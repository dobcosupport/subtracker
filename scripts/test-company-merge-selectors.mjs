import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { test } from "node:test";

const companies = [
  { id: 9001, company_name: "Archived Original", external_id: "OLD", nj_pwc_number: "OLD-PWC", active: false, merged_into_contractor_id: 9003 },
  { id: 9002, company_name: "Ordinary Inactive", external_id: "INACTIVE", nj_pwc_number: null, active: false, merged_into_contractor_id: null },
  { id: 9003, company_name: "Merged Successor", external_id: "NEW", nj_pwc_number: "NEW-PWC", active: true, merged_into_contractor_id: null },
];
let databaseError = null;
const calls = [];
class Query {
  constructor(table) { this.table = table; this.filters = []; this.start = 0; this.end = Infinity; }
  select() { return this; }
  is(field, value) { calls.push({ field, value }); this.filters.push((row) => row[field] === value); return this; }
  eq(field, value) { this.filters.push((row) => row[field] === value); return this; }
  neq(field, value) { this.filters.push((row) => row[field] !== value); return this; }
  ilike(field, value) { this.filters.push((row) => row[field].toLowerCase().includes(value.replaceAll("%", "").toLowerCase())); return this; }
  order() { return this; }
  range(start, end) { this.start = start; this.end = end; return this; }
  rows() { return (this.table === "contractors" ? companies : []).filter((row) => this.filters.every((filter) => filter(row))).slice(this.start, this.end + 1); }
  then(resolve, reject) { return Promise.resolve({ data: databaseError ? null : this.rows(), error: databaseError }).then(resolve, reject); }
}
const admin = { from: (table) => new Query(table) };
const load = (file, dependencies = {}) => {
  const loaded = { exports: {} };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, {
    module: loaded, exports: loaded.exports, Request, Response, URL,
    require: (name) => {
      assert(Object.hasOwn(dependencies, name), `Unexpected module: ${name}`);
      return dependencies[name];
    },
    fetch: () => { throw new Error("Network is forbidden in selector regressions"); },
  });
  return loaded.exports;
};
const matching = load("src/lib/contractor-matching.ts");
const imports = load("services/imports.ts", { xlsx: {}, "@/lib/supabase": { supabase: admin }, "@/lib/contractor-matching": matching });
const tiers = load("services/tieredSubs.ts", { "@/lib/supabase": { supabase: admin } });
class AdminApiError extends Error { constructor(message, status = 500) { super(message); this.status = status; } }
let allowed = true;
const compose = load("src/app/api/communications/compose-options/route.ts", {
  "@/lib/server-admin": {
    AdminApiError, requireModulePermission: async (_request, module, action) => {
      assert.equal(module, "contractors"); assert.equal(action, "view");
      if (!allowed) throw new AdminApiError("Permission denied", 403);
    },
  },
  "@/lib/server-communication-compose": { requireCompose: async () => ({ admin }) },
  "@/lib/server-communications": {
    checkDatabaseError: (error) => { if (error) throw new AdminApiError(error.message, 503); },
    communicationError: (error) => Response.json({ error: error.message }, { status: error.status ?? 500 }),
  },
  "@/lib/server-communication-history": {},
  "@/lib/email-provider": {},
  "@/lib/server-email-provider": {},
});

test("generic import references exclude merged originals, retain ordinary inactive companies and fail explicitly", async () => {
  const reference = await imports.fetchReferenceData();
  assert.equal(reference.contractorsByExternalId.has("old"), false);
  assert.equal(reference.contractorsByNjPwcNumber.has("OLD-PWC"), false);
  assert.equal(reference.contractorsByName.has(matching.normalizeCompanyName("Archived Original")), false);
  assert.equal(reference.contractorsByExternalId.get("inactive").id, 9002);
  assert.equal(reference.contractorsByExternalId.get("new").id, 9003);
  databaseError = { message: "Synthetic missing merge migration" };
  try { await assert.rejects(imports.fetchReferenceData(), /Unable to load current company references/); }
  finally { databaseError = null; }
});
test("tier selector excludes merged predecessors and otherwise preserves active-only behavior", async () => {
  const { data, error } = await tiers.getAvailableTieredSubContractors(9999);
  assert.equal(error, null);
  assert.deepEqual(Array.from(data, (row) => row.id), [9003]);
});
test("Communications compose excludes merged originals without hiding ordinary inactive companies", async () => {
  const response = await compose.GET(new Request("http://localhost/api/communications/compose-options?kind=contractors"));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).rows.map((row) => row.id), [9002, 9003]);
  assert(calls.some((call) => call.field === "merged_into_contractor_id" && call.value === null));
});
test("Communications selector preserves permission failures and truthful database errors", async () => {
  allowed = false;
  assert.equal((await compose.GET(new Request("http://localhost/?kind=contractors"))).status, 403);
  allowed = true;
  databaseError = { message: "Synthetic migration missing" };
  try {
    const response = await compose.GET(new Request("http://localhost/?kind=contractors"));
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /migration missing/);
  } finally { databaseError = null; }
});
