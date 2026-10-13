"use strict";

/* eslint-disable @typescript-eslint/no-require-imports -- Standalone worker uses CommonJS. */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { chromium } = require("playwright");
const { createHealthMonitor } = require("./health");
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

const CONFIG = {
  baseUrl: (process.env.SUBTRACKER_BASE_URL || "").replace(/\/+$/, ""),
  workerKey: process.env.NJ_BRC_WORKER_KEY || "",
  pollIntervalMs: Math.max(5000, Number(process.env.POLL_INTERVAL_SECONDS || 30) * 1000),
  navigationTimeoutMs: Math.max(5000, Number(process.env.NAVIGATION_TIMEOUT_MS || 30000)),
  humanVerificationTimeoutMs: Math.max(10000, Number(process.env.HUMAN_VERIFICATION_TIMEOUT_MS || 300000)),
  maxPreSubmissionRetries: Math.max(0, Math.min(5, Number(process.env.MAX_PRE_SUBMISSION_RETRIES || 2))),
  headless: String(process.env.HEADLESS || "false").toLowerCase() === "true",
  captureMode: String(process.env.NJ_BRC_CAPTURE_MODE || "false").toLowerCase() === "true",
  logPath: process.env.WORKER_LOG_PATH || path.join(__dirname, "logs", "nj-brc-worker.log"),
  lockPath: path.join(__dirname, "worker.lock"),
};

let healthMonitor = null;
let lockToken = null;

class NjBrcApiError extends Error {
  constructor(message, code = "api_error") {
    super(message);
    this.name = "NjBrcApiError";
    this.code = code;
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
    throw new NjBrcApiError("NJ BRC API request failed (network or timeout).", "transport_error");
  }
  if (response.status === 401 || response.status === 403) {
    throw new NjBrcApiError(`NJ BRC API authorization failed (HTTP ${response.status}).`, "unauthorized");
  }
  if (!response.ok) throw new NjBrcApiError(`NJ BRC API request failed (HTTP ${response.status}).`);
  try {
    return await response.json();
  } catch {
    throw new NjBrcApiError("NJ BRC API request failed (invalid response).", "invalid_response");
  }
}

function apiUrl(instanceId) {
  return `${CONFIG.baseUrl}/api/integrations/compliance-sync/nj-brc?instance_id=${encodeURIComponent(instanceId)}`;
}

async function claimRequest(instanceId) {
  const body = await requestJson(apiUrl(instanceId));
  return body && Object.prototype.hasOwnProperty.call(body, "request") ? body.request : null;
}

