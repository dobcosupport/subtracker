"use client";

import { useEffect, useState } from "react";
import { adminFetch } from "@/lib/admin-client";
import { useSessionProfile } from "@/components/SessionContext";
import { canAccessModule } from "@/lib/permissions";
import InvitationEmailSettings from "@/components/InvitationEmailSettings";
import ProviderCredentialSettings from "@/components/ProviderCredentialSettings";
import MicrosoftEmailConnectionSettings from "@/components/MicrosoftEmailConnectionSettings";
import { SMS_VERIFICATION_STATUSES } from "@/types/communications";
import { smsVerificationLabels } from "@/lib/sms-provider";
import type { ChannelSettings, ChannelSettingsInput, CommunicationChannel } from "@/types/communications";

const control = "mt-1 block w-full rounded border border-slate-300 px-2 py-1 text-sm disabled:bg-slate-50";
const button = "rounded border border-slate-300 px-2 py-0.5 font-medium disabled:cursor-not-allowed disabled:opacity-50";
export default function CommunicationChannelSettings({ channel }: { channel: CommunicationChannel }) {
  const session = useSessionProfile();
  const canManage = canAccessModule(session.permissions, "settings", "manage");
  const [saved, setSaved] = useState<ChannelSettings | null>(null);
  const [form, setForm] = useState<ChannelSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const isEmail = channel === "email";
  const dirty = Boolean(form && saved && JSON.stringify(form) !== JSON.stringify(saved));
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const response = await adminFetch(`/api/admin/communication-settings/${channel}`);
        const result = await response.json() as { settings?: ChannelSettings; error?: string };
        if (!response.ok || !result.settings) throw new Error(result.error ?? "Unable to load channel settings.");
        if (active) { setSaved(result.settings); setForm(result.settings); }
      } catch (reason) {
        if (active) setError(reason instanceof Error ? reason.message : "Unable to load channel settings.");
      }
    })();
    return () => { active = false; };
  }, [channel]);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!form || !canManage) return;
    setBusy(true); setError(""); setNotice("");
    const input: ChannelSettingsInput = {
      provider: form.provider, enabled: form.enabled, automated_enabled: form.automated_enabled, revision: form.revision,
      ...(isEmail ? { from_name: form.from_name, from_address: form.from_address, reply_to_address: form.reply_to_address,
        ...(form.provider === "microsoft_365" ? { microsoft_tenant_id: form.microsoft_tenant_id, microsoft_client_id: form.microsoft_client_id } : { sending_domain: form.sending_domain }) }
        : { sending_phone_number: form.sending_phone_number, incoming_enabled: form.incoming_enabled, two_way_enabled: form.two_way_enabled,
          sms_verification_status: form.sms_verification_status ?? "not_recorded" }),
    };
    try {
      const response = await adminFetch(`/api/admin/communication-settings/${channel}`, { method: "PATCH", body: JSON.stringify(input) });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Unable to save channel settings.");
      const reload = await adminFetch(`/api/admin/communication-settings/${channel}`);
      const persisted = await reload.json() as { settings?: ChannelSettings; error?: string };
      if (!reload.ok || !persisted.settings) throw new Error(persisted.error ?? "Saved settings could not be reloaded.");
      setSaved(persisted.settings); setForm(persisted.settings);
      setNotice("Settings saved. No connection test, sending or automation has run.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to save channel settings."); }
    finally { setBusy(false); }
  }
  const stringField = (label: string, field: "from_name" | "from_address" | "reply_to_address" | "sending_domain" | "sending_phone_number" | "microsoft_tenant_id" | "microsoft_client_id") => (
    <label key={field} className="text-sm font-medium">{label}
      <input className={control} type={field.includes("address") ? "email" : "text"} maxLength={field === "sending_phone_number" ? 50 : 500}
        value={form?.[field] ?? ""} onChange={(event) => setForm((current) => current && ({ ...current, [field]: event.target.value,
          ...(field === "sending_phone_number" ? { sms_verification_status: "not_recorded" as const } : {}) }))} />
    </label>
  );
  const check = (label: string, field: "enabled" | "automated_enabled" | "incoming_enabled" | "two_way_enabled") => (
    <label key={field} className="flex items-center gap-2 text-sm">
      <input type="checkbox" checked={form?.[field] ?? false} onChange={(event) => setForm((current) => current && ({ ...current, [field]: event.target.checked }))} />{label}
    </label>
  );
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">{isEmail ? "Email" : "Text Messaging"} Configuration</h2>
      </div>
      <p className="text-sm text-slate-500">{isEmail
        ? "Email Enabled permits deliberate manual sends only after Microsoft 365 authentication and an administrator test Email are verified. Automated Email remains independently controlled."
        : "Installation-level settings. Enablement records configuration intent only; no delivery or automation runs."}</p>
      {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : null}
      {notice && !dirty ? <p role="status" className="text-sm text-green-700">{notice}</p> : null}
      {dirty ? <p className="text-sm font-medium text-amber-800">Unsaved Changes</p> : null}
      {!form && !error ? <p className="text-sm">Loading channel settings...</p> : null}
      {form ? <form onSubmit={(event) => void save(event)} className="space-y-4">
        <fieldset disabled={!canManage || busy} className="space-y-4">
          <legend className="text-xs font-semibold uppercase text-slate-500">Non-Secret Configuration</legend>
          <div className="text-sm font-medium">
            <label htmlFor={`communication-${channel}-provider`}>Provider</label>
            <select id={`communication-${channel}-provider`} className={control} value={form.provider ?? ""} onChange={(event) => setForm({ ...form, provider: event.target.value === "azure_communication_services" ? "azure_communication_services" : isEmail && event.target.value === "microsoft_365" ? "microsoft_365" : !isEmail && event.target.value === "twilio" ? "twilio" : null })}>
              <option value="">Not configured</option><option value="azure_communication_services">Azure Communication Services</option>
              {isEmail ? <option value="microsoft_365">Microsoft 365 / Office 365</option> : null}
              {!isEmail ? <option value="twilio">Twilio</option> : null}
            </select>
          </div>
          {form.provider === "azure_communication_services" || (isEmail && form.provider === "microsoft_365") ? <div className="space-y-4 rounded border border-slate-200 p-4">
            {!isEmail ? <div className="space-y-1">
              <p className="text-sm">Provider: Azure Communication Services</p>
              <p className="text-xs text-slate-500">Azure Communication Services SMS retires September 30, 2028.</p>
              <p className="text-xs text-slate-500">Twilio remains a future/alternative SMS provider; connectivity is not implemented.</p>
            </div> : null}
            <section className="space-y-2">
              <h3 className="text-xs font-semibold uppercase text-slate-500">General</h3>
              <div className="flex flex-wrap gap-4">
                {check(`${isEmail ? "Email" : "SMS"} Enabled`, "enabled")}
                {check(`Automated ${isEmail ? "Email" : "SMS"} Enabled`, "automated_enabled")}
              </div>
            </section>
            <section className="space-y-2 border-t border-slate-100 pt-3">
              <h3 className="text-xs font-semibold uppercase text-slate-500">Sender</h3>
              <div className="grid gap-3 sm:grid-cols-2">
                {isEmail ? [stringField("From Name", "from_name"), stringField(form.provider === "microsoft_365" ? "From Email Address" : "From Address", "from_address"), stringField("Reply-To Address", "reply_to_address"), ...(form.provider === "microsoft_365" ? [] : [stringField("Sending Domain", "sending_domain")])]
                  : stringField("SMS Sender Phone Number", "sending_phone_number")}
              </div>
              {!isEmail ? <div className="space-y-2">
                <label className="block text-sm font-medium" htmlFor="sms-verification-status">Toll-Free SMS Verification</label>
                <select id="sms-verification-status" className={control} value={form.sms_verification_status ?? "not_recorded"}
                  disabled={form.sending_phone_number !== saved?.sending_phone_number || !form.sending_phone_number}
                  onChange={(event) => {
                    const status = SMS_VERIFICATION_STATUSES.find((value) => value === event.target.value);
                    if (status) setForm({ ...form, sms_verification_status: status });
                  }}>
                  {SMS_VERIFICATION_STATUSES.map((status) => <option key={status} value={status}>{smsVerificationLabels[status]}</option>)}
                </select>
                <p className="text-xs text-slate-500">Administrator-recorded carrier status, not a live ACS check or verified connection. Save a changed sender first; changing it clears the recorded verification. Pending verification is not production-ready.</p>
              </div> : null}
            </section>
            {!isEmail ? <section className="space-y-2 border-t border-slate-100 pt-3">
              <h3 className="text-xs font-semibold uppercase text-slate-500">Messaging</h3>
              <div className="flex flex-wrap gap-4">{check("Incoming SMS Enabled", "incoming_enabled")}{check("Two-Way SMS Enabled", "two_way_enabled")}</div>
            </section> : null}
            {form.provider === "microsoft_365" ? <section className="space-y-2 border-t border-slate-100 pt-3">
              <h3 className="text-xs font-semibold uppercase text-slate-500">Microsoft 365 Application</h3>
              <div className="grid gap-3 sm:grid-cols-2">
                {stringField("Microsoft Entra Tenant ID", "microsoft_tenant_id")}
                {stringField("Application / Client ID", "microsoft_client_id")}
              </div>
            </section> : null}
          </div> : !isEmail && form.provider === "twilio" ? <section className="space-y-2 rounded border border-slate-200 p-4 text-sm" aria-label="Twilio configuration">
            <p>Provider: Twilio</p>
            <p>Connector Status: <strong>Not Implemented</strong></p>
            <p>Credential Status: <strong>Not Configured</strong></p>
            <p className="text-xs text-slate-500">Recognized future SMS provider only. Selecting Twilio does not enable sending. Existing non-sensitive SMS settings are preserved.</p>
            <div className="flex flex-wrap gap-2 text-xs">
              {["Replace Credential", "Test Connection", "Send Test SMS"].map((label) => <button key={label} type="button" className={button} disabled>{label}</button>)}
            </div>
          </section> : <p className="text-sm text-slate-500">Select a provider to display its configuration. Credential Status: Not Configured.</p>}
        </fieldset>
        {canManage ? <div className="text-xs"><button className={`${button} bg-slate-900 text-white`} disabled={busy} type="submit">{busy ? "Saving..." : "Save Settings"}</button></div> : <p className="text-xs text-slate-500">View only. Settings Manage is required to change configuration.</p>}
      </form> : null}
      {form?.provider === "azure_communication_services" || (isEmail && form?.provider === "microsoft_365") ? <section className="space-y-2 rounded border border-slate-300 bg-slate-50 p-4" aria-label="Provider connection">
        <h3 className="text-xs font-semibold uppercase text-slate-500">{form.provider === "microsoft_365" ? "Microsoft 365 Connection" : "Connection"}</h3>
        {form.provider === "microsoft_365" ? <MicrosoftEmailConnectionSettings key={`microsoft-${saved?.revision}`} settings={saved ?? undefined}
          canManage={canManage && !busy} providerSaved={saved?.provider === form.provider} />
          : <ProviderCredentialSettings key={`${channel}-${form.provider}`} channel={channel} provider={form.provider} settings={saved ?? undefined} canManage={canManage && !busy} providerSaved={saved?.provider === form.provider} />}
      </section> : null}
      {isEmail ? <InvitationEmailSettings /> : null}
    </section>
  );
}
