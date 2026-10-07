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

async function searchAndExtract(browser, searchTerm) {
  const page = await browser.newPage();
  try {
    await page.goto(CONFIG.reportUrl, { waitUntil: "domcontentloaded", timeout: SEARCH_APPLY_TIMEOUT_MS });

    // The report visuals render asynchronously. The report contains SIX search
    // inputs (Business Name, Address, City, State, Zip, Certificate) — all share
    // name="search-field", each inside its own iframe. Poll until the Business
    // Name search input actually exists, then target it.
    //
    // The Business Name search is the FIRST search-field visual in document
    // order (it precedes Address/City/State/Zip/Certificate). We identify it via
    // the "Search Business Name" heading in the main document, resolve its
    // iframe to a content frame, and read the textbox from that frame.
    let target = null;
    const deadline = Date.now() + SEARCH_APPLY_TIMEOUT_MS;
    while (!target && Date.now() < deadline) {
      // Resolve the Business Name visual's iframe to its content frame.
      const mainFrame = page.mainFrame();
      const iframeHandle = await mainFrame.evaluateHandle(() => {
        const headings = Array.from(document.querySelectorAll("h1,h2,h3,h4,[role='heading'],span,div"));
        const heading = headings.find((h) => /^\s*Search Business Name\s*$/i.test((h.textContent || "").trim()));
        if (!heading) return null;
        let container = heading;
        for (let i = 0; i < 10 && container; i++) {
          const iframe = container.querySelector ? container.querySelector("iframe") : null;
          if (iframe) return iframe;
          container = container.parentElement;
        }
        return null;
      }).catch(() => null);
      const iframeElement = iframeHandle && (await iframeHandle.asElement());
      if (iframeElement) {
        const businessFrame = await iframeElement.contentFrame().catch(() => null);
        if (businessFrame) {
          target = await businessFrame.$('input[name="search-field"], input[placeholder="Search"]').catch(() => null);
        }
      }
      // Fallback: first search-field across all frames (Business Name is first).
      if (!target) {
        for (const frame of page.frames()) {
          target = await frame.$('input[name="search-field"], input[placeholder="Search"]').catch(() => null);
          if (target) break;
        }
      }
      if (!target) await page.waitForTimeout(500);
    }

    if (!target) {
      const err = new Error("Business-name search input not found on report.");
      err.code = "Invalid Search";
      throw err;
    }

    await target.fill(searchTerm);
    // Press Enter to apply — do NOT click the Power BI Search button (the
    // Clear control overlaps it).
    await target.press("Enter");

    // Wait for the result table to refresh before extracting.
    await page.waitForTimeout(2000); // allow the visual to start refreshing
    await page.waitForLoadState("networkidle", { timeout: SEARCH_APPLY_TIMEOUT_MS }).catch(() => undefined);

    return await extractRows(page);
  } finally {
    await page.close().catch(() => undefined);
  }
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
async function processRequest(browser, request) {
  const startedAt = Date.now();
  const requestId = request.id;
  const originalName = request.searched_company_name;

  let resultStatus = "No Match Found";
  let candidates = [];
  let errorMessage = null;
  let variationUsed = null;
  let postResult = null;

  try {
    // Search normalization: stop at the first variation that returns rows.
    const variations = buildSearchVariations(originalName);
    let rows = [];
    for (const term of variations) {
      rows = await searchAndExtract(browser, term);
      if (rows.length > 0) {
        variationUsed = term;
        break;
      }
    }

    if (rows.length === 0) {
      resultStatus = "No Match Found";
      candidates = [];
    } else {
      candidates = rows
        .map((cells) => mapRowToCandidate(cells, CONFIG.reportUrl))
        .filter(Boolean)
        .slice(0, MAX_CANDIDATES);
      resultStatus = candidates.length === 1 ? "Match Found" : "Multiple Matches";
    }
  } catch (err) {
    // Never submit partial candidates after a failed extraction.
    candidates = [];
    if (err && err.code === "Invalid Search") {
      resultStatus = "Invalid Search";
    } else if (/search input|table|render|load|report/i.test(String(err && err.message))) {
      resultStatus = "Website Error";
    } else {
      resultStatus = "RPA Error";
    }
    errorMessage = String((err && err.message) || err);
  }

  // Submit (retry only the POST, not the search).
  try {
    postResult = await submitResults(requestId, resultStatus, candidates, errorMessage);
  } catch (err) {
    postResult = { ok: false, error: String((err && err.message) || err) };
  }

  const durationMs = Date.now() - startedAt;
  writeLog({
    event: "request_processed",
    search_request_id: requestId,
    company_name: originalName,
    search_variation_used: variationUsed,
    result_status: resultStatus,
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

  const browser = await chromium.launch({ headless: CONFIG.headless });

  const shutdown = async () => {
    writeLog({ event: "worker_stop" });
    await browser.close().catch(() => undefined);
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
      writeLog({ event: "poll_error", message: msg });
      if (/401|Unauthorized/.test(msg)) {
        await browser.close().catch(() => undefined);
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
        await processRequest(browser, request);
      } catch (err) {
        writeLog({
          event: "request_exception",
          search_request_id: request && request.id,
          message: String((err && err.message) || err),
        });
      }
    }
  }
}

main().catch((err) => {
  console.error("Fatal worker error:", err && err.message ? err.message : err);
  process.exit(1);
});
