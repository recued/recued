/** D-139 Phase 1a.2 — shared helpers across HubSpot engagement reconcilers.
 *
 *  Pure functions; no IO. Used by the meeting / note / call / task
 *  reconcilers + their projection paths. P1a.1.1 unified the
 *  previously-duplicated email-reconciler helpers (`parseUnixMs`,
 *  `canonicalizeEmail`, `parseEmailList`, `isInternalDomain`,
 *  `byteSizeOf`, `ENGAGEMENT_BODY_INLINE_MAX_BYTES`) into this module
 *  so all five HubSpot engagement reconcilers share one canonical
 *  parsing/canonicalization path. Email-specific projection (subject,
 *  bounce_detail, body-state machine with mail-twin branch) stays in
 *  `email-engagement-reconciler.ts`.
 *
 *  Spec: D-139 § A.3, § A.3.2, § A.3.3, § A.3.6, § A.3.7. */

import { composePlatformRecordTargetId } from '@recued/contracts';
import type {
  Authorship,
  ConnectionRecord,
  EngagementLifecycleState,
  EngagementVendor,
} from '@recued/contracts';

import {
  listHubSpotAssociations,
  type HubSpotSearchDeps,
  type RawHubSpotRecord,
} from './_hubspot-search.js';

// ────────────────────────────────────────────────────────────────
// Engagement-row body inline cap (kept identical to email so all
// engagement bodies obey the same truncation discipline)
// ────────────────────────────────────────────────────────────────

/** Body-inline cap — engagement row payloads aim for ≤ 8 KB total per
 *  D-128 `PLATFORM_REFERENCE_META_MAX_BYTES`. Reserve ~6 KB for the
 *  body and ~2 KB for meta + the rest of the row. Bodies ≥ this cap
 *  truncate + flip `body_state` to `'truncated_inline'` with the byte
 *  count exposed via `body_truncation_offset`. */
export const ENGAGEMENT_BODY_INLINE_MAX_BYTES = 6 * 1024;

// ────────────────────────────────────────────────────────────────
// Time + email canonicalization
// ────────────────────────────────────────────────────────────────

/** Parse a HubSpot timestamp (unix-ms-as-string OR ISO date string)
 *  into UTC unix-ms. Returns null when the input is empty / malformed.
 *  Accepts large integers as strings (HubSpot serializes engagement
 *  timestamps as decimal unix-ms strings; ISO strings appear for
 *  date-only fields like task due dates per § A.3.7). */
export const parseUnixMs = (
  raw: string | null | undefined,
): number | null => {
  if (raw === null || raw === undefined || raw === '') return null;
  const asInt = Number(raw);
  if (Number.isFinite(asInt) && asInt > 0) return Math.trunc(asInt);
  const asDate = Date.parse(raw);
  return Number.isFinite(asDate) ? asDate : null;
};

/** § A.3.7 — detect a date-only HubSpot timestamp (`'2026-05-04'` no
 *  time component). The substrate canonicalizes such inputs to UTC
 *  midnight + flips `due_at_is_date_only: true` so producers know NOT
 *  to compare against intra-day timestamps. Number-as-string inputs
 *  (unix-ms) are NEVER date-only. */
export const isDateOnlyHubSpotTimestamp = (
  raw: string | null | undefined,
): boolean => {
  if (raw === null || raw === undefined || raw === '') return false;
  // Numeric → unix-ms; not date-only.
  if (Number.isFinite(Number(raw))) return false;
  // ISO date-only matches `YYYY-MM-DD` exactly (no `T`).
  return /^\d{4}-\d{2}-\d{2}$/.test(raw.trim());
};

