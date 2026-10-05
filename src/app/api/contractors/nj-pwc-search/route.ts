import { jsonError, requireModulePermission } from "@/lib/server-admin";

// =====================================================================
// NJ PWC contractor search — request creation (Add Contractor workflow)
//
// The Add Contractor form POSTs a company name (+ optional city/state/zip)
// to create an attended NJ PWC search request. Power Automate Desktop
// picks up the pending request, queries the NJ Public Works Power BI
// report, and POSTs candidate matches back via the integrations route.
//
// This endpoint creates the request ONLY. It performs no website lookup
// and never touches Active Compliance Records.
// =====================================================================

function normalizeCompanyName(value: unknown): string {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toUpperCase();
}

export async function POST(request: Request) {
  try {
    // Authenticated module user (contractors module, manage) may initiate
    // an attended search. Uses module permission rather than the RPA key.
    const { admin, profile } = await requireModulePermission(request, "contractors", "manage");

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "Request body must be valid JSON." }, { status: 400 });
    }

    const payload = (body ?? {}) as Record<string, unknown>;
    const companyName = normalizeCompanyName(payload.company_name);
    if (companyName.length === 0) {
      return Response.json({ error: "company_name is required." }, { status: 400 });
    }

    const toOptionalText = (value: unknown): string | null =>
      typeof value === "string" && value.trim() !== "" ? value.trim() : null;

    const { data: searchRequest, error: insertError } = await admin
      .from("compliance_sync_search_requests")
      .insert({
        compliance_name: "NJ PWC",
        searched_company_name: companyName,
        searched_zip_code: toOptionalText(payload.zip_code),
        searched_city: toOptionalText(payload.city),
        searched_state: toOptionalText(payload.state),
        status: "pending",
        candidates: [],
        requested_by: profile.name,
        is_test: false,
      })
      .select("id, status, created_at")
      .single();
    if (insertError) throw insertError;

    return Response.json({
      search_request_id: searchRequest.id,
      status: searchRequest.status,
      message: "NJ PWC search request created. Waiting for the registry search to complete.",
    });
  } catch (error) {
    return jsonError(error);
  }
}
