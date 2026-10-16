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
  -- Like Supabase's: the server-side key's role, which bypasses RLS.
  create role service_role nologin bypassrls;
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
  grant usage on schema public to anon, authenticated, service_role;
  alter default privileges in schema public
    grant all on tables to anon, authenticated, service_role;
  insert into auth.users (id) values ('${A}'), ('${B}');
`);

const migrationsDir = fileURLToPath(new URL("../supabase/migrations/", import.meta.url));
for (const file of readdirSync(migrationsDir).sort()) {
  await db.exec(readFileSync(join(migrationsDir, file), "utf8"));
}

// --- helpers --------------------------------------------------------------
// userId: a user's id (authenticated), null (anon) or SERVICE (service_role).
const SERVICE = Symbol("service_role");
async function as(userId, sql, params = []) {
  await db.exec("reset role");
  if (userId === SERVICE) {
    await db.query(`select set_config('request.jwt.claims', $1, false)`, [
      JSON.stringify({ role: "service_role" }),
    ]);
    await db.exec("set role service_role");
  } else if (userId) {
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

// --- product_facts ----------------------------------------------------------
console.log("\nbusiness_profiles.product_facts\n");

await check("product_facts defaults to '' (not NULL) on rows that don't set it", async () => {
  const { rows } = await as(B, `select product_facts from business_profiles`);
  assert(rows.length === 1 && rows[0].product_facts === "", JSON.stringify(rows));
});

await check("user A can save product_facts on their own profile (upsert)", async () => {
  await as(A, `
    insert into business_profiles (user_id, business_name, source_type, product_facts)
    values ($1, 'Paws & Co', 'manual', $2)
    on conflict (user_id) do update set product_facts = excluded.product_facts`,
    [A, "Waterproof harness\nSizes S-L"]);
  const { rows } = await as(A, `select product_facts from business_profiles`);
  assert(rows.length === 1 && rows[0].product_facts === "Waterproof harness\nSizes S-L", JSON.stringify(rows));
});

await check("user B cannot read user A's product_facts", async () => {
  const { rows } = await as(B, `select product_facts from business_profiles where user_id = $1`, [A]);
  assert(rows.length === 0, `saw ${rows.length} rows`);
});

await check("user B's update of user A's product_facts affects 0 rows", async () => {
  const { affectedRows } = await as(B,
    `update business_profiles set product_facts = 'planted claim' where user_id = $1`, [A]);
  assert(affectedRows === 0, `affected ${affectedRows}`);
  const { rows } = await as(A, `select product_facts from business_profiles`);
  assert(rows[0].product_facts === "Waterproof harness\nSizes S-L", JSON.stringify(rows));
});

await check("product_facts cannot be NULL", async () => {
  await rejects(as(A, `update business_profiles set product_facts = null`), /null value|not-null/);
});

await check("anon cannot read product_facts", async () => {
  const { rows } = await as(null, `select product_facts from business_profiles`);
  assert(rows.length === 0, `saw ${rows.length} rows`);
});

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

// --- generated ideas ------------------------------------------------------
console.log("\ngenerated_ideas RLS + column privileges\n");

const BATCH_A = "aaaaaaaa-0000-0000-0000-00000000ba7c";
const BATCH_B = "bbbbbbbb-0000-0000-0000-00000000ba7c";
const INSERT_IDEA = `
  insert into generated_ideas (user_id, batch_id, hook, script_beats, filming_instructions, format, caption)
  values ($1, $2, $3, '["beat one","beat two","beat three"]'::jsonb, 'phone by a window', 'POV', 'caption')
  returning id`;

let ideaA = "";
let ideaB = "";

await check("RLS is enabled on generated_ideas", async () => {
  const { rows } = await db.query(
    `select relrowsecurity from pg_class where oid = 'public.generated_ideas'::regclass`,
  );
  assert(rows[0].relrowsecurity === true, "relrowsecurity is false");
});

await check("there is no INSERT policy on generated_ideas", async () => {
  const { rows } = await db.query(
    `select policyname, cmd from pg_policies where tablename = 'generated_ideas' order by cmd`,
  );
  const cmds = rows.map((r) => r.cmd);
  assert(JSON.stringify(cmds) === JSON.stringify(["DELETE", "SELECT", "UPDATE"]), JSON.stringify(rows));
});

await check("the server (service_role) can insert ideas for A and B", async () => {
  ideaA = (await as(SERVICE, INSERT_IDEA, [A, BATCH_A, "A's hook"])).rows[0].id;
  ideaB = (await as(SERVICE, INSERT_IDEA, [B, BATCH_B, "B's hook"])).rows[0].id;
  await as(SERVICE, INSERT_IDEA, [A, BATCH_A, "A's second hook"]);
  const { rows } = await db.query(`select status, caption from generated_ideas where id = $1`, [ideaA]);
  assert(rows[0].status === "new", `default status was ${rows[0].status}`);
});

await check("user A cannot insert an idea for themselves", async () => {
  await rejects(as(A, INSERT_IDEA, [A, BATCH_A, "self-made"]), /permission denied/);
});

await check("user A cannot insert an idea for user B", async () => {
  await rejects(as(A, INSERT_IDEA, [B, BATCH_B, "planted"]), /permission denied/);
});

await check("user A cannot insert relying on the auth.uid() default either", async () => {
  await rejects(
    as(A, `insert into generated_ideas (batch_id, hook, script_beats, filming_instructions, format)
           values ($1, 'x', '[]'::jsonb, 'x', 'x')`, [BATCH_A]),
    /permission denied/,
  );
});

await check("user A sees only their own ideas", async () => {
  const { rows } = await as(A, `select user_id, hook from generated_ideas order by hook`);
  assert(rows.length === 2, `saw ${rows.length} rows`);
  assert(rows.every((r) => r.user_id === A), JSON.stringify(rows));
});

await check("user A cannot read user B's idea even by id", async () => {
  const { rows } = await as(A, `select * from generated_ideas where id = $1`, [ideaB]);
  assert(rows.length === 0, `saw ${rows.length} rows`);
});

await check("user A's status update of user B's idea affects 0 rows", async () => {
  const { affectedRows } = await as(A, `update generated_ideas set status = 'dismissed' where id = $1`, [ideaB]);
  assert(affectedRows === 0, `affected ${affectedRows}`);
});

await check("user A's delete of user B's idea affects 0 rows", async () => {
  const { affectedRows } = await as(A, `delete from generated_ideas where id = $1`, [ideaB]);
  assert(affectedRows === 0, `affected ${affectedRows}`);
});

for (const status of ["saved", "dismissed", "new"]) {
  await check(`user A can set their idea's status to '${status}'`, async () => {
    const { affectedRows } = await as(A, `update generated_ideas set status = $1 where id = $2`, [status, ideaA]);
    assert(affectedRows === 1, `affected ${affectedRows}`);
    const { rows } = await db.query(`select status from generated_ideas where id = $1`, [ideaA]);
    assert(rows[0].status === status, `status is ${rows[0].status}`);
  });
}

