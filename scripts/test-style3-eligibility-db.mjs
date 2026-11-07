import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { PGlite } = require(process.env.PGLITE_MODULE || "@electric-sql/pglite");
const sql = name => fs.readFileSync(new URL(`../supabase/${name}`, import.meta.url), "utf8");

test("bulk eligibility delegates to monitoring authority with assignment scope and restricted grants", async () => {
  const db = await PGlite.create();
  try {
    await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE contractors(id integer primary key, company_name text not null, active boolean, material_vendor_only boolean);
      CREATE TABLE projects(id integer primary key, status text, public_works boolean);
      CREATE TABLE contractor_projects(id integer primary key, contractor_id integer, project_id integer, active boolean);
      INSERT INTO contractors VALUES (1,'Public',true,false),(2,'Materials',true,true),
        (3,'Private',true,false),(4,'Completed assignment',true,false),
        (5,'Closed project',true,false),(6,'Inactive',false,false),(7,'No project',true,false);
      INSERT INTO projects VALUES (1,'Active',true),(2,'Active',false),(3,'Closed',true);
      INSERT INTO contractor_projects VALUES (1,1,1,true),(2,2,1,true),(3,3,2,true),
        (4,4,1,false),(5,5,3,true),(6,6,1,true);`);
    const source = sql("20261119_nj_pwc_public_works_monitoring_eligibility.sql");
    const authority = source.match(/CREATE OR REPLACE FUNCTION public\.nj_pwc_daily_contractor_eligible[\s\S]*?\$\$;/);
    assert.ok(authority);
    await db.exec(authority[0]);
    const before = (await db.query("SELECT pg_get_functiondef('public.nj_pwc_daily_contractor_eligible(integer)'::regprocedure) AS definition")).rows[0].definition;
    await db.exec(sql("20261214_style3_dashboard_eligibility.sql"));
    const after = (await db.query("SELECT pg_get_functiondef('public.nj_pwc_daily_contractor_eligible(integer)'::regprocedure) AS definition")).rows[0].definition;
    assert.equal(after, before);
    const rows = (await db.query("SELECT * FROM dashboard_nj_pwc_eligibility(0,500)")).rows;
    assert.deepEqual(rows.map(row => [row.contractor_id, row.applicability]), [
      [1, "applicable"], [2, "not_applicable"], [3, "not_applicable"],
    ]);
    assert.deepEqual((await db.query("SELECT contractor_id FROM dashboard_nj_pwc_eligibility(1,1)")).rows.map(row => row.contractor_id), [2]);
    for (const role of ["anon", "authenticated", "service_role"]) {
      const { rows: [result] } = await db.query(`SELECT has_function_privilege($1,
        'public.dashboard_nj_pwc_eligibility(integer,integer)', 'EXECUTE') AS allowed`, [role]);
      assert.equal(result.allowed, role === "service_role");
    }
    await db.exec("UPDATE projects SET public_works = false WHERE id = 1");
    assert.equal((await db.query("SELECT applicability FROM dashboard_nj_pwc_eligibility(0,1)")).rows[0].applicability, "not_applicable");
    await db.exec(`CREATE OR REPLACE FUNCTION public.nj_pwc_daily_contractor_eligible(p_contractor_id integer)
      RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT NULL::boolean $$`);
    assert.equal((await db.query("SELECT applicability FROM dashboard_nj_pwc_eligibility(0,1)")).rows[0].applicability, "unknown");
  } finally {
    await db.close();
  }
});
