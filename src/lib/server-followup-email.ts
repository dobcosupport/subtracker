import "server-only";
import { AdminApiError, type AdminContext } from "@/lib/server-admin";
import type { FollowupEmailOrigin } from "@/lib/followup-email";

type Followup = { id: number; contractor_id: number; origin_communication_id: string | null };
type Message = { id: string; sent_at: string; communication_contractors: { contractor_id: number }[] };

export async function followupEmailOrigins(admin: AdminContext["admin"], ids: number[]) {
  const origins: Record<number, FollowupEmailOrigin | null> = {};
  if (!ids.length) return origins;
  const { data: followups, error } = await admin.from("contractor_followups")
    .select("id,contractor_id,origin_communication_id").in("id", ids).returns<Followup[]>();
  if (error) throw new AdminApiError(`Unable to load Follow-Up email linkage: ${error.message}`, 503);
  const links: { followup_id: number; message_id: string }[] = [];
  for (let start = 0; ; start += 500) {
    const result = await admin.from("communication_followups").select("followup_id,message_id")
      .in("followup_id", ids).order("followup_id").order("message_id").range(start, start + 499);
    if (result.error) throw new AdminApiError(`Unable to load Follow-Up communication links: ${result.error.message}`, 503);
    links.push(...result.data ?? []);
    if ((result.data?.length ?? 0) < 500) break;
  }
  const messageIds = [...new Set([...(followups ?? []).flatMap(row => row.origin_communication_id ? [row.origin_communication_id] : []),
    ...links.map(row => row.message_id)])];
  const messages = new Map<string, Message>();
  for (let start = 0; start < messageIds.length; start += 200) {
    const result = await admin.from("communication_messages")
      .select("id,sent_at,communication_contractors(contractor_id)")
      .in("id", messageIds.slice(start, start + 200)).eq("channel", "email").in("status", ["Sent", "Delivered"])
      .not("sent_at", "is", null).returns<Message[]>();
    if (result.error) throw new AdminApiError(`Unable to verify Follow-Up Email Sent: ${result.error.message}`, 503);
    for (const message of result.data ?? []) {
      if (!Number.isFinite(Date.parse(message.sent_at))) throw new AdminApiError("Follow-Up Email Sent timestamp is invalid.", 503);
      messages.set(message.id, message);
    }
  }
  for (const row of followups ?? []) {
    const candidates = row.origin_communication_id ? [row.origin_communication_id]
      : links.filter(link => link.followup_id === row.id).map(link => link.message_id);
    const source = candidates.map(id => messages.get(id)).filter((message): message is Message =>
      Boolean(message?.communication_contractors.some(link => link.contractor_id === row.contractor_id)))
      .sort((a, b) => Date.parse(a.sent_at) - Date.parse(b.sent_at) || a.id.localeCompare(b.id))[0];
    origins[row.id] = source ? { communication_id: source.id, sent_at: source.sent_at } : null;
  }
  return origins;
}
