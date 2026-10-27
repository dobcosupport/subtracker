import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
const require = createRequire(import.meta.url);
const { PGlite } = require("@electric-sql/pglite");
const sql = name => fs.readFileSync(new URL("../supabase/" + name, import.meta.url), "utf8");
const migration = "20261118_nj_pwc_exception_select_match.sql";
const actor = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

test("Multiple Matches stored selection (isolated PostgreSQL only)", async t => {
  const db = await PGlite.create();
  const rows = async (q,args=[]) => (await db.query(q,args)).rows;
  const preview = async f => (await rows("SELECT get_nj_pwc_exception_candidates($1) p",[f.exception]))[0].p;
  const apply = async (f, overrides={}) => (await rows(
    "SELECT select_nj_pwc_exception_match($1,$2,$3,$4,$5,$6,'Selection Test','test@example.invalid') r",
    [overrides.exception ?? f.exception, overrides.request ?? f.request, overrides.identity ?? f.preview.candidates[0].identity,
      overrides.snapshot ?? f.preview.snapshot, overrides.confirmed ?? true, overrides.actor ?? actor]))[0].r;
  const records = f => rows("SELECT * FROM compliance_records WHERE contractor_id=$1 ORDER BY id",[f.contractor]);
  const currentCompliance = f => rows("SELECT * FROM contractor_compliance_status WHERE contractor_id=$1 AND compliance_record_id IS NOT NULL",[f.contractor]);
  const exception = async f => (await rows("SELECT * FROM nj_pwc_sync_exceptions WHERE id=$1",[f.exception]))[0];
  const approve = async result => rows("SELECT * FROM approve_nj_pwc_review($1,$2,'Selection Test','test@example.invalid','Explicit approval')",
    [result.review_queue_id,actor]);
  const state = async () => {
    const tables=["contractors","compliance_records","compliance_sync_search_requests","nj_pwc_sync_exceptions",
      "nj_pwc_sync_state","compliance_sync_runs","compliance_sync_review_queue","administration_audit_log"];
    return Object.fromEntries(await Promise.all(tables.map(async name=>[name,await rows(
      `SELECT to_jsonb(t) r FROM ${name} t ORDER BY to_jsonb(t)::text`)])));
  };
  let sequence=0;
  const fixture = async ({mode="auto_approve", candidate={}, name, duplicate=false, testMode=false}={}) => {
    const n=++sequence, company=name??`Selection Contractor ${n}`;
    await rows("UPDATE compliance_sync_settings SET enabled=TRUE,mode=$1 WHERE compliance_name='NJ PWC'",[mode]);
    const id=(await rows("INSERT INTO contractors(company_name,active) VALUES($1,TRUE) RETURNING id",[company]))[0].id;
    const selected={business_name:company,certificate_number:`CERT${n}`,registration_date:"2025-01-01",
      expiration_date:"2099-01-01",address:"PO Box 661",city:"Hawthorne",state:"NJ",zip_code:"07507",
      county:"Passaic",source_url:"https://registry.example.invalid",...candidate};
    const candidates=[selected,duplicate?selected:{...selected,business_name:"Other Company",certificate_number:`OTHER${n}`}];
    const request=(await rows(`INSERT INTO compliance_sync_search_requests(compliance_name,searched_company_name,contractor_id,
      status,result_status,candidates,origin,is_test,completed_at) VALUES('NJ PWC',$1,$2,'completed','Multiple Matches',$3,'exception_retry',$4,now()) RETURNING id`,
    [company,id,JSON.stringify(candidates),testMode]))[0].id;
    const e=(await rows(`INSERT INTO nj_pwc_sync_exceptions(contractor_id,is_test,reason,kind,last_search_request_id,consecutive_failure_count)
      VALUES($1,$2,'Multiple Matches','failure',$3,2) RETURNING id`,[id,testMode,request]))[0].id;
    await rows("INSERT INTO nj_pwc_sync_state(contractor_id,is_test,state,consecutive_failure_count) VALUES($1,$2,'Investigation Required',2)",[id,testMode]);
    const f={contractor:id,request,exception:e,candidate:selected};
    f.preview=await preview(f);return f;
  };
  try {
    await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE SCHEMA auth; CREATE TABLE auth.users(id UUID PRIMARY KEY,email TEXT);
      CREATE FUNCTION auth.uid() RETURNS UUID LANGUAGE sql STABLE AS $$SELECT NULL::UUID$$;`);
    for (const name of ["20260929_user_management.sql","20260929_user_management_enhancements.sql"])
      await db.exec(sql(name).split("INSERT INTO public.role_permissions")[0]+"\nCOMMIT;");
    for (const name of ["subtracker_schema.sql","20260924_contractor_detail_enhancements.sql",
      "20261002_compliance_sync_admin.sql","20261002_compliance_sync_rpa.sql","20261002_synced_compliance_records.sql",
      "20261002_compliance_records_synced_status.sql","20261002_nj_brc_rpa_mapping.sql","20261002_nj_brc_test_mode.sql",
      "20261005_nj_pwc_search_requests.sql","20261006_nj_pwc_schema_alignment.sql","20261009_compliance_worker_health.sql",
      "20261014_nj_pwc_registry_sync_schema.sql","20261014_nj_pwc_registry_sync_functions.sql",
      "20261015_nj_pwc_atomic_queue.sql","20261016_nj_pwc_registry_match_acceptance.sql",
      "20261017_nj_pwc_exception_retry_lifecycle.sql","20261018_active_current_registration_sync.sql",
      "20261019_nj_pwc_daily_sync_schedule.sql","20261020_nj_pwc_graceful_stop.sql"]) await db.exec(sql(name));
    await rows("INSERT INTO auth.users(id,email) VALUES($1,'test@example.invalid')",[actor]);
    await rows("INSERT INTO user_profiles(auth_user_id,name,email,role,status) VALUES($1,'Selection Test','test@example.invalid','Administrator','Active')",[actor]);
    const definitions = () => rows(`SELECT oid::text,pg_get_functiondef(oid) definition FROM pg_proc
      WHERE pronamespace='public'::regnamespace AND prokind='f'
      AND proname NOT IN ('get_nj_pwc_exception_candidates','select_nj_pwc_exception_match') ORDER BY oid`);
    const functionsBefore=await definitions();
    const retained=await state();
    await assert.rejects(db.exec(sql(migration).replace(/COMMIT;\s*$/,"SELECT 1/0; COMMIT;")),/division by zero/);
    await db.exec("ROLLBACK");
    await db.exec(sql(migration));
    await db.exec(sql(migration));
    await t.test("additive migration preserves all data and all existing functions/ACLs",async()=>{
      assert.deepEqual(await state(),retained);
      assert.deepEqual(await definitions(),functionsBefore);
      for(const role of ["anon","authenticated"]) for(const signature of [
        "get_nj_pwc_exception_candidates(integer)",
        "select_nj_pwc_exception_match(integer,integer,text,text,boolean,uuid,text,text)"]) {
        assert.equal((await rows("SELECT has_function_privilege($1,$2,'EXECUTE') permitted",[role,signature]))[0].permitted,false);
      }
    });
    await t.test("Mechanical Associates #684 / request #3626 shape retains NJ versus New Jersey safeguard",async()=>{
      await rows("ALTER SEQUENCE contractors_id_seq RESTART WITH 684");
      await rows("ALTER SEQUENCE compliance_sync_search_requests_id_seq RESTART WITH 3626");
      const f=await fixture({mode:"review_required",name:"Mechanical Associates of NJ",
        candidate:{business_name:"Mechanical Associates of New Jersey",certificate_number:"644541",registration_date:"2026-05-11",expiration_date:"2028-05-10"}});
      assert.equal(f.contractor,684);assert.equal(f.request,3626);
      assert.equal(f.preview.candidates.length,2);
      const beforeName=(await rows("SELECT company_name FROM contractors WHERE id=$1",[f.contractor]))[0].company_name;
      const result=await apply(f);
      assert.equal(result.approval,"review_required");assert.equal(result.review_reason,"Name Mismatch");
      assert.equal((await records(f)).length,0);
      assert.equal((await exception(f)).status,"open");
      assert.equal((await exception(f)).review_queue_id,result.review_queue_id);
      const beforeReplay=await state();
      assert.equal((await apply(f)).already_processed,true);
      assert.deepEqual(await state(),beforeReplay);
      await assert.rejects(apply(f,{identity:f.preview.candidates[1].identity}),/already been imported/);
      await approve(result);
      assert.equal((await records(f))[0].registration_number,"644541");
      assert.equal((await exception(f)).status,"resolved");
      assert.equal((await rows("SELECT company_name FROM contractors WHERE id=$1",[f.contractor]))[0].company_name,beforeName);
      const auto=await fixture({name:"Mechanical Associates of NJ",candidate:{
        business_name:"Mechanical Associates of New Jersey",certificate_number:"644541",registration_date:"2026-05-11",expiration_date:"2028-05-10"}});
      assert.equal((await apply(auto)).review_reason,"Name Mismatch","Even Auto Approve must preserve NJ versus New Jersey review");
    });
    await t.test("safe selection applies current record and closes only through success helpers; replay is a receipt",async()=>{
      const f=await fixture(), result=await apply(f), record=(await records(f))[0];
      assert.equal(result.record_action,"created");
      assert.equal(record.active,true);assert.equal(record.is_current,true);
      assert.equal(record.sync_status,"Approved");assert.equal(record.registry_status,"OK");
      assert.equal(record.registration_number,f.candidate.certificate_number);
      assert(record.last_registry_sync_at && record.synced_last_verified_at && record.source_url && record.sync_run_id);
      assert.equal((await currentCompliance(f)).find(row=>row.compliance_name==="NJ PWC").compliance_record_id,record.id);
      assert.equal((await exception(f)).status,"resolved");
      const before=await state();assert.equal((await apply(f)).already_processed,true);assert.deepEqual(await state(),before);
      await assert.rejects(apply(f,{snapshot:"0".repeat(32)}),/no longer an open/);
    });
    await t.test("Review Required is not bypassed for an otherwise valid selected candidate",async()=>{
      const f=await fixture({mode:"review_required"}), result=await apply(f);
      assert.equal(result.review_reason,"Review Required Mode");assert.equal((await records(f)).length,0);
      assert.equal((await exception(f)).status,"open");
    });
    await t.test("anomaly, expired, mismatch, conflicting certificate remain Review outcomes",async()=>{
      for(const [changes,reason] of [[{registration_date:"invalid"},"Registry Anomaly"],
        [{registration_date:"2019-01-01",expiration_date:"2020-01-01"},"Expired Registration"],[{business_name:"Different Entity"},"Name Mismatch"]]) {
        const f=await fixture({candidate:changes});const result=await apply(f);
        assert.equal(result.review_reason,reason);assert.equal((await records(f)).length,0);assert.equal((await exception(f)).status,"open");
      }
      const f=await fixture();
      await rows("SELECT * FROM nj_pwc_apply_certificate($1,$2,'Test','Fixture',NULL,'Fixture')",
        [f.contractor,JSON.stringify({...f.candidate,certificate_number:"OLD"})]);
      f.preview=await preview(f);
      const result=await apply(f);
      assert.equal(result.review_reason,"Certificate Changed");
      await approve(result);
      const history=await records(f);assert.equal(history.length,2);
      assert.equal(history.filter(r=>r.active&&r.is_current).length,1);
      assert.equal(history[0].registration_number,"OLD");assert.equal(history[0].is_current,false);
      const current=(await currentCompliance(f)).filter(row=>row.compliance_name==="NJ PWC");
      assert.equal(current.length,1);assert.equal(current[0].compliance_record_id,history[1].id);
    });
    await t.test("same certificate/dates refresh, changed dates retain Compliance History",async()=>{
      const f=await fixture();
      await rows("SELECT * FROM nj_pwc_apply_certificate($1,$2,'Test','Fixture',NULL,'Fixture')",[f.contractor,JSON.stringify(f.candidate)]);
      f.preview=await preview(f);assert.equal((await apply(f)).record_action,"refreshed");assert.equal((await records(f)).length,1);
      const g=await fixture();
      await rows("SELECT * FROM nj_pwc_apply_certificate($1,$2,'Test','Fixture',NULL,'Fixture')",
        [g.contractor,JSON.stringify({...g.candidate,expiration_date:"2098-01-01"})]);
      g.preview=await preview(g);assert.equal((await apply(g)).record_action,"versioned");
      assert.equal((await records(g)).length,2);
    });
    await t.test("stale request, exception, contractor, current record and candidate changes reject atomically",async()=>{
      for(const change of [
        f=>rows("UPDATE contractors SET company_name='Changed' WHERE id=$1",[f.contractor]),
        f=>rows("UPDATE nj_pwc_sync_exceptions SET status='resolved' WHERE id=$1",[f.exception]),
        f=>rows("UPDATE compliance_sync_search_requests SET status='processing' WHERE id=$1",[f.request]),
        f=>rows("UPDATE compliance_sync_search_requests SET candidates=jsonb_set(candidates,'{0,address}','\"Altered\"') WHERE id=$1",[f.request]),
        f=>rows("INSERT INTO compliance_records(contractor_id,compliance_type_id,registration_number,active,is_current) VALUES($1,nj_pwc_compliance_type_id(),'OTHER',true,true)",[f.contractor]),
      ]) {
        const f=await fixture();await change(f);const before=await state();
        await assert.rejects(apply(f),/changed|open Multiple Matches|missing/);assert.deepEqual(await state(),before);
      }
      const f=await fixture();await rows(`INSERT INTO compliance_sync_search_requests(compliance_name,searched_company_name,contractor_id,status,origin)
        VALUES('NJ PWC','New search',$1,'pending','exception_retry')`,[f.contractor]);
      await assert.rejects(apply(f),/Latest registry request changed/);
      await assert.rejects(apply(f,{request:f.request+1}),/latest request changed/);
    });
    await t.test("missing, identical duplicate and distinct rows sharing a certificate are rejected",async()=>{
      const f=await fixture();await assert.rejects(apply(f,{identity:"0".repeat(32)}),/missing or duplicated/);
      const g=await fixture({duplicate:true});await assert.rejects(apply(g),/missing or duplicated/);
      const h=await fixture();
      await rows("UPDATE compliance_sync_search_requests SET candidates=jsonb_set(candidates,'{1,certificate_number}',to_jsonb($2::text)) WHERE id=$1",[h.request,h.candidate.certificate_number]);
      h.preview=await preview(h);await assert.rejects(apply(h),/certificate is not unique/);
      await assert.rejects(apply(f,{confirmed:false}),/explicit confirmation/);
    });
    await t.test("settings, request binding, inactive contractors and reason changes cannot authorize a stale selection",async()=>{
      for (const change of [
        ()=>rows("UPDATE compliance_sync_settings SET mode='review_required' WHERE compliance_name='NJ PWC'"),
        ()=>rows("UPDATE compliance_sync_settings SET enabled=FALSE WHERE compliance_name='NJ PWC'"),
        f=>rows("UPDATE contractors SET active=FALSE WHERE id=$1",[f.contractor]),
        f=>rows("UPDATE nj_pwc_sync_exceptions SET reason='No Match Found' WHERE id=$1",[f.exception]),
        f=>rows("UPDATE compliance_sync_search_requests SET contractor_id=NULL WHERE id=$1",[f.request]),
        f=>rows("UPDATE compliance_sync_search_requests SET is_test=TRUE WHERE id=$1",[f.request]),
      ]) {
        const f=await fixture();await change(f);const before=await state();
        await assert.rejects(apply(f),/changed|inactive/);assert.deepEqual(await state(),before);
      }
    });
    await t.test("simultaneously submitted identical selections apply once; different actor cannot replay the receipt",async()=>{
      const f=await fixture(),results=await Promise.all([apply(f),apply(f)]);
      assert.equal(results.filter(r=>r.already_processed===true).length,1);
      assert.equal((await records(f)).length,1);
      assert.equal((await rows("SELECT count(*)::int n FROM administration_audit_log WHERE action='NJ_PWC_EXCEPTION_MATCH_SELECTED' AND object_id=$1",[String(f.contractor)]))[0].n,1);
      await assert.rejects(apply(f,{actor:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"}),/no longer an open/);
    });
    await t.test("explicit Test Mode result selection remains a warned live import and preserves review closure",async()=>{
      const f=await fixture({testMode:true});
      assert.equal(f.preview.is_test,true);
      await apply(f);assert.equal((await exception(f)).status,"resolved");assert.equal((await records(f)).length,1);
      const g=await fixture({testMode:true,mode:"review_required"});
      const result=await apply(g);assert.equal((await exception(g)).status,"open");
      await approve(result);assert.equal((await exception(g)).status,"resolved");
    });
    await t.test("final audit failure rolls back application, request linkage, exception, reviews and state",async()=>{
      const f=await fixture();const before=await state();
      await db.exec("ALTER TABLE administration_audit_log ADD CONSTRAINT fixture_selection_fail CHECK(action<>'NJ_PWC_EXCEPTION_MATCH_SELECTED') NOT VALID");
      await assert.rejects(apply(f),/fixture_selection_fail/);
      assert.deepEqual(await state(),before);
      await db.exec("ALTER TABLE administration_audit_log DROP CONSTRAINT fixture_selection_fail");
      await apply(f);
    });
  } finally {await db.close();}
});
