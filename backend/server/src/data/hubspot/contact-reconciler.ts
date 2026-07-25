/** D-129 Phase 3 — HubSpot contact reconciler.
 *
 *  Implements `VendorReconciler` for `(hubspot, contact)`. Mirrors the
 *  deal reconciler's shape; the differences are:
 *
 *    - `email` is the canonical join key. `meta.email` is canonicalized
 *      (lowercase + trim) at projection time. The cross-source
 *      `engagement_score_per_contact` topic at P6 uses this field to
 *      join against Recued local `data.contact.<email>` for mail /
 *      calendar activity counts. A non-canonicalized email here would
 *      silently miss every record with capitalised characters, so
 *      canonicalization is contract-level rather than convenience.
 *    - `meta.name` reconstitutes from `firstname + ' ' + lastname`,
 *      falling back to the email local-part when both are absent.
 *      Empty strings + null are treated identically (HubSpot returns
 *      `null` for unset properties).
 *    - Hash tuple is `email / lifecycle_stage / owner / account_id`.
 *      `recent_activity_at` is intentionally excluded — HubSpot bumps
 *      `notes_last_contacted` on any logged activity (call / meeting /
 *      email open) including ones that don't change anything semantic-
 *      ally interesting about the contact. Including it would force a
 *      meta refresh + cascade event on every touch; the cascade
 *      should fire only when contact identity changes.
 *
 *  Spec: `docs/d-129-spec.md` § A.3, § Phase 3. */

import {
  canonicalizeMailingAddress,
  canonicalizePhone,
  HUBSPOT_CONTACT_PROPERTIES,
  HUBSPOT_DEFAULT_RECONCILIATION_CADENCE,
  PLATFORM_REFERENCE_BATCH_SIZE,
  composePlatformRecordTargetId,
  type ConnectionRecord,
  type EnrichmentMeta,
  type MailingAddress,
} from '@recued/contracts';

import type {
  ReconciliationCadence,
  SlimRecord,
  VendorReconciler,
  WebhookProcessor,
} from '../../housekeeping/reconciliation/vendor-reconciler.js';

import { fnv1aHex } from './_fnv1a.js';
import {
  searchHubSpotObjects,
  type HubSpotSearchDeps,
  type RawHubSpotRecord,
} from './_hubspot-search.js';

// ────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────

/** SlimRecord variant carrying the raw HubSpot payload. The harness
 *  reads only `id` + `modified_at`; `hashOf` + `toMeta` consume `_raw`
 *  to compute their outputs. */
export interface HubSpotContactSlimRecord extends SlimRecord {
  _raw: RawHubSpotRecord;
}

/** Construction-time deps. The boot wire injects the search helper
 *  deps; tests pass a deterministic `now()` and a fake fetcher. */
export interface HubSpotContactReconcilerDeps {
  search: HubSpotSearchDeps;
  /** Wall-clock used to stamp `meta.snapshot_at`. Defaults to
   *  `Date.now`. Tests pin this so snapshots round-trip exactly. */
  now?: () => number;
  /** D-129 P5 — optional webhook processor (entity='contact'). */
  webhookProcessor?: WebhookProcessor;
}

// ────────────────────────────────────────────────────────────────
// Reconciler
// ────────────────────────────────────────────────────────────────

/** D-129 P3 — `(hubspot, contact)` reconciler. One instance per server
 *  registered into the default `ReconcilerRegistry` at boot; per-
 *  connection task wiring lives in the `bin.ts` connection-upsert
 *  hook (P2.5). */
export class HubSpotContactReconciler implements VendorReconciler {
  readonly vendor = 'hubspot' as const;
  readonly entity = 'contact' as const;
  readonly default_cadence: ReconciliationCadence = HUBSPOT_DEFAULT_RECONCILIATION_CADENCE;
  readonly webhookProcessor?: WebhookProcessor;

  private readonly deps: HubSpotContactReconcilerDeps;

  constructor(deps: HubSpotContactReconcilerDeps) {
    this.deps = deps;
    if (deps.webhookProcessor) this.webhookProcessor = deps.webhookProcessor;
  }

