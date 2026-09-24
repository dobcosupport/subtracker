import { supabase } from "@/lib/supabase";
import type { ComplianceStatusRecord } from "@/types/database";

export async function getDashboardCompliance(): Promise<{
  data: ComplianceStatusRecord[] | null;
  error: { message: string } | null;
}> {
  const { data, error } = await supabase
    .from("contractor_compliance_status")
    .select("contractor_id, company_name, contractor_active, compliance_record_id, compliance_type_id, compliance_name, registration_number, expiration_date, days_remaining, calculated_status")
    .eq("contractor_active", true)
    .not("compliance_record_id", "is", null);

  return {
    data: (data as ComplianceStatusRecord[] | null) ?? null,
    error: error ? { message: error.message } : null,
  };
}