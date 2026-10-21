import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { PGlite } = require("@electric-sql/pglite");
const sql = (name) => fs.readFileSync(new URL(`../supabase/${name}`, import.meta.url), "utf8");
const actor = "00000000-0000-0000-0000-000000000001";
const db = await PGlite.create();
const rows = async (query, args = []) => (await db.query(query, args)).rows;
try {
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY,email text);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
      $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;`);
  for (const name of ["20260929_user_management.sql","20260929_user_management_enhancements.sql"]) {
    await db.exec(sql(name).split("INSERT INTO public.role_permissions")[0] + "\nCOMMIT;");
  }
  const permissions=sql("20260929_user_management_enhancements.sql");
  const permissionStart=permissions.indexOf("CREATE OR REPLACE FUNCTION public.user_has_module_permission");
  await db.exec(permissions.slice(permissionStart,permissions.indexOf("$$;",permissionStart)+3));
  for (const name of [
    "subtracker_schema.sql","20260924_contractor_detail_enhancements.sql","20260925_contractor_tiered_subs.sql",
    "20261002_compliance_sync_admin.sql","20261002_compliance_sync_rpa.sql",
    "20261002_synced_compliance_records.sql","20261002_compliance_records_synced_status.sql",
    "20261002_nj_brc_rpa_mapping.sql","20261002_nj_brc_test_mode.sql",
    "20261005_nj_pwc_search_requests.sql","20261006_nj_pwc_schema_alignment.sql","20261006_add_contractor_county.sql",
    "20261009_contractor_federal_tax_id.sql","20261009_compliance_worker_health.sql","20261009_nj_brc_worker.sql",
    "20261014_nj_pwc_registry_sync_schema.sql","20261014_nj_pwc_registry_sync_functions.sql",
    "20261015_nj_pwc_atomic_queue.sql","20261016_nj_pwc_registry_match_acceptance.sql",
    "20261017_nj_pwc_exception_retry_lifecycle.sql",
    "20261018_active_current_registration_sync.sql",
    "20261019_nj_pwc_daily_sync_schedule.sql","20261020_nj_pwc_graceful_stop.sql",
  ]) await db.exec(sql(name));
  await rows("INSERT INTO auth.users VALUES($1,'admin@example.invalid')",[actor]);
  await rows("INSERT INTO user_profiles(auth_user_id,name,email,role,status,system_administrator) VALUES($1,'Synthetic Admin','admin@example.invalid','Administrator','Active',true)",[actor]);
  const before = await rows("SELECT oid::regprocedure::text signature,pg_get_functiondef(oid) definition FROM pg_proc WHERE proname IN ('submit_nj_pwc_sync_result','nj_pwc_apply_certificate','approve_nj_brc_search_request','report_nj_brc_search_result')");
  const migration = sql("20261105_administrative_registration_unlink.sql");
  await assert.rejects(db.exec(migration.replace(/COMMIT;\s*$/, "SELECT 1/0; COMMIT;")), /division by zero/);
  await db.exec("ROLLBACK");
  assert.equal((await rows("SELECT to_regclass('compliance_record_unlinks') value"))[0].value,null);
  await db.exec(migration);
  assert.deepEqual(await rows("SELECT oid::regprocedure::text signature,pg_get_functiondef(oid) definition FROM pg_proc WHERE proname IN ('submit_nj_pwc_sync_result','nj_pwc_apply_certificate','approve_nj_brc_search_request','report_nj_brc_search_result')"),before,
    "Worker and approval implementations are unchanged; registration guard covers all writers");
  const type = Object.fromEntries((await rows("SELECT id,compliance_name FROM compliance_types")).map(r=>[r.compliance_name,r.id]));
  const company = async (name) => (await rows("INSERT INTO contractors(company_name,notes,nj_brc_number) VALUES($1,'UNCHANGED','LEGACY') RETURNING id",[name]))[0].id;
  const record = async (id,kind,number,overrides={}) => (await rows(`INSERT INTO compliance_records(contractor_id,compliance_type_id,registration_number,
    effective_date,expiration_date,matched_company_name,active,is_current) VALUES($1,$2,$3,'2025-01-01',$4,$5,$6,$7) RETURNING *`,
    [id,type[kind],number,kind==="NJ BRC"?null:"2099-12-31",overrides.name??"Synthetic Registry Company",overrides.active??true,overrides.current??true]))[0];
  const unlink = async (id,rec,kind,overrides={}) => {
    const c=(await rows("SELECT * FROM contractors WHERE id=$1",[id]))[0];
    return (await rows("SELECT unlink_contractor_registration($1,$2,$3,$4,$5,$6,$7,$8) result",
      [id,rec.id,kind,overrides.updated??rec.updated_at,kind==="NJ PWC"?c.nj_pwc_number:c.nj_brc_number,
        overrides.reason??"Confirmed incorrect relationship",overrides.confirmed??true,overrides.actor??actor]))[0].result;
  };
  const c=await company("Synthetic Unlink PWC");
  const first=await record(c,"NJ PWC","PWC1");
  const second=await record(c,"NJ PWC","PWC2");
  await assert.rejects(unlink(c,second,"NJ PWC",{reason:" \t\n "}),/non-blank/);
  await assert.rejects(unlink(c,second,"NJ PWC",{confirmed:false}),/confirmation/);
  await assert.rejects(unlink(c,second,"NJ PWC",{updated:"2000-01-01"}),/changed/);
  await assert.rejects(unlink(c,second,"NJ PWC",{actor:"00000000-0000-0000-0000-000000000099"}),/permission/);
  await db.exec("ALTER TABLE administration_audit_log ADD CONSTRAINT fail_unlink CHECK(action<>'COMPLIANCE_RECORD_UNLINKED') NOT VALID");
  await assert.rejects(unlink(c,second,"NJ PWC"),/fail_unlink/);
  assert.equal((await rows("SELECT active FROM compliance_records WHERE id=$1",[second.id]))[0].active,true);
  assert.equal((await rows("SELECT count(*)::int n FROM compliance_record_unlinks"))[0].n,0);
  assert.equal((await rows("SELECT nj_pwc_number FROM contractors WHERE id=$1",[c]))[0].nj_pwc_number,"PWC2");
  await db.exec("ALTER TABLE administration_audit_log DROP CONSTRAINT fail_unlink");
  const result=await unlink(c,second,"NJ PWC");
  assert.equal(result.resulting_identifier,"PWC1");
  assert.equal(result.previous_identifier,"PWC2");
  assert.equal(result.replacement_record_id,first.id);
  assert.equal(result.missing_information,false);
  assert.equal(result.record_company_name,"Synthetic Registry Company");
  assert.equal(result.administrator_id,actor);
  await assert.rejects(rows("UPDATE compliance_records SET registration_number='CHANGED HISTORY' WHERE id=$1",[second.id]),/administratively unlinked/);
  assert.equal((await rows("SELECT active,is_current,contractor_id FROM compliance_records WHERE id=$1",[second.id]))[0].contractor_id,c);
  await assert.rejects(unlink(c,second,"NJ PWC"),/already unlinked/);
  await assert.rejects(record(c,"NJ PWC","pwc-2"),/excluded/);
  await assert.rejects(rows("UPDATE compliance_records SET active=true,is_current=true WHERE id=$1",[second.id]),/administratively unlinked/);
  await assert.rejects(rows("SELECT * FROM nj_pwc_apply_certificate($1,$2,'Worker','NJ PWC Registry',NULL,NULL)",
    [c,JSON.stringify({certificate_number:"PWC2",business_name:"Synthetic Registry Company",expiration_date:"2099-12-31"})]),/excluded/);
  assert.equal((await rows("SELECT active FROM compliance_records WHERE id=$1",[first.id]))[0].active,true,"Blocked worker transaction rolls back deactivation");
  const removed=await unlink(c,first,"NJ PWC");
  assert.equal(removed.resulting_identifier,null);
  assert.equal(removed.missing_information,true);
  assert.equal((await rows("SELECT count(*)::int n FROM contractor_compliance_status WHERE contractor_id=$1 AND compliance_name='NJ PWC'",[c]))[0].n,0,
    "Actual dashboard view has no current PWC record, enabling the derived Missing Information item");
  const corrected=await record(c,"NJ PWC","CORRECTED");
  assert.equal((await rows("SELECT nj_pwc_number,notes,nj_brc_number FROM contractors WHERE id=$1",[c]))[0].nj_pwc_number,"CORRECTED","Normal rescan/import sync still works");
  assert.equal((await rows("SELECT calculated_status FROM contractor_compliance_status WHERE contractor_id=$1 AND compliance_name='NJ PWC'",[c]))[0].calculated_status,"Active",
    "Normal corrected registration restores the real dashboard view");
  const other=await company("Unrelated Company");
  await record(other,"NJ PWC","PWC2");
  assert.equal((await rows("SELECT nj_pwc_number FROM contractors WHERE id=$1",[other]))[0].nj_pwc_number,"PWC2","No global registration block");
  const brc=await record(c,"NJ BRC","BRC1");
  const brc2=await record(c,"NJ BRC","BRC2");
  assert.equal((await unlink(c,brc2,"NJ BRC")).resulting_identifier,"BRC1");
  assert.equal((await unlink(c,brc,"NJ BRC")).resulting_identifier,null);
  await assert.rejects(record(c,"NJ BRC","BRC2"),/excluded/);
  await record(c,"NJ BRC","BRC-CORRECT");
  assert.equal((await rows("SELECT expiration_date FROM compliance_records WHERE contractor_id=$1 AND active AND compliance_type_id=$2",[c,type["NJ BRC"]]))[0].expiration_date,null);
  const stale=await record(other,"NJ BRC","STALE",{active:false,current:false});
  await rows("UPDATE contractors SET nj_brc_number='STALE' WHERE id=$1",[other]);
  assert.equal((await unlink(other,stale,"NJ BRC")).resulting_identifier,null,"Inactive historical selection repairs stale card identifier");
  assert.equal((await rows("SELECT notes FROM contractors WHERE id=$1",[c]))[0].notes,"UNCHANGED");
  assert.equal((await rows("SELECT count(*)::int n FROM compliance_records"))[0].n,8,"No registration history deleted");
  assert.equal((await rows("SELECT count(*)::int n FROM activity_log WHERE activity_type='Compliance Record Unlinked'"))[0].n,5);
  const audit=(await rows("SELECT details FROM administration_audit_log WHERE action='COMPLIANCE_RECORD_UNLINKED' ORDER BY id LIMIT 1"))[0].details;
  for(const field of ["contractor_id","contractor_name","compliance_type","compliance_record_id","identifier_removed","record_company_name","previous_identifier","resulting_identifier","reason","administrator_id","timestamp","missing_information","replacement_record_id","another_record_selected"]) assert.ok(field in audit,field);
  await rows("SELECT set_config('request.jwt.claim.sub',$1,false)",[actor]);
  await db.exec(`INSERT INTO role_permissions(role,module,can_view,can_add,can_edit,can_delete,can_manage)
    VALUES('Administrator','compliance_sync',true,true,true,true,true) ON CONFLICT(role,module)
    DO UPDATE SET can_view=true,can_add=true,can_edit=true,can_delete=true,can_manage=true`);
  await rows("UPDATE contractors SET federal_tax_id='000000001',brc_name_control='SYNT' WHERE id=$1",[c]);
  const pending=(await rows(`INSERT INTO nj_brc_search_requests(contractor_id,company_name,brc_name_control,
    federal_tax_id,taxpayer_id_submission,status,claim_worker_key,worker_instance_id)
    VALUES($1,'Synthetic Unlink PWC','SYNT','000000001','000000001000','claimed','nj-brc',$2) RETURNING id`,[c,actor]))[0];
  await rows("SELECT * FROM report_nj_brc_search_result($1,$2,'successful_certificate',$3::jsonb)",[pending.id,actor,
    JSON.stringify({taxpayer_name:"Synthetic Unlink PWC",certificate_number:"BRC2",effective_date:"2025-01-01",
      source_url:"https://www1.state.nj.us/TYTR_BRC/jsp/BRCLoginJsp.jsp",match_rationale:"Synthetic identity match"})]);
  await assert.rejects(rows("SELECT approve_nj_brc_search_request($1,'Previously pending incorrect certificate')",[pending.id]),/excluded/);
  assert.equal((await rows("SELECT status FROM nj_brc_search_requests WHERE id=$1",[pending.id]))[0].status,"review_required",
    "Blocked BRC approval preserves the review instead of recording false success");
  assert.equal((await rows("SELECT registration_number FROM compliance_records WHERE contractor_id=$1 AND compliance_type_id=$2 AND active AND is_current",
    [c,type["NJ BRC"]]))[0].registration_number,"BRC-CORRECT","Blocked approval rolls back deactivation of the valid BRC");
  const orderingCompany=await company("Deterministic Current Record Selection");
  const a=await record(orderingCompany,"NJ PWC","ORDER-A");
  const b=await record(orderingCompany,"NJ PWC","ORDER-B");
  const newest=await record(orderingCompany,"NJ PWC","ORDER-C");
  await rows("UPDATE compliance_records SET updated_at='2025-01-01' WHERE id=$1",[b.id]);
  await rows("UPDATE compliance_records SET updated_at='2025-02-01' WHERE id=$1",[a.id]);
  const workerSnapshot=await record(orderingCompany,"NJ BRC","BRC-WORKER");
  await rows("UPDATE compliance_records SET verified_date='2026-10-20',updated_at=updated_at+interval '1 second' WHERE id=$1",[workerSnapshot.id]);
  await assert.rejects(unlink(orderingCompany,workerSnapshot,"NJ BRC"),/changed/,
    "Worker update invalidates administrator snapshot before unlink");
  await db.exec("ALTER TABLE activity_log ADD CONSTRAINT fail_unlink_activity CHECK(activity_type<>'Compliance Record Unlinked') NOT VALID");
  const auditsBefore=(await rows("SELECT count(*)::int n FROM administration_audit_log"))[0].n;
  await assert.rejects(unlink(orderingCompany,newest,"NJ PWC"),/fail_unlink_activity/);
  assert.equal((await rows("SELECT count(*)::int n FROM administration_audit_log"))[0].n,auditsBefore,
    "Activity failure rolls back administration audit too");
  assert.equal((await rows("SELECT active FROM compliance_records WHERE id=$1",[newest.id]))[0].active,true);
  await db.exec("ALTER TABLE activity_log DROP CONSTRAINT fail_unlink_activity");
  assert.equal((await unlink(orderingCompany,newest,"NJ PWC")).replacement_record_id,a.id,
    "Latest updated_at wins over a larger legacy record ID");
  await db.exec("SET ROLE authenticated");
  await assert.rejects(rows("SELECT unlink_contractor_registration(1,1,'NJ PWC',now(),NULL,'reason',true,$1)",[actor]),/permission denied/);
  await assert.rejects(db.exec("INSERT INTO compliance_record_unlinks(record_id) VALUES(999)"),/permission denied/);
  await db.exec("RESET ROLE");
  assert.ok(corrected.id>0);
  console.log("PASS: migration atomicity; admin/confirmation/reason/stale-snapshot gates; selected-only non-destructive unlink; deterministic replacement and stale identifier clearing; complete audit/activity; audit rollback; excluded worker/manual reattachment denied; corrected identities and unrelated contractors allowed; NJ BRC non-expiring; existing worker function bodies unchanged");
} catch(error) {
  console.error("FAIL:",error.message,error.code??"",error.where??"");
  process.exitCode=1;
} finally { await db.close(); }
