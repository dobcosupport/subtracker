import { requireModulePermission, jsonError } from "@/lib/server-admin";

// Administrator-only connectivity check for the Compliance Sync module.
// Confirms the endpoint is reachable, the user is authenticated and
// authorized, the RPA key is configured, and the required tables exist.
// Does NOT perform any website lookup.
export async function GET(request: Request) {
  try {
    const { admin } = await requireModulePermission(request, "compliance_sync", "view");

    const checks: Record<string, boolean> = {
      authenticated: true,
      rpa_key_configured: Boolean(process.env.COMPLIANCE_SYNC_RPA_KEY),
    };

    const tables = ["compliance_sync_settings", "compliance_sync_runs", "compliance_sync_review_queue", "compliance_sync_exceptions"];
    const missing: string[] = [];
    for (const table of tables) {
      const { error } = await admin.from(table).select("id", { head: true, count: "exact" }).limit(1);
      if (error) missing.push(table);
    }
    checks.tables_exist = missing.length === 0;

    return Response.json({
      ok: checks.authenticated && checks.rpa_key_configured && checks.tables_exist,
      checks,
      missing_tables: missing,
    });
  } catch (error) {
    return jsonError(error);
  }
}
