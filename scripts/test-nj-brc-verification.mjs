import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import test, { after, before } from "node:test";

const require = createRequire(import.meta.url);
const log = path.join(os.tmpdir(), `brc-verification-${randomUUID()}.log`);
Object.assign(process.env, {
  WORKER_LOG_PATH: log, HEADLESS: "false",
  SUBTRACKER_BASE_URL: "https://application.fixture.invalid", NJ_BRC_WORKER_KEY: "fixture-worker-secret",
});
const { chromium } = require("../worker/nj-brc/node_modules/playwright");
const { processRequest, classifySourcePage, inspectHumanVerification } = require("../worker/nj-brc/worker");
const { createHealthMonitor } = require("../worker/nj-brc/health");
const fixtures = JSON.parse(fs.readFileSync(new URL("./fixtures/nj-brc-verification.json", import.meta.url), "utf8"));
const instance = "00000000-0000-4000-8000-000000000001";
const request = {
  id: "00000000-0000-4000-8000-000000000002", company_name: "ABCO Electric LLC",
  brc_name_control: "ABCO", taxpayer_id_submission: "001234567000",
};
let browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => {
  await browser?.close();
  if (fs.existsSync(log)) fs.unlinkSync(log);
});

async function fixture(run, { result = "certificate", challengeAfterSubmit = false, disableSubmit = false, gateBeforeForm = false,
  formAfterSubmit = false } = {}) {
  const context = await browser.newContext();
  const posts = [], sourcePosts = [], states = [], healthPosts = [];
  let now = 0, lost = false, stopped = false, operator;
  const timers = new Map();
  const originalFetch = globalThis.fetch;
  const monitor = createHealthMonitor({ baseUrl: "https://application.fixture.invalid", workerKey: "fixture-worker-secret" },
    () => true, () => {}, String, {
      instanceId: instance, metadata: () => ({ hash: "a".repeat(64), modified: "2026-10-29T00:00:00Z" }),
      setInterval: (fn) => { timers.set("heartbeat", fn); return "heartbeat"; },
      clearInterval: (key) => timers.delete(key),
      setTimeout: () => ({ unref() {} }), clearTimeout() {},
      fetch: async (_url, options) => {
        healthPosts.push(JSON.parse(options.body));
        return { ok: true, json: async () => ({ ok: true }) };
      },
    });
  globalThis.fetch = async (url, options) => {
    assert.ok(url.startsWith("https://application.fixture.invalid/"), "No real API requests");
    const body = JSON.parse(options.body);
    posts.push(body);
    if (body.state) states.push(body.state);
    return { ok: true, status: 200, json: async () => ({
      ok: true, request: { status: body.result?.kind === "successful_certificate" ? "review_required" : body.result?.kind },
    }) };
  };
  await context.route("**/*", async (route) => {
    const req = route.request(), url = new URL(req.url());
    assert.ok(["www1.state.nj.us", "challenge.fixture.invalid"].includes(url.hostname), "Unexpected network blocked");
    if (url.pathname === "/_Incapsula_Resource") return route.fulfill({ contentType: "text/html", body: fixtures.protection_frame });
    if (url.pathname === "/checkbox") return route.fulfill({ contentType: "text/html", body: fixtures.checkbox });
    if (req.method() === "POST") {
      sourcePosts.push(req.postData());
      const body = challengeAfterSubmit
        ? `${formAfterSubmit ? fixtures.form : ""}<iframe title="Security check" src="/_Incapsula_Resource?token=fixture-private-token"></iframe>` : fixtures[result];
      return route.fulfill({ contentType: "text/html", body });
    }
    const cookie = await req.headerValue("cookie") || "";
    const body = gateBeforeForm && !cookie.includes("fixture_verified=yes")
      ? '<iframe title="Security check" src="/_Incapsula_Resource?token=fixture-private-token"></iframe>'
      : disableSubmit ? fixtures.form.replace("</body>",
        "<script>document.querySelector('[name=pinidnum]').addEventListener('input',()=>{if(!document.cookie.includes('fixture_verified=yes'))document.querySelector('[value=Submit]').disabled=true;});</script></body>") : fixtures.form;
    return route.fulfill({ contentType: "text/html", body });
  });
  monitor.start();
  await monitor.flush();
  const f = {
    context, posts, sourcePosts, states, healthPosts, monitor,
    setOperator(fn) { operator = fn; },
    loseLease() { lost = true; }, shutdown() { stopped = true; },
    get elapsed() { return now; },
    async complete({ navigate = false, manualSubmit = false, navigationToForm = false, removeChallenge = false } = {}) {
      const page = context.pages()[0];
      // Simulated operator only. Production code never clicks or writes challenge controls.
      const frame = page.frames().find((item) => item.url().includes("/checkbox"));
      assert.ok(frame, "Expected actionable nested verification frame");
      await frame.locator("#human").evaluate((element) => { element.checked = true; });
      await context.addCookies([{ name: "fixture_verified", value: "yes", url: "https://www1.state.nj.us" }]);
      if (disableSubmit) await page.locator('input[value="Submit"]').evaluate((element) => { element.disabled = false; });
      if (removeChallenge) await page.locator("iframe").evaluateAll((frames) => frames.forEach((element) => element.remove()));
      if (navigationToForm) await page.goto("https://www1.state.nj.us/TYTR_BRC/jsp/BRCLoginJsp.jsp");
      if (navigate) await page.setContent(fixtures[result]);
      if (manualSubmit) await page.locator('input[value="Submit"]').click();
    },
    options: {
      healthMonitor: monitor, now: () => now, verificationTimeoutMs: 25000, timeoutMs: 0,
      isStopping: () => stopped, hasLostLease: () => lost,
      confirmOwnership: async () => {
        if (lost) throw Object.assign(new Error("Fixture lease lost"), { code: "ownership_lost" });
      },
      sleep: async (ms) => {
        now += ms;
        if (now % 20000 === 0) { timers.get("heartbeat")?.(); await monitor.flush(); }
        await operator?.();
      },
    },
  };
  try { await run(f); } finally {
    await monitor.stop();
    globalThis.fetch = originalFetch;
    await context.close();
  }
}

