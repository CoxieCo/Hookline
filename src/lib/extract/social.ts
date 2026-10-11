import "server-only";

import * as cheerio from "cheerio";
import { ExtractError } from "./errors";
import { socialProfileUrl, type SocialPlatform } from "./input";
import { safeFetch, type SafeFetchOptions } from "./ssrf";
import type { SourceContent } from "./website";

const MIN_BIO_CHARS = 20;

const clean = (s: string | undefined | null) => (s ?? "").replace(/\s+/g, " ").trim();

export type SocialProfile = { displayName: string; bio: string };

/**
 * Best-effort parse of a public profile page. Returns null when the page is a
 * login wall or has no real bio — we never pad the result with guesses.
 */
export function parseSocialProfile(platform: SocialPlatform, html: string, finalUrl: string): SocialProfile | null {
  if (/\/(accounts\/)?login\b/i.test(new URL(finalUrl).pathname)) return null;

  const $ = cheerio.load(html);
  const meta = (sel: string) => clean($(sel).first().attr("content"));
  const ogTitle = meta('meta[property="og:title"]');
  const description = meta('meta[property="og:description"]') || meta('meta[name="description"]');

  let displayName = "";
  let bio = "";

  if (platform === "instagram") {
    // og:title: "Name (@handle) • Instagram photos and videos"
    displayName = clean(ogTitle.replace(/\s*\(@[^)]*\).*$/, "").replace(/\s*•\s*Instagram.*$/i, ""));
    // og:description: "1,234 Followers, 56 Following, 78 Posts - See Instagram photos and videos from Name (@handle)"
    // Sometimes followed by ': "bio text"'. Strip the boilerplate; keep only a real bio.
    bio = clean(
      description
        .replace(/^[\d.,]+[KkMm]?\s+Followers?,\s*[\d.,]+[KkMm]?\s+Following,\s*[\d.,]+[KkMm]?\s+Posts?\s*-\s*/i, "")
        .replace(/^See Instagram photos and videos from\s+[^)]*\)\s*:?\s*/i, "")
        .replace(/^["“]|["”]$/g, ""),
    );
  } else {
    const hydration = $("script#__UNIVERSAL_DATA_FOR_REHYDRATION__").first().text();
    if (hydration) {
      try {
        const user = JSON.parse(hydration)?.__DEFAULT_SCOPE__?.["webapp.user-detail"]?.userInfo?.user;
        displayName = clean(user?.nickname);
        bio = clean(user?.signature);
      } catch {
        // Fall through to meta tags.
      }
    }
    if (!bio) {
      // "Name (@handle) on TikTok | 1.2M Likes. 30K Followers. <bio>.Watch the latest video from Name (@handle)."
      bio = clean(
        description
          .replace(/^.*?on TikTok\s*\|\s*[\d.,]+[KkMm]?\s+Likes\.\s*[\d.,]+[KkMm]?\s+Followers\.\s*/i, "")
          .replace(/\.?\s*Watch the latest video from .*$/i, ""),
      );
      if (bio === description) bio = ""; // pattern didn't match — don't trust it
    }
    if (!displayName) displayName = clean(ogTitle.replace(/\s*\(@[^)]*\).*$/, ""));
  }

  if (/log ?in|sign ?up/i.test(bio) && bio.length < 80) return null;
  if (bio.length < MIN_BIO_CHARS) return null;
  return { displayName, bio };
}

export async function readSocial(
  handle: string,
  platforms: SocialPlatform[],
  fetchOptions: SafeFetchOptions = {},
): Promise<SourceContent> {
  for (const platform of platforms) {
    const url = socialProfileUrl(platform, handle);
    let res;
    try {
      res = await safeFetch(url, { timeoutMs: 8_000, ...fetchOptions });
    } catch (err) {
      if (err instanceof ExtractError && err.reason === "blocked_address") throw err;
      continue; // timeouts / network errors: try the next platform
    }
    if (res.status !== 200) continue;

    const profile = parseSocialProfile(platform, res.body, res.url);
    if (!profile) continue;

    const label = platform === "instagram" ? "Instagram" : "TikTok";
    const text = [
      `Platform: ${label}`,
      `Handle: @${handle}`,
      profile.displayName && `Display name: ${profile.displayName}`,
      `Bio: ${profile.bio}`,
    ]
      .filter(Boolean)
      .join("\n");
    return { sourceUrl: url, text };
  }

  throw new ExtractError("social_blocked", `@${handle} on ${platforms.join("/")}`);
}
