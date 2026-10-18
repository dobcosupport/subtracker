"use client";

import { useCallback, useEffect, useState } from "react";
import { adminFetch } from "@/lib/admin-client";
import { canAccessModule } from "@/lib/permissions";
import { useSessionProfile } from "@/components/SessionContext";
import { reminderChannelConfigured, reminderIsActive } from "@/lib/notifications";
import type { NotificationAutomation, NotificationsConfiguration, ReminderRule } from "@/types/notifications";
import type { MessageTemplate } from "@/types/communication-compose";
import { readJson } from "@/lib/communication-compose-client";

const button = "rounded border border-slate-300 px-2 py-0.5 font-medium disabled:cursor-not-allowed disabled:opacity-50";
type Editor = { rule: ReminderRule | null; days: string; email: boolean; sms: boolean; template: string; emailTemplate: string; smsTemplate: string };

export default function NotificationsPanel() {
  const { permissions } = useSessionProfile();
  const canManage = canAccessModule(permissions, "settings", "manage");
  const [configuration, setConfiguration] = useState<NotificationsConfiguration | null>(null);
  const [automation, setAutomation] = useState<NotificationAutomation | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [removing, setRemoving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const load = useCallback(async () => {
    const response = await adminFetch("/api/admin/notifications");
    const result = await response.json() as NotificationsConfiguration & { error?: string };
    if (!response.ok || !result.automation || !result.rules) throw new Error(result.error ?? "Unable to load notification configuration.");
    return result;
  }, []);
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const result = await load();
        if (active) { setConfiguration(result); setAutomation(result.automation); setError(""); }
      } catch (reason) { if (active) setError(reason instanceof Error ? reason.message : "Unable to load notification configuration."); }
      finally { if (active) setLoading(false); }
    })();
    return () => { active = false; };
  }, [load]);

  async function mutate(url: string, method: string, input: unknown, message: string) {
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await adminFetch(url, { method, body: JSON.stringify(input) });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Unable to save notification configuration.");
      const persisted = await load();
      setConfiguration(persisted); setAutomation(persisted.automation); setEditor(null); setRemoving(false); setNotice(message);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to save notification configuration."); }
    finally { setBusy(false); }
  }
  function open(rule: ReminderRule | null) {
    setEditor({ rule, days: rule ? String(rule.days_before_expiration) : "", email: rule?.email_enabled ?? false, sms: rule?.sms_enabled ?? false, template: rule?.template_reference ?? "", emailTemplate: rule?.email_template_id ?? "", smsTemplate: rule?.sms_template_id ?? "" });
    setRemoving(false); setError(""); setNotice("");
    void (async () => {
      try {
        const rows: MessageTemplate[] = [];
        let offset: number | null = 0;
        do {
          const page: { templates: MessageTemplate[]; next_offset: number | null } = await readJson(`/api/admin/communication-templates?offset=${offset}`);
          rows.push(...page.templates); offset = page.next_offset;
          if (rows.length > 10000) throw new Error("Too many templates to display.");
        } while (offset !== null);
        setTemplates(rows);
      } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to load reminder templates."); }
    })();
  }
  function saveRule(event: React.FormEvent) {
    event.preventDefault();
    if (!editor || !canManage) return;
    if (!/^[1-9]\d*$/.test(editor.days) || Number(editor.days) > 2147483647) { setError("Days Before Expiration must be a positive integer (maximum 2147483647)."); return; }
    const id = editor.rule?.id;
    void mutate(`/api/admin/notifications/reminders${id ? `/${id}` : ""}`, id ? "PATCH" : "POST", {
      days_before_expiration: Number(editor.days), email_enabled: editor.email, sms_enabled: editor.sms,
      template_reference: editor.template.trim() || null, ...(editor.rule ? { revision: editor.rule.revision } : {}),
      email_template_id: editor.emailTemplate || null, sms_template_id: editor.smsTemplate || null,
    }, "Reminder configuration saved. No messages were generated.");
  }
  return <section aria-label="Notification configuration" className="space-y-5">
    <header>
      <h2 className="text-lg font-semibold">Compliance Notifications</h2>
      <p className="mt-1 text-sm text-slate-500">Configuration only. No expiration scanning, message generation, queueing, sending, or reminder worker runs.</p>
    </header>
    {loading ? <p role="status" className="text-sm">Loading notification configuration...</p> : null}
    {error ? <p role="alert" className="text-sm text-red-700">{error} Reload configuration before retrying a failed save.</p> : null}
    {notice ? <p role="status" className="text-sm text-green-700">{notice}</p> : null}
    {configuration && automation ? <>
      <form className="space-y-3 rounded border border-slate-200 p-4" onSubmit={(event) => {
        event.preventDefault();
        if (canManage) void mutate("/api/admin/notifications", "PATCH", automation, "Master automation configuration saved. Delivery remains unavailable.");
      }}>
        <h3 className="font-semibold">Master Automation Controls</h3>
        <p className="text-xs text-slate-500">Shared with Automated Email/SMS Enabled in the Email and Text Messaging tabs. OFF blocks that channel regardless of reminder selections. These switches record intent only.</p>
        <fieldset disabled={!canManage || busy || editor !== null} className="flex flex-wrap gap-4">
          {(["email", "sms"] as const).map((channel) => <label key={channel} className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={automation[channel].automated_enabled} onChange={(event) => setAutomation({ ...automation, [channel]: { ...automation[channel], automated_enabled: event.target.checked } })} />
            Automated {channel === "email" ? "Email" : "SMS"}
          </label>)}
        </fieldset>
        {canManage ? <div className="text-xs"><button className={button} type="submit" disabled={busy || editor !== null}>Save Automation Controls</button></div> : null}
      </form>
      <section className="space-y-2" aria-label="Reminder rules">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold">Expiration Reminders</h3>
          {canManage ? <div className="text-xs"><button type="button" aria-label="Add Reminder" className={`${button} text-base`} disabled={busy || editor !== null} onClick={() => open(null)}>+</button></div> : null}
        </div>
        <p className="text-xs text-slate-500">Neither channel selected = Inactive. Selecting a channel makes configuration Active, not operational. Clear both channels to deactivate without removing the rule.</p>
        <ul aria-label="Reminder list" className="divide-y divide-slate-200 rounded border border-slate-200">
          {configuration.rules.map((rule) => <li key={rule.id} className="flex items-start justify-between gap-3 px-3 py-2">
            <div className="text-sm">
              <span className="font-medium">{rule.days_before_expiration} Days Before Expiration</span>
              <span className={`ml-3 text-xs ${reminderIsActive(rule) ? "text-emerald-700" : "text-slate-500"}`}>{reminderIsActive(rule) ? "Active" : "Inactive"}</span>
              {reminderIsActive(rule) ? <p className="mt-1 text-xs text-slate-500">
                {(["email", "sms"] as const).filter((channel) => channel === "email" ? rule.email_enabled : rule.sms_enabled).map((channel) =>
                  `${channel === "email" ? "Email" : "SMS"}: ${reminderChannelConfigured(rule, configuration.automation, channel) ? "configured; connector unavailable" : "blocked by master OFF"}`).join("; ")}
              </p> : null}
            </div>
            {canManage ? <div className="text-xs"><button type="button" className={button} disabled={busy || editor !== null} onClick={() => open(rule)}>Edit</button></div> : null}
          </li>)}
        </ul>
        {!configuration.rules.length ? <p className="text-sm text-slate-500">No reminder rules configured.</p> : null}
      </section>
      {editor ? <section role="dialog" aria-modal="false" aria-label={editor.rule ? "Edit Reminder" : "Add Reminder"} className="space-y-3 rounded border border-slate-300 bg-slate-50 p-4">
        <h3 className="font-semibold">{editor.rule ? "Edit Reminder" : "Add Reminder"}</h3>
        <form onSubmit={saveRule} className="space-y-3">
          <fieldset disabled={busy || !canManage} className="space-y-3">
            <label className="block text-sm font-medium">Days Before Expiration
              <input type="number" min={1} max={2147483647} step={1} required value={editor.days} onChange={(event) => setEditor({ ...editor, days: event.target.value })}
                className="mt-1 block w-full rounded border border-slate-300 px-2 py-1" />
            </label>
            <div className="flex gap-4 text-sm">
              <label className="flex items-center gap-2"><input type="checkbox" checked={editor.email} onChange={(event) => setEditor({ ...editor, email: event.target.checked })} />Email</label>
              <label className="flex items-center gap-2"><input type="checkbox" checked={editor.sms} onChange={(event) => setEditor({ ...editor, sms: event.target.checked })} />SMS</label>
            </div>
            <p className="text-xs">Status: {editor.email || editor.sms ? "Active" : "Inactive"} (derived from channels)</p>
            <label className="block text-sm font-medium">Template Reference (optional)
              <input maxLength={500} value={editor.template} onChange={(event) => setEditor({ ...editor, template: event.target.value })}
                className="mt-1 block w-full rounded border border-slate-300 px-2 py-1" />
            </label>
            {(["email", "sms"] as const).map((channel) => {
              const key = channel === "email" ? "emailTemplate" : "smsTemplate";
              return <div key={channel}><label htmlFor={`reminder-${channel}-template`} className="block text-sm">{channel === "email" ? "Email" : "SMS"} Template</label>
                <select id={`reminder-${channel}-template`} className="mt-1 block w-full rounded border border-slate-300 px-2 py-1" value={editor[key]} onChange={(event) => setEditor({ ...editor, [key]: event.target.value })}>
                  <option value="">No template selected</option>
                  {editor[key] && !templates.some((t) => t.id === editor[key]) ? <option value={editor[key]}>Referenced template unavailable ({editor[key]})</option> : null}
                  {templates.filter((t) => t.channel === channel && (t.is_active || t.id === editor[key])).map((t) => <option key={t.id} value={t.id}>{t.name}{!t.is_active ? " (Inactive)" : ""}</option>)}
                </select>
              </div>;
            })}
            <p className="text-xs text-slate-500">Channel-specific template references only. No reminder rendering, generation, or sending runs. Legacy free-text references are preserved separately.</p>
          </fieldset>
          <div className="flex flex-wrap gap-2 text-xs">
            <button className={`${button} bg-slate-900 text-white`} type="submit" disabled={busy || !canManage}>Save Reminder</button>
            {editor.rule && canManage ? <button className={`${button} text-red-700`} type="button" disabled={busy} onClick={() => setRemoving(true)}>Remove Reminder</button> : null}
            <button className={button} type="button" disabled={busy} onClick={() => { setEditor(null); setRemoving(false); }}>Cancel</button>
          </div>
        </form>
        {removing && editor.rule ? <div className="space-y-2 border-t border-slate-200 pt-3">
          <p className="text-sm">Remove this reminder configuration? Existing Communications and history will not be changed. Clear both channels instead to retain it as Inactive.</p>
          <div className="flex gap-2 text-xs">
            <button type="button" className={`${button} text-red-700`} disabled={busy || !canManage} onClick={() => {
              if (editor.rule) void mutate(`/api/admin/notifications/reminders/${editor.rule.id}`, "DELETE", { revision: editor.rule.revision }, "Reminder configuration removed. No history was changed.");
            }}>Confirm Remove</button>
            <button type="button" className={button} disabled={busy} onClick={() => setRemoving(false)}>Keep Reminder</button>
          </div>
        </div> : null}
      </section> : null}
      {!canManage ? <p className="text-xs text-slate-500">View only. Settings Manage is required to change Notifications.</p> : null}
      <p className="text-xs text-slate-500">Future execution must also verify an operational/enabled provider, recipient eligibility, SMS consent where applicable, and valid message data. No rule can execute in this foundation step.</p>
    </> : null}
    <div className="text-xs"><button type="button" className={button} disabled={busy || loading} onClick={() => {
      setLoading(true); setError(""); setNotice("");
      void load().then((result) => { setConfiguration(result); setAutomation(result.automation); setEditor(null); setRemoving(false); })
        .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Unable to reload notification configuration."))
        .finally(() => setLoading(false));
    }}>Reload Configuration</button></div>
  </section>;
}
