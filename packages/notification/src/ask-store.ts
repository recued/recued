/** D-158 P0 — the durable pending-ask store (A.2).
 *
 *  `ask` is durable by construction: the pending ask, its options, and
 *  its `(handler.kind, handler.payload)` are persisted BEFORE `ask`
 *  returns, so an outstanding ask survives a server crash / restart
 *  (I-2). This file is that persistence — built, like the D-153
 *  `CommitStore`, on the generic `Collection` primitive: an in-memory
 *  collection backs tests, a SQLite collection backs the server, with
 *  no store-code change. The collection is keyed by `ask_id`.
 *
 *  `PendingAsk` rows are per-pair and never cloud-synced (D-090 /
 *  D-097). The store is small + bounded; D-158 P3 prunes terminal
 *  (`handled`) rows on a retention window.
 *
 *  Spec: D-158 § A.2 / I-2.
 */

import { isFieldQueryable, type Collection } from '@recued/storage';
import type {
  Answer,
  ChannelName,
  PendingAsk,
  PendingAskStatus,
} from './types.js';

/** The fields the block supplies to persist a fresh ask. The store
 *  owns only the lifecycle fields — `status` is forced to `'open'` and
 *  the answer fields are absent until a reply lands. `fanout_channels`
 *  IS supplied here: the close-broadcast target set is known before
 *  delivery and is persisted with the ask (see `PendingAsk`). */
export type NewPendingAsk = Omit<
  PendingAsk,
  'status' | 'answer' | 'answered_via'
>;

/** The durable pending-ask store — persistence + the lifecycle
 *  transitions of A.2. The notification block is the sole writer. */
export interface AskStore {
  /** Persist a fresh ask as `open` — written BEFORE any channel
   *  delivery, so the ask is durable the instant `ask` can fail (I-2).
   *  The caller-supplied `fanout_channels` is stored as-is (the
   *  close-broadcast set). Throws when `ask_id` is already stored (ids
   *  are minted fresh per ask). */
  create(ask: NewPendingAsk): Promise<void>;

  /** Transition `open → answered`, attaching the channel-stripped
   *  `Answer` and the `via` provenance. This single write is the dedup
   *  point (A.5) — once-only: throws when `ask_id` is unknown or the
   *  ask is not `open`. */
  recordAnswer(
    ask_id: string,
    answer: Answer,
    via: ChannelName,
  ): Promise<void>;

  /** Transition `answered → handled` once the `on_answer` handler has
   *  run to completion. Throws when `ask_id` is unknown or the ask is
   *  not `answered` — handled-capture is once-only. */
  markHandled(ask_id: string): Promise<void>;

  /** D-177 P5a — retire a still-`open` ask WITHOUT an answer (the
   *  batch-ask JOIN supersedes the prior payload version's ask with a
   *  re-rendered one). Transitions `open → handled` directly — terminal,
   *  no `answer` recorded, never re-delivered by the boot sweep. Returns
   *  `'cancelled'` on success, `'not_open'` when the ask is unknown or
   *  already past `open` (a fast answer won the race — benign: the
   *  answer dispatches to the handler, whose version guard rejects the
   *  stale payload). Never throws on state. */
  cancel(ask_id: string): Promise<'cancelled' | 'not_open'>;

  /** One ask by id, or `null` when unknown. */
  get(ask_id: string): Promise<PendingAsk | null>;

  /** Every ask in a given lifecycle state, oldest first — the read the
   *  boot sweep walks (`open` re-deliver, `answered` re-dispatch). */
  listByStatus(status: PendingAskStatus): Promise<PendingAsk[]>;

  /** Cheap count of outstanding (`open`) asks — backs the `ui`
   *  "N asks awaiting you" badge (N.9 SHOULD). */
  countOpen(): Promise<number>;
  /** Delete `handled` asks older than `before` (unix-ms on `created_at`).
   *  Returns how many rows went. The store's own header has promised this
   *  retention window since D-158 P3; until D-210 it did not exist and
   *  terminal rows accumulated forever.
   *
   *  ⛔ `handled` ONLY, never `answered`. An `answered` row is not history —
   *  it is the at-least-once retry queue: `recoverPendingAsks` re-dispatches
   *  answered-but-unhandled asks after a crash, and `checkpoint-retention`
   *  refuses to expire a checkpoint whose ask is `answered` because the
   *  answer path owns it. Deleting one drops a decision the user made
   *  (D-158 TR-4's forbidden failure). `open` is likewise untouched — that
   *  is a live decision, and its expiry is `preflight.stale_after_days`.
   *
   *  ⛔ Safe only because the decision itself now lives in the activity log
   *  (`NotificationBlockDeps.recordAnswerAudit`). Before that row existed
   *  this prune would have destroyed the ONLY record of what the user was
   *  shown, what they picked, and which channel they answered on. */
  pruneHandled(before: number): Promise<number>;
}

