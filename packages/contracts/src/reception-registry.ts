/** D-149 P3 § A.3 — `public_endpoint_registry` rpc-layer contract.
 *
 *  Server-internal table. Per-pair only; no cross-cloud sync (§ Must Hold I-15; D-097 / D-168).
 *  Mirrors the SQL schema in `backend/server/src/storage/reception-store.ts`
 *  + threads the typed shapes the rpc surface returns to webclient
 *  callers (Settings → Server → Reception page).
 *
 *  Spec: docs/d-149-spec.md § A.3 (storage + rpc) + § A.5.x (per-kind
 *  packet declarations). */

import type { ReceptionEndpointKind } from './reception.js';
import type { SourceQueryRef } from './reception-source-query.js';
import type { RedactedPacketKind } from './redacted-packets.js';
import type { ProposedEndpointConfig } from './compose/index.js';
// D-149 P12 § A.20 — type-only import (erased at compile time, so no
// runtime import cycle with `reception-visitor-ux.ts`, which value-imports
// the registry's per-kind maps).
import type {
  AbuseInboxSummary,
  ViewAsVisitorPanel,
} from './reception-visitor-ux.js';
// D-149 follow-on § A.10 — type-only import for the `reception.template.list`
// result shape (erased at compile time, so no runtime import cycle —
// `intake-form-template.ts` value-imports `intake-form-config.ts` only).
import type { IntakeFormTemplate } from './intake-form-template.js';
// D-151 — type-only import for the non-intake config templates carried
// alongside on the same `reception.template.list` result (likewise
// erased at compile time).
import type { ReceptionConfigTemplate } from './reception-config-template.js';

// ────────────────────────────────────────────────────────────────
// PacketDeclaration shape
// ────────────────────────────────────────────────────────────────

/** § A.3 column `packet_declaration` (TEXT, JSON). The substrate
 *  validator gates these fields at endpoint-create:
 *
 *    - `packet_kind` ∈ RECEPTION_PACKET_KINDS (per `redacted-packet.ts`)
 *    - `source_query_ref.kind` ∈
 *      SOURCE_QUERY_KINDS_PERMITTED_PER_PACKET_KIND[packet_kind]
 *    - `fields_visible_override` ⊆ PACKET_FIELDS_VISIBLE[packet_kind]
 *
 *  `allowed_actions` is approval_link-specific (per § A.5.5); other kinds
 *  leave it empty. */
export interface PacketDeclaration {
  /** Closed-list D-145 packet kind for the reception consumer (one of
   *  six reception kinds; substrate rejects D-145 originals at the rpc
   *  layer since reception doesn't expose S2S Preview shapes). */
  readonly packet_kind: RedactedPacketKind;
  /** Per § A.5.6 status_link's `fields_visible_override` clamps the
   *  closed list further; other kinds leave undefined to inherit
   *  `PACKET_FIELDS_VISIBLE[packet_kind]` verbatim. */
  readonly fields_visible_override?: ReadonlyArray<string>;
  /** Typed allowlist (per `reception-source-query.ts`). String form
   *  rejected at rpc layer. */
  readonly source_query_ref: SourceQueryRef;
  /** Per-packet-kind transformation hooks (per § A.5.x). Names match
   *  closed-list transformation registry; substrate rejects unknown
   *  names at endpoint-create. */
  readonly transformations?: ReadonlyArray<string>;
  /** Approval-link closed-list action kinds (per § A.5.5). Empty for
   *  every other kind. */
  readonly allowed_actions?: ReadonlyArray<string>;
}

// ────────────────────────────────────────────────────────────────
// Per-kind expiry ceiling
// ────────────────────────────────────────────────────────────────

/** Spec § N.4 — per-kind expiry ceiling. `null` ⇒ kind permits long-
 *  lived (`expires_at` may be `null`), but emits a warning audit row
 *  at endpoint-enable + records `long_lived_acknowledged_at` so future
 *  audit / settings UX surfaces the deliberate-long-lived state.
 *
 *  `drop_link` / `approval_link` carry hard 30-day ceilings; others
 *  permit null long-lived. Note: even kinds that permit null
 *  long-lived still flow through the substrate-side 90-day TTL clamp
 *  inside `buildReceptionPacket` (so any non-null expiry is at most
 *  90 days from now). */
export const RECEPTION_PER_KIND_EXPIRY_MAX_MS: Readonly<
  Record<ReceptionEndpointKind, number | null>
