import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import * as XLSX from "xlsx";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requirePackage = createRequire(import.meta.url);
const tables = {};
const calls = [];
let failure = null;
class Query {
  constructor(table) { this.table = table; this.filters = []; this.start = 0; this.end = Infinity; calls.push(this); }
  select() { return this; }
  order() { return this; }
  range(start, end) { this.start = start; this.end = end; return this; }
  abortSignal(signal) { this.signal = signal; return this; }
  eq(key, value) { this.filters.push((row) => row[key] === value); return this; }
  insert(payload) { this.operation = "insert"; this.payload = payload; return this; }
  update(payload) { this.operation = "update"; this.payload = payload; return this; }
  delete() { this.operation = "delete"; return this; }
  maybeSingle() { this.single = true; return this; }
  then(resolve, reject) {
    return Promise.resolve().then(() => {
      this.signal?.throwIfAborted();
      if (failure) return { data: null, error: { message: failure } };
      const rows = this.operation === "insert" ? [{ id: "new", ...this.payload }] : (tables[this.table] ?? []).filter((row) => this.filters.every((filter) => filter(row)));
      if (this.operation === "update") for (const row of rows) Object.assign(row, this.payload);
      const data = rows.slice(this.start, this.end + 1);
      return { data: this.single ? data[0] ?? null : data, error: null };
    }).then(resolve, reject);
  }
}
const supabase = { from: (table) => new Query(table), rpc: async (name, args) => { calls.push({ name, args }); return { error: failure ? { message: failure } : null }; } };
const cache = new Map();
function load(filename) {
  filename = path.resolve(root, filename);
  if (cache.has(filename)) return cache.get(filename);
  const code = ts.transpileModule(fs.readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const loadedModule = { exports: {} };
  const localRequire = (id) => {
    if (id === "@/lib/supabase") return { supabase };
    if (id.startsWith("@/") || id.startsWith(".")) {
      const bases = id.startsWith("@/") ? [path.join(root, "src", id.slice(2)), path.join(root, id.slice(2))] : [path.resolve(path.dirname(filename), id)];
      for (const base of bases) for (const ext of [".ts", ".tsx"]) if (fs.existsSync(base + ext)) return load(base + ext);
    }
    return requirePackage(id);
  };
  vm.runInNewContext(code, { exports: loadedModule.exports, module: loadedModule, require: localRequire, Blob, Date, Map, Set }, { filename });
  cache.set(filename, loadedModule.exports);
  return loadedModule.exports;
}
const exporter = load("src\\lib\\custom-export.ts");
const config = load("src\\lib\\export-template-config.ts");
const service = load("services\\export-templates.ts");
const categories = load("src\\types\\export-template.ts").TEMPLATE_CATEGORIES;
const permissions = load("src\\components\\SessionContext.tsx");
const plain = (value) => JSON.parse(JSON.stringify(value));
const template = (overrides = {}) => ({
  id: "one", name: "Test", category: "contractors", field_ids: ["data_warning", "contractor_name"],
  default_format: "xlsx", default_scope: "filtered", configuration_version: 1,
  sort_configuration: null, filter_configuration: null, revision: 1, ...overrides,
});

test("six stable categories and new template warning/private defaults", () => {
  assert.deepEqual(Array.from(categories, (category) => category.label), ["Contractors", "Compliance", "Insurance", "Projects", "Executive", "Personal"]);
  const draft = config.newTemplateDraft();
  assert.equal(draft.visibility, "private");
  assert.equal(draft.category, "contractors");
  assert.ok(draft.configuration.fields.includes("data_warning"));
  draft.name = "New";
  config.validateTemplateDraft(draft);
  draft.category = "unknown";
  assert.throws(() => config.validateTemplateDraft(draft), /category/);
});

test("templates load ordered IDs and preserve deliberate Data Warning removal", () => {
  assert.deepEqual(plain(config.templateConfiguration(template()).fields), ["data_warning", "contractor_name"]);
  assert.deepEqual(plain(config.templateConfiguration(template({ field_ids: ["contractor_name"] })).fields), ["contractor_name"]);
  const field = exporter.EXPORT_FIELDS.find((entry) => entry.id === "contractor_name");
  const previous = field.label;
  field.label = "Renamed Company";
  try { assert.equal(config.templateConfiguration(template()).fields[1], "contractor_name"); }
  finally { field.label = previous; }
});

test("unsupported versions, fields, sort/filter shapes, and categories are explicit failures", () => {
  for (const overrides of [
    { configuration_version: 2 }, { category: "unknown" }, { field_ids: ["ein"] },
    { field_ids: ["contractor_name", "contractor_name"] }, { field_ids: [] },
    { sort_configuration: { field: "nj_pwc_status", direction: "asc" } },
    { filter_configuration: { sql: "select *" } }, { filter_configuration: [] }, { filter_configuration: true },
    { sort_configuration: true }, { default_format: "pdf" }, { default_scope: "saved_ids" },
  ]) assert.throws(() => config.templateConfiguration(template(overrides)));
});

test("both seeded templates use exactly approved existing fields, categories, and defaults", () => {
  const sql = fs.readFileSync(path.join(root, "supabase", "20261008_saved_export_templates.sql"), "utf8");
  const seed = sql.slice(sql.indexOf("INSERT INTO public.export_templates("));
  const arrays = [...seed.matchAll(/ARRAY\[([\s\S]*?)\]/g)].map((match) => [...match[1].matchAll(/'([^']+)'/g)].map((field) => field[1]));
  assert.deepEqual(arrays[0], [
    "contractor_name","sage_erp_id","address_1","address_2","city","state","zip_code","county","phone","email",
    "material_vendor_only","contractor_status","nj_pwc_number","nj_pwc_expiration","nj_pwc_status","nj_brc_number",
    "nj_brc_name_control","nj_brc_status","ny_pwc_number","ny_pwc_expiration","ny_pwc_status","gl_expiration",
    "wc_expiration","project_names","project_numbers","data_warning",
  ]);
  assert.deepEqual(arrays[1], ["contractor_name","sage_erp_id","city","state","phone","email","contractor_status","gl_expiration","wc_expiration","data_warning"]);
  for (const fields of arrays) exporter.selectedExportFields(fields);
  assert.match(seed, /'insurance',ARRAY/);
  assert.match(seed, /'contractors',ARRAY/);
  assert.equal((seed.match(/'xlsx','all'/g) ?? []).length, 2);
});

test("ordered fields, supported filters, and deterministic sorting are consistent in Excel/CSV", async () => {
  const data = {
    contractors: [
      { id: 2, company_name: "Bravo", city: "Wayne", state: "NJ", active: true, material_vendor_only: false },
      { id: 1, company_name: "Alpha", city: "Wayne", state: "NJ", active: true, material_vendor_only: false },
      { id: 3, company_name: "Inactive", city: "Wayne", state: "NJ", active: false, material_vendor_only: false },
    ], compliance: [], insurance: [], assignments: [], tieredSubs: [], followups: [],
  };
  const before = JSON.stringify(data);
  const filtered = exporter.configureExportData(data, { contractor_status: "Active", state: "nj", city: "ayn", material_vendor_only: false });
  assert.equal(filtered.contractors.length, 2);
  assert.equal(exporter.configureExportData(data, { contractor_name: "zzz" }).contractors.length, 0);
  const fields = ["state", "data_warning", "contractor_name"];
  const prepared = exporter.prepareCustomExport(filtered, fields, { field: "contractor_name", direction: "desc" });
  assert.equal(prepared.rows[0]["Contractor Name"], "Bravo");
  const trips = [];
  for (const format of ["xlsx", "csv"]) {
    const workbook = XLSX.read(Buffer.from(await exporter.generateCustomExport(prepared.rows, fields, format).arrayBuffer()), { type: "buffer", raw: true });
    trips.push(XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1, defval: "" }));
  }
  assert.deepEqual(trips[0], trips[1]);
  assert.deepEqual(trips[0][0], ["State", "Data Warning", "Contractor Name"]);
  assert.equal(JSON.stringify(data), before);
});

