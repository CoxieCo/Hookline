export type ExtractFailureReason =
  | "unauthorized"
  | "invalid_input"
  | "blocked_address"
  | "rate_limited"
  | "fetch_timeout"
  | "site_unreachable"
  | "page_unreadable"
  | "social_blocked"
  | "model_failed"
  | "server_error";

export const FAILURE_STATUS: Record<ExtractFailureReason, number> = {
  unauthorized: 401,
  invalid_input: 400,
  blocked_address: 400,
  rate_limited: 429,
  fetch_timeout: 504,
  site_unreachable: 502,
  page_unreadable: 422,
  social_blocked: 422,
  model_failed: 502,
  server_error: 500,
};

export const FAILURE_MESSAGES: Record<ExtractFailureReason, string> = {
  unauthorized: "Your session has expired. Please log in again.",
  invalid_input:
    "That doesn't look like a website or an Instagram/TikTok handle. Try something like yourstore.com or @yourbrand.",
  blocked_address: "That address points to a private or local network, so we can't read it.",
  rate_limited: "You've hit the limit of 10 profile builds per hour. You can fill in your profile by hand below.",
  fetch_timeout: "Your site took too long to respond, so we couldn't read it.",
  site_unreachable: "We couldn't reach that website. Check the address, or fill in your profile by hand.",
  page_unreadable: "We reached your site but couldn't find enough readable text on the page.",
  social_blocked:
    "Instagram and TikTok usually hide profiles from anyone who isn't logged in, so we couldn't read yours.",
  model_failed: "Our AI couldn't build a profile from that page this time.",
  server_error: "Something went wrong on our side.",
};

/** A failure with a user-facing reason code. `detail` is for server logs only. */
export class ExtractError extends Error {
  constructor(
    readonly reason: ExtractFailureReason,
    readonly detail?: string,
  ) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = "ExtractError";
  }
}

export type ExtractFailure = {
  ok: false;
  reason: ExtractFailureReason;
  message: string;
};
