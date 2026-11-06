import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const app = process.env.TEST_APP_URL;
assert.ok(app && new URL(app).hostname === "localhost", "Use an intercepted local preview.");
const origin = new URL(fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8").match(/^NEXT_PUBLIC_SUPABASE_URL\s*=\s*["']?([^"'\r\n]+)/m)[1].trim()).origin;
const uuid = n => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const user = { id: uuid(1), email: "fixture@example.invalid", aud: "authenticated", app_metadata: {}, user_metadata: {} };
let admin = true, manage = true;
const template = { id: uuid(2), name: "Fixture reminder", channel: "email", revision: 1, is_active: true,
  subject: "Review this exact subject", body: "Review this exact body", approved_by: null, approved_at: null };
let rules = [
  { id: uuid(10), compliance_type_id: 1, insurance_item_key: null, name: "Fixture Expiring", retired: false, expiration_allowed: true,
    automatic_enabled: false, schedule_type: "expiration", sender_contact_id: null, internal_contact_id: null, revision: 1, intervals: [] },
  { id: uuid(11), compliance_type_id: 2, insurance_item_key: null, name: "Fixture Non-Expiring", retired: false, expiration_allowed: false,
    automatic_enabled: false, schedule_type: "non_expiring", sender_contact_id: null, internal_contact_id: null, revision: 1, intervals: [] },
  { id: uuid(12), compliance_type_id: null, insurance_item_key: "certificate_of_insurance", name: "Certificate of Insurance (Retired / Historical)", retired: true, expiration_allowed: true,
    automatic_enabled: false, schedule_type: "expiration", sender_contact_id: null, internal_contact_id: null, revision: 1, intervals: [] },
];
const writes = [], errors = [];
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext();
  await context.addInitScript(({ origin, user }) => localStorage.setItem(`sb-${new URL(origin).hostname.split(".")[0]}-auth-token`,
    JSON.stringify({ access_token: "synthetic-token", refresh_token: "synthetic-refresh", token_type: "bearer", expires_at: Math.floor(Date.now()/1000)+3600, user })), { origin, user });
  await context.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== new URL(app).origin) {
      assert.equal(url.origin, origin);
      assert.ok(url.pathname.startsWith("/auth/") && ["GET", "HEAD"].includes(request.method()), "No real database or provider requests.");
      return route.fulfill({ json: user });
    }
    if (url.pathname === "/api/admin/bootstrap") return route.fulfill({ json: {} });
    if (url.pathname === "/api/auth/session") return route.fulfill({ json: {
      profile: { auth_user_id: user.id, name: "Fixture", role: admin ? "Administrator" : "Manager", status: "Active", system_administrator: false },
      permissions: [{ module: "settings", can_view: true, can_manage: manage }],
    } });
    if (url.pathname === "/api/admin/notifications") return route.fulfill({ json: {
      automation: { email: { automated_enabled: false, revision: 1 }, sms: { automated_enabled: false, revision: 1 } }, rules: [], execution_enabled: false,
    } });
    if (url.pathname === "/api/admin/notifications/requirements") {
      if (request.method() === "GET") return route.fulfill({ json: { rules, templates: [template], contacts: [], execution_enabled: false } });
      assert.equal(request.method(), "POST"); assert.ok(manage);
      const input = request.postDataJSON(); writes.push({ path: url.pathname, input });
      rules = rules.map(rule => rule.id === input.id ? { ...rule, ...input, configuration_ready: true, revision: input.revision + 1 } : rule);
      return route.fulfill({ json: { id: input.id, execution_enabled: false } });
    }
    if (url.pathname === `/api/admin/communication-templates/${template.id}/approve-automation`) {
      assert.equal(request.method(), "POST"); assert.ok(admin && manage); assert.deepEqual(request.postDataJSON(), { revision: template.revision });
      writes.push({ path: url.pathname }); template.approved_by = user.id; template.approved_at = "2026-11-06T12:00:00Z";
      return route.fulfill({ json: { id: template.id, revision: template.revision, approved: true } });
    }
    assert.ok(!url.pathname.startsWith("/api/"), `Unexpected API ${url.pathname}`);
    return route.continue();
  });
  const page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  page.on("dialog", dialog => dialog.accept());
  await page.goto(`${app}/email-communications`);
  await page.getByRole("tab", { name: "Notifications", exact: true }).click();
  const panel = page.getByRole("region", { name: "Requirement notification rules" });
  await panel.getByText("Fixture Non-Expiring", { exact: true }).waitFor();
  assert.equal(await panel.getByRole("button", { name: /Configure Certificate/ }).count(), 0);
  await panel.getByRole("button", { name: "Configure Fixture Non-Expiring" }).click();
  let editor = panel.getByRole("form", { name: "Requirement rule editor" });
  await editor.getByText("No expiration intervals or expiration notice automation apply.").waitFor();
  assert.equal(await editor.getByRole("option", { name: "Expiration Based" }).isDisabled(), true);
  assert.equal(await editor.getByRole("button", { name: "Add interval" }).count(), 0);
  await editor.getByRole("button", { name: "Cancel" }).click();
  await panel.getByText("Review template revision 1").click();
  await panel.getByText("Review this exact body").waitFor();
  await panel.getByRole("button", { name: "Approve Fixture reminder revision 1" }).click();
  await panel.getByText(/Approved 2026-11-06/).waitFor();
  await panel.getByRole("button", { name: "Configure Fixture Expiring" }).click();
  editor = panel.getByRole("form", { name: "Requirement rule editor" });
  await editor.getByRole("button", { name: "Add interval" }).click();
  await editor.getByLabel("Days before expiration").fill("47");
  await editor.getByLabel("Enabled", { exact: true }).check();
  await editor.getByLabel("Approved template").selectOption(template.id);
  await editor.getByLabel("Automatic Notices Enabled").check();
  await editor.getByRole("button", { name: "Save rule" }).click();
  await panel.getByText(/Configuration ready \(not executing; master controls apply\)/).waitFor();
  assert.equal(writes.length, 2);
  assert.equal(writes[1].input.intervals[0].days_before_expiration, 47);
  template.revision = 2; template.approved_by = null; template.approved_at = null; rules[0].configuration_ready = false;
  await page.reload(); await page.getByRole("tab", { name: "Notifications", exact: true }).click();
  await panel.getByText(/Not ready: requirement or template approval changed/).waitFor();
  admin = false;
  await page.reload(); await page.getByRole("tab", { name: "Notifications", exact: true }).click();
  await panel.getByText("Fixture Non-Expiring", { exact: true }).waitFor();
  assert.equal(await panel.getByRole("button", { name: /Approve Fixture reminder/ }).count(), 0, "Settings manager alone cannot approve.");
  manage = false;
  await page.reload(); await page.getByRole("tab", { name: "Notifications", exact: true }).click();
  await panel.getByText("Fixture Non-Expiring", { exact: true }).waitFor();
  assert.equal(await panel.getByRole("button", { name: /Configure/ }).count(), 0, "View-only cannot edit.");
  assert.equal(writes.length, 2);
  assert.deepEqual(errors, []);
  await context.close();
  console.log("PASS: requirement configuration UI, retired/non-expiring behavior, template review/administrator approval, configurable interval, stale revision Not Ready, permission boundaries and no send.");
} finally { await browser.close(); }
