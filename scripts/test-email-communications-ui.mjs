import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "../worker/nj-pwc/node_modules/playwright");
const app = process.env.TEST_APP_URL;
assert.ok(app && new URL(app).hostname === "localhost", "Use an intercepted localhost preview only");
const origin = new URL(fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8")
  .match(/^NEXT_PUBLIC_SUPABASE_URL\s*=\s*["']?([^"'\r\n]+)/m)[1].trim()).origin;
const uuid = n => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const user = { id: uuid(1), email: "fixture@example.invalid", aud: "authenticated", app_metadata: {}, user_metadata: {} };
const internal = { recipient_type: "dobco_contact", recipient_name: "Alice Internal", email: "alice@example.invalid",
  mobile_phone: null, contractor_contact_id: null, dobco_contact_id: uuid(10) };
const contractor = { recipient_type: "contractor_contact", recipient_name: "Chris Contractor", email: "chris@example.invalid",
  mobile_phone: null, contractor_contact_id: uuid(11), dobco_contact_id: null };
const disabled = { ...contractor, recipient_name: "Dana Disabled", email: "dana@example.invalid", contractor_contact_id: uuid(12) };
const bccContact = { ...internal, recipient_name: "Bea Internal", email: "bea@example.invalid", dobco_contact_id: uuid(13) };
const template = { id: uuid(50), name: "Project Update", channel: "email", category: "General Contractor Communication",
  subject: "Project update", body: "Please review the project update.", revision: 1, is_active: true };
const controls = { available: true, enabled: true, contractor_email_enabled: true, internal_email_enabled: true };
const settings = { channel: "email", provider: "microsoft_365", enabled: true, automated_enabled: false, from_name: "SubTracker Fixture",
  from_address: "sender@example.invalid", reply_to_address: null, microsoft_tenant_id: uuid(90), microsoft_client_id: uuid(91), revision: 1,
  configuration_status: "Configuration Complete", contractor_email_enabled: true, internal_email_enabled: true };
const drafts = new Map(), writes = [], errors = [], sent = [], plans = [];
let grants = ["communications_content", "communications_summary", "communications_delivery", "settings", "projects", "contractors", "compliance"];
let pending = false, failSave = false, failSend = false, editPermission = true;
const choice = r => ({ key: r.email, kind: "contact", label: r.recipient_name,
  detail: `${r.recipient_type === "dobco_contact" ? "Dobco Contact" : "Contractor Contact"} | ${r.email}`, recipient: r,
  ...(r.recipient_type === "contractor_contact" ? { contractor_id: 1, company_name: "Fixture Construction" } : {}),
  exclusion_reason: r.email === disabled.email ? "This contractor contact has email disabled." : null });
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await context.addInitScript(({ origin, user }) => localStorage.setItem(`sb-${new URL(origin).hostname.split(".")[0]}-auth-token`,
    JSON.stringify({ access_token: "synthetic-token", refresh_token: "synthetic-refresh", token_type: "bearer",
      expires_at: Math.floor(Date.now() / 1000) + 3600, user })), { origin, user });
  await context.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== new URL(app).origin) {
      assert.equal(url.origin, origin);
      assert.ok(url.pathname.startsWith("/auth/") && ["GET", "HEAD"].includes(request.method()), "No real database or provider requests");
      return route.fulfill({ json: user });
    }
    if (url.pathname === "/api/admin/bootstrap") return route.fulfill({ json: {} });
    if (url.pathname === "/api/auth/session") return route.fulfill({ json: {
      profile: { auth_user_id: user.id, name: "Synthetic reviewer", role: "Fixture", status: "Active", system_administrator: false },
      permissions: grants.map(module => ({ module, can_view: true, can_add: true, can_edit: module === "communications_content" ? editPermission : true, can_manage: true, can_delete: true })),
    } });
    if (!url.pathname.startsWith("/api/")) return route.continue();
    if (request.method() !== "GET") writes.push({ path: url.pathname, body: request.postDataJSON() });
    if (url.pathname === "/api/communications/compose-options") {
      const kind = url.searchParams.get("kind") ?? "configuration";
      if (kind === "configuration") return route.fulfill({ json: {
        email_controls: pending ? { available: false, notice: "Email workspace migration is pending. Sending, saving and scheduling here are unavailable until it is applied." } : controls,
        installation: { organization_name: "Fixture", application_name: "SubTracker" },
        channels: [{ ...settings, manual_send_ready: controls.enabled }],
      } });
      return route.fulfill({ json: { rows: kind === "templates" ? [template]
        : kind === "projects" ? [{ id: 18, project_number: "24-002", project_name: "NJSDA Garfield ES" }]
          : kind === "contractors" ? [{ id: 1, company_name: "Fixture Construction" }]
            : kind === "compliance" ? [{ contractor_id: 1, compliance_record_id: 7, compliance_name: "NJ PWC", calculated_status: "Current", expiration_date: "2027-01-01", days_remaining: 90 }] : [],
      next_offset: null } });
    }
    if (url.pathname === "/api/communications/email-recipients") {
      const search = (url.searchParams.get("search") ?? "").toLowerCase();
      const rows = [internal, contractor, disabled, bccContact].filter(r => r.recipient_name.toLowerCase().includes(search) || r.email.includes(search)).map(choice);
      if (search.includes("company")) rows.push({ key: "company:1", kind: "company", label: "Fixture Construction", detail: "Company | Choose contacts", contractor_id: 1 });
      if (search.includes("24-002")) rows.push({ key: "project:18", kind: "project", label: "24-002 - NJSDA Garfield ES", detail: "Project | Choose assigned contractor contacts", project_id: 18 });
      return route.fulfill({ json: { rows, notice: "Fixture contacts only" } });
    }
    if (url.pathname === "/api/communications/email-assessment") {
      assert.equal(request.method(), "POST");
      const draft = request.postDataJSON();
      assert.ok(draft.recipients.length <= 100);
      const exclusions = draft.recipients.map(r => ({ email: r.email, recipient_role: r.recipient_role ?? "to",
        reason: !controls.enabled ? "Email is currently disabled in Email Settings."
          : r.recipient_type === "dobco_contact" && !controls.internal_email_enabled ? "Dobco internal email is currently disabled in Email Settings."
            : r.recipient_type !== "dobco_contact" && !controls.contractor_email_enabled ? "Contractor email is currently disabled in Email Settings."
              : r.email === disabled.email ? "This contractor contact has email disabled." : null }));
      return route.fulfill({ json: { draft, exclusions } });
    }
    if (url.pathname === "/api/communications/email-history") {
      const folder = url.searchParams.get("folder");
      const rows = [...drafts.values()].filter(d => folder === "Drafts" ? d.status === "Draft" : folder === "Scheduled" ? d.status === "Scheduled" : d.status === (url.searchParams.get("status") || "Sent"));
      return route.fulfill({ json: { messages: rows.map(d => ({ ...d, recipient_count: d.recipients.length,
        direction: "outbound", source: "manual", created_at: "2026-11-10T12:00:00Z", contractors: [], projects: [] })), next_offset: null } });
    }
    if (url.pathname === "/api/admin/communication-templates") return route.fulfill({ json: { templates: [template], next_offset: null } });
    if (url.pathname === "/api/admin/dobco-contacts") return route.fulfill({ json: { contacts: [] } });
    if (url.pathname === "/api/admin/communication-settings/email") return route.fulfill({ json: { settings, email_controls: controls } });
    if (url.pathname === "/api/admin/microsoft-email") return route.fulfill({ json: { identity_status: "Ready", authentication_status: "Verified", delivery_status: "Accepted by Graph", configuration_status: "Ready for Testing" } });
    if (url.pathname === "/api/admin/invitation-email-settings") return route.fulfill({ json: { settings: {
      enabled: true, delivery_mode: "supabase_auth", revision: 1, organization_name: "Fixture", application_name: "SubTracker",
    } } });
    if (url.pathname === "/api/admin/notifications") return route.fulfill({ json: {
      automation: { email: { automated_enabled: false, revision: 1 }, sms: { automated_enabled: false, revision: 1 } }, rules: [], execution_enabled: false,
    } });
    if (url.pathname === "/api/admin/notifications/requirements") return route.fulfill({ json: { rules: [], templates: [], contacts: [], execution_enabled: false } });
    if (url.pathname === "/api/communications" && request.method() === "POST") {
      if (failSave) return route.fulfill({ status: 503, json: { error: "Synthetic uncertain save" } });
      const id = uuid(100 + drafts.size), draft = { ...request.postDataJSON(), id, status: "Draft", revision: 1 };
      if (draft.recipients.some(r => r.recipient_type === "contractor_contact")) assert.ok(draft.contractor_ids.includes(1));
      drafts.set(id, draft);
      return route.fulfill({ status: 201, json: { id, status: "Draft", revision: 1 } });
    }
    const match = url.pathname.match(/^\/api\/communications\/([^/]+)(?:\/(draft|send|plan|delivery))?$/);
    if (match) {
      const [, id, action] = match, draft = drafts.get(id);
      assert.ok(draft, `Known fixture draft ${id}`);
      if (action === "draft") return route.fulfill({ json: { draft: { ...draft,
        related_contractors: draft.contractor_ids.includes(1) ? [{ id: 1, company_name: "Fixture Construction" }] : [],
        related_projects: draft.project_ids.includes(18) ? [{ id: 18, project_number: "24-002", project_name: "NJSDA Garfield ES" }] : [],
        provider: "microsoft_365", sender_name: settings.from_name, sender_address: settings.from_address } } });
      if (action === "send") {
        assert.equal(draft.status, "Draft"); assert.equal(request.postDataJSON().revision, draft.revision);
        assert.ok(draft.recipients.every(r => r.email !== disabled.email));
        if (failSend) {
          draft.status = "Failed";
          return route.fulfill({ status: 502, json: { error: "Synthetic unknown outcome; review history. Do not retry." } });
        }
        draft.status = "Sent"; sent.push(structuredClone(draft));
        return route.fulfill({ json: { communication_id: id, status: "Sent", graph_acceptance: "Accepted", delivered: false } });
      }
      if (action === "plan") {
        const input = request.postDataJSON();
        assert.equal(input.revision, draft.revision);
        draft.status = input.action === "cancel" ? "Cancelled" : "Scheduled"; draft.revision++;
        if (input.action === "schedule") { assert.ok(Date.parse(input.scheduled_at) > Date.now()); draft.scheduled_at = input.scheduled_at; }
        plans.push(structuredClone(draft));
        return route.fulfill({ json: { id, status: draft.status, execution_enabled: false } });
      }
      if (action === "delivery") return route.fulfill({ json: { delivery: { status: draft.status, provider: "microsoft_365", failure_reason: null, sent_at: null,
        communication_recipients: draft.recipients.map((r, i) => ({ id: uuid(i + 300), status: draft.status, recipient_role: r.recipient_role, failure_reason: null })) } } });
      if (request.method() === "PATCH") {
        assert.ok(editPermission, "Add-only users must not require Edit just to send an unchanged saved Draft");
        assert.equal(request.postDataJSON().revision, draft.revision);
        Object.assign(draft, request.postDataJSON(), { revision: draft.revision + 1 });
        return route.fulfill({ json: { id, revision: draft.revision, status: "Draft" } });
      }
      return route.fulfill({ json: { communication: { ...draft, sender_address: settings.from_address, communication_recipients: draft.recipients, context_snapshot: null } } });
    }
    assert.fail(`Unexpected API request: ${request.method()} ${url.pathname}`);
  });
  const page = await context.newPage();
  page.on("pageerror", e => errors.push(e.message));
  async function fresh() {
    await page.goto(`${app}/email-communications`);
    await page.getByLabel("Template", { exact: true }).getByRole("option", { name: template.name }).waitFor({ state: "attached" });
  }
  async function recipient(name, role = "To") {
    if (role !== "To" && !(await page.getByRole("combobox", { name: `${role} recipient search`, exact: true }).isVisible())) await page.getByRole("button", { name: "Cc / Bcc", exact: true }).click();
    await page.getByRole("combobox", { name: `${role} recipient search`, exact: true }).fill(name);
    await page.locator("#email-recipient-results").getByRole("button").filter({ hasText: name }).first().click();
  }
  async function message(subject = "Fixture message") {
    await page.getByLabel("Subject", { exact: true }).fill(subject); await page.getByLabel("Message", { exact: true }).fill("Synthetic message; no real delivery.");
  }
  async function screenshot(name) {
    if (process.env.TEST_SCREENSHOT_DIR) await page.locator("main").screenshot({ path: path.join(process.env.TEST_SCREENSHOT_DIR, `${name}.png`), animations: "disabled" });
  }
  await fresh();
  assert.deepEqual(await page.getByRole("tab").allTextContents(), ["New Message", "Drafts", "Scheduled", "Sent", "Templates", "Contacts", "Settings"]);
  const sidebar = page.locator("#app-navigation");
  assert.equal(await sidebar.evaluate(element => element.getBoundingClientRect().width), 252, "Email reuses the approved Style 3 sidebar.");
  assert.equal(await sidebar.locator('[aria-current="page"]').innerText(), "Email Communications");
  assert.equal(await sidebar.getByRole("img", { name: "Dobco", exact: true }).count(), 1);
  assert.equal(await sidebar.getByText("Administration", { exact: true }).count(), 1);
  assert.equal(await sidebar.getByText("Synthetic reviewer", { exact: true }).count(), 1);
  assert.equal(await sidebar.locator("nav svg").count(), await sidebar.locator("nav a").count(), "Shared navigation uses production icons.");
  const mailbox = page.getByRole("tablist", { name: "Email Communications areas" });
  const folderPolish = await mailbox.getByRole("tab", { name: "Drafts", exact: true }).evaluate(tab => ({
    gap: getComputedStyle(tab).columnGap,
    iconBorder: getComputedStyle(tab.firstElementChild).borderTopColor,
  }));
  assert.equal(folderPolish.gap, "6px", "Secondary mailbox icons sit close to their labels.");
  assert.equal(folderPolish.iconBorder, "rgb(203, 217, 235)", "Mailbox icon containers have defined Style 3 borders.");
  const tabColors = async () => mailbox.getByRole("tab").evaluateAll(tabs => tabs.map(tab => ({
    selected: tab.getAttribute("aria-selected"), background: getComputedStyle(tab).backgroundColor,
    border: getComputedStyle(tab).borderTopColor,
  })));
  let colors = await tabColors();
  assert.equal(colors[0].background, "rgb(8, 100, 255)");
  assert.ok(colors.slice(1).every(tab => tab.background === "rgb(255, 255, 255)" && tab.border === "rgb(220, 229, 240)"));
  await page.getByRole("tab", { name: "Drafts", exact: true }).hover();
  await page.waitForTimeout(200);
  colors = await tabColors();
  assert.equal(colors[1].background, "rgb(234, 242, 254)", "Mailbox folders have visible hover feedback.");
  await page.getByRole("tab", { name: "Drafts", exact: true }).click();
  await page.getByRole("tab", { name: "Settings", exact: true }).focus();
  await page.mouse.move(0, 0);
  await page.waitForTimeout(200);
  colors = await tabColors();
  assert.equal(colors[1].background, "rgb(8, 100, 255)");
  assert.equal(colors[0].background, "rgb(255, 255, 255)", "Only the selected section stays blue.");
  for (const [width, height] of [[1600, 1000], [1024, 768], [390, 844]]) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `No Email page overflow at ${width}px`);
    const menu = page.getByRole("button", { name: "Menu", exact: true });
    if (width <= 900) {
      await menu.click();
      await sidebar.getByRole("link", { name: "Email Communications", exact: true }).click();
      assert.equal(await menu.getAttribute("aria-expanded"), "false", "Shared mobile sidebar closes after navigation.");
    }
    for (const tab of await mailbox.getByRole("tab").all()) {
      const box = await tab.boundingBox();
      assert.ok(box && box.x >= 0 && box.x + box.width <= width + 1, "Mailbox controls fit the viewport.");
    }
  }
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.getByRole("tab", { name: "New Message", exact: true }).click();
  if (process.env.TEST_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.TEST_SCREENSHOT_DIR, "Email_Style3_Navigation_Fixture.png"), animations: "disabled" });
  assert.equal(await page.getByText(/Preview Drafts|I reviewed the email/).count(), 0);
  await recipient("Alice Internal"); await message("Single direct send");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "Sent." }).waitFor();
  assert.equal(sent.length, 1); assert.equal(await page.getByRole("dialog").count(), 0);
  assert.equal(writes.filter(w => w.path === "/api/communications").length, 1);
  await fresh();
  await recipient("Alice Internal"); await recipient("Chris Contractor", "Cc"); await recipient("Dana Disabled", "Bcc");
  await message("Mixed-recipient review");
  await screenshot("Email_Composer_Fixture");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const confirmation = page.getByRole("dialog");
  await confirmation.getByRole("heading", { name: "Send this message to 3 recipients?" }).waitFor();
  assert.match(await confirmation.innerText(), /2 eligible\s+1 excluded/);
  assert.equal(sent.length, 1); assert.equal(await page.getByRole("dialog").count(), 1);
  await screenshot("Email_Bulk_Confirmation_Fixture");
  await confirmation.getByRole("button", { name: "Send to 2", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "Sent." }).waitFor();
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1].recipients.map(r => r.recipient_role), ["to", "cc"]);
  await fresh();
  await recipient("Alice Internal"); await recipient("Chris Contractor", "Cc");
  await page.getByLabel("Template", { exact: true }).selectOption(template.id);
  assert.equal(await page.getByLabel("Message", { exact: true }).inputValue(), template.body);
  await page.getByRole("button", { name: "+ Add project, contractor or compliance item", exact: true }).click();
  await page.getByRole("button", { name: "Find", exact: true }).click();
  await page.getByRole("button", { name: "24-002 - NJSDA Garfield ES", exact: true }).click();
  await page.getByRole("button", { name: "Save Draft", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "Draft saved." }).waitFor();
  assert.equal(sent.length, 2);
  const saved = [...drafts.values()].at(-1);
  assert.deepEqual(saved.project_ids, [18]); assert.equal(saved.template_id, template.id);
  await page.getByRole("tab", { name: "Drafts", exact: true }).click();
  await page.getByRole("button", { name: "Project update", exact: true }).click();
  await page.getByRole("button", { name: "Edit draft", exact: true }).first().click();
  await page.getByRole("heading", { name: "Edit draft", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Remove Chris Contractor from cc", exact: true }).count(), 1);
  await recipient("Bea Internal", "Bcc");
  await page.getByRole("button", { name: "Save Draft", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "Draft saved." }).waitFor();
  assert.deepEqual(saved.recipients.map(r => r.recipient_role), ["to", "cc", "bcc"]);
  await page.getByRole("button", { name: "Schedule", exact: true }).click();
  const schedule = page.getByRole("dialog");
  assert.match(await schedule.innerText(), /plans only.*Automatic delivery is not available/s);
  await schedule.getByLabel("Date", { exact: true }).fill("2099-01-02"); await schedule.getByLabel("Time", { exact: true }).fill("10:30");
  await schedule.getByLabel("Time zone", { exact: true }).selectOption("UTC");
  await screenshot("Email_Schedule_Fixture");
  await schedule.getByRole("button", { name: "Schedule", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "Plan saved" }).waitFor();
  assert.equal(plans.length, 1); assert.equal(sent.length, 2);
  assert.equal(plans[0].scheduled_at, "2099-01-02T10:30:00.000Z");
  assert.deepEqual(plans[0].recipients.map(r => r.recipient_role), ["to", "cc", "bcc"]);
  await page.getByRole("tab", { name: "Scheduled", exact: true }).click();
  await page.getByRole("button", { name: "Project update", exact: true }).click();
  await page.getByRole("article", { name: "Message details" }).getByText(/Bcc:.*Bea Internal/).waitFor();
  assert.match(await page.getByRole("article", { name: "Message details" }).innerText(), /Bcc:.*Bea Internal/);
  await screenshot("Email_Scheduled_Fixture");
  await page.getByRole("button", { name: "Cancel scheduled plan", exact: true }).click();
  await page.getByText("No scheduled messages.", { exact: true }).waitFor();
  await page.getByRole("tab", { name: "Sent", exact: true }).click();
  await page.getByRole("button", { name: "Mixed-recipient review", exact: true }).waitFor();
  await screenshot("Email_Sent_Fixture");
  await page.getByRole("tab", { name: "Templates", exact: true }).click();
  await page.getByRole("heading", { name: "Communication Templates", exact: true }).waitFor();
  await page.getByRole("tab", { name: "Contacts", exact: true }).click();
  await page.getByLabel("Contact source", { exact: true }).selectOption("contractor");
  await page.getByRole("link", { name: "open the existing Contractor directory" }).waitFor();
  await page.getByRole("tab", { name: "Settings", exact: true }).click();
  await page.getByLabel("Contractor Email Enabled", { exact: true }).waitFor();
  await page.getByLabel("Dobco Internal Email Enabled", { exact: true }).waitFor();
  await screenshot("Email_Settings_Fixture");
  controls.contractor_email_enabled = false;
  await fresh(); await recipient("Chris Contractor"); await message();
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "Contractor email is currently disabled" }).waitFor();
  assert.equal(sent.length, 2);
  controls.contractor_email_enabled = true; controls.internal_email_enabled = false;
  await fresh(); await recipient("Alice Internal"); await message();
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "Dobco internal email is currently disabled" }).waitFor();
  assert.equal(sent.length, 2); controls.internal_email_enabled = true;
  editPermission = false;
  await fresh(); await recipient("Alice Internal"); await message("Add-only saved then sent");
  await page.getByRole("button", { name: "Save Draft", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "Draft saved." }).waitFor();
  const savesBeforeSend = writes.filter(w => w.path === "/api/communications" || /^\/api\/communications\/[0-9a-f-]{36}$/.test(w.path)).length;
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "Sent." }).waitFor();
  assert.equal(sent.length, 3);
  assert.equal(writes.filter(w => w.path === "/api/communications" || /^\/api\/communications\/[0-9a-f-]{36}$/.test(w.path)).length, savesBeforeSend);
  editPermission = true;
  failSend = true;
  await fresh(); await recipient("Alice Internal"); await message("Unknown fixture send");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "unknown outcome" }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Send", exact: true }).isDisabled(), true);
  assert.equal(sent.length, 3); failSend = false;
  failSave = true;
  await fresh(); await recipient("Alice Internal"); await message();
  await page.getByRole("button", { name: "Save Draft", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "do not retry an uncertain save" }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Save Draft", exact: true }).isDisabled(), true);
  failSave = false; pending = true;
  await fresh();
  await page.getByRole("status").filter({ hasText: "migration is pending" }).waitFor();
  for (const name of ["Save Draft", "Schedule", "Send"]) assert.equal(await page.getByRole("button", { name, exact: true }).isDisabled(), true);
  pending = false; grants = ["settings"];
  await page.goto(`${app}/email-communications`);
  await page.getByRole("heading", { name: "Email Communications", exact: true }).waitFor();
  assert.equal(await page.getByRole("textbox", { name: "Message", exact: true }).count(), 0);
  assert.deepEqual(errors, []);
  console.log("PASS: Unified Style 3 Email workspace; direct single send, exactly one multi-recipient confirmation with exclusions, independent optional draft save/reopen, real To/Cc/Bcc roles, templates/project associations, plan-only UTC scheduling/cancellation, Sent/details, master-control explanations, permissions, uncertain-save retry protection, pending-migration write block. All network/delivery mutations intercepted.");
} finally { await browser.close(); }
