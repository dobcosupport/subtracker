import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
import ts from "typescript";
import * as XLSX from "xlsx";
const require = createRequire(import.meta.url);
const { PGlite } = require("@electric-sql/pglite");
const read = (name) => fs.readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
const cache = new Map();
function load(name) {
  if (cache.has(name)) return cache.get(name);
  const mod = { exports: {} };
  const requireLocal = (id) => id === "xlsx" ? XLSX : load(id.replace("@/lib/", "src/lib/").replace("@/types/", "types/") + ".ts");
  vm.runInNewContext(ts.transpileModule(read(name), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module: mod, exports: mod.exports, require: requireLocal });
  cache.set(name, mod.exports);
  return mod.exports;
}
const { buildProcorePreview } = load("src/lib/procore-preview.ts");
const { parseProcoreWorkbook } = load("src/lib/procore-parser.ts");
const { PROCORE_HEADINGS } = load("types/procore-import.ts");
const row = (number, company = "Synthetic Existing", project = "22-002", name = "", email = "") => ({
  row: number, "Company (Vendor) > Name": company, "Company (Vendor) > Business Phone": "2015551000",
  "Company (Vendor) > Address": "123 Test Street", "Company (Vendor) > City": "Test City",
  "Company (Vendor) > State": "NJ", "Company (Vendor) > Zip": "00123", "Project > Number": project,
  "User > Full Name": name, "User > Email Address": email, "User > Business Phone": name ? "2015552000" : "",
  "User > Cell Phone": name ? "2015553000" : "",
});
const source = [
  row(2, undefined, undefined, "Test Person", "PERSON@EXAMPLE.INVALID"),
  row(3, undefined, "24-003", "Test Person", "person@example.invalid"),
  row(4), row(5, "Synthetic New LLC", "24-003", "New Person", "new@example.invalid"),
  row(6, "Synthetic New, L.L.C.", "22-002", "New Person", "new@example.invalid"),
  row(7, "Unmatched Vendor"), row(8, undefined, "22002"),
  row(9, "Staged Only", "not-a-project"), row(10, undefined, "24-003", "", "invalid"),
];
const workbook = (data) => {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(data), "Procore");
  return XLSX.write(book, { type: "array", bookType: "xlsx" });
};
const cells = [PROCORE_HEADINGS, ...source.map((r) => PROCORE_HEADINGS.map((h) => r[h]))];
assert.equal(parseProcoreWorkbook(workbook(cells), "fixture.xlsx").length, source.length);
const grouped = [
  ["Company (Vendor)", "", "", "", "", "", "Project", "User", "", "", ""],
  ["Name", "Business Phone", "Address", "City", "State", "Zip", "Number", "Full Name", "Email Address", "Business Phone", "Cell Phone"],
  ...cells.slice(1),
];
assert.equal(parseProcoreWorkbook(workbook(grouped), "fixture.xlsx").length, source.length);
assert.throws(() => parseProcoreWorkbook(workbook([["Wrong"], ["x"]]), "fixture.xlsx"), /heading/i);
const bigRows = Array.from({ length: 6000 }, (_, index) => row(index + 2, "Synthetic Existing", index % 2 ? "24-003" : "22-002", "Test Person", "person@example.invalid"));
const refShape = { token: "", contractors: [{ id: 1, company_name: "Synthetic Existing", active: true }],
  projects: [{ id: 1, project_number: "22-002", project_name: "A" }, { id: 2, project_number: "24-003", project_name: "B" }], vendors: [], contacts: [] };
