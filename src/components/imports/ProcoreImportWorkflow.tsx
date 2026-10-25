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
function lastPage(total: number) { return Math.max(0, Math.ceil(total / 20) - 1); }
function Pager({ page, total, onPage, direct = false }: { page: number; total: number; onPage: (page: number) => void; direct?: boolean }) {
  const pages = lastPage(total) + 1;
  return <div className={`${styles.actions} my-2`}>
    <button type="button" className={secondary} disabled={!page} onClick={() => onPage(page - 1)}>Previous review page</button>
    {direct ? <form className="flex items-center gap-2 text-xs" noValidate onSubmit={(event) => {
      event.preventDefault();
      const input = event.currentTarget.elements.namedItem("page");
      if (!(input instanceof HTMLInputElement) || !input.value.trim()) return;
      const requested = Number(input.value);
      if (!Number.isSafeInteger(requested)) return;
      const next = Math.min(pages, Math.max(1, requested));
      input.value = String(next); onPage(next - 1);
    }}>
      <label>Page <input key={page} aria-label="Contractor review page" name="page" type="number" min={1} max={pages} step={1}
        defaultValue={page + 1} className="h-7 w-16 rounded-md border border-slate-300 px-2 text-xs" /></label>
      <span>of {pages}</span><button type="submit" className={secondary}>Go</button>
    </form> : <span className="text-xs">Page {page + 1} of {pages}</span>}
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
  const [projectChoices, setProjectChoices] = useState<Record<string, string>>({});
  const [duplicateConfirmation, setDuplicateConfirmation] = useState<{
    key: string; name: string; suggestion: { id: number; label: string };
  } | null>(null);
  const [filter, setFilter] = useState("");
  const [vendorPage, setVendorPage] = useState(0);
  const [contactPage, setContactPage] = useState(0);
  const [projectPage, setProjectPage] = useState(0);
  const [finalization, setFinalization] = useState<{ revision: number; token: string; summary: ProcorePreview["summary"] } | null>(null);
  const finalized = !!review?.run.finalized_at;
  const accept = (result: ProcoreResponse) => {
    const sameRun = review?.run.id === result.run.id;
    setReview(result);
    if (!sameRun) { setChoices({}); setProjectChoices({}); }
    setVendorPage((page) => sameRun ? Math.min(page, lastPage(result.preview.vendors.filter((v) =>
      v.name.toLowerCase().includes(filter.toLowerCase())).length)) : 0);
    setContactPage((page) => sameRun ? Math.min(page, lastPage(result.preview.contacts.length)) : 0);
    setProjectPage((page) => sameRun ? Math.min(page, lastPage(result.preview.projects.length)) : 0);
  };
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
    if (!review || finalized || busy) return;
    const saved = review.run.decisions.vendors[key];
    if (choice.action === "ADD" && saved?.action === "ADD" &&
      JSON.stringify(choice.duplicateOverride) === JSON.stringify(saved.duplicateOverride)) return;
    if (choice.action === "MATCH" && (saved?.action === "MATCH" && saved.contractorId === choice.contractorId ||
      review.preview.vendors.find((vendor) => vendor.key === key)?.contractorId === choice.contractorId)) return;
    void perform(async () => {
      accept(await api<ProcoreResponse>(`/api/imports/procore/${review.run.id}`, {
        method: "PATCH", body: JSON.stringify({ revision: review.run.revision,
          decisions: { vendors: { ...review.run.decisions.vendors, [key]: choice } } }),
      }));
      setChoices((current) => { const next = { ...current }; delete next[key]; return next; });
      setMessage("Review decision saved. No contractor, contact or ownership is created until Import.");
    });
  };
  const saveProject = (number: string, projectId: number | null) => {
    if (!review || finalized || busy) return;
    void perform(async () => {
      accept(await api<ProcoreResponse>(`/api/imports/procore/${review.run.id}/projects`, {
        method: "PATCH", body: JSON.stringify({ revision: review.run.revision, token: review.token, number, projectId }),
      }));
      setProjectChoices((current) => { const next = { ...current }; delete next[number]; return next; });
      setMessage("Procore project mapping saved for this and future imports. No assignment or ownership is created until Import.");
    });
  };
  if (!canView) return null;
  const vendors = review?.preview.vendors.filter((v) => v.name.toLowerCase().includes(filter.toLowerCase())) ?? [];
  const contractors = [...(review?.contractors ?? [])].sort((a, b) => a.company_name.localeCompare(b.company_name));
  const requestBody = review ? { revision: review.run.revision, token: review.token } : null;
  return <section aria-label="Procore Import" className={`${styles.workflow} rounded-2xl border border-slate-200 bg-white p-5 shadow-sm`}>
    <h2 className="text-xl font-semibold text-slate-900">Procore Import</h2>
    <p className="my-2 text-sm text-slate-600">Import approved companies, contacts and project relationships using explicit Procore project mappings or exact project numbers. Import adds PROCORE ownership only; MANUAL and MYCOI are preserved. Existing contractor/contact information is never overwritten. Finalize closes the file, including unmatched items; it does not import staged Adds or reconcile absence.</p>
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
      <Pager page={vendorPage} total={vendors.length} onPage={setVendorPage} direct={!finalized} />
      {vendors.slice(vendorPage * 20, (vendorPage + 1) * 20).map((vendor) => {
        const decision = review.run.decisions.vendors[vendor.key];
        const savedAdd = decision?.action === "ADD";
        const suggestion = vendor.suggestions.length === 1 ? vendor.suggestions[0] : null;
        const matchedName = contractors.find((contractor) => contractor.id === vendor.contractorId)?.company_name;
        const override = decision?.action === "ADD" ? decision.duplicateOverride : undefined;
        const staleOverride = !!override && (vendor.suggestions.length !== 1 || suggestion?.id !== override.contractorId ||
          suggestion?.label !== override.companyName || !override.approvedBy || !override.approvedAt);
        const reviewAdd = !vendor.contractorId && (staleOverride || (savedAdd && !override && vendor.suggestions.length > 0));
        const plan = review.preview.ready.find((entry) => entry.key === vendor.key);
        const importedRows = vendor.sourceRows.filter((row) => review.run.imported_rows.includes(row)).length;
        const contactIssues = review.preview.contacts.filter((contact) => contact.vendor === vendor.name && contact.issue);
        return <article key={vendor.key} className="my-2 rounded-xl border border-slate-200 p-3">
        <div className={styles.vendorHeader}><div className={styles.vendorIdentity}>
          <h5 className="font-semibold">{vendor.name || "(Missing company name)"}</h5>
          <p className="text-xs">{vendor.sourceRows.length} source rows · {vendor.contractorId ? `Matched contractor #${vendor.contractorId}` : vendor.addContractor ? "Add Contractor staged" : "Unmatched"}</p>
          {vendor.contractorId ? <p className="my-1 text-xs font-semibold text-blue-800">MATCHED — {matchedName ?? `Contractor #${vendor.contractorId}`}</p> : null}
          {savedAdd && !finalized ? <p className="my-1 text-xs font-semibold text-blue-800">ADD saved — {vendor.contractorId ? `mapped to contractor #${vendor.contractorId}` : "Will Add on Import; contractor decision resolved"}. You can still Match Contractor or Leave Unmatched before Import.</p> : null}
          {override && !finalized && !vendor.contractorId ? <p className="my-1 text-xs text-amber-800">{staleOverride
            ? "Duplicate-name override requires review." : "Duplicate-name override approved"} — {override.companyName} (#{override.contractorId})</p> : null}
          {!finalized ? <p className="my-1 text-xs font-semibold">{plan ? `${plan.rows.length} source rows import-ready · ${plan.assignments.length} project assignments`
            : importedRows === vendor.sourceRows.length ? "All source rows already imported."
              : "No source rows import-ready for this company; see remaining issues below."}</p> : null}
          <p className="my-1 text-xs">Company phone: {vendor.company.phone || "—"} · Address: {[vendor.company.address_1,
            vendor.company.city, vendor.company.state, vendor.company.zip_code].filter(Boolean).join(", ") || "—"}</p>
        </div></div>
        {vendor.issues.map((issue) => <p key={issue} className="my-1 text-xs text-amber-800">{issue}</p>)}
        {contactIssues.map((contact, index) => <p key={index} className="my-1 text-xs text-slate-600">
          Contact {contact.contact_name || contact.email || "(unnamed)"}: {contact.issue} Contractor/project eligibility is unchanged.
        </p>)}
        {suggestion ? <div className="my-2 text-xs">
          <p>Suggested: <strong>{suggestion.label}</strong></p>
          {!finalized ? <button type="button" className={primary} aria-label={`Accept Match: ${suggestion.label}`}
            disabled={busy || !canWrite || vendor.contractorId === suggestion.id}
            onClick={() => save(vendor.key, { action: "MATCH", contractorId: suggestion.id })}>Accept Match</button> : null}
        </div> : vendor.suggestions.length ? <p className="text-xs">Multiple normalized-name candidates: {vendor.suggestions.map((s) => s.label).join("; ")}. Choose the correct contractor below.</p> : null}
        {!finalized ? <div className={`${styles.actions} mt-2`}>
          <select aria-label={`Match contractor for ${vendor.name}`} className="max-w-full rounded border border-slate-300 p-1 text-sm" disabled={busy || !canWrite}
            value={choices[vendor.key] ?? ""} onChange={(e) => setChoices((current) => ({ ...current, [vendor.key]: e.target.value }))}>
            <option value="">Choose existing contractor</option>{contractors.map((c) => <option key={c.id} value={c.id}>{c.company_name}{c.active ? "" : " (Inactive)"}</option>)}
          </select>
          <button type="button" className={secondary} disabled={busy || !canWrite || !choices[vendor.key] || Number(choices[vendor.key]) === vendor.contractorId} onClick={() => save(vendor.key, { action: "MATCH", contractorId: Number(choices[vendor.key]) })}>Match Contractor</button>
          <button type="button" className={suggestion ? secondary : primary}
            disabled={busy || !canWrite || !canAdd || (savedAdd && !reviewAdd) || importedRows > 0 || !vendor.key}
            onClick={() => {
              if (suggestion) setDuplicateConfirmation({ key: vendor.key, name: vendor.name, suggestion });
              else if (vendor.suggestions.length) setError("Multiple normalized-name contractors exist. Choose an existing contractor; a separate-contractor override requires one unambiguous suggestion.");
              else save(vendor.key, { action: "ADD" });
            }}>{reviewAdd ? "Review Add Contractor" : savedAdd ? "ADD saved" : "Add Contractor"}</button>
          <button type="button" className={destructive} disabled={busy || !canWrite} onClick={() => save(vendor.key, { action: "UNMATCHED" })}>Leave Unmatched</button>
        </div> : null}
      </article>;
      })}
      <details className="my-3 rounded-xl border border-slate-200 p-3"><summary className="cursor-pointer font-semibold">Projects — approved mappings, otherwise exact project numbers</summary>
        {!finalized ? <p className="my-2 text-xs">Explicit project decisions apply to future Procore imports too. No numbers are changed and no projects are created. Select a different project to intentionally change a mapping, or Leave Unmatched.</p> : null}
        <Pager page={projectPage} total={review.preview.projects.length} onPage={setProjectPage} />
        {review.preview.projects.slice(projectPage * 20, (projectPage + 1) * 20).map((p) => {
          const imported = p.rows.some((row) => review.run.imported_rows.includes(row));
          return <div key={p.number} className="my-2 rounded border border-slate-200 p-2" aria-label={`Procore project ${p.number}`}>
            <p className="text-sm">{p.number || "(Blank project number)"}: {p.projectId
              ? `MATCHED ${p.number} → ${p.targetNumber ?? p.number} (#${p.projectId})${p.mapped ? " — approved mapping" : " — exact match"}`
              : "Unmatched — no project will be created"}</p>
            {!finalized && p.number ? <div className={`${styles.actions} mt-1`}>
              <select aria-label={`Match project for ${p.number}`} className="max-w-full rounded border border-slate-300 p-1 text-sm"
                disabled={busy || !canWrite || imported} value={projectChoices[p.number] ?? String(p.projectId ?? "")}
                onChange={(event) => setProjectChoices((current) => ({ ...current, [p.number]: event.target.value }))}>
                <option value="">Choose SubTracker project</option>
                {[...(review.projects ?? [])].sort((a, b) => a.project_number.localeCompare(b.project_number)).map((project) =>
                  <option key={project.id} value={project.id}>{project.project_number} — {project.project_name}</option>)}
              </select>
              <button type="button" className={secondary} disabled={busy || !canWrite || imported || !projectChoices[p.number] ||
                Number(projectChoices[p.number]) === p.projectId} onClick={() => saveProject(p.number, Number(projectChoices[p.number]))}>Match Project</button>
              <button type="button" className={destructive} disabled={busy || !canWrite || imported || (p.mapped && !p.projectId)}
                onClick={() => saveProject(p.number, null)}>Leave Unmatched</button>
              {imported ? <span className="text-xs">Already imported in this review; mapping cannot be changed here.</span> : null}
            </div> : null}
          </div>;
        })}
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
    {duplicateConfirmation ? <dialog aria-label="Create separate contractor"
      ref={(node) => { if (node && !node.open) node.showModal(); }}
      onCancel={(event) => { event.preventDefault(); setDuplicateConfirmation(null); }}
      className="m-auto max-w-lg rounded-2xl bg-white p-5 shadow-xl backdrop:bg-slate-900/40">
      <h3 className="font-semibold">A similar SubTracker contractor already exists:</h3>
      <p className="my-2 text-sm">{duplicateConfirmation.suggestion.label} (#{duplicateConfirmation.suggestion.id})</p>
      <p className="my-2 text-sm">Create a separate contractor for {duplicateConfirmation.name} anyway? Creation occurs only during Import Resolved Records.</p>
      <div className={styles.actions}>
        <button type="button" className={secondary} onClick={() => setDuplicateConfirmation(null)}>Cancel</button>
        <button type="button" className={primary} onClick={() => {
          const confirmation = duplicateConfirmation;
          setDuplicateConfirmation(null);
          save(confirmation.key, { action: "ADD", duplicateOverride: {
            contractorId: confirmation.suggestion.id, companyName: confirmation.suggestion.label,
          } });
        }}>Create Separate Contractor</button>
      </div>
    </dialog> : null}
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
