import { supabase } from "@/lib/supabase";
import type { InsuranceVerificationHistory } from "@/types/database";

export interface MycoiCoveragePolicy {
  id: number;
  contractor_id: number;
  policy_line: string;
  expiration_date: string | null;
  active: boolean;
  is_current: boolean;
  vendor: { contractor_id: number; active: boolean };
}

export interface MycoiCoverage {
  contractor_id: number;
  general_liability_expiration_date: string | null;
  workers_comp_expiration_date: string | null;
}

export function getMycoiExpirations(policies: MycoiCoveragePolicy[]): Map<number, MycoiCoverage> {
  const coverage = new Map<number, MycoiCoverage>();
  for (const policy of policies) {
    if (!policy.active || !policy.is_current || !policy.vendor?.active
      || policy.vendor.contractor_id !== policy.contractor_id || !policy.expiration_date) continue;
    const line = policy.policy_line.trim().toLowerCase().replace(/\s+/g, " ");
    const field = line === "general liability" ? "general_liability_expiration_date"
      : line === "workers compensation" ? "workers_comp_expiration_date" : null;
    if (!field) continue;
    const value = coverage.get(policy.contractor_id) ?? {
      contractor_id: policy.contractor_id, general_liability_expiration_date: null, workers_comp_expiration_date: null,
    };
    if (!value[field] || policy.expiration_date > value[field]) value[field] = policy.expiration_date;
    coverage.set(policy.contractor_id, value);
  }
  return coverage;
}

export async function getMycoiPolicies(contractorIds?: number[], signal?: AbortSignal): Promise<{
  data: MycoiCoveragePolicy[] | null;
  error: { message: string } | null;
}> {
  const policies: MycoiCoveragePolicy[] = [];
  if (contractorIds?.length === 0) return { data: [], error: null };
  const batches = contractorIds
    ? Array.from({ length: Math.ceil(contractorIds.length / 100) }, (_, index) => contractorIds.slice(index * 100, index * 100 + 100))
    : [undefined];
  for (const batch of batches) {
    for (let offset = 0; ; offset += 1000) {
      signal?.throwIfAborted();
      let query = supabase.from("mycoi_policies")
        .select("id, contractor_id, policy_line, expiration_date, active, is_current, vendor:mycoi_vendor_mappings!inner(contractor_id, active)")
        .eq("active", true).eq("is_current", true).eq("vendor.active", true);
      if (batch) query = query.in("contractor_id", batch);
      if (signal) query = query.abortSignal(signal);
      const { data, error } = await query.order("id").range(offset, offset + 999).returns<MycoiCoveragePolicy[]>();
      signal?.throwIfAborted();
      if (error) return { data: null, error: { message: `Unable to load myCOI insurance: ${error.message}` } };
      policies.push(...(data ?? []));
      if (!data || data.length < 1000) break;
    }
  }
  return { data: policies, error: null };
}

export async function getInsuranceVerificationHistory(contractorId: number): Promise<{
  data: InsuranceVerificationHistory[] | null;
  error: { message: string } | null;
}> {
  const { data, error } = await supabase.from("contractor_insurance_history")
    .select("id, contractor_id, coi_on_file, general_liability_on_file, general_liability_expiration_date, workers_comp_on_file, workers_comp_expiration_date, verified_date, notes, created_at")
    .eq("contractor_id", contractorId).order("created_at", { ascending: false });
  return { data: (data as InsuranceVerificationHistory[] | null) ?? null, error: error ? { message: error.message } : null };
}