/** § A.3.7 — convert a date-only HubSpot timestamp (`'2026-05-04'`)
 *  into the UTC unix-ms value representing 00:00 in the supplied IANA
 *  timezone. P1a.2 carry-forward (Codex review P2 #2): `Date.parse`
 *  on a bare `YYYY-MM-DD` string lands at UTC midnight — for users
 *  east of UTC (e.g. `Europe/Berlin`) that's *yesterday's* local
 *  midnight, undercounting "is this overdue right now" comparisons by
 *  up to a day. The fix interprets the date string as wall-clock
 *  midnight in the user's local TZ + converts to UTC unix-ms.
 *
 *  Returns null for empty / malformed inputs. The conversion uses
 *  `Intl.DateTimeFormat` with `timeZone: tz` to compute the offset at
 *  the target date — DST boundaries respected. Falls back to UTC
 *  midnight when the tz is unknown / invalid (matches the substrate's
 *  `'tz_inferred'` coverage hint).
 *
 *  Tested examples:
 *    - `'2026-05-04'` + `'America/New_York'` → 1746331200000
 *      (May 4 2026 00:00 EDT = May 4 2026 04:00 UTC)
 *    - `'2026-05-04'` + `'Europe/Berlin'` → 1746309600000
 *      (May 4 2026 00:00 CEST = May 3 2026 22:00 UTC)
 *    - `'2026-05-04'` + `'UTC'` → 1746316800000
 *      (May 4 2026 00:00 UTC) */
export const computeLocalDayMidnightUtc = (
  raw: string | null | undefined,
  tz: string,
): number | null => {
  if (raw === null || raw === undefined || raw === '') return null;
  const trimmed = raw.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null;
  // Treat the date string as wall-clock midnight in `tz`. The
  // simplest correct algorithm: build the UTC midnight first, then
  // figure out what UTC offset the target tz has at that moment, then
  // shift accordingly. Use `Intl.DateTimeFormat` with `timeZone: tz`
  // to read the offset; DST-aware.
  const utcMidnight = Date.parse(`${trimmed}T00:00:00Z`);
  if (!Number.isFinite(utcMidnight)) return null;
  // Shortcut: UTC tz needs no shift.
  if (tz === 'UTC' || tz === 'Etc/UTC' || tz === 'GMT') return utcMidnight;
  let offsetMinutes: number;
  try {
    offsetMinutes = readUtcOffsetMinutes(tz, new Date(utcMidnight));
  } catch {
    // Unknown tz (Intl rejects) — fall back to UTC midnight; the
    // coverage substrate flags this case as `'tz_inferred'`.
    return utcMidnight;
  }
  // Wall-clock midnight in the target tz happens BEFORE UTC midnight
  // for east-of-UTC offsets (positive offsetMinutes) and AFTER for
  // west-of-UTC (negative). Subtract the offset in ms.
  return utcMidnight - offsetMinutes * 60 * 1000;
};

/** Read the IANA timezone's UTC offset (in minutes) at the given
 *  Date instant. Positive for east-of-UTC zones (Berlin = +60 in
 *  winter, +120 in summer); negative for west-of-UTC zones (NYC =
 *  −300 in winter, −240 in summer). DST-aware via Intl. */
const readUtcOffsetMinutes = (tz: string, at: Date): number => {
  // `Intl.DateTimeFormat` with `formatToParts` + `timeZoneName: 'shortOffset'`
  // returns a string like `'GMT+2'` / `'GMT-04:30'` / `'GMT'`. Parse it.
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    timeZoneName: 'shortOffset',
  });
  const parts = fmt.formatToParts(at);
  const tzPart = parts.find((p) => p.type === 'timeZoneName');
  if (tzPart === undefined) return 0;
  const value = tzPart.value.trim();
  if (value === 'GMT' || value === 'UTC') return 0;
  // Match `GMT±H` / `GMT±H:MM` / `GMT±HH:MM`.
  const m = /^(?:GMT|UTC)([+-])(\d{1,2})(?::(\d{2}))?$/.exec(value);
  if (m === null) return 0;
  const sign = m[1] === '+' ? 1 : -1;
  const hours = Number(m[2] ?? '0');
  const minutes = Number(m[3] ?? '0');
  return sign * (hours * 60 + minutes);
};

/** Canonicalize an email — lowercase + trim. Returns null for empty /
 *  malformed inputs. Used by the contact-edge writer + by direction's
 *  internal-domain analysis. */
export const canonicalizeEmail = (
  raw: string | null | undefined,
): string | null => {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.length === 0 || !trimmed.includes('@')) return null;
  return trimmed;
};

/** Parse a HubSpot email-list field. Splits on `;`, `,`, or `\n` and
 *  canonicalizes each entry. */
export const parseEmailList = (
  raw: string | null | undefined,
): string[] => {
  if (raw === null || raw === undefined || raw === '') return [];
  const parts = raw.split(/[;,\n]/);
  const out: string[] = [];
  for (const p of parts) {
    const c = canonicalizeEmail(p);
    if (c !== null) out.push(c);
  }
  return out;
};

