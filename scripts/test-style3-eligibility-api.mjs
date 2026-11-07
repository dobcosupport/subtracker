import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const source = fs.readFileSync(new URL("../src/app/api/dashboard/eligibility/route.ts", import.meta.url), "utf8");
class AdminApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}
let allowed = true, failRpc = false, calls = [];
const contractors = Array.from({ length: 501 }, (_, i) => ({
  contractor_id: i + 1, company_name: `Company ${i + 1}`, applicability: i === 0 ? "applicable" : "not_applicable",
}));
const admin = {
  rpc(name, args) {
    calls.push({ name, args });
    if (failRpc) return Promise.resolve({ data: null, error: { message: "RPC missing" } });
    return Promise.resolve({ data: contractors.filter(row => row.contractor_id > args.p_after_id).slice(0, args.p_limit), error: null });
  },
  from(table) {
    let ids = null, filter = null;
    const query = {
      select() { return query; }, eq(column, value) { if (column === "compliance_name") filter = value; return query; },
      in(column, values) { if (column === "id" || column === "contractor_id") ids = values; return query; },
      order() { return query; }, range() { return query; },
      returns() {
        return Promise.resolve({ data: table === "compliance_types"
          ? [{ id: 1, compliance_name: "PWC", requires_expiration: true }]
          : table === "requirement_notification_rules" ? [{ compliance_type_id: 1, eligibility_authority: "nj_pwc_monitoring" }]
          : table === "contractors" ? (ids || []).map(id => ({ id, state: "CA", federal_tax_id: "present", nj_brc_number: null }))
          : table === "contractor_compliance_status" && filter === "NJ BRC" ? []
          : [{ contractor_id: 1, compliance_type_id: 1, compliance_record_id: 1, calculated_status: "Active",
            registration_number: "present", days_remaining: null }], error: null });
      },
      then(resolve, reject) {
        return Promise.resolve({ data: ["contractors", "projects", "compliance"].map(module => ({ module, can_view: allowed })), error: null }).then(resolve, reject);
      },
    };
    return query;
  },
};
const loadedModule = { exports: {} };
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
  module: loadedModule, exports: loadedModule.exports, Response,
  require(name) {
    if (name === "@/services/style3-overall-compliance") {
      return { calculateOverallContractorCompliance: (contractors, currentRequirements) => {
        const population = contractors.length;
        const compliant = contractors.filter(row => row.state === "CA"
          && row.federal_tax_id && currentRequirements.every(status => status.contractor_id === row.contractor_id)).length;
        return { population, compliant, nonCompliant: 0, expiringSoon: 0, needsReview: 0,
          rate: population ? compliant / population * 100 : null };
      } };
    }
    assert.equal(name, "@/lib/server-admin");
    return { AdminApiError, jsonError: error => Response.json({ error: error.message }, { status: error.status ?? 500 }),
      requireModulePermission: async () => ({ admin, profile: { system_administrator: false, role: "Test" } }) };
  },
});
const GET = loadedModule.exports.GET;
let response = await GET(new Request("http://localhost/api/dashboard/eligibility"));
assert.equal(response.status, 200);
let body = await response.json();
assert.equal(body.contractors.length, 501);
assert.deepEqual(calls.map(call => call.args.p_after_id), [0, 500]);
assert.deepEqual(body.known_type_ids, [1]);
assert.equal(body.statuses.length, 1);
assert.deepEqual(body.overall_compliance, { population: 501, compliant: 501, nonCompliant: 0,
  expiringSoon: 0, needsReview: 0, rate: 100 });
allowed = false;
calls = [];
response = await GET(new Request("http://localhost/api/dashboard/eligibility"));
assert.equal(response.status, 403);
assert.equal(calls.length, 0, "unauthorized requests cannot invoke the projection");
allowed = true;
failRpc = true;
response = await GET(new Request("http://localhost/api/dashboard/eligibility"));
body = await response.json();
assert.equal(response.status, 503);
assert.match(body.error, /RPC missing/);
console.log("Dashboard eligibility API: permissions, paging and failure handling passed.");
