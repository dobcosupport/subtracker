import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "../worker/nj-pwc/node_modules/playwright");
const app = process.env.TEST_APP_URL || "http://localhost:3000";
assert.ok(["localhost", "127.0.0.1"].includes(new URL(app).hostname), "Synthetic browser tests require localhost.");
const supabaseOrigin = new URL(fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8")
  .match(/^NEXT_PUBLIC_SUPABASE_URL\s*=\s*["']?([^"'\r\n]+)/m)[1].trim()).origin;
const user = { id: "00000000-0000-0000-0000-000000000001", email: "fixture@example.invalid",
  aud: "authenticated", app_metadata: {}, user_metadata: {} };
const eligibility = {
  contractors: [{ contractor_id: 1, company_name: "Example Contractor", applicability: "applicable" },
    { contractor_id: 2, company_name: "Material Vendor", applicability: "not_applicable" },
    { contractor_id: 3, company_name: "Sixty Day Contractor", applicability: "applicable" },
    { contractor_id: 4, company_name: "Ninety Day Contractor", applicability: "applicable" }],
  requirements: [{ id: 1, compliance_name: "NJ PWC", requires_expiration: true },
    { id: 2, compliance_name: "NJ BRC", requires_expiration: false }],
  known_type_ids: [1],
  statuses: [{ contractor_id: 1, compliance_type_id: 1, compliance_record_id: 1, expiration_date: "2026-12-01",
    days_remaining: 24, calculated_status: "30 Day" },
  { contractor_id: 3, compliance_type_id: 1, compliance_record_id: 3, expiration_date: "2026-12-15",
    days_remaining: 38, calculated_status: "60 Day" },
  { contractor_id: 4, compliance_type_id: 1, compliance_record_id: 4, expiration_date: "2027-01-15",
    days_remaining: 69, calculated_status: "90 Day" }],
  overall_compliance: { population: 4, compliant: 1, nonCompliant: 1, expiringSoon: 1, needsReview: 1, rate: 25 },
};
const projects = [{ id: 5, project_number: "26-005", project_name: "Example Project", status: "Active", public_works: true },
  { id: 6, project_number: "26-006", project_name: "Private Project", status: "Active", public_works: false }];
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1536, height: 1024 } });
  await context.addInitScript(({ origin, user }) => localStorage.setItem(`sb-${new URL(origin).hostname.split(".")[0]}-auth-token`,
    JSON.stringify({ access_token: "synthetic-token", refresh_token: "synthetic-refresh", token_type: "bearer",
      expires_at: Math.floor(Date.now() / 1000) + 3600, user })), { origin: supabaseOrigin, user });
  let deny = false, fail = false, activeCount = 8, activeFail = false, navigating = false, contentAllowed = true, contentFail = false, emailDetailRequests = 0, eligibilityRequests = 0, emailRequests = 0, projectRequests = 0, followupRequests = 0, activeRequests = 0;
  await context.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin === new URL(app).origin) {
      if (url.pathname === "/api/auth/session") return route.fulfill({ json: {
        profile: { ...user, name: "Synthetic User", role: "Test", status: "Active", system_administrator: false },
        permissions: ["dashboard", "contractors", "projects", "documents", "compliance", "followups", "communications_summary", "communications_content",
          "reports", "users", "roles", "company_merge", "imports", "audit", "compliance_sync", "settings"].map(module => ({
          module, can_view: module === "dashboard" || (!deny && (module !== "communications_content" || contentAllowed)), can_manage: false, can_add: false, can_edit: false, can_delete: false,
        })),
      } });
      if (url.pathname === "/api/admin/bootstrap") return route.fulfill({ json: {} });
      if (url.pathname === "/api/dashboard/eligibility") {
        eligibilityRequests++;
        return route.fulfill(fail ? { status: 503, json: { error: "Synthetic eligibility failure" } } : { json: eligibility });
      }
      if (url.pathname === "/api/communications") {
        emailRequests++;
        return route.fulfill({ json: { messages: ["Sent", "Scheduled", "Cancelled", "Failed"].map((status, index) => ({
          id: String(index + 1), status, created_at: "2026-11-07T10:00:00Z",
        })), next_offset: null } });
      }
      if (/^\/api\/communications\/[1-4]$/.test(url.pathname)) {
        emailDetailRequests++;
        return route.fulfill(contentFail ? { status: 503, json: { error: "Synthetic content unavailable" } } : { json: { communication: { subject: `Fixture subject ${url.pathname.slice(-1)}`,
          communication_recipients: [{ recipient_name: "Fixture recipient" }, { recipient_name: "Second recipient" }] } } });
      }
      if (url.pathname.startsWith("/api/") && navigating && request.method() === "GET") return route.fulfill({ json: {} });
      assert.ok(!url.pathname.startsWith("/api/"), `Unexpected API request: ${url.pathname}`);
      return route.continue();
    }
    assert.equal(url.origin, supabaseOrigin, "All external traffic is intercepted.");
    if (url.pathname.startsWith("/auth/")) return route.fulfill({ json: user });
    const table = url.pathname.split("/").at(-1);
    if (table === "contractors" && request.method() === "HEAD") {
      activeRequests++;
      assert.equal(url.searchParams.get("active"), "eq.true");
      return route.fulfill(activeFail ? { status: 200 } : { status: 200, headers: {
        "content-range": `*/${activeCount}`, "access-control-expose-headers": "content-range",
      } });
    }
    assert.equal(request.method(), "GET", "No live database mutations.");
    if (table === "projects") { projectRequests++; return route.fulfill({ json: projects }); }
    if (table === "export_templates" || table === "export_template_user_preferences") return route.fulfill({ json: [] });
    if (table === "contractor_contacts") return route.fulfill({ json: [{ contractor_id: 1, contact_name: "Primary Example",
      email: "primary@example.invalid", business_phone: "555-0101", mobile_phone: null, is_active: true, is_primary_contact: true }] });
    if (table === "contractor_followups") {
      followupRequests++;
      return route.fulfill({ json: [{ id: 1, contractor_id: 1, contractor: { company_name: "Example Contractor" },
        followup_date: "2026-11-10", subject: "Review registration", status: "Open", notes: null }] });
    }
    if (navigating) return route.fulfill({ json: [] });
    throw new Error(`Unexpected database request: ${table}`);
  });
  const page = await context.newPage(), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(app);
  await page.getByRole("heading", { name: "Welcome back, Synthetic!" }).waitFor();
  await page.getByRole("heading", { name: "Upcoming Expirations" }).waitFor();
  await page.getByRole("heading", { name: "Contractor Growth" }).waitFor();
  await page.getByRole("heading", { name: "Recent Email Communications" }).waitFor();
  const layout = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('section[aria-label="Dashboard overview"] > *')].map(element => element.getBoundingClientRect());
    const panels = ["Contractor Growth", "Overall Contractor Compliance", "Upcoming Expirations", "Open Follow-Ups", "Projects", "Recent Email Communications"]
      .map(title => [...document.querySelectorAll("h2")].filter(element => element.textContent === title).at(-1)?.closest("section")?.getBoundingClientRect());
    return { cards: cards.map(({ x, y, width, height }) => ({ x, y, width, height })),
      panels: panels.map(rect => rect && ({ x: rect.x, y: rect.y, width: rect.width, height: rect.height, bottom: rect.bottom })) };
  });
  for (const width of [2560, 1920, 1536, 1440, 1366]) {
    await page.setViewportSize({ width, height: width === 2560 ? 1440 : 1024 });
    const responsiveLayout = await page.evaluate(() => {
      const main = document.querySelector("main");
      const content = main.children[1].getBoundingClientRect();
      const workspace = main.parentElement.getBoundingClientRect();
      const workspaceBackground = getComputedStyle(main.parentElement).backgroundImage;
      const sidebarBackground = getComputedStyle(document.querySelector("aside")).backgroundImage;
      const cards = [...document.querySelectorAll('section[aria-label="Dashboard overview"] > *')].map(element => element.getBoundingClientRect());
      return {
        content: { x: content.x, width: content.width, right: content.right },
        workspace: { x: workspace.x, width: workspace.width, right: workspace.right },
        workspaceBackground,
        sidebarBackground,
        cardRows: new Set(cards.map(card => Math.round(card.y))).size,
        overflow: document.documentElement.scrollWidth > window.innerWidth,
      };
    });
    assert.equal(responsiveLayout.overflow, false, `Dashboard does not overflow at ${width}px`);
    assert.equal(responsiveLayout.cardRows, 1, `five KPI cards remain on one row at ${width}px`);
    if (width === 2560) {
      assert.equal(responsiveLayout.content.width, 2100);
      assert.match(responsiveLayout.workspaceBackground, /subtracker-app-background\.png/);
      assert.doesNotMatch(responsiveLayout.sidebarBackground, /subtracker-app-background\.png/);
      assert.ok(responsiveLayout.content.x - responsiveLayout.workspace.x >= 90
        && responsiveLayout.workspace.right - responsiveLayout.content.right >= 90,
      `large display gutters remain balanced: ${JSON.stringify(responsiveLayout)}`);
      if (process.env.DASHBOARD_LARGE_SCREEN_SCREENSHOT) {
        await page.screenshot({ path: process.env.DASHBOARD_LARGE_SCREEN_SCREENSHOT, fullPage: true });
      }
    } else {
      assert.equal(responsiveLayout.content.width, responsiveLayout.workspace.width,
        `existing content widths are unchanged at ${width}px`);
      assert.doesNotMatch(responsiveLayout.workspaceBackground, /subtracker-app-background\.png/,
        `construction artwork stays hidden at ${width}px`);
    }
  }
  await page.setViewportSize({ width: 1536, height: 1024 });
  assert.equal(layout.cards.length, 5);
  assert.ok(layout.cards.every(card => Math.abs(card.y - layout.cards[0].y) < 1 && Math.abs(card.width - layout.cards[0].width) < 2));
  assert.ok(Math.abs(layout.panels[2].y - layout.panels[1].y) < 1 && Math.abs(layout.panels[2].height - layout.panels[1].height) < 1);
  assert.ok(layout.panels[2].x < layout.panels[1].x && layout.panels[2].width > layout.panels[0].width);
  assert.ok(layout.panels[0].y > layout.panels[2].y && Math.abs(layout.panels[0].y - layout.panels[3].y) < 1 && Math.abs(layout.panels[0].y - layout.panels[4].y) < 1);
  assert.ok(layout.panels[0].x < layout.panels[3].x && layout.panels[3].x < layout.panels[4].x);
  assert.ok(Math.abs(layout.panels[0].bottom - layout.panels[5].bottom) < 1);
  assert.equal(await page.getByText("Overall", { exact: false }).count() > 0, true);
  const activeKpi = page.getByRole("link", { name: "Active Contractors", exact: true });
  assert.match(await activeKpi.innerText(), /Active Contractors\s+8\s+4 with active project assignments/);
  const growthPanel = page.locator("section").filter({ has: page.getByRole("heading", { name: "Contractor Growth" }) });
  const month = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric" }).format(new Date());
  await growthPanel.getByRole("img", { name: `${month}: 8 active contractors; 4 active and assigned contractors` }).waitFor();
  assert.equal(await growthPanel.locator('[role="img"] > div > div > div').count(), 2);
  assert.doesNotMatch(await growthPanel.innerText(), /September|October|tracking begins|snapshots/i);
  assert.equal(await growthPanel.getByRole("link").count(), 1);
  const growthLink = growthPanel.getByRole("link", { name: "Contractor Growth: View Contractors" });
  assert.equal(await growthLink.getAttribute("href"), "/contractors");
  assert.equal(await growthLink.evaluate(element => getComputedStyle(element).cursor), "pointer");
  const growthBounds = await growthPanel.boundingBox(), linkBounds = await growthLink.boundingBox();
  assert.ok(growthBounds && linkBounds && Math.abs(growthBounds.width - linkBounds.width) <= 2
    && Math.abs(growthBounds.height - linkBounds.height) <= 2, "growth link covers the card");
  const compliancePanel = page.locator("section").filter({ has: page.getByRole("heading", { name: "Overall Contractor Compliance" }) });
  assert.match(await compliancePanel.innerText(), /Overall rate/);
  assert.match(await compliancePanel.innerText(), /Based on FEIN, NJ BRC, and applicable NJ PWC/);
  assert.match(await compliancePanel.innerText(), /4 Active \+ Assigned Contractors/);
  assert.match(await compliancePanel.innerText(), /Compliant\s+1 · 25\.0%/);
  assert.match(await compliancePanel.innerText(), /Non-Compliant\s+1 · 25\.0%/);
  assert.match(await compliancePanel.innerText(), /Expiring Soon\s+1 · 25\.0%/);
  assert.match(await compliancePanel.innerText(), /Needs Review\s+1 · 25\.0%/);
  assert.match(await compliancePanel.innerText(), /25\.0%\s+Overall rate/);
  assert.doesNotMatch(await compliancePanel.innerText(), /100%|NJ PWC Current/);
  assert.equal(await compliancePanel.getByRole("button").count(), 0);
  assert.equal(await compliancePanel.getByRole("link", { name: "View Compliance →" }).count(), 1);
  for (const control of [compliancePanel.getByRole("link", { name: "View Compliance →" })]) {
    const bounds = await control.boundingBox(), panelBounds = await compliancePanel.boundingBox();
    assert.ok(bounds && panelBounds && bounds.y + bounds.height <= panelBounds.y + panelBounds.height,
      "Compliance controls fit without clipping");
  }
  assert.equal(await page.getByRole("heading", { name: "Assigned Contractors" }).count(), 0);
  assert.equal(await page.getByRole("heading", { name: "Known Requirement Exceptions" }).count(), 0);
  const expirations = page.locator("section").filter({ has: page.getByRole("heading", { name: "Upcoming Expirations" }) });
  assert.match(await expirations.innerText(), /Current applicable requirements approaching expiration/);
  assert.doesNotMatch(await expirations.innerText(), /Current requirements due|^Current requirements$/m);
  assert.deepEqual(await expirations.locator("th").allTextContents(), ["Contractor", "Requirement", "Expiration", "Days Remaining"]);
  assert.match(await page.getByRole("button", { name: "Next 30 Days" }).innerText(), /1/);
  assert.match(await page.getByRole("button", { name: "Next 60 Days" }).innerText(), /2/);
  assert.match(await page.getByRole("button", { name: "Next 90 Days" }).innerText(), /3/);
  assert.equal(await expirations.locator("tbody tr").count(), 1);
  assert.equal(await page.getByRole("button", { name: "Next 30 Days" }).getAttribute("aria-pressed"), "true");
  await page.getByRole("button", { name: "Next 60 Days" }).click();
  assert.equal(new URL(page.url()).pathname, "/");
  assert.equal(await page.getByRole("button", { name: "Next 60 Days" }).getAttribute("aria-pressed"), "true");
  assert.equal(await expirations.locator("tbody tr").count(), 2);
  await page.getByRole("button", { name: "Next 90 Days" }).click();
  assert.equal(new URL(page.url()).pathname, "/");
  assert.equal(await expirations.locator("tbody tr").count(), 3);
  assert.equal(await page.getByText("Review registration", { exact: true }).count(), 1);
  const diagnostic = page.getByRole("button", { name: "Review Details →" });
  assert.equal(await diagnostic.evaluate(element => element.closest("a") === null), true, "diagnostic is not nested inside the navigation link");
  await page.keyboard.press("Tab");
  await diagnostic.focus();
  assert.equal(await diagnostic.evaluate(element => element.matches(":focus-visible")), true);
  await page.keyboard.press("Enter");
  assert.equal(new URL(page.url()).pathname, "/");
  await page.getByRole("button", { name: "Assigned contractors", exact: true }).click();
  await page.getByRole("cell", { name: /Primary Example/ }).waitFor();
  assert.equal(await page.getByText("No Primary Contact", { exact: true }).count(), 3);
  await page.getByRole("button", { name: "Export assigned contractors" }).click();
  await page.getByRole("dialog", { name: "Dashboard Export" }).waitFor();
  await page.getByRole("button", { name: "Close Dashboard Export" }).click();
  await page.getByRole("button", { name: "Close Dashboard details" }).click();
  await diagnostic.click();
  assert.equal(new URL(page.url()).pathname, "/");
  await page.getByRole("button", { name: "Close Dashboard details" }).click();
  await page.getByText("Fixture subject 1", { exact: true }).waitFor();
  assert.equal(await page.getByText("Fixture recipient +1", { exact: true }).count(), 3);
  assert.equal(await page.getByText("Fixture subject 3", { exact: true }).count(), 1);
  assert.equal(await page.getByText("Fixture subject 4", { exact: true }).count(), 0);
  const emailPanel = page.locator("section").filter({ has: page.getByRole("heading", { name: "Recent Email Communications" }) });
  const emailFit = await emailPanel.evaluate(element => {
    const panel = element.getBoundingClientRect(), rows = [...element.querySelectorAll("tbody tr")].map(row => row.getBoundingClientRect());
    return { rows: rows.length, lastBottom: rows.at(-1)?.bottom, panelBottom: panel.bottom, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight };
  });
  assert.equal(emailFit.rows, 3);
  assert.ok(emailFit.lastBottom <= emailFit.panelBottom && emailFit.scrollHeight <= emailFit.clientHeight, `three email rows fit without clipping: ${JSON.stringify(emailFit)}`);
  const projectPanel = page.locator("section").filter({ has: page.getByRole("heading", { name: "Projects", exact: true }) });
  assert.ok(await projectPanel.evaluate(element => element.scrollHeight <= element.clientHeight), "project information is not clipped");
  assert.match(await projectPanel.innerText(), /Public Works/);
  assert.match(await projectPanel.innerText(), /Non-Public Works/);
  await page.getByLabel("Search active projects and assigned contractors").fill("26-005");
  assert.equal(await page.getByRole("link", { name: "26-005 Example Project" }).getAttribute("href"), "/projects?projectId=5");
  await page.getByLabel("Search active projects and assigned contractors").clear();
  await page.getByRole("button", { name: "Next 30 Days" }).click();
  if (process.env.DASHBOARD_SCREENSHOT) await page.screenshot({ path: process.env.DASHBOARD_SCREENSHOT, fullPage: true });
  await page.setViewportSize({ width: 1366, height: 768 });
  for (const [panel, control] of [[growthPanel, growthPanel.getByText(month, { exact: true })],
    [expirations, expirations.getByRole("button", { name: "Next 90 Days" })],
    [compliancePanel, compliancePanel.getByRole("link", { name: "View Compliance →" })]]) {
    const bounds = await control.boundingBox(), panelBounds = await panel.boundingBox();
    assert.ok(bounds && panelBounds && bounds.x >= panelBounds.x && bounds.x + bounds.width <= panelBounds.x + panelBounds.width
      && bounds.y + bounds.height <= panelBounds.y + panelBounds.height, "notebook panel controls fit");
  }
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "notebook content does not overflow");
  assert.ok(await emailPanel.evaluate(element => element.scrollHeight <= element.clientHeight), "three emails fit at notebook width");
  assert.ok(await projectPanel.evaluate(element => element.scrollHeight <= element.clientHeight), "project information fits at notebook width");
  const extraDays = [1, 30, 31, 60, 90, 0, 91];
  for (const [index, day] of extraDays.entries()) {
    const id = 100 + index;
    eligibility.contractors.push({ contractor_id: id, company_name: `Boundary ${day}`, applicability: "applicable" });
    const date = new Date(Date.UTC(2026, 10, 7 + day)).toISOString().slice(0, 10);
    eligibility.statuses.push({ contractor_id: id, compliance_type_id: 1, compliance_record_id: id,
      expiration_date: date, days_remaining: day, calculated_status: "Active" });
  }
  eligibility.overall_compliance = { population: eligibility.contractors.length, compliant: 1, nonCompliant: 1,
    expiringSoon: 1, needsReview: eligibility.contractors.length - 3, rate: 1 / eligibility.contractors.length * 100 };
  await page.reload();
  await page.getByRole("button", { name: "Next 30 Days" }).waitFor();
  assert.match(await page.getByRole("button", { name: "Next 30 Days" }).innerText(), /3/);
  assert.match(await page.getByRole("button", { name: "Next 60 Days" }).innerText(), /6/);
  assert.match(await page.getByRole("button", { name: "Next 90 Days" }).innerText(), /8/);
  await page.getByRole("button", { name: "Next 90 Days" }).click();
  assert.equal(await expirations.locator("tbody tr").count(), 3);
  assert.deepEqual(await expirations.locator("tbody tr td:first-child").allTextContents(), ["Boundary 1", "Example Contractor", "Boundary 30"]);
  const expirationFit = await expirations.evaluate(element => {
    const table = element.querySelector("table").parentElement;
    return { panelHeight: element.clientHeight, panelScrollHeight: element.scrollHeight, tableHeight: table.clientHeight,
      tableScrollHeight: table.scrollHeight, tableOverflowY: getComputedStyle(table).overflowY };
  });
  assert.ok(expirationFit.panelScrollHeight <= expirationFit.panelHeight && expirationFit.tableScrollHeight <= expirationFit.tableHeight
    && expirationFit.tableOverflowY !== "auto" && expirationFit.tableOverflowY !== "scroll", `expiration preview fits: ${JSON.stringify(expirationFit)}`);
  eligibility.contractors.splice(-extraDays.length);
  eligibility.statuses.splice(-extraDays.length);
  eligibility.overall_compliance = { population: 4, compliant: 1, nonCompliant: 1, expiringSoon: 1, needsReview: 1, rate: 25 };
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Menu", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "Close menu", exact: true }).getAttribute("aria-expanded"), "true");
  assert.equal(await page.getByRole("link", { name: /Dashboard/ }).isVisible(), true);
  await page.getByRole("button", { name: "Close menu", exact: true }).click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "mobile content does not overflow");
  contentAllowed = false;
  const detailReads = emailDetailRequests;
  await page.reload();
  await page.getByRole("heading", { name: "Recent Email Communications" }).waitFor();
  await page.getByText("Restricted", { exact: true }).first().waitFor();
  assert.equal(emailDetailRequests, detailReads, "summary-only users do not request content");
  contentAllowed = true;
  contentFail = true;
  await page.reload();
  await page.getByRole("alert").getByText("Email details temporarily unavailable.").waitFor();
  assert.equal(await page.getByText("Synthetic content unavailable").count(), 0);
  contentFail = false;
  activeCount = 9;
  await page.reload();
  await growthPanel.getByRole("img", { name: `${month}: 9 active contractors; 4 active and assigned contractors` }).waitFor();
  assert.match(await activeKpi.innerText(), /Active Contractors\s+9\s+4 with active project assignments/);
  activeFail = true;
  await page.reload();
  await page.getByRole("alert").filter({ hasText: "Contractor growth temporarily unavailable." }).waitFor();
  activeFail = false;
  fail = true;
  await page.reload();
  await page.getByRole("alert").getByText("Compliance data temporarily unavailable").waitFor();
  assert.equal(await page.getByText("Synthetic eligibility failure").count(), 0, "raw backend errors are not displayed");
  assert.equal(await page.getByRole("heading", { name: "Projects", exact: true }).count(), 1);
  deny = true;
  const before = [eligibilityRequests, emailRequests, projectRequests, followupRequests, activeRequests];
  await page.reload();
  await page.getByRole("heading", { name: "Welcome back, Synthetic!" }).waitFor();
  await page.waitForTimeout(300);
  assert.deepEqual([eligibilityRequests, emailRequests, projectRequests, followupRequests, activeRequests], before, "no restricted data requests without permission");
  assert.deepEqual(errors, []);
  deny = false;
  fail = false;
  navigating = true;
  await page.setViewportSize({ width: 1536, height: 1024 });
  for (const mode of ["card", "bar", "Enter", "Space"]) {
    await page.goto(app);
    await growthPanel.getByRole("img").waitFor();
    if (mode === "card") await growthLink.click({ position: { x: 8, y: 8 } });
    else if (mode === "bar") {
      const bar = await growthPanel.locator('[role="img"] > div > div > div').first().boundingBox();
      assert.ok(bar);
      await page.mouse.click(bar.x + bar.width / 2, bar.y + bar.height / 2);
    } else {
      await growthLink.focus();
      assert.equal(await growthLink.evaluate(element => element.matches(":focus-visible")), true);
      await page.keyboard.press(mode);
    }
    await page.waitForURL(url => url.pathname === "/contractors");
    await page.getByRole("heading", { name: "Contractor Management", exact: true }).waitFor();
  }
  const navigationCases = [
    { region: "overview", name: "Active Contractors", path: "/contractors", heading: "Contractor Management", active: "Active Contractors" },
    { region: "overview", name: "Active Projects", path: "/projects", heading: "Project Management", active: "Active Projects" },
    { region: "overview", name: "Compliance Rate", path: "/compliance", heading: "Compliance Tracking" },
    { region: "overview", name: "Open Follow-Ups", path: "/followups", heading: "Follow-Ups" },
    { region: "overview", name: "Expiring Soon", path: "/compliance" },
    { region: "Upcoming Expirations", name: "View all compliance expirations", path: "/compliance" },
    { region: "Upcoming Expirations", name: "Example Contractor", path: "/contractors/1" },
    { region: "Open Follow-Ups", name: "View all follow-ups", path: "/followups" },
    { region: "Open Follow-Ups", name: "Example Contractor", path: "/contractors/1" },
    { region: "Projects", name: "View all projects", path: "/projects" },
    { region: "Overall Contractor Compliance", name: "View Compliance →", path: "/compliance" },
    { region: "Recent Email Communications", name: "View all email communications", path: "/email-communications" },
  ];
  await page.setViewportSize({ width: 1536, height: 1024 });
  for (const testCase of navigationCases) {
    const modes = testCase.name === "Example Contractor" ? [false] : [false, true];
    for (const keyboard of modes) {
      await page.goto(app);
      await page.getByRole("heading", { name: "Welcome back, Synthetic!" }).waitFor();
      const region = testCase.region === "overview" ? page.locator('section[aria-label="Dashboard overview"]')
        : page.locator("section").filter({ has: page.getByRole("heading", { name: testCase.region, exact: true }) });
      const link = region.getByRole("link", { name: testCase.name, exact: true });
      await link.waitFor();
      if (keyboard) {
        await link.focus();
        assert.equal(await link.evaluate(element => element.matches(":focus-visible")), true, `${testCase.name} has visible keyboard focus`);
        await page.keyboard.press("Enter");
      } else {
        await link.click({ position: testCase.region === "overview" ? { x: 8, y: 8 } : undefined });
      }
      await page.waitForURL(url => url.pathname === testCase.path);
      assert.equal(new URL(page.url()).search, "", `${testCase.name} uses no invented filter`);
      if (testCase.heading) await page.getByRole("heading", { name: testCase.heading, exact: true }).waitFor();
      if (testCase.active) assert.match(await page.getByRole("button", { name: new RegExp(`^${testCase.active}`) }).getAttribute("class"), /bg-slate-900/);
    }
  }
  await context.close();
} finally {
  await browser.close();
}
console.log("Style 3 Dashboard: fixture data, filtering, search, failures, permissions and mobile passed.");
