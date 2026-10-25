import type { ComplianceHistoryRecord } from "@/types/database";

export function projectComplianceSections(
  records: ComplianceHistoryRecord[],
  contractorNames: ReadonlyMap<number, string>,
): { name: string; columns: string[]; rows: Record<string, string>[] }[] {
  const expiration = (record: ComplianceHistoryRecord) =>
    ["NJ BRC", "NY BRC"].includes(record.compliance_name) ? "Non-expiring" : record.expiration_date || "\u2014";
  const current = records.filter(record => record.active && record.is_current);
  return [
    {
      name: "Current Compliance",
      columns: ["Compliance Type", "Contractor", "Registration Number", "Effective Date", "Expiration Date", "Current Status"],
      rows: current.map(record => ({
        "Compliance Type": record.compliance_name,
        Contractor: contractorNames.get(record.contractor_id) || "\u2014",
        "Registration Number": record.registration_number || "\u2014",
        "Effective Date": record.effective_date || "\u2014",
        "Expiration Date": expiration(record),
        "Current Status": record.calculated_status,
      })),
    },
    {
      name: "Compliance History",
      columns: ["Compliance Type", "Contractor", "Expiration Date", "Record Status"],
      rows: records.map(record => ({
        "Compliance Type": record.compliance_name,
        Contractor: contractorNames.get(record.contractor_id) || "\u2014",
        "Expiration Date": expiration(record),
        "Record Status": record.active && record.is_current
          ? record.calculated_status
          : `${record.active ? "Superseded" : "Archived"} (${record.calculated_status})`,
      })),
    },
  ];
}
