import type { ComplianceHistoryRecord, ComplianceType, ContractorFollowup } from "@/types/database";

export const insuranceRelatedItems = [
  { key: "certificate_of_insurance", label: "Certificate of Insurance" },
  { key: "general_liability", label: "General Liability" },
  { key: "workers_compensation", label: "Workers Compensation" },
] as const;

export function getFollowupRelatedValue(followup: ContractorFollowup, records: ComplianceHistoryRecord[]): string {
  if (followup.insurance_item_key) return `insurance:${followup.insurance_item_key}`;
  const typeId = followup.compliance_type_id ?? records.find((record) => record.id === followup.compliance_record_id)?.compliance_type_id;
  if (typeId != null) return `compliance:${typeId}`;
  return followup.compliance_record_id != null ? `legacy:${followup.compliance_record_id}` : "";
}

export function getFollowupRelatedLabel(followup: ContractorFollowup, records: ComplianceHistoryRecord[], types: ComplianceType[]): string {
  if (followup.insurance_item_key) return insuranceRelatedItems.find((item) => item.key === followup.insurance_item_key)?.label ?? `Unavailable insurance item (${followup.insurance_item_key})`;
  const record = records.find((item) => item.id === followup.compliance_record_id);
  const typeId = followup.compliance_type_id ?? record?.compliance_type_id;
  const name = types.find((type) => type.id === typeId)?.compliance_name
    ?? (followup.compliance_type_id != null ? followup.related_type?.compliance_name : undefined)
    ?? record?.compliance_name;
  if (name) return `${name}${record?.registration_number ? ` - ${record.registration_number}` : ""}`;
  if (typeId != null) return `Compliance type #${typeId} (unavailable)`;
  return followup.compliance_record_id != null ? `Compliance record #${followup.compliance_record_id} (unavailable)` : "General Follow-Up";
}

export function followupRelationshipPayload(value: string, recordId: string): Pick<ContractorFollowup, "compliance_type_id" | "insurance_item_key" | "compliance_record_id"> {
  if (!value) return { compliance_type_id: null, insurance_item_key: null, compliance_record_id: null };
  if (value.startsWith("insurance:")) {
    const item = insuranceRelatedItems.find((entry) => `insurance:${entry.key}` === value);
    if (!item) throw new Error("Invalid insurance related item.");
    return { compliance_type_id: null, insurance_item_key: item.key, compliance_record_id: null };
  }
  const match = /^(compliance|legacy):([1-9]\d*)$/.exec(value);
  if (!match || !Number.isSafeInteger(Number(match[2])) || (recordId && (!/^[1-9]\d*$/.test(recordId) || !Number.isSafeInteger(Number(recordId))))) {
    throw new Error("Invalid compliance related item or record.");
  }
  return { compliance_type_id: match[1] === "compliance" ? Number(match[2]) : null, insurance_item_key: null, compliance_record_id: recordId ? Number(recordId) : null };
}

export function followupRecordLabel(record: ComplianceHistoryRecord): string {
  const date = record.expiration_date?.split("-");
  return `${record.compliance_name}${record.registration_number ? ` - ${record.registration_number}` : ""}${!record.active || !record.is_current ? " (Historical)" : ""}${date?.length === 3 ? ` - Expires ${date[1]}/${date[2]}/${date[0]}` : ""}`;
}
