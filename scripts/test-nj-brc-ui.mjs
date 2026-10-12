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
const contractor = { id: 1, company_name: "Synthetic BRC Contractor", active: true, nj_brc_number: "0001234567", brc_name_control: "SYNT" };
const queued = { id: "00000000-0000-0000-0000-000000000010", contractor_id: 1, company_name: contractor.company_name, nj_brc_number: contractor.nj_brc_number,
  brc_name_control: "SYNT", federal_tax_id_masked: "**-***6789", taxpayer_id_submission_masked: "*****6789***",
  created_at: "2026-10-09T20:00:00Z", status: "human_verification_required",
  result_evidence: { taxpayer_name: "Synthetic BRC Contractor", certificate_number: "7654321",
    effective_date: "2009-09-09", date_of_issuance: "2026-10-09", source_url: "https://www1.state.nj.us/TYTR_BRC/servlet/common/BRCLogin",
    verified_at: "2026-10-09T20:00:00Z", match_rationale: "Exact normalized name", discrepancy_warnings: [] } };
const posts = [];
let failure = false;
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1366, height: 1000 } });
  await context.addInitScript(({ storageKey, user }) => localStorage.setItem(storageKey, JSON.stringify({
    access_token: "synthetic-token", refresh_token: "synthetic-refresh", token_type: "bearer",
    expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user,
  })), { storageKey, user });
  await context.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin === new URL(appUrl).origin) {
      if (url.pathname === "/api/contractors/nj-brc-search") {
        if (failure) return route.fulfill({ status: 503, json: { error: "Synthetic NJ BRC Worker Offline" } });
        if (request.method() === "POST") posts.push(request.postDataJSON());
        return route.fulfill({ json: { request: queued } });
      }
      if (url.pathname.startsWith("/api/")) return route.fulfill({ json: {
        profile: { auth_user_id: user.id, name: "Synthetic", email: user.email, role: "Administrator", status: "Active", system_administrator: true },
        permissions: ["contractors", "compliance", "insurance", "projects", "followups", "imports", "compliance_sync"].map(module => ({ module, can_view: true, can_manage: true, can_add: true, can_edit: true, can_delete: true })),
      } });
      return route.continue();
    }
    assert.equal(url.origin, origin);
    if (url.pathname.startsWith("/auth/")) return route.fulfill({ json: user });
    assert.equal(request.method(), "GET", "Unexpected database write blocked");
    return route.fulfill({ json: url.pathname.endsWith("/contractors") ? [contractor] : [] });
  });
  const page = await context.newPage();
  await page.goto(`${appUrl}/contractors/1`);
  const pwcSearch = page.getByRole("button", { name: "Search NJ PWC", exact: true });
  const brcSearch = page.getByRole("button", { name: "Search NJ BRC", exact: true });
  await pwcSearch.waitFor();
  await brcSearch.waitFor();
  for (const text of ["NJ BRC Registration Validation", "Review Required only. NJ BRC is non-expiring.", "No NJ BRC request loaded."]) {
    assert.equal(await page.getByText(text, { exact: false }).count(), 0, `Contractor detail should not show "${text}"`);
  }
  const assertSearchButtonsGrouped = async (requireSameRow) => {
    assert.equal(await pwcSearch.evaluate(button => {
      const next = button.nextElementSibling;
      return next instanceof HTMLButtonElement && next.textContent?.includes("Search NJ BRC");
    }), true, "NJ BRC search should immediately follow NJ PWC search");
    const [pwcBox, brcBox] = await Promise.all([pwcSearch.boundingBox(), brcSearch.boundingBox()]);
    assert.ok(pwcBox && brcBox);
    if (requireSameRow) assert.equal(pwcBox.y, brcBox.y, "NJ PWC and NJ BRC search buttons should share a row");
  };
  await assertSearchButtonsGrouped(true);
  await page.setViewportSize({ width: 390, height: 844 });
  await assertSearchButtonsGrouped(false);
  await page.setViewportSize({ width: 1366, height: 1000 });
  await brcSearch.click();
  assert.deepEqual(posts, [{ contractor_id: 1 }]);
  assert.equal(await page.getByRole("button", { name: "Search NJ BRC", exact: true }).count(), 1);
  assert.equal(await page.getByText("No NJ BRC request loaded.", { exact: true }).count(), 0);
  failure = true;
  await brcSearch.click();
  assert.equal(posts.length, 1);
  console.log("PASS: compact BRC search action stays beside PWC, submits queue requests and omits the information panel; no live writes");
} finally { await browser.close(); }
