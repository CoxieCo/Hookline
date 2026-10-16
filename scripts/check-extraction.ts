// Runs ONE profile extraction through the real code path (readWebsite →
// extractPage/formatPage → extractProfileWithClaude → schema validation) on a
// saved HTML fixture served from 127.0.0.1, never a live site, and prints the
// result with mechanical grounding checks. Costs API credit: one model
// invocation (the extractor's maxRetries: 1 allows at most 2 HTTP calls).
// Never prints keys.
//
//   node --env-file=.env.local --experimental-transform-types \
//     --import ./scripts/ts-alias-hooks.mjs scripts/check-extraction.ts [fixture.html]
//
// ANTHROPIC_MODEL=<id> picks the model, as in the app.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { CLAUDE_MODEL, acceptsSampling } from "@/lib/claude";
import { extractProfileWithClaude } from "@/lib/extract/model";
import { isBlockedAddress } from "@/lib/extract/ssrf";
import { readWebsite } from "@/lib/extract/website";
import { ExtractedProfileSchema, ModelExtractionSchema } from "@/lib/profile/schema";

const fixturePath = process.argv[2] ?? new URL("./fixtures/small-store.html", import.meta.url);
const html = readFileSync(fixturePath, "utf8");

// Phrases the fixture deliberately does NOT state as product facts (opinions,
// a testimonial's "60 hours") or never mentions at all (common inventions).
const MUST_NOT_APPEAR = [/\b60\b/, /eco/i, /sustainab/i, /non-toxic/i, /natural/i, /organic/i, /clean[- ]burn/i, /nicest/i, /\bbest\b/i, /long[- ]lasting/i];

const server = http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as AddressInfo).port;

console.log(`API key present: ${Boolean(process.env.ANTHROPIC_API_KEY)}`);
console.log(`Model: ${CLAUDE_MODEL} · temperature: ${acceptsSampling() ? "0" : "not sent (model rejects sampling params)"}`);

let exitCode = 0;
try {
  // Same loopback seam as the unit tests; production uses the SSRF defaults.
  const source = await readWebsite(new URL(`http://fernleaf.test:${port}/`), false, {
    resolver: async () => [{ address: "127.0.0.1", family: 4 }],
    isAddressAllowed: (ip) => ip === "127.0.0.1" || !isBlockedAddress(ip),
    allowedPorts: [port],
  });
  console.log(`Page text sent to the model: ${source.text.length} chars\n`);

  const started = Date.now();
  const profile = await extractProfileWithClaude(source.sourceUrl, source.text);
  console.log(`Seconds: ${((Date.now() - started) / 1000).toFixed(1)}\n`);
  console.log(JSON.stringify(profile, null, 2));

  const checks: [string, boolean][] = [];
  checks.push(["validates against ModelExtractionSchema", ModelExtractionSchema.safeParse(profile).success]);
  checks.push(["re-validates against ExtractedProfileSchema unchanged", JSON.stringify(ExtractedProfileSchema.parse(profile)) === JSON.stringify(profile)]);

  const sourceText = source.text.toLowerCase();
  const facts = profile.product_facts ? profile.product_facts.split("\n") : [];
  checks.push(["product_facts is non-empty", facts.length > 0]);
  for (const fact of facts) {
    const numbers = fact.match(/\d+(?:[.,]\d+)?/g) ?? [];
    const missing = numbers.filter((n) => !sourceText.includes(n));
    checks.push([`fact numbers all in page: ${JSON.stringify(fact)}${missing.length ? ` (missing ${missing.join(", ")})` : ""}`, missing.length === 0]);
  }
  for (const re of MUST_NOT_APPEAR) {
    checks.push([`product_facts has no ${re}`, !re.test(profile.product_facts)]);
  }

  console.log("\nChecks:");
  for (const [label, ok] of checks) console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  if (checks.some(([, ok]) => !ok)) exitCode = 1;
} catch (err) {
  console.error(`FAILED: ${(err as Error).name}: ${(err as Error).message}`);
  exitCode = 1;
} finally {
  server.close();
}
process.exit(exitCode);