async function updateRequest(instanceId, payload) {
  return requestJson(apiUrl(instanceId), {
    method: "POST",
    body: JSON.stringify(payload),
  });
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

async function detectProtectionPage(page) {
  const text = (await page.locator("body").innerText({ timeout: 3000 }).catch(() => "")).toLowerCase();
  if (/incapsula|imperva|access denied|request rejected|security incident|unusual traffic|blocked by/.test(text)) {
    return { kind: "website_error", message: "NJ BRC site displayed a protection or access-denied page." };
  }
  return null;
}

async function detectHumanVerification(page) {
  const challenges = page.locator('iframe[src*="recaptcha" i], iframe[src*="hcaptcha" i], iframe[title*="captcha" i]');
  const count = await challenges.count().catch(() => 0);
  let visibleChallenge = false;
  for (let index = 0; index < count; index += 1) {
    const iframe = challenges.nth(index);
    if (!(await iframe.isVisible().catch(() => false))) continue;
    visibleChallenge = true;
    const checked = await iframe
      .contentFrame()
      .getByRole("checkbox")
      .getAttribute("aria-checked", { timeout: 500 })
      .catch(() => null);
    if (checked !== "true") return true;
  }
  if (visibleChallenge) return false;
  const bodyText = (await page.locator("body").innerText({ timeout: 3000 }).catch(() => "")).toLowerCase();
  if (/i am not a robot|verify you are human|human verification required|complete the security check/.test(bodyText)) return true;
  return false;
}

async function classifySourcePage(page, request) {
  if (await detectHumanVerification(page)) {
    return { kind: "human_verification_required" };
  }
  const protection = await detectProtectionPage(page);
  if (protection) return { kind: "website_error", match_rationale: protection.message };
  const visibleText = (await page.locator("body").innerText({ timeout: 3000 }).catch(() => "")).replace(/\s+/g, " ").trim();
  if (/\b(no (?:certificate|registration|records?) (?:were )?found|no match found|no results found)\b/i.test(visibleText)) {
    return { kind: "no_match", match_rationale: "The source page explicitly stated that no matching registration was found." };
  }
  if (/\b(invalid (?:taxpayer id|business entity id|name control)|taxpayer id (?:is )?invalid)\b/i.test(visibleText)) {
    return { kind: "invalid_input", match_rationale: "The source page explicitly rejected a lookup input." };
  }
  const form = page.locator(FORM_SELECTOR);
  if (await form.count() > 0) {
    return { kind: "website_error", match_rationale: "NJ BRC form remained visible after submission without a recognized result." };
  }
  const certificateHeading = page.getByText(/business registration certificate/i);
  const hasCertificateHeading = await certificateHeading.count().catch(() => 0);
  const confirmedLabels = await Promise.all(
    RESULT_LABELS.map((label) => page.getByRole("cell", { name: label, exact: true }).count().catch(() => 0)),
  );
  if (!hasCertificateHeading && confirmedLabels.every((count) => count === 0)) {
    return { kind: "website_error", match_rationale: "NJ BRC source page was not a recognized certificate result." };
  }
  return extractCertificate(page, request);
}

const PAGE_TEXT_MAX = 3000;
const HTML_SNAPSHOT_MAX = 262144;
const SCREENSHOT_BASE64_MAX = 1048576;
const CAPTCHA_SELECTOR = 'iframe, [id*="captcha" i], [class*="captcha" i], [aria-label*="captcha" i], '
  + '[id*="challenge" i], [class*="challenge" i], .g-recaptcha, .h-captcha, .cf-turnstile';

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

function sanitizePageUrl(value) {
  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol)) return null;
    return `${url.origin}${url.pathname.replace(/;jsessionid=[^/]*/gi, "")}`.slice(0, 1000);
  } catch {
    return null;
  }
}

