import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { randomUUID } from "node:crypto";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { createHealthMonitor } from "../worker/nj-brc/health.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testLog = path.join(os.tmpdir(), `subtracker-brc-fixture-${randomUUID()}.log`);
process.env.WORKER_LOG_PATH = testLog;
const require = createRequire(path.join(root, "worker", "nj-brc", "worker.js"));
const { chromium } = require("playwright");
const {
  SOURCE_URL,
  FORM_SELECTOR,
  createLookupPlan,
  parseNjDate,
  normalizeBusinessName,
  sanitizeSourceUrl,
  extractCertificate,
  detectHumanVerification,
  classifySourcePage,
  fillLookupForm,
  redactPageContent,
  sanitizeMessage,
  sanitizeResultPayload,
  processRequest,
} = require("./worker.js");
const { normalizeFederalTaxIdForNjBrcLookup } = require("./input.js");

const results = [];
function test(name, callback) {
  results.push({ name, callback });
}

function certificateFixture({
  taxpayer = "ABCO ELECTRIC LLC",
  trade = "",
  certificate = "1329504",
  effective = "September 09, 2009",
  issuance = "October 09, 2026",
  addressFirst = "ONE GEOFFREY WAY",
  addressContinuation = "WAYNE, NJ 07470",
  officeUse = "DO NOT USE FOR REGISTRATION",
} = {}) {
  const row = (label, value) => `<tr><td>${label}</td><td>${value}</td></tr>`;
  return `<!doctype html><html><body>
    <h1>STATE OF NEW JERSEY</h1><h2>BUSINESS REGISTRATION CERTIFICATE</h2>
    <table>
      ${row("Taxpayer Name:", taxpayer)}
      ${row("Trade Name:", trade)}
      ${row("Address:", addressFirst)}
      <tr><td></td><td>${addressContinuation}</td></tr>
      ${row("Certificate Number:", certificate)}
      ${row("Effective Date:", effective)}
      ${row("Date of Issuance:", issuance)}
    </table>
    <table><tr><td>For Office Use Only</td></tr><tr><td>${officeUse}</td></tr></table>
  </body></html>`;
}

async function withPage(browser, html, callback) {
  const page = await browser.newPage();
  try {
    await page.route("https://www1.state.nj.us/**", (route) => route.fulfill({
      status: 200,
      contentType: "text/html",
      body: html,
    }));
    await page.goto(`${SOURCE_URL}?fixture=synthetic#not-for-evidence`);
    return await callback(page);
  } finally {
    await page.close();
  }
}

test("FEIN normalization strips formatting and preserves leading zeros", () => {
  assert.deepEqual(normalizeFederalTaxIdForNjBrcLookup("12-3456789"), {
    ok: true,
    taxpayerId: "123456789000",
  });
  assert.deepEqual(normalizeFederalTaxIdForNjBrcLookup("00-1234567"), {
    ok: true,
    taxpayerId: "001234567000",
  });
  assert.deepEqual(normalizeFederalTaxIdForNjBrcLookup("001234567"), {
    ok: true,
    taxpayerId: "001234567000",
  });
});

test("invalid FEIN with letters is rejected without repair", () => {
  assert.deepEqual(normalizeFederalTaxIdForNjBrcLookup("12-ABC6789"), {
    ok: false,
    error: "Invalid Taxpayer ID (FEIN): expected 9 digits before NJ BRC formatting.",
  });
  assert.equal(normalizeFederalTaxIdForNjBrcLookup("12/3456789").ok, false);
});

