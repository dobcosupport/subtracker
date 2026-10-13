import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";

const require = createRequire(import.meta.url);
const { PGlite } = require(process.env.PGLITE_MODULE || "@electric-sql/pglite");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "supabase");
const sql = (name) => fs.readFileSync(path.join(root, name), "utf8");
const workers = ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"];

test("NJ PWC atomic queue migration and ownership/recovery SQL", async (t) => {
  const db = await PGlite.create();
  const rows = async (query, args = []) => (await db.query(query, args)).rows;
  const claim = async (owner) => rows("SELECT * FROM claim_nj_pwc_request($1)", [owner]);
  const start = async (id, owner) => rows("SELECT start_nj_pwc_request($1,$2)", [id, owner]);
  const complete = async (id, owner, status = "No Match Found") =>
    (await rows("SELECT complete_nj_pwc_request($1,$2,$3,'[]',NULL,NULL,NULL) AS result", [id, owner, status]))[0].result;
  const insert = async (name, priority, origin = "user") =>
    (await rows("INSERT INTO compliance_sync_search_requests(compliance_name,searched_company_name,priority,origin) VALUES ('NJ PWC',$1,$2,$3) RETURNING id", [name, priority, origin]))[0].id;
  const recover = async (id, action) =>
    (await rows("SELECT recover_orphaned_nj_pwc_request($1,$2,10,NULL,'Queue Test Admin','admin@example.test',NULL) AS result", [id, action]))[0].result;
  const orphan = async () => rows("SELECT id FROM list_orphaned_nj_pwc_requests(10)");
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
      "20261009_compliance_worker_health.sql",
      "20261014_nj_pwc_registry_sync_schema.sql", "20261014_nj_pwc_registry_sync_functions.sql",
      "20261015_nj_pwc_atomic_queue.sql",
    ]) await db.exec(sql(name));

    await t.test("migration applies and reruns without duplicating or renaming authoritative processing", async () => {
      await db.exec(sql("20261015_nj_pwc_atomic_queue.sql"));
      assert.ok((await rows("SELECT to_regprocedure('submit_nj_pwc_sync_result(integer,text,jsonb,text,text,text)') AS f"))[0].f);
      assert.equal((await rows("SELECT has_function_privilege('service_role','submit_nj_pwc_sync_result(integer,text,jsonb,text,text,text)','EXECUTE') AS ok"))[0].ok, false);
    });
    await t.test("unregistered workers cannot claim", async () => {
      await assert.rejects(claim(workers[0]), /healthy heartbeat/);
      for (const id of workers) {
        assert.equal((await rows("SELECT report_nj_pwc_queue_worker(jsonb_build_object('instance_id',$1::TEXT,'started_at',now(),'sequence',1,'lifecycle','ready','browser_connected',TRUE,'loaded_hash','test-hash','current_hash','test-hash')) AS accepted", [id]))[0].accepted, true);
      }
    });
    await t.test("two worker claims are distinct and respect 0/10/20 priority and id tie-breaker", async () => {
      const daily = await insert("Daily", 20);
      const retry = await insert("Retry", 10);
      const user = await insert("User", 0);
      const user2 = await insert("User2", 0);
      const [a, b] = await Promise.all([claim(workers[0]), claim(workers[1])]);
      assert.deepEqual([a[0].id,b[0].id].sort((x,y)=>x-y), [user,user2]);
      assert.equal((await claim(workers[0]))[0].id,a[0].id);
      await complete(a[0].id,workers[0]); await complete(b[0].id,workers[1]);
      assert.equal((await claim(workers[0]))[0].id,retry);
      await complete(retry,workers[0]);
      assert.equal((await claim(workers[0]))[0].id,daily);
      await complete(daily,workers[0]);
      assert.deepEqual(await claim(workers[0]),[]);
    });
    await t.test("processing is single-start, results owner-checked, completion idempotent", async () => {
      const id=await insert("Ownership",0);
      await claim(workers[0]);
      await assert.rejects(start(id,workers[1]),/not claimed/);
      await start(id,workers[0]);
      await assert.rejects(start(id,workers[0]),/not claimed/);
      await assert.rejects(claim(workers[0]),/already owns/);
      await assert.rejects(complete(id,workers[1]),/does not own/);
      assert.equal((await complete(id,workers[0],"Website Error")).status,"website_error");
      assert.equal((await complete(id,workers[0])).already_processed,true);
    });
    await t.test("healthy and too-young claims are not orphaned; stale claims never reassign", async () => {
      const id=await insert("Orphan",0);
      await rows("UPDATE compliance_sync_search_requests SET requested_by='Original Search User' WHERE id=$1",[id]);
      await claim(workers[0]);
      await rows("UPDATE compliance_sync_search_requests SET claimed_at=now()-interval '20 minutes' WHERE id=$1",[id]);
      assert.deepEqual(await orphan(),[]);
      await assert.rejects(recover(id,"retry"),/no longer meets/);
      await rows("UPDATE nj_pwc_queue_workers SET last_heartbeat_at=now()-interval '5 minutes' WHERE instance_id=$1",[workers[0]]);
      assert.deepEqual(await orphan(),[{id}]);
      assert.deepEqual(await claim(workers[1]),[]);
      await rows("UPDATE compliance_sync_search_requests SET claimed_at=now() WHERE id=$1",[id]);
      assert.deepEqual(await orphan(),[]);
      await rows("UPDATE compliance_sync_search_requests SET claimed_at=now()-interval '20 minutes' WHERE id=$1",[id]);
      const result=await recover(id,"retry");
      assert.ok(result.retry_request_id);
      const old=(await rows("SELECT * FROM compliance_sync_search_requests WHERE id=$1",[id]))[0];
      assert.equal(old.status,"failed"); assert.equal(old.worker_instance_id,workers[0]);
      const retry=(await rows("SELECT * FROM compliance_sync_search_requests WHERE id=$1",[result.retry_request_id]))[0];
      assert.equal(retry.retry_of_request_id,id); assert.equal(retry.priority,0);
      assert.equal(retry.requested_by,"Original Search User");
      assert.equal(retry.worker_instance_id,null);
      await assert.rejects(complete(id,workers[0]),/does not own/);
      assert.equal((await claim(workers[1]))[0].id,retry.id);
      await complete(retry.id,workers[1]);
    });
    await t.test("Mark Failed and Resolve terminalize without pretending a successful result", async () => {
      for (const action of ["fail","resolve"]) {
        const id=await insert(`Orphan ${action}`,0);
        await claim(workers[1]);
        await rows("UPDATE compliance_sync_search_requests SET claimed_at=now()-interval '20 minutes' WHERE id=$1",[id]);
        await rows("UPDATE nj_pwc_queue_workers SET lifecycle='stopped' WHERE instance_id=$1",[workers[1]]);
        assert.equal((await recover(id,action)).retry_request_id,null);
        assert.equal((await rows("SELECT result_status FROM compliance_sync_search_requests WHERE id=$1",[id]))[0].result_status,"RPA Error");
        await rows("UPDATE nj_pwc_queue_workers SET lifecycle='ready',last_heartbeat_at=now() WHERE instance_id=$1",[workers[1]]);
      }
    });
    await t.test("daily finalization including force cannot abandon claimed/processing requests", async () => {
      const contractor=(await rows("INSERT INTO contractors(company_name,nj_pwc_number) VALUES ('Daily Queue Contractor','Q123') RETURNING id"))[0].id;
      await rows("UPDATE compliance_sync_settings SET enabled=TRUE,test_mode=TRUE WHERE compliance_name='NJ PWC'");
      const run=(await rows("SELECT * FROM enqueue_nj_pwc_daily_sync(CURRENT_DATE,'Queue Test')"))[0];
      const request=(await claim(workers[1]))[0];
      assert.equal(request.contractor_id,contractor); assert.equal(request.is_test,true);
      for (const force of [false,true]) {
        const result=(await rows("SELECT * FROM finalize_nj_pwc_daily_run($1,$2)",[run.run_id,force]))[0];
        assert.equal(result.finished,false); assert.equal(result.pending,1);
      }
      await start(request.id,workers[1]);
      assert.equal((await rows("SELECT * FROM finalize_nj_pwc_daily_run($1,TRUE)",[run.run_id]))[0].finished,false);
      await rows("UPDATE compliance_sync_search_requests SET claimed_at=now()-interval '20 minutes' WHERE id=$1",[request.id]);
      await rows("UPDATE nj_pwc_queue_workers SET lifecycle='stopped' WHERE instance_id=$1",[workers[1]]);
      const recovery=await recover(request.id,"retry");
      const retried=(await rows("SELECT * FROM compliance_sync_search_requests WHERE id=$1",[recovery.retry_request_id]))[0];
      assert.equal(retried.is_test,true); assert.equal(retried.priority,10); assert.equal(retried.sync_run_id,run.run_id);
      assert.equal((await rows("SELECT count(*)::INT AS n FROM compliance_records WHERE contractor_id=$1",[contractor]))[0].n,0);
      assert.equal((await rows("SELECT consecutive_failure_count FROM nj_pwc_sync_state WHERE contractor_id=$1 AND is_test",[contractor]))[0].consecutive_failure_count,0);
      await rows("UPDATE nj_pwc_queue_workers SET lifecycle='ready',last_heartbeat_at=now() WHERE instance_id=$1",[workers[1]]);
      await claim(workers[1]); await start(retried.id,workers[1]); await complete(retried.id,workers[1],"RPA Error");
      assert.equal((await rows("SELECT * FROM finalize_nj_pwc_daily_run($1,FALSE)",[run.run_id]))[0].finished,true);
    });
    await t.test("owned exact results preserve Test Mode, Auto Approve and Review Required behavior", async () => {
      await rows("UPDATE contractors SET active=FALSE");
      const contractor=(await rows("INSERT INTO contractors(company_name,nj_pwc_number) VALUES ('Exact Queue LLC','123456') RETURNING id"))[0].id;
      for (const [day,isTest,mode,days,records] of [
        [1,true,"auto_approve",365,0],
        [2,false,"auto_approve",365,1],
        [3,false,"review_required",730,1],
      ]) {
        await rows("UPDATE compliance_sync_settings SET test_mode=$1,mode=$2 WHERE compliance_name='NJ PWC'",[isTest,mode]);
        await rows("SELECT * FROM enqueue_nj_pwc_daily_sync(CURRENT_DATE+$1::INT,'Queue Exact Test')",[day]);
        const request=(await claim(workers[1]))[0];
        assert.equal(request.contractor_id,contractor);
        await start(request.id,workers[1]);
        const completed=(await rows(`SELECT complete_nj_pwc_request($1,$2,'Match Found',jsonb_build_array(jsonb_build_object(
          'business_name','Exact Queue LLC','certificate_number','123456',
          'registration_date',CURRENT_DATE-1,'expiration_date',CURRENT_DATE+$3::INT
        )),NULL,NULL,NULL) AS result`,[request.id,workers[1],days]))[0].result;
        assert.equal(completed.status,"completed");
        assert.equal(completed.sync.classification,"Exact Match");
        assert.equal((await rows("SELECT count(*)::INT AS n FROM compliance_records WHERE contractor_id=$1",[contractor]))[0].n,records);
        if (!isTest) assert.equal(completed.sync.outcome,mode==="auto_approve" ? "success:auto_approved" : "success:review_required_update");
        await rows("SELECT * FROM finalize_nj_pwc_daily_run($1,FALSE)",[request.sync_run_id]);
      }
    });
    await t.test("ownership and recovery actions have durable audit entries", async () => {
      const audit=(await rows("SELECT count(*)::INT AS n FROM administration_audit_log WHERE action LIKE 'NJ_PWC%REQUEST%' OR action LIKE 'NJ_PWC%ORPHAN%'"))[0];
      assert.ok(audit.n>=10);
    });
  } finally { await db.close(); }
});
