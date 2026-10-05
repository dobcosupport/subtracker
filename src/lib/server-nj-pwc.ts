// =====================================================================
// NJ PWC RPA mapping — input normalization & validation (server-only)
//
// Lookup inputs come from the contractor MASTER record, never the Active
// Compliance Record:
//   NJ Public Works "Certificate #"        <- contractors.nj_pwc_number
//   NJ Public Works "Business Name"        <- contractors.company_name
//   (fallback match keys: zip_code, city)
//
// Normalization is applied to the values SENT to the RPA only. It never
// overwrites the stored contractor value.
// =====================================================================

export interface NjPwcLookupInput {
  nj_pwc_number: string;
  company_name: string;
  zip_code: string;
  city: string;
}

export type NjPwcValidationError =
  | "Missing NJ PWC Number"
  | "Invalid NJ PWC Number"
  | "Missing Company Name";

/**
 * Normalize the NJ PWC Certificate / Registration Number for submission.
 * - Treated as text; never converted to a number
 * - Trim spaces
 * - Remove display spaces and dashes
 * - Preserve leading zeros
 */
export function normalizeNjPwcNumber(value: string | null | undefined): string {
  return (value ?? "").trim().replace(/[\s-]/g, "");
}

/** Validate an NJ PWC Number after normalization (must be alphanumeric). */
export function isValidNjPwcNumber(value: string): boolean {
  if (value.length === 0) return false;
  return /^[A-Z0-9]+$/i.test(value);
}

/**
 * Validate contractor master inputs for an NJ PWC lookup. Returns the
 * normalized inputs on success, or the first validation error. Does not
 * mutate the stored contractor values.
 */
export function validateNjPwcLookup(contractor: { nj_pwc_number?: string | null; company_name?: string | null; zip_code?: string | null; city?: string | null }):
  | { ok: true; input: NjPwcLookupInput }
  | { ok: false; error: NjPwcValidationError } {
  const pwcNumber = normalizeNjPwcNumber(contractor.nj_pwc_number);
  const companyName = (contractor.company_name ?? "").trim();
  const zipCode = (contractor.zip_code ?? "").trim();
  const city = (contractor.city ?? "").trim();

  if (!contractor.nj_pwc_number || pwcNumber.length === 0) return { ok: false, error: "Missing NJ PWC Number" };
  if (!isValidNjPwcNumber(pwcNumber)) return { ok: false, error: "Invalid NJ PWC Number" };
  if (companyName.length === 0) return { ok: false, error: "Missing Company Name" };

  return { ok: true, input: { nj_pwc_number: pwcNumber, company_name: companyName, zip_code: zipCode, city } };
}
