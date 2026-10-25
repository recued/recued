/** D-231 — the recipe read `{{data.memory.<memory_id>[.field]}}`: the ROW plus its
 *  resolved body, so a recipe reads `.summary` / `.body` / `.kind` / `.origin_actor`
 *  without a second call. `get()` (not `getRow()`) because a > 64 KB body lives in
 *  CAS and the row alone carries only a preview.
 *
 *  ⚠ READ-ONLY, and there is no write path to add: the owner writes via
 *  `memory.create` / `memory.import` and the chat `memory.write` tool. A recipe that
 *  could author here would let an installed pack forge the owner's own knowledge.
 *
 *  D-198 §10 — a FORGOTTEN entry (under the redaction overlay: the owner's
 *  redaction or an agent's `memory.forget`) resolves absent, as it is absent from
 *  recall. Before §10 the read ignored the overlay, so any recipe holding a
 *  forgotten entry's id still read its content.
 *
 *  `assertScope` is the executor's namespace-scope check, run before the read and
 *  again after it, as the executor's other namespace readers do. */

import type { Collection } from '@recued/storage';
import type { MemoryRedactionRecord } from './memory-rpc-handler.js';
import type { UserMemoryStore } from './user-memory-store.js';

export const createDataMemoryLookup = (
  store: Pick<UserMemoryStore, 'get'>,
  redactions: Pick<Collection<MemoryRedactionRecord>, 'has'> | undefined,
  assertScope: () => void,
) => async (key: string): Promise<Record<string, unknown> | null> => {
  assertScope();
  if (redactions !== undefined && (await redactions.has(key))) return null;
  const resolved = await store.get(key);
  assertScope();
  if (!resolved) return null;
  return {
    ...resolved.row,
    ...(resolved.body !== undefined ? { body: resolved.body } : {}),
  };
};
