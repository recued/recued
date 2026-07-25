/** D-148 § A.2.1 — server identity manager.
 *
 *  Orchestrates the lifecycle of `server_identity_key` and
 *  `publisher_identity_key` on top of a `ServerKeyStore`. P1
 *  shipped the primitives; P2 lands the boot-flow + rotation flow
 *  + the listener surface that the broadcast bus + audit log wire
 *  into.
 *
 *  Identity rotation is the load-bearing operation: rotating
 *  `server_identity_key` invalidates every existing pair-blob
 *  signature minted by the prior key (per-command BridgeAuthority
 *  signing retired in D-169 § N.3). The substrate emits a
 *  `pair.required` synthesis the broadcast bus translates into a
 *  wire event so paired clients re-pair. This module emits the
 *  *signal*; the wiring (audit emission + WS disconnect +
 *  client_token revoke) lives at the caller because each surface
 *  has its own dependency graph.
 *
 *  The pre-rotate / post-rotate listener split lets callers
 *  serialize side effects: revoke client tokens BEFORE the new key
 *  becomes the signing target so an in-flight pair-blob never sees
 *  its signature ratified post-rotate, and emit the audit row +
 *  broadcast AFTER the new key persists so the audit signature
 *  itself is over the new identity (avoids a chicken-and-egg where
 *  the audit row would otherwise be signed by the
 *  key it's announcing the death of).
 */

import {
  ed25519Sign,
  ensureServerIdentityKeys,
  generateEd25519Keypair,
  type Ed25519Keypair,
  type ServerKeyStore,
} from '../keys/index.js';

export interface IdentityRotationEvent {
  /** Rotation kind — server identity or publisher identity. */
  key_class: 'server_identity_key' | 'publisher_identity_key';
  /** Public-key fingerprint of the prior key (the one being
   *  retired). Stable id surfaced in the audit row. */
  previous_fingerprint: string;
  /** Public-key fingerprint of the new key now in effect. */
  new_fingerprint: string;
  /** Unix-ms when rotation completed. */
  rotated_at: number;
}

export interface ServerIdentityListeners {
  /** Fires AFTER the new key is persisted + the in-memory keypair
   *  reference has been swapped. Use for: audit-log emission,
   *  broadcast-bus pair.required notification, settings-page
   *  re-render. */
  onServerIdentityRotated?: (event: IdentityRotationEvent) => void;
  /** Fires AFTER the publisher identity has been rotated. Use for:
   *  marketplace re-publish trigger, audit-log emission. */
  onPublisherIdentityRotated?: (event: IdentityRotationEvent) => void;
  /** Fires BEFORE either identity rotation persists, with the
   *  previous keypair still active. Use for revoking dependent
   *  capabilities (client_tokens / pending pair-blobs / cached
   *  authority signatures) atomically against the prior key —
   *  capability revocation must NOT race the new key becoming the
   *  signing target. Throwing from this listener aborts the
   *  rotation; the prior key remains. */
  onBeforeRotate?: (event: {
    key_class: IdentityRotationEvent['key_class'];
    previous_fingerprint: string;
  }) => void | Promise<void>;
}

export interface ServerIdentity {
  /** Current server_identity_key. Always present after construction
   *  (boot ensures init). */
  serverIdentityKey(): Ed25519Keypair;
  /** Current publisher_identity_key. */
  publisherIdentityKey(): Ed25519Keypair;
  /** Sign an arbitrary payload with the server_identity_key. The
   *  caller is responsible for canonicalization. */
  signWithServerIdentity(payload: Uint8Array | string): string;
  /** Sign with the publisher_identity_key (marketplace publish flow). */
  signWithPublisherIdentity(payload: Uint8Array | string): string;
  /** Rotate the server_identity_key. Generates a new keypair,
   *  persists, fires listeners. Returns the {previous, current}
   *  pair so the caller can include both fingerprints in the audit
   *  row. */
  rotateServerIdentity(): Promise<{ previous: Ed25519Keypair; current: Ed25519Keypair }>;
  /** Adopt a pre-generated `server_identity_key`. Used by the
   *  D-148 § A.6.5 rotation engine: the engine generates the keypair
   *  itself (so it can include the new fingerprint in its
   *  `effects.recordAudit` / `effects.broadcast` calls), then hands
   *  it off here to take the rotation through the same mutex +
   *  persistence + cache-swap path that `rotateServerIdentity()`
   *  uses. Skips `onBeforeRotate` (the engine has its own pre-rotate
   *  revoke pipeline via `revokeAllPairedClients`) but fires
   *  `onServerIdentityRotated` for cache-invalidation hooks. */
  adoptServerIdentity(
    next: Ed25519Keypair,
  ): Promise<{ previous: Ed25519Keypair; current: Ed25519Keypair }>;
  /** Rotate the publisher_identity_key. Independent of server
   *  identity per I-7. */
  rotatePublisherIdentity(): Promise<{ previous: Ed25519Keypair; current: Ed25519Keypair }>;
  /** Replace the listener set. Useful for late-binding when the
   *  broadcast bus comes online after identity boot. */
  setListeners(listeners: ServerIdentityListeners): void;
}

export interface CreateServerIdentityOptions {
  store: ServerKeyStore;
  listeners?: ServerIdentityListeners;
  now?: () => number;
}

