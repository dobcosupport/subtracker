import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const cache = new Map();
const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const env = { AZURE_KEY_VAULT_AUTH_MODE: "vercel_oidc", AZURE_TENANT_ID: id(1), AZURE_CLIENT_ID: id(2) };
let settings = { channel: "email", provider: "microsoft_365", enabled: true, automated_enabled: false,
  microsoft_tenant_id: id(1), microsoft_client_id: id(2), from_name: "Portable Sender",
  from_address: "sender@example.invalid", reply_to_address: "reply@example.invalid", revision: 1 };
let state = null, manage = true, view = true, deliveryManage = true, tokenFailure = false, fetchFailure = false, graphStatus = 202, dbFailure = false;
let fetches = [], scopes = [], assertions = 0, vaultReads = 0, authWrites = 0;
const messages = new Map();
let composeStatus = "Draft";
let composeDraft = { id: id(20), subject: "Saved Subject", body: "Saved snapshot body",
  sender_address: settings.from_address, reply_to_address: settings.reply_to_address,
  recipients: [{ email: "one@example.invalid" }, { email: "two@example.invalid" }] };
class AdminApiError extends Error { constructor(message, status) { super(message); this.status = status; } }
const admin = {
  from(table) {
    const query = { select() { return this; }, eq() { return this; },
      async single() { return { data: settings, error: null }; },
      async maybeSingle() { return { data: state, error: dbFailure ? {} : null }; } };
    assert.ok(["communication_channel_settings", "microsoft_email_connection_state"].includes(table));
    return query;
  },
  async rpc(name, input) {
    if (dbFailure) return { error: {} };
    if (name === "record_microsoft_authentication") {
      authWrites++;
      state = { settings_revision: input.p_revision, authentication_status: input.p_category ? "Test Failed" : "Verified",
        diagnostic_category: input.p_category, delivery_status: "Not Tested" };
    } else if (name === "reserve_microsoft_test_email") {
      if (!state || state.authentication_status !== "Verified" || state.settings_revision !== input.p_revision || messages.has(input.p_request_id)) return { error: {} };
      messages.set(input.p_request_id, { status: "Sending", recipient: input.p_recipient, sender: settings.from_address });
    } else if (name === "finish_microsoft_test_email") {
      const message = messages.get(input.p_message_id);
      message.status = input.p_outcome === "accepted" ? "Sent" : "Failed";
      message.outcome = input.p_outcome;
      state.delivery_status = input.p_outcome === "accepted" ? "Accepted by Graph" : input.p_outcome === "outcome_unknown" ? "Outcome Unknown" : "Test Failed";
    } else if (name === "reserve_communication_email_send") {
      if (!deliveryManage || composeStatus !== "Draft" || !state || state.settings_revision !== input.p_settings_revision
        || state.authentication_status !== "Verified" || state.delivery_status !== "Accepted by Graph" || !settings.enabled
        || settings.automated_enabled !== false) return { error: { code: "22023", message: "Compose Email is not ready." } };
      composeStatus = "Sending";
      return { data: structuredClone(composeDraft), error: null };
    } else if (name === "finish_communication_email_send") {
      if (composeStatus !== "Sending") return { error: { code: "22023", message: "Email cannot be finalized." } };
      composeStatus = input.p_outcome === "accepted" ? "Sent" : "Failed";
    } else assert.fail(name);
    return { error: null };
  },
};
function load(file) {
  if (cache.has(file)) return cache.get(file);
  const output = { exports: {} }; cache.set(file, output.exports);
  const code = ts.transpileModule(fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, { module: output, exports: output.exports, Request, Response, URL, Buffer, AbortSignal, process: { env },
    // No real network or console is available to provider code.
    fetch: async (url, options) => {
      fetches.push({ url, options });
      if (fetchFailure) throw new Error("SENSITIVE_TOKEN_AND_PROVIDER_DETAIL");
      return new Response(null, { status: graphStatus });
    },
    require(name) {
      if (name === "server-only") return {};
      if (name === "@vercel/oidc") return { getVercelOidcToken: async (...args) => {
        assert.equal(args.length, 0); assertions++; return "SENSITIVE_ASSERTION";
      } };
      if (name === "@azure/identity") return { ClientAssertionCredential: class {
        constructor(tenant, client, callback) { assert.equal(tenant, env.AZURE_TENANT_ID); assert.equal(client, env.AZURE_CLIENT_ID); this.callback = callback; }
        async getToken(scope) {
          scopes.push(scope); await this.callback();
          if (tokenFailure) throw new Error("SENSITIVE_AUTH_DETAIL");
          return { token: "SENSITIVE_TOKEN", expiresOnTimestamp: Date.now() + 60000 };
        }
      } };
      if (name === "@/lib/server-admin") return { AdminApiError, requireModulePermission: async (request, module, action) => {
        if (module === "settings" && (action === "manage" ? !manage : !view)) throw new AdminApiError("Denied", 403);
        if (module === "communications_delivery" && (action !== "manage" || !deliveryManage)) throw new AdminApiError("Denied", 403);
        return { admin, profile: { auth_user_id: id(3) } };
      } };
      if (name === "@/lib/server-provider-credentials") return { CredentialStoreError: AdminApiError, getProviderCredential: async () => { vaultReads++; assert.fail("Microsoft must not read a stored credential"); } };
      if (name === "@/lib/server-communications") return {
        settingsColumns: "non-secret-settings",
        checkDatabaseError(error) { if (error) throw new AdminApiError(error.message, error.code === "42501" ? 403 : 400); },
        communicationError(error) { return Response.json({ error: error.message ?? "Communication operation failed." }, { status: error.status ?? 500, headers: { "Cache-Control": "no-store" } }); },
      };
      if (name.startsWith("@/lib/")) return load(`src/lib/${name.slice(6)}.ts`);
      if (name.startsWith("@/types/")) return load(`types/${name.slice(8)}.ts`);
      assert.fail(name);
    },
  }, { filename: file });
  return output.exports;
}
const route = load("src/app/api/admin/microsoft-email/route.ts");
const sendRoute = load("src/app/api/communications/[id]/send/route.ts");
const request = (action, extra = {}) => new Request("https://synthetic.invalid/api/admin/microsoft-email",
  { method: "POST", body: JSON.stringify({ action, revision: settings.revision, ...extra }) });