test("request requires valid Taxpayer ID and Name Control; Business Entity ID is output not input", () => {
  assert.deepEqual(createLookupPlan({
    company_name: "ABCO ELECTRIC LLC",
    brc_name_control: "ABCO",
    nj_brc_number: null,
    taxpayer_id_submission: "001234567000",
  }), {
    ok: true,
    companyName: "ABCO ELECTRIC LLC",
    nameControl: "ABCO",
    lookupKind: "taxpayer_id",
    taxpayerId: "001234567000",
  });
  const missingTaxpayer = createLookupPlan({
    company_name: "ABCO ELECTRIC LLC",
    brc_name_control: "ABCO",
    nj_brc_number: "0123456789",
    taxpayer_id_submission: "",
  });
  assert.equal(missingTaxpayer.ok, false);
  const malformedTaxpayerSnapshot = createLookupPlan({
    company_name: "ABCO ELECTRIC LLC",
    brc_name_control: "ABCO",
    nj_brc_number: "0123456789",
    taxpayer_id_submission: "not-a-valid-snapshot",
  });
  assert.equal(malformedTaxpayerSnapshot.ok, false);
});

test("invalid lookup inputs never proceed to form submission", () => {
  assert.equal(createLookupPlan({
    company_name: "ABCO ELECTRIC LLC",
    brc_name_control: "ABCO",
    nj_brc_number: "",
    taxpayer_id_submission: "",
  }).ok, false);
  assert.equal(createLookupPlan({
    company_name: "ABCO ELECTRIC LLC",
    brc_name_control: "ABCDE",
    nj_brc_number: "0123456789",
  }).ok, false);
});

test("source date labels parse independently; issue date is never substituted", () => {
  assert.equal(parseNjDate("September 09, 2009"), "2009-09-09");
  assert.equal(parseNjDate("October 09, 2026"), "2026-10-09");
  assert.equal(parseNjDate("09/09/2009"), "2009-09-09");
  assert.equal(parseNjDate("not a date"), null);
});

test("identity canonicalization strips punctuation and repeated trailing legal suffixes only", () => {
  assert.equal(
    normalizeBusinessName("Alpha Builders, L.L.C.").text,
    normalizeBusinessName("Alpha Builders LLC").text,
  );
  assert.notEqual(
    normalizeBusinessName("Alpha Builders Co. Services").text,
    normalizeBusinessName("Alpha Builders Services").text,
  );
  assert.equal(normalizeBusinessName("A&B").text, normalizeBusinessName("A and B").text);
  assert.equal(normalizeBusinessName("Alpha-Builders").text, normalizeBusinessName("Alpha Builders").text);
  assert.equal(normalizeBusinessName("L.L.C.").text, "llc");
  assert.equal(
    sanitizeSourceUrl(`${SOURCE_URL}?case=synthetic#fragment`),
    SOURCE_URL,
  );
  assert.equal(sanitizeSourceUrl("https://example.com/other"), null);
});

test("confirmed certificate labels map to their own fields and address continuation", async () => {
  await withPage(browserRef, certificateFixture(), async (page) => {
    const result = await extractCertificate(page, { company_name: "ABCO ELECTRIC LLC" }, "2026-10-09T20:52:25.788Z");
    assert.equal(result.kind, "successful_certificate");
    assert.equal(result.taxpayer_name, "ABCO ELECTRIC LLC");
    assert.equal(result.trade_name, null);
    assert.equal(result.address, "ONE GEOFFREY WAY, WAYNE, NJ 07470");
    assert.equal(result.certificate_number, "1329504");
    assert.equal(result.effective_date, "2009-09-09");
    assert.equal(result.date_of_issuance, "2026-10-09");
    assert.equal(result.office_use_only, "DO NOT USE FOR REGISTRATION");
    assert.equal(result.expiration_date, undefined);
    assert.equal(result.source_url, SOURCE_URL);
    assert.equal(result.source_url.includes("?"), false);
  });
});

