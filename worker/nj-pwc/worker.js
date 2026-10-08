// =====================================================================
// SubTracker NJ PWC Playwright Worker
//
// Polls SubTracker for pending NJ PWC search requests, searches the NJ
// Public Works Contractor Registration Power BI report via Chromium, and
// posts candidate matches back to SubTracker over HTTPS.
//
// This is the persistent implementation of the extraction method proven
// during live testing (Playwright frame iteration + table read). It is NOT
// a Power Automate Desktop flow.
//
// Run: node worker.js
// Requires a .env file (see .env.example). Never commit .env.
// =====================================================================

"use strict";

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

// ---------------------------------------------------------------------
// Environment / config
// ---------------------------------------------------------------------
loadEnvFile(path.join(__dirname, ".env"));

const CONFIG = {
  baseUrl: (process.env.SUBTRACKER_BASE_URL || "").replace(/\/+$/, ""),
  rpaKey: process.env.COMPLIANCE_SYNC_RPA_KEY || "",
  reportUrl: process.env.NJ_PWC_REPORT_URL || "",
  pollIntervalSeconds: Math.max(5, Number(process.env.POLL_INTERVAL_SECONDS) || 30),
  logPath: process.env.WORKER_LOG_PATH || path.join(__dirname, "logs", "nj-pwc-worker.log"),
  headless: String(process.env.HEADLESS || "false").toLowerCase() === "true",
};

const MAX_CANDIDATES = 50;
const SEARCH_APPLY_TIMEOUT_MS = 60000;
const RETRY_DELAYS_MS = [5000, 15000, 45000];

// Search reliability (bounded; no unlimited retry loops).
const INPUT_ATTEMPTS = 3; // fill/verify/Enter attempts per page
const INPUT_RETRY_DELAYS_MS = [1000, 2000]; // delay before input attempt 2 and 3
const PAGE_ATTEMPTS = 2; // original page + one fresh-page retry
const PAGE_RETRY_DELAY_MS = 2000;
const INPUT_ACTION_TIMEOUT_MS = 15000;
const INPUT_STABLE_MS = 500; // input must stay attached this long before fill
const RESULTS_UPDATE_TIMEOUT_MS = 30000;
const RESULTS_POLL_MS = 500;
const RESULTS_STABLE_MS = 1500; // non-empty results must be unchanged this long
const EMPTY_RESULTS_STABLE_MS = 5000; // empty results need a longer settle (re-render gaps)

// The Business Name search box is the only search-field inside the Power BI
// visual-sandbox iframe nearest to the "Search Business Name" heading. Six
// visuals share input[name="search-field"], so the frame MUST be resolved via
// the heading — never "first search-field in any frame".
const BUSINESS_IFRAME_SELECTOR =
  "xpath=//*[normalize-space(.)='Search Business Name' and not(*[normalize-space(.)='Search Business Name'])]" +
  "/ancestor-or-self::*[.//iframe][1]//iframe";
const BUSINESS_INPUT_SELECTOR = 'input[name="search-field"]';

// Business suffixes stripped during search normalization (Attempt 3).
const BUSINESS_SUFFIXES = ["L.L.C.", "LLC", "CORPORATION", "CORP", "INC", "COMPANY", "CO", "LTD"];

// ---------------------------------------------------------------------
// Minimal .env loader (no external dependency)
// ---------------------------------------------------------------------
function loadEnvFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return;
    const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch {
    /* .env is optional; environment may supply the variables directly */
  }
}

// ---------------------------------------------------------------------
// Logging — one structured entry per request + heartbeat.
// NEVER log: RPA key, Supabase keys, tokens, cookies, passwords.
// ---------------------------------------------------------------------
function ensureLogDir() {
  const dir = path.dirname(path.resolve(CONFIG.logPath));
  fs.mkdirSync(dir, { recursive: true });
}

function writeLog(entry) {
  const line = JSON.stringify({ timestamp: new Date().toISOString(), ...entry });
  fs.appendFileSync(path.resolve(CONFIG.logPath), line + "\n", "utf8");
  // Mirror a sanitized line to stdout for attended runs.
  console.log(line);
}

function logHeartbeat() {
  writeLog({ event: "heartbeat", message: "No pending requests" });
}

