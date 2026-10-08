import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import * as XLSX from "xlsx";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requirePackage = createRequire(import.meta.url);
const calls = [];
let tables = {};
let failureTable = null;

class Query {
  constructor(table) {
    this.table = table;
    this.filters = [];
    this.orders = [];
    this.start = 0;
    this.end = Infinity;
    calls.push(this);
  }
  select(columns, options) { this.columns = columns; this.head = options?.head; return this; }
  in(column, ids) { this.filters.push((row) => ids.includes(row[column])); return this; }
  eq(column, value) {
    this.filters.push((row) => column === "compliance_types.active" ? row.compliance_types?.active === value : row[column] === value);
    return this;
  }
  order(column, options) { this.orders.push([column, options?.ascending !== false]); return this; }
  range(start, end) { this.start = start; this.end = end; return this; }
  abortSignal(signal) { this.signal = signal; return this; }
  then(resolve, reject) {
    return Promise.resolve().then(() => {
      this.signal?.throwIfAborted();
      if (this.table === failureTable) return { data: null, error: { message: "Synthetic retrieval failure" }, count: null };
      const rows = (tables[this.table] ?? []).filter((row) => this.filters.every((filter) => filter(row))).sort((a, b) => {
        for (const [column, ascending] of this.orders) {
          const comparison = a[column] < b[column] ? -1 : a[column] > b[column] ? 1 : 0;
          if (comparison) return ascending ? comparison : -comparison;
        }
        return 0;
      });
      return { data: this.head ? null : rows.slice(this.start, this.end + 1), count: rows.length, error: null };
    }).then(resolve, reject);
  }
}

const supabase = { from: (table) => new Query(table) };
const modules = new Map();
function load(relative) {
  if (modules.has(relative)) return modules.get(relative);
  const filename = path.join(root, relative);
  const source = fs.readFileSync(filename, "utf8");
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  const loadedModule = { exports: {} };
  const localRequire = (id) => {
    if (id === "@/lib/supabase") return { supabase };
    if (id === "@/services/compliance") return load("services\\compliance.ts");
    return requirePackage(id);
  };
  vm.runInNewContext(code, { module: loadedModule, exports: loadedModule.exports, require: localRequire, Blob, Date, Map, Set }, { filename });
  modules.set(relative, loadedModule.exports);
  return loadedModule.exports;
}
const exporter = load("src\\lib\\custom-export.ts");
const signal = () => new AbortController().signal;
const empty = () => ({ contractors: [], compliance: [], insurance: [], assignments: [], tieredSubs: [], followups: [] });
const contractor = (id = 1) => ({ id, company_name: `Contractor ${id}`, active: true, city: "Wayne", state: "NJ", zip_code: "07470", material_vendor_only: false });
const compliance = (overrides = {}) => ({
  id: 1, contractor_id: 1, registration_number: "00708951", effective_date: "2026-01-15",
  expiration_date: "2099-01-14", active: true, is_current: true,
  compliance_types: { compliance_name: "NJ PWC", requires_expiration: true, active: true },
  ...overrides,
});

test("registry IDs are stable and unique; defaults and unavailable fields are correct", () => {
  assert.equal(new Set(exporter.EXPORT_FIELDS.map((field) => field.id)).size, exporter.EXPORT_FIELDS.length);
  assert.equal(exporter.EXPORT_FIELDS.length, 37);
  assert.equal(exporter.EXPORT_GROUPS.find((group) => group.id === exporter.EXPORT_FIELDS.find((field) => field.id === "data_warning").group).label, "Data Quality");
  assert.deepEqual(Array.from(exporter.EXPORT_FIELDS.filter((field) => field.defaultSelected).map((field) => field.id)), [
    "contractor_name", "sage_erp_id", "city", "state", "nj_pwc_number", "nj_pwc_expiration", "nj_pwc_status", "data_warning",
  ]);
  assert.throws(() => exporter.selectedExportFields([]), /at least one/);
  assert.throws(() => exporter.selectedExportFields(["ein"]), /no longer available/);
});

