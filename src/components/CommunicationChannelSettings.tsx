"use client";

import { useEffect, useState } from "react";
import { adminFetch } from "@/lib/admin-client";
import { useSessionProfile } from "@/components/SessionContext";
import { canAccessModule } from "@/lib/permissions";
import InvitationEmailSettings from "@/components/InvitationEmailSettings";
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
      ...(isEmail ? { from_name: form.from_name, from_address: form.from_address, reply_to_address: form.reply_to_address, sending_domain: form.sending_domain }
        : { sending_phone_number: form.sending_phone_number, incoming_enabled: form.incoming_enabled, two_way_enabled: form.two_way_enabled }),
    };
    try {
      const response = await adminFetch(`/api/admin/communication-settings/${channel}`, { method: "PATCH", body: JSON.stringify(input) });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Unable to save channel settings.");
      const reload = await adminFetch(`/api/admin/communication-settings/${channel}`);
      const persisted = await reload.json() as { settings?: ChannelSettings; error?: string };
      if (!reload.ok || !persisted.settings) throw new Error(persisted.error ?? "Saved settings could not be reloaded.");
      setSaved(persisted.settings); setForm(persisted.settings);
      setNotice("Configuration saved. Sending, connection testing and automation remain unavailable.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to save channel settings."); }
    finally { setBusy(false); }
  }
  const stringField = (label: string, field: "from_name" | "from_address" | "reply_to_address" | "sending_domain" | "sending_phone_number") => (
    <label key={field} className="text-sm font-medium">{label}
      <input className={control} type={field.includes("address") ? "email" : "text"} maxLength={field === "sending_phone_number" ? 50 : 500}
        value={form?.[field] ?? ""} onChange={(event) => setForm((current) => current && ({ ...current, [field]: event.target.value }))} />
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
      <p className="text-sm text-slate-500">Installation-level settings. Enablement records configuration intent only; no delivery or automation runs.</p>
      {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : null}
      {notice ? <p role="status" className="text-sm text-green-700">{notice}</p> : null}
      {!form && !error ? <p className="text-sm">Loading channel settings...</p> : null}
      {form ? <form onSubmit={(event) => void save(event)} className="space-y-4">
        <fieldset disabled={!canManage || busy} className="space-y-4">
          <div className="text-sm font-medium">
            <label htmlFor={`communication-${channel}-provider`}>Provider</label>
            <select id={`communication-${channel}-provider`} className={control} value={form.provider ?? ""} onChange={(event) => setForm({ ...form, provider: event.target.value === "azure_communication_services" ? "azure_communication_services" : !isEmail && event.target.value === "twilio" ? "twilio" : null })}>
              <option value="">Not configured</option><option value="azure_communication_services">Azure Communication Services</option>
              {!isEmail ? <option value="twilio">Twilio</option> : null}
            </select>
          </div>
          {form.provider === "azure_communication_services" ? <div className="space-y-4 rounded border border-slate-200 p-4">
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
                {isEmail ? [stringField("From Name", "from_name"), stringField("From Address", "from_address"), stringField("Reply-To Address", "reply_to_address"), stringField("Sending Domain", "sending_domain")]
                  : stringField("Sending Phone Number", "sending_phone_number")}
              </div>
            </section>
            {!isEmail ? <section className="space-y-2 border-t border-slate-100 pt-3">
              <h3 className="text-xs font-semibold uppercase text-slate-500">Messaging</h3>
              <div className="flex flex-wrap gap-4">{check("Incoming SMS Enabled", "incoming_enabled")}{check("Two-Way SMS Enabled", "two_way_enabled")}</div>
            </section> : null}
            <section className="space-y-2 border-t border-slate-100 pt-3">
              <h3 className="text-xs font-semibold uppercase text-slate-500">Connection</h3>
              <p className="text-sm">Provider: Azure Communication Services</p>
              <p className="text-sm">Credential Status: <strong>Not Configured</strong></p>
              <p className="text-sm">Configuration Status: <span className="rounded bg-amber-100 px-2 py-1 text-xs font-semibold text-amber-800">{saved?.configuration_status}</span></p>
              {saved?.provider !== form.provider ? <p className="text-xs text-slate-500">Provider selection is unsaved. Configuration Status reflects saved settings.</p> : null}
              <div className="flex flex-wrap gap-2 text-xs">
                {["Replace Credential", "Test Connection", isEmail ? "Send Test Email" : "Send Test SMS"].map((label) => <button key={label} type="button" className={button} disabled>{label}</button>)}
              </div>
              <p className="text-xs text-slate-500">No credentials are requested or stored. A future server-side connector and secure secret store are required before connection testing.</p>
            </section>
          </div> : !isEmail && form.provider === "twilio" ? <section className="space-y-2 rounded border border-slate-200 p-4 text-sm" aria-label="Twilio configuration">
            <p>Provider: Twilio</p>
            <p>Connector Status: <strong>Not Implemented</strong></p>
            <p>Credential Status: <strong>Not Configured</strong></p>
            <p>Configuration Status: {saved?.configuration_status}</p>
            {saved?.provider !== form.provider ? <p className="text-xs text-slate-500">Provider selection is unsaved. Configuration Status reflects saved settings.</p> : null}
            <p className="text-xs text-slate-500">Recognized future SMS provider only. Selecting Twilio does not enable sending. Existing non-sensitive SMS settings are preserved.</p>
            <div className="flex flex-wrap gap-2 text-xs">
              {["Replace Credential", "Test Connection", "Send Test SMS"].map((label) => <button key={label} type="button" className={button} disabled>{label}</button>)}
            </div>
          </section> : <p className="text-sm text-slate-500">Select a provider to display its configuration. Credential Status: Not Configured.</p>}
        </fieldset>
        {canManage ? <div className="text-xs"><button className={`${button} bg-slate-900 text-white`} disabled={busy} type="submit">{busy ? "Saving..." : "Save Configuration"}</button></div> : <p className="text-xs text-slate-500">View only. Settings Manage is required to change configuration.</p>}
      </form> : null}
      {isEmail ? <InvitationEmailSettings /> : null}
    </section>
  );
}
