/** D-177 P5a — the durable batch-ask store (N.10).
 *
 *  One `BatchAskRecord` per open `(origin unit × ingredient × operation ×
 *  connection)` aggregation: members accumulate while `open`, the answer
 *  transitions `open → closing` guarded by the answered `payload_version`
 *  (the stale-approve guard), and `closing → answered` once the answer
 *  work (mint + per-member resume/deny + checkpoint consumption) is done.
 *  A crash between the two leaves `closing` + the recorded answer — the
 *  at-least-once answer re-dispatch proves it is the SAME answer
 *  (version + option equality) and idempotently finishes the work.
 *
 *  Built on the generic `Collection<BatchAskRecord>` primitive (the
 *  `CheckpointStore` pattern) — in-memory in tests, SQLite on the server.
 *  The store is deliberately DUMB about flow: it owns the rows, the
 *  member-id minting (seq-based — stable across payload re-renders by
 *  construction), and the guarded state transitions; liveness pruning,
 *  ask raising/cancelling, minting, and resume orchestration live in
 *  `backend/server/src/batch-approval.ts`. The Collection is async, so
 *  the read-modify-write transitions are NOT atomic at this layer — the
 *  server coordinator serializes all mutations per batch row (and the
 *  find-or-create per key), which is the same in-process-serialize +
 *  durable-state discipline the held-action registry uses.
 *
 *  SINGLE-WRITER REQUIREMENT (codex HIGH, folded as a constraint): the
 *  version-guarded `close` is a read-then-write, NOT a database-level
 *  CAS — its correctness rests on exactly ONE coordinator instance
 *  owning this store (composed once per server process inside
 *  `composeNotificationBlock`; the server is the pair's sole
 *  orchestrator, D-148). Never hand the store handle to a second
 *  mutation path. If a multi-writer deployment ever exists, `close`
 *  must become a SQLite `UPDATE … WHERE state='open' AND
 *  payload_version=?` CAS first.
 *
 *  Spec: docs/d-177-spec.md § N.10; landing order P5a. */

import type {
  BatchAskKey,
  BatchAskMember,
  BatchAskRecord,
} from '@recued/contracts';
import { batchAskKeyMatches } from '@recued/contracts';
import type { Collection } from './types.js';

/** Caller-supplied fields for a fresh member — the store mints the
 *  `member_id` (seq-based within the row). */
export type NewBatchAskMember = Omit<BatchAskMember, 'member_id'>;

/** Outcome of `close` — the version-guarded `open → closing` transition. */
export type BatchAskCloseResult =
  /** `open` ∧ version matched — transitioned to `closing`, answer
   *  recorded. `row` is the post-transition state (the member snapshot —
   *  members are frozen once the row leaves `open`). */
  | { kind: 'closed'; row: BatchAskRecord }
  /** Already `closing` / `answered` by the SAME answer (version + option
   *  equal) — an at-least-once re-dispatch finishing interrupted work.
   *  The caller redoes the (idempotent) answer work. */
  | { kind: 'reentry'; row: BatchAskRecord }
  /** Version moved (a JOIN re-rendered after this ask was raised) or a
   *  different answer already owns the row — the stale answer is
   *  rejected; the live re-rendered ask is the re-ask (N.10). */
  | { kind: 'stale' }
  | { kind: 'not_found' };

/** The durable batch-ask store. The server batch-approval coordinator is
 *  the sole caller and serializes every mutation (see module doc). */
export interface BatchAskStore {
  /** Persist a fresh `open` row (version 1) with its first member. The
   *  caller supplies the row identity + key facets; the store mints the
   *  first `member_id`. Throws on a duplicate `batch_id`. */
  create(
    row: Omit<
      BatchAskRecord,
      'state' | 'payload_version' | 'member_seq' | 'members' | 'updated_at'
    >,
    firstMember: NewBatchAskMember,
  ): Promise<BatchAskRecord>;

  /** One row by id, or `null`. */
  get(batch_id: string): Promise<BatchAskRecord | null>;

  /** The single `open` row matching every facet of `key`, or `null`.
   *  (At most one can exist — the coordinator serializes find-or-create
   *  per key.) */
  findOpenByKey(key: BatchAskKey): Promise<BatchAskRecord | null>;

  /** JOIN: append a member to an `open` row, bump `payload_version` +
   *  `member_seq`, return the updated row + the minted `member_id`.
   *  `'not_open'` when the row is unknown or has left `open` (the hold
   *  arrived after the close transition — it starts a NEW ask, N.10). */
  addMember(
    batch_id: string,
    member: NewBatchAskMember,
    now_ms: number,
  ): Promise<{ kind: 'joined'; row: BatchAskRecord; member_id: string } | { kind: 'not_open' }>;

  /** Point the row at the live `PendingAsk` for its current version.
   *  Best-effort pointer (a crash between bump and re-raise self-heals);
   *  unknown id is a silent no-op. */
  setCurrentAsk(batch_id: string, ask_id: string): Promise<void>;

  /** ROLLBACK of a just-joined member whose re-rendered ask could not be
   *  raised (codex MEDIUM fold): pop the member and restore the prior
   *  `payload_version`, so the still-live previous ask's version pin is
   *  coherent again and the joining hold falls back to a per-hold ask.
   *  Valid ONLY under the coordinator's serializer (no interleaving
   *  joins), ONLY on an `open` row, and ONLY for the LAST-appended
   *  member — anything else is a no-op returning `'not_rolled_back'`
   *  (fail safe: an impossible rollback leaves the row to the
   *  self-healing paths). `member_seq` is never rewound — member ids are
   *  never reused. */
  removeMember(
    batch_id: string,
    member_id: string,
  ): Promise<'rolled_back' | 'not_rolled_back'>;

