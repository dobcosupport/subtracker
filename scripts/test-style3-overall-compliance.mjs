import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const source = fs.readFileSync(new URL("../services/style3-overall-compliance.ts", import.meta.url), "utf8");
const loadedModule = { exports: {} };
vm.runInNewContext(ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText, { module: loadedModule, exports: loadedModule.exports });
const { calculateOverallContractorCompliance } = loadedModule.exports;
const contractors = [
  { contractor_id: 1, state: "CA", federal_tax_id: "present", nj_brc_number: null, nj_pwc_applicability: "not_applicable" },
  { contractor_id: 2, state: "New Jersey", federal_tax_id: "present", nj_brc_number: null, nj_pwc_applicability: "applicable" },
  { contractor_id: 3, state: "NY", federal_tax_id: null, nj_brc_number: null, nj_pwc_applicability: "not_applicable" },
  { contractor_id: 4, state: "NJ", federal_tax_id: "present", nj_brc_number: null, nj_pwc_applicability: "not_applicable" },
  { contractor_id: 5, state: "NJ", federal_tax_id: "present", nj_brc_number: null, nj_pwc_applicability: "applicable" },
  { contractor_id: 6, state: null, federal_tax_id: null, nj_brc_number: null, nj_pwc_applicability: "unknown" },
];
const records = [
  { contractor_id: 2, compliance_name: "NJ BRC", calculated_status: "Active", registration_number: "brc-2", days_remaining: null },
  { contractor_id: 2, compliance_name: "NJ PWC", calculated_status: "Active", registration_number: "pwc-2", days_remaining: 45 },
  { contractor_id: 5, compliance_name: "NJ BRC", calculated_status: "Active", registration_number: "brc-5", days_remaining: null },
  { contractor_id: 5, compliance_name: "NJ PWC", calculated_status: "30 Day", registration_number: "pwc-5", days_remaining: 30 },
];
const result = JSON.parse(JSON.stringify(calculateOverallContractorCompliance(contractors, records)));
assert.deepEqual({ ...result, rate: Math.round(result.rate * 10) / 10 },
  { population: 6, compliant: 2, nonCompliant: 2, expiringSoon: 1, needsReview: 1, rate: 33.3 });
assert.throws(() => calculateOverallContractorCompliance([contractors[0], contractors[0]], []), /unique contractor IDs/);
assert.throws(() => calculateOverallContractorCompliance(contractors, [
  { ...records[0], contractor_id: 100 },
]), /outside the Dashboard population/);
console.log("Overall compliance: scope, precedence, categories and denominator invariant passed.");
