/** D-192 F1 — Commitment-evidence declaration contract.
 *
 *  A catalog manifest's top-level `commitment_evidence` array turns
 *  designated external signals into PROPOSED canonical commitments.
 *  It is NOT a Source (nothing mirrors, nothing reconciles, no
 *  sync-state row — deliberately disjoint from `work_entity_sources`,
 *  whose validator keeps `commitment` a reserved kind): one qualifying
 *  signal = one immutable evidence snapshot
 *  (`CommitmentEvidenceEntry`, `work-entities.ts`) + one HELD
 *  `commitment-create` proposal; only the owner's approval mints the
 *  D-145 `data_commitment` row (invariant 3: approval-gated, never
 *  auto-from-AI — enforced structurally by the literal
 *  `approval: 'required'` field the validator pins).
 *
 *  v1 ships the KERNEL declaration only (the SF-task-declaration
 *  precedent): pack-declared entries validate fail-closed but stay
 *  inert until the decomposer pass-through lands.
 *
 *  Spec: docs/d-192-spec.md § Commitment evidence (F1) ·
 *  decisions-log D-192 (ratified 2026-07-02). */

import type { CrmAlias } from './connection-vendors.js';
import type { CommitmentDirection, CommitmentEvidenceKind } from './work-entities.js';

// ────────────────────────────────────────────────────────────────
// Closed enums
// ────────────────────────────────────────────────────────────────

/** Capture events. `value_set` — the field goes empty → non-empty;
 *  `value_changed` — non-empty → different non-empty. A field going
 *  non-empty → EMPTY never captures (a cleared next-step is not a
 *  promise, and per lifecycle invariant it is not fulfillment proof
 *  either). */
export const COMMITMENT_EVIDENCE_CAPTURE_EVENTS = ['value_set', 'value_changed'] as const;
export type CommitmentEvidenceCaptureEvent =
  (typeof COMMITMENT_EVIDENCE_CAPTURE_EVENTS)[number];
export const COMMITMENT_EVIDENCE_CAPTURE_EVENT_SET: ReadonlySet<string> = new Set(
  COMMITMENT_EVIDENCE_CAPTURE_EVENTS,
);

/** Counterparty resolution strategies.
 *   - `record_contact_edges` (D-192 F1): the captured record's contact
 *     edges (deal → `crm.contact`/`contact` edges → the D-138
 *     forward-resolver → `contact_id`) — the CRM next-step showcase.
 *   - `mail_thread_contact` (D-192 email flagship E1): the mail-thread
 *     counterparty of an extracted `commitment_tracker` commitment. The
 *     `commitment_tracker` producer walks PER CONTACT, so the counterparty
 *     IS the walked contact (`value.entity`); direction is derived by
 *     comparing the promise `actor_email` against that subject — the
 *     actor is the subject ⇒ `inbound` (they promised us), else
 *     `outbound` (our side promised them). Both resolve the counterparty
 *     to its D-138 canonical email. The resolver logic lives backend-side
 *     (`resolveMailCommitmentCounterparty`, `commitment-extraction-funnel.ts`)
 *     — this enum only names the strategy, exactly as `record_contact_edges`
 *     names the deal resolver in `resolveCounterpartyFromContactEmails`.
 *   - `messenger_sender_contact` (D-192 messenger flagship M3): the
 *     sender of an inbound matched chat message. The messenger bus is
 *     inbound-only, so the sender IS the counterparty; the resolver maps
 *     the `(vendor, actor_platform_id)` pair through the D-138
 *     `contact_platform_link` table → D-138 canonical email (the same
 *     `lookupPlatformLink` → `resolveCanonicalEmail` walk F1's
 *     `record_contact_edges` uses for a `remote_id` edge). Direction stays
 *     `inbound` (no actor-vs-subject flip — there is no separate subject).
 *     The resolver logic lives backend-side
 *     (`resolveMessageCommitmentActor`, `message-commitment-funnel.ts`).
 *  Unresolvable → the proposal's counterparty defaults EMPTY (the column
 *  is nullable — the owner fills or leaves at approval). */
export const COMMITMENT_EVIDENCE_COUNTERPARTY_RESOLVERS = [
  'record_contact_edges',
  'mail_thread_contact',
  'messenger_sender_contact',
] as const;
export type CommitmentEvidenceCounterpartyResolver =
  (typeof COMMITMENT_EVIDENCE_COUNTERPARTY_RESOLVERS)[number];

/** The subset a *manifest* DECLARATION may use — mirrors the kinds split
 *  (`COMMITMENT_EVIDENCE_DECLARABLE_KINDS` vs `COMMITMENT_EVIDENCE_KINDS`,
 *  `work-entities.ts`). v1: `record_contact_edges` only.
 *  `mail_thread_contact` and `messenger_sender_contact` are KERNEL
 *  strategies the flagship funnels apply internally (never a pack field
 *  diff), so the declaration validator rejects either with a kernel-only
 *  pointer — while the wider set above still carries them as valid
 *  resolved strategies. */
export const COMMITMENT_EVIDENCE_DECLARABLE_COUNTERPARTY_RESOLVERS = [
  'record_contact_edges',
] as const;
export const COMMITMENT_EVIDENCE_DECLARABLE_COUNTERPARTY_RESOLVER_SET: ReadonlySet<string> =
  new Set(COMMITMENT_EVIDENCE_DECLARABLE_COUNTERPARTY_RESOLVERS);

/** Statement template cap — the template itself (the rendered
 *  statement additionally clamps to `COMMITMENT_STATEMENT_MAX` at the
 *  store). Templates are a single-placeholder convention
 *  (`{{field_value}}`), not an expression language. */
export const COMMITMENT_EVIDENCE_STATEMENT_TEMPLATE_MAX_CHARS = 200;

/** The one placeholder a statement template may reference. */
export const COMMITMENT_EVIDENCE_TEMPLATE_PLACEHOLDER = '{{field_value}}';

// ────────────────────────────────────────────────────────────────
// Declaration shape
// ────────────────────────────────────────────────────────────────

/** The capture source for the `crm_field` family: one canonical-
 *  vocabulary field on a `crm_alias` entity. The `(crm_alias, field)`
 *  pair must exist in the D-190 canonical vocabulary for at least one
 *  vendor (`canonicalCrmFieldSet` — the validator gate); capture is
 *  deterministic (no AI, no confidence machinery) because the field
 *  is structured and rep-authored. */
export interface CommitmentEvidenceCrmFieldSource {
  crm_alias: CrmAlias;
  field: string;
}

export interface CommitmentEvidenceDeclaration {
  /** Evidence family — closed list (v1: `crm_field` only; `mail` /
   *  `message` are reserved names the validator rejects explicitly). */
  kind: CommitmentEvidenceKind;
  source: CommitmentEvidenceCrmFieldSource;
  /** The declaration's DEFAULT direction — owner-editable at
   *  approval (a next-step is usually self→counterparty =
   *  `outbound`, but the declaration only proposes). */
  direction: CommitmentDirection;
  counterparty: { resolve: CommitmentEvidenceCounterpartyResolver };
  /** Proposal statement template; rendered value clamps to
   *  `COMMITMENT_STATEMENT_MAX`. */
  statement: { template: string };
  capture_on: readonly CommitmentEvidenceCaptureEvent[];
  /** LITERAL `'required'` — the validator rejects anything else in
   *  v1. Structurally pins invariant 3. */
  approval: 'required';
}