test("first session fills validated fields, waits for operator in nested protection frame, renews health, and submits once", async () => {
  await fixture(async (f) => {
    f.setOperator(async () => {
      const page = f.context.pages()[0];
      assert.equal(await page.locator('[name=pinnctl]').inputValue(), "ABCO");
      assert.equal(await page.locator('[name=pinidnum]').inputValue(), "001234567000");
      assert.equal(f.sourcePosts.length, 0);
      assert.equal(f.states.at(-1), "human_verification_required");
      if (f.elapsed === 21000) await f.complete();
    });
    const result = await processRequest(f.context, request, instance, f.options);
    assert.equal(result.kind, "successful_certificate");
    assert.equal(f.sourcePosts.length, 1);
    assert.deepEqual(f.states, ["processing", "human_verification_required", "processing"]);
    assert.ok(f.healthPosts.some((p) => p.lifecycle === "human_verification_required" && !p.event));
    assert.equal(f.posts.at(-1).result.certificate_number, "1329504");
    assert.equal(f.context.pages().length, 0);
  });
});

test("verified context cookies survive queue items; explicit session reset requires verification again", async () => {
  await fixture(async (f) => {
    let waits = 0;
    f.setOperator(async () => { waits++; await f.complete(); });
    for (let i = 0; i < 2; i++) {
      assert.equal((await processRequest(f.context, { ...request, id: randomUUID() }, instance, f.options)).kind, "successful_certificate");
    }
    assert.equal(waits, 1);
    assert.equal(f.sourcePosts.length, 2);
    await f.context.clearCookies();
    await processRequest(f.context, { ...request, id: randomUUID() }, instance, f.options);
    assert.equal(waits, 2);
    assert.equal(f.sourcePosts.length, 3);
  });
});

