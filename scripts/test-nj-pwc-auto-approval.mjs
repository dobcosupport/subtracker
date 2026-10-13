import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";

// Route-level tests for NJ PWC auto-approval / daily registry sync. The SQL
// functions (classification, versioning, thresholds, Test Mode) are covered
// by the PGlite acceptance harness; these tests verify that routes validate
// input, enforce permissions, call the right RPC with the right actor, and
// map RPC errors without leaking or inventing state.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function load(relative, dependencies) {
  const source = fs.readFileSync(path.join(root, relative), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const loaded = { exports: {} };
  vm.runInNewContext(compiled, {
    module: loaded,
    exports: loaded.exports,
    require(name) {
      assert.ok(name in dependencies, `Unexpected import ${name}`);
      return dependencies[name];
    },
    Request,
    Response,
    URL,
    Date,
    Intl,
    Promise,
    Map,
    Set,
    process: { env: {} },
  }, { filename: relative });
  return loaded.exports;
}

class AdminApiError extends Error {
  constructor(message, status = 500, details) { super(message); this.status = status; this.details = details; }
}
const jsonError = (error) => Response.json({ error: error.message }, { status: error.status ?? 500 });

const profile = { auth_user_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Synthetic Admin", email: "admin@example.test" };

function fakeAdmin({ tables = {}, rpc = {} } = {}) {
  const calls = [];
  return {
    calls,
    from(table) {
      const filters = [];
      const resolveResult = () => {
        const entry = tables[table] ?? { data: null, error: null };
        return typeof entry === "function" ? entry(filters) : entry;
      };
      const query = new Proxy({}, {
        get(_target, method) {
          if (method === "then") return (resolve, reject) => Promise.resolve(resolveResult()).then(resolve, reject);
          if (method === "maybeSingle") return async () => resolveResult();
          return (...args) => { calls.push({ table, method, args }); filters.push({ method, args }); return query; };
        },
      });
      return query;
    },
    async rpc(name, args) {
      calls.push({ type: "rpc", name, args });
      const handler = rpc[name];
      if (!handler) return { data: null, error: { message: `unexpected rpc ${name}` } };
      return typeof handler === "function" ? handler(args) : handler;
    },
  };
}

function libs(admin, { permissionError = null, rpaOk = true } = {}) {
  const permissions = [];
  const audits = [];
  const serverAdmin = {
    AdminApiError,
    jsonError,
    async requireModulePermission(_request, module, action) {
      permissions.push(`${module}/${action}`);
      if (permissionError) throw permissionError;
      return { admin, profile };
    },
    async writeAdministrationAudit(_admin, actor, action, objectType, objectId, label, details) {
      audits.push({ actor, action, objectType, objectId, label, details });
    },
  };
  const helpers = load("src\\lib\\server-nj-pwc-sync.ts", { "@/lib/server-admin": serverAdmin });
  const serverComplianceSync = {
    jsonError,
    isValidDateString: (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value),
    isResultStatus: (value) => ["Match Found", "No Match Found", "Multiple Matches", "Invalid Search", "Website Error", "RPA Error"].includes(value),
    async requireRpaKey() {
      return rpaOk ? { admin } : Response.json({ error: "Unauthorized" }, { status: 401 });
    },
  };
  return {
    permissions,
    audits,
    deps: {
      "@/lib/server-admin": serverAdmin,
      "@/lib/server-nj-pwc-sync": helpers,
      "@/lib/server-compliance-sync": serverComplianceSync,
    },
  };
}

const post = (body, method = "POST") => new Request("http://local.test/api", {
  method,
  headers: { "content-type": "application/json" },
  body: typeof body === "string" ? body : JSON.stringify(body),
});
const plain = (value) => JSON.parse(JSON.stringify(value));
const rpcCalls = (admin) => admin.calls.filter((call) => call.type === "rpc");

test("NJ PWC mutations reject empty RPC results instead of reporting success", async () => {
  const cases = [
    ["src\\app\\api\\contractors\\nj-pwc-import\\route.ts", "import_nj_pwc_candidate",
      { contractor_id: 5, search_request_id: 9, candidate: { certificate_number: "708951" } }],
    ["src\\app\\api\\admin\\compliance-sync\\nj-pwc-review\\route.ts", "approve_nj_pwc_review",
      { review_id: 21, decision: "approved" }],
    ["src\\app\\api\\integrations\\compliance-sync\\nj-pwc-daily\\route.ts", "enqueue_nj_pwc_daily_sync",
      { action: "enqueue" }],
    ["src\\app\\api\\integrations\\compliance-sync\\nj-pwc-daily\\route.ts", "finalize_nj_pwc_daily_run",
      { action: "finalize", run_id: 3 }],
    ["src\\app\\api\\admin\\compliance-sync\\nj-pwc-sync-exceptions\\route.ts", "retry_nj_pwc_sync_exception",
      { action: "retry", exception_id: 21 }],
    ["src\\app\\api\\admin\\compliance-sync\\nj-pwc-sync-exceptions\\route.ts", "resolve_nj_pwc_sync_exception",
      { action: "resolve", exception_id: 21, confirmed: true }],
    ["src\\app\\api\\integrations\\compliance-sync\\search-requests\\route.ts", "complete_nj_pwc_request",
      { worker_instance_id: profile.auth_user_id, search_request_id: 40, result_status: "No Match Found" }],
  ];
  for (const data of [null, []]) {
    for (const [file, name, body] of cases) {
      const admin = fakeAdmin({
        tables: { compliance_sync_search_requests: { data: { id: 40, status: "pending", origin: "daily_sync" }, error: null } },
        rpc: { [name]: { data, error: null } },
      });
      const response = await load(file, libs(admin).deps).POST(post(body));
      assert.equal(response.status, 500, name);
      assert.match((await response.json()).error, /returned no result/, name);
    }
  }
});

// ------------------------------------------------------------------ import
test("import: user selection calls import_nj_pwc_candidate with the server actor and contractors/manage", async () => {
  const admin = fakeAdmin({ rpc: { import_nj_pwc_candidate: { data: [{ approval: "auto_approved", review_reason: null, sync_run_id: 7, review_queue_id: 8, compliance_record_id: 9, record_action: "created" }], error: null } } });
  const { deps, permissions } = libs(admin);
  const route = load("src\\app\\api\\contractors\\nj-pwc-import\\route.ts", deps);
  const res = await route.POST(post({ contractor_id: 5, search_request_id: "12", candidate: { certificate_number: " 708951 ", business_name: "ignored" } }));
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.approval, "auto_approved");
  assert.equal(json.review_status, "approved");
  assert.equal(json.compliance_record_id, 9);
  assert.match(json.message, /approved/);
  assert.deepEqual(permissions, ["contractors/manage"]);
  const [call] = rpcCalls(admin);
  assert.equal(call.name, "import_nj_pwc_candidate");
  assert.deepEqual(plain(call.args), {
    p_search_request_id: 12, p_contractor_id: 5, p_certificate_number: "708951",
    p_actor_id: profile.auth_user_id, p_actor_name: profile.name, p_actor_email: profile.email,
  });
});