test("lookup form fills Name Control and Taxpayer ID fields and never Business Entity ID", async () => {
  const formHtml = `<!doctype html><form action="/TYTR_BRC/servlet/common/BRCLogin">
    <input name="pinnctl" maxlength="4">
    <input name="pinidnum" maxlength="12">
    <input name="pincorpid" maxlength="10">
    <input name="pincasinoid" maxlength="7">
    <input type="submit" name="submit" value="Submit">
    <input type="submit" name="submit" value="Reset">
  </form>`;
  await withPage(browserRef, formHtml, async (page) => {
    const plan = createLookupPlan({
      company_name: "ABCO ELECTRIC LLC",
      brc_name_control: "ABCO",
      nj_brc_number: null,
      taxpayer_id_submission: "001234567000",
    });
    assert.equal(plan.lookupKind, "taxpayer_id");
    const submit = await fillLookupForm(page, plan);
    assert.equal(await page.locator(FORM_SELECTOR).count(), 1);
    assert.equal(await page.locator('input[name="pinnctl"]').inputValue(), "ABCO");
    assert.equal(await page.locator('input[name="pinidnum"]').inputValue(), "001234567000");
    assert.equal(await page.locator('input[name="pincorpid"]').inputValue(), "");
    assert.equal(await page.locator('input[name="pincasinoid"]').inputValue(), "");
    assert.equal(await submit.getAttribute("name"), "submit");
    assert.equal(await submit.inputValue(), "Submit");
  });
});

test("live NJ BRC form selects Submit and never Reset", async () => {
  const formHtml = `<input type="submit" name="submit" value="Submit" id="page-level">
    <form action="/TYTR_BRC/servlet/common/BRCLogin" method="POST">
      <input name="pinnctl" maxlength="4">
      <input name="pinidnum" maxlength="12">
      <input name="pincorpid" maxlength="10">
      <input name="pincasinoid" maxlength="7">
      <input type="submit" name="submit" value="Submit">
      <input type="submit" name="submit" value="Reset">
      <input type="reset" name="submit" value="Submit">
      <div class="captcha-box"><input type="submit" name="submit" value="Submit"></div>
      <input type="submit" name="submit" value="Submit" form="other-form">
    </form>
    <form id="other-form" action="/elsewhere"><input type="submit" name="submit" value="Submit"></form>`;
  await withPage(browserRef, formHtml, async (page) => {
    let resetClicked = false;
    await page.exposeFunction("markResetClicked", () => { resetClicked = true; });
    await page.evaluate(() => {
      for (const element of document.querySelectorAll('input[value="Reset"]')) {
        element.addEventListener("click", (event) => { event.preventDefault(); window.markResetClicked(); });
      }
    });
    const plan = createLookupPlan({
      company_name: "ABCO ELECTRIC LLC",
      brc_name_control: "ABCO",
      taxpayer_id_submission: "001234567000",
    });
    const requestId = "00000000-0000-4000-8000-000000000004";
    const submit = await fillLookupForm(page, plan, requestId);
    assert.equal(await submit.inputValue(), "Submit");
    assert.equal(await submit.getAttribute("type"), "submit");
    assert.equal(await submit.evaluate((element) => element.form?.getAttribute("action")), "/TYTR_BRC/servlet/common/BRCLogin");
    assert.equal(await submit.evaluate((element) => Boolean(element.closest(".captcha-box")) || element.hasAttribute("form")), false);
    await submit.evaluate((element) => element.form.addEventListener("submit", (event) => event.preventDefault()));
    await submit.click();
    assert.equal(resetClicked, false);
    const diagnostic = fs.readFileSync(testLog, "utf8").split(/\r?\n/)
      .map((line) => line && JSON.parse(line))
      .find((entry) => entry?.event === "submit_control_diagnostics" && entry.request_id === requestId);
    assert.ok(diagnostic);
    const details = JSON.parse(diagnostic.message);
    assert.equal(details.visible_enabled_search_submit_count, 1);
    assert.doesNotMatch(diagnostic.message, /ABCO|001234567000/);
    assert.deepEqual(details.candidates.map(({ value, form_association }) => ({ value, form_association })), [
      { value: "Submit", form_association: "none" },
      { value: "Submit", form_association: "nj_brc_lookup" },
      { value: "Reset", form_association: "nj_brc_lookup" },
      { value: "Submit", form_association: "other_form" },
      { value: "Submit", form_association: "other_form" },
    ]);
  });
});

