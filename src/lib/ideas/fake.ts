import "server-only";

import { GeneratedBatchSchema, type GeneratedIdea } from "./schema";

/**
 * End-to-end tests run the real route, quota and database against a canned
 * model response, so they don't spend API credit. Only possible on a dev
 * server started with HOOKLINE_FAKE_MODEL=1; never in a production build.
 */
export function fakeModelEnabled() {
  return process.env.HOOKLINE_FAKE_MODEL === "1" && process.env.NODE_ENV !== "production";
}

export function fakeIdeas(): GeneratedIdea[] {
  console.warn("[ideas] HOOKLINE_FAKE_MODEL=1: returning canned ideas, Claude was not called");
  const formats = ["POV", "Problem then solution", "Before and after", "Myth-busting", "Quick comparison"];
  const run = Date.now().toString(36);
  return GeneratedBatchSchema.parse({
    ideas: formats.map((format, i) => ({
      hook: `[Fake idea ${i + 1} · ${run}] Open on the product in close-up as the on-screen text asks a question.`,
      script_beats: ["Close-up of the product", "Show the problem it solves", "Show it in use", "End on the product"],
      filming_instructions: "Phone on a tripod by a window, close-up shots, add on-screen text, about 15 seconds.",
      format,
      trend_name: format,
      caption: `Fake caption ${i + 1} for testing #test`,
      duration_seconds: 15,
    })),
  }).ideas;
}
