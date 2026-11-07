import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const loaded = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL("../services/style3-dashboard-operations.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText, { module: loaded, exports: loaded.exports, require(name) {
  if (name === "@/lib/supabase") return {};
  if (name === "@/lib/admin-client") return {};
  throw new Error(`Unexpected dependency ${name}`);
} });
const rows = ["2026-11-06", "2026-11-07", "2026-11-08", null].map(followup_date => ({ followup_date }));
const summary = loaded.exports.summarizeFollowupDates(rows, new Date(2026, 10, 7, 23, 59));
assert.equal(summary.past, 1);
assert.equal(summary.thisWeek, 1);
assert.equal(summary.classify("2026-11-08"), "upcoming");
assert.equal(summary.classify(null), "undated");
const sunday = loaded.exports.summarizeFollowupDates(rows, new Date(2026, 10, 8));
assert.equal(sunday.past, 2);
assert.equal(sunday.thisWeek, 1);
console.log("Dashboard follow-up dates: local calendar boundaries, undated and upcoming passed.");
