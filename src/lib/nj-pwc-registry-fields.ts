export const njPwcRegistryFields = [
  { key: "companyName", field: "company_name", candidate: "business_name", label: "Company Name" },
  { key: "pwcNumber", field: "nj_pwc_number", candidate: "certificate_number", label: "NJ PWC #" },
  { key: "address", field: "address_1", candidate: "address", label: "Address 1" },
  { key: "city", field: "city", candidate: "city", label: "City" },
  { key: "state", field: "state", candidate: "state", label: "State" },
  { key: "zip", field: "zip_code", candidate: "zip_code", label: "ZIP Code" },
  { key: "county", field: "county", candidate: "county", label: "County" },
] as const;

export type NjPwcRegistryField = typeof njPwcRegistryFields[number]["field"];

export const njPwcExceptionButtonClass = "inline-flex h-7 shrink-0 items-center justify-center whitespace-nowrap rounded-md border px-2 text-xs font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:cursor-not-allowed disabled:opacity-50";

export type NjPwcExceptionCandidates = {
  exception_id: number;
  contractor_id: number;
  company_name: string;
  search_request_id: number;
  is_test: boolean;
  snapshot: string;
  candidates: {
    identity: string;
    business_name: string;
    certificate_number: string;
    address?: string | null;
    city?: string | null;
    state?: string | null;
    zip_code?: string | null;
    county?: string | null;
    registration_date?: string | null;
    expiration_date?: string | null;
    source_url?: string | null;
  }[];
};

export type NjPwcRegistryMatch = {
  exception_id: number;
  contractor_id: number;
  search_request_id: number;
  is_test: boolean;
  current: Record<NjPwcRegistryField | "address_2", string | null>;
  known_certificates: string[];
  candidate: {
    business_name: string;
    certificate_number: string;
    address: string | null;
    city: string | null;
    state: string | null;
    zip_code: string | null;
    county: string | null;
    registration_date: string | null;
    expiration_date: string | null;
  } | null;
  evidence: {
    confidence: "High" | "Medium" | "Low";
    certificate_match: boolean;
    street_address_match: boolean;
    city_match: boolean;
    state_match: boolean;
    zip_match: boolean;
    unit_conflict: boolean;
    registration_active: boolean;
    expired: boolean;
    registry_anomaly: boolean;
  };
  snapshot: string;
  duplicate_target: boolean;
  can_accept: boolean;
  mode: string;
};