  async *listUpdatedSince(
    connection: ConnectionRecord,
    cursor: number,
    limit: number,
  ): AsyncIterable<HubSpotContactSlimRecord> {
    const pageLimit = Math.min(limit, PLATFORM_REFERENCE_BATCH_SIZE);
    for await (const raw of searchHubSpotObjects(
      connection,
      {
        objectType: 'contacts',
        properties: HUBSPOT_CONTACT_PROPERTIES,
        modifiedSince: cursor,
        limit: pageLimit,
      },
      this.deps.search,
    )) {
      const modifiedAt = parseUnixMs(raw.properties.hs_lastmodifieddate);
      if (modifiedAt === null) continue;
      yield {
        id: composePlatformRecordTargetId(this.vendor, this.entity, connection.name, String(raw.id)),
        modified_at: modifiedAt,
        _raw: raw,
      };
    }
  }

  hashOf(record: HubSpotContactSlimRecord): string {
    return computeContactHash(record._raw);
  }

  toMeta(record: HubSpotContactSlimRecord): EnrichmentMeta {
    return projectContactMeta(record._raw, computeContactHash(record._raw), this.now());
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }
}

// ────────────────────────────────────────────────────────────────
// Hash + meta projection (exported for direct unit testing)
// ────────────────────────────────────────────────────────────────

/** D-129 P3 — canonical-field hash for a HubSpot contact record. Tuple
 *  uses *projected* email (canonicalized) so two raw records that
 *  differ only in email casing still hash identically. `lifecycle_stage`
 *  / `owner` / `account_id` participate; `recent_activity_at` does
 *  not — see file header for rationale.
 *
 *  D-138 P1 widens the tuple to include `phone` (E.164-canonicalized)
 *  + `address_hash` (SHA-style hash over canonicalized
 *  `MailingAddress`) + `company` (the contact-level company-string
 *  property). The widening forces a meta refresh + cascade when any
 *  of these change; tradeoff is more refreshes when phone/address/
 *  company churn, but without inclusion the merge predicate's
 *  identity fields would never refresh on existing records. Both
 *  HubSpot and the Salesforce parallel reconciler keep the same
 *  shape so downstream consumers don't have to vendor-specialize. */
export const computeContactHash = (raw: RawHubSpotRecord): string => {
  // D-138 P1 — use the same default country code as `projectContactMeta`
  // so a local-format phone change actually flips the hash. Without
  // the matching default, both inputs canonicalize to `''` here and
  // reconciliation would skip refreshing `meta.phone`.
  const phone = canonicalizePhone(raw.properties.phone, 'US') ?? '';
  const address = projectHubSpotMailingAddress(raw);
  const fields = [
    canonicalizeEmail(raw.properties.email) ?? '',
    raw.properties.lifecyclestage ?? '',
    raw.properties.hubspot_owner_id ?? '',
    raw.properties.associatedcompanyid ?? '',
    phone,
    address ? mailingAddressHashKey(address) : '',
    nullIfEmpty(raw.properties.company) ?? '',
  ];
  return `fnv1a:${fnv1aHex(fields.join('\x1f'))}`;
};

/** Stable string projection of a `MailingAddress` for inclusion in
 *  the canonical hash. Joining with `\x1f` keeps the hash insensitive
 *  to field-order rearrangement. */
const mailingAddressHashKey = (a: MailingAddress): string => {
  return [
    a.address1,
    a.address2 ?? '',
    a.city,
    a.state,
    a.zip,
    a.country,
  ].join('\x1f');
};

/** D-129 P3 — project a raw HubSpot contact into the canonical
 *  `EnrichmentMeta` snapshot. `snapshot_hash` + `snapshot_at` are the
 *  two stamping fields the cascade engine reads; the rest are the
 *  6 canonical fields declared on the `hubspot.contact` entity. */
