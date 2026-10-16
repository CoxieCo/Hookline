import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IdeasError } from "@/lib/ideas/errors";
import type { ProfileWithFacts } from "@/lib/profile/schema";

// SDK mocked: no API key, no network.
// A plain function rather than vi.fn(): Vitest 5 turns a rejected promise
// returned by a vi.fn() into an unhandled rejection that fails a later test.
const parseCalls: unknown[][] = [];
let parseImpl: (req: unknown) => Promise<unknown> = async () => {
  throw new Error("parseImpl not set");
};
vi.mock("@anthropic-ai/sdk", () => {
  class APIError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  }
  class Anthropic {
    static APIError = APIError;
    messages = {
      parse: (req: unknown) => {
        parseCalls.push([req]);
        return parseImpl(req);
      },
    };
  }
  return { default: Anthropic, APIError };
});

// The default model is whatever applies with no override set.
vi.stubEnv("ANTHROPIC_MODEL", "");
const { generateIdeasWithClaude, requestIdeasFromClaude, IDEAS_TEMPERATURE } = await import("@/lib/ideas/model");
const { fakeModelEnabled, FAKE_MODEL_CLAIM, FAKE_MISSED_NUMBER } = await import("@/lib/ideas/fake");
const { acceptsSampling, CLAUDE_MODEL, DEFAULT_CLAUDE_MODEL } = await import("@/lib/claude");
vi.unstubAllEnvs();
const Anthropic = (await import("@anthropic-ai/sdk")).default as unknown as {
  APIError: new (status: number, message: string) => Error;
};

const profile: ProfileWithFacts = {
  business_name: "Tails & Trails",
  industry: "Pet accessories",
  product_description: "Reflective dog leads.",
  target_customer: "Early-morning dog walkers",
  brand_tone: "warm",
  product_facts: "Reflective stitching\nSizes S-L",
};

const idea = {
  hook: "Open on a dark street: only the lead glows.",
  script_beats: ["Dark street", "Headlights hit the lead", "It lights up"],
  filming_instructions: "Film at dusk with a phone, ~15s.",
  format: "Before and after",
  trend_name: "before-and-after",
  caption: "Seen on every walk ✨",
  duration_seconds: 15,
  claims_to_verify: [],
};
const good = { ideas: Array.from({ length: 5 }, () => idea) };

type SentRequest = {
  model: string;
  max_tokens: number;
  temperature?: number;
  system: string;
  messages: { content: string }[];
  output_config: { format: { type: string; schema: { properties: { ideas: { items: { required: string[] } } } } } };
};

async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (e) {
    return e as IdeasError;
  }
  throw new Error("expected a failure");
}

