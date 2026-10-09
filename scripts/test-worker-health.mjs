import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { execFileSync } from "node:child_process";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
function load(relative, dependencies = {}) {
  const source = fs.readFileSync(path.join(root, relative), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  const loadedModule = { exports: {} };
  vm.runInNewContext(compiled, {
    module: loadedModule, exports: loadedModule.exports, require: (name) => name in dependencies ? dependencies[name] : require(name),
    Request, Response, URL, Date, process: { env: { COMPLIANCE_SYNC_RPA_KEY: "synthetic-key" } },
  }, { filename: relative });
  return loadedModule.exports;
}
const { classifyWorker, overallWorkerHealth } = load("src\\lib\\worker-health.ts");
const now = Date.now();
const row = (overrides = {}) => ({
  worker_key: "nj-pwc", display_name: "NJ PWC Worker", enabled: true, instance_id: null,
  started_at: new Date(now - 300_000).toISOString(), last_heartbeat_at: new Date(now).toISOString(),
  lifecycle: "ready", last_poll_at: new Date(now).toISOString(), browser_connected: true,
  file_modified_at: new Date(now - 400_000).toISOString(), loaded_hash: "a", current_hash: "a",
  current_request_id: null, last_search_at: null, last_search_request_id: null, last_search_result: null,
  last_error_at: null, last_error: null, test_id: null, test_requested_at: null, test_acknowledged_at: null,
  ...overrides,
});

test("exact heartbeat thresholds: 60s online, >60s degraded, >120s stopped", () => {
  for (const [age, expected] of [[60000, "online"], [60001, "degraded"], [120000, "degraded"], [120001, "offline"]]) {
    const health = classifyWorker(row({ last_heartbeat_at: new Date(now - age).toISOString() }), now);
    assert.equal(health.health, expected);
    assert.equal(health.available, age <= 120000);
  }
  assert.equal(classifyWorker(row({ last_heartbeat_at: null }), now).status, "Stopped");
  assert.equal(classifyWorker(row({ last_heartbeat_at: "invalid" }), now).health, "offline");
});
test("newer file or changed hash requires restart and degrades overall health", () => {
  for (const stale of [row({ file_modified_at: new Date(now - 200000).toISOString() }), row({ current_hash: "b" })]) {
    assert.equal(classifyWorker(stale, now).restartRequired, true);
    assert.equal(classifyWorker(stale, now).available, true);
    assert.equal(overallWorkerHealth([stale], now), "degraded");
  }
  assert.equal(classifyWorker(row({ file_modified_at: new Date(now - 300000).toISOString() }), now).restartRequired, false);
});
test("unconfigured future worker is excluded, stop is offline, history errors do not degrade recovery", () => {
  assert.equal(overallWorkerHealth([row(), row({ enabled: false, last_heartbeat_at: null })], now), "online");
  assert.equal(overallWorkerHealth([row({ lifecycle: "stopped" })], now), "offline");
  assert.equal(overallWorkerHealth([], now), "degraded");
  assert.equal(classifyWorker(row({ last_error: "Old error" }), now).health, "online");
});
test("busy worker with fresh heartbeats stays online during a long search", () => {
  const busy = row({ lifecycle: "busy", last_poll_at: new Date(now - 600000).toISOString(), current_request_id: 5 });
  assert.equal(classifyWorker(busy, now).health, "online");
  assert.equal(classifyWorker(row({ last_poll_at: new Date(now - 120001).toISOString() }), now).available, false);
  assert.equal(classifyWorker(row({ browser_connected: false }), now).available, false);
  assert.equal(classifyWorker(row({ lifecycle: "starting" }), now).available, false);
});
test("diagnostic expiry is explicit and acknowledgement is required", () => {
  const pending = row({ test_id: "test", test_requested_at: new Date(now - 29999).toISOString() });
  assert.equal(classifyWorker(pending, now).testState, "pending");
  assert.equal(classifyWorker({ ...pending, test_requested_at: new Date(now - 30000).toISOString() }, now).testState, "timed_out");
  assert.equal(classifyWorker({ ...pending, test_acknowledged_at: new Date(now).toISOString() }, now).testState, "passed");
});

class ApiError extends Error { constructor(message, status) { super(message); this.status = status; } }
const jsonError = (error) => Response.json({ error: error.message }, { status: error.status ?? 500 });
function query(response, calls = []) {
  return new Proxy({}, { get(_target, name) {
    if (name === "then") return (resolve) => Promise.resolve(response).then(resolve);
    return (...args) => { calls.push({ name, args }); return query(response, calls); };
  } });
}
const healthModule = { classifyWorker, overallWorkerHealth };
test("server guard rejects absent/offline workers and fails explicitly on schema errors", async () => {
  const service = load("src\\lib\\server-worker-health.ts", {
    "server-only": {}, "@/lib/server-admin": { AdminApiError: ApiError }, "@/lib/worker-health": healthModule,
  });
  for (const result of [{ data: null, error: null }, { data: row({ lifecycle: "stopped" }), error: null }]) {
    await assert.rejects(service.requireNjPwcWorker({ from: () => query(result) }), /NJ PWC Worker Offline/);
  }
  await assert.rejects(service.requireNjPwcWorker({ from: () => query({ error: { message: "missing table" } }) }), /Unable to verify/);
  await service.requireNjPwcWorker({ from: () => query({ data: row(), error: null }) });
});
test("search creation is guarded before insert and does not block existing result routes", async () => {
  let inserts = 0;
  const route = load("src\\app\\api\\contractors\\nj-pwc-search\\route.ts", {
    "@/lib/server-admin": { requireModulePermission: async () => ({ admin: { from() { inserts++; } }, profile: {} }), jsonError },
    "@/lib/server-worker-health": { requireNjPwcWorker: async () => { throw new ApiError("NJ PWC Worker Offline", 503); } },
  });
  const response = await route.POST(new Request("http://localhost/api/search", { method: "POST", body: JSON.stringify({ company_name: "Synthetic" }) }));
  assert.equal(response.status, 503);
  assert.equal(inserts, 0);
  for (const file of ["latest\\route.ts", "[id]\\route.ts"]) {
    assert.doesNotMatch(fs.readFileSync(path.join(root, "src\\app\\api\\contractors\\nj-pwc-search", file), "utf8"), /requireNjPwcWorker/);
  }
});
test("both contractor search workflows stop offline pending/new requests but reuse completed results", async () => {
    for (const relative of ["src\\app\\contractors\\page.tsx", "src\\app\\contractors\\[id]\\page.tsx"]) {
      const source = fs.readFileSync(path.join(root, relative), "utf8");
      const ast = ts.createSourceFile(relative, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      let expression;
      function visit(node) {
        if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "handleNjPwcSearch") expression = node.initializer.getText(ast);
        ts.forEachChild(node, visit);
      }
      visit(ast);
      const compiled = ts.transpileModule(`module.exports = ${expression};`, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
      for (const status of ["pending", "absent", "completed"]) {
        const calls = [];
        let warning;
        let checks = 0;
        const loadedModule = { exports: {} };
        const context = {
          module: loadedModule, Error, contractor: { company_name: "Synthetic" }, form: { company_name: "Synthetic" },
          setFormError() {}, setNjPwcSearching() {}, setNjPwcNoMatch() {}, setNjPwcCandidates() {},
          setNjPwcRequestId() {}, saveNjPwcPersisted() {}, applyNjPwcResult() {}, setNjPwcResultsOpen() {},
          normalizeNjPwcCompanyName: (value) => value,
          setNjPwcMessage: (value) => { warning = value; },
          checkNjPwcWorker: async () => { checks++; throw new Error("NJ PWC Worker Offline"); },
          adminFetch: async (_path, options) => {
            calls.push(options?.method ?? "GET");
            return { ok: true, json: async () => ({ found: status !== "absent", status, search_request_id: 5, candidates: [{ business_name: "Synthetic" }] }) };
          },
        };
        vm.runInNewContext(compiled, context);
        await loadedModule.exports();
        assert.deepEqual(calls, ["GET"]);
        if (status === "completed") assert.equal(checks, 0);
        else { assert.equal(checks, 1); assert.equal(warning, "NJ PWC Worker Offline"); }
      }
    }
});
test("health/log reads require view, diagnostic writes require manage and preserve rate limit", async () => {
  const permissions = [];
  const calls = [];
  let response = { data: [row()], error: null };
  const admin = { from: () => query(response, calls) };
  const route = load("src\\app\\api\\admin\\compliance-sync\\worker-health\\route.ts", {
    "@/lib/server-admin": {
      AdminApiError: ApiError, jsonError, writeAdministrationAudit: async () => {},
      requireModulePermission: async (_request, module, action) => { permissions.push([module, action]); return { admin, profile: {} }; },
    }, "@/lib/worker-health": healthModule,
  });
  assert.equal((await route.GET(new Request("http://localhost/health"))).status, 200);
  assert.equal((await route.GET(new Request("http://localhost/health?logs=nj-pwc"))).status, 200);
  assert.ok(calls.some((call) => call.name === "limit" && call.args[0] === 50));
  response = { data: row(), error: null };
  const post = await route.POST(new Request("http://localhost/health", { method: "POST", body: '{"worker_key":"nj-pwc"}' }));
  assert.equal(post.status, 429);
  assert.deepEqual(permissions, [["compliance_sync", "view"], ["compliance_sync", "view"], ["compliance_sync", "manage"]]);
  assert.ok(calls.some((call) => call.name === "or" && /test_requested_at/.test(call.args[0])));
});
test("diagnostic creation is audited and rejected when unavailable", async () => {
  let unavailable = false;
  let audited = 0;
  let updateCount = 0;
  const admin = { from() {
    let updated = false;
    const fluent = {
      select() { return this; }, eq() { return this; }, single() { return this; }, or() { return this; },
      update() { updated = true; updateCount++; return this; },
      then(resolve) { return Promise.resolve({ data: updated ? [{ worker_key: "nj-pwc" }] : row({ browser_connected: !unavailable }), error: null }).then(resolve); },
    };
    return fluent;
  } };
  const route = load("src\\app\\api\\admin\\compliance-sync\\worker-health\\route.ts", {
    "@/lib/server-admin": { AdminApiError: ApiError, jsonError,
      requireModulePermission: async () => ({ admin, profile: {} }),
      writeAdministrationAudit: async () => { audited++; },
    }, "@/lib/worker-health": healthModule,
  });
  const request = () => new Request("http://localhost/health", { method: "POST", body: '{"worker_key":"nj-pwc"}' });
  assert.equal((await route.POST(request())).status, 200);
  assert.equal(audited, 1);
  unavailable = true;
  assert.equal((await route.POST(request())).status, 503);
  assert.equal(updateCount, 1);
});

test("unauthorized health and telemetry requests do not touch database", async () => {
  const adminRoute = load("src\\app\\api\\admin\\compliance-sync\\worker-health\\route.ts", {
    "@/lib/server-admin": { AdminApiError: ApiError, jsonError, requireModulePermission: async () => { throw new ApiError("Forbidden", 403); } },
    "@/lib/worker-health": healthModule,
  });
  assert.equal((await adminRoute.GET(new Request("http://localhost/health"))).status, 403);
  assert.equal((await adminRoute.POST(new Request("http://localhost/health", { method: "POST" }))).status, 403);
  const telemetry = load("src\\app\\api\\integrations\\compliance-sync\\worker-health\\route.ts", {
    "@/lib/server-compliance-sync": { requireRpaKey: async () => Response.json({ error: "Unauthorized" }, { status: 401 }), jsonError },
  });
  assert.equal((await telemetry.POST(new Request("http://localhost/health", { method: "POST" }))).status, 401);
});
test("telemetry validates reports, strips extra fields/secrets, and rejects superseded instances", async () => {
  let report;
  let accepted = true;
  const telemetry = load("src\\app\\api\\integrations\\compliance-sync\\worker-health\\route.ts", {
    "@/lib/server-compliance-sync": {
      jsonError, isResultStatus: (value) => ["Match Found", "No Match Found", "Multiple Matches"].includes(value),
      requireRpaKey: async () => ({ admin: {
        rpc: async (_name, args) => { report = args.p_report; return { data: accepted, error: null }; },
        from: () => query({ data: { test_id: null }, error: null }),
      } }),
    },
  });
  const payload = {
    worker_key: "nj-pwc", instance_id: "00000000-0000-0000-0000-000000000001",
    started_at: new Date(now - 1000).toISOString(), file_modified_at: new Date(now - 2000).toISOString(),
    loaded_hash: "a".repeat(64), current_hash: "a".repeat(64), lifecycle: "ready",
    sequence: 1, browser_connected: true, event: "error",
    message: "synthetic-key Bearer synthetic-token https://example.invalid/?secret=yes", secret: "not persisted",
  };
  const send = (value) => telemetry.POST(new Request("http://localhost/health", { method: "POST", body: JSON.stringify(value) }));
  assert.equal((await send(payload)).status, 200);
  assert.doesNotMatch(report.message, /synthetic-key|synthetic-token|example/);
  assert.equal(report.secret, undefined);
  for (const invalid of [{ sequence: 0 }, { instance_id: "bad" }, { lifecycle: "bad" }, { worker_key: "arbitrary" }, { event: "shell" }, { event: "search", request_id: null }, { message: "a".repeat(1001) }]) {
    assert.equal((await send({ ...payload, ...invalid })).status, 400);
  }
  accepted = false;
  assert.equal((await send(payload)).status, 409);
});

const { createHealthMonitor } = require(path.join(root, "worker", "nj-pwc", "health.js"));
test("monitor independently reports busy heartbeat, startup, code changes, diagnostics and shutdown", async () => {
  const sent = [];
  let code = { hash: "a".repeat(64), modified: new Date(now - 10000).toISOString() };
  let testDelivered = false;
  const monitor = createHealthMonitor({ baseUrl: "http://synthetic.invalid", rpaKey: "synthetic" }, () => true, () => {}, String, {
    metadata: () => code,
    fetch: async (_url, options) => {
      const payload = JSON.parse(options.body); sent.push(payload);
      const testId = payload.lifecycle === "busy" && !testDelivered ? "00000000-0000-0000-0000-000000000002" : null;
      if (testId) testDelivered = true;
      return { ok: true, json: async () => ({ test_id: testId }) };
    },
  });
  try {
    monitor.start(); await monitor.flush();
    monitor.ready(); monitor.polled(); monitor.busy(5);
    code = { hash: "b".repeat(64), modified: new Date(Date.now() + 1000).toISOString() };
    await monitor.flush();
    assert.equal(sent[0].event, "start");
    assert.equal(sent.some((entry) => entry.lifecycle === "busy" && entry.current_request_id === 5), true);
    assert.ok(sent.some((entry) => entry.event === "test"));
    assert.equal(sent.at(-1).loaded_hash, "a".repeat(64));
    assert.equal(sent.at(-1).current_hash, "b".repeat(64));
    monitor.search(5, "No Match Found"); await monitor.flush();
    assert.equal(sent.at(-1).event, "search");
    assert.ok(sent.every((entry, i) => i === 0 || entry.sequence > sent[i - 1].sequence));
  } finally { await monitor.stop(); }
  assert.equal(sent.at(-1).lifecycle, "stopped");
});
test("telemetry transport failure is explicit and leaves extraction independent", async () => {
  const errors = [];
  const monitor = createHealthMonitor({ baseUrl: "http://synthetic.invalid", rpaKey: "synthetic" }, () => false,
    (event) => errors.push(event), String, {
      metadata: () => ({ hash: "a".repeat(64), modified: new Date(now).toISOString() }),
      fetch: async () => { throw new Error("Synthetic network failure"); },
    });
  try { monitor.start(); await monitor.flush(); } finally { await monitor.stop(); }
  assert.ok(errors.some((entry) => entry.event === "health_report_error" && /Synthetic network failure/.test(entry.message)));
});

test("periodic heartbeat runs while busy and reports disconnected browsers without diagnostic spin", async () => {
      const sent = [];
      let connected = true;
      let tick;
      let stopped = false;
      const monitor = createHealthMonitor({ baseUrl: "http://synthetic.invalid", rpaKey: "synthetic" }, () => connected,
        () => {}, String, {
          metadata: () => ({ hash: "a".repeat(64), modified: new Date(now - 10000).toISOString() }),
          setInterval(callback, interval) { assert.equal(interval, 15000); tick = callback; return 1; },
          clearInterval(id) { assert.equal(id, 1); stopped = true; },
          fetch: async (_url, options) => { sent.push(JSON.parse(options.body)); return { ok: true, json: async () => ({ test_id: connected ? null : "synthetic-test" }) }; },
        });
      try {
        monitor.start(); await monitor.flush(); monitor.ready(); monitor.polled(); monitor.busy(6);
        tick(); await monitor.flush();
        assert.equal(sent.at(-1).lifecycle, "busy");
        connected = false;
        const count = sent.length;
        tick(); await monitor.flush();
        assert.equal(sent.length, count + 1);
        assert.equal(sent.at(-1).browser_connected, false);
      } finally { await monitor.stop(); }
      assert.equal(stopped, true);
    });

test("all worker extraction/search helper bodies remain identical to Checkpoint 38", () => {
      const previous = execFileSync("git", ["show", "022d994:worker/nj-pwc/worker.js"], { cwd: root, encoding: "utf8" });
      const current = fs.readFileSync(path.join(root, "worker", "nj-pwc", "worker.js"), "utf8");
      const functions = (source) => {
        const ast = ts.createSourceFile("worker.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
        return new Map(ast.statements.filter(ts.isFunctionDeclaration).map((node) => [node.name.text, node.getText(ast)]));
      };
      const before = functions(previous), after = functions(current);
      for (const [name, code] of before) if (!["main", "processRequest"].includes(name)) assert.equal(after.get(name), code, name);
      const processingBefore = before.get("processRequest");
      const processingAfter = after.get("processRequest");
      assert.equal(processingAfter.slice(0, processingAfter.indexOf('  if (postResult && postResult.ok && ["Match Found"')), processingBefore.slice(0, processingBefore.lastIndexOf("}")));
    });
