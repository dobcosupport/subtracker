"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { canAccessModule } from "@/lib/permissions";
import { getOpenFollowups, type DashboardFollowup } from "@/services/followups";
import { useSessionProfile } from "./SessionContext";

export default function DashboardFollowups({ page = false }: { page?: boolean }) {
  const profile = useSessionProfile();
  if (!profile.system_administrator && (!canAccessModule(profile.permissions, "followups")
    || !canAccessModule(profile.permissions, "contractors"))) return null;
  return <FollowupsQueue page={page} />;
}

function FollowupsQueue({ page }: { page: boolean }) {
  const [open, setOpen] = useState(false);
  const [followups, setFollowups] = useState<DashboardFollowup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const dialog = useRef<HTMLDialogElement>(null);

  const refresh = useCallback(() => {
    const current = ++request.current;
    return getOpenFollowups().then((result) => {
      if (current !== request.current) return;
      if (result.error || !result.data) {
        setFollowups([]);
        setError(result.error?.message ?? "Unable to load open follow-ups.");
      } else {
        setFollowups(result.data);
        setError(null);
      }
    }, (reason: unknown) => {
      if (current !== request.current) return;
      setFollowups([]);
      setError(reason instanceof Error ? reason.message : "Unable to load open follow-ups.");
    }).finally(() => {
      if (current === request.current) setLoading(false);
    });
  }, []);

  const reload = useCallback(() => {
    setLoading(true);
    setError(null);
    void refresh();
  }, [refresh]);

  useEffect(() => {
    void refresh();
    const requests = request;
    window.addEventListener("focus", reload);
    return () => {
      requests.current++;
      window.removeEventListener("focus", reload);
    };
  }, [refresh, reload]);

  useEffect(() => {
    if (!open) return;
    const element = dialog.current;
    const focus = document.activeElement;
    const overflow = document.body.style.overflow;
    element?.showModal();
    document.body.style.overflow = "hidden";
    return () => {
      element?.close();
      document.body.style.overflow = overflow;
      if (focus instanceof HTMLElement && focus.isConnected) focus.focus();
    };
  }, [open]);

  const contents = <div className="flex max-h-[90dvh] flex-col">
        <header className="flex shrink-0 items-center justify-between gap-4 border-b border-slate-200 px-5 py-4">
          <div>
            <h2 id="dashboard-followups-title" className="text-xl font-semibold text-slate-900">Open Follow-Ups</h2>
            <p className="mt-1 text-sm text-slate-500">Open and Waiting Response items, oldest follow-up date first. Manage items on the company card.</p>
          </div>
          {!page ? <button type="button" autoFocus aria-label="Close Follow-Ups" onClick={() => setOpen(false)}
            className="px-2 text-xl">&times;</button> : null}
        </header>
        <div className="min-h-0 flex-1 overflow-auto">
          {error ? <p role="alert" className="p-5 text-sm text-red-700">{error}</p>
            : loading ? <p role="status" className="p-5 text-sm text-slate-500">Loading open follow-ups...</p>
            : !followups.length ? <p className="p-5 text-sm text-slate-500">No open follow-ups.</p>
            : <table className="min-w-full border-collapse text-left">
              <thead className="bg-slate-50"><tr>
                {["Company Name", "Follow-Up Item", "Follow-Up Date", "Status", "Company"].map((heading) =>
                  <th key={heading} className="border border-slate-200 px-4 py-3 text-sm font-semibold text-slate-700">{heading}</th>)}
              </tr></thead>
              <tbody>{followups.map((followup) => <tr key={followup.id} className="align-top hover:bg-slate-50/80">
                <td className="border border-slate-200 px-4 py-3 text-sm font-medium text-slate-800">{followup.contractor.company_name}</td>
                <td className="border border-slate-200 px-4 py-3 text-sm text-slate-700">
                  <p className="font-medium">{followup.subject}</p>
                  {followup.notes ? <p className="mt-1 whitespace-pre-wrap text-slate-500">{followup.notes}</p> : null}
                </td>
                <td className="whitespace-nowrap border border-slate-200 px-4 py-3 text-sm text-slate-600">{followup.followup_date || "No date"}</td>
                <td className="whitespace-nowrap border border-slate-200 px-4 py-3 text-sm text-slate-600">{followup.status}</td>
                <td className="whitespace-nowrap border border-slate-200 px-4 py-3 text-sm">
                  <Link href={`/contractors/${followup.contractor_id}`} className="text-indigo-600 hover:underline">Open Company</Link>
                </td>
              </tr>)}</tbody>
            </table>}
        </div>
        <footer className="flex shrink-0 justify-end border-t border-slate-200 px-5 py-4">
          <button type="button" disabled={loading} onClick={reload}
            className="rounded-xl border border-slate-200 px-4 py-2 text-sm text-slate-700 disabled:opacity-50">Refresh follow-ups</button>
        </footer>
      </div>;

  if (page) return <section aria-labelledby="dashboard-followups-title" className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">{contents}</section>;
  return <>
    <button type="button" onClick={() => { setOpen(true); reload(); }}
      className="rounded-2xl border border-violet-200 bg-violet-50 text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-md">
      <div className="font-bold tracking-tight text-violet-700">{loading ? "..." : error ? "!" : followups.length}</div>
      <div className="font-medium text-slate-700">Follow-Ups</div>
    </button>
    {!open && error ? <span role="alert" className="sr-only">Unable to load follow-ups. Open Follow-Ups to retry.</span> : null}
    {open ? <dialog ref={dialog} aria-modal="true" aria-labelledby="dashboard-followups-title"
      onCancel={(event) => { event.preventDefault(); setOpen(false); }}
      className="fixed inset-0 m-auto w-[calc(100%_-_2rem)] max-w-5xl rounded-2xl border border-slate-200 p-0 shadow-xl backdrop:bg-slate-900/40">
      {contents}
    </dialog> : null}
  </>;
}
