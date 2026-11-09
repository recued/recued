/** ⛔⛔⛔ THE IN-APP NOTIFICATION CHANNEL WAS GREEN-BUT-MUTE, AND EVERY TEST
 *  PASSED.
 *
 *  `emitNotification` emitted the bare `'notification'` broadcast kind — and the
 *  bus fans out ONLY the kinds a client NAMES (`events/bus.ts`:
 *  `if (!sub.kinds.has(stamped.kind)) continue`). That kind is in NEITHER list:
 *  the webclient names 53 of the 55 and omits it; the Bridge names four
 *  `notification.*` kinds but not the bare one.
 *
 *  So a recipe sending to an enrolled in-app connection was counted in
 *  `delivered_to[]`, wrote an audit row with `bytes_out`, and reached nobody.
 *  `community/recipes/triage-inbox.json` shipped `channels: ["in_app"]` as its
 *  DEFAULT (until D-312), and the silence only began once the owner ENROLLED an
 *  in-app connection — so it was mute for exactly the people who asked for it.
 *
 *  🔑 THE COMPOSITION TEST COULD NOT SEE THIS. It mocks `emitNotification`, so it
 *  pinned that the composer calls the helper and stayed blind to which KIND
 *  reached the bus — which is where the muteness lived. This file uses the REAL
 *  helper, which is the only place that question can be asked.
 *
 *  ⚠ DERIVED, NOT SPELLED. A hand-written expected kind would have been just as
 *  wrong as the code was, because the mistake was about the far end of the wire.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { emitNotification } from '../events/emit-sites.js';
import type { EventBus } from '../events/bus.js';
import { bootInAppChannel } from '../data/notification/in-app/boot.js';
import { handleNotificationSend, type NotificationPayload } from '../notification-handler.js';

const namedKinds = (): Set<string> => {
  const readList = (rel: string, name: string): string[] => {
    const src = readFileSync(new URL(rel, import.meta.url), 'utf-8');
    const at = src.indexOf(name);
    expect(at, `${name} moved or was renamed`).toBeGreaterThan(-1);
    return [...src.slice(at, src.indexOf('];', at)).matchAll(/^\s*'([a-z_.]+)',/gm)]
      .map((m) => m[1]!);
  };
  return new Set([
    ...readList('../../../../apps/webclient/src/realtime/subscriber.ts', 'WEBCLIENT_DEFAULT_SUBSCRIPTIONS'),
    ...readList('../../../../apps/bridge/src/realtime/subscriber.ts', 'BRIDGE_DEFAULT_SUBSCRIPTIONS'),
  ]);
};

const captureBus = () => {
  const emitted: Array<Record<string, unknown>> = [];
  const bus = { emit: (e: Record<string, unknown>) => { emitted.push(e); } };
  return { emitted, bus: bus as unknown as EventBus };
};

describe('in-app notification delivery — it must land on a kind somebody names', () => {
  it('emits a kind at least one client subscribes to', () => {
    const { emitted, bus } = captureBus();
    emitNotification(bus, { body: { text: 'Build finished', title: 'Done' } });

    expect(emitted, 'nothing reached the bus').toHaveLength(1);
    const subscribed = namedKinds();

    // Guards the guard: if the bare kind ever becomes subscribed, this test
    // would start passing for a reason unrelated to the fix.
    expect(
      subscribed.has('notification'),
      'the bare kind became subscribed; this test no longer proves anything',
    ).toBe(false);

    expect(
      subscribed.has(String(emitted[0]!.kind)),
      `in-app emits '${String(emitted[0]!.kind)}', which no client names — the `
      + 'send is counted as delivered and reaches nobody',
    ).toBe(true);
  });

  /** ⚠ THE SHAPE IS THE KIND'S, NOT THE OLD PAYLOAD'S. `notification.notify`
   *  carries `title` / `text` / `link_url` FLAT; the dead kind nested them under
   *  `body` beside a `subtype`. Emitting the right kind with the wrong shape
   *  would render an empty toast — delivered, and still saying nothing. */
  it('carries the message in the shape that kind renders', () => {
    const { emitted, bus } = captureBus();
    emitNotification(bus, {
      body: { text: 'Build finished', title: 'Done', link_url: 'https://example.test/run/1' },
    });
    expect(emitted[0]).toEqual({
      kind: 'notification.notify',
      title: 'Done',
      text: 'Build finished',
      link_url: 'https://example.test/run/1',
    });
  });

  /** ⚠ Optional fields stay ABSENT rather than explicitly undefined — the
   *  renderer distinguishes "no title" from a blank one. */
  it('omits absent optional fields', () => {
    const { emitted, bus } = captureBus();
    emitNotification(bus, { body: { text: 'Build finished' } });
    expect(emitted[0]).toEqual({ kind: 'notification.notify', text: 'Build finished' });
  });

  /** ⚠ A bus-less runtime is the ext-side posture, not an error. */
  it('is a no-op without a bus', () => {
    expect(() => emitNotification(undefined, { body: { text: 'x' } })).not.toThrow();
  });

  /** D-338 §11 — the names an Agenda links in the app ride the frame the toast renders. */
  it('carries the names a text links in the app, and only to the app', async () => {
    const mentions = [{ text: 'Ilsa Varga', ref: { collection: 'contact', id: 'contact-ilsa' } }];
    const { emitted, bus } = captureBus();
    // The real in-app dispatcher, with no in-app connection enrolled: it goes to the bus.
    const inApp = bootInAppChannel({ connectionStore: { list: () => [] } as never, notificationHandler: {} as never,
      channel: 'in_app', subtype: 'in-app', emitInApp: body => emitNotification(bus, { body }) });
    const messenger: NotificationPayload[] = [];
    const result = await handleNotificationSend({ dispatchers: { in_app: inApp,
      telegram: async payload => { messenger.push(payload); return { ok: true }; } } },
    { title: 'Agenda · Tue 20 Oct', text: 'Birthday: Ilsa Varga', ui_link_url: '#today', mentions });
    expect([...result.delivered_to].sort()).toEqual(['in_app', 'telegram']);
    expect(emitted).toEqual([{ kind: 'notification.notify', title: 'Agenda · Tue 20 Oct', text: 'Birthday: Ilsa Varga', link_url: '#today', mentions }]);
    // A messenger gets the text alone: a name there has nowhere to open.
    expect(messenger).toHaveLength(1);
    expect(messenger[0]).not.toHaveProperty('mentions');
  });
});
