import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import { createRequire } from "node:module";
import ts from "typescript";

const require = createRequire(import.meta.url);
const { PGlite } = require("@electric-sql/pglite");
const root = path.resolve(import.meta.dirname, "..");
const cache = new Map(), calls = [];
const project = { id: 1, project_number: "26-001", project_name: "Public School", status: "Active", public_works: true };
const privateProject = { ...project, id: 2, project_name: "Private School", public_works: false };
const contractor = { id: 1, company_name: "Example", active: true, material_vendor_only: false, state: "NJ",
  federal_tax_id: "present", nj_brc_number: null };
const record = (name = "NJ PWC", overrides = {}) => ({ contractor_id: 1, compliance_name: name,
  registration_number: "present", expiration_date: "2026-11-09", registry_status: null, ...overrides });
const eligibility = { contractor_id: 1, project_id: 1, applicable: true };
let tables, failure;
const supabase = { from: table => query(table), rpc: () => { throw new Error("Assessment must not use an RPC."); } };
function query(table) {
  const filters = [];
  let start = 0, end = Infinity, single = false, signal;
  const call = { table, filters: [] }; calls.push(call);
  const q = {
    select(columns) { call.columns = columns; return q; },
    eq(key, value) { call.filters.push([key, value]); filters.push(row => row[key] === value); return q; },
    is(key, value) { call.filters.push([key, value]); filters.push(row => (row[key] ?? null) === value); return q; },
    in(key, values) { call.filters.push([key, values]); filters.push(row => {
      if (key === "compliance_types.compliance_name") return values.includes(row.compliance_types.compliance_name);
      return values.includes(row[key]);
    }); return q; },
    order() { return q; }, range(a, b) { start = a; end = b; return q; },
    abortSignal(s) { signal = s; return q; }, returns() { return q; }, maybeSingle() { single = true; return q; },
    then(resolve, reject) {
      return Promise.resolve().then(() => {
        signal?.throwIfAborted();
        if (failure === table) return { data: null, error: { message: "Synthetic denied" } };
        const data = (tables[table] ?? []).filter(row => filters.every(filter => filter(row))).slice(start, end + 1);
        return { data: single ? data[0] ?? null : data, error: null };
      }).then(resolve, reject);
    },
  };
  return q;
}
function load(file) {
  file = path.resolve(root, file);
  if (cache.has(file)) return cache.get(file);
  const loadedModule = { exports: {} };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { module: loadedModule, exports: loadedModule.exports, Date, Set, Map, require: id => {
    if (id === "@/lib/supabase") return { supabase };
    if (id.startsWith(".")) return load(path.resolve(path.dirname(file), id + ".ts"));
    return require(id);
  } });
  cache.set(file, loadedModule.exports);
  return loadedModule.exports;
}
const { classifyExpiration } = load("services\\expiration-classification.ts");
const { assessProjectContractor, getSelectedProjectAssessment, getReportProjectContext, getComplianceReportAssessment,
  complianceCompanies, filterComplianceCompanies, complianceSummary } = load("services\\project-compliance-assessment.ts");
const { evaluateNjPwcAssignment, njPwcReasonSql } = load("services\\nj-pwc-eligibility-rule.ts");
const plain = value => JSON.parse(JSON.stringify(value));
const assessment = (c = contractor, p = project, e = eligibility, records = [record("NJ BRC"), record()]) =>
  plain(assessProjectContractor(c, p, e, records, "2026-11-09"));

test("inclusive date boundaries and invalid dates are explicit", () => {
  for (const [days, status] of [[-1, "Expired"], [0, "0-30 Days"], [30, "0-30 Days"], [31, "31-60 Days"],
    [60, "31-60 Days"], [61, "61-90 Days"], [90, "61-90 Days"], [91, "Current"], [365, "Current"]]) {
    const date = new Date(Date.parse("2026-11-09T00:00:00Z") + days * 86400000).toISOString().slice(0, 10);
    assert.deepEqual(plain(classifyExpiration(date, "2026-11-09")), { status, daysRemaining: days });
  }
  for (const invalid of ["2026-02-30", "2026-13-01", "", "11/09/2026"]) assert.throws(() => classifyExpiration(invalid), /date/);
  assert.throws(() => classifyExpiration("2026-11-09", "2026-02-30"), /date/);
});

test("legacy compliance/export expiration-day behavior is intentionally unchanged", () => {
  const legacy = load("services\\compliance.ts");
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(legacy.calculateComplianceStatus({ compliance_name: "NJ PWC", requires_expiration: true,
    registration_number: "present", expiration_date: today }).calculated_status, "Expired");
  assert.equal(classifyExpiration(today, today).status, "0-30 Days");
});

