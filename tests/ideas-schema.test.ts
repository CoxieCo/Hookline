import { describe, expect, it } from "vitest";
import {
  GeneratedBatchSchema,
  GeneratedIdeaSchema,
  IdeaStatusUpdateSchema,
  ModelBatchSchema,
  normalizeTrendName,
} from "@/lib/ideas/schema";

const idea = (overrides: Record<string, unknown> = {}) => ({
  hook: "POV: your husky meets a chew toy he can't destroy. Open on the toy in his jaws.",
  script_beats: ["Toy drops on the floor", "Husky pounces", "Ten minutes later: still in one piece"],
  filming_instructions: "Phone on the floor, low angle, natural light from a window. About 15 seconds.",
  format: "POV",
  trend_name: "POV",
  caption: "Built for the chewers 🐾 #dogsoftiktok",
  duration_seconds: 15,
  claims_to_verify: ["Survives a husky's chewing"],
  ...overrides,
});
const batch = (n = 5, overrides: Record<string, unknown> = {}) => ({
  ideas: Array.from({ length: n }, () => idea(overrides)),
});

describe("GeneratedBatchSchema (model output re-validation)", () => {
  it("accepts a valid batch of 5", () => {
    const out = GeneratedBatchSchema.parse(batch());
    expect(out.ideas).toHaveLength(5);
    expect(out.ideas[0].trend_name).toBe("POV");
  });

  it.each([0, 4, 6, 10])("rejects a batch of %i ideas", (n) => {
    expect(GeneratedBatchSchema.safeParse(batch(n)).success).toBe(false);
  });

  it("rejects extra fields on an idea", () => {
    expect(GeneratedBatchSchema.safeParse(batch(5, { rating: "5 stars" })).success).toBe(false);
  });

  it("rejects extra top-level fields", () => {
    expect(GeneratedBatchSchema.safeParse({ ...batch(), note: "hi" }).success).toBe(false);
  });

  it.each(["hook", "script_beats", "filming_instructions", "format", "trend_name", "caption", "duration_seconds", "claims_to_verify"])(
    "rejects an idea missing %s",
    (field) => {
      const bad = idea();
      delete (bad as Record<string, unknown>)[field];
      expect(GeneratedIdeaSchema.safeParse(bad).success).toBe(false);
    },
  );

  it.each([
    ["2 beats", ["a", "b"]],
    ["7 beats", ["a", "b", "c", "d", "e", "f", "g"]],
    ["a blank beat", ["a", "  ", "c"]],
    ["a non-string beat", ["a", 2, "c"]],
    ["a string instead of an array", "a, b, c"],
  ])("rejects script_beats with %s", (_label, beats) => {
    expect(GeneratedIdeaSchema.safeParse(idea({ script_beats: beats })).success).toBe(false);
  });

  it.each([3, 6])("accepts %i beats", (n) => {
    const beats = Array.from({ length: n }, (_, i) => `beat ${i}`);
    expect(GeneratedIdeaSchema.safeParse(idea({ script_beats: beats })).success).toBe(true);
  });

  it.each([6, 46, 12.5, "15", -1])("rejects duration_seconds %j", (d) => {
    expect(GeneratedIdeaSchema.safeParse(idea({ duration_seconds: d })).success).toBe(false);
  });

  it.each([7, 45])("accepts duration_seconds %i", (d) => {
    expect(GeneratedIdeaSchema.safeParse(idea({ duration_seconds: d })).success).toBe(true);
  });

  it("enforces a caption under 150 characters", () => {
    expect(GeneratedIdeaSchema.safeParse(idea({ caption: "x".repeat(149) })).success).toBe(true);
    expect(GeneratedIdeaSchema.safeParse(idea({ caption: "x".repeat(150) })).success).toBe(false);
  });

  it.each(["hook", "filming_instructions", "format", "caption"])("rejects a blank %s", (field) => {
    expect(GeneratedIdeaSchema.safeParse(idea({ [field]: "   " })).success).toBe(false);
  });

  it("rejects wrong types", () => {
    expect(GeneratedIdeaSchema.safeParse(idea({ hook: 42 })).success).toBe(false);
    expect(GeneratedBatchSchema.safeParse({ ideas: "five ideas" }).success).toBe(false);
    expect(GeneratedBatchSchema.safeParse(null).success).toBe(false);
  });

  it("trims text fields", () => {
    expect(GeneratedIdeaSchema.parse(idea({ hook: "  Hello  \n" })).hook).toBe("Hello");
  });
});

