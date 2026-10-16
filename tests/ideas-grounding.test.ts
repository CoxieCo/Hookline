import { describe, expect, it } from "vitest";
import { applyNumberCheck, findNumberMentions, groundingText, mergeNumberFlags } from "@/lib/ideas/grounding";
import type { GeneratedIdea } from "@/lib/ideas/schema";
import type { ProfileWithFacts } from "@/lib/profile/schema";

const profile: ProfileWithFacts = {
  business_name: "Muddy Paws Supply Co.",
  industry: "Pet accessories",
  product_description: "A waterproof dog harness with reflective strips.",
  target_customer: "Dog owners who walk in the rain",
  brand_tone: "warm, cheeky",
  product_facts: "Waterproof harness\nReflective strips\nSizes S-L",
};

const idea = (overrides: Partial<GeneratedIdea> = {}): GeneratedIdea => ({
  hook: '"Rain? What rain?" Open on the harness dripping wet.',
  script_beats: ["Pour water over the harness", "It beads off", "Headlights hit the reflective strips"],
  filming_instructions: "Phone on a tripod by the back door, about 15 seconds. Speed the pour up 2x.",
  format: "Before and after",
  trend_name: "Before and after",
  caption: "Puddles fear us 🐾",
  duration_seconds: 15,
  claims_to_verify: [],
  ...overrides,
});

const keys = (text: string) => findNumberMentions(text).map((m) => m.key);
const texts = (text: string) => findNumberMentions(text).map((m) => m.text);

describe("findNumberMentions", () => {
  it.each([
    ["Dries in 30 minutes", ["30min"]],
    ["Stays dry for 3 hours on a 5 km walk", ["3h", "5km"]],
    ["A 2.5m lead", ["2.5m"]],
    ["Ships in 3-5 days", ["3-5day"]],
    ["Ships in 3–5 days", ["3-5day"]],
    ["Ships in 3 to 5 days", ["3-5day"]],
    ["A 5-year guarantee", ["5year"]],
    ["98% of dogs", ["98%"]],
    ["Only 40 percent", ["40%"]],
    ["10x brighter", ["10x"]],
    ["£24.99 or $30", ["£24.99", "$30"]],
    ["just $25.00", ["$25"]],
    ["costs 30 dollars", ["$30"]],
    ["€1,200 total", ["€1200"]],
    ["$20–$30", ["$20-30"]],
    ["10,000 happy customers", ["10000customer"]],
    ["over 500 reviews", ["500review"]],
    ["5 stars", ["5star"]],
    ["5-star reviews", ["5star"]],
    ["rated 4.9/5", ["4.9/5"]],
    ["survives 100 washes", ["100wash"]],
    ["two hours later", ["2h"]],
    ["only weighs 120 g", ["120g"]],
    ["up to 25 mph", ["25mph"]],
    ["at -5 °C", ["5c"]],
  ])("%j → %j", (text, expected) => {
    expect(keys(text)).toEqual(expected);
  });

  it.each([
    "Sizes S-L",
    "Sizes S, M and L",
    "Step 1: clip it on",
    "Film 3 shots and 2 clips",
    "Do a 360° spin around the dog",
    '"Day 3" of the rain challenge',
    "One day, your dog will thank you",
    "Open on the first frame",
    "a 24/7 kind of dog",
    "3 dogs on a walk",
    "Pour water over it",
  ])("finds nothing in %j", (text) => {
    expect(findNumberMentions(text)).toEqual([]);
  });

  it("keeps the original wording for display", () => {
    expect(texts("Stays dry for 3 hours on a 5 km walk")).toEqual(["3 hours", "5 km"]);
  });
});

