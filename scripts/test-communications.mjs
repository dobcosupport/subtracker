import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const cache = new Map();
const credentialEnvironment = {};
const syntheticSecrets = new Map();
let vaultError = null, vaultReads = 0, vaultWrites = 0;
let oidcError = null, oidcCalls = 0;
const assertions = [];
class SyntheticClientAssertionCredential {
  constructor(tenantId, clientId, callback) { this.callback = callback; assertions.push({ tenantId, clientId }); }
  async getToken() { return { token: await this.callback(), expiresOnTimestamp: Date.now() + 60000 }; }
}
class SyntheticSecretClient {
  constructor(url, credential) { this.credential = credential; }
  async getSecret(name) {
    if (this.credential instanceof SyntheticClientAssertionCredential) await this.credential.getToken();
    vaultReads++;
    if (vaultError) throw vaultError;
    if (!syntheticSecrets.has(name)) throw { code: "SecretNotFound" };
    return { value: syntheticSecrets.get(name), properties: { enabled: true } };
  }
  async setSecret(name, value) {
    if (this.credential instanceof SyntheticClientAssertionCredential) await this.credential.getToken();
    vaultWrites++;
    if (vaultError) throw vaultError;
    syntheticSecrets.set(name, value);
    return { value, properties: { enabled: true } };
  }
}
const uuid = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const actor = { auth_user_id: uuid(1), role: "Synthetic", status: "Active", system_administrator: false, last_login: new Date().toISOString() };
let authenticated = true, dbError = null, auditError = false;
let grants = {}, rpcCalls = [], auditCalls = [], selectCalls = [];
let historyMessages = null, timelineFailure = false;
const queryCalls = [];
const activityRows = [], followupRows = [];
const contractorRows = [{ id: 1, company_name: "Synthetic One" }, { id: 2, company_name: "Synthetic Two" }];
const templateRows = [{ id: uuid(70), name: "Portable Template", category: "General Contractor Communication", channel: "email", subject: "Subject", body: "Hello {{contact_name}}", is_active: true, revision: 1 }];
const contactRows = [{ id: uuid(71), contractor_id: 1, contact_name: "Synthetic Contact", email: "contact@example.invalid", mobile_phone: "+15555550111",
  is_active: true, receives_compliance_email: true, receives_compliance_sms: true, receives_internal_email: true, receives_internal_sms: true, sms_consent_recorded: false,
  sms_consent_source_or_note: "Must not be projected", user_profile_id: uuid(999) }];
