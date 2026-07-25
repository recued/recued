/** D-149 P3 § A.4 + § Contract Tightening — typed allowlist for
 *  `packet_declaration.source_query_ref`.
 *
 *  Pre-Pass-2 design used a bare `string` here, which is a substrate
 *  hole: an attacker who controls a packet declaration could point the
 *  query at `vault.*` / `data.memory.*` / `data.enrichment.*` and leak
 *  per-pair private state through the rendered packet's
 *  `fields_visible` projection. The Pass-2 hardening replaces the string
 *  with a discriminated union over the source query kinds reception
 *  legitimately reads.
 *
 *  Validator at the endpoint-create rpc layer asserts:
 *
 *    1. `packet_declaration.source_query_ref` parses to a `SourceQueryRef`
 *       (i.e. one of the closed kinds).
 *    2. `source_query_ref.kind ∈ SOURCE_QUERY_KINDS_PERMITTED_PER_PACKET_KIND[
 *         packet_declaration.packet_kind]` — per-packet-kind
 *       per-source-query allowlist.
 *
 *  Arbitrary substrate paths (`vault.*`, `data.memory.*`,
 *  `data.enrichment.*`, `connection.*`) are rejected at the rpc edge —
 *  there is no `string` escape hatch.
 *
 *  Spec: D-149 § A.4 + § Contract Tightening § Source query
 *  reference. */

import type { RedactedPacketKind } from './redacted-packets.js';

// ────────────────────────────────────────────────────────────────
// Per-kind source query union
// ────────────────────────────────────────────────────────────────

/** § Contract Tightening — discriminated union over the source query
 *  kinds reception is allowed to read. Adding a new kind = substrate
 *  code change in this file (NOT a packet_declaration config). */
export type SourceQueryRef =
  // reception_page consumes config from the per-server config table
  | { readonly kind: 'reception_page_config' }
  // scheduling_link consumes the user's combined calendar
  | { readonly kind: 'data.calendar.combined' }
  // intake_form consumes a form_definition row
  | { readonly kind: 'reception_form_definition'; readonly form_definition_id: string }
  // drop_link consumes a per-link config row
  | { readonly kind: 'reception_drop_config'; readonly drop_config_id: string }
  // approval_link consumes an approval intent row
  | { readonly kind: 'reception_approval_intent'; readonly intent_id: string }
  // status_link consumes a typed entity reference (allowlisted entity kinds)
  | { readonly kind: 'data.task'; readonly task_id: string }
  | { readonly kind: 'data.note'; readonly note_id: string }
  | { readonly kind: 'data.commitment'; readonly commitment_id: string }
  | { readonly kind: 'data.project'; readonly project_id: string }
  | { readonly kind: 'data.event'; readonly event_id: string }
  | { readonly kind: 'data.packing_list'; readonly list_id: string }
  | { readonly kind: 'data.itinerary'; readonly itinerary_id: string };

export type SourceQueryKind = SourceQueryRef['kind'];

export const SOURCE_QUERY_KINDS: ReadonlyArray<SourceQueryKind> = [
  'reception_page_config',
  'data.calendar.combined',
  'reception_form_definition',
  'reception_drop_config',
  'reception_approval_intent',
  'data.task',
  'data.note',
  'data.commitment',
  'data.project',
  'data.event',
  'data.packing_list',
  'data.itinerary',
] as const;

export const SOURCE_QUERY_KIND_SET: ReadonlySet<SourceQueryKind> = new Set(SOURCE_QUERY_KINDS);

export const isSourceQueryKind = (value: unknown): value is SourceQueryKind =>
  typeof value === 'string' && SOURCE_QUERY_KIND_SET.has(value as SourceQueryKind);

// ────────────────────────────────────────────────────────────────
// Per-packet-kind allowlist
// ────────────────────────────────────────────────────────────────

/** Spec § Contract Tightening § Source query reference. Each reception
 *  packet kind binds to its single allowed source-query kind (status_link
 *  carries the broadest set since the projection can read any of seven
 *  entity kinds). D-145 originals (S2S Preview kinds) are absent from
 *  this map — the substrate gate fires only on reception packet kinds. */
