export type FollowupEmailOrigin = { communication_id: string; sent_at: string };

export function emailSentDate(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", month: "2-digit", day: "2-digit", year: "numeric",
  }).format(new Date(value));
}
