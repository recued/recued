/** D-198 Slice 4 — the store-backed `MemoryWriteAdapter`.
 *
 *  The AI / customer write path (§5 / §6): the `memory.write` chat tool (and,
 *  when a live caller wires it, the D-145 `memory.write` primitive) writes into
 *  the ONE `user_memory` store via `writeAuthored`, stamped `contracted_user`
 *  (§3 — the AI operating under a contract, distinct from the owner's own
 *  `user_self` webclient `#data` writes) plus the authoring session's provenance.
 *
 *  The D-145 `MemoryWriteAdapter.write(req)` interface carries NO context (the
 *  primitive calls it context-free), so the origin + session are BOUND at
 *  construction — the chat-tool dispatch builds one adapter per call from its
 *  `ChatDispatchContext`. Origin-honesty (§3 rule 1): a caller can never mint a
 *  row of another origin — the origin is set here, never read from `req`.
 *
 *  This is NOT the D-145 compose-preview registry's `memory.write` noop
 *  (`reception-rpc-handler.ts` — that path stays a deliberate no-op for authoring
 *  preview). The live write path is the chat tool over this adapter (Fork 2 = A).
 *
 *  Spec: docs/d-198-spec.md §5 / §6 + docs/d-198-build-plan.md §B Slice 4. */

import type { Actor } from '@recued/contracts';
import type { MemoryWriteAdapter } from '@recued/middleware/primitives/index.js';
import type { UserMemorySession, UserMemoryStore } from './user-memory-store.js';

export interface StoreBackedMemoryWriteAdapterOptions {
  store: UserMemoryStore;
  /** The immutable writer identity stamped on every row — `contracted_user` for
   *  the AI / customer path. Bound at construction (never from the request). */
  origin_actor: Actor;
  /** The authoring session's provenance (chat session + governing contract),
   *  bound at construction from the dispatch context. Optional. */
  session?: UserMemorySession;
}

/** Coerce the primitive's opaque `payload` into a stored text body (mirrors the
 *  `memory.create` rpc's coercion): a string rides verbatim (empty → body-less),
 *  anything else JSON-serializes, null/undefined → body-less. */
const coercePayloadBody = (payload: unknown): string | undefined => {
  if (payload === undefined || payload === null) return undefined;
  if (typeof payload === 'string') return payload.length > 0 ? payload : undefined;
  try {
    return JSON.stringify(payload);
  } catch {
    return undefined;
  }
};

export const createStoreBackedMemoryWriteAdapter = (
  options: StoreBackedMemoryWriteAdapterOptions,
): MemoryWriteAdapter => ({
  async write(request) {
    const body = coercePayloadBody(request.payload);
    const row = await options.store.writeAuthored({
      origin_actor: options.origin_actor,
      kind: request.kind,
      summary: request.summary,
      reason_code: request.reason_code,
      ...(body !== undefined ? { body } : {}),
      ...(request.event_at !== undefined ? { event_at: request.event_at } : {}),
      ...(request.provenance_entity_ids !== undefined
        && request.provenance_entity_ids.length > 0
        ? { provenance_entity_ids: request.provenance_entity_ids }
        : {}),
      ...(options.session !== undefined ? { session: options.session } : {}),
    });
    return {
      memory_id: row.memory_id,
      provenance_edges_written: row.provenance_entity_ids?.length ?? 0,
    };
  },
});
