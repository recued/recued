/** D-212 follow-on 2 — replay the keyfile-event ledger into the audit log.
 *
 *  The COMMIT half of the hand-off `keyfile-event-ledger.ts` describes: the CLI
 *  commands append with the server stopped, and the next boot mirrors what is
 *  not already there into the D-120 activity log as a signed, reserve-class
 *  `keyfile_sealing_changed` row.
 *
 *  ── Idempotent by reading audit, NOT by clearing the ledger ─────────
 *  The ledger is never cleared, so "what have I already recorded?" has to be
 *  answered from the audit log itself — `activity_id` is `keyfile:<entry id>`,
 *  and a prefix scan of the activity list gives the seen set. ⛔ A cursor file
 *  beside the ledger would be simpler and WRONG: a migration-snapshot rollback
 *  restores the SQLite file, taking the audit rows with it, and a cursor would
 *  then say "already replayed" about rows that no longer exist. Reading the
 *  destination is what makes the replay self-healing across a restore, which is
 *  the reason the ledger lives outside the database in the first place.
 *
 *  Best-effort throughout, and for the same reason D-178's replay is: this is a
 *  receipt, not the event. A failure leaves the entry unreplayed and the next
 *  boot tries again — the ledger is still the durable record either way, so
 *  nothing is lost by declining to wedge a boot over it.
 */

import type { KeyfileEventEntry, KeyfileEventLedger } from './keyfile-event-ledger.js';
import {
  KEYFILE_EVENT_LEDGER_FILE,
  createKeyfileEventLedger,
  unreplayedKeyfileEvents,
} from './keyfile-event-ledger.js';

/** The audit surface the replay needs — a narrow slice of the D-120 store, so
 *  the whole path is testable without one. */
export interface KeyfileEventAuditSink {
  listActivities(limit?: number): Promise<Array<{ activity_id: string }>>;
  logActivity(entry: {
    activity_id: string;
    timestamp: number;
    action: 'keyfile_sealing_changed';
    target: string;
    detail?: string;
  }): Promise<void>;
}

/** Activity-id prefix, so the replay can read back which ledger entries it has
 *  already mirrored — `keyfile:<ledger-entry-id>`. */
export const KEYFILE_EVENT_REPLAY_PREFIX = 'keyfile:';

export interface ReplayKeyfileEventsArgs {
  /** Server data dir (`dirname(dbPath)`) holding the ledger. */
  dataPath: string;
  auditLog: KeyfileEventAuditSink;
  /** Injected for tests; production opens the file beside the database. */
  ledger?: KeyfileEventLedger;
  warn?: (message: string) => void;
}

/** The JSON `detail` for one event. The `ActivityEntry` shape has no dedicated
 *  fields, so this follows the convention the other adapters use.
 *
 *  ⛔ `recorded_at_boot` is not decoration. Without it the row reads as a
 *  first-hand observation, and it is not one: the server was stopped when this
 *  happened and the line it came from is an unauthenticated file. A signed row
 *  that overstates what it witnessed is worse than an unsigned one. */
const detailFor = (e: KeyfileEventEntry): string =>
  JSON.stringify({
    kind: e.kind,
    posture: e.posture,
    ...(e.previous_keyfile ? { previous_keyfile: e.previous_keyfile } : {}),
    ...(e.server_identity_fingerprint
      ? { server_identity_fingerprint: e.server_identity_fingerprint }
      : {}),
    recorded_at_boot: true,
  });

/** Mirror unreplayed keyfile events into the audit log. Safe to call
 *  unconditionally every boot — a no-op when the ledger is absent or every
 *  entry is already recorded. Returns how many rows it wrote. */
export const replayKeyfileEventsIntoAudit = async (
  args: ReplayKeyfileEventsArgs,
): Promise<number> => {
  const warn = args.warn ?? ((message: string) => console.warn(message));
  const ledger = args.ledger ?? createKeyfileEventLedger(args.dataPath);

  let entries: KeyfileEventEntry[];
  try {
    entries = ledger.readAll();
  } catch (err) {
    warn(`[keys] keyfile-event ledger unreadable: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
  if (entries.length === 0) return 0;

  let seen: ReadonlySet<string>;
  try {
    const activities = await args.auditLog.listActivities();
    seen = new Set(
      activities
        .filter((a) => a.activity_id.startsWith(KEYFILE_EVENT_REPLAY_PREFIX))
        .map((a) => a.activity_id.slice(KEYFILE_EVENT_REPLAY_PREFIX.length)),
    );
  } catch {
    // Cannot read prior replay state ⇒ skip rather than risk duplicating rows.
    // The ledger keeps the entries; the next boot asks again.
    return 0;
  }

  let written = 0;
  for (const e of unreplayedKeyfileEvents(ledger, seen)) {
    try {
      await args.auditLog.logActivity({
        activity_id: `${KEYFILE_EVENT_REPLAY_PREFIX}${e.id}`,
        timestamp: e.at,
        action: 'keyfile_sealing_changed',
        target: e.keyfile_path,
        detail: detailFor(e),
      });
      written += 1;
    } catch (err) {
      // Best-effort: the entry stays unreplayed for the next boot.
      warn(
        `[keys] keyfile event ${e.id} not mirrored into the audit log: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  if (written > 0) {
    console.error(
      `[keys] recorded ${written} keyfile sealing change(s) from ${KEYFILE_EVENT_LEDGER_FILE}`,
    );
  }
  return written;
};
