/** D-188 — the master pause on the built-in tool registry (the owner's ruling of 2026-11-08:
 *  *"schedule/arm/trigger/manual all stopped"*, and chat with them).
 *
 *  While the owner's pause holds, every call is refused before any gate or handler: a read
 *  as much as a write, on every channel (the owner's chat, an AI app over MCP, a messenger)
 *  and every tier. No chat turn starts during a pause (`chat-turn-queue.ts`), so what this
 *  meets is a turn that was already running when the owner paused, and an AI app's calls.
 *  Nothing is put to the owner either (`checkBeforeAsking`).
 *
 *  ⛔ Applied twice, because a wrapper can answer a call itself: on the raw registry, which
 *  the MCP door and every chat wrapper reach, and outermost on the chat's, whose wrappers
 *  answer `tools.search` and the enrichment topics without the raw registry. */
import type { ChatDispatchResult, InternalToolRegistry } from '@recued/contracts';

export const wrapRegistryWithPause = (
  inner: InternalToolRegistry,
  /** The words the caller reads while paused, `undefined` while the server runs. */
  pausedRefusal: (name: string) => string | undefined,
): InternalToolRegistry => {
  const refused = (name: string): ChatDispatchResult | null => {
    const detail = pausedRefusal(name);
    return detail === undefined ? null : { ok: false, reason: 'classification_blocked', detail };
  };
  return {
    ...inner,
    dispatch: async (name, args, ctx) => refused(name) ?? inner.dispatch(name, args, ctx),
    checkBeforeAsking: async (name, args, ctx) =>
      refused(name) ?? (inner.checkBeforeAsking ? inner.checkBeforeAsking(name, args, ctx) : null),
  };
};
