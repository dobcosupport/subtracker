import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const appUrl = process.env.TEST_APP_URL;
assert.equal(new URL(appUrl).hostname, "localhost", "Use an isolated localhost preview");
const env = fs.readFileSync(".env.local", "utf8");
const origin = new URL(env.match(/^NEXT_PUBLIC_SUPABASE_URL\s*=\s*["']?([^"'\r\n]+)/m)[1].trim()).origin;
const storageKey = `sb-${new URL(origin).hostname.split(".")[0]}-auth-token`;
const user = { id: "00000000-0000-0000-0000-000000000001", email: "fixture@example.invalid", aud: "authenticated", app_metadata: {}, user_metadata: {} };
const contractor = { id: 8, company_name: "Isolated Workspace Fixture", active: true };
const projects = Array.from({ length: 125 }, (_, index) => ({
  id: index + 1, project_number: `26-${String(index + 1).padStart(3, "0")}`, project_name: `Fixture Project ${index + 1}`, status: "Active",
}));
projects.push({ id: 126, project_number: "25-999", project_name: "Historical Terminal Project", status: "Completed" });
const combinations = [["MANUAL"], ["PROCORE"], ["MYCOI"], ["MANUAL", "PROCORE"], ["MANUAL", "MYCOI"], ["PROCORE", "MYCOI"], ["MANUAL", "PROCORE", "MYCOI"], [], ["MANUAL"]];
const assignments = combinations.flatMap((sources, index) => sources.length ? [{
  id: index + 1, contractor_id: 8, project_id: index + 1, active: true,
  manual_owned: sources.includes("MANUAL"), mycoi_owned: sources.includes("MYCOI"), ownership_sources: [...sources],
  assigned_date: "2026-01-01", projects: projects[index],
}] : []);
assignments.push({ id: 126, contractor_id: 8, project_id: 126, active: false, manual_owned: false, mycoi_owned: false, ownership_sources: [], assigned_date: "2025-01-01", projects: projects[125] });
const provenance = { last_imported_at: "2026-10-27T20:23:50Z", import_reference: "Isolated import", import_history_id: null };
const tables = {
  contractors: [contractor], projects, contractor_projects: assignments,
  contractor_followups: [{ id: 1, contractor_id: 8, followup_date: "2026-11-01", followup_method: "Phone", subject: "Fixture follow-up", status: "Open", notes: "Existing contractor follow-up" }],
  mycoi_vendor_mappings: [{ id: 1, contractor_id: 8, raw_vendor_name: "Fixture Vendor", vendor_email: null, vendor_phone: null, active: true, ...provenance }],
  mycoi_contractor_divisions: [{ id: 1, vendor_mapping_id: 1, active: true, is_current: true, compliance_status: "Compliant Finalized", division: { project_id: 3, project: projects[2] }, ...provenance }],
  mycoi_policies: [{ id: 1, contractor_id: 8, vendor_mapping_id: 1, active: true, is_current: true, policy_line: "General Liability", policy_number: "FIXTURE-POLICY", expiration_date: "2025-12-10", expired: true, divisions: [{ contractor_division_id: 1 }], ...provenance }],
};
const writes = [];
const reads = [];
const browserErrors = [];
const screenshotDirectory = process.env.TEST_SCREENSHOT_DIR;
if (screenshotDirectory) fs.mkdirSync(screenshotDirectory, { recursive: true });
let failProject = null;
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1536, height: 1024 } });
  await context.addInitScript(({ storageKey, user }) => localStorage.setItem(storageKey, JSON.stringify({
    access_token: "fixture-token", refresh_token: "fixture-refresh", token_type: "bearer",
    expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user,
  })), { storageKey, user });
  await context.route("**/*", async (route) => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin === new URL(appUrl).origin) {
      if (url.pathname === "/api/admin/bootstrap") return route.fulfill({ json: {} });
      assert.ok(["GET", "HEAD"].includes(request.method()), `Unexpected app write: ${url.pathname}`);
      if (url.pathname.endsWith("/merge-history")) return route.fulfill({ json: { contractor_id: 8, companies: [], receipts: [], categories: [] } });
      if (url.pathname.startsWith("/api/")) return route.fulfill({ json: {
        profile: { auth_user_id: user.id, name: "Fixture", email: user.email, role: "Administrator", status: "Active", system_administrator: true },
        permissions: ["contractors", "compliance", "insurance", "projects", "followups", "imports", "compliance_sync"].map(module => ({ module, can_view: true, can_manage: true, can_add: true, can_edit: true, can_delete: true })),
        data: [], contacts: [],
      } });
      return route.continue();
    }
    assert.equal(url.origin, origin, "Unexpected external traffic blocked");
    if (url.pathname.startsWith("/auth/")) return route.fulfill({ json: user });
    if (url.pathname.endsWith("/rpc/set_manual_project_assignment")) {
      const input = request.postDataJSON();
      assert.equal(input.p_contractor, 8);
      writes.push(input);
      await new Promise(resolve => setTimeout(resolve, 200));
      if (input.p_project === failProject) return route.fulfill({ status: 403, json: { message: "Fixture Manual save denied" } });
      let assignment = assignments.find(item => item.project_id === input.p_project && item.active);
      if (!assignment) {
        assignment = { id: 200 + input.p_project, contractor_id: 8, project_id: input.p_project, active: true, ownership_sources: [], manual_owned: false, mycoi_owned: false, assigned_date: input.p_assigned, projects: projects.find(project => project.id === input.p_project) };
        assignments.push(assignment);
      }
      assignment.ownership_sources = [...assignment.ownership_sources.filter(source => source !== "MANUAL"), ...(input.p_owned ? ["MANUAL"] : [])];
      assignment.manual_owned = input.p_owned;
      assignment.active = assignment.ownership_sources.length > 0;
      return route.fulfill({ json: [assignment] });
    }
    assert.ok(["GET", "HEAD"].includes(request.method()), `Unexpected database write: ${url.pathname}`);
    const table = url.pathname.split("/").at(-1);
    reads.push(table);
    let rows = tables[table] ?? [];
    for (const [key, value] of url.searchParams) {
      const get = row => key.split(".").reduce((item, part) => item?.[part], row);
      if (value.startsWith("eq.")) rows = rows.filter(row => String(get(row)) === value.slice(3));
      if (value.startsWith("neq.")) rows = rows.filter(row => String(get(row)) !== value.slice(4));
      if (value.startsWith("in.(")) rows = rows.filter(row => value.slice(4, -1).split(",").includes(String(get(row))));
    }
    return route.fulfill({ json: (request.headers().accept ?? "").includes("vnd.pgrst.object") ? rows[0] ?? null : rows });
  });
  const page = await context.newPage();
  page.on("pageerror", error => browserErrors.push(error.message));
  page.on("dialog", dialog => dialog.accept());
  await page.goto(`${appUrl}/contractors/8`);
  await page.getByRole("tab", { name: "Overview", exact: true }).waitFor();
  await page.locator('#view-insurance [aria-label="Imported myCOI summary"]').waitFor({ state: "attached" });
  await page.waitForLoadState("networkidle");
  const baselineReads = reads.length;
  assert.equal(await page.getByRole("tab").count(), 5);
  assert.deepEqual(await page.getByRole("tabpanel").getByRole("heading").allTextContents(), ["Company Information", "Compliance Records"]);
  for (const name of ["Overview", "Insurance (myCOI)", "Projects", "Follow-Ups", "Company History"]) {
    await page.getByRole("tab", { name, exact: true }).click();
    assert.equal(await page.getByRole("tabpanel").count(), 1);
    assert.equal(await page.getByRole("tab", { name, exact: true }).getAttribute("aria-selected"), "true");
    assert.equal(await page.evaluate(() => scrollY), 0);
    assert.ok(await page.getByRole("heading", { name: contractor.company_name, exact: true }).isVisible());
    assert.ok(await page.getByRole("group", { name: "Contractor quick links" }).isVisible());
  }
  assert.equal(reads.length, baselineReads, "View switches reuse loaded data without re-fetches");
  assert.deepEqual(writes, [], "View navigation performs no writes");
  await page.goBack();
  assert.equal(await page.getByRole("tab", { name: "Follow-Ups", exact: true }).getAttribute("aria-selected"), "true");
  await page.goForward();
  assert.equal(await page.getByRole("tab", { name: "Company History", exact: true }).getAttribute("aria-selected"), "true");
  await page.getByRole("button", { name: "Project History", exact: true }).click();
  assert.ok(await page.getByText("Historical Terminal Project", { exact: true }).isVisible());
  await page.getByRole("tab", { name: "Insurance (myCOI)", exact: true }).click();
  await page.getByRole("button", { name: "Has Expired Policies (1)", exact: true }).click();
  await page.getByRole("searchbox", { name: "Search insurance projects" }).fill("26-003");
  for (const name of ["View compliance", "View expiring", "View expired"]) {
    await page.getByRole("link").filter({ hasText: name }).click();
    assert.equal(await page.getByRole("tab", { name: "Overview", exact: true }).getAttribute("aria-selected"), "true");
    await page.waitForFunction(() => {
      const bounds = document.getElementById("compliance").getBoundingClientRect();
      return bounds.top >= 0 && bounds.top < innerHeight;
    });
    assert.equal(new URL(page.url()).hash, "#compliance");
    if (name !== "View expired") await page.getByRole("tab", { name: "Insurance (myCOI)", exact: true }).click();
  }
  await page.getByRole("button", { name: "Add Compliance Record", exact: true }).click();
  await page.getByRole("textbox", { name: "Registration Number", exact: true }).fill("UNSAVED-FIXTURE");
  await page.goBack();
  assert.equal(await page.getByRole("textbox", { name: "Registration Number", exact: true }).inputValue(), "UNSAVED-FIXTURE", "History navigation must not lose open modal form state");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(await page.getByRole("searchbox", { name: "Search insurance projects" }).inputValue(), "26-003");
  assert.equal(await page.getByRole("button", { name: "Has Expired Policies (1)" }).getAttribute("aria-pressed"), "true");
  await page.getByRole("tab", { name: "Projects", exact: true }).click();
  assert.equal(await page.getByRole("tabpanel").getByRole("checkbox").count(), 0, "Normal Projects workspace is read-only");
  assert.equal(await page.getByRole("tabpanel").getByText("Historical Terminal Project", { exact: false }).count(), 0);
  const assignedSearch = page.getByRole("searchbox", { name: "Search assigned projects" });
  await assignedSearch.fill("26-004");
  assert.equal(await page.getByRole("tabpanel").getByText("26-004 · Fixture Project 4", { exact: true }).count(), 1);
  await assignedSearch.fill("Fixture Project 7");
  assert.equal(await page.getByRole("tabpanel").getByText("26-007 · Fixture Project 7", { exact: true }).count(), 1);
  await assignedSearch.fill("");
  await page.getByRole("button", { name: "Manage Project Assignments", exact: true }).click();
  const modal = page.getByRole("dialog", { name: "Manage Project Assignments", exact: true });
  assert.ok(await modal.getByText("Each checkbox change is saved immediately. Procore and myCOI relationships are preserved.").isVisible());
  assert.equal(await modal.getByRole("button", { name: /Save Changes|Cancel/ }).count(), 0);
  assert.equal(await modal.locator("tbody tr").count(), 50);
  for (let index = 0; index < combinations.length; index++) {
    const checkbox = modal.getByRole("checkbox", { name: `MANUAL 26-${String(index + 1).padStart(3, "0")}`, exact: true });
    assert.equal(await checkbox.isChecked(), combinations[index].includes("MANUAL"));
    const sources = await checkbox.locator("xpath=ancestor::tr").locator("td").nth(2).innerText();
    for (const source of ["PROCORE", "MYCOI"]) assert.equal(sources.includes(source === "PROCORE" ? "Procore" : "myCOI"), combinations[index].includes(source));
  }
  if (screenshotDirectory) await modal.screenshot({ path: path.join(screenshotDirectory, "contractor-project-modal-isolated-sources.png") });
  const search = modal.getByRole("searchbox", { name: "Search projects" });
  await search.fill("26-125");
  assert.equal(await modal.locator("tbody tr").count(), 1, "Search spans all pages");
  await search.fill("Fixture Project 125");
  assert.equal(await modal.locator("tbody tr").count(), 1);
  if (screenshotDirectory) await modal.screenshot({ path: path.join(screenshotDirectory, "contractor-project-modal-isolated-search.png") });
  await search.fill("");
  await modal.getByRole("button", { name: "Next", exact: true }).click();
  assert.equal(await modal.locator("tbody tr").count(), 50);
  await modal.getByRole("button", { name: "Next", exact: true }).click();
  assert.equal(await modal.locator("tbody tr").count(), 25);
  await modal.getByRole("button", { name: "Previous", exact: true }).click();
  await modal.getByRole("button", { name: "Previous", exact: true }).click();
  const checkbox = id => modal.getByRole("checkbox", { name: `MANUAL 26-${String(id).padStart(3, "0")}`, exact: true });
  await checkbox(8).click();
  await modal.getByText("Saving...", { exact: true }).waitFor();
  assert.equal(await checkbox(8).isDisabled(), true);
  assert.equal(await checkbox(2).isDisabled(), false, "Saving must not block other rows");
  await checkbox(8).waitFor({ state: "visible" });
  await page.waitForFunction(() => !document.querySelector('input[aria-label="MANUAL 26-008"]').disabled);
  assert.equal(await checkbox(8).isChecked(), true);
  assert.deepEqual(assignments.find(row => row.project_id === 8).ownership_sources, ["MANUAL"]);
  for (const id of [1, 4, 5, 7]) {
    const before = [...assignments.find(row => row.project_id === id).ownership_sources];
    await checkbox(id).click();
    await page.waitForFunction(id => !document.querySelector(`input[aria-label="MANUAL 26-${String(id).padStart(3, "0")}"]`).disabled, id);
    const row = assignments.find(row => row.project_id === id);
    assert.equal(await checkbox(id).isChecked(), false);
    assert.deepEqual(row.ownership_sources, before.filter(source => source !== "MANUAL"));
    assert.equal(row.active, row.ownership_sources.length > 0);
  }
  await checkbox(2).click();
  await checkbox(3).click();
  await page.waitForFunction(() => [2, 3].every(id => !document.querySelector(`input[aria-label="MANUAL 26-${String(id).padStart(3, "0")}"]`).disabled));
  assert.equal(await checkbox(2).isChecked(), true, "Concurrent successful saves retain both rows");
  assert.equal(await checkbox(3).isChecked(), true);
  assert.deepEqual(assignments.find(row => row.project_id === 2).ownership_sources, ["PROCORE", "MANUAL"]);
  assert.deepEqual(assignments.find(row => row.project_id === 3).ownership_sources, ["MYCOI", "MANUAL"]);
  failProject = 9;
  await checkbox(9).click();
  await modal.getByText("Fixture Manual save denied", { exact: true }).waitFor();
  assert.equal(await checkbox(9).isChecked(), true, "Failed write restores the previous checkbox state");
  assert.equal(await checkbox(9).isDisabled(), false);
  failProject = null;
  await modal.getByRole("button", { name: /^Assigned Manually/ }).click();
  assert.equal(await modal.getByRole("checkbox").count(), 4);
  await modal.getByRole("button", { name: /^Not Manually Assigned/ }).click();
  assert.equal(await modal.getByRole("checkbox").count(), 50);
  assert.equal(await checkbox(1).isChecked(), false);
  await modal.getByRole("button", { name: /^All \(/ }).click();
  await search.fill("26-008");
  assert.equal(await checkbox(8).isChecked(), true, "Search/filter/page changes retain saved state");
  await page.goBack();
  assert.ok(await modal.isVisible(), "History navigation must not hide a top-layer modal inside an inactive workspace");
  assert.equal(await search.inputValue(), "26-008");
  await page.goForward();
  const beforeClose = writes.length;
  await modal.getByRole("button", { name: "Close", exact: true }).click();
  assert.equal(writes.length, beforeClose);
  await page.getByRole("tab", { name: "Overview", exact: true }).click();
  await page.getByRole("tab", { name: "Projects", exact: true }).click();
  await page.getByRole("button", { name: "Manage Project Assignments", exact: true }).click();
  assert.equal(await search.inputValue(), "26-008");
  assert.equal(await checkbox(8).isChecked(), true);
  await modal.getByRole("button", { name: "Close", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => parseFloat(getComputedStyle(document.querySelector("main").parentElement).marginLeft) === 0);
  assert.equal(await page.getByRole("tabpanel").count(), 1);
  assert.ok(await page.getByRole("tabpanel").evaluate(el => el.getBoundingClientRect().right <= innerWidth));
  assert.deepEqual(browserErrors, []);
  console.log("PASS: five exclusive persistent workspaces, Overview Compliance/KPI targeting, back/forward, no navigation refetches/writes, retained myCOI/modal state, read-only assigned search; all seven source combinations; immediate Manual add/remove, imported-source preservation, row-local saving/errors, concurrent saves, filters and full-collection 50-row pagination. All data/mutations isolated and mocked.");
} finally {
  await browser.close();
}
