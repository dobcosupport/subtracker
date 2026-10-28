import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const actor = "00000000-0000-4000-8000-000000000001";
const activeContact = "00000000-0000-4000-8000-000000000002";
class AdminApiError extends Error {
  constructor(message, status = 500) { super(message); this.status = status; }
}

let allowed = true;
let previewError = null;
let executeError = null;
let previewData;
let executeData;
let accessCalls = 0;
let rpcCalls = [];
let queryCalls = [];
const tableRows = {};

const companies = Array.from({ length: 15 }, (_, index) => ({
  id: 7001 + index,
  company_name: `Synthetic Company ${String(index + 1).padStart(2, "0")}`,
  city: "Synthetic City",
  state: "NJ",
  active: index % 2 === 0,
  merged_into_contractor_id: null,
}));
companies.push({
  id: 8001,
  company_name: "Archived predecessor",
  city: "Synthetic City",
  state: "NJ",
  active: false,
  merged_into_contractor_id: 7001,
});

class Query {
  constructor(table) {
    this.table = table;
    this.operations = [];
  }
  select(...args) { this.operations.push(["select", ...args]); return this; }
  is(...args) { this.operations.push(["is", ...args]); return this; }
  eq(...args) { this.operations.push(["eq", ...args]); return this; }
  in(...args) { this.operations.push(["in", ...args]); return this; }
  ilike(...args) { this.operations.push(["ilike", ...args]); return this; }
  order(...args) { this.operations.push(["order", ...args]); return this; }
  limit(...args) { this.operations.push(["limit", ...args]); return this; }
  range(...args) { this.operations.push(["range", ...args]); return this; }
  then(resolve, reject) {
    queryCalls.push({ table: this.table, operations: this.operations });
    let rows = this.table === "contractors" ? companies : tableRows[this.table] ?? [];
    for (const [operation, field, value] of this.operations) {
      if (operation === "is") rows = rows.filter((row) => (row[field] ?? null) === value);
      if (operation === "eq") rows = rows.filter((row) => row[field] === value);
      if (operation === "in") rows = rows.filter((row) => value.includes(row[field]));
      if (operation === "ilike") {
        const needle = String(value).replace(/^%|%$/g, "").toLowerCase();
        rows = rows.filter((row) => String(row[field] ?? "").toLowerCase().includes(needle));
      }
      if (operation === "limit") rows = rows.slice(0, field);
    }
    return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
  }
}

const admin = {
  from(table) { return new Query(table); },
  async rpc(name, args) {
    rpcCalls.push({ name, args });
    if (name === "company_merge_preview") {
      return previewError ? { data: null, error: previewError } : { data: structuredClone(previewData), error: null };
    }
    return executeError ? { data: null, error: executeError } : { data: structuredClone(executeData), error: null };
  },
};

const serverAdmin = {
  AdminApiError,
  async requireModulePermission(_request, module, action) {
    accessCalls += 1;
    assert.equal(module, "company_merge");
    assert.equal(action, "manage");
    if (!allowed) throw new AdminApiError("Dedicated permission required.", 403);
    return { admin, actor: { id: actor }, profile: { auth_user_id: actor, role: "Synthetic", system_administrator: false } };
  },
};

function loadRoute(file, dependencies) {
  const loaded = { exports: {} };
  const source = fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  });
  vm.runInNewContext(transpiled.outputText, {
    module: loaded,
    exports: loaded.exports,
    Request,
    Response,
    URL,
    require(name) {
      assert.ok(name in dependencies, `unexpected API route import: ${name}`);
      return dependencies[name];
    },
  });
  return loaded.exports;
}

