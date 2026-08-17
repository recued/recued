/** D-240 slice 2 — mint a submitter's viewback credential at submit time.
 *
 *  ONE helper, two callers (the intake submit handler and the booking one), for
 *  the reason the reception substrate keeps re-learning: two copies of a
 *  security-relevant decision drift, and the half that drifts is the one nobody
 *  is looking at. Everything policy-shaped lives here — which modes are
 *  mintable, what happens when the anchor is missing, and what a failure means
 *  for the visitor.
 *
 *  Spec: D-240 § D1 / D3 / D6 / D10. */

import {
  resolveVisitorLookupExpiry,
  type ReceptionRecordKind,
  type VisitorLookupConfig,
} from '@recued/contracts';

import type { ReceptionManageCredentialStore } from '../../../storage/reception-manage-credential-store.js';

/** The URL prefix the viewback route is mounted at. Slice 3 hangs the handler
 *  here; slice 2 mints links that point at it. */
export const RECEPTION_LOOKUP_PATH = '/reception/lookup' as const;

export interface MintVisitorLookupArgs {
  /** The endpoint's `visitor_lookup` config. Absent / disabled ⇒ no mint. */
  readonly config: VisitorLookupConfig | undefined;
  /** Absent on a server without the credential store wired ⇒ no mint. */
  readonly store: ReceptionManageCredentialStore | undefined;
  readonly endpoint_id: string;
  /** The durable row this credential is scoped to — the submission id. */
  readonly record_id: string;
  readonly now: number;
  /** `scheduling_link` for a booking, `intake_form` for an intake. Drives which
   *  expiry modes are even reachable (the config validator already refused the
   *  others at write time; this is the runtime half of the same closed list). */
  readonly record_kind?: ReceptionRecordKind;
  /** `after_event` only — the booking slot's own end. */
  readonly slot_end_at?: number;
  /** `after_field` only — the visitor's submitted field values. ⚠ Passed WHOLE
   *  rather than pre-extracted so the anchor field name stays a config concern:
   *  the caller does not need to know which field the owner chose, and cannot
   *  get it wrong. Only the named one is read, and only to compute a number. */
  readonly field_values?: Readonly<Record<string, unknown>>;
}

/** Mint and return the RELATIVE viewback path, or `null` when there is nothing
 *  to mint.
 *
 *  ⛔ NEVER THROWS. Every caller reaches this AFTER the durable submission row
 *  is committed, so a throw here would turn a recorded submission into an error
 *  page — the visitor would be told their request failed when it did not, and
 *  would re-submit. The link is a convenience; the submission is the product.
 *  A failure is logged and the receipt renders without a link, which is exactly
 *  what an endpoint with the feature disabled renders. */
export const mintVisitorLookupPath = (args: MintVisitorLookupArgs): string | null => {
  const { config, store } = args;
  if (!config || config.enabled !== true || store === undefined) return null;

  const resolved = resolveVisitorLookupExpiry({
    expiry: config.expiry,
    now: args.now,
    ...(args.slot_end_at === undefined ? {} : { slot_end_at: args.slot_end_at }),
    ...(config.expiry.mode === 'after_field'
      ? { field_value: args.field_values?.[config.expiry.field] }
      : {}),
  });

  if (resolved.kind !== 'resolved' && resolved.kind !== 'deferred') {
    // `unsupported` — an author configured a mode whose slice has not landed;
    // the config validator refuses these at write time, so reaching here means
    // a config stored before that refusal existed.
    // `anchor_missing` — an `after_event` mint on a record carrying no slot end.
    // ⚠ Both are LOUD. Silence here is the shape where a feature is enabled, a
    // receipt renders with no link, and nothing anywhere says why.
    console.warn(
      `[visitor-lookup] no credential minted for record '${args.record_id}' on endpoint `
      + `'${args.endpoint_id}': ${resolved.kind} (mode '${resolved.mode}')`,
    );
    return null;
  }

  // D-240 slice 5 — a visitor anchor that would not parse is not a failure the
  // submitter can see (they get a conservative window), but it IS one the owner
  // needs: a form whose anchor field never parses issues short links forever and
  // looks like it is working. One line per submission is the right volume — it
  // is per-form-misconfiguration, not per-request noise.
  if (resolved.kind === 'resolved' && resolved.anchor === 'fallback') {
    console.warn(
      `[visitor-lookup] anchor field did not parse for record '${args.record_id}' on `
      + `endpoint '${args.endpoint_id}' — issued the default window instead`,
    );
  }

  try {
    const issued = store.issue({
      kind: args.record_kind ?? 'intake_form',
      endpoint_id: args.endpoint_id,
      record_id: args.record_id,
      // ⛔ The VISITOR capability — repeatable read, never the owner's
      // single-use write. The store fences the two apart on this value.
      purpose: 'lookup',
      now: args.now,
      ceiling_at: resolved.ceiling_at,
      // D-240 slice 4 — the deferred arm carries its GRACE instead of a ttl:
      // there is no anchor to count from yet. The store starts such a credential
      // at the ceiling and the stamp sweep shortens it once the record resolves.
      ...(resolved.kind === 'deferred'
        ? { deferred_grace_ms: resolved.grace_ms }
        : { ttl_ms: resolved.expires_at - args.now }),
    });
    return `${RECEPTION_LOOKUP_PATH}/${issued.secret}`;
  } catch (error) {
    console.warn(
      `[visitor-lookup] credential mint failed for record '${args.record_id}': `
      + (error instanceof Error ? error.message : String(error)),
    );
    return null;
  }
};
