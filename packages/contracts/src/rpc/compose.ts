/** Handler-slice composition for the server rpc registry.
 *
 *  A `HandlerSlice` is one namespace's worth of rpc handlers plus the
 *  authoritative list of methods the slice claims. `composeHandlers`
 *  merges many slices (any of which may be `undefined`, signalling
 *  "deps not wired on this server instance") into a single
 *  `HandlerRegistry` + a `wiredMethods` set.
 *
 *  Why not derive the method set from `Object.keys(handlers)`? Because
 *  the explicit `methods` tuple lets TypeScript enforce exhaustiveness
 *  on the handler map (`Pick<CompleteHandlerRegistry, M>`) and lets the
 *  runtime check for duplicate claims across slices at boot. Keyword
 *  "authoritative" — the tuple is the source of truth.
 *
 *  Pairs with the existing `SERVER_RPC_METHOD_SET` exported from
 *  `server-registry.ts`, which is the CONTRACT-side set (every method
 *  the registry declares, drives `unknown_method` 404 detection). This
 *  module builds the INSTANCE-side set (what THIS server has deps for,
 *  drives `not_configured` 501 detection). Both are passed to the
 *  dispatcher. */

import type { CompleteHandlerRegistry, HandlerRegistry } from './handler.js';
import type { RpcRegistry } from './types.js';

/** A handler cluster — the methods it claims + their implementations.
 *  Exhaustive on `M`: every method listed in `methods` MUST have a
 *  matching entry in `handlers`. TypeScript enforces this via the
 *  `Pick<CompleteHandlerRegistry<R, Ctx>, M>` shape. */
export interface HandlerSlice<
  R extends RpcRegistry,
  M extends keyof R,
  Ctx = unknown,
> {
  readonly methods: ReadonlyArray<M>;
  readonly handlers: Pick<CompleteHandlerRegistry<R, Ctx>, M>;
}

/** Identity helper — lets `make*Handlers` functions return an
 *  inferred-`M` slice without spelling the union out twice. Use
 *  `handlerSlice({ methods: [...] as const, handlers: {...} })`. The
 *  `const M extends keyof R` generic narrows `methods` to literal
 *  string keys so `handlers` is exhaustively typed. */
export const handlerSlice = <
  R extends RpcRegistry,
  const M extends keyof R,
  Ctx = unknown,
>(
  slice: HandlerSlice<R, M, Ctx>,
): HandlerSlice<R, M, Ctx> => slice;

/** Output of `composeHandlers`.
 *
 *  - `handlers` is the merged registry, ready for the dispatcher.
 *  - `wiredMethods` is the set of method names that have a handler on
 *    this server instance. Pass it to the dispatcher as the 501
 *    gating set (see `rpc-dispatcher.ts`).
 */
export interface ComposedHandlers<R extends RpcRegistry, Ctx> {
  handlers: HandlerRegistry<R, Ctx>;
  wiredMethods: ReadonlySet<keyof R>;
}

/** Type-erased slice accepted by `composeHandlers`. Each slice's
 *  exhaustiveness was already checked when it was built via
 *  `handlerSlice(...)`; the compose step only needs the merged shape. */
export type AnyHandlerSlice<R extends RpcRegistry, Ctx = unknown> = {
  readonly methods: ReadonlyArray<keyof R>;
  readonly handlers: HandlerRegistry<R, Ctx>;
};

/** Merge slices into a single handler registry.
 *
 *  - Undefined slices drop silently (the `make*Handlers(deps)` pattern
 *    returns `undefined` when deps aren't wired).
 *  - Duplicate method claims across slices throw at compose time —
 *    that's a boot-time bug, never a runtime condition.
 *  - Order of slices doesn't affect correctness but is preserved for
 *    the sake of predictable debug output. */
export const composeHandlers = <R extends RpcRegistry, Ctx = unknown>(
  slices: ReadonlyArray<AnyHandlerSlice<R, Ctx> | undefined>,
): ComposedHandlers<R, Ctx> => {
  const handlers: HandlerRegistry<R, Ctx> = {};
  const wiredMethods = new Set<keyof R>();
  for (const slice of slices) {
    if (!slice) continue;
    for (const m of slice.methods) {
      if (wiredMethods.has(m)) {
        throw new Error(
          `composeHandlers: duplicate handler claim for '${String(m)}'`,
        );
      }
      wiredMethods.add(m);
    }
    Object.assign(handlers, slice.handlers);
  }
  return { handlers, wiredMethods };
};