await check("an invalid status is rejected by the CHECK constraint", async () => {
  await rejects(
    as(A, `update generated_ideas set status = 'archived' where id = $1`, [ideaA]),
    /generated_ideas_status_check/,
  );
});

for (const [column, value] of [
  ["hook", "'rewritten hook'"],
  ["script_beats", `'["x"]'::jsonb`],
  ["caption", "'new caption'"],
  ["format", "'other'"],
  ["batch_id", `'${BATCH_B}'`],
  ["created_at", "now() - interval '1 year'"],
  ["user_id", `'${B}'`],
  ["claims_to_verify", `'[]'::jsonb`],
]) {
  await check(`user A cannot change ${column} on their own idea`, async () => {
    await rejects(
      as(A, `update generated_ideas set ${column} = ${value} where id = $1`, [ideaA]),
      /permission denied/,
    );
  });
}

await check("a status update bundled with a hook change is rejected as a whole", async () => {
  await rejects(
    as(A, `update generated_ideas set status = 'saved', hook = 'sneaky' where id = $1`, [ideaA]),
    /permission denied/,
  );
  const { rows } = await db.query(`select status, hook from generated_ideas where id = $1`, [ideaA]);
  assert(rows[0].status === "new" && rows[0].hook === "A's hook", JSON.stringify(rows));
});

await check("claims_to_verify defaults to an empty array", async () => {
  const { rows } = await as(A, `select claims_to_verify from generated_ideas where id = $1`, [ideaA]);
  assert(JSON.stringify(rows[0].claims_to_verify) === "[]", JSON.stringify(rows));
});

let ideaWithClaims = "";
const CLAIMS = ["Lasts 10 hours", "“5 km” (script beat 2)"];

