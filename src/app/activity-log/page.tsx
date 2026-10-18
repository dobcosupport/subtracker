"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { adminFetch } from "@/lib/admin-client";
import { useSessionProfile } from "@/components/SessionContext";
import { canAccessModule } from "@/lib/permissions";
import ContractorCommunicationDetails from "@/components/ContractorCommunicationDetails";
import type { ContractorActivityOption, ContractorTimeline, ContractorTimelineEntry, TimelineOffsets } from "@/types/contractor-activity";

const button = "rounded border border-slate-300 px-2 py-0.5 font-medium disabled:cursor-not-allowed disabled:opacity-50";
function Timeline({ contractorId }: { contractorId: number }) {
  const { permissions } = useSessionProfile();
  const [result, setResult] = useState<ContractorTimeline | null>(null);
  const [cursor, setCursor] = useState<TimelineOffsets | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [details, setDetails] = useState<{ id: string; kind: "content" | "delivery" } | null>(null);
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const params = new URLSearchParams({ contractor_id: String(contractorId) });
        if (cursor) for (const [source, position] of Object.entries(cursor)) params.set(source, String(position));
        const response = await adminFetch(`/api/activity-log?${params}`);
        const data = await response.json() as ContractorTimeline & { error?: string };
        if (!response.ok) throw new Error(data.error ?? "Unable to load contractor activity.");
        if (active) {
          setResult((previous) => ({ ...data, entries: cursor && previous ? [...previous.entries, ...data.entries] : data.entries }));
          setError("");
        }
      } catch (reason) { if (active) setError(reason instanceof Error ? reason.message : "Unable to load contractor activity."); }
      finally { if (active) setLoading(false); }
    })();
    return () => { active = false; };
  }, [contractorId, cursor]);

  function entryDetails(entry: ContractorTimelineEntry) {
    if (entry.source === "activity") return <>
      <p className="font-medium">{entry.record.activity_type}</p>
      <p className="whitespace-pre-wrap break-words">{entry.record.notes || "No notes."}</p>
      {entry.record.created_by ? <p className="text-xs text-slate-500">By {entry.record.created_by}</p> : null}
      {entry.record.project_id ? <p className="text-xs text-slate-500">Project #{entry.record.project_id}</p> : null}
    </>;
    if (entry.source === "followup") return <>
      <p className="font-medium">{entry.record.subject}</p>
      <p>Method: {entry.record.followup_method} | Status: {entry.record.status}</p>
      <p>Related Item: {entry.record.related_item}</p>
      <p className="text-xs text-slate-500">Manual Follow-Up record, not proof of a message sent by SubTracker.</p>
    </>;
    return <>
      <p className="font-medium">{entry.record.description}</p>
      <p>{entry.record.source === "manual" ? "Manual" : "Automated"} | Status: {entry.record.status} | Recipients: {entry.record.recipient_count}</p>
      <p>Contractors: {entry.record.contractors.map((link) => link.contractors?.company_name ?? `#${link.contractor_id}`).join("; ") || "-"}</p>
      <p>Projects: {entry.record.projects.map((link) => link.projects ? `${link.projects.project_number} - ${link.projects.project_name}` : `#${link.project_id}`).join("; ") || "-"}</p>
      <p className="break-all text-xs text-slate-500">Communication ID: {entry.record.id}</p>
      <div className="flex flex-wrap gap-2 text-xs">
        {canAccessModule(permissions, "communications_content") ? <button type="button" className={button} onClick={() => setDetails({ id: entry.record.id, kind: "content" })}>View Details</button> : null}
        {canAccessModule(permissions, "communications_delivery") ? <button type="button" className={button} onClick={() => setDetails({ id: entry.record.id, kind: "delivery" })}>Delivery Details</button> : null}
      </div>
    </>;
  }
  return (
    <div className="space-y-4">
      {result ? <>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">{result.contractor.company_name}</h2>
          {canAccessModule(permissions, "contractors") ? <Link href={`/contractors/${contractorId}`} className="text-sm font-medium text-indigo-600">Open Contractor Card</Link> : null}
        </div>
        <p className="text-xs text-slate-500">Newest first. Activity and Follow-Ups use their recorded date; Communications use their creation timestamp.</p>
        {!result.sources.followups ? <p className="text-sm text-slate-500">Follow-Ups require Follow-Ups View permission.</p> : null}
        {!result.sources.communications ? <p className="text-sm text-slate-500">Communications require Communications Summary View permission.</p> : null}
        <ol aria-label="Contractor timeline" className="divide-y divide-slate-200 rounded border border-slate-200 bg-white">
          {result.entries.map((entry) => <li key={`${entry.source}:${entry.record.id}`} className="grid gap-2 p-4 sm:grid-cols-[150px_110px_1fr]">
            <time dateTime={entry.date} className="text-sm text-slate-500">{entry.source === "communication" ? new Date(entry.date).toLocaleString() : entry.date.slice(0, 10)}</time>
            <span className="text-sm font-semibold">{entry.source === "activity" ? "Activity" : entry.source === "followup" ? "Follow-Up" : entry.record.channel === "email" ? "Email" : "SMS"}</span>
            <div className="min-w-0 space-y-1 text-sm">{entryDetails(entry)}</div>
          </li>)}
        </ol>
        {!result.entries.length ? <p className="text-sm text-slate-500">No permitted activity found for this contractor.</p> : null}
      </> : null}
      {loading ? <p role="status" className="text-sm">Loading contractor activity...</p> : null}
      {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : null}
      <div className="text-xs">
        {result?.next ? <button type="button" className={button} disabled={loading} onClick={() => { setLoading(true); setCursor(result.next); }}>Load Older Entries</button> : null}
        {error ? <button type="button" className={`${button} ml-2`} disabled={loading} onClick={() => { setLoading(true); setCursor((previous) => ({ ...(previous ?? { activity: 0, followup: 0, communication: 0 }) })); }}>Retry</button> : null}
      </div>
      {details ? <ContractorCommunicationDetails key={`${details.id}:${details.kind}`} {...details} onClose={() => setDetails(null)} /> : null}
    </div>
  );
}

