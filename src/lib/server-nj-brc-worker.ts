import "server-only";
import { timingSafeEqual } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { AdminApiError, createAdminClient } from "@/lib/server-admin";
import { classifyWorker, type WorkerHealthRow } from "@/lib/worker-health";

export async function requireNjBrcWorkerAuth(request: Request): Promise<{ admin: ReturnType<typeof createAdminClient> } | Response> {
  const expected = process.env.NJ_BRC_WORKER_KEY;
  const provided = request.headers.get("x-subtracker-brc-key");
  if (!expected || !provided) return Response.json({ error: "Unauthorized." }, { status: 401 });
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }
  return { admin: createAdminClient() };
}

export function njBrcUserClient(request: Request) {
  const authorization = request.headers.get("authorization");
  if (!authorization?.match(/^Bearer\s+\S+$/i)) throw new AdminApiError("Authentication is required.", 401);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new AdminApiError("NJ BRC server configuration is unavailable.", 503);
  return createClient(url, key, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

export async function requireNjBrcWorker(admin: ReturnType<typeof createAdminClient>) {
  const { data, error } = await admin.from("compliance_sync_workers").select("*").eq("worker_key", "nj-brc").maybeSingle();
  if (error) throw new AdminApiError("Unable to verify NJ BRC worker availability.", 503);
  if (!data || !classifyWorker(data as WorkerHealthRow).available) {
    throw new AdminApiError("NJ BRC Worker Offline. No new search was queued. Check Worker Health in Compliance Sync.", 503);
  }
}

export function positiveInteger(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  if (typeof value === "string" && !/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 2147483647 ? parsed : null;
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export async function njBrcBody(request: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new AdminApiError("Request body must be valid JSON.", 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new AdminApiError("Request body must be a JSON object.", 400);
  }
  return body as Record<string, unknown>;
}

export function njBrcError(error: unknown): Response {
  if (error instanceof AdminApiError) return Response.json({ error: error.message }, { status: error.status });
  const code = error && typeof error === "object" ? (error as { code?: string }).code : undefined;
  const status = code === "42501" ? 403 : code === "P0002" ? 404 : code === "22023" || code === "23514" ? 400
    : code === "23505" || code === "55000" || code === "P0001" ? 409 : 500;
  const message = status === 403 ? "You do not have permission to perform this action."
    : status === 404 ? "NJ BRC request or contractor not found."
    : status === 400 ? "NJ BRC request validation failed."
    : status === 409 ? "NJ BRC request state or worker ownership has changed. Refresh and try again."
    : "Unable to process the NJ BRC request.";
  const safeMessages = [
    "Invalid Taxpayer ID (FEIN): expected 9 digits before NJ BRC formatting.",
    "NJ BRC Business Entity ID and Name Control are required",
    "NJ BRC request is not awaiting approval", "NJ BRC request is not awaiting rejection",
    "NJ BRC review item is not pending for this contractor",
    "Contractor lookup identifiers changed after request creation",
    "NJ BRC identity or certificate evidence is incomplete",
    "NJ BRC review fields no longer match extracted evidence",
    "NJ BRC must be configured as non-expiring before approval",
    "A rejection reason is required",
    "Successful NJ BRC result is missing required certificate evidence",
    "NJ BRC result already recorded with a different classification",
    "NJ BRC request cannot accept a result in its current state",
    "NJ BRC request is not owned by this worker instance",
  ];
  const databaseMessage = error && typeof error === "object" ? (error as { message?: unknown }).message : undefined;
  return Response.json({ error: typeof databaseMessage === "string" && safeMessages.includes(databaseMessage) ? databaseMessage : message }, { status });
}

const SAFE_FIELDS = [
  "id", "contractor_id", "company_name", "nj_brc_number", "brc_name_control", "status", "created_at", "updated_at",
  "claimed_at", "processing_started_at", "completed_at", "result_type", "review_queue_id", "existing",
] as const;

export const NJ_BRC_READ_COLUMNS = [
  ...SAFE_FIELDS.filter((field) => field !== "existing"), "federal_tax_id", "taxpayer_id_submission", "result_evidence",
].join(",");
export const NJ_BRC_ACTIVE_STATES = ["pending", "claimed", "processing", "human_verification_required", "review_required"];

function maskIdentifier(value: unknown, suppliedMask: unknown, prefix: string): string | null {
  if (typeof suppliedMask === "string" && suppliedMask.includes("*")) return suppliedMask;
  if (typeof value !== "string" || !value) return null;
  const digits = value.replace(/\D/g, "");
  return digits.length >= 4 ? `${prefix}${digits.slice(-4)}` : "*********";
}

export function maskedNjBrcRequest(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value)) value = value[0];
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const field of SAFE_FIELDS) if (row[field] !== undefined) result[field] = row[field];
  result.federal_tax_id_masked = maskIdentifier(row.federal_tax_id, row.federal_tax_id_masked, "***-**-");
  result.taxpayer_id_submission_masked = maskIdentifier(row.taxpayer_id_submission, row.taxpayer_id_submission_masked, "********");
  result.result_evidence = redactNjBrcEvidence(row.result_evidence, row.federal_tax_id, row.taxpayer_id_submission);
  return result;
}

export function redactNjBrcEvidence(value: unknown, ...secrets: unknown[]): unknown {
  const sensitive = secrets.filter((secret): secret is string => typeof secret === "string" && secret.length > 0)
    .flatMap((secret) => [secret, secret.replace(/\D/g, "")]).filter((secret) => secret.length >= 9)
    .sort((a, b) => b.length - a.length);
  function sanitize(item: unknown, field = ""): unknown {
    if (typeof item === "string") {
      let text = item;
      for (const secret of sensitive) text = text.split(secret).join("[REDACTED]");
      return field === "certificate_number" ? text
        : text.replace(/\b\d{2}[- ]\d{7}\b|\b\d{9}(?:000)?\b/g, "[REDACTED]");
    }
    if (Array.isArray(item)) return item.map((child) => sanitize(child, field));
    if (item && typeof item === "object") {
      return Object.fromEntries(Object.entries(item).filter(([key]) => !/fein|taxpayer_id|federal_tax|submission/i.test(key))
        .map(([key, child]) => [key, sanitize(child, key)]));
    }
    return item ?? null;
  }
  return sanitize(value);
}
