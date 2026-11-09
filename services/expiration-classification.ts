export type ExpirationState = "Expired" | "0-30 Days" | "31-60 Days" | "61-90 Days" | "Current";

function dateDay(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Expiration classification requires YYYY-MM-DD dates.");
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) {
    throw new Error("Expiration classification received an invalid calendar date.");
  }
  return timestamp / 86_400_000;
}

// Date-only UTC arithmetic; the expiration day remains in the inclusive 0-30 bucket.
// Legacy Dashboard/history/export consumers retain their existing expiration-day semantics.
export function classifyExpiration(expiration: string, today = new Date().toISOString().slice(0, 10)): {
  status: ExpirationState; daysRemaining: number;
} {
  const daysRemaining = dateDay(expiration) - dateDay(today);
  const status = daysRemaining < 0 ? "Expired" : daysRemaining <= 30 ? "0-30 Days"
    : daysRemaining <= 60 ? "31-60 Days" : daysRemaining <= 90 ? "61-90 Days" : "Current";
  return { status, daysRemaining };
}
