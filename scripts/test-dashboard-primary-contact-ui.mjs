import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "../worker/nj-pwc/node_modules/playwright");
const app = process.env.TEST_APP_URL || "http://localhost:3000";
assert.ok(["localhost", "127.0.0.1"].includes(new URL(app).hostname), "Synthetic browser tests require localhost");
const origin = new URL(fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8")
  .match(/^NEXT_PUBLIC_SUPABASE_URL\s*=\s*["']?([^"'\r\n]+)/m)[1].trim()).origin;
const user = { id: "00000000-0000-0000-0000-000000000001", email: "fixture@example.invalid",
  aud: "authenticated", app_metadata: {}, user_metadata: {} };
const contacts = [
  { contractor_id: 17, contact_name: "Primary Example", email: "primary@example.invalid", business_phone: "201-555-0117",
    mobile_phone: "201-555-0999", is_active: true, is_primary_contact: true },
  { contractor_id: 18, contact_name: "Not Primary", email: "other@example.invalid", is_active: true, is_primary_contact: false },
  { contractor_id: 18, contact_name: "Inactive Primary", is_active: false, is_primary_contact: true },
  { contractor_id: 19, contact_name: "Mobile Primary", email: null, business_phone: null, mobile_phone: "201-555-0119",
    is_active: true, is_primary_contact: true },
];
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  await context.addInitScript(({ origin, user }) => localStorage.setItem(
    `sb-${new URL(origin).hostname.split(".")[0]}-auth-token`,
    JSON.stringify({ access_token: "synthetic-token", refresh_token: "synthetic-refresh", token_type: "bearer",
      expires_at: Math.floor(Date.now() / 1000) + 3600, user })), { origin, user });
  let contactReads = 0, contactFailure = false;
  await context.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin === new URL(app).origin) {
      if (url.pathname === "/api/auth/session") return route.fulfill({ json: {
        profile: { auth_user_id: user.id, name: "Synthetic", status: "Active", system_administrator: true },
        permissions: ["dashboard", "contractors", "followups", "imports"].map(module => ({ module, can_view: true })),
      } });
      if (url.pathname === "/api/dashboard/eligibility") return route.fulfill({ json: {
        contractors: [17, 18, 19].map(id => ({ contractor_id: id, company_name: `Company ${id}`, applicability: "applicable" })),
        requirements: [{ id: 1, compliance_name: "NJ PWC", requires_expiration: true }],
        known_type_ids: [1], statuses: [17, 18, 19].map(id => ({ contractor_id: id, compliance_type_id: 1,
          compliance_record_id: id, expiration_date: "2099-01-01", days_remaining: 9999,
          calculated_status: id === 18 ? "Expired" : "Active" })),
        overall_compliance: { population: 3, compliant: 0, nonCompliant: 3, expiringSoon: 0, needsReview: 0, rate: 0 },
      } });
      if (url.pathname === "/api/communications") return route.fulfill({ json: { messages: [], next_offset: null } });
      if (url.pathname.startsWith("/api/")) {
        assert.ok(request.method() === "GET" || url.pathname === "/api/admin/bootstrap");
        return route.fulfill({ json: {} });
      }
      return route.continue();
    }
    assert.equal(url.origin, origin);
    assert.ok(["GET", "HEAD"].includes(request.method()), "No live database mutations");
    if (url.pathname.startsWith("/auth/")) return route.fulfill({ json: user });
    const table = url.pathname.split("/").at(-1);
    if (table === "contractors" && request.method() === "HEAD") {
      return route.fulfill({ status: 200, headers: { "content-range": "*/3", "access-control-expose-headers": "content-range" } });
    }
    if (table === "contractor_contacts") {
      contactReads++;
      assert.equal(url.searchParams.get("is_active"), "eq.true");
      assert.equal(url.searchParams.get("is_primary_contact"), "eq.true");
      assert.equal(url.searchParams.get("contractor_id"), "in.(17,18,19)");
      assert.doesNotMatch(url.searchParams.get("select"), /sms/i);
      if (contactFailure) return route.fulfill({ status: 403, json: { message: "Synthetic primary read denied" } });
      return route.fulfill({ json: contacts.filter(contact => contact.is_active && contact.is_primary_contact) });
    }
    if (table === "contractor_compliance_status") return route.fulfill({ json: [17, 18, 19].map(id => ({
      contractor_id: id, company_name: `Company ${id}`, contractor_active: true, compliance_record_id: id,
      compliance_type_id: 1, compliance_name: "NJ PWC", registration_number: `${id}`,
      expiration_date: "2099-01-01", days_remaining: 9999, calculated_status: id === 18 ? "Expired" : "Active",
    })) });
    if (table === "contractor_projects") return route.fulfill({ json: [{
      id: 1, contractor_id: 17, active: true, projects: { project_number: "26-017", status: "Active", public_works: false },
    }] });
    return route.fulfill({ json: [], headers: { "content-range": "*/0" } });
  });
  const page = await context.newPage(), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error" && !(contactFailure && message.text().includes("403"))) errors.push(message.text());
  });
  await page.goto(app);
  await page.getByRole("button", { name: "Review Details →" }).click();
  await page.getByRole("button", { name: "Assigned contractors", exact: true }).click();
  const section = page.locator("section").filter({ has: page.getByRole("heading", { name: "Assigned Contractors", exact: true }) });
  const table = section.locator("table");
  await table.getByRole("cell", { name: /Primary Example/ }).waitFor();
  assert.deepEqual(await table.locator("th").allTextContents(), ["Contractor", "Primary Contact"]);
  const first = table.locator("tbody tr").filter({ hasText: "Company 17" });
  assert.match(await first.locator("td").nth(1).innerText(), /Primary Example[\s\S]*primary@example\.invalid[\s\S]*201-555-0117/);
  assert.equal(await table.locator("tbody tr").filter({ hasText: "Company 18" }).locator("td").nth(1).innerText(), "No Primary Contact");
  assert.match(await table.locator("tbody tr").filter({ hasText: "Company 19" }).locator("td").nth(1).innerText(), /201-555-0119/);
  assert.doesNotMatch(await table.innerText(), /SMS|Not Primary|Inactive Primary|Email Status|Next Action/);
  const geometry = await table.evaluate(element => ({
    width: element.getBoundingClientRect().width, parent: element.parentElement.clientWidth,
  }));
  assert.ok(Math.abs(geometry.width - geometry.parent) <= 1, "table fills available width");
  const cards = page.locator('section[aria-label="Dashboard overview"]');
  const counts = await cards.innerText();
  assert.match(counts, /Active Contractors\s*3\s*3 with active project assignments/);
  const readsBeforeSearch = contactReads;
  await page.getByLabel("Search contractors", { exact: true }).fill("Company 17");
  assert.equal(await table.locator("tbody tr").count(), 1);
  await page.getByLabel("Search contractors", { exact: true }).fill("");
  assert.equal(await table.locator("tbody tr").count(), 3);
  assert.equal(contactReads, readsBeforeSearch, "search changes reuse the batched contact read");
  assert.equal(await cards.innerText(), counts);
  if (process.env.TEST_SCREENSHOT) await section.screenshot({ path: process.env.TEST_SCREENSHOT });
  await page.getByText("No open follow-ups.", { exact: true }).waitFor();
  await page.setViewportSize({ width: 1000, height: 900 });
  assert.ok(await table.evaluate(element => element.parentElement.scrollWidth >= element.parentElement.clientWidth));
  await page.getByRole("button", { name: "Status filters and PWC Missing" }).click();
  await page.locator('section[aria-label="Dashboard filters"]').getByRole("button", { name: /PWC Missing/ }).click();
  await page.getByText("No PWC deficiencies found.").waitFor();
  assert.equal(await page.getByText(/Legacy status filters use their existing company-wide/).count(), 1);
  contactFailure = true;
  await page.reload();
  await page.getByRole("button", { name: "Review Details →" }).click();
  await page.getByRole("button", { name: "Assigned contractors", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "Synthetic primary read denied" }).waitFor();
  assert.equal(await table.getByText("No Primary Contact", { exact: true }).count(), 0, "read errors cannot masquerade as absent contacts");
  assert.equal(await table.getByText("Unavailable", { exact: true }).count(), 3);
  assert.equal(await cards.innerText(), counts, "contact failure does not alter compliance counts");
  assert.deepEqual(errors, []);
  console.log("PASS: active-primary contacts, absent/phone/error states, search, follow-ups and batched contact requests.");
  console.log(JSON.stringify(geometry));
} finally { await browser.close(); }
