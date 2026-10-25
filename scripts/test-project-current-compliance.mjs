import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
import ts from "typescript";
import * as XLSX from "xlsx";

const require = createRequire(import.meta.url);
const project = { id: 13, project_number: "25-004", project_name: "Project Compliance Fixture",
  status: "Active", created_at: "2026-01-01", updated_at: "2026-01-01" };
const contractor = { id: 115, company_name: "DoveLin Enterprises, Inc.", active: true, nj_pwc_number: "703084" };
const type = { id: 6, compliance_name: "NJ PWC", requires_expiration: true, active: true };
const credential = (id, changes = {}) => ({
  id, contractor_id: 115, compliance_type_id: 6, registration_number: "703084",
  effective_date: "2026-10-22", expiration_date: "2028-10-21", active: true, is_current: true,
  created_at: "2026-10-22", compliance_types: type, registry_status: "OK", ...changes,
});
const records = [
  credential(86, { active: false, is_current: false, effective_date: "2024-10-22",
    expiration_date: "2026-10-21", created_at: "2026-10-05" }),
  credential(303),
];
const assignment = { id: 1383, contractor_id: 115, project_id: 13, active: true, assigned_date: "2026-10-23",
  ownership_sources: ["MANUAL"], manual_owned: true, mycoi_owned: false,
  contractors: contractor, projects: project };
let tables = { projects: [project], contractors: [contractor], contractor_projects: [assignment],
  compliance_records: records, compliance_types: [type], activity_log: [], documents: [] };
let failure = null;
const reads = [];
const supabase = { from(table) {
  let start = 0, end = Infinity;
  const filters = [];
  const query = {
    select() { return query; },
    eq(key, value) { filters.push(row => row[key] === value); return query; },
    in(key, values) { filters.push(row => values.includes(row[key])); return query; },
    order() { return query; },
    range(a, b) { start = a; end = b; return query; },
    returns() { return query; },
    single() { return Promise.resolve({ data: project, error: null }); },
    then(resolve, reject) {
      reads.push({ table, start });
      return Promise.resolve({
        data: failure?.table === table && failure.start === start ? null
          : (tables[table] ?? []).filter(row => filters.every(filter => filter(row))).slice(start, end + 1),
        error: failure?.table === table && failure.start === start ? { message: "Fixture read denied" } : null,
      }).then(resolve, reject);
    },
  };
  return query;
} };
function load(file, dependencies) {
  const result = { exports: {} };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { module: result, exports: result.exports, Date, Blob,
    require: id => dependencies[id] ?? require(id) });
  return result.exports;
}
const compliance = load("services/compliance.ts", { "@/lib/supabase": { supabase } });
const shared = load("services/project-compliance.ts", {});
const exports = load("services/project-export.ts", { "@/lib/supabase": { supabase },
  "@/services/compliance": compliance, "@/services/project-compliance": shared });
const sections = await exports.loadProjectExport(13);
const current = sections.find(section => section.name === "Current Compliance");
assert.equal(current.rows.length, 1);
assert.deepEqual(JSON.parse(JSON.stringify(current.rows[0])), {
  "Compliance Type": "NJ PWC", Contractor: contractor.company_name, "Registration Number": "703084",
  "Effective Date": "2026-10-22", "Expiration Date": "2028-10-21", "Current Status": "Active",
});
const history = sections.find(section => section.name === "Compliance History");
assert.equal(history.rows.length, 2);
assert.equal(history.rows.find(row => row["Expiration Date"] === "2026-10-21")["Record Status"], "Archived (Expired)");
const card = (await compliance.getComplianceHistoryForContractor(115)).data.filter(record => record.active);
assert.equal(card.length, 1);
assert.equal(card[0].id, 303);
assert.equal(card[0].expiration_date, current.rows[0]["Expiration Date"]);
assert.equal(card[0].calculated_status, current.rows[0]["Current Status"]);
const pdfText = Buffer.from(await exports.projectExportPdf(sections).arrayBuffer()).toString("latin1");
const currentPdf = pdfText.slice(pdfText.indexOf("(CURRENT COMPLIANCE)"), pdfText.indexOf("(COMPLIANCE HISTORY)"));
assert(currentPdf.includes("(2028-10-21)") && currentPdf.includes("(703084)") && currentPdf.includes("(2026-10-22)"));
assert(!currentPdf.includes("(2026-10-21)"));
assert(pdfText.slice(pdfText.indexOf("(COMPLIANCE HISTORY)")).includes("(2026-10-21)"));
const workbook = XLSX.read(await exports.projectExportXlsx(sections).arrayBuffer());
assert.deepEqual(XLSX.utils.sheet_to_json(workbook.Sheets["Current Compliance"]), JSON.parse(JSON.stringify(current.rows)));
assert.equal(XLSX.utils.sheet_to_json(workbook.Sheets["Compliance History"]).length, 2);
console.log("PASS: DoveLin #115 / project #13 / assignment #1383: Contractor Card, Project rows, PDF and XLSX agree on #303, 703084, 2026-10-22 to 2028-10-21 Active; #86 remains archived in history.");

