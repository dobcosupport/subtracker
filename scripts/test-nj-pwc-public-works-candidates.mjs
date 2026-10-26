import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { PGlite } = require(process.env.PGLITE_MODULE || "@electric-sql/pglite");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "supabase");
const sql = (name) => fs.readFileSync(path.join(root, name), "utf8");

async function main() {
  const db = await PGlite.create();
  const rows = async (query, args = []) => (await db.query(query, args)).rows;
  try {
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE SCHEMA auth; CREATE TABLE auth.users(id UUID PRIMARY KEY,email TEXT);
      CREATE FUNCTION auth.uid() RETURNS UUID LANGUAGE sql STABLE AS $$ SELECT NULL::UUID $$;
    `);
    for (const name of ["20260929_user_management.sql", "20260929_user_management_enhancements.sql"]) {
      await db.exec(sql(name).split("INSERT INTO public.role_permissions")[0] + "\nCOMMIT;");
    }
    for (const name of [
      "subtracker_schema.sql", "20260924_contractor_detail_enhancements.sql",
      "20261002_compliance_sync_admin.sql", "20261002_compliance_sync_rpa.sql",
      "20261002_synced_compliance_records.sql", "20261002_compliance_records_synced_status.sql",
      "20261002_nj_brc_rpa_mapping.sql", "20261002_nj_brc_test_mode.sql",
      "20261005_nj_pwc_search_requests.sql", "20261006_nj_pwc_schema_alignment.sql",
      "20261009_compliance_worker_health.sql", "20261014_nj_pwc_registry_sync_schema.sql",
      "20261014_nj_pwc_registry_sync_functions.sql", "20261015_nj_pwc_atomic_queue.sql",
      "20261017_nj_pwc_exception_retry_lifecycle.sql", "20261019_nj_pwc_daily_sync_schedule.sql",
      "20261020_nj_pwc_graceful_stop.sql",
    ]) await db.exec(sql(name));
    await db.exec("ALTER TABLE public.projects ADD COLUMN public_works BOOLEAN");
    await db.exec(sql("20261115_nj_pwc_public_works_candidates.sql"));
    await db.exec(sql("20261115_nj_pwc_public_works_candidates.sql"));
    assert.equal((await rows("SELECT has_function_privilege('anon','public.nj_pwc_daily_contractor_eligible(integer)','EXECUTE') AS allowed"))[0].allowed, false);
    assert.equal((await rows("SELECT has_function_privilege('authenticated','public.nj_pwc_daily_contractor_eligible(integer)','EXECUTE') AS allowed"))[0].allowed, false);
    assert.equal((await rows("SELECT has_function_privilege('service_role','public.nj_pwc_daily_contractor_eligible(integer)','EXECUTE') AS allowed"))[0].allowed, false);
    assert.equal((await rows(`SELECT bool_and(has_function_privilege(pg_get_userbyid(p.proowner),
      'public.nj_pwc_daily_contractor_eligible(integer)','EXECUTE')) AS allowed
      FROM pg_proc p WHERE p.oid IN (
        'public.enqueue_nj_pwc_daily_sync(date,text)'::regprocedure,
        'public.run_nj_pwc_daily_sync_now(uuid,uuid,text,text)'::regprocedure
      )`))[0].allowed, true);

    await rows("UPDATE compliance_sync_settings SET enabled=TRUE,test_mode=FALSE,mode='review_required' WHERE compliance_name='NJ PWC'");
    const [publicProject] = await rows("INSERT INTO projects(project_number,project_name,status,public_works) VALUES('PW-ELIGIBLE','Active Public Works','Active',TRUE) RETURNING id");
    const [falseProject] = await rows("INSERT INTO projects(project_number,project_name,status,public_works) VALUES('PW-NO','Not Public Works','Active',FALSE) RETURNING id");
    const [unclassifiedProject] = await rows("INSERT INTO projects(project_number,project_name,status,public_works) VALUES('PW-NULL','Unclassified','Active',NULL) RETURNING id");
    const [inactiveProject] = await rows("INSERT INTO projects(project_number,project_name,status,public_works) VALUES('PW-INACTIVE','Inactive Public Works','Completed',TRUE) RETURNING id");
    const contractor = async (name, { id = null, active = true, material = false, number = null } = {}) => {
      const inserted = id === null
        ? await rows("INSERT INTO contractors(company_name,active,material_vendor_only,nj_pwc_number) VALUES($1,$2,$3,$4) RETURNING id",
          [name, active, material, number])
        : await rows("INSERT INTO contractors(id,company_name,active,material_vendor_only,nj_pwc_number) VALUES($1,$2,$3,$4,$5) RETURNING id",
          [id, name, active, material, number]);
      return inserted[0].id;
    };
    const assign = async (contractorId, projectId, active = true) =>
      rows("INSERT INTO contractor_projects(contractor_id,project_id,active) VALUES($1,$2,$3)", [contractorId, projectId, active]);

    const publicWorksNoRecord = await contractor("New Public Works Contractor");
    await assign(publicWorksNoRecord, publicProject.id);
    const yannuzzi = await contractor("Yannuzzi Group", { id: 372 });
    await assign(yannuzzi, publicProject.id);
    const materialOnly = await contractor("Material Only Contractor", { material: true, number: "MAT-372" });
    await assign(materialOnly, publicProject.id);
    const numberOnly = await contractor("Existing Number Contractor", { number: "EXIST-372" });
    const recordOnly = await contractor("Existing Record Contractor");
    const [pwcType] = await rows("SELECT id FROM compliance_types WHERE compliance_name='NJ PWC'");
    await rows(`INSERT INTO compliance_records(contractor_id,compliance_type_id,registration_number,active,is_current)
      VALUES($1,$2,'RECORD-372',TRUE,TRUE)`, [recordOnly, pwcType.id]);
    const falseOnly = await contractor("False Public Works Contractor");
    await assign(falseOnly, falseProject.id);
    const nullOnly = await contractor("Unclassified Public Works Contractor");
    await assign(nullOnly, unclassifiedProject.id);
    const inactive = await contractor("Inactive Public Works Contractor", { active: false, number: "INACTIVE-372" });
    await assign(inactive, publicProject.id);
    const blank = await contractor("");
    await assign(blank, publicProject.id);
    const inactiveAssignment = await contractor("Inactive Assignment Contractor");
    await assign(inactiveAssignment, publicProject.id, false);
    const inactiveProjectAssignment = await contractor("Inactive Project Contractor");
    await assign(inactiveProjectAssignment, inactiveProject.id);
    const pendingAutomatic = await contractor("Already Pending Contractor");
    await assign(pendingAutomatic, publicProject.id);
    const [existingPending] = await rows(`INSERT INTO compliance_sync_search_requests(
      compliance_name,searched_company_name,status,candidates,is_test,requested_by,contractor_id,origin,priority
    ) VALUES('NJ PWC','ALREADY PENDING CONTRACTOR','pending','[]',FALSE,'Prior Automatic Search',$1,'exception_retry',10) RETURNING id`, [pendingAutomatic]);
    const userPending = await contractor("User Pending Contractor");
    await assign(userPending, publicProject.id);
    await rows(`INSERT INTO compliance_sync_search_requests(
      compliance_name,searched_company_name,status,candidates,is_test,requested_by,contractor_id,origin,priority
    ) VALUES('NJ PWC','USER PENDING CONTRACTOR','pending','[]',FALSE,'User Search',$1,'user',0)`, [userPending]);

    const requestKey = "12121212-1212-4121-8121-121212121212";
    const runNow = (await rows("SELECT * FROM run_nj_pwc_daily_sync_now($1,NULL,'Eligibility Test','test@example.test')", [requestKey]))[0];
    const runNowIds = (await rows("SELECT contractor_id FROM compliance_sync_search_requests WHERE sync_run_id=$1 ORDER BY contractor_id", [runNow.run_id])).map(row => row.contractor_id);
    const expected = [publicWorksNoRecord, yannuzzi, numberOnly, recordOnly, userPending].sort((a, b) => a - b);
    assert.deepEqual(runNowIds, expected, "Run Now selects Public Works eligibility plus both legacy monitoring branches");
    assert.equal(runNowIds.includes(materialOnly), false, "Material Only is excluded even with a number and Public Works assignment");
    for (const id of [falseOnly, nullOnly, inactive, blank, inactiveAssignment, inactiveProjectAssignment, pendingAutomatic]) {
      assert.equal(runNowIds.includes(id), false, `Ineligible or already-pending contractor ${id} is not queued`);
    }
    assert.equal((await rows("SELECT count(*)::INT AS n FROM compliance_sync_search_requests WHERE contractor_id=$1 AND status='pending' AND origin<>'user'", [pendingAutomatic]))[0].n, 1,
      "Existing pending automatic request is not duplicated");
    assert.equal((await rows("SELECT count(*)::INT AS n FROM compliance_sync_search_requests WHERE id=$1", [existingPending.id]))[0].n, 1);

    await rows("UPDATE compliance_sync_search_requests SET status='completed' WHERE sync_run_id=$1", [runNow.run_id]);
    await rows("UPDATE compliance_sync_runs SET run_status='Completed',completed_at=now() WHERE id=$1", [runNow.run_id]);
    const scheduled = (await rows("SELECT * FROM enqueue_nj_pwc_daily_sync(CURRENT_DATE+400,'Eligibility Test')"))[0];
    const scheduledIds = (await rows("SELECT contractor_id FROM compliance_sync_search_requests WHERE sync_run_id=$1 ORDER BY contractor_id", [scheduled.run_id])).map(row => row.contractor_id);
    assert.deepEqual(scheduledIds, runNowIds, "Scheduled and Run Now produce identical eligibility");
    assert.equal(scheduled.enqueued, expected.length);
    assert.equal((await rows("SELECT count(*)::INT AS n FROM compliance_sync_search_requests WHERE contractor_id=$1 AND status='pending' AND origin<>'user'", [pendingAutomatic]))[0].n, 1,
      "Scheduled run preserves the pending-request guard");
    console.log("PASS: Public Works eligibility, legacy monitoring, material-only and pending exclusions match for Run Now and scheduled enqueue.");
  } finally {
    await db.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
