/** D-148 § A.4.4 — server-side token-rotation emitter.
 *
 *  Orchestrator over the `ClientTokenStore.rotate()` primitive +
 *  the `EventBus.emit('token.rotated', …)` push. The emit happens
 *  BEFORE the rpc returns + BEFORE the OLD WS sees any verify
 *  failure on the next rpc — `EventBus.emit` is in-process synchronous
 *  fan-out, so the WS-server's `send` helper queues the broadcast frame
 *  onto every subscribed WS's write buffer before this function
 *  returns. The targeted client therefore receives the new bearer
 *  on the SAME WS that's about to lose auth, applies it locally
 *  (`tokenStore.wrap` + `localStore.set` + `ws.applyRotatedBearer`),
 *  and reconnects with the fresh bearer.
 *
 *  Failure modes (mapped to `RpcError` shapes the handler raises):
 *    - `not_found` — no row with `token_id` → 404.
 *    - `already_revoked` — row exists but `revoked_at` is set → 409.
 *      Rotation only makes sense on a live row; revoked tokens need
 *      a fresh pair flow, not a rotation.
 *
 *  Bus-emit failure: swallowed at the bus boundary (see
 *  `events/bus.ts` — push errors must not abort the emit chain).
 *  A swallowed push means the targeted client missed the live event;
 *  the cursor-since replay on next reconnect re-delivers it from the
 *  ring buffer. The rpc result still reflects the persisted rotation.
 */

import type { EventBus } from '../events/bus.js';
import type { ClientTokenStore } from './client-tokens.js';

export interface TokenRotationEmitter {
  /** Rotate the bearer behind `token_id`, then broadcast
   *  `token.rotated` to every paired subscriber. The bearer
   *  plaintext rides ONLY through the broadcast — the rpc result
   *  carries the public token ids + issue timestamp for the caller's
   *  audit / display surfaces, never the bearer. */
  rotate(token_id: string): Promise<RotateOutcome>;
}

export type RotateOutcome =
  | {
      ok: true;
      replaced_token_id: string;
      new_token_id: string;
      issued_at: number;
    }
  | { ok: false; reason: 'not_found' | 'already_revoked' };

export interface CreateTokenRotationEmitterOptions {
  clientTokens: ClientTokenStore;
  bus: EventBus;
}

export const createTokenRotationEmitter = (
  opts: CreateTokenRotationEmitterOptions,
): TokenRotationEmitter => {
  return {
    async rotate(token_id) {
      const result = await opts.clientTokens.rotate({ token_id });
      if (!result.ok) {
        return { ok: false, reason: result.reason };
      }
      // Emit the broadcast BEFORE returning so the bus's synchronous
      // fan-out queues the frame onto the targeted WS's write buffer
      // ahead of any subsequent verify-driven kick. The bus stamps
      // the cursor; we provide the rest of the variant.
      opts.bus.emit({
        kind: 'token.rotated',
        target_token_id: result.replaced_token_id,
        new_token_id: result.new_token_id,
        bearer: result.bearer,
        issued_at: result.issued_at,
      });
      return {
        ok: true,
        replaced_token_id: result.replaced_token_id,
        new_token_id: result.new_token_id,
        issued_at: result.issued_at,
      };
    },
  };
};
