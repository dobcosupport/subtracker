"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { adminFetch } from "@/lib/admin-client";
import { useSessionProfile } from "@/components/SessionContext";
import { canAccessModule } from "@/lib/permissions";

const buckets = [
  ["all", "All Active"], ["ready", "Ready"], ["existing_brc", "Existing BRC / Reconcile"],
  ["missing_information", "Missing Information"], ["needs_review", "Needs Review"],
  ["verified", "Verified"], ["no_result", "No Result"], ["failed", "Failed"],
] as const;
type Bucket = typeof buckets[number][0];
interface QueueRow {
  contractor_id: number;
  company_name: string;
  brc_number: string | null;
  name_control_status: string;
  fein_status: string;
  compliance_state: string;
  request_status: string | null;
  review_status: string | null;
  last_attempt_at: string | null;
  last_result: string | null;
  bucket: Exclude<Bucket, "all">;
  reasons: string[];
}
interface QueueData {
  rows: QueueRow[];
  counts: Record<Bucket, number>;
  total_filtered: number;
  page: number;
  page_size: number;
}
interface Manifest {
  id: string;
  status: string;
  created_at: string;
  member_count: number;
  completed_count?: number;
  skipped_count?: number;
  current_ordinal?: number | null;
  last_error?: string | null;
}
function display(value: string | null) {
  return value ? value.replaceAll("_", " ") : "—";
}
function date(value: string | null) {
  return value ? new Date(value).toLocaleString() : "—";
}
function selectionBlocker(row: QueueRow): string | null {
  if (row.bucket === "ready") return null;
  if (row.bucket === "missing_information") {
    const missing = [
      row.fein_status === "missing" ? "Missing FEIN" : row.fein_status === "invalid" ? "Invalid FEIN" : null,
      row.name_control_status === "missing" ? "Missing Name Control" : row.name_control_status === "invalid" ? "Invalid Name Control" : null,
    ].filter(Boolean);
    return missing.join("; ") || row.reasons.join("; ") || "Missing required company information";
  }
  if (row.bucket === "needs_review") return "Prior attempt or existing BRC requires review";
  return buckets.find(([key]) => key === row.bucket)?.[1] ?? "Company is not Ready";
}
const button = "rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 disabled:opacity-40";

function ManifestMembers({ sessionId, active }: { sessionId: string; active: boolean }) {
  const [members, setMembers] = useState<{
    contractor_id: number; ordinal: number; company_name: string; state?: string;
    request_status?: string | null; result_type?: string | null; skip_reason?: string | null;
  }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const loadMembers = () => adminFetch(`/api/admin/compliance-sync/nj-brc-sessions?session_id=${encodeURIComponent(sessionId)}`, { signal: controller.signal })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error ?? "Unable to load frozen membership.");
        if (!controller.signal.aborted) { setMembers(body.session.members); setError(null); }
      }).catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Unable to load frozen membership.");
      });
    void loadMembers();
    const timer = active ? window.setInterval(() => { void loadMembers(); }, 5000) : undefined;
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [sessionId, active]);
  if (error) return <p role="alert" className="mt-2 text-red-700">{error}</p>;
  if (!members) return <p className="mt-2 text-slate-500">Loading frozen membership…</p>;
  return <ol className="mt-2 max-h-48 overflow-auto text-slate-600">{members.map((member) =>
    <li key={member.contractor_id}>{member.ordinal}. #{member.contractor_id} {member.company_name}
      {member.state ? ` · ${display(member.state)}` : ""}
      {member.request_status ? ` · ${display(member.request_status)}` : ""}
      {member.result_type ? ` · ${display(member.result_type)}` : ""}
      {member.skip_reason ? ` · ${member.skip_reason}` : ""}
    </li>)}</ol>;
}

function workerCommand(batchId: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(batchId)) return null;
  return `powershell -ExecutionPolicy Bypass -File "D:\\subtracker\\worker\\nj-brc\\start-worker.ps1" -BatchId "${batchId}"`;
}

function WorkerCommand({ batchId }: { batchId: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<string | null>(null);
  const command = workerCommand(batchId);
  if (!command) return null;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setStatus("Worker command copied.");
    } catch {
      inputRef.current?.select();
      setStatus("Clipboard unavailable; the command is selected for manual copy.");
    }
  };
  return <div className="mt-2 flex flex-wrap items-center gap-2">
    <input ref={inputRef} readOnly value={command} aria-label={`Worker command for batch ${batchId}`}
      onFocus={(event) => event.currentTarget.select()}
      className="min-w-0 flex-1 rounded border border-slate-200 bg-slate-50 px-2 py-1 font-mono text-[11px] text-slate-700" />
    <button type="button" className={button} onClick={() => void copy()}>Copy Worker Command</button>
    {status ? <span role="status" className="text-slate-500">{status}</span> : null}
  </div>;
}

