/** D-160 P0 — the shared session-state store.
 *
 *  One chat-history store; every entry carries its `SurfaceTag` so a
 *  conversation begun in the webclient and continued over Telegram is
 *  one conversation seen through two windows (D-160 N.5 / A.5). The
 *  `chat` and `messenger` channels are handed the SAME store instance —
 *  that shared instance is what makes "one conversation, two windows"
 *  true.
 *
 *  P0 ships the interface + an in-memory implementation. The durable
 *  backing — a `surface` column on the existing `chat_messages` table,
 *  or a dedicated table — is the D-137-refactor-depth question D-160
 *  O-5 leaves open; the framework wiring (P1) settles it. P0 needs only
 *  the shared interface + a working in-memory backing.
 *
 *  Spec: D-160 § N.5 / A.5 / O-5.
 */

import type { SurfaceTag } from './channel.js';

/** One conversation entry. Append-only; `(session_id, ts)` orders it. */
export interface SessionEntry {
  session_id: string;
  surface: SurfaceTag;
  role: 'user' | 'assistant';
  text: string;
  ts: number;
}

/** The store both channels share. Deliberately minimal — append + read;
 *  the framework owns turn orchestration, not this leaf. */
export interface SessionStateStore {
  /** Append one entry. */
  append(entry: SessionEntry): void;
  /** Every entry for a session, in append order. */
  history(session_id: string): readonly SessionEntry[];
}

/** In-memory `SessionStateStore` — the P0 backing. */
export const createInMemorySessionStore = (): SessionStateStore => {
  const bySession = new Map<string, SessionEntry[]>();
  return {
    append(entry: SessionEntry): void {
      const list = bySession.get(entry.session_id);
      if (list) {
        list.push(entry);
      } else {
        bySession.set(entry.session_id, [entry]);
      }
    },
    history(session_id: string): readonly SessionEntry[] {
      return bySession.get(session_id) ?? [];
    },
  };
};