test("one row per contractor, authoritative compliance, latest follow-up, project aggregation and booleans", () => {
  const data = empty();
  data.contractors = [{ ...contractor(), nj_pwc_number: "WRONG MASTER VALUE" }];
  data.compliance = [compliance()];
  data.assignments = [
    { id: 1, contractor_id: 1, projects: { project_name: "Project A", project_number: "01" } },
    { id: 2, contractor_id: 1, projects: [{ project_name: "Project B", project_number: "02" }] },
  ];
  data.followups = [
    { id: 1, contractor_id: 1, followup_date: "2026-01-01", created_at: "2026-01-05", notes: "old", status: "Open" },
    { id: 2, contractor_id: 1, followup_date: "2026-01-02", created_at: "2026-01-03", notes: "newer date", status: "Open" },
    { id: 3, contractor_id: 1, followup_date: "2026-01-02", created_at: "2026-01-04", notes: "latest", status: "Resolved" },
  ];
  const rows = exporter.buildCustomExportRows(data, ["contractor_name", "nj_pwc_number", "nj_pwc_expiration", "nj_pwc_status", "project_names", "followup_notes", "followup_status", "material_vendor_only"]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]["NJ PWC Number"], "00708951");
  assert.equal(rows[0]["NJ PWC Expiration Date"], "2099-01-14");
  assert.equal(rows[0]["NJ PWC Status"], "Active");
  assert.equal(rows[0]["Assigned Project Names"], "Project A; Project B");
  assert.equal(rows[0]["Latest Follow-up Note"], "latest");
  assert.equal(rows[0]["Follow-up Status"], "Resolved");
  assert.equal(rows[0]["Material Vendor"], "No");
  data.compliance.push(compliance({ id: 2 }));
  assert.equal(exporter.buildCustomExportRows(data, ["nj_pwc_number"])[0]["NJ PWC Number"], "");
  assert.equal(exporter.buildCustomExportRows(data, ["contractor_name"]).length, 1);
});

test("Excel and CSV round trips preserve headers, dates, blanks, ZIP/registration zeros and multiline text", async () => {
  const fields = ["contractor_name", "zip_code", "nj_pwc_number", "nj_pwc_expiration", "followup_notes"];
  const rows = [{ "Contractor Name": 'Company, "Quoted"', "ZIP Code": "07470", "NJ PWC Number": "00708951", "NJ PWC Expiration Date": "2028-01-14", "Latest Follow-up Note": "line 1\nline 2" }];
  const excel = exporter.generateCustomExport(rows, fields, "xlsx");
  const workbook = XLSX.read(await excel.arrayBuffer(), { type: "array" });
  assert.deepEqual(workbook.SheetNames, ["Contractors"]);
  const worksheet = workbook.Sheets.Contractors;
  assert.equal(worksheet.B2.t, "s");
  assert.equal(worksheet.B2.v, "07470");
  assert.equal(worksheet.C2.v, "00708951");
  assert.deepEqual(XLSX.utils.sheet_to_json(worksheet), rows);
  const csv = await exporter.generateCustomExport(rows, fields, "csv").arrayBuffer();
  assert.deepEqual(Array.from(new Uint8Array(csv).slice(0, 3)), [239, 187, 191]);
  const csvWorkbook = XLSX.read(Buffer.from(csv), { type: "buffer", raw: true });
  assert.deepEqual(XLSX.utils.sheet_to_json(csvWorkbook.Sheets.Sheet1), rows);
  const protectedCsv = await exporter.generateCustomExport([{ "Contractor Name": "=HYPERLINK(\"bad\")" }], ["contractor_name"], "csv").text();
  assert.ok(protectedCsv.includes("'=HYPERLINK"));
  const blankWorkbook = XLSX.read(await exporter.generateCustomExport([{ "Contractor Name": "" }], ["contractor_name"], "xlsx").arrayBuffer());
  assert.equal(blankWorkbook.Sheets.Contractors.A2.v, "");
  assert.equal(exporter.customExportFilename("csv", new Date(2026, 9, 8, 9, 5)), "SubTracker_Custom_Export_2026-10-08_0905.csv");
});

test("all scope is paginated, includes inactive contractors, and has no Dashboard filters", async () => {
  calls.length = 0;
  tables = { contractors: Array.from({ length: 1201 }, (_, index) => ({ ...contractor(index + 1), active: index % 2 === 0 })) };
  const data = await exporter.fetchCustomExportData({ fields: ["contractor_name"], scope: "all", format: "csv" }, [999], signal());
  assert.equal(data.contractors.length, 1201);
  const contractorQueries = calls.filter((query) => query.table === "contractors");
  assert.equal(contractorQueries.length, 3);
  assert.ok(contractorQueries.every((query) => query.filters.length === 0));
  assert.ok(calls.every((query) => ["contractors", "compliance_records"].includes(query.table)));
  assert.equal(await exporter.countAllExportContractors(signal()), 1201);
});

