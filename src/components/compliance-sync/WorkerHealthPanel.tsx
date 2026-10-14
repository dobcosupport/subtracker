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
  current_request_key?: string | null;
  testState: string;
  diagnosticAvailable?: boolean;
  operationalState?: string;
  browser_connected?: boolean;
  loaded_hash?: string | null;
  current_hash?: string | null;
}
interface HealthResponse { overall: "online" | "degraded" | "offline"; workers: Worker[] }
interface WorkerEvent { id: number; received_at: string; event: string; message: string; request_id: number | null; request_key?: string | null }
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
  const brcWorker = health?.workers.find((worker) => worker.worker_key === "nj-brc") ?? {
    ...unreportedWorker, worker_key: "nj-brc", display_name: "NJ BRC Worker",
    enabled: true, status: health ? "Monitoring Not Deployed" : error ? "Unavailable" : "Loading...", health: "degraded",
  };
  const workers = [njWorker, brcWorker, ...plannedWorkers];
  return <section aria-labelledby="worker-health-heading" className="rounded-xl border border-slate-200 bg-white p-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 id="worker-health-heading" className="text-lg font-semibold text-slate-900">Worker Health</h2>
      <button type="button" onClick={() => void refresh()} className="text-sm font-medium text-indigo-700 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-2">Refresh Status</button>
    </div>
    <p role="status" className="mt-2 flex items-center gap-2 text-sm font-semibold">
      {overall ? <><span aria-hidden="true" className={`h-3 w-3 rounded-full ${tones[overall]}`} />{overallLabels[overall]}</> : "Loading worker health..."}
    </p>
    {error ? <p role="alert" className="mt-3 text-sm text-red-700">Worker health unavailable: {error}. Displayed worker details may be outdated.</p> : null}
    {actionError ? <p role="alert" className="mt-3 text-sm text-red-700">{actionError}</p> : null}
    {message ? <p className="mt-3 text-sm text-slate-600">{message}</p> : null}
    <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{workers.map((worker) => <article key={worker.worker_key} className="rounded-lg border border-slate-200 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-900">{worker.display_name}</h3>
        {!worker.enabled ? <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">Planned</span> : null}
      </div>
      {worker.enabled ? <dl className="mt-2 space-y-1 text-xs text-slate-600">
        <div><dt className="inline font-medium">Status: </dt><dd className="inline break-words">{`${worker.status}${worker.health === "degraded" ? " (Degraded)" : ""}${worker.current_request_key || worker.current_request_id ? ` - Processing request #${worker.current_request_key || worker.current_request_id}` : ""}`}</dd></div>
        <div><dt className="inline font-medium">Last Heartbeat: </dt><dd className="inline break-words">{date(worker.last_heartbeat_at)}</dd></div>
        <div><dt className="inline font-medium">Last Successful Search: </dt><dd className="inline break-words">{`${date(worker.last_search_at)}${worker.last_search_result ? ` - ${worker.last_search_result}` : ""}`}</dd></div>
      </dl> : null}
      <details className="mt-2 text-xs text-slate-600">
        <summary className="cursor-pointer font-medium text-indigo-700">Worker details</summary>
        <dl className="mt-2 space-y-1">
          {worker.worker_key === "nj-brc" ? <>
            <div><dt className="inline font-medium">Operational State: </dt><dd className="inline">{worker.operationalState ?? "Not reported"}</dd></div>
            <div><dt className="inline font-medium">Browser Connected: </dt><dd className="inline">{worker.browser_connected ? "Yes" : "No"}</dd></div>
            <div><dt className="inline font-medium">Last Queue Poll: </dt><dd className="inline">{date(worker.last_poll_at)}</dd></div>
            <div><dt className="inline font-medium">Loaded Code Hash: </dt><dd className="inline break-all">{worker.loaded_hash ?? "Not reported"}</dd></div>
            <div><dt className="inline font-medium">Current Code Hash: </dt><dd className="inline break-all">{worker.current_hash ?? "Not reported"}</dd></div>
          </> : null}
          <div><dt className="inline font-medium">Last Error: </dt><dd className="inline break-words">{worker.last_error ? `${worker.last_error} (${date(worker.last_error_at)})` : "None reported"}</dd></div>
          <div><dt className="inline font-medium">Worker Start Time: </dt><dd className="inline">{date(worker.started_at)}</dd></div>
          <div><dt className="inline font-medium">Worker File Last Modified: </dt><dd className="inline">{date(worker.file_modified_at)}</dd></div>
        </dl>
        {!worker.enabled ? <p className="mt-2">Future worker; excluded from overall status.</p> : !worker.last_heartbeat_at ? <p className="mt-2">No telemetry received. Deploy monitoring and restart the existing worker once.</p> : null}
      </details>
      {worker.restartRequired ? <div role="status" className="mt-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-800"><p className="font-semibold">Restart Required</p><p>Current worker file is newer than the running process or its code has changed.</p></div> : null}
      {!worker.enabled ? <p className="mt-3 text-xs text-slate-500">Future worker; excluded from overall status.</p> : !worker.last_heartbeat_at ? <p className="mt-3 text-xs text-slate-500">No telemetry received. Deploy monitoring and restart the existing worker once.</p> : null}
      {worker.testState !== "none" ? <p role="status" className="mt-3 text-sm">{worker.testState === "passed" ? "Worker readiness test passed." : worker.testState === "timed_out" ? "Worker test timed out: no readiness acknowledgement within 30 seconds." : "Worker test awaiting acknowledgement..."}</p> : null}
      <div className="mt-4 flex flex-wrap gap-3">
        <button type="button" disabled={!(worker.diagnosticAvailable ?? worker.available) || testing !== null || worker.testState === "pending" || Boolean(error)} onClick={() => void test(worker)} className="rounded-lg border border-indigo-300 bg-white px-3 py-2 text-sm font-semibold text-indigo-800 hover:bg-indigo-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:border-slate-300 disabled:bg-slate-100 disabled:text-slate-700 disabled:opacity-100">{testing === worker.worker_key ? "Testing..." : "Test Worker"}</button>
        <button type="button" disabled={!worker.enabled || logsLoading} onClick={() => void viewLogs(worker)} className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-800 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:border-slate-200 disabled:bg-slate-100 disabled:text-slate-700 disabled:opacity-100">{logsLoading && worker.enabled ? "Loading Logs..." : "View Logs"}</button>
      </div>
    </article>)}</div>
    <p className="mt-4 text-xs text-slate-500">Stopped means explicit shutdown or no heartbeat within 120 seconds, not an OS process inspection. Successful Search includes a completed No Match Found lookup. Historical errors remain visible after recovery. Test Worker checks readiness, not registry results.</p>
    <details className="mt-3 text-sm text-slate-600">
      <summary className="cursor-pointer font-medium">Manual Restart Instructions</summary>
      <ol className="mt-2 list-inside list-decimal space-y-2">
        <li>Stop the existing worker terminal with Ctrl+C before starting another instance.</li>
        <li>Start the worker:</li>
      </ol>
      <pre className="mt-2 overflow-x-auto rounded-lg bg-slate-50 p-3">{'powershell -ExecutionPolicy Bypass -File "D:\\subtracker\\worker\\nj-pwc\\start-worker.ps1"'}</pre>
      <p className="mt-3 font-medium">NJ BRC Worker:</p>
      <pre className="mt-2 overflow-x-auto rounded-lg bg-slate-50 p-3">{'powershell -ExecutionPolicy Bypass -File "D:\\subtracker\\worker\\nj-brc\\start-worker.ps1"'}</pre>
      <p className="mt-3 font-medium">Alternative:</p>
      <pre className="mt-2 overflow-x-auto rounded-lg bg-slate-50 p-3">{'Set-Location -LiteralPath \'D:\\subtracker\\worker\\nj-pwc\'\nnpm start'}</pre>
      <p className="mt-3 font-medium">Notes:</p>
      <ul className="mt-2 list-inside list-disc space-y-1">
        <li>The Bypass option only applies to the new PowerShell process being launched.</li>
        <li>This avoids failures caused by unsigned PowerShell scripts.</li>
        <li>Do not run multiple worker instances simultaneously.</li>
      </ul>
    </details>
    {logs ? <div className="mt-5 border-t border-slate-200 pt-4"><div className="flex justify-between gap-3"><h3 className="font-semibold">Recent Logs - {logs.name}</h3><button type="button" onClick={() => setLogs(null)} className="text-sm font-medium text-indigo-700 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-2">Close Logs</button></div>{logs.events.length === 0 ? <p className="mt-2 text-sm text-slate-500">No operational events reported.</p> : <ul className="mt-3 max-h-72 space-y-2 overflow-y-auto">{logs.events.map((event) => <li key={event.id} className="break-words rounded-lg bg-slate-50 p-3 text-xs"><p className="font-medium">{date(event.received_at)} - {event.event}{event.request_key || event.request_id ? ` - Request #${event.request_key || event.request_id}` : ""}</p><p className="mt-1 whitespace-pre-wrap">{event.message}</p></li>)}</ul>}</div> : null}
  </section>;
}