test("import: review_required result reports a pending review and its reason", async () => {
  const admin = fakeAdmin({ rpc: { import_nj_pwc_candidate: { data: [{ approval: "review_required", review_reason: "Name Mismatch", review_queue_id: 3 }], error: null } } });
  const route = load("src\\app\\api\\contractors\\nj-pwc-import\\route.ts", libs(admin).deps);
  const json = await (await route.POST(post({ contractor_id: 5, search_request_id: 12, candidate: { certificate_number: "1" } }))).json();
  assert.equal(json.review_status, "pending");
  assert.match(json.message, /Review Queue \(Name Mismatch\)/);
});

test("import: validates required inputs before calling the RPC", async () => {
  const admin = fakeAdmin();
  const route = load("src\\app\\api\\contractors\\nj-pwc-import\\route.ts", libs(admin).deps);
  for (const body of [
    { search_request_id: 1, candidate: { certificate_number: "1" } },
    { contractor_id: 1, candidate: { certificate_number: "1" } },
    { contractor_id: 1, search_request_id: 1, candidate: { certificate_number: "  " } },
    { contractor_id: -1, search_request_id: 1, candidate: { certificate_number: "1" } },
  ]) {
    assert.equal((await route.POST(post(body))).status, 400);
  }
  assert.equal((await route.POST(post("{not json"))).status, 400);
  assert.equal(rpcCalls(admin).length, 0);
});

test("import: maps RPC errors (candidate not in stored results -> 422, disabled -> 409, missing -> 404)", async () => {
  for (const [code, status] of [["23514", 422], ["55000", 409], ["P0002", 404], ["22023", 400], ["XX000", 500]]) {
    const admin = fakeAdmin({ rpc: { import_nj_pwc_candidate: { data: null, error: { code, message: `err ${code}` } } } });
    const route = load("src\\app\\api\\contractors\\nj-pwc-import\\route.ts", libs(admin).deps);
    const res = await route.POST(post({ contractor_id: 1, search_request_id: 1, candidate: { certificate_number: "1" } }));
    assert.equal(res.status, status, code);
    assert.equal((await res.json()).error, `err ${code}`);
  }
});

