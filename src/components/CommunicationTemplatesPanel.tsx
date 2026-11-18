"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSessionProfile } from "@/components/SessionContext";
import { canAccessModule } from "@/lib/permissions";
import { readJson } from "@/lib/communication-compose-client";
import { INSERTABLE_MERGE_FIELDS, MERGE_FIELDS, MERGE_FIELD_LABELS, parseMessageTemplate, type MergeField } from "@/lib/communication-templates";
import { TEMPLATE_CATEGORIES, TEMPLATE_OPERATION_DEFAULTS, type MessageTemplate, type MessageTemplateInput } from "@/types/communication-compose";
import EmailRichTextEditor from "@/components/EmailRichTextEditor";
import { EMAIL_IMPORTANCES, EMAIL_IMPORTANCE_LABELS } from "@/types/communications";

const button = "rounded border border-slate-300 px-2 py-1 text-sm disabled:opacity-50";
const control = "block w-full rounded border border-slate-300 px-2 py-1 text-sm";
const empty: MessageTemplateInput = { name: "", category: "General Contractor Communication", channel: "email", subject: "", body: "", is_active: false, ...TEMPLATE_OPERATION_DEFAULTS };
export default function CommunicationTemplatesPanel() {
  const { permissions } = useSessionProfile();
  const canManage = canAccessModule(permissions, "settings", "manage");
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [editor, setEditor] = useState<(MessageTemplateInput & { id?: string; revision?: number }) | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const subjectInput = useRef<HTMLInputElement>(null);
  const bodyInput = useRef<HTMLTextAreaElement>(null);
  const followupInput = useRef<HTMLInputElement>(null);
  const insertField = (field: MergeField, target: "subject" | "body" | "followup_subject") => {
    if (!editor) return;
    const element = target === "subject" ? subjectInput.current : target === "body" ? bodyInput.current : followupInput.current;
    const text = editor[target] ?? "";
    const start = element?.selectionStart ?? text.length;
    const end = element?.selectionEnd ?? start;
    const token = `{{${field}}}`;
    const value = text.slice(0, start) + token + text.slice(end);
    if (value.length > (target === "subject" ? 1000 : target === "body" ? 100000 : 200)) {
      setError(`Template ${target} is too long to insert this field.`);
      return;
    }
    setEditor({ ...editor, [target]: value });
    requestAnimationFrame(() => { element?.focus(); element?.setSelectionRange(start + token.length, start + token.length); });
  };
  const fieldControl = (target: "subject" | "body" | "followup_subject") => <select className={button} aria-label={`Insert field into template ${target}`} value="" onChange={(event) => {
    const field = MERGE_FIELDS.find(field => field === event.target.value);
    if (field) insertField(field, target);
  }}>
    <option value="" disabled>Insert Field ▾</option>
    {INSERTABLE_MERGE_FIELDS.map(field =>
      <option key={field} value={field}>{MERGE_FIELD_LABELS[field]}</option>)}
  </select>;
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
    <p className="text-sm text-slate-500">Installation-configurable message templates. Deactivate to preserve references and history. No templates execute or send automatically.</p>
    {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : null}
    {notice ? <p role="status" className="text-sm text-green-700">{notice}</p> : null}
    <ul className="divide-y rounded border border-slate-200">{templates.map((template) => <li key={template.id} className="flex items-center justify-between gap-3 p-3 text-sm">
      <span>{template.name} · {template.channel} · {template.category} · {template.is_active ? "Active" : "Inactive"}</span>
      {canManage ? <button className={button} disabled={busy || !!editor} onClick={() => { setEditor({ ...TEMPLATE_OPERATION_DEFAULTS, ...template }); setError(""); setNotice(""); }}>Edit</button> : null}
    </li>)}</ul>
    {!templates.length ? <p className="text-sm">No templates configured.</p> : null}
    {editor ? <form className="space-y-3 rounded border p-4" aria-label="Template editor" onSubmit={(event) => {
      event.preventDefault();
      if (!canManage) return;
      setBusy(true); setError(""); setNotice("");
      void (async () => {
        try {
          const { id, revision, name, category, channel, subject, body, is_active, purpose, default_importance, followup_enabled,
            followup_status, followup_delay_days, followup_subject, followup_related_item } = editor;
          const input = parseMessageTemplate({ name, category, channel, subject: channel === "sms" ? null : subject, body, is_active,
            purpose, default_importance, followup_enabled, followup_status, followup_delay_days, followup_subject, followup_related_item, ...(id ? { revision } : {}) }, !!id);
          await readJson(`/api/admin/communication-templates${id ? `/${id}` : ""}`, { method: id ? "PATCH" : "POST", body: JSON.stringify(input) });
          setTemplates(await load()); setEditor(null); setNotice("Template saved. No messages were generated.");
        } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to save template."); }
        finally { setBusy(false); }
      })();
    }}>
      <fieldset disabled={busy || !canManage} className="space-y-3">
        <label className="block text-sm">Template Name<input className={control} maxLength={200} required value={editor.name} onChange={(event) => setEditor({ ...editor, name: event.target.value })} /></label>
        <label className="block text-sm">Reminder Stage / Purpose<input className={control} maxLength={200} value={editor.purpose ?? ""} placeholder="Optional description, e.g. 45 Day renewal notice" onChange={event => setEditor({ ...editor, purpose: event.target.value })} /></label>
        <div><label className="block text-sm" htmlFor="template-category">Category</label><select id="template-category" className={control} value={editor.category} onChange={(event) => setEditor({ ...editor, category: event.target.value as MessageTemplateInput["category"] })}>{TEMPLATE_CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select></div>
        <div><label className="block text-sm" htmlFor="template-channel">Channel</label><select id="template-channel" className={control} value={editor.channel} onChange={(event) => setEditor({ ...editor, channel: event.target.value === "sms" ? "sms" : "email", subject: event.target.value === "sms" ? null : "" })}><option value="email">Email</option><option value="sms">SMS</option></select></div>
        {editor.channel === "email" ? <div>
          <label className="block text-sm">Default Importance<select className={control} value={editor.default_importance ?? "normal"} onChange={event => {
            const value = EMAIL_IMPORTANCES.find(value => value === event.target.value);
            if (value) setEditor({ ...editor, default_importance: value });
          }}>{EMAIL_IMPORTANCES.map(value => <option key={value} value={value}>{EMAIL_IMPORTANCE_LABELS[value]}</option>)}</select></label>
          <div className="mb-1 flex items-center justify-between gap-2"><label className="text-sm" htmlFor="template-subject">Template Subject</label>{fieldControl("subject")}</div>
          <input ref={subjectInput} id="template-subject" className={control} maxLength={1000} value={editor.subject ?? ""} onChange={(event) => setEditor({ ...editor, subject: event.target.value })} />
        </div> : null}
        {editor.channel === "email" ? <EmailRichTextEditor id="template-body" label="Template Body" value={editor.body}
          onChange={body => setEditor({ ...editor, body })} /> : <div>
          <div className="mb-1 flex items-center justify-between gap-2"><label className="text-sm" htmlFor="template-body">Template Body</label>{fieldControl("body")}</div>
          <textarea ref={bodyInput} id="template-body" className={`${control} min-h-40`} maxLength={100000} required value={editor.body}
            onChange={event => setEditor({ ...editor, body: event.target.value })} />
        </div>}
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={editor.followup_enabled ?? false}
          disabled={editor.channel !== "email"} onChange={event => setEditor({ ...editor, followup_enabled: event.target.checked })} />
          Default Create Follow-Up after successful send</label>
        {editor.followup_enabled ? <fieldset className="space-y-3 rounded border border-blue-200 bg-blue-50/40 p-3" aria-label="Template Follow-Up settings">
          <legend className="px-1 text-sm font-semibold">Editable New Message defaults</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm">Follow-Up Status<select aria-label="Follow-Up Status" className={control} value={editor.followup_status} onChange={event => {
              const status = (["Open", "Waiting Response", "Resolved", "Closed"] as const).find(status => status === event.target.value);
              if (status) setEditor({ ...editor, followup_status: status });
            }}>{["Open", "Waiting Response", "Resolved", "Closed"].map(status => <option key={status}>{status}</option>)}</select></label>
            <label className="text-sm">Follow-Up delay in days<input aria-label="Follow-Up delay in days" className={control} type="number" min={0} max={36500} required value={editor.followup_delay_days}
              onChange={event => setEditor({ ...editor, followup_delay_days: event.target.valueAsNumber })} /></label>
          </div>
          <div><div className="mb-1 flex items-center justify-between gap-2"><label className="text-sm" htmlFor="template-followup-subject">Follow-Up Subject</label>{fieldControl("followup_subject")}</div>
            <input ref={followupInput} id="template-followup-subject" className={control} maxLength={200} required value={editor.followup_subject}
              onChange={event => setEditor({ ...editor, followup_subject: event.target.value })} /></div>
          <p className="text-sm">Related Item comes from New Message: the exact selected Compliance Record, otherwise the selected Contractor. No Compliance Record is inferred.</p>
          <p className="text-xs text-slate-600">These are defaults, not mandatory actions. The user can change or uncheck Create Follow-Up in New Message before sending or scheduling. Relative dates use the actual acceptance date in America/New_York. Drafting, scheduling, activation and failed delivery create no Follow-Up. Reviewed messages retain their snapshotted settings.</p>
        </fieldset> : null}
        <label className="flex gap-2 text-sm"><input type="checkbox" checked={editor.is_active} onChange={(event) => setEditor({ ...editor, is_active: event.target.checked })} />Active</label>
      </fieldset>
      <p className="text-xs text-slate-500">Use Insert Field in Subject, Body or Follow-Up Subject, then Preview in New Message with a selected contractor and exact compliance record. Square-bracket placeholders are not supported. Contacts store one full name; a separate first name is unavailable. Unresolved fields block sending and scheduling. Active does not authorize automatic sending; existing notification intervals and approvals still control it.</p>
      <div className="flex gap-2"><button className={button} disabled={busy} type="submit">Save Template</button><button type="button" className={button} disabled={busy} onClick={() => setEditor(null)}>Cancel</button></div>
    </form> : null}
    <button type="button" className={button} disabled={busy} onClick={() => {
      setError(""); void load().then(setTemplates).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Unable to reload templates."));
    }}>Reload Templates</button>
  </section>;
}
