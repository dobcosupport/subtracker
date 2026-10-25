import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
const read = (name) => fs.readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
class ApiError extends Error { constructor(message, status) { super(message); this.status = status; } }
const actor = "00000000-0000-0000-0000-000000000001";
let writable = true, canAdd = true, failRpc = null, lastRpc = null;
let run = { id: "00000000-0000-0000-0000-000000000010", revision: 1, finalized_at: null,
  file_name: "test.xlsx", source_rows: [{ row: 2, "Company (Vendor) > Name": "Fixture" }],
  decisions: { vendors: {} }, imported_rows: [] };
const reference = { token: "current", contractors: [], projects: [], contacts: [], vendors: [] };
let ready = [{ createContractor: true }];
const context = { profile: { auth_user_id: actor }, admin: { rpc: async (name, args) => {
  lastRpc = { name, args };
  if (failRpc) return { data: null, error: failRpc };
  return { data: name === "procore_save_review" ? run : name === "procore_list_import_runs" ? [] : { finalized_at: "fixture", assignments: 1 }, error: null };
} } };
const cache = new Map();
const modules = {
  "server-only": {},
  "@/lib/server-admin": {
    AdminApiError: ApiError, jsonError: (error) => Response.json({ error: error.message }, { status: error.status ?? 500 }),
    requireModulePermission: async (_request, _module, action) => {
      if (action === "add" && !canAdd) throw new ApiError("Add permission required", 403);
      return context;
    },
  },
  "@/lib/server-procore-import": {
    procoreContext: async (_request, write) => { if (write && !writable) throw new ApiError("View only", 403); return context; },
    procoreRun: async () => run, procoreReference: async () => reference,
    procoreResponse: async (_context, r) => ({ run: r, token: reference.token }),
    workingProcore: (r) => { if (r.finalized_at) throw new ApiError("Finalized — read-only", 409); },
    procoreError: (error) => { if (error) throw new ApiError(error.message, error.code === "40001" ? 409 : 503); },
  },
  "@/lib/procore-preview": { buildProcorePreview: () => ({ ready, summary: { contractors: 1, assignments: 1 } }), procoreVendorKey: (s) => s.toLowerCase() },
  "@/lib/procore-parser": { parseProcoreWorkbook: () => [] },
};
function load(name) {
  if (cache.has(name)) return cache.get(name);
  const mod = { exports: {} };
  vm.runInNewContext(ts.transpileModule(read(name), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { module: mod, exports: mod.exports, Request, Response, URL, Buffer,
    require: (id) => { if (Object.hasOwn(modules, id)) return modules[id]; throw Error(`Unexpected dependency ${id}`); } });
  cache.set(name, mod.exports); return mod.exports;
}
const helpers = load("src/lib/server-procore-import.ts");
modules["@/lib/server-procore-import"].validateProcoreDecisions = helpers.validateProcoreDecisions;
const routes = load("src/app/api/imports/procore/[id]/route.ts");
const finalize = load("src/app/api/imports/procore/[id]/finalize/route.ts");
const listing = load("src/app/api/imports/procore/route.ts");
const projects = load("src/app/api/imports/procore/[id]/projects/route.ts");
const params = { params: Promise.resolve({ id: run.id }) };
const request = (body, method = "POST") => new Request(`http://localhost/api/imports/procore/${run.id}`, {
  method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});
assert.throws(() => helpers.validateProcoreDecisions({ vendors: { unknown: { action: "ADD" } } }, run), /Unknown/);
assert.throws(() => helpers.validateProcoreDecisions({ vendors: { fixture: { action: "MATCH", contractorId: -1 } } }, run), /Choose/);
assert.throws(() => helpers.validateProcoreDecisions({ vendors: { fixture: { action: "ADD", unexpected: true } } }, run), /Choose/);
assert.equal(helpers.validateProcoreDecisions({ vendors: { fixture: { action: "UNMATCHED" } } }, run).vendors.fixture.action, "UNMATCHED");
const override = { contractorId: 9, companyName: "Fixture", approvedBy: "forged", approvedAt: "forged" };
const validatedOverride = helpers.validateProcoreDecisions({ vendors: { fixture: { action: "ADD", duplicateOverride: override } } }, run);
assert.deepEqual(JSON.parse(JSON.stringify(validatedOverride.vendors.fixture.duplicateOverride)), { contractorId: 9, companyName: "Fixture" },
  "Client cannot mint approval identity/time");
for (const invalid of [true, null, {}, { contractorId: -1, companyName: "Fixture" },
  { contractorId: 9, companyName: "" }, { contractorId: 9, companyName: "Fixture", bypass: true }]) {
  assert.throws(() => helpers.validateProcoreDecisions({ vendors: { fixture: { action: "ADD", duplicateOverride: invalid } } }, run), /override/);
}
const approve = { revision: 1, token: "current" };
assert.equal((await routes.POST(request({ ...approve, token: "stale" }), params)).status, 409);
assert.equal((await routes.POST(request({ ...approve, revision: 0 }), params)).status, 409);
assert.equal(lastRpc, null);
writable = false;
assert.equal((await routes.POST(request(approve), params)).status, 403); writable = true;
canAdd = false;
assert.equal((await routes.POST(request(approve), params)).status, 403); canAdd = true;
assert.equal((await routes.POST(request({ ...approve, plan: [{ contractorId: 9999 }], actor: "forged" }), params)).status, 200);
assert.equal(lastRpc.name, "procore_apply_import");
assert.equal(lastRpc.args.p_actor, actor);
assert.equal(lastRpc.args.p_plan, ready, "Client mutations never become trusted plan");
ready = [];
assert.equal((await routes.POST(request(approve), params)).status, 400);
ready = [{ createContractor: false }];
failRpc = { message: "Atomic import failed", code: "40001" };
assert.equal((await routes.POST(request(approve), params)).status, 409); failRpc = null;
assert.equal((await routes.PATCH(request({ revision: 0, decisions: { vendors: {} } }, "PATCH"), params)).status, 409);
assert.equal((await routes.PATCH(request({ revision: 1, decisions: { vendors: { fixture: { action: "ADD" } } } }, "PATCH"), params)).status, 200);
assert.equal(lastRpc.name, "procore_save_review"); assert.equal(lastRpc.args.p_actor, actor);
run.source_rows[0]["Project > Number"] = "25-900";
const mapRequest = { ...approve, number: "25-900", projectId: 45 };
assert.equal((await projects.PATCH(request(mapRequest, "PATCH"), params)).status, 200);
assert.equal(lastRpc.name, "procore_save_project_mapping");
assert.equal(lastRpc.args.p_project, 45); assert.equal(lastRpc.args.p_actor, actor);
assert.equal((await projects.PATCH(request({ ...mapRequest, projectId: null }, "PATCH"), params)).status, 200);
assert.equal((await projects.PATCH(request({ ...mapRequest, number: "25900" }, "PATCH"), params)).status, 400);
assert.equal((await projects.PATCH(request({ ...mapRequest, projectId: -1 }, "PATCH"), params)).status, 400);
assert.equal((await projects.PATCH(request({ ...mapRequest, revision: 0 }, "PATCH"), params)).status, 409);
writable = false;
assert.equal((await projects.PATCH(request(mapRequest, "PATCH"), params)).status, 403);
writable = true;
assert.equal((await finalize.POST(request(approve), params)).status, 409);
assert.equal((await finalize.POST(request({ ...approve, confirmed: true }), params)).status, 200);
assert.equal(lastRpc.name, "procore_finalize_import"); assert.equal(lastRpc.args.p_actor, actor);
run = { ...run, finalized_at: "fixture" };
assert.equal((await projects.PATCH(request(mapRequest, "PATCH"), params)).status, 409);
assert.equal((await routes.POST(request(approve), params)).status, 409);
assert.equal((await routes.PATCH(request({ revision: 1, decisions: { vendors: {} } }, "PATCH"), params)).status, 409);
assert.equal((await finalize.POST(request({ ...approve, confirmed: true }), params)).status, 409);
assert.equal((await routes.GET(new Request("http://localhost"), params)).status, 200);
assert.equal((await listing.GET(new Request("http://localhost/api/imports/procore?scope=garbage"))).status, 400);
assert.equal((await listing.GET(new Request("http://localhost/api/imports/procore?offset=-1"))).status, 400);
assert.equal((await listing.GET(new Request("http://localhost/api/imports/procore?scope=finalized&offset=20"))).status, 200);
assert.equal(lastRpc.args.p_finalized, true); assert.equal(lastRpc.args.p_offset, 20);
console.log("PASS: actual Procore route handlers enforce permissions, server actor/plan, revision/reference, Add permission, validated decisions, empty-ready rejection, explicit RPC failure, confirmed Finalize, finalized mutation refusal and scoped history pagination; no network or shared database.");
