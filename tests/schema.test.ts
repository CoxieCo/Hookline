import { describe, expect, it } from "vitest";
import {
  cleanProductFacts,
  ExtractedProfileSchema,
  FIELD_LIMITS,
  PRODUCT_FACTS_LIMIT,
  ProfileFormSchema,
} from "@/lib/profile/schema";

const validModelOutput = {
  business_name: "Paws Co",
  industry: "Pet supplies",
  product_description: "Durable dog toys and treats.",
  target_customer: "Dog owners",
  brand_tone: "playful, warm",
  product_facts: "Natural rubber\nSizes S-L",
  confidence: "high",
};

describe("ExtractedProfileSchema (model output validation)", () => {
  it("accepts a valid result", () => {
    expect(ExtractedProfileSchema.parse(validModelOutput)).toEqual(validModelOutput);
  });

  it("accepts empty strings for unknown fields", () => {
    const out = ExtractedProfileSchema.parse({ ...validModelOutput, target_customer: "", brand_tone: "" });
    expect(out.target_customer).toBe("");
  });

  it("trims whitespace", () => {
    expect(ExtractedProfileSchema.parse({ ...validModelOutput, industry: "  Pets \n" }).industry).toBe("Pets");
  });

  it.each(["N/A", "n/a", "Unknown", "none", "Not specified", "---"])("collapses placeholder %j to empty", (v) => {
    expect(ExtractedProfileSchema.parse({ ...validModelOutput, brand_tone: v }).brand_tone).toBe("");
  });

  it("truncates over-long fields to the limit", () => {
    const out = ExtractedProfileSchema.parse({ ...validModelOutput, business_name: "x".repeat(500) });
    expect(out.business_name).toHaveLength(FIELD_LIMITS.business_name);
  });

  it("cleans product_facts and collapses a placeholder to empty", () => {
    expect(ExtractedProfileSchema.parse({ ...validModelOutput, product_facts: " * Natural rubber \n\n" }).product_facts)
      .toBe("Natural rubber");
    expect(ExtractedProfileSchema.parse({ ...validModelOutput, product_facts: "None" }).product_facts).toBe("");
  });

  it("rejects a missing field", () => {
    const rest: Partial<typeof validModelOutput> = { ...validModelOutput };
    delete rest.industry;
    expect(ExtractedProfileSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects unexpected extra fields", () => {
    expect(ExtractedProfileSchema.safeParse({ ...validModelOutput, website: "x" }).success).toBe(false);
  });

  it.each(["certain", "HIGH", "", null])("rejects confidence %j", (confidence) => {
    expect(ExtractedProfileSchema.safeParse({ ...validModelOutput, confidence }).success).toBe(false);
  });

  it("rejects non-string field values", () => {
    expect(ExtractedProfileSchema.safeParse({ ...validModelOutput, industry: 42 }).success).toBe(false);
    expect(ExtractedProfileSchema.safeParse({ ...validModelOutput, industry: null }).success).toBe(false);
  });

  it("rejects non-objects", () => {
    for (const v of [null, undefined, "{}", [], 1]) {
      expect(ExtractedProfileSchema.safeParse(v).success).toBe(false);
    }
  });
});

describe("cleanProductFacts", () => {
  it("keeps one fact per line, without bullets, numbering or blank lines", () => {
    expect(cleanProductFacts("- Waterproof\r\n\r\n• Reflective strips\n3) Sizes S-L\n* Unknown")).toBe(
      "Waterproof\nReflective strips\nSizes S-L",
    );
  });

  it("keeps hyphenated text and numbers that aren't list markers", () => {
    expect(cleanProductFacts("5-year guarantee\n-10% off\n2.5 m lead")).toBe("5-year guarantee\n-10% off\n2.5 m lead");
  });

  it("drops whole lines past the limit rather than cutting a fact in half", () => {
    const line = "x".repeat(600);
    const out = cleanProductFacts([line, line, line].join("\n"));
    expect(out).toBe(`${line}\n${line}`);
    expect(out.length).toBeLessThanOrEqual(PRODUCT_FACTS_LIMIT);
  });

  it("returns empty for nothing", () => {
    expect(cleanProductFacts("  \n ")).toBe("");
  });
});

describe("ProfileFormSchema (save action validation)", () => {
  const form = {
    business_name: "Paws Co",
    industry: "Pet supplies",
    product_description: "Dog toys",
    target_customer: "Dog owners",
    brand_tone: "playful",
    source_type: "website",
    source_url: "https://paws.example/",
  };

  it("accepts a valid form and keeps the source URL", () => {
    expect(ProfileFormSchema.parse(form).source_url).toBe("https://paws.example/");
  });

  it("product_facts is optional and defaults to an empty string", () => {
    expect(ProfileFormSchema.parse(form).product_facts).toBe("");
    expect(ProfileFormSchema.parse({ ...form, product_facts: "   " }).product_facts).toBe("");
  });

  it("product_facts is trimmed and its line endings normalised", () => {
    expect(ProfileFormSchema.parse({ ...form, product_facts: "  Waterproof\r\nSizes S-L \n" }).product_facts).toBe(
      "Waterproof\nSizes S-L",
    );
  });

  it(`product_facts is limited to ${PRODUCT_FACTS_LIMIT} characters on the server`, () => {
    expect(ProfileFormSchema.safeParse({ ...form, product_facts: "x".repeat(PRODUCT_FACTS_LIMIT) }).success).toBe(true);
    const r = ProfileFormSchema.safeParse({ ...form, product_facts: "x".repeat(PRODUCT_FACTS_LIMIT + 1) });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0].path).toEqual(["product_facts"]);
    expect(r.error?.issues[0].message).toBe("Product facts must be 1500 characters or fewer.");
  });

  it("a textarea's CRLF line breaks don't count double against the limit", () => {
    // 750 one-character lines: 1499 characters with \n, 2248 as submitted with \r\n.
    const facts = Array.from({ length: 750 }, () => "x").join("\r\n");
    expect(facts.length).toBeGreaterThan(PRODUCT_FACTS_LIMIT);
    expect(ProfileFormSchema.safeParse({ ...form, product_facts: facts }).success).toBe(true);
  });

  it("rejects a non-string product_facts", () => {
    expect(ProfileFormSchema.safeParse({ ...form, product_facts: 42 }).success).toBe(false);
  });

  it("drops source_url for manual profiles", () => {
    expect(ProfileFormSchema.parse({ ...form, source_type: "manual" }).source_url).toBeNull();
  });

  it("treats an empty source_url as null", () => {
    expect(ProfileFormSchema.parse({ ...form, source_url: "" }).source_url).toBeNull();
  });

  it.each(["business_name", "industry", "product_description", "target_customer", "brand_tone"] as const)(
    "requires %s (whitespace-only counts as empty)",
    (field) => {
      const r = ProfileFormSchema.safeParse({ ...form, [field]: "   " });
      expect(r.success).toBe(false);
      expect(r.error?.issues[0].path).toEqual([field]);
      expect(r.error?.issues[0].message).toMatch(/is required/);
    },
  );

  it.each(Object.entries(FIELD_LIMITS))("enforces the %s length limit (%i)", (field, limit) => {
    expect(ProfileFormSchema.safeParse({ ...form, [field]: "x".repeat(limit) }).success).toBe(true);
    const r = ProfileFormSchema.safeParse({ ...form, [field]: "x".repeat(limit + 1) });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0].message).toMatch(/characters or fewer/);
  });

  it.each(["tiktok", "Website", "", undefined])("rejects source_type %j", (source_type) => {
    expect(ProfileFormSchema.safeParse({ ...form, source_type }).success).toBe(false);
  });

  it.each(["javascript:alert(1)", "ftp://x.com", "not a url", `https://x.com/${"a".repeat(2100)}`])(
    "rejects source_url %j",
    (source_url) => {
      expect(ProfileFormSchema.safeParse({ ...form, source_url }).success).toBe(false);
    },
  );
});
