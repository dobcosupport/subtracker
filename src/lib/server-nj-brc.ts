// =====================================================================
// NJ BRC RPA mapping — input normalization & validation (server-only)
//
// Lookup inputs come from the contractor MASTER record, never the Active
// Compliance Record:
//   NJ website "Name Control"        <- contractors.brc_name_control
//   NJ website "Taxpayer ID"         <- contractors.federal_tax_id (FEIN + '000')
//
// NJ BRC Number (Business Entity ID) is an output populated from the
// returned Certificate Number, not a search input.
// =====================================================================

export interface NjBrcLookupInput {
  brc_name_control: string;
  federal_tax_id: string;
  nj_brc_number?: string | null;
}

export type NjBrcValidationError =
  | "Missing BRC Name Control"
  | "Missing Taxpayer ID (FEIN)"
  | "Invalid BRC Name Control"
  | "Invalid Taxpayer ID (FEIN)";

/**
 * Normalize BRC Name Control for the NJ website lookup.
 * - Trim leading/trailing spaces
 * - Uppercase
 * - Remove unsupported punctuation (keeps letters, digits, spaces,
 *   ampersands, and hyphens)
 * - Collapse internal whitespace
 */
export function normalizeBrcNameControl(value: string | null | undefined): string {
  return (value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9 &\-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Normalize the NJ BRC Number (Business Entity ID) for submission.
 * - Treated as text; never converted to a number
 * - Trim spaces
 * - Remove display spaces and dashes
 * - Preserve leading zeros
 */
export function normalizeNjBrcNumber(value: string | null | undefined): string {
  return (value ?? "").trim().replace(/[\s-]/g, "");
}

/** Validate a BRC Name Control after normalization. */
export function isValidBrcNameControl(value: string): boolean {
  if (value.length === 0) return false;
  // Allowed characters only; length bounded by the source field (4 chars).
  return /^[A-Z0-9 &\-]+$/.test(value) && value.length <= 4;
}

/** Validate an NJ BRC Number after normalization (must be alphanumeric). */
export function isValidNjBrcNumber(value: string): boolean {
  if (value.length === 0) return false;
  return /^[A-Z0-9]+$/i.test(value);
}

/**
 * Validate contractor master inputs for an NJ BRC lookup. Returns the
 * normalized inputs on success, or the first validation error. Does not
 * mutate the stored contractor values.
 */
export function validateNjBrcLookup(contractor: {
  active?: boolean | null;
  brc_name_control?: string | null;
  federal_tax_id?: string | null;
  nj_brc_number?: string | null;
}):
  | { ok: true; input: NjBrcLookupInput }
  | { ok: false; error: NjBrcValidationError } {
  const nameControl = normalizeBrcNameControl(contractor.brc_name_control);

  if (!contractor.brc_name_control || nameControl.length === 0) return { ok: false, error: "Missing BRC Name Control" };
  if (!isValidBrcNameControl(nameControl)) return { ok: false, error: "Invalid BRC Name Control" };

  const rawFein = contractor.federal_tax_id ?? "";
  const digits = rawFein.replace(/\D/g, "");
  if (!digits) return { ok: false, error: "Missing Taxpayer ID (FEIN)" };
  if (digits.length !== 9 || !/^[0-9\s().-]+$/.test(rawFein.trim())) {
    return { ok: false, error: "Invalid Taxpayer ID (FEIN)" };
  }

  return {
    ok: true,
    input: {
      brc_name_control: nameControl,
      federal_tax_id: rawFein,
      nj_brc_number: contractor.nj_brc_number ?? null,
    },
  };
}
