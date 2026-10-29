import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
const require=createRequire(import.meta.url);
const {chromium}=require("playwright");
const appUrl=process.env.TEST_APP_URL;
assert.ok(appUrl && new URL(appUrl).hostname==="localhost","Only isolated localhost browser fixtures");
const env=fs.readFileSync(".env.local","utf8");
const origin=new URL(env.match(/^NEXT_PUBLIC_SUPABASE_URL\s*=\s*["']?([^"'\r\n]+)/m)[1].trim()).origin;
const storageKey=`sb-${new URL(origin).hostname.split(".")[0]}-auth-token`;
const user={id:"00000000-0000-0000-0000-000000000001",email:"synthetic@example.invalid",aud:"authenticated",app_metadata:{},user_metadata:{}};
let manager=true,fail=false,archiveFixture=false,historyError=false;
const writes=[],searches=[];
const company={id:5,company_name:"Synthetic Correction Contractor",active:true,nj_pwc_number:"PWC-WRONG",nj_brc_number:"BRC-WRONG",
  brc_name_control:"SYNT",city:"Newark",state:"NJ",zip_code:"07102"};
const record=(id,number,name)=>({id,registration_number:number,synced_registration_number:number,certificate_number:number,
  matched_business_entity_id:number,matched_company_name:name,searched_name_control:"SYNT",effective_date:"2025-01-01",
  expiration_date:"2099-12-31",verified_date:"2026-10-21",verification_source:"Synthetic Registry",
  active:true,is_current:true,updated_at:"2026-10-21T10:00:00Z",supplies_identifier:id%2===0,unlinked_at:null});
const data={"NJ PWC":[record(10,"PWC-WRONG","Wrong PWC Company"),record(11,"PWC-KEEP","Remaining PWC Company")],
  "NJ BRC":[record(20,"BRC-WRONG","Wrong BRC Company")]};
const archivedRows=[
  {...data["NJ PWC"][0],contractor_id:5,compliance_type_id:6,compliance_types:{compliance_name:"NJ PWC",requires_expiration:true},registry_status:"OK",source_url:"https://example.invalid/registry"},
  {...data["NJ BRC"][0],contractor_id:5,compliance_type_id:7,compliance_types:{compliance_name:"NJ BRC",requires_expiration:false},expiration_date:null},
];
const historyMetadata=()=>archivedRows.filter(row=>!row.active).map(row=>({record_id:row.id,reason:"Wrong company identity; preserve history",
  unlinked_at:"2026-10-21T12:00:00Z",administrator:"Original Administrator",record_company_name:row.matched_company_name,
  identifiers:{previous:row.registration_number,resulting:null}}));
const browser=await chromium.launch({headless:true});
try {
  const context=await browser.newContext({viewport:{width:1440,height:1000}});
  await context.addInitScript(({storageKey,user})=>localStorage.setItem(storageKey,JSON.stringify({
    access_token:"synthetic-token",refresh_token:"synthetic-refresh",token_type:"bearer",
    expires_in:3600,expires_at:Math.floor(Date.now()/1000)+3600,user,
  })),{storageKey,user});
  await context.route("**/*",async route=>{
    const request=route.request(),url=new URL(request.url());
    if(url.origin===new URL(appUrl).origin) {
      if(url.pathname==="/api/admin/compliance-sync/nj-brc-queue") return route.fulfill({json:{
        rows:[],counts:{all:0,ready:0,existing_brc:0,missing_information:0,needs_review:0,verified:0,no_result:0,failed:0},
        total_filtered:0,page:1,page_size:25,
      }});
      if(url.pathname==="/api/admin/compliance-sync/nj-brc-sessions") return route.fulfill({json:{sessions:[]}});
      if(url.pathname==="/api/contractors/5/compliance-history") {
        assert.equal(request.method(),"GET");
        return route.fulfill(historyError?{status:503,json:{error:"Synthetic history unavailable"}}:{json:{unlinks:historyMetadata()}});
      }
      if(url.pathname==="/api/admin/compliance-sync/registration-unlink") {
        if(request.method()==="POST") {
          const body=request.postDataJSON();writes.push(body);
          if(fail) return route.fulfill({status:409,json:{error:"Registration changed; reload before confirming"}});
          const rows=data[body.compliance],r=rows.find(r=>r.id===body.record_id);
          r.active=false;r.is_current=false;r.supplies_identifier=false;r.unlinked_at="2026-10-21T12:00:00Z";
          const remaining=rows.find(r=>r.active&&r.is_current);
          if(remaining) remaining.supplies_identifier=true;
          company[body.compliance==="NJ PWC"?"nj_pwc_number":"nj_brc_number"]=remaining?.registration_number??null;
          return route.fulfill({json:{result:{compliance_record_id:r.id}}});
        }
        assert.equal(request.method(),"GET");
        return route.fulfill({json:url.searchParams.has("contractor_id")
          ?{contractor:company,records:data[url.searchParams.get("compliance")]}
          :{contractors:[company,{id:6,company_name:"Unrelated Inactive Contractor",active:false}]}});
      }
      if(url.pathname==="/api/contractors/nj-pwc-search"||url.pathname==="/api/contractors/nj-brc-search") {
        if(request.method()==="GET") return route.fulfill({json:{request:null}});
        assert.equal(request.method(),"POST");searches.push({path:url.pathname,body:request.postDataJSON()});
        return route.fulfill({json:{search_request_id:999,request:{id:"synthetic"}}});
      }
      if(url.pathname.endsWith("nj-pwc-sync-exceptions")) return route.fulfill({json:{test_mode:false,exceptions:[],health:null,active_run:null}});
      if(url.pathname.endsWith("orphaned-requests")) return route.fulfill({json:{requests:[],age_threshold_minutes:10}});
      if(url.pathname.endsWith("worker-health")) return route.fulfill({json:{overall:"offline",workers:[]}});
      if(url.pathname.startsWith("/api/")) {
        assert.ok(request.method()==="GET" || ["/api/auth/session","/api/admin/bootstrap"].includes(url.pathname),`No unexpected API mutations allowed: ${request.method()} ${url.pathname}`);
        return route.fulfill({json:{
          profile:{auth_user_id:user.id,name:"Synthetic",email:user.email,role:manager?"Administrator":"Read Only",status:"Active",system_administrator:false},
          permissions:["dashboard","compliance_sync","contractors","compliance","insurance","projects","followups"].map(module=>({
            module,can_view:true,can_manage:manager,can_add:manager,can_edit:manager,can_delete:manager,
          })),
        }});
      }
      return route.continue();
    }
    assert.equal(url.origin,origin,"Unexpected external request blocked");
    if(url.pathname.startsWith("/auth/")) return route.fulfill({json:user});
    assert.ok(["GET","HEAD"].includes(request.method()),"All real database mutations blocked");
    if(archiveFixture) {
      let rows=url.pathname.endsWith("/contractors")?[company]
        :url.pathname.endsWith("/compliance_records")?archivedRows:[];
      for(const [key,value] of url.searchParams) {
        if(value.startsWith("eq.")) rows=rows.filter(r=>String(r[key])===value.slice(3));
        if(key==="contractor_id"&&value.startsWith("in.(")) rows=rows.filter(r=>value.slice(4,-1).split(",").includes(String(r.contractor_id)));
      }
      return route.fulfill({json:(request.headers().accept??"").includes("vnd.pgrst.object")?rows[0]??null:rows});
    }
    return route.fulfill({json:[]});
  });
  const page=await context.newPage();
  const errors=[];page.on("pageerror",error=>errors.push(error.message));
  await page.goto(`${appUrl}/admin/compliance-sync`);
  for(const type of ["NJ PWC","NJ BRC"]) {
    await page.getByRole("tab",{name:type,exact:true}).click();
    const panel=page.getByRole("region",{name:`${type} administrative unlink`});
    const combo=panel.getByRole("combobox",{name:"Search all contractors"});
    await combo.fill("inactive");
    await panel.getByRole("option",{name:/Unrelated Inactive/}).waitFor();
    await combo.fill("Correction");
    await panel.getByRole("option",{name:/Synthetic Correction/}).click();
    const article=panel.getByRole("article",{name:`Registration record ${type==="NJ PWC"?10:20}`});
    await article.getByText(/Supplies Contractor Card identifier: Yes/).waitFor();
    await article.getByText(type==="NJ PWC"?"Record business/company: Wrong PWC Company":"Record business/company: Wrong BRC Company",{exact:true}).waitFor();
    if(type==="NJ BRC") {
      await article.getByText(/Business Entity ID: BRC-WRONG/).waitFor();
      await article.getByText(/Non-expiring/).waitFor();
    }
    await article.getByRole("button",{name:"Remove / Unlink Record"}).click();
    const dialog=page.getByRole("dialog",{name:`Confirm ${type} Unlink`});
    await dialog.getByText(/synced .* may be cleared/).waitFor();
    const confirm=dialog.getByRole("button",{name:"Confirm Unlink",exact:true});
    assert.equal(await confirm.isDisabled(),true);
    await dialog.getByLabel("Reason for Removal").fill(" \n ");
    assert.equal(await confirm.isDisabled(),true);
    await dialog.getByRole("button",{name:"Cancel",exact:true}).click();
    assert.equal(writes.length,type==="NJ PWC"?0:2,"Cancel makes no requests");
    await article.getByRole("button",{name:"Remove / Unlink Record"}).click();
    await dialog.getByLabel("Reason for Removal").fill("Wrong company identity; preserve history");
    if(type==="NJ PWC") {
      fail=true;
      await confirm.click();
      await dialog.getByRole("alert").getByText(/Registration changed/).waitFor();
      assert.equal(data[type][0].active,true);
      fail=false;
    }
    await confirm.click();
    await panel.getByText("Record unlinked and archived. Rescan this contractor to locate and review the correct registration.",{exact:true}).waitFor();
    assert.equal(searches.length,type==="NJ PWC"?0:1,"Unlink does not start scans");
    await article.getByText(/Previously unlinked/).waitFor();
    if(type==="NJ PWC") {
      await panel.getByRole("article",{name:"Registration record 11"}).getByText(/Supplies Contractor Card identifier: Yes/).waitFor();
      assert.equal(company.nj_pwc_number,"PWC-KEEP");
    } else assert.equal(company.nj_brc_number,null);
    const scan=panel.getByRole("button",{name:`Queue ${type} Rescan`});
    page.once("dialog",dialog=>dialog.dismiss());
    await scan.click();
    assert.equal(searches.length,type==="NJ PWC"?0:1);
    page.once("dialog",dialog=>dialog.accept());
    await scan.click();
    await panel.getByText(new RegExp(`${type} search queued`)).waitFor();
  }
  assert.equal(writes.length,3);
  assert.ok(writes.every(body=>body.reason.trim()&&body.confirmed===true));
  assert.deepEqual(searches.map(r=>r.path),["/api/contractors/nj-pwc-search","/api/contractors/nj-brc-search"]);
  manager=false;
  await page.reload();
  await page.getByRole("tab",{name:"NJ PWC",exact:true}).click();
  assert.equal(await page.getByRole("region",{name:"NJ PWC administrative unlink"}).count(),0,"View-only user has no correction controls");
  archiveFixture=true;
  archivedRows.forEach(row=>{row.active=false;row.is_current=false;});
  company.nj_pwc_number=null;company.nj_brc_number=null;
  const loadHistory=async()=>{
    await page.goto(`${appUrl}/contractors/5`);
    await page.getByRole("heading",{name:company.company_name,exact:true}).waitFor();
    await page.getByRole("button",{name:"Company History",exact:true}).click();
    await page.getByRole("button",{name:"Compliance History",exact:true}).click();
    await page.getByRole("status").filter({hasText:"Loading administrative compliance history"}).waitFor({state:"hidden"});
  };
  await loadHistory();
  const synced=page.getByRole("heading",{name:"Synced Compliance Records",exact:true}).locator("..").locator("..");
  assert.equal(await synced.getByRole("table").locator("tbody tr").count(),0,"No inactive/unlinked records in current synced display");
  const history=page.getByRole("table",{name:"Compliance History",exact:true});
  for(const number of ["PWC-WRONG","BRC-WRONG"]) {
    const row=history.getByRole("row").filter({has:page.getByRole("cell",{name:number,exact:true})});
    await row.getByText("Archived / Administratively unlinked",{exact:true}).waitFor();
    await row.getByText("Administrator: Original Administrator",{exact:true}).waitFor();
    await row.getByText("Reason: Wrong company identity; preserve history",{exact:true}).waitFor();
    await row.getByText(/^Unlinked:/).waitFor();
  }
  await history.getByText("Non-expiring",{exact:true}).waitFor();
  await history.getByText("Retained registry status: OK",{exact:true}).waitFor();
  await history.getByText("Source URL: https://example.invalid/registry",{exact:true}).waitFor();
  archivedRows.push({...record(30,"PWC-CORRECT","Correct PWC Company"),contractor_id:5,compliance_type_id:6,
    compliance_types:{compliance_name:"NJ PWC",requires_expiration:true}});
  await loadHistory();
  await page.getByRole("heading",{name:"Synced Compliance Records",exact:true}).waitFor();
  await synced.getByRole("cell",{name:"PWC-CORRECT",exact:true}).waitFor();
  assert.doesNotMatch(await synced.innerText(),/PWC-WRONG|BRC-WRONG/);
  assert.equal(await history.getByText("Archived / Administratively unlinked",{exact:true}).count(),2,"Corrected current record never removes archived history");
  historyError=true;await loadHistory();
  await page.getByRole("alert").getByText("Synthetic history unavailable",{exact:true}).waitFor();
  assert.equal(writes.length,3,"Opening card/history never performs another unlink");
  assert.equal(searches.length,2,"Opening card/history never performs a rescan");
  assert.deepEqual(errors,[]);
  console.log("PASS: rendered desktop all-contractor searchable dropdown; record identities/current badges; BRC non-expiring; mandatory reason/confirm/cancel; errors without fake success; replacement/blank card values; preserved history; explicit existing rescan actions only; view-only controls hidden; all mutations intercepted");
} finally { await browser.close(); }
