import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { test } from "node:test";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const source = fs.readFileSync(path.join(root, "services", "followups.ts"), "utf8");
const followup = (id, status = "Open", contractorId = 17, date = "2026-10-01") => ({
  id, status, contractor_id: contractorId, followup_date: date, followup_method: "Email",
  subject: `Follow-up ${id}`, notes: `Notes ${id}`, created_at: "2026-10-01T12:00:00Z",
  contractor: { company_name: `Company ${contractorId}` },
});

function serviceFixture(initial) {
  const rows = structuredClone(initial);
  const calls = [];
  let failAt = null;
  class Query {
    constructor(table) { this.table = table; this.filters = []; this.orders = []; this.start = 0; this.end = Infinity; calls.push(this); }
    select(columns) { this.columns = columns; return this; }
    in(field, values) { this.filters.push((row) => values.includes(row[field])); this.statuses = values; return this; }
    eq(field, value) { this.filters.push((row) => row[field] === value); return this; }
    order(field, options) { this.orders.push({ field, ...options }); return this; }
    range(start, end) { this.start = start; this.end = end; return this; }
    returns() { return this; }
    insert(value) { this.inserted = value; return this; }
    update(value) { this.updated = value; return this; }
    then(resolve, reject) {
      if (this.start === failAt) return Promise.resolve({ data: null, error: { message: "Synthetic read failure" } }).then(resolve, reject);
      if (this.inserted) rows.push({ id: 10000, created_at: "2026-10-01", ...this.inserted });
      let found = rows.filter((row) => this.filters.every((filter) => filter(row)));
      if (this.updated) found.forEach((row) => Object.assign(row, this.updated));
      found = found.toSorted((a, b) => {
        for (const { field, ascending, nullsFirst } of this.orders) {
          if (a[field] === b[field]) continue;
          if (a[field] == null) return nullsFirst === false ? 1 : -1;
          if (b[field] == null) return nullsFirst === false ? -1 : 1;
          const order = a[field] < b[field] ? -1 : 1;
          return ascending ? order : -order;
        }
        return 0;
      });
      return Promise.resolve({ data: found.slice(this.start, this.end + 1), error: null, count: found.length }).then(resolve, reject);
    }
  }
  const loaded = { exports: {} };
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, {
    module: loaded, exports: loaded.exports,
    require(name) {
      assert.equal(name, "@/lib/supabase");
      return { supabase: { from: (table) => new Query(table) } };
    },
  });
  return { service: loaded.exports, calls, rows, fail: (offset) => { failAt = offset; } };
}

test("queue reuses company follow-ups, including create/close/reopen and retained history", async () => {
  const fixture = serviceFixture([
    followup(1), followup(2, "Waiting Response"), followup(3, "Closed", 18), followup(4, "Resolved", 19),
  ]);
  const { service, calls } = fixture;
  let result = await service.getOpenFollowups();
  assert.deepEqual(Array.from(result.data, (row) => row.id), [1, 2]);
  assert.ok(calls.every((call) => call.table === "contractor_followups"));
  assert.match(calls[0].columns, /contractor:contractors!inner\(company_name\)/);
  assert.deepEqual(Array.from(calls[0].statuses), ["Open", "Waiting Response"]);
  const created = await service.createFollowup({ ...followup(5), id: undefined });
  assert.equal(created.error, null);
  result = await service.getOpenFollowups();
  assert.equal(result.data.length, 3, "a newly created company follow-up joins the queue");
  await service.updateFollowup(1, { status: "Closed" });
  result = await service.getOpenFollowups();
  assert.equal(result.data.length, 2);
  assert.ok(!result.data.some((row) => row.id === 1));
  const history = await service.getFollowupsForContractor(17);
  assert.equal(history.data.find((row) => row.id === 1).status, "Closed", "closing never deletes the record");
  await service.updateFollowup(1, { status: "Open" });
  assert.equal((await service.getOpenFollowups()).data.length, 3);
  assert.ok(!(await service.getOpenFollowups()).data.some((row) => [18, 19].includes(row.contractor_id)));
});

test("queue reads every page, sorts dates oldest first and undated items last", async () => {
  const many = Array.from({ length: 1005 }, (_, id) => followup(id + 10));
  const { service, calls } = serviceFixture([
    followup(1, "Open", 17, "2026-12-01"),
    followup(2, "Open", 17, null),
    followup(3, "Open", 17, "2026-09-01"),
    ...many,
  ]);
  const result = await service.getOpenFollowups();
  assert.equal(result.data.length, 1008);
  assert.equal(result.data[0].id, 3);
  assert.equal(result.data.at(-1).id, 2);
  assert.deepEqual(calls.map(({ start, end }) => [start, end]), [[0, 499], [500, 999], [1000, 1499]]);
  assert.equal(new Set(result.data.map((row) => row.id)).size, result.data.length);
});

