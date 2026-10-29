import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function load(relative, dependencies) {
  const compiled = ts.transpileModule(fs.readFileSync(path.join(root, relative), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const loaded = { exports: {} };
  vm.runInNewContext(compiled, { module: loaded, exports: loaded.exports, Error,
    require(name) { assert.ok(name in dependencies, name); return dependencies[name]; } });
  return loaded.exports;
}
test("BRC status ignores legacy expiration without changing expiring PWC behavior", () => {
  const { calculateComplianceStatus } = load("services\\compliance.ts", { "@/lib/supabase": { supabase: {} } });
  for (const expiration_date of [null, "2000-01-01"]) {
    const result = calculateComplianceStatus({ compliance_name: "NJ BRC", requires_expiration: false, expiration_date, registration_number: "1234567" });
    assert.equal(result.calculated_status, "Active");
    assert.equal(result.days_remaining, null);
  }
  assert.equal(calculateComplianceStatus({ compliance_name: "NJ PWC", requires_expiration: true, expiration_date: null, registration_number: "123" }).calculated_status, "Missing Information");
});
test("NJ BRC worker health distinguishes healthy, degraded, and offline states", () => {
  const { classifyWorker, overallWorkerHealth } = load("src\\lib\\worker-health.ts", {});
  const now = Date.parse("2026-10-12T15:00:00Z");
  const worker = {
    worker_key: "nj-brc", display_name: "NJ BRC Worker", enabled: true,
    instance_id: "00000000-0000-4000-8000-000000000001",
    started_at: "2026-10-12T14:00:00Z",
    last_heartbeat_at: "2026-10-12T14:59:45Z",
    lifecycle: "ready", last_poll_at: "2026-10-12T14:59:45Z",
    browser_connected: true, file_modified_at: "2026-10-12T14:00:00Z",
    loaded_hash: "a".repeat(64), current_hash: "a".repeat(64),
    current_request_id: null, current_request_key: null,
    last_search_at: null, last_search_request_id: null, last_search_request_key: null,
    last_search_result: null, last_error_at: null, last_error: null,
    test_id: null, test_requested_at: null, test_acknowledged_at: null,
  };
  assert.equal(classifyWorker(worker, now).health, "online");
  const idle = { ...worker, last_poll_at: "2026-10-12T14:55:00Z" };
  assert.equal(classifyWorker(idle, now).health, "online", "leased BRC heartbeat remains healthy during idle backoff");
  assert.equal(classifyWorker({ ...idle, worker_key: "nj-pwc" }, now).available, false, "PWC queue freshness is unchanged");
  assert.equal(classifyWorker({ ...worker, last_heartbeat_at: "2026-10-12T14:58:45Z" }, now).health, "degraded");
  const offline = { ...worker, last_heartbeat_at: "2026-10-12T14:57:59Z" };
  assert.equal(classifyWorker(offline, now).health, "offline");
  assert.equal(classifyWorker(offline, now).available, false);
  assert.equal(overallWorkerHealth([worker, offline], now), "offline");
});
test("BRC approvals and rejections use server transactional path, not legacy promotion", async () => {
  const calls = [];
  const query = { select() { return this; }, eq() { return this; }, maybeSingle: async () => ({ data: { compliance_name: "NJ BRC" }, error: null }) };
  const service = load("services\\complianceSync.ts", {
    "@/lib/supabase": { supabase: { from(table) { calls.push(table); return query; } } },
    "@/lib/admin-client": { adminFetch: async (url, options) => { calls.push({ url, payload: JSON.parse(options.body) }); return { ok: true, json: async () => ({ ok: true }) }; } },
  });
  for (const decision of ["approved", "rejected"]) {
    const result = await service.reviewComplianceSyncEntry(5, decision, "Synthetic", "test");
    assert.equal(result.error, null);
  }
  assert.equal(calls.filter(item => item === "compliance_sync_review_queue").length, 2);
  assert.ok(calls.filter(item => typeof item === "object").every(item => item.url === "/api/admin/compliance-sync/nj-brc-review"));
  assert.ok(!calls.includes("contractors") && !calls.includes("compliance_records"));
});
test("BRC approval API failure does not become success or fall through to PWC", async () => {
  const query = { select() { return this; }, eq() { return this; }, maybeSingle: async () => ({ data: { compliance_name: "NJ BRC" }, error: null }) };
  const service = load("services\\complianceSync.ts", {
    "@/lib/supabase": { supabase: { from: () => query } },
    "@/lib/admin-client": { adminFetch: async () => ({ ok: false, json: async () => ({ error: "Identity changed; review rejected" }) }) },
  });
  assert.equal((await service.reviewComplianceSyncEntry(5, "approved", "Synthetic")).error.message, "Identity changed; review rejected");
});
