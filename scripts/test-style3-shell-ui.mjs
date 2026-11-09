import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "../worker/nj-pwc/node_modules/playwright");
const app = process.env.TEST_APP_URL || "http://localhost:3000";
assert.ok(["localhost", "127.0.0.1"].includes(new URL(app).hostname), "Use an intercepted localhost preview.");
const origin = new URL(fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8")
  .match(/^NEXT_PUBLIC_SUPABASE_URL\s*=\s*["']?([^"'\r\n]+)/m)[1].trim()).origin;
const user = { id: "00000000-0000-0000-0000-000000000001", email: "fixture@example.invalid",
  aud: "authenticated", app_metadata: {}, user_metadata: {} };
const modules = ["dashboard", "contractors", "projects", "documents", "compliance", "followups",
  "communications_summary", "reports", "users", "roles", "company_merge", "imports", "audit", "compliance_sync", "settings"];
const navigation = ["Dashboard", "Contractors", "Projects", "Documents", "Compliance", "Follow-Ups",
  "Email Communications", "Reports", "User Management", "Roles & Permissions", "Company Merge", "Import / Export", "Logs", "Compliance Sync", "Settings"];
const contractors = [
  { id: 1, company_name: "Alpha Contractor", trade: "Concrete", active: true, material_vendor_only: false, phone: "555-0101" },
  { id: 2, company_name: "Beta Vendor", trade: null, active: true, material_vendor_only: true },
  { id: 3, company_name: "Inactive Company", trade: null, active: false, material_vendor_only: false },
];
let denied = false;
const requests = [];
const browser = await chromium.launch({ headless: true });

async function fixtureContext(authenticated) {
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  if (authenticated) await context.addInitScript(({ origin, user }) =>
    localStorage.setItem(`sb-${new URL(origin).hostname.split(".")[0]}-auth-token`, JSON.stringify({
      access_token: "synthetic-token", refresh_token: "synthetic-refresh", token_type: "bearer",
      expires_at: Math.floor(Date.now() / 1000) + 3600, user,
    })), { origin, user });
  await context.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin === new URL(app).origin) {
      if (url.pathname === "/api/auth/session") {
        requests.push(url.pathname);
        return route.fulfill({ json: {
          profile: { ...user, name: "Synthetic User", role: "Test", status: "Active", system_administrator: false },
          permissions: modules.map(module => ({ module, can_view: !denied || module === "dashboard",
            can_manage: !denied, can_add: false, can_edit: false, can_delete: false })),
        } });
      }
      if (url.pathname === "/api/admin/bootstrap") {
        requests.push(url.pathname);
        return route.fulfill({ json: {} });
      }
      assert.ok(!url.pathname.startsWith("/api/"), `Unexpected API request: ${url.pathname}`);
      return route.continue();
    }
    assert.equal(url.origin, origin, "All external traffic must be intercepted.");
    requests.push(`${request.method()} ${url.pathname}`);
    if (url.pathname === "/auth/v1/logout") return route.fulfill({ status: 204 });
    if (url.pathname === "/auth/v1/user") return route.fulfill({ json: user });
    assert.ok(["GET", "HEAD"].includes(request.method()), "No database mutations or email requests.");
    assert.ok(url.pathname.startsWith("/rest/v1/"), `Unexpected external request: ${url.pathname}`);
    const table = url.pathname.split("/").at(-1);
    if (request.method() === "HEAD") return route.fulfill({ status: 200, headers: {
      "content-range": "*/0", "access-control-expose-headers": "content-range",
    } });
    return route.fulfill({ json: table === "contractors" ? contractors : [] });
  });
  return context;
}

