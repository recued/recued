/** One bounded, self-sweeping single-use nonce store, shared by every public
 *  door that issues a form nonce.
 *
 *  ⛔ WHY THIS EXISTS. The D-210 launch audit's finding #9 named unbounded
 *  growth in `ask-landing-nonce-store.ts`: *"entries removed only by successful
 *  `consume`, TTL checked at consume, never swept."* That was fixed — in that
 *  ONE file. Four siblings written from the same template
 *  (`approval-link` / `drop-link` / `scheduling-link` / `intake-form`) kept the
 *  original shape, and every one of them is reachable from an UNAUTHENTICATED
 *  public endpoint. A nonce is freed only when someone POSTs; a visitor who
 *  loads a booking page and never submits, a mail scanner that previews a
 *  manage link, a crawler — each leaves an entry resident for the life of the
 *  process. Form abandonment alone makes this a monotonic leak under entirely
 *  normal traffic.
 *
 *  Fixing the cited file rather than the defect CLASS is what left them behind,
 *  so there is now exactly one implementation and the five factories are thin
 *  wrappers over it. [[feedback_complete_the_fence_dont_predict_the_default]]
 *
 *  🔑 KEYED BY THE NONCE, scope compared as a value — never
 *  `${scope}|${nonce}` as a composite key. A delimiter-sensitive key invites a
 *  scope containing the delimiter to collide with another; the manage door's
 *  scope is `__manage__:<credential_id>`, which is exactly that shape.
 *
 *  ⚠ `maxPerScope` IS OPTIONAL, AND MOST CALLERS MUST LEAVE IT UNSET. It is
 *  safe only where a scope belongs to ONE decision-maker — `ask_id` (one owner,
 *  one decision) or `__manage__:<credential_id>` (one link). The reception
 *  doors scope on `endpoint_id`, which is shared by every concurrent visitor to
 *  that page: a per-scope cap of 4 there would mean the fifth visitor loading a
 *  booking page silently evicts the first visitor's nonce and their submit
 *  fails with a 403. The GLOBAL cap is the bound for those.
 *
 *  Under a flood the global cap evicts oldest-first, which can cost a
 *  legitimate in-flight visitor their nonce (they reload and get a fresh one).
 *  That is a deliberate trade: graceful degradation of one submit beats
 *  unbounded growth taking the whole server down, and the per-IP rate limiter
 *  in front bounds how fast an attacker can drive it. */

import { randomBytes } from 'node:crypto';

const NONCE_BYTES = 24;

/** Global ceiling for a door shared by many visitors. Sized well above normal
 *  in-flight load: at the `reception_page` limit of 60 req/min against a 30-min
 *  TTL, one source sustains ~1,800 live nonces, so this holds several busy
 *  sources at once and only bites under abuse. */
export const DEFAULT_NONCE_MAX_ENTRIES = 8_192;

export interface BoundedNonceStoreOptions {
  /** How long an issued nonce stays valid. */
  readonly ttlMs: number;
  /** Global entry ceiling; oldest-first eviction past it. */
  readonly maxEntries?: number;
  /** Per-scope ceiling. OMIT for any scope shared by multiple visitors — see
   *  the header. */
  readonly maxPerScope?: number;
  /** Spend the nonce even when it was presented under the WRONG scope.
   *
   *  ⛔ EXPLICIT PER DOOR, because the two postures are both defensible and the
   *  doors genuinely disagree — this must never be decided by whichever
   *  implementation a refactor happened to share.
   *
   *  `true` (ask-landing): a presented nonce is no longer a secret, so it must
   *  not be reusable after anyone has exercised it. Safe there because an
   *  `ask_id` scope belongs to one owner and one decision.
   *
   *  `false` (default, every reception door): a cross-scope presentation is a
   *  miss that leaves the nonce usable for the scope that minted it. A visitor
   *  with two links open, a prefetch, or a stray resubmit must not be able to
   *  burn a nonce out from under the page that legitimately holds it —
   *  `d-210-reception-manage-handler` pins exactly this. */
  readonly spendOnScopeMismatch?: boolean;
}

export interface BoundedNonceStore<V> {
  /** Mint a single-use nonce bound to `scope`, carrying `value`. */
  issue(scope: string, now: number, value: V): string;
  /** Consume single-use. Returns the carried value iff the nonce was issued
   *  for `scope` AND is inside the TTL; null otherwise. */
  consume(scope: string, nonce: string, now: number): { value: V } | null;
}

export const createBoundedNonceStore = <V>(
  options: BoundedNonceStoreOptions,
): BoundedNonceStore<V> => {
  const { ttlMs } = options;
  const maxEntries = options.maxEntries ?? DEFAULT_NONCE_MAX_ENTRIES;
  const maxPerScope = options.maxPerScope;
  if (!Number.isInteger(ttlMs) || ttlMs < 1) {
    throw new Error('bounded nonce store ttlMs must be a positive integer');
  }
  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    throw new Error('bounded nonce store maxEntries must be a positive integer');
  }
  if (
    maxPerScope !== undefined
    && (!Number.isInteger(maxPerScope) || maxPerScope < 1)
  ) {
    throw new Error('bounded nonce store maxPerScope must be a positive integer');
  }

  const inner = new Map<string, { scope: string; issued_at: number; value: V }>();

  // Map iteration is insertion order and `delete` does not reorder, so the
  // first key is always the oldest live entry.
  const sweepExpired = (now: number): void => {
    for (const [nonce, entry] of inner) {
      if (now - entry.issued_at > ttlMs) inner.delete(nonce);
    }
  };

  const evictOldestForScope = (scope: string): void => {
    if (maxPerScope === undefined) return;
    let count = 0;
    for (const entry of inner.values()) {
      if (entry.scope === scope) count += 1;
    }
    while (count >= maxPerScope) {
      let removed = false;
      for (const [nonce, entry] of inner) {
        if (entry.scope === scope) {
          inner.delete(nonce);
          count -= 1;
          removed = true;
          break;
        }
      }
      if (!removed) break;
    }
  };

  const evictOldestGlobal = (): void => {
    while (inner.size >= maxEntries) {
      const oldest = inner.keys().next();
      if (oldest.done) break;
      inner.delete(oldest.value);
    }
  };

  return {
    issue(scope, now, value) {
      sweepExpired(now);
      evictOldestForScope(scope);
      evictOldestGlobal();
      let nonce: string;
      do {
        nonce = randomBytes(NONCE_BYTES).toString('hex');
      } while (inner.has(nonce));
      inner.set(nonce, { scope, issued_at: now, value });
      return nonce;
    },
    consume(scope, nonce, now) {
      sweepExpired(now);
      const entry = inner.get(nonce);
      if (entry === undefined) return null;
      if (entry.scope !== scope) {
        // See `spendOnScopeMismatch` — the doors deliberately differ here.
        if (options.spendOnScopeMismatch === true) inner.delete(nonce);
        return null;
      }
      // A right-scope presentation always spends it, expired or not.
      inner.delete(nonce);
      if (now - entry.issued_at > ttlMs) return null;
      return { value: entry.value };
    },
  };
};
