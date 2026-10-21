import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

let tables = {}, failure = null, allowed = true;
const calls = [];
class Query {
  constructor(table) { this.table=table;this.filters=[];this.start=0;this.end=Infinity;calls.push(this); }
  select(columns) { this.columns=columns;return this; }
  eq(key,value) { this.filters.push(row=>row[key]===value);return this; }
  in(key,values) { this.filters.push(row=>values.includes(key==="compliance_types.compliance_name"?row.compliance_types.compliance_name:row[key]));return this; }
  order() { return this; }
  range(start,end) { this.start=start;this.end=end;return this; }
  then(resolve,reject) { return Promise.resolve({data:failure===this.table?null:(tables[this.table]??[])
    .filter(row=>this.filters.every(f=>f(row))).slice(this.start,this.end+1),
    error:failure===this.table?{message:"Synthetic read failure"}:null}).then(resolve,reject); }
}
const admin={from:table=>new Query(table)};
class AdminApiError extends Error { constructor(message,status=500) { super(message);this.status=status; } }
const server={AdminApiError,jsonError:e=>Response.json({error:e.message},{status:e.status??500}),
  requireModulePermission:async(_request,module,action)=>{
    assert.equal(module,"contractors");assert.equal(action,"view");
    if(!allowed)throw new AdminApiError("Permission denied",403);
    return {admin};
  }};
function load(file,deps) {
  const result={exports:{}};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL(`../${file}`,import.meta.url),"utf8"),{
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020},
  }).outputText,{module:result,exports:result.exports,Request,Response,URL,Date,require:name=>{
    assert.ok(name in deps,name);return deps[name];
  }});
  return result.exports;
}
const compliance=load("services/compliance.ts",{"@/lib/supabase":{supabase:admin}});
const record=(id,name,active=true,current=true)=>({id,contractor_id:35,compliance_type_id:6,
  registration_number:`REG-${id}`,effective_date:"2025-01-01",expiration_date:name==="NJ BRC"?null:"2099-01-01",
  active,is_current:current,compliance_types:{compliance_name:name,requires_expiration:name!=="NJ BRC"},
  matched_company_name:"AMEC Electric, LLC",registry_status:"OK",sync_status:"Approved",sync_source:"RPA",
  verification_source:"Registry",source_url:"https://example.invalid/evidence",verified_date:"2026-10-21",verified_by:"Synthetic Admin"});
tables.compliance_records=[record(273,"NJ PWC",false,false),record(275,"NJ PWC",false,false),record(64,"NJ PWC",false,false),
  record(300,"NJ BRC",false,false),record(301,"NJ PWC"),record(302,"NJ BRC"),record(303,"NJ PWC",true,false),
  {...record(304,"NJ PWC"),contractor_id:99},record(305,"Unrelated compliance",false,false)];
assert.deepEqual(Array.from((await compliance.getSyncedComplianceRecordsForContractor(35)).data,r=>r.id),[301,302]);
let history=(await compliance.getComplianceHistoryForContractor(35)).data;
assert.equal(history.length,8,"Archived, inactive and unrelated compliance history remains available");
assert.equal(history.find(r=>r.id===273).matched_company_name,"AMEC Electric, LLC");
assert.equal(history.find(r=>r.id===273).registry_status,"OK");
assert.equal(history.find(r=>r.id===273).source_url,"https://example.invalid/evidence");
assert.equal(history.find(r=>r.id===300).expiration_date,null);
assert.equal(history.find(r=>r.id===300).calculated_status,"Active","BRC remains non-expiring even in history");
tables.compliance_records=tables.compliance_records.filter(r=>![301,302].includes(r.id));
assert.equal((await compliance.getSyncedComplianceRecordsForContractor(35)).data.length,0,"No historical record replaces a current relationship");
failure="compliance_records";
assert.match((await compliance.getSyncedComplianceRecordsForContractor(35)).error.message,/Synthetic/);
failure=null;
const helpers=load("src/lib/server-nj-pwc-sync.ts",{"@/lib/server-admin":server});
const route=load("src/app/api/contractors/[id]/compliance-history/route.ts",{
  "@/lib/server-admin":server,"@/lib/server-nj-pwc-sync":helpers,
});
const get=id=>route.GET(new Request(`http://localhost/api/contractors/${id}/compliance-history`),{params:Promise.resolve({id:String(id)})});
allowed=false;calls.length=0;
assert.equal((await get(35)).status,403);assert.equal(calls.length,0);
allowed=true;assert.equal((await get(-1)).status,400);
tables.compliance_record_unlinks=Array.from({length:1001},(_,i)=>({record_id:i+1,contractor_id:35,
  reason:"Wrong business",unlinked_at:"2026-10-21T17:54:28Z",unlinked_by:"actor",administrator:{name:"Current Name"}}));
tables.compliance_record_unlinks.push({record_id:9000,contractor_id:99,reason:"Private other contractor"});
tables.administration_audit_log=[{id:1,object_type:"contractor",object_id:"35",action:"COMPLIANCE_RECORD_UNLINKED",
  user_name:"Original Administrator",details:{compliance_record_id:273,record_company_name:"AMEC Electric, LLC",
    previous_identifier:"621916",resulting_identifier:null}},
  {id:2,object_type:"contractor",object_id:"99",action:"COMPLIANCE_RECORD_UNLINKED",
    details:{compliance_record_id:273,record_company_name:"Wrong contractor leak"}}];
let response=await get(35);assert.equal(response.status,200);
const result=await response.json();
assert.equal(result.unlinks.length,1001,"All archived entries paginate and remain contractor scoped");
assert.deepEqual(result.unlinks.find(r=>r.record_id===273),{
  record_id:273,reason:"Wrong business",unlinked_at:"2026-10-21T17:54:28Z",
  administrator:"Original Administrator",record_company_name:"AMEC Electric, LLC",
  identifiers:{previous:"621916",resulting:null},
});
assert.equal(result.unlinks.find(r=>r.record_id===1).identifiers,null,"Absent audit snapshots are not invented");
assert.ok(calls.every(q=>q.table!=="user_profiles"),"Only the actor's safe joined name is projected");
for(const table of ["compliance_record_unlinks","administration_audit_log"]) {
  failure=table;response=await get(35);assert.equal(response.status,500);
  assert.match((await response.json()).error,/Synthetic/);
}
failure=null;
console.log("PASS: current-only synced PWC/BRC; all retained compliance history; source/status evidence; non-expiring BRC; authenticated contractor-view archive metadata; original audit actor/identifier snapshots; pagination/scoping and explicit errors; no mutations");
