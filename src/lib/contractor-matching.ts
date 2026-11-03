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
const NAME_VARIANTS: Record<string, string> = {
  mfg: "manufacturing", mfr: "manufacturing", mfrs: "manufacturers",
  const: "construction", constr: "construction", constn: "construction",
  bldg: "building", bldgs: "buildings", bldrs: "builders",
  nj: "new jersey", ny: "new york", bros: "brothers", mech: "mechanical",
  intl: "international", assoc: "associates", assocs: "associates",
  svc: "service", svcs: "services", elec: "electric", sys: "systems",
  ent: "enterprises", ents: "enterprises", enterp: "enterprises",
  mgmt: "management", plbg: "plumbing", htg: "heating", mtl: "metal", genl: "general",
  corportation: "corporation", specialities: "specialties", speciality: "specialty",
};

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

export function normalizeCompanyNameVariant(value: string | null | undefined): string {
  const tokens = normalizeCompanyName(value).split(" ").filter(Boolean);
  const expanded = tokens.flatMap((token) => (NAME_VARIANTS[token] ?? token).split(" "));
  if (expanded[0] === "the") expanded.shift();
  const withoutAnd = expanded.filter((token) => token !== "and");
  while (withoutAnd.length > 1 && LEGAL_SUFFIXES.has(withoutAnd[withoutAnd.length - 1])) withoutAnd.pop();
  return withoutAnd.map((token) => {
    if (/^[a-z]{2,}ies$/.test(token)) return `${token.slice(0, -3)}y`;
    if (/^[a-z]{3,}s$/.test(token) && !/(ss|us|is)$/.test(token)) return token.slice(0, -1);
    return token;
  }).join(" ");
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
  dba_name?: string | null;
  nj_pwc_number?: string | null;
  nj_brc_number?: string | null;
  federal_tax_id?: string | null;
};

export type ContractorDuplicateMatch<T extends ContractorMatchCandidate = ContractorMatchCandidate> = {
  contractor: T;
  contractors: T[];
  ambiguous: boolean;
  matchType: "nj_pwc_number" | "strong_identity" | "company_name";
  signal: "nj_pwc_number" | "legal_name_exact" | "legal_name_variant" | "dba_exact" | "dba_variant"
    | "candidate_dba_matches_legal_name" | "candidate_dba_matches_existing_dba" | "nj_brc_number" | "federal_tax_id";
};

function normalizeFeinForMatch(value: string | null | undefined): string | null {
  const digits = (value ?? "").replace(/\D/g, "");
  return /^\d{9}$/.test(digits) && !/^(\d)\1{8}$/.test(digits) && digits !== "123456789" ? digits : null;
}

function normalizeBrcForMatch(value: string | null | undefined): string | null {
  const normalized = (value ?? "").replace(/[^\p{L}\p{N}]/gu, "").toUpperCase();
  return normalized.length >= 4 && !/^0+$/.test(normalized) ? normalized : null;
}

/**
 * Find an existing contractor that duplicates the proposed one.
 * Priority: NJ PWC number first, then normalized company name.
 * Any of `njPwcNumbers` (e.g. the form value and a selected NJ PWC
 * certificate_number) may match.
 */
