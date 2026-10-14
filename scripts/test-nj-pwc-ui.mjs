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
let orphanVisible = true;
const recoveryActions = [];
let registryVisible = false;
let registryFailure = false;
let registryConfidence = "High";
let registryMode = "auto_approve";
const acceptancePosts = [];
const registryMatch = () => ({
  exception_id: 91, contractor_id: 5, search_request_id: 101, is_test: testMode,
  current: { company_name: "B & B Ironworks", address_1: "12 Main Street", address_2: null,
    city: "Newton", state: "NJ", zip_code: "07860", county: "Existing County", nj_pwc_number: "123456" },
  known_certificates: ["123456"],
  candidate: { business_name: "B&B Ironworks, Inc.", address: "12 Main St", city: "Newton", state: "NJ",
    zip_code: "07860", county: "Registry County", certificate_number: "123456",
    registration_date: "2025-01-01", expiration_date: "2099-01-01" },
  evidence: { confidence: registryConfidence, certificate_match: true, street_address_match: true,
    city_match: true, state_match: true, zip_match: true, registration_active: true,
    unit_conflict: false, expired: false, registry_anomaly: false },
  snapshot: "a".repeat(32), duplicate_target: false, can_accept: true, mode: registryMode,
});
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
          test_mode: testMode, exceptions: registryVisible ? [
            { id: 91, contractor_id: 5, contractor: "B & B Ironworks", is_test: testMode,
              reason: "Name Mismatch", kind: "failure", consecutive_failure_count: 2,
              last_attempt_at: null, last_successful_sync_at: null, registry_match: registryMatch() },
            { id: 92, contractor_id: 6, contractor: "No Specific Candidate", is_test: testMode,
              reason: "Name Mismatch", kind: "failure", consecutive_failure_count: 1,
              registry_match: { ...registryMatch(), candidate: null, can_accept: false } },
          ] : [],
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
      if (url.pathname === "/api/admin/compliance-sync/nj-pwc-orphaned-requests") {
        if (request.method() === "POST") {
          const payload = request.postDataJSON();
          assert.equal(payload.request_id, 81);
          assert.equal(payload.confirmed, true);
          recoveryActions.push(payload.action);
          orphanVisible = false;
          return route.fulfill({ json: { ok: true } });
        }
        assert.equal(request.method(), "GET");
        return route.fulfill({ json: { age_threshold_minutes: 10, requests: orphanVisible ? [{
          request_id: 81, contractor_id: 5, contractor: "Synthetic Orphan",
          status: "processing", worker_instance_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          claimed_at: "2026-10-15T12:00:00Z",
        }] : [] } });
      }
      if (url.pathname === "/api/admin/compliance-sync/nj-pwc-registry-match") {
        if (request.method() === "GET") return route.fulfill({ json: { comparison: registryMatch() } });
        assert.equal(request.method(), "POST");
        const payload = request.postDataJSON();
        acceptancePosts.push(payload);
        if (registryFailure) return route.fulfill({ status: 409, json: { error: "Registry comparison changed. Refresh and confirm." } });
        registryVisible = false;
        return route.fulfill({ json: { ok: true, message: "B&B Ironworks, Inc.: selected fields updated, Name Mismatch resolved, failure count reset." } });
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
  const orphans = page.locator("section").filter({ has: page.getByRole("heading", { name: "NJ PWC Orphaned Requests", exact: true }) });
  page.on("dialog", dialog => dialog.accept());
  for (const label of ["Mark Failed", "Retry Search", "Resolve"]) {
    orphanVisible = true;
    await visit();
    await orphans.getByText(/Synthetic Orphan/).waitFor();
    await orphans.getByRole("button", { name: label, exact: true }).click();
    await orphans.getByText("No orphaned NJ PWC requests.", { exact: true }).waitFor();
  }
  assert.deepEqual(recoveryActions, ["fail", "retry", "resolve"]);

  for (const [confidence,mode] of [["High","auto_approve"],["Medium","auto_approve"],["Low","auto_approve"],["High","review_required"]]) {
    registryConfidence = confidence; registryMode = mode; registryVisible = true;
    await visit();
    const queue = page.locator("section").filter({ has: page.getByRole("heading", { name: "NJ PWC Sync Exceptions", exact: true }) });
    const action = queue.getByRole("button", { name: "Accept Registry Match", exact: true });
    await action.waitFor();
    assert.equal(await action.count(), 1, "no action without a specific candidate");
    await action.click();
    const dialog = page.getByRole("dialog");
    await dialog.getByText(`${confidence} Confidence`, { exact: true }).waitFor().catch(async error => {
      console.error("Synthetic UI errors:", errors, "Dialog:", await dialog.allTextContents());
      throw error;
    });
    assert.equal(await dialog.getByRole("checkbox", { name: "Import Company Name", exact: true }).isChecked(), true);
    assert.equal(await dialog.getByRole("checkbox", { name: "Import Company Name", exact: true }).isDisabled(), true);
    assert.equal(await dialog.getByRole("checkbox", { name: "Import Address 1", exact: true }).isChecked(), false);
    await dialog.getByRole("checkbox", { name: "Import County", exact: true }).check();
    await dialog.getByRole("button", { name: "Continue to Confirmation" }).click();
    await dialog.getByRole("heading", { name: "Accept NJ PWC Registry Match?" }).waitFor();
    await dialog.getByText(/deliberate user-selected import/).waitFor();
    if (confidence === "High" && mode === "auto_approve") await dialog.getByText(/Process valid High Confidence/).waitFor();
    else await dialog.getByText(/Send the compliance result to Review Required/).waitFor();
    await dialog.getByRole("button", { name: "Accept Registry Match", exact: true }).click();
    await page.getByText(/B&B Ironworks, Inc.: selected fields updated/).waitFor();
    await queue.getByText("No open NJ PWC sync exceptions.", { exact: true }).waitFor();
    assert.equal(await page.getByRole("dialog").count(), 0);
    assert.deepEqual(acceptancePosts.at(-1), { exception_id: 91, snapshot: "a".repeat(32), selected_fields: ["company_name","county"], confirmed: true });
  }
  registryVisible = true; registryFailure = true;
  await visit();
  await page.getByRole("button", { name: "Accept Registry Match", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Continue to Confirmation" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Accept Registry Match", exact: true }).click();
  await page.getByRole("dialog").getByRole("alert").filter({ hasText: "Registry comparison changed" }).waitFor();
  await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
  registryVisible = false; registryFailure = false;

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
  console.log("PASS: NJ PWC shadow metrics, live mode, health errors, orphan actions, registry comparison/field selection/confirmation, confidence gates and stale errors; all API/data calls mocked");
} finally {
  await browser.close();
}
