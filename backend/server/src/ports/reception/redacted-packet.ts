/** D-149 P2 § A.4 — `buildReceptionPacket` wrapper over D-145's
 *  `buildRedactedPacket`.
 *
 *  Reception is the second consumer of the D-145 PB12 `redacted_packet`
 *  substrate (the first is S2S Preview). D-149 reuses the substrate's
 *  closed-list pick + per-kind transformation + audit-emit discipline
 *  wholesale; the only consumer-side differences:
 *
 *    1. Reception tokens live in `public_endpoint_registry` (HMAC-
 *       stored, presented via URL query at request time per D-149
 *       § A.18). The packet envelope MUST NOT carry the token —
 *       spec § A.4 line 536 line "never embed token in built packet;
 *       always presented separately". The wrapper strips
 *       `access_token` from the D-145 envelope before returning.
 *
 *    2. `audit_target_id` resolves to `endpoint.endpoint_id` so the
 *       `redacted_packet.built` audit row links back to the registry
 *       row that authorized the build (vs S2S Preview's per-packet
 *       audit id).
 *
 *    3. The build emits include `endpoint_id` in the audit context
 *       so per-pair operators can correlate packet builds with the
 *       endpoint registry rows.
 *
 *  P2 ships the wrapper + a minimal `ReceptionEndpointContext` shape
 *  that mirrors only the registry columns the wrapper reads. The
 *  full `PublicEndpointRegistryRow` (with packet_declaration parser
 *  + token-rotation columns) lands at P3 alongside the registry
 *  store. The wrapper deliberately takes the narrow context shape so
 *  the substrate stays decoupled from the storage layer's row type.
 *
 *  Per-kind handlers (P4-P9) call the wrapper to produce the packet
 *  they render to visitors; the wrapper is shared substrate (not a
 *  per-kind file) because the strict-pick + transform + audit emit
 *  discipline applies identically to every kind. Per-kind source-
 *  query resolution lives in `transformations/<kind>.ts`.
 *
 *  Spec: `docs/d-149-spec.md` § A.4 + § A.5. */

import {
  buildRedactedPacket,
  PACKET_FIELDS_VISIBLE,
  type BuildRedactedPacketOptions,
  type RedactedPacket,
  type RedactedPacketBuildAuditEvent,
  type RedactedPacketKind,
  type RedactedPacketRawByKind,
} from '@recued/contracts';

/** Closed-list of reception packet kinds — the subset of D-145's
 *  `RedactedPacketKind` that the reception consumer handles. Adding
 *  a new reception kind = substrate code change in `redacted-packets.ts`
 *  + adding the kind here (the build-time `Exclude<...>` constraint
 *  catches drift between the two lists). */
export type ReceptionPacketKind =
  | 'reception_page_packet'
  | 'scheduling_link_packet'
  | 'intake_form_packet'
  | 'drop_link_packet'
  | 'approval_link_packet'
  | 'status_link_packet';

export const RECEPTION_PACKET_KINDS: ReadonlyArray<ReceptionPacketKind> = [
  'reception_page_packet',
  'scheduling_link_packet',
  'intake_form_packet',
  'drop_link_packet',
  'approval_link_packet',
  'status_link_packet',
] as const;

export const RECEPTION_PACKET_KIND_SET: ReadonlySet<ReceptionPacketKind> =
  new Set(RECEPTION_PACKET_KINDS);

export const isReceptionPacketKind = (value: unknown): value is ReceptionPacketKind =>
  typeof value === 'string' &&
  RECEPTION_PACKET_KIND_SET.has(value as ReceptionPacketKind);

/** Build-time check — every entry in `ReceptionPacketKind` must be a
 *  member of `RedactedPacketKind` (the D-145 closed list). If a future
 *  edit removes a reception kind from D-145's list without removing it
 *  here, TypeScript surfaces the drift at this assignment. */
type _AssertReceptionKindsAreRedactedKinds = ReceptionPacketKind extends RedactedPacketKind
  ? true
  : never;
const _RECEPTION_KIND_TYPE_GUARD: _AssertReceptionKindsAreRedactedKinds = true;
void _RECEPTION_KIND_TYPE_GUARD;

