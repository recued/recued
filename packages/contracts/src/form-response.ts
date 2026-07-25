/**
 * Canonical intake-form response — the generic DESTINATION (D-210 A.4).
 *
 * A response enters this data contract only after the owner accepts it. The
 * public POST writes the sealed `reception_form_submission` evidence row; the
 * approve funnel creates this mutable working destination.
 *
 * Under centre/leaf this is a **stage-3 destination**, not evidence. The sealed,
 * never-edited record of what a visitor submitted is
 * `reception_form_submission` — written first, kept even for spam, and the
 * provenance anchor every other surface keys off. Because that evidence lives
 * elsewhere, this record is free to be what an owner actually needs: a working
 * record they can advance through a lifecycle. The response stays free-form —
 * its values and the form definition used to validate them are retained as JSON
 * rather than forced into a task/contact schema.
 */

import type { CanonicalRecord } from './canonical-record.js';

export interface FormResponseVisitor {
  readonly email?: string;
}

/** D-210 A.7.1 — the lifecycle that makes this a TIER-2 destination rather than
 *  a log wearing a destination's name. A.4 names the two real usages: an event
 *  ROSTER and a public APPLY flow.
 *
 *  🔑 Deliberately kept TIGHT rather than unioning both domains' vocabularies.
 *  A generic destination that carries every word from every workflow is the
 *  one-word-two-substrates failure, and a state nobody sets is worse than a
 *  state that is missing. Adding a member later is additive and safe; REMOVING
 *  one is not — so this starts small on purpose.
 *
 *  ⚠ `no_show` is NOT foldable into `declined`. Per A.5.3b, never remap a state
 *  whose distinguishability a downstream policy keys on: "they were accepted and
 *  did not turn up" and "I turned them down" are opposite facts about opposite
 *  parties, and a repeat-no-show rule cannot be computed once they collapse. */
export const FORM_RESPONSE_LIFECYCLE_STATES = [
  /** Arrived, owner has not touched it. */
  'received',
  /** Owner is working it — the apply flow's shortlist step. */
  'in_review',
  /** Owner said yes: registered for the event / advanced the application. */
  'accepted',
  /** Owner said no. */
  'declined',
  /** Was `accepted`, then did not turn up. A fact about the VISITOR. */
  'no_show',
] as const;

export type FormResponseLifecycleState = (typeof FORM_RESPONSE_LIFECYCLE_STATES)[number];

/** The state a response is BORN in. Named rather than positional — the same
 *  reason `BOOKING_DEFAULT_LIFECYCLE_STATE` is: reordering the list above must
 *  never silently change what a new record means. */
export const FORM_RESPONSE_DEFAULT_LIFECYCLE_STATE: FormResponseLifecycleState = 'received';

export const FORM_RESPONSE_LIFECYCLE_STATE_SET: ReadonlySet<FormResponseLifecycleState> = new Set(
  FORM_RESPONSE_LIFECYCLE_STATES,
);

