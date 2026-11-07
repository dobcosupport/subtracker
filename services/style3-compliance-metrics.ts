export type RequirementApplicability = "applicable" | "not_applicable" | "unknown";
export type RequirementCurrentStatus = "current" | "expiring" | "deficient" | "unknown";

export interface RequirementAssessment {
  contractorId: number;
  requirementId: string;
  applicability: RequirementApplicability;
  status: RequirementCurrentStatus;
}

export interface CurrentComplianceMetric {
  knownCurrent: number;
  knownDeficient: number;
  needsReview: number;
  percentage: number | null;
}

export function calculateCurrentCompliance(
  eligibleContractorIds: readonly number[],
  assessments: readonly RequirementAssessment[],
): CurrentComplianceMetric {
  const eligible = new Set(eligibleContractorIds);
  const byContractor = new Map<number, RequirementAssessment[]>();
  const identities = new Set<string>();
  for (const assessment of assessments) {
    if (!eligible.has(assessment.contractorId)) continue;
    const identity = JSON.stringify([assessment.contractorId, assessment.requirementId]);
    if (identities.has(identity)) throw new Error("Duplicate requirement assessment.");
    identities.add(identity);
    const rows = byContractor.get(assessment.contractorId) ?? [];
    rows.push(assessment);
    byContractor.set(assessment.contractorId, rows);
  }
  let knownCurrent = 0;
  let knownDeficient = 0;
  let needsReview = 0;
  for (const id of eligible) {
    const rows = byContractor.get(id) ?? [];
    const applicable = rows.filter((row) => row.applicability === "applicable");
    const uncertain = rows.length === 0 || rows.some((row) => row.applicability === "unknown"
        || (row.applicability === "applicable" && row.status === "unknown"));
    if (uncertain) needsReview++;
    for (const row of applicable) {
      if (row.status === "deficient") knownDeficient++;
      else if (row.status === "current" || row.status === "expiring") knownCurrent++;
    }
  }
  const known = knownCurrent + knownDeficient;
  return {
    knownCurrent,
    knownDeficient,
    needsReview,
    percentage: known ? Math.round(100 * knownCurrent / known) : null,
  };
}
