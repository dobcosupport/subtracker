import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
import ts from "typescript";
import * as XLSX from "xlsx";

const require = createRequire(import.meta.url);
const project = { id: 13, project_number: "23-001", project_name: "Export Fixture", status: "Active",
  created_at: "2026-01-01", updated_at: "2026-01-02" };
const assignments = Array.from({ length: 501 }, (_, index) => ({
  id: index + 1, contractor_id: 1, project_id: 13, assigned_date: "2026-01-01",
  removed_date: index === 500 ? "2026-02-01" : null, active: index !== 500,
  ownership_sources: ["MANUAL", "MYCOI", "PROCORE"], manual_owned: true, mycoi_owned: true,
  contractors: { company_name: index === 500 ? "HIDDEN LAST CONTRACTOR" : "Fixture Company", trade: "Steel", active: true },
}));
const compliance = Array.from({ length: 501 }, (_, index) => ({
  id: index + 1, contractor_id: 1, compliance_type_id: 1, registration_number: `REG-${index}`,
  active: index !== 500, is_current: index !== 500, expiration_date: "2027-01-01",
  effective_date: "2026-01-01", notes: index === 500 ? "HIDDEN LAST COMPLIANCE" : "",
  created_at: "2026-01-01", compliance_types: {
    compliance_name: index === 500 ? "HIDDEN LAST COMPLIANCE" : "NJ PWC", requires_expiration: true,
  },
}));
const tables = { projects: [project], contractor_projects: assignments, compliance_records: compliance,
  activity_log: [{ id: 1, project_id: 13, activity_date: "2026-01-01", created_at: "2026-01-01T12:00:00Z",
    activity_type: "Project Source ADDED", notes: "PROCORE ownership added" }], documents: [],
  mycoi_vendor_mappings: [], mycoi_contractor_divisions: [], mycoi_policies: [] };
const reads = [];
const renderedCells = [];
const tableLayouts = [];
let fail = false;
const supabase = { from(table) {
  let start = 0, end = Infinity;
  const query = {
    select() { return query; }, eq() { return query; }, in() { return query; }, order() { return query; },
    range(a, b) { start = a; end = b; return query; }, returns() { return query; },
    single() { return Promise.resolve({ data: project, error: null }); },
    then(resolve, reject) { reads.push({ table, start }); return Promise.resolve({
      data: fail ? null : tables[table].slice(start, end + 1), error: fail ? { message: "fixture read failure" } : null,
    }).then(resolve, reject); },
  };
  return query;
} };
const exportModule = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync("services/project-export.ts", "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { module: exportModule, exports: exportModule.exports, Blob, Date, require: id => {
  if (id === "@/lib/supabase") return { supabase };
  if (id === "@/services/compliance") return { calculateComplianceStatus: () => ({ calculated_status: "Active" }) };
  if (id === "jspdf-autotable") return { default: (document, options) => {
    tableLayouts.push({ rowPageBreak: options.rowPageBreak, showHead: options.showHead });
    return require(id).default(document, { ...options, didDrawCell: cell => renderedCells.push({
      table: tableLayouts.length, section: cell.section, row: cell.row.index, column: cell.column.index,
      page: document.internal.getCurrentPageInfo().pageNumber, y: cell.cell.y, height: cell.cell.height,
      fill: cell.cell.styles.fillColor, status: cell.cell.text.join(" "),
    }) });
  } };
  return require(id);
} });
const { loadProjectExport, projectExportXlsx, projectExportPdf } = exportModule.exports;
const sections = await loadProjectExport(13);
assert.equal(sections.find(s => s.name === "Contractor History").rows.length, 501);
assert.equal(sections.find(s => s.name === "Compliance History").rows.length, 501);
assert.equal(JSON.stringify(sections.map(s => s.name)), JSON.stringify(["Project Details", "Compliance History", "Contractor History"]));
assert.equal(JSON.stringify(sections[0].columns), JSON.stringify(["Project Number", "Project Name", "Status", "Created Date",
  "Inactive By", "Inactive Date", "Reactivated By", "Reactivated Date"]));
