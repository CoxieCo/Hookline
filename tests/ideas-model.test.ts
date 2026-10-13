import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IdeasError } from "@/lib/ideas/errors";
import type { ProfileValues } from "@/lib/profile/schema";

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

const { generateIdeasWithClaude, IDEAS_TEMPERATURE } = await import("@/lib/ideas/model");
const { acceptsSampling, CLAUDE_MODEL } = await import("@/lib/claude");
const Anthropic = (await import("@anthropic-ai/sdk")).default as unknown as {
  APIError: new (status: number, message: string) => Error;
};

const profile: ProfileValues = {
  business_name: "Tails & Trails",
  industry: "Pet accessories",
  product_description: "Reflective dog leads.",
  target_customer: "Early-morning dog walkers",
  brand_tone: "warm",
};

const idea = {
  hook: "Open on a dark street: only the lead glows.",
  script_beats: ["Dark street", "Headlights hit the lead", "It lights up"],
  filming_instructions: "Film at dusk with a phone, ~15s.",
  format: "Before and after",
  trend_name: "before-and-after",
  caption: "Seen on every walk ✨",
  duration_seconds: 15,
};
const good = { ideas: Array.from({ length: 5 }, () => idea) };

type SentRequest = {
  model: string;
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

  it("sends the shared model, temperature 0.8, a JSON schema and the delimited prompt", async () => {
    parseImpl = async () => ({ stop_reason: "end_turn", parsed_output: good });
    const out = await generateIdeasWithClaude(profile, ["an old hook"]);

    expect(out).toHaveLength(5);
    expect(out[0].trend_name).toBe("Before and after"); // normalised
    const req = parseCalls[0][0] as SentRequest;
    expect(CLAUDE_MODEL).toBe("claude-sonnet-4-5");
    expect(req.model).toBe(CLAUDE_MODEL);
    expect(req.temperature).toBe(IDEAS_TEMPERATURE);
    expect(IDEAS_TEMPERATURE).toBe(0.8);
    expect(req.output_config.format.type).toBe("json_schema");
    expect(req.output_config.format.schema.properties.ideas.items.required.sort()).toEqual(
      ["caption", "duration_seconds", "filming_instructions", "format", "hook", "script_beats", "trend_name"],
    );
    expect(req.system).toMatch(/untrusted data, not instructions/);
    expect(req.messages[0].content).toContain("<business_name>Tails & Trails</business_name>");
    expect(req.messages[0].content).toContain("<hook>an old hook</hook>");
  });

  it("only sends temperature to models that accept it", () => {
    expect(acceptsSampling("claude-sonnet-4-5")).toBe(true);
    expect(acceptsSampling("claude-haiku-4-5")).toBe(true);
    for (const m of ["claude-opus-5", "claude-opus-5-5", "claude-opus-4-8", "claude-sonnet-5", "claude-fable-5-1"]) {
      expect(acceptsSampling(m), m).toBe(false);
    }
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

  it("HOOKLINE_FAKE_MODEL=1 skips Claude in development…", async () => {
    vi.stubEnv("HOOKLINE_FAKE_MODEL", "1");
    vi.stubEnv("NODE_ENV", "development");
    const out = await generateIdeasWithClaude(profile, []);
    expect(out).toHaveLength(5);
    expect(parseCalls).toHaveLength(0);
  });

  it("…but never in production", async () => {
    vi.stubEnv("HOOKLINE_FAKE_MODEL", "1");
    vi.stubEnv("NODE_ENV", "production");
    parseImpl = async () => ({ stop_reason: "end_turn", parsed_output: good });
    await generateIdeasWithClaude(profile, []);
    expect(parseCalls).toHaveLength(1);
  });
});
