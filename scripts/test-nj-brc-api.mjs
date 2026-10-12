import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const input = require(path.join(root, "worker", "nj-brc", "input.js"));
const uuid = "12345678-1234-4234-8234-123456789012";
const instanceId = "12345678-1234-4234-8234-123456789013";
const rawFein = "00-1234567";
const submission = "001234567000";
const contractor = { id: 42, company_name: "Synthetic Contractor", active: true, nj_brc_number: "0012345678", brc_name_control: "AB&C", federal_tax_id: rawFein };
const snapshot = { ...contractor, id: uuid, contractor_id: 42, status: "review_required", taxpayer_id_submission: submission, review_queue_id: 17, created_at: "2026-10-09T12:00:00Z" };
const certificate = {
  kind: "successful_certificate", taxpayer_name: "Synthetic Contractor", certificate_number: "987654321",
  effective_date: "2026-10-01", source_url: "https://www1.state.nj.us/TYTR_BRC/jsp/BRCLoginJsp.jsp",
  verified_at: "2026-10-09T12:00:00Z", discrepancy_warnings: [],
};

class ApiError extends Error {
  constructor(message, status = 500) { super(message); this.status = status; }
}
function load(relative, dependencies, env = {}) {
  const source = fs.readFileSync(path.join(root, relative), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const loadedModule = { exports: {} };
  vm.runInNewContext(compiled, {
    module: loadedModule, exports: loadedModule.exports,
    require: (name) => name in dependencies ? dependencies[name] : require(name),
    Request, Response, URL, Date, Buffer, process: { env },
  }, { filename: relative });
  return loadedModule.exports;
}
function fixture({ rows = {}, permissionError, rpcError, userRpcResult, adminRpcResult, available = true, healthError, env = {} } = {}) {
  const calls = [];
  const pools = Object.fromEntries(Object.entries(rows).map(([table, results]) => [table, [...results]]));
  const admin = {
    from(table) {
      calls.push({ table });
      const data = table === "compliance_sync_workers" ? { worker_key: "nj-brc" } : pools[table]?.shift() ?? null;
      const result = { data, error: table === "compliance_sync_workers" ? healthError : null };
      const query = new Proxy({}, { get(_target, method) {
        if (method === "then") return (resolve) => Promise.resolve(result).then(resolve);
        return (...args) => { calls.push({ table, method, args }); return query; };
      } });
      return query;
    },
    async rpc(name, args) { calls.push({ kind: "service-rpc", name, args }); return { data: adminRpcResult ?? true, error: rpcError ?? null }; },
  };
  const serverAdmin = {
    AdminApiError: ApiError, createAdminClient: () => admin,
    async requireModulePermission(_request, module, action) {
      calls.push({ kind: "permission", module, action });
      if (permissionError) throw permissionError;
      return { admin };
    },
  };
  const environment = { NEXT_PUBLIC_SUPABASE_URL: "https://synthetic.example", NEXT_PUBLIC_SUPABASE_ANON_KEY: "synthetic-anon", NJ_BRC_WORKER_KEY: "synthetic-brc-key", ...env };
  const helper = load("src\\lib\\server-nj-brc-worker.ts", {
    "server-only": {},
    "@/lib/server-admin": serverAdmin,
    "@/lib/worker-health": { classifyWorker: () => ({ available }) },
    "@supabase/supabase-js": {
      createClient(url, key, options) {
        calls.push({ kind: "user-client", url, key, options });
        return { async rpc(name, args) {
          calls.push({ kind: "user-rpc", name, args });
          return { data: userRpcResult ?? [{ id: uuid, status: "pending", federal_tax_id_masked: "***-**-4567", taxpayer_id_submission_masked: "********7000" }], error: rpcError ?? null };
        } };
      },
    },
  }, environment);
  const dependencies = { "@/lib/server-admin": serverAdmin, "@/lib/server-nj-brc-worker": helper, "../../../../../worker/nj-brc/input": input };
  const healthDependencies = {
    ...dependencies,
    "@/lib/server-compliance-sync": {
      requireRpaKey: async () => Response.json({ error: "Unauthorized." }, { status: 401 }),
      jsonError: helper.njBrcError,
      isResultStatus: (value) => ["Match Found", "No Match Found", "Website Error", "RPA Error"].includes(value),
    },
  };
  return {
    calls, helper,
    search: load("src\\app\\api\\contractors\\nj-brc-search\\route.ts", dependencies),
    review: load("src\\app\\api\\admin\\compliance-sync\\nj-brc-review\\route.ts", dependencies),
    worker: load("src\\app\\api\\integrations\\compliance-sync\\nj-brc\\route.ts", dependencies),
    health: load("src\\app\\api\\integrations\\compliance-sync\\worker-health\\route.ts", healthDependencies, environment),
  };
}
function request(body, headers = {}, suffix = "") {
  return new Request(`https://synthetic.example/api${suffix}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: "Bearer synthetic-user-jwt", "x-subtracker-brc-key": "synthetic-brc-key", ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}
const userRpcs = (f) => f.calls.filter((call) => call.kind === "user-rpc");
const serviceRpcs = (f) => f.calls.filter((call) => call.kind === "service-rpc");

test("worker auth uses only the distinct BRC header and authenticates before creating a service client", async () => {
  const f = fixture();
  for (const headers of [
    { "x-subtracker-brc-key": "", "x-subtracker-rpa-key": "synthetic-brc-key" },
    { "x-subtracker-brc-key": "bad" },
    { "x-subtracker-brc-key": "synthetic-brc-kex" },
  ]) assert.equal((await f.worker.GET(request(undefined, headers, `?instance_id=${instanceId}`))).status, 401);
  assert.equal(serviceRpcs(f).length, 0);
  assert.equal((await fixture({ env: { NJ_BRC_WORKER_KEY: "" } }).worker.GET(request(undefined, {}, `?instance_id=${instanceId}`))).status, 401);
});
test("search requires contractors/manage and does not perform work after denied access", async () => {
  const f = fixture({ permissionError: new ApiError("Forbidden.", 403) });
  assert.equal((await f.search.POST(request({ contractor_id: 42 }))).status, 403);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0], { kind: "permission", module: "contractors", action: "manage" });
});
test("request body parsing rejects malformed JSON, arrays, primitives, null, and FEIN overrides", async () => {
  for (const body of ["{", "[]", "null", '"text"', { contractor_id: 42, federal_tax_id: rawFein }, { contractor_id: 42, nj_brc_number: "other" }]) {
    const f = fixture();
    assert.equal((await f.search.POST(request(body))).status, 400);
    assert.equal(userRpcs(f).length, 0);
  }
});
test("positive integer IDs reject coercion, booleans, fractions, unsafe values, and out-of-range DB values", async () => {
  for (const id of [null, true, [], {}, "", "0", "-1", "1.0", "1e2", " 42 ", "042", 0, -1, 1.5, 2147483648]) {
    const f = fixture();
    assert.equal((await f.search.POST(request({ contractor_id: id }))).status, 400);
    assert.equal(f.calls.filter((call) => call.table).length, 0);
  }
});
test("GET masks raw identifiers and embedded evidence without modifying certificate numbers", async () => {
  const f = fixture({ rows: { nj_brc_search_requests: [{
    ...snapshot, result_evidence: {
      ...certificate, federal_tax_id: rawFein, taxpayer_id_submission: submission,
      match_rationale: `Lookup ${rawFein}/${submission}`, discrepancy_warnings: ["FEIN 001234567"],
    },
  }], contractors: [contractor] }, available: false });
  const response = await f.search.GET(request(undefined, {}, "?contractor_id=42"));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.request.federal_tax_id, undefined);
  assert.equal(body.request.taxpayer_id_submission, undefined);
  assert.equal(body.request.federal_tax_id_masked, "***-**-4567");
  assert.equal(body.request.taxpayer_id_submission_masked, "********7000");
  assert.equal(body.request.result_evidence.certificate_number, "987654321");
  assert.equal(body.request.current_contractor.company_name, contractor.company_name);
  assert.equal(body.request.current_contractor.federal_tax_id_masked, "***-**-4567");
  assert.equal(body.request.current_contractor.federal_tax_id, undefined);
  assert.doesNotMatch(JSON.stringify(body), /00-1234567|\b001234567000\b|\b001234567\b/);
  assert.equal(f.calls.some((call) => call.table === "compliance_sync_workers"), false);
});
test("review GET uses compliance_sync/view and resolves review_queue_id; missing request is null", async () => {
  const f = fixture();
  const response = await f.search.GET(request(undefined, {}, "?review_id=17"));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { request: null });
  assert.equal(f.calls[0].module, "compliance_sync");
  assert.equal(f.calls[0].action, "view");
  assert.ok(f.calls.some((call) => call.method === "eq" && call.args[0] === "review_queue_id" && call.args[1] === 17));
  assert.equal((await f.search.GET(request(undefined, {}, "?review_id=17&contractor_id=42"))).status, 400);
});
test("active duplicates are returned masked even when worker is offline or master changed", async () => {
  for (const status of ["pending", "claimed", "processing", "human_verification_required", "review_required"]) {
    const f = fixture({ rows: { nj_brc_search_requests: [{ ...snapshot, status }] }, available: false });
    const response = await f.search.POST(request({ contractor_id: 42 }));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).request.existing, true);
    assert.equal(f.calls.some((call) => call.table === "contractors" || call.table === "compliance_sync_workers"), false);
    assert.equal(userRpcs(f).length, 0);
  }
});
test("new search requires worker availability and never queues a request offline", async () => {
  const f = fixture({ rows: { contractors: [contractor] }, available: false });
  assert.equal((await f.search.POST(request({ contractor_id: 42 }))).status, 503);
  assert.equal(userRpcs(f).length, 0);
  const schemaFailure = fixture({ rows: { contractors: [contractor] }, healthError: { message: rawFein } });
  const response = await schemaFailure.search.POST(request({ contractor_id: 42 }));
  assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /00-1234567/);
});
test("new search snapshots raw saved inputs via userJWT RPC and one worker-owned transformation helper", async () => {
  const f = fixture({ rows: { contractors: [contractor] } });
  const response = await f.search.POST(request({ contractor_id: "42" }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).request.federal_tax_id_masked, "***-**-4567");
  assert.deepEqual(JSON.parse(JSON.stringify(userRpcs(f)[0])), {
    kind: "user-rpc", name: "create_nj_brc_search_request", args: { p_contractor_id: 42, p_taxpayer_id_submission: submission },
  });
  const userClient = f.calls.find((call) => call.kind === "user-client");
  assert.equal(userClient.options.global.headers.Authorization, "Bearer synthetic-user-jwt");
  assert.equal(userClient.key, "synthetic-anon");
  assert.equal(serviceRpcs(f).length, 0);
  assert.equal(f.calls.some((call) => ["insert", "update", "delete"].includes(call.method)), false);
});
test("invalid saved inputs report precise errors without echoing sensitive values", async () => {
  const invalid = [
    [{ ...contractor, active: false }, /inactive/],
    [null, /not found/],
    [{ ...contractor, nj_brc_number: 1234567890 }, /10 digits/],
    [{ ...contractor, nj_brc_number: "123456789" }, /10 digits/],
    [{ ...contractor, brc_name_control: "ABC" }, /4 approved characters/],
    [{ ...contractor, brc_name_control: "AB!C" }, /4 approved characters/],
    [{ ...contractor, brc_name_control: "AB C" }, /without spaces/],
    [{ ...contractor, federal_tax_id: "AB123456789" }, /expected 9 digits/],
    [{ ...contractor, federal_tax_id: 123456789 }, /expected 9 digits/],
  ];
  for (const [value, error] of invalid) {
    const f = fixture({ rows: { contractors: [value] } });
    const response = await f.search.POST(request({ contractor_id: 42 }));
    assert.equal(response.status, value === null ? 404 : 400);
    assert.match((await response.json()).error, error);
    assert.equal(userRpcs(f).length, 0);
  }
});
test("claim GET unwraps RPC row arrays and empty claims while using atomic service RPC only", async () => {
  for (const result of [[snapshot], []]) {
    const f = fixture({ adminRpcResult: result });
    const response = await f.worker.GET(request(undefined, {}, `?instance_id=${instanceId}`));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.request?.id ?? null, result.length ? uuid : null);
    assert.equal(body.request?.federal_tax_id, undefined);
    assert.equal(serviceRpcs(f)[0].name, "claim_nj_brc_search_request");
    assert.equal(serviceRpcs(f)[0].args.p_worker_instance_id, instanceId);
    assert.equal(f.calls.some((call) => call.table), false);
  }
});
test("worker ownership identifiers must be UUIDs, never coerced numbers", async () => {
  const f = fixture();
  assert.equal((await f.worker.GET(request(undefined, {}, "?instance_id=123"))).status, 400);
  for (const body of [{ request_id: 17, instance_id: instanceId }, { request_id: uuid, instance_id: "invalid" }]) {
    assert.equal((await f.worker.POST(request({ ...body, state: "processing" }))).status, 400);
  }
  assert.equal(serviceRpcs(f).length, 0);
});
test("intermediate worker transitions use ownership RPC and do not store/log raw error text", async () => {
  for (const state of ["processing", "human_verification_required"]) {
    const f = fixture();
    const response = await f.worker.POST(request({ request_id: uuid, instance_id: instanceId, state, error_message: rawFein }));
    assert.equal(response.status, 200);
    assert.equal(serviceRpcs(f)[0].name, "set_nj_brc_search_request_state");
    assert.equal(serviceRpcs(f)[0].args.p_status, state);
    assert.doesNotMatch(JSON.stringify(serviceRpcs(f)), /00-1234567/);
  }
});
test("successful result only stages evidence through service-owned transactional RPC and masks echoed FEIN", async () => {
  const f = fixture({ rows: { nj_brc_search_requests: [snapshot] }, adminRpcResult: [{ request_id: uuid, status: "review_required", review_queue_id: 17 }] });
  const response = await f.worker.POST(request({
    request_id: uuid, instance_id: instanceId,
    result: { ...certificate, match_rationale: `Match with ${rawFein} / ${submission}` },
  }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).request.status, "review_required");
  const call = serviceRpcs(f)[0];
  assert.equal(call.name, "report_nj_brc_search_result");
  assert.equal(call.args.p_result_type, "successful_certificate");
  assert.equal(call.args.p_error_code, null);
  assert.equal(call.args.p_evidence.certificate_number, "987654321");
  assert.doesNotMatch(JSON.stringify(call.args.p_evidence), /00-1234567|001234567000/);
  assert.equal(userRpcs(f).length, 0);
  assert.equal(f.calls.some((call) => call.table === "contractors" || call.table === "compliance_records"), false);
});
test("terminal classifications remain distinct rather than converting website/human/identity failures to no_match", async () => {
  for (const kind of ["no_match", "invalid_input", "identity_mismatch", "ambiguous_result", "website_error", "failed"]) {
    const f = fixture();
    const response = await f.worker.POST(request({ request_id: uuid, instance_id: instanceId, result: { kind, match_rationale: "Explicit source evidence." } }));
    assert.equal(response.status, 200);
    assert.equal(serviceRpcs(f)[0].args.p_result_type, kind);
  }
});
test("successful worker report preserves DB identity-mismatch downgrade and no review linkage", async () => {
  const f = fixture({
    rows: { nj_brc_search_requests: [snapshot] },
    adminRpcResult: [{ request_id: uuid, status: "identity_mismatch", review_queue_id: null, idempotent: false }],
  });
  const response = await f.worker.POST(request({
    request_id: uuid, instance_id: instanceId, result: { ...certificate, taxpayer_name: "A Different Contractor" },
  }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.request.status, "identity_mismatch");
  assert.equal(body.request.review_queue_id, null);
});
test("worker rejects unsupported states, raw fields, malformed results, and mixed state/results", async () => {
  for (const addition of [
    { state: "completed" }, { state: "no_match" }, { result: [] }, { result: { kind: "human_verification_required" } },
    { result: { ...certificate, federal_tax_id: rawFein } }, { result: { ...certificate, expiration_date: "2027-01-01" } },
    { result: { ...certificate, raw_html: "secret" } }, { result: certificate, state: "processing" },
    { result: certificate, error_message: "secret" }, { state: "processing", contractor_id: 7 },
  ]) {
    const f = fixture();
    assert.equal((await f.worker.POST(request({ request_id: uuid, instance_id: instanceId, ...addition }))).status, 400);
    assert.equal(serviceRpcs(f).length, 0);
  }
});
test("certificate evidence validates calendar dates, verified timestamps, and source URL confidentiality", async () => {
  for (const change of [
    { effective_date: "2026-02-30" }, { effective_date: "10/01/2026" }, { verified_at: "not-a-date" },
    { verified_at: "2026-02-30T12:00:00Z" }, { verified_at: "2026-01-01T12:00:00" },
    { taxpayer_name: null }, { certificate_number: "" }, { source_url: "http://www1.state.nj.us/TYTR_BRC/jsp/login" },
    { source_url: "https://www1.state.nj.us.evil.example/TYTR_BRC/jsp/login" },
    { source_url: `https://www1.state.nj.us/TYTR_BRC/jsp/login?fein=${submission}` },
    { source_url: "https://www1.state.nj.us/TYTR_BRC/jsp/login#fragment" },
    { discrepancy_warnings: [7] }, { office_use_only: "x".repeat(4001) },
  ]) {
    const f = fixture();
    assert.equal((await f.worker.POST(request({ request_id: uuid, instance_id: instanceId, result: { ...certificate, ...change } }))).status, 400);
    assert.equal(serviceRpcs(f).length, 0);
  }
});
test("approval resolves review linkage, uses manage-gated userJWT RPC, and returns compliance record ID", async () => {
  const f = fixture({ rows: { nj_brc_search_requests: [snapshot] }, userRpcResult: 99 });
  const response = await f.review.POST(request({ review_id: 17, decision: "approved", notes: `Checked ${rawFein}` }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, compliance_record_id: 99 });
  assert.equal(f.calls[0].module, "compliance_sync");
  assert.equal(f.calls[0].action, "manage");
  assert.equal(userRpcs(f)[0].name, "approve_nj_brc_search_request");
  assert.equal(userRpcs(f)[0].args.p_request_id, uuid);
  assert.doesNotMatch(userRpcs(f)[0].args.p_decision_notes, /00-1234567/);
  assert.equal(serviceRpcs(f).length, 0);
});
test("rejection requires nonblank notes, resolves linked UUID, and uses user JWT", async () => {
  for (const notes of [undefined, null, "", "   "]) {
    const f = fixture();
    assert.equal((await f.review.POST(request({ review_id: 17, decision: "rejected", notes }))).status, 400);
    assert.equal(userRpcs(f).length, 0);
  }
  const f = fixture({ rows: { nj_brc_search_requests: [snapshot] }, userRpcResult: true });
  assert.equal((await f.review.POST(request({ review_id: 17, decision: "rejected", notes: "Identity evidence needs correction." }))).status, 200);
  assert.equal(userRpcs(f)[0].name, "reject_nj_brc_search_request");
});
test("review rejects wrong decision, unknown fields, missing linkage, and oversized notes", async () => {
  for (const payload of [
    { review_id: uuid, decision: "approved" }, { review_id: 17, decision: "approve" },
    { review_id: 17, decision: "approved", contractor_id: 7 }, { review_id: 17, decision: "approved", notes: "x".repeat(2001) },
  ]) {
    const f = fixture();
    assert.equal((await f.review.POST(request(payload))).status, 400);
    assert.equal(userRpcs(f).length, 0);
  }
  assert.equal((await fixture().review.POST(request({ review_id: 17, decision: "approved" }))).status, 404);
});
test("database errors map safe HTTP statuses without exposing FEIN or backend diagnostics", async () => {
  for (const [code, status] of [["42501", 403], ["P0002", 404], ["23514", 400], ["22023", 400], ["23505", 409], ["55000", 409], ["unknown", 500]]) {
    const f = fixture({ rows: { contractors: [contractor] }, rpcError: { code, message: `Database error ${rawFein}`, details: submission } });
    const response = await f.search.POST(request({ contractor_id: 42 }));
    assert.equal(response.status, status);
    assert.doesNotMatch(await response.text(), /00-1234567|001234567000/);
  }
});

