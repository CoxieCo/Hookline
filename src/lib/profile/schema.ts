import { z } from "zod";

// Shared by the extraction route, the save action and the onboarding UI.

export const PROFILE_FIELDS = [
  "business_name",
  "industry",
  "product_description",
  "target_customer",
  "brand_tone",
] as const;

export type ProfileField = (typeof PROFILE_FIELDS)[number];
export type ProfileValues = Record<ProfileField, string>;

export const FIELD_LIMITS: Record<ProfileField, number> = {
  business_name: 120,
  industry: 120,
  product_description: 2000,
  target_customer: 1000,
  brand_tone: 300,
};

export const FIELD_LABELS: Record<ProfileField, string> = {
  business_name: "Business name",
  industry: "Industry",
  product_description: "Product description",
  target_customer: "Target customer",
  brand_tone: "Brand tone",
};

/**
 * Product facts: short lines the owner confirms are true and is happy to say
 * in videos. Optional (may be ""), so it isn't one of the required
 * PROFILE_FIELDS; it's the main source of product specifics for idea generation.
 */
export const PRODUCT_FACTS_LIMIT = 1500;
export const PRODUCT_FACTS_LABEL = "Product facts";

/** The profile as idea generation sees it. */
export type ProfileWithFacts = ProfileValues & { product_facts: string };

const PLACEHOLDER_RE = /^(n\/?a|unknown|none|not (specified|available|provided|stated)|-+)$/i;

/**
 * One fact per line: normalises line endings, strips bullet markers and
 * placeholder lines, and drops whole lines (never half a fact) past `max`.
 */
export function cleanProductFacts(text: string, max = PRODUCT_FACTS_LIMIT) {
  const lines = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/^\s*(?:[-*•·]|\d+[.)])\s+/, "").trim())
    .filter((line) => line && !PLACEHOLDER_RE.test(line));
  let out = "";
  for (const line of lines) {
    const next = out ? `${out}\n${line}` : line;
    if (next.length > max) break;
    out = next;
  }
  return out;
}

export const SOURCE_TYPES =["website", "social", "manual"] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export const CONFIDENCE = ["high", "medium", "low"] as const;
export type Confidence = (typeof CONFIDENCE)[number];

export const EMPTY_PROFILE: ProfileValues = {
  business_name: "",
  industry: "",
  product_description: "",
  target_customer: "",
  brand_tone: "",
};

/**
 * Shape the model is constrained to via structured outputs. Kept free of
 * transforms/limits so it converts cleanly to a JSON Schema for the API.
 */
export const ModelExtractionSchema = z.object({
  business_name: z.string(),
  industry: z.string(),
  product_description: z.string(),
  target_customer: z.string(),
  brand_tone: z.string(),
  product_facts: z.string(),
  confidence: z.enum(CONFIDENCE),
});

/**
 * Second pass over whatever the model returned: rejects wrong shapes, trims,
 * collapses "unknown"-style placeholders to "", and enforces field limits.
 */
const cleanModelString = (max: number) =>
  z
    .string()
    .transform((s) => s.trim())
    .transform((s) => (PLACEHOLDER_RE.test(s) ? "" : s))
    .transform((s) => s.slice(0, max));

export const ExtractedProfileSchema = z
  .object({
    business_name: cleanModelString(FIELD_LIMITS.business_name),
    industry: cleanModelString(FIELD_LIMITS.industry),
    product_description: cleanModelString(FIELD_LIMITS.product_description),
    target_customer: cleanModelString(FIELD_LIMITS.target_customer),
    brand_tone: cleanModelString(FIELD_LIMITS.brand_tone),
    product_facts: z.string().transform((s) => cleanProductFacts(s)),
    confidence: z.enum(CONFIDENCE),
  })
  .strict();

export type ExtractedProfile = z.infer<typeof ExtractedProfileSchema>;

const requiredField = (field: ProfileField) =>
  z
    .string({ error: `${FIELD_LABELS[field]} is required.` })
    .trim()
    .min(1, `${FIELD_LABELS[field]} is required.`)
    .max(FIELD_LIMITS[field], `${FIELD_LABELS[field]} must be ${FIELD_LIMITS[field]} characters or fewer.`);

/** Server-side validation for the save action. */
export const ProfileFormSchema = z
  .object({
    business_name: requiredField("business_name"),
    industry: requiredField("industry"),
    product_description: requiredField("product_description"),
    target_customer: requiredField("target_customer"),
    brand_tone: requiredField("brand_tone"),
    // Optional. Line endings are normalised first so a textarea's \r\n
    // doesn't count double against the limit.
    product_facts: z
      .string()
      .optional()
      .transform((s) => (s ?? "").replace(/\r\n?/g, "\n").trim())
      .pipe(
        z.string().max(PRODUCT_FACTS_LIMIT, `${PRODUCT_FACTS_LABEL} must be ${PRODUCT_FACTS_LIMIT} characters or fewer.`),
      ),
    source_type: z.enum(SOURCE_TYPES, { error: "Invalid profile source." }),
    source_url: z
      .string()
      .trim()
      .max(2048, "Source URL is too long.")
      .optional()
      .transform((s) => s || null)
      .refine((s) => s === null || /^https?:\/\/\S+$/i.test(s), {
        message: "Source URL must be an http(s) URL.",
      }),
  })
  // A manually typed profile has no source URL.
  .transform((p) => (p.source_type === "manual" ? { ...p, source_url: null } : p));

export type ProfileFormInput = z.input<typeof ProfileFormSchema>;
