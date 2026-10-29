import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { EventEmitter } from "node:events";

const require = createRequire(import.meta.url);
const { timingConfig, createBackoff, retryTransient } = require("../worker/nj-brc/runtime.js");
const { createHealthMonitor } = require("../worker/nj-brc/health.js");

test("idle delays are bounded, work resets immediately, transient failures have separate bounded backoff", () => {
  const backoff = createBackoff(timingConfig({}));
  assert.deepEqual(Array.from({ length: 7 }, () => backoff.empty()), [30000,60000,120000,240000,300000,300000,300000]);
  backoff.work();
  assert.equal(backoff.empty(),30000);
  assert.deepEqual(Array.from({ length: 5 }, () => backoff.error()), [30000,60000,120000,120000,120000]);
  backoff.work(); assert.equal(backoff.error(),30000);
  assert.equal(timingConfig({ IDLE_MAX_SECONDS: "600", HEARTBEAT_SECONDS: "25" }).idleMax,600000);
  for (const env of [{ IDLE_MAX_SECONDS: "0" },{ HEARTBEAT_SECONDS: "60" },{ POLL_INTERVAL_SECONDS: "NaN" },
    { POLL_INTERVAL_SECONDS: "60", IDLE_MAX_SECONDS: "30" }]) assert.throws(() => timingConfig(env));
});

test("transient reporting retries use injected delays and never retry terminal/ownership errors", async () => {
  let count = 0;
  const delays = [];
  const options = { attempts: 3, sleep: async (ms) => delays.push(ms) };
  assert.equal(await retryTransient(async () => {
    if (++count < 3) throw Object.assign(new Error("Transient"),{ retryable: true });
    return "persisted";
  },options),"persisted");
  assert.deepEqual(delays,[1000,2000]);
  for (const code of ["ownership_lost","unauthorized","invalid_response"]) {
    count = 0;
    await assert.rejects(retryTransient(async () => { count++; throw Object.assign(new Error(code),{ code }); },options));
    assert.equal(count,1);
  }
  count = 0;
  await assert.rejects(retryTransient(async () => { count++; throw Object.assign(new Error("Transient"),{ retryable: true }); },options));
  assert.equal(count,3);
});

function healthFixture() {
  const deadlines = new Map(), intervals = new Map(), posts = [], lost = [], errors = [];
  let id = 0, reject = false;
  const monitor = createHealthMonitor({ baseUrl: "https://offline.invalid",workerKey: "synthetic",heartbeatMs: 20000 },
    () => true,(entry) => errors.push(entry),String,{
      instanceId: "00000000-0000-4000-8000-000000000001",
      metadata: () => ({ hash: "a".repeat(64),modified: "2026-10-29T00:00:00Z" }),
      setInterval: (fn,ms) => { intervals.set(++id,{ fn,ms }); return id; },
      clearInterval: (key) => intervals.delete(key),
      setTimeout: (fn,ms) => { deadlines.set(++id,{ fn,ms }); return id; },
      clearTimeout: (key) => deadlines.delete(key),
      onLeaseLost: (reason) => lost.push(reason),
      fetch: async (_url,options) => {
        posts.push(JSON.parse(options.body));
        return { ok: !reject,status: reject ? 409 : 200,json: async () => ({ ok: true }) };
      },
    });
  return { monitor,deadlines,intervals,posts,lost,errors,reject: () => { reject = true; } };
}
test("unchanged idle health is coalesced; one RPC per configurable heartbeat, no idle event writes", async () => {
  const f = healthFixture();
  f.monitor.start(); await f.monitor.flush();
  assert.equal(f.posts.length,1);
  for (let i=0;i<20;i++) { f.monitor.ready(); f.monitor.polled(); f.monitor.idle(); }
  assert.equal(f.posts.length,1);
  const timer = [...f.intervals.values()][0];
  assert.equal(timer.ms,20000);
  for (let i=0;i<3;i++) { timer.fn(); await f.monitor.flush(); }
  assert.equal(f.posts.length,4);
  assert.ok(f.posts.slice(1).every((post) => !post.event));
  await f.monitor.stop();
  assert.equal(f.posts.at(-1).event,"stop");
  assert.equal(f.intervals.size,0); assert.equal(f.deadlines.size,0);
});
test("missed renewals and explicit lease rejection fence the process; failures never extend its deadline", async () => {
  const f = healthFixture();
  f.monitor.start(); await f.monitor.flush();
  const deadline = [...f.deadlines.values()][0];
  assert.equal(deadline.ms,80000);
  f.reject();
  assert.equal(await f.monitor.flush(),false);
  assert.match(f.lost[0],/409/);
  assert.equal([...f.deadlines.values()][0],deadline);
  deadline.fn(); assert.match(f.lost.at(-1),/deadline/);
  assert.equal(f.errors.length,1);
  await f.monitor.stop();
});

