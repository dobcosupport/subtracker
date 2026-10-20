"use client";

import { useEffect, useState } from "react";
import { adminFetch } from "@/lib/admin-client";
import type { ChannelSettingsInput } from "@/types/communications";
import type { MicrosoftEmailConnection } from "@/types/microsoft-email";

const button = "rounded border border-slate-300 px-2 py-0.5 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-50";
const url = "/api/admin/microsoft-email";

export default function MicrosoftEmailConnectionSettings({ settings, canManage, providerSaved }: {
  settings?: ChannelSettingsInput; canManage: boolean; providerSaved: boolean;
}) {
  const [state, setState] = useState<MicrosoftEmailConnection | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [recipient, setRecipient] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [requestId, setRequestId] = useState("");
  async function reload() {
    const response = await adminFetch(url);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? "Unable to read Microsoft Email connection state.");
    setState(result);
  }
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const response = await adminFetch(url);
        const result = await response.json();
        if (!response.ok) throw new Error(result.error ?? "Unable to read Microsoft Email connection state.");
        if (active) setState(result);
      } catch (reason) { if (active) setError(reason instanceof Error ? reason.message : "Unable to read connection state."); }
    })();
    return () => { active = false; };
  }, []);
  async function run(action: "authenticate" | "send_test") {
    if (!canManage || !providerSaved || !settings || busy) return;
    setBusy(true); setError(""); setNotice(""); setEditing(false);
    try {
      const response = await adminFetch(url, { method: "POST", body: JSON.stringify({
        action, revision: settings.revision,
        ...(action === "send_test" ? { recipient, request_id: requestId, confirmed } : {}),
      }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? `Test Email outcome: ${result.outcome ?? "unknown"}. Review Communication Logs before another test.`);
      setNotice(action === "authenticate"
        ? result.authentication_status === "Verified" ? "Authentication verified only; mailbox authorization and delivery were not tested." : `Authentication test failed: ${result.diagnostic_category}.`
        : `Communication ${result.communication_id}: accepted by Microsoft Graph. Receipt and reading are not confirmed.`);
      await reload();
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Microsoft Email test failed.";
      try { await reload(); setError(message); }
      catch { setState(null); setError(`${message} Connection state could not be refreshed.`); }
    } finally { setBusy(false); }
  }
  const saved = providerSaved && settings?.provider === "microsoft_365";
  return <div className="space-y-2 text-sm">
    <p>Authentication: <strong>Microsoft Entra / Vercel OIDC</strong></p>
    <p>Credential: <strong>No stored client secret required</strong></p>
    <p>Server Identity: <strong>{state?.identity_status ?? "Unavailable"}</strong></p>
    <p>Authentication Status: <strong>{saved ? state?.authentication_status ?? "Not Tested" : "Not Tested"}</strong></p>
    <p>Mailbox Authorization: <strong>Configured externally / Exchange RBAC</strong></p>
    <p className="text-xs text-slate-500">Administrator-reported infrastructure configuration; not verified by SubTracker.</p>
    <p>Authorized Sender: <strong>{saved ? settings?.from_address || "Not Configured" : "Save provider settings first"}</strong></p>
    <p>Delivery: <strong>{saved ? state?.delivery_status ?? "Not Tested" : "Not Tested"}</strong></p>
    <p>Overall Connection: <strong>{saved ? state?.overall_status ?? "Not Verified" : "Not Verified"}</strong></p>
    <p className="text-xs text-slate-500">Microsoft Entra authentication can be tested without sending Email. Exchange mailbox authorization is configured separately through Exchange Online RBAC. A deliberate test Email is required to validate the complete sending path. Graph acceptance does not prove recipient delivery or reading.</p>
    {state?.diagnostic_category ? <p className="text-xs">Diagnostic: {state.diagnostic_category}</p> : null}
    {error ? <p role="alert" className="text-xs text-red-700">{error} No automatic retry is performed.</p> : null}
    {notice ? <p role="status" className="text-xs text-slate-700">{notice}</p> : null}
    <div className="flex gap-2">
      <button type="button" className={button} disabled={!canManage || !saved || !state?.can_test || busy} onClick={() => void run("authenticate")}>Test Connection</button>
      <button type="button" className={button} disabled={!canManage || !saved || !state?.can_send_test || busy}
        onClick={() => { setRequestId(crypto.randomUUID()); setRecipient(""); setConfirmed(false); setEditing(true); }}>Send Test Email</button>
    </div>
    {editing ? <div className="space-y-2 rounded border border-amber-300 p-3">
      <p className="font-medium">This action sends a real Email from the saved sender mailbox.</p>
      <label className="block" htmlFor="microsoft-test-recipient">Test Recipient</label>
      <input id="microsoft-test-recipient" type="email" maxLength={254} value={recipient} autoComplete="off"
        className="block w-full rounded border px-2 py-1" onChange={(event) => setRecipient(event.target.value)} />
      <label className="flex items-center gap-2"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />I confirm this will send a real Email.</label>
      <button type="button" className={button} disabled={!confirmed || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient) || busy}
        onClick={() => void run("send_test")}>Send Real Test Email</button>
      <button type="button" className={`${button} ml-2`} onClick={() => setEditing(false)}>Cancel</button>
    </div> : null}
  </div>;
}
