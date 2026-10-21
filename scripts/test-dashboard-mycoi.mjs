import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const file = new URL("../services/dashboard.ts", import.meta.url);
const source = fs.readFileSync(file, "utf8");
const insuranceSource = fs.readFileSync(new URL("../services/insurance.ts", import.meta.url), "utf8");
const functions = [source, insuranceSource].map((text) => {
  const syntax = ts.createSourceFile("fixture.ts", text, ts.ScriptTarget.Latest, true);
  return syntax.statements.filter((node) => ts.isFunctionDeclaration(node))
  .map((node) => {
    const text = node.getText(syntax);
    return text.startsWith("export ") ? text : `export ${text}`;
  }).join("\n");
}).join("\n");
let tables = {};
let failure = null;
const calls = [];
class Query {
  constructor(table) {
    this.table = table;
    this.filters = [];
    this.start = 0;
    this.end = Infinity;
    calls.push(this);
  }
  select(columns) { this.columns = columns; return this; }
  eq(key, value) {
    this.filters.push((row) => key.split(".").reduce((item, part) => item?.[part], row) === value);
    return this;
  }
  neq(key, value) { this.filters.push((row) => row[key] !== value); return this; }
  in(key, values) { this.ids = values; this.filters.push((row) => values.includes(row[key])); return this; }
  order() { return this; }
  range(start, end) { this.start = start; this.end = end; return this; }
  returns() { return this; }
  then(resolve, reject) {
    const rows = (tables[this.table] ?? []).filter((row) => this.filters.every((filter) => filter(row)));
    return Promise.resolve(this.table === failure
      ? { data: null, error: { message: "Synthetic read failure" } }
      : { data: rows.slice(this.start, this.end + 1), error: null, count: rows.length }).then(resolve, reject);
  }
}
const loaded = { exports: {} };
vm.runInNewContext(ts.transpileModule(functions, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText, {
  module: loaded, exports: loaded.exports,
  supabase: { from: (table) => new Query(table) },
  getAssignments: async () => ({ data: [], error: null }),
});
const dashboard = loaded.exports;
const compliance = [{
  contractor_id: 49, company_name: "Synthetic Aries fixture", contractor_active: true,
  compliance_record_id: 14, compliance_name: "NJ PWC", calculated_status: "Active",
}];
const policy = {
  id: 133, contractor_id: 49, policy_line: "General Liability", expiration_date: "2026-12-27",
  active: true, is_current: true, vendor: { contractor_id: 49, active: true },
};
const legacy = {
  contractor_id: 49, certificate_on_file: true, general_liability_on_file: true,
  general_liability_expiration_date: "2099-01-01", workers_comp_on_file: true,
  workers_comp_expiration_date: "2099-01-01",
};
const coverage = (rows, name = "General Liability") => rows.filter((row) => row.compliance_name === name);
const build = (policies) => dashboard.buildDashboardRecords(compliance, policies);
const snapshot = JSON.stringify({ policy, legacy, compliance });

let rows = build([policy]);
assert.equal(coverage(rows).length, 1);
assert.notEqual(coverage(rows)[0].calculated_status, "Missing Information");
assert.equal(coverage(rows)[0].expiration_date, "2026-12-27");
assert.ok(!rows.some((row) => row.compliance_name === "Certificate Of Insurance"), "Standalone certificate requirement retired");
assert.equal(coverage(build([]))[0].calculated_status, "Missing Information");
assert.equal(coverage(build([]))[0].expiration_date, null);
for (const change of [
  { active: false }, { is_current: false }, { expiration_date: null }, { policy_line: "Umbrella/Excess" },
  { vendor: { contractor_id: 49, active: false } },
  { vendor: { contractor_id: 999, active: true } },
  { contractor_id: 999, vendor: { contractor_id: 999, active: true } },
]) {
  assert.equal(coverage(build([{ ...policy, ...change }]))[0].calculated_status, "Missing Information");
  assert.equal(coverage(build([{ ...policy, ...change }]))[0].expiration_date, null);
}
assert.equal(coverage(build([{ ...policy, policy_line: "  GENERAL   LIABILITY " }])).length, 1);
for (const policies of [
  [policy, { ...policy, id: 134, expiration_date: "2026-11-30" }],
  [{ ...policy, id: 134, expiration_date: "2026-11-30" }, policy],
]) {
  assert.equal(coverage(build(policies)).length, 1);
  assert.equal(coverage(build(policies))[0].expiration_date, "2026-12-27");
}
const wc = { ...policy, id: 131, policy_line: "Workers Compensation" };
assert.equal(coverage(build([wc]), "Worker's Comp").length, 1);
assert.notEqual(coverage(build([wc]), "Worker's Comp")[0].calculated_status, "Missing Information");
assert.equal(coverage(build([{ ...wc, expiration_date: null }]), "Worker's Comp")[0].calculated_status, "Missing Information");
for (const [days, expected] of [[-1, "Expired"], [0, "Expired"], [15, "30 Day"], [45, "60 Day"], [75, "90 Day"], [120, "Active"]]) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  const expiration = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const record = coverage(build([{ ...policy, expiration_date: expiration }]))[0];
  assert.equal(record.calculated_status, expected);
  assert.equal(coverage(build([{ ...policy, expiration_date: expiration }])).length, 1);
}
assert.equal(JSON.stringify({ policy, legacy, compliance }), snapshot, "No source mutation");
console.log("PASS: myCOI-only GL/WC qualification, same-contractor mapping, latest expiry, retired COI, missing coverage and expiration thresholds");

tables = {
  contractor_compliance_status: compliance,
  mycoi_policies: [policy, wc],
};
let result = await dashboard.getDashboardData();
assert.equal(result.error, null);
assert.equal(coverage(result.data.records)[0].expiration_date, "2026-12-27");
assert.notEqual(coverage(result.data.records, "Worker's Comp")[0].calculated_status, "Missing Information");
tables.contractor_insurance = [{ ...legacy, certificate_on_file: true }];
result = await dashboard.getCompanyComplianceStatuses([49]);
assert.equal(result.error, null);
assert.equal(result.data.get(49), dashboard.getCompanyComplianceStatus(build([policy, wc])));
assert.ok(calls.every((query) => query.table !== "contractor_insurance"), "Legacy data never queried");
assert.ok(calls.some((query) => query.table === "mycoi_policies" && query.ids?.includes(49)), "Company statuses scope policies to requested contractors");

tables.mycoi_policies = Array.from({ length: 1001 }, (_, id) => ({ ...policy, id }));
result = await dashboard.getMycoiPolicies([49]);
assert.equal(result.data.length, 1001);
assert.ok(calls.some((query) => query.table === "mycoi_policies" && query.start === 1000));
assert.ok(calls.filter((query) => query.table === "mycoi_policies").every((query) => query.columns.includes("mycoi_vendor_mappings!inner")));
failure = "mycoi_policies";
for (const load of [() => dashboard.getDashboardData(), () => dashboard.getCompanyComplianceStatuses([49])]) {
  result = await load();
  assert.equal(result.data, null);
  assert.match(result.error.message, /Unable to load myCOI insurance: Synthetic read failure/);
}
console.log("PASS: both dashboard/status entry points, paginated mapped-policy reads, scoped contractor queries, and explicit query errors");
