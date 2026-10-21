import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let tables = {};
let failure = null;
const calls = [];
class Query {
  constructor(table) { this.table = table; this.filters = []; this.start = 0; this.end = Infinity; calls.push(this); }
  select(columns) { this.columns = columns; return this; }
  eq(key, value) { this.filters.push((row) => row[key] === value); return this; }
  in(key, values) { this.filters.push((row) => values.includes(row[key])); return this; }
  order() { return this; }
  range(start, end) { this.start = start; this.end = end; return this; }
  returns() {
    return Promise.resolve(this.table === failure
      ? { data: null, error: { message: "Synthetic database error" } }
      : { data: (tables[this.table] ?? []).filter((row) => this.filters.every((filter) => filter(row))).slice(this.start, this.end + 1), error: null });
  }
}
const loadedModule = { exports: {} };
const compiled = ts.transpileModule(fs.readFileSync(path.join(root, "services", "mycoi.ts"), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
vm.runInNewContext(compiled, {
  module: loadedModule, exports: loadedModule.exports,
  require: (name) => {
    assert.equal(name, "@/lib/supabase");
    return { supabase: { from: (table) => new Query(table) } };
  },
});
const get = loadedModule.exports.getMycoiInsurance;
let result = await get(1);
assert.equal(result.error, null);
assert.equal(result.data.vendors.length, 0);
assert.equal(calls.length, 1, "No unscoped reads without mapped vendors");
tables = {
  mycoi_vendor_mappings: Array.from({ length: 1001 }, (_, i) => ({ id: i + 1, contractor_id: 1, active: i !== 0 })),
  mycoi_contractor_divisions: Array.from({ length: 1001 }, (_, i) => ({ id: i + 1, vendor_mapping_id: 1, active: false })),
  mycoi_policies: Array.from({ length: 1001 }, (_, i) => ({ id: i + 1, contractor_id: 1, vendor_mapping_id: 1 })),
};
tables.mycoi_vendor_mappings.push({ id: 2000, contractor_id: 2 });
tables.mycoi_policies.push({ id: 2000, contractor_id: 2, vendor_mapping_id: 2000 });
calls.length = 0;
result = await get(1);
assert.equal(result.data.vendors.length, 1001);
assert.equal(result.data.divisions.length, 1001);
assert.equal(result.data.policies.length, 1001);
assert.equal(result.error, null);
assert.ok(calls.filter((call) => call.start === 1000).length >= 3, "All collections paginate");
assert.ok(calls.some((call) => call.columns.includes("project:projects")), "Existing project master is joined");
assert.ok(calls.some((call) => call.columns.includes("mycoi_policy_divisions")), "Policy/project links are retrieved");
for (const table of Object.keys(tables)) {
  failure = table;
  const denied = await get(1);
  assert.equal(denied.data, null);
  assert.match(denied.error.message, /Unable to load myCOI.*Synthetic database error/);
}
console.log("PASS: scoped read-only retrieval, all pages, historical rows, existing-project joins, and explicit errors");

const adminModule = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(root, "src", "lib", "server-admin.ts"), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText, {
  module: adminModule, exports: adminModule.exports,
  require: (name) => {
    assert.ok(["server-only", "@supabase/supabase-js"].includes(name));
    return {};
  },
});
const auditPayloads = [];
let auditFailure = false;
const admin = { from: (table) => {
  assert.equal(table, "administration_audit_log");
  return { insert: async (payload) => {
    if (auditFailure) return { error: { message: "Synthetic audit write denied", code: "42501" } };
    auditPayloads.push(JSON.parse(JSON.stringify(payload)));
    return { error: null };
  } };
} };
const actor = { auth_user_id: "00000000-0000-0000-0000-000000000001", name: "Synthetic Editor", email: "editor@example.invalid" };
await adminModule.exports.writeAdministrationAudit(admin, actor, "ROLE_UPDATED", "role", "Synthetic", "Synthetic", { renamed: false });
assert.deepEqual(auditPayloads, [{
  user_id: actor.auth_user_id, user_name: actor.name, user_email: actor.email,
  action: "ROLE_UPDATED", object_type: "role", object_id: "Synthetic", object_label: "Synthetic", details: { renamed: false },
}]);
auditFailure = true;
await assert.rejects(adminModule.exports.writeAdministrationAudit(admin, actor, "ROLE_UPDATED", "role", "Synthetic", "Synthetic"),
  (error) => error.message === "Synthetic audit write denied" && error.code === "42501" && error.status === 500);
console.log("PASS: existing non-NJ-PWC application audit helper writes the verified audit columns and surfaces failures; no new myCOI audit workflow implemented");

function loadFunctions(relativePath, names) {
  const text = fs.readFileSync(path.join(root, ...relativePath), "utf8");
  const source = ts.createSourceFile(relativePath.at(-1), text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const functions = source.statements.filter((node) => ts.isFunctionDeclaration(node) && names.includes(node.name?.text));
  assert.equal(functions.length, names.length);
  const selected = functions.map((node) => {
    const declaration = node.getText(source);
    return declaration.startsWith("export ") ? declaration : `export ${declaration}`;
  }).join("\n");
  const output = { exports: {} };
  vm.runInNewContext(ts.transpileModule(selected, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, { module: output, exports: output.exports,
    getMycoiExpirations: (policies) => insurance.getMycoiExpirations(policies) });
  return output.exports;
}
const insurance = loadFunctions(["services", "insurance.ts"], ["getMycoiExpirations"]);
const dashboard = loadFunctions(["services", "dashboard.ts"], ["getCompanyComplianceStatus", "daysUntil", "buildDashboardRecords"]);
const compliance = [
  { contractor_id: 1, company_name: "Synthetic", compliance_record_id: 1, compliance_type_id: 1, compliance_name: "W9", calculated_status: "Active" },
  { contractor_id: 1, company_name: "Synthetic", compliance_record_id: 2, compliance_type_id: 2, compliance_name: "NJ PWC", registration_number: "SYN-PWC", expiration_date: "2099-01-01", calculated_status: "Active" },
  { contractor_id: 1, company_name: "Synthetic", compliance_record_id: 3, compliance_type_id: 3, compliance_name: "NJ BRC", registration_number: "SYN-BRC", expiration_date: null, calculated_status: "Active" },
];
const policy = { id: 1, contractor_id: 1, active: true, is_current: true, vendor: { contractor_id: 1, active: true },
  policy_line: "General Liability", expiration_date: "2099-01-01" };
const policies = [policy, { ...policy, id: 2, policy_line: "Workers Compensation" }];
const policyBefore = JSON.stringify(policies);
const records = dashboard.buildDashboardRecords(compliance, policies);
assert.equal(dashboard.getCompanyComplianceStatus(records), "Compliant");
assert.equal(records.filter((row) => row.record_key.startsWith("insurance:")).length, 2);
assert.equal(dashboard.getCompanyComplianceStatus(dashboard.buildDashboardRecords(compliance, [{ ...policy, expiration_date: "2000-01-01" }])), "Non-Compliant");
assert.equal(dashboard.getCompanyComplianceStatus(dashboard.buildDashboardRecords(compliance, [])), "Non-Compliant");
for (const [days, expected] of [[15, "30 Day"], [45, "60 Day"], [75, "90 Day"]]) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  const expiration = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const rows = dashboard.buildDashboardRecords(compliance, [{ ...policy, expiration_date: expiration }, policies[1]]);
  assert.ok(rows.some((row) => row.compliance_name === "General Liability" && row.calculated_status === expected));
  assert.equal(dashboard.getCompanyComplianceStatus(rows), "Expiring");
}
assert.equal(JSON.stringify(policies), policyBefore);
const card = loadFunctions(["src", "app", "contractors", "[id]", "page.tsx"], ["overallStatus"]);
for (const [rows, expected] of [
  [[], "Non-Compliant"],
  [[{ active: true, calculated_status: "Active" }], "Compliant"],
  [[{ active: true, calculated_status: "Expired" }], "Expired"],
  [[{ active: true, calculated_status: "Missing Information" }], "Missing Information"],
  [[{ active: true, calculated_status: "30 Day" }], "Expiring Soon"],
  [[{ active: false, calculated_status: "Expired" }, { active: true, calculated_status: "Active" }], "Compliant"],
]) assert.equal(card.overallStatus(rows), expected);
console.log("PASS: myCOI-only dashboard thresholds/company compliance and unchanged contractor-card overall compliance calculations");