/** Reception envelope — the D-145 `RedactedPacket<K>` minus the
 *  `access_token` field. Per spec § A.4 line 536, the token never
 *  rides the envelope at reception (tokens live in the registry).
 *
 *  `created_at` + `expires_at` + `audit_target_id` flow through
 *  unchanged from the underlying substrate. */
export type ReceptionRedactedPacket<K extends ReceptionPacketKind = ReceptionPacketKind> =
  Omit<RedactedPacket<K>, 'access_token'>;

/** Narrow context the wrapper reads from the registry. P3 lands the
 *  full `PublicEndpointRegistryRow`; for P2 the wrapper takes only the
 *  columns it actually consumes (the spec § A.4 example reads
 *  `endpoint.endpoint_id` + `endpoint.expires_at` + the kind hint
 *  used for the audit row).
 *
 *  Kept loose-but-typed so the test fixtures can produce contexts
 *  without dragging the full registry-row shape into P2. */
export interface ReceptionEndpointContext {
  readonly endpoint_id: string;
  readonly kind: ReceptionPacketKind;
  /** Unix-ms expiry stamped onto the envelope when the caller does
   *  not pass an explicit override. Mirrors the registry row's
   *  `expires_at` column. */
  readonly expires_at?: number;
  /** Optional per-pair audit context — surfaces in the
   *  `redacted_packet.built` row alongside `endpoint_id`. Closed-
   *  shape (string / number / boolean) per the D-145 substrate's
   *  audit-context contract. */
  readonly audit_context?: Readonly<Record<string, string | number | boolean>>;
}

/** D-149 § N.4 — reception consumer max TTL. `status_link` carries
 *  a 90-day hard ceiling (longest of any reception kind); other
 *  link-style kinds clamp lower at the rpc layer (drop / approval
 *  30d max). Setting the substrate's `max_ttl_ms` to 90d here lets
 *  every reception kind pass through without violating D-145's
 *  default 30d clamp. P3 wires per-kind ceilings at the registry
 *  rpc layer (the registry also rejects `expires_at` beyond the
 *  per-kind ceiling before reaching the substrate). */
export const RECEPTION_PACKET_MAX_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/** Wrapper-side options. The wrapper provides its own `now` +
 *  `randomToken` defaults so per-kind handlers don't have to wire
 *  the substrate's deterministic-clock seam by hand — the substrate
 *  still requires a token internally even though the envelope drops
 *  it (the substrate's audit row records the token's existence; we
 *  generate one and discard).
 *
 *  Pure-fn wiring matches the D-145 pattern: `now` + `randomToken`
 *  are required so tests can pin a deterministic clock + token. */
export interface BuildReceptionPacketOptions {
  /** Unix-ms now; passed straight to the substrate's `now`. */
  readonly now: number;
  /** Random-token generator. The substrate consumes a token even
   *  though the reception envelope drops it; injection lets tests
   *  pin deterministic builds. */
  readonly randomToken: () => string;
  /** Optional explicit expiry; overrides `endpoint.expires_at` when
   *  set. Clamped by the substrate to
   *  `[now + REDACTED_PACKET_MIN_TTL_MS, now + RECEPTION_PACKET_MAX_TTL_MS]`. */
  readonly expires_at?: number;
  /** D-120 audit-emit seam. Wrapper threads through to the substrate;
   *  the wrapper attaches the registry-side `endpoint_id` + kind to
   *  the audit context before the seam fires. */
  readonly emitAudit?: (event: RedactedPacketBuildAuditEvent) => string | undefined;
}

/** § A.4 — build a reception packet from raw source data + endpoint
 *  registry context. Wraps `buildRedactedPacket` to:
 *    1. Generate the substrate-required access_token via opts.randomToken
 *       (the token is consumed by the substrate audit emit; the
 *       envelope drops it before return).
 *    2. Attach `endpoint_id` + `kind` to the audit context so the
 *       per-pair audit row links back to the registry row.
 *    3. Strip `access_token` from the returned envelope per spec
 *       § A.4 line 536.
 *
 *  Throws `RedactedPacketValidationError` on bad raw input — caller
 *  surfaces to the visitor as 500 (server-side misconfiguration).
 *  The validator rejects shape-mismatches at the substrate boundary
 *  so a buggy source-query never produces a malformed packet. */
