/** D-139 Phase 1b — shared helpers across Salesforce engagement reconcilers.
 *
 *  Pure functions; no IO. Mirrors the HubSpot `engagement-shared.ts`
 *  structure but with Salesforce-flavored derivation rules:
 *
 *    - `parseIsoMs` — Salesforce timestamps land as ISO 8601 strings
 *      with offsets. Returns unix-ms; preserves NULL on missing.
 *    - `extractIsoOffsetTzHint` — captures the original ISO offset
 *      (e.g. `'-04:00'`) for `event_at_tz_hint` per § A.3.7. Substrate
 *      passes `vendorTzHint` through `resolveEngagementTzHint` so the
 *      Salesforce-side fallback chain is: vendor offset → calendar
 *      adapter → prefs → UTC.
 *    - `canonicalizeEmail` / `parseEmailList` / `isInternalDomain`
 *      — same shape as HubSpot. Re-implemented here so the Salesforce
 *      data-layer doesn't import HubSpot helpers (substrate isolation).
 *    - `deriveSalesforceAuthorship` — `OwnerId` / `CreatedById` per
 *      § A.3.2. Automated Process User CreatedById marks
 *      `'crm_automation'`; matching connection-user OwnerId marks
 *      `'user'`; non-matching populated OwnerId marks `'crm_user'`.
 *    - `deriveTaskLifecycleState` — Status field drives state per
 *      § A.3.6 (Completed → 'completed', Cancelled/Deferred →
 *      'cancelled', else 'pending').
 *    - `deriveEventLifecycleState` — StartDateTime vs now drives
 *      state (future → 'scheduled', past → 'completed') per § A.3.6.
 *
 *  Spec: D-139 § A.3, § A.3.1, § A.3.2, § A.3.3,
 *  § A.3.6, § A.3.7. */

import {
  type Authorship,
  type EngagementLifecycleState,
} from '@recued/contracts';

// ────────────────────────────────────────────────────────────────
// Time + email canonicalization
// ────────────────────────────────────────────────────────────────

/** Parse a Salesforce ISO-8601 datetime / date string. Salesforce
 *  emits `LastModifiedDate`, `SystemModstamp`, `StartDateTime`,
 *  `MessageDate`, `CallStartDateTime`, etc. as ISO strings:
 *
 *    - Datetime fields: `'2026-05-01T14:32:18.000Z'` or
 *      `'2026-05-01T10:32:18.000-04:00'` (offset preserved on read).
 *    - Date-only fields: `'2026-05-01'` (substrate canonicalizes to
 *      midnight UTC; the offset isn't supplied, so `tz_inferred`).
 *
 *  Returns null on missing / unparseable input. */
export const parseIsoMs = (raw: unknown): number | null => {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
};

/** Extract a timezone hint from a Salesforce ISO-8601 datetime. UTC
 *  offsets (`'Z'` or `'+00:00'`) return `'UTC'`. Whole-hour offsets
 *  return the canonical `Etc/GMT±N` form (POSIX-flipped sign — east-
 *  of-UTC offsets land as `Etc/GMT-N`). Half-hour / quarter-hour
 *  offsets (`+05:30` India, `+09:30` Adelaide, `+05:45` Nepal) return
 *  the verbatim offset string (`'+05:30'`) since the
 *  `Etc/GMT±N` family only handles whole-hour offsets — preserving
 *  the offset is the most precise tz hint the substrate has at this
 *  layer.
 *
 *  D-139 P1b Codex review fold #9 — prior shape mapped `+05:30` to
 *  `Etc/GMT-5`, dropping the 30-minute component (off by 30 minutes
 *  for India, Iran, Newfoundland, etc.). Now: whole-hour offsets use
 *  `Etc/GMT±N`; non-whole-hour offsets surface raw. The resolver
 *  downstream still routes through `resolveEngagementTzHint` for
 *  calendar-adapter / prefs refinement.
 *
 *  Returns undefined when the input is not an ISO string with an
 *  explicit offset. */
export const extractIsoOffsetTzHint = (raw: unknown): string | undefined => {
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  // Match trailing `Z`, `+HH:MM`, `-HH:MM`, `+HHMM`, `-HHMM`.
  if (/Z$/i.test(raw)) return 'UTC';
  const offsetMatch = /([+-])(\d{2}):?(\d{2})$/.exec(raw);
  if (offsetMatch === null) return undefined;
  const sign = offsetMatch[1];
  const hoursStr = offsetMatch[2];
  const minsStr = offsetMatch[3];
  const hours = parseInt(hoursStr, 10);
  const mins = parseInt(minsStr, 10);
  if (sign === '+' && hours === 0 && mins === 0) return 'UTC';
  // Codex fold #9 — preserve minutes for non-whole-hour offsets.
  // POSIX `Etc/GMT±N` only covers whole-hour offsets and flips the
  // sign (east-of-UTC = `GMT-N`). Half/quarter-hour offsets
  // (India/Iran/Newfoundland/Adelaide/Nepal/Chatham) surface as
  // raw `±HH:MM` strings.
  if (mins === 0) {
    return `Etc/GMT${sign === '+' ? '-' : '+'}${hours}`;
  }
  return `${sign}${hoursStr}:${minsStr}`;
};

