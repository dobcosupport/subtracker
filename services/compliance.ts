import { supabase } from "@/lib/supabase";
import type {
  ComplianceRecord,
  ComplianceStatusRecord,
  ComplianceType,
} from "@/types/database";

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