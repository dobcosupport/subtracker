"use client";

import { useEffect, useRef, useState } from "react";
import { templateConfiguration } from "@/lib/export-template-config";
import type { CustomExportConfiguration } from "@/types/custom-export";
import type { ExportTemplate } from "@/types/export-template";
import CustomExportDialog from "./CustomExportDialog";
import ExportTemplateList from "./ExportTemplateList";
import { useExportTemplates } from "./useExportTemplates";

interface Props { contractorIds: number[]; dashboardFilter: string; dashboardSearch: string; onClose: () => void }
export default function DashboardExportDialog(props: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const state = useExportTemplates();
  const [selection, setSelection] = useState<{ configuration?: CustomExportConfiguration; template?: ExportTemplate; run: boolean } | null>(null);
  useEffect(() => {
    if (selection) return;
    const element = ref.current;
    const focus = document.activeElement;
    const overflow = document.body.style.overflow;
    element?.showModal(); document.body.style.overflow = "hidden";
    return () => { element?.close(); document.body.style.overflow = overflow; if (focus instanceof HTMLElement && focus.isConnected) focus.focus(); };
  }, [selection]);
  const choose = (template: ExportTemplate, run: boolean) => {
    try { setSelection({ configuration: templateConfiguration(template), template, run }); }
    catch (reason) { state.setError(reason instanceof Error ? reason.message : "Invalid template. Review it in Import / Export."); }
  };
  if (selection) return <CustomExportDialog {...props} initialConfiguration={selection.configuration} template={selection.template} runImmediately={selection.run} onClose={() => setSelection(null)} />;
  return <dialog ref={ref} aria-modal="true" aria-labelledby="dashboard-export-title" onCancel={(event) => { event.preventDefault(); props.onClose(); }} className="fixed inset-0 m-auto w-[calc(100%_-_2rem)] max-w-3xl rounded-2xl border p-0 shadow-xl backdrop:bg-slate-900/40">
    <div className="flex max-h-[90dvh] flex-col">
      <header className="flex shrink-0 items-center justify-between border-b px-5 py-4"><h2 id="dashboard-export-title" className="text-xl font-semibold">Dashboard Export</h2><button type="button" autoFocus onClick={props.onClose} aria-label="Close Dashboard Export" className="px-2 text-xl">&times;</button></header>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
        <button type="button" onClick={() => setSelection({ run: false })} className="rounded-xl bg-slate-900 px-4 py-2.5 text-sm text-white">Create Custom Export</button>
        <h3 className="text-lg font-semibold">Saved Export Templates</h3>
        {state.error ? <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{state.error}</p> : null}
        <button type="button" disabled={state.loading} onClick={() => void state.refresh()} className="text-sm text-indigo-600">Refresh templates</button>
        {state.loading ? <p role="status" className="text-sm">Loading templates...</p> : <ExportTemplateList templates={state.templates} preferences={state.preferences} preference={(...args) => void state.preference(...args)} disabled={state.preferenceBusy} actions={(template) => <>
          <button type="button" onClick={() => choose(template, true)} className="font-semibold text-indigo-600">Run</button>
          <button type="button" onClick={() => choose(template, false)} className="text-indigo-600">Review settings</button>
        </>} />}
      </div>
      <footer className="flex shrink-0 justify-end border-t px-5 py-4"><button type="button" onClick={props.onClose} className="rounded-lg border px-4 py-2">Cancel</button></footer>
    </div>
  </dialog>;
}
