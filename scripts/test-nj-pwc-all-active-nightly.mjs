import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { PGlite } = require("@electric-sql/pglite");
const sql = name => fs.readFileSync(new URL("../supabase/" + name, import.meta.url), "utf8");
const migration = "20261119_nj_pwc_public_works_monitoring_eligibility.sql";
const worker = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const restarted = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

test("Public Works eligibility and drain-before-rollover (isolated PostgreSQL)", async t => {
  const db = await PGlite.create();
  const rows = async (query, args = []) => (await db.query(query, args)).rows;
  const one = async (query, args = []) => (await rows(query, args))[0];
  let publicWorksProjectId = null;
  const contractor = async (name, active = true, material = false, number = null, withPublicWorksAssignment = true) => {
    const id = (await one("INSERT INTO contractors(company_name,active,material_vendor_only,nj_pwc_number) VALUES($1,$2,$3,$4) RETURNING id",
      [name, active, material, number])).id;
    if (withPublicWorksAssignment) {
      if (!publicWorksProjectId) {
        publicWorksProjectId = (await one(`INSERT INTO projects(project_number,project_name,status,public_works)
          VALUES('ELIGIBILITY','Eligibility Fixture','Active',true) RETURNING id`)).id;
      }
      await rows("INSERT INTO contractor_projects(contractor_id,project_id,active) VALUES($1,$2,true)",
        [id, publicWorksProjectId]);
    }
    return id;
  };
  const enqueue = date => one("SELECT * FROM enqueue_nj_pwc_daily_sync($1,'Nightly Test')", [date]);
  const poll = when => one("SELECT * FROM poll_nj_pwc_daily_sync_schedule($1)", [when]);
  const runNow = key => one("SELECT * FROM run_nj_pwc_daily_sync_now($1,NULL,'Nightly Test','test@example.invalid')", [key]);
  const finalize = (id, force = false) => one("SELECT * FROM finalize_nj_pwc_daily_run($1,$2)", [id, force]);
  const claim = (owner = worker) => one("SELECT * FROM claim_nj_pwc_request($1)", [owner]);
  const start = (id, owner = worker) => rows("SELECT start_nj_pwc_request($1,$2)", [id, owner]);
  const complete = (id, status = "No Match Found", candidates = [], owner = worker) =>
    one("SELECT complete_nj_pwc_request($1,$2,$3,$4,NULL,NULL,NULL) result", [id, owner, status, JSON.stringify(candidates)]);
  const runRequests = id => rows("SELECT * FROM compliance_sync_search_requests WHERE sync_run_id=$1 ORDER BY contractor_id", [id]);
  const register = owner => one(`SELECT report_nj_pwc_queue_worker(jsonb_build_object(
    'instance_id',$1::text,'started_at',now(),'sequence',1,'lifecycle','ready','browser_connected',true,
    'loaded_hash','fixture','current_hash','fixture')) accepted`, [owner]);
  const schedule = async (day, testMode = false) => {
    await rows(`UPDATE compliance_sync_settings SET enabled=true,daily_sync_enabled=true,mode='review_required',
      test_mode=$2,daily_sync_start_date=$1,daily_sync_time='02:00',daily_sync_timezone='America/New_York',
      daily_sync_last_scheduled_date=NULL,next_sync_at=($1::date+'02:00'::time) AT TIME ZONE 'America/New_York'
      WHERE compliance_name='NJ PWC'`, [day, testMode]);
  };
  const scenario = (name, fn) => t.test(name, async () => {
    await db.exec("BEGIN");
    try { await fn(); } finally {
      await db.exec("ROLLBACK");
    }
  });
  try {
    await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE SCHEMA auth; CREATE TABLE auth.users(id UUID PRIMARY KEY,email TEXT);
      CREATE FUNCTION auth.uid() RETURNS UUID LANGUAGE sql STABLE AS $$SELECT NULL::UUID$$;`);
    for (const name of ["20260929_user_management.sql", "20260929_user_management_enhancements.sql"])
      await db.exec(sql(name).split("INSERT INTO public.role_permissions")[0] + "\nCOMMIT;");
    for (const name of [
      "subtracker_schema.sql", "20260924_contractor_detail_enhancements.sql",
      "20261002_compliance_sync_admin.sql", "20261002_compliance_sync_rpa.sql",
      "20261002_synced_compliance_records.sql", "20261002_compliance_records_synced_status.sql",
      "20261002_nj_brc_rpa_mapping.sql", "20261002_nj_brc_test_mode.sql",
      "20261005_nj_pwc_search_requests.sql", "20261006_nj_pwc_schema_alignment.sql",
      "20261009_compliance_worker_health.sql", "20261014_nj_pwc_registry_sync_schema.sql",
      "20261014_nj_pwc_registry_sync_functions.sql", "20261015_nj_pwc_atomic_queue.sql",
      "20261016_nj_pwc_registry_match_acceptance.sql", "20261017_nj_pwc_exception_retry_lifecycle.sql",
      "20261018_active_current_registration_sync.sql", "20261019_nj_pwc_daily_sync_schedule.sql",
      "20261020_nj_pwc_graceful_stop.sql", "20261114_project_public_works.sql",
      "20261115_nj_pwc_public_works_candidates.sql", "20261118_nj_pwc_exception_select_match.sql",
    ]) {
      if (name === "20261114_project_public_works.sql") {
        await rows("INSERT INTO projects(project_number,project_name,status) VALUES('P-null','Legacy Unclassified','Active')");
      }
      await db.exec(sql(name));
    }
    await contractor("Existing preserved contractor", false);
    await rows("UPDATE compliance_sync_settings SET enabled=true,test_mode=false,mode='review_required' WHERE compliance_name='NJ PWC'");
    const changed = ["nj_pwc_daily_contractor_eligible", "nj_pwc_reconcile_monitoring_eligibility",
      "enqueue_nj_pwc_daily_sync", "run_nj_pwc_daily_sync_now", "poll_nj_pwc_daily_sync_schedule",
      "claim_nj_pwc_request", "start_nj_pwc_request", "complete_nj_pwc_request", "finalize_nj_pwc_daily_run"];
    const definitions = () => rows(`SELECT oid::text,proname,pg_get_functiondef(oid) body,proacl::text acl
      FROM pg_proc WHERE pronamespace='public'::regnamespace AND prokind='f' ORDER BY oid`);
    const baseline = await definitions();
    const tableNames = ["contractors", "projects", "contractor_projects", "compliance_records", "compliance_sync_settings",
      "compliance_sync_runs", "compliance_sync_search_requests", "compliance_sync_review_queue",
      "nj_pwc_sync_state", "nj_pwc_sync_exceptions", "administration_audit_log"];
    const dataSnapshot = async () => Object.fromEntries(await Promise.all(tableNames.map(async name =>
      [name, await rows(`SELECT to_jsonb(t) row FROM ${name} t ORDER BY to_jsonb(t)::text`)])));
    const before = await dataSnapshot();
    await db.exec(sql(migration));
    await db.exec(sql(migration));
    await t.test("migration reruns without data changes or ACL drift", async () => {
      assert.deepEqual(await dataSnapshot(), before);
      const after = await definitions();
      assert.deepEqual(after.filter(f => !changed.includes(f.proname)), baseline.filter(f => !changed.includes(f.proname)));
      assert.deepEqual(after.filter(f => baseline.some(b => b.oid === f.oid)).map(f => [f.oid, f.acl]),
        baseline.map(f => [f.oid, f.acl]));
      assert.equal(after.filter(f => baseline.some(b => b.oid === f.oid && b.body !== f.body)).length, 8);
      assert.equal(after.filter(f => !baseline.some(b => b.oid === f.oid) && changed.includes(f.proname)).length, 1);
    });
    await register(worker);
    await scenario("only contractors with an active Public Works assignment qualify", async () => {
      const eligible = await contractor("Active Public Works project");
      const noPublicWorks = await contractor("Active non-Public Works project", true, false, null, false);
      const completedPublicWorks = await contractor("Completed Public Works project", true, false, null, false);
      const inactiveAssignment = await contractor("Inactive Public Works assignment", true, false, null, false);
      const materialOnly = await contractor("Material Only", true, true, "MAT");
      const inactive = await contractor("Inactive", false);
      const blank = await contractor("");
      const whitespace = await contractor("   ");
      const numberOnly = await contractor("Number without project", true, false, "123456", false);
      const currentRecordOnly = await contractor("Current registration without project", true, false, null, false);
      const historical = await contractor("Historical registration without project", true, false, null, false);
      const noProject = await contractor("No project or registration", true, false, null, false);
      const pending = await contractor("Already pending automatic", true, false, null, false);
      const user = await contractor("Pending user search", true, false, null, false);

      const nonPublicWorksProject = (await one(`INSERT INTO projects(project_number,project_name,status,public_works)
        VALUES('NON-PW','Non-Public Works Fixture','Active',false) RETURNING id`)).id;
      const completedProject = (await one(`INSERT INTO projects(project_number,project_name,status,public_works)
        VALUES('COMPLETED-PW','Completed Public Works Fixture','Completed',true) RETURNING id`)).id;
      const activeProject = (await one(`INSERT INTO projects(project_number,project_name,status,public_works)
        VALUES('INACTIVE-ASSIGNMENT','Inactive Assignment Fixture','Active',true) RETURNING id`)).id;
      await rows("INSERT INTO contractor_projects(contractor_id,project_id,active) VALUES($1,$2,true),($3,$4,true),($5,$6,false)",
        [noPublicWorks, nonPublicWorksProject, completedPublicWorks, completedProject, inactiveAssignment, activeProject]);
      await rows(`INSERT INTO compliance_records(contractor_id,compliance_type_id,registration_number,
        expiration_date,active,is_current) VALUES($1,nj_pwc_compliance_type_id(),'654321','2020-01-01',true,true)`,
        [currentRecordOnly]);
      await rows(`INSERT INTO compliance_records(contractor_id,compliance_type_id,registration_number,active,is_current)
        VALUES($1,nj_pwc_compliance_type_id(),'OLD',false,false)`, [historical]);
      await rows(`INSERT INTO compliance_sync_search_requests(compliance_name,searched_company_name,contractor_id,status,origin,result_status)
        VALUES('NJ PWC','OLD SEARCH',$1,'failed','daily_sync','RPA Error')`, [historical]);
      await rows(`INSERT INTO compliance_sync_search_requests(compliance_name,searched_company_name,contractor_id,status,origin)
        VALUES('NJ PWC','PENDING',$1,'pending','exception_retry'),('NJ PWC','USER',$2,'pending','user')`,
        [pending, user]);

      for (const id of [eligible]) assert.equal((await one("SELECT nj_pwc_daily_contractor_eligible($1) eligible", [id])).eligible, true);
      for (const id of [noPublicWorks, completedPublicWorks, inactiveAssignment, materialOnly, inactive, blank, whitespace,
        numberOnly, currentRecordOnly, historical, noProject, pending, user]) {
        assert.equal((await one("SELECT nj_pwc_daily_contractor_eligible($1) eligible", [id])).eligible, false);
      }
      const manual = await runNow("11111111-1111-4111-8111-111111111111");
      assert.deepEqual((await runRequests(manual.run_id)).map(r => r.contractor_id), [eligible]);
      assert.equal((await one("SELECT status FROM compliance_sync_search_requests WHERE contractor_id=$1 AND origin='exception_retry'", [pending])).status,
        "cancelled", "stale pending automatic work is not searched");
      assert.equal((await one("SELECT status FROM compliance_sync_search_requests WHERE contractor_id=$1 AND origin='user'", [user])).status,
        "pending", "user searches are not governed by nightly monitoring eligibility");
      assert.equal((await one("SELECT count(*)::int n FROM compliance_records")).n, 2, "eligibility checks preserve current and historical records");
    });

    await scenario("ineligible contractors retain exceptions, cancel queued work and preserve pending expirations", async () => {
      const id = await contractor("Eligibility removed after no-match");
      const run = await enqueue("2035-01-01");
      const request = (await runRequests(run.run_id))[0];
      await rows(`INSERT INTO nj_pwc_sync_exceptions(contractor_id,reason,kind,status)
        VALUES($1,'No Match Found','failure','open')`, [id]);
      await rows(`INSERT INTO compliance_records(contractor_id,compliance_type_id,registration_number,expiration_date,active,is_current)
        VALUES($1,nj_pwc_compliance_type_id(),'998877','2099-01-01',true,true)`, [id]);
      await rows(`INSERT INTO nj_pwc_sync_state(contractor_id,is_test,state,pending_expiration_run_id)
        VALUES($1,false,'Investigation Required',$2)`, [id, run.run_id]);
      await rows("UPDATE contractor_projects SET active=false WHERE contractor_id=$1", [id]);

      assert.equal(await claim(), undefined);
      const cancelled = await one("SELECT status,sync_outcome FROM compliance_sync_search_requests WHERE id=$1", [request.id]);
      assert.equal(cancelled.status, "cancelled");
      assert.equal(cancelled.sync_outcome, "cancelled:monitoring_not_required");
      const retained = await one("SELECT status,monitoring_not_required_reason FROM nj_pwc_sync_exceptions WHERE contractor_id=$1", [id]);
      assert.equal(retained.status, "monitoring_not_required");
      assert.match(retained.monitoring_not_required_reason, /No active assignment/);
      assert.equal((await one("SELECT pending_expiration_run_id FROM nj_pwc_sync_state WHERE contractor_id=$1", [id])).pending_expiration_run_id, null);
      assert.deepEqual(await rows("SELECT registration_number,expiration_date::text,active,is_current FROM compliance_records WHERE contractor_id=$1", [id]),
        [{ registration_number: "998877", expiration_date: "2099-01-01", active: true, is_current: true }]);
      assert.equal((await one("SELECT count(*)::int n FROM administration_audit_log WHERE action LIKE 'NJ_PWC_%NOT_REQUIRED%'")).n >= 2, true);

      await rows("SELECT nj_pwc_reconcile_monitoring_eligibility()");
      assert.equal((await one("SELECT count(*)::int n FROM nj_pwc_sync_exceptions WHERE contractor_id=$1", [id])).n, 1,
        "reconciliation is idempotent and does not recreate or duplicate retained exceptions");
      assert.equal((await finalize(run.run_id)).finished, true, "a run with cancelled stale work can finalize");
      await rows("UPDATE contractor_projects SET active=true WHERE contractor_id=$1", [id]);
      assert.equal((await one("SELECT nj_pwc_daily_contractor_eligible($1) eligible", [id])).eligible, true,
        "a later qualifying project assignment restores eligibility without a flag reset");
      const next = await enqueue("2035-01-02");
      assert.deepEqual((await runRequests(next.run_id)).map(row => row.contractor_id), [id]);
      assert.equal((await one("SELECT status FROM nj_pwc_sync_exceptions WHERE contractor_id=$1", [id])).status,
        "monitoring_not_required", "re-entry preserves the historical disposition");
    });

    await scenario("claimed and in-flight automatic requests are rechecked before search and result application", async () => {
      const beforeStart = await contractor("Assignment removed before start");
      const firstRun = await enqueue("2035-01-03");
      const claimed = await claim();
      assert.equal(claimed.contractor_id, beforeStart);
      await rows("UPDATE contractor_projects SET active=false WHERE contractor_id=$1", [beforeStart]);
      await start(claimed.id);
      assert.equal((await one("SELECT status FROM compliance_sync_search_requests WHERE id=$1", [claimed.id])).status, "cancelled");
      assert.equal((await finalize(firstRun.run_id)).finished, true);

      const duringSearch = await contractor("Assignment removed during search");
      const secondRun = await enqueue("2035-01-04");
      const activeRequest = await claim();
      assert.equal(activeRequest.contractor_id, duringSearch);
      await start(activeRequest.id);
      await rows("UPDATE contractor_projects SET active=false WHERE contractor_id=$1", [duringSearch]);
      const result = await complete(activeRequest.id, "No Match Found");
      assert.equal(result.result.status, "cancelled");
      assert.equal(result.result.monitoring_not_required, true);
      assert.equal((await one("SELECT status FROM compliance_sync_search_requests WHERE id=$1", [activeRequest.id])).status, "cancelled");
      assert.equal((await one("SELECT count(*)::int n FROM nj_pwc_sync_exceptions WHERE contractor_id=$1", [duringSearch])).n, 0,
        "a stale search result cannot create a new exception");
      assert.equal((await finalize(secondRun.run_id)).finished, true);
    });
    await scenario("midnight and next 2 AM preserve pending rows; schedule skips overlap and forced finalization cannot discard them", async () => {
      await contractor("Long-running A"); await contractor("Long-running B");
      await schedule("2035-01-01");
      const run = await poll("2035-01-01T07:00:00Z");
      const original = await runRequests(run.run_id);
      assert.equal((await poll("2035-01-02T05:30:00Z")).created, false, "Midnight is not a cutoff");
      for (const force of [false, true]) {
        const f = await finalize(run.run_id, force);
        assert.equal(f.finished, false); assert.equal(f.pending, 2);
      }
      const due = await poll("2035-01-02T07:00:00Z");
      assert.equal(due.created, false); assert.equal(due.run_id, run.run_id);
      assert.match(due.skipped_reason, /run_in_progress/);
      assert.equal(new Date(due.next_sync_at).toISOString(), "2035-01-03T07:00:00.000Z");
      assert.deepEqual(await runRequests(run.run_id), original);
      assert.equal((await enqueue("2035-01-03")).run_id, run.run_id, "Direct enqueue also refuses overlap");
      assert.equal((await runNow("22222222-2222-4222-8222-222222222222")).run_id, run.run_id);
      assert.equal((await one("SELECT count(*)::int n FROM compliance_sync_runs WHERE run_status='Running'")).n, 1);
      for (let i = 0; i < 2; i++) { const request = await claim(); await start(request.id); await complete(request.id); }
      assert.equal(await claim(), undefined);
      assert.equal((await finalize(run.run_id)).finished, true);
      const after = await poll("2035-01-02T18:00:00Z");
      assert.equal(after.created, false, "No catch-up run immediately after draining");
      assert.equal((await one("SELECT count(*)::int n FROM compliance_sync_search_requests WHERE sync_run_id=$1", [run.run_id])).n, 2);
      const completedRequests = await runRequests(run.run_id);
      const next = await poll("2035-01-03T07:00:00Z");
      assert.equal(next.created, true, "Normal recurrence resumes at the next configured occurrence");
      assert.notEqual(next.run_id, run.run_id);
      assert.deepEqual(await runRequests(run.run_id), completedRequests,
        "The original completed requests are never reset or reprocessed");
    });
    await scenario("processing work survives next schedule; restart recovers ownership without replaying completed requests", async () => {
      await contractor("Completed before restart"); await contractor("In flight at restart"); await contractor("Pending through restart");
      await schedule("2035-01-01");
      const run = await poll("2035-01-01T07:00:00Z");
      const done = await claim(); await start(done.id); await complete(done.id);
      const owned = await claim(); await start(owned.id);
      assert.equal((await poll("2035-01-02T07:00:00Z")).created, false);
      assert.equal((await finalize(run.run_id, true)).finished, false);
      await rows("UPDATE nj_pwc_queue_workers SET lifecycle='stopped' WHERE instance_id=$1", [worker]);
      await rows("UPDATE compliance_sync_search_requests SET claimed_at=now()-interval '20 minutes' WHERE id=$1", [owned.id]);
      await register(restarted);
      const pending = await claim(restarted);
      assert.notEqual(pending.id, owned.id); assert.notEqual(pending.id, done.id);
      await start(pending.id, restarted); await complete(pending.id, "No Match Found", [], restarted);
      assert.equal(await claim(restarted), undefined, "Owned work is not automatically repeated after restart");
      const recovery = await one("SELECT recover_orphaned_nj_pwc_request($1,'retry',10,NULL,'Fixture','fixture@example.invalid',NULL) result", [owned.id]);
      const retried = await claim(restarted);
      assert.equal(retried.id, recovery.result.retry_request_id); assert.equal(retried.sync_run_id, run.run_id);
      assert.equal(retried.retry_of_request_id, owned.id);
      await start(retried.id, restarted); await complete(retried.id, "RPA Error", [], restarted);
      assert.equal((await one("SELECT status FROM compliance_sync_search_requests WHERE id=$1", [owned.id])).status, "failed");
      assert.equal((await one("SELECT result_status FROM compliance_sync_search_requests WHERE id=$1", [retried.id])).result_status, "RPA Error");
      assert.equal((await finalize(run.run_id)).finished, true);
      assert.equal(await claim(restarted), undefined);
    });
    await scenario("Stop Run keeps cancellation and in-flight completion semantics", async () => {
      await contractor("Stop A"); await contractor("Stop B");
      const run = await enqueue("2035-01-01");
      const inFlight = await claim(); await start(inFlight.id);
      const stop = await one("SELECT * FROM request_nj_pwc_daily_run_stop($1,NULL,'Admin','admin@example.invalid')", [run.run_id]);
      assert.equal(stop.finished, false);
      await register(restarted);
      assert.equal(await claim(restarted), undefined);
      await complete(inFlight.id);
      const f = await finalize(run.run_id);
      assert.equal(f.finished, true); assert.equal(f.run_status, "Cancelled");
      assert.equal((await runRequests(run.run_id)).filter(r => r.status === "cancelled").length, 1);
    });
    await scenario("Review Required, mismatch/multiple/no-match exceptions, technical failures and retries remain terminal outcomes", async () => {
      let day = 0;
      for (const [name, resultStatus, candidates, outcome] of [
        ["Exact Fixture", "Match Found", [{ business_name: "Exact Fixture", certificate_number: "123", registration_date: "2025-01-01", expiration_date: "2099-01-01" }], "review:"],
        ["Mismatch Fixture", "Match Found", [{ business_name: "Different Entity", certificate_number: "456", expiration_date: "2099-01-01" }], "failure:Name Mismatch"],
        ["Multiple Fixture", "Multiple Matches", [{ business_name: "First Entity", certificate_number: "111", expiration_date: "2099-01-01" },
          { business_name: "Second Entity", certificate_number: "222", expiration_date: "2099-01-01" }], "failure:Multiple Matches"],
        ["No Match Fixture", "No Match Found", [], "failure:No Match Found"],
        ["Technical Fixture", "Website Error", [], "infrastructure:"],
      ]) {
        const id = await contractor(name);
        const run = await enqueue("2035-02-" + String(++day).padStart(2, "0"));
        const request = await claim(); await start(request.id); await complete(request.id, resultStatus, candidates);
        const result = await one("SELECT * FROM compliance_sync_search_requests WHERE id=$1", [request.id]);
        assert.ok(result.sync_outcome.startsWith(outcome), `${name}: ${result.sync_outcome}`);
        assert.notEqual(result.status, "pending");
        assert.equal((await finalize(run.run_id)).finished, true);
        if (resultStatus === "No Match Found") {
          const exception = await one("SELECT id FROM nj_pwc_sync_exceptions WHERE contractor_id=$1 AND status='open'", [id]);
          const retry = await one("SELECT * FROM retry_nj_pwc_sync_exception($1,NULL,'Admin','admin@example.invalid')", [exception.id]);
          const retryRequest = await claim(); assert.equal(retryRequest.id, retry.search_request_id);
          await start(retryRequest.id); await complete(retryRequest.id);
          assert.equal((await one("SELECT status FROM nj_pwc_sync_exceptions WHERE id=$1", [exception.id])).status, "open");
        }
        await rows("UPDATE contractors SET active=false WHERE id=$1", [id]);
      }
      assert.equal((await one("SELECT count(*)::int n FROM compliance_records")).n, 0, "Review Required never applies certificates just because contractors were searched");
    });
    await scenario("606-contractor population queues and drains without a contractor batch cap", async () => {
      const projectId = (await one(`INSERT INTO projects(project_number,project_name,status,public_works)
        VALUES('POPULATION-PW','Population Public Works','Active',true) RETURNING id`)).id;
      await rows("INSERT INTO contractors(company_name,active,material_vendor_only) SELECT 'Population '||n,true,false FROM generate_series(1,606) n");
      await rows(`INSERT INTO contractor_projects(contractor_id,project_id,active)
        SELECT id,$1,true FROM contractors WHERE company_name LIKE 'Population %'`, [projectId]);
      const run = await enqueue("2035-03-01");
      assert.equal(run.enqueued, 606);
      await rows("UPDATE compliance_sync_settings SET test_mode=true WHERE compliance_name='NJ PWC'");
      assert.equal((await enqueue("2035-03-02")).run_id, run.run_id, "Test Mode change cannot start an overlapping run");
      let searched = 0;
      for (;;) {
        const request = await claim(); if (!request) break;
        await start(request.id); await complete(request.id, "RPA Error"); searched++;
      }
      assert.equal(searched, 606);
      assert.equal((await finalize(run.run_id)).finished, true);
      assert.equal((await runRequests(run.run_id)).filter(r => r.processing_at && r.completed_at).length, 606);
    });
    await scenario("competing due polls/direct enqueue/Run Now share one active run and one queue", async () => {
      await contractor("Concurrent fixture");
      await schedule("2035-04-01");
      const results = await Promise.all([
        poll("2035-04-01T06:00:00Z"),
        enqueue("2035-04-01"),
        runNow("33333333-3333-4333-8333-333333333333"),
      ]);
      assert.equal(results.filter(r => r.created).length, 1);
      const running = await rows("SELECT id FROM compliance_sync_runs WHERE run_status='Running'");
      assert.equal(running.length, 1);
      assert.equal((await runRequests(running[0].id)).length, 1);
      assert.equal(results.every(r => r.run_id === running[0].id), true);
    });
  } finally { await db.close(); }
});
