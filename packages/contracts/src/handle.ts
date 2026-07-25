/** D-148 § A.5.1 + § A.5.6 — handle governance.
 *
 *  Two distinct identifiers per § A.5.1: `publisher_id` (immutable
 *  internal id keyed on server identity) and `handle` (mutable user-
 *  facing display name + DDNS subdomain). This file ships the handle
 *  validator + impersonation-detection helpers.
 *
 *  Reserved names overlap with `content-policy.ts`'s `RESERVED_HANDLES`
 *  but D-148 carries a tighter list specific to `<handle>.recued.cloud`
 *  DDNS subdomains: `admin / api / cloud / mcp / webhooks / reception
 *  / app / apps / docs / blog / status` etc. — the DNS-zone-conflict
 *  set, distinct from the marketplace publisher-handle blocklist
 *  (offensive terms + platform impersonation already handled in
 *  `validatePublisherHandle`).
 *
 *  This file's `validateHandle` composes both surfaces: marketplace
 *  reservation rules (delegating to `content-policy.ts`) PLUS the
 *  D-148 DDNS-zone reservation set PLUS Unicode-confusable detection
 *  against existing handles.
 */

/** D-148 § A.5.6 — DDNS-zone-specific reserved names. Distinct from
 *  `RESERVED_HANDLES` in `content-policy.ts` (which carries the
 *  marketplace blocklist + offensive-term filter). The two sets
 *  overlap; both apply at registration. */
export const D148_RESERVED_HANDLES: ReadonlySet<string> = new Set([
  // DNS-zone conflicts (subdomains Recued cloud uses for its own
  // services; user can't claim them).
  'admin',
  'root',
  'help',
  'support',
  'api',
  'cloud',
  'auth',
  'oauth',
  'login',
  'app',
  'apps',
  'webhooks',
  'mcp',
  'reception',
  'docs',
  'blog',
  'status',
  'recued',
  'recued-core',
  'core',
  'kernel',
  'system',
  'sys',
  'staff',
  'security',
  'abuse',
  'privacy',
  'legal',
  'press',
  'careers',
  // D-176 Phase 3 — public-secondary nameserver labels live IN the
  // customer zone (`ns1-4.recued.cloud` A/AAAA glue, exempted from
  // rebuild-from-D1 pruning in the apply-agent). A customer handle here
  // would collide with fleet infrastructure. Reserved through ns9 for
  // future fleet growth.
  'ns1', 'ns2', 'ns3', 'ns4', 'ns5', 'ns6', 'ns7', 'ns8', 'ns9',
  // Single-letter handles reserved for high-trust holders (not auto-
  // claimable). Spec § A.5.6.
  'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm',
  'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
]);

/** D-148 § A.5.6 — handle format. Inherits `validatePublisherHandle`
 *  shape: lowercase letters + digits + hyphens; must start with a
 *  letter; must end with letter or digit; minimum 2 chars (single-
 *  letter handles are reserved, not banned at format level). */
export const D148_HANDLE_REGEX = /^[a-z]([a-z0-9-]*[a-z0-9])?$/;

export const D148_HANDLE_MIN_LENGTH = 2;
export const D148_HANDLE_MAX_LENGTH = 40;

export type HandleValidationCode =
  | 'handle_empty'
  | 'handle_too_short'
  | 'handle_too_long'
  | 'handle_format'
  | 'handle_reserved'
  | 'handle_taken'
  | 'handle_confusable_to_existing';

export interface HandleValidationIssue {
  code: HandleValidationCode;
  message: string;
}

export interface HandleValidationOptions {
  /** Lookup of existing handles for confusable detection. Caller
   *  passes the canonical lowercase set; the validator does the
   *  fold-and-compare. Empty by default — confusable detection
   *  is skipped when no comparison set provided. */
  existing_handles?: ReadonlySet<string>;
}

export interface HandleValidationResult {
  ok: boolean;
  /** Canonical normalized form (NFKC + lowercase + trim). Set even
   *  when validation fails — callers persisting the rejected form
   *  for telemetry use this. */
  canonical: string;
  issues: HandleValidationIssue[];
}

