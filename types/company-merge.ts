export interface CompanyMergeCandidate {
  id: number;
  company_name: string;
  city?: string | null;
  state?: string | null;
  active: boolean;
}

export interface CompanyMergeCounts {
  primary: number;
  secondary: number;
}

export interface CompanyMergePreview {
  primary: Record<string, unknown> & { id: number; company_name: string };
  secondary: Record<string, unknown> & { id: number; company_name: string };
  snapshot: string;
  fields: string[];
  counts: Record<string, CompanyMergeCounts>;
  projects: { primary: number; secondary: number; shared: number; union: number };
  compliance: Array<{
    compliance_type_id: number;
    compliance_name: string;
    records: Array<{
      id: number;
      contractor_id: number;
      registration_number: string | null;
      effective_date: string | null;
      expiration_date: string | null;
      registry_status: string | null;
      [field: string]: unknown;
    }>;
  }>;
  contacts: Array<{
    id: string;
    contractor_id: number;
    contact_name: string;
    is_primary_contact: boolean;
    is_active: boolean;
  }>;
  blockers: string[];
}

export interface CompanyMergeResult {
  merge_id: string;
  successor_id: number;
  already_processed?: boolean;
}

export type CompanyMergeChoices = Record<string, "primary" | "secondary">;
export type CompanyMergeComplianceChoices = Record<string, number>;
