/** D-158 P0 — `ask_id` minting, inbound-reply matching, dedup (A.5).
 *
 *  `correlation.ts` owns the `ask_id` ↔ inbound-reply mapping. An
 *  inbound message on any channel is matched back to its pending ask by
 *  `ask_id`; the `open → answered` transition is the dedup point —
 *  first writer wins, every later reply is a no-op (I-6).
 *
 *  Because `Collection` is a `get` / `set` store with no atomic
 *  compare-and-swap, two concurrent replies for one ask (the spec's UI
 *  click + Telegram reply, A.5) could both observe `open` between an
 *  `await get` and an `await set`. The `AskSerializer` closes that gap:
 *  every reply for one `ask_id` runs strictly sequentially, so the
 *  load → status-check → write is effectively atomic. The store's
 *  `status` is then the single dedup truth — within a process via the
 *  serializer, across a restart via the persisted row itself.
 *
 *  Spec: D-158 § A.5 / I-6.
 */

import type { AskOption, PendingAsk } from './types.js';

// ────────────────────────────────────────────────────────────────
// ask_id minting
// ────────────────────────────────────────────────────────────────

/** Mint a fresh `ask_id`. UUID with the same browserless fallback
 *  shape the gateway's `mintCorrelationId` uses, so the block has no
 *  hard `crypto` dependency. `createNotificationBlock` accepts an
 *  injected minter for deterministic tests; production omits it for
 *  this default. */
export const mintAskId = (): string => {
  const g = (globalThis as {
    crypto?: {
      randomUUID?: () => string;
      getRandomValues?: <T extends ArrayBufferView>(a: T) => T;
    };
  }).crypto;
  if (typeof g?.randomUUID === 'function') return `ask-${g.randomUUID()}`;
  // ⛔ D-210 audit finding 21 — this MINTS A BEARER CAPABILITY. The value is the
  // only thing standing between a stranger and the owner's pending decision, so
  // it may never come from `Math.random()`: a recoverable PRNG stream makes every
  // future ask_id predictable from a few observed ones.
  //
  // The old comment called this a "browserless fallback", which read as harmless
  // — but the SERVER is the caller, and `engines: node >= 20` (where
  // `globalThis.crypto` is always present) is advisory metadata, not an enforced
  // guarantee. Unreachable-in-practice is not the same as safe-by-construction.
  const bytes = new Uint8Array(16);
  if (typeof g?.getRandomValues === 'function') {
    g.getRandomValues(bytes);
  } else {
    // Fail CLOSED. A caller with no CSPRNG at all cannot be handed a weak
    // capability quietly — an ask that never mints is recoverable; one minted
    // from a guessable stream is not. ⇒ [[fail_before_the_commit_when_the_failure_is_invisible_after]]
    throw new Error(
      'mintAskId: no cryptographic random source available — refusing to mint a '
      + 'guessable ask capability (Node >= 19 or any Web Crypto host is required)',
    );
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `ask-${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

// ────────────────────────────────────────────────────────────────
// inbound-reply matching
// ────────────────────────────────────────────────────────────────

/** Match an inbound reply's chosen option id against the ask's
 *  declared options. Returns the `AskOption`, or `undefined` for an
 *  option the ask never offered — an inbound reply carrying an unknown
 *  option is not a valid answer and the block drops it. */
export const selectAskOption = (
  ask: PendingAsk,
  option_id: string,
): AskOption | undefined => ask.options.find((o) => o.id === option_id);

// ────────────────────────────────────────────────────────────────
// per-ask serialization — the dedup gate
// ────────────────────────────────────────────────────────────────

/** Runs work for one `ask_id` strictly in series. Replies for
 *  *different* asks never block each other; replies for the *same* ask
 *  queue, so the block's load → dedup-check → `open → answered` write
 *  cannot interleave. */
export interface AskSerializer {
  /** Run `fn` after every prior `run` for this `ask_id` has settled.
   *  Resolves / rejects with `fn`'s own outcome. */
  run<T>(ask_id: string, fn: () => Promise<T>): Promise<T>;
}

/** Create an `AskSerializer`. Per-key promise-chain: each `run` chains
 *  onto the key's current tail and becomes the new tail; a prior
 *  failure does not block a later reply (the chain advances on both
 *  settle outcomes). A settled tail with nothing chained behind it is
 *  pruned, so a long-lived process does not accumulate one entry per
 *  ever-seen ask. */
export const createAskSerializer = (): AskSerializer => {
  const tails = new Map<string, Promise<unknown>>();
  return {
    run<T>(ask_id: string, fn: () => Promise<T>): Promise<T> {
      const prior = tails.get(ask_id) ?? Promise.resolve();
      // Chain on both outcomes — one reply rejecting must not strand
      // the next reply for the same ask behind a never-resolving tail.
      const next = prior.then(fn, fn);
      tails.set(ask_id, next);
      const prune = (): void => {
        if (tails.get(ask_id) === next) tails.delete(ask_id);
      };
      next.then(prune, prune);
      return next;
    },
  };
};
