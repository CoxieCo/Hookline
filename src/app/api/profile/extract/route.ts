import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import {
  ExtractError,
  FAILURE_MESSAGES,
  FAILURE_STATUS,
  type ExtractFailure,
  type ExtractFailureReason,
} from "@/lib/extract/errors";
import { classifyInput } from "@/lib/extract/input";
import { extractProfileWithClaude } from "@/lib/extract/model";
import { readSocial } from "@/lib/extract/social";
import { readWebsite, type SourceContent } from "@/lib/extract/website";
import type { ExtractedProfile, SourceType } from "@/lib/profile/schema";

// Page fetches (≤10s + ≤5s for subpages) plus one model call (≤40s).
export const maxDuration = 60;

export type ExtractSuccess = {
  ok: true;
  profile: ExtractedProfile;
  source: { type: Exclude<SourceType, "manual">; url: string };
};
export type ExtractResponse = ExtractSuccess | ExtractFailure;

const BodySchema = z.object({ input: z.string().max(2048) });

function fail(reason: ExtractFailureReason) {
  return NextResponse.json<ExtractFailure>(
    { ok: false, reason, message: FAILURE_MESSAGES[reason] },
    { status: FAILURE_STATUS[reason] },
  );
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return fail("unauthorized");

  const body = BodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return fail("invalid_input");

  const input = classifyInput(body.data.input);
  if (input.kind === "invalid") return fail("invalid_input");

  // Checked after cheap local validation so typos don't burn quota, but
  // before any outbound request so the fetcher can't be used as a free probe.
  const { data: allowed, error: quotaError } = await supabase.rpc("consume_extraction_quota");
  if (quotaError) {
    console.error("[extract] rate-limit check failed", quotaError.message);
    return fail("server_error");
  }
  if (allowed !== true) return fail("rate_limited");

  try {
    let content: SourceContent;
    let sourceType: ExtractSuccess["source"]["type"];
    if (input.kind === "website") {
      content = await readWebsite(input.url, input.isBareDomain);
      sourceType = "website";
    } else {
      content = await readSocial(input.handle, input.platforms);
      sourceType = "social";
    }

    const profile = await extractProfileWithClaude(content.sourceUrl, content.text);
    return NextResponse.json<ExtractSuccess>({
      ok: true,
      profile,
      source: { type: sourceType, url: content.sourceUrl },
    });
  } catch (err) {
    if (err instanceof ExtractError) {
      console.warn(`[extract] user=${user.id} ${err.message}`);
      return fail(err.reason);
    }
    console.error("[extract] unexpected error", err);
    return fail("server_error");
  }
}
