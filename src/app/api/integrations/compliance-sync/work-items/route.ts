import {
  isSyncableComplianceType,
  jsonError,
  requireRpaKey,
  SYNCABLE_COMPLIANCE_TYPES,
  type SyncableComplianceType,
} from "@/lib/server-compliance-sync";
import { validateNjBrcLookup } from "@/lib/server-nj-brc";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

export async function GET(request: Request) {
  try {
    const auth = await requireRpaKey(request);
    if (auth instanceof Response) return auth;
    const { admin } = auth;

    // Optional limit with a safe server-side maximum
    const url = new URL(request.url);
    const limitParam = url.searchParams.get("limit");
    let limit = DEFAULT_LIMIT;
    if (limitParam !== null) {
      const parsed = Number(limitParam);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return Response.json({ error: "limit must be a positive integer." }, { status: 400 });
      }
      limit = Math.min(Math.floor(parsed), MAX_LIMIT);
    }

    // Enabled sync types from Compliance Sync settings
    const { data: settings, error: settingsError } = await admin
      .from("compliance_sync_settings")
      .select("compliance_name, enabled")
      .eq("enabled", true);
    if (settingsError) throw settingsError;

    const enabledTypes = (settings ?? [])
      .map((setting) => setting.compliance_name)
      .filter(isSyncableComplianceType)
      .sort() as SyncableComplianceType[];

    if (enabledTypes.length === 0) {
      return Response.json({ work_items: [] });
    }

    // Active contractors only; alphabetical by company name; only RPA-needed fields
    const { data: contractors, error: contractorsError } = await admin
      .from("contractors")
      .select("id, company_name, address_1, address_2, city, state, zip_code, nj_pwc_number, nj_brc_number, ny_pwc_number, ny_brc_number, brc_name_control")
      .eq("active", true)
      .order("company_name", { ascending: true })
      .limit(limit);
    if (contractorsError) throw contractorsError;

    const contractorList = contractors ?? [];
    const contractorIds = contractorList.map((contractor) => contractor.id);

    // Current Active Compliance Records for the enabled sync types, so the
    // RPA can compare against existing authoritative values.
    const { data: complianceTypes } = await admin
      .from("compliance_types")
      .select("id, compliance_name")
      .in("compliance_name", enabledTypes);
    const typeIdToName = new Map((complianceTypes ?? []).map((type) => [type.id, type.compliance_name as SyncableComplianceType]));

    const { data: activeRecords } = contractorIds.length
      ? await admin
          .from("compliance_records")
          .select("id, contractor_id, compliance_type_id, registration_number, effective_date, expiration_date")
          .in("contractor_id", contractorIds)
          .eq("active", true)
          .eq("is_current", true)
      : { data: [] };

    // Map: contractor_id -> compliance_name -> active record
    const activeByContractor = new Map<number, Map<string, { id: number; registration_number: string | null; effective_date: string | null; expiration_date: string | null }>>();
    for (const record of activeRecords ?? []) {
      const name = typeIdToName.get(record.compliance_type_id);
      if (!name) continue;
      const byType = activeByContractor.get(record.contractor_id) ?? new Map();
      byType.set(name, {
        id: record.id,
        registration_number: record.registration_number,
        effective_date: record.effective_date,
        expiration_date: record.expiration_date,
      });
      activeByContractor.set(record.contractor_id, byType);
    }

    const workItems = contractorList.map((contractor) => {
      const byType = activeByContractor.get(contractor.id);

      // NJ BRC: validate the contractor master lookup inputs. If blank/invalid,
      // record a Compliance Sync exception and surface input_error so the RPA
      // skips the website lookup (Review Status = Failed).
      let njBrcInputError: string | null = null;
      let njBrcInput: { brc_name_control: string; nj_brc_number: string } | null = null;
      if (enabledTypes.includes("NJ BRC")) {
        const validation = validateNjBrcLookup(contractor);
        if (validation.ok) {
          njBrcInput = validation.input;
        } else {
          njBrcInputError = validation.error;
          void admin
            .from("compliance_sync_exceptions")
            .insert({
              contractor_id: contractor.id,
              company_name: contractor.company_name,
              compliance_name: "NJ BRC",
              exception_type: validation.error,
              message: `${validation.error}: lookup skipped for ${contractor.company_name}.`,
              result_status: "Invalid Search",
              resolved: false,
            })
            .then(() => undefined);
        }
      }

      const activeForType = (type: SyncableComplianceType) => {
        const record = byType?.get(type);
        return record
          ? {
              active_compliance_record_id: record.id,
              active_registration_number: record.registration_number,
              active_effective_date: record.effective_date,
              active_expiration_date: record.expiration_date,
            }
          : {
              active_compliance_record_id: null,
              active_registration_number: null,
              active_effective_date: null,
              active_expiration_date: null,
            };
      };

      return {
        contractor_id: contractor.id,
        company_name: contractor.company_name,
        address_1: contractor.address_1 ?? null,
        address_2: contractor.address_2 ?? null,
        city: contractor.city ?? null,
        state: contractor.state ?? null,
        zip_code: contractor.zip_code ?? null,
        nj_pwc_number: contractor.nj_pwc_number ?? null,
        nj_brc_number: contractor.nj_brc_number ?? null,
        ny_pwc_number: contractor.ny_pwc_number ?? null,
        ny_brc_number: contractor.ny_brc_number ?? null,
        brc_name_control: contractor.brc_name_control ?? null,
        compliance_types_to_check: enabledTypes.filter((type) => SYNCABLE_COMPLIANCE_TYPES.includes(type)),
        // Normalized NJ BRC lookup inputs (from contractor master fields)
        nj_brc_lookup: njBrcInput,
        nj_brc_input_error: njBrcInputError,
        // Current Active Compliance context per type (for comparison)
        active_compliance: enabledTypes.map((type) => ({ compliance_type: type, ...activeForType(type) })),
      };
    });

    return Response.json({ work_items: workItems });
  } catch (error) {
    return jsonError(error);
  }
}
