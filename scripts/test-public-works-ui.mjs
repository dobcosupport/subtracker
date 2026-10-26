import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const appUrl = process.env.TEST_APP_URL;
assert(appUrl && new URL(appUrl).hostname === "localhost", "Intercepted localhost fixtures only");
const env = fs.readFileSync(".env.local", "utf8");
const origin = new URL(env.match(/^NEXT_PUBLIC_SUPABASE_URL\s*=\s*["']?([^"'\r\n]+)/m)[1].trim()).origin;
const storageKey = `sb-${new URL(origin).hostname.split(".")[0]}-auth-token`;
const user = { id: "00000000-0000-0000-0000-000000000001", email: "fixture@example.invalid", aud: "authenticated", app_metadata: {}, user_metadata: {} };
const projects = [
  { id: 1, project_number: "PW-1", project_name: "Works One", status: "Active", public_works: true },
  { id: 2, project_number: "PW-2", project_name: "Works Two", status: "Active", public_works: true },
  { id: 3, project_number: "PRIVATE", project_name: "Private Project", status: "Active", public_works: false },
  { id: 4, project_number: "LEGACY", project_name: "Unclassified Legacy", status: "Active", public_works: null },
].map(project => ({ ...project, created_at: "2026-01-01", updated_at: "2026-01-01" }));
const contractors = [1, 2, 3, 4, 5].map(id => ({
  id, company_name: `Fixture Company ${id}`, active: true, material_vendor_only: id === 4,
}));
const assignments = [[1, 1], [1, 2], [1, 3], [2, 1], [3, 1], [4, 1], [5, 4]].map(([contractor_id, project_id], id) =>
  ({ id, contractor_id, project_id, active: true, ownership_sources: ["MANUAL", "PROCORE"], assigned_date: "2026-01-01" }));
const records = [2, 3].map(id => ({
  id, contractor_id: id, compliance_type_id: 6, registration_number: `PWC-${id}`,
  expiration_date: id === 2 ? "2000-01-01" : "2099-01-01", registry_status: "OK",
  active: true, is_current: true, compliance_types: { compliance_name: "NJ PWC", requires_expiration: true },
}));
const historyBefore = JSON.stringify({ assignments, records });
const writes = [];
let deniedPwc = false;
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1366, height: 1000 } });
  const errors = [];
  await context.addInitScript(({ storageKey, user }) => localStorage.setItem(storageKey, JSON.stringify({
    access_token: "fixture-token", refresh_token: "fixture-refresh", token_type: "bearer", expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600, user,
  })), { storageKey, user });
  await context.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    if (url.origin === new URL(appUrl).origin) {
      if (url.pathname === "/api/admin/bootstrap") return route.fulfill({ json: {} });
      if (url.pathname === "/api/auth/session") return route.fulfill({ json: {
        profile: { auth_user_id: user.id, name: "Fixture", email: user.email, role: "Administrator", status: "Active", system_administrator: false },
        permissions: ["dashboard", "imports", "insurance", "projects", "contractors", "compliance", "followups"].map(module =>
          ({ module, can_view: true, can_manage: true, can_add: true, can_edit: true, can_delete: false })),
      } });
      assert(["GET", "HEAD"].includes(method), "Unexpected application write");
      return route.continue();
    }
    assert.equal(url.origin, origin, "Unexpected external request blocked");
    if (url.pathname.startsWith("/auth/")) return route.fulfill({ json: user });
    const table = url.pathname.split("/").at(-1);
    if (deniedPwc && table === "contractor_projects" && url.searchParams.get("select")?.includes("public_works")) {
      return route.fulfill({ status: 403, json: { message: "Fixture PWC read denied" } });
    }
    let rows = table === "projects" ? projects : table === "contractors" ? contractors : table === "compliance_records" ? records
      : table === "contractor_projects" ? assignments.map(assignment => ({ ...assignment,
        contractors: contractors.find(row => row.id === assignment.contractor_id),
        projects: projects.find(row => row.id === assignment.project_id),
      })) : table === "contractor_compliance_status" ? contractors.map(contractor => {
        const record = records.find(row => row.contractor_id === contractor.id);
        return { contractor_id: contractor.id, company_name: contractor.company_name, contractor_active: true,
          compliance_record_id: record?.id ?? null, compliance_name: record ? "NJ PWC" : null,
          registration_number: record?.registration_number ?? null, expiration_date: record?.expiration_date ?? null,
          calculated_status: record ? record.id === 2 ? "Expired" : "Active" : "Missing Information" };
      }) : [];
    for (const [key, value] of url.searchParams) {
      if (value.startsWith("eq.")) rows = rows.filter(row => String(row[key]) === value.slice(3));
      if (value.startsWith("neq.")) rows = rows.filter(row => String(row[key]) !== value.slice(4));
      if (value.startsWith("in.(")) rows = rows.filter(row => value.slice(4, -1).split(",").includes(String(row[key])));
    }
    if (method === "POST" || method === "PATCH") {
      assert(["projects", "activity_log"].includes(table), `Unexpected database write ${table}`);
      const body = request.postDataJSON();
      writes.push({ table, method, body });
      if (table === "projects") {
        if (method === "POST") {
          assert.equal(typeof body.public_works, "boolean");
          projects.push({ id: projects.length + 1, created_at: "2026-01-01", updated_at: "2026-01-01", ...body });
        } else {
          if ("project_name" in body || "project_number" in body) assert.equal(typeof body.public_works, "boolean");
          rows.forEach(row => Object.assign(row, body));
        }
      }
      return route.fulfill({ json: [] });
    }
    assert(["GET", "HEAD"].includes(method), "Unexpected database request");
    const total = rows.length;
    if (url.searchParams.has("offset")) rows = rows.slice(Number(url.searchParams.get("offset")), Number(url.searchParams.get("offset")) + Number(url.searchParams.get("limit")));
    if (request.headers().accept?.includes("vnd.pgrst.object")) return route.fulfill({ json: rows[0] ?? null });
    return route.fulfill({ json: rows, headers: { "content-range": `0-${Math.max(total - 1, 0)}/${total}` } });
  });
  const page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(appUrl);
  const filters = page.getByRole("region", { name: "Dashboard filters" });
  await filters.getByRole("button", { name: /PWC Missing/ }).waitFor();
  await page.getByRole("button", { name: "2 PWC Missing", exact: true }).waitFor();
  for (const width of [1920, 1200, 1280, 1366, 1440]) {
    await page.setViewportSize({ width, height: 1080 });
    const container = await filters.evaluate(node => {
      const rect = node.getBoundingClientRect();
      const css = getComputedStyle(node);
      return { x: rect.x, y: rect.y, width: rect.width, right: rect.right,
        display: css.display, columns: css.gridTemplateColumns, gap: css.columnGap };
    });
    const rects = await filters.locator(":scope > *").evaluateAll(nodes => nodes.map(node => {
      const rect = node.getBoundingClientRect();
      const label = node.lastElementChild;
      const css = getComputedStyle(node);
      return { label: label.textContent, x: rect.x, top: rect.top, right: rect.right, width: rect.width,
        minWidth: css.minWidth, padding: css.padding, labelWidth: label.scrollWidth, available: label.clientWidth };
    }));
    const documentSize = await page.evaluate(() => ({
      viewport: innerWidth, client: document.documentElement.clientWidth,
      scroll: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
    }));
    console.log(JSON.stringify({ url: appUrl, viewport: { width, height: 1080 }, container, cards: rects, documentSize }));
    assert.equal(rects.length, 8);
    assert.equal(new Set(rects.map(rect => rect.top)).size, 1, `Eight dashboard controls on one row at ${width}px: ${JSON.stringify(rects)}`);
    assert(rects[0].x >= container.x && rects.at(-1).right <= container.right + 1, "All cards contained within actual dashboard width");
    for (const rect of rects) assert(rect.labelWidth <= rect.available, `Full label fits at ${width}px: ${JSON.stringify(rect)}`);
    assert(documentSize.scroll <= documentSize.client,
      `No horizontal page scrolling at ${width}px`);
    console.log(`PASS: ${width}px — all 8 cards on one row, all labels fit, no horizontal page scrolling.`);
  }
  await page.setViewportSize({ width: 1920, height: 1080 });
  if (process.env.TEST_SCREENSHOT_PATH) await page.screenshot({ path: process.env.TEST_SCREENSHOT_PATH });
  for (const [name, count, ids] of [
    ["All Companies", 5, [1, 2, 3, 4, 5]], ["90 Day", 0, []], ["60 Day", 0, []], ["30 Day", 0, []],
    ["Expired", 1, [2]], ["Missing Information", 5, [1, 2, 3, 4, 5]],
  ]) {
    await filters.getByRole("button", { name: `${count} ${name}`, exact: true }).click();
    await page.getByText(`Showing: ${name}`, { exact: true }).waitFor();
    assert.equal(await page.locator("tbody tr").count(), ids.length, `${name} retains its company result count`);
    for (const id of ids) assert(await page.getByRole("link", { name: `Fixture Company ${id}`, exact: true }).isVisible());
  }
  assert.equal(await filters.getByRole("link", { name: /Material Vendor Only/ }).getAttribute("href"), "/contractors?type=vendors");
  await filters.getByRole("button", { name: /PWC Missing/ }).click();
  const company = page.getByRole("row").filter({ has: page.getByRole("link", { name: "Fixture Company 1", exact: true }) });
  assert.match(await company.innerText(), /Missing/);
  assert.match(await company.innerText(), /PW-1.*Works One/s);
  assert.match(await company.innerText(), /PW-2.*Works Two/s);
  assert.doesNotMatch(await company.innerText(), /PRIVATE/);
  const expired = page.getByRole("row").filter({ has: page.getByRole("link", { name: "Fixture Company 2", exact: true }) });
  assert.match(await expired.innerText(), /Expired.*01\/01\/2000/s);
  for (const id of [3, 4, 5]) assert.equal(await page.getByRole("link", { name: `Fixture Company ${id}`, exact: true }).count(), 0);
  await page.getByPlaceholder("Search contractors").fill("Works Two");
  assert.equal(await page.locator("tbody tr").count(), 1);
  assert.match(await company.innerText(), /PW-1.*PW-2/s, "Search never hides other affected projects");
  await page.setViewportSize({ width: 768, height: 1000 });
  assert(new Set((await filters.locator(":scope > *").evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().top)))).size > 1, "Narrow responsive grid retained");
  await page.setViewportSize({ width: 1366, height: 1000 });
  await page.goto(`${appUrl}/projects`);
  await page.getByRole("button", { name: "Add Project", exact: true }).click();
  await page.getByLabel("Project Number").fill("NEW-YES");
  await page.getByLabel("Project Name").fill("New Yes");
  assert.equal(await page.getByRole("radio", { checked: true }).count(), 0, "No default choice");
  let before = writes.length;
  await page.getByRole("button", { name: "Save Project", exact: true }).click();
  await page.getByText("Select whether this is a Public Works project.", { exact: true }).waitFor();
  assert.equal(writes.length, before);
  await page.getByRole("radio", { name: "Yes", exact: true }).check();
  await page.getByRole("button", { name: "Save Project", exact: true }).click();
  await page.getByText("Project added successfully.", { exact: true }).waitFor();
  assert.equal(projects.at(-1).public_works, true);
  await page.getByRole("button", { name: "Add Project", exact: true }).click();
  await page.getByLabel("Project Number").fill("NEW-NO");
  await page.getByLabel("Project Name").fill("New No");
  assert.equal(await page.getByRole("radio", { checked: true }).count(), 0);
  await page.getByRole("radio", { name: "No", exact: true }).check();
  await page.getByRole("button", { name: "Save Project", exact: true }).click();
  await page.getByText("Project added successfully.", { exact: true }).waitFor();
  assert.equal(projects.at(-1).public_works, false);
  const legacyRow = page.getByRole("row").filter({ hasText: "Unclassified Legacy" });
  await legacyRow.getByRole("button", { name: "Deactivate", exact: true }).click();
  await page.getByRole("heading", { name: "Deactivate Project?" }).waitFor();
  await page.getByRole("button", { name: "Deactivate", exact: true }).last().click();
  await page.getByRole("heading", { name: "Deactivate Project?" }).waitFor({ state: "hidden" });
  assert.equal(projects[3].public_works, null);
  await page.getByRole("button", { name: /Inactive Projects/ }).click();
  await legacyRow.getByRole("button", { name: "Reactivate", exact: true }).click();
  await page.getByRole("button", { name: "Reactivate", exact: true }).last().click();
  await page.getByRole("heading", { name: "Reactivate Project?" }).waitFor({ state: "hidden" });
  assert.equal(projects[3].public_works, null);
  await page.getByRole("button", { name: /Active Projects/ }).click();
  await legacyRow.getByRole("button", { name: "Edit", exact: true }).click();
  assert.equal(await page.getByRole("radio", { checked: true }).count(), 0);
  before = writes.length;
  await page.getByRole("button", { name: "Save Changes", exact: true }).click();
  await page.getByText("Select whether this is a Public Works project.", { exact: true }).waitFor();
  assert.equal(writes.length, before);
  await page.getByRole("radio", { name: "No", exact: true }).check();
  await page.getByRole("button", { name: "Save Changes", exact: true }).click();
  await page.getByText("Project updated successfully.", { exact: true }).waitFor();
  assert.equal(projects[3].public_works, false);
  await legacyRow.getByRole("button", { name: "Edit", exact: true }).click();
  assert(await page.getByRole("radio", { name: "No", exact: true }).isChecked(), "Saved No restored");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  const worksRow = page.getByRole("row").filter({ hasText: "Works One" });
  await worksRow.getByRole("button", { name: "Edit", exact: true }).click();
  assert(await page.getByRole("radio", { name: "Yes", exact: true }).isChecked(), "Saved Yes restored");
  await page.getByRole("radio", { name: "No", exact: true }).check();
  await page.getByRole("button", { name: "Save Changes", exact: true }).click();
  await page.getByText("Project updated successfully.", { exact: true }).waitFor();
  await page.goto(appUrl);
  await page.getByRole("button", { name: "1 PWC Missing", exact: true }).waitFor();
  await page.getByRole("button", { name: /PWC Missing/ }).click();
  assert.equal(await page.getByRole("link", { name: /PW-1 — Works One/ }).count(), 0);
  assert.equal(await page.getByRole("link", { name: /PW-2 — Works Two/ }).count(), 1);
  assert.equal(JSON.stringify({ assignments, records }), historyBefore);
  deniedPwc = true;
  await page.reload();
  await page.getByRole("button", { name: "! PWC Missing", exact: true }).waitFor();
  await page.getByRole("button", { name: /PWC Missing/ }).click();
  await page.getByRole("alert").filter({ hasText: "Fixture PWC read denied" }).waitFor();
  await page.getByRole("button", { name: /All Companies/ }).click();
  assert(await page.getByText("Showing: All Companies", { exact: true }).isVisible());
  assert.equal(errors.length, 0, errors.join("\n"));
  console.log("PASS: eight readable desktop dashboard buttons on one row; responsive grid; all existing filters/material link retained; grouped PWC count/projects/status/expiration/search; explicit read errors isolated; new Yes/No with no default; legacy edit required; saved value restored; Deactivate/Reactivate preserve NULL; Yes-to-No refreshes deficiencies without history/ownership writes; localhost network fully intercepted.");
} finally { await browser.close(); }
