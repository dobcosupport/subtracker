import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const source = fs.readFileSync(new URL("../services/style3-project-metrics.ts", import.meta.url), "utf8");
const rows = [
  { id: 1, status: "Active", public_works: true },
  { id: 2, status: "Active", public_works: false },
  { id: 3, status: "Active", public_works: null },
  { id: 4, status: "Closed", public_works: true },
  { id: 5, status: "Inactive", public_works: false },
];
let fail = false;
let loadedRows = rows.filter((row) => row.status === "Active");
const calls = [];
const loaded = { exports: {} };
vm.runInNewContext(ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText, {
  module: loaded,
  exports: loaded.exports,
  require(name) {
    assert.equal(name, "@/lib/supabase");
    return { supabase: { from(table) {
      assert.equal(table, "projects");
      const query = {
        select() { return query; },
        eq(field, value) { assert.equal(field, "status"); assert.equal(value, "Active"); return query; },
        order(field) { assert.equal(field, "id"); return query; },
        range(start, end) { calls.push([start, end]); return query; },
        returns() {
          return Promise.resolve(fail
            ? { data: null, error: { message: "read failed" } }
            : { data: loadedRows.slice(calls.at(-1)[0], calls.at(-1)[1] + 1), error: null });
        },
      };
      return query;
    } } };
  },
});
const { countActiveProjectsByWorkType, getActiveProjectWorkTypes } = loaded.exports;
const expected = [
  { type: "Public Works", count: 1 },
  { type: "Non-Public Works", count: 1 },
  { type: "Unspecified", count: 1 },
];
assert.deepEqual(JSON.parse(JSON.stringify(countActiveProjectsByWorkType(rows))), expected);
assert.deepEqual(JSON.parse(JSON.stringify((await getActiveProjectWorkTypes()).data)), expected);
assert.deepEqual(calls, [[0, 499]]);
loadedRows = Array.from({ length: 501 }, (_, id) => ({ id, status: "Active", public_works: true }));
calls.length = 0;
const paginated = await getActiveProjectWorkTypes();
assert.equal(paginated.data[0].count, 501);
assert.deepEqual(calls, [[0, 499], [500, 999]]);
fail = true;
const result = await getActiveProjectWorkTypes();
assert.equal(result.data, null);
assert.match(result.error.message, /read failed/);
console.log("Style 3 project metric: active-only work types and read failures passed.");
