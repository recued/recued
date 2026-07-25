/** D-167 P1 — chat-mode session alias-ledger store.
 *
 *  The runtime keeps one local alias ledger per active chat session. The
 *  ledger lives in pure process RAM keyed on `session_id` — the only durable
 *  D-167 scope (`AliasScope = 'session'`) — and is dropped at session close.
 *  A fresh ledger on resume is the safer privacy default: replay would
 *  re-cost tokens to regenerate the context anyway, so there is no
 *  token-savings argument for persisting it (spec §"Alias ledger").
 *
 *  The store is the chat-mode counterpart of the recipe-mode `pii-protect`
 *  run-local ledger: same `Ledger` substrate, different lifetime owner. The
 *  ledger never reaches the LLM, the cloud, or normal audit rows — only the
 *  `redaction_summary` count does (built in `egress-aliasing.ts`).
 *
 *  Authored INERT for the substrate-only P1 slice — no chat-orchestrator wires
 *  it yet (the live egress runs the orchestrator's own `executeAiCall`, not
 *  the D-160 middleware pipeline; D-164 P6.0 (b)). The seam is ready for the
 *  wiring follow-on.
 *
 *  Spec: docs/d-167-spec.md §"Alias ledger", §"Runtime flow".
 */

import { createLedger, type Ledger } from '@recued/transforms';

export interface SessionLedgerStore {
  /** The session's ledger, created on first use. Cross-packet alignment
   *  within a session falls out of reusing the same ledger: a later packet
   *  that pulls the same `owner_email` reuses `m1@d1.invalid` rather than
   *  allocating a fresh alias (spec §"Ledger persistence across packets"). */
  getOrCreate(session_id: string): Ledger;
  /** The session's ledger if one exists; undefined before first use or after
   *  `drop`. Restore paths read through here — an unknown session has no
   *  ledger, so aliases pass through unchanged (comfort-layer fail-open). */
  get(session_id: string): Ledger | undefined;
  /** Purge a session's ledger at session close. Idempotent. */
  drop(session_id: string): void;
  /** Count of live ledgers — diagnostics / tests only. */
  size(): number;
}

/** In-memory session-ledger store. Process-local, never persisted, never
 *  synced (D-097). One per chat substrate instance. */
export const createSessionLedgerStore = (): SessionLedgerStore => {
  const ledgers = new Map<string, Ledger>();
  return {
    getOrCreate(session_id: string): Ledger {
      const existing = ledgers.get(session_id);
      if (existing) return existing;
      const fresh = createLedger(session_id);
      ledgers.set(session_id, fresh);
      return fresh;
    },
    get(session_id: string): Ledger | undefined {
      return ledgers.get(session_id);
    },
    drop(session_id: string): void {
      ledgers.delete(session_id);
    },
    size(): number {
      return ledgers.size;
    },
  };
};