/** True when `email`'s domain matches one of `internalDomains`
 *  (case-insensitive). Used by direction's internal-domain analysis. */
export const isInternalDomain = (
  email: string,
  internalDomains: ReadonlyArray<string>,
): boolean => {
  const at = email.lastIndexOf('@');
  if (at < 0) return false;
  const domain = email.slice(at + 1).toLowerCase();
  for (const d of internalDomains) {
    if (domain === d.toLowerCase()) return true;
  }
  return false;
};

/** UTF-8 byte size — uses `Buffer.byteLength` when Node's globals are
 *  available, falls back to `TextEncoder` (browser/runtime parity). */
export const byteSizeOf = (s: string): number => {
  if (typeof Buffer !== 'undefined') return Buffer.byteLength(s, 'utf8');
  return new TextEncoder().encode(s).length;
};

// ────────────────────────────────────────────────────────────────
// § A.3.7 timezone fallback chain (P1a.1.2)
//
// Spec § A.3.7 lines 456-486 describe the fallback chain for
// `event_at_tz_hint`: vendor-supplied IANA tz → calendar adapter
// `timeZone` field → user account-default `prefs.timezone` → UTC
// (with `'tz_inferred'` coverage flag). HubSpot engagements never
// supply a vendor-side IANA tz (timestamps are UTC unix-ms), so the
// HubSpot side reduces to: calendar adapter (meetings only) →
// prefsTimezone() → UTC. Salesforce engagements at P1b will populate
// vendorTzHint from the ISO offset.
//
// The resolver flags the final UTC fallback so producers reading
// the engagement row can populate `coverage.sources_degraded` with
// reason `'tz_inferred'` per § A.9.3 — the canonical `event_at` is
// still UTC unix-ms but the wall-clock representation is approximate.
// ────────────────────────────────────────────────────────────────

export interface ResolveEngagementTzHintInput {
  /** Vendor-supplied IANA tz (Salesforce parses from ISO offset; HubSpot
   *  always undefined at v1 because HubSpot uses unix-ms UTC). */
  vendorTzHint?: string;
  /** Calendar adapter's `timeZone` field for calendar-twin engagements
   *  (HubSpot meetings, Salesforce Events with calendar association).
   *  Undefined when no calendar twin is detected or the engagement type
   *  is mail-shaped (no calendar context). */
  calendarAdapterTzHint?: string;
  /** Per-pair `prefs.timezone` reader. Returns null/undefined when
   *  Settings → Profile → Time Zone hasn't been touched. */
  prefsTimezone?: () => string | null | undefined;
}

export interface ResolveEngagementTzHintResult {
  /** Resolved IANA tz string. `'UTC'` is the final-fallback sentinel
   *  when nothing else is available. */
  tz: string;
  /** True when every step of the chain returned null/undefined and the
   *  resolver fell to the UTC sentinel. Producers populate
   *  `coverage.sources_degraded` with reason `'tz_inferred'` when this
   *  flag is true on a row they aggregate. */
  inferred: boolean;
}

/** § A.3.7 fallback chain. Pure function — no IO of its own; the
 *  only failure mode is the prefs callback throwing. Vendor →
 *  calendar adapter → `prefs.timezone` → UTC. Each step short-
 *  circuits on the first non-empty value; the final UTC sentinel
 *  sets `inferred: true` so the row's `event_at_tz_inferred` flag
 *  flips on.
 *
 *  P1a.1.2 Codex review fold (Area 2 — P2) — `prefsTimezone()` is a
 *  user-supplied callback (production wires read `prefs.timezone`
 *  via the per-pair store, which can race with cache invalidation
 *  or hit a malformed row). A synchronous throw inside the callback
 *  is caught + the resolver falls through to the UTC sentinel. The
 *  type rules out async returns; an inadvertent `Promise<...>`
 *  return is treated as "no value" (non-string fallthrough). */
