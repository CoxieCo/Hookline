import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

/*
 * Onboarding flow, end to end, against the real Supabase project in .env.local.
 *
 * Auth: a confirmed throwaway user is created with the Supabase Admin API
 * (needs a real SUPABASE_SERVICE_ROLE_KEY in .env.local), then signed in
 * through the app's own /login form so the browser holds real session
 * cookies. The user (and, via ON DELETE CASCADE, their profile row) is
 * deleted afterwards. Keys are never logged.
 *
 * Optional: EMPTY_STATE_BASE_URL points at a second server started with
 * ONBOARDING_REDIRECT=off, to exercise the dashboard's empty-state button.
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

test("(f) a signed-out user visiting /onboarding is sent to /login", async ({ page }) => {
  await page.goto("/onboarding");
  await expect(page).toHaveURL(/\/login\?next=%2Fonboarding$/);
  await expect(page.getByRole("heading", { name: "Log in to Hookline" })).toBeVisible();
  await shot(page, "f-signed-out-onboarding-redirects-to-login");
});

test.describe("signed-in flow", () => {
  test.skip(!HAS_ADMIN_KEY, "needs a real SUPABASE_SERVICE_ROLE_KEY in .env.local to create a confirmed test user");

  const email = `hookline-e2e-${Date.now()}@example.com`;
  const password = `E2e-${crypto.randomUUID()}`;
  let userId = "";
  let page: Page;
  test.beforeAll(async ({ browser }) => {
    // /onboarding reads business_profiles.product_facts. The migration is required: a missing column fails, never skips.
    const probe = await admin("/rest/v1/business_profiles?select=product_facts&limit=0");
    console.log(`business_profiles.product_facts present: ${probe.status === 200} (HTTP ${probe.status})`);
    expect(probe.status, "business_profiles.product_facts must exist: apply 20261014000000_product_facts_and_claims.sql").toBe(200);

    const res = await admin("/auth/v1/admin/users", {
      method: "POST",
      body: JSON.stringify({ email, password, email_confirm: true }),
    });
    expect(res.status, "admin create user").toBe(200);
    userId = (await res.json()).id;

    page = await browser.newPage();
    await page.goto("/login");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    // Login redirects to /dashboard, which (no profile yet) redirects to /onboarding.
    await page.waitForURL(/\/(dashboard|onboarding)/);
  });

  test.afterAll(async () => {
    await page?.close();
    if (userId) {
      const res = await admin(`/auth/v1/admin/users/${userId}`, { method: "DELETE" });
      console.log(`cleanup: deleted test user -> HTTP ${res.status}`);
    }
  });

  test("(a) signed-in user with no profile visiting /dashboard ends up at /onboarding", async () => {
    const rows = await (await admin(`/rest/v1/business_profiles?user_id=eq.${userId}&select=id`)).json();
    expect(rows, "precondition: no business_profiles row").toEqual([]);

    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/onboarding$/);
    await expect(page.getByRole("heading", { name: "Tell us about your business" })).toBeVisible();
    await shot(page, "a-dashboard-redirects-to-onboarding");
  });

  test("(b) visiting /onboarding directly loads 'Tell us about your business'", async () => {
    await page.goto("/onboarding");
    await expect(page).toHaveURL(/\/onboarding$/);
    await expect(page.getByRole("heading", { name: "Tell us about your business" })).toBeVisible();
    await expect(page.getByLabel("Paste your website or Instagram/TikTok handle")).toBeVisible();
    await expect(page.getByRole("button", { name: "Build my profile" })).toBeVisible();
    await shot(page, "b-onboarding-step-1");
  });

  test("(g) dashboard empty-state card has a visible 'Set up your profile' button", async ({ browser }) => {
    const emptyStateBase = process.env.EMPTY_STATE_BASE_URL;
    test.skip(!emptyStateBase, "set EMPTY_STATE_BASE_URL to a server running with ONBOARDING_REDIRECT=off");

    // Same host => same session cookies; different port serves the no-redirect build.
    const p = await browser.newPage({ storageState: await page.context().storageState() });
    await p.goto(`${emptyStateBase}/dashboard`);
    const card = p.getByTestId("profile-empty");
    await expect(card).toBeVisible();
    const button = card.getByRole("link", { name: "Set up your profile" });
    await expect(button).toBeVisible();
    await expect(button).toBeInViewport();
    await expect(button).toHaveAttribute("href", "/onboarding");
    await shot(p, "g-dashboard-empty-state-button");
    // It must be the top-most element at its centre (not covered by anything).
    await button.click({ trial: true });
    await button.click();
    await expect(p).toHaveURL(/\/onboarding$/);
    await p.close();
  });

  test("(c) 'I'd rather type it myself' shows the manual form", async () => {
    await page.goto("/onboarding");
    await page.getByRole("button", { name: "I'd rather type it myself" }).click();
    await expect(page.getByRole("heading", { name: "Review your profile" })).toBeVisible();
    for (const label of ["Business name", "Industry", "Product description", "Target customer", "Brand tone"]) {
      await expect(page.getByLabel(label, { exact: true })).toHaveValue("");
    }
    // Product facts: optional, with helper text and a notice while it's empty.
    const facts = page.getByLabel(/^Product facts: things that are true about your product/);
    await expect(facts).toHaveValue("");
    await expect(facts).toHaveAttribute("maxlength", "1500");
    await expect(facts).not.toHaveAttribute("required");
    const help = page.getByText(/One per line: features, materials, sizes/);
    await expect(help).toBeVisible();
    // Says the ideas can be wrong; never that they only ever state these facts.
    await expect(help).toContainText("They can still get things wrong, so check each one before you post it.");
    await expect(help).not.toContainText("only state");
    await expect(page.getByTestId("product-facts-empty")).toContainText("No product facts yet");
    await facts.fill("Natural rubber");
    await expect(page.getByTestId("product-facts-empty")).toHaveCount(0);
    await facts.fill("");
    await expect(page.getByTestId("product-facts-empty")).toBeVisible();
    await expect(page.getByRole("button", { name: "Save and continue" })).toBeVisible();
    await shot(page, "c-manual-form");
  });

  const profile = {
    "Business name": "E2E Paws Co",
    Industry: "Pet supplies",
    "Product description": "Indestructible dog toys made for heavy chewers.",
    "Target customer": "Owners of large, energetic dogs",
    "Brand tone": "playful, confident",
  };

  // Typed with real line breaks; saved with \n (the browser submits \r\n).
  const productFacts = "Natural rubber\nSizes S, M and L\nFloats in water";

  test("(d) saving the manual form creates a row and lands on /dashboard with the summary", async () => {
    for (const [label, value] of Object.entries(profile)) {
      await page.getByLabel(label, { exact: true }).fill(value);
    }
    await page.getByLabel(/^Product facts:/).fill(productFacts);
    await page.getByRole("button", { name: "Save and continue" }).click();
    await page.waitForURL(/\/dashboard$/);

    const summary = page.getByTestId("profile-summary");
    await expect(summary).toBeVisible();
    await expect(summary.getByRole("heading", { name: "E2E Paws Co" })).toBeVisible();
    await expect(summary).toContainText("Pet supplies");
    await expect(page.getByTestId("profile-empty")).toHaveCount(0);

    const rows = await (
      await admin(
        `/rest/v1/business_profiles?user_id=eq.${userId}&select=business_name,industry,source_type,source_url,product_facts`,
      )
    ).json();
    console.log(`saved row: ${JSON.stringify(rows)}`);
    expect(rows).toEqual([
      {
        business_name: "E2E Paws Co",
        industry: "Pet supplies",
        source_type: "manual",
        source_url: null,
        product_facts: productFacts,
      },
    ]);

    // Reloading must keep showing the summary, not redirect again.
    await page.reload();
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(summary).toBeVisible();
    await shot(page, "d-dashboard-profile-summary");
  });

  test("(e) 'Edit profile' opens /onboarding pre-filled, skipping the URL step", async () => {
    await page.goto("/dashboard");
    await page.getByRole("link", { name: "Edit profile" }).click();
    await expect(page).toHaveURL(/\/onboarding$/);
    await expect(page.getByRole("heading", { name: "Review your profile" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Tell us about your business" })).toHaveCount(0);
    for (const [label, value] of Object.entries(profile)) {
      await expect(page.getByLabel(label, { exact: true })).toHaveValue(value);
    }
    await expect(page.getByLabel(/^Product facts:/)).toHaveValue(productFacts);
    await expect(page.getByTestId("product-facts-empty")).toHaveCount(0);
    await shot(page, "e-edit-profile-prefilled");
  });

  test("(h) editing product facts saves and pre-fills again; clearing them is allowed", async () => {
    await page.goto("/onboarding");
    const facts = page.getByLabel(/^Product facts:/);
    await facts.fill("Natural rubber\nSizes S-L");
    await page.getByRole("button", { name: "Save and continue" }).click();
    await page.waitForURL(/\/dashboard$/);
    await page.goto("/onboarding");
    await expect(page.getByLabel(/^Product facts:/)).toHaveValue("Natural rubber\nSizes S-L");

    await page.getByLabel(/^Product facts:/).fill("");
    await page.getByRole("button", { name: "Save and continue" }).click();
    await page.waitForURL(/\/dashboard$/);
    const rows = await (await admin(`/rest/v1/business_profiles?user_id=eq.${userId}&select=product_facts`)).json();
    expect(rows).toEqual([{ product_facts: "" }]);
    await page.goto("/onboarding");
    await expect(page.getByLabel(/^Product facts:/)).toHaveValue("");
    await expect(page.getByTestId("product-facts-empty")).toBeVisible();
    await shot(page, "h-product-facts-empty-notice");
  });

  test("(i) the server rejects product facts over 1500 characters", async () => {
    await page.goto("/onboarding");
    const facts = page.getByLabel(/^Product facts:/);
    // Bypass the textarea's maxlength, as a crafted request would.
    await facts.evaluate((el) => el.removeAttribute("maxlength"));
    await facts.fill("x".repeat(1501));
    await page.getByRole("button", { name: "Save and continue" }).click();
    await expect(page.getByText("Product facts must be 1500 characters or fewer.")).toBeVisible();
    await expect(page).toHaveURL(/\/onboarding$/);
    const rows = await (await admin(`/rest/v1/business_profiles?user_id=eq.${userId}&select=product_facts`)).json();
    expect(rows).toEqual([{ product_facts: "" }]);
  });
});
