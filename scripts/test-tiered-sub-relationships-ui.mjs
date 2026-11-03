import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const appUrl = process.env.TEST_APP_URL;
assert.equal(new URL(appUrl).hostname, "localhost");
const env = fs.readFileSync(".env.local", "utf8");
const origin = new URL(env.match(/^NEXT_PUBLIC_SUPABASE_URL\s*=\s*["']?([^"'\r\n]+)/m)[1].trim()).origin;
const storageKey = `sb-${new URL(origin).hostname.split(".")[0]}-auth-token`;
const user = { id: "00000000-0000-0000-0000-000000000001", email: "synthetic@example.invalid", aud: "authenticated", app_metadata: {}, user_metadata: {} };
const company = (id, company_name) => ({ id, company_name, active: true, email: null, merged_into_contractor_id: null });
const companies = [
  company(227, "Mechanical Associates of New Jersey"), company(717, "Radius Systems, LLC"),
  company(900, "Synthetic Radius Tiered Sub"),
  ...Array.from({ length: 9 }, (_, i) => company(1000 + i, `Synthetic Tiered Sub ${i + 1}`)),
];
const relationship = (id, parent, child) => ({
  id, contractor_id: parent, tiered_sub_contractor_id: child, active: true, assigned_date: "2026-10-29",
  contractor: { company_name: companies.find((c) => c.id === parent).company_name },
  tiered_sub_contractor: { company_name: companies.find((c) => c.id === child).company_name },
});
// Relationship 55 and shared project 38 reproduce the read-only Mechanical/Radius example.
const relationships = [relationship(55, 227, 717), ...Array.from({ length: 9 }, (_, i) => relationship(100 + i, 227, 1000 + i))];
const project = { id: 38, project_number: "21-002", project_name: "Rowan University Fossil Park", status: "Active" };
const assignments = [227, 717, 900].map((id) => ({
  id, contractor_id: id, project_id: 38, active: true, manual_owned: true, mycoi_owned: false, ownership_sources: ["MANUAL"], assigned_date: "2026-10-29", projects: project,
}));
const writes = [];
const unexpectedRequests = [];
const filter = (rows, url) => rows.filter((row) => [...url.searchParams].every(([key, value]) =>
  value.startsWith("eq.") ? String(row[key]) === value.slice(3)
    : value.startsWith("neq.") ? String(row[key]) !== value.slice(4)
      : value.startsWith("in.(") ? value.slice(4, -1).split(",").includes(String(row[key]))
        : true));

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(({ storageKey, user }) => localStorage.setItem(storageKey, JSON.stringify({
    access_token: "synthetic-token", refresh_token: "synthetic-refresh", token_type: "bearer",
    expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user,
  })), { storageKey, user });
  await context.route("**/*", async (route) => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin === new URL(appUrl).origin) {
      if (url.pathname.startsWith("/api/")) return route.fulfill({ json: {
        profile: { auth_user_id: user.id, name: "Offline UI Test", email: user.email, role: "Administrator", status: "Active", system_administrator: true },
        permissions: ["contractors", "compliance", "insurance", "projects", "followups", "imports", "compliance_sync"].map((module) => ({
          module, can_view: true, can_manage: true, can_add: true, can_edit: true, can_delete: true,
        })), data: [], contacts: [],
      } });
      return route.continue();
    }
    if (url.origin !== origin) {
      unexpectedRequests.push(request.url());
      return route.abort();
    }
    if (url.pathname.startsWith("/auth/")) return route.fulfill({ json: user });
    if (!["GET", "HEAD"].includes(request.method())) {
      writes.push(request.url());
      return route.abort();
    }
    const table = url.pathname.split("/").at(-1);
    let data = [];
    if (table === "contractors") {
      data = filter(companies, url);
      if (url.searchParams.get("id")?.startsWith("eq.")) return route.fulfill({ json: data[0] ?? null });
    }
    if (table === "contractor_tiered_subs") data = filter(relationships, url);
    if (table === "contractor_projects") data = filter(assignments, url);
    if (table === "projects") data = [project];
    return route.fulfill({ json: data });
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => console.error("Browser error:", error.message));
  const panel = page.getByRole("region", { name: "Tier Sub Relationships", exact: true });
  const manage = page.getByRole("button", { name: "Manage Tiered Subs", exact: true });
  const summary = panel.locator("summary");
  const details = panel.locator("details");
  async function checkCollapsed(count) {
    await page.waitForFunction((count) => document.querySelector('section[aria-label="Tier Sub Relationships"] summary')?.textContent.includes(`(${count})`), count);
    assert.equal(await manage.getAttribute("aria-expanded"), "false");
    assert.equal(await details.evaluate((element) => element.open), false);
    assert.ok((await manage.boundingBox()).y < (await summary.boundingBox()).y, "Management must precede information");
  }
  await page.goto(`${appUrl}/contractors/227`);
  await page.getByRole("heading", { name: companies[0].company_name, exact: true }).waitFor().catch(async (error) => {
    console.error("Local page:", page.url(), (await page.locator("body").innerText()).slice(0, 1500));
    throw error;
  });
  await checkCollapsed(10);
  await summary.click();
  assert.equal(await manage.getAttribute("aria-expanded"), "false");
  await panel.getByRole("heading", { name: "Tiered Subs", exact: true }).waitFor();
  assert.equal(await panel.getByRole("heading", { name: "Works Under", exact: true }).count(), 0);
  const radius = panel.getByRole("listitem").filter({ has: page.getByRole("link", { name: companies[1].company_name, exact: true }) });
  await radius.getByRole("link", { name: "21-002", exact: true }).waitFor();
  assert.equal(await radius.getByRole("link", { name: "21-002" }).getAttribute("href"), "/projects?projectId=38");
  await manage.click();
  assert.equal(await details.evaluate((element) => element.open), true, "Management must not collapse information");
  assert.equal(await page.getByRole("checkbox", { name: companies[1].company_name, exact: true }).isChecked(), true);
  await summary.click();
  assert.equal(await manage.getAttribute("aria-expanded"), "true", "Information must not collapse management");
  await summary.click();
  await radius.getByRole("link", { name: companies[1].company_name, exact: true }).click();
  await page.getByRole("heading", { name: companies[1].company_name, exact: true }).waitFor();
  await checkCollapsed(1);
  await summary.click();
  await panel.getByRole("heading", { name: "Works Under", exact: true }).waitFor();
  assert.equal(await panel.getByRole("heading", { name: "Tiered Subs", exact: true }).count(), 0);
  await panel.getByRole("link", { name: "21-002", exact: true }).waitFor();
  await manage.click();
  assert.equal(await page.getByRole("checkbox", { name: companies[0].company_name, exact: true }).isChecked(), false, "A parent must not be managed as a child");
  await panel.getByRole("link", { name: companies[0].company_name, exact: true }).click();
  await page.getByRole("heading", { name: companies[0].company_name, exact: true }).waitFor();
  await checkCollapsed(10);

  relationships.push(relationship(56, 717, 900));
  await page.goto(`${appUrl}/contractors/717`);
  await page.getByRole("heading", { name: companies[1].company_name, exact: true }).waitFor();
  await checkCollapsed(2);
  await summary.click();
  await panel.getByRole("heading", { name: "Works Under", exact: true }).waitFor();
  await panel.getByRole("heading", { name: "Tiered Subs", exact: true }).waitFor();
  await panel.getByRole("link", { name: companies[2].company_name, exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await panel.evaluate((element) => element.getBoundingClientRect().right <= innerWidth), "Panel must fit a narrow viewport");
  assert.deepEqual(writes, [], "No database mutations should be attempted while viewing relationships");
  assert.deepEqual(unexpectedRequests, [], "No unexpected external requests");
  console.log("PASS: ordering, independent collapsed controls, Mechanical/Radius shared project and round-trip links, parent-only management, simultaneous directions, narrow layout; all APIs/database reads mocked.");
} finally {
  await browser.close();
}
