import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import ts from "typescript";
import * as XLSX from "xlsx";

const requirePackage = createRequire(import.meta.url);
const { PGlite } = requirePackage("@electric-sql/pglite");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");
const cache = new Map();
function load(relative) {
  if (cache.has(relative)) return cache.get(relative);
  const output = { exports: {} };
  cache.set(relative, output.exports);
  vm.runInNewContext(ts.transpileModule(read(...relative.split("\\")), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, {
    exports: output.exports, module: output, Date, ArrayBuffer,
    require: (name) => {
      if (name === "xlsx") return XLSX;
      if (name.startsWith("@/types/")) return load(`types\\${name.slice(8)}.ts`);
      if (name.startsWith("@/lib/")) return load(`src\\lib\\${name.slice(6)}.ts`);
      throw new Error(`Unexpected dependency ${name}`);
    },
  });
  return output.exports;
}
const { parseMycoiPolicies, parseMycoiWorkbook } = load("src\\lib\\mycoi-parser.ts");
const { buildMycoiPreview, blankDecisions, mycoiKey } = load("src\\lib\\mycoi-preview.ts");
const row = (id, values = {}) => ({
  row: id, "Division Name": "22002 - Synthetic School", "Vendor Name": "Synthetic Geo Environmental",
  "Vendor Email": "vendor@example.invalid", "Vendor Phone": "(201) 555-0100", "Compliance Status": "Compliant Finalized",
  "Policy Expiration Dates": "policyNumber: SYN-1 (AZ, MA); expirationDate: 06/01/2027; isExpired: false; policyLines: General Liability, Rigger's Liability",
  ...values,
});
const emptyRef = () => ({
  token: "test", contractors: [{ id: 1, company_name: "Synthetic GeoEnvironmental", active: true }, { id: 2, company_name: "Other Synthetic", active: true }],
  projects: [{ id: 1, project_number: "22002", project_name: "Synthetic School" }, { id: 2, project_number: "24003", project_name: "Synthetic College" }],
  vendors: [], divisions: [], statuses: [], policies: [], links: [],
});
const initialDecisions = () => ({ ...blankDecisions(), vendors: { "synthetic geo environmental": 1 }, divisions: { "22002 - synthetic school": 1 } });
for (const division of ["22002 - Union City New Grade 7-9 School - Wrap Up", "22002 - ABCO - Union City New Grade 7-9 School - Wrap Up"]) {
  const choices = blankDecisions(); choices.vendors["synthetic geo environmental"] = 1;
  const result = buildMycoiPreview([row(2, { "Division Name": division })], choices, emptyRef());
  assert.equal(result.ready.length, 1, "Exact unique number automatically resolves readiness");
  assert.equal(result.divisions[0].projectId, 1);
  assert.equal(result.divisions[0].automatic, true);
}
for (const division of ["99999 - Unknown Project", "No Project Number"]) {
  const choices = blankDecisions(); choices.vendors["synthetic geo environmental"] = 1;
  assert.ok(buildMycoiPreview([row(2, { "Division Name": division })], choices, emptyRef()).issues.some((issue) => issue.category === "Project Review Required"));
}
const differentNumber = emptyRef(); differentNumber.projects[0].project_number = "22-002";
assert.equal(buildMycoiPreview([row(2)], blankDecisions(), differentNumber).divisions[0].projectId, 1, "Unique five-digit format conversion");
for (const [sourceNumber, storedNumber] of [["22002", "22-002"], ["23008", "23-008"], ["24003", "24-003"]]) {
  const ref = emptyRef(); ref.projects = [{ id: 10, project_number: storedNumber, project_name: "Name deliberately unrelated" }];
  const input = row(2, { "Division Name": `${sourceNumber} - Source title` });
  let result = buildMycoiPreview([input], blankDecisions(), ref);
  assert.equal(result.divisions[0].projectId, 10);
  assert.equal(result.divisions[0].automatic, true);
  ref.projects.push({ id: 11, project_number: sourceNumber, project_name: "Exact wins" });
  assert.equal(buildMycoiPreview([input], blankDecisions(), ref).divisions[0].projectId, 11);
  ref.divisions.push({ id: 1, raw_division_name: input["Division Name"], project_id: 10, active: true });
  assert.equal(buildMycoiPreview([input], blankDecisions(), ref).divisions[0].projectId, 10, "Saved wins over exact");
  ref.divisions = []; ref.projects = [ref.projects[0], { ...ref.projects[0], id: 12 }];
  result = buildMycoiPreview([input], blankDecisions(), ref);
  assert.equal(result.divisions[0].projectId, null, "Ambiguous normalized match needs review");
  assert.ok(result.issues.some((issue) => issue.category === "Project Review Required"));
  ref.projects.push({ id: 13, project_number: sourceNumber, project_name: "Exact A" }, { id: 14, project_number: sourceNumber, project_name: "Exact B" });
  assert.equal(buildMycoiPreview([input], blankDecisions(), ref).divisions[0].projectId, null, "Ambiguous exact never falls through");
}
for (const division of ["99999 - Unknown", "2200A - Invalid", "220020 - Six digits", "No number"]) {
  assert.equal(buildMycoiPreview([row(2, { "Division Name": division })], blankDecisions(), differentNumber).divisions[0].projectId, null);
}
const sharedProjectChoices = blankDecisions(); sharedProjectChoices.vendors["synthetic geo environmental"] = 1;
const sharedProjectPreview = buildMycoiPreview([
  row(2, { "Division Name": "22002 - Union City New Grade 7-9 School - Wrap Up" }),
  row(3, { "Division Name": "22002 - ABCO - Union City New Grade 7-9 School - Wrap Up" }),
], sharedProjectChoices, differentNumber);
assert.equal(sharedProjectPreview.ready.length, 1);
assert.equal(sharedProjectPreview.divisions.length, 2);
assert.ok(sharedProjectPreview.divisions.every((division) => division.automatic && division.projectId === 1));
const plain = (value) => JSON.parse(JSON.stringify(value));
const parsed = parseMycoiPolicies(row(2)["Policy Expiration Dates"]);
assert.equal(parsed.errors.length, 0);
assert.equal(parsed.policies[0].policyNumber, "SYN-1 (AZ, MA)");
assert.deepEqual(plain(parsed.policies[0].policyLines), ["General Liability", "Rigger's Liability"]);
assert.equal(parsed.policies[0].expirationDate, "2027-06-01");
assert.equal(parsed.policies[0].isExpired, false);
assert.equal(parseMycoiPolicies("").policies.length, 0);
assert.equal(parseMycoiPolicies(" \n ").errors.length, 0);
for (const value of [
  "null", "[]", '{"policyNumber":"SYN"}', "garbage",
  row(2)["Policy Expiration Dates"] + "; stray data",
  row(2)["Policy Expiration Dates"].replace("06/01/2027", "02/30/2027"),
  row(2)["Policy Expiration Dates"].replace("false", "null"),
  row(2)["Policy Expiration Dates"].replace("SYN-1 (AZ, MA)", ""),
  row(2)["Policy Expiration Dates"].replace("General Liability, Rigger's Liability", '["General Liability"]'),
  row(2)["Policy Expiration Dates"].replace("General Liability, Rigger's Liability", "General Liability, "),
]) assert.ok(parseMycoiPolicies(value).errors.length > 0, value);
assert.equal(parseMycoiPolicies(row(2)["Policy Expiration Dates"].replace("General Liability, Rigger's Liability", "Unknown Synthetic Coverage")).errors.length, 0);
assert.equal(parseMycoiPolicies(row(2)["Policy Expiration Dates"].replace("SYN-1 (AZ, MA)", "SYN &amp; OTHER")).policies[0].policyNumber, "SYN &amp; OTHER");
for (const number of ["SYN &amp;", "SYN (MA&amp;WI)"]) {
  assert.equal(parseMycoiPolicies(row(2)["Policy Expiration Dates"].replace("SYN-1 (AZ, MA)", number)).policies[0].policyNumber, number);
}
const two = `${row(2)["Policy Expiration Dates"]}, policyNumber: SYN-2; expirationDate: 06/01/2025; isExpired: true; policyLines: General Liability`;
assert.equal(parseMycoiPolicies(two).policies.length, 2);
const headings = load("types\\mycoi-import.ts").MYCOI_HEADINGS;
function workbook(values, csv = false) {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(values), "Report");
  const buffer = csv ? Buffer.from(XLSX.utils.sheet_to_csv(book.Sheets.Report), "utf8") : XLSX.write(book, { type: "buffer", bookType: "xlsx" });
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}
for (const csv of [false, true]) {
  const source = row(2, { "Vendor Name": "Synthetic \"Quoted\", O'Name", "Vendor Phone": "" });
  const values = [headings, headings.map((heading) => source[heading])];
  assert.deepEqual(plain(parseMycoiWorkbook(workbook(values, csv), csv ? "synthetic.csv" : "synthetic.xlsx"))[0], source);
  const reversed = [headings.slice().reverse(), headings.slice().reverse().map((heading) => source[heading])];
  assert.deepEqual(plain(parseMycoiWorkbook(workbook(reversed, csv), csv ? "synthetic.csv" : "synthetic.xlsx"))[0], source);
}
assert.throws(() => parseMycoiWorkbook(workbook([["Wrong"]]), "synthetic.xlsx"), /headings/);
assert.throws(() => parseMycoiWorkbook(workbook([headings, ["D", "V", "", 123, "Status", ""]]), "synthetic.xlsx"), /expected text/);
const invalidBook = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(invalidBook, XLSX.utils.aoa_to_sheet([headings, headings.map((heading) => row(2)[heading])]), "Report");
const parseBook = () => {
  const bytes = XLSX.write(invalidBook, { type: "buffer", bookType: "xlsx" });
  return parseMycoiWorkbook(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), "synthetic.xlsx");
};
invalidBook.Sheets.Report.A2.f = '"Synthetic"';
assert.throws(parseBook, /formula\/error/);
delete invalidBook.Sheets.Report.A2.f;
invalidBook.Sheets.Report.A2 = { t: "e", v: 7 };
assert.throws(parseBook, /formula\/error/);
invalidBook.Sheets.Report.A2 = { t: "s", v: row(2)["Division Name"] };
invalidBook.Sheets.Report["!ref"] = "A1:F5002";
assert.throws(parseBook, /5,000/);
invalidBook.Sheets.Report["!ref"] = "A1:F2";
XLSX.utils.book_append_sheet(invalidBook, XLSX.utils.aoa_to_sheet([headings]), "Unexpected");
assert.throws(parseBook, /exactly one worksheet/);
let reference = emptyRef();
let decisions = blankDecisions();
let source = [row(2), row(3, { "Division Name": "24003 - Synthetic College", "Compliance Status": "Non-Compliant In-Progress" })];
let preview = buildMycoiPreview(source, decisions, reference);
assert.equal(preview.ready.length, 0);
assert.equal(preview.vendors[0].suggestions.length, 1);
assert.equal(preview.divisions[0].suggestions[0].id, 1);
decisions = initialDecisions();
decisions.divisions["24003 - synthetic college"] = 2;
preview = buildMycoiPreview(source, decisions, reference);
assert.equal(preview.ready.length, 1);
assert.equal(preview.ready[0].policies.length, 2);
assert.equal(preview.ready[0].policies[0].divisions.length, 2);
assert.equal(preview.ready[0].divisions[1].status, "Non-Compliant In-Progress");
for (const [field, value, category] of [
  ["Policy Expiration Dates", "malformed", "Policy Parse Errors"],
  ["Compliance Status", "Mystery", "Source Review Required"],
  ["Vendor Phone", "20155501002015550101", "Contact Review Required"],
  ["Vendor Phone", "20155501001234", "Contact Review Required"],
  ["Vendor Email", "VendorAsAgent@mycoitracking.com", "Contact Review Required"],
  ["Division Name", "Unknown project", "Project Review Required"],
  ["Vendor Name", "", "Vendor Review Required"],
]) {
  const result = buildMycoiPreview([row(2, { [field]: value })], initialDecisions(), reference);
  assert.equal(result.ready.length, 0);
  assert.ok(result.issues.some((issue) => issue.category === category));
}
source = [row(2), row(3, { "Vendor Email": "other@example.invalid", "Vendor Phone": "(201) 555-0199" })];
assert.equal(buildMycoiPreview(source, initialDecisions(), reference).ready.length, 0);
decisions = initialDecisions();
decisions.contacts["synthetic geo environmental"] = { email: "vendor@example.invalid", phone: "__KEEP__" };
assert.equal(buildMycoiPreview(source, decisions, reference).ready.length, 1);
assert.equal(buildMycoiPreview(source, decisions, reference).ready[0].phone, null);
const ambiguous = emptyRef();
ambiguous.contractors.push({ id: 3, company_name: "Synthetic Geo Environmental", active: true });
ambiguous.projects.push({ id: 3, project_number: "22002", project_name: "Duplicate test number" });
const ambiguousPreview = buildMycoiPreview([row(2)], blankDecisions(), ambiguous);
assert.ok(ambiguousPreview.issues.some((issue) => /Ambiguous contractor/.test(issue.reason)));
assert.ok(ambiguousPreview.issues.some((issue) => /Ambiguous project/.test(issue.reason)));
const fixture = path.join(root, "test-data", "mycoi", "Compliance(2).xlsx");
if (fs.existsSync(fixture)) {
  const bytes = fs.readFileSync(fixture);
  const hash = crypto.createHash("sha256").update(bytes).digest("hex");
  const rows = parseMycoiWorkbook(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), "Compliance(2).xlsx");
  const results = rows.map((item) => parseMycoiPolicies(item["Policy Expiration Dates"]));
  assert.equal(rows.length, 1099);
  assert.equal(results.reduce((sum, item) => sum + item.errors.length, 0), 0);
  assert.equal(results.reduce((sum, item) => sum + item.policies.length, 0), 4250);
  assert.equal(crypto.createHash("sha256").update(fs.readFileSync(fixture)).digest("hex"), hash);
  console.log("PASS: real local read-only workbook, 1,099 rows, 4,250 source policies, zero policy syntax errors, unchanged SHA256; no source values emitted");
}