test("Submit value matches case-insensitively with surrounding whitespace", async () => {
  await withPage(browserRef, `<form action="/TYTR_BRC/servlet/common/BRCLogin">
    <input name="pinnctl" maxlength="4">
    <input name="pinidnum" maxlength="12">
    <input type="SUBMIT" name="submit" value="  sUbMiT ">
    <input type="submit" name="submit" value=" reset ">
  </form>`, async (page) => {
    const plan = createLookupPlan({
      company_name: "ABCO ELECTRIC LLC",
      brc_name_control: "ABCO",
      taxpayer_id_submission: "001234567000",
    });
    const submit = await fillLookupForm(page, plan);
    assert.equal(await submit.inputValue(), "  sUbMiT ");
  });
});

test("lookup form rejects Reset-only and duplicate Submit controls", async () => {
  const plan = createLookupPlan({
    company_name: "ABCO ELECTRIC LLC",
    brc_name_control: "ABCO",
    taxpayer_id_submission: "001234567000",
  });
  await withPage(browserRef, `<form action="/TYTR_BRC/servlet/common/BRCLogin">
    <input name="pinnctl" maxlength="4"><input name="pinidnum" maxlength="12">
    <input type="submit" name="submit" value="Reset">
    <input type="submit" name="submit" value="Search">
  </form>`, async (page) => {
    await assert.rejects(fillLookupForm(page, plan), /search-submit control \(found 0\)/);
  });
  await withPage(browserRef, `<form action="/TYTR_BRC/servlet/common/BRCLogin">
    <input name="pinnctl" maxlength="4"><input name="pinidnum" maxlength="12">
    <input type="submit" name="submit" value="Submit">
    <input type="submit" name="submit" value="Submit">
    <input type="submit" name="submit" value="Reset">
  </form>`, async (page) => {
    await assert.rejects(fillLookupForm(page, plan), /search-submit control \(found 2\)/);
  });
});

test("lookup form rejects missing valid submit controls", async () => {
  await withPage(browserRef, `<form action="/TYTR_BRC/servlet/common/BRCLogin">
    <input name="pinnctl" maxlength="4">
    <input name="pinidnum" maxlength="12">
    <button type="button" name="not-submit">Not a submit control</button>
    <input type="submit" name="submit" value="Submit" disabled>
    <input type="submit" name="submit" value="Submit" style="display:none">
  </form>`, async (page) => {
    const plan = createLookupPlan({
      company_name: "ABCO ELECTRIC LLC",
      brc_name_control: "ABCO",
      taxpayer_id_submission: "001234567000",
    });
    await assert.rejects(
      fillLookupForm(page, plan),
      /exactly one visible, enabled search-submit control \(found 0\)/,
    );
  });
});

test("visible CAPTCHA frame is detected, hidden frame is ignored", async () => {
  await withPage(browserRef, '<iframe title="reCAPTCHA verification" src="about:blank"></iframe>', async (page) => {
    assert.equal(await detectHumanVerification(page), true);
  });
  await withPage(browserRef, '<iframe hidden title="hCaptcha" src="about:blank"></iframe>', async (page) => {
    assert.equal(await detectHumanVerification(page), false);
  });
  await withPage(browserRef, '<p>Please verify you are human.</p>', async (page) => {
    assert.equal(await detectHumanVerification(page), true);
  });
  await withPage(browserRef,
    '<iframe title="reCAPTCHA verification" srcdoc=\'<div role="checkbox" aria-checked="true">Verified</div>\'></iframe>',
    async (page) => {
      assert.equal(await detectHumanVerification(page), false);
    });
});

test("synthetic manual verification resumes on the same page without navigation", async () => {
  await withPage(browserRef,
    '<iframe title="reCAPTCHA verification" srcdoc=\'<div id="box" role="checkbox" aria-checked="false" tabindex="0">Verify</div><script>document.getElementById("box").onclick=()=>{const box=document.getElementById("box");box.setAttribute("aria-checked","true");box.textContent="Verified";}</script>\'></iframe>',
    async (page) => {
      const originalUrl = page.url();
      assert.equal(await detectHumanVerification(page), true);
      await page.frameLocator('iframe[title="reCAPTCHA verification"]').getByRole("checkbox").click();
      assert.equal(await detectHumanVerification(page), false);
      assert.equal(page.url(), originalUrl);
    });
});

