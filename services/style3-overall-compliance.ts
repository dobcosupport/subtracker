export type OverallComplianceCategory = "compliant" | "nonCompliant" | "expiringSoon" | "needsReview";
export type NjPwcApplicability = "applicable" | "not_applicable" | "unknown";
export type ScopedRequirementStatus = {
  contractor_id: number;
  compliance_name: "NJ BRC" | "NJ PWC";
  calculated_status: string;
  registration_number: string | null;
  days_remaining: number | null;
};

export interface ScopedComplianceContractor {
  contractor_id: number;
  state: string | null;
  federal_tax_id: string | null;
  nj_brc_number: string | null;
  nj_pwc_applicability: NjPwcApplicability;
}

export interface OverallComplianceCounts {
  population: number;
  compliant: number;
  nonCompliant: number;
  expiringSoon: number;
  needsReview: number;
  rate: number | null;
}

const stateNames: Record<string, string> = {
  ALABAMA: "AL", ALASKA: "AK", ARIZONA: "AZ", ARKANSAS: "AR", CALIFORNIA: "CA", COLORADO: "CO",
  CONNECTICUT: "CT", DELAWARE: "DE", FLORIDA: "FL", GEORGIA: "GA", HAWAII: "HI", IDAHO: "ID",
  ILLINOIS: "IL", INDIANA: "IN", IOWA: "IA", KANSAS: "KS", KENTUCKY: "KY", LOUISIANA: "LA",
  MAINE: "ME", MARYLAND: "MD", MASSACHUSETTS: "MA", MICHIGAN: "MI", MINNESOTA: "MN",
  MISSISSIPPI: "MS", MISSOURI: "MO", MONTANA: "MT", NEBRASKA: "NE", NEVADA: "NV",
  "NEW HAMPSHIRE": "NH", "NEW JERSEY": "NJ", "NEW MEXICO": "NM", "NEW YORK": "NY",
  "NORTH CAROLINA": "NC", "NORTH DAKOTA": "ND", OHIO: "OH", OKLAHOMA: "OK", OREGON: "OR",
  PENNSYLVANIA: "PA", "RHODE ISLAND": "RI", "SOUTH CAROLINA": "SC", "SOUTH DAKOTA": "SD",
  TENNESSEE: "TN", TEXAS: "TX", UTAH: "UT", VERMONT: "VT", VIRGINIA: "VA", WASHINGTON: "WA",
  "WEST VIRGINIA": "WV", WISCONSIN: "WI", WYOMING: "WY", "DISTRICT OF COLUMBIA": "DC",
};
const validJurisdictions = new Set([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS",
  "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY",
  "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV",
  "WI", "WY", "DC", "AB", "BC", "MB", "NB", "NL", "NS", "NT", "NU", "ON", "PE", "QC", "SK", "YT",
]);
const currentPwcStatuses = new Set(["Active", "30 Day", "60 Day", "90 Day"]);

function normalizedState(value: string | null): string {
  if (!value?.trim()) return "";
  const state = value.trim().toUpperCase().replace(/\./g, "");
  return stateNames[state] ?? state;
}

export function calculateOverallContractorCompliance(
  contractors: readonly ScopedComplianceContractor[],
  currentRequirements: readonly ScopedRequirementStatus[],
): OverallComplianceCounts {
  const contractorIds = new Set<number>();
  const records = new Map<number, ScopedRequirementStatus[]>();
  for (const contractor of contractors) {
    if (!Number.isInteger(contractor.contractor_id) || contractorIds.has(contractor.contractor_id)) {
      throw new Error("Overall compliance requires unique contractor IDs.");
    }
    if (!["applicable", "not_applicable", "unknown"].includes(contractor.nj_pwc_applicability)) {
      throw new Error("Overall compliance received unknown NJ PWC applicability.");
    }
    contractorIds.add(contractor.contractor_id);
  }
  for (const record of currentRequirements) {
    if (!contractorIds.has(record.contractor_id)) throw new Error("Compliance record is outside the Dashboard population.");
    const rows = records.get(record.contractor_id) ?? [];
    rows.push(record);
    records.set(record.contractor_id, rows);
  }

  const counts: OverallComplianceCounts = {
    population: contractors.length, compliant: 0, nonCompliant: 0, expiringSoon: 0, needsReview: 0, rate: null,
  };
  for (const contractor of contractors) {
    const state = normalizedState(contractor.state);
    const validState = validJurisdictions.has(state);
    const isNj = state === "NJ";
    const feinMissing = !contractor.federal_tax_id?.trim();
    const rows = records.get(contractor.contractor_id) ?? [];
    const brcRows = rows.filter(row => row.compliance_name === "NJ BRC");
    const pwcRows = rows.filter(row => row.compliance_name === "NJ PWC");

    let needsReview = !validState || (isNj && contractor.nj_pwc_applicability === "unknown");
    let missingRequirement = feinMissing;
    if (isNj) {
      if (brcRows.length > 1) needsReview = true;
      else if (brcRows.length === 0) {
        if (contractor.nj_brc_number?.trim()) needsReview = true;
        else missingRequirement = true;
      } else if (!brcRows[0].registration_number?.trim()) {
        missingRequirement = true;
      }

      if (contractor.nj_pwc_applicability === "applicable") {
        if (pwcRows.length > 1) needsReview = true;
        else if (pwcRows.length === 0) missingRequirement = true;
        else {
          const pwc = pwcRows[0];
          if (pwc.calculated_status === "Expired" || pwc.calculated_status === "Missing Information") {
            missingRequirement = true;
          } else if (!currentPwcStatuses.has(pwc.calculated_status)) {
            needsReview = true;
          }
        }
      }
    }

    let category: OverallComplianceCategory;
    if (needsReview) category = "needsReview";
    else if (missingRequirement) category = "nonCompliant";
    else if (isNj && contractor.nj_pwc_applicability === "applicable"
      && pwcRows.length === 1 && (pwcRows[0].calculated_status === "30 Day"
        || (pwcRows[0].days_remaining !== null && pwcRows[0].days_remaining >= 1 && pwcRows[0].days_remaining <= 30))) {
      category = "expiringSoon";
    } else category = "compliant";
    counts[category]++;
  }

  const total = counts.compliant + counts.nonCompliant + counts.expiringSoon + counts.needsReview;
  if (total !== counts.population) throw new Error("Overall compliance categories do not equal the Dashboard population.");
  counts.rate = counts.population ? counts.compliant / counts.population * 100 : null;
  return counts;
}
