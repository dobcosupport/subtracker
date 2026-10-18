import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const cache = new Map();
const uuid = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const actor = { auth_user_id: uuid(1), role: "Synthetic", status: "Active", system_administrator: false, last_login: new Date().toISOString() };
let authenticated = true, dbError = null, auditError = false;
let grants = {}, rpcCalls = [], auditCalls = [], selectCalls = [];
let historyMessages = null, timelineFailure = false;
const queryCalls = [];
const activityRows = [], followupRows = [];
const contractorRows = [{ id: 1, company_name: "Synthetic One" }, { id: 2, company_name: "Synthetic Two" }];
const channels = {
  email: { channel: "email", provider: null, enabled: false, automated_enabled: false, from_name: null, from_address: null, reply_to_address: null, sending_domain: null, sending_phone_number: null, incoming_enabled: false, two_way_enabled: false, revision: 1 },
  sms: { channel: "sms", provider: null, enabled: false, automated_enabled: false, from_name: null, from_address: null, reply_to_address: null, sending_domain: null, sending_phone_number: null, incoming_enabled: false, two_way_enabled: false, revision: 1 },
};
const invitationConfig = {
  enabled: true, delivery_mode: "supabase_auth", organization_name: null, application_name: null,
  subject: null, application_base_url: null, invitation_path: null, template_reference: null,
  template_content: null, sender_reference: null, reply_to_reference: null, revision: 1,
};
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
      : this.table === "app_roles" ? [{ role: "Synthetic", is_system: false }] : assert.fail(`Unexpected table ${this.table}`);
    if (this.table === "role_permissions" && this.selection === "module,can_view") {
      rows = Object.entries(grants).filter(([key, value]) => key.endsWith(":view") && value).map(([key]) => ({ module: key.split(":")[0], can_view: true }));
    } else if (this.table === "role_permissions" && this.selection.startsWith("module,")) {
      rows = APP_MODULES.map((entry) => ({ module: entry, can_view: true, can_add: true, can_edit: true, can_delete: true, can_manage: true }));
    }
    rows = rows.filter((row) => this.filters.every(([key, value]) => (this.table === "role_permissions" || this.table === "user_profiles")
      || (key === "contractor_filter.contractor_id" ? row.communication_contractors.some((link) => link.contractor_id === value) : row[key] === value)));
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
    module: output, exports: output.exports, Request, Response, URL, URLSearchParams, Headers, console,
    process: { env: { NEXT_PUBLIC_SUPABASE_URL: "https://synthetic.invalid", NEXT_PUBLIC_SUPABASE_ANON_KEY: "synthetic", SUPABASE_SERVICE_ROLE_KEY: "synthetic-server-only" } },
    require: (name) => {
      if (name === "server-only") return {};
      if (name === "@supabase/supabase-js") return { createClient: () => admin };
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
assert.equal(loadedConfig.settings.credential_configured, false);
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
  ...message, id: uuid(index + 100), created_at: new Date(Date.UTC(2026, 9, 18, 20, 0, -index)).toISOString(),
  communication_contractors: [{ contractor_id: index % 2 ? 1 : 2, contractors: { company_name: index % 2 ? "Synthetic One" : "Synthetic Two" } }],
}));
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
