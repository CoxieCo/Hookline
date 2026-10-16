// Makes ONE real Claude call through the production prompt + validation code
// with a made-up pet accessories profile whose product facts are deliberately
// limited, and prints the ideas for review: what the model flagged itself in
// claims_to_verify, what the server's number check added, latency, tokens and
// an approximate cost. Costs API credit. Never prints keys.
//
//   node --env-file=.env.local --experimental-transform-types \
//     --import ./scripts/ts-alias-hooks.mjs scripts/sample-ideas.ts [--avoid=<file with one hook per line>]
//
// ANTHROPIC_MODEL=<id> picks the model, as in the app. SAMPLE_OUT=<file> also
// writes the raw result as JSON.
import { readFileSync, writeFileSync } from "node:fs";
import { CLAUDE_MODEL, acceptsSampling } from "@/lib/claude";
import { IdeasError } from "@/lib/ideas/errors";
import { applyNumberCheck } from "@/lib/ideas/grounding";
import { IDEAS_TEMPERATURE, requestIdeasFromClaude } from "@/lib/ideas/model";
import type { ProfileWithFacts } from "@/lib/profile/schema";

const SAMPLE_PROFILE: ProfileWithFacts = {
  business_name: "Muddy Paws Supply Co.",
  industry: "Pet accessories",
  product_description: "A waterproof dog harness with reflective strips.",
  target_customer: "Dog owners in rainy cities who walk their dogs before work or after dark.",
  brand_tone: "Warm, cheeky, outdoorsy",
  product_facts: "Waterproof harness\nReflective strips\nSizes S-L",
};

// USD per million tokens (input, output), standard API rates, for an estimate only.
const PRICES: Record<string, [number, number]> = {
  "claude-sonnet-4-5": [3, 15],
  "claude-sonnet-5": [2, 10],
  "claude-sonnet-5-5": [2, 10],
};

// The route's limit is 80s; the script waits longer so a slow model is measured, not lost.
const SCRIPT_TIMEOUT_MS = 170_000;
const ROUTE_TIMEOUT_MS = 80_000;

const avoidArg = process.argv.find((a) => a.startsWith("--avoid="));
const recentHooks = avoidArg
  ? readFileSync(avoidArg.slice("--avoid=".length), "utf8").split(/\r?\n/).filter(Boolean)
  : [];

console.log(`API key present: ${Boolean(process.env.ANTHROPIC_API_KEY)}`);
console.log(`Model: ${CLAUDE_MODEL} · temperature: ${acceptsSampling() ? IDEAS_TEMPERATURE : "not sent (model rejects sampling params)"}`);
console.log(`Product facts: ${JSON.stringify(SAMPLE_PROFILE.product_facts)}`);
console.log(`Recent hooks sent as "avoid": ${recentHooks.length}\n`);

const started = Date.now();
try {
  const { ideas: raw, usage } = await requestIdeasFromClaude(SAMPLE_PROFILE, recentHooks, { timeoutMs: SCRIPT_TIMEOUT_MS });
  const seconds = (Date.now() - started) / 1000;
  const checked = applyNumberCheck(raw, SAMPLE_PROFILE);

  const price = PRICES[CLAUDE_MODEL];
  const cost = price ? (usage.input_tokens * price[0] + usage.output_tokens * price[1]) / 1e6 : null;
  console.log(`OK: ${raw.length} ideas in ${seconds.toFixed(1)}s${seconds * 1000 > ROUTE_TIMEOUT_MS ? " (OVER the route's 80s limit: would fail in the app)" : ""}`);
  console.log(`Tokens: ${usage.input_tokens} in / ${usage.output_tokens} out · approx cost: ${cost === null ? "unknown model price" : `$${cost.toFixed(4)}`}\n`);

  checked.forEach((idea, i) => {
    const fromModel = raw[i].claims_to_verify;
    const fromCheck = idea.claims_to_verify.slice(fromModel.length);
    console.log(`━━ Idea ${i + 1} · ${idea.format}${idea.trend_name ? ` (trend: ${idea.trend_name})` : ""} · ~${idea.duration_seconds}s`);
    console.log(`HOOK: ${idea.hook}`);
    idea.script_beats.forEach((beat, j) => console.log(`  ${j + 1}. ${beat}`));
    console.log(`FILM: ${idea.filming_instructions}`);
    console.log(`CAPTION (${idea.caption.length} chars): ${idea.caption}`);
    console.log(`MODEL FLAGGED: ${fromModel.length ? "" : "(none)"}`);
    fromModel.forEach((c) => console.log(`  - ${c}`));
    console.log(`NUMBER CHECK ADDED: ${fromCheck.length ? "" : "(none)"}`);
    fromCheck.forEach((c) => console.log(`  - ${c}`));
    console.log("");
  });

  if (process.env.SAMPLE_OUT) {
    writeFileSync(
      process.env.SAMPLE_OUT,
      JSON.stringify({ model: CLAUDE_MODEL, seconds, usage, cost, raw, checked }, null, 2),
    );
  }
} catch (err) {
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (err instanceof IdeasError) console.log(`FAILED after ${seconds}s: ${err.reason} — ${err.detail ?? ""}`);
  else console.log(`FAILED after ${seconds}s: ${(err as Error).message}`);
  process.exitCode = 1;
}
