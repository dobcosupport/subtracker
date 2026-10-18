"use client";

import { useCallback, useEffect, useState } from "react";
import { useSessionProfile } from "@/components/SessionContext";
import { canAccessModule } from "@/lib/permissions";
import { readJson } from "@/lib/communication-compose-client";
import { MERGE_FIELDS, parseMessageTemplate } from "@/lib/communication-templates";
import { TEMPLATE_CATEGORIES, type MessageTemplate, type MessageTemplateInput } from "@/types/communication-compose";

const button = "rounded border border-slate-300 px-2 py-1 text-sm disabled:opacity-50";
const control = "block w-full rounded border border-slate-300 px-2 py-1 text-sm";
const empty: MessageTemplateInput = { name: "", category: "General Contractor Communication", channel: "email", subject: "", body: "", is_active: false };
export default function CommunicationTemplatesPanel() {
  const { permissions } = useSessionProfile();
  const canManage = canAccessModule(permissions, "settings", "manage");
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [editor, setEditor] = useState<(MessageTemplateInput & { id?: string; revision?: number }) | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const load = useCallback(async () => {
    const rows: MessageTemplate[] = [];
    let offset: number | null = 0;
    do {
      const page: { templates: MessageTemplate[]; next_offset: number | null } = await readJson(`/api/admin/communication-templates?offset=${offset}`);
      rows.push(...page.templates);
      if (rows.length > 10000) throw new Error("Too many templates to display.");
      offset = page.next_offset;
    } while (offset !== null);
    return rows;
  }, []);
  useEffect(() => {
    let active = true;
    void load().then((rows) => { if (active) setTemplates(rows); }).catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : "Unable to load templates."); });
    return () => { active = false; };
  }, [load]);
  return <section aria-label="Communication templates" className="space-y-4">
    <div className="flex items-center justify-between"><h2 className="text-lg font-semibold">Communication Templates</h2>
      {canManage ? <button type="button" className={button} disabled={busy || !!editor} onClick={() => { setEditor({ ...empty }); setError(""); setNotice(""); }}>Add Template</button> : null}</div>
    <p className="text-sm text-slate-500">Installation-configurable plain text. Deactivate to preserve references and history. No templates execute or send automatically.</p>
    {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : null}
    {notice ? <p role="status" className="text-sm text-green-700">{notice}</p> : null}
    <ul className="divide-y rounded border border-slate-200">{templates.map((template) => <li key={template.id} className="flex items-center justify-between gap-3 p-3 text-sm">
      <span>{template.name} · {template.channel} · {template.category} · {template.is_active ? "Active" : "Inactive"}</span>
      {canManage ? <button className={button} disabled={busy || !!editor} onClick={() => { setEditor(template); setError(""); setNotice(""); }}>Edit</button> : null}
    </li>)}</ul>
    {!templates.length ? <p className="text-sm">No templates configured.</p> : null}
    {editor ? <form className="space-y-3 rounded border p-4" aria-label="Template editor" onSubmit={(event) => {
      event.preventDefault();
      if (!canManage) return;
      setBusy(true); setError(""); setNotice("");
      void (async () => {
        try {
          const { id, revision, name, category, channel, subject, body, is_active } = editor;
          const input = parseMessageTemplate({ name, category, channel, subject: channel === "sms" ? null : subject, body, is_active, ...(id ? { revision } : {}) }, !!id);
          await readJson(`/api/admin/communication-templates${id ? `/${id}` : ""}`, { method: id ? "PATCH" : "POST", body: JSON.stringify(input) });
          setTemplates(await load()); setEditor(null); setNotice("Template saved. No messages were generated.");
        } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to save template."); }
        finally { setBusy(false); }
      })();
    }}>
      <fieldset disabled={busy || !canManage} className="space-y-3">
        <label className="block text-sm">Template Name<input className={control} maxLength={200} required value={editor.name} onChange={(event) => setEditor({ ...editor, name: event.target.value })} /></label>
        <div><label className="block text-sm" htmlFor="template-category">Category</label><select id="template-category" className={control} value={editor.category} onChange={(event) => setEditor({ ...editor, category: event.target.value as MessageTemplateInput["category"] })}>{TEMPLATE_CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select></div>
        <div><label className="block text-sm" htmlFor="template-channel">Channel</label><select id="template-channel" className={control} value={editor.channel} onChange={(event) => setEditor({ ...editor, channel: event.target.value === "sms" ? "sms" : "email", subject: event.target.value === "sms" ? null : "" })}><option value="email">Email</option><option value="sms">SMS</option></select></div>
        {editor.channel === "email" ? <label className="block text-sm">Template Subject<input className={control} maxLength={1000} value={editor.subject ?? ""} onChange={(event) => setEditor({ ...editor, subject: event.target.value })} /></label> : null}
        <label className="block text-sm" htmlFor="template-body">Template Body</label>
        <textarea id="template-body" className={`${control} min-h-40`} maxLength={100000} required value={editor.body} onChange={(event) => setEditor({ ...editor, body: event.target.value })} />
        <label className="flex gap-2 text-sm"><input type="checkbox" checked={editor.is_active} onChange={(event) => setEditor({ ...editor, is_active: event.target.checked })} />Active</label>
      </fieldset>
      <p className="text-xs text-slate-500">Merge fields: {MERGE_FIELDS.map((field) => `{{${field}}}`).join(", ")}. Contacts store one full name; separate first/last names are unavailable and are not guessed. Missing context remains visibly unresolved.</p>
      <div className="flex gap-2"><button className={button} disabled={busy} type="submit">Save Template</button><button type="button" className={button} disabled={busy} onClick={() => setEditor(null)}>Cancel</button></div>
    </form> : null}
    <button type="button" className={button} disabled={busy} onClick={() => {
      setError(""); void load().then(setTemplates).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Unable to reload templates."));
    }}>Reload Templates</button>
  </section>;
}
