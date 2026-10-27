import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
function load(file, dependencies) {
  const loaded={exports:{}};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,"utf8"),{
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}
  }).outputText,{module:loaded,exports:loaded.exports,require:name=>{
    assert.ok(name in dependencies,`Unexpected import ${name}`);return dependencies[name];
  },Request,Response,URL,Map,Set});
  return loaded.exports;
}
class AdminApiError extends Error {constructor(message,status=500){super(message);this.status=status;}}
const payload={exception_id:294,search_request_id:3626,candidate_identity:"a".repeat(32),snapshot:"b".repeat(32),confirmed:true};
const post=body=>new Request("http://localhost/api",{method:"POST",body:JSON.stringify(body)});
function harness({denied=null,result={approval:"review_required",review_reason:"Name Mismatch",review_queue_id:77},error=null,tables={}}={}) {
  const calls=[], permissions=[],profile={auth_user_id:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",name:"Server Actor",email:"actor@example.invalid"};
  const server={
    AdminApiError,jsonError:e=>Response.json({error:e.message},{status:e.status??500}),
    requireModulePermission:async(_req,module,action)=>{
      permissions.push(`${module}/${action}`);
      if(denied===module)throw new AdminApiError("Forbidden",403);
      return {profile,admin:{
        rpc:async(name,args)=>{calls.push({name,args});return {data:result,error};},
        from(table) {
          const filters=[],query={
            select(){return query;},eq(key,value){filters.push([key,value]);return query;},
            in(key,values){filters.push([key,values]);return query;},
            order(){return query;},limit(){return query;},maybeSingle(){return query;},
            then(resolve,reject){
              const entry=tables[table]??{data:[],count:0,error:null};
              return Promise.resolve(typeof entry==="function"?entry(filters):entry).then(resolve,reject);
            }
          };return query;
        }
      }};
    }
  };
  const helpers=load("src\\lib\\server-nj-pwc-sync.ts",{"@/lib/server-admin":server});
  const dependencies={"@/lib/server-admin":server,"@/lib/server-nj-pwc-sync":helpers};
  return {calls,permissions,profile,route:load("src\\app\\api\\admin\\compliance-sync\\nj-pwc-select-match\\route.ts",dependencies),
    exceptions:()=>load("src\\app\\api\\admin\\compliance-sync\\nj-pwc-sync-exceptions\\route.ts",dependencies)};
}
test("stored candidate GET requires view only and disables caching",async()=>{
  const h=harness({result:{search_request_id:3626,candidates:[{certificate_number:"644541"}]}});
  const r=await h.route.GET(new Request("http://localhost/api?exception_id=294"));
  assert.equal(r.status,200);assert.equal(r.headers.get("cache-control"),"no-store");
  assert.deepEqual(h.permissions,["compliance_sync/view"]);
  assert.equal(h.calls[0].name,"get_nj_pwc_exception_candidates");
  assert.equal(h.calls[0].args.p_exception_id,294);
  assert.equal((await r.json()).selection.search_request_id,3626);
});
test("selection requires both manage permissions and server-derived actor, never browser details",async()=>{
  const h=harness(), r=await h.route.POST(post(payload)), body=await r.json();
  assert.equal(r.status,200);assert.match(body.message,/Sent to PWC Review.*Name Mismatch/);
  assert.deepEqual(h.permissions,["compliance_sync/manage","contractors/manage"]);
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls[0])),{name:"select_nj_pwc_exception_match",args:{
    p_exception_id:294,p_request_id:3626,p_candidate_identity:payload.candidate_identity,p_snapshot:payload.snapshot,p_confirmed:true,
    p_actor_id:h.profile.auth_user_id,p_actor_name:h.profile.name,p_actor_email:h.profile.email
  }});
  for(const permissionModule of ["compliance_sync","contractors"]){
    const denied=harness({denied:permissionModule});
    assert.equal((await denied.route.POST(post(payload))).status,403);assert.equal(denied.calls.length,0);
  }
});
test("invalid identity, unconfirmed selection and injected fields never reach RPC",async()=>{
  for(const change of [{confirmed:false},{confirmed:"true"},{candidate_identity:""},{snapshot:"wrong"},
    {exception_id:0},{search_request_id:-1},{candidate:{certificate_number:"644541"}},{actor_id:"injected"}]){
    const h=harness();assert.equal((await h.route.POST(post({...payload,...change}))).status,400);
    assert.equal(h.calls.length,0);
  }
  const h=harness();
  assert.equal((await h.route.GET(new Request("http://localhost/api?exception_id=bad"))).status,400);
});
test("stale, invalid, missing, and infrastructure RPC failures stay explicit",async()=>{
  for(const [code,status] of [["55000",409],["22023",400],["23514",422],["P0002",404],["XX000",500]]){
    const h=harness({error:{code,message:"Stored selection changed"}});
    const r=await h.route.POST(post(payload));assert.equal(r.status,status);
    assert.equal((await r.json()).error,"Stored selection changed");
  }
});
test("applied/refreshed, review and idempotent outcomes reported distinctly; empty outcome is never success",async()=>{
  for(const approval of ["auto_approved","refreshed"]){
    const h=harness({result:{approval,record_action:"refreshed",compliance_record_id:9,already_processed:true}});
    const r=await h.route.POST(post(payload));assert.equal(r.status,200);
    assert.match((await r.json()).message,/Already processed.*refreshed.*resolved/);
  }
  for(const result of [null,[],{}, {approval:"review_required"},{approval:"auto_approved"}]){
    const r=await harness({result}).route.POST(post(payload));assert.ok(r.status>=500);
  }
});
test("exception listing offers selection only for usable latest linked completed results, not other reasons or old results",async()=>{
  const requestIds=[];
  const exceptionRows=[
    {id:294,reason:"Multiple Matches",last_search_request_id:3626},
    {id:295,reason:"No Match Found",last_search_request_id:3626},
    {id:296,reason:"Multiple Matches",last_search_request_id:3627},
    {id:297,reason:"Multiple Matches",last_search_request_id:3628},
    {id:298,reason:"Multiple Matches",last_search_request_id:3629},
  ].map(row=>({...row,contractor_id:684,is_test:false,contractors:{company_name:"Mechanical Associates of NJ"}}));
  const stored=[{business_name:"Mechanical Associates of New Jersey",certificate_number:"644541"}];
  const h=harness({tables:{
    compliance_sync_settings:{data:{test_mode:false},error:null},
    nj_pwc_sync_exceptions:{data:exceptionRows,count:5,error:null},
    compliance_sync_search_requests:filters=>{
      requestIds.push(...filters.find(([key])=>key==="id")[1]);
      return {error:null,data:[
        {id:3626,status:"completed",completed_at:"2026-10-27",candidates:stored,origin:"exception_retry"},
        {id:3627,status:"processing",candidates:stored},
        {id:3628,status:"completed",completed_at:"2026-10-27",imported_at:"2026-10-27",candidates:stored},
        {id:3629,status:"completed",completed_at:"2026-10-27",candidates:[]},
      ].map(row=>({result_status:"Multiple Matches",...row}))};
    }
  }});
  const r=await h.exceptions().GET(new Request("http://localhost/api"));
  assert.equal(r.status,200);const body=await r.json();
  assert.deepEqual(requestIds,[3626,3627,3628,3629]);
  assert.deepEqual(body.exceptions.map(row=>row.can_select_match),[true,false,false,false,false]);
  assert.equal(body.exceptions[0].retry_request.id,3626,"Existing retry display is retained");
  assert.equal("candidates" in body.exceptions[0],false,"Full candidates are fetched only on dialog open");
});
