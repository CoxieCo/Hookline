/** The one place the Claude model is chosen (profile extraction and idea generation). */
export const CLAUDE_MODEL = process.env.ANTHROPIC_MODEL?.trim() || "claude-sonnet-4-5";

// Newer models (Opus 4.7+, Sonnet 5, Fable, Mythos) reject sampling params
// with a 400, so temperature is only sent where it's accepted.
const REJECTS_SAMPLING = /^claude-(opus-(4-[7-9]|[5-9])|sonnet-[5-9]|fable|mythos)/;

export function acceptsSampling(model: string = CLAUDE_MODEL) {
  return !REJECTS_SAMPLING.test(model);
}
