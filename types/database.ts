export interface Contractor {
  id: number;
  company_name: string;
  trade: string | null;
  contact_name: string | null;
  email: string | null;
  phone: string | null;
  address_1?: string | null;
  address_2?: string | null;
  city?: string | null;
  state?: string | null;
  zip_code?: string | null;
  county?: string | null;
  nj_pwc_number?: string | null;
  nj_brc_number?: string | null;
  ny_pwc_number?: string | null;
  ny_brc_number?: string | null;
  brc_name_control?: string | null;
  brc_name_control_is_manual?: boolean;
  material_vendor_only?: boolean;
  sage_erp_id?: string | null;
  notes: string | null;
  external_id: string | null;
  legacy_id: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export type ContractorInput = Omit<Contractor, "id" | "created_at" | "updated_at">;

export interface InsuranceTracking {
  contractor_id: number;
  certificate_on_file: boolean;
  general_liability_on_file: boolean;
  general_liability_expiration_date: string | null;
  workers_comp_on_file: boolean;
  workers_comp_expiration_date: string | null;
  last_verified_date: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface InsuranceVerificationHistory {
  id: number;
  contractor_id: number;
  coi_on_file: boolean;
  general_liability_on_file: boolean | null;
  general_liability_expiration_date: string | null;
  workers_comp_on_file: boolean | null;
  workers_comp_expiration_date: string | null;
  verified_date: string | null;
  notes: string | null;
  created_at: string;
}

export interface Project {
  id: number;
  project_number: string;
  project_name: string;
  status: string;
  inactivated_by: string | null;
  inactivated_at: string | null;
  reactivated_by: string | null;
  reactivated_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProjectAssignment {
  contractors: {
    company_name: string;
    trade: string | null;
    active: boolean;
  } | null;
}

export interface ContractorProject {
  id: number;
  contractor_id: number;
  project_id: number;
  assigned_date: string;
  removed_date: string | null;
  active: boolean;
  created_at: string;
}

export interface Assignment extends ContractorProject {
  contractors: {
    company_name: string;
  } | null;
  projects: {
    project_number: string;
    project_name: string;
    status: string;
    inactivated_by: string | null;
    inactivated_at: string | null;
  } | null;
}

export interface ComplianceType {
  id: number;
  compliance_name: string;
  requires_expiration: boolean;
  active: boolean;
}

export interface ComplianceRecord {
  id: number;
  contractor_id: number;
  compliance_type_id: number;
  registration_number: string | null;
  effective_date: string | null;
  expiration_date: string | null;
  verified_date: string | null;
  verified_by: string | null;
  verification_source: string | null;
  is_current: boolean;
  active: boolean;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export type ComplianceStatus =
  | "Active"
  | "90 Day"
  | "60 Day"
  | "30 Day"
  | "Expired"
  | "Missing Information";

export interface ComplianceStatusRecord {
  contractor_id: number;
  company_name: string;
  contractor_active: boolean;
  compliance_record_id: number;
  compliance_type_id: number;
  compliance_name: string;
  registration_number: string | null;
  effective_date: string | null;
  expiration_date: string | null;
  days_remaining: number | null;
  calculated_status: ComplianceStatus;
}

export interface ComplianceHistoryRecord {
  id: number;
  contractor_id: number;
  compliance_type_id: number;
  compliance_name: string;
  registration_number: string | null;
  effective_date: string | null;
  expiration_date: string | null;
  active: boolean;
  is_current: boolean;
  days_remaining: number | null;
  calculated_status: ComplianceStatus;
}

export interface Document {
  id: number;
  contractor_id: number;
  compliance_record_id: number | null;
  document_name: string;
  document_type: string;
  storage_path: string;
  original_file_name: string | null;
  storage_provider: string | null;
  file_size_bytes: number | null;
  upload_date: string;
  expiration_date: string | null;
  created_at: string;
}

export interface ActivityLog {
  id: number;
  contractor_id: number | null;
  project_id: number | null;
  activity_date: string;
  activity_type: string;
  notes: string | null;
  follow_up_date: string | null;
  created_by: string | null;
  created_at: string;
}

export type FollowupMethod = "Email" | "Phone" | "Meeting" | "Text" | "Other";
export type FollowupStatus = "Open" | "Waiting Response" | "Resolved" | "Closed";

export interface ContractorFollowup {
  id: number;
  contractor_id: number;
  compliance_record_id: number | null;
  compliance_type_id: number | null;
  insurance_item_key: "certificate_of_insurance" | "general_liability" | "workers_compensation" | null;
  related_type?: { compliance_name: string } | null;
  followup_date: string;
  followup_method: FollowupMethod;
  subject: string;
  notes: string | null;
  status: FollowupStatus;
  created_at: string;
  updated_at: string;
}

export interface Reminder {
  id: number;
  contractor_id: number;
  compliance_record_id: number;
  reminder_stage: "90 Day" | "60 Day" | "30 Day" | "Expired";
  expiration_date_snapshot: string;
  scheduled_date: string;
  generated_date: string;
  sent_date: string | null;
  delivery_status: string;
  acknowledged_date: string | null;
  resolved_date: string | null;
  notes: string | null;
  created_at: string;
}

export interface ContractorTieredSub {
  id: number;
  contractor_id: number;
  tiered_sub_contractor_id: number;
  active: boolean;
  assigned_date: string;
  removed_date: string | null;
  created_at: string;
  updated_at: string;
}

export interface TieredSubRecord extends ContractorTieredSub {
  tiered_sub_contractor: {
    company_name: string;
  } | null;
}
