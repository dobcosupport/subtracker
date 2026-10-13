"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { adminFetch } from "@/lib/admin-client";

interface BrcEvidence {
  taxpayer_name?: string;
  trade_name?: string | null;
  address?: string | null;
  certificate_number?: string;
  effective_date?: string;
  date_of_issuance?: string | null;
  office_use_only?: string | null;
  source_url?: string;
  verified_at?: string;
  match_rationale?: string;
  discrepancy_warnings?: string[];
}
interface BrcRequest {
  id: string;
  status: string;
  company_name: string;
  nj_brc_number: string | null;
  brc_name_control: string;
  federal_tax_id_masked?: string | null;
  taxpayer_id_submission_masked?: string | null;
  created_at: string;
  review_queue_id?: number | null;
  result_evidence?: BrcEvidence | null;
  error_message?: string | null;
  current_contractor?: { company_name: string; nj_brc_number: string | null; brc_name_control: string | null; federal_tax_id_masked: string | null } | null;
}
const stateLabels: Record<string, string> = {
  pending: "Pending", claimed: "Claimed", processing: "Processing",
  human_verification_required: "Human Verification Required", review_required: "Review Required",
  completed: "Completed", no_match: "No Match", invalid_input: "Invalid Input",
  identity_mismatch: "Identity Mismatch", ambiguous_result: "Ambiguous Result",
  website_error: "Website Error", failed: "Failed",
};

export function NjBrcReviewEvidence({ reviewId }: { reviewId: number }) {
  const [expanded, setExpanded] = useState(false);
  return <details className="mt-2 min-w-80" onToggle={(event) => setExpanded(event.currentTarget.open)}>
    <summary className="cursor-pointer text-indigo-600">View NJ BRC evidence</summary>
    {expanded ? <NjBrcRequestPanel reviewId={reviewId} /> : null}
  </details>;
}

export default function NjBrcRequestPanel({ contractorId, reviewId, actionOnly = false }: { contractorId?: number; reviewId?: number; actionOnly?: boolean }) {
  const [request, setRequest] = useState<BrcRequest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const endpoint = `/api/contractors/nj-brc-search?${reviewId ? `review_id=${reviewId}` : `contractor_id=${contractorId}`}`;
  const load = useCallback(async (signal?: AbortSignal) => {
    const current = ++generation.current;
    try {
      const response = await adminFetch(endpoint, { signal });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Unable to load NJ BRC request.");
      if (!signal?.aborted && current === generation.current) { setRequest(result.request); setError(null); }
    } catch (reason) {
      if (!signal?.aborted && current === generation.current) setError(reason instanceof Error ? reason.message : "Unable to load NJ BRC request.");
    }
  }, [endpoint]);
  useEffect(() => {
    const controller = new AbortController();
    const initial = window.setTimeout(() => { void load(controller.signal); }, 0);
    const interval = window.setInterval(() => { void load(controller.signal); }, 15000);
    return () => { controller.abort(); window.clearTimeout(initial); window.clearInterval(interval); };
  }, [load]);
  const search = async () => {
    setBusy(true); setError(null);
    try {
      const response = await adminFetch("/api/contractors/nj-brc-search", { method: "POST", body: JSON.stringify({ contractor_id: contractorId }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Unable to queue NJ BRC request.");
      generation.current++;
      setRequest(result.request);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to queue NJ BRC request."); }
    finally { setBusy(false); }
  };
  return <>
    {!reviewId ? <button type="button" onClick={() => void search()} disabled={busy} className="whitespace-nowrap rounded-xl bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-50">{busy ? "Queuing..." : "Search NJ BRC"}</button> : null}
    {actionOnly && error ? <span role="alert" className="max-w-64 text-xs text-red-700">{error}</span> : null}
    {actionOnly && request ? <span role="status" className="text-xs text-slate-600">NJ BRC: {stateLabels[request.status] ?? request.status}</span> : null}
    {actionOnly ? null : <>
    <section aria-label="NJ BRC Registration Validation" className={`rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm ${reviewId ? "mt-4" : "mt-2 basis-full"}`}>
    <h3 className="font-semibold text-slate-900">NJ BRC Registration Validation</h3>
    <p className="mt-2 text-xs text-slate-500">Review Required only. NJ BRC is non-expiring. A successful lookup populates NJ BRC # from the returned Certificate Number; compliance records remain review-gated.</p>
    {error ? <p role="alert" className="mt-2 text-red-700">{error}</p> : null}
    {request ? <div className="mt-3 space-y-2">
      <p role="status">Request #{request.id}: <strong>{stateLabels[request.status] ?? request.status}</strong></p>
      <dl className="grid gap-2 sm:grid-cols-2">
        {[["Contractor", request.company_name], ["NJ BRC # at Request", request.nj_brc_number], ["Name Control", request.brc_name_control],
          ["Stored FEIN (masked)", request.federal_tax_id_masked], ["Submitted Taxpayer ID (masked)", request.taxpayer_id_submission_masked],
          ["Request Created", new Date(request.created_at).toLocaleString()]].map(([label, value]) => <div key={label}><dt className="font-medium">{label}</dt><dd className="break-words">{value || "Not provided"}</dd></div>)}
      </dl>
      {request.current_contractor ? <div className="border-t border-slate-200 pt-3">
        <h4 className="font-semibold">Current Contractor Data</h4>
        <dl className="mt-2 grid gap-2 sm:grid-cols-2">
          {[["Company Name", request.current_contractor.company_name], ["Current NJ BRC #", request.current_contractor.nj_brc_number],
            ["Name Control", request.current_contractor.brc_name_control], ["FEIN (masked)", request.current_contractor.federal_tax_id_masked]]
            .map(([label, value]) => <div key={label}><dt className="font-medium">{label}</dt><dd>{value || "Not provided"}</dd></div>)}
        </dl>
      </div> : null}
      {request.status === "human_verification_required" ? <p className="rounded-lg bg-amber-50 p-3 text-amber-800">An authorized person must complete human verification in the visible browser on the NJ BRC worker machine. The same session will continue; do not start another worker.</p> : null}
      {request.error_message ? <p role="alert" className="text-amber-800">{request.error_message}</p> : null}
      {request.result_evidence ? <dl className="grid gap-2 border-t border-slate-200 pt-3 sm:grid-cols-2">
        {[["Taxpayer Name", request.result_evidence.taxpayer_name], ["Trade Name", request.result_evidence.trade_name], ["Address", request.result_evidence.address],
          ["Certificate Number", request.result_evidence.certificate_number], ["Certificate Effective Date", request.result_evidence.effective_date],
          ["Date of Issuance (evidence only)", request.result_evidence.date_of_issuance], ["For Office Use Only (evidence only)", request.result_evidence.office_use_only],
          ["Verification Time", request.result_evidence.verified_at], ["Source URL", request.result_evidence.source_url],
          ["Match Rationale", request.result_evidence.match_rationale], ["Discrepancies", request.result_evidence.discrepancy_warnings?.join("; ")],
          ["Expiration", "Non-expiring"]].map(([label, value]) => <div key={label}><dt className="font-medium">{label}</dt><dd className="whitespace-pre-wrap break-words">{value || "Not displayed"}</dd></div>)}
      </dl> : null}
      {request.review_queue_id && !reviewId ? <Link href="/admin/compliance-sync" className="inline-block font-medium text-indigo-700">Review NJ BRC result #{request.review_queue_id}</Link> : null}
    </div> : <p className="mt-3 text-slate-500">{reviewId ? "No worker evidence available." : "No NJ BRC request loaded."}</p>}
  </section>
    </>}
  </>;
}
