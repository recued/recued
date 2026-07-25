/** An append-only JSONL ledger on the data volume — the shape used by every
 *  record that must outlive the SQLite file.
 *
 *  ── Why a file and not rows ─────────────────────────────────────────
 *  Two callers need a history that survives the database being replaced: the
 *  D-178 update ledger (a migration-snapshot rollback restores SQLite, and the
 *  history of the update it reverts must survive that restore) and the D-212
 *  keyfile-event ledger (the events happen with the server STOPPED, so there is
 *  no audit log to write to at the time). Both then REPLAY into the D-120 audit
 *  log at boot, idempotent on the entry id, with the file staying the source of
 *  truth.
 *
 *  ── One implementation, deliberately ────────────────────────────────
 *  ⛔ The mechanics below are subtle enough to be worth exactly one copy. This
 *  file's sibling `durable-fs.ts` exists because the atomic-write pattern HAD
 *  two copies and they drifted — one looped on the write offset and one ignored
 *  the byte count, and the one that ignored it silently truncated the file
 *  holding the server vault key. A second hand-rolled JSONL reader would be the
 *  same bet: the torn-final-line guard is the kind of thing a reimplementation
 *  leaves out because nothing fails without it until a crash.
 *
 *  Entries are never mutated or deleted. A malformed line is skipped on read
 *  rather than poisoning the tail — a partial-write corruption of the last line
 *  must not lose the rest of the history.
 */

import {
  appendFileSync,
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from 'node:fs';

export interface JsonlLedger<T> {
  append(entry: T): void;
  /** All entries, oldest-first. Malformed lines are skipped. */
  readAll(): T[];
  /** The last `n` entries, newest-last. */
  tail(n: number): T[];
}

/** Open the JSONL ledger at `path`. The directory is assumed to exist (the data
 *  volume). Reads tolerate a missing file (empty history).
 *
 *  `accept` narrows a parsed line to `T` — return null to skip a line that
 *  parses as JSON but is not a well-formed entry, so a foreign or half-migrated
 *  record is dropped rather than handed to a caller that will trust it. */
export const createJsonlLedger = <T>(
  path: string,
  accept: (parsed: unknown) => T | null,
): JsonlLedger<T> => {
  const readAll = (): T[] => {
    if (!existsSync(path)) return [];
    const raw = readFileSync(path, 'utf8');
    const out: T[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue; // torn or foreign line — never poisons the rest
      }
      const entry = accept(parsed);
      if (entry !== null) out.push(entry);
    }
    return out;
  };

  // ⛔ A crash mid-append can leave the file ending WITHOUT a trailing newline
  // (a torn final line). Appending naively would concatenate the next good
  // entry onto that corrupt line, and the malformed-line skip above would then
  // drop BOTH — losing a real record. Guard by checking the last byte and
  // prefixing a newline when the boundary is not clean.
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