const channels = {
  email: { channel: "email", provider: null, enabled: false, automated_enabled: false, from_name: null, from_address: null, reply_to_address: null, sending_domain: null, sending_phone_number: null, incoming_enabled: false, two_way_enabled: false, revision: 1 },
  sms: { channel: "sms", provider: null, enabled: false, automated_enabled: false, from_name: null, from_address: null, reply_to_address: null, sending_domain: null, sending_phone_number: null, incoming_enabled: false, two_way_enabled: false, revision: 1 },
};
const invitationConfig = {
  enabled: true, delivery_mode: "supabase_auth", organization_name: null, application_name: null,
  subject: null, application_base_url: null, invitation_path: null, template_reference: null,
  template_content: null, sender_reference: null, reply_to_reference: null, revision: 1,
};
const reminderRows = [{ id: uuid(50), days_before_expiration: 45, email_enabled: false, sms_enabled: false, template_reference: null, revision: 1, created_at: "2026-10-18T12:00:00Z", updated_at: "2026-10-18T12:00:00Z" }];
const message = {
  id: uuid(10), channel: "email", direction: "outbound", source: "manual", status: "Draft", created_at: "2026-10-18T12:00:00Z",
  subject: "Restricted subject", body: "Restricted exact body\nwith whitespace",
  sender_name: "Synthetic Sender", sender_address: "sender@example.invalid", revision: 1,
  provider: "synthetic-provider", provider_message_id: "restricted-provider-id", failure_reason: "Restricted delivery failure",
  sent_at: null, delivered_at: null,
  communication_recipients: [{ id: uuid(11), recipient_type: "external", recipient_name: "Synthetic Recipient", email: "restricted@example.invalid", mobile_phone: "+15555550100", status: "Draft", provider_recipient_id: "restricted-recipient-id", failure_reason: "Restricted recipient failure" }],
  communication_contractors: [], communication_projects: [], communication_compliance_items: [], communication_mycoi_items: [], communication_insurance_items: [],
};
function columns(input) {
  const result = []; let level = 0, start = 0;
  for (let i = 0; i < input.length; i++) {
    if (input[i] === "(") level++;
    if (input[i] === ")") level--;
    if (input[i] === "," && level === 0) { result.push(input.slice(start, i)); start = i + 1; }
  }
  result.push(input.slice(start));
  return result.map((field) => field.trim());
}
function project(row, selection) {
  assert.ok(selection && !selection.includes("*"), "No wildcard reads of sensitive tables");
  return Object.fromEntries(columns(selection).map((field) => {
    const nested = field.match(/^([^()]+)\((.*)\)$/);
    if (nested) {
      const key = nested[1].split(":")[0];
      const relation = nested[1].includes(":") ? nested[1].split(":")[1].split("!")[0] : key;
      const values = row[key] ?? row[relation] ?? [];
      return [key, nested[2] === "count" ? [{ count: values.length }] : Array.isArray(values) ? values.map((value) => project(value, nested[2])) : project(values, nested[2])];
    }
    return [field, row[field] ?? null];
  }));
}
class Query {
  constructor(table) { this.table = table; this.filters = []; this.orders = []; this.bounds = [0, Infinity]; }
  select(selection) { this.selection = selection; selectCalls.push([this.table, selection]); return this; }
  eq(key, value) { assert.equal(this.ranged, undefined, "Filters must be applied before pagination"); this.filters.push([key, value]); return this; }
  neq(key, value) { this.notFilters ??= []; this.notFilters.push([key, value]); return this; }
  ilike(key, value) { this.search = [key, value]; return this; }
  order(key, options) { this.orders.push([key, options?.ascending !== false]); return this; }
  range(from, to) { this.ranged = true; this.bounds = [from, to]; return this; }
  maybeSingle() { return Promise.resolve(this.execute(true)); }
  single() { return Promise.resolve(this.execute(true)); }
  then(resolve, reject) { return Promise.resolve(this.execute(false)).then(resolve, reject); }
  upsert(rows) { this.rows = rows; return this; }
  insert(rows) { this.inserted = rows; return this; }
  execute(single) {
    queryCalls.push({ table: this.table, selection: this.selection, filters: this.filters, bounds: this.bounds });
    if (dbError && this.table.startsWith("communication_")) return { data: null, error: dbError };
    if (dbError && this.table === "notification_reminder_rules") return { data: null, error: dbError };
    if (timelineFailure && this.table === "contractor_followups") return { error: { message: "Synthetic follow-up read failure" }, data: null };
    if (this.rows) { assert.equal(this.table, "role_permissions"); savedPermissions = this.rows; return { error: null }; }
    if (this.inserted) {
      if (this.table === "role_permissions") savedPermissions = this.inserted;
      else assert.equal(this.table, "app_roles");
      return { error: null };
    }
    const permission = Object.fromEntries(["view", "add", "edit", "delete", "manage"].map((action) => [`can_${action}`, Boolean(grants[`${this.filters.find(([key]) => key === "module")?.[1]}:${action}`])]));
    let rows = this.table === "user_profiles" ? [actor]
      : this.table === "role_permissions" ? [permission]
      : this.table === "communication_messages" ? historyMessages ?? [message]
      : this.table === "activity_log" ? activityRows
      : this.table === "contractor_followups" ? followupRows
      : this.table === "contractors" ? contractorRows
      : this.table === "communication_channel_settings" ? Object.values(channels)
      : this.table === "user_invitation_email_settings" ? [{ ...invitationConfig, channel: "email" }]
      : this.table === "notification_reminder_rules" ? reminderRows
      : this.table === "communication_templates" ? templateRows
      : this.table === "contractor_contacts" || this.table === "dobco_contacts" ? contactRows
      : this.table === "projects" ? [{ id: 1, project_number: "10001", project_name: "Portable Project" }]
      : this.table === "contractor_compliance_status" ? [{ contractor_id: 1, compliance_record_id: 1, compliance_name: "Portable Compliance", calculated_status: "Active", expiration_date: null, days_remaining: null }]
      : this.table === "app_roles" ? [{ role: "Synthetic", is_system: false }] : assert.fail(`Unexpected table ${this.table}`);
    if (this.table === "role_permissions" && this.selection === "module,can_view") {
      rows = Object.entries(grants).filter(([key, value]) => key.endsWith(":view") && value).map(([key]) => ({ module: key.split(":")[0], can_view: true }));
    } else if (this.table === "role_permissions" && this.selection.startsWith("module,")) {
      rows = APP_MODULES.map((entry) => ({ module: entry, can_view: true, can_add: true, can_edit: true, can_delete: true, can_manage: true }));
    }
    rows = rows.filter((row) => this.filters.every(([key, value]) => (this.table === "role_permissions" || this.table === "user_profiles")
      || (key === "contractor_filter.contractor_id" ? row.communication_contractors.some((link) => link.contractor_id === value) : row[key] === value)));
    rows = rows.filter((row) => (this.notFilters ?? []).every(([key, value]) => row[key] !== value));
    if (this.search) rows = rows.filter((row) => row[this.search[0]].includes(this.search[1].slice(1, -1)));
    rows = [...rows].sort((a, b) => {
      for (const [key, ascending] of this.orders) {
        if (a[key] === b[key]) continue;
        const diff = a[key] < b[key] ? -1 : 1;
        return ascending ? diff : -diff;
      }
      return 0;
    }).slice(this.bounds[0], this.bounds[1] + 1);
    const projected = rows.map((row) => project(row, this.selection));
    return { data: single ? projected[0] ?? null : projected, error: null };
  }
}
let savedPermissions = null;
const admin = {
  from: (table) => new Query(table),
  auth: { getUser: async () => ({ data: { user: authenticated ? { id: actor.auth_user_id } : null }, error: null }) },
  rpc: async (name, args) => { rpcCalls.push([name, args]); return { data: name === "save_communication_draft" ? uuid(20) : null, error: dbError }; },
};
// Run the real server authentication and permission guards against synthetic clients.
function load(file) {
  if (cache.has(file)) return cache.get(file);
  const output = { exports: {} }; cache.set(file, output.exports);
  const code = ts.transpileModule(fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, {
    module: output, exports: output.exports, Request, Response, URL, URLSearchParams, Headers, console, Buffer,
    process: { env: new Proxy(credentialEnvironment, { get: (target, key) => target[key] ?? ({ NEXT_PUBLIC_SUPABASE_URL: "https://synthetic.invalid", NEXT_PUBLIC_SUPABASE_ANON_KEY: "synthetic", SUPABASE_SERVICE_ROLE_KEY: "synthetic-server-only" })[key] }) },
    require: (name) => {
      if (name === "server-only") return {};
      if (name === "@supabase/supabase-js") return { createClient: () => admin };
      if (name === "@azure/identity") return { ClientAssertionCredential: SyntheticClientAssertionCredential, EnvironmentCredential: class {}, ManagedIdentityCredential: class {}, WorkloadIdentityCredential: class {} };
      if (name === "@vercel/oidc") return { getVercelOidcToken: async (...args) => {
        assert.equal(args.length, 0, "Use the default Vercel team audience, not AzureADTokenExchange");
        oidcCalls++;
        if (oidcError) throw oidcError;
        return "synthetic-vercel-assertion-not-a-real-token";
      } };
      if (name === "@azure/keyvault-secrets") return { SecretClient: SyntheticSecretClient };
      if (name.startsWith("@/types/")) return load(`types/${name.slice(8)}.ts`);
      if (name.startsWith("@/lib/")) {
        const result = load(`src/lib/${name.slice(6)}.ts`);
        return name === "@/lib/server-admin" ? { ...result, writeAdministrationAudit: async (...args) => { auditCalls.push(args); if (auditError) throw new Error("Synthetic audit failure"); } } : result;
      }
      assert.fail(`Unexpected import ${name}`);
    },
  }, { filename: file });
  return output.exports;
}
const api = load("src/app/api/communications/route.ts");
const detail = load("src/app/api/communications/[id]/route.ts");
const delivery = load("src/app/api/communications/[id]/delivery/route.ts");
const settings = load("src/app/api/admin/communication-settings/[channel]/route.ts");
const invitationSettings = load("src/app/api/admin/invitation-email-settings/route.ts");
const invitationValidation = load("src/lib/invitation-email.ts");
const notifications = load("src/app/api/admin/notifications/route.ts");
const reminders = load("src/app/api/admin/notifications/reminders/route.ts");
const reminderDetail = load("src/app/api/admin/notifications/reminders/[id]/route.ts");
const notificationValidation = load("src/lib/notifications.ts");
const roles = load("src/app/api/admin/roles/route.ts");
const timeline = load("src/app/api/activity-log/route.ts");
const optionsApi = load("src/app/api/activity-log/contractors/route.ts");
const validation = load("src/lib/communications.ts");
const permissions = load("src/lib/permissions.ts");
const { APP_MODULES } = load("types/user-management.ts");
const context = (id = uuid(10)) => ({ params: Promise.resolve({ id, channel: "email" }) });
const request = (method = "GET", body, query = "") => new Request(`http://localhost/api/communications${query}`, { method, headers: { authorization: "Bearer synthetic" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const draft = { channel: "email", subject: "Synthetic", body: "Exact\n  body", recipients: [{ recipient_type: "external", recipient_name: "Synthetic", email: "synthetic@example.invalid", mobile_phone: null, contractor_contact_id: null, dobco_contact_id: null }], contractor_ids: [], project_ids: [], compliance_record_ids: [], mycoi_policy_ids: [], insurance_items: [] };
const config = { provider: "azure_communication_services", enabled: true, automated_enabled: true, from_name: "Portable Installation", from_address: "portable@example.invalid", reply_to_address: null, sending_domain: "example.invalid", revision: 1 };
const status = async (promise, expected) => { const response = await promise; assert.equal(response.status, expected, await response.clone().text()); return response; };
const allow = (...entries) => { grants = Object.fromEntries(entries.map((entry) => [entry, true])); };
for (const capability of ["contractors:view", "settings:view", "settings:manage"]) {
  allow(capability);
  await status(api.GET(request()), 403);
  await status(detail.GET(request(), context()), 403);
  await status(delivery.GET(request(), context()), 403);
  await status(api.POST(request("POST", draft)), 403);
}
allow("communications_summary:view");
const summary = await (await status(api.GET(request()), 200)).json();
assert.equal(summary.messages[0].recipient_count, 1);
for (const forbidden of ["Restricted", "restricted@", "+1555555", "provider", "subject", "body", "failure", "sender", "sent_at", "delivered_at"]) assert.equal(JSON.stringify(summary).includes(forbidden), false, `Summary cannot contain ${forbidden}`);
await status(detail.GET(request(), context()), 403);
await status(delivery.GET(request(), context()), 403);
await status(api.GET(request("GET", undefined, "?status=invalid")), 400);
await status(api.GET(request("GET", undefined, "?offset=-1")), 400);
for (const value of ["", "0", "-1", "1.5", "abc", "2147483648", "1 OR 1=1"]) await status(api.GET(request("GET", undefined, `?contractor_id=${encodeURIComponent(value)}`)), 400);
historyMessages = Array.from({ length: 122 }, (_, index) => ({
  ...message, id: uuid(index + 100), created_at: new Date(Date.UTC(2026, 9, 18, 20, 0, -index)).toISOString(),
  communication_contractors: [{ contractor_id: index % 2 ? 1 : 2, contractors: { company_name: index % 2 ? "Synthetic One" : "Synthetic Two" } }],
}));
const scopedFirst = await (await status(api.GET(request("GET", undefined, "?contractor_id=1")), 200)).json();
assert.equal(scopedFirst.messages.length, 50);
assert.equal(scopedFirst.next_offset, 50);
assert.ok(scopedFirst.messages.every((row) => row.contractors.some((link) => link.contractor_id === 1)));
const scopedSecond = await (await status(api.GET(request("GET", undefined, "?contractor_id=1&offset=50")), 200)).json();
assert.equal(scopedSecond.messages.length, 11);
assert.equal(scopedSecond.next_offset, null);
assert.equal(new Set([...scopedFirst.messages, ...scopedSecond.messages].map((row) => row.id)).size, 61, "Contractor-scoped pagination has no gaps or duplicates");
assert.ok(queryCalls.some((query) => query.table === "communication_messages" && query.selection.includes("contractor_filter:communication_contractors!inner") && query.filters.some(([key, value]) => key === "contractor_filter.contractor_id" && value === 1)));
historyMessages = null;
allow("communications_content:view");
const content = await (await status(detail.GET(request(), context()), 200)).json();
assert.equal(content.communication.body, message.body);
assert.equal(content.communication.communication_recipients[0].email, "restricted@example.invalid");
for (const forbidden of ["provider", "failure", "sent_at", "delivered_at"]) assert.equal(JSON.stringify(content).includes(forbidden), false);
await status(api.POST(request("POST", draft)), 403);
await status(delivery.GET(request(), context()), 403);
await status(detail.GET(request(), context("bad-id")), 400);
await status(detail.GET(request(), context(uuid(99))), 404);
allow("communications_delivery:view");
const metadata = await (await status(delivery.GET(request(), context()), 200)).json();
assert.equal(metadata.delivery.provider_message_id, message.provider_message_id);
for (const forbidden of ["body", "subject", "recipient_name", "sender_address", "email", "mobile_phone", "@example.invalid"]) assert.equal(JSON.stringify(metadata).includes(forbidden), false);
await status(detail.GET(request(), context()), 403);
await status(api.POST(request("POST", draft)), 403);
allow("communications_content:add");
const created = await (await status(api.POST(request("POST", draft)), 201)).json();
assert.equal(created.status, "Draft");
assert.deepEqual(Object.keys(created).sort(), ["id", "revision", "status"]);
assert.equal(rpcCalls.at(-1)[1].p_actor, actor.auth_user_id);
assert.equal(rpcCalls.at(-1)[1].p_id, null);
for (const extra of [{ id: uuid(2) }, { created_by: uuid(2) }, { status: "Sent" }, { provider_message_id: "invented" }, { sent_at: new Date().toISOString() }, { revision: 1 }]) await status(api.POST(request("POST", { ...draft, ...extra })), 400);
await status(detail.PATCH(request("PATCH", { ...draft, revision: 1 }), context()), 403);
allow("communications_content:edit");
await status(detail.PATCH(request("PATCH", { ...draft, revision: 1 }), context()), 200);
assert.equal(rpcCalls.at(-1)[1].p_id, uuid(10));
dbError = { code: "40001", message: "Draft changed" };
await status(detail.PATCH(request("PATCH", { ...draft, revision: 1 }), context()), 409);
dbError = { code: "22023", message: "Only Draft can be edited" };
await status(detail.PATCH(request("PATCH", { ...draft, revision: 1 }), context()), 400);
dbError = null;
allow("settings:view");
const loadedConfig = await (await status(settings.GET(request(), context()), 200)).json();
assert.equal(Object.hasOwn(loadedConfig.settings, "credential_configured"), false, "Credential status has its own vault-backed endpoint");
assert.equal(loadedConfig.settings.configuration_status, "Not Configured");
await status(settings.PATCH(request("PATCH", config), context()), 403);
allow("settings:manage");
await status(settings.PATCH(request("PATCH", config), context()), 200);
const twilioSettings = { provider: "twilio", enabled: true, automated_enabled: false, sending_phone_number: "+15555550100", incoming_enabled: false, two_way_enabled: false, revision: 1 };
await status(settings.PATCH(request("PATCH", twilioSettings), { params: Promise.resolve({ channel: "sms" }) }), 200);
assert.equal(rpcCalls.at(-1)[1].p_input.provider, "twilio");
assert.equal(validation.configurationStatus(twilioSettings, "sms"), "Configuration Incomplete");
await status(settings.PATCH(request("PATCH", { ...config, provider: "twilio" }), context()), 400);
for (const field of ["account_sid", "auth_token", "connection_string"]) {
  await status(settings.PATCH(request("PATCH", { ...twilioSettings, [field]: "synthetic" }), { params: Promise.resolve({ channel: "sms" }) }), 400);
}
for (const extra of [{ secret: "synthetic" }, { credential_configured: true }, { enabled: "yes" }, { from_address: "invalid" }, { sending_phone_number: "+15555550100" }]) await status(settings.PATCH(request("PATCH", { ...config, ...extra }), context()), 400);
assert.equal(validation.configurationStatus(config, "email"), "Configuration Incomplete");
assert.equal(validation.configurationStatus({ provider: null, enabled: false, automated_enabled: false, revision: 1 }, "sms"), "Not Configured");
auditError = true;
await status(settings.PATCH(request("PATCH", config), context()), 500);
auditError = false;
for (const permission of ["users:manage", "communications_content:add", "communications_summary:view"]) {
  allow(permission);
  await status(invitationSettings.GET(request()), 403);
  await status(invitationSettings.PATCH(request("PATCH", invitationConfig)), 403);
}
allow("settings:view");
const invitationResult = await (await status(invitationSettings.GET(request()), 200)).json();
assert.equal(invitationResult.settings.delivery_mode, "supabase_auth");
assert.equal(invitationResult.delivery_plan.active_delivery_mode, "supabase_auth");
assert.equal(invitationResult.delivery_plan.configuration_only, true);
assert.ok(!Object.keys(invitationResult.settings).some((key) => /secret|credential|token/.test(key)));
await status(invitationSettings.PATCH(request("PATCH", invitationConfig)), 403);
const futureInvitation = {
  ...invitationConfig, enabled: false, delivery_mode: "application_email_provider",
  organization_name: "Portable Organization", application_name: "Portable App", subject: "An invitation",
  application_base_url: "https://portable.example.invalid", invitation_path: "/account-invitation",
  template_reference: "installation/invitation-v1", template_content: "Welcome {{invitee_name}}\n{{invitation_url}}",
  sender_reference: "email-channel.sender", reply_to_reference: "email-channel.reply_to",
};
allow("settings:manage");
await status(invitationSettings.PATCH(request("PATCH", futureInvitation)), 200);
assert.equal(rpcCalls.at(-1)[0], "save_user_invitation_email_settings");
assert.equal(rpcCalls.at(-1)[1].p_actor, actor.auth_user_id);
assert.equal(rpcCalls.at(-1)[1].p_input.template_content, futureInvitation.template_content);
assert.equal(auditCalls.at(-1)[2], "INVITATION_EMAIL_SETTINGS_UPDATED");
const plan = invitationValidation.invitationDeliveryPlan(futureInvitation);
assert.equal(plan.configured_adapter, "application_email_provider");
assert.equal(plan.connector_status, "Not Implemented");
assert.equal(plan.active_delivery_mode, "supabase_auth", "Saving future mode cannot switch live invitations");
for (const invalid of [
  { secret: "synthetic" }, { enabled: "yes" }, { delivery_mode: "unknown" }, { revision: 0 },
  { application_base_url: "javascript:alert(1)" }, { application_base_url: "https://user:pass@example.invalid" },
  { application_base_url: "https://example.invalid/path" }, { application_base_url: "https://example.invalid?key=x" },
  { invitation_path: "//external.invalid" }, { invitation_path: "/\\external.invalid" }, { invitation_path: "/invite#hash" },
  { subject: "Subject\r\nHeader" }, { template_content: "x".repeat(10001) },
]) await status(invitationSettings.PATCH(request("PATCH", { ...futureInvitation, ...invalid })), 400);
dbError = { code: "40001", message: "Invitation settings changed" };
await status(invitationSettings.PATCH(request("PATCH", futureInvitation)), 409);
dbError = null;
auditError = true;
await status(invitationSettings.PATCH(request("PATCH", futureInvitation)), 500);
auditError = false;
console.log("PASS: invitation configuration projection, independent Settings access, typed future adapter plan, no runtime switch, validation, revision conflicts and explicit audit failures.");
const inactiveReminder = { days_before_expiration: 45, email_enabled: false, sms_enabled: false, template_reference: null };
const masters = { email: { automated_enabled: false, revision: 1 }, sms: { automated_enabled: false, revision: 1 } };
for (const permission of ["users:manage", "communications_content:add", "communications_summary:view", "activity:view"]) {
  allow(permission);
  await status(notifications.GET(request()), 403);
  await status(notifications.PATCH(request("PATCH", masters)), 403);
  await status(reminders.POST(request("POST", inactiveReminder)), 403);
  await status(reminderDetail.PATCH(request("PATCH", { ...inactiveReminder, revision: 1 }), context(uuid(50))), 403);
  await status(reminderDetail.DELETE(request("DELETE", { revision: 1 }), context(uuid(50))), 403);
}
allow("settings:view");
const notificationResult = await (await status(notifications.GET(request()), 200)).json();
assert.equal(notificationResult.execution_enabled, false);
assert.equal(notificationResult.rules[0].days_before_expiration, 45, "Reads persisted offsets, not a 90/60/30 runtime schedule");
assert.deepEqual(Object.keys(notificationResult.automation.email).sort(), ["automated_enabled", "revision"]);
await status(notifications.PATCH(request("PATCH", masters)), 403);
await status(reminders.POST(request("POST", inactiveReminder)), 403);
allow("settings:manage");
const beforeNotificationWrites = rpcCalls.length;
await status(notifications.PATCH(request("PATCH", masters)), 200);
await status(reminders.POST(request("POST", inactiveReminder)), 201);
await status(reminderDetail.PATCH(request("PATCH", { ...inactiveReminder, email_enabled: true, revision: 1 }), context(uuid(50))), 200);
await status(reminderDetail.DELETE(request("DELETE", { revision: 1 }), context(uuid(50))), 200);
assert.ok(rpcCalls.slice(beforeNotificationWrites).every(([name, args]) => ["save_notification_automation", "save_notification_reminder"].includes(name) && args.p_actor === actor.auth_user_id), "Configuration changes never invoke draft creation or other mutation functions");
for (const invalid of [
  { days_before_expiration: 0 }, { days_before_expiration: -1 }, { days_before_expiration: 1.5 },
  { days_before_expiration: "45" }, { days_before_expiration: 2147483648 }, { active: true },
  { email_enabled: "yes" }, { sms_enabled: null }, { template_reference: "x".repeat(501) },
  { recipient_ids: [1] }, { provider: "twilio" },
]) await status(reminders.POST(request("POST", { ...inactiveReminder, ...invalid })), 400);
await status(reminderDetail.PATCH(request("PATCH", inactiveReminder), context(uuid(50))), 400);
await status(reminderDetail.DELETE(request("DELETE", { revision: 0 }), context(uuid(50))), 400);
await status(reminderDetail.DELETE(request("DELETE", { revision: 1, active: false }), context(uuid(50))), 400);
await status(reminderDetail.DELETE(request("DELETE", { revision: 1 }), context("invalid")), 400);
for (const invalid of [{ email: { ...masters.email, automated_enabled: "no" }, sms: masters.sms }, { ...masters, enabled: true }, { email: masters.email }, { email: { ...masters.email, revision: 0 }, sms: masters.sms }]) {
  await status(notifications.PATCH(request("PATCH", invalid)), 400);
}
for (const email of [false, true]) for (const sms of [false, true]) for (const masterEmail of [false, true]) for (const masterSms of [false, true]) {
  const rule = { ...inactiveReminder, email_enabled: email, sms_enabled: sms };
  const automation = { email: { ...masters.email, automated_enabled: masterEmail }, sms: { ...masters.sms, automated_enabled: masterSms } };
  assert.equal(notificationValidation.reminderIsActive(rule), email || sms);
  assert.equal(notificationValidation.reminderChannelConfigured(rule, automation, "email"), email && masterEmail);
  assert.equal(notificationValidation.reminderChannelConfigured(rule, automation, "sms"), sms && masterSms);
}
dbError = { code: "23505", message: "Active reminder offset already configured" };
await status(reminders.POST(request("POST", { ...inactiveReminder, email_enabled: true })), 400);
dbError = { code: "40001", message: "Configuration changed" };
await status(notifications.PATCH(request("PATCH", masters)), 409);
await status(reminderDetail.PATCH(request("PATCH", { ...inactiveReminder, revision: 1 }), context(uuid(50))), 409);
dbError = { code: "P0002", message: "Reminder not found" };
await status(reminderDetail.DELETE(request("DELETE", { revision: 1 }), context(uuid(99))), 404);
dbError = { code: "42P01", message: "Notification migration missing" };
allow("settings:view");
await status(notifications.GET(request()), 500);
dbError = null;
allow("settings:manage");
auditError = true;
await status(reminders.POST(request("POST", inactiveReminder)), 500);
auditError = false;
console.log("PASS: Notifications Settings-only access, persisted rules, configuration-only writes, strict validation, master/channel truth table, explicit duplicate/stale/missing/audit errors; no draft/queue/provider calls.");
allow("roles:manage");
const matrix = APP_MODULES.map((entry) => ({ module: entry, can_view: false, can_add: entry === "communications_content", can_edit: entry === "communications_content", can_delete: false }));
await status(roles.PATCH(request("PATCH", { role: "Synthetic", permissions: matrix })), 200);
assert.equal(savedPermissions.find((p) => p.module === "communications_content").can_view, false, "Role API preserves Add/Edit without granting View");
await status(roles.PATCH(request("PATCH", { role: "Synthetic", permissions: matrix.map((p) => ({ ...p, can_add: p.module === "communications_summary" || p.can_add })) })), 400);
await status(roles.POST(request("POST", { sourceRole: "Administrator", role: "Synthetic Clone" })), 201);
for (const permission of savedPermissions) {
  if (permission.module === "communications_content") {
    assert.equal(permission.can_delete, false); assert.equal(permission.can_add, true); assert.equal(permission.can_edit, true);
  } else if (permission.module.startsWith("communications_")) {
    assert.equal(permission.can_view, true); assert.equal(permission.can_add || permission.can_edit || permission.can_delete || permission.can_manage, false);
  } else {
    assert.equal(permission.can_view && permission.can_add && permission.can_edit && permission.can_delete && permission.can_manage, true, "Cloning preserves unrelated module behavior");
  }
}
const grantMatrix = APP_MODULES.map((entry) => ({ role: "Synthetic", module: entry, can_view: false, can_manage: entry === "communications_content", can_add: entry === "communications_content", can_edit: false, can_delete: false }));
assert.equal(permissions.canAccessModule(grantMatrix, "communications_content", "view"), false);
assert.equal(permissions.canAccessModule(grantMatrix, "communications_content", "add"), true);
assert.equal(permissions.canAccessCommunications(grantMatrix), true);
assert.equal(permissions.moduleForPath("/communications"), "communications_summary");
actor.system_administrator = false;
historyMessages = Array.from({ length: 122 }, (_, index) => ({
  ...message, status: "Sent", id: uuid(index + 100), created_at: new Date(Date.UTC(2026, 9, 18, 20, 0, -index)).toISOString(),
  communication_contractors: [{ contractor_id: index % 2 ? 1 : 2, contractors: { company_name: index % 2 ? "Synthetic One" : "Synthetic Two" } }],
}));
historyMessages.unshift({ ...message, id: uuid(9999), communication_contractors: [{ contractor_id: 1, contractors: { company_name: "Synthetic One" } }] });
for (let i = 1; i <= 65; i++) {
  activityRows.push({ id: i, contractor_id: 1, project_id: null, activity_date: "2026-10-18", activity_type: "Status Change", notes: `Activity ${i}`, follow_up_date: null, created_by: "Synthetic", created_at: new Date(Date.UTC(2026, 9, 18, 10, 0, i)).toISOString() });
  followupRows.push({ id: i, contractor_id: 1, followup_date: "2026-10-18", followup_method: "Email", subject: `Same authoritative follow-up ${i}`, status: i % 2 ? "Open" : "Resolved", created_at: new Date(Date.UTC(2026, 9, 18, 11, 0, i)).toISOString(), notes: "Not part of the operational summary", compliance_record_id: null, compliance_type_id: null, insurance_item_key: "general_liability", related_type: null, related_record: null });
}
activityRows.push({ ...activityRows[0], id: 999, contractor_id: 2 });
followupRows.push({ ...followupRows[0], id: 999, contractor_id: 2, insurance_item_key: null });
const sourceSnapshot = JSON.stringify({ historyMessages, activityRows, followupRows });
const timelineRequest = (query = "?contractor_id=1") => request("GET", undefined, query);
for (const capability of ["contractors:view", "followups:view", "communications_summary:view"]) {
  allow(capability);
  await status(timeline.GET(timelineRequest()), 403);
  await status(optionsApi.GET(request()), 403);
}
allow("activity:view");
let readsBefore = queryCalls.length;
const activityOnly = await (await status(timeline.GET(timelineRequest()), 200)).json();
assert.equal(activityOnly.entries.length, 50);
assert.ok(activityOnly.entries.every((entry) => entry.source === "activity"));
assert.equal(activityOnly.sources.followups, false);
assert.equal(activityOnly.sources.communications, false);
assert.ok(!queryCalls.slice(readsBefore).some((query) => ["contractor_followups", "communication_messages"].includes(query.table)), "Unauthorized sources must not even be queried");
await status(timeline.GET(timelineRequest("?contractor_id=0")), 400);
await status(timeline.GET(timelineRequest("?contractor_id=999")), 404);
await status(timeline.GET(timelineRequest("?contractor_id=1&followup=-1")), 400);
const options = await (await status(optionsApi.GET(request()), 200)).json();
assert.equal(options.contractors.length, 2);
assert.deepEqual(Object.keys(options.contractors[0]).sort(), ["company_name", "id"], "Directory exposes no contact or contractor master detail fields");
const filteredOptions = await (await status(optionsApi.GET(request("GET", undefined, "?search=Two")), 200)).json();
assert.equal(filteredOptions.contractors.length, 1);
await status(optionsApi.GET(request("GET", undefined, "?offset=-1")), 400);
allow("activity:view", "followups:view");
readsBefore = queryCalls.length;
const followupOnly = await (await status(timeline.GET(timelineRequest()), 200)).json();
assert.ok(followupOnly.entries.every((entry) => entry.source !== "communication"));
assert.ok(followupOnly.entries.some((entry) => entry.source === "followup" && entry.record.related_item === "General Liability"));
assert.ok(!queryCalls.slice(readsBefore).some((query) => query.table === "communication_messages"));
allow("activity:view", "communications_summary:view");
readsBefore = queryCalls.length;
const communicationOnly = await (await status(timeline.GET(timelineRequest()), 200)).json();
assert.ok(communicationOnly.entries.some((entry) => entry.source === "communication"));
assert.ok(communicationOnly.entries.every((entry) => entry.source !== "communication" || entry.record.status !== "Draft"), "Operational timeline excludes Drafts before pagination");
assert.ok(!queryCalls.slice(readsBefore).some((query) => query.table === "contractor_followups"));
allow("activity:view", "followups:view", "communications_summary:view");
let position = null, allEntries = [];
do {
  const query = new URLSearchParams({ contractor_id: "1", ...(position ?? {}) });
  const result = await (await status(timeline.GET(timelineRequest(`?${query}`)), 200)).json();
  allEntries.push(...result.entries);
  position = result.next;
  assert.ok(allEntries.length < 250, "Pagination must terminate");
} while (position);
assert.equal(allEntries.length, 191, "Every authoritative source record appears once across composed pages");
assert.equal(new Set(allEntries.map((entry) => `${entry.source}:${entry.record.id}`)).size, 191);
for (let i = 1; i < allEntries.length; i++) assert.ok(Date.parse(allEntries[i - 1].date) >= Date.parse(allEntries[i].date), "Composed pages remain chronological");
for (const entry of allEntries) {
  if (entry.source === "communication") {
    for (const forbidden of ["body", "subject", "email", "mobile_phone", "provider_message_id", "failure_reason"]) assert.equal(Object.hasOwn(entry.record, forbidden), false);
  } else assert.equal(entry.record.contractor_id, 1);
}
const secondContractor = await (await status(timeline.GET(timelineRequest("?contractor_id=2")), 200)).json();
assert.ok(secondContractor.entries.every((entry) => entry.source === "communication" ? entry.record.contractors.some((link) => link.contractor_id === 2) : entry.record.contractor_id === 2));
timelineFailure = true;
await status(timeline.GET(timelineRequest()), 500);
timelineFailure = false;
assert.equal(JSON.stringify({ historyMessages, activityRows, followupRows }), sourceSnapshot, "Read-time composition never mutates authoritative records");
historyMessages = null;
console.log("PASS: activity/source permission matrix, contractor options/validation, server-scoped inner relation before pagination, interleaved multi-source pagination without gaps/duplicates, summary omission, no copies or writes.");
authenticated = false;
await status(api.GET(request()), 401);
authenticated = true; actor.status = "Inactive";
await status(api.GET(request()), 403);
actor.status = "Active"; actor.system_administrator = true; allow();
await status(api.GET(request()), 200);
await status(detail.GET(request(), context()), 200);
await status(delivery.GET(request(), context()), 200);
assert.ok(auditCalls.length && selectCalls.length);
console.log("PASS: real server auth/permission guards, independent summary/content/delivery/Add/Edit/settings APIs, restricted projections, validation, Draft-only RPC requests, explicit errors, role-matrix independence and no sending.");

actor.system_administrator = false;
const credentials = load("src/app/api/admin/communication-settings/[channel]/credential/route.ts");
const credentialProvider = load("src/lib/server-provider-credentials.ts");
const secret = "endpoint=https://synthetic.communication.azure.com/;accesskey=c3ludGhldGlj";
const replacement = "endpoint=https://synthetic.communication.azure.com/;accesskey=cmVwbGFjZW1lbnQ=";
const credentialContext = (channel = "email") => ({ params: Promise.resolve({ channel }) });
const credentialRequest = (value = secret) => request("PUT", { credential: value });
const auditBefore = auditCalls.length, rpcBefore = rpcCalls.length;
authenticated = false;
await status(credentials.PUT(credentialRequest(), credentialContext()), 401);
authenticated = true;
allow("settings:view");
await status(credentials.PUT(credentialRequest(), credentialContext()), 403);
assert.equal(vaultWrites, 0);
await status(credentials.GET(request(), credentialContext()), 503);
allow("settings:manage");
await status(credentials.GET(request(), credentialContext()), 403, "Manage does not imply View");
channels.email.provider = "azure_communication_services";
await status(credentials.PUT(credentialRequest(), credentialContext()), 503);
assert.equal(vaultWrites, 0, "Missing infrastructure cannot write");
Object.assign(credentialEnvironment, { SUBTRACKER_KEY_VAULT_ENABLED: "true", AZURE_KEY_VAULT_URL: "https://synthetic.vault.azure.net", AZURE_KEY_VAULT_AUTH_MODE: "environment" });
allow("settings:view", "settings:manage");
channels.email.provider = "azure_communication_services";
channels.sms.provider = "azure_communication_services";
assert.equal((await (await status(credentials.GET(request(), credentialContext()), 200)).json()).credential_configured, false);
for (const invalid of ["", "synthetic", secret.replace("communication.azure.com", "evil.invalid"), null, {}, secret + ";suffix", "x".repeat(4097)]) {
  await status(credentials.PUT(credentialRequest(invalid), credentialContext()), 400);
}
await status(credentials.PUT(request("PUT", { credential: secret, extra: secret }), credentialContext()), 400);
await status(credentials.PUT(credentialRequest("x".repeat(9000)), credentialContext()), 413);
await status(credentials.PUT(new Request("http://localhost", { method: "PUT", body: secret, headers: { authorization: "Bearer synthetic" } }), credentialContext()), 400);
await status(credentials.PUT(credentialRequest(), credentialContext("invalid")), 400);
assert.equal(vaultWrites, 0);
for (const channel of ["email", "sms"]) {
  const response = await status(credentials.PUT(credentialRequest(), credentialContext(channel)), 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await response.json(), { credential_configured: true }, "Only status is returned, never SDK response/value");
}
assert.deepEqual([...syntheticSecrets.keys()].sort(), ["subtracker-acs-email", "subtracker-acs-sms"]);
await status(credentials.PUT(credentialRequest(replacement), credentialContext()), 200);
assert.equal(await credentialProvider.getProviderCredential("azure_communication_services", "email"), replacement);
assert.equal(await credentialProvider.getProviderCredential("azure_communication_services", "sms"), secret, "Channel replacement is isolated");
vaultError = Object.assign(new Error(`Raw provider exception ${secret}`), { code: "Forbidden" });
for (const operation of [credentials.GET(request(), credentialContext()), credentials.PUT(credentialRequest(), credentialContext())]) {
  const response = await status(operation, 503);
  const body = await response.text();
  assert.equal(body.includes(secret), false);
  assert.equal(body.includes("Raw provider"), false);
}
assert.equal(syntheticSecrets.get("subtracker-acs-email"), replacement, "Failure never erases a credential");
vaultError = null;
dbError = { code: "42501", message: `Raw database exception ${secret}` };
const databaseFailure = await status(credentials.PUT(credentialRequest(), credentialContext()), 503);
assert.equal((await databaseFailure.text()).includes(secret), false);
dbError = null;
for (const broken of [{ value: secret, properties: { enabled: false } }, { properties: { enabled: true } }]) {
  const provider = credentialProvider.createCredentialProvider({ getSecret: async () => broken, setSecret: async () => undefined });
  await assert.rejects(provider.getProviderCredentialStatus("azure_communication_services", "email"), (error) => error.status === 503);
}
const missingVault = credentialProvider.createCredentialProvider({
  getSecret: async () => { throw { code: "VaultNotFound", message: secret }; }, setSecret: async () => undefined,
});
await assert.rejects(missingVault.getProviderCredentialStatus("azure_communication_services", "email"), (error) => error.status === 503 && !error.message.includes(secret));
channels.sms.provider = "twilio";
const writesBefore = vaultWrites;
await status(credentials.PUT(credentialRequest(), credentialContext("sms")), 409);
assert.equal(vaultWrites, writesBefore);
credentialEnvironment.AZURE_KEY_VAULT_URL = "http://synthetic.vault.azure.net";
await status(credentials.GET(request(), credentialContext()), 503);
credentialEnvironment.AZURE_KEY_VAULT_URL = "https://synthetic.vault.azure.net";
credentialEnvironment.AZURE_KEY_VAULT_AUTH_MODE = "unsupported";
await status(credentials.GET(request(), credentialContext()), 503);
assert.equal(auditCalls.length, auditBefore, "No secret enters audit payloads");
assert.equal(rpcCalls.length, rpcBefore, "No secret/database/communication writes");
assert.ok(vaultReads > 0);
console.log("PASS: synthetic Key Vault status/read/configure/replace, channel isolation, real Settings authorization, infrastructure gate, bounded validation, sanitized failures, no secret responses/audit/database writes or provider sending.");

const composeOptions = load("src/app/api/communications/compose-options/route.ts");
const templateApi = load("src/app/api/admin/communication-templates/route.ts");
const templateDetail = load("src/app/api/admin/communication-templates/[id]/route.ts");
const draftEditor = load("src/app/api/communications/[id]/draft/route.ts");
const merge = load("src/lib/communication-templates.ts");
const optionRequest = (kind, extra = "") => request("GET", undefined, `?kind=${kind}${extra}`);
for (const permission of ["communications_summary:view", "communications_content:view", "settings:view"]) {
  allow(permission);
  await status(composeOptions.GET(optionRequest("configuration")), 403);
  await status(draftEditor.GET(request(), context()), 403);
}
for (const permission of ["communications_content:add", "communications_content:edit"]) {
  allow(permission);
  await status(composeOptions.GET(optionRequest("configuration")), 200);
  await status(composeOptions.GET(optionRequest("templates")), 200);
  for (const kind of ["contractors", "contacts", "internal", "projects", "compliance"]) await status(composeOptions.GET(optionRequest(kind, "&contractor_id=1")), 403);
}
allow("communications_content:add", "contractors:view", "settings:view", "projects:view", "compliance:view");
for (const kind of ["contractors", "contacts", "internal", "projects", "compliance"]) {
  const result = await (await status(composeOptions.GET(optionRequest(kind, "&contractor_id=1")), 200)).json();
  assert.ok(result.rows.length);
  assert.equal(JSON.stringify(result).includes("Must not be projected"), false);
  assert.equal(JSON.stringify(result).includes("user_profile_id"), false, "No user-management identity dependency");
}
await status(composeOptions.GET(optionRequest("contacts", "&contractor_id=0")), 400);
await status(composeOptions.GET(optionRequest("contractors", "&offset=-1")), 400);
await status(composeOptions.GET(optionRequest("contractors", "&search=%25")), 400);
await status(composeOptions.GET(optionRequest("invalid")), 400);
const templateInput = { name: "Portable", category: "Internal Alert", channel: "email", subject: "{{organization_name}}", body: "Hello {{contact_name}}", is_active: false };
allow("settings:view");
await status(templateApi.GET(request()), 200);
await status(templateApi.POST(request("POST", templateInput)), 403);
allow("settings:manage");
await status(templateApi.GET(request()), 403);
await status(templateApi.POST(request("POST", templateInput)), 201);
assert.equal(rpcCalls.at(-1)[0], "save_communication_template");
await status(templateDetail.PATCH(request("PATCH", { ...templateInput, revision: 1 }), context(uuid(70))), 200);
for (const invalid of [{ name: "" }, { body: "" }, { body: "{{unknown}}" }, { body: "{{contact_name}} {{" }, { channel: "sms" }, { is_active: "yes" }, { category: "invented" }]) {
  await status(templateApi.POST(request("POST", { ...templateInput, ...invalid })), 400);
}
await status(templateDetail.PATCH(request("PATCH", { ...templateInput, revision: 0 }), context(uuid(70))), 400);
dbError = { code: "40001", message: "Template changed; reload" };
await status(templateDetail.PATCH(request("PATCH", { ...templateInput, revision: 1 }), context(uuid(70))), 409);
dbError = null;
allow("communications_content:edit");
const editor = await (await status(draftEditor.GET(request(), context()), 200)).json();
assert.equal(editor.draft.body, message.body);
assert.equal(editor.draft.revision, message.revision);
message.status = "Sent";
await status(draftEditor.GET(request(), context()), 404);
message.status = "Draft";
allow("communications_content:add");
await status(draftEditor.GET(request(), context()), 403);
const resolved = merge.renderMessage("Hello {{contact_name}}\n{{contractor_name}}\n{{expiration_date}}", { contact_name: "Exact Name", contractor_name: "Authoritative Company" });
assert.equal(resolved.text, "Hello Exact Name\nAuthoritative Company\n{{expiration_date}}");
assert.deepEqual([...resolved.unresolved], ["expiration_date"]);
for (const active of [false, true]) for (const destination of [null, "person@example.invalid"]) for (const receives of [false, true]) {
  assert.equal(merge.composeEligibility({ is_active: active, email: destination, receives_email: receives }, "email"), active && !!destination && receives);
}
for (const active of [false, true]) for (const destination of [null, "+15555550111"]) for (const receives of [false, true]) for (const consent of [false, true]) {
  assert.equal(merge.composeEligibility({ is_active: active, mobile_phone: destination, receives_sms: receives, sms_consent_recorded: consent }, "sms"), active && !!destination && receives && consent);
}
const noExpiration = merge.renderMessage("{{expiration_date}} {{days_until_expiration}}", { expiration_date: null, days_until_expiration: null });
assert.equal(noExpiration.unresolved.length, 2, "Non-expiring/missing dates never fabricated");
assert.ok(merge.renderMessage("{{contact_first_name}}", {}).unresolved.includes("contact_first_name"), "Full names are not guessed into first/last fields");
assert.ok(rpcCalls.every(([name]) => !/send|queue|dispatch/i.test(name)));
console.log("PASS: Step 6C compose/source permissions, minimal contact projections, active template management/revisions, Edit-only Draft access (no Sent content), controlled merges/missing data, full Email/SMS eligibility truth tables and no sends.");

const emailPlan = load("src/lib/email-provider.ts");
const emailAdapter = load("src/lib/server-email-provider.ts");
const microsoftConfig = { provider: "microsoft_365", enabled: true, automated_enabled: false,
  from_name: "Portable Organization", from_address: "mailbox@example.invalid", reply_to_address: "reply@example.invalid",
  microsoft_tenant_id: uuid(800), microsoft_client_id: uuid(801), revision: 1 };
allow("settings:view");
channels.email = { ...channels.email, ...microsoftConfig };
const microsoftSettings = await (await status(settings.GET(request(), context()), 200)).json();
assert.equal(microsoftSettings.settings.microsoft_tenant_id, uuid(800));
assert.equal(microsoftSettings.settings.microsoft_client_id, uuid(801));
allow("settings:manage");
await status(settings.PATCH(request("PATCH", microsoftConfig), context()), 200);
assert.equal(rpcCalls.at(-1)[1].p_input.provider, "microsoft_365");
assert.equal(rpcCalls.at(-1)[1].p_input.automated_enabled, false);
for (const invalid of [{ microsoft_tenant_id: "not-a-uuid" }, { microsoft_client_id: "tenant.example.invalid" }, { client_secret: "forbidden" }]) {
  await status(settings.PATCH(request("PATCH", { ...microsoftConfig, ...invalid }), context()), 400);
}
const smsContext = { params: Promise.resolve({ channel: "sms" }) };
await status(settings.PATCH(request("PATCH", { provider: "microsoft_365", enabled: false, automated_enabled: false, sending_phone_number: null, incoming_enabled: false, two_way_enabled: false, revision: 1 }), smsContext), 400);
assert.equal(emailPlan.emailProviderPlan(microsoftConfig, true).connection_status, "Ready for Testing");
assert.equal(emailPlan.emailProviderPlan(microsoftConfig, true).configuration_status, "Ready for Testing");
for (const change of [{ enabled: false }, { from_address: null }, { microsoft_tenant_id: null }, { microsoft_client_id: null }, { microsoft_client_id: "invalid" }]) {
  assert.equal(emailPlan.emailProviderPlan({ ...microsoftConfig, ...change }, true).connection_status, "Not Configured");
  assert.equal(emailPlan.emailProviderPlan({ ...microsoftConfig, ...change }, true).configuration_status, "Incomplete");
}
assert.equal(emailPlan.emailProviderPlan(microsoftConfig, false).connection_status, "Not Configured");
assert.equal(emailPlan.emailProviderPlan(microsoftConfig, false).configuration_status, "Credential Required");
const acsConfig = { ...microsoftConfig, provider: "azure_communication_services", microsoft_tenant_id: null, microsoft_client_id: null };
assert.equal(emailPlan.emailProviderPlan(acsConfig, false).configuration_status, "Credential Required");
assert.equal(emailPlan.emailProviderPlan(acsConfig, true).configuration_status, "Ready for Testing");
for (const configured of [true, false]) {
  const plan = emailPlan.emailProviderPlan(microsoftConfig, configured);
  assert.equal(plan.test_enabled, false); assert.equal(plan.send_enabled, false);
  assert.notEqual(plan.connection_status, "Verified");
  assert.equal(plan.authentication, "application_client_secret");
}
const microsoftRequest = (method = "GET", body) => request(method, body, "?provider=microsoft_365");
const m365Secret = "synthetic-microsoft-application-secret";
const secretAuditBefore = auditCalls.length, secretRpcBefore = rpcCalls.length;
allow("settings:view");
await status(credentials.PUT(microsoftRequest("PUT", { credential: m365Secret }), credentialContext()), 403);
credentialEnvironment.SUBTRACKER_KEY_VAULT_ENABLED = "false";
await status(credentials.GET(microsoftRequest(), credentialContext()), 503);
credentialEnvironment.SUBTRACKER_KEY_VAULT_ENABLED = "true";
credentialEnvironment.AZURE_KEY_VAULT_AUTH_MODE = "environment";
assert.deepEqual(await (await status(credentials.GET(microsoftRequest(), credentialContext()), 200)).json(), { credential_configured: false });
allow("settings:manage");
for (const invalid of ["", " ", "line\nbreak", "x".repeat(4097), null, {}]) {
  await status(credentials.PUT(microsoftRequest("PUT", { credential: invalid }), credentialContext()), 400);
}
assert.deepEqual(await (await status(credentials.PUT(microsoftRequest("PUT", { credential: m365Secret }), credentialContext()), 200)).json(), { credential_configured: true });
assert.equal(syntheticSecrets.get("subtracker-microsoft-365-email"), m365Secret);
assert.equal(syntheticSecrets.get("subtracker-acs-email"), replacement);
assert.equal(syntheticSecrets.get("subtracker-acs-sms"), secret);
const readsBeforeAdapter = vaultReads;
const preparedMicrosoft = await emailAdapter.prepareEmailAdapter(microsoftConfig);
assert.equal(preparedMicrosoft.provider, "microsoft_365");
assert.equal(preparedMicrosoft.authentication, "application_client_secret");
assert.equal(preparedMicrosoft.clientSecret, m365Secret, "Credential exists only inside the server adapter boundary");
assert.equal(preparedMicrosoft.tenantId, uuid(800));
assert.equal(preparedMicrosoft.clientId, uuid(801));
assert.ok(vaultReads > readsBeforeAdapter);
const preparedACS = await emailAdapter.prepareEmailAdapter({ ...config, automated_enabled: false });
assert.equal(preparedACS.provider, "azure_communication_services");
assert.equal(preparedACS.connectionString, replacement);
await assert.rejects(emailAdapter.prepareEmailAdapter({ ...microsoftConfig, enabled: false }), (error) => error.status === 409);
await status(credentials.PUT(microsoftRequest("PUT", { credential: m365Secret }), smsContext), 400);
channels.email.provider = "azure_communication_services";
await status(credentials.PUT(microsoftRequest("PUT", { credential: m365Secret }), credentialContext()), 409);
channels.email.provider = "microsoft_365";
vaultError = Object.assign(new Error(`Raw Azure exception ${m365Secret}`), { code: "Forbidden" });
const sanitized = await status(credentials.PUT(microsoftRequest("PUT", { credential: "synthetic-replacement" }), credentialContext()), 503);
assert.equal((await sanitized.text()).includes(m365Secret), false);
assert.equal(syntheticSecrets.get("subtracker-microsoft-365-email"), m365Secret);
vaultError = null;
assert.equal(auditCalls.length, secretAuditBefore);
assert.equal(rpcCalls.length, secretRpcBefore, "Microsoft credential never enters database writes");
for (const provider of ["microsoft_365", "azure_communication_services"]) {
  channels.email.provider = provider;
  const invitationPlan = invitationValidation.invitationDeliveryPlan({ ...invitationConfig, delivery_mode: "application_email_provider" });
  assert.equal(invitationPlan.configured_adapter, "application_email_provider");
  assert.equal(invitationPlan.active_delivery_mode, "supabase_auth");
}
console.log("PASS: Microsoft 365 Email-only configuration/UUID validation, synthetic separate Key Vault reference and sanitized responses, Settings authorization, server application-auth adapter preparation, no Verified/test/send, unchanged SMS and provider-independent invitations.");

const smsPlan = load("src/lib/sms-provider.ts");
const smsConfiguration = { provider: "azure_communication_services", enabled: true, automated_enabled: false,
  sending_phone_number: "+15555550100", incoming_enabled: false, two_way_enabled: false, revision: 1 };
allow("settings:manage");
for (const verification of ["not_recorded", "not_submitted", "under_review", "approved", "rejected"]) {
  await status(settings.PATCH(request("PATCH", { ...smsConfiguration, sms_verification_status: verification }), smsContext), 200);
  assert.equal(rpcCalls.at(-1)[1].p_input.sms_verification_status, verification);
  for (const credential of [true, false]) {
    const plan = smsPlan.smsProviderPlan({ ...smsConfiguration, sms_verification_status: verification }, credential);
    assert.equal(plan.test_enabled, false);
    assert.equal(plan.send_enabled, false);
    assert.equal(plan.configuration_status, verification === "under_review" ? "Verification Pending" : verification === "rejected" ? "Verification Rejected"
      : verification === "approved" ? credential ? "Ready for Testing" : "Credential Required" : "Verification Required");
  }
}
for (const invalid of [null, true, "Verified", "", {}]) await status(settings.PATCH(request("PATCH", { ...smsConfiguration, sms_verification_status: invalid }), smsContext), 400);
await status(settings.PATCH(request("PATCH", { ...microsoftConfig, sms_verification_status: "approved" }), context()), 400);
for (const change of [{ enabled: false }, { provider: "twilio" }, { sending_phone_number: null }, { sending_phone_number: "not-a-phone" }, { sending_phone_number: "+123" }]) {
  assert.equal(smsPlan.smsProviderPlan({ ...smsConfiguration, sms_verification_status: "approved", ...change }, true).configuration_status, "Incomplete");
}
allow("settings:view");
await status(settings.PATCH(request("PATCH", { ...smsConfiguration, sms_verification_status: "under_review" }), smsContext), 403);
console.log("PASS: SMS administrator-recorded verification validation/permissions and readiness truth table; pending/rejected/unknown never ready; test/send remain disabled.");
allow("settings:view", "settings:manage");
channels.sms = { ...channels.sms, ...smsConfiguration, enabled: false, automated_enabled: false, sms_verification_status: "under_review" };
const smsBeforeCredential = JSON.stringify(channels.sms);
const smsRPCBeforeCredential = rpcCalls.length, smsAuditBeforeCredential = auditCalls.length;
await status(credentials.PUT(request("PUT", { credential: secret }), smsContext), 200);
await status(credentials.PUT(request("PUT", { credential: replacement }), smsContext), 200);
const smsCredentialStatus = await status(credentials.GET(request(), smsContext), 200);
assert.deepEqual(await smsCredentialStatus.json(), { credential_configured: true });
assert.equal(JSON.stringify(channels.sms), smsBeforeCredential, "Configure/replace cannot alter SMS masters or verification");
assert.equal(rpcCalls.length, smsRPCBeforeCredential, "Credential must not enter settings RPCs");
assert.equal(auditCalls.length, smsAuditBeforeCredential, "Credential must not enter audit payloads");
vaultError = new Error(`Synthetic sensitive SDK detail: ${replacement}`);
const smsCredentialError = await status(credentials.PUT(request("PUT", { credential: secret }), smsContext), 503);
assert.equal((await smsCredentialError.text()).includes(replacement), false);
vaultError = null;
console.log("PASS: configure/replace SMS credential with both masters OFF preserves settings/verification, returns status only, no settings/audit writes and sanitized errors.");
Object.assign(credentialEnvironment, { AZURE_KEY_VAULT_AUTH_MODE: "vercel_oidc", AZURE_TENANT_ID: uuid(900), AZURE_CLIENT_ID: uuid(901) });
delete credentialEnvironment.AZURE_CLIENT_SECRET;
const beforeOidcSettings = JSON.stringify(channels);
const beforeOidcRPC = rpcCalls.length, beforeOidcAudit = auditCalls.length;
const oidcStatus = await status(credentials.GET(request(), smsContext), 200);
assert.deepEqual(await oidcStatus.json(), { credential_configured: true });
await status(credentials.PUT(request("PUT", { credential: secret }), smsContext), 200);
assert.ok(oidcCalls >= 2, "Vault reads/writes invoke the server-side assertion callback");
assert.deepEqual(assertions.at(-1), { tenantId: uuid(900), clientId: uuid(901) });
assert.equal(JSON.stringify(channels), beforeOidcSettings);
assert.equal(rpcCalls.length, beforeOidcRPC);
assert.equal(auditCalls.length, beforeOidcAudit);
assert.equal(channels.sms.enabled, false); assert.equal(channels.sms.automated_enabled, false);
oidcError = new Error("synthetic-vercel-assertion-not-a-real-token");
const oidcFailure = await status(credentials.PUT(request("PUT", { credential: replacement }), smsContext), 503);
assert.equal((await oidcFailure.text()).includes("synthetic-vercel-assertion"), false);
oidcError = null;
for (const field of ["AZURE_TENANT_ID", "AZURE_CLIENT_ID"]) {
  const value = credentialEnvironment[field]; delete credentialEnvironment[field];
  const callsBefore = oidcCalls;
  await status(credentials.GET(request(), smsContext), 503);
  assert.equal(oidcCalls, callsBefore, "Missing identity configuration fails before token acquisition");
  credentialEnvironment[field] = value;
}
for (const mode of ["environment", "workload_identity", "managed_identity"]) {
  credentialEnvironment.AZURE_KEY_VAULT_AUTH_MODE = mode;
  await status(credentials.GET(request(), smsContext), 200);
}
console.log("PASS: explicit Vercel OIDC assertion mode uses configurable tenant/client, default audience and existing vault provider; sanitized failures, no client secret, no settings/audit writes or SMS enablement; other identity modes preserved.");