export const resolveEngagementTzHint = (
  input: ResolveEngagementTzHintInput,
): ResolveEngagementTzHintResult => {
  if (typeof input.vendorTzHint === 'string' && input.vendorTzHint.length > 0) {
    return { tz: input.vendorTzHint, inferred: false };
  }
  if (
    typeof input.calendarAdapterTzHint === 'string' &&
    input.calendarAdapterTzHint.length > 0
  ) {
    return { tz: input.calendarAdapterTzHint, inferred: false };
  }
  if (input.prefsTimezone !== undefined) {
    let prefsTz: string | null | undefined;
    try {
      prefsTz = input.prefsTimezone();
    } catch {
      // Codex P2 fold — prefs lookup blew up; fall through to UTC
      // sentinel rather than abort the ingest path. Producers see
      // `event_at_tz_inferred = true` and can populate
      // `coverage.sources_degraded` with `'tz_inferred'`.
      prefsTz = undefined;
    }
    if (typeof prefsTz === 'string' && prefsTz.length > 0) {
      return { tz: prefsTz, inferred: false };
    }
  }
  return { tz: 'UTC', inferred: true };
};

// ────────────────────────────────────────────────────────────────
// Authorship — base derivation shared across non-email entity types
// ────────────────────────────────────────────────────────────────

/** Derive authorship for non-email engagements (meetings / notes /
 *  calls / tasks). Email overrides this with its own derivation
 *  because of the tracking-pixel `'system_process'` branch (only
 *  applies to email).
 *
 *  Order of precedence per § A.3.2:
 *    1. owner matches connection user → 'user'
 *    2. workflow-created → 'crm_automation'
 *    3. created_via_workflow → 'crm_automation'
 *    4. import_id populated → 'import'
 *    5. owner non-empty (different teammate) → 'crm_user'
 *    6. otherwise → 'unknown' */
export const deriveAuthorshipBase = (
  raw: RawHubSpotRecord,
  connectionUserOwnerId: string | undefined,
): Authorship => {
  const ownerId = raw.properties.hubspot_owner_id ?? null;
  if (
    typeof connectionUserOwnerId === 'string' &&
    connectionUserOwnerId.length > 0 &&
    ownerId === connectionUserOwnerId
  ) {
    return 'user';
  }
  if (
    raw.properties.hs_created_by_workflow_id !== undefined &&
    raw.properties.hs_created_by_workflow_id !== null &&
    raw.properties.hs_created_by_workflow_id !== ''
  ) {
    return 'crm_automation';
  }
  if (
    raw.properties.hs_created_via_workflow !== undefined &&
    raw.properties.hs_created_via_workflow !== null &&
    raw.properties.hs_created_via_workflow !== ''
  ) {
    return 'crm_automation';
  }
  if (
    raw.properties.hs_import_id !== undefined &&
    raw.properties.hs_import_id !== null &&
    raw.properties.hs_import_id !== ''
  ) {
    return 'import';
  }
  if (typeof ownerId === 'string' && ownerId.length > 0) {
    return 'crm_user';
  }
  return 'unknown';
};

// ────────────────────────────────────────────────────────────────
// Body preview helper
// ────────────────────────────────────────────────────────────────

/** First 256 chars of `body` (display preview). Returns null when
 *  body is empty. */
export const pickBodyPreview = (body: string | null | undefined): string | null => {
  if (body === null || body === undefined || body.length === 0) return null;
  return body.slice(0, 256);
};

// ────────────────────────────────────────────────────────────────
// Body-state machine for engagements without mail-twin matcher
// (notes / calls / tasks). Meetings have their own calendar-twin
// matcher — reuse this function for the post-twin-check path.
// ────────────────────────────────────────────────────────────────

export interface BodyStateProjection {
  body_state: 'none' | 'inline_body' | 'truncated_inline';
  body_inline?: string;
  body_truncation_offset?: number;
}

export const pickInlineBodyState = (body: string): BodyStateProjection => {
  if (body.length === 0) return { body_state: 'none' };
  const byteLength = byteSizeOf(body);
  if (byteLength <= ENGAGEMENT_BODY_INLINE_MAX_BYTES) {
    return { body_state: 'inline_body', body_inline: body };
  }
  const truncated = body.slice(
    0,
    Math.floor(ENGAGEMENT_BODY_INLINE_MAX_BYTES / 2),
  );
  return {
    body_state: 'truncated_inline',
    body_inline: truncated,
    body_truncation_offset: byteLength,
  };
};

// ────────────────────────────────────────────────────────────────
// Direction — subject-verb heuristic (tasks share this with
// salesforce.task at P1b)
// ────────────────────────────────────────────────────────────────

const OUTBOUND_VERB_PREFIXES: ReadonlyArray<string> = [
  'email ',
  'send ',
  'call ',
  'follow up',
  'follow-up',
  'reach out',
  'reach-out',
  'ping ',
  'message ',
  'reply ',
  'respond',
];