const variants = [
  ...records,
  credential(400, { contractor_id: 200, expiration_date: "2000-01-01", synced_expiration_date: "2099-01-01" }),
  credential(401, { contractor_id: 200, active: false, is_current: false, expiration_date: "2099-01-01", created_at: "2098-01-01" }),
  credential(402, { contractor_id: 201, active: false, is_current: true }),
  credential(403, { contractor_id: 202, active: true, is_current: false }),
  credential(404, { contractor_id: 203, compliance_type_id: 7, registration_number: null, expiration_date: null,
    compliance_types: { compliance_name: "NJ BRC", requires_expiration: false } }),
  credential(405, { contractor_id: 204, compliance_type_id: 9, registration_number: null, expiration_date: null,
    compliance_types: { compliance_name: "NY BRC", requires_expiration: false } }),
  credential(406, { contractor_id: 205, registry_status: "Expired - Not Found in Registry" }),
  credential(407, { contractor_id: 206, expiration_date: null }),
];
tables.compliance_records = variants;
const mapped = (await compliance.getComplianceHistoryForContractors([115, 200, 201, 202, 203, 204, 205, 206])).data;
const variantSections = shared.projectComplianceSections(mapped, new Map(variants.map(row => [row.contractor_id, `Fixture ${row.contractor_id}`])));
const variantCurrent = variantSections[0].rows;
assert.equal(variantCurrent.length, 6);
assert.equal(variantCurrent.find(row => row.Contractor === "Fixture 200")["Current Status"], "Expired",
  "An actually expired current credential is not replaced by future-dated history or informational sync dates");
for (const id of [203, 204]) {
  assert.equal(variantCurrent.find(row => row.Contractor === `Fixture ${id}`)["Expiration Date"], "Non-expiring");
  assert.equal(variantCurrent.find(row => row.Contractor === `Fixture ${id}`)["Current Status"], "Active");
}
for (const name of ["NJ BRC", "NY BRC"]) assert.equal(compliance.calculateComplianceStatus({
  compliance_name: name, registration_number: null, expiration_date: null, requires_expiration: true,
}).calculated_status, "Active", "Established non-expiring types never require expiration");
assert.equal(variantCurrent.find(row => row.Contractor === "Fixture 205")["Current Status"], "Expired");
assert.equal(variantCurrent.find(row => row.Contractor === "Fixture 206")["Current Status"], "Missing Information");
assert.equal(mapped.find(row => row.id === 401).active, false);
assert.equal(variantSections[1].rows.find(row => row.Contractor === "Fixture 202")["Record Status"], "Superseded (Active)");
const variantBook = XLSX.read(await exports.projectExportXlsx(variantSections).arrayBuffer());
assert.deepEqual(XLSX.utils.sheet_to_json(variantBook.Sheets["Current Compliance"]), JSON.parse(JSON.stringify(variantCurrent)));
const variantPdf = Buffer.from(await exports.projectExportPdf(variantSections).arrayBuffer()).toString("latin1");
assert(variantPdf.includes("(Non-expiring)") && variantPdf.includes("(Expired)"));
console.log("PASS: explicit active/current flags, not latest dates; actual expired and registry-expired remain expired; informational sync cannot override; missing PWC dates; NJ/NY BRC non-expiring; inactive/unlinked/superseded records retained only as history.");

