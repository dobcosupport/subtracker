"use client";

import { useEffect, useRef, useState } from "react";

type Props = {
  companyName: string;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
};

export default function DeactivateContractorDialog({ companyName, onCancel, onConfirm }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const submitting = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const element = dialog.current;
    const focus = document.activeElement;
    const overflow = document.body.style.overflow;
    element?.showModal();
    cancelButton.current?.focus();
    document.body.style.overflow = "hidden";
    return () => {
      element?.close();
      document.body.style.overflow = overflow;
      if (focus instanceof HTMLElement && focus.isConnected) focus.focus();
    };
  }, []);

  const cancel = () => { if (!submitting.current) onCancel(); };
  const confirm = async () => {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      onCancel();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to deactivate contractor. Refresh the contractor before trying again.");
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  return <dialog ref={dialog} aria-modal="true" aria-labelledby="deactivate-contractor-title"
    aria-describedby="deactivate-contractor-description deactivate-contractor-warning"
    onCancel={event => { event.preventDefault(); cancel(); }}
    onKeyDown={event => { event.stopPropagation(); if (event.key === "Enter") event.preventDefault(); }}
    onClick={event => {
      if (event.target !== event.currentTarget) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) cancel();
    }}
    className="fixed inset-0 m-auto max-h-[90dvh] w-[calc(100%_-_2rem)] max-w-lg overflow-y-auto rounded-2xl border border-slate-200 bg-white p-0 text-slate-800 shadow-xl backdrop:bg-slate-900/40">
    <header className="flex items-center justify-between gap-4 border-b border-slate-200 px-5 py-4">
      <h2 id="deactivate-contractor-title" className="text-xl font-semibold">Deactivate Contractor?</h2>
      <button type="button" aria-label="Close deactivation confirmation" disabled={busy} onClick={cancel}
        className="rounded-md px-2 text-xl text-slate-500 hover:bg-slate-100 disabled:opacity-50">&times;</button>
    </header>
    <div id="deactivate-contractor-description" className="space-y-3 px-5 py-4 text-sm text-slate-600">
      <p>Are you sure you want to deactivate <strong className="text-slate-900">{companyName}</strong>?</p>
      <p>The contractor and existing history will be preserved.</p>
      <p id="deactivate-contractor-warning" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 font-semibold text-red-700">This does not delete the contractor or its history.</p>
      {error ? <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-red-700">{error}</p> : null}
    </div>
    <footer className="flex flex-wrap justify-end gap-3 border-t border-slate-200 px-5 py-4">
      <button ref={cancelButton} type="button" autoFocus disabled={busy} onClick={cancel}
        className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium hover:bg-slate-50 disabled:opacity-50">Cancel</button>
      <button type="button" disabled={busy} onClick={() => void confirm()}
        className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50">{busy ? "Deactivating..." : "Deactivate Contractor"}</button>
    </footer>
  </dialog>;
}