test("FEIN is contractor-level; NJ BRC reuses state authority and never expires", () => {
  const publicRows = assessment(), privateRows = assessment(contractor, privateProject, { ...eligibility, project_id: 2, applicable: false });
  assert.equal(publicRows.length, 3, "Insurance is deliberately not assessed.");
  assert.deepEqual({ ...publicRows[0], projectId: 2 }, privateRows[0]);
  assert.equal(assessment({ ...contractor, federal_tax_id: " " })[0].status, "Missing");
  for (const expiration_date of ["1990-01-01", "2026-11-09", "invalid", null]) {
    const brc = assessment(contractor, project, eligibility, [record("NJ BRC", { expiration_date })])[1];
    assert.equal(brc.status, "Current"); assert.equal(brc.expirationDate, null); assert.equal(brc.daysRemaining, null);
    assert.match(brc.detail, /On File/);
  }
  assert.equal(assessment({ ...contractor, state: "New Jersey" })[1].applicable, true);
  assert.equal(assessment({ ...contractor, state: "NY" })[1].status, "Not Required");
  assert.equal(assessment(contractor, project, eligibility, [record()])[1].status, "Missing");
  assert.equal(assessment({ ...contractor, state: null })[1].status, "Unavailable");
  assert.equal(assessment({ ...contractor, nj_brc_number: "legacy" }, project, eligibility, [record()])[1].status, "Unavailable");
  assert.equal(assessment(contractor, project, eligibility, [record("NJ BRC"), record("NJ BRC")])[1].status, "Unavailable");
});

test("PWC output honors scoped authority, missing data, source lock and context validation", () => {
  assert.equal(assessment()[2].status, "0-30 Days");
  assert.equal(assessment(contractor, privateProject, { ...eligibility, project_id: 2, applicable: false })[2].status, "Not Required");
  assert.equal(assessment({ ...contractor, material_vendor_only: true }, project, { ...eligibility, applicable: false })[2].applicable, false);
  assert.equal(assessment(contractor, project, eligibility, [record("NJ BRC")])[2].status, "Missing");
  assert.equal(assessment(contractor, project, eligibility, [record("NJ BRC"), record("NJ PWC", { registration_number: "" })])[2].status, "Missing");
  assert.equal(assessment(contractor, project, eligibility, [record("NJ BRC"), record("NJ PWC", { registry_status: "Expired - Not Found in Registry" })])[2].status, "Expired");
  assert.throws(() => assessment(contractor, project, { ...eligibility, project_id: 2 }), /context/);
  assert.throws(() => assessment(contractor, { ...project, public_works: null }), /classification is unknown/);
  assert.throws(() => assessment(contractor, project, eligibility, [record("NJ PWC", { contractor_id: 2 })]), /outside/);
  assert.equal(assessment(contractor, project, eligibility, [record("NJ BRC"), record(), record()])[2].status, "Unavailable");
});