/** Skeleton form for confusable detection. The Unicode TR39
 *  "skeleton algorithm" maps each character to its prototype
 *  confusable, then NFKC-normalizes the result. Two handles whose
 *  skeletons match are visually-confusable.
 *
 *  We implement a curated subset covering the Latin-script attack
 *  surface (the realistic threat model for Recued's user base v1):
 *  diacritics + Cyrillic look-alikes + zero-width controls + common
 *  digit/letter swaps. Full TR39 tables run to ~5 MB — out of scope
 *  for the contracts package. The curated table covers the
 *  `recued / recüed / recûed / recued-staff / recued-staff` class
 *  of attempts the spec calls out by name.
 *
 *  Add to the table at site of need; substantive widening (full
 *  TR39 absorption, IDN script-mixing detection) is a follow-up D. */
const CONFUSABLE_PROTOTYPES: Map<string, string> = new Map([
  // Latin diacritics → bare letter.
  ['à', 'a'], ['á', 'a'], ['â', 'a'], ['ã', 'a'], ['ä', 'a'], ['å', 'a'], ['ā', 'a'], ['ă', 'a'], ['ą', 'a'],
  ['è', 'e'], ['é', 'e'], ['ê', 'e'], ['ë', 'e'], ['ē', 'e'], ['ĕ', 'e'], ['ė', 'e'], ['ę', 'e'],
  ['ì', 'i'], ['í', 'i'], ['î', 'i'], ['ï', 'i'], ['ī', 'i'], ['į', 'i'],
  ['ò', 'o'], ['ó', 'o'], ['ô', 'o'], ['õ', 'o'], ['ö', 'o'], ['ø', 'o'], ['ō', 'o'], ['ő', 'o'],
  ['ù', 'u'], ['ú', 'u'], ['û', 'u'], ['ü', 'u'], ['ū', 'u'], ['ů', 'u'], ['ű', 'u'],
  ['ý', 'y'], ['ÿ', 'y'],
  ['ç', 'c'], ['ć', 'c'], ['č', 'c'], ['ĉ', 'c'],
  ['ñ', 'n'], ['ń', 'n'], ['ň', 'n'],
  ['š', 's'], ['ś', 's'], ['ş', 's'],
  ['ž', 'z'], ['ź', 'z'], ['ż', 'z'],
  ['ł', 'l'],
  // Cyrillic look-alikes for Latin.
  ['а', 'a'], ['е', 'e'], ['о', 'o'], ['р', 'p'], ['с', 'c'], ['у', 'y'], ['х', 'x'],
  // Greek look-alikes.
  ['α', 'a'], ['ο', 'o'], ['ρ', 'p'], ['ν', 'v'],
  // Digit/letter confusables.
  ['0', 'o'], ['1', 'l'],
  // Fullwidth Latin variants.
  ['ａ', 'a'], ['ｂ', 'b'], ['ｃ', 'c'], ['ｄ', 'd'], ['ｅ', 'e'], ['ｆ', 'f'], ['ｇ', 'g'], ['ｈ', 'h'],
  ['ｉ', 'i'], ['ｊ', 'j'], ['ｋ', 'k'], ['ｌ', 'l'], ['ｍ', 'm'], ['ｎ', 'n'], ['ｏ', 'o'], ['ｐ', 'p'],
  ['ｑ', 'q'], ['ｒ', 'r'], ['ｓ', 's'], ['ｔ', 't'], ['ｕ', 'u'], ['ｖ', 'v'], ['ｗ', 'w'], ['ｘ', 'x'],
  ['ｙ', 'y'], ['ｚ', 'z'],
]);

/** Zero-width / formatting code points that have no visual identity
 *  but can be smuggled into a handle string to defeat naive equality.
 *  Skeleton folding strips these. */
const INVISIBLE_CODEPOINTS: ReadonlySet<string> = new Set([
  '​', // ZERO WIDTH SPACE
  '‌', // ZERO WIDTH NON-JOINER
  '‍', // ZERO WIDTH JOINER
  '‎', // LEFT-TO-RIGHT MARK
  '‏', // RIGHT-TO-LEFT MARK
  '⁠', // WORD JOINER
  '﻿', // ZERO WIDTH NO-BREAK SPACE / BOM
  '­', // SOFT HYPHEN
  ' ',      // U+00A0 NO-BREAK SPACE (visible but indistinguishable from space)
]);

