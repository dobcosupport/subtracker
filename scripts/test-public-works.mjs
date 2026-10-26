import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
import ts from "typescript";
const require = createRequire(import.meta.url);
const { PGlite } = require("@electric-sql/pglite");
const read = file => fs.readFileSync(file, "utf8");
function load(file, dependencies) {
  const result = { exports: {} };
  vm.runInNewContext(ts.transpileModule(read(file), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { module: result, exports: result.exports, Date,
    require: id => { assert(id in dependencies, `Unexpected dependency ${id}`); return dependencies[id]; } });
  return result.exports;
}
const calls = [];
let tables = {};
let failure = null;
const supabase = { from(table) {
  let start = 0, end = Infinity;
  const filters = [];
  const query = {
    select(columns) { calls.push({ table, columns }); return query; },
    eq(key, value) { filters.push(row => row[key] === value); return query; },
    in(key, values) { filters.push(row => values.includes(row[key])); return query; },
    order() { return query; }, range(a, b) { start = a; end = b; return query; }, returns() { return query; },
    insert(data) { calls.push({ insert: data }); return query; },
    update(data) { calls.push({ update: data }); return query; },
    then(resolve, reject) { return Promise.resolve({
      data: failure === table ? null : (tables[table] ?? []).filter(row => filters.every(filter => filter(row))).slice(start, end + 1),
      error: failure === table ? { message: "Fixture read denied" } : null,
    }).then(resolve, reject); },
  };
  return query;
} };
const dependencies = { "@/lib/supabase": { supabase } };
const compliance = load("services/compliance.ts", dependencies);
const service = load("services/pwc-missing.ts", { ...dependencies, "@/services/compliance": compliance });
const projects = load("services/projects.ts", dependencies);
for (const public_works of [undefined, null, "", "false", 0]) {
  const before = calls.length;
  assert.match((await projects.createProject({ public_works })).error.message, /Select whether/);
  assert.match((await projects.updateProject(1, { project_name: "Edited", public_works })).error.message, /Select whether/);
  assert.equal(calls.length, before, "Invalid classification never reaches database");
}
for (const public_works of [true, false]) {
  assert.equal((await projects.createProject({ public_works })).error, null);
  assert.equal((await projects.updateProject(1, { project_name: "Edited", public_works })).error, null);
}
assert.equal((await projects.updateProject(1, { status: "Inactive" })).error, null);
const importerSource = read("services/imports.ts");
const importerSyntax = ts.createSourceFile("imports.ts", importerSource, ts.ScriptTarget.Latest, true);
const projectImporter = importerSyntax.statements.find(node => ts.isFunctionDeclaration(node) && node.name.text === "importProjects");
const importerModule = { exports: {} };
const importCalls = [];
let existingProject = null;
const importSupabase = {
  from(table) {
    assert.equal(table, "projects");
    const query = { select() { return query; }, eq() { return query; },
      async maybeSingle() { return { data: existingProject, error: null }; } };
    return query;
  },
  async rpc(name, input) {
    importCalls.push({ name, input });
    assert.equal(name, "import_project_without_classification");
    assert(!("public_works" in input), "Generic import never invents classification");
    return { error: null };
  },
};
vm.runInNewContext(ts.transpileModule(`export ${projectImporter.getText(importerSyntax)}`, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { module: importerModule, exports: importerModule.exports, supabase: importSupabase });
const importRows = [{ action: "Create", rowNumber: 2, identifier: "IMPORT", data: {
  project_number: "IMPORT", project_name: "Import", status: "Active",
} }];
assert.equal((await importerModule.exports.importProjects(importRows)).created, 1);
existingProject = { id: 45 };
assert.equal((await importerModule.exports.importProjects(importRows)).updated, 1);
assert.equal(importCalls[1].input.p_existing, 45);
const project = (id, public_works = true, status = "Active") =>
  ({ id, project_number: `PW-${id}`, project_name: `Public Works ${id}`, public_works, status });
const assignment = (id, contractor_id, changes = {}) => ({
  id, contractor_id, project_id: 1, active: true,
  contractors: { company_name: `Company ${contractor_id}`, active: true, material_vendor_only: false },
  projects: project(1), ...changes,
});
const credential = (contractor_id, changes = {}) => ({
  id: contractor_id, contractor_id, compliance_type_id: 6, active: true, is_current: true,
  registration_number: "PWC-123", expiration_date: "2099-01-01", registry_status: "OK",
  compliance_types: { compliance_name: "NJ PWC", requires_expiration: true }, ...changes,
});
tables = {
  contractor_projects: [
    assignment(1, 1), assignment(2, 2), assignment(3, 3),
    assignment(4, 4, { contractors: { company_name: "Material Only", active: true, material_vendor_only: true } }),
    assignment(5, 5, { projects: project(1, false) }), assignment(6, 6, { projects: project(1, null) }),
    assignment(7, 1, { project_id: 2, projects: project(2) }),
    assignment(8, 1, { project_id: 3, projects: project(3, false) }),
    assignment(9, 7, { active: false }), assignment(10, 8, { projects: project(1, true, "Inactive") }),
    assignment(11, 9), assignment(12, 10), assignment(13, 11), assignment(14, 12), assignment(15, 13),
    assignment(16, 14, { contractors: { company_name: "Inactive", active: false, material_vendor_only: false } }),
  ],
  compliance_records: [
    credential(2, { expiration_date: "2000-01-01" }), credential(3),
    credential(9, { registration_number: "" }), credential(10, { registry_status: "Expired - Not Found in Registry" }),
    credential(11, { expiration_date: null }), credential(12, { active: false, is_current: false }),
    credential(13, { expiration_date: "2000-01-01", active: false }),
  ],
};
const original = JSON.stringify(tables);
let result = await service.getPwcMissing();
assert.equal(result.error, null);
assert.deepEqual(Array.from(result.data, row => row.contractor_id), [1, 10, 11, 12, 13, 2, 9]);
assert.equal(result.data.find(row => row.contractor_id === 1).status, "Missing");
assert.deepEqual(Array.from(result.data.find(row => row.contractor_id === 1).projects, row => row.id), [1, 2]);
for (const id of [2, 10, 13]) assert.equal(result.data.find(row => row.contractor_id === id).status, "Expired");
for (const id of [9, 11, 12]) assert.equal(result.data.find(row => row.contractor_id === id).status, "Invalid");
assert.equal(JSON.stringify(tables), original, "Reporting never mutates source/history/assignments");
for (const status of ["Active", "90 Day", "60 Day", "30 Day"]) {
  assert.equal(service.buildPwcMissing([assignment(1, 1)], [{
    contractor_id: 1, compliance_name: "NJ PWC", active: true, is_current: true, calculated_status: status,
  }]).length, 0);
}
tables.contractor_projects[6].projects.public_works = false;
result = await service.getPwcMissing();
assert.equal(result.data.find(row => row.contractor_id === 1).projects.length, 1);
assert.equal(JSON.stringify(tables.compliance_records), JSON.stringify(JSON.parse(original).compliance_records));
tables.contractor_projects = Array.from({ length: 1001 }, (_, i) => assignment(i, 1, { project_id: i, projects: project(i) }));
assert.equal((await service.getPwcMissing()).data[0].projects.length, 1001, "All assignment pages retained");
for (const table of ["contractor_projects", "compliance_records"]) {
  failure = table;
  result = await service.getPwcMissing();
  assert.equal(result.data, null);
  assert.match(result.error.message, /Fixture read denied/);
}
console.log("PASS: explicit service validation; status-only compatibility; shared NJ PWC calculation; missing/expired/registry-expired/invalid/archived; Material Only and unclassified exclusions; grouped projects, all 1001 assignments, error propagation, no history mutation.");

const db = await PGlite.create();
try {
  await db.exec(`
    CREATE ROLE authenticated; CREATE ROLE anon;
    CREATE TABLE projects(id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,project_number text UNIQUE,project_name text,
      status text,inactivated_by text,updated_at timestamptz DEFAULT now());
    INSERT INTO projects(project_number,project_name,status) VALUES('LEGACY','Legacy project','Active');
    CREATE TABLE permissions(module text,action text);
    INSERT INTO permissions VALUES('imports','view'),('projects','add'),('projects','edit');
    CREATE FUNCTION user_has_module_permission(text,text) RETURNS boolean LANGUAGE sql SECURITY DEFINER AS
      $$SELECT EXISTS(SELECT 1 FROM permissions WHERE module=$1 AND action=$2)$$;
    CREATE TABLE contractor_projects(id integer,ownership_sources text[]);
    INSERT INTO contractor_projects VALUES(1,ARRAY['MANUAL','MYCOI','PROCORE']);
    CREATE TABLE compliance_records(id integer,expiration_date date);
    INSERT INTO compliance_records VALUES(1,'2000-01-01');
    GRANT SELECT,INSERT,UPDATE ON projects TO authenticated;
    GRANT USAGE ON SEQUENCE projects_id_seq TO authenticated;
  `);
  const legacyBefore = (await db.query("SELECT to_jsonb(projects) AS row FROM projects WHERE id=1")).rows[0].row;
  const migration = read("supabase/20261114_project_public_works.sql");
  await db.exec(migration.replace(/COMMIT;\s*$/, "ROLLBACK;"));
  assert.equal((await db.query("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name='projects' AND column_name='public_works'")).rows[0].n, 0);
  await db.exec(migration);
  assert.deepEqual((await db.query("SELECT to_jsonb(projects)-'public_works' AS row FROM projects WHERE id=1")).rows[0].row, legacyBefore);
  assert.equal((await db.query("SELECT public_works FROM projects WHERE id=1")).rows[0].public_works, null);
  assert.equal((await db.query("SELECT column_default FROM information_schema.columns WHERE table_name='projects' AND column_name='public_works'")).rows[0].column_default, null);
  await assert.rejects(db.exec("INSERT INTO projects(project_number) VALUES('BAD')"), /Select whether/);
  await assert.rejects(db.exec("UPDATE projects SET project_name=project_name WHERE id=1"), /Select whether/);
  await db.exec("UPDATE projects SET status='Inactive',inactivated_by='Fixture' WHERE id=1; UPDATE projects SET status='Active' WHERE id=1");
  assert.equal((await db.query("SELECT public_works FROM projects WHERE id=1")).rows[0].public_works, null);
  await db.exec("UPDATE projects SET public_works=true,project_name='Reviewed' WHERE id=1");
  await db.exec("INSERT INTO projects(project_number,public_works) VALUES('YES',true),('NO',false)");
  await assert.rejects(db.exec("UPDATE projects SET public_works=null WHERE id=1"), /Select whether/);
  await db.exec("SET ROLE authenticated");
  await assert.rejects(db.exec("INSERT INTO projects(project_number) VALUES('BYPASS')"), /Select whether/);
  await db.exec("SELECT set_config('subtracker.project_import','on',true)");
  await assert.rejects(db.exec("UPDATE projects SET public_works=null WHERE id=1"), /Select whether/);
  await db.exec("SELECT import_project_without_classification('IMPORTED','Imported project','Active')");
  assert.equal((await db.query("SELECT public_works FROM projects WHERE project_number='IMPORTED'")).rows[0].public_works, null);
  await assert.rejects(db.exec("INSERT INTO projects(project_number) VALUES('AFTER-IMPORT-BYPASS')"), /Select whether/);
  await db.exec("SELECT import_project_without_classification('IMPORTED','Still unclassified','Inactive',(SELECT id FROM projects WHERE project_number='IMPORTED'))");
  assert.equal((await db.query("SELECT public_works FROM projects WHERE project_number='IMPORTED'")).rows[0].public_works, null);
  await db.exec("SELECT import_project_without_classification('LEGACY','Imported edit','Active',1)");
  assert.equal((await db.query("SELECT public_works FROM projects WHERE id=1")).rows[0].public_works, true);
  await db.exec("UPDATE projects SET public_works=false WHERE id=1");
  await db.exec("SELECT import_project_without_classification('LEGACY','Preserved No','Active',1)");
  assert.equal((await db.query("SELECT public_works FROM projects WHERE id=1")).rows[0].public_works, false);
  await db.exec("RESET ROLE; DELETE FROM permissions WHERE module='projects'; SET ROLE authenticated");
  await assert.rejects(db.exec("SELECT import_project_without_classification('DENIED','Denied','Active')"), /permission required/);
  await db.exec("RESET ROLE; INSERT INTO permissions VALUES('projects','add'); SET ROLE authenticated");
  await assert.rejects(db.exec("SELECT import_project_without_classification('LEGACY','Edit denied','Active',1)"), /permission required/);
  await db.exec("RESET ROLE; SET ROLE anon");
  await assert.rejects(db.exec("SELECT import_project_without_classification('DENIED','Denied','Active')"), /permission denied/);
  await db.exec("RESET ROLE");
  assert.deepEqual((await db.query("SELECT * FROM contractor_projects")).rows, [{ id: 1, ownership_sources: ["MANUAL", "MYCOI", "PROCORE"] }]);
  assert.equal((await db.query("SELECT count(*)::int n FROM compliance_records WHERE expiration_date='2000-01-01'")).rows[0].n, 1);
  console.log("PASS: isolated migration/rollback; legacy NULL/no default; database rejects unclassified manual insert/full edit and null reset; Deactivate/Reactivate allowed; trusted import creates NULL/preserves Yes/No; import permissions/ACL and bypass rejection; no ownership/history changes.");
} finally { await db.close(); }