const bigPreview = buildProcorePreview(bigRows, { vendors: { "synthetic existing": { action: "MATCH", contractorId: 1 } } }, refShape);
assert.equal(bigPreview.summary.contractors, 1); assert.equal(bigPreview.summary.contacts, 1);
assert.equal(bigPreview.summary.assignments, 2); assert.equal(bigPreview.ready[0].contacts.length, 1);
const mixedIdentity = buildProcorePreview([
  row(2, undefined, undefined, "Same Person", "same@example.invalid"),
  row(3, undefined, "24-003", " same   PERSON ", ""),
], { vendors: { "synthetic existing": { action: "MATCH", contractorId: 1 } } }, refShape);
assert.equal(mixedIdentity.summary.contacts, 1, "Name-only source joins a unique email identity");
assert.equal(mixedIdentity.ready[0].contacts.length, 1);
assert.equal(mixedIdentity.ready[0].contacts[0].rows.length, 2);
const aliasContacts = buildProcorePreview([
  row(2, "First Alias", "22-002", "Same Person", ""),
  row(3, "Second Alias", "22-002", "same person", "same@example.invalid"),
], { vendors: { "first alias": { action: "MATCH", contractorId: 1 }, "second alias": { action: "MATCH", contractorId: 1 } } }, refShape);
assert.equal(aliasContacts.summary.contractors, 1);
assert.equal(aliasContacts.summary.contacts, 1, "Aliases matched to one contractor share a contact identity");
assert.equal(aliasContacts.contacts.length, 1);
assert.equal(aliasContacts.summary.readyAssignments, 1);
for (const plan of aliasContacts.ready) {
  assert.equal(plan.contacts[0].email, "same@example.invalid", "Available email is retained even if the first alias has none");
  assert.equal(plan.contacts[0].rows.length, 1, "Contact lineage remains scoped to its vendor's source row");
}
const fallback = buildProcorePreview([row(2, undefined, undefined, "  Same   Person  ", "")],
  { vendors: { "synthetic existing": { action: "MATCH", contractorId: 1 } } },
  { ...refShape, contacts: [{ id: "existing", contractor_id: 1, contact_name: "same person", email: "known@example.invalid",
    business_phone: null, mobile_phone: null, is_active: false }] });
assert.equal(fallback.contacts[0].existingId, "existing", "Name fallback preserves inactive existing identity");
const ambiguousProject = buildProcorePreview([row(2)], { vendors: {} },
  { ...refShape, projects: [...refShape.projects, { id: 99, project_number: "22-002", project_name: "Duplicate" }] });
assert.equal(ambiguousProject.projects[0].projectId, null);
const conflictingCompany = buildProcorePreview([row(2, "Brand New"), { ...row(3, "Brand New"), "Company (Vendor) > City": "Different" }],
  { vendors: { "brand new": { action: "ADD" } } }, refShape);
