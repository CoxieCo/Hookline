import { describe, expect, it } from "vitest";
import { ExtractedProfileSchema, FIELD_LIMITS, ProfileFormSchema } from "@/lib/profile/schema";

const validModelOutput = {
  business_name: "Paws Co",
  industry: "Pet supplies",
  product_description: "Durable dog toys and treats.",
  target_customer: "Dog owners",
  brand_tone: "playful, warm",
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
