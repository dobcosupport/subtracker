import { isResultStatus, isValidDateString, jsonError, requireRpaKey } from "@/lib/server-compliance-sync";
import { writeAdministrationAudit } from "@/lib/server-admin";

// =====================================================================
// NJ PWC contractor search — RPA integration
//
// GET  : Power Automate Desktop polls for pending NJ PWC search requests.
// POST : PAD submits the candidate matches found on the NJ Public Works
//        Power BI report for a given search request.
//
// COMPLIANCE LOGIC LOCK: this route reads/writes ONLY
// compliance_sync_search_requests. It never touches contractors or
// Active Compliance Records.
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
    const limitParam = Number(url.searchParams.get("limit") ?? "25");
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(Math.floor(limitParam), 100) : 25;

    const { data, error } = await admin
      .from("compliance_sync_search_requests")
      .select("id, compliance_name, searched_company_name, searched_zip_code, searched_city, searched_state, created_at")
      .eq("compliance_name", complianceName)
      .eq("status", "pending")
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

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "Request body must be valid JSON." }, { status: 400 });
    }
    const payload = (body ?? {}) as Record<string, unknown>;

    const requestId = Number(payload.search_request_id);
    if (!Number.isInteger(requestId) || requestId <= 0) {
      return Response.json({ error: "search_request_id is invalid." }, { status: 400 });
    }
    if (!isResultStatus(payload.result_status)) {
      return Response.json({ error: "result_status is missing or invalid." }, { status: 400 });
    }

    const { data: existing, error: findError } = await admin
      .from("compliance_sync_search_requests")
      .select("id, status")
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
    const status =
      resultStatus === "No Match Found" ? "no_match"
      : resultStatus === "Match Found" || resultStatus === "Multiple Matches" ? "completed"
      : "failed";

    const { error: updateError } = await admin
      .from("compliance_sync_search_requests")
      .update({
        status,
        result_status: resultStatus,
        candidates,
        error_message: toTextOrNull(payload.error_message),
        source_url: toTextOrNull(payload.source_url),
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", requestId);
    if (updateError) throw updateError;

    await writeAdministrationAudit(admin, null, "NJ_PWC_SEARCH_RESULT_SUBMITTED", "compliance_sync", String(requestId), "NJ PWC Search", {
      result_status: resultStatus,
      candidate_count: candidates.length,
    }).catch(() => undefined);

    return Response.json({ ok: true, search_request_id: requestId, status, candidate_count: candidates.length });
  } catch (error) {
    return jsonError(error);
  }
}
