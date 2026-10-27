"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { adminFetch } from "@/lib/admin-client";
import type { CompanyMergeHistory as History, CompanyMergeHistoryPage } from "@/types/database";

async function readHistory<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await adminFetch(url, { signal });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? "Unable to load company merge history.");
  return body as T;
}

function RetainedCategory({ contractorId, sourceId, category, label }: {
  contractorId: number; sourceId: number; category: string; label: string;
}) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<CompanyMergeHistoryPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function load(offset = 0) {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ source_id: String(sourceId), category, offset: String(offset) });
      const next = await readHistory<CompanyMergeHistoryPage>(`/api/contractors/${contractorId}/merge-history?${params}`);
      setPage((previous) => ({ ...next, rows: offset && previous ? [...previous.rows, ...next.rows] : next.rows }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to load retained history.");
    } finally { setLoading(false); }
  }
  const columns = [...new Set((page?.rows ?? []).flatMap((row) => Object.keys(row)))];
  return <div className="rounded-lg border border-slate-200 p-3">
    <button type="button" aria-expanded={open} className="text-left text-sm font-semibold text-indigo-700"
      onClick={() => { setOpen(!open); if (!open && !page && !loading) void load(); }}>{open ? "−" : "+"} {label}</button>
    {open ? <div className="mt-2 space-y-2 text-sm">
      {category === "communications" ? <p><Link href="/communications" className="text-indigo-700 underline">Open Communications</Link> — use the retained message IDs below. Message bodies, recipients and delivery details are not disclosed here.</p> : null}
      {category === "provenance" || category.endsWith("_provenance") ? <p>Permanent merge receipt evidence is projected field-by-field, not a raw snapshot. Missing after-values mean no after-image was recorded, not proof of deletion. Moved contacts and selected compliance keep their original record IDs; refer to the successor Company Card for their current state.</p> : null}
      {category === "sync_provenance" || ["sync_reviews", "pwc_requests", "brc_requests"].includes(category) ? <p>Registry evidence remains attributed to the originally searched company. Only lifecycle metadata is shown; candidate payloads, tax submissions, worker credentials and queue snapshots are not exposed.</p> : null}
      {category === "insurance_snapshot" ? <p>Manual insurance tracking on the original Company Card is archival evidence, not the successor&apos;s current insurance status.</p> : null}
      {error ? <p role="alert" className="text-red-700">{error} <button type="button" disabled={loading} onClick={() => void load(page?.next_offset ?? 0)} className="underline">Retry</button></p> : null}
      {page?.rows.length ? <div className="overflow-x-auto"><table className="w-full text-left text-xs">
        <caption className="sr-only">{label} retained under original company #{sourceId}</caption>
        <thead><tr>{columns.map((column) => <th key={column} className="whitespace-nowrap p-2">{column.replaceAll("_", " ")}</th>)}</tr></thead>
        <tbody>{page.rows.map((row, index) => <tr key={index} className="border-t border-slate-100">{columns.map((column) => <td key={column} className="max-w-sm break-words p-2">{row[column] === null || row[column] === undefined ? "—" : typeof row[column] === "boolean" ? row[column] ? "Yes" : "No" : String(row[column])}</td>)}</tr>)}</tbody>
      </table></div> : page ? <p>No retained rows in this category under original company #{sourceId}.</p> : null}
      {loading ? <p role="status">Loading retained history…</p> : null}
      {page?.next_offset !== null && page?.next_offset !== undefined ? <button type="button" disabled={loading} onClick={() => void load(page.next_offset!)} className="rounded border border-indigo-200 px-3 py-1 text-indigo-700">Load more — additional history remains</button> : page && !error ? <p className="text-xs text-slate-500">All {page.rows.length} retained rows loaded.</p> : null}
    </div> : null}
  </div>;
}

