import "server-only";

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { acceptsSampling, CLAUDE_MODEL } from "@/lib/claude";
import type { ProfileWithFacts } from "@/lib/profile/schema";
import { IdeasError } from "./errors";
import { fakeIdeas, fakeModelEnabled } from "./fake";
import { applyNumberCheck } from "./grounding";
import { buildIdeasUserPrompt, IDEAS_SYSTEM_PROMPT } from "./prompt";
import { GeneratedBatchSchema, ModelBatchSchema, type GeneratedIdea } from "./schema";

/** Higher than extraction (0): we want five different ideas, not the likeliest one. */
export const IDEAS_TEMPERATURE = 0.8;

// One attempt, bounded so the route (maxDuration 90s) always gets to answer.
const MODEL_TIMEOUT_MS = 80_000;

// Room for five ideas plus their claim lists, and for the thinking tokens that
// newer models (which think by default) count against max_tokens. Still small
// enough for a non-streaming request.
const MAX_TOKENS = 16_000;

export type ModelIdeas = {
  /** Validated, but before the server's own number check. */
  ideas: GeneratedIdea[];
  usage: { input_tokens: number; output_tokens: number };
};

/** The Claude call alone. Exported for scripts/sample-ideas.ts; the app uses generateIdeasWithClaude. */
export async function requestIdeasFromClaude(
  profile: ProfileWithFacts,
  recentHooks: string[],
  { timeoutMs = MODEL_TIMEOUT_MS }: { timeoutMs?: number } = {},
): Promise<ModelIdeas> {
  const client = new Anthropic({ timeout: timeoutMs, maxRetries: 0 });

  let response;
  try {
    response = await client.messages.parse({
      model: CLAUDE_MODEL,
      max_tokens: MAX_TOKENS,
      ...(acceptsSampling() ? { temperature: IDEAS_TEMPERATURE } : {}),
      system: IDEAS_SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildIdeasUserPrompt(profile, recentHooks) }],
      output_config: { format: zodOutputFormat(ModelBatchSchema) },
    });
  } catch (err) {
    if (err instanceof Anthropic.APIError) {
      throw new IdeasError("model_failed", `Anthropic API ${err.status ?? "?"}: ${err.message}`);
    }
    // Includes the SDK failing to parse truncated or off-schema JSON.
    throw new IdeasError("model_failed", (err as Error).message);
  }

  // refusal, max_tokens (truncated), etc. — the output can't be trusted.
  if (response.stop_reason !== "end_turn") {
    throw new IdeasError("model_failed", `stop_reason ${response.stop_reason}`);
  }

  const result = GeneratedBatchSchema.safeParse(response.parsed_output);
  if (!result.success) {
    throw new IdeasError("model_failed", `invalid output: ${result.error.message}`);
  }
  return {
    ideas: result.data.ideas,
    usage: { input_tokens: response.usage?.input_tokens ?? 0, output_tokens: response.usage?.output_tokens ?? 0 },
  };
}

/**
 * Five validated ideas. claims_to_verify holds the model's own list plus any
 * number the server's check found that the profile and product facts don't
 * contain. Flags never fail or regenerate the batch.
 */
export async function generateIdeasWithClaude(profile: ProfileWithFacts, recentHooks: string[]): Promise<GeneratedIdea[]> {
  const ideas = fakeModelEnabled() ? fakeIdeas() : (await requestIdeasFromClaude(profile, recentHooks)).ideas;
  return applyNumberCheck(ideas, profile);
}
