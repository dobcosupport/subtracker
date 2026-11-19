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
const template = { id: uuid(50), name: "Expired PWC Notice", default_importance: "high", channel: "email", category: "General Contractor Communication",
  subject: "Expired {{compliance_type}} registration - {{contractor_name}}",
  body: "<p><strong>URGENT – WORK RESTRICTION</strong></p><p>Effective immediately, <b>{{contractor_name}}</b> is not permitted to perform affected public works onsite work requiring a valid {{compliance_type}} registration until the required registration has been renewed and verified.</p><p>Registration Number: {{registration_number}}<br>Expiration Date: {{expiration_date}}</p>",
  revision: 1, is_active: true };
const templateCopies = [];
const controls = { available: true, enabled: true, contractor_email_enabled: true, internal_email_enabled: true };
const scheduling = { available: true, execution_enabled: true, automatic_delivery_enabled: true,
  notice: "Scheduled messages are delivered when due, subject to current Email Settings and recipient eligibility." };
const workerPolicy = { enabled: true, batch_size: 5, retry_policy: "pre_dispatch_only", retry_delay_seconds: 300,
  maximum_attempts: 5, stale_claim_seconds: 600, last_polled_at: "2026-11-10T12:00:00Z", revision: 1 };
const settings = { channel: "email", provider: "microsoft_365", enabled: true, automated_enabled: false, from_name: "SubTracker Fixture",
  from_address: "sender@example.invalid", reply_to_address: null, microsoft_tenant_id: uuid(90), microsoft_client_id: uuid(91), revision: 1,
  configuration_status: "Configuration Complete", contractor_email_enabled: true, internal_email_enabled: true };