test("import: permission failure stops before the RPC", async () => {
  const admin = fakeAdmin();
  const route = load("src\\app\\api\\contractors\\nj-pwc-import\\route.ts", libs(admin, { permissionError: new AdminApiError("Forbidden", 403) }).deps);
  assert.equal((await route.POST(post({ contractor_id: 1, search_request_id: 1, candidate: { certificate_number: "1" } }))).status, 403);
  assert.equal(rpcCalls(admin).length, 0);
});

// ------------------------------------------------------------------ review
test("review: approve and reject call the transactional functions with compliance_sync/manage", async () => {
  const admin = fakeAdmin({ rpc: {
    approve_nj_pwc_review: { data: [{ review_queue_id: 4, compliance_record_id: 11, record_action: "versioned" }], error: null },
    reject_nj_pwc_review: { data: [{ review_queue_id: 4 }], error: null },
  } });
  const { deps, permissions } = libs(admin);
  const route = load("src\\app\\api\\admin\\compliance-sync\\nj-pwc-review\\route.ts", deps);
  const approved = await (await route.POST(post({ review_id: 4, decision: "approved" }))).json();
  assert.equal(approved.record_action, "versioned");
  const rejected = await route.POST(post({ review_id: 4, decision: "rejected", notes: "Wrong company" }));
  assert.equal(rejected.status, 200);
  assert.deepEqual(permissions, ["compliance_sync/manage", "compliance_sync/manage"]);
  const [approve, reject] = rpcCalls(admin);
  assert.equal(approve.args.p_notes, null);
  assert.equal(approve.args.p_actor_email, profile.email);
  assert.equal(reject.args.p_reason, "Wrong company");
});

test("review: rejects bad decisions, missing rejection reason, and unexpected fields", async () => {
  const admin = fakeAdmin();
  const route = load("src\\app\\api\\admin\\compliance-sync\\nj-pwc-review\\route.ts", libs(admin).deps);
  assert.equal((await route.POST(post({ review_id: 4, decision: "maybe" }))).status, 400);
  assert.equal((await route.POST(post({ review_id: 4, decision: "rejected", notes: "  " }))).status, 400);
  assert.equal((await route.POST(post({ review_id: 0, decision: "approved" }))).status, 400);
  assert.equal((await route.POST(post({ review_id: 4, decision: "approved", status: "approved" }))).status, 400);
  assert.equal(rpcCalls(admin).length, 0);
});

test("review: already-decided review maps to 409", async () => {
  const admin = fakeAdmin({ rpc: { approve_nj_pwc_review: { data: null, error: { code: "55000", message: "Review entry is already approved." } } } });
  const route = load("src\\app\\api\\admin\\compliance-sync\\nj-pwc-review\\route.ts", libs(admin).deps);
  assert.equal((await route.POST(post({ review_id: 4, decision: "approved" }))).status, 409);
});

// ------------------------------------------------------------------ settings
test("settings: Mode change is persisted and audited with old/new values", async () => {
  const admin = fakeAdmin({ tables: { compliance_sync_settings: { data: { id: 2, compliance_name: "NJ PWC", mode: "review_required", failure_expire_threshold: 3 }, error: null } } });
  const { deps, audits } = libs(admin);
  const route = load("src\\app\\api\\admin\\compliance-sync\\settings\\route.ts", deps);
  const res = await route.PATCH(post({ id: 2, mode: "auto_approve", failure_expire_threshold: 4 }, "PATCH"));
  assert.equal(res.status, 200);
  const update = admin.calls.find((call) => call.method === "update");
  assert.equal(update.args[0].mode, "auto_approve");
  assert.equal(update.args[0].failure_expire_threshold, 4);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, "COMPLIANCE_SYNC_SETTING_CHANGED");
  assert.deepEqual(plain(audits[0].details.changes.mode), { old: "review_required", new: "auto_approve" });
  assert.deepEqual(plain(audits[0].details.changes.failure_expire_threshold), { old: 3, new: 4 });
});

test("settings: NJ BRC Auto Approve stays locked", async () => {
  const admin = fakeAdmin({ tables: { compliance_sync_settings: { data: { id: 1, compliance_name: "NJ BRC", mode: "review_required" }, error: null } } });
  const { deps, audits } = libs(admin);
  const route = load("src\\app\\api\\admin\\compliance-sync\\settings\\route.ts", deps);
  assert.equal((await route.PATCH(post({ id: 1, mode: "auto_approve" }, "PATCH"))).status, 409);
  assert.equal(admin.calls.some((call) => call.method === "update"), false);
  assert.equal(audits.length, 0);
});

