import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = process.env.PLAYWRIGHT_MODULE
  ? require(process.env.PLAYWRIGHT_MODULE)
  : createRequire(new URL("../worker/nj-pwc/package.json", import.meta.url))("playwright");
const appUrl = process.env.TEST_APP_URL;
assert.equal(new URL(appUrl).hostname, "localhost");
const env = fs.readFileSync(".env.local", "utf8");
const origin = new URL(env.match(/^NEXT_PUBLIC_SUPABASE_URL\s*=\s*["']?([^"'\r\n]+)/m)[1].trim()).origin;
const storageKey = `sb-${new URL(origin).hostname.split(".")[0]}-auth-token`;
const user = { id: "00000000-0000-0000-0000-000000000001", email: "synthetic@example.invalid", aud: "authenticated", app_metadata: {}, user_metadata: {} };
const contractor = { id: 1, company_name: "LBJ Interior Solutions LLC", dba_name: "LBJ Flooring LLC", county: "Mercer County", active: true, trade: null, contact_name: null, email: null, phone: null, notes: null,
  nj_brc_number: "0001234567", federal_tax_id: "01-2345678", brc_name_control: "SYNT", brc_name_control_is_manual: true };
const writes = [];
async function verifyIdentifierLayout(page) {
  const rows = [["NJ PWC #", "NY PWC #"], ["NJ BRC #", "NY BRC #"], ["BRC Name Control", "Taxpayer ID (FEIN)", "Sage ERP ID"]];
  for (const labels of rows) {
    for (const label of labels) {
      const input = page.getByLabel(label, { exact: true });
      const parent = input.locator("..");
      const caption = parent.locator("span");
      assert.equal(await caption.innerText(), label);
      await input.scrollIntoViewIfNeeded();
      const positions = await parent.evaluate(element => {
        const input = element.querySelector("input").getBoundingClientRect();
        const caption = element.querySelector("span").getBoundingClientRect();
        return { inputTop: input.top, captionBottom: caption.bottom };
      });
      assert.ok(positions.captionBottom <= positions.inputTop, `${label}: label must be above input`);
    }
    const inputs = labels.map(label => page.getByLabel(label, { exact: true }));
    const finalBoxes = await Promise.all(inputs.map(input => input.boundingBox()));
    assert.ok(finalBoxes[1].x > finalBoxes[0].x);
    assert.ok(Math.abs(finalBoxes[0].y - finalBoxes[1].y) < 2);
    if (finalBoxes.length === 3) assert.ok(finalBoxes[2].x > finalBoxes[1].x);
  }
}
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1366, height: 1000 } });
  await context.addInitScript(({ storageKey, user }) => localStorage.setItem(storageKey, JSON.stringify({
    access_token: "synthetic-token", refresh_token: "synthetic-refresh", token_type: "bearer",
    expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user,
  })), { storageKey, user });
  await context.route("**/*", async (route) => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin === new URL(appUrl).origin) {
      if (url.pathname === "/api/contractors" && request.method() === "POST") {
        writes.push(request.postDataJSON().contractor);
        return route.fulfill({ status: 201, json: { data: [{ id: 2, ...writes.at(-1) }] } });
      }
      if (url.pathname.startsWith("/api/")) return route.fulfill({ json: {
        profile: { auth_user_id: user.id, name: "Synthetic", email: user.email, role: "Administrator", status: "Active", system_administrator: true },
        permissions: ["contractors", "compliance", "insurance", "projects", "followups", "imports", "compliance_sync"].map((module) => ({ module, can_view: true, can_manage: true, can_add: true, can_edit: true, can_delete: true })),
      } });
      return route.continue();
    }
    assert.equal(url.origin, origin, "Unexpected external request");
    if (url.pathname.startsWith("/auth/")) return route.fulfill({ json: user });
    const table = url.pathname.split("/").at(-1);
    if (table === "contractors") {
      if (request.method() === "PATCH") {
        const payload = request.postDataJSON();
        writes.push(payload);
        Object.assign(contractor, payload);
        return route.fulfill({ status: 204, body: "" });
      }
      assert.equal(request.method(), "GET");
      return route.fulfill({ json: request.headers().accept?.includes("object") ? contractor : [contractor] });
    }
    assert.ok(["GET", "HEAD"].includes(request.method()), "Unexpected database write blocked");
    return route.fulfill({ json: [] });
  });
  const page = await context.newPage();
  await page.goto(`${appUrl}/contractors`);
  await page.getByRole("button", { name: "Add Contractor", exact: true }).click();
  await verifyIdentifierLayout(page);
  await page.getByLabel("Company Name", { exact: true }).fill("New Synthetic FEIN");
  await page.getByLabel("DBA", { exact: true }).fill("New Synthetic DBA");
  await page.getByLabel("County", { exact: true }).fill("New Synthetic County");
  await page.getByLabel("NJ BRC #", { exact: true }).fill("0007654321");
  await page.getByLabel("Taxpayer ID (FEIN)", { exact: true }).fill("02-3456789");
  await page.getByLabel("BRC Name Control", { exact: true }).fill("NEWS");
  await page.getByRole("button", { name: "Save Contractor", exact: true }).click();
  await page.getByRole("heading", { name: "Add Contractor", exact: true }).waitFor({ state: "hidden" });
  assert.equal(writes[0].federal_tax_id, "02-3456789");
  assert.equal(writes[0].dba_name, "New Synthetic DBA");
  assert.equal(writes[0].county, "New Synthetic County");
  assert.equal(writes[0].nj_brc_number, "0007654321");
  assert.equal(writes[0].brc_name_control, "NEWS");
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  assert.equal(await page.getByLabel("Taxpayer ID (FEIN)", { exact: true }).inputValue(), "01-2345678");
  await page.getByLabel("Taxpayer ID (FEIN)", { exact: true }).fill("03-4567890");
  await page.getByRole("button", { name: "Save Contractor", exact: true }).click();
  await page.getByRole("heading", { name: "Edit Contractor", exact: true }).waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  assert.equal(await page.getByLabel("Taxpayer ID (FEIN)", { exact: true }).inputValue(), "03-4567890");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByPlaceholder("Search contractors", { exact: true }).fill("LBJ Flooring LLC");
  const searchResult = page.locator("tbody tr");
  await searchResult.first().waitFor();
  assert.equal(await searchResult.count(), 1, "search by DBA returns one legal contractor record");
  assert.match(await searchResult.first().innerText(), /LBJ Interior Solutions LLC[\s\S]*DBA: LBJ Flooring LLC/);
  await page.goto(`${appUrl}/contractors/1`);
  await page.getByRole("heading", { name: contractor.company_name, exact: true }).waitFor();
  await page.getByText("LBJ Flooring LLC", { exact: true }).waitFor();
  await page.getByText("Mercer County", { exact: true }).waitFor();
  await page.getByText("03-4567890", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Edit Contractor", exact: true }).click();
  await verifyIdentifierLayout(page);
  assert.equal(await page.getByLabel("DBA", { exact: true }).inputValue(), "LBJ Flooring LLC");
  assert.equal(await page.getByLabel("County", { exact: true }).inputValue(), "Mercer County");
  await page.getByLabel("DBA", { exact: true }).fill("Updated Flooring LLC");
  await page.getByLabel("County", { exact: true }).fill("Hudson County");
  assert.equal(await page.getByLabel("Taxpayer ID (FEIN)", { exact: true }).inputValue(), "03-4567890");
  await page.getByLabel("Taxpayer ID (FEIN)", { exact: true }).fill("");
  await page.getByRole("button", { name: "Save Changes", exact: true }).click();
  await page.getByRole("heading", { name: "Edit Contractor", exact: true }).waitFor({ state: "hidden" });
  assert.equal(contractor.dba_name, "Updated Flooring LLC");
  assert.equal(contractor.county, "Hudson County");
  await page.getByRole("button", { name: "Edit Contractor", exact: true }).click();
  assert.equal(await page.getByLabel("DBA", { exact: true }).inputValue(), "Updated Flooring LLC");
  assert.equal(await page.getByLabel("County", { exact: true }).inputValue(), "Hudson County");
  await page.getByLabel("DBA", { exact: true }).fill("   ");
  await page.getByLabel("County", { exact: true }).fill("   ");
  await page.getByRole("button", { name: "Save Changes", exact: true }).click();
  await page.getByRole("heading", { name: "Edit Contractor", exact: true }).waitFor({ state: "hidden" });
  assert.equal(contractor.dba_name, null);
  assert.equal(contractor.county, null);
  await page.getByRole("button", { name: "Edit Contractor", exact: true }).click();
  assert.equal(await page.getByLabel("DBA", { exact: true }).inputValue(), "");
  assert.equal(await page.getByLabel("County", { exact: true }).inputValue(), "");
  assert.equal(await page.getByLabel("Taxpayer ID (FEIN)", { exact: true }).inputValue(), "");
  assert.equal(contractor.federal_tax_id, null);
  assert.equal(contractor.nj_brc_number, "0001234567");
  assert.equal(contractor.brc_name_control, "SYNT");
  console.log("PASS: mocked DBA/County create, DBA search, detail display, edit and clear; FEIN remains independent; no live writes");
} finally { await browser.close(); }
