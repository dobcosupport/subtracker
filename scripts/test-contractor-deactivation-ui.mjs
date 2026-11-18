import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "../worker/nj-pwc/node_modules/playwright");
const app = process.env.TEST_APP_URL;
assert.equal(new URL(app).hostname, "localhost", "Mutation checks require an intercepted localhost fixture");
const origin = new URL(fs.readFileSync(".env.local", "utf8")
  .match(/^NEXT_PUBLIC_SUPABASE_URL\s*=\s*["']?([^"'\r\n]+)/m)[1].trim()).origin;
const user = { id: "00000000-0000-0000-0000-000000000001", email: "fixture@example.invalid", aud: "authenticated", app_metadata: {}, user_metadata: {} };
const contractor = { id: 8, company_name: "Isolated Deactivation Fixture", active: true, email: null };
const project = { id: 1, project_number: "26-001", project_name: "Preserved Fixture Project", status: "Active" };
const complianceType = { id: 1, compliance_name: "NJ PWC", requires_expiration: true, active: true };
const history = {
  contractor_contacts: [{ id: "00000000-0000-0000-0000-000000000011", contractor_id: 8, contact_name: "Preserved Contact", is_active: true }],
  projects: [project],
  contractor_projects: [{ id: 1, contractor_id: 8, project_id: 1, active: true, assigned_date: "2026-01-01",
    manual_owned: true, mycoi_owned: true, ownership_sources: ["MANUAL", "PROCORE", "MYCOI"], projects: project }],
  compliance_types: [complianceType],
  compliance_records: [{ id: 1, contractor_id: 8, compliance_type_id: 1, compliance_types: complianceType, active: true,
    registration_number: "FIXTURE-PWC", effective_date: "2026-01-01", expiration_date: "2099-01-01" }],
  contractor_followups: [{ id: 1, contractor_id: 8, followup_date: "2099-01-01", followup_method: "Phone", subject: "Preserved Follow-Up", status: "Open" }],
  insurance_verification_history: [{ id: 1, contractor_id: 8, verification_date: "2026-01-01", notes: "Preserved insurance" }],
  mycoi_vendor_mappings: [{ id: 1, contractor_id: 8, raw_vendor_name: "Preserved Vendor", active: true }],
  communication_messages: [{ id: "00000000-0000-0000-0000-000000000012", status: "Sent", subject: "Preserved Email" }],
};
const baselineHistory = structuredClone(history);
const activity = [{ id: 1, contractor_id: 8, activity_date: "2026-01-01", activity_type: "Original Fixture History", notes: "Preserved Company History" }];
const patches = [], auditWrites = [], errors = [];
let fail = false, releaseUpdate = null;
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1536, height: 1000 } });
  await context.addInitScript(({ origin, user }) => localStorage.setItem(`sb-${new URL(origin).hostname.split(".")[0]}-auth-token`,
    JSON.stringify({ access_token: "fixture-token", refresh_token: "fixture-refresh", token_type: "bearer",
      expires_at: Math.floor(Date.now() / 1000) + 3600, user })), { origin, user });
  await context.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin === new URL(app).origin) {
      if (url.pathname === "/api/admin/bootstrap") return route.fulfill({ json: {} });
      assert.ok(["GET", "HEAD"].includes(request.method()), `No application writes allowed: ${url.pathname}`);
      if (url.pathname === "/api/auth/session") return route.fulfill({ json: {
        profile: { auth_user_id: user.id, name: "Fixture", role: "Administrator", status: "Active", system_administrator: true },
        permissions: ["contractors", "projects", "compliance", "insurance", "followups", "imports", "compliance_sync"].map(module =>
          ({ module, can_view: true, can_manage: true, can_add: true, can_edit: true })),
      } });
      if (url.pathname.endsWith("/merge-history")) return route.fulfill({ json: { companies: [], receipts: [], categories: [] } });
      if (url.pathname === "/api/followups/email-origins") return route.fulfill({ json: {
        origins: Object.fromEntries(url.searchParams.get("ids").split(",").map(id => [id, null])),
      } });
      if (url.pathname.startsWith("/api/")) return route.fulfill({ json: { contacts: [], data: [] } });
      return route.continue();
    }
    assert.equal(url.origin, origin, "All external traffic must be intercepted");
    if (url.pathname.startsWith("/auth/")) return route.fulfill({ json: user });
    const table = url.pathname.split("/").at(-1);
    if (table === "contractors" && request.method() === "PATCH") {
      assert.equal(url.searchParams.get("id"), "eq.8");
      const input = request.postDataJSON();
      assert.equal(input.active, false);
      patches.push(input);
      if (releaseUpdate) await new Promise(resolve => { releaseUpdate.resolve = resolve; });
      if (fail) return route.fulfill({ status: 403, json: { message: "Fixture deactivation denied", code: "42501" } });
      Object.assign(contractor, input);
      return route.fulfill({ status: 204, body: "" });
    }
    if (table === "activity_log" && request.method() === "POST") {
      const input = request.postDataJSON();
      auditWrites.push(input); activity.push({ id: activity.length + 1, ...input });
      return route.fulfill({ status: 201, json: [input] });
    }
    assert.ok(["GET", "HEAD"].includes(request.method()), `No history/relationship mutations allowed: ${table}`);
    let rows = table === "contractors" ? [contractor] : table === "activity_log" ? activity : history[table] ?? [];
    for (const [key, value] of url.searchParams) {
      const get = row => key.split(".").reduce((v, part) => v?.[part], row);
      if (value.startsWith("eq.")) rows = rows.filter(row => String(get(row)) === value.slice(3));
      if (value.startsWith("in.(")) rows = rows.filter(row => value.slice(4, -1).split(",").includes(String(get(row))));
    }
    return route.fulfill({ json: request.headers().accept?.includes("vnd.pgrst.object") ? rows[0] ?? null : rows });
  });
  const page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  const dialog = page.getByRole("dialog", { name: "Deactivate Contractor?", exact: true });
  const cancel = async () => {
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
  };
  const openDirectory = async () => {
    contractor.active = true;
    await page.goto(`${app}/contractors`);
    await page.getByRole("heading", { name: "Contractor Management", exact: true }).waitFor();
    await page.getByRole("button", { name: "Deactivate", exact: true }).click();
    await dialog.waitFor();
  };
  const openDetail = async () => {
    contractor.active = true;
    await page.goto(`${app}/contractors/8`);
    try {
      await page.getByRole("button", { name: "Deactivate Contractor", exact: true }).click();
    } catch (reason) {
      console.error("Detail initialization:", await page.locator("body").innerText(), errors);
      throw reason;
    }
    await dialog.waitFor();
  };
  for (const open of [openDirectory, openDetail]) {
    const count = patches.length;
    await open();
    assert.equal(contractor.active, true);
    assert.equal(patches.length, count, "Opening confirmation performs zero writes");
    assert.match(await dialog.innerText(), /Isolated Deactivation Fixture/);
    await dialog.getByText("Are you sure you want to deactivate Isolated Deactivation Fixture?", { exact: true }).waitFor();
    await dialog.getByText("This does not delete the contractor or its history.", { exact: true }).waitFor();
    assert.equal(await dialog.getByRole("button", { name: "Cancel", exact: true }).evaluate(e => e === document.activeElement), true);
    await dialog.getByRole("button", { name: "Deactivate Contractor", exact: true }).focus();
    await page.keyboard.press("Enter");
    assert.equal(patches.length, count, "Enter cannot confirm");
    await cancel();
    for (const dismissal of ["x", "escape", "outside"]) {
      await open();
      if (dismissal === "x") await dialog.getByRole("button", { name: "Close deactivation confirmation" }).click();
      else if (dismissal === "escape") await page.keyboard.press("Escape");
      else await page.mouse.click(2, 2);
      await dialog.waitFor({ state: "hidden" });
      assert.equal(contractor.active, true);
      assert.equal(patches.length, count, "Dismissal performs no mutation");
    }
    await open();
    fail = true;
    await dialog.getByRole("button", { name: "Deactivate Contractor", exact: true }).click();
    await dialog.getByRole("alert").filter({ hasText: "Fixture deactivation denied" }).waitFor();
    assert.equal(contractor.active, true, "Failed update retains Active state");
    assert.equal(auditWrites.length, count, "Failure cannot log a successful status change");
    fail = false;
    await cancel();
    await open();
    releaseUpdate = {};
    const confirm = dialog.getByRole("button", { name: "Deactivate Contractor", exact: true });
    await confirm.dblclick();
    await dialog.getByRole("button", { name: "Deactivating...", exact: true }).waitFor();
    assert.equal(patches.length, count + 2, "One failed attempt plus exactly one rapid-confirm mutation");
    assert.equal(await dialog.getByRole("button", { name: "Deactivating...", exact: true }).isDisabled(), true);
    await page.keyboard.press("Escape");
    assert.equal(await dialog.isVisible(), true, "Cannot dismiss an in-flight request");
    releaseUpdate.resolve(); releaseUpdate = null;
    await dialog.waitFor({ state: "hidden" });
    await page.getByRole("button", { name: /Activate Contractor|^Activate$/ }).waitFor();
    assert.equal(contractor.active, false);
    assert.deepEqual(history, baselineHistory, "Deactivation never mutates linked records/history");
    assert.equal(activity[0].notes, "Preserved Company History");
    assert.equal(auditWrites.length, count + 1, "Successful status change logged once");
    patches.length = 0; auditWrites.length = 0;
  }
  await openDirectory();
  await cancel();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByRole("button", { name: "Deactivate", exact: true }).last().click();
  await dialog.waitFor();
  await cancel();
  assert.equal(patches.length, 0, "Directory Edit deactivation also requires confirmation");
  await page.getByRole("checkbox", { name: "Active", exact: true }).uncheck();
  await page.getByRole("button", { name: "Save Contractor", exact: true }).click();
  await dialog.waitFor();
  assert.equal(patches.length, 0, "Saving an inactive edit cannot bypass confirmation");
  await cancel();
  assert.equal(contractor.active, true, "Cancelling an inactive edit leaves the contractor Active");
  assert.equal(await page.getByRole("checkbox", { name: "Active", exact: true }).isChecked(), false,
    "Cancelling confirmation preserves the edit state for correction");
  assert.equal(await page.getByRole("button", { name: "Save Contractor", exact: true }).isVisible(), true);
  await page.getByRole("button", { name: "Save Contractor", exact: true }).click();
  await dialog.waitFor();
  fail = true;
  await dialog.getByRole("button", { name: "Deactivate Contractor", exact: true }).click();
  await dialog.getByRole("alert").filter({ hasText: "Fixture deactivation denied" }).waitFor();
  assert.equal(contractor.active, true);
  fail = false;
  const beforeConfirmedEdit = patches.length;
  await dialog.getByRole("button", { name: "Deactivate Contractor", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.equal(patches.length - beforeConfirmedEdit, 1, "Directory edit confirmation performs exactly one update");
  assert.equal(patches.length, 2, "Directory edit has one failed and one confirmed save");
  assert.equal(auditWrites.length, 1);
  assert.equal(contractor.active, false);
  assert.deepEqual(history, baselineHistory);
  patches.length = 0; auditWrites.length = 0;
  await openDetail();
  await cancel();
  await page.getByRole("tabpanel", { name: "Overview", exact: true }).getByRole("button", { name: "Edit Contractor", exact: true }).click();
  await page.getByRole("checkbox", { name: "Active", exact: true }).uncheck();
  await page.getByRole("button", { name: "Save Changes", exact: true }).click();
  await dialog.waitFor();
  assert.equal(patches.length, 0, "Detail Active checkbox cannot bypass confirmation");
  if (process.env.TEST_SCREENSHOT_DIR) {
    fs.mkdirSync(process.env.TEST_SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({ path: path.join(process.env.TEST_SCREENSHOT_DIR, "Contractor_Deactivation_Confirmation.png") });
  }
  await dialog.getByRole("button", { name: "Deactivate Contractor", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.equal(patches.length, 1, "Confirmed edit saves once");
  assert.equal(contractor.active, false);
  assert.deepEqual(history, baselineHistory);
  const beforeMobile = patches.length;
  await page.setViewportSize({ width: 320, height: 568 });
  await openDetail();
  const dimensions = await dialog.evaluate(element => ({
    width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height,
    overflow: element.scrollWidth > element.clientWidth,
  }));
  assert.ok(dimensions.width <= 320 && dimensions.height <= 568);
  assert.equal(dimensions.overflow, false, "Confirmation fits a narrow Style 3 viewport");
  await cancel();
  assert.equal(patches.length, beforeMobile);
  assert.deepEqual(errors, []);
  console.log("PASS: shared directory/detail/Edit confirmation; Cancel/X/Escape/outside/Enter safety; one rapid-confirm mutation; disabled processing; visible failure retaining Active; confirmed edit; unchanged fixture history. No real data mutations.");
} finally {
  await browser.close();
}
