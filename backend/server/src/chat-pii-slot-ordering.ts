/** D-167 — deterministic per-session alias slot ordering.
 *
 * The session alias ledger is RAM and dies with the process (C3′), while
 * `nextCounter` numbers by ALLOCATION order. So after a restart the ledger is
 * rebuilt from whichever packet runs next, and `pii.Person1` can mean Alice
 * before the restart and Danny after it. This module removes the drift by fixing
 * the numbering from the session's DURABLE rows before anything in the turn
 * allocates.
 *
 * Predates D-213: the renumbering is a D-167 property. What D-213 Track B added
 * is the substrate that makes it fixable — the per-row `{value, kind}` candidate
 * projection and an oldest-first harvest over it.
 *
 * ⚠ What is and is not at stake. Live turns were never wrong: durable rows are
 * pre-alias (P6), the chat tail is real-valued, and `restoreChatAiResult` runs in
 * the same request that allocated — so no alias ever crossed a restart boundary
 * in a resolvable position and no card could show the wrong person. The damage is
 * that `chat_egress` holds two epochs of one session using the same token for
 * different people, which silently falsifies the "align the two texts to recover
 * the mapping" property in D-213 §3.6. This is a
 * transparency/legibility fix, not a leak fix. */

import { piiEgress } from '@recued/gateway';

import type { ChatStore } from './storage/chat-store.js';

/** The live session alias ledger, named off the store that mints it (the same
 *  local alias `chat-pii-egress.ts` uses). */
type SessionLedger = ReturnType<piiEgress.SessionLedgerStore['getOrCreate']>;

/** Bounds for the ordering harvest. Deliberately the same shape as the Track B
 *  reharvest budget, and deliberately its own instance: this walk runs on EVERY
 *  turn of a fresh session (the numbering must be stable whether or not the turn
 *  recalled), so it must not consume or depend on that budget. */
export const SLOT_ORDERING_MAX_ROWS = 256;
export const SLOT_ORDERING_MAX_BYTES = 1_048_576;
export const SLOT_ORDERING_MAX_CANDIDATES = 1_024;
export const SLOT_ORDERING_MAX_MS = 250;

export interface ChatPiiSlotOrderingDeps {
  readonly store: Pick<ChatStore, 'harvestPiiSources'>;
  readonly max_rows?: number;
  readonly max_bytes?: number;
  readonly max_candidates?: number;
  readonly max_ms?: number;
}

/** Seed one session ledger's slot ordering. Idempotent and fail-open.
 *
 * ⛔ Harvests ONE session — the ledger's own — so X1 is not engaged. X1 governs
 * the PII layer reading OTHER sessions, which is why the Track B contributor
 * needs recall's authorized set; a session seeding from its own rows is the same
 * unconditional own-session read that contributor already performs first.
 *
 * ⚠ Fail-open by design. A locked vault, an absent store, or a harvest error
 * leaves the ledger unseeded, which is exactly today's behaviour — degrading to
 * the status quo, never blocking the turn. The reservation map stays empty, so a
 * later request retries; `reserveAliasSlotOrdering` then skips anything already
 * allocated rather than reassigning it. */
export const createChatPiiSlotOrderingSeeder = (
  deps: ChatPiiSlotOrderingDeps,
): ((
  ledger: SessionLedger,
  session_id: string,
) => Promise<void>) =>
  async (ledger, session_id) => {
    // Cheap pre-check: a ledger an earlier epoch already fixed must keep that
    // ordering, and re-running the harvest would be pure cost.
    if (ledger.slotReservations.size > 0) return;
    const harvest = deps.store.harvestPiiSources;
    if (harvest === undefined) return;
    let ordered: piiEgress.AliasSlotSeed[];
    try {
      const page = await harvest({
        session_id,
        max_rows: deps.max_rows ?? SLOT_ORDERING_MAX_ROWS,
        max_bytes: deps.max_bytes ?? SLOT_ORDERING_MAX_BYTES,
        max_candidates: deps.max_candidates ?? SLOT_ORDERING_MAX_CANDIDATES,
        max_ms: deps.max_ms ?? SLOT_ORDERING_MAX_MS,
      });
      // Row order, then within-row list order. `harvestPiiSources` walks
      // `ORDER BY ts ASC, message_id ASC` — the direction that keeps a
      // budget-truncated prefix STABLE as the session grows. Do not "unify" it
      // with the recall scan, which is correctly newest-first.
      ordered = page.rows.flatMap((row) =>
        row.candidates.map((candidate) => ({
          kind: candidate.kind,
          value: candidate.value,
        })),
      );
    } catch {
      return;
    }
    piiEgress.reserveAliasSlotOrdering(ledger, ordered);
  };
