import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appUrl = process.env.TEST_APP_URL;
assert.ok(appUrl && new URL(appUrl).hostname === "localhost", "Use an isolated localhost preview");
const env = fs.readFileSync(path.join(root, ".env.local"), "utf8");
const origin = new URL(env.match(/^NEXT_PUBLIC_SUPABASE_URL\s*=\s*["']?([^"'\r\n]+)/m)[1].trim()).origin;
const storageKey = `sb-${new URL(origin).hostname.split(".")[0]}-auth-token`;
const user = { id: "00000000-0000-0000-0000-000000000001", email: "synthetic@example.invalid", aud: "authenticated", app_metadata: {}, user_metadata: {} };
const base = {
  worker_key: "nj-pwc", display_name: "NJ PWC Worker", enabled: true, status: "Running",
  health: "online", available: true, restartRequired: false,
  started_at: "2026-10-07T20:40:53.620Z", last_heartbeat_at: "2026-10-09T16:11:28.808Z",
  last_poll_at: "2026-10-09T16:11:28.808Z", file_modified_at: "2026-10-07T19:00:00.000Z",
  last_search_at: "2026-10-09T12:31:13.157Z", last_search_request_id: 56, last_search_result: "Match Found",
  last_error_at: null, last_error: null, current_request_id: null, testState: "none",
};
const future = { ...base, worker_key: "ny", display_name: "Future NY Worker", enabled: false,
  status: "Not Configured", health: "not_configured", available: false,
  started_at: null, last_heartbeat_at: null, last_poll_at: null, file_modified_at: null,
  last_search_at: null, last_search_request_id: null, last_search_result: null };
let health = { overall: "online", workers: [{ ...base }, future] };
let healthFailure = false;
let logsFailure = false;
let testFailure = false;
const testWrites = [];
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
try {
  await context.addInitScript(({ storageKey, user }) => localStorage.setItem(storageKey, JSON.stringify({
    access_token: "synthetic-token", refresh_token: "synthetic-refresh", token_type: "bearer",
    expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user,
  })), { storageKey, user });
  await context.route("**/*", async (route) => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin === new URL(appUrl).origin) {
      if (url.pathname === "/api/admin/compliance-sync/worker-health") {
        if (request.method() === "POST") {
          if (testFailure) return route.fulfill({ status: 403, json: { error: "SYNTHETIC Test Worker permission denied" } });
          testWrites.push(request.postDataJSON());
          health.workers[0].testState = "pending";
          return route.fulfill({ json: { test_id: "synthetic", message: "Readiness test requested." } });
        }
        if (url.searchParams.has("logs")) {
          if (logsFailure) return route.fulfill({ status: 500, json: { error: "SYNTHETIC logs unavailable" } });
          return route.fulfill({ json: { events: [{ id: 1, received_at: base.last_search_at, event: "search", message: "Search completed: Match Found", request_id: 56 }] } });
        }
        if (healthFailure) return route.fulfill({ status: 503, json: { error: "SYNTHETIC telemetry database unavailable" } });
        return route.fulfill({ json: health });
      }
      if (url.pathname.startsWith("/api/")) return route.fulfill({ json: {
        profile: { auth_user_id: user.id, name: "SYNTHETIC", email: user.email, role: "Administrator", status: "Active", system_administrator: true },
        permissions: ["dashboard", "imports", "contractors", "compliance", "insurance", "projects", "followups", "compliance_sync"].map((module) => ({ module, can_view: true, can_manage: true, can_add: true, can_edit: true, can_delete: true })),
      } });
      return route.continue();
    }
    assert.equal(url.origin, origin, "Unexpected external request blocked");
    if (url.pathname.startsWith("/auth/")) return route.fulfill({ json: user });
    assert.ok(["GET", "HEAD"].includes(request.method()), "No database writes allowed in UI fixture");
    return route.fulfill({ json: [] });
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${appUrl}/admin/compliance-sync`);
  const panel = page.getByRole("region", { name: "Worker Health", exact: true });
  await panel.getByText("Healthy", { exact: true }).waitFor();
  const worker = panel.locator("article").filter({ has: page.getByRole("heading", { name: "NJ PWC Worker", exact: true }) });
  assert.equal(await panel.locator("article").count(), 4);
  for (const name of ["NY Worker", "Reminder Automation Worker", "Email Notification Worker"]) {
    const planned = panel.locator("article").filter({ has: page.getByRole("heading", { name, exact: true }) });
    await planned.getByText("Planned", { exact: true }).waitFor();
    assert.equal(await planned.getByRole("button", { name: "Test Worker", exact: true }).isDisabled(), true);
    assert.equal(await planned.getByRole("button", { name: "View Logs", exact: true }).isDisabled(), true);
    assert.equal(await planned.getByText("Restart Required", { exact: true }).count(), 0);
  }
  const healthBox = await panel.boundingBox();
  const settingsBox = await page.getByRole("heading", { name: "Compliance Sync Settings", exact: true }).boundingBox();
  assert.ok(healthBox.y < settingsBox.y, "Worker Health must be above existing settings/content");
  assert.equal(await worker.getByText("Restart Required", { exact: true }).count(), 0);
  health = { overall: "degraded", workers: [{ ...base, restartRequired: true, health: "degraded", file_modified_at: "2026-10-07T21:54:43.000Z" }, future] };
  await panel.getByRole("button", { name: "Refresh Status" }).click();
  await panel.getByText("Degraded", { exact: true }).waitFor();
  await worker.getByText("Restart Required", { exact: true }).waitFor();
  await worker.getByRole("button", { name: "Test Worker", exact: true }).click();
  await worker.getByText("Worker test awaiting acknowledgement...", { exact: true }).waitFor();
  assert.equal(testWrites.length, 1);
  assert.equal(testWrites[0].worker_key, "nj-pwc");
  health.workers[0].testState = "passed";
  await panel.getByRole("button", { name: "Refresh Status" }).click();
  await worker.getByText("Worker readiness test passed.", { exact: true }).waitFor();
  health.workers[0].testState = "timed_out";
  await panel.getByRole("button", { name: "Refresh Status" }).click();
  await worker.getByText(/Worker test timed out/).waitFor();
  await worker.getByRole("button", { name: "View Logs", exact: true }).click();
  await panel.getByText("Search completed: Match Found", { exact: true }).waitFor();
  await panel.getByRole("button", { name: "Close Logs", exact: true }).click();
  logsFailure = true;
  await worker.getByRole("button", { name: "View Logs", exact: true }).click();
  await panel.getByRole("alert").filter({ hasText: "SYNTHETIC logs unavailable" }).waitFor();
  testFailure = true;
  await worker.getByRole("button", { name: "Test Worker", exact: true }).click();
  await panel.getByRole("alert").filter({ hasText: "permission denied" }).waitFor();
  health = { overall: "offline", workers: [{ ...base, status: "Stopped", health: "offline", available: false }, future] };
  await panel.getByRole("button", { name: "Refresh Status" }).click();
  await panel.getByText("One or More Workers Offline", { exact: true }).waitFor();
  assert.equal(await worker.getByRole("button", { name: "Test Worker", exact: true }).isDisabled(), true);
  healthFailure = true;
  await panel.getByRole("button", { name: "Refresh Status" }).click();
  await panel.getByRole("alert").filter({ hasText: "Worker health unavailable" }).waitFor();
  await panel.getByText("Degraded", { exact: true }).waitFor();
  assert.equal(await panel.locator("article").count(), 4);
  assert.equal(await panel.getByText("Planned", { exact: true }).count(), 3);
  assert.equal(await panel.getByRole("button", { name: "Restart Worker", exact: true }).count(), 0);
  assert.deepEqual(errors, []);
  console.log("PASS: mocked Worker Health UI: four cards, disabled planned workers, Healthy/degraded/offline statuses, stale code, diagnostics and logs; no live writes");
} finally { await context.close(); await browser.close(); }
