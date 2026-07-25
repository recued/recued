/** D-212 follow-on 2 — the durable record that a keyfile's sealing changed.
 *
 *  ── The question this exists to answer ──────────────────────────────
 *  *When did the sealing factor last change, and did I do it?* — the one you
 *  actually ask after a compromise. `rotate-passphrase` and `recover-keyfile`
 *  both change how the realm's keys are protected and neither could write an
 *  audit row, **because the server is stopped, so there is no audit log to write
 *  to.** What existed instead was the `.pre-rotate-<ms>` / `.unopenable-<ms>`
 *  backup filename: durable and timestamped, and unable to distinguish "an
 *  attacker rotated my keyfile at 03:14" from "I fat-fingered my own passphrase
 *  change". A file mtime is weak evidence.
 *
 *  ── Shape: an append-only ledger, replayed into audit at boot ───────
 *  The precedent is D-178's update ledger, not the restore-provenance marker,
 *  and the difference matters. ⛔ **A marker is REPLACED; this must APPEND.**
 *  Restore provenance is single-valued — the last committed restore defines the
 *  current lineage, so clear-first is correct there. Here, an attacker's
 *  rotation followed by the operator's own rotation before the next boot is
 *  precisely the pair you need to see, and clear-first would drop the one that
 *  matters. So: append-only, never cleared, and the boot replay is idempotent on
 *  the entry id (`unreplayedKeyfileEvents`) rather than destructive.
 *
 *  Never cleared also answers "what if the server never boots again": the file
 *  IS the record, and a structured line beats a backup's filename. It grows by
 *  one line per keyfile event — a handful over a realm's life.
 *
 *  ⚠ **This ledger is NOT encrypted**, because it has to be readable when the
 *  keyfile is not. Every field is non-secret by construction: an event kind, a
 *  timestamp, file paths, the sealing posture (which the keyfile's own header
 *  states in the clear anyway) and a PUBLIC key fingerprint. Nothing here helps
 *  anyone open anything, and the whole point is that it survives the realm being
 *  unopenable. Adding a secret to this shape would be a mistake — say so here
 *  rather than discover it later.
 *
 *  ⚠ And it is UNAUTHENTICATED. Anyone who can write the data directory can
 *  forge a line — but they can also rewrite the keyfile and the database, so
 *  this adds no exposure. It does bound what the replayed audit row may claim:
 *  the row records that a LEDGER LINE said this, recorded at boot, not that the
 *  server witnessed it. The `recorded_at_boot` detail field says so on the row.
 */

import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

import { createJsonlLedger, type JsonlLedger } from '../jsonl-ledger.js';
import type { KeyfileSealingPosture } from './index.js';

/** Beside `updates.log` on the data volume, and deliberately NOT dot-prefixed:
 *  the reservation and the restore marker are machinery an operator should never
 *  have to think about, and this is evidence they are meant to find. */
export const KEYFILE_EVENT_LEDGER_FILE = 'keyfile-events.log';

export const keyfileEventLedgerPath = (dataPath: string): string =>
  join(dataPath, KEYFILE_EVENT_LEDGER_FILE);

/** What happened to the keyfile. Two commands, two kinds — kept distinct
 *  because their COSTS differ: a rotation preserves the server identity and a
 *  regeneration destroys it, and an operator reading this back is often asking
 *  exactly which one they are looking at. */
export type KeyfileEventKind =
  /** `recued rotate-passphrase` — same realm, same identity, new passphrase. */
  | 'passphrase_rotated'
  /** `recued recover-keyfile` — realm rescued, identity replaced. */
  | 'keyfile_regenerated';

export interface KeyfileEventEntry {
  /** Stable unique id — the idempotency key for the replay-into-audit path. */
  id: string;
  kind: KeyfileEventKind;
  /** Unix-ms the event completed. Injected by the caller; no clock read here. */
  at: number;
  /** Absolute path of the keyfile that changed. */
  keyfile_path: string;
  /** How the keyfile is sealed AFTER the event. A rotation leaves this
   *  `passphrase` by construction (changing the factor CLASS is regeneration's
   *  job); a regeneration reports whatever this host offered at the time, which
   *  is the field that says whether an unattended recovery landed UNSEALED. */
  posture: KeyfileSealingPosture;
  /** Where the previous keyfile was kept — `.pre-rotate-<ms>` or
   *  `.unopenable-<ms>`. Absent when there was nothing to displace. */
  previous_keyfile?: string;
  /** Server identity fingerprint AFTER the event: unchanged across a rotation,
   *  new after a regeneration. Recorded on both so a reader can tell which
   *  happened from the ledger alone, without trusting `kind`. */
  server_identity_fingerprint?: string;
}

export type KeyfileEventLedger = JsonlLedger<KeyfileEventEntry>;

const acceptEntry = (parsed: unknown): KeyfileEventEntry | null => {
  const o = parsed as Partial<KeyfileEventEntry>;
  if (typeof o?.id !== 'string' || typeof o?.at !== 'number') return null;
  if (o.kind !== 'passphrase_rotated' && o.kind !== 'keyfile_regenerated') return null;
  return o as KeyfileEventEntry;
};

export const createKeyfileEventLedger = (dataPath: string): KeyfileEventLedger =>
  createJsonlLedger(keyfileEventLedgerPath(dataPath), acceptEntry);

/** Record a keyfile event. **Best-effort by construction** — the record is not
 *  the event, and a rotation that succeeded must not be reported as failed
 *  because a log line would not write. Returns the entry it appended, or null
 *  when it could not, so a caller that wants to say something about it can.
 *
 *  ⛔ Call this only AFTER the change is verified on disk. An entry written
 *  ahead of the write would outlive a rollback and become the false claim the
 *  whole record exists to avoid. */
export const recordKeyfileEvent = (
  dataPath: string,
  entry: Omit<KeyfileEventEntry, 'id'>,
  opts: { mintId?: () => string; warn?: (message: string) => void } = {},
): KeyfileEventEntry | null => {
  const full: KeyfileEventEntry = {
    id: (opts.mintId ?? (() => randomBytes(12).toString('hex')))(),
    ...entry,
  };
  try {
    createKeyfileEventLedger(dataPath).append(full);
    return full;
  } catch (err) {
    (opts.warn ?? ((m: string) => console.warn(m)))(
      `[keys] keyfile event not recorded (the change itself succeeded): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
};

/** The entries not yet mirrored into the audit log — the caller supplies the
 *  ids already recorded there. Mirrors D-178's `unreplayedEntries`. */
export const unreplayedKeyfileEvents = (
  ledger: KeyfileEventLedger,
  alreadyInAudit: ReadonlySet<string>,
): KeyfileEventEntry[] => ledger.readAll().filter((e) => !alreadyInAudit.has(e.id));