describe("mergeNumberFlags", () => {
  const grounding = groundingText(profile);

  it("flags nothing when the idea has no numbers", () => {
    expect(mergeNumberFlags(idea(), grounding)).toEqual([]);
  });

  it("catches a number the model's own list missed", () => {
    const out = mergeNumberFlags(
      idea({
        script_beats: ["Pour a full jug over the harness", "Still dry after 30 minutes", "Headlights hit the strips"],
        claims_to_verify: ["The harness keeps the dog itself dry"],
      }),
      grounding,
    );
    expect(out).toEqual(["The harness keeps the dog itself dry", "“30 minutes” (script beat 2)"]);
  });

  it("checks the hook, every beat, the filming instructions and the caption", () => {
    const out = mergeNumberFlags(
      idea({
        hook: '"Our harness is 10x brighter" Open on the dark street.',
        script_beats: ["Clip it on", "Walk 5 km", "Back home dry"],
        filming_instructions: "Film the harness under 2 litres of water.",
        caption: "Only £29 🐾",
      }),
      grounding,
    );
    expect(out).toEqual([
      "“10x” (hook)",
      "“5 km” (script beat 2)",
      "“2 litres” (filming instructions)",
      "“£29” (caption)",
    ]);
  });

  it("does not repeat a number the model already listed, however it was worded", () => {
    const out = mergeNumberFlags(
      idea({
        script_beats: ["Clip it on", "Dries in 30 mins", "Done"],
        claims_to_verify: ["Dries in 30 minutes"],
      }),
      grounding,
    );
    expect(out).toEqual(["Dries in 30 minutes"]);
  });

  it("flags the same number only once, at its first appearance", () => {
    const out = mergeNumberFlags(
      idea({ hook: '"5 km in the rain" Open on a puddle.', script_beats: ["Walk 5 km", "5km later: dry", "Done"] }),
      grounding,
    );
    expect(out).toEqual(["“5 km” (hook)"]);
  });

  it("does not flag numbers that appear in the profile or product facts", () => {
    const withNumbers: ProfileWithFacts = {
      ...profile,
      product_description: "Waterproof harness, £34.99.",
      product_facts: "Waterproof harness\nReflective strips\nSizes S-L\nShips in 3-5 days\n2 m matching lead",
    };
    const out = mergeNumberFlags(
      idea({
        script_beats: ["Just £34.99", "Ships in 3 to 5 days", "Comes with a 2m lead"],
        caption: "Now £29.99 🐾",
      }),
      groundingText(withNumbers),
    );
    // £34.99, 3-5 days and 2 m are grounded; the £29.99 "sale price" is not.
    expect(out).toEqual(["“£29.99” (caption)"]);
  });

  it("ignores video timing in the filming instructions, but not elsewhere", () => {
    const out = mergeNumberFlags(
      idea({
        filming_instructions: "Hold each shot for 3 seconds, speed it up 2x, about 15 seconds total.",
        script_beats: ["Clip it on", "Dries in 30 seconds", "Done"],
      }),
      grounding,
    );
    expect(out).toEqual(["“30 seconds” (script beat 2)"]);
  });

  it("matches a range only against the same range", () => {
    const facts = groundingText({ ...profile, product_facts: "Ships in 3-5 days" });
    expect(mergeNumberFlags(idea({ caption: "Ships in 2 days" }), facts)).toEqual(["“2 days” (caption)"]);
  });

  it("keeps the model's claims first and never drops one", () => {
    const out = mergeNumberFlags(
      idea({ caption: "100 washes and counting", claims_to_verify: ["Machine washable", "  ", "machine washable"] }),
      grounding,
    );
    expect(out).toEqual(["Machine washable", "“100 washes” (caption)"]);
  });
});

describe("applyNumberCheck", () => {
  it("runs on every idea in the batch and leaves the other fields alone", () => {
    const batch = [idea(), idea({ caption: "Rated 4.9/5 by owners" })];
    const out = applyNumberCheck(batch, profile);
    expect(out.map((i) => i.claims_to_verify)).toEqual([[], ["“4.9/5” (caption)"]]);
    expect(out[1].caption).toBe("Rated 4.9/5 by owners");
    expect(batch[1].claims_to_verify).toEqual([]); // input not mutated
  });
});
