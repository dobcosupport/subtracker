import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const appUrl = process.env.TEST_APP_URL;
assert.ok(appUrl && new URL(appUrl).hostname === "localhost", "Only intercepted localhost fixtures");
const env = fs.readFileSync(".env.local", "utf8");
const origin = new URL(env.match(/^NEXT_PUBLIC_SUPABASE_URL\s*=\s*["']?([^"'\r\n]+)/m)[1].trim()).origin;
const storageKey = `sb-${new URL(origin).hostname.split(".")[0]}-auth-token`;
const user = { id: "00000000-0000-4000-8000-000000000001", email: "fixture@example.invalid", aud: "authenticated", app_metadata: {}, user_metadata: {} };
const keys = ["ready", "existing_brc", "missing_information", "needs_review", "verified", "no_result", "failed"];
const companies = Array.from({ length: 64 }, (_, index) => {
  const bucket = index < 35 ? "ready" : keys[(index - 35) % 7];
  return {
  contractor_id: index + 1, company_name: index === 0 ? "Material Only Fixture" : `Fixture Company ${String(index + 1).padStart(3, "0")}`,
  brc_number: ["existing_brc", "verified"].includes(bucket) ? `CERT-${index}` : null,
  name_control_status: bucket === "missing_information" ? "invalid" : "valid",
  fein_status: bucket === "missing_information" ? "missing" : "valid",
  compliance_state: bucket === "verified" ? "Active" : "Missing Information",
  request_status: bucket === "needs_review" ? "review_required" : null,
  review_status: bucket === "needs_review" ? "pending" : null,
  last_attempt_at: ["needs_review", "no_result", "failed"].includes(bucket) ? "2026-10-29T12:00:00Z" : null,
  last_result: bucket === "failed" ? "website_error" : null,
  bucket, reasons: bucket === "missing_information" ? ["Missing FEIN", "Invalid Name Control"] : [],
}; });
const counts = Object.fromEntries(["all", ...keys].map((key) => [key, key === "all" ? companies.length : companies.filter((row) => row.bucket === key).length]));
const requests = [], writes = [], sessions = [];
let fail = false, rejectSave = false, manager = true;
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(({ storageKey, user }) => localStorage.setItem(storageKey, JSON.stringify({
    access_token: "fixture-token", refresh_token: "fixture-refresh", token_type: "bearer",
    expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user,
  })), { storageKey, user });
  await context.route("**/*", async (route) => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin === new URL(appUrl).origin) {
      assert.ok(!url.pathname.includes("nj-brc-search") && !url.pathname.includes("/integrations/compliance-sync/nj-brc"),
        `No BRC search or worker request permitted: ${url.pathname}`);
      if (url.pathname === "/api/admin/compliance-sync/nj-brc-queue") {
        requests.push(url.searchParams.toString());
        assert.equal(request.method(), "GET");
        if (fail) return route.fulfill({ status: 503, json: { error: "Queue unavailable; no results inferred." } });
        const bucket = url.searchParams.get("bucket"), term = url.searchParams.get("search").toLowerCase();
        const rows = companies.filter((row) => (bucket === "all" || row.bucket === bucket)
          && `${row.company_name} ${row.contractor_id} ${row.brc_number ?? ""}`.toLowerCase().includes(term));
        const page = Number(url.searchParams.get("page")), size = Number(url.searchParams.get("page_size"));
        return route.fulfill({ json: { rows: rows.slice((page - 1) * size, page * size), counts, total_filtered: rows.length, page, page_size: size } });
      }
      if (url.pathname === "/api/admin/compliance-sync/nj-brc-sessions") {
        if (request.method() !== "GET") {
          writes.push(request.postDataJSON());
          if (rejectSave) return route.fulfill({ status: 409, json: { error: "Company is no longer Ready. Refresh selection." } });
          const body = request.postDataJSON();
          if (request.method() === "POST") sessions.unshift({
            id: "00000000-0000-4000-8000-000000000010", status: "prepared", created_at: "2026-10-29T12:00:00Z", member_count: body.contractor_ids.length,
            members: body.contractor_ids.map((id, index) => ({ contractor_id: id, ordinal: index + 1, company_name: companies.find((row) => row.contractor_id === id).company_name })),
          });
          else sessions[0].status = { start: "running", pause: "paused", resume: "running", stop: "stopped" }[body.action];
        }
        return route.fulfill({ json: url.searchParams.has("session_id") ? { session: sessions[0] } : { sessions } });
      }
      if (url.pathname.endsWith("nj-pwc-sync-exceptions")) return route.fulfill({ json: { test_mode: false, exceptions: [], health: null, active_run: null } });
      if (url.pathname.endsWith("orphaned-requests")) return route.fulfill({ json: { requests: [], age_threshold_minutes: 10 } });
      if (url.pathname.endsWith("worker-health")) return route.fulfill({ json: { overall: "offline", workers: [] } });
      if (url.pathname.endsWith("registration-unlink")) return route.fulfill({ json: { contractors: [] } });
      if (url.pathname.startsWith("/api/")) {
        assert.ok(request.method() === "GET" || ["/api/auth/session", "/api/admin/bootstrap"].includes(url.pathname),
          `Unexpected mutation blocked: ${url.pathname}`);
        return route.fulfill({ json: {
          profile: { auth_user_id: user.id, name: "Fixture", email: user.email, role: manager ? "Compliance Manager" : "Read Only", status: "Active", system_administrator: false },
          permissions: ["dashboard", "compliance_sync", "contractors", "compliance", "insurance", "projects", "followups"].map((module) => ({
            module, can_view: true, can_manage: manager, can_add: manager, can_edit: manager, can_delete: manager,
          })),
        } });
      }
      return route.continue();
    }
    assert.equal(url.origin, origin, "All NJ/external traffic blocked");
    if (url.pathname.startsWith("/auth/")) return route.fulfill({ json: user });
    assert.ok(["GET", "HEAD"].includes(request.method()), "No real database writes");
    return route.fulfill({ json: [] });
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${appUrl}/admin/compliance-sync`);
  assert.equal(requests.length, 0, "Queue must not fetch on PWC/other tabs");
  await page.getByRole("tab", { name: "NJ BRC", exact: true }).click();
  const panel = page.getByRole("region", { name: "NJ BRC Verification Queue" });
  await panel.getByText("Population reconciled: 64 active companies, one bucket per company.", { exact: false }).waitFor();
  assert.equal(await panel.locator("tbody tr").count(), 25);
  await panel.getByRole("link", { name: "Material Only Fixture" }).waitFor();
  assert.equal(writes.length, 0, "Viewing queue does not create manifests or searches");
  if (process.env.BRC_QUEUE_CHECK_LAYOUT) {
    const columns = () => panel.locator('[class*="grid-cols-2"]').evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").length);
    assert.equal(await columns(), 8, "Desktop summary stays compact in one row");
    await page.setViewportSize({ width: 900, height: 1000 });
    assert.equal(await columns(), 4, "Tablet summary uses four columns");
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await columns(), 2, "Phone summary uses two columns");
    assert.equal(await panel.locator("table").evaluate((element) => element.parentElement.scrollWidth > element.parentElement.clientWidth), true, "Wide operational table scrolls within its container");
    await page.setViewportSize({ width: 1440, height: 1000 });
  }
  if (process.env.BRC_QUEUE_SCREENSHOT) await panel.screenshot({ path: process.env.BRC_QUEUE_SCREENSHOT });
  await panel.getByRole("button", { name: /^Ready \d+$/ }).click();
  await panel.getByText("Page 1 of 2", { exact: false }).waitFor();
  for (const id of [8, 3, 1, 5]) {
    const checkbox = panel.getByRole("checkbox", { name: `Select BRC company ${id}`, exact: true });
    assert.equal(await checkbox.isEnabled(), true);
    await checkbox.check();
  }
  await panel.getByRole("button", { name: "Next", exact: true }).click();
  await panel.getByText("Page 2 of 2", { exact: false }).waitFor();
  await panel.getByRole("checkbox", { name: "Select BRC company 26", exact: true }).check();
  await panel.getByRole("status").filter({ hasText: /^5 selected$/ }).waitFor();
  await panel.getByRole("textbox", { name: "Search NJ BRC queue" }).fill("Material Only");
  await panel.getByRole("button", { name: "Search", exact: true }).click();
  await panel.getByText("1 matching companies", { exact: false }).waitFor();
  assert.equal(await panel.getByRole("checkbox", { name: "Select BRC company 1", exact: true }).isChecked(), true);
  const createFive = panel.getByRole("button", { name: "Create Verification Batch (5)", exact: true });
  assert.equal(await createFive.isEnabled(), true);
  await createFive.click();
  await panel.getByText("Verification batch saved. No worker was started and no NJ search requests were created.").waitFor();
  assert.deepEqual(writes[0].contractor_ids, [8, 3, 1, 5, 26]);
  assert.equal(sessions[0].status, "prepared");
  assert.equal(sessions[0].member_count, 5);
  assert.deepEqual(sessions[0].members.map((member) => [member.ordinal, member.contractor_id]), [[1, 8], [2, 3], [3, 1], [4, 5], [5, 26]]);
  await panel.getByText("View frozen membership", { exact: true }).click();
  await panel.getByText("1. #8 Fixture Company 008", { exact: true }).waitFor();
  await panel.getByText("5. #26 Fixture Company 026", { exact: true }).waitFor();
  assert.equal(await panel.locator("ol li").count(), 5);
  await panel.getByRole("status").filter({ hasText: /^0 selected$/ }).waitFor();
  await panel.getByRole("textbox", { name: "Search NJ BRC queue" }).fill("");
  await panel.getByRole("button", { name: "Search", exact: true }).click();
  await panel.getByText("Page 1 of 2", { exact: false }).waitFor();
  await panel.getByRole("button", { name: "Select Ready on page" }).click();
  await panel.getByRole("status").filter({ hasText: /^25 selected$/ }).waitFor();
  await panel.getByRole("button", { name: "Next", exact: true }).click();
  await panel.getByText("Page 2 of 2", { exact: false }).waitFor();
  await panel.getByRole("button", { name: "Select Ready on page" }).click();
  await panel.getByRole("status").filter({ hasText: /^40 selected$/ }).waitFor();
  await panel.getByRole("button", { name: "Clear selection", exact: true }).click();
  await panel.getByRole("status").filter({ hasText: /^0 selected$/ }).waitFor();
  assert.equal(await panel.locator("tbody input:checked").count(), 0);
  page.once("dialog", (dialog) => dialog.accept());
  await panel.getByRole("button", { name: "Start attended session", exact: true }).click();
  await panel.getByRole("status").filter({ hasText: "Attended session enabled." }).waitFor();
  assert.equal(sessions[0].status, "running");
  assert.equal(await panel.getByRole("button", { name: "Start attended session", exact: true }).count(), 0);
  Object.assign(sessions[0], { completed_count: 1, skipped_count: 0, current_ordinal: 2 });
  Object.assign(sessions[0].members[0], {
    state: "completed", request_status: "review_required", result_type: "successful_certificate",
  });
  await panel.getByText("1/5 outcomes saved", { exact: false }).waitFor();
  await panel.locator("ol li").filter({ hasText: "completed · review required · successful certificate" }).waitFor();
  await panel.getByRole("button", { name: "Pause manifest" }).click();
  await panel.getByRole("button", { name: "Resume manifest" }).waitFor();
  await panel.getByRole("button", { name: "Resume manifest" }).click();
  await panel.getByRole("button", { name: "Pause manifest" }).waitFor();
  await panel.getByRole("button", { name: "Stop manifest" }).click();
  await panel.getByText(/companies · stopped/).waitFor();
  assert.equal(await panel.getByRole("button", { name: "Resume manifest" }).count(), 0);
  await panel.getByRole("button", { name: "Missing Information", exact: false }).click();
  await panel.getByText("Page 1 of 1", { exact: false }).waitFor();
  assert.equal(await panel.locator('tbody input:not(:disabled)').count(), 0);
  const blockedRow = panel.locator("tbody tr").first();
  await blockedRow.getByText("Missing FEIN; Invalid Name Control", { exact: true }).waitFor();
  assert.equal(await blockedRow.getByRole("checkbox").getAttribute("aria-describedby"),
    `brc-selection-reason-${await blockedRow.getByRole("checkbox").getAttribute("aria-label").then((label) => label.match(/\d+$/)[0])}`);
  await panel.getByRole("button", { name: /^Existing BRC \/ Reconcile \d+$/ }).click();
  await panel.locator("tbody tr").first().locator("td").first().getByText("Existing BRC / Reconcile", { exact: true }).waitFor();
  assert.equal(await panel.locator("tbody input:not(:disabled)").count(), 0);
  await panel.getByRole("button", { name: /^Needs Review \d+$/ }).click();
  await panel.locator("tbody tr").first().getByText("Prior attempt or existing BRC requires review", { exact: true }).waitFor();
  assert.equal(await panel.locator("tbody input:not(:disabled)").count(), 0);
  await panel.getByRole("button", { name: "All Active", exact: false }).click();
  await panel.getByRole("textbox", { name: "Search NJ BRC queue" }).fill("Material Only");
  await panel.getByRole("button", { name: "Search", exact: true }).click();
  await panel.getByText("1 matching companies", { exact: false }).waitFor();
  await panel.getByText("Population reconciled: 64 active companies", { exact: false }).waitFor();
  rejectSave = true;
  await panel.getByRole("checkbox", { name: "Select BRC company 1" }).check();
  await panel.getByRole("button", { name: /Create Verification Batch/ }).click();
  await panel.getByRole("alert").filter({ hasText: "Company is no longer Ready" }).waitFor();
  assert.ok(!(await panel.innerText()).includes("001234567"), "No full FEIN in UI");
  assert.equal(await panel.getByRole("button", { name: "Start Session", exact: true }).count(), 0);
  fail = true;
  await panel.getByRole("button", { name: "Refresh queue" }).click();
  await panel.getByRole("alert").filter({ hasText: "Queue unavailable" }).waitFor();
  assert.equal(await panel.locator("tbody tr").count(), 0, "Failed load cannot display stale success rows");
  assert.deepEqual(errors, []);
  await page.getByRole("tab", { name: "NJ PWC", exact: true }).click();
  assert.equal(await page.getByRole("region", { name: "NJ BRC Verification Queue" }).count(), 0);
  fail = false; manager = false;
  await page.reload();
  await page.getByRole("tab", { name: "NJ BRC", exact: true }).click();
  await panel.getByText("Population reconciled: 64 active companies", { exact: false }).waitFor();
  assert.equal(await panel.getByRole("button", { name: "Select Ready on page" }).isEnabled(), true);
  assert.equal(await panel.getByRole("button", { name: /Create Verification Batch/ }).isDisabled(), true);
  await panel.getByRole("checkbox", { name: "Select BRC company 1", exact: true }).check();
  await panel.getByText("creating or changing a verification batch requires Compliance Sync manage permission.", { exact: false }).waitFor();
  assert.equal(writes.filter((write) => "contractor_ids" in write).length, 2, "Only deliberate batch save and intercepted failed save occurred");
  console.log("PASS: five Ready companies individually selected across pages/search; Create Verification Batch (5); exactly five Prepared Batch members in selection order; page select/clear; visible disabled reasons; creation permissions preserved; no NJ/search/worker mutation routes called.");
} finally { await browser.close(); }
