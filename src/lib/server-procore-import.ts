import "server-only";
import { AdminApiError, requireModulePermission, type AdminContext } from "@/lib/server-admin";
import { buildProcorePreview, procoreIdentityCandidates, procoreVendorKey } from "@/lib/procore-preview";
import type { ProcoreChoice, ProcoreDecisions, ProcoreIdentityMatches, ProcoreReference, ProcoreResponse, ProcoreRun } from "@/types/procore-import";

export async function procoreContext(request: Request, write = false): Promise<AdminContext> {
  const context = await requireModulePermission(request, "imports", "view");
  if (!context.profile.system_administrator) {
    const { data, error } = await context.admin.from("role_permissions")
      .select("module,can_view,can_add,can_edit,can_manage").eq("role", context.profile.role);
    if (error) throw new AdminApiError(error.message, 503);
    for (const moduleName of ["imports", "contractors", "projects"]) {
      const permission = data?.find((p) => p.module === moduleName);
      if (!permission?.can_view || (write && (moduleName === "contractors"
        ? !permission.can_manage : !permission.can_add || !permission.can_edit))) {
        throw new AdminApiError(`Procore requires ${moduleName} View${write ? moduleName === "contractors" ? " and Manage" : ", Add and Edit" : ""} permission.`, 403);
      }
    }
  }
  return context;
}

export function procoreError(error: { message: string; code?: string; details?: string } | null, atomicImport = false): void {
  if (atomicImport && error?.code === "57014" && /statement timeout/i.test(error.message)) {
    throw new AdminApiError("Procore import timed out. The import transaction was rolled back; no import changes were committed. Your saved review decisions and project mappings were not cleared. Do not retry until the timeout has been reviewed.", 503);
  }
  if (error?.code === "SI409") {
    // Central contractor identity check (SQLSTATE SI409, JSON DETAIL). Nothing was committed.
    let matches: { contractor_id?: number; company_name?: string }[] = [];
    try { const detail = JSON.parse(error.details ?? "{}"); if (Array.isArray(detail.matches)) matches = detail.matches; } catch { /* message only */ }
    const names = matches.filter((m) => m.contractor_id).slice(0, 5).map((m) => `${m.company_name ?? "Contractor"} (#${m.contractor_id})`);
    throw new AdminApiError(`Procore import: ${error.message}${names.length ? `: ${names.join("; ")}` : ""}. No changes were committed; reload the review.`, 409);
  }
  if (error) throw new AdminApiError(`Procore import: ${error.message}${["PGRST202", "PGRST205", "42P01", "42703"].includes(error.code ?? "")
    ? ". Requires the Procore migrations, including 20261112_procore_project_mappings.sql; install before deploying dependent code." : ""}`,
    error.code === "40001" ? 409 : error.code === "42501" ? 403 : 503);
}

export async function procoreReference(context: AdminContext): Promise<ProcoreReference> {
  const { data, error } = await context.admin.rpc("procore_import_reference");
  procoreError(error);
  if (!data || !Array.isArray(data.contractors) || !Array.isArray(data.projects) || !Array.isArray(data.contacts) ||
    !Array.isArray(data.projectMappings) || !data.token) {
    throw new AdminApiError("Procore reference data is unavailable. Requires 20261112_procore_project_mappings.sql before deploying dependent code.", 503);
  }
  return data as ProcoreReference;
}

export async function procoreRun(context: AdminContext, id: string): Promise<ProcoreRun> {
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(id)) throw new AdminApiError("Invalid Procore import ID.", 400);
  const { data, error } = await context.admin.from("procore_import_runs").select("*").eq("id", id).maybeSingle();
  procoreError(error);
  if (!data) throw new AdminApiError("Procore import not found.", 404);
  return data as ProcoreRun;
}

export function workingProcore(run: ProcoreRun) {
  if (run.finalized_at) throw new AdminApiError("This Procore import is Finalized and read-only.", 409);
}

