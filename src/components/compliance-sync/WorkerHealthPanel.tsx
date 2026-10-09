"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { adminFetch } from "@/lib/admin-client";

interface Worker {
  worker_key: string;
  display_name: string;
  enabled: boolean;
  status: string;
  health: string;
  available: boolean;
  restartRequired: boolean;
  started_at: string | null;
  last_heartbeat_at: string | null;
  last_poll_at: string | null;
  file_modified_at: string | null;
  last_search_at: string | null;
  last_search_request_id: number | null;
  last_search_result: string | null;
  last_error_at: string | null;
  last_error: string | null;
  current_request_id: number | null;
  testState: string;
}
interface HealthResponse { overall: "online" | "degraded" | "offline"; workers: Worker[] }
interface WorkerEvent { id: number; received_at: string; event: string; message: string; request_id: number | null }
const date = (value: string | null) => value ? new Date(value).toLocaleString() : "Never reported";
const overallLabels = { online: "Healthy", degraded: "Degraded", offline: "One or More Workers Offline" };
const tones = { online: "bg-emerald-500", degraded: "bg-amber-500", offline: "bg-red-500" };
const unreportedWorker = {
  enabled: false, status: "Planned", health: "not_configured",
  available: false, restartRequired: false, started_at: null,
  last_heartbeat_at: null, last_poll_at: null, file_modified_at: null,
  last_search_at: null, last_search_request_id: null, last_search_result: null,
  last_error_at: null, last_error: null, current_request_id: null, testState: "none",
};
const plannedWorkers: Worker[] = [
  { ...unreportedWorker, worker_key: "ny", display_name: "NY Worker" },
  { ...unreportedWorker, worker_key: "reminder-automation", display_name: "Reminder Automation Worker" },
  { ...unreportedWorker, worker_key: "email-notification", display_name: "Email Notification Worker" },
];

