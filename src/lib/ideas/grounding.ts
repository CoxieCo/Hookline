import type { ProfileWithFacts } from "@/lib/profile/schema";
import { normalizeClaims, type GeneratedIdea } from "./schema";

/*
 * Deterministic post-check, run on every generated batch with no extra model
 * call: finds numbers with units, percentages and currency amounts in what
 * the owner would say or show, and flags any that don't also appear in the
 * profile or product facts. Flags are merged into claims_to_verify; nothing
 * is rejected or regenerated.
 */

/** A number as written ("3–5 days") and a canonical key for comparing ("3-5day"). */
export type NumberMention = { text: string; key: string };

// Canonical unit for every spelling we recognise. Left out on purpose: "in"
// (a word), '"' for inches (every hook opens with a quoted line), and a bare
// "°" or "degrees" ("a 360° spin" is a camera move, not a claim).
const UNITS: Record<string, string> = {
  mm: "mm", millimetre: "mm", millimeter: "mm",
  cm: "cm", centimetre: "cm", centimeter: "cm",
  m: "m", metre: "m", meter: "m",
  km: "km", kilometre: "km", kilometer: "km",
  inch: "in",
  ft: "ft", foot: "ft", feet: "ft",
  yd: "yd", yard: "yd",
  mi: "mi", mile: "mi",
  mg: "mg", g: "g", gram: "g", gsm: "gsm",
  kg: "kg", kilo: "kg", kilogram: "kg",
  lb: "lb", lbs: "lb", pound: "lb",
  oz: "oz", ounce: "oz",
  ml: "ml", millilitre: "ml", milliliter: "ml",
  l: "l", litre: "l", liter: "l",
  s: "s", sec: "s", secs: "s", second: "s",
  min: "min", mins: "min", minute: "min",
  h: "h", hr: "h", hrs: "h", hour: "h",
  day: "day", week: "week", month: "month", yr: "year", year: "year",
  mph: "mph", kph: "kmh", "km/h": "kmh",
  "°c": "c", "°f": "f",
  x: "x",
  "%": "%", percent: "%", "per cent": "%",
  // Social proof, sales and durability counts ("10,000 happy customers", "5 stars", "100 washes").
  customer: "customer", review: "review", order: "order", sold: "sold", buyer: "buyer",
  follower: "follower", rating: "rating", star: "star", sale: "sale", wash: "wash",
};

/** Counts that may have one describing word in between: "10,000 happy customers". */
const SOCIAL_NOUNS = new Set(["customer", "review", "order", "buyer", "follower", "rating", "sale"]);

// No "one": "One day, ..." is a figure of speech far more often than a claim.
const WORD_NUMBERS: Record<string, number> = {
  two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  twelve: 12, twenty: 20, thirty: 30, forty: 40, fifty: 50, hundred: 100,
};

const CURRENCY_SYMBOLS: Record<string, string> = { $: "$", "£": "£", "€": "€" };
const CURRENCY_WORDS: Record<string, string> = {
  usd: "$", dollar: "$", dollars: "$", gbp: "£", eur: "€", euro: "€", euros: "€",
};

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
// Longest first, so "km/h" wins over "km" and "mins" over "min".
const unitAlternation = Object.keys(UNITS)
  .sort((a, b) => b.length - a.length)
  .map((u) => (/^[a-z]/.test(u) ? `${esc(u)}(?:e?s)?` : esc(u)))
  .join("|");

const NUM = String.raw`\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?`;
const WORD_NUM = Object.keys(WORD_NUMBERS).join("|");
const RANGE_SEP = String.raw`\s?(?:-|–|—|to)\s?`;

// $25, £9.99, €1,200 ... optionally a range ("$20–$30").
const CURRENCY_BEFORE = new RegExp(String.raw`([$£€])\s?(${NUM})(?:${RANGE_SEP}[$£€]?\s?(${NUM}))?`, "gi");
// 25 USD, 30 dollars
const CURRENCY_AFTER = new RegExp(
  String.raw`(?<![\w.,])(${NUM})\s?(usd|gbp|eur|dollars?|euros?)\b`,
  "gi",
);
// 3-5 days, 10x, 2.5m, 5-year, 98%, 10,000 happy customers, ten hours, 4.9/5
const QUANTITY = new RegExp(
  String.raw`(?<![\w.,$£€])(${NUM}|${WORD_NUM})(?:${RANGE_SEP}(${NUM}|${WORD_NUM}))?\+?` +
    String.raw`(?:\s?-\s?|\s?)(?:([a-z]+)\s)?(${unitAlternation})(?![a-z0-9])`,
  "gi",
);
const RATING = /(?<![\w.,])(\d(?:\.\d)?)\s?\/\s?(5|10)(?![\d.])/gi;

function toNumber(raw: string) {
  const word = WORD_NUMBERS[raw.toLowerCase()];
  return String(word ?? parseFloat(raw.replace(/,/g, "")));
}