test("settings: validates values and rejects unknown keys", async () => {
  const admin = fakeAdmin({ tables: { compliance_sync_settings: { data: { id: 2, compliance_name: "NJ PWC" }, error: null } } });
  const route = load("src\\app\\api\\admin\\compliance-sync\\settings\\route.ts", libs(admin).deps);
  for (const body of [
    { id: 2, mode: "yolo" },
    { id: 2, enabled: "yes" },
    { id: 2, test_mode: 1 },
    { id: 2, sync_source: "FTP" },
    { id: 2, failure_expire_threshold: 0 },
    { id: 2, failure_expire_threshold: 31 },
    { id: 2 },
    { id: 2, auto_approve: true },
  ]) {
    assert.equal((await route.PATCH(post(body, "PATCH"))).status, 400, JSON.stringify(body));
  }
});

// ------------------------------------------------------------------ daily trigger
test("daily: enqueue requires the RPA key and calls enqueue_nj_pwc_daily_sync", async () => {
  const unauthorized = fakeAdmin();
  const denied = load("src\\app\\api\\integrations\\compliance-sync\\nj-pwc-daily\\route.ts", libs(unauthorized, { rpaOk: false }).deps);
  assert.equal((await denied.POST(post({ action: "enqueue" }))).status, 401);
  assert.equal(rpcCalls(unauthorized).length, 0);

  const admin = fakeAdmin({ rpc: { enqueue_nj_pwc_daily_sync: { data: [{ run_id: 3, created: true, enqueued: 12, is_test: true, skipped_reason: null }], error: null } } });
  const route = load("src\\app\\api\\integrations\\compliance-sync\\nj-pwc-daily\\route.ts", libs(admin).deps);
  const json = await (await route.POST(post({ action: "enqueue", run_date: "2026-10-14" }))).json();
  assert.equal(json.enqueued, 12);
  assert.deepEqual(plain(rpcCalls(admin)[0].args), { p_run_date: "2026-10-14", p_triggered_by: "NJ PWC Worker" });

  const defaulted = fakeAdmin({ rpc: { enqueue_nj_pwc_daily_sync: { data: [{ run_id: 3 }], error: null } } });
  const route2 = load("src\\app\\api\\integrations\\compliance-sync\\nj-pwc-daily\\route.ts", libs(defaulted).deps);
  await route2.POST(post({ action: "enqueue" }));
  assert.match(rpcCalls(defaulted)[0].args.p_run_date, /^\d{4}-\d{2}-\d{2}$/);
});

test("daily: finalize processes running daily runs and validates input", async () => {
  const admin = fakeAdmin({
    tables: { compliance_sync_runs: { data: [{ id: 3 }, { id: 4 }], error: null } },
    rpc: { finalize_nj_pwc_daily_run: (args) => ({ data: [{ run_id: args.p_run_id, finished: args.p_run_id === 3 }], error: null }) },
  });
  const route = load("src\\app\\api\\integrations\\compliance-sync\\nj-pwc-daily\\route.ts", libs(admin).deps);
  const json = await (await route.POST(post({ action: "finalize" }))).json();
  assert.deepEqual(json.runs.map((run) => [run.run_id, run.finished]), [[3, true], [4, false]]);
  assert.ok(rpcCalls(admin).every((call) => call.args.p_force === false));
  assert.equal((await route.POST(post({ action: "finalize", force: "yes" }))).status, 400);
  assert.equal((await route.POST(post({ action: "finalize", run_id: "x" }))).status, 400);
  assert.equal((await route.POST(post({ action: "enqueue", run_date: "10/14/2026" }))).status, 400);
  assert.equal((await route.POST(post({ action: "expire_everyone" }))).status, 400);
});

// ------------------------------------------------------------------ exceptions
test("exceptions: GET returns report rows merged with sync state plus health counts", async () => {
  const exceptionRow = {
    id: 21, contractor_id: 5, is_test: true, reason: "No Match Found", kind: "failure", consecutive_failure_count: 1,
    occurrences: 2, expired_by_sync: false, first_detected_at: "2026-10-13T10:00:00Z", last_attempt_at: "2026-10-13T10:00:00Z",
    review_queue_id: null, last_search_request_id: 9, contractors: { company_name: "Synthetic Paving" },
  };
  const admin = fakeAdmin({ tables: {
    compliance_sync_settings: { data: { test_mode: true }, error: null },
    nj_pwc_sync_exceptions: { data: [exceptionRow], error: null, count: 1 },
    nj_pwc_sync_state: { data: [{ contractor_id: 5, is_test: true, consecutive_failure_count: 2, last_successful_sync_at: "2026-10-01T10:00:00Z", last_attempt_at: "2026-10-14T10:00:00Z" }], error: null, count: 0 },
    compliance_sync_review_queue: { data: null, error: null, count: 4 },
    compliance_sync_runs: { data: [{ id: 3, run_status: "Completed" }], error: null },
  } });
  const { deps, permissions } = libs(admin);
  const route = load("src\\app\\api\\admin\\compliance-sync\\nj-pwc-sync-exceptions\\route.ts", deps);
  const json = await (await route.GET(new Request("http://local.test/api"))).json();
  assert.deepEqual(permissions, ["compliance_sync/view"]);
  assert.equal(json.test_mode, true);
  assert.equal(json.health.review_required, 4);
  assert.equal(json.health.last_successful_daily_run.id, 3);
  const [row] = json.exceptions;
  assert.equal(row.contractor, "Synthetic Paving");
  assert.equal(row.consecutive_failure_count, 2);
  assert.equal(row.last_successful_sync_at, "2026-10-01T10:00:00Z");
  assert.equal(row.last_attempt_at, "2026-10-14T10:00:00Z");
});

