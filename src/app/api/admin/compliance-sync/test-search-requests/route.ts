import { jsonError, requireModulePermission } from "@/lib/server-admin";

// =====================================================================
// NJ PWC Search Requests endpoint — admin connectivity check.
// Confirms the endpoint is reachable, the user is authenticated and
// authorized, and the compliance_sync_search_requests table exists.
// Performs NO website lookup and never exposes the RPA key (it only
// reports whether the key is configured, never its value).
// =====================================================================

export async function GET(request: Request) {
  try {
    const { admin } = await requireModulePermission(request, "compliance_sync", "view");

    const checks: Record<string, boolean> = {
      authenticated: true,
      rpa_key_configured: Boolean(process.env.COMPLIANCE_SYNC_RPA_KEY),
    };

    const { error: tableError } = await admin
      .from("compliance_sync_search_requests")
      .select("id", { head: true, count: "exact" })
      .limit(1);
    checks.search_requests_table_exists = !tableError;

    return Response.json({
      ok: checks.authenticated && checks.rpa_key_configured && checks.search_requests_table_exists,
      endpoint: "/api/integrations/compliance-sync/search-requests",
      method: "GET (list pending) / POST (submit matches)",
      checks,
    });
  } catch (error) {
    return jsonError(error);
  }
}
