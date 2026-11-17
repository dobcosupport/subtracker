import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
import { renderToStaticMarkup } from "react-dom/server";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "../worker/nj-pwc/node_modules/playwright");
const source = fs.readFileSync(new URL("../src/components/contractors/ContractorProjectAssignments.tsx", import.meta.url), "utf8");
const css = fs.readFileSync(new URL("../src/components/contractors/ContractorProjectAssignments.module.css", import.meta.url), "utf8");
const classes = new Proxy({}, { get: (_, key) => `assignment-${key}` });
let state = [], hook = 0, refs = [], refHook = 0;
const loaded = { exports: {} };
new Function("require", "module", "exports", ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText)((name) => {
  if (name.endsWith(".module.css")) return { __esModule: true, default: classes };
  if (name === "react-dom") return { createPortal: (element) => element };
  if (name === "react") return {
    useEffect() {},
    useRef(initial) { return refs[refHook++] ??= { current: initial }; },
    useState(initial) {
      const index = hook++;
      if (!(index in state)) state[index] = typeof initial === "function" ? initial() : initial;
      return [state[index], value => { state[index] = typeof value === "function" ? value(state[index]) : value; }];
    },
  };
  return require(name);
}, loaded, loaded.exports);
const numbers = ["23-10B", "23-008", "21-004", "23-2B", "20-005", "23-007", "23-10A", "23-2A",
  "24-101", "24-015", "25-001", "22-001", "17-003", ...Array.from({ length: 16 }, (_, index) => `26-${String(index + 1).padStart(3, "0")}`)];
const projects = Object.freeze(numbers.map((project_number, index) => Object.freeze({
  id: index + 1, project_number, project_name: `Synthetic project ${project_number}`, status: "Active",
})));
const combinations = [["MANUAL"], ["MYCOI"], ["PROCORE"], ["MYCOI", "MANUAL"], ["PROCORE", "MANUAL"], ["PROCORE", "MYCOI"], ["PROCORE", "MYCOI", "MANUAL"]];
const assignments = Object.freeze(combinations.map((sources, index) => Object.freeze({
  id: index + 1, project_id: index + 1, active: true, projects: projects[index],
  manual_owned: sources.includes("MANUAL"), ownership_sources: Object.freeze(sources),
})));
const before = JSON.stringify({ projects, assignments });
const toggles = [];
const props = { contractorName: "Isolated fixture", projects, assignments, onToggle: async (project) => { toggles.push(project); } };
const render = () => { hook = 0; refHook = 0; return loaded.exports.default(props); };
const elements = (node, type) => Array.isArray(node) ? node.flatMap(item => elements(item, type))
  : node?.props ? [...(node.type === type ? [node] : []), ...elements(node.props.children, type)] : [];
const text = node => Array.isArray(node) ? node.map(text).join("") : node?.props ? text(node.props.children) : String(node ?? "");
const previousDocument = globalThis.document, previousWindow = globalThis.window;
globalThis.document = { body: {} };
const confirmations = [];
globalThis.window = { confirm(message) { confirmations.push(message); return false; } };
let markup;
try {
  let tree = render();
  assert.equal(elements(tree, "input").filter(input => input.props.type === "checkbox").length, 0, "Normal workspace is read-only");
  assert.match(text(tree), /7 Active Projects/);
  elements(tree, "button").find(button => text(button) === "Manage Project Assignments").props.onClick();
  tree = render();
  const modal = elements(tree, "dialog")[0];
  assert.match(text(modal), /Each checkbox change is saved immediately/);
  assert.deepEqual(elements(modal, "button").slice(-1).map(text), ["Close"]);
  const labels = elements(modal, "input").filter(input => input.props.type === "checkbox");
  assert.deepEqual(labels.map(input => input.props["aria-label"].slice(7)), [...numbers].sort((a, b) => a.localeCompare(b, "en", { numeric: true, sensitivity: "base" })));
  const lastManual = labels.find(input => input.props["aria-label"] === `MANUAL ${projects[0].project_number}`);
  lastManual.props.onChange();
  assert.equal(toggles.length, 0, "Cancel last-source confirmation makes no mutation");
  globalThis.window.confirm = message => { confirmations.push(message); return true; };
  for (const project of projects) {
    const input = elements(render(), "input").find(item => item.props["aria-label"] === `MANUAL ${project.project_number}`);
    assert.equal(input.props.checked, assignments.find(row => row.project_id === project.id)?.manual_owned ?? false);
    input.props.onChange();
    assert.equal(toggles.at(-1), project, "Original project is passed to the existing mutation handler");
    const saving = elements(render(), "input").filter(item => item.props.disabled);
    assert.deepEqual(saving.map(item => item.props["aria-label"]), [`MANUAL ${project.project_number}`], "Only saving row is disabled");
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(confirmations.length, 2, "Only Manual-only removals request confirmation");
  for (let index = 0; index < combinations.length; index++) {
    const row = elements(render(), "tr").find(item => text(item).includes(projects[index].project_number));
    const sources = renderToStaticMarkup(elements(row, "td")[2]);
    assert.equal(sources.includes("Manual"), false, "Manual is independently represented by its checkbox");
    assert.equal(sources.includes("Procore"), combinations[index].includes("PROCORE"));
    assert.equal(sources.includes("myCOI"), combinations[index].includes("MYCOI"));
  }
  assert.equal(loaded.exports.projectOwnership({ ownership_sources: ["MYCOI", "MANUAL"] }), "BOTH");
  assert.equal(loaded.exports.projectOwnership({ ownership_sources: ["PROCORE", "MYCOI", "MANUAL"] }), "MANUAL + MYCOI + PROCORE");
  assert.equal(JSON.stringify({ projects, assignments }), before, "Frozen inputs and ownership remain unchanged");
  elements(render(), "button").find(button => text(button) === "Close").props.onClick();
  markup = renderToStaticMarkup(render());
} finally {
  if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument;
  if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
}
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.route("**/*", route => route.abort());
  const componentCss = css.replace(/\.([a-zA-Z][\w-]*)/g, ".assignment-$1");
  for (const width of [1536, 1024, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.setContent(`<style>body{margin:0;padding:16px;box-sizing:border-box}*{box-sizing:border-box}${componentCss}</style>${markup}`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `No horizontal page overflow at ${width}px`);
    assert.equal(await page.locator(".assignment-assignmentRow").count(), 7);
    for (const badge of await page.locator(".assignment-source").all()) {
      const bounds = await badge.boundingBox();
      assert.ok(bounds.width > 0 && bounds.width < width);
    }
  }
  console.log("PASS: natural project ordering, read-only normal view, all seven source combinations, Manual-only confirmation/cancel, original immediate handlers, per-row saving, imported-source labels, immutable inputs/history and responsive 320–1536px rows; isolated with no network/database access.");
} finally { await browser.close(); }