/** Compute the confusable skeleton of a handle. Two handles whose
 *  skeletons compare equal are visually confusable. Algorithm:
 *
 *   1. NFKC-normalize so compatibility forms (fullwidth, ligature)
 *      collapse to the base form.
 *   2. Lowercase.
 *   3. Strip invisible code points (zero-width controls).
 *   4. Map each remaining character through the confusable prototype
 *      table; characters absent from the table pass through.
 *   5. Drop hyphens (handles with hyphens are confusable with the
 *      same letters without — `recue-d` ↔ `recued`).
 */
export const computeHandleSkeleton = (handle: string): string => {
  const normalized = handle.normalize('NFKC').toLowerCase().trim();
  let skeleton = '';
  for (const ch of normalized) {
    if (INVISIBLE_CODEPOINTS.has(ch)) continue;
    if (ch === '-') continue;
    skeleton += CONFUSABLE_PROTOTYPES.get(ch) ?? ch;
  }
  return skeleton;
};

/** Canonical form of a handle: NFKC-normalize + lowercase + trim.
 *  Distinct from skeleton — canonical preserves hyphens + diacritics
 *  for display, while skeleton folds them for confusable comparison. */
export const canonicalizeHandle = (handle: string): string =>
  handle.normalize('NFKC').toLowerCase().trim();

/** Detect whether `candidate` is visually-confusable with any
 *  handle in `existing`. Both inputs are folded through
 *  `computeHandleSkeleton` before comparison. Returns the first
 *  matching existing handle (for surfacing in error messages) or
 *  undefined when no confusable found. */
export const findConfusableHandle = (
  candidate: string,
  existing: ReadonlySet<string>,
): string | undefined => {
  const candidate_skeleton = computeHandleSkeleton(candidate);
  if (!candidate_skeleton) return undefined;
  for (const handle of existing) {
    if (handle === candidate) continue;
    if (computeHandleSkeleton(handle) === candidate_skeleton) {
      return handle;
    }
  }
  return undefined;
};

/** D-148 § A.5.6 — handle validator. Returns issues + canonical
 *  form. Caller layers existing-handle taken-check + cloud-side
 *  collision check on top (server-authoritative). */
export const validateHandle = (
  handle: string,
  options: HandleValidationOptions = {},
): HandleValidationResult => {
  const issues: HandleValidationIssue[] = [];
  const canonical = canonicalizeHandle(handle);

  if (!canonical) {
    issues.push({
      code: 'handle_empty',
      message: 'Handle is required',
    });
    return { ok: false, canonical, issues };
  }

  if (canonical.length < D148_HANDLE_MIN_LENGTH) {
    issues.push({
      code: 'handle_too_short',
      message: `Handle must be at least ${D148_HANDLE_MIN_LENGTH} characters`,
    });
  }
  if (canonical.length > D148_HANDLE_MAX_LENGTH) {
    issues.push({
      code: 'handle_too_long',
      message: `Handle must be ${D148_HANDLE_MAX_LENGTH} characters or fewer`,
    });
  }

  // Format check on the canonical form. Reject any non-ASCII letter,
  // digit, or hyphen — confusable detection above runs separately
  // for diacritic look-alikes; the format rule simply says handles
  // are ASCII-only by construction.
  if (!D148_HANDLE_REGEX.test(canonical)) {
    issues.push({
      code: 'handle_format',
      message: 'Handle must be lowercase ASCII letters, digits, and hyphens. Must start with a letter; must end with a letter or digit',
    });
  }

  if (D148_RESERVED_HANDLES.has(canonical)) {
    issues.push({
      code: 'handle_reserved',
      message: `'${canonical}' is reserved`,
    });
  }

  // Existing-handle checks run after format / reservation. Order:
  //   (1) `handle_taken` — exact case-insensitive match against an
  //        existing handle in the comparison set. Definitive collision;
  //        emit before running confusable detection (Codex P2 #2 fold).
  //   (2) `handle_confusable_to_existing` — if no exact match, check
  //        skeleton equality against the rest of the set.
  if (options.existing_handles && options.existing_handles.size > 0) {
    // Canonicalize the comparison set on every call. Cheap; cleaner
    // than asking callers to pre-canonicalize.
    const canonical_set = new Set<string>();
    for (const h of options.existing_handles) {
      canonical_set.add(canonicalizeHandle(h));
    }
    if (canonical_set.has(canonical)) {
      issues.push({
        code: 'handle_taken',
        message: `'${canonical}' is already taken`,
      });
    } else {
      // Only run confusable detection if not already definitively
      // taken; the two messages would be redundant.
      const collision = findConfusableHandle(canonical, canonical_set);
      if (collision !== undefined) {
        issues.push({
          code: 'handle_confusable_to_existing',
          message: `'${canonical}' is visually confusable with existing handle '${collision}'`,
        });
      }
    }
  }

  return { ok: issues.length === 0, canonical, issues };
};

