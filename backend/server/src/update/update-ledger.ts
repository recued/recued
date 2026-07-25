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
 *  Pure fs append/read over an injected path; entries are never mutated or
 *  deleted (append-only). A malformed line is skipped on read rather than
 *  poisoning the tail — the sidecar is the source of truth and partial-write
 *  corruption of the last line must not lose the rest of the history.
 */

import { appendFileSync, closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';

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

export interface UpdateLedger {
  append(entry: UpdateLedgerEntry): void;
  /** Read all entries oldest-first (malformed lines skipped). */
  readAll(): UpdateLedgerEntry[];
  /** The last `n` entries (newest-last), for the boot-replay tail. */
  tail(n: number): UpdateLedgerEntry[];
}

const parseLine = (line: string): UpdateLedgerEntry | null => {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const o = JSON.parse(trimmed) as Partial<UpdateLedgerEntry>;
    if (typeof o.id !== 'string' || typeof o.kind !== 'string') return null;
    return o as UpdateLedgerEntry;
  } catch {
    return null;
  }
};

/** Open the JSONL ledger at `path`. The directory is assumed to exist (the
 *  data volume). Reads tolerate a missing file (empty history). */
export const createUpdateLedger = (path: string): UpdateLedger => {
  const readAll = (): UpdateLedgerEntry[] => {
    if (!existsSync(path)) return [];
    const raw = readFileSync(path, 'utf8');
    const out: UpdateLedgerEntry[] = [];
    for (const line of raw.split('\n')) {
      const e = parseLine(line);
      if (e) out.push(e);
    }
    return out;
  };
  // A crash mid-append can leave the file ending without a trailing newline
  // (a torn final line). Appending naively would concatenate the next good
  // entry onto that corrupt line, and the malformed-line skip in readAll would
  // then drop BOTH — losing a real lock/boot-failure record. Guard by checking
  // the last byte and prefixing a newline when the boundary isn't clean.
  const endsWithNewline = (): boolean => {
    if (!existsSync(path)) return true;
    const size = statSync(path).size;
    if (size === 0) return true;
    const fd = openSync(path, 'r');
    try {
      const buf = Buffer.alloc(1);
      readSync(fd, buf, 0, 1, size - 1);
      return buf[0] === 0x0a;
    } finally {
      closeSync(fd);
    }
  };
  return {
    append(entry) {
      const prefix = endsWithNewline() ? '' : '\n';
      appendFileSync(path, `${prefix}${JSON.stringify(entry)}\n`, 'utf8');
    },
    readAll,
    tail(n) {
      const all = readAll();
      return n >= all.length ? all : all.slice(all.length - n);
    },
  };
};

/** From the ledger tail, the entries not yet mirrored into the D-120 audit log
 *  — the caller passes the set of already-seen ids (idempotent replay, I-3). */
export const unreplayedEntries = (
  ledger: UpdateLedger,
  alreadyInAudit: ReadonlySet<string>,
): UpdateLedgerEntry[] => ledger.readAll().filter((e) => !alreadyInAudit.has(e.id));
