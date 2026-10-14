import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";

const require = createRequire(import.meta.url);
const { PGlite } = require(process.env.PGLITE_MODULE || "@electric-sql/pglite");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "supabase");
const sql = name => fs.readFileSync(path.join(root, name), "utf8");

test("NJ PWC user-confirmed registry match acceptance", async t => {
  const db = await PGlite.create();
  const rows = async (query,args=[]) => (await db.query(query,args)).rows;
  const preview = async id => (await rows("SELECT get_nj_pwc_registry_match($1) AS p",[id]))[0].p;
  const accept = async (fixture,fields=["company_name"],snapshot=fixture.preview.snapshot) =>
    (await rows("SELECT accept_nj_pwc_registry_match($1,$2,$3,TRUE,NULL,'Acceptance Test User','user@example.test') AS r",
      [fixture.exceptionId,snapshot,fields]))[0].r;
  let importerBefore;
  let sequence=0;
  const fixture = async ({mode="auto_approve",isTest=false,known=true,conflict=false,expired=false,anomaly=false,unit=false}={}) => {
    sequence++;
    await rows("UPDATE compliance_sync_settings SET enabled=TRUE,mode=$1 WHERE compliance_name='NJ PWC'",[mode]);
    const cert=`CERT${sequence}`;
    const c=(await rows(`INSERT INTO contractors(company_name,address_1,city,state,zip_code,nj_pwc_number,county,
      nj_brc_number,brc_name_control,sage_erp_id,ny_pwc_number,ny_brc_number)
      VALUES($1,'12 Main Street','Newton','NJ','07860',$2,'Existing County','BRC-KEEP','KEEP','SAGE-KEEP','NY-PWC-KEEP','NY-BRC-KEEP')
      RETURNING *`,[`Contractor Quality ${sequence}`,known?cert:null]))[0];
    const candidate={
      business_name:`Registry Quality ${sequence}, Inc.`,certificate_number:cert,
      address:unit?"12 Main St Suite 4":conflict?"99 Different Road":"12 Main St",
      city:"Newton",state:"NJ",zip_code:"07860-1234",county:"Registry County",
      registration_date:"2025-01-01",expiration_date:expired?"2020-01-01":"2099-01-01",
    };
    if(anomaly) candidate.registration_date="not-a-date";
    const request=(await rows(`INSERT INTO compliance_sync_search_requests(compliance_name,searched_company_name,
      contractor_id,status,result_status,candidates,is_test,origin,completed_at)
      VALUES('NJ PWC',$1,$2,'completed','Match Found',$3,$4,'daily_sync',now()) RETURNING id`,
      [c.company_name,c.id,JSON.stringify([candidate]),isTest]))[0];
    const exception=(await rows(`INSERT INTO nj_pwc_sync_exceptions(contractor_id,is_test,reason,kind,last_search_request_id,
      consecutive_failure_count) VALUES($1,$2,'Name Mismatch','failure',$3,2) RETURNING id`,[c.id,isTest,request.id]))[0];
    await rows("INSERT INTO nj_pwc_sync_state(contractor_id,is_test,consecutive_failure_count,state) VALUES($1,FALSE,2,'Investigation Required')",[c.id]);
    if(isTest) await rows("INSERT INTO nj_pwc_sync_state(contractor_id,is_test,consecutive_failure_count,state,dry_run_action) VALUES($1,TRUE,2,'Investigation Required','would_expire')",[c.id]);
    return {contractor:c,candidate,requestId:request.id,exceptionId:exception.id,preview:await preview(exception.id)};
  };
  try {
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE SCHEMA auth; CREATE TABLE auth.users(id UUID PRIMARY KEY,email TEXT);
      CREATE FUNCTION auth.uid() RETURNS UUID LANGUAGE sql STABLE AS $$ SELECT NULL::UUID $$;
    `);
    for(const name of ["20260929_user_management.sql","20260929_user_management_enhancements.sql"]) {
      await db.exec(sql(name).split("INSERT INTO public.role_permissions")[0]+"\nCOMMIT;");
    }
    for(const name of [
      "subtracker_schema.sql","20260924_contractor_detail_enhancements.sql","20260925_contractor_tiered_subs.sql",
      "20261002_compliance_sync_admin.sql","20261002_compliance_sync_rpa.sql",
      "20261002_synced_compliance_records.sql","20261002_compliance_records_synced_status.sql",
      "20261002_nj_brc_rpa_mapping.sql","20261002_nj_brc_test_mode.sql",
      "20261005_nj_pwc_search_requests.sql","20261006_nj_pwc_schema_alignment.sql",
      "20261006_add_contractor_county.sql",
      "20261014_nj_pwc_registry_sync_schema.sql","20261014_nj_pwc_registry_sync_functions.sql",
    ]) await db.exec(sql(name));
    importerBefore=(await rows(`SELECT pg_get_functiondef(p.oid) AS definition,p.proowner::TEXT AS owner,
      p.proacl::TEXT AS acl,pg_get_function_result(p.oid) AS result,l.lanname AS language,p.prosecdef AS security_definer
      FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang
      WHERE p.oid='public.import_nj_pwc_candidate(integer,integer,text,uuid,text,text)'::regprocedure`))[0];
    await db.exec(sql("20261016_nj_pwc_registry_match_acceptance.sql"));

    await t.test("stable preflight preserves the importer contract and creates both UI RPCs",async()=>{
      const after=(await rows(`SELECT pg_get_functiondef(p.oid) AS definition,p.proowner::TEXT AS owner,
        p.proacl::TEXT AS acl,pg_get_function_result(p.oid) AS result,l.lanname AS language,p.prosecdef AS security_definer
        FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang
        WHERE p.oid='public.import_nj_pwc_candidate(integer,integer,text,uuid,text,text)'::regprocedure`))[0];
      assert.deepEqual(after,importerBefore);
      assert.equal(after.result,"TABLE(sync_run_id integer, review_queue_id integer, approval text, review_reason text, compliance_record_id integer, record_action text)");
      assert.equal(after.language,"plpgsql"); assert.equal(after.security_definer,true);
      assert.deepEqual((await rows(`SELECT array_agg(format_type(a.type_oid,NULL) ORDER BY a.ordinality) AS types
        FROM pg_proc p CROSS JOIN LATERAL unnest(p.proargtypes) WITH ORDINALITY AS a(type_oid,ordinality)
        WHERE p.oid='public.import_nj_pwc_candidate(integer,integer,text,uuid,text,text)'::regprocedure`))[0].types,
        ["integer","integer","text","uuid","text","text"]);
      for(const signature of [
        "public.get_nj_pwc_registry_matches(integer[])",
        "public.accept_nj_pwc_registry_match(integer,text,text[],boolean,uuid,text,text)",
      ]) assert.equal((await rows("SELECT to_regprocedure($1) IS NOT NULL AS exists",[signature]))[0].exists,true,signature);
    });
    await t.test("migration reruns idempotently and does not change importer or daily classifier",async()=>{
      const before=(await rows("SELECT pg_get_functiondef('nj_pwc_classify_sync_result(text,text[],text,jsonb)'::regprocedure) AS d"))[0].d;
      await db.exec(sql("20261016_nj_pwc_registry_match_acceptance.sql"));
      assert.equal((await rows("SELECT pg_get_functiondef('nj_pwc_classify_sync_result(text,text[],text,jsonb)'::regprocedure) AS d"))[0].d,before);
      assert.deepEqual((await rows(`SELECT pg_get_functiondef(p.oid) AS definition,p.proowner::TEXT AS owner,
        p.proacl::TEXT AS acl,pg_get_function_result(p.oid) AS result,l.lanname AS language,p.prosecdef AS security_definer
        FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang
        WHERE p.oid='public.import_nj_pwc_candidate(integer,integer,text,uuid,text,text)'::regprocedure`))[0],importerBefore);
    });
    await t.test("incompatible importer signatures or result types fail before creating migration objects",async()=>{
      for(const testCase of [
        {definition:`CREATE FUNCTION public.import_nj_pwc_candidate(bigint,integer,text,uuid,text,text) RETURNS TEXT LANGUAGE sql SECURITY DEFINER AS $$ SELECT 'wrong overload' $$;`,error:/Expected public\.import_nj_pwc_candidate/},
        {definition:`CREATE FUNCTION public.import_nj_pwc_candidate(integer,integer,text,uuid,text,text) RETURNS TEXT LANGUAGE sql SECURITY DEFINER AS $$ SELECT 'wrong result' $$;`,error:/result structure is incompatible/},
        {definition:`CREATE FUNCTION public.import_nj_pwc_candidate(integer,integer,text,uuid,text,text) RETURNS TABLE(sync_run_id integer,review_queue_id integer,approval text,review_reason text,compliance_record_id integer,record_action text) LANGUAGE plpgsql SECURITY INVOKER AS $$ BEGIN RETURN; END $$;`,error:/must remain a PL\/pgSQL SECURITY DEFINER/},
        {definition:`CREATE ROLE untrusted_import_owner; GRANT CREATE ON SCHEMA public TO untrusted_import_owner; SET ROLE untrusted_import_owner; CREATE FUNCTION public.import_nj_pwc_candidate(integer,integer,text,uuid,text,text) RETURNS TABLE(sync_run_id integer,review_queue_id integer,approval text,review_reason text,compliance_record_id integer,record_action text) LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN RETURN; END $$; RESET ROLE; GRANT EXECUTE ON FUNCTION public.import_nj_pwc_candidate(integer,integer,text,uuid,text,text) TO service_role; REVOKE ALL ON FUNCTION public.import_nj_pwc_candidate(integer,integer,text,uuid,text,text) FROM PUBLIC,anon,authenticated;`,error:/untrusted or unexpected owner/},
        {definition:`CREATE FUNCTION public.import_nj_pwc_candidate(integer,integer,text,uuid,text,text) RETURNS TABLE(sync_run_id integer,review_queue_id integer,approval text,review_reason text,compliance_record_id integer,record_action text) LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN RETURN; END $$; REVOKE ALL ON FUNCTION public.import_nj_pwc_candidate(integer,integer,text,uuid,text,text) FROM PUBLIC,anon,authenticated,service_role;`,error:/executable only by the trusted server role/},
      ]) {
        const incompatible=await PGlite.create();
        try {
          await incompatible.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; ${testCase.definition}`);
          await assert.rejects(incompatible.exec(sql("20261016_nj_pwc_registry_match_acceptance.sql")),testCase.error);
          await incompatible.exec("ROLLBACK");
          const created=(await incompatible.query(`SELECT count(*)::INT AS n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
            WHERE n.nspname='public' AND p.proname IN ('nj_pwc_comparison_text','get_nj_pwc_registry_matches','accept_nj_pwc_registry_match')`)).rows[0].n;
          assert.equal(created,0,"failed migration must roll back every function created before failure");
        } finally { await incompatible.close(); }
      }
    });
    await t.test("B & B, punctuation and repeated spaces compare equivalently",async()=>{
      for(const [a,b] of [["B & B Ironworks","B&B Ironworks"],["Company, Inc.","company inc"],["A   Company","a company"]]) {
        assert.equal((await rows("SELECT nj_pwc_comparison_text($1)=nj_pwc_comparison_text($2) AS same",[a,b]))[0].same,true);
      }
    });
    await t.test("legal suffix and word abbreviation differences remain evidence, not silent name rewrites",async()=>{
      for(const [a,b] of [["Company LLC","Company Inc"],["Window Mfg.","Window Manufacturing"]]) {
        assert.equal((await rows("SELECT nj_pwc_comparison_text($1)=nj_pwc_comparison_text($2) AS same",[a,b]))[0].same,false);
      }
      assert.equal((await rows("SELECT nj_pwc_comparison_street('5 North Street, Avenue Boulevard Road') AS s"))[0].s,"5 NORTH ST AVE BLVD RD");
      assert.equal((await rows("SELECT nj_pwc_comparison_zip('07860-1234') AS z"))[0].z,"07860");
    });
    await t.test("certificate and full normalized address produce High Confidence",async()=>{
      const f=await fixture();
      assert.equal(f.preview.evidence.confidence,"High");
      assert.equal(f.preview.evidence.zip_match,true);
    });
    await t.test("matching certificate and conflicting street are Medium and forced to review",async()=>{
      const f=await fixture({conflict:true});
      assert.equal(f.preview.evidence.confidence,"Medium");
      assert.equal((await accept(f)).approval,"review_required");
      assert.equal((await rows("SELECT count(*)::INT AS n FROM compliance_records WHERE contractor_id=$1",[f.contractor.id]))[0].n,0);
    });
    await t.test("full address with no known certificate is Medium and forced to review",async()=>{
      const f=await fixture({known:false});
      assert.equal(f.preview.evidence.confidence,"Medium");
      assert.equal((await accept(f)).approval,"review_required");
    });
    await t.test("unit conflict is Low even when base street and certificate match",async()=>{
      const f=await fixture({unit:true});
      assert.equal(f.preview.evidence.confidence,"Low");
      assert.equal(f.preview.evidence.unit_conflict,true);
      assert.equal((await accept(f)).approval,"review_required");
    });
    await t.test("stale Medium or Low name match is rejected instead of risking Auto Approve",async()=>{
      const f=await fixture({unit:true});
      await rows("UPDATE contractors SET company_name=$1 WHERE id=$2",[f.candidate.business_name,f.contractor.id]);
      f.preview=await preview(f.exceptionId);
      assert.equal(f.preview.evidence.confidence,"Low");
      await assert.rejects(accept(f),/Contractor name changed since this Name Mismatch/);
      assert.equal((await rows("SELECT imported_at FROM compliance_sync_search_requests WHERE id=$1",[f.requestId]))[0].imported_at,null);
    });
    await t.test("certificate conflict or municipality conflict is Low",async()=>{
      const f=await fixture();
      await rows("UPDATE contractors SET nj_pwc_number='CONFLICT',city='Elsewhere' WHERE id=$1",[f.contractor.id]);
      f.preview=await preview(f.exceptionId);
      assert.equal(f.preview.evidence.confidence,"Low");
      assert.equal((await accept(f)).approval,"review_required");
    });
    await t.test("ambiguous multiple candidates have no acceptance action; unique known certificate disambiguates",async()=>{
      const f=await fixture();
      await rows("UPDATE compliance_sync_search_requests SET candidates=$1,result_status='Multiple Matches' WHERE id=$2",
        [JSON.stringify([f.candidate,{...f.candidate,business_name:"Other Entity",certificate_number:"OTHER",address:"22 Other St"}]),f.requestId]);
      const p=await preview(f.exceptionId);
      assert.equal(p.evidence.confidence,"High"); assert.equal(p.candidate.certificate_number,f.candidate.certificate_number);
      await rows("UPDATE contractors SET nj_pwc_number=NULL WHERE id=$1",[f.contractor.id]);
      f.preview=await preview(f.exceptionId);
      assert.equal(f.preview.candidate,null); assert.equal(f.preview.can_accept,false);
      await assert.rejects(accept(f),/No specific/);
    });
    await t.test("expired and anomalous registrations are Low and always reviewed",async()=>{
      for(const options of [{expired:true},{anomaly:true}]) {
        const f=await fixture(options);
        assert.equal(f.preview.evidence.confidence,"Low");
        assert.equal((await accept(f)).approval,"review_required");
      }
    });
    await t.test("stale contractor, candidate, exception link or Mode changes are rejected",async()=>{
      for(const change of [
        f=>rows("UPDATE contractors SET city='Changed' WHERE id=$1",[f.contractor.id]),
        f=>rows("UPDATE compliance_sync_search_requests SET candidates=$1 WHERE id=$2",[JSON.stringify([{...f.candidate,address:"Changed"}]),f.requestId]),
        f=>rows("UPDATE nj_pwc_sync_exceptions SET last_search_request_id=NULL WHERE id=$1",[f.exceptionId]),
        ()=>rows("UPDATE compliance_sync_settings SET mode='review_required' WHERE compliance_name='NJ PWC'"),
      ]) {
        const f=await fixture(); await change(f);
        await assert.rejects(accept(f),/comparison changed/);
        assert.equal((await rows("SELECT company_name FROM contractors WHERE id=$1",[f.contractor.id]))[0].company_name,f.contractor.company_name);
      }
    });
    await t.test("High Confidence follows Auto Approve; explicit Test Mode acceptance is a deliberate live import",async()=>{
      const f=await fixture({isTest:true});
      assert.equal((await accept(f)).approval,"auto_approved");
      assert.equal((await rows("SELECT count(*)::INT AS n FROM compliance_records WHERE contractor_id=$1",[f.contractor.id]))[0].n,1);
      const state=await rows("SELECT is_test,consecutive_failure_count,dry_run_action FROM nj_pwc_sync_state WHERE contractor_id=$1",[f.contractor.id]);
      assert.ok(state.every(s=>s.consecutive_failure_count===0));
      assert.equal(state.find(s=>s.is_test).dry_run_action,null);
      assert.equal((await rows("SELECT status FROM nj_pwc_sync_exceptions WHERE id=$1",[f.exceptionId]))[0].status,"resolved");
    });
    await t.test("High Confidence follows Review Required mode",async()=>{
      const f=await fixture({mode:"review_required"});
      const result=await accept(f);
      assert.equal(result.approval,"review_required");
      assert.equal((await rows("SELECT status,is_test FROM compliance_sync_review_queue WHERE id=$1",[result.review_queue_id]))[0].status,"pending");
    });
    await t.test("only selected supported fields change; protected contractor values and active flag remain",async()=>{
      const f=await fixture({known:false});
      const before=(await rows("SELECT * FROM contractors WHERE id=$1",[f.contractor.id]))[0];
      await accept(f,["company_name","county"]);
      const after=(await rows("SELECT * FROM contractors WHERE id=$1",[f.contractor.id]))[0];
      for(const key of Object.keys(before).filter(k=>!["company_name","county","updated_at"].includes(k))) {
        assert.deepEqual(after[key],before[key],key);
      }
      assert.equal(after.company_name,f.candidate.business_name); assert.equal(after.county,f.candidate.county);
    });
    await t.test("active compliance certificate can support High without overwriting unselected contractor NJ PWC #",async()=>{
      const f=await fixture({known:false});
      await rows(`INSERT INTO compliance_records(contractor_id,compliance_type_id,registration_number,expiration_date)
        VALUES($1,nj_pwc_compliance_type_id(),$2,'2098-01-01')`,[f.contractor.id,f.candidate.certificate_number]);
      f.preview=await preview(f.exceptionId);
      assert.equal(f.preview.evidence.confidence,"High");
      assert.equal((await accept(f)).approval,"auto_approved");
      assert.equal((await rows("SELECT nj_pwc_number FROM contractors WHERE id=$1",[f.contractor.id]))[0].nj_pwc_number,null);
      const history=await rows("SELECT active,is_current FROM compliance_records WHERE contractor_id=$1",[f.contractor.id]);
      assert.equal(history.length,2); assert.equal(history.filter(r=>r.active&&r.is_current).length,1);
    });
    await t.test("projects, insurance, follow-ups and relationship tables remain byte-for-byte unchanged",async()=>{
      const f=await fixture();
      const project=(await rows("INSERT INTO projects(project_number,project_name) VALUES('ACCEPT-TEST','Acceptance Test Project') RETURNING id"))[0].id;
      const child=(await rows("INSERT INTO contractors(company_name) VALUES('Acceptance Tiered Sub') RETURNING id"))[0].id;
      await rows("INSERT INTO contractor_projects(contractor_id,project_id) VALUES($1,$2)",[f.contractor.id,project]);
      await rows("INSERT INTO contractor_insurance(contractor_id,certificate_on_file,notes) VALUES($1,TRUE,'Preserve insurance')",[f.contractor.id]);
      await rows("INSERT INTO contractor_insurance_history(contractor_id,coi_on_file,notes) VALUES($1,TRUE,'Preserve history')",[f.contractor.id]);
      await rows("INSERT INTO contractor_followups(contractor_id,followup_date,followup_method,subject) VALUES($1,CURRENT_DATE,'Email','Preserve follow-up')",[f.contractor.id]);
      await rows("INSERT INTO contractor_tiered_subs(contractor_id,tiered_sub_contractor_id) VALUES($1,$2)",[f.contractor.id,child]);
      const tables=(await rows(`SELECT tablename FROM pg_tables WHERE schemaname='public'
        AND (tablename LIKE '%project%' OR tablename LIKE '%insurance%' OR tablename LIKE '%followup%' OR tablename LIKE '%tiered%')`)).map(r=>r.tablename);
      const capture=async()=>Promise.all(tables.map(table=>rows(`SELECT to_jsonb(t) AS row FROM public."${table}" t ORDER BY to_jsonb(t)::TEXT`)));
      const before=await capture(); await accept(f); assert.deepEqual(await capture(),before);
    });
    await t.test("resolved exceptions and double submission cannot process twice",async()=>{
      const f=await fixture(); await accept(f);
      await assert.rejects(accept(f),/resolved/);
      assert.equal((await rows("SELECT count(*)::INT AS n FROM administration_audit_log WHERE action='NJ_PWC_REGISTRY_MATCH_ACCEPTED' AND object_id=$1",[String(f.contractor.id)]))[0].n,1);
    });
    await t.test("concurrent submissions permit exactly one acceptance",async()=>{
      const f=await fixture();
      const results=await Promise.allSettled([accept(f),accept(f)]);
      assert.equal(results.filter(r=>r.status==="fulfilled").length,1);
      assert.equal(results.filter(r=>r.status==="rejected").length,1);
    });
    await t.test("an unchanged active certificate refreshes verification without duplicate records",async()=>{
      const f=await fixture();
      await rows(`INSERT INTO compliance_records(contractor_id,compliance_type_id,registration_number,effective_date,expiration_date)
        VALUES($1,nj_pwc_compliance_type_id(),$2,'2025-01-01','2099-01-01')`,[f.contractor.id,f.candidate.certificate_number]);
      f.preview=await preview(f.exceptionId);
      const result=await accept(f);
      assert.equal(result.record_action,"refreshed");
      assert.equal((await rows("SELECT count(*)::INT AS n FROM compliance_records WHERE contractor_id=$1",[f.contractor.id]))[0].n,1);
    });
    await t.test("existing six-argument user import preserves authoritative approval behavior",async()=>{
      const f=await fixture();
      await rows("UPDATE contractors SET company_name=$1 WHERE id=$2",[f.candidate.business_name,f.contractor.id]);
      const result=(await rows("SELECT * FROM import_nj_pwc_candidate($1,$2,$3,NULL,'Original Import User','u@example.test')",
        [f.requestId,f.contractor.id,f.candidate.certificate_number]))[0];
      assert.equal(result.approval,"auto_approved");
    });
    await t.test("duplicate contractor identity blocks acceptance and requires manual merge",async()=>{
      const f=await fixture();
      await rows("INSERT INTO contractors(company_name,nj_pwc_number) VALUES('Duplicate Target',$1)",[f.candidate.certificate_number]);
      f.preview=await preview(f.exceptionId);
      assert.equal(f.preview.duplicate_target,true);
      await assert.rejects(accept(f),/manual contractor merge/);
    });
    await t.test("audit contains actor, IDs, confidence, evidence, all changes and live/Test separation without taxpayer values",async()=>{
      const f=await fixture({isTest:true}); await accept(f,["company_name","address_1","nj_pwc_number"]);
      const audit=(await rows("SELECT * FROM administration_audit_log WHERE action='NJ_PWC_REGISTRY_MATCH_ACCEPTED' AND object_id=$1",[String(f.contractor.id)]))[0];
      assert.equal(audit.user_name,"Acceptance Test User");
      for(const key of ["exception_id","contractor_id","search_request_id","confidence","evidence","old_contractor_name","new_contractor_name","changed_fields","certificate_number","approval","record_action","source_is_test"]) assert.ok(key in audit.details,key);
      assert.equal(audit.details.source_is_test,true);
      assert.equal(audit.details.changed_fields.company_name.old,f.contractor.company_name);
      assert.doesNotMatch(JSON.stringify(audit.details),/fein|taxpayer|worker_key|sage_erp|brc_name/i);
    });
    await t.test("failure at final audit rolls back contractor, compliance, exception and import atomically",async()=>{
      const f=await fixture();
      await db.exec(`CREATE FUNCTION fail_acceptance_audit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.action='NJ_PWC_REGISTRY_MATCH_ACCEPTED' THEN RAISE EXCEPTION 'Synthetic audit failure'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER fail_acceptance_audit BEFORE INSERT ON administration_audit_log FOR EACH ROW EXECUTE FUNCTION fail_acceptance_audit();`);
      await assert.rejects(accept(f),/Synthetic audit failure/);
      assert.equal((await rows("SELECT company_name FROM contractors WHERE id=$1",[f.contractor.id]))[0].company_name,f.contractor.company_name);
      assert.equal((await rows("SELECT status FROM nj_pwc_sync_exceptions WHERE id=$1",[f.exceptionId]))[0].status,"open");
      assert.equal((await rows("SELECT imported_at FROM compliance_sync_search_requests WHERE id=$1",[f.requestId]))[0].imported_at,null);
      assert.equal((await rows("SELECT count(*)::INT AS n FROM compliance_records WHERE contractor_id=$1",[f.contractor.id]))[0].n,0);
      await db.exec("DROP TRIGGER fail_acceptance_audit ON administration_audit_log; DROP FUNCTION fail_acceptance_audit()");
    });
    await t.test("unconfirmed, protected-field and missing Company Name selections are rejected",async()=>{
      const f=await fixture();
      await assert.rejects(rows("SELECT accept_nj_pwc_registry_match($1,$2,ARRAY['company_name'],FALSE,NULL,'U','E')",[f.exceptionId,f.preview.snapshot]),/confirmation/);
      for(const fields of [["city"],["company_name","fein"]]) await assert.rejects(accept(f,fields),/supported registry fields/);
    });
    if(process.env.NJ_PWC_READ_ONLY_LIVE==="1") {
      await t.test("read-only live exception validation: GETs only, SQL evidence evaluated locally",async()=>{
        const env=Object.fromEntries(fs.readFileSync(".env.local","utf8").split(/\r?\n/)
          .filter(l=>/^[A-Z_][A-Z_0-9]*=/.test(l)).map(l=>{
            const i=l.indexOf("=");return [l.slice(0,i),l.slice(i+1).trim().replace(/^['"]|['"]$/g,"")];
          }));
        async function get(table,params) {
          const url=new URL(env.NEXT_PUBLIC_SUPABASE_URL+"/rest/v1/"+table);
          for(const [k,v] of Object.entries(params)) url.searchParams.set(k,v);
          const response=await fetch(url,{method:"GET",headers:{
            apikey:env.SUPABASE_SERVICE_ROLE_KEY,Authorization:"Bearer "+env.SUPABASE_SERVICE_ROLE_KEY,
          }});
          if(!response.ok) throw new Error(`Read-only ${table} GET failed: HTTP ${response.status}`);
          return response.json();
        }
        const exceptions=await get("nj_pwc_sync_exceptions",{select:"id,contractor_id,reason,is_test,last_search_request_id",status:"eq.open",limit:"1000"});
        const mismatches=exceptions.filter(e=>e.reason==="Name Mismatch");
        const ids=[...new Set(mismatches.map(e=>e.contractor_id))];
        const requests=[...new Set(mismatches.map(e=>e.last_search_request_id).filter(Boolean))];
        const [contractors,searches,records]=await Promise.all([
          ids.length?get("contractors",{select:"id,company_name,address_1,address_2,city,state,zip_code,county,nj_pwc_number",id:`in.(${ids.join(",")})`}):[],
          requests.length?get("compliance_sync_search_requests",{select:"id,contractor_id,status,result_status,candidates,imported_at",id:`in.(${requests.join(",")})`}):[],
          ids.length?get("compliance_records",{select:"contractor_id,registration_number,compliance_types!inner(compliance_name)",active:"eq.true",is_current:"eq.true",contractor_id:`in.(${ids.join(",")})`,"compliance_types.compliance_name":"eq.NJ PWC"}):[],
        ]);
        const summary=[];
        for(const e of mismatches) {
          const current=contractors.find(c=>c.id===e.contractor_id);
          assert.ok(current,`Contractor ${e.contractor_id} exists`);
          const request=searches.find(r=>r.id===e.last_search_request_id);
          const known=[current.nj_pwc_number,...records.filter(r=>r.contractor_id===current.id).map(r=>r.registration_number)].filter(Boolean);
          const candidates=request?.status==="completed"&&!request.imported_at?request.candidates:[];
          const result=(await rows(`
            WITH known AS (SELECT coalesce(array_agg(DISTINCT nj_pwc_normalize_certificate(k)),ARRAY[]::TEXT[]) AS certs FROM unnest($2::TEXT[]) k),
            matches AS (SELECT c FROM jsonb_array_elements($3::JSONB) c,known WHERE nj_pwc_normalize_certificate(c->>'certificate_number')=ANY(known.certs)),
            choice AS (SELECT CASE WHEN (SELECT count(*) FROM matches)=1 THEN (SELECT c FROM matches LIMIT 1)
              WHEN jsonb_array_length($3::JSONB)=1 THEN ($3::JSONB)->0 ELSE NULL END AS candidate)
            SELECT choice.candidate IS NOT NULL AS available,nj_pwc_registry_match_evidence($1::JSONB,known.certs,choice.candidate,
              (SELECT count(*)::INT FROM matches),CASE WHEN (SELECT count(*) FROM matches)=1 THEN 1 ELSE jsonb_array_length($3::JSONB) END) AS evidence
            FROM choice,known`,[JSON.stringify(current),known,JSON.stringify(candidates||[])]))[0];
          summary.push({exception_id:e.id,contractor_id:current.id,contractor:current.company_name,is_test:e.is_test,
            candidate_available:result.available,confidence:result.evidence.confidence,
            certificate_match:result.evidence.certificate_match,street_address_match:result.evidence.street_address_match,
            unit_conflict:result.evidence.unit_conflict,expired:result.evidence.expired,registry_anomaly:result.evidence.registry_anomaly});
        }
        console.log(JSON.stringify({read_only:true,snapshot_at:new Date().toISOString(),open_exceptions:exceptions.length,
          name_mismatches:mismatches.length,counts:summary.reduce((counts,row)=>{
            const key=row.candidate_available?row.confidence:"No specific candidate";counts[key]=(counts[key]||0)+1;return counts;
          },{}),examples:summary},null,2));
      });
    }
  } finally { await db.close(); }
});
