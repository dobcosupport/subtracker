import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const require = createRequire(import.meta.url);
const source = fs.readFileSync(new URL("../src/app/contractors/[id]/page.tsx", import.meta.url), "utf8");
const start = source.indexOf('<section id="compliance"');
assert.ok(start >= 0);
const end = source.indexOf("</section>", start) + "</section>".length;
const panel = source.slice(start, end);
const keys = [
  "njPwcSearching", "njPwcRequestId", "njPwcAdditionalRequestIds", "njPwcCandidates",
  "njPwcMessage", "njPwcNoMatch", "njPwcTrackingError", "activeRecords", "syncedRecords",
  "saving", "handleNjPwcSearch", "handleNjPwcStartNew", "setNjPwcResultsOpen",
  "openComplianceCreate", "openComplianceEdit", "archiveCompliance",
];
const compiled = ts.transpileModule(`export function render(state) {
  const { ${keys.join(",")} } = state;
  return (${panel});
}`, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const loaded = { exports: {} };
vm.runInNewContext(compiled, {
  module: loaded, exports: loaded.exports, require,
  styles: new Proxy({}, { get: (_, key) => key }),
  statusStyles: { Active: "active", "90 Day": "expiring" },
  Style3Icon: () => React.createElement("svg", { "aria-hidden": true }),
});
const calls = [];
const state = {
  njPwcSearching: false, njPwcRequestId: null, njPwcAdditionalRequestIds: [],
  njPwcCandidates: [], njPwcMessage: null, njPwcNoMatch: false, njPwcTrackingError: null,
  activeRecords: [], syncedRecords: [], saving: false,
  ...Object.fromEntries(keys.filter(key => /^(handle|set|open|archive)/.test(key))
    .map(key => [key, (...args) => calls.push([key, ...args])])),
};
function elements(tree, type) {
  if (!React.isValidElement(tree)) return [];
  return [
    ...(tree.type === type ? [tree] : []),
    ...React.Children.toArray(tree.props.children).flatMap(child => elements(child, type)),
  ];
}
const text = element => renderToStaticMarkup(element).replace(/<[^>]*>/g, "").trim().replace(/\u203a$/, "").trim();
const button = (tree, name) => {
  const matches = elements(tree, "button").filter(element => text(element) === name);
  assert.equal(matches.length, 1, `Exactly one ${name} action`);
  return matches[0];
};
const render = overrides => loaded.exports.render({ ...state, ...overrides });
const initial = render();
assert.equal(elements(initial, "details").length, 1);
assert.equal(elements(elements(initial, "details")[0], "button").length, 0,
  "Search controls never require the external-reference disclosure");
assert.equal(button(initial, "Search NJ PWC").props.disabled, false);
button(initial, "Search NJ PWC").props.onClick();
button(initial, "+ Add Compliance Record").props.onClick();
assert.deepEqual(calls.splice(0), [["handleNjPwcSearch"], ["openComplianceCreate"]]);
assert.equal(button(render({ njPwcSearching: true }), "Searching NJ PWC...").props.disabled, true);

for (const requests of [{ njPwcRequestId: 31 }, { njPwcAdditionalRequestIds: [32] }]) {
  const pending = render({ ...requests, njPwcMessage: "NJ PWC search queued." });
  assert.equal(button(pending, "Search NJ PWC").props.disabled, true);
  button(pending, "Check NJ PWC Search Status").props.onClick();
  button(pending, "Start New NJ PWC Search").props.onClick();
  assert.deepEqual(calls.splice(0), [["handleNjPwcSearch"], ["handleNjPwcStartNew"]]);
  assert.match(renderToStaticMarkup(pending), /role="status"[^>]*>NJ PWC search queued/);
}
const match = render({ njPwcRequestId: 31, njPwcCandidates: [{ business_name: "Registry Match" }] });
button(match, "View NJ PWC Search Results").props.onClick();
assert.deepEqual(calls.splice(0), [["setNjPwcResultsOpen", true]]);
const noMatch = render({ njPwcRequestId: 31, njPwcNoMatch: true });
assert.match(renderToStaticMarkup(noMatch), /role="status"[^>]*>No NJ PWC match was found/);
assert.equal(elements(elements(noMatch, "details")[0], "p").some(element => text(element).includes("No NJ PWC match")), false);
assert.match(renderToStaticMarkup(render({ njPwcTrackingError: "Import failed" })), /role="alert"[^>]*>Import failed/);

const populated = render({ activeRecords: [
  { id: 1, compliance_name: "NJ PWC", registration_number: "668354", effective_date: "2025-02-13", expiration_date: "2027-02-12", calculated_status: "90 Day" },
  { id: 2, compliance_name: "NJ BRC", registration_number: "1556183", effective_date: "2010-04-15", expiration_date: null, calculated_status: "Active" },
] });
assert.equal(button(populated, "Search NJ PWC").props.disabled, false, "Existing/manual records do not hide lookup");
assert.match(renderToStaticMarkup(populated), /1556183/);
assert.match(renderToStaticMarkup(populated), /Non-expiring/);
assert.doesNotMatch(panel, /Search NJ BRC|NJ BRC Website Error|Start New NJ BRC|Check NJ BRC/);
console.log("PASS: primary NJ PWC and manual actions, pending/status/restart/results, match/no-match feedback, manual PWC/BRC preservation, and no BRC automation.");

const parsed = ts.createSourceFile("page.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const detail = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "ContractorDetailPage");
const hookNames = [];
function collectHooks(node) {
  if (ts.isVariableDeclaration(node) && ts.isArrayBindingPattern(node.name)
    && node.initializer && ts.isCallExpression(node.initializer) && node.initializer.expression.getText(parsed) === "useState") {
    hookNames.push(node.name.elements[0].getText(parsed));
  }
  ts.forEachChild(node, collectHooks);
}
collectHooks(detail);
let hookIndex = 0;
let effects = [];
let values = new Map();
let scenario = "match";
const requests = [];
const timers = [];
const fakeReact = {
  useState(initial) {
    const name = hookNames[hookIndex++];
    if (!values.has(name)) values.set(name, typeof initial === "function" ? initial() : initial);
    return [values.get(name), value => values.set(name, typeof value === "function" ? value(values.get(name)) : value)];
  },
  useMemo: fn => fn(), useCallback: fn => fn, useEffect: fn => effects.push(fn),
};
const component = { exports: {} };
vm.runInNewContext(ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020 },
}).outputText, {
  module: component, exports: component.exports,
  URL,
  window: { setTimeout: fn => timers.push(fn), confirm: () => true,
    location: { href: "http://localhost:3000/contractors/8" }, history: { pushState() {} }, scrollTo() {} },
  require(name) {
    if (name === "react") return fakeReact;
    if (name === "react/jsx-runtime") return require(name);
    if (name === "next/navigation") return { useParams: () => ({ id: "8" }) };
    if (name.endsWith(".module.css")) return { __esModule: true, default: new Proxy({}, { get: (_, key) => key }) };
    if (name === "@/lib/admin-client") return { adminFetch: async (url, options) => {
      requests.push({ url, method: options?.method ?? "GET" });
      assert.equal(options?.method ?? "GET", "GET", "Reusing an existing request creates no new search");
      return { ok: true, json: async () => url.includes("/latest?")
        ? { found: true, search_request_id: 31 }
        : { status: scenario === "pending" ? "pending" : scenario === "no_match" ? "no_match" : "completed",
          candidates: scenario === "match" ? [{ business_name: "Synthetic Match" }] : [] } };
    } };
    if (name === "@/lib/worker-health-client") return { checkNjPwcWorker: async () => null };
    if (name === "@/lib/nj-pwc-contractor-search") return {
      getNjPwcSearchNames: legal => [legal],
      attachNjPwcSearchProvenance: results => results.flatMap(result => result.candidates),
    };
    if (name === "@/services/followups") return { followupStatuses: ["Open", "Waiting Response", "Resolved", "Closed"], followupMethods: [] };
    if (name === "@/lib/followup-related-item") return { insuranceRelatedItems: [] };
    return { __esModule: true, default: () => null };
  },
});
const renderPage = () => {
  hookIndex = 0;
  effects = [];
  return component.exports.default();
};
for (const mode of ["match", "no_match", "pending"]) {
  scenario = mode;
  values = new Map([
    ["contractor", { id: 8, company_name: "Synthetic Contractor", active: true }],
    ["loading", false], ["complianceTypesLoading", false],
  ]);
  requests.length = 0;
  timers.length = 0;
  const tree = renderPage();
  assert.equal(elements(tree, "section").some(element => element.props["aria-label"] === "Operational overview"), false,
    "Overview omits the redundant operational panel");
  assert.equal(elements(tree, "button").filter(element => text(element) === "+ Add Compliance Record").length, 1,
    "Manual compliance entry appears only once on the Contractor Card");
  const rail = elements(tree, "aside")[0];
  assert.ok(rail);
  const sectionNav = elements(tree, "nav").find(element => element.props["aria-label"] === "Contractor detail sections");
  assert.deepEqual(elements(sectionNav, "button").map(element => element.props.children),
    ["Overview", "Insurance (myCOI)", "Projects", "Follow-Ups", "Company History"]);
  const overview = elements(tree, "div").find(element => element.props.id === "view-overview");
  assert.deepEqual(elements(overview, "section").map(element => element.props.id), ["overview", "compliance"],
    "Overview contains Company Information followed by the complete Compliance panel");
  const complianceLinks = elements(tree, "a").filter(element => element.props.href === "?view=overview#compliance");
  assert.equal(complianceLinks.length, 3);
  for (const link of complianceLinks) {
    link.props.onClick({ preventDefault() {} });
    assert.equal(values.get("activeSection"), "overview");
  }
  for (const tab of elements(sectionNav, "button")) {
    tab.props.onClick();
    const workspace = renderPage();
    const tabs = elements(workspace, "button").filter(element => element.props.role === "tab");
    assert.deepEqual(tabs.filter(element => element.props["aria-selected"]).map(element => element.props.id), [tab.props.id]);
    assert.deepEqual(tabs.filter(element => element.props.className.includes("sectionTabActive")).map(element => element.props.id), [tab.props.id],
      "Selected styling follows only the active workspace");
    const panels = elements(workspace, "div").filter(element => element.props.role === "tabpanel");
    assert.equal(panels.length, 5);
    assert.deepEqual(panels.filter(element => !element.props.hidden).map(element => element.props["aria-labelledby"]), [tab.props.id]);
  }
  button(sectionNav, "Overview").props.onClick();
  assert.equal(elements(rail, "a").length, 0, "Quick Links expand locally rather than navigate to center anchors");
  assert.equal(elements(tree, "section").some(element => ["contacts", "tiered-subs"].includes(element.props.id)), false,
    "No duplicate center Contacts or Tiered Subs interface");
  assert.equal(source.match(/<ContractorContactsSection\b/g).length, 1);
  assert.equal(source.match(/<TieredSubRelationshipsPanel\b/g).length, 1);
  button(rail, "Manage Tiered Subs").props.onClick();
  assert.equal(values.get("tieredSubsOpenForContractorId"), 8);
  assert.equal(values.get("activeSection"), "overview");
  const expandedRail = elements(renderPage(), "aside")[0];
  assert.equal(elements(expandedRail, "div").find(element => element.props.id === "rail-tiered-sub-management").props.hidden, false);
  button(expandedRail, "Manage Tiered Subs").props.onClick();
  assert.equal(values.get("tieredSubsOpenForContractorId"), null);
  assert.equal(values.get("activeSection"), "overview");
  const followupDisclosure = elements(rail, "details").find(element =>
    elements(element, "summary").some(summary => text(summary).includes("Active Follow-Ups")));
  assert.ok(followupDisclosure, "Active follow-ups expand in the rail");
  assert.equal(elements(rail, "button").some(element => text(element).includes("Add Compliance Record")), false,
    "Contractor Actions must not duplicate compliance entry");
  button(rail, "+ Add Follow-Up");
  button(rail, "Edit Contractor");
  button(rail, "Deactivate Contractor");
  button(tree, "Search NJ PWC").props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  renderPage();
  const poll = effects.find(effect => effect.toString().includes("const requestIds"));
  assert.ok(poll, "Existing authoritative polling effect is exercised");
  poll();
  await new Promise(resolve => setImmediate(resolve));
  const updated = renderPage();
  assert.equal(values.get("njPwcRequestId"), 31);
  assert.equal(requests.filter(request => request.url.endsWith("/31")).length, 1);
  if (mode === "match") {
    assert.equal(values.get("njPwcResultsOpen"), true);
    assert.equal(values.get("njPwcCandidates")[0].business_name, "Synthetic Match");
    values.set("njPwcResultsOpen", false);
    button(renderPage(), "View NJ PWC Search Results").props.onClick();
    assert.equal(values.get("njPwcResultsOpen"), true);
  } else if (mode === "no_match") {
    assert.equal(values.get("njPwcNoMatch"), true);
    assert.equal(values.get("njPwcSearching"), false);
    button(updated, "Start New NJ PWC Search");
  } else {
    assert.equal(values.get("njPwcSearching"), true);
    assert.equal(button(updated, "Searching NJ PWC...").props.disabled, true);
    assert.equal(timers.length, 1);
    for (let attempt = 1; attempt < 60; attempt++) {
      timers.shift()();
      await new Promise(resolve => setImmediate(resolve));
    }
    const timedOut = renderPage();
    assert.equal(values.get("njPwcSearching"), false);
    assert.match(values.get("njPwcMessage"), /still pending/);
    assert.equal(button(timedOut, "Check NJ PWC Search Status").props.disabled, false);
    assert.equal(button(timedOut, "Start New NJ PWC Search").props.disabled, false);
  }
}
console.log("PASS: unchanged search handlers reuse existing requests and process matches, no matches, pending polls, and timeout/status recovery with mocked read-only responses.");
console.log("PASS: rail-only Contacts/Tiered Subs, local management expansion, five center tabs, Overview Compliance panel/KPI links, active Follow-Up disclosure, and no duplicate compliance action.");
