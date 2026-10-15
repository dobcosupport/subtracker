export interface MycoiProvenance {
  last_imported_at: string | null;
  import_reference: string | null;
  import_history_id: number | null;
}

export interface MycoiVendorMapping extends MycoiProvenance {
  id: number;
  contractor_id: number;
  raw_vendor_name: string;
  vendor_email: string | null;
  vendor_phone: string | null;
  active: boolean;
}

export interface MycoiContractorDivision extends MycoiProvenance {
  id: number;
  vendor_mapping_id: number;
  division_mapping_id: number;
  compliance_status: string | null;
  active: boolean;
  is_current: boolean;
  division: {
    raw_division_name: string;
    leading_project_number: string | null;
    project_id: number | null;
    project: { project_number: string; project_name: string } | null;
  } | null;
}

export interface MycoiPolicy extends MycoiProvenance {
  id: number;
  contractor_id: number;
  vendor_mapping_id: number;
  policy_line: string;
  policy_number: string | null;
  expiration_date: string | null;
  expired: boolean | null;
  source: "myCOI";
  active: boolean;
  is_current: boolean;
  divisions: { contractor_division_id: number }[];
}

export interface MycoiInsurance {
  vendors: MycoiVendorMapping[];
  divisions: MycoiContractorDivision[];
  policies: MycoiPolicy[];
}