export function validateProcoreDecisions(value: unknown, run: ProcoreRun): ProcoreDecisions {
  if (!value || typeof value !== "object" || Array.isArray(value) || !("vendors" in value) ||
    Object.keys(value).some((key) => key !== "vendors") || !value.vendors || typeof value.vendors !== "object" || Array.isArray(value.vendors)) {
    throw new AdminApiError("Invalid Procore review decisions.", 400);
  }
  const keys = new Set(run.source_rows.map((r) => procoreVendorKey(r["Company (Vendor) > Name"])));
  const vendors: Record<string, ProcoreChoice> = {};
  for (const [key, choice] of Object.entries(value.vendors)) {
    if (!keys.has(key) || ["__proto__", "constructor", "prototype"].includes(key) || !choice ||
      typeof choice !== "object" || Array.isArray(choice) || !("action" in choice)) throw new AdminApiError("Unknown Procore vendor decision.", 400);
    if (choice.action === "MATCH" && "contractorId" in choice && Number.isSafeInteger(choice.contractorId) &&
      Number(choice.contractorId) > 0 && Object.keys(choice).every((k) => ["action", "contractorId"].includes(k))) {
      vendors[key] = { action: "MATCH", contractorId: Number(choice.contractorId) };
    } else if (choice.action === "ADD" && "duplicateOverride" in choice &&
      Object.keys(choice).every((k) => ["action", "duplicateOverride"].includes(k))) {
      const override = choice.duplicateOverride;
      if (!override || typeof override !== "object" || Array.isArray(override) ||
        !("contractorId" in override) || !Number.isSafeInteger(override.contractorId) || Number(override.contractorId) <= 0 ||
        !("companyName" in override) || typeof override.companyName !== "string" || !override.companyName.trim() ||
        override.companyName.length > 250 ||
        Object.keys(override).some((k) => !["contractorId", "companyName", "approvedBy", "approvedAt"].includes(k))) {
        throw new AdminApiError("Invalid duplicate-name override. Review the existing contractor again.", 400);
      }
      // Approval identity/time are minted or retained by the save RPC, never trusted from the client.
      vendors[key] = { action: "ADD", duplicateOverride: {
        contractorId: Number(override.contractorId), companyName: override.companyName,
      } };
    } else if (choice.action === "ADD" && "identityReview" in choice &&
      Object.keys(choice).every((k) => ["action", "identityReview"].includes(k))) {
      const review = choice.identityReview;
      const ids = review && typeof review === "object" && !Array.isArray(review) && "candidateIds" in review ? review.candidateIds : null;
      const reason = review && typeof review === "object" && "reason" in review && typeof review.reason === "string" ? review.reason.trim() : "";
      if (!review || typeof review !== "object" || Array.isArray(review) || !Array.isArray(ids) || !ids.length || ids.length > 100 ||
        ids.some((id) => !Number.isSafeInteger(id) || id <= 0 || id > 999999999) || reason.length < 3 || reason.length > 1000 ||
        Object.keys(review).some((k) => !["candidateIds", "reason", "decisionId", "approvedBy", "approvedAt"].includes(k))) {
        throw new AdminApiError("Different-company review requires the reviewed contractors and a reason of 3 to 1000 characters.", 400);
      }
      // The decision record, approver and time are minted or retained by the save RPC, never trusted from the client.
      vendors[key] = { action: "ADD", identityReview: {
        candidateIds: [...new Set(ids.map(Number))].sort((a, b) => a - b), reason,
      } };
    } else if ((choice.action === "ADD" || choice.action === "UNMATCHED") && Object.keys(choice).length === 1) {
      vendors[key] = { action: choice.action };
    } else throw new AdminApiError("Choose Match Contractor, Add Contractor or Leave Unmatched.", 400);
  }
  return { vendors };
}

/** Central contractor identity matches for unresolved vendors: one RPC per review response. */
export async function procoreIdentityMatches(context: AdminContext, run: ProcoreRun, reference: ProcoreReference): Promise<ProcoreIdentityMatches> {
  const candidates = procoreIdentityCandidates(run.source_rows, reference);
  if (!candidates.length) return {};
  const { data, error } = await context.admin.rpc("procore_identity_matches", { p_candidates: candidates });
  if (error && ["PGRST202", "42883"].includes(error.code ?? "")) {
    throw new AdminApiError("Procore contractor identity check is unavailable. Requires 20261203_contractor_identity_foundation.sql and 20261204_contractor_identity_procore.sql before deploying dependent code.", 503);
  }
  procoreError(error);
  if (!data || typeof data !== "object" || Array.isArray(data) || candidates.some((c) => !Array.isArray(data[c.candidate_key]))) {
    throw new AdminApiError("Procore contractor identity matches are unavailable; reload the review.", 503);
  }
  return data as ProcoreIdentityMatches;
}

export async function procorePreview(context: AdminContext, run: ProcoreRun, reference: ProcoreReference) {
  return buildProcorePreview(run.source_rows, run.decisions, reference, run.imported_rows,
    await procoreIdentityMatches(context, run, reference));
}

export async function procoreResponse(context: AdminContext, run: ProcoreRun): Promise<ProcoreResponse> {
  // The retained spreadsheet stays server-side; the UI reviews unique entities.
  const { source_rows: source, finalized_review: frozen, ...publicRun } = run;
  if (run.finalized_at) {
    if (!frozen) throw new AdminApiError("Finalized Procore review is unavailable.", 503);
    return { run: publicRun, ...frozen, token: "" };
  }
  void source;
  const reference = await procoreReference(context);
  return { run: publicRun, preview: await procorePreview(context, run, reference),
    contractors: reference.contractors, projects: reference.projects, token: reference.token };
}