// Captures sanitized evidence of the page left after a submitted lookup ended in
// website_error. The DOM is redacted in place first (the page is discarded
// afterwards), so the screenshot and HTML never contain lookup inputs, CAPTCHA
// frames, scripts, or session tokens.
async function capturePageDiagnostics(page, plan) {
  const secrets = pageDiagnosticSecrets(plan);
  const diagnostics = { captured_at: new Date().toISOString(), page_url: sanitizePageUrl(page.url()) };
  try {
    await page.evaluate(({ digitPatterns, literals, words, captchaSelector }) => {
      const redact = (text) => {
        let safe = String(text || "");
        for (const literal of literals) safe = safe.split(literal).join("[REDACTED]");
        for (const pattern of digitPatterns) {
          safe = safe.replace(new RegExp(`(^|[^0-9])${pattern}(?=[^0-9]|$)`, "g"), "$1[REDACTED TAXPAYER ID]");
        }
        for (const word of words) {
          const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          safe = safe.replace(new RegExp(`(^|[^A-Za-z0-9&-])${escaped}(?=[^A-Za-z0-9&-]|$)`, "gi"), "$1[REDACTED]");
        }
        return safe.replace(/\b\d{2}-\d{7}\b/g, "[REDACTED TAXPAYER ID]")
          .replace(/\b\d{9,12}\b/g, "[REDACTED IDENTIFIER]");
      };
      for (const element of document.querySelectorAll(`script, noscript, object, embed, ${captchaSelector}`)) element.remove();
      for (const control of document.querySelectorAll("input, textarea, select")) {
        const type = (control.getAttribute("type") || "").toLowerCase();
        if (control.tagName === "INPUT" && ["submit", "button", "reset", "image"].includes(type)) continue;
        if (control.tagName === "SELECT") {
          control.selectedIndex = -1;
          continue;
        }
        control.value = "";
        control.removeAttribute("value");
        if (control.tagName === "TEXTAREA") control.textContent = "";
      }
      for (const element of document.querySelectorAll("*")) {
        for (const attribute of [...element.attributes]) {
          if (/^on/i.test(attribute.name)) {
            element.removeAttribute(attribute.name);
            continue;
          }
          let value = attribute.value;
          if (["href", "src", "action", "formaction"].includes(attribute.name.toLowerCase())) {
            value = value.replace(/;jsessionid=[^?#]*/gi, "").replace(/[?#].*$/, "");
          }
          value = redact(value);
          if (value !== attribute.value) element.setAttribute(attribute.name, value);
        }
      }
      const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const value = redact(node.nodeValue);
        if (value !== node.nodeValue) node.nodeValue = value;
      }
      document.title = redact(document.title);
    }, { ...secrets, captchaSelector: CAPTCHA_SELECTOR });

    diagnostics.page_title = redactPageContent(await page.title(), secrets).trim().slice(0, 300) || null;
    const bodyText = await page.locator("body").innerText({ timeout: 3000 }).catch(() => "");
    diagnostics.page_text = redactPageContent(bodyText.replace(/\s+/g, " ").trim(), secrets).slice(0, PAGE_TEXT_MAX) || null;

    const html = redactPageContent(await page.content(), secrets).replace(/<script\b[\s\S]*?<\/script>/gi, "");
    diagnostics.html_snapshot = html.slice(0, HTML_SNAPSHOT_MAX);
    diagnostics.html_truncated = html.length > HTML_SNAPSHOT_MAX;

    for (const quality of [60, 30]) {
      const image = await page.screenshot({
        type: "jpeg",
        quality,
        fullPage: false,
        animations: "disabled",
        timeout: 10000,
        mask: [page.locator('input:not([type="submit" i]):not([type="button" i]):not([type="reset" i]):not([type="image" i]), textarea, select')],
      });
      const data = image.toString("base64");
      if (data.length <= SCREENSHOT_BASE64_MAX) {
        diagnostics.screenshot = { content_type: "image/jpeg", data_base64: data };
        break;
      }
    }
  } catch (error) {
    diagnostics.capture_error = sanitizeMessage(redactPageContent(error?.message || error, secrets));
  }
  return diagnostics;
}

async function fillLookupForm(page, plan, requestId = "") {
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
    if (isSearchSubmit && await candidate.isVisible() && await candidate.isEnabled()) usable.push(candidate);
  }
  writeLog({
    event: "submit_control_diagnostics",
    request_id: requestId,
    message: JSON.stringify({
      candidates: diagnostics,
      matching_submit_locator_count: matchingCount,
      visible_enabled_search_submit_count: usable.length,
    }),
  });
  if (usable.length !== 1) {
    const error = new Error(`NJ BRC lookup form must have exactly one visible, enabled search-submit control (found ${usable.length}).`);
    error.code = "submit_control_invalid";
    throw error;
  }
  return usable[0];
}