test("Incapsula-branded page with explicit human challenge remains human verification", async () => {
  await withPage(browserRef,
    "<title>Incapsula</title><p>Incapsula security check: verify you are human.</p>",
    async (page) => {
      const result = await classifySourcePage(page, {});
      assert.equal(result.kind, "human_verification_required");
    });
});

test("form left on an unrecognized response is a sanitized Website Error", async () => {
    await withPage(browserRef, `<form action="/TYTR_BRC/servlet/common/BRCLogin">
      <input name="pinnctl" maxlength="4">
      <input name="pinidnum" maxlength="12">
      <input name="pincorpid" maxlength="10">
      <input type="submit" name="submit">
    </form>`, async (page) => {
      const result = await classifySourcePage(page, {});
      assert.equal(result.kind, "website_error");
      assert.ok(result.match_rationale);
      assert.ok(!("error_message" in sanitizeResultPayload(result)));
    });
});

test("only explicit source phrases become no-match or invalid-input", async () => {
  await withPage(browserRef, "<p>No records were found for this lookup.</p>", async (page) => {
    assert.equal((await classifySourcePage(page, {})).kind, "no_match");
  });
  await withPage(browserRef, "<p>Invalid Taxpayer ID</p>", async (page) => {
    assert.equal((await classifySourcePage(page, {})).kind, "invalid_input");
  });
});

test("identity conflicts, partial identity, unknown pages and protection pages are not no-match", async () => {
  await withPage(browserRef, certificateFixture(), async (page) => {
    const result = await extractCertificate(page, { company_name: "UNRELATED CONTRACTOR LLC" });
    assert.equal(result.kind, "identity_mismatch");
  });
  await withPage(browserRef, certificateFixture({ taxpayer: "ABCO SERVICES LLC" }), async (page) => {
    const result = await extractCertificate(page, { company_name: "ABCO ELECTRIC LLC" });
    assert.equal(result.kind, "ambiguous_result");
  });
  await withPage(browserRef, "<p>Unexpected content from the registry.</p>", async (page) => {
    assert.equal((await classifySourcePage(page, {})).kind, "website_error");
  });
  await withPage(browserRef, "<p>Incapsula incident ID: 123456</p>", async (page) => {
    const result = await classifySourcePage(page, {});
    assert.equal(result.kind, "website_error");
    assert.ok(!("message" in result));
    assert.ok(!("error_message" in result));
    assert.equal(sanitizeResultPayload(result).match_rationale.length > 0, true);
  });
  await withPage(browserRef, certificateFixture({ effective: "" }), async (page) => {
    assert.equal((await extractCertificate(page, { company_name: "ABCO ELECTRIC LLC" })).kind, "ambiguous_result");
  });
});

test("diagnostic sanitization masks taxpayer identifiers", () => {
  const sanitized = sanitizeMessage("failure for Taxpayer ID 12-3456789000");
  assert.ok(!sanitized.includes("12-3456789000"));
  assert.match(sanitized, /REDACTED/);
});

