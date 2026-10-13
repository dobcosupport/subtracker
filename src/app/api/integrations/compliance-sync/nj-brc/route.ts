import { AdminApiError, type createAdminClient } from "@/lib/server-admin";
import { isUuid, njBrcBody, njBrcError, redactNjBrcEvidence, requireNjBrcWorkerAuth } from "@/lib/server-nj-brc-worker";

const RESULT_KINDS = ["successful_certificate", "no_match", "invalid_input", "identity_mismatch", "ambiguous_result", "website_error", "failed"];
const TEXT_FIELDS = ["taxpayer_name", "trade_name", "address", "certificate_number", "office_use_only", "match_rationale"];
const RESULT_FIELDS = ["kind", ...TEXT_FIELDS, "effective_date", "date_of_issuance", "source_url", "verified_at", "discrepancy_warnings",
  "page_diagnostics"];
const PAGE_DIAGNOSTIC_FIELDS = ["page_url", "page_title", "page_text", "screenshot", "html_snapshot", "html_truncated", "captured_at",
  "capture_error"];
const PAGE_TEXT_MAX = 3072;
const HTML_SNAPSHOT_MAX = 262144;
const SCREENSHOT_BASE64_MAX = 1048576;

function boundedString(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text ? text.slice(0, maximum) : null;
}

// Post-submission website_error diagnostics are supplemental: malformed parts are
// dropped rather than rejecting the terminal result they accompany.
function normalizePageDiagnostics(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((field) => !PAGE_DIAGNOSTIC_FIELDS.includes(field))) return null;
  const diagnostics: Record<string, unknown> = {};
  if (typeof input.page_url === "string") {
    try {
      const url = new URL(input.page_url);
      if ((url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password) {
        diagnostics.page_url = `${url.origin}${url.pathname.replace(/;jsessionid=[^/?#]*/gi, "")}`.slice(0, 1000);
      }
    } catch {
      // Unparseable URLs are omitted.
    }
  }
  diagnostics.page_title = boundedString(input.page_title, 300);
  diagnostics.page_text = boundedString(input.page_text, PAGE_TEXT_MAX);
  diagnostics.html_snapshot = boundedString(input.html_snapshot, HTML_SNAPSHOT_MAX);
  diagnostics.html_truncated = input.html_truncated === true
    || (typeof input.html_snapshot === "string" && input.html_snapshot.trim().length > HTML_SNAPSHOT_MAX);
  diagnostics.capture_error = boundedString(input.capture_error, 500);
  if (typeof input.captured_at === "string" && Number.isFinite(Date.parse(input.captured_at))) {
    diagnostics.captured_at = new Date(input.captured_at).toISOString();
  }
  const screenshot = input.screenshot as Record<string, unknown> | null | undefined;
  if (screenshot && typeof screenshot === "object" && !Array.isArray(screenshot)
    && (screenshot.content_type === "image/jpeg" || screenshot.content_type === "image/png")
    && typeof screenshot.data_base64 === "string" && screenshot.data_base64.length <= SCREENSHOT_BASE64_MAX
    && /^[A-Za-z0-9+/]+={0,2}$/.test(screenshot.data_base64)) {
    diagnostics.screenshot = { content_type: screenshot.content_type, data_base64: screenshot.data_base64 };
  }
  return Object.values(diagnostics).some((item) => item !== null && item !== false) ? diagnostics : null;
}

function date(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) {
    throw new AdminApiError(`${field} must be a valid YYYY-MM-DD date.`, 400);
  }
  return value;
}