await check("the server can insert an idea with claims_to_verify, and its owner can read them", async () => {
  ideaWithClaims = (await as(SERVICE, `
    insert into generated_ideas (user_id, batch_id, hook, script_beats, filming_instructions, format, claims_to_verify)
    values ($1, $2, 'claims hook', '["a","b","c"]'::jsonb, 'x', 'POV', $3::jsonb) returning id`,
    [A, BATCH_A, JSON.stringify(CLAIMS)])).rows[0].id;
  const { rows } = await as(A, `select claims_to_verify from generated_ideas where id = $1`, [ideaWithClaims]);
  assert(JSON.stringify(rows[0].claims_to_verify) === JSON.stringify(CLAIMS), JSON.stringify(rows));
});

await check("user A cannot clear the claims on their own idea (alone or bundled with a status change)", async () => {
  await rejects(
    as(A, `update generated_ideas set claims_to_verify = '[]'::jsonb where id = $1`, [ideaWithClaims]),
    /permission denied/,
  );
  await rejects(
    as(A, `update generated_ideas set status = 'saved', claims_to_verify = '[]'::jsonb where id = $1`, [ideaWithClaims]),
    /permission denied/,
  );
  const { rows } = await db.query(`select status, claims_to_verify from generated_ideas where id = $1`, [ideaWithClaims]);
  assert(rows[0].status === "new" && rows[0].claims_to_verify.length === 2, JSON.stringify(rows));
});

await check("user A can still change the status of an idea that has claims", async () => {
  const { affectedRows } = await as(A, `update generated_ideas set status = 'saved' where id = $1`, [ideaWithClaims]);
  assert(affectedRows === 1, `affected ${affectedRows}`);
});

await check("user B cannot read user A's claims_to_verify", async () => {
  const { rows } = await as(B, `select claims_to_verify from generated_ideas where id = $1`, [ideaWithClaims]);
  assert(rows.length === 0, `saw ${rows.length} rows`);
});

await check("status is the ONLY column authenticated can update (column privileges)", async () => {
  const { rows: cols } = await db.query(`
    select column_name from information_schema.column_privileges
    where table_schema = 'public' and table_name = 'generated_ideas'
      and grantee = 'authenticated' and privilege_type = 'UPDATE'
    order by column_name`);
  assert(JSON.stringify(cols.map((r) => r.column_name)) === '["status"]', JSON.stringify(cols));
  const { rows: table } = await db.query(
    `select has_table_privilege('authenticated', 'public.generated_ideas', 'UPDATE') as t`);
  assert(table[0].t === false, "authenticated has table-wide UPDATE");
});

await check("claims_to_verify must be a JSON array, even for the server", async () => {
  await rejects(
    as(SERVICE, `insert into generated_ideas (user_id, batch_id, hook, script_beats, filming_instructions, format, claims_to_verify)
                 values ($1, $2, 'x', '[]'::jsonb, 'x', 'x', '"just a string"'::jsonb)`, [A, BATCH_A]),
    /generated_ideas_claims_to_verify_is_array/,
  );
});

await check("anon (signed out) cannot read ideas", async () => {
  await rejects(as(null, `select * from generated_ideas`), /permission denied/);
});

await check("anon (signed out) cannot update or delete ideas", async () => {
  await rejects(as(null, `update generated_ideas set status = 'dismissed'`), /permission denied/);
  await rejects(as(null, `delete from generated_ideas`), /permission denied/);
});

await check("script_beats must be a JSON array, even for the server", async () => {
  await rejects(
    as(SERVICE, `insert into generated_ideas (user_id, batch_id, hook, script_beats, filming_instructions, format)
                 values ($1, $2, 'x', '{"a":1}'::jsonb, 'x', 'x')`, [A, BATCH_A]),
    /generated_ideas_script_beats_is_array/,
  );
});

await check("user A can delete their own idea", async () => {
  const { affectedRows } = await as(A, `delete from generated_ideas where id = $1`, [ideaA]);
  assert(affectedRows === 1, `affected ${affectedRows}`);
});

await check("user B's idea is untouched after all of A's attempts", async () => {
  const { rows } = await as(B, `select hook, status, user_id from generated_ideas`);
  assert(rows.length === 1, `saw ${rows.length} rows`);
  assert(rows[0].hook === "B's hook" && rows[0].status === "new" && rows[0].user_id === B, JSON.stringify(rows));
});

