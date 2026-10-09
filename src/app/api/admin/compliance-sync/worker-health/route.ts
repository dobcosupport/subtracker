import { randomUUID } from "node:crypto";
import { AdminApiError, jsonError, requireModulePermission, writeAdministrationAudit } from "@/lib/server-admin";
import { classifyWorker, overallWorkerHealth, type WorkerHealthRow } from "@/lib/worker-health";

export async function GET(request: Request) {
  try {
    const { admin } = await requireModulePermission(request, "compliance_sync", "view");
    const workerKey = new URL(request.url).searchParams.get("logs");
    if (workerKey) {
      if (!["nj-pwc", "ny"].includes(workerKey)) throw new AdminApiError("Unknown worker.", 400);
      const { data, error } = await admin.from("compliance_sync_worker_events")
        .select("id, received_at, event, message, request_id").eq("worker_key", workerKey).order("id", { ascending: false }).limit(50);
      if (error) throw error;
      return Response.json({ events: data }, { headers: { "Cache-Control": "no-store" } });
    }
    const { data, error } = await admin.from("compliance_sync_workers").select("*").order("worker_key");
    if (error) throw error;
    const rows = (data ?? []) as WorkerHealthRow[];
    const now = Date.now();
    return Response.json({
      overall: overallWorkerHealth(rows, now),
      workers: rows.map((row) => ({
        worker_key: row.worker_key, display_name: row.display_name, enabled: row.enabled,
        started_at: row.started_at, last_heartbeat_at: row.last_heartbeat_at, last_poll_at: row.last_poll_at,
        file_modified_at: row.file_modified_at, last_search_at: row.last_search_at,
        last_search_request_id: row.last_search_request_id, last_search_result: row.last_search_result,
        last_error_at: row.last_error_at, last_error: row.last_error, current_request_id: row.current_request_id,
        ...classifyWorker(row, now),
      })),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return jsonError(error); }
}

export async function POST(request: Request) {
  try {
    const { admin, profile } = await requireModulePermission(request, "compliance_sync", "manage");
    const payload: unknown = await request.json().catch(() => null);
    const workerKey = payload && typeof payload === "object" && "worker_key" in payload ? payload.worker_key : null;
    if (typeof workerKey !== "string" || !["nj-pwc", "ny"].includes(workerKey)) throw new AdminApiError("Unknown worker.", 400);
    const { data, error } = await admin.from("compliance_sync_workers").select("*").eq("worker_key", workerKey).single();
    if (error) throw error;
    if (!classifyWorker(data as WorkerHealthRow).available) throw new AdminApiError("Worker is offline or not ready. Cannot test.", 503);
    const testId = randomUUID();
    const now = new Date().toISOString();
    const cutoff = new Date(Date.now() - 30_000).toISOString();
    const { data: updated, error: updateError } = await admin.from("compliance_sync_workers")
      .update({ test_id: testId, test_requested_at: now, test_acknowledged_at: null })
      .eq("worker_key", workerKey).or(`test_requested_at.is.null,test_requested_at.lt.${cutoff}`).select("worker_key");
    if (updateError) throw updateError;
    if (!updated?.length) throw new AdminApiError("A worker test was requested recently. Try again after 30 seconds.", 429);
    await writeAdministrationAudit(admin, profile, "WORKER_READINESS_TEST_REQUESTED", "compliance_sync", workerKey, data.display_name, { test_id: testId });
    return Response.json({ test_id: testId, message: "Readiness test requested. Waiting up to 30 seconds for worker acknowledgement." });
  } catch (error) { return jsonError(error); }
}
