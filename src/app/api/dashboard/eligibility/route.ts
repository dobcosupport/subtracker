import { AdminApiError, jsonError, requireModulePermission } from "@/lib/server-admin";
import { calculateOverallContractorCompliance, type ScopedComplianceContractor, type ScopedRequirementStatus } from "@/services/style3-overall-compliance";

type EligibilityRow = { contractor_id: number; company_name: string; applicability: "applicable" | "not_applicable" | "unknown" };
type RequirementRow = { id: number; compliance_name: string; requires_expiration: boolean };
type RuleRow = { compliance_type_id: number | null; eligibility_authority: string };
type StatusRow = { contractor_id: number; compliance_record_id: number | null; compliance_type_id: number | null;
  expiration_date: string | null; days_remaining: number | null; calculated_status: string; registration_number: string | null };
type ContractorScopeRow = { id: number; state: string | null; federal_tax_id: string | null; nj_brc_number: string | null };
type CurrentRegistrationRow = ScopedRequirementStatus;

async function allRows<T>(read: (start: number, end: number) => PromiseLike<{
  data: T[] | null; error: { message: string } | null;
}>): Promise<T[]> {
  const rows: T[] = [];
  for (let offset = 0; ; offset += 500) {
    const result = await read(offset, offset + 499);
    if (result.error || !result.data) throw new AdminApiError(result.error?.message ?? "Dashboard data could not be read.", 503);
    rows.push(...result.data);
    if (result.data.length < 500) return rows;
  }
}

export async function GET(request: Request) {
  try {
    const { admin, profile } = await requireModulePermission(request, "dashboard", "view");
    if (!profile.system_administrator) {
      const modules = ["contractors", "projects", "compliance"];
      const { data: permissions, error } = await admin.from("role_permissions")
        .select("module,can_view").eq("role", profile.role).in("module", modules);
      if (error) throw new AdminApiError(error.message, 503);
      if (!permissions || modules.some(module => !permissions.some(permission => permission.module === module && permission.can_view))) {
        throw new AdminApiError("Dashboard eligibility requires Contractors, Projects and Compliance access.", 403);
      }
    }
    const rows: EligibilityRow[] = [];
    let after = 0;
    for (;;) {
      const { data, error } = await admin.rpc("dashboard_nj_pwc_eligibility", { p_after_id: after, p_limit: 500 });
      if (error) throw new AdminApiError(`Dashboard eligibility unavailable: ${error.message}`, 503);
      if (!Array.isArray(data)) throw new AdminApiError("Dashboard eligibility returned an invalid result.", 503);
      for (const row of data as EligibilityRow[]) {
        if (!Number.isInteger(row.contractor_id) || row.contractor_id <= after || typeof row.company_name !== "string"
          || !["applicable", "not_applicable", "unknown"].includes(row.applicability)) {
          throw new AdminApiError("Dashboard eligibility returned invalid or unordered data.", 503);
        }
        rows.push(row);
        after = row.contractor_id;
      }
      if (data.length < 500) break;
    }
    const [types, rules] = await Promise.all([
      allRows<RequirementRow>((a, b) => admin.from("compliance_types").select("id,compliance_name,requires_expiration")
        .eq("active", true).order("id").range(a, b).returns<RequirementRow[]>()),
      allRows<RuleRow>((a, b) => admin.from("requirement_notification_rules").select("compliance_type_id,eligibility_authority")
        .eq("eligibility_authority", "nj_pwc_monitoring").order("id").range(a, b).returns<RuleRow[]>()),
    ]);
    const contractorFields: ContractorScopeRow[] = [];
    const currentBrc: CurrentRegistrationRow[] = [];
    const populationIds = rows.map(row => row.contractor_id);
    for (let start = 0; start < populationIds.length; start += 100) {
      const batch = populationIds.slice(start, start + 100);
      const [contractorResult, brcResult] = await Promise.all([
        admin.from("contractors").select("id,state,federal_tax_id,nj_brc_number").in("id", batch)
          .returns<ContractorScopeRow[]>(),
        admin.from("contractor_compliance_status")
          .select("contractor_id,compliance_name,calculated_status,registration_number,days_remaining")
          .in("contractor_id", batch).eq("compliance_name", "NJ BRC").order("contractor_id").order("compliance_record_id")
          .returns<CurrentRegistrationRow[]>(),
      ]);
      if (contractorResult.error || !contractorResult.data) {
        throw new AdminApiError(contractorResult.error?.message ?? "Unable to load Dashboard contractor requirements.", 503);
      }
      if (brcResult.error || !brcResult.data) {
        throw new AdminApiError(brcResult.error?.message ?? "Unable to load current NJ BRC records.", 503);
      }
      contractorFields.push(...contractorResult.data);
      currentBrc.push(...brcResult.data);
    }
    const contractorFieldMap = new Map(contractorFields.map(row => [row.id, row]));
    if (contractorFieldMap.size !== populationIds.length) {
      throw new AdminApiError("Dashboard contractor requirement inputs are incomplete.", 503);
    }
    const knownTypeIds = rules.flatMap(rule => rule.compliance_type_id === null ? [] : [rule.compliance_type_id]);
    const ids = rows.filter(row => row.applicability === "applicable").map(row => row.contractor_id);
    const statuses: StatusRow[] = [];
    if (knownTypeIds.length) for (let start = 0; start < ids.length; start += 100) {
      for (let offset = 0; ; offset += 500) {
        const result = await admin.from("contractor_compliance_status")
          .select("contractor_id,compliance_record_id,compliance_type_id,expiration_date,days_remaining,calculated_status,registration_number")
          .in("contractor_id", ids.slice(start, start + 100)).in("compliance_type_id", knownTypeIds)
          .order("contractor_id").order("compliance_record_id").range(offset, offset + 499).returns<StatusRow[]>();
        if (result.error || !result.data) throw new AdminApiError(result.error?.message ?? "Unable to load current compliance.", 503);
        statuses.push(...result.data);
        if (result.data.length < 500) break;
      }
    }
    const scopeContractors: ScopedComplianceContractor[] = rows.map(row => {
      const fields = contractorFieldMap.get(row.contractor_id);
      if (!fields) throw new AdminApiError("Dashboard contractor requirement inputs are incomplete.", 503);
      return { contractor_id: row.contractor_id, state: fields.state, federal_tax_id: fields.federal_tax_id,
        nj_brc_number: fields.nj_brc_number, nj_pwc_applicability: row.applicability };
    });
    const statusRows: CurrentRegistrationRow[] = [
      ...currentBrc,
      ...statuses.flatMap(row => {
        const type = types.find(item => item.id === row.compliance_type_id);
        return type?.compliance_name === "NJ PWC" ? [{
          contractor_id: row.contractor_id, compliance_name: "NJ PWC" as const, calculated_status: row.calculated_status,
          registration_number: row.registration_number, days_remaining: row.days_remaining,
        }] : [];
      }),
    ];
    const overall_compliance = calculateOverallContractorCompliance(scopeContractors, statusRows);
    return Response.json({ contractors: rows, requirements: types, known_type_ids: knownTypeIds, statuses, overall_compliance },
      { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return jsonError(error);
  }
}