test("worker health uses BRC event names and UUID request keys", async () => {
  const payloads = [];
  const monitor = createHealthMonitor(
    { baseUrl: "https://subtracker.invalid", workerKey: "synthetic-key" },
    () => true,
    () => {},
    String,
    {
      instanceId: "00000000-0000-4000-8000-000000000001",
      metadata: () => ({ hash: "a".repeat(64), modified: "2026-10-09T00:00:00.000Z" }),
      setInterval: () => 1,
      clearInterval: () => {},
      fetch: async (_url, options) => {
        payloads.push({
          headers: options.headers,
          body: JSON.parse(options.body),
        });
        return new Response(JSON.stringify({ test_id: "test-1" }), { status: 200 });
      },
    },
  );
  monitor.start();
  await monitor.flush();
  monitor.busy("00000000-0000-4000-8000-000000000002");
  monitor.event("heartbeat", "Summary heartbeat should carry no event.");
  monitor.event("queue_poll", "Unsupported event should be ignored.");
  monitor.search("00000000-0000-4000-8000-000000000002", "Successful Certificate");
  await monitor.flush();
  const all = payloads.map((item) => item.body);
  assert.equal(all[0].worker_key, "nj-brc");
  assert.equal(all[0].event, "start");
  assert.equal(all[0].instance_id, "00000000-0000-4000-8000-000000000001");
  assert.ok(all.some((payload) => payload.event === "search" &&
    payload.result_status === "Successful Certificate" &&
    payload.request_key === "00000000-0000-4000-8000-000000000002"));
  assert.ok(all.every((payload) => !("request_id" in payload) && !("current_request_id" in payload)));
  assert.ok(all.every((payload) => !["heartbeat", "queue_poll"].includes(payload.event)));
  assert.equal(payloads[0].headers["x-subtracker-brc-key"], "synthetic-key");
  monitor.websiteError("Source unavailable.", "00000000-0000-4000-8000-000000000002");
  await monitor.flush();
  assert.ok(payloads.some((item) => item.body.event === "website_error" &&
    item.body.lifecycle === "website_error"));
  monitor.polled();
  await monitor.flush();
  assert.equal(payloads.at(-1).body.lifecycle, "ready");
  monitor.humanVerificationRequired("00000000-0000-4000-8000-000000000002");
  monitor.polled();
  await monitor.flush();
  assert.equal(payloads.at(-1).body.lifecycle, "human_verification_required");
  await monitor.stop();
});

test("submit-control failure is reported as a terminal website error", async () => {
  const context = await browserRef.newContext();
  const request = { id: "00000000-0000-4000-8000-000000000003", company_name: "ABCO Electric LLC",
    brc_name_control: "ABCO", taxpayer_id_submission: "001234567000" };
  const posts = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    posts.push(body);
    return { ok: true, status: 200, json: async () => ({ ok: true, request: { status: "website_error" } }) };
  };
  try {
    await context.route("https://www1.state.nj.us/**", (route) => route.fulfill({
      contentType: "text/html",
      body: `<form method="POST" action="/TYTR_BRC/servlet/common/BRCLogin">
        <input name="pinnctl" maxlength="4"><input name="pinidnum" maxlength="12">
        <button type="button">Not a submit control</button>
      </form>`,
    }));
    const result = await processRequest(context, request, "00000000-0000-4000-8000-000000000001");
    assert.equal(result.kind, "website_error");
    assert.match(result.match_rationale, /exactly one visible, enabled search-submit control/);
    assert.equal(posts.at(-1).result.kind, "website_error");
    assert.match(posts.at(-1).result.match_rationale, /exactly one visible, enabled search-submit control/);
    const diagnostics = fs.readFileSync(testLog, "utf8").split(/\r?\n/)
      .map((line) => line && JSON.parse(line))
      .filter((entry) => entry?.event === "submit_control_diagnostics" && entry.request_id === request.id);
    assert.equal(diagnostics.length, 1);
    assert.doesNotMatch(diagnostics[0].message, /ABCO|001234567000/);
    const details = JSON.parse(diagnostics[0].message);
    assert.equal(details.visible_enabled_search_submit_count, 0);
    assert.deepEqual(details.candidates.map(({ tag, type, form_association }) => ({ tag, type, form_association })), [
      { tag: "button", type: "button", form_association: "nj_brc_lookup" },
    ]);
    assert.equal("page_diagnostics" in posts.at(-1).result, false);
  } finally {
    globalThis.fetch = originalFetch;
    await context.close();
  }
});

