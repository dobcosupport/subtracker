import "server-only";
import { AdminApiError, type createAdminClient } from "@/lib/server-admin";
import { classifyWorker, type WorkerHealthRow } from "@/lib/worker-health";

export async function getNjPwcWorkerAvailability(admin: ReturnType<typeof createAdminClient>) {
  const { data, error } = await admin.from("compliance_sync_workers").select("*").eq("worker_key", "nj-pwc").maybeSingle();
  if (error) throw new AdminApiError("Unable to verify NJ PWC worker availability.", 503);
  const health = data ? classifyWorker(data as WorkerHealthRow) : { available: false, restartRequired: false };
  if (health.available || !data?.enabled) return health;
  // The dashboard's latest-instance row is not a multi-worker liveness registry.
  const { data: instances, error: instanceError } = await admin.from("nj_pwc_queue_workers")
    .select("loaded_hash,current_hash")
    .in("lifecycle", ["ready", "busy"]).eq("browser_connected", true)
    .gt("last_heartbeat_at", new Date(Date.now() - 120_000).toISOString());
  if (instanceError || !Array.isArray(instances)) throw new AdminApiError("Unable to verify NJ PWC worker instances.", 503);
  return instances.some((instance) => instance.loaded_hash && instance.loaded_hash === instance.current_hash)
    ? { ...health, available: true, restartRequired: false } : health;
}

export async function requireNjPwcWorker(admin: ReturnType<typeof createAdminClient>) {
  const health = await getNjPwcWorkerAvailability(admin);
  if (!health.available) {
    throw new AdminApiError("NJ PWC Worker Offline. No new search was queued. Check Worker Health in Compliance Sync.", 503);
  }
}