try {
  const context = await fixtureContext(true);
  const page = await context.newPage(), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${app}/contractors`);
  await page.getByRole("cell", { name: "Alpha Contractor", exact: true }).waitFor();
  const sidebar = page.locator("#app-navigation");
  assert.deepEqual(await sidebar.locator("nav a").allTextContents(), navigation);
  assert.equal(await sidebar.locator("nav svg").count(), navigation.length, "Production colored icons are reused.");
  assert.equal(await sidebar.locator('[aria-current="page"]').innerText(), "Contractors");
  assert.equal(await sidebar.getByRole("img", { name: "Dobco", exact: true }).count(), 1);
  assert.equal(await sidebar.getByText("Administration", { exact: true }).count(), 1);
  assert.equal(await page.locator("header").count(), 1);
  assert.equal(await page.getByPlaceholder("Search active projects or assigned contractors").count(), 0);

  const sizes = [[2560, 1440], [1920, 1080], [1536, 864], [1366, 768], [1280, 800], [1024, 768], [768, 1024], [390, 844], [320, 640]];
  if (process.env.SHELL_SCREENSHOT_DIR) fs.mkdirSync(process.env.SHELL_SCREENSHOT_DIR, { recursive: true });
  for (const [width, height] of sizes) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(300);
    const bounds = await page.evaluate(() => {
      const sidebar = document.querySelector("#app-navigation");
      const workspace = sidebar.nextElementSibling;
      const header = document.querySelector("header");
      const content = document.querySelector("main");
      return {
        overflow: document.documentElement.scrollWidth > innerWidth,
        sidebarWidth: sidebar.getBoundingClientRect().width,
        workspaceX: workspace.getBoundingClientRect().x,
        background: getComputedStyle(workspace).backgroundImage,
        sidebarBackground: getComputedStyle(sidebar).backgroundImage,
        header: header.getBoundingClientRect().toJSON(),
        content: content.getBoundingClientRect().toJSON(),
      };
    });
    assert.equal(bounds.overflow, false, `No horizontal page overflow at ${width}px`);
    assert.equal(bounds.sidebarWidth, 252);
    assert.equal(bounds.workspaceX, width > 900 ? 252 : 0);
    assert.equal(bounds.header.right, width);
    assert.ok(bounds.content.width <= 2100);
    assert.equal(bounds.sidebarBackground, "none", "Artwork stays out of the sidebar.");
    if (width >= 2200) assert.match(bounds.background, /subtracker-app-background-v3\.png/);
    else assert.doesNotMatch(bounds.background, /subtracker-app-background/);
    assert.equal(await page.getByRole("button", { name: "Menu", exact: true }).count(), width > 900 ? 0 : 1);
    for (const control of [page.getByRole("button", { name: "Add Contractor", exact: true }),
      page.getByPlaceholder("Search contractors"), page.getByRole("combobox", { name: "Company Type Filter" })]) {
      const box = await control.boundingBox();
      assert.ok(box && box.x >= 0 && box.x + box.width <= width + 1,
        `Workspace controls fit at ${width}px: ${JSON.stringify(box)}`);
    }
    if (process.env.SHELL_SCREENSHOT_DIR) await page.screenshot({
      path: `${process.env.SHELL_SCREENSHOT_DIR}\\contractors-${width}x${height}.png`, animations: "disabled",
    });
  }
  await page.getByRole("button", { name: "Menu", exact: true }).click();
  await sidebar.getByRole("link", { name: "Contractors", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "Menu", exact: true }).getAttribute("aria-expanded"), "false",
    "Mobile navigation closes after selecting a route.");
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.getByRole("button", { name: "Close menu", exact: true }).click();
  await page.waitForTimeout(300);
  assert.equal(await page.locator("header").evaluate(element => element.getBoundingClientRect().x), 0);
  await page.getByRole("button", { name: "Menu", exact: true }).click();

  await page.getByPlaceholder("Search contractors").fill("alpha");
  assert.equal(await page.locator("tbody tr").count(), 1);
  await page.getByPlaceholder("Search contractors").fill("");
  await page.getByRole("combobox", { name: "Company Type Filter" }).selectOption("vendors");
  assert.equal(await page.locator("tbody tr").count(), 1);
  assert.match(await page.locator("tbody").innerText(), /Beta Vendor/);
  await page.getByRole("combobox", { name: "Company Type Filter" }).selectOption("all");
  await page.getByRole("button", { name: /Inactive Contractors/ }).click();
  assert.match(await page.locator("tbody").innerText(), /Inactive Company/);
  await page.getByRole("button", { name: /Active Contractors/, exact: false }).first().click();
  await page.getByRole("button", { name: /Company Name/ }).click();
  assert.match(await page.locator("tbody tr").first().innerText(), /Beta Vendor/);
  await page.getByRole("button", { name: "Add Contractor", exact: true }).click();
  await page.getByRole("heading", { name: "Add Contractor", exact: true }).waitFor();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.locator('summary[aria-label="Help"]').click();
  assert.match(await page.locator("header").innerText(), /Search and manage contractors using the controls below/);
  await page.locator('summary[aria-label="Help"]').click();
  await page.locator('summary[aria-label="Account menu"]').click();
  await page.locator("header").getByRole("button", { name: "Sign Out", exact: true }).focus();
  await page.keyboard.press("Enter");
  await page.waitForURL(`${app}/login`);
  assert.ok(requests.includes("POST /auth/v1/logout"));
  assert.ok(!requests.some(request => /dashboard\/eligibility|communications|contractor_followups/.test(request)),
    "Contractors shell never reads Dashboard datasets.");
  assert.deepEqual(errors, []);
  await context.close();

  const limited = await fixtureContext(true);
  denied = true;
  const limitedPage = await limited.newPage();
  await limitedPage.goto(`${app}/contractors`);
  await limitedPage.getByRole("heading", { name: "Access Denied" }).waitFor();
  assert.equal(await limitedPage.getByRole("heading", { name: "Contractor Management" }).count(), 0);
  denied = false;
  await limited.close();

  const otherRoutes = await fixtureContext(true);
  const otherPage = await otherRoutes.newPage();
  await otherPage.goto(`${app}/reports`);
  await otherPage.locator("#app-navigation").waitFor();
  assert.equal(await otherPage.locator("#app-navigation nav svg").count(), navigation.length, "Reports reuses the production shell.");
  assert.equal(await otherPage.locator("#app-navigation [aria-current=page]").innerText(), "Reports");
  assert.equal(await otherPage.locator('summary[aria-label="Account menu"]').count(), 1);
  await otherPage.goto(`${app}/projects`);
  await otherPage.locator("#app-navigation").waitFor();
  assert.equal(await otherPage.locator("#app-navigation nav svg").count(), 0, "Unconverted routes retain their existing shell.");
  await otherRoutes.close();

  for (const authenticated of [false, true]) {
    const authContext = await fixtureContext(authenticated);
    const authPage = await authContext.newPage();
    for (const path of ["/login", "/setup", "/invite", "/reset-password"]) {
      const start = requests.length;
      await authPage.goto(`${app}${path}`);
      if (path === "/invite") await authPage.getByText(authenticated ? "Welcome to SubTracker" : "Invitation link invalid or expired", { exact: true }).waitFor();
      else if (path === "/reset-password") await authPage.getByText(authenticated ? "Reset your password" : "Reset link invalid or expired", { exact: true }).waitFor();
      else if (path === "/setup") await authPage.getByText("System administrator account is ready.", { exact: true }).waitFor();
      else await authPage.locator("main").waitFor();
      assert.equal(new URL(authPage.url()).pathname, path, `${path} is not redirected by AppShell`);
      assert.equal(await authPage.locator("#app-navigation").count(), 0);
      assert.equal(await authPage.locator('summary[aria-label="Account menu"]').count(), 0);
      assert.ok(!requests.slice(start).some(request => request === "/api/auth/session"
        || (path !== "/setup" && request === "/api/admin/bootstrap")),
        `${path} bypasses application profile/bootstrap checks`);
      if (path === "/setup") assert.equal(requests.slice(start).filter(request => request === "/api/admin/bootstrap").length, 1,
        "Setup retains its own existing bootstrap request without a duplicate shell bootstrap.");
    }
    if (!authenticated) {
      await authPage.goto(`${app}/contractors`);
      await authPage.waitForURL(`${app}/login?next=%2Fcontractors`);
    }
    await authContext.close();
  }
  console.log("Style 3 shared shell: nine viewports, navigation, controls, isolated data, permissions, Sign Out and four auth-flow bypasses passed.");
} finally {
  await browser.close();
}