// ────────────────────────────────────────────────────────────────
// D-148 § A.5.6 / P8 — handle reservation + change + transfer +
// expiry/grace state machine
// ────────────────────────────────────────────────────────────────

/** Reservation lifecycle. Closed list per § A.5.6. The cloud is the
 *  authority over `active` ↔ `grace` ↔ `released`; the server learns
 *  the state via the cloud's reservation rpc responses. */
export type HandleSubscriptionState = 'active' | 'grace' | 'released';

/** Handle history entry — one row per `(handle, reserved_at)`. The
 *  passport reads the same shape; the server-local store persists it
 *  forever (subject to retention policy, but identity provenance is
 *  load-bearing so the row never auto-truncates).
 *
 *  Codex P8 contract fold #1 — `reason` was previously typed as
 *  arbitrary `string` even though the closed-list `HandleHistoryReason`
 *  is the structural classification. The free-text user note now lives
 *  in `note` so the UI doesn't have to silently drop non-enum values. */
export interface HandleHistoryEntry {
  handle: string;
  reserved_at: number;
  released_at?: number;
  /** When the row records a transfer-in or transfer-out; the
   *  counterparty's publisher_id (stable opaque id, not handle —
   *  handle would change after the transfer). Audit chain reuses the
   *  identifier across rotations. Omitted on initial reservation +
   *  voluntary release. */
  transfer_counterparty_publisher_id?: string;
  /** Closed-list classification of why this row exists. The substrate
   *  always populates this; consumers branch on the discriminator
   *  rather than parsing free text. */
  reason?: HandleHistoryReason;
  /** Optional user-supplied free-text note (e.g., "renamed for
   *  rebrand", "transferred to acme corp"). UI surfaces verbatim. */
  note?: string;
}

/** Closed list of reasons the user-facing handle history surfaces. */
export type HandleHistoryReason =
  | 'reserved'
  | 'changed'
  | 'transferred_in'
  | 'transferred_out'
  | 'released_after_grace'
  | 'released_voluntary'
  | 'reclaimed_abuse_report';

/** Abuse-report kinds the cloud surfaces accept. Closed list. */
export type HandleAbuseKind =
  | 'impersonation'
  | 'trademark_violation'
  | 'offensive_content'
  | 'phishing'
  | 'other';

// ────────────────────────────────────────────────────────────────
// Wire shapes for cloud rpc (D-148 § A.5.2 path family extension)
// ────────────────────────────────────────────────────────────────

/** POST /v1/ddns/reserve-handle — first-come-first-served reservation
 *  rpc. The signature covers canonical-JSON of `{ publisher_id,
 *  handle, nonce, timestamp }`.
 *
 *  Codex P8 contract fold #2 — `nonce` was added because timestamp-
 *  alone replay protection collides on the per-publisher ledger when
 *  two distinct ops mint the same millisecond. The replay ledger keys
 *  on `(publisher_id, nonce)` so distinct nonces with the same
 *  timestamp don't collide. */
export interface HandleReserveRequest {
  publisher_id: string;
  handle: string;
  /** Per-request unique identifier (UUID v4). Replay-defense ledger
   *  rejects duplicate `(publisher_id, nonce)` even when timestamp
   *  matches. */
  nonce: string;
  signature: string;
  timestamp: number;
}

