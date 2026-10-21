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
let syncMode = "auto_approve";
let healthFailure = false;
let orphanVisible = true;
const recoveryActions = [];
let registryVisible = false;
let registryFailure = false;
let registryConfidence = "High";
let registryMode = "auto_approve";
const acceptancePosts = [];
let retryScenario = false;
let retryQueued = false;
let retryPollCount = 0;
let retryExceptionVisible = true;
let retryStatus = "pending";
const schedulePosts = [];
let dailySchedule = { enabled: false, date: "2026-10-15", time: "02:00:00", timezone: "America/New_York" };
const runNowPosts = [];
let manualRunActive = false;
const stopPosts = [];
let stopRequested = false;
let stopDrained = false;
const activeRun = () => {
  if (!manualRunActive || stopDrained) return null;
  return { id: 301, run_date: "2026-10-14", started_at: "2026-10-14T12:00:00Z",
    run_status: "Running", is_test: testMode, manual_run: true,
    stop_requested_at: stopRequested ? "2026-10-14T12:30:00Z" : null,
    stop_requested_by: stopRequested ? "Synthetic" : null };
};
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
const assertReadableContrast = async (locator, label) => {
  const ratio = await locator.evaluate(element => {
    const luminance = value => {
      const [red, green, blue] = value.match(/[\d.]+/g).slice(0, 3).map(Number).map(channel => {
        const normalized = channel / 255;
        return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    };
    const style = getComputedStyle(element);
    const foreground = luminance(style.color);
    const background = luminance(style.backgroundColor);
    return { ratio: (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05),
      foreground: style.color, background: style.backgroundColor };
  });
  assert.ok(ratio.ratio >= 4.5, `${label} contrast ratio ${ratio.ratio.toFixed(2)} is below 4.5:1 (text ${ratio.foreground}, background ${ratio.background})`);
  return ratio;
};
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
      if (url.pathname === "/api/admin/compliance-sync/registration-unlink") return route.fulfill({json:{contractors:[]}});
      if (url.pathname === "/api/admin/compliance-sync/nj-pwc-sync-exceptions") {
        if (request.method() === "POST") {
          const payload = request.postDataJSON();
          assert.deepEqual(payload, { action: "retry", exception_id: 93 });
          retryScenario = true;
          retryQueued = true;
          retryPollCount = 0;
          return route.fulfill({ json: { ok: true, exception_id: 93, search_request_id: 194, created: true } });
        }
        assert.equal(request.method(), "GET");
        if (healthFailure) return route.fulfill({ status: 503, json: { error: "Synthetic sync health unavailable" } });
        let exceptions;
        if (retryScenario) {
          if (retryQueued) {
            retryStatus = ["pending", "claimed", "processing", "completed"][Math.min(retryPollCount, 3)];
            retryPollCount += 1;
            retryExceptionVisible = retryStatus !== "completed";
          }
          exceptions = retryExceptionVisible ? [{
            id: 93, contractor_id: 9, contractor: "Retry Contractor", is_test: testMode,
            reason: "Name Mismatch", kind: "failure", consecutive_failure_count: 2,
            last_attempt_at: null, last_successful_sync_at: null,
            retry_request: retryQueued ? { id: 194, status: retryStatus, result_status: null,
              sync_outcome: null, searched_company_name: "UPDATED CONTRACTOR NAME", origin: "exception_retry" } : null,
          }] : [];
        } else {
          exceptions = registryVisible ? [
            { id: 91, contractor_id: 5, contractor: "B & B Ironworks", is_test: testMode,
              reason: "Name Mismatch", kind: "failure", consecutive_failure_count: 2,
              last_attempt_at: null, last_successful_sync_at: null, registry_match: registryMatch() },
            { id: 92, contractor_id: 6, contractor: "No Specific Candidate", is_test: testMode,
              reason: "Name Mismatch", kind: "failure", consecutive_failure_count: 1,
              registry_match: { ...registryMatch(), candidate: null, can_accept: false } },
          ] : [];
        }
        return route.fulfill({ json: {
          test_mode: testMode, exceptions, active_run: activeRun(),
          health: {
            open_exceptions: retryScenario ? (retryExceptionVisible ? 1 : 0) : registryVisible ? 2 : 0,
            review_required: 4, expired_by_sync: 1, registry_unavailable: 2,
            would_auto_approve: testMode ? 7 : null, would_expire: testMode ? 3 : null,
            would_request_review: 0, would_propose_expiration: 0, last_successful_daily_run: null,
          },
        } });
      }
      if (url.pathname === "/api/admin/compliance-sync/nj-pwc-schedule") {
        assert.equal(request.method(), "POST");
        const payload = request.postDataJSON();
        schedulePosts.push(payload);
        dailySchedule = { enabled: payload.daily_sync_enabled, date: payload.daily_sync_start_date,
          time: payload.daily_sync_time, timezone: payload.daily_sync_timezone };
        return route.fulfill({ json: { ok: true, next_sync_at: dailySchedule.enabled ? "2026-10-15T06:00:00Z" : null } });
      }
      if (url.pathname === "/api/admin/compliance-sync/nj-pwc-run-now") {
        assert.equal(request.method(), "POST");
        const payload = request.postDataJSON();
        assert.match(payload.request_key, /^[0-9a-f-]{36}$/i);
        runNowPosts.push(payload);
        if (manualRunActive) return route.fulfill({ json: { ok: true, run_id: 301, created: false,
          is_test: testMode, run_date: "2026-10-14", run_status: "Running", already_active: true } });
        manualRunActive = true;
        return route.fulfill({ json: { ok: true, run_id: 301, created: true,
          is_test: testMode, run_date: "2026-10-14", run_status: "Running", already_active: false } });
      }
      if (url.pathname === "/api/admin/compliance-sync/nj-pwc-stop-run") {
        assert.equal(request.method(), "POST");
        const payload = request.postDataJSON();
        stopPosts.push(payload);
        if (stopRequested) return route.fulfill({ json: { ok: true, run_id: 301, stop_requested: true,
          already_requested: true, run_status: stopDrained ? "Cancelled" : "Running", finished: stopDrained } });
        stopRequested = true;
        return route.fulfill({ json: { ok: true, run_id: 301, stop_requested: true,
          already_requested: false, run_status: "Running", finished: false } });
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
      sync_source: "RPA", test_mode: testMode, mode: syncMode, failure_expire_threshold: 3,
      daily_sync_enabled: dailySchedule.enabled, daily_sync_start_date: dailySchedule.date,
      daily_sync_time: dailySchedule.time, daily_sync_timezone: dailySchedule.timezone,
      next_sync_at: dailySchedule.enabled ? "2026-10-15T06:00:00Z" : null,
    }] : [];
    return route.fulfill({ json: rows });
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const visit = () => page.goto(`${appUrl}/admin/compliance-sync`);
  const selectTab = (name) => page.getByRole("tab", { name, exact: true }).click();
  const health = page.locator("section").filter({ has: page.getByRole("heading", { name: "NJ PWC Sync Health", exact: true }) });
  const card = name => health.locator("div.rounded-lg").filter({ has: page.getByText(name, { exact: true }) });
  await visit();
  await page.getByRole("tab", { name: "Overview", exact: true }).waitFor();
  assert.deepEqual(await page.getByRole("tab").allTextContents(), ["Overview", "Settings", "NJ PWC", "NJ BRC", "Reviews", "Sync History", "Automation"]);
  const summary = page.getByRole("region", { name: "Compliance Sync summary" });
  for (const label of ["Last Sync", "Next Scheduled Sync", "Records Checked", "Open Exceptions", "Pending Review"]) {
    await summary.getByText(label, { exact: true }).waitFor();
  }
  const services = page.getByRole("region", { name: "Compliance Services" });
  await services.getByText("NJ PWC", { exact: true }).waitFor();
  await services.getByText("Enabled", { exact: true }).waitFor();
  await services.getByText("Auto Approve", { exact: true }).waitFor();
  await services.getByText("RPA", { exact: true }).waitFor();
  await services.getByText("Test", { exact: true }).waitFor();
  await page.getByText("NJ PWC Test Mode is ON.", { exact: false }).waitFor();
  await selectTab("Settings");
  assert.equal(await page.getByRole("button", { name: "Stop Run", exact: true }).count(), 0,
    "Stop Run does not appear without an active automatic run (Priority 0 user searches never create runs)");
  await selectTab("NJ PWC");
  await page.getByTestId("nj-pwc-test-mode-banner").waitFor();
  await card("Would Auto Approve").getByText("7", { exact: true }).waitFor();
  await card("Would Expire").getByText("3", { exact: true }).waitFor();
  await card("Expired by Sync").getByText("1", { exact: true }).waitFor();
  const orphans = page.locator("section").filter({ has: page.getByRole("heading", { name: "NJ PWC Orphaned Requests", exact: true }) });
  const dialogMessages = [];
  page.on("dialog", dialog => { dialogMessages.push(dialog.message()); void dialog.accept(); });
  for (const label of ["Mark Failed", "Retry Search", "Resolve"]) {
    orphanVisible = true;
    await visit();
    await selectTab("NJ PWC");
    await orphans.getByText(/Synthetic Orphan/).waitFor();
    await orphans.getByRole("button", { name: label, exact: true }).click();
    await orphans.getByText("No orphaned NJ PWC requests.", { exact: true }).waitFor();
  }
  assert.deepEqual(recoveryActions, ["fail", "retry", "resolve"]);

  for (const [confidence,mode] of [["High","auto_approve"],["Medium","auto_approve"],["Low","auto_approve"],["High","review_required"]]) {
    registryConfidence = confidence; registryMode = mode; registryVisible = true;
    await visit();
    await selectTab("NJ PWC");
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
  await selectTab("NJ PWC");
  await page.getByRole("button", { name: "Accept Registry Match", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Continue to Confirmation" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Accept Registry Match", exact: true }).click();
  await page.getByRole("dialog").getByRole("alert").filter({ hasText: "Registry comparison changed" }).waitFor();
  await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
  registryVisible = false; registryFailure = false;

  testMode = false;
  await visit();
  await selectTab("NJ PWC");
  await card("Would Auto Approve").getByText("Test Mode off", { exact: true }).waitFor();
  await card("Would Expire").getByText("Test Mode off", { exact: true }).waitFor();
  assert.equal(await page.getByTestId("nj-pwc-test-mode-banner").count(), 0);

  testMode = true;
  healthFailure = true;
  await visit();
  await selectTab("NJ PWC");
  await page.getByTestId("nj-pwc-test-mode-banner").waitFor();
  await health.getByRole("alert").filter({ hasText: "Synthetic sync health unavailable" }).waitFor();
  await card("Would Auto Approve").getByText("Unavailable", { exact: true }).waitFor();

  healthFailure = false;
  retryScenario = true;
  retryQueued = false;
  retryExceptionVisible = true;
  await visit();
  await selectTab("NJ PWC");
  const retryQueue = page.locator("section").filter({ has: page.getByRole("heading", { name: "NJ PWC Sync Exceptions", exact: true }) });
  await retryQueue.getByText("Retry Contractor").waitFor();
  await retryQueue.getByRole("button", { name: "Run Search Again", exact: true }).click();
  await page.getByText(/Retry Queued \(Request #194\)/).waitFor();
  await retryQueue.getByText("Retry pending · Request #194", { exact: true }).waitFor();
  await retryQueue.getByText("Retry claimed · Request #194", { exact: true }).waitFor();
  await retryQueue.getByText("Retry processing · Request #194", { exact: true }).waitFor();
  await retryQueue.getByText("No open NJ PWC sync exceptions.", { exact: true }).waitFor();
  await card("Open Exceptions").getByText("0", { exact: true }).waitFor();
  assert.equal(retryStatus, "completed");

  const settingsSection = page.locator("section").filter({ has: page.getByRole("heading", { name: "Compliance Sync Settings", exact: true }) });
  await selectTab("Settings");
  await settingsSection.getByRole("textbox", { name: "Daily Sync Start Date" }).fill("10/15/2026");
  await settingsSection.getByRole("textbox", { name: "Daily Sync Start Time" }).fill("02:00 AM");
  await settingsSection.getByRole("checkbox", { name: "Daily Sync Enabled" }).check();
  const runNowButton = settingsSection.getByRole("button", { name: "Run Now", exact: true });
  const runNowStyle = await assertReadableContrast(runNowButton, "Run Now");
  assert.equal(runNowStyle.background, "rgb(29, 78, 216)");
  assert.equal(runNowStyle.foreground, "rgb(255, 255, 255)");
  await settingsSection.getByRole("button", { name: "Save Schedule", exact: true }).click();
  await page.getByText(/NJ PWC daily schedule saved\. Next Scheduled Run:/).waitFor();
  const saveScheduleButton = settingsSection.getByRole("button", { name: "Save Schedule", exact: true });
  await page.mouse.move(0, 0);
  const saveScheduleStyle = await assertReadableContrast(saveScheduleButton, "Save Schedule");
  assert.equal(saveScheduleStyle.background, "rgb(29, 78, 216)");
  assert.equal(saveScheduleStyle.foreground, "rgb(255, 255, 255)");
  await saveScheduleButton.hover();
  assert.equal(await saveScheduleButton.evaluate(element => getComputedStyle(element).backgroundColor), "rgb(30, 64, 175)");
  await page.mouse.move(0, 0);
  assert.deepEqual(schedulePosts[0], { daily_sync_enabled: true, daily_sync_start_date: "2026-10-15",
    daily_sync_time: "02:00 AM", daily_sync_timezone: "America/New_York" });
  await settingsSection.getByRole("button", { name: "Run Now", exact: true }).click();
  let runNowDialog = page.getByRole("dialog");
  await runNowDialog.getByRole("heading", { name: "Run NJ PWC Sync Now?" }).waitFor();
  await runNowDialog.getByText("Auto Approve", { exact: true }).waitFor();
  await runNowDialog.getByText("ON", { exact: true }).waitFor();
  await runNowDialog.getByText("This run will search and classify NJ PWC records but will not make live compliance-record changes.", { exact: true }).waitFor();
  const testPrimary = runNowDialog.getByRole("button", { name: "Run Test Sync Now", exact: true });
  const testPrimaryStyle = await assertReadableContrast(testPrimary, "Run Test Sync Now");
  assert.equal(testPrimaryStyle.background, "rgb(29, 78, 216)");
  assert.equal(testPrimaryStyle.foreground, "rgb(255, 255, 255)");
  await testPrimary.hover();
  assert.equal(await testPrimary.evaluate(element => getComputedStyle(element).backgroundColor), "rgb(30, 64, 175)");
  await runNowDialog.getByRole("button", { name: "Cancel", exact: true }).focus();
  await page.keyboard.press("Tab");
  const focusStyle = await testPrimary.evaluate(element => getComputedStyle(element));
  assert.equal(focusStyle.outlineStyle, "solid");
  assert.equal(focusStyle.outlineColor, "rgb(147, 197, 253)");
  await testPrimary.evaluate(element => { element.disabled = true; });
  const disabledStyle = await testPrimary.evaluate(element => ({
    background: getComputedStyle(element).backgroundColor,
    foreground: getComputedStyle(element).color,
  }));
  assert.deepEqual(disabledStyle, { background: "rgb(203, 213, 225)", foreground: "rgb(51, 65, 85)" });
  await testPrimary.evaluate(element => { element.disabled = false; });
  await assertReadableContrast(runNowDialog.getByRole("button", { name: "Cancel", exact: true }), "Test Cancel");
  await runNowDialog.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(runNowPosts.length, 0, "canceling confirmation does not start a run");
  await settingsSection.getByRole("button", { name: "Run Now", exact: true }).click();
  runNowDialog = page.getByRole("dialog");
  await runNowDialog.getByRole("button", { name: "Run Test Sync Now", exact: true }).click();
  await page.getByText(/NJ PWC Run Now started: run #301 \(Test Mode\)/).waitFor();
  assert.equal(runNowPosts.length, 1);
  assert.notEqual(runNowPosts[0].request_key, schedulePosts[0].request_key);
  await settingsSection.getByRole("button", { name: "Stop Run", exact: true }).waitFor();
  await page.getByText("Active Run: #301 · Running (Test Mode)", { exact: true }).waitFor();
  testMode = false;
  await visit();
  await selectTab("Settings");
  await settingsSection.getByRole("button", { name: "Run Now", exact: true }).click();
  runNowDialog = page.getByRole("dialog");
  await runNowDialog.getByRole("heading", { name: "Run NJ PWC Sync Now?" }).waitFor();
  await runNowDialog.getByText("OFF", { exact: true }).waitFor();
  await runNowDialog.getByText("This is a LIVE NJ PWC sync. Eligible results may update compliance records according to the current Mode.", { exact: true }).waitFor();
  const livePrimary = runNowDialog.getByRole("button", { name: "Run Live Sync Now", exact: true });
  await livePrimary.waitFor();
  const livePrimaryStyle = await assertReadableContrast(livePrimary, "Run Live Sync Now");
  assert.equal(livePrimaryStyle.background, "rgb(29, 78, 216)");
  assert.equal(livePrimaryStyle.foreground, "rgb(255, 255, 255)");
  await livePrimary.hover();
  assert.equal(await livePrimary.evaluate(element => getComputedStyle(element).backgroundColor), "rgb(30, 64, 175)");
  await assertReadableContrast(runNowDialog.getByRole("button", { name: "Cancel", exact: true }), "Live Cancel");
  await runNowDialog.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(runNowPosts.length, 1, "canceling a LIVE confirmation performs no sync");
  await settingsSection.getByRole("button", { name: "Run Now", exact: true }).click();
  runNowDialog = page.getByRole("dialog");
  await runNowDialog.getByRole("button", { name: "Run Live Sync Now", exact: true }).click();
  await page.getByText(/Run Now not started\. NJ PWC run #301 is already active/).waitFor();
  assert.equal(runNowPosts.length, 2, "conflicting Run Now reports the active run and creates no new run");

  syncMode = "review_required";
  await visit();
  await selectTab("Settings");
  await settingsSection.getByRole("button", { name: "Run Now", exact: true }).click();
  runNowDialog = page.getByRole("dialog");
  await runNowDialog.getByText("Review Required", { exact: true }).waitFor();
  await runNowDialog.getByText("OFF", { exact: true }).waitFor();
  await runNowDialog.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(runNowPosts.length, 2, "Review Required remains visible and Cancel starts nothing");
  syncMode = "auto_approve";

  await visit();
  await selectTab("Settings");
  const stopRunButton = settingsSection.getByRole("button", { name: "Stop Run", exact: true });
  await stopRunButton.waitFor();
  const stopRunStyle = await assertReadableContrast(stopRunButton, "Stop Run");
  assert.equal(stopRunStyle.background, "rgb(185, 28, 28)");
  assert.equal(stopRunStyle.foreground, "rgb(255, 255, 255)");
  await stopRunButton.click();
  const stopDialog = page.getByRole("dialog");
  await stopDialog.getByRole("heading", { name: "Stop NJ PWC Run #301?" }).waitFor();
  await stopDialog.getByText(/graceful stop/).waitFor();
  await stopDialog.getByRole("button", { name: "Stop Run", exact: true }).click();
  await page.getByText("Stop requested for NJ PWC run #301. The in-progress search will finish; no new searches will start.", { exact: true }).waitFor();
  assert.deepEqual(stopPosts[0], { run_id: 301 });
  const stopRequestedButton = settingsSection.getByRole("button", { name: "Stop Requested…", exact: true });
  await stopRequestedButton.waitFor();
  assert.equal(await stopRequestedButton.isDisabled(), true);
  stopDrained = true;
  await stopRequestedButton.waitFor({ state: "detached", timeout: 15000 });
  assert.equal(await settingsSection.getByRole("button", { name: "Stop Run", exact: true }).count(), 0,
    "Stop Run disappears once the run is recorded as Cancelled");

  await selectTab("Automation");
  const testConnectionButton = page.getByRole("button", { name: "Test Connection", exact: true });
  const testConnectionStyle = await assertReadableContrast(testConnectionButton, "Test Connection");
  assert.equal(testConnectionStyle.background, "rgb(15, 23, 42)");
  assert.equal(testConnectionStyle.foreground, "rgb(255, 255, 255)");
  const brcTestButton = page.getByRole("button", { name: "Test NJ BRC Lookup", exact: false });
  const brcTestStyle = await assertReadableContrast(brcTestButton, "Test NJ BRC Lookup");
  assert.equal(brcTestStyle.background, "rgb(226, 232, 240)");
  const pwcTestButton = page.getByRole("button", { name: "Test NJ PWC Lookup", exact: false });
  const pwcTestStyle = await assertReadableContrast(pwcTestButton, "Test NJ PWC Lookup");
  assert.equal(pwcTestStyle.background, "rgb(226, 232, 240)");
  const createTestResultButton = page.getByRole("button", { name: "Create Test NJ PWC Result", exact: false });
  const createTestResultStyle = await assertReadableContrast(createTestResultButton, "Create Test NJ PWC Result");
  assert.equal(createTestResultStyle.background, "rgb(226, 232, 240)");
  await selectTab("Overview");
  await assertReadableContrast(page.getByRole("button", { name: "Test Worker" }).first(), "Test Worker");
  await assertReadableContrast(page.getByRole("button", { name: "View Logs" }).first(), "View Logs");
  await selectTab("Settings");
  await settingsSection.getByRole("checkbox", { name: "Daily Sync Enabled" }).uncheck();
  await settingsSection.getByRole("button", { name: "Save Schedule", exact: true }).click();
  await page.getByText("NJ PWC daily schedule disabled.", { exact: true }).waitFor();
  assert.equal(schedulePosts[1].daily_sync_enabled, false);
  assert.ok(dialogMessages.includes("Disable the NJ PWC daily schedule? Already queued or in-progress work will continue."));
  assert.deepEqual(errors, []);
  console.log("PASS: NJ PWC shadow metrics, live mode, health errors, orphan actions, registry acceptance, confidence gates, retry status polling and automatic exception removal; all API/data calls mocked");
} finally {
  await browser.close();
}