function healthAdmin(testMode) {
  const dryRun = { would_auto_approve: 7, would_request_review: 2, would_expire: 3, would_propose_expiration: 1 };
  const eqValue = (filters, column) => filters.find((f) => f.method === "eq" && f.args[0] === column)?.args[1];
  return fakeAdmin({ tables: {
    compliance_sync_settings: { data: { test_mode: testMode }, error: null },
    nj_pwc_sync_exceptions: { data: [], error: null, count: 0 },
    nj_pwc_sync_state: (filters) => {
      const action = eqValue(filters, "dry_run_action");
      if (action) return { data: null, error: null, count: eqValue(filters, "is_test") === true ? dryRun[action] : 99 };
      if (eqValue(filters, "state") === "Expired") return { data: null, error: null, count: eqValue(filters, "is_test") === false ? 5 : 42 };
      return { data: [], error: null, count: 0 };
    },
    compliance_sync_review_queue: { data: null, error: null, count: 0 },
    compliance_sync_runs: { data: [], error: null },
  } });
}

test("exceptions: Test Mode ON reports Would Auto Approve / Would Expire from dry-run classifications", async () => {
  const admin = healthAdmin(true);
  const route = load("src\\app\\api\\admin\\compliance-sync\\nj-pwc-sync-exceptions\\route.ts", libs(admin).deps);
  const { health } = await (await route.GET(new Request("http://local.test/api"))).json();
  assert.equal(health.would_auto_approve, 7);
  assert.equal(health.would_expire, 3);
  assert.equal(health.would_request_review, 2);
  assert.equal(health.would_propose_expiration, 1);
  // Expired by Sync counts only actual live expirations, never dry-run ones.
  assert.equal(health.expired_by_sync, 5);
  const dryRunQueries = admin.calls.filter((c) => c.table === "nj_pwc_sync_state" && c.method === "eq" && c.args[0] === "dry_run_action");
  assert.deepEqual(dryRunQueries.map((c) => c.args[1]).sort(), ["would_auto_approve", "would_expire", "would_propose_expiration", "would_request_review"]);
});

test("exceptions: Test Mode OFF leaves dry-run metrics empty and still reports live expirations", async () => {
  const admin = healthAdmin(false);
  const route = load("src\\app\\api\\admin\\compliance-sync\\nj-pwc-sync-exceptions\\route.ts", libs(admin).deps);
  const json = await (await route.GET(new Request("http://local.test/api"))).json();
  assert.equal(json.test_mode, false);
  assert.equal(json.health.would_auto_approve, null);
  assert.equal(json.health.would_expire, null);
  assert.equal(json.health.expired_by_sync, 5);
});

test("exceptions: retry and confirmed resolve call audited functions with the actor", async () => {
  const admin = fakeAdmin({ rpc: {
    retry_nj_pwc_sync_exception: { data: [{ search_request_id: 30 }], error: null },
    resolve_nj_pwc_sync_exception: { data: [{ exception_id: 21 }], error: null },
  } });
  const { deps, permissions } = libs(admin);
  const route = load("src\\app\\api\\admin\\compliance-sync\\nj-pwc-sync-exceptions\\route.ts", deps);
  assert.equal((await (await route.POST(post({ action: "retry", exception_id: 21 }))).json()).search_request_id, 30);
  assert.equal((await route.POST(post({ action: "resolve", exception_id: 21, confirmed: true, reset_failure_count: true, note: " checked " }))).status, 200);
  assert.deepEqual(permissions, ["compliance_sync/manage", "compliance_sync/manage"]);
  const [retry, resolve] = rpcCalls(admin);
  assert.equal(retry.args.p_actor_id, profile.auth_user_id);
  assert.equal(resolve.args.p_reset_failure_count, true);
  assert.equal(resolve.args.p_note, "checked");
});

