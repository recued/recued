/** D-145 PB12 — `s2s_preview.{build,consume}` rpc handlers.
 *
 *  Wraps the substrate `buildRedactedPacket` (D-145 PB12 contracts)
 *  + the SQLite `S2SPreviewStore` to implement the S2S Preview
 *  consumer surface per § B.13.4. Two methods:
 *
 *    - `s2s_preview.build` — strict-pick raw input through the
 *      per-kind `fields_visible` closed list, run the per-kind
 *      transformation, persist under an opaque access token,
 *      emit `redacted_packet.built` D-120 audit row.
 *    - `s2s_preview.consume` — validate token shape, look up the
 *      persisted packet, check expiry, return the packet, emit
 *      `redacted_packet.accessed` D-120 audit row linking back to
 *      the build row via `audit_target_id`.
 *
 *  Errors land as `RpcError` with stable codes mapping to the
 *  closed-list `RedactedPacketValidationIssueKind` enum so callers
 *  can branch on the specific failure (invalid input vs expired
 *  token vs unknown token).
 *
 *  Spec: `docs/d-145-spec.md` § B.13.3 + § B.13.4. */

import {
  RedactedPacketValidationError,
  RpcError,
  S2S_PREVIEW_PACKET_KIND_SET,
  buildRedactedPacket,
  isPacketExpired,
  validateAccessToken,
  type HandlerSlice,
  type RedactedPacket,
  type RedactedPacketAccessAuditEvent,
  type RedactedPacketKind,
  type S2SPreviewBuildRequest,
  type S2SPreviewBuildResponse,
  type S2SPreviewConsumeRequest,
  type S2SPreviewConsumeResponse,
  type S2SPreviewPacketKind,
  type ServerRpcRegistry,
} from '@recued/contracts';
import type { AuditLogStore } from '@recued/storage';
import type { WsClient } from '../ws-server.js';
import { S2SPreviewTokenCollisionError, type S2SPreviewStore } from './store.js';

/** Substrate dependencies the rpc layer wires. Audit log is optional
 *  (omit for dbless harnesses); store is required (handler factory
 *  returns `undefined` when absent so the dispatcher reports
 *  `not_configured` rather than crashing). */
export interface S2SPreviewRpcDeps {
  store: S2SPreviewStore;
  /** Audit emitter — when wired, build emits `redacted_packet.built`
   *  + consume emits `redacted_packet.accessed`. Failures never bubble
   *  to the caller (the rpc returns the packet either way; audit is
   *  best-effort). */
  auditLog?: AuditLogStore;
  /** Wall-clock seam — production wires `Date.now`; tests inject a
   *  pinned clock. */
  now: () => number;
  /** Opaque-token generator. Production wires a CSPRNG-backed
   *  implementation (see `crypto.randomBytes(32).toString('hex')`);
   *  tests inject a deterministic stub. Returned token must be a
   *  non-empty string ≤ 256 chars (substrate validates). */
  randomToken: () => string;
  /** Maximum number of insert retries on `S2SPreviewTokenCollisionError`.
   *  CSPRNG-backed tokens make collisions astronomically unlikely;
   *  the retry budget exists so a misconfigured `randomToken` (e.g.
   *  test stub returning constants) surfaces as a clear error
   *  instead of an infinite loop. Default: 3. */
  maxTokenRetries?: number;
}

/** Token digest used as the audit row `target` so the build/access
 *  rows are queryable without exposing the raw token. SHA-256 prefix
 *  (16 hex chars) keyed on the token; the prefix is enough to link
 *  the two rows but not to recover the token. */
const tokenDigest = (token: string): string => {
  // Lazy import — only required when the audit log is wired. Tests
  // that don't exercise audit never call this path.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createHash } = require('node:crypto') as typeof import('node:crypto');
  return createHash('sha256').update(token).digest('hex').slice(0, 16);
};

/** Map a `RedactedPacketValidationError` to a stable `RpcError`. The
 *  rpc-side error code mirrors the substrate's first-issue kind so
 *  callers can branch on the specific failure. */