export interface HandleReserveResponse {
  reserved_at: number;
  handle: string;
  /** The reservation lifecycle stamp at acceptance (always `'active'`
   *  on a successful reserve). */
  state: HandleSubscriptionState;
  /** D-176 — short label of the DDNS zone this handle is bound to
   *  (`DdnsZone.label`, e.g. `net`; the cloud's `HostnameRow.zone`). New
   *  reservations land in the default zone. Optional for forward-compat: an
   *  older cloud omits it and the server falls back to `defaultDdnsZone()`. */
  zone?: string;
}

/** POST /v1/ddns/change-handle — change current handle. Cloud verifies
 *  the publisher's signature, releases the old handle, reserves the
 *  new one + emits the audit chain. Old handle continues resolving for
 *  `HANDLE_OLD_REDIRECT_WINDOW_MS` (best-effort soft redirect). */
export interface HandleChangeRequest {
  publisher_id: string;
  current_handle: string;
  new_handle: string;
  /** Per-request unique identifier (Codex P8 contract fold #2). */
  nonce: string;
  signature: string;
  timestamp: number;
}

export interface HandleChangeResponse {
  released_handle: string;
  reserved_handle: string;
  reserved_at: number;
  /** Window during which the released handle still resolves with a
   *  soft redirect to the new handle. */
  soft_redirect_until: number;
  /** D-176 — short label of the DDNS zone the (newly reserved) handle is
   *  bound to (`DdnsZone.label`, e.g. `net`; the cloud's `HostnameRow.zone`).
   *  A change carries the handle's existing zone. Optional for forward-compat:
   *  an older cloud omits it and the server falls back to `defaultDdnsZone()`. */
  zone?: string;
}

/** POST /v1/ddns/transfer-handle — dual-signature transfer. The
 *  request carries TWO signatures: `outgoing_signature` from the
 *  current owner (signs the canonical-JSON of `{ outgoing_publisher_id,
 *  incoming_publisher_id, handle, timestamp }`) and `incoming_signature`
 *  from the new owner (over the same payload). Cloud verifies BOTH +
 *  flips the reservation. */
export interface HandleTransferRequest {
  outgoing_publisher_id: string;
  incoming_publisher_id: string;
  handle: string;
  /** Per-request unique identifier (Codex P8 contract fold #2). */
  nonce: string;
  outgoing_signature: string;
  incoming_signature: string;
  timestamp: number;
}

export interface HandleTransferResponse {
  transferred_at: number;
  handle: string;
  outgoing_publisher_id: string;
  incoming_publisher_id: string;
}

/** POST /v1/ddns/abuse-report — anonymous-or-authenticated abuse
 *  report. Reporters need not be Pro subscribers; cloud queues for
 *  manual review.
 *
 *  Codex P8 security fold #3 — `reporter_publisher_id` was previously
 *  caller-supplied with no authentication, allowing anyone to claim
 *  any other publisher had filed the report. The substrate now treats
 *  the field as a SIGNED claim: when supplied, `signature` + `nonce`
 *  + `timestamp` must accompany it and verify against that publisher's
 *  pinned `server_identity_key`. Anonymous reports omit all four
 *  fields — the cloud accepts the report but does not stamp any
 *  reporter id. */
export interface HandleAbuseReportRequest {
  /** Handle being reported. */
  reported_handle: string;
  /** Closed-list category (see `HandleAbuseKind`). */
  kind: HandleAbuseKind;
  /** User-supplied detail. Capped at 4 KB at the wire layer. */
  detail: string;
  /** When the reporter is logged in (Pro publisher), their stable
   *  publisher_id rides along, ATTESTED by `signature`/`nonce`/
   *  `timestamp`. Anonymous reports omit all four fields. */
  reporter_publisher_id?: string;
  /** Required when `reporter_publisher_id` is set. Signature covers
   *  canonical-JSON of `{ reported_handle, kind, detail,
   *  reporter_publisher_id, nonce, timestamp }`. */
  signature?: string;
  nonce?: string;
  timestamp?: number;
}

export interface HandleAbuseReportResponse {
  /** Cloud-issued ticket id; reporter can reference if escalating. */
  ticket_id: string;
  received_at: number;
}

