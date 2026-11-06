"use client";

import { useEffect, useState } from "react";
import { loadProjectLifecycle } from "@/services/project-lifecycle";
import type { LifecycleAssignment, ProjectLifecycleAction, ProjectLifecycleReview } from "@/types/project-lifecycle";

const reasons = ["Work Complete", "No Longer Onsite", "Removed from Project", "Added in Error", "Other"];
const button = "rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium disabled:opacity-50";
const sourceName = (source: string) => source === "MYCOI" ? "myCOI" : source === "PROCORE" ? "Procore" : source === "MANUAL" ? "Manual" : source;
const time = (value: string | null) => value ? new Date(value).toLocaleString() : "Not recorded";

export default function ProjectLifecyclePanel({ projectId, requestClose = false, onChanged }: {
  projectId: number; requestClose?: boolean; onChanged: () => Promise<void>;
}) {
  const [review, setReview] = useState<ProjectLifecycleReview | null>(null);
  const [tab, setTab] = useState<"active" | "completed" | "history">("active");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<{ action: "close" } | { action: "end"; assignment: LifecycleAssignment } |
    { action: "detach"; assignment: LifecycleAssignment; source: "PROCORE" | "MYCOI" } | null>(requestClose ? { action: "close" } : null);
  const [reason, setReason] = useState(reasons[0]);
  const [acknowledged, setAcknowledged] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    loadProjectLifecycle(projectId).then(data => { if (active) setReview(data); })
      .catch(cause => { if (active) setError(cause instanceof Error ? cause.message : "Unable to load lifecycle."); });
    return () => { active = false; };
  }, [projectId]);
  const refresh = async () => {
    setBusy(true); setError(null);
    try { setReview(await loadProjectLifecycle(projectId)); setAcknowledged(false); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to reload lifecycle."); }
    finally { setBusy(false); }
  };
  const execute = async () => {
    if (!review || !confirm || !acknowledged) return;
    setBusy(true); setError(null);
    const action: ProjectLifecycleAction = confirm.action === "close" ? { action: "close", token: review.token } :
      confirm.action === "end" ? { action: "end", token: review.token, assignment: confirm.assignment.id, reason } :
        { action: "detach", token: review.token, assignment: confirm.assignment.id, source: confirm.source };
    try {
      setReview(await loadProjectLifecycle(projectId, action));
      setConfirm(null); setAcknowledged(false);
      setNotice(action.action === "close" ? "Project closed. All history retained." :
        action.action === "end" ? "Assignment period ended. History retained." : "Current designation detached. Assignment remains Active.");
      await onChanged();
    } catch (cause) {
      setAcknowledged(false);
      setError(cause instanceof Error ? cause.message : "Unable to update project lifecycle.");
    } finally { setBusy(false); }
  };
  const begin = (action: NonNullable<typeof confirm>) => {
    setConfirm(action); setAcknowledged(false); setError(null); setReason(reasons[0]);
  };
  const currentProject = review?.project.status === "Active" && !review.project.closed_at;
  const rows = review?.assignments.filter(row => tab === "history" || (tab === "active" ? row.active : !row.active)) ?? [];
  return <section aria-label="Project relationships" className="space-y-4 rounded-xl border border-slate-200 p-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h3 className="text-lg font-semibold">Contractor / Project Relationships</h3>
      <div className="flex gap-2">
        <button className={button} disabled={busy} onClick={() => void refresh()}>Reload Review</button>
        {review?.canManage && currentProject ? <button className={`${button} text-red-700`} disabled={busy} onClick={() => begin({ action: "close" })}>Close Project</button> : null}
      </div>
    </div>
    {error ? <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p> : null}
    {notice ? <p role="status" className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800">{notice}</p> : null}
    {!review ? <p className="text-sm text-slate-500">{error ? "Lifecycle controls unavailable. No changes were made." : "Loading authoritative project relationships..."}</p> : <>
      {review.project.closed_at ? <p className="rounded-lg bg-slate-100 p-3 text-sm">Closed {time(review.project.closed_at)} by {review.events.find(event => event.action === "Project Closed")?.actor_name ?? review.project.closed_by}. History remains accessible; assignments are not automatically reopened.</p> : null}
      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Assignment periods">
        {(["active", "completed", "history"] as const).map(value => <button key={value} role="tab" aria-selected={tab === value}
          className={`${button} ${tab === value ? "bg-slate-900 text-white" : ""}`} onClick={() => setTab(value)}>
          {value === "active" ? "Active Contractors" : value === "completed" ? "Completed Work" : "All History"}
        </button>)}
      </div>
      {rows.length ? <div className="overflow-x-auto"><table className="w-full text-left text-sm" aria-label="Assignment relationships">
        <thead className="bg-slate-50"><tr>{["Contractor / Source History", "Assignment Period", "Status / End Reason", "Actions"].map(label => <th key={label} className="p-3">{label}</th>)}</tr></thead>
        <tbody>{rows.map(row => <tr key={row.id} className="border-t border-slate-200 align-top">
          <td className="p-3"><a className="font-medium text-indigo-700" href={`/contractors/${row.contractor_id}`}>{row.contractor_name}</a>
            {row.contractor_trade ? <p className="text-xs text-slate-500">{row.contractor_trade}</p> : null}
            <div className="mt-1 flex gap-1">{row.active ? row.ownership_sources.filter(source => !row.detached_designations[source]).map(source =>
              <span key={source} className="rounded bg-slate-100 px-2 py-1 text-xs">{sourceName(source)}</span>) : null}</div>
            <p className="mt-2 text-xs text-slate-500">Originally assigned through {row.original_sources.map(sourceName).join(" / ") || "source not recorded"}.</p>
            {Object.entries(row.detached_designations).map(([source, record]) => <p key={source} className="mt-1 text-xs text-slate-500">{sourceName(source)} designation detached {time(record.at)} by {record.name}.</p>)}
          </td>
          <td className="p-3">Started {row.assigned_date}<br />{row.active ? "Ongoing" : `Ended ${row.ended_at ? time(row.ended_at) : row.removed_date ?? "date not recorded"}`}
            {!row.active ? <p className="mt-1 text-xs text-slate-500">By {review.events.find(event => event.assignment_id === row.id && event.action === "Assignment Ended")?.actor_name ??
              (row.end_reason === "Project Closed" ? review.events.find(event => event.action === "Project Closed")?.actor_name : null) ?? row.ended_by ?? "not recorded"}</p> : null}</td>
          <td className="p-3">{row.active ? "Active" : row.end_reason ?? "Ended by source reconciliation / legacy removal"}</td>
          <td className="space-y-2 p-3">{review.canManage && currentProject && row.active ? <>
            <button className={button} disabled={busy} onClick={() => begin({ action: "end", assignment: row })}>Mark Work Complete</button>
            {(["PROCORE", "MYCOI"] as const).filter(source => row.ownership_sources.includes(source) && !row.detached_designations[source]).map(source =>
              <button key={source} className={`${button} block`} disabled={busy} onClick={() => begin({ action: "detach", assignment: row, source })}>Detach {sourceName(source)} Designation</button>)}
          </> : <span className="text-xs text-slate-500">Historical / read-only</span>}</td>
        </tr>)}</tbody>
      </table></div> : <p className="text-sm text-slate-500">No assignment periods in this view.</p>}
      <details><summary className="cursor-pointer font-medium">Preserved Project Records</summary>
        <p className="my-2 text-xs text-slate-500">Contacts, Follow-Ups, documents, policies and compliance are contractor-associated records, not exclusive project ownership. Closing does not complete Follow-Ups or delete these records.</p>
        <dl className="grid gap-2 text-sm sm:grid-cols-2">{Object.entries(review.counts).map(([label, count]) => <div key={label} className="flex justify-between gap-3 rounded bg-slate-50 p-2"><dt>{label}</dt><dd>{count}</dd></div>)}</dl>
        <h4 className="mt-4 font-medium">Contacts</h4>
        {review.contacts.length ? review.contacts.map(contact => <p key={contact.id} className="text-sm">{contact.contact_name} - {contact.title_or_role || "Contact"} ({contact.is_active ? "Active" : "Inactive"})</p>) : <p className="text-sm">No associated contacts.</p>}
        <h4 className="mt-4 font-medium">Follow-Ups / History</h4>
        {review.followups.length ? review.followups.map(item => <p key={item.id} className="text-sm">{item.followup_date}: {item.subject} - {item.status}</p>) : <p className="text-sm">No associated Follow-Ups.</p>}
        <h4 className="mt-4 font-medium">Procore / myCOI History</h4>
        {review.procore.map(item => <p key={item.id} className="break-all text-sm">Procore run {item.import_run_id}, history #{item.import_history_id}, source row {item.source_row}, {time(item.imported_at)}</p>)}
        {review.mycoi.map(item => <p key={item.id} className="text-sm">myCOI division: {item.raw_division_name} ({item.active ? "Active mapping" : "Historical mapping"})</p>)}
        {!review.procore.length && !review.mycoi.length ? <p className="text-sm">No retained lineage or division mapping records. Assignment source history is shown above.</p> : null}
        <h4 className="mt-4 font-medium">Relationship Events</h4>
        {review.events.map(event => <p key={event.id} className="text-sm">{time(event.occurred_at)} - {event.action} by {event.actor_name}{event.details.source ? ` (${sourceName(event.details.source)})` : ""}{event.details.reason ? `: ${event.details.reason}` : ""}</p>)}
      </details>
      {confirm ? <div role="dialog" aria-modal="true" aria-label={confirm.action === "close" ? "Project Closeout Review" : "Confirm Assignment Change"}
        className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/50 p-4">
        <div className="max-h-[90vh] w-full max-w-2xl space-y-4 overflow-y-auto rounded-2xl bg-white p-6 shadow-xl">
          <h3 className="text-xl font-semibold">{confirm.action === "close" ? "Project Closeout Review" :
            confirm.action === "end" ? "Mark Work Complete" : `Detach ${sourceName(confirm.source)} Designation`}</h3>
          <p className="font-medium">{review.project.project_number} - {review.project.project_name}</p>
          {confirm.action === "close" ? <>
            <p className="text-sm">Closing this project removes it and ended contractor assignments from current operational/compliance calculations. All project history will be retained.</p>
            <div className="rounded-lg border border-slate-200 p-3 text-sm"><h4 className="font-semibold">Assignment periods to end</h4>
              {review.assignments.filter(row => row.active).length ? <ul className="mt-2 list-inside list-disc">
                {review.assignments.filter(row => row.active).map(row => <li key={row.id}>{row.contractor_name} - assignment #{row.id}, started {row.assigned_date}</li>)}
              </ul> : <p className="mt-2">No active assignment periods.</p>}
            </div>
            <dl className="grid gap-2 text-sm sm:grid-cols-2">{Object.entries(review.counts).map(([label, count]) => <div key={label} className="rounded bg-slate-50 p-2"><dt>{label}</dt><dd className="font-semibold">{count}</dd></div>)}</dl>
            <p className="text-sm">All {review.assignments.filter(row => row.active).length} active assignment periods will end as Project Closed. NJ PWC monitoring will be reevaluated against remaining Active Public Works assignments. Material Only stays excluded. Compliance, documents, contacts, open Follow-Ups and import provenance are retained.</p>
          </> : <>
            <p>{confirm.assignment.contractor_name} - assignment #{confirm.assignment.id}</p>
            {confirm.action === "end" ? <label className="block text-sm">End reason<select aria-label="End reason" className={`${button} ml-3`} value={reason} onChange={event => setReason(event.target.value)}>{reasons.map(item => <option key={item}>{item}</option>)}</select></label> :
              <p className="text-sm">Only the current visible designation will be detached. The assignment remains Active. Original source, ownership and import history remain intact. Later imports cannot silently restore this badge on this assignment period.</p>}
          </>}
          {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : null}
          {!review.canManage || !currentProject ? <p className="text-sm text-amber-800">An administrator with Project Edit permission and an Active project are required.</p> : null}
          <label className="flex gap-2 text-sm"><input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} disabled={busy} />I confirm this exact change. All history will be preserved.</label>
          <div className="flex gap-3">
            <button className={button} disabled={busy} onClick={() => { setConfirm(null); setAcknowledged(false); }}>Cancel</button>
            <button className={button} disabled={busy} onClick={() => void refresh()}>Reload Review</button>
            <button className={`${button} bg-slate-900 text-white`} disabled={busy || !acknowledged || !review.canManage || !currentProject} onClick={() => void execute()}>{busy ? "Saving..." : confirm.action === "close" ? "Confirm Close Project" : "Confirm Change"}</button>
          </div>
        </div>
      </div> : null}
    </>}
  </section>;
}
