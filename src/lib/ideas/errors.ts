export type IdeasFailureReason =
  | "unauthorized"
  | "no_profile"
  | "rate_limited"
  | "invalid_input"
  | "not_found"
  | "model_failed"
  | "server_error";

export const IDEAS_FAILURE_STATUS: Record<IdeasFailureReason, number> = {
  unauthorized: 401,
  no_profile: 409,
  rate_limited: 429,
  invalid_input: 400,
  not_found: 404,
  model_failed: 502,
  server_error: 500,
};

export const IDEAS_FAILURE_MESSAGES: Record<IdeasFailureReason, string> = {
  unauthorized: "Your session has expired. Please log in again.",
  no_profile: "Set up your business profile first, so the ideas are about your store.",
  rate_limited: "You've used all 5 idea batches for the last 24 hours.",
  invalid_input: "That request wasn't valid.",
  not_found: "That idea no longer exists.",
  model_failed: "Our AI couldn't write ideas this time. This usually works on a second try.",
  server_error: "Something went wrong on our side.",
};

/** Max generation batches per user per rolling 24 hours (enforced in SQL). */
export const GENERATION_LIMIT = 5;

/** A failure with a user-facing reason code. `detail` is for server logs only. */
export class IdeasError extends Error {
  constructor(
    readonly reason: IdeasFailureReason,
    readonly detail?: string,
  ) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = "IdeasError";
  }
}

export type IdeasFailure = {
  ok: false;
  reason: IdeasFailureReason;
  message: string;
  /** rate_limited only: ISO time the next batch is allowed. */
  retry_at?: string;
};

/**
 * "You can generate again in 2 hours 5 minutes." Relative, so it's correct
 * whatever the user's time zone (the UI adds a local clock time). Rounds up
 * so it never promises a time that's too early.
 */
export function retryInWords(retryAt: Date, now: Date = new Date()) {
  const minutes = Math.max(1, Math.ceil((retryAt.getTime() - now.getTime()) / 60_000));
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const parts = [
    h > 0 && `${h} hour${h === 1 ? "" : "s"}`,
    m > 0 && `${m} minute${m === 1 ? "" : "s"}`,
  ].filter(Boolean);
  return `You can generate again in ${parts.join(" ")}.`;
}
