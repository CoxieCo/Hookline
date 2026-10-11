import * as cheerio from "cheerio";

export type PageContent = {
  url: string;
  title: string;
  description: string;
  siteName: string;
  headings: string[];
  products: string[];
  bodyText: string;
};

const clean = (s: string | undefined | null) =>
  (s ?? "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u200B-\u200F\u2028\u2029\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();

const uniq = (items: string[]) => [...new Set(items.filter(Boolean))];

/** Pulls readable, model-friendly content out of an HTML document. */
export function extractPage(html: string, url: string): PageContent {
  const $ = cheerio.load(html);
  const meta = (selector: string) => clean($(selector).first().attr("content"));

  const products = extractJsonLdProducts($);
  const metaPrice = meta('meta[property="product:price:amount"], meta[property="og:price:amount"]');
  if (metaPrice) {
    const currency = meta('meta[property="product:price:currency"], meta[property="og:price:currency"]');
    const name = meta('meta[property="og:title"]') || clean($("title").first().text());
    products.push(`${name} — ${metaPrice}${currency ? ` ${currency}` : ""}`);
  }

  const headings = uniq(
    $("h1, h2, h3")
      .map((_, el) => clean($(el).text()))
      .get()
      .filter((h) => h.length > 1 && h.length < 200),
  ).slice(0, 30);

  $("script, style, noscript, svg, iframe, template, nav, form, [aria-hidden='true']").remove();
  const main = $("main, [role='main'], article").first();
  const mainText = clean(main.text());
  const bodyText = mainText.length > 300 ? mainText : clean($("body").text());

  return {
    url,
    title: clean($("title").first().text()),
    description: meta('meta[name="description"]') || meta('meta[property="og:description"]'),
    siteName: meta('meta[property="og:site_name"]'),
    headings,
    products: uniq(products).slice(0, 25),
    bodyText,
  };
}

function extractJsonLdProducts($: cheerio.CheerioAPI): string[] {
  const out: string[] = [];
  const visit = (node: unknown, depth: number) => {
    if (!node || typeof node !== "object" || depth > 6 || out.length >= 25) return;
    if (Array.isArray(node)) return node.forEach((n) => visit(n, depth + 1));

    const obj = node as Record<string, unknown>;
    const types = ([] as unknown[]).concat(obj["@type"] ?? []).map(String);
    if (types.includes("Product") && typeof obj.name === "string") {
      const offers = ([] as unknown[]).concat(obj.offers ?? [])[0] as Record<string, unknown> | undefined;
      const price = offers?.price ?? offers?.lowPrice;
      const currency = offers?.priceCurrency;
      out.push(clean(`${obj.name}${price != null ? ` — ${price}${currency ? ` ${currency}` : ""}` : ""}`));
    }
    for (const key of ["@graph", "itemListElement", "item", "mainEntity"]) {
      if (key in obj) visit(obj[key], depth + 1);
    }
  };

  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      visit(JSON.parse($(el).text()), 0);
    } catch {
      // Malformed JSON-LD is common; ignore it.
    }
  });
  return out;
}

/** Characters of real content — used to decide whether a page is readable. */
export function contentLength(page: PageContent) {
  return page.description.length + page.headings.join(" ").length + page.bodyText.length;
}

/** Renders a page as compact labelled text, capped at `maxChars`. */
export function formatPage(page: PageContent, maxChars: number): string {
  const lines = [`URL: ${page.url}`];
  if (page.siteName) lines.push(`Site name: ${page.siteName}`);
  if (page.title) lines.push(`Title: ${page.title}`);
  if (page.description) lines.push(`Meta description: ${page.description}`);
  if (page.headings.length) lines.push(`Headings:\n${page.headings.map((h) => `- ${h}`).join("\n")}`);
  if (page.products.length) lines.push(`Products and prices:\n${page.products.map((p) => `- ${p}`).join("\n")}`);
  const header = lines.join("\n").slice(0, maxChars);
  const room = Math.max(0, maxChars - header.length - 20);
  const body = page.bodyText.length > room ? `${page.bodyText.slice(0, room)}…` : page.bodyText;
  return body ? `${header}\nPage text:\n${body}` : header;
}
