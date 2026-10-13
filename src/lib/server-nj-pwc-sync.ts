import { AdminApiError } from "@/lib/server-admin";

// Shared helpers for the NJ PWC auto-approval / registry sync routes. All
// state changes happen inside SECURITY DEFINER SQL functions (see
// supabase/20261014_nj_pwc_registry_sync_functions.sql); routes only
// authenticate, validate input shape, and translate RPC errors.

const RPC_ERROR_STATUS: Record<string, number> = {
  "55000": 409, // object_not_in_prerequisite_state
  "23514": 422, // check_violation
  P0002: 404, // no_data_found
  "22023": 400, // invalid_parameter_value
};

type RpcError = { code?: string; message?: string } | null | undefined;

export function njPwcRpcError(error: RpcError): AdminApiError | null {
  if (!error) return null;
  const status = (error.code && RPC_ERROR_STATUS[error.code]) || 500;
  return new AdminApiError(error.message || "NJ PWC operation failed.", status, { code: error.code });
}

export function firstRpcRow<T>(data: unknown): T {
  const row: unknown = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    throw new AdminApiError("NJ PWC operation returned no result.", 500);
  }
  return row as T;
}

export async function readJsonObject(request: Request, allowedKeys: readonly string[]): Promise<Record<string, unknown>> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    throw new AdminApiError("Request body must be valid JSON.", 400);
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new AdminApiError("Request body must be a JSON object.", 400);
  }
  const body = payload as Record<string, unknown>;
  const unexpected = Object.keys(body).filter((key) => !allowedKeys.includes(key));
  if (unexpected.length > 0) {
    throw new AdminApiError(`Unexpected field(s): ${unexpected.join(", ")}.`, 400);
  }
  return body;
}

export function positiveInt(value: unknown): number | null {
  const parsed = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof parsed === "number" && Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function optionalText(value: unknown, field: string, maxLength = 2000): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > maxLength) {
    throw new AdminApiError(`${field} must be text of at most ${maxLength} characters.`, 400);
  }
  return value.trim() === "" ? null : value.trim();
}