for (const [companyName, expected] of [
  ["ABCO Electric LLC", "successful_certificate"],
  ["ABCO Plumbing LLC", "ambiguous_result"],
  ["Unrelated Business LLC", "identity_mismatch"],
]) {
  test(`same-action certificate form extracts evidence and preserves ${expected} identity outcome after one submission`, async () => {
    await fixture(async (f) => {
      await f.context.addCookies([{ name: "fixture_verified", value: "yes", url: "https://www1.state.nj.us" }]);
      const actual = await processRequest(f.context, { ...request, company_name: companyName }, instance, f.options);
      assert.equal(actual.kind, expected);
      assert.equal(actual.classification, "certificate");
      assert.equal(actual.taxpayer_name, "ABCO ELECTRIC LLC");
      assert.equal(actual.certificate_number, "1329504");
      assert.equal(actual.effective_date, "2009-09-09");
      assert.equal(actual.date_of_issuance, "2026-10-09");
      if (expected === "successful_certificate") {
        assert.equal(actual.source_url, "https://www1.state.nj.us/TYTR_BRC/servlet/common/BRCLogin");
      }
      assert.equal(f.sourcePosts.length, 1);
      assert.equal(f.posts.filter((post) => post.result).length, 1);
      assert.equal(f.posts.at(-1).result.kind, expected);
      assert.equal(actual.page_diagnostics, undefined);
      assert.deepEqual(f.states, ["processing"]);
      const logs = fs.readFileSync(log, "utf8");
      for (const secret of ["001234567", "fixture-worker-secret", "fixture-private-token", "fixture_verified", "I am human", "<html"]) {
        assert.ok(!logs.includes(secret), "Logs must exclude fixture secrets and source content");
      }
    }, { result: "certificate_same_action" });
  });
}

test("attended post-submit verification continues to a same-action certificate form without replay", async () => {
  await fixture(async (f) => {
    await f.context.addCookies([{ name: "fixture_verified", value: "yes", url: "https://www1.state.nj.us" }]);
    f.setOperator(() => f.complete({ navigate: true }));
    const actual = await processRequest(f.context, request, instance, f.options);
    assert.equal(actual.kind, "successful_certificate");
    assert.equal(f.sourcePosts.length, 1);
    assert.deepEqual(f.states, ["processing", "human_verification_required", "processing"]);
  }, { challengeAfterSubmit: true, result: "certificate_same_action" });
});

test("certificate markers precede actual lookup controls, but do not override protection or verification", async () => {
  await fixture(async (f) => {
    const page = await f.context.newPage();
    await page.goto("https://www1.state.nj.us/TYTR_BRC/servlet/common/BRCLogin");
    const controls = '<input name="pinnctl" maxlength="4"><input name="pinidnum" maxlength="12">';
    const cases = [
      [fixtures.certificate_same_action.replace("</form>", `${controls}</form>`), "successful_certificate", "certificate"],
      [fixtures.certificate_same_action.replace("1329504", ""), "ambiguous_result", "certificate"],
      [fixtures.form, "website_error", "unrecognized"],
      [`<form action="/TYTR_BRC/servlet/common/BRCLogin"></form>`, "website_error", "unrecognized"],
      [`<form action="/TYTR_BRC/servlet/common/BRCLogin" hidden>${controls}</form>`, "website_error", "unrecognized"],
      [fixtures.form.replace("</form>", "<h1>BUSINESS REGISTRATION CERTIFICATE</h1></form>"), "website_error", "unrecognized"],
      [fixtures.form.replace("</form>", `${fixtures.certificate.replace("<!doctype html><html><body>", "<div hidden>").replace("</body></html>", "</div>")}</form>`), "website_error", "unrecognized"],
      [fixtures.certificate_same_action.replace("</form>", `${controls}<table><tr><td>Certificate Number:</td><td>9999999</td></tr></table></form>`), "website_error", "unrecognized"],
      [fixtures.certificate_same_action.replace("</body>", "Access denied. Request rejected by Imperva.</body>"), "website_error", "protection"],
      [fixtures.certificate_same_action.replace("</body>", `${fixtures.checkbox}</body>`), "human_verification_required", "human_verification"],
      [fixtures.form.replace("</form>", "No registration found.</form>"), "no_match", "no_result"],
    ];
    for (const [html, kind, classification] of cases) {
      await page.setContent(html);
      const actual = await classifySourcePage(page, request, 200);
      assert.equal(actual.kind, kind);
      assert.equal(actual.classification, classification);
      if (html === fixtures.form) {
        assert.equal(actual.match_rationale, "NJ BRC form remained visible after submission without a recognized result.");
      }
      if (!html.includes("pinnctl") && !html.includes("BUSINESS REGISTRATION CERTIFICATE")
        && classification === "unrecognized") {
        assert.equal(actual.match_rationale, "NJ BRC source page was not a recognized certificate result.");
      }
    }
    await page.setContent(fixtures.certificate_same_action);
    assert.equal((await classifySourcePage(page, request, 403)).classification, "protection");
    assert.equal((await classifySourcePage(page, request, 503)).classification, "temporary_failure");
    assert.equal(f.sourcePosts.length, 0);
  });
});

