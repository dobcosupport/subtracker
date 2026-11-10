import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "../worker/nj-pwc/node_modules/playwright");
const app = process.env.TEST_APP_URL;
assert.ok(app && new URL(app).hostname === "localhost", "Use an intercepted localhost preview");
const origin = new URL(fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8")
  .match(/^NEXT_PUBLIC_SUPABASE_URL\s*=\s*["']?([^"'\r\n]+)/m)[1].trim()).origin;
const uuid = n => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const user = { id: uuid(1), email: "fixture@example.invalid", aud: "authenticated", app_metadata: {}, user_metadata: {} };
const contacts = [
  { id: uuid(10), contact_name: "Internal Eligible", type: "dobco_contact", contractor_id: null, email: "fixture@example.invalid",
    mobile_phone: "+15555550101", is_active: true, receives_email: true, receives_sms: true, sms_consent_recorded: true },
  { id: uuid(11), contact_name: "Internal No Consent", type: "dobco_contact", contractor_id: null, email: "other@example.invalid",
    mobile_phone: "+15555550102", is_active: true, receives_email: true, receives_sms: true, sms_consent_recorded: false },
];
let add = true, summary = false;
const drafts = [], errors = [];
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  await context.addInitScript(({ origin, user }) => localStorage.setItem(`sb-${new URL(origin).hostname.split(".")[0]}-auth-token`,
    JSON.stringify({ access_token: "synthetic-token", refresh_token: "synthetic-refresh", token_type: "bearer",
      expires_at: Math.floor(Date.now() / 1000) + 3600, user })), { origin, user });
  await context.route("**/*", async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin !== new URL(app).origin) {
      assert.equal(url.origin, origin);
      assert.ok(url.pathname.startsWith("/auth/") && ["GET", "HEAD"].includes(req.method()), "No real database or provider requests");
      return route.fulfill({ json: user });
    }
    if (url.pathname === "/api/admin/bootstrap") return route.fulfill({ json: {} });
    if (url.pathname === "/api/auth/session") return route.fulfill({ json: {
      profile: { auth_user_id: user.id, name: "Synthetic", role: "Fixture", status: "Active", system_administrator: false },
      permissions: [
        { module: "communications_content", can_add: add, can_edit: true, can_view: false, can_manage: false },
        { module: "communications_summary", can_view: summary },
        { module: "settings", can_view: true }, { module: "projects", can_view: true }, { module: "contractors", can_view: true },
      ],
    } });
    if (url.pathname === "/api/communications/compose-options") {
      const kind = url.searchParams.get("kind") ?? "configuration";
      if (kind === "configuration") return route.fulfill({ json: {
        email_controls: { available: true, enabled: true, contractor_email_enabled: true, internal_email_enabled: true },
        installation: { organization_name: "Portable Org", application_name: "SubTracker" },
        channels: [{ channel: "email", manual_send_ready: false }, { channel: "sms", provider: "twilio", manual_send_ready: false }],
      } });
      return route.fulfill({ json: { rows: kind === "internal" ? contacts : [], next_offset: null } });
    }
    if (url.pathname === "/api/communications" && req.method() === "GET") return route.fulfill({ json: {
      messages: drafts.map(d => ({ ...d, direction: "outbound", source: "manual", status: "Draft",
        created_at: "2026-11-10T12:00:00Z", recipient_count: d.recipients.length, description: "Manual sms communication", contractors: [], projects: [] })),
      next_offset: null,
    } });
    if (url.pathname === "/api/communications" && req.method() === "POST") {
      const input = req.postDataJSON();
      assert.equal(input.channel, "sms"); assert.equal(input.subject, null);
      const draft = { ...input, id: uuid(100 + drafts.length), revision: 1 };
      drafts.push(draft);
      return route.fulfill({ status: 201, json: { id: draft.id, status: "Draft", revision: 1 } });
    }
    const draftMatch = url.pathname.match(/^\/api\/communications\/([^/]+)\/draft$/);
    if (draftMatch) {
      const draft = drafts.find(d => d.id === draftMatch[1]); assert.ok(draft);
      return route.fulfill({ json: { draft: { ...draft, related_contractors: [], related_projects: [], provider: "twilio" } } });
    }
    const edit = url.pathname.match(/^\/api\/communications\/([^/]+)$/);
    if (edit && req.method() === "PATCH") {
      const draft = drafts.find(d => d.id === edit[1]); assert.ok(draft);
      assert.equal(req.postDataJSON().revision, draft.revision);
      Object.assign(draft, req.postDataJSON(), { revision: draft.revision + 1 });
      return route.fulfill({ json: { id: draft.id, status: "Draft", revision: draft.revision } });
    }
    assert.ok(!url.pathname.startsWith("/api/"), `Unexpected API ${req.method()} ${url.pathname}`);
    return route.continue();
  });
  const page = await context.newPage(); page.on("pageerror", e => errors.push(e.message));
  await page.goto(`${app}/admin/audit?tab=communications`);
  await page.getByRole("button", { name: "New Message", exact: true }).click();
  await page.getByRole("region", { name: "Email composer", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Preview Drafts", exact: true }).count(), 0, "Generic history opens the same new Email composer");
  await page.getByRole("button", { name: "Text Messaging", exact: true }).click();
  const compose = page.getByRole("region", { name: "Communications compose", exact: true });
  await compose.getByRole("button", { name: "Preview Drafts", exact: true }).waitFor();
  assert.equal(await compose.getByRole("heading", { name: "Email Message", exact: true }).count(), 0);
  const sms = compose.getByRole("region", { name: "sms recipients", exact: true });
  await sms.getByRole("button", { name: "Select All Eligible Dobco Contacts", exact: true }).click();
  assert.equal(await sms.getByLabel("Internal Eligible", { exact: false }).isChecked(), true);
  assert.equal(await sms.getByLabel("Internal No Consent", { exact: false }).isDisabled(), true);
  await compose.getByLabel("SMS Body", { exact: true }).fill("Hello {{contact_name}}\n{{organization_name}}");
  await compose.getByRole("button", { name: "Preview Drafts", exact: true }).click();
  assert.equal(await compose.getByLabel("Exact Final Message", { exact: true }).inputValue(), "Hello Internal Eligible\nPortable Org");
  await compose.getByRole("button", { name: "Save Draft", exact: true }).click();
  await compose.getByRole("button", { name: "Draft Saved", exact: true }).waitFor();
  assert.equal(drafts.length, 1); assert.equal(drafts[0].channel, "sms");
  assert.equal(await compose.getByRole("button", { name: "SMS Sending Unavailable", exact: true }).isDisabled(), true);
  const original = structuredClone(drafts[0].recipients);
  contacts[0].contact_name = "Changed current name";
  add = false; summary = true;
  await page.goto(`${app}/admin/audit?tab=communications`);
  await page.getByRole("button", { name: "Edit Draft", exact: true }).click();
  await compose.getByText("Saved recipient snapshots:", { exact: false }).waitFor();
  assert.match(await compose.innerText(), /Internal Eligible/); assert.doesNotMatch(await compose.innerText(), /Changed current name/);
  await compose.getByLabel("SMS Body", { exact: true }).fill("Exact updated SMS draft");
  await compose.getByRole("button", { name: "Preview Drafts", exact: true }).click();
  await compose.getByRole("button", { name: "Save Draft", exact: true }).click();
  await compose.getByRole("button", { name: "Draft Saved", exact: true }).waitFor();
  assert.deepEqual(drafts[0].recipients, original);
  assert.equal(drafts[0].body, "Exact updated SMS draft");
  assert.deepEqual(errors, []);
  console.log("PASS: Generic history reuses unified Email composer; independent Text Messaging retains SMS consent, individual selection, merge rendering, optional Draft editing and frozen snapshots; SMS delivery remains disabled. No real network mutations.");
} finally { await browser.close(); }