function ManifestDetails({ sessionId, active }: { sessionId: string; active: boolean }) {
  const [open, setOpen] = useState(false);
  return <details className="mt-2" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer font-medium text-indigo-700">View frozen membership</summary>
    {open ? <ManifestMembers sessionId={sessionId} active={active} /> : null}
  </details>;
}

export default function NjBrcVerificationQueue() {
  const profile = useSessionProfile();
  const canManage = profile.system_administrator || canAccessModule(profile.permissions, "compliance_sync", "manage");
  const [data, setData] = useState<QueueData | null>(null);
  const [sessions, setSessions] = useState<Manifest[]>([]);
  const [bucket, setBucket] = useState<Bucket>("all");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const generation = useRef(0);
  const sessionGeneration = useRef(0);
  const load = useCallback(async (signal?: AbortSignal) => {
    const current = ++generation.current;
    setLoading(true);
    try {
      const params = new URLSearchParams({ bucket, search: query, page: String(page), page_size: String(pageSize) });
      const response = await adminFetch(`/api/admin/compliance-sync/nj-brc-queue?${params}`, { signal });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Unable to load NJ BRC verification queue.");
      if (current === generation.current && !signal?.aborted) { setData(body); setError(null); }
    } catch (reason) {
      if (current === generation.current && !signal?.aborted) {
        setData(null);
        setError(reason instanceof Error ? reason.message : "Unable to load NJ BRC verification queue.");
      }
    } finally {
      if (current === generation.current && !signal?.aborted) setLoading(false);
    }
  }, [bucket, query, page, pageSize]);
  const loadSessions = useCallback(async (signal?: AbortSignal) => {
    const current = ++sessionGeneration.current;
    try {
      const response = await adminFetch("/api/admin/compliance-sync/nj-brc-sessions", { signal });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Unable to load BRC manifests.");
      if (current === sessionGeneration.current && !signal?.aborted) { setSessions(body.sessions); setSessionError(null); }
    } catch (reason) {
      if (current === sessionGeneration.current && !signal?.aborted) setSessionError(reason instanceof Error ? reason.message : "Unable to load BRC manifests.");
    }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const initial = window.setTimeout(() => { void load(controller.signal); }, 0);
    return () => { controller.abort(); window.clearTimeout(initial); };
  }, [load]);
  useEffect(() => {
    const controller = new AbortController();
    const initial = window.setTimeout(() => { void loadSessions(controller.signal); }, 0);
    return () => { controller.abort(); window.clearTimeout(initial); };
  }, [loadSessions]);
  const hasActiveBatch = sessions.some((session) => ["running", "paused"].includes(session.status));
  useEffect(() => {
    if (!hasActiveBatch) return;
    const controller = new AbortController();
    const timer = window.setInterval(() => { void loadSessions(controller.signal); }, 5000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [hasActiveBatch, loadSessions]);
  const save = async (payload: { contractor_ids: number[] } | { session_id: string; action: "start" | "pause" | "resume" | "stop" }) => {
    setSaving(true); setSessionError(null); setNotice(null);
    try {
      const response = await adminFetch("/api/admin/compliance-sync/nj-brc-sessions", {
        method: "contractor_ids" in payload ? "POST" : "PATCH", body: JSON.stringify(payload),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Unable to save BRC manifest.");
      if ("contractor_ids" in payload) setSelected(new Set());
      setNotice("contractor_ids" in payload
        ? "Verification batch saved. No worker was started and no NJ search requests were created."
        : payload.action === "start" || payload.action === "resume"
          ? "Attended session enabled. Only the BRC worker explicitly bound to this batch may process it."
          : `Verification batch ${payload.action === "pause" ? "paused" : "stopped"}. Completed submissions will not be replayed.`);
      await Promise.all([loadSessions(), load()]);
    } catch (reason) {
      setSessionError(reason instanceof Error ? reason.message : "Unable to save BRC manifest.");
    } finally { setSaving(false); }
  };
  const readyRows = data?.rows.filter((row) => row.bucket === "ready") ?? [];
  const reconciled = data && buckets.slice(1).reduce((sum, [key]) => sum + data.counts[key], 0) === data.counts.all;
  const totalPages = Math.max(1, Math.ceil((data?.total_filtered ?? 0) / pageSize));
  return <section aria-label="NJ BRC Verification Queue" className="space-y-3 rounded-xl border border-slate-200 bg-white p-4">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 className="text-lg font-semibold text-slate-900">NJ BRC Verification Queue</h2>
        <p className="mt-1 text-xs text-slate-500">All active companies, including Material Only. NJ BRC is non-expiring. Processing requires an explicitly started attended batch; captured certificates remain review-gated.</p>
      </div>
      <button type="button" className={button} disabled={loading || saving} onClick={() => { void load(); void loadSessions(); }}>Refresh queue</button>
    </div>
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-8">
      {buckets.map(([key, label]) => <button key={key} type="button" aria-pressed={bucket === key}
        onClick={() => { setBucket(key); setPage(1); }}
        className={`rounded-lg border p-2 text-left ${bucket === key ? "border-indigo-300 bg-indigo-50" : "border-slate-200 bg-slate-50"}`}>
        <span className="block text-xs text-slate-600">{label}</span>
        <span className="mt-1 block text-lg font-semibold text-slate-900">{data ? data.counts[key] : "—"}</span>
      </button>)}
    </div>
    {data ? <p role="status" className={`text-xs ${reconciled ? "text-slate-500" : "text-red-700"}`}>
      {reconciled ? `Population reconciled: ${data.counts.all} active companies, one bucket per company.` : "Population counts do not reconcile. Refresh before preparing a manifest."}
      {" "}Counts cover the full active population; search filters table rows only.
    </p> : null}
    <div className="flex flex-wrap items-center gap-2">
      <form className="flex flex-wrap gap-2" onSubmit={(event) => { event.preventDefault(); setQuery(search.trim()); setPage(1); }}>
        <input aria-label="Search NJ BRC queue" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Company, ID or BRC number"
          className="w-64 rounded-lg border border-slate-200 px-3 py-1.5 text-sm" />
        <button type="submit" className={button}>Search</button>
      </form>
      <button type="button" className={button} disabled={saving || loading || readyRows.length === 0} onClick={() => setSelected((current) => new Set([...current, ...readyRows.map((row) => row.contractor_id)]))}>Select Ready on page</button>
      <button type="button" className={button} disabled={saving || !selected.size} onClick={() => setSelected(new Set())}>Clear selection</button>
      <button type="button" className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40"
        disabled={!canManage || saving || loading || !selected.size || !reconciled} onClick={() => void save({ contractor_ids: [...selected] })}>
        {saving ? "Creating…" : `Create Verification Batch (${selected.size})`}
      </button>
      <span role="status" className="text-xs font-medium text-slate-600">{selected.size} selected</span>
    </div>
    {!canManage ? <p className="text-xs text-amber-800">You can select Ready companies, but creating or changing a verification batch requires Compliance Sync manage permission.</p> : null}
    <p className="text-xs text-slate-500">Select Ready companies here without opening View company. Selection is retained across pages and searches in the order selected.</p>
    {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : null}
    {loading ? <p className="text-sm text-slate-500">Loading reconciliation population…</p> : null}
    <div className="overflow-x-auto">
      <table className="w-full min-w-[1150px] border-collapse text-left text-xs [&_th]:border [&_th]:border-slate-200 [&_th]:px-2 [&_th]:py-2 [&_td]:border [&_td]:border-slate-200 [&_td]:px-2 [&_td]:py-2">
        <thead className="bg-slate-50"><tr>{["Select", "ID", "Company", "BRC Number", "Name Control", "FEIN", "Current BRC", "Search / Review", "Queue Bucket", "Last Attempt / Result", "Action"].map((label) => <th key={label} className="font-semibold">{label}</th>)}</tr></thead>
        <tbody>
          {!loading && data?.rows.map((row) => {
            const blocker = selectionBlocker(row);
            return <tr key={row.contractor_id}>
            <td><input type="checkbox" aria-label={`Select BRC company ${row.contractor_id}`} checked={selected.has(row.contractor_id)}
              disabled={blocker !== null || saving}
              aria-describedby={blocker ? `brc-selection-reason-${row.contractor_id}` : undefined}
              onChange={(event) => setSelected((current) => { const next = new Set(current); if (event.target.checked) next.add(row.contractor_id); else next.delete(row.contractor_id); return next; })} />
              {blocker ? <span id={`brc-selection-reason-${row.contractor_id}`} className="mt-1 block w-36 text-xs text-slate-500">{blocker}</span> : null}</td>
            <td>{row.contractor_id}</td>
            <td className="max-w-56 font-medium"><Link href={`/contractors/${row.contractor_id}`} className="text-indigo-700 hover:underline">{row.company_name}</Link></td>
            <td>{row.brc_number || "—"}</td><td>{row.name_control_status}</td><td>{row.fein_status}</td>
            <td>{row.compliance_state}</td>
            <td>{display(row.request_status)}<br /><span className="text-slate-500">{row.review_status ? `Review: ${display(row.review_status)}` : "No review"}</span></td>
            <td><span className="font-medium">{buckets.find(([key]) => key === row.bucket)?.[1]}</span>
              {row.reasons.length ? <ul className="mt-1 max-w-56 text-slate-500">{row.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul> : null}</td>
            <td>{date(row.last_attempt_at)}<br />{display(row.last_result)}</td>
            <td><Link href={`/contractors/${row.contractor_id}`} className="whitespace-nowrap font-medium text-indigo-700 hover:underline">{row.bucket === "missing_information" ? "Edit company" : "View company"}</Link></td>
          </tr>; })}
          {!loading && data?.rows.length === 0 ? <tr><td colSpan={11} className="text-slate-500">No companies match this filter.</td></tr> : null}
        </tbody>
      </table>
    </div>
    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600">
      <span>{data?.total_filtered ?? 0} matching companies · Page {page} of {totalPages} · {selected.size} selected across pages</span>
      <div className="flex items-center gap-2">
        <label>Rows <select aria-label="BRC queue page size" value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1); }} className="rounded border border-slate-200 p-1">{[25, 50, 100].map((size) => <option key={size}>{size}</option>)}</select></label>
        <button type="button" className={button} disabled={loading || page <= 1} onClick={() => setPage((value) => value - 1)}>Previous</button>
        <button type="button" className={button} disabled={loading || page >= totalPages} onClick={() => setPage((value) => value + 1)}>Next</button>
      </div>
    </div>
    <div className="border-t border-slate-200 pt-3">
      <h3 className="text-sm font-semibold">Prepared Batches</h3>
      <p className="mt-1 text-xs text-slate-500">Create the batch, launch the visible BRC worker with its Batch ID, then Start attended session. Pause blocks further source actions; an in-flight response can still be saved. Resume continues unfinished members without replaying completed submissions. Stop is final.</p>
      {notice ? <p role="status" className="mt-2 text-xs text-emerald-700">{notice}</p> : null}
      {sessionError ? <p role="alert" className="mt-2 text-sm text-red-700">{sessionError}</p> : null}
      <div className="mt-2 space-y-2">{sessions.length ? sessions.map((session) => <div key={session.id} className="rounded-lg border border-slate-200 px-3 py-2 text-xs">
        <div className="flex flex-wrap items-center justify-between gap-2">
        <span><span className="font-medium">{session.status === "prepared" ? "Prepared Batch" : "Verification Batch"} {session.id}</span> · {session.member_count} companies · {display(session.status)} · {date(session.created_at)}</span>
        <div className="flex gap-2">
          {session.status === "prepared" ? <button type="button" className={button} disabled={!canManage || saving}
            onClick={() => { if (window.confirm(`Start attended NJ BRC processing for this ${session.member_count}-company batch? Complete human verification manually in the worker browser when required.`)) void save({ session_id: session.id, action: "start" }); }}>Start attended session</button> : null}
          {["prepared", "running"].includes(session.status) ? <button type="button" className={button} disabled={!canManage || saving} onClick={() => void save({ session_id: session.id, action: "pause" })}>Pause manifest</button> : null}
          {session.status === "paused" ? <button type="button" className={button} disabled={!canManage || saving} onClick={() => void save({ session_id: session.id, action: "resume" })}>Resume manifest</button> : null}
          {["prepared", "running", "paused"].includes(session.status) ? <button type="button" className={button} disabled={!canManage || saving} onClick={() => void save({ session_id: session.id, action: "stop" })}>Stop manifest</button> : null}
        </div>
        </div>
        {session.completed_count !== undefined ? <p className="mt-1 text-slate-600">
          {session.completed_count}/{session.member_count} outcomes saved · {session.skipped_count ?? 0} skipped
          {session.current_ordinal ? ` · Next/current company ${session.current_ordinal}` : ""}
        </p> : null}
        {session.last_error ? <p role="alert" className="mt-1 text-red-700">{session.last_error}</p> : null}
        <WorkerCommand batchId={session.id} />
        <ManifestDetails sessionId={session.id} active={["running", "paused"].includes(session.status)} />
      </div>) : <p className="text-xs text-slate-500">No saved batches.</p>}</div>
    </div>
  </section>;
}