tables.compliance_records = Array.from({ length: 1001 }, (_, index) => credential(index + 1000));
assert.equal((await compliance.getComplianceHistoryForContractor(115)).data.length, 1001);
assert(reads.some(read => read.table === "compliance_records" && read.start === 1000));
failure = { table: "compliance_records", start: 500 };
assert.equal((await compliance.getComplianceHistoryForContractor(115)).data, null);
await assert.rejects(exports.loadProjectExport(13), /Fixture read denied/);
failure = null;
const batchIds = Array.from({ length: 205 }, (_, index) => index + 1);
tables.compliance_records = batchIds.map(id => credential(id + 2000, { contractor_id: id }));
assert.equal((await compliance.getComplianceHistoryForContractors(batchIds)).data.length, 205);
assert.equal((await compliance.getComplianceHistoryForContractors([])).data.length, 0);
console.log("PASS: complete 1001-row history, >100-contractor batches, empty inputs, later-page failure rejects partial data/exports; read-only services.");

if (process.env.TEST_APP_URL) {
  const appUrl = process.env.TEST_APP_URL;
  assert.equal(new URL(appUrl).hostname, "localhost");
  let uiContractor = contractor;
  let uiProject = project;
  let uiRecords = variants;
  let uiAssignments = [assignment];
  if (process.env.PROJECT_COMPLIANCE_SNAPSHOT) {
    const snapshot = JSON.parse(fs.readFileSync(process.env.PROJECT_COMPLIANCE_SNAPSHOT, "utf8"));
    uiContractor = snapshot.contractors[0];
    uiProject = snapshot.projects[0];
    uiRecords = snapshot.records.map(row => ({ ...row, compliance_types: snapshot.types.find(type => type.id === row.compliance_type_id) }));
    uiAssignments = snapshot.assignments.map(row => ({ ...row, contractors: uiContractor, projects: uiProject }));
  }
  tables = { projects: [uiProject], contractors: [uiContractor], contractor_projects: uiAssignments,
    compliance_records: uiRecords, compliance_types: [type], activity_log: [], documents: [],
    contractor_followups: [], contractor_insurance_history: [], contractor_tiered_subs: [], contractor_contacts: [],
    mycoi_vendor_mappings: [], mycoi_contractor_divisions: [], mycoi_policies: [] };
  const env = fs.readFileSync(".env.local", "utf8");
  const origin = new URL(env.match(/^NEXT_PUBLIC_SUPABASE_URL\s*=\s*["']?([^"'\r\n]+)/m)[1].trim()).origin;
  const storageKey = `sb-${new URL(origin).hostname.split(".")[0]}-auth-token`;
  const user = { id: "00000000-0000-0000-0000-000000000001", email: "fixture@example.invalid",
    aud: "authenticated", app_metadata: {}, user_metadata: {} };
  const { chromium } = require("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 1000 } });
    await context.addInitScript(({ storageKey, user }) => localStorage.setItem(storageKey, JSON.stringify({
      access_token: "fixture-token", refresh_token: "fixture-refresh", token_type: "bearer", expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600, user,
    })), { storageKey, user });
    const mutations = [], pageErrors = [];
    await context.route("**/*", async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin === new URL(appUrl).origin) {
        if (url.pathname === "/api/admin/bootstrap") return route.fulfill({ json: {} });
        if (!["GET", "HEAD"].includes(request.method())) { mutations.push(url.pathname); return route.abort(); }
        if (url.pathname === "/api/auth/session") return route.fulfill({ json: {
          profile: { auth_user_id: user.id, name: "Fixture", email: user.email, role: "Administrator", status: "Active" },
          permissions: ["projects", "contractors", "compliance", "insurance", "imports", "followups"].map(module => ({
            module, can_view: true, can_manage: true, can_add: true, can_edit: true,
          })),
        } });
        if (url.pathname.startsWith("/api/")) return route.fulfill({ json: { unlinks: [] } });
        return route.continue();
      }
      assert.equal(url.origin, origin, "All non-local network requests must be intercepted database reads");
      if (!["GET", "HEAD"].includes(request.method())) { mutations.push(url.pathname); return route.abort(); }
      if (url.pathname.startsWith("/auth/")) return route.fulfill({ json: user });
      const table = url.pathname.split("/").at(-1);
      assert(Object.hasOwn(tables, table), `Unexpected table ${table}`);
      let rows = tables[table];
      for (const [key, filter] of url.searchParams) {
        const value = row => key.split(".").reduce((result, field) => result?.[field], row);
        if (filter.startsWith("eq.")) rows = rows.filter(row => String(value(row)) === filter.slice(3));
        if (filter.startsWith("in.(")) {
          const values = filter.slice(4, -1).split(",").map(part => part.replace(/^"|"$/g, ""));
          rows = rows.filter(row => values.includes(String(value(row))));
        }
      }
      const offset = Number(url.searchParams.get("offset") ?? 0), limit = Number(url.searchParams.get("limit") ?? rows.length);
      rows = rows.slice(offset, offset + limit);
      return route.fulfill({ json: request.headers().accept?.includes("vnd.pgrst.object") ? rows[0] : rows });
    });
    const page = await context.newPage();
    page.on("pageerror", error => pageErrors.push(error.message));
    await page.goto(`${appUrl}/contractors/115`);
    await page.getByRole("heading", { name: uiContractor.company_name, exact: true }).waitFor();
    const activeCard = page.getByRole("table")
      .filter({ has: page.getByRole("columnheader", { name: "Actions", exact: true }) });
    const cardRow = activeCard.getByRole("row").filter({ hasText: "NJ PWC" });
    await cardRow.waitFor();
    assert((await cardRow.innerText()).includes("2028-10-21"));
    assert(!(await cardRow.innerText()).includes("2026-10-21"));
    await page.goto(`${appUrl}/projects?projectId=13`);
    const table = page.getByRole("table", { name: "Current Compliance", exact: true });
    const row = table.getByRole("row").filter({ hasText: uiContractor.company_name }).filter({ hasText: "NJ PWC" });
    await row.waitFor();
    const cells = await row.getByRole("cell").allTextContents();
    assert.deepEqual(cells, ["NJ PWC", uiContractor.company_name, "703084", "2026-10-22", "2028-10-21", "Active"]);
    const historyTable = page.getByRole("table", { name: "Compliance History", exact: true });
    const old = historyTable.getByRole("row").filter({ hasText: "2026-10-21" });
    assert((await old.innerText()).includes("Archived (Expired)"));
    for (const format of ["PDF", "XLSX"]) {
      await page.getByRole("button", { name: "Export", exact: true }).click();
      const download = page.waitForEvent("download");
      await page.getByRole("button", { name: format, exact: true }).click();
      const file = await download;
      const bytes = fs.readFileSync(await file.path());
      if (format === "PDF") {
        const text = bytes.toString("latin1");
        const current = text.slice(text.indexOf("(CURRENT COMPLIANCE)"), text.indexOf("(COMPLIANCE HISTORY)"));
        assert(current.includes("(2028-10-21)") && !current.includes("(2026-10-21)"));
      } else {
        const rows = XLSX.utils.sheet_to_json(XLSX.read(bytes).Sheets["Current Compliance"]);
        const saved = rows.find(row => row.Contractor === uiContractor.company_name && row["Compliance Type"] === "NJ PWC");
        assert.deepEqual(Object.values(saved), cells, "Downloaded XLSX exactly matches the displayed current row");
      }
      await page.getByRole("button", { name: "Export", exact: true }).waitFor();
      if (process.env.PROJECT_EXPORT_SAMPLE_DIR) {
        fs.mkdirSync(process.env.PROJECT_EXPORT_SAMPLE_DIR, { recursive: true });
        fs.copyFileSync(await file.path(), `${process.env.PROJECT_EXPORT_SAMPLE_DIR}\\dovelin-project-current.${format.toLowerCase()}`);
      }
    }
    if (process.env.PROJECT_EXPORT_SAMPLE_DIR) {
      await table.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${process.env.PROJECT_EXPORT_SAMPLE_DIR}\\dovelin-project-current.png` });
    }
    assert.deepEqual(pageErrors, []);
    assert.deepEqual(mutations, []);
    console.log("PASS: localhost Contractor Card and Project Details agree; saved snapshot NJ PWC current/history; actual browser PDF/XLSX downloads match; all database/API traffic intercepted; no writes.");
  } finally { await browser.close(); }
}