const db = await PGlite.create();
try {
  await db.exec(`
    CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
      $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    GRANT USAGE ON SCHEMA auth TO authenticated;
    CREATE TABLE user_profiles(auth_user_id uuid PRIMARY KEY,role text,status text,name text,email text,system_administrator boolean DEFAULT false);
    CREATE TABLE role_permissions(role text,module text,can_view boolean,can_manage boolean,can_add boolean,can_edit boolean,can_delete boolean);
    INSERT INTO user_profiles VALUES
      ('00000000-0000-0000-0000-000000000001','Editor','Active','Synthetic Editor','editor@example.invalid',false),
      ('00000000-0000-0000-0000-000000000002','Viewer','Active','Synthetic Viewer','viewer@example.invalid',false);
    INSERT INTO role_permissions SELECT role,module,true,role='Editor',role='Editor',role='Editor',false
      FROM (VALUES ('Editor'),('Viewer')) roles(role) CROSS JOIN (VALUES ('imports'),('insurance'),('contractors'),('projects')) modules(module);
    CREATE TABLE contractors(id integer PRIMARY KEY,company_name text,active boolean DEFAULT true,email text,phone text);
    INSERT INTO contractors VALUES(1,'Synthetic GeoEnvironmental',true,'general@example.invalid','GENERAL'),(2,'Other Synthetic',true,null,null);
    CREATE TABLE projects(id integer PRIMARY KEY,project_number text UNIQUE,project_name text);
    INSERT INTO projects VALUES(1,'22-002','Synthetic School'),(2,'24-003','Synthetic College');
    CREATE TABLE import_history(id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,file_name text,import_date timestamptz DEFAULT now(),
      imported_rows integer,successful_rows integer,failed_rows integer,notes text);
    CREATE TABLE administration_audit_log(id bigint GENERATED BY DEFAULT AS IDENTITY,user_id uuid,user_name text,user_email text,
      audit_date timestamptz DEFAULT now(),action text,object_type text,object_id text,object_label text,details jsonb);
    CREATE TABLE compliance_types(id integer GENERATED BY DEFAULT AS IDENTITY,compliance_name text UNIQUE,requires_expiration boolean,active boolean);
  `);
  const permissionSql = read("supabase", "20260929_user_management_enhancements.sql");
  const start = permissionSql.indexOf("CREATE OR REPLACE FUNCTION public.user_has_module_permission");
  await db.exec(permissionSql.slice(start, permissionSql.indexOf("$$;", start) + 3));
  await db.exec(read("supabase", "20260924_contractor_insurance_history.sql"));
  await db.exec(read("supabase", "20260925_insurance_policy_tracking.sql"));
  await db.exec("INSERT INTO contractor_insurance(contractor_id,notes) VALUES(1,'Legacy unchanged'); INSERT INTO contractor_insurance_history(contractor_id,coi_on_file,notes) VALUES(1,true,'History unchanged')");
  await db.exec(read("supabase", "20261021_mycoi_foundation.sql"));
  const originalIndex = (await db.query("SELECT indexdef FROM pg_indexes WHERE indexname='mycoi_policy_current_identity'")).rows[0].indexdef;
  const migration = read("supabase", "20261022_mycoi_import_workflow.sql");
  assert.doesNotMatch(migration, /audit_application_change|nj_pwc_write_audit/);
  await assert.rejects(db.exec(migration.replace(/COMMIT;\s*$/, "SELECT 1/0;\nCOMMIT;")), (error) => error.code === "22012");
  await db.exec("ROLLBACK");
  assert.equal((await db.query("SELECT to_regclass('public.mycoi_import_runs') r")).rows[0].r, null);
  assert.equal((await db.query("SELECT indexdef FROM pg_indexes WHERE indexname='mycoi_policy_current_identity'")).rows[0].indexdef, originalIndex);
  assert.equal((await db.query("SELECT count(*)::integer n FROM pg_proc WHERE proname IN ('mycoi_import_reference','mycoi_apply_import')")).rows[0].n, 0);
  await db.exec(migration);
  const snapshot = async () => plain((await db.query(`SELECT
    (SELECT jsonb_agg(to_jsonb(c)) FROM contractors c) contractors,
    (SELECT jsonb_agg(to_jsonb(p)) FROM projects p) projects,
    (SELECT jsonb_agg(to_jsonb(i)) FROM contractor_insurance i) insurance,
    (SELECT jsonb_agg(to_jsonb(h)) FROM contractor_insurance_history h) history`)).rows[0]);
  const before = await snapshot();
  const actor = "00000000-0000-0000-0000-000000000001";
  const ref = async () => (await db.query("SELECT mycoi_import_reference() value")).rows[0].value;
  const audit = [{ user_id: actor, user_name: "Synthetic Editor", user_email: "editor@example.invalid", action: "MYCOI_IMPORT_APPLIED", details: { synthetic: true } }];
  const stage = async (rows, choices) => (await db.query(`INSERT INTO mycoi_import_runs(file_name,created_by,source_rows,decisions)
    VALUES('synthetic.xlsx',$1,$2::jsonb,$3::jsonb) RETURNING *`, [actor, JSON.stringify(rows), JSON.stringify(choices)])).rows[0];
  const apply = async (run, expectedToken, plan, audits = audit, user = actor) => (await db.query(
    "SELECT mycoi_apply_import($1,$2,$3,$4::jsonb,$5::jsonb,$6) result",
    [run.id, run.revision, expectedToken, JSON.stringify(plan), JSON.stringify(audits), user])).rows[0].result;
  source = [row(2), row(3, { "Division Name": "24003 - Synthetic College", "Compliance Status": "Non-Compliant In-Progress", "Policy Expiration Dates": two }),
    row(4, { "Vendor Name": "Unmapped Synthetic", "Division Name": "Unknown", "Policy Expiration Dates": "bad" })];
  decisions = initialDecisions();
  decisions.divisions = {};
  let run = await stage(source, decisions);
  reference = await ref();
  preview = buildMycoiPreview(source, decisions, reference);
  assert.equal(preview.ready.length, 1);
  const result = await apply(run, reference.token, preview.ready);
  assert.deepEqual(plain(result), { rows: 2, vendors: 1, policies: 3, changes: 13, exceptions: 1 });
  let state = await ref();
  assert.equal(state.vendors.length, 1);
  assert.equal(state.divisions.length, 2);
  assert.equal(state.statuses.length, 2);
  assert.equal(state.policies.length, 3);
  assert.equal(state.links.length, 5);
  assert.ok(state.policies.some((policy) => policy.expired && policy.expiration_date === "2025-06-01"));
  assert.deepEqual(await snapshot(), before);
  run = await stage(source.slice(0, 2), blankDecisions());
  preview = buildMycoiPreview(source.slice(0, 2), blankDecisions(), state);
  assert.equal(preview.ready.length, 1, "Saved mappings reused without manual decisions");
  const repeated = await apply(run, state.token, preview.ready);
  assert.equal(repeated.changes, 0);
  state = await ref();
  assert.equal(state.policies.length, 3);
  assert.equal(state.statuses.length, 2);
  const beforeFail = await snapshot();
  const badRun = await stage([row(2)], blankDecisions());
  preview = buildMycoiPreview([row(2)], blankDecisions(), state);
  await assert.rejects(apply(badRun, state.token, preview.ready, [{ ...audit[0], user_id: "00000000-0000-0000-0000-000000000002" }]), /Audit actor mismatch/);
  assert.equal((await db.query("SELECT import_history_id FROM mycoi_import_runs WHERE id=$1", [badRun.id])).rows[0].import_history_id, null);
  await db.exec("ALTER TABLE administration_audit_log ADD CONSTRAINT synthetic_audit_failure CHECK(action<>'FORCED_FAILURE')");
  await assert.rejects(apply(badRun, state.token, preview.ready, [{ ...audit[0], action: "FORCED_FAILURE" }]), /synthetic_audit_failure/);
  assert.deepEqual(plain(await ref()), plain(state), "Actual audit storage failure rolls back all myCOI data/provenance");
  assert.equal((await db.query("SELECT import_history_id FROM mycoi_import_runs WHERE id=$1", [badRun.id])).rows[0].import_history_id, null);
  await db.exec("ALTER TABLE administration_audit_log DROP CONSTRAINT synthetic_audit_failure");
  assert.deepEqual(await snapshot(), beforeFail);
  await assert.rejects(apply(badRun, "stale", preview.ready), /refresh preview/);
  await assert.rejects(apply(badRun, state.token, preview.ready, audit, "00000000-0000-0000-0000-000000000002"), /permissions/);
  const later = row(2, { "Compliance Status": "Non-Compliant Finalized", "Vendor Email": "", "Vendor Phone": "",
    "Policy Expiration Dates": row(2)["Policy Expiration Dates"].replace("2027", "2028") });
  run = await stage([later], blankDecisions());
  state = await ref();
  const laterPreview = buildMycoiPreview([later], blankDecisions(), state);
  await apply(run, state.token, laterPreview.ready);
  state = await ref();
  assert.equal(state.vendors[0].vendor_email, "vendor@example.invalid");
  assert.equal(state.vendors[0].vendor_phone, "(201) 555-0100");
  assert.ok(state.statuses.some((item) => !item.is_current));
  assert.ok(state.policies.some((item) => !item.is_current && item.expiration_date === "2027-06-01"));
  assert.ok(state.policies.some((item) => item.is_current && item.expiration_date === "2028-06-01"));
  const blank = row(2, { "Policy Expiration Dates": "", "Vendor Email": "", "Vendor Phone": "" });
  run = await stage([blank], blankDecisions());
  const count = state.policies.length;
  await apply(run, state.token, buildMycoiPreview([blank], blankDecisions(), state).ready);
  state = await ref();
  assert.equal(state.policies.length, count);
  const ignored = row(2, { "Vendor Name": "Leave ignored", "Policy Expiration Dates": "bad" });
  decisions = blankDecisions(); decisions.ignored = [2];
  run = await stage([ignored], decisions);
  const ignoredResult = await apply(run, state.token, []);
  assert.equal(ignoredResult.exceptions, 0);
  assert.equal(ignoredResult.rows, 0);
  assert.equal((await ref()).policies.length, count);
  const alias = row(2, { "Vendor Name": "Synthetic Vendor Alias", "Vendor Email": "alias@example.invalid",
    "Policy Expiration Dates": row(2)["Policy Expiration Dates"].replace("2027", "2028") });
  const aliasDecisions = blankDecisions();
  aliasDecisions.vendors["synthetic vendor alias"] = 1;
  run = await stage([alias], aliasDecisions);
  state = await ref();
  await apply(run, state.token, buildMycoiPreview([alias], aliasDecisions, state).ready);
  state = await ref();
  assert.equal(state.vendors.length, 2, "Distinct raw aliases can map to one contractor");
  const aliasMapping = state.vendors.find((item) => item.raw_vendor_name === "Synthetic Vendor Alias");
  assert.equal(state.policies.filter((item) => item.vendor_mapping_id === aliasMapping.id).length, 2);
  assert.ok(state.links.every((link) => state.policies.find((item) => item.id === link.policy_id).vendor_mapping_id
    === state.statuses.find((item) => item.id === link.contractor_division_id).vendor_mapping_id), "Aliases never manufacture cross-vendor associations");
  const dual = row(2, { "Policy Expiration Dates":
    "policyNumber: SYN-DUAL; expirationDate: 06/01/2025; isExpired: true; policyLines: General Liability, policyNumber: SYN-DUAL; expirationDate: 06/01/2029; isExpired: false; policyLines: General Liability" });
  run = await stage([dual], blankDecisions()); state = await ref();
  await apply(run, state.token, buildMycoiPreview([dual], blankDecisions(), state).ready);
  state = await ref();
  const dualCount = state.policies.length;
  const reordered = row(2, { "Policy Expiration Dates": dual["Policy Expiration Dates"].split(", policyNumber: ").reverse().map((part) => part.startsWith("policyNumber:") ? part : `policyNumber: ${part}`).join(", ") });
  run = await stage([reordered], blankDecisions());
  const dualRepeated = await apply(run, state.token, buildMycoiPreview([reordered], blankDecisions(), state).ready);
  assert.equal(dualRepeated.changes, 0, "Multiple expirations of the same number are repeat-safe regardless of source order");
  assert.equal((await ref()).policies.length, dualCount);
  const spaced = row(2, { "Vendor Name": "\tSynthetic Tab Vendor\t", "Policy Expiration Dates": "" });
  const spacedDecisions = blankDecisions();
  spacedDecisions.vendors[mycoiKey(spaced["Vendor Name"])] = 1;
  run = await stage([spaced], spacedDecisions); state = await ref();
  await apply(run, state.token, buildMycoiPreview([spaced], spacedDecisions, state).ready);
  state = await ref(); run = await stage([spaced], blankDecisions());
  const spacedRepeated = await apply(run, state.token, buildMycoiPreview([spaced], blankDecisions(), state).ready);
  assert.equal(spacedRepeated.changes, 0, "Source normalization matches generated database keys");
  await db.exec("SET ROLE authenticated");
  await assert.rejects(db.query("SELECT mycoi_import_reference()"), /permission denied/);
  await assert.rejects(apply(run, state.token, []), /permission denied/);
  await assert.rejects(db.exec("DELETE FROM mycoi_import_runs"), /permission denied/);
  await assert.rejects(db.exec("INSERT INTO mycoi_import_runs(file_name) VALUES('denied')"), /permission denied/);
  await db.exec("SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',false)");
  assert.ok((await db.query("SELECT count(*)::integer n FROM mycoi_import_runs")).rows[0].n > 0, "Viewer can read history");
  await db.exec("SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000003',false)");
  assert.equal((await db.query("SELECT count(*)::integer n FROM mycoi_import_runs")).rows[0].n, 0, "Unprovisioned actor cannot read staging data");
  await db.exec("RESET ROLE");
  assert.deepEqual(await snapshot(), before);
  const histories = (await db.query("SELECT * FROM import_history")).rows;
  assert.ok(histories.every((item) => item.file_name === "synthetic.xlsx"));
  assert.ok((await db.query("SELECT count(*)::integer n FROM administration_audit_log")).rows[0].n >= 5);
  console.log("PASS: atomic SQL imports, durable raw rows/partial exceptions, first/saved mappings, project statuses, multiple lines/policies, cross-division deduplication, exact rerun idempotence");
  console.log("PASS: historical expiration/status superseding, blank contact/policy retention, SQL dates/source flags, legacy/master snapshots unchanged");
  console.log("PASS: stale previews/permissions denied, audit failure rolls back insurance/history/run, service-only RPCs, RLS and no ordinary staging writes/deletes");
} finally { await db.close(); }
console.log("PASS: deterministic observed-format parser, malformed/unknown/blank variants, XLSX/CSV round trips, mapping/contact review, placeholder and ambiguity handling");