/** Closed list of error codes the handle-rpc surfaces can return.
 *  Distinct from `HandleValidationCode` (which covers shape errors
 *  the local validator catches) — these are runtime / authority /
 *  state-machine errors that only the cloud can surface.
 *
 *  Codex P8 fold notes:
 *    - `handle_publisher_unknown` is emitted ONLY post-signature-verify
 *      in the cloud (security fold #4 collapses pre-auth lookup
 *      failures into `handle_signature_invalid` to prevent publisher
 *      enumeration).
 *    - `handle_already_reserved` is the substrate's discriminator for
 *      "this publisher already owns a different handle" (correctness
 *      fold #2 / #4). Distinct from `handle_taken` which means
 *      "another publisher owns this handle".
 *    - `handle_authority_handle_mismatch` surfaces the
 *      `authority.handle === row.handle` invariant from correctness
 *      fold #5; emitted when an actor tries to operate on a stale row.
 */
export type HandleRpcErrorCode =
  | 'handle_signature_invalid'
  | 'handle_publisher_unknown'
  | 'handle_subscription_lapsed'
  | 'handle_replay_window_exceeded'
  | 'handle_replay_duplicate'
  | 'handle_taken'
  | 'handle_already_reserved'
  | 'handle_confusable_to_existing'
  | 'handle_reserved'
  | 'handle_validation_error'
  | 'handle_grace_pending'
  | 'handle_transfer_signature_mismatch'
  | 'handle_transfer_handle_unowned'
  | 'handle_authority_handle_mismatch'
  | 'handle_abuse_kind_unknown'
  | 'handle_abuse_detail_too_large'
  | 'handle_abuse_signature_invalid'
  | 'handle_abuse_signature_required'
  | 'handle_rate_limited';

/** D-148 § A.5.6 — closed enumeration of the `HandleRpcErrorCode` union.
 *  Production HTTP cloud-client uses this at the response-decoding
 *  boundary to project the cloud's `error.code` into the typed union;
 *  the unit-test ratchet (`d-148-phase-8-handle-production-wiring`)
 *  asserts the array's membership equals the type's so any future code
 *  added to the union is forced to extend this list at the same time.
 *  Keep this in lockstep with the union literally above. */
export const HANDLE_RPC_ERROR_CODES: ReadonlyArray<HandleRpcErrorCode> = [
  'handle_signature_invalid',
  'handle_publisher_unknown',
  'handle_subscription_lapsed',
  'handle_replay_window_exceeded',
  'handle_replay_duplicate',
  'handle_taken',
  'handle_already_reserved',
  'handle_confusable_to_existing',
  'handle_reserved',
  'handle_validation_error',
  'handle_grace_pending',
  'handle_transfer_signature_mismatch',
  'handle_transfer_handle_unowned',
  'handle_authority_handle_mismatch',
  'handle_abuse_kind_unknown',
  'handle_abuse_detail_too_large',
  'handle_abuse_signature_invalid',
  'handle_abuse_signature_required',
  'handle_rate_limited',
] as const;

/** D-148 § A.5.6 — replay window for signed handle-management
 *  requests. Same envelope discipline as the DDNS update endpoint. */
export const HANDLE_RPC_REPLAY_WINDOW_MS = 5 * 60 * 1000;

/** D-148 § A.5.6 — abuse-report detail cap (4 KB). */
export const HANDLE_ABUSE_REPORT_DETAIL_MAX_BYTES = 4 * 1024;

/** D-148 § A.5.6 — closed list of abuse kinds. */
export const HANDLE_ABUSE_KINDS: ReadonlyArray<HandleAbuseKind> = [
  'impersonation',
  'trademark_violation',
  'offensive_content',
  'phishing',
  'other',
] as const;

export const isHandleAbuseKind = (value: unknown): value is HandleAbuseKind =>
  typeof value === 'string' && (HANDLE_ABUSE_KINDS as ReadonlyArray<string>).includes(value);

/** D-148 § A.5.6 — closed list of reservation lifecycle states. */
export const HANDLE_SUBSCRIPTION_STATES: ReadonlyArray<HandleSubscriptionState> = [
  'active',
  'grace',
  'released',
] as const;

export const isHandleSubscriptionState = (
  value: unknown,
): value is HandleSubscriptionState =>
  typeof value === 'string' &&
  (HANDLE_SUBSCRIPTION_STATES as ReadonlyArray<string>).includes(value);