function canonicalUnit(raw: string) {
  const u = raw.toLowerCase();
  if (UNITS[u]) return UNITS[u];
  // Plurals: "hours", "inches", "washes".
  for (const strip of [/es$/, /s$/]) {
    const singular = u.replace(strip, "");
    if (UNITS[singular]) return UNITS[singular];
  }
  return null;
}

/** Every number-with-unit, percentage, currency amount and rating in `text`, in order. */
export function findNumberMentions(text: string): NumberMention[] {
  const found: (NumberMention & { at: number; end: number })[] = [];
  const add = (at: number, raw: string, key: string) => {
    const end = at + raw.length;
    // A span already claimed (e.g. "$25" before "25 dollars" rules) wins.
    if (found.some((f) => at < f.end && end > f.at)) return;
    found.push({ text: raw.trim(), key, at, end });
  };

  for (const m of text.matchAll(CURRENCY_BEFORE)) {
    const range = m[3] ? `-${toNumber(m[3])}` : "";
    add(m.index, m[0], `${CURRENCY_SYMBOLS[m[1]]}${toNumber(m[2])}${range}`);
  }
  for (const m of text.matchAll(CURRENCY_AFTER)) {
    add(m.index, m[0], `${CURRENCY_WORDS[m[2].toLowerCase()]}${toNumber(m[1])}`);
  }
  for (const m of text.matchAll(RATING)) {
    add(m.index, m[0], `${toNumber(m[1])}/${m[2]}`);
  }
  for (const m of text.matchAll(QUANTITY)) {
    const [, first, second] = m;
    let raw = m[0];
    let between: string | undefined = m[3];
    let unitRaw = m[4];
    // "5-star reviews": the word in between is itself the unit.
    if (between && canonicalUnit(between)) {
      raw = raw.slice(0, raw.toLowerCase().lastIndexOf(between.toLowerCase()) + between.length);
      unitRaw = between;
      between = undefined;
    }
    const unit = canonicalUnit(unitRaw);
    if (!unit) continue;
    // A describing word is only allowed before a social count, and a word
    // number only before a spelled-out unit ("two hours", not "two s").
    if (between && !SOCIAL_NOUNS.has(unit)) continue;
    if (WORD_NUMBERS[first.toLowerCase()] && unitRaw.length <= 2) continue;
    // Letter sizes ("Sizes S-L", "S, M, L") have no digits, so never get here.
    const range = second ? `-${toNumber(second)}` : "";
    add(m.index, raw, `${toNumber(first)}${range}${unit}`);
  }

  return found.sort((a, b) => a.at - b.at).map(({ text, key }) => ({ text, key }));
}

type Field = { label: string; text: string; /** Units here describe the video itself, not the product. */ videoUnits?: boolean };

function ideaFields(idea: GeneratedIdea): Field[] {
  return [
    { label: "hook", text: idea.hook },
    ...idea.script_beats.map((text, i) => ({ label: `script beat ${i + 1}`, text })),
    // "Hold for 3 seconds", "speed it up 2x": filming timing, not a product claim.
    { label: "filming instructions", text: idea.filming_instructions, videoUnits: true },
    { label: "caption", text: idea.caption },
  ];
}

const VIDEO_UNITS = new Set(["s", "x"]);

/** All the text an idea may take product specifics from. */
export function groundingText(profile: ProfileWithFacts) {
  return [
    profile.business_name,
    profile.industry,
    profile.product_description,
    profile.target_customer,
    profile.brand_tone,
    profile.product_facts,
  ].join("\n");
}

/**
 * claims_to_verify for one idea: the model's own list, plus a flag for every
 * number that appears in neither the grounding text nor the model's list.
 * Deduplicated; never removes anything the model listed.
 */
export function mergeNumberFlags(idea: GeneratedIdea, grounding: string): string[] {
  const allowed = new Set(findNumberMentions(grounding).map((m) => m.key));
  const alreadyListed = new Set(idea.claims_to_verify.flatMap((c) => findNumberMentions(c).map((m) => m.key)));
  const flags: string[] = [];
  const flagged = new Set<string>();

  for (const field of ideaFields(idea)) {
    for (const mention of findNumberMentions(field.text)) {
      const unit = mention.key.replace(/^[^a-z%°/]*/i, "");
      if (field.videoUnits && VIDEO_UNITS.has(unit)) continue;
      if (allowed.has(mention.key) || alreadyListed.has(mention.key) || flagged.has(mention.key)) continue;
      flagged.add(mention.key);
      flags.push(`“${mention.text}” (${field.label})`);
    }
  }
  return normalizeClaims([...idea.claims_to_verify, ...flags]);
}

export function applyNumberCheck(ideas: GeneratedIdea[], profile: ProfileWithFacts): GeneratedIdea[] {
  const grounding = groundingText(profile);
  return ideas.map((idea) => ({ ...idea, claims_to_verify: mergeNumberFlags(idea, grounding) }));
}
