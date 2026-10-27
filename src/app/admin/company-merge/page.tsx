"use client";

import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import { adminFetch } from "@/lib/admin-client";
import type {
  CompanyMergeCandidate,
  CompanyMergeChoices,
  CompanyMergeComplianceChoices,
  CompanyMergePreview,
  CompanyMergeResult,
} from "@/types/company-merge";

type SearchSide = "primary" | "secondary";

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
}: {
  side: SearchSide;
  selected: CompanyMergeCandidate | null;
  onSelect: (candidate: CompanyMergeCandidate | null) => void;
  excludedId: number | null;
  disabled: boolean;
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
          <p className="mt-1 text-xs text-slate-600">ID {selected.id} · {[selected.city, selected.state].filter(Boolean).join(", ") || "Location not listed"}</p>
        </div>
      ) : (
        <>
          <form onSubmit={(event) => { event.preventDefault(); void search(); }} className="mt-3 flex gap-2">
            <label className="sr-only" htmlFor={`${side}-company-search`}>Search {side} company by name or ID</label>
            <input id={`${side}-company-search`} value={term} onChange={(event) => setTerm(event.target.value)} maxLength={80} disabled={disabled} placeholder="Company name or numeric ID" className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm" />
            <button type="submit" disabled={disabled || loading || term.trim().length < 1} className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">{loading ? "Searching…" : "Search"}</button>
          </form>
          {error ? <p role="alert" className="mt-2 text-sm text-red-700">{error}</p> : null}
          <ul className="mt-2 max-h-48 divide-y divide-slate-100 overflow-y-auto">
            {results.filter((candidate) => candidate.id !== excludedId).map((candidate) => (
              <li key={candidate.id}>
                <button type="button" disabled={disabled} onClick={() => { onSelect(candidate); setResults([]); }} className="w-full rounded-md px-2 py-2 text-left hover:bg-slate-50 disabled:opacity-50">
                  <span className="block text-sm font-medium text-slate-800">{candidate.company_name}</span>
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
  const [executing, setExecuting] = useState(false);
  const [submissionStarted, setSubmissionStarted] = useState(false);
  const [result, setResult] = useState<CompanyMergeResult | null>(null);
  const operationId = useRef<string | null>(null);

  const selectedFields = useMemo(() => preview?.fields ?? [], [preview]);
  const missingCompliance = useMemo(() => (preview?.compliance ?? []).filter((entry) =>
    !entry.records.some((record) => complianceChoices[String(entry.compliance_type_id)] === record.id)
  ), [preview, complianceChoices]);
  const activeContacts = useMemo(() => preview?.contacts.filter((contact) => contact.is_active) ?? [], [preview]);
  const needsPrimaryContact = activeContacts.length > 0;
  const canExecute = Boolean(preview && !preview.blockers.length && !missingCompliance.length
    && (!needsPrimaryContact || activeContacts.some((contact) => contact.id === primaryContact)));

  const loadPreview = async () => {
    if (!primary || !secondary || primary.id === secondary.id) return;
    setPreviewBusy(true);
    setError(null);
    setPreview(null);
    setResult(null);
    setChoices({});
    setComplianceChoices({});
    setPrimaryContact("");
    setIrreversibleAcknowledged(false);
    operationId.current = null;
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
    if (!preview || !primary || !secondary || !canExecute || !irreversibleAcknowledged) return;
    setExecuting(true);
    setSubmissionStarted(true);
    setError(null);
    operationId.current ??= crypto.randomUUID();
    try {
      const response = await adminFetch("/api/admin/company-merge", {
        method: "POST",
        body: JSON.stringify({
          primary: primary.id,
          secondary: secondary.id,
          snapshot: preview.snapshot,
          choices,
          compliance: complianceChoices,
          primary_contact: primaryContact || null,
          operation: operationId.current,
          confirmed: true,
        }),
      });
      const body = await response.json() as CompanyMergeResult & { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Company merge failed.");
      setResult(body);
      setConfirmationOpen(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Company merge failed. Retry with the same operation ID.");
    } finally {
      setExecuting(false);
    }
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
          <button type="button" onClick={() => { setResult(null); setPreview(null); setPrimary(null); setSecondary(null); }} className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700">Start another merge</button>
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
          <CandidateSearch side="primary" selected={primary} excludedId={secondary?.id ?? null} disabled={submissionStarted} onSelect={(candidate) => { setPrimary(candidate); setPreview(null); setResult(null); operationId.current = null; setSubmissionStarted(false); }} />
          <CandidateSearch side="secondary" selected={secondary} excludedId={primary?.id ?? null} disabled={submissionStarted} onSelect={(candidate) => { setSecondary(candidate); setPreview(null); setResult(null); operationId.current = null; setSubmissionStarted(false); }} />
        </div>
        <button type="button" onClick={() => void loadPreview()} disabled={!primary || !secondary || primary.id === secondary.id || previewBusy || submissionStarted} className="rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50">{previewBusy ? "Loading preview…" : "Load merge preview"}</button>

        {error ? <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</p> : null}

        {preview ? (
          <section aria-label="Company merge preview" className="space-y-4">
            {preview.blockers.length ? <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4">
              <h2 className="font-semibold text-red-900">Merge blocked</h2>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-red-800">{preview.blockers.map((blocker, index) => <li key={`${blocker}-${index}`}>{blocker}</li>)}</ul>
            </div> : null}

            <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">
              <strong>External systems:</strong> Review MyCOI and Procore after this merge and explicitly rematch their records. This operation does not guarantee that either external system is updated.
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
                    <input type="radio" name={`field-${field}`} checked={choices[field] === choice} disabled={submissionStarted} onChange={() => setChoices((current) => ({ ...current, [field]: choice }))} className="mt-0.5 accent-indigo-600 disabled:opacity-50" />
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
                  <select value={complianceChoices[String(entry.compliance_type_id)] ?? ""} disabled={submissionStarted} onChange={(event) => setComplianceChoices((current) => ({ ...current, [String(entry.compliance_type_id)]: Number(event.target.value) }))} className="mt-2 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm disabled:bg-slate-100">
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
                <select value={primaryContact} disabled={submissionStarted} onChange={(event) => setPrimaryContact(event.target.value)} className="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 disabled:bg-slate-100">
                  <option value="">Choose one existing contact…</option>
                  {activeContacts.map((contact) => <option key={contact.id} value={contact.id}>{contact.contact_name} · Company {contact.contractor_id}{contact.is_primary_contact ? " · currently primary" : ""}</option>)}
                </select>
              </label> : <p className="mt-3 text-xs text-slate-500">No active contact records are available; no primary contact is required.</p>}
            </section>

            <section className="rounded-xl border border-slate-300 bg-white p-4">
              <label className="flex items-start gap-3 text-sm text-slate-800">
                <input type="checkbox" checked={irreversibleAcknowledged} disabled={submissionStarted} onChange={(event) => setIrreversibleAcknowledged(event.target.checked)} className="mt-0.5 h-4 w-4 accent-red-700 disabled:opacity-50" />
                <span>I understand this merge is irreversible and have reviewed the selected companies and merge choices.</span>
              </label>
              <button type="button" onClick={() => setConfirmationOpen(true)} disabled={!canExecute || !irreversibleAcknowledged} className="mt-4 rounded-lg bg-red-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-red-800 disabled:cursor-not-allowed disabled:opacity-50">Continue to final confirmation</button>
              {!preview.blockers.length && missingCompliance.length ? <p className="mt-2 text-xs text-amber-800">Choose a record for each compliance type before continuing.</p> : null}
            </section>
          </section>
        ) : null}
      </div>

      {confirmationOpen ? <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4">
        <section role="dialog" aria-modal="true" aria-labelledby="merge-confirm-title" className="w-full max-w-lg space-y-4 rounded-xl bg-white p-6 shadow-2xl">
          <h2 id="merge-confirm-title" className="text-xl font-semibold text-slate-900">Confirm irreversible company merge</h2>
          <p className="text-sm text-slate-700">Merge <strong>{secondary?.company_name} (ID {secondary?.id})</strong> into <strong>{primary?.company_name} (ID {primary?.id})</strong>? The primary company will survive. Historical records will not be deleted.</p>
          <p className="text-sm text-red-800">This final action cannot be undone. Verify the company identities and choices before proceeding.</p>
          {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : null}
          <div className="flex flex-col-reverse justify-end gap-2 sm:flex-row">
            <button type="button" onClick={() => setConfirmationOpen(false)} disabled={executing || submissionStarted} className="rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-medium text-slate-700 disabled:opacity-50">Go back</button>
            <button type="button" onClick={() => void executeMerge()} disabled={executing || !canExecute || !irreversibleAcknowledged} className="rounded-lg bg-red-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-red-800 disabled:opacity-50">{executing ? "Merging…" : submissionStarted ? "Retry same operation" : "Confirm and merge"}</button>
            {submissionStarted && !executing ? <button type="button" onClick={() => { operationId.current = null; setSubmissionStarted(false); setConfirmationOpen(false); void loadPreview(); }} className="rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-medium text-slate-700">Discard retry and refresh preview</button> : null}
          </div>
        </section>
      </div> : null}
    </main>
  );
}
