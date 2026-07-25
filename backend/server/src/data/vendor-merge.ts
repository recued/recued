/** D-138 P5 — vendor-merge client interface.
 *
 *  One implementation per (vendor, object_type) pair. The driver
 *  resolves the implementation via the registry (keyed by the
 *  `UpstreamMergeObjectType` discriminator) and calls `merge()` once
 *  per attempt. Implementations are responsible for HTTP / SOAP
 *  semantics; the driver owns retry / backoff / state-transition
 *  bookkeeping.
 *
 *  Spec: `docs/d-138-spec.md` § A.7 + § Phase 5. */

import type {
  ConnectionRecord,
  UpstreamMergeError,
  UpstreamMergeFieldOutcome,
  UpstreamMergeObjectType,
  UpstreamMergeVendorPair,
} from '@recued/contracts';

// ────────────────────────────────────────────────────────────────
// Outcome types
// ────────────────────────────────────────────────────────────────

/** Successful vendor-merge outcome. */
export interface VendorMergeSuccess {
  ok: true;
  /** Vendor's response — opaque to the driver but logged for forensics. */
  vendor_response?: Record<string, unknown>;
}

/** Failed vendor-merge outcome — split into retryable + terminal so the
 *  driver knows whether to schedule another attempt or settle into
 *  `vendor_merge_failed`. The structured `error` is what the outbox
 *  row stores + the broadcast bus surfaces. */
export interface VendorMergeFailureRetryable {
  ok: false;
  retryable: true;
  error: UpstreamMergeError;
}

export interface VendorMergeFailureTerminal {
  ok: false;
  retryable: false;
  error: UpstreamMergeError;
}

export type VendorMergeResult =
  | VendorMergeSuccess
  | VendorMergeFailureRetryable
  | VendorMergeFailureTerminal;

/** Side-by-side preview of a single survivor + loser pair. The
 *  describe rpc surfaces this; the modal renders it. */
export interface VendorMergePreview {
  field_outcomes: UpstreamMergeFieldOutcome[];
  vendor_semantics_summary: string;
  /** True when the vendor + object_type expose a callable merge API.
   *  False for `salesforce:contact` — the modal renders the degraded-
   *  path explanation. */
  dispatchable: boolean;
  survivor_last_modified?: string;
  loser_last_modified?: string;
}

// ────────────────────────────────────────────────────────────────
// Client interface
// ────────────────────────────────────────────────────────────────

/** One vendor-merge client per `(vendor, object_type)` pair. The
 *  driver passes a `ConnectionRecord` so the client can read the
 *  freshest auth token + base URL + sandbox toggle (Salesforce). */
export interface VendorMergeClient {
  readonly object_type: UpstreamMergeObjectType;

  /** Render the modal preview. Best-effort — fetches both records
   *  from the vendor + projects per-field outcomes per the vendor's
   *  documented merge rules. Salesforce returns `winner: 'unknown'`
   *  per field (their per-field merge semantics aren't documented as
   *  a stable contract). HubSpot uses "most-recent value wins" per
   *  their docs. */
  describe(
    connection: ConnectionRecord,
    pair: UpstreamMergeVendorPair,
  ): Promise<VendorMergePreview>;

  /** Fire the merge. Idempotent on `idempotency_key` (HubSpot uses an
   *  Idempotency-Key header; Salesforce SOAP carries it as a tracking
   *  id we log + send on the SOAPAction header). */
  merge(
    connection: ConnectionRecord,
    pair: UpstreamMergeVendorPair,
    idempotency_key: string,
  ): Promise<VendorMergeResult>;
}

// ────────────────────────────────────────────────────────────────
// Degraded-path stub — Salesforce contact
// ────────────────────────────────────────────────────────────────

/** Salesforce's standard API doesn't expose Contact merge — the
 *  modal explains the degraded path + the local-only merge proceeds.
 *  This stub is registered as the `salesforce:contact` client so the
 *  registry has a uniform surface; `dispatchable: false` short-
 *  circuits the driver before the merge call fires. */
export const SALESFORCE_CONTACT_DEGRADED: VendorMergeClient = {
  object_type: 'salesforce:contact',
  describe: async () => ({
    field_outcomes: [],
    vendor_semantics_summary:
      'Salesforce does not expose Contact merge in the standard API. We will merge locally only. Merge in Salesforce manually if you want the upstream cleanup.',
    dispatchable: false,
  }),
  merge: async () => ({
    ok: false,
    retryable: false,
    error: {
      code: 'salesforce_contact_not_dispatchable',
      message:
        'Salesforce Contact merge is not exposed in the standard API. Local merge proceeded; upstream merge requires manual action in Salesforce.',
    },
  }),
};
