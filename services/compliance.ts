import { supabase } from "@/lib/supabase";
import type {
  ComplianceRecord,
  ComplianceHistoryRecord,
  ComplianceStatusRecord,
  ComplianceType,
} from "@/types/database";

function calculateStatus(record: {
  compliance_name: string;
  registration_number: string | null;
  expiration_date: string | null;
  requires_expiration: boolean;
}): { calculated_status: ComplianceHistoryRecord["calculated_status"]; days_remaining: number | null } {
  if (record.requires_expiration && !record.expiration_date) {
    return { calculated_status: "Missing Information", days_remaining: null };
  }

  if (["NJ PWC", "NY PWC"].includes(record.compliance_name) && !record.registration_number?.trim()) {
    return { calculated_status: "Missing Information", days_remaining: null };
  }

  if (!record.expiration_date) {
    return { calculated_status: "Active", days_remaining: null };
  }

  const currentDate = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`).getTime();
  const expirationDate = new Date(`${record.expiration_date}T00:00:00Z`).getTime();
  const daysRemaining = Math.floor((expirationDate - currentDate) / 86400000);

  if (daysRemaining <= 0) return { calculated_status: "Expired", days_remaining: daysRemaining };
  if (daysRemaining <= 30) return { calculated_status: "30 Day", days_remaining: daysRemaining };
  if (daysRemaining <= 60) return { calculated_status: "60 Day", days_remaining: daysRemaining };
  if (daysRemaining <= 90) return { calculated_status: "90 Day", days_remaining: daysRemaining };
  return { calculated_status: "Active", days_remaining: daysRemaining };
}

export async function getComplianceRecords(): Promise<{
  data: ComplianceStatusRecord[] | null;
  error: { message: string } | null;
}> {
  const { data, error } = await supabase
    .from("contractor_compliance_status")
    .select("*")
    .not("compliance_record_id", "is", null);

  return {
    data: (data as ComplianceStatusRecord[] | null) ?? null,
    error: error ? { message: error.message } : null,
  };
}

export async function createComplianceRecord(
  record: Omit<ComplianceRecord, "id" | "created_at" | "updated_at">
): Promise<{
  data: ComplianceRecord[] | null;
  error: { message: string } | null;
}> {
  const { data, error } = await supabase
    .from("compliance_records")
    .insert(record);

  return {
    data: (data as ComplianceRecord[] | null) ?? null,
    error: error ? { message: error.message } : null,
  };
}

export async function getComplianceTypes(): Promise<{
  data: ComplianceType[] | null;
  error: { message: string } | null;
}> {
  const { data, error } = await supabase
    .from("compliance_types")
    .select("*")
    .eq("active", true)
    .order("compliance_name");

  return {
    data: (data as ComplianceType[] | null) ?? null,
    error: error ? { message: error.message } : null,
  };
}

export async function getComplianceRecordsForContractor(contractorId: number): Promise<{
  data: ComplianceStatusRecord[] | null;
  error: { message: string } | null;
}> {
  const { data, error } = await supabase
    .from("contractor_compliance_status")
    .select("*")
    .eq("contractor_id", contractorId)
    .not("compliance_record_id", "is", null);

  return {
    data: (data as ComplianceStatusRecord[] | null) ?? null,
    error: error ? { message: error.message } : null,
  };
}

export async function getComplianceHistoryForContractor(contractorId: number): Promise<{
  data: ComplianceHistoryRecord[] | null;
  error: { message: string } | null;
}> {
  const { data, error } = await supabase
    .from("compliance_records")
    .select(
      "id, contractor_id, compliance_type_id, registration_number, effective_date, expiration_date, active, is_current, compliance_types(compliance_name, requires_expiration)"
    )
    .eq("contractor_id", contractorId)
    .order("created_at", { ascending: false });

  const history = ((data ?? []) as Array<{
    id: number;
    contractor_id: number;
    compliance_type_id: number;
    registration_number: string | null;
    effective_date: string | null;
    expiration_date: string | null;
    active: boolean;
    is_current: boolean;
    compliance_types:
      | { compliance_name: string; requires_expiration: boolean }[]
      | { compliance_name: string; requires_expiration: boolean }
      | null;
  }>).map((record) => {
    const complianceType = Array.isArray(record.compliance_types)
      ? record.compliance_types[0]
      : record.compliance_types;
    const status = calculateStatus({
      compliance_name: complianceType?.compliance_name ?? "",
      registration_number: record.registration_number,
      expiration_date: record.expiration_date,
      requires_expiration: complianceType?.requires_expiration ?? true,
    });

    return {
      id: record.id,
      contractor_id: record.contractor_id,
      compliance_type_id: record.compliance_type_id,
      compliance_name: complianceType?.compliance_name ?? "Unknown",
      registration_number: record.registration_number,
      effective_date: record.effective_date,
      expiration_date: record.expiration_date,
      active: record.active,
      is_current: record.is_current,
      ...status,
    };
  });

  return {
    data: error ? null : history,
    error: error ? { message: error.message } : null,
  };
}

export async function updateComplianceRecord(
  id: number,
  updates: Pick<ComplianceRecord, "compliance_type_id" | "registration_number" | "effective_date" | "expiration_date" | "verified_date" | "verified_by" | "notes">
): Promise<{
  data: ComplianceRecord[] | null;
  error: { message: string } | null;
}> {
  const { data, error } = await supabase
    .from("compliance_records")
    .update(updates)
    .eq("id", id)
    .eq("active", true)
    .eq("is_current", true);

  return {
    data: (data as ComplianceRecord[] | null) ?? null,
    error: error ? { message: error.message } : null,
  };
}

export async function archiveComplianceRecord(id: number): Promise<{
  error: { message: string } | null;
}> {
  const { error } = await supabase
    .from("compliance_records")
    .update({ active: false, is_current: false })
    .eq("id", id)
    .eq("active", true)
    .eq("is_current", true);

  return { error: error ? { message: error.message } : null };
}