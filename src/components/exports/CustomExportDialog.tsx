"use client";

import { useEffect, useRef, useState } from "react";
import ExportFieldSelector from "./ExportFieldSelector";
import { EXPORT_FIELDS, prepareCustomExport, exportCompletionMessage, countAllExportContractors, customExportFilename, fetchCustomExportData, generateCustomExport } from "@/lib/custom-export";
import type { CustomExportConfiguration, CustomExportRow } from "@/types/custom-export";

interface Props {
  contractorIds: number[];
  dashboardFilter: string;
  dashboardSearch: string;
  onClose: () => void;
}

export default function CustomExportDialog({ contractorIds, dashboardFilter, dashboardSearch, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const exportController = useRef<AbortController | null>(null);
  const [configuration, setConfiguration] = useState<CustomExportConfiguration>({
    scope: "filtered",
    format: "xlsx",
    fields: EXPORT_FIELDS.filter((field) => field.defaultSelected).map((field) => field.id),
  });
  const [allCount, setAllCount] = useState<number | null>(null);
  const [countError, setCountError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [completion, setCompletion] = useState<string | null>(null);
  const [pendingDownload, setPendingDownload] = useState<{ rows: CustomExportRow[]; warningCount: number } | null>(null);
  const busy = progress !== null;
  const selectionLocked = busy || pendingDownload !== null;
  const recordCount = configuration.scope === "filtered" ? contractorIds.length : allCount;

  useEffect(() => {
    const element = dialog.current;
    const previousFocus = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    element?.showModal();
    document.body.style.overflow = "hidden";
    const controller = new AbortController();
    void countAllExportContractors(controller.signal).then(setAllCount).catch((reason: unknown) => {
      if (!controller.signal.aborted) setCountError(reason instanceof Error ? reason.message : "Unable to count contractors.");
    });
    return () => {
      controller.abort();
      exportController.current?.abort();
      element?.close();
      document.body.style.overflow = previousOverflow;
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);

  const downloadPreparedExport = (prepared: { rows: CustomExportRow[]; warningCount: number }) => {
    setError(null);
    const blob = generateCustomExport(prepared.rows, configuration.fields, configuration.format);
    const url = URL.createObjectURL(blob);
    try {
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = customExportFilename(configuration.format);
      document.body.appendChild(anchor);
      try {
        anchor.click();
      } finally {
        anchor.remove();
      }
    } finally {
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    setPendingDownload(null);
    setCompletion(exportCompletionMessage(prepared.warningCount, configuration.fields.includes("data_warning")));
  };

  const exportFile = async () => {
    if (exportController.current) return;
    if (configuration.fields.length === 0) {
      setError("Select at least one field to export.");
      return;
    }
    if (recordCount === 0) {
      setError("There are no contractors in this scope to export.");
      return;
    }
    const controller = new AbortController();
    exportController.current = controller;
    setError(null);
    setCompletion(null);
    setProgress("Loading authorized contractor data...");
    try {
      const data = await fetchCustomExportData(configuration, contractorIds, controller.signal);
      if (data.contractors.length === 0) throw new Error("There are no accessible contractors to export.");
      setProgress(`Preparing ${data.contractors.length} contractor rows...`);
      await new Promise((resolve) => window.setTimeout(resolve, 0));
      controller.signal.throwIfAborted();
      const prepared = prepareCustomExport(data, configuration.fields);
      controller.signal.throwIfAborted();
      if (prepared.warningCount > 0 && !configuration.fields.includes("data_warning")) {
        setPendingDownload(prepared);
        return;
      }
      downloadPreparedExport(prepared);
    } catch (reason) {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Unable to export contractors. Please try again.");
    } finally {
      if (!controller.signal.aborted) setProgress(null);
      if (exportController.current === controller) exportController.current = null;
    }
  };

  return (
    <dialog ref={dialog} aria-modal="true" aria-labelledby="custom-export-title" aria-describedby="custom-export-description" onCancel={(event) => { event.preventDefault(); onClose(); }} className="fixed inset-0 m-auto w-[calc(100%_-_2rem)] max-w-2xl rounded-2xl border border-slate-200 bg-white p-0 shadow-xl backdrop:bg-slate-900/40">
      <div className="flex h-[min(780px,90dvh)] flex-col">
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-slate-200 px-5 py-4">
          <div>
            <h2 id="custom-export-title" className="text-xl font-semibold text-slate-900">Custom Export</h2>
            <p id="custom-export-description" className="mt-1 text-xs text-slate-500">One row per contractor. Compliance uses active, current records. Dates use YYYY-MM-DD.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close Custom Export" autoFocus className="rounded-lg px-2 py-1 text-xl text-slate-500 hover:bg-slate-100">&times;</button>
        </header>
        <div className="flex min-h-0 flex-1 flex-col gap-4 px-5 py-4">
          <fieldset disabled={selectionLocked} className="shrink-0 space-y-2">
            <legend className="mb-2 text-sm font-semibold text-slate-900">Records to export</legend>
            {([["filtered", "Current Dashboard Results"], ["all", "All Contractors"]] as const).map(([scope, label]) => (
              <label key={scope} className="flex items-center gap-2 text-sm text-slate-700">
                <input type="radio" name="export-scope" value={scope} checked={configuration.scope === scope} onChange={() => { setConfiguration((current) => ({ ...current, scope })); setError(null); setCompletion(null); }} className="accent-indigo-600" />
                {label}
              </label>
            ))}
            <p className="text-xs text-slate-500">{configuration.scope === "filtered" ? `Card: ${dashboardFilter}${dashboardSearch.trim() ? `; Search: "${dashboardSearch.trim()}"` : "; no search text"}.` : "All accessible contractors, including inactive contractors. Dashboard filters do not apply."}</p>
            <p role="status" className="text-xs font-medium text-slate-700">{recordCount === null ? "Contractor count unavailable until data is loaded." : `${recordCount} contractor${recordCount === 1 ? "" : "s"} to export`}</p>
            {countError && configuration.scope === "all" ? <p className="text-xs text-red-700">Unable to count contractors: {countError} Export will retry data retrieval.</p> : null}
          </fieldset>
          <ExportFieldSelector selected={configuration.fields} disabled={selectionLocked} onChange={(fields) => { setConfiguration((current) => ({ ...current, fields })); setError(null); setCompletion(null); }} />
          <fieldset disabled={selectionLocked} className="flex shrink-0 flex-wrap items-center gap-x-5 gap-y-2 text-sm text-slate-700">
            <legend className="mb-2 font-semibold text-slate-900">File format</legend>
            {([["xlsx", "Excel (.xlsx)"], ["csv", "CSV (.csv)"]] as const).map(([format, label]) => (
              <label key={format} className="flex items-center gap-2">
                <input type="radio" name="export-format" checked={configuration.format === format} onChange={() => { setConfiguration((current) => ({ ...current, format })); setCompletion(null); }} className="accent-indigo-600" />
                {label}
              </label>
            ))}
          </fieldset>
          <p className="shrink-0 text-xs text-slate-500">Project lists include active assignments; tiered-sub lists include active relationships. Latest follow-up is ordered by follow-up date, then creation date.</p>
          {error ? <p role="alert" className="shrink-0 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null}
          {pendingDownload ? <div role="alert" className="shrink-0 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
            Data-quality issues were found for {pendingDownload.warningCount} contractor{pendingDownload.warningCount === 1 ? "" : "s"}. Data Warning is not selected, so these issues will not appear in the file. Ambiguous compliance fields will be blank.
            <button type="button" onClick={() => { setPendingDownload(null); setError(null); }} className="mt-1 block font-semibold underline">Back to field selection</button>
          </div> : null}
          {completion ? <p role="status" className="shrink-0 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{completion}</p> : null}
          {progress ? <p role="status" className="flex shrink-0 items-center gap-2 text-sm text-slate-600"><span aria-hidden="true" className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-indigo-600" />{progress}</p> : null}
        </div>
        <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-slate-200 px-5 py-4">
          <p className="text-xs text-slate-500">{configuration.fields.length} fields &middot; {configuration.format.toUpperCase()}</p>
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm text-slate-700">Cancel</button>
            <button type="button" onClick={() => {
              if (pendingDownload) {
                try { downloadPreparedExport(pendingDownload); } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to generate export."); }
              } else void exportFile();
            }} disabled={busy} className="rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-medium text-white disabled:opacity-50">{busy ? "Exporting..." : pendingDownload ? "Download without warnings" : "Export"}</button>
          </div>
        </footer>
      </div>
    </dialog>
  );
}
