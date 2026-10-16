/** The one place the Claude model is chosen (profile extraction and idea generation). */
export const DEFAULT_CLAUDE_MODEL = "claude-sonnet-5-5";
export const CLAUDE_MODEL = process.env.ANTHROPIC_MODEL?.trim() || DEFAULT_CLAUDE_MODEL;

// Newer models (Opus 4.7+, Sonnet 5+, Haiku 5+, Fable, Mythos) reject sampling
// params with a 400, so temperature is only sent where it's accepted.
const REJECTS_SAMPLING = /^claude-(opus-(4-[7-9]|[5-9])|sonnet-[5-9]|haiku-[5-9]|fable|mythos)/;

export function acceptsSampling(model: string = CLAUDE_MODEL) {
  return !REJECTS_SAMPLING.test(model);
}