const mapValidationError = (e: RedactedPacketValidationError): RpcError => {
  const first = e.issues[0];
  if (!first) {
    return new RpcError(
      'redacted_packet_invalid',
      'redacted_packet validation failed without issues — this should not happen',
      400,
    );
  }
  const status =
    first.kind === 'token_expired' || first.kind === 'token_unknown' ? 410 : 400;
  return new RpcError(`redacted_packet.${first.kind}`, e.message, status);
};

/** Build with retry on token collision. Substrate's CSPRNG-backed
 *  `randomToken` makes collisions astronomically unlikely; the retry
 *  budget exists so a misconfigured generator surfaces clearly. */
const buildAndPersistWithRetry = (
  deps: S2SPreviewRpcDeps,
  packet_kind: RedactedPacketKind,
  raw: unknown,
  opts: NonNullable<S2SPreviewBuildRequest['opts']>,
): RedactedPacket => {
  const maxRetries = deps.maxTokenRetries ?? 3;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Caller-supplied access_token short-circuits retry — collision
    // on a caller-provided token is the caller's bug, not the
    // substrate's, so we surface it immediately.
    const tokenIsCallerSupplied = opts.access_token !== undefined;
    const buildOpts = {
      now: deps.now(),
      ...(opts.expires_at !== undefined ? { expires_at: opts.expires_at } : {}),
      ...(opts.access_token !== undefined ? { access_token: opts.access_token } : {}),
      randomToken: deps.randomToken,
    };
    const packet = buildRedactedPacket(
      packet_kind,
      raw as never,
      buildOpts,
      opts.context,
    );
    try {
      deps.store.put(packet);
      return packet;
    } catch (e) {
      if (e instanceof S2SPreviewTokenCollisionError) {
        if (tokenIsCallerSupplied) throw e;
        lastErr = e;
        continue;
      }
      throw e;
    }
  }
  throw lastErr ?? new Error('s2s_preview.build: token retry budget exhausted');
};

const emitAccessAudit = (
  deps: S2SPreviewRpcDeps,
  access_token: string,
  event: RedactedPacketAccessAuditEvent,
): void => {
  if (!deps.auditLog) return;
  const target = tokenDigest(access_token);
  const detail = JSON.stringify({
    packet_kind: event.packet_kind,
    fields_visible: event.fields_visible,
    accessed_at: event.accessed_at,
    ...(event.audit_target_id !== undefined ? { audit_target_id: event.audit_target_id } : {}),
    ...(event.consumer !== undefined ? { consumer: event.consumer } : {}),
  });
  void deps
    .auditLog.logActivity({
      activity_id: '',
      timestamp: deps.now(),
      action: 'redacted_packet.accessed',
      target,
      detail,
    })
    .catch(() => {
      // Best-effort.
    });
};

// ── handle s2s_preview.build ────────────────────────────────────────

