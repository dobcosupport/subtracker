"use client";

import { useEffect, useState } from "react";
import { adminFetch } from "@/lib/admin-client";
import type { ChannelSettingsInput, CommunicationChannel, CredentialProvider } from "@/types/communications";
import { emailProviderPlan } from "@/lib/email-provider";

const button = "rounded border border-slate-300 px-2 py-0.5 font-medium disabled:cursor-not-allowed disabled:opacity-50";
export default function ProviderCredentialSettings({ channel, canManage, providerSaved, provider = "azure_communication_services", settings }: {
  channel: CommunicationChannel; canManage: boolean; providerSaved: boolean; provider?: CredentialProvider; settings?: ChannelSettingsInput;
}) {
  const microsoft = provider === "microsoft_365";
  const credentialUrl = `/api/admin/communication-settings/${channel}/credential?provider=${provider}`;
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [available, setAvailable] = useState(false);
  const [editing, setEditing] = useState(false);
  const [credential, setCredential] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const response = await adminFetch(credentialUrl);
        const result = await response.json() as { credential_configured?: boolean; error?: string };
        if (!response.ok || typeof result.credential_configured !== "boolean") throw new Error(result.error ?? "Unable to determine credential status.");
        if (active) { setConfigured(result.credential_configured); setAvailable(true); }
      } catch (reason) {
        if (active) { setAvailable(false); setError(reason instanceof Error ? reason.message : "Unable to determine credential status."); }
      }
    })();
    return () => { active = false; };
  }, [credentialUrl]);
  async function save() {
    if (!canManage || !available || !providerSaved || busy) return;
    setBusy(true); setError("");
    const submitted = credential;
    setCredential(""); setEditing(false);
    try {
      const response = await adminFetch(credentialUrl, { method: "PUT", body: JSON.stringify({ credential: submitted }) });
      const result = await response.json() as { credential_configured?: boolean; error?: string };
      if (!response.ok || result.credential_configured !== true) throw new Error(result.error ?? "Unable to save the credential.");
      setConfigured(true);
    } catch (reason) {
      // A transport failure may occur after the vault write; do not claim the old status.
      setConfigured(null); setAvailable(false);
      setError(reason instanceof Error ? reason.message : "Unable to save the credential.");
    } finally { setBusy(false); }
  }
  const configurationStatus = !providerSaved || !settings ? "Incomplete" : channel === "email"
    ? emailProviderPlan(settings, configured === true && available).configuration_status
    : !settings.enabled || !settings.sending_phone_number ? "Incomplete"
      : configured === true && available ? "Ready for Testing" : "Credential Required";
  return <div className="space-y-2">
    <p className="text-sm">Configuration Status: <strong>{configurationStatus}</strong></p>
    <p className="text-xs text-slate-500">Readiness reflects saved settings only. Ordinary settings can be saved without secure credential storage.</p>
    <p className="text-sm">Credential Status: <strong>{configured === null ? error ? "Unavailable" : "Checking..." : configured ? "Configured" : "Not Configured"}</strong></p>
    <p className="text-sm">Connection Status: <strong>Not Verified</strong></p>
    {error ? <p role="alert" className="text-xs text-red-700">Credential storage reason: {error} This does not block Save Settings.</p> : null}
    <div className="flex flex-wrap gap-2 text-xs">
      <button type="button" className={button} disabled={!canManage || !available || !providerSaved || busy}
        onClick={() => { setCredential(""); setEditing(true); }}>{configured ? "Replace Connection" : "Configure Connection"}</button>
      <button type="button" className={button} disabled>Test Connection</button>
      <button type="button" className={button} disabled>{channel === "email" ? "Send Test Email" : "Send Test SMS"}</button>
    </div>
    {editing ? <div className="space-y-2">
      <label className="block text-sm" htmlFor={`${provider}-${channel}-credential`}>{microsoft ? "Microsoft 365 Client Secret" : "ACS Connection String"}</label>
      <input id={`${provider}-${channel}-credential`} type="password" autoComplete="new-password" spellCheck={false}
        className="block w-full rounded border border-slate-300 px-2 py-1 text-sm" maxLength={4096} value={credential}
        onKeyDown={(event) => { if (event.key === "Enter") event.preventDefault(); }}
        onChange={(event) => setCredential(event.target.value)} />
      <div className="flex gap-2 text-xs">
        <button type="button" className={button} disabled={!credential || busy} onClick={() => void save()}>Save Connection</button>
        <button type="button" className={button} onClick={() => { setCredential(""); setEditing(false); }}>Cancel</button>
      </div>
      <p className="text-xs text-slate-500">Enter once. Saved credentials are never displayed. Saving does not verify the connection or enable sending.</p>
    </div> : null}
    <p className="text-xs text-slate-500">Only credential configuration requires provisioned Azure Key Vault infrastructure and access. {microsoft ? "Microsoft 365" : "ACS"} connection testing and test sending are not implemented. No connection has been verified.</p>
  </div>;
}
