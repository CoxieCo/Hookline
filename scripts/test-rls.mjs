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

await db.close();
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
