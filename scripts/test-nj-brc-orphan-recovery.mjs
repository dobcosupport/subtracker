import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const currentInstance = "12345678-1234-4234-8234-123456789012";
const oldInstance = "12345678-1234-4234-8234-123456789013";
const requestId = "12345678-1234-4234-8234-123456789014";

function load(relative, dependencies, env = {}) {
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
    Date,
    process: { env },
  }, { filename: relative });
  return loaded.exports;
}

function healthyWorker(instanceId = currentInstance) {
  return {
    worker_key: "nj-brc",
    display_name: "NJ BRC Worker",
    enabled: true,
    instance_id: instanceId,
    expires_at: new Date(Date.now() + 90_000).toISOString(),
    started_at: "2026-10-13T12:00:00Z",
    last_heartbeat_at: new Date().toISOString(),
    lifecycle: "ready",
    last_poll_at: new Date().toISOString(),
    browser_connected: true,
    file_modified_at: "2026-10-13T12:00:00Z",
    loaded_hash: "a".repeat(64),
    current_hash: "a".repeat(64),
    current_request_id: null,
    current_request_key: null,
    last_search_at: null,
    last_search_request_id: null,
    last_search_request_key: null,
    last_search_result: null,
    last_error_at: null,
    last_error: null,
    test_id: null,
    test_requested_at: null,
    test_acknowledged_at: null,
  };
}

function fixture({ requests = [], worker = healthyWorker(), rpcError = null, permissionError = null, env = {} } = {}) {
  const calls = [];
  const admin = {
    from(table) {
      const result = { data: table === "nj_brc_worker_lease" ? worker : requests, error: null };
      const query = new Proxy({}, {
        get(_target, method) {
          if (method === "then") return (resolve, reject) => Promise.resolve(result).then(resolve, reject);
          if (method === "maybeSingle") return async () => result;
          return (...args) => { calls.push({ table, method, args }); return query; };
        },
      });
      return query;
    },
    async rpc(name, args) {
      calls.push({ type: "rpc", name, args });
      return { data: [{ request_id: requestId, status: "website_error", error_code: "website_error", completed_at: new Date().toISOString() }], error: rpcError };
    },
  };
  const profile = {
    auth_user_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    name: "Synthetic Admin",
    email: "admin@example.test",
  };
  const serverAdmin = {
    AdminApiError: class AdminApiError extends Error {
      constructor(message, status = 500) { super(message); this.status = status; }
    },
    createAdminClient: () => admin,
    jsonError(error) {
      return Response.json({ error: error.message }, { status: error.status ?? 500 });
    },
    async requireModulePermission(_request, module, action) {
      calls.push({ type: "permission", module, action });
      if (permissionError) throw permissionError;
      return { admin, profile };
    },
  };
  const workerHealth = load("src\\lib\\worker-health.ts", {});
  const orphanModule = load("src\\lib\\nj-brc-orphan-recovery.ts", {
    "@/lib/worker-health": workerHealth,
  });
  const route = load("src\\app\\api\\admin\\compliance-sync\\nj-brc-orphaned-requests\\route.ts", {
    "@/lib/server-admin": serverAdmin,
    "@/lib/nj-brc-orphan-recovery": orphanModule,
    "@/lib/worker-health": workerHealth,
  }, env);
  return { calls, route, orphanModule };
}

const candidate = (overrides = {}) => ({
  id: requestId,
  contractor_id: 42,
  company_name: "Synthetic Contractor",
  status: "processing",
  worker_instance_id: oldInstance,
  claimed_at: new Date(Date.now() - 20 * 60_000).toISOString(),
  created_at: new Date(Date.now() - 20 * 60_000).toISOString(),
  ...overrides,
});
const request = (body) => new Request("https://example.test/api/admin/compliance-sync/nj-brc-orphaned-requests", {
  method: body === undefined ? "GET" : "POST",
  body: body === undefined ? undefined : JSON.stringify(body),
});

