"use client";

import { useEffect, useRef, useState } from "react";
import { adminFetch } from "@/lib/admin-client";
import { njPwcExceptionButtonClass as button, type NjPwcExceptionCandidates } from "@/lib/nj-pwc-registry-fields";

export default function NjPwcSelectMatchDialog({ exceptionId, onClose, onAccepted }: {
  exceptionId: number; onClose: () => void; onAccepted: (message: string) => void;
}) {
  const [results, setResults] = useState<NjPwcExceptionCandidates | null>(null);
  const [selected, setSelected] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submitting = useRef(false);
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let active = true;
    const previous = document.activeElement;
    dialog.current?.focus();
    void (async () => {
      try {
        const response = await adminFetch(`/api/admin/compliance-sync/nj-pwc-select-match?exception_id=${exceptionId}`);
        const body = await response.json() as { selection?: NjPwcExceptionCandidates; error?: string };
        if (!response.ok || !body.selection) throw new Error(body.error ?? "Unable to load stored registry candidates.");
        if (active) setResults(body.selection);
      } catch (reason) {
        if (active) setError(reason instanceof Error ? reason.message : "Unable to load stored registry candidates.");
      }
    })();
    return () => { active = false; if (previous instanceof HTMLElement) previous.focus(); };
  }, [exceptionId]);
  const submit = async () => {
    if (!results || !selected || !confirmed || submitting.current) return;
    submitting.current = true; setBusy(true); setError(null);
    try {
      const response = await adminFetch("/api/admin/compliance-sync/nj-pwc-select-match", {
        method: "POST", body: JSON.stringify({ exception_id: exceptionId, search_request_id: results.search_request_id,
          snapshot: results.snapshot, candidate_identity: selected, confirmed: true }),
      });
      const body = await response.json() as { message?: string; error?: string };
      if (!response.ok || !body.message) throw new Error(body.error ?? "Unable to select registry match.");
      onAccepted(body.message);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to select registry match.");
    } finally { submitting.current = false; setBusy(false); }
  };
  return <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/40 p-3">
    <div ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="pwc-select-title"
      className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-xl bg-white p-4 shadow-xl"
      onKeyDown={event => {
        if (event.key === "Escape" && !busy) onClose();
        if (event.key === "Tab") {
          const elements = Array.from(dialog.current?.querySelectorAll<HTMLElement>("button:not(:disabled),input:not(:disabled),a[href]") ?? []);
          const radios = elements.filter((element): element is HTMLInputElement => element instanceof HTMLInputElement && element.type === "radio");
          const activeRadio = radios.find(element => element.checked) ?? radios[0];
          const controls = elements.filter(element => !(element instanceof HTMLInputElement && element.type === "radio") || element === activeRadio);
          if (!controls.length) return;
          const first = controls[0], last = controls[controls.length - 1];
          if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) {
            event.preventDefault(); last.focus();
          } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        }
      }}>
      <h2 id="pwc-select-title" className="text-lg font-semibold">Select NJ PWC Match</h2>
      {results ? <>
        <p className="mt-1 text-sm">{results.company_name} · Stored request #{results.search_request_id}</p>
        <p className="mt-1 text-xs text-slate-600">Choose the correct registration. Existing validation and Review Required policy still apply. Contractor name and address will not be overwritten.</p>
        {results.is_test ? <p className="mt-2 text-sm text-amber-800">These results came from Test Mode. Confirming is an explicit live import and may update compliance records.</p> : null}
        <fieldset disabled={busy} className="mt-3 space-y-2">
          <legend className="text-sm font-semibold">Stored registry candidates</legend>
          {results.candidates.map((candidate, index) => {
            const link = candidate.source_url && /^https?:\/\//i.test(candidate.source_url) ? candidate.source_url : null;
            const duplicate = results.candidates.filter(other => other.identity === candidate.identity
              || other.certificate_number.replace(/[\s-]/g, "").toUpperCase() === candidate.certificate_number.replace(/[\s-]/g, "").toUpperCase()).length > 1;
            return <div key={`${candidate.identity}:${index}`} className="rounded-lg border border-slate-200 p-2 text-sm">
              <label className="flex items-start gap-2">
                <input type="radio" name="pwc-candidate" className="mt-1" disabled={duplicate} value={candidate.identity} checked={selected === candidate.identity}
                  onChange={() => { setSelected(candidate.identity); setConfirmed(false); }} />
                <span><strong>{candidate.business_name}</strong> · Certificate {candidate.certificate_number}<br />
                  {[candidate.address, candidate.city, candidate.state, candidate.zip_code].filter(Boolean).join(", ") || "Address not supplied"}
                  {candidate.county ? <><br />County: {candidate.county}</> : null}<br />
                  Effective: {candidate.registration_date || "Not supplied"} · Expires: {candidate.expiration_date || "Not supplied"}
                  {duplicate ? <><br /><span className="text-red-700">Duplicate registry certificate; manual investigation required.</span></> : null}
                </span>
              </label>
              {link ? <a href={link} target="_blank" rel="noopener noreferrer" className="ml-5 text-xs text-indigo-700 underline focus-visible:outline focus-visible:outline-2">Registry source</a> : null}
            </div>;
          })}
        </fieldset>
        {!results.candidates.length ? <p className="mt-2 text-sm">No usable stored candidates. Run Search Again if fresh results are needed.</p> : null}
        <label className="mt-3 flex items-start gap-2 text-sm">
          <input type="checkbox" checked={confirmed} disabled={!selected || busy} onChange={event => setConfirmed(event.target.checked)} />
          I confirm this is the correct registry registration and authorize processing under existing validation and review rules.
        </label>
      </> : !error ? <p role="status" className="mt-3 text-sm">Loading stored candidates...</p> : null}
      {error ? <p role="alert" className="mt-3 text-sm text-red-700">{error}</p> : null}
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <button type="button" disabled={busy} onClick={onClose} className={`${button} border-slate-400 bg-slate-100 text-slate-900 hover:bg-slate-200`}>Cancel</button>
        <button type="button" disabled={!selected || !confirmed || busy} onClick={() => void submit()}
          className={`${button} border-green-800 bg-green-700 text-white hover:bg-green-800`}>{busy ? "Processing..." : "Confirm Selection"}</button>
      </div>
    </div>
  </div>;
}
