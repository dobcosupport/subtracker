// =====================================================================
// NJ BRC RPA mapping — input normalization & validation (server-only)
//
// Lookup inputs come from the contractor MASTER record, never the Active
// Compliance Record:
//   NJ website "Name Control"        <- contractors.brc_name_control
//   NJ website "Business Entity ID"  <- contractors.nj_brc_number
//
// Normalization is applied to the values SENT to the RPA only. It never
// overwrites the stored contractor value (a manually maintained BRC Name
// Control is preserved in the contractors table untouched).
// =====================================================================

export interface NjBrcLookupInput {
  brc_name_control: string;
  nj_brc_number: string;
}

export type NjBrcValidationError =
  | "Missing BRC Name Control"
  | "Missing NJ BRC Number"
  | "Invalid BRC Name Control"
  | "Invalid Business Entity ID";

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
export function validateNjBrcLookup(contractor: { active?: boolean | null; brc_name_control?: string | null; nj_brc_number?: string | null }):
  | { ok: true; input: NjBrcLookupInput }
  | { ok: false; error: NjBrcValidationError } {
  const nameControl = normalizeBrcNameControl(contractor.brc_name_control);
  const brcNumber = normalizeNjBrcNumber(contractor.nj_brc_number);

  if (!contractor.brc_name_control || nameControl.length === 0) return { ok: false, error: "Missing BRC Name Control" };
  if (!isValidBrcNameControl(nameControl)) return { ok: false, error: "Invalid BRC Name Control" };
  if (!contractor.nj_brc_number || brcNumber.length === 0) return { ok: false, error: "Missing NJ BRC Number" };
  if (!isValidNjBrcNumber(brcNumber)) return { ok: false, error: "Invalid Business Entity ID" };

  return { ok: true, input: { brc_name_control: nameControl, nj_brc_number: brcNumber } };
}
