/** D-148 § A.6.5 (multi-domain extension; FU3) — server-side per-domain
 *  two-pin rotation engine.
 *
 *  Mirrors the single-domain `RotationEngine.renewTls` flow scoped
 *  per-domain. Per spec § A.6.5 line 920: "With the `TLSDomainStore`
 *  substrate (§ A.6.3), the two-pin rotation protocol applies
 *  per-domain. Pro-managed (`pro_acme`) domains follow the auto-rotation
 *  flow; BYO-uploaded (`byo_upload`) domains rotate at user-driven
 *  re-upload time (the upload itself stages the next-fingerprint; the
 *  existing rotation event surface fires per-domain)."
 *
 *  The engine is dependency-injected — production wires the
 *  `RotationSideEffects`-shaped broadcast + audit + the
 *  `ServerIdentityHooks`-shaped key loader. Tests use in-memory hooks.
 *
 *  Substrate-then-wiring: this slice ships the engine + verifier; the
 *  rpc seam + bin.ts composition land in a follow-up alongside a
 *  production `cert_domain_rotate.*` rpc method or a per-domain hook
 *  fired from the W3.6 `SqliteTlsDomainStore.upload()` path.
 */

import {
  ed25519Sign,
  type Ed25519Keypair,
} from '../index.js';
import type {
  CertDomainRotationNotice,
  CertDomainRotationRevertedEvent,
} from '@recued/contracts';
import {
  signedBytesForCertDomainRotationNotice,
  signedBytesForCertDomainRotationReverted,
} from './cert-domain-rotation-verifier.js';

/** Default lead time between emitting the signed
 *  `cert_domain_rotation_notice` + the actual per-domain cert flip.
 *  Spec § A.6.5 calls for T-7d notice so pinned clients have time to
 *  receive + persist the next fingerprint before the active cert
 *  changes. Tests pass a small positive offset (e.g. `1`) for tight
 *  emission-side assertions; the engine rejects `<= 0` so emitted
 *  notices always carry `rotation_at > emitted_at` (the applier's
 *  freshness gate rejects `rotation_at <= now`, and a same-tick
 *  notice would round-trip as `rotation_at_in_past`). */
export const DEFAULT_DOMAIN_ROTATION_NOTICE_LEAD_MS = 7 * 24 * 60 * 60 * 1000;

/** External substrate hook — server identity key loader. Mirrors the
 *  single-domain `ServerIdentityHooks.load` slice. The engine never
 *  rotates the identity key itself; the load is the sign-time read
 *  only. */
export interface PerDomainRotationIdentityHook {
  load(): Promise<Ed25519Keypair>;
}

/** External substrate surface — per-domain broadcast + audit emit.
 *  Production wires through the realtime bus + the FU6 signing audit
 *  log; tests pass in-memory recorders. */
export interface PerDomainRotationEffects {
  /** Emit a signed `cert_domain_rotation_notice` event so pinned
   *  clients persist the next fingerprint for the named domain. */
  broadcastCertDomainRotationNotice(notice: CertDomainRotationNotice): Promise<void>;
  /** Emit a signed `cert_domain_rotation_reverted` event so pinned
   *  clients collapse the two-pin overlap back to the reverted
   *  fingerprint for the named domain. */
  broadcastCertDomainRotationReverted(
    event: CertDomainRotationRevertedEvent,
  ): Promise<void>;
  /** Record a per-domain cert rotation audit row. The substrate hands
   *  the closed-list payload; the caller maps to the
   *  `HIGH_ASSURANCE_AUDIT_KINDS` `cert_renewal` audit kind (signed
   *  with `server_identity_key` per § A.7.4). Domain travels in the
   *  payload so compliance review can scope per-domain. */
  recordAudit(payload: {
    op: 'tls_renew';
    key_class: 'tls_private_key';
    domain: string;
    rotated_at: number;
    new_fingerprint: string;
    previous_fingerprint?: string;
    triggered_by_client_id: string;
    reason?: string;
    /** Set when this audit row records a rotation REVERT rather than
     *  a forward rotation. The kind is still `cert_renewal`; the
     *  payload flag lets compliance review distinguish the two cases.
     */
    revert?: true;
  }): Promise<void>;
}

/** Clock injection. */
export type Clock = () => number;

export interface PerDomainRotationEngineOptions {
  clock?: Clock;
  server_identity: PerDomainRotationIdentityHook;
  effects: PerDomainRotationEffects;
  /** Optional override for the rotation-at lead time. Production
   *  callers leave this unset (default 7d per spec). Tests pin to 0
   *  for synchronous flip semantics OR a small offset to assert the
   *  notice's `rotation_at` math. */
  rotation_notice_lead_ms?: number;
}

