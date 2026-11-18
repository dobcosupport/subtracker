"use client";

import { useState } from "react";
import { useSessionProfile } from "@/components/SessionContext";
import ContractorCommunicationDetails from "@/components/ContractorCommunicationDetails";
import { canAccessModule } from "@/lib/permissions";
import { emailSentDate, type FollowupEmailOrigin } from "@/lib/followup-email";

export default function FollowupEmailSent({ origin, label = false }: { origin?: FollowupEmailOrigin | null; label?: boolean }) {
  const { permissions } = useSessionProfile();
  const [open, setOpen] = useState(false);
  const kind = canAccessModule(permissions, "communications_content") ? "content"
    : canAccessModule(permissions, "communications_delivery") ? "delivery" : null;
  if (!origin) return label ? null : <span aria-label="Email Sent: Not Applicable">—</span>;
  return <div className="text-xs">
    <span>{label ? "Email Sent: " : ""}<time dateTime={origin.sent_at}>{emailSentDate(origin.sent_at)}</time></span>
    {kind ? <button type="button" className="ml-2 font-semibold text-blue-700" onClick={() => setOpen(value => !value)}>View Sent Email</button> : null}
    {open && kind ? <ContractorCommunicationDetails id={origin.communication_id} kind={kind} onClose={() => setOpen(false)} /> : null}
  </div>;
}
