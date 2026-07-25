/** Server-side handler types — the mirror image of `Conn<R>`.
 *
 *  `Conn<R>` is for calling rpc methods. `HandlerRegistry<R, Ctx>` is
 *  for implementing them. Both are driven by the same `RpcRegistry`
 *  so a rename/reshape on one side breaks the other at compile time.
 *
 *  Design choices:
 *
 *    - Handlers return **bare** `Promise<R[M]['response']>`. Transport
 *      envelopes (server's `HandlerResult`, HTTP `{ok, data}`, …) are
 *      the dispatcher's concern, not the handler's. Handlers throw
 *      `RpcError` (or any Error) to signal failure — the dispatcher
 *      normalises it for the wire.
 *
 *    - The registry is a **partial** map: `{[M in keyof R]?: Handler}`.
 *      Not every server instance implements every method — e.g., a
 *      server without auth deps wired up simply omits `auth.*` keys.
 *      The dispatcher returns `not_configured` for missing methods.
 *      This matches how the current `ws-server.ts` gates on `*Deps`
 *      presence, but moves the check from per-case to one line.
 *
 *    - A `Ctx` param threads through every call for things the
 *      handler needs but the payload doesn't carry (auth client, the
 *      connected WS client, instance id, request id). Defaults to
 *      `unknown` so a transport that doesn't need context can ignore
 *      it.
 *
 *  Exhaustiveness: to require every method be implemented, callers
 *  can use `CompleteHandlerRegistry<R, Ctx>` (non-partial) instead.
 *  Useful for test doubles that want a TypeScript guarantee that all
 *  methods are stubbed.
 */

import type { RpcMethodSpec, RpcRequest, RpcResponse } from './types.js';

/** Single-method handler. Typed against the registry so the payload
 *  and response shapes match the wire contract exactly. */
export type RpcHandler<Req, Res, Ctx = unknown> = (
  payload: Req,
  ctx: Ctx,
) => Promise<Res>;

/** Entries are filtered to the specific `RpcMethodSpec` shape — this
 *  both excludes any `string` index signature a registry might inherit
 *  from `extends RpcRegistry` (`R[string]` resolves to
 *  `RpcMethodSpec<unknown, unknown>` which doesn't satisfy the
 *  `infer`) and keeps the handler types precisely tied to each
 *  method's declared request/response. */
export type HandlerRegistry<R, Ctx = unknown> = {
  [M in keyof R]?: R[M] extends RpcMethodSpec
    ? RpcHandler<RpcRequest<R, M>, RpcResponse<R, M>, Ctx>
    : never;
};

/** Exhaustive handler registry — every method in `R` must be
 *  implemented. TypeScript flags a missing method as a compile error. */
export type CompleteHandlerRegistry<R, Ctx = unknown> = {
  [M in keyof R]-?: R[M] extends RpcMethodSpec
    ? RpcHandler<RpcRequest<R, M>, RpcResponse<R, M>, Ctx>
    : never;
};
