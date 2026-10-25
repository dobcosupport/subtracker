import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
import ts from "typescript";
const require = createRequire(import.meta.url);
const { PGlite } = require("@electric-sql/pglite");
const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const cache = new Map();
function load(file) {
  if (cache.has(file)) return cache.get(file);
  const mod = { exports: {} };
  vm.runInNewContext(ts.transpileModule(read(file), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText, { module: mod, exports: mod.exports,
    require: (id) => load(id.replace("@/lib/", "src/lib/").replace("@/types/", "types/") + ".ts") });
  cache.set(file, mod.exports); return mod.exports;
}
const { buildProcorePreview } = load("src/lib/procore-preview.ts");
const { PROCORE_HEADINGS } = load("types/procore-import.ts");
const actor = "00000000-0000-0000-0000-000000000001";
const source = [20, 21].map((row) => ({ row, ...Object.fromEntries(PROCORE_HEADINGS.map((h) => [h, ""])),
  "Company (Vendor) > Name": "A&A Concrete Products Inc.", "Project > Number": "25-900",
  "Company (Vendor) > Address": "PO BOX 108", "Company (Vendor) > City": "Riverdale",
  "Company (Vendor) > State": "NJ", "Company (Vendor) > Zip": "07457" }));
const decisions = { vendors: { "a and a concrete products": { action: "ADD" } } };
const db = await PGlite.create();
try {
  await db.exec(`
    CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth; CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$SELECT '${actor}'::uuid$$;
    CREATE TABLE user_profiles(auth_user_id uuid PRIMARY KEY,role text,status text,name text,email text,system_administrator boolean);
    INSERT INTO user_profiles VALUES('${actor}','Admin','Active','Test','test@example.invalid',true);
    CREATE TABLE role_permissions(role text,module text,can_view boolean,can_manage boolean,can_add boolean,can_edit boolean);
    CREATE TABLE contractors(id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,company_name text,phone text,address_1 text,
      city text,state text,zip_code text,active boolean,creation_source text,creation_import_history_id integer);
    CREATE TABLE projects(id integer PRIMARY KEY,project_number text,project_name text);
    INSERT INTO projects VALUES(45,'25900','CHURCH - Montclair'),(46,'24-003','Other');
    CREATE TABLE contractor_contacts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),contractor_id integer REFERENCES contractors,
      contact_name text,email text,mobile_phone text,is_active boolean DEFAULT true);
    CREATE FUNCTION save_contractor_contact(integer,uuid,jsonb) RETURNS contractor_contacts LANGUAGE sql AS
      $$SELECT * FROM contractor_contacts LIMIT 1$$;
    CREATE TABLE contractor_projects(id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,contractor_id integer REFERENCES contractors,
      project_id integer REFERENCES projects,active boolean DEFAULT true,ownership_sources text[] DEFAULT '{}',UNIQUE(contractor_id,project_id));
    CREATE FUNCTION set_project_assignment_source(integer,integer,text,boolean) RETURNS contractor_projects LANGUAGE plpgsql AS $$
      DECLARE saved contractor_projects; BEGIN
        INSERT INTO contractor_projects(contractor_id,project_id,ownership_sources) VALUES($1,$2,ARRAY[$3])
        ON CONFLICT(contractor_id,project_id) DO UPDATE SET ownership_sources=
          CASE WHEN $3=ANY(contractor_projects.ownership_sources) THEN contractor_projects.ownership_sources
            ELSE array_append(contractor_projects.ownership_sources,$3) END RETURNING * INTO saved; RETURN saved;
      END; $$;
    CREATE TABLE import_history(id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,file_name text,imported_rows integer,
      successful_rows integer,failed_rows integer,notes text);
    CREATE TABLE administration_audit_log(audit_date timestamptz DEFAULT now(),user_id uuid,user_name text,user_email text,action text,object_type text,
      object_id text,object_label text,details jsonb);
  `);
  const ownership = read("supabase/20261104_mycoi_insurance_project_ownership.sql");
  const start = ownership.indexOf("CREATE FUNCTION public.contractor_import_name_key(");
  await db.exec(ownership.slice(start, ownership.indexOf("$$;", start) + 3));
  await db.exec(read("supabase/20261110_procore_import_workflow.sql"));
  const migration = read("supabase/20261112_procore_project_mappings.sql");
  const priorRpc = (await db.query("SELECT pg_get_functiondef('procore_apply_import(uuid,integer,text,jsonb,uuid)'::regprocedure) definition")).rows[0].definition;
  await assert.rejects(db.exec(migration.replace(/COMMIT;\s*$/, "SELECT 1/0; COMMIT;")), /division by zero/);
  await db.exec("ROLLBACK");
  assert.equal((await db.query("SELECT to_regclass('procore_project_mappings') value")).rows[0].value, null);
  assert.equal((await db.query("SELECT pg_get_functiondef('procore_apply_import(uuid,integer,text,jsonb,uuid)'::regprocedure) definition")).rows[0].definition, priorRpc);
  await db.exec(migration);
  const reference = async () => (await db.query("SELECT procore_import_reference() value")).rows[0].value;
  let run = (await db.query("INSERT INTO procore_import_runs(file_name,created_by,source_rows,decisions) VALUES('aa.xlsx',$1,$2,$3) RETURNING *",
    [actor, JSON.stringify(source), JSON.stringify(decisions)])).rows[0];
  const reload = async () => { run = (await db.query("SELECT * FROM procore_import_runs WHERE id=$1", [run.id])).rows[0]; };
  const preview = async () => buildProcorePreview(run.source_rows, run.decisions, await reference(), run.imported_rows);
  const save = async (project, token, revision = run.revision, who = actor, number = "25-900") => {
    await db.query("SELECT procore_save_project_mapping($1,$2,$3,$4,$5,$6)",
      [run.id, revision, token ?? (await reference()).token, number, project, who]);
    await reload();
  };
  assert.equal((await preview()).ready.length, 0, "No punctuation-stripping auto-match");
  assert.equal((await db.query("SELECT procore_resolve_project('25900') id")).rows[0].id, 45);
  assert.equal((await db.query("SELECT procore_resolve_project('25-900') id")).rows[0].id, null);
  assert.equal(buildProcorePreview([{ ...source[0], "Project > Number": "25900" }], decisions, await reference()).ready.length, 1);
  const staleToken = (await reference()).token;
  const failure = async (operation, pattern) => {
    await db.exec("BEGIN"); await assert.rejects(operation(), pattern); await db.exec("ROLLBACK"); await reload();
  };
  await failure(() => save(45, "stale"), /Reference data changed/);
  await failure(() => save(999), /existing SubTracker/);
  await failure(() => save(45, undefined, 0), /changed/);
  await failure(() => save(45, undefined, run.revision, "00000000-0000-0000-0000-000000000099"), /permission denied/);
  await failure(() => save(45, undefined, run.revision, actor, "25900"), /Unknown Procore/);
  await save(45);
  assert.deepEqual(run.decisions, decisions, "Company decisions are not modified by project mapping");
  assert.equal(run.revision, 2);
  let plan = await preview();
  assert.equal(plan.ready.length, 1);
  assert.equal(plan.ready[0].assignments[0].projectId, 45);
  assert.equal(plan.ready[0].assignments[0].rows.length, 2);
  assert.equal(plan.projects[0].targetNumber, "25900");
  const sharedDestination = buildProcorePreview([...source, { ...source[0], row: 22, "Project > Number": "25900" }],
    decisions, await reference());
  assert.equal(sharedDestination.summary.assignments, 1, "Mapped and exact numbers for the same project count one relationship");
  assert.equal(sharedDestination.summary.readyAssignments, 1);
  assert.equal((await db.query("SELECT count(*)::int n FROM contractor_projects")).rows[0].n, 0, "No ownership before Import");
  assert.equal((await db.query("SELECT count(*)::int n FROM contractors")).rows[0].n, 0, "Mapping does not create contractor");
  const revision = run.revision;
  await save(45); assert.equal(run.revision, revision, "Repeat saved mapping is a no-op");
  await failure(() => save(46, staleToken), /Reference data changed/);
  await save(46); assert.equal((await preview()).projects[0].projectId, 46, "Intentional correction allowed before Import");
  await save(null); assert.equal((await preview()).ready.length, 0, "Explicit Leave Unmatched is retained");
  await save(45);
  const future = buildProcorePreview(source, decisions, await reference());
  assert.equal(future.ready[0].assignments[0].projectId, 45, "Future reviews reuse approved mapping");
  const beforeProjects = (await db.query("SELECT * FROM projects ORDER BY id")).rows;
  const ref = await reference(); plan = await preview();
  const forged = JSON.parse(JSON.stringify(plan.ready)); forged[0].assignments[0].projectId = 46;
  await failure(() => db.query("SELECT procore_apply_import($1,$2,$3,$4,$5)", [run.id, run.revision, ref.token, JSON.stringify(forged), actor]), /approved Procore mapping/);
  const imported = (await db.query("SELECT procore_apply_import($1,$2,$3,$4,$5) value",
    [run.id, run.revision, ref.token, JSON.stringify(plan.ready), actor])).rows[0].value;
  assert.equal(imported.contractors_created, 1); assert.equal(imported.assignments, 1);
  await reload();
  assert.equal((await preview()).ready.length, 0);
  assert.deepEqual((await db.query("SELECT * FROM projects ORDER BY id")).rows, beforeProjects, "No project renumbering or creation");
  assert.equal((await db.query("SELECT count(*)::int n FROM procore_vendor_mappings")).rows[0].n, 1);
  assert.deepEqual((await db.query("SELECT project_id,ownership_sources FROM contractor_projects")).rows,
    [{ project_id: 45, ownership_sources: ["PROCORE"] }]);
  const lineage = (await db.query("SELECT project_id,evidence FROM procore_import_lineage ORDER BY source_row")).rows;
  assert.equal(lineage.length, 2);
  for (const record of lineage) {
    assert.equal(record.project_id, 45);
    assert.equal(record.evidence.source_row["Project > Number"], "25-900", "Original source retained");
    assert.equal(record.evidence.project_mapping.project_id, 45);
  }
  await failure(() => save(46), /already imported/);
  await failure(async () => db.query("SELECT procore_apply_import($1,$2,$3,$4,$5)",
    [run.id, run.revision, (await reference()).token, JSON.stringify(plan.ready), actor]), /explicit approval|already imported/);
  assert.equal((await db.query("SELECT count(*)::int n FROM contractors")).rows[0].n, 1);
  const contractor = (await db.query("SELECT id FROM contractors")).rows[0].id;
  const contactSource = source.map((row) => ({ ...row, "User > Full Name": "Mapped Contact",
    "User > Email Address": "mapped@example.invalid", "User > Business Phone": "2015551111", "User > Cell Phone": "2015552222" }));
  run = (await db.query("INSERT INTO procore_import_runs(file_name,created_by,source_rows,decisions) VALUES('future.xlsx',$1,$2,$3) RETURNING *",
    [actor, JSON.stringify(contactSource), JSON.stringify({ vendors: { "a and a concrete products": { action: "MATCH", contractorId: contractor } } })])).rows[0];
  const futurePlan = await preview();
  assert.equal(futurePlan.ready[0].assignments[0].projectId, 45);
  await db.query("SELECT procore_apply_import($1,$2,$3,$4,$5)",
    [run.id, run.revision, (await reference()).token, JSON.stringify(futurePlan.ready), actor]);
  await reload();
  assert.equal((await db.query("SELECT count(*)::int n FROM contractors")).rows[0].n, 1);
  assert.equal((await db.query("SELECT count(*)::int n FROM contractor_projects")).rows[0].n, 1);
  assert.deepEqual((await db.query("SELECT contact_name,email,business_phone,mobile_phone FROM contractor_contacts")).rows,
    [{ contact_name: "Mapped Contact", email: "mapped@example.invalid", business_phone: "2015551111", mobile_phone: "2015552222" }]);
  assert.equal((await preview()).ready.length, 0, "Future mapped import also remains idempotent");
  run = (await db.query("INSERT INTO procore_import_runs(file_name,created_by,source_rows) VALUES('exact.xlsx',$1,$2) RETURNING *",
    [actor, JSON.stringify([{ ...source[0], "Project > Number": "25900" }])])).rows[0];
  await save(null, undefined, run.revision, actor, "25900");
  assert.equal((await preview()).projects[0].projectId, null, "Explicit unmatched takes precedence over exact fallback");
  await save(46, undefined, run.revision, actor, "25900");
  assert.equal((await preview()).projects[0].projectId, 46, "Approved mapping takes precedence over exact fallback");
  await failure(() => db.exec("DELETE FROM projects WHERE id=46"), /foreign key/);
  await db.query("SELECT procore_finalize_import($1,$2,$3,$4,$5)", [run.id, run.revision, (await reference()).token,
    JSON.stringify({ preview: await preview(), contractors: [] }), actor]);
  await reload();
  await failure(() => save(45, undefined, run.revision, actor, "25900"), /Finalized/);
  await db.exec("SET ROLE authenticated");
  await assert.rejects(db.query("SELECT * FROM procore_project_mappings"), /permission denied/);
  await assert.rejects(db.query("SELECT procore_save_project_mapping($1,$2,$3,$4,$5,$6)",
    [run.id, run.revision, "", "25-900", 45, actor]), /permission denied/);
  await db.exec("RESET ROLE");
  const overrideMigration = read("supabase/20261113_procore_contractor_match_override.sql");
  const mappingImportRpc = (await db.query("SELECT pg_get_functiondef('procore_apply_import(uuid,integer,text,jsonb,uuid)'::regprocedure) definition")).rows[0].definition;
  await assert.rejects(db.exec(overrideMigration.replace(/COMMIT;\s*$/, "SELECT 1/0; COMMIT;")), /division by zero/);
  await db.exec("ROLLBACK");
  assert.equal((await db.query("SELECT pg_get_functiondef('procore_apply_import(uuid,integer,text,jsonb,uuid)'::regprocedure) definition")).rows[0].definition, mappingImportRpc);
  const retained = (await db.query("SELECT to_jsonb(r) value FROM procore_import_runs r ORDER BY id")).rows;
  await db.exec(overrideMigration);
  assert.deepEqual((await db.query("SELECT to_jsonb(r) value FROM procore_import_runs r ORDER BY id")).rows, retained,
    "Migration changes no existing review");
  const suggested = (await db.query("INSERT INTO contractors(company_name,active) VALUES('C&V Paving Contractors',true) RETURNING *")).rows[0];
  const alternate = (await db.query("INSERT INTO contractors(company_name,active) VALUES('Different Existing',true) RETURNING *")).rows[0];
  const key = "c and v paving contractors";
  const overrideRows = source.map((r) => ({ ...r, "Company (Vendor) > Name": "C&V Paving Contractors",
    "Project > Number": "24-003", "User > Full Name": "Separate Contact", "User > Email Address": "separate@example.invalid" }));
  run = (await db.query("INSERT INTO procore_import_runs(file_name,created_by,source_rows) VALUES('override.xlsx',$1,$2) RETURNING *",
    [actor, JSON.stringify(overrideRows)])).rows[0];
  let state = await preview();
  assert.equal(state.vendors[0].suggestions.length, 1);
  assert.equal(state.vendors[0].suggestions[0].id, suggested.id);
  assert.equal(state.ready.length, 0, "Suggestion is never silently accepted");
  const saveChoices = async (choice, extra = {}) => {
    await db.query("SELECT procore_save_review($1,$2,$3,$4)", [run.id, run.revision,
      JSON.stringify({ vendors: { [key]: choice, ...extra } }), actor]);
    await reload();
  };
  await saveChoices({ action: "MATCH", contractorId: suggested.id });
  assert.equal((await preview()).ready[0].contractorId, suggested.id);
  await saveChoices({ action: "MATCH", contractorId: alternate.id });
  assert.equal((await preview()).ready[0].contractorId, alternate.id);
  const validPlan = (await preview()).ready;
  const forceAddPlan = JSON.parse(JSON.stringify(validPlan));
  forceAddPlan[0].createContractor = true; forceAddPlan[0].contractorId = null;
  const applyPlan = async (plan) => db.query("SELECT procore_apply_import($1,$2,$3,$4,$5) value",
    [run.id, run.revision, (await reference()).token, JSON.stringify(plan), actor]);
  await saveChoices({ action: "ADD" });
  assert.equal((await preview()).ready.length, 0, "Ordinary ADD cannot bypass duplicate-name protection");
  await failure(() => applyPlan(forceAddPlan), /duplicate-name override/);
  for (const approval of [
    { contractorId: alternate.id, companyName: alternate.company_name },
    { contractorId: suggested.id, companyName: "Wrong warning" },
  ]) {
    await failure(() => saveChoices({ action: "ADD", duplicateOverride: approval }), /context changed/);
  }
  await saveChoices({ action: "ADD", duplicateOverride: { contractorId: suggested.id, companyName: suggested.company_name,
    approvedBy: "forged", approvedAt: "forged" } });
  const stampedApproval = run.decisions.vendors[key].duplicateOverride;
  assert.equal(stampedApproval.approvedBy, actor);
  assert.notEqual(stampedApproval.approvedAt, "forged");
  assert.equal((await preview()).ready.length, 1);
  assert.equal((await db.query("SELECT procore_duplicate_override_valid($1,$2,$3) valid",
    [run.id, key, JSON.stringify(stampedApproval)])).rows[0].valid, true);
  await saveChoices({ action: "ADD", duplicateOverride: { contractorId: suggested.id, companyName: suggested.company_name } },
    { unrelated: { action: "UNMATCHED" } });
  assert.deepEqual(run.decisions.vendors[key].duplicateOverride, stampedApproval, "Unrelated saves preserve original approver/time");
  const approvedDecisions = JSON.parse(JSON.stringify(run.decisions));
  const approvedPlan = (await preview()).ready;
  const copiedRun = (await db.query("INSERT INTO procore_import_runs(file_name,created_by,source_rows,decisions) VALUES('copied.xlsx',$1,$2,$3) RETURNING *",
    [actor, JSON.stringify(overrideRows), JSON.stringify(approvedDecisions)])).rows[0];
  await failure(async () => db.query("SELECT procore_apply_import($1,$2,$3,$4,$5)",
    [copiedRun.id, copiedRun.revision, (await reference()).token, JSON.stringify(approvedPlan), actor]), /stale or unverified/);
  const existingHistory = (await db.query("SELECT id FROM import_history ORDER BY id LIMIT 1")).rows[0].id;
  await failure(async () => {
    await db.query("INSERT INTO procore_vendor_mappings(vendor_key,raw_vendor_name,contractor_id,import_run_id,import_history_id,accepted_by) VALUES($1,$2,$3,$4,$5,$6)",
      [key, suggested.company_name, suggested.id, run.id, existingHistory, actor]);
    await applyPlan(approvedPlan);
  }, /existing vendor mapping/);
  const originalContractor = (await db.query("SELECT to_jsonb(c) value FROM contractors c WHERE id=$1", [suggested.id])).rows[0].value;
  await db.query("UPDATE contractors SET company_name='Renamed Suggestion' WHERE id=$1", [suggested.id]);
  assert.equal((await preview()).ready.length, 0, "Renamed warning context fails closed in preview");
  await failure(() => applyPlan(approvedPlan), /stale or unverified/);
  await db.query("UPDATE contractors SET company_name=$1 WHERE id=$2", [suggested.company_name, suggested.id]);
  const duplicate = (await db.query("INSERT INTO contractors(company_name,active) VALUES('C & V Paving Contractors',true) RETURNING id")).rows[0].id;
  assert.equal((await preview()).ready.length, 0, "New ambiguity invalidates approval");
  await failure(() => applyPlan(approvedPlan), /stale or unverified/);
  await db.query("DELETE FROM contractors WHERE id=$1", [duplicate]);
  for (const [field, value] of [["contractorId", alternate.id], ["companyName", "Tampered"], ["approvedBy", "forged"], ["approvedAt", "forged"]]) {
    const tampered = JSON.parse(JSON.stringify(approvedDecisions));
    tampered.vendors[key].duplicateOverride[field] = value;
    await db.query("UPDATE procore_import_runs SET decisions=$1 WHERE id=$2", [JSON.stringify(tampered), run.id]);
    await failure(() => applyPlan(approvedPlan), /stale or unverified/);
  }
  await db.query("UPDATE procore_import_runs SET decisions=$1 WHERE id=$2", [JSON.stringify(approvedDecisions), run.id]);
  await reload();
  await saveChoices({ action: "MATCH", contractorId: suggested.id });
  assert.equal((await preview()).ready[0].createContractor, false, "ADD override can become MATCH before Import");
  await saveChoices({ action: "UNMATCHED" });
  assert.equal((await preview()).ready.length, 0);
  await saveChoices({ action: "ADD", duplicateOverride: { contractorId: suggested.id, companyName: suggested.company_name } });
  const approvalBeforeImport = run.decisions.vendors[key].duplicateOverride;
  const beforeCount = (await db.query("SELECT count(*)::int n FROM contractors")).rows[0].n;
  const separatePlan = (await preview()).ready;
  await db.exec("ALTER TABLE administration_audit_log ADD CONSTRAINT reject_override_audit CHECK(action<>'PROCORE_SEPARATE_CONTRACTOR_CREATED')");
  await failure(() => applyPlan(separatePlan), /reject_override_audit/);
  assert.equal((await db.query("SELECT count(*)::int n FROM contractors")).rows[0].n, beforeCount, "Override audit failure rolls back creation");
  await db.exec("ALTER TABLE administration_audit_log DROP CONSTRAINT reject_override_audit");
  const separateResult = (await applyPlan(separatePlan)).rows[0].value;
  assert.equal(separateResult.contractors_created, 1);
  await reload();
  const separateMapping = (await db.query("SELECT * FROM procore_vendor_mappings WHERE vendor_key=$1", [key])).rows[0];
  assert.notEqual(separateMapping.contractor_id, suggested.id);
  assert.equal((await db.query("SELECT count(*)::int n FROM contractors")).rows[0].n, beforeCount + 1);
  assert.equal((await db.query("SELECT count(*)::int n FROM contractor_contacts WHERE contractor_id=$1", [separateMapping.contractor_id])).rows[0].n, 1);
  assert.equal((await preview()).ready.length, 0);
  const evidence = (await db.query("SELECT user_id,details FROM administration_audit_log WHERE action='PROCORE_SEPARATE_CONTRACTOR_CREATED'")).rows;
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].user_id, actor);
  assert.equal(evidence[0].details.vendor_key, key);
  assert.equal(evidence[0].details.raw_vendor_name, "C&V Paving Contractors");
  assert.equal(evidence[0].details.suggested_contractor_id, suggested.id);
  assert.equal(evidence[0].details.suggested_contractor_name, suggested.company_name);
  assert.equal(evidence[0].details.contractor_id, separateMapping.contractor_id);
  assert.equal(evidence[0].details.import_run_id, run.id);
  assert.equal(evidence[0].details.import_history_id, run.import_history_id);
  assert(evidence[0].details.timestamp);
  assert.deepEqual(evidence[0].details.approval, approvalBeforeImport);
  assert.deepEqual((await db.query("SELECT to_jsonb(c) value FROM contractors c WHERE id=$1", [suggested.id])).rows[0].value,
    originalContractor, "Suggested existing contractor never overwritten");
  await failure(() => applyPlan(separatePlan), /existing vendor mapping/);
  assert.equal((await db.query("SELECT count(*)::int n FROM contractors")).rows[0].n, beforeCount + 1);
  const currentRun = run;
  const matchedChoice = { vendors: { [key]: { action: "MATCH", contractorId: suggested.id } } };
  const matchRun = (await db.query("INSERT INTO procore_import_runs(file_name,created_by,source_rows,decisions) VALUES('matched-after-override.xlsx',$1,$2,$3) RETURNING *",
    [actor, JSON.stringify(overrideRows), JSON.stringify(matchedChoice)])).rows[0];
  await db.query("INSERT INTO contractor_projects(contractor_id,project_id,ownership_sources) VALUES($1,46,ARRAY['MANUAL','MYCOI'])", [suggested.id]);
  run = matchRun;
  const existingMatchPlan = (await preview()).ready;
  assert.equal(existingMatchPlan[0].createContractor, false);
  await applyPlan(existingMatchPlan);
  await reload();
  assert.deepEqual((await db.query("SELECT ownership_sources FROM contractor_projects WHERE contractor_id=$1 AND project_id=46", [suggested.id])).rows[0].ownership_sources,
    ["MANUAL", "MYCOI", "PROCORE"], "New RPC preserves existing MANUAL/MYCOI ownership on ordinary MATCH import");
  assert.equal((await preview()).ready.length, 0);
  assert.equal((await db.query("SELECT count(*)::int n FROM contractors")).rows[0].n, beforeCount + 1);
  await db.query("INSERT INTO role_permissions(role,module,can_view,can_manage,can_add,can_edit) VALUES('Restricted','imports',true,true,true,true),('Restricted','projects',true,true,true,true),('Restricted','contractors',true,true,false,true)");
  const restricted = "00000000-0000-0000-0000-000000000002";
  await db.query("INSERT INTO user_profiles VALUES($1,'Restricted','Active','Restricted','restricted@example.invalid',false)", [restricted]);
  const permissionRun = (await db.query("INSERT INTO procore_import_runs(file_name,created_by,source_rows) VALUES('permission.xlsx',$1,$2) RETURNING *",
    [actor, JSON.stringify(overrideRows.map(r => ({ ...r, "Company (Vendor) > Name": "Different Existing" })))])).rows[0];
  await failure(() => db.query("SELECT procore_save_review($1,$2,$3,$4)", [permissionRun.id, permissionRun.revision,
    JSON.stringify({ vendors: { "different existing": { action: "ADD", duplicateOverride: {
      contractorId: alternate.id, companyName: alternate.company_name,
    } } } }), restricted]), /permission denied/);
  run = currentRun;
  await db.exec("SET ROLE authenticated");
  await assert.rejects(db.query("SELECT procore_duplicate_override_valid($1,$2,$3)", [run.id, key, "{}"]), /permission denied/);
  await db.exec("RESET ROLE");
  console.log("PASS: contractor suggestion/MATCH paths; reviewed duplicate override uses saved actor/time and original warning context; ordinary/stale/tampered/ambiguous/mapped ADD rejected; atomic audited separate creation and contact dedupe; unchanged original company; audit rollback; replay prevention; no review backfill.");
  console.log("PASS: additive migration rollback/ACLs; exact-only fallback; A&A mapping/readiness; repeated and future rows; intentional rematch/unmatch; stale revision/token, actor and forged target rejection; one atomic contractor/vendor/assignment creation; source/number preservation; mapped lineage; no ownership before Import; replay blocked.");
} finally { await db.close(); }
