export type UnlinkCompliance = "NJ PWC" | "NJ BRC";

export interface ComplianceUnlinkHistory {
  record_id: number;
  reason: string;
  unlinked_at: string;
  administrator: string;
  record_company_name: string | null;
  identifiers: { previous: string | null; resulting: string | null } | null;
}

export interface UnlinkContractor {
  id: number;
  company_name: string;
  active: boolean;
}

export interface UnlinkRecord {
  id: number;
  registration_number: string | null;
  synced_registration_number: string | null;
  certificate_number: string | null;
  matched_business_entity_id: string | null;
  matched_company_name: string | null;
  searched_name_control: string | null;
  effective_date: string | null;
  expiration_date: string | null;
  verified_date: string | null;
  verification_source: string | null;
  active: boolean;
  is_current: boolean;
  updated_at: string;
  supplies_identifier: boolean;
  unlinked_at: string | null;
}

export interface UnlinkSelection {
  contractor: UnlinkContractor & {
    nj_pwc_number: string | null;
    nj_brc_number: string | null;
    brc_name_control: string | null;
    city: string | null;
    state: string | null;
    zip_code: string | null;
  };
  records: UnlinkRecord[];
}
