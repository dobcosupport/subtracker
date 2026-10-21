import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import * as XLSX from "xlsx";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const clone = (value) => JSON.parse(JSON.stringify(value));
const profile = { auth_user_id: "00000000-0000-0000-0000-000000000001", name: "Synthetic", email: "synthetic@example.invalid", role: "Synthetic Role", system_administrator: false };
const modules = ["imports", "insurance", "contractors", "projects"];
let permissions = modules.map((module) => ({ module, can_view: true, can_add: true, can_edit: true }));
let run = null, authenticated = true, failRpc = false, loseRevisionRace = false, applications = 0;
let lastApplication = null;
const reference = { token: "reference-v1", contractors: [{ id: 1, company_name: "GEO-INSTRUMENTS", active: true }],
  projects: [{ id: 1, project_number: "22002", project_name: "Synthetic School" }],
  vendors: [], divisions: [], policies: [], statuses: [], links: [] };
class AdminApiError extends Error { constructor(message, status) { super(message); this.status = status; } }
class Query {
  constructor(table) { this.table = table; this.filters = []; this.mode = "read"; }
  select() { return this; }
  eq(field, value) { this.filters.push([field, value]); return this; }
  order() { return this; }
  range() { return this; }
  insert(data) { this.mode = "insert"; this.data = clone(data); return this; }
  update(data) { this.mode = "update"; this.data = clone(data); return this; }
  async single() { return this.execute(true); }
  async maybeSingle() { return this.execute(true); }
  then(resolve, reject) { return Promise.resolve(this.execute(false)).then(resolve, reject); }
  execute(single) {
    if (this.table === "role_permissions") return { data: clone(permissions), error: null };
    assert.equal(this.table, "mycoi_import_runs", "Application must not mutate contractor/project/legacy tables");
    if (this.mode === "insert") run = { ...this.data, id: "00000000-0000-0000-0000-000000000010", revision: 1, status: "Review", imported_rows: [],
      imported_vendor_keys: [], imported_policy_ids: [], import_history_id: null, source_row_count: this.data.source_rows.length };
    if (this.mode === "update") {
      if (loseRevisionRace || this.filters.some(([field, value]) => run[field] !== value)) return { data: null, error: null };
      Object.assign(run, this.data);
    }
    return { data: clone(single ? run : run ? [run] : []), error: null };
  }
}
const admin = { from: (table) => new Query(table), rpc: async (name, args) => {
  if (name === "mycoi_import_reference") return { data: clone(reference), error: null };
  assert.equal(name, "mycoi_apply_import");
  if (failRpc) return { error: { code: "40001", message: "Concurrent import; refresh preview." } };
  assert.equal(args.p_actor, profile.auth_user_id);
  lastApplication = clone(args);
  const plan = args.p_plan[0] ?? args.p_snapshot[0];
  assert.equal(plan.contractorId, 1, "Server recomputes the plan; untrusted client plans ignored");
  assert.equal(plan.policies[0].expiration, "2027-06-01");
  if (args.p_plan.length) assert.ok(args.p_audits.some((event) => event.action === "MYCOI_MAPPINGS_ACCEPTED"));
  assert.ok(args.p_audits.every((event) => event.user_id === profile.auth_user_id));
  applications++; run.imported_rows = [2]; run.revision++; run.import_history_id = 1; run.status = "Complete";
  return { data: {}, error: null };
} };
const serverAdmin = { AdminApiError, jsonError: (error) => Response.json({ error: error.message }, { status: error.status ?? 500 }),
  requireModulePermission: async (_request,module,action) => {
    if (!authenticated) throw new AdminApiError("Authentication required.", 401);
    if (module === "contractors" && action === "add" && !permissions.find((p)=>p.module==="contractors")?.can_add) throw new AdminApiError("Contractors Add permission required.",403);
    return { admin, profile };
  } };
const cache = new Map();
function load(relative) {
  if (cache.has(relative)) return cache.get(relative);
  const output = { exports: {} }; cache.set(relative, output.exports);
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(root, relative), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, { exports: output.exports, module: output, Response, Request, File, FormData, URL, Error, Date, Buffer,
    require: (name) => {
      if (name === "server-only") return {};
      if (name === "@/lib/server-admin") return serverAdmin;
      if (name === "xlsx") return XLSX;
      if (name.startsWith("@/types/")) return load(`types\\${name.slice(8)}.ts`);
      if (name.startsWith("@/lib/")) return load(`src\\lib\\${name.slice(6)}.ts`);
      throw new Error(`Unexpected dependency ${name}`);
    } });
  return output.exports;
}
const list = load("src\\app\\api\\imports\\mycoi\\route.ts");
const detail = load("src\\app\\api\\imports\\mycoi\\[id]\\route.ts");
const helpers = load("src\\lib\\server-mycoi-import.ts");
const request = (method = "GET", body, query = "") => new Request(`http://localhost/api/imports/mycoi${query}`, {
  method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
});
const params = () => ({ params: Promise.resolve({ id: run.id }) });
authenticated = false;
assert.equal((await list.GET(request())).status, 401); assert.equal(run, null);
authenticated = true;
assert.equal((await list.GET(request("GET", undefined, "?offset=-1"))).status, 400);
permissions[1].can_view = false;
assert.equal((await list.GET(request())).status, 403);
permissions[1].can_view = true; permissions[1].can_edit = false;
assert.equal((await list.POST(request("POST", {}))).status, 403); assert.equal(run, null);
assert.equal((await list.GET(request())).status, 200);
permissions[1].can_edit = true;
const upload = (content, name) => {
  const form = new FormData(); form.set("file", new File([content], name));
  return list.POST(new Request("http://localhost/api/imports/mycoi", { method: "POST", body: form }));
};
assert.equal((await upload("wrong", "bad.exe")).status, 400); assert.equal(run, null);
assert.equal((await upload("Wrong Header\nx", "bad.csv")).status, 400);
const headings = load("types\\mycoi-import.ts").MYCOI_HEADINGS;
const source = ["22002 - Synthetic School", "GEO-Instruments", "zeid.alkas@geo-instruments.com", "9735577667", "Compliant Finalized",
  "policyNumber: SYN-1; expirationDate: 06/01/2027; isExpired: false; policyLines: General Liability"];