const get = () => route.GET(new Request("https://synthetic.invalid/api/admin/microsoft-email"));
const post = (action, extra) => route.POST(request(action, extra));
const sendPost = (messageId, body = { confirmed: true }) => sendRoute.POST(
  new Request(`https://synthetic.invalid/api/communications/${messageId}/send`, { method: "POST", body: JSON.stringify(body) }),
  { params: Promise.resolve({ id: messageId }) },
);
async function check(response, code) {
  assert.equal(response.status, code, await response.clone().text());
  const text = await response.text();
  assert.doesNotMatch(text, /SENSITIVE_/);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  return JSON.parse(text);
}
assert.equal((await check(await get(), 200)).overall_status, "Not Verified");
manage = false;
await check(await post("authenticate"), 403); assert.equal(assertions, 0);
manage = true; view = false;
await check(await get(), 403); view = true;
await check(await post("send_test", { recipient: "test@example.invalid", confirmed: true, request_id: id(10) }), 409);
await check(await post("authenticate"), 200);
assert.equal(fetches.length, 0, "Authentication test makes no Graph/mailbox request");
assert.equal(messages.size, 0, "Authentication creates no Draft/message");
assert.equal(authWrites, 1);
assert.equal(scopes[0], "https://graph.microsoft.com/.default");
let status = await check(await get(), 200);
assert.equal(status.authentication_status, "Verified"); assert.equal(status.delivery_status, "Not Tested");
assert.equal(status.overall_status, "Ready for Test Email");
assert.equal(vaultReads, 0);
await check(await sendPost(composeDraft.id), 400);
assert.equal(fetches.length, 0, "Compose remains blocked until the deliberate provider test Email is accepted");
await check(await post("send_test", { recipient: "test@example.invalid", confirmed: false, request_id: id(10) }), 400);
await check(await post("send_test", { recipient: "test@example.invalid", confirmed: true, request_id: id(10), from: "arbitrary@example.invalid" }), 400);
await check(await post("send_test", { recipient: "test@example.invalid", confirmed: true, request_id: id(10) }), 200);
assert.equal(fetches.length, 1);
assert.equal(fetches[0].url, "https://graph.microsoft.com/v1.0/users/sender%40example.invalid/sendMail");
const message = JSON.parse(fetches[0].options.body).message;
const adapter = load("src/lib/server-email-provider.ts");
assert.equal(message.subject, adapter.MICROSOFT_TEST_SUBJECT);
assert.equal(message.body.content, adapter.MICROSOFT_TEST_BODY);
const migration = fs.readFileSync(new URL("../supabase/20261102_microsoft_email_oidc_tests.sql", import.meta.url), "utf8");
assert.ok(migration.includes(`'${message.subject}'`), "SQL snapshot preserves the exact test subject");
assert.ok(migration.includes(`'${message.body.content}'`), "SQL snapshot preserves the exact sent body");
assert.equal(Object.hasOwn(message, "from"), false, "Graph sender mailbox is selected only by the saved sender URL");
assert.equal(message.replyTo[0].emailAddress.address, settings.reply_to_address);
assert.equal(message.toRecipients[0].emailAddress.address, "test@example.invalid");
assert.equal(messages.get(id(10)).status, "Sent");
assert.equal((await check(await get(), 200)).overall_status, "Verified");
assert.equal(settings.automated_enabled, false);
const beforeUnconfirmedCompose = fetches.length;
await check(await sendPost(composeDraft.id, { confirmed: false }), 400);
await check(await sendPost(composeDraft.id, { confirmed: true, from: "arbitrary@example.invalid" }), 400);
assert.equal(fetches.length, beforeUnconfirmedCompose, "Compose requires an exact explicit confirmation");
await check(await sendPost(composeDraft.id), 200);
assert.equal(composeStatus, "Sent");
assert.equal(fetches.length, beforeUnconfirmedCompose + 1);
const composeCall = fetches.at(-1);
assert.equal(composeCall.url, "https://graph.microsoft.com/v1.0/users/sender%40example.invalid/sendMail");
const composeMessage = JSON.parse(composeCall.options.body).message;
assert.equal(composeMessage.subject, "Saved Subject");
assert.equal(composeMessage.body.content, "Saved snapshot body");
assert.deepEqual(composeMessage.toRecipients.map((item) => item.emailAddress.address), ["one@example.invalid", "two@example.invalid"]);
assert.equal(composeMessage.replyTo[0].emailAddress.address, settings.reply_to_address);
assert.equal(Object.hasOwn(composeMessage, "from"), false);
const duplicateComposeCalls = fetches.length;
await check(await sendPost(composeDraft.id), 400);
assert.equal(fetches.length, duplicateComposeCalls, "A completed Compose send cannot be replayed");
composeDraft = { ...composeDraft, id: id(21), subject: "Rejected Subject" };
composeStatus = "Draft"; graphStatus = 403;
await check(await sendPost(composeDraft.id), 502);
assert.equal(composeStatus, "Failed", "Definite Graph rejection is logged as Failed");
composeDraft = { ...composeDraft, id: id(22), subject: "Unknown Subject" };
composeStatus = "Draft"; fetchFailure = true;
const beforeUnknownCompose = fetches.length;
await check(await sendPost(composeDraft.id), 502);
assert.equal(composeStatus, "Failed", "Uncertain Graph outcome is finalized as Failed for safe no-retry handling");
await check(await sendPost(composeDraft.id), 400);
assert.equal(fetches.length, beforeUnknownCompose + 1, "Unknown outcome never retries automatically");
fetchFailure = false; graphStatus = 202;
const beforeDuplicateTestEmail = fetches.length;
await check(await post("send_test", { recipient: "test@example.invalid", confirmed: true, request_id: id(10) }), 409);
assert.equal(fetches.length, beforeDuplicateTestEmail, "Duplicate request cannot dispatch again");
graphStatus = 403;
await check(await post("send_test", { recipient: "test@example.invalid", confirmed: true, request_id: id(11) }), 502);
assert.equal(messages.get(id(11)).outcome, "graph_rejected");
fetchFailure = true;
await check(await post("send_test", { recipient: "test@example.invalid", confirmed: true, request_id: id(12) }), 502);
assert.equal(messages.get(id(12)).outcome, "outcome_unknown");
assert.equal((await check(await get(), 200)).delivery_status, "Outcome Unknown");
fetchFailure = false; tokenFailure = true;
const countBeforeFailure = fetches.length;
await check(await post("authenticate"), 200);
assert.equal((await check(await get(), 200)).authentication_status, "Test Failed");
assert.equal(fetches.length, countBeforeFailure);
tokenFailure = false;
settings = { ...settings, revision: 2 };
assert.equal((await check(await get(), 200)).authentication_status, "Not Tested");
settings.enabled = false;
await check(await post("authenticate"), 409);
settings.enabled = true; env.AZURE_CLIENT_ID = id(99);
assert.equal((await check(await get(), 200)).identity_status, "Identity Mismatch");
await check(await post("authenticate"), 200);
assert.equal(state.authentication_status, "Test Failed");
assert.equal(state.diagnostic_category, "identity_configuration");
dbFailure = true;
await check(await get(), 503);
dbFailure = false; env.AZURE_CLIENT_ID = id(2);
delete env.AZURE_TENANT_ID;
assert.equal((await check(await get(), 200)).identity_status, "Unavailable");
env.AZURE_TENANT_ID = id(1);
await check(await route.POST(new Request("https://synthetic.invalid/api/admin/microsoft-email",
  { method: "POST", body: "x".repeat(2049) })), 413);
await check(await route.POST(new Request("https://synthetic.invalid/api/admin/microsoft-email",
  { method: "POST", body: "invalid-json" })), 400);
await check(await route.POST(new Request("https://synthetic.invalid/api/admin/microsoft-email",
  { method: "POST", body: JSON.stringify({ action: "authenticate", revision: 1 }) })), 409);
assert.equal(settings.automated_enabled, false);
console.log("PASS: synthetic-only Microsoft OIDC authentication, default audience, secret-free configuration, permission/saved-revision gates, layered status, explicit test recipient/confirmation, configured sender, authoritative reservation, replay rejection, Graph 202 versus delivery, sanitized failures/unknown outcome; no real provider request.");