/** Build the identity manager. Idempotent on construction:
 *  ensures both keys exist (via `ensureServerIdentityKeys`) and
 *  caches the in-memory references so callers don't re-load on
 *  every sign.
 *
 *  After rotation, the in-memory cache swaps to the new keypair
 *  before listeners fire, so any listener that calls back into the
 *  identity manager sees the new key. */
export const createServerIdentity = (
  options: CreateServerIdentityOptions,
): ServerIdentity => {
  const { store } = options;
  let listeners: ServerIdentityListeners = options.listeners ?? {};
  const now = options.now ?? Date.now;

  // Boot: ensure both keys exist + cache in memory.
  let { server_identity, publisher_identity } = ensureServerIdentityKeys(store);

  // Codex P2 #5 fold — per-class rotation mutex. Concurrent calls
  // serialize on a promise chain so a second rotateServerIdentity
  // can't capture the same `previous` as a still-in-flight first
  // rotation + race past the onBeforeRotate hook. The chain holds a
  // lock-like guarantee even though JS is cooperative — if a caller
  // awaits past `onBeforeRotate`, the next rotation queues behind
  // the current one's full sign-off rather than interleaving.
  const rotationLocks: Record<IdentityRotationEvent['key_class'], Promise<void>> = {
    server_identity_key: Promise.resolve(),
    publisher_identity_key: Promise.resolve(),
  };

  const rotate = async (
    key_class: IdentityRotationEvent['key_class'],
    options: {
      /** Pre-generated keypair to adopt. When undefined, `rotate` mints
       *  a fresh keypair via `generateEd25519Keypair(key_class)`. The
       *  engine-driven `adoptServerIdentity` path passes a keypair the
       *  rotation engine already generated so its
       *  `effects.recordAudit` call can include the matching
       *  `new_fingerprint`. */
      preGenerated?: Ed25519Keypair;
      /** Skip `onBeforeRotate`. The engine-driven path runs its own
       *  pre-rotate revoke pipeline (`revokeAllPairedClients`) AFTER
       *  persistence, so the listener's pre-rotate hook is redundant
       *  + would fire twice across the engine + direct-call surfaces. */
      skipOnBeforeRotate?: boolean;
    } = {},
  ): Promise<{ previous: Ed25519Keypair; current: Ed25519Keypair }> => {
    // Wait our turn on the per-class chain. Failure of a prior
    // rotation does not propagate — each rotation's outcome is
    // independent + the chain's job is serialization, not error
    // accumulation.
    let release: () => void = () => {};
    const ticket = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previousLock = rotationLocks[key_class];
    rotationLocks[key_class] = ticket;
    try {
      await previousLock;
    } catch { /* swallow — predecessor's failure is not ours */ }

    try {
      const previous =
        key_class === 'server_identity_key' ? server_identity : publisher_identity;
      if (!options.skipOnBeforeRotate && listeners.onBeforeRotate) {
        await listeners.onBeforeRotate({
          key_class,
          previous_fingerprint: previous.public_key_fingerprint,
        });
      }
      // Re-check the active key after the async hook: if a
      // concurrent rotation slipped in (different class would not
      // affect us, but defense-in-depth) the cached fingerprint
      // would have moved.
      const stillCurrent =
        key_class === 'server_identity_key' ? server_identity : publisher_identity;
      if (stillCurrent.public_key_fingerprint !== previous.public_key_fingerprint) {
        throw new Error(
          `rotate${key_class === 'server_identity_key' ? 'Server' : 'Publisher'}Identity: ` +
          `previous key changed during onBeforeRotate (concurrent rotation)`,
        );
      }
      const current = options.preGenerated ?? generateEd25519Keypair(key_class);
      if (current.key_class !== key_class) {
        throw new Error(
          `adoptIdentity: keypair.key_class=${current.key_class} but rotate target=${key_class}`,
        );
      }
      if (key_class === 'server_identity_key') {
        store.saveServerIdentityKey(current);
        server_identity = current;
      } else {
        store.savePublisherIdentityKey(current);
        publisher_identity = current;
      }
      // Codex P2 #4 fold — fence on disk durability before
      // notifying listeners. If the store's underlying persist is
      // synchronous (in-memory) flush is a no-op; otherwise we
      // await fsync + rename so a crash between save + broadcast
      // can't leave clients chasing a key that's not on disk.
      if (store.flush) await store.flush();

      const event: IdentityRotationEvent = {
        key_class,
        previous_fingerprint: previous.public_key_fingerprint,
        new_fingerprint: current.public_key_fingerprint,
        rotated_at: now(),
      };
      if (key_class === 'server_identity_key') {
        listeners.onServerIdentityRotated?.(event);
      } else {
        listeners.onPublisherIdentityRotated?.(event);
      }
      return { previous, current };
    } finally {
      release();
    }
  };

  return {
    serverIdentityKey: () => server_identity,
    publisherIdentityKey: () => publisher_identity,
    signWithServerIdentity: (payload) => ed25519Sign(server_identity, payload),
    signWithPublisherIdentity: (payload) => ed25519Sign(publisher_identity, payload),
    rotateServerIdentity: () => rotate('server_identity_key'),
    adoptServerIdentity: (next) =>
      rotate('server_identity_key', { preGenerated: next, skipOnBeforeRotate: true }),
    rotatePublisherIdentity: () => rotate('publisher_identity_key'),
    setListeners: (next) => {
      listeners = next;
    },
  };
};
