"use client";

import { useEffect, useState } from "react";
import { adminFetch } from "@/lib/admin-client";
import { useSessionProfile } from "@/components/SessionContext";
import type { ProcoreChoice, ProcoreHistory, ProcorePreview, ProcoreResponse } from "@/types/procore-import";
import styles from "./MycoiImportWorkflow.module.css";

const primary = `${styles.button} ${styles.primary}`;
const secondary = `${styles.button} ${styles.secondary}`;
const destructive = `${styles.button} ${styles.destructive}`;
async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await adminFetch(url, init);
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? "Procore request failed.");
  return value as T;
}
const summaryLabels: Record<keyof ProcorePreview["summary"], string> = {
  sourceRows: "Source rows", contractors: "Contractors", projects: "Projects", contacts: "Contacts",
  assignments: "Contractor/Project Assignments", readyAssignments: "Ready Assignments", importedRows: "Imported rows", unresolvedRows: "Unresolved rows",
};
function Statistics({ summary }: { summary: Partial<ProcorePreview["summary"]> }) {
  return <dl className="my-3 flex flex-wrap gap-x-5 gap-y-2 text-sm">{Object.entries(summaryLabels).map(([key, label]) =>
    <div key={key}><dt className="inline">{label}: </dt><dd className="inline font-semibold">{summary[key as keyof typeof summary] ?? 0}</dd></div>)}</dl>;
}
function Pager({ page, total, onPage }: { page: number; total: number; onPage: (page: number) => void }) {
  return <div className={`${styles.actions} my-2`}>
    <button type="button" className={secondary} disabled={!page} onClick={() => onPage(page - 1)}>Previous review page</button>
    <span className="text-xs">Page {page + 1} of {Math.max(1, Math.ceil(total / 20))}</span>
    <button type="button" className={secondary} disabled={(page + 1) * 20 >= total} onClick={() => onPage(page + 1)}>Next review page</button>
  </div>;
}

