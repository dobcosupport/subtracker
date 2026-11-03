import { normalizeCompanyName } from "@/lib/contractor-matching";

export type NjPwcCandidate = {
  searched_company_name?: string;
  search_request_id?: number;
  business_name: string | null;
  certificate_number: string | null;
  registration_date: string | null;
  expiration_date: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip_code: string | null;
  county: string | null;
  source_url?: string | null;
};

export function getNjPwcSearchNames(companyName: string, dbaName: string | null | undefined): string[] {
  const names = [companyName, dbaName ?? ""].map((value) => value.trim()).filter(Boolean);
  const unique = new Map<string, string>();
  for (const name of names) {
    const key = normalizeCompanyName(name);
    if (!unique.has(key)) unique.set(key, name);
  }
  return [...unique.values()];
}

export function attachNjPwcSearchProvenance(
  results: Array<{ requestId: number; searched_company_name?: string; candidates?: NjPwcCandidate[] }>,
): NjPwcCandidate[] {
  return results.flatMap((result) => (result.candidates ?? []).map((candidate) => ({
    ...candidate,
    searched_company_name: result.searched_company_name,
    search_request_id: result.requestId,
  })));
}
