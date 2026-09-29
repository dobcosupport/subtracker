"use client";

import { useEffect, useMemo, useState } from "react";
import { adminFetch } from "@/lib/admin-client";
import type { AdministrationAuditEntry } from "@/types/user-management";

function formatDate(value: string): string {
  return new Date(value).toLocaleString();
}

export default function AdministrationAuditPage() {
  const [entries, setEntries] = useState<AdministrationAuditEntry[]>([]);
  const [search, setSearch] = useState("");
  const [actionFilter, setActionFilter] = useState("All actions");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const loadEntries = async () => {
      try {
        const response = await adminFetch("/api/admin/audit");
        const result = await response.json() as { entries?: AdministrationAuditEntry[]; error?: string };
        if (!response.ok) throw new Error(result.error ?? "Unable to load audit history.");
        setEntries(result.entries ?? []);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "Unable to load audit history.");
      } finally {
        setLoading(false);
      }
    };
    void loadEntries();
  }, []);

  const actionOptions = useMemo(() => [...new Set(entries.map((entry) => entry.action))].sort(), [entries]);
  const visibleEntries = useMemo(() => {
    const term = search.trim().toLowerCase();
    return entries.filter((entry) => (actionFilter === "All actions" || entry.action === actionFilter)
      && (!term || [entry.user_name, entry.user_email, entry.action, entry.object_type, entry.object_label].some((value) => value.toLowerCase().includes(term))));
  }, [actionFilter, entries, search]);

  return (
    <main className="min-h-screen p-7 text-slate-800">
      <div className="mx-auto max-w-7xl space-y-6">
        <header><p className="text-xs font-semibold uppercase text-slate-400">Administration</p><h1 className="mt-2 text-3xl font-semibold text-slate-900">Audit Log</h1></header>
        {error ? <p role="alert" className="border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p> : null}
        <section className="overflow-hidden border border-slate-200 bg-white">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 p-4">
            <span className="text-sm text-slate-500">{visibleEntries.length} events</span>
            <div className="flex flex-wrap gap-2"><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search audit log" aria-label="Search audit log" className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm sm:w-64" /><select value={actionFilter} onChange={(event) => setActionFilter(event.target.value)} aria-label="Filter by action" className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"><option>All actions</option>{actionOptions.map((action) => <option key={action}>{action}</option>)}</select></div>
          </div>
          <div className="overflow-x-auto"><table className="w-full min-w-[850px] text-left"><thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr>{["User", "Date", "Action", "Object"].map((heading) => <th key={heading} className="border-b border-slate-200 px-4 py-3 font-semibold">{heading}</th>)}</tr></thead><tbody>
            {loading ? <tr><td colSpan={4} className="p-8 text-center text-sm text-slate-500">Loading audit history...</td></tr> : visibleEntries.length === 0 ? <tr><td colSpan={4} className="p-8 text-center text-sm text-slate-500">No matching events.</td></tr> : visibleEntries.map((entry) => <tr key={entry.id} className="border-b border-slate-100 last:border-0"><td className="px-4 py-3"><p className="text-sm font-medium text-slate-800">{entry.user_name}</p><p className="text-xs text-slate-500">{entry.user_email || "System"}</p></td><td className="px-4 py-3 text-sm text-slate-600">{formatDate(entry.audit_date)}</td><td className="px-4 py-3 text-sm text-slate-700">{entry.action}</td><td className="px-4 py-3"><p className="text-sm text-slate-800">{entry.object_label}</p><p className="text-xs text-slate-500">{entry.object_type}{entry.object_id ? ` #${entry.object_id}` : ""}</p>{entry.details.changed_fields?.length ? <p className="mt-1 text-xs text-slate-500">Changed: {entry.details.changed_fields.join(", ")}</p> : null}</td></tr>)}
          </tbody></table></div>
        </section>
      </div>
    </main>
  );
}
