import "server-only";

import { ExtractError } from "./errors";
import { contentLength, extractPage, formatPage, type PageContent } from "./html";
import { safeFetch, type SafeFetchOptions, type SafeResponse } from "./ssrf";

export const MAX_MODEL_CHARS = 15_000;
const MIN_READABLE_CHARS = 200;

// Common about/catalog paths (the /pages/* ones are Shopify's defaults).
const EXTRA_PATHS = ["/about", "/about-us", "/pages/about", "/pages/about-us", "/collections/all"];
const MAX_EXTRA_PAGES = 2;

export type SourceContent = { sourceUrl: string; text: string };

function isHtml(res: SafeResponse) {
  return !res.contentType || /text\/html|application\/xhtml\+xml/i.test(res.contentType);
}

export async function readWebsite(
  url: URL,
  isBareDomain: boolean,
  fetchOptions: SafeFetchOptions = {},
): Promise<SourceContent> {
  const res = await safeFetch(url.href, fetchOptions);
  if (res.status < 200 || res.status >= 300) {
    throw new ExtractError("site_unreachable", `HTTP ${res.status} from ${res.url}`);
  }
  if (!isHtml(res)) {
    throw new ExtractError("page_unreadable", `content-type ${res.contentType}`);
  }

  const pages: PageContent[] = [extractPage(res.body, res.url)];

  // For a bare domain, opportunistically read a couple of obvious subpages.
  // Failures are ignored; this is not a crawler.
  if (isBareDomain) {
    const origin = new URL(res.url).origin;
    const results = await Promise.allSettled(
      EXTRA_PATHS.map((path) =>
        safeFetch(`${origin}${path}`, { ...fetchOptions, timeoutMs: 5_000, maxBytes: 750_000 }),
      ),
    );
    const seen = new Set([res.url]);
    for (const r of results) {
      if (pages.length > MAX_EXTRA_PAGES) break;
      if (r.status !== "fulfilled") continue;
      const sub = r.value;
      // Skip errors, non-HTML, and subpages that just redirected to the homepage.
      if (sub.status !== 200 || !isHtml(sub) || seen.has(sub.url) || new URL(sub.url).pathname === "/") continue;
      seen.add(sub.url);
      const page = extractPage(sub.body, sub.url);
      if (contentLength(page) >= MIN_READABLE_CHARS) pages.push(page);
    }
  }

  if (pages.reduce((n, p) => n + contentLength(p), 0) < MIN_READABLE_CHARS) {
    throw new ExtractError("page_unreadable", `too little text at ${res.url}`);
  }

  // Homepage gets the most room; subpages share the rest.
  const budgets =
    pages.length === 1 ? [MAX_MODEL_CHARS] : [9_000, ...pages.slice(1).map(() => Math.floor(6_000 / (pages.length - 1)))];
  const text = pages.map((p, i) => formatPage(p, budgets[i])).join("\n\n---\n\n");

  return { sourceUrl: res.url, text: text.slice(0, MAX_MODEL_CHARS) };
}