/** Closed-list result shape for a successful forward rotation. */
export interface PerDomainRotationStageOk {
  ok: true;
  domain: string;
  previous_fingerprint: string;
  next_fingerprint: string;
  rotation_at: number;
  notice: CertDomainRotationNotice;
}

/** Closed-list result shape for a failed forward rotation. */
export interface PerDomainRotationStageErr {
  ok: false;
  domain: string;
  error:
    | 'invalid_domain'
    | 'invalid_fingerprint'
    | 'fingerprint_unchanged'
    /** Codex W3.FU3 P2 fold — `rotation_at_offset_ms <= 0` would emit
     *  a notice the applier deterministically rejects with
     *  `rotation_at_in_past` (the freshness gate's `<= now`). Forbid
     *  non-positive offsets at the engine boundary so emitted notices
     *  always round-trip cleanly through the applier. */
    | 'invalid_rotation_offset'
    | 'rotation_in_progress';
}

export type PerDomainRotationStageResult =
  | PerDomainRotationStageOk
  | PerDomainRotationStageErr;

/** Closed-list result shape for a successful per-domain revert. */
export interface PerDomainRotationRevertOk {
  ok: true;
  domain: string;
  reverted_to_fingerprint: string;
  reverted_at: number;
  event: CertDomainRotationRevertedEvent;
}

/** Closed-list result shape for a failed per-domain revert. */
export interface PerDomainRotationRevertErr {
  ok: false;
  domain: string;
  error:
    | 'invalid_domain'
    | 'invalid_fingerprint'
    | 'rotation_in_progress';
}

export type PerDomainRotationRevertResult =
  | PerDomainRotationRevertOk
  | PerDomainRotationRevertErr;

export interface PerDomainRotationEngine {
  /** Stage a per-domain rotation. Captures `previous_fingerprint` +
   *  `next_fingerprint` (the caller supplies both — the W3.6 store
   *  knows the previous before replace; the renewal hook produces the
   *  next), signs a `cert_domain_rotation_notice` with the current
   *  `server_identity_key`, broadcasts to pinned clients, and emits
   *  the cert_renewal audit row.
   *
   *  Substrate doesn't itself replace the cert — the caller owns the
   *  storage flip. The substrate is the rotation-event-fire side of
   *  the two-pin protocol. */
  stageDomainRotation(args: {
    domain: string;
    previous_fingerprint: string;
    next_fingerprint: string;
    triggered_by_client_id: string;
    reason?: string;
    rotation_at_offset_ms?: number;
  }): Promise<PerDomainRotationStageResult>;

  /** Revert a per-domain rotation. Emits a signed
   *  `cert_domain_rotation_reverted` event for pinned clients to roll
   *  back the two-pin overlap, and records the revert audit row.
   *  Used when the new cert proves bad post-stage (Reachability
   *  Doctor detects regression OR operator manually triggers from
   *  Settings). */
  revertDomainRotation(args: {
    domain: string;
    reverted_to_fingerprint: string;
    triggered_by_client_id: string;
    reason?: string;
  }): Promise<PerDomainRotationRevertResult>;
}

/** Lowercase + trim. Mirrors the W3.6 `canonicalizeDomain` discipline
 *  so the rotation engine treats `Alice.Example` + `alice.example`
 *  as the same row. Domains that survive trim+lowercase but are
 *  empty or contain only whitespace surface as `invalid_domain`. */
const canonicaliseDomain = (raw: string): string =>
  typeof raw === 'string' ? raw.trim().toLowerCase() : '';

const isValidFingerprint = (s: unknown): s is string =>
  typeof s === 'string' && s.length > 0;