assert.equal(conflictingCompany.ready.length, 0, "Conflicting company fields cannot create a partial silent contractor");
const db = await PGlite.create();
const actor = "00000000-0000-0000-0000-000000000001";
try {
  await db.exec(`
    CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth; CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
      $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    GRANT USAGE ON SCHEMA auth TO authenticated;
    CREATE TABLE user_profiles(auth_user_id uuid PRIMARY KEY,role text,status text,name text,email text,system_administrator boolean);
    CREATE TABLE role_permissions(role text,module text,can_view boolean,can_manage boolean,can_add boolean,can_edit boolean);
    INSERT INTO user_profiles VALUES('${actor}','Administrator','Active','Fixture Admin','admin@example.invalid',true);
    CREATE FUNCTION user_has_module_permission(text,text) RETURNS boolean LANGUAGE sql AS $$SELECT auth.uid()='${actor}'::uuid$$;
    CREATE TABLE contractors(id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,company_name text,phone text,address_1 text,city text,state text,zip_code text,active boolean DEFAULT true,
      creation_source text DEFAULT 'MANUAL',creation_import_history_id integer);
    INSERT INTO contractors(company_name,phone) VALUES('Synthetic Existing','DO NOT CHANGE'),('Unrelated','PROTECTED');
    CREATE TABLE projects(id integer PRIMARY KEY,project_number text,project_name text);
    INSERT INTO projects VALUES(1,'22-002','A'),(2,'24-003','B'),(3,'99-001','Unrelated');
    CREATE TABLE contractor_projects(id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,contractor_id integer REFERENCES contractors,
      project_id integer REFERENCES projects,assigned_date date DEFAULT current_date,removed_date date,active boolean DEFAULT true,
      ownership_sources text[] DEFAULT '{}',manual_owned boolean GENERATED ALWAYS AS ('MANUAL'=ANY(ownership_sources)) STORED,
      mycoi_owned boolean GENERATED ALWAYS AS ('MYCOI'=ANY(ownership_sources)) STORED,
      procore_owned boolean GENERATED ALWAYS AS ('PROCORE'=ANY(ownership_sources)) STORED);
    CREATE UNIQUE INDEX active_pair ON contractor_projects(contractor_id,project_id) WHERE active;
    INSERT INTO contractor_projects(contractor_id,project_id,ownership_sources) VALUES(1,1,ARRAY['MANUAL','MYCOI']),(2,3,ARRAY['MANUAL']);
    CREATE TABLE import_history(id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,file_name text,imported_rows integer,successful_rows integer,failed_rows integer,notes text);
    CREATE TABLE administration_audit_log(id bigint GENERATED ALWAYS AS IDENTITY,user_id uuid,user_name text,user_email text,action text,object_type text,object_id text,object_label text,details jsonb);
    CREATE TABLE activity_log(id integer GENERATED ALWAYS AS IDENTITY,contractor_id integer,project_id integer,activity_type text,notes text,created_by text);
    CREATE TABLE relationship_sources(source text PRIMARY KEY);
    INSERT INTO relationship_sources VALUES('MANUAL'),('MYCOI'),('PROCORE');
    CREATE FUNCTION mycoi_unchanged_marker() RETURNS text LANGUAGE sql AS $$SELECT 'unchanged'::text$$;
  `);
  const ownership = read("supabase/20261104_mycoi_insurance_project_ownership.sql");
  for (const marker of ["CREATE FUNCTION public.contractor_import_name_key(", "CREATE FUNCTION public.audit_project_ownership()", "CREATE FUNCTION public.set_project_assignment_source("]) {
    const start = ownership.indexOf(marker);
    await db.exec(ownership.slice(start, ownership.indexOf("$$;", start) + 3));
  }
  await db.exec("CREATE TRIGGER ownership_audit AFTER INSERT OR UPDATE ON contractor_projects FOR EACH ROW EXECUTE FUNCTION audit_project_ownership()");
  await db.exec(read("supabase/20261023_contractor_contacts.sql"));
  await db.exec(`INSERT INTO contractor_contacts(contractor_id,contact_name,email,mobile_phone) VALUES(1,'Test Person','person@example.invalid','ORIGINAL MOBILE')`);
  const migration = read("supabase/20261110_procore_import_workflow.sql");
  const beforeContacts = (await db.query("SELECT to_jsonb(c) row FROM contractor_contacts c")).rows;
  const beforeOwnership = (await db.query("SELECT to_jsonb(c) row FROM contractor_projects c ORDER BY id")).rows;
  await assert.rejects(db.exec(migration.replace(/COMMIT;\s*$/, "SELECT 1/0; COMMIT;")), /division by zero/);
  await db.exec("ROLLBACK");
  assert.equal((await db.query("SELECT to_regclass('procore_import_runs') value")).rows[0].value, null);
  await db.exec(migration);
  assert.deepEqual((await db.query("SELECT to_jsonb(c)-'business_phone' row FROM contractor_contacts c")).rows, beforeContacts);
  assert.deepEqual((await db.query("SELECT to_jsonb(c) row FROM contractor_projects c ORDER BY id")).rows, beforeOwnership);
  const reference = async () => (await db.query("SELECT procore_import_reference() value")).rows[0].value;
  const decisions = { vendors: { "synthetic existing": { action: "MATCH", contractorId: 1 },
    "synthetic new": { action: "ADD" }, "staged only": { action: "ADD" }, "unmatched vendor": { action: "UNMATCHED" } } };
  let run = (await db.query("INSERT INTO procore_import_runs(file_name,created_by,source_rows) VALUES('fixture.xlsx',$1,$2) RETURNING *", [actor, JSON.stringify(source)])).rows[0];
  run = (await db.query("SELECT to_jsonb(procore_save_review($1,$2,$3,$4)) value", [run.id, run.revision, JSON.stringify(decisions), actor])).rows[0].value;
  const ref = await reference();
  const preview = buildProcorePreview(source, decisions, ref);
  assert.equal(preview.summary.contractors, 4);
  assert.equal(preview.projects.find((p) => p.number === "22002").projectId, null);
  assert.equal(preview.ready.length, 2);
  assert(preview.contacts.some((c) => c.issue?.includes("invalid")));
  assert.equal(preview.ready[0].contacts[0].business_phone, "2015552000");
  const tables = ["contractors", "contractor_projects", "contractor_contacts", "import_history", "administration_audit_log", "activity_log", "procore_import_runs", "procore_vendor_mappings", "procore_import_lineage"];
  const state = async () => Object.fromEntries(await Promise.all(tables.map(async (t) =>
    [t, (await db.query(`SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY to_jsonb(x)::text),'[]') value FROM ${t} x`)).rows[0].value])));
  const apply = () => db.query("SELECT procore_apply_import($1,$2,$3,$4,$5) value", [run.id, run.revision, ref.token, JSON.stringify(preview.ready), actor]);
  const expectRollback = async (fn, pattern) => {
    const before = await state(); await db.exec("BEGIN");
    await assert.rejects(fn(), pattern); await db.exec("ROLLBACK"); assert.deepEqual(await state(), before);
  };
  await expectRollback(() => db.query("SELECT procore_apply_import($1,$2,$3,$4,$5)", [run.id, run.revision, "stale", JSON.stringify(preview.ready), actor]), /Reference data changed/);
  await expectRollback(() => db.query("SELECT procore_save_review($1,0,$2,$3)", [run.id, JSON.stringify(decisions), actor]), /changed/);
  await expectRollback(() => db.query("SELECT procore_apply_import($1,$2,$3,$4,$5)", [run.id, run.revision, ref.token, JSON.stringify(preview.ready), "00000000-0000-0000-0000-000000000099"]), /permission denied/);
  for (const [table, condition] of [["administration_audit_log", "action<>'PROCORE_IMPORT_APPLIED'"], ["activity_log", "activity_type<>'Project Source ADDED'"], ["procore_import_lineage", "source_row<>5"]]) {
    await db.exec(`ALTER TABLE ${table} ADD CONSTRAINT fixture_failure CHECK (${condition})`);
    await expectRollback(apply, /fixture_failure/);
    await db.exec(`ALTER TABLE ${table} DROP CONSTRAINT fixture_failure`);
  }
  const result = (await apply()).rows[0].value;
  assert.equal(result.contractors_created, 1); assert.equal(result.contacts_created, 1); assert.equal(result.ownership_removals, 0);
  assert.deepEqual((await db.query("SELECT ownership_sources FROM contractor_projects WHERE contractor_id=1 AND project_id=1")).rows[0].ownership_sources, ["MANUAL", "MYCOI", "PROCORE"]);
  assert.equal((await db.query("SELECT count(*)::int n FROM contractor_contacts")).rows[0].n, 2);
  const created = (await db.query("SELECT * FROM contractors WHERE creation_source='PROCORE'")).rows[0];
  assert.equal(created.address_1, "123 Test Street"); assert.equal(created.zip_code, "00123"); assert.equal(created.phone, "2015551000");
  const newContact = (await db.query("SELECT * FROM contractor_contacts WHERE contractor_id=$1", [created.id])).rows[0];
  assert.equal(newContact.business_phone, "2015552000"); assert.equal(newContact.mobile_phone, "2015553000");
  assert.equal(newContact.receives_compliance_sms, false); assert.equal(newContact.is_primary_contact, false);
  assert.equal((await db.query("SELECT phone FROM contractors WHERE id=1")).rows[0].phone, "DO NOT CHANGE");
  assert.deepEqual((await db.query("SELECT to_jsonb(c)-'business_phone' row FROM contractor_contacts c WHERE contractor_id=1")).rows, beforeContacts);
  assert.equal((await db.query("SELECT count(*)::int n FROM procore_import_lineage")).rows[0].n, 6);
  assert.equal((await db.query("SELECT count(*)::int n FROM contractors WHERE company_name='Staged Only'")).rows[0].n, 0);
  await expectRollback(apply, /changed/);
  run = (await db.query("SELECT * FROM procore_import_runs WHERE id=$1", [run.id])).rows[0];
  const nextRef = await reference();
  const nextPreview = buildProcorePreview(source, decisions, nextRef, run.imported_rows);
  assert.equal(nextPreview.ready.length, 0);
  const snapshot = { preview: nextPreview, contractors: nextRef.contractors, token: "" };
  const businessBeforeFinalize = await state();
  const finalized = (await db.query("SELECT procore_finalize_import($1,$2,$3,$4,$5) value", [run.id, run.revision, nextRef.token, JSON.stringify(snapshot), actor])).rows[0].value;
  assert(finalized.finalized_at);
  for (const t of tables.filter((t) => !["procore_import_runs", "administration_audit_log"].includes(t))) {
    assert.deepEqual((await state())[t], businessBeforeFinalize[t], `Finalize changed ${t}`);
  }
  await expectRollback(() => db.query("SELECT procore_save_review($1,$2,$3,$4)", [run.id, run.revision + 1, JSON.stringify(decisions), actor]), /Finalized/);
  const history = (await db.query("SELECT procore_list_import_runs(true,0,$1) value", [actor])).rows[0].value;
  assert.equal(history.length, 1);
  assert.equal((await db.query("SELECT procore_list_import_runs(false,0,$1) value", [actor])).rows[0].value.length, 0);
  assert.equal((await db.query("SELECT mycoi_unchanged_marker() value")).rows[0].value, "unchanged");
  const aliasRows = [row(2, "First Alias", "22-002", "Same Person", ""),
    row(3, "Second Alias", "22-002", "same person", "same@example.invalid")];
  const aliasDecisions = { vendors: { "first alias": { action: "MATCH", contractorId: 1 },
    "second alias": { action: "MATCH", contractorId: 1 } } };
  let aliasRun = (await db.query("INSERT INTO procore_import_runs(file_name,created_by,source_rows) VALUES('aliases.xlsx',$1,$2) RETURNING *",
    [actor, JSON.stringify(aliasRows)])).rows[0];
  aliasRun = (await db.query("SELECT to_jsonb(procore_save_review($1,$2,$3,$4)) value",
    [aliasRun.id, aliasRun.revision, JSON.stringify(aliasDecisions), actor])).rows[0].value;
  const aliasReference = await reference();
  const aliasPlan = buildProcorePreview(aliasRows, aliasDecisions, aliasReference);
  const aliasResult = (await db.query("SELECT procore_apply_import($1,$2,$3,$4,$5) value",
    [aliasRun.id, aliasRun.revision, aliasReference.token, JSON.stringify(aliasPlan.ready), actor])).rows[0].value;
  assert.equal(aliasResult.assignments, 1, "Two aliases do not inflate the unique assignment result");
  assert.equal(aliasResult.contacts_created, 1);
  const aliasLineage = (await db.query("SELECT contact_id FROM procore_import_lineage WHERE import_run_id=$1", [aliasRun.id])).rows;
  assert.equal(aliasLineage.length, 2);
  assert.equal(aliasLineage[0].contact_id, aliasLineage[1].contact_id);
  assert.equal((await db.query("SELECT email FROM contractor_contacts WHERE id=$1", [aliasLineage[0].contact_id])).rows[0].email, "same@example.invalid");
  const sourceCombinations = [["MYCOI"], ["PROCORE"], ["MANUAL", "PROCORE"], ["MYCOI", "PROCORE"]];
  for (const [index, sources] of sourceCombinations.entries()) {
    await db.query("INSERT INTO projects(id,project_number,project_name) VALUES($1,$2,'Source preservation')", [100 + index, `COMBO-${index}`]);
    await db.query("INSERT INTO contractor_projects(contractor_id,project_id,ownership_sources) VALUES(1,$1,$2)", [100 + index, sources]);
    const addition = (await db.query("SELECT to_jsonb(set_project_assignment_source(1,$1,'PROCORE',true)) value", [100 + index])).rows[0].value;
    assert.deepEqual(new Set(addition.ownership_sources), new Set([...sources, "PROCORE"]));
  }
  for (const name of ["procore_apply_import(uuid,integer,text,jsonb,uuid)", "procore_finalize_import(uuid,integer,text,jsonb,uuid)"]) {
    assert.equal((await db.query("SELECT has_function_privilege('authenticated',$1,'EXECUTE') value", [name])).rows[0].value, false);
    assert.equal((await db.query("SELECT has_function_privilege('service_role',$1,'EXECUTE') value", [name])).rows[0].value, true);
  }
  const oldValues = { contact_name: "Manual Contact", title_or_role: null, email: null, mobile_phone: "MOBILE",
    is_primary_contact: false, is_compliance_contact: false, receives_compliance_email: false,
    receives_compliance_sms: false, sms_consent_recorded: false, sms_consent_date: null, sms_consent_source_or_note: null, is_active: true };
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [actor]);
  let saved = (await db.query("SELECT to_jsonb(save_contractor_contact(1,null,$1)) value", [JSON.stringify({ ...oldValues, business_phone: "OFFICE" })])).rows[0].value;
  assert.equal(saved.business_phone, "OFFICE"); assert.equal(saved.mobile_phone, "MOBILE");
  saved = (await db.query("SELECT to_jsonb(save_contractor_contact(1,$1,$2)) value", [saved.id, JSON.stringify(oldValues)])).rows[0].value;
  assert.equal(saved.business_phone, "OFFICE"); assert.equal(saved.mobile_phone, "MOBILE");
  console.log("PASS: Procore parser flattened/grouped headers, 6000-row unique summaries, company dedup/matching/Add/unmatched, exact project numbers, blank/invalid contacts do not block assignments; additive migration rollback/no backfill; separate phones; contact email/name dedup; existing company/contacts/preferences retained; MANUAL+MYCOI+PROCORE preservation; row lineage; stale/reference/permission rejection; audit/activity/lineage rollback; repeat import no duplicates; unmatched/staged Finalize without data changes; frozen history; service-only ACL; legacy contact RPC compatibility.");
} finally { await db.close(); }
