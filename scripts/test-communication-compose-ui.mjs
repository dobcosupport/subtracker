import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const appUrl = process.env.TEST_APP_URL;
assert.ok(appUrl && new URL(appUrl).hostname === "localhost", "Use an intercepted localhost preview");
const env = fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const origin = new URL(env.match(/^NEXT_PUBLIC_SUPABASE_URL\s*=\s*["']?([^"'\r\n]+)/m)[1].trim()).origin;
const storageKey = `sb-${new URL(origin).hostname.split(".")[0]}-auth-token`;
const uuid = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const user = { id: uuid(1), email: "synthetic@example.invalid", aud: "authenticated", app_metadata: {}, user_metadata: {} };
const contractors = [{ id: 1, company_name: "Portable One" }, { id: 2, company_name: "Portable Two" }];
const projects = [{ id: 1, project_number: "10001", project_name: "Portable Project" }];
const contact = (n, name, type = "dobco_contact", contractor_id = null, changes = {}) => ({
  id: uuid(n), contact_name: name, type, contractor_id, email: `${n}@example.invalid`, mobile_phone: `+1555555${String(n).padStart(4, "0")}`,
  is_active: true, receives_email: true, receives_sms: true, sms_consent_recorded: true, ...changes,
});
const contacts = [
  contact(10, "Internal Eligible"), contact(11, "Internal Inactive", "dobco_contact", null, { is_active: false }),
  contact(12, "Internal No Consent", "dobco_contact", null, { sms_consent_recorded: false }),
  contact(13, "Internal No Email", "dobco_contact", null, { email: null }),
  contact(20, "Contractor First", "contractor_contact", 1), contact(21, "Contractor Second", "contractor_contact", 1),
  contact(22, "Contractor Other", "contractor_contact", 2),
];
const template = { id: uuid(60), name: "Portable Personalized", channel: "email", category: "Expiration Reminder", subject: "{{contractor_name}}",
  body: "Hello {{contact_name}}\n{{project_name}}\n{{expiration_date}}", is_active: true, revision: 1 };
let templates = [template], drafts = [], grants = [], savedCount = 0, failSave = false, manualEmailReady = false;
const sentIds = new Set(), sends = [], errors = [], writes = [];
const emailSettings = { channel: "email", provider: "microsoft_365", enabled: true, automated_enabled: false,
  from_name: "Portable Sender", from_address: "sender@example.invalid", manual_send_ready: false };
const allow = (...permissions) => { grants = permissions; };
const has = (module, action) => grants.includes(`${module}:${action}`);
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
try {
  await context.addInitScript(({ storageKey, user }) => localStorage.setItem(storageKey, JSON.stringify({
    access_token: "synthetic-token", refresh_token: "synthetic-refresh", token_type: "bearer", expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600, user,
  })), { storageKey, user });
  await context.route("**/*", async (route) => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== new URL(appUrl).origin) {
      assert.equal(url.origin, origin, "No Azure, Twilio or other external request");
      assert.ok(["GET", "HEAD"].includes(request.method()), `No external mutations: ${request.method()} ${url.href}`);
      assert.ok(url.pathname.startsWith("/auth/"), "No browser database access");
      return route.fulfill({ json: user });
    }
    if (url.pathname === "/api/admin/bootstrap") return route.fulfill({ json: {} });
    if (url.pathname === "/api/auth/session") return route.fulfill({ json: {
      profile: { auth_user_id: user.id, name: "Synthetic", email: user.email, role: "Synthetic", status: "Active", system_administrator: false },
      permissions: [...new Set(grants.map((p) => p.split(":")[0]))].map((module) => Object.assign({ module },
        ...["view", "add", "edit", "delete", "manage"].map((action) => ({ [`can_${action}`]: has(module, action) })))),
    } });
    if (url.pathname === "/api/communications/compose-options") {
      assert.ok(has("communications_content", "add") || has("communications_content", "edit"));
      assert.equal(request.method(), "GET");
      const kind = url.searchParams.get("kind") ?? "configuration";
      if (kind === "configuration") return route.fulfill({ json: { installation: { organization_name: "Portable Org", application_name: "Portable App" }, channels: [
        { ...emailSettings, manual_send_ready: manualEmailReady },
        { channel: "sms", provider: "twilio", sending_phone_number: "+15555550000", manual_send_ready: false },
      ] } });
      const rows = kind === "templates" ? templates.filter((t) => t.is_active)
        : kind === "contractors" ? contractors : kind === "projects" ? projects
          : kind === "internal" ? contacts.filter((c) => c.type === "dobco_contact")
            : kind === "contacts" ? contacts.filter((c) => c.contractor_id === Number(url.searchParams.get("contractor_id")))
              : kind === "compliance" ? [] : assert.fail(`Unknown source ${kind}`);
      return route.fulfill({ json: { rows, next_offset: null } });
    }
    if (url.pathname === "/api/communications" && request.method() === "GET") {
      assert.ok(has("communications_summary", "view"));
      return route.fulfill({ json: { messages: drafts.map((d) => ({ ...d, direction: "outbound", source: "manual", status: sentIds.has(d.id) ? "Sent" : "Draft", created_at: "2026-10-18T12:00:00Z",
        recipient_count: d.recipients.length, description: "Manual Draft", contractors: [], projects: [] })), next_offset: null } });
    }
    if (/^\/api\/communications\/[^/]+\/send$/.test(url.pathname)) {
      assert.equal(request.method(), "POST");
      assert.ok(has("communications_delivery", "manage"));
      assert.deepEqual(request.postDataJSON(), { confirmed: true });
      const id = url.pathname.split("/")[3];
      const draft = drafts.find((item) => item.id === id);
      assert.ok(draft && draft.channel === "email" && !sentIds.has(id), "Only an unsent Email Draft can be sent");
      if (!manualEmailReady || !emailSettings.enabled || emailSettings.provider !== "microsoft_365") {
        return route.fulfill({ status: 409, json: { error: "Microsoft 365 authentication and test Email are required." } });
      }
      assert.equal(emailSettings.automated_enabled, false, "Manual send does not depend on Automated Email");
      sends.push({ id, sender: emailSettings.from_address, recipients: structuredClone(draft.recipients), body: draft.body });
      sentIds.add(id);
      return route.fulfill({ json: { communication_id: id, status: "Sent", graph_acceptance: "Accepted", delivered: false } });
    }
    if (/^\/api\/communications\/[^/]+\/draft$/.test(url.pathname)) {
      assert.ok(has("communications_content", "edit"));
      const draft = drafts.find((d) => d.id === url.pathname.split("/")[3]);
      return route.fulfill({ status: draft ? 200 : 404, json: draft ? { draft: { ...draft, provider: "microsoft_365", sender_address: emailSettings.from_address,
        related_contractors: contractors.filter((c) => draft.contractor_ids.includes(c.id)), related_projects: projects.filter((p) => draft.project_ids.includes(p.id)) } } : { error: "Editable manual Draft not found." } });
    }
    if (url.pathname === "/api/communications" && request.method() === "POST" || /^\/api\/communications\/[^/]+$/.test(url.pathname) && request.method() === "PATCH") {
      assert.ok(has("communications_content", request.method() === "POST" ? "add" : "edit"));
      const input = request.postDataJSON();
      assert.equal(Object.hasOwn(input, "status"), false);
      writes.push(input);
      if (failSave) return route.fulfill({ status: 409, json: { error: "Synthetic stale Draft; reload before saving." } });
      const id = request.method() === "POST" ? uuid(100 + savedCount++) : url.pathname.split("/").at(-1);
      const draft = { ...input, id, revision: (input.revision ?? 0) + 1,
        provider: input.channel === "email" ? emailSettings.provider : "twilio",
        sender_address: input.channel === "email" ? emailSettings.from_address : null };
      drafts = [...drafts.filter((d) => d.id !== id), draft];
      return route.fulfill({ status: request.method() === "POST" ? 201 : 200, json: { id, revision: draft.revision, status: "Draft" } });
    }
    if (url.pathname.startsWith("/api/admin/communication-templates")) {
      if (request.method() === "GET") {
        assert.ok(has("settings", "view"));
        return route.fulfill({ json: { templates, next_offset: null } });
      }
      assert.ok(has("settings", "manage"));
      const input = request.postDataJSON();
      const id = request.method() === "POST" ? uuid(80) : url.pathname.split("/").at(-1);
      templates = [...templates.filter((t) => t.id !== id), { ...input, id, revision: (input.revision ?? 0) + 1 }];
      return route.fulfill({ json: { id, revision: (input.revision ?? 0) + 1 } });
    }
    assert.ok(!url.pathname.startsWith("/api/"), `No provider, vault, queue, invitation, notification or unrelated API: ${url.pathname}`);
    assert.ok(["GET", "HEAD"].includes(request.method()));
    return route.continue();
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  const compose = page.getByRole("region", { name: "Communications compose", exact: true });
  const openNew = async () => {
    await page.goto(`${appUrl}/admin/audit?tab=communications`);
    await page.getByRole("button", { name: "New Message", exact: true }).click();
    await compose.getByRole("button", { name: "Preview Drafts", exact: true }).waitFor();
  };
  allow("communications_content:add", "communications_delivery:manage", "contractors:view", "settings:view", "projects:view", "compliance:view");
  await openNew();
  assert.equal(await page.getByRole("heading", { name: "History", exact: true }).count(), 0, "Add does not grant Summary");
  await compose.getByRole("button", { name: "Search Contractors", exact: true }).click();
  await compose.getByRole("button", { name: "Select Portable One", exact: true }).click();
  await compose.getByText("Contractor First", { exact: false }).first().waitFor();
  await compose.getByRole("button", { name: "Select Portable Two", exact: true }).click();
  const email = compose.getByRole("region", { name: "email recipients", exact: true });
  await email.getByLabel("Contractor First", { exact: false }).check();
  await email.getByLabel("Contractor Second", { exact: false }).check();
  await email.getByLabel("Contractor Other", { exact: false }).check();
  await email.getByRole("button", { name: "Select All Eligible Dobco Contacts", exact: true }).click();
  assert.equal(await email.getByLabel("Internal Eligible", { exact: false }).isChecked(), true);
  assert.equal(await email.getByLabel("Internal No Consent", { exact: false }).isChecked(), true, "Consent is SMS-only");
  assert.equal(await email.getByLabel("Internal Inactive", { exact: false }).isDisabled(), true);
  assert.equal(await email.getByLabel("Internal No Email", { exact: false }).isDisabled(), true);
  await compose.getByRole("checkbox", { name: "SMS", exact: true }).check();
  const sms = compose.getByRole("region", { name: "sms recipients", exact: true });
  await sms.getByRole("button", { name: "Select All Eligible Dobco Contacts", exact: true }).click();
  assert.equal(await sms.getByLabel("Internal No Consent", { exact: false }).isDisabled(), true);
  assert.equal(await sms.getByLabel("Internal No Email", { exact: false }).isChecked(), true);
  await compose.getByRole("button", { name: "Search Projects", exact: true }).click();
  await compose.getByRole("button", { name: "Select 10001 - Portable Project", exact: true }).click();
  await compose.getByRole("region", { name: "email editor", exact: true }).getByLabel("Template", { exact: true }).selectOption(template.id);
  await compose.getByLabel("SMS Body", { exact: true }).fill("Internal SMS\n{{organization_name}}");
  await compose.getByRole("button", { name: "Preview Drafts", exact: true }).click();
  const preview = compose.getByRole("region", { name: "Draft preview", exact: true });
  const articles = preview.getByRole("article");
  assert.equal(await articles.count(), 7, "Five Email plus two eligible SMS Drafts");
  assert.equal(await articles.first().getByLabel("Exact Final Message", { exact: true }).inputValue(), "Hello Internal Eligible\nPortable Project\n{{expiration_date}}");
  await preview.getByText("Unresolved fields:", { exact: false }).first().waitFor();
  const firstContractor = articles.filter({ hasText: "To: Contractor First" });
  assert.equal(await firstContractor.getByLabel("Final Subject", { exact: true }).inputValue(), "Portable One");
  assert.equal(await firstContractor.getByRole("button", { name: "Send Email", exact: true }).isDisabled(), true,
    "Email cannot send before authentication and administrator test delivery are complete");
  await firstContractor.getByLabel("Exact Final Message", { exact: true }).fill("Exact edited final\nmessage");
  await firstContractor.getByRole("button", { name: "Save Draft", exact: true }).click();
  await firstContractor.getByText("Draft (not sent)", { exact: false }).waitFor();
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].body, "Exact edited final\nmessage");
  assert.deepEqual(drafts[0].contractor_ids, [1, 2]);
  assert.equal(drafts[0].recipients[0].recipient_name, "Contractor First");
  const frozen = structuredClone(drafts[0].recipients);
  contacts.find((c) => c.id === uuid(20)).contact_name = "Changed Contact Name";
  contacts.find((c) => c.id === uuid(20)).email = "changed@example.invalid";
  assert.deepEqual(drafts[0].recipients, frozen);
  const smsArticle = articles.filter({ hasText: "Channel: sms" }).first();
  assert.equal(await smsArticle.getByLabel("Final Subject", { exact: true }).count(), 0);
  assert.equal(await smsArticle.getByLabel("Exact Final Message", { exact: true }).inputValue(), "Internal SMS\nPortable Org");
  await smsArticle.getByRole("button", { name: "Save Draft", exact: true }).click();
  await smsArticle.getByText("Draft (not sent)", { exact: false }).waitFor();
  assert.equal(drafts[1].channel, "sms"); assert.equal(drafts[1].subject, null);
  for (const send of await preview.getByRole("button", { name: "SMS Sending Unavailable", exact: true }).all()) assert.equal(await send.isDisabled(), true);
  await compose.getByRole("button", { name: "Close Composer", exact: true }).click();
  allow("communications_summary:view", "communications_content:edit");
  await page.goto(`${appUrl}/admin/audit?tab=communications`);
  await page.getByRole("heading", { name: "History", exact: true }).waitFor();
  await page.getByRole("button", { name: "Edit Draft", exact: true }).first().waitFor();
  assert.equal(await page.getByRole("button", { name: "Edit Draft", exact: true }).count(), 2);
  assert.equal(await page.getByRole("cell", { name: "Draft", exact: true }).count(), 2, "Saved Communications are Draft, never Sent/Delivered");
  assert.equal(await page.getByRole("button", { name: "Content", exact: true }).count(), 0);
  allow("communications_content:edit", "contractors:view", "projects:view");
  await page.goto(`${appUrl}/admin/audit?tab=communications`);
  assert.equal(await page.getByRole("button", { name: "New Message", exact: true }).count(), 0);
  await page.getByLabel("Draft ID to Edit", { exact: true }).fill(drafts[0].id);
  await page.getByRole("button", { name: "Open Draft Editor", exact: true }).click();
  await compose.getByText("Saved recipient snapshots:", { exact: false }).waitFor();
  assert.ok((await compose.innerText()).includes("Contractor First"));
  assert.equal((await compose.innerText()).includes("Changed Contact Name"), false, "Edit does not refresh contacts");
  await compose.getByLabel("Email Body", { exact: true }).fill("Edit without Content View");
  await compose.getByRole("button", { name: "Preview Drafts", exact: true }).click();
  await compose.getByRole("button", { name: "Save Draft", exact: true }).click();
  await compose.getByText("Draft (not sent)", { exact: false }).waitFor();
  assert.deepEqual(drafts.find((d) => d.channel === "email").recipients, frozen);
  assert.equal(drafts.find((d) => d.channel === "email").revision, 2);
  allow("communications_content:edit", "settings:view", "contractors:view");
  await page.goto(`${appUrl}/admin/audit?tab=communications`);
  const editId = drafts.find((d) => d.channel === "email").id;
  await page.getByLabel("Draft ID to Edit", { exact: true }).fill(editId);
  await page.getByRole("button", { name: "Open Draft Editor", exact: true }).click();
  await compose.getByText("Saved recipient snapshots:", { exact: false }).waitFor();
  await compose.getByLabel("Deliberately reselect/refresh", { exact: false }).check();
  await compose.getByRole("region", { name: "email recipients", exact: true }).getByLabel("Changed Contact Name", { exact: false }).check();
  await compose.getByRole("button", { name: "Preview Drafts", exact: true }).click();
  failSave = true;
  await compose.getByRole("button", { name: "Save Draft", exact: true }).click();
  await compose.getByText("Synthetic stale Draft;", { exact: false }).waitFor();
  assert.equal(await compose.getByRole("button", { name: "Save Draft", exact: true }).isDisabled(), true, "No uncertain automatic duplicate retry");
  failSave = false;
  allow("settings:view", "settings:manage");
  await page.goto(`${appUrl}/settings`);
  await page.getByRole("tab", { name: "Templates", exact: true }).click();
  const panel = page.getByRole("region", { name: "Communication templates", exact: true });
  await panel.getByRole("button", { name: "Add Template", exact: true }).click();
  await panel.getByLabel("Template Name", { exact: true }).fill("Portable Internal SMS");
  await panel.getByLabel("Channel", { exact: true }).selectOption("sms");
  await panel.getByLabel("Category", { exact: true }).selectOption("Internal Alert");
  await panel.getByLabel("Template Body", { exact: true }).fill("Portable wording {{organization_name}}");
  await panel.getByRole("checkbox", { name: "Active", exact: true }).check();
  await panel.getByRole("button", { name: "Save Template", exact: true }).click();
  await panel.getByText("Template saved.", { exact: false }).waitFor();
  const item = panel.getByRole("listitem").filter({ hasText: "Portable Internal SMS" });
  await item.getByRole("button", { name: "Edit", exact: true }).click();
  await panel.getByRole("checkbox", { name: "Active", exact: true }).uncheck();
  await panel.getByRole("button", { name: "Save Template", exact: true }).click();
  await panel.getByText("Template saved.", { exact: false }).waitFor();
  assert.equal(templates.find((t) => t.name === "Portable Internal SMS").is_active, false);
  assert.equal(await panel.getByRole("button", { name: /Delete/ }).count(), 0);
  allow("settings:view");
  await page.reload();
  await page.getByRole("tab", { name: "Templates", exact: true }).click();
  assert.equal(await panel.getByRole("button", { name: "Add Template", exact: true }).count(), 0);
  assert.equal(await panel.getByRole("button", { name: "Edit", exact: true }).count(), 0);
  manualEmailReady = true;
  allow("communications_content:edit", "communications_delivery:manage", "contractors:view", "settings:view");
  await page.goto(`${appUrl}/admin/audit?tab=communications`);
  const emailDraftId = drafts.find((draft) => draft.channel === "email").id;
  await page.getByLabel("Draft ID to Edit", { exact: true }).fill(emailDraftId);
  await page.getByRole("button", { name: "Open Draft Editor", exact: true }).click();
  await compose.getByText("Saved recipient snapshots:", { exact: false }).waitFor();
  await compose.getByRole("button", { name: "Preview Drafts", exact: true }).click();
  const sendPreview = compose.getByRole("region", { name: "Draft preview", exact: true });
  const sendDraft = sendPreview.getByRole("article", { name: "Draft 1", exact: true });
  await sendDraft.getByRole("button", { name: "Save Draft", exact: true }).click();
  await sendDraft.getByRole("button", { name: "Send Email", exact: true }).waitFor();
  assert.equal(await sendDraft.getByRole("button", { name: "Send Email", exact: true }).isEnabled(), true);
  assert.equal(sends.length, 0, "Saved Compose Draft remains unsent until explicit confirmation");
  await sendDraft.getByRole("button", { name: "Send Email", exact: true }).click();
  assert.equal(await sendDraft.getByRole("button", { name: "Send Email Now", exact: true }).isDisabled(), true);
  await sendDraft.getByLabel("I reviewed the final message and confirm this deliberate Email send.", { exact: true }).check();
  await sendDraft.getByRole("button", { name: "Send Email Now", exact: true }).click();
  await sendDraft.getByText("Sent / Accepted for processing by Microsoft Graph. Recipient delivery is not confirmed.", { exact: true }).waitFor();
  assert.equal(sends.length, 1);
  assert.equal(sends[0].sender, emailSettings.from_address);
  assert.deepEqual(sends[0].recipients, frozen, "Graph recipients use the saved authoritative recipient snapshots");
  assert.equal(sends[0].body, drafts.find((draft) => draft.id === emailDraftId).body);
  assert.equal(sentIds.has(emailDraftId), true, "The authoritative Communications history is updated to Sent");
  assert.equal(emailSettings.automated_enabled, false);
  assert.deepEqual(errors, []);
  assert.equal(writes.length, 5, "Only deliberate Draft create/edit attempts");
  console.log("PASS: Compose/Templates preserve draft snapshots; manual Email remains blocked until ready, then requires deliberate confirmation, uses configured sender and saved recipient snapshots, logs Sent without claiming delivery, and sends no automated Email or SMS.");
} finally { await context.close(); await browser.close(); }
