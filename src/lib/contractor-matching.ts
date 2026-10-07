// =====================================================================
// Shared contractor duplicate matching (client + server safe)
//
// Single source of truth for contractor company-name / NJ PWC number
// normalization used by Add Contractor, the server-side create route, and
// the spreadsheet import. Exact matches only — no fuzzy matching and no
// automatic merging.
// =====================================================================

const LEGAL_SUFFIXES = new Set([
  "llc",
  "inc",
  "incorporated",
  "corp",
  "corporation",
  "co",
  "company",
  "ltd",
  "lp",
  "llp",
  "pc",
]);

/**
 * Normalize a company name for duplicate matching.
 * "ABCO Electric LLC" and "Abco Electric, LLC" both become "abco electric".
 */
export function normalizeCompanyName(value: string | null | undefined): string {
  const tokens = (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/&/g, " and ")
    // Periods/apostrophes join their neighbours ("L.L.C." -> "llc", "O'Neil" -> "oneil").
    .replace(/[.'\u2019]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);

  // Strip trailing legal suffixes, but never reduce the name to nothing.
  while (tokens.length > 1 && LEGAL_SUFFIXES.has(tokens[tokens.length - 1])) {
    tokens.pop();
  }
  return tokens.join(" ");
}

/**
 * Normalize an NJ PWC certificate number for duplicate matching: trims and
 * removes all formatting (spaces, dashes, punctuation), case-insensitive.
 * Kept as text so leading zeros are preserved.
 */
export function normalizeNjPwcNumberForMatch(value: string | null | undefined): string {
  return (value ?? "").replace(/[^\p{L}\p{N}]/gu, "").toUpperCase();
}

export type ContractorMatchCandidate = {
  id: number;
  company_name: string;
  nj_pwc_number?: string | null;
};

export type ContractorDuplicateMatch<T extends ContractorMatchCandidate = ContractorMatchCandidate> = {
  contractor: T;
  matchType: "nj_pwc_number" | "company_name";
};

/**
 * Find an existing contractor that duplicates the proposed one.
 * Priority: NJ PWC number first, then normalized company name.
 * Any of `njPwcNumbers` (e.g. the form value and a selected NJ PWC
 * certificate_number) may match.
 */
export function findDuplicateContractor<T extends ContractorMatchCandidate>(
  existing: readonly T[],
  proposed: { company_name: string | null | undefined; nj_pwc_numbers?: Array<string | null | undefined> }
): ContractorDuplicateMatch<T> | null {
  const pwcNumbers = new Set(
    (proposed.nj_pwc_numbers ?? []).map(normalizeNjPwcNumberForMatch).filter((value) => value.length > 0)
  );
  if (pwcNumbers.size > 0) {
    const pwcMatch = existing.find((contractor) => {
      const normalized = normalizeNjPwcNumberForMatch(contractor.nj_pwc_number);
      return normalized.length > 0 && pwcNumbers.has(normalized);
    });
    if (pwcMatch) return { contractor: pwcMatch, matchType: "nj_pwc_number" };
  }

  const name = normalizeCompanyName(proposed.company_name);
  if (name.length > 0) {
    const nameMatch = existing.find((contractor) => normalizeCompanyName(contractor.company_name) === name);
    if (nameMatch) return { contractor: nameMatch, matchType: "company_name" };
  }
  return null;
}

export function describeDuplicateContractor(match: ContractorDuplicateMatch): string {
  const { contractor, matchType } = match;
  const reason = matchType === "nj_pwc_number"
    ? `already has NJ PWC # ${contractor.nj_pwc_number ?? ""}`.trim()
    : "has a matching company name";
  return `Existing contractor "${contractor.company_name}" (ID ${contractor.id}) ${reason}. The contractor was not created. Edit the existing contractor instead.`;
}
