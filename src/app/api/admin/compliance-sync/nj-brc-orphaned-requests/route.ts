import { AdminApiError, createAdminClient, jsonError, requireModulePermission } from "@/lib/server-admin";
import { isOrphanedNjBrcRequest, orphanAgeThresholdMinutes, type NjBrcOrphanCandidate } from "@/lib/nj-brc-orphan-recovery";
import type { WorkerHealthRow } from "@/lib/worker-health";

const TERMINAL_ERROR_MESSAGE =
  "NJ BRC request was abandoned after its assigned worker instance became inactive; the search result could not be confirmed.";

function configuredAgeThreshold(): number {
  try {
    return orphanAgeThresholdMinutes(process.env.NJ_BRC_ORPHANED_REQUEST_AGE_MINUTES);
  } catch (error) {
    throw new AdminApiError(error instanceof Error ? error.message : "Invalid NJ BRC orphan age configuration.", 503);
  }
}

async function listOrphanedRequests(admin: ReturnType<typeof createAdminClient>, ageThresholdMinutes: number) {
  const [{ data: workerData, error: workerError }, { data: requestData, error: requestError }] = await Promise.all([
    admin.from("compliance_sync_workers").select("*").eq("worker_key", "nj-brc").maybeSingle(),
    admin.from("nj_brc_search_requests")
      .select("id,contractor_id,company_name,status,worker_instance_id,claimed_at,created_at")
      .in("status", ["claimed", "processing"])
      .order("claimed_at", { ascending: true }),
  ]);
  if (workerError) throw workerError;
  if (requestError) throw requestError;

  const currentWorker = workerData as WorkerHealthRow | null;
  const now = Date.now();
  const requests = (requestData ?? []) as NjBrcOrphanCandidate[];
  return requests
    .filter((request) => isOrphanedNjBrcRequest(request, currentWorker, ageThresholdMinutes, now))
    .map((request) => ({
      request_id: request.id,
      contractor_id: request.contractor_id,
      contractor: request.company_name,
      status: request.status,
      claimed_at: request.claimed_at,
      worker_instance_id: request.worker_instance_id,
      created_at: request.created_at,
    }));
}

export async function GET(request: Request) {
  try {
    const { admin } = await requireModulePermission(request, "compliance_sync", "manage");
    const ageThresholdMinutes = configuredAgeThreshold();
    const requests = await listOrphanedRequests(admin, ageThresholdMinutes);
    return Response.json(
      { requests, count: requests.length, age_threshold_minutes: ageThresholdMinutes },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: Request) {
  try {
    const { admin, profile } = await requireModulePermission(request, "compliance_sync", "manage");
    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      throw new AdminApiError("Request body must be valid JSON.", 400);
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new AdminApiError("Request body must be a JSON object.", 400);
    }
    const body = payload as Record<string, unknown>;
    if (Object.keys(body).some((key) => !["request_id", "confirmed"].includes(key))) {
      throw new AdminApiError("Only request_id and confirmed may be submitted.", 400);
    }
    if (typeof body.request_id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.request_id)) {
      throw new AdminApiError("request_id must be a UUID.", 400);
    }
    if (body.confirmed !== true) throw new AdminApiError("Explicit confirmation is required.", 400);

    const { data, error } = await admin.rpc("recover_orphaned_nj_brc_request", {
      p_request_id: body.request_id,
      p_min_age_minutes: configuredAgeThreshold(),
      p_actor_id: profile.auth_user_id,
      p_actor_name: profile.name,
      p_actor_email: profile.email,
      p_error_message: TERMINAL_ERROR_MESSAGE,
    });
    if (error?.code === "55000") {
      throw new AdminApiError("Request no longer meets the orphaned-request cleanup criteria. Refresh the list and try again.", 409);
    }
    if (error) throw error;
    const result = Array.isArray(data) ? data[0] ?? null : data;
    return Response.json({ ok: true, request: result });
  } catch (error) {
    return jsonError(error);
  }
}
