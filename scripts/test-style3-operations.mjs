import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
import ts from "typescript";

const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
function load(file, dependencies = {}) {
  const loaded = { exports: {} };
  vm.runInNewContext(ts.transpileModule(read(file), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, { module: loaded, exports: loaded.exports, require(name) {
    assert.ok(name in dependencies, `Unexpected dependency: ${name}`);
    return dependencies[name];
  } });
  return loaded.exports;
}
const { matchesComplianceFilter } = load("services/compliance-directory.ts");
const { localCalendarDate, matchesFollowupFilter } = load("services/followup-queue.ts");
const statuses = ["Expired", "Expired", "30 Day", "30 Day", "60 Day", "60 Day", "90 Day", "90 Day", "Active", "Active", "Missing Information", "Expired"];
const days = [-1, 0, 1, 30, 31, 60, 61, 90, 91, null, null, 20];
const records = statuses.map((calculated_status, index) => ({
  compliance_record_id: index + 1, contractor_id: index + 1, company_name: `Fixture Company ${index + 1}`,
  compliance_type_id: 1, compliance_name: index === 9 ? "NJ BRC" : "NJ PWC", contractor_active: true,
  registration_number: `REG-${index + 1}`, effective_date: "2026-01-01",
  expiration_date: days[index] === null ? null : "2026-12-01",
  days_remaining: days[index], calculated_status,
}));
const count = filter => records.filter(row => matchesComplianceFilter(row, filter)).length;
assert.equal(count("all"), 12);
assert.equal(count("Expired"), 3, "The database's expiry-today and registry-expired statuses are authoritative.");
assert.equal(count("30 Day"), 2, "Expired registry records with future dates never join upcoming expiry buckets.");
assert.equal(count("31-90"), 4);
assert.equal(count("Active"), 2, "Non-expiring current records remain current.");
assert.equal(count("90+"), 1, "Non-expiring records are not included in the 90+ outlook.");
assert.equal(count("Missing Information"), 1);
assert.equal(["Active", "90 Day", "60 Day", "30 Day", "Expired", "Missing Information"].reduce((sum, filter) => sum + count(filter), 0), records.length);

let failureAt = null;
const ranges = [];
const large = Array.from({ length: 1007 }, (_, index) => ({ ...records[index % records.length], compliance_record_id: index + 1 }));
const compliance = load("services/compliance.ts", { "@/lib/supabase": { supabase: { from(table) {
  assert.equal(table, "contractor_compliance_status");
  let start, end;
  const query = {
    select(columns) { assert.equal(columns, "*"); return query; },
    not(field, operation, value) { assert.deepEqual([field, operation, value], ["compliance_record_id", "is", null]); return query; },
    order(field) { assert.equal(field, "compliance_record_id"); return query; },
    range(first, last) { start = first; end = last; ranges.push([start, end]); return query; },
    returns() { return query; },
    then(resolve, reject) { return Promise.resolve(start === failureAt
      ? { data: null, error: { message: "Synthetic page failure" } }
      : { data: large.slice(start, end + 1), error: null }).then(resolve, reject); },
  };
  return query;
} } } });
assert.equal((await compliance.getComplianceRecords()).data.length, large.length);
assert.deepEqual(ranges, [[0, 499], [500, 999], [1000, 1499]]);
failureAt = 500;
const failed = await compliance.getComplianceRecords();
assert.equal(failed.data, null);
assert.equal(failed.error.message, "Synthetic page failure", "Never display partial counts as authoritative.");

const today = "2026-11-07";
const followups = [
  { id: 1, status: "Open", followup_date: "2026-11-06" },
  { id: 2, status: "Waiting Response", followup_date: today },
  { id: 3, status: "Open", followup_date: "2026-11-08" },
  { id: 4, status: "Open", followup_date: null },
  { id: 5, status: "Closed", followup_date: "2026-11-06" },
  { id: 6, status: "Resolved", followup_date: today },
].map(row => ({ ...row, contractor_id: row.id, contractor: { company_name: `Queue Company ${row.id}` },
  subject: row.id === 1 ? "Long subject ".repeat(30) : `Follow-up ${row.id}`,
  notes: row.id === 1 ? "Full follow-up details ".repeat(60) : "Short notes", created_at: "2026-01-01" }));
for (const [filter, expected] of [["open", 4], ["overdue", 1], ["today", 1], ["upcoming", 1]]) {
  assert.equal(followups.filter(row => matchesFollowupFilter(row, filter, today)).length, expected);
}
assert.equal(localCalendarDate(new Date(2026, 10, 7, 23, 59)), today);
assert.equal(localCalendarDate(new Date(2026, 10, 8, 0, 1)), "2026-11-08");
assert.equal(matchesFollowupFilter(followups[1], "overdue", "2026-11-08"), true);
assert.equal(matchesFollowupFilter(followups[3], "upcoming", today), false);
console.log("PASS: view-authoritative compliance populations, all-page reads, partial-page failure, local follow-up dates and undated/closed handling.");

if (process.env.OPERATIONS_UNIT_ONLY === "1") process.exit(0);
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "../worker/nj-pwc/node_modules/playwright");
const app = process.env.TEST_APP_URL || "http://localhost:3000";
assert.ok(["localhost", "127.0.0.1"].includes(new URL(app).hostname), "Use an intercepted local preview.");
const origin = new URL(read(".env.local").match(/^NEXT_PUBLIC_SUPABASE_URL\s*=\s*["']?([^"'\r\n]+)/m)[1].trim()).origin;
const user = { id: "00000000-0000-0000-0000-000000000001", email: "fixture@example.invalid", aud: "authenticated", app_metadata: {}, user_metadata: {} };
const modules = ["dashboard", "documents", "compliance", "followups", "contractors", "projects", "reports", "communications_summary", "settings"];
const browser = await chromium.launch({ headless: true });
let complianceFailure = false, queueFailure = false, denyModule = "";
let followupReads = 0;
const errors = [], writes = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: "America/New_York" });
  await context.addInitScript(({ origin, user }) => localStorage.setItem(`sb-${new URL(origin).hostname.split(".")[0]}-auth-token`,
    JSON.stringify({ access_token: "synthetic-token", refresh_token: "synthetic-refresh", token_type: "bearer",
      expires_at: Math.floor(Date.now() / 1000) + 3600, user })), { origin, user });
  await context.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin === new URL(app).origin) {
      if (url.pathname === "/api/auth/session") return route.fulfill({ json: {
        profile: { ...user, name: "Synthetic Review", role: "Test", status: "Active", system_administrator: false },
        permissions: modules.map(module => ({ module, can_view: module !== denyModule, can_manage: false })),
      } });
      if (url.pathname === "/api/admin/bootstrap") return route.fulfill({ json: {} });
      assert.ok(!url.pathname.startsWith("/api/"), `Unexpected API request: ${url.pathname}`);
      return route.continue();
    }
    assert.equal(url.origin, origin);
    if (url.pathname.startsWith("/auth/")) return route.fulfill({ json: user });
    if (!["GET", "HEAD"].includes(request.method())) {
      writes.push(url.pathname);
      return route.abort();
    }
    const table = url.pathname.split("/").at(-1);
    if (table === "contractor_compliance_status") {
      if (complianceFailure) return route.fulfill({ status: 403, json: { message: "Synthetic compliance denied" } });
      const offset = Number(url.searchParams.get("offset") || 0), limit = Number(url.searchParams.get("limit") || 500);
      return route.fulfill({ json: records.slice(offset, offset + limit) });
    }
    if (table === "contractor_followups") {
      followupReads++;
      assert.equal(url.searchParams.get("status"), "in.(Open,Waiting Response)");
      if (queueFailure) return route.fulfill({ status: 403, json: { message: "Synthetic follow-ups denied" } });
      return route.fulfill({ json: followups.filter(row => ["Open", "Waiting Response"].includes(row.status)) });
    }
    assert.ok(["contractors", "compliance_types"].includes(table), `Unexpected table: ${table}`);
    return route.fulfill({ json: [] });
  });
  const page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  await page.clock.setFixedTime(new Date("2026-11-07T17:00:00Z"));
  const checkShell = async name => {
    const sidebar = page.locator("#app-navigation");
    assert.equal(await sidebar.count(), 1);
    assert.equal(await sidebar.locator('[aria-current="page"]').innerText(), name);
    assert.equal(await sidebar.locator("nav svg").count(), await sidebar.locator("nav a").count());
    assert.equal(await sidebar.getByRole("img", { name: "Dobco", exact: true }).count(), 1);
    assert.equal(await page.getByText("Synthetic Review", { exact: true }).count() >= 1, true);
  };
  await page.goto(`${app}/documents`);
  await page.getByRole("heading", { name: "Document Management", exact: true }).waitFor();
  await checkShell("Documents");
  assert.equal(await page.locator('input[type="file"]').count(), 0);
  assert.match(await page.locator("main").innerText(), /contractor and compliance records/);

  await page.goto(`${app}/compliance`);
  const complianceTable = page.getByRole("table", { name: "Compliance directory", exact: true });
  await complianceTable.waitFor();
  await checkShell("Compliance");
  assert.equal(await complianceTable.locator("tbody tr").count(), records.length);
  assert.deepEqual(await complianceTable.evaluate(table => ({
    font: getComputedStyle(table).fontSize,
    headerFont: getComputedStyle(table.querySelector("th")).fontSize,
    cellBorder: getComputedStyle(table.querySelector("td")).borderLeftWidth,
  })), { font: "13px", headerFont: "11px", cellBorder: "0px" }, "The directory uses shared compact Style 3 table primitives.");
  assert.ok((await page.getByRole("searchbox", { name: "Search compliance records", exact: true }).boundingBox()).width >= 300,
    "Desktop search retains enough width for its full label.");
  assert.deepEqual(await complianceTable.locator("th").allTextContents(), ["Contractor Name", "Compliance Type", "Registration Number", "Effective Date", "Expiration Date", "Days Remaining", "Calculated Status"]);
  const summary = page.getByRole("region", { name: "Compliance overview", exact: true });
  for (const [label, expected] of [["Expired", 3], ["Expiring \u226430 Days", 2], ["Expiring 31\u201390 Days", 4], ["Total Records", 12]]) {
    const card = summary.getByRole("button").filter({ has: page.getByRole("heading", { name: label, exact: true }) });
    assert.equal(await card.locator("strong").innerText(), String(expected));
    await card.click();
    assert.equal(await complianceTable.locator("tbody tr").count(), expected);
  }
  for (const row of ["Active", "90 Day", "60 Day", "30 Day", "Expired", "Missing Information"]) {
    const label = row === "Active" ? "Current" : row;
    await page.getByRole("button", { name: `Compliance Status: ${label}, ${count(row)} records`, exact: true }).click();
    assert.equal(await complianceTable.locator("tbody tr").count(), count(row));
  }
  for (const [key, label] of [["30 Day", "\u226430 days"], ["60 Day", "31\u201360 days"], ["90 Day", "61\u201390 days"], ["90+", "90+ days"]]) {
    await page.getByRole("button", { name: `Expiration Outlook: ${label}, ${count(key)} records`, exact: true }).click();
    assert.equal(await complianceTable.locator("tbody tr").count(), count(key));
  }
  await page.getByRole("button", { name: "Clear filters", exact: true }).click();
  await page.getByRole("searchbox", { name: "Search compliance records", exact: true }).fill("REG-12");
  assert.equal(await complianceTable.locator("tbody tr").count(), 1);
  await page.getByRole("searchbox").fill("not-a-record");
  await page.getByText("No compliance records found.", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Clear filters", exact: true }).click();

  for (const route of ["documents", "compliance", "followups"]) {
    await page.goto(`${app}/${route}`);
    await page.getByRole("heading", { level: 1 }).waitFor();
    for (const [width, height] of [[2560, 1440], [1440, 1000], [900, 900], [390, 844], [320, 640]]) {
      await page.setViewportSize({ width, height });
      await page.waitForTimeout(100);
      const bounds = await page.evaluate(() => ({
        overflow: document.documentElement.scrollWidth > innerWidth,
        content: document.querySelector("main > div").getBoundingClientRect().toJSON(),
      }));
      assert.equal(bounds.overflow, false, `${route} has no page overflow at ${width}px`);
      assert.ok(bounds.content.width <= 2100, "Shared content maximum is preserved.");
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${app}/followups`);
  const queue = page.getByRole("table", { name: "Follow-up work queue", exact: true });
  await queue.waitFor();
  await checkShell("Follow-Ups");
  assert.equal(await queue.locator("tbody tr").count(), 4);
  const overview = page.getByRole("region", { name: "Follow-up overview", exact: true });
  for (const [label, expected] of [["Overdue", 1], ["Due Today", 1], ["Upcoming", 1], ["Open", 4]]) {
    const card = overview.getByRole("button").filter({ has: page.getByRole("heading", { name: label, exact: true }) });
    assert.equal(await card.locator("strong").innerText(), String(expected));
    await card.click();
    assert.equal(await queue.locator("tbody tr").count(), expected);
  }
  assert.equal(await queue.getByRole("link", { name: "Open Company", exact: true }).first().getAttribute("href"), "/contractors/1");
  const longRow = queue.locator("tbody tr").first();
  assert.ok((await longRow.boundingBox()).height < 150, "Long text stays compact by default.");
  await longRow.getByText("View follow-up details", { exact: true }).click();
  assert.equal(await longRow.locator("details").last().getAttribute("open"), "");
  assert.match(await longRow.innerText(), /Full follow-up details/);
  const reads = followupReads;
  await page.getByRole("button", { name: "Refresh Follow-Ups", exact: true }).click();
  await queue.waitFor();
  assert.ok(followupReads > reads);
  await page.clock.setFixedTime(new Date("2026-11-08T17:00:00Z"));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForFunction(() => Array.from(document.querySelectorAll('section[aria-label="Follow-up overview"] button'))
    .find(button => button.querySelector("h2")?.textContent === "Overdue")?.querySelector("strong")?.textContent === "2");
  await overview.getByRole("button").filter({ has: page.getByRole("heading", { name: "Upcoming", exact: true }) }).click();
  await page.getByText("No follow-ups in this view.", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Show all open", exact: true }).click();
  queueFailure = true;
  await page.getByRole("button", { name: "Refresh Follow-Ups", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "Synthetic follow-ups denied" }).waitFor();
  assert.equal(await overview.getByRole("button", { disabled: true }).count(), 4);
  queueFailure = false;
  await page.getByRole("button", { name: "Refresh Follow-Ups", exact: true }).click();
  await queue.waitFor();
  complianceFailure = true;
  await page.goto(`${app}/compliance`);
  await page.getByRole("alert").filter({ hasText: "Synthetic compliance denied" }).waitFor();
  assert.equal(await page.getByRole("region", { name: "Compliance overview", exact: true }).getByRole("button", { disabled: true }).count(), 4);
  complianceFailure = false;
  for (const denied of ["documents", "compliance", "followups", "contractors"]) {
    denyModule = denied;
    await page.goto(`${app}/${denied === "contractors" ? "followups" : denied}`);
    await page.getByRole("heading", { name: "Access Denied", exact: true }).waitFor();
  }
  assert.deepEqual(writes, [], "No database changes or email sends.");
  assert.deepEqual(errors, []);
  console.log("PASS: all three shared shells, cards/charts/search filters, exact directory columns, compact expanded details, refresh/recovery, permissions, 320-2560px layouts and zero writes.");
} finally {
  await browser.close();
}
