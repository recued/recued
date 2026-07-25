/** D-158 P2b-ii — single-use form-nonce store for the `/ask/<ask_id>`
 *  notification ask-landing page.
 *
 *  Mirrors the reception `createInMemoryApprovalLinkNonceStore`
 *  (`ports/reception/handlers/approval-link.ts`) — in-memory, per-process,
 *  single-use, 30-minute TTL — but keyed on `ask_id` instead of
 *  `endpoint_id`. The GET render issues a nonce; the POST consumes it
 *  (delete-on-read), so a replayed or cross-origin POST without a freshly
 *  issued nonce is rejected. Keying on `ask_id` also binds the nonce to the
 *  ask it was issued for: a POST whose body `ask_id` was tampered to a
 *  different ask presents a nonce that was never issued under that id, so
 *  `consume` fails.
 *
 *  Process-scoped, like the reception nonce stores: across a restart the map
 *  is empty, so an in-flight page must be reloaded to obtain a fresh nonce.
 *  The single-use form nonce is defense-in-depth on top of the primary
 *  capability (the 122-bit `ask_id`, emailed only to the user) + the
 *  same-origin POST guard. Spec: D-158 § P2 / A.4 / N.4. */

import { createBoundedNonceStore } from './bounded-nonce-store.js';

/** Form-nonce TTL — the user has 30 minutes to submit after the page loads.
 *  Matches the reception `APPROVAL_LINK_NONCE_TTL_MS`. */
export const ASK_LANDING_NONCE_TTL_MS = 30 * 60 * 1000;

export const ASK_LANDING_NONCE_MAX_ENTRIES = 4_096;
/** Safe HERE and almost nowhere else: an `ask_id` scopes ONE owner's ONE
 *  decision, so capping concurrent renders at 4 costs nothing. The reception
 *  doors scope on `endpoint_id` — shared by every concurrent visitor — and must
 *  NOT set this. See `bounded-nonce-store.ts`. */
export const ASK_LANDING_NONCE_MAX_PER_ASK = 4;

export interface AskLandingNonceStore {
  /** Mint a single-use nonce bound to `ask_id`, valid for the TTL window. */
  issue(ask_id: string, now: number): string;
  /** Consume the nonce (single-use — deleted on read). Returns true iff the
   *  nonce was issued for `ask_id` AND is within the TTL window. */
  consume(ask_id: string, nonce: string, now: number): boolean;
}

export const createInMemoryAskLandingNonceStore = (options: {
  readonly maxEntries?: number;
  readonly maxPerAsk?: number;
} = {}): AskLandingNonceStore => {
  // One shared implementation with every other public door — the sweep + the
  // two ceilings live in `bounded-nonce-store.ts`. This file keeps only what is
  // genuinely ask-specific: the TTL, the per-ask cap, and the boolean shape.
  const store = createBoundedNonceStore<null>({
    ttlMs: ASK_LANDING_NONCE_TTL_MS,
    maxEntries: options.maxEntries ?? ASK_LANDING_NONCE_MAX_ENTRIES,
    maxPerScope: options.maxPerAsk ?? ASK_LANDING_NONCE_MAX_PER_ASK,
    // Ask-landing's own posture, preserved verbatim: a nonce presented under
    // the wrong ask is spent. The reception doors deliberately do NOT do this.
    spendOnScopeMismatch: true,
  });
  return {
    issue: (ask_id, now) => store.issue(ask_id, now, null),
    consume: (ask_id, nonce, now) => store.consume(ask_id, nonce, now) !== null,
  };
};