assert.equal(JSON.stringify(sections[2].columns), JSON.stringify(["Contractor Name", "Trade", "Assigned Date", "Removed Date", "Assignment Status"]));
assert.equal(JSON.stringify(sections[1].columns), JSON.stringify(["Compliance Type", "Contractor", "Expiration Date", "Current Status"]));
assert(reads.every(r => ["contractor_projects", "compliance_records"].includes(r.table)), "No insurance/activity/provenance export queries");
assert(reads.some(r => r.table === "contractor_projects" && r.start === 500));
assert(reads.some(r => r.table === "compliance_records" && r.start === 500));
const workbookBlob = projectExportXlsx(sections);
const book = XLSX.read(await workbookBlob.arrayBuffer());
assert.equal(JSON.stringify(book.SheetNames), JSON.stringify(sections.map(s => s.name)));
const history = XLSX.utils.sheet_to_json(book.Sheets["Contractor History"]);
assert.equal(history.at(-1)["Contractor Name"], "HIDDEN LAST CONTRACTOR");
assert.equal(history[0]["Assignment Status"], "Active (MANUAL + MYCOI + PROCORE)");
assert.equal(XLSX.utils.sheet_to_json(book.Sheets["Compliance History"]).at(-1)["Compliance Type"], "HIDDEN LAST COMPLIANCE");
assert(!JSON.stringify(sections).includes("REG-"), "Internal/extra compliance fields are excluded");
for (const section of sections) {
  assert.equal(JSON.stringify(XLSX.utils.sheet_to_json(book.Sheets[section.name], { header: 1 })[0]), JSON.stringify(section.columns));
}
const pdf = projectExportPdf(sections.map(s => ({ ...s, rows: s.rows.slice(-1) })));
const pdfText = Buffer.from(await pdf.arrayBuffer()).toString("latin1");
assert(pdfText.startsWith("%PDF-"));
assert(pdfText.indexOf("(COMPLIANCE HISTORY)") < pdfText.indexOf("(CONTRACTOR HISTORY)"),
  "PDF renders Compliance History before Contractor History");
assert(pdfText.includes("HIDDEN LAST CONTRACTOR"));
assert(pdfText.includes("HIDDEN LAST") && pdfText.includes("COMPLIANCE"));
assert(!pdfText.includes("Import History ID"));
assert(!pdfText.includes("Project / Audit Report"));
const visualSections = sections.map(s => ({ ...s, rows: s.rows.slice(0, s.name === "Project Details" ? 1 : 8) }));
visualSections[1].rows = Array.from({ length: 75 }, (_, index) => ({
  "Compliance Type": ["NJ PWC", "NJ BRC", "NY PWC"][index % 3],
  Contractor: `Contractor ${String(index).padStart(3, "0")} - ${index % 5 === 0 ? "Long construction company name wrapping onto a second line LLC" : "Example Construction LLC"}`,
  "Expiration Date": "2027-01-01", "Current Status": ["Active", "60 Day", "90 Day", "Expired", "30 Day"][index % 5],
}));
visualSections[2].rows = visualSections[2].rows.map((row, index) => ({
  ...row, "Contractor Name": `Contractor ${index} Construction LLC`,
  "Assignment Status": index % 2 ? "Removed" : "Active (MANUAL + MYCOI + PROCORE)",
}));
renderedCells.length = 0;
tableLayouts.length = 0;
const visualPdf = projectExportPdf(visualSections);
assert(tableLayouts.every(layout => layout.rowPageBreak === "avoid" && layout.showHead === "everyPage"));
for (const table of [1, 2]) {
  const body = renderedCells.filter(cell => cell.table === table && cell.section === "body");
  for (const row of new Set(body.map(cell => cell.row))) {
    const cells = body.filter(cell => cell.row === row);
    assert.equal(new Set(cells.map(cell => cell.page)).size, 1, `Table ${table}, row ${row} is never split`);
    assert(cells.every(cell => cell.y + cell.height < 284), "Rows stay above the bottom margin");
  }
  for (const page of new Set(body.map(cell => cell.page))) {
    assert(renderedCells.some(cell => cell.table === table && cell.page === page && cell.section === "head"),
      "Every continued page repeats its table header");
  }
}
for (const [status, color] of [["Active", [209, 250, 229]], ["60 Day", [255, 237, 213]],
  ["90 Day", [254, 243, 199]], ["Expired", [127, 29, 29]]]) {
  assert(renderedCells.some(cell => cell.table === 1 && cell.column === 3 && cell.status === status &&
    JSON.stringify(cell.fill) === JSON.stringify(color)), `${status} keeps its visual status color`);
}
if (process.env.PROJECT_EXPORT_SAMPLE_DIR) {
  const dir = process.env.PROJECT_EXPORT_SAMPLE_DIR;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(`${dir}\\project-details.pdf`, Buffer.from(await visualPdf.arrayBuffer()));
  fs.writeFileSync(`${dir}\\project-details.xlsx`, Buffer.from(await projectExportXlsx(visualSections).arrayBuffer()));
}
fail = true;
await assert.rejects(loadProjectExport(13), /fixture read failure/);
fail = false;
console.log("PASS: full paginated histories; exactly three screen-matching sections/columns; no internal metadata; assignment sources; XLSX/PDF content; multi-page repeated headers, whole rows and status colors; explicit errors; no writes.");

