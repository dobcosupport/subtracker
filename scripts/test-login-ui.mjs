import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "../worker/nj-pwc/node_modules/playwright");
const appUrl = process.env.TEST_APP_URL;
assert.ok(appUrl && new URL(appUrl).hostname === "localhost", "Use an intercepted localhost preview");

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
const requests = [];
let signInSucceeds = false;
let recoverySucceeds = false;

try {
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== new URL(appUrl).origin) {
      if (url.pathname.endsWith("/auth/v1/token") && request.method() === "POST") {
        requests.push({ type: "sign-in", body: request.postDataJSON() });
        if (!signInSucceeds) {
          return route.fulfill({ status: 400, json: { error: "invalid_grant", error_description: "Invalid login credentials" } });
        }
        const now = Math.floor(Date.now() / 1000);
        const payload = Buffer.from(JSON.stringify({ sub: "00000000-0000-0000-0000-000000000001", exp: now + 3600, iat: now })).toString("base64url");
        return route.fulfill({ json: {
          access_token: `synthetic.${payload}.signature`, refresh_token: "synthetic-refresh",
          token_type: "bearer", expires_in: 3600, expires_at: now + 3600,
          user: { id: "00000000-0000-0000-0000-000000000001", email: "synthetic@example.invalid", aud: "authenticated", app_metadata: {}, user_metadata: {} },
        } });
      }
      return route.abort();
    }
    if (url.pathname === "/api/auth/recovery") {
      requests.push({ type: "recovery", body: request.postDataJSON() });
      return route.fulfill(recoverySucceeds
        ? { json: { message: "If the account exists, a password reset email has been sent." } }
        : { status: 503, json: { error: "Recovery unavailable." } });
    }
    if (url.pathname.startsWith("/api/")) {
      if (url.pathname === "/api/auth/session") requests.push({ type: "session-check" });
      return route.fulfill({ status: 403, json: { error: "Blocked in login test." } });
    }
    return route.continue();
  });

  await page.goto(`${appUrl}/login`);
  assert.equal(await page.getByAltText("Dobco Group").evaluate((image) =>
    new URL(image.currentSrc).searchParams.get("url")), "/Logo.png");
  assert.equal(await page.getByRole("link", { name: "Initial Setup" }).getAttribute("href"), "/setup");
  assert.equal(await page.getByLabel("Password", { exact: true }).getAttribute("minlength"), "8");
  assert.equal(await page.getByLabel("Password", { exact: true }).getAttribute("autocomplete"), "current-password");
  await page.getByRole("link", { name: "Initial Setup" }).click();
  await page.waitForURL((url) => url.pathname === "/setup");
  await page.goto(`${appUrl}/login`);
  await page.keyboard.press("Tab");
  assert.equal(await page.getByLabel("Email", { exact: true }).evaluate((element) =>
    document.activeElement === element && element.matches(":focus-visible")), true, "Keyboard focus is visible on the email field");
  await page.getByLabel("Email", { exact: true }).fill("synthetic@example.invalid");
  await page.getByLabel("Password", { exact: true }).fill("synthetic-password");
  await page.getByRole("button", { name: "Show password" }).click();
  assert.equal(await page.getByLabel("Password", { exact: true }).getAttribute("type"), "text");
  await page.getByRole("button", { name: "Hide password" }).click();
  assert.equal(await page.getByLabel("Password", { exact: true }).getAttribute("type"), "password");
  await page.getByRole("button", { name: "Sign In", exact: true }).click();
  await page.locator("form").getByRole("alert").getByText("Invalid login credentials").waitFor();
  assert.deepEqual(requests[0], { type: "sign-in", body: { email: "synthetic@example.invalid", password: "synthetic-password", gotrue_meta_security: {} } });

  await page.getByRole("button", { name: "Forgot password?" }).click();
  assert.equal(await page.locator("form").getByRole("alert").count(), 0);
  assert.equal(await page.getByLabel("Password", { exact: true }).count(), 0);
  await page.getByRole("button", { name: "Reset password" }).click();
  await page.locator("form").getByRole("alert").getByText("Recovery unavailable.").waitFor();
  recoverySucceeds = true;
  await page.getByRole("button", { name: "Reset password" }).click();
  await page.locator("form").getByRole("status").getByText("If the account exists, a password reset email has been sent.").waitFor();
  assert.deepEqual(requests.filter((item) => item.type === "recovery").map((item) => item.body), [
    { email: "synthetic@example.invalid" }, { email: "synthetic@example.invalid" },
  ]);
  await page.getByRole("button", { name: "Back to login" }).click();
  assert.equal(await page.locator("form").getByRole("status").count(), 0);

  for (const [width, height] of [[2560, 1440], [1920, 1080], [1536, 864], [1440, 900], [1366, 768], [1280, 800], [1024, 768], [853, 533], [768, 1024], [640, 400], [390, 844], [320, 640]]) {
    await page.setViewportSize({ width, height });
    const layout = await page.evaluate(() => {
      const card = document.querySelector("section[aria-label='Account access']").getBoundingClientRect();
      return {
        viewport: document.documentElement.clientWidth,
        content: document.documentElement.scrollWidth,
        background: getComputedStyle(document.querySelector("main")).backgroundImage,
        backgroundSize: getComputedStyle(document.querySelector("main")).backgroundSize,
        overlayCount: document.querySelectorAll("main > section").length,
        text: document.querySelector("main").innerText,
        card: card.toJSON(),
      };
    });
    assert.ok(layout.content <= layout.viewport, `Horizontal overflow at ${width}x${height}`);
    assert.match(layout.background, /subtracker-app-background-v9\.png/);
    assert.doesNotMatch(layout.background, /linear-gradient/);
    assert.equal(layout.backgroundSize, "cover");
    assert.equal(layout.overlayCount, 1, "Sign In is the only overlay");
    assert.doesNotMatch(layout.text, /Welcome to|Compliance\. Contractors\. Projects\.|All in one place|Track Compliance|Manage Contractors|Keep Projects Moving|PEOPLE|PROJECTS|PROGRESS|BUILDING A SAFER TOMORROW/i);
    assert.ok(layout.card && layout.card.width <= width - 20, `Login card fits width at ${width}x${height}`);
    assert.ok(Math.abs((layout.card.left + layout.card.right) / 2 - width / 2) <= 1, `Login card stays centered at ${width}x${height}`);
    if (width === 2560 || width === 1366) {
      const cardStyle = await page.locator("main > section[aria-label='Account access']").evaluate((element) => {
        const style = getComputedStyle(element);
        const glass = getComputedStyle(element, "::before");
        return { background: style.backgroundColor, blur: style.backdropFilter, border: style.borderTopColor, opacity: style.opacity, shadow: style.boxShadow, glassBackground: glass.backgroundColor, glassBlur: glass.backdropFilter, glassMask: glass.maskImage, glassPointerEvents: glass.pointerEvents };
      });
      assert.equal(cardStyle.background, "rgba(0, 0, 0, 0)");
      assert.equal(cardStyle.blur, "none");
      assert.match(cardStyle.glassBackground, /rgba\(245,\s*249,\s*255,\s*0\.15\)/);
      assert.equal(cardStyle.glassBlur, "blur(10px)");
      assert.match(cardStyle.glassMask, /radial-gradient/);
      assert.equal(cardStyle.glassPointerEvents, "none");
      assert.equal(cardStyle.border, "rgba(0, 0, 0, 0)");
      assert.equal(cardStyle.shadow, "none");
      assert.equal(cardStyle.opacity, "1");
      assert.match(await page.locator("form label span").first().evaluate(element => getComputedStyle(element).backgroundColor), /0\.93\)/);
      assert.equal(await page.getByRole("button", { name: "Sign In" }).evaluate(element => getComputedStyle(element).backgroundColor), "rgb(20, 115, 238)");
      assert.match(await page.getByRole("link", { name: "Initial Setup" }).evaluate(element => getComputedStyle(element).backgroundColor), /0\.8\)/);
    }
    for (const control of [page.getByLabel("Email", { exact: true }), page.getByLabel("Password", { exact: true }), page.getByRole("button", { name: "Sign In", exact: true }), page.getByRole("link", { name: "Initial Setup" })]) {
      assert.ok(await control.isVisible(), `Login control hidden at ${width}x${height}`);
    }
    if (process.env.LOGIN_2560_SCREENSHOT && width === 2560) await page.screenshot({ path: process.env.LOGIN_2560_SCREENSHOT, fullPage: true });
    if (process.env.LOGIN_1366_SCREENSHOT && width === 1366) await page.screenshot({ path: process.env.LOGIN_1366_SCREENSHOT, fullPage: true });
  }
  for (const zoom of ["125%", "150%"]) {
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.evaluate((value) => { document.documentElement.style.zoom = value; }, zoom);
    const zoomLayout = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      content: document.documentElement.scrollWidth,
    }));
    assert.ok(zoomLayout.content <= zoomLayout.viewport, `Horizontal overflow at ${zoom} browser zoom`);
    assert.ok(await page.getByRole("button", { name: "Sign In", exact: true }).isVisible(), `Sign In hidden at ${zoom} browser zoom`);
    await page.evaluate(() => { document.documentElement.style.zoom = ""; });
  }

  signInSucceeds = true;
  await page.getByRole("button", { name: "Sign In", exact: true }).click();
  await page.waitForURL((url) => url.pathname === "/");
  const sessionStored = await page.evaluate(() => Object.keys(localStorage).some((key) => key.startsWith("sb-") && key.endsWith("-auth-token")));
  assert.ok(sessionStored, "Successful sign-in must persist its session");
  await page.waitForURL((url) => url.pathname === "/login", { timeout: 15000 });
  assert.ok(requests.some((item) => item.type === "session-check"), "Protected access must check the account session");
  console.log("Login UI regression passed: sign-in, session persistence, redirect, denied access, error handling, recovery, setup link and responsive layout.");
} finally {
  await context.close();
  await browser.close();
}