const drafts = new Map(), writes = [], errors = [], sent = [], plans = [];
const followupRetries = [];
let followupRecoveryId = null, followupRecovered = false;
let grants = ["communications_content", "communications_summary", "communications_delivery", "settings", "projects", "contractors", "compliance"];
let pending = false, failSave = false, failSend = false, editPermission = true, providerReady = true;
let draftReadGate = null;
let draftReadStarted = null;
const draftReads = [];
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
        scheduling,
        installation: { organization_name: "Fixture", application_name: "SubTracker" },
        channels: [{ ...settings, manual_send_ready: controls.enabled && providerReady }],
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
      if (`${draft.subject} ${draft.body}`.includes("{{registration_number}}")) {
        assert.deepEqual(draft.contractor_ids, [1]);
        if (!draft.compliance_record_ids.includes(7)) return route.fulfill({ status: 400,
          json: { error: "Cannot send: Expiration Date could not be resolved for this recipient." } });
        const to = draft.recipients.filter(r => (r.recipient_role ?? "to") === "to");
        const values = { contractor_name: "Fixture Construction", compliance_type: "NJ PWC", registration_number: "REG-123", expiration_date: "2027-01-01",
          ...(to.length === 1 ? { contact_name: to[0].recipient_name, contact_email: to[0].email, contact_mobile: to[0].mobile_phone } : {}),
          ...(draft.project_ids.includes(18) ? { project_number: "24-002", project_name: "NJSDA Garfield ES" } : {}) };
        for (const field of ["subject", "body"]) draft[field] = draft[field].replace(/\{\{(\w+)\}\}/g, (_, key) => values[key] ?? `{{${key}}}`);
      }
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
        direction: "outbound", source: "manual", created_at: "2026-11-10T12:00:00Z", contractors: [], projects: [] })), next_offset: null, scheduling } });
    }
    if (url.pathname === "/api/admin/communication-templates") {
      if (request.method() === "POST") {
        const input = request.postDataJSON();
        assert.ok(!("id" in input) && !("revision" in input) && !("created_at" in input), "Create never copies source identity/history");
        const copy = { ...input, id: uuid(600 + templateCopies.length), revision: 1, created_at: "2026-11-18T12:00:00Z", updated_at: "2026-11-18T12:00:00Z" };
        templateCopies.push(copy);
        return route.fulfill({ status: 201, json: { id: copy.id, revision: 1 } });
      }
      assert.equal(request.method(), "GET");
      return route.fulfill({ json: { templates: [template, ...templateCopies], next_offset: null } });
    }
    if (/^\/api\/admin\/communication-templates\/[^/]+$/.test(url.pathname)) {
      assert.equal(request.method(), "PATCH");
      const copy = templateCopies.find(t => url.pathname.endsWith(`/${t.id}`));
      assert.ok(copy, "Only duplicate is edited");
      const input = request.postDataJSON();
      assert.equal(input.revision, copy.revision);
      Object.assign(copy, input, { revision: copy.revision + 1 });
      return route.fulfill({ json: { id: copy.id, revision: copy.revision } });
    }
    if (url.pathname === "/api/admin/dobco-contacts") return route.fulfill({ json: { contacts: [] } });
    if (url.pathname === "/api/admin/communication-settings/email") return route.fulfill({ json: { settings, email_controls: controls } });
    if (url.pathname === "/api/admin/scheduled-email") {
      if (request.method() === "PATCH") {
        const input = request.postDataJSON();
        assert.equal(input.revision, workerPolicy.revision);
        assert.ok(!("last_polled_at" in input));
        Object.assign(workerPolicy, input, { revision: workerPolicy.revision + 1 });
        return route.fulfill({ json: { saved: true } });
      }
      return route.fulfill({ json: { policy: workerPolicy, scheduling } });
    }
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
      drafts.set(id, draft);
      return route.fulfill({ status: 201, json: { id, status: "Draft", revision: 1 } });
    }
    if (/^\/api\/communications\/[^/]+\/followup$/.test(url.pathname)) {
      if (request.method() === "POST") {
        assert.equal(url.pathname, `/api/communications/${followupRecoveryId}/followup`);
        assert.equal(followupRecovered, false);
        followupRetries.push(followupRecoveryId);
        followupRecovered = true;
      } else assert.equal(request.method(), "GET");
      const followup = url.pathname === `/api/communications/${followupRecoveryId}/followup`
        ? followupRecovered ? { state: "completed", followup_id: 501 }
          : { state: "recoverable", last_error: "Synthetic insertion failure; email remains Sent." }
        : { state: "not_configured" };
      return route.fulfill({ json: { followup } });
    }
    const match = url.pathname.match(/^\/api\/communications\/([^/]+)(?:\/(draft|send|plan|delivery))?$/);
    if (match) {
      const [, id, action] = match, draft = drafts.get(id);
      assert.ok(draft, `Known fixture draft ${id}`);
      if (action === "draft") {
        const payload = structuredClone({ draft: { ...draft,
        related_contractors: draft.contractor_ids.includes(1) ? [{ id: 1, company_name: "Fixture Construction" }] : [],
        related_projects: draft.project_ids.includes(18) ? [{ id: 18, project_number: "24-002", project_name: "NJSDA Garfield ES" }] : [],
        provider: "microsoft_365", sender_name: settings.from_name, sender_address: settings.from_address } });
        draftReads.push(payload);
        draftReadStarted?.();
        if (draftReadGate) await draftReadGate;
        return route.fulfill({ json: payload });
      }
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
        return route.fulfill({ json: { id, status: draft.status, execution_enabled: scheduling.execution_enabled, scheduling } });
      }
      if (action === "delivery") return route.fulfill({ json: { delivery: { status: draft.status, provider: "microsoft_365", failure_reason: null, sent_at: null,
        scheduled_delivery: draft.status === "Scheduled" && !scheduling.automatic_delivery_enabled ? {
          blocked_reason: "Automatic Delivery is disabled. Message remains Scheduled.", outcome: null, finished_at: null, next_attempt_at: "2099-01-02T10:35:00Z",
        } : null,
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
    await page.getByLabel("Subject", { exact: true }).fill(subject); await page.getByLabel("Message Body", { exact: true }).fill("Synthetic message; no real delivery.");
  }
  async function screenshot(name) {
    if (process.env.TEST_SCREENSHOT_DIR) await page.locator("main").screenshot({ path: path.join(process.env.TEST_SCREENSHOT_DIR, `${name}.png`), animations: "disabled" });
  }
  await fresh();
  const messageOptions = page.getByRole("region", { name: "Message Options", exact: true });
  await messageOptions.getByRole("heading", { name: "Message Options", exact: true }).waitFor();
  const importanceBox = await messageOptions.getByLabel("Importance", { exact: true }).boundingBox();
  const followupBox = await messageOptions.getByRole("checkbox", { name: "Create Follow-Up after successful send", exact: true }).boundingBox();
  assert.ok(importanceBox && followupBox && Math.abs(importanceBox.y + importanceBox.height / 2 - followupBox.y - followupBox.height / 2) < 3,
    "Importance and Create Follow-Up share one compact desktop row");
  assert.equal(await messageOptions.getByLabel("Follow-Up Status", { exact: true }).count(), 0);
  await messageOptions.getByRole("checkbox", { name: "Create Follow-Up after successful send", exact: true }).check();
  await messageOptions.getByLabel("Follow-Up Status", { exact: true }).waitFor();
  await messageOptions.getByRole("checkbox", { name: "Create Follow-Up after successful send", exact: true }).uncheck();
  assert.equal(await page.getByLabel("Importance", { exact: true }).inputValue(), "normal", "No template starts Normal");
  const editor = page.getByLabel("Message Body", { exact: true });
  async function selectBody() { await editor.selectText(); }
  await editor.fill("Formatting fixture");
  await selectBody(); await page.getByRole("button", { name: "Bold", exact: true }).click();
  assert.equal(await editor.locator("b,strong").count(), 1);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  assert.equal(await editor.locator("b,strong").count(), 0);
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  assert.equal(await editor.locator("b,strong").count(), 1);
  await selectBody(); await page.getByRole("button", { name: "Underline", exact: true }).click();
  assert.equal(await editor.locator("u,span[style*='underline']").count(), 1);
  await selectBody(); await page.getByRole("button", { name: "Clear formatting", exact: true }).click();
  assert.equal(await editor.locator("b,strong,u,span[style]").count(), 0);
  await selectBody(); await page.getByRole("button", { name: "Bulleted list", exact: true }).click();
  assert.equal(await editor.locator("ul li").count(), 1);
  await selectBody(); await page.getByRole("button", { name: "Numbered list", exact: true }).click();
  assert.equal(await editor.locator("ol li").count(), 1);
  await editor.fill("Safe link");
  await selectBody();
  page.once("dialog", dialog => dialog.accept("https://example.invalid/renew"));
  await page.getByRole("button", { name: "Add link", exact: true }).click();
  assert.equal(await editor.locator("a").getAttribute("href"), "https://example.invalid/renew");
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
  providerReady = false;
  await fresh();
  await recipient("Alice Internal");
  await page.getByRole("button", { name: "+ Add project, contractor or compliance item", exact: true }).click();
  const related = page.getByRole("region", { name: "Related To selection", exact: true });
  assert.equal(await related.getByRole("group").count(), 3, "All three Related To selectors open together");
  await related.getByRole("checkbox", { name: "Fixture Construction", exact: true }).check();
  await related.getByLabel("Related compliance record", { exact: true }).selectOption("7");
  await related.getByRole("button", { name: "Apply", exact: true }).click();
  await page.getByLabel("Template", { exact: true }).selectOption(template.id);
  assert.equal(await page.getByLabel("Importance", { exact: true }).inputValue(), "high", "Template High loads into composer");
  await screenshot("Email_Importance_New_Message");
  const formattedBody = page.getByLabel("Message Body", { exact: true });
  assert.ok(await page.getByRole("button", { name: "Bold", exact: true }).count());
  assert.ok(await page.getByRole("button", { name: "Undo", exact: true }).count());
  await formattedBody.locator("strong").selectText();
  await page.getByRole("button", { name: "Italic", exact: true }).click();
  assert.equal(await formattedBody.locator("em, i").count(), 1, "The shared editor can add formatting without replacing the template body.");
  await page.getByLabel("Subject", { exact: true }).fill("{{contractor_name}} | {{compliance_type}} | {{registration_number}} | {{expiration_date}}");
  assert.equal(await page.getByRole("button", { name: "Send", exact: true }).isDisabled(), true);
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  const preview = page.getByRole("dialog", { name: "Email Preview" });
  await preview.waitFor();
  assert.equal(await preview.getByLabel("Rendered subject").innerText(), "Fixture Construction | NJ PWC | REG-123 | 2027-01-01");
  assert.equal(await preview.getByLabel("Rendered body").locator("strong").innerText(), "URGENT – WORK RESTRICTION");
  assert.equal(await preview.getByLabel("Rendered body").locator("em, i").count(), 1, "Preview retains formatting edited in the composer.");
  assert.equal(await preview.getByLabel("Rendered body").locator("b").innerText(), "Fixture Construction", "Bold merge tokens resolve");
  assert.match(await preview.innerText(), /Importance: high/i);
  assert.match(await preview.getByLabel("Rendered body").innerText(), /Effective immediately, Fixture Construction is not permitted.*NJ PWC.*Registration Number: REG-123.*Expiration Date: 2027-01-01/s);
  await screenshot("Email_Expired_PWC_Rich_Preview");
  assert.equal(sent.length, 0); assert.equal(drafts.size, 0); assert.equal(plans.length, 0);
  assert.ok(writes.every(w => w.path === "/api/communications/email-assessment"), "Preview uses only the read-only assessment, never save/send/schedule");
  await preview.getByRole("button", { name: "Close Preview" }).click();
  await page.getByRole("button", { name: "Remove compliance context" }).click();
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "Expiration Date could not be resolved" }).waitFor();
  assert.equal(await page.getByRole("dialog", { name: "Email Preview" }).count(), 0, "Changed context cannot show a stale preview");
  assert.equal(sent.length, 0); assert.equal(drafts.size, 0);
  providerReady = true;
  await fresh();
  await recipient("Alice Internal"); await message("Single direct send");
  await page.getByLabel("Template", { exact: true }).selectOption(template.id);
  await message("Single direct send");
  await page.getByLabel("Importance", { exact: true }).selectOption("normal");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "Sent." }).waitFor();
  assert.equal(sent.length, 1); assert.equal(await page.getByRole("dialog").count(), 0);
  assert.equal(sent[0].importance, "normal", "Template High + reviewed Normal snapshots Normal");
  assert.equal(writes.filter(w => w.path === "/api/communications").length, 1);
  template.default_importance = "normal";
  await fresh();
  await recipient("Alice Internal"); await recipient("Chris Contractor", "Cc"); await recipient("Dana Disabled", "Bcc");
  await page.getByLabel("Template", { exact: true }).selectOption(template.id);
  assert.equal(await page.getByLabel("Importance", { exact: true }).inputValue(), "normal");
  await page.getByLabel("Importance", { exact: true }).selectOption("high");
  await message("Mixed-recipient review");
  await page.getByLabel("Message Body", { exact: true }).selectText();
  await page.getByRole("button", { name: "Clear formatting", exact: true }).click();
  await page.getByLabel("Message Body", { exact: true }).selectText();
  await page.getByRole("button", { name: "Bold", exact: true }).click();
  assert.equal(await page.getByLabel("Message Body", { exact: true }).locator("strong,b").count(), 1);
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
  assert.equal(sent[1].importance, "high", "Template Normal + reviewed High snapshots High");
  assert.match(sent[1].body, /<(strong|b)>Synthetic message/);
  template.default_importance = "high";
  assert.deepEqual(sent[1].recipients.map(r => r.recipient_role), ["to", "cc"]);
  await fresh();
  await recipient("Alice Internal"); await recipient("Chris Contractor", "Cc");
  await page.getByLabel("Template", { exact: true }).selectOption(template.id);
  await page.getByLabel("Subject", { exact: true }).fill("Expired PWC Notice");
  assert.match(await page.getByLabel("Message Body", { exact: true }).innerHTML(), /<strong>URGENT – WORK RESTRICTION<\/strong>/);
  await page.getByLabel("Message Body", { exact: true }).fill("Draft with preserved formatting.");
  await page.getByLabel("Importance", { exact: true }).selectOption("low");
  const messageFollowupCheckbox = page.getByRole("checkbox", { name: "Create Follow-Up after successful send", exact: true });
  assert.equal(await messageFollowupCheckbox.isChecked(), false);
  await messageFollowupCheckbox.check();
  await page.getByLabel("Follow-Up Subject", { exact: true }).fill("User-reviewed project follow-up");
  await page.getByLabel("Follow-Up Status", { exact: true }).selectOption("Waiting Response");
  await page.getByLabel("Follow-Up delay in days", { exact: true }).fill("17");
  await page.getByRole("button", { name: "+ Add project, contractor or compliance item", exact: true }).click();
  await related.getByRole("checkbox", { name: "24-002 - NJSDA Garfield ES", exact: true }).check();
  await related.getByRole("checkbox", { name: "Fixture Construction", exact: true }).check();
  await related.getByRole("button", { name: "Apply", exact: true }).click();
  await page.getByRole("button", { name: "Save Draft", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "Draft saved." }).waitFor();
  assert.equal(sent.length, 2);
  const saved = [...drafts.values()].at(-1);
  assert.equal(saved.importance, "low");
  assert.equal(saved.followup.enabled, true);
  assert.equal(saved.followup.delay_days, 17);
  assert.deepEqual(saved.project_ids, [18]); assert.equal(saved.template_id, template.id);
  const rolesAndEmails = rs => rs.map(({ email, recipient_role }) => ({ email, recipient_role }));
  const savedPair = [
    { email: internal.email, recipient_role: "to" }, { email: contractor.email, recipient_role: "cc" },
  ];
  assert.deepEqual(rolesAndEmails(saved.recipients), savedPair);
  await page.getByRole("tab", { name: "Drafts", exact: true }).click();
  await page.getByRole("button", { name: "Expired PWC Notice", exact: true }).click();
  let releaseDraftRead;
  const draftRequested = new Promise(resolve => { draftReadStarted = resolve; });
  draftReadGate = new Promise(resolve => { releaseDraftRead = resolve; });
  await page.getByRole("button", { name: "Edit draft", exact: true }).first().click();
  await page.getByRole("heading", { name: "Edit draft", exact: true }).waitFor();
  await draftRequested;
  assert.equal(await page.getByRole("button", { name: "Remove Chris Contractor from cc", exact: true }).count(), 0,
    "The heading renders before the deliberately held draft response; it is not a hydration-ready signal.");
  releaseDraftRead(); draftReadGate = null; draftReadStarted = null;
  await page.getByRole("button", { name: "Remove Chris Contractor from cc", exact: true }).waitFor();
  assert.equal(await page.getByLabel("Importance", { exact: true }).inputValue(), "low", "Draft restores reviewed value instead of template default");
  assert.equal(await messageFollowupCheckbox.isChecked(), true, "Reopening restores the reviewed override, not template OFF");
  assert.equal(await page.getByLabel("Follow-Up Subject", { exact: true }).inputValue(), "User-reviewed project follow-up");
  assert.equal(await page.getByLabel("Follow-Up Status", { exact: true }).inputValue(), "Waiting Response");
  assert.equal(await page.getByLabel("Follow-Up delay in days", { exact: true }).inputValue(), "17");
  assert.deepEqual(rolesAndEmails(draftReads.at(-1).draft.recipients), savedPair);
  assert.equal(await page.getByRole("button", { name: "Remove Alice Internal from to", exact: true }).count(), 1);
  assert.equal(await page.getByRole("button", { name: "Remove Chris Contractor from cc", exact: true }).count(), 1);
  await recipient("Bea Internal", "Bcc");
  await page.getByRole("button", { name: "Save Draft", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "Draft saved." }).waitFor();
  assert.deepEqual(saved.recipients.map(r => r.recipient_role), ["to", "cc", "bcc"]);
  const expectedThree = [...savedPair, { email: bccContact.email, recipient_role: "bcc" }];
  const draftCount = drafts.size;
  async function reopenRecipients(expected) {
    await page.getByRole("tab", { name: "Drafts", exact: true }).click();
    const row = page.getByRole("row").filter({ has: page.getByRole("button", { name: "Expired PWC Notice", exact: true }) });
    await row.getByRole("button", { name: "Edit draft", exact: true }).click();
    for (const r of expected) {
      const contact = [internal, contractor, bccContact].find(c => c.email === r.email);
      await page.getByRole("button", { name: `Remove ${contact.recipient_name} from ${r.recipient_role}`, exact: true }).waitFor();
    }
    assert.deepEqual(rolesAndEmails(draftReads.at(-1).draft.recipients), expected);
    assert.equal(await page.getByRole("button", { name: /^Remove .* from (to|cc|bcc)$/ }).count(), expected.length);
    assert.equal(drafts.size, draftCount);
  }
  await reopenRecipients(expectedThree);
  await recipient("Alice Internal", "Bcc");
  await page.getByRole("alert").filter({ hasText: "already selected in To, Cc or Bcc" }).waitFor();
  assert.equal(await page.getByRole("button", { name: /^Remove .* from (to|cc|bcc)$/ }).count(), 3);
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.getByRole("button", { name: "Remove Chris Contractor from cc", exact: true }).click();
  await recipient("Chris Contractor", "Bcc");
  await page.getByRole("button", { name: "Remove Bea Internal from bcc", exact: true }).click();
  await recipient("Bea Internal", "To");
  await page.getByRole("button", { name: "Remove Alice Internal from to", exact: true }).click();
  await recipient("Alice Internal", "Cc");
  await page.getByRole("button", { name: "Save Draft", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "Draft saved." }).waitFor();
  const movedRoles = [
    { email: contractor.email, recipient_role: "bcc" }, { email: bccContact.email, recipient_role: "to" },
    { email: internal.email, recipient_role: "cc" },
  ];
  assert.deepEqual(rolesAndEmails(saved.recipients), movedRoles);
  await reopenRecipients(movedRoles);
  for (const [contact, from, to] of [[internal, "cc", "To"], [contractor, "bcc", "Cc"], [bccContact, "to", "Bcc"]]) {
    await page.getByRole("button", { name: `Remove ${contact.recipient_name} from ${from}`, exact: true }).click();
    await recipient(contact.recipient_name, to);
  }
  await page.getByRole("button", { name: "Save Draft", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "Draft saved." }).waitFor();
  assert.deepEqual(rolesAndEmails(saved.recipients), expectedThree);
  await reopenRecipients(expectedThree);
  await page.getByRole("button", { name: "Schedule", exact: true }).click();
  const schedule = page.getByRole("dialog");
  assert.match(await schedule.innerText(), /delivered when due.*current Email Settings and recipient eligibility/s);
  await schedule.getByLabel("Date", { exact: true }).fill("2099-01-02"); await schedule.getByLabel("Time", { exact: true }).fill("10:30");
  await schedule.getByLabel("Time zone", { exact: true }).selectOption("UTC");
  await screenshot("Email_Schedule_Fixture");
  await schedule.getByRole("button", { name: "Schedule", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "Scheduled for" }).waitFor();
  assert.equal(plans.length, 1); assert.equal(sent.length, 2);
  assert.equal(plans[0].scheduled_at, "2099-01-02T10:30:00.000Z");
  assert.deepEqual(plans[0].recipients.map(r => r.recipient_role), ["to", "cc", "bcc"]);
  template.default_importance = "normal"; template.revision++;
  assert.equal(plans[0].importance, "low", "Scheduled snapshot is independent of later template edits");
  await page.getByRole("tab", { name: "Scheduled", exact: true }).click();
  await page.getByRole("button", { name: "Expired PWC Notice", exact: true }).click();
  await page.getByRole("article", { name: "Message details" }).getByText(/Bcc:.*Bea Internal/).waitFor();
  await page.getByRole("article", { name: "Message details" }).getByText("Importance: Low", { exact: true }).waitFor();
  assert.match(await page.getByRole("article", { name: "Message details" }).innerText(), /Bcc:.*Bea Internal/);
  await screenshot("Email_Scheduled_Fixture");
  await page.getByRole("button", { name: "Cancel scheduled plan", exact: true }).click();
  await page.getByText("No scheduled messages.", { exact: true }).waitFor();
  await page.getByRole("tab", { name: "Sent", exact: true }).click();
  await page.getByRole("button", { name: "Mixed-recipient review", exact: true }).waitFor();
  await screenshot("Email_Sent_Fixture");
  followupRecoveryId = sent.find(d => d.subject === "Mixed-recipient review").id;
  await page.getByRole("button", { name: "Mixed-recipient review", exact: true }).click();
  await page.getByRole("article", { name: "Message details" }).getByText("Importance: High", { exact: true }).waitFor();
  assert.equal(await page.getByRole("article", { name: "Message details" }).locator("strong,b").filter({ hasText: "Synthetic message" }).count(), 1, "Sent details retain rich formatting");
  const actionPanel = page.getByLabel("Post-send Follow-Up", { exact: true });
  await actionPanel.getByText("Follow-Up: recoverable", { exact: true }).waitFor();
  await actionPanel.getByRole("alert").filter({ hasText: "email remains Sent" }).waitFor();
  const sentBeforeRecovery = sent.length;
  await actionPanel.getByRole("button", { name: "Retry Follow-Up only (no email)", exact: true }).click();
  await actionPanel.getByText("Follow-Up: completed · #501", { exact: true }).waitFor();
  assert.equal(await actionPanel.getByRole("button").count(), 0, "Completed action cannot be retried from history");
  assert.deepEqual(followupRetries, [followupRecoveryId]);
  assert.equal(sent.length, sentBeforeRecovery, "History recovery never sends another email");
  await page.getByRole("button", { name: "Close details", exact: true }).click();
  await page.getByRole("tab", { name: "Templates", exact: true }).click();
  await page.getByRole("heading", { name: "Communication Templates", exact: true }).waitFor();
  const templatesPanel = page.getByRole("region", { name: "Communication templates", exact: true });
  await templatesPanel.getByRole("button", { name: "Edit", exact: true }).click();
  const templateEditor = page.getByRole("form", { name: "Template editor" });
  const subjectEditor = templateEditor.getByLabel("Template Subject", { exact: true });
  await subjectEditor.fill("Notice: company end");
  await subjectEditor.evaluate(element => { element.focus(); element.setSelectionRange(8, 15); });
  await templateEditor.getByLabel("Insert field into template subject").selectOption("contractor_name");
  assert.equal(await subjectEditor.inputValue(), "Notice: {{contractor_name}} end", "Subject insertion replaces the selected range");
  const bodyEditor = templateEditor.getByLabel("Template Body", { exact: true });
  await bodyEditor.getByText("URGENT – WORK RESTRICTION", { exact: true }).waitFor();
  await bodyEditor.fill("Hello ");
  assert.equal((await bodyEditor.innerText()).replace(/\u00a0/g, " "), "Hello ");
  await bodyEditor.press("Control+End");
  for (const field of ["contractor_name", "compliance_type", "registration_number", "expiration_date"]) {
    await templateEditor.getByLabel("Insert field into Template Body").selectOption(field);
  }
  assert.match(await bodyEditor.innerText(), /Hello \{\{contractor_name\}\}\{\{compliance_type\}\}\{\{registration_number\}\}\{\{expiration_date\}\}/);
  assert.equal(await templateEditor.getByLabel("Insert field into Template Body").getByRole("option", { name: "Contact First Name", exact: true }).count(), 0);
  await templateEditor.getByRole("button", { name: "Cancel", exact: true }).click();
  Object.assign(template, { purpose: "Future custom stage", default_importance: "high", followup_enabled: true,
    followup_status: "Waiting Response", followup_delay_days: 60, followup_subject: "Review {{contractor_name}}",
    followup_related_item: "contractor",
    body: '<p><strong>{{contractor_name}}</strong> <em>renewal</em> <u>required</u></p><ul><li>{{registration_number}}</li></ul><ol><li>{{expiration_date}}</li></ol><p><a href="https://example.invalid/renew">Renew</a></p>' });
  await templatesPanel.getByRole("button", { name: "Reload Templates", exact: true }).click();
  const sourceBeforeCopy = structuredClone(template), messagesBeforeCopy = structuredClone([...drafts.values()]);
  const copyWritesStart = writes.length;
  await templatesPanel.getByRole("button", { name: "Duplicate", exact: true }).click();
  assert.equal(writes.length, copyWritesStart, "Duplicate opens locally without any mutation");
  assert.equal(await templateEditor.getByLabel("Template Name", { exact: true }).inputValue(), `${template.name} - Copy`);
  assert.equal(await templateEditor.getByLabel("Template Subject", { exact: true }).inputValue(), template.subject);
  assert.equal(await templateEditor.getByLabel("Template Body", { exact: true }).evaluate(e => e.innerHTML), template.body, "Rich HTML and merge tokens are preserved exactly");
  assert.equal(await templateEditor.getByRole("combobox", { name: "Default Importance", exact: true }).inputValue(), "high");
  assert.equal(await templateEditor.getByLabel("Reminder Stage / Purpose", { exact: true }).inputValue(), template.purpose);
  assert.equal(await templateEditor.getByRole("combobox", { name: "Follow-Up Status", exact: true }).inputValue(), "Waiting Response");
  assert.equal(await templateEditor.getByRole("spinbutton", { name: "Follow-Up delay in days", exact: true }).inputValue(), "60");
  assert.equal(await templateEditor.getByRole("textbox", { name: "Follow-Up Subject", exact: true }).inputValue(), template.followup_subject);
  assert.equal(await templateEditor.getByRole("checkbox", { name: "Active", exact: true }).isChecked(), false);
  await screenshot("Email_Duplicate_Template_Editor");
  await templateEditor.getByLabel("Template Name", { exact: true }).fill("60-Day Compliance Expiration Notice");
  await templateEditor.getByRole("button", { name: "Save Template", exact: true }).click();
  await templatesPanel.getByRole("listitem").filter({ hasText: "60-Day Compliance Expiration Notice" }).waitFor();
  assert.equal(templateCopies.length, 1);
  const copy = templateCopies[0];
  assert.notEqual(copy.id, template.id); assert.equal(copy.revision, 1); assert.equal(copy.is_active, false);
  for (const key of ["category", "channel", "subject", "body", "default_importance", "purpose", "followup_enabled",
    "followup_status", "followup_delay_days", "followup_subject", "followup_related_item"]) assert.equal(copy[key], template[key], `Saved copy preserves ${key}`);
  await templatesPanel.getByRole("listitem").filter({ hasText: "60-Day Compliance Expiration Notice" }).getByRole("button", { name: "Edit", exact: true }).click();
  await templateEditor.getByLabel("Template Subject", { exact: true }).fill("60-Day revised {{contractor_name}}");
  await templateEditor.getByRole("button", { name: "Save Template", exact: true }).click();
  await page.getByText("Template saved. No messages were generated.", { exact: true }).waitFor();
  assert.equal(copy.subject, "60-Day revised {{contractor_name}}");
  assert.deepEqual(template, sourceBeforeCopy);
  assert.deepEqual([...drafts.values()], messagesBeforeCopy, "Existing Sent/Scheduled snapshots remain unchanged");
  assert.ok(writes.slice(copyWritesStart).every(w => w.path === "/api/admin/communication-templates" || w.path === `/api/admin/communication-templates/${copy.id}`),
    "No notification assignment, approval, activation or email execution");
  await templatesPanel.getByRole("listitem").filter({ hasText: "60-Day Compliance Expiration Notice" }).getByRole("button", { name: "Duplicate", exact: true }).click();
  await templateEditor.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(templateCopies.length, 1, "Cancelling a duplicate persists nothing");
  await page.getByRole("tab", { name: "Contacts", exact: true }).click();
  await page.getByLabel("Contact source", { exact: true }).selectOption("contractor");
  await page.getByRole("link", { name: "open the existing Contractor directory" }).waitFor();
  await page.getByRole("tab", { name: "Settings", exact: true }).click();
  await page.getByLabel("Contractor Email Enabled", { exact: true }).waitFor();
  await page.getByLabel("Dobco Internal Email Enabled", { exact: true }).waitFor();
  await screenshot("Email_Settings_Fixture");
  await page.getByText("Scheduled delivery processing", { exact: true }).click();
  await page.getByLabel("Batch size (1-5)", { exact: true }).fill("2");
  const savedPolicy = page.waitForResponse(response => response.url().endsWith("/api/admin/scheduled-email") && response.request().method() === "PATCH");
  await page.getByRole("button", { name: "Save Worker Settings", exact: true }).click();
  await savedPolicy;
  await page.getByRole("button", { name: "Save Worker Settings", exact: true }).waitFor();
  assert.equal(workerPolicy.batch_size, 2);
  scheduling.automatic_delivery_enabled = false;
  scheduling.notice = "Automatic Delivery is disabled in Email Settings. Messages remain Scheduled.";
  await fresh(); await recipient("Alice Internal"); await message("Paused scheduled fixture");
  await page.getByRole("button", { name: "Schedule", exact: true }).click();
  assert.match(await page.getByRole("dialog").innerText(), /Automatic Delivery is disabled/);
  await page.getByRole("dialog").getByLabel("Date", { exact: true }).fill("2099-01-02");
  await page.getByRole("dialog").getByLabel("Time", { exact: true }).fill("10:30");
  await page.getByRole("dialog").getByRole("button", { name: "Schedule", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "Automatic Delivery is disabled" }).waitFor();
  assert.equal(sent.length, 2);
  await page.getByRole("tab", { name: "Scheduled", exact: true }).click();
  await page.getByRole("button", { name: "Paused scheduled fixture", exact: true }).click();
  await page.getByRole("article", { name: "Message details" }).getByRole("status").filter({ hasText: "Message remains Scheduled." }).waitFor();
  await page.getByRole("button", { name: "Cancel scheduled plan", exact: true }).click();
  await page.getByText("No scheduled messages.", { exact: true }).waitFor();
  scheduling.execution_enabled = false; scheduling.available = false;
  scheduling.notice = "Automatic delivery is not available; the scheduled delivery migration is pending. This message will not send itself.";
  await fresh();
  await page.getByRole("button", { name: "Schedule", exact: true }).click();
  assert.match(await page.getByRole("dialog").innerText(), /migration is pending.*will not send itself/);
  await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
  scheduling.available = true; scheduling.execution_enabled = true; scheduling.automatic_delivery_enabled = true;
  scheduling.notice = "Scheduled messages are delivered when due, subject to current Email Settings and recipient eligibility.";
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
  pending = false;
  await fresh();
  await recipient("Alice Internal"); await recipient("Chris Contractor", "Cc"); await recipient("Bea Internal", "Bcc");
  assert.equal(await page.getByRole("button", { name: "Remove contractor Fixture Construction", exact: true }).count(), 0,
    "Cc contractor does not implicitly change Related To");
  await page.getByLabel("Template", { exact: true }).selectOption(template.id);
  await page.getByRole("button", { name: "+ Add project, contractor or compliance item", exact: true }).click();
  await related.getByRole("checkbox", { name: "Fixture Construction", exact: true }).check();
  await related.getByRole("checkbox", { name: "24-002 - NJSDA Garfield ES", exact: true }).check();
  await related.getByLabel("Related compliance record", { exact: true }).selectOption("7");
  await screenshot("Email_Related_To_Combined_Selectors");
  await related.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "Remove contractor Fixture Construction", exact: true }).count(), 0,
    "Picker cancellation does not apply staged selections");
  await page.getByRole("button", { name: "+ Add project, contractor or compliance item", exact: true }).click();
  await related.getByRole("checkbox", { name: "Fixture Construction", exact: true }).check();
  await related.getByRole("checkbox", { name: "24-002 - NJSDA Garfield ES", exact: true }).check();
  await related.getByLabel("Related compliance record", { exact: true }).selectOption("7");
  await related.getByRole("button", { name: "Apply", exact: true }).click();
  await page.getByLabel("Subject", { exact: true }).fill("{{contact_name}} | {{contractor_name}} | {{project_number}} | {{registration_number}}");
  await page.getByLabel("Message Body", { exact: true }).fill("{{contact_email}} | {{project_name}} | {{compliance_type}} | {{registration_number}}");
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await preview.waitFor();
  const mixedSubject = await preview.getByLabel("Rendered subject").innerText();
  const mixedBody = await preview.getByLabel("Rendered body").locator(":scope > div").innerText();
  const mixedHtml = await preview.getByLabel("Rendered body").locator(":scope > div").innerHTML();
  assert.equal(mixedSubject, "Alice Internal | Fixture Construction | 24-002 | REG-123");
  assert.equal(mixedBody, "alice@example.invalid | NJSDA Garfield ES | NJ PWC | REG-123");
  await screenshot("Email_To_Context_Mixed_Recipients_Preview");
  await preview.getByRole("button", { name: "Close Preview" }).click();
  await page.getByRole("button", { name: "Remove Chris Contractor from cc", exact: true }).click();
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await preview.waitFor();
  assert.equal(await preview.getByLabel("Rendered subject").innerText(), mixedSubject);
  assert.equal(await preview.getByLabel("Rendered body").locator(":scope > div").innerText(), mixedBody, "Removing Cc never changes merge context");
  await preview.getByRole("button", { name: "Close Preview" }).click();
  await recipient("Chris Contractor", "Cc");
  const mixedSentBefore = sent.length;
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Send to 3", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "Sent." }).waitFor();
  assert.equal(sent.length, mixedSentBefore + 1);
  assert.equal(sent.at(-1).subject, mixedSubject);
  assert.equal(sent.at(-1).body, mixedHtml, "Send preserves the same fully merged rich HTML shown in Preview");
  assert.deepEqual(sent.at(-1).contractor_ids, [1]);
  assert.deepEqual(sent.at(-1).project_ids, [18]);
  assert.deepEqual(sent.at(-1).compliance_record_ids, [7]);
  assert.deepEqual(sent.at(-1).recipients.map(r => r.recipient_role), ["to", "bcc", "cc"]);
  await fresh();
  await recipient("Chris Contractor");
  await page.getByRole("button", { name: "Remove contractor Fixture Construction", exact: true }).waitFor();
  await page.getByRole("button", { name: "+ Add project, contractor or compliance item", exact: true }).click();
  assert.equal(await related.getByRole("checkbox", { name: "Fixture Construction", exact: true }).isChecked(), true,
    "A To contractor contact's company is preselected Related To context");
  const toCompliance = related.getByLabel("Related compliance record", { exact: true });
  await toCompliance.locator("option[value='7']").waitFor({ state: "attached" });
  assert.equal(await toCompliance.isDisabled(), false, "Compliance selection is immediately available for the To contractor");
  await toCompliance.selectOption("7");
  await related.getByRole("button", { name: "Apply", exact: true }).click();
  await page.getByLabel("Subject", { exact: true }).fill("90-Day Notice – {{compliance_type}} – {{contractor_name}}");
  await page.getByLabel("Message Body", { exact: true }).fill("Hello {{contact_name}} | {{registration_number}} | {{expiration_date}}");
  const writesBeforeFourFields = writes.length;
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await preview.waitFor();
  assert.equal(await preview.getByLabel("Rendered subject").innerText(), "90-Day Notice – NJ PWC – Fixture Construction");
  assert.equal(await preview.getByLabel("Rendered body").locator(":scope > div").innerText(), "Hello Chris Contractor | REG-123 | 2027-01-01");
  assert.ok(writes.slice(writesBeforeFourFields).every(w => w.path === "/api/communications/email-assessment"), "Four-field Preview is read-only");
  await preview.getByRole("button", { name: "Close Preview" }).click();
  await recipient("Bea Internal", "Cc");
  assert.equal(await page.getByRole("button", { name: "Remove contractor Fixture Construction", exact: true }).count(), 1,
    "Cc additions leave Related To unchanged");
  grants = ["settings"];
  await page.goto(`${app}/email-communications`);
  await page.getByRole("heading", { name: "Email Communications", exact: true }).waitFor();
  assert.equal(await page.getByRole("textbox", { name: "Message", exact: true }).count(), 0);
  assert.deepEqual(errors, []);
  console.log("PASS: Unified Style 3 Email workspace; direct single send, exactly one multi-recipient confirmation with exclusions, independent optional draft save/reopen, real To/Cc/Bcc roles, templates/project associations, capability-aware UTC scheduling/cancellation, disabled automation/blocked reason/pending worker messaging, runtime policy edits, Sent/details and Follow-Up-only recovery without resending, master-control explanations, permissions, uncertain-save retry protection, pending-migration write block. All network/delivery mutations intercepted.");
} finally { await browser.close(); }
