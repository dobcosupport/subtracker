import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import * as XLSX from "xlsx";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "../worker/nj-pwc/node_modules/playwright");
const app = process.env.TEST_APP_URL || "http://localhost:3000";
assert.ok(["localhost", "127.0.0.1"].includes(new URL(app).hostname), "Use an intercepted local preview.");
const origin = new URL(fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8")
  .match(/^NEXT_PUBLIC_SUPABASE_URL\s*=\s*["']?([^"'\r\n]+)/m)[1].trim()).origin;
const user = { id: "00000000-0000-0000-0000-000000000001", email: "fixture@example.invalid",
  aud: "authenticated", app_metadata: {}, user_metadata: {} };
const companies = ["Alpha Construction", "Beta Builders", "Gamma Services"];
const contractors = companies.map((company_name, index) => ({
  id: index + 1, company_name, active: true, material_vendor_only: false, federal_tax_id: `00-000000${index + 1}`, state: "NJ",
}));
const compliance = contractors.flatMap((c, i) => [
  { contractor_id: c.id, company_name: c.company_name, contractor_active: true, compliance_record_id: c.id,
    compliance_type_id: 1, compliance_name: "NJ PWC", registration_number: `PWC-${c.id}`,
    expiration_date: new Date(Date.now() + (i === 1 ? -5 : i === 2 ? 20 : 100) * 86400000).toISOString().slice(0, 10), days_remaining: i === 1 ? -5 : i === 2 ? 20 : 100,
    calculated_status: i === 1 ? "Expired" : i === 2 ? "30 Day" : "Active" },
  { contractor_id: c.id, company_name: c.company_name, contractor_active: true, compliance_record_id: c.id + 10,
    compliance_type_id: 2, compliance_name: "NJ BRC", registration_number: i === 2 ? null : `BRC-${c.id}`,
    expiration_date: null, days_remaining: null, calculated_status: i === 2 ? "Missing Information" : "Active" },
]);
const template = { id: "00000000-0000-0000-0000-000000000002", name: "Shared FEIN export", description: "Synthetic fixture",
  category: "contractors", field_ids: ["contractor_name", "federal_tax_id", "data_warning"], default_format: "xlsx",
  default_scope: "all", configuration_version: 1, sort_configuration: { field: "contractor_name", direction: "desc" },
  filter_configuration: { state: "NJ" }, active: true, visibility: "shared", revision: 1, is_system: false };
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1536, height: 864 }, acceptDownloads: true });
const requests = [], errors = [];
let denied = false, failLoad = false, inaccessible = false, delayedExport = false, preferenceError = false, templateError = false;
let fullNavigation = false, expirationScenario = false, finalScenario = false;
let preferences = [], exportedIds = [];
await context.addInitScript(({ origin, user }) =>
  localStorage.setItem(`sb-${new URL(origin).hostname.split(".")[0]}-auth-token`, JSON.stringify({
    access_token: "synthetic-token", refresh_token: "synthetic-refresh", token_type: "bearer",
    expires_at: Math.floor(Date.now() / 1000) + 3600, user,
  })), { origin, user });
