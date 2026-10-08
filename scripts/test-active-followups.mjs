import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import { renderToStaticMarkup } from "react-dom/server";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const filename = path.join(root, "src", "app", "contractors", "[id]", "page.tsx");
const source = fs.readFileSync(filename, "utf8");
const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const require = createRequire(import.meta.url);
const declarations = new Map();
let panel;
let relatedSelect;
function visit(node) {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
    declarations.set(node.name.text, node.initializer?.getText(ast));
  }
  if (ts.isJsxElement(node) && node.openingElement.attributes.properties.some(
    (attribute) => ts.isJsxAttribute(attribute) && attribute.name.getText(ast) === "aria-labelledby"
      && attribute.initializer?.getText(ast) === '"active-followups-heading"'
  )) panel = node.getText(ast);
  if (ts.isJsxElement(node) && node.openingElement.attributes.properties.some(
    (attribute) => ts.isJsxAttribute(attribute) && attribute.name.getText(ast) === "id"
      && attribute.initializer?.getText(ast) === '"related_compliance_record"'
  )) relatedSelect = node.getText(ast);
  ts.forEachChild(node, visit);
}
visit(ast);
assert.ok(panel, "Active follow-ups must be a labelled section");

const helperSource = fs.readFileSync(path.join(root, "src", "lib", "followup-related-item.ts"), "utf8");
const helperModule = { exports: {} };
vm.runInNewContext(ts.transpileModule(helperSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText, { module: helperModule, exports: helperModule.exports });
const helpers = helperModule.exports;

function evaluate(expression, context) {
  const compiled = ts.transpileModule(`const value = ${expression}; module.exports = value;`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const loadedModule = { exports: {} };
  const records = context.records ?? [];
  const form = context.followupForm ?? { related_item: "", compliance_record_id: "" };
  const matching = records.filter((record) => form.related_item === `compliance:${record.compliance_type_id}`);
  vm.runInNewContext(compiled, {
    module: loadedModule, exports: loadedModule.exports, require, ...helpers,
    records, complianceTypes: [], matchingFollowupRecords: matching,
    activeFollowupRecords: matching.filter((record) => record.active && record.is_current),
    historicalFollowupRecords: matching.filter((record) => !record.active || !record.is_current),
    ...context,
  }, { filename });
  return loadedModule.exports;
}

const makeFollowup = (id, status, overrides = {}) => ({
  id, contractor_id: 14, compliance_record_id: null, compliance_type_id: null, insurance_item_key: null, followup_date: "2026-10-08",
  followup_method: "Email", subject: `Follow-up ${id}`, notes: "Existing notes",
  status, created_at: "2026-10-08T12:00:00Z", updated_at: "2026-10-08T12:00:00Z", ...overrides,
});
const getActive = (followups) => evaluate(declarations.get("activeFollowups"), {
  followups, useMemo: (callback) => callback(),
});

function harness(initial, result) {
  const state = {
    followups: initial, editingFollowup: initial[0], modalOpen: true,
    form: { ...initial[0], related_item: "", compliance_record_id: "", notes: initial[0].notes ?? "" },
    error: null, saving: false, success: null, reloads: [], calls: [],
  };
  let releaseReload;
  const reload = new Promise((resolve) => { releaseReload = resolve; });
  let signalReload;
  const reloadStarted = new Promise((resolve) => { signalReload = resolve; });
  const context = {
    contractorId: 14, Date,
    setFollowups: (update) => { state.followups = update(state.followups); },
    setEditingFollowup: (value) => { state.editingFollowup = value; },
    setFollowupForm: (value) => { state.form = value; },
    setFollowupModalOpen: (value) => { state.modalOpen = value; },
    setFollowupError: (value) => { state.error = value; },
    setSaving: (value) => { state.saving = value; },
    setSuccess: (value) => { state.success = value; },
    updateFollowup: async (id, payload) => { state.calls.push({ id, payload }); return result; },
    createFollowup: async (payload) => { state.calls.push({ payload }); return result; },
    loadDetails: async (background) => { state.reloads.push(background); signalReload(); await reload; },
  };
  return {
    state, releaseReload, reloadStarted,
    save: () => evaluate(declarations.get("saveFollowup"), {
      ...context, followupForm: state.form, editingFollowup: state.editingFollowup,
    })({ preventDefault() {} }),
    open: (followup) => evaluate(declarations.get("openFollowupEdit"), context)(followup),
  };
}

test("active scope is independent of history status filters", () => {
  const rows = ["Open", "Waiting Response", "Closed", "Resolved"].map((status, index) => makeFollowup(index + 1, status));
  assert.deepEqual(Array.from(getActive(rows), (row) => row.id), [1, 2]);
  const history = evaluate(declarations.get("filteredFollowups"), { followups: rows, followupStatusFilter: null, useMemo: (callback) => callback() });
  assert.equal(history.length, 4);
});

test("cards have native keyboard button semantics, metadata, and reuse the editor", () => {
  const rows = [makeFollowup(1, "Open", { compliance_record_id: 8 }), makeFollowup(2, "Waiting Response")];
  const h = harness(rows, { data: null, error: null });
  const element = evaluate(panel, {
    activeFollowups: rows, records: [{ id: 8, compliance_name: "NJ PWC" }],
    openFollowupEdit: h.open,
  });
  const html = renderToStaticMarkup(element);
  assert.match(html, /Active Follow-Ups \(2\)/);
  assert.equal((html.match(/<button /g) ?? []).length, 2);
  assert.match(html, /type="button"/);
  assert.match(html, /focus-visible:outline/);
  assert.match(html, /Follow-Up Date: 2026-10-08/);
  assert.match(html, /Status: Waiting Response/);
  assert.match(html, /Method: Email/);
  assert.equal((html.match(/Related Item:/g) ?? []).length, 2);
  assert.match(html, /Related Item: NJ PWC/);
  const card = element.props.children[1].props.children[0][0];
  card.props.onClick();
  assert.equal(h.state.editingFollowup.id, 1);
  assert.equal(h.state.modalOpen, true);
  assert.equal(h.state.form.compliance_record_id, "8");
  for (const key of ["followup_date", "followup_method", "subject", "notes", "status"]) {
    assert.equal(h.state.form[key], rows[0][key]);
  }
});

for (const status of ["Open", "Waiting Response", "Closed", "Resolved"]) {
  test(`confirmed ${status} save immediately updates active list and retains history`, async () => {
    const original = makeFollowup(1, "Open");
    const historical = makeFollowup(2, "Closed", { followup_date: "2026-09-01" });
    const saved = { ...original, status, subject: "Edited subject", notes: "Edited notes" };
    const h = harness([original, historical], { data: [saved], error: null });
    Object.assign(h.state.form, saved, { related_item: "compliance:6", compliance_record_id: "8" });
    const saving = h.save();
    await h.reloadStarted;
    assert.equal(getActive(h.state.followups).length, ["Open", "Waiting Response"].includes(status) ? 1 : 0);
    assert.equal(h.state.followups.length, 2);
    assert.equal(h.state.followups.find((row) => row.id === 1).status, status);
    assert.equal(h.state.followups.find((row) => row.id === 2), historical);
    assert.equal(h.state.modalOpen, false);
    assert.deepEqual(h.state.reloads, [true], "Audit/history reload runs in background");
    assert.equal(h.state.calls.length, 1);
    assert.equal(h.state.calls[0].payload.compliance_record_id, 8);
    assert.equal(h.state.calls[0].payload.notes, "Edited notes");
    h.releaseReload();
    await saving;
    assert.equal(h.state.saving, false);
  });
}

test("failed saves preserve active item and leave editor open", async () => {
  for (const result of [{ data: null, error: { message: "Permission denied" } }, { data: [], error: { message: "Follow-up was not updated." } }]) {
    const original = makeFollowup(1, "Open");
    const h = harness([original], result);
    h.state.form.status = "Closed";
    await h.save();
    assert.equal(h.state.followups[0], original);
    assert.equal(getActive(h.state.followups).length, 1);
    assert.equal(h.state.modalOpen, true);
    assert.ok(h.state.error);
    assert.equal(h.state.saving, false);
    assert.equal(h.state.reloads.length, 0);
  }
});

for (const data of [null, []]) {
  for (const status of ["Open", "Waiting Response", "Closed", "Resolved"]) {
    test(`successful ${status} update with ${data === null ? "null" : "empty"} returned data remains successful`, async () => {
      const original = makeFollowup(1, "Open", { compliance_record_id: 8 });
      const history = makeFollowup(2, "Resolved");
      const h = harness([original, history], { data, error: null });
      h.open(original);
      Object.assign(h.state.form, { status, subject: "Changed subject" });
      const saving = h.save();
      await h.reloadStarted;
      assert.equal(h.state.error, null);
      assert.equal(h.state.modalOpen, false);
      assert.equal(h.state.followups.length, 2);
      assert.equal(h.state.followups.find((row) => row.id === 2), history);
      const saved = h.state.followups.find((row) => row.id === 1);
      assert.equal(saved.status, status);
      assert.equal(saved.subject, "Changed subject");
      assert.equal(saved.compliance_record_id, 8);
      assert.equal(getActive(h.state.followups).length, ["Open", "Waiting Response"].includes(status) ? 1 : 0);
      h.releaseReload();
      await saving;
      assert.equal(h.state.saving, false);
    });
  }
}

test("related selector preselects active, archived, and unavailable associations", () => {
  const records = [
    { id: 8, compliance_type_id: 6, compliance_name: "NJ PWC", registration_number: "12345", active: false, is_current: false, expiration_date: "2025-01-01" },
    { id: 9, compliance_type_id: 6, compliance_name: "NJ PWC", active: true, is_current: true, expiration_date: null },
    { id: 10, compliance_type_id: 8, compliance_name: "NY PWC", active: true, is_current: false, expiration_date: null },
  ];
  for (const selected of ["8", "9", "99", ""]) {
    const element = evaluate(relatedSelect, { records, followupForm: { related_item: "compliance:6", compliance_record_id: selected }, setFollowupForm() {} });
    const html = renderToStaticMarkup(element);
    const options = [];
    function collect(node) {
      if (Array.isArray(node)) return node.forEach(collect);
      if (node?.type === "option") options.push(node.props.value);
      else if (node?.props) collect(node.props.children);
    }
    collect(element);
    assert.equal(options.some((value) => String(value) === selected), true);
    assert.match(html, new RegExp(`value="${selected}" selected=""`));
    assert.equal(options.includes(10), false, "Records of other types are not offered");
    assert.equal(options.filter((value) => String(value) === "8").length, 1);
    assert.match(html, /label="Active Compliance Records"/);
    assert.match(html, /label="Historical Compliance Records"/);
    assert.match(html, /NJ PWC - 12345 \(Historical\) - Expires 01\/01\/2025/);
    if (selected === "8") assert.match(html, /value="8" selected="">NJ PWC - 12345 \(Historical\)/);
    if (selected === "99") assert.match(html, /Previously linked compliance record #99 \(unavailable\)/);
    if (!selected) assert.match(html, /value="" selected="">No specific record/);
  }
});

test("only an explicit None selection clears an existing relationship", async () => {
  const original = makeFollowup(1, "Open", { compliance_record_id: 8 });
  const h = harness([original], { data: null, error: null });
  h.open(original);
  let update;
  const select = evaluate(relatedSelect, {
    records: [], followupForm: h.state.form,
    setFollowupForm: (value) => { update = value; },
  });
  select.props.onChange({ target: { value: "" } });
  h.state.form = update(h.state.form);
  const saving = h.save();
  await h.reloadStarted;
  assert.equal(h.state.calls[0].payload.compliance_record_id, null);
  h.releaseReload();
  await saving;
});

test("empty compliance groups are omitted while unavailable links stay selectable", () => {
  for (const selected of ["", "99"]) {
    const html = renderToStaticMarkup(evaluate(relatedSelect, {
      records: [], followupForm: { related_item: "compliance:6", compliance_record_id: selected }, setFollowupForm() {},
    }));
    assert.doesNotMatch(html, /<optgroup/);
    assert.match(html, new RegExp(`value="${selected}" selected=""`));
  }
});

test("all Related Item categories survive save and reopening without records", async () => {
  for (const value of ["", ...[6, 7, 8, 9, 3, 5].map((id) => `compliance:${id}`), ...helpers.insuranceRelatedItems.map((item) => `insurance:${item.key}`)]) {
    const original = makeFollowup(1, "Open");
    const h = harness([original], { data: null, error: null });
    h.state.form.related_item = value;
    const saving = h.save();
    await h.reloadStarted;
    const payload = h.state.calls[0].payload;
    assert.equal(payload.compliance_record_id, null);
    assert.equal(helpers.getFollowupRelatedValue(h.state.followups[0], []), value);
    h.open(h.state.followups[0]);
    assert.equal(h.state.form.related_item, value);
    h.releaseReload();
    await saving;
  }
});

test("explicit General clears all links only on save; No specific record retains type", async () => {
  const original = makeFollowup(1, "Open", { compliance_type_id: 6, compliance_record_id: 8 });
  for (const relatedItem of ["", "compliance:6"]) {
    const h = harness([original], { data: null, error: null });
    h.open(original);
    h.state.form.related_item = relatedItem;
    h.state.form.compliance_record_id = "";
    assert.equal(h.state.followups[0].compliance_record_id, 8);
    const saving = h.save();
    await h.reloadStarted;
    assert.equal(h.state.calls[0].payload.compliance_type_id, relatedItem ? 6 : null);
    assert.equal(h.state.calls[0].payload.insurance_item_key, null);
    assert.equal(h.state.calls[0].payload.compliance_record_id, null);
    h.releaseReload();
    await saving;
  }
});

test("incompatible category changes require confirmation and cancellation preserves form", () => {
  const form = { related_item: "compliance:6", compliance_record_id: "8" };
  let changes = 0;
  let confirmations = 0;
  for (const approved of [false, true]) {
    const change = evaluate(declarations.get("changeFollowupRelatedItem"), {
      followupForm: form,
      window: { confirm(message) { assert.match(message, /clear/); confirmations++; return approved; } },
      setFollowupForm(update) { changes++; const next = update(form); assert.equal(next.related_item, "compliance:7"); assert.equal(next.compliance_record_id, ""); },
    });
    change("compliance:6");
    change("compliance:7");
  }
  assert.equal(confirmations, 2);
  assert.equal(changes, 1);
});

test("legacy and unavailable links never become General automatically", () => {
  const legacy = makeFollowup(1, "Open", { compliance_record_id: 100 });
  const record = { id: 100, compliance_type_id: 6, compliance_name: "NJ PWC", registration_number: "12345" };
  assert.equal(helpers.getFollowupRelatedValue(legacy, [record]), "compliance:6");
  assert.equal(helpers.getFollowupRelatedLabel(legacy, [record], []), "NJ PWC - 12345");
  assert.equal(helpers.getFollowupRelatedValue(legacy, []), "legacy:100");
  assert.equal(helpers.followupRelationshipPayload("legacy:100", "100").compliance_record_id, 100);
  const oldInsuranceType = { ...record, compliance_type_id: 1, compliance_name: "Insurance Certificate" };
  assert.equal(helpers.getFollowupRelatedValue(legacy, [oldInsuranceType]), "compliance:1");
});

test("insurance hides record selector, historical type fallback stays selectable, errors stay explicit", () => {
  for (const value of ["", "insurance:general_liability", "compliance:6", "legacy:99"]) {
    const html = renderToStaticMarkup(evaluate(declarations.get("followupRelatedFields"), {
      followupForm: { related_item: value, compliance_record_id: "" },
      editingFollowup: makeFollowup(1, "Open", { compliance_type_id: 6 }),
      complianceTypesLoading: false, complianceTypesError: "Denied", changeFollowupRelatedItem() {}, setFollowupForm() {},
    }));
    assert.equal(html.includes("Specific Compliance Record (Optional)"), value.startsWith("compliance:") || value.startsWith("legacy:"));
    assert.match(html, /Unable to load compliance types: Denied/);
    assert.match(html, /value="insurance:workers_compensation"/);
    assert.match(html, new RegExp(`value="${value}" selected=""`));
  }
});

test("relationship helper rejects invalid category keys and identifiers", () => {
  for (const value of ["insurance:umbrella", "compliance:0", "compliance:NaN", "random"]) {
    assert.throws(() => helpers.followupRelationshipPayload(value, ""), /Invalid/);
  }
  assert.throws(() => helpers.followupRelationshipPayload("compliance:6", "bad"), /Invalid/);
});

test("importer preserves exact related type without selecting or creating a record", async () => {
  const importSource = fs.readFileSync(path.join(root, "services", "imports.ts"), "utf8");
  const importAst = ts.createSourceFile("imports.ts", importSource, ts.ScriptTarget.Latest, true);
  const declaration = importAst.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "importFollowUps");
  assert.ok(declaration);
  const payloads = [];
  let typeError = null;
  const importer = evaluate(declaration.getText(importAst), {
    resolveContractorId: async () => 14,
    supabase: { from(table) {
      if (table === "compliance_types") return { select: async () => ({ data: [{ id: 6, compliance_name: "NJ PWC" }], error: typeError }) };
      assert.equal(table, "contractor_followups", "No automatic compliance-record lookup");
      return { insert: async (payload) => { payloads.push(payload); return { error: null }; } };
    } },
  });
  const row = { action: "Create", rowNumber: 2, identifier: "Synthetic", data: { company_name: "Synthetic", related_compliance_type: "NJ PWC", followup_date: "2026-10-08", followup_method: "Email", status: "Open", subject: "Synthetic", notes: null } };
  assert.equal((await importer([row])).created, 1);
  assert.equal(payloads[0].compliance_type_id, 6);
  assert.equal(payloads[0].compliance_record_id, null);
  assert.equal(payloads[0].insurance_item_key, null);
  assert.equal((await importer([{ ...row, data: { ...row.data, related_compliance_type: "Unknown" } }])).failed, 1);
  typeError = { message: "Type lookup denied" };
  const denied = await importer([row]);
  assert.equal(denied.failed, 1);
  assert.equal(denied.errors[0].message, "Type lookup denied");
  assert.equal(payloads.length, 1);
  assert.match(importSource, /raw\["Related Compliance Type"\]/);
});

test("successful create without representation still closes editor and reloads", async () => {
  const h = harness([makeFollowup(1, "Open")], { data: null, error: null });
  h.state.editingFollowup = null;
  const saving = h.save();
  await h.reloadStarted;
  assert.equal(h.state.modalOpen, false);
  assert.equal(h.state.error, null);
  assert.equal(h.state.followups.length, 1, "No invented ID for a new record");
  h.releaseReload();
  await saving;
});

test("update service requests affected-row count and rejects zero-row writes", async () => {
  const serviceSource = fs.readFileSync(path.join(root, "services", "followups.ts"), "utf8");
  let response;
  let requestedOptions;
  const query = {
    update(_payload, options) { requestedOptions = options; return this; },
    eq() { return this; }, select() { return this; },
    then(resolve) { return Promise.resolve(response).then(resolve); },
  };
  const code = ts.transpileModule(serviceSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const loadedModule = { exports: {} };
  vm.runInNewContext(code, { module: loadedModule, exports: loadedModule.exports, require: () => ({ supabase: { from: () => query } }) });
  const update = loadedModule.exports.updateFollowup;
  for (const data of [null, []]) {
    response = { data, error: null, count: 1 };
    const result = await update(1, { status: "Closed" });
    assert.equal(result.error, null);
    assert.equal(requestedOptions.count, "exact");
  }
  response = { data: [], error: null, count: 0 };
  assert.match((await update(1, { status: "Closed" })).error.message, /not updated/);
  response = { data: null, error: { message: "Permission denied" }, count: null };
  assert.equal((await update(1, { status: "Closed" })).error.message, "Permission denied");
});

test("new follow-ups still use create and saved date ordering", async () => {
  const existing = makeFollowup(1, "Waiting Response");
  const saved = makeFollowup(3, "Open", { followup_date: "2026-09-30" });
  const h = harness([existing], { data: [saved], error: null });
  h.state.editingFollowup = null;
  const saving = h.save();
  await h.reloadStarted;
  assert.deepEqual(Array.from(h.state.followups, (row) => row.id), [1, 3]);
  assert.equal(h.state.calls[0].payload.contractor_id, 14);
  h.releaseReload();
  await saving;
});

test("empty active section remains labelled and displays zero count", () => {
  const html = renderToStaticMarkup(evaluate(panel, { activeFollowups: [], records: [], openFollowupEdit() {} }));
  assert.match(html, /Active Follow-Ups \(0\)/);
  assert.match(html, /No active follow-ups/);
  assert.doesNotMatch(html, /<button/);
});

test("subject validation leaves the editor and original record unchanged", async () => {
  const original = makeFollowup(1, "Open");
  const h = harness([original], { data: [original], error: null });
  h.state.form.subject = "   ";
  await h.save();
  assert.equal(h.state.error, "Subject is required.");
  assert.equal(h.state.modalOpen, true);
  assert.equal(h.state.followups[0], original);
  assert.equal(h.state.calls.length, 0);
});
