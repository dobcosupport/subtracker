export const PROCORE_HEADINGS = [
  "Company (Vendor) > Name", "Company (Vendor) > Business Phone", "Company (Vendor) > Address",
  "Company (Vendor) > City", "Company (Vendor) > State", "Company (Vendor) > Zip", "Project > Number",
  "User > Full Name", "User > Email Address", "User > Business Phone", "User > Cell Phone",
] as const;
export type ProcoreRow = { row: number } & Record<typeof PROCORE_HEADINGS[number], string>;
export interface ProcoreDuplicateOverride {
  contractorId: number; companyName: string;
  approvedBy?: string; approvedAt?: string;
}
export type ProcoreChoice = { action: "MATCH"; contractorId: number } |
  { action: "ADD"; duplicateOverride?: ProcoreDuplicateOverride } | { action: "UNMATCHED" };
export interface ProcoreDecisions { vendors: Record<string, ProcoreChoice> }
export interface ProcoreContact {
  contact_name: string; email: string | null; business_phone: string | null; mobile_phone: string | null;
  rows: number[];
}
export interface ProcoreCompany {
  company_name: string; phone: string | null; address_1: string | null;
  city: string | null; state: string | null; zip_code: string | null;
}
export interface ProcoreReference {
  token: string;
  contractors: { id: number; company_name: string; active: boolean }[];
  projects: { id: number; project_number: string; project_name: string }[];
  vendors: { vendor_key: string; contractor_id: number }[];
  projectMappings?: { source_number: string; project_id: number | null }[];
  contacts: { id: string; contractor_id: number; contact_name: string; email: string | null;
    business_phone: string | null; mobile_phone: string | null; is_active: boolean }[];
}
export interface ProcorePlan {
  key: string; company: ProcoreCompany; contractorId: number | null; createContractor: boolean;
  assignments: { projectId: number; number: string; rows: number[] }[];
  contacts: ProcoreContact[]; rows: number[];
}
export interface ProcorePreview {
  summary: { sourceRows: number; contractors: number; projects: number; contacts: number; assignments: number;
    readyAssignments: number; importedRows: number; unresolvedRows: number };
  vendors: { key: string; name: string; sourceRows: number[]; contractorId: number | null;
    addContractor: boolean; suggestions: { id: number; label: string }[];
    company: ProcoreCompany; issues: string[] }[];
  projects: { number: string; projectId: number | null; rows: number[]; mapped?: boolean; targetNumber?: string }[];
  contacts: (ProcoreContact & { vendor: string; existingId: string | null; issue: string | null })[];
  ready: ProcorePlan[];
}
export interface ProcoreRun {
  id: string; file_name: string; revision: number; created_at: string; updated_at: string;
  source_rows: ProcoreRow[]; source_row_count: number; decisions: ProcoreDecisions; imported_rows: number[];
  status: "Review" | "Partial" | "Complete"; import_history_id: number | null;
  last_imported_at: string | null; finalized_at: string | null;
  closeout: Record<string, number> | null; finalized_review: ProcoreReview | null;
}
export interface ProcoreReview {
  preview: ProcorePreview; contractors: ProcoreReference["contractors"]; token: string;
  projects?: ProcoreReference["projects"];
}
export interface ProcoreResponse extends ProcoreReview {
  run: Omit<ProcoreRun, "source_rows" | "finalized_review">;
}
export type ProcoreHistory = Pick<ProcoreRun, "id" | "file_name" | "revision" | "created_at" |
  "status" | "source_row_count" | "finalized_at" | "closeout" | "last_imported_at">;
