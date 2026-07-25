/** D-130 Phase 3 — Salesforce contact reconciler.
 *
 *  Implements `VendorReconciler` for `(salesforce, contact)`. Mirrors
 *  the opportunity reconciler's shape; the differences are:
 *
 *    - `email` is the canonical join key. `meta.email` is canonicalized
 *      (lowercase + trim) at projection time. The cross-source
 *      `engagement_score_per_contact` topic at P6 uses this field to
 *      join against Recued local `data.contact.<email>` for mail /
 *      calendar activity counts (D-117 already lower-cases its
 *      `data.contact.*` keys, so a non-canonicalized email here would
 *      silently miss every record with capitalised characters).
 *      Canonicalization is contract-level, not reconciler convenience —
 *      the test suite pins `'Bob@Example.COM' → 'bob@example.com'`.
 *    - `meta.name` reconstitutes from `FirstName + ' ' + LastName`,
 *      falling back to the email local-part when both are absent.
 *      Empty strings + null are treated identically (Salesforce returns
 *      `null` for unset properties).
 *    - Hash tuple is `email / lifecycle_stage / owner / account_id`.
 *      `LastActivityDate` is intentionally excluded — Salesforce bumps
 *      it on any logged activity (call / meeting / email open) including
 *      ones that don't change anything semantically interesting about
 *      the contact. Including it would force a meta refresh + cascade
 *      event on every touch; the cascade should fire only when contact
 *      identity changes.
 *    - `meta.lifecycle_stage` projects from `LeadSource`. Salesforce's
 *      contact lifecycle vocabulary (Web / Phone Inquiry / Partner
 *      Referral / etc.) diverges from HubSpot's
 *      subscriber/lead/mql/sql/customer ladder, which is why the
 *      `lifecycle_stage_inferred` topic ships as a parallel
 *      `_salesforce`-suffixed topic at P6 (per spec § 11) — the closed-
 *      list `value.stage` enum can't widen across vendors without
 *      breaking either side. The raw `LeadSource` lands here verbatim.
 *
 *  Spec: `docs/d-130-spec.md` § A.3, § Phase 3. */

import {
  canonicalizeMailingAddress,
  canonicalizePhone,
  PLATFORM_REFERENCE_BATCH_SIZE,
  SALESFORCE_CONTACT_FIELDS,
  SALESFORCE_DEFAULT_RECONCILIATION_CADENCE,
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
  searchSalesforceObjects,
  type RawSalesforceRecord,
  type SalesforceSearchDeps,
} from './_salesforce-search.js';

// ────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────

/** SlimRecord variant carrying the raw Salesforce contact payload. The
 *  harness reads only `id` + `modified_at`; `hashOf` + `toMeta` consume
 *  `_raw` to compute their outputs. */
export interface SalesforceContactSlimRecord extends SlimRecord {
  _raw: RawSalesforceRecord;
}

/** Construction-time deps. The boot wire injects the search helper
 *  deps; tests pass a deterministic `now()` and a fake fetcher. */
export interface SalesforceContactReconcilerDeps {
  search: SalesforceSearchDeps;
  /** Wall-clock used to stamp `meta.snapshot_at`. Defaults to
   *  `Date.now`. Tests pin this so snapshots round-trip exactly. */
  now?: () => number;
  /** D-130 P5 — optional CometD webhook processor (PushTopic stream
   *  events on the `/topic/RecuedContactFeed` channel). Wired in
   *  `bin.ts` once P5 lands. */
  webhookProcessor?: WebhookProcessor;
}

// ────────────────────────────────────────────────────────────────
// Reconciler
// ────────────────────────────────────────────────────────────────

/** D-130 P3 — `(salesforce, contact)` reconciler. One instance per
 *  server registered into the default `ReconcilerRegistry` at boot;
 *  per-connection task wiring lives in the `bin.ts` connection-upsert
 *  hook (shared with opportunity + account once P4 lands). */
export class SalesforceContactReconciler implements VendorReconciler {
  readonly vendor = 'salesforce' as const;
  readonly entity = 'contact' as const;
  readonly default_cadence: ReconciliationCadence = SALESFORCE_DEFAULT_RECONCILIATION_CADENCE;
  readonly webhookProcessor?: WebhookProcessor;

  private readonly deps: SalesforceContactReconcilerDeps;

  constructor(deps: SalesforceContactReconcilerDeps) {
    this.deps = deps;
    if (deps.webhookProcessor) this.webhookProcessor = deps.webhookProcessor;
  }

