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
let viewer = false;
let missingMigration = false;
let savedContact = null;
let uploadSource = source;
let runSequence = 0;
let shrinkOnSave = false;
const contacts = [];
const response = () => run.finalized_at ? { run, ...run.finalized_review, token: "" } : ({
  run, preview: buildProcorePreview(run.source_rows, run.decisions, reference, run.imported_rows),
  contractors: reference.contractors, token: reference.token,
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
        if (method === "PATCH") {
          if (failSave) return route.fulfill({ status: 409, json: { error: "Fixture stale review; reload." } });
          run.decisions = request.postDataJSON().decisions; run.revision++;
          if (shrinkOnSave) {
            run.source_rows = run.source_rows.filter((row) => Number(row["Company (Vendor) > Name"].slice(-3)) < 940);
            run.source_row_count = run.source_rows.length;
            shrinkOnSave = false;
          }
        }
        if (method === "POST") {
          assert(!run.finalized_at); imports++;
          for (const plan of response().preview.ready) {
            if (plan.createContractor) {
              adds++; plan.contractorId = 2;
              reference.contractors.push({ id: 2, company_name: plan.company.company_name, active: true });
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
  const buttonMetrics = await vendor("New Fixture").getByRole("button", { name: "Add Contractor", exact: true }).evaluate((b) =>
    ({ height: b.getBoundingClientRect().height, background: getComputedStyle(b).backgroundColor }));
  assert.equal(buttonMetrics.height, 28); assert.equal(buttonMetrics.background, "rgb(29, 78, 216)");
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
