/** Notification channel registry substrate tests. */

import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  MESSENGER_VENDOR_SLUGS,
  NOTIFICATION_DELIVERY_CHANNELS,
  type ConnectionKind,
  type ConnectionRow,
  type NotificationSubtype,
  totalRecord,
} from '@recued/contracts';
import type { ConnectionKindHandler } from '@recued/ingredients';
import {
  NOTIFICATION_CHANNEL_REGISTRY,
  type NotificationChannelBootDeps,
  type NotificationChannelEntry,
} from '../data/notification-channel-registry.js';
import { bootChatTransportChannel } from '../data/notification/chat-transport/boot.js';
import { bootEmailChannel } from '../data/notification/email/boot.js';
import { bootInAppChannel } from '../data/notification/in-app/boot.js';
import { buildSubtypeDispatcher } from '../notification-dispatchers.js';
import type {
  NotificationChannel,
  NotificationChannelDispatcher,
  NotificationPayload,
} from '../notification-handler.js';
import type { ConnectionStoreSqlite } from '../storage/connection-store.js';

type TestConnectionStore = ConnectionStoreSqlite & {
  list: ReturnType<typeof vi.fn>;
};

/** D-192 WhatsApp make-live — DERIVED, not hand-spelled.
 *
 *  These four constants used to name `slack`/`telegram`/`email`/`in_app` literally,
 *  and so did the registry they were checking — which is precisely why nothing
 *  noticed that a newly declared chat transport had no registry entry, no
 *  dispatcher, and therefore no delivery. Two hand-written lists agreeing with each
 *  other proves nothing; the fix is to derive both from the ONE registry that
 *  declares what a chat transport is. A future vendor is now covered here for free.
 *
 *  `email` / `in_app` stay literal on purpose: they are NOT chat transports, and
 *  `in_app` is the one channel whose id genuinely differs from its wire subtype. */
const CHAT_TRANSPORTS = MESSENGER_VENDOR_SLUGS;

const EXPECTED_CHANNELS = [
  ...CHAT_TRANSPORTS,
  'email',
  'in_app',
] as const satisfies readonly NotificationChannel[];

const EXPECTED_SUBTYPES = [
  ...CHAT_TRANSPORTS,
  'email',
  'in-app',
] as const satisfies readonly NotificationSubtype[];

const EXPECTED_SUBTYPE_BY_CHANNEL = {
  // For a chat transport the channel id IS the wire subtype — the two spellings
  // only ever diverge for `in_app`.
  ...totalRecord(CHAT_TRANSPORTS, (v): NotificationSubtype => v),
  email: 'email',
  in_app: 'in-app',
} satisfies Record<NotificationChannel, NotificationSubtype>;

const EXPECTED_BOOT_BY_CHANNEL = {
  // Every chat transport boots identically — that is a FACT about them, and the
  // reason four byte-identical `boot<X>Channel` files were collapsed into one.
  ...totalRecord(CHAT_TRANSPORTS, () => bootChatTransportChannel),
  email: bootEmailChannel,
  in_app: bootInAppChannel,
} satisfies Record<NotificationChannel, NotificationChannelEntry['boot']>;

const ENTRY_CASES = NOTIFICATION_CHANNEL_REGISTRY.map((entry) =>
  [entry.channel, entry] as const);

const mockedModulePaths = [
  '../data/notification-channel-registry.js',
  '../data/notification/chat-transport/boot.js',
  '../data/notification/email/boot.js',
  '../data/notification/in-app/boot.js',
] as const;

const keySet = (value: object): string[] => Object.keys(value).sort();

const buildRow = (
  overrides: Partial<ConnectionRow> & { name: string; subtype: string },
): ConnectionRow => ({
  pk: `notification:${overrides.name}`,
  kind: 'notification',
  display_name: overrides.name,
  config_json: '{}',
  auth_ciphertext: 'ciphertext',
  enrolled_at: 1,
  updated_at: 1,
  ...overrides,
});

const buildStore = (
  rows: ConnectionRow[] = [],
): TestConnectionStore => {
  const list = vi.fn((query?: { kind?: ConnectionKind }) =>
    query?.kind
      ? rows.filter((row) => row.kind === query.kind)
      : rows.slice());

  return {
    upsert: vi.fn(() => {
      throw new Error('not implemented in stub');
    }),
    get: vi.fn((kind: ConnectionKind, name: string) =>
      rows.find((row) => row.kind === kind && row.name === name) ?? null),
    list,
    listSince: vi.fn(() => []),
    delete: vi.fn(() => false),
    count: vi.fn(() => rows.length),
    addOnUpsert: vi.fn(() => vi.fn()),
    addOnDelete: vi.fn(() => vi.fn()),
  } as unknown as TestConnectionStore;
};

