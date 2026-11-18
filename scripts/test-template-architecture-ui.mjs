import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "../worker/nj-pwc/node_modules/playwright");
const app = process.env.TEST_APP_URL;
assert.ok(app && new URL(app).hostname === "localhost", "Intercepted localhost only");
const origin = new URL(fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8")
  .match(/^NEXT_PUBLIC_SUPABASE_URL\s*=\s*["']?([^"'\r\n]+)/m)[1].trim()).origin;
const uuid = n => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const user = { id: uuid(1), email: "fixture@example.invalid", aud: "authenticated", app_metadata: {}, user_metadata: {} };
// Read-only ABCO record values verified before this test; all configuration, recipients and writes below are isolated fixtures.
const company = { id: 14, company_name: "ABCO Electric LLC" };
const record = { contractor_id: 14, compliance_record_id: 10, compliance_name: "NJ PWC", registration_number: "708951",
  expiration_date: "2028-01-14", calculated_status: "Active", days_remaining: 423 };
let template = { id: uuid(50), name: "90-Day Compliance Expiration Notice", category: "Expiration Reminder", channel: "email",
  subject: "90-Day Compliance Notice – {{compliance_type}} – {{contractor_name}}",
  body: "Hello {{contractor_name}},\n\nCompany: {{contractor_name}}\nCompliance Type: {{compliance_type}}\nRegistration Number: {{registration_number}}\nExpiration Date: {{expiration_date}}\n\nRendering validation only: the selected record is not in the 90-day window.",
  is_active: true, revision: 1, purpose: "90 Day", followup_enabled: true, followup_status: "Open", followup_delay_days: 30,
  followup_subject: "Review {{compliance_type}} renewal – {{contractor_name}}", followup_related_item: "originating_compliance_record" };
const defaultOffTemplate = { ...template, id: uuid(51), name: "Ordinary Message", followup_enabled: false,
  subject: "Ordinary message", body: "A normal email without required compliance fields.", followup_subject: "Review {{contractor_name}}" };
const cache = new Map();
function load(file) {
  if (cache.has(file)) return cache.get(file);
  const output = { exports: {} }; cache.set(file, output.exports);
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    module: output, exports: output.exports, require(name) {
      if (name.startsWith("@/lib/")) return load(`src/lib/${name.slice(6)}.ts`);
      if (name.startsWith("@/types/")) return load(`types/${name.slice(8)}.ts`);
      assert.fail(name);
    },
  }, { filename: file });
  return output.exports;
}
const { renderMessage } = load("src/lib/communication-templates.ts");
const values = { contractor_name: company.company_name, compliance_type: record.compliance_name,
  registration_number: record.registration_number, expiration_date: record.expiration_date };
const recipient = { recipient_type: "contractor_contact", contractor_contact_id: uuid(11), dobco_contact_id: null,
  recipient_name: "Preview Fixture Contact", email: "preview@example.invalid", mobile_phone: null };
const drafts = new Map(), followups = new Map(), graph = [], errors = [];
let rejectGraph = false, assessments = 0;
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
  await context.addInitScript(({ origin, user }) => localStorage.setItem(`sb-${new URL(origin).hostname.split(".")[0]}-auth-token`,
    JSON.stringify({ access_token: "fixture-token", refresh_token: "fixture-refresh", expires_at: Math.floor(Date.now() / 1000) + 3600, user })), { origin, user });
  await context.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== new URL(app).origin) {
      assert.equal(url.origin, origin);
      assert.ok(url.pathname.startsWith("/auth/") && ["GET", "HEAD"].includes(request.method()), "No real database or Graph writes");
      return route.fulfill({ json: user });
    }
    if (!url.pathname.startsWith("/api/")) return route.continue();
    const input = request.method() !== "GET" ? request.postDataJSON() : null;
    if (url.pathname === "/api/admin/bootstrap") return route.fulfill({ json: {} });
    if (url.pathname === "/api/auth/session") return route.fulfill({ json: {
      profile: { auth_user_id: user.id, name: "LOCAL FIXTURE — NO REAL EMAIL", role: "Fixture", status: "Active", system_administrator: false },
      permissions: ["settings", "contractors", "projects", "compliance", "communications_content", "communications_summary", "communications_delivery"]
        .map(module => ({ module, can_view: true, can_add: true, can_edit: true, can_manage: true })),
    } });
    if (url.pathname === "/api/admin/communication-templates") return route.fulfill({ json: { templates: [template], next_offset: null } });
    if (url.pathname === `/api/admin/communication-templates/${template.id}`) {
      assert.equal(input.revision, template.revision);
      assert.equal(input.followup_enabled, true);
      assert.equal(input.purpose, "90 Day");
      assert.equal(input.followup_delay_days, 30);
      assert.equal(input.followup_related_item, "originating_compliance_record");
      assert.equal(input.followup_subject, "Review {{compliance_type}} renewal – {{contractor_name}}");
      template = { ...template, ...input, revision: template.revision + 1 };
      return route.fulfill({ json: { id: template.id, revision: template.revision } });
    }
    if (url.pathname === "/api/communications/compose-options") {
      const kind = url.searchParams.get("kind") ?? "configuration";
      if (kind === "configuration") return route.fulfill({ json: { email_controls: { available: true, enabled: true },
        channels: [{ channel: "email", manual_send_ready: true }], installation: {},
        scheduling: { available: true, execution_enabled: false, automatic_delivery_enabled: false, notice: "LOCAL FIXTURE: automatic reminders remain OFF" } } });
      return route.fulfill({ json: { rows: kind === "templates" ? [template, defaultOffTemplate] : kind === "compliance" ? [record] : kind === "contractors" ? [company] : [], next_offset: null } });
    }
    if (url.pathname === "/api/communications/email-recipients") return route.fulfill({ json: { rows: [{
      key: recipient.email, kind: "contact", label: recipient.recipient_name, detail: `LOCAL FIXTURE | ${company.company_name}`,
      recipient, contractor_id: company.id, company_name: company.company_name, exclusion_reason: null,
    }] } });
    if (url.pathname === "/api/communications/email-assessment") {
      assessments++;
      assert.deepEqual(input.contractor_ids, [14]);
      const subject = renderMessage(input.subject, values), body = renderMessage(input.body, values);
      assert.equal(subject.unresolved.length + body.unresolved.length, 0);
      return route.fulfill({ json: { draft: { ...input, subject: subject.text, body: body.text },
        exclusions: input.recipients.map(r => ({ email: r.email, recipient_role: r.recipient_role ?? "to", reason: null })),
        followup: input.followup.enabled ? { ...input.followup, subject: renderMessage(input.followup.subject, values).text,
          related_item: input.compliance_record_ids.length ? "originating_compliance_record" : "contractor",
          related_label: input.compliance_record_ids.length ? "NJ PWC / 708951" : company.company_name } : null } });
    }
    if (url.pathname === "/api/communications" && request.method() === "POST") {
      const id = uuid(100 + drafts.size);
      drafts.set(id, { ...input, id, revision: 1, status: "Draft" });
      return route.fulfill({ status: 201, json: { id, revision: 1, status: "Draft" } });
    }
    const plan = url.pathname.match(/^\/api\/communications\/([^/]+)\/plan$/);
    if (plan) {
      const draft = drafts.get(plan[1]);
      assert.equal(draft.status, "Draft");
      assert.equal(input.action, "schedule");
      Object.assign(draft, { status: "Scheduled", scheduled_at: input.scheduled_at });
      return route.fulfill({ json: { id: draft.id, status: "Scheduled", execution_enabled: false,
        scheduling: { notice: "LOCAL FIXTURE: automatic reminders remain OFF" } } });
    }
    const send = url.pathname.match(/^\/api\/communications\/([^/]+)\/send$/);
    if (send) {
      const draft = drafts.get(send[1]);
      if (draft.status !== "Draft") return route.fulfill({ status: 409, json: { error: "Already reserved or sent" } });
      graph.push(draft.id);
      if (rejectGraph) {
        draft.status = "Failed";
        return route.fulfill({ status: 502, json: { error: "MOCK Graph rejection. Communication Failed; 0 linked Follow-Ups. No real email sent." } });
      }
      draft.status = "Sent";
      if (draft.followup.enabled && !followups.has(draft.id)) followups.set(draft.id, {
        id: followups.size + 1, contractor_id: 14, compliance_record_id: draft.compliance_record_ids[0] ?? null });
      return route.fulfill({ json: { communication_id: draft.id, status: "Sent", graph_acceptance: "Accepted", delivered: false,
        followup: followups.has(draft.id) ? { state: "completed", followup_id: followups.get(draft.id).id } : { state: "not_configured" } } });
    }
    if (url.pathname === "/api/communications/email-history") return route.fulfill({ json: { messages: [], next_offset: null } });
    assert.fail(`Unexpected API: ${request.method()} ${url.pathname}`);
  });
  const page = await context.newPage(); page.on("pageerror", error => errors.push(error.message));
  const screenshot = async name => {
    if (process.env.TEST_SCREENSHOT_DIR) await page.locator("main").screenshot({ path: path.join(process.env.TEST_SCREENSHOT_DIR, `${name}.png`), animations: "disabled" });
  };
  await page.goto(`${app}/email-communications`);
  await page.getByRole("tab", { name: "Templates", exact: true }).click();
  await page.getByRole("region", { name: "Communication templates", exact: true }).getByRole("button", { name: "Edit", exact: true }).click();
  const editor = page.getByRole("form", { name: "Template editor" });
  assert.equal(await editor.getByRole("checkbox", { name: "Default Create Follow-Up after successful send" }).isChecked(), true);
  assert.equal(await editor.getByLabel("Follow-Up Status", { exact: true }).inputValue(), "Open");
  assert.equal(await editor.getByLabel("Follow-Up delay in days", { exact: true }).inputValue(), "30");
  for (const target of ["subject", "body", "followup_subject"]) {
    assert.equal(await editor.getByLabel(`Insert field into template ${target}`).getByRole("option", { name: "Registration Number", exact: true }).count(), 1);
    assert.equal(await editor.getByLabel(`Insert field into template ${target}`).getByRole("option", { name: "Contact First Name", exact: true }).count(), 0);
  }
  await screenshot("template-editor-insert-fields-and-followup");
  await editor.getByRole("button", { name: "Save Template", exact: true }).click();
  await page.getByRole("status").filter({ hasText: /saved/i }).waitFor();
  await page.getByRole("tab", { name: "New Message", exact: true }).click();
  const followupCheckbox = page.getByRole("checkbox", { name: "Create Follow-Up after successful send", exact: true });
  assert.equal(await followupCheckbox.isChecked(), false, "No template starts OFF");
  async function addRecipient() {
    await page.getByRole("combobox", { name: "To recipient search", exact: true }).fill("Preview");
    await page.getByRole("button", { name: /Preview Fixture Contact LOCAL FIXTURE/ }).click();
  }
  async function compose() {
    await page.getByLabel("Template", { exact: true }).selectOption(template.id);
    assert.equal(await followupCheckbox.isChecked(), true, "Template default ON populates an editable message choice");
    await addRecipient();
    await page.getByRole("button", { name: "+ Add project, contractor or compliance item", exact: true }).click();
    await page.getByLabel("Relationship type").selectOption("compliance");
    await page.getByRole("button", { name: "Find", exact: true }).click();
    await page.getByRole("button", { name: "NJ PWC | Active", exact: true }).click();
  }
  await compose();
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  const preview = page.getByRole("dialog", { name: "Email Preview" });
  await preview.waitFor();
  assert.equal(await preview.getByLabel("Rendered subject").innerText(), "90-Day Compliance Notice – NJ PWC – ABCO Electric LLC");
  for (const value of Object.values(values)) assert.ok((await preview.getByLabel("Rendered body").innerText()).includes(value));
  for (const text of ["Create Follow-Up: Yes", "Status: Open", "Timing: 30 days after successful send", "Related Compliance Record: NJ PWC / 708951"]) {
    assert.ok((await preview.getByLabel("Configured Follow-Up preview").innerText()).includes(text));
  }
  assert.match(await preview.getByLabel("Configured Follow-Up preview").innerText(), /Review NJ PWC renewal – ABCO Electric LLC/);
  assert.equal(graph.length, 0); assert.equal(followups.size, 0); assert.equal(drafts.size, 0);
  if (process.env.TEST_SCREENSHOT_DIR) await preview.screenshot({ path: path.join(process.env.TEST_SCREENSHOT_DIR, "abco-rendered-preview-with-followup.png"), animations: "disabled" });
  await preview.getByRole("button", { name: "Close Preview" }).click();
  await page.getByLabel("Subject", { exact: true }).fill(renderMessage(template.subject, values).text);
  await page.getByLabel("Message", { exact: true }).fill(renderMessage(template.body, values).text);
  await page.getByLabel("Message", { exact: true }).blur();
  await screenshot("new-message-followup-rendered-compliance");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "Linked Follow-Up #1 created" }).waitFor();
  assert.equal(graph.length, 1); assert.equal(followups.size, 1);
  await screenshot("mock-accepted-one-linked-followup");
  const id = [...drafts.keys()][0];
  const duplicate = await page.evaluate(async id => {
    const response = await fetch(`/api/communications/${id}/send`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmed: true, revision: 1 }) });
    return response.status;
  }, id);
  assert.equal(duplicate, 409); assert.equal(graph.length, 1); assert.equal(followups.size, 1);
  assert.equal(await page.getByRole("button", { name: "Send", exact: true }).isDisabled(), true);
  await page.reload(); await compose();
  rejectGraph = true;
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "MOCK Graph rejection" }).waitFor();
  assert.equal(graph.length, 2); assert.equal(followups.size, 1, "Failed communication adds no Follow-Up");
  await screenshot("mock-failed-no-followup");
  rejectGraph = false;
  for (const scenario of [
    { name: "No template OFF", template: "", checked: false, initial: false },
    { name: "No template ON", template: "", checked: true, initial: false },
    { name: "Template ON overridden OFF", template: template.id, checked: false, initial: true },
    { name: "Template OFF overridden ON", template: defaultOffTemplate.id, checked: true, initial: false },
  ]) {
    await page.reload();
    await page.getByLabel("Template", { exact: true }).selectOption(scenario.template);
    assert.equal(await followupCheckbox.isChecked(), scenario.initial, scenario.name);
    await followupCheckbox.setChecked(scenario.checked);
    if (scenario.checked) await page.getByLabel("Follow-Up Subject", { exact: true }).fill("Review {{contractor_name}}");
    await addRecipient();
    await page.getByLabel("Subject", { exact: true }).fill(scenario.name);
    await page.getByLabel("Message", { exact: true }).fill("Hello {{contractor_name}}, this is a local fixture.");
    const beforeGraph = graph.length, beforeFollowups = followups.size;
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "Sent." }).waitFor();
    assert.equal(graph.length, beforeGraph + 1);
    assert.equal(followups.size, beforeFollowups + Number(scenario.checked), scenario.name);
    const saved = [...drafts.values()].at(-1);
    assert.equal(saved.followup.enabled, scenario.checked, "Final per-message decision is sent to persistence");
  }
  for (const scenario of [{ enabled: false, template: template.id }, { enabled: true, template: template.id }, { enabled: true, template: "" }]) {
    const { enabled } = scenario;
    await page.reload();
    await page.getByLabel("Template", { exact: true }).selectOption(scenario.template);
    await followupCheckbox.setChecked(enabled);
    if (enabled) {
      await page.getByLabel("Follow-Up timing", { exact: true }).selectOption("specific_date");
      await page.getByLabel("Follow-Up date", { exact: true }).fill("2030-04-15");
      await page.getByLabel("Follow-Up Subject", { exact: true }).fill("User-reviewed scheduled Follow-Up");
    }
    await addRecipient();
    await page.getByLabel("Subject", { exact: true }).fill(`Scheduled choice ${enabled}`);
    await page.getByLabel("Message", { exact: true }).fill("Reviewed local schedule.");
    const beforeGraph = graph.length, beforeFollowups = followups.size;
    await page.getByRole("button", { name: "Schedule", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Date", { exact: true }).fill("2099-01-01");
    await dialog.getByLabel("Time", { exact: true }).fill("10:00");
    await dialog.getByRole("button", { name: "Schedule", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "Scheduled for" }).waitFor();
    const scheduled = [...drafts.values()].at(-1);
    assert.equal(scheduled.followup.enabled, enabled);
    if (enabled) assert.equal(scheduled.followup.date, "2030-04-15");
    assert.equal(graph.length, beforeGraph); assert.equal(followups.size, beforeFollowups);
  }
  assert.ok(assessments >= 3);
  assert.deepEqual(errors, []);
  console.log("PASS: visible per-message Follow-Up before Message; no-template OFF/ON; template default OFF/ON; user overrides both directions; fixed-date/relative controls; scheduled final OFF/ON payloads; template defaults label/Insert Field; rendered ABCO screenshot/Preview; mock acceptance one, rejection none, replay no duplicate. Every API/provider mutation intercepted. Automatic reminders OFF.");
} finally { await browser.close(); }