/** How long a `handled` ask survives before the retention sweep drops it.
 *
 *  A FIXED constant, not a Settings knob — the same call
 *  `checkpoint-retention` makes for its 24 h garbage grace: once the
 *  decision itself is in the activity log, the terminal ask row is
 *  operational residue, and deleting residue is substrate hygiene rather
 *  than a policy the owner should have to think about. (`preflight.
 *  stale_after_days` is the knob that governs a real decision — how long an
 *  UNANSWERED approval may wait.)
 *
 *  A week rather than a day for one user-facing reason: `/ask/<ask_id>`
 *  serves the honest "already answered — response recorded: X" page off
 *  this row. Past the window the same link degrades to "no longer
 *  available", which is true but less useful, so the window is the span in
 *  which re-tapping your own approval link still tells you what you chose. */
export const HANDLED_ASK_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Build an `AskStore` over a backing `Collection<PendingAsk>` keyed by
 *  `ask_id` — an in-memory collection in tests, a SQLite collection on
 *  the server. */
export const createAskStore = (
  backing: Collection<PendingAsk>,
): AskStore => {
  /** ⛔ THE READ SHAPE. `listByStatus`, `countOpen` and `pruneHandled` all ask
   *  "which rows have status X" — a question `Collection` can only answer by
   *  reading and JSON-parsing EVERY row and filtering in JS. Measured against
   *  the SQLite backing before this: `countOpen()` cost 1ms at 1k rows, 14ms at
   *  10k, 51ms at 50k. That one is not a background sweep — it backs the
   *  "N asks awaiting you" BADGE, so it is a UI read paying O(total asks).
   *
   *  A backing that can filter server-side does so (`isFieldQueryable`);
   *  everything else keeps the original full-scan path unchanged. Both paths
   *  are exercised by the test suite — a fast path covered only in production
   *  is a fast path nobody has tested.
   *
   *  ⚠ The fallback is NOT dead code to be deleted later: the in-memory
   *  collection backs every test in this package, and `packages/` may not
   *  depend on the server's SQLite backing (public-boundary rule). */
  const queryable = isFieldQueryable(backing) ? backing : undefined;
  /** Oldest-first — the boot sweep walks asks in creation order. */
  const byCreatedAsc = (a: PendingAsk, b: PendingAsk): number =>
    a.created_at - b.created_at;

  /** Load an ask the caller asserts exists; throw the store's
   *  unknown-id error otherwise. */
  const loadOrThrow = async (
    ask_id: string,
    op: string,
  ): Promise<PendingAsk> => {
    const existing = await backing.get(ask_id);
    if (existing === null) {
      throw new Error(`AskStore.${op}: ask_id "${ask_id}" not found`);
    }
    return existing;
  };

  return {
    async create(ask) {
      if (await backing.has(ask.ask_id)) {
        throw new Error(
          `AskStore.create: ask_id "${ask.ask_id}" already stored `
            + `(create is once-only per ask)`,
        );
      }
      const row: PendingAsk = { ...ask, status: 'open' };
      await backing.set(ask.ask_id, row);
    },

    async recordAnswer(ask_id, answer, via) {
      const existing = await loadOrThrow(ask_id, 'recordAnswer');
      if (existing.status !== 'open') {
        throw new Error(
          `AskStore.recordAnswer: ask_id "${ask_id}" is "${existing.status}", `
            + `not "open" (the open → answered write is once-only — A.5 dedup)`,
        );
      }
      await backing.set(ask_id, {
        ...existing,
        status: 'answered',
        answer,
        answered_via: via,
      });
    },

    async markHandled(ask_id) {
      const existing = await loadOrThrow(ask_id, 'markHandled');
      if (existing.status !== 'answered') {
        throw new Error(
          `AskStore.markHandled: ask_id "${ask_id}" is "${existing.status}", `
            + `not "answered"`,
        );
      }
      await backing.set(ask_id, { ...existing, status: 'handled' });
    },

    async cancel(ask_id) {
      const existing = await backing.get(ask_id);
      if (existing === null || existing.status !== 'open') return 'not_open';
      await backing.set(ask_id, { ...existing, status: 'handled' });
      return 'cancelled';
    },

    get(ask_id) {
      return backing.get(ask_id);
    },

    async listByStatus(status) {
      const matching = queryable
        ? await queryable.queryByField({ equals: { status } })
        : (await backing.list()).filter((a) => a.status === status);
      // Sorted HERE in both paths, not in SQL: `byCreatedAsc` is the boot
      // sweep's contract and must not depend on which backing is underneath.
      return [...matching].sort(byCreatedAsc);
    },

    async countOpen() {
      if (queryable) return queryable.countByField({ equals: { status: 'open' } });
      const all = await backing.list();
      return all.reduce((n, a) => (a.status === 'open' ? n + 1 : n), 0);
    },

    async pruneHandled(before) {
      // ⛔ BOTH PREDICATES TRAVEL TOGETHER. The status check is the whole
      // safety property (see the interface doc): `answered` is the retry
      // queue, `open` is a live decision. Pushing the age bound down without
      // the status bound — or vice versa — would delete either live decisions
      // or the entire handled history. They are one query, never two.
      if (queryable) {
        return queryable.deleteByField({
          equals: { status: 'handled' },
          lessThan: { field: 'created_at', value: before },
        });
      }
      const all = await backing.list();
      let removed = 0;
      for (const ask of all) {
        if (ask.status !== 'handled') continue;
        if (ask.created_at >= before) continue;
        await backing.delete(ask.ask_id);
        removed += 1;
      }
      return removed;
    },
  };
};
