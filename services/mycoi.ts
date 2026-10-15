import { supabase } from "@/lib/supabase";
import type { MycoiContractorDivision, MycoiInsurance, MycoiPolicy, MycoiVendorMapping } from "@/types/mycoi";

export async function getMycoiInsurance(contractorId: number): Promise<{
  data: MycoiInsurance | null;
  error: { message: string } | null;
}> {
  const vendors: MycoiVendorMapping[] = [];
  for (let start = 0; ; start += 1000) {
    const { data, error } = await supabase.from("mycoi_vendor_mappings")
      .select("id, contractor_id, raw_vendor_name, vendor_email, vendor_phone, last_imported_at, import_reference, import_history_id, active")
      .eq("contractor_id", contractorId).order("id").range(start, start + 999)
      .returns<MycoiVendorMapping[]>();
    if (error) return { data: null, error: { message: `Unable to load myCOI vendor mappings: ${error.message}` } };
    vendors.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  if (vendors.length === 0) return { data: { vendors, divisions: [], policies: [] }, error: null };

  const divisions: MycoiContractorDivision[] = [];
  const policies: MycoiPolicy[] = [];
  for (let batch = 0; batch < vendors.length; batch += 100) {
    const vendorIds = vendors.slice(batch, batch + 100).map((vendor) => vendor.id);
    for (let start = 0; ; start += 1000) {
      const { data, error } = await supabase.from("mycoi_contractor_divisions")
        .select("*, division:mycoi_division_mappings(raw_division_name, leading_project_number, project_id, project:projects(project_number, project_name))")
        .in("vendor_mapping_id", vendorIds).order("id").range(start, start + 999)
        .returns<MycoiContractorDivision[]>();
      if (error) return { data: null, error: { message: `Unable to load myCOI project statuses: ${error.message}` } };
      divisions.push(...(data ?? []));
      if (!data || data.length < 1000) break;
    }
    for (let start = 0; ; start += 1000) {
      const { data, error } = await supabase.from("mycoi_policies")
        .select("*, divisions:mycoi_policy_divisions(contractor_division_id)")
        .eq("contractor_id", contractorId).in("vendor_mapping_id", vendorIds)
        .order("id").range(start, start + 999).returns<MycoiPolicy[]>();
      if (error) return { data: null, error: { message: `Unable to load myCOI policies: ${error.message}` } };
      policies.push(...(data ?? []));
      if (!data || data.length < 1000) break;
    }
  }
  return { data: { vendors, divisions, policies }, error: null };
}
