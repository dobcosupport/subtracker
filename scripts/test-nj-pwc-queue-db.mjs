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
  const complete = async (id, owner, status = "No Match Found", candidates = []) =>
    (await rows("SELECT complete_nj_pwc_request($1,$2,$3,$4::JSONB,NULL,NULL,NULL) AS result", [id, owner, status, JSON.stringify(candidates)]))[0].result;
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
      "20261017_nj_pwc_exception_retry_lifecycle.sql",
      "20261019_nj_pwc_daily_sync_schedule.sql",
    ]) await db.exec(sql(name));

    await t.test("migration applies and reruns without duplicating or renaming authoritative processing", async () => {
      await db.exec(sql("20261015_nj_pwc_atomic_queue.sql"));
      await db.exec(sql("20261017_nj_pwc_exception_retry_lifecycle.sql"));
      await db.exec(sql("20261019_nj_pwc_daily_sync_schedule.sql"));
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
    await t.test("daily schedule persists settings, audits changes, calculates local time through DST, and skips missed dates",async()=>{
      const saved=(await rows(`SELECT * FROM save_nj_pwc_daily_sync_schedule(
        TRUE,'2026-10-15','02:00','America/New_York',NULL,'Schedule Admin','schedule@example.test')`))[0];
      assert.equal(saved.daily_sync_enabled,true);
      assert.equal(saved.daily_sync_start_date.toISOString().slice(0,10),"2026-10-15");
      assert.equal(saved.daily_sync_time,"02:00:00");
      assert.equal(saved.daily_sync_timezone,"America/New_York");
      assert.ok(new Date(saved.next_sync_at)>new Date());
      const change=(await rows(`SELECT details FROM administration_audit_log
        WHERE action='NJ_PWC_DAILY_SCHEDULE_CHANGED' ORDER BY id DESC LIMIT 1`))[0].details;
      assert.equal(change.enabled.new,true); assert.equal(change.start_date.new,"2026-10-15");
      assert.equal(change.timezone.new,"America/New_York"); assert.ok(change.next_scheduled_run);
      const changed=(await rows(`SELECT * FROM save_nj_pwc_daily_sync_schedule(
        TRUE,'2026-10-15','03:30','America/New_York',NULL,'Schedule Admin','schedule@example.test')`))[0];
      assert.equal(new Date(changed.next_sync_at).toISOString(),"2026-10-15T07:30:00.000Z","time edits recalculate the next occurrence");

      const spring=(await rows(`SELECT nj_pwc_next_daily_sync_at('2026-03-08','02:00','America/New_York','2026-03-07T14:00:00Z') AS run_at`))[0].run_at;
      const springNext=(await rows(`SELECT nj_pwc_next_daily_sync_at('2026-03-08','02:00','America/New_York','2026-03-08T12:00:00Z') AS run_at`))[0].run_at;
      assert.equal(new Date(spring).toISOString(),"2026-03-08T07:00:00.000Z");
      assert.equal(new Date(springNext).toISOString(),"2026-03-09T06:00:00.000Z");
      const fall=(await rows(`SELECT nj_pwc_next_daily_sync_at('2026-11-01','02:00','America/New_York','2026-10-31T14:00:00Z') AS run_at`))[0].run_at;
      assert.equal(new Date(fall).toISOString(),"2026-11-01T07:00:00.000Z");

      const missed=(await rows(`SELECT nj_pwc_next_daily_sync_at('2026-10-10','02:00','America/New_York','2026-10-14T12:00:00Z') AS run_at`))[0].run_at;
      assert.equal(new Date(missed).toISOString(),"2026-10-15T06:00:00.000Z","missed past dates advance to the next occurrence");
    });
    await t.test("scheduled run is created once per local date even if Test Mode changes",async()=>{
      const contractor=(await rows("INSERT INTO contractors(company_name,active,nj_pwc_number) VALUES('Schedule Test Contractor',TRUE,'SCHED-635') RETURNING id"))[0].id;
      await rows(`UPDATE compliance_sync_settings SET daily_sync_enabled=TRUE,daily_sync_start_date='2031-01-01',
        daily_sync_time='02:00',daily_sync_timezone='America/New_York',daily_sync_last_scheduled_date=NULL,
        next_sync_at='2031-01-01T07:00:00Z',test_mode=TRUE WHERE compliance_name='NJ PWC'`);
      const concurrent=await Promise.all([
        rows("SELECT * FROM poll_nj_pwc_daily_sync_schedule('2031-01-01T07:00:00Z')"),
        rows("SELECT * FROM poll_nj_pwc_daily_sync_schedule('2031-01-01T07:00:00Z')"),
      ]);
      assert.equal(concurrent.flat().filter((poll) => poll.due).length,1);
      const first=concurrent.flat().find((poll) => poll.due);
      assert.equal(first.due,true); assert.equal(first.is_test,true); assert.equal(first.created,true);
      assert.equal(new Date(first.next_sync_at).toISOString(),"2031-01-02T07:00:00.000Z");
      const run=(await rows("SELECT run_date,is_test,run_status FROM compliance_sync_runs WHERE id=$1",[first.run_id]))[0];
      assert.equal(run.run_date.toISOString().slice(0,10),"2031-01-01"); assert.equal(run.is_test,true); assert.equal(run.run_status,"Running");
      const queuedBefore=(await rows("SELECT count(*)::INT AS n FROM compliance_sync_search_requests WHERE sync_run_id=$1",[first.run_id]))[0].n;
      assert.equal(queuedBefore,1);
      await rows("UPDATE compliance_sync_settings SET test_mode=FALSE,next_sync_at='2031-01-01T07:00:00Z' WHERE compliance_name='NJ PWC'");
      const second=(await rows("SELECT * FROM poll_nj_pwc_daily_sync_schedule('2031-01-01T07:05:00Z')"))[0];
      assert.equal(second.due,false); assert.equal(second.skipped_reason,"already_scheduled");
      assert.equal((await rows("SELECT count(*)::INT AS n FROM compliance_sync_runs WHERE run_type='nj_pwc_daily' AND run_date='2031-01-01'"))[0].n,1);

      await rows(`UPDATE compliance_sync_search_requests SET status='processing' WHERE sync_run_id=$1`,[first.run_id]);
      await rows(`SELECT * FROM save_nj_pwc_daily_sync_schedule(FALSE,'2031-01-01','02:00','America/New_York',
        NULL,'Schedule Admin','schedule@example.test')`);
      const disabled=(await rows("SELECT * FROM poll_nj_pwc_daily_sync_schedule('2031-01-02T07:00:00Z')"))[0];
      assert.equal(disabled.due,false); assert.equal(disabled.skipped_reason,"disabled");
      assert.equal((await rows("SELECT status FROM compliance_sync_search_requests WHERE sync_run_id=$1",[first.run_id]))[0].status,"processing");
      await rows("UPDATE compliance_sync_search_requests SET status='failed',result_status='RPA Error' WHERE sync_run_id=$1",[first.run_id]);
      await rows("UPDATE compliance_sync_runs SET run_status='Completed',completed_at=now() WHERE id=$1",[first.run_id]);
      await rows("UPDATE contractors SET active=FALSE WHERE id=$1",[contractor]);
    });
    await t.test("reenabling after missed dates schedules the next occurrence without a catch-up run",async()=>{
      const result=(await rows(`SELECT * FROM save_nj_pwc_daily_sync_schedule(
        TRUE,'2026-10-10','02:00','America/New_York',NULL,'Schedule Admin','schedule@example.test')`))[0];
      assert.equal(new Date(result.next_sync_at).toISOString(),"2026-10-15T06:00:00.000Z");
      const poll=(await rows("SELECT * FROM poll_nj_pwc_daily_sync_schedule('2026-10-14T12:00:00Z')"))[0];
      assert.equal(poll.due,false);
      assert.equal((await rows("SELECT count(*)::INT AS n FROM compliance_sync_runs WHERE run_type='nj_pwc_daily' AND run_date<'2026-10-15'"))[0].n,0);
    });
    await t.test("existing same-date run in the other Test Mode lane prevents a second scheduled run",async()=>{
      const existing=(await rows(`INSERT INTO compliance_sync_runs(run_at,started_at,completed_at,sync_source,run_status,status,
        is_test,run_type,run_date,triggered_by,initiated_by)
        VALUES(now(),now(),now(),'RPA','Completed','completed',FALSE,'nj_pwc_daily','2032-01-01','Legacy','Legacy') RETURNING id`))[0].id;
      await rows(`UPDATE compliance_sync_settings SET daily_sync_enabled=TRUE,daily_sync_start_date='2032-01-01',
        daily_sync_time='02:00',daily_sync_timezone='America/New_York',daily_sync_last_scheduled_date=NULL,
        next_sync_at='2032-01-01T07:00:00Z',test_mode=TRUE WHERE compliance_name='NJ PWC'`);
      const result=(await rows("SELECT * FROM poll_nj_pwc_daily_sync_schedule('2032-01-01T07:00:00Z')"))[0];
      assert.equal(result.due,false); assert.equal(result.run_id,existing); assert.equal(result.is_test,false);
      assert.equal(result.skipped_reason,"already_scheduled");
      assert.equal((await rows("SELECT count(*)::INT AS n FROM compliance_sync_runs WHERE run_type='nj_pwc_daily' AND run_date='2032-01-01'"))[0].n,1);
    });
    const createExceptionRetryFixture = async (name,isTest=false) => {
      await rows("UPDATE compliance_sync_settings SET enabled=TRUE,test_mode=$1,mode='auto_approve' WHERE compliance_name='NJ PWC'",[isTest]);
      const contractor=(await rows(`INSERT INTO contractors(company_name,active,city,state,zip_code,nj_pwc_number)
        VALUES($1,TRUE,'Old City','NJ','07000','OLD-CERT') RETURNING id`,[`${name} Original Name`]))[0].id;
      const prior=(await rows(`INSERT INTO compliance_sync_search_requests(compliance_name,searched_company_name,
        searched_city,searched_state,searched_zip_code,status,result_status,candidates,is_test,contractor_id,origin)
        VALUES('NJ PWC',$1,'Old City','NJ','07000','completed','Match Found','[]',$2,$3,'daily_sync') RETURNING id`,
        [`${name} Original Name`,isTest,contractor]))[0].id;
      const exception=(await rows(`INSERT INTO nj_pwc_sync_exceptions(contractor_id,is_test,reason,kind,
        last_search_request_id,consecutive_failure_count,last_attempt_at)
        VALUES($1,$2,'Name Mismatch','failure',$3,2,now()-interval '1 hour') RETURNING id`,[contractor,isTest,prior]))[0].id;
      await rows(`INSERT INTO nj_pwc_sync_state(contractor_id,is_test,state,consecutive_failure_count)
        VALUES($1,$2,'Investigation Required',2)`,[contractor,isTest]);
      return { contractor, prior, exception };
    };
    const processRetry = async (requestId, status, candidates = []) => {
      const request=(await claim(workers[0]))[0];
      assert.equal(request.id,requestId);
      await start(requestId,workers[0]);
      return complete(requestId,workers[0],status,candidates);
    };
    await t.test("exception retry snapshots current contractor fields and outranks pending Daily Sync work",async()=>{
      const fixture=await createExceptionRetryFixture("Fresh Snapshot");
      await rows(`UPDATE contractors SET company_name='Fresh Snapshot Current Name',city='New City',state='NJ',
        zip_code='07102',nj_pwc_number='CURRENT-CERT' WHERE id=$1`,[fixture.contractor]);
      const pendingDaily=(await rows(`INSERT INTO compliance_sync_search_requests(compliance_name,searched_company_name,
        searched_city,searched_state,searched_zip_code,status,candidates,is_test,contractor_id,origin,priority)
        VALUES('NJ PWC','Fresh Snapshot Original Name','Old City','NJ','07000','pending','[]',FALSE,$1,'daily_sync',20) RETURNING id`,
        [fixture.contractor]))[0].id;
      const remainingDaily=(await rows(`INSERT INTO compliance_sync_search_requests(compliance_name,searched_company_name,
        status,candidates,is_test,contractor_id,origin,priority)
        VALUES('NJ PWC','Remaining Daily Work','pending','[]',FALSE,$1,'daily_sync',20) RETURNING id`,
        [fixture.contractor]))[0].id;
      const result=(await rows("SELECT * FROM retry_nj_pwc_sync_exception($1,NULL,'Retry Admin','retry@example.test')",[fixture.exception]))[0];
      assert.equal(result.created,true);
      const retry=(await rows("SELECT * FROM compliance_sync_search_requests WHERE id=$1",[result.search_request_id]))[0];
      assert.equal(retry.searched_company_name,"FRESH SNAPSHOT CURRENT NAME");
      assert.equal(retry.searched_city,"New City"); assert.equal(retry.searched_state,"NJ"); assert.equal(retry.searched_zip_code,"07102");
      assert.equal(retry.contractor_id,fixture.contractor); assert.equal(retry.is_test,false);
      assert.equal(retry.origin,"exception_retry"); assert.equal(retry.priority,10);
      assert.equal(retry.retry_of_request_id,fixture.prior);
      assert.notEqual(retry.id,pendingDaily);
      assert.equal((await rows("SELECT last_search_request_id FROM nj_pwc_sync_exceptions WHERE id=$1",[fixture.exception]))[0].last_search_request_id,retry.id);
      const candidate={business_name:"Fresh Snapshot Current Name",certificate_number:"CURRENT-CERT",
        registration_date:"2025-01-01",expiration_date:"2099-01-01"};
      const completed=await processRetry(retry.id,"Match Found",[candidate]);
      assert.equal(completed.sync.classification,"Exact Match");
      assert.equal((await rows("SELECT status FROM nj_pwc_sync_exceptions WHERE id=$1",[fixture.exception]))[0].status,"resolved");
      const state=(await rows("SELECT consecutive_failure_count,last_successful_sync_at FROM nj_pwc_sync_state WHERE contractor_id=$1 AND NOT is_test",[fixture.contractor]))[0];
      assert.equal(state.consecutive_failure_count,0); assert.ok(state.last_successful_sync_at);
      assert.equal((await claim(workers[0]))[0].id,pendingDaily);
      await complete(pendingDaily,workers[0]);
      assert.equal((await claim(workers[0]))[0].id,remainingDaily);
      await complete(remainingDaily,workers[0]);
      await rows("UPDATE contractors SET active=FALSE WHERE id=$1",[fixture.contractor]);
    });
    await t.test("same failed retry keeps the exception open and updates attempt and request",async()=>{
      const fixture=await createExceptionRetryFixture("Repeated Mismatch");
      await rows("UPDATE contractors SET company_name='Repeated Mismatch Current Name' WHERE id=$1",[fixture.contractor]);
      const {search_request_id:retryId}=(await rows("SELECT * FROM retry_nj_pwc_sync_exception($1,NULL,'Retry Admin','retry@example.test')",[fixture.exception]))[0];
      const candidate={business_name:"Still Different Registry Name",certificate_number:"OLD-CERT",
        registration_date:"2025-01-01",expiration_date:"2099-01-01"};
      const result=await processRetry(retryId,"Match Found",[candidate]);
      assert.equal(result.sync.classification,"Name Mismatch");
      const exception=(await rows(`SELECT status,reason,last_search_request_id,last_attempt_at,occurrences,consecutive_failure_count
        FROM nj_pwc_sync_exceptions WHERE id=$1`,[fixture.exception]))[0];
      assert.equal(exception.status,"open"); assert.equal(exception.reason,"Name Mismatch");
      assert.equal(exception.last_search_request_id,retryId);
      assert.equal((await rows("SELECT last_attempt_at > now() - interval '5 minutes' AS recent FROM nj_pwc_sync_exceptions WHERE id=$1",[fixture.exception]))[0].recent,true);
      assert.equal(exception.occurrences,2); assert.equal(exception.consecutive_failure_count,2);
      assert.equal((await rows("SELECT consecutive_failure_count FROM nj_pwc_sync_state WHERE contractor_id=$1 AND NOT is_test",[fixture.contractor]))[0].consecutive_failure_count,2);
      await rows("UPDATE contractors SET active=FALSE WHERE id=$1",[fixture.contractor]);
    });
    await t.test("Test Mode retry resolves and resets only its shadow lane",async()=>{
      const fixture=await createExceptionRetryFixture("Test Lane",true);
      const {search_request_id:retryId}=(await rows("SELECT * FROM retry_nj_pwc_sync_exception($1,NULL,'Retry Admin','retry@example.test')",[fixture.exception]))[0];
      const retry=(await rows("SELECT origin,priority,is_test FROM compliance_sync_search_requests WHERE id=$1",[retryId]))[0];
      assert.equal(retry.origin,"exception_retry"); assert.equal(retry.priority,10); assert.equal(retry.is_test,true);
      const candidate={business_name:"Test Lane Original Name",certificate_number:"OLD-CERT",
        registration_date:"2025-01-01",expiration_date:"2099-01-01"};
      const result=await processRetry(retryId,"Match Found",[candidate]);
      assert.equal(result.sync.classification,"Exact Match");
      assert.equal((await rows("SELECT status FROM nj_pwc_sync_exceptions WHERE id=$1",[fixture.exception]))[0].status,"resolved");
      const testState=(await rows("SELECT consecutive_failure_count,last_successful_sync_at FROM nj_pwc_sync_state WHERE contractor_id=$1 AND is_test",[fixture.contractor]))[0];
      assert.equal(testState.consecutive_failure_count,0); assert.ok(testState.last_successful_sync_at);
      assert.equal((await rows("SELECT count(*)::INT AS n FROM compliance_records WHERE contractor_id=$1",[fixture.contractor]))[0].n,0);
      assert.equal((await rows("SELECT count(*)::INT AS n FROM nj_pwc_sync_state WHERE contractor_id=$1 AND NOT is_test",[fixture.contractor]))[0].n,0);
      await rows("UPDATE contractors SET active=FALSE WHERE id=$1",[fixture.contractor]);
    });
    await t.test("changed retry failure reason replaces the old open exception",async()=>{
      const fixture=await createExceptionRetryFixture("Changed Failure");
      const {search_request_id:retryId}=(await rows("SELECT * FROM retry_nj_pwc_sync_exception($1,NULL,'Retry Admin','retry@example.test')",[fixture.exception]))[0];
      const result=await processRetry(retryId,"No Match Found");
      assert.equal(result.sync.classification,"No Match Found");
      assert.equal((await rows("SELECT status FROM nj_pwc_sync_exceptions WHERE id=$1",[fixture.exception]))[0].status,"resolved");
      const current=(await rows(`SELECT id,status,reason,last_search_request_id FROM nj_pwc_sync_exceptions
        WHERE contractor_id=$1 AND is_test=FALSE AND status='open'`,[fixture.contractor]))[0];
      assert.equal(current.reason,"No Match Found"); assert.equal(current.last_search_request_id,retryId);
      assert.equal((await rows("SELECT consecutive_failure_count FROM nj_pwc_sync_state WHERE contractor_id=$1 AND NOT is_test",[fixture.contractor]))[0].consecutive_failure_count,2);
      await rows("UPDATE contractors SET active=FALSE WHERE id=$1",[fixture.contractor]);
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
    await t.test("Run Now is idempotent, snapshots current settings, uses priority 20, and preserves recurrence",async()=>{
      const contractor=(await rows(`INSERT INTO contractors(company_name,active,nj_pwc_number)
        VALUES('Run Now Contractor',TRUE,'RUN-NOW-635') RETURNING id`))[0].id;
      await rows(`UPDATE compliance_sync_settings SET enabled=TRUE,mode='review_required',sync_source='API',test_mode=TRUE,
        failure_expire_threshold=7,daily_sync_enabled=FALSE,daily_sync_start_date='2032-04-02',daily_sync_time='03:30',
        daily_sync_timezone='America/New_York',next_sync_at='2032-04-02T07:30:00Z' WHERE compliance_name='NJ PWC'`);
      const activeRuns=await rows("SELECT id,run_type,manual_run,run_date,is_test FROM compliance_sync_runs WHERE run_status='Running'");
      assert.deepEqual(activeRuns,[],JSON.stringify(activeRuns));
      const requestKey='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
      const started=(await rows("SELECT * FROM run_nj_pwc_daily_sync_now($1,NULL,'Run Now Admin','run@example.test')",[requestKey]))[0];
      assert.equal(started.created,true); assert.equal(started.is_test,true); assert.equal(started.run_status,'Running');
      const run=(await rows("SELECT run_type,manual_run,run_date,is_test,sync_source,notes FROM compliance_sync_runs WHERE id=$1",[started.run_id]))[0];
      assert.equal(run.run_type,'nj_pwc_daily'); assert.equal(run.manual_run,true); assert.equal(run.is_test,true); assert.equal(run.sync_source,'API');
      assert.match(run.notes,/Test Mode/); assert.match(run.notes,/review_required/);
      const request=(await rows("SELECT origin,priority,is_test,sync_run_id FROM compliance_sync_search_requests WHERE sync_run_id=$1",[started.run_id]))[0];
      assert.equal(request.origin,'daily_sync'); assert.equal(request.priority,20); assert.equal(request.is_test,true);
      const nextBefore=(await rows("SELECT next_sync_at FROM compliance_sync_settings WHERE compliance_name='NJ PWC'"))[0].next_sync_at;
      const duplicate=(await rows("SELECT * FROM run_nj_pwc_daily_sync_now($1,NULL,'Run Now Admin','run@example.test')",[requestKey]))[0];
      assert.equal(duplicate.created,false); assert.equal(duplicate.run_id,started.run_id); assert.equal(duplicate.already_active,true);
      const conflict=(await rows("SELECT * FROM run_nj_pwc_daily_sync_now($1,NULL,'Run Now Admin','run@example.test')",['dddddddd-dddd-4ddd-8ddd-dddddddddddd']))[0];
      assert.equal(conflict.created,false); assert.equal(conflict.run_id,started.run_id); assert.equal(conflict.already_active,true);
      assert.equal((await rows("SELECT next_sync_at FROM compliance_sync_settings WHERE compliance_name='NJ PWC'"))[0].next_sync_at.getTime(),nextBefore.getTime());
      assert.equal((await rows("SELECT count(*)::INT AS n FROM compliance_sync_runs WHERE manual_run"))[0].n,1);
      const manualAudit=(await rows(`SELECT details FROM administration_audit_log
        WHERE action='NJ_PWC_DAILY_RUN_MANUALLY_STARTED' AND object_id=$1`,[String(started.run_id)]))[0].details;
      assert.equal(manualAudit.mode,'review_required'); assert.equal(manualAudit.test_mode,true);
      assert.equal(manualAudit.failure_expire_threshold,7); assert.equal(manualAudit.sync_source,'API');
      await rows("UPDATE compliance_sync_runs SET run_status='Completed',completed_at=now() WHERE id=$1",[started.run_id]);
      const replay=(await rows("SELECT * FROM run_nj_pwc_daily_sync_now($1,NULL,'Run Now Admin','run@example.test')",[requestKey]))[0];
      assert.equal(replay.created,false); assert.equal(replay.run_status,'Completed');
      await rows("UPDATE compliance_sync_search_requests SET status='failed',result_status='RPA Error' WHERE sync_run_id=$1",[started.run_id]);
      await rows("UPDATE contractors SET active=FALSE WHERE id=$1",[contractor]);
    });
    await t.test("ownership and recovery actions have durable audit entries", async () => {
      const audit=(await rows("SELECT count(*)::INT AS n FROM administration_audit_log WHERE action LIKE 'NJ_PWC%REQUEST%' OR action LIKE 'NJ_PWC%ORPHAN%'"))[0];
      assert.ok(audit.n>=10);
    });
  } finally { await db.close(); }
});
