import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

function load(file, dependencies = {}) {
  const loaded = { exports: {} };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL(file, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, { module: loaded, exports: loaded.exports, require(name) {
    assert.ok(name in dependencies, `Unexpected dependency ${name}`);
    return dependencies[name];
  } });
  return loaded.exports;
}
const metrics = load("../services/style3-compliance-metrics.ts");
const { summarizeDashboardCompliance } = load("../services/style3-dashboard-compliance.ts", {
  "@/services/style3-compliance-metrics": metrics,
  "@/lib/admin-client": {},
  "@/lib/followup-related-item": { insuranceRelatedItems: [{ key: "general_liability" }, { key: "workers_compensation" }] },
});
const data = {
  contractors: [
    { contractor_id: 1, company_name: "Eligible", applicability: "applicable" },
    { contractor_id: 2, company_name: "Material", applicability: "not_applicable" },
    { contractor_id: 3, company_name: "Expired", applicability: "applicable" },
    { contractor_id: 4, company_name: "Missing", applicability: "applicable" },
  ],
  requirements: [{ id: 1, compliance_name: "Registration", requires_expiration: true },
    { id: 2, compliance_name: "Non-expiring registration", requires_expiration: false }],
  known_type_ids: [1],
  statuses: [{ contractor_id: 1, compliance_type_id: 1, compliance_record_id: 1,
    expiration_date: "2026-12-01", days_remaining: 24, calculated_status: "30 Day" },
  { contractor_id: 3, compliance_type_id: 1, compliance_record_id: 2,
    expiration_date: "2026-01-01", days_remaining: -1, calculated_status: "Expired" }],
  overall_compliance: { population: 4, compliant: 0, nonCompliant: 2, expiringSoon: 0, needsReview: 2, rate: 0 },
};
const result = JSON.parse(JSON.stringify(summarizeDashboardCompliance(data)));
assert.equal(result.population, 4);
assert.deepEqual(result.metric, { knownCurrent: 1, knownDeficient: 1, needsReview: 4, percentage: 50 });
assert.deepEqual(result.knownRequirements, ["Registration"]);
assert.equal(result.njPwc, null, "other authorities must not be presented as NJ PWC");
assert.equal(result.expirations.length, 1);
assert.equal(result.expirations[0].contractorId, 1);
assert.deepEqual(result.exceptions.map(row => [row.contractorId, row.status]), [[3, "Expired"], [4, "Needs Review"]]);
data.statuses.push({ contractor_id: 4, compliance_type_id: 1, compliance_record_id: 4,
  expiration_date: "2026-12-10", days_remaining: 33, calculated_status: "Missing Information" });
assert.equal(summarizeDashboardCompliance(data).expirations.length, 1, "unknown status is not a current expiration");
data.statuses.push({ ...data.statuses[0], compliance_record_id: 3 });
assert.equal(summarizeDashboardCompliance(data).metric.percentage, 0, "ambiguous current records are not treated as current");
assert.equal(summarizeDashboardCompliance(data).expirations.length, 0);
data.requirements[0].compliance_name = "NJ PWC";
data.statuses.pop();
const njPwc = summarizeDashboardCompliance(data).njPwc;
assert.deepEqual(JSON.parse(JSON.stringify(njPwc)), { current: 1, expired: 1, expiring: 1 });
data.known_type_ids = [];
assert.equal(summarizeDashboardCompliance(data).njPwc, null, "unconfigured authority is not reported as zero");
console.log("Dashboard compliance: known authority, unknown scope, missing and ambiguous records passed.");
