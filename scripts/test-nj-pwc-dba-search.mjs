import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const load = (relative, dependencies = {}) => {
  const source = fs.readFileSync(path.join(root, relative), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const loaded = { exports: {} };
  vm.runInNewContext(compiled, {
    module: loaded, exports: loaded.exports,
    require(name) {
      if (name in dependencies) return dependencies[name];
      throw new Error(`Unexpected import ${name}`);
    },
  }, { filename: relative });
  return loaded.exports;
};

const matching = load("src\\lib\\contractor-matching.ts");
const search = load("src\\lib\\nj-pwc-contractor-search.ts", {
  "@/lib/contractor-matching": matching,
});
assert.deepEqual(
  Array.from(search.getNjPwcSearchNames("LBJ Interior Solutions LLC", "LBJ Flooring LLC")),
  ["LBJ Interior Solutions LLC", "LBJ Flooring LLC"],
  "legal name and DBA each generate a query",
);
assert.deepEqual(
  Array.from(search.getNjPwcSearchNames("LBJ Flooring LLC", "LBJ Flooring, L.L.C.")),
  ["LBJ Flooring LLC"],
  "equivalent normalized legal and DBA names generate one query",
);
const [legalCandidate, dbaCandidate] = search.attachNjPwcSearchProvenance([
  { requestId: 31, searched_company_name: "LBJ Interior Solutions LLC", candidates: [{ business_name: "LBJ Interior Solutions LLC" }] },
  { requestId: 32, searched_company_name: "LBJ Flooring LLC", candidates: [{ business_name: "LBJ Interior Solutions LLC" }] },
]);
assert.deepEqual(
  [legalCandidate.searched_company_name, legalCandidate.search_request_id, dbaCandidate.searched_company_name, dbaCandidate.search_request_id],
  ["LBJ Interior Solutions LLC", 31, "LBJ Flooring LLC", 32],
  "each registry result preserves the searched name and request ID",
);
console.log("PASS: NJ PWC searches legal and DBA names, deduplicates normalized equivalents, and preserves result provenance.");
