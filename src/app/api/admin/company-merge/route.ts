import { AdminApiError, requireModulePermission } from "@/lib/server-admin";
import type {
  CompanyMergeChoices,
  CompanyMergeComplianceChoices,
  CompanyMergePreview,
  CompanyMergeResult,
} from "@/types/company-merge";

const SEARCH_LIMIT = 12;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function responseError(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

function errorParts(error: unknown): { code?: string; message: string } {
  if (error && typeof error === "object") {
    const candidate = error as { code?: unknown; message?: unknown; details?: unknown };
    return {
      code: typeof candidate.code === "string" ? candidate.code : undefined,
      message: typeof candidate.message === "string" ? candidate.message : "Company merge request failed.",
    };
  }
  return { message: error instanceof Error ? error.message : "Company merge request failed." };
}

function mapApiError(error: unknown): Response {
  if (error instanceof AdminApiError) return responseError(error.message, error.status);
  const { code, message } = errorParts(error);
  if (code === "40001") return responseError("The company records changed after preview. Refresh the preview and review it again.", 409);
  if (code === "42501") return responseError("You do not have permission to perform this company merge.", 403);
  if (code === "22023") return responseError(message, 400);
  if (code === "55000") return responseError(message || "This merge is blocked. Resolve the listed blockers and refresh the preview.", 409);
  if (code === "55P03" || code === "40P01") return responseError("The merge could not obtain the required database lock. Refresh the preview and retry.", 409);
  if (code === "PGRST202" || code === "42883" || /company_merge_(preview|execute).*does not exist|could not find the function/i.test(message)) {
    return responseError("Company Merge is unavailable because its database migration has not been applied.", 503);
  }
  return responseError(message, 500);
}

function parseId(value: string | null): number | null {
  if (!value || !/^[1-9]\d*$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function getPreview(
  admin: Awaited<ReturnType<typeof requireModulePermission>>["admin"],
  primary: number,
  secondary: number,
  actorId: string
): Promise<CompanyMergePreview> {
  const { data, error } = await admin.rpc("company_merge_preview", {
    p_primary: primary,
    p_secondary: secondary,
    p_actor: actorId,
  });
  if (error) throw error;
  if (!isRecord(data) || typeof data.snapshot !== "string" || !Array.isArray(data.fields)) {
    throw new AdminApiError("The company merge preview returned an invalid response.", 503);
  }
  return data as unknown as CompanyMergePreview;
}

export async function GET(request: Request) {
  try {
    const { admin, actor } = await requireModulePermission(request, "company_merge", "manage");
    const url = new URL(request.url);
    const primaryValue = url.searchParams.get("primary");
    const secondaryValue = url.searchParams.get("secondary");

    if (primaryValue !== null || secondaryValue !== null) {
      const primary = parseId(primaryValue);
      const secondary = parseId(secondaryValue);
      if (!primary || !secondary || primary === secondary) {
        return responseError("Choose two distinct, valid company IDs.", 400);
      }
      const preview = await getPreview(admin, primary, secondary, actor.id);
      return Response.json(preview, { headers: { "Cache-Control": "no-store" } });
    }

    const search = (url.searchParams.get("search") ?? "").trim();
    if (!search || search.length > 80 || (!/^\d+$/.test(search) && search.length < 2)) {
      return responseError("Enter a company name (at least 2 characters) or numeric ID.", 400);
    }

    let query = admin.from("contractors")
      .select("id, company_name, city, state, active")
      .is("merged_into_contractor_id", null)
      .order("company_name")
      .limit(SEARCH_LIMIT);
    if (/^\d+$/.test(search)) {
      const id = parseId(search);
      if (!id) return Response.json({ candidates: [] });
      query = query.eq("id", id);
    } else {
      const escaped = search.replace(/[\\%_]/g, "\\$&");
      query = query.ilike("company_name", `%${escaped}%`);
    }
    const { data, error } = await query;
    if (error) throw error;
    return Response.json({ candidates: data ?? [] }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return mapApiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const { admin, actor } = await requireModulePermission(request, "company_merge", "manage");
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return responseError("Request body must be valid JSON.", 400);
    }
    if (!isRecord(body)) return responseError("Request body must be an object.", 400);
    const allowedKeys = new Set(["primary", "secondary", "snapshot", "choices", "compliance", "primary_contact", "operation", "confirmed"]);
    if (Object.keys(body).some((key) => !allowedKeys.has(key))) return responseError("Request contains unexpected fields.", 400);
    const primary = Number.isSafeInteger(body.primary) && (body.primary as number) > 0 ? body.primary as number : null;
    const secondary = Number.isSafeInteger(body.secondary) && (body.secondary as number) > 0 ? body.secondary as number : null;
    if (!primary || !secondary || primary === secondary) return responseError("Choose two distinct, valid company IDs.", 400);
    if (typeof body.snapshot !== "string" || body.snapshot.length < 1 || body.snapshot.length > 20000) return responseError("A valid preview snapshot is required.", 400);
    if (body.confirmed !== true) return responseError("Explicit confirmation is required before merging.", 400);
    if (typeof body.operation !== "string" || !UUID_PATTERN.test(body.operation)) return responseError("A valid operation ID is required.", 400);
    if (!isRecord(body.choices) || !isRecord(body.compliance)) return responseError("Merge choices are required.", 400);

    const rawChoices = body.choices as Record<string, unknown>;
    const rawCompliance = body.compliance as Record<string, unknown>;
    const choiceKeys = Object.keys(rawChoices);
    if (!choiceKeys.length || choiceKeys.length > 100 || choiceKeys.some((key) => !/^[a-z][a-z0-9_]{0,63}$/.test(key))
      || choiceKeys.some((key) => rawChoices[key] !== "primary" && rawChoices[key] !== "secondary")) {
      return responseError("Merge choices must map known field names to primary or secondary.", 400);
    }
    const complianceKeys = Object.keys(rawCompliance);
    if (complianceKeys.length > 100 || complianceKeys.some((key) => !/^[1-9]\d*$/.test(key))
      || complianceKeys.some((key) => !Number.isSafeInteger(rawCompliance[key]) || (rawCompliance[key] as number) <= 0)) {
      return responseError("Compliance choices must map type IDs to valid record IDs.", 400);
    }
    const primaryContact = body.primary_contact;
    if (primaryContact !== null && (typeof primaryContact !== "string" || !UUID_PATTERN.test(primaryContact))) {
      return responseError("Choose a primary contact from the preview, or leave it empty when none is required.", 400);
    }

    let preview: CompanyMergePreview | null = null;
    try {
      preview = await getPreview(admin, primary, secondary, actor.id);
    } catch (previewError) {
      const { code } = errorParts(previewError);
      if (code !== "55000" && code !== "40001") throw previewError;
    }
    if (preview && !preview.blockers.length) {
      if (!Array.isArray(preview.fields) || !Array.isArray(preview.compliance) || !Array.isArray(preview.contacts)) {
        throw new AdminApiError("The company merge preview returned an invalid response.", 503);
      }
      const validFields = new Set(preview.fields);
      if (Object.keys(rawChoices).length !== validFields.size
        || Object.keys(rawChoices).some((field) => !validFields.has(field))) {
        return responseError("Every mergeable field must have a valid primary or secondary choice.", 400);
      }
      const validTypes = new Map(preview.compliance.map((entry) => [String(entry.compliance_type_id), new Set(entry.records.map((record) => record.id))]));
      if (Object.keys(rawCompliance).length !== validTypes.size
        || Object.keys(rawCompliance).some((typeId) => !validTypes.has(typeId))) {
        return responseError("Select one compliance record for every compliance type.", 400);
      }
      for (const [typeId, availableIds] of validTypes) {
        if (!availableIds.has(rawCompliance[typeId] as number)) {
          return responseError("Each compliance selection must match a record shown in the preview.", 400);
        }
      }
      if (primaryContact !== null && !preview.contacts.some((contact) => contact.id === primaryContact && contact.is_active)) {
        return responseError("Choose an active primary contact from the preview.", 400);
      }
    }

    const { data, error } = await admin.rpc("company_merge_execute", {
      p_primary: primary,
      p_secondary: secondary,
      p_snapshot: body.snapshot,
      p_choices: body.choices as CompanyMergeChoices,
      p_compliance: body.compliance as CompanyMergeComplianceChoices,
      p_primary_contact: primaryContact,
      p_operation: body.operation,
      p_confirmed: true,
      p_actor: actor.id,
    });
    if (error) throw error;
    if (!isRecord(data) || typeof data.merge_id !== "string" || !Number.isSafeInteger(data.successor_id)) {
      throw new AdminApiError("The company merge operation returned an invalid response.", 503);
    }
    return Response.json(data as unknown as CompanyMergeResult, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return mapApiError(error);
  }
}