test("filtered scope uses only displayed IDs; relation retrieval excludes inactive/history records", async () => {
  calls.length = 0;
  tables = {
    contractors: [contractor(), contractor(2)],
    compliance_records: [compliance(), compliance({ id: 2, active: false }), compliance({ id: 3, is_current: false }), compliance({ id: 4, compliance_types: { compliance_name: "NJ PWC", active: false } })],
  };
  const data = await exporter.fetchCustomExportData({ fields: ["nj_pwc_number"], scope: "filtered", format: "xlsx" }, [1, 1], signal());
  assert.equal(data.contractors.length, 1);
  assert.equal(data.compliance.length, 1);
  assert.equal(data.compliance[0].id, 1);
  assert.ok(calls.every((query) => ["contractors", "compliance_records"].includes(query.table)));
  await assert.rejects(exporter.fetchCustomExportData({ fields: ["contractor_name"], scope: "filtered", format: "csv" }, [99], signal()), /no longer accessible/);
});

test("related query errors stop export, closing can abort, and no initial retrieval occurs", async () => {
  failureTable = "contractor_insurance";
  tables = { contractors: [contractor()] };
  await assert.rejects(exporter.fetchCustomExportData({ fields: ["gl_expiration"], scope: "filtered", format: "csv" }, [1], signal()), /Synthetic retrieval failure/);
  failureTable = null;
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(exporter.fetchCustomExportData({ fields: ["contractor_name"], scope: "all", format: "csv" }, [], controller.signal), /abort/i);
});

test("single conflict blanks all affected fields without blocking unaffected contractors or mutating input", () => {
  const data = empty();
  data.contractors = [{ ...contractor(), company_name: "EAI Inc." }, contractor(2)];
  data.compliance = [compliance(), compliance({ id: 2 }), compliance({ id: 3, contractor_id: 2 })];
  const before = JSON.stringify(data);
  const fields = ["contractor_name", "nj_pwc_number", "nj_pwc_effective", "nj_pwc_expiration", "nj_pwc_status", "data_warning"];
  const prepared = exporter.prepareCustomExport(data, fields);
  assert.equal(prepared.rows.length, 2);
  assert.equal(prepared.warningCount, 1);
  const conflict = prepared.rows.find((row) => row["Contractor Name"] === "EAI Inc.");
  for (const label of ["NJ PWC Number", "NJ PWC Effective Date", "NJ PWC Expiration Date", "NJ PWC Status"]) assert.equal(conflict[label], "");
  assert.equal(conflict["Data Warning"], "Multiple active/current NJ PWC records found; NJ PWC fields left blank");
  const valid = prepared.rows.find((row) => row["Contractor Name"] === "Contractor 2");
  assert.equal(valid["NJ PWC Number"], "00708951");
  assert.equal(valid["NJ PWC Status"], "Active");
  assert.equal(valid["Data Warning"], "");
  assert.equal(JSON.stringify(data), before);
  assert.equal(exporter.exportCompletionMessage(prepared.warningCount, true), "Export completed with data warnings for 1 contractor. Review the Data Warning column.");
});

test("multiple issues are semicolon-separated and counts represent contractors rather than issues", () => {
  const data = empty();
  data.contractors = [contractor(), contractor(2), contractor(3)];
  const brc = { compliance_name: "NJ BRC", requires_expiration: false, active: true };
  data.compliance = [
    compliance(), compliance({ id: 2 }),
    compliance({ id: 3, compliance_types: brc }), compliance({ id: 4, compliance_types: brc }),
    compliance({ id: 5, contractor_id: 2 }), compliance({ id: 6, contractor_id: 2 }),
  ];
  const prepared = exporter.prepareCustomExport(data, ["contractor_name", "nj_brc_number", "nj_brc_name_control", "nj_brc_status", "data_warning"]);
  assert.equal(prepared.warningCount, 2);
  assert.equal(prepared.rows[0]["Data Warning"], "Multiple active/current NJ BRC records found; NJ BRC fields left blank; Multiple active/current NJ PWC records found; NJ PWC fields left blank");
  for (const label of ["NJ BRC Business Entity ID", "NJ BRC Name Control", "NJ BRC Status"]) assert.equal(prepared.rows[0][label], "");
  assert.equal(prepared.rows[2]["Data Warning"], "");
  assert.match(exporter.exportCompletionMessage(prepared.warningCount, true), /2 contractors/);
});