await context.route("**/*", async route => {
  const request = route.request(), url = new URL(request.url());
  if (url.origin === new URL(app).origin) {
    if (url.pathname === "/api/auth/session") return route.fulfill({ json: {
      profile: { ...user, name: "Synthetic User", role: fullNavigation ? "Review Fixture" : "Reports Reader", status: "Active", system_administrator: false },
      permissions: (fullNavigation ? ["dashboard", "contractors", "projects", "documents", "compliance", "followups",
        "communications_summary", "reports", "users", "roles", "company_merge", "imports", "audit", "compliance_sync", "settings"]
        : ["reports", "dashboard", "contractors"]).map(module => ({
        module, can_view: !denied || module !== "reports", can_manage: false, can_add: false, can_edit: false, can_delete: false,
      })),
    } });
    if (url.pathname === "/api/admin/bootstrap") return route.fulfill({ json: {} });
    assert.ok(!url.pathname.startsWith("/api/"), `Unexpected API: ${url.pathname}`);
    return route.continue();
  }
  assert.equal(url.origin, origin, "All external traffic must be intercepted.");
  if (url.pathname === "/auth/v1/user") return route.fulfill({ json: user });
  const table = url.pathname.split("/").at(-1);
  requests.push({ table, method: request.method(), query: url.search });
  if (table === "set_export_template_preference") {
    assert.equal(request.method(), "POST");
    const body = request.postDataJSON();
    assert.equal(body.p_template_id, template.id);
    if (preferenceError) return route.fulfill({ status: 403, json: { message: "Synthetic preference denied" } });
    preferences = [{ template_id: body.p_template_id, is_favorite: body.p_favorite, is_default: body.p_default }];
    return route.fulfill({ json: null });
  }
  assert.ok(["GET", "HEAD"].includes(request.method()), "No template management or business-data writes.");
  if (request.method() === "HEAD") return route.fulfill({ status: 200, headers: {
    "content-range": `*/${url.searchParams.get("active") === "eq.false" ? 0 : 3}`,
    "access-control-expose-headers": "content-range",
  } });
  if (table === "projects") {
    const projects = [
    { id: 11, project_number: "21-002", project_name: "School", status: "Active", public_works: true },
    { id: 12, project_number: "23-007", project_name: "Bridge", status: "Active", public_works: false },
    { id: 13, project_number: "25-900", project_name: "Complex", status: "Active", public_works: true },
    ];
    const selected = url.searchParams.get("id");
    return route.fulfill({ json: selected ? projects.find(project => `eq.${project.id}` === selected) ?? null : projects });
  }
  if (table === "contractor_compliance_status") return route.fulfill(failLoad
    ? { status: 403, json: { message: "Synthetic report denied" } } : { json: expirationScenario ? [
      ...compliance.map(row => row.contractor_id === 1 && row.compliance_name === "NJ PWC"
        ? { ...row, expiration_date: new Date().toISOString().slice(0, 10), days_remaining: 0, calculated_status: "Expired" } : row),
      { ...compliance[0], compliance_record_id: 101, compliance_name: "NY PWC",
        expiration_date: new Date(Date.now() - 86400000).toISOString().slice(0, 10), days_remaining: -1, calculated_status: "Expired" },
    ] : compliance });
  if (table === "export_templates") return route.fulfill(templateError
    ? { status: 503, json: { message: "Synthetic template unavailable" } } : { json: [template] });
  if (table === "export_template_user_preferences") return route.fulfill({ json: preferences });
  if (table === "contractors") {
    const ids = url.searchParams.get("id");
    if (ids) exportedIds.push(ids);
    if (delayedExport && ids) await new Promise(resolve => setTimeout(resolve, 1200));
    const selected = ids ? contractors.filter(c => ids.slice(4, -1).split(",").includes(String(c.id))) : contractors;
    return route.fulfill({ json: inaccessible && ids ? [] : selected });
  }
  if (table === "contractor_projects") {
    const assignments = [
    { id: 1, contractor_id: 1, project_id: 11, active: true, projects: { project_name: "School", project_number: "21-002", status: "Active" } },
    { id: 2, contractor_id: 2, project_id: 12, active: true, projects: { project_name: "Bridge", project_number: "23-007", status: "Active" } },
    { id: 3, contractor_id: 1, project_id: 12, active: true, projects: { project_name: "Bridge", project_number: "23-007", status: "Active" } },
    { id: 4, contractor_id: 1, project_id: 13, active: true, projects: { project_name: "Complex", project_number: "25-900", status: "Active" } },
    ];
    return route.fulfill({ json: assignments.filter(row => !url.searchParams.get("project_id") || url.searchParams.get("project_id") === `eq.${row.project_id}`) });
  }
  if (table === "contractor_followups") return route.fulfill({ json: [
    { id: 1, contractor_id: 1, followup_date: "2026-11-09", followup_method: "Email", subject: "Send renewal", status: "Open", notes: "Follow-up note" },
    { id: 2, contractor_id: 2, followup_date: "2026-11-08", followup_method: "Phone", subject: "Waiting for certificate", status: "Waiting Response", notes: "" },
  ] });
  if (table === "compliance_records" && url.searchParams.get("select")?.includes("registry_status")
    && !url.searchParams.get("select")?.includes("requires_expiration")) {
    const date = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    return route.fulfill({ json: contractors.flatMap(c => [
      { contractor_id: c.id, registration_number: c.id === 1 || c.id === 3 ? null : "BRC", expiration_date: null,
        registry_status: null, compliance_types: { compliance_name: "NJ BRC" } },
      { contractor_id: c.id, registration_number: "PWC", expiration_date: date,
        registry_status: null, compliance_types: { compliance_name: "NJ PWC" } },
    ]) });
  }
  if (table === "compliance_records") return route.fulfill({ json: [
    { id: 1, contractor_id: 1, registration_number: "A", expiration_date: "2027-12-01", compliance_types: { compliance_name: "NJ PWC", requires_expiration: true } },
    { id: 2, contractor_id: 1, registration_number: "B", expiration_date: "2027-12-01", compliance_types: { compliance_name: "NJ PWC", requires_expiration: true } },
  ] });
  if (table === "mycoi_policies" && finalScenario) return route.fulfill({ json: contractors.flatMap(c =>
    ["General Liability", "Workers Compensation"].map((policy_line, index) => ({
      id: c.id * 10 + index, contractor_id: c.id, policy_line,
      expiration_date: new Date(Date.now() + (c.id === 1 ? 30 : -10) * 86400000).toISOString().slice(0, 10),
      active: true, is_current: true, vendor: { contractor_id: c.id, active: true },
    }))) });
  assert.ok(["mycoi_policies", "contractor_tiered_subs"].includes(table), `Unexpected data source: ${table}`);
  return route.fulfill({ json: [] });
});
const page = await context.newPage();
page.on("pageerror", e => errors.push(e.message));
async function openReports() {
  await page.goto(`${app}/reports`);
  await page.getByRole("heading", { name: "Compliance Status", exact: true }).waitFor();
  await page.getByRole("link", { name: "Alpha Construction", exact: true }).waitFor();
}
async function custom() {
  await page.getByRole("button", { name: "Create Custom Export", exact: true }).click();
  await page.getByRole("dialog", { name: "Reports Export" }).getByRole("button", { name: "Create Custom Export", exact: true }).click();
  return page.getByRole("dialog", { name: "Custom Export", exact: true });
}
async function downloadRows(action) {
  const pending = page.waitForEvent("download");
  await action();
  const file = await pending;
  const data = fs.readFileSync(await file.path());
  return { file, data, rows: file.suggestedFilename().endsWith(".pdf") ? null
    : XLSX.utils.sheet_to_json(XLSX.read(data, { type: "buffer" }).Sheets[XLSX.read(data, { type: "buffer" }).SheetNames[0]]) };
}
try {
  await openReports();
  assert.equal(await page.locator("#app-navigation [aria-current=page]").innerText(), "Reports");
  assert.equal(await page.locator("header").count(), 1);
  assert.equal(await page.getByPlaceholder("Search active projects or assigned contractors").count(), 0);
  assert.equal(await page.locator("[data-company-id]").count(), 3);
  assert.equal(await page.locator("tbody").count(), 0, "Compliance uses the requirement matrix, not the legacy table.");
  assert.match(await page.getByRole("region", { name: "Compliance summary" }).innerText(), /3\nContractors/);
  const alphaMatrix = page.locator('[data-company-id="1"]');
  for (const requirement of ["FEIN (Taxpayer ID)", "NJ BRC", "NJ PWC"])
    assert.equal(await alphaMatrix.getByText(requirement, { exact: true }).count(), 1);
  assert.match(await alphaMatrix.innerText(), /Current/);
  assert.match(await alphaMatrix.innerText(), /Missing/);
  assert.match(await alphaMatrix.innerText(), /0-30 Days/);
  await page.getByRole("button", { name: "Collapse Alpha Construction", exact: true }).click();
  assert.equal(await alphaMatrix.getByText("NJ PWC", { exact: true }).count(), 0);
  await page.getByRole("button", { name: "Expand Alpha Construction", exact: true }).click();
  assert.equal(await page.getByRole("link", { name: "Alpha Construction", exact: true }).getAttribute("href"), "/contractors/1");
  for (const [label, rows] of [["Missing Information", 7], ["Expired Items", 1], ["Upcoming Expirations", 1],
    ["Project Compliance", 3], ["Insurance", 6], ["Follow-Up", 2]]) {
    await page.getByRole("tab", { name: label, exact: true }).click();
    assert.equal(await page.locator("tbody tr").count(), rows, label);
    await page.getByRole("button", { name: "Export", exact: true }).click();
    const result = await downloadRows(() => page.getByRole("menuitem", { name: "Export to Excel (.xlsx)", exact: true }).click());
    assert.equal(result.rows.length, rows, `${label} exports its own rows`);
    const headers = await page.locator("thead th").allTextContents();
    const sheet = XLSX.read(result.data, { type: "buffer" });
    assert.deepEqual(XLSX.utils.sheet_to_json(sheet.Sheets[sheet.SheetNames[0]], { header: 1 })[0],
      headers.map(header => header.replace(/ [\^v]$/, "")), `${label} exports its own columns`);
  }
  await page.getByRole("tab", { name: "Missing Information", exact: true }).click();
  await page.getByRole("heading", { name: "Missing Information", exact: true }).waitFor();
  assert.deepEqual((await page.locator("thead th").allTextContents()).map(text => text.replace(/ [\^v]$/, "")),
    ["Company Name", "Missing Item", "Status", "Assigned Projects"]);
  const missingAlpha = page.locator("tbody tr").filter({ hasText: "Alpha Construction" });
  assert.match(await missingAlpha.first().innerText(), /21-002.*23-007.*25-900/);
  assert.equal(await missingAlpha.first().evaluate(row => getComputedStyle(row).backgroundColor), "rgb(249, 202, 207)");
  await page.getByRole("combobox", { name: "Filter by project" }).selectOption("11");
  await page.getByRole("button", { name: "Export", exact: true }).waitFor({ state: "visible" });
  await page.waitForFunction(() => !Array.from(document.querySelectorAll("button")).find(b => b.textContent.trim() === "Export ▾")?.disabled);
  await page.getByRole("link", { name: "Alpha Construction", exact: true }).first().waitFor();
  assert.equal(await page.getByRole("link", { name: "Beta Builders", exact: true }).count(), 0);
  assert.doesNotMatch(await page.locator("tbody").innerText(), /23-007|25-900|Bridge|Complex/);
  for (const label of ["Missing Information", "Expired Items", "Upcoming Expirations", "Project Compliance", "Insurance", "Follow-Up", "Compliance Status"]) {
    await page.getByRole("tab", { name: label, exact: true }).click();
    assert.equal(await page.getByRole("combobox", { name: "Filter by project" }).inputValue(), "11", `${label} retains project ID.`);
  }
  await page.getByRole("tab", { name: "Missing Information", exact: true }).click();
  await page.getByRole("searchbox", { name: "Search report" }).fill("General Liability");
  await page.getByRole("combobox", { name: "Filter by status" }).selectOption("Missing Information");
  for (const format of ["CSV (.csv)", "Excel (.xlsx)", "PDF (.pdf)"]) {
    const result = await downloadRows(async () => {
      await page.getByRole("button", { name: "Export", exact: true }).click();
      await page.getByRole("menuitem", { name: `Export to ${format}`, exact: true }).click();
    });
    if (result.rows) {
      assert.equal(result.rows.length, 1);
      assert.equal(result.rows[0]["Company Name"], "Alpha Construction");
      assert.equal(result.rows[0]["Missing Item"], "General Liability");
      assert.equal(result.rows[0]["Assigned Projects"], "21-002 - School");
      assert.equal(result.rows[0]["Report Project"], "21-002 - School");
    } else {
      const pdf = result.data.toString("latin1");
      assert.ok(pdf.includes("SubTracker / Missing Information / 21-002 - School"));
      assert.ok(pdf.includes("General Liability") && pdf.includes("Alpha Construction") && pdf.includes("Page 1 of 1"));
      assert.match(pdf, /\/MediaBox \[0 0 792\. 612\.\]/);
    }
    assert.doesNotMatch(result.rows ? JSON.stringify(result.rows) : result.data.toString("latin1"), /Beta Builders|23-007|25-900|Bridge|Complex/);
  }
  await page.getByRole("searchbox", { name: "Search report" }).fill("");
  await page.getByRole("combobox", { name: "Filter by project" }).selectOption("All projects");
  assert.match(await missingAlpha.first().innerText(), /21-002.*23-007.*25-900/, "All Projects restores assignment presentation.");
  await page.getByRole("tab", { name: "Compliance Status", exact: true }).click();
  await page.getByRole("button", { name: "Sort by Company Name" }).click();
  assert.match(await page.locator("[data-company-id]").first().innerText(), /Gamma Services/);
  await page.getByRole("button", { name: "Sort by Company Name" }).click();
  await page.getByRole("combobox", { name: "Filter by status" }).selectOption("Missing");
  assert.equal(await page.locator("[data-company-id]").count(), 2);
  assert.equal(await page.getByRole("option", { name: "21-002 - School", exact: true }).getAttribute("value"), "11");
  assert.equal(await page.getByRole("option", { name: "23-007 - Bridge", exact: true }).getAttribute("value"), "12");
  const allProjectRow = page.locator("tbody tr").filter({ hasText: "Alpha Construction" });
  await page.getByRole("combobox", { name: "Filter by project" }).selectOption("11");
  await page.getByRole("button", { name: "Collapse Alpha Construction", exact: true }).waitFor();
  assert.equal(await page.locator("[data-company-id]").count(), 1);
  assert.equal(await page.getByRole("link", { name: "Beta Builders", exact: true }).count(), 0);
  assert.doesNotMatch(await alphaMatrix.innerText(), /21-002|23-007|25-900|School|Bridge|Complex/);
  assert.equal(await page.getByRole("button", { name: "Sort by Assigned Projects" }).count(), 0);
  assert.equal(await page.locator("main strong").filter({ hasText: /^21-002 - School$/ }).count(), 1);
  const projectExport = await downloadRows(async () => {
    await page.getByRole("button", { name: "Export", exact: true }).click();
    await page.getByRole("menuitem", { name: "Export to CSV (.csv)", exact: true }).click();
  });
  assert.equal(projectExport.rows.length, 3);
  assert.deepEqual(projectExport.rows.map(row => row.Requirement), ["FEIN", "NJ BRC", "NJ PWC"]);
  assert.equal(projectExport.rows[0]["Company Name"], "Alpha Construction");
  assert.equal(projectExport.rows[0]["Report Project"], "21-002 - School");
  assert.equal(projectExport.rows[0]["Assigned Projects"], undefined);
  assert.doesNotMatch(JSON.stringify(projectExport.rows), /23-007|25-900|Bridge|Complex|Beta Builders/);
  for (const label of ["Export to Excel (.xlsx)", "Export to PDF (.pdf)"]) {
    const result = await downloadRows(async () => {
      await page.getByRole("button", { name: "Export", exact: true }).click();
      await page.getByRole("menuitem", { name: label, exact: true }).click();
    });
    if (result.rows) {
      assert.equal(result.rows[0]["Report Project"], "21-002 - School");
      assert.doesNotMatch(JSON.stringify(result.rows), /23-007|25-900|Assigned Projects/);
    } else {
      assert.doesNotMatch(result.data.toString("latin1"), /23-007|25-900|Assigned Projects/);
      assert.match(result.data.toString("latin1"), /21-002 - School/);
      const pdf = result.data.toString("latin1");
      assert.equal((pdf.match(/SubTracker \/ Compliance Status \/ 21-002 - School/g) ?? []).length, 1, "Project in running header.");
      for (const label of ["SubTracker", "Compliance Status", "Fully Compliant", "Missing Requirements",
        "Company Name", "Status", "Expiration Date", "FEIN", "NJ BRC", "NJ PWC", "Page 1 of 1"])
        assert.ok(pdf.includes(label), `Compliance PDF includes ${label}`);
      assert.doesNotMatch(pdf, /\(Issues\)/);
    }
  }
  await page.getByRole("searchbox", { name: "Search report" }).fill("23-007");
  assert.equal(await page.locator("[data-company-id]").count(), 0, "Hidden unrelated assignments cannot influence scoped search.");
  await page.getByRole("searchbox", { name: "Search report" }).fill("");
  await page.getByRole("tab", { name: "Project Compliance", exact: true }).click();
  assert.equal(await page.locator("tbody tr").count(), 1);
  assert.match(await allProjectRow.innerText(), /Selected project/);
  assert.doesNotMatch(await allProjectRow.innerText(), /23-007|25-900|Bridge|Complex/);
  const scopedAssignments = await downloadRows(async () => {
    await page.getByRole("button", { name: "Export", exact: true }).click();
    await page.getByRole("menuitem", { name: "Export to CSV (.csv)", exact: true }).click();
  });
  assert.equal(scopedAssignments.rows[0]["Assigned Projects"], "21-002 - School");
  assert.doesNotMatch(JSON.stringify(scopedAssignments.rows), /23-007|25-900/);
  await page.getByRole("tab", { name: "Compliance Status", exact: true }).click();
  await page.getByRole("combobox", { name: "Filter by status" }).selectOption("Missing");
  await page.getByRole("button", { name: "Create Custom Export", exact: true }).click();
  await page.getByRole("dialog", { name: "Reports Export" }).getByText(/Project: 21-002 - School \(ID 11\)/).waitFor();
  await page.getByRole("dialog", { name: "Reports Export" }).getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("combobox", { name: "Filter by project" }).selectOption("All projects");
  await page.getByRole("tab", { name: "Project Compliance", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "Sort by Assigned Projects" }).count(), 1);
  assert.match(await allProjectRow.innerText(), /21-002, 23-007, 25-900/, "Full assignment data restored without refetch or mutation.");
  await page.getByRole("tab", { name: "Compliance Status", exact: true }).click();
  await page.getByRole("combobox", { name: "Filter by status" }).selectOption("Missing");
  await page.getByRole("searchbox", { name: "Search report" }).fill("Alpha");
  for (const [label, extension] of [["Export to CSV (.csv)", ".csv"], ["Export to Excel (.xlsx)", ".xlsx"], ["Export to PDF (.pdf)", ".pdf"]]) {
    await page.getByRole("button", { name: "Export", exact: true }).click();
    const result = await downloadRows(() => page.getByRole("menuitem", { name: label, exact: true }).click());
    assert.ok(result.file.suggestedFilename().endsWith(extension));
    if (result.rows) {
      assert.equal(result.rows.length, 3);
      assert.equal(result.rows[0]["Company Name"], "Alpha Construction");
      const sheet = XLSX.read(result.data, { type: "buffer" });
      assert.deepEqual(XLSX.utils.sheet_to_json(sheet.Sheets[sheet.SheetNames[0]], { header: 1 })[0],
        ["Company Name", "Requirement", "Status", "Expiration Date", "Details"]);
    } else assert.equal(result.data.subarray(0, 4).toString(), "%PDF");
  }
  exportedIds = [];
  let dialog = await custom();
  assert.equal(await dialog.getByRole("radio", { name: "Current Report Results", exact: true }).isChecked(), true);
  assert.match(await dialog.innerText(), /Compliance Status; Status: Missing; Project: All projects; Search: "Alpha"/);
  await dialog.getByRole("button", { name: "Select All", exact: true }).click();
  assert.equal(await dialog.getByRole("checkbox").count(), 38);
  assert.equal(await dialog.getByRole("checkbox", { name: "Taxpayer ID (FEIN)", exact: true }).isChecked(), true);
  await dialog.getByRole("button", { name: "Clear All", exact: true }).click();
  await dialog.getByRole("checkbox", { name: "Contractor Name", exact: true }).check();
  await dialog.getByRole("checkbox", { name: "Taxpayer ID (FEIN)", exact: true }).check();
  await dialog.getByRole("button", { name: "Export", exact: true }).click();
  await dialog.getByRole("button", { name: "Download without warnings" }).waitFor();
  await dialog.getByRole("button", { name: "Back to field selection" }).click();
  await dialog.getByRole("checkbox", { name: "Data Warning", exact: true }).check();
  const fein = await downloadRows(() => dialog.getByRole("button", { name: "Export", exact: true }).click());
  assert.equal(fein.rows.length, 1);
  assert.equal(fein.rows[0]["Taxpayer ID (FEIN)"], "00-0000001");
  assert.deepEqual(exportedIds, ["in.(1)", "in.(1)"], "Exact report population; no all-contractors fallback.");
  await dialog.getByRole("radio", { name: "CSV (.csv)", exact: true }).check();
  await dialog.getByRole("checkbox", { name: "Data Warning", exact: true }).uncheck();
  await dialog.getByRole("button", { name: "Export", exact: true }).click();
  const confirmed = await downloadRows(() => dialog.getByRole("button", { name: "Download without warnings" }).click());
  assert.ok(confirmed.file.suggestedFilename().endsWith(".csv"));
  assert.equal(confirmed.rows.length, 1);
  assert.equal(confirmed.rows[0]["Data Warning"], undefined);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  let host = page.getByRole("dialog", { name: "Reports Export" });
  assert.equal(await host.getByRole("button", { name: /^(Edit|Delete|New Template|Save)/ }).count(), 0);
  await host.getByRole("button", { name: "Favorite", exact: true }).click();
  await host.getByRole("button", { name: "Unfavorite", exact: true }).waitFor();
  await host.getByRole("button", { name: "Set as default", exact: true }).click();
  await host.getByRole("button", { name: "Clear default", exact: true }).waitFor();
  preferenceError = true;
  await host.getByRole("button", { name: "Unfavorite", exact: true }).click();
  await host.getByRole("alert").filter({ hasText: "Synthetic preference denied" }).waitFor();
  preferenceError = false;
  await host.getByRole("button", { name: "Review settings", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Custom Export", exact: true });
  assert.equal(await dialog.getByRole("radio", { name: "Current Report Results", exact: true }).isChecked(), true,
    "An All Contractors template cannot silently discard scoped IDs.");
  const saved = await downloadRows(() => dialog.getByRole("button", { name: "Export", exact: true }).click());
  assert.equal(saved.rows.length, 1);
  await dialog.getByRole("radio", { name: "All Contractors", exact: true }).check();
  const all = await downloadRows(() => dialog.getByRole("button", { name: "Export", exact: true }).click());
  assert.equal(all.rows.length, 3, "All Contractors is available by explicit choice.");
  assert.equal(all.rows[0]["Contractor Name"], "Gamma Services", "Template sort is preserved.");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  inaccessible = true;
  await host.getByRole("button", { name: "Run", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Custom Export", exact: true });
  await dialog.getByRole("alert").filter({ hasText: "no longer accessible" }).waitFor();
  assert.equal(await dialog.getByRole("radio", { name: "Current Report Results", exact: true }).isChecked(), true);
  inaccessible = false;
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  delayedExport = true;
  await host.getByRole("button", { name: "Run", exact: true }).click();
  await page.getByRole("button", { name: "Exporting...", exact: true }).waitFor();
  await page.getByRole("dialog", { name: "Custom Export", exact: true }).getByRole("button", { name: "Cancel", exact: true }).click();
  delayedExport = false;
  await host.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("searchbox", { name: "Search report" }).fill("No matches");
  dialog = await custom();
  await dialog.getByRole("button", { name: "Export", exact: true }).click();
  await dialog.getByRole("alert").filter({ hasText: "no contractors in this scope" }).waitFor();
  assert.equal(await dialog.getByRole("radio", { name: "Current Report Results", exact: true }).isChecked(), true);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await host.getByRole("button", { name: "Cancel", exact: true }).click();
  templateError = true;
  await page.getByRole("button", { name: "Create Custom Export", exact: true }).click();
  await host.getByRole("alert").filter({ hasText: "Synthetic template unavailable" }).waitFor();
  templateError = false;
  await host.getByRole("button", { name: "Refresh templates" }).click();
  await host.getByRole("button", { name: "Run", exact: true }).waitFor();
  await host.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("searchbox", { name: "Search report" }).fill("");
  expirationScenario = true;
  await openReports();
  await page.getByRole("combobox", { name: "Filter by project" }).selectOption("11");
  for (const [label, expectedItem, expectedDays, expectedColor, headers] of [
    ["Missing Information", "General Liability", null, "rgb(249, 202, 207)", ["Company Name", "Missing Item", "Status", "Assigned Projects"]],
    ["Expired Items", "NY PWC", -1, "rgb(249, 202, 207)", ["Company Name", "Expired Item", "Expiration Date", "Days Remaining", "Assigned Projects"]],
    ["Upcoming Expirations", "NJ PWC", 0, "rgb(255, 222, 222)", ["Company Name", "Expiring Item", "Expiration Date", "Days Remaining", "Status", "Assigned Projects"]],
  ]) {
    await page.getByRole("tab", { name: label, exact: true }).click();
    assert.equal(await page.getByRole("combobox", { name: "Filter by project" }).inputValue(), "11");
    await page.getByRole("heading", { name: label, exact: true }).waitFor();
    await page.getByRole("searchbox", { name: "Search report" }).fill(expectedItem);
    await page.locator("tbody tr").first().waitFor();
    assert.equal(await page.locator("tbody tr").count(), 1);
    assert.deepEqual((await page.locator("thead th").allTextContents()).map(text => text.replace(/ [\^v]$/, "")), headers);
    assert.doesNotMatch(await page.locator("tbody").innerText(), /Beta Builders|Gamma Services|23-007|25-900/);
    assert.equal(await page.locator("tbody tr").first().evaluate(row => getComputedStyle(row).backgroundColor), expectedColor);
    for (const format of ["CSV (.csv)", "Excel (.xlsx)", "PDF (.pdf)"]) {
      const result = await downloadRows(async () => {
        await page.getByRole("button", { name: "Export", exact: true }).click();
        await page.getByRole("menuitem", { name: `Export to ${format}`, exact: true }).click();
      });
      if (result.rows) {
        assert.equal(result.rows.length, 1);
        assert.equal(result.rows[0]["Company Name"], "Alpha Construction");
        assert.equal(result.rows[0]["Assigned Projects"], "21-002 - School");
        if (expectedDays !== null) assert.equal(result.rows[0]["Days Remaining"], expectedDays);
        if (expectedDays === 0) assert.equal(result.rows[0].Status, "0-30 Days", "Today is upcoming, not expired.");
      } else {
        const pdf = result.data.toString("latin1");
        assert.ok(pdf.includes(`SubTracker / ${label} / 21-002 - School`));
        const printedText = [...pdf.matchAll(/\(((?:\\.|[^\\)])*)\) Tj/g)].map(match => match[1]).join(" ");
        for (const header of headers) assert.ok(printedText.includes(header), header);
        assert.match(pdf, /\/MediaBox \[0 0 792\. 612\.\]/);
      }
      assert.doesNotMatch(result.rows ? JSON.stringify(result.rows) : result.data.toString("latin1"), /Beta Builders|Gamma Services|23-007|25-900/);
    }
    await page.getByRole("searchbox", { name: "Search report" }).fill("");
  }
  await page.getByRole("combobox", { name: "Filter by project" }).selectOption("12");
  await page.getByRole("link", { name: "Alpha Construction", exact: true }).waitFor({ state: "hidden" });
  assert.equal(await page.locator("tbody tr").count(), 0, "Another Public Works assignment cannot contaminate selected private project NJ PWC.");
  await page.getByRole("combobox", { name: "Filter by project" }).selectOption("All projects");
  assert.match(await page.locator("tbody").innerText(), /Alpha Construction/);
  assert.match(await page.locator("tbody").innerText(), /23-007.*25-900/);
  expirationScenario = false;
  finalScenario = true;
  await openReports();
  await page.getByRole("combobox", { name: "Filter by project" }).selectOption("11");
  for (const [label, expectedHeaders] of [
    ["Project Compliance", ["Contractor", "Status", "Assigned Projects", "Compliance Issues", "Insurance Issues"]],
    ["Insurance", ["Company Name", "Insurance Item", "Status", "Expiration Date", "Days Remaining", "Assigned Projects"]],
  ]) {
    await page.getByRole("tab", { name: label, exact: true }).click();
    await page.getByRole("heading", { name: label, exact: true }).waitFor();
    await page.getByRole("link", { name: "Alpha Construction", exact: true }).first().waitFor();
    assert.equal(await page.getByRole("combobox", { name: "Filter by project" }).inputValue(), "11");
    assert.deepEqual((await page.locator("thead th").allTextContents()).map(text => text.replace(/ [\^v]$/, "")), expectedHeaders);
    assert.doesNotMatch(await page.locator("tbody").innerText(), /Beta Builders|Gamma Services|23-007|25-900|Bridge|Complex/);
    if (label === "Project Compliance") {
      assert.equal(await page.locator("tbody tr").count(), 1);
      assert.match(await page.locator("tbody").innerText(), /NJ BRC: Missing.*NJ PWC: 0-30 Days/);
      assert.match(await page.locator("tbody").innerText(), /General Liability: 0-30 Days/);
      assert.doesNotMatch(await page.locator("tbody").innerText(), /21-002/);
    } else {
      assert.equal(await page.locator("tbody tr").count(), 2);
      assert.match(await page.locator("tbody").innerText(), /0-30 Days/);
      assert.equal(await page.locator("tbody tr").first().evaluate(row => getComputedStyle(row).backgroundColor), "rgb(255, 222, 222)");
    }
    await page.getByRole("searchbox", { name: "Search report" }).fill(label === "Insurance" ? "General Liability" : "Alpha");
    await page.getByRole("combobox", { name: "Filter by status" }).selectOption(label === "Insurance" ? "0-30 Days" : "Non-Compliant");
    for (const format of ["CSV (.csv)", "Excel (.xlsx)", "PDF (.pdf)"]) {
      const result = await downloadRows(async () => {
        await page.getByRole("button", { name: "Export", exact: true }).click();
        await page.getByRole("menuitem", { name: `Export to ${format}`, exact: true }).click();
      });
      if (result.rows) {
        assert.equal(result.rows.length, 1);
        assert.equal(result.rows[0][label === "Insurance" ? "Company Name" : "Contractor"], "Alpha Construction");
        assert.equal(result.rows[0]["Report Project"], "21-002 - School");
        assert.equal(result.rows[0]["Assigned Projects"], "21-002 - School");
        if (label === "Insurance") assert.equal(result.rows[0]["Days Remaining"], 30);
      } else {
        const pdf = result.data.toString("latin1");
        assert.ok(pdf.includes(`SubTracker / ${label} / 21-002 - School`));
        assert.match(pdf, /\/MediaBox \[0 0 792\. 612\.\]/);
        const text = [...pdf.matchAll(/\(((?:\\.|[^\\)])*)\) Tj/g)].map(match => match[1]).join(" ");
        for (const header of expectedHeaders) assert.ok(text.includes(header), header);
      }
      assert.doesNotMatch(result.rows ? JSON.stringify(result.rows) : result.data.toString("latin1"), /Beta Builders|Gamma Services|23-007|25-900|Bridge|Complex/);
    }
    await page.getByRole("searchbox", { name: "Search report" }).fill("");
    await page.getByRole("combobox", { name: "Filter by status" }).selectOption("All statuses");
  }
  await page.getByRole("tab", { name: "Project Compliance", exact: true }).click();
  await page.getByRole("combobox", { name: "Filter by project" }).selectOption("12");
  await page.getByRole("link", { name: "Beta Builders", exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector("tbody")?.textContent.includes("23-007") === false
    && !document.querySelector("tbody")?.textContent.includes("NJ PWC"));
  assert.doesNotMatch(await page.locator("tbody").innerText(), /NJ PWC|21-002|25-900/);
  await page.getByRole("combobox", { name: "Filter by project" }).selectOption("11");
  await page.getByRole("tab", { name: "Follow-Up", exact: true }).click();
  assert.equal(await page.getByRole("combobox", { name: "Filter by project" }).inputValue(), "11");
  await page.getByText("Project-specific Follow-Up unavailable", { exact: true }).waitFor();
  assert.equal(await page.locator("tbody tr").count(), 0, "Contractor membership does not establish Follow-Up ownership.");
  assert.equal(await page.getByRole("button", { name: "Create Custom Export", exact: true }).isDisabled(), true);
  await page.getByRole("button", { name: "Export", exact: true }).click();
  for (const format of ["Excel (.xlsx)", "CSV (.csv)"]) assert.equal(
    await page.getByRole("menuitem", { name: `Export to ${format}`, exact: true }).isDisabled(), true);
  const notice = await downloadRows(() => page.getByRole("menuitem", { name: "Export to PDF (.pdf)", exact: true }).click());
  assert.match(notice.data.toString("latin1"), /SubTracker \/ Follow-Up \/ 21-002 - School/);
  assert.match(notice.data.toString("latin1"), /Project-specific Follow-Up unavailable/);
  assert.doesNotMatch(notice.data.toString("latin1"), /Send renewal|Waiting for certificate|Beta Builders/);
  await page.getByRole("combobox", { name: "Filter by project" }).selectOption("All projects");
  assert.equal(await page.locator("tbody tr").count(), 2);
  assert.deepEqual((await page.locator("thead th").allTextContents()).map(text => text.replace(/ [\^v]$/, "")),
    ["Company Name", "Status", "Follow-Up Date", "Last Follow-Up", "Method", "Subject", "Notes"]);
  await page.getByRole("searchbox", { name: "Search report" }).fill("Send renewal");
  await page.getByRole("combobox", { name: "Filter by status" }).selectOption("Open");
  for (const format of ["CSV (.csv)", "Excel (.xlsx)", "PDF (.pdf)"]) {
    const result = await downloadRows(async () => {
      await page.getByRole("button", { name: "Export", exact: true }).click();
      await page.getByRole("menuitem", { name: `Export to ${format}`, exact: true }).click();
    });
    if (result.rows) {
      assert.equal(result.rows.length, 1);
      assert.equal(result.rows[0].Subject, "Send renewal");
      assert.equal(result.rows[0].Notes, "Follow-up note");
      assert.equal(result.rows[0]["Report Project"], undefined);
    } else assert.match(result.data.toString("latin1"), /SubTracker \/ Follow-Up \/ All Projects/);
  }
  await page.getByRole("searchbox", { name: "Search report" }).fill("");
  for (const label of ["Project Compliance", "Insurance"]) {
    await page.getByRole("tab", { name: label, exact: true }).click();
    assert.match(await page.locator("tbody").innerText(), /Beta Builders/);
    assert.match(await page.locator("tbody").innerText(), /21-002, 23-007, 25-900/);
  }
  finalScenario = false;
  fullNavigation = true;
  await openReports();
  assert.equal(await page.locator("#app-navigation").getByText("Administration", { exact: true }).count(), 1);
  const sizes = [[2560, 1440], [1920, 1080], [1536, 864], [1366, 768], [1280, 800], [1024, 768], [768, 1024], [390, 844], [320, 640]];
  if (process.env.REPORTS_SCREENSHOT_DIR) fs.mkdirSync(process.env.REPORTS_SCREENSHOT_DIR, { recursive: true });
  for (const [width, height] of sizes) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `No page overflow at ${width}`);
    const expandedCompany = page.locator('[data-company-id="1"]');
    await page.getByRole("button", { name: "Collapse Alpha Construction", exact: true }).click();
    assert.equal(await expandedCompany.getByText("NJ PWC", { exact: true }).count(), 0, `Company collapses at ${width}`);
    await page.getByRole("button", { name: "Expand Alpha Construction", exact: true }).click();
    assert.equal(await expandedCompany.getByText("NJ PWC", { exact: true }).count(), 1, `Separate requirements expand at ${width}`);
    assert.equal(await page.locator("header").evaluate(e => e.getBoundingClientRect().right), width);
    for (const control of [page.getByRole("button", { name: "Export", exact: true }), page.getByRole("button", { name: "Create Custom Export", exact: true }),
      page.getByRole("searchbox", { name: "Search report" }), page.getByRole("combobox", { name: "Filter by status" }),
      page.getByRole("combobox", { name: "Filter by project" })]) {
      const box = await control.boundingBox();
      assert.ok(box && box.x >= 0 && box.x + box.width <= width + 1, `Visible control fits ${width}`);
    }
    const controls = await page.locator("main label").evaluateAll(elements => elements.map(e => e.getBoundingClientRect().toJSON()));
    for (let i = 0; i < controls.length; i++) for (let j = i + 1; j < controls.length; j++)
      assert.ok(controls[i].right <= controls[j].left || controls[j].right <= controls[i].left
        || controls[i].bottom <= controls[j].top || controls[j].bottom <= controls[i].top, "Filters do not overlap.");
    if (process.env.REPORTS_SCREENSHOT_DIR && [2560, 1920, 1024, 390].includes(width)) {
      await page.getByRole("heading", { name: "Compliance Status", exact: true }).click();
      await page.screenshot({ path: `${process.env.REPORTS_SCREENSHOT_DIR}\\reports-${width}x${height}.png`, fullPage: true, animations: "disabled" });
    }
    await page.getByRole("button", { name: "Export", exact: true }).click();
    const menuBox = await page.getByRole("menu").boundingBox();
    assert.ok(menuBox.x >= 0 && menuBox.x + menuBox.width <= width + 1, `Export menu fits ${width}`);
    await page.keyboard.press("Escape");
    if ([1024, 390, 320].includes(width)) {
      dialog = await custom();
      const bounds = await dialog.boundingBox();
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1, `Custom Export fits width ${width}`);
      for (const control of [dialog.getByRole("button", { name: "Export", exact: true }), dialog.getByRole("button", { name: "Cancel", exact: true }),
        dialog.getByRole("searchbox", { name: "Search fields by label" })]) {
        const box = await control.boundingBox();
        assert.ok(box && box.y >= 0 && box.y + box.height <= height + 1, `Custom Export controls fit ${width}x${height}: ${JSON.stringify(box)}`);
      }
      if (process.env.REPORTS_SCREENSHOT_DIR)
        await page.screenshot({ path: `${process.env.REPORTS_SCREENSHOT_DIR}\\custom-export-${width}x${height}.png`, animations: "disabled" });
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await host.getByRole("button", { name: "Cancel", exact: true }).click();
    }
  }
  await page.getByRole("button", { name: "Menu", exact: true }).click();
  await page.locator("#app-navigation").getByRole("link", { name: "Reports", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "Menu", exact: true }).getAttribute("aria-expanded"), "false");
  failLoad = true;
  await page.reload();
  await page.getByRole("alert").filter({ hasText: "Synthetic report denied" }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Create Custom Export", exact: true }).isDisabled(), true);
  denied = true;
  await page.reload();
  await page.getByRole("heading", { name: "Access Denied" }).waitFor();
  assert.deepEqual(errors, []);
  console.log("PASS Reports: seven categories, filters/search/sort/drill-down, CSV/XLSX/PDF, 38 fields/FEIN, scoped custom/template exports, explicit All Contractors, preferences, warnings, cancellation/errors, permissions and nine responsive sizes.");
} finally {
  await context.close();
  await browser.close();
}