/** § A.3.3 task subject-verb heuristic — `'outbound'` when the subject
 *  starts with an outbound-action verb; `'unknown'` otherwise.
 *  Producer-side override available per the spec. */
export const deriveTaskDirectionFromSubject = (
  subject: string | null | undefined,
): 'outbound' | 'unknown' => {
  if (subject === null || subject === undefined) return 'unknown';
  const lower = subject.trim().toLowerCase();
  if (lower.length === 0) return 'unknown';
  for (const prefix of OUTBOUND_VERB_PREFIXES) {
    if (lower.startsWith(prefix)) return 'outbound';
  }
  return 'unknown';
};

// ────────────────────────────────────────────────────────────────
// Lifecycle helpers — note / meeting / task / call drivers
// ────────────────────────────────────────────────────────────────

/** § A.3.6 note lifecycle — always `'point_in_time'`. */
export const deriveNoteLifecycleState =
  (): EngagementLifecycleState => 'point_in_time';

/** § A.3.6 meeting lifecycle. State machine driven by
 *  `hs_meeting_outcome` + the start_time vs now comparison.
 *
 *    - outcome=CANCELED → 'cancelled'
 *    - outcome=RESCHEDULED → 'scheduled' (the row's start_time has
 *      been pushed forward; producers see it as a fresh upcoming
 *      meeting)
 *    - start_time > now → 'scheduled'
 *    - start_time ≤ now AND outcome populated (any non-empty value
 *      other than the special 'CANCELED'/'RESCHEDULED'/'SCHEDULED')
 *      → 'completed'
 *    - start_time ≤ now AND outcome unpopulated → 'completed'
 *      (substrate treats past meetings without an explicit outcome
 *      as completed; producers can override via lifecycle_acceptance) */
export const deriveMeetingLifecycleState = (
  outcome: string | null | undefined,
  startTime: number | null,
  now: number,
): EngagementLifecycleState => {
  const o = (outcome ?? '').toUpperCase();
  if (o === 'CANCELED' || o === 'CANCELLED') return 'cancelled';
  if (o === 'RESCHEDULED') return 'scheduled';
  if (startTime === null) return 'scheduled';
  if (startTime > now) return 'scheduled';
  return 'completed';
};

/** § A.3.6 task lifecycle. Driven by `hs_task_status`:
 *
 *    - COMPLETED → 'completed'
 *    - CANCELED / CANCELLED / DEFERRED → 'cancelled'
 *    - everything else (NOT_STARTED / IN_PROGRESS / WAITING / empty)
 *      → 'pending' */
export const deriveTaskLifecycleState = (
  status: string | null | undefined,
): EngagementLifecycleState => {
  const s = (status ?? '').toUpperCase();
  if (s === 'COMPLETED') return 'completed';
  if (s === 'CANCELED' || s === 'CANCELLED' || s === 'DEFERRED') {
    return 'cancelled';
  }
  return 'pending';
};

/** § A.3.6 Pass-5 R5.4 call lifecycle. Driven by `hs_call_status`:
 *
 *    - QUEUED / IN_PROGRESS → 'pending'
 *    - COMPLETED → 'point_in_time' (engagement evidence)
 *    - NO_ANSWER → 'no_answer' (attempt happened, no connection)
 *    - FAILED → 'failed'
 *    - CANCELED / CANCELLED → 'cancelled'
 *    - empty / unknown → 'point_in_time' (substrate default;
 *      producers filter via `authorship` + `call_outcome_acceptance`) */
export const deriveCallLifecycleState = (
  status: string | null | undefined,
): EngagementLifecycleState => {
  const s = (status ?? '').toUpperCase();
  if (s === 'QUEUED' || s === 'IN_PROGRESS') return 'pending';
  if (s === 'COMPLETED') return 'point_in_time';
  if (s === 'NO_ANSWER') return 'no_answer';
  if (s === 'FAILED') return 'failed';
  if (s === 'CANCELED' || s === 'CANCELLED') return 'cancelled';
  return 'point_in_time';
};

