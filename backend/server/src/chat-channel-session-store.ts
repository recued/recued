import type { SessionEntry, SessionStateStore } from '@recued/chat';
import type { ChatMessage } from '@recued/contracts';
import type { ChatStore } from './storage/chat-store.js';

/** A `SessionStateStore` whose history is hydrated from the per-pair
 *  `ChatStore` via `preload`, then read from an in-memory cache. */
export interface ChatStoreBackedSessionStateStore extends SessionStateStore {
  /** Hydrate the cache for a session from the durable ChatStore (the
   *  conversational user/assistant rows), append-ordered. Returns the
   *  loaded entries. Call before driving a stream so `history` reads are
   *  warm. */
  preload(session_id: string): Promise<readonly SessionEntry[]>;
  /** No-op retained for interface stability. This store performs no
   *  durable writes (see the module note); there is nothing to await. */
  flush(): Promise<void>;
}

const messageToSessionEntry = (message: ChatMessage): SessionEntry | null => {
  if (message.role !== 'user' && message.role !== 'assistant') {
    return null;
  }
  return {
    session_id: message.session_id,
    surface: 'chat',
    role: message.role,
    text: message.content,
    ts: message.ts,
  };
};

/** D-160 Stage 2 — a CACHE-ONLY `SessionStateStore` over the ChatStore.
 *
 *  `append` writes only to the in-memory cache; it does NOT write through
 *  to the ChatStore. Durable assistant/user persistence — the fully-shaped
 *  `ChatMessage` with `tool_calls` / `provenance` / `model_used` — is
 *  owned by the chat orchestrator's RICH finalize (spec A.8 care-spot
 *  (f)). A write-through here would double-persist a lossy, defaults-
 *  filled row against that finalize. The cache exists so a stream's
 *  `history` reads stay consistent within the session; `preload` hydrates
 *  it from the durable rows the rich finalize wrote on prior turns. */
export const createChatStoreSessionStateStore = (
  chatStore: ChatStore,
): ChatStoreBackedSessionStateStore => {
  const bySession = new Map<string, SessionEntry[]>();

  const cacheAppend = (entry: SessionEntry): void => {
    const list = bySession.get(entry.session_id);
    if (list) {
      list.push(entry);
    } else {
      bySession.set(entry.session_id, [entry]);
    }
  };

  return {
    append(entry: SessionEntry): void {
      cacheAppend(entry);
    },

    history(session_id: string): readonly SessionEntry[] {
      return bySession.get(session_id) ?? [];
    },

    async preload(session_id: string): Promise<readonly SessionEntry[]> {
      // Degrade to EMPTY — never a STALE prior turn — when the durable read
      // throws. This store is long-lived across turns, and the orchestrator's
      // best-effort preload swallows this rejection (a committed user row must
      // not be stranded). A `prompt` hook that reads `ctx.history` (the D-164
      // entity prefetch) must then see an empty turn and no-op, NOT fire on the
      // last successfully-warmed turn's messages. Clearing the cache here makes
      // `history()` return [] — matching the caller's documented "degrade to an
      // unwarmed (empty) cache" intent — before re-throwing for the caller.
      const messages = await chatStore.listMessages(session_id).catch((err) => {
        bySession.delete(session_id);
        throw err;
      });
      const entries = messages.flatMap((message) => {
        const entry = messageToSessionEntry(message);
        return entry ? [entry] : [];
      });
      bySession.set(session_id, entries);
      return entries;
    },

    async flush(): Promise<void> {
      // No durable writes — the rich finalize owns ChatStore persistence.
    },
  };
};
