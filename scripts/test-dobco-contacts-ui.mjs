import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appUrl = process.env.TEST_APP_URL;
assert.ok(appUrl && new URL(appUrl).hostname === "localhost", "Use only a localhost preview with intercepted synthetic data");
const env = fs.readFileSync(path.join(root, ".env.local"), "utf8");
const origin = new URL(env.match(/^NEXT_PUBLIC_SUPABASE_URL\s*=\s*["']?([^"'\r\n]+)/m)[1].trim()).origin;
const storageKey = `sb-${new URL(origin).hostname.split(".")[0]}-auth-token`;
const user = { id: "00000000-0000-0000-0000-000000000001", email: "synthetic@example.invalid", aud: "authenticated", app_metadata: {}, user_metadata: {} };
const optionalUser = { auth_user_id: "00000000-0000-0000-0000-000000000002", name: "Synthetic linked user", email: "linked@example.invalid" };
const contacts = [];
let canManage = true, canViewUsers = true, failLoad = false, failSave = false, optionReads = 0, mutations = 0;
const errors = [];
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
try {
  await context.addInitScript(({ storageKey, user }) => localStorage.setItem(storageKey, JSON.stringify({
    access_token: "synthetic-token", refresh_token: "synthetic-refresh", token_type: "bearer",
    expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user,
  })), { storageKey, user });
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== new URL(appUrl).origin) {
      assert.equal(url.origin, origin, "Block unexpected external requests");
      assert.ok(["GET", "HEAD"].includes(request.method()), "Block all external mutations");
      assert.ok(url.pathname.startsWith("/auth/"), "No database requests are permitted from the client");
      return route.fulfill({ json: user });
    }
    if (url.pathname === "/api/admin/bootstrap") return route.fulfill({ json: {} });
    if (url.pathname === "/api/auth/session") return route.fulfill({ json: {
      profile: { auth_user_id: user.id, name: "Synthetic actor", email: user.email, role: "Synthetic", status: "Active", system_administrator: false },
      permissions: [
        { module: "settings", can_view: true, can_manage: canManage },
        { module: "users", can_view: canViewUsers, can_manage: false },
      ],
    } });
    if (url.pathname === "/api/admin/dobco-contacts/user-options") {
      optionReads++;
      return route.fulfill({ status: canManage && canViewUsers ? 200 : 403, json: canManage && canViewUsers ? { users: [optionalUser] } : { error: "Synthetic permission denied" } });
    }
    if (url.pathname.startsWith("/api/admin/dobco-contacts")) {
      if (request.method() === "GET") return route.fulfill({ status: failLoad ? 500 : 200, json: failLoad ? { error: "Synthetic missing migration" } : { contacts } });
      assert.ok(["POST", "PATCH"].includes(request.method()), "No delete operations");
      if (!canManage || failSave) return route.fulfill({ status: canManage ? 500 : 403, json: { error: "Synthetic save denied" } });
      const body = request.postDataJSON();
      assert.equal(Object.hasOwn(body, "id"), false);
      const id = request.method() === "POST" ? "00000000-0000-0000-0000-000000000010" : url.pathname.split("/").at(-1);
      const saved = { ...body, id, created_at: "2026-10-17T12:00:00Z", updated_at: "2026-10-17T12:00:00Z" };
      const index = contacts.findIndex((contact) => contact.id === id);
      if (index < 0) contacts.push(saved); else contacts[index] = saved;
      mutations++;
      return route.fulfill({ status: request.method() === "POST" ? 201 : 200, json: { contact: saved } });
    }
    assert.ok(!url.pathname.startsWith("/api/"), `Unexpected API request: ${url.pathname}`);
    assert.ok(["GET", "HEAD"].includes(request.method()), "Block unrelated app mutations");
    return route.continue();
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  const load = async () => {
    await page.goto(`${appUrl}/settings`);
    await page.getByRole("tab", { name: "DOBCO CONTACTS", exact: true }).click();
    await page.getByText("Loading Dobco contacts...", { exact: true }).waitFor({ state: "hidden" });
  };
  const dialog = page.getByRole("dialog");
  await load();
  await page.getByText("No Dobco contacts have been added.", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Add Dobco Contact", exact: true }).click();
  await dialog.getByLabel("Contact Name", { exact: true }).fill("Synthetic non-user contact");
  await dialog.getByLabel("Email", { exact: true }).fill("contact@example.invalid");
  await dialog.getByLabel("Mobile Phone", { exact: true }).fill("555 0100");
  assert.equal(await dialog.getByLabel("SMS Consent Recorded", { exact: true }).isChecked(), false);
  assert.equal(await dialog.getByLabel("Receive Internal SMS Alerts", { exact: true }).isChecked(), false);
  assert.equal(await dialog.getByLabel("SMS Consent Date", { exact: true }).inputValue(), "");
  assert.equal(await dialog.getByLabel("SMS Consent Source / Note", { exact: true }).inputValue(), "");
  await dialog.getByRole("option", { name: `${optionalUser.name} (${optionalUser.email})`, exact: true }).waitFor({ state: "attached" });
  assert.equal(await dialog.getByLabel("SubTracker User (optional)", { exact: true }).inputValue(), "");
  await dialog.getByRole("button", { name: "Save Contact", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.equal(contacts[0].user_profile_id, null, "Contact is created without any application account");
  const panel = page.getByRole("tabpanel");
  const row = panel.locator("details").first().locator("..");
  assert.equal((await row.innerText()).replace(/\s+/g, " ").trim(), "Synthetic non-user contact Edit");
  const layout = await row.evaluate((element) => ({
    nameTop: element.querySelector("summary").getBoundingClientRect().top,
    editTop: element.querySelector("button").getBoundingClientRect().top,
    editFont: getComputedStyle(element.querySelector("button")).fontSize,
  }));
  assert.equal(layout.nameTop, layout.editTop, "Name/Edit stay on one compact row");
  assert.equal(layout.editFont, "12px");
  await row.locator("summary").click();
  assert.ok((await row.locator("details").innerText()).includes("contact@example.invalid"));
  await row.getByRole("button", { name: "Edit", exact: true }).click();
  assert.equal(await dialog.getByLabel("Mobile Phone", { exact: true }).inputValue(), "555 0100");
  for (const label of ["Receive Internal Email Alerts", "Receive Internal SMS Alerts", "SMS Consent Recorded"]) await dialog.getByLabel(label, { exact: true }).check();
  await dialog.getByLabel("SMS Consent Date", { exact: true }).fill("2026-10-17");
  await dialog.getByLabel("SMS Consent Source / Note", { exact: true }).fill("Synthetic recorded consent");
  await dialog.getByLabel("SubTracker User (optional)", { exact: true }).selectOption(optionalUser.auth_user_id);
  await dialog.getByLabel("Active", { exact: true }).uncheck();
  await dialog.getByText("Future email eligible: No. Future SMS eligible: No. Delivery is not configured.", { exact: true }).waitFor();
  await dialog.getByRole("button", { name: "Save Contact", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.equal(contacts.length, 1);
  assert.equal(contacts[0].is_active, false);
  await load();
  assert.ok(await page.getByText("Synthetic non-user contact", { exact: true }).isVisible(), "Inactive contact remains available after reload");
  await panel.getByRole("button", { name: "Edit", exact: true }).click();
  assert.equal(await dialog.getByLabel("SMS Consent Source / Note", { exact: true }).inputValue(), "Synthetic recorded consent");
  assert.equal(await dialog.getByLabel("SMS Consent Date", { exact: true }).inputValue(), "2026-10-17");
  assert.equal(await dialog.getByLabel("Active", { exact: true }).isChecked(), false);
  await dialog.getByLabel("Active", { exact: true }).check();
  await dialog.getByText("Future email eligible: Yes. Future SMS eligible: Yes. Delivery is not configured.", { exact: true }).waitFor();
  failSave = true;
  await dialog.getByRole("button", { name: "Save Contact", exact: true }).click();
  await dialog.getByRole("alert").getByText("Synthetic save denied", { exact: true }).waitFor();
  assert.equal(await dialog.getByLabel("Contact Name", { exact: true }).inputValue(), "Synthetic non-user contact");
  failSave = false;
  await dialog.getByRole("button", { name: "Save Contact", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.equal(contacts[0].is_active, true);
  assert.equal(contacts[0].sms_consent_recorded, true);
  const savedBeforeStatus = { ...contacts[0] };
  await panel.getByRole("button", { name: "Edit", exact: true }).click();
  const actions = dialog.locator('button[type="submit"]').locator("..");
  assert.deepEqual(await actions.locator("button").allTextContents(), ["Save Contact", "Deactivate", "Cancel"]);
  const actionSizes = await actions.locator("button").evaluateAll((buttons) => buttons.map((button) => {
    const style = getComputedStyle(button);
    return { font: style.fontSize, height: button.getBoundingClientRect().height, padding: style.padding };
  }));
  assert.ok(actionSizes.every((size) => size.font === "12px" && size.height === 20 && size.padding === "2px 8px"));
  await dialog.getByLabel("Email", { exact: true }).fill("unsaved@example.invalid");
  failSave = true;
  await dialog.getByRole("button", { name: "Deactivate", exact: true }).click();
  await dialog.getByRole("alert").getByText("Synthetic save denied", { exact: true }).waitFor();
  assert.deepEqual(contacts[0], savedBeforeStatus, "Failed status update preserves the saved contact");
  failSave = false;
  await dialog.getByRole("button", { name: "Deactivate", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.deepEqual(contacts[0], { ...savedBeforeStatus, is_active: false }, "Deactivation changes only saved Active status, not unsaved form fields");
  await load();
  assert.equal(contacts.length, 1, "Deactivation does not delete the contact");
  await panel.getByRole("button", { name: "Edit", exact: true }).click();
  assert.deepEqual(await dialog.locator('button[type="submit"]').locator("..").locator("button").allTextContents(), ["Save Contact", "Activate", "Cancel"]);
  await dialog.getByText("Future email eligible: No. Future SMS eligible: No. Delivery is not configured.", { exact: true }).waitFor();
  await dialog.getByLabel("Receive Internal SMS Alerts", { exact: true }).uncheck();
  await dialog.getByRole("button", { name: "Activate", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.deepEqual(contacts[0], savedBeforeStatus, "Activation restores only status, preserving every saved field");
  canManage = false;
  await load();
  assert.equal(await panel.getByRole("button", { name: "Edit", exact: true }).count(), 0);
  assert.equal(await panel.getByRole("button", { name: "Add Dobco Contact", exact: true }).count(), 0);
  await panel.locator("summary").first().click();
  assert.ok(await panel.getByText("contact@example.invalid", { exact: true }).isVisible());
  canManage = true;
  canViewUsers = false;
  await load();
  const reads = optionReads;
  await panel.getByRole("button", { name: "Edit", exact: true }).click();
  assert.equal(await dialog.getByLabel("SubTracker User (optional)", { exact: true }).isDisabled(), true);
  assert.equal(optionReads, reads, "No user lookup without User Management permission");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  failLoad = true;
  await load();
  await panel.getByRole("alert").getByText("Synthetic missing migration", { exact: true }).waitFor();
  assert.equal(await panel.getByRole("button", { name: "Add Dobco Contact", exact: true }).isDisabled(), true);
  await page.getByRole("tab", { name: "Email", exact: true }).click();
  await panel.getByText("NOT CONFIGURED", { exact: true }).waitFor();
  assert.equal(await panel.getByRole("button", { name: "Send Test Email", exact: true }).isDisabled(), true);
  assert.equal(mutations, 5, "Only five synthetic create/edit/status operations");
  assert.deepEqual(errors, []);
  console.log("PASS: isolated UI add without login, compact Name/Edit, basic details, complete form, consent defaults, status persistence, optional link, view-only gates, save/load errors, and unchanged ACS placeholders. All API/auth calls intercepted; no live writes.");
} finally {
  await context.close();
  await browser.close();
}
