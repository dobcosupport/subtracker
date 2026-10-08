import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appUrl = process.env.TEST_APP_URL;
assert.ok(appUrl && new URL(appUrl).hostname === "localhost", "Use an isolated localhost production preview");
const env = fs.readFileSync(path.join(root, ".env.local"), "utf8");
const origin = new URL(env.match(/^NEXT_PUBLIC_SUPABASE_URL\s*=\s*["']?([^"'\r\n]+)/m)[1].trim()).origin;
const storageKey = `sb-${new URL(origin).hostname.split(".")[0]}-auth-token`;
const user = { id: "00000000-0000-0000-0000-000000000001", email: "synthetic@example.invalid", aud: "authenticated", app_metadata: {}, user_metadata: {} };
const types = ["NJ PWC", "NJ BRC", "NY PWC", "NY BRC", "W9", "Safety Certification"].map((compliance_name, index) => ({ id: index + 1, compliance_name, active: true, requires_expiration: !compliance_name.endsWith("BRC") }));
const record = (id, type, active, registration_number) => ({
  id, contractor_id: 1, compliance_type_id: type, registration_number, active, is_current: active,
  expiration_date: type === 2 ? null : "2026-12-31", effective_date: null,
  compliance_types: { compliance_name: types[type - 1].compliance_name, requires_expiration: types[type - 1].requires_expiration },
});
const tables = {
  contractors: [{ id: 1, company_name: "SYNTHETIC Related Item Contractor", active: true }],
  compliance_types: types,
  compliance_records: [record(100, 1, false, "67890"), record(101, 1, true, "12345"), record(102, 1, true, "54321"), record(200, 2, true, "ABC123456")],
  contractor_followups: [{
    id: 5, contractor_id: 1, compliance_type_id: null, insurance_item_key: null, compliance_record_id: 100,
    followup_date: "2026-10-08", followup_method: "Email", subject: "SYNTHETIC legacy", notes: null,
    status: "Open", created_at: "2026-10-08T12:00:00Z", updated_at: "2026-10-08T12:00:00Z",
  }],
};
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
const writes = [];
let failSave = false;
let nextId = 6;
try {
  await context.addInitScript(({ storageKey, user }) => localStorage.setItem(storageKey, JSON.stringify({
    access_token: "synthetic-token", refresh_token: "synthetic-refresh", token_type: "bearer",
    expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user,
  })), { storageKey, user });
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === new URL(appUrl).origin) {
      if (url.pathname.startsWith("/api/")) return route.fulfill({ json: {
        profile: { auth_user_id: user.id, name: "SYNTHETIC", email: user.email, role: "Administrator", status: "Active", system_administrator: true },
        permissions: ["dashboard", "imports", "contractors", "compliance", "insurance", "projects", "followups"].map((module) => ({ module, can_view: true, can_manage: true, can_add: true, can_edit: true, can_delete: true })),
      } });
      return route.continue();
    }
    assert.equal(url.origin, origin, "Unexpected external request blocked");
    if (url.pathname.startsWith("/auth/")) return route.fulfill({ json: user });
    const table = url.pathname.split("/").at(-1);
    if (["POST", "PATCH"].includes(request.method())) {
      assert.equal(table, "contractor_followups", "All writes are synthetic follow-ups only");
      if (failSave) return route.fulfill({ status: 403, json: { message: "SYNTHETIC save denied" } });
      const payload = request.postDataJSON();
      writes.push(payload);
      let saved;
      if (request.method() === "POST") {
        saved = { id: nextId++, created_at: "2026-10-08T12:00:00Z", updated_at: "2026-10-08T12:00:00Z", ...payload };
        tables.contractor_followups.push(saved);
      } else {
        saved = tables.contractor_followups.find((row) => `eq.${row.id}` === url.searchParams.get("id"));
        assert.ok(saved, "Update uses actual follow-up ID");
        Object.assign(saved, payload);
      }
      return route.fulfill({ json: request.method() === "POST" ? [saved] : null, headers: { "content-range": "0-0/1" } });
    }
    assert.ok(["GET", "HEAD"].includes(request.method()), "Unexpected mutation blocked");
    let rows = tables[table] ?? [];
    for (const [key, value] of url.searchParams) {
      if (value.startsWith("eq.")) rows = rows.filter((row) => String(row[key]) === value.slice(3));
      if (value.startsWith("neq.")) rows = rows.filter((row) => String(row[key]) !== value.slice(4));
      if (value.startsWith("in.(")) rows = rows.filter((row) => value.slice(4, -1).split(",").includes(String(row[key])));
    }
    if (table === "contractor_followups") rows = rows.map((row) => ({ ...row, related_type: row.compliance_type_id ? { compliance_name: types.find((type) => type.id === row.compliance_type_id)?.compliance_name } : null }));
    return route.fulfill({ json: (request.headers().accept ?? "").includes("vnd.pgrst.object") ? rows[0] ?? null : rows });
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${appUrl}/contractors/1`);
  const active = page.getByRole("region", { name: /Active Follow-Ups/ });
  const related = page.getByRole("combobox", { name: "Related Item", exact: true });
  const specific = page.getByRole("combobox", { name: "Specific Compliance Record (Optional)", exact: true });
  const editor = page.getByRole("heading", { name: /^(Edit|Add) Follow-Up$/ });
  const save = async (editing = true) => {
    await page.getByRole("button", { name: editing ? "Save Changes" : "Save Follow-Up", exact: true }).click();
    await editor.waitFor({ state: "hidden" });
  };
  const open = async (subject) => {
    await active.getByRole("button").filter({ hasText: subject }).click();
    await editor.waitFor();
  };
  await active.getByRole("button").focus();
  await page.keyboard.press("Enter");
  assert.equal(await related.inputValue(), "compliance:1");
  assert.equal(await specific.inputValue(), "100");
  assert.match(await specific.locator("option:checked").textContent(), /67890 \(Historical\)/);
  assert.match(await specific.locator('option[value="101"]').textContent(), /NJ PWC - 12345 - Expires 12\/31\/2026/);
  assert.equal(await specific.locator('option[value="200"]').count(), 0);
  for (const id of ["101", "102", "100"]) {
    await specific.selectOption(id);
    await save();
    await open("SYNTHETIC legacy");
    assert.equal(await specific.inputValue(), id);
  }
  page.once("dialog", (dialog) => dialog.dismiss());
  await related.selectOption("compliance:2");
  assert.equal(await related.inputValue(), "compliance:1");
  assert.equal(await specific.inputValue(), "100");
  page.once("dialog", (dialog) => dialog.accept());
  await related.selectOption("compliance:2");
  assert.equal(await specific.inputValue(), "");
  assert.equal(await specific.locator('option[value="100"]').count(), 0);
  assert.equal(await specific.locator("optgroup").count(), 1, "Empty Historical group is hidden");
  await save();
  await open("SYNTHETIC legacy");
  assert.equal(await related.inputValue(), "compliance:2");
  await related.selectOption("compliance:1");
  await specific.selectOption("101");
  await save();
  await open("SYNTHETIC legacy");
  await specific.selectOption("");
  await save();
  await open("SYNTHETIC legacy");
  assert.equal(await related.inputValue(), "compliance:1");
  assert.equal(await specific.inputValue(), "");
  await specific.selectOption("100");
  await save();
  await open("SYNTHETIC legacy");
  page.once("dialog", (dialog) => dialog.accept());
  await related.selectOption("");
  assert.equal(tables.contractor_followups[0].compliance_record_id, 100, "General does not clear DB before save");
  await save();
  assert.equal(tables.contractor_followups[0].compliance_record_id, null);
  assert.equal(tables.contractor_followups[0].compliance_type_id, null);
  assert.equal(tables.contractor_followups[0].insurance_item_key, null);
  await open("SYNTHETIC legacy");
  assert.equal(await related.inputValue(), "");
  await page.getByRole("combobox", { name: "Status", exact: true }).selectOption("Closed");
  await save();
  const categories = [
    ["", "General Follow-Up"],
    ...types.map((type) => [`compliance:${type.id}`, type.compliance_name]),
    ["insurance:certificate_of_insurance", "Certificate of Insurance"],
    ["insurance:general_liability", "General Liability"],
    ["insurance:workers_compensation", "Workers Compensation"],
  ];
  for (const [value, label] of categories) {
    const subject = `SYNTHETIC category ${label}`;
    await page.getByRole("button", { name: "Add Follow-Up", exact: true }).click();
    await related.selectOption(value);
    assert.equal(await specific.count(), value.startsWith("compliance:") ? 1 : 0);
    if (value === "compliance:3") assert.equal(await specific.locator("optgroup").count(), 0);
    await page.getByRole("textbox", { name: "Subject", exact: true }).fill(subject);
    await save(false);
    await active.getByRole("button").filter({ hasText: subject }).getByText(`Related Item: ${label}`, { exact: true }).waitFor();
    await page.reload();
    await open(subject);
    assert.equal(await related.inputValue(), value);
    assert.equal(writes.at(-1).compliance_record_id, null);
    if (value.startsWith("insurance:")) assert.equal(writes.at(-1).compliance_type_id, null);
    for (const status of ["Waiting Response", "Open", "Resolved"]) {
      await page.getByRole("combobox", { name: "Status", exact: true }).selectOption(status);
      await save();
      assert.equal(await active.getByRole("button").filter({ hasText: subject }).count(), status === "Resolved" ? 0 : 1);
      if (status !== "Resolved") await open(subject);
    }
    await page.getByRole("button", { name: "Company History", exact: true }).click();
    await page.getByRole("button", { name: "Compliance Follow-Up History", exact: true }).click();
    const historyRow = page.getByRole("row").filter({ hasText: subject });
    await historyRow.getByRole("cell", { name: label, exact: true }).waitFor();
    await historyRow.getByRole("button", { name: "Edit", exact: true }).click();
    assert.equal(await related.inputValue(), value);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
  }
  await page.getByRole("button", { name: "Add Follow-Up", exact: true }).click();
  await related.selectOption("insurance:general_liability");
  await page.getByRole("textbox", { name: "Subject", exact: true }).fill("SYNTHETIC failed save");
  failSave = true;
  await page.getByRole("button", { name: "Save Follow-Up", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "SYNTHETIC save denied" }).waitFor();
  assert.equal(await related.inputValue(), "insurance:general_liability");
  assert.equal(await editor.isVisible(), true);
  assert.deepEqual(errors, []);
  console.log("PASS: isolated production browser creates/reopens General, six compliance categories without records, and three insurance categories");
  console.log("PASS: legacy/historical links, matching-record switching, No specific record, General clearing after save, confirm/cancel, Active and History, failed saves; all network writes intercepted");
} finally {
  await context.close();
  await browser.close();
}
