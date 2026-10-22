import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
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
const provenance = { last_imported_at: "2026-10-15T12:00:00Z", import_reference: "SYNTHETIC mycoi.xlsx", import_history_id: null };
const vendor = { id: 10, contractor_id: 1, raw_vendor_name: "GZA Geo Environmental", vendor_email: "mycoi@example.invalid", vendor_phone: "MYCOI PHONE", active: true, ...provenance };
const rawDivision = "22002 - ABCO - Union City New Grade 7-9 School - Wrap Up";
const division = {
  id: 20, vendor_mapping_id: 10, active: true, is_current: true, compliance_status: "Compliant", ...provenance,
  division: { raw_division_name: rawDivision, leading_project_number: "22002", project_id: 1, project: { project_number: "22002", project_name: "Union City" } },
};
const policy = { id: 30, contractor_id: 1, vendor_mapping_id: 10, policy_line: "General Liability", policy_number: "GL-ONE", expiration_date: "2020-01-01", expired: false, source: "myCOI", active: true, is_current: true, divisions: [{ contractor_division_id: 20 }], ...provenance };
const tables = {
  contractors: [{ id: 1, company_name: "GZA GeoEnvironmental", email: "general@example.invalid", phone: "GENERAL PHONE", active: true }],
  contractor_insurance: [{ contractor_id: 1, certificate_on_file: true, general_liability_on_file: true, general_liability_expiration_date: "2026-01-01", workers_comp_on_file: false, workers_comp_expiration_date: null, notes: "SYNTHETIC legacy note" }],
  contractor_insurance_history: [{ id: 1, contractor_id: 1, coi_on_file: true, created_at: "2026-01-01T12:00:00Z" }],
  mycoi_vendor_mappings: [],
  mycoi_contractor_divisions: [],
  mycoi_policies: [],
};
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
let deniedTable = null;
let insuranceView = true;
let editor = true;
let mycoiReads = 0;
const assignmentWrites = [];
const errors = [];
try {
  await context.addInitScript(({ storageKey, user }) => localStorage.setItem(storageKey, JSON.stringify({
    access_token: "synthetic-token", refresh_token: "synthetic-refresh", token_type: "bearer",
    expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user,
  })), { storageKey, user });
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === new URL(appUrl).origin) {
      if (url.pathname === "/api/admin/bootstrap" && request.method() === "POST") return route.fulfill({ json: {} });
      assert.ok(["GET", "HEAD"].includes(request.method()), `Unexpected application mutation blocked: ${request.method()} ${url.pathname}`);
      if (url.pathname.startsWith("/api/")) return route.fulfill({ json: {
        profile: { auth_user_id: user.id, name: "SYNTHETIC", email: user.email, role: editor ? "Administrator" : "Read Only", status: "Active", system_administrator: false },
        permissions: ["dashboard", "imports", "contractors", "compliance", "insurance", "projects", "followups"].map((module) => ({
          module, can_view: module !== "insurance" || insuranceView,
          can_manage: editor, can_add: editor, can_edit: editor, can_delete: editor,
        })),
      } });
      return route.continue();
    }
    assert.equal(url.origin, origin, "Unexpected external request blocked");
    if (url.pathname.endsWith("/rpc/set_manual_project_assignment") && request.method() === "POST") {
      const input = request.postDataJSON();
      assert.equal(input.p_contractor, 1);
      assignmentWrites.push(input);
      const assignment = tables.contractor_projects.find((item) => item.project_id === input.p_project);
      assignment.manual_owned = input.p_owned;
      assignment.active = assignment.manual_owned || assignment.mycoi_owned;
      assignment.ownership_sources = [...assignment.ownership_sources.filter((source)=>source!=="MANUAL"), ...(input.p_owned ? ["MANUAL"] : [])];
      return route.fulfill({ json: [assignment] });
    }
    assert.ok(["GET", "HEAD"].includes(request.method()), `Unexpected database mutation blocked: ${request.method()} ${url.pathname}`);
    if (url.pathname.startsWith("/auth/")) return route.fulfill({ json: user });
    const table = url.pathname.split("/").at(-1);
    if (table.startsWith("mycoi_")) mycoiReads++;
    if (table === deniedTable) return route.fulfill({ status: 403, json: { message: "SYNTHETIC myCOI read denied" } });
    let rows = tables[table] ?? [];
    for (const [key, value] of url.searchParams) {
      if (value.startsWith("eq.")) rows = rows.filter((row) => String(row[key]) === value.slice(3));
      if (value.startsWith("in.(")) rows = rows.filter((row) => value.slice(4, -1).split(",").includes(String(row[key])));
    }
    return route.fulfill({ json: (request.headers().accept ?? "").includes("vnd.pgrst.object") ? rows[0] ?? null : rows });
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  const panel = page.getByRole("region", { name: "COI / myCOI Insurance", exact: true });
  const load = async () => {
    await page.goto(`${appUrl}/contractors/1`);
    await panel.waitFor();
    await panel.getByText("Loading myCOI insurance...").waitFor({ state: "hidden" });
  };
  const readonly = async () => {
    assert.equal(await panel.locator("input,select,textarea,button,form").count(), 0);
    assert.equal(await page.getByRole("button", { name: /Add Insurance|Create Insurance|Save Insurance|Edit Insurance|Delete Insurance/ }).count(), 0);
    assert.ok(await page.getByText("general@example.invalid", { exact: true }).isVisible());
    assert.ok(await page.getByText("GENERAL PHONE", { exact: true }).isVisible());
  };
  await load();
  assert.ok(await panel.getByText("No myCOI vendor mapping has been established.", { exact: true }).isVisible());
  assert.ok(await panel.getByText("Insurance information is maintained through myCOI imports.", { exact: true }).isVisible());
  assert.equal(await panel.getByRole("heading", { name: "Legacy / Manual Insurance" }).count(), 0);
  assert.equal(await panel.getByText("SYNTHETIC legacy note", { exact: true }).count(), 0);
  assert.equal(await panel.getByText(/myCOI Vendor Email:/).count(), 0);
  await readonly();

  tables.mycoi_vendor_mappings = [vendor];
  tables.mycoi_contractor_divisions = [{ ...division, compliance_status: "Compliant Finalized" }, {
    ...division, id: 21, compliance_status: "Review", division: { raw_division_name: "Unknown division", leading_project_number: null, project_id: null, project: null },
  }, {
    ...division, id: 22, compliance_status: "Compliant Finalized", division: { raw_division_name: "24003 - Long raw college division", leading_project_number: "24003", project_id: 2, project: { project_number: "24-003", project_name: "College" } },
  }, {
    ...division, id: 23, compliance_status: "Non-Compliant In-Progress", division: { raw_division_name: "25001 - Long raw school division", leading_project_number: "25001", project_id: 3, project: { project_number: "25-001", project_name: "School" } },
  }];
  for (const [index, status] of ["Undecided In-Progress", "Unregistered", "Compliant In-Progress", "Non-Compliant Finalized"].entries()) {
    tables.mycoi_contractor_divisions.push({
      ...division, id: 40 + index, compliance_status: status,
      division: { raw_division_name: `Raw attention division ${index}`, leading_project_number: null, project_id: 40 + index,
        project: { project_number: `26-00${index}`, project_name: `Attention ${index}` } },
    });
  }
  tables.mycoi_policies = [
    { ...policy, divisions: [{ contractor_division_id: 20 }, { contractor_division_id: 22 }] },
    { ...policy, id: 31, policy_number: "GL-TWO", expiration_date: "2099-01-01", expired: true },
    { ...policy, id: 32, policy_number: "GL-HISTORY", active: false, is_current: false },
    { ...policy, id: 33, policy_number: "UNASSIGNED", divisions: [] },
    { ...policy, id: 34, policy_number: "SCHOOL-ONLY", divisions: [{ contractor_division_id: 23 }] },
  ];
  await load();
  assert.ok(await panel.getByText("mycoi@example.invalid", { exact: false }).isVisible());
  assert.ok(await panel.getByText("MYCOI PHONE", { exact: false }).isVisible());
  const project = panel.locator("details").filter({ has: page.locator("summary", { hasText: "22002 - Union City" }) });
  const college = panel.locator("details").filter({ has: page.locator("summary", { hasText: "24-003 - College" }) });
  const school = panel.locator("details").filter({ has: page.locator("summary", { hasText: "25-001 - School" }) });
  assert.notEqual(await project.getAttribute("open"), null, "Expired source information expands project");
  assert.equal(await college.getAttribute("open"), null, "Compliant Finalized project collapsed");
  assert.notEqual(await school.getAttribute("open"), null, "In-Progress project expanded");
  assert.ok(await project.locator("summary").getByText("Compliant Finalized | 2 Policies", { exact: true }).isVisible());
  for (let index = 0; index < 4; index++) {
    const attention = panel.locator("details").filter({ has: page.locator("summary", { hasText: `26-00${index} - Attention ${index}` }) });
    assert.notEqual(await attention.getAttribute("open"), null, "Attention status defaults expanded");
  }
  const currentTable = project.getByRole("table");
  assert.ok(await currentTable.getByRole("row").filter({ hasText: "GL-ONE" }).getByText("Current", { exact: true }).isVisible(), "Do not derive source flag from old expiration date");
  assert.ok(await currentTable.getByRole("row").filter({ hasText: "GL-TWO" }).getByText("Expired", { exact: true }).isVisible());
  assert.ok(await currentTable.getByRole("row").filter({ hasText: "GL-ONE" }).getByText("2020-01-01", { exact: true }).isVisible());
  assert.ok(await currentTable.getByRole("row").filter({ hasText: "GL-TWO" }).getByText("2099-01-01", { exact: true }).isVisible());
  assert.match(await currentTable.getByRole("row").nth(1).textContent(), /GL-ONE/, "Non-expired source policies first");
  assert.ok(await currentTable.getByRole("columnheader", { name: "Insurance Type", exact: true }).isVisible());
  assert.equal(await panel.getByText(/GL-HISTORY/).isVisible(), false);
  assert.equal(await panel.getByText(rawDivision, { exact: false }).first().isVisible(), false);
  assert.deepEqual(await currentTable.getByRole("columnheader").allTextContents(), ["Insurance Type", "Policy Number", "Expiration Date", "Status"]);
  await college.locator("summary").click();
  assert.ok(await college.getByText("GL-ONE", { exact: true }).isVisible(), "Shared policy appears under both projects");
  assert.equal(await college.getByText("GL-TWO", { exact: true }).count(), 0, "Unrelated policy not moved");
  await project.locator("summary").click();
  assert.equal(await project.getAttribute("open"), null);
  assert.notEqual(await college.getAttribute("open"), null, "Projects toggle independently");
  assert.ok(await school.getByText("SCHOOL-ONLY", { exact: true }).isVisible());
  assert.ok(await panel.getByText("UNASSIGNED", { exact: true }).isVisible());
  assert.equal(await panel.getByText("myCOI Details / History", { exact: true }).count(), 0);
  await page.getByRole("button", { name: "Company History", exact: true }).click();
  const history = page.locator("details").filter({ has: page.locator("summary", { hasText: "myCOI Import History" }) });
  assert.equal(await history.getAttribute("open"), null);
  await history.locator("summary").click();
  assert.ok(await history.getByText(/GL-HISTORY/).isVisible());
  assert.ok(await history.getByText(rawDivision, { exact: false }).first().isVisible());
  assert.ok(await history.getByText("Historical / Superseded | Source: myCOI", { exact: true }).isVisible());
  assert.ok(await history.getByText("Source: SYNTHETIC mycoi.xlsx", { exact: true }).first().isVisible());
  await readonly();
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileBounds = await panel.boundingBox();
  assert.ok(mobileBounds && mobileBounds.x >= 0 && mobileBounds.x + mobileBounds.width <= 390, "Compact insurance panel fits mobile viewport");
  await page.setViewportSize({ width: 1366, height: 900 });

  tables.projects = [{ id: 1, project_number: "22-002", project_name: "Synthetic", status: "Active" }];
  tables.contractor_projects = [{
    id: 1, contractor_id: 1, project_id: 1, active: true, manual_owned: false, mycoi_owned: true, ownership_sources: ["MYCOI"],
    assigned_date: "2026-01-01", created_at: "2026-01-01", projects: tables.projects[0],
  }];
  await load();
  const manualProject = page.getByRole("checkbox", { name: "MANUAL 22-002", exact: true });
  assert.equal(await manualProject.isChecked(), false);
  assert.ok(await manualProject.locator("..").getByText("COI", { exact: true }).isVisible());
  await manualProject.click();
  await manualProject.locator("..").getByText("MAN / COI", { exact: true }).waitFor();
  assert.equal(assignmentWrites.at(-1).p_owned, true);
  await manualProject.click();
  await manualProject.locator("..").getByText("COI", { exact: true }).waitFor();
  assert.equal(assignmentWrites.at(-1).p_owned, false);
  assert.equal(tables.contractor_projects[0].active, true, "Removing manual ownership leaves imported membership effective");
  tables.contractor_projects[0].ownership_sources=["MYCOI","PROCORE"];
  await load();
  await manualProject.locator("..").getByText("COI / PRO",{exact:true}).waitFor();
  await manualProject.click();
  await manualProject.locator("..").getByText("MAN / COI / PRO",{exact:true}).waitFor();
  await manualProject.click();
  await manualProject.locator("..").getByText("COI / PRO",{exact:true}).waitFor();

  editor = false;
  await load();
  await readonly();
  tables.mycoi_vendor_mappings = [{ ...vendor, vendor_email: null, vendor_phone: null }];
  await load();
  assert.equal(await panel.getByText(/myCOI Vendor Email:|myCOI Vendor Phone:/).count(), 0);
  deniedTable = "mycoi_policies";
  await load();
  assert.match(await panel.getByRole("alert").textContent(), /Unable to load myCOI policies.*SYNTHETIC myCOI read denied/);
  assert.equal(await panel.getByRole("heading", { name: "Legacy / Manual Insurance" }).count(), 0);
  assert.equal(await panel.getByText("No myCOI vendor mapping has been established.", { exact: true }).count(), 0, "Failures must not masquerade as empty data");

  deniedTable = null;
  insuranceView = false;
  const beforeReads = mycoiReads;
  await load();
  assert.ok(await panel.getByText("You do not have permission to view insurance information.", { exact: true }).isVisible());
  assert.equal(mycoiReads, beforeReads, "No myCOI requests without insurance view permission");
  assert.deepEqual(errors, []);
  console.log("PASS: project-grouped read-only insurance, unchanged individual policies/dates/links, archived history, editor/viewer permissions and explicit errors; rendered MYCOI -> BOTH -> MYCOI manual retention without removing effective membership; no real database writes");
} finally {
  await context.close();
  await browser.close();
}
