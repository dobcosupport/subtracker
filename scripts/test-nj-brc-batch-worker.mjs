import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import test, { after, before } from "node:test";

const require = createRequire(import.meta.url);
const log = path.join(os.tmpdir(), `brc-batch-${randomUUID()}.log`);
Object.assign(process.env, {
  WORKER_LOG_PATH: log, HEADLESS: "false",
  SUBTRACKER_BASE_URL: "https://batch.fixture.invalid", NJ_BRC_WORKER_KEY: "fixture-batch-key",
});
const { chromium } = require("../worker/nj-brc/node_modules/playwright");
const { processRequest, inspectHumanVerification, SOURCE_URL } = require("../worker/nj-brc/worker");
const { parseBatchId, runAttendedBatch } = require("../worker/nj-brc/batch");
const fixtureHtml = JSON.parse(fs.readFileSync(new URL("./fixtures/nj-brc-verification.json", import.meta.url), "utf8"));
const sessionId = "00000000-0000-4000-8000-000000000001";
const instanceId = "00000000-0000-4000-8000-000000000002";
let browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); if (fs.existsSync(log)) fs.unlinkSync(log); });

async function fixture(run, { outcomes = ["certificate", "no_result", "invalid_input", "unknown", "certificate"], human = false } = {}) {
  const context = await browser.newContext();
  const session = { id: sessionId, status: "running", member_count: outcomes.length };
  const members = outcomes.map((_, index) => ({ ordinal: index + 1, contractor_id: index + 1, request_id: null, state: "prepared" }));
  const requests = [], reports = [], posts = [], navigations = [], calls = [], events = [];
  let current = null, active = 0, peak = 0, now = 0, gateStage = 0, operator = null, rejectReport = false, pauseStateRace = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    assert.ok(url.startsWith("https://batch.fixture.invalid/api/integrations/compliance-sync/nj-brc?"), "Unexpected API blocked");
    const body = JSON.parse(options.body);
    if (body.state && pauseStateRace) {
      pauseStateRace = false; session.status = "paused";
      return { ok: false, status: 409 };
    }
    if (body.state) current.status = body.state;
    if (body.result) {
      reports.push(body);
      if (rejectReport) return { ok: false, status: 503 };
      current.status = body.result.kind === "successful_certificate" ? "review_required" : body.result.kind;
      current.result_type = body.result.kind;
    }
    return { ok: true, status: 200, json: async () => ({ request: { id: current.id, status: current.status } }) };
  };
  await context.route("**/*", async (route) => {
    const request = route.request(), url = new URL(request.url());
    assert.ok(["www1.state.nj.us", "challenge.fixture.invalid"].includes(url.hostname), "External request blocked");
    if (url.pathname === "/_Incapsula_Resource") return route.fulfill({ contentType: "text/html", body: fixtureHtml.protection_frame });
    if (url.pathname === "/checkbox") return route.fulfill({ contentType: "text/html", body: fixtureHtml.checkbox });
    navigations.push({ method: request.method(), request_id: current?.id });
    if (request.method() === "POST") {
      posts.push({ id: current.id, data: request.postData() });
      assert.equal(posts.filter((post) => post.id === current.id).length, 1, "Never replay a company submission");
      const outcome = outcomes[members.findIndex((member) => member.request_id === current.id)];
      const html = outcome === "post_challenge" ? '<iframe title="Security check" src="/_Incapsula_Resource"></iframe>'
        : outcome === "invalid_input" ? "<body>Invalid Name Control</body>"
        : fixtureHtml[outcome === "certificate" ? "certificate_same_action" : outcome];
      return route.fulfill({ contentType: "text/html", body: html });
    }
    const form = human ? fixtureHtml.form : fixtureHtml.form.replace("<script>", "<script>document.cookie='fixture_verified=yes';");
    return route.fulfill({ contentType: "text/html", body: form });
  });
  const control = async (action, payload = {}) => {
    calls.push(action);
    if (action === "pause") { if (session.status === "running") session.status = "paused"; }
    if (action === "next") {
      if (session.status !== "running") return { session: { ...session }, request: null };
      const member = members.find((member) => member.state === "prepared");
      if (!member) { session.status = "completed"; return { session: { ...session }, request: null }; }
      assert.equal(member.request_id, null, "Completed/in-flight request must never be recreated");
      current = {
        id: randomUUID(), contractor_id: member.contractor_id, company_name: "ABCO Electric LLC",
        brc_name_control: "ABCO", taxpayer_id_submission: "001234567000", status: "claimed",
      };
      member.request_id = current.id;
      requests.push(current);
      return { session: { ...session }, member: { ...member }, request: { ...current } };
    }
    if (action === "complete") {
      const member = members.find((member) => member.request_id === payload.request_id);
      assert.ok(member);
      assert.ok(["review_required", "no_match", "invalid_input", "website_error", "failed", "identity_mismatch", "ambiguous_result"].includes(current.status));
      member.state = "completed";
    }
    return { session: { ...session } };
  };
  const f = {
    context, session, members, requests, reports, posts, navigations, calls, events,
    setOperator(fn) { operator = fn; },
    rejectReports() { rejectReport = true; },
    pauseOnStateUpdate() { pauseStateRace = true; },
    get current() { return current; },
    get page() { return context.pages()[0]; },
    get peak() { return peak; },
    async simulateOperator() {
      if (!human) return;
      const page = context.pages()[0];
      if (!page) return;
      const checkFrame = page.frames().find((frame) => frame.url().includes("/checkbox"));
      if (checkFrame && gateStage === 0) {
        gateStage = 1;
        // Synthetic operator changes only intercepted fixture documents.
        await checkFrame.setContent("<body>Select all images containing a test object.</body>");
      } else if (gateStage === 1) {
        gateStage = 2;
        await context.addCookies([{ name: "fixture_verified", value: "yes", url: SOURCE_URL }]);
        await page.goto(SOURCE_URL);
      }
    },
    async run(overrides = {}) {
      return runAttendedBatch({
        sessionId, instanceId, context, browser, control, controlIntervalMs: 0,
        confirmOwnership: async () => {},
        log: (event) => events.push(event),
        sleep: async (ms) => { now += ms; await f.simulateOperator(); await operator?.(); },
        processRequest: async (...args) => {
          active++; peak = Math.max(peak, active);
          try {
            return await processRequest(args[0], args[1], args[2], {
              ...args[3], timeoutMs: 500, verificationTimeoutMs: 10000, now: () => now,
            });
          } finally { active--; }
        },
        ...overrides,
      });
    },
  };
  try { await run(f); } finally { globalThis.fetch = originalFetch; await context.close(); }
}

