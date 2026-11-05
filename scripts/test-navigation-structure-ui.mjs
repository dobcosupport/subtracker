import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const app = process.env.TEST_APP_URL;
assert.ok(app && new URL(app).hostname === "localhost", "Use intercepted localhost only");
const origin = new URL(fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8")
  .match(/^NEXT_PUBLIC_SUPABASE_URL\s*=\s*["']?([^"'\r\n]+)/m)[1].trim()).origin;
const user = { id: "00000000-0000-0000-0000-000000000001", email: "fixture@example.invalid",
  aud: "authenticated", app_metadata: {}, user_metadata: {} };
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1080 } });
  let modules = ["dashboard", "contractors", "projects", "documents", "compliance", "followups", "reports",
    "settings", "imports", "audit", "activity", "communications_summary", "users", "roles", "company_merge", "compliance_sync"];
  const reads = [], errors = [];
  let followups = [{ id: 1, contractor_id: 17, subject: "Existing company follow-up", status: "Open",
    followup_date: "2026-11-05", created_at: "2026-11-05T12:00:00Z", notes: null, contractor: { company_name: "Synthetic Company" } }];
  await context.addInitScript(({ origin, user }) => localStorage.setItem(
    `sb-${new URL(origin).hostname.split(".")[0]}-auth-token`,
    JSON.stringify({ access_token: "synthetic-token", refresh_token: "synthetic-refresh", token_type: "bearer",
      expires_at: Math.floor(Date.now() / 1000) + 3600, user })), { origin, user });
  await context.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== new URL(app).origin) {
      assert.equal(url.origin, origin);
      assert.ok(["GET", "HEAD"].includes(request.method()), "No database writes");
      if (url.pathname.startsWith("/auth/")) return route.fulfill({ json: user });
      if (url.pathname.endsWith("/contractor_followups")) {
        assert.ok(modules.includes("followups") && modules.includes("contractors"));
        assert.equal(url.searchParams.get("status"), "in.(Open,Waiting Response)");
        return route.fulfill({ json: followups });
      }
      return route.fulfill({ json: [], headers: { "content-range": "*/0" } });
    }
    if (url.pathname === "/api/admin/bootstrap") return route.fulfill({ json: {} });
    if (url.pathname === "/api/auth/session") return route.fulfill({ json: {
      profile: { auth_user_id: user.id, name: "Synthetic", status: "Active", system_administrator: false },
      permissions: modules.map(module => ({ module, can_view: true, can_manage: module === "company_merge", can_add: false, can_edit: false })),
    } });
    if (url.pathname.startsWith("/api/")) {
      assert.equal(request.method(), "GET", "Structural navigation is read-only");
      reads.push(url.pathname);
      if (url.pathname === "/api/activity-log/contractors") {
        assert.ok(modules.includes("activity"));
        return route.fulfill({ json: { contractors: [{ id: 17, company_name: "Synthetic Company" }], next_offset: null } });
      }
      if (url.pathname === "/api/activity-log") return route.fulfill({ json: {
        contractor: { id: 17, company_name: "Synthetic Company" }, entries: [],
        sources: { activity: true, followups: false, communications: false }, next: null,
      } });
      if (url.pathname === "/api/admin/audit") {
        assert.ok(modules.includes("audit"));
        return route.fulfill({ json: { logs: [], next_offset: null } });
      }
      if (url.pathname === "/api/communications") {
        assert.ok(modules.includes("communications_summary"));
        return route.fulfill({ json: { communications: [], next_offset: null } });
      }
      return route.fulfill({ json: { rows: [], batches: [], runs: [] } });
    }
    return route.continue();
  });
  const page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await page.goto(`${app}/settings`);
  const nav = page.locator("aside nav");
  const mainLinks = nav.locator(":scope > a");
  const adminLinks = nav.locator(":scope > div > a");
  await mainLinks.first().waitFor();
  const labels = locator => locator.evaluateAll(links => links.map(link => link.querySelector("span").lastChild.textContent.trim()));
  assert.deepEqual(await labels(mainLinks), ["Dashboard", "Contractors", "Projects", "Documents", "Compliance", "Follow-Ups", "Email Communications", "Reports"]);
  assert.deepEqual(await labels(adminLinks), ["User Management", "Roles & Permissions", "Company Merge", "Import / Export", "Logs", "Compliance Sync", "Settings"]);
  assert.equal(await nav.locator('a[href="/activity-log"]').count(), 0);
  assert.equal(await nav.locator('a[href="/email-communications"]').count(), 1);
  for (const [href, heading] of [["/documents", "Document Management"], ["/compliance", "Compliance Tracking"], ["/imports", "Import / Export"]]) {
    await nav.locator(`a[href="${href}"]`).click();
    await page.getByRole("heading", { name: heading, exact: true }).waitFor();
    assert.equal(new URL(page.url()).pathname, href);
  }
  await nav.locator('a[href="/followups"]').click();
  await page.getByText("Existing company follow-up", { exact: true }).waitFor();
  assert.equal(await page.getByRole("link", { name: "Open Company", exact: true }).getAttribute("href"), "/contractors/17");
  followups = [];
  await page.getByRole("button", { name: "Refresh follow-ups", exact: true }).click();
  await page.getByText("No open follow-ups.", { exact: true }).waitFor();
  await nav.locator('a[href="/email-communications"]').click();
  await page.getByRole("tab", { name: "Overview", exact: true }).waitFor();
  assert.deepEqual(await page.getByRole("tab").allTextContents(), ["Overview", "Scheduled", "Sent", "Templates", "Dobco Contacts", "Notifications", "Settings"]);
  await nav.locator('a[href="/admin/audit"]').click();
  await page.getByRole("tab", { name: "Activity Log", exact: true }).click();
  await page.getByLabel("Contractor", { exact: true }).selectOption("17");
  await page.getByText("No permitted activity found for this contractor.", { exact: true }).waitFor();
  assert.equal(await nav.locator('a[aria-current="page"]').getAttribute("href"), "/admin/audit");
  modules = ["activity"];
  await page.goto(`${app}/admin/audit`);
  await page.getByRole("heading", { name: "Contractor Activity Log", exact: true }).waitFor();
  assert.equal(await page.getByRole("tab", { name: "Audit Logs", exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole("tab", { name: "Communication Logs", exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole("tab", { name: "Activity Log", exact: true }).getAttribute("aria-selected"), "true");
  const before = reads.length;
  modules = ["imports"];
  await page.goto(`${app}/admin/audit`);
  await page.getByRole("heading", { name: "Access Denied", exact: true }).waitFor();
  assert.equal(reads.length, before, "Import permissions do not grant Logs access");
  await page.goto(`${app}/imports`);
  await page.getByRole("heading", { name: "Import / Export", exact: true }).waitFor();
  modules = ["followups"];
  await page.goto(`${app}/followups`);
  await page.getByRole("heading", { name: "Access Denied", exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log("PASS: exact main/admin ordering, unchanged letter navigation, single Email Communications entry/7 areas, reused Compliance/Documents/Import routes, shared Follow-Ups queue, Logs Activity timeline and independent permission gates; no console/hydration errors.");
} finally { await browser.close(); }