if (process.env.TEST_APP_URL) {
  const appUrl = process.env.TEST_APP_URL;
  assert.equal(new URL(appUrl).hostname, "localhost", "Intercepted localhost fixtures only");
  const { chromium } = require("playwright");
  const env = fs.readFileSync(".env.local", "utf8");
  const origin = new URL(env.match(/^NEXT_PUBLIC_SUPABASE_URL\s*=\s*["']?([^"'\r\n]+)/m)[1].trim()).origin;
  const storageKey = `sb-${new URL(origin).hostname.split(".")[0]}-auth-token`;
  const user = { id: "00000000-0000-0000-0000-000000000001", email: "fixture@example.invalid",
    aud: "authenticated", app_metadata: {}, user_metadata: {} };
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ acceptDownloads: true });
    await context.addInitScript(({ storageKey, user }) => localStorage.setItem(storageKey, JSON.stringify({
      access_token: "fixture-token", refresh_token: "fixture-refresh", token_type: "bearer", expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600, user,
    })), { storageKey, user });
    let mutation = false;
    let denyExport = false;
    await context.route("**/*", async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin === new URL(appUrl).origin) {
        if (url.pathname === "/api/admin/bootstrap") return route.fulfill({ json: {} });
        if (url.pathname === "/api/auth/session") return route.fulfill({ json: {
          profile: { auth_user_id: user.id, name: "Fixture", email: user.email, role: "Administrator", status: "Active" },
          permissions: ["projects", "contractors", "compliance", "insurance"].map(module => ({
            module, can_view: true, can_manage: true, can_add: true, can_edit: true,
          })),
        } });
        if (!["GET", "HEAD"].includes(request.method())) { mutation = true; return route.abort(); }
        return route.continue();
      }
      assert.equal(url.origin, origin);
      if (!["GET", "HEAD"].includes(request.method())) { mutation = true; return route.abort(); }
      if (url.pathname.startsWith("/auth/")) return route.fulfill({ json: user });
      const table = url.pathname.split("/").at(-1);
      assert(Object.hasOwn(tables, table), `Unexpected table ${table}`);
      if (denyExport && table === "contractor_projects") return route.fulfill({ status: 503, json: { message: "Export read denied" } });
      let rows = tables[table];
      if (url.searchParams.get("active") === "eq.true") rows = rows.filter(r => r.active);
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? rows.length);
      rows = rows.slice(offset, offset + limit);
      return route.fulfill({ json: request.headers().accept?.includes("vnd.pgrst.object") ? rows[0] : rows });
    });
    const page = await context.newPage();
    page.on("pageerror", error => console.error("Project fixture error:", error.message));
    await page.goto(`${appUrl}/projects?projectId=13`);
    const exportButton = page.getByRole("button", { name: "Export", exact: true });
    try { await exportButton.waitFor(); }
    catch (error) { console.error("Project fixture page:", await page.locator("body").innerText()); throw error; }
    await page.waitForFunction(() => !Array.from(document.querySelectorAll("button")).find(b => b.textContent === "Export")?.disabled);
    const close = page.getByRole("button", { name: "Close", exact: true });
    for (const width of [1440, 768, 390]) {
      await page.setViewportSize({ width, height: 900 });
      if (!await exportButton.count()) throw new Error(`Project header disappeared: ${await page.locator("body").innerText()}`);
      const exportBox = await exportButton.boundingBox(), closeBox = await close.boundingBox();
      assert.equal(exportBox.height, 28); assert.equal(closeBox.height, 28);
      assert(Math.abs(exportBox.y - closeBox.y) <= 1, "Actions stay on the same header row");
      assert(closeBox.x + closeBox.width <= width, "Header actions fit narrow screen");
    }
    await exportButton.click();
    assert.equal(await exportButton.getAttribute("aria-expanded"), "true");
    await exportButton.click();
    assert.equal(await exportButton.getAttribute("aria-expanded"), "false");
    await exportButton.click();
    await page.keyboard.press("Escape");
    assert.equal(await exportButton.getAttribute("aria-expanded"), "false");
    await exportButton.click();
    await page.getByRole("heading", { name: "Project Details", exact: true }).click();
    assert.equal(await exportButton.getAttribute("aria-expanded"), "false");
    if (process.env.PROJECT_EXPORT_SAMPLE_DIR) {
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.screenshot({ path: `${process.env.PROJECT_EXPORT_SAMPLE_DIR}\\screen-project-details.png` });
      await page.getByRole("heading", { name: "Compliance History", exact: true }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${process.env.PROJECT_EXPORT_SAMPLE_DIR}\\screen-compliance-history.png` });
    }
    // Removing the rendered history sections proves export reads data, not the DOM.
    await page.getByRole("heading", { name: "Contractor History", exact: true }).locator("..").evaluate(el => el.remove());
    await page.getByRole("heading", { name: "Compliance History", exact: true }).locator("..").evaluate(el => el.remove());
    for (const format of ["PDF", "XLSX"]) {
      await exportButton.click();
      const download = page.waitForEvent("download");
      await page.getByRole("button", { name: format, exact: true }).click();
      const file = await download;
      assert.equal(file.suggestedFilename(), `Project-23-001.${format.toLowerCase()}`);
      const bytes = fs.readFileSync(await file.path());
      if (format === "PDF") {
        assert(bytes.toString("latin1").includes("HIDDEN LAST"));
      } else {
        const downloadedBook = XLSX.read(bytes);
        assert.equal(XLSX.utils.sheet_to_json(downloadedBook.Sheets["Contractor History"]).length, 501);
        assert.equal(XLSX.utils.sheet_to_json(downloadedBook.Sheets["Compliance History"]).at(-1)["Compliance Type"], "HIDDEN LAST COMPLIANCE");
      }
      await page.waitForFunction(() => Array.from(document.querySelectorAll("button")).some(b => b.textContent === "Export" && !b.disabled));
    }
    denyExport = true;
    await exportButton.click();
    await page.getByRole("button", { name: "XLSX", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "Export read denied" }).waitFor();
    await close.click();
    await page.getByRole("heading", { name: "Project Details", exact: true }).waitFor({ state: "hidden" });
    await page.waitForURL(`${appUrl}/projects`);
    denyExport = false;
    await page.getByRole("button", { name: "View", exact: true }).click();
    await page.getByRole("heading", { name: "Project Details", exact: true }).waitFor();
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await page.getByRole("heading", { name: "Project Details", exact: true }).waitFor({ state: "hidden" });
    assert.equal(page.url(), `${appUrl}/projects`);
    assert.equal(mutation, false);
    console.log("PASS: compact 28px header at 1440/768/390px; dropdown toggle/outside/Escape; PDF/XLSX downloads with unrendered full histories; explicit error; original Close/deep-link behavior; all writes blocked.");
  } finally { await browser.close(); }
}
