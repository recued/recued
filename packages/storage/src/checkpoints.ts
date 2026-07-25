/** D-157 P1 — the checkpoint store.
 *
 *  The persistence substrate for a preflight-gated run's resumable
 *  state. When the `(channel × actor × contract_id)` policy matrix
 *  yields an `ask` verdict for a boundary-crossing call, the engine
 *  mints a `Checkpoint` — the run's `step.*` namespace snapshot + the
 *  gated step id — persists it here, and ENDS the execution (D-157
 *  § A.2 / N.3 / I-4). No process is held: the paused run lives
 *  entirely on disk as a `Checkpoint` row.
 *
 *  A checkpoint's lifecycle is write-once → read → delete; it has no
 *  in-place status transition, unlike a `Commit`:
 *
 *    1. `write(checkpoint)` persists a freshly-minted checkpoint. The
 *       engine mints a unique `checkpoint_id` per preflight gate, so
 *       the write is once-only — a duplicate id throws.
 *    2. The gateway's preflight `on_answer` reads the checkpoint back
 *       (`get`), or a boot sweep pairs an `awaiting_approval` run anchor
 *       with its checkpoint (`listByRun`).
 *    3. On `Approve` a fresh execution re-instantiates from the
 *       checkpoint past the gate; on `Deny` the run aborts. Either way
 *       the checkpoint is consumed — `delete` removes it. `delete` is
 *       idempotent so an at-least-once `on_answer` dispatch is safe.
 *
 *  Built on the generic `Collection<Checkpoint>` primitive — the same
 *  shape `CommitStore` / `AuditLogStore` are built on — so an in-memory
 *  collection backs tests and a SQLite collection backs the server with
 *  no store-code change. The collection is keyed by `checkpoint_id`.
 *
 *  Substrate-only: this slice ships the store + its type. The engine
 *  pause/resume path (the writer) and the gateway preflight `on_answer`
 *  (the readers) are later D-157 P1 slices.
 *
 *  Spec: docs/d-157-spec.md § A.2 / N.3 / I-4 / I-5.
 */

import type { Collection } from './types.js';
import type { Checkpoint, PreflightApprovedTarget } from '@recued/contracts';

/** The checkpoint store — persistence for the D-157 preflight pause.
 *  The engine pause/resume path (a later D-157 P1 slice) is the sole
 *  writer; the gateway preflight flow + the boot sweep are the readers. */
export interface CheckpointStore {
  /** Persist a freshly-minted checkpoint. Throws when a checkpoint with
   *  the same `checkpoint_id` already exists — the engine mints a
   *  unique id per preflight gate, so the write is once-only. */
  write(checkpoint: Checkpoint): Promise<void>;

  /** One checkpoint by id, or null when unknown. The address the
   *  gateway's preflight `notification.ask` handler payload
   *  (`{ checkpoint_id }`) resolves through on `on_answer`. */
  get(checkpoint_id: string): Promise<Checkpoint | null>;

  /** Checkpoints belonging to one run — keyed on the
   *  execution-request anchor's `run_id`. Newest `created_at` first.
   *  A run has at most one live checkpoint (a gate ends the execution,
   *  and re-instantiation consumes the checkpoint it resumed from), so
   *  this normally returns 0 or 1; it is an array — and ordered — so a
   *  boot sweep pairing an `awaiting_approval` anchor with its
   *  checkpoint stays correct even if the consume-on-resume discipline
   *  is ever violated. Empty result for an empty `run_id`. */
  listByRun(run_id: string): Promise<Checkpoint[]>;

