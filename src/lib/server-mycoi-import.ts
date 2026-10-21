import "server-only";
import { AdminApiError, requireModulePermission, type AdminContext } from "@/lib/server-admin";
import { buildMycoiPreview, blankDecisions, mycoiKey } from "@/lib/mycoi-preview";
import type { ImportDecisions, ImportReference, MycoiImportRun } from "@/types/mycoi-import";

export async function mycoiContext(request: Request, write = false): Promise<AdminContext> {
  const context = await requireModulePermission(request, "imports", "view");
  if (context.profile.system_administrator) return context;
  const { data, error } = await context.admin.from("role_permissions")
    .select("module, can_view, can_add, can_edit").eq("role", context.profile.role);
  if (error) throw new AdminApiError(error.message, 503);
  for (const moduleName of ["imports", "insurance", "contractors", "projects"]) {
    const permission = data?.find((row) => row.module === moduleName);
    if (!permission?.can_view || (write && ["imports", "insurance"].includes(moduleName) && (!permission.can_add || !permission.can_edit))) {
      throw new AdminApiError(`myCOI requires ${moduleName} View${write && ["imports", "insurance"].includes(moduleName) ? ", Add and Edit" : ""} permission.`, 403);
    }
  }
  return context;
}

export async function mycoiReference(context: AdminContext): Promise<ImportReference> {
  const { data, error } = await context.admin.rpc("mycoi_import_reference");
  if (error) throw new AdminApiError(`Unable to load myCOI reference data: ${error.message}`, 503);
  return data as ImportReference;
}

export async function mycoiRun(context: AdminContext, id: string): Promise<MycoiImportRun> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new AdminApiError("Invalid import run ID.", 400);
  const { data, error } = await context.admin.from("mycoi_import_runs").select("*").eq("id", id).single();
  if (error || !data) throw new AdminApiError(error?.message ?? "Import run not found.", 404);
  return data as MycoiImportRun;
}

export function validateDecisions(value: unknown, run: MycoiImportRun): ImportDecisions {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AdminApiError("Invalid review decisions.", 400);
  const input = value as Record<string, unknown>;
  const result = blankDecisions();
  if (input.addContractors !== undefined) {
    if (!Array.isArray(input.addContractors) || input.addContractors.some((key) =>
      typeof key !== "string" || !run.source_rows.some((row) => mycoiKey(row["Vendor Name"]) === key)
      || ["__proto__", "constructor", "prototype"].includes(key))) {
      throw new AdminApiError("Invalid Add Contractor decisions.", 400);
    }
    result.addContractors = [...new Set(input.addContractors as string[])];
  }
  for (const field of ["vendors", "divisions", "contacts"] as const) {
    const choices = input[field];
    if (!choices || typeof choices !== "object" || Array.isArray(choices)) throw new AdminApiError(`Invalid ${field} decisions.`, 400);
    const keys = new Set(run.source_rows.map((row) => mycoiKey(row[field === "divisions" ? "Division Name" : "Vendor Name"])));
    for (const [key, selection] of Object.entries(choices)) {
      if (!keys.has(key) || ["__proto__", "constructor", "prototype"].includes(key)) throw new AdminApiError("Unknown source mapping key.", 400);
      if (field === "contacts") {
        if (!selection || typeof selection !== "object" || Array.isArray(selection)) throw new AdminApiError("Invalid contact decision.", 400);
        const contact: ImportDecisions["contacts"][string] = {};
        for (const [name, text] of Object.entries(selection)) {
          if (!["email", "phone"].includes(name) || typeof text !== "string" || text.length > 2000) throw new AdminApiError("Invalid contact selection.", 400);
          contact[name as "email" | "phone"] = text;
        }
        result.contacts[key] = contact;
      } else {
        if (!Number.isSafeInteger(selection) || Number(selection) <= 0) throw new AdminApiError("Choose an existing mapping ID.", 400);
        result[field][key] = Number(selection);
      }
    }
  }
  if (!Array.isArray(input.ignored) || input.ignored.some((id) => !Number.isSafeInteger(id) || !run.source_rows.some((row) => row.row === id) || run.imported_rows.includes(id))) {
    throw new AdminApiError("Invalid ignored source rows.", 400);
  }
  result.ignored = [...new Set(input.ignored as number[])];
  if (result.addContractors?.some((key) => result.vendors[key] != null)) {
    throw new AdminApiError("Choose either Match Existing Contractor or Add Contractor, not both.", 400);
  }
  return result;
}

export async function runResponse(context: AdminContext, run: MycoiImportRun) {
  const reference = await mycoiReference(context);
  return {
    run, preview: buildMycoiPreview(run.source_rows, run.decisions, reference, run.imported_rows),
    contractors: reference.contractors, projects: reference.projects, token: reference.token,
  };
}

export function mycoiAudits(context: AdminContext, run: MycoiImportRun, reference: ImportReference) {
  const preview = buildMycoiPreview(run.source_rows, run.decisions, reference, run.imported_rows);
  const base = { user_id: context.profile.auth_user_id, user_name: context.profile.name, user_email: context.profile.email };
  const mappings = preview.ready.flatMap((vendor) => [
    ...(!reference.vendors.some((item) => item.active && mycoiKey(item.raw_vendor_name) === vendor.key)
      ? [{ kind: "vendor", raw: vendor.raw, contractor_id: vendor.createContractor ? null : vendor.contractorId }] : []),
    ...vendor.divisions.filter((division) => !reference.divisions.some((item) => item.active && mycoiKey(item.raw_division_name) === division.key && item.project_id === division.projectId))
      .map((division) => ({ kind: "division", raw: division.raw, project_id: division.projectId })),
  ]);
  return [
    ...(mappings.length ? [{ ...base, action: "MYCOI_MAPPINGS_ACCEPTED", details: { mappings } }] : []),
    { ...base, action: "MYCOI_IMPORT_APPLIED", details: { source_rows: preview.ready.flatMap((vendor) => vendor.rows), ignored_rows: run.decisions.ignored, unresolved_rows: preview.summary.unresolvedRows } },
  ];
}