  async *listUpdatedSince(
    connection: ConnectionRecord,
    cursor: number,
    limit: number,
  ): AsyncIterable<SalesforceContactSlimRecord> {
    const pageLimit = Math.min(limit, PLATFORM_REFERENCE_BATCH_SIZE);
    const soql = buildContactSoql(cursor, pageLimit);
    for await (const raw of searchSalesforceObjects(
      connection,
      { soql },
      this.deps.search,
    )) {
      const modifiedAt = parseIsoMs(raw.LastModifiedDate);
      if (modifiedAt === null) continue;
      yield {
        id: composePlatformRecordTargetId(this.vendor, this.entity, connection.name, String(raw.Id)),
        modified_at: modifiedAt,
        _raw: raw,
      };
    }
  }

  hashOf(record: SalesforceContactSlimRecord): string {
    return computeContactHash(record._raw);
  }

  toMeta(record: SalesforceContactSlimRecord): EnrichmentMeta {
    return projectContactMeta(record._raw, computeContactHash(record._raw), this.now());
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }
}

// ────────────────────────────────────────────────────────────────
// SOQL composition (exported for direct unit testing)
// ────────────────────────────────────────────────────────────────

/** D-130 P3 — compose the SOQL string for a contact reconciliation
 *  page. First-run (`cursor === 0`) omits the `WHERE` clause to walk
 *  every record; subsequent runs filter by `LastModifiedDate >= <iso>`.
 *  The `ORDER BY LastModifiedDate ASC` sort matches the cursor-advance
 *  invariant — the harness records `max(modified_at)` seen so the next
 *  run picks up where this one left off. */
export const buildContactSoql = (cursor: number, limit: number): string => {
  const fields = SALESFORCE_CONTACT_FIELDS.join(', ');
  const baseClauses = [
    `SELECT ${fields}`,
    `FROM Contact`,
  ];
  if (cursor > 0) {
    baseClauses.push(`WHERE LastModifiedDate >= ${new Date(cursor).toISOString()}`);
  }
  baseClauses.push(`ORDER BY LastModifiedDate ASC`);
  baseClauses.push(`LIMIT ${limit}`);
  return baseClauses.join(' ');
};

// ────────────────────────────────────────────────────────────────
// Hash + meta projection (exported for direct unit testing)
// ────────────────────────────────────────────────────────────────

/** D-130 P3 — canonical-field hash for a Salesforce contact record.
 *  Tuple uses *projected* (canonicalized) email so two raw records that
 *  differ only in email casing still hash identically — symmetric with
 *  HubSpot's contact reconciler. `LeadSource` (lifecycle_stage) /
 *  `OwnerId` / `AccountId` participate; `LastActivityDate` does not —
 *  see file header for rationale.
 *
 *  D-138 P1 widens the tuple to include `Phone` (E.164-canonicalized)
 *  + `address_hash` (over canonicalized `MailingAddress`). Symmetric
 *  with the HubSpot widening. Salesforce has no flat company-string
 *  field on Contact (the workplace is reached via `Account.Name`
 *  through `AccountId` resolution), so the reconciler omits it from
 *  the hash; the company-name resolver lives at the `data.contact`
 *  layer for cross-vendor uniformity. */
export const computeContactHash = (raw: RawSalesforceRecord): string => {
  // D-138 P1 — match the projector's default country code so the
  // hash reacts to local-format phone changes. (`projectContactMeta`
  // calls `canonicalizePhone(_, 'US')`; the hash must agree.)
  const phone = canonicalizePhone(readString(raw.Phone), 'US') ?? '';
  const address = projectSalesforceMailingAddress(raw);
  const fields = [
    canonicalizeContactEmail(raw.Email) ?? '',
    stringify(raw.LeadSource),
    stringify(raw.OwnerId),
    stringify(raw.AccountId),
    phone,
    address ? mailingAddressHashKey(address) : '',
  ];
  return `fnv1a:${fnv1aHex(fields.join('\x1f'))}`;
};

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

/** D-130 P3 — project a raw Salesforce contact into the canonical
 *  `EnrichmentMeta` snapshot. `snapshot_hash` + `snapshot_at` are the
 *  two stamping fields the cascade engine reads; the rest are the
 *  6 canonical fields declared on the `salesforce.contact` entity. */
