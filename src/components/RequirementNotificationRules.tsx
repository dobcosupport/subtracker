"use client";

import { useCallback, useEffect, useState } from "react";
import { useSessionProfile } from "@/components/SessionContext";
import { canAccessModule } from "@/lib/permissions";
import { readJson } from "@/lib/communication-compose-client";
import { automationTemplateReady, parseRequirementRule } from "@/lib/requirement-notifications";
import type { RequirementNotificationConfiguration, RequirementRule } from "@/types/requirement-notifications";
import RequirementNoticePreview from "@/components/RequirementNoticePreview";

const button = "rounded border border-slate-300 px-2 py-1 text-sm disabled:opacity-50";
export default function RequirementNotificationRules() {
  const profile = useSessionProfile();
  const manage = profile.system_administrator || canAccessModule(profile.permissions, "settings", "manage");
  const approve = profile.system_administrator || (profile.role === "Administrator" && manage);
  const [data, setData] = useState<RequirementNotificationConfiguration | null>(null);
  const [editor, setEditor] = useState<RequirementRule | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => setData(await readJson<RequirementNotificationConfiguration>("/api/admin/notifications/requirements")), []);
  useEffect(() => {
    let active = true;
    void readJson<RequirementNotificationConfiguration>("/api/admin/notifications/requirements")
      .then(result => { if (active) setData(result); })
      .catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : "Unable to load requirement rules."); });
    return () => { active = false; };
  }, []);
  async function act(action: () => Promise<void>, success: string) {
    setBusy(true); setError(""); setNotice("");
    try { await action(); await load(); setNotice(success); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to save configuration."); }
    finally { setBusy(false); }
  }
  return <section aria-label="Requirement notification rules" className="space-y-3">
    <h3 className="font-semibold">Requirement Notification Rules</h3>
    <p className="text-sm text-slate-500">Configuration only. No scheduler or email runs. Non-expiring requirements do not use expiration dates or intervals. Manual emails never require a template.</p>
    {error ? <p role="alert" className="text-red-700">{error}</p> : null}
    {notice ? <p role="status">{notice}</p> : null}
    {!data ? <p role="status">Loading requirement rules...</p> : <>
      <RequirementNoticePreview rules={data.rules} />
      <ul className="divide-y rounded border">{data.rules.map(rule => <li key={rule.id ?? `${rule.compliance_type_id}:${rule.insurance_item_key}`} className="p-3 text-sm">
        <span className="font-medium">{rule.name}</span> — {rule.schedule_type === "expiration" ? "Expiration Based" : "Non-Expiring"} — {rule.retired ? "Retired / inactive" : rule.configuration_ready ? "Configuration ready (not executing; master controls apply)" : rule.automatic_enabled ? "Not ready: requirement or template approval changed" : "Automatic notices disabled"}
        {manage && !rule.retired ? <button className={`${button} ml-3`} disabled={busy || !!editor} onClick={() => { setEditor(structuredClone(rule)); setError(""); }}>Configure {rule.name}</button> : null}
      </li>)}</ul>
      {editor ? <form aria-label="Requirement rule editor" className="space-y-3 rounded border p-3" onSubmit={event => {
        event.preventDefault();
        const { id, name, compliance_type_id, insurance_item_key, automatic_enabled, schedule_type, sender_contact_id, internal_contact_id, revision, intervals, eligibility_authority } = editor;
        const fields = { compliance_type_id, insurance_item_key, automatic_enabled, schedule_type, sender_contact_id, internal_contact_id, revision, intervals, eligibility_authority };
        void act(async () => { const input = parseRequirementRule(fields); await readJson("/api/admin/notifications/requirements", { method: "POST", body: JSON.stringify({ id, ...input }) }); setEditor(null); }, `${name} configuration saved. No notice was sent.`);
      }}>
        <h4 className="font-semibold">{editor.name}</h4>
        <label className="block">Eligibility Authority <select value={editor.eligibility_authority} disabled={busy} onChange={event => setEditor({ ...editor, eligibility_authority: event.target.value === "nj_pwc_monitoring" ? "nj_pwc_monitoring" : "current_requirement" })}>
          <option value="current_requirement">Current requirement</option><option value="nj_pwc_monitoring">NJ PWC Monitoring</option>
        </select></label>
        <label className="block">Schedule type <select value={editor.schedule_type} disabled={busy} onChange={event => {
          const schedule_type = event.target.value === "expiration" ? "expiration" : "non_expiring";
          setEditor({ ...editor, schedule_type, ...(schedule_type === "non_expiring" ? { automatic_enabled: false, intervals: [] } : {}) });
        }}><option value="expiration" disabled={!editor.expiration_allowed}>Expiration Based</option><option value="non_expiring">Non-Expiring</option></select></label>
        {editor.schedule_type === "expiration" ? <>
          <label className="block"><input type="checkbox" checked={editor.automatic_enabled} disabled={busy} onChange={event => setEditor({ ...editor, automatic_enabled: event.target.checked })} /> Automatic Notices Enabled</label>
          {editor.intervals.map((interval, index) => <fieldset key={index} className="flex flex-wrap gap-2">
            <label>Days before expiration <input type="number" min="1" max="36500" value={interval.days_before_expiration} onChange={event => setEditor({ ...editor, intervals: editor.intervals.map((entry, i) => i === index ? { ...entry, days_before_expiration: Number(event.target.value) } : entry) })} /></label>
            <label><input type="checkbox" checked={interval.enabled} onChange={event => setEditor({ ...editor, intervals: editor.intervals.map((entry, i) => i === index ? { ...entry, enabled: event.target.checked } : entry) })} /> Enabled</label>
            <label>Approved template <select value={interval.template_id ?? ""} onChange={event => setEditor({ ...editor, intervals: editor.intervals.map((entry, i) => i === index ? { ...entry, template_id: event.target.value || null } : entry) })}>
              <option value="">Select template</option>{data.templates.filter(template => template.channel === "email").map(template => <option key={template.id} value={template.id}>{template.name} (revision {template.revision}{automationTemplateReady(template) ? ", approved" : ", not approved/current"})</option>)}</select></label>
            <button type="button" className={button} onClick={() => setEditor({ ...editor, intervals: editor.intervals.filter((_, i) => i !== index) })}>Remove interval</button>
          </fieldset>)}
          <button type="button" className={button} disabled={editor.intervals.length >= 100} onClick={() => setEditor({ ...editor, intervals: [...editor.intervals, { days_before_expiration: 1, enabled: false, template_id: null }] })}>Add interval</button>
        </> : <p>No expiration intervals or expiration notice automation apply.</p>}
        {(["sender_contact_id", "internal_contact_id"] as const).map(key => <label key={key} className="block">{key === "sender_contact_id" ? "Future sender contact" : "Future internal notification contact"} <select value={editor[key] ?? ""} onChange={event => setEditor({ ...editor, [key]: event.target.value || null })}><option value="">None</option>{data.contacts.filter(contact => contact.is_active || contact.id === editor[key]).map(contact => <option key={contact.id} value={contact.id}>{contact.contact_name}{contact.is_active ? "" : " (Inactive)"}</option>)}</select></label>)}
        <div className="flex gap-2"><button className={button} disabled={busy}>Save rule</button><button type="button" className={button} disabled={busy} onClick={() => setEditor(null)}>Cancel</button></div>
      </form> : null}
      <section aria-label="Template automation approvals" className="space-y-2">
        <h3 className="font-semibold">Template Automation Approval</h3>
        <p className="text-sm">Approval applies only to the current revision. Editing a template requires reapproval; manual messages are unaffected.</p>
        <ul className="divide-y rounded border">{data.templates.filter(template => template.channel === "email").map(template => <li key={template.id} className="p-3 text-sm">
          {template.name} — revision {template.revision} — {automationTemplateReady(template) ? `Approved ${template.approved_at} by ${template.approved_by}` : template.is_active ? "Not approved" : "Inactive"}
          <details><summary>Review template revision {template.revision}</summary><p>Subject: {template.subject || "(none)"}</p><p className="whitespace-pre-wrap">{template.body}</p></details>
          {approve && template.is_active && !automationTemplateReady(template) ? <button className={`${button} ml-3`} disabled={busy} onClick={() => {
            if (!window.confirm(`Approve ${template.name} revision ${template.revision} for future automation?`)) return;
            void act(async () => { await readJson(`/api/admin/communication-templates/${template.id}/approve-automation`, { method: "POST", body: JSON.stringify({ revision: template.revision }) }); }, "Template revision approved. No notice was sent.");
          }}>Approve {template.name} revision {template.revision}</button> : null}
        </li>)}</ul>
      </section>
    </>}
  </section>;
}