test("exceptions: resolve requires explicit confirmation; bad input never reaches the RPC", async () => {
  const admin = fakeAdmin();
  const route = load("src\\app\\api\\admin\\compliance-sync\\nj-pwc-sync-exceptions\\route.ts", libs(admin).deps);
  assert.equal((await route.POST(post({ action: "resolve", exception_id: 21 }))).status, 400);
  assert.equal((await route.POST(post({ action: "resolve", exception_id: 21, confirmed: "true" }))).status, 400);
  assert.equal((await route.POST(post({ action: "resolve", exception_id: 21, confirmed: true, reset_failure_count: "yes" }))).status, 400);
  assert.equal((await route.POST(post({ action: "delete", exception_id: 21 }))).status, 400);
  assert.equal((await route.POST(post({ action: "retry" }))).status, 400);
  assert.equal(rpcCalls(admin).length, 0);
});

// ------------------------------------------------------------------ worker result submission
const searchRequestsRoute = (admin) => load("src\\app\\api\\integrations\\compliance-sync\\search-requests\\route.ts", libs(admin).deps);

test("search-requests: daily-sync results use the ownership-enforced completion wrapper", async () => {
  const admin = fakeAdmin({
    tables: { compliance_sync_search_requests: { data: { id: 40, status: "pending", origin: "daily_sync", contractor_id: 5 }, error: null } },
    rpc: { complete_nj_pwc_request: { data: { status: "completed", sync: { classification: "Exact Match", outcome: "auto_approved" } }, error: null } },
  });
  const res = await searchRequestsRoute(admin).POST(post({
    worker_instance_id: profile.auth_user_id, search_request_id: 40, result_status: "Match Found", source_url: "https://example.test/report",
    search_variation: "x".repeat(60),
    candidates: [{ business_name: "Synthetic Paving", certificate_number: "708951", registration_date: "2025-01-01", expiration_date: "2027-01-01" }],
  }));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).sync.classification, "Exact Match");
  const [call] = rpcCalls(admin);
  assert.equal(call.args.p_request_id, 40);
  assert.equal(call.args.p_worker_instance_id, profile.auth_user_id);
  assert.equal(call.args.p_result_status, "Match Found");
  assert.equal(call.args.p_candidates.length, 1);
  assert.equal(call.args.p_search_variation.length, 40);
  assert.equal(admin.calls.some((c) => c.method === "update"), false);
});

test("search-requests: user searches also enforce ownership in a transaction", async () => {
  const admin = fakeAdmin({
    tables: { compliance_sync_search_requests: { data: { id: 41, status: "processing", origin: "user", contractor_id: 5 }, error: null } },
    rpc: { complete_nj_pwc_request: { data: { status: "no_match" }, error: null } },
  });
  const res = await searchRequestsRoute(admin).POST(post({ worker_instance_id: profile.auth_user_id, search_request_id: 41, result_status: "No Match Found", candidates: [] }));
  assert.equal((await res.json()).status, "no_match");
  assert.equal(rpcCalls(admin)[0].name, "complete_nj_pwc_request");
  assert.equal(admin.calls.some((c) => c.method === "update"), false);
});

// ------------------------------------------------------------------ status
test("calculateStatus: registry-confirmed expiration reports Expired even with a future date", async () => {
  const future = new Date(Date.now() + 400 * 86400000).toISOString().slice(0, 10);
  const row = (registry_status) => ({
    id: 1, contractor_id: 5, compliance_type_id: 6, registration_number: "708951", effective_date: "2025-01-01",
    expiration_date: future, active: true, is_current: true, registry_status,
    compliance_types: { compliance_name: "NJ PWC", requires_expiration: true },
  });
  const supabase = fakeAdmin({ tables: { compliance_records: { data: [row("Expired - Not Found in Registry"), row("Investigation Required"), row("OK")], error: null } } });
  const compliance = load("services\\compliance.ts", { "@/lib/supabase": { supabase } });
  const { data } = await compliance.getComplianceHistoryForContractor(5);
  assert.deepEqual(data.map((record) => record.calculated_status), ["Expired", "Active", "Active"]);
});

// ------------------------------------------------------------------ worker daily trigger
const require = createRequire(import.meta.url);
const worker = require(path.join(root, "worker", "nj-pwc", "worker.js"));

test("worker: user submitted during daily processing runs next, before retry and remaining daily work", async () => {
  const queue = [{ id: 1, priority: 20 }, { id: 2, priority: 20 }, { id: 3, priority: 10 }];
  const events = [];
  let polls = 0;
  // Begin with only daily work, then add the retry/user during its active search.
  const retry = queue.pop();
  const claim = async () => {
    polls++;
    queue.sort((a,b) => a.priority-b.priority || a.id-b.id);
    return queue.shift() ?? null;
  };
  const start = async (request) => { events.push(`start:${request.id}`); };
  const process = async (request) => {
    if (request.id === 1) {
      queue.push(retry, { id: 4, priority: 0 });
      await Promise.resolve();
      assert.deepEqual(events, ["start:1"]);
      assert.equal(polls,1, "the active search must not be interrupted");
    }
    events.push(`finish:${request.id}`);
  };
  for (let i=0;i<4;i++) {
    assert.equal(await worker.processQueueCycle(claim,start,process),true);
    assert.equal(polls,i+1, "exactly one claim per cycle");
  }
  assert.deepEqual(events,["start:1","finish:1","start:4","finish:4","start:3","finish:3","start:2","finish:2"]);
  assert.equal(await worker.processQueueCycle(claim,start,process),false);
});

