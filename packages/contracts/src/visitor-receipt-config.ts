/** D-149 § A.20.3 — Visitor Receipt per-endpoint config.
 *
 *  The config-side half of the Visitor Receipt feature: the `via`
 *  closed list + the `VisitorReceiptConfig` shape + its validator. Split
 *  out of `reception-visitor-ux.ts` so the four per-kind config
 *  contracts (`scheduling-link-config.ts` / `intake-form-config.ts` /
 *  `drop-link-config.ts` / `approval-link-config.ts`) can carry an
 *  optional `visitor_receipt?: VisitorReceiptConfig` field + delegate to
 *  `validateVisitorReceiptConfig` WITHOUT a circular import:
 *  `reception-visitor-ux.ts` already imports all four per-kind config
 *  files (for the Launch Wizard validator), so the per-kind files cannot
 *  import back from it. This file imports NOTHING — it is the shared
 *  leaf both sides depend on.
 *
 *  The "built receipt" half (`VisitorReceipt` / `VisitorReceiptInput` /
 *  `buildVisitorReceipt`) stays in `reception-visitor-ux.ts` — it needs
 *  `ReceptionEndpointKind` + is about the rendered receipt object, not
 *  the persisted config.
 *
 *  Spec: D-149 § A.20.3. */

/** Per-endpoint receipt-delivery mode. `page` (default) renders the
 *  receipt server-side for the visitor to save / print; `email` sends
 *  it to the visitor-self-reported address via D-127 mail-send. */
export type VisitorReceiptVia = 'email' | 'page';

export const VISITOR_RECEIPT_VIA_VALUES: ReadonlyArray<VisitorReceiptVia> = [
  'email',
  'page',
] as const;

export const VISITOR_RECEIPT_VIA_SET: ReadonlySet<VisitorReceiptVia> = new Set(
  VISITOR_RECEIPT_VIA_VALUES,
);

/** Default delivery mode when a config omits `via` — page-only (no
 *  email; the user opts in). */
export const VISITOR_RECEIPT_DEFAULT_VIA: VisitorReceiptVia = 'page';

/** Per-endpoint visitor-receipt config (§ A.20.3). Persisted alongside
 *  the per-kind config blob; absent ⇒ receipts disabled (the
 *  conservative default — receipts are opt-in). `via` is optional —
 *  an omitted `via` resolves to `VISITOR_RECEIPT_DEFAULT_VIA` ('page')
 *  per § A.20.3 "Default: page-only". */
export interface VisitorReceiptConfig {
  readonly enabled: boolean;
  readonly via?: VisitorReceiptVia;
}

export type VisitorReceiptConfigValidationCode =
  | 'config_shape_invalid'
  | 'enabled_invalid'
  | 'via_unknown';

export interface VisitorReceiptConfigValidationFailure {
  readonly code: VisitorReceiptConfigValidationCode;
  readonly detail: string;
}

/** Validate a `VisitorReceiptConfig` shape. Pure function — no I/O.
 *  Returns the list of failures; empty array ⇒ valid. `via` is
 *  OPTIONAL — an omitted `via` is accepted (it resolves to the
 *  documented `VISITOR_RECEIPT_DEFAULT_VIA` default at build time); a
 *  PRESENT `via` must be in the closed list. */
export const validateVisitorReceiptConfig = (
  config: unknown,
): ReadonlyArray<VisitorReceiptConfigValidationFailure> => {
  const failures: VisitorReceiptConfigValidationFailure[] = [];
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    return [{ code: 'config_shape_invalid', detail: 'visitor_receipt config must be an object' }];
  }
  const c = config as Record<string, unknown>;
  if (typeof c.enabled !== 'boolean') {
    failures.push({ code: 'enabled_invalid', detail: 'visitor_receipt.enabled must be a boolean' });
  }
  // `via` is optional — absent ⇒ the documented page-only default. Only
  // a PRESENT value is gated against the closed list (Codex P2 fold —
  // the validator previously rejected the documented `{ enabled: true }`
  // default-via shape).
  if (
    c.via !== undefined &&
    (typeof c.via !== 'string' || !VISITOR_RECEIPT_VIA_SET.has(c.via as VisitorReceiptVia))
  ) {
    failures.push({
      code: 'via_unknown',
      detail: `visitor_receipt.via must be one of ${VISITOR_RECEIPT_VIA_VALUES.join(', ')} when present`,
    });
  }
  return failures;
};
