"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { adminFetch } from "@/lib/admin-client";
import type { ProcoreHealth, ProcoreOperation } from "@/types/procore-import";
import styles from "./MycoiImportWorkflow.module.css";

const states = {
  healthy: { label: "Healthy", style: "border-emerald-200 bg-emerald-50 text-emerald-800" },
  running: { label: "Import Running", style: "border-blue-200 bg-blue-50 text-blue-800" },
  attention: { label: "Attention", style: "border-amber-200 bg-amber-50 text-amber-800" },
  abnormal: { label: "Abnormal Processing", style: "border-red-200 bg-red-50 text-red-800" },
  stopping: { label: "Stopping...", style: "border-amber-200 bg-amber-50 text-amber-800" },
};
const time = (value: string | null) => value ? new Date(value).toLocaleString() : "Not recorded";

export default function ProcoreImportStatus({ importBusy }: { importBusy: boolean }) {
  const [health, setHealth] = useState<ProcoreHealth | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [confirmation, setConfirmation] = useState<ProcoreOperation | null>(null);
  const [stopping, setStopping] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const inFlight = useRef(false);
  const stopAccepted = useRef(new Set<string>());
  const stopInFlight = useRef(false);
  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true; setRefreshing(true);
    try {
      const response = await adminFetch("/api/imports/procore/health");
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Unable to load Procore Import Status.");
      const operations: ProcoreOperation[] = body.operations.map((operation: ProcoreOperation) =>
        stopAccepted.current.has(operation.id) && operation.status === "running"
          ? { ...operation, status: "stopping", can_stop: false } : operation);
      setHealth({ ...body, operations,
        state: operations.some((operation) => operation.status === "stopping") ? "stopping" : body.state });
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to load Procore Import Status.");
    } finally { inFlight.current = false; setRefreshing(false); }
  }, []);
  const active = importBusy || health?.operations.some((operation) => operation.executing
    || (["running", "stopping"].includes(operation.status) && operation.deadline_at > health.observedAt));
  useEffect(() => {
    const initial = setTimeout(() => void refresh(), 0);
    const timer = active ? setInterval(() => void refresh(), 15_000) : undefined;
    return () => { clearTimeout(initial); clearInterval(timer); };
  }, [active, importBusy, refresh]);
  useEffect(() => {
    if (confirmation) dialog.current?.showModal();
    else dialog.current?.close();
  }, [confirmation]);

  const stop = async () => {
    if (!confirmation || stopInFlight.current) return;
    stopInFlight.current = true;
    setStopping(true);
    try {
      const response = await adminFetch("/api/imports/procore/health", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operationId: confirmation.id, confirmed: true }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Stop request failed.");
      if (body.operationId !== confirmation.id || body.status !== "stopping") {
        throw new Error("Stop outcome could not be confirmed. Refresh Import Status.");
      }
      stopAccepted.current.add(confirmation.id);
      setHealth((current) => current ? { ...current, state: "stopping",
        operations: current.operations.map((operation) => operation.id === confirmation.id
          ? { ...operation, status: "stopping", can_stop: false } : operation) } : current);
      setConfirmation(null);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Stop request failed.");
    } finally { stopInFlight.current = false; setStopping(false); }
  };
  const state = health && !error ? states[health.state] : states.attention;
  return <section aria-label="Procore Import Status" className={`mb-4 max-w-4xl rounded-lg border p-3 text-sm ${state.style}`}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="font-semibold">Procore Import Status: <span role="status">{health ? state.label : "Status unavailable"}</span></h3>
      <button type="button" className={`${styles.button} ${styles.secondary}`} disabled={refreshing}
        onClick={() => void refresh()}>Refresh Import Status</button>
    </div>
    {error ? <p role="alert" className="mt-2">{error}</p> : null}
    {health ? <>
      <p className="mt-1 text-xs">Checked {time(health.observedAt)}. Idle status does not poll; active requests refresh every 15 seconds.</p>
      {health.state === "healthy" && !error ? <p className="mt-2">No Procore import running. No abnormal Procore processing detected.</p> : null}
      {health.untrackedActivity ? <p className="mt-2">Untracked Procore database activity detected. Ownership cannot be proven for cooperative stop. A database administrator must investigate; no session-stop control is exposed.</p> : null}
      {health.state === "abnormal" && !health.untrackedActivity ? <p className="mt-2">Execution exceeded the {health.reviewThresholdSeconds}-second review threshold. It may still be legitimate. Check the operation before requesting a stop.</p> : null}
      <p className="mt-1 text-xs">Atomic transactions are bounded to {health.timeoutSeconds} seconds. No safe immediate Cancel Import capability is available.</p>
      {health.operations.filter((operation, index) => index < 5
        || ["running", "stopping"].includes(operation.status)).map((operation) => <div key={operation.id} className="mt-2 border-t border-current/20 pt-2">
        <p className="font-medium">{operation.status === "stopped" ? "Stopped by Administrator" : operation.status === "stopping" ? "Stopping..." : operation.stage}</p>
        <p className="break-all text-xs">Operation {operation.id} · Import {operation.run_id} · Submitted revision {operation.revision}</p>
        <p className="text-xs">Started {time(operation.started_at)} · Last recorded activity {time(operation.last_activity_at)}
          {operation.finished_at ? ` · Finished ${time(operation.finished_at)}` : ""}</p>
        {operation.diagnostic ? <p className="mt-1">{operation.diagnostic}</p> : null}
        {operation.stop_requested_at ? <p className="text-xs">Stop requested {time(operation.stop_requested_at)} · Administrator {operation.stop_requested_by}</p> : null}
        {operation.can_stop && operation.status === "running" && !error ? <button type="button"
          className={`${styles.button} ${styles.destructive} mt-2`} disabled={stopping}
          onClick={() => setConfirmation(operation)}>Stop Procore Process</button> : null}
      </div>)}
    </> : null}
    <dialog ref={dialog} onCancel={(event) => { if (stopping) event.preventDefault(); else setConfirmation(null); }}
      className="m-auto max-w-lg rounded-xl border border-slate-200 bg-white p-5 text-sm text-slate-800 backdrop:bg-black/40">
      <h4 className="font-semibold">Stop Procore Process</h4>
      <p className="my-2 break-all">Ask operation {confirmation?.id} for import {confirmation?.run_id} to stop?</p>
      <p>Existing committed/staged import data will be preserved. Stopping may not be instantaneous: the current bounded transaction must return or reach a safe stop boundary. No database session will be terminated.</p>
      {error ? <p role="alert" className="mt-2 text-red-700">{error}</p> : null}
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className={`${styles.button} ${styles.secondary}`} disabled={stopping}
          onClick={() => setConfirmation(null)}>Keep operation</button>
        <button type="button" className={`${styles.button} ${styles.destructive}`} disabled={stopping}
          onClick={() => void stop()}>{stopping ? "Requesting stop..." : "Confirm Stop Request"}</button>
      </div>
    </dialog>
  </section>;
}
