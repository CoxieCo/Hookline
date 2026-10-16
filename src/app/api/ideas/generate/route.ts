import { NextResponse } from "next/server";
import {
  IDEAS_FAILURE_MESSAGES,
  IDEAS_FAILURE_STATUS,
  IdeasError,
  retryInWords,
  type IdeasFailure,
  type IdeasFailureReason,
} from "@/lib/ideas/errors";
import { generateIdeasWithClaude } from "@/lib/ideas/model";
import { RECENT_HOOKS_LIMIT } from "@/lib/ideas/prompt";
import { IDEA_COLUMNS, type Idea } from "@/lib/ideas/schema";
import { PROFILE_FIELDS, type ProfileWithFacts } from "@/lib/profile/schema";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

// One model call (≤80s) plus a few small queries.
export const maxDuration = 90;

export type GenerateSuccess = { ok: true; batch_id: string; ideas: Idea[] };
export type GenerateResponse = GenerateSuccess | IdeasFailure;

type Quota = { allowed: boolean; retry_at: string | null };

function fail(reason: IdeasFailureReason, extra?: Partial<IdeasFailure>) {
  return NextResponse.json<IdeasFailure>(
    { ok: false, reason, message: IDEAS_FAILURE_MESSAGES[reason], ...extra },
    { status: IDEAS_FAILURE_STATUS[reason] },
  );
}

export async function POST() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return fail("unauthorized");

  // RLS scopes this to the signed-in user's row.
  const { data: profile, error: profileError } = await supabase
    .from("business_profiles")
    .select("business_name, industry, product_description, target_customer, brand_tone, product_facts")
    .maybeSingle();
  if (profileError) {
    console.error("[ideas] profile load failed", profileError.message);
    return fail("server_error");
  }
  // Checked before the quota so a missing profile never costs a generation.
  if (!profile) return fail("no_profile");

  // Checks and records one batch atomically (5 per rolling 24h, see migration).
  const { data: quota, error: quotaError } = await supabase.rpc("consume_generation_quota");
  if (quotaError) {
    console.error("[ideas] rate-limit check failed", quotaError.message);
    return fail("server_error");
  }
  const { allowed, retry_at } = (quota ?? {}) as Partial<Quota>;
  if (allowed !== true) {
    const retryAt = retry_at ? new Date(retry_at) : null;
    return fail("rate_limited", {
      message: `${IDEAS_FAILURE_MESSAGES.rate_limited} ${retryAt ? retryInWords(retryAt) : "Please try again later."}`,
      ...(retryAt && { retry_at: retryAt.toISOString() }),
    });
  }

  const { data: recent, error: recentError } = await supabase
    .from("generated_ideas")
    .select("hook")
    .order("created_at", { ascending: false })
    .limit(RECENT_HOOKS_LIMIT);
  if (recentError) {
    console.error("[ideas] recent hooks load failed", recentError.message);
    return fail("server_error");
  }

  const profileValues = Object.fromEntries(
    [...PROFILE_FIELDS, "product_facts"].map((field) => [field, (profile as Record<string, string | null>)[field] ?? ""]),
  ) as ProfileWithFacts;

  let generated;
  try {
    generated = await generateIdeasWithClaude(profileValues, recent.map((r) => r.hook as string));
  } catch (err) {
    if (err instanceof IdeasError) {
      console.warn(`[ideas] user=${user.id} ${err.message}`);
      return fail(err.reason);
    }
    console.error("[ideas] unexpected model error", err);
    return fail("server_error");
  }

  // Users have no INSERT privilege on generated_ideas; rows are only written
  // here, with the service role, for the user verified above.
  const batchId = crypto.randomUUID();
  const rows = generated.map((idea) => ({
    user_id: user.id,
    batch_id: batchId,
    hook: idea.hook,
    script_beats: idea.script_beats,
    filming_instructions: idea.filming_instructions,
    format: idea.format,
    caption: idea.caption,
    duration_seconds: idea.duration_seconds,
    trend_name: idea.trend_name || null,
    claims_to_verify: idea.claims_to_verify,
  }));

  try {
    const { data: inserted, error: insertError } = await createAdminClient()
      .from("generated_ideas")
      .insert(rows)
      .select(IDEA_COLUMNS);
    if (insertError) throw new Error(insertError.message);
    return NextResponse.json<GenerateSuccess>({ ok: true, batch_id: batchId, ideas: inserted as Idea[] });
  } catch (err) {
    console.error("[ideas] insert failed", (err as Error).message);
    return fail("server_error");
  }
}
