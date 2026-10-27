import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
const require=createRequire(import.meta.url),{chromium}=require("playwright");
const appUrl=process.env.TEST_APP_URL;
assert.ok(appUrl&&new URL(appUrl).hostname==="localhost","Only intercepted localhost fixtures allowed");
const env=fs.readFileSync(".env.local","utf8");
const origin=new URL(env.match(/^NEXT_PUBLIC_SUPABASE_URL\s*=\s*["']?([^"'\r\n]+)/m)[1].trim()).origin;
const storageKey=`sb-${new URL(origin).hostname.split(".")[0]}-auth-token`;
const user={id:"00000000-0000-0000-0000-000000000001",email:"synthetic@example.invalid",aud:"authenticated",app_metadata:{},user_metadata:{}};
const candidate={identity:"a".repeat(32),business_name:"Mechanical Associates of New Jersey",certificate_number:"644541",
  address:"Po Box 661",city:"Hawthorne",state:"NJ",zip_code:"07507",county:"Passaic",registration_date:"2026-05-11",
  expiration_date:"2028-05-10",source_url:"https://registry.example.invalid/details"};
const posts=[],gets=[],retries=[];
let outcome="review",visible=true;
const browser=await chromium.launch({headless:true});
try {
  const context=await browser.newContext({viewport:{width:1366,height:1000}});
  await context.addInitScript(({storageKey,user})=>localStorage.setItem(storageKey,JSON.stringify({
    access_token:"synthetic-token",refresh_token:"synthetic-refresh",token_type:"bearer",
    expires_in:3600,expires_at:Math.floor(Date.now()/1000)+3600,user
  })),{storageKey,user});
  await context.route("**/*",async route=>{
    const request=route.request(),url=new URL(request.url());
    if(url.origin===new URL(appUrl).origin){
      if(url.pathname==="/api/admin/compliance-sync/nj-pwc-select-match"){
        if(request.method()==="GET"){
          gets.push(url.searchParams.get("exception_id"));
          return route.fulfill({json:{selection:{exception_id:294,contractor_id:684,company_name:"Mechanical Associates of NJ",
            search_request_id:3626,is_test:false,snapshot:"b".repeat(32),candidates:[candidate,{...candidate,
              identity:"c".repeat(32),business_name:"Other Mechanical Company",certificate_number:"999999",source_url:"javascript:alert(1)"}]}}});
        }
        posts.push(request.postDataJSON());
        if(outcome==="stale")return route.fulfill({status:409,json:{error:"Stored registry selection changed. Reload candidates."}});
        if(outcome==="applied")visible=false;
        return route.fulfill({json:{ok:true,message:outcome==="review"?"Sent to PWC Review (Name Mismatch). The exception remains open pending review."
          :"Synced NJ PWC compliance record applied; Multiple Matches resolved."}});
      }
      if(url.pathname==="/api/admin/compliance-sync/nj-pwc-sync-exceptions"){
        if(request.method()==="POST"){
          retries.push(request.postDataJSON());return route.fulfill({json:{ok:true,search_request_id:3627,created:true}});
        }
        return route.fulfill({json:{test_mode:false,active_run:null,health:{open_exceptions:3,review_required:0,expired_by_sync:0,registry_unavailable:0},
          exceptions:visible?[
            {id:294,contractor_id:684,contractor:"Mechanical Associates of NJ",reason:"Multiple Matches",kind:"failure",is_test:false,can_select_match:true},
            {id:295,contractor_id:685,contractor:"No Stored Candidates",reason:"Multiple Matches",kind:"failure",can_select_match:false},
            {id:296,contractor_id:686,contractor:"No Match Contractor",reason:"No Match Found",kind:"failure",can_select_match:false}
          ]:[]}});
      }
      if(url.pathname==="/api/admin/compliance-sync/registration-unlink")return route.fulfill({json:{contractors:[]}});
      if(url.pathname==="/api/admin/compliance-sync/nj-pwc-orphaned-requests")return route.fulfill({json:{requests:[]}});
      if(url.pathname==="/api/admin/compliance-sync/worker-health")return route.fulfill({json:{overall:"offline",workers:[]}});
      if(url.pathname.startsWith("/api/"))return route.fulfill({json:{profile:{auth_user_id:user.id,name:"Synthetic",email:user.email,
        role:"Administrator",status:"Active",system_administrator:true},permissions:["dashboard","imports","contractors","compliance",
          "insurance","projects","followups","compliance_sync"].map(module=>({module,can_view:true,can_manage:true,can_add:true,can_edit:true,can_delete:true}))}});
      return route.continue();
    }
    assert.equal(url.origin,origin,"External requests are blocked");
    if(url.pathname.startsWith("/auth/"))return route.fulfill({json:user});
    assert.ok(["GET","HEAD"].includes(request.method()),"Shared writes are blocked");
    return route.fulfill({json:url.pathname.endsWith("/compliance_sync_settings")?[{id:1,compliance_name:"NJ PWC",enabled:true,
      mode:"review_required",sync_source:"RPA",test_mode:false,failure_expire_threshold:3}]:[]});
  });
  const page=await context.newPage(),errors=[];
  page.on("pageerror",error=>errors.push(error.message));
  page.on("dialog",dialog=>dialog.accept());
  const visit=async()=>{await page.goto(`${appUrl}/admin/compliance-sync`);await page.getByRole("tab",{name:"NJ PWC",exact:true}).click();};
  const action=()=>page.getByRole("button",{name:"Select Match",exact:true});
  const dialog=()=>page.getByRole("dialog",{name:"Select NJ PWC Match"});
  const confirm=()=>dialog().getByRole("button",{name:"Confirm Selection"});
  await visit();await action().waitFor();assert.equal(await action().count(),1);
  const group=page.getByLabel("NJ PWC exception actions for Mechanical Associates of NJ",{exact:true});
  const boxes=await group.locator("button,a").evaluateAll(elements=>elements.map(e=>{
    const r=e.getBoundingClientRect();return {height:r.height,top:r.top,outline:getComputedStyle(e).outlineStyle};
  }));
  assert.ok(boxes.every(b=>b.height===28),"Exception controls are exactly 28px tall");
  assert.equal(new Set(boxes.map(b=>Math.round(b.top))).size,1,`Desktop actions share a single row: ${JSON.stringify(boxes)}`);
  const colors=await group.locator("button").evaluateAll(elements=>elements.map(element=>{
    const style=getComputedStyle(element),context=document.createElement("canvas").getContext("2d");
    const luminance=color=>{
      context.fillStyle=color;context.fillRect(0,0,1,1);
      const channels=[...context.getImageData(0,0,1,1).data].slice(0,3).map(n=>n/255)
        .map(n=>n<=0.04045?n/12.92:((n+0.055)/1.055)**2.4);
      return channels[0]*0.2126+channels[1]*0.7152+channels[2]*0.0722;
    };
    const a=luminance(style.color),b=luminance(style.backgroundColor);
    return {background:style.backgroundColor,contrast:(Math.max(a,b)+0.05)/(Math.min(a,b)+0.05)};
  }));
  assert.ok(colors.every(color=>color.contrast>=4.5),`Compact buttons retain readable contrast: ${JSON.stringify(colors)}`);
  assert.equal(new Set(colors.map(color=>color.background)).size,3,"Select, retry and resolve remain color-distinct");
  await action().focus();await page.keyboard.press("Tab");await page.keyboard.press("Shift+Tab");
  assert.ok(await action().evaluate(e=>parseFloat(getComputedStyle(e).outlineWidth)>0&&getComputedStyle(e).outlineStyle!=="none"),"Keyboard focus is visible");
  await action().click();await dialog().getByRole("radio").first().waitFor();
  assert.ok(gets.length>0&&gets.every(id=>id==="294"),"Candidate reads use only the selected exception");
  assert.equal(await dialog().getByRole("radio",{checked:true}).count(),0);
  assert.equal(await confirm().isDisabled(),true);
  for(const text of ["Certificate 644541","Po Box 661, Hawthorne, NJ, 07507","County: Passaic","2026-05-11","2028-05-10"])
    assert.ok((await dialog().textContent()).includes(text),text);
  assert.equal(await dialog().getByRole("link",{name:"Registry source"}).count(),1,"Unsafe source links are not rendered");
  await dialog().getByRole("radio").first().check();assert.equal(await confirm().isDisabled(),true);
  await dialog().getByRole("checkbox").check();assert.equal(await confirm().isEnabled(),true);
  await dialog().getByRole("radio").nth(1).check();assert.equal(await dialog().getByRole("checkbox").isChecked(),false);
  await dialog().getByRole("radio").nth(1).focus();await page.keyboard.press("Shift+Tab");
  assert.equal(await dialog().getByRole("link",{name:"Registry source"}).evaluate(e=>e===document.activeElement),true,"Only the selected radio is a tab stop");
  await page.keyboard.press("Shift+Tab");
  assert.equal(await dialog().getByRole("button",{name:"Cancel"}).evaluate(e=>e===document.activeElement),true,"Focus trap respects the selected radio group's tab stop");
  await dialog().getByRole("radio").first().check();await dialog().getByRole("checkbox").check();
  outcome="stale";await confirm().click();await dialog().getByRole("alert").waitFor();
  assert.match(await dialog().getByRole("alert").textContent(),/selection changed/);
  assert.deepEqual(posts[0],{exception_id:294,search_request_id:3626,candidate_identity:candidate.identity,snapshot:"b".repeat(32),confirmed:true});
  await dialog().getByRole("button",{name:"Cancel"}).click();await action().waitFor();
  assert.equal(await action().evaluate(e=>e===document.activeElement),true,"Focus returns to the opener");
  await page.setViewportSize({width:390,height:844});await action().click();
  await dialog().getByRole("radio").first().waitFor();assert.equal(await dialog().getByRole("radio",{checked:true}).count(),0);
  assert.equal(await dialog().evaluate(e=>e.scrollWidth<=e.clientWidth),true);
  assert.equal(await confirm().evaluate(e=>e.getBoundingClientRect().height),28);
  await dialog().getByRole("button",{name:"Cancel"}).focus();await page.keyboard.press("Shift+Tab");
  assert.equal(await dialog().evaluate(e=>e.contains(document.activeElement)),true);
  await page.keyboard.press("Escape");assert.equal(await dialog().count(),0);
  const mobileBoxes=await group.locator("button,a").evaluateAll(es=>es.map(e=>{const r=e.getBoundingClientRect();return {height:r.height,top:r.top};}));
  assert.ok(mobileBoxes.every(b=>b.height===28));assert.ok(new Set(mobileBoxes.map(b=>b.top)).size>1,"Mobile actions wrap");
  outcome="review";await action().click();await dialog().getByRole("radio").first().check();
  await dialog().getByRole("checkbox").check();await confirm().click();
  await page.getByText(/Sent to PWC Review \(Name Mismatch\)/).waitFor();
  assert.equal(await dialog().count(),0);assert.equal(await action().count(),1,"Review does not pretend the open exception was applied");
  await group.getByRole("button",{name:"Run Search Again",exact:true}).click();
  assert.deepEqual(retries,[{action:"retry",exception_id:294}],"Existing retry payload unchanged");
  outcome="applied";await action().click();await dialog().getByRole("radio").first().check();
  await dialog().getByRole("checkbox").check();await confirm().click();
  await page.getByText(/Synced NJ PWC compliance record applied/).waitFor();
  await page.getByText("No open NJ PWC sync exceptions.",{exact:true}).waitFor();
  assert.deepEqual(errors,[]);
  console.log("PASS Select Match UI: stored candidates, explicit consent, stale error, Review/applied, retry, focus, 28px desktop/mobile controls; all APIs intercepted.");
} finally {await browser.close();}