export default function CompanyMergeHistory({ contractorId }: { contractorId: number }) {
  const [result, setResult] = useState<{ id: number; history?: History; error?: string } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void readHistory<History>(`/api/contractors/${contractorId}/merge-history`, controller.signal)
      .then((history) => { if (!controller.signal.aborted) setResult({ id: contractorId, history }); })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setResult({ id: contractorId, error: reason instanceof Error ? reason.message : "Unable to load company merge history." });
      });
    return () => controller.abort();
  }, [contractorId]);
  const current = result?.id === contractorId ? result : null;
  const history = current?.history;
  const identity = (id: number) => {
    const company = history?.companies.find((item) => item.id === id);
    return <Link href={`/contractors/${id}`} className="font-medium text-indigo-700 underline">{company?.company_name ?? "Company"} #{id}</Link>;
  };
  return <section aria-labelledby="company-merge-history-heading" className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
    <h2 id="company-merge-history-heading" className="text-xl font-semibold text-slate-900">Company Merge History</h2>
    {!current ? <p role="status" className="mt-2 text-sm">Loading permanent merge history…</p> : current.error ? <p role="alert" className="mt-2 text-sm text-red-700">{current.error} Merge history has not been verified; this is not confirmation of no prior merges.</p> : history ? <div className="mt-3 space-y-4">
      {!history.receipts.length ? <p className="text-sm text-slate-500">No permanent merge receipts for this Company Card.</p> : <>
        <p className="text-sm text-slate-600">Original identities and histories are preserved. Nothing in this history viewer changes records or sends communications.</p>
        <ol className="space-y-3">{history.receipts.map((receipt) => <li key={receipt.id} className="rounded-xl border border-indigo-100 bg-indigo-50 p-3 text-sm">
          <p>Primary: {identity(receipt.primary_id)} · Secondary: {identity(receipt.secondary_id)} → Successor: {identity(receipt.successor_id)}</p>
          <p className="mt-1">Merged <time dateTime={receipt.merged_at}>{new Date(receipt.merged_at).toLocaleString()}</time> by {receipt.actor_name ?? "User"} ({receipt.actor_id})</p>
          <p className="mt-1 break-all text-xs text-slate-500">Permanent receipt: {receipt.id}</p>
        </li>)}</ol>
        <h3 className="font-semibold">Original Company Cards and categorized retained history</h3>
        {history.companies.map((company) => <details key={company.id} className="rounded-xl border border-slate-200 p-3" open={company.id === contractorId && !!company.merged_into_contractor_id}>
          <summary className="cursor-pointer text-sm font-semibold">{company.company_name} #{company.id} {company.merged_into_contractor_id ? "(archived predecessor — read-only)" : "(successor / current card)"}</summary>
          <div className="mt-3 space-y-3">
            <p className="text-sm">{identity(company.id)}{company.merged_into_contractor_id ? <> · Successor: {identity(company.merged_into_contractor_id)}</> : null}</p>
            <nav aria-label={`History pages for ${company.company_name} #${company.id}`} className="flex flex-wrap gap-3 text-xs text-indigo-700">
              {history.categories.some((category) => category.key === "documents" && category.allowed) ? <Link href="/documents" className="underline">Documents</Link> : null}
              {history.categories.some((category) => category.key === "activity" && category.allowed) ? <Link href="/activity-log" className="underline">Activity Log</Link> : null}
              {history.categories.some((category) => category.key === "communications" && category.allowed) ? <Link href="/communications" className="underline">Communications</Link> : null}
            </nav>
            <p className="text-xs text-slate-500">Rows below retain their original company IDs. Selected current compliance records and contacts may have moved to a successor; lineage references preserve the record IDs. Free-text notes, tax identifiers, message contents and recipient details are intentionally omitted.</p>
            {history.categories.map((category) => category.allowed
              ? <RetainedCategory key={`${contractorId}:${company.id}:${category.key}`} contractorId={contractorId} sourceId={company.id} category={category.key} label={category.label} />
              : <p key={category.key} className="text-xs text-slate-500">{category.label}: permission required.</p>)}
          </div>
        </details>)}
      </>}
    </div> : null}
  </section>;
}