export const handleS2SPreviewBuild = (
  deps: S2SPreviewRpcDeps,
  args: unknown,
): S2SPreviewBuildResponse => {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new RpcError('bad_request', 's2s_preview.build: args must be an object', 400);
  }
  const a = args as Record<string, unknown>;
  const packet_kind = a.packet_kind as RedactedPacketKind | undefined;
  if (typeof packet_kind !== 'string') {
    throw new RpcError(
      'bad_request',
      's2s_preview.build: packet_kind is required',
      400,
    );
  }
  // Codex review fold (2026-05-13 P1) — gate the S2S Preview rpc
  // against the narrow `S2S_PREVIEW_PACKET_KIND_SET`. D-149 reception
  // kinds belong exclusively to the reception consumer
  // (`buildReceptionPacket` — token-stripped envelope + registry-bound
  // endpoint context). A peer asking S2S Preview for a reception kind
  // must be rejected to prevent token-bearing envelopes for reception
  // kinds from leaving the public_endpoint_registry path. The code
  // mirrors the existing `redacted_packet.unknown_packet_kind`
  // convention so client error-handling stays uniform.
  if (!S2S_PREVIEW_PACKET_KIND_SET.has(packet_kind as S2SPreviewPacketKind)) {
    throw new RpcError(
      'redacted_packet.unknown_packet_kind',
      `s2s_preview.build: packet_kind '${packet_kind}' is not an S2S Preview kind`,
      400,
    );
  }
  const opts = (a.opts ?? {}) as NonNullable<S2SPreviewBuildRequest['opts']>;
  // Skip the substrate-level audit emit seam — the realized
  // access_token isn't known until the substrate generates it (and
  // we may retry on collision). Emit explicitly below with the
  // realized envelope so the audit row's `target = tokenDigest`
  // always references the persisted token.
  let packet: RedactedPacket;
  try {
    packet = buildAndPersistWithRetry(deps, packet_kind, a.raw, opts);
  } catch (e) {
    if (e instanceof RedactedPacketValidationError) throw mapValidationError(e);
    if (e instanceof S2SPreviewTokenCollisionError) {
      throw new RpcError(
        'redacted_packet.token_collision',
        e.message,
        409,
      );
    }
    throw e;
  }
  if (deps.auditLog) {
    const target = tokenDigest(packet.access_token);
    void deps.auditLog
      .logActivity({
        activity_id: '',
        timestamp: deps.now(),
        action: 'redacted_packet.built',
        target,
        detail: JSON.stringify({
          packet_kind: packet.packet_kind,
          fields_visible: packet.fields_visible,
          created_at: packet.created_at,
          expires_at: packet.expires_at,
          ...(opts.context !== undefined ? { context: opts.context } : {}),
        }),
      })
      .catch(() => {
        /* Best-effort — audit failure must not bubble to the caller. */
      });
  }
  return { packet };
};

// ── handle s2s_preview.consume ──────────────────────────────────────

export const handleS2SPreviewConsume = (
  deps: S2SPreviewRpcDeps,
  args: unknown,
): S2SPreviewConsumeResponse => {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new RpcError('bad_request', 's2s_preview.consume: args must be an object', 400);
  }
  const a = args as Record<string, unknown>;
  const tokenIssues = validateAccessToken(a.access_token);
  if (tokenIssues.length > 0) {
    throw mapValidationError(new RedactedPacketValidationError(tokenIssues));
  }
  const access_token = a.access_token as string;
  const consumer = typeof a.consumer === 'string' ? a.consumer : undefined;

  // Look up unfiltered so we can disambiguate `token_expired` from
  // `token_unknown`. The substrate's consume side is the authoritative
  // boundary; the rpc surfaces the closed-list error codes.
  const stored = deps.store.getRaw(access_token);
  if (!stored) {
    throw mapValidationError(
      new RedactedPacketValidationError([{ kind: 'token_unknown' }]),
    );
  }
  const now = deps.now();
  if (isPacketExpired(stored, now)) {
    throw mapValidationError(
      new RedactedPacketValidationError([{ kind: 'token_expired' }]),
    );
  }
  emitAccessAudit(deps, access_token, {
    packet_kind: stored.packet_kind,
    fields_visible: stored.fields_visible,
    accessed_at: now,
    ...(stored.audit_target_id !== undefined ? { audit_target_id: stored.audit_target_id } : {}),
    ...(consumer !== undefined ? { consumer } : {}),
  });
  return { packet: stored };
};

// ── Handler slice factory ───────────────────────────────────────────

export type S2SPreviewMethods = 's2s_preview.build' | 's2s_preview.consume';

export const makeS2SPreviewHandlers = (
  deps: S2SPreviewRpcDeps | undefined,
): HandlerSlice<ServerRpcRegistry, S2SPreviewMethods, WsClient> | undefined => {
  if (!deps) return undefined;
  return {
    methods: ['s2s_preview.build', 's2s_preview.consume'],
    handlers: {
      's2s_preview.build': async (args) => handleS2SPreviewBuild(deps, args),
      's2s_preview.consume': async (args) => handleS2SPreviewConsume(deps, args),
    },
  };
};
