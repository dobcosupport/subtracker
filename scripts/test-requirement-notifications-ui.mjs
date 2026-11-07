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
    automatic_enabled: false, eligibility_authority: "current_requirement", schedule_type: "expiration", sender_contact_id: null, internal_contact_id: null, revision: 1, intervals: [] },
  { id: uuid(11), compliance_type_id: 2, insurance_item_key: null, name: "Fixture Non-Expiring", retired: false, expiration_allowed: false,
    automatic_enabled: false, eligibility_authority: "current_requirement", schedule_type: "non_expiring", sender_contact_id: null, internal_contact_id: null, revision: 1, intervals: [] },
  { id: uuid(12), compliance_type_id: null, insurance_item_key: "certificate_of_insurance", name: "Certificate of Insurance (Retired / Historical)", retired: true, expiration_allowed: true,
    automatic_enabled: false, eligibility_authority: "current_requirement", schedule_type: "expiration", sender_contact_id: null, internal_contact_id: null, revision: 1, intervals: [] },
];
const writes = [], errors = [], noticeCalls = [];
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
      permissions: [{ module: "settings", can_view: true, can_manage: manage }, { module: "contractors", can_view: true },
        { module: "communications_content", can_add: true, can_edit: true }, { module: "communications_delivery", can_view: true, can_manage: true }],
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
    if (url.pathname === "/api/communications/compose-options") {
      assert.equal(request.method(), "GET");
      if (url.searchParams.get("kind") === "contractors") return route.fulfill({ json: { rows: [{ id: 1, company_name: "Fixture Legal", dba_name: "Fixture DBA" }], next_offset: null } });
      if (url.searchParams.get("kind") === "contacts") return route.fulfill({ json: { rows: [{ id: uuid(30), contractor_id: 1, type: "contractor_contact",
        contact_name: "Fixture Contact", email: "fixture@example.invalid", is_active: true, receives_email: true }], next_offset: null } });
      assert.fail(`Unexpected selection ${url.search}`);
    }
    if (url.pathname === "/api/admin/notifications/requirements/preview") {
      assert.equal(request.method(), "POST");
      assert.deepEqual(request.postDataJSON(), { rule_id: uuid(10), contractor_id: 1, contact_id: uuid(30), project_id: null });
      return route.fulfill({ json: { execution_enabled: false, preview: { company_name: "Fixture Legal", dba_name: "Fixture DBA",
        contact_name: "Fixture Contact", contact_email: "fixture@example.invalid", requirement_name: "Fixture Expiring",
        expiration_date: "2027-01-30", days_remaining: 30, sender_name: "Fixture Sender", sender_address: "sender@example.invalid",
        template_revision: 1, subject: "Fixture subject", body: "Fixture personalized body {{contact_first_name}}",
        unresolved: ["contact_first_name"], duplicate: false, other_recipient_sent: true, snapshot: { fixture: "current" } } } });
    }
    if (url.pathname === "/api/admin/notifications/requirements/draft") {
      assert.equal(request.method(), "POST");
      const input = request.postDataJSON(); noticeCalls.push(input);
      assert.equal(input.is_test, true); assert.equal(input.subject, "[TEST] Fixture subject");
      assert.equal(input.body, "Fixture personalized body reviewed"); assert.deepEqual(input.preview, { fixture: "current" });
      return route.fulfill({ status: 201, json: { id: uuid(31), status: "Draft", revision: 1 } });
    }
    if (url.pathname === `/api/communications/${uuid(31)}/send`) {
      assert.equal(request.method(), "POST"); assert.deepEqual(request.postDataJSON(), { confirmed: true, revision: 1 });
      noticeCalls.push("send");
      return route.fulfill({ json: { communication_id: uuid(31), status: "Sent", graph_acceptance: "Accepted", delivered: false } });
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
  await panel.locator("span").filter({ hasText: /^Fixture Non-Expiring$/ }).waitFor();
  const notice = panel.getByRole("region", { name: "Requirement notice preview" });
  await notice.locator("select").nth(0).selectOption(uuid(10));
  await notice.getByLabel("Search Contractors").fill("Fixture");
  await notice.getByRole("button", { name: "Search", exact: true }).click();
  await notice.locator("select").nth(1).selectOption("1");
  await notice.getByRole("option", { name: "Fixture Contact (fixture@example.invalid)" }).waitFor({ state: "attached" });
  await notice.locator("select").nth(2).selectOption(uuid(30));
  await notice.getByRole("button", { name: "Generate Preview" }).click();
  await notice.getByLabel("Final body").waitFor();
  assert.equal(await notice.getByLabel("Final body").inputValue(), "Fixture personalized body {{contact_first_name}}");
  await notice.getByText("This interval was previously sent to another contact.").waitFor();
  await notice.getByText(/Unresolved fields: contact_first_name/).waitFor();
  assert.equal(await notice.getByRole("button", { name: "Save Notice Draft for Review" }).isDisabled(), true);
  await notice.getByLabel("Final body").fill("Fixture personalized body reviewed");
  await notice.getByRole("button", { name: "Save Notice Draft for Review" }).click();
  const review = notice.getByRole("region", { name: "Review notice send" });
  await review.getByText(/Actual recipient: richg@dobcogroup.com/).waitFor();
  assert.equal(await review.getByRole("button", { name: "Confirm and Send Notice" }).isDisabled(), true);
  await review.getByRole("checkbox").check();
  await review.getByRole("button", { name: "Confirm and Send Notice" }).click();
  await review.getByText(/Accepted by Microsoft Graph/).waitFor();
  assert.equal(await review.getByRole("button", { name: "Confirm and Send Notice" }).isDisabled(), true);
  assert.equal(noticeCalls.length, 2);
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
  await editor.getByLabel("Eligibility Authority").selectOption("nj_pwc_monitoring");
  await editor.getByRole("button", { name: "Add interval" }).click();
  await editor.getByLabel("Days before expiration").fill("47");
  await editor.getByLabel("Enabled", { exact: true }).check();
  await editor.getByLabel("Approved template").selectOption(template.id);
  await editor.getByLabel("Automatic Notices Enabled").check();
  await editor.getByRole("button", { name: "Save rule" }).click();
  await panel.getByText(/Configuration ready \(not executing; master controls apply\)/).waitFor();
  assert.equal(writes.length, 2);
  assert.equal(writes[1].input.intervals[0].days_before_expiration, 47);
  assert.equal(writes[1].input.eligibility_authority, "nj_pwc_monitoring");
  template.revision = 2; template.approved_by = null; template.approved_at = null; rules[0].configuration_ready = false;
  await page.reload(); await page.getByRole("tab", { name: "Notifications", exact: true }).click();
  await panel.getByText(/Not ready: requirement or template approval changed/).waitFor();
  admin = false;
  await page.reload(); await page.getByRole("tab", { name: "Notifications", exact: true }).click();
  await panel.locator("span").filter({ hasText: /^Fixture Non-Expiring$/ }).waitFor();
  assert.equal(await panel.getByRole("button", { name: /Approve Fixture reminder/ }).count(), 0, "Settings manager alone cannot approve.");
  manage = false;
  await page.reload(); await page.getByRole("tab", { name: "Notifications", exact: true }).click();
  await panel.locator("span").filter({ hasText: /^Fixture Non-Expiring$/ }).waitFor();
  assert.equal(await panel.getByRole("button", { name: /Configure/ }).count(), 0, "View-only cannot edit.");
  assert.equal(writes.length, 2);
  assert.deepEqual(errors, []);
  await context.close();
  console.log("PASS: requirement configuration and notice review UI, redirected test draft, explicit confirmation and intercepted send, stale revision and permission boundaries; no real delivery.");
} finally { await browser.close(); }