test("instrumented lifecycle handles both signals, releases ownership, and exits nonzero on lease loss without starting a worker", async () => {
  for (const reason of ["SIGINT","SIGTERM","lease_lost"]) {
    const calls = [],logs = [],timers = new Map();
    let lock = null;
    const fakeProcess = Object.assign(new EventEmitter(),{
      pid: 12345,exitCode: 0,env: { SUBTRACKER_BASE_URL: "https://offline.invalid",NJ_BRC_WORKER_KEY: "synthetic" },
    });
    const memoryFs = {
      existsSync: (file) => file.endsWith("worker.lock") && lock !== null,mkdirSync() {},closeSync() {},
      openSync: () => { lock = ""; return 1; },writeFileSync: (_fd,text) => { lock = text; },
      readFileSync: () => lock,unlinkSync: () => { lock = null; },
      appendFileSync: (_file,text) => logs.push(JSON.parse(text)),
    };
    const workerRequire = createRequire(path.resolve("worker","nj-brc","worker.js"));
    const loaded = { exports: {} };
    const source = fs.readFileSync(path.resolve("worker","nj-brc","worker.js"),"utf8");
    vm.runInNewContext(source + "\nmodule.exports.instrumentedMain=main;",{
      module: loaded,exports: loaded.exports,__dirname: path.resolve("worker","nj-brc"),process: fakeProcess,
      console: { log() {},error() {} },AbortController,AbortSignal,URL,
      setTimeout: (fn,ms) => { const key = timers.size+1; timers.set(key,{ fn,ms }); return key; },
      clearTimeout: (key) => timers.delete(key),
      fetch: async (url,options) => {
        const body = options.body ? JSON.parse(options.body) : {};
        calls.push(body.action || "claim");
        if (!body.action) fakeProcess.emit(reason);
        return { ok: true,status: 200,json: async () => body.action === "release"
          ? { released: true } : body.action ? { owned: true } : { request: null } };
      },
      require(name) {
        if (name === "node:fs") return memoryFs;
        if (name === "playwright") return { chromium: { launch: async () => ({
          isConnected: () => true,
          newContext: async () => ({ setDefaultTimeout() {},close: async () => calls.push("context_close") }),
          close: async () => calls.push("browser_close"),
        }) } };
        if (name === "./health") return { createHealthMonitor: (_config,_connected,_log,_sanitize,deps) => ({
          start() { if (reason === "lease_lost") deps.onLeaseLost("Synthetic ownership lost."); },
          ready() {},polled() {},flush: async () => true,stop: async () => calls.push("health_stop"),
        }) };
        return workerRequire(name);
      },
    });
    await loaded.exports.instrumentedMain();
    assert.equal(calls[0],"acquire");
    assert.equal(calls.at(-1),"release");
    assert.equal(calls.filter((call) => call === "claim").length,reason === "lease_lost" ? 0 : 1);
    assert.equal(lock,null); assert.equal(timers.size,0);
    assert.equal(fakeProcess.listenerCount("SIGINT"),0);
    assert.equal(fakeProcess.listenerCount("SIGTERM"),0);
    assert.equal(fakeProcess.exitCode,reason === "lease_lost" ? 1 : 0);
    assert.ok(logs.some((entry) => entry.event === (reason === "lease_lost" ? "ownership_lost" : "shutdown_requested")));
    assert.equal(logs.at(-1).event,"worker_stop");
  }
});