test("local SQL shares global/selected predicate, preserves global behavior and enforces invoker RLS", async () => {
  const db = await PGlite.create();
  try {
    await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE contractors(id integer primary key, company_name text, active boolean, material_vendor_only boolean);
      CREATE TABLE projects(id integer primary key, status text, public_works boolean);
      CREATE TABLE contractor_projects(id integer primary key, contractor_id integer, project_id integer, active boolean);
      INSERT INTO contractors SELECT row_number() OVER (), n,a,m FROM
        (VALUES ('Example'),(''),('   '),(NULL)) names(n)
        CROSS JOIN (VALUES (true),(false),(NULL)) active(a)
        CROSS JOIN (VALUES (true),(false),(NULL)) materials(m);
      INSERT INTO projects SELECT row_number() OVER (),s,p FROM
        (VALUES ('Active'),('Closed'),(NULL)) status(s)
        CROSS JOIN (VALUES (true),(false),(NULL)) works(p);
      INSERT INTO contractor_projects SELECT row_number() OVER (),c.id,p.id,a FROM contractors c CROSS JOIN projects p
        CROSS JOIN (VALUES (true),(false),(NULL)) flags(a);`);
    const old = fs.readFileSync(path.join(root, "supabase\\20261119_nj_pwc_public_works_monitoring_eligibility.sql"), "utf8")
      .match(/CREATE OR REPLACE FUNCTION public\.nj_pwc_daily_contractor_eligible[\s\S]*?\$\$;/)[0];
    await db.exec(old);
    const before = (await db.query("SELECT id,nj_pwc_daily_contractor_eligible(id) eligible FROM contractors ORDER BY id")).rows;
    const migration = fs.readFileSync(path.join(root, "supabase\\20261216_project_compliance_assessment_foundation.sql"), "utf8");
    assert.ok(migration.replace(/\r\n/g, "\n").includes(njPwcReasonSql()), "SQL CASE must be generated from the same ordered rule definition.");
    await db.exec(migration);
    const reasonRows = await db.query(`SELECT c.active contractor_active,c.company_name,c.material_vendor_only material_only,
      cp.active assignment_active,p.status project_status,p.public_works,
      nj_pwc_assignment_reason(c.active,c.company_name,c.material_vendor_only,cp.active,p.status,p.public_works) reason,
      nj_pwc_assignment_qualifies(c.active,c.company_name,c.material_vendor_only,cp.active,p.status,p.public_works) applicable
      FROM contractors c JOIN contractor_projects cp ON cp.contractor_id=c.id JOIN projects p ON p.id=cp.project_id`);
    for (const row of reasonRows.rows) {
      const actual = evaluateNjPwcAssignment(row);
      assert.equal(actual.reason, row.reason);
      assert.equal(actual.applicable, row.applicable);
    }
    assert.equal(reasonRows.rows.length, 972, "Null/false/empty/multiple assignments share exact reasons and applicability.");
    assert.deepEqual((await db.query("SELECT id,nj_pwc_daily_contractor_eligible(id) eligible FROM contractors ORDER BY id")).rows, before);
    const parity = await db.query(`SELECT count(*)::int mismatches FROM contractors c CROSS JOIN projects p WHERE
      (SELECT applicable FROM project_nj_pwc_eligibility(p.id,ARRAY[c.id])) IS DISTINCT FROM
      EXISTS (SELECT 1 FROM contractor_projects cp WHERE cp.contractor_id=c.id AND cp.project_id=p.id
        AND c.active AND nullif(btrim(c.company_name),'') IS NOT NULL AND NOT c.material_vendor_only
        AND cp.active AND p.status='Active' AND p.public_works IS TRUE)`);
    assert.equal(parity.rows[0].mismatches, 0);
    await db.exec(`TRUNCATE contractors,projects,contractor_projects;
      INSERT INTO contractors VALUES (1,'Both',true,false),(2,'Materials',true,true),(3,'No assignment',true,false),(4,'Inactive',false,false);
      INSERT INTO projects VALUES (1,'Active',true),(2,'Active',false),(3,'Closed',true);
      INSERT INTO contractor_projects VALUES (1,1,1,true),(2,1,2,true),(3,2,1,true),(4,1,3,true),(5,3,1,false),(6,4,1,true);`);
    const scope = async (c, p) => (await db.query("SELECT applicable FROM project_nj_pwc_eligibility($1,ARRAY[$2]::integer[])", [p, c])).rows[0].applicable;
    assert.equal(await scope(1, 1), true);
    assert.equal(await scope(1, 2), false, "Another Public Works assignment cannot contaminate the private project.");
    assert.equal(await scope(1, 1), true, "Private assignment cannot remove eligibility on Public Works.");
    assert.equal(await scope(2, 1), false); assert.equal(await scope(3, 1), false); assert.equal(await scope(4, 1), false);
    assert.equal(await scope(1, 3), false);
    assert.equal((await db.query("SELECT nj_pwc_daily_contractor_eligible(1) ok")).rows[0].ok, true);
    await db.exec(`ALTER TABLE contractors ENABLE ROW LEVEL SECURITY; ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
      ALTER TABLE contractor_projects ENABLE ROW LEVEL SECURITY;
      CREATE POLICY c ON contractors TO authenticated USING(id=1);
      CREATE POLICY p ON projects TO authenticated USING(id=2);
      CREATE POLICY cp ON contractor_projects TO authenticated USING(project_id=2);
      GRANT SELECT ON contractors,projects,contractor_projects TO authenticated;
      SET ROLE authenticated;`);
    assert.equal((await db.query("SELECT * FROM project_nj_pwc_eligibility(1,ARRAY[1])")).rows.length, 0, "Hidden project not disclosed.");
    assert.equal((await db.query("SELECT * FROM project_nj_pwc_eligibility(2,ARRAY[2])")).rows.length, 0, "Hidden contractor not disclosed.");
    assert.deepEqual((await db.query("SELECT * FROM project_nj_pwc_eligibility(2,ARRAY[1])")).rows,
      [{ contractor_id: 1, project_id: 2, applicable: false }]);
    await db.exec("RESET ROLE");
    assert.equal((await db.query("SELECT prosecdef FROM pg_proc WHERE proname='project_nj_pwc_eligibility'")).rows[0].prosecdef, false);
    assert.equal((await db.query("SELECT has_function_privilege('anon','project_nj_pwc_eligibility(integer,integer[])','EXECUTE') allowed")).rows[0].allowed, false);
  } finally { await db.close(); }
});

test("assessment reader fails closed, retains project IDs and uses current records only", async () => {
  const signal = () => new AbortController().signal;
  const reset = () => {
    calls.length = 0; failure = null;
    tables = { projects: [{ ...project }, { ...privateProject }], contractor_projects: [{ id: 1, contractor_id: 1, project_id: 1, active: true }],
      contractors: [contractor], compliance_records: [record("NJ BRC"), record()].map(r => ({
        ...r, active: true, is_current: true, "compliance_types.active": true, compliance_types: { compliance_name: r.compliance_name },
      })) };
  };
  reset();
  const context = await getReportProjectContext(signal());
  assert.equal(context.projects[0].public_works, true);
  const result = await getSelectedProjectAssessment(1, signal(), "2026-11-09");
  assert.equal(result.contractors.length, 1); assert.equal(result.assessments.length, 3);
  assert.equal(result.assessments.every(row => row.projectId === 1), true);
  assert.equal(calls.some(c => c.table.includes("eligibility")), false, "Only existing RLS SELECT reads are used.");
  assert.deepEqual(plain(calls.find(c => c.table === "compliance_records").filters.slice(1, 4)),
    [["active", true], ["is_current", true], ["compliance_types.active", true]]);
  reset(); tables.projects = [];
  await assert.rejects(getSelectedProjectAssessment(1, signal()), /missing or inaccessible/);
  reset(); tables.contractors = [];
  await assert.rejects(getSelectedProjectAssessment(1, signal()), /missing, inaccessible or changed/);
  reset(); failure = "contractor_projects";
  await assert.rejects(getSelectedProjectAssessment(1, signal()), /Synthetic denied/);
  reset(); tables.contractor_projects = [];
  assert.equal((await getSelectedProjectAssessment(1, signal())).contractors.length, 0);
  assert.equal(calls.some(c => c.table === "contractors"), false, "Empty population never queries all contractors.");
  await assert.rejects(getSelectedProjectAssessment(NaN, signal()), /valid selected project/);
  for (const invalid of [undefined, null, "", "1", "All projects", -1, 0, Infinity]) {
    await assert.rejects(getComplianceReportAssessment(invalid, signal()), /valid selected project/);
  }
  reset(); tables.projects[0] = { ...project, public_works: null };
  await assert.rejects(getSelectedProjectAssessment(1, signal()), /classification is unknown/);
  reset(); tables.contractor_projects[0].project_id = 999;
  await assert.rejects(getReportProjectContext(signal()), /no longer accessible/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(getReportProjectContext(controller.signal));
  reset();
  const population = Array.from({ length: 501 }, (_, i) => ({ ...contractor, id: i + 1 }));
  tables.contractors = population;
  tables.compliance_records = [];
  tables.contractor_projects = population.map(c => ({ id: c.id, contractor_id: c.id, project_id: 1, active: true }));
  const paged = await getSelectedProjectAssessment(1, signal(), "2026-11-09");
  assert.equal(paged.contractors.length, 501);
  assert.equal(paged.assessments.length, 1503);
  assert.equal(calls.filter(c => c.table === "compliance_records").length, 6);

  reset();
  tables.contractor_projects.push({ id: 2, contractor_id: 1, project_id: 2, active: true });
  assert.equal((await getSelectedProjectAssessment(2, signal())).assessments[2].status, "Not Required");
  assert.equal((await getSelectedProjectAssessment(1, signal())).assessments[2].applicable, true);
  tables.projects[0].status = "Closed";
  assert.equal((await getSelectedProjectAssessment(1, signal())).assessments[2].applicable, false);
  reset(); tables.contractor_projects[0].active = false;
  assert.equal((await getSelectedProjectAssessment(1, signal())).contractors.length, 0);
  reset(); tables.contractors[0] = { ...contractor, material_vendor_only: true };
  assert.equal((await getSelectedProjectAssessment(1, signal())).assessments[2].applicable, false);
  reset();
  assert.equal((await getComplianceReportAssessment("all", signal())).contractors.length, 1);
  assert.equal((await getComplianceReportAssessment("unassigned", signal())).contractors.length, 0);
});

test("summary/filter/export population uses unique companies and never treats Unavailable as compliant", () => {
  const rows = assessment();
  const data = { project, contractors: [contractor, { ...contractor, id: 2, company_name: "Another" }],
    assessments: [...rows, ...rows.map(row => ({ ...row, contractorId: 2, status: row.requirement === "NJ BRC" ? "Unavailable" : "Missing" }))] };
  const companies = complianceCompanies(data);
  assert.equal(companies[0].name, "Another");
  assert.equal(companies[0].state, "Needs Review");
  assert.deepEqual(plain(complianceSummary(companies)).map(card => card.count), [2, 0, 1, 0, 1]);
  assert.equal(filterComplianceCompanies(companies, "", "Missing").length, 1, "Multiple missing requirements count once.");
  assert.equal(filterComplianceCompanies(companies, "Example", "0-30 Days").length, 1);
  assert.equal(filterComplianceCompanies(companies, "23-007", "All statuses").length, 0);
});