export const createPerDomainRotationEngine = (
  opts: PerDomainRotationEngineOptions,
): PerDomainRotationEngine => {
  const clock = opts.clock ?? Date.now;
  const lead = opts.rotation_notice_lead_ms ?? DEFAULT_DOMAIN_ROTATION_NOTICE_LEAD_MS;
  // In-flight guard scoped per-domain so concurrent rotations against
  // the SAME domain serialize cleanly while DIFFERENT domains rotate
  // in parallel. Mirrors the single-domain engine's per-class guard.
  const inflight = new Set<string>();

  const guard = async <T>(
    domain: string,
    fn: () => Promise<T>,
  ): Promise<T | { rotation_in_progress: true }> => {
    if (inflight.has(domain)) {
      return { rotation_in_progress: true };
    }
    inflight.add(domain);
    try {
      return await fn();
    } finally {
      inflight.delete(domain);
    }
  };

  return {
    async stageDomainRotation(args) {
      const domain = canonicaliseDomain(args.domain);
      if (domain.length === 0) {
        return { ok: false, domain: args.domain, error: 'invalid_domain' };
      }
      if (!isValidFingerprint(args.previous_fingerprint)) {
        return { ok: false, domain, error: 'invalid_fingerprint' };
      }
      if (!isValidFingerprint(args.next_fingerprint)) {
        return { ok: false, domain, error: 'invalid_fingerprint' };
      }
      // Equal fingerprints would emit a no-op rotation notice — that
      // would confuse pinned clients (they'd persist the same
      // fingerprint as both `current` + `next`). Surface as
      // `fingerprint_unchanged` so the caller knows the renewal hook
      // didn't actually produce a new cert.
      if (args.previous_fingerprint === args.next_fingerprint) {
        return { ok: false, domain, error: 'fingerprint_unchanged' };
      }
      // Codex W3.FU3 P2 fold — guard against emitting a notice the
      // applier deterministically rejects. The applier's freshness
      // check is `rotation_at <= now` → `rotation_at_in_past`. A
      // same-tick notice (`rotation_at === emitted_at`) round-trips
      // as stale; a negative offset is structurally malformed. Reject
      // both at the engine boundary so emitters cannot produce
      // notices that no receiver can apply.
      const offset = args.rotation_at_offset_ms ?? lead;
      if (!Number.isFinite(offset) || offset <= 0) {
        return { ok: false, domain, error: 'invalid_rotation_offset' };
      }

      const outcome = await guard<PerDomainRotationStageResult>(domain, async () => {
        const emitted_at = clock();
        const rotation_at = emitted_at + offset;
        const signer = await opts.server_identity.load();
        const signed = signedBytesForCertDomainRotationNotice({
          domain,
          current_fingerprint: args.previous_fingerprint,
          next_fingerprint: args.next_fingerprint,
          rotation_at,
        });
        const signature = ed25519Sign(signer, signed);
        const notice: CertDomainRotationNotice = {
          type: 'cert_domain_rotation_notice',
          domain,
          current_fingerprint: args.previous_fingerprint,
          next_fingerprint: args.next_fingerprint,
          rotation_at,
          signature,
          signer_fingerprint: signer.public_key_fingerprint,
          emitted_at,
        };
        await opts.effects.broadcastCertDomainRotationNotice(notice);
        await opts.effects.recordAudit({
          op: 'tls_renew',
          key_class: 'tls_private_key',
          domain,
          rotated_at: rotation_at,
          new_fingerprint: args.next_fingerprint,
          previous_fingerprint: args.previous_fingerprint,
          triggered_by_client_id: args.triggered_by_client_id,
          ...(args.reason !== undefined ? { reason: args.reason } : {}),
        });
        return {
          ok: true,
          domain,
          previous_fingerprint: args.previous_fingerprint,
          next_fingerprint: args.next_fingerprint,
          rotation_at,
          notice,
        };
      });
      if ('rotation_in_progress' in outcome) {
        return { ok: false, domain, error: 'rotation_in_progress' };
      }
      return outcome;
    },

    async revertDomainRotation(args) {
      const domain = canonicaliseDomain(args.domain);
      if (domain.length === 0) {
        return { ok: false, domain: args.domain, error: 'invalid_domain' };
      }
      if (!isValidFingerprint(args.reverted_to_fingerprint)) {
        return { ok: false, domain, error: 'invalid_fingerprint' };
      }
      const outcome = await guard<PerDomainRotationRevertResult>(domain, async () => {
        const reverted_at = clock();
        const signer = await opts.server_identity.load();
        const signed = signedBytesForCertDomainRotationReverted({
          domain,
          reverted_to_fingerprint: args.reverted_to_fingerprint,
          reverted_at,
          ...(args.reason !== undefined ? { reason: args.reason } : {}),
        });
        const signature = ed25519Sign(signer, signed);
        const event: CertDomainRotationRevertedEvent = {
          type: 'cert_domain_rotation_reverted',
          domain,
          reverted_to_fingerprint: args.reverted_to_fingerprint,
          ...(args.reason !== undefined ? { reason: args.reason } : {}),
          reverted_at,
          signature,
          signer_fingerprint: signer.public_key_fingerprint,
        };
        await opts.effects.broadcastCertDomainRotationReverted(event);
        await opts.effects.recordAudit({
          op: 'tls_renew',
          key_class: 'tls_private_key',
          domain,
          rotated_at: reverted_at,
          new_fingerprint: args.reverted_to_fingerprint,
          triggered_by_client_id: args.triggered_by_client_id,
          revert: true,
          ...(args.reason !== undefined ? { reason: args.reason } : {}),
        });
        return {
          ok: true,
          domain,
          reverted_to_fingerprint: args.reverted_to_fingerprint,
          reverted_at,
          event,
        };
      });
      if ('rotation_in_progress' in outcome) {
        return { ok: false, domain, error: 'rotation_in_progress' };
      }
      return outcome;
    },
  };
};
