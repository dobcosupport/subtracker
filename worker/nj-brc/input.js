"use strict";

const INVALID_FEIN_MESSAGE =
  "Invalid Taxpayer ID (FEIN): expected 9 digits before NJ BRC formatting.";

function normalizeFederalTaxIdForNjBrcLookup(value) {
  if (typeof value !== "string") {
    return { ok: false, error: INVALID_FEIN_MESSAGE };
  }

  const trimmed = value.trim();
  if (!trimmed || /[^\d\s().-]/.test(trimmed)) {
    return { ok: false, error: INVALID_FEIN_MESSAGE };
  }

  const digits = trimmed.replace(/\D/g, "");
  if (digits.length !== 9) {
    return { ok: false, error: INVALID_FEIN_MESSAGE };
  }

  return { ok: true, taxpayerId: `${digits}000` };
}

module.exports = {
  INVALID_FEIN_MESSAGE,
  normalizeFederalTaxIdForNjBrcLookup,
};