const route = loadRoute("src/app/api/admin/company-merge/route.ts", { "@/lib/server-admin": serverAdmin });
const getRequest = (url) => new Request(`http://localhost${url}`);
const postRequest = (body) => new Request("http://localhost/api/admin/company-merge", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const json = (response) => response.json();
const plain = (value) => JSON.parse(JSON.stringify(value));

previewData = {
  primary: { id: 7001, company_name: "Synthetic Primary", city: "North" },
  secondary: { id: 7002, company_name: "Synthetic Secondary", city: "South" },
  snapshot: "synthetic-preview-snapshot",
  fields: ["company_name", "city"],
  counts: {},
  projects: { primary: 1, secondary: 1, shared: 0, union: 2 },
  compliance: [{
    compliance_type_id: 501,
    compliance_name: "Synthetic Compliance",
    records: [{ id: 601, contractor_id: 7001, registration_number: "SYN-REG", effective_date: null, expiration_date: null, registry_status: "Current" }],
  }],
  contacts: [{ id: activeContact, contractor_id: 7001, contact_name: "Synthetic Active Contact", is_primary_contact: true, is_active: true }],
  blockers: [],
};
executeData = { merge_id: "00000000-0000-4000-8000-000000000003", successor_id: 7001 };

allowed = false;
let response = await route.GET(getRequest("/api/admin/company-merge?search=Synthetic"));
assert.equal(response.status, 403);
response = await route.POST(postRequest({}));
assert.equal(response.status, 403);
assert.equal(rpcCalls.length, 0, "unauthorized requests never reach RPC");
assert.equal(accessCalls, 2, "both protected handlers checked the dedicated permission");
allowed = true;

response = await route.GET(getRequest("/api/admin/company-merge?search=Synthetic"));
let body = await json(response);
assert.equal(response.status, 200);
assert.equal(body.candidates.length, 12, "name search has a bounded first page");
assert(!body.candidates.some((candidate) => candidate.id === 8001), "archived predecessors are excluded");
const searchQuery = queryCalls.at(-1);
assert.deepEqual(searchQuery.operations.find(([name]) => name === "is"), ["is", "merged_into_contractor_id", null]);
assert.deepEqual(searchQuery.operations.find(([name]) => name === "limit"), ["limit", 12]);
assert(!searchQuery.operations.some(([name]) => name === "range"), "candidate endpoint does not expose unbounded paging");

response = await route.GET(getRequest("/api/admin/company-merge?primary=7001&secondary=7002"));
body = await json(response);
assert.equal(response.status, 200);
assert.deepEqual(plain(rpcCalls.at(-1)), {
  name: "company_merge_preview",
  args: { p_primary: 7001, p_secondary: 7002, p_actor: actor },
});
previewData.blockers = ["An unfinished import explicitly selects a predecessor. Remove that decision or finalize the import first."];
response = await route.GET(getRequest("/api/admin/company-merge?primary=7001&secondary=7002"));
body = await json(response);
assert.equal(response.status, 200, "a merge blocker does not turn a read-only preview into an API error");
assert.deepEqual(body.blockers, previewData.blockers, "preview returns blocker details for the UI");
assert.deepEqual(body.blockerDetails, [], "unmatched blocker records retain the generic safeguard message");
previewData.blockers = [];

const syncBlocker = "Open sync review or exception. Resolve it through the existing workflow before merging.";
tableRows.nj_pwc_sync_exceptions = [{
  id: 274, contractor_id: 7002, is_test: false, reason: "Multiple Matches", kind: "failure", status: "open",
  consecutive_failure_count: 2, occurrences: 2, last_run_id: 135, last_search_request_id: 3888, review_queue_id: null,
  details: { candidate_count: 32 }, updated_at: "2026-10-28T08:10:55Z",
}];
tableRows.compliance_sync_search_requests = [{
  id: 3888, status: "completed", result_status: "Multiple Matches", searched_company_name: "Synthetic Secondary",
  searched_zip_code: "11249", searched_city: "Brooklyn", searched_state: "NY",
  completed_at: "2026-10-28T08:10:00Z", imported_at: null, selected_candidate: null,
  sync_run_id: 134, origin: "daily_sync",
  candidates: [
    { business_name: "Synthetic Candidate A", certificate_number: "123456" },
    { business_name: "Synthetic Candidate B", certificate_number: "654321" },
    ...Array.from({ length: 30 }, (_, index) => ({ business_name: `Other Candidate ${index + 1}`, certificate_number: String(700000 + index) })),
  ],
}];
previewData.blockers = [syncBlocker];
response = await route.GET(getRequest("/api/admin/company-merge?primary=7001&secondary=7002"));
body = await json(response);
assert.equal(response.status, 200);
assert.deepEqual(body.blockers, [syncBlocker], "detailed blocker diagnostics preserve the database safety blocker");
assert.equal(body.blockerDetails.length, 1);
assert.deepEqual(plain(body.blockerDetails[0]), {
  blocker: syncBlocker, company_id: 7002, company_name: "Synthetic Secondary", source: "NJ PWC",
  record_type: "NJ PWC Sync Exception", record_id: 274, status: "open", reason: "Multiple Matches",
  context: "failure · Production record · 2 consecutive failures · 2 occurrences · Candidates: Synthetic Candidate A (123456); Synthetic Candidate B (654321); Other Candidate 1 (700000).",
  resolution_path: "/admin/compliance-sync", resolution_label: "Open Compliance Sync → NJ PWC Sync Exceptions",
  resolution_actions: [
    { label: "Select Match", guidance: "Only select a candidate if you have evidence it is this contractor.", href: "/admin/compliance-sync" },
    { label: "Run Search Again", guidance: "Consider this after correcting company information or when a new search could return a different result.", href: "/admin/compliance-sync" },
    { label: "Resolve Exception", guidance: "Use when the search has been reviewed and no valid registration match should be assigned.", href: "/admin/compliance-sync" },
    { label: "Open Contractor", guidance: "Review or correct the contractor's company information before searching again.", href: "/contractors/7002" },
  ],
  nj_pwc: {
    search_request_id: 3888, sync_run_id: 135, searched_company_name: "Synthetic Secondary",
    searched_city: "Brooklyn", searched_state: "NY", searched_zip_code: "11249",
    candidate_count: 32, selected_match: null,
  },
});
assert(queryCalls.slice(-3).some((call) => call.table === "nj_pwc_sync_exceptions"),
  "preview diagnostics read the source exception record without changing it");
assert(queryCalls.some((call) => call.table === "compliance_sync_search_requests"
  && call.operations.some(([name, value]) => name === "select" && value.includes("sync_run_id"))
  && call.operations.some(([name, value]) => name === "select" && value.includes("selected_candidate"))),
  "preview reads run/search identifiers and candidate-selection state");
tableRows.compliance_sync_search_requests[0].imported_at = "2026-10-28T08:15:00Z";
tableRows.compliance_sync_search_requests[0].selected_candidate = {
  business_name: "Synthetic Candidate A", certificate_number: "123456",
};
response = await route.GET(getRequest("/api/admin/company-merge?primary=7001&secondary=7002"));
body = await json(response);
assert.equal(body.blockerDetails[0].nj_pwc.selected_match, "Synthetic Candidate A · 123456");
assert(!body.blockerDetails[0].resolution_actions.some(({ label }) => label === "Select Match"),
  "Select Match is omitted after a candidate has already been selected");
previewData.blockers = [];
delete tableRows.nj_pwc_sync_exceptions;
delete tableRows.compliance_sync_search_requests;

const importBlocker = "An unfinished import explicitly selects a predecessor. Remove that decision or finalize the import first.";
tableRows.mycoi_import_runs = [{
  id: "run-7002", file_name: "synthetic.xlsx", status: "Partial", revision: 3, finalized_at: null,
  decisions: { vendors: { "synthetic vendor": 7002 } }, updated_at: "2026-10-28T08:00:00Z",
}];
tableRows.procore_import_runs = [{
  id: "procore-run-7001", file_name: "synthetic-procore.xlsx", status: "Review", revision: 4, finalized_at: null,
  decisions: { vendors: { "synthetic contractor": { action: "MATCH", contractorId: "7001" } } },
  updated_at: "2026-10-28T08:05:00Z",
}];
previewData.blockers = [importBlocker];
response = await route.GET(getRequest("/api/admin/company-merge?primary=7001&secondary=7002"));
body = await json(response);
assert.equal(response.status, 200);
assert.deepEqual(body.blockerDetails.map((detail) => [detail.source, detail.company_id, detail.record_id, detail.reason, detail.resolution_path]), [
  ["MyCOI", 7002, "run-7002", "Saved MATCH decision for synthetic vendor", "/imports"],
  ["Procore", 7001, "procore-run-7001", "Saved MATCH decision for synthetic contractor", "/imports"],
], "unfinished MyCOI and Procore decisions identify their run and matched company separately");
previewData.blockers = [];
delete tableRows.mycoi_import_runs;
delete tableRows.procore_import_runs;

const validPayload = () => ({
  primary: 7001,
  secondary: 7002,
  snapshot: previewData.snapshot,
  choices: { company_name: "secondary", city: "primary" },
  compliance: { "501": 601 },
  primary_contact: activeContact,
  operation: "00000000-0000-4000-8000-000000000004",
  confirmed: true,
});

const rpcCountBeforeValidation = rpcCalls.length;
const executeCountBeforeValidation = rpcCalls.filter(({ name }) => name === "company_merge_execute").length;
const queryCountBeforeValidation = queryCalls.length;
for (const invalidBody of [
  { ...validPayload(), raw_company_name: "trust this client value" },
  { ...validPayload(), choices: { company_name: "client supplied scalar value", city: "primary" } },
  { ...validPayload(), compliance: {} },
  { ...validPayload(), primary_contact: "00000000-0000-4000-8000-000000000005" },
  { ...validPayload(), confirmed: false },
  { ...validPayload(), primary: 7001, secondary: 7001 },
]) {
  response = await route.POST(postRequest(invalidBody));
  assert.equal(response.status, 400, "invalid mutation payload is rejected");
}
assert.equal(rpcCalls.filter(({ name }) => name === "company_merge_execute").length, executeCountBeforeValidation,
  "invalid mutation payloads never invoke the execute RPC");
assert.equal(queryCalls.length, queryCountBeforeValidation, "invalid mutations perform no direct table writes");
assert(rpcCalls.length >= rpcCountBeforeValidation, "invalid mutation validation may perform only read-only preview RPCs");

response = await route.POST(postRequest(validPayload()));
body = await json(response);
assert.equal(response.status, 200);
assert.deepEqual(body, executeData);
assert.deepEqual(plain(rpcCalls.slice(-2)), [
  { name: "company_merge_preview", args: { p_primary: 7001, p_secondary: 7002, p_actor: actor } },
  {
    name: "company_merge_execute",
    args: {
      p_primary: 7001,
      p_secondary: 7002,
      p_snapshot: previewData.snapshot,
      p_choices: { company_name: "secondary", city: "primary" },
      p_compliance: { "501": 601 },
      p_primary_contact: activeContact,
      p_operation: validPayload().operation,
      p_confirmed: true,
      p_actor: actor,
    },
  },
], "execute sends selector values only and derives the actor on the server");

executeData = { ...executeData, already_processed: true };
response = await route.POST(postRequest(validPayload()));
assert.equal(response.status, 200);
assert.deepEqual(await json(response), executeData, "exact replay response is returned without success fallback");

for (const [code, status] of [["40001", 409], ["55000", 409], ["55P03", 409], ["40P01", 409], ["42501", 403], ["22023", 400]]) {
  executeError = { code, message: `Synthetic ${code} failure` };
  response = await route.POST(postRequest(validPayload()));
  assert.equal(response.status, status, `${code} maps to HTTP ${status}`);
}
executeError = null;
previewError = { code: "PGRST202", message: "Could not find company_merge_preview function" };
response = await route.GET(getRequest("/api/admin/company-merge?primary=7001&secondary=7002"));
assert.equal(response.status, 503, "missing migration maps to 503");
previewError = null;

executeData = null;
response = await route.POST(postRequest(validPayload()));
assert.equal(response.status, 503, "empty execute RPC cannot masquerade as success");
executeData = { merge_id: "00000000-0000-4000-8000-000000000003", successor_id: 7001 };

console.log("PASS: actual transpiled Company Merge GET/POST handlers; synthetic VM only, no database/network. Coverage includes permission gate, archived exclusion and cap, actor derivation, strict validation, preview/execute/replay payloads, and all requested database error mappings.");