async function waitForChallengeToClear(page, request, instanceId, context) {
  const requestId = getRequestId(request);
  let lastOwnershipPoll = 0;
  let reported = false;
  while (await detectHumanVerification(page)) {
    if (!reported) {
      healthMonitor?.humanVerificationRequired(requestId);
      writeLog({ event: "human_verification_required", request_id: requestId, message: "Manual website verification is required." });
      reported = true;
    }
    const remaining = context.challengeDeadline - Date.now();
    if (remaining <= 0) {
      const message = "Human verification timeout reached; request remains recoverable and browser session is retained.";
      writeLog({ event: "human_verification_required", request_id: requestId, message });
      healthMonitor?.event("human_verification_required", message, { request_key: requestId });
      await updateRequest(instanceId, {
        request_id: requestId,
        instance_id: instanceId,
        state: "human_verification_required",
        error_message: message,
      });
      context.challengeDeadline = Date.now() + CONFIG.humanVerificationTimeoutMs;
    }

    if (Date.now() - lastOwnershipPoll >= CONFIG.pollIntervalMs) {
      lastOwnershipPoll = Date.now();
      try {
        const current = await claimRequest(instanceId);
        if (getRequestId(current) === requestId) {
          healthMonitor?.polled();
        } else {
          healthMonitor?.error("Queue ownership confirmation did not return the active request.", requestId);
          writeLog({
            event: "queue_poll",
            request_id: requestId,
            message: "Active human-verification request ownership could not be reconfirmed; no other request will be processed.",
          });
        }
      } catch (error) {
        if (!(error instanceof NjBrcApiError) || error.code === "unauthorized") throw error;
        const message = sanitizeMessage(error);
        healthMonitor?.error(message, requestId);
        writeLog({ event: "queue_poll", request_id: requestId, message });
      }
    }
    await page.waitForTimeout(1000);
  }
  healthMonitor?.humanVerificationCompleted(requestId);
  writeLog({ event: "human_verification_completed", request_id: requestId });
}

async function navigateAndCheck(page) {
  await page.goto(SOURCE_URL, { waitUntil: "domcontentloaded", timeout: CONFIG.navigationTimeoutMs });
  return detectProtectionPage(page);
}

async function prepareSubmission(page, request, plan, instanceId) {
  const attempts = CONFIG.maxPreSubmissionRetries + 1;
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) {
      const protection = await navigateAndCheck(page);
      if (protection) throw new Error(protection.message);
    }
    if (await detectHumanVerification(page)) {
      await waitForChallengeToClear(page, request, instanceId, {
        challengeDeadline: Date.now() + CONFIG.humanVerificationTimeoutMs,
      });
    }
    try {
      return await fillLookupForm(page, plan, getRequestId(request));
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
  if (result.kind === "website_error" && result.page_diagnostics && typeof result.page_diagnostics === "object") {
    const diagnostics = result.page_diagnostics;
    const text = (value, maximum) => (typeof value === "string" ? value.slice(0, maximum) : null);
    sanitized.page_diagnostics = {
      page_url: text(diagnostics.page_url, 1000),
      page_title: text(diagnostics.page_title, 300),
      page_text: text(diagnostics.page_text, PAGE_TEXT_MAX),
      html_snapshot: text(diagnostics.html_snapshot, HTML_SNAPSHOT_MAX),
      html_truncated: diagnostics.html_truncated === true,
      captured_at: text(diagnostics.captured_at, 40),
      capture_error: text(diagnostics.capture_error, 500),
      screenshot: diagnostics.screenshot?.content_type === "image/jpeg"
        && typeof diagnostics.screenshot.data_base64 === "string"
        && diagnostics.screenshot.data_base64.length <= SCREENSHOT_BASE64_MAX
        ? { content_type: "image/jpeg", data_base64: diagnostics.screenshot.data_base64 }
        : null,
    };
  }
  return sanitized;
}

async function submitResult(instanceId, requestId, result) {
  const sanitizedResult = sanitizeResultPayload(result);
  if (
    sanitizedResult.kind === "successful_certificate" &&
    (!sanitizedResult.taxpayer_name || !sanitizedResult.certificate_number ||
      !sanitizedResult.effective_date || !sanitizedResult.source_url || !sanitizedResult.verified_at)
  ) {
    throw new Error("Successful certificate result is missing required evidence.");
  }
  const response = await updateRequest(instanceId, {
    request_id: requestId,
    instance_id: instanceId,
    result: sanitizedResult,
  });
  return response;
}

