import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
import ts from "typescript";
import * as XLSX from "xlsx";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const appUrl = process.env.TEST_APP_URL;
assert(appUrl && new URL(appUrl).hostname === "localhost", "Intercepted localhost fixtures only");
const env = fs.readFileSync(".env.local", "utf8");
const origin = new URL(env.match(/^NEXT_PUBLIC_SUPABASE_URL\s*=\s*["']?([^"'\r\n]+)/m)[1].trim()).origin;
const storageKey = `sb-${new URL(origin).hostname.split(".")[0]}-auth-token`;
const user = { id: "00000000-0000-0000-0000-000000000001", email: "fixture@example.invalid", aud: "authenticated", app_metadata: {}, user_metadata: {} };
const cache = new Map();
function load(name) {
  if (cache.has(name)) return cache.get(name);
  const mod = { exports: {} };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(name, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { module: mod, exports: mod.exports, require: (id) =>
    load(id.replace("@/lib/", "src/lib/").replace("@/types/", "types/") + ".ts") });
  cache.set(name, mod.exports); return mod.exports;
}
const { buildProcorePreview } = load("src/lib/procore-preview.ts");
const { PROCORE_HEADINGS } = load("types/procore-import.ts");
const source = [];
for (let i = 0; i < 6000; i++) {
  source.push({ row: i + 2, ...Object.fromEntries(PROCORE_HEADINGS.map((h) => [h, ""])),
    "Company (Vendor) > Name": i < 5996 ? "Existing Fixture" : i === 5996 ? "New Fixture" : i === 5997 ? "Unmatched Fixture" : "Staged Fixture",
    "Project > Number": i < 5998 ? "22-002" : "UNKNOWN",
    "Company (Vendor) > Business Phone": "2015551111", "User > Full Name": i % 2 ? "" : "Fixture Contact",
    "User > Email Address": i % 2 ? "" : "person@example.invalid",
    "User > Business Phone": i % 2 ? "" : "2015552222", "User > Cell Phone": i % 2 ? "" : "2015553333" });
}
const book = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([PROCORE_HEADINGS, ...source.map((r) => PROCORE_HEADINGS.map((h) => r[h]))]), "Report");
const buffer = XLSX.write(book, { type: "buffer", bookType: "xlsx" });
const reference = { token: "fixture-token", contractors: [{ id: 1, company_name: "Existing Fixture", active: true }],
  projects: [{ id: 1, project_number: "22-002", project_name: "Fixture Project" }], vendors: [], contacts: [] };
let run = null;
let imports = 0;
let adds = 0;
let finalizations = 0;
let failSave = false;
let failImport = false;
let viewer = false;
let missingMigration = false;
let savedContact = null;
let uploadSource = source;
let runSequence = 0;
let shrinkOnSave = false;
let saveAttempts = 0;
const contacts = [];
const response = () => run.finalized_at ? { run, ...run.finalized_review, token: "" } : ({
  run, preview: buildProcorePreview(run.source_rows, run.decisions, reference, run.imported_rows),
  contractors: reference.contractors, projects: reference.projects, token: reference.token,
});
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(({ storageKey, user }) => localStorage.setItem(storageKey, JSON.stringify({
    access_token: "fixture-token", refresh_token: "fixture-refresh", token_type: "bearer", expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600, user,
  })), { storageKey, user });
  await context.route("**/*", async (route) => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    if (url.origin === new URL(appUrl).origin) {
      if (url.pathname === "/api/admin/bootstrap") return route.fulfill({ json: {} });
      if (url.pathname === "/api/auth/session") return route.fulfill({ json: {
        profile: { auth_user_id: user.id, name: "Fixture", email: user.email, role: "Administrator", status: "Active", system_administrator: false },
        permissions: ["dashboard", "imports", "insurance", "projects", "contractors", "compliance", "followups"].map((module) =>
          ({ module, can_view: true, can_manage: !viewer, can_add: !viewer, can_edit: !viewer, can_delete: false })),
      } });
      if (url.pathname.startsWith("/api/imports/mycoi")) {
        assert.equal(method, "GET", "Procore never mutates myCOI");
        return route.fulfill({ json: { runs: [] } });
      }
      if (url.pathname.startsWith("/api/imports/procore")) {
        if (missingMigration) return route.fulfill({ status: 503, json: { error: "Requires 20261110_procore_import_workflow.sql; install before use." } });
        if (method === "GET" && url.pathname === "/api/imports/procore") {
          return route.fulfill({ json: { runs: run && (!!run.finalized_at === (url.searchParams.get("scope") === "finalized")) ? [run] : [] } });
        }
        if (method === "POST" && url.pathname === "/api/imports/procore") {
          run = { id: `00000000-0000-0000-0000-${String(10 + runSequence++).padStart(12, "0")}`, file_name: "fixture.xlsx", revision: 1,
            created_at: new Date().toISOString(), source_rows: uploadSource, source_row_count: uploadSource.length, decisions: { vendors: {} },
            imported_rows: [], finalized_at: null, finalized_review: null, status: "Review" };
          return route.fulfill({ json: response() });
        }
        if (url.pathname.endsWith("/finalize")) {
          if (method === "GET") return route.fulfill({ json: { revision: run.revision, token: reference.token, summary: response().preview.summary } });
          assert.equal(request.postDataJSON().confirmed, true);
          const frozen = response(); run.finalized_review = { preview: frozen.preview, contractors: frozen.contractors, token: "" };
          run.finalized_at = new Date().toISOString(); run.revision++; finalizations++;
          return route.fulfill({ json: { result: { finalized_at: run.finalized_at } } });
        }
        if (method === "PATCH" && url.pathname.endsWith("/projects")) {
          const body = request.postDataJSON();
          assert.equal(body.revision, run.revision);
          assert.equal(body.token, reference.token);
          reference.projectMappings ??= [];
          reference.projectMappings = reference.projectMappings.filter((m) => m.source_number !== body.number);
          reference.projectMappings.push({ source_number: body.number, project_id: body.projectId });
          run.revision++;
          return route.fulfill({ json: response() });
        }
        if (method === "PATCH") {
          saveAttempts++;
          if (failSave) return route.fulfill({ status: 409, json: { error: "Fixture stale review; reload." } });
          run.decisions = request.postDataJSON().decisions; run.revision++;
          for (const decision of Object.values(run.decisions.vendors)) {
            if (decision.duplicateOverride) {
              decision.duplicateOverride.approvedBy = user.id;
              decision.duplicateOverride.approvedAt ??= new Date().toISOString();
            }
          }
          if (shrinkOnSave) {
            run.source_rows = run.source_rows.filter((row) => Number(row["Company (Vendor) > Name"].slice(-3)) < 940);
            run.source_row_count = run.source_rows.length;
            shrinkOnSave = false;
          }
        }
        if (method === "POST") {
          if (failImport) return route.fulfill({ status: 503, json: { error: "Procore import timed out. The import transaction was rolled back; no import changes were committed. Your saved review decisions and project mappings were not cleared. Do not retry until the timeout has been reviewed." } });
          assert(!run.finalized_at); imports++;
          for (const plan of response().preview.ready) {
            if (plan.createContractor) {
              adds++; plan.contractorId = Math.max(...reference.contractors.map(c => c.id)) + 1;
              reference.contractors.push({ id: plan.contractorId, company_name: plan.company.company_name, active: true });
            }
            reference.vendors.push({ vendor_key: plan.key, contractor_id: plan.contractorId });
            run.imported_rows.push(...plan.rows);
          }
          run.revision++; run.status = "Partial";
        }
        return route.fulfill({ json: response() });
      }
      if (url.pathname.startsWith("/api/")) { assert.equal(method, "GET"); return route.fulfill({ json: { unlinks: [] } }); }
      return route.continue();
    }
    assert.equal(url.origin, origin, "No external traffic outside intercepted Supabase");
    if (url.pathname.startsWith("/auth/")) return route.fulfill({ json: user });
    if (url.pathname.endsWith("/rpc/save_contractor_contact")) {
      assert.equal(method, "POST");
      savedContact = request.postDataJSON();
      const saved = { ...savedContact.p_values, id: "00000000-0000-0000-0000-000000000020", contractor_id: 1 };
      contacts.push(saved); return route.fulfill({ json: saved });
    }
    assert(["GET", "HEAD"].includes(method), `Unexpected database mutation blocked: ${method} ${url.pathname}`);
    const table = url.pathname.split("/").at(-1);
    let rows = table === "contractors" ? [{ id: 1, company_name: "Existing Fixture", active: true, phone: "COMPANY PHONE" }]
      : table === "contractor_contacts" ? contacts : [];
    if ((request.headers().accept ?? "").includes("vnd.pgrst.object")) rows = rows[0] ?? null;
    return route.fulfill({ json: rows });
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${appUrl}/imports`);
  const section = page.getByRole("region", { name: "Procore Import", exact: true });
  await section.waitFor();
  assert((await page.getByRole("region", { name: "myCOI Insurance Import", exact: true }).boundingBox()).y < (await section.boundingBox()).y);
  await section.getByLabel("Procore report", { exact: true }).setInputFiles({ name: "fixture.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer });
  await section.getByRole("heading", { name: "Review: fixture.xlsx", exact: true }).waitFor();
  assert.equal(await section.getByRole("button", { name: "Match Contractor", exact: true }).count(), 4, "Unique companies, not 6000 row controls");
  assert((await section.innerText()).includes("6000"));
  await section.getByLabel("Match contractor for Existing Fixture", { exact: true }).selectOption("1");
  failSave = true;
  await section.getByRole("button", { name: "Match Contractor", exact: true }).first().click();
  await section.getByRole("alert").filter({ hasText: "Fixture stale" }).waitFor();
  failSave = false;
  await section.getByRole("button", { name: "Match Contractor", exact: true }).first().click();
  await section.getByText("Matched contractor #1", { exact: false }).waitFor();
  const vendor = (name) => section.locator("article").filter({ has: page.getByRole("heading", { name, exact: true }) });
  await vendor("New Fixture").getByRole("button", { name: "Add Contractor", exact: true }).click();
  await vendor("New Fixture").getByText("Add Contractor staged", { exact: false }).waitFor();
  assert.equal(adds, 0, "Staged Add is not executed while reviewing");
  await vendor("Staged Fixture").getByRole("button", { name: "Add Contractor", exact: true }).click();
  await vendor("Staged Fixture").getByText("Add Contractor staged", { exact: false }).waitFor();
  await vendor("Unmatched Fixture").getByRole("button", { name: "Leave Unmatched", exact: true }).click();
  const buttonMetrics = await vendor("New Fixture").getByRole("button", { name: "ADD saved", exact: true }).evaluate((b) =>
    ({ height: b.getBoundingClientRect().height, background: getComputedStyle(b).backgroundColor }));
  assert.equal(buttonMetrics.height, 28); assert.equal(buttonMetrics.background, "rgb(226, 232, 240)");
  await section.getByRole("button", { name: "Import Resolved Records", exact: true }).click();
  await section.getByRole("status").filter({ hasText: "completed" }).waitFor();
  assert.equal(imports, 1); assert.equal(adds, 1);
  await section.getByRole("button", { name: "Finalize Procore Import", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Finalize Procore Import", exact: true });
  await dialog.waitFor(); await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(finalizations, 0);
  await section.getByRole("button", { name: "Finalize Procore Import", exact: true }).click();
  await dialog.getByRole("button", { name: "Confirm Finalize", exact: true }).click();
  await section.getByText("Finalized — read-only", { exact: true }).waitFor();
  assert.equal(finalizations, 1); assert.equal(adds, 1);
  assert.equal(await section.getByRole("button", { name: "Match Contractor", exact: true }).count(), 0);
  assert.equal(await section.getByRole("button", { name: "Import Resolved Records", exact: true }).count(), 0);
  const history = section.locator("details").filter({ has: page.locator("summary", { hasText: "Procore Import History" }) });
  assert.equal(await history.getAttribute("open"), null);
  await history.locator("summary").click();
  await history.getByRole("button", { name: "Review History fixture.xlsx", exact: true }).waitFor();
  await history.getByRole("button", { name: "Review History fixture.xlsx", exact: true }).click();
  await section.getByRole("heading", { name: "Review History: fixture.xlsx", exact: true }).waitFor();
  uploadSource = Array.from({ length: 5500 }, (_, index) => ({
    ...source[0], row: index + 2, "Company (Vendor) > Name": `Pagination ${String(index % 960).padStart(3, "0")}`,
    "User > Full Name": "", "User > Email Address": "",
  }));
  await section.getByLabel("Procore report", { exact: true }).setInputFiles({ name: "pagination.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer });
  const pageField = section.getByRole("spinbutton", { name: "Contractor review page", exact: true });
  const previous = section.getByRole("button", { name: "Previous review page", exact: true }).first();
  const next = section.getByRole("button", { name: "Next review page", exact: true }).first();
  const go = section.getByRole("button", { name: "Go", exact: true });
  const waitPage = async (number) => {
    await page.waitForFunction((value) => document.querySelector('[aria-label="Contractor review page"]')?.value === String(value), number);
    assert.equal(await section.getByRole("button", { name: "Match Contractor", exact: true }).count(), 20,
      "Only the current 20 unique candidates are rendered");
  };
  const jump = async (number, enter = false) => {
    await pageField.fill(String(number));
    if (enter) await pageField.press("Enter"); else await go.click();
    await waitPage(Math.min(48, Math.max(1, number)));
  };
  const saveDecision = async (name, action, expectedPage) => {
    const response = page.waitForResponse((r) => r.request().method() === "PATCH" && r.url().includes("/api/imports/procore/"));
    await vendor(name).getByRole("button", { name: action, exact: true }).click();
    assert.equal((await response).status(), 200);
    await page.waitForFunction(() => !Array.from(document.querySelectorAll("button"))
      .find((b) => b.textContent === "Reload Procore Review")?.disabled);
    await waitPage(expectedPage);
  };
  await waitPage(1); assert(await previous.isDisabled());
  assert((await pageField.locator("..").locator("..").innerText()).includes("of 48"));
  await next.click(); await waitPage(2);
  await section.getByLabel("Match contractor for Pagination 020", { exact: true }).selectOption("1");
  await section.getByLabel("Match contractor for Pagination 021", { exact: true }).selectOption("1");
  await previous.click(); await waitPage(1);
  await next.click(); await waitPage(2);
  assert.equal(await section.getByLabel("Match contractor for Pagination 021", { exact: true }).inputValue(), "1",
    "Unsaved selection survives page navigation");
  await saveDecision("Pagination 020", "Match Contractor", 2);
  assert.equal(await section.getByLabel("Match contractor for Pagination 021", { exact: true }).inputValue(), "1",
    "Saving another decision preserves local selections");
  assert.equal(await section.getByLabel("Match contractor for Pagination 020", { exact: true }).inputValue(), "",
    "Only the saved selection is cleared");
  const matchedKey = response().preview.vendors.find((v) => v.name === "Pagination 020").key;
  assert.equal(run.decisions.vendors[matchedKey].action, "MATCH");
  await jump(17);
  await saveDecision("Pagination 320", "Add Contractor", 17);
  await vendor("Pagination 320").getByText("Add Contractor staged", { exact: false }).waitFor();
  assert.equal(adds, 1, "Pagination review does not execute staged Adds");
  await saveDecision("Pagination 321", "Leave Unmatched", 17);
  const unmatchedKey = response().preview.vendors.find((v) => v.name === "Pagination 321").key;
  assert.equal(run.decisions.vendors[unmatchedKey].action, "UNMATCHED");
  const decisions = structuredClone(run.decisions);
  await jump(2, true);
  await vendor("Pagination 020").getByText("Matched contractor #1", { exact: false }).waitFor();
  await jump(17, true);
  await vendor("Pagination 320").getByText("Add Contractor staged", { exact: false }).waitFor();
  assert.deepEqual(run.decisions, decisions, "All saved decisions remain intact across navigation");
  await section.getByRole("button", { name: "Reload Procore Review", exact: true }).click();
  await waitPage(17);
  await jump(2);
  assert.equal(await section.getByLabel("Match contractor for Pagination 021", { exact: true }).inputValue(), "1",
    "Explicit reload preserves other local selections");
  await jump(17);
  for (const width of [1440, 768]) {
    await page.setViewportSize({ width, height: 1000 });
    const metrics = await pageField.evaluate((input) => ({
      inputHeight: input.getBoundingClientRect().height,
      inputWidth: input.getBoundingClientRect().width,
      formWidth: input.form.getBoundingClientRect().width,
      availableWidth: input.closest("section").getBoundingClientRect().width,
    }));
    assert.equal(metrics.inputHeight, 28);
    assert(metrics.inputWidth >= 48 && metrics.inputWidth <= 80, "Page field stays compact");
    assert(metrics.formWidth < metrics.availableWidth, `Compact direct navigation fits narrow screens: ${JSON.stringify({ width, ...metrics })}`);
    assert.equal(await go.evaluate((button) => button.getBoundingClientRect().height), 28);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await jump(0); assert(await previous.isDisabled());
  await jump(999); assert(await next.isDisabled());
  await pageField.fill(""); await go.click(); assert.equal(await pageField.inputValue(), "");
  assert(await next.isDisabled(), "Blank input does not navigate from last page");
  await pageField.fill("1.5"); await pageField.press("Enter"); assert(await next.isDisabled());
  await pageField.evaluate((input) => { input.value = "invalid"; });
  await go.click(); assert(await next.isDisabled(), "Invalid text does not navigate");
  await jump(48);
  shrinkOnSave = true;
  await saveDecision("Pagination 940", "Leave Unmatched", 47);
  assert(await next.isDisabled());
  assert((await pageField.locator("..").locator("..").innerText()).includes("of 47"));
  assert.equal(imports, 1); assert.equal(finalizations, 1, "Pagination never imports or finalizes");
  uploadSource = Array.from({ length: 960 }, (_, index) => ({
    ...source[0], row: index + 2, "Company (Vendor) > Name": `Decision ${String(index).padStart(3, "0")}`,
    "Company (Vendor) > City": "Fixture City",
    "Project > Number": index === 261 ? "25-900" : "22-002",
    "User > Full Name": "", "User > Email Address": "",
  }));
  uploadSource.push({ ...uploadSource[260], row: 962 });
  uploadSource.push({ ...uploadSource[262], row: 963, "Company (Vendor) > City": "Conflicting City" });
  uploadSource.push({ ...uploadSource[263], row: 964, "Project > Number": "OTHER UNKNOWN" });
  await section.getByLabel("Procore report", { exact: true }).setInputFiles({ name: "decisions.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer });
  await waitPage(1);
  const importButton = section.getByRole("button", { name: "Import Resolved Records", exact: true });
  assert(await importButton.isDisabled());
  await saveDecision("Decision 000", "Leave Unmatched", 1);
  const savedOther = structuredClone(run.decisions);
  await jump(14);
  await section.getByLabel("Match contractor for Decision 263", { exact: true }).selectOption("1");
  failSave = true;
  await vendor("Decision 260").getByRole("button", { name: "Add Contractor", exact: true }).click();
  await section.getByRole("alert").filter({ hasText: "Fixture stale review" }).waitFor();
  assert(await vendor("Decision 260").getByRole("button", { name: "Add Contractor", exact: true }).isEnabled(),
    "Failed save must not falsely show ADD saved or lock a retry");
  assert.equal(run.decisions.vendors["decision 260"], undefined);
  failSave = false;
  const beforeSave = saveAttempts, beforeAdds = adds;
  await saveDecision("Decision 260", "Add Contractor", 14);
  const savedAddButton = vendor("Decision 260").getByRole("button", { name: "ADD saved", exact: true });
  assert(await savedAddButton.isDisabled());
  await savedAddButton.evaluate(button => { button.click(); button.click(); });
  assert.equal(saveAttempts, beforeSave + 1, "ADD saves exactly once and repeat clicks cannot resave");
  assert.equal(adds, beforeAdds, "Review never creates a contractor");
  await vendor("Decision 260").getByText(/ADD saved.*contractor decision resolved/).waitFor();
  await vendor("Decision 260").getByText("2 source rows import-ready · 1 project assignments", { exact: true }).waitFor();
  assert(await importButton.isEnabled(), "Eligible saved ADD immediately enables partial Import");
  assert.equal(run.decisions.vendors["decision 000"].action, savedOther.vendors["decision 000"].action);
  assert.equal(await section.getByLabel("Match contractor for Decision 263", { exact: true }).inputValue(), "1");
  await saveDecision("Decision 261", "Add Contractor", 14);
  await vendor("Decision 261").getByText(/Unmatched project number 25-900/).waitFor();
  assert(await vendor("Decision 261").getByRole("button", { name: "ADD saved", exact: true }).isDisabled());
  assert(!response().preview.ready.some(p => p.key === "decision 261"));
  await saveDecision("Decision 262", "Add Contractor", 14);
  await vendor("Decision 262").getByText(/Conflicting company city/).waitFor();
  assert(!response().preview.ready.some(p => p.key === "decision 262"));
  await section.getByLabel("Match contractor for Decision 260", { exact: true }).selectOption("1");
  await saveDecision("Decision 260", "Match Contractor", 14);
  assert.equal(run.decisions.vendors["decision 260"].action, "MATCH");
  await saveDecision("Decision 260", "Add Contractor", 14);
  await saveDecision("Decision 260", "Leave Unmatched", 14);
  assert.equal(run.decisions.vendors["decision 260"].action, "UNMATCHED");
  assert(await importButton.isDisabled(), "Only blocked/unresolved companies remain after changing ADD to Unmatched");
  await saveDecision("Decision 260", "Add Contractor", 14);
  const beforeFailedImport = JSON.stringify({run, reference, imports, adds});
  failImport = true;
  await importButton.click();
  await section.getByRole("alert").filter({hasText:"no import changes were committed"}).waitFor();
  await waitPage(14);
  assert.equal(JSON.stringify({run, reference, imports, adds}), beforeFailedImport);
  assert.equal(await section.getByLabel("Match contractor for Decision 263", {exact:true}).inputValue(),"1");
  assert(await vendor("Decision 260").getByRole("button", {name:"ADD saved",exact:true}).isDisabled());
  failImport = false;
  await importButton.click();
  await section.getByRole("status").filter({ hasText: "completed" }).waitFor();
  await waitPage(14);
  assert.equal(adds, beforeAdds + 1, "Repeated source rows create exactly one contractor on Import");
  const mapping = reference.vendors.find(v => v.vendor_key === "decision 260");
  assert(mapping);
  await vendor("Decision 260").getByText(`Matched contractor #${mapping.contractor_id}`, { exact: false }).waitFor();
  assert(await importButton.isDisabled(), "Already imported rows never create a second contractor");
  assert.equal(run.decisions.vendors["decision 000"].action, "UNMATCHED");
  assert.equal(await section.getByLabel("Match contractor for Decision 263", { exact: true }).inputValue(), "1");
  console.log("PASS: page 14 ADD saves once, resolves immediately, disables repeat Add, recalculates partial Import; specific project/company blockers; ADD to MATCH/UNMATCHED; other saved/unsaved decisions preserved; one creation/mapping for repeated rows; no pagination reset.");
  reference.projects.push({ id: 45, project_number: "25900", project_name: "CHURCH - Montclair" },
    { id: 46, project_number: "24-003", project_name: "Other mapping target" });
  await section.getByRole("button", { name: "Reload Procore Review", exact: true }).click();
  const projectDetails = section.locator("details").filter({ has: page.locator("summary", { hasText: "Projects —" }) });
  await projectDetails.locator("summary").click();
  const projectRow = section.getByLabel("Procore project 25-900", { exact: true });
  await projectRow.getByText("25-900: Unmatched — no project will be created", { exact: true }).waitFor();
  const decisionsBeforeMapping = structuredClone(run.decisions);
  const projectSelect = section.getByLabel("Match project for 25-900", { exact: true });
  const matchProject = projectRow.getByRole("button", { name: "Match Project", exact: true });
  await section.getByLabel("Match project for OTHER UNKNOWN", { exact: true }).selectOption("46");
  await projectSelect.selectOption("45"); await matchProject.click();
  await projectRow.getByText(/MATCHED 25-900 → 25900/).waitFor();
  await waitPage(14);
  const mappedReviewBeforeFailure = JSON.stringify({run,reference,imports,adds});
  failImport = true;
  await importButton.click();
  await section.getByRole("alert").filter({hasText:"no import changes were committed"}).waitFor();
  await waitPage(14);
  assert.equal(JSON.stringify({run,reference,imports,adds}),mappedReviewBeforeFailure);
  await projectRow.getByText(/MATCHED 25-900 → 25900/).waitFor();
  assert.equal(await section.getByLabel("Match contractor for Decision 263", {exact:true}).inputValue(),"1");
  assert.equal(await section.getByLabel("Match project for OTHER UNKNOWN", {exact:true}).inputValue(),"46");
  failImport = false;
  assert(await matchProject.isDisabled(), "Repeat Match disabled until intentional change");
  assert.deepEqual(run.decisions, decisionsBeforeMapping);
  assert.equal(await section.getByLabel("Match contractor for Decision 263", { exact: true }).inputValue(), "1");
  assert.equal(await section.getByLabel("Match project for OTHER UNKNOWN", { exact: true }).inputValue(), "46",
    "Other unsaved project selections are retained");
  assert(await importButton.isEnabled(), "Mapping immediately makes saved ADD assignment-ready");
  assert.equal(response().preview.ready.find(p => p.key === "decision 261").assignments[0].projectId, 45);
  await projectSelect.selectOption("46"); await matchProject.click();
  await projectRow.getByText(/MATCHED 25-900 → 24-003/).waitFor();
  await projectRow.getByRole("button", { name: "Leave Unmatched", exact: true }).click();
  await projectRow.getByText("25-900: Unmatched — no project will be created", { exact: true }).waitFor();
  assert(await importButton.isDisabled());
  await projectSelect.selectOption("45"); await matchProject.click();
  await projectRow.getByText(/MATCHED 25-900 → 25900/).waitFor();
  await waitPage(14);
  assert.equal(adds, beforeAdds + 1, "Mapping creates no contractor or ownership");
  assert.deepEqual(run.decisions, decisionsBeforeMapping);
  console.log("PASS: manual project mapping 25-900 to 25900; saved matched indicator; repeat disabled; intentional rematch and Leave Unmatched; immediate assignment readiness; page 14 and other unsaved/saved selections retained.");
  reference.contractors.push({ id: 80, company_name: "C&V Paving Contractors", active: true },
    { id: 81, company_name: "Alternate Contractor", active: true },
    { id: 82, company_name: "Ambiguous Fixture LLC", active: true },
    { id: 83, company_name: "Ambiguous Fixture Inc.", active: true },
    { id: 84, company_name: "Unknown Project Suggestion", active: true });
  uploadSource = Array.from({ length: 960 }, (_, index) => ({
    ...source[0], row: index + 2, "Company (Vendor) > Name": index === 260 ? "C&V Paving Contractors"
      : index === 261 ? "Unknown Project Suggestion" : index === 263 ? "Ambiguous Fixture" : `Suggestion Review ${String(index).padStart(3, "0")}`,
    "Project > Number": index === 261 || index === 264 ? "UNAPPROVED PROJECT" : "22-002",
    "User > Full Name": "", "User > Email Address": "",
  }));
  await section.getByLabel("Procore report", { exact: true }).setInputFiles({ name: "suggestions.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer });
  await waitPage(1);
  await saveDecision("Suggestion Review 000", "Leave Unmatched", 1);
  await jump(14);
  const suggestionVendor = vendor("C&V Paving Contractors");
  const acceptSuggestion = suggestionVendor.getByRole("button", { name: "Accept Match: C&V Paving Contractors", exact: true });
  await acceptSuggestion.waitFor();
  await suggestionVendor.getByText("Suggested: C&V Paving Contractors", { exact: true }).waitFor();
  assert(await suggestionVendor.getByRole("button", { name: "Add Contractor", exact: true }).isEnabled());
  assert(!run.decisions.vendors["c and v paving contractors"], "Suggestions are never silently accepted");
  assert(await importButton.isDisabled());
  const noSuggestion = vendor("Suggestion Review 262");
  assert.equal(await noSuggestion.getByRole("button", { name: /Accept Match/ }).count(), 0);
  for (const action of ["Match Contractor", "Add Contractor", "Leave Unmatched"]) {
    assert.equal(await noSuggestion.getByRole("button", { name: action, exact: true }).count(), 1);
  }
  assert.equal(await vendor("Ambiguous Fixture").getByRole("button", { name: /Accept Match/ }).count(), 0,
    "Multiple candidates do not invent a preferred suggestion");
  await section.getByLabel("Match contractor for Suggestion Review 262", { exact: true }).selectOption("81");
  const openProjects = section.locator("details").filter({ has: page.locator("summary", { hasText: "Projects —" }) });
  if (!(await openProjects.evaluate(node => node.open))) await openProjects.locator("summary").click();
  await section.getByLabel("Match project for UNAPPROVED PROJECT", { exact: true }).selectOption("45");
  failSave = true;
  await acceptSuggestion.click();
  await section.getByRole("alert").filter({ hasText: "Fixture stale review" }).waitFor();
  assert(await acceptSuggestion.isEnabled(), "Failed acceptance remains actionable");
  assert(!run.decisions.vendors["c and v paving contractors"]);
  failSave = false;
  const savesBeforeAccept = saveAttempts;
  await acceptSuggestion.click();
  await suggestionVendor.getByText("MATCHED — C&V Paving Contractors", { exact: true }).waitFor();
  assert.deepEqual(run.decisions.vendors["c and v paving contractors"], { action: "MATCH", contractorId: 80 });
  assert(await acceptSuggestion.isDisabled());
  await acceptSuggestion.evaluate(button => { button.click(); button.click(); });
  assert.equal(saveAttempts, savesBeforeAccept + 1, "Accepted suggestion cannot repeatedly save");
  assert(await importButton.isEnabled());
  await waitPage(14);
  assert.equal(run.decisions.vendors["suggestion review 000"].action, "UNMATCHED");
  assert.equal(await section.getByLabel("Match contractor for Suggestion Review 262", { exact: true }).inputValue(), "81");
  assert.equal(await section.getByLabel("Match project for UNAPPROVED PROJECT", { exact: true }).inputValue(), "45");
  await section.getByLabel("Match contractor for C&V Paving Contractors", { exact: true }).selectOption("81");
  await saveDecision("C&V Paving Contractors", "Match Contractor", 14);
  await suggestionVendor.getByText("MATCHED — Alternate Contractor", { exact: true }).waitFor();
  assert.equal(run.decisions.vendors["c and v paving contractors"].contractorId, 81);
  assert(await acceptSuggestion.isEnabled(), "Saved MATCH can intentionally return to the suggestion");
  const beforeCancel = saveAttempts, contractorsBeforeCancel = reference.contractors.length;
  await suggestionVendor.getByRole("button", { name: "Add Contractor", exact: true }).click();
  const duplicateDialog = section.getByRole("dialog", { name: "Create separate contractor", exact: true });
  await duplicateDialog.getByText("C&V Paving Contractors (#80)", { exact: true }).waitFor();
  await duplicateDialog.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(saveAttempts, beforeCancel);
  assert.equal(reference.contractors.length, contractorsBeforeCancel);
  assert.equal(run.decisions.vendors["c and v paving contractors"].contractorId, 81);
  await suggestionVendor.getByRole("button", { name: "Add Contractor", exact: true }).click();
  await duplicateDialog.getByRole("button", { name: "Create Separate Contractor", exact: true }).click();
  await suggestionVendor.getByText(/Duplicate-name override approved/).waitFor();
  assert.equal(run.decisions.vendors["c and v paving contractors"].action, "ADD");
  assert.equal(run.decisions.vendors["c and v paving contractors"].duplicateOverride.contractorId, 80);
  assert.equal(run.decisions.vendors["c and v paving contractors"].duplicateOverride.companyName, "C&V Paving Contractors");
  assert(await suggestionVendor.getByRole("button", { name: "ADD saved", exact: true }).isDisabled());
  assert(await acceptSuggestion.isEnabled());
  assert.equal(reference.contractors.length, contractorsBeforeCancel, "Confirmation saves only a decision");
  await acceptSuggestion.click();
  await suggestionVendor.getByText("MATCHED — C&V Paving Contractors", { exact: true }).waitFor();
  await saveDecision("C&V Paving Contractors", "Leave Unmatched", 14);
  assert.equal(run.decisions.vendors["c and v paving contractors"].action, "UNMATCHED");
  assert(await importButton.isDisabled());
  const unmatchedProject = vendor("Unknown Project Suggestion");
  await unmatchedProject.getByRole("button", { name: "Accept Match: Unknown Project Suggestion", exact: true }).click();
  await unmatchedProject.getByText("MATCHED — Unknown Project Suggestion", { exact: true }).waitFor();
  assert.equal(run.decisions.vendors["unknown project suggestion"].contractorId, 84);
  assert(!response().preview.ready.some(plan => plan.key === "unknown project suggestion"));
  assert(await importButton.isDisabled(), "Accepting contractor never approves an unmatched project");
  assert(!reference.projectMappings.some(mapping => mapping.source_number === "UNAPPROVED PROJECT"));
  await waitPage(14);
  assert.equal(await section.getByLabel("Match contractor for Suggestion Review 262", { exact: true }).inputValue(), "81");
  assert.equal(await section.getByLabel("Match project for UNAPPROVED PROJECT", { exact: true }).inputValue(), "45");
  console.log("PASS: preferred explicit Accept Match; exact ID saved, named MATCHED state and repeat-save guard; failed save retry; alternate MATCH; no/ambiguous suggestion controls; confirmation cancel writes nothing; explicit ADD override evidence with disabled repeats; ADD to suggested MATCH/Unmatched; page 14 and all other decisions/selections preserved; contractor/project decisions independent.");
  await page.goto(`${appUrl}/contractors/1`);
  await page.getByRole("button", { name: "Add Contact", exact: true }).click();
  const contactDialog = page.getByRole("dialog", { name: "Add Contact", exact: true });
  await contactDialog.getByLabel("Contact Name", { exact: true }).fill("Separate Phones");
  await contactDialog.getByLabel("Business Phone", { exact: true }).fill("2015554444");
  await contactDialog.getByLabel("Mobile Phone", { exact: true }).fill("2015555555");
  await contactDialog.getByRole("button", { name: "Add Contact", exact: true }).click();
  await contactDialog.waitFor({ state: "hidden" });
  assert.equal(savedContact.p_values.business_phone, "2015554444");
  assert.equal(savedContact.p_values.mobile_phone, "2015555555");
  viewer = true;
  await page.goto(`${appUrl}/imports`);
  await section.waitFor();
  assert(await section.getByLabel("Procore report", { exact: true }).isDisabled());
  missingMigration = true;
  await page.reload(); await section.getByRole("alert").filter({ hasText: "20261110" }).waitFor();
  assert.deepEqual(errors, []);
  console.log("PASS: 5500-row/960-unique-company fixture (48 pages); Match on page 2; Add and Leave Unmatched on page 17; reload preserves page; Previous/Next; Go/Enter; first/last disabled; blank/text/fraction rejected; 0/over-max clamped; shrinking 48 to 47 pages clamped; saved decisions and other unsaved selections retained; only 20 candidates rendered; no extra import/finalize.");
  console.log("PASS: Procore section directly below unchanged myCOI; 6000 rows summarized into four companies; Match/Add/Leave Unmatched; staged Adds only execute on Import; unresolved/staged Finalize cancel/confirm; frozen read-only review; collapsed history; compact 28px blue buttons; permission and explicit migration/stale errors; separate contact Business/Mobile form + RPC mapping; all network writes intercepted, no shared data.");
} finally { await browser.close(); }