test("post-submission website error attaches sanitized page diagnostics", async () => {
  const context = await browserRef.newContext();
  const request = { id: "00000000-0000-4000-8000-000000000005", company_name: "ABCO Electric LLC",
    brc_name_control: "ABCO", taxpayer_id_submission: "001234567000" };
  const posts = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    if (options?.body) posts.push(JSON.parse(options.body));
    return { ok: true, status: 200, json: async () => ({ ok: true, request: { status: "website_error" } }) };
  };
  const loginForm = (values = {}) => `<form method="POST" action="/TYTR_BRC/servlet/common/BRCLogin">
    <input name="pinnctl" maxlength="4" value="${values.nameControl || ""}">
    <input name="pinidnum" maxlength="12" value="${values.taxpayerId || ""}">
    <input type="hidden" name="session_token" value="hidden-session-secret">
    <input type="submit" name="submit" value="Submit"><input type="submit" name="submit" value="Reset"></form>`;
  try {
    await context.route("https://www1.state.nj.us/**", (route) => {
      if (route.request().method() !== "POST") return route.fulfill({ contentType: "text/html", body: loginForm() });
      return route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head>
        <title>Error for 001234567000</title><script>window.secret = "script-secret";</script></head><body>
        <h1>Unexpected response</h1>
        <p>Taxpayer ID 001234567000 (00-1234567) for name control ABCO could not be processed.</p>
        <a href="/TYTR_BRC/help;jsessionid=SESSIONSECRET?token=querysecret">Help</a>
        <div class="g-recaptcha" style="display:none"><iframe title="captcha" src="https://www.google.com/recaptcha/api2/anchor?k=captcha-secret"></iframe></div>
        ${loginForm({ nameControl: "ABCO", taxpayerId: "001234567000" })}
        <p>${"Filler text. ".repeat(400)}</p>
      </body></html>` });
    });
    const result = await processRequest(context, request, "00000000-0000-4000-8000-000000000001");
    assert.equal(result.kind, "website_error");
    const diagnostics = posts.at(-1).result.page_diagnostics;
    assert.ok(diagnostics);
    assert.equal(diagnostics.page_url, "https://www1.state.nj.us/TYTR_BRC/servlet/common/BRCLogin");
    assert.match(diagnostics.page_title, /^Error for \[REDACTED/);
    assert.match(diagnostics.page_text, /Unexpected response/);
    assert.ok(diagnostics.page_text.length <= 3000);
    assert.ok(diagnostics.html_snapshot.length > 0);
    assert.equal(diagnostics.screenshot.content_type, "image/jpeg");
    const image = Buffer.from(diagnostics.screenshot.data_base64, "base64");
    assert.deepEqual([...image.subarray(0, 3)], [0xff, 0xd8, 0xff]);
    assert.ok(diagnostics.captured_at);
    assert.equal(diagnostics.capture_error, null);
    const textual = JSON.stringify({ ...diagnostics, screenshot: null });
    for (const secret of ["001234567000", "001234567", "00-1234567", "ABCO", "hidden-session-secret", "script-secret",
      "SESSIONSECRET", "querysecret", "captcha-secret", "recaptcha", "<script", "test-worker-key"]) {
      assert.equal(textual.includes(secret), false, `diagnostics must not contain ${secret}`);
    }
    const logged = fs.readFileSync(testLog, "utf8");
    assert.equal(logged.includes("001234567000"), false);
  } finally {
    globalThis.fetch = originalFetch;
    await context.close();
  }
});

test("page diagnostic redaction masks formatted FEINs, Name Control and session tokens", () => {
  const fein = "001234567".split("").join("[\\s.()/-]*");
  const safe = redactPageContent("FEIN 00 123 4567, id 001234567000; AB&C ok ABCOX; /x;jsessionid=abc?sid=1",
    { digitPatterns: [fein], literals: [], words: ["AB&C"] });
  assert.doesNotMatch(safe, /00 123 4567|001234567000|AB&C|jsessionid|sid=1/);
  assert.match(safe, /ABCOX/);
});

test("claimed request runs through actual form submission and posts review-ready certificate without master writes", async () => {
  const context = await browserRef.newContext();
  const request = { id: "00000000-0000-4000-8000-000000000002", company_name: "ABCO Electric, L.L.C.",
    nj_brc_number: "0001234567", brc_name_control: "ABCO", taxpayer_id_submission: "001234567000" };
  const snapshot = structuredClone(request);
  const posts = [];
  const sourcePosts = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    posts.push(body);
    return { ok: true, status: 200, json: async () => ({ ok: true, request: { status: "review_required" } }) };
  };
  try {
    await context.route("**/*", async route => {
      assert.equal(new URL(route.request().url()).hostname, "www1.state.nj.us");
      if (route.request().method() === "POST") {
        sourcePosts.push(new URLSearchParams(route.request().postData()));
        return route.fulfill({ contentType: "text/html", body: certificateFixture() });
      }
      return route.fulfill({ contentType: "text/html", body: `<form method="POST" action="/TYTR_BRC/servlet/common/BRCLogin">
        <input name="pinnctl" maxlength="4"><input name="pinidnum" maxlength="12">
        <input name="pincorpid" maxlength="10"><input type="submit" name="submit" value="Submit"></form>` });
    });
    const result = await processRequest(context, request, "00000000-0000-4000-8000-000000000001");
    assert.equal(result.kind, "successful_certificate");
    assert.equal(sourcePosts.length, 1);
    assert.equal(sourcePosts[0].get("pinidnum"), "001234567000");
    assert.equal(sourcePosts[0].get("pinnctl"), "ABCO");
    assert.equal(sourcePosts[0].get("pincorpid"), "");
    assert.equal(posts.length, 2);
    assert.equal(posts[0].state, "processing");
    assert.equal(posts[1].result.certificate_number, "1329504");
    assert.equal(posts[1].result.effective_date, "2009-09-09");
    assert.equal(posts[1].result.source_url, "https://www1.state.nj.us/TYTR_BRC/servlet/common/BRCLogin");
    assert.equal("federal_tax_id" in posts[1].result, false);
    assert.equal("expiration_date" in posts[1].result, false);
    assert.deepEqual(request, snapshot);
  } finally {
    globalThis.fetch = originalFetch;
    await context.close();
  }
});

test("exclusive instance lock rejects a second process without reclaiming its owner's lock", () => {
  let lock = null;
  const memoryFs = {
    existsSync: (file) => file.endsWith("worker.lock") && lock !== null,
    mkdirSync() {},
    openSync: (_file, flags) => {
      assert.equal(flags, "wx");
      if (lock !== null) throw Object.assign(new Error("Lock exists"), { code: "EEXIST" });
      lock = "";
      return 1;
    },
    writeFileSync: (_descriptor, value) => { lock = value; },
    closeSync() {},
    readFileSync: () => lock,
    unlinkSync: () => { lock = null; },
  };
  const loadProcess = (pid) => {
    const loaded = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(root, "worker", "nj-brc", "worker.js"), "utf8"), {
      module: loaded, exports: loaded.exports,
      require: (name) => name === "node:fs" ? memoryFs : require(name),
      __dirname: path.join(root, "worker", "nj-brc"),
      process: { pid, env: {} }, console,
    });
    return loaded.exports;
  };
  const first = loadProcess(101);
  const second = loadProcess(102);
  first.acquireInstanceLock();
  const ownedLock = lock;
  assert.throws(() => second.acquireInstanceLock(), /lock already exists/);
  assert.equal(lock, ownedLock);
  second.releaseInstanceLock();
  assert.equal(lock, ownedLock);
  first.releaseInstanceLock();
  assert.equal(lock, null);
});

let browserRef;
let failed = 0;
try {
  browserRef = await chromium.launch({ headless: true });
  for (const { name, callback } of results) {
    try {
      await callback();
      console.log(`PASS ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`FAIL ${name}\n${error.stack || error}`);
    }
  }
} finally {
  await browserRef?.close();
  if (fs.existsSync(testLog)) fs.unlinkSync(testLog);
}
console.log(`${results.length - failed}/${results.length} synthetic NJ BRC tests passed.`);
if (failed) process.exitCode = 1;