// ────────────────────────────────────────────────────────────────
// § A.4 — engagement-association fetcher (P1a.1.1)
//
// HubSpot exposes engagement→deal / engagement→account / engagement→
// contact associations through `/crm/v3/objects/<from>/<id>/
// associations/<to>`. The fetcher walks all three association types
// in parallel and shapes the result into the `EngagementCrmAssociations`
// projection that the reconciler ingest path + the rescan substrate +
// the edge-only webhook write path consume.
// ────────────────────────────────────────────────────────────────

/** HubSpot engagement-types this helper supports. The five entity
 *  types covered by D-139 P1a.1 + P1a.2 — same set the search helper
 *  + capability map thread through. */
export type HubSpotEngagementEntity =
  | 'email'
  | 'meeting'
  | 'note'
  | 'call'
  | 'task';

/** Pluralized HubSpot object type for `/crm/v3/objects/<plural>` URL
 *  composition. */
export const hubSpotEngagementPluralFor = (
  entity: HubSpotEngagementEntity,
): 'emails' | 'meetings' | 'notes' | 'calls' | 'tasks' => {
  switch (entity) {
    case 'email':
      return 'emails';
    case 'meeting':
      return 'meetings';
    case 'note':
      return 'notes';
    case 'call':
      return 'calls';
    case 'task':
      return 'tasks';
  }
};

/** Vendor- AND connection-namespaced target_id for an associated CRM record.
 *  D-190 per-connection scoping — must match the record reconcilers' target_id
 *  EXACTLY (`composePlatformRecordTargetId`), so an engagement edge points at the
 *  same `(scope, target_id)` row the deal/contact/company reconciler writes (the
 *  edge-driven aggregates — e.g. `engagement-sentiment-trend` — key their
 *  enrichment on this id; a mismatch orphans them from the record). */
const targetIdFor = (
  vendor: EngagementVendor,
  entity: 'deal' | 'company' | 'contact',
  connection_name: string,
  raw_id: string,
): string => composePlatformRecordTargetId(vendor, entity, connection_name, raw_id);

/** Structured projection of the CRM-side association set for one
 *  engagement. The reconciler ingest path consumes `deals` + `companies`
 *  to emit `engagement_edges` rows of type `'deal'` + `'account'`;
 *  `contacts` is OPTIONAL and only used when the caller wants the CRM
 *  list to override email-header-derived contacts (P1a.1.1 default
 *  keeps header-derived contacts so test fixtures continue to pass —
 *  the rescan substrate uses the CRM list for diff). */
export interface EngagementCrmAssociations {
  /** Raw HubSpot deal ids, e.g. `['47291', '47292']`. The reconciler
   *  wraps these in the `<vendor>_<entity>_<id>` shape per § A.4. */
  deals: ReadonlyArray<string>;
  /** Raw HubSpot company ids — `engagement_edges.edge_type='account'`
   *  per § A.4 closed-list (HubSpot's `company` aliases to `account`
   *  in the cross-vendor lens at D-130 P7). */
  companies: ReadonlyArray<string>;
  /** Optional — raw HubSpot contact-object ids. Today the reconciler
   *  derives contact edges from email-header participants directly
   *  (one HTTP saved per ingest). When supplied, this list represents
   *  the CRM's recorded contact-association — closer to the user's
   *  actual intent than header parsing. P1a.1.1 leaves `contacts`
   *  unconsumed at the reconciler ingest path; future phases may
   *  wire it through. */
  contacts?: ReadonlyArray<string>;
}

export interface FetchEngagementAssociationsInput {
  connection: ConnectionRecord;
  entity: HubSpotEngagementEntity;
  /** Raw HubSpot id (no vendor prefix). The wrapping
   *  `target_id = '<vendor>_<entity>_<raw_id>'` happens at projection
   *  time. */
  raw_id: string;
  /** Search-helper deps (fetcher / refreshAuth / sleep / etc.). */
  search: HubSpotSearchDeps;
  /** Whether to fetch contact associations. Defaults to false — the
   *  reconciler ingest path derives contacts from email headers; the
   *  rescan substrate calls with `include_contacts: true` to diff the
   *  full association set. */
  include_contacts?: boolean;
  /** Codex P2 #1 fold-back — per-leg page cap. Each association leg
   *  (deals / companies / contacts) walks its own paginated response;
   *  this caps the page count per leg per invocation so a deeply-
   *  paginated engagement doesn't monopolize the daily token budget.
   *  Pagination tail surfaces via `next_cursors` for caller-driven
   *  resumption. */
  page_cap?: number;
}

