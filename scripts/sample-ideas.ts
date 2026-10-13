// Makes ONE real Claude call through the production prompt + validation code
// with a made-up pet accessories profile, and prints the ideas for review.
// Costs API credit. Never prints keys.
//
//   node --env-file=.env.local --experimental-transform-types \
//     --import ./scripts/ts-alias-hooks.mjs scripts/sample-ideas.ts [--avoid=<file with one hook per line>]
import { readFileSync } from "node:fs";
import { CLAUDE_MODEL, acceptsSampling } from "@/lib/claude";
import { IdeasError } from "@/lib/ideas/errors";
import { generateIdeasWithClaude, IDEAS_TEMPERATURE } from "@/lib/ideas/model";
import type { ProfileValues } from "@/lib/profile/schema";

const SAMPLE_PROFILE: ProfileValues = {
  business_name: "Muddy Paws Supply Co.",
  industry: "Pet accessories",
  product_description:
    "Reflective, waterproof dog leads, collars and harnesses in bright colours, plus a foldable silicone travel water bowl that clips onto the lead.",
  target_customer:
    "Dog owners in rainy cities who walk their dogs before work or after dark, mostly with medium and large breeds.",
  brand_tone: "Warm, cheeky, outdoorsy",
};

const avoidArg = process.argv.find((a) => a.startsWith("--avoid="));
const recentHooks = avoidArg
  ? readFileSync(avoidArg.slice("--avoid=".length), "utf8").split(/\r?\n/).filter(Boolean)
  : [];

console.log(`API key present: ${Boolean(process.env.ANTHROPIC_API_KEY)}`);
console.log(`Model: ${CLAUDE_MODEL} · temperature: ${acceptsSampling() ? IDEAS_TEMPERATURE : "not sent"}`);
console.log(`Recent hooks sent as "avoid": ${recentHooks.length}\n`);

const started = Date.now();
try {
  const ideas = await generateIdeasWithClaude(SAMPLE_PROFILE, recentHooks);
  console.log(`OK: ${ideas.length} ideas in ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
  ideas.forEach((idea, i) => {
    console.log(`━━ Idea ${i + 1} · ${idea.format}${idea.trend_name ? ` (trend: ${idea.trend_name})` : ""} · ~${idea.duration_seconds}s`);
    console.log(`HOOK: ${idea.hook}`);
    idea.script_beats.forEach((beat, j) => console.log(`  ${j + 1}. ${beat}`));
    console.log(`FILM: ${idea.filming_instructions}`);
    console.log(`CAPTION (${idea.caption.length} chars): ${idea.caption}\n`);
  });
  if (process.env.HOOKS_OUT) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(process.env.HOOKS_OUT, ideas.map((i) => i.hook).join("\n"));
  }
} catch (err) {
  if (err instanceof IdeasError) console.log(`FAILED: ${err.reason} — ${err.detail ?? ""}`);
  else console.log(`FAILED: ${(err as Error).message}`);
  process.exitCode = 1;
}
