export interface WorkerHealthRow {
  worker_key: string;
  display_name: string;
  enabled: boolean;
  instance_id: string | null;
  started_at: string | null;
  last_heartbeat_at: string | null;
  lifecycle: "starting" | "ready" | "busy" | "stopped" | null;
  last_poll_at: string | null;
  browser_connected: boolean;
  file_modified_at: string | null;
  loaded_hash: string | null;
  current_hash: string | null;
  current_request_id: number | null;
  last_search_at: string | null;
  last_search_request_id: number | null;
  last_search_result: string | null;
  last_error_at: string | null;
  last_error: string | null;
  test_id: string | null;
  test_requested_at: string | null;
  test_acknowledged_at: string | null;
}

export function classifyWorker(row: WorkerHealthRow, now = Date.now()) {
  const heartbeatAge = row.last_heartbeat_at ? now - Date.parse(row.last_heartbeat_at) : Infinity;
  const pollAge = row.last_poll_at ? now - Date.parse(row.last_poll_at) : Infinity;
  const pollHealthy = row.lifecycle === "busy" && Boolean(row.last_poll_at);
  const restartRequired = Boolean(row.started_at && row.file_modified_at && Date.parse(row.file_modified_at) > Date.parse(row.started_at))
    || Boolean(row.loaded_hash && row.current_hash && row.loaded_hash !== row.current_hash);
  const offline = !row.last_heartbeat_at || !Number.isFinite(heartbeatAge) || heartbeatAge > 120_000 || row.lifecycle === "stopped";
  const unavailable = offline || !row.browser_connected || !["ready", "busy"].includes(row.lifecycle ?? "")
    || (!pollHealthy && (!Number.isFinite(pollAge) || pollAge > 120_000));
  const status = !row.enabled ? "Not Configured" : offline ? "Stopped" : "Running";
  const health = !row.enabled ? "not_configured"
    : offline ? "offline"
    : restartRequired || heartbeatAge > 60_000 || (!pollHealthy && pollAge > 60_000) || unavailable ? "degraded" : "online";
  const testState = !row.test_id || !row.test_requested_at ? "none"
    : row.test_acknowledged_at && Date.parse(row.test_acknowledged_at) >= Date.parse(row.test_requested_at) ? "passed"
    : now - Date.parse(row.test_requested_at) >= 30_000 ? "timed_out" : "pending";
  return { status, health, restartRequired, available: row.enabled && !unavailable, testState };
}

export function overallWorkerHealth(rows: WorkerHealthRow[], now = Date.now()) {
  const required = rows.filter((row) => row.enabled).map((row) => classifyWorker(row, now));
  if (required.some((row) => row.health === "offline")) return "offline";
  if (!required.length || required.some((row) => row.health !== "online")) return "degraded";
  return "online";
}
