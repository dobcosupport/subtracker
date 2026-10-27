"use client";

import { useEffect, useRef, useState } from "react";
import { adminFetch } from "@/lib/admin-client";
import { useSessionProfile } from "@/components/SessionContext";
import type { CompanyContactAction, CompanyContactBatch, CompanyContactImportRow, CompanyContactReference, CompanyContactValues, CompanyContactsReview } from "@/types/company-contacts-import";
import styles from "./MycoiImportWorkflow.module.css";

const endpoint = "/api/imports/company-contacts";
const primary = `${styles.button} ${styles.primary}`;
const secondary = `${styles.button} ${styles.secondary}`;
const input = "h-7 w-full min-w-0 rounded-md border border-slate-400 bg-white px-2 text-xs focus-visible:outline-2 focus-visible:outline-blue-600";
async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await adminFetch(url, init);
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? "Company Contacts request failed.");
  return value as T;
}
function ContactValues({ values }: { values: CompanyContactValues }) {
  return <dl className="space-y-1 break-words text-xs">
    <div><dt className="inline font-semibold">Name: </dt><dd className="inline">{values.contact_name || "(blank)"}</dd></div>
    <div><dt className="inline font-semibold">Cell: </dt><dd className="inline">{values.mobile_phone || "(blank)"}</dd></div>
    <div><dt className="inline font-semibold">Email: </dt><dd className="inline">{values.email || "(blank)"}</dd></div>
  </dl>;
}
function ReviewRow({ row, contacts, busy, canWrite, onResolve }: {
  row: CompanyContactImportRow; contacts: CompanyContactReference[]; busy: boolean; canWrite: boolean;
  onResolve: (row: CompanyContactImportRow, action: CompanyContactAction, contact: CompanyContactReference | null, values: CompanyContactValues, confirmDuplicate: boolean) => void;
}) {
  const [selectedId, setSelectedId] = useState("");
  const [values, setValues] = useState<CompanyContactValues>(row.normalized);
  const [confirmed, setConfirmed] = useState(false);
  const [duplicate, setDuplicate] = useState(false);
  const selected = contacts.find((c) => c.id === selectedId) ?? null;
  const terminal = row.status === "IMPORTED" || row.status === "UPDATED";
  const choose = (id: string) => {
    const contact = contacts.find((c) => c.id === id);
    setSelectedId(id);
    setConfirmed(false);
    setValues({
      contact_name: row.normalized.contact_name || contact?.contact_name || "",
      email: row.normalized.email || contact?.email || null,
      mobile_phone: row.normalized.mobile_phone || contact?.mobile_phone || null,
    });
  };
  const save = (action: CompanyContactAction) => onResolve(row, action, selected, values, duplicate);
  return <details className="rounded-lg border border-slate-200 bg-white p-3">
    <summary className="cursor-pointer text-xs focus-visible:outline-2 focus-visible:outline-blue-600">
      <span className="font-semibold">Row {row.source_row}: {row.normalized.contact_name || "(missing Name)"}</span>
      <span className={`${styles.badge} ${row.status === "ERROR" ? styles.amber : terminal ? styles.green : styles.blue}`}>{row.status}</span>
      <span>{row.resolution ? `Resolved: ${row.resolution.action}` : "Needs decision"}</span>
      {row.contact_id ? <span className="ml-2">Contact saved</span> : null}
    </summary>
    <div className="mt-3 space-y-3">
      <div className="grid gap-3 md:grid-cols-2">
        <div><h4 className="mb-1 text-xs font-semibold">Original imported values</h4>
          <ContactValues values={{ contact_name: row.original.Name, mobile_phone: row.original.Cell, email: row.original.Email }} /></div>
        <div><h4 className="mb-1 text-xs font-semibold">{terminal ? "Saved result (at import time)" : "Existing selected contact"}</h4>
          {terminal && row.after_contact ? <ContactValues values={row.after_contact} /> : selected ? <>
            <ContactValues values={selected} /><p className="mt-1 text-xs">{selected.is_active ? "Active" : "Inactive — import will not reactivate"}</p>
          </> : <p className="text-xs">No contact selected. Suggestions are not accepted automatically.</p>}</div>
      </div>
      {row.issues.length ? <ul className="list-inside list-disc text-xs text-amber-900">{row.issues.map((v) => <li key={v}>{v}</li>)}</ul> : null}
      {row.duplicate_rows.length ? <p className="text-xs text-amber-900">Possible duplicate source rows: {row.duplicate_rows.join(", ")}. Choose one new contact; resolve other rows to the saved contact or Skip.</p> : null}
      {row.error ? <p role="alert" className="text-xs text-red-700">{row.error}</p> : null}
      {row.resolution ? <div className="rounded border border-blue-200 bg-blue-50 p-2 text-xs">
        <p className="font-semibold">Saved decision: {row.resolution.action}</p>
        {row.resolution.action === "UPDATE" || row.resolution.action === "ADD" ? <ContactValues values={row.resolution.values} /> : null}
        <p>Approved {new Date(row.resolution.approved_at).toLocaleString()} · {row.resolution.approved_by}</p>
      </div> : null}
      {!terminal && canWrite ? <fieldset disabled={busy} className="space-y-3 disabled:opacity-70">
        <div className="flex flex-wrap items-end gap-2">
          <label className="min-w-0 flex-1 text-xs">Select Existing Contact
            <select aria-label={`Existing contact for row ${row.source_row}`} className={`${input} mt-1`} value={selectedId} onChange={(e) => choose(e.target.value)}>
              <option value="">No contact selected</option>
              {contacts.map((c) => <option key={c.id} value={c.id}>{c.contact_name} · {c.email || "no email"} · {c.mobile_phone || "no cell"}{c.is_active ? "" : " · Inactive"}</option>)}
            </select>
          </label>
          {row.exact_matches.length === 1 ? <button className={secondary} type="button" onClick={() => choose(row.exact_matches[0].id)}>Accept Match</button> : null}
        </div>
        {row.suggestions.length ? <p className="break-words text-xs">Suggestions only: {row.suggestions.map((c) => `${c.contact_name} (${c.email || "no email"}; ${c.mobile_phone || "no cell"})`).join(" · ")}</p> : null}
        <div>
          <h4 className="mb-1 text-xs font-semibold">Proposed {selected ? "update" : "new contact"} — edit questionable values before approval</h4>
          <div className="grid gap-2 sm:grid-cols-3">
            {(["contact_name", "mobile_phone", "email"] as const).map((field) => <label key={field} className="min-w-0 text-xs">
              {field === "contact_name" ? "Name" : field === "mobile_phone" ? "Cell" : "Email"}
              <input aria-label={`Proposed ${field} for row ${row.source_row}`} className={`${input} mt-1`} value={values[field] ?? ""} onChange={(e) => {
                setValues((v) => ({ ...v, [field]: e.target.value })); setConfirmed(false);
              }} />
              {selected && (values[field] || selected[field] || "") !== (selected[field] || "") ? <span className="text-amber-900">Changes existing {selected[field] || "(blank)"}</span> : null}
            </label>)}
          </div>
          <p className="mt-1 text-xs text-slate-600">Blank imported/proposed fields never erase existing values. Keep Existing Values changes nothing. No user account, recipient enrollment or SMS consent is created.</p>
        </div>
        <label className="flex items-start gap-2 text-xs"><input type="checkbox" checked={duplicate} onChange={(e) => setDuplicate(e.target.checked)} />
          I reviewed the possible duplicates and explicitly approve this contact decision.</label>
        <label className="flex items-start gap-2 text-xs"><input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
          I confirm the selected contact and proposed result. A name suggestion alone is not an accepted match.</label>
        <div className={styles.actions}>
          <button type="button" className={primary} disabled={!confirmed || Boolean(selected)} onClick={() => save("ADD")}>Add Contact</button>
          <button type="button" className={primary} disabled={!confirmed || !selected} onClick={() => save("UPDATE")}>Update Existing Contact</button>
          <button type="button" className={secondary} disabled={!confirmed || !selected} onClick={() => save("KEEP")}>Keep Existing Values</button>
          <button type="button" className={secondary} onClick={() => save("SKIP")}>Skip</button>
          <button type="button" className={secondary} disabled={!row.resolution && row.status !== "ERROR"} onClick={() => save("UNDO")}>Undo / Change Resolution</button>
        </div>
      </fieldset> : null}
      <details className="text-xs"><summary className="cursor-pointer">Row audit history ({row.events.length})</summary>
        <p className="mt-1 break-all">Batch contact ID: {row.contact_id || "not applied"}</p>
        <p className="mt-1 break-all">Normalized comparison keys: {row.matching_keys.join(" · ") || "(none)"}</p>
        <ul className="mt-1 space-y-1">{row.events.map((event, index) => <li key={index}>{new Date(event.at).toLocaleString()} · {event.action} · {event.actor}
          {typeof event.error === "string" ? ` · ${event.error}` : ""}</li>)}</ul>
      </details>
    </div>
  </details>;
}

