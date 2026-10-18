"use client";

import { useEffect, useState } from "react";
import { adminFetch } from "@/lib/admin-client";
import { canAccessModule } from "@/lib/permissions";
import { useSessionProfile } from "@/components/SessionContext";
import { COMMUNICATION_STATUSES, type CommunicationSummary, type RecipientSnapshot } from "@/types/communications";

type Content = { id: string; subject: string | null; body: string; sender_name: string | null; sender_address: string | null; status: string; communication_recipients: RecipientSnapshot[] };
type Delivery = {
  id: string; status: string; provider: string | null; provider_message_id: string | null; failure_reason: string | null;
  queued_at: string | null; sent_at: string | null; delivered_at: string | null; failed_at: string | null; cancelled_at: string | null;
  communication_recipients: { id: string; status: string; provider_recipient_id: string | null; failure_reason: string | null; sent_at: string | null; delivered_at: string | null }[];
};
const button = "rounded border border-slate-300 px-2 py-0.5 font-medium disabled:cursor-not-allowed disabled:opacity-50";
export default function CommunicationLogsPanel() {
  const { permissions } = useSessionProfile();
  const summaryAllowed = canAccessModule(permissions, "communications_summary");
  const contentAllowed = canAccessModule(permissions, "communications_content");
  const deliveryAllowed = canAccessModule(permissions, "communications_delivery");
  const [filters, setFilters] = useState({ channel: "", source: "", status: "" });
  const [offset, setOffset] = useState(0);
  const [next, setNext] = useState<number | null>(null);
  const [messages, setMessages] = useState<CommunicationSummary[]>([]);
  const [loading, setLoading] = useState(summaryAllowed);
  const [error, setError] = useState("");
  const [detailError, setDetailError] = useState("");
  const [content, setContent] = useState<Content | null>(null);
  const [delivery, setDelivery] = useState<Delivery | null>(null);
  const [lookup, setLookup] = useState("");
  const [detailBusy, setDetailBusy] = useState(false);
  useEffect(() => {
    if (!summaryAllowed) return;
    let active = true;
    void (async () => {
      try {
        const query = new URLSearchParams({ ...filters, offset: String(offset) });
        const response = await adminFetch(`/api/communications?${query}`);
        const result = await response.json() as { messages?: CommunicationSummary[]; next_offset?: number | null; error?: string };
        if (!response.ok || !result.messages) throw new Error(result.error ?? "Unable to load communications.");
        if (active) { setMessages(result.messages); setNext(result.next_offset ?? null); setError(""); }
      } catch (reason) {
        if (active) { setMessages([]); setError(reason instanceof Error ? reason.message : "Unable to load communications."); }
      } finally { if (active) setLoading(false); }
    })();
    return () => { active = false; };
  }, [filters, offset, summaryAllowed]);
  async function open(id: string, kind: "content" | "delivery") {
    setDetailBusy(true); setDetailError(""); setContent(null); setDelivery(null);
    try {
      const response = await adminFetch(`/api/communications/${encodeURIComponent(id)}${kind === "delivery" ? "/delivery" : ""}`);
      const result = await response.json() as { communication?: Content; delivery?: Delivery; error?: string };
      if (!response.ok) throw new Error(result.error ?? "Unable to load communication details.");
      if (kind === "content") {
        if (!result.communication) throw new Error("Communication content was not returned.");
        setContent(result.communication);
      } else {
        if (!result.delivery) throw new Error("Delivery details were not returned.");
        setDelivery(result.delivery);
      }
    } catch (reason) { setDetailError(reason instanceof Error ? reason.message : "Unable to load communication details."); }
    finally { setDetailBusy(false); }
  }
  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-slate-500">Authoritative communication history. Sending and message composition are unavailable in Step 5.</p>
        <div className="text-xs"><button className={button} disabled title="Composition and sending are not available">New Message</button></div>
      </header>
      {summaryAllowed ? <section className="space-y-4 rounded border border-slate-200 bg-white p-4">
        <h2 className="font-semibold">History</h2>
        <div className="flex flex-wrap gap-3">
          {(["channel", "source", "status"] as const).map((key) => <div key={key} className="text-xs font-medium capitalize">
            <label htmlFor={`communication-filter-${key}`}>{key}</label>
            <select id={`communication-filter-${key}`} value={filters[key]} onChange={(event) => { setLoading(true); setOffset(0); setFilters({ ...filters, [key]: event.target.value }); }} className="ml-2 rounded border border-slate-300 px-2 py-1">
              <option value="">All</option>
              {(key === "channel" ? ["email", "sms"] : key === "source" ? ["manual", "automated"] : COMMUNICATION_STATUSES).map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </div>)}
        </div>
        {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : null}
        {loading ? <p className="text-sm">Loading communications...</p> : !error && !messages.length ? <p className="text-sm text-slate-500">No communications match these filters.</p> : null}
        {!loading && messages.length ? <div className="overflow-x-auto"><table className="w-full text-left text-xs">
          <thead><tr>{["Date / Time", "Channel", "Source", "Status", "Related Records", "Recipients", "Description", "Details"].map((heading) => <th key={heading} className="border-b px-2 py-2">{heading}</th>)}</tr></thead>
          <tbody>{messages.map((message) => <tr key={message.id}>
            <td className="border-b px-2 py-2">{new Date(message.created_at).toLocaleString()}</td>
            <td className="border-b px-2 py-2">{message.channel}</td><td className="border-b px-2 py-2">{message.source}</td><td className="border-b px-2 py-2">{message.status}</td>
            <td className="border-b px-2 py-2">{[...message.contractors.map((r) => r.contractors?.company_name ?? `Contractor ${r.contractor_id}`), ...message.projects.map((r) => r.projects ? `${r.projects.project_number} - ${r.projects.project_name}` : `Project ${r.project_id}`)].join("; ") || "-"}</td>
            <td className="border-b px-2 py-2">{message.recipient_count}</td><td className="border-b px-2 py-2">{message.description}</td>
            <td className="border-b px-2 py-2"><div className="flex gap-2">
              {contentAllowed ? <button className={button} disabled={detailBusy} onClick={() => void open(message.id, "content")}>Content</button> : null}
              {deliveryAllowed ? <button className={button} disabled={detailBusy} onClick={() => void open(message.id, "delivery")}>Delivery</button> : null}
              {!contentAllowed && !deliveryAllowed ? <span>Summary only</span> : null}
            </div></td>
          </tr>)}</tbody>
        </table></div> : null}
        <div className="flex gap-2 text-xs">
          <button className={button} disabled={offset === 0 || loading} onClick={() => { setLoading(true); setOffset(Math.max(0, offset - 50)); }}>Previous</button>
          <button className={button} disabled={next === null || loading} onClick={() => { if (next !== null) { setLoading(true); setOffset(next); } }}>Next</button>
        </div>
      </section> : <p className="text-sm">Communications Summary View is required for history rows. Other Communications permissions remain independent.</p>}
      {contentAllowed || deliveryAllowed ? <section className="space-y-2 rounded border border-slate-200 bg-white p-4 text-xs">
        <label className="block">Communication ID<input value={lookup} onChange={(event) => setLookup(event.target.value)} className="ml-2 w-80 max-w-full rounded border border-slate-300 px-2 py-1" /></label>
        <div className="flex gap-2">
          {contentAllowed ? <button className={button} disabled={!lookup.trim() || detailBusy} onClick={() => void open(lookup.trim(), "content")}>Open Content</button> : null}
          {deliveryAllowed ? <button className={button} disabled={!lookup.trim() || detailBusy} onClick={() => void open(lookup.trim(), "delivery")}>Open Delivery</button> : null}
        </div>
      </section> : null}
      {detailError ? <p role="alert" className="text-sm text-red-700">{detailError}</p> : null}
      {content ? <section className="space-y-3 rounded border border-slate-200 bg-white p-4 text-sm">
        <h2 className="font-semibold">Message Content</h2><p>{content.id} - {content.status}</p>
        <p>Sender: {content.sender_name || "-"} {content.sender_address || ""}</p>
        <h3 className="font-medium">{content.subject || "No subject"}</h3><p className="whitespace-pre-wrap break-words">{content.body}</p>
        <h3 className="font-medium">Recipient Snapshots</h3>
        <ul>{content.communication_recipients.map((r, i) => <li key={i} className="break-words">{r.recipient_name}: {r.email || "-"} / {r.mobile_phone || "-"}</li>)}</ul>
      </section> : null}
      {delivery ? <section className="space-y-2 rounded border border-slate-200 bg-white p-4 text-sm">
        <h2 className="font-semibold">Delivery Details</h2><p>{delivery.id} - {delivery.status}</p>
        <p>Provider: {delivery.provider || "Not configured"}</p><p>Provider Message ID: {delivery.provider_message_id || "None"}</p>
        {(["queued_at", "sent_at", "delivered_at", "failed_at", "cancelled_at"] as const).map((key) => <p key={key}>{key}: {delivery[key] || "None"}</p>)}
        <p>Failure: {delivery.failure_reason || "None"}</p>
        <ul>{delivery.communication_recipients.map((r) => <li key={r.id}>{r.id}: {r.status}; Provider ID: {r.provider_recipient_id || "None"}; Sent: {r.sent_at || "None"}; Delivered: {r.delivered_at || "None"}; Failure: {r.failure_reason || "None"}</li>)}</ul>
      </section> : null}
    </div>
  );
}