export default function ProcoreImportWorkflow() {
  const profile = useSessionProfile();
  const allowed = (module: string, write = false) => profile.system_administrator || profile.permissions.some((p) =>
    p.module === module && p.can_view && (!write || (module === "contractors" ? p.can_manage : p.can_add && p.can_edit)));
  const canView = ["imports", "projects", "contractors"].every((m) => allowed(m));
  const canWrite = ["imports", "projects", "contractors"].every((m) => allowed(m, true));
  const canAdd = profile.system_administrator || profile.permissions.some((p) => p.module === "contractors" && p.can_add);
  const [review, setReview] = useState<ProcoreResponse | null>(null);
  const [working, setWorking] = useState<ProcoreHistory[]>([]);
  const [history, setHistory] = useState<ProcoreHistory[]>([]);
  const [workingOffset, setWorkingOffset] = useState(0);
  const [historyOffset, setHistoryOffset] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState("");
  const [vendorPage, setVendorPage] = useState(0);
  const [contactPage, setContactPage] = useState(0);
  const [projectPage, setProjectPage] = useState(0);
  const [finalization, setFinalization] = useState<{ revision: number; token: string; summary: ProcorePreview["summary"] } | null>(null);
  const finalized = !!review?.run.finalized_at;
  const accept = (result: ProcoreResponse) => { setReview(result); setChoices({}); setVendorPage(0); setContactPage(0); setProjectPage(0); };
  const perform = async (action: () => Promise<void>) => {
    setBusy(true); setError(null); setMessage(null);
    try { await action(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Procore operation failed."); }
    finally { setBusy(false); }
  };
  const list = async (scope: "working" | "finalized", offset: number) => {
    const { runs } = await api<{ runs: ProcoreHistory[] }>(`/api/imports/procore?scope=${scope}&offset=${offset}`);
    if (scope === "working") { setWorking(runs); setWorkingOffset(offset); }
    else { setHistory(runs); setHistoryOffset(offset); }
  };
  useEffect(() => {
    if (!canView) return;
    let active = true;
    void api<{ runs: ProcoreHistory[] }>("/api/imports/procore?scope=working&offset=0")
      .then((result) => { if (active) setWorking(result.runs); })
      .catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : "Unable to load Procore imports."); });
    return () => { active = false; };
  }, [canView]);
  const save = (key: string, choice: ProcoreChoice) => {
    if (!review || finalized) return;
    void perform(async () => {
      accept(await api<ProcoreResponse>(`/api/imports/procore/${review.run.id}`, {
        method: "PATCH", body: JSON.stringify({ revision: review.run.revision,
          decisions: { vendors: { ...review.run.decisions.vendors, [key]: choice } } }),
      }));
      setMessage("Review decision saved. No contractor, contact or ownership is created until Import.");
    });
  };
  if (!canView) return null;
  const vendors = review?.preview.vendors.filter((v) => v.name.toLowerCase().includes(filter.toLowerCase())) ?? [];
  const contractors = [...(review?.contractors ?? [])].sort((a, b) => a.company_name.localeCompare(b.company_name));
  const requestBody = review ? { revision: review.run.revision, token: review.token } : null;
  return <section aria-label="Procore Import" className={`${styles.workflow} rounded-2xl border border-slate-200 bg-white p-5 shadow-sm`}>
    <h2 className="text-xl font-semibold text-slate-900">Procore Import</h2>
    <p className="my-2 text-sm text-slate-600">Import approved companies, contacts and exact project-number relationships. Import adds PROCORE ownership only; MANUAL and MYCOI are preserved. Existing contractor/contact information is never overwritten. Finalize closes the file, including unmatched items; it does not import staged Adds or reconcile absence.</p>
    <label className="block text-sm font-medium">Select Procore report (XLSX or CSV, up to 3 MB)
      <input aria-label="Procore report" className={`${styles.fileInput} my-2 block w-full`} type="file" accept=".xlsx,.csv"
        disabled={busy || !canWrite} onChange={(event) => {
          const file = event.target.files?.[0]; event.target.value = "";
          if (!file) return;
          void perform(async () => { const form = new FormData(); form.set("file", file);
            accept(await api<ProcoreResponse>("/api/imports/procore", { method: "POST", body: form })); await list("working", 0); });
        }} />
    </label>
    {error ? <p role="alert" className={`${styles.blockers} ${styles.red}`}>{error}</p> : null}
    {message ? <p role="status" className="my-2 text-sm text-emerald-800">{message}</p> : null}
    <h3 className="mt-3 font-semibold">Current / Working Procore Imports</h3>
    {!working.length ? <p className="my-2 text-sm text-slate-500">No working Procore imports. Upload a report to start.</p> : working.map((run) =>
      <article key={run.id} className="my-2 flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 p-3">
        <span className="font-medium">{run.file_name}</span><span className={`${styles.badge} ${styles.amber}`}>{run.status}</span>
        <span className="text-xs">{run.source_row_count} source rows</span>
        <button type="button" disabled={busy} className={secondary} onClick={() => void perform(async () =>
          accept(await api<ProcoreResponse>(`/api/imports/procore/${run.id}`)))}>Review {run.file_name}</button>
      </article>)}
    <div className={styles.actions}>
      <button type="button" className={secondary} disabled={busy || !workingOffset} onClick={() => void perform(() => list("working", workingOffset - 20))}>Previous working imports</button>
      <button type="button" className={secondary} disabled={busy || working.length < 20} onClick={() => void perform(() => list("working", workingOffset + 20))}>Next working imports</button>
      <button type="button" className={secondary} disabled={busy} onClick={() => void perform(() => list("working", workingOffset))}>Refresh Procore imports</button>
    </div>
    {review ? <div className="mt-4 border-t border-slate-200 pt-4">
      <h3 className="font-semibold">{finalized ? "Review History" : "Review"}: {review.run.file_name}</h3>
      <span className={`${styles.badge} ${finalized ? styles.gray : styles.blue}`}>{finalized ? "Finalized — read-only" : review.run.status}</span>
      <Statistics summary={review.preview.summary} />
      <div className={`${styles.actions} my-3`}>
        <button type="button" className={secondary} disabled={busy} onClick={() => void perform(async () => accept(await api<ProcoreResponse>(`/api/imports/procore/${review.run.id}`)))}>Reload Procore Review</button>
        {!finalized ? <>
          <button type="button" className={primary} disabled={busy || !canWrite || !review.preview.ready.length}
            onClick={() => void perform(async () => {
              accept(await api<ProcoreResponse>(`/api/imports/procore/${review.run.id}`, { method: "POST", body: JSON.stringify(requestBody) }));
              await list("working", workingOffset); setMessage("Procore Import completed. Resolved assignments now include PROCORE; other ownership is preserved.");
            })}>Import Resolved Records</button>
          <button type="button" className={secondary} disabled={busy || !canWrite} onClick={() => void perform(async () =>
            setFinalization(await api(`/api/imports/procore/${review.run.id}/finalize`)))}>Finalize Procore Import</button>
        </> : null}
      </div>
      <label className="my-3 block text-sm">Find company
        <input className="ml-2 rounded border border-slate-300 p-2" value={filter} onChange={(e) => { setFilter(e.target.value); setVendorPage(0); }} />
      </label>
      <h4 className="font-semibold">Contractors</h4>
      <Pager page={vendorPage} total={vendors.length} onPage={setVendorPage} />
      {vendors.slice(vendorPage * 20, (vendorPage + 1) * 20).map((vendor) => <article key={vendor.key} className="my-2 rounded-xl border border-slate-200 p-3">
        <div className={styles.vendorHeader}><div className={styles.vendorIdentity}>
          <h5 className="font-semibold">{vendor.name || "(Missing company name)"}</h5>
          <p className="text-xs">{vendor.sourceRows.length} source rows · {vendor.contractorId ? `Matched contractor #${vendor.contractorId}` : vendor.addContractor ? "Add Contractor staged" : "Unmatched"}</p>
          <p className="my-1 text-xs">Company phone: {vendor.company.phone || "—"} · Address: {[vendor.company.address_1,
            vendor.company.city, vendor.company.state, vendor.company.zip_code].filter(Boolean).join(", ") || "—"}</p>
        </div></div>
        {vendor.issues.map((issue) => <p key={issue} className="my-1 text-xs text-amber-800">{issue}</p>)}
        {vendor.suggestions.length ? <p className="text-xs">Suggested: {vendor.suggestions.map((s) => s.label).join("; ")} — explicit approval required.</p> : null}
        {!finalized ? <div className={`${styles.actions} mt-2`}>
          <select aria-label={`Match contractor for ${vendor.name}`} className="max-w-full rounded border border-slate-300 p-1 text-sm" disabled={busy || !canWrite}
            value={choices[vendor.key] ?? ""} onChange={(e) => setChoices((current) => ({ ...current, [vendor.key]: e.target.value }))}>
            <option value="">Choose existing contractor</option>{contractors.map((c) => <option key={c.id} value={c.id}>{c.company_name}{c.active ? "" : " (Inactive)"}</option>)}
          </select>
          <button type="button" className={secondary} disabled={busy || !canWrite || !choices[vendor.key]} onClick={() => save(vendor.key, { action: "MATCH", contractorId: Number(choices[vendor.key]) })}>Match Contractor</button>
          <button type="button" className={primary} disabled={busy || !canWrite || !canAdd || !!vendor.suggestions.length || !vendor.key} onClick={() => save(vendor.key, { action: "ADD" })}>Add Contractor</button>
          <button type="button" className={destructive} disabled={busy || !canWrite} onClick={() => save(vendor.key, { action: "UNMATCHED" })}>Leave Unmatched</button>
        </div> : null}
      </article>)}
      <details className="my-3 rounded-xl border border-slate-200 p-3"><summary className="cursor-pointer font-semibold">Projects — exact project numbers only</summary>
        <Pager page={projectPage} total={review.preview.projects.length} onPage={setProjectPage} />
        {review.preview.projects.slice(projectPage * 20, (projectPage + 1) * 20).map((p) =>
          <p key={p.number} className="my-1 text-sm">{p.number || "(Blank project number)"}: {p.projectId ? `Matched #${p.projectId}` : "Unmatched — no project will be created"}</p>)}
      </details>
      <details className="my-3 rounded-xl border border-slate-200 p-3"><summary className="cursor-pointer font-semibold">Contacts — deduplicated within contractor</summary>
        <p className="my-2 text-xs">Blank users do not block assignments. Existing contacts and communication preferences stay unchanged. Contact issues do not block valid assignments.</p>
        <Pager page={contactPage} total={review.preview.contacts.length} onPage={setContactPage} />
        {review.preview.contacts.slice(contactPage * 20, (contactPage + 1) * 20).map((c, i) =>
          <p key={i} className="my-2 text-sm">{c.vendor}: {c.contact_name || "(No name)"} · {c.email || "No email"} · Business: {c.business_phone || "—"} · Mobile: {c.mobile_phone || "—"}{c.issue ? ` · ${c.issue}` : " · New contact"}</p>)}
      </details>
    </div> : null}
    <details className="mt-4 rounded-xl border border-slate-200 p-3" onToggle={(event) => {
      if (event.currentTarget.open) void perform(() => list("finalized", historyOffset));
    }}><summary className="cursor-pointer font-semibold">Procore Import History</summary>
      <p className="my-2 text-xs">Retained finalized files are read-only. Finalizing never imports staged data or reconciles absence.</p>
      {!history.length ? <p className="my-2 text-sm">No finalized Procore imports.</p> : history.map((run) =>
        <article key={run.id} className="my-2 rounded border border-slate-200 p-3">
          <span className="font-medium">{run.file_name}</span><span className={`${styles.badge} ${styles.gray}`}>Finalized</span>
          <p className="text-xs">Finalized: {run.finalized_at ? new Date(run.finalized_at).toLocaleString() : ""}</p>
          <button type="button" className={secondary} disabled={busy} onClick={() => void perform(async () => accept(await api<ProcoreResponse>(`/api/imports/procore/${run.id}`)))}>Review History {run.file_name}</button>
        </article>)}
      <div className={styles.actions}>
        <button type="button" className={secondary} disabled={busy || !historyOffset} onClick={() => void perform(() => list("finalized", historyOffset - 20))}>Previous Procore history</button>
        <button type="button" className={secondary} disabled={busy || history.length < 20} onClick={() => void perform(() => list("finalized", historyOffset + 20))}>Next Procore history</button>
      </div>
    </details>
    {finalization && review ? <dialog aria-label="Finalize Procore Import"
      ref={(node) => { if (node && !node.open) node.showModal(); }}
      onCancel={(event) => { event.preventDefault(); if (!busy) setFinalization(null); }}
      className="m-auto max-h-[90vh] max-w-2xl overflow-y-auto rounded-2xl bg-white p-5 shadow-xl backdrop:bg-slate-900/40">
        <h3 className="font-semibold">Finalize {review.run.file_name}</h3>
        <Statistics summary={finalization.summary} />
        <p className="my-3 text-sm">I am finished working with this uploaded file. Unmatched companies/projects may remain. Staged Adds will not be executed. No ownership is added or removed.</p>
        <div className={styles.actions}>
          <button type="button" className={secondary} disabled={busy} onClick={() => setFinalization(null)}>Cancel</button>
          <button type="button" className={primary} disabled={busy} onClick={() => void perform(async () => {
            await api(`/api/imports/procore/${review.run.id}/finalize`, { method: "POST", body: JSON.stringify({ revision: finalization.revision, token: finalization.token, confirmed: true }) });
            accept(await api<ProcoreResponse>(`/api/imports/procore/${review.run.id}`));
            setFinalization(null); await list("working", 0); await list("finalized", 0); setMessage("Procore import Finalized. No additional data was imported.");
          })}>Confirm Finalize</button>
        </div>
    </dialog> : null}
  </section>;
}