export interface FormResponse extends CanonicalRecord {
  readonly _collection: 'form_response';
  /** Stable origin id. `_id` is the same value. */
  readonly submission_id: string;
  readonly endpoint_id: string;
  readonly form_definition_id: string;
  /** Exact owner-side form definition captured for this submission. */
  readonly definition_snapshot: Readonly<Record<string, unknown>>;
  /** Free-form visitor values, keyed by the snapshotted field names. */
  readonly values: Readonly<Record<string, unknown>>;
  /** Substrate-supplied visitor fields that are not part of `values`. */
  readonly visitor: FormResponseVisitor;
  readonly submitted_at: number;
  readonly accepted_at: number;
  /** Last owner edit to values or visitor identity. Initially accepted_at. */
  readonly updated_at: number;
  /** Visitor-authored content remains tainted after owner acceptance.
   *
   *  ⛔ This stays `'anonymous'` even though the owner can now advance
   *  `lifecycle_state`. It describes who authored the ANSWERS, and they are
   *  still the visitor's. Re-stamping the row `user_self` because an owner
   *  touched one field would launder D-177 taint on the visitor free-text —
   *  a stored read that the Gateway treats as clean when it is not. The owner
   *  authors the STATE; the visitor authors the CONTENT; one row, two
   *  authorships, and only the content decides the taint. */
  readonly origin_actor: 'anonymous';
  /** Server-owned promotion path; never caller supplied. */
  readonly origin_surface: 'system';
  /** D-210 A.7.1 — owner-authored lifecycle. */
  readonly lifecycle_state: FormResponseLifecycleState;
  /** When `lifecycle_state` last actually CHANGED — not when the row was last
   *  touched. A metadata edit must not move it, or "when did they no-show?"
   *  silently degrades into "when was this last saved?". */
  readonly state_changed_at: number;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface AcceptFormResponseInput {
  readonly submission_id: string;
  readonly endpoint_id: string;
  readonly form_definition_id: string;
  readonly definition_snapshot: Readonly<Record<string, unknown>>;
  readonly values: Readonly<Record<string, unknown>>;
  readonly visitor?: FormResponseVisitor;
  readonly submitted_at: number;
  readonly accepted_at: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface FormResponseListQuery {
  readonly endpoint_id?: string;
  readonly form_definition_id?: string;
  /** Exclusive, stable keyset cursor matching the store's sort order. */
  readonly before?: FormResponseListCursor;
  readonly limit?: number;
  readonly lifecycle_states?: ReadonlyArray<FormResponseLifecycleState>;
}

export interface FormResponseListCursor {
  readonly accepted_at: number;
  readonly submission_id: string;
}

/** Small row projection for the owner Data browser. Full answer values and the
 * frozen schema stay behind `form_response.get`, so opening a collection does
 * not pull every visitor's complete submission into memory. */
export interface FormResponseListItem {
  readonly submission_id: string;
  readonly endpoint_id: string;
  readonly form_definition_id: string;
  readonly visitor: FormResponseVisitor;
  readonly submitted_at: number;
  readonly accepted_at: number;
  readonly updated_at: number;
  readonly lifecycle_state: FormResponseLifecycleState;
  readonly state_changed_at: number;
  readonly template_ref?: string;
}

/** Privacy-minimized record carried by the warehouse trigger fired when an
 * accepted response is first created. It intentionally excludes `values`, the
 * frozen definition, visitor identity, and free-form metadata: a trigger may
 * use these routing fields to decide whether to run, but reading the submitted
 * answers remains a separate owner-only operation. */
export interface FormResponseTriggerRecord {
  readonly _id: string;
  readonly _collection: 'form_response';
  readonly submission_id: string;
  readonly endpoint_id: string;
  readonly form_definition_id: string;
  readonly submitted_at: number;
  readonly accepted_at: number;
}

/** Stable warehouse-bus address for the existing at-most-once trigger
 * substrate. Recipes subscribe to `FORM_RESPONSE_CREATED_EVENT_PATTERN`; the
 * event's `record_id` is the canonical submission id and `record` is a
 * {@link FormResponseTriggerRecord}. The durable FormResponse remains the
 * source of truth when a process exits between persistence and event fan-out.
 */
export const FORM_RESPONSE_EVENT_PLATFORM = 'form_response' as const;
export const FORM_RESPONSE_EVENT_SLUG = 'accepted' as const;
export const FORM_RESPONSE_EVENT_ENTITY_TYPE = 'response' as const;
export const FORM_RESPONSE_CREATED_EVENT_PATTERN =
  `data.${FORM_RESPONSE_EVENT_PLATFORM}.${FORM_RESPONSE_EVENT_SLUG}.${FORM_RESPONSE_EVENT_ENTITY_TYPE}.created` as const;

/** Owner-facing Data browser list result. `next_cursor` is present only when
 *  another page exists; callers feed it back as `FormResponseListQuery.before`.
 *  Full answer values are fetched only when the owner opens a row. */
export interface FormResponseListRpcResponse {
  readonly responses: ReadonlyArray<FormResponseListItem>;
  readonly next_cursor?: FormResponseListCursor;
}

/** D-210 A.8 slice 2 — advance the owner-authored lifecycle.
 *
 *  ⛔ Carries ONLY the state. The visitor's answers are not editable through
 *  this method and there is no field for them, so a UI wired to it cannot
 *  rewrite what someone submitted even by accident. */
export interface FormResponseSetStateRpcRequest {
  readonly submission_id: string;
  readonly lifecycle_state: FormResponseLifecycleState;
}

/** `response` is null when no such submission exists — a missing row is not an
 *  error here, the same shape `form_response.get` returns. */
export interface FormResponseSetStateRpcResponse {
  readonly response: FormResponse | null;
}

/** Owner edits the working destination only. Provenance, frozen definition,
 * submission/acceptance timestamps, and lifecycle are intentionally absent. */
export interface FormResponseUpdateRpcRequest {
  readonly submission_id: string;
  readonly values: Readonly<Record<string, unknown>>;
  readonly visitor: FormResponseVisitor;
}

export interface FormResponseUpdateRpcResponse {
  readonly response: FormResponse | null;
}

export type FormResponseExportFormat = 'json' | 'csv';

export interface FormResponseExportRpcRequest {
  readonly format: FormResponseExportFormat;
  readonly endpoint_id?: string;
  readonly form_definition_id?: string;
  readonly lifecycle_states?: ReadonlyArray<FormResponseLifecycleState>;
  /** Resume point for the NEXT chunk — echo back `next_cursor` from the
   *  previous response. Absent ⇒ the first chunk (and, for CSV, the only one
   *  that carries a header row). */
  readonly before?: FormResponseListCursor;
}

export interface FormResponseExportRpcResponse {
  readonly filename: string;
  readonly mime_type: 'application/json' | 'text/csv';
  readonly content: string;
  readonly record_count: number;
  /** Present iff more records remain past this chunk. The per-call ceiling
   *  bounds ONE rpc payload, not the owner's ability to export their data:
   *  a caller loops on this until it is absent.
   *
   *  ⛔ It previously threw `result exceeds N records; narrow the filters` —
   *  naming filters the responses tab does not expose, so an owner past the
   *  ceiling could never export anything at all. A partial file presented as
   *  complete would have been worse; this is neither. */
  readonly next_cursor?: FormResponseListCursor;
}

export interface FormResponseGetRpcRequest {
  readonly submission_id: string;
}

export interface FormResponseGetRpcResponse {
  readonly response: FormResponse | null;
}

export interface AcceptFormResponseResult {
  readonly status: 'created' | 'existing';
  readonly response: FormResponse;
}