test("Excel and CSV retain warning column including all-blank cells, and contain identical conflict text", async () => {
  const data = empty();
  data.contractors = [contractor(), contractor(2)];
  data.compliance = [compliance(), compliance({ id: 2 })];
  const fields = ["contractor_name", "nj_pwc_number", "data_warning"];
  for (const withConflict of [true, false]) {
    if (!withConflict) data.compliance = [];
    const prepared = exporter.prepareCustomExport(data, fields);
    const roundTrips = [];
    for (const format of ["xlsx", "csv"]) {
      const blob = exporter.generateCustomExport(prepared.rows, fields, format);
      const workbook = XLSX.read(Buffer.from(await blob.arrayBuffer()), { type: "buffer", raw: true });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      assert.equal(sheet.C1.v, "Data Warning");
      roundTrips.push(XLSX.utils.sheet_to_json(sheet, { defval: "" }));
    }
    assert.deepEqual(roundTrips[0], roundTrips[1]);
    assert.equal(roundTrips[0][0]["Data Warning"], withConflict ? "Multiple active/current NJ PWC records found; NJ PWC fields left blank" : "");
    assert.equal(roundTrips[0][1]["Data Warning"], "");
  }
});

test("warnings are detected even when Data Warning and compliance fields are deselected", async () => {
  tables = { contractors: [contractor()], compliance_records: [compliance(), compliance({ id: 2 })] };
  calls.length = 0;
  const data = await exporter.fetchCustomExportData({ fields: ["contractor_name"], scope: "all", format: "csv" }, [], signal());
  const prepared = exporter.prepareCustomExport(data, ["contractor_name"]);
  assert.equal(prepared.warningCount, 1);
  assert.deepEqual(Object.keys(prepared.rows[0]), ["Contractor Name"]);
  assert.ok(calls.some((query) => query.table === "compliance_records"));
  assert.match(exporter.exportCompletionMessage(prepared.warningCount, false), /not included in the file/);
  for (const format of ["xlsx", "csv"]) {
    const workbook = XLSX.read(Buffer.from(await exporter.generateCustomExport(prepared.rows, ["contractor_name"], format).arrayBuffer()));
    assert.equal(workbook.Sheets[workbook.SheetNames[0]].A2.v, "Contractor 1");
  }
});

test("each NJ and NY compliance conflict blanks only that type, including array relations", () => {
  const types = [
    ["NJ PWC", ["NJ PWC Number", "NJ PWC Effective Date", "NJ PWC Expiration Date", "NJ PWC Status"]],
    ["NJ BRC", ["NJ BRC Business Entity ID", "NJ BRC Name Control", "NJ BRC Status"]],
    ["NY PWC", ["NY PWC Number", "NY PWC Effective Date", "NY PWC Expiration Date", "NY PWC Status"]],
    ["NY BRC", ["NY BRC Number", "NY BRC Status"]],
  ];
  const fields = exporter.EXPORT_FIELDS.map((field) => field.id);
  for (const [name, labels] of types) {
    const data = empty();
    data.contractors = [{ ...contractor(), brc_name_control: "CTRL" }];
    data.compliance = types.flatMap(([compliance_name], index) => {
      const record = compliance({ id: index, compliance_types: [{ compliance_name, requires_expiration: compliance_name.endsWith("PWC") }] });
      return compliance_name === name ? [record, { ...record, id: 100 + index }] : [record];
    });
    const prepared = exporter.prepareCustomExport(data, fields);
    assert.equal(prepared.warningCount, 1);
    assert.equal(prepared.rows[0]["Data Warning"], `Multiple active/current ${name} records found; ${name} fields left blank`);
    for (const label of labels) assert.equal(prepared.rows[0][label], "", `${name}: ${label}`);
    for (const [otherName, otherLabels] of types) {
      if (otherName !== name) assert.equal(prepared.rows[0][otherLabels[0]], "00708951");
    }
  }
});
