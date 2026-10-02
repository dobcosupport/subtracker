import { createAdminClient, jsonError, writeAdministrationAudit } from "@/lib/server-admin";

// =====================================================================
// Compliance Sync RPA — server-only helpers
//
// SECURITY: The RPA key is read from the server-only environment variable
// COMPLIANCE_SYNC_RPA_KEY. It is never exposed via NEXT_PUBLIC_*, browser
// code, client components, URL query parameters, or logs. The key value
// is never written to the audit log.
// =====================================================================

const RPA_HEADER = "x-subtracker-rpa-key";

export const SYNCABLE_COMPLIANCE_TYPES = ["NJ PWC", "NJ BRC", "NY PWC", "NY BRC"] as const;
export type SyncableComplianceType = (typeof SYNCABLE_COMPLIANCE_TYPES)[number];

export const RESULT_STATUSES = ["Match Found", "No Match Found", "Multiple Matches", "Invalid Search", "Website Error", "RPA Error"] as const;
export type ResultStatus = (typeof RESULT_STATUSES)[number];

export function isSyncableComplianceType(value: unknown): value is SyncableComplianceType {
  return typeof value === "string" && (SYNCABLE_COMPLIANCE_TYPES as readonly string[]).includes(value);
}

export function isResultStatus(value: unknown): value is ResultStatus {
  return typeof value === "string" && (RESULT_STATUSES as readonly string[]).includes(value);
}

export function isValidDateString(value: unknown): value is string {
  if (typeof value !== "string" || value.trim() === "") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed);
}

/**
 * Validates the RPA key from the request header against the server-only
 * environment variable. Returns the admin client on success, or a 401
 * Response on failure (and records an audit entry WITHOUT the key value).
 */
export async function requireRpaKey(request: Request): Promise<{ admin: ReturnType<typeof createAdminClient> } | Response> {
  const admin = createAdminClient();
  const expected = process.env.COMPLIANCE_SYNC_RPA_KEY;
  const provided = request.headers.get(RPA_HEADER);

  const reject = async (): Promise<Response> => {
    await writeAdministrationAudit(admin, null, "RPA authentication rejected", "compliance_sync", null, "Compliance Sync RPA", {
      reason: !provided ? "missing key" : "invalid key",
      path: new URL(request.url).pathname,
    }).catch(() => undefined);
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  };

  if (!expected) {
    await writeAdministrationAudit(admin, null, "RPA authentication rejected", "compliance_sync", null, "Compliance Sync RPA", {
      reason: "server key not configured",
      path: new URL(request.url).pathname,
    }).catch(() => undefined);
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }
  if (!provided || provided !== expected) return reject();

  return { admin };
}

export { jsonError };
