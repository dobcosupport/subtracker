"use client";

import { useEffect, useRef, useState } from "react";
import { saveExportTemplate } from "@/services/export-templates";
import { TEMPLATE_CATEGORIES, type ExportTemplate, type ExportTemplateDraft } from "@/types/export-template";
import { validateTemplateDraft } from "@/lib/export-template-config";
import ExportFieldSelector from "./ExportFieldSelector";
import ExportOptions from "./ExportOptions";

export default function ExportTemplateEditor({ initial, existing, notice, canShare, onClose, onSaved }: {
  initial: ExportTemplateDraft; existing?: ExportTemplate; notice?: string; canShare: boolean; onClose: () => void; onSaved: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  useEffect(() => {
    const element = ref.current;
    const focus = document.activeElement;
    const overflow = document.body.style.overflow;
    element?.showModal(); document.body.style.overflow = "hidden";
    return () => { element?.close(); document.body.style.overflow = overflow; if (focus instanceof HTMLElement && focus.isConnected) focus.focus(); };
  }, []);
  const save = async () => {
    if (saving.current) return;
    saving.current = true; setBusy(true); setError(null);
    try { validateTemplateDraft(draft); await saveExportTemplate(draft, existing); onSaved(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to save template."); }
    finally { saving.current = false; setBusy(false); }
  };
  return <dialog ref={ref} aria-modal="true" aria-labelledby="template-editor-title" onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }} className="fixed inset-0 m-auto w-[calc(100%_-_2rem)] max-w-3xl rounded-2xl border p-0 shadow-xl backdrop:bg-slate-900/40">
    <div className="flex h-[min(850px,90dvh)] flex-col">
      <header className="flex shrink-0 items-center justify-between border-b px-5 py-4"><h2 id="template-editor-title" className="text-xl font-semibold">{existing ? "Edit Export Template" : "Create Export Template"}</h2><button type="button" autoFocus disabled={busy} onClick={onClose} aria-label="Close template editor" className="px-2 text-xl">&times;</button></header>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
        {notice ? <p role="alert" className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800">{notice} Review and repair the settings before saving in the current format.</p> : null}
        <fieldset disabled={busy} className="grid gap-3 text-sm sm:grid-cols-2">
          <label>Template name<input value={draft.name} maxLength={120} required onChange={(event) => setDraft({ ...draft, name: event.target.value })} className="mt-1 block w-full rounded-lg border p-2" /></label>
          <label>Category<select value={draft.category} onChange={(event) => { const category = TEMPLATE_CATEGORIES.find((item) => item.id === event.target.value); if (category) setDraft({ ...draft, category: category.id }); }} className="mt-1 block w-full rounded-lg border p-2">{TEMPLATE_CATEGORIES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
          <label className="sm:col-span-2">Description<textarea value={draft.description ?? ""} maxLength={2000} onChange={(event) => setDraft({ ...draft, description: event.target.value || null })} className="mt-1 block w-full rounded-lg border p-2" /></label>
          <label>Visibility<select disabled={!canShare} value={draft.visibility} onChange={(event) => setDraft({ ...draft, visibility: event.target.value === "shared" ? "shared" : "private" })} className="mt-1 block w-full rounded-lg border p-2"><option value="private">Private</option><option value="shared">Shared</option></select></label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={draft.active} onChange={(event) => setDraft({ ...draft, active: event.target.checked })} />Active template</label>
          <p className="text-xs text-slate-500 sm:col-span-2">Category organizes templates. Visibility controls access. Only administrators can publish shared templates.</p>
          <label>Default format<select value={draft.configuration.format} onChange={(event) => setDraft({ ...draft, configuration: { ...draft.configuration, format: event.target.value === "csv" ? "csv" : "xlsx" } })} className="mt-1 block w-full rounded-lg border p-2"><option value="xlsx">Excel (.xlsx)</option><option value="csv">CSV (.csv)</option></select></label>
          <label>Default scope<select value={draft.configuration.scope} onChange={(event) => setDraft({ ...draft, configuration: { ...draft.configuration, scope: event.target.value === "all" ? "all" : "filtered" } })} className="mt-1 block w-full rounded-lg border p-2"><option value="filtered">Current Dashboard Results</option><option value="all">All Contractors</option></select></label>
        </fieldset>
        <div className="flex h-80 flex-col"><ExportFieldSelector ordered disabled={busy} selected={draft.configuration.fields} onChange={(fields) => setDraft({ ...draft, configuration: { ...draft.configuration, fields } })} /></div>
        <ExportOptions disabled={busy} configuration={draft.configuration} onChange={(configuration) => setDraft({ ...draft, configuration })} />
        {error ? <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p> : null}
      </div>
      <footer className="flex shrink-0 justify-end gap-3 border-t px-5 py-4"><button type="button" disabled={busy} onClick={onClose} className="rounded-lg border px-4 py-2">Cancel</button><button type="button" disabled={busy} onClick={() => void save()} className="rounded-lg bg-slate-900 px-4 py-2 text-white disabled:opacity-50">{busy ? "Saving..." : "Save template"}</button></footer>
    </div>
  </dialog>;
}