const buildNotificationHandler = () =>
  vi.fn<ConnectionKindHandler>(async () => ({
    status: 'ok',
    result: {},
    headers: undefined,
  }));

const buildBaseBootDeps = (): NotificationChannelBootDeps => {
  const deps = {
    connectionStore: buildStore(),
    notificationHandler: buildNotificationHandler(),
    channel: 'slack',
    subtype: 'slack',
  } satisfies NotificationChannelBootDeps;

  return deps;
};

const buildBootDeps = (
  overrides: Partial<NotificationChannelBootDeps> = {},
): NotificationChannelBootDeps => ({
  ...buildBaseBootDeps(),
  ...overrides,
});

const payloadFor = (
  channel: NotificationChannel,
  overrides: Partial<NotificationPayload> = {},
): NotificationPayload => ({
  channel,
  text: 'Alert body',
  title: 'Alert title',
  link_url: 'https://example.test/run/1',
  ...overrides,
});

const rowsForKnownSubtypes = (): ConnectionRow[] =>
  EXPECTED_SUBTYPES.map((subtype) =>
    buildRow({ name: `record-${subtype}`, subtype }));

const nextChannel = (channel: NotificationChannel): NotificationChannel => {
  const index = EXPECTED_CHANNELS.indexOf(channel);
  return EXPECTED_CHANNELS[(index + 1) % EXPECTED_CHANNELS.length]!;
};

const nextSubtype = (subtype: NotificationSubtype): NotificationSubtype => {
  const index = EXPECTED_SUBTYPES.indexOf(subtype);
  return EXPECTED_SUBTYPES[(index + 1) % EXPECTED_SUBTYPES.length]!;
};

const buildDispatchersFromRegistry = (
  entries: ReadonlyArray<NotificationChannelEntry>,
  deps: Pick<NotificationChannelBootDeps, 'connectionStore' | 'notificationHandler'>,
): Record<string, NotificationChannelDispatcher> => {
  const dispatchers: Record<string, NotificationChannelDispatcher> = {};
  for (const entry of entries) {
    dispatchers[entry.channel] = entry.boot({
      ...deps,
      channel: entry.channel,
      subtype: entry.subtype,
    });
  }
  return dispatchers;
};

afterEach(() => {
  vi.restoreAllMocks();
  for (const path of mockedModulePaths) {
    vi.doUnmock(path);
  }
  vi.resetModules();
});

/** D-192 WhatsApp make-live — THE assertion that was missing, and the reason a
 *  declared-but-undispatchable channel could exist at all.
 *
 *  `NOTIFICATION_DELIVERY_CHANNELS` (what `notification.send` will ACCEPT as a
 *  target) is registry-driven and grew a member the moment WhatsApp was declared.
 *  `NOTIFICATION_CHANNEL_REGISTRY` (what can actually DELIVER) was a hand-written
 *  array and did not. An array cannot be checked for completeness by the compiler
 *  the way a `Record` can, so the gap was silent: a send aimed at the new channel
 *  would resolve, find no dispatcher, and do nothing at all.
 *
 *  Green, ready, and mute — for the third time in this arc. So assert the
 *  RELATIONSHIP between the two lists rather than either one's contents. */
describe('every channel that can be SENT to can also be DELIVERED to', () => {
  it('covers every delivery channel with a dispatcher entry', () => {
    const dispatchable = NOTIFICATION_CHANNEL_REGISTRY.map((e) => e.channel).sort();
    expect(dispatchable).toEqual([...NOTIFICATION_DELIVERY_CHANNELS].sort());
  });

  it('gives every declared chat transport an entry, keyed channel === subtype', () => {
    // Iterates the LIVE messenger registry, so the next vendor is covered here
    // with zero edits — and a vendor that is declared but never wired to a
    // dispatcher fails HERE rather than in a user's silent, healthy-looking
    // WhatsApp thread.
    for (const vendor of MESSENGER_VENDOR_SLUGS) {
      const entry = NOTIFICATION_CHANNEL_REGISTRY.find((e) => e.channel === vendor);
      expect(entry, `no dispatcher entry for declared transport '${vendor}'`).toBeDefined();
      expect(entry?.subtype).toBe(vendor);
      expect(entry?.boot).toBe(bootChatTransportChannel);
    }
  });
});

