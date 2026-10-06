import { jsonError, requireModulePermission } from "@/lib/server-admin";

// =====================================================================
// NJ PWC contractor search — latest request lookup (Add Contractor)
//
// Returns the current user's most recent NJ PWC search request for an
// exact-normalized company name. Used by the Add Contractor form to
// recover/resume a search when the browser no longer has the request ID
// (page refresh, modal reopened, polling timed out).
//
// Security: requires Contractor Manage permission; only returns requests
// created by the current user; exact company-name match (no fuzzy).
// Read-only. Never touches Active Compliance Records.
// =====================================================================

function normalizeCompanyName(value: unknown): string {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toUpperCase();
}

export async function GET(request: Request) {
  try {
    const { admin, profile } = await requireModulePermission(request, "contractors", "manage");

    const url = new URL(request.url);
    const companyName = normalizeCompanyName(url.searchParams.get("company_name"));
    if (companyName.length === 0) {
      return Response.json({ error: "company_name is required." }, { status: 400 });
    }

    // Newest request first; only this user's requests; exact company name.
    const { data, error } = await admin
      .from("compliance_sync_search_requests")
      .select("id, searched_company_name, status, result_status, candidates, error_message, created_at, completed_at, requested_by")
      .eq("compliance_name", "NJ PWC")
      .eq("searched_company_name", companyName)
      .eq("requested_by", profile.name)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;

    if (!data) {
      return Response.json({ found: false });
    }

    // Audit when a still-pending request is returned so it will be reused
    // instead of creating a duplicate pending request.
    if (data.status === "pending") {
      const { writeAdministrationAudit } = await import("@/lib/server-admin");
      await writeAdministrationAudit(admin, profile, "NJ_PWC_PENDING_REQUEST_REUSED", "compliance_sync", String(data.id), "NJ PWC Search", {
        searched_company_name: data.searched_company_name,
        reused_search_request_id: data.id,
      }).catch(() => undefined);
    }

    return Response.json({
      found: true,
      search_request_id: data.id,
      searched_company_name: data.searched_company_name,
      status: data.status,
      result_status: data.result_status,
      candidates: data.candidates ?? [],
      error_message: data.error_message,
      created_at: data.created_at,
      completed_at: data.completed_at,
    });
  } catch (error) {
    return jsonError(error);
  }
}
