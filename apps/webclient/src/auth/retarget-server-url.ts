/** D-148 — change the address of a server this browser is already paired to.
 *
 *  Composes the three pieces that each exist for their own reason:
 *    1. `probeServerIdentity` — the candidate must PROVE it holds the pinned
 *       key (`auth/identity-probe.ts`).
 *    2. a re-seal of the wrapped bearer — see below.
 *    3. `store.retargetProfile` — one write carrying the new URL and the
 *       record that survives it.
 *
 *  ⛔⛔ THE RE-SEAL IS NOT OPTIONAL, AND IT IS WHY THIS MODULE EXISTS RATHER
 *  THAN A TWO-LINE CALLER. The v1 token AAD bound the ciphertext to
 *  `(token_id, server_url, server_public_key)`. Moving the URL under a v1
 *  record makes every later unwrap fail AEAD verify — the bearer is
 *  unrecoverable and the user is told to re-pair, by the very feature that
 *  promised to move them safely.
 *
 *  ⚠ THIS IS NO LONGER THE ONLY PLACE THAT RE-SEALS — and the comment said it
 *  was for three commits after it stopped being true. `onLegacyAadRecord` is now
 *  wired in `webclient-main.ts`, so a v1 record drains on its first unwrap after
 *  a release carrying that reaches the client. The re-seal HERE is still not
 *  optional: retarget moves the URL, and a v1 record whose URL moved is
 *  unrecoverable — this path cannot wait for a background drain that may not
 *  have shipped yet.
 *
 *  ⇒ Unwrap under the CURRENT address (which still opens a v1 record through
 *  the store's fallback), re-wrap under v2 (no `server_url`), and hand the new
 *  record to the same write that moves the URL. Nothing is persisted until
 *  both succeed.
 *
 *  ⚠ A profile with no stored bearer is a legitimate case (a pending or
 *  half-paired row), not an error: there is nothing to re-seal, so the URL
 *  moves alone.
 */

import { probeServerIdentity, type IdentityProbeOutcome } from './identity-probe.js';
import { decideServerUrlChange } from './server-url-change-guard.js';
import type { WebclientTokenStore } from '../storage/token-store.js';
import type { WebclientServerProfile, WebclientTokenRecord } from '@recued/contracts';

export type RetargetOutcome =
  | { readonly kind: 'saved'; readonly server_url: string }
  /** The candidate did not prove it is this server, or did not answer. */
  | { readonly kind: 'refused'; readonly probe: IdentityProbeOutcome }
  /** The address could not be parsed. */
  | { readonly kind: 'invalid_address' }
  /** Another profile already holds that address, or the id is stale. */
  | { readonly kind: 'rejected_by_store' }
  /** ⚠ The bearer could not be re-sealed. Nothing was written — the profile
   *  still points at its old address with its old record, which is the only
   *  state from which the user can still reach their server. */
  | { readonly kind: 'token_reseal_failed'; readonly reason: string };

export interface RetargetDeps {
  readonly tokenStore: WebclientTokenStore;
  readonly retarget: (
    id: string,
    next_url: string,
    next_token: WebclientTokenRecord | null,
  ) => Promise<string | null>;
  readonly fetch?: typeof globalThis.fetch;
}

/** ⛔ MAY THIS BE SAVED — the question, with none of the doing.
 *
 *  Split out because the panel's "Check address" button needs the ANSWER and
 *  must not perform the ACT. Folding the two together meant every Check
 *  unwrapped and re-wrapped the user's bearer (verified by probe: 1 unwrap,
 *  1 wrap per click) to compute a result it then threw away — credential
 *  crypto inside a read-only affordance, and a Check that could fail for a
 *  reason having nothing to do with the address.
 *
 *  Takes no `tokenStore` and writes nothing, which is the point. */
export const verifyRetargetCandidate = async (
  profile: WebclientServerProfile,
  candidateUrl: string,
  deps: { readonly fetch?: typeof globalThis.fetch },
): Promise<{ kind: 'verified' } | RetargetOutcome> => {
  const pinnedKey = profile.server_public_key;
  if (!pinnedKey) {
    // Without a pinned key there is nothing the probe could verify AGAINST, so
    // "verified" would be a word with no content. Refuse rather than fall back
    // to a liveness check wearing an identity check's name.
    return { kind: 'refused', probe: { kind: 'not_the_same_server' } };
  }

  const probe = await probeServerIdentity({
    serverUrl: candidateUrl,
    pinnedPublicKey: pinnedKey,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });

  const verdict = decideServerUrlChange({
    currentUrl: profile.server_url,
    candidateUrl,
    probe,
  });
  if (verdict.kind === 'refuse_unparseable') return { kind: 'invalid_address' };
  if (verdict.kind === 'refuse_unproven') return { kind: 'refused', probe: verdict.probe };
  return { kind: 'verified' };
};

export const retargetServerUrl = async (
  profile: WebclientServerProfile,
  candidateUrl: string,
  deps: RetargetDeps,
): Promise<RetargetOutcome> => {
  // ONE definition of "may this be saved", shared with the Check button.
  const verdict = await verifyRetargetCandidate(profile, candidateUrl, deps);
  if (verdict.kind !== 'verified') return verdict;
  const pinnedKey = profile.server_public_key!;

  // ── Re-seal, before anything is written ──────────────────────────────────
  let nextToken: WebclientTokenRecord | null = profile.webclient_token;
  if (nextToken) {
    try {
      const bearer = await deps.tokenStore.unwrap(nextToken, {
        token_id: nextToken.token_id,
        // ⚠ The OLD url — this is the AAD the record was sealed under, and
        // passing it is what lets the store's v1 fallback open a legacy row.
        server_url: profile.server_url,
        server_public_key: pinnedKey,
      });
      nextToken = await deps.tokenStore.wrap({
        token_id: nextToken.token_id,
        bearer,
        // No `server_url` — v2 omits it, which is the whole reason this
        // address can move at all. ⚠ Stating intent, not enforcing it:
        // `wrap` is structurally v2-only ("ALWAYS v2. There is no path that
        // writes a v1 seal"), so passing `server_url` here would simply be
        // ignored. Verified by mutation — adding it back reds nothing.
        aad: { token_id: nextToken.token_id, server_public_key: pinnedKey },
      });
    } catch (err) {
      return {
        kind: 'token_reseal_failed',
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  const saved = await deps.retarget(profile.id, candidateUrl, nextToken);
  if (saved === null) return { kind: 'rejected_by_store' };
  return { kind: 'saved', server_url: saved };
};