describe('NOTIFICATION_CHANNEL_REGISTRY shape', () => {
  it('exports one entry per channel, in deterministic boot order', () => {
    // Was `toHaveLength(4)` + a hand-spelled order. The count was never the point —
    // the COVERAGE is (see the completeness ratchet above), and a magic number just
    // means the next vendor has to come and edit it.
    expect(Array.isArray(NOTIFICATION_CHANNEL_REGISTRY)).toBe(true);
    expect(NOTIFICATION_CHANNEL_REGISTRY).toHaveLength(EXPECTED_CHANNELS.length);
    expect(NOTIFICATION_CHANNEL_REGISTRY.map((entry) => entry.channel)).toEqual([
      ...EXPECTED_CHANNELS,
    ]);
  });

  it('contains the exact channel set with no missing or extra channels', () => {
    expect(new Set(NOTIFICATION_CHANNEL_REGISTRY.map((entry) => entry.channel))).toEqual(
      new Set(EXPECTED_CHANNELS),
    );
  });

  it('keeps every entry to the three-field registry contract', () => {
    for (const entry of NOTIFICATION_CHANNEL_REGISTRY) {
      expect(keySet(entry)).toEqual(['boot', 'channel', 'subtype']);
      expect(EXPECTED_CHANNELS).toContain(entry.channel);
      expect(EXPECTED_SUBTYPES).toContain(entry.subtype);
      expect(entry.boot).toEqual(expect.any(Function));
    }
  });

  it('maps channels to notification row subtypes, including in_app to in-app', () => {
    expect(Object.fromEntries(
      NOTIFICATION_CHANNEL_REGISTRY.map((entry) => [entry.channel, entry.subtype]),
    )).toEqual(EXPECTED_SUBTYPE_BY_CHANNEL);
  });

  it('stores the statically imported boot functions directly on entries', () => {
    for (const entry of NOTIFICATION_CHANNEL_REGISTRY) {
      expect(entry.boot).toBe(EXPECTED_BOOT_BY_CHANNEL[entry.channel]);
    }
  });
});

describe('NOTIFICATION_CHANNEL_REGISTRY static import discipline', () => {
  it.each(ENTRY_CASES)(
    '%s boot is synchronous and returns a dispatcher directly',
    (_channel, entry) => {
      expect(entry.boot.constructor.name).not.toBe('AsyncFunction');

      const returned = entry.boot(buildBootDeps({
        channel: entry.channel,
        subtype: entry.subtype,
      }));

      expect(returned).toEqual(expect.any(Function));
      expect(returned).not.toBeInstanceOf(Promise);
      expect(typeof (returned as unknown as { then?: unknown }).then).not.toBe('function');
    },
  );

  it('statically imports every boot module, and boots none of them at import time', async () => {
    // Three modules now, not four: the byte-identical `slack/boot.ts` and
    // `telegram/boot.ts` collapsed into ONE `chat-transport/boot.ts` that every
    // declared transport shares. What this test actually guards is unchanged and is
    // the part that matters — the boot modules are STATICALLY imported (no lazy
    // path), and importing the registry must not BOOT anything.
    vi.resetModules();

    const chatTransportModuleLoaded = vi.fn();
    const emailModuleLoaded = vi.fn();
    const inAppModuleLoaded = vi.fn();
    const dispatcher: NotificationChannelDispatcher = async () => ({ ok: true });
    const bootChatTransportMock =
      vi.fn<NotificationChannelEntry['boot']>(() => dispatcher);
    const bootEmailMock =
      vi.fn<NotificationChannelEntry['boot']>(() => dispatcher);
    const bootInAppMock =
      vi.fn<NotificationChannelEntry['boot']>(() => dispatcher);

    vi.doMock('../data/notification/chat-transport/boot.js', () => {
      chatTransportModuleLoaded();
      return { bootChatTransportChannel: bootChatTransportMock };
    });
    vi.doMock('../data/notification/email/boot.js', () => {
      emailModuleLoaded();
      return { bootEmailChannel: bootEmailMock };
    });
    vi.doMock('../data/notification/in-app/boot.js', () => {
      inAppModuleLoaded();
      return { bootInAppChannel: bootInAppMock };
    });

    const mod = await import('../data/notification-channel-registry.js');

    expect(chatTransportModuleLoaded).toHaveBeenCalledTimes(1);
    expect(emailModuleLoaded).toHaveBeenCalledTimes(1);
    expect(inAppModuleLoaded).toHaveBeenCalledTimes(1);
    // Every chat transport shares the one boot fn; email + in_app keep their own.
    expect(mod.NOTIFICATION_CHANNEL_REGISTRY.map((entry) => entry.boot)).toEqual([
      ...MESSENGER_VENDOR_SLUGS.map(() => bootChatTransportMock),
      bootEmailMock,
      bootInAppMock,
    ]);
    expect(bootChatTransportMock).not.toHaveBeenCalled();
    expect(bootEmailMock).not.toHaveBeenCalled();
    expect(bootInAppMock).not.toHaveBeenCalled();
  });
});

