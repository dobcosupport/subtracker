import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import ts from "typescript";
import * as XLSX from "xlsx";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const uuid = "00000000-0000-4000-8000-000000000001";
let authenticated = true, importsView = true, settingsView = true, importsWrite = true, settingsManage = true;
let rpcResult = null, rpcError = null;
const calls = [];
class AdminApiError extends Error { constructor(message, status) { super(message); this.status = status; } }
const context = {
  profile: { auth_user_id: uuid, role: "Test", system_administrator: false },
  admin: {
    from: (table) => {
      assert.equal(table, "role_permissions", "API must not directly write contacts or any other destination");
      return { select: () => ({ eq: async () => ({ data: [
        { module: "imports", can_view: importsView, can_add: importsWrite, can_edit: importsWrite },
        { module: "settings", can_view: settingsView, can_manage: settingsManage },
      ], error: null }) }) };
    },
    rpc: async (name, args) => {
      assert.equal(name, "company_contacts_import");
      calls.push(args);
      return { data: rpcResult ?? (args.p_action === "list" ? { batches: [] } : { batch: { id: uuid }, rows: [], summary: {}, contacts: [] }), error: rpcError };
    },
  },
};
const server = {
  AdminApiError,
  requireModulePermission: async (_r, module, action) => {
    assert.equal(module, "imports"); assert.equal(action, "view");
    if (!authenticated) throw new AdminApiError("Authentication required", 401);
    if (!importsView) throw new AdminApiError("Permission denied", 403);
    return context;
  },
  jsonError: (e) => Response.json({ error: e.message }, { status: e.status ?? 500 }),
};
const cache = new Map();
function load(relative) {
  if (cache.has(relative)) return cache.get(relative);
  const mod = { exports: {} }; cache.set(relative, mod.exports);
  const code = ts.transpileModule(fs.readFileSync(path.join(root, relative), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(code, {
    module: mod, exports: mod.exports, Response, Request, File, FormData, Buffer, URL, Uint8Array, Date,
    require: (name) => {
      if (name === "server-only") return {};
      if (name === "@/lib/server-admin") return server;
      if (name.startsWith("@/lib/")) return load(`src\\lib\\${name.slice(6)}.ts`);
      if (name.startsWith("@/types/")) return load(`types\\${name.slice(8)}.ts`);
      return require(name);
    },
  });
  return mod.exports;
}
const { companyContactsTemplate, parseCompanyContactsWorkbook: parse } = load("src\\lib\\company-contacts-workbook.ts");
const route = load("src\\app\\api\\imports\\company-contacts\\route.ts");
const workbook = (cells, name = "Company Contacts", mutate = () => {}) => {
  const book = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet(cells);
  mutate(sheet); XLSX.utils.book_append_sheet(book, sheet, name);
  return XLSX.write(book, { type: "array", bookType: "xlsx" });
};
const valid = [["Name", "Cell", "Email"], ["Synthetic Person", "(201) 555-0101", "PERSON@example.org"]];
const upload = (buffer = workbook(valid), name = "Contacts.xlsx") => {
  const form = new FormData(); form.set("file", new File([buffer], name));
  return route.POST(new Request("http://localhost/api/imports/company-contacts", { method: "POST", body: form }));
};
const patch = (body) => route.PATCH(new Request("http://localhost/api/imports/company-contacts", {
  method: "PATCH", body: JSON.stringify(body), headers: { "Content-Type": "application/json" },
}));
test("template contains exactly the authoritative worksheet and headers, no people", () => {
  const book = XLSX.read(companyContactsTemplate(), { type: "array" });
  assert.deepEqual(book.SheetNames, ["Company Contacts"]);
  const cells = XLSX.utils.sheet_to_json(book.Sheets["Company Contacts"], { header: 1 });
  assert.deepEqual(cells, [["Name", "Cell", "Email"]]);
  assert.equal(book.Sheets["Company Contacts"]["!autofilter"].ref, "A1:C1");
});
test("valid XLSX, normalized headers, safe first sheet and additional-column notices", () => {
  const result = parse(workbook([[" name ", "CELL", " email ", "Not imported"], ["Person", "", "external@example.org", "ignored"]], "Employees"), "Employee Import 10-27-26.xlsx");
  assert.equal(result.rows.length, 1);
  assert.equal(JSON.stringify(result.rows[0].original), JSON.stringify({ Name: "Person", Cell: "", Email: "external@example.org" }));
  assert.equal(result.notices.length, 2);
});
test("missing/duplicate headers, unrelated/invalid formats and formula/error cells reject the whole upload", () => {
  for (const cells of [
    [["Cell", "Email"], ["2015550101", "x@example.org"]],
    [["Name", "Name", "Cell", "Email"], ["One", "Two", "", ""]],
    [["Name"], ["One"]], [["Vendor", "Phone", "Address"], ["Vendor", "", ""]],
  ]) assert.throws(() => parse(workbook(cells), "Contacts.xlsx"), /column|headers/);
  assert.throws(() => parse(new TextEncoder().encode("unrelated text").buffer, "Contacts.xlsx"), /not an XLSX/);
  assert.throws(() => parse(workbook(valid), "Contacts.csv"), /\.xlsx/);
  for (const modify of [(s) => { s.A2.f = "1+1"; }, (s) => { s.A2 = { t: "e", v: 7 }; }]) {
    assert.throws(() => parse(workbook(valid, "Company Contacts", modify), "Contacts.xlsx"), /Row 2.*formulas or error/);
  }
});
test("blank rows ignored; source row numbers and original whitespace/notes retained", () => {
  const result = parse(workbook([["Name", "Cell", "Email"], ["", "", ""], [" Name (PM) ", "2015550101 (personal)", ""], ["Another", "", "other@outside.org"]]), "Contacts.xlsx");
  assert.equal(result.rows.length, 2); assert.equal(result.rows[0].source_row, 3);
  assert.equal(result.rows[0].original.Name, " Name (PM) ");
  assert.equal(result.rows[0].original.Email, "");
});
test("API requires Imports and Settings permissions; Communications-only/read-only cannot mutate", async () => {
  const read = () => route.GET(new Request("http://localhost/api/imports/company-contacts"));
  authenticated = false;
  assert.equal((await read()).status, 401); assert.equal((await upload()).status, 401);
  authenticated = true;
  importsView = false; assert.equal((await read()).status, 403); importsView = true;
  settingsView = false; assert.equal((await upload()).status, 403); assert.equal((await read()).status, 403); settingsView = true;
  for (const field of ["settings", "imports"]) {
    if (field === "settings") settingsManage = false; else importsWrite = false;
    assert.equal((await read()).status, 200);
    assert.equal((await upload()).status, 403);
    assert.equal((await patch({ operation: "apply", batch_id: uuid, revision: 1 })).status, 403);
    settingsManage = true; importsWrite = true;
  }
});
test("authorized template, upload and history; same content uses stable dedup identity and server actor", async () => {
  const template = await route.GET(new Request("http://localhost/api/imports/company-contacts?template=1"));
  assert.equal(template.status, 200);
  assert.match(template.headers.get("Content-Disposition"), /Company Contacts Import Template.xlsx/);
  assert.equal((await upload()).status, 200);
  const first = calls.at(-1);
  assert.equal(first.p_actor, uuid); assert.equal(first.p_action, "stage");
  assert.equal(first.p_data.rows[0].original.Email, "PERSON@example.org");
  assert.equal((await upload(workbook([valid[0], [" synthetic   person ", "201.555.0101", "person@EXAMPLE.ORG"]]), "Renamed.xlsx")).status, 200);
  assert.equal(calls.at(-1).p_data.file_hash, first.p_data.file_hash);
  assert.equal((await route.GET(new Request(`http://localhost/api/imports/company-contacts?batch=${uuid}`))).status, 200);
  assert.equal(calls.at(-1).p_action, "get");
});
test("invalid workbook never reaches staging, and request cannot spoof actor, source values or destination fields", async () => {
  const count = calls.length;
  assert.equal((await upload(workbook([["Cell", "Email"], ["123", "bad"]]))).status, 400);
  assert.equal(calls.length, count);
  for (const extra of [{ p_actor: uuid }, { is_active: true }, { source_rows: [] }, { created_by: uuid }]) {
    assert.equal((await patch({ operation: "apply", batch_id: uuid, revision: 1, ...extra })).status, 400);
  }
  assert.equal((await patch({ operation: "resolve", batch_id: uuid, revision: 1, row_id: "bad", action: "ADD" })).status, 400);
});
test("RPC errors are surfaced, stale is 409, missing migration and empty results are not success", async () => {
  rpcError = { code: "40001", message: "Import changed" };
  assert.equal((await patch({ operation: "apply", batch_id: uuid, revision: 1 })).status, 409);
  rpcError = { code: "PGRST202", message: "Missing RPC" };
  const response = await route.GET(new Request("http://localhost/api/imports/company-contacts"));
  assert.equal(response.status, 503); assert.match((await response.json()).error, /20261120_company_contacts_import.sql/);
  rpcError = null; rpcResult = {};
  assert.equal((await upload()).status, 503);
  rpcResult = null;
});
