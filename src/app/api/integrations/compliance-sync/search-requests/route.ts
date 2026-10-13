import { isResultStatus, isValidDateString, jsonError, requireRpaKey } from "@/lib/server-compliance-sync";
import { AdminApiError } from "@/lib/server-admin";
import { njPwcRpcError, firstRpcRow, readJsonObject, positiveInt } from "@/lib/server-nj-pwc-sync";

// =====================================================================
// NJ PWC contractor search — RPA integration
//
// POST : NJ PWC workers claim one request, mark it processing, then complete
//        it under the same worker-instance ownership.
// GET  : Legacy NJ PWC batch polling fails closed to prevent unclaimed work.
//
// User-initiated searches (origin = "user"): this route reads/writes ONLY
// compliance_sync_search_requests; the user later imports a candidate.
// Daily registry sync searches (origin = "daily_sync" / "exception_retry"):
// results are handed to submit_nj_pwc_sync_result(), which classifies the
// result and applies the NJ PWC Mode rules in a single transaction.
// =====================================================================

const MAX_CANDIDATES = 50;

function toTextOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}
function toDateOrNull(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (!isValidDateString(value)) return null;
  return String(value).slice(0, 10);
}

function normalizeCandidate(value: unknown): Record<string, string | null> | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  const businessName = toTextOrNull(row.business_name ?? row.matched_company_name);
  if (!businessName) return null;
  return {
    business_name: businessName,
    certificate_number: toTextOrNull(row.certificate_number),
    registration_date: toDateOrNull(row.registration_date),
    expiration_date: toDateOrNull(row.expiration_date),
    address: toTextOrNull(row.address),
    city: toTextOrNull(row.city),
    state: toTextOrNull(row.state),
    zip_code: toTextOrNull(row.zip_code),
    county: toTextOrNull(row.county),
    source_url: toTextOrNull(row.source_url),
  };
}

// GET /api/integrations/compliance-sync/search-requests?compliance_name=NJ%20PWC
// Returns pending search requests for the RPA to process.
export async function GET(request: Request) {
  try {
    const auth = await requireRpaKey(request);
    if (auth instanceof Response) return auth;
    const { admin } = auth;

    const url = new URL(request.url);
    const complianceName = url.searchParams.get("compliance_name") ?? "NJ PWC";
    if (complianceName === "NJ PWC") {
      return Response.json({ error: "NJ PWC workers must use atomic POST claim; batch polling is disabled." }, { status: 409 });
    }
    const limitParam = Number(url.searchParams.get("limit") ?? "25");
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(Math.floor(limitParam), 100) : 25;

    const { data, error } = await admin
      .from("compliance_sync_search_requests")
      .select("id, compliance_name, searched_company_name, searched_zip_code, searched_city, searched_state, created_at, origin, contractor_id, sync_run_id, priority")
      .eq("compliance_name", complianceName)
      .eq("status", "pending")
      .order("priority", { ascending: true })
      .order("created_at", { ascending: true })
      .limit(limit);
    if (error) throw error;

    return Response.json({ search_requests: data ?? [] });
  } catch (error) {
    return jsonError(error);
  }
}

// POST /api/integrations/compliance-sync/search-requests
// Body: { search_request_id, result_status, candidates?: [...], error_message?, source_url? }
export async function POST(request: Request) {
  try {
    const auth = await requireRpaKey(request);
    if (auth instanceof Response) return auth;
    const { admin } = auth;

    const payload = await readJsonObject(request, [
      "action", "worker_instance_id", "search_request_id", "result_status",
      "candidates", "error_message", "source_url", "search_variation",
    ]);
    const workerId = payload.worker_instance_id;
    if (typeof workerId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(workerId)) {
      throw new AdminApiError("worker_instance_id must be a UUID.", 400);
    }
    if (payload.action === "claim") {
      const { data, error } = await admin.rpc("claim_nj_pwc_request", { p_worker_instance_id: workerId });
      const rpcError = njPwcRpcError(error);
      if (rpcError) throw rpcError;
      if (!Array.isArray(data) || data.length > 1) throw new AdminApiError("NJ PWC claim returned an invalid response.", 500);
      return Response.json({ ok: true, request: data[0] ?? null });
    }
    if (payload.action === "start") {
      const requestId = positiveInt(payload.search_request_id);
      if (!requestId) throw new AdminApiError("search_request_id is invalid.", 400);
      const { error } = await admin.rpc("start_nj_pwc_request", {
        p_request_id: requestId, p_worker_instance_id: workerId,
      });
      const rpcError = njPwcRpcError(error);
      if (rpcError) throw rpcError;
      return Response.json({ ok: true });
    }
    if (payload.action !== undefined && payload.action !== "complete") {
      throw new AdminApiError("action must be claim, start, or complete.", 400);
    }

    const requestId = Number(payload.search_request_id);
    if (!Number.isInteger(requestId) || requestId <= 0) {
      return Response.json({ error: "search_request_id is invalid." }, { status: 400 });
    }
    if (!isResultStatus(payload.result_status)) {
      return Response.json({ error: "result_status is missing or invalid." }, { status: 400 });
    }

    const { data: existing, error: findError } = await admin
      .from("compliance_sync_search_requests")
      .select("id, status, origin, contractor_id")
      .eq("id", requestId)
      .maybeSingle();
    if (findError) throw findError;
    if (!existing) return Response.json({ error: "search_request_id does not reference an existing search request." }, { status: 404 });

    const rawCandidates = Array.isArray(payload.candidates) ? payload.candidates : [];
    const candidates = rawCandidates
      .map(normalizeCandidate)
      .filter((candidate): candidate is Record<string, string | null> => candidate !== null)
      .slice(0, MAX_CANDIDATES);

    const resultStatus = payload.result_status;

    const { data, error } = await admin.rpc("complete_nj_pwc_request", {
      p_request_id: requestId,
      p_worker_instance_id: workerId,
      p_result_status: resultStatus,
      p_candidates: candidates,
      p_error_message: toTextOrNull(payload.error_message),
      p_source_url: toTextOrNull(payload.source_url),
      p_search_variation: toTextOrNull(payload.search_variation)?.slice(0, 40) ?? null,
    });
    const rpcError = njPwcRpcError(error);
    if (rpcError) throw rpcError;
    const row = firstRpcRow<Record<string, unknown>>(data);
    return Response.json({ ok: true, search_request_id: requestId, candidate_count: candidates.length, ...row });
  } catch (error) {
    return jsonError(error);
  }
}
