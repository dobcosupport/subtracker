import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

const uuid = n => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const accepted = "2026-11-17T21:56:20.81295Z";
const followups = [
  { id: 21, contractor_id: 14, origin_communication_id: uuid(1), followup_date: "2026-12-17" },
  { id: 22, contractor_id: 14, origin_communication_id: null },
  { id: 23, contractor_id: 14, origin_communication_id: null, followup_method: "Email" },
  ...[24, 25, 26, 27].map((id, i) => ({ id, contractor_id: 14, origin_communication_id: uuid(i + 3) })),
];
const messages = [
  { id: uuid(1), status: "Sent", channel: "email", sent_at: accepted, communication_contractors: [{ contractor_id: 14 }] },
  { id: uuid(2), status: "Delivered", channel: "email", sent_at: "2026-11-18T02:00:00Z", communication_contractors: [{ contractor_id: 14 }] },
  { id: uuid(3), status: "Failed", channel: "email", sent_at: accepted, communication_contractors: [{ contractor_id: 14 }] },
  { id: uuid(4), status: "Sent", channel: "sms", sent_at: accepted, communication_contractors: [{ contractor_id: 14 }] },
  { id: uuid(5), status: "Sent", channel: "email", sent_at: null, communication_contractors: [{ contractor_id: 14 }] },
  { id: uuid(6), status: "Sent", channel: "email", sent_at: accepted, communication_contractors: [{ contractor_id: 99 }] },
];
const links = [{ followup_id: 22, message_id: uuid(2) }];
let denied = new Set(), failTable = null;
const reads = [], permissionChecks = [];
class AdminApiError extends Error { constructor(message, status = 500) { super(message); this.status = status; } }
class Query {
  constructor(table) { this.table = table; this.filters = []; this.bounds = [0, Infinity]; reads.push(this); }
  select(columns) { this.columns = columns; assert.doesNotMatch(columns, /body|subject|email|recipient|snapshot/); return this; }
  in(key, values) { this.filters.push(row => values.includes(row[key])); return this; }
  eq(key, value) { this.filters.push(row => row[key] === value); return this; }
  not(key, operator, value) { assert.equal(operator, "is"); this.filters.push(row => row[key] !== value); return this; }
  order() { return this; }
  range(start, end) { this.bounds = [start, end]; return this; }
  returns() { return this; }
  then(resolve, reject) {
    const data = this.table === "contractor_followups" ? followups : this.table === "communication_messages" ? messages
      : this.table === "communication_followups" ? links : assert.fail(this.table);
    const result = failTable === this.table ? { data: null, error: { message: "Synthetic read failure" } }
      : { data: data.filter(row => this.filters.every(filter => filter(row))).slice(this.bounds[0], this.bounds[1] + 1), error: null };
    return Promise.resolve(result).then(resolve, reject);
  }
}
const admin = { from: table => new Query(table) };
const cache = new Map();
function load(file) {
  if (cache.has(file)) return cache.get(file);
  const loaded = { exports: {} };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { module: loaded, exports: loaded.exports, Request, Response, URL, Intl, require(name) {
    if (name === "server-only") return {};
    if (name === "@/lib/server-admin") return { AdminApiError,
      jsonError: error => Response.json({ error: error.message }, { status: error.status ?? 500 }),
      requireModulePermission: async (_request, module, action) => {
        permissionChecks.push([module, action]);
        if (denied.has(module)) throw new AdminApiError("Permission denied", 403);
        return { admin };
      } };
    if (name.startsWith("@/lib/")) return load(`src/lib/${name.slice(6)}.ts`);
    assert.fail(`Unexpected dependency ${name}`);
  } });
  cache.set(file, loaded.exports);
  return loaded.exports;
}
const { followupEmailOrigins } = load("src/lib/server-followup-email.ts");
const { emailSentDate } = load("src/lib/followup-email.ts");
const endpoint = load("src/app/api/followups/email-origins/route.ts");

test("ABCO authoritative acceptance is separate from unchanged due date; historical links derive without backfill", async () => {
  const before = JSON.stringify({ followups, links, messages });
  const result = await followupEmailOrigins(admin, followups.map(row => row.id));
  assert.equal(result[21].communication_id, uuid(1));
  assert.equal(result[21].sent_at, accepted);
  assert.equal(emailSentDate(result[21].sent_at), "11/17/2026");
  assert.equal(followups[0].followup_date, "2026-12-17");
  assert.equal(result[22].communication_id, uuid(2), "Existing legacy communication link needs no origin-column backfill");
  assert.equal(emailSentDate(result[22].sent_at), "11/17/2026", "Uses the same Eastern calendar as acceptance-based due dates, not browser/UTC date");
  for (const id of [23, 24, 25, 26, 27]) assert.equal(result[id], null, "Manual method Email, Failed, SMS, missing timestamp or another contractor never fabricate a date");
  assert.equal(JSON.stringify({ followups, links, messages }), before, "Read projection never rewrites data");
});

test("legacy multiple links use earliest successful Email, while explicit origin never falls back to another message", async () => {
  links.push({ followup_id: 22, message_id: uuid(1) }, { followup_id: 24, message_id: uuid(1) });
  const result = await followupEmailOrigins(admin, [22, 24]);
  assert.equal(result[22].communication_id, uuid(1));
  assert.equal(result[24], null);
  links.splice(1);
});

test("all historical links are paginated without default API row-limit truncation", async () => {
  const before = links.length;
  for (let i = 0; i < 501; i++) links.push({ followup_id: 22, message_id: uuid(100 + i) });
  const start = reads.length;
  await followupEmailOrigins(admin, [22]);
  assert.deepEqual(reads.slice(start).filter(row => row.table === "communication_followups").map(row => row.bounds), [[0, 499], [500, 999]]);
  links.splice(before);
});

test("read failures and invalid stored timestamps are explicit, not success-shaped N/A", async () => {
  for (const table of ["contractor_followups", "communication_followups", "communication_messages"]) {
    failTable = table;
    await assert.rejects(followupEmailOrigins(admin, [21]), /Synthetic read failure/);
  }
  failTable = null;
  messages[0].sent_at = "bad date";
  await assert.rejects(followupEmailOrigins(admin, [21]), /timestamp is invalid/);
  messages[0].sent_at = accepted;
});

test("read-only API enforces Follow-Ups and Contractors View, bounds IDs and exposes only origin identity/date", async () => {
  const request = ids => new Request(`https://fixture.invalid/api/followups/email-origins?ids=${ids}`);
  for (const permission of ["followups", "contractors"]) {
    denied = new Set([permission]);
    assert.equal((await endpoint.GET(request("21"))).status, 403);
  }
  denied.clear();
  for (const ids of ["", "0", "-1", "abc", "2147483648", Array(201).fill("21").join(",")]) {
    assert.equal((await endpoint.GET(request(ids))).status, 400);
  }
  const response = await endpoint.GET(request("21,23"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  const data = await response.json();
  assert.deepEqual(Object.keys(data.origins[21]).sort(), ["communication_id", "sent_at"]);
  assert.equal(data.origins[23], null);
  assert.ok(permissionChecks.some(([module, action]) => module === "followups" && action === "view"));
  assert.equal(endpoint.POST, undefined);
});
