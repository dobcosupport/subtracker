import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const source = fs.readFileSync(new URL("../services/style3-compliance-metrics.ts", import.meta.url), "utf8");
const loaded = { exports: {} };
vm.runInNewContext(ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText, { module: loaded, exports: loaded.exports });
const { calculateCurrentCompliance } = loaded.exports;
const assessment = (contractorId, requirementId, applicability, status) =>
  ({ contractorId, requirementId, applicability, status });
const assessments = [
  assessment(1, "eligible", "applicable", "current"),
  assessment(1, "not-required", "not_applicable", "deficient"),
  assessment(2, "eligible", "applicable", "expiring"),
  assessment(3, "eligible", "applicable", "deficient"),
  assessment(4, "eligible", "applicable", "current"),
  assessment(4, "unmodeled", "unknown", "unknown"),
  assessment(5, "eligible", "applicable", "unknown"),
  assessment(6, "unrelated", "not_applicable", "unknown"),
  assessment(8, "known", "applicable", "deficient"),
  assessment(8, "unmodeled", "unknown", "unknown"),
  assessment(99, "excluded", "applicable", "deficient"),
];
const metric = JSON.parse(JSON.stringify(calculateCurrentCompliance([1, 2, 3, 4, 5, 6, 7, 8], assessments)));
assert.deepEqual(metric, { knownCurrent: 3, knownDeficient: 2, needsReview: 4, percentage: 60 });
const empty = JSON.parse(JSON.stringify(calculateCurrentCompliance([7], [])));
assert.deepEqual(empty, { knownCurrent: 0, knownDeficient: 0, needsReview: 1, percentage: null });
assert.throws(() => calculateCurrentCompliance([1], [assessments[0], assessments[0]]), /Duplicate/);
console.log("Style 3 compliance metric: authority, unknown and denominator handling passed.");
