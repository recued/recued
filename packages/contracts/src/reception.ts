/** D-149 § N.1 + § N.3 + § N.6 — public Reception substrate contracts.
 *
 *  Reception is the user's server's anonymous-visitor surface — six
 *  endpoint kinds (default off, granular, redacted) mounted at
 *  `/reception/*` on D-148's consolidated path-routing dispatcher
 *  (W3.7 path-mount swap; supersedes the pre-amendment 4th-port-binding
 *  framing on port 8446).
 *
 *  P1 ships the closed-list type registry only — endpoint kinds, the
 *  high-assurance audit-event kinds (per § N.3), and the substrate-internal
 *  table inventory (per Must Hold I-15 per-pair-only invariant; D-168
 *  retired the legacy SYNC_OBJECTS substrate).
 *  P2 + P3 + P4-P9 fill the per-kind handlers + packet definitions +
 *  rpc surface; this file is intentionally narrow at P1 so the lint /
 *  schema / passport / reachability surfaces have a stable import to
 *  reference without pulling in implementation. */

import { INTAKE_FORM_SUBMISSION_PROCESSING_OUTCOMES } from './intake-form-config.js';
import { SCHEDULING_LINK_BOOKING_PROCESSING_OUTCOMES } from './scheduling-link-config.js';

/** D-149 § N.1 — closed list of Reception endpoint kinds. Adding a
 *  kind = substrate code change in this file (NOT config). The
 *  validator at endpoint create rpc gates `kind ∈ RECEPTION_ENDPOINT_KINDS`. */
export type ReceptionEndpointKind =
  | 'reception_page'
  | 'scheduling_link'
  | 'intake_form'
  | 'drop_link'
  | 'approval_link'
  | 'status_link';

export const RECEPTION_ENDPOINT_KINDS: ReadonlyArray<ReceptionEndpointKind> = [
  'reception_page',
  'scheduling_link',
  'intake_form',
  'drop_link',
  'approval_link',
  'status_link',
] as const;

export const RECEPTION_ENDPOINT_KIND_SET: ReadonlySet<ReceptionEndpointKind> =
  new Set(RECEPTION_ENDPOINT_KINDS);

export const isReceptionEndpointKind = (value: unknown): value is ReceptionEndpointKind =>
  typeof value === 'string' &&
  RECEPTION_ENDPOINT_KIND_SET.has(value as ReceptionEndpointKind);

/** D-210 R-2 slice 4 — which reception kinds have something that RUNS a paired recipe.
 *
 *  ⛔ A kind is pairable IFF a consumer exists that would run its pair. Binding one on a kind
 *  with no consumer would save a row nothing reads and show the owner a door over a recipe
 *  that never fires — a promise the substrate cannot keep. So the value is the CONSUMER, not
 *  a boolean: `null` names the reason for the refusal, and it is the thing that changes when
 *  a kind becomes pairable.
 *
 *  ⛔ Keyed on the closed `ReceptionEndpointKind` union rather than listing the pairable ones,
 *  so adding a kind to that union is a TYPE ERROR here — it cannot default into either answer.
 *
 *  ⚠ It lives in CONTRACTS because it has TWO consumers that must not disagree: the rpc gate
 *  (which refuses a bind) and the webclient (which decides whether to offer the button). A
 *  webclient list that drifted from the server's would either hide a working control or offer
 *  one that 409s. One const, two readers. */
export const RECEPTION_PAIR_CONSUMER: Readonly<
  Record<ReceptionEndpointKind, string | null>
> = {
  /** The submit-time gated runner (`coordinateIntakeFormPairedRun`). */
  intake_form: 'the submit-time gated runner',
  /** D-210 R-2 slice 3b — the booking drain. Before that slice this was `null` in effect:
   *  the drain could only ever fire the pack's compiled default. */
  scheduling_link: 'the booking drain',
  reception_page: null,
  drop_link: null,
  approval_link: null,
  status_link: null,
};

/** `true` when something exists that would run this kind's paired recipe. */
export const isReceptionPairableKind = (kind: ReceptionEndpointKind): boolean =>
  RECEPTION_PAIR_CONSUMER[kind] !== null;

/** D-149 § N.3 — closed list of high-assurance audit event kinds.
 *  These rows land in `data.memory.audit` signed per D-148 § A.2.5
 *  (mutations, revocations, drop receipt, approval consumption, form
 *  submission, listener lifecycle). Routine reads (200/304/401/410/429
 *  + status_link auto-refresh polls) emit ONLY to the operational
 *  `public_endpoint_access_log` row per request — never to D-120 — so
 *  a polled status link doesn't flood Memory with 1,440 rows/visitor/day
 *  (TR-4 + § A.16.5). */