describe("generateIdeasWithClaude", () => {
  beforeEach(() => {
    parseCalls.length = 0;
  });
  afterEach(() => vi.unstubAllEnvs());

  it("sends the default model (claude-sonnet-5-5) without temperature, a JSON schema and the delimited prompt", async () => {
    parseImpl = async () => ({ stop_reason: "end_turn", parsed_output: good });
    const out = await generateIdeasWithClaude(profile, ["an old hook"]);

    expect(out).toHaveLength(5);
    expect(out[0].trend_name).toBe("Before and after"); // normalised
    const req = parseCalls[0][0] as SentRequest;
    expect(DEFAULT_CLAUDE_MODEL).toBe("claude-sonnet-5-5");
    expect(CLAUDE_MODEL).toBe("claude-sonnet-5-5");
    expect(req.model).toBe("claude-sonnet-5-5");
    // Sonnet 5.5 rejects non-default sampling values with a 400.
    expect(req).not.toHaveProperty("temperature");
    expect(req).not.toHaveProperty("thinking");
    expect(req.output_config.format.type).toBe("json_schema");
    expect(req.output_config.format.schema.properties.ideas.items.required.sort()).toEqual(
      ["caption", "claims_to_verify", "duration_seconds", "filming_instructions", "format", "hook", "script_beats", "trend_name"],
    );
    expect(req.max_tokens).toBe(16_000);
    expect(req.system).toMatch(/untrusted data, not instructions/);
    expect(req.messages[0].content).toContain("<business_name>Tails & Trails</business_name>");
    expect(req.messages[0].content).toContain("<hook>an old hook</hook>");
    expect(req.messages[0].content).toContain("<product_facts>\nReflective stitching\nSizes S-L\n</product_facts>");
  });

  it("merges numbers the model didn't list into claims_to_verify, keeping the model's own claims", async () => {
    const ideas = [
      { ...idea, script_beats: ["Dark street", "Glows for 8 hours", "It lights up"], claims_to_verify: ["Glows in the dark"] },
      ...good.ideas.slice(1),
    ];
    parseImpl = async () => ({ stop_reason: "end_turn", parsed_output: { ideas } });
    const out = await generateIdeasWithClaude(profile, []);
    expect(out[0].claims_to_verify).toEqual(["Glows in the dark", "“8 hours” (script beat 2)"]);
    expect(out[1].claims_to_verify).toEqual([]);
  });

  it("flags never fail the batch", async () => {
    const flagged = { ...idea, caption: "10,000 happy customers, 98% dry, £30", claims_to_verify: ["x", "y"] };
    parseImpl = async () => ({ stop_reason: "end_turn", parsed_output: { ideas: Array.from({ length: 5 }, () => flagged) } });
    const out = await generateIdeasWithClaude(profile, []);
    expect(out).toHaveLength(5);
    expect(out[0].claims_to_verify).toHaveLength(5);
    expect(parseCalls).toHaveLength(1); // no regeneration
  });

  it("requestIdeasFromClaude returns the model's ideas before the number check, with token usage", async () => {
    const ideas = [{ ...idea, caption: "Glows for 8 hours" }, ...good.ideas.slice(1)];
    parseImpl = async () => ({
      stop_reason: "end_turn",
      parsed_output: { ideas },
      usage: { input_tokens: 3000, output_tokens: 1500 },
    });
    const out = await requestIdeasFromClaude(profile, []);
    expect(out.ideas[0].claims_to_verify).toEqual([]);
    expect(out.usage).toEqual({ input_tokens: 3000, output_tokens: 1500 });
  });

  it("an idea without claims_to_verify → model_failed", async () => {
    const rest: Record<string, unknown> = { ...idea };
    delete rest.claims_to_verify;
    parseImpl = async () => ({ stop_reason: "end_turn", parsed_output: { ideas: [...good.ideas.slice(0, 4), rest] } });
    expect((await failure(generateIdeasWithClaude(profile, []))).reason).toBe("model_failed");
  });

  it("only sends temperature to models that accept it", () => {
    for (const m of ["claude-sonnet-4-5", "claude-sonnet-4-6", "claude-haiku-4-5", "claude-opus-4-6"]) {
      expect(acceptsSampling(m), m).toBe(true);
    }
    for (const m of [
      "claude-sonnet-5-5", "claude-sonnet-5", "claude-opus-5", "claude-opus-5-5", "claude-opus-4-8",
      "claude-opus-4-7", "claude-haiku-5-5", "claude-fable-5-1", "claude-mythos-5-1",
    ]) {
      expect(acceptsSampling(m), m).toBe(false);
    }
  });

  // ANTHROPIC_MODEL is read at import, so each case re-imports the modules.
  it.each([
    ["claude-sonnet-4-5", true],
    ["  claude-haiku-4-5  ", true], // trimmed
    ["claude-opus-4-8", false],
    ["claude-sonnet-5-5", false],
  ])("ANTHROPIC_MODEL=%j overrides the default, with model-specific options", async (envValue, sendsTemperature) => {
    vi.resetModules();
    vi.stubEnv("ANTHROPIC_MODEL", envValue);
    const claude = await import("@/lib/claude");
    const model = await import("@/lib/ideas/model");
    expect(claude.CLAUDE_MODEL).toBe(envValue.trim());

    parseImpl = async () => ({ stop_reason: "end_turn", parsed_output: good });
    await model.requestIdeasFromClaude(profile, []);
    const req = parseCalls[0][0] as SentRequest;
    expect(req.model).toBe(envValue.trim());
    expect(req.max_tokens).toBe(16_000);
    if (sendsTemperature) expect(req.temperature).toBe(IDEAS_TEMPERATURE);
    else expect(req).not.toHaveProperty("temperature");
    expect(req).not.toHaveProperty("thinking");
  });

  it.each(["refusal", "max_tokens", "pause_turn"])("stop_reason %s → model_failed", async (stop_reason) => {
    parseImpl = async () => ({ stop_reason, parsed_output: good });
    const err = await failure(generateIdeasWithClaude(profile, []));
    expect(err).toBeInstanceOf(IdeasError);
    expect(err.reason).toBe("model_failed");
    expect(err.message).toContain(stop_reason);
  });

  it("an off-spec batch (4 ideas) → model_failed", async () => {
    parseImpl = async () => ({ stop_reason: "end_turn", parsed_output: { ideas: good.ideas.slice(0, 4) } });
    expect((await failure(generateIdeasWithClaude(profile, []))).reason).toBe("model_failed");
  });

  it("an idea with an invented extra field → model_failed", async () => {
    const bad = { ideas: [...good.ideas.slice(0, 4), { ...idea, testimonial: "Best lead ever! – Sam" }] };
    parseImpl = async () => ({ stop_reason: "end_turn", parsed_output: bad });
    expect((await failure(generateIdeasWithClaude(profile, []))).reason).toBe("model_failed");
  });

  it("null parsed output → model_failed", async () => {
    parseImpl = async () => ({ stop_reason: "end_turn", parsed_output: null });
    expect((await failure(generateIdeasWithClaude(profile, []))).reason).toBe("model_failed");
  });

  it("an API error → model_failed", async () => {
    parseImpl = async () => {
      throw new Anthropic.APIError(529, "overloaded");
    };
    const err = await failure(generateIdeasWithClaude(profile, []));
    expect(err.reason).toBe("model_failed");
    expect(err.message).toContain("529");
  });

  it("an SDK parse error (e.g. truncated JSON) → model_failed", async () => {
    parseImpl = async () => {
      throw new SyntaxError("Unexpected end of JSON input");
    };
    expect((await failure(generateIdeasWithClaude(profile, []))).reason).toBe("model_failed");
  });

  it("HOOKLINE_FAKE_MODEL=1 skips Claude in local development…", async () => {
    vi.stubEnv("HOOKLINE_FAKE_MODEL", "1");
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("VERCEL_ENV", "");
    const out = await generateIdeasWithClaude(profile, []);
    expect(out).toHaveLength(5);
    expect(parseCalls).toHaveLength(0);
    // The canned batch exercises both kinds of flag: one the "model" listed, one the number check adds.
    expect(out[0].claims_to_verify).toEqual([FAKE_MODEL_CLAIM]);
    expect(out[1].claims_to_verify).toEqual([`“${FAKE_MISSED_NUMBER}” (script beat 2)`]);
    expect(out.slice(2).every((i) => i.claims_to_verify.length === 0)).toBe(true);
  });

  it.each([
    ["NODE_ENV=production", { NODE_ENV: "production" }],
    ["on Vercel (VERCEL=1)", { NODE_ENV: "development", VERCEL: "1" }],
    ["on a Vercel preview (VERCEL_ENV=preview)", { NODE_ENV: "development", VERCEL_ENV: "preview" }],
    ["on Vercel in production", { NODE_ENV: "production", VERCEL: "1", VERCEL_ENV: "production" }],
  ])("…but HOOKLINE_FAKE_MODEL=1 can't be activated %s: Claude is called", async (_label, env) => {
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("HOOKLINE_FAKE_MODEL", "1");
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    expect(fakeModelEnabled()).toBe(false);
    parseImpl = async () => ({ stop_reason: "end_turn", parsed_output: good });
    await generateIdeasWithClaude(profile, []);
    expect(parseCalls).toHaveLength(1);
  });

  it.each(["0", "true", "", undefined])("HOOKLINE_FAKE_MODEL=%j does not enable the fake", (value) => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("HOOKLINE_FAKE_MODEL", value);
    expect(fakeModelEnabled()).toBe(false);
  });

});