test("verification timeout reports terminal website_error with sanitized diagnostics; no source submission or endless wait", async () => {
  await fixture(async (f) => {
    const result = await processRequest(f.context, request, instance, f.options);
    assert.equal(result.kind, "website_error");
    assert.equal(f.elapsed, 25000);
    assert.equal(f.sourcePosts.length, 0);
    assert.equal(f.posts.at(-1).result.page_diagnostics.classification, "verification_timeout");
    assert.equal(f.posts.at(-1).result.page_diagnostics.stage, "human_verification");
    assert.equal(f.posts.at(-1).result.page_diagnostics.human_verification_detected, true);
    await f.monitor.flush();
    assert.equal(f.healthPosts.at(-1).lifecycle, "website_error", "Terminal timeout must clear the waiting health state");
    const diagnostics = JSON.stringify(f.posts.at(-1).result.page_diagnostics);
    for (const secret of ["001234567", "ABCO", "fixture-worker-secret", "fixture-private-token", "fixture_verified", "<html", "screenshot", "html_snapshot"]) {
      assert.ok(!diagnostics.includes(secret), secret);
    }
    assert.equal(f.context.pages().length, 0);
  });
});

test("lease loss while waiting forbids source and result submission", async () => {
  await fixture(async (f) => {
    f.setOperator(() => f.loseLease());
    await assert.rejects(processRequest(f.context, request, instance, f.options), /ownership lost|Lease lost/);
    assert.equal(f.sourcePosts.length, 0);
    assert.equal(f.posts.filter((post) => post.result).length, 0);
    assert.equal(f.context.pages().length, 0);
  });
});

test("shutdown while waiting reports a recoverable terminal failure without submitting source", async () => {
  await fixture(async (f) => {
    f.setOperator(() => f.shutdown());
    assert.equal((await processRequest(f.context, request, instance, f.options)).kind, "failed");
    assert.equal(f.posts.at(-1).result.kind, "failed");
    assert.equal(f.posts.at(-1).result.page_diagnostics.classification, "verification_shutdown");
    assert.equal(f.sourcePosts.length, 0);
    await f.monitor.flush();
    assert.notEqual(f.healthPosts.at(-1).lifecycle, "human_verification_required");
  });
});

for (const result of ["no_result", "denied", "temporary", "unknown"]) {
  test(`after verification, ${result} is classified without replay`, async () => {
    await fixture(async (f) => {
      f.setOperator(() => f.complete());
      const actual = await processRequest(f.context, request, instance, f.options);
      assert.equal(actual.kind, result === "no_result" ? "no_match" : "website_error");
      if (result !== "no_result") assert.equal(actual.classification,
        { denied: "protection", temporary: "temporary_failure", unknown: "unrecognized" }[result]);
      assert.equal(f.sourcePosts.length, 1);
    }, { result });
  });
}

test("post-submit verification can continue to a certificate without a second website submission", async () => {
  await fixture(async (f) => {
    f.setOperator(() => f.complete({ navigate: true }));
    await f.context.addCookies([{ name: "fixture_verified", value: "yes", url: "https://www1.state.nj.us" }]);
    assert.equal((await processRequest(f.context, request, instance, f.options)).kind, "successful_certificate");
    assert.equal(f.sourcePosts.length, 1);
    assert.deepEqual(f.states, ["processing", "human_verification_required", "processing"]);
  }, { challengeAfterSubmit: true });
});