export type ReceptionHighAssuranceAuditKind =
  | 'endpoint.created'
  | 'endpoint.enabled'
  | 'endpoint.disabled'
  | 'endpoint.revoked'
  | 'endpoint.extended'
  | 'endpoint.expired'
  | 'endpoint.token_rotated'
  | 'form_submission.received'
  | 'drop_blob.received'
  | 'approval_intent.consumed'
  | 'reception.listener.started'
  | 'reception.listener.stopped'
  | 'reception.emergency_disabled'
  // D-149 P4 § A.5.1 — reception_page singleton config upsert. Mary
  // changing the front-door page's contact card / section toggles /
  // CTA links is a high-assurance event (alters the visitor-facing
  // surface server-wide) — emit a signed memory row on every upsert.
  | 'reception_page.config_updated'
  // D-200 Slices 6g.3/6g.11 — owner mutations of the exact commerce pair alter
  // anonymous visitor behavior and therefore require signed provenance.
  | 'reception.intake_recipe_pair.bound'
  | 'reception.intake_recipe_pair.configured'
  | 'reception.intake_recipe_pair.cleared'
  // D-149 P12 § A.20.5 — Abuse Inbox IP ban / unban. Banning a source
  // IP (endpoint-scoped hash) appends to the per-server block list +
  // is enforced at the path-listener; unbanning lifts it. Both alter
  // who can reach the public surface — high-assurance, signed per use.
  | 'reception.ip_blocked'
  | 'reception.ip_unblocked';

export const RECEPTION_HIGH_ASSURANCE_AUDIT_KINDS: ReadonlyArray<ReceptionHighAssuranceAuditKind> = [
  'endpoint.created',
  'endpoint.enabled',
  'endpoint.disabled',
  'endpoint.revoked',
  'endpoint.extended',
  'endpoint.expired',
  'endpoint.token_rotated',
  'form_submission.received',
  'drop_blob.received',
  'approval_intent.consumed',
  'reception.listener.started',
  'reception.listener.stopped',
  'reception.emergency_disabled',
  'reception_page.config_updated',
  'reception.intake_recipe_pair.bound',
  'reception.intake_recipe_pair.configured',
  'reception.intake_recipe_pair.cleared',
  'reception.ip_blocked',
  'reception.ip_unblocked',
] as const;

export const RECEPTION_HIGH_ASSURANCE_AUDIT_KIND_SET: ReadonlySet<ReceptionHighAssuranceAuditKind> =
  new Set(RECEPTION_HIGH_ASSURANCE_AUDIT_KINDS);

export const isReceptionHighAssuranceAuditKind = (
  value: unknown,
): value is ReceptionHighAssuranceAuditKind =>
  typeof value === 'string' &&
  RECEPTION_HIGH_ASSURANCE_AUDIT_KIND_SET.has(value as ReceptionHighAssuranceAuditKind);

/** D-149 § A.3 + § A.5.x + § Must Hold I-15 — server-internal table
 *  inventory for the Reception substrate. Per-pair only; no cross-cloud
 *  sync (D-097 / D-168). Each table is created via
 *  `ensureReceptionSchema(db)` at boot (idempotent CREATE TABLE IF NOT
 *  EXISTS); per-phase population fills the rows.
 *
 *  P1 lands the eight tables as placeholder shells per the spec
 *  P1 line "ALTER TABLE migrations land at boot for the eight new
 *  tables"; later phases (P3 wires registry + access_log; P5 wires
 *  booking_request; P6 wires form_definition + form_submission; P7
 *  wires drop_blob_metadata; P8 wires approval_intent; P9 wires
 *  status_projection) fill the operational read/write paths. The
 *  ninth `reception_rate_limiter` table referenced in § Scope item 12
 *  + § Contract Tightening lands at P3 alongside the in-memory rate
 *  limiter primary path (per the P3 phase line). D-149 P12 adds the
 *  tenth IP-block table; D-200 Slice 6g.2 adds the eleventh local
 *  intake-form/recipe pair registry.
 *
 *  ⚠ D-210 A.8 slice 4c — `reception_booking_request` is GONE from both this
 *  union and the array below. A booking is now a `reception_form_submission`
 *  row (slice 4b-ii switched every writer and reader); P5's table had no
 *  writer and no reader left, so 4c dropped the DDL. ⛔ Both the union and the
 *  array must be edited together — dropping only the array still typechecks
 *  (a subset satisfies `ReadonlyArray<ReceptionTableName>`), which would leave
 *  a name in the type that no schema creates.
 *  ⇒ [[feedback_a_subset_typechecks_so_derive_the_closed_list]] */
