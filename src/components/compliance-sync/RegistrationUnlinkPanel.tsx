"use client";

import { useEffect, useRef, useState } from "react";
import { useSessionProfile } from "@/components/SessionContext";
import { adminFetch } from "@/lib/admin-client";
import type { UnlinkCompliance, UnlinkContractor, UnlinkRecord, UnlinkSelection } from "@/types/registration-unlink";

const endpoint = "/api/admin/compliance-sync/registration-unlink";
const button = "rounded-lg border border-slate-300 bg-slate-800 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50";
const input = "rounded-lg border border-slate-300 bg-white p-2 text-sm";
const date = (value: string | null) => value ? new Date(`${value.slice(0, 10)}T12:00:00`).toLocaleDateString("en-US") : "Not supplied";

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await adminFetch(path, init);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "Registration operation failed.");
  return result as T;
}

export default function RegistrationUnlinkPanel({ compliance }: { compliance: UnlinkCompliance }) {
  const controlId = compliance === "NJ PWC" ? "unlink-nj-pwc" : "unlink-nj-brc";
  const profile = useSessionProfile();
  const allowed = (module: string) => profile.system_administrator || profile.permissions.some((entry) =>
    entry.module === module && entry.can_view && entry.can_manage);
  const canManage = allowed("compliance_sync");
  const canSearch = allowed("contractors");
  const [contractors, setContractors] = useState<UnlinkContractor[]>([]);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [selection, setSelection] = useState<UnlinkSelection | null>(null);
  const [confirm, setConfirm] = useState<UnlinkRecord | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const generation = useRef(0);
  const dialog = useRef<HTMLDialogElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!canManage) return;
    const controller = new AbortController();
    void api<{ contractors: UnlinkContractor[] }>(`${endpoint}?compliance=${encodeURIComponent(compliance)}`, { signal: controller.signal })
      .then((result) => { if (!controller.signal.aborted) setContractors(result.contractors); })
      .catch((failure: unknown) => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Unable to load contractors."); });
    return () => { controller.abort(); };
  }, [canManage, compliance]);

  const select = async (id: number) => {
    const current = ++generation.current;
    setOpen(false); setSelection(null); setSuccess(null); setError(null); setBusy(true);
    try {
      const result = await api<UnlinkSelection>(`${endpoint}?compliance=${encodeURIComponent(compliance)}&contractor_id=${id}`);
      if (current === generation.current) { setSelection(result); setQuery(result.contractor.company_name); }
    } catch (failure) {
      if (current === generation.current) setError(failure instanceof Error ? failure.message : "Unable to load registrations.");
    } finally { if (current === generation.current) setBusy(false); }
  };

  const close = () => { if (!busy) { dialog.current?.close(); setConfirm(null); setReason(""); } };
  const unlink = async () => {
    if (!selection || !confirm || !reason.trim() || busy) return;
    setBusy(true); setError(null);
    const company = selection.contractor;
    try {
      await api(endpoint, { method: "POST", body: JSON.stringify({
        contractor_id: company.id, record_id: confirm.id, compliance,
        expected_updated_at: confirm.updated_at,
        expected_identifier: compliance === "NJ PWC" ? company.nj_pwc_number : company.nj_brc_number,
        reason, confirmed: true,
      }) });
      dialog.current?.close(); setConfirm(null); setReason("");
      setSelection(null);
      setSuccess("Record unlinked and archived. Rescan this contractor to locate and review the correct registration.");
      const refreshed = await api<UnlinkSelection>(`${endpoint}?compliance=${encodeURIComponent(compliance)}&contractor_id=${company.id}`);
      setSelection(refreshed);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Unlink outcome could not be confirmed. Reload the linked records before retrying.");
    } finally { setBusy(false); }
  };
  const rescan = async () => {
    if (!selection || busy || !window.confirm(`Queue an existing ${compliance} search for ${selection.contractor.company_name}? This deliberately requests a worker lookup; results must still be reviewed.`)) return;
    setBusy(true); setError(null);
    const company = selection.contractor;
    try {
      await api(compliance === "NJ PWC" ? "/api/contractors/nj-pwc-search" : "/api/contractors/nj-brc-search", {
        method: "POST", body: JSON.stringify(compliance === "NJ PWC"
          ? { company_name: company.company_name, city: company.city, state: company.state, zip_code: company.zip_code }
          : { contractor_id: company.id }),
      });
      setSuccess(`${compliance} search queued using the existing search workflow. Review the results before importing or approving a registration.`);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Unable to queue search."); }
    finally { setBusy(false); }
  };

  if (!canManage) return null;
  const matches = contractors.filter((company) => company.company_name.toLowerCase().includes(query.toLowerCase()) || String(company.id) === query);
  const identifier = selection ? compliance === "NJ PWC" ? selection.contractor.nj_pwc_number : selection.contractor.nj_brc_number : null;
  return <section aria-label={`${compliance} administrative unlink`} className="space-y-3 rounded-xl border border-slate-200 bg-white p-4">
    <h2 className="text-lg font-semibold">{compliance} Administrative Correction</h2>
    <p className="text-sm text-slate-600">Unlink an incorrect registration relationship without deleting history. Known unlinked identities cannot automatically reattach to this contractor.</p>
    <div className="relative max-w-xl">
      <label htmlFor={controlId} className="block text-sm font-semibold">Search all contractors</label>
      <input ref={searchInput} id={controlId} role="combobox" aria-expanded={open} aria-controls={`${controlId}-options`}
        aria-autocomplete="list" autoComplete="off" value={query} disabled={busy}
        onFocus={() => setOpen(true)} onChange={(event) => { setQuery(event.target.value); setSelection(null); setSuccess(null); setOpen(true); }}
        onKeyDown={(event) => {
          if (event.key === "Escape") setOpen(false);
          if (event.key === "ArrowDown") { event.preventDefault(); setOpen(true); }
          if (event.key === "Enter" && open && matches.length === 1) { event.preventDefault(); void select(matches[0].id); }
        }} className={`${input} w-full`} />
      {open ? <div id={`${controlId}-options`} role="listbox" aria-label="Contractors"
        className="absolute z-10 max-h-56 w-full overflow-y-auto rounded-lg border border-slate-300 bg-white shadow-lg">
        {matches.map((company) => <button role="option" aria-selected={selection?.contractor.id === company.id} key={company.id} type="button"
          onClick={() => void select(company.id)} className="block w-full px-3 py-2 text-left text-sm hover:bg-slate-100">
          {company.company_name} (#{company.id}){company.active ? "" : " — Inactive"}
        </button>)}
        {!matches.length ? <p className="p-3 text-sm">No contractors match.</p> : null}
      </div> : null}
    </div>
    {busy ? <p role="status">Working…</p> : null}
    {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : null}
    {success ? <div role="status" className="space-y-2 text-sm text-emerald-800"><p>{success}</p>
      {selection ? <><p>Rescan {compliance}. No scan starts automatically.</p>
        <button className={button} type="button" disabled={busy || !canSearch || !selection.contractor.active} onClick={() => void rescan()}>Queue {compliance} Rescan</button>
        {!canSearch ? <p>Contractors Manage permission is required by the existing search workflow.</p> : null}</> : null}
    </div> : null}
    {selection ? <div className="space-y-3">
      <p className="text-sm"><strong>{selection.contractor.company_name}</strong> — Synced {compliance} #: {identifier || "Blank / Missing"}</p>
      {compliance === "NJ BRC" ? <p className="text-sm">NJ BRC is non-expiring. Contractor Name Control: {selection.contractor.brc_name_control || "Not supplied"}</p> : null}
      {!selection.records.length ? <p>No linked registration records.</p> : null}
      {selection.records.map((record) => <article key={record.id} aria-label={`Registration record ${record.id}`} className="space-y-2 rounded-lg border border-slate-200 p-3 text-sm">
        <p className="font-semibold">Record #{record.id}: {record.registration_number || "No registration number"}</p>
        <p>Record business/company: {record.matched_company_name || "Not retained in source evidence"}</p>
        <p>Synced registration: {record.synced_registration_number || "Not supplied"} | Certificate: {record.certificate_number || "Not supplied"}</p>
        {compliance === "NJ BRC" ? <p>Business Entity ID: {record.matched_business_entity_id || record.registration_number || "Not supplied"} | Name Control: {record.searched_name_control || "Not supplied"}</p> : null}
        <p>Active: {record.active ? "Yes" : "No"} | Current: {record.is_current ? "Yes" : "No"} | Supplies Contractor Card identifier: <strong>{record.supplies_identifier ? "Yes" : "No"}</strong></p>
        <p>Effective: {date(record.effective_date)} | {compliance === "NJ BRC" ? "Non-expiring" : `Expiration: ${date(record.expiration_date)}`}</p>
        <p>Verified: {date(record.verified_date)} | Source: {record.verification_source || "Not supplied"}</p>
        {record.unlinked_at ? <p>Previously unlinked: {new Date(record.unlinked_at).toLocaleString()} — retained for history.</p>
          : <button type="button" className={button} disabled={busy} onClick={() => {
            setConfirm(record); setReason(""); setError(null); dialog.current?.showModal();
          }}>Remove / Unlink Record</button>}
      </article>)}
      <button type="button" className={button} disabled={busy} onClick={() => void select(selection.contractor.id)}>Reload Linked Records</button>
    </div> : null}
    <dialog ref={dialog} aria-labelledby={`${controlId}-confirm`} onCancel={(event) => { event.preventDefault(); close(); }}
      onClose={() => searchInput.current?.focus()} className="max-w-lg space-y-4 rounded-xl border border-slate-300 p-6 backdrop:bg-slate-900/40">
      <h3 id={`${controlId}-confirm`} className="text-lg font-semibold">Confirm {compliance} Unlink</h3>
      {confirm && selection ? <>
        <p>Contractor: {selection.contractor.company_name}</p>
        <p>{compliance} registration: {confirm.registration_number || "Blank"} (record #{confirm.id})</p>
        <p>Record business/company: {confirm.matched_company_name || "Not retained in source evidence"}</p>
        <p>The contractor&apos;s synced {compliance} # may be cleared. History is preserved. Rescan {compliance} after removal to locate and review the correct registration.</p>
        <label className="block">Reason for Removal
          <textarea required maxLength={2000} value={reason} disabled={busy} onChange={(event) => setReason(event.target.value)} className={`${input} mt-1 block w-full`} />
        </label>
        {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : null}
        <div className="flex gap-2">
          <button type="button" className={button} disabled={busy} onClick={close}>Cancel</button>
          <button type="button" className={button} disabled={busy || !reason.trim()} onClick={() => void unlink()}>Confirm Unlink</button>
        </div>
      </> : null}
    </dialog>
  </section>;
}
