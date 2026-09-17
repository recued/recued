/** "This server is no longer connected to your account" — said ONCE.
 *
 *  ⛔⛔ SEVERAL DETECTORS, ONE FACT. The DDNS poller learns it from the cloud's
 *  `ddns_publisher_retired`; the entitlement mint learns it from
 *  `credential_invalid`; a future ACME detector would learn the same thing a
 *  third way. Each one firing its own audit row and its own notification would
 *  nag the owner two or three times for a single event, and leave an audit trail
 *  that reads like three separate disconnections.
 *
 *  🔑 SO THE ANNOUNCEMENT IS A SEAM, NOT A SIDE EFFECT AT EACH SITE. Detectors
 *  report; this decides whether anything is said. Adding a detector later means
 *  calling `announce` — not remembering the dedup rules a second time.
 *
 *  ⚠ PERSISTED, UNLIKE THE POLLER'S STAND-DOWN, and the asymmetry is deliberate.
 *  The stand-down is process-local so a restart RE-ASKS the cloud rather than
 *  assuming (a server rebound while it was down must resume). The announcement
 *  is the opposite: the owner has already been told, and a server that restarts
 *  nightly must not re-notify nightly, nor write a fresh audit row each time for
 *  one disconnection.
 *
 *  ⚠ AND IT RE-ARMS ON RECONNECT, or the second disconnection in a server's life
 *  would be silent — the failure mode of a one-shot that is never reset.
 */

import type Database from 'better-sqlite3';

/** Which detector noticed. Carried into the audit detail only — the message the
 *  owner reads is the same either way, because the remedy is. */
export type DisconnectSource = 'ddns_publish' | 'entitlement_mint';

export interface DisconnectAnnouncementStore {
  /** Unix-ms of the announcement in force, or null when none. */
  load(): number | null;
  save(at: number): void;
  clear(): void;
}

const ROW_KEY = 'pro_disconnect_announced_at';

/** ⚠ EVERY STATEMENT IS PREPARED LAZILY, AND THE DDL WITH THEM.
 *
 *  ⛔ IT USED TO RUN AT CONSTRUCTION, and construction happens on the boot path
 *  for EVERY server — while the store itself is touched only when a
 *  disconnection is announced, which for almost every server is never. A
 *  composition-time schema write to pay for a path that rarely runs is the wrong
 *  trade on its own, and it also broke the runtime harness, whose `db` stub is a
 *  partial object: the boot sequence threw before it reached anything else.
 *
 *  🔑 That break was a fair signal rather than a bad stub — a constructor that
 *  cannot be called without a fully-featured database is a constructor that
 *  cannot be composed early, and this one has to be. */