  /** D-173 N.5 — the NARROW editable-args writer (THE SECURITY
   *  BOUNDARY). Set `arg_overrides` (the admin's allowlist-validated
   *  edits) — and, when a target-affecting edit was made, the recomputed
   *  `approved_target` — onto an EXISTING held checkpoint, in place,
   *  WITHOUT consuming it. Returns the patched checkpoint; throws
   *  `checkpoint <id> not found` when the id is unknown (the hold was
   *  already consumed / never existed) so the approve handler fails
   *  closed rather than silently dropping the edit.
   *
   *  This is the ONLY write path for `Checkpoint.arg_overrides`
   *  (D-173 N.5 MUST). It MUST be called ONLY from the admin-only
   *  `reception.inbox.approve` rpc handler, which validated `arg_overrides`
   *  against the operation's `ArgEditSchema` allowlist (N.6) BEFORE
   *  calling this — the store does not (and cannot) re-allowlist, so the
   *  upstream gate is load-bearing. The engine resume merge reads
   *  `arg_overrides` ONLY off the consumed checkpoint, never off caller
   *  input, so no non-inbox path can inject overrides; this writer is the
   *  single seam that gets an override onto a checkpoint at all.
   *
   *  Deliberately NOT a general `update` — the only mutable fields are
   *  `arg_overrides` and `approved_target`. `write` stays once-only (a
   *  duplicate id throws); a checkpoint's other fields are immutable for
   *  its lifetime. Idempotent under retry with the same edits (the patch
   *  is a whole-field replace). */
  setArgOverrides(
    checkpoint_id: string,
    patch: {
      arg_overrides: Record<string, unknown>;
      approved_target?: PreflightApprovedTarget;
    },
  ): Promise<Checkpoint>;

  /** Consume a checkpoint — remove it after the gated run was
   *  re-instantiated (`Approve`) or aborted (`Deny`). Idempotent:
   *  deleting an unknown `checkpoint_id` is a silent no-op, so an
   *  at-least-once `on_answer` dispatch never throws on the retry. */
  delete(checkpoint_id: string): Promise<void>;

  /** Every checkpoint currently in the store, oldest `created_at`
   *  first — the walk order for D-157's optional staleness guard. */
  list(): Promise<Checkpoint[]>;

  /** Total checkpoint count. */
  size(): Promise<number>;
}

/** Build a `CheckpointStore` over a backing `Collection<Checkpoint>`.
 *  The collection is keyed by `checkpoint_id` — pass an in-memory
 *  collection in tests, a SQLite collection on the server. */
export const createCheckpointStore = (
  backing: Collection<Checkpoint>,
): CheckpointStore => {
  /** Newest-`created_at`-first — `listByRun` read order. */
  const byCreatedDesc = (a: Checkpoint, b: Checkpoint): number =>
    b.created_at - a.created_at;
  /** Oldest-`created_at`-first — the `list` staleness-guard walk. */
  const byCreatedAsc = (a: Checkpoint, b: Checkpoint): number =>
    a.created_at - b.created_at;

  return {
    async write(checkpoint) {
      if (await backing.has(checkpoint.checkpoint_id)) {
        throw new Error(
          `CheckpointStore: checkpoint_id "${checkpoint.checkpoint_id}" `
            + `already written (checkpoint write is once-only — the engine `
            + `mints a fresh checkpoint_id per preflight gate)`,
        );
      }
      await backing.set(checkpoint.checkpoint_id, checkpoint);
    },

    get(checkpoint_id) {
      return backing.get(checkpoint_id);
    },

    async listByRun(run_id) {
      if (run_id === '') return [];
      const all = await backing.list();
      return all.filter((c) => c.run_id === run_id).sort(byCreatedDesc);
    },

    async setArgOverrides(checkpoint_id, patch) {
      // D-173 N.5 — the NARROW editable-args writer (THE SECURITY
      // BOUNDARY). Read the held checkpoint, replace ONLY `arg_overrides`
      // (+ `approved_target` when a target-affecting edit was made), and
      // persist it in place. Every other field is carried verbatim — this
      // is deliberately not a general update. Fail closed on an unknown id
      // so the approve handler never silently drops an edit onto a
      // consumed / missing hold.
      const existing = await backing.get(checkpoint_id);
      if (existing === null) {
        throw new Error(
          `CheckpointStore: checkpoint "${checkpoint_id}" not found `
            + `(setArgOverrides targets an existing held checkpoint — the `
            + `hold was already consumed or never existed)`,
        );
      }
      const patched: Checkpoint = {
        ...existing,
        arg_overrides: patch.arg_overrides,
        ...(patch.approved_target !== undefined
          ? { approved_target: patch.approved_target }
          : {}),
      };
      await backing.set(checkpoint_id, patched);
      return patched;
    },

    async delete(checkpoint_id) {
      await backing.delete(checkpoint_id);
    },

    async list() {
      const all = await backing.list();
      return all.sort(byCreatedAsc);
    },

    size() {
      return backing.size();
    },
  };
};
