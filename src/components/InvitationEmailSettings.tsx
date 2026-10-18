"use client";

import { useEffect, useState } from "react";
import { adminFetch } from "@/lib/admin-client";
import { useSessionProfile } from "@/components/SessionContext";
import { canAccessModule } from "@/lib/permissions";
import { invitationDeliveryPlan, invitationTemplateFields } from "@/lib/invitation-email";
import type { InvitationEmailSettingsInput } from "@/types/invitation-email";

const fields = [
  ["organization_name", "Organization Name"],
  ["application_name", "Application Name"],
  ["subject", "Invitation Subject"],
  ["application_base_url", "Application Base URL"],
  ["invitation_path", "Invitation Path"],
  ["template_reference", "Invitation Template Reference"],
  ["sender_reference", "Invitation Sender Reference"],
  ["reply_to_reference", "Invitation Reply-To Reference"],
] as const;

export default function InvitationEmailSettings() {
  const { permissions } = useSessionProfile();
  const canManage = canAccessModule(permissions, "settings", "manage");
  const [form, setForm] = useState<InvitationEmailSettingsInput | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const response = await adminFetch("/api/admin/invitation-email-settings");
        const result = await response.json() as { settings?: InvitationEmailSettingsInput; error?: string };
        if (!response.ok || !result.settings) throw new Error(result.error ?? "Unable to load invitation email settings.");
        if (active) setForm(result.settings);
      } catch (reason) { if (active) setError(reason instanceof Error ? reason.message : "Unable to load invitation email settings."); }
    })();
    return () => { active = false; };
  }, []);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!canManage || !form) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await adminFetch("/api/admin/invitation-email-settings", { method: "PATCH", body: JSON.stringify(form) });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Unable to save invitation email settings.");
      const reload = await adminFetch("/api/admin/invitation-email-settings");
      const persisted = await reload.json() as { settings?: InvitationEmailSettingsInput; error?: string };
      if (!reload.ok || !persisted.settings) throw new Error(persisted.error ?? "Saved invitation settings could not be reloaded.");
      setForm(persisted.settings);
      setNotice("Invitation configuration saved. Existing Supabase Auth invitation behavior is unchanged.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to save invitation email settings."); }
    finally { setBusy(false); }
  }

  return <section aria-label="User Management Email" className="space-y-3 rounded border border-slate-200 p-4 text-sm">
    <h3 className="text-xs font-semibold uppercase text-slate-500">User Management Email</h3>
    <p>Configuration foundation only. The active Send Invitation and Re-Invite actions still use Supabase Auth, regardless of the mode or enablement saved here. Step 5 does not change authentication or delivery.</p>
    <p>No secrets, tokens, or credential values belong in these fields. Sender, Reply-To, and template references identify non-sensitive future configuration only.</p>
    {error ? <p role="alert" className="text-red-700">{error}</p> : null}
    {notice ? <p role="status" className="text-green-700">{notice}</p> : null}
    {!form && !error ? <p>Loading invitation email settings...</p> : null}
    {form ? <form onSubmit={(event) => void save(event)} className="space-y-3">
      <fieldset disabled={!canManage || busy} className="space-y-3">
        <label className="flex items-center gap-2"><input type="checkbox" checked={form.enabled} onChange={(event) => setForm({ ...form, enabled: event.target.checked })} />Invitation Email Enabled</label>
        <div>
          <label htmlFor="invitation-delivery-mode" className="font-medium">Invitation Delivery Mode</label>
          <select id="invitation-delivery-mode" className="mt-1 block w-full rounded border border-slate-300 px-2 py-1" value={form.delivery_mode}
            onChange={(event) => setForm({ ...form, delivery_mode: event.target.value === "application_email_provider" ? "application_email_provider" : "supabase_auth" })}>
            <option value="supabase_auth">Supabase Auth</option>
            <option value="application_email_provider">Application Email Provider</option>
          </select>
        </div>
        <p>Configured Adapter Status: <strong>{invitationDeliveryPlan(form).connector_status}</strong></p>
        {form.delivery_mode === "supabase_auth" ? <div className="space-y-1 text-slate-600">
          <p>Supabase Auth controls current sender/from, Reply-To behavior, SMTP/provider credentials, sending domain, and deployed subject/body template. The main Email provider settings do not override Supabase.</p>
          <p>The current redirect uses the server deployment APP_URL with /invite. Supabase Site URL and allowed redirect URLs remain externally configured.</p>
        </div> : <div className="space-y-1 text-slate-600">
          <p>Connector Not Implemented. Future delivery will use the provider configured in the main Email settings above, through an Application Email Adapter.</p>
          <p>Saving this mode does not activate sending, reroute invitations, generate tokens, render templates, or replace authentication.</p>
        </div>}
        <div className="grid gap-3 sm:grid-cols-2">
          {fields.map(([key, label]) => <label key={key} className="font-medium">{label}
            <input type={key === "application_base_url" ? "url" : "text"} maxLength={key === "application_base_url" ? 2048 : 500}
              className="mt-1 block w-full rounded border border-slate-300 px-2 py-1 font-normal disabled:bg-slate-50"
              value={form[key] ?? ""} onChange={(event) => setForm({ ...form, [key]: event.target.value })} />
          </label>)}
        </div>
        <p className="text-xs text-slate-500">Application Base URL is an HTTP/HTTPS origin; Invitation Path is a local absolute path. These are future values, not overrides for the live APP_URL redirect.</p>
        <div>
          <label htmlFor="invitation-template-draft" className="block font-medium">Invitation Template Draft</label>
          <textarea id="invitation-template-draft" rows={5} maxLength={10000} className="mt-1 block w-full rounded border border-slate-300 px-2 py-1 font-normal disabled:bg-slate-50"
            value={form.template_content ?? ""} onChange={(event) => setForm({ ...form, template_content: event.target.value })} />
        </div>
        <p className="text-xs text-slate-500">Future field convention: {invitationTemplateFields.map((field) => `{{${field}}}`).join(", ")}. Draft text is stored only; no template engine, preview, URL generation, or output sending is implemented.</p>
      </fieldset>
      {canManage ? <div className="text-xs"><button type="submit" disabled={busy} className="rounded border border-slate-300 bg-slate-900 px-2 py-0.5 font-medium text-white disabled:opacity-50">{busy ? "Saving..." : "Save Invitation Configuration"}</button></div>
        : <p className="text-xs text-slate-500">View only. Settings Manage is required to change invitation configuration.</p>}
    </form> : null}
    <p className="text-xs text-slate-500">Existing installation branding in the deployed Supabase invitation template and invitation landing page remains unchanged. Accounts, invitations, authentication, roles, permissions, and status remain in User Management.</p>
  </section>;
}