export type ReceptionTableName =
  | 'public_endpoint_registry'
  | 'public_endpoint_access_log'
  | 'reception_form_definition'
  // D-200 Slice 6g.2 — exact local intake-form/recipe binding. Stores only
  // the compact content-addressed pair; no Seller or provider authority.
  | 'reception_intake_recipe_pair'
  | 'reception_form_submission'
  | 'reception_drop_blob_metadata'
  | 'reception_approval_intent'
  | 'reception_status_projection'
  // D-149 P3 § Contract Tightening § Rate-limit substrate — the ninth
  // Reception table, persistence shadow for the in-memory token bucket
  // primary path. Lands at P3 alongside the rpc surface; bumped into
  // the closed list here so the per-pair-only invariant keeps
  // covering every Reception-substrate table without a P3-specific
  // exception.
  | 'reception_rate_limiter'
  // D-149 P12 § A.20.5 — Abuse Inbox per-server IP block list. The
  // tenth Reception table; stores `(endpoint_id, source_ip_hash)`
  // ban tuples the path-listener enforces before the rate-limit check.
  // Server-internal — no cross-cloud sync (D-097 / D-168).
  | 'reception_ip_block_list'
  // D-240 slice 3b — the endpoint → LOOKUP-recipe binding. Its own table rather
  // than a slot on `reception_intake_recipe_pair`: that row's binding is a
  // three-revision union carrying a form-definition cross-check and paid-checkout
  // claim configuration, none of which a read-only viewback recipe has, and it
  // holds ONE `contract_id` where D-207 §5.1c requires one per RECIPE.
  | 'reception_lookup_recipe_pair';

export const RECEPTION_TABLES: ReadonlyArray<ReceptionTableName> = [
  'public_endpoint_registry',
  'public_endpoint_access_log',
  'reception_form_definition',
  'reception_intake_recipe_pair',
  'reception_form_submission',
  'reception_drop_blob_metadata',
  'reception_approval_intent',
  'reception_status_projection',
  'reception_rate_limiter',
  'reception_ip_block_list',
  'reception_lookup_recipe_pair',
] as const;

export const RECEPTION_TABLE_SET: ReadonlySet<ReceptionTableName> =
  new Set(RECEPTION_TABLES);

// ────────────────────────────────────────────────────────────────
// D-210 A.8 slice 4b — the merged submission table's outcome vocabulary
// ────────────────────────────────────────────────────────────────

/** Which flow wrote a `reception_form_submission` row.
 *
 *  ⚠ DERIVED FROM THE ROW, never stored: a booking row has a slot
 *  (`slot_start_at IS NOT NULL`) and no form definition; an intake row is the
 *  converse. A stored discriminator would be a second source of truth for a
 *  fact the columns already carry — and one the two writers could drift from. */
export type ReceptionSubmissionRecordKind = 'booking' | 'intake';

/** Every outcome the merged table's one `processing_outcome` column can hold.
 *
 *  ## Why a union, when the union was explicitly rejected once
 *
 *  `reception-record.ts` ruled AGAINST a union — *"the union of both would let a
 *  reader ask a booking whether it was `spam`"* — but on the premise that the two
 *  tables stay SIBLINGS. A.3 merges them, so one physical column must hold both
 *  vocabularies and the union is no longer a choice; only where it is ENFORCED is.
 *
 *  🔑 The rejected ruling's REASONING outlives its premise, so the hazard it named
 *  is closed at its new location instead of dropped: this list is what the COLUMN
 *  admits, and `outcomesForRecordKind` below is what each ROW admits. A booking
 *  row carrying `spam` is refused by the substrate — strictly stronger than the
 *  sibling tables, where it was merely unreachable by accident. The read
 *  projections and the `reception.record.list` wire filter keep narrowing per
 *  kind exactly as before; nothing downstream widened.
 *
 *  ⛔ DERIVED from the two source lists, never re-typed. A hand-copied union is a
 *  subset that typechecks — it would go stale the day either arm gains a member,
 *  and the staleness would surface as a runtime throw on a live row. */
export const RECEPTION_SUBMISSION_PROCESSING_OUTCOMES: ReadonlyArray<string> = [
  ...new Set<string>([
    ...SCHEDULING_LINK_BOOKING_PROCESSING_OUTCOMES,
    ...INTAKE_FORM_SUBMISSION_PROCESSING_OUTCOMES,
  ]),
];

export const RECEPTION_SUBMISSION_PROCESSING_OUTCOME_SET: ReadonlySet<string> =
  new Set(RECEPTION_SUBMISSION_PROCESSING_OUTCOMES);

/** The outcomes ONE row may carry, keyed on which flow wrote it.
 *
 *  This is the enforcement point the union defers to. Both arms stay their own
 *  closed list — the merge is a storage fact, not a semantic one. */
export const outcomesForRecordKind = (
  kind: ReceptionSubmissionRecordKind,
): ReadonlyArray<string> =>
  kind === 'booking'
    ? SCHEDULING_LINK_BOOKING_PROCESSING_OUTCOMES
    : INTAKE_FORM_SUBMISSION_PROCESSING_OUTCOMES;

// D-148 W3.7 — `RECEPTION_DEFAULT_PORT` retired. Reception no longer
// binds its own TCP port; it mounts at `/reception/*` on the consolidated
// path-routing dispatcher per D-148 § A.6 + § A.7. The pre-amendment
// constant (8446) survives only inside the legacy spec narrative
// (D-149 § A.2.legacy). Consumers that previously read the
// port for Server Passport / Settings UX / Reachability Doctor populate
// from the per-listener bind ports instead (LAN listener port 80 / public
// listener port 443; the per-path resolution table is the source of truth).
