/** D-148 § A.4.4 — `token.rotate` rpc handler slice.
 *
 *  Pair-rpc surface for Settings → Server → Clients "Rotate" button.
 *  Validates input, delegates to the emitter, maps failure shapes
 *  back to typed `RpcError`s.
 *
 *  Channel isolation: `token.` is in `MCP_RESERVED_RPC_PREFIXES`
 *  (see `packages/contracts/src/mcp-tool-catalog.ts`) so external
 *  MCP agents cannot reach this handler.
 */

import { RpcError } from '@recued/contracts';
import type { HandlerSlice, ServerRpcRegistry } from '@recued/contracts';

import type { WsClient } from '../ws-server.js';
import type { TokenRotationEmitter } from './token-rotation-emitter.js';

export interface TokenRotationRpcDeps {
  emitter: TokenRotationEmitter;
}

export const handleTokenRotate = async (
  deps: TokenRotationRpcDeps,
  args: { token_id: string },
): Promise<{ replaced_token_id: string; new_token_id: string; issued_at: number }> => {
  if (typeof args.token_id !== 'string' || args.token_id.length === 0) {
    throw new RpcError('bad_request', 'token.rotate: token_id must be a non-empty string', 400);
  }
  const result = await deps.emitter.rotate(args.token_id);
  if (!result.ok) {
    if (result.reason === 'not_found') {
      throw new RpcError('not_found', `token.rotate: no client_tokens row with token_id`, 404);
    }
    // already_revoked
    throw new RpcError(
      'conflict',
      `token.rotate: token is already revoked — cannot rotate a revoked token, re-pair instead`,
      409,
    );
  }
  return {
    replaced_token_id: result.replaced_token_id,
    new_token_id: result.new_token_id,
    issued_at: result.issued_at,
  };
};

export const makeTokenRotationHandlers = (
  deps: TokenRotationRpcDeps | undefined,
): HandlerSlice<ServerRpcRegistry, 'token.rotate', WsClient> | undefined => {
  if (!deps) return undefined;
  return {
    methods: ['token.rotate'],
    handlers: {
      'token.rotate': async (args) =>
        handleTokenRotate(deps, args as Parameters<typeof handleTokenRotate>[1]),
    },
  };
};
