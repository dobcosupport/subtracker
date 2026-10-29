import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

class AdminApiError extends Error {
  constructor(message, status = 500) { super(message); this.status = status; }
}
const sessionId = "00000000-0000-4000-8000-000000000001";
function load(file, dependencies) {
  const compiled = ts.transpileModule(fs.readFileSync(path.resolve(file), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const loadedModule = { exports: {} };
  vm.runInNewContext(compiled, {
    module: loadedModule, exports: loadedModule.exports, Request, Response, URL, Buffer, process: { env: {} },
    require(name) { assert.ok(name in dependencies, `Unexpected dependency ${name}`); return dependencies[name]; },
  });
  return loadedModule.exports;
}
function fixture({ denied = false, rpcError = null, result = {} } = {}) {
  const calls = [];
  const admin = {
    from() { throw new Error("Queue reads must use a single snapshot RPC, not repeated scans."); },
    async rpc(name, args) { calls.push({ kind: "read", name, args }); return { data: result, error: rpcError }; },
  };
  const permission = {
    AdminApiError,
    async requireModulePermission(_request, module, action) {
      calls.push({ kind: "permission", module, action });
      if (denied) throw new AdminApiError("Forbidden.", 403);
      return { admin };
    },
  };
  const worker = load("src\\lib\\server-nj-brc-worker.ts", {
    "server-only": {}, "@/lib/server-admin": permission, "@/lib/worker-health": {},
    "@supabase/supabase-js": {}, "node:crypto": { timingSafeEqual: () => true },
  });
  const helpers = load("src\\lib\\server-nj-brc-queue.ts", { "server-only": {}, "@/lib/server-admin": permission });
  const dependencies = {
    "@/lib/server-admin": permission, "@/lib/server-nj-brc-queue": helpers,
    "@/lib/server-nj-brc-worker": {
      ...worker,
      njBrcUserClient() {
        return { async rpc(name, args) { calls.push({ kind: "mutation", name, args }); return { data: result, error: rpcError }; } };
      },
    },
  };
  return {
    calls,
    queue: load("src\\app\\api\\admin\\compliance-sync\\nj-brc-queue\\route.ts", dependencies),
    sessions: load("src\\app\\api\\admin\\compliance-sync\\nj-brc-sessions\\route.ts", dependencies),
  };
}
const get = (query = "") => new Request(`https://fixture.invalid/api?${query}`);
const body = (value, method = "POST") => new Request("https://fixture.invalid/api", {
  method, headers: { "content-type": "application/json" }, body: typeof value === "string" ? value : JSON.stringify(value),
});
test("queue and session reads/mutations require permissions before any database access", async () => {
  for (const [action, call] of [
    ["view", (f) => f.queue.GET(get())],
    ["view", (f) => f.sessions.GET(get(`session_id=${sessionId}`))],
    ["manage", (f) => f.sessions.POST(body({ contractor_ids: [1] }))],
    ["manage", (f) => f.sessions.PATCH(body({ session_id: sessionId, action: "pause" }, "PATCH"))],
  ]) {
    const f = fixture({ denied: true });
    assert.equal((await call(f)).status, 403);
    assert.deepEqual(f.calls, [{ kind: "permission", module: "compliance_sync", action }]);
  }
});
test("queue GET performs exactly one read RPC and returns its consistent population snapshot", async () => {
  const result = {
    rows: [{ contractor_id: 1, company_name: "Material Only Fixture", fein_status: "valid", bucket: "ready" }],
    counts: { all: 1, ready: 1, existing_brc: 0, missing_information: 0, needs_review: 0, verified: 0, no_result: 0, failed: 0 },
    total_filtered: 1, page: 2, page_size: 50,
  };
  const f = fixture({ result });
  const response = await f.queue.GET(get("bucket=ready&search=Fixture&page=2&page_size=50"));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), result);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(f.calls.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls[1])), {
    kind: "read", name: "get_nj_brc_verification_queue",
    args: { p_bucket: "ready", p_search: "Fixture", p_page: 2, p_page_size: 50 },
  });
});
test("queue rejects unsupported buckets, invalid pagination and excessive search without querying", async () => {
  for (const query of ["bucket=material_only", "page=0", "page=-1", "page=01", "page=1.5", "page=100001",
    "page_size=101", "page_size=0", `search=${"x".repeat(101)}`]) {
    const f = fixture();
    assert.equal((await f.queue.GET(get(query))).status, 400, query);
    assert.equal(f.calls.length, 1, query);
  }
});
test("safe errors surface database failure without leaking SQL, FEIN, or a fake empty population", async () => {
  for (const [code, status] of [["42501", 403], ["P0002", 404], ["22023", 400], ["23505", 409], ["55000", 409], ["XX000", 500]]) {
    const f = fixture({ rpcError: { code, message: "private FEIN 00-1234567 SQL internals" } });
    const response = await f.queue.GET(get());
    assert.equal(response.status, status);
    const result = await response.json();
    assert.equal(typeof result.error, "string");
    assert.equal("rows" in result, false);
    assert.ok(!JSON.stringify(result).includes("1234567"));
  }
});
test("manifest creation rejects invalid/duplicate IDs, secret overrides and malformed bodies", async () => {
  for (const payload of ["{", "null", "[]", { contractor_ids: [] }, { contractor_ids: [1, 1] },
    { contractor_ids: [true] }, { contractor_ids: [2147483648] }, { contractor_ids: [1], federal_tax_id: "00-1234567" },
    { contractor_ids: Array.from({ length: 5001 }, (_, index) => index + 1) }]) {
    const f = fixture();
    assert.equal((await f.sessions.POST(body(payload))).status, 400);
    assert.equal(f.calls.filter((call) => call.kind === "mutation").length, 0);
  }
});
test("manifest creation uses actor-scoped coordination RPC, not search creation/claim/worker RPCs", async () => {
  const f = fixture({ result: sessionId });
  const response = await f.sessions.POST(body({ contractor_ids: [7, 1] }));
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { session_id: sessionId, status: "prepared", member_count: 2 });
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls[1])), {
    kind: "mutation", name: "create_nj_brc_verification_session", args: { p_contractor_ids: [7, 1] },
  });
  assert.equal(f.calls.length, 2);
});
test("session detail reads all frozen membership through one read RPC", async () => {
  const session = { id: sessionId, status: "prepared", member_count: 1, members: [{ ordinal: 1, contractor_id: 7, company_name: "Fixture" }] };
  const f = fixture({ result: session });
  const response = await f.sessions.GET(get(`session_id=${sessionId}`));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { session });
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls[1])), {
    kind: "read", name: "get_nj_brc_verification_session", args: { p_session_id: sessionId },
  });
});
test("session list returns server aggregates through one RPC without embedded members or client-side counts", async () => {
  const result = {
    sessions: [{
      id: sessionId, status: "running", member_count: 5000,
      completed_count: 3500, skipped_count: 1200, current_ordinal: 4701,
      last_error: null, created_at: "2026-10-29T12:00:00Z", updated_at: "2026-10-29T12:00:00Z",
    }],
    total: 115,
  };
  const f = fixture({ result });
  const response = await f.sessions.GET(get());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), result);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].name, "list_nj_brc_verification_sessions");
  assert.equal(f.calls[1].kind, "read");
});
test("session transitions permit only administrative start/pause/resume/stop", async () => {
  for (const action of ["start", "pause", "resume", "stop"]) {
    const f = fixture({ result: { id: sessionId, status: { start: "running", pause: "paused", resume: "running", stop: "stopped" }[action] } });
    assert.equal((await f.sessions.PATCH(body({ session_id: sessionId, action }, "PATCH"))).status, 200);
    assert.equal(f.calls[1].name, "set_nj_brc_verification_session_state");
    assert.equal(f.calls[1].kind, "mutation");
  }
  for (const payload of [{ session_id: sessionId, action: "complete" }, { session_id: sessionId, action: "process" },
    { session_id: "bad", action: "pause" }, { session_id: sessionId, action: "resume", request_id: sessionId }]) {
    const f = fixture();
    assert.equal((await f.sessions.PATCH(body(payload, "PATCH"))).status, 400);
    assert.equal(f.calls.length, 1);
  }
});