test("worker: a rejected start never executes a search or consumes another request", async () => {
  let processed=0,claims=0;
  await assert.rejects(worker.processQueueCycle(
    async () => { claims++; return {id:1}; },
    async () => { throw new Error("ownership rejected"); },
    async () => { processed++; },
  ),/ownership rejected/);
  assert.equal(claims,1); assert.equal(processed,0);
});

test("worker: result submission includes claim owner and does not retry ownership conflicts", async () => {
  const originalFetch=global.fetch;
  const posts=[];
  global.fetch=async (_url,options)=>{
    posts.push(JSON.parse(options.body));
    assert.ok(options.signal);
    return Response.json({error:"Claim was manually recovered"},{status:409});
  };
  try {
    const result=await worker.submitResults(17,"Website Error",[],"Synthetic failure",null,profile.auth_user_id);
    assert.equal(result.ok,false); assert.equal(result.status,409);
    assert.deepEqual(posts,[{
      action:"complete",worker_instance_id:profile.auth_user_id,search_request_id:17,
      result_status:"Website Error",candidates:[],error_message:"Synthetic failure",
      source_url:posts[0].source_url,search_variation:null,
    }]);
  } finally { global.fetch=originalFetch; }
});

test("queue API: claim returns exactly one request or an explicit empty queue", async () => {
  for (const data of [[{id:1,status:"claimed"}],[]]) {
    const admin=fakeAdmin({rpc:{claim_nj_pwc_request:{data,error:null}}});
    const response=await searchRequestsRoute(admin).POST(post({action:"claim",worker_instance_id:profile.auth_user_id}));
    assert.equal(response.status,200);
    assert.equal((await response.json()).request?.id ?? null,data[0]?.id ?? null);
    assert.equal(rpcCalls(admin)[0].args.p_worker_instance_id,profile.auth_user_id);
    assert.equal(admin.calls.some((c)=>c.table),false);
  }
});

test("queue API: legacy batch polls, missing owners and conflicting results fail closed", async () => {
  const admin=fakeAdmin({
    tables:{compliance_sync_search_requests:{data:{id:1,status:"processing",origin:"user"},error:null}},
    rpc:{complete_nj_pwc_request:{data:null,error:{code:"55000",message:"Worker does not own request"}}},
  });
  const route=searchRequestsRoute(admin);
  assert.equal((await route.GET(new Request("http://local.test/api?compliance_name=NJ%20PWC&limit=25"))).status,409);
  assert.equal((await route.POST(post({action:"claim"}))).status,400);
  assert.equal((await route.POST(post({search_request_id:1,result_status:"Website Error",worker_instance_id:profile.auth_user_id}))).status,409);
});

test("queue API: processing start calls the owner-checked RPC", async () => {
  const admin=fakeAdmin({rpc:{start_nj_pwc_request:{data:null,error:null}}});
  const response=await searchRequestsRoute(admin).POST(post({action:"start",worker_instance_id:profile.auth_user_id,search_request_id:12}));
  assert.equal(response.status,200);
  assert.deepEqual(plain(rpcCalls(admin)[0].args),{p_request_id:12,p_worker_instance_id:profile.auth_user_id});
});

test("orphan API: requires manage, explicit confirmation and server-derived actor/age", async () => {
  const admin=fakeAdmin({rpc:{
    list_orphaned_nj_pwc_requests:{data:[{id:8,searched_company_name:"Synthetic Contractor",worker_instance_id:profile.auth_user_id,status:"processing"}],error:null},
    recover_orphaned_nj_pwc_request:{data:{request_id:8,retry_request_id:9},error:null},
  }});
  const {deps,permissions}=libs(admin);
  const route=load("src\\app\\api\\admin\\compliance-sync\\nj-pwc-orphaned-requests\\route.ts",deps);
  assert.equal((await route.GET(new Request("http://local.test/api"))).status,200);
  assert.equal((await route.POST(post({request_id:8,action:"retry"}))).status,400);
  assert.equal((await route.POST(post({request_id:8,action:"retry",confirmed:true}))).status,200);
  assert.deepEqual(permissions,["compliance_sync/manage","compliance_sync/manage","compliance_sync/manage"]);
  const call=rpcCalls(admin).find((c)=>c.name==="recover_orphaned_nj_pwc_request");
  assert.equal(call.args.p_min_age_minutes,10); assert.equal(call.args.p_actor_id,profile.auth_user_id);
  assert.equal(call.args.p_action,"retry");
});

