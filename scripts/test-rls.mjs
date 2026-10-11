// Runs the business_profiles migration against an in-process Postgres (PGlite)
// with a minimal stand-in for Supabase's auth schema and roles, then checks
// that RLS isolates users. Run with: npm run test:rls
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";

const A = "aaaaaaaa-0000-0000-0000-000000000001";
const B = "bbbbbbbb-0000-0000-0000-000000000002";

const db = await PGlite.create();

// --- Supabase-like environment -------------------------------------------
await db.exec(`
  create role anon nologin;
  create role authenticated nologin;
  create schema auth;
  create table auth.users (id uuid primary key);
  -- Same definition Supabase uses: reads the JWT "sub" claim for the request.
  create function auth.uid() returns uuid language sql stable as $$
    select coalesce(
      nullif(current_setting('request.jwt.claim.sub', true), ''),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    )::uuid
  $$;
  grant usage on schema auth to anon, authenticated;
  grant execute on function auth.uid() to anon, authenticated;
  -- Supabase grants table privileges broadly and relies on RLS to restrict rows.
  grant usage on schema public to anon, authenticated;
  alter default privileges in schema public
    grant all on tables to anon, authenticated;
  insert into auth.users (id) values ('${A}'), ('${B}');
`);

const migrationsDir = fileURLToPath(new URL("../supabase/migrations/", import.meta.url));
for (const file of readdirSync(migrationsDir).sort()) {
  await db.exec(readFileSync(join(migrationsDir, file), "utf8"));
}

// --- helpers --------------------------------------------------------------
async function as(userId, sql, params = []) {
  await db.exec("reset role");
  if (userId) {
    await db.query(`select set_config('request.jwt.claims', $1, false)`, [
      JSON.stringify({ sub: userId, role: "authenticated" }),
    ]);
    await db.exec("set role authenticated");
  } else {
    await db.query(`select set_config('request.jwt.claims', '', false)`);
    await db.exec("set role anon");
  }
  try {
    return await db.query(sql, params);
  } finally {
    await db.exec("reset role");
  }
}

