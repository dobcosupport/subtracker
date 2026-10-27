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
  ilike(...args) { this.operations.push(["ilike", ...args]); return this; }
  order(...args) { this.operations.push(["order", ...args]); return this; }
  limit(...args) { this.operations.push(["limit", ...args]); return this; }
  range(...args) { this.operations.push(["range", ...args]); return this; }
  then(resolve, reject) {
    queryCalls.push({ table: this.table, operations: this.operations });
    let rows = this.table === "contractors" ? companies : [];
    for (const [operation, field, value] of this.operations) {
      if (operation === "is") rows = rows.filter((row) => (row[field] ?? null) === value);
      if (operation === "eq") rows = rows.filter((row) => row[field] === value);
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