test("orphan API: permission failure or healthy-owner conflict cannot report successful recovery", async () => {
  const admin=fakeAdmin({rpc:{recover_orphaned_nj_pwc_request:{data:null,error:{code:"55000",message:"No longer orphaned"}}}});
  const file="src\\app\\api\\admin\\compliance-sync\\nj-pwc-orphaned-requests\\route.ts";
  const denied=load(file,libs(admin,{permissionError:new AdminApiError("Forbidden",403)}).deps);
  assert.equal((await denied.POST(post({request_id:8,action:"fail",confirmed:true}))).status,403);
  assert.equal(rpcCalls(admin).length,0);
  assert.equal((await load(file,libs(admin).deps).POST(post({request_id:8,action:"resolve",confirmed:true}))).status,409);
});

function schedulerFixture({ hour = 6, now = "2026-10-14T12:00:00Z", fail = false } = {}) {
  const posts = [];
  const logs = [];
  let clock = new Date(now);
  const scheduler = worker.createDailySyncScheduler({
    config: { baseUrl: "https://subtracker.example.test", dailySyncHour: hour },
    headers: () => ({ "content-type": "application/json" }),
    log: (entry) => logs.push(entry),
    now: () => clock,
    async fetch(url, init) {
      const body = JSON.parse(init.body);
      posts.push({ url, body });
      if (fail) return new Response(JSON.stringify({ error: "down" }), { status: 503 });
      const payload = body.action === "enqueue"
        ? { ok: true, run_id: 3, created: true, enqueued: 2, is_test: true }
        : { ok: true, runs: [{ run_id: 3, finished: true }] };
      return new Response(JSON.stringify(payload), { status: 200 });
    },
  });
  return { scheduler, posts, logs, setNow: (value) => { clock = new Date(value); } };
}

test("worker: parses NJ_PWC_DAILY_SYNC_HOUR", () => {
  assert.equal(worker.parseDailySyncHour(undefined), 6);
  assert.equal(worker.parseDailySyncHour("off"), null);
  assert.equal(worker.parseDailySyncHour("23"), 23);
  assert.equal(worker.parseDailySyncHour("24"), 6);
  assert.deepEqual(worker.zonedDateParts(new Date("2026-10-14T03:30:00Z"), "America/New_York"), { date: "2026-10-13", hour: 23 });
});

test("worker: enqueues once per New York day after the configured hour", async () => {
  const f = schedulerFixture({ now: "2026-10-14T09:00:00Z" }); // 05:00 New York
  assert.equal(await f.scheduler.maybeEnqueue(), null);
  assert.equal(f.posts.length, 0);
  f.setNow("2026-10-14T10:30:00Z"); // 06:30 New York
  await f.scheduler.maybeEnqueue();
  await f.scheduler.maybeEnqueue();
  assert.equal(f.posts.length, 1);
  assert.match(f.posts[0].url, /\/api\/integrations\/compliance-sync\/nj-pwc-daily$/);
  assert.deepEqual(f.posts[0].body, { action: "enqueue", run_date: "2026-10-14" });
  f.setNow("2026-10-15T10:30:00Z");
  await f.scheduler.maybeEnqueue();
  assert.equal(f.posts[1].body.run_date, "2026-10-15");
  assert.ok(f.logs.every((entry) => !JSON.stringify(entry).includes("rpa")));
});

test("worker: enqueue failure is logged and retried on the next poll", async () => {
  const f = schedulerFixture({ fail: true });
  assert.equal(await f.scheduler.maybeEnqueue(), null);
  await f.scheduler.maybeEnqueue();
  assert.equal(f.posts.length, 2);
  assert.equal(f.logs[0].event, "daily_sync_error");
});

test("worker: finalize is throttled and disabled when the daily sync is off", async () => {
  const f = schedulerFixture();
  await f.scheduler.maybeFinalize();
  await f.scheduler.maybeFinalize();
  assert.equal(f.posts.length, 1);
  assert.deepEqual(f.posts[0].body, { action: "finalize" });
  assert.equal(f.logs[0].event, "daily_sync_finalized");
  f.setNow("2026-10-14T12:11:00Z");
  await f.scheduler.maybeFinalize();
  assert.equal(f.posts.length, 2);

  const off = schedulerFixture({ hour: null });
  await off.scheduler.maybeEnqueue();
  await off.scheduler.maybeFinalize();
  assert.equal(off.posts.length, 0);
});