> = {
  reception_page: null,
  scheduling_link: null,
  intake_form: null,
  drop_link: 30 * 24 * 60 * 60 * 1000,
  approval_link: 30 * 24 * 60 * 60 * 1000,
  status_link: 90 * 24 * 60 * 60 * 1000,
} as const;

// ────────────────────────────────────────────────────────────────
// Endpoint-summary projection (returned by reception.endpoints.list)
// ────────────────────────────────────────────────────────────────

/** Rpc-side projection of a registry row. Excludes `bearer_secret_hmac`
 *  / `single_use_secret_hmac` / `consumed_by_visitor_email_encrypted`
 *  (sub_dek-encrypted PII / secret material). Settings UX renders from
 *  this shape; visitor traffic never reaches it. */
export interface EndpointSummary {
  readonly endpoint_id: string;
  readonly kind: ReceptionEndpointKind;
  readonly enabled: boolean;
  readonly packet_declaration: PacketDeclaration;
  readonly created_at: number;
  readonly created_by_client_id: string;
  /** Unix-ms; `null` ⇒ long-lived (`long_lived_acknowledged_at` carries
   *  the user-ack stamp). */
  readonly expires_at: number | null;
  readonly long_lived_acknowledged_at: number | null;
  readonly revoked_at: number | null;
  readonly revocation_reason: string | null;
  readonly audit_count: number;
  readonly last_accessed_at: number | null;
  /** Per-kind metadata blob (e.g. `intake_form.template_ref`,
   *  `drop_link.size_cap_bytes`). Closed-shape per kind; substrate
   *  validator gates at rpc layer. */
  readonly metadata: Readonly<Record<string, unknown>>;
}

// ────────────────────────────────────────────────────────────────
// Access-log projection (returned by reception.endpoint.access_log)
// ────────────────────────────────────────────────────────────────

export type ReceptionAccessAction =
  | 'view'
  | 'submit'
  | 'upload'
  | 'approve'
  | 'reject'
  | 'expired'
  | 'invalid_token'
  | 'rate_limited'
  | 'revoked';

export type ReceptionAccessOutcome =
  | 'ok'
  | 'rejected'
  | 'rate_limited'
  | 'expired'
  | 'invalid_token'
  | 'revoked'
  | 'capacity_full';

export const RECEPTION_ACCESS_ACTIONS: ReadonlyArray<ReceptionAccessAction> = [
  'view',
  'submit',
  'upload',
  'approve',
  'reject',
  'expired',
  'invalid_token',
  'rate_limited',
  'revoked',
] as const;

export const RECEPTION_ACCESS_OUTCOMES: ReadonlyArray<ReceptionAccessOutcome> = [
  'ok',
  'rejected',
  'rate_limited',
  'expired',
  'invalid_token',
  'revoked',
  'capacity_full',
] as const;

export const RECEPTION_ACCESS_ACTION_SET: ReadonlySet<ReceptionAccessAction> = new Set(
  RECEPTION_ACCESS_ACTIONS,
);
export const RECEPTION_ACCESS_OUTCOME_SET: ReadonlySet<ReceptionAccessOutcome> = new Set(
  RECEPTION_ACCESS_OUTCOMES,
);

export interface AccessLogEntry {
  readonly id: string;
  readonly endpoint_id: string;
  readonly accessed_at: number;
  /** HKDF endpoint-scoped hash by default; HKDF server-wide hash when
   *  cross-endpoint analytics opt-in is on (per § A.16.4). `null` when
   *  the request bypassed source-ip hashing (rare; e.g. internal probe). */
  readonly source_ip_hash: string | null;
  readonly user_agent_hash: string | null;
  readonly action_taken: ReceptionAccessAction;
  readonly outcome: ReceptionAccessOutcome;
  readonly url_path_redacted: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
}

// ────────────────────────────────────────────────────────────────
// Rpc input / output shapes
// ────────────────────────────────────────────────────────────────

export interface ReceptionEndpointsListFilter {
  readonly kind?: ReceptionEndpointKind;
  readonly enabled?: boolean;
  readonly include_revoked?: boolean;
}

export interface ReceptionEndpointsListResult {
  readonly endpoints: ReadonlyArray<EndpointSummary>;
}