  /** Abandon an `open` row terminally (codex MEDIUM fold — the
   *  create-path raise failure: the row exists but its v1 ask never
   *  raised, and the hold falls back to a per-hold ask; the row must not
   *  absorb future joins). `open → answered` with no answer fields.
   *  No-op on non-`open` rows / unknown ids. */
  terminalize(batch_id: string): Promise<void>;

  /** The version-guarded close (N.10): `open` ∧ `payload_version ===
   *  expected_version` → `closing`, recording `(option, version, now)`.
   *  Re-entry with the same answer → `'reentry'`. Anything else →
   *  `'stale'` / `'not_found'`. */
  close(
    batch_id: string,
    expected_version: number,
    option: string,
    now_ms: number,
  ): Promise<BatchAskCloseResult>;

  /** Terminal transition `closing → answered` once the answer work is
   *  done. Idempotent (already-`answered` is a no-op); unknown id is a
   *  silent no-op. */
  markAnswered(batch_id: string): Promise<void>;

  /** Every row, oldest `created_at` first — inspectors + tests. */
  list(): Promise<BatchAskRecord[]>;
}

/** Build a `BatchAskStore` over a backing `Collection<BatchAskRecord>`
 *  keyed by `batch_id`. */
export const createBatchAskStore = (
  backing: Collection<BatchAskRecord>,
): BatchAskStore => {
  const mintMemberId = (seq: number): string => `m${seq}`;

  return {
    async create(row, firstMember) {
      if (await backing.has(row.batch_id)) {
        throw new Error(
          `BatchAskStore: batch_id "${row.batch_id}" already exists `
            + `(create is once-only — ids are minted fresh per row)`,
        );
      }
      const member_id = mintMemberId(1);
      const fresh: BatchAskRecord = {
        ...row,
        state: 'open',
        payload_version: 1,
        member_seq: 1,
        members: [{ ...firstMember, member_id }],
        updated_at: row.created_at,
      };
      await backing.set(row.batch_id, fresh);
      return fresh;
    },

    get(batch_id) {
      return backing.get(batch_id);
    },

    async findOpenByKey(key) {
      const all = await backing.list();
      return (
        all.find((row) => row.state === 'open' && batchAskKeyMatches(row, key))
        ?? null
      );
    },

    async addMember(batch_id, member, now_ms) {
      const row = await backing.get(batch_id);
      if (row === null || row.state !== 'open') return { kind: 'not_open' };
      const seq = row.member_seq + 1;
      const member_id = mintMemberId(seq);
      const updated: BatchAskRecord = {
        ...row,
        member_seq: seq,
        payload_version: row.payload_version + 1,
        members: [...row.members, { ...member, member_id }],
        updated_at: now_ms,
      };
      await backing.set(batch_id, updated);
      return { kind: 'joined', row: updated, member_id };
    },

    async setCurrentAsk(batch_id, ask_id) {
      const row = await backing.get(batch_id);
      if (row === null) return;
      await backing.set(batch_id, { ...row, current_ask_id: ask_id });
    },

    async removeMember(batch_id, member_id) {
      const row = await backing.get(batch_id);
      if (row === null || row.state !== 'open') return 'not_rolled_back';
      const last = row.members[row.members.length - 1];
      if (last === undefined || last.member_id !== member_id) {
        return 'not_rolled_back';
      }
      // payload_version is restored alongside the pop so the prior
      // version's still-live ask pins coherently again; version 1 is the
      // floor (a one-member row's rollback is the caller's `terminalize`).
      if (row.members.length === 1 || row.payload_version <= 1) {
        return 'not_rolled_back';
      }
      const updated: BatchAskRecord = {
        ...row,
        members: row.members.slice(0, -1),
        payload_version: row.payload_version - 1,
      };
      await backing.set(batch_id, updated);
      return 'rolled_back';
    },

    async terminalize(batch_id) {
      const row = await backing.get(batch_id);
      if (row === null || row.state !== 'open') return;
      await backing.set(batch_id, { ...row, state: 'answered' });
    },

    async close(batch_id, expected_version, option, now_ms) {
      const row = await backing.get(batch_id);
      if (row === null) return { kind: 'not_found' };
      if (row.state === 'open') {
        if (row.payload_version !== expected_version) return { kind: 'stale' };
        const closed: BatchAskRecord = {
          ...row,
          state: 'closing',
          answer_option: option,
          answered_version: expected_version,
          answered_at: now_ms,
          updated_at: now_ms,
        };
        await backing.set(batch_id, closed);
        return { kind: 'closed', row: closed };
      }
      // `closing` / `answered` — only the SAME answer may re-enter (the
      // at-least-once re-dispatch finishing interrupted work).
      if (
        row.answered_version === expected_version
        && row.answer_option === option
      ) {
        return { kind: 'reentry', row };
      }
      return { kind: 'stale' };
    },

    async markAnswered(batch_id) {
      const row = await backing.get(batch_id);
      if (row === null || row.state === 'answered') return;
      await backing.set(batch_id, { ...row, state: 'answered' });
    },

    async list() {
      const all = await backing.list();
      return all.sort((a, b) => a.created_at - b.created_at);
    },
  };
};