test("batch CLI requires one explicit UUID, never silently enables global queue processing", () => {
  assert.equal(parseBatchId([]), null);
  assert.equal(parseBatchId(["--batch", sessionId]), sessionId);
  for (const args of [["--batch"], ["--batch", "all"], ["--batch", sessionId, "extra"], ["--legacy"]]) {
    assert.throws(() => parseBatchId(args), /Prepared Verification Batch UUID/);
  }
});

test("five companies share one visible-session page, manual multi-stage verification, sequential reports then automatic advance", async () => {
  await fixture(async (f) => {
    const pages = [];
    f.context.on("page", (page) => pages.push(page));
    const result = await f.run();
    assert.equal(result.status, "completed");
    assert.equal(pages.length, 1, "Entire batch uses one page/context");
    assert.equal(f.peak, 1);
    assert.equal(f.requests.length, 5);
    assert.equal(f.posts.length, 5);
    assert.equal(f.reports.length, 5);
    assert.deepEqual(f.reports.map((report) => report.result.kind),
      ["successful_certificate", "no_match", "invalid_input", "website_error", "successful_certificate"]);
    assert.equal(f.requests[0].status, "review_required", "Capture never auto-approves");
    assert.equal(f.requests[4].status, "review_required");
    assert.ok(f.members.every((member) => member.state === "completed"));
    assert.ok(f.posts.every((post) => /pinnctl=ABCO/.test(post.data) && /pinidnum=001234567000/.test(post.data)));
    assert.equal(f.calls.filter((call) => call === "pause").length, 0, "Isolated failures do not stop the batch");
    assert.equal(f.events.filter((event) => event.event === "batch_member_saved").length, 5);
  }, { human: true });
});

test("pause before submission retains the page; resume proceeds once and never replays completed companies", async () => {
  await fixture(async (f) => {
    let paused = false, resumed = false;
    const originalProcess = processRequest;
    await f.run({
      processRequest: async (context, request, instance, options) => {
        if (!paused) { f.session.status = "paused"; paused = true; }
        return originalProcess(context, request, instance, { ...options, timeoutMs: 0 });
      },
      sleep: async () => {
        assert.equal(f.posts.length, 0);
        assert.equal(f.context.pages().length, 1);
        f.session.status = "running"; resumed = true;
      },
    });
    assert.ok(resumed);
    assert.equal(f.posts.length, 2);
    assert.equal(f.requests.length, 2);
  }, { outcomes: ["certificate", "certificate"] });
});

test("multiple post-submit verification stages wait for the real certificate without a second submission", async () => {
  await fixture(async (f) => {
    let stage = 0;
    f.setOperator(async () => {
      const frame = f.page?.frames().find((frame) => frame.url().includes("/checkbox"));
      if (frame && stage === 0) {
        stage++;
        await frame.setContent("<body>Please select all images containing the fixture object.</body>");
      } else if (stage === 1) {
        stage++;
        await f.page.setContent(fixtureHtml.certificate_same_action);
      }
    });
    await f.run();
    assert.equal(stage, 2);
    assert.equal(f.posts.length, 1);
    assert.equal(f.reports[0].result.kind, "successful_certificate");
    assert.equal(f.current.status, "review_required");
  }, { outcomes: ["post_challenge"] });
});

