import { adminFetch } from "@/lib/admin-client";

export async function readJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await adminFetch(url, init);
  const result = await response.json();
  if (!response.ok) throw new Error(typeof result.error === "string" ? result.error : "Communication request failed.");
  return result as T;
}
export async function composeRows<T>(kind: string, query: Record<string, string> = {}): Promise<T[]> {
  const rows: T[] = [];
  let offset: number | null = 0;
  do {
    const page: { rows: T[]; next_offset: number | null } = await readJson(`/api/communications/compose-options?${new URLSearchParams({ kind, ...query, offset: String(offset) })}`);
    rows.push(...page.rows);
    if (rows.length > 10000) throw new Error("Selection exceeds 10000 records. Narrow the search.");
    offset = page.next_offset;
  } while (offset !== null);
  return rows;
}