export function findDuplicateContractor<T extends ContractorMatchCandidate>(
  existing: readonly T[],
  proposed: {
    company_name: string | null | undefined;
    dba_name?: string | null;
    nj_pwc_numbers?: Array<string | null | undefined>;
    nj_brc_number?: string | null;
    federal_tax_id?: string | null;
  }
): ContractorDuplicateMatch<T> | null {
  const pwcNumbers = new Set(
    (proposed.nj_pwc_numbers ?? []).map(normalizeNjPwcNumberForMatch).filter((value) => value.length > 0)
  );
  if (pwcNumbers.size > 0) {
    const pwcMatches = existing.filter((contractor) => {
      const normalized = normalizeNjPwcNumberForMatch(contractor.nj_pwc_number);
      return normalized.length > 0 && pwcNumbers.has(normalized);
    });
    if (pwcMatches.length) return {
      contractor: pwcMatches[0], contractors: pwcMatches, ambiguous: pwcMatches.length > 1,
      matchType: "nj_pwc_number", signal: "nj_pwc_number",
    };
  }

  const incomingFein = normalizeFeinForMatch(proposed.federal_tax_id);
  const incomingBrc = normalizeBrcForMatch(proposed.nj_brc_number);
  const strongMatches = new Map<number, { contractor: T; signal: "nj_brc_number" | "federal_tax_id" }>();
  for (const contractor of existing) {
    const feinMatches = incomingFein !== null && normalizeFeinForMatch(contractor.federal_tax_id) === incomingFein;
    const brcMatches = incomingBrc !== null && normalizeBrcForMatch(contractor.nj_brc_number) === incomingBrc;
    if (brcMatches) strongMatches.set(contractor.id, { contractor, signal: "nj_brc_number" });
    else if (feinMatches) strongMatches.set(contractor.id, { contractor, signal: "federal_tax_id" });
  }
  if (strongMatches.size) {
    const matches = [...strongMatches.values()];
    return {
      contractor: matches[0].contractor,
      contractors: matches.map((match) => match.contractor),
      ambiguous: matches.length > 1,
      matchType: "strong_identity",
      signal: matches[0].signal,
    };
  }

  const proposedNames = [
    { value: proposed.company_name, role: "legal" as const },
    { value: proposed.dba_name, role: "dba" as const },
  ].filter((entry) => normalizeCompanyName(entry.value));
  const signals: Record<string, ContractorDuplicateMatch<T>["signal"]> = {
    "legal:legal": "legal_name_exact",
    "legal:dba": "dba_exact",
    "dba:legal": "candidate_dba_matches_legal_name",
    "dba:dba": "candidate_dba_matches_existing_dba",
  };
  for (const variant of [false, true]) {
    const found = new Map<number, { contractor: T; signal: ContractorDuplicateMatch<T>["signal"] }>();
    for (const candidate of proposedNames) {
      const candidateName = variant ? normalizeCompanyNameVariant(candidate.value) : normalizeCompanyName(candidate.value);
      if (!candidateName) continue;
      for (const contractor of existing) {
        const existingNames = [
          { value: contractor.company_name, role: "legal" as const },
          { value: contractor.dba_name, role: "dba" as const },
        ];
        for (const current of existingNames) {
          const currentName = variant ? normalizeCompanyNameVariant(current.value) : normalizeCompanyName(current.value);
          if (!currentName || currentName !== candidateName) continue;
          const base = signals[`${candidate.role}:${current.role}`];
          const signal = variant && candidate.role === "legal" && current.role === "legal"
            ? "legal_name_variant" : variant && current.role === "dba" && candidate.role === "legal"
              ? "dba_variant" : base;
          found.set(contractor.id, { contractor, signal });
        }
      }
    }
    if (found.size) {
      const matches = [...found.values()];
      return {
        contractor: matches[0].contractor,
        contractors: matches.map((match) => match.contractor),
        ambiguous: matches.length > 1,
        matchType: "company_name",
        signal: matches[0].signal,
      };
    }
  }
  return null;
}

export function describeDuplicateContractor(match: ContractorDuplicateMatch): string {
  const { contractor, matchType } = match;
  const reason = matchType === "nj_pwc_number"
    ? `already has NJ PWC # ${contractor.nj_pwc_number ?? ""}`.trim()
    : matchType === "strong_identity"
      ? match.signal === "nj_brc_number" ? "has a matching NJ BRC number" : "has a matching FEIN"
    : match.signal.includes("dba") || match.signal.startsWith("candidate_dba")
      ? `has a matching DBA (${contractor.dba_name ?? contractor.company_name})`
      : "has a matching company name";
  if (match.ambiguous) {
    return `Multiple existing contractors match this identity (${match.contractors.map((item) => `${item.company_name} (ID ${item.id})`).join("; ")}). Contractor creation was blocked for identity review.`;
  }
  return `Existing contractor "${contractor.company_name}"${contractor.dba_name ? ` (DBA: ${contractor.dba_name})` : ""} (ID ${contractor.id}) ${reason}. The contractor was not created.`;
}
