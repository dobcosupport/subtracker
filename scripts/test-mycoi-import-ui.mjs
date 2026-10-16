import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import * as XLSX from "xlsx";

const requirePackage = createRequire(import.meta.url);
const { chromium } = requirePackage("playwright");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appUrl = process.env.TEST_APP_URL;
assert.ok(appUrl && new URL(appUrl).hostname === "localhost", "Only isolated localhost previews are allowed");
const env = fs.readFileSync(path.join(root, ".env.local"), "utf8");
const origin = new URL(env.match(/^NEXT_PUBLIC_SUPABASE_URL\s*=\s*["']?([^"'\r\n]+)/m)[1].trim()).origin;
const storageKey = `sb-${new URL(origin).hostname.split(".")[0]}-auth-token`;
const user = { id: "00000000-0000-0000-0000-000000000001", email: "synthetic@example.invalid", aud: "authenticated", app_metadata: {}, user_metadata: {} };
const cache = new Map();
function load(relative) {
  if (cache.has(relative)) return cache.get(relative);
  const output = { exports: {} }; cache.set(relative, output.exports);
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(root, relative), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, { module: output, exports: output.exports, require: (name) => {
    if (name === "xlsx") return XLSX;
    return load(name.startsWith("@/types/") ? `types\\${name.slice(8)}.ts` : `src\\lib\\${name.slice(6)}.ts`);
  } });
  return output.exports;
}
const { buildMycoiPreview, blankDecisions } = load("src\\lib\\mycoi-preview.ts");
const { parseMycoiWorkbook } = load("src\\lib\\mycoi-parser.ts");
const headings = load("types\\mycoi-import.ts").MYCOI_HEADINGS;
const source = [
  ["22002 - Synthetic School", "GEO-Instruments", "zeid.alkas@geo-instruments.com", "9735577667", "Compliant Finalized", "policyNumber: SYN-1; expirationDate: 06/01/2027; isExpired: false; policyLines: General Liability, Workers Compensation, policyNumber: AUTO-2; expirationDate: 06/01/2027; isExpired: false; policyLines: Automobile Liability, policyNumber: UMB-3; expirationDate: 06/01/2025; isExpired: true; policyLines: Umbrella / Excess"],
  ["24003 - Synthetic College", "GEO-Instruments", "zeid.alkas@geo-instruments.com", "9735577667", "Compliant Finalized", ""],
  ["Unknown Division", "Unresolved Synthetic", "unresolved@example.invalid", "invalid-phone", "Unknown", "malformed-policy"],
];
const book = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([headings, ...source]), "Report");
let bytes = XLSX.write(book, { type: "buffer", bookType: "xlsx" });
const ref = {
  token: "synthetic-reference", contractors: [{ id: 1, company_name: "GEO-INSTRUMENTS", active: true }, { id: 2, company_name: "Different Existing Contractor", active: true }],
  projects: [{ id: 2, project_number: "24-003", project_name: "Synthetic College" }, { id: 1, project_number: "22-002", project_name: "Synthetic School" }],
  vendors: [], divisions: [], statuses: [], policies: [], links: [],
};
let run = null;
let editor = true;
let failSave = false;
let uploads = 0;
let executions = 0;
const response = () => ({
  run, preview: buildMycoiPreview(run.source_rows, run.decisions, ref, run.imported_rows),
  token: ref.token, contractors: ref.contractors, projects: ref.projects,
});
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const errors = [];
const colors = [];
async function renderedStyle(locator) {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return { background: style.backgroundColor, color: style.color, border: style.borderTopColor,
      borderWidth: style.borderTopWidth, weight: style.fontWeight, outline: style.outlineStyle,
      outlineWidth: style.outlineWidth, opacity: style.opacity, cursor: style.cursor };
  });
}
async function checkActionRow(controls) {
  const boxes = await Promise.all(controls.map((control) => control.boundingBox()));
  assert.ok(boxes.every(Boolean));
  assert.ok(boxes.every((box) => Math.abs(box.y - boxes[0].y) < 1), "Matching controls share one desktop row");
  assert.ok(boxes.every((box) => box.height === 40), "Matching controls have equal 40px heights");
  for (let index = 1; index < boxes.length; index++) {
    assert.ok(boxes[index].x - boxes[index - 1].x - boxes[index - 1].width >= 7, "Labels have consistent visible spacing");
  }
}
function contrast(background, foreground) {
  const luminance = (color) => color.match(/\d+/g).slice(0, 3).map(Number).map((value) => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
  const values = [luminance(background), luminance(foreground)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}
async function checkControl(locator, label, background, hoverBackground, text = "rgb(255, 255, 255)") {
  await locator.scrollIntoViewIfNeeded();
  await locator.page().mouse.move(0, 0);
  const normal = await renderedStyle(locator);
  assert.equal(normal.background, background, `${label}: actual solid background`);
  assert.equal(normal.color, text, `${label}: actual contrasting text`);
  assert.ok(contrast(normal.background, normal.color) >= 4.5, `${label}: WCAG AA text contrast`);
  assert.ok(Number(normal.weight) >= 600, `${label}: readable weight`);
  assert.ok(parseFloat(normal.borderWidth) >= 1, `${label}: visible border`);
  assert.notEqual(normal.background, "rgba(0, 0, 0, 0)");
  assert.notEqual(normal.background, "rgb(255, 255, 255)");
  await locator.hover();
  const hovered = await renderedStyle(locator);
  assert.equal(hovered.background, hoverBackground, `${label}: visible hover`);
  assert.ok(contrast(hovered.background, hovered.color) >= 4.5);
  await locator.page().keyboard.press("Tab");
  await locator.focus();
  const focused = await renderedStyle(locator);
  assert.equal(focused.outline, "solid", `${label}: keyboard focus ring`);
  assert.equal(focused.outlineWidth, "3px");
  colors.push({ label, background: normal.background, text: normal.color, hover: hovered.background,
    contrast: contrast(normal.background, normal.color).toFixed(2), focus: `${focused.outlineWidth} ${focused.outline}` });
  await locator.page().mouse.move(0, 0);
}
try {
  await context.addInitScript(({ storageKey, user }) => localStorage.setItem(storageKey, JSON.stringify({
    access_token: "synthetic-token", refresh_token: "synthetic-refresh", token_type: "bearer",
    expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user,
  })), { storageKey, user });
  await context.route("**/*", async (route) => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== new URL(appUrl).origin) {
      assert.equal(url.origin, origin, "Unexpected external request blocked");
      assert.ok(["GET", "HEAD"].includes(request.method()), "All database writes are blocked");
      if (url.pathname.startsWith("/auth/")) return route.fulfill({ json: user });
      return route.fulfill({ json: [], headers: { "content-range": "*/0" } });
    }
    if (url.pathname === "/api/admin/bootstrap") return route.fulfill({ json: {} });
    if (url.pathname === "/api/auth/session") return route.fulfill({ json: {
      profile: { auth_user_id: user.id, name: "Synthetic", email: user.email, role: editor ? "Administrator" : "Read Only", status: "Active", system_administrator: false },
      permissions: ["dashboard", "imports", "insurance", "contractors", "projects", "compliance", "followups"].map((module) => ({ module, can_view: true, can_add: editor, can_edit: editor, can_delete: false, can_manage: editor })),
    } });
    if (url.pathname === "/api/imports/mycoi" && request.method() === "POST") {
      assert.match(request.headers()["content-type"], /^multipart\/form-data; boundary=/, "Upload preserves FormData boundary");
      assert.ok(request.postDataBuffer().includes(bytes), "Actual synthetic workbook is uploaded");
      uploads++;
      const rows = parseMycoiWorkbook(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), "synthetic.xlsx");
      run = { id: "00000000-0000-0000-0000-000000000010", file_name: "synthetic.xlsx", created_at: "2026-10-15T12:00:00Z", updated_at: "2026-10-15T12:00:00Z", last_imported_at: null,
        source_rows: rows, source_row_count: 3, decisions: blankDecisions(), imported_rows: [], revision: 1, status: "Review", import_history_id: null,
        metrics: { rows: 0, vendors: 0, policies: 0, changes: 0, exceptions: 3 } };
      return route.fulfill({ json: response() });
    }
    if (url.pathname === "/api/imports/mycoi") return route.fulfill({ json: { runs: run ? [run] : [] } });
    if (url.pathname.startsWith("/api/imports/mycoi/")) {
      if (request.method() === "PATCH") {
        if (failSave) return route.fulfill({ status: 409, json: { error: "Synthetic concurrent review; reload before saving." } });
        const body = request.postDataJSON(); assert.equal(body.revision, run.revision);
        run.decisions = body.decisions; run.revision++;
      }
      if (request.method() === "POST") {
        const body = request.postDataJSON(); assert.equal(body.revision, run.revision); assert.equal(body.token, ref.token);
        const ready = response().preview.ready;
        assert.equal(ready.length, 1, "Only resolved vendor imports");
        run.imported_rows = ready.flatMap((vendor) => vendor.rows); run.revision++; run.status = "Partial";
        run.metrics = { rows: 2, vendors: 1, policies: 1, changes: 5, exceptions: 1 }; run.last_imported_at = "2026-10-15T12:05:00Z";
        ref.vendors = [{ id: 1, raw_vendor_name: "GEO-Instruments", contractor_id: 1, active: true, vendor_email: source[0][2], vendor_phone: source[0][3] }];
        ref.divisions = [{ id: 1, raw_division_name: source[0][0], project_id: 1, active: true },
          { id: 2, raw_division_name: source[1][0], project_id: 2, active: true }];
        executions++;
      }
      return route.fulfill({ json: response() });
    }
    assert.ok(["GET", "HEAD"].includes(request.method()), `Unexpected application mutation ${url.pathname}`);
    return route.continue();
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${appUrl}/imports`);
  const panel = page.getByRole("region", { name: "myCOI Insurance Import", exact: true });
  await panel.getByLabel("myCOI report", { exact: true }).setInputFiles({ name: "synthetic.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: bytes });
  await panel.getByRole("heading", { name: "Preview: synthetic.xlsx" }).waitFor();
  assert.equal(uploads, 1); assert.equal(executions, 0);
  const vendor = panel.getByRole("group", { name: "Vendor review: GEO-Instruments", exact: true });
  const insurance = vendor.getByRole("table", { name: "Parsed insurance for source row 2", exact: true });
  await insurance.waitFor({ state: "visible" });
  assert.deepEqual(await insurance.getByRole("columnheader").allTextContents(), ["Insurance Type", "Policy Number", "Expiration Date", "Status"]);
  assert.equal(await insurance.getByRole("row").count(), 5, "All parsed policies and lines are shown before acceptance");
  assert.match(await insurance.getByRole("row").nth(1).textContent(), /General Liability.*SYN-1.*06\/01\/2027.*Current/);
  assert.match(await insurance.getByRole("row").nth(2).textContent(), /Workers Compensation.*SYN-1/);
  assert.match(await insurance.getByRole("row").nth(4).textContent(), /Umbrella \/ Excess.*UMB-3.*06\/01\/2025.*Expired/);
  const rowReview = vendor.getByRole("region", { name: "Insurance review for source row 2", exact: true });
  const sourceDetails = rowReview.locator("details");
  assert.equal(await sourceDetails.getAttribute("open"), null);
  assert.equal(await rowReview.getByText(source[0][5], { exact: true }).isVisible(), false, "Raw serialization is secondary");
  await sourceDetails.getByText("Source Details", { exact: true }).click();
  await vendor.getByRole("region", { name: "Insurance review for source row 3", exact: true })
    .getByText("No policies supplied for this row; existing policies are retained.", { exact: true }).waitFor();
  for (const control of await panel.getByRole("button").all()) {
    const actual = await renderedStyle(control);
    const label = await control.evaluate((element) => `${element.tagName} ${element.getAttribute("aria-label") ?? element.textContent} ${element.getAttribute("type") ?? ""}`);
    assert.match(actual.background, /^rgb\(/, `${label}: every workflow button has an opaque computed fill`);
    assert.ok(contrast(actual.background, actual.color) >= 4.5, "Every workflow button has contrasting text");
    assert.ok(parseFloat(actual.borderWidth) >= 1);
  }
  const uploadButtonStyle = await panel.getByLabel("myCOI report", { exact: true }).evaluate((element) => {
    const style = getComputedStyle(element, "::file-selector-button");
    return { background: style.backgroundColor, color: style.color };
  });
  assert.deepEqual(uploadButtonStyle, { background: "rgb(51, 65, 85)", color: "rgb(255, 255, 255)" });
  await rowReview.getByText(source[0][5], { exact: true }).waitFor({ state: "visible" });
  assert.match(await sourceDetails.textContent(), /Source Excel row: 2/);
  assert.match(await sourceDetails.textContent(), /Complete raw Division Name: 22002 - Synthetic School/);
  await sourceDetails.getByText("Source Details", { exact: true }).click();
  assert.ok(await vendor.getByText("GEO-INSTRUMENTS", { exact: true }).isVisible());
  const acceptMatch = vendor.getByRole("button", { name: "Accept Match: GEO-INSTRUMENTS", exact: true });
  await acceptMatch.waitFor({ state: "visible" });
  await checkControl(acceptMatch, "Accept Match", "rgb(29, 78, 216)", "rgb(30, 64, 175)");
  await checkControl(vendor.getByRole("button", { name: "Choose Different Contractor", exact: true }), "Choose Different Contractor", "rgb(51, 65, 85)", "rgb(30, 41, 59)");
  await checkControl(vendor.getByRole("button", { name: "Leave Unmatched", exact: true }), "Leave Unmatched", "rgb(226, 232, 240)", "rgb(203, 213, 225)", "rgb(15, 23, 42)");
  await checkActionRow([acceptMatch, vendor.getByRole("button", { name: "Choose Different Contractor", exact: true }), vendor.getByRole("button", { name: "Leave Unmatched", exact: true })]);
  const header = vendor.locator("header");
  assert.equal(await header.getByRole("button").count(), 3);
  assert.equal(await vendor.getByRole("button", { name: /^(Accept Match:|Choose Different Contractor$|Leave Unmatched$)/ }).count(), 3, "No duplicate vendor controls below insurance");
  const headerBox = await header.boundingBox();
  const insuranceBox = await vendor.getByRole("heading", { name: "Parsed Insurance", exact: true }).boundingBox();
  assert.ok(headerBox.y + headerBox.height <= insuranceBox.y, "Actions precede insurance");
  const cardBox = await vendor.boundingBox();
  assert.ok(headerBox.y - cardBox.y < 20, "Actions are in top portion of card");
  const identityBox = await header.getByText("myCOI Vendor Name: GEO-Instruments", { exact: true }).boundingBox();
  const actionBox = await acceptMatch.boundingBox();
  assert.ok(actionBox.x > identityBox.x && Math.abs(actionBox.y - identityBox.y) < 5, "Desktop actions align right of vendor summary");
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileVendorButtons = await Promise.all((await header.getByRole("button").all()).map((control) => control.boundingBox()));
  assert.ok(mobileVendorButtons.some((box) => box.y > mobileVendorButtons[0].y), "Vendor actions wrap on mobile");
  await page.setViewportSize({ width: 1440, height: 1000 });
  const disabledImport = panel.getByRole("button", { name: "Import Ready Vendors (0)", exact: true });
  assert.ok(await disabledImport.isDisabled());
  const importHeader = panel.locator('header[aria-label="Import actions header"]');
  const saveReview = importHeader.getByRole("button", { name: "Save Review / Refresh Preview", exact: true });
  const reloadReview = importHeader.getByRole("button", { name: "Reload Saved Preview", exact: true });
  assert.equal(await importHeader.getByRole("button").count(), 3);
  await checkActionRow([saveReview, reloadReview, disabledImport]);
  for (const label of ["Save Review / Refresh Preview", "Reload Saved Preview", "Import Ready Vendors (0)"]) {
    assert.equal(await panel.getByRole("button", { name: label, exact: true }).count(), 1, "Import actions are not duplicated");
  }
  await importHeader.scrollIntoViewIfNeeded();
  for (const control of [saveReview, reloadReview, disabledImport]) {
    const bounds = await control.boundingBox();
    assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 1000, "All import actions visible at section header");
  }
  const importHeaderBox = await importHeader.boundingBox();
  const vendorHeaderBox = await header.boundingBox();
  assert.ok(importHeaderBox.y + importHeaderBox.height < vendorHeaderBox.y, "Import actions precede vendor cards");
  await checkControl(reloadReview, "Reload Saved Preview", "rgb(51, 65, 85)", "rgb(30, 41, 59)");
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileImportButtons = await Promise.all([saveReview, reloadReview, disabledImport].map((control) => control.boundingBox()));
  assert.ok(mobileImportButtons.some((box) => box.y > mobileImportButtons[0].y), "Import actions wrap on mobile");
  await page.setViewportSize({ width: 768, height: 844 });
  for (const control of [saveReview, reloadReview, disabledImport]) {
    const bounds = await control.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 768, `Narrow-screen buttons fit viewport: ${JSON.stringify(bounds)}`);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  assert.deepEqual(await renderedStyle(disabledImport).then(({ background, color, cursor }) => ({ background, color, cursor })),
    { background: "rgb(226, 232, 240)", color: "rgb(71, 85, 105)", cursor: "not-allowed" });
  assert.equal((await renderedStyle(vendor.getByText("Unmatched", { exact: true }))).background, "rgb(254, 243, 199)");
  await panel.getByText("No vendors are currently ready to import.", { exact: true }).waitFor();
  await acceptMatch.click();
  await vendor.getByText("Ready to Import", { exact: true }).waitFor();
  assert.equal(run.decisions.vendors["geo-instruments"], 1);
  assert.equal(ref.vendors.length, 0, "Acceptance only stages the mapping");
  await vendor.getByText("GEO-Instruments → GEO-INSTRUMENTS", { exact: true }).waitFor();
  assert.equal(await vendor.getByText("Project Matched Automatically", { exact: true }).count(), 2);
  assert.equal(await vendor.getByRole("button", { name: /Accept Project Match:/ }).count(), 0);
  assert.deepEqual(run.decisions.divisions, {}, "Automatic projects need no manual decisions");
  assert.equal(ref.divisions.length, 0, "Automatic match is staged until import execution");
  await vendor.getByRole("button", { name: "Change Contractor", exact: true }).click();
  assert.deepEqual(await vendor.getByLabel("Contractor for GEO-Instruments", { exact: true }).locator("option").allTextContents(),
    ["Select a contractor", "Different Existing Contractor", "GEO-INSTRUMENTS"]);
  const revisionBeforeSelection = run.revision;
  await vendor.getByLabel("Contractor for GEO-Instruments", { exact: true }).selectOption("2");
  assert.equal(run.revision, revisionBeforeSelection, "Selecting is not acceptance");
  assert.equal(run.decisions.vendors["geo-instruments"], 1);
  await vendor.getByRole("button", { name: "Accept Match", exact: true }).click();
  await vendor.getByText("GEO-Instruments → Different Existing Contractor", { exact: true }).waitFor();
  assert.equal(run.decisions.vendors["geo-instruments"], 2);
  await vendor.getByRole("button", { name: "Change Contractor", exact: true }).click();
  await vendor.getByRole("button", { name: "Leave Unmatched", exact: true }).click();
  await vendor.getByText("Unmatched", { exact: true }).waitFor();
  assert.equal(run.decisions.vendors["geo-instruments"], undefined);
  await vendor.getByRole("button", { name: "Accept Match: GEO-INSTRUMENTS", exact: true }).click();
  await vendor.getByText("Ready to Import", { exact: true }).waitFor();
  const firstDivision = vendor.getByRole("region", { name: "Division review: 22002 - Synthetic School", exact: true });
  const secondDivision = vendor.getByRole("region", { name: "Division review: 24003 - Synthetic College", exact: true });
  await firstDivision.getByText("✓ 22-002 - Synthetic School", { exact: true }).waitFor();
  await firstDivision.getByText("myCOI: 22002 - Synthetic School", { exact: true }).waitFor();
  await firstDivision.getByText("SubTracker: 22-002 - Synthetic School", { exact: true }).waitFor();
  assert.equal(await firstDivision.getByRole("button").count(), 0, "Accepted project collapses to confirmed line");
  await secondDivision.getByText("✓ 24-003 - Synthetic College", { exact: true }).waitFor();
  await vendor.getByText("Ready to Import", { exact: true }).waitFor();
  await panel.getByText("Ready to Import: 1 | Unresolved: 1", { exact: true }).waitFor();
  assert.equal((await renderedStyle(vendor.getByText("Ready to Import", { exact: true }))).background, "rgb(220, 252, 231)");
  assert.equal(ref.contractors[0].company_name, "GEO-INSTRUMENTS");
  assert.equal(run.source_rows[0]["Vendor Name"], "GEO-Instruments");
  assert.doesNotMatch(await vendor.innerText(), /<\/?(?:ul|li|div|span|p)\b|class(?:Name)?=|style=|\{styles\./i, "No implementation markup visible in vendor review");
  const unresolvedVendor = panel.getByRole("group", { name: "Vendor review: Unresolved Synthetic", exact: true });
  const unresolvedDivision = unresolvedVendor.getByRole("region", { name: "Division review: Unknown Division", exact: true });
  await unresolvedDivision.getByRole("button", { name: "Choose Different Project", exact: true }).click();
  assert.deepEqual(await unresolvedDivision.getByLabel("Existing project for Unknown Division", { exact: true }).locator("option").allTextContents(),
    ["Select a project", "22-002 - Synthetic School", "24-003 - Synthetic College"]);
  const projectRevision = run.revision;
  await unresolvedDivision.getByLabel("Existing project for Unknown Division", { exact: true }).selectOption("1");
  assert.equal(run.revision, projectRevision, "Selecting a project is not acceptance");
  assert.equal(run.decisions.divisions["unknown division"], undefined);
  const manualProject = unresolvedDivision.getByRole("button", { name: "Accept Project Match: Unknown Division", exact: true });
  const differentProject = unresolvedDivision.getByRole("button", { name: "Choose Different Project", exact: true });
  const leaveProject = unresolvedDivision.getByRole("button", { name: "Leave Unresolved", exact: true });
  await checkControl(manualProject, "Accept Project Match", "rgb(29, 78, 216)", "rgb(30, 64, 175)");
  await checkControl(differentProject, "Choose Different Project", "rgb(51, 65, 85)", "rgb(30, 41, 59)");
  await checkActionRow([manualProject, differentProject, leaveProject]);
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileBoxes = await Promise.all([manualProject, differentProject, leaveProject].map((control) => control.boundingBox()));
  assert.ok(mobileBoxes.some((box) => box.y > mobileBoxes[0].y));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await leaveProject.click();
  await unresolvedDivision.getByText("Detected Project Number: Not available", { exact: true }).waitFor();
  await unresolvedVendor.getByText("Policy Parse Exception — this row requires review.", { exact: true }).waitFor();
  assert.equal((await renderedStyle(unresolvedVendor.getByRole("note"))).background, "rgb(254, 226, 226)");
  const failedSource = unresolvedVendor.locator("details").first();
  assert.equal(await failedSource.getAttribute("open"), null, "Error details remain collapsed; warning is prominent");
  await failedSource.getByText("Source Details", { exact: true }).click();
  assert.match(await failedSource.textContent(), /malformed-policy/);
  assert.match(await failedSource.textContent(), /Parser errors: Policy 1:/);
  await failedSource.getByText("Source Details", { exact: true }).click();
  await unresolvedVendor.getByText("1 Policy Parse Exception", { exact: true }).waitFor();
  await unresolvedVendor.getByRole("button", { name: "Choose Different Contractor", exact: true }).click();
  await unresolvedVendor.getByLabel("Contractor for Unresolved Synthetic", { exact: true }).selectOption("2");
  await unresolvedVendor.getByRole("button", { name: "Accept Match", exact: true }).click();
  await unresolvedVendor.getByText("Matched", { exact: true }).waitFor();
  await unresolvedVendor.getByText("1 Contact Conflict Requires Review", { exact: true }).waitFor();
  await unresolvedVendor.getByLabel("phone for Unresolved Synthetic", { exact: true }).selectOption("__KEEP__");
  await unresolvedVendor.getByText("1 Contact Conflict Requires Review", { exact: true }).waitFor({ state: "hidden" });
  await unresolvedVendor.getByText("1 Project Match Requires Review", { exact: true }).waitFor();
  await unresolvedVendor.getByRole("button", { name: "Change Contractor", exact: true }).click();
  await unresolvedVendor.getByRole("button", { name: "Leave Unmatched", exact: true }).click();
  await unresolvedVendor.getByText("Unmatched", { exact: true }).waitFor();
  await panel.getByText("Ready to Import: 1 | Unresolved: 1", { exact: true }).waitFor();
  page.once("dialog", (dialog) => dialog.accept());
  await checkControl(panel.getByRole("button", { name: "Import Ready Vendors (1)", exact: true }), "Import Ready Vendors", "rgb(29, 78, 216)", "rgb(30, 64, 175)");
  await panel.getByRole("button", { name: "Import Ready Vendors (1)", exact: true }).click();
  await panel.getByRole("status").waitFor();
  assert.match(await panel.getByRole("status").textContent(), /2 rows imported, 1 unresolved/);
  assert.equal(executions, 1);
  await page.reload();
  await panel.getByRole("button", { name: "Review synthetic.xlsx", exact: true }).click();
  await panel.getByRole("heading", { name: "Preview: synthetic.xlsx" }).waitFor();
  assert.ok(await panel.getByText(/malformed-policy/).first().count() > 0, "Unresolved raw context remains");
  failSave = true;
  await panel.getByRole("button", { name: "Ignore This Source Record #4", exact: true }).first().click();
  await panel.getByRole("alert").waitFor();
  assert.match(await panel.getByRole("alert").textContent(), /concurrent review/);
  failSave = false;
  await page.reload();
  await panel.getByLabel("myCOI report", { exact: true }).setInputFiles({ name: "synthetic.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: bytes });
  await vendor.getByText("Saved mapping reused automatically.", { exact: true }).waitFor();
  await vendor.getByText("Ready to Import", { exact: true }).waitFor();
  assert.equal(await vendor.getByRole("button", { name: /Accept Match/ }).count(), 0);
  assert.equal(run.decisions.vendors["geo-instruments"], undefined, "Later upload uses permanent mapping without new acceptance");
  ref.contractors.push({ id: 3, company_name: "Sergeant Paint LLC", active: true },
    { id: 4, company_name: "abc Construction", active: true }, { id: 5, company_name: "ABC Construction", active: true });
  for (const name of ["Sergeant Paint LLC", "SERGEANT PAINT LLC"]) {
    const exactBook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(exactBook, XLSX.utils.aoa_to_sheet([headings, [source[0][0], name, source[0][2], source[0][3], source[0][4], source[0][5]]]), "Report");
    bytes = XLSX.write(exactBook, { type: "buffer", bookType: "xlsx" });
    await panel.getByLabel("myCOI report", { exact: true }).setInputFiles({ name: "synthetic.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: bytes });
    const exactVendor = panel.getByRole("group", { name: `Vendor review: ${name}`, exact: true });
    await exactVendor.getByText("Exact Name Match", { exact: true }).waitFor();
    await exactVendor.getByText("Suggested SubTracker Contractor:", { exact: false }).waitFor();
    assert.equal(run.decisions.vendors["sergeant paint llc"], undefined);
    assert.equal(response().preview.ready.length, 0);
    await exactVendor.getByRole("button", { name: "Choose Different Contractor", exact: true }).click();
    assert.deepEqual(await exactVendor.getByLabel(`Contractor for ${name}`, { exact: true }).locator("option").allTextContents(),
      ["Select a contractor", "abc Construction", "ABC Construction", "Different Existing Contractor", "GEO-INSTRUMENTS", "Sergeant Paint LLC"]);
    await exactVendor.getByLabel(`Contractor for ${name}`, { exact: true }).selectOption("3");
    await exactVendor.getByRole("button", { name: "Accept Match", exact: true }).click();
    await exactVendor.getByText("Ready to Import", { exact: true }).waitFor();
    assert.equal(run.decisions.vendors["sergeant paint llc"], 3);
    assert.equal(ref.vendors.some((v) => v.contractor_id === 3), false, "Exact acceptance remains staged");
    assert.equal(ref.contractors.find((c) => c.id === 3).company_name, "Sergeant Paint LLC");
    await exactVendor.getByText("✓ Exact Vendor Match", { exact: true }).waitFor();
    assert.equal(await exactVendor.locator("header").getByRole("button", { name: "Change Contractor", exact: true }).count(), 1);
    assert.equal(await exactVendor.getByRole("button", { name: "Accept Match", exact: true }).count(), 0);
  }
  editor = false;
  await page.reload();
  await panel.getByText(/Read-only history/).waitFor();
  assert.equal(await panel.getByLabel("myCOI report", { exact: true }).count(), 0);
  assert.equal(executions, 1);
  assert.deepEqual(errors, []);
  console.log("COMPUTED STYLES", JSON.stringify(colors));
  console.log("PASS: unique YYNNN to YY-NNN project numbers automatically stage both projects, bypass review buttons, make accepted vendor ready, persist only on import and reuse later; unknown/no-number project remains manual; computed styles, policy tables and raw details retained");
  console.log("PASS: GEO-Instruments -> GEO-INSTRUMENTS explicit solid acceptance, staged-only decisions, selection is not acceptance, Leave Unmatched, per-vendor blockers, automatic readiness/counts, partial import, saved mapping reuse, unchanged names, failed staging and viewer restrictions; all writes intercepted");
} finally { await context.close(); await browser.close(); }
