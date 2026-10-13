import { beforeEach, describe, expect, it, vi } from "vitest";
import { IdeasError, retryInWords } from "@/lib/ideas/errors";
import type { GeneratedIdea } from "@/lib/ideas/schema";

// The route's control flow around the quota, with Supabase and the model mocked.
// (The quota SQL itself is tested against Postgres in scripts/test-rls.mjs.)

type Result = { data: unknown; error: { message: string } | null };

/** Minimal chainable stand-in for a supabase-js query builder. */
function query(result: Result) {
  const q: Record<string, unknown> = {};
  for (const m of ["select", "order", "limit", "eq", "neq"]) q[m] = vi.fn(() => q);
  q.insert = vi.fn(() => q);
  q.maybeSingle = vi.fn(() => Promise.resolve(result));
  q.then = (resolve: (r: Result) => unknown, reject: (e: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return q;
}

let user: { id: string } | null;
let profileResult: Result;
let quotaResult: Result;
let recentResult: Result;
let insertResult: Result;
const rpc = vi.fn();
const adminFrom = vi.fn();
const generate = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user } }) },
    from: (table: string) => query(table === "business_profiles" ? profileResult : recentResult),
    rpc: (...args: unknown[]) => {
      rpc(...args);
      return Promise.resolve(quotaResult);
    },
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const q = query(insertResult);
      adminFrom(table, q);
      return q;
    },
  }),
}));
vi.mock("@/lib/ideas/model", () => ({ generateIdeasWithClaude: (...a: unknown[]) => generate(...a) }));

const { POST } = await import("@/app/api/ideas/generate/route");

const USER = "aaaaaaaa-0000-0000-0000-000000000001";
const profileRow = {
  business_name: "Tails & Trails",
  industry: "Pet accessories",
  product_description: "Reflective leads",
  target_customer: "Dog walkers",
  brand_tone: "warm",
};
const idea: GeneratedIdea = {
  hook: "Hook",
  script_beats: ["a", "b", "c"],
  filming_instructions: "Film it",
  format: "POV",
  trend_name: "",
  caption: "Caption",
  duration_seconds: 12,
};

async function call() {
  const res = await POST();
  return { status: res.status, body: await res.json() };
}

beforeEach(() => {
  user = { id: USER };
  profileResult = { data: profileRow, error: null };
  quotaResult = { data: { allowed: true, retry_at: null }, error: null };
  recentResult = { data: [{ hook: "old hook 1" }, { hook: "old hook 2" }], error: null };
  insertResult = { data: [], error: null };
  rpc.mockReset();
  adminFrom.mockReset();
  generate.mockReset();
  generate.mockResolvedValue(Array.from({ length: 5 }, () => idea));
});

describe("POST /api/ideas/generate", () => {
  it("401 unauthorized when signed out, touching nothing", async () => {
    user = null;
    const { status, body } = await call();
    expect(status).toBe(401);
    expect(body.reason).toBe("unauthorized");
    expect(rpc).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });

  it("no_profile without consuming quota", async () => {
    profileResult = { data: null, error: null };
    const { status, body } = await call();
    expect(status).toBe(409);
    expect(body.reason).toBe("no_profile");
    expect(rpc).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });

  it("server_error (not no_profile) when the profile query fails", async () => {
    profileResult = { data: null, error: { message: "boom" } };
    const { body } = await call();
    expect(body.reason).toBe("server_error");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("consumes the quota before calling the model", async () => {
    await call();
    expect(rpc).toHaveBeenCalledWith("consume_generation_quota");
    expect(rpc.mock.invocationCallOrder[0]).toBeLessThan(generate.mock.invocationCallOrder[0]);
  });

  it("rate_limited with a human retry time when the quota is used up; the model is not called", async () => {
    const retryAt = new Date(Date.now() + (2 * 60 + 5) * 60_000 - 30_000);
    quotaResult = { data: { allowed: false, retry_at: retryAt.toISOString() }, error: null };
    const { status, body } = await call();
    expect(status).toBe(429);
    expect(body.reason).toBe("rate_limited");
    expect(body.message).toBe(
      "You've used all 5 idea batches for the last 24 hours. You can generate again in 2 hours 5 minutes.",
    );
    expect(body.retry_at).toBe(retryAt.toISOString());
    expect(generate).not.toHaveBeenCalled();
    expect(adminFrom).not.toHaveBeenCalled();
  });

  it("treats an unexpected quota reply as rate limited, never as allowed", async () => {
    quotaResult = { data: null, error: null };
    const { body } = await call();
    expect(body.reason).toBe("rate_limited");
    expect(generate).not.toHaveBeenCalled();
  });

  it("server_error when the quota check itself fails; the model is not called", async () => {
    quotaResult = { data: null, error: { message: "rpc down" } };
    const { status, body } = await call();
    expect(status).toBe(500);
    expect(body.reason).toBe("server_error");
    expect(generate).not.toHaveBeenCalled();
  });

  it("sends the profile and recent hooks to the model", async () => {
    await call();
    expect(generate).toHaveBeenCalledWith(profileRow, ["old hook 1", "old hook 2"]);
  });

  it("model_failed is passed through, nothing is inserted", async () => {
    generate.mockRejectedValue(new IdeasError("model_failed", "stop_reason refusal"));
    const { status, body } = await call();
    expect(status).toBe(502);
    expect(body.reason).toBe("model_failed");
    expect(adminFrom).not.toHaveBeenCalled();
  });

  it("inserts 5 rows with one shared batch_id for the verified user, via the service client", async () => {
    const { status, body } = await call();
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(adminFrom).toHaveBeenCalledWith("generated_ideas", expect.anything());
    const insert = adminFrom.mock.calls[0][1].insert as ReturnType<typeof vi.fn>;
    const rows = insert.mock.calls[0][0] as Record<string, unknown>[];
    expect(rows).toHaveLength(5);
    expect(new Set(rows.map((r) => r.batch_id)).size).toBe(1);
    expect(rows[0].batch_id).toBe(body.batch_id);
    expect(rows.every((r) => r.user_id === USER)).toBe(true);
    expect(rows[0].trend_name).toBeNull(); // "" from the model is stored as NULL
    expect(Object.keys(rows[0])).not.toContain("status");
  });

  it("server_error when the insert fails", async () => {
    insertResult = { data: null, error: { message: "insert failed" } };
    const { body } = await call();
    expect(body.reason).toBe("server_error");
  });
});

describe("retryInWords", () => {
  const now = new Date("2026-10-11T12:00:00Z");
  const at = (minutes: number) => new Date(now.getTime() + minutes * 60_000);

  it.each([
    [0, "You can generate again in 1 minute."],
    [0.2, "You can generate again in 1 minute."],
    [1, "You can generate again in 1 minute."],
    [45, "You can generate again in 45 minutes."],
    [60, "You can generate again in 1 hour."],
    [61, "You can generate again in 1 hour 1 minute."],
    [23 * 60 + 59.5, "You can generate again in 24 hours."],
  ])("%f minutes → %j (rounded up)", (minutes, expected) => {
    expect(retryInWords(at(minutes), now)).toBe(expected);
  });
});
