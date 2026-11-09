/** ⛔⛔ SEVERAL DETECTORS, ONE FACT — and each one announcing for itself would
 *  nag the owner two or three times for a single disconnection, and leave an
 *  audit trail that reads like three separate events.
 *
 *  The DDNS poller learns it from `ddns_publisher_retired`; the entitlement mint
 *  learns it from `credential_invalid`; a future ACME detector would learn the
 *  same thing a third way. They report here; this decides whether anything is
 *  said.
 */
import { describe, expect, it, vi } from 'vitest';
import DatabaseCtor from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import {
  createDisconnectAnnouncer,
  createSqliteDisconnectAnnouncementStore,
  DISCONNECT_NOTIFICATION_TITLE,
  type DisconnectAnnouncementStore,
} from '../pro-convenience/disconnect-announcer.js';

const NOW = 1_800_000_000_000;

const memoryStore = (): DisconnectAnnouncementStore => {
  let at: number | null = null;
  return {
    load: () => at,
    save: (v) => { at = v; },
    clear: () => { at = null; },
  };
};

const mk = (over: Partial<Parameters<typeof createDisconnectAnnouncer>[0]> = {}) => {
  const logActivity = vi.fn();
  const notify = vi.fn();
  const store = over.store ?? memoryStore();
  const announcer = createDisconnectAnnouncer({
    store, logActivity, notify, now: () => NOW, ...over,
  });
  return { announcer, logActivity, notify, store };
};

