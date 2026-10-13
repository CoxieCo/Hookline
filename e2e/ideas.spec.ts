import { readFileSync } from "node:fs";
import { expect, test, type Browser, type Page } from "@playwright/test";

/*
 * Idea generation, end to end, against the real Supabase project in .env.local.
 *
 * Needs:
 *  - the generated_ideas + generation quota migrations applied to that project;
 *  - a dev server started with HOOKLINE_FAKE_MODEL=1, which replaces ONLY the
 *    Claude call with canned ideas (route, auth, quota, inserts and RLS are
 *    all real). Run with E2E_FAKE_MODEL=1 to confirm you did that, so this
 *    suite never spends API credit by accident.
 *
 * Two confirmed throwaway users are created with the Admin API (one with a
 * profile, one without), signed in through /login, and deleted afterwards
 * (ON DELETE CASCADE removes their profiles, ideas and quota log). Keys are
 * never logged.
 */

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes("=") && !l.trimStart().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);
const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const HAS_ADMIN_KEY = /^eyJ|^sb_secret_/.test(SERVICE_KEY);

const SHOTS = "screenshots";
const shot = (page: Page, name: string) => page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });

const admin = (path: string, init: RequestInit = {}) =>
  fetch(`${SUPABASE_URL}${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });

test.describe.configure({ mode: "serial" });

test("(f) signed-out requests to the idea routes return 401", async ({ request }) => {
  const res = await request.post("/api/ideas/generate");
  const body = await res.json();
  console.log(`signed-out POST /api/ideas/generate -> HTTP ${res.status()} ${JSON.stringify(body)}`);
  expect(res.status()).toBe(401);
  expect(body).toMatchObject({ ok: false, reason: "unauthorized" });

  const patch = await request.patch(`/api/ideas/${crypto.randomUUID()}`, { data: { status: "saved" } });
  console.log(`signed-out PATCH /api/ideas/<id> -> HTTP ${patch.status()} ${JSON.stringify(await patch.json())}`);
  expect(patch.status()).toBe(401);
});

test.describe("signed in", () => {
  test.skip(!HAS_ADMIN_KEY, "needs a real SUPABASE_SERVICE_ROLE_KEY in .env.local to create confirmed test users");
  test.skip(process.env.E2E_FAKE_MODEL !== "1", "start the dev server with HOOKLINE_FAKE_MODEL=1, then run with E2E_FAKE_MODEL=1");

  const stamp = Date.now();
  const withProfile = { email: `hookline-e2e-ideas-${stamp}@example.com`, password: `E2e-${crypto.randomUUID()}`, id: "" };
  const noProfile = { email: `hookline-e2e-noprof-${stamp}@example.com`, password: `E2e-${crypto.randomUUID()}`, id: "" };
  let page: Page;
  let migrated = false;
  const NEEDS_MIGRATION = "generated_ideas does not exist yet: paste the two migrations into the Supabase SQL Editor, then re-run";
  let savedHook = "";
  let dismissedHook = "";

  async function createUser(u: typeof withProfile) {
    const res = await admin("/auth/v1/admin/users", {
      method: "POST",
      body: JSON.stringify({ email: u.email, password: u.password, email_confirm: true }),
    });
    expect(res.status, "admin create user").toBe(200);
    u.id = (await res.json()).id;
  }

  async function signIn(browser: Browser, u: typeof withProfile) {
    const context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
    const p = await context.newPage();
    await p.goto("/login");
    await p.getByLabel("Email").fill(u.email);
    await p.getByLabel("Password").fill(u.password);
    await p.getByRole("button", { name: "Continue", exact: true }).click();
    await p.waitForURL(/\/(dashboard|onboarding)/);
    return p;
  }

  const ideaRows = async (userId: string, select = "id,hook,status,batch_id") =>
    (await admin(`/rest/v1/generated_ideas?user_id=eq.${userId}&select=${select}`)).json();

  test.beforeAll(async ({ browser }) => {
    // Tests that need the new tables skip (with a reason) until the migrations are applied.
    const probe = await admin("/rest/v1/generated_ideas?select=id&limit=1");
    migrated = probe.status === 200;
    console.log(`generated_ideas table present: ${migrated} (HTTP ${probe.status})`);

    await createUser(withProfile);
    await createUser(noProfile);
    const res = await admin("/rest/v1/business_profiles", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        user_id: withProfile.id,
        business_name: "E2E Muddy Paws",
        industry: "Pet accessories",
        product_description: "Reflective, waterproof dog leads and a clip-on travel bowl.",
        target_customer: "Dog owners who walk in the dark",
        brand_tone: "warm, cheeky",
        source_type: "manual",
      }),
    });
    expect(res.status, "insert profile").toBe(201);

    page = await signIn(browser, withProfile);
  });

  test.afterAll(async () => {
    await page?.context().close();
    for (const u of [withProfile, noProfile]) {
      if (!u.id) continue;
      const res = await admin(`/auth/v1/admin/users/${u.id}`, { method: "DELETE" });
      console.log(`cleanup: deleted test user -> HTTP ${res.status}`);
    }
  });

  test("(a) a user with a profile sees the Generate ideas button and the empty state", async () => {
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByTestId("profile-summary")).toContainText("E2E Muddy Paws");
    if (migrated) await expect(page.getByTestId("ideas-empty")).toBeVisible();
    // Before the migration the history query fails; the page must still work.
    else await expect(page.getByText(/We couldn.t load your earlier ideas/)).toBeVisible();

    const button = page.getByRole("button", { name: "Generate ideas" });
    await expect(button).toBeVisible();
    await expect(button).toBeEnabled();
    await expect(button).toBeInViewport();
    // Trial click: fails if anything covers the button's centre.
    await button.click({ trial: true });
    await shot(page, "ideas-a-generate-button");
  });

  test("(b) Generate shows the loading state, then 5 idea cards [model mocked]", async () => {
    test.skip(!migrated, NEEDS_MIGRATION);
    // Hold the request briefly so the loading state is observable; the server is real.
    await page.route("**/api/ideas/generate", async (route) => {
      await new Promise((r) => setTimeout(r, 1500));
      await route.continue();
    });

    await page.getByRole("button", { name: "Generate ideas" }).click();
    const loading = page.getByTestId("ideas-loading");
    await expect(loading).toBeVisible();
    await expect(loading.getByRole("status")).toContainText("Writing 5 ideas for E2E Muddy Paws");
    await expect(page.getByTestId("idea-skeleton")).toHaveCount(5);
    await expect(page.getByRole("button", { name: "Generating…" })).toBeDisabled();
    await shot(page, "ideas-b1-loading");

    const cards = page.getByTestId("idea-card");
    await expect(cards).toHaveCount(5, { timeout: 30_000 });
    await expect(loading).toHaveCount(0);
    await page.unroute("**/api/ideas/generate");

    // The canned ideas prove the fake model ran (so no API credit was spent).
    await expect(cards.first().getByTestId("idea-hook")).toContainText("[Fake idea");

    // Card anatomy, in visual order.
    const card = cards.first();
    const order = await card.evaluate((el) => {
      const find = (sel: string) => el.querySelector(sel);
      const y = (n: Element | null) => (n ? n.getBoundingClientRect().top : -1);
      const byText = (t: string) => [...el.querySelectorAll("h4, button")].find((n) => n.textContent?.trim() === t) ?? null;
      return {
        tag: y(find("span")),
        hook: y(find('[data-testid="idea-hook"]')),
        beats: y(find("ol")),
        film: y(byText("How to film it")),
        caption: y(byText("Caption")),
        save: y(byText("Save")),
        hookSize: parseFloat(getComputedStyle(find('[data-testid="idea-hook"]')!).fontSize),
        beatSize: parseFloat(getComputedStyle(find("ol li")!).fontSize),
      };
    });
    console.log(`card layout: ${JSON.stringify(order)}`);
    expect(order.tag).toBeLessThan(order.hook);
    expect(order.hook).toBeLessThan(order.beats);
    expect(order.beats).toBeLessThan(order.film);
    expect(order.film).toBeLessThan(order.caption);
    expect(order.caption).toBeLessThan(order.save);
    expect(order.hookSize).toBeGreaterThan(order.beatSize);
    await expect(card.locator("ol li")).toHaveCount(4);

    // Every control on every card is visible and not covered.
    for (const name of ["Copy", "Save", "Dismiss"]) {
      for (const b of await page.getByRole("button", { name, exact: true }).all()) {
        await b.scrollIntoViewIfNeeded();
        await expect(b).toBeVisible();
        await b.click({ trial: true });
      }
    }

    // Copy puts the caption on the clipboard.
    await card.getByRole("button", { name: "Copy", exact: true }).click();
    await expect(card.getByRole("button", { name: "Copied" })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/^Fake caption \d for testing/);

    const rows = await ideaRows(withProfile.id);
    expect(rows).toHaveLength(5);
    expect(new Set(rows.map((r: { batch_id: string }) => r.batch_id)).size).toBe(1);
    await page.evaluate(() => window.scrollTo(0, 0));
    await shot(page, "ideas-b2-five-cards");
  });

  test("(c) Save and Dismiss persist after a reload", async () => {
    test.skip(!migrated, NEEDS_MIGRATION);
    const cards = page.getByTestId("idea-card");
    savedHook = (await cards.nth(0).getByTestId("idea-hook").textContent())!.trim();
    dismissedHook = (await cards.nth(1).getByTestId("idea-hook").textContent())!.trim();

    await cards.nth(0).getByRole("button", { name: "Save", exact: true }).click();
    const savedCard = page.getByTestId("idea-card").filter({ hasText: savedHook });
    await expect(savedCard).toHaveAttribute("data-status", "saved");
    await expect(savedCard.getByRole("button", { name: "Saved", exact: true })).toHaveAttribute("aria-pressed", "true");

    await page.getByTestId("idea-card").filter({ hasText: dismissedHook }).getByRole("button", { name: "Dismiss" }).click();
    await expect(page.getByTestId("idea-card").filter({ hasText: dismissedHook })).toHaveCount(0);
    await expect(page.getByTestId("idea-card")).toHaveCount(4);

    await page.reload();
    await expect(page.getByTestId("idea-card")).toHaveCount(4);
    const afterReload = page.getByTestId("idea-card").filter({ hasText: savedHook });
    await expect(afterReload).toHaveAttribute("data-status", "saved");
    await expect(afterReload.getByText("Saved", { exact: true }).first()).toBeVisible();
    await expect(page.getByTestId("idea-card").filter({ hasText: dismissedHook })).toHaveCount(0);
    // The other cards are still "new", and look different from the saved one.
    await expect(page.locator('[data-testid="idea-card"][data-status="new"]')).toHaveCount(3);
    const [savedBorder, newBorder] = await Promise.all([
      afterReload.evaluate((el) => getComputedStyle(el).borderColor),
      page.locator('[data-testid="idea-card"][data-status="new"]').first().evaluate((el) => getComputedStyle(el).borderColor),
    ]);
    console.log(`border colours: saved=${savedBorder} new=${newBorder}`);
    expect(savedBorder).not.toBe(newBorder);

    const rows: { hook: string; status: string }[] = await ideaRows(withProfile.id, "hook,status");
    const statusOf = (hook: string) => rows.find((r) => r.hook === hook)?.status;
    console.log(`db statuses: ${JSON.stringify(rows.map((r) => r.status).sort())}`);
    expect(statusOf(savedHook)).toBe("saved");
    expect(statusOf(dismissedHook)).toBe("dismissed");
    await afterReload.scrollIntoViewIfNeeded();
    await shot(page, "ideas-c-saved-dismissed-after-reload");
  });

  test("(c2) another user's idea can't be changed through the status route", async ({ browser }) => {
    test.skip(!migrated, NEEDS_MIGRATION);
    const other = await signIn(browser, noProfile);
    const [target] = await ideaRows(withProfile.id, "id,status");
    const res = await other.request.patch(`/api/ideas/${target.id}`, { data: { status: "dismissed" } });
    console.log(`other user's PATCH -> HTTP ${res.status()} ${JSON.stringify(await res.json())}`);
    expect(res.status()).toBe(404);
    const [after] = await ideaRows(withProfile.id, "id,status").then((r) => r.filter((x: { id: string }) => x.id === target.id));
    expect(after.status).toBe(target.status);

    const bad = await page.request.patch(`/api/ideas/${target.id}`, { data: { status: "saved", hook: "rewritten" } });
    console.log(`PATCH with an extra field -> HTTP ${bad.status()}`);
    expect(bad.status()).toBe(400);
    await other.context().close();
  });

  test("(d) a signed-in user with no profile is sent to /onboarding, and generate says no_profile", async ({ browser }) => {
    const p = await signIn(browser, noProfile);
    await p.goto("/dashboard");
    await expect(p).toHaveURL(/\/onboarding$/);
    await expect(p.getByRole("heading", { name: "Tell us about your business" })).toBeVisible();

    const res = await p.request.post("/api/ideas/generate");
    const body = await res.json();
    console.log(`no-profile POST /api/ideas/generate -> HTTP ${res.status()} ${JSON.stringify(body)}`);
    expect(res.status()).toBe(409);
    expect(body.reason).toBe("no_profile");

    // No quota was consumed for the failed attempt.
    if (migrated) {
      const log = await (await admin(`/rest/v1/idea_generation_log?user_id=eq.${noProfile.id}&select=id`)).json();
      expect(log).toEqual([]);
    }
    await shot(p, "ideas-d-no-profile-onboarding");
    await p.context().close();
  });

  test("(g) a model failure shows a retry button [error response mocked in the browser]", async () => {
    await page.route("**/api/ideas/generate", (route) =>
      route.fulfill({
        status: 502,
        json: { ok: false, reason: "model_failed", message: "Our AI couldn't write ideas this time. This usually works on a second try." },
      }),
    );
    await page.getByRole("button", { name: "Generate ideas" }).click();
    const error = page.getByTestId("generate-error");
    await expect(error).toHaveAttribute("data-reason", "model_failed");
    const retry = error.getByRole("button", { name: "Try again" });
    await expect(retry).toBeVisible();
    await retry.click({ trial: true });
    await page.evaluate(() => window.scrollTo(0, 0));
    await shot(page, "ideas-g-model-failed-retry");
    await page.unroute("**/api/ideas/generate");
  });

  test("(e) the 6th generation within 24 hours shows the rate-limit message", async () => {
    test.skip(!migrated, NEEDS_MIGRATION);
    // Batch 1 was (b). Batches 2-5 through the real route with this session.
    for (let i = 2; i <= 5; i++) {
      const res = await page.request.post("/api/ideas/generate");
      console.log(`generation ${i} -> HTTP ${res.status()}`);
      expect(res.status()).toBe(200);
    }

    await page.reload();
    await page.getByRole("button", { name: "Generate ideas" }).click();
    const error = page.getByTestId("generate-error");
    await expect(error).toBeVisible({ timeout: 30_000 });
    await expect(error).toHaveAttribute("data-reason", "rate_limited");
    await expect(error).toContainText("You've used all 5 idea batches for the last 24 hours.");
    await expect(error).toContainText(/You can generate again in (23 hours( \d+ minutes?)?|24 hours)\./);
    await expect(error).toContainText(/\(around .+\)/);
    console.log(`rate-limit message: ${(await error.textContent())?.trim()}`);

    // 5 batches x 5 ideas; the refused 6th inserted nothing.
    const rows = await ideaRows(withProfile.id);
    expect(rows).toHaveLength(25);
    expect(new Set(rows.map((r: { batch_id: string }) => r.batch_id)).size).toBe(5);
    await page.evaluate(() => window.scrollTo(0, 0));
    await shot(page, "ideas-e-rate-limited");
  });
});
