import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const appUrl = process.env.TEST_APP_URL;
assert.ok(appUrl && new URL(appUrl).hostname === "localhost", "Use only an intercepted localhost preview");
const env = fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const origin = new URL(env.match(/^NEXT_PUBLIC_SUPABASE_URL\s*=\s*["']?([^"'\r\n]+)/m)[1].trim()).origin;
const storageKey = `sb-${new URL(origin).hostname.split(".")[0]}-auth-token`;
const id = "00000000-0000-0000-0000-000000000001";
const user = { id, email: "synthetic@example.invalid", aud: "authenticated", app_metadata: {}, user_metadata: {} };
const channels = Object.fromEntries(["email", "sms"].map((channel) => [channel, { channel, provider: null, enabled: false, automated_enabled: false, from_name: null, from_address: null, reply_to_address: null, sending_domain: null, sending_phone_number: null, incoming_enabled: false, two_way_enabled: false, revision: 1, credential_configured: false, configuration_status: "Not Configured" }]));
let invitationConfig = {
  enabled: true, delivery_mode: "supabase_auth", organization_name: null, application_name: null,
  subject: null, application_base_url: null, invitation_path: null, template_reference: null,
  template_content: null, sender_reference: null, reply_to_reference: null, revision: 1,
};
let invitationWrites = 0, failInvitation = false;
let vaultAvailable = false, credentialWrites = 0;
const credentialStates = { email: false, sms: false, microsoft_365: false };
const summary = { id, channel: "email", direction: "outbound", source: "manual", status: "Draft", created_at: "2026-10-18T12:00:00Z", recipient_count: 2, description: "Manual email communication", contractors: [], projects: [] };
let grants = [], settingWrites = 0, contentReads = 0, deliveryReads = 0, summaryReads = 0, auditReads = 0, failSettings = false, roleSaved = null;
const queries = [], errors = [];
const allow = (...values) => { grants = values; };
const permitted = (entry, action) => grants.includes(`${entry}:${action}`);
const roles = ["dashboard", "contractors", "compliance", "insurance", "followups", "projects", "tiered_subs", "reports", "imports", "documents", "activity", "users", "roles", "audit", "settings", "compliance_sync", "communications_summary", "communications_content", "communications_delivery"];
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
try {
  await context.addInitScript(({ storageKey, user }) => localStorage.setItem(storageKey, JSON.stringify({
    access_token: "synthetic-token", refresh_token: "synthetic-refresh", token_type: "bearer",
    expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user,
  })), { storageKey, user });
  await context.route("**/*", async (route) => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== new URL(appUrl).origin) {
      assert.equal(url.origin, origin, "Unexpected external request blocked");
      assert.ok(["GET", "HEAD"].includes(request.method()), "No external mutations");
      assert.ok(url.pathname.startsWith("/auth/"), "No direct browser database access");
      return route.fulfill({ json: user });
    }
    if (url.pathname === "/api/admin/bootstrap") return route.fulfill({ json: {} });
    if (url.pathname === "/api/auth/session") return route.fulfill({ json: {
      profile: { auth_user_id: id, name: "Synthetic actor", email: user.email, role: "Synthetic", status: "Active", system_administrator: false },
      permissions: roles.map((entry) => Object.assign({ role: "Synthetic", module: entry }, ...["view", "add", "edit", "delete", "manage"].map((action) => ({ [`can_${action}`]: permitted(entry, action) })))),
    } });
    if (url.pathname === "/api/admin/audit") {
      assert.ok(permitted("audit", "view"), "Communication permissions must not load Audit Logs");
      assert.equal(request.method(), "GET");
      auditReads++;
      return route.fulfill({ json: { entries: [
        { id: 1, user_name: "Synthetic Administrator", user_email: "admin@example.invalid", audit_date: "2026-10-18T12:00:00Z", action: "ROLE_UPDATED", object_type: "role", object_label: "Synthetic role", object_id: "1", details: { changed_fields: ["can_view"] } },
        { id: 2, user_name: "Synthetic Operator", user_email: "operator@example.invalid", audit_date: "2026-10-18T11:00:00Z", action: "USER_UPDATED", object_type: "user", object_label: "Synthetic account", object_id: "2", details: {} },
      ] } });
    }
    if (url.pathname.startsWith("/api/admin/communication-settings/")) {
      if (url.pathname.endsWith("/credential")) {
        const channel = url.pathname.split("/").at(-2);
        const provider = url.searchParams.get("provider") ?? "azure_communication_services";
        assert.ok(provider === "azure_communication_services" || channel === "email" && provider === "microsoft_365");
        const credentialKey = provider === "microsoft_365" ? provider : channel;
        if (!vaultAvailable) {
          assert.equal(request.method(), "GET", "Infrastructure unavailable: no credential writes");
          return route.fulfill({ status: 503, json: { error: "Credential storage is unavailable. An administrator must verify Azure Key Vault configuration and access." } });
        }
        if (request.method() === "PUT") {
          assert.ok(permitted("settings", "manage"));
          assert.deepEqual(Object.keys(request.postDataJSON()), ["credential"]);
          assert.ok(provider === "microsoft_365" ? request.postDataJSON().credential.startsWith("synthetic-microsoft-") : request.postDataJSON().credential.startsWith("endpoint=https://synthetic."));
          credentialWrites++; credentialStates[credentialKey] = true;
        } else assert.equal(request.method(), "GET");
        return route.fulfill({ json: { credential_configured: credentialStates[credentialKey] } });
      }
      const channel = url.pathname.split("/").at(-1);
      if (request.method() === "GET") return route.fulfill({ json: { settings: channels[channel] } });
      assert.equal(request.method(), "PATCH");
      assert.ok(permitted("settings", "manage"), "No unauthorized UI save");
      if (failSettings) return route.fulfill({ status: 500, json: { error: "Synthetic configuration failure" } });
      const input = request.postDataJSON();
      assert.ok(!Object.keys(input).some((key) => /secret|credential|token/i.test(key)));
      channels[channel] = { ...channels[channel], ...input, revision: input.revision + 1, credential_configured: false, configuration_status: "Configuration Incomplete" };
      settingWrites++;
      return route.fulfill({ json: { saved: true, revision: channels[channel].revision } });
    }
    if (url.pathname === "/api/admin/invitation-email-settings") {
      if (request.method() === "GET") {
        assert.ok(permitted("settings", "view"));
        return route.fulfill({ json: { settings: invitationConfig } });
      }
      assert.equal(request.method(), "PATCH");
      assert.ok(permitted("settings", "manage"));
      if (failInvitation) return route.fulfill({ status: 409, json: { error: "Synthetic invitation settings conflict" } });
      const input = request.postDataJSON();
      assert.ok(!Object.keys(input).some((key) => /secret|credential|token/.test(key)));
      invitationConfig = { ...input, revision: input.revision + 1 };
      invitationWrites++;
      return route.fulfill({ json: { saved: true, revision: invitationConfig.revision } });
    }
    if (url.pathname === "/api/communications") {
      assert.equal(request.method(), "GET", "UI must not compose/send messages");
      assert.ok(permitted("communications_summary", "view"));
      summaryReads++; queries.push(Object.fromEntries(url.searchParams));
      return route.fulfill({ json: { messages: ["channel", "source", "status"].every((key) => !url.searchParams.get(key) || url.searchParams.get(key) === summary[key]) ? [summary] : [], next_offset: null } });
    }
    if (url.pathname === `/api/communications/${id}`) {
      assert.equal(request.method(), "GET");
      assert.ok(permitted("communications_content", "view"));
      contentReads++;
      return route.fulfill({ json: { communication: { id, subject: "Synthetic subject", body: "Exact synthetic full body", sender_name: "Synthetic", sender_address: "sender@example.invalid", status: "Draft", communication_recipients: [{ recipient_name: "Snapshot", email: "snapshot@example.invalid", mobile_phone: null }] } } });
    }
    if (url.pathname === `/api/communications/${id}/delivery`) {
      assert.equal(request.method(), "GET");
      assert.ok(permitted("communications_delivery", "view"));
      deliveryReads++;
      return route.fulfill({ json: { delivery: { id, status: "Draft", provider: null, provider_message_id: null, failure_reason: null, queued_at: null, sent_at: null, delivered_at: null, failed_at: null, cancelled_at: null, communication_recipients: [] } } });
    }
    if (url.pathname === "/api/admin/roles") {
      if (request.method() === "PATCH") { roleSaved = request.postDataJSON(); return route.fulfill({ json: { permissions: roleSaved.permissions } }); }
      return route.fulfill({ json: { roles: [{ role: "Synthetic", is_system: false }], permissions: roles.map((entry) => ({ role: "Synthetic", module: entry, can_view: false, can_manage: false, can_add: false, can_edit: false, can_delete: false })) } });
    }
    assert.ok(!url.pathname.startsWith("/api/"), `Unexpected app API: ${url.pathname}`);
    assert.ok(["GET", "HEAD"].includes(request.method()), "No unrelated app mutations");
    return route.continue();
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  allow("settings:view", "settings:manage");
  const tab = async (name) => {
    await page.goto(`${appUrl}/settings`);
    await page.getByRole("tab", { name, exact: true }).click();
    await page.getByLabel("Provider", { exact: true }).waitFor();
  };
  await tab("Email");
  await page.getByRole("heading", { name: "User Management Email", exact: true }).waitFor();
  const invitation = page.getByRole("region", { name: "User Management Email", exact: true });
  await invitation.getByLabel("Invitation Delivery Mode", { exact: true }).selectOption("supabase_auth");
  await invitation.getByText("Supabase Auth controls current sender/from", { exact: false }).waitFor();
  await invitation.getByLabel("Invitation Delivery Mode", { exact: true }).selectOption("application_email_provider");
  await invitation.getByText("Connector Not Implemented.", { exact: false }).waitFor();
  await invitation.getByLabel("Invitation Email Enabled", { exact: true }).uncheck();
  const portableInvitation = {
    "Organization Name": "Portable Organization", "Application Name": "Portable Application",
    "Invitation Subject": "A portable invitation", "Application Base URL": "https://portable.example.invalid",
    "Invitation Path": "/account-invitation", "Invitation Template Reference": "installation/invitation-v1",
    "Invitation Sender Reference": "email-channel.sender", "Invitation Reply-To Reference": "email-channel.reply_to",
    "Invitation Template Draft": "Welcome {{invitee_name}}\n{{organization_name}} {{application_name}}\n{{invitation_url}}",
  };
  for (const [label, value] of Object.entries(portableInvitation)) await invitation.getByLabel(label, { exact: true }).fill(value);
  await invitation.getByRole("button", { name: "Save Invitation Configuration", exact: true }).click();
  await invitation.getByRole("status").waitFor();
  await tab("Email");
  for (const [label, value] of Object.entries(portableInvitation)) assert.equal(await invitation.getByLabel(label, { exact: true }).inputValue(), value);
  assert.equal(await invitation.getByLabel("Invitation Delivery Mode", { exact: true }).inputValue(), "application_email_provider");
  assert.equal(await invitation.getByLabel("Invitation Email Enabled", { exact: true }).isChecked(), false);
  assert.equal(invitationWrites, 1);
  await invitation.getByText("active Send Invitation and Re-Invite actions still use Supabase Auth", { exact: false }).waitFor();
  failInvitation = true;
  await invitation.getByLabel("Organization Name", { exact: true }).fill("Unsaved organization");
  await invitation.getByRole("button", { name: "Save Invitation Configuration", exact: true }).click();
  await invitation.getByText("Synthetic invitation settings conflict", { exact: true }).waitFor();
  assert.equal(await invitation.getByLabel("Organization Name", { exact: true }).inputValue(), "Unsaved organization");
  failInvitation = false;
  await tab("Email");
  assert.equal(await page.getByLabel("Provider", { exact: true }).locator('option[value="twilio"]').count(), 0);
  assert.equal(await page.getByRole("heading", { name: "Sender", exact: true }).count(), 0, "No provider-specific area before provider selection");
  await page.getByLabel("Provider", { exact: true }).selectOption("azure_communication_services");
  for (const name of ["General", "Sender", "Connection"]) assert.equal(await page.getByRole("heading", { name, exact: true }).isVisible(), true);
  for (const name of ["Configure Connection", "Test Connection", "Send Test Email"]) assert.equal(await page.getByRole("button", { name, exact: true }).isDisabled(), true);
  await page.getByText("Credential Status: Unavailable", { exact: true }).waitFor();
  await page.getByLabel("From Name", { exact: true }).fill("Portable Installation");
  await page.getByLabel("From Address", { exact: true }).fill("portable@example.invalid");
  await page.getByLabel("Reply-To Address", { exact: true }).fill("reply@example.invalid");
  await page.getByLabel("Sending Domain", { exact: true }).fill("example.invalid");
  await page.getByLabel("Email Enabled", { exact: true }).check();
  await page.getByLabel("Automated Email Enabled", { exact: true }).check();
  await page.getByText("Unsaved Changes", { exact: true }).waitFor();
  assert.equal(await page.getByText("Configuration Status:", { exact: false }).innerText(), "Configuration Status: Incomplete", "Status uses saved, not unsaved configuration");
  await page.getByRole("button", { name: "Save Settings", exact: true }).click();
  await page.getByRole("status").waitFor();
  await page.getByText("Configuration Status: Credential Required", { exact: true }).waitFor();
  assert.equal(await page.getByText("Unsaved Changes", { exact: true }).count(), 0);
  await tab("Email");
  assert.equal(await page.getByLabel("From Address", { exact: true }).inputValue(), "portable@example.invalid");
  assert.equal(await page.getByLabel("From Name", { exact: true }).inputValue(), "Portable Installation");
  assert.equal(await page.getByLabel("Reply-To Address", { exact: true }).inputValue(), "reply@example.invalid");
  assert.equal(await page.getByLabel("Sending Domain", { exact: true }).inputValue(), "example.invalid");
  for (const name of ["Email Enabled", "Automated Email Enabled"]) assert.equal(await page.getByLabel(name, { exact: true }).isChecked(), true);
  await tab("Text Messaging");
  assert.equal(await page.getByLabel("Provider", { exact: true }).locator('option[value="twilio"]').count(), 1);
  assert.equal(await page.getByLabel("Sending Phone Number", { exact: true }).count(), 0);
  await page.getByLabel("Provider", { exact: true }).selectOption("azure_communication_services");
  for (const name of ["General", "Sender", "Messaging", "Connection"]) assert.equal(await page.getByRole("heading", { name, exact: true }).isVisible(), true);
  for (const name of ["Configure Connection", "Test Connection", "Send Test SMS"]) assert.equal(await page.getByRole("button", { name, exact: true }).isDisabled(), true);
  await page.getByLabel("Sending Phone Number", { exact: true }).fill("+15555550100");
  await page.getByLabel("SMS Enabled", { exact: true }).check();
  await page.getByLabel("Automated SMS Enabled", { exact: true }).check();
  await page.getByLabel("Incoming SMS Enabled", { exact: true }).check();
  await page.getByLabel("Two-Way SMS Enabled", { exact: true }).check();
  await page.getByRole("button", { name: "Save Settings", exact: true }).click();
  await page.getByRole("status").waitFor();
  assert.equal(settingWrites, 2);
  assert.equal(channels.email.from_address, "portable@example.invalid");
  assert.equal(channels.sms.sending_phone_number, "+15555550100");
  await tab("Text Messaging");
  assert.equal(await page.getByLabel("Sending Phone Number", { exact: true }).inputValue(), "+15555550100", "Saved provider restores its settings area");
  for (const name of ["SMS Enabled", "Automated SMS Enabled", "Incoming SMS Enabled", "Two-Way SMS Enabled"]) assert.equal(await page.getByLabel(name, { exact: true }).isChecked(), true);
  await page.getByLabel("Provider", { exact: true }).selectOption("twilio");
  await page.getByText("Provider: Twilio", { exact: true }).waitFor();
  await page.getByText("Connector Status: Not Implemented", { exact: true }).waitFor();
  assert.equal(await page.getByLabel(/Account SID|Auth Token/).count(), 0);
  for (const name of ["Replace Credential", "Test Connection", "Send Test SMS"]) assert.equal(await page.getByRole("button", { name, exact: true }).isDisabled(), true);
  await page.getByRole("button", { name: "Save Settings", exact: true }).click();
  await page.getByRole("status").waitFor();
  await tab("Text Messaging");
  assert.equal(await page.getByLabel("Provider", { exact: true }).inputValue(), "twilio");
  await page.getByText("Connector Status: Not Implemented", { exact: true }).waitFor();
  assert.equal(channels.sms.sending_phone_number, "+15555550100");
  await page.getByLabel("Provider", { exact: true }).selectOption("azure_communication_services");
  assert.equal(await page.getByLabel("Sending Phone Number", { exact: true }).inputValue(), "+15555550100");
  failSettings = true;
  await page.getByLabel("Sending Phone Number", { exact: true }).fill("+15555550199");
  await page.getByRole("button", { name: "Save Settings", exact: true }).click();
  await page.getByText("Synthetic configuration failure", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("Sending Phone Number", { exact: true }).inputValue(), "+15555550199", "Failure preserves unsaved form");
  failSettings = false;
  allow("settings:view");
  await tab("Email");
  assert.equal(await page.getByLabel("From Name", { exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole("button", { name: "Save Settings", exact: true }).count(), 0);
  assert.equal(await invitation.getByLabel("Organization Name", { exact: true }).isDisabled(), true);
  assert.equal(await invitation.getByRole("button", { name: "Save Invitation Configuration", exact: true }).count(), 0);
  vaultAvailable = true;
  allow("settings:view", "settings:manage");
  await tab("Email");
  await page.getByText("Credential Status: Not Configured", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Configure Connection", exact: true }).click();
  const syntheticCredential = "endpoint=https://synthetic.communication.azure.com/;accesskey=c3ludGhldGlj";
  await page.getByLabel("ACS Connection String", { exact: true }).fill(syntheticCredential);
  await page.getByRole("button", { name: "Save Connection", exact: true }).click();
  await page.getByText("Credential Status: Configured", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("ACS Connection String", { exact: true }).count(), 0);
  assert.equal((await page.locator("body").innerText()).includes(syntheticCredential), false);
  await page.getByRole("button", { name: "Replace Connection", exact: true }).click();
  assert.equal(await page.getByLabel("ACS Connection String", { exact: true }).inputValue(), "");
  await page.getByLabel("ACS Connection String", { exact: true }).fill(`${syntheticCredential}=`);
  await page.getByRole("button", { name: "Save Connection", exact: true }).click();
  await page.getByRole("button", { name: "Replace Connection", exact: true }).waitFor();
  for (const name of ["Test Connection", "Send Test Email"]) assert.equal(await page.getByRole("button", { name, exact: true }).isDisabled(), true, "Stored credential is not Verified");
  assert.equal(credentialWrites, 2);
  await tab("Email");
  await page.getByText("Credential Status: Configured", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("ACS Connection String", { exact: true }).count(), 0);
  allow("settings:view");
  await tab("Email");
  await page.getByRole("button", { name: "Replace Connection", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Replace Connection", exact: true }).isDisabled(), true);
  allow("settings:view", "settings:manage");
  vaultAvailable = false;
  await tab("Email");
  assert.equal(await page.getByLabel("Provider", { exact: true }).locator('option[value="microsoft_365"]').innerText(), "Microsoft 365 / Office 365");
  assert.equal(await page.getByLabel("Provider", { exact: true }).locator('option[value="azure_communication_services"]').count(), 1);
  await page.getByLabel("Provider", { exact: true }).selectOption("microsoft_365");
  await page.getByText("Unsaved Changes", { exact: true }).waitFor();
  await page.getByRole("heading", { name: "Microsoft 365 Connection", exact: true }).waitFor();
  await page.getByText("Credential Status: Unavailable", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("Sending Domain", { exact: true }).count(), 0, "No ACS-specific domain under Microsoft");
  assert.equal(await page.getByLabel("Sending Phone Number", { exact: true }).count(), 0);
  assert.equal(await page.getByLabel("ACS Connection String", { exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "Configure Connection", exact: true }).isDisabled(), true);
  await page.getByRole("button", { name: "Save Settings", exact: true }).click();
  await page.getByRole("status").waitFor();
  await page.getByText("Configuration Status: Incomplete", { exact: true }).waitFor();
  assert.equal(await page.getByText("Unsaved Changes", { exact: true }).count(), 0);
  await tab("Email");
  assert.equal(await page.getByLabel("Provider", { exact: true }).inputValue(), "microsoft_365", "Provider persists even with incomplete settings and unavailable Key Vault");
  await page.getByText("Credential Status: Unavailable", { exact: true }).waitFor();
  await page.getByLabel("Microsoft Entra Tenant ID", { exact: true }).fill("00000000-0000-0000-0000-000000000800");
  await page.getByLabel("Application / Client ID", { exact: true }).fill("00000000-0000-0000-0000-000000000801");
  await page.getByLabel("From Name", { exact: true }).fill("Portable Microsoft Organization");
  await page.getByLabel("From Email Address", { exact: true }).fill("mailbox@example.invalid");
  await page.getByLabel("Reply-To Address", { exact: true }).fill("microsoft-reply@example.invalid");
  await page.getByLabel("Automated Email Enabled", { exact: true }).uncheck();
  await page.getByRole("button", { name: "Save Settings", exact: true }).click();
  await page.getByRole("status").waitFor();
  assert.equal(await page.getByText("Unsaved Changes", { exact: true }).count(), 0);
  await page.getByText("Configuration Status: Credential Required", { exact: true }).waitFor();
  for (const name of ["Configure Connection", "Test Connection", "Send Test Email"]) assert.equal(await page.getByRole("button", { name, exact: true }).isDisabled(), true);
  await tab("Email");
  assert.equal(await page.getByLabel("Provider", { exact: true }).inputValue(), "microsoft_365");
  for (const [label, expected] of Object.entries({
    "Microsoft Entra Tenant ID": "00000000-0000-0000-0000-000000000800",
    "Application / Client ID": "00000000-0000-0000-0000-000000000801",
    "From Name": "Portable Microsoft Organization", "From Email Address": "mailbox@example.invalid", "Reply-To Address": "microsoft-reply@example.invalid",
  })) assert.equal(await page.getByLabel(label, { exact: true }).inputValue(), expected);
  assert.equal(await page.getByLabel("Automated Email Enabled", { exact: true }).isChecked(), false);
  vaultAvailable = true;
  await tab("Email");
  await page.getByText("Credential Status: Not Configured", { exact: true }).waitFor();
  await page.getByText("Configuration Status: Credential Required", { exact: true }).waitFor();
  await page.getByText("Connection Status: Not Verified", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Configure Connection", exact: true }).click();
  const microsoftCredential = "synthetic-microsoft-application-secret";
  await page.getByLabel("Microsoft 365 Client Secret", { exact: true }).fill(microsoftCredential);
  await page.getByRole("button", { name: "Save Connection", exact: true }).click();
  await page.getByText("Credential Status: Configured", { exact: true }).waitFor();
  await page.getByText("Configuration Status: Ready for Testing", { exact: true }).waitFor();
  await page.getByText("Connection Status: Not Verified", { exact: true }).waitFor();
  await page.getByLabel("From Email Address", { exact: true }).fill("unsaved@example.invalid");
  await page.getByText("Unsaved Changes", { exact: true }).waitFor();
  await page.getByText("Configuration Status: Ready for Testing", { exact: true }).waitFor();
  await page.getByLabel("From Email Address", { exact: true }).fill("mailbox@example.invalid");
  assert.equal(await page.getByText("Unsaved Changes", { exact: true }).count(), 0, "Reverting ordinary edits clears dirty state");
  assert.equal(await page.getByLabel("Microsoft 365 Client Secret", { exact: true }).count(), 0);
  assert.equal((await page.locator("body").innerText()).includes(microsoftCredential), false);
  await page.getByRole("button", { name: "Replace Connection", exact: true }).click();
  assert.equal(await page.getByLabel("Microsoft 365 Client Secret", { exact: true }).inputValue(), "");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  for (const name of ["Test Connection", "Send Test Email"]) assert.equal(await page.getByRole("button", { name, exact: true }).isDisabled(), true, "Readiness never enables live tests or sending");
  await page.getByLabel("Provider", { exact: true }).selectOption("azure_communication_services");
  assert.equal(await page.getByLabel("Microsoft Entra Tenant ID", { exact: true }).count(), 0);
  assert.equal(await page.getByLabel("Application / Client ID", { exact: true }).count(), 0);
  assert.equal(await page.getByLabel("Sending Domain", { exact: true }).inputValue(), "example.invalid");
  await page.getByRole("button", { name: "Save Settings", exact: true }).click();
  await page.getByRole("status").waitFor();
  await tab("Email");
  await page.getByText("Credential Status: Configured", { exact: true }).waitFor();
  await page.getByLabel("Provider", { exact: true }).selectOption("microsoft_365");
  assert.equal(await page.getByLabel("Microsoft Entra Tenant ID", { exact: true }).inputValue(), "00000000-0000-0000-0000-000000000800");
  await page.getByRole("button", { name: "Save Settings", exact: true }).click();
  await page.getByRole("status").waitFor();
  allow("settings:view");
  await tab("Email");
  assert.equal(await page.getByLabel("Microsoft Entra Tenant ID", { exact: true }).isDisabled(), true);
  await page.getByRole("button", { name: "Replace Connection", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Replace Connection", exact: true }).isDisabled(), true);
  await tab("Text Messaging");
  assert.equal(await page.getByLabel("Provider", { exact: true }).locator('option[value="microsoft_365"]').count(), 0, "Microsoft is not an SMS provider");
  assert.equal(await page.getByLabel("Provider", { exact: true }).locator('option[value="twilio"]').count(), 1);
  assert.equal(credentialWrites, 3);
  console.log("PASS: Microsoft 365 provider-specific Email configuration/persistence, no ACS-only fields, truthful unavailable/readiness status, separate write-once credential UI, disabled testing/sending, Settings View gates, unchanged SMS choices.");
  allow("communications_summary:view");
  await page.goto(`${appUrl}/communications`);
  await page.getByText("Summary only", { exact: true }).waitFor();
  assert.equal(new URL(page.url()).pathname, "/admin/audit", "Legacy history URL consolidates into Logs");
  assert.equal(await page.getByRole("heading", { name: "Logs", exact: true }).isVisible(), true);
  assert.equal(await page.getByRole("tab", { name: "Communication Logs", exact: true }).getAttribute("aria-selected"), "true");
  assert.equal(await page.getByRole("tab", { name: "Audit Logs", exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole("link", { name: "Communications", exact: true }).count(), 0);
  assert.equal(await page.getByRole("link", { name: /Logs/ }).count(), 1);
  assert.equal(auditReads, 0);
  assert.equal(await page.getByRole("button", { name: "New Message", exact: true }).count(), 0, "Summary View does not grant Draft creation");
  assert.equal(await page.getByRole("button", { name: "Content", exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "Delivery", exact: true }).count(), 0);
  assert.equal(contentReads + deliveryReads, 0);
  await page.getByLabel("channel", { exact: true }).selectOption("sms");
  await page.getByText("No communications match these filters.", { exact: true }).waitFor();
  await page.getByLabel("source", { exact: true }).selectOption("automated");
  await page.getByLabel("status", { exact: true }).selectOption("Failed");
  await page.waitForFunction(() => Array.from(document.querySelectorAll("select")).some((el) => el.value === "Failed"));
  allow("communications_content:view");
  const summariesBefore = summaryReads;
  await page.goto(`${appUrl}/communications`);
  await page.getByLabel("Communication ID", { exact: true }).fill(id);
  await page.getByRole("button", { name: "Open Content", exact: true }).click();
  await page.getByText("Exact synthetic full body", { exact: true }).waitFor();
  assert.equal(summaryReads, summariesBefore, "Content alone does not request Summary");
  assert.equal(await page.getByText("Snapshot: snapshot@example.invalid / -", { exact: true }).isVisible(), true);
  assert.equal(await page.getByRole("heading", { name: "Delivery Details", exact: true }).count(), 0);
  allow("communications_delivery:view");
  await page.goto(`${appUrl}/communications`);
  await page.getByLabel("Communication ID", { exact: true }).fill(id);
  await page.getByRole("button", { name: "Open Delivery", exact: true }).click();
  await page.getByRole("heading", { name: "Delivery Details", exact: true }).waitFor();
  assert.equal(await page.getByText("Exact synthetic full body", { exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "Open Content", exact: true }).count(), 0);
  allow("audit:view");
  const summariesBeforeAudit = summaryReads;
  await page.goto(`${appUrl}/admin/audit`);
  await page.getByText("Synthetic role", { exact: true }).waitFor();
  assert.equal(await page.getByRole("tab", { name: "Audit Logs", exact: true }).getAttribute("aria-selected"), "true");
  assert.equal(await page.getByRole("tab", { name: "Communication Logs", exact: true }).isDisabled(), true);
  await page.getByLabel("Search audit log", { exact: true }).fill("operator");
  assert.equal(await page.getByText("Synthetic role", { exact: true }).count(), 0);
  assert.equal(await page.getByText("Synthetic account", { exact: true }).isVisible(), true);
  await page.getByLabel("Search audit log", { exact: true }).fill("");
  await page.getByLabel("Filter by action", { exact: true }).selectOption("ROLE_UPDATED");
  assert.equal(await page.getByText("Synthetic role", { exact: true }).isVisible(), true);
  assert.equal(await page.getByText("Synthetic account", { exact: true }).count(), 0);
  assert.equal(summaryReads, summariesBeforeAudit, "Audit View alone does not load communications");
  allow("audit:view", "communications_summary:view");
  await page.goto(`${appUrl}/admin/audit`);
  await page.getByText("Synthetic role", { exact: true }).waitFor();
  await page.getByRole("tab", { name: "Communication Logs", exact: true }).click();
  await page.getByText("Summary only", { exact: true }).waitFor();
  await page.getByRole("tab", { name: "Audit Logs", exact: true }).click();
  await page.getByText("Synthetic role", { exact: true }).waitFor();
  allow("roles:view", "roles:manage");
  await page.goto(`${appUrl}/admin/roles`);
  await page.getByRole("checkbox", { name: "View Communications Summary", exact: true }).waitFor();
  for (const label of ["Communications Summary", "Communications Content", "Communications Delivery"]) assert.equal(await page.getByRole("rowheader", { name: label, exact: true }).count(), 1);
  await page.getByRole("checkbox", { name: "Add Communications Content", exact: true }).check();
  await page.getByRole("checkbox", { name: "Edit Communications Content", exact: true }).check();
  assert.equal(await page.getByRole("checkbox", { name: "View Communications Content", exact: true }).isChecked(), false);
  assert.equal(await page.getByRole("checkbox", { name: "Add Communications Summary", exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole("checkbox", { name: "Delete Communications Content", exact: true }).isDisabled(), true);
  await page.getByRole("button", { name: "Save Permissions", exact: true }).click();
  await page.getByText("Permissions saved for Synthetic.", { exact: true }).waitFor();
  const row = roleSaved.permissions.find((entry) => entry.module === "communications_content");
  assert.equal(row.can_view, false); assert.equal(row.can_add, true); assert.equal(row.can_edit, true);
  assert.equal(contentReads, 1); assert.equal(deliveryReads, 1);
  assert.ok(queries.some((q) => q.channel === "sms"));
  assert.deepEqual(errors, []);
  console.log("PASS: invitation configuration both modes, portable fields/template draft persistence, explicit configuration-only state, save conflicts and view-only gates. No invitation/provider API calls.");
  console.log("PASS: Logs tabs/navigation/legacy redirect, unchanged audit search/action filters, independent audit/summary/content/delivery access, provider-dependent grouped settings, persistence/errors/view-only, disabled connector controls and permission-grid actions. No live mutations or sending.");
} catch (error) {
  console.error(await context.pages()[0]?.locator("body").innerText());
  console.error(errors);
  throw error;
} finally {
  await context.close(); await browser.close();
}