async function processRequest(context, request, instanceId) {
  const requestId = getRequestId(request);
  await updateRequest(instanceId, {
    request_id: requestId,
    instance_id: instanceId,
    state: "processing",
  });
  healthMonitor?.busy(requestId);
  writeLog({ event: "request_processing", request_id: requestId, message: "Processing claimed NJ BRC request." });

  const plan = createLookupPlan(request);
  if (!plan.ok) {
    const result = finalErrorResult("invalid_input", plan.error);
    await submitResult(instanceId, requestId, result);
    healthMonitor?.event("request_processed", "NJ BRC invalid-input result submitted.", {
      request_key: requestId,
      result_status: result.kind,
    });
    healthMonitor?.event("invalid_input", "NJ BRC request did not contain valid lookup inputs.", {
      request_id: requestId,
    });
    return result;
  }

  const page = await context.newPage();
  let result;
  let submitted = false;
  try {
    await page.goto(SOURCE_URL, { waitUntil: "domcontentloaded", timeout: CONFIG.navigationTimeoutMs });
    if (await detectHumanVerification(page)) {
      await updateRequest(instanceId, {
        request_id: requestId,
        instance_id: instanceId,
        state: "human_verification_required",
      });
      await waitForChallengeToClear(page, request, instanceId, {
        challengeDeadline: Date.now() + CONFIG.humanVerificationTimeoutMs,
      });
    }
    const protection = await detectProtectionPage(page);
    if (protection) {
      result = finalErrorResult("website_error", protection.message);
    } else {
      const submit = await prepareSubmission(page, request, plan, instanceId);
      await submit.click({ timeout: CONFIG.navigationTimeoutMs });
      submitted = true;
      // A click is the sole submission attempt. A navigation timeout is never
      // retried because the source may already have accepted the request.
      await page.waitForLoadState("domcontentloaded", { timeout: CONFIG.navigationTimeoutMs }).catch(() => null);

      if (await detectHumanVerification(page)) {
        await updateRequest(instanceId, {
          request_id: requestId,
          instance_id: instanceId,
          state: "human_verification_required",
        });
        await waitForChallengeToClear(page, request, instanceId, {
          challengeDeadline: Date.now() + CONFIG.humanVerificationTimeoutMs,
        });
      }
      result = await classifySourcePage(page, request);
    }
  } catch (error) {
    if (error instanceof NjBrcApiError) throw error;
    result = finalErrorResult("website_error", sanitizeMessage(error));
    writeLog({ event: "website_error", request_id: requestId, message: sanitizeMessage(error) });
  } finally {
    if (submitted && result?.kind === "website_error" && !page.isClosed()) {
      result.page_diagnostics = await capturePageDiagnostics(page, plan);
      writeLog({
        event: "page_diagnostics_captured",
        request_id: requestId,
        message: JSON.stringify({
          page_text_chars: result.page_diagnostics.page_text?.length || 0,
          html_chars: result.page_diagnostics.html_snapshot?.length || 0,
          screenshot: Boolean(result.page_diagnostics.screenshot),
          capture_error: Boolean(result.page_diagnostics.capture_error),
        }),
      });
    }
    if (!page.isClosed()) await page.close().catch(() => null);
  }

  if (result.kind === "successful_certificate" && plan.warning) {
    result.discrepancy_warnings = [...(result.discrepancy_warnings || []), plan.warning];
  }
  const report = await submitResult(instanceId, requestId, result);
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
    result = {
      ...result,
      kind: "failed",
      match_rationale: "The API did not confirm creation of the required review item.",
    };
    healthMonitor?.error(result.match_rationale, requestId);
  }
  healthMonitor?.event("request_processed", "NJ BRC lookup result submitted.", {
    request_key: requestId,
    result_status: result.kind,
  });
  if (result.kind === "successful_certificate" && persistedStatus === "review_required") {
    healthMonitor?.search(requestId, "Successful Certificate");
  }
  writeLog({ event: "request_processed", request_id: requestId, result_kind: result.kind });
  if (result.kind === "no_match") healthMonitor?.event("no_match", "Source explicitly reported no match.", { request_id: requestId });
  if (result.kind === "identity_mismatch") healthMonitor?.event("identity_mismatch", "Certificate identity differed.", { request_id: requestId });
  if (result.kind === "ambiguous_result") {
    healthMonitor?.event("ambiguous_result", "Certificate evidence requires review.", { request_id: requestId });
  }
  if (result.kind === "website_error") {
    healthMonitor?.websiteError(result.match_rationale || "NJ BRC source result could not be classified.", requestId);
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
      await context.close().catch(() => null);
      await browser.close().catch(() => null);
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
  } catch {
    // Do not delete a lock that cannot be verified as ours.
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
  if (!CONFIG.captureMode && (!CONFIG.baseUrl || !CONFIG.workerKey)) {
    throw new Error("Missing required config. Set SUBTRACKER_BASE_URL and NJ_BRC_WORKER_KEY.");
  }
  if (CONFIG.captureMode && CONFIG.headless) {
    throw new Error("Attended capture requires HEADLESS=false.");
  }
  const instanceId = acquireInstanceLock();
  let browserHandle;
  try {
    browserHandle = await createBrowserContext();
    healthMonitor = CONFIG.captureMode
      ? null
      : createHealthMonitor(
        { baseUrl: CONFIG.baseUrl, workerKey: CONFIG.workerKey },
        () => Boolean(browserHandle?.browser?.isConnected()),
        writeLog,
        sanitizeMessage,
        { instanceId },
      );
    healthMonitor?.start();
    healthMonitor?.ready();
    writeLog({ event: "worker_start", message: "NJ BRC worker started." });

    const shutdown = async () => {
      await healthMonitor?.stop();
      await browserHandle?.close();
      releaseInstanceLock();
      process.exit(0);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);

    if (CONFIG.captureMode) {
      await runCaptureMode(browserHandle);
      return;
    }

    while (true) {
      let request;
      try {
        request = await claimRequest(instanceId);
        healthMonitor?.polled();
        if (!request) {
          healthMonitor?.idle();
          await new Promise((resolve) => setTimeout(resolve, CONFIG.pollIntervalMs));
          continue;
        }
        const requestId = getRequestId(request);
        if (!requestId) throw new Error("Claimed NJ BRC request has no request ID.");
        writeLog({ event: "request_claimed", request_id: requestId, message: "Request claimed." });
        healthMonitor?.busy(requestId);
        const result = await processRequest(browserHandle.context, request, instanceId);
        if (result.kind !== "website_error") healthMonitor?.idle();
      } catch (error) {
        const requestId = getRequestId(request);
        const message = sanitizeMessage(error);
        writeLog({ event: "website_error", request_id: requestId || undefined, message });
        healthMonitor?.error(message, requestId || null);
        if (error instanceof NjBrcApiError && (requestId || error.code === "unauthorized")) {
          await healthMonitor?.stop();
          await browserHandle.close();
          releaseInstanceLock();
          process.exitCode = 1;
          return;
        }
        if (request && requestId) {
          try {
            await updateRequest(instanceId, {
              request_id: requestId,
              instance_id: instanceId,
              result: finalErrorResult("failed", "Internal worker failure; request was not automatically retried."),
            });
            healthMonitor?.event("failed", "Internal worker failure; request was not automatically retried.", {
              request_key: requestId,
            });
          } catch (reportError) {
            writeLog({ event: "failed", request_id: requestId, message: sanitizeMessage(reportError) });
          }
          // Do not reacquire this instance-owned request after an uncertain
          // processing failure; the browser may already have submitted it.
          await healthMonitor?.stop();
          await browserHandle.close();
          releaseInstanceLock();
          process.exitCode = 1;
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, CONFIG.pollIntervalMs));
      }
    }
  } finally {
    if (browserHandle) await browserHandle.close();
    releaseInstanceLock();
  }
}

if (require.main === module) {
  main().catch(async (error) => {
    const message = sanitizeMessage(error);
    writeLog({ event: "website_error", message });
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
  detectHumanVerification,
  classifySourcePage,
  sanitizeResultPayload,
  fillLookupForm,
  capturePageDiagnostics,
  redactPageContent,
  processRequest,
  acquireInstanceLock,
  releaseInstanceLock,
};