const healthReport = {
  worker_key: "nj-brc", instance_id: instanceId, started_at: "2026-10-09T12:00:00Z",
  file_modified_at: "2026-10-09T11:00:00Z", loaded_hash: "a".repeat(64), current_hash: "a".repeat(64),
  sequence: 1, lifecycle: "ready", browser_connected: true, last_poll_at: "2026-10-09T12:00:00Z",
  current_request_key: uuid,
};
test("actual worker-health route accepts BRC UUID telemetry lifecycle and all agreed events", async () => {
  for (const event of ["start", "stop", "search", "error", "test", "human_verification_required",
    "human_verification_completed", "request_processed", "no_match", "invalid_input",
    "identity_mismatch", "ambiguous_result", "website_error", "failed"]) {
    const f = fixture();
    const response = await f.health.POST(request({
      ...healthReport, lifecycle: event === "human_verification_required" ? event : "busy",
      event, request_key: uuid, message: "Synthetic worker event.",
      ...(event === "search" ? { result_status: "Successful Certificate" } : {}),
    }));
    assert.equal(response.status, 200, event);
    const call = serviceRpcs(f)[0];
    assert.equal(call.name, "report_compliance_worker");
    assert.equal(call.args.p_report.worker_key, "nj-brc");
    assert.equal(call.args.p_report.current_request_key, uuid);
    assert.equal(call.args.p_report.request_key, uuid);
  }
});
test("actual worker-health route binds BRC credential to nj-brc only and rejects invalid UUID events", async () => {
  for (const change of [
    { worker_key: "nj-pwc" }, { worker_key: "ny" }, { current_request_key: 17 },
    { request_key: "bad" }, { event: "result_posted", message: "Synthetic" },
    { event: "search", result_status: "Match Found", request_key: uuid, message: "Synthetic" },
    { event: "search", result_status: "Successful Certificate", message: "Synthetic" },
  ]) {
    const f = fixture();
    assert.equal((await f.health.POST(request({ ...healthReport, ...change }))).status, 400);
    assert.equal(serviceRpcs(f).length, 0);
  }
  const f = fixture();
  assert.equal((await f.health.POST(request(healthReport, { "x-subtracker-brc-key": "wrong" }))).status, 401);
  assert.equal(serviceRpcs(f).length, 0);
});
test("actual worker-health route sanitizes FEIN, submitted taxpayer ID, credentials and source URLs", async () => {
  const f = fixture();
  const response = await f.health.POST(request({
    ...healthReport, event: "error",
    message: `${rawFein} ${submission} synthetic-brc-key Bearer synthetic-secret https://synthetic.example/?secret=value`,
  }));
  assert.equal(response.status, 200);
  assert.doesNotMatch(serviceRpcs(f)[0].args.p_report.message, /00-1234567|001234567000|synthetic-brc-key|synthetic-secret|secret=value/);
});
test("actual worker health monitor sends accepted start/human/search/error/recovery/stop payloads to real route", async () => {
  const { createHealthMonitor } = require(path.join(root, "worker", "nj-brc", "health.js"));
  const f = fixture();
  const logs = [];
  const statuses = [];
  const monitor = createHealthMonitor(
    { baseUrl: "https://synthetic.example", workerKey: "synthetic-brc-key" }, () => true,
    (entry) => logs.push(entry), (value) => String(value),
    {
      metadata: () => ({ hash: "a".repeat(64), modified: healthReport.file_modified_at }),
      instanceId, setInterval: () => 1, clearInterval: () => {},
      fetch: async (url, options) => {
        const response = await f.health.POST(new Request(url, options));
        statuses.push(response.status);
        return response;
      },
    },
  );
  monitor.start(); await monitor.flush();
  monitor.ready(); await monitor.flush();
  monitor.polled(); await monitor.flush();
  monitor.busy(uuid); await monitor.flush();
  monitor.humanVerificationRequired(uuid); await monitor.flush();
  monitor.error("Synthetic poll failure.", uuid); await monitor.flush();
  assert.equal(serviceRpcs(f).at(-1).args.p_report.lifecycle, "human_verification_required");
  monitor.humanVerificationCompleted(uuid); await monitor.flush();
  monitor.search(uuid, "Successful Certificate"); await monitor.flush();
  monitor.event("request_processed", "Certificate processed.", { request_id: uuid }); await monitor.flush();
  monitor.websiteError("Synthetic website failure.", uuid); await monitor.flush();
  assert.equal(serviceRpcs(f).at(-1).args.p_report.lifecycle, "website_error");
  monitor.polled(); await monitor.flush();
  assert.equal(serviceRpcs(f).at(-1).args.p_report.lifecycle, "ready");
  await monitor.stop();
  assert.equal(logs.length, 0, JSON.stringify(logs));
  assert.ok(statuses.length >= 12);
  assert.ok(statuses.every((status) => status === 200), statuses.join(","));
  const reports = serviceRpcs(f).map((call) => call.args.p_report);
  assert.ok(reports.some((report) => report.event === "search" && report.result_status === "Successful Certificate" && report.request_key === uuid));
  assert.ok(reports.some((report) => report.event === "request_processed" && report.request_key === uuid));
  assert.ok(reports.every((report) => !report.request_id && !report.current_request_id));
});