// --- generation rate limit ------------------------------------------------
console.log("\ngeneration rate limit\n");

const consumeGen = (who) =>
  as(who, `select public.consume_generation_quota() as q`).then((r) => r.rows[0].q);
const genLogCount = async (who) =>
  (await db.query(`select count(*)::int as n from idea_generation_log where user_id = $1`, [who])).rows[0].n;

await check("user A gets exactly 5 batches, the 6th is refused with a retry time", async () => {
  const results = [];
  for (let i = 0; i < 6; i++) results.push(await consumeGen(A));
  assert(results.slice(0, 5).every((r) => r.allowed === true && r.retry_at === null), JSON.stringify(results));
  assert(results[5].allowed === false, `6th call returned ${JSON.stringify(results[5])}`);
  const { rows } = await db.query(
    `select min(created_at) + interval '24 hours' as expected from idea_generation_log where user_id = $1`, [A]);
  const got = new Date(results[5].retry_at).getTime();
  assert(Math.abs(got - new Date(rows[0].expected).getTime()) < 1000,
    `retry_at ${results[5].retry_at}, expected ${rows[0].expected}`);
  assert((await genLogCount(A)) === 5, "the refused call was still recorded");
});

await check("user B's generation quota is independent of user A's", async () => {
  assert((await consumeGen(B)).allowed === true, "B was refused");
});

await check("the generation quota is separate from the extraction quota", async () => {
  // A has used up generation; extraction entries for A are unaffected and vice versa.
  const { rows } = await db.query(`select count(*)::int as n from profile_extraction_log where user_id = $1`, [A]);
  assert(rows[0].n === 11, `extraction log for A has ${rows[0].n} rows`);
});

await check("batches older than 24 hours no longer count", async () => {
  await db.query(
    `update idea_generation_log set created_at = now() - interval '24 hours 1 minute'
     where id = (select id from idea_generation_log where user_id = $1 order by created_at limit 1)`, [A]);
  const r = await consumeGen(A);
  assert(r.allowed === true, `A still refused after the oldest batch aged out: ${JSON.stringify(r)}`);
  assert((await consumeGen(A)).allowed === false, "A got a 7th slot in the window");
});

await check("users cannot read the generation log", async () => {
  await rejects(as(A, `select * from idea_generation_log`), /permission denied/);
});

await check("users cannot delete their generation log entries to reset the quota", async () => {
  const before = await genLogCount(A);
  await rejects(as(A, `delete from idea_generation_log`), /permission denied/);
  assert((await genLogCount(A)) === before, "log rows were deleted");
});

await check("users cannot back-date their log entries to reset the quota", async () => {
  await rejects(
    as(A, `update idea_generation_log set created_at = now() - interval '2 days'`),
    /permission denied/,
  );
  assert((await consumeGen(A)).allowed === false, "A was allowed after the attempted back-date");
});

await check("users cannot truncate the generation log", async () => {
  await rejects(as(A, `truncate idea_generation_log`), /permission denied/);
});

await check("users cannot insert log entries (e.g. to burn someone else's quota)", async () => {
  await rejects(as(A, `insert into idea_generation_log (user_id) values ($1)`, [B]), /permission denied/);
});

await check("the quota function takes no arguments, so it can't target another user", async () => {
  await rejects(as(A, `select public.consume_generation_quota($1::uuid)`, [B]), /does not exist/);
});

await check("anon cannot call the generation quota function", async () => {
  await rejects(as(null, `select public.consume_generation_quota()`), /permission denied/);
});

await check("a JWT without a user id is refused by the function itself", async () => {
  await db.exec("reset role");
  await db.query(`select set_config('request.jwt.claims', '{"role":"authenticated"}', false)`);
  await db.exec("set role authenticated");
  try {
    const { rows } = await db.query(`select public.consume_generation_quota() as q`);
    assert(rows[0].q.allowed === false, JSON.stringify(rows[0].q));
  } finally {
    await db.exec("reset role");
  }
});

await check("deleting a user cascades to their ideas and generation log", async () => {
  await as(SERVICE, INSERT_IDEA, [A, BATCH_A, "to be cascaded"]);
  await db.query(`delete from auth.users where id = $1`, [A]);
  const ideas = await db.query(`select count(*)::int as n from generated_ideas where user_id = $1`, [A]);
  assert(ideas.rows[0].n === 0 && (await genLogCount(A)) === 0, "rows survived the user");
});

await db.close();
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