/** Canonicalize an email — lowercase + trim. Returns null for empty
 *  / malformed inputs. */
export const canonicalizeEmail = (
  raw: string | null | undefined,
): string | null => {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.length === 0 || !trimmed.includes('@')) return null;
  return trimmed;
};

/** Parse a Salesforce email-list field. Splits on `;`, `,`, or `\n`
 *  and canonicalizes each entry. EmailMessage.ToAddress / CcAddress /
 *  BccAddress arrive as semicolon-separated strings. */
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
 *  available, falls back to `TextEncoder` (browser parity). */
export const byteSizeOf = (s: string): number => {
  if (typeof Buffer !== 'undefined') return Buffer.byteLength(s, 'utf8');
  return new TextEncoder().encode(s).length;
};

// ────────────────────────────────────────────────────────────────
// Engagement-row body inline cap (parity with HubSpot)
// ────────────────────────────────────────────────────────────────

/** Body-inline cap — same as HubSpot's. Engagement row payloads aim
 *  for ≤ 8 KB total per D-128's `PLATFORM_REFERENCE_META_MAX_BYTES`.
 *  Reserve ~6 KB for body, ~2 KB for meta. */
export const ENGAGEMENT_BODY_INLINE_MAX_BYTES = 6 * 1024;

export interface BodyStateProjection {
  body_state: 'none' | 'inline_body' | 'truncated_inline';
  body_inline?: string;
  body_truncation_offset?: number;
}

/** Body-state machine over the CRM body (none / inline_body /
 *  truncated_inline). Per D-184 Decision 2 the ingest never sets
 *  `'mail_link'`: CRM-email ↔ `data.mail` twins resolve LIVE in the
 *  `resolveEngagementsForContact` resolver (which flips `body_state` →
 *  `'mail_link'` + sets `mail_twin_id`), not in the reconciler. */
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

/** First 256 chars of `body` (display preview). Returns null when
 *  body is empty. */
export const pickBodyPreview = (body: string | null | undefined): string | null => {
  if (body === null || body === undefined || body.length === 0) return null;
  return body.slice(0, 256);
};

// ────────────────────────────────────────────────────────────────
// Authorship — Salesforce-flavored derivation (§ A.3.2)
// ────────────────────────────────────────────────────────────────

/** Salesforce's "Automated Process User" — a system-level user the
 *  platform creates per-org for triggering automation (Process Builder
 *  / Flow / Apex). When `CreatedById` matches this user, the row is
 *  authored by automation — `'crm_automation'` per § A.3.2.
 *
 *  The actual Id varies per-org but always carries a recognizable
 *  prefix (`005` is the User SObject prefix); the substrate captures
 *  the connection's resolved Automated Process User Id at enrollment
 *  + threads it through reconcilers. When unknown (older orgs / probe
 *  failed), the substrate skips the `'crm_automation'` branch. */
export interface SalesforceAuthorshipDeps {
  /** OwnerId matching the connection's user identity. When OwnerId
   *  matches this value → `'user'`. */
  connectionUserOwnerId?: string;
  /** Automated Process User Id (typically resolved via SOQL
   *  `SELECT Id FROM User WHERE Alias = 'autoproc'` at enrollment).
   *  When `CreatedById` matches → `'crm_automation'`. */
  automatedProcessUserId?: string;
}

/** Derive authorship for Salesforce engagement rows. Order of
 *  precedence per § A.3.2:
 *
 *    1. OwnerId matches connection user → 'user'
 *    2. CreatedById matches Automated Process User → 'crm_automation'
 *    3. OwnerId populated (different user) → 'crm_user'
 *    4. CreatedById populated (no owner) → 'crm_user'
 *    5. otherwise → 'unknown' */
export const deriveSalesforceAuthorship = (input: {
  ownerId?: unknown;
  createdById?: unknown;
  deps: SalesforceAuthorshipDeps;
}): Authorship => {
  const ownerId = readString(input.ownerId);
  const createdById = readString(input.createdById);

  if (
    ownerId !== null &&
    typeof input.deps.connectionUserOwnerId === 'string' &&
    input.deps.connectionUserOwnerId.length > 0 &&
    ownerId === input.deps.connectionUserOwnerId
  ) {
    return 'user';
  }

  if (
    createdById !== null &&
    typeof input.deps.automatedProcessUserId === 'string' &&
    input.deps.automatedProcessUserId.length > 0 &&
    createdById === input.deps.automatedProcessUserId
  ) {
    return 'crm_automation';
  }

  if (ownerId !== null) return 'crm_user';
  if (createdById !== null) return 'crm_user';
  return 'unknown';
};