function normalizeResult(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AdminApiError("result must be a JSON object.", 400);
  const input = value as Record<string, unknown>;
  if (typeof input.kind !== "string" || !RESULT_KINDS.includes(input.kind)) throw new AdminApiError("result.kind is invalid.", 400);
  if (Object.keys(input).some((field) => !RESULT_FIELDS.includes(field))) {
    throw new AdminApiError("result contains unsupported fields. Do not submit lookup inputs or raw page content.", 400);
  }
  const evidence: Record<string, unknown> = {};
  for (const field of TEXT_FIELDS) {
    if (input[field] !== undefined && input[field] !== null
      && (typeof input[field] !== "string" || (input[field] as string).length > 4000)) {
      throw new AdminApiError(`result.${field} must be text of at most 4000 characters.`, 400);
    }
    evidence[field] = typeof input[field] === "string" ? input[field].trim() || null : null;
  }
  evidence.effective_date = date(input.effective_date, "result.effective_date");
  evidence.date_of_issuance = date(input.date_of_issuance, "result.date_of_issuance");
  if (input.source_url !== undefined && input.source_url !== null) {
    let url: URL;
    try { url = new URL(String(input.source_url)); } catch { throw new AdminApiError("result.source_url must be an NJ BRC HTTPS URL.", 400); }
    if (url.protocol !== "https:" || url.hostname !== "www1.state.nj.us" || !url.pathname.startsWith("/TYTR_BRC/")
      || url.username || url.password || url.search || url.hash || url.port) {
      throw new AdminApiError("result.source_url must be an NJ BRC HTTPS URL without query parameters or fragments.", 400);
    }
    evidence.source_url = url.href;
  }
  if (input.verified_at !== undefined && input.verified_at !== null) {
    if (typeof input.verified_at !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(input.verified_at)
      || !Number.isFinite(Date.parse(input.verified_at))) {
      throw new AdminApiError("result.verified_at must be an ISO timestamp.", 400);
    }
    date(input.verified_at.slice(0, 10), "result.verified_at");
    evidence.verified_at = new Date(input.verified_at).toISOString();
  }
  if (input.discrepancy_warnings !== undefined
    && (!Array.isArray(input.discrepancy_warnings) || input.discrepancy_warnings.length > 50
      || input.discrepancy_warnings.some((warning) => typeof warning !== "string" || warning.length > 2000))) {
    throw new AdminApiError("result.discrepancy_warnings must be an array of at most 50 text warnings.", 400);
  }
  evidence.discrepancy_warnings = input.discrepancy_warnings ?? [];
  if (input.kind === "successful_certificate"
    && (!evidence.taxpayer_name || !evidence.certificate_number || !evidence.effective_date || !evidence.source_url || !evidence.verified_at)) {
    throw new AdminApiError("A successful certificate requires taxpayer_name, certificate_number, effective_date, source_url, and verified_at.", 400);
  }
  if (input.page_diagnostics !== undefined && input.kind !== "website_error") {
    throw new AdminApiError("result.page_diagnostics is accepted only for website_error results.", 400);
  }
  const pageDiagnostics = input.kind === "website_error" ? normalizePageDiagnostics(input.page_diagnostics) : null;
  return { kind: input.kind, evidence, pageDiagnostics };
}

async function attachPageDiagnostics(
  admin: ReturnType<typeof createAdminClient>,
  requestId: string,
  instanceId: string,
  diagnostics: Record<string, unknown> | null,
  secrets: unknown[],
): Promise<boolean | undefined> {
  if (!diagnostics) return undefined;
  const { screenshot, ...text } = diagnostics;
  const redacted = redactNjBrcEvidence(text, ...secrets) as Record<string, unknown>;
  try {
    const { error } = await admin.rpc("attach_nj_brc_page_diagnostics", {
      p_request_id: requestId,
      p_worker_instance_id: instanceId,
      p_diagnostics: screenshot ? { ...redacted, screenshot } : redacted,
    });
    return !error;
  } catch {
    return false;
  }
}

export async function GET(request: Request) {
  try {
    const auth = await requireNjBrcWorkerAuth(request);
    if (auth instanceof Response) return auth;
    const instanceId = new URL(request.url).searchParams.get("instance_id");
    if (!isUuid(instanceId)) return Response.json({ error: "instance_id must be a UUID." }, { status: 400 });
    const { data, error } = await auth.admin.rpc("claim_nj_brc_search_request", { p_worker_instance_id: instanceId });
    if (error) throw error;
    const claim = Array.isArray(data) ? data[0] ?? null : data;
    const fields = ["id", "contractor_id", "company_name", "nj_brc_number", "brc_name_control", "taxpayer_id_submission",
      "status", "created_at", "claimed_at", "processing_started_at"];
    return Response.json({ request: claim ? Object.fromEntries(fields.filter((field) => claim[field] !== undefined)
      .map((field) => [field, claim[field]])) : null });
  } catch (error) {
    return njBrcError(error);
  }
}

