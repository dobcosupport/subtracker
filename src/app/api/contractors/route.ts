import { createClient } from "@supabase/supabase-js";
import { findDuplicateContractor, describeDuplicateContractor, type ContractorMatchCandidate } from "@/lib/contractor-matching";
import { jsonError, requireModulePermission } from "@/lib/server-admin";

// =====================================================================
// Contractor creation with server-side duplicate protection.
//
// Matching priority (exact, no fuzzy matching, no merging):
//   1. NJ PWC number (contractor.nj_pwc_number and/or the selected NJ PWC
//      search result's certificate_number)
//   2. Normalized company name
// A duplicate returns 409 and nothing is inserted.
// =====================================================================

const TEXT_FIELDS = [
  "company_name", "trade", "contact_name", "email", "phone",
  "address_1", "address_2", "city", "state", "zip_code", "county",
  "nj_pwc_number", "nj_brc_number", "ny_pwc_number", "ny_brc_number",
  "brc_name_control", "sage_erp_id", "notes", "external_id", "legacy_id",
] as const;
const BOOLEAN_FIELDS = ["brc_name_control_is_manual", "material_vendor_only", "active"] as const;
const BOOLEAN_DEFAULTS: Record<(typeof BOOLEAN_FIELDS)[number], boolean> = {
  brc_name_control_is_manual: false,
  material_vendor_only: false,
  active: true,
};
const PAGE_SIZE = 1000;

function toTextOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

export async function POST(request: Request) {
  try {
    // Same permission the contractors RLS INSERT policy enforces.
    const { admin } = await requireModulePermission(request, "contractors", "add");

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "Request body must be valid JSON." }, { status: 400 });
    }
    const payload = (body ?? {}) as Record<string, unknown>;
    const input = (payload.contractor ?? {}) as Record<string, unknown>;

    const contractor: Record<string, string | boolean | null> = {};
    for (const field of TEXT_FIELDS) contractor[field] = toTextOrNull(input[field]);
    for (const field of BOOLEAN_FIELDS) {
      contractor[field] = typeof input[field] === "boolean" ? (input[field] as boolean) : BOOLEAN_DEFAULTS[field];
    }
    if (!contractor.company_name) {
      return Response.json({ error: "Company Name is required." }, { status: 400 });
    }

    // Load every contractor (active and inactive), paging past PostgREST's row cap.
    const existing: ContractorMatchCandidate[] = [];
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error } = await admin
        .from("contractors")
        .select("id, company_name, nj_pwc_number")
        .order("id", { ascending: true })
        .range(from, from + PAGE_SIZE - 1);
      if (error) throw error;
      existing.push(...((data ?? []) as ContractorMatchCandidate[]));
      if (!data || data.length < PAGE_SIZE) break;
    }

    const duplicate = findDuplicateContractor(existing, {
      company_name: contractor.company_name as string,
      nj_pwc_numbers: [contractor.nj_pwc_number as string | null, toTextOrNull(payload.nj_pwc_match_number)],
    });
    if (duplicate) {
      return Response.json(
        {
          error: describeDuplicateContractor(duplicate),
          duplicate: {
            id: duplicate.contractor.id,
            company_name: duplicate.contractor.company_name,
            nj_pwc_number: duplicate.contractor.nj_pwc_number ?? null,
            match_type: duplicate.matchType,
          },
        },
        { status: 409 }
      );
    }

    // Insert as the calling user (not the service role) so RLS and the
    // audit_application_change trigger (auth.uid()) behave exactly as before.
    const token = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] ?? "";
    const userClient = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "", {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const { data: created, error: insertError } = await userClient.from("contractors").insert(contractor).select();
    if (insertError) throw insertError;

    return Response.json({ data: created ?? [] }, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}
