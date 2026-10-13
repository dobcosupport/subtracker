import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const appUrl = process.env.TEST_APP_URL;
assert.ok(appUrl && new URL(appUrl).hostname === "localhost", "Use an isolated localhost preview");
const env = fs.readFileSync(".env.local", "utf8");
const origin = new URL(env.match(/^NEXT_PUBLIC_SUPABASE_URL\s*=\s*["']?([^"'\r\n]+)/m)[1].trim()).origin;
const storageKey = `sb-${new URL(origin).hostname.split(".")[0]}-auth-token`;
const user = { id: "00000000-0000-0000-0000-000000000001", email: "synthetic@example.invalid", aud: "authenticated", app_metadata: {}, user_metadata: {} };
let testMode = true;
let healthFailure = false;
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1366, height: 1000 } });
  await context.addInitScript(({ storageKey, user }) => localStorage.setItem(storageKey, JSON.stringify({
    access_token: "synthetic-token", refresh_token: "synthetic-refresh", token_type: "bearer",
    expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user,
  })), { storageKey, user });
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === new URL(appUrl).origin) {
      if (url.pathname === "/api/admin/compliance-sync/nj-pwc-sync-exceptions") {
        assert.equal(request.method(), "GET");
        if (healthFailure) return route.fulfill({ status: 503, json: { error: "Synthetic sync health unavailable" } });
        return route.fulfill({ json: {
          test_mode: testMode, exceptions: [],
          health: {
            open_exceptions: 2, review_required: 4, expired_by_sync: 1, registry_unavailable: 2,
            would_auto_approve: testMode ? 7 : null, would_expire: testMode ? 3 : null,
            would_request_review: 0, would_propose_expiration: 0, last_successful_daily_run: null,
          },
        } });
      }
      if (url.pathname === "/api/admin/compliance-sync/nj-brc-orphaned-requests") {
        return route.fulfill({ json: { requests: [], age_threshold_minutes: 10 } });
      }
      if (url.pathname === "/api/admin/compliance-sync/worker-health") {
        return route.fulfill({ json: { overall: "offline", workers: [] } });
      }
      if (url.pathname.startsWith("/api/")) return route.fulfill({ json: {
        profile: { auth_user_id: user.id, name: "Synthetic", email: user.email, role: "Administrator", status: "Active", system_administrator: true },
        permissions: ["dashboard", "imports", "contractors", "compliance", "insurance", "projects", "followups", "compliance_sync"].map(module => ({
          module, can_view: true, can_manage: true, can_add: true, can_edit: true, can_delete: true,
        })),
      } });
      return route.continue();
    }
    assert.equal(url.origin, origin, "Unexpected external request blocked");
    if (url.pathname.startsWith("/auth/")) return route.fulfill({ json: user });
    assert.ok(["GET", "HEAD"].includes(request.method()), "Database writes are blocked");
    const rows = url.pathname.endsWith("/compliance_sync_settings") ? [{
      id: 1, compliance_name: "NJ PWC", enabled: true, mode: "auto_approve",
      sync_source: "RPA", test_mode: testMode, failure_expire_threshold: 3,
    }] : [];
    return route.fulfill({ json: rows });
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const visit = () => page.goto(`${appUrl}/admin/compliance-sync`);
  const health = page.locator("section").filter({ has: page.getByRole("heading", { name: "NJ PWC Sync Health", exact: true }) });
  const card = name => health.locator("div.rounded-xl").filter({ has: page.getByText(name, { exact: true }) });
  await visit();
  await page.getByTestId("nj-pwc-test-mode-banner").waitFor();
  await card("Would Auto Approve").getByText("7", { exact: true }).waitFor();
  await card("Would Expire").getByText("3", { exact: true }).waitFor();
  await card("Expired by Sync").getByText("1", { exact: true }).waitFor();

  testMode = false;
  await visit();
  await card("Would Auto Approve").getByText("Test Mode off", { exact: true }).waitFor();
  await card("Would Expire").getByText("Test Mode off", { exact: true }).waitFor();
  assert.equal(await page.getByTestId("nj-pwc-test-mode-banner").count(), 0);

  testMode = true;
  healthFailure = true;
  await visit();
  await page.getByTestId("nj-pwc-test-mode-banner").waitFor();
  await health.getByRole("alert").filter({ hasText: "Synthetic sync health unavailable" }).waitFor();
  await card("Would Auto Approve").getByText("Unavailable", { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log("PASS: NJ PWC shadow metrics, live mode, and failed health loading; all API/data calls mocked");
} finally {
  await browser.close();
}
