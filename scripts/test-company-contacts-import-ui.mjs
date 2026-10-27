import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import * as XLSX from "xlsx";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const appUrl = process.env.TEST_APP_URL;
assert.ok(appUrl && new URL(appUrl).hostname === "localhost", "Intercepted localhost fixtures only");
const env = fs.readFileSync(".env.local", "utf8");
const origin = new URL(process.env.TEST_SUPABASE_URL || env.match(/^NEXT_PUBLIC_SUPABASE_URL\s*=\s*["']?([^"'\r\n]+)/m)[1].trim()).origin;
const storageKey = `sb-${new URL(origin).hostname.split(".")[0]}-auth-token`;
const user = { id: "00000000-0000-4000-8000-000000000001", email: "fixture@example.invalid", aud: "authenticated", app_metadata: {}, user_metadata: {} };
const contact = { id: "00000000-0000-4000-8000-000000000010", contact_name: "Existing Person", email: "person@example.org",
  mobile_phone: "201-555-0101", is_active: true, updated_at: "2026-10-27 12:00:00+00", version: "synthetic-contact-version" };
const book = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["Name", "Cell", "Email"]]), "Company Contacts");
const template = XLSX.write(book, { type: "buffer", bookType: "xlsx" });
let review = null, writes = 0, applied = 0, viewOnly = false, settingsView = true, stale = false, missing = false;
const errors = [];
const buildReview = () => ({
  batch: { id: "00000000-0000-4000-8000-000000000100", file_name: "Synthetic.xlsx", created_at: "2026-10-27T12:00:00Z",
    created_by: user.id, revision: 1, status: "Review", notices: ["Additional columns were ignored."], import_history_id: 1 },
  rows: [
    { id: "00000000-0000-4000-8000-000000000101", source_row: 2, original: { Name: "Existing Updated", Cell: "", Email: "PERSON@example.org" },
      normalized: { contact_name: "Existing Updated", mobile_phone: null, email: "PERSON@example.org" },
      status: "MATCHED", matching_keys: ["name:existing updated", "email:person@example.org"], issues: [], duplicate_rows: [], suggestions: [contact], exact_matches: [contact],
      resolution: null, contact_id: null, error: null, events: [], before_contact: null, after_contact: null },
    { id: "00000000-0000-4000-8000-000000000102", source_row: 3, original: { Name: "New Person", Cell: "", Email: "" },
      normalized: { contact_name: "New Person", mobile_phone: null, email: null }, status: "REVIEW", issues: [], duplicate_rows: [],
      matching_keys: ["name:new person"], suggestions: [], exact_matches: [], resolution: null, contact_id: null, error: null, events: [], before_contact: null, after_contact: null },
  ],
  contacts: [contact], summary: { total: 2, imported: 0, updated: 0, skipped: 0, errors: 0, unresolved: 2, ready: 0 },
});
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(({ storageKey, user }) => localStorage.setItem(storageKey, JSON.stringify({
    access_token: "fixture-token", refresh_token: "fixture-refresh", token_type: "bearer", expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600, user,
  })), { storageKey, user });
  await context.route("**/*", async (route) => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    if (url.origin !== new URL(appUrl).origin) {
      assert.equal(url.origin, origin, "No unexpected external requests");
      assert.ok(["GET", "HEAD"].includes(method), "No real database or external mutations");
      return route.fulfill({ json: url.pathname.startsWith("/auth/") ? user : [] });
    }
    if (url.pathname === "/api/auth/session") return route.fulfill({ json: {
      profile: { auth_user_id: user.id, name: "Synthetic", email: user.email, role: "Test", status: "Active", system_administrator: false },
      permissions: [
        { module: "imports", can_view: true, can_add: !viewOnly, can_edit: !viewOnly },
        { module: "settings", can_view: settingsView, can_manage: !viewOnly },
      ],
    } });
    if (url.pathname === "/api/admin/bootstrap") return route.fulfill({ json: {} });
    if (url.pathname === "/api/admin/dobco-contacts") {
      assert.equal(method, "GET", "Import never uses the manual contact API to write");
      return route.fulfill({ json: { contacts: review?.rows.filter((r) => r.after_contact).map((r) => ({
        ...r.after_contact, receives_internal_email: false, receives_internal_sms: false, sms_consent_recorded: false,
        sms_consent_date: null, sms_consent_source_or_note: null, user_profile_id: null,
        created_at: "2026-10-27T12:00:00Z",
      })) ?? [] } });
    }
    if (url.pathname === "/api/imports/company-contacts") {
      if (missing) return route.fulfill({ status: 503, json: { error: "Apply 20261120_company_contacts_import.sql manually." } });
      if (method === "GET") {
        if (url.searchParams.get("template") === "1") return route.fulfill({ body: template, headers: {
          "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": 'attachment; filename="Company Contacts Import Template.xlsx"',
        } });
        return route.fulfill({ json: url.searchParams.has("batch") ? review : { batches: review ? [review.batch] : [] } });
      }
      if (method === "POST") { review = buildReview(); return route.fulfill({ json: review }); }
      assert.equal(method, "PATCH");
      writes++;
      const body = request.postDataJSON();
      assert.equal(body.batch_id, review.batch.id);
      assert.equal(body.revision, review.batch.revision);
      if (stale) return route.fulfill({ status: 409, json: { error: "Contact changed; reload and review it again" } });
      if (body.operation === "apply") {
        applied++;
        for (const row of review.rows.filter((r) => r.resolution && r.status !== "SKIP")) {
          row.status = row.resolution.action === "UPDATE" ? "UPDATED" : "IMPORTED";
          row.contact_id = contact.id; row.after_contact = { ...contact, ...row.resolution.values };
        }
        review.summary = { total: 2, imported: 0, updated: 1, skipped: 1, errors: 0, unresolved: 0, ready: 0 };
        review.batch.status = "Complete";
      } else {
        const row = review.rows.find((r) => r.id === body.row_id);
        assert(row);
        if (body.action === "UNDO") { row.resolution = null; row.status = "REVIEW"; }
        else {
          row.resolution = { ...body, approved_at: "2026-10-27T12:01:00Z", approved_by: user.id };
          row.status = body.action === "SKIP" ? "SKIP" : row.status;
        }
        review.summary.ready = review.rows.filter((r) => r.resolution && r.status !== "SKIP").length;
        review.summary.skipped = review.rows.filter((r) => r.status === "SKIP").length;
        review.summary.unresolved = review.rows.filter((r) => !r.resolution).length;
      }
      review.batch.revision++;
      return route.fulfill({ json: review });
    }
    if (url.pathname.startsWith("/api/")) {
      assert.equal(method, "GET", "No unrelated API mutation");
      return route.fulfill({ json: {} });
    }
    if (url.origin === origin) return route.fulfill({ json: [] });
    assert.ok(["GET", "HEAD"].includes(method));
    return route.continue();
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${appUrl}/imports`);
  const panel = page.getByRole("region", { name: "Company Contacts import" });
  await panel.getByRole("button", { name: "Download Blank Template" }).waitFor();
  const downloading = page.waitForEvent("download");
  await panel.getByRole("button", { name: "Download Blank Template" }).click();
  assert.equal((await downloading).suggestedFilename(), "Company Contacts Import Template.xlsx");
  await panel.getByLabel("Company Contacts workbook").setInputFiles({ name: "Synthetic.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: template });
  await panel.getByRole("button", { name: "Import Company Contacts", exact: true }).click();
  await panel.getByText("Synthetic.xlsx · Review", { exact: true }).waitFor();
  const first = () => panel.locator("details").filter({ has: page.locator("summary", { hasText: "Row 2:" }) }).first();
  const expand = async () => { const row = first(); if (!(await row.getAttribute("open") !== null)) await row.locator("summary").first().click(); return row; };
  let row = await expand();
  assert.equal(await row.getByLabel("Existing contact for row 2").inputValue(), "");
  assert.equal(await row.getByRole("button", { name: "Update Existing Contact" }).isDisabled(), true);
  assert.equal(await panel.getByRole("button", { name: "Import Resolved Records" }).isDisabled(), true);
  await row.getByRole("button", { name: "Accept Match" }).click();
  assert.equal(await row.getByLabel("Existing contact for row 2").inputValue(), contact.id);
  assert.equal(await row.getByLabel("Proposed mobile_phone for row 2").inputValue(), contact.mobile_phone, "Blank phone preserves existing");
  assert.equal(await row.getByRole("button", { name: "Update Existing Contact" }).isDisabled(), true, "Explicit confirmation required");
  await row.getByLabel("I confirm the selected contact", { exact: false }).check();
  stale = true;
  await row.getByRole("button", { name: "Update Existing Contact" }).click();
  await panel.getByRole("alert").filter({ hasText: "Contact changed" }).waitFor();
  stale = false;
  await row.getByRole("button", { name: "Update Existing Contact" }).click();
  await panel.getByText("Decision saved.", { exact: false }).waitFor();
  row = await expand();
  await row.getByRole("button", { name: "Undo / Change Resolution" }).click();
  await panel.getByRole("button", { name: "Import Resolved Records" }).waitFor();
  row = await expand();
  assert.equal(await panel.getByRole("button", { name: "Import Resolved Records" }).isDisabled(), true);
  await row.getByRole("button", { name: "Accept Match" }).click();
  await row.getByLabel("I confirm the selected contact", { exact: false }).check();
  await row.getByRole("button", { name: "Update Existing Contact" }).click();
  await panel.getByText("Decision saved.", { exact: false }).waitFor();
  const second = panel.locator("details").filter({ has: page.locator("summary", { hasText: "Row 3:" }) }).first();
  await second.locator("summary").first().click();
  await second.getByRole("button", { name: "Skip", exact: true }).click();
  await panel.getByText("skipped:", { exact: false }).first().waitFor();
  page.once("dialog", (dialog) => dialog.dismiss());
  await panel.getByRole("button", { name: "Import Resolved Records" }).click();
  assert.equal(applied, 0);
  page.once("dialog", (dialog) => dialog.accept());
  await panel.getByRole("button", { name: "Import Resolved Records" }).click();
  await panel.getByText("Actual batch results:", { exact: false }).waitFor();
  assert.equal(applied, 1);
  assert.equal(await panel.getByRole("button", { name: "Import Resolved Records" }).isDisabled(), true);
  row = await expand();
  assert.equal(await row.getByRole("button", { name: "Update Existing Contact" }).count(), 0, "Applied rows are read-only");
  // The existing shell reserves 288px for its fixed sidebar and the page has 64px padding.
  // Exercise a 390px content area without changing that unrelated shell.
  for (const width of [1440, 742]) {
    await page.setViewportSize({ width, height: 1000 });
    const layout = await panel.evaluate((element) => {
      const buttons = [...element.querySelectorAll("button")].filter((b) => b.getBoundingClientRect().height);
      return {
        overflow: element.scrollWidth > element.clientWidth + 1,
        width: element.clientWidth,
        overflowing: [...element.querySelectorAll("*")].filter((e) => e.getBoundingClientRect().right > element.getBoundingClientRect().right)
          .slice(0, 6).map((e) => `${e.tagName}: ${e.textContent.slice(0, 80)}`),
        buttons: buttons.map((b) => ({ height: b.getBoundingClientRect().height, font: getComputedStyle(b).fontSize, outline: getComputedStyle(b).outlineStyle })),
      };
    });
    assert.equal(layout.overflow, false, `No horizontal overflow at ${width}px (panel ${layout.width}px): ${layout.overflowing.join("; ")}`);
    assert.ok(layout.buttons.every((b) => b.height >= 28 && b.height <= 36 && b.font === "12px"), `Compact usable controls at ${width}px`);
    const button = panel.getByRole("button", { name: "Download Blank Template" });
    await button.focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    assert.equal(await button.evaluate((b) => getComputedStyle(b).outlineStyle), "solid");
  }
  await page.goto(`${appUrl}/settings`);
  await page.getByRole("tab", { name: "DOBCO CONTACTS", exact: true }).click();
  await page.getByRole("tabpanel").getByText("Existing Updated", { exact: true }).waitFor();
  await page.goto(`${appUrl}/imports`);
  await panel.getByRole("button", { name: "Download Blank Template" }).waitFor();
  viewOnly = true;
  await page.reload();
  await panel.getByRole("button", { name: "Download Blank Template" }).waitFor();
  assert.equal(await panel.getByRole("button", { name: "Import Company Contacts", exact: true }).count(), 0);
  assert.equal(await panel.getByRole("button", { name: "Import Resolved Records" }).count(), 0);
  missing = true; viewOnly = false;
  await page.reload();
  await panel.getByRole("alert").filter({ hasText: "20261120_company_contacts_import.sql" }).waitFor();
  missing = false; settingsView = false;
  await page.reload();
  await page.getByRole("heading", { name: "Import / Export", exact: true }).waitFor();
  assert.equal(await panel.count(), 0, "Import/Communications view alone cannot reveal Company Contacts import");
  assert.ok(writes >= 4);
  assert.deepEqual(errors, []);
  console.log("PASS: synthetic localhost upload/template, explicit selection+confirmation, stale errors, undo/skip, apply confirmation, terminal read-only rows, permission gates, desktop/390px content layout and visible focus. All API/data requests intercepted.");
} finally { await browser.close(); }
