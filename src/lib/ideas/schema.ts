import { z } from "zod";
import { TREND_NAMES, type TrendName } from "@/lib/trends";

// Shared by the generation route, the status route and the dashboard UI.

export const IDEAS_PER_BATCH = 5;

export const IDEA_STATUSES = ["new", "saved", "dismissed"] as const;
export type IdeaStatus = (typeof IDEA_STATUSES)[number];

export const IDEA_LIMITS = {
  hook: 400,
  beat: 200,
  minBeats: 3,
  maxBeats: 6,
  filming: 1500,
  format: 60,
  /** "Under 150 characters". */
  caption: 149,
  minDuration: 7,
  maxDuration: 45,
  claim: 300,
  maxClaims: 20,
} as const;

/**
 * Shape the model is constrained to via structured outputs. Kept free of
 * length/count/range limits (the API doesn't support them) so it converts
 * cleanly to a JSON Schema; GeneratedBatchSchema enforces them afterwards.
 */
export const ModelIdeaSchema = z.object({
  hook: z.string(),
  script_beats: z.array(z.string()),
  filming_instructions: z.string(),
  format: z.string(),
  trend_name: z.string(),
  caption: z.string(),
  duration_seconds: z.int(),
  // Last, so the model lists the claims in what it has already written.
  claims_to_verify: z.array(z.string()),
});

export const ModelBatchSchema = z.object({ ideas: z.array(ModelIdeaSchema) });

const text = (max: number) => z.string().trim().min(1).max(max);

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Maps the model's trend_name onto a trends-list entry, ignoring case and
 * punctuation ("problem-then-solution" → "Problem then solution"). Anything
 * that isn't on the list becomes "" (no trend) rather than failing the batch:
 * the SDK can only pass an enum to the API as a hint, not a hard constraint.
 */
export function normalizeTrendName(value: string): TrendName | "" {
  const key = squash(value);
  return (key && TREND_NAMES.find((name) => squash(name) === key)) || "";
}

/**
 * Trims, drops blanks and case-insensitive duplicates, and clips over-long
 * entries. Never fails the batch: a flag the user should see is worth more
 * than a perfectly formatted one.
 */
export function normalizeClaims(claims: string[]) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of claims) {
    const claim = raw.trim().replace(/\s+/g, " ");
    const key = claim.toLowerCase();
    if (!claim || seen.has(key)) continue;
    seen.add(key);
    out.push(claim.length > IDEA_LIMITS.claim ? `${claim.slice(0, IDEA_LIMITS.claim - 1)}…` : claim);
  }
  return out.slice(0, IDEA_LIMITS.maxClaims);
}

/** Second pass over whatever the model returned: exact shape, counts and limits. */
export const GeneratedIdeaSchema = z
  .object({
    hook: text(IDEA_LIMITS.hook),
    script_beats: z.array(text(IDEA_LIMITS.beat)).min(IDEA_LIMITS.minBeats).max(IDEA_LIMITS.maxBeats),
    filming_instructions: text(IDEA_LIMITS.filming),
    format: text(IDEA_LIMITS.format),
    trend_name: z.string().max(IDEA_LIMITS.format).transform(normalizeTrendName),
    caption: text(IDEA_LIMITS.caption),
    duration_seconds: z.int().min(IDEA_LIMITS.minDuration).max(IDEA_LIMITS.maxDuration),
    claims_to_verify: z.array(z.string()).transform(normalizeClaims),
  })
  .strict();

export const GeneratedBatchSchema = z
  .object({
    ideas: z.array(GeneratedIdeaSchema).length(IDEAS_PER_BATCH),
  })
  .strict();

export type GeneratedIdea = z.infer<typeof GeneratedIdeaSchema>;

/** Body of PATCH /api/ideas/[id]. Only the status can ever change. */
export const IdeaStatusUpdateSchema = z.object({ status: z.enum(IDEA_STATUSES) }).strict();

/** A generated_ideas row as the app reads it. */
export type Idea = {
  id: string;
  batch_id: string;
  hook: string;
  script_beats: string[];
  filming_instructions: string;
  format: string;
  caption: string;
  duration_seconds: number | null;
  trend_name: string | null;
  /** Specific claims not backed by the profile or product facts: "Check before posting". */
  claims_to_verify: string[];
  status: IdeaStatus;
  created_at: string;
};

export const IDEA_COLUMNS =
  "id, batch_id, hook, script_beats, filming_instructions, format, caption, duration_seconds, trend_name, claims_to_verify, status, created_at";