test("administrative pause racing a processing state update waits for Resume instead of treating it as lease loss", async () => {
  await fixture(async (f) => {
    f.pauseOnStateUpdate();
    let resumed = false;
    f.setOperator(async () => {
      assert.equal(f.posts.length, 0);
      assert.equal(f.session.status, "paused");
      f.session.status = "running"; resumed = true;
    });
    await f.run();
    assert.ok(resumed);
    assert.equal(f.posts.length, 1);
    assert.equal(f.reports[0].result.kind, "successful_certificate");
    assert.equal(f.session.status, "completed");
  }, { outcomes: ["certificate"] });
});

test("a systemic NJ failure is safely saved and pauses; explicit resume advances without resubmitting its completed member", async () => {
  await fixture(async (f) => {
    let resumed = false;
    f.setOperator(async () => {
      if (f.session.status === "paused") {
        assert.equal(f.posts.length, 1);
        assert.equal(f.members[0].state, "completed");
        f.session.status = "running"; resumed = true;
      }
    });
    await f.run();
    assert.ok(resumed);
    assert.equal(f.posts.length, 2);
    assert.equal(f.requests.length, 2);
    assert.ok(f.calls.includes("pause"));
  }, { outcomes: ["temporary", "certificate"] });
});

test("result persistence failure pauses and exits without claiming or submitting company two", async () => {
  await fixture(async (f) => {
    f.rejectReports();
    await assert.rejects(f.run(), /API request failed/);
    assert.equal(f.session.status, "paused");
    assert.equal(f.requests.length, 1);
    assert.equal(f.posts.length, 1);
    assert.equal(f.members[0].state, "prepared");
    assert.equal(f.calls.includes("complete"), false);
  }, { outcomes: ["certificate", "certificate"] });
});

test("repeated source errors pause as a systemic failure, rather than consuming the rest of the batch", async () => {
  await fixture(async (f) => {
    let paused = false;
    f.setOperator(async () => {
      if (f.session.status === "paused") {
        assert.equal(f.posts.length, 2);
        assert.equal(f.requests.length, 2);
        paused = true; f.session.status = "running";
      }
    });
    await f.run();
    assert.ok(paused);
    assert.equal(f.posts.length, 3);
  }, { outcomes: ["unknown", "unknown", "certificate"] });
});

test("lease loss and browser failure pause without advancing the batch", async () => {
  for (const code of ["ownership_lost", "browser_lost"]) {
    await fixture(async (f) => {
      await assert.rejects(f.run({
        processRequest: async () => { throw Object.assign(new Error(`Fixture ${code}`), { code }); },
      }), new RegExp(code));
      assert.equal(f.session.status, "paused");
      assert.equal(f.requests.length, 1);
      assert.equal(f.posts.length, 0);
      assert.equal(f.calls.includes("complete"), false);
    });
  }
});

test("stop during an attended challenge reports failure without any submission and leaves remaining members untouched", async () => {
  await fixture(async (f) => {
    await f.run({ sleep: async () => { f.session.status = "stopped"; } });
    assert.equal(f.posts.length, 0);
    assert.equal(f.requests.length, 1);
    assert.equal(f.members[0].state, "completed");
    assert.equal(f.reports[0].result.kind, "failed");
  }, { human: true });
});

test("document replacement while inspecting a challenge retries the current document instead of failing a legitimate result", async () => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.setContent('<iframe srcdoc="<body>I am human<input type=checkbox aria-label=human></body>"></iframe>');
    const frame = page.frames()[1];
    const original = frame.frameElement.bind(frame);
    frame.frameElement = async () => ({
      evaluate: async () => {
        await page.setContent(fixtureHtml.certificate_same_action);
        throw new Error("elementHandle.isVisible: Unable to adopt element handle from a different document");
      },
      dispose: async () => {},
    });

    test("successful manually verified same-action result survives the document-replacement race in the complete reporting path", async () => {
      await fixture(async (f) => {
        let replaced = false;
        await f.run({
          sleep: async () => {
            const page = f.page;
            const frame = page.frames().find((frame) => frame.url().includes("/checkbox"));
            if (frame && !replaced) {
              replaced = true;
              frame.frameElement = async () => ({
                evaluate: async () => {
                  await page.setContent(fixtureHtml.certificate_same_action);
                  throw new Error("Unable to adopt element handle from a different document");
                },
                dispose: async () => {},
              });
            }
          },
        });
        assert.ok(replaced);
        assert.equal(f.posts.length, 0, "A result already displayed after manual verification is not submitted again");
        assert.equal(f.reports.length, 1);
        assert.equal(f.reports[0].result.kind, "successful_certificate");
        assert.equal(f.current.status, "review_required");
        assert.equal(f.members[0].state, "completed");
      }, { outcomes: ["certificate"], human: true });
    });
    assert.equal((await inspectHumanVerification(page)).state, "navigating");
    frame.frameElement = original;
    assert.equal((await inspectHumanVerification(page)).state, "none");
  } finally { await context.close(); }
});