export const createSqliteDisconnectAnnouncementStore = (
  db: Database.Database,
): DisconnectAnnouncementStore => {
  let prepared: {
    read: Database.Statement;
    write: Database.Statement;
    remove: Database.Statement;
  } | undefined;

  const stmts = () => {
    if (!prepared) {
      db.exec(
        `CREATE TABLE IF NOT EXISTS server_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
      );
      prepared = {
        read: db.prepare(`SELECT value FROM server_config WHERE key = ?`),
        write: db.prepare(`INSERT OR REPLACE INTO server_config (key, value) VALUES (?, ?)`),
        remove: db.prepare(`DELETE FROM server_config WHERE key = ?`),
      };
    }
    return prepared;
  };

  return {
    load(): number | null {
      const row = stmts().read.get(ROW_KEY) as { value: string } | undefined;
      if (!row) return null;
      const parsed = Number(row.value);
      // A corrupt value reads as "never announced" — the cost is one extra
      // notification, against a silent one that never arrives.
      return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    },
    save(at: number): void {
      stmts().write.run(ROW_KEY, String(at));
    },
    clear(): void {
      stmts().remove.run(ROW_KEY);
    },
  };
};

/** Is this server currently disowned? Process-local, shared by the detectors
 *  and the DDNS poller.
 *
 *  ⛔⛔⛔ THE POLLER OWNED THIS AS A PRIVATE `let retired = false` AND NOTHING
 *  COULD CLEAR IT. A stand-down with no resume path is only correct if the state
 *  it reflects is permanent, and this one is not: the owner reconnects the server
 *  and the cloud starts honouring it again. Publishing stayed dead until the
 *  process restarted — with the Pro card healthy, the handle provisioner working,
 *  and the hostname quietly not updating.
 *
 *  🔑 SHARED, BECAUSE BOTH DETECTORS SEE THE SAME FACT. The mint notices a
 *  reconnection within a tick; the poller cannot notice it at all without asking
 *  the cloud, which is the thing it has stopped doing. One of them has to tell
 *  the other, and a flag with two writers and one reader is the smallest thing
 *  that does it.
 *
 *  ⚠ NOT PERSISTED — a restart re-asks rather than assuming, which is the same
 *  reasoning the stand-down had before and the opposite of the ANNOUNCEMENT
 *  mark, which must survive restarts so one disconnection is announced once. */
export interface ServerDisownedFlag {
  isDisowned(): boolean;
  markDisowned(): void;
  /** The cloud confirmed ownership — resume. */
  markConnected(): void;
}

export const createServerDisownedFlag = (): ServerDisownedFlag => {
  let disowned = false;
  return {
    isDisowned: () => disowned,
    markDisowned: () => { disowned = true; },
    markConnected: () => { disowned = false; },
  };
};

export interface DisconnectAnnouncerDeps {
  store: DisconnectAnnouncementStore;
  /** Audit sink — the same `logActivity` shape the binding manager uses. */
  logActivity: (entry: {
    activity_id: string;
    timestamp: number;
    action: 'server_account_disconnected';
    target: string;
    detail: string;
  }) => Promise<void> | void;
  /** Delivers the message to the owner.
   *
   *  ⛔⛔⛔ THIS WAS `emitNotification(bus, { subtype: 'in-app', … })` AND IT
   *  REACHED NOBODY. That helper emits the bare `'notification'` broadcast kind,
   *  and the D-121 bus fans out only the kinds a client NAMES — `'notification'`
   *  is in neither `WEBCLIENT_DEFAULT_SUBSCRIPTIONS` (53 of 55 kinds) nor
   *  `BRIDGE_DEFAULT_SUBSCRIPTIONS` (which names `notification.ask`,
   *  `notification.ask_closed`, `notification.bridge_mode_changed` and
   *  `notification.notify`, but not the bare kind). The message was emitted onto
   *  the bus and dropped: typed, green, audited, and invisible.
   *
   *  🔑 `NotificationBlock.notify` IS THE DELIVERY PATH. It emits
   *  `notification.notify` — a kind the Bridge names — and persists a
   *  `notification_fired` activity row, so the message also survives a restart
   *  in the notification history rather than existing only as a bus event
   *  nobody was listening for. */
  notify: (body: { title: string; text: string }) => void;
  now?: () => number;
}

export interface DisconnectAnnouncer {
  /** Report that a detector saw this server disowned. Writes one audit row and
   *  emits one notification the FIRST time; every later call is a no-op until
   *  `rearm()`. Returns whether it announced. */
  announce(source: DisconnectSource): Promise<boolean>;
  /** The server is connected again — allow a future disconnection to be
   *  announced. Cheap and idempotent; safe to call on every success. */
  rearm(): void;
}

export const DISCONNECT_NOTIFICATION_TITLE = 'Server disconnected from your account';
export const DISCONNECT_NOTIFICATION_TEXT =
  'This server is no longer connected to your recued.com account, so its Pro '
  + 'hostname and certificate have stopped updating. Reconnect it from '
  + 'Settings > Account.';

export const createDisconnectAnnouncer = (
  deps: DisconnectAnnouncerDeps,
): DisconnectAnnouncer => {
  const now = deps.now ?? Date.now;

  return {
    async announce(source: DisconnectSource): Promise<boolean> {
      let already: number | null;
      try {
        already = deps.store.load();
      } catch {
        // ⚠ AN UNREADABLE STORE MUST NOT SILENCE THE ANNOUNCEMENT. The whole
        // point is that the owner hears this once; failing closed here would
        // trade "possibly told twice" for "possibly never told".
        already = null;
      }
      if (already !== null) return false;

      const at = now();
      // ⛔ THE MARK GOES DOWN FIRST. The audit sink and the notification bus are
      // both allowed to fail, and a throw between them would otherwise leave the
      // announcement un-marked — so the next tick, five minutes later, says it
      // all again, and again, which is precisely the nagging this exists to stop.
      try {
        deps.store.save(at);
      } catch {
        // Cannot persist ⇒ cannot dedup across restarts. Still announce: one
        // notification per boot beats none at all.
      }

      try {
        await deps.logActivity({
          activity_id: `server_account_disconnected:${at}`,
          timestamp: at,
          action: 'server_account_disconnected',
          target: source,
          detail: JSON.stringify({ source }),
        });
      } catch {
        /* best-effort, mirrors the binding manager's audit posture */
      }

      try {
        deps.notify({
          title: DISCONNECT_NOTIFICATION_TITLE,
          text: DISCONNECT_NOTIFICATION_TEXT,
        });
      } catch {
        /* the bus swallows too; never let a notification failure propagate */
      }

      return true;
    },

    rearm(): void {
      try {
        deps.store.clear();
      } catch {
        /* a stuck mark costs one missed future announcement, never a crash */
      }
    },
  };
};
