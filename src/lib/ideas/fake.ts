import "server-only";

import { GeneratedBatchSchema, type GeneratedIdea } from "./schema";

/**
 * End-to-end tests run the real route, quota and database against a canned
 * model response, so they don't spend API credit. Only possible on a local
 * dev server started with HOOKLINE_FAKE_MODEL=1. Never in a production build
 * (Next inlines NODE_ENV there) and never on Vercel (any environment,
 * including preview deployments), whatever HOOKLINE_FAKE_MODEL says.
 */
export function fakeModelEnabled() {
  if (process.env.NODE_ENV === "production") return false;
  if (process.env.VERCEL || process.env.VERCEL_ENV) return false;
  return process.env.HOOKLINE_FAKE_MODEL === "1";
}

/** What the fake model "noticed" in idea 1. Idea 2 has a number it missed, for the server's check to find. */
export const FAKE_MODEL_CLAIM = "Fake claim: the harness keeps a dog dry for a whole walk";
export const FAKE_MISSED_NUMBER = "5 km";

export function fakeIdeas(): GeneratedIdea[] {
  console.warn("[ideas] HOOKLINE_FAKE_MODEL=1: returning canned ideas, Claude was not called");
  const formats = ["POV", "Problem then solution", "Before and after", "Myth-busting", "Quick comparison"];
  const run = Date.now().toString(36);
  return GeneratedBatchSchema.parse({
    ideas: formats.map((format, i) => ({
      hook: `[Fake idea ${i + 1} · ${run}] Open on the product in close-up as the on-screen text asks a question.`,
      script_beats: [
        "Close-up of the product",
        i === 1 ? `Show it after a ${FAKE_MISSED_NUMBER} walk` : "Show the problem it solves",
        "Show it in use",
        "End on the product",
      ],
      filming_instructions: "Phone on a tripod by a window, close-up shots, add on-screen text, about 15 seconds.",
      format,
      trend_name: format,
      caption: `Fake caption ${i + 1} for testing #test`,
      duration_seconds: 15,
      claims_to_verify: i === 0 ? [FAKE_MODEL_CLAIM] : [],
    })),
  }).ideas;
}
