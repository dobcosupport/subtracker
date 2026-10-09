import "server-only";
import { AdminApiError, type createAdminClient } from "@/lib/server-admin";
import { classifyWorker, type WorkerHealthRow } from "@/lib/worker-health";

export async function getNjPwcWorkerAvailability(admin: ReturnType<typeof createAdminClient>) {
  const { data, error } = await admin.from("compliance_sync_workers").select("*").eq("worker_key", "nj-pwc").maybeSingle();
  if (error) throw new AdminApiError("Unable to verify NJ PWC worker availability.", 503);
  return data ? classifyWorker(data as WorkerHealthRow) : { available: false, restartRequired: false };
}

export async function requireNjPwcWorker(admin: ReturnType<typeof createAdminClient>) {
  const health = await getNjPwcWorkerAvailability(admin);
  if (!health.available) {
    throw new AdminApiError("NJ PWC Worker Offline. No new search was queued. Check Worker Health in Compliance Sync.", 503);
  }
}
