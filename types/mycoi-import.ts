export const MYCOI_HEADINGS = [
  "Division Name", "Vendor Name", "Vendor Email", "Vendor Phone", "Compliance Status", "Policy Expiration Dates",
] as const;
export type MycoiHeading = typeof MYCOI_HEADINGS[number];
export type SourceRow = { row: number } & Record<MycoiHeading, string>;
export interface ParsedPolicy {
  policyNumber: string;
  expirationDate: string;
  isExpired: boolean;
  policyLines: string[];
}
export interface PolicyParseResult {
  raw: string;
  policies: ParsedPolicy[];
  errors: string[];
}
export interface ImportDecisions {
  addContractors?: string[];
  vendors: Record<string, number>;
  divisions: Record<string, number>;
  contacts: Record<string, { email?: string; phone?: string }>;
  ignored: number[];
}
export interface ImportReference {
  token: string;
  contractors: { id: number; company_name: string; active: boolean }[];
  projects: { id: number; project_number: string; project_name: string }[];
  vendors: { id: number; contractor_id: number; raw_vendor_name: string; vendor_email: string | null; vendor_phone: string | null; active: boolean }[];
  divisions: { id: number; raw_division_name: string; project_id: number | null; active: boolean }[];
  statuses: { id: number; vendor_mapping_id: number; division_mapping_id: number; compliance_status: string | null; active: boolean; is_current: boolean }[];
  policies: { id: number; contractor_id: number; vendor_mapping_id: number; policy_line: string; policy_number: string | null; expiration_date: string | null; expired: boolean | null; active: boolean; is_current: boolean }[];
  links: { policy_id: number; contractor_division_id: number }[];
}
export interface ReviewIssue {
  category: "Vendor Review Required" | "Project Review Required" | "Policy Parse Errors" | "Contact Review Required" | "Source Review Required";
  reason: string;
  rows: number[];
}
export interface VendorReview {
  addContractor: boolean;
  key: string;
  raw: string;
  rows: SourceRow[];
  contractorId: number | null;
  saved: boolean;
  suggestions: { id: number; label: string; reason: string }[];
  emailValues: string[];
  phoneValues: string[];
  existingEmail: string | null;
  existingPhone: string | null;
}
export interface DivisionReview {
  key: string;
  raw: string;
  projectId: number | null;
  saved: boolean;
  automatic: boolean;
  suggestions: { id: number; label: string; reason: string }[];
}
export interface VendorPlan {
  createContractor?: boolean;
  key: string;
  raw: string;
  contractorId: number;
  email: string | null;
  phone: string | null;
  rows: number[];
  divisions: { key: string; raw: string; projectId: number; status: string }[];
  policies: { line: string; number: string; expiration: string; expired: boolean; divisions: string[] }[];
}
export interface ImportPreview {
  summary: {
    rowsRead: number; uniqueVendors: number; matchedVendors: number; vendorsRequiringReview: number;
    matchedDivisions: number; divisionsRequiringReview: number; policiesParsed: number;
    policyParseErrors: number; contactChanges: number; insuranceChanges: number;
    readyRows: number; unresolvedRows: number; ignoredRows: number;
  };
  vendors: VendorReview[];
  divisions: DivisionReview[];
  issues: ReviewIssue[];
  rowPolicies: Record<number, PolicyParseResult>;
  ready: VendorPlan[];
}
export interface MycoiImportRun {
  id: string;
  file_name: string;
  created_at: string;
  updated_at: string;
  last_imported_at: string | null;
  revision: number;
  source_rows: SourceRow[];
  source_row_count: number;
  decisions: ImportDecisions;
  imported_rows: number[];
  metrics: { rows: number; vendors: number; policies: number; changes: number; exceptions: number };
  status: "Review" | "Partial" | "Complete";
  import_history_id: number | null;
  imported_vendor_keys: string[];
  imported_policy_ids: number[];
  finalized_at: string | null;
  finalized_by: string | null;
  closeout: MycoiCloseout | null;
  finalized_review: MycoiReviewSnapshot | null;
  artifacts_purged_at: string | null;
}

export interface MycoiCloseout {
  totalRows: number;
  totalVendors: number;
  matchedExistingVendors: number;
  contractorsAdded: number;
  unmatchedVendors: number;
  stagedContractorsNotCreated: number;
  matchedProjects: number;
  unresolvedProjects: number;
  policiesImported: number;
}

export interface MycoiReviewSnapshot {
  preview: ImportPreview;
  contractors: ImportReference["contractors"];
  projects: ImportReference["projects"];
}
