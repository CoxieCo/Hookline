import "server-only";

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { acceptsSampling, CLAUDE_MODEL } from "@/lib/claude";
import type { ProfileValues } from "@/lib/profile/schema";
import { IdeasError } from "./errors";
import { fakeIdeas, fakeModelEnabled } from "./fake";
import { buildIdeasUserPrompt, IDEAS_SYSTEM_PROMPT } from "./prompt";
import { GeneratedBatchSchema, ModelBatchSchema, type GeneratedIdea } from "./schema";

/** Higher than extraction (0): we want five different ideas, not the likeliest one. */
export const IDEAS_TEMPERATURE = 0.8;

// One attempt, bounded so the route (maxDuration 90s) always gets to answer.
const MODEL_TIMEOUT_MS = 80_000;

export async function generateIdeasWithClaude(profile: ProfileValues, recentHooks: string[]): Promise<GeneratedIdea[]> {
  if (fakeModelEnabled()) return fakeIdeas();

  const client = new Anthropic({ timeout: MODEL_TIMEOUT_MS, maxRetries: 0 });

  let response;
  try {
    response = await client.messages.parse({
      model: CLAUDE_MODEL,
      max_tokens: 8192,
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
  return result.data.ideas;
}
