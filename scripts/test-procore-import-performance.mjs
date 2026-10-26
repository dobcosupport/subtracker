import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import ts from "typescript";

const require = createRequire(import.meta.url);
const { PGlite } = require("@electric-sql/pglite");
const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const cache = new Map();
function load(file) {
  if (cache.has(file)) return cache.get(file);
  const mod = { exports: {} };
  vm.runInNewContext(ts.transpileModule(read(file), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText, { module: mod, exports: mod.exports,
    require: id => load(id.replace("@/lib/", "src/lib/").replace("@/types/", "types/") + ".ts") });
  cache.set(file, mod.exports); return mod.exports;
}
const { buildProcorePreview } = load("src/lib/procore-preview.ts");
const { PROCORE_HEADINGS } = load("types/procore-import.ts");
const actor = "00000000-0000-0000-0000-000000000001";
const db = await PGlite.create();
const query = async (sql, args = []) => (await db.query(sql, args)).rows;
try {
  // Synthetic fixture: production's 5,996 rows, 761 already imported,
  // 3,314 ready rows / 317 companies / 57 creates / 1,008 assignments.
  await db.exec(`
    CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth; CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$SELECT '${actor}'::uuid$$;
    CREATE TABLE user_profiles(auth_user_id uuid PRIMARY KEY,role text,status text,name text,email text,system_administrator boolean);
    INSERT INTO user_profiles VALUES('${actor}','Admin','Active','Fixture','fixture@example.invalid',true);
    CREATE TABLE role_permissions(role text,module text,can_view boolean,can_manage boolean,can_add boolean,can_edit boolean);
    CREATE TABLE contractors(id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,company_name text,phone text,address_1 text,
      city text,state text,zip_code text,active boolean,creation_source text,creation_import_history_id integer);
    CREATE TABLE projects(id integer PRIMARY KEY,project_number text,project_name text);
    INSERT INTO projects SELECT n,CASE WHEN n=45 THEN '25900' ELSE 'P'||n END,'Project '||n FROM generate_series(1,76) n;
    CREATE TABLE contractor_contacts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),contractor_id integer REFERENCES contractors,
      contact_name text,email text,mobile_phone text,is_active boolean DEFAULT true);
    CREATE INDEX fixture_contact_contractor ON contractor_contacts(contractor_id);
    CREATE FUNCTION save_contractor_contact(integer,uuid,jsonb) RETURNS contractor_contacts LANGUAGE sql AS
      $$SELECT * FROM contractor_contacts LIMIT 1$$;
    CREATE TABLE contractor_projects(id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,contractor_id integer REFERENCES contractors,
      project_id integer REFERENCES projects,active boolean DEFAULT true,ownership_sources text[] DEFAULT '{}',
      assigned_date date DEFAULT current_date,removed_date date,UNIQUE(contractor_id,project_id));
    CREATE TABLE relationship_sources(source text PRIMARY KEY);
    INSERT INTO relationship_sources VALUES('MANUAL'),('MYCOI'),('PROCORE');
    CREATE TABLE activity_log(contractor_id integer,project_id integer,activity_type text,notes text,created_by text);
    CREATE TABLE import_history(id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,file_name text,imported_rows integer,
      successful_rows integer,failed_rows integer,notes text);
    CREATE TABLE administration_audit_log(audit_date timestamptz DEFAULT now(),user_id uuid,user_name text,user_email text,
      action text,object_type text,object_id text,object_label text,details jsonb);
  `);
  const ownership = read("supabase/20261104_mycoi_insurance_project_ownership.sql");
  const start = ownership.indexOf("CREATE FUNCTION public.contractor_import_name_key(");
  await db.exec(ownership.slice(start, ownership.indexOf("$$;", start) + 3));
  const auditStart = ownership.indexOf("CREATE FUNCTION public.audit_project_ownership()");
  await db.exec(ownership.slice(auditStart, ownership.indexOf("\nINSERT INTO administration_audit_log", auditStart)));
  const helperStart = ownership.indexOf("CREATE FUNCTION public.set_project_assignment_source(");
  await db.exec(ownership.slice(helperStart, ownership.indexOf("$$;", helperStart) + 3));
  for (const file of ["20261110_procore_import_workflow.sql", "20261112_procore_project_mappings.sql",
    "20261113_procore_contractor_match_override.sql"]) await db.exec(read("supabase/" + file));
  const source = [], decisions = { vendors: {} }, imported = [];
  const row = (name, project, contact = "") => {
    const number = source.length + 2;
    source.push({ row: number, ...Object.fromEntries(PROCORE_HEADINGS.map(h => [h, ""])),
      "Company (Vendor) > Name": name, "Project > Number": project,
      "Company (Vendor) > Address": "123 Synthetic Main Street", "Company (Vendor) > City": "Fixture",
      "Company (Vendor) > State": "NJ", "Company (Vendor) > Zip": "07001",
      "User > Full Name": contact, "User > Email Address": contact ? contact.replaceAll(" ", "").toLowerCase() + "@example.invalid" : "" });
    return number;
  };
  const existing = async name => (await query("INSERT INTO contractors(company_name,active) VALUES($1,true) RETURNING id", [name]))[0].id;
  const priorContractors = [];
  for (let n = 0; n < 149; n++) {
    const name = "Prior Vendor " + n, id = await existing(name);
    priorContractors.push(id);
    if (n < 107) decisions.vendors[name.toLowerCase()] = { action: "MATCH", contractorId: id };
  }
  for (let n = 0; n < 761; n++) imported.push(row("Prior Vendor " + n % 149, "P1"));
  const pendingIds = [];
  for (let n = 0; n < 317; n++) {
    const name = "Ready Vendor " + n;
    const id = n < 57 ? null : await existing(name);
    pendingIds.push(id);
    decisions.vendors[name.toLowerCase()] = id ? { action: "MATCH", contractorId: id } : { action: "ADD" };
    const count = n < 144 ? 11 : 10;
    const assignments = n < 57 ? 4 : 3;
    for (let r = 0; r < count; r++) row(name, r % assignments === 0 ? "25-900" : "P" + (r % assignments + 1),
      "Contact " + n + " Person " + (n < 263 ? r % 2 : 0));
  }
  while (source.length < 5996) {
    const n = (source.length - 4075) % 484;
    const name = "Unresolved Vendor " + n;
    row(name, "UNKNOWN");
    if (n < 84) decisions.vendors[name.toLowerCase()] = { action: "ADD" };
    if (n === 84) decisions.vendors[name.toLowerCase()] = { action: "UNMATCHED" };
  }
  assert.deepEqual(Object.values(decisions.vendors).reduce((counts,decision) => {
    counts[decision.action] = (counts[decision.action] ?? 0) + 1; return counts;
  },{}),{MATCH:367,ADD:141,UNMATCHED:1});
  assert.equal(new Set(source.map(r=>r["Company (Vendor) > Name"])).size,950);
  let run = (await query("INSERT INTO procore_import_runs(file_name,created_by,source_rows,decisions,imported_rows,revision,status) VALUES('scale.xlsx',$1,$2,$3,$4,533,'Partial') RETURNING *",
    [actor, JSON.stringify(source), JSON.stringify(decisions), JSON.stringify(imported)]))[0];
  await query("INSERT INTO procore_project_mappings(source_number,project_id,import_run_id,accepted_by) VALUES('25-900',45,$1,$2)", [run.id, actor]);
  const history = (await query("INSERT INTO import_history(file_name,imported_rows,successful_rows,failed_rows) VALUES('scale.xlsx',5996,761,5235) RETURNING id"))[0].id;
  await query("UPDATE procore_import_runs SET import_history_id=$1 WHERE id=$2", [history, run.id]);
  for (let n = 0; n < priorContractors.length; n++) {
    await query(`INSERT INTO procore_vendor_mappings(vendor_key,raw_vendor_name,contractor_id,import_run_id,import_history_id,accepted_by)
      VALUES($1,$2,$3,$4,$5,$6)`, ["prior vendor " + n, "Prior Vendor " + n, priorContractors[n], run.id, history, actor]);
  }
  for (const number of imported) {
    const contractor = priorContractors[(number - 2) % 149];
    await query(`INSERT INTO procore_import_lineage(import_run_id,import_history_id,source_row,contractor_id,project_id,actor_id,evidence)
      VALUES($1,$2,$3,$4,1,$5,'{}')`, [run.id, history, number, contractor, actor]);
  }
  const existingPending = pendingIds.filter(Boolean);
  for (let n = 0; n < existingPending.length; n++) {
    for (const project of n < 142 ? [45, 2, 3] : [45, 2]) {
      await query("INSERT INTO contractor_projects(contractor_id,project_id,ownership_sources) VALUES($1,$2,ARRAY['MANUAL','MYCOI'])", [existingPending[n], project]);
    }
  }
  for (let n = 0; n < 171; n++) await existing("Unrelated Vendor " + n);
  for (let n = 0; n < 860; n++) {
    const id = priorContractors[Math.floor(n / 6)];
    await query("INSERT INTO contractor_projects(contractor_id,project_id,ownership_sources) VALUES($1,$2,ARRAY['MANUAL'])", [id, n % 6 + 1]);
  }
  for (let n = 0; n < 39; n++) {
    const name = `Contact ${n + 57} Person 0`;
    await query("INSERT INTO contractor_contacts(contractor_id,contact_name,email,is_active) VALUES($1,$2,$3,$4)",
      [pendingIds[n + 57], name, n < 31 ? name.replaceAll(" ", "").toLowerCase() + "@example.invalid" : null, n >= 31]);
  }
  for (let n = 0; n < 295; n++) {
    await query("INSERT INTO contractor_contacts(contractor_id,contact_name,email) VALUES($1,$2,$3)",
      [priorContractors[n % 149], "Prior Person " + n, `prior${n}@example.invalid`]);
  }
  const reference = async () => (await query("SELECT procore_import_reference() AS value"))[0].value;
  const ref = await reference();
  const preview = buildProcorePreview(source, decisions, ref, imported);
  assert.equal(preview.ready.length, 317);
  assert.equal(preview.ready.reduce((n,v) => n + v.rows.length, 0), 3314);
  assert.equal(preview.ready.reduce((n,v) => n + v.assignments.length, 0), 1008);
  assert.equal(preview.ready.reduce((n,v) => n + v.contacts.length, 0), 580);
  const explain = async bucket => (await query(`EXPLAIN (ANALYZE, FORMAT JSON)
    SELECT value FROM jsonb_array_elements($1::jsonb)
    WHERE (value->>'row')::integer=763 AND btrim(value->>'Project > Number')='25-900'
      AND contractor_import_name_key(value->>'Company (Vendor) > Name')='ready vendor 0'`,
    [JSON.stringify(bucket)]))[0]["QUERY PLAN"][0];
  const fullScan = await explain(source), indexedScan = await explain([source[761]]);
  assert.equal(fullScan.Plan["Rows Removed by Filter"],5995);
  assert.equal(indexedScan.Plan["Rows Removed by Filter"],0);
  console.log(`EXPLAIN ANALYZE (isolated): old lookup examines 5,996 rows; indexed bucket examines 1; ${5996*3314} -> 3,314 source rows examined across the ready plan`);
  const invoke = async plan => query("SELECT procore_apply_import($1,$2,$3,$4,$5) AS value",
    [run.id, run.revision, (await reference()).token, JSON.stringify(plan), actor]);
  const timed = async (name, operation) => {
    const start = performance.now(); const result = await operation();
    console.log(`${name}: ${(performance.now()-start).toFixed(1)}ms`); return result;
  };
  // Profile the real legacy function in an isolated transaction, then roll it
  // back. No production connections or source data are used by this test.
  await db.exec("BEGIN");
  const legacy = await timed("legacy full atomic import", () => invoke(preview.ready));
  assert.equal(legacy[0].value.contractors_created, 57);
  assert.equal(legacy[0].value.contacts_created, 541);
  await db.exec("ROLLBACK");
  if (process.env.PROCORE_PROFILE_LEGACY_ONLY === "1") {
    console.log("PASS: reproduced production-scale legacy atomic path; all fixture writes rolled back");
  } else {
    const grants = await query("SELECT proacl FROM pg_proc WHERE oid='procore_apply_import(uuid,integer,text,jsonb,uuid)'::regprocedure");
    const migration = read("supabase/20261117_procore_import_source_lookup.sql");
    const definition = async () => query("SELECT pg_get_functiondef('procore_apply_import(uuid,integer,text,jsonb,uuid)'::regprocedure) AS definition");
    const oldDefinition = await definition();
    await assert.rejects(db.exec(migration.replace(/COMMIT;\s*$/, "SELECT 1/0; COMMIT;")),/division by zero/);
    await db.exec("ROLLBACK");
    assert.deepEqual(await definition(),oldDefinition);
    await db.exec(migration);
    assert.deepEqual(await query("SELECT proacl FROM pg_proc WHERE oid='procore_apply_import(uuid,integer,text,jsonb,uuid)'::regprocedure"), grants);
    const tables = ["contractors","contractor_contacts","contractor_projects","procore_vendor_mappings",
      "procore_import_lineage","procore_import_runs","import_history","administration_audit_log","activity_log","procore_project_mappings"];
    const snapshot = async () => Object.fromEntries(await Promise.all(tables.map(async table =>
      [table, await query(`SELECT to_jsonb(t) AS r FROM ${table} t ORDER BY to_jsonb(t)::text`)])));
    const before = await snapshot();
    const rejectUnchanged = async (operation, pattern) => {
      await assert.rejects(operation(), pattern);
      assert.deepEqual(await snapshot(), before);
    };
    await rejectUnchanged(() => invoke([{...preview.ready[0], key:"wrong vendor"}]), /Invalid vendor identity/);
    const corruptPlan = structuredClone(preview.ready.slice(0, 1));
    corruptPlan[0].assignments[0].rows = [999999];
    await rejectUnchanged(() => invoke(corruptPlan), /query returned no rows/);
    corruptPlan[0].assignments[0].rows = [imported[0]];
    await rejectUnchanged(() => invoke(corruptPlan), /query returned no rows/);
    corruptPlan[0].assignments[0].projectId = 1;
    await rejectUnchanged(() => invoke(corruptPlan), /Project number must match exactly/);
    await db.exec("BEGIN");
    await query("UPDATE procore_import_runs SET source_rows=source_rows || jsonb_build_array(source_rows->761) WHERE id=$1",[run.id]);
    await assert.rejects(invoke(preview.ready), /query returned more than one row/);
    await db.exec("ROLLBACK");
    assert.deepEqual(await snapshot(), before, "duplicate row numbers cannot be silently overwritten by the index");
    // Fail at the final audit, after all entity/ownership/lineage writes.
    await db.exec(`CREATE FUNCTION fixture_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.action='PROCORE_IMPORT_APPLIED' THEN
        RAISE EXCEPTION 'canceling statement due to statement timeout' USING ERRCODE='57014';
      END IF; RETURN NEW; END $$;
      CREATE TRIGGER fixture_fail_audit BEFORE INSERT ON administration_audit_log FOR EACH ROW EXECUTE FUNCTION fixture_fail_audit();`);
    await assert.rejects(invoke(preview.ready), error => error.code === "57014" && /statement timeout/.test(error.message));
    assert.deepEqual(await snapshot(), before, "late failure must roll back every attempted write and retain review");
    await db.exec("DROP TRIGGER fixture_fail_audit ON administration_audit_log");
    const result = (await timed("optimized full atomic import", () => invoke(preview.ready)))[0].value;
    assert.deepEqual(result, legacy[0].value, "same atomic output counts");
    const updated = (await query("SELECT * FROM procore_import_runs WHERE id=$1",[run.id]))[0];
    assert.equal(updated.imported_rows.length, 4075);
    assert.deepEqual(updated.decisions, decisions);
    assert.equal(updated.revision, 534);
    assert.equal((await query("SELECT count(*)::int n FROM procore_import_lineage"))[0].n, 4075);
    assert.equal((await query("SELECT count(*)::int n FROM procore_vendor_mappings"))[0].n, 466);
    assert.equal((await query("SELECT count(*)::int n FROM contractors"))[0].n, 637);
    assert.equal((await query("SELECT count(*)::int n FROM contractors WHERE creation_source='PROCORE' AND creation_import_history_id=$1",[history]))[0].n,57);
    assert.equal((await query("SELECT count(*)::int n FROM contractor_contacts"))[0].n, 875);
    assert.equal((await query("SELECT count(*)::int n FROM contractor_contacts WHERE email IS NULL"))[0].n,8);
    assert.equal((await query("SELECT count(*)::int n FROM contractor_contacts WHERE NOT is_active"))[0].n,31);
    assert.equal((await query("SELECT count(*)::int n FROM contractor_projects"))[0].n, 1868);
    assert.equal((await query("SELECT count(*)::int n FROM contractor_projects WHERE 'PROCORE'=ANY(ownership_sources)"))[0].n,1008);
    assert.equal((await query("SELECT count(*)::int n FROM contractor_projects WHERE 'MANUAL'=ANY(ownership_sources) AND 'MYCOI'=ANY(ownership_sources)"))[0].n,662);
    assert.equal((await query("SELECT count(*)::int n FROM procore_import_lineage WHERE evidence->'source_row'->>'Project > Number'='25-900' AND project_id=45"))[0].n,
      preview.ready.reduce((n,v) => n + v.assignments.find(a => a.number === "25-900").rows.length,0));
    assert.equal((await query("SELECT count(*)::int n FROM administration_audit_log WHERE action='PROJECT_SOURCE_ADDED' AND details->>'source'='PROCORE'"))[0].n,1008);
    assert.equal((await query("SELECT successful_rows FROM import_history WHERE id=$1",[history]))[0].successful_rows,4075);
    assert.deepEqual((await query("SELECT source_row FROM procore_import_lineage WHERE evidence='{}' ORDER BY source_row")).map(r=>r.source_row),imported,
      "all old lineage remains untouched");
    assert.equal((await query("SELECT count(*)::int n FROM contractors WHERE creation_source='PROCORE' AND address_1='123 Synthetic Main Street' AND city='Fixture' AND state='NJ' AND zip_code='07001'"))[0].n,57);
    assert.equal((await query("SELECT count(*)::int n FROM contractor_projects WHERE cardinality(ownership_sources)<>(SELECT count(DISTINCT s) FROM unnest(ownership_sources) s)"))[0].n,0);
    assert.equal(buildProcorePreview(source, decisions, await reference(), updated.imported_rows).ready.length,0);
    run = updated;
    const after = await snapshot();
    await assert.rejects(invoke(preview.ready), /already imported|approval and no existing vendor mapping/);
    assert.deepEqual(await snapshot(), after, "replay must not create entities or duplicate ownership");
    const mappings = (await reference()).vendors;
    const repeat = preview.ready.map(v => ({...v,createContractor:false,
      contractorId:mappings.find(m=>m.vendor_key===v.key).contractor_id}));
    await assert.rejects(invoke(repeat), /Source row already imported/);
    assert.deepEqual(await snapshot(), after);
    assert.equal(updated.source_row_count-updated.imported_rows.length,1921);
    console.log("PASS: production-scale atomic rollback/retry, counts, deduplication, exact mappings, ownership, unresolved and idempotency");
  }
} finally { await db.close(); }