test("operator-submitted form is never submitted again by worker", async () => {
  await fixture(async (f) => {
    f.setOperator(() => f.complete({ manualSubmit: true }));
    assert.equal((await processRequest(f.context, request, instance, f.options)).kind, "successful_certificate");
    assert.equal(f.sourcePosts.length, 1);
  });
});

test("verification-disabled Submit is not rejected before operator completion", async () => {
  await fixture(async (f) => {
    f.setOperator(() => f.complete());
    assert.equal((await processRequest(f.context, request, instance, f.options)).kind, "successful_certificate");
    assert.equal(f.sourcePosts.length, 1);
  }, { disableSubmit: true });
});

test("a first-session gate before the form resumes to validated controls in the same context", async () => {
  await fixture(async (f) => {
    f.setOperator(() => f.complete({ navigationToForm: true }));
    assert.equal((await processRequest(f.context, request, instance, f.options)).kind, "successful_certificate");
    assert.equal(f.sourcePosts.length, 1);
    assert.deepEqual(f.states, ["processing", "human_verification_required", "processing"]);
  }, { gateBeforeForm: true });
});

test("challenge disappearance with a recognized lookup form allows exactly one submission", async () => {
  await fixture(async (f) => {
    f.setOperator(() => f.complete({ removeChallenge: true }));
    assert.equal((await processRequest(f.context, request, instance, f.options)).kind, "successful_certificate");
    assert.equal(f.sourcePosts.length, 1);
  });
});

test("post-submit challenge returning the form fails unrecognized without a duplicate lookup", async () => {
  await fixture(async (f) => {
    await f.context.addCookies([{ name: "fixture_verified", value: "yes", url: "https://www1.state.nj.us" }]);
    f.setOperator(() => f.complete());
    const actual = await processRequest(f.context, request, instance, f.options);
    assert.equal(actual.kind, "website_error");
    assert.equal(actual.classification, "unrecognized");
    assert.equal(f.sourcePosts.length, 1);
  }, { challengeAfterSubmit: true, formAfterSubmit: true });
});

test("checked post-submit widget waits for delayed navigation instead of failing its remaining wrapper", async () => {
  await fixture(async (f) => {
    await f.context.addCookies([{ name: "fixture_verified", value: "yes", url: "https://www1.state.nj.us" }]);
    f.setOperator(async () => {
      if (f.elapsed === 1000) await f.complete();
      if (f.elapsed === 2000) await f.context.pages()[0].setContent(fixtures.certificate);
    });
    assert.equal((await processRequest(f.context, request, instance, f.options)).kind, "successful_certificate");
    assert.equal(f.sourcePosts.length, 1);
    assert.equal(f.elapsed, 2000);
  }, { challengeAfterSubmit: true });
});

test("genuine denial after post-submit verification retains protection classification without replay", async () => {
  await fixture(async (f) => {
    await f.context.addCookies([{ name: "fixture_verified", value: "yes", url: "https://www1.state.nj.us" }]);
    f.setOperator(() => f.complete({ navigate: true }));
    const actual = await processRequest(f.context, request, instance, f.options);
    assert.equal(actual.kind, "website_error");
    assert.equal(actual.classification, "protection");
    assert.equal(f.sourcePosts.length, 1);
  }, { challengeAfterSubmit: true, result: "denied" });
});

test("an unrelated iframe or un-actionable prompt is never treated as actionable CAPTCHA", async () => {
  const page = await browser.newPage();
  await page.route("**/*", (route) => route.fulfill({ body: "" }));
  try {
    for (const name of ["unrelated_iframe", "unactionable_prompt", "denied"]) {
      await page.setContent(fixtures[name]);
      assert.notEqual((await inspectHumanVerification(page)).state, "required");
      assert.equal((await classifySourcePage(page, {})).kind, "website_error");
    }
  } finally { await page.close(); }
});
