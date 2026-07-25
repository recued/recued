/** D-178 slice 3 — the update LEDGER (spec § Rollback × migrations, "the
 *  update ledger lives outside the database").
 *
 *  An append-only JSONL sidecar on the data volume (`updates.log`), NOT rows in
 *  the SQLite file. This placement is normative regardless of any open fork: a
 *  migration-snapshot rollback restores SQLite, and the history of the update
 *  it reverts must survive that restore. After any restore, boot replays the
 *  ledger's tail into the D-120 audit log (idempotent on `id`) so
 *  `update_applied`, the rollback that undid it, and the restore itself all
 *  persist (I-3). The ledger is ALSO what the boot-failure counter + the update
 *  lock key off — they must outlive both crash loops and snapshot restores.
 *
 *  The append/read mechanics live in `../jsonl-ledger.js` — this file is the
 *  typed shape over them. They moved when D-212's keyfile-event ledger needed
 *  the same substrate: entries are never mutated or deleted, a malformed line is
 *  skipped rather than poisoning the tail, and a torn final line from a crashed
 *  append is repaired on the next one. Two hand-rolled copies of that would
 *  drift, the way `durable-fs.ts`'s pattern did before it was made singular.
 */

import { createJsonlLedger, type JsonlLedger } from '../jsonl-ledger.js';

export const UPDATE_LEDGER_FILE = 'updates.log';

/** The lifecycle events an update produces. Two-phase apply walks
 *  `apply_started → apply_staged → (apply_committed | apply_reverted)`; rollback
 *  emits `rolled_back` (with snapshot metadata when it restored one); a restore
 *  replay emits `restore_replayed`. */
export type UpdateLedgerKind =
  | 'apply_started'
  | 'apply_staged'
  | 'apply_committed'
  | 'apply_reverted'
  | 'rolled_back'
  | 'snapshot_taken'
  | 'restore_replayed';

export interface UpdateLedgerEntry {
  /** Stable unique id — idempotency key for the replay-into-audit path. */
  id: string;
  kind: UpdateLedgerKind;
  /** Event time (ms). Injected by the caller (no clock read in here). */
  at: number;
  from_version: string;
  to_version: string;
  channel: 'stable' | 'edge';
  /** What initiated this — `auto` (housekeeping) / `manual` (CLI/UI) / the
   *  internal `revert` path (boot-health auto-revert). */
  trigger: 'auto' | 'manual' | 'revert';
  /** Release identity from the manifest (the apply-lock key). */
  release_identity: string;
  /** The applied release migrated the schema — drives the rollback guard. */
  migration?: boolean;
  /** Snapshot file path when a pre-migration snapshot was taken/restored. */
  snapshot_ref?: string;
  /** Free-form non-secret detail (e.g. a revert reason). */
  detail?: string;
}

export type UpdateLedger = JsonlLedger<UpdateLedgerEntry>;

const acceptEntry = (parsed: unknown): UpdateLedgerEntry | null => {
  const o = parsed as Partial<UpdateLedgerEntry>;
  if (typeof o?.id !== 'string' || typeof o?.kind !== 'string') return null;
  return o as UpdateLedgerEntry;
};

/** Open the JSONL ledger at `path`. The directory is assumed to exist (the
 *  data volume). Reads tolerate a missing file (empty history). */
export const createUpdateLedger = (path: string): UpdateLedger =>
  createJsonlLedger(path, acceptEntry);

/** From the ledger tail, the entries not yet mirrored into the D-120 audit log
 *  — the caller passes the set of already-seen ids (idempotent replay, I-3). */
export const unreplayedEntries = (
  ledger: UpdateLedger,
  alreadyInAudit: ReadonlySet<string>,
): UpdateLedgerEntry[] => ledger.readAll().filter((e) => !alreadyInAudit.has(e.id));
