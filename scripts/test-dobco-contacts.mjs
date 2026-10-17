import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const clone = (value) => JSON.parse(JSON.stringify(value));
const uuid = (number) => `00000000-0000-0000-0000-${String(number).padStart(12, "0")}`;
const contacts = [];
const profiles = [{ auth_user_id: uuid(900), name: "Synthetic User", email: "user@example.invalid", role: "Read Only", status: "Inactive" }];
const profilesBefore = clone(profiles);
const actor = { auth_user_id: uuid(901), name: "Synthetic Admin", email: "admin@example.invalid" };
const blank = {
  contact_name: "Synthetic Contact", email: null, mobile_phone: null, is_active: true,
  receives_internal_email: false, receives_internal_sms: false, sms_consent_recorded: false,
  sms_consent_date: null, sms_consent_source_or_note: null, user_profile_id: null,
};
let authenticated = true, activeActor = true, systemAdministrator = false;
let view = true, manage = true, userView = true;
let readFailure = false, writeFailure = false, auditFailure = false;
let writes = 0, userReads = 0;
const audits = [];

class AdminApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}
class Query {
  constructor(table) {
    assert.ok(["dobco_contacts", "user_profiles"].includes(table), `Unexpected table ${table}`);
    this.table = table;
    this.filters = [];
    this.from = 0;
    this.to = Infinity;
  }
  select(columns) { this.columns = columns.split(","); return this; }
  order() { return this; }
  range(from, to) { this.from = from; this.to = to; return this; }
  eq(field, value) { this.filters.push([field, value]); return this; }
  insert(values) { this.mode = "insert"; this.values = clone(values); return this; }
  update(values) { this.mode = "update"; this.values = clone(values); return this; }
  single() { return Promise.resolve(this.execute(true)); }
  maybeSingle() { return Promise.resolve(this.execute(true)); }
  then(resolve, reject) { return Promise.resolve(this.execute(false)).then(resolve, reject); }
  execute(single) {
    if (readFailure || (this.mode && writeFailure)) return { data: null, error: new Error("Synthetic database failure") };
    if (this.table === "user_profiles") {
      userReads++;
      assert.equal(this.mode, undefined, "User profiles must never be mutated");
      assert.ok(this.columns.every((key) => ["auth_user_id", "name", "email"].includes(key)), "Only minimal optional-link fields may be read");
    }
    const table = this.table === "dobco_contacts" ? contacts : profiles;
    let rows = table.filter((row) => this.filters.every(([key, value]) => row[key] === value));
    if (this.mode) {
      assert.equal(this.table, "dobco_contacts");
      assert.deepEqual(Object.keys(this.values).sort(), Object.keys(blank).sort(), "Only contact input fields can be written");
      if (this.mode === "insert") {
        const contact = { ...this.values, id: uuid(contacts.length + 1), created_at: "2026-10-17T12:00:00Z", updated_at: "2026-10-17T12:00:00Z" };
        contacts.push(contact);
        rows = [contact];
      } else {
        assert.deepEqual(this.filters.map(([key]) => key), ["id"], "Updates must be bound to route contact ID");
        for (const row of rows) Object.assign(row, this.values);
      }
      writes += rows.length;
    }
    rows = rows.slice(this.from, this.to + 1).map((row) => Object.fromEntries(this.columns.map((key) => [key, row[key]])));
    return { data: clone(single ? rows[0] ?? null : rows), error: null };
  }
}
const context = { admin: { from: (table) => new Query(table) }, profile: actor };
const serverAdmin = {
  AdminApiError,
  requireModulePermission: async (_request, module, action) => {
    if (!authenticated) throw new AdminApiError("Authentication required", 401);
    if (!activeActor) throw new AdminApiError("Inactive actor", 403);
    assert.ok(module === "settings" || (module === "users" && action === "view"), "No new User Management permissions");
    const allowed = module === "users" ? userView : action === "view" ? view : manage;
    if (!systemAdministrator && !allowed) throw new AdminApiError("Permission denied", 403);
    return context;
  },
  jsonError: (error) => Response.json({ error: error.message }, { status: error.status ?? 500 }),
  writeAdministrationAudit: async (_admin, auditActor, action, objectType, id, label, details) => {
    if (auditFailure) throw new Error("Synthetic audit failure");
    assert.equal(auditActor, actor);
    audits.push({ action, objectType, id, label, details });
  },
};
const cache = new Map();
function load(relative) {
  if (cache.has(relative)) return cache.get(relative);
  const output = { exports: {} };
  cache.set(relative, output.exports);
  const code = ts.transpileModule(fs.readFileSync(path.join(root, relative), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(code, {
    module: output, exports: output.exports, Response, Request, Date, Error,
    require: (name) => {
      if (name === "server-only") return {};
      if (name === "@/lib/server-admin") return serverAdmin;
      if (name.startsWith("@/types/")) return load(`types\\${name.slice(8)}.ts`);
      if (name.startsWith("@/lib/")) return load(`src\\lib\\${name.slice(6)}.ts`);
      throw new Error(`Unexpected dependency ${name}`);
    },
  });
  return output.exports;
}
const list = load("src\\app\\api\\admin\\dobco-contacts\\route.ts");
const detail = load("src\\app\\api\\admin\\dobco-contacts\\[id]\\route.ts");
const options = load("src\\app\\api\\admin\\dobco-contacts\\user-options\\route.ts");
const { parseDobcoContact: parse, dobcoRecipientEligibility: eligible } = load("src\\lib\\dobco-contacts.ts");
const request = (method = "GET", body) => new Request("http://localhost/api/admin/dobco-contacts", {
  method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
});
const post = (body) => list.POST(request("POST", body));
const patch = (body, id = uuid(1)) => detail.PATCH(request("PATCH", body), { params: Promise.resolve({ id }) });
const assertEligibility = (contact, email, sms) => assert.equal(JSON.stringify(eligible(contact)), JSON.stringify({ email, sms }));
const contactInput = (contact) => Object.fromEntries(Object.keys(blank).map((key) => [key, contact[key]]));

authenticated = false;
for (const response of [await list.GET(request()), await post(blank), await patch(blank), await options.GET(request())]) assert.equal(response.status, 401);
authenticated = true;
activeActor = false;
assert.equal((await post(blank)).status, 403);
activeActor = true;
view = false;
assert.equal((await list.GET(request())).status, 403);
view = true;
manage = false;
assert.equal((await list.GET(request())).status, 200);
assert.equal((await post(blank)).status, 403);
assert.equal((await patch(blank)).status, 403);
assert.equal((await patch(blank, uuid(2))).status, 403, "Changing ID cannot bypass manage permission");
assert.equal((await options.GET(request())).status, 403);
assert.equal(writes, 0);
manage = true;
userView = false;
assert.equal((await post(blank)).status, 201, "No login, profile, or user-view permission is required for an unlinked contact");
assert.equal(userReads, 0);
assert.equal(contacts[0].user_profile_id, null);
assert.equal((await options.GET(request())).status, 403);
assert.equal((await patch({ ...blank, user_profile_id: profiles[0].auth_user_id })).status, 403);
assert.equal(contacts[0].user_profile_id, null);
userView = true;
assert.equal((await options.GET(request())).status, 200);
assert.equal((await patch({ ...blank, user_profile_id: uuid(999) })).status, 400);
assert.equal((await patch({ ...blank, user_profile_id: profiles[0].auth_user_id })).status, 200);
assert.equal(contacts[0].contact_name, blank.contact_name, "Linking does not copy name/email/status");
assert.equal(contacts[0].email, null);
assert.equal(contacts[0].is_active, true, "Linked account status does not control Dobco Contact status");
userView = false;
assert.equal((await patch({ ...contactInput(contacts[0]), mobile_phone: "  555 0100  " })).status, 200, "Existing link can be preserved without new User Management access");
assert.equal(contacts[0].mobile_phone, "555 0100");
assert.equal(contacts[0].sms_consent_recorded, false);
assert.equal(contacts[0].receives_internal_sms, false);
assert.equal(contacts[0].sms_consent_date, null);
assert.equal(contacts[0].sms_consent_source_or_note, null);
assertEligibility(contacts[0], false, false);
assert.equal((await patch({ ...contactInput(contacts[0]), user_profile_id: null })).status, 200);

const all = { ...blank, email: "person@example.invalid", mobile_phone: "555 0100", receives_internal_email: true,
  receives_internal_sms: true, sms_consent_recorded: true, sms_consent_date: "2026-10-17", sms_consent_source_or_note: "  Explicit synthetic consent  " };
assert.equal((await patch(all)).status, 200);
assert.equal(contacts[0].sms_consent_source_or_note, "Explicit synthetic consent");
assertEligibility(contacts[0], true, true);
assertEligibility({ ...contacts[0], email: " " }, false, true);
assertEligibility({ ...contacts[0], mobile_phone: null }, true, false);
assertEligibility({ ...contacts[0], sms_consent_recorded: false }, true, false);
assertEligibility({ ...contacts[0], receives_internal_email: false, receives_internal_sms: false }, false, false);
assert.equal((await patch({ ...all, is_active: false })).status, 200);
assert.equal(contacts.length, 1, "Deactivation preserves the contact");
assertEligibility(contacts[0], false, false);
assert.equal((await list.GET(request())).status, 200);
assert.equal((await (await list.GET(request())).json()).contacts[0].is_active, false);
assert.equal((await patch(all)).status, 200, "Activation restores only the saved status/settings");
assert.equal((await post({ ...blank, contact_name: "Second synthetic contact" })).status, 201);
const secondBefore = clone(contacts[1]);
assert.equal((await patch({ ...all, contact_name: "Changed First" }, uuid(1))).status, 200);
assert.deepEqual(contacts[1], secondBefore, "Updating one contact cannot change another");
assert.equal((await patch({ ...blank, contact_name: "Changed Second" }, uuid(2))).status, 200);
assert.equal(contacts[0].contact_name, "Changed First");

const beforeInvalid = clone(contacts);
for (const key of ["id", "created_at", "updated_at", "auth_user_id", "name", "role", "status", "entra_object_id", "actor"]) {
  assert.equal((await patch({ ...all, [key]: uuid(2) })).status, 400, `Reject mass assignment: ${key}`);
}
for (const input of [null, [], {}, { ...blank, contact_name: " " }, { ...blank, email: "not-email" },
  { ...blank, mobile_phone: 123 }, { ...blank, is_active: "false" }, { ...blank, sms_consent_recorded: "true" },
  { ...blank, user_profile_id: "not-a-uuid" }, { ...blank, sms_consent_date: "2026-02-30" },
  { ...blank, sms_consent_date: "0000-01-01" }]) {
  assert.equal((await patch(input)).status, 400);
}
assert.equal((await patch(blank, "not-an-id")).status, 400);
assert.equal((await patch(blank, uuid(999))).status, 404);
const malformed = new Request("http://localhost/api/admin/dobco-contacts", { method: "POST", body: "{" });
assert.equal((await list.POST(malformed)).status, 400);
assert.deepEqual(contacts, beforeInvalid);
assert.equal(parse({ ...blank, sms_consent_date: "2024-02-29" }).sms_consent_date, "2024-02-29");
assert.equal((await patch({ ...blank, mobile_phone: " ", email: "" })).status, 200, "Contact channels remain optional");
assert.equal(contacts[0].mobile_phone, null);
assert.equal(contacts[0].email, null);
assert.equal(list.DELETE, undefined);
assert.equal(detail.DELETE, undefined, "No delete API");
assert.deepEqual(profiles, profilesBefore, "Existing identities, roles, and statuses never change");
assert.ok(audits.every((entry) => entry.objectType === "dobco_contact"));
assert.ok(audits.every((entry) => (entry.details?.changed_fields ?? []).every((key) => Object.hasOwn(blank, key))));

// Exercise pagination without writing fixtures to an external system.
for (let index = 3; index <= 503; index++) contacts.push({ ...blank, id: uuid(index) });
assert.equal((await (await list.GET(request())).json()).contacts.length, 503);
readFailure = true;
assert.equal((await list.GET(request())).status, 500);
assert.equal((await patch(blank)).status, 500);
readFailure = false;
writeFailure = true;
assert.equal((await post(blank)).status, 500);
assert.equal((await patch(blank)).status, 500);
writeFailure = false;
auditFailure = true;
assert.equal((await patch(blank)).status, 500, "Audit failure cannot appear as success");
auditFailure = false;
systemAdministrator = true;
manage = false;
assert.equal((await patch(blank)).status, 200, "Existing system administrator override remains supported");
console.log("PASS: standalone contact create/edit/status, optional user link, ID/field validation, authorization, pagination, consent defaults, eligibility, audit/error handling; no user mutations.");