// ---------------------------------------------------------------------
// HTTP helpers (RPA key sent only as a header; never logged)
// ---------------------------------------------------------------------
function authHeaders() {
  return {
    "x-subtracker-rpa-key": CONFIG.rpaKey,
    "Content-Type": "application/json",
  };
}

async function fetchPendingRequests() {
  const url = `${CONFIG.baseUrl}/api/integrations/compliance-sync/search-requests?compliance_name=NJ%20PWC&limit=25`;
  const res = await fetch(url, { headers: authHeaders() });
  if (res.status === 401) throw new Error("Unauthorized (401): the RPA key is missing or invalid. Stopping the worker.");
  if (!res.ok) throw new Error(`Queue poll failed: HTTP ${res.status}`);
  const body = await res.json();
  return Array.isArray(body.search_requests) ? body.search_requests : [];
}

// ---------------------------------------------------------------------
// Search normalization — try variations in order, stop at first result.
// ---------------------------------------------------------------------
function buildSearchVariations(companyName) {
  const exact = companyName.trim();
  const noCommas = exact.replace(/,/g, "").replace(/\s+/g, " ").trim();

  // Attempt 3: strip trailing business suffixes.
  let stripped = noCommas;
  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of BUSINESS_SUFFIXES) {
      const re = new RegExp(`[\\s,.]+${suffix.replace(/\./g, "\\.")}$`, "i");
      if (re.test(stripped)) {
        stripped = stripped.replace(re, "").trim();
        changed = true;
      }
    }
  }

  // Attempt 4: first two meaningful words.
  const words = stripped.split(" ").filter(Boolean);
  const firstTwo = words.slice(0, 2).join(" ");

  // Preserve order, drop empties and duplicates.
  const seen = new Set();
  return [exact, noCommas, stripped, firstTwo]
    .filter((v) => v && v.length > 0)
    .filter((v) => (seen.has(v.toUpperCase()) ? false : (seen.add(v.toUpperCase()), true)));
}

// ---------------------------------------------------------------------
// Power BI search + extraction (the proven live method)
// ---------------------------------------------------------------------
async function extractRows(page) {
  // Iterate all frames; find a table whose TH headers contain both
  // "Business" and "Certificate"; read rows with >= 9 TD cells.
  for (const frame of page.frames()) {
    const rows = await frame
      .evaluate(() => {
        const tables = Array.from(document.querySelectorAll("table"));
        for (const table of tables) {
          const heads = Array.from(table.querySelectorAll("th")).map((th) => (th.textContent || "").trim());
          const hasBusiness = heads.some((h) => /Business/i.test(h));
          const hasCertificate = heads.some((h) => /Certificate/i.test(h));
          if (!hasBusiness || !hasCertificate) continue;
          const bodyRows = Array.from(table.querySelectorAll("tr")).filter((r) => r.querySelectorAll("td").length >= 9);
          return bodyRows.map((r) => Array.from(r.querySelectorAll("td")).map((td) => (td.textContent || "").trim()));
        }
        return null;
      })
      .catch(() => null);
    if (rows && rows.length > 0) return rows;
  }
  return [];
}

function toIsoDate(display) {
  // Convert MM/DD/YYYY -> YYYY-MM-DD. Return null when absent/unparseable.
  if (!display) return null;
  const m = String(display).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const [, mm, dd, yyyy] = m;
  return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
}

function toText(value) {
  const v = value === undefined || value === null ? "" : String(value).trim();
  return v === "" ? null : v;
}

function mapRowToCandidate(cells, sourceUrl) {
  // Column position mapping (proven against the live report).
  const businessName = toText(cells[0]);
  if (!businessName) return null; // a row without a business name is skipped
  return {
    business_name: businessName,
    certificate_number: toText(cells[8]), // text; preserve leading zeros
    registration_date: toIsoDate(cells[1]),
    expiration_date: toIsoDate(cells[2]),
    address: toText(cells[3]),
    city: toText(cells[4]),
    state: toText(cells[5]),
    zip_code: toText(cells[6]),
    county: toText(cells[7]),
    source_url: sourceUrl,
  };
}

// ---------------------------------------------------------------------
// Error classification helpers
// ---------------------------------------------------------------------
const ERROR_CODES = {
  TRANSIENT: "TRANSIENT", // detached element, timeout, re-render, results not updated
  INPUT_NOT_IDENTIFIED: "INPUT_NOT_IDENTIFIED", // Business Name field not found / ambiguous
  BROWSER_CLOSED: "BROWSER_CLOSED",
};