export const projectContactMeta = (
  raw: RawHubSpotRecord,
  snapshotHash: string,
  snapshotAt: number,
): EnrichmentMeta => {
  const meta: EnrichmentMeta = {
    snapshot_at: snapshotAt,
    snapshot_hash: snapshotHash,
  };

  const email = canonicalizeEmail(raw.properties.email);
  if (email !== null) meta.email = email;

  const name = constructContactName(raw, email);
  if (name !== null) meta.name = name;

  const lifecycleStage = raw.properties.lifecyclestage;
  if (typeof lifecycleStage === 'string' && lifecycleStage.length > 0) {
    meta.lifecycle_stage = lifecycleStage;
  }

  const owner = raw.properties.hubspot_owner_id;
  if (typeof owner === 'string' && owner.length > 0) {
    meta.owner = `hubspot_owner_id:${owner}`;
  }

  const accountId = raw.properties.associatedcompanyid;
  if (typeof accountId === 'string' && accountId.length > 0) {
    meta.account_id = accountId;
  }

  const recentActivity = parseUnixMs(raw.properties.notes_last_contacted);
  if (recentActivity !== null) meta.recent_activity_at = recentActivity;

  // D-138 P1 — predicate-match identity fields. Phone canonicalizes
  // through the shared E.164 helper (US default since HubSpot sits
  // primarily on US-based portals; the resolver chain in the
  // `data.contact` upsert path accepts a per-record override but the
  // reconciler-side projection takes the simpler default). Address
  // canonicalizes through the structured shape; partial addresses
  // (missing required fields) drop out rather than persist a partial
  // object.
  const phone = canonicalizePhone(raw.properties.phone, 'US');
  if (phone) meta.phone = phone;

  const mailing = projectHubSpotMailingAddress(raw);
  if (mailing) meta.mailing_address = mailing;

  const company = nullIfEmpty(raw.properties.company);
  if (company !== null) meta.company = company;

  return meta;
};

/** Project HubSpot's flat `address` / `city` / `state` / `zip` /
 *  `country` properties into a structured `MailingAddress`. Returns
 *  null when any required field is absent — partial addresses don't
 *  persist (per D-138 spec § Contract Tightening). */
const projectHubSpotMailingAddress = (raw: RawHubSpotRecord): MailingAddress | null => {
  const props = raw.properties;
  const input: Parameters<typeof canonicalizeMailingAddress>[0] = {};
  if (props.address) input.address1 = props.address;
  if (props.address2) input.address2 = props.address2;
  if (props.city) input.city = props.city;
  if (props.state) input.state = props.state;
  if (props.zip) input.zip = props.zip;
  if (props.country) input.country = props.country;
  return canonicalizeMailingAddress(input);
};

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

/** Canonicalize HubSpot's `email` property to lowercase + trimmed.
 *  Empty / null / whitespace-only inputs return `null` so callers can
 *  distinguish "no email" from "empty email" without re-checking the
 *  raw value. */
export const canonicalizeEmail = (
  raw: string | null | undefined,
): string | null => {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
};

/** Reconstitute `meta.name` from `firstname` + `lastname` with email-
 *  local-part fallback. Returns null only when every source is absent
 *  (no first / last name AND no email). HubSpot returns `null` for
 *  unset properties; empty strings are treated identically. */
const constructContactName = (
  raw: RawHubSpotRecord,
  canonicalEmail: string | null,
): string | null => {
  const firstName = nullIfEmpty(raw.properties.firstname);
  const lastName = nullIfEmpty(raw.properties.lastname);
  if (firstName !== null && lastName !== null) {
    return `${firstName} ${lastName}`;
  }
  if (firstName !== null) return firstName;
  if (lastName !== null) return lastName;
  if (canonicalEmail !== null) {
    const at = canonicalEmail.indexOf('@');
    return at > 0 ? canonicalEmail.slice(0, at) : canonicalEmail;
  }
  return null;
};

const nullIfEmpty = (raw: string | null | undefined): string | null => {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const parseUnixMs = (raw: string | null | undefined): number | null => {
  if (raw === null || raw === undefined || raw === '') return null;
  // HubSpot emits ms epoch as a numeric string for native date fields
  // (`hs_lastmodifieddate`, `notes_last_contacted`); ISO strings appear
  // on `createdAt` / `updatedAt` envelope fields. Try numeric first,
  // then fall through to ISO parsing.
  const asInt = Number(raw);
  if (Number.isFinite(asInt) && asInt > 0) return Math.trunc(asInt);
  const asDate = Date.parse(raw);
  return Number.isFinite(asDate) ? asDate : null;
};
