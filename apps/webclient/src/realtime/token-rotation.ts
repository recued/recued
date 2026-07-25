/** D-148 § A.4.4 — `token.rotated` broadcast handler.
 *
 *  Closes the credential-refresh loop. When the server rotates this
 *  client's bearer (periodic 90d hygiene, compromise alert, admin
 *  revoke + reissue, …), it emits a `token.rotated` event on the per-
 *  pair broadcast bus carrying the new plaintext bearer + the
 *  `target_token_id` discriminator. This handler:
 *
 *    1. Filters on `target_token_id === stored.token_id` — sibling
 *       clients (the user's other paired surfaces) receive the same
 *       broadcast but are no-ops here.
 *    2. Reads the active pair context (`server_url` + `server_public_key`)
 *       so it can build a fresh AAD bound to the new `token_id`.
 *    3. Calls `tokenStore.wrap()` to AES-GCM-encrypt the plaintext
 *       under the local non-extractable key. The plaintext bearer is
 *       held in a local variable for exactly this call and discarded
 *       on return; it never persists in any IDB row.
 *    4. Writes the wrapped `WebclientTokenRecord` to local storage so
 *       `resolveBearer` (DD#2 of `webclient-bootstrap.ts`) picks it up
 *       on the next reconnect.
 *    5. Calls `ws.applyRotatedBearer()` to lift the WS-client out of
 *       `reauth_required` (no-op when the WS is `connected` — the
 *       fresh bearer rides through naturally on the next reconnect).
 *
 *  Failure modes (each isolates to a stable error report; the handler
 *  never throws into the subscriber's dispatch loop):
 *
 *    - Local store read fails → onError({ stage: 'read_pair_context' }).
 *    - Pair context missing (server_url / server_public_key null) →
 *      onError({ stage: 'read_pair_context' }) + bail. This shape
 *      should not happen at runtime (bootstrap requires both), but
 *      tolerating a partial wipe-during-rotation race is cheap.
 *    - Wrap fails → onError({ stage: 'wrap' }). Indicates a key-access
 *      issue (corrupted IDB key, key revoked); next reconnect will
 *      fail to reauth_required and prompt user re-pair.
 *    - Persist fails → onError({ stage: 'persist' }). Same retry-
 *      via-reauth fallback applies.
 *
 *  Spec: D-148 § A.4.4. */

import type { WebclientLocalStore } from '../storage/local-store.js';
import { rewrapBearerForActivePair } from '../storage/rewrap-bearer.js';
import type { WebclientTokenStore } from '../storage/token-store.js';
import type { BroadcastSubscriber } from './subscriber.js';
import type { WebclientWsClient } from './ws-client.js';

/** Closed list of failure stages reported through `onError`. Keeping
 *  the discriminator typed lets callers route to per-stage telemetry
 *  / UI prompts without string-matching. */
export type TokenRotationFailureStage =
  | 'read_pair_context'
  | 'wrap'
  | 'persist';

export interface TokenRotationFailureContext {
  stage: TokenRotationFailureStage;
}

export interface CreateTokenRotationHandlerOptions {
  localStore: WebclientLocalStore;
  tokenStore: WebclientTokenStore;
  subscriber: BroadcastSubscriber;
  /** Only `applyRotatedBearer` is consumed — narrowed so tests can
   *  inject a minimal fake without simulating the full ws-client. */
  ws: Pick<WebclientWsClient, 'applyRotatedBearer'>;
  /** Best-effort failure sink. Defaults to no-op so a missing handler
   *  doesn't introduce console noise; production wires it to the audit
   *  / telemetry surface that already exists for transport errors. */
  onError?: (err: Error, context: TokenRotationFailureContext) => void;
}

export interface TokenRotationHandler {
  /** Detach the subscription. Idempotent. */
  dispose(): void;
}

export const createTokenRotationHandler = (
  options: CreateTokenRotationHandlerOptions,
): TokenRotationHandler => {
  const report = (err: unknown, stage: TokenRotationFailureStage): void => {
    if (!options.onError) return;
    const wrapped = err instanceof Error ? err : new Error(String(err));
    try {
      options.onError(wrapped, { stage });
    } catch {
      // Failure reports must never re-enter the handler — swallow.
    }
  };

  type RotationEvent = {
    target_token_id: string;
    new_token_id: string;
    bearer: string;
    issued_at: number;
  };

  const processOne = async (event: RotationEvent): Promise<void> => {
    // The sibling filter is rotation-specific (the broadcast fans out to
    // every paired surface; only the one whose stored token_id matches
    // `target_token_id` rotates) — it stays here, ahead of the shared
    // read-context → wrap → persist core. The webclient_token read also
    // gates pre-pair (no stored token → nothing to rotate).
    let stored;
    try {
      stored = await options.localStore.get('webclient_token');
    } catch (err) {
      report(err, 'read_pair_context');
      return;
    }
    if (!stored) return; // Pre-pair or just cleared — nothing to rotate.
    if (event.target_token_id !== stored.token_id) return; // Sibling.

    // Read server context, build the AAD bound to the NEW token_id, wrap the
    // fresh bearer, and persist `webclient_token` in place — the same envelope
    // the bootstrap's resolveBearer reads. `issued_at` overrides the wrap's
    // client-clock stamp with the server's authoritative issue time so
    // Settings + audit rows match the server's record.
    const result = await rewrapBearerForActivePair({
      localStore: options.localStore,
      tokenStore: options.tokenStore,
      token_id: event.new_token_id,
      bearer: event.bearer,
      issued_at: event.issued_at,
    });
    if (!result.ok) {
      report(result.error, result.stage);
      return;
    }

    // Lift the ws-client out of `reauth_required` (if it landed
    // there because the old bearer was rejected first) AND clear
    // the transport's sticky auth-block so the next open() with
    // the fresh bearer isn't rejected by the OLD WS's auth-close
    // residue (Codex P1 fold in ws-client.applyRotatedBearer).
    try {
      options.ws.applyRotatedBearer();
    } catch {
      // applyRotatedBearer is documented as non-throwing; defensive.
    }
  };

  // Codex P2 fold — serialize back-to-back rotations through a single
  // promise chain. Without this, two events firing close together
  // each start their own detached async task and race on
  // `localStore.get('webclient_token')` — the second task can read
  // the OLD token_id before the first persists the new one, then
  // drop the second event as a sibling-mismatch. Serializing through
  // `chain` guarantees each event sees the prior persist; the chain
  // is keyed to the handler instance, so multiple handler instances
  // remain independent.
  let chain: Promise<void> = Promise.resolve();

  const detach = options.subscriber.on('token.rotated', (event) => {
    chain = chain.then(() =>
      processOne({
        target_token_id: event.target_token_id,
        new_token_id: event.new_token_id,
        bearer: event.bearer,
        issued_at: event.issued_at,
      }),
    );
  });

  let disposed = false;
  return {
    dispose: () => {
      if (disposed) return;
      disposed = true;
      detach();
    },
  };
};
