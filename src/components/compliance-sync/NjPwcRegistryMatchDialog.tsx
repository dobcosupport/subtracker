"use client";

import { useRef, useState } from "react";
import { adminFetch } from "@/lib/admin-client";
import { njPwcExceptionButtonClass, njPwcRegistryFields, type NjPwcRegistryField, type NjPwcRegistryMatch } from "@/lib/nj-pwc-registry-fields";

function address(values: (string | null)[]): string {
  return values.filter(Boolean).join(", ") || "Not supplied";
}

export function NjPwcRegistryComparison({ match }: { match: NjPwcRegistryMatch }) {
  const candidate = match.candidate;
  if (!candidate) return <p className="mt-2 text-xs text-slate-500">No specific registry candidate available. Run Search Again or review the contractor manually.</p>;
  const indicators = [
    ["Certificate Match", match.evidence.certificate_match],
    ["Street Address Match", match.evidence.street_address_match],
    ["City Match", match.evidence.city_match],
    ["State Match", match.evidence.state_match],
    ["ZIP Match", match.evidence.zip_match],
  ] as const;
  return (
    <div className="mt-2 space-y-1 text-xs font-normal">
      <p><strong>Current Contractor Name:</strong> {match.current.company_name}</p>
      <p><strong>NJ PWC Registry Name:</strong> {candidate.business_name}</p>
      <p><strong>Contractor Address:</strong> {address([match.current.address_1, match.current.address_2, match.current.city, match.current.state, match.current.zip_code])}</p>
      <p><strong>Registry Address:</strong> {address([candidate.address, candidate.city, candidate.state, candidate.zip_code])}</p>
      <p><strong>Current NJ PWC #:</strong> {match.known_certificates.join(", ") || "Not supplied"}</p>
      <p><strong>Registry Certificate #:</strong> {candidate.certificate_number}</p>
      <p className={match.evidence.confidence === "High" ? "font-semibold text-emerald-700" : match.evidence.confidence === "Medium" ? "font-semibold text-amber-700" : "font-semibold text-red-700"}>{match.evidence.confidence} Confidence</p>
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {indicators.map(([label, matched]) => <span key={label}>{label}: {matched ? "Yes" : "No / Missing"}</span>)}
        <span>Registration: {match.evidence.expired ? "Expired" : match.evidence.registration_active ? "Active" : "Unknown / Invalid"}</span>
      </div>
      {match.evidence.unit_conflict ? <p className="text-red-700">Unit, suite, floor, or building information conflicts or is incomplete.</p> : null}
      {match.evidence.registry_anomaly ? <p className="text-red-700">Registry validation anomaly. Compliance approval requires review.</p> : null}
      {match.duplicate_target ? <p className="text-red-700">Another contractor may be the same entity. Use the existing contractor merge workflow; acceptance is blocked.</p> : null}
    </div>
  );
}

export default function NjPwcRegistryMatchDialog({ match, onClose, onAccepted }: {
  match: NjPwcRegistryMatch;
  onClose: () => void;
  onAccepted: (message: string) => void;
}) {
  const [selected, setSelected] = useState<NjPwcRegistryField[]>(["company_name"]);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submitting = useRef(false);
  const candidate = match.candidate;
  if (!candidate) return null;

  const accept = async () => {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      const response = await adminFetch("/api/admin/compliance-sync/nj-pwc-registry-match", {
        method: "POST",
        body: JSON.stringify({ exception_id: match.exception_id, snapshot: match.snapshot, selected_fields: selected, confirmed: true }),
      });
      const result = await response.json() as { message?: string; error?: string };
      if (!response.ok || !result.message) throw new Error(result.error ?? "Unable to accept the registry match.");
      onAccepted(result.message);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to accept the registry match.");
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/40 px-4">
      <div role="dialog" aria-modal="true" aria-labelledby="nj-pwc-match-title" className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-2xl bg-white p-6 shadow-xl">
        <h2 id="nj-pwc-match-title" className="text-xl font-semibold">{confirming ? "Accept NJ PWC Registry Match?" : "Compare & Accept Registry Match"}</h2>
        <NjPwcRegistryComparison match={match} />
        {confirming ? (
          <div className="mt-4 text-sm">
            <p><strong>Current Contractor Name:</strong> {match.current.company_name}</p>
            <p><strong>New Contractor Name:</strong> {candidate.business_name}</p>
            <p><strong>NJ PWC #:</strong> {candidate.certificate_number}</p>
            <p><strong>Address:</strong> {address([candidate.address, candidate.city, candidate.state, candidate.zip_code])}</p>
            <p className="mt-3 font-semibold">This action will:</p>
            <ul className="ml-5 list-disc space-y-1">
              <li>Update the contractor company name to the NJ PWC registry name.</li>
              <li>Import only these selected fields: {njPwcRegistryFields.filter((field) => selected.includes(field.field)).map((field) => field.label).join(", ")}.</li>
              <li>{match.evidence.confidence === "High" && match.mode === "auto_approve" ? "Process valid High Confidence compliance results automatically using Auto Approve mode." : "Send the compliance result to Review Required, regardless of Auto Approve mode for Medium or Low Confidence."}</li>
              <li>Resolve the Name Mismatch exception and reset the consecutive NJ PWC failure count.</li>
              <li>Preserve project assignments, compliance history, insurance, follow-ups, tiered-sub relationships, and audit history.</li>
            </ul>
            {match.is_test ? <p className="mt-3 font-semibold text-amber-800">This source is Test Mode. Acceptance is a deliberate user-selected import that can update live contractor data and, when eligible, live compliance records.</p> : null}
          </div>
        ) : (
          <>
            <p className="mt-4 text-sm text-slate-500">Choose fields to import. Populated fields are never overwritten unless explicitly selected. Company Name is required.</p>
            <table className="mt-3 w-full text-left text-sm">
              <thead><tr><th className="p-2">Field</th><th className="p-2">Registry Value</th><th className="p-2">Current Value</th><th className="p-2">Import</th></tr></thead>
              <tbody>{njPwcRegistryFields.filter((field) => field.field !== "county" || candidate.county).map((field) => (
                <tr key={field.field}>
                  <td className="p-2">{field.label}</td>
                  <td className="p-2">{candidate[field.candidate] || "Not supplied"}</td>
                  <td className="p-2">{match.current[field.field] || "Not supplied"}</td>
                  <td className="p-2"><input type="checkbox" aria-label={`Import ${field.label}`} checked={selected.includes(field.field)}
                    disabled={field.field === "company_name" || !candidate[field.candidate]}
                    onChange={(event) => setSelected((current) => event.target.checked ? [...current, field.field] : current.filter((key) => key !== field.field))} /></td>
                </tr>
              ))}</tbody>
            </table>
          </>
        )}
        {error ? <p role="alert" className="mt-3 text-sm text-red-700">{error}</p> : null}
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button type="button" disabled={busy} onClick={onClose} className={`${njPwcExceptionButtonClass} border-slate-300 bg-slate-100`}>Cancel</button>
          {confirming ? <button type="button" disabled={busy || !match.can_accept} onClick={() => void accept()} className={`${njPwcExceptionButtonClass} bg-indigo-600 text-white`}>{busy ? "Accepting..." : "Accept Registry Match"}</button>
            : <button type="button" disabled={!match.can_accept} onClick={() => setConfirming(true)} className={`${njPwcExceptionButtonClass} bg-indigo-600 text-white`}>Continue to Confirmation</button>}
        </div>
      </div>
    </div>
  );
}
