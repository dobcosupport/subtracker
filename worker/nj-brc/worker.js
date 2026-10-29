"use strict";

/* eslint-disable @typescript-eslint/no-require-imports -- Standalone worker uses CommonJS. */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { chromium } = require("playwright");
const { createHealthMonitor } = require("./health");
const { timingConfig, integerSetting, retryTransient } = require("./runtime");
const { parseBatchId, runAttendedBatch } = require("./batch");
const {
  normalizeFederalTaxIdForNjBrcLookup,
  INVALID_FEIN_MESSAGE,
} = require("./input");

const SOURCE_URL = "https://www1.state.nj.us/TYTR_BRC/jsp/BRCLoginJsp.jsp";
const FORM_SELECTOR = 'form[action="/TYTR_BRC/servlet/common/BRCLogin"]';
// Live NJ BRC form has Submit and Reset as input[type=submit][name=submit]; only value "Submit" searches.
const SUBMIT_SELECTOR = 'input[type="submit" i][name="submit"]';
const SUBMIT_VALUE = "submit";
const SUBMIT_DIAGNOSTIC_SELECTOR = "input, button, [role='button']";
const LABELS = [
  "Taxpayer Name:",
  "Trade Name:",
  "Address:",
  "Certificate Number:",
  "Effective Date:",
  "Date of Issuance:",
  "For Office Use Only",
];
const RESULT_LABELS = LABELS.slice(0, 6);
const RESULT_KINDS = new Set([
  "successful_certificate",
  "no_match",
  "invalid_input",
  "identity_mismatch",
  "ambiguous_result",
  "website_error",
  "failed",
]);
const RESULT_EVIDENCE_FIELDS = [
  "taxpayer_name",
  "trade_name",
  "address",
  "certificate_number",
  "effective_date",
  "date_of_issuance",
  "office_use_only",
  "source_url",
  "verified_at",
  "match_rationale",
  "discrepancy_warnings",
];

loadEnvFile(path.join(__dirname, ".env"));
const TIMING = timingConfig(process.env);

const CONFIG = {
  baseUrl: (process.env.SUBTRACKER_BASE_URL || "").replace(/\/+$/, ""),
  workerKey: process.env.NJ_BRC_WORKER_KEY || "",
  pollIntervalMs: TIMING.normal,
  navigationTimeoutMs: integerSetting(process.env, "NAVIGATION_TIMEOUT_MS", 30000, 5000, 120000),
  humanVerificationTimeoutMs: integerSetting(process.env, "HUMAN_VERIFICATION_TIMEOUT_MS", 300000, 10000, 900000),
  maxPreSubmissionRetries: integerSetting(process.env, "MAX_PRE_SUBMISSION_RETRIES", 2, 0, 5),
  headless: String(process.env.HEADLESS || "true").toLowerCase() === "true",
  captureMode: String(process.env.NJ_BRC_CAPTURE_MODE || "false").toLowerCase() === "true",
  logPath: process.env.WORKER_LOG_PATH || path.join(__dirname, "logs", "nj-brc-worker.log"),
  lockPath: path.join(__dirname, "worker.lock"),
};

let healthMonitor = null;
let lockToken = null;
let stopping = false;
let leaseLost = false;
const wake = new AbortController();
const sleep = (ms) => new Promise((resolve) => {
  if (wake.signal.aborted) return resolve();
  const finish = () => { clearTimeout(timer); wake.signal.removeEventListener("abort", finish); resolve(); };
  const timer = setTimeout(finish, ms);
  wake.signal.addEventListener("abort", finish, { once: true });
});

class NjBrcApiError extends Error {
  constructor(message, code = "api_error", retryable = false) {
    super(message);
    this.name = "NjBrcApiError";
    this.code = code;
    this.retryable = retryable;
  }
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  let content;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    throw new Error("NJ BRC worker .env exists but cannot be read.");
  }
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index < 0) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }
}

