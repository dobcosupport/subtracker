import "server-only";
import { AdminApiError } from "@/lib/server-admin";

export const NJ_BRC_QUEUE_BUCKETS = [
  "ready",
  "existing_brc",
  "missing_information",
  "needs_review",
  "verified",
  "no_result",
  "failed",
] as const;

export type NjBrcQueueBucket = (typeof NJ_BRC_QUEUE_BUCKETS)[number];
export type NjBrcQueueFilter = NjBrcQueueBucket | "all";

export interface NjBrcQueueQuery {
  bucket: NjBrcQueueFilter;
  search: string;
  page: number;
  pageSize: number;
}

export function parseNjBrcQueueQuery(url: URL): NjBrcQueueQuery {
  const bucket = url.searchParams.get("bucket") ?? "all";
  if (bucket !== "all" && !NJ_BRC_QUEUE_BUCKETS.includes(bucket as NjBrcQueueBucket)) {
    throw new AdminApiError("bucket is not supported.", 400);
  }

  const parsePositive = (value: string | null, fallback: number, name: string, maximum: number) => {
    if (value === null) return fallback;
    if (!/^[1-9]\d*$/.test(value)) throw new AdminApiError(`${name} must be a positive integer.`, 400);
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed > maximum) {
      throw new AdminApiError(`${name} is outside the supported range.`, 400);
    }
    return parsed;
  };

  const page = parsePositive(url.searchParams.get("page"), 1, "page", 100000);
  const pageSize = parsePositive(url.searchParams.get("page_size"), 25, "page_size", 100);
  if (!Number.isSafeInteger((page - 1) * pageSize)) {
    throw new AdminApiError("The requested page is outside the supported range.", 400);
  }
  const search = (url.searchParams.get("search") ?? "").trim();
  if (search.length > 100) throw new AdminApiError("search must be at most 100 characters.", 400);
  return { bucket: bucket as NjBrcQueueFilter, search, page, pageSize };
}

export function safeNjBrcQueueError(error: unknown): Response {
  if (error instanceof AdminApiError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  const code = error && typeof error === "object" ? (error as { code?: string }).code : undefined;
  const status = code === "42501" ? 403
    : code === "P0002" ? 404
      : code === "22023" ? 400
        : code === "23514" || code === "23505" || code === "55000" ? 409
          : 500;
  const message = status === 403 ? "You do not have permission to perform this action."
    : status === 404 ? "NJ BRC verification session not found."
      : status === 400 ? "The NJ BRC verification request is invalid."
        : status === 409 ? "The NJ BRC queue or session changed. Refresh and try again."
          : "Unable to process the NJ BRC verification request.";
  return Response.json({ error: message }, { status });
}
