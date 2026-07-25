/** D-158 P0 — the `on_answer` handler registry + answer re-dispatch (A.3).
 *
 *  `AskHandlerKind` is a closed-list slug identifying a consumer's
 *  handler. At boot each consumer calls `registerAskHandler(kind, fn)`;
 *  the block persists only `(ask_id → handler.kind, handler.payload)` —
 *  never the function. That is what lets an `ask` survive a restart:
 *  the *data* (kind + payload) is durable, the *function* is wired
 *  fresh on every boot (I-4).
 *
 *  `dispatchAnswer` is the one place an answer reaches a handler — used
 *  both live (by `submitAnswer`) and on boot (by the re-dispatch
 *  sweep). It is at-least-once by the spec's crash-recovery model: a
 *  crash between "answer recorded" and "handler ran" is recovered by
 *  re-dispatch on the next boot (A.2 boot sweep), so a handler may run
 *  again for an answer it already processed — handlers tolerate this.
 *
 *  Spec: docs/d-158-spec.md § A.3 / I-4.
 */

import type { AskStore } from './ask-store.js';
import type { AskHandlerFn, AskHandlerKind, PendingAsk } from './types.js';

/** Kind → function registry. Boot-wired: each consumer registers once,
 *  the block looks up by the persisted `handler_kind`. */
export interface HandlerRegistry {
  /** Wire a handler for a kind. Throws on a duplicate kind —
   *  registration is once-only per kind, and a second registration is
   *  a wiring bug (two consumers claiming one slug). */
  register(kind: AskHandlerKind, fn: AskHandlerFn): void;
  /** The function registered for `kind`, or `undefined` when none is —
   *  an answer for an unregistered kind stays `answered` until a boot
   *  that has the handler wired (I-4 crash-recovery). */
  get(kind: AskHandlerKind): AskHandlerFn | undefined;
}

/** Create an empty `HandlerRegistry`. */
export const createHandlerRegistry = (): HandlerRegistry => {
  const handlers = new Map<AskHandlerKind, AskHandlerFn>();
  return {
    register(kind, fn) {
      if (handlers.has(kind)) {
        throw new Error(
          `HandlerRegistry.register: handler kind "${kind}" already `
            + `registered (registration is once-only per kind)`,
        );
      }
      handlers.set(kind, fn);
    },
    get(kind) {
      return handlers.get(kind);
    },
  };
};

/** Dispatch one answered ask to its registered handler, then transition
 *  it `answered → handled`.
 *
 *  - Returns `false` without side effect when the ask is not `answered`
 *    (nothing to dispatch) or no handler is registered for its kind —
 *    in the latter case the ask stays `answered` and a later boot, with
 *    the handler wired, re-dispatches it (I-4).
 *  - The handler is invoked with the persisted `handler_payload` and
 *    the channel-stripped `Answer` only — no channel id, no channel
 *    name reaches the caller (I-10).
 *  - `markHandled` is reached only on a clean handler return: a handler
 *    that throws propagates the throw and leaves the ask `answered`, so
 *    the boot sweep retries it. */
export const dispatchAnswer = async (deps: {
  registry: HandlerRegistry;
  store: AskStore;
  ask: PendingAsk;
}): Promise<boolean> => {
  const { registry, store, ask } = deps;
  if (ask.status !== 'answered' || ask.answer === undefined) return false;
  const fn = registry.get(ask.handler_kind);
  if (fn === undefined) return false;
  await fn(ask.handler_payload, ask.answer);
  await store.markHandled(ask.ask_id);
  return true;
};