export default function CompanyContactsImportWorkflow() {
  const profile = useSessionProfile();
  const permitted = (module: string, write = false) => profile.system_administrator || profile.permissions.some((p) =>
    p.module === module && p.can_view && (!write || (module === "settings" ? p.can_manage : p.can_add && p.can_edit)));
  const canView = permitted("imports") && permitted("settings");
  const canWrite = permitted("imports", true) && permitted("settings", true);
  const [review, setReview] = useState<CompanyContactsReview | null>(null);
  const [batches, setBatches] = useState<CompanyContactBatch[]>([]);
  const [offset, setOffset] = useState(0);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!canView) return;
    let active = true;
    void api<{ batches: CompanyContactBatch[] }>(endpoint).then((value) => { if (active) setBatches(value.batches); })
      .catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : "Unable to load Company Contacts imports."); });
    return () => { active = false; };
  }, [canView]);
  const perform = async (operation: () => Promise<void>) => {
    setBusy(true); setError(null); setNotice(null);
    try { await operation(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Company Contacts operation failed."); }
    finally { setBusy(false); }
  };
  const history = async (next = offset) => {
    const result = await api<{ batches: CompanyContactBatch[] }>(`${endpoint}?offset=${next}`);
    setBatches(result.batches); setOffset(next);
  };
  const open = async (id: string) => {
    setReview(await api<CompanyContactsReview>(`${endpoint}?batch=${id}`)); setPage(0);
  };
  const resolve = (row: CompanyContactImportRow, action: CompanyContactAction, contact: CompanyContactReference | null, values: CompanyContactValues, confirmDuplicate: boolean) => {
    if (!review) return;
    void perform(async () => {
      setReview(await api<CompanyContactsReview>(endpoint, { method: "PATCH", body: JSON.stringify({
        operation: "resolve", batch_id: review.batch.id, revision: review.batch.revision, row_id: row.id, action,
        contact_id: contact?.id ?? null, contact_version: contact?.version ?? null, values, confirm_duplicate: confirmDuplicate,
      }) }));
      setNotice("Decision saved. Contacts change only when Import Resolved Records succeeds.");
      await history();
    });
  };
  if (!canView) return null;
  return <section aria-label="Company Contacts import" className={`${styles.workflow} rounded-2xl border border-slate-200 bg-white p-4 shadow-sm`}>
    <h2 className="text-lg font-semibold text-slate-900">Company Contacts</h2>
    <p className="mt-1 text-xs text-slate-600">Import Name, Cell and Email into the existing company address book (currently DOBCO CONTACTS). Upload stages rows only; every contact decision needs review.</p>
    <div className={`${styles.actions} mt-3`}>
      <button type="button" className={secondary} disabled={busy} onClick={() => void perform(async () => {
        const response = await adminFetch(`${endpoint}?template=1`);
        if (!response.ok) { const result = await response.json(); throw new Error(result.error ?? "Template download failed."); }
        const url = URL.createObjectURL(await response.blob());
        const link = document.createElement("a"); link.href = url; link.download = "Company Contacts Import Template.xlsx"; link.click();
        URL.revokeObjectURL(url);
      })}>Download Blank Template</button>
      {canWrite ? <>
        <input ref={fileInput} aria-label="Company Contacts workbook" type="file" accept=".xlsx" className={`${styles.fileInput} max-w-full`} disabled={busy} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        <button type="button" className={primary} disabled={busy || !file} onClick={() => void perform(async () => {
          if (!file) return;
          const form = new FormData(); form.set("file", file);
          const result = await api<CompanyContactsReview>(endpoint, { method: "POST", body: form });
          setReview(result); setPage(0); setFile(null); if (fileInput.current) fileInput.current.value = "";
          setNotice("Workbook staged, or its existing batch reopened if previously uploaded. No live contacts changed.");
          await history(0);
        })}>Import Company Contacts</button>
      </> : null}
      <button type="button" className={secondary} disabled={busy} onClick={() => void perform(async () => {
        if (review) await open(review.batch.id);
        await history();
      })}>View Current Import / Review Status</button>
      <button type="button" className={secondary} disabled={busy} onClick={() => void perform(() => history(0))}>View Import History</button>
    </div>
    {busy ? <p role="status" className="mt-2 text-xs">Working...</p> : null}
    {error ? <p role="alert" className="mt-2 text-sm text-red-700">{error} Reload the current review before retrying a stale operation.</p> : null}
    {notice ? <p role="status" className="mt-2 text-xs text-emerald-800">{notice}</p> : null}
    {batches.length || offset ? <details className="mt-3 text-xs" open={!review}>
      <summary className="cursor-pointer font-semibold">Import status and history</summary>
      <ul className="mt-2 space-y-2">{batches.map((batch) => <li key={batch.id} className="flex flex-wrap items-center gap-2">
        <button type="button" className={secondary} disabled={busy} onClick={() => void perform(() => open(batch.id))}>Open {batch.file_name}</button>
        <span>{batch.status} · {new Date(batch.created_at).toLocaleString()} · Uploaded by {batch.created_by}</span>
      </li>)}</ul>
      {!batches.length ? <p className="mt-2">No more imports on this history page.</p> : null}
      <div className={`${styles.actions} mt-2`}>
        <button type="button" className={secondary} disabled={busy || !offset} onClick={() => void perform(() => history(Math.max(0, offset - 20)))}>Previous imports</button>
        <span>Page {offset / 20 + 1}</span>
        <button type="button" className={secondary} disabled={busy || batches.length < 20} onClick={() => void perform(() => history(offset + 20))}>Next imports</button>
      </div>
    </details> : <p className="mt-2 text-xs">No Company Contacts imports on this history page.</p>}
    {review ? <div className="mt-4 space-y-3">
      <h3 className="break-words text-sm font-semibold">{review.batch.file_name} · {review.batch.status}</h3>
      <p className="break-all text-xs">Batch {review.batch.id} · Uploaded {new Date(review.batch.created_at).toLocaleString()} by {review.batch.created_by}</p>
      {review.batch.notices.map((message, index) => <p key={index} className="text-xs text-amber-900">{message}</p>)}
      <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs">{Object.entries(review.summary).map(([label, count]) => <div key={label}>
        <dt className="inline capitalize">{label}: </dt><dd className="inline font-semibold">{count}</dd>
      </div>)}</dl>
      <div className={styles.actions}>
        {canWrite ? <button type="button" className={primary} disabled={busy || !review.summary.ready} onClick={() => {
          if (!window.confirm(`Import ${review.summary.ready} resolved row(s)? Unresolved and skipped rows will not change contacts.`)) return;
          void perform(async () => {
            const result = await api<CompanyContactsReview>(endpoint, { method: "PATCH", body: JSON.stringify({
              operation: "apply", batch_id: review.batch.id, revision: review.batch.revision,
            }) });
            setReview(result);
            setNotice(`Actual batch results: ${result.summary.imported} imported/kept, ${result.summary.updated} updated, ${result.summary.skipped} skipped, ${result.summary.errors} errors, ${result.summary.unresolved} unresolved. Errors need review before retry.`);
            await history();
          });
        }}>Import Resolved Records</button> : null}
        <button type="button" className={secondary} disabled={busy || !page} onClick={() => setPage((p) => p - 1)}>Previous rows</button>
        <span className="text-xs">Review page {page + 1} of {Math.max(1, Math.ceil(review.rows.length / 20))}</span>
        <button type="button" className={secondary} disabled={busy || (page + 1) * 20 >= review.rows.length} onClick={() => setPage((p) => p + 1)}>Next rows</button>
      </div>
      {review.rows.slice(page * 20, page * 20 + 20).map((row) => <ReviewRow key={`${row.id}:${review.batch.revision}`} row={row}
        contacts={review.contacts} busy={busy} canWrite={canWrite} onResolve={resolve} />)}
    </div> : null}
  </section>;
}