test("granular imports permissions do not turn Add or View into Edit/Delete", () => {
  const profile = { role: "Custom", system_administrator: false, permissions: [{ module: "imports", can_view: true, can_manage: true, can_add: true, can_edit: false, can_delete: false }] };
  assert.equal(permissions.templatePermission(profile, "add"), true);
  assert.equal(permissions.templatePermission(profile, "edit"), false);
  assert.equal(permissions.templatePermission(profile, "delete"), false);
  profile.permissions[0].can_view = false;
  assert.equal(permissions.templatePermission(profile, "add"), false);
  profile.system_administrator = true;
  assert.equal(permissions.templatePermission(profile, "delete"), true);
});

test("template service paginates listings and errors/aborts are not hidden", async () => {
  tables.export_templates = Array.from({ length: 1201 }, (_, id) => template({ id: String(id) }));
  tables.export_template_user_preferences = [];
  calls.length = 0;
  assert.equal((await service.fetchExportTemplates(new AbortController().signal)).templates.length, 1201);
  assert.equal(calls.filter((call) => call.table === "export_templates").length, 3);
  failure = "Missing table";
  try { await assert.rejects(service.fetchExportTemplates(new AbortController().signal), /migration/); }
  finally { failure = null; }
  const abort = new AbortController(); abort.abort();
  await assert.rejects(service.fetchExportTemplates(abort.signal), /abort/i);
});

test("save/delete use revision guards and preference changes use atomic RPC", async () => {
  const draft = config.newTemplateDraft(); draft.name = " Saved ";
  const saved = await service.saveExportTemplate(draft);
  assert.equal(saved.name, "Saved");
  tables.export_templates = [template()];
  calls.length = 0;
  await service.saveExportTemplate(draft, template());
  assert.equal(calls[0].operation, "update");
  assert.equal(calls[0].filters.length, 2);
  await assert.rejects(service.saveExportTemplate(draft, template({ revision: 99 })), /changed/);
  await assert.rejects(service.deleteExportTemplate(template({ revision: 99 })), /changed/);
  await service.setTemplatePreference("one", true, true);
  assert.equal(calls.at(-1).name, "set_export_template_preference");
  assert.deepEqual(plain(calls.at(-1).args), { p_template_id: "one", p_favorite: true, p_default: true });
});