test("orphan detection requires old in-flight state, no live owning lease, and age threshold", () => {
  const { orphanModule } = fixture();
  const stale = candidate();
  const now = Date.now();
  assert.equal(orphanModule.isOrphanedNjBrcRequest(stale, healthyWorker(), 10, now), true);
  assert.equal(orphanModule.isOrphanedNjBrcRequest(candidate({ status: "human_verification_required" }), null, 10, now), true);
  assert.equal(orphanModule.isOrphanedNjBrcRequest(candidate({ worker_instance_id: currentInstance }),
    { instance_id: currentInstance, expires_at: new Date(now - 1).toISOString() }, 10, now), true);
  for (const invalid of [
    candidate({ status: "pending" }),
    candidate({ status: "review_required" }),
    candidate({ worker_instance_id: currentInstance }),
    candidate({ worker_instance_id: null }),
    candidate({ claimed_at: new Date(now - 9 * 60_000).toISOString() }),
    candidate({ claimed_at: null }),
  ]) {
    assert.equal(orphanModule.isOrphanedNjBrcRequest(invalid, healthyWorker(), 10, now), false);
  }
});

test("orphan age threshold defaults to ten minutes and validates configured values", () => {
  const { orphanModule } = fixture();
  assert.equal(orphanModule.orphanAgeThresholdMinutes(undefined), 10);
  assert.equal(orphanModule.orphanAgeThresholdMinutes("25"), 25);
  for (const value of ["0", "-1", "1.5", "1441", "bad"]) {
    assert.throws(() => orphanModule.orphanAgeThresholdMinutes(value));
  }
});

test("GET returns only eligible orphaned requests for administrators", async () => {
  const f = fixture({
    requests: [
      candidate(),
      candidate({ id: "22345678-1234-4234-8234-123456789014", status: "claimed" }),
      candidate({ id: "32345678-1234-4234-8234-123456789014", status: "pending" }),
      candidate({ id: "42345678-1234-4234-8234-123456789014", worker_instance_id: currentInstance }),
      candidate({ id: "52345678-1234-4234-8234-123456789014", claimed_at: new Date(Date.now() - 2 * 60_000).toISOString() }),
    ],
  });
  const response = await f.route.GET(request());
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.count, 2);
  assert.deepEqual(result.requests.map((item) => item.status), ["processing", "claimed"]);
  assert.equal(result.age_threshold_minutes, 10);
  assert.equal(f.calls[0].module, "compliance_sync");
  assert.equal(f.calls[0].action, "manage");
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("cleanup requires exact confirmation and calls the guarded atomic audit RPC", async () => {
  const f = fixture();
  const response = await f.route.POST(request({ request_id: requestId, confirmed: true }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json().then((body) => body.request.status), "website_error");
  const rpc = f.calls.find((call) => call.type === "rpc");
  assert.equal(rpc.name, "recover_orphaned_nj_brc_request");
  assert.equal(rpc.args.p_request_id, requestId);
  assert.equal(rpc.args.p_min_age_minutes, 10);
  assert.equal(rpc.args.p_actor_id, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  assert.match(rpc.args.p_error_message, /worker instance became inactive/);
});

test("cleanup rejects missing confirmation, unsupported fields, and stale candidates", async () => {
  for (const payload of [
    { request_id: requestId },
    { request_id: requestId, confirmed: false },
    { request_id: requestId, confirmed: true, status: "website_error" },
  ]) {
    const f = fixture();
    assert.equal((await f.route.POST(request(payload))).status, 400);
    assert.equal(f.calls.some((call) => call.type === "rpc"), false);
  }
  const stale = fixture({ rpcError: { code: "55000", message: "no longer eligible" } });
  assert.equal((await stale.route.POST(request({ request_id: requestId, confirmed: true }))).status, 409);
});

test("users without Compliance Sync manage permission cannot list or clean requests", async () => {
  const denied = new Error("Forbidden.");
  denied.status = 403;
  const f = fixture({ permissionError: denied });
  assert.equal((await f.route.GET(request())).status, 403);
  assert.equal((await f.route.POST(request({ request_id: requestId, confirmed: true }))).status, 403);
  assert.equal(f.calls.some((call) => call.type === "rpc"), false);
});
