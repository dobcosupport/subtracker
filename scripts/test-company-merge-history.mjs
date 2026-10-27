import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";

// Synthetic route/service/component fixtures only: no environment, network or database writes.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const routePath = "src\\app\\api\\contractors\\[id]\\merge-history\\route.ts";
function load(relative, dependencies) {
  const compiled = ts.transpileModule(fs.readFileSync(path.join(root, relative), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const loaded = { exports: {} };
  vm.runInNewContext(compiled, {
    module: loaded, exports: loaded.exports, Request, Response, URL, URLSearchParams, AbortController,
    require(name) { assert.ok(name in dependencies, `Unexpected import: ${name}`); return dependencies[name]; },
  }, { filename: relative });
  return loaded.exports;
}
class AdminApiError extends Error {
  constructor(message, status = 500) { super(message); this.status = status; }
}
const actor = "00000000-0000-4000-8000-000000000001";
const company = (id, successor = null) => ({ id, company_name: `Synthetic Company ${id}`, merged_into_contractor_id: successor });
const receipt = (id, primary, secondary, successor) => ({
  id: `00000000-0000-4000-9000-${String(id).padStart(12, "0")}`,
  primary_id: primary, secondary_id: secondary, successor_id: successor, actor_id: actor, merged_at: "2026-10-27T12:00:00Z",
  snapshot: { tax_id: "SECRET" }, choices: { private: "SECRET" },
});
const base = () => ({
  contractors: [company(1, 3), company(2, 3), company(3), company(99)],
  company_merges: [receipt(1, 1, 2, 3)],
  user_profiles: [{ auth_user_id: actor, name: "Synthetic Merger", email: "SECRET@example.test" }],
  role_permissions: [],
});
function splitColumns(text) {
  let depth = 0, start = 0;
  const result = [];
  for (let index = 0; index < text.length; index++) {
    if (text[index] === "(") depth++;
    if (text[index] === ")") depth--;
    if (text[index] === "," && depth === 0) { result.push(text.slice(start, index)); start = index + 1; }
  }
  result.push(text.slice(start));
  return result;
}
function project(row, columns) {
  if (columns === "*") return { ...row };
  const result = {};
  for (const column of splitColumns(columns)) {
    const json = column.match(/^(\w+):(\w+)->>(\w+)$/);
    if (json) { result[json[1]] = row[json[2]]?.[json[3]] ?? null; continue; }
    const nested = column.match(/^(\w+):[^()]+\((.*)\)$/);
    if (nested) { result[nested[1]] = row[nested[1]] ? project(row[nested[1]], nested[2]) : null; continue; }
    result[column] = row[column] ?? null;
  }
  return result;
}
function fakeAdmin(tables, errors = {}) {
  const calls = [];
  const fieldValue = (row, field) => field.includes("->>")
    ? String(row[field.split("->>")[0]]?.[field.split("->>")[1]] ?? "")
    : field.split(".").reduce((r, key) => r?.[key], row);
  const from = (table) => {
    const filters = [], orders = [];
    let columns = "*", bounds = null, single = false;
    const resolve = () => {
      if (errors[table]) return { data: null, error: errors[table] };
      let rows = [...(tables[table] ?? [])];
      for (const { method, args } of filters) {
        const [field, value] = args;
        if (method === "eq") rows = rows.filter((row) => fieldValue(row, field) === value);
        if (method === "is") rows = rows.filter((row) => (row[field] ?? null) === value);
        if (method === "in") rows = rows.filter((row) => value.includes(row[field]));
        if (method === "or") {
          const clauses = [...field.matchAll(/([\w>_-]+)\.(in|eq)\.(?:\(([^)]+)\)|(\d+))/g)];
          rows = rows.filter((row) => clauses.some(([, key, op, ids, id]) => op === "in"
            ? ids.split(",").map(Number).includes(row[key]) : String(fieldValue(row, key)) === id));
        }
      }
      rows.sort((a, b) => {
        for (const key of orders) {
          const diff = typeof a[key] === "number" ? a[key] - b[key] : String(a[key]).localeCompare(String(b[key]));
          if (diff) return diff;
        }
        return 0;
      });
      if (bounds) rows = rows.slice(bounds[0], bounds[1] + 1);
      const data = rows.map((row) => project(row, columns));
      return { data: single ? data[0] ?? null : data, error: null };
    };
    const query = new Proxy({}, { get(_target, method) {
      if (method === "then") return (resolveResult, reject) => Promise.resolve(resolve()).then(resolveResult, reject);
      return (...args) => {
        calls.push({ table, method, args });
        if (method === "select") columns = args[0];
        else if (method === "order") orders.push(args[0]);
        else if (method === "range") bounds = args;
        else if (method === "maybeSingle") single = true;
        else {
          assert.ok(["eq", "in", "or", "is"].includes(method), `Unexpected write/method ${method}`);
          filters.push({ method, args });
        }
        return query;
      };
    } });
    return query;
  };
  return { from, calls };
}
function fixture({ tables = base(), modules = [], administrator = false, errors = {}, deny = false } = {}) {
  tables.role_permissions = ["contractors", ...modules].map((module) => ({ module, role: "Synthetic", can_view: true }));
  const admin = fakeAdmin(tables, errors);
  const permissionCalls = [];
  const route = load(routePath, { "@/lib/server-admin": {
    AdminApiError,
    jsonError(error) { return Response.json({ error: error.message }, { status: error.status ?? 500 }); },
    async requireModulePermission(_request, module, action) {
      permissionCalls.push([module, action]);
      if (deny) throw new AdminApiError("Denied", 403);
      return { admin, profile: { role: "Synthetic", system_administrator: administrator } };
    },
  } });
  return {
    admin, permissionCalls,
    async get(id = 3, params = "") {
      const response = await route.GET(new Request(`https://example.test/api/contractors/${id}/merge-history${params ? `?${params}` : ""}`),
        { params: Promise.resolve({ id: String(id) }) });
      return { status: response.status, body: await response.json() };
    },
  };
}
test("nonmerged companies explicitly return no receipts without querying histories", async () => {
  const f = fixture();
  const { status, body } = await f.get(99);
  assert.equal(status, 200);
  assert.deepEqual(body.companies.map((c) => c.id), [99]);
  assert.deepEqual(body.receipts, []);
  assert.deepEqual(f.permissionCalls, [["contractors", "view"]]);
  assert.ok(!f.admin.calls.some((c) => c.table === "compliance_records"));
});
test("successor and archived predecessor both expose original identity, roles, actor and permanent receipt", async () => {
  for (const id of [1, 2, 3]) {
    const { status, body } = await fixture().get(id);
    assert.equal(status, 200);
    assert.deepEqual(body.companies.map((c) => c.id).sort(), [1, 2, 3]);
    assert.equal(body.receipts[0].actor_name, "Synthetic Merger");
    assert.equal(body.receipts[0].primary_id, 1);
    assert.equal(body.receipts[0].secondary_id, 2);
    assert.equal(body.receipts[0].successor_id, 3);
    assert.ok(!JSON.stringify(body).includes("SECRET"));
  }
});
test("multi-generation ancestry includes all predecessors and successors without duplicate receipts", async () => {
  const tables = base();
  tables.contractors = [company(1, 3), company(2, 3), company(3, 5), company(4, 5), company(5)];
  tables.company_merges.push(receipt(2, 3, 4, 5));
  for (const id of [1, 3, 5]) {
    const { body } = await fixture({ tables }).get(id);
    assert.deepEqual(body.companies.map((c) => c.id).sort(), [1, 2, 3, 4, 5]);
    assert.equal(body.receipts.length, 2);
  }
});
test("authentication/contractor permission is mandatory and unknown IDs/categories are rejected", async () => {
  assert.equal((await fixture({ deny: true }).get()).status, 403);
  assert.equal((await fixture().get("1 OR 1=1")).status, 400);
  assert.equal((await fixture().get(404)).status, 404);
  assert.equal((await fixture().get(3, "category=__proto__&source_id=1")).status, 400);
  assert.equal((await fixture({ modules: ["activity"] }).get(3, "category=activity&source_id=99")).status, 404);
  assert.equal((await fixture({ modules: ["activity"] }).get(3, "category=activity&source_id=1&offset=-1")).status, 400);
});
test("every retained category is separately permission-gated before data access", async () => {
  const f = fixture();
  const { body } = await f.get();
  for (const category of body.categories) {
    if (["contact_provenance", "identity_provenance"].includes(category.key)) {
      assert.equal(category.allowed, true);
      continue;
    }
    assert.equal(category.allowed, false);
    const before = f.admin.calls.length;
    const response = await f.get(3, `category=${category.key}&source_id=1`);
    assert.equal(response.status, 403, category.key);
    assert.ok(!f.admin.calls.slice(before).some((c) => !["role_permissions", "contractors", "company_merges"].includes(c.table)));
  }
});
test("area-permitted histories use safe minimal projections, never snapshots/tax/free text/recipient contents", async () => {
  const f = fixture({ modules: ["projects", "tiered_subs", "compliance", "insurance", "activity", "documents", "followups", "communications_summary", "imports", "compliance_sync"] });
  const { body } = await f.get();
  for (const category of body.categories) {
    const { status } = await f.get(3, `category=${category.key}&source_id=1`);
    assert.equal(status, 200, category.key);
  }
  for (const { args: [columns] } of f.admin.calls.filter((c) => c.method === "select")) {
    assert.ok(!/(^|,)\*|snapshot|choices|federal_tax|registration_number|notes|subject|recipient|body|storage_path|email|phone/.test(columns), columns);
  }
});
test("system administrators can view each area without role rows", async () => {
  const { body } = await fixture({ administrator: true }).get();
  assert.ok(body.categories.every((category) => category.allowed));
});
test("history pagination has no silent cap and preserves original IDs across all pages", async () => {
  const tables = base();
  tables.activity_log = Array.from({ length: 123 }, (_, i) => ({ id: i + 1, contractor_id: 1, activity_type: "Synthetic" }));
  tables.activity_log.push({ id: 999, contractor_id: 2, activity_type: "Other company" });
  const f = fixture({ tables, modules: ["activity"] });
  const ids = [];
  let offset = 0;
  while (offset !== null) {
    const { status, body } = await f.get(3, `category=activity&source_id=1&offset=${offset}`);
    assert.equal(status, 200);
    ids.push(...body.rows.map((r) => r.id));
    assert.ok(body.rows.every((r) => r.contractor_id === 1));
    offset = body.next_offset;
  }
  assert.deepEqual(ids, Array.from({ length: 123 }, (_, i) => i + 1));
});
test("tier history covers both original source roles", async () => {
  const tables = base();
  tables.contractor_tiered_subs = [
    { id: 1, contractor_id: 1, tiered_sub_contractor_id: 99 },
    { id: 2, contractor_id: 99, tiered_sub_contractor_id: 1 },
    { id: 3, contractor_id: 2, tiered_sub_contractor_id: 99 },
  ];
  const { body } = await fixture({ tables, modules: ["tiered_subs"] }).get(3, "category=tiers&source_id=1");
  assert.deepEqual(body.rows.map((r) => r.id), [1, 2]);
});
test("moved compliance lineage exposes safe before/after ownership, not snapshots or other permission areas", async () => {
  const tables = base();
  tables.company_merge_lineage = [
    { merge_id: tables.company_merges[0].id, category: "compliance_records", source_id: "42",
      before_row: { contractor_id: 1, active: true, is_current: true, registration_number: "SECRET" },
      after_row: { contractor_id: 3, active: true, is_current: true } },
    { merge_id: tables.company_merges[0].id, category: "contractor_projects", source_id: "43" },
  ];
  const { body } = await fixture({ tables, modules: ["compliance"] }).get(3, "category=provenance&source_id=1");
  assert.equal(body.rows.length, 1);
  assert.equal(body.rows[0].before_contractor_id, 1);
  assert.equal(body.rows[0].after_contractor_id, 3);
  assert.ok(!JSON.stringify(body).includes("SECRET"));
});
test("myCOI division evidence is filtered through original vendor identity", async () => {
  const tables = base();
  tables.mycoi_contractor_divisions = [
    { id: 1, vendor: { contractor_id: 1 }, import_history_id: 8, compliance_status: "Historical" },
    { id: 2, vendor: { contractor_id: 2 }, import_history_id: 9 },
  ];
  const { body } = await fixture({ tables, modules: ["insurance"] }).get(3, "category=mycoi_divisions&source_id=1");
  assert.deepEqual(body.rows.map((r) => r.id), [1]);
  assert.equal(body.rows[0].import_history_id, 8);
});
test("contact provenance preserves UUID and original ownership without disclosing contact PII", async () => {
  const tables = base();
  const contactId = "00000000-0000-4000-8000-000000000042";
  tables.company_merge_lineage = [{
    merge_id: tables.company_merges[0].id, category: "contractor_contacts", source_id: contactId,
    before_row: { id: contactId, contractor_id: 1, email: "SECRET@example.test" },
    after_row: { id: contactId, contractor_id: 3, contact_name: "SECRET" },
  }];
  const { status, body } = await fixture({ tables }).get(3, "category=contact_provenance&source_id=1");
  assert.equal(status, 200);
  assert.equal(body.rows[0].source_id, contactId);
  assert.equal(body.rows[0].before_contractor_id, 1);
  assert.equal(body.rows[0].after_contractor_id, 3);
  assert.ok(!JSON.stringify(body).includes("SECRET"));
  const sibling = await fixture({ tables }).get(3, "category=contact_provenance&source_id=2");
  assert.deepEqual(sibling.body.rows, []);
});
test("communications retain original company links and only minimal permission-checked message metadata", async () => {
  const tables = base();
  tables.communication_contractors = [
    { contractor_id: 1, message_id: "message-1", message: { id: "message-1", channel: "email", source: "manual", status: "Sent", body: "SECRET", recipient_email: "SECRET" } },
    { contractor_id: 2, message_id: "message-2", message: { id: "message-2", channel: "sms", status: "Sent" } },
  ];
  assert.equal((await fixture({ tables, modules: ["communications_content"] }).get(3, "category=communications&source_id=1")).status, 403);
  const { status, body } = await fixture({ tables, modules: ["communications_summary"] }).get(3, "category=communications&source_id=1");
  assert.equal(status, 200);
  assert.equal(body.rows.length, 1);
  assert.equal(body.rows[0].message_id, "message-1");
  assert.equal(body.rows[0].message_channel, "email");
  assert.ok(!JSON.stringify(body).includes("SECRET"));
});
test("missing migration fails explicitly rather than claiming no merge history", async () => {
  for (const table of ["contractors", "company_merges", "company_merge_lineage"]) {
    const f = fixture({ modules: ["compliance"], errors: { [table]: { code: "42P01", message: "missing" } } });
    const result = await f.get(3, table === "company_merge_lineage" ? "category=provenance&source_id=1" : "");
    assert.equal(result.status, 503);
    assert.match(result.body.error, /migration\/schema is missing/);
  }
});
test("original manual insurance is archival and is neither filtered to current nor replaced by successor state", async () => {
  const tables = base();
  tables.contractor_insurance = [
    { contractor_id: 1, certificate_on_file: true, last_verified_date: "2025-01-02", notes: "SECRET" },
    { contractor_id: 3, certificate_on_file: false },
  ];
  assert.equal((await fixture({ tables }).get(3, "category=insurance_snapshot&source_id=1")).status, 403);
  const { body } = await fixture({ tables, modules: ["insurance"] }).get(3, "category=insurance_snapshot&source_id=1");
  assert.equal(body.rows.length, 1);
  assert.equal(body.rows[0].contractor_id, 1);
  assert.equal(body.rows[0].certificate_on_file, true);
  assert.equal(body.rows[0].last_verified_date, "2025-01-02");
  assert.ok(!JSON.stringify(body).includes("SECRET"));
});
test("retired Procore before-images and original myCOI before/after provenance survive mapping deletion", async () => {
  const tables = base();
  tables.company_merge_lineage = [
    { merge_id: tables.company_merges[0].id, category: "procore_vendor_mappings", source_id: "mapping-hash",
      before_row: { contractor_id: 1, import_history_id: 71, import_run_id: "source-run", accepted_at: "2026-01-02", evidence: "SECRET" }, after_row: null },
    { merge_id: tables.company_merges[0].id, category: "mycoi_vendor_mappings", source_id: "88",
      before_row: { contractor_id: 1, active: true, import_history_id: 72, vendor_email: "SECRET" },
      after_row: { contractor_id: 1, active: false, import_history_id: 72 } },
  ];
  assert.equal((await fixture({ tables, modules: ["insurance"] }).get(3, "category=procore_provenance&source_id=1")).status, 403);
  const procore = await fixture({ tables, modules: ["imports"] }).get(3, "category=procore_provenance&source_id=1");
  assert.equal(procore.body.rows[0].before_import_history_id, 71);
  assert.equal(procore.body.rows[0].before_import_run_id, "source-run");
  assert.equal(procore.body.rows[0].after_contractor_id, null);
  const mycoi = await fixture({ tables, modules: ["insurance"] }).get(3, "category=mycoi_provenance&source_id=1");
  assert.equal(mycoi.body.rows[0].before_active, true);
  assert.equal(mycoi.body.rows[0].after_active, false);
  assert.equal(mycoi.body.rows[0].before_import_history_id, 72);
  assert.ok(!JSON.stringify([procore.body, mycoi.body]).includes("SECRET"));
});
test("original immutable registry evidence and live retained queue metadata exclude all sensitive payloads", async () => {
  const tables = base();
  const sensitive = { candidates: "SECRET", current_snapshot: "SECRET", result_evidence: "SECRET",
    taxpayer_id_submission: "SECRET", federal_tax_id: "SECRET", review_notes: "SECRET", claim_worker_key: "SECRET" };
  tables.company_merge_lineage = [{
    merge_id: tables.company_merges[0].id, category: "nj_brc_search_requests", source_id: "request-1",
    before_row: { contractor_id: 1, status: "completed", created_at: "2026-01-02", ...sensitive },
  }];
  for (const [table, category] of [["compliance_sync_review_queue", "sync_reviews"],
    ["compliance_sync_search_requests", "pwc_requests"], ["nj_brc_search_requests", "brc_requests"]]) {
    tables[table] = [{ id: 1, contractor_id: 1, status: "completed", ...sensitive }, { id: 2, contractor_id: 3, status: "completed" }];
    assert.equal((await fixture({ tables, modules: ["compliance"] }).get(3, `category=${category}&source_id=1`)).status, 403);
    const { status, body } = await fixture({ tables, modules: ["compliance_sync"] }).get(3, `category=${category}&source_id=1`);
    assert.equal(status, 200);
    assert.equal(body.rows.length, 1);
    assert.equal(body.rows[0].contractor_id, 1);
    assert.ok(!JSON.stringify(body).includes("SECRET"));
  }
  const { body } = await fixture({ tables, modules: ["compliance_sync"] }).get(3, "category=sync_provenance&source_id=1");
  assert.equal(body.rows[0].source_id, "request-1");
  assert.equal(body.rows[0].before_status, "completed");
  assert.ok(!JSON.stringify(body).includes("SECRET"));
});
test("original contractor identity before-image excludes tax and limits history to its own source", async () => {
  const tables = base();
  tables.company_merge_lineage = [1, 2].map((id) => ({
    merge_id: tables.company_merges[0].id, category: "contractors", source_id: String(id),
    before_row: { id, company_name: `Original ${id}`, active: true, federal_tax_id: "SECRET", address_1: "SECRET" },
  }));
  const { body } = await fixture({ tables }).get(3, "category=identity_provenance&source_id=1");
  assert.equal(body.rows.length, 1);
  assert.equal(body.rows[0].before_company_name, "Original 1");
  assert.ok(!JSON.stringify(body).includes("SECRET"));
});
test("traversal overflow and orphan archive references explicitly report incomplete history", async () => {
  const tables = base();
  tables.company_merges = Array.from({ length: 201 }, (_, i) => receipt(i + 1, 1, 2, 3));
  const overflow = await fixture({ tables }).get();
  assert.equal(overflow.status, 409);
  assert.match(overflow.body.error, /not complete/);
  const orphan = base();
  orphan.company_merges = [];
  assert.equal((await fixture({ tables: orphan }).get(1)).status, 409);
});
test("normal selector excludes archived originals, while direct card lookup preserves them", async () => {
  const admin = fakeAdmin(base());
  const service = load("services\\contractors.ts", {
    "@/lib/supabase": { supabase: admin },
    "@/lib/admin-client": { adminFetch() { throw new Error("No writes allowed"); } },
  });
  const list = await service.getContractors();
  assert.deepEqual([...list.data].map((c) => c.id), [3, 99]);
  const original = await service.getContractorById(1);
  assert.equal(original.data.id, 1);
  assert.equal(original.data.merged_into_contractor_id, 3);
  assert.ok(admin.calls.some((c) => c.method === "is" && c.args[0] === "merged_into_contractor_id" && c.args[1] === null));
});
test("card wiring is in the active implementation and archived cards return before mutation controls", () => {
  const source = fs.readFileSync(path.join(root, "src\\app\\contractors\\[id]\\page.tsx"), "utf8").split('"use client";')[1];
  assert.match(source, /import CompanyMergeHistory/);
  assert.match(source, /if \(contractor\.merged_into_contractor_id\) return/);
  assert.match(source, /Archived merged Company Card — read-only/);
  assert.match(source, /const \{ data: contractorData[\s\S]*if \(contractorData\?\.merged_into_contractor_id/);
  assert.equal((source.match(/<CompanyMergeHistory key=/g) ?? []).length, 2);
});
test("history component renders predecessor labels/links, permanent receipts, denied areas and explicit errors", async () => {
  const { body } = await fixture().get(3);
  const React = require("react");
  const { renderToStaticMarkup } = require("react-dom/server");
  function render(result) {
    let hook = 0;
    const component = load("src\\components\\CompanyMergeHistory.tsx", {
      "next/link": { default: ({ href, children, ...props }) => React.createElement("a", { href, ...props }, children) },
      "react": { useEffect() {}, useState(initial) { return [hook++ === 0 ? result : initial, () => {}]; } },
      "react/jsx-runtime": require("react/jsx-runtime"),
      "@/lib/admin-client": { adminFetch() { throw new Error("No network allowed"); } },
    }).default;
    return renderToStaticMarkup(React.createElement(component, { contractorId: 3 }));
  }
  const html = render({ id: 3, history: body });
  assert.match(html, /Synthetic Company 1/);
  assert.match(html, /href="\/contractors\/1"/);
  assert.match(html, /Permanent receipt/);
  assert.match(html, /permission required/);
  assert.match(html, /Synthetic Merger/);
  const error = render({ id: 3, error: "Required database migration is missing" });
  assert.match(error, /role="alert"/);
  assert.match(error, /not confirmation of no prior merges/);
});
