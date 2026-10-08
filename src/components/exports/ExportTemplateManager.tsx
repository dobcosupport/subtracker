"use client";

import { useState } from "react";
import { deleteExportTemplate } from "@/services/export-templates";
import { newTemplateDraft, templateConfiguration } from "@/lib/export-template-config";
import type { ExportTemplate, ExportTemplateDraft } from "@/types/export-template";
import { isTemplateAdministrator, templatePermission, useSessionProfile } from "../SessionContext";
import ExportTemplateEditor from "./ExportTemplateEditor";
import ExportTemplateList from "./ExportTemplateList";
import { useExportTemplates } from "./useExportTemplates";

export default function ExportTemplateManager() {
  const profile = useSessionProfile();
  const state = useExportTemplates();
  const [editor, setEditor] = useState<{ initial: ExportTemplateDraft; existing?: ExportTemplate; notice?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const editable = (template: ExportTemplate) => !template.is_system && (template.owner_user_id === profile.auth_user_id || isTemplateAdministrator(profile));
  const open = (template: ExportTemplate, duplicate: boolean) => {
    let notice: string | undefined;
    try { templateConfiguration(template); }
    catch (reason) { notice = reason instanceof Error ? reason.message : "Unsupported template configuration."; }
    setEditor({ existing: duplicate ? undefined : template, notice, initial: {
      name: duplicate ? `${template.name.slice(0, 113)} (copy)` : template.name,
      description: template.description, category: template.category,
      visibility: duplicate ? "private" : template.visibility, active: duplicate || template.active,
      configuration: { fields: [...template.field_ids], format: template.default_format, scope: template.default_scope, sort: template.sort_configuration, filters: template.filter_configuration },
    } });
  };
  const remove = async (template: ExportTemplate) => {
    if (!window.confirm(`Delete "${template.name}"? This cannot be undone.`)) return;
    setBusy(true); state.setError(null);
    try { await deleteExportTemplate(template); await state.refresh(); }
    catch (reason) { state.setError(reason instanceof Error ? reason.message : "Unable to delete template."); }
    finally { setBusy(false); }
  };
  return <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-xl font-semibold">Saved Export Templates</h2><p className="mt-1 text-sm text-slate-500">Manage reusable settings here. Run templates from Dashboard Export. System templates can be duplicated, not edited.</p></div>
      <div className="flex gap-3 text-sm"><button type="button" disabled={state.loading || busy} onClick={() => void state.refresh()} className="text-indigo-600">Refresh templates</button>{templatePermission(profile, "add") ? <button type="button" disabled={busy} onClick={() => setEditor({ initial: newTemplateDraft() })} className="rounded-lg bg-slate-900 px-4 py-2 text-white">Create template</button> : null}</div>
    </div>
    {state.error ? <p role="alert" className="mb-3 rounded-lg bg-red-50 p-3 text-sm text-red-700">{state.error}</p> : null}
    {state.loading ? <p role="status" className="text-sm">Loading templates...</p> : <ExportTemplateList management templates={state.templates} preferences={state.preferences} preference={(...args) => void state.preference(...args)} disabled={busy || state.preferenceBusy} actions={(template) => <>
      {templatePermission(profile, "add") ? <button type="button" disabled={busy} onClick={() => open(template, true)} className="text-indigo-600">Duplicate</button> : null}
      {editable(template) && templatePermission(profile, "edit") ? <button type="button" disabled={busy} onClick={() => open(template, false)} className="text-indigo-600">Edit</button> : null}
      {editable(template) && templatePermission(profile, "delete") ? <button type="button" disabled={busy} onClick={() => void remove(template)} className="text-red-700">Delete</button> : null}
    </>} />}
    {editor ? <ExportTemplateEditor initial={editor.initial} existing={editor.existing} notice={editor.notice} canShare={isTemplateAdministrator(profile)} onClose={() => setEditor(null)} onSaved={() => { setEditor(null); void state.refresh(); }} /> : null}
  </section>;
}