describe('per-channel boot modules', () => {
  it.each(ENTRY_CASES)(
    '%s returns NO_CONNECTION_BOUND when no row matches its subtype',
    async (_channel, entry) => {
      const connectionStore = buildStore([
        buildRow({ name: 'other', subtype: nextSubtype(entry.subtype) }),
      ]);
      const notificationHandler = buildNotificationHandler();
      const dispatcher = entry.boot(buildBootDeps({
        connectionStore,
        notificationHandler,
        channel: entry.channel,
        subtype: entry.subtype,
      }));

      const out = await dispatcher(payloadFor(entry.channel));

      expect(out).toEqual({
        ok: false,
        reason: 'NO_CONNECTION_BOUND',
      });
      expect(connectionStore.list).toHaveBeenCalledWith({ kind: 'notification' });
      expect(notificationHandler).not.toHaveBeenCalled();
    },
  );

  it.each(ENTRY_CASES)(
    '%s routes the matching row, params, and synthetic call to the handler',
    async (_channel, entry) => {
      const matchingRow = buildRow({
        name: `record-${entry.channel}`,
        subtype: entry.subtype,
      });
      const connectionStore = buildStore([
        buildRow({ name: 'ignored', subtype: nextSubtype(entry.subtype) }),
        matchingRow,
      ]);
      const notificationHandler = buildNotificationHandler();
      const dispatcher = entry.boot(buildBootDeps({
        connectionStore,
        notificationHandler,
        channel: entry.channel,
        subtype: entry.subtype,
      }));

      const out = await dispatcher(payloadFor(entry.channel));

      expect(out).toEqual({ ok: true });
      expect(notificationHandler).toHaveBeenCalledTimes(1);
      const [row, params, call, ctx] = notificationHandler.mock.calls[0]!;
      expect(row).toBe(matchingRow);
      expect(params).toEqual({
        text: 'Alert body',
        title: 'Alert title',
        link_url: 'https://example.test/run/1',
      });
      expect(call).toEqual({
        slug: `recued/notification-send.${entry.channel}`,
        risk_tier: 'write',
        input: {},
        output: {},
      });
      expect(ctx).toBeUndefined();
    },
  );

  it.each(ENTRY_CASES)(
    '%s honors caller-provided channel and subtype instead of module-local labels',
    async (_channel, entry) => {
      const overriddenChannel = nextChannel(entry.channel);
      const overriddenSubtype = nextSubtype(entry.subtype);
      const rows = rowsForKnownSubtypes();
      const notificationHandler = buildNotificationHandler();
      const dispatcher = entry.boot(buildBootDeps({
        connectionStore: buildStore(rows),
        notificationHandler,
        channel: overriddenChannel,
        subtype: overriddenSubtype,
      }));

      await dispatcher(payloadFor(entry.channel));

      const [row, _params, call] = notificationHandler.mock.calls[0]!;
      expect(row.subtype).toBe(overriddenSubtype);
      expect(row.name).toBe(`record-${overriddenSubtype}`);
      expect(call.slug).toBe(`recued/notification-send.${overriddenChannel}`);
    },
  );

  it('returns independent dispatcher closures while sharing the same handler reference', async () => {
    const rows = rowsForKnownSubtypes();
    const notificationHandler = buildNotificationHandler();
    const connectionStore = buildStore(rows);
    // One boot fn, two channels — the point of the test is that each CALL yields
    // an independent closure bound to its own channel/subtype labels, which is
    // exactly why the four byte-identical per-vendor boot files bought nothing.
    const slackDispatcher = bootChatTransportChannel(buildBootDeps({
      connectionStore,
      notificationHandler,
      channel: 'slack',
      subtype: 'slack',
    }));
    const telegramDispatcher = bootChatTransportChannel(buildBootDeps({
      connectionStore,
      notificationHandler,
      channel: 'telegram',
      subtype: 'telegram',
    }));

    expect(slackDispatcher).not.toBe(telegramDispatcher);

    await slackDispatcher(payloadFor('slack', { text: 'Slack alert' }));
    await telegramDispatcher(payloadFor('telegram', { text: 'Telegram alert' }));

    expect(notificationHandler).toHaveBeenCalledTimes(2);
    expect(notificationHandler.mock.calls[0]![0].subtype).toBe('slack');
    expect(notificationHandler.mock.calls[1]![0].subtype).toBe('telegram');
  });
});

