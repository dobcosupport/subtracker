export const COMPANY_CONTACT_COLUMNS = ["Name", "Cell", "Email"] as const;
export const COMPANY_CONTACT_SHEET = "Company Contacts";
export const COMPANY_CONTACT_MAX_ROWS = 2000;

export type CompanyContactValues = { contact_name: string; mobile_phone: string | null; email: string | null };
export type CompanyContactSnapshot = CompanyContactValues & { id: string; is_active: boolean; updated_at: string };
export type CompanyContactReference = CompanyContactSnapshot & { version: string };
export type CompanyContactSource = { source_row: number; original: Record<typeof COMPANY_CONTACT_COLUMNS[number], string> };
export type CompanyContactAction = "ADD" | "UPDATE" | "KEEP" | "SKIP" | "UNDO";
export type CompanyContactImportRow = CompanyContactSource & {
  id: string;
  normalized: CompanyContactValues;
  matching_keys: string[];
  status: "NEW" | "MATCHED" | "REVIEW" | "SKIP" | "IMPORTED" | "UPDATED" | "ERROR";
  issues: string[];
  duplicate_rows: number[];
  suggestions: CompanyContactReference[];
  exact_matches: CompanyContactReference[];
  resolution: { action: CompanyContactAction; contact_id: string | null; values: CompanyContactValues; approved_by: string; approved_at: string } | null;
  contact_id: string | null;
  error: string | null;
  events: { action: string; actor: string; at: string; [key: string]: unknown }[];
  before_contact: CompanyContactSnapshot | null;
  after_contact: CompanyContactSnapshot | null;
};
export type CompanyContactBatch = {
  id: string; file_name: string; created_at: string; created_by: string; revision: number;
  status: "Review" | "Partial" | "Complete"; notices: string[]; import_history_id: number | null;
};
export type CompanyContactsReview = {
  batch: CompanyContactBatch;
  rows: CompanyContactImportRow[];
  contacts: CompanyContactReference[];
  summary: { total: number; imported: number; updated: number; skipped: number; errors: number; unresolved: number; ready: number };
};