export const projectContactMeta = (
  raw: RawSalesforceRecord,
  snapshotHash: string,
  snapshotAt: number,
): EnrichmentMeta => {
  const meta: EnrichmentMeta = {
    snapshot_at: snapshotAt,
    snapshot_hash: snapshotHash,
  };

  const email = canonicalizeContactEmail(raw.Email);
  if (email !== null) meta.email = email;

  const name = constructContactName(raw, email);
  if (name !== null) meta.name = name;

  const lifecycleStage = readString(raw.LeadSource);
  if (lifecycleStage !== null) meta.lifecycle_stage = lifecycleStage;

  const owner = readString(raw.OwnerId);
  if (owner !== null) meta.owner = `salesforce_user:${owner}`;

  const accountId = readString(raw.AccountId);
  if (accountId !== null) meta.account_id = accountId;

  const recentActivity = parseIsoMs(raw.LastActivityDate);
  if (recentActivity !== null) meta.recent_activity_at = recentActivity;

  // D-138 P1 — predicate-match identity fields. Phone defaults to US
  // — Salesforce orgs span every locale but the reconciler-side
  // default is the safest seed; user-settings override applies at
  // the `data.contact` upsert path. Address canonicalizes through
  // the structured shape; partial addresses drop out.
  const phone = canonicalizePhone(readString(raw.Phone), 'US');
  if (phone) meta.phone = phone;

  const mailing = projectSalesforceMailingAddress(raw);
  if (mailing) meta.mailing_address = mailing;

  return meta;
};

/** Project Salesforce's `MailingStreet` / `MailingCity` /
 *  `MailingState` / `MailingPostalCode` / `MailingCountry` fields into
 *  a structured `MailingAddress`. Returns null when any required
 *  field is absent. */
const projectSalesforceMailingAddress = (raw: RawSalesforceRecord): MailingAddress | null => {
  const street = readString(raw.MailingStreet);
  // Salesforce returns Street as a single multi-line field — newlines
  // separate address1 / address2. Split on first newline.
  let address1: string | undefined;
  let address2: string | undefined;
  if (street) {
    const lines = street.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    address1 = lines[0];
    if (lines.length >= 2) address2 = lines.slice(1).join(' ');
  }
  const input: Parameters<typeof canonicalizeMailingAddress>[0] = {};
  if (address1) input.address1 = address1;
  if (address2) input.address2 = address2;
  const city = readString(raw.MailingCity);
  if (city) input.city = city;
  const state = readString(raw.MailingState);
  if (state) input.state = state;
  const postal = readString(raw.MailingPostalCode);
  if (postal) input.postal_code = postal;
  const country = readString(raw.MailingCountry);
  if (country) input.country = country;
  return canonicalizeMailingAddress(input);
};

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

/** Canonicalize Salesforce's `Email` field to lowercase + trimmed.
 *  Empty / null / whitespace-only inputs return `null` so callers can
 *  distinguish "no email" from "empty email" without re-checking the
 *  raw value. Mirrors the HubSpot contact reconciler's helper —
 *  Salesforce SOQL returns plain email strings (no `Bob <bob@x.com>`
 *  envelope shape that mail headers carry) so the simple lowercase +
 *  trim canonicalization is sufficient. */
export const canonicalizeContactEmail = (raw: unknown): string | null => {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
};

/** Reconstitute `meta.name` from `FirstName` + `LastName` with email-
 *  local-part fallback. Returns null only when every source is absent
 *  (no first / last name AND no email). Salesforce returns `null` for
 *  unset properties; empty strings are treated identically. */
const constructContactName = (
  raw: RawSalesforceRecord,
  canonicalEmail: string | null,
): string | null => {
  const firstName = nullIfEmpty(raw.FirstName);
  const lastName = nullIfEmpty(raw.LastName);
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

const readString = (raw: unknown): string | null => {
  if (typeof raw !== 'string') return null;
  if (raw.length === 0) return null;
  return raw;
};

const nullIfEmpty = (raw: unknown): string | null => {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
};

/** Stringify a SOQL-returned value into a hash-stable token. Booleans
 *  + numbers stringify natively; null / undefined collapse to empty
 *  string. Symmetric with the opportunity reconciler's helper. */
const stringify = (raw: unknown): string => {
  if (raw === null || raw === undefined) return '';
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? String(raw) : '';
  }
  if (typeof raw === 'boolean') return raw ? 'true' : 'false';
  return '';
};

/** Parse a Salesforce ISO-8601 timestamp (e.g. `2026-05-01T14:32:18.000Z`)
 *  into unix-ms. Returns null on missing / unparseable input. Salesforce
 *  emits dates as ISO strings throughout the SOQL response — both
 *  `LastModifiedDate` (datetime) and `LastActivityDate` (date — midnight
 *  UTC) parse correctly via `Date.parse`. */
const parseIsoMs = (raw: unknown): number | null => {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
};
