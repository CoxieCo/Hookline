export type SocialPlatform = "instagram" | "tiktok";

export type ClassifiedInput =
  | { kind: "website"; url: URL; isBareDomain: boolean }
  | { kind: "social"; handle: string; platforms: SocialPlatform[] }
  | { kind: "invalid"; why: string };

const HANDLE = /^[A-Za-z0-9._]{1,30}$/;
const INSTAGRAM_RESERVED = new Set(["p", "reel", "reels", "explore", "stories", "accounts", "tv", "direct"]);
const NON_WEB_SCHEME = /^(javascript|data|file|mailto|ftp|about|blob|vbscript|gopher|ws|wss|tel|sms):/i;

export function socialProfileUrl(platform: SocialPlatform, handle: string) {
  return platform === "instagram"
    ? `https://www.instagram.com/${handle}/`
    : `https://www.tiktok.com/@${handle}`;
}

/**
 * Decides whether the user pasted a website or an Instagram/TikTok profile.
 * Pure string handling — no network. Address safety is checked separately
 * by the SSRF guard at fetch time.
 */
export function classifyInput(raw: string): ClassifiedInput {
  const input = raw.trim();
  if (!input) return { kind: "invalid", why: "empty" };
  if (input.length > 2048) return { kind: "invalid", why: "too long" };
  if (/\s/.test(input)) return { kind: "invalid", why: "contains whitespace" };

  if (input.startsWith("@")) {
    const handle = input.slice(1);
    return HANDLE.test(handle)
      ? { kind: "social", handle, platforms: ["instagram", "tiktok"] }
      : { kind: "invalid", why: "bad handle" };
  }

  let candidate = input;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
    if (NON_WEB_SCHEME.test(candidate)) return { kind: "invalid", why: "non-web scheme" };
    candidate = `https://${candidate}`;
  }

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return { kind: "invalid", why: "unparseable" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { kind: "invalid", why: `scheme ${url.protocol}` };
  }

  const host = url.hostname.toLowerCase().replace(/^(www|m)\./, "");
  const segments = url.pathname.split("/").filter(Boolean);

  if (host === "instagram.com") {
    const handle = segments[0];
    if (!handle || INSTAGRAM_RESERVED.has(handle.toLowerCase()) || !HANDLE.test(handle)) {
      return { kind: "invalid", why: "not an instagram profile URL" };
    }
    return { kind: "social", handle, platforms: ["instagram"] };
  }

  if (host === "tiktok.com") {
    const handle = segments[0]?.startsWith("@") ? segments[0].slice(1) : "";
    if (!HANDLE.test(handle)) return { kind: "invalid", why: "not a tiktok profile URL" };
    return { kind: "social", handle, platforms: ["tiktok"] };
  }

  const isIpLiteral = /^[\d.]+$/.test(url.hostname) || url.hostname.startsWith("[");
  if (!isIpLiteral && !url.hostname.includes(".")) {
    return { kind: "invalid", why: "no domain" };
  }

  return {
    kind: "website",
    url,
    isBareDomain: (url.pathname === "/" || url.pathname === "") && !url.search,
  };
}