export async function POST(request: Request) {
  try {
    const auth = await requireNjBrcWorkerAuth(request);
    if (auth instanceof Response) return auth;
    const payload = await njBrcBody(request);
    if (!isUuid(payload.request_id)) return Response.json({ error: "request_id must be a UUID." }, { status: 400 });
    if (!isUuid(payload.instance_id)) return Response.json({ error: "instance_id must be a UUID." }, { status: 400 });
    if (Object.keys(payload).some((key) => !["request_id", "instance_id", "state", "result", "error_message"].includes(key))) {
      return Response.json({ error: "Worker payload contains unsupported fields." }, { status: 400 });
    }
    if (payload.result !== undefined) {
      if (payload.state !== undefined || payload.error_message !== undefined) {
        return Response.json({ error: "Submit either a state transition or a terminal result, not both." }, { status: 400 });
      }
      const result = normalizeResult(payload.result);
      const { data: snapshot, error: snapshotError } = await auth.admin.from("nj_brc_search_requests")
        .select("federal_tax_id,taxpayer_id_submission").eq("id", payload.request_id).maybeSingle();
      if (snapshotError) throw snapshotError;
      const secrets = [snapshot?.federal_tax_id, snapshot?.taxpayer_id_submission];
      const evidence = redactNjBrcEvidence(result.evidence, ...secrets);
      const { data, error } = await auth.admin.rpc("report_nj_brc_search_result", {
        p_request_id: payload.request_id, p_worker_instance_id: payload.instance_id,
        p_result_type: result.kind, p_evidence: evidence, p_error_code: result.kind === "successful_certificate" ? null : result.kind,
      });
      if (error && result.kind === "website_error") {
        const safeEvidence = evidence && typeof evidence === "object" && !Array.isArray(evidence)
          ? evidence as Record<string, unknown>
          : {};
        const { data: terminalError, error: terminalErrorFailure } = await auth.admin.rpc("store_nj_brc_terminal_error", {
          p_request_id: payload.request_id,
          p_worker_instance_id: payload.instance_id,
          p_error_code: "website_error",
          p_error_message: typeof safeEvidence.match_rationale === "string"
            ? safeEvidence.match_rationale
            : "NJ BRC website lookup failed.",
        });
        if (terminalErrorFailure) throw terminalErrorFailure;
        const stored = await attachPageDiagnostics(auth.admin, payload.request_id, payload.instance_id, result.pageDiagnostics, secrets);
        return Response.json({
          ok: true,
          request: Array.isArray(terminalError) ? terminalError[0] ?? null : terminalError,
          terminal_error_fallback: true,
          ...(stored === undefined ? {} : { page_diagnostics_stored: stored }),
        });
      }
      if (error) throw error;
      const stored = await attachPageDiagnostics(auth.admin, payload.request_id, payload.instance_id, result.pageDiagnostics, secrets);
      return Response.json({
        ok: true,
        request: Array.isArray(data) ? data[0] ?? null : data,
        ...(stored === undefined ? {} : { page_diagnostics_stored: stored }),
      });
    }
    if (payload.state !== "processing" && payload.state !== "human_verification_required") {
      return Response.json({ error: "state must be processing or human_verification_required, or submit result." }, { status: 400 });
    }
    if (payload.error_message !== undefined && (typeof payload.error_message !== "string" || payload.error_message.length > 2000)) {
      return Response.json({ error: "error_message must be text of at most 2000 characters." }, { status: 400 });
    }
    const { data, error } = await auth.admin.rpc("set_nj_brc_search_request_state", {
      p_request_id: payload.request_id, p_worker_instance_id: payload.instance_id, p_status: payload.state,
    });
    if (error) throw error;
    return Response.json({ ok: true, request: data });
  } catch (error) {
    return njBrcError(error);
  }
}