export default function WorkerHealthPanel() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [logs, setLogs] = useState<{ name: string; events: WorkerEvent[] } | null>(null);
  const [logsLoading, setLogsLoading] = useState(false);
  const refreshGeneration = useRef(0);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const generation = ++refreshGeneration.current;
    try {
      const response = await adminFetch("/api/admin/compliance-sync/worker-health", { signal });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Unable to load worker health.");
      if (!signal?.aborted && generation === refreshGeneration.current) { setHealth(result as HealthResponse); setError(null); }
    } catch (reason) {
      if (!signal?.aborted && generation === refreshGeneration.current) setError(reason instanceof Error ? reason.message : "Unable to load worker health.");
    }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const initial = window.setTimeout(() => { void refresh(controller.signal); }, 0);
    const interval = window.setInterval(() => { void refresh(controller.signal); }, 15000);
    return () => { controller.abort(); window.clearTimeout(initial); window.clearInterval(interval); };
  }, [refresh]);

  const test = async (worker: Worker) => {
    setTesting(worker.worker_key); setActionError(null); setMessage(null);
    try {
      const response = await adminFetch("/api/admin/compliance-sync/worker-health", {
        method: "POST", body: JSON.stringify({ worker_key: worker.worker_key }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Worker test failed.");
      setMessage(result.message);
      await refresh();
    } catch (reason) { setActionError(reason instanceof Error ? reason.message : "Worker test failed."); }
    finally { setTesting(null); }
  };
  const viewLogs = async (worker: Worker) => {
    setLogsLoading(true); setActionError(null); setLogs(null);
    try {
      const response = await adminFetch(`/api/admin/compliance-sync/worker-health?logs=${encodeURIComponent(worker.worker_key)}`);
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Unable to load worker logs.");
      setLogs({ name: worker.display_name, events: result.events });
    } catch (reason) { setActionError(reason instanceof Error ? reason.message : "Unable to load worker logs."); }
    finally { setLogsLoading(false); }
  };
  const overall = error ? "degraded" : health?.overall;
  const njWorker = health?.workers.find((worker) => worker.worker_key === "nj-pwc") ?? {
    ...unreportedWorker, worker_key: "nj-pwc", display_name: "NJ PWC Worker",
    enabled: true, status: error ? "Unavailable" : "Loading...", health: "degraded",
  };
  const workers = [njWorker, ...plannedWorkers];
  return <section aria-labelledby="worker-health-heading" className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 id="worker-health-heading" className="text-xl font-semibold text-slate-900">Worker Health</h2>
      <button type="button" onClick={() => void refresh()} className="text-sm font-medium text-indigo-600">Refresh Status</button>
    </div>
    <p className="mt-4 text-xs font-semibold uppercase tracking-wide text-slate-500">Overall Status</p>
    <p role="status" className="mt-1 flex items-center gap-2 font-semibold">
      {overall ? <><span aria-hidden="true" className={`h-3 w-3 rounded-full ${tones[overall]}`} />{overallLabels[overall]}</> : "Loading worker health..."}
    </p>
    {error ? <p role="alert" className="mt-3 text-sm text-red-700">Worker health unavailable: {error}. Displayed worker details may be outdated.</p> : null}
    {actionError ? <p role="alert" className="mt-3 text-sm text-red-700">{actionError}</p> : null}
    {message ? <p className="mt-3 text-sm text-slate-600">{message}</p> : null}
    <div className="mt-5 grid gap-4 lg:grid-cols-2">{workers.map((worker) => <article key={worker.worker_key} className="rounded-xl border border-slate-200 p-4">
      <h3 className="font-semibold text-slate-900">{worker.display_name}</h3>
      {!worker.enabled ? <p className="mt-3 flex items-center gap-2 text-sm text-slate-600"><span aria-hidden="true" className="h-3 w-3 rounded-full border border-slate-300 bg-slate-100" />Planned</p> : null}
      <dl className="mt-3 space-y-2 text-sm">
        {[
          ["Status", `${worker.status}${worker.health === "degraded" ? " (Degraded)" : ""}${worker.current_request_id ? ` - Processing request #${worker.current_request_id}` : ""}`],
          ["Last Heartbeat", date(worker.last_heartbeat_at)],
          ["Last Successful Search", `${date(worker.last_search_at)}${worker.last_search_result ? ` - ${worker.last_search_result}` : ""}`],
          ["Last Error", worker.last_error ? `${worker.last_error} (${date(worker.last_error_at)})` : "None reported"],
          ["Worker Start Time", date(worker.started_at)],
          ["Worker File Last Modified", date(worker.file_modified_at)],
        ].filter(([label]) => worker.enabled || label !== "Status").map(([label, value]) => <div key={label}><dt className="inline font-medium">{label}: </dt><dd className="inline break-words">{value}</dd></div>)}
      </dl>
      {worker.restartRequired ? <div role="status" className="mt-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-800"><p className="font-semibold">Restart Required</p><p>Current worker file is newer than the running process or its code has changed.</p></div> : null}
      {!worker.enabled ? <p className="mt-3 text-xs text-slate-500">Future worker; excluded from overall status.</p> : !worker.last_heartbeat_at ? <p className="mt-3 text-xs text-slate-500">No telemetry received. Deploy monitoring and restart the existing worker once.</p> : null}
      {worker.testState !== "none" ? <p role="status" className="mt-3 text-sm">{worker.testState === "passed" ? "Worker readiness test passed." : worker.testState === "timed_out" ? "Worker test timed out: no readiness acknowledgement within 30 seconds." : "Worker test awaiting acknowledgement..."}</p> : null}
      <div className="mt-4 flex flex-wrap gap-3">
        <button type="button" disabled={!worker.available || testing !== null || worker.testState === "pending" || Boolean(error)} onClick={() => void test(worker)} className="rounded-lg border border-indigo-200 px-3 py-2 text-sm font-medium text-indigo-600 disabled:opacity-50">{testing === worker.worker_key ? "Testing..." : "Test Worker"}</button>
        <button type="button" disabled={!worker.enabled || logsLoading} onClick={() => void viewLogs(worker)} className="rounded-lg border border-slate-200 px-3 py-2 text-sm disabled:opacity-50">{logsLoading && worker.enabled ? "Loading Logs..." : "View Logs"}</button>
      </div>
    </article>)}</div>
    <p className="mt-4 text-xs text-slate-500">Stopped means explicit shutdown or no heartbeat within 120 seconds, not an OS process inspection. Successful Search includes a completed No Match Found lookup. Historical errors remain visible after recovery. Test Worker checks readiness, not registry results.</p>
    <details className="mt-3 text-sm text-slate-600"><summary className="cursor-pointer font-medium">Manual restart instructions</summary><p className="mt-2">Stop the existing worker terminal with Ctrl+C before starting another instance.</p><pre className="mt-2 overflow-x-auto rounded-lg bg-slate-50 p-3">{'Set-Location -LiteralPath \'D:\\subtracker\\worker\\nj-pwc\'\n.\\start-worker.ps1'}</pre></details>
    {logs ? <div className="mt-5 border-t border-slate-200 pt-4"><div className="flex justify-between gap-3"><h3 className="font-semibold">Recent Logs - {logs.name}</h3><button type="button" onClick={() => setLogs(null)} className="text-sm text-indigo-600">Close Logs</button></div>{logs.events.length === 0 ? <p className="mt-2 text-sm text-slate-500">No operational events reported.</p> : <ul className="mt-3 max-h-72 space-y-2 overflow-y-auto">{logs.events.map((event) => <li key={event.id} className="break-words rounded-lg bg-slate-50 p-3 text-xs"><p className="font-medium">{date(event.received_at)} - {event.event}{event.request_id ? ` - Request #${event.request_id}` : ""}</p><p className="mt-1 whitespace-pre-wrap">{event.message}</p></li>)}</ul>}</div> : null}
  </section>;
}
