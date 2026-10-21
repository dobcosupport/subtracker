import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
import ts from "typescript";

const requirePackage = createRequire(import.meta.url);
let tables = {};
let failure = null;
const calls = [];
class Query {
  constructor(table) {
    assert.notEqual(table, "contractor_insurance", "Operational code must never read/write Manual Insurance");
    this.table = table; this.filters = []; this.start = 0; this.end = Infinity; calls.push(table);
  }
  select() { return this; }
  eq(key, value) { this.filters.push((r) => key.split(".").reduce((item, k) => item?.[k], r) === value); return this; }
  in(key, ids) { this.filters.push((r) => ids.includes(r[key])); return this; }
  order() { return this; }
  limit(count) { this.end = count - 1; return this; }
  range(start, end) { this.start = start; this.end = end; return this; }
  returns() { return this; }
  maybeSingle() { this.single = true; return this; }
  then(resolve, reject) {
    const data = (tables[this.table] ?? []).filter((r) => this.filters.every((f) => f(r))).slice(this.start, this.end + 1);
    return Promise.resolve(failure === this.table ? { data: null, error: { message: "Synthetic read failure" } }
      : { data: this.single ? data[0] ?? null : data, error: null }).then(resolve, reject);
  }
}
const writes = [];
const supabase = { from: (table) => new Query(table), rpc: async (name, args) => {
  writes.push({ name, args }); return { data: [], error: null };
} };
const cache = new Map();
function load(name) {
  if (cache.has(name)) return cache.get(name);
  const output = { exports: {} };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL(`../${name}`, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText, { module: output, exports: output.exports, Blob, require: (id) => {
    if (id === "@/lib/supabase") return { supabase };
    if (id.startsWith("@/services/")) return load(`services/${id.slice(11)}.ts`);
    if (id.startsWith("@/lib/")) return load(`src/lib/${id.slice(6)}.ts`);
    return requirePackage(id);
  } });
  cache.set(name, output.exports);
  return output.exports;
}
const exports = load("services/exports.ts");
const imports = load("services/imports.ts");
const policy = { id: 1, contractor_id: 1, policy_line: "General Liability", expiration_date: "2026-12-27",
  active: true, is_current: true, vendor: { contractor_id: 1, active: true } };
tables = {
  contractors: [{ id: 1, company_name: "Synthetic", active: true }],
  projects: [{ id: 2, project_number: "22-002", project_name: "Synthetic" }],
  contractor_projects: [{ id: 10, contractor_id: 1, project_id: 2, active: true, manual_owned: false, mycoi_owned: true }],
  mycoi_policies: [policy, { ...policy, id: 2, expiration_date: "2027-12-27" },
    { ...policy, id: 3, expiration_date: "2099-12-27", active: false }],
};
let result = await exports.fetchContractorMasterExport("active");
assert.equal(result.error, null);
assert.equal(result.rows[0]["Insurance Summary"], "GL: expires 2027-12-27; WC: Missing Information");
assert.doesNotMatch(result.rows[0]["Insurance Summary"], /COI|verified|on file/i);
failure = "mycoi_policies";
result = await exports.fetchContractorMasterExport("active");
assert.equal(result.rows.length, 0);
assert.match(result.error.message, /Synthetic read failure/);
failure = null;
const reference = await imports.fetchReferenceData();
let preview = imports.buildPreview("synthetic.xlsx", { Insurance: [{ "Company Name": "Synthetic", "COI On File": "Yes" }] }, reference);
assert.equal(preview.rowsBySheet.Insurance[0].action, "Error");
assert.match(preview.rowsBySheet.Insurance[0].errors[0].message, /Manual Insurance is retired/);
preview.rowsBySheet.Insurance[0].action = "Create"; // A stale caller still cannot write legacy data.
result = await imports.runImport(preview);
assert.equal(result.failed, 1);
assert.match(result.errors[0].message, /retired/);
assert.equal(writes.length, 0);
preview = imports.buildPreview("synthetic.xlsx", { "Project Assignments": [
  { "Company Name": "Synthetic", "Project Number": "22-002", Active: "Yes" },
] }, reference);
assert.equal(preview.rowsBySheet["Project Assignments"][0].action, "Update", "Retaining a MYCOI-only project must establish MANUAL ownership, not skip");
result = await imports.runImport(preview);
assert.equal(result.failed, 0);
assert.equal(writes[0].name, "set_manual_project_assignment");
assert.equal(writes[0].args.p_owned, true);
assert.ok(calls.every((table) => !table.startsWith("contractor_insurance")));
console.log("PASS: myCOI-only master summaries/latest expiry/missing coverage/query failures; retired worksheet rejected, stale manual writes blocked; master project import establishes independent MANUAL ownership");
