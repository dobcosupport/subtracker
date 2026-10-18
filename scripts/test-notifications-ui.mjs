import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const appUrl = process.env.TEST_APP_URL;
assert.ok(appUrl && new URL(appUrl).hostname === "localhost", "Use an intercepted localhost preview only");
const env = fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const origin = new URL(env.match(/^NEXT_PUBLIC_SUPABASE_URL\s*=\s*["']?([^"'\r\n]+)/m)[1].trim()).origin;
const storageKey = `sb-${new URL(origin).hostname.split(".")[0]}-auth-token`;
const uuid = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const user = { id: uuid(1), email: "synthetic@example.invalid", aud: "authenticated", app_metadata: {}, user_metadata: {} };
let canManage = true, canView = true, failLoad = false, failSave = false, nextId = 10;
let automation = { email: { automated_enabled: false, revision: 1 }, sms: { automated_enabled: false, revision: 1 } };
let rules = [90, 60, 30].map((days, index) => ({
  id: uuid(index + 2), days_before_expiration: days, email_enabled: false, sms_enabled: false, template_reference: null,
  revision: 1, created_at: "2026-10-18T12:00:00Z", updated_at: "2026-10-18T12:00:00Z",
}));
const errors = [], writes = [];
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
try {
  await context.addInitScript(({ storageKey, user }) => localStorage.setItem(storageKey, JSON.stringify({
    access_token: "synthetic-token", refresh_token: "synthetic-refresh", token_type: "bearer",
    expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user,
  })), { storageKey, user });
  await context.route("**/*", async (route) => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== new URL(appUrl).origin) {
      assert.equal(url.origin, origin, "No ACS, Twilio or unexpected external requests");
      assert.ok(["GET", "HEAD"].includes(request.method()), "No live mutations or invitations");
      assert.ok(url.pathname.startsWith("/auth/"), "No direct browser database access");
      return route.fulfill({ json: user });
    }
    if (url.pathname === "/api/admin/bootstrap") return route.fulfill({ json: {} });
    if (url.pathname === "/api/admin/communication-templates") {
      assert.equal(request.method(), "GET");
      return route.fulfill({ json: { templates: [
        { id: uuid(90), name: "Portable Reminder Email", channel: "email", is_active: true },
        { id: uuid(91), name: "Portable Reminder SMS", channel: "sms", is_active: true },
      ], next_offset: null } });
    }
    if (url.pathname === "/api/auth/session") return route.fulfill({ json: {
      profile: { auth_user_id: user.id, name: "Synthetic Actor", email: user.email, role: "Synthetic", status: "Active", system_administrator: false },
      permissions: [{ module: "settings", can_view: canView, can_manage: canManage, can_add: false, can_edit: false, can_delete: false }],
    } });
    if (url.pathname.startsWith("/api/admin/notifications")) {
      assert.ok(canView);
      if (request.method() === "GET") {
        assert.equal(url.pathname, "/api/admin/notifications");
        return route.fulfill({ status: failLoad ? 503 : 200, json: failLoad ? { error: "Synthetic migration unavailable" } : { automation, rules, execution_enabled: false } });
      }
      assert.ok(canManage, "View-only users never mutate Notifications");
      const input = request.postDataJSON();
      assert.ok(!Object.keys(input).some((key) => /active|secret|credential|recipient|provider/.test(key)), "No Active toggle or sensitive/execution fields");
      if (failSave) return route.fulfill({ status: 409, json: { error: "Synthetic configuration changed; reload" } });
      if (url.pathname === "/api/admin/notifications") {
        assert.equal(request.method(), "PATCH");
        automation = Object.fromEntries(["email", "sms"].map((channel) => [channel, { ...input[channel], revision: input[channel].revision + 1 }]));
      } else {
        const id = url.pathname.split("/")[5];
        if (request.method() === "DELETE") {
          assert.ok(rules.some((rule) => rule.id === id));
          rules = rules.filter((rule) => rule.id !== id);
        } else {
          assert.ok(["POST", "PATCH"].includes(request.method()));
          const conflict = rules.some((rule) => rule.id !== id && rule.days_before_expiration === input.days_before_expiration && (rule.email_enabled || rule.sms_enabled) && (input.email_enabled || input.sms_enabled));
          if (conflict) return route.fulfill({ status: 400, json: { error: "An active reminder already uses this expiration offset." } });
          const saved = { ...input, id: id ?? uuid(nextId++), revision: (input.revision ?? 0) + 1, created_at: "2026-10-18T12:00:00Z", updated_at: "2026-10-18T13:00:00Z" };
          rules = [...rules.filter((rule) => rule.id !== id), saved].sort((a, b) => b.days_before_expiration - a.days_before_expiration);
        }
      }
      writes.push({ url: url.pathname, method: request.method(), input });
      return route.fulfill({ json: { saved: true } });
    }
    assert.ok(!url.pathname.startsWith("/api/"), `No message/queue/invitation or unrelated API calls: ${url.pathname}`);
    assert.ok(["GET", "HEAD"].includes(request.method()));
    return route.continue();
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  const open = async () => {
    await page.goto(`${appUrl}/settings`);
    await page.getByRole("tab", { name: "Notifications", exact: true }).click();
  };
  const panel = page.getByRole("region", { name: "Notification configuration", exact: true });
  const list = panel.getByRole("list", { name: "Reminder list", exact: true });
  const row = (days) => list.getByRole("listitem").filter({ hasText: `${days} Days Before Expiration` });
  const dialog = page.getByRole("dialog");
  const saveRule = async () => {
    await dialog.getByRole("button", { name: "Save Reminder", exact: true }).click();
    await panel.getByText("Reminder configuration saved. No messages were generated.", { exact: true }).waitFor();
  };
  await open();
  await list.waitFor();
  assert.equal(await list.getByRole("listitem").count(), 3);
  for (const days of [90, 60, 30]) await row(days).getByText("Inactive", { exact: true }).waitFor();
  assert.equal(await panel.getByRole("checkbox", { name: /Active/ }).count(), 0);
  for (const name of ["Automated Email", "Automated SMS"]) assert.equal(await panel.getByLabel(name, { exact: true }).isChecked(), false);
  await row(90).getByRole("button", { name: "Edit", exact: true }).click();
  await dialog.getByLabel("Email", { exact: true }).check();
  await dialog.getByText("Status: Active (derived from channels)", { exact: true }).waitFor();
  await saveRule();
  await row(90).getByText("Active", { exact: true }).waitFor();
  await row(90).getByText("Email: blocked by master OFF", { exact: true }).waitFor();
  await open();
  await row(90).getByText("Active", { exact: true }).waitFor();
  assert.equal(await panel.getByLabel("Automated Email", { exact: true }).isChecked(), false);
  await row(90).getByRole("button", { name: "Edit", exact: true }).click();
  await dialog.getByLabel("Email", { exact: true }).uncheck();
  await dialog.getByLabel("SMS", { exact: true }).check();
  await dialog.getByLabel("Days Before Expiration", { exact: true }).fill("75");
  await dialog.getByLabel("Template Reference (optional)", { exact: true }).fill("portable/expiration-reminder");
  await dialog.getByLabel("Email Template", { exact: true }).selectOption(uuid(90));
  await dialog.getByLabel("SMS Template", { exact: true }).selectOption(uuid(91));
  await saveRule();
  assert.equal(await row(90).count(), 0);
  await row(75).getByText("SMS: blocked by master OFF", { exact: true }).waitFor();
  await row(75).getByRole("button", { name: "Edit", exact: true }).click();
  assert.equal(await dialog.getByLabel("Template Reference (optional)", { exact: true }).inputValue(), "portable/expiration-reminder");
  assert.equal(await dialog.getByLabel("Email Template", { exact: true }).inputValue(), uuid(90));
  assert.equal(await dialog.getByLabel("SMS Template", { exact: true }).inputValue(), uuid(91));
  await dialog.getByLabel("SMS", { exact: true }).uncheck();
  await saveRule();
  await row(75).getByText("Inactive", { exact: true }).waitFor();
  await panel.getByRole("button", { name: "Add Reminder", exact: true }).click();
  assert.equal(await dialog.getByLabel("Days Before Expiration", { exact: true }).inputValue(), "");
  assert.equal(await dialog.getByLabel("Email", { exact: true }).isChecked(), false);
  await dialog.getByLabel("Days Before Expiration", { exact: true }).fill("15");
  await saveRule();
  await row(15).getByText("Inactive", { exact: true }).waitFor();
  await row(60).getByRole("button", { name: "Edit", exact: true }).click();
  await dialog.getByLabel("SMS", { exact: true }).check();
  await saveRule();
  await panel.getByRole("button", { name: "Add Reminder", exact: true }).click();
  await dialog.getByLabel("Days Before Expiration", { exact: true }).fill("60");
  await dialog.getByLabel("Email", { exact: true }).check();
  await dialog.getByRole("button", { name: "Save Reminder", exact: true }).click();
  await panel.getByText("An active reminder already uses this expiration offset.", { exact: false }).waitFor();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await panel.getByLabel("Automated Email", { exact: true }).check();
  await panel.getByRole("button", { name: "Save Automation Controls", exact: true }).click();
  await panel.getByText("Master automation configuration saved.", { exact: false }).waitFor();
  await open(); await list.waitFor();
  assert.equal(await panel.getByLabel("Automated Email", { exact: true }).isChecked(), true);
  assert.equal(await panel.getByLabel("Automated SMS", { exact: true }).isChecked(), false);
  await row(60).getByText("SMS: blocked by master OFF", { exact: true }).waitFor();
  await panel.getByLabel("Automated Email", { exact: true }).uncheck();
  await panel.getByLabel("Automated SMS", { exact: true }).check();
  await panel.getByRole("button", { name: "Save Automation Controls", exact: true }).click();
  await panel.getByText("Master automation configuration saved.", { exact: false }).waitFor();
  await open(); await list.waitFor();
  assert.equal(await panel.getByLabel("Automated Email", { exact: true }).isChecked(), false);
  assert.equal(await panel.getByLabel("Automated SMS", { exact: true }).isChecked(), true);
  await row(60).getByText("SMS: configured; connector unavailable", { exact: true }).waitFor();
  await panel.getByLabel("Automated SMS", { exact: true }).uncheck();
  await panel.getByRole("button", { name: "Save Automation Controls", exact: true }).click();
  await panel.getByText("Master automation configuration saved.", { exact: false }).waitFor();
  await row(15).getByRole("button", { name: "Edit", exact: true }).click();
  await dialog.getByRole("button", { name: "Remove Reminder", exact: true }).click();
  await dialog.getByRole("button", { name: "Keep Reminder", exact: true }).click();
  assert.equal(rules.length, 4);
  await dialog.getByRole("button", { name: "Remove Reminder", exact: true }).click();
  await dialog.getByRole("button", { name: "Confirm Remove", exact: true }).click();
  await panel.getByText("Reminder configuration removed. No history was changed.", { exact: true }).waitFor();
  assert.equal(await row(15).count(), 0);
  failSave = true;
  await row(75).getByRole("button", { name: "Edit", exact: true }).click();
  await dialog.getByLabel("Days Before Expiration", { exact: true }).fill("77");
  await dialog.getByRole("button", { name: "Save Reminder", exact: true }).click();
  await panel.getByText("Synthetic configuration changed; reload", { exact: false }).waitFor();
  assert.equal(await dialog.getByLabel("Days Before Expiration", { exact: true }).inputValue(), "77");
  failSave = false;
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  canManage = false;
  await open(); await list.waitFor();
  assert.equal(await panel.getByRole("button", { name: "Edit", exact: true }).count(), 0);
  assert.equal(await panel.getByRole("button", { name: "Add Reminder", exact: true }).count(), 0);
  assert.equal(await panel.getByLabel("Automated Email", { exact: true }).isDisabled(), true);
  failLoad = true;
  await open();
  await panel.getByText("Synthetic migration unavailable", { exact: false }).waitFor();
  assert.equal(await panel.getByRole("button", { name: "Add Reminder", exact: true }).count(), 0);
  failLoad = false;
  await panel.getByRole("button", { name: "Reload Configuration", exact: true }).click();
  await list.waitFor();
  canView = false;
  await page.goto(`${appUrl}/settings`);
  await page.getByRole("heading", { name: "Access Denied", exact: true }).waitFor();
  assert.ok(writes.some((write) => write.method === "DELETE"));
  assert.ok(!automation.email.automated_enabled && !automation.sms.automated_enabled);
  assert.deepEqual(errors, []);
  console.log("PASS: inactive seed rows, derived Email/SMS activation/deactivation, compact add/edit/remove, custom intervals/reference persistence, independent master OFF/ON persistence/gating, duplicate/save/load errors, permissions and no sending/draft/queue/provider calls.");
} finally { await context.close(); await browser.close(); }