const csv = XLSX.utils.sheet_to_csv(XLSX.utils.aoa_to_sheet([headings, source]));
const uploaded = await upload(csv, "synthetic.csv");
assert.equal(uploaded.status, 200);
const uploadPreview = (await uploaded.json()).preview;
assert.equal(uploadPreview.ready.length, 0, "Suggestions cannot auto-accept");
assert.equal(uploadPreview.rowPolicies[2].policies[0].policyNumber, "SYN-1", "Presentation exposes actual parser output before matching");
assert.equal(uploadPreview.rowPolicies[2].policies[0].expirationDate, "2027-06-01");
assert.equal(uploadPreview.rowPolicies[2].raw, source[5], "Raw source remains exact");
assert.equal(applications, 0);
const decisions = { vendors: { "geo-instruments": 1 }, divisions: {}, contacts: {}, ignored: [] };
assert.throws(() => helpers.validateDecisions({ ...decisions, vendors: { unknown: 1 } }, run), /Unknown source/);
assert.throws(() => helpers.validateDecisions({ ...decisions, ignored: [999] }, run), /ignored/);
assert.throws(() => helpers.validateDecisions({ ...decisions, contacts: { "geo-instruments": { arbitrary: "x" } } }, run), /contact selection/);
assert.equal((await detail.PATCH(request("PATCH", { revision: 0, decisions }), params())).status, 409);
loseRevisionRace = true;
assert.equal((await detail.PATCH(request("PATCH", { revision: 1, decisions }), params())).status, 409);
loseRevisionRace = false;
const saved = await detail.PATCH(request("PATCH", { revision: 1, decisions }), params());
assert.equal(saved.status, 200); assert.equal((await saved.json()).preview.ready.length, 1);
assert.equal(run.revision, 2);
assert.equal(run.decisions.vendors["geo-instruments"], 1);
assert.equal(reference.vendors.length, 0, "Accepting stages only; permanent mapping is not written by PATCH");
assert.equal(run.source_rows[0]["Vendor Name"], "GEO-Instruments");
assert.equal(reference.contractors[0].company_name, "GEO-INSTRUMENTS");
assert.equal((await detail.POST(request("POST", { revision: 2, token: "stale" }), params())).status, 409);
failRpc = true;
assert.equal((await detail.POST(request("POST", { revision: 2, token: reference.token }), params())).status, 409);
assert.equal(applications, 0);
failRpc = false;
const applied = await detail.POST(request("POST", { revision: 2, token: reference.token, plan: [{ contractorId: 999 }] }), params());
assert.equal(applied.status, 200); assert.equal(applications, 1);
assert.equal(lastApplication.p_snapshot, null, "Ordinary ready-vendor import cannot globally synchronize projects");
const accepted = await detail.POST(request("POST", {
  revision: run.revision, token: reference.token, acceptCompleteSnapshot: true,
  snapshot: [{ contractorId: 999, divisions: [] }],
}), params());
assert.equal(accepted.status, 200);
assert.equal(lastApplication.p_plan.length, 0, "Previously imported rows are not duplicated");
assert.equal(lastApplication.p_snapshot[0].contractorId, 1, "Complete source snapshot is recomputed server-side, including previously imported rows");
const applicationCount = applications;
run.decisions.ignored = [2];
assert.equal((await detail.POST(request("POST", { revision: run.revision, token: reference.token, acceptCompleteSnapshot: true }), params())).status, 400);
run.decisions.ignored = [];
run.source_rows[0]["Vendor Name"] = "Unresolved";
assert.equal((await detail.POST(request("POST", { revision: run.revision, token: reference.token, acceptCompleteSnapshot: true }), params())).status, 400);
run.source_rows[0]["Vendor Name"] = "GEO-Instruments";
assert.equal(applications, applicationCount, "Ignored/unresolved complete submissions never call the mutation RPC");
run.source_rows[0]["Vendor Name"] = "New Company For Creation";
run.imported_rows=[];
run.decisions={...decisions,vendors:{},addContractors:["new company for creation"]};
permissions.find((p)=>p.module==="contractors").can_add=false;
assert.equal((await detail.POST(request("POST",{revision:run.revision,token:reference.token}),params())).status,403,
  "Creating requires Contractors Add even when ordinary matching imports are allowed");
assert.equal(applications,applicationCount,"Add denied before mutation RPC");
assert.throws(()=>helpers.validateDecisions({...run.decisions,vendors:{"new company for creation":1}},run),/not both/);
assert.throws(()=>helpers.validateDecisions({...run.decisions,addContractors:["not a source name"]},run),/Invalid Add Contractor/);
assert.equal((await detail.GET(request(), params())).status, 200);
assert.equal((await list.GET(request())).status, 200);
console.log("PASS: real route/helper handlers with isolated adapters: authentication, multi-module read/write permissions, multipart validation/staging, explicit suggestions, decision validation, optimistic review races, stale snapshot/RPC conflicts, server-recomputed plans/audits, history/resume; no network/database access");