export interface ReceptionEndpointPreviewInput {
  readonly kind: ReceptionEndpointKind;
  readonly packet_declaration: PacketDeclaration;
  readonly expires_at?: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ReceptionEndpointPreviewResult {
  /** Server-rendered visitor view (same code path as the production
   *  per-kind handlers — P4-P9 wire the live render; P3 returns a
   *  substrate-level placeholder that future phases swap in). */
  readonly html: string;
  /** Closed list of visible fields per the packet declaration. Mary
   *  uses this to verify "the visitor sees only these fields" in the
   *  Settings UX before clicking Create. */
  readonly visible_fields: ReadonlyArray<string>;
  /** SHA-256 of canonical-serialized input; gates `reception.endpoint.create`
   *  via `preview_hash` parameter. 10-min expiry. */
  readonly preview_hash: string;
  /** Unix-ms; preview hash is invalidated after this timestamp. */
  readonly expires_at: number;
  /** D-149 P12 § A.20.2 — the View-As-Visitor panel: visible vs.
   *  stripped fields (with rationale), expiry / token / audit posture,
   *  and the § N.7 MUST-invariant compliance summary. Always populated
   *  by `reception.endpoint.preview_draft` (the panel is `synthetic:
   *  true` so any debug echo is unmistakably a synthetic session, never
   *  a real visitor access); optional on the type only so pre-P12 test
   *  fixtures that construct the result literal still compile. */
  readonly view_as_visitor?: ViewAsVisitorPanel;
}

export interface ReceptionEndpointCreateInput {
  readonly kind: ReceptionEndpointKind;
  readonly packet_declaration: PacketDeclaration;
  readonly expires_at?: number | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** REQUIRED per Pass-3. Substrate-validates the hash against canonical
   *  serialization of `{ kind, packet_declaration, expires_at?, metadata? }`. */
  readonly preview_hash: string;
}

export interface ReceptionEndpointCreateResult {
  readonly endpoint_id: string;
  readonly public_locator: string;
  /** Returned ONCE. The substrate never re-surfaces the plaintext —
   *  callers must capture immediately. */
  readonly bearer_secret_once: string;
  /** Pre-assembled share URL for the kind; never re-surfaced. */
  readonly share_url_once: string;
  /** Always `false` at create per Must Hold I-1 (default off). */
  readonly enabled: boolean;
}

export type ReceptionEndpointRotateReason = 'lost_url' | 'suspected_leak' | 'hygiene';

export interface ReceptionEndpointRotateInput {
  readonly endpoint_id: string;
  readonly reason?: ReceptionEndpointRotateReason;
}

export interface ReceptionEndpointRotateResult {
  readonly bearer_secret_once: string;
  readonly share_url_once: string;
}

export interface ReceptionEndpointMutationInput {
  readonly endpoint_id: string;
}

export interface ReceptionEndpointRevokeInput {
  readonly endpoint_id: string;
  readonly reason?: string;
}

export interface ReceptionEndpointExtendInput {
  readonly endpoint_id: string;
  readonly new_expires_at: number | null;
}

export interface ReceptionEndpointAccessLogInput {
  readonly endpoint_id: string;
  readonly since?: number;
  readonly limit?: number;
}

export interface ReceptionEndpointAccessLogResult {
  readonly entries: ReadonlyArray<AccessLogEntry>;
}

export interface ReceptionEmergencyDisableAllInput {
  readonly reason?: string;
}

export interface ReceptionEmergencyDisableAllResult {
  readonly disabled_count: number;
}

// ────────────────────────────────────────────────────────────────
// D-149 P12 § A.20.5 — Abuse Inbox rpc shapes
// ────────────────────────────────────────────────────────────────

/** Rpc-side projection of a `reception_ip_block_list` row — the
 *  per-server IP block list the Abuse Inbox "Ban this IP" action
 *  appends to + the path-listener enforces. `source_ip_hash` is the
 *  endpoint-scoped HKDF hash (§ Must Hold I-9 — bans are intrinsically
 *  per-endpoint; there is no server-wide raw-IP ban surface). */
export interface ReceptionIpBlockEntry {
  readonly endpoint_id: string;
  readonly source_ip_hash: string;
  readonly blocked_at: number;
  readonly blocked_by_client_id: string;
  readonly reason: string | null;
}

export interface ReceptionAbuseInboxListInput {
  /** Lookback window start (Unix-ms). Default: `now - 7d`. */
  readonly since?: number;
  /** Max operational-access-log rows scanned. Default 5000, cap 20000. */
  readonly limit?: number;
  /** Cluster threshold for `buildAbuseInbox`. Default 3. */
  readonly cluster_threshold?: number;
}

export interface ReceptionAbuseInboxListResult {
  /** Aggregated abuse-signal clusters (per `buildAbuseInbox`). */
  readonly summary: AbuseInboxSummary;
  /** The current per-server IP block list — surfaced alongside the
   *  clusters so the Settings UX can render the ban state without a
   *  second rpc. */
  readonly blocked: ReadonlyArray<ReceptionIpBlockEntry>;
}

export interface ReceptionAbuseInboxBanIpInput {
  readonly endpoint_id: string;
  /** Endpoint-scoped HKDF source-IP hash — exactly the value an
   *  `AbuseInboxRow` surfaces. */
  readonly source_ip_hash: string;
  readonly reason?: string;
}

export interface ReceptionAbuseInboxBanIpResult {
  readonly ok: true;
  /** `false` ⇒ the `(endpoint_id, source_ip_hash)` pair was already
   *  blocked (idempotent ban). */
  readonly created: boolean;
}

export interface ReceptionAbuseInboxUnbanIpInput {
  readonly endpoint_id: string;
  readonly source_ip_hash: string;
}

export interface ReceptionAbuseInboxUnbanIpResult {
  readonly ok: true;
  /** `false` ⇒ the pair was not on the block list (idempotent unban). */
  readonly removed: boolean;
}

// ────────────────────────────────────────────────────────────────
// D-149 follow-on § A.10 — intake_form Templates browser rpc shape
// ────────────────────────────────────────────────────────────────

/** Result of `reception.template.list` — the Foundation-pack
 *  `intake_form` template manifests the server reads from the installed
 *  `recued-core/personal-organizer-foundation` pack's `templates/`
 *  directory. Resolves the D-149 Templates-browser wire question: the
 *  templates are server-side pack content, so they reach the webclient
 *  FROM the server (per D-148 § A.4 — the webclient projects
 *  server-supplied state, never bundles pack content locally). A
 *  malformed / unknown template file is skipped server-side rather than
 *  failing the whole list, so `templates` may carry fewer than the six
 *  `INTAKE_FORM_TEMPLATE_REFS` — the Settings → Reception → Templates
 *  browser projection (`buildIntakeFormTemplatesBrowserModel`) surfaces
 *  the gap via its `missing_refs` field. */
export interface ReceptionTemplateListResult {
  readonly templates: ReadonlyArray<IntakeFormTemplate>;
  /** D-151 — the non-intake config templates (`scheduling_link` +
   *  `reception_page`) read from the same Foundation pack's
   *  `config-templates/` directory. Carried alongside `templates` rather
   *  than merged into it because the two manifests have genuinely
   *  different shapes (an intake template carries a `form_definition` +
   *  `anti_spam_defaults`; a config template carries a starting per-kind
   *  config). The Settings →
   *  Reception Templates gallery renders both as cards; "Use template"
   *  opens the per-kind authoring form. A malformed / unknown file is
   *  skipped server-side, so this may carry fewer than the six closed-list
   *  `RECEPTION_CONFIG_TEMPLATE_REFS`. */
  readonly config_templates: ReadonlyArray<ReceptionConfigTemplate>;
}

// ────────────────────────────────────────────────────────────────
// D-151 P2 — intent-first Compose proposal rpc shape
// ────────────────────────────────────────────────────────────────

export const RECEPTION_COMPOSE_INTENT_TEXT_MAX = 2_000 as const;

export interface ReceptionComposeProposeInput {
  readonly intent_text: string;
  readonly voice_input?: boolean;
}

export type ReceptionComposeProposeResult = ProposedEndpointConfig;

// ────────────────────────────────────────────────────────────────
// Rpc method-name closed list (for ratchet tests + filter validators)
// ────────────────────────────────────────────────────────────────

export const RECEPTION_RPC_METHODS = [
  'reception.endpoints.list',
  'reception.endpoint.preview_draft',
  'reception.endpoint.create',
  'reception.endpoint.rotate_token',
  'reception.endpoint.enable',
  'reception.endpoint.disable',
  'reception.endpoint.revoke',
  'reception.endpoint.extend',
  'reception.endpoint.access_log',
  // D-200 Slice 6g.3 — owner-only exact intake-form/recipe authoring.
  'reception.intake_recipe_pair.get',
  'reception.intake_recipe_pair.bind',
  'reception.intake_recipe_pair.configure',
  'reception.intake_recipe_pair.clear',
  // ⛔ `reception.record.list` (D-210 step 2a) and `reception.inbox.*` are NOT here, and that
  // is the convention rather than an omission: this list is exactly what
  // `makeReceptionHandlers` serves, and a ratchet asserts the two are equal
  // (`d-200-slice6g3-intake-pair-authoring.test.ts`). Both of those live on their own slices
  // with their own deps. They are still reserved + admin-only — the MCP fence is the
  // `'reception.'` PREFIX (`MCP_RESERVED_RPC_PREFIXES`), never membership of this array.
  // D-200 Slice 6g.14 — owner-local exact-submission provider recovery.
  'reception.emergency_disable_all',
  // D-149 P4 § A.5.1 — reception_page singleton config rpcs. Read +
  // upsert the per-server singleton row's config blob; the rpc surface
  // is dedicated rather than reusing endpoint.create / extend because
  // the singleton lifecycle differs from link-style endpoints (no
  // bearer secret, no per-link expiry, no revocation — only config
  // mutation + section toggles).
  'reception.page.get',
  'reception.page.upsert',
  // D-149 P12 § A.20.5 — Abuse Inbox rpc trio. `list` aggregates recent
  // operational-access-log rows into abuse-signal clusters + returns
  // the per-server IP block list; `ban_ip` / `unban_ip` mutate the
  // block list (each emits a signed `reception.ip_blocked` /
  // `reception.ip_unblocked` audit row). Reserved-prefix-gated like
  // every other reception rpc.
  'reception.abuse_inbox.list',
  'reception.abuse_inbox.ban_ip',
  'reception.abuse_inbox.unban_ip',
  // D-149 follow-on § A.10 — Templates browser wire. `reception.template.list`
  // reads the Foundation-pack `intake_form` template manifests from the
  // installed `recued-core/personal-organizer-foundation` pack so the
  // Settings → Reception → Templates browser projects server-supplied pack
  // content (D-148 § A.4) rather than bundling it client-side. Read-only,
  // reserved-prefix-gated like every other reception rpc.
  'reception.template.list',
  // D-151 P2 — server-side intent-first Compose proposal. Runs one
  // fast-tier `ai.synthesize` through `executeRecuedRequest` with
  // empty memory/enrichment consults and returns the captured
  // `ProposedEndpointConfig` result, not the durable `RecuedPlan`.
  'reception.compose.propose',
] as const;

export type ReceptionRpcMethodName = (typeof RECEPTION_RPC_METHODS)[number];

export const RECEPTION_RPC_METHOD_SET: ReadonlySet<ReceptionRpcMethodName> = new Set(
  RECEPTION_RPC_METHODS,
);

// ────────────────────────────────────────────────────────────────
// Rpc validation error codes
// ────────────────────────────────────────────────────────────────

/** Substrate-level rpc-layer error codes raised by reception rpcs.
 *  Closed-list so the dispatcher can carry them end-to-end without
 *  fingerprinting via free-form messages. Maps to `RpcError.code`. */
export type ReceptionRpcErrorCode =
  | 'unknown_endpoint_kind'
  | 'unknown_packet_kind'
  | 'packet_kind_disallowed_for_endpoint_kind'
  | 'fields_visible_override_exceeds_ceiling'
  | 'fields_visible_unknown_field'
  | 'preview_hash_missing'
  | 'preview_hash_mismatch'
  | 'preview_hash_expired'
  | 'expires_at_in_past'
  | 'expires_at_exceeds_ceiling'
  | 'long_lived_not_permitted_for_kind'
  | 'source_query_not_object'
  | 'source_query_unknown_kind'
  | 'source_query_missing_id_field'
  | 'source_query_disallowed_for_packet'
  | 'endpoint_not_found'
  | 'endpoint_already_enabled'
  | 'endpoint_already_disabled'
  | 'endpoint_already_revoked'
  | 'endpoint_revoked_cannot_extend'
  | 'transformation_unknown'
  | 'allowed_action_unknown_for_kind'
  // D-149 P4 § A.5.1 reception_page singleton validation codes
  | 'reception_page_config_invalid'
  // D-149 P5 § A.5.2 scheduling_link metadata validation. Emitted when
  // a caller-supplied `metadata` blob (passed through endpoint.create /
  // preview_draft for kind='scheduling_link') fails
  // `validateSchedulingLinkConfig`. The detail message carries the
  // first failure's code so Mary's UX can localize the message.
  | 'scheduling_link_config_invalid'
  // D-149 P6 § A.5.3 intake_form metadata validation. Mirrors the
  // scheduling_link path — emitted when a caller-supplied `metadata`
  // blob for kind='intake_form' fails `validateIntakeFormConfig`. The
  // detail message carries the first failure's code so Mary's UX can
  // localize the message.
  | 'intake_form_config_invalid'
  // D-149 P7 § A.5.4 drop_link metadata validation. Mirrors the
  // intake_form path — emitted when a caller-supplied `metadata` blob
  // for kind='drop_link' fails `validateDropLinkConfig`. The detail
  // message carries the first failure's code so Mary's UX can
  // localize.
  | 'drop_link_config_invalid'
  // D-149 P8 § A.5.5 approval_link metadata validation. Mirrors the
  // drop_link path — emitted when a caller-supplied `metadata` blob
  // for kind='approval_link' fails `validateApprovalLinkConfig`. The
  // detail message carries the first failure's code so Mary's UX can
  // localize the message.
  | 'approval_link_config_invalid'
  // D-149 P9 § A.5.6 status_link metadata validation. Mirrors the
  // approval_link path — emitted when a caller-supplied `metadata`
  // blob for kind='status_link' fails `validateStatusLinkConfig`. The
  // detail message carries the first failure's code so Mary's UX can
  // localize the message.
  | 'status_link_config_invalid'
  // D-200 Slices 6g.3/6g.11 — exact pair authoring/source failures.
  | 'intake_recipe_pair_invalid'
  | 'intake_recipe_pair_wrong_endpoint_kind'
  | 'intake_recipe_pair_recipe_not_found'
  | 'intake_recipe_pair_recipe_invalid'
  | 'intake_recipe_pair_incompatible'
  | 'intake_recipe_pair_conflict'
  | 'intake_recipe_pair_recipe_not_editable'
  | 'intake_recipe_pair_stored_invalid'
  // D-151 P2 — intent-first Compose proposal rpc validation/errors.
  | 'compose_intent_invalid'
  | 'compose_ai_unavailable'
  | 'compose_proposal_invalid'
  | 'compose_compile_error';

export const RECEPTION_RPC_ERROR_CODES: ReadonlyArray<ReceptionRpcErrorCode> = [
  'unknown_endpoint_kind',
  'unknown_packet_kind',
  'packet_kind_disallowed_for_endpoint_kind',
  'fields_visible_override_exceeds_ceiling',
  'fields_visible_unknown_field',
  'preview_hash_missing',
  'preview_hash_mismatch',
  'preview_hash_expired',
  'expires_at_in_past',
  'expires_at_exceeds_ceiling',
  'long_lived_not_permitted_for_kind',
  'source_query_not_object',
  'source_query_unknown_kind',
  'source_query_missing_id_field',
  'source_query_disallowed_for_packet',
  'endpoint_not_found',
  'endpoint_already_enabled',
  'endpoint_already_disabled',
  'endpoint_already_revoked',
  'endpoint_revoked_cannot_extend',
  'transformation_unknown',
  'allowed_action_unknown_for_kind',
  'reception_page_config_invalid',
  'scheduling_link_config_invalid',
  'intake_form_config_invalid',
  'drop_link_config_invalid',
  'approval_link_config_invalid',
  'status_link_config_invalid',
  'intake_recipe_pair_invalid',
  'intake_recipe_pair_wrong_endpoint_kind',
  'intake_recipe_pair_recipe_not_found',
  'intake_recipe_pair_recipe_invalid',
  'intake_recipe_pair_incompatible',
  'intake_recipe_pair_conflict',
  'intake_recipe_pair_recipe_not_editable',
  'intake_recipe_pair_stored_invalid',
  'compose_intent_invalid',
  'compose_ai_unavailable',
  'compose_proposal_invalid',
  'compose_compile_error',
] as const;

export const RECEPTION_RPC_ERROR_CODE_SET: ReadonlySet<ReceptionRpcErrorCode> = new Set(
  RECEPTION_RPC_ERROR_CODES,
);

// ────────────────────────────────────────────────────────────────
// Per-endpoint-kind → packet-kind mapping
// ────────────────────────────────────────────────────────────────

/** Each reception endpoint kind binds to exactly one packet kind. The
 *  rpc layer asserts `packet_declaration.packet_kind` matches the
 *  endpoint kind via this map (mismatch → `packet_kind_disallowed_for_endpoint_kind`). */
export const RECEPTION_ENDPOINT_KIND_TO_PACKET_KIND: Readonly<
  Record<ReceptionEndpointKind, RedactedPacketKind>
> = {
  reception_page: 'reception_page_packet',
  scheduling_link: 'scheduling_link_packet',
  intake_form: 'intake_form_packet',
  drop_link: 'drop_link_packet',
  approval_link: 'approval_link_packet',
  status_link: 'status_link_packet',
} as const;