test("failed pages expose an error rather than a partial or success-shaped empty queue", async () => {
  const fixture = serviceFixture(Array.from({ length: 501 }, (_, id) => followup(id)));
  fixture.fail(500);
  const result = await fixture.service.getOpenFollowups();
  assert.equal(result.data, null);
  assert.equal(result.error.message, "Synthetic read failure");
});

test("mounted Dashboard queue, count, navigation, permissions, refresh and unchanged compliance cards", async () => {
  const webpack = require("next/dist/compiled/webpack/webpack").webpack;
  const { chromium } = createRequire(path.join(root, "worker", "nj-pwc", "package.json"))("playwright");
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "subtracker-dashboard-followups-"));
  const file = (name, content) => {
    const target = path.join(temporary, name);
    fs.writeFileSync(target, content);
    return target;
  };
  const entry = file("entry.js", `
    const React = require(${JSON.stringify(require.resolve("react"))});
    const {createRoot} = require(${JSON.stringify(require.resolve("react-dom/client"))});
    const Home = require(${JSON.stringify(path.join(root, "src", "app", "page.tsx"))}).default;
    const {SessionContext} = require(${JSON.stringify(path.join(root, "src", "components", "SessionContext.tsx"))});
    const allowed = new URLSearchParams(location.search).get("access") !== "denied";
    createRoot(document.getElementById("root")).render(React.createElement(SessionContext.Provider, {
      value: {system_administrator:false, permissions: [
        {module:"contractors",can_view:true}, {module:"followups",can_view:allowed}
      ]}
    }, React.createElement(Home)));
  `);
  const supabase = file("supabase.js", `
    export const supabase = {from(table) {
      const request = {table,orders:[]};
      const query = {
        select(columns){request.columns=columns;return query},
        in(field,values){request[field]=values;return query},
        order(field,options){request.orders.push({field,...options});return query},
        range(start,end){request.start=start;request.end=end;return query},
        returns(){return query},
        then(resolve,reject){return fetch("/followups?query="+encodeURIComponent(JSON.stringify(request)))
          .then(response=>response.json()).then(resolve,reject)}
      };
      return query;
    }};
  `);
  const dashboard = file("dashboard.js", `
    export const getCompanyComplianceStatus = () => "Compliant";
    export const getDashboardData = async () => ({error:null,data:{
      activeContractorCount:7, materialVendorCount:2, inactiveContractorCount:3, inactiveProjectCount:4,
      projectNumbersByContractor:new Map(), records:[{
        contractor_id:17,company_name:"Company 17",record_key:"compliance:1",compliance_name:"NJ PWC",
        registration_number:"123",expiration_date:"2027-01-01",calculated_status:"Active"
      }]
    }});
  `);
  const pwc = file("pwc.js", `export const getPwcMissing = async () => ({data:[],error:null});`);
  const link = file("link.js", `const React=require(${JSON.stringify(require.resolve("react"))});module.exports=({href,children,...props})=>React.createElement("a",{href,...props},children);`);
  const dynamic = file("dynamic.js", "module.exports=()=>()=>null;");
  let server;
  let browser;
  try {
    await new Promise((resolve, reject) => {
      const compiler = webpack({
        mode: "development", devtool: false, entry, output: { path: temporary, filename: "bundle.js" },
        resolve: {
          extensions: [".tsx", ".ts", ".js"],
          modules: [path.join(root, "node_modules"), "node_modules"],
          alias: {
            "next/link": link, "next/dynamic": dynamic,
            "@/components/exports/DashboardExportDialog": dynamic,
            "@/lib/supabase": supabase,
            "@/lib/permissions": path.join(root, "src", "lib", "permissions.ts"),
            "@/services/dashboard": dashboard, "@/services/pwc-missing": pwc,
            "@/services/followups": path.join(root, "services", "followups.ts"),
            "@/components/DashboardFollowups": path.join(root, "src", "components", "DashboardFollowups.tsx"),
          },
        },
        module: { rules: [
          { test: /\.tsx?$/, use: [{ loader: path.join(root, "scripts", "fixtures", "company-merge-ui", "tsx-loader.cjs") }] },
          { test: /\.css$/, type: "asset/source" },
        ] },
      });
      compiler.run((error, stats) => compiler.close(() => {
        if (error) reject(error);
        else if (stats.hasErrors()) reject(new Error(stats.toString({ all: false, errors: true })));
        else resolve();
      }));
    });
    server = http.createServer((request, response) => {
      if (request.url === "/bundle.js") {
        response.writeHead(200, { "content-type": "text/javascript" });
        fs.createReadStream(path.join(temporary, "bundle.js")).pipe(response);
      } else {
        response.writeHead(200, { "content-type": "text/html" });
        response.end('<!doctype html><html><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let rows = [followup(1), followup(2, "Waiting Response"), followup(3, "Closed", 18)];
    let failure = false;
    let reads = 0;
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      assert.equal(url.origin, origin, "no external or production requests");
      if (url.pathname !== "/followups") return route.continue();
      assert.equal(route.request().method(), "GET", "the dashboard queue is read-only");
      reads++;
      const query = JSON.parse(url.searchParams.get("query"));
      assert.equal(query.table, "contractor_followups");
      const data = rows.filter((row) => query.status.includes(row.status)).slice(query.start, query.end + 1);
      return route.fulfill({ json: failure ? { data: null, error: { message: "Synthetic denied read" } } : { data, error: null } });
    });
    await page.goto(origin);
    await page.getByRole("button", { name: "2 Follow-Ups", exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "New Review", exact: true }).count(), 0);
    const cards = page.locator('section[aria-label="Dashboard filters"]');
    const originalCards = cards.locator(":scope > button, :scope > a").filter({ hasNotText: "Follow-Ups" });
    const complianceCounts = await originalCards.allTextContents();
    const summaryCards = cards.locator(":scope > button, :scope > a");
    assert.equal(await summaryCards.count(), 9);
    assert.match(await summaryCards.nth(7).innerText(), /PWC Missing/);
    assert.equal(await summaryCards.nth(8).innerText(), "2\nFollow-Ups");
    assert.match(await summaryCards.nth(8).getAttribute("class"), /bg-violet-50/);
    assert.match(await summaryCards.nth(8).getAttribute("class"), /rounded-2xl/);
    assert.equal(await page.locator("main > div > header").getByRole("button", { name: /Follow-Ups/ }).count(), 0);
    assert.match(complianceCounts.join(" "), /7\s*All Companies/);
    assert.equal(await page.getByRole("button", { name: "Export", exact: true }).isEnabled(), true);
    await page.getByRole("button", { name: "2 Follow-Ups", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Open Follow-Ups", exact: true });
    await dialog.getByText("Follow-up 2", { exact: true }).waitFor();
    assert.equal(await dialog.locator("tbody tr").count(), 2, "multiple items for the same company remain separate");
    assert.equal(await dialog.getByRole("link", { name: "Open Company" }).first().getAttribute("href"), "/contractors/17");
    assert.equal(await dialog.getByText("Company 18", { exact: true }).count(), 0, "closed-history-only company is absent");
    assert.match(await dialog.innerText(), /Waiting Response/);
    rows.push(followup(4));
    await dialog.getByRole("button", { name: "Refresh follow-ups" }).click();
    await page.getByRole("button", { name: "3 Follow-Ups", exact: true }).waitFor();
    assert.equal(await dialog.locator("tbody tr").count(), 3);
    rows[0].status = "Closed";
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.getByRole("button", { name: "2 Follow-Ups", exact: true }).waitFor();
    assert.equal(await dialog.locator("tbody tr").count(), 2);
    assert.equal(rows.find((row) => row.id === 1).status, "Closed", "source history still contains the closed item");
    rows[0].status = "Open";
    await dialog.getByRole("button", { name: "Close Follow-Ups" }).click();
    await page.getByRole("button", { name: "2 Follow-Ups", exact: true }).click();
    await page.getByRole("button", { name: "3 Follow-Ups", exact: true }).waitFor();
    assert.equal(await dialog.locator("tbody tr").count(), 3, "reopened company item returns");
    assert.deepEqual(await originalCards.allTextContents(), complianceCounts, "compliance card counts are unchanged by follow-up mutations");
    failure = true;
    await dialog.getByRole("button", { name: "Refresh follow-ups" }).click();
    await dialog.getByRole("alert").waitFor();
    assert.equal(await dialog.getByRole("alert").innerText(), "Synthetic denied read");
    assert.equal(await page.getByRole("button", { name: "! Follow-Ups", exact: true }).count(), 1);
    assert.equal(await dialog.locator("tbody tr").count(), 0);
    failure = false;
    rows = rows.map((row) => ({ ...row, status: "Closed" }));
    await dialog.getByRole("button", { name: "Refresh follow-ups" }).click();
    await page.getByRole("button", { name: "0 Follow-Ups", exact: true }).waitFor();
    await dialog.getByText("No open follow-ups.", { exact: true }).waitFor();
    await page.keyboard.press("Escape");
    assert.equal(await dialog.count(), 0);
    assert.equal(await page.getByRole("button", { name: "0 Follow-Ups", exact: true }).evaluate((element) => element === document.activeElement), true);
    const beforeDenied = reads;
    await page.goto(`${origin}/?access=denied`);
    await page.getByRole("heading", { name: "Dashboard", exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: /Follow-Ups/ }).count(), 0);
    assert.equal(reads, beforeDenied, "follow-up data is not queried without view permission");
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    if (server) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
