"use client";

import { useState } from "react";
import { adminFetch } from "@/lib/admin-client";
import type { ScheduledEmailPolicy, ScheduledEmailStatus } from "@/types/scheduled-email";

export default function ScheduledEmailWorkerSettings({ canManage }: { canManage: boolean }) {
  const [policy, setPolicy] = useState<ScheduledEmailPolicy | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  async function load() {
    const response = await adminFetch("/api/admin/scheduled-email");
    const result = await response.json() as { policy?: ScheduledEmailPolicy | null; scheduling?: ScheduledEmailStatus; notice?: string; error?: string };
    if (!response.ok || result.policy === undefined) throw new Error(result.error ?? "Unable to load scheduled delivery settings.");
    setPolicy(result.policy); setStatus(result.scheduling?.notice ?? result.notice ?? ""); setLoaded(true);
  }
  async function open() {
    if (loaded || busy) return;
    setBusy(true); setError("");
    try { await load(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to load scheduled delivery settings."); }
    finally { setBusy(false); }
  }
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!policy || !canManage) return;
    setBusy(true); setError("");
    try {
      const input = {
        revision: policy.revision, enabled: policy.enabled, batch_size: policy.batch_size,
        retry_policy: policy.retry_policy, retry_delay_seconds: policy.retry_delay_seconds,
        maximum_attempts: policy.maximum_attempts, stale_claim_seconds: policy.stale_claim_seconds,
      };
      const response = await adminFetch("/api/admin/scheduled-email", { method: "PATCH", body: JSON.stringify(input) });
      const result = await response.json() as { saved?: boolean; error?: string };
      if (!response.ok || result.saved !== true) throw new Error(result.error ?? "Worker settings were not confirmed. Reload before trying again.");
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to save scheduled delivery settings."); }
    finally { setBusy(false); }
  }
  const field = (label: string, key: "batch_size" | "retry_delay_seconds" | "maximum_attempts" | "stale_claim_seconds") =>
    <label className="text-sm" key={key}>{label}<input type="number" required className="mt-1 block w-full rounded border border-slate-300 px-2 py-1"
      value={policy?.[key] ?? ""} onChange={event => setPolicy(current => current && ({ ...current, [key]: Number(event.target.value) }))} /></label>;
  return <details className="space-y-2 rounded border border-slate-300 bg-slate-50 p-4" onToggle={event => { if (event.currentTarget.open) void open(); }}>
    <summary className="cursor-pointer text-sm font-medium">Scheduled delivery processing</summary>
    {busy ? <p className="text-sm">Loading or saving worker settings...</p> : null}
    {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : null}
    {status ? <p role="status" className="text-sm">{status}</p> : null}
    {policy ? <form onSubmit={event => void save(event)} className="space-y-3">
      <fieldset disabled={!canManage || busy} className="space-y-3">
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={policy.enabled}
          onChange={event => setPolicy({ ...policy, enabled: event.target.checked })} />Scheduled delivery worker active</label>
        <p className="text-xs text-slate-500">First activation requires zero Scheduled messages. A configured trigger is also required. Email and individual recipient controls always apply.</p>
        <div className="grid gap-3 sm:grid-cols-2">{field("Batch size (1-5)", "batch_size")}{field("Retry / blocked recheck delay (seconds)", "retry_delay_seconds")}
          {field("Maximum pre-delivery attempts", "maximum_attempts")}{field("Stale claim timeout (seconds)", "stale_claim_seconds")}</div>
        <label className="block text-sm">Retry policy<select className="ml-2 rounded border border-slate-300 px-2 py-1" value={policy.retry_policy}
          onChange={event => setPolicy({ ...policy, retry_policy: event.target.value === "none" ? "none" : "pre_dispatch_only" })}>
          <option value="pre_dispatch_only">Before delivery reservation only</option><option value="none">No retries</option></select></label>
        <p className="text-xs text-slate-500">A reserved delivery is never retried automatically, including uncertain Graph outcomes. Blocked eligibility remains Scheduled and is rechecked without exhausting attempts.</p>
        <p className="text-xs">Last worker check: {policy.last_polled_at ? new Date(policy.last_polled_at).toLocaleString() : "Not yet observed"}</p>
        <button type="submit" className="rounded border border-slate-300 px-2 py-1 text-sm font-medium" disabled={busy}>Save Worker Settings</button>
      </fieldset>
    </form> : null}
    {error && !policy ? <button type="button" className="text-sm underline" onClick={() => void open()}>Reload worker settings</button> : null}
  </details>;
}