function sanitizeMessage(input, maxLength = 500) {
  let message = String(input?.message || input || "Unexpected worker error");
  for (const secret of [CONFIG.workerKey]) {
    if (secret) message = message.split(secret).join("[REDACTED]");
  }
  message = message
    .replace(/\b\d{2}[\s-]?\d{7,10}\b/g, "[REDACTED TAXPAYER ID]")
    .replace(/\b\d{9,12}\b/g, "[REDACTED IDENTIFIER]")
    .replace(/([?&](?:token|key|session|sid|auth|r)=)[^\s&"']+/gi, "$1[REDACTED]")
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/\b(password|authorization|cookie|token|secret|api[_-]?key)\s*[:=]\s*\S+/gi, "$1=[REDACTED]")
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[URL]")
    .replace(/\s+/g, " ")
    .trim();
  return message.length > maxLength ? `${message.slice(0, maxLength - 3)}...` : message;
}

function sanitizeDiagnosticValue(value, sensitiveValues = []) {
  let safeValue = String(value || "");
  for (const secret of [CONFIG.workerKey, ...sensitiveValues]) {
    if (!secret) continue;
    const escaped = String(secret).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    safeValue = safeValue.replace(new RegExp(escaped, "gi"), "[REDACTED]");
  }
  return sanitizeMessage(safeValue);
}

function writeLog(entry) {
  const safe = {
    timestamp: new Date().toISOString(),
    event: String(entry.event || "worker_event").slice(0, 80),
    ...(entry.request_id ? { request_id: String(entry.request_id).slice(0, 80) } : {}),
    ...(entry.state ? { state: String(entry.state).slice(0, 80) } : {}),
    ...(entry.result_kind ? { result_kind: String(entry.result_kind).slice(0, 80) } : {}),
    ...(entry.message ? {
      message: sanitizeMessage(entry.message, entry.event === "submit_control_diagnostics" ? 8000 : 500),
    } : {}),
  };
  const line = JSON.stringify(safe);
  fs.mkdirSync(path.dirname(path.resolve(CONFIG.logPath)), { recursive: true });
  fs.appendFileSync(path.resolve(CONFIG.logPath), `${line}\n`, "utf8");
  console.log(line);
}

function authHeaders() {
  return {
    "x-subtracker-brc-key": CONFIG.workerKey,
    "Content-Type": "application/json",
  };
}

async function requestJson(url, options = {}) {
  let response;
  try {
    response = await fetch(url, {
      ...options,
      headers: { ...authHeaders(), ...(options.headers || {}) },
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new NjBrcApiError("NJ BRC API request failed (network or timeout).", "transport_error", true);
  }
  if (response.status === 401 || response.status === 403) {
    throw new NjBrcApiError(`NJ BRC API authorization failed (HTTP ${response.status}).`, "unauthorized");
  }
  if (!response.ok) {
    throw new NjBrcApiError(`NJ BRC API request failed (HTTP ${response.status}).`,
      response.status === 409 ? "ownership_lost" : "api_error", [408, 429, 500, 502, 503, 504].includes(response.status));
  }
  try {
    return await response.json();
  } catch {
    throw new NjBrcApiError("NJ BRC API request failed (invalid response).", "invalid_response");
  }
}

async function leaseAction(instanceId, action) {
  const result = await requestJson(`${CONFIG.baseUrl}/api/integrations/compliance-sync/nj-brc/lease`, {
    method: "POST", body: JSON.stringify({ instance_id: instanceId, action }),
  });
  if ((action === "release" ? result?.released : result?.owned) !== true) {
    throw new NjBrcApiError("Lease API did not confirm ownership action.", "invalid_response");
  }
  return result;
}

async function confirmOwnership(instanceId) {
  if (leaseLost) throw new NjBrcApiError("Worker lease lost; no further source actions permitted.", "ownership_lost");
  await leaseAction(instanceId, "renew");
}

function apiUrl(instanceId) {
  return `${CONFIG.baseUrl}/api/integrations/compliance-sync/nj-brc?instance_id=${encodeURIComponent(instanceId)}`;
}

async function updateRequest(instanceId, payload) {
  return requestJson(apiUrl(instanceId), {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

async function updateRequestState(instanceId, payload, options) {
  let pausedMs = 0;
  for (;;) {
    try { await updateRequest(instanceId, payload); return pausedMs; } catch (error) {
      if (!(error instanceof NjBrcApiError) || error.code !== "ownership_lost"
        || !await options.onStateConflict?.()) throw error;
      pausedMs += await options.beforeSourceAction?.(true) || 0;
    }
  }
}

function getRequestId(request) {
  return String(request?.id || request?.request_id || "");
}

function createLookupPlan(request) {
  const companyName = typeof request?.company_name === "string" ? request.company_name : "";
  const nameControl = typeof request?.brc_name_control === "string" ? request.brc_name_control : "";
  const submittedTaxpayerId = typeof request?.taxpayer_id_submission === "string"
    ? request.taxpayer_id_submission
    : "";

  if (!submittedTaxpayerId) {
    return {
      ok: false,
      error: "Invalid NJ BRC request: Taxpayer ID (FEIN) is required.",
    };
  }
  if (!/^\d{12}$/.test(submittedTaxpayerId)) {
    return {
      ok: false,
      error: INVALID_FEIN_MESSAGE,
    };
  }
  const prefix = submittedTaxpayerId.slice(0, 9);
  const recomputed = normalizeFederalTaxIdForNjBrcLookup(prefix);
  if (!recomputed.ok || recomputed.taxpayerId !== submittedTaxpayerId) {
    return {
      ok: false,
      error: INVALID_FEIN_MESSAGE,
    };
  }

  if (!companyName.trim()) {
    return { ok: false, error: "Invalid NJ BRC request: company name is missing." };
  }
  if (!nameControl.trim()) {
    return { ok: false, error: "Invalid NJ BRC request: Name Control is missing." };
  }
  if (nameControl.length !== 4 || !/^[A-Za-z0-9&-]{4}$/.test(nameControl)) {
    return { ok: false, error: "Invalid NJ BRC request: Name Control must be four supported characters." };
  }
  return {
    ok: true,
    companyName,
    nameControl,
    lookupKind: "taxpayer_id",
    taxpayerId: submittedTaxpayerId,
  };
}

function normalizedCellText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function parseNjDate(value) {
  const text = normalizedCellText(value);
  if (!text) return null;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  const numeric = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(text);
  let year;
  let month;
  let day;
  if (iso) [, year, month, day] = iso;
  else if (numeric) [, month, day, year] = numeric;
  else {
    const parsed = new Date(text);
    if (Number.isNaN(parsed.getTime())) return null;
    year = String(parsed.getFullYear());
    month = String(parsed.getMonth() + 1);
    day = String(parsed.getDate());
  }
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  const check = new Date(Date.UTC(y, m - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

async function getLabelRow(page, label) {
  const labelCell = page.getByRole("cell", { name: label, exact: true });
  const count = await labelCell.count();
  if (count !== 1) return null;
  return labelCell.locator("xpath=..");
}

async function getRowCells(row) {
  if (!row) return [];
  return row.locator(":scope > td").allTextContents();
}

function boundedText(value, maximum = 4000) {
  const text = normalizedCellText(value);
  return text.length > maximum ? text.slice(0, maximum) : text;
}

async function readLabeledValue(page, label) {
  const row = await getLabelRow(page, label);
  const cells = (await getRowCells(row)).map(normalizedCellText);
  return cells.length > 1 ? boundedText(cells[1]) : "";
}

async function readAddress(page) {
  const row = await getLabelRow(page, "Address:");
  if (!row) return "";
  const firstCells = (await getRowCells(row)).map(normalizedCellText);
  const lines = firstCells.length > 1 && firstCells[1] ? [firstCells[1]] : [];
  const known = new Set(RESULT_LABELS);
  const continuations = row.locator("xpath=following-sibling::tr");
  const count = await continuations.count();
  for (let index = 0; index < count; index += 1) {
    const next = continuations.nth(index);
    const cells = (await getRowCells(next)).map(normalizedCellText);
    if (cells.some((cell) => known.has(cell))) break;
    if (cells.length > 1 && cells[1]) lines.push(cells[1]);
    if (lines.length >= 3) break;
  }
  return boundedText(lines.join(", "));
}

async function readOfficeUseOnly(page) {
  const labelCell = page.getByRole("cell", { name: "For Office Use Only", exact: true });
  if (await labelCell.count() !== 1) return "";
  const table = labelCell.locator("xpath=ancestor::table[1]");
  const row = labelCell.locator("xpath=..");
  const following = row.locator("xpath=following-sibling::tr");
  const count = await following.count();
  for (let index = 0; index < count; index += 1) {
    const cells = (await getRowCells(following.nth(index))).map(normalizedCellText).filter(Boolean);
    if (cells.length) return boundedText(cells.join(" "));
  }
  const nextTable = table.locator("xpath=following::table[1]");
  if (await nextTable.count()) {
    const cells = (await nextTable.locator("tr").first().locator(":scope > td").allTextContents())
      .map(normalizedCellText).filter(Boolean);
    return boundedText(cells.join(" "));
  }
  return "";
}

async function extractCertificate(page, request, verifiedAt = new Date().toISOString()) {
  const values = {};
  for (const label of RESULT_LABELS) {
    const key = {
      "Taxpayer Name:": "taxpayer_name",
      "Trade Name:": "trade_name",
      "Address:": "address",
      "Certificate Number:": "certificate_number",
      "Effective Date:": "effective_date",
      "Date of Issuance:": "date_of_issuance",
    }[label];
    values[key] = label === "Address:" ? await readAddress(page) : await readLabeledValue(page, label);
  }
  values.office_use_only = await readOfficeUseOnly(page);
  const sourceUrl = sanitizeSourceUrl(page.url());
  if (!sourceUrl) {
    return {
      kind: "ambiguous_result",
      match_rationale: "The certificate page source URL was not a confirmed NJ BRC URL.",
    };
  }

  if (!values.taxpayer_name || !values.certificate_number || !values.effective_date) {
    return {
      kind: "ambiguous_result",
      match_rationale: "Certificate labels were incomplete; manual review is required.",
    };
  }
  const effectiveDate = parseNjDate(values.effective_date);
  if (!effectiveDate) {
    return {
      kind: "ambiguous_result",
      match_rationale: "The certificate Effective Date could not be parsed.",
    };
  }

  const intended = normalizeBusinessName(request?.company_name);
  const returned = normalizeBusinessName(values.taxpayer_name);
  const overlap = intended.tokens.filter((token) => returned.tokens.includes(token));
  if (!intended.text || !returned.text) {
    return {
      kind: "ambiguous_result",
      match_rationale: "Taxpayer Name could not be compared with the requested contractor.",
    };
  }
  if (!overlap.length) {
    return {
      kind: "identity_mismatch",
      taxpayer_name: values.taxpayer_name,
      trade_name: values.trade_name || null,
      address: values.address || null,
      certificate_number: values.certificate_number,
      effective_date: effectiveDate,
      date_of_issuance: parseNjDate(values.date_of_issuance),
      office_use_only: values.office_use_only || null,
      match_rationale: "Returned Taxpayer Name has no matching business-name terms.",
      discrepancy_warnings: ["Returned Taxpayer Name does not match the requested contractor name."],
    };
  }

  const sameIdentity = intended.text === returned.text;
  if (!sameIdentity) {
    const kind = overlap.length ? "ambiguous_result" : "identity_mismatch";
    return {
      kind,
      taxpayer_name: values.taxpayer_name,
      trade_name: values.trade_name || null,
      address: values.address || null,
      certificate_number: values.certificate_number,
      effective_date: effectiveDate,
      date_of_issuance: parseNjDate(values.date_of_issuance),
      office_use_only: values.office_use_only || null,
      match_rationale: kind === "identity_mismatch"
        ? "Returned Taxpayer Name has no matching business-name terms."
        : "Returned Taxpayer Name partially overlaps the requested contractor name.",
      discrepancy_warnings: [kind === "identity_mismatch"
        ? "Returned Taxpayer Name does not match the requested contractor."
        : "Returned Taxpayer Name requires manual identity review."],
    };
  }

  return {
    kind: "successful_certificate",
    taxpayer_name: values.taxpayer_name,
    trade_name: values.trade_name || null,
    address: values.address || null,
    certificate_number: values.certificate_number,
    effective_date: effectiveDate,
    date_of_issuance: parseNjDate(values.date_of_issuance),
    office_use_only: values.office_use_only || null,
    source_url: sourceUrl,
    verified_at: verifiedAt,
    match_rationale: sameIdentity
      ? "Returned Taxpayer Name matches the requested contractor name."
      : "Returned Taxpayer Name shares its business-name terms with the requested contractor; manual review required.",
    discrepancy_warnings: sameIdentity ? [] : ["Returned Taxpayer Name is not an exact name match."],
  };
}

function normalizeBusinessName(value) {
  const suffixes = new Set([
    "llc",
    "inc",
    "incorporated",
    "corp",
    "corporation",
    "company",
    "co",
    "ltd",
    "lp",
    "llp",
    "pc",
  ]);
  const tokens = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[.'\u2019]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  while (tokens.length > 1 && suffixes.has(tokens[tokens.length - 1])) tokens.pop();
  return { text: tokens.join(" "), tokens };
}

function sanitizeSourceUrl(value) {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.hostname.toLowerCase() !== "www1.state.nj.us" ||
      (url.port && url.port !== "443") ||
      url.username ||
      url.password ||
      !url.pathname.startsWith("/TYTR_BRC/")
    ) return null;
    return `https://www1.state.nj.us${url.pathname}`;
  } catch {
    return null;
  }
}

async function detectProtectionPage(page, verification = null) {
  const text = (await page.locator("body").innerText({ timeout: 3000 }).catch(() => "")).toLowerCase();
  const frameUrls = page.frames().map((frame) => frame.url()).join(" ").toLowerCase();
  const frameSources = await page.locator("iframe").evaluateAll((frames) => frames.map((frame) => frame.getAttribute("src") || "").join(" "));
  const denied = /access denied|request rejected|security incident|unusual traffic|blocked by/.test(text);
  const verifiedForm = verification?.state === "completed" && await page.locator(FORM_SELECTOR).count() === 1;
  if (denied || (!verifiedForm && (/incapsula|imperva/.test(text)
    || /incapsula|imperva|access.denied/i.test(`${frameUrls} ${frameSources}`)))) {
    return { kind: "website_error", explicit_denial: denied,
      message: "NJ BRC site displayed a protection or access-denied page." };
  }
  return null;
}

async function inspectHumanVerification(page) {
  let completed = false;
  let unknown = false;
  let disabledChallenge = false;
  const pending = [page.mainFrame()];
  while (pending.length) {
    const frame = pending.shift();
    if (frame.isDetached()) continue;
    let visible = true;
    let snapshot;
    try {
      for (let ancestor = frame; ancestor.parentFrame(); ancestor = ancestor.parentFrame()) {
        const element = await ancestor.frameElement();
        try {
          visible = visible && await element.evaluate((node) => {
            const style = getComputedStyle(node);
            return node.getClientRects().length > 0 && style.visibility !== "hidden" && style.display !== "none";
          });
        } finally { await element.dispose(); }
      }
      if (!visible) continue;
      snapshot = await frame.evaluate(() => {
        const visible = (node) => {
          const style = getComputedStyle(node);
          return node.getClientRects().length > 0 && style.visibility !== "hidden" && style.display !== "none";
        };
        return {
          text: document.body?.innerText || "",
          controls: Array.from(document.querySelectorAll('input[type="checkbox"],[role="checkbox"]'))
            .filter(visible).map((node) => ({
              named: /human|robot|captcha|verif/i.test([
                node.getAttribute("aria-label"), node.textContent,
                ...Array.from(node.labels || [], (label) => label.textContent),
              ].join(" ")),
              checked: node.checked === true || node.getAttribute("aria-checked") === "true",
              disabled: node.matches(":disabled") || node.getAttribute("aria-disabled") === "true",
            })),
        };
      });
      pending.push(...frame.childFrames());
    } catch (error) {
      if (isDocumentReplacement(error)) return { state: "navigating" };
      throw error;
    }
    const text = snapshot.text;
    const prompt = /\b(?:i am human|i'm human|i am not a robot|i'm not a robot|verify (?:that )?you are human|human verification required|complete the security check)\b/i.test(text);
    if (/\b(?:select|click|choose) (?:all |each |the |every )?(?:images?|pictures?|tiles?|squares?)\b/i.test(text)) {
      return { state: "required" };
    }
    for (const checkbox of snapshot.controls) {
      if (!prompt && !checkbox.named) continue;
      if (checkbox.checked) completed = true;
      else if (!checkbox.disabled) return { state: "required" };
      else disabledChallenge = true;
    }
    if (/\b(?:verification (?:is )?(?:complete|successful)|you (?:are|have been) verified)\b/i.test(text)) completed = true;
    else if (prompt && !completed) unknown = true;
  }
  return { state: disabledChallenge ? "unknown" : completed ? "completed" : unknown ? "unknown" : "none" };
}

function isDocumentReplacement(error) {
  return /execution context was destroyed|cannot find context|different document|frame was detached|frame has been detached|context.*destroyed|cannot adopt|unable to adopt/i.test(error?.message || "");
}

async function detectHumanVerification(page) {
  return (await inspectHumanVerification(page)).state === "required";
}

async function classifySourcePage(page, request, responseStatus = null) {
  try {
    return await classifyCurrentDocument(page, request, responseStatus);
  } catch (error) {
    if (!isDocumentReplacement(error)) throw error;
    return { kind: "website_error", classification: "unrecognized",
      match_rationale: "NJ document changed during inspection; waiting without replay." };
  }
}

async function classifyCurrentDocument(page, request, responseStatus = null) {
  const verification = await inspectHumanVerification(page);
  if (verification.state === "navigating") {
    return { kind: "website_error", classification: "unrecognized", match_rationale: "NJ page is navigating; waiting for the current document." };
  }
  if (verification.state === "required") {
    return { kind: "human_verification_required", classification: "human_verification" };
  }
  const protection = await detectProtectionPage(page, verification);
  if (protection || responseStatus === 401 || responseStatus === 403) {
    return { kind: "website_error", classification: "protection",
      match_rationale: protection?.message || "NJ BRC source denied access." };
  }
  const visibleText = (await page.locator("body").innerText({ timeout: 3000 }).catch(() => "")).replace(/\s+/g, " ").trim();
  if ([408, 429].includes(responseStatus) || responseStatus >= 500
    || /temporarily unavailable|service unavailable|try again later|bad gateway|gateway timeout|maintenance in progress/i.test(visibleText)) {
    return { kind: "website_error", classification: "temporary_failure", match_rationale: "NJ BRC source is temporarily unavailable; no lookup was automatically resubmitted." };
  }
  if (verification.state === "unknown") {
    return { kind: "website_error", classification: "unrecognized",
      match_rationale: "Possible human verification could not be safely identified as an actionable control." };
  }
  if (/\b(no (?:certificate|registration|records?) (?:were )?found|no match found|no results found)\b/i.test(visibleText)) {
    return { kind: "no_match", classification: "no_result", match_rationale: "The source page explicitly stated that no matching registration was found." };
  }
  if (/\b(invalid (?:taxpayer id|business entity id|name control)|taxpayer id (?:is )?invalid)\b/i.test(visibleText)) {
    return { kind: "invalid_input", match_rationale: "The source page explicitly rejected a lookup input." };
  }
  const certificateHeading = page.getByText(/business registration certificate/i);
  const hasCertificateHeading = await certificateHeading.count().catch(() => 0);
  const confirmedLabels = await Promise.all(
    RESULT_LABELS.map((label) => page.getByRole("cell", { name: label, exact: true }).count().catch(() => 0)),
  );
  const requiredLabels = ["Taxpayer Name:", "Certificate Number:", "Effective Date:", "Date of Issuance:"];
  const strongCertificate = hasCertificateHeading > 0 && await certificateHeading.first().isVisible()
    && (await Promise.all(requiredLabels.map(async (label) => {
      const cell = page.getByRole("cell", { name: label, exact: true });
      return await cell.count() === 1 && await cell.isVisible();
    }))).every(Boolean);
  if (!strongCertificate) {
    for (const form of await page.locator(FORM_SELECTOR).all()) {
      const nameControl = form.locator('input[name="pinnctl"][maxlength="4"]');
      const taxpayerId = form.locator('input[name="pinidnum"][maxlength="12"]');
      if (await form.isVisible() && await nameControl.count() === 1 && await taxpayerId.count() === 1
        && await nameControl.isVisible() && await taxpayerId.isVisible()) {
        return { kind: "website_error", classification: "unrecognized", match_rationale: "NJ BRC form remained visible after submission without a recognized result." };
      }
    }
  }
  if (!hasCertificateHeading && confirmedLabels.every((count) => count === 0)) {
    return { kind: "website_error", classification: "unrecognized", match_rationale: "NJ BRC source page was not a recognized certificate result." };
  }
  return { ...await extractCertificate(page, request), classification: "certificate" };
}

async function waitForResult(page, request, options = {}) {
  const now = options.now || Date.now;
  const pause = options.sleep || ((ms) => page.waitForTimeout(ms));
  let deadline = now() + (options.timeoutMs ?? TIMING.resultWait);
  let result;
  do {
    deadline += await options.beforeSourceAction?.() || 0;
    try {
      result = await classifySourcePage(page, request,
        options.getResponseStatus ? options.getResponseStatus() : options.responseStatus);
    } catch (error) {
      if (!isDocumentReplacement(error)) throw error;
      result = { kind: "website_error", classification: "unrecognized", match_rationale: "NJ document changed while reading the result; no submission was replayed." };
    }
    if (result.kind !== "website_error" || result.classification !== "unrecognized") return result;
    if (now() >= deadline) break;
    await pause(Math.min(250, deadline - now()));
  } while (!page.isClosed());
  return result;
}

const PAGE_TEXT_MAX = 3000;

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function pageDiagnosticSecrets(plan) {
  const taxpayerId = plan?.taxpayerId || "";
  const fein = taxpayerId.slice(0, 9);
  const digitSecrets = [taxpayerId, fein].filter((value) => /^\d{9,12}$/.test(value));
  return {
    // Digit secrets match with any separators, e.g. 00-1234567 or 001 234 567 000.
    digitPatterns: digitSecrets.map((value) => value.split("").join("[\\s.()/-]*")),
    literals: [CONFIG.workerKey].filter(Boolean),
    words: [plan?.nameControl].filter((value) => typeof value === "string" && value.trim()),
  };
}

function redactPageContent(text, secrets) {
  let safe = String(text || "");
  for (const literal of secrets.literals) safe = safe.split(literal).join("[REDACTED]");
  for (const pattern of secrets.digitPatterns) {
    safe = safe.replace(new RegExp(`(^|[^0-9])${pattern}(?=[^0-9]|$)`, "g"), "$1[REDACTED TAXPAYER ID]");
  }
  for (const word of secrets.words) {
    safe = safe.replace(new RegExp(`(^|[^A-Za-z0-9&-])${escapeRegExp(word)}(?=[^A-Za-z0-9&-]|$)`, "gi"), "$1[REDACTED]");
  }
  return safe
    .replace(/\b\d{2}-\d{7}\b/g, "[REDACTED TAXPAYER ID]")
    .replace(/\b\d{9,12}\b/g, "[REDACTED IDENTIFIER]")
    .replace(/;jsessionid=[^\s"'?#/<>]*/gi, "")
    .replace(/([?&](?:token|key|session|sid|auth|r|jsessionid)=)[^\s&"'<>]+/gi, "$1[REDACTED]");
}

function sanitizePageUrl(value, base) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value, base);
    if (!["https:", "http:"].includes(url.protocol)) return null;
    return `${url.origin}${url.pathname.replace(/;jsessionid=[^/]*/gi, "")}`.slice(0, 1000);
  } catch {
    return null;
  }
}

// Retain bounded metadata, never input values, frame contents or page HTML.
async function capturePageDiagnostics(page, plan, metadata = {}) {
  const secrets = pageDiagnosticSecrets(plan);
  const clean = (text, max) => redactPageContent(text, secrets)
    .replace(/Bearer\s+\S+/gi, "[REDACTED]")
    .replace(/\b(password|authorization|cookie|token|secret|api[_-]?key)\s*[:=]\s*\S+/gi, "$1=[REDACTED]")
    .replace(/https?:\/\/[^\s"'<>]+/gi, (url) => sanitizePageUrl(url) || "[URL]").slice(0, max);
  const diagnostics = {
    captured_at: new Date().toISOString(),
    page_url: clean(sanitizePageUrl(page.url()) || "", 1000),
    classification: metadata.classification || "unrecognized",
    stage: metadata.stage || "result",
    response_status: metadata.responseStatus ?? null,
    iframes: [],
  };
  try {
    diagnostics.protection_detected = metadata.classification === "protection" || Boolean(await detectProtectionPage(page));
    diagnostics.human_verification_detected = await detectHumanVerification(page);
    diagnostics.iframe_count = await page.locator("iframe").count();
    for (const frame of await page.locator("iframe").all()) {
      if (diagnostics.iframes.length >= 20) break;
      diagnostics.iframes.push({
        url: clean(sanitizePageUrl(await frame.getAttribute("src"), page.url()) || "", 500),
        title: clean(await frame.getAttribute("title") || "", 200),
        visible: await frame.isVisible(),
      });
    }
    diagnostics.page_title = clean(await page.title(), 300) || null;
    const bodyText = await page.locator("body").innerText({ timeout: 3000 }).catch(() => "");
    diagnostics.page_text = clean(bodyText.replace(/\s+/g, " ").trim(), PAGE_TEXT_MAX) || null;
  } catch (error) {
    diagnostics.capture_error = sanitizeMessage(redactPageContent(error?.message || error, secrets));
  }
  return diagnostics;
}

async function fillLookupForm(page, plan, requestId = "", allowVerificationWait = false) {
  const form = page.locator(FORM_SELECTOR);
  if (await form.count() !== 1) throw new Error("NJ BRC login form could not be identified uniquely.");
  const nameControl = form.locator('input[name="pinnctl"][maxlength="4"]');
  if (await nameControl.count() !== 1) throw new Error("NJ BRC Name Control field could not be identified uniquely.");
  await nameControl.fill(plan.nameControl);

  const taxpayerId = form.locator('input[name="pinidnum"][maxlength="12"]');
  if (await taxpayerId.count() !== 1) throw new Error("NJ BRC Taxpayer ID field could not be identified uniquely.");
  await taxpayerId.fill(plan.taxpayerId);

  const submit = form.locator(SUBMIT_SELECTOR);
  const formHandle = await form.elementHandle();
  const rawDiagnostics = await page.locator(SUBMIT_DIAGNOSTIC_SELECTOR).evaluateAll((elements, lookupFormElement) => {
    return elements.filter((element) => {
      const tag = element.tagName.toLowerCase();
      const type = (element.getAttribute("type") || (tag === "button" ? "submit" : "")).toLowerCase();
      const isCaptchaRelated = element.closest(
        '[id*="captcha" i], [class*="captcha" i], [aria-label*="captcha" i], [id*="challenge" i], [class*="challenge" i]',
      );
      const identifiers = [
        element.id,
        element.getAttribute("name"),
        element.getAttribute("aria-label"),
        element.getAttribute("title"),
      ].join(" ");
      if (isCaptchaRelated || /captcha|recaptcha|hcaptcha|turnstile|challenge/i.test(identifiers)) return false;
      return (tag === "input" && ["submit", "image", "button"].includes(type))
        || tag === "button"
        || element.getAttribute("role") === "button";
    }).map((element) => {
      const tag = element.tagName.toLowerCase();
      const type = (element.getAttribute("type") || (tag === "button" ? "submit" : "")).toLowerCase();
      const associatedForm = element.form || element.closest("form");
      const style = getComputedStyle(element);
      const visible = element.getClientRects().length > 0 && style.visibility !== "hidden" && style.display !== "none";
      const disabled = Boolean(element.disabled) || element.getAttribute("aria-disabled") === "true"
        || element.matches(":disabled");
      const value = tag === "input" ? element.value : element.getAttribute("value");
      const buttonText = tag === "button" || element.getAttribute("role") === "button"
        ? (element.innerText || element.textContent || "").trim()
        : "";
      if (/captcha|human verification|i am human|i'm human|verify you are human|robot|challenge/i.test(`${buttonText} ${value || ""}`)) {
        return null;
      }
      const action = associatedForm?.getAttribute("action") || "";
      let safeAction = null;
      try {
        safeAction = action ? new URL(action, location.href).pathname : null;
      } catch {
        safeAction = "[unrecognized]";
      }
      return {
        tag,
        type,
        name: element.getAttribute("name"),
        id: element.id || null,
        value: value || null,
        visible_button_text: buttonText || null,
        visible,
        enabled: !disabled,
        disabled,
        form_association: associatedForm === lookupFormElement
          ? "nj_brc_lookup"
          : associatedForm
            ? "other_form"
            : "none",
        form_id: associatedForm?.id || null,
        form_action: safeAction,
      };
    }).filter(Boolean);
  }, formHandle);
  const sensitiveValues = [plan.nameControl, plan.taxpayerId];
  const diagnostics = rawDiagnostics.map((candidate) => Object.fromEntries(
    Object.entries(candidate).map(([key, value]) => [
      key,
      typeof value === "string" ? sanitizeDiagnosticValue(value, sensitiveValues) : value,
    ]),
  ));
  const matchingCount = await submit.count();
  const usable = [];
  const canWait = allowVerificationWait && await detectHumanVerification(page);
  let enabledCount = 0;
  for (let index = 0; index < matchingCount; index += 1) {
    const candidate = submit.nth(index);
    const isSearchSubmit = await candidate.evaluate((element, { lookupFormElement, submitValue }) => {
      if (element.tagName.toLowerCase() !== "input") return false;
      if ((element.getAttribute("type") || "").trim().toLowerCase() !== "submit") return false;
      if (element.getAttribute("name") !== "submit") return false;
      if (element.form !== lookupFormElement) return false;
      if ((element.value || "").trim().toLowerCase() !== submitValue) return false;
      const identifiers = [
        element.id,
        element.className,
        element.getAttribute("aria-label"),
        element.getAttribute("title"),
      ].join(" ");
      if (/captcha|recaptcha|hcaptcha|turnstile|challenge/i.test(identifiers)) return false;
      return !element.closest(
        '[id*="captcha" i], [class*="captcha" i], [aria-label*="captcha" i], [id*="challenge" i], [class*="challenge" i]',
      );
    }, { lookupFormElement: formHandle, submitValue: SUBMIT_VALUE });
    if (isSearchSubmit && await candidate.isVisible()) {
      const enabled = await candidate.isEnabled();
      if (enabled) enabledCount++;
      if (enabled || canWait) usable.push(candidate);
    }
  }
  writeLog({
    event: "submit_control_diagnostics",
    request_id: requestId,
    message: JSON.stringify({
      candidates: diagnostics,
      matching_submit_locator_count: matchingCount,
      visible_enabled_search_submit_count: enabledCount,
    }),
  });
  if (usable.length !== 1) {
    const error = new Error(`NJ BRC lookup form must have exactly one visible, enabled search-submit control (found ${usable.length}).`);
    error.code = "submit_control_invalid";
    throw error;
  }
  return usable[0];
}

async function waitForChallengeToClear(page, request, instanceId, options = {}) {
  const requestId = getRequestId(request);
  const now = options.now || Date.now;
  const pause = options.sleep || sleep;
  const monitor = options.healthMonitor || healthMonitor;
  let deadline = options.verificationDeadline ?? now() + (options.verificationTimeoutMs ?? CONFIG.humanVerificationTimeoutMs);
  let lastOwnershipCheck = now();
  const checkActive = () => {
    if (leaseLost || options.hasLostLease?.()) throw new NjBrcApiError("Human-verification ownership lost; no result submission permitted.", "ownership_lost");
    if (stopping || options.isStopping?.()) {
      throw Object.assign(new Error("Worker stopped while awaiting human verification; no lookup was replayed."), { code: "verification_shutdown" });
    }
  };
  checkActive();
  await options.confirmOwnership?.(instanceId);
  deadline += await updateRequestState(instanceId, { request_id: requestId, instance_id: instanceId, state: "human_verification_required" }, options);
  monitor?.humanVerificationRequired(requestId);
  writeLog({ event: "human_verification_required", request_id: requestId,
    message: "Complete human verification manually in the visible browser. Do not click Submit; the worker will continue this lookup once." });
  if (CONFIG.headless) {
    throw Object.assign(new Error("Manual human verification requires an explicitly attended visible browser."), { code: "verification_unavailable" });
  }
  for (;;) {
    checkActive();
    deadline += await options.beforeSourceAction?.() || 0;
    if (now() >= deadline) {
      throw Object.assign(new Error("Manual human verification timed out; request closed without automatic replay."), { code: "verification_timeout" });
    }
    if (now() - lastOwnershipCheck >= TIMING.heartbeat) {
      await options.confirmOwnership?.(instanceId);
      lastOwnershipCheck = now();
    }
    const verification = await inspectHumanVerification(page);
    if (["completed", "none"].includes(verification.state)) {
      const result = await classifySourcePage(page, request);
      if (await page.locator(FORM_SELECTOR).count() === 1
        && !["protection", "temporary_failure"].includes(result.classification)) break;
      if (["certificate", "no_result"].includes(result.classification)) break;
      if (result.classification === "temporary_failure"
        || (result.classification === "protection" && (verification.state === "none"
          || (await detectProtectionPage(page, verification))?.explicit_denial))) break;
      // A checked widget can precede its navigation; retain the bounded wait.
    }
    // Unknown/transitional stages remain attended until a legitimate result or form is available.
    await pause(Math.min(1000, deadline - now()));
  }
  checkActive();
  await options.confirmOwnership?.(instanceId);
  await updateRequestState(instanceId, { request_id: requestId, instance_id: instanceId, state: "processing" }, options);
  monitor?.humanVerificationCompleted(requestId);
  writeLog({ event: "human_verification_completed", request_id: requestId });
}

async function prepareSubmission(page, request, plan, options = {}) {
  const attempts = CONFIG.maxPreSubmissionRetries + 1;
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await options.beforeSourceAction?.(true);
    if (attempt > 0) {
      await page.goto(SOURCE_URL, { waitUntil: "domcontentloaded", timeout: CONFIG.navigationTimeoutMs });
    }
    try {
      return await fillLookupForm(page, plan, getRequestId(request), true);
    } catch (error) {
      lastError = error;
      if (error?.code === "submit_control_invalid") throw error;
      if (attempt + 1 >= attempts) break;
      writeLog({
        event: "request_processing",
        request_id: getRequestId(request),
        message: `Pre-submission form preparation retry ${attempt + 1}.`,
      });
      await page.waitForTimeout(500 * (attempt + 1));
    }
  }
  throw lastError || new Error("NJ BRC form preparation failed.");
}

function finalErrorResult(kind, reason) {
  return { kind, match_rationale: sanitizeMessage(reason) };
}

function sanitizeResultPayload(result) {
  if (!result || !RESULT_KINDS.has(result.kind)) {
    throw new Error("Worker generated an unsupported result kind.");
  }
  const sanitized = { kind: result.kind };
  for (const field of RESULT_EVIDENCE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(result, field)) continue;
    const value = result[field];
    if (field === "discrepancy_warnings") {
      if (Array.isArray(value)) {
        sanitized[field] = value
          .filter((item) => typeof item === "string")
          .slice(0, 20)
          .map((item) => boundedText(item, 2000));
      }
    } else if (field === "source_url") {
      sanitized[field] = sanitizeSourceUrl(value);
    } else if (field === "effective_date" || field === "date_of_issuance") {
      sanitized[field] = value == null ? null : parseNjDate(value);
    } else if (field === "verified_at") {
      const date = new Date(value);
      sanitized[field] = Number.isNaN(date.getTime()) ? null : date.toISOString();
    } else if (value == null) {
      sanitized[field] = null;
    } else if (typeof value === "string") {
      sanitized[field] = boundedText(value);
    }
  }
  if (["website_error", "failed"].includes(result.kind) && result.page_diagnostics && typeof result.page_diagnostics === "object") {
    const diagnostics = result.page_diagnostics;
    const text = (value, maximum) => (typeof value === "string" ? value.slice(0, maximum) : null);
    sanitized.page_diagnostics = {
      page_url: text(diagnostics.page_url, 1000),
      page_title: text(diagnostics.page_title, 300),
      page_text: text(diagnostics.page_text, PAGE_TEXT_MAX),
      captured_at: text(diagnostics.captured_at, 40),
      capture_error: text(diagnostics.capture_error, 500),
      classification: text(diagnostics.classification, 80),
      stage: text(diagnostics.stage, 80),
      response_status: Number.isInteger(diagnostics.response_status) ? diagnostics.response_status : null,
      iframe_count: Number.isInteger(diagnostics.iframe_count) ? diagnostics.iframe_count : 0,
      iframes: Array.isArray(diagnostics.iframes) ? diagnostics.iframes.slice(0, 20).map((frame) => ({
        url: text(frame.url, 500), title: text(frame.title, 200), visible: frame.visible === true,
      })) : [],
      protection_detected: diagnostics.protection_detected === true,
      human_verification_detected: diagnostics.human_verification_detected === true,
    };
  }
  return sanitized;
}

async function submitResult(instanceId, requestId, result, options = {}) {
  const sanitizedResult = sanitizeResultPayload(result);
  if (
    sanitizedResult.kind === "successful_certificate" &&
    (!sanitizedResult.taxpayer_name || !sanitizedResult.certificate_number ||
      !sanitizedResult.effective_date || !sanitizedResult.source_url || !sanitizedResult.verified_at)
  ) {
    throw new Error("Successful certificate result is missing required evidence.");
  }
  const response = await retryTransient(async () => {
    await options.confirmOwnership?.(instanceId);
    return updateRequest(instanceId, { request_id: requestId, instance_id: instanceId, result: sanitizedResult });
  }, {
    attempts: TIMING.resultAttempts, sleep: options.sleep || sleep,
    onRetry: (attempt, delay) => writeLog({ event: "result_retry", request_id: requestId, message: `Reporting retry ${attempt}; delay ${delay}ms.` }),
  });
  if (response.page_diagnostics_stored === false) {
    writeLog({ event: "diagnostics_error", request_id: requestId, message: "API could not retain page diagnostics." });
  }
  return response;
}

async function processRequest(context, request, instanceId, options = {}) {
  const requestId = getRequestId(request);
  const monitor = options.healthMonitor || healthMonitor;
  await options.beforeSourceAction?.(true);
  await updateRequestState(instanceId, {
    request_id: requestId,
    instance_id: instanceId,
    state: "processing",
  }, options);
  monitor?.busy(requestId);
  writeLog({ event: "request_processing", request_id: requestId, message: "Processing claimed NJ BRC request." });

  const plan = createLookupPlan(request);
  if (!plan.ok) {
    const result = finalErrorResult("invalid_input", plan.error);
    await submitResult(instanceId, requestId, result, options);
    monitor?.event("request_processed", "NJ BRC invalid-input result submitted.", {
      request_key: requestId,
      result_status: result.kind,
    });
    monitor?.event("invalid_input", "NJ BRC request did not contain valid lookup inputs.", {
      request_id: requestId,
    });
    return result;
  }

  const page = options.page || await context.newPage();
  let result;
  let stage = "navigation";
  let responseStatus = null;
  let submitted = false;
  let verificationDeadline;
  const sourceGuard = options.beforeSourceAction;
  options = {
    ...options,
    beforeSourceAction: async (force = false) => {
      const pausedMs = await sourceGuard?.(force) || 0;
      if (verificationDeadline) verificationDeadline += pausedMs;
      return pausedMs;
    },
  };
  const sourceSubmission = (sourceRequest) => {
    if (sourceRequest.frame() === page.mainFrame() && sourceRequest.isNavigationRequest()
      && sourceRequest.method() === "POST"
      && sanitizeSourceUrl(sourceRequest.url()) === "https://www1.state.nj.us/TYTR_BRC/servlet/common/BRCLogin") submitted = true;
  };
  const navigationResponse = (response) => {
    if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) responseStatus = response.status();
  };
  const waitForVerification = async () => {
    if (!await detectHumanVerification(page)) return false;
    stage = "human_verification";
    verificationDeadline ??= (options.now || Date.now)() + (options.verificationTimeoutMs ?? CONFIG.humanVerificationTimeoutMs);
    await waitForChallengeToClear(page, request, instanceId, { ...options, verificationDeadline });
    return true;
  };
  const assertOwnership = async () => {
    if (leaseLost || options.hasLostLease?.()) throw new NjBrcApiError("Worker lease lost; no further processing permitted.", "ownership_lost");
    await options.confirmOwnership?.(instanceId);
    await options.beforeSourceAction?.(true);
  };
  const observeResult = async () => {
    stage = "result";
    let observed = await waitForResult(page, request, { ...options, getResponseStatus: () => responseStatus });
    while (observed.kind === "human_verification_required") {
      await waitForVerification();
      stage = "result";
      observed = await waitForResult(page, request, { ...options, getResponseStatus: () => responseStatus });
    }
    return observed;
  };
  page.on("request", sourceSubmission);
  page.on("response", navigationResponse);
  try {
    await assertOwnership();
    await page.goto(SOURCE_URL, { waitUntil: "domcontentloaded", timeout: CONFIG.navigationTimeoutMs });
    // A gate can precede the form. Otherwise fill the validated controls before waiting.
    if (await page.locator(FORM_SELECTOR).count() !== 1) await waitForVerification();
    if (await page.locator(FORM_SELECTOR).count() === 1 && !submitted) {
      stage = "preparation";
      let submit = await prepareSubmission(page, request, plan, options);
      const waited = await waitForVerification();
      const prepared = await classifySourcePage(page, request, responseStatus);
      if (["certificate", "no_result"].includes(prepared.classification) || prepared.kind === "invalid_input") {
        result = prepared;
      } else if (["protection", "temporary_failure"].includes(prepared.classification)
        || (await inspectHumanVerification(page)).state === "unknown") {
        result = prepared;
      } else if (!submitted && await page.locator(FORM_SELECTOR).count() === 1) {
        // Verification may replace the form; revalidate only after a manual wait.
        if (waited) submit = await fillLookupForm(page, plan, requestId);
        if (await detectHumanVerification(page)) {
          throw Object.assign(new Error("Human verification reset before submission; no lookup was sent."), { code: "verification_unrecognized" });
        }
        await assertOwnership();
        if (stopping || options.isStopping?.()) {
          throw Object.assign(new Error("Worker stopped before submission; no lookup was sent."), { code: "verification_shutdown" });
        }
        stage = "submission";
        submitted = true;
        await submit.click({ timeout: CONFIG.navigationTimeoutMs });
        // Never repeat this click, including when a post-submit challenge returns a form.
        await page.waitForLoadState("domcontentloaded", { timeout: CONFIG.navigationTimeoutMs });
      }
    } else {
      result = await classifySourcePage(page, request, responseStatus);
    }
    if (!result) {
      result = await observeResult();
    }
  } catch (error) {
    if (error instanceof NjBrcApiError) throw error;
    if (error.code === "batch_stopped" || error.code === "browser_lost") {
      if (error.code === "browser_lost") throw error;
      result = { ...finalErrorResult("failed", "Batch stopped; current attempt will not be replayed."), classification: "batch_stopped" };
    } else {
    if (!page.isClosed() && (isDocumentReplacement(error)
      || (submitted && (error.name === "TimeoutError" || /timeout|timed out/i.test(error.message))))) {
      result = await observeResult();
    }
    if (!result) {
    if (leaseLost || options.hasLostLease?.()) throw new NjBrcApiError("Lease lost during human verification; no result submitted.", "ownership_lost");
    result = { ...finalErrorResult(error.code === "verification_shutdown" ? "failed" : "website_error", sanitizeMessage(error)),
      classification: error.code?.startsWith("verification_") ? error.code
        : error.name === "TimeoutError" || /ERR_TIMED_OUT|timeout|timed out/i.test(error.message)
        ? "timeout" : stage === "navigation" ? "navigation_failure" : "unrecognized" };
    monitor?.busy(requestId);
    writeLog({ event: "website_error", request_id: requestId, message: sanitizeMessage(error) });
    }
    }
  } finally {
    if (result && ["website_error", "failed"].includes(result.kind) && !page.isClosed()) {
      result.page_diagnostics = await capturePageDiagnostics(page, plan, {
        classification: result.classification, stage, responseStatus,
      });
      writeLog({
        event: "page_diagnostics_captured",
        request_id: requestId,
        message: JSON.stringify({
          page_text_chars: result.page_diagnostics.page_text?.length || 0,
          iframe_count: result.page_diagnostics.iframe_count,
          classification: result.classification,
          capture_error: Boolean(result.page_diagnostics.capture_error),
        }),
      });
    }
    page.removeListener("request", sourceSubmission);
    page.removeListener("response", navigationResponse);
    if (!options.page && !page.isClosed()) await page.close();
  }

  if (result.kind === "successful_certificate" && plan.warning) {
    result.discrepancy_warnings = [...(result.discrepancy_warnings || []), plan.warning];
  }
  const report = await submitResult(instanceId, requestId, result, options);
  if (report.reporting_failure || (report.request?.status === "failed" && result.kind !== "failed")) {
    if (options.page) throw new NjBrcApiError("Result could not be safely persisted; batch paused without replay.", "persistence_failure");
    result = finalErrorResult("failed", "Result reporting failed; retained evidence requires explicit review.");
    monitor?.error(result.match_rationale, requestId);
  }
  const persistedStatus = report?.request?.status;
  if (result.kind === "successful_certificate" && persistedStatus === "identity_mismatch") {
    result = {
      ...result,
      kind: "identity_mismatch",
      match_rationale: "The server-side identity recheck rejected this certificate for the requested contractor.",
      discrepancy_warnings: [
        ...(result.discrepancy_warnings || []),
        "Server-side identity recheck rejected the certificate.",
      ],
    };
  } else if (result.kind === "successful_certificate" && persistedStatus !== "review_required") {
    if (options.page) throw new NjBrcApiError("Required review was not confirmed; batch paused.", "persistence_failure");
    result = {
      ...result,
      kind: "failed",
      match_rationale: "The API did not confirm creation of the required review item.",
    };
    monitor?.error(result.match_rationale, requestId);
  }
  monitor?.event("request_processed", "NJ BRC lookup result submitted.", {
    request_key: requestId,
    result_status: result.kind,
  });
  if (result.kind === "successful_certificate" && persistedStatus === "review_required") {
    monitor?.search(requestId, "Successful Certificate");
  }
  writeLog({ event: "request_processed", request_id: requestId, result_kind: result.kind });
  if (result.kind === "no_match") monitor?.event("no_match", "Source explicitly reported no match.", { request_id: requestId });
  if (result.kind === "identity_mismatch") monitor?.event("identity_mismatch", "Certificate identity differed.", { request_id: requestId });
  if (result.kind === "ambiguous_result") {
    monitor?.event("ambiguous_result", "Certificate evidence requires review.", { request_id: requestId });
  }
  if (result.kind === "website_error") {
    monitor?.websiteError(result.match_rationale || "NJ BRC source result could not be classified.", requestId);
  }
  return result;
}

async function createBrowserContext() {
  const browser = await chromium.launch({ headless: CONFIG.headless });
  const context = await browser.newContext();
  context.setDefaultTimeout(CONFIG.navigationTimeoutMs);
  return {
    browser,
    context,
    async close() {
      for (const [stage, resource] of [["context", context], ["browser", browser]]) {
        try { await resource.close(); } catch (error) {
          process.exitCode = 1;
          writeLog({ event: "browser_close_error", message: `${stage}: ${sanitizeMessage(error)}` });
        }
      }
    },
  };
}

function acquireInstanceLock() {
  fs.mkdirSync(__dirname, { recursive: true });
  const instanceId = crypto.randomUUID();
  lockToken = `${process.pid}:${instanceId}`;
  try {
    const descriptor = fs.openSync(CONFIG.lockPath, "wx", 0o600);
    fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, instance_id: instanceId, started_at: new Date().toISOString() }));
    fs.closeSync(descriptor);
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new Error("NJ BRC worker lock already exists. Confirm the prior process is stopped, then remove the lock manually; stale locks are never reclaimed automatically.");
    }
    throw error;
  }
  return instanceId;
}

function releaseInstanceLock() {
  if (!lockToken || !fs.existsSync(CONFIG.lockPath)) return;
  try {
    const lock = JSON.parse(fs.readFileSync(CONFIG.lockPath, "utf8"));
    if (`${lock.pid}:${lock.instance_id}` === lockToken) fs.unlinkSync(CONFIG.lockPath);
  } catch (error) {
    process.exitCode = 1;
    writeLog({ event: "lock_release_error", message: `Local ownership could not be verified; lock retained. ${sanitizeMessage(error)}` });
  }
  lockToken = null;
}

async function runCaptureMode(browserHandle) {
  const page = await browserHandle.context.newPage();
  await page.goto(SOURCE_URL, { waitUntil: "domcontentloaded", timeout: CONFIG.navigationTimeoutMs });
  const form = page.locator(FORM_SELECTOR);
  const diagnostics = {
    event: "attended_capture",
    source_url: SOURCE_URL,
    form_count: await form.count().catch(() => 0),
    controls: {},
    confirmed_result_labels: {},
    screenshot: path.join(__dirname, "logs", "nj-brc-login-sanitized.png"),
  };
  for (const [key, selector] of Object.entries({
    name_control: 'input[name="pinnctl"][maxlength="4"]',
    taxpayer_id: 'input[name="pinidnum"][maxlength="12"]',
    business_entity_id: 'input[name="pincorpid"][maxlength="10"]',
    casino_entity_id: 'input[name="pincasinoid"][maxlength="7"]',
    submit: SUBMIT_SELECTOR,
  })) {
    diagnostics.controls[key] = await form.locator(selector).count().catch(() => 0);
  }
  for (const label of RESULT_LABELS) {
    diagnostics.confirmed_result_labels[label] = await page.getByRole("cell", { name: label, exact: true }).count().catch(() => 0);
  }
  await page.locator("input, textarea").evaluateAll((controls) => {
    for (const control of controls) {
      control.setAttribute("value", "");
      control.value = "";
      control.style.backgroundColor = "#111";
      control.style.color = "#111";
    }
  }).catch(() => null);
  fs.mkdirSync(path.dirname(diagnostics.screenshot), { recursive: true });
  await page.screenshot({ path: diagnostics.screenshot, fullPage: false });
  writeLog({
    event: "attended_capture",
    message: JSON.stringify({
      source_url: diagnostics.source_url,
      form_count: diagnostics.form_count,
      controls: diagnostics.controls,
      confirmed_result_labels: diagnostics.confirmed_result_labels,
      screenshot: diagnostics.screenshot,
    }),
  });
  console.log("Attended capture mode: manually inspect the visible browser; this mode never fills or submits the form.");
  console.log("Use only an expressly approved known contractor. Do not save certificate screenshots or raw page HTML.");
  while (!page.isClosed()) await page.waitForTimeout(1000);
}

async function main() {
  const batchId = parseBatchId(process.argv.slice(2));
  if (!CONFIG.captureMode && !batchId) {
    throw new Error("No global queue processing is enabled. Start an explicitly selected attended batch with --batch UUID.");
  }
  if (batchId && (CONFIG.headless || CONFIG.captureMode)) {
    throw new Error("An attended verification batch requires HEADLESS=false and NJ_BRC_CAPTURE_MODE=false.");
  }
  if (!CONFIG.captureMode && (!CONFIG.baseUrl || !CONFIG.workerKey)) {
    throw new Error("Missing required config. Set SUBTRACKER_BASE_URL and NJ_BRC_WORKER_KEY.");
  }
  if (CONFIG.captureMode && CONFIG.headless) {
    throw new Error("Attended capture requires HEADLESS=false.");
  }
  const instanceId = acquireInstanceLock();
  let browserHandle;
  let leased = false;
  let shutdownTimer = null;
  const requestShutdown = (reason, failed = false) => {
    if (failed) { leaseLost = true; process.exitCode = 1; }
    if (stopping && !failed) return;
    stopping = true;
    wake.abort();
    writeLog({ event: failed ? "ownership_lost" : "shutdown_requested", message: reason });
    const close = () => {
      void browserHandle?.close().catch((error) => {
        process.exitCode = 1;
        writeLog({ event: "browser_close_error", message: sanitizeMessage(error) });
      });
    };
    if (failed) close();
    else shutdownTimer = setTimeout(close, TIMING.shutdown);
  };
  const interrupt = () => requestShutdown("SIGINT received; draining current request.");
  const terminate = () => requestShutdown("SIGTERM received; draining current request.");
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  try {
    if (!CONFIG.captureMode) {
      await leaseAction(instanceId, "acquire");
      leased = true;
      writeLog({ event: "lease_acquired", message: "Authoritative NJ BRC lease acquired." });
    }
    browserHandle = await createBrowserContext();
    healthMonitor = CONFIG.captureMode
      ? null
      : createHealthMonitor(
        { baseUrl: CONFIG.baseUrl, workerKey: CONFIG.workerKey, heartbeatMs: TIMING.heartbeat },
        () => Boolean(browserHandle?.browser?.isConnected()),
        writeLog,
        sanitizeMessage,
        { instanceId, onLeaseLost: (reason) => requestShutdown(reason, true) },
      );
    healthMonitor?.start();
    healthMonitor?.ready();
    if (healthMonitor && !await healthMonitor.flush()) throw new NjBrcApiError("Initial worker health/lease confirmation failed.", "startup_error");
    writeLog({ event: "worker_start", message: `NJ BRC attended worker started; batch ${batchId || "capture"}, heartbeat ${TIMING.heartbeat}ms. No global queue polling.` });

    if (CONFIG.captureMode) {
      await runCaptureMode(browserHandle);
      return;
    }

    if (batchId) {
      const endpoint = `${CONFIG.baseUrl}/api/integrations/compliance-sync/nj-brc/batch`;
      await runAttendedBatch({
        sessionId: batchId, instanceId, context: browserHandle.context, browser: browserHandle.browser,
        processRequest, confirmOwnership, sleep, log: writeLog,
        isStopping: () => stopping, healthMonitor,
        control: (action, payload = {}) => action === "status"
          ? requestJson(`${endpoint}?instance_id=${encodeURIComponent(instanceId)}&session_id=${encodeURIComponent(batchId)}`)
          : requestJson(endpoint, { method: "POST", body: JSON.stringify({
            instance_id: instanceId, session_id: batchId, action, ...payload,
          }) }),
      });
      return;
    }

  } finally {
    stopping = true;
    clearTimeout(shutdownTimer);
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
    await healthMonitor?.stop();
    if (browserHandle) await browserHandle.close();
    if (leased) {
      try {
        await leaseAction(instanceId, "release");
        writeLog({ event: "lease_released", message: "Lease released; interrupted request closed without replay." });
      } catch (error) {
        process.exitCode = 1;
        writeLog({ event: "lease_release_error", message: sanitizeMessage(error) });
      }
    }
    releaseInstanceLock();
    writeLog({ event: "worker_stop", message: `NJ BRC stopped; exit status ${process.exitCode || 0}.` });
  }
}

if (require.main === module) {
  main().catch(async (error) => {
    const message = sanitizeMessage(error);
    writeLog({ event: "fatal_error", message });
    await healthMonitor?.stop();
    releaseInstanceLock();
    process.exitCode = 1;
  });
}

module.exports = {
  SOURCE_URL,
  FORM_SELECTOR,
  LABELS,
  RESULT_KINDS,
  RESULT_EVIDENCE_FIELDS,
  sanitizeMessage,
  createLookupPlan,
  parseNjDate,
  getLabelRow,
  readLabeledValue,
  readAddress,
  readOfficeUseOnly,
  extractCertificate,
  normalizeBusinessName,
  sanitizeSourceUrl,
  detectProtectionPage,
  inspectHumanVerification,
  detectHumanVerification,
  classifySourcePage,
  waitForResult,
  sanitizeResultPayload,
  fillLookupForm,
  capturePageDiagnostics,
  redactPageContent,
  processRequest,
  isDocumentReplacement,
  acquireInstanceLock,
  releaseInstanceLock,
};
