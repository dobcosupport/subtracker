"use client";

import { useEffect, useState } from "react";
import { useSessionProfile } from "@/components/SessionContext";
import { canAccessModule } from "@/lib/permissions";
import { readJson } from "@/lib/communication-compose-client";
import type { EmailListRow } from "@/types/email-workspace";
import type { RecipientSnapshot } from "@/types/communications";
import type { ScheduledEmailStatus } from "@/types/scheduled-email";
import styles from "./email-workspace.module.css";

type Content = { subject: string | null; body: string; status: string; sender_address: string | null;
  communication_recipients: RecipientSnapshot[]; context_snapshot?: { projects?: { project_number: string; project_name: string }[];
    contractors?: { company_name: string }[]; followups?: { subject: string }[]; requirements?: { name: string }[];
    mycoi?: { policy_line: string }[]; template?: { name: string } | null } | null };
type Delivery = { status: string; provider: string; failure_reason: string | null; sent_at: string | null;
  scheduled_delivery?: { blocked_reason: string | null; outcome: string | null; next_attempt_at: string; finished_at: string | null } | null;
  communication_recipients: { id: string; status: string; recipient_role?: string; failure_reason: string | null }[] };

export default function EmailHistory({ folder, refresh, onEdit }: {
  folder: "Drafts" | "Scheduled" | "Sent"; refresh: number; onEdit: (id: string) => void;
}) {
  const { permissions } = useSessionProfile();
  const [rows, setRows] = useState<EmailListRow[]>([]);
  const [scheduling, setScheduling] = useState<ScheduledEmailStatus | null>(null);
  const [offset, setOffset] = useState(0);
  const [next, setNext] = useState<number | null>(null);
  const [status, setStatus] = useState("");
  const [localRefresh, setLocalRefresh] = useState(0);
  const [content, setContent] = useState<Content | null>(null);
  const [delivery, setDelivery] = useState<Delivery | null>(null);
  const [selected, setSelected] = useState<EmailListRow | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [lookup, setLookup] = useState("");
  const summaryAllowed = canAccessModule(permissions, "communications_summary");
  const contentAllowed = canAccessModule(permissions, "communications_content");
  const deliveryAllowed = canAccessModule(permissions, "communications_delivery");
  const manage = canAccessModule(permissions, "communications_delivery", "manage");
  useEffect(() => {
    if (!summaryAllowed) return;
    let active = true;
    void readJson<{ messages: EmailListRow[]; next_offset: number | null; scheduling?: ScheduledEmailStatus }>(`/api/communications/email-history?${new URLSearchParams({ folder, offset: String(offset), status })}`)
      .then(result => { if (active) { setRows(result.messages); setNext(result.next_offset); setScheduling(result.scheduling ?? null); setError(""); setLoading(false); } })
      .catch(reason => { if (active) { setRows([]); setError(reason instanceof Error ? reason.message : "Unable to load emails."); setLoading(false); } });
    return () => { active = false; };
  }, [folder, offset, refresh, localRefresh, summaryAllowed, status]);
  async function open(row: EmailListRow) {
    setBusy(true); setError(""); setSelected(row); setContent(null); setDelivery(null);
    try {
      const [detail, outcome] = await Promise.all([
        contentAllowed ? readJson<{ communication: Content }>(`/api/communications/${row.id}`) : Promise.resolve(null),
        deliveryAllowed ? readJson<{ delivery: Delivery }>(`/api/communications/${row.id}/delivery`) : Promise.resolve(null),
      ]);
      setContent(detail?.communication ?? null); setDelivery(outcome?.delivery ?? null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to load email details."); }
    finally { setBusy(false); }
  }
  async function cancel() {
    if (!selected) return;
    setBusy(true); setError("");
    try {
      const result = await readJson<{ status: string; execution_enabled: boolean }>(`/api/communications/${selected.id}/plan`,
        { method: "POST", body: JSON.stringify({ action: "cancel", revision: selected.revision }) });
      if (result.status !== "Cancelled" || typeof result.execution_enabled !== "boolean") throw new Error("Cancellation was not confirmed. Refresh before trying again.");
      setSelected(null); setContent(null); setDelivery(null); setLocalRefresh(i => i + 1);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Cancellation failed. Refresh before trying again."); }
    finally { setBusy(false); }
  }
  return <section aria-label={`${folder} messages`}>
    <header className={styles.panelHeader}><div><h2>{folder}</h2><p>{folder === "Scheduled" ? scheduling?.notice ?? "Checking scheduled delivery availability..." : folder === "Drafts" ? "Continue a saved message or start a new one." : "Sent messages and delivery outcomes."}</p></div>
      <div className={styles.inline}>{folder === "Sent" ? <select aria-label="Delivery status filter" value={status} onChange={e => { setStatus(e.target.value); setOffset(0); setSelected(null); }}>
        <option value="">Sent / Delivered</option>{["Failed", "Cancelled", "Skipped"].map(s => <option key={s}>{s}</option>)}</select> : null}
        <button type="button" className={styles.secondary} onClick={() => setLocalRefresh(i => i + 1)}>Refresh</button></div></header>
    {!summaryAllowed ? <p className={styles.hint}>Communications Summary View permission is required.</p> : error ? <p className={styles.error} role="alert">{error}</p> : null}
    {!summaryAllowed && folder === "Drafts" && canAccessModule(permissions, "communications_content", "edit") ? <div className={styles.panel}>
      <label htmlFor="email-draft-lookup">Draft ID to edit</label><div className={styles.inline}><input id="email-draft-lookup" value={lookup} onChange={e => setLookup(e.target.value)} />
        <button type="button" className={styles.secondary} disabled={!lookup.trim()} onClick={() => onEdit(lookup.trim())}>Open draft</button></div>
    </div> : null}
    {summaryAllowed ? loading ? <p className={styles.empty}>Loading messages...</p> : rows.length ? <div className={styles.tableScroll}>
      <table className={styles.table}><thead><tr><th>Date</th><th>Recipient</th><th>Subject</th><th>Type</th><th>Status</th></tr></thead>
        <tbody>{rows.map(row => <tr key={row.id}><td>{new Date(row.scheduled_at ?? row.sent_at ?? row.created_at).toLocaleString()}</td>
          <td>{row.recipients ? row.recipients.slice(0, 2).map(r => r.recipient_name).join(", ") + (row.recipients.length > 2 ? ` +${row.recipients.length - 2}` : "") : `${row.recipient_count} recipients`}</td>
          <td><button type="button" className={styles.textButton} disabled={busy || (!contentAllowed && !deliveryAllowed)} onClick={() => void open(row)}>{contentAllowed ? row.subject || "(No subject)" : "Content restricted"}</button>
            {row.status === "Draft" && canAccessModule(permissions, "communications_content", "edit") ? <div><button type="button" className={styles.textButton} onClick={() => onEdit(row.id)}>Edit draft</button></div> : null}
            <small>{row.projects.map(p => p.projects ? `${p.projects.project_number} - ${p.projects.project_name}` : "").filter(Boolean).join("; ")}</small></td>
          <td>{row.communication_type ?? row.source}</td><td><span className={styles.badge} data-status={row.status}>{row.status}</span></td></tr>)}</tbody>
      </table></div> : <p className={styles.empty}>No {status || folder.toLowerCase()} messages.</p> : null}
    {selected ? <article className={styles.detail} aria-label="Message details">
      <div className={styles.inline}><h3>{content?.subject ?? "Message details"}</h3><button type="button" className={styles.secondary} onClick={() => setSelected(null)}>Close details</button></div>
      {content ? <><p>From: {content.sender_address}</p>{(["to", "cc", "bcc"] as const).map(role => {
        const recipients = content.communication_recipients.filter(r => (r.recipient_role ?? "to") === role);
        return recipients.length ? <p key={role}><strong>{role === "to" ? "To" : role === "cc" ? "Cc" : "Bcc"}:</strong> {recipients.map(r => `${r.recipient_name} <${r.email}>`).join("; ")}</p> : null;
      })}<p>{content.context_snapshot?.contractors?.map(c => c.company_name).join("; ")}</p>
        <p>{content.context_snapshot?.projects?.map(p => `${p.project_number} - ${p.project_name}`).join("; ")}</p>
        <p>{content.context_snapshot?.template?.name ? `Template: ${content.context_snapshot.template.name}` : ""}</p>
        <p>{[...(content.context_snapshot?.followups ?? []).map(f => f.subject), ...(content.context_snapshot?.requirements ?? []).map(r => r.name),
          ...(content.context_snapshot?.mycoi ?? []).map(p => p.policy_line)].join("; ")}</p><pre>{content.body}</pre></> : null}
      {delivery ? <div><p>{delivery.provider} | {delivery.status}{delivery.sent_at ? ` | ${new Date(delivery.sent_at).toLocaleString()}` : ""}</p>
        {delivery.failure_reason ? <p role="alert">{delivery.failure_reason}</p> : null}
        {delivery.scheduled_delivery?.blocked_reason ? <p role="status">{delivery.scheduled_delivery.blocked_reason}
          {delivery.scheduled_delivery.finished_at ? " Processing stopped; review is required." : ` Recheck after ${new Date(delivery.scheduled_delivery.next_attempt_at).toLocaleString()}.`}</p> : null}
        {delivery.communication_recipients.map(r => <p key={r.id}>{r.recipient_role ?? "to"} | {r.status}{r.failure_reason ? ` | ${r.failure_reason}` : ""}</p>)}</div> : null}
      <div className={styles.inline}>{selected.status === "Draft" && canAccessModule(permissions, "communications_content", "edit") ? <button type="button" className={styles.primary} onClick={() => onEdit(selected.id)}>Edit draft</button> : null}
        {selected.status === "Scheduled" && manage ? <button type="button" className={styles.secondary} disabled={busy} onClick={() => void cancel()}>Cancel scheduled plan</button> : null}</div>
    </article> : null}
    {summaryAllowed ? <footer className={styles.pagination}><button type="button" className={styles.secondary} disabled={offset === 0} onClick={() => { setOffset(Math.max(0, offset - 50)); setSelected(null); }}>Previous</button>
      <button type="button" className={styles.secondary} disabled={next === null} onClick={() => { if (next !== null) setOffset(next); setSelected(null); }}>Next</button></footer> : null}
  </section>;
}