function makeError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

const TRANSIENT_PATTERN =
  /not attached to the DOM|element is detached|frame (?:was|has been|got) detached|Execution context was destroyed|Timeout \d+ms exceeded|net::ERR_|page crashed|Target crashed|Target page, context or browser has been closed/i;
const BROWSER_GONE_PATTERN = /Browser has been closed|browser has disconnected|Browser closed/i;

function isBrowserGone(err, browser) {
  if (err && err.code === ERROR_CODES.BROWSER_CLOSED) return true;
  if (browser && !browser.isConnected()) return true;
  return BROWSER_GONE_PATTERN.test(String((err && err.message) || err));
}

// Returns "browser_closed" | "transient" | "input_not_identified" | "other".
function classifyError(err, browser) {
  if (isBrowserGone(err, browser)) return "browser_closed";
  if (err && err.code === ERROR_CODES.INPUT_NOT_IDENTIFIED) return "input_not_identified";
  if (err && (err.code === ERROR_CODES.TRANSIENT || err.name === "TimeoutError")) return "transient";
  if (TRANSIENT_PATTERN.test(String((err && err.message) || err))) return "transient";
  return "other";
}

// Strip Playwright call logs, redact the report URL/token and the RPA key,
// and cap length. Used for both log lines and the posted error_message.
function sanitizeMessage(err) {
  let msg = String((err && err.message) || err || "Unknown error");
  msg = msg.split(/\n\s*Call log:/i)[0];
  if (CONFIG.reportUrl) msg = msg.split(CONFIG.reportUrl).join("[NJ_PWC_REPORT_URL]");
  if (CONFIG.rpaKey) msg = msg.split(CONFIG.rpaKey).join("[REDACTED]");
  msg = msg.replace(/([?&]r=)[^\s&"']+/g, "$1[REDACTED]");
  msg = msg.replace(/\s+/g, " ").trim();
  return msg.length > 500 ? `${msg.slice(0, 497)}...` : msg;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------
// Business Name input (Locator-based; re-resolved on every action)
// ---------------------------------------------------------------------
function businessIframeLocator(page) {
  return page.locator(BUSINESS_IFRAME_SELECTOR);
}

function businessInputLocator(page) {
  // contentFrame() re-resolves the iframe on every action, so a replaced
  // iframe or input is picked up automatically (no stale handles).
  return businessIframeLocator(page).contentFrame().locator(BUSINESS_INPUT_SELECTOR);
}

// Confirms exactly one Business Name iframe and exactly one input inside it.
// Returns { iframes, inputs }.
async function countBusinessTargets(page) {
  const iframes = await businessIframeLocator(page).count().catch(() => 0);
  if (iframes !== 1) return { iframes, inputs: 0 };
  const inputs = await businessInputLocator(page).count().catch(() => 0);
  return { iframes, inputs };
}

// Snapshot of the results table (first frame table with Business + Certificate
// headers). Used only to detect that the table updated for the current search;
// extraction itself still uses extractRows().
async function readResultsSnapshot(page) {
  for (const frame of page.frames()) {
    const snap = await frame
      .evaluate(() => {
        const tables = Array.from(document.querySelectorAll("table"));
        for (const table of tables) {
          const heads = Array.from(table.querySelectorAll("th")).map((th) => (th.textContent || "").trim());
          if (!heads.some((h) => /Business/i.test(h)) || !heads.some((h) => /Certificate/i.test(h))) continue;
          const rows = Array.from(table.querySelectorAll("tr")).filter((r) => r.querySelectorAll("td").length >= 9);
          return { present: true, rowCount: rows.length, text: rows.map((r) => (r.textContent || "").trim()).join("\u0001") };
        }
        return null;
      })
      .catch(() => null);
    if (snap) return { ...snap, key: `${snap.rowCount}\u0002${snap.text}` };
  }
  return { present: false, rowCount: 0, text: "", key: "absent" };
}

// Wait until the Business Name input is uniquely identifiable and the results
// table has rendered. Returns the baseline results snapshot (pre-search).
async function waitForReportReady(page) {
  const deadline = Date.now() + SEARCH_APPLY_TIMEOUT_MS;
  let last = { iframes: 0, inputs: 0 };
  let snapshot = { present: false, rowCount: 0, key: "absent" };
  while (Date.now() < deadline) {
    last = await countBusinessTargets(page);
    if (last.iframes === 1 && last.inputs === 1) {
      snapshot = await readResultsSnapshot(page);
      if (snapshot.present && snapshot.rowCount > 0) return snapshot;
    }
    await page.waitForTimeout(RESULTS_POLL_MS);
  }
  if (last.iframes !== 1 || last.inputs !== 1) {
    throw makeError(
      `Business Name search field could not be identified confidently (Search Business Name iframes: ${last.iframes}, search inputs in that iframe: ${last.inputs}). Not searching to avoid typing into the Address/Zip/Certificate fields.`,
      ERROR_CODES.INPUT_NOT_IDENTIFIED
    );
  }
  throw makeError(`Results table did not render within ${SEARCH_APPLY_TIMEOUT_MS / 1000}s.`, ERROR_CODES.TRANSIENT);
}

// One fill + verify + Enter attempt using a freshly resolved Locator.
async function applySearchTerm(page, searchTerm) {
  const targets = await countBusinessTargets(page);
  if (targets.iframes > 1 || targets.inputs > 1) {
    throw makeError(
      `Business Name search field is ambiguous (iframes: ${targets.iframes}, inputs: ${targets.inputs}).`,
      ERROR_CODES.INPUT_NOT_IDENTIFIED
    );
  }
  const input = businessInputLocator(page);
  await input.waitFor({ state: "visible", timeout: INPUT_ACTION_TIMEOUT_MS });
  // Require the input to stay attached briefly so we don't act mid re-render.
  await page.waitForTimeout(INPUT_STABLE_MS);
  await input.waitFor({ state: "visible", timeout: INPUT_ACTION_TIMEOUT_MS });
  if (!(await input.isEnabled()) || !(await input.isEditable())) {
    throw makeError("Business Name search field is not enabled/editable yet.", ERROR_CODES.TRANSIENT);
  }

  await input.fill(searchTerm, { timeout: INPUT_ACTION_TIMEOUT_MS });
  const value = await input.inputValue({ timeout: INPUT_ACTION_TIMEOUT_MS });
  if (value !== searchTerm) {
    throw makeError("Business Name search field value did not match the intended search term after fill.", ERROR_CODES.TRANSIENT);
  }
  // Tag the filled element so a re-render between fill and Enter (which would
  // send Enter to a fresh, empty input) can be detected while waiting.
  const marker = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await input.evaluate((el, m) => el.setAttribute("data-subtracker-search", m), marker, { timeout: INPUT_ACTION_TIMEOUT_MS });
  // Press Enter to apply — do NOT click the Power BI Search button (the
  // Clear control overlaps it).
  await input.press("Enter", { timeout: INPUT_ACTION_TIMEOUT_MS });
  return marker;
}

// Wait for evidence the results table updated for this search: its contents
// differ from the pre-search baseline and then stay unchanged for a settle
// window (longer when empty, since re-renders can briefly clear the table).
// If the table is still at baseline and the input was replaced (marker gone)
// without the term, the search never applied: throw a re-apply error.
async function waitForResultsUpdate(page, baseline, searchTerm, marker) {
  const startedAt = Date.now();
  const deadline = startedAt + RESULTS_UPDATE_TIMEOUT_MS;
  let lastKey = null;
  let lastChangeAt = Date.now();
  while (Date.now() < deadline) {
    const snap = await readResultsSnapshot(page);
    if (snap.key !== lastKey) {
      lastKey = snap.key;
      lastChangeAt = Date.now();
    }
    if (snap.key !== baseline.key) {
      const settleMs = snap.present && snap.rowCount > 0 ? RESULTS_STABLE_MS : EMPTY_RESULTS_STABLE_MS;
      if (Date.now() - lastChangeAt >= settleMs) return;
    } else if (Date.now() - startedAt >= 1000) {
      const input = businessInputLocator(page);
      const current = await input
        .evaluate((el) => ({ marker: el.getAttribute("data-subtracker-search"), value: el.value }), null, { timeout: 1000 })
        .catch(() => null);
      if (current && current.marker !== marker && current.value !== searchTerm) {
        throw makeError("Business Name search field was re-rendered before the search applied; re-entering the search term.", ERROR_CODES.TRANSIENT);
      }
    }
    await page.waitForTimeout(RESULTS_POLL_MS);
  }
  const err = makeError(`Results table did not update for the current search within ${RESULTS_UPDATE_TIMEOUT_MS / 1000}s.`, ERROR_CODES.TRANSIENT);
  err.escalate = true; // go straight to the fresh-page retry
  throw err;
}

async function captureFailureScreenshot(page, ctx) {
  if (!page || page.isClosed()) return null;
  try {
    const dir = path.join(path.dirname(path.resolve(CONFIG.logPath)), "screenshots");
    fs.mkdirSync(dir, { recursive: true });
    // One file per request (overwritten) so repeated failures don't accumulate.
    const file = path.join(dir, `request-${ctx.requestId}.png`);
    await page.screenshot({ path: file, fullPage: false, timeout: 10000 });
    return file;
  } catch {
    return null;
  }
}

function logSearchAttempt(ctx, fields) {
  writeLog({
    event: "search_attempt",
    search_request_id: ctx.requestId,
    search_variation: ctx.variation,
    variation_number: ctx.variationNumber,
    ...fields,
  });
}

// Search one term with bounded retries:
//   - up to INPUT_ATTEMPTS fill/verify/Enter attempts per page (Locator
//     re-resolved every attempt) for transient errors;
//   - then ONE retry of the whole search on a fresh page.
// Valid empty results are returned as [] and never retried.
async function searchAndExtract(browser, searchTerm, ctx) {
  let lastError = null;
  for (let pageAttempt = 1; pageAttempt <= PAGE_ATTEMPTS; pageAttempt++) {
    let page = null;
    let inputAttempt = 0;
    try {
      try {
        page = await browser.newPage();
      } catch (err) {
        if (isBrowserGone(err, browser)) throw makeError(sanitizeMessage(err), ERROR_CODES.BROWSER_CLOSED);
        throw err;
      }
      await page.goto(CONFIG.reportUrl, { waitUntil: "domcontentloaded", timeout: SEARCH_APPLY_TIMEOUT_MS });
      const baseline = await waitForReportReady(page);

      for (inputAttempt = 1; inputAttempt <= INPUT_ATTEMPTS; inputAttempt++) {
        try {
          const marker = await applySearchTerm(page, searchTerm);
          await waitForResultsUpdate(page, baseline, searchTerm, marker);
          break;
        } catch (err) {
          const kind = classifyError(err, browser);
          if (kind !== "transient" || err.escalate || inputAttempt === INPUT_ATTEMPTS) throw err;
          logSearchAttempt(ctx, { page_attempt: pageAttempt, input_attempt: inputAttempt, outcome: "input_retry", error_type: kind, message: sanitizeMessage(err) });
          await sleep(INPUT_RETRY_DELAYS_MS[inputAttempt - 1] || 2000);
        }
      }

      const rows = await extractRows(page);
      logSearchAttempt(ctx, { page_attempt: pageAttempt, input_attempt: inputAttempt, outcome: "ok", row_count: rows.length });
      return rows;
    } catch (err) {
      lastError = err;
      const kind = classifyError(err, browser);
      const finalAttempt = kind !== "transient" || pageAttempt === PAGE_ATTEMPTS;
      let screenshot = null;
      if (finalAttempt && kind !== "browser_closed") screenshot = await captureFailureScreenshot(page, ctx);
      logSearchAttempt(ctx, {
        page_attempt: pageAttempt,
        input_attempt: inputAttempt || null,
        outcome: finalAttempt ? "failed" : "page_retry",
        error_type: kind,
        message: sanitizeMessage(err),
        screenshot,
      });
      if (finalAttempt) throw err;
      await sleep(PAGE_RETRY_DELAY_MS);
    } finally {
      if (page) await page.close().catch(() => undefined);
    }
  }
  throw lastError || makeError("Search failed after retries.", ERROR_CODES.TRANSIENT);
}

// ---------------------------------------------------------------------
// Result submission — idempotent by search_request_id; retry POST only.
// ---------------------------------------------------------------------
async function submitResults(requestId, resultStatus, candidates, errorMessage) {
  const url = `${CONFIG.baseUrl}/api/integrations/compliance-sync/search-requests`;
  const payload = {
    search_request_id: requestId,
    result_status: resultStatus,
    candidates,
    error_message: errorMessage || null,
    source_url: CONFIG.reportUrl,
  };

  let lastError = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const res = await fetch(url, { method: "POST", headers: authHeaders(), body: JSON.stringify(payload) });
      const body = await res.json().catch(() => ({}));
      if (res.status === 401) throw Object.assign(new Error("Unauthorized (401): RPA key rejected."), { fatal: true });
      if (res.status === 400 || res.status === 404) {
        // Validation / not-found: do not retry.
        return { ok: false, status: res.status, body, retried: attempt };
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { ok: true, status: res.status, body, retried: attempt };
    } catch (err) {
      lastError = err;
      if (err && err.fatal) throw err;
      if (attempt < RETRY_DELAYS_MS.length) {
        await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
      }
    }
  }
  throw lastError || new Error("Submission failed after retries.");
}

// ---------------------------------------------------------------------
// Per-request processing
// ---------------------------------------------------------------------

// Run the search variations in order, stopping at the first that returns
// rows. A transient failure on one variation does not stop the remaining
// variations; non-transient failures (field not identified, unknown errors)
// stop the loop. A closed browser is rethrown for browser recovery.
async function runSearchVariations(browser, requestId, originalName) {
  const variations = buildSearchVariations(originalName || "");
  const failures = [];
  if (variations.length === 0) return { rows: [], variationUsed: null, failures, invalid: true };

  for (let i = 0; i < variations.length; i++) {
    const term = variations[i];
    const ctx = { requestId, variation: term, variationNumber: i + 1 };
    try {
      const rows = await searchAndExtract(browser, term, ctx);
      if (rows.length > 0) return { rows, variationUsed: term, failures, invalid: false };
    } catch (err) {
      const kind = classifyError(err, browser);
      if (kind === "browser_closed") throw makeError(sanitizeMessage(err), ERROR_CODES.BROWSER_CLOSED);
      failures.push({ variation: term, error_type: kind, message: sanitizeMessage(err) });
      if (kind !== "transient") break;
    }
  }
  return { rows: [], variationUsed: null, failures, invalid: false };
}

// Holds the shared browser and relaunches it when closed/disconnected.
function createBrowserManager() {
  let browser = null;
  return {
    get current() {
      return browser;
    },
    async ensure() {
      if (browser && browser.isConnected()) return browser;
      const relaunch = browser !== null;
      if (browser) await browser.close().catch(() => undefined);
      browser = await chromium.launch({ headless: CONFIG.headless });
      writeLog({ event: relaunch ? "browser_relaunch" : "browser_launch" });
      return browser;
    },
    async relaunch() {
      if (browser) await browser.close().catch(() => undefined);
      browser = null;
      browser = await chromium.launch({ headless: CONFIG.headless });
      writeLog({ event: "browser_relaunch" });
      return browser;
    },
    async close() {
      if (browser) await browser.close().catch(() => undefined);
    },
  };
}

async function processRequest(browserManager, request) {
  const startedAt = Date.now();
  const requestId = request.id;
  const originalName = request.searched_company_name;

  let resultStatus = "No Match Found";
  let candidates = [];
  let errorMessage = null;
  let errorType = null;
  let variationUsed = null;
  let variationFailures = [];
  let browserRelaunched = false;
  let postResult = null;

  try {
    let outcome = null;
    // Browser recovery: if the shared browser closed/disconnected, relaunch
    // it and retry this request ONCE.
    for (let browserAttempt = 1; browserAttempt <= 2; browserAttempt++) {
      const browser = await browserManager.ensure();
      try {
        outcome = await runSearchVariations(browser, requestId, originalName);
        break;
      } catch (err) {
        if (browserAttempt === 1 && isBrowserGone(err, browser)) {
          browserRelaunched = true;
          writeLog({ event: "browser_recovery", search_request_id: requestId, message: sanitizeMessage(err) });
          await browserManager.relaunch();
          continue;
        }
        throw err;
      }
    }

    variationFailures = outcome.failures;
    if (outcome.invalid) {
      resultStatus = "Invalid Search";
      errorType = "invalid_search";
      errorMessage = "Company name is empty after normalization.";
    } else if (outcome.rows.length > 0) {
      variationUsed = outcome.variationUsed;
      candidates = outcome.rows
        .map((cells) => mapRowToCandidate(cells, CONFIG.reportUrl))
        .filter(Boolean)
        .slice(0, MAX_CANDIDATES);
      resultStatus = candidates.length === 1 ? "Match Found" : "Multiple Matches";
    } else if (outcome.failures.length === 0) {
      // Every variation completed and validly returned no rows.
      resultStatus = "No Match Found";
    } else {
      // No rows, and at least one variation failed: do NOT report a
      // (possibly false) "No Match Found".
      const last = outcome.failures[outcome.failures.length - 1];
      errorType = last.error_type;
      if (last.error_type === "transient") {
        resultStatus = "Website Error";
        errorMessage = `Transient worker error after retries (${outcome.failures.length} variation(s) failed; last: "${last.variation}"): ${last.message}`;
      } else if (last.error_type === "input_not_identified") {
        resultStatus = "Website Error";
        errorMessage = last.message;
      } else {
        resultStatus = "RPA Error";
        errorMessage = last.message;
      }
    }
  } catch (err) {
    // Never submit partial candidates after a failed extraction.
    candidates = [];
    errorType = classifyError(err, browserManager.current);
    resultStatus = "RPA Error";
    errorMessage = errorType === "browser_closed"
      ? `Browser closed during search and recovery failed: ${sanitizeMessage(err)}`
      : sanitizeMessage(err);
  }

  // Submit (retry only the POST, not the search).
  try {
    postResult = await submitResults(requestId, resultStatus, candidates, errorMessage);
  } catch (err) {
    postResult = { ok: false, error: sanitizeMessage(err) };
  }

  const durationMs = Date.now() - startedAt;
  writeLog({
    event: "request_processed",
    search_request_id: requestId,
    company_name: originalName,
    search_variation_used: variationUsed,
    result_status: resultStatus,
    error_type: errorType,
    error_message: errorMessage,
    variation_failures: variationFailures,
    browser_relaunched: browserRelaunched,
    candidate_count: candidates.length,
    duration_ms: durationMs,
    post_result: postResult && postResult.ok
      ? { ok: true, status: postResult.status, candidate_count: postResult.body && postResult.body.candidate_count }
      : { ok: false, status: postResult && postResult.status, error: postResult && (postResult.error || (postResult.body && postResult.body.error)) },
  });
}

// ---------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------
async function main() {
  if (!CONFIG.baseUrl || !CONFIG.rpaKey || !CONFIG.reportUrl) {
    console.error("Missing required config. Set SUBTRACKER_BASE_URL, COMPLIANCE_SYNC_RPA_KEY, and NJ_PWC_REPORT_URL in .env.");
    process.exit(1);
  }

  ensureLogDir();
  writeLog({ event: "worker_start", headless: CONFIG.headless, poll_interval_seconds: CONFIG.pollIntervalSeconds });

  const browserManager = createBrowserManager();
  await browserManager.ensure();

  const shutdown = async () => {
    writeLog({ event: "worker_stop" });
    await browserManager.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Sequential processing; one request at a time (v1).
  for (;;) {
    let pending = [];
    try {
      pending = await fetchPendingRequests();
    } catch (err) {
      const msg = String((err && err.message) || err);
      writeLog({ event: "poll_error", message: sanitizeMessage(err) });
      if (/401|Unauthorized/.test(msg)) {
        await browserManager.close();
        process.exit(1);
      }
      await new Promise((r) => setTimeout(r, CONFIG.pollIntervalSeconds * 1000));
      continue;
    }

    if (pending.length === 0) {
      logHeartbeat();
      await new Promise((r) => setTimeout(r, CONFIG.pollIntervalSeconds * 1000));
      continue;
    }

    for (const request of pending) {
      try {
        await processRequest(browserManager, request);
      } catch (err) {
        writeLog({
          event: "request_exception",
          search_request_id: request && request.id,
          message: sanitizeMessage(err),
        });
      }
    }
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Fatal worker error:", sanitizeMessage(err));
    process.exit(1);
  });
}

module.exports = {
  buildSearchVariations,
  classifyError,
  sanitizeMessage,
  isBrowserGone,
  searchAndExtract,
  runSearchVariations,
  processRequest,
  createBrowserManager,
  ERROR_CODES,
  BUSINESS_IFRAME_SELECTOR,
  BUSINESS_INPUT_SELECTOR,
};
