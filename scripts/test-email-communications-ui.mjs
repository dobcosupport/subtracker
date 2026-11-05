import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const app = process.env.TEST_APP_URL;
assert.ok(app && new URL(app).hostname === "localhost", "Use an intercepted localhost preview only");
const origin = new URL(fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8")
  .match(/^NEXT_PUBLIC_SUPABASE_URL\s*=\s*["']?([^"'\r\n]+)/m)[1].trim()).origin;
const user = { id: "00000000-0000-0000-0000-000000000001", email: "fixture@example.invalid",
  aud: "authenticated", app_metadata: {}, user_metadata: {} };
const areas = ["Overview", "Scheduled", "Sent", "Templates", "Dobco Contacts", "Notifications", "Settings"];
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1680, height: 1000 } });
  let settings = true, communications = false;
  const reads = [], errors = [];
  await context.addInitScript(({ origin, user }) => localStorage.setItem(
    `sb-${new URL(origin).hostname.split(".")[0]}-auth-token`,
    JSON.stringify({ access_token: "synthetic-token", refresh_token: "synthetic-refresh", token_type: "bearer",
      expires_at: Math.floor(Date.now() / 1000) + 3600, user })), { origin, user });
  await context.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== new URL(app).origin) {
      assert.equal(url.origin, origin);
      assert.ok(url.pathname.startsWith("/auth/"), "No database, provider or outbound message requests");
      assert.ok(["GET", "HEAD"].includes(request.method()), "No external mutations");
      return route.fulfill({ json: user });
    }
    if (url.pathname === "/api/admin/bootstrap") return route.fulfill({ json: {} });
    if (url.pathname === "/api/auth/session") return route.fulfill({ json: {
      profile: { auth_user_id: user.id, name: "Synthetic", status: "Active", system_administrator: false },
      permissions: [
        { module: "settings", can_view: settings, can_manage: false },
        { module: "communications_summary", can_view: communications, can_manage: false },
      ],
    } });
    if (url.pathname.startsWith("/api/")) {
      assert.equal(request.method(), "GET", "Navigation/shells cannot mutate any backend");
      reads.push(url.pathname);
      if (url.pathname === "/api/admin/dobco-contacts") return route.fulfill({ json: { contacts: [{
        id: "00000000-0000-0000-0000-000000000011", contact_name: "Internal Dobco Fixture",
        email: "internal@example.invalid", mobile_phone: "201-555-0111", is_active: true,
        receives_internal_email: true, receives_internal_sms: false, sms_consent_recorded: false,
        sms_consent_date: null, sms_consent_source_or_note: null, user_profile_id: null,
      }] } });
      if (url.pathname === "/api/admin/notifications") return route.fulfill({ json: {
        automation: { email: { automated_enabled: false, revision: 1 }, sms: { automated_enabled: false, revision: 1 } },
        rules: [], execution_enabled: false,
      } });
      assert.fail(`Unexpected API request: ${url.pathname}`);
    }
    return route.continue();
  });
  const page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await page.goto(`${app}/settings`);
  const sidebar = page.locator("aside");
  const navigation = sidebar.getByRole("link", { name: /Email Communications/ });
  await navigation.waitFor();
  assert.equal(await navigation.getAttribute("href"), "/email-communications");
  assert.deepEqual(await page.getByRole("tab").allTextContents(), ["General", "Email", "Text Messaging", "Templates"]);
  assert.equal(await sidebar.getByRole("link", { name: /Dobco Contacts|Notifications/ }).count(), 0);
  await navigation.click();
  await page.getByRole("heading", { name: "Email Communications", exact: true }).waitFor();
  assert.equal(await navigation.getAttribute("aria-current"), "page");
  assert.deepEqual(await page.getByRole("tab").allTextContents(), areas);
  const panel = page.getByRole("tabpanel");
  for (const name of ["Overview", "Scheduled", "Sent", "Templates", "Settings"]) {
    await page.getByRole("tab", { name, exact: true }).click();
    await panel.getByRole("heading", { name, exact: true }).waitFor();
    assert.match(await panel.innerText(), /Not implemented in this checkpoint/);
    assert.equal(await panel.locator("button,input,select,textarea").count(), 0, "shell has no invented controls");
  }
  assert.deepEqual(reads, [], "future areas perform no data/provider reads");
  await page.getByRole("tab", { name: "Dobco Contacts", exact: true }).click();
  await panel.getByText("Internal Dobco Fixture", { exact: true }).waitFor();
  await page.getByRole("tab", { name: "Notifications", exact: true }).click();
  await panel.getByRole("heading", { name: "Compliance Notifications", exact: true }).waitFor();
  await panel.getByText("No reminder rules configured.", { exact: false }).waitFor();
  assert.deepEqual([...new Set(reads)].sort(), ["/api/admin/dobco-contacts", "/api/admin/notifications"]);
  const container = page.locator("main > div");
  assert.ok(await container.evaluate(element => element.getBoundingClientRect().width <= 1024), "compact bounded section");
  if (process.env.TEST_SCREENSHOT) await page.locator("main").screenshot({ path: process.env.TEST_SCREENSHOT });
  await page.setViewportSize({ width: 800, height: 900 });
  assert.ok(await page.getByRole("tablist").evaluate(element => element.scrollWidth >= element.clientWidth), "tabs scroll instead of expanding the page");
  settings = false; communications = true;
  const beforeDenied = reads.length;
  await page.reload();
  await page.getByRole("heading", { name: "Email Communications", exact: true }).waitFor();
  for (const name of ["Dobco Contacts", "Notifications"]) {
    await page.getByRole("tab", { name, exact: true }).click();
    await panel.getByRole("status").filter({ hasText: "Settings View permission is required" }).waitFor();
  }
  assert.equal(reads.length, beforeDenied, "Communications-only access cannot query Settings-protected panels");
  communications = false;
  await page.reload();
  await page.getByRole("heading", { name: "Access Denied", exact: true }).waitFor();
  await page.goto(`${app}/settings`);
  await page.getByRole("heading", { name: "Access Denied", exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log("PASS: top-level Email Communications, seven compact areas, backend-free shells, reused Settings-protected panels, no duplicate Settings tabs, access separation and no console/hydration errors.");
} finally { await browser.close(); }
