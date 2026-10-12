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
