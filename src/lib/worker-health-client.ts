import { adminFetch } from "@/lib/admin-client";

export async function checkNjPwcWorker(): Promise<string | null> {
  const response = await adminFetch("/api/contractors/nj-pwc-search/availability");
  const result = await response.json() as { available?: boolean; message?: string | null; error?: string };
  if (!response.ok) throw new Error(result.error ?? "Unable to verify NJ PWC worker availability.");
  if (!result.available) throw new Error("NJ PWC Worker Offline. Check Worker Health in Compliance Sync. Existing searches and results have not been deleted.");
  return result.message ?? null;
}