export default function ActivityLogPage() {
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [options, setOptions] = useState<ContractorActivityOption[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [selected, setSelected] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    const timeout = window.setTimeout(() => {
      void (async () => {
        try {
          const response = await adminFetch(`/api/activity-log/contractors?${new URLSearchParams({ search, offset: String(offset) })}`);
          const data = await response.json() as { contractors?: ContractorActivityOption[]; next_offset?: number | null; error?: string };
          if (!response.ok || !data.contractors) throw new Error(data.error ?? "Unable to load contractors.");
          if (active) { setOptions(data.contractors); setNext(data.next_offset ?? null); setError(""); }
        } catch (reason) { if (active) { setOptions([]); setError(reason instanceof Error ? reason.message : "Unable to load contractors."); } }
        finally { if (active) setLoading(false); }
      })();
    }, 250);
    return () => { active = false; window.clearTimeout(timeout); };
  }, [search, offset]);
  return (
    <main className="min-h-screen bg-[#f5f7fb] p-4 text-slate-800 sm:p-8">
      <div className="mx-auto max-w-6xl space-y-5">
        <header><p className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-400">Operations</p><h1 className="mt-2 text-3xl font-semibold">Contractor Activity Log</h1>
          <p className="mt-2 text-sm text-slate-500">Review existing activity, Follow-Ups, and Communications for one contractor. Work individual Follow-Ups on the Contractor Card.</p></header>
        <section aria-label="Contractor selection" className="space-y-3 rounded border border-slate-200 bg-white p-4">
          <label className="block text-sm font-medium">Find Contractor
            <input type="search" maxLength={200} value={search} onChange={(event) => { setLoading(true); setOffset(0); setSelected(""); setOptions([]); setSearch(event.target.value); }} className="mt-1 block w-full rounded border border-slate-300 px-2 py-1" />
          </label>
          <div>
            <label htmlFor="activity-contractor" className="text-sm font-medium">Contractor</label>
            <select id="activity-contractor" value={selected} disabled={loading} onChange={(event) => setSelected(event.target.value)} className="mt-1 block w-full rounded border border-slate-300 px-2 py-1 text-sm">
              <option value="">{loading ? "Loading contractors..." : "Select a contractor"}</option>
              {options.map((contractor) => <option key={contractor.id} value={contractor.id}>{contractor.company_name}</option>)}
            </select>
          </div>
          {!loading && !error && !options.length ? <p className="text-sm text-slate-500">No contractors match this search.</p> : null}
          {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : null}
          <div className="flex gap-2 text-xs">
            <button type="button" className={button} disabled={loading || offset === 0} onClick={() => { setLoading(true); setSelected(""); setOffset(Math.max(0, offset - 50)); }}>Previous Contractors</button>
            <button type="button" className={button} disabled={loading || next === null} onClick={() => { if (next !== null) { setLoading(true); setSelected(""); setOffset(next); } }}>More Contractors</button>
          </div>
        </section>
        {selected ? <Timeline key={selected} contractorId={Number(selected)} /> : <p className="text-sm text-slate-500">Select a contractor to view permitted history.</p>}
      </div>
    </main>
  );
}
