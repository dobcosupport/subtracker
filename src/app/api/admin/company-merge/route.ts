import { AdminApiError, requireModulePermission } from "@/lib/server-admin";
import type {
  CompanyMergeChoices,
  CompanyMergeBlockerDetail,
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

async function readRows<T>(
  query: PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  label: string
): Promise<T[]> {
  const { data, error } = await query;
  if (error) throw new AdminApiError(`Unable to load ${label} blocker details: ${error.message}`, 503);
  return data ?? [];
}

async function getBlockerDetails(
  admin: Awaited<ReturnType<typeof requireModulePermission>>["admin"],
  preview: CompanyMergePreview
): Promise<CompanyMergeBlockerDetail[]> {
  const details: CompanyMergeBlockerDetail[] = [];
  const contractorIds = [preview.primary.id, preview.secondary.id];
  const companies = new Map([
    [preview.primary.id, preview.primary.company_name],
    [preview.secondary.id, preview.secondary.company_name],
  ]);
  const add = (input: CompanyMergeBlockerDetail) => details.push(input);
  const companyFields = (contractorId: number | null) => ({
    company_id: contractorId,
    company_name: contractorId === null ? null : companies.get(contractorId) ?? null,
  });
  const syncBlocker = preview.blockers.find((blocker) => blocker.startsWith("Open sync review or exception."));
  const pendingSearchBlocker = preview.blockers.find((blocker) => blocker.startsWith("Pending or in-flight registry search."));
  const brcSearchBlocker = preview.blockers.find((blocker) => blocker.startsWith("Actionable immutable NJ BRC request."));
  const importBlocker = preview.blockers.find((blocker) => blocker.startsWith("An unfinished import explicitly selects a predecessor."));
  const communicationBlocker = preview.blockers.find((blocker) => blocker.startsWith("Affected draft or in-flight communication."));
  const followupBlocker = preview.blockers.find((blocker) => blocker.startsWith("Open follow-up or unsent reminder."));
  const tieredCycleBlocker = preview.blockers.find((blocker) => blocker.startsWith("Tiered relationship union would create a cycle through the merged company."));
  const resolution = (path: string, label: string) => ({ resolution_path: path, resolution_label: label });

  if (syncBlocker) {
    const [reviews, pwcExceptions, syncExceptions] = await Promise.all([
      readRows(admin.from("compliance_sync_review_queue")
        .select("id,contractor_id,compliance_name,status,proposed_registration_number,proposed_status,proposed_expiration_date,current_registration_number,current_expiration_date,created_at")
        .in("contractor_id", contractorIds).eq("status", "pending"), "compliance sync reviews"),
      readRows(admin.from("nj_pwc_sync_exceptions")
        .select("id,contractor_id,is_test,reason,kind,status,consecutive_failure_count,occurrences,last_run_id,last_search_request_id,review_queue_id,details,updated_at")
        .in("contractor_id", contractorIds).eq("status", "open"), "NJ PWC sync exceptions"),
      readRows(admin.from("compliance_sync_exceptions")
        .select("id,contractor_id,compliance_name,exception_type,message,resolved,created_at")
        .in("contractor_id", contractorIds).eq("resolved", false), "compliance sync exceptions"),
    ]);
    const requestIds = [...new Set(pwcExceptions.map((row) => row.last_search_request_id).filter((id): id is number => id !== null))];
    const requests = requestIds.length ? await readRows(admin.from("compliance_sync_search_requests")
      .select("id,status,result_status,searched_company_name,searched_zip_code,searched_city,searched_state,search_variation,origin,candidates,completed_at,imported_at,selected_candidate,sync_run_id")
      .in("id", requestIds), "NJ PWC exception search requests") : [];
    const requestsById = new Map(requests.map((row) => [row.id, row]));
    const selectableRequests = new Set(requests.filter((request) =>
      request.status === "completed" && request.completed_at && !request.imported_at
      && ["Match Found", "Multiple Matches"].includes(request.result_status ?? "")
      && Array.isArray(request.candidates) && request.candidates.some((candidate: unknown) =>
        isRecord(candidate) && typeof candidate.business_name === "string" && candidate.business_name.trim()
        && typeof candidate.certificate_number === "string" && candidate.certificate_number.replace(/[\s-]/g, "")))
      .map((request) => request.id));
    for (const row of reviews) add({
      blocker: syncBlocker, ...companyFields(row.contractor_id), source: "Compliance Sync",
      record_type: `${row.compliance_name} Review`, record_id: row.id, status: row.status,
      reason: row.proposed_status ?? "Pending review",
      context: `Current registration: ${row.current_registration_number ?? "not recorded"}; proposed registration: ${row.proposed_registration_number ?? "not provided"}.`,
      ...resolution("/admin/compliance-sync", "Open Compliance Sync → Reviews"),
    });
    for (const row of pwcExceptions) {
      const request = row.last_search_request_id ? requestsById.get(row.last_search_request_id) : null;
      const requestCandidates = Array.isArray(request?.candidates) ? request.candidates.filter(isRecord) : [];
      const candidateCount = requestCandidates.length || row.details?.candidate_count;
      const candidateSummary = requestCandidates.slice(0, 3).flatMap((candidate) => {
        const businessName = typeof candidate.business_name === "string" ? candidate.business_name : null;
        const certificateNumber = typeof candidate.certificate_number === "string" ? candidate.certificate_number : null;
        return businessName && certificateNumber ? [`${businessName} (${certificateNumber})`] : [];
      }).join("; ");
      const selectedCandidate = isRecord(request?.selected_candidate) ? request.selected_candidate : null;
      const selectedMatch = selectedCandidate
        ? [selectedCandidate.business_name, selectedCandidate.certificate_number].filter((value) => typeof value === "string" && value.trim()).join(" · ") || "Yes"
        : request?.imported_at ? "Yes (candidate processed)" : null;
      const exceptionPath = "/admin/compliance-sync";
      const resolutionActions = [
        ...(request && selectableRequests.has(request.id) && !request.imported_at && !selectedCandidate && row.reason === "Multiple Matches" ? [{
          label: "Select Match",
          guidance: "Only select a candidate if you have evidence it is this contractor.",
          href: exceptionPath,
        }] : []),
        ...(!request?.origin || request.origin !== "exception_retry" || !["pending", "claimed", "processing"].includes(request.status) ? [{
          label: "Run Search Again",
          guidance: "Consider this after correcting company information or when a new search could return a different result.",
          href: exceptionPath,
        }] : []),
        {
          label: "Resolve Exception",
          guidance: "Use when the search has been reviewed and no valid registration match should be assigned.",
          href: exceptionPath,
        },
        {
          label: "Open Contractor",
          guidance: "Review or correct the contractor's company information before searching again.",
          href: `/contractors/${row.contractor_id}`,
        },
      ];
      add({
        blocker: syncBlocker, ...companyFields(row.contractor_id), source: "NJ PWC",
        record_type: "NJ PWC Sync Exception", record_id: row.id, status: row.status,
        reason: row.reason,
        context: `${row.kind}${row.is_test ? " · Test record" : " · Production record"} · ${row.consecutive_failure_count} consecutive failures · ${row.occurrences} occurrences${candidateSummary ? ` · Candidates: ${candidateSummary}` : ""}.`,
        ...resolution(exceptionPath, "Open Compliance Sync → NJ PWC Sync Exceptions"),
        resolution_actions: resolutionActions,
        nj_pwc: {
          search_request_id: request?.id ?? row.last_search_request_id,
          sync_run_id: row.last_run_id ?? request?.sync_run_id ?? null,
          searched_company_name: request?.searched_company_name ?? null,
          searched_city: request?.searched_city ?? null,
          searched_state: request?.searched_state ?? null,
          searched_zip_code: request?.searched_zip_code ?? null,
          candidate_count: typeof candidateCount === "number" ? candidateCount : null,
          selected_match: selectedMatch,
        },
      });
    }
    for (const row of syncExceptions) add({
      blocker: syncBlocker, ...companyFields(row.contractor_id), source: "Compliance Sync",
      record_type: `${row.compliance_name ?? "Compliance"} Sync Exception`, record_id: row.id,
      status: row.resolved ? "resolved" : "open", reason: row.exception_type, context: row.message,
      ...resolution("/admin/compliance-sync", "Open Compliance Sync"),
    });
  }

  if (pendingSearchBlocker) {
    const rows = await readRows(admin.from("compliance_sync_search_requests")
      .select("id,contractor_id,compliance_name,status,result_status,searched_company_name,origin,created_at")
      .in("contractor_id", contractorIds).in("status", ["pending", "claimed", "processing"]), "registry search requests");
    for (const row of rows) add({
      blocker: pendingSearchBlocker, ...companyFields(row.contractor_id), source: "Compliance Sync",
      record_type: `${row.compliance_name} Registry Search`, record_id: row.id, status: row.status,
      reason: row.result_status, context: `${row.origin} · ${row.searched_company_name}`,
      ...resolution("/admin/compliance-sync", "Open Compliance Sync"),
    });
  }

  if (brcSearchBlocker) {
    const rows = await readRows(admin.from("nj_brc_search_requests")
      .select("id,contractor_id,company_name,nj_brc_number,status,created_at")
      .in("contractor_id", contractorIds)
      .in("status", ["pending", "claimed", "processing", "human_verification_required", "review_required"]), "NJ BRC search requests");
    for (const row of rows) add({
      blocker: brcSearchBlocker, ...companyFields(row.contractor_id), source: "NJ BRC",
      record_type: "NJ BRC Search Request", record_id: row.id, status: row.status,
      reason: row.status === "review_required" || row.status === "human_verification_required" ? "Human review required" : null,
      context: `${row.company_name} · NJ BRC ${row.nj_brc_number ?? "not provided"}`,
      ...resolution("/admin/compliance-sync", "Open Compliance Sync → NJ BRC"),
    });
  }

  if (importBlocker) {
    const [mycoiRuns, procoreRuns] = await Promise.all([
      readRows(admin.from("mycoi_import_runs").select("id,file_name,status,revision,finalized_at,decisions,updated_at").is("finalized_at", null), "unfinished MyCOI imports"),
      readRows(admin.from("procore_import_runs").select("id,file_name,status,revision,finalized_at,decisions,updated_at").is("finalized_at", null), "unfinished Procore imports"),
    ]);
    for (const run of mycoiRuns) {
      for (const [vendor, decision] of Object.entries(run.decisions?.vendors ?? {})) {
        const contractorId = typeof decision === "number" ? decision : Number(decision);
        if (!contractorIds.includes(contractorId)) continue;
        add({
          blocker: importBlocker, ...companyFields(contractorId), source: "MyCOI",
          record_type: "Unfinished MyCOI Import", record_id: run.id, status: run.status ?? "unfinished",
          reason: `Saved MATCH decision for ${vendor}`,
          context: `${run.file_name} · Revision ${run.revision} · Updated ${run.updated_at}`,
          ...resolution("/imports", "Open Imports → MyCOI"),
        });
      }
    }
    for (const run of procoreRuns) {
      for (const [vendor, decision] of Object.entries(run.decisions?.vendors ?? {})) {
        if (!isRecord(decision) || decision.action !== "MATCH") continue;
        const contractorId = Number(decision.contractorId);
        if (!contractorIds.includes(contractorId)) continue;
        add({
          blocker: importBlocker, ...companyFields(contractorId), source: "Procore",
          record_type: "Unfinished Procore Import", record_id: run.id, status: run.status ?? "unfinished",
          reason: `Saved MATCH decision for ${vendor}`,
          context: `${run.file_name} · Revision ${run.revision} · Updated ${run.updated_at}`,
          ...resolution("/imports", "Open Imports → Procore"),
        });
      }
    }
  }

  if (followupBlocker) {
    const [followups, reminders] = await Promise.all([
      readRows(admin.from("contractor_followups").select("id,contractor_id,status,subject,followup_date")
        .in("contractor_id", contractorIds).in("status", ["Open", "Waiting Response"]), "open follow-ups"),
      readRows(admin.from("reminders").select("id,contractor_id,sent_date,resolved_date,reminder_stage,scheduled_date,notes")
        .in("contractor_id", contractorIds).is("sent_date", null).is("resolved_date", null), "unsent reminders"),
    ]);
    for (const row of followups) add({
      blocker: followupBlocker, ...companyFields(row.contractor_id), source: "Company Follow-Up",
      record_type: "Open Follow-Up", record_id: row.id, status: row.status,
      reason: row.subject, context: `Follow-up date: ${row.followup_date}`,
      ...resolution(`/contractors/${row.contractor_id}`, "Open Company Card → Follow-Ups"),
    });
    for (const row of reminders) add({
      blocker: followupBlocker, ...companyFields(row.contractor_id), source: "Reminders",
      record_type: "Unsent Reminder", record_id: row.id, status: "unsent",
      reason: row.reminder_stage, context: `Scheduled ${row.scheduled_date}${row.notes ? ` · ${row.notes}` : ""}`,
      ...resolution(`/contractors/${row.contractor_id}`, "Open Company Card → Reminders"),
    });
  }

  if (communicationBlocker) {
    const [contractorLinks, insuranceLinks, contacts, complianceRecords, policies] = await Promise.all([
      readRows(admin.from("communication_contractors").select("message_id,contractor_id").in("contractor_id", contractorIds), "communication links"),
      readRows(admin.from("communication_insurance_items").select("message_id,contractor_id").in("contractor_id", contractorIds), "communication insurance links"),
      readRows(admin.from("contractor_contacts").select("id,contractor_id").in("contractor_id", contractorIds), "company communication contacts"),
      readRows(admin.from("compliance_records").select("id,contractor_id").in("contractor_id", contractorIds), "company communication compliance records"),
      readRows(admin.from("mycoi_policies").select("id,contractor_id").in("contractor_id", contractorIds), "company communication policies"),
    ]);
    const [recipientLinks, complianceLinks, policyLinks] = await Promise.all([
      contacts.length ? readRows(admin.from("communication_recipients").select("message_id,contractor_contact_id")
        .in("contractor_contact_id", contacts.map((row) => row.id)), "company message recipients") : [],
      complianceRecords.length ? readRows(admin.from("communication_compliance_items").select("message_id,compliance_record_id")
        .in("compliance_record_id", complianceRecords.map((row) => row.id)), "company compliance communications") : [],
      policies.length ? readRows(admin.from("communication_mycoi_items").select("message_id,policy_id")
        .in("policy_id", policies.map((row) => row.id)), "company MyCOI communications") : [],
    ]);
    const contactOwners = new Map(contacts.map((row) => [row.id, row.contractor_id]));
    const complianceOwners = new Map(complianceRecords.map((row) => [row.id, row.contractor_id]));
    const policyOwners = new Map(policies.map((row) => [row.id, row.contractor_id]));
    const owners = new Map<string, Set<number>>();
    const linkOwner = (messageId: string, contractorId: number) => {
      const ownerSet = owners.get(messageId) ?? new Set<number>();
      ownerSet.add(contractorId);
      owners.set(messageId, ownerSet);
    };
    for (const row of [...contractorLinks, ...insuranceLinks]) linkOwner(row.message_id, row.contractor_id);
    for (const row of recipientLinks) {
      const contractorId = contactOwners.get(row.contractor_contact_id);
      if (contractorId !== undefined) linkOwner(row.message_id, contractorId);
    }
    for (const row of complianceLinks) {
      const contractorId = complianceOwners.get(row.compliance_record_id);
      if (contractorId !== undefined) linkOwner(row.message_id, contractorId);
    }
    for (const row of policyLinks) {
      const contractorId = policyOwners.get(row.policy_id);
      if (contractorId !== undefined) linkOwner(row.message_id, contractorId);
    }
    const messageIds = [...owners.keys()];
    if (messageIds.length) {
      const messages = await readRows(admin.from("communication_messages")
        .select("id,status,channel,subject,created_at").in("id", messageIds).in("status", ["Draft", "Queued", "Sending"]), "affected communications");
      for (const row of messages) {
        for (const contractorId of owners.get(row.id) ?? [null]) add({
            blocker: communicationBlocker, ...companyFields(contractorId), source: "Communications",
            record_type: `${row.channel} Message`, record_id: row.id, status: row.status,
            reason: row.subject ?? "No subject", context: `Created ${row.created_at}`,
            ...resolution("/communications", "Open Communications"),
          });
      }
    }
  }

  if (tieredCycleBlocker) {
    const edges = await readRows(admin.from("contractor_tiered_subs")
      .select("id,contractor_id,tiered_sub_contractor_id").eq("active", true), "active tiered relationships");
    const normalized = edges.map((edge) => ({
      ...edge,
      parent_id: contractorIds.includes(edge.contractor_id) ? 0 : edge.contractor_id,
      child_id: contractorIds.includes(edge.tiered_sub_contractor_id) ? 0 : edge.tiered_sub_contractor_id,
    }));
    const outgoing = new Map<number, typeof normalized>();
    for (const edge of normalized) outgoing.set(edge.parent_id, [...(outgoing.get(edge.parent_id) ?? []), edge]);
    const findCycle = (node: number, seen: Set<number>, path: typeof normalized): typeof normalized | null => {
      if (node === 0) return path;
      if (seen.has(node)) return null;
      for (const edge of outgoing.get(node) ?? []) {
        const result = findCycle(edge.child_id, new Set([...seen, node]), [...path, edge]);
        if (result) return result;
      }
      return null;
    };
    const cycle = normalized.filter((edge) => edge.parent_id === 0 && edge.child_id !== 0)
      .map((edge) => findCycle(edge.child_id, new Set([0]), [edge])).find((path) => path !== null) ?? [];
    for (const edge of cycle) {
      const companyId = contractorIds.includes(edge.contractor_id) ? edge.contractor_id
        : contractorIds.includes(edge.tiered_sub_contractor_id) ? edge.tiered_sub_contractor_id : null;
      add({
        blocker: tieredCycleBlocker, ...companyFields(companyId), source: "Tiered Subs",
        record_type: "Active Tiered Relationship", record_id: edge.id, status: "active",
        reason: `Contractor #${edge.contractor_id} → Tiered Sub #${edge.tiered_sub_contractor_id}`,
        context: "This active relationship is part of the cycle involving the selected companies.",
        ...resolution(`/contractors/${companyId ?? contractorIds[0]}`, "Open Company Card → Tiered Subs"),
      });
    }
  }

  return details;
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
  const preview = data as unknown as CompanyMergePreview;
  return { ...preview, blockerDetails: await getBlockerDetails(admin, preview) };
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