let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL  ${name}\n        ${e.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
async function rejects(promise, pattern) {
  try {
    await promise;
  } catch (e) {
    assert(pattern.test(e.message), `unexpected error: ${e.message}`);
    return;
  }
  throw new Error("expected an error, but the statement succeeded");
}

// --- tests ----------------------------------------------------------------
console.log("business_profiles RLS\n");

await check("RLS is enabled on the table", async () => {
  const { rows } = await db.query(
    `select relrowsecurity from pg_class where oid = 'public.business_profiles'::regclass`,
  );
  assert(rows[0].relrowsecurity === true, "relrowsecurity is false");
});

await check("user A can insert their own row (user_id defaults to auth.uid())", async () => {
  const { rows } = await as(A,
    `insert into business_profiles (industry) values ('pets') returning user_id`);
  assert(rows[0].user_id === A, `user_id was ${rows[0].user_id}`);
});

await check("user A cannot insert a row owned by user B", async () => {
  await rejects(
    as(A, `insert into business_profiles (user_id, industry) values ($1, 'spoof')`, [B]),
    /row-level security/,
  );
});

await check("user B can insert their own row", async () => {
  await as(B, `insert into business_profiles (industry) values ('fitness')`);
});

await check("user A only sees their own row", async () => {
  const { rows } = await as(A, `select user_id, industry from business_profiles`);
  assert(rows.length === 1, `saw ${rows.length} rows`);
  assert(rows[0].user_id === A && rows[0].industry === "pets", JSON.stringify(rows));
});

await check("user A cannot read user B's row even when filtering for it", async () => {
  const { rows } = await as(A, `select * from business_profiles where user_id = $1`, [B]);
  assert(rows.length === 0, `saw ${rows.length} rows`);
});

await check("user A can update their own row", async () => {
  const { affectedRows } = await as(A,
    `update business_profiles set brand_tone = 'playful' where user_id = $1`, [A]);
  assert(affectedRows === 1, `affected ${affectedRows}`);
});

await check("user A's update of user B's row affects 0 rows", async () => {
  const { affectedRows } = await as(A,
    `update business_profiles set industry = 'hacked' where user_id = $1`, [B]);
  assert(affectedRows === 0, `affected ${affectedRows}`);
});

await check("user A cannot reassign their row to user B", async () => {
  await rejects(
    as(A, `update business_profiles set user_id = $1 where user_id = $2`, [B, A]),
    /row-level security/,
  );
});

await check("user A's delete of user B's row affects 0 rows", async () => {
  const { affectedRows } = await as(A, `delete from business_profiles where user_id = $1`, [B]);
  assert(affectedRows === 0, `affected ${affectedRows}`);
});

await check("a user cannot have more than one profile", async () => {
  await rejects(
    as(A, `insert into business_profiles (industry) values ('second')`),
    /unique/,
  );
});

await check("anon (signed out) sees no rows", async () => {
  const { rows } = await as(null, `select * from business_profiles`);
  assert(rows.length === 0, `saw ${rows.length} rows`);
});

await check("anon (signed out) cannot insert", async () => {
  await rejects(
    as(null, `insert into business_profiles (user_id, industry) values ($1, 'x')`, [A]),
    /row-level security/,
  );
});

await check("user B's row is untouched after all of A's attempts", async () => {
  const { rows } = await as(B, `select industry from business_profiles`);
  assert(rows.length === 1 && rows[0].industry === "fitness", JSON.stringify(rows));
});

await check("user A can delete their own row", async () => {
  const { affectedRows } = await as(A, `delete from business_profiles`);
  assert(affectedRows === 1, `affected ${affectedRows}`);
});

// --- onboarding migration -------------------------------------------------
console.log("\nonboarding: business_name, source_type, upsert\n");

const UPSERT = `
  insert into business_profiles (user_id, business_name, source_type, source_url, industry)
  values ($1, $2, $3, $4, $5)
  on conflict (user_id) do update set
    business_name = excluded.business_name,
    source_type   = excluded.source_type,
    source_url    = excluded.source_url,
    industry      = excluded.industry
  returning business_name, source_type`;

await check("user A can upsert (insert) a profile with business_name", async () => {
  const { rows } = await as(A, UPSERT, [A, "Paws Co", "website", "https://paws.example", "pets"]);
  assert(rows[0].business_name === "Paws Co", JSON.stringify(rows));
});

await check("user A can upsert (update) the same profile — still one row", async () => {
  await as(A, UPSERT, [A, "Paws & Co", "manual", null, "pets"]);
  const { rows } = await as(A, `select business_name, source_type from business_profiles`);
  assert(rows.length === 1, `saw ${rows.length} rows`);
  assert(rows[0].business_name === "Paws & Co" && rows[0].source_type === "manual", JSON.stringify(rows));
});

await check("user A's upsert targeting user B's user_id is rejected", async () => {
  await rejects(as(A, UPSERT, [B, "Hijack", "manual", null, "x"]), /row-level security/);
  const { rows } = await as(B, `select industry from business_profiles`);
  assert(rows[0].industry === "fitness", JSON.stringify(rows));
});

for (const value of ["website", "social", "manual"]) {
  await check(`source_type '${value}' is accepted`, async () => {
    await as(A, `update business_profiles set source_type = $1`, [value]);
  });
}

for (const value of ["tiktok", "", "Website"]) {
  await check(`source_type '${value}' is rejected by the CHECK constraint`, async () => {
    await rejects(
      as(A, `update business_profiles set source_type = $1`, [value]),
      /business_profiles_source_type_check/,
    );
  });
}

// --- extraction rate limit ------------------------------------------------
console.log("\nextraction rate limit\n");

const consume = (who) =>
  as(who, `select public.consume_extraction_quota() as ok`).then((r) => r.rows[0].ok);

await check("user A gets exactly 10 extractions, the 11th is refused", async () => {
  const results = [];
  for (let i = 0; i < 11; i++) results.push(await consume(A));
  assert(results.slice(0, 10).every((r) => r === true), JSON.stringify(results));
  assert(results[10] === false, `11th call returned ${results[10]}`);
});

await check("user B's quota is independent of user A's", async () => {
  assert((await consume(B)) === true, "B was refused");
});

await check("entries older than an hour no longer count", async () => {
  await db.query(
    `update profile_extraction_log set created_at = now() - interval '61 minutes' where user_id = $1`,
    [A],
  );
  assert((await consume(A)) === true, "A still refused after window passed");
});

await check("users cannot read the log table directly", async () => {
  const { rows } = await as(A, `select * from profile_extraction_log`);
  assert(rows.length === 0, `saw ${rows.length} rows`);
});

await check("users cannot delete their log entries to reset the quota", async () => {
  const { affectedRows } = await as(A, `delete from profile_extraction_log`);
  assert(affectedRows === 0, `deleted ${affectedRows}`);
  const { rows } = await db.query(`select count(*)::int as n from profile_extraction_log where user_id = $1`, [A]);
  assert(rows[0].n === 11, `log has ${rows[0].n} rows for A`);
});

await check("users cannot insert log entries for someone else", async () => {
  await rejects(
    as(A, `insert into profile_extraction_log (user_id) values ($1)`, [B]),
    /row-level security/,
  );
});

await check("anon cannot call the quota function", async () => {
  await rejects(as(null, `select public.consume_extraction_quota()`), /permission denied/);
});

await db.close();
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
