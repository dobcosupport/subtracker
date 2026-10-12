export type NjBrcTaxpayerIdNormalization =
  | { ok: true; taxpayerId: string }
  | { ok: false; error: string };

export declare const INVALID_FEIN_MESSAGE: string;
export declare function normalizeFederalTaxIdForNjBrcLookup(
  value: unknown,
): NjBrcTaxpayerIdNormalization;
