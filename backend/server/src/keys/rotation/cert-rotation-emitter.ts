/** D-148 § A.6.5 — server-side cert.rotation_notice emitter.
 *
 *  Production bridge from the `RotationSideEffects.broadcastCert*`
 *  callbacks the rotation engine invokes after a successful TLS
 *  renewal / revert to the realtime `EventBus` every paired client
 *  subscribes to via `DEFAULT_SUBSCRIPTIONS` (D-121 Phase 6 broadcast
 *  bus).
 *
 *  Why a bridge instead of letting `renewTls` emit directly:
 *
 *    - The rotation engine is dependency-injected so tests can drive
 *      it with in-memory `RotationSideEffects` recorders. Production
 *      callers wire those callbacks to the live bus. This module
 *      provides the production wiring.
 *    - The engine substrate doesn't import the bus contract — it's
 *      shaped around the abstract emit shapes. The bridge is the
 *      single place the substrate types meet the `ServerEvent`
 *      discriminated union.
 *    - The bridge factory composes once at boot + hands its two
 *      callbacks into the rotation engine's `effects` slot. Mirrors
 *      the [[project_handover_2026_05_15_d148_token_rotate_bin_wiring_landed]]
 *      `createTokenRotationEmitter` pattern: substrate + production
 *      bridge wired separately so tests stay substrate-only.
 *
 *  Failure model: the bus's `emit` is fire-and-forget synchronous
 *  fan-out — push errors are swallowed at the bus boundary so they
 *  cannot abort the rotation flow. The notice still gets stamped onto
 *  the ring buffer, so paired clients reconnecting after a missed live
 *  event recover via cursor-since replay.
 *
 *  Sibling-event isolation: unlike `token.rotated` (which carries
 *  `target_token_id` so non-targeted siblings no-op), cert rotation
 *  has one cert per server — every paired client applies independently.
 *  The bridge does NOT filter; the bus fans out to every subscriber +
 *  the receive-side cert-pin handler decides what to persist. */

import type { EventBus } from '../../events/bus.js';

/** The two production callbacks the rotation engine expects to find
 *  on its `effects` slot. Exact shape matches
 *  `RotationSideEffects.broadcastCertRotationNotice` +
 *  `RotationSideEffects.broadcastCertRotationReverted`. */
export interface CertRotationBroadcaster {
  broadcastCertRotationNotice(args: {
    current_fingerprint: string;
    next_fingerprint: string;
    rotation_at: number;
    signature: string;
    signer_fingerprint: string;
    emitted_at: number;
  }): Promise<void>;
  broadcastCertRotationReverted(args: {
    reverted_to_fingerprint: string;
    reason?: string;
    reverted_at: number;
    signature: string;
    signer_fingerprint: string;
  }): Promise<void>;
}

export interface CertRotationBroadcasterOptions {
  bus: EventBus;
}

/** Build the production cert-rotation broadcaster. Composed in
 *  `bin.ts` once the full rotation engine is wired; the engine
 *  consumes both callbacks via its `RotationSideEffects` slot. */
export const createCertRotationBroadcaster = (
  opts: CertRotationBroadcasterOptions,
): CertRotationBroadcaster => {
  return {
    async broadcastCertRotationNotice(args) {
      opts.bus.emit({
        kind: 'cert.rotation_notice',
        current_fingerprint: args.current_fingerprint,
        next_fingerprint: args.next_fingerprint,
        rotation_at: args.rotation_at,
        signature: args.signature,
        signer_fingerprint: args.signer_fingerprint,
        emitted_at: args.emitted_at,
      });
    },
    async broadcastCertRotationReverted(args) {
      // `reason` is optional on both the substrate callback shape +
      // the `cert.rotation_reverted` ServerEvent variant. Forward
      // only when present so the ServerEvent stays clean — `reason:
      // undefined` would round-trip through the bus as a key with an
      // undefined value, which the wire serializer drops, but
      // assertions against the broadcast frame are simpler when the
      // key is absent in both cases.
      opts.bus.emit({
        kind: 'cert.rotation_reverted',
        reverted_to_fingerprint: args.reverted_to_fingerprint,
        ...(args.reason !== undefined ? { reason: args.reason } : {}),
        reverted_at: args.reverted_at,
        signature: args.signature,
        signer_fingerprint: args.signer_fingerprint,
      });
    },
  };
};
