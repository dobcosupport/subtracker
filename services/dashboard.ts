import { supabase } from "@/lib/supabase";
import type { ComplianceStatusRecord } from "@/types/database";

export async function getDashboardCompliance(): Promise<{
  data: ComplianceStatusRecord[] | null;
  error: { message: string } | null;
}> {
  const { data, error } = await supabase
    .from("contractor_compliance_status")
    .select("*")
    .eq("contractor_active", true)
    .eq("compliance_active", true)
    .eq("compliance_current", true)
    .not("compliance_record_id", "is", null);

  return {
    data: (data as ComplianceStatusRecord[] | null) ?? null,
    error: error ? { message: error.message } : null,
  };
}