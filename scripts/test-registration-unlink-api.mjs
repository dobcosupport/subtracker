import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const actor="00000000-0000-0000-0000-000000000001";
class AdminApiError extends Error { constructor(message,status=500) { super(message);this.status=status; } }
let allowed=true, rpcError=null, rpcResult={compliance_record_id:10,resulting_identifier:null};
const calls=[];
let tables={};
class Query {
  constructor(table) { this.table=table;this.filters=[];this.offset=0;this.end=Infinity; }
  select(columns) { assert.doesNotMatch(columns,/federal_tax_id|taxpayer_id_submission|raw_result|claim_worker/);return this; }
  eq(field,value) { this.filters.push(row=>row[field]===value);return this; }
  is(field,value) { this.filters.push(row=>(row[field]??null)===value);return this; }
  order() { return this; }
  range(offset,end) { this.offset=offset;this.end=end;return this; }
  returns() { return this; }
  result() { return (tables[this.table]??[]).filter(row=>this.filters.every(filter=>filter(row))).slice(this.offset,this.end+1); }
  maybeSingle() { return Promise.resolve({data:this.result()[0]??null,error:null}); }
  then(resolve,reject) { return Promise.resolve({data:this.result(),error:null}).then(resolve,reject); }
}
const server={
  AdminApiError,jsonError:error=>Response.json({error:error.message},{status:error.status??500}),
  requireModulePermission:async (_request,module,action)=>{
    assert.equal(module,"compliance_sync");assert.equal(action,"manage");
    if(!allowed) throw new AdminApiError("Permission denied",403);
    return {profile:{auth_user_id:actor},admin:{
      from:table=>new Query(table),rpc:async(name,args)=>{calls.push({name,args});return {data:rpcResult,error:rpcError};},
    }};
  },
};
function load(file,deps) {
  const loaded={exports:{}};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL(`../${file}`,import.meta.url),"utf8"),{
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020},
  }).outputText,{module:loaded,exports:loaded.exports,Request,Response,URL,require:name=>{
    assert.ok(name in deps,name);return deps[name];
  }});
  return loaded.exports;
}
const helper=load("src/lib/server-nj-pwc-sync.ts",{"@/lib/server-admin":server});
const route=load("src/app/api/admin/compliance-sync/registration-unlink/route.ts",{
  "@/lib/server-admin":server,"@/lib/server-nj-pwc-sync":helper,
});
const request=body=>new Request("http://localhost/api/unlink",{method:"POST",body:JSON.stringify(body)});
const payload={contractor_id:1,record_id:10,compliance:"NJ PWC",expected_updated_at:"2026-10-21T12:00:00Z",
  expected_identifier:"WRONG",reason:"Incorrect business",confirmed:true};
allowed=false;
assert.equal((await route.POST(request(payload))).status,403);
assert.equal((await route.GET(new Request("http://localhost/?compliance=NJ%20PWC"))).status,403);
assert.equal(calls.length,0);
allowed=true;
for(const changes of [{reason:" \t\n "},{reason:1},{reason:"x".repeat(2001)},{confirmed:false},{record_id:-1},
  {compliance:"NY PWC"},{expected_updated_at:"invalid"},{expected_identifier:undefined},{p_actor:"forged"}]) {
  assert.equal((await route.POST(request({...payload,...changes}))).status,400,JSON.stringify(changes));
}
assert.equal(calls.length,0);
assert.equal((await route.POST(request(payload))).status,200);
assert.deepEqual(JSON.parse(JSON.stringify(calls[0])),{name:"unlink_contractor_registration",args:{
  p_contractor:1,p_record:10,p_compliance:"NJ PWC",p_expected_updated_at:payload.expected_updated_at,
  p_expected_identifier:"WRONG",p_reason:"Incorrect business",p_confirmed:true,p_actor:actor,
}},"Actor is server-derived; one atomic RPC and no direct mutations");
for(const [code,status] of [["40001",409],["42501",403],["P0002",404],["22023",400],["23514",503]]) {
  rpcError={code,message:"Synthetic failure"};assert.equal((await route.POST(request(payload))).status,status);
}
rpcError=null;rpcResult=null;
assert.equal((await route.POST(request(payload))).status,503,"No success-shaped empty RPC fallback");
tables={
  contractors:Array.from({length:1001},(_,i)=>({id:i+1,company_name:`Company ${i+1}`,active:i%2===0,nj_brc_number:"BRC10"})),
  compliance_types:[{id:2,compliance_name:"NJ BRC"}],
  compliance_records:[{id:10,contractor_id:1,compliance_type_id:2,registration_number:"BRC10",active:true,is_current:true,matched_company_name:null},
    {id:9,contractor_id:1,compliance_type_id:2,registration_number:"BRC9",active:false,is_current:false}],
  compliance_record_unlinks:[{record_id:9,contractor_id:1,compliance_type_id:2,unlinked_at:"2026-10-20"}],
  compliance_sync_review_queue:[{contractor_id:1,compliance_name:"NJ BRC",status:"approved",compliance_record_id:10,
    brc_evidence:{taxpayer_name:"Verified BRC Company"},brc_name_control_used:"VERI"}],
};
tables.contractors.push({id:1002,company_name:"Archived merged predecessor",active:false,merged_into_contractor_id:1});
let response=await route.GET(new Request("http://localhost/?compliance=NJ%20BRC"));
const ordinaryCompanies=(await response.json()).contractors;
assert.equal(ordinaryCompanies.length,1001,"All ordinary contractors, including inactive and second page");
assert(ordinaryCompanies.some(company=>company.active===false),"Ordinary inactive contractors remain selectable");
assert(!ordinaryCompanies.some(company=>company.id===1002),"Archived merged predecessors are excluded");
assert.equal((await route.GET(new Request("http://localhost/?compliance=NJ%20BRC&contractor_id=1002"))).status,404);
response=await route.GET(new Request("http://localhost/?compliance=NJ%20BRC&contractor_id=1"));
assert.equal(response.status,200);
const selection=await response.json();
assert.equal(selection.records[0].supplies_identifier,true);
assert.equal(selection.records[0].matched_company_name,"Verified BRC Company","BRC evidence supplements historical record identity");
assert.equal(selection.records[0].searched_name_control,"VERI");
assert.equal(selection.records[1].unlinked_at,"2026-10-20");
console.log("PASS: admin-only list/selection/mutation, all-contractor pagination, minimal safe evidence, server-derived actor, explicit confirmation/reason/snapshot, strict payloads, truthful failures and one atomic RPC");
