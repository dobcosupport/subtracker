import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { renderToStaticMarkup } from "react-dom/server";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const componentPath = path.join(root, "src", "components", "contractors", "ContractorProjectAssignments.tsx");
const cssPath = componentPath.replace(".tsx", ".module.css");
const compiled = ts.transpileModule(fs.readFileSync(componentPath, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
}).outputText;
const componentModule = { exports: {} };
new Function("require", "module", "exports", compiled)((specifier) =>
  specifier.endsWith(".module.css") ? { container: "assignment-container", projects: "assignment-projects" } : require(specifier),
componentModule, componentModule.exports);
const Component = componentModule.exports.default;
const numbers = ["23-10B", "23-008", "21-004", "23-2B", "20-005", "23-007", "23-10A", "23-2A",
  "24-101", "24-015", "25-001", "22-001", "17-003", ...Array.from({ length: 16 }, (_, index) => `26-${String(index + 1).padStart(3, "0")}`)];
const projects = Object.freeze(numbers.map((project_number, index) => Object.freeze({
  id: index + 1, project_number, project_name: `Synthetic project ${project_number}`, status: "Active",
})));
const sources = [["MANUAL"], ["MYCOI"], ["PROCORE"], ["MYCOI", "MANUAL"], ["PROCORE", "MANUAL"],
  ["PROCORE", "MYCOI"], ["PROCORE", "MYCOI", "MANUAL"]];
const badges = ["MAN", "COI", "PRO", "MAN / COI", "MAN / PRO", "COI / PRO", "MAN / COI / PRO"];
const assignments = Object.freeze(projects.slice(0, sources.length).map((project, index) => Object.freeze({
  project_id: project.id, manual_owned: sources[index].includes("MANUAL"),
  ownership_sources: Object.freeze(sources[index]),
})));
const before = JSON.stringify({ projects, assignments });
const toggles = [];
const props = { projects, assignments, busyId: projects[0].id, onToggle: async (project) => { toggles.push(project); } };
const element = Component(props);
const labels = element.props.children[2].props.children;
assert.deepEqual(labels.map((label) => label.props.children[1]), [
  "17-003", "20-005", "21-004", "22-001", "23-2A", "23-2B", "23-007", "23-008", "23-10A", "23-10B",
  "24-015", "24-101", "25-001", ...Array.from({ length: 16 }, (_, index) => `26-${String(index + 1).padStart(3, "0")}`),
]);
for (const label of labels) {
  const checkbox = label.props.children[0];
  const project = projects.find((item) => checkbox.props["aria-label"] === `MANUAL ${item.project_number}`);
  assert.equal(checkbox.props.checked, assignments.find((item) => item.project_id === project.id)?.manual_owned ?? false);
  assert.equal(checkbox.props.disabled, project.id === props.busyId);
  const assignmentIndex = assignments.findIndex((item) => item.project_id === project.id);
  const badge = label.props.children[2];
  if (assignmentIndex === -1) {
    assert.equal(badge, null, "Unassigned projects never acquire a display source");
  } else {
    assert.equal(badge.props.children, badges[assignmentIndex], "Badge derives from actual source values in canonical order");
    assert.equal(badge.props.title, `Ownership: ${sources[assignmentIndex].join(" + ")}`, "Full source values remain accessible");
  }
  await checkbox.props.onChange();
  assert.equal(toggles.at(-1), project, "Existing handler receives the original project object");
}
assert.equal(JSON.stringify({ projects, assignments }), before, "Rendering/sorting must not mutate input records");
const markup = renderToStaticMarkup(element);
for (const label of badges) {
  assert.ok(markup.includes(`>${label}</span>`), `Compact ownership combination: ${label}`);
}
assert.equal(componentModule.exports.projectOwnership({ ownership_sources: ["MYCOI", "MANUAL"] }), "BOTH", "Project History formatting is unchanged");
assert.equal(componentModule.exports.projectOwnership({ ownership_sources: ["PROCORE", "MYCOI", "MANUAL"] }), "MANUAL + MYCOI + PROCORE");
const cssFiles = fs.readdirSync(path.join(root, ".next", "static"), { recursive: true })
  .filter((file) => file.endsWith(".css"));
assert.ok(cssFiles.length, "Run the production build before the layout test");
const appCss = cssFiles.map((file) => fs.readFileSync(path.join(root, ".next", "static", file), "utf8")).join("\n");
const componentCss = fs.readFileSync(cssPath, "utf8").replaceAll(".container", ".assignment-container")
  .replaceAll(".projects", ".assignment-projects");
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.route("**/*", (route) => route.abort());
  for (const [width, expected] of [[560, 5], [700, 6], [450, 4], [330, 3], [240, 2], [180, 1]]) {
    await page.setViewportSize({ width: width + 32, height: 800 });
    await page.setContent(`<style>${appCss}\n${componentCss}\nbody{margin:0;padding:16px}</style>${markup}`);
    const metrics = await page.locator(".assignment-projects").evaluate((grid) => ({
      columns: getComputedStyle(grid).gridTemplateColumns.split(" ").length,
      overflow: document.documentElement.scrollWidth > innerWidth,
      height: grid.getBoundingClientRect().height,
    }));
    assert.equal(metrics.columns, expected, `Project columns at ${width}px available width`);
    assert.equal(metrics.overflow, false, `No horizontal page scroll at ${width}px`);
    assert.ok(metrics.height <= 160, "Project list retains its compact height limit");
    const badgeMetrics = await page.locator(".assignment-projects label span").evaluateAll((spans) => spans.map((span) => ({
      width: span.getBoundingClientRect().width,
      cellWidth: span.parentElement.getBoundingClientRect().width,
      wraps: span.getBoundingClientRect().height > 20,
    })));
    for (const badge of badgeMetrics) {
      assert.ok(badge.width <= badge.cellWidth, "Source badges never widen project columns");
      assert.equal(badge.wraps, false, "Compact source labels remain on one line");
    }
    const displayed = await page.locator("input").evaluateAll((inputs) => inputs.map((input) => input.getAttribute("aria-label")));
    assert.deepEqual(displayed, labels.map((label) => label.props.children[0].props["aria-label"]));
  }
  await page.setViewportSize({ width: 732, height: 800 });
  await page.setContent(`<style>${appCss}\n${componentCss}</style>${renderToStaticMarkup(Component({ ...props, projects: projects.slice(0, 2) }))}`);
  assert.ok((await page.locator(".assignment-projects").boundingBox()).height <= 64, "Few projects remain compact");
  console.log("PASS: 29-project natural numeric/text ordering; 5/6 desktop columns; 1-4 narrower columns; no horizontal scrolling; compact few-project layout; all seven source badges fit; full ownership titles and history preserved; checked/busy state and original handlers preserved; frozen input data unchanged; no network or database access");
} finally {
  await browser.close();
}
