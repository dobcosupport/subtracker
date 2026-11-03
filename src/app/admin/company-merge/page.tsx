"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { adminFetch } from "@/lib/admin-client";
import type {
  CompanyMergeCandidate,
  CompanyMergeChoices,
  CompanyMergeComplianceChoices,
  CompanyMergePreview,
  CompanyMergeResult,
} from "@/types/company-merge";

type SearchSide = "primary" | "secondary";

type CompanyMergeRequest = Readonly<{
  primary: number;
  secondary: number;
  snapshot: string;
  choices: Readonly<CompanyMergeChoices>;
  compliance: Readonly<CompanyMergeComplianceChoices>;
  primary_contact: string | null;
  operation: string;
  confirmed: true;
}>;

type PendingMergeConfirmation = Readonly<{
  request: CompanyMergeRequest;
  primaryName: string;
  secondaryName: string;
  resultingCompanyName: string;
  resultingDbaName: string;
  fieldSources: ReadonlyArray<Readonly<{ field: string; source: "primary" | "secondary"; value: string }>>;
  complianceRecords: ReadonlyArray<Readonly<{ name: string; id: number; registrationNumber: string }>>;
  primaryContact: string;
}>;

function displayValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function fieldLabel(value: string): string {
  return value.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function fieldNote(field: string): string | null {
  if (field === "nj_pwc_number" || field === "nj_brc_number") {
    return "Fallback only when no current New Jersey compliance record is selected; the selected current record is authoritative.";
  }
  if (field === "ny_pwc_number" || field === "ny_brc_number") {
    return "The selected current New York compliance record will be authoritative after the merge.";
  }
  return null;
}

function CandidateSearch({
  side,
  selected,
  onSelect,
  excludedId,
  disabled,
  inputRef,
}: {
  side: SearchSide;
  selected: CompanyMergeCandidate | null;
  onSelect: (candidate: CompanyMergeCandidate | null) => void;
  excludedId: number | null;
  disabled: boolean;
  inputRef?: (input: HTMLInputElement | null) => void;
}) {
  const [term, setTerm] = useState("");
  const [results, setResults] = useState<CompanyMergeCandidate[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const search = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await adminFetch(`/api/admin/company-merge?search=${encodeURIComponent(term.trim())}`);
      const body = await response.json() as { candidates?: CompanyMergeCandidate[]; error?: string };
      if (!response.ok) throw new Error(body.error ?? "Unable to search companies.");
      setResults(body.candidates ?? []);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to search companies.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-slate-900">{side === "primary" ? "Primary company (survives)" : "Secondary company (merged)"}</h2>
        {selected ? <button type="button" disabled={disabled} onClick={() => { onSelect(null); setResults([]); }} className="text-xs font-medium text-slate-500 hover:text-slate-900 disabled:opacity-50">Clear</button> : null}
      </div>
      {selected ? (
        <div className="mt-3 rounded-lg bg-indigo-50 p-3">
          <p className="font-medium text-slate-900">{selected.company_name}</p>
          {selected.dba_name ? <p className="mt-1 text-xs text-slate-600">DBA: {selected.dba_name}</p> : null}
          <p className="mt-1 text-xs text-slate-600">ID {selected.id} · {[selected.city, selected.state].filter(Boolean).join(", ") || "Location not listed"}</p>
        </div>
      ) : (
        <>
          <form onSubmit={(event) => { event.preventDefault(); void search(); }} className="mt-3 flex gap-2">
            <label className="sr-only" htmlFor={`${side}-company-search`}>Search {side} company by name or ID</label>
            <input ref={inputRef} id={`${side}-company-search`} value={term} onChange={(event) => setTerm(event.target.value)} maxLength={80} disabled={disabled} placeholder="Company name or numeric ID" className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm" />
            <button type="submit" disabled={disabled || loading || term.trim().length < 1} className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">{loading ? "Searching…" : "Search"}</button>
          </form>
          {error ? <p role="alert" className="mt-2 text-sm text-red-700">{error}</p> : null}
          <ul className="mt-2 max-h-48 divide-y divide-slate-100 overflow-y-auto">
            {results.filter((candidate) => candidate.id !== excludedId).map((candidate) => (
              <li key={candidate.id}>
                <button type="button" disabled={disabled} onClick={() => { onSelect(candidate); setResults([]); }} className="w-full rounded-md px-2 py-2 text-left hover:bg-slate-50 disabled:opacity-50">
                  <span className="block text-sm font-medium text-slate-800">{candidate.company_name}</span>
                  {candidate.dba_name ? <span className="block text-xs text-slate-600">DBA: {candidate.dba_name}</span> : null}
                  <span className="block text-xs text-slate-500">ID {candidate.id} · {[candidate.city, candidate.state].filter(Boolean).join(", ") || "Location not listed"} · {candidate.active ? "Active" : "Inactive"}</span>
                </button>
              </li>
            ))}
            {results.length > 0 && results.every((candidate) => candidate.id === excludedId) ? <li className="p-3 text-xs text-slate-500">No distinct matches.</li> : null}
          </ul>
        </>
      )}
    </section>
  );
}

export default function CompanyMergeAdministrationPage() {
  const [primary, setPrimary] = useState<CompanyMergeCandidate | null>(null);
  const [secondary, setSecondary] = useState<CompanyMergeCandidate | null>(null);
  const [preview, setPreview] = useState<CompanyMergePreview | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [choices, setChoices] = useState<CompanyMergeChoices>({});
  const [complianceChoices, setComplianceChoices] = useState<CompanyMergeComplianceChoices>({});
  const [primaryContact, setPrimaryContact] = useState("");
  const [irreversibleAcknowledged, setIrreversibleAcknowledged] = useState(false);
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  const [pendingConfirmation, setPendingConfirmation] = useState<PendingMergeConfirmation | null>(null);
  const [typedSecondaryId, setTypedSecondaryId] = useState("");
  const [executing, setExecuting] = useState(false);
  const [submissionStarted, setSubmissionStarted] = useState(false);
  const [result, setResult] = useState<CompanyMergeResult | null>(null);
  const submissionLock = useRef(false);
  const primarySearchInput = useRef<HTMLInputElement | null>(null);
  const focusPrimaryAfterReset = useRef(false);

  useEffect(() => {
    if (!result && focusPrimaryAfterReset.current) {
      focusPrimaryAfterReset.current = false;
      primarySearchInput.current?.focus();
    }
  }, [result]);

  const selectedFields = useMemo(() => preview?.fields ?? [], [preview]);
  const missingCompliance = useMemo(() => (preview?.compliance ?? []).filter((entry) =>
    !entry.records.some((record) => complianceChoices[String(entry.compliance_type_id)] === record.id)
  ), [preview, complianceChoices]);
  const activeContacts = useMemo(() => preview?.contacts.filter((contact) => contact.is_active) ?? [], [preview]);
  const needsPrimaryContact = activeContacts.length > 0;
  const canExecute = Boolean(preview && !preview.blockers.length && !missingCompliance.length
    && (!needsPrimaryContact || activeContacts.some((contact) => contact.id === primaryContact)));

  const invalidatePendingConfirmation = () => {
    setPendingConfirmation(null);
    setTypedSecondaryId("");
    setConfirmationOpen(false);
  };

  const openFinalConfirmation = () => {
    if (!preview || !primary || !secondary || primary.id !== preview.primary.id || secondary.id !== preview.secondary.id
      || !canExecute || !irreversibleAcknowledged || submissionStarted) return;
    invalidatePendingConfirmation();
    const operation = crypto.randomUUID();
    const request: CompanyMergeRequest = Object.freeze({
      primary: preview.primary.id,
      secondary: preview.secondary.id,
      snapshot: preview.snapshot,
      choices: Object.freeze({ ...choices }),
      compliance: Object.freeze({ ...complianceChoices }),
      primary_contact: primaryContact || null,
      operation,
      confirmed: true,
    });
    const fieldSources: Array<Readonly<{ field: string; source: "primary" | "secondary"; value: string }>> = [];
    for (const field of Object.keys(request.choices)) {
      const source = request.choices[field];
      if (!source) {
        setError(`Missing source for ${fieldLabel(field)}.`);
        return;
      }
      fieldSources.push(Object.freeze({
        field,
        source,
        value: displayValue((source === "primary" ? preview.primary : preview.secondary)[field]),
      }));
    }
    const selectedComplianceRecords = [];
    for (const entry of preview.compliance) {
      const selectedId = request.compliance[String(entry.compliance_type_id)];
      const record = entry.records.find((candidate) => candidate.id === selectedId);
      if (!record) {
        setError(`Selected ${entry.compliance_name} record is no longer available.`);
        return;
      }
      selectedComplianceRecords.push(Object.freeze({
        name: entry.compliance_name,
        id: record.id,
        registrationNumber: record.registration_number || "No registration",
      }));
    }
    const frozenFieldSources = Object.freeze(fieldSources);
    const complianceRecords = Object.freeze(selectedComplianceRecords);
    const contact = request.primary_contact
      ? preview.contacts.find((candidate) => candidate.id === request.primary_contact && candidate.is_active)
      : null;
    const pending: PendingMergeConfirmation = Object.freeze({
      request,
      primaryName: preview.primary.company_name,
      secondaryName: preview.secondary.company_name,
      resultingCompanyName: displayValue(
        (request.choices.company_name === "secondary" ? preview.secondary : preview.primary).company_name,
      ),
      resultingDbaName: displayValue(
        (request.choices.dba_name === "secondary" ? preview.secondary : preview.primary).dba_name,
      ),
      fieldSources: frozenFieldSources,
      complianceRecords,
      primaryContact: contact ? `${contact.contact_name} (ID ${contact.id})` : "No active primary contact selected",
    });
    setPendingConfirmation(pending);
    setTypedSecondaryId("");
    setConfirmationOpen(true);
  };

  const loadPreview = async () => {
    if (!primary || !secondary || primary.id === secondary.id) return;
    invalidatePendingConfirmation();
    setPreviewBusy(true);
    setError(null);
    setPreview(null);
    setResult(null);
    setChoices({});
    setComplianceChoices({});
    setPrimaryContact("");
    setIrreversibleAcknowledged(false);
    setSubmissionStarted(false);
    try {
      const response = await adminFetch(`/api/admin/company-merge?primary=${primary.id}&secondary=${secondary.id}`);
      const body = await response.json() as CompanyMergePreview & { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Unable to preview this company merge.");
      setPreview(body);
      setChoices(Object.fromEntries(body.fields.filter((field) => field !== "id").map((field) => [field, "primary"])));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to preview this company merge.");
    } finally {
      setPreviewBusy(false);
    }
  };

  const executeMerge = async () => {
    const pending = pendingConfirmation;
    if (!pending || typedSecondaryId !== String(pending.request.secondary) || submissionLock.current) return;
    submissionLock.current = true;
    setExecuting(true);
    setSubmissionStarted(true);
    setError(null);
    try {
      const response = await adminFetch("/api/admin/company-merge", {
        method: "POST",
        body: JSON.stringify(pending.request),
      });
      const body = await response.json() as CompanyMergeResult & { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Company merge failed.");
      setResult(body);
      setConfirmationOpen(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Company merge failed. Retry with the same operation ID.");
    } finally {
      submissionLock.current = false;
      setExecuting(false);
    }
  };

  const startAnotherMerge = () => {
    invalidatePendingConfirmation();
    focusPrimaryAfterReset.current = true;
    setPrimary(null);
    setSecondary(null);
    setPreview(null);
    setPreviewBusy(false);
    setError(null);
    setChoices({});
    setComplianceChoices({});
    setPrimaryContact("");
    setIrreversibleAcknowledged(false);
    setConfirmationOpen(false);
    setExecuting(false);
    setSubmissionStarted(false);
    submissionLock.current = false;
    setResult(null);
  };

  if (result) {
    return (
      <main className="min-h-screen bg-[#f5f7fb] p-4 text-slate-800 sm:p-6 lg:p-8">
        <div className="mx-auto max-w-3xl space-y-5">
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-5">
            <h1 className="text-2xl font-semibold text-emerald-950">{result.already_processed ? "Merge already completed" : "Company merge completed"}</h1>
            <p className="mt-2 text-sm text-emerald-900">The surviving company is ID {result.successor_id}. Merge receipt: {result.merge_id}.</p>
            <Link href={`/contractors/${result.successor_id}`} className="mt-4 inline-flex rounded-lg bg-emerald-800 px-4 py-2.5 text-sm font-semibold text-white hover:bg-emerald-900">Open Company Card</Link>
          </div>
          <button type="button" onClick={startAnotherMerge} className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700">Start another merge</button>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-[#f5f7fb] p-4 text-slate-800 sm:p-6 lg:p-8">
      <div className="mx-auto max-w-6xl space-y-5">
        <header>
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-400">Administration</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-900">Company Merge</h1>
          <p className="mt-2 max-w-3xl text-sm text-slate-600">Review two company records, choose how their data is combined, and confirm the irreversible operation. No records change until you submit the final confirmation.</p>
        </header>

        <div className="grid gap-4 md:grid-cols-2">
          <CandidateSearch side="primary" selected={primary} excludedId={secondary?.id ?? null} disabled={submissionStarted} inputRef={(input) => { primarySearchInput.current = input; }} onSelect={(candidate) => { invalidatePendingConfirmation(); setPrimary(candidate); setPreview(null); setResult(null); setSubmissionStarted(false); }} />
          <CandidateSearch side="secondary" selected={secondary} excludedId={primary?.id ?? null} disabled={submissionStarted} onSelect={(candidate) => { invalidatePendingConfirmation(); setSecondary(candidate); setPreview(null); setResult(null); setSubmissionStarted(false); }} />
        </div>
        <button type="button" onClick={() => void loadPreview()} disabled={!primary || !secondary || primary.id === secondary.id || previewBusy || submissionStarted} className="rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50">{previewBusy ? "Loading preview…" : "Load merge preview"}</button>

        {error ? <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</p> : null}

        {preview ? (
          <section aria-label="Company merge preview" className="space-y-4">
            {preview.blockers.length ? <div role="alert" aria-label="Blocking merge issues" className="rounded-xl border border-red-200 bg-red-50 p-4">
              <h2 className="font-semibold text-red-900">Merge blocked</h2>
              <div className="mt-3 space-y-3">
                {preview.blockers.map((blocker, index) => {
                  const blockerDetails = preview.blockerDetails?.filter((detail) => detail.blocker === blocker) ?? [];
                  return <section key={`${blocker}-${index}`} className="rounded-lg border border-red-200 bg-white p-3 text-sm text-red-950">
                    {blockerDetails.length ? blockerDetails.map((detail) => (
                      <article key={`${detail.source}:${detail.record_id}`} className="border-b border-red-100 py-2 last:border-0 last:pb-0 first:pt-0">
                        <h3 className="font-semibold">{detail.company_name ? `${detail.company_name} (#${detail.company_id})` : "Affected company"}</h3>
                        <p className="mt-1 font-semibold">{detail.source === "NJ PWC" ? `NJ PWC Sync Exception #${detail.record_id}` : `${detail.source} ${detail.record_type}${detail.record_id === null ? "" : ` · ID: ${detail.record_id}`}`}</p>
                        {detail.nj_pwc ? (
                          <div className="mt-2 space-y-2">
                            <div className="flex flex-wrap gap-2 text-sm font-bold">
                              {detail.nj_pwc.search_request_id !== null ? <span className="rounded bg-indigo-100 px-2 py-1 text-indigo-950">Search Request #{detail.nj_pwc.search_request_id}</span> : null}
                              {detail.nj_pwc.sync_run_id !== null ? <span className="rounded bg-indigo-100 px-2 py-1 text-indigo-950">Sync Run #{detail.nj_pwc.sync_run_id}</span> : null}
                            </div>
                            {detail.nj_pwc.searched_company_name ? <p>Search: {detail.nj_pwc.searched_company_name}</p> : null}
                            {detail.nj_pwc.searched_city || detail.nj_pwc.searched_state || detail.nj_pwc.searched_zip_code ? (
                              <p>{[detail.nj_pwc.searched_city, detail.nj_pwc.searched_state].filter(Boolean).join(", ")}{detail.nj_pwc.searched_zip_code ? ` ${detail.nj_pwc.searched_zip_code}` : ""}</p>
                            ) : null}
                            {detail.nj_pwc.candidate_count !== null ? <p>Candidates returned: {detail.nj_pwc.candidate_count}</p> : null}
                            <p>Selected Match: {detail.nj_pwc.selected_match ?? "None"}</p>
                          </div>
                        ) : null}
                        {detail.status ? <p>Status: {detail.status}</p> : null}
                        {detail.reason ? <p>Reason: {detail.reason}</p> : null}
                        {detail.context ? <p className="mt-1 text-slate-700">{detail.context}</p> : null}
                        {detail.resolution_actions?.length ? (
                          <div className="mt-3">
                            <p className="font-semibold">Resolution options (use the existing Compliance Sync workflow; no action is performed here):</p>
                            <ul className="mt-1 space-y-1">
                              {detail.resolution_actions.map((action) => (
                                <li key={action.label}>
                                  <Link className="font-medium text-indigo-700 underline" href={action.href}>{action.label}</Link>
                                  <span className="text-slate-700"> — {action.guidance}</span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        ) : <p className="mt-1">Resolution: <Link className="font-medium text-indigo-700 underline" href={detail.resolution_path}>{detail.resolution_label}</Link></p>}
                      </article>
                    )) : <p>{blocker}</p>}
                  </section>;
                })}
              </div>
            </div> : null}

            <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">
              <strong>Information — External systems:</strong> Review MyCOI and Procore after this merge and explicitly rematch their records. This operation does not guarantee that either external system is updated.
            </div>

            <section className="rounded-xl border border-slate-200 bg-white p-4">
              <h2 className="font-semibold text-slate-900">Company details</h2>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                {[["Primary", preview.primary], ["Secondary", preview.secondary]].map(([label, company]) => (
                  <dl key={String(label)} className="rounded-lg bg-slate-50 p-3">
                    {Object.entries(company as Record<string, unknown>).map(([field, value]) => <div key={field} className="flex justify-between gap-4 border-b border-slate-200 py-1.5 last:border-0"><dt className="text-xs font-medium text-slate-500">{fieldLabel(field)}</dt><dd className="max-w-[65%] break-words text-right text-xs text-slate-800">{displayValue(value)}</dd></div>)}
                  </dl>
                ))}
              </div>
            </section>

            <section className="rounded-xl border border-slate-200 bg-white p-4">
              <h2 className="font-semibold text-slate-900">Scalar field choices</h2>
              <p className="mt-1 text-xs text-slate-500">Primary is the default for each field. Choose the source for every listed field.</p>
              <div className="mt-3 divide-y divide-slate-100">
                {selectedFields.map((field) => <fieldset key={field} className="grid gap-2 py-3 sm:grid-cols-[minmax(120px,1fr)_1fr_1fr] sm:items-center">
                  <legend className="text-sm font-medium text-slate-800">{fieldLabel(field)}</legend>
                  {(["primary", "secondary"] as const).map((choice) => <label key={choice} className="flex items-start gap-2 text-xs text-slate-700">
                    <input type="radio" name={`field-${field}`} checked={choices[field] === choice} disabled={submissionStarted} onChange={() => { invalidatePendingConfirmation(); setChoices((current) => ({ ...current, [field]: choice })); }} className="mt-0.5 accent-indigo-600 disabled:opacity-50" />
                    <span><span className="font-medium">{choice === "primary" ? "Primary" : "Secondary"}{field === "nj_pwc_number" || field === "nj_brc_number" ? " fallback" : ""}</span><span className="block break-words text-slate-500">{displayValue((choice === "primary" ? preview.primary : preview.secondary)[field])}</span></span>
                  </label>)}
                  {fieldNote(field) ? <p className="text-xs text-amber-800 sm:col-start-2 sm:col-span-2">{fieldNote(field)}</p> : null}
                </fieldset>)}
              </div>
            </section>

            <section className="rounded-xl border border-slate-200 bg-white p-4">
              <h2 className="font-semibold text-slate-900">Compliance record selection</h2>
              <p className="mt-1 text-xs text-slate-500">Select one existing record for every compliance type. Nothing is preselected; record history is retained.</p>
              <div className="mt-3 grid gap-3 md:grid-cols-2">
                {preview.compliance.map((entry) => <label key={entry.compliance_type_id} className="block rounded-lg border border-slate-200 p-3 text-sm font-medium text-slate-800">{entry.compliance_name}
                  <select aria-label={entry.compliance_name} value={complianceChoices[String(entry.compliance_type_id)] ?? ""} disabled={submissionStarted} onChange={(event) => { invalidatePendingConfirmation(); setComplianceChoices((current) => ({ ...current, [String(entry.compliance_type_id)]: Number(event.target.value) })); }} className="mt-2 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm disabled:bg-slate-100">
                    <option value="">Choose a record…</option>
                    {entry.records.map((record) => <option key={record.id} value={record.id}>ID {record.id} · {record.registration_number || "No registration"} · {record.registry_status || "Status not listed"} · Expires {record.expiration_date || "—"}</option>)}
                  </select>
                </label>)}
                {!preview.compliance.length ? <p className="text-sm text-slate-500">No compliance records require a choice.</p> : null}
              </div>
            </section>

            <section className="rounded-xl border border-slate-200 bg-white p-4">
              <h2 className="font-semibold text-slate-900">Related records and contacts</h2>
              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[380px] text-left text-sm">
                  <thead><tr className="border-b border-slate-200 text-xs uppercase text-slate-500"><th className="py-2 pr-3">Related table</th><th className="px-3 py-2">Primary</th><th className="px-3 py-2">Secondary</th></tr></thead>
                  <tbody>{Object.entries(preview.counts).map(([table, count]) => <tr key={table} className="border-b border-slate-100"><th className="py-2 pr-3 font-medium text-slate-700">{fieldLabel(table)}</th><td className="px-3 py-2">{count.primary}</td><td className="px-3 py-2">{count.secondary}</td></tr>)}</tbody>
                </table>
              </div>
              <p className="mt-3 text-sm text-slate-700">Projects: {preview.projects.primary} primary · {preview.projects.secondary} secondary · {preview.projects.shared} shared · {preview.projects.union} after merge</p>
              {activeContacts.length ? <label className="mt-4 block text-sm font-medium text-slate-800">Primary contact after merge <span className="text-red-700">(required)</span>
                <select value={primaryContact} disabled={submissionStarted} onChange={(event) => { invalidatePendingConfirmation(); setPrimaryContact(event.target.value); }} className="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 disabled:bg-slate-100">
                  <option value="">Choose one existing contact…</option>
                  {activeContacts.map((contact) => <option key={contact.id} value={contact.id}>{contact.contact_name} · Company {contact.contractor_id}{contact.is_primary_contact ? " · currently primary" : ""}</option>)}
                </select>
              </label> : <p className="mt-3 text-xs text-slate-500">No active contact records are available; no primary contact is required.</p>}
            </section>

            <section className="rounded-xl border border-slate-300 bg-white p-4">
              <label className="flex items-start gap-3 text-sm text-slate-800">
                <input type="checkbox" checked={irreversibleAcknowledged} disabled={submissionStarted} onChange={(event) => { invalidatePendingConfirmation(); setIrreversibleAcknowledged(event.target.checked); }} className="mt-0.5 h-4 w-4 accent-red-700 disabled:opacity-50" />
                <span>I understand this merge is irreversible and have reviewed the selected companies and merge choices.</span>
              </label>
              <button type="button" onClick={openFinalConfirmation} disabled={!canExecute || !irreversibleAcknowledged || submissionStarted} className="mt-4 rounded-lg bg-red-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-red-800 disabled:cursor-not-allowed disabled:opacity-50">Continue to final confirmation</button>
              {!preview.blockers.length && missingCompliance.length ? <p className="mt-2 text-xs text-amber-800">Choose a record for each compliance type before continuing.</p> : null}
            </section>
          </section>
        ) : null}
      </div>

      {confirmationOpen && pendingConfirmation ? <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4">
        <section role="dialog" aria-modal="true" aria-labelledby="merge-confirm-title" className="max-h-[90vh] w-full max-w-lg space-y-4 overflow-y-auto rounded-xl bg-white p-6 shadow-2xl">
          <h2 id="merge-confirm-title" className="text-xl font-semibold text-slate-900">Final confirmation: irreversible company merge</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <section aria-label="Primary Company" className="rounded-lg border border-slate-200 bg-slate-50 p-3">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Primary Company</h3>
              <p className="mt-1 font-semibold text-slate-900">{pendingConfirmation.primaryName}</p>
              <p className="text-sm text-slate-700">Contractor ID: {pendingConfirmation.request.primary}</p>
            </section>
            <section aria-label="Secondary Company" className="rounded-lg border border-slate-200 bg-slate-50 p-3">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Secondary Company</h3>
              <p className="mt-1 font-semibold text-slate-900">{pendingConfirmation.secondaryName}</p>
              <p className="text-sm text-slate-700">Contractor ID: {pendingConfirmation.request.secondary}</p>
            </section>
          </div>
          <section aria-label="Resulting Company" className="rounded-lg border border-indigo-200 bg-indigo-50 p-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-indigo-700">Resulting Company</h3>
            <p className="mt-1 text-lg font-semibold text-indigo-950">{pendingConfirmation.resultingCompanyName}</p>
            <p className="mt-1 text-sm text-indigo-900">DBA: {pendingConfirmation.resultingDbaName}</p>
          </section>
          <section aria-label="Merge Operation" className="rounded-lg border border-amber-200 bg-amber-50 p-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-amber-800">Merge Operation</h3>
            <p className="mt-1 break-all font-mono text-sm text-amber-950">Operation ID: {pendingConfirmation.request.operation}</p>
          </section>
          <section aria-label="Selected merge inputs" className="space-y-3 rounded-lg border border-slate-200 p-3 text-sm">
            <div>
              <h3 className="font-semibold text-slate-900">Field sources</h3>
              <ul className="mt-1 space-y-1">
                {pendingConfirmation.fieldSources.map(({ field, source, value }) => (
                  <li key={field}>{fieldLabel(field)}: {source === "primary" ? "Primary" : "Secondary"} Company (ID {source === "primary" ? pendingConfirmation.request.primary : pendingConfirmation.request.secondary}) — {value}</li>
                ))}
              </ul>
            </div>
            <div>
              <h3 className="font-semibold text-slate-900">Compliance records</h3>
              {pendingConfirmation.complianceRecords.length ? <ul className="mt-1 space-y-1">
                {pendingConfirmation.complianceRecords.map((record) => <li key={record.id}>{record.name}: ID {record.id} · {record.registrationNumber}</li>)}
              </ul> : <p className="mt-1">No compliance records selected.</p>}
            </div>
            <div><h3 className="font-semibold text-slate-900">Primary contact</h3><p className="mt-1">{pendingConfirmation.primaryContact}</p></div>
          </section>
          <p className="text-sm text-red-800">This final action cannot be undone. Verify the company identities and choices before proceeding.</p>
          <label className="block text-sm font-semibold text-slate-900" htmlFor="confirm-secondary-id">
            Type {pendingConfirmation.request.secondary} to confirm merging contractor {pendingConfirmation.request.secondary}
            <input id="confirm-secondary-id" value={typedSecondaryId} onChange={(event) => setTypedSecondaryId(event.target.value)} disabled={executing || submissionStarted} inputMode="numeric" autoComplete="off" className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-base disabled:bg-slate-100" />
          </label>
          {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : null}
          <div className="flex flex-col-reverse justify-end gap-2 sm:flex-row">
            <button type="button" onClick={invalidatePendingConfirmation} disabled={executing || submissionStarted} className="rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-medium text-slate-700 disabled:opacity-50">Go back</button>
            <button type="button" onClick={() => void executeMerge()} disabled={executing || typedSecondaryId !== String(pendingConfirmation.request.secondary)} className="rounded-lg bg-red-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-red-800 disabled:opacity-50">{executing ? "Merging…" : submissionStarted ? "Retry same operation" : "Merge"}</button>
            {submissionStarted && !executing ? <button type="button" onClick={() => { setSubmissionStarted(false); void loadPreview(); }} className="rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-medium text-slate-700">Discard retry and refresh preview</button> : null}
          </div>
        </section>
      </div> : null}
    </main>
  );
}
