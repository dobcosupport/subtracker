"use client";

import { useEffect, useState } from "react";
import { adminFetch } from "@/lib/admin-client";
import { useSessionProfile } from "@/components/SessionContext";
import { canAccessModule } from "@/lib/permissions";
import type { RecipientSnapshot } from "@/types/communications";

type Content = { id: string; status: string; subject: string | null; body: string; sender_name: string | null; sender_address: string | null; communication_recipients: RecipientSnapshot[] };
type Delivery = {
  id: string; status: string; provider: string | null; provider_message_id: string | null; failure_reason: string | null;
  queued_at: string | null; sent_at: string | null; delivered_at: string | null; failed_at: string | null; cancelled_at: string | null;
  communication_recipients: { id: string; status: string; provider_recipient_id: string | null; failure_reason: string | null }[];
};
export default function ContractorCommunicationDetails({ id, kind, onClose }: { id: string; kind: "content" | "delivery"; onClose: () => void }) {
  const { permissions } = useSessionProfile();
  const allowed = canAccessModule(permissions, kind === "content" ? "communications_content" : "communications_delivery");
  const [content, setContent] = useState<Content | null>(null);
  const [delivery, setDelivery] = useState<Delivery | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!allowed) return;
    let active = true;
    void (async () => {
      try {
        const response = await adminFetch(`/api/communications/${id}${kind === "delivery" ? "/delivery" : ""}`);
        const result = await response.json() as { communication?: Content; delivery?: Delivery; error?: string };
        if (!response.ok) throw new Error(result.error ?? "Unable to load communication details.");
        if (kind === "content" && !result.communication || kind === "delivery" && !result.delivery) throw new Error("Communication details were not returned.");
        if (active) { setContent(result.communication ?? null); setDelivery(result.delivery ?? null); }
      } catch (reason) { if (active) setError(reason instanceof Error ? reason.message : "Unable to load communication details."); }
    })();
    return () => { active = false; };
  }, [id, kind, allowed]);
  return (
    <section aria-label="Communication details" className="space-y-2 rounded border border-slate-200 bg-white p-4 text-sm">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-semibold">{kind === "content" ? "Message Content" : "Delivery Details"}</h2>
        <div className="text-xs"><button type="button" onClick={onClose} className="rounded border border-slate-300 px-2 py-0.5">Close Details</button></div>
      </div>
      {!allowed ? <p role="alert">You do not have permission to view these details.</p> : <>
        <p className="break-all">Communication ID: {id}</p>
        {error ? <p role="alert" className="text-red-700">{error}</p> : !content && !delivery ? <p>Loading details...</p> : null}
        {content ? <>
          <p>Status: {content.status}</p><p>Sender: {content.sender_name || "-"} {content.sender_address || ""}</p>
          <h3 className="font-medium">{content.subject || "No subject"}</h3><p className="whitespace-pre-wrap break-words">{content.body}</p>
          <h3 className="font-medium">Recipient Snapshots</h3>
          <ul>{content.communication_recipients.map((recipient, index) => <li key={index} className="break-words">{recipient.recipient_name}: {recipient.email || "-"} / {recipient.mobile_phone || "-"}</li>)}</ul>
        </> : null}
        {delivery ? <>
          <p>Status: {delivery.status}</p><p>Provider: {delivery.provider || "Not configured"}</p><p className="break-all">Provider Message ID: {delivery.provider_message_id || "None"}</p>
          {(["queued_at", "sent_at", "delivered_at", "failed_at", "cancelled_at"] as const).map((field) => <p key={field}>{field}: {delivery[field] || "None"}</p>)}
          <p>Failure: {delivery.failure_reason || "None"}</p>
          <ul>{delivery.communication_recipients.map((recipient) => <li key={recipient.id} className="break-words">{recipient.id}: {recipient.status}; Provider ID: {recipient.provider_recipient_id || "None"}; Failure: {recipient.failure_reason || "None"}</li>)}</ul>
        </> : null}
      </>}
    </section>
  );
}
