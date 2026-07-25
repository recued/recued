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
 *  same-origin POST guard. Spec: docs/d-158-spec.md § P2 / A.4 / N.4. */

import { randomBytes } from 'node:crypto';

/** Form-nonce TTL — the user has 30 minutes to submit after the page loads.
 *  Matches the reception `APPROVAL_LINK_NONCE_TTL_MS`. */
export const ASK_LANDING_NONCE_TTL_MS = 30 * 60 * 1000;

const NONCE_BYTES = 24;

export interface AskLandingNonceStore {
  /** Mint a single-use nonce bound to `ask_id`, valid for the TTL window. */
  issue(ask_id: string, now: number): string;
  /** Consume the nonce (single-use — deleted on read). Returns true iff the
   *  nonce was issued for `ask_id` AND is within the TTL window. */
  consume(ask_id: string, nonce: string, now: number): boolean;
}

export const createInMemoryAskLandingNonceStore = (): AskLandingNonceStore => {
  const inner = new Map<string, number>();
  return {
    issue(ask_id, now) {
      const nonce = randomBytes(NONCE_BYTES).toString('hex');
      inner.set(`${ask_id}|${nonce}`, now);
      return nonce;
    },
    consume(ask_id, nonce, now) {
      const key = `${ask_id}|${nonce}`;
      const stamp = inner.get(key);
      if (stamp === undefined) return false;
      inner.delete(key);
      if (now - stamp > ASK_LANDING_NONCE_TTL_MS) return false;
      return true;
    },
  };
};
