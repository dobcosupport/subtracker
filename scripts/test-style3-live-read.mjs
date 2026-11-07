import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
import ts from "typescript";
import { createClient } from "@supabase/supabase-js";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "../worker/nj-pwc/node_modules/playwright");
const app = process.env.TEST_APP_URL || "http://localhost:3000";
assert.equal(new URL(app).hostname, "localhost", "The browser must use localhost.");
const env = {};
for (const line of fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/)) {
  const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (match) env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
}
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const supabaseOrigin = new URL(env.NEXT_PUBLIC_SUPABASE_URL).origin;
class AdminApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}
function load(file, dependencies) {
  const loaded = { exports: {} };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL(file, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, { module: loaded, exports: loaded.exports, Response, require(name) {
    if (!(name in dependencies)) throw new Error(`Unexpected dependency ${name}`);
    return dependencies[name];
  } });
  return loaded.exports;
}
const route = load("../src/app/api/dashboard/eligibility/route.ts", {
  "@/lib/server-admin": {
    AdminApiError, jsonError: error => Response.json({ error: error.message }, { status: error.status ?? 500 }),
    requireModulePermission: async () => ({ admin, profile: { system_administrator: true } }),
  },
  "@/services/style3-overall-compliance": load("../services/style3-overall-compliance.ts", {}),
});
const response = await route.GET(new Request("http://localhost/api/dashboard/eligibility"));
const data = await response.json();
assert.equal(response.status, 200, "The production-backed Dashboard service must succeed.");
const metricModule = load("../services/style3-compliance-metrics.ts", {});
const { summarizeDashboardCompliance } = load("../services/style3-dashboard-compliance.ts", {
  "@/services/style3-compliance-metrics": metricModule, "@/lib/admin-client": {},
  "@/lib/followup-related-item": { insuranceRelatedItems: [{ key: "general_liability" }, { key: "workers_compensation" }] },
});
const summary = summarizeDashboardCompliance(data);
const activeResult = await admin.from("contractors").select("id", { count: "exact", head: true }).eq("active", true);
assert.ifError(activeResult.error);
assert.ok(Number.isSafeInteger(activeResult.count) && activeResult.count >= 0, "Active contractor count must be available.");
assert.ok(summary.population > 0);
assert.deepEqual(
  [summary.overallCompliance.population, summary.overallCompliance.compliant, summary.overallCompliance.nonCompliant,
    summary.overallCompliance.expiringSoon, summary.overallCompliance.needsReview],
  [631, 222, 347, 0, 62],
  "The approved contractor-level distribution must match the reviewed live population.",
);
assert.equal(summary.overallCompliance.compliant + summary.overallCompliance.nonCompliant
  + summary.overallCompliance.expiringSoon + summary.overallCompliance.needsReview, summary.overallCompliance.population);
assert.equal(summary.overallCompliance.rate, 222 / 631 * 100);
assert.ok(summary.knownRequirements.length > 0, "A configured authority is required.");
const knownCount = data.contractors.filter(row => row.applicability === "applicable").length;
assert.ok(knownCount > 0);
assert.ok(summary.metric.knownCurrent + summary.metric.knownDeficient <= knownCount);
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const user = { id: "00000000-0000-0000-0000-000000000001", email: "fixture@example.invalid", aud: "authenticated", app_metadata: {}, user_metadata: {} };
  await context.addInitScript(({ origin, user }) => localStorage.setItem(`sb-${new URL(origin).hostname.split(".")[0]}-auth-token`,
    JSON.stringify({ access_token: "synthetic-token", refresh_token: "synthetic-refresh", token_type: "bearer",
      expires_at: Math.floor(Date.now() / 1000) + 3600, user })), { origin: supabaseOrigin, user });
  await context.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin === new URL(app).origin) {
      if (url.pathname === "/api/auth/session") return route.fulfill({ json: {
        profile: { name: "Synthetic Review", role: "Test", status: "Active", system_administrator: false },
        permissions: ["dashboard", "contractors", "projects", "compliance"].map(module => ({ module, can_view: true })),
      } });
      if (url.pathname === "/api/admin/bootstrap") return route.fulfill({ json: {} });
      if (url.pathname === "/api/dashboard/eligibility") return route.fulfill({ json: data });
      assert.ok(!url.pathname.startsWith("/api/"), `Unexpected API ${url.pathname}`);
      return route.continue();
    }
    assert.equal(url.origin, supabaseOrigin);
    if (url.pathname.startsWith("/auth/")) return route.fulfill({ json: user });
    if (url.pathname.endsWith("/contractors") && request.method() === "HEAD") {
      return route.fulfill({ status: 200, headers: { "content-range": `*/${activeResult.count}`, "access-control-expose-headers": "content-range" } });
    }
    assert.equal(request.method(), "GET", "The browser cannot mutate production.");
    if (url.pathname.endsWith("/projects") || url.pathname.endsWith("/contractor_contacts")) return route.fulfill({ json: [] });
    throw new Error(`Unexpected external request ${url.pathname}`);
  });
  const page = await context.newPage();
  await page.goto(app);
  await page.getByRole("heading", { name: "Overall Contractor Compliance" }).waitFor();
  const month = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric" }).format(new Date());
  await page.getByRole("img", { name: `${month}: ${activeResult.count} active contractors; ${summary.population} active and assigned contractors` }).waitFor();
  assert.match(await page.getByRole("link", { name: "Active Contractors", exact: true }).innerText(),
    new RegExp(`Active Contractors\\s+${activeResult.count}\\s+${summary.population.toLocaleString()} with active project assignments`));
  assert.match(await page.getByRole("link", { name: "Compliance Rate", exact: true }).innerText(),
    /Compliance Rate\s+35\.2%\s+FEIN, NJ BRC, and applicable NJ PWC/);
  const compliance = page.locator("section").filter({ has: page.getByRole("heading", { name: "Overall Contractor Compliance" }) });
  assert.match(await compliance.innerText(), /35\.2%\s+Overall rate/);
  assert.match(await compliance.innerText(), new RegExp(`${summary.population} Active \\+ Assigned Contractors`));
  assert.match(await compliance.innerText(), /Compliant\s+222 · 35\.2%/);
  assert.match(await compliance.innerText(), /Non-Compliant\s+347 · 55\.0%/);
  assert.match(await compliance.innerText(), /Expiring Soon\s+0 · 0\.0%/);
  assert.match(await compliance.innerText(), /Needs Review\s+62 · 9\.8%/);
  assert.equal(await compliance.getByRole("link", { name: "View Compliance →" }).count(), 1);
  assert.doesNotMatch(await compliance.innerText(), /100%|NJ PWC Current/);
  assert.equal(await page.getByText("Compliance data temporarily unavailable").count(), 0);
  console.log(JSON.stringify({ activeContractors: activeResult.count, overallCompliance: summary.overallCompliance }));
  await context.close();
} finally {
  await browser.close();
}
console.log("Production-backed eligibility service and local Dashboard rendering passed (browser auth and other sources intercepted).");