// ────────────────────────────────────────────────────────────────
// Lifecycle helpers — task / event / email_message / call drivers
// ────────────────────────────────────────────────────────────────

/** § A.3.6 Salesforce Task lifecycle. Salesforce Status enum:
 *  `'Not Started' | 'In Progress' | 'Completed' | 'Waiting on
 *  someone else' | 'Deferred'`. CompletedDateTime populated alongside
 *  `'Completed'` flips state to 'completed'; `'Deferred'` to
 *  'cancelled' (per substrate naming convention — Salesforce doesn't
 *  surface a "cancelled" status natively, but Deferred is the closest
 *  semantic for "we're not doing this"). */
export const deriveSalesforceTaskLifecycleState = (
  status: string | null | undefined,
): EngagementLifecycleState => {
  const s = (status ?? '').toLowerCase().trim();
  if (s === 'completed') return 'completed';
  if (s === 'deferred' || s === 'cancelled' || s === 'canceled') {
    return 'cancelled';
  }
  return 'pending';
};

/** § A.3.6 Salesforce Event lifecycle. Salesforce Events don't have
 *  a status enum — completion is implicit from `StartDateTime`
 *  vs now. Future events → 'scheduled'; past events → 'completed'.
 *  Cancellation in Salesforce typically deletes the Event (no
 *  cancelled-but-preserved row); the substrate exposes the deleted
 *  row via tombstone, not a 'cancelled' lifecycle state. */
export const deriveSalesforceEventLifecycleState = (
  startTime: number | null,
  now: number,
): EngagementLifecycleState => {
  if (startTime === null) return 'scheduled';
  if (startTime > now) return 'scheduled';
  return 'completed';
};

/** § A.3.6 Salesforce EmailMessage lifecycle. Always `'point_in_time'`
 *  — EmailMessage rows represent sent or received emails (no
 *  scheduled-vs-pending distinction in Salesforce's data model;
 *  drafts are a separate construct). */
export const deriveSalesforceEmailMessageLifecycleState =
  (): EngagementLifecycleState => 'point_in_time';

/** § A.3.6 Salesforce VoiceCall / CallHistory lifecycle. Always
 *  `'point_in_time'` — calls are point-in-time records of an
 *  attempted-or-completed call. */
export const deriveSalesforceCallLifecycleState =
  (): EngagementLifecycleState => 'point_in_time';

// ────────────────────────────────────────────────────────────────
// Direction derivation
// ────────────────────────────────────────────────────────────────

/** § A.3.3 Salesforce Email direction — driven by `Incoming` boolean.
 *  `true` → 'inbound'; `false` → 'outbound'. The substrate doesn't
 *  derive 'internal' for Salesforce email_message even when all
 *  participants share an internal domain — Salesforce's Incoming
 *  field is the primary signal and overriding it would be misleading. */
export const deriveSalesforceEmailDirection = (
  incoming: unknown,
): 'inbound' | 'outbound' | 'unknown' => {
  if (incoming === true || incoming === 'true') return 'inbound';
  if (incoming === false || incoming === 'false') return 'outbound';
  return 'unknown';
};

/** § A.3.3 Salesforce VoiceCall direction — driven by `CallType`. */
export const deriveSalesforceCallDirection = (
  callType: unknown,
): 'inbound' | 'outbound' | 'internal' | 'unknown' => {
  if (typeof callType !== 'string') return 'unknown';
  const upper = callType.toUpperCase();
  if (upper === 'INBOUND') return 'inbound';
  if (upper === 'OUTBOUND') return 'outbound';
  if (upper === 'INTERNAL') return 'internal';
  return 'unknown';
};

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

const readString = (raw: unknown): string | null => {
  if (typeof raw !== 'string') return null;
  if (raw.length === 0) return null;
  return raw;
};

/** Stringify a SOQL value for hash-stable token output. */
export const stringifySoqlValue = (raw: unknown): string => {
  if (raw === null || raw === undefined) return '';
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? String(raw) : '';
  }
  if (typeof raw === 'boolean') return raw ? 'true' : 'false';
  return '';
};

/** Vendor-namespaced target_id for Salesforce engagement rows. */
export const salesforceEngagementTargetIdFor = (
  entity: string,
  rawId: string,
): string => `salesforce_${entity}_${rawId}`;

/** Read a Salesforce ID and return null when missing / non-string. */
export const readSalesforceId = (raw: unknown): string | null => readString(raw);

/** Read a number from a SOQL value (number or numeric-string). */
export const readSalesforceNumber = (raw: unknown): number | null => {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? raw : null;
  }
  if (typeof raw === 'string' && raw.length > 0) {
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

/** Read a boolean from a SOQL value. */
export const readSalesforceBoolean = (raw: unknown): boolean | null => {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'string') {
    const lower = raw.toLowerCase();
    if (lower === 'true') return true;
    if (lower === 'false') return false;
  }
  return null;
};
