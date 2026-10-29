import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

class AdminApiError extends Error {
  constructor(message, status = 500) { super(message); this.status = status; }
}
const session = "00000000-0000-4000-8000-000000000001";
const instance = "00000000-0000-4000-8000-000000000002";
const requestId = "00000000-0000-4000-8000-000000000003";
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
function fixture({ authorized = true, error = null, result = { session: { id: session, status: "running" }, member: null, request: null } } = {}) {
  const calls = [];
  const permission = { AdminApiError };
  const worker = load("src\\lib\\server-nj-brc-worker.ts", {
    "server-only": {}, "@/lib/server-admin": permission, "@/lib/worker-health": {},
    "@supabase/supabase-js": {}, "node:crypto": {},
  });
  const route = load("src\\app\\api\\integrations\\compliance-sync\\nj-brc\\batch\\route.ts", {
    "@/lib/server-admin": permission,
    "@/lib/server-nj-brc-worker": {
      ...worker,
      async requireNjBrcWorkerAuth() {
        calls.push({ kind: "auth" });
        if (!authorized) return Response.json({ error: "Unauthorized." }, { status: 401 });
        return { admin: { async rpc(name, args) {
          calls.push({ name, args });
          return { data: result, error };
        } } };
      },
    },
  });
  return { route, calls, result };
}
const get = (query = `instance_id=${instance}&session_id=${session}`) => new Request(`https://fixture.invalid/api?${query}`);
const post = (payload) => new Request("https://fixture.invalid/api", {
  method: "POST", headers: { "content-type": "application/json" },
  body: typeof payload === "string" ? payload : JSON.stringify(payload),
});

test("batch authentication precedes parsing and any database access", async () => {
  const f = fixture({ authorized: false });
  assert.equal((await f.route.GET(get("bad"))).status, 401);
  assert.equal((await f.route.POST(post("{"))).status, 401);
  assert.equal(f.calls.length, 2);
});
test("batch GET is owned read-only control, not a claim or global queue scan", async () => {
  const f = fixture();
  const response = await f.route.GET(get());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), f.result);
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls[1])), {
    name: "get_owned_nj_brc_batch", args: { p_instance: instance, p_session: session },
  });
});
test("batch rejects missing, duplicate, malformed and override query parameters", async () => {
  for (const query of ["", `instance_id=${instance}`, `session_id=${session}`,
    `instance_id=bad&session_id=${session}`, `instance_id=${instance}&session_id=${session}&action=next`,
    `instance_id=${instance}&instance_id=${instance}&session_id=${session}`]) {
    const f = fixture();
    assert.equal((await f.route.GET(get(query))).status, 400, query);
    assert.equal(f.calls.length, 1);
  }
});
test("batch mutates only through service-scoped bound next/complete/pause RPC", async () => {
  for (const action of ["next", "complete", "pause"]) {
    const f = fixture();
    const response = await f.route.POST(post({
      instance_id: instance, session_id: session, action, ...(action === "complete" ? { request_id: requestId } : {}),
    }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), f.result);
    assert.deepEqual(JSON.parse(JSON.stringify(f.calls[1])), {
      name: "control_nj_brc_batch",
      args: { p_instance: instance, p_session: session, p_action: action, p_request: action === "complete" ? requestId : null },
    });
  }
});
test("batch rejects user identity/input overrides, unsupported actions and malformed completion", async () => {
  const valid = { instance_id: instance, session_id: session, action: "next" };
  for (const payload of ["{", "null", "[]", {}, { ...valid, instance_id: "bad" }, { ...valid, session_id: 1 },
    { ...valid, action: "start" }, { ...valid, action: "resume" }, { ...valid, action: "complete" },
    { ...valid, request_id: requestId }, { ...valid, created_by: session }, { ...valid, contractor_id: 1 },
    { ...valid, federal_tax_id: "00-1234567" }, { ...valid, action: "complete", request_id: "bad" }]) {
    const f = fixture();
    assert.equal((await f.route.POST(post(payload))).status, 400, JSON.stringify(payload));
    assert.equal(f.calls.length, 1);
  }
});
test("batch reports lease conflicts and database failures without sensitive diagnostics", async () => {
  for (const [code, status] of [["42501", 403], ["55000", 409], ["P0002", 404], ["22023", 400], ["XX000", 500]]) {
    const f = fixture({ error: { code, message: "Secret FEIN 00-1234567 SQL internals" } });
    const response = await f.route.POST(post({ instance_id: instance, session_id: session, action: "next" }));
    assert.equal(response.status, status);
    assert.ok(!JSON.stringify(await response.json()).includes("1234567"));
  }
});
