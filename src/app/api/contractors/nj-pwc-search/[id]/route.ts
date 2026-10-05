import { jsonError, requireModulePermission } from "@/lib/server-admin";

// =====================================================================
// NJ PWC contractor search — status / result polling (Add Contractor)
//
// The Add Contractor form polls this endpoint with the search_request_id
// returned by the create endpoint. Returns the request status and, when
// the RPA has posted results, the candidate matches for user selection.
//
// Read-only. Never touches Active Compliance Records.
// =====================================================================

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { admin } = await requireModulePermission(request, "contractors", "manage");

    const { id: idParam } = await context.params;
    const id = Number(idParam);
    if (!Number.isInteger(id) || id <= 0) {
      return Response.json({ error: "id is required." }, { status: 400 });
    }

    const { data: searchRequest, error } = await admin
      .from("compliance_sync_search_requests")
      .select("id, status, result_status, candidates, searched_company_name, error_message, completed_at")
      .eq("id", id)
      .maybeSingle();
    if (error) throw error;
    if (!searchRequest) return Response.json({ error: "Search request not found." }, { status: 404 });

    return Response.json({
      search_request_id: searchRequest.id,
      status: searchRequest.status,
      result_status: searchRequest.result_status,
      candidates: searchRequest.candidates ?? [],
      searched_company_name: searchRequest.searched_company_name,
      error_message: searchRequest.error_message,
      completed_at: searchRequest.completed_at,
    });
  } catch (error) {
    return jsonError(error);
  }
}