export const buildReceptionPacket = <K extends ReceptionPacketKind>(
  kind: K,
  raw: RedactedPacketRawByKind[K],
  endpoint: ReceptionEndpointContext,
  opts: BuildReceptionPacketOptions,
): ReceptionRedactedPacket<K> => {
  // The wrapper enforces kind/context consistency — the registry row's
  // kind MUST match the build kind. A mismatch is a substrate bug
  // (handler dispatching the wrong kind) — surface it as a substrate
  // validation error rather than silently building.
  if (endpoint.kind !== kind) {
    throw new ReceptionPacketValidationError(
      `endpoint.kind '${endpoint.kind}' does not match build kind '${kind}'`,
    );
  }

  const auditContext: Record<string, string | number | boolean> = {
    endpoint_id: endpoint.endpoint_id,
    packet_kind: kind,
  };
  if (endpoint.audit_context) {
    for (const [k, v] of Object.entries(endpoint.audit_context)) {
      // Reserved keys win — caller-supplied audit_context can't
      // override `endpoint_id` / `packet_kind`. The substrate's
      // audit row carries both regardless of caller-supplied
      // overrides.
      if (k === 'endpoint_id' || k === 'packet_kind') continue;
      auditContext[k] = v;
    }
  }

  const buildOpts: BuildRedactedPacketOptions = {
    now: opts.now,
    randomToken: opts.randomToken,
    // Codex review fold (2026-05-13 P1) — reception clamp is 90d
    // (status_link max ceiling). D-145's default 30d clamp would
    // reject any reception kind with an expiry between 30d and 90d.
    max_ttl_ms: RECEPTION_PACKET_MAX_TTL_MS,
    ...(opts.expires_at !== undefined
      ? { expires_at: opts.expires_at }
      : endpoint.expires_at !== undefined
        ? { expires_at: endpoint.expires_at }
        : {}),
    ...(opts.emitAudit !== undefined ? { emitAudit: opts.emitAudit } : {}),
  };

  const built = buildRedactedPacket(kind, raw, buildOpts, auditContext);

  // Strip the substrate-generated access_token per spec § A.4 line 536.
  // The reception envelope intentionally omits the field; the substrate
  // still consumes a token internally because the build emit records
  // the token's existence + the consumer-side rpc surface (P3) does
  // not exist yet to enforce omission at the build level.
  const { access_token: _accessToken, ...rest } = built;
  void _accessToken;
  // `audit_target_id` flows through from the substrate; the registry
  // row sets endpoint_id as the canonical audit pointer at P3, but at
  // P2 we override here so the wrapper-only path remains testable.
  const envelope: ReceptionRedactedPacket<K> = {
    ...(rest as Omit<RedactedPacket<K>, 'access_token'>),
    audit_target_id: built.audit_target_id ?? endpoint.endpoint_id,
  };
  return envelope;
};

/** Closed-shape error thrown when the wrapper-level invariants fail
 *  (kind mismatch / missing endpoint context). Substrate-level
 *  validation errors continue to surface as `RedactedPacketValidationError`. */
export class ReceptionPacketValidationError extends Error {
  readonly code = 'RECEPTION_PACKET_VALIDATION_ERROR' as const;
  constructor(message: string) {
    super(message);
    this.name = 'ReceptionPacketValidationError';
  }
}

/** Substrate self-check — asserts every reception kind in
 *  `RECEPTION_PACKET_KINDS` has a matching entry in the D-145
 *  `PACKET_FIELDS_VISIBLE` registry. Mirrors `assertRedactedPacketInvariants`
 *  but scoped to the reception subset; callers wire it into the boot
 *  path so registry drift surfaces immediately. */
export const assertReceptionPacketInvariants = (): void => {
  const missing: ReceptionPacketKind[] = [];
  for (const kind of RECEPTION_PACKET_KINDS) {
    const fields = PACKET_FIELDS_VISIBLE[kind];
    if (!fields || fields.length === 0) missing.push(kind);
  }
  if (missing.length > 0) {
    throw new ReceptionPacketValidationError(
      `RECEPTION_PACKET_KINDS missing PACKET_FIELDS_VISIBLE entries: ${missing.join(', ')}`,
    );
  }
};