describe('disconnect announcer — said once, by whoever noticed', () => {
  it('announces on the first report', async () => {
    const { announcer, logActivity, notify } = mk();
    expect(await announcer.announce('ddns_publish')).toBe(true);
    expect(logActivity).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![0].title).toBe(DISCONNECT_NOTIFICATION_TITLE);
  });

  /** ⛔ THE CASE THE SEAM EXISTS FOR. Two detectors see the same disconnection —
   *  the DDNS poller and the entitlement mint both run every five minutes — and
   *  the owner must hear about it once, not twice. */
  it('a second detector reporting the same fact says nothing', async () => {
    const { announcer, logActivity, notify } = mk();
    await announcer.announce('ddns_publish');
    expect(await announcer.announce('entitlement_mint')).toBe(false);
    expect(logActivity).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('and neither does the same detector on its next tick', async () => {
    const { announcer, notify } = mk();
    await announcer.announce('ddns_publish');
    for (let i = 0; i < 10; i += 1) await announcer.announce('ddns_publish');
    expect(notify).toHaveBeenCalledTimes(1);
  });

  /** ⛔⛔ A ONE-SHOT THAT NEVER RESETS IS SILENT FOR EVERY LATER EVENT. Reconnect
   *  then disconnect again is an ordinary sequence, and the second one matters
   *  as much as the first. */
  it('re-arms on reconnect, so a later disconnection is announced again', async () => {
    const { announcer, notify } = mk();
    await announcer.announce('ddns_publish');
    announcer.rearm();
    expect(await announcer.announce('ddns_publish')).toBe(true);
    expect(notify).toHaveBeenCalledTimes(2);
  });

  /** ⛔⛔ THE MARK GOES DOWN BEFORE THE ANNOUNCEMENT, because both sinks may
   *  fail. A throw between them would leave it un-marked, and the next tick —
   *  five minutes later — would say it all again, and again. */
  it('does not repeat when the audit sink throws', async () => {
    const logActivity = vi.fn(() => { throw new Error('audit down'); });
    const { announcer, notify } = mk({ logActivity });
    expect(await announcer.announce('ddns_publish')).toBe(true);
    expect(await announcer.announce('ddns_publish')).toBe(false);
    expect(notify, 'the notification still went out').toHaveBeenCalledTimes(1);
  });

  it('does not repeat when the notification bus throws', async () => {
    const notify = vi.fn(() => { throw new Error('bus down'); });
    const { announcer, logActivity } = mk({ notify });
    expect(await announcer.announce('ddns_publish')).toBe(true);
    expect(await announcer.announce('ddns_publish')).toBe(false);
    expect(logActivity).toHaveBeenCalledTimes(1);
  });

  /** ⚠ AN UNREADABLE STORE MUST NOT SILENCE IT. Failing closed here would trade
   *  "possibly told twice" for "possibly never told", and only one of those is
   *  recoverable by the owner. */
  it('still announces when the store cannot be read', async () => {
    const store: DisconnectAnnouncementStore = {
      load: () => { throw new Error('db locked'); },
      save: () => { throw new Error('db locked'); },
      clear: () => {},
    };
    const { announcer, notify } = mk({ store });
    expect(await announcer.announce('ddns_publish')).toBe(true);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('records which detector noticed, in the audit detail only', async () => {
    const { announcer, logActivity, notify } = mk();
    await announcer.announce('entitlement_mint');
    expect(JSON.parse(logActivity.mock.calls[0]![0].detail).source).toBe('entitlement_mint');
    // ⚠ But NOT in the copy — the owner's remedy is the same either way, and
    // naming an internal detector in a notification explains nothing.
    const body = notify.mock.calls[0]![0];
    expect(`${body.title} ${body.text}`).not.toContain('entitlement_mint');
  });
});

describe('disconnect announcement store — surviving a restart', () => {
  /** ⛔⛔ THIS IS WHY IT IS PERSISTED AND THE POLLER'S STAND-DOWN IS NOT. The
   *  stand-down must re-ASK on boot (a server rebound while down has to resume);
   *  the announcement must NOT re-fire on boot, or a server that restarts
   *  nightly notifies nightly about one disconnection. */
  it('a fresh process does not re-announce', () => {
    const db = new DatabaseCtor(':memory:');
    createSqliteDisconnectAnnouncementStore(db).save(NOW);
    // A new store over the same database = a restart.
    expect(createSqliteDisconnectAnnouncementStore(db).load()).toBe(NOW);
  });

  it('clear() lets the next disconnection through', () => {
    const db = new DatabaseCtor(':memory:');
    const store = createSqliteDisconnectAnnouncementStore(db);
    store.save(NOW);
    store.clear();
    expect(store.load()).toBeNull();
  });

  /** ⚠ A corrupt value reads as "never announced" — one extra notification,
   *  against a silent one that never arrives. */
  it('a corrupt row reads as never-announced', () => {
    const db = new DatabaseCtor(':memory:');
    const store = createSqliteDisconnectAnnouncementStore(db);
    store.save(NOW);
    db.prepare(`UPDATE server_config SET value = 'not-a-number' WHERE key = ?`)
      .run('pro_disconnect_announced_at');
    expect(store.load()).toBeNull();
  });
});

/** ⛔⛔⛔ THREE HOPS, AND EVERY ONE OF THEM HAS DIED SILENTLY BEFORE.
 *
 *  `readProvisioned` was supplied only in tests. The entitlement projection was
 *  written but never passed. The rename count was written and never read. This
 *  seam has the same shape and one extra hop: the announcer is built at the
 *  composition site, handed to the poller starter, and forwarded to the poller —
 *  and its notification bus is threaded from a fourth file.
 *
 *  ⚠ THE BUS IS THE SHARPEST OF THEM. `emitNotification` returns early on an
 *  undefined bus, so a missing thread leaves the announcer composing, auditing
 *  and announcing NOTHING — typed, green, and silent, which is the one outcome
 *  the seam exists to prevent.
 *
 *  ⚠ COMMENTS STRIPPED: each site carries a note naming the thing it wires, and
 *  a raw search finds the prose whether or not the call is there.
 */
describe('composition — the announcer is actually reachable in production', () => {
  const codeOf = (rel: string): string =>
    readFileSync(new URL(rel, import.meta.url), 'utf-8')
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');

  /** ⛔ ONE INSTANCE, BUILT WHERE BOTH DETECTORS CAN SEE IT. The provisioning
   *  loop starts before the housekeeping tail, so an announcer built in the tail
   *  could only ever reach one of the two. */
  it('exactly one announcer is constructed, at the shared site', () => {
    const runtime = codeOf('../serve/start-post-listener-runtime.ts');
    expect(runtime, 'nothing constructs the announcer').toContain('createDisconnectAnnouncer(');
    const tail = codeOf('../serve/start-post-housekeeping-tail.ts');
    expect(
      tail,
      'the tail builds a SECOND announcer — the once-only rule then depends on '
      + 'write ordering rather than on one decision-maker',
    ).not.toContain('createDisconnectAnnouncer(');
  });

  it('the entitlement detector reports, and re-arms on a proven connection', () => {
    const code = codeOf('../serve/start-post-listener-runtime.ts');
    const at = code.indexOf('startProConvenienceProvisioning({');
    expect(at).toBeGreaterThan(-1);
    const call = code.slice(at, code.indexOf('  });', at));
    // ⚠ The assignment, not the identifier: both keys also appear in the spread's
    // GUARD, so a bare-name search matches with the payload deleted.
    expect(call, 'the mint detector never reaches the announcer')
      .toContain('announceDisconnect: (source) => disconnectAnnouncer.announce(source)');
    expect(call, 'never re-arms — the second disconnection would be silent')
      .toContain('rearmDisconnect: () => disconnectAnnouncer.rearm()');
  });

  it('the tail hands the SAME instance to the poller starter', () => {
    const code = codeOf('../serve/start-post-housekeeping-tail.ts');
    const at = code.indexOf('startDdnsUpdatePoller({');
    expect(at).toBeGreaterThan(-1);
    expect(
      code.slice(at, code.indexOf('});', at)),
      'the poller is started without the announcer — the stand-down stays silent',
    ).toContain('options.disconnectAnnouncer!.announce(source)');
  });

  it('the starter forwards it into the poller composition', () => {
    const code = codeOf('../serve/start-ddns-update-poller.ts');
    const at = code.indexOf('composeDdnsUpdatePoller({');
    expect(at).toBeGreaterThan(-1);
    expect(
      code.slice(at, code.indexOf('});', at)),
      'the starter accepts the announcer and drops it on the floor',
    ).toContain('announceDisconnect: options.announceDisconnect');
  });

  /** ⛔⛔⛔ THE MESSAGE WAS EMITTED ONTO A KIND NOBODY LISTENS FOR.
   *
   *  The first version delivered through `emitNotification(bus, { subtype:
   *  'in-app', … })`, which emits the bare `'notification'` broadcast kind. The
   *  D-121 bus fans out ONLY the kinds a client names, and `'notification'` is in
   *  neither list: the webclient names 53 of the 55 kinds and omits it, and the
   *  Bridge names four `notification.*` kinds but not the bare one. So the
   *  announcement was composed, audited, marked-as-told, and dropped at the
   *  fan-out — every layer typed and green.
   *
   *  🔑 THIS TEST DERIVES THE REQUIREMENT rather than asserting a spelling: it
   *  reads both subscription lists and requires the delivery path to use a kind
   *  SOMEBODY names. A hand-written expectation would have been just as wrong as
   *  the code, because the mistake was about the other end of the wire. */
  it('delivers on a kind some client actually subscribes to', () => {
    const readList = (rel: string, name: string): string[] => {
      const src = readFileSync(new URL(rel, import.meta.url), 'utf-8');
      const at = src.indexOf(name);
      expect(at, `${name} moved or was renamed`).toBeGreaterThan(-1);
      return [...src.slice(at, src.indexOf('];', at)).matchAll(/^\s*'([a-z_.]+)',/gm)]
        .map((m) => m[1]!);
    };
    const subscribed = new Set([
      ...readList('../../../../apps/webclient/src/realtime/subscriber.ts', 'WEBCLIENT_DEFAULT_SUBSCRIPTIONS'),
      ...readList('../../../../apps/bridge/src/realtime/subscriber.ts', 'BRIDGE_DEFAULT_SUBSCRIPTIONS'),
    ]);

    // The bare kind is the one that was used, and it must still be unsubscribed
    // — otherwise this test would pass for the wrong reason.
    expect(
      subscribed.has('notification'),
      'the bare kind became subscribed; this test no longer proves anything',
    ).toBe(false);
    expect(subscribed.has('notification.notify')).toBe(true);

    const code = codeOf('../serve/start-post-listener-runtime.ts');
    const at = code.indexOf('createDisconnectAnnouncer({');
    expect(at).toBeGreaterThan(-1);
    const build = code.slice(at, code.indexOf('    : undefined;', at));
    expect(
      build,
      'delivery went back to a bus kind no client names — the owner is never told',
    ).not.toContain('emitNotification(');
    expect(
      build,
      'nothing delivers the message',
    ).toContain('notificationBlock');
  });

  /** ⛔ AND THE TAIL MUST BE HANDED IT. A shared instance that never reaches the
   *  second detector is a singleton in name only. */
  it('the shared instance reaches the tail', () => {
    const code = codeOf('../serve/start-post-listener-runtime.ts');
    const at = code.indexOf('startPostHousekeepingTail({');
    expect(at).toBeGreaterThan(-1);
    expect(
      code.slice(at, code.indexOf('  });', at)),
      'the DDNS detector gets no announcer',
    ).toContain('disconnectAnnouncer');
  });
});