export const SOURCE_QUERY_KINDS_PERMITTED_PER_PACKET_KIND: Partial<
  Record<RedactedPacketKind, ReadonlyArray<SourceQueryKind>>
> = {
  reception_page_packet: ['reception_page_config'],
  scheduling_link_packet: ['data.calendar.combined'],
  intake_form_packet: ['reception_form_definition'],
  drop_link_packet: ['reception_drop_config'],
  approval_link_packet: ['reception_approval_intent'],
  status_link_packet: [
    'data.task',
    'data.note',
    'data.commitment',
    'data.project',
    'data.event',
    'data.packing_list',
    'data.itinerary',
  ],
} as const;

/** Validator helper — does `ref.kind` appear in the permitted set for
 *  `packet_kind`? Returns false when `packet_kind` is a D-145 original
 *  (S2S Preview) since reception doesn't gate those at this layer. */
export const isSourceQueryPermittedFor = (
  packet_kind: RedactedPacketKind,
  ref: SourceQueryRef,
): boolean => {
  const permitted = SOURCE_QUERY_KINDS_PERMITTED_PER_PACKET_KIND[packet_kind];
  if (!permitted) return false;
  return permitted.includes(ref.kind);
};

// ────────────────────────────────────────────────────────────────
// Parse-from-untrusted-input
// ────────────────────────────────────────────────────────────────

/** Closed-list error codes the rpc layer surfaces when a caller-supplied
 *  `packet_declaration.source_query_ref` fails validation. The bare-string
 *  / vault-escape paths surface `source_query_unknown_kind`; per-kind
 *  per-packet-kind mismatch surfaces `source_query_disallowed_for_packet`. */
export type SourceQueryValidationCode =
  | 'source_query_not_object'
  | 'source_query_unknown_kind'
  | 'source_query_missing_id_field'
  | 'source_query_disallowed_for_packet';

export interface SourceQueryValidationFailure {
  readonly code: SourceQueryValidationCode;
  readonly detail: string;
}

export type SourceQueryValidationResult =
  | { readonly ok: true; readonly value: SourceQueryRef }
  | { readonly ok: false } & SourceQueryValidationFailure;

/** Per-kind id field required on the parsed shape. Keeps the parser
 *  closed-list — adding a new query kind = adding a new entry here. */
const REQUIRED_ID_FIELD_BY_KIND: Record<SourceQueryKind, string | null> = {
  reception_page_config: null,
  'data.calendar.combined': null,
  reception_form_definition: 'form_definition_id',
  reception_drop_config: 'drop_config_id',
  reception_approval_intent: 'intent_id',
  'data.task': 'task_id',
  'data.note': 'note_id',
  'data.commitment': 'commitment_id',
  'data.project': 'project_id',
  'data.event': 'event_id',
  'data.packing_list': 'list_id',
  'data.itinerary': 'itinerary_id',
};

/** Parse an unknown blob into a `SourceQueryRef`. Strict — unknown keys
 *  beyond `kind` + the required id field are tolerated for forward
 *  compatibility but never carried forward into the parsed shape. */
export const parseSourceQueryRef = (raw: unknown): SourceQueryValidationResult => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      ok: false,
      code: 'source_query_not_object',
      detail: 'source_query_ref must be an object',
    };
  }
  const obj = raw as Record<string, unknown>;
  const kind = obj.kind;
  if (typeof kind !== 'string' || !isSourceQueryKind(kind)) {
    return {
      ok: false,
      code: 'source_query_unknown_kind',
      detail: `source_query_ref.kind must be one of ${SOURCE_QUERY_KINDS.join(', ')}; got ${JSON.stringify(kind)}`,
    };
  }
  const requiredIdField = REQUIRED_ID_FIELD_BY_KIND[kind];
  if (requiredIdField === null) {
    return { ok: true, value: { kind } as SourceQueryRef };
  }
  const idValue = obj[requiredIdField];
  if (typeof idValue !== 'string' || idValue.length === 0) {
    return {
      ok: false,
      code: 'source_query_missing_id_field',
      detail: `source_query_ref kind=${kind} requires non-empty ${requiredIdField}`,
    };
  }
  return {
    ok: true,
    value: { kind, [requiredIdField]: idValue } as unknown as SourceQueryRef,
  };
};