describe('registry-authoritative routing', () => {
  it.each(ENTRY_CASES)(
    '%s selects the row matching entry.subtype and slugs with entry.channel',
    async (_channel, entry) => {
      const rows = rowsForKnownSubtypes();
      const notificationHandler = buildNotificationHandler();
      const dispatcher = entry.boot(buildBootDeps({
        connectionStore: buildStore(rows),
        notificationHandler,
        channel: entry.channel,
        subtype: entry.subtype,
      }));

      const out = await dispatcher(payloadFor(entry.channel));

      expect(out).toEqual({ ok: true });
      expect(notificationHandler).toHaveBeenCalledTimes(1);
      const [row, _params, call] = notificationHandler.mock.calls[0]!;
      expect(row.subtype).toBe(entry.subtype);
      expect(row.name).toBe(`record-${entry.subtype}`);
      expect(call.slug).toBe(`recued/notification-send.${entry.channel}`);
    },
  );
});

describe('NotificationChannelBootDeps contract', () => {
  it('constructs the exact four-field deps object every boot module requires', () => {
    const connectionStore = buildStore();
    const notificationHandler = buildNotificationHandler();
    const deps = buildBootDeps({
      connectionStore,
      notificationHandler,
      channel: 'in_app',
      subtype: 'in-app',
    });

    expect(keySet(deps)).toEqual([
      'channel',
      'connectionStore',
      'notificationHandler',
      'subtype',
    ]);
    expect(deps.connectionStore).toBe(connectionStore);
    expect(deps.notificationHandler).toBe(notificationHandler);
    expect(deps.channel).toBe('in_app');
    expect(deps.subtype).toBe('in-app');
  });
});

describe('pluggability seam', () => {
  it('can append a fifth registry entry whose boot wraps buildSubtypeDispatcher', async () => {
    const log: Array<{ channel: string; subtype: string; text: string }> = [];
    const smsChannel = 'sms' as NotificationChannel;
    const smsSubtype = 'sms' as NotificationSubtype;
    const smsBoot = vi.fn<NotificationChannelEntry['boot']>((deps) => {
      const inner = buildSubtypeDispatcher(deps);
      return async (payload) => {
        log.push({
          channel: deps.channel,
          subtype: deps.subtype,
          text: payload.text,
        });
        return inner(payload);
      };
    });
    const smsEntry = {
      channel: smsChannel,
      subtype: smsSubtype,
      boot: smsBoot,
    } satisfies NotificationChannelEntry;
    const rows = [
      ...rowsForKnownSubtypes(),
      buildRow({ name: 'record-sms', subtype: 'sms' }),
    ];
    const notificationHandler = buildNotificationHandler();
    const dispatchers = buildDispatchersFromRegistry(
      [...NOTIFICATION_CHANNEL_REGISTRY, smsEntry],
      {
        connectionStore: buildStore(rows),
        notificationHandler,
      },
    );

    expect(dispatchers.sms).toEqual(expect.any(Function));
    const out = await dispatchers.sms!({
      channel: smsChannel,
      text: 'SMS alert',
    });

    expect(out).toEqual({ ok: true });
    expect(smsBoot).toHaveBeenCalledTimes(1);
    expect(log).toEqual([
      { channel: 'sms', subtype: 'sms', text: 'SMS alert' },
    ]);
    const [row, _params, call] = notificationHandler.mock.calls[0]!;
    expect(row.name).toBe('record-sms');
    expect(row.subtype).toBe('sms');
    expect(call.slug).toBe('recued/notification-send.sms');
  });
});
