import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const appUrl = process.env.TEST_APP_URL;
assert.ok(appUrl && new URL(appUrl).hostname === "localhost", "Use an intercepted localhost preview only");
const env = fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const origin = new URL(env.match(/^NEXT_PUBLIC_SUPABASE_URL\s*=\s*["']?([^"'\r\n]+)/m)[1].trim()).origin;
const storageKey = `sb-${new URL(origin).hostname.split(".")[0]}-auth-token`;
const id = "00000000-0000-0000-0000-000000000001";
const user = { id, email: "synthetic@example.invalid", aud: "authenticated", app_metadata: {}, user_metadata: {} };
let grants = [], failTimeline = false, timelineReads = 0, contentReads = 0, deliveryReads = 0;
const queries = [], errors = [];
const contractors = [{ id: 1, company_name: "Synthetic One" }, { id: 2, company_name: "Synthetic Two" }];
const allowed = (module) => grants.includes(module);
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
try {
  await context.addInitScript(({ storageKey, user }) => localStorage.setItem(storageKey, JSON.stringify({
    access_token: "synthetic-token", refresh_token: "synthetic-refresh", token_type: "bearer",
    expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user,
  })), { storageKey, user });
  await context.route("**/*", async (route) => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== new URL(appUrl).origin) {
      assert.equal(url.origin, origin, "No ACS, Twilio or unexpected external request");
      assert.ok(["GET", "HEAD"].includes(request.method()), "No external mutations");
      assert.ok(url.pathname.startsWith("/auth/"), "No direct browser database calls");
      return route.fulfill({ json: user });
    }
    if (url.pathname === "/api/admin/bootstrap") return route.fulfill({ json: {} });
    assert.ok(["GET", "HEAD"].includes(request.method()), "Timeline is entirely read only");
    if (url.pathname === "/api/auth/session") return route.fulfill({ json: {
      profile: { auth_user_id: id, name: "Synthetic Actor", email: user.email, role: "Synthetic", status: "Active", system_administrator: false },
      permissions: grants.map((entry) => ({ module: entry, can_view: true, can_manage: false, can_add: false, can_edit: false, can_delete: false })),
    } });
    if (url.pathname === "/api/activity-log/contractors") {
      assert.ok(allowed("activity"));
      queries.push(Object.fromEntries(url.searchParams));
      const search = url.searchParams.get("search") ?? "";
      const offset = Number(url.searchParams.get("offset") ?? 0);
      return route.fulfill({ json: {
        contractors: search ? contractors.filter((c) => c.company_name.includes(search)) : offset === 0 ? [contractors[0]] : [contractors[1]],
        next_offset: !search && offset === 0 ? 50 : null,
      } });
    }
    if (url.pathname === "/api/activity-log") {
      assert.ok(allowed("activity"));
      const contractorId = Number(url.searchParams.get("contractor_id"));
      assert.ok([1, 2].includes(contractorId), "Every timeline request is contractor scoped");
      timelineReads++;
      queries.push(Object.fromEntries(url.searchParams));
      if (failTimeline) return route.fulfill({ status: 500, json: { error: "Synthetic timeline unavailable" } });
      const older = Number(url.searchParams.get("activity") ?? 0) > 0;
      const entries = [{
        source: "activity", date: older ? "2026-10-16T00:00:00.000Z" : "2026-10-17T00:00:00.000Z", created_at: "2026-10-17T09:00:00Z",
        record: { id: older ? 2 : 1, contractor_id: contractorId, activity_type: older ? "Older Activity" : `Activity for ${contractorId}`, notes: "Existing operational notes", created_by: "Synthetic Actor" },
      }];
      if (!older && allowed("followups")) entries.unshift({
        source: "followup", date: "2026-10-18T00:00:00.000Z", created_at: "2026-10-18T09:00:00Z",
        record: { id: 10, contractor_id: contractorId, followup_date: "2026-10-18", followup_method: "Email", subject: `Existing Follow-Up for ${contractorId}`, status: "Open", related_item: "General Liability" },
      });
      if (!older && allowed("communications_summary")) entries.unshift({
        source: "communication", date: "2026-10-18T14:00:00Z", created_at: "2026-10-18T14:00:00Z",
        record: { id, channel: "email", direction: "outbound", source: "manual", status: "Draft", created_at: "2026-10-18T14:00:00Z", recipient_count: 2,
          description: `Manual email for ${contractorId}`, contractors: [{ contractor_id: contractorId, contractors: { company_name: contractors[contractorId - 1].company_name } }],
          projects: [{ project_id: 1, projects: { project_number: "10001", project_name: "Synthetic Project" } }] },
      });
      return route.fulfill({ json: {
        contractor: contractors[contractorId - 1], entries, next: older ? null : { activity: 1, followup: allowed("followups") ? 1 : 0, communication: allowed("communications_summary") ? 1 : 0 },
        sources: { activity: true, followups: allowed("followups"), communications: allowed("communications_summary") },
      } });
    }
    if (url.pathname === `/api/communications/${id}`) {
      assert.ok(allowed("communications_content")); contentReads++;
      return route.fulfill({ json: { communication: {
        id, status: "Draft", subject: "Restricted subject", body: "Exact full content", sender_name: "Sender", sender_address: "sender@example.invalid",
        communication_recipients: [{ recipient_name: "Snapshot Recipient", email: "recipient@example.invalid", mobile_phone: null }],
      } } });
    }
    if (url.pathname === `/api/communications/${id}/delivery`) {
      assert.ok(allowed("communications_delivery")); deliveryReads++;
      return route.fulfill({ json: { delivery: {
        id, status: "Draft", provider: "Synthetic Provider", provider_message_id: null, failure_reason: null,
        queued_at: null, sent_at: null, delivered_at: null, failed_at: null, cancelled_at: null, communication_recipients: [],
      } } });
    }
    assert.ok(!url.pathname.startsWith("/api/"), `Unexpected API ${url.pathname}`);
    return route.continue();
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  const timeline = page.getByRole("list", { name: "Contractor timeline", exact: true });
  const load = async (...modules) => {
    grants = modules;
    await page.goto(`${appUrl}/activity-log`);
    await page.getByLabel("Contractor", { exact: true }).selectOption("1");
    await timeline.waitFor();
  };
  await load("activity");
  assert.equal(await timeline.locator("li").count(), 1);
  await timeline.getByText("Activity for 1", { exact: true }).waitFor();
  assert.equal(await timeline.getByText("Existing Follow-Up for 1", { exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "View Details", exact: true }).count(), 0);
  assert.equal(contentReads + deliveryReads, 0);
  await load("activity", "followups");
  assert.equal(await timeline.locator("li").count(), 2);
  await timeline.getByText("Existing Follow-Up for 1", { exact: true }).waitFor();
  assert.match(await timeline.innerText(), /Method: Email \| Status: Open/);
  assert.match(await timeline.innerText(), /not proof of a message sent/);
  await load("activity", "followups", "communications_summary", "contractors");
  assert.equal(await timeline.locator("li").count(), 3);
  assert.match(await timeline.locator("li").nth(0).innerText(), /Manual email for 1/);
  assert.match(await timeline.locator("li").nth(1).innerText(), /Existing Follow-Up for 1/);
  assert.match(await timeline.locator("li").nth(2).innerText(), /Activity for 1/);
  assert.equal(await page.getByRole("link", { name: "Open Contractor Card", exact: true }).getAttribute("href"), "/contractors/1");
  assert.equal(await page.getByRole("button", { name: "View Details", exact: true }).count(), 0);
  assert.equal(await page.getByText("Exact full content", { exact: true }).count(), 0);
  await page.getByRole("button", { name: "Load Older Entries", exact: true }).click();
  await timeline.getByText("Older Activity", { exact: true }).waitFor();
  assert.equal(await timeline.locator("li").count(), 4);
  assert.equal(await page.getByRole("button", { name: "Load Older Entries", exact: true }).count(), 0);
  await page.getByLabel("Find Contractor", { exact: true }).fill("Two");
  await page.getByLabel("Contractor", { exact: true }).selectOption("2");
  await timeline.getByText("Activity for 2", { exact: true }).waitFor();
  assert.equal(await timeline.getByText("Existing Follow-Up for 1", { exact: true }).count(), 0);
  await load("activity", "communications_summary", "communications_content");
  await page.getByRole("button", { name: "View Details", exact: true }).click();
  await page.getByText("Exact full content", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Delivery Details", exact: true }).count(), 0);
  await page.getByRole("button", { name: "More Contractors", exact: true }).click();
  await page.getByLabel("Contractor", { exact: true }).selectOption("2");
  await timeline.getByText("Activity for 2", { exact: true }).waitFor();
  assert.equal(await page.getByText("Exact full content", { exact: true }).count(), 0, "Changing contractors clears details");
  await load("activity", "communications_summary", "communications_delivery");
  await page.getByRole("button", { name: "Delivery Details", exact: true }).click();
  await page.getByText("Provider: Synthetic Provider", { exact: true }).waitFor();
  assert.equal(await page.getByText("Exact full content", { exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "View Details", exact: true }).count(), 0);
  await page.getByRole("button", { name: "Close Details", exact: true }).click();
  assert.equal(await page.getByRole("region", { name: "Communication details", exact: true }).count(), 0);
  failTimeline = true;
  grants = ["activity"];
  await page.goto(`${appUrl}/activity-log`);
  await page.getByLabel("Contractor", { exact: true }).selectOption("1");
  await page.getByText("Synthetic timeline unavailable", { exact: true }).waitFor();
  failTimeline = false;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await timeline.getByText("Activity for 1", { exact: true }).waitFor();
  grants = ["contractors", "communications_summary"];
  const readsBefore = timelineReads;
  await page.goto(`${appUrl}/activity-log`);
  await page.getByRole("heading", { name: "Access Denied", exact: true }).waitFor();
  assert.equal(timelineReads, readsBefore);
  assert.equal(contentReads, 1); assert.equal(deliveryReads, 1);
  assert.ok(queries.some((q) => q.search === "Two"));
  assert.ok(queries.some((q) => q.activity === "1"));
  assert.deepEqual(errors, []);
  console.log("PASS: read-only contractor selector/search/paging, chronological Activity/Follow-Up/Communication timeline, independent sources and details, contractor switching, older entries, explicit errors/retry and activity route guard. No live writes or provider calls.");
} finally {
  await context.close(); await browser.close();
}