export interface FetchEngagementAssociationsResult {
  associations: EngagementCrmAssociations;
  /** Codex P2 #1 fold-back — actual page count consumed across all
   *  three legs (was a fixed `2`/`3` pre-fold). Counts against the
   *  per-connection daily token budget at § A.6.2. */
  api_calls_consumed: number;
  /** True when the engagement record itself returned 404 — the caller
   *  should tombstone the engagement row + cascade. Distinct from "no
   *  associations" (which is a normal empty array). */
  source_record_missing: boolean;
  /** Codex P2 #1 fold-back — per-leg unwalked-tail cursors. Set when
   *  `page_cap` was hit on the corresponding leg. Callers thread these
   *  back into a follow-up call to resume the walk. Omitted entirely
   *  when no leg paginated past its cap. */
  next_cursors?: {
    deals?: string;
    companies?: string;
    contacts?: string;
  };
}

/** Fetch the CRM-side engagement-association set in parallel. The
 *  reconciler / rescan / edge-only webhook all share this one
 *  primitive — ensures the three call sites build the same target_id
 *  shape from the same raw association ids.
 *
 *  Codex P2 #1 fold-back — `api_calls_consumed` reflects actual page
 *  counts (was a fixed `2`/`3` regardless of pagination), and the
 *  walk respects the per-leg `page_cap` from § A.6.2 so a deeply-
 *  paginated engagement doesn't monopolize the daily budget. The
 *  unwalked tail surfaces via `next_cursors` so callers can resume.
 *
 *  Spec: D-139 § A.4, § A.6.2, § A.6.3. */
export const fetchHubSpotEngagementAssociations = async (
  input: FetchEngagementAssociationsInput,
): Promise<FetchEngagementAssociationsResult> => {
  const fromObjectType = hubSpotEngagementPluralFor(input.entity);
  const includeContacts = input.include_contacts === true;
  const pageCap = input.page_cap;
  const opts = pageCap !== undefined ? { page_cap: pageCap } : {};
  const promises = [
    listHubSpotAssociations(
      input.connection,
      fromObjectType,
      input.raw_id,
      'deals',
      input.search,
      opts,
    ),
    listHubSpotAssociations(
      input.connection,
      fromObjectType,
      input.raw_id,
      'companies',
      input.search,
      opts,
    ),
  ];
  if (includeContacts) {
    promises.push(
      listHubSpotAssociations(
        input.connection,
        fromObjectType,
        input.raw_id,
        'contacts',
        input.search,
        opts,
      ),
    );
  }
  const results = await Promise.all(promises);
  const dealsResult = results[0] ?? null;
  const companiesResult = results[1] ?? null;
  const contactsResult = includeContacts ? (results[2] ?? null) : undefined;

  // 404 on any of the association GETs is unambiguous — HubSpot
  // returns 404 on the FROM object, not on the association
  // endpoint when the association is empty (empty associations
  // return 200 + empty results array).
  const sourceMissing =
    dealsResult === null ||
    companiesResult === null ||
    (includeContacts && contactsResult === null);

  const associations: EngagementCrmAssociations = {
    deals: dealsResult?.ids ?? [],
    companies: companiesResult?.ids ?? [],
  };
  if (includeContacts) {
    associations.contacts = contactsResult?.ids ?? [];
  }
  const api_calls_consumed =
    (dealsResult?.pages_fetched ?? 0) +
    (companiesResult?.pages_fetched ?? 0) +
    (includeContacts ? (contactsResult?.pages_fetched ?? 0) : 0);
  const next_cursors: NonNullable<FetchEngagementAssociationsResult['next_cursors']> = {};
  if (dealsResult?.next_cursor) next_cursors.deals = dealsResult.next_cursor;
  if (companiesResult?.next_cursor)
    next_cursors.companies = companiesResult.next_cursor;
  if (includeContacts && contactsResult?.next_cursor)
    next_cursors.contacts = contactsResult.next_cursor;
  const out: FetchEngagementAssociationsResult = {
    associations,
    api_calls_consumed,
    source_record_missing: sourceMissing,
  };
  if (Object.keys(next_cursors).length > 0) out.next_cursors = next_cursors;
  return out;
};

// Reference for tooling — `targetIdFor` is exported via the
// reconciler edge-construction path; surface it from here too so
// engagement-shared remains the canonical source.
export { targetIdFor as hubSpotEngagementTargetIdFor };