describe("claims_to_verify", () => {
  it("accepts an empty list", () => {
    expect(GeneratedIdeaSchema.parse(idea({ claims_to_verify: [] })).claims_to_verify).toEqual([]);
  });

  it("trims, collapses whitespace, and drops blanks and case-insensitive duplicates", () => {
    const out = GeneratedIdeaSchema.parse(
      idea({ claims_to_verify: ["  Lasts 10 hours ", "", "   ", "lasts 10 hours", "Machine\n washable"] }),
    );
    expect(out.claims_to_verify).toEqual(["Lasts 10 hours", "Machine washable"]);
  });

  it("clips an over-long claim instead of failing the batch", () => {
    const out = GeneratedIdeaSchema.parse(idea({ claims_to_verify: ["x".repeat(1000)] }));
    expect(out.claims_to_verify[0]).toHaveLength(300);
    expect(out.claims_to_verify[0].endsWith("…")).toBe(true);
  });

  it("keeps at most 20 claims", () => {
    const many = Array.from({ length: 30 }, (_, i) => `claim ${i}`);
    expect(GeneratedIdeaSchema.parse(idea({ claims_to_verify: many })).claims_to_verify).toHaveLength(20);
  });

  it.each([["a string", "Lasts 10 hours"], ["numbers", [1, 2]], ["null", null]])("rejects %s", (_label, value) => {
    expect(GeneratedIdeaSchema.safeParse(idea({ claims_to_verify: value })).success).toBe(false);
  });

  it("is part of the schema sent to the model, after the content fields", () => {
    const keys = Object.keys(ModelBatchSchema.shape.ideas.element.shape);
    expect(keys.at(-1)).toBe("claims_to_verify");
  });
});

describe("trend_name normalisation", () => {
  it.each([
    ["POV", "POV"],
    ["pov", "POV"],
    ["problem-then-solution", "Problem then solution"],
    ["BEFORE AND AFTER!", "Before and after"],
    ["Stop scrolling if you own a ___", "Stop scrolling if you own a ___"],
  ])("maps %j to %j", (input, expected) => {
    expect(normalizeTrendName(input)).toBe(expected);
  });

  it.each(["", "   ", "Viral dance", "trending now", "Before & After"])("maps unknown %j to empty", (input) => {
    expect(normalizeTrendName(input)).toBe("");
  });

  it("is applied when validating an idea", () => {
    expect(GeneratedIdeaSchema.parse(idea({ trend_name: "myth busting" })).trend_name).toBe("Myth-busting");
    expect(GeneratedIdeaSchema.parse(idea({ trend_name: "made up" })).trend_name).toBe("");
  });
});

describe("ModelBatchSchema (sent to the API)", () => {
  it("has no limits, so it converts cleanly — limits live in GeneratedBatchSchema", () => {
    // 2 beats and a 99s video pass the model schema but not the strict one.
    const loose = batch(2, { script_beats: ["a", "b"], duration_seconds: 99 });
    expect(ModelBatchSchema.safeParse(loose).success).toBe(true);
    expect(GeneratedBatchSchema.safeParse(loose).success).toBe(false);
  });
});

describe("IdeaStatusUpdateSchema (PATCH body)", () => {
  it.each(["new", "saved", "dismissed"])("accepts %j", (status) => {
    expect(IdeaStatusUpdateSchema.parse({ status })).toEqual({ status });
  });

  it.each([{ status: "archived" }, { status: "" }, {}, { status: "saved", hook: "x" }, { hook: "x" }, null, "saved"])(
    "rejects %j",
    (body) => {
      expect(IdeaStatusUpdateSchema.safeParse(body).success).toBe(false);
    },
  );
});
