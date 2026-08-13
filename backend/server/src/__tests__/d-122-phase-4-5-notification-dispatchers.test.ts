/** D-122 follow-on — `notification-send` dispatcher bridge tests.
 *
 *  Verifies the bridge that connects the kernel `notification-send` rpc
 *  to the connection-notification handler for the four channels
 *  (slack / telegram / email / in_app). Channel → subtype mapping,
 *  per-call connection record selection, and result-envelope
 *  translation are the load-bearing concerns; per-channel transport
 *  semantics (slack chat.postMessage, telegram sendMessage, mail rpc,
 *  in-app bus) are covered by the connection-notification handler's
 *  own tests in `packages/ingredients/src/__tests__/d-125-phase-4-3-*`.
 *
 *  These tests exercise the registry + per-channel boot modules end-to-
 *  end: `buildAllDispatchersViaRegistry` mirrors what
 *  `composeConnectionNotification` does (iterate the registry, call
 *  each entry's `boot`, collect into a channel-keyed map). The shared
 *  closure body lives in `buildSubtypeDispatcher`; each per-channel
 *  boot in `data/notification/<channel>/boot.ts` invokes it. */

import { describe, expect, it } from 'vitest';
import type {
  ConnectionRow,
  ConnectionKind,
} from '@recued/contracts';
import { NOTIFICATION_DELIVERY_CHANNELS, totalRecord } from '@recued/contracts';
import type { ConnectionKindHandler } from '@recued/ingredients';
import { IngredientError } from '@recued/ingredients';
import { NOTIFICATION_CHANNEL_REGISTRY } from '../data/notification-channel-registry.js';
import type {
  NotificationChannel,
  NotificationChannelDispatcher,
} from '../notification-handler.js';
import type { ConnectionStoreSqlite } from '../storage/connection-store.js';

// ────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────

const buildRow = (overrides: Partial<ConnectionRow> & Pick<ConnectionRow, 'name' | 'subtype'>): ConnectionRow => ({
  pk: `notification:${overrides.name}`,
  kind: 'notification',
  display_name: overrides.name,
  config_json: '{}',
  auth_ciphertext: '',
  enrolled_at: 1,
  updated_at: 1,
  ...overrides,
});

const buildStore = (rows: ConnectionRow[]): ConnectionStoreSqlite => {
  const store = {
    upsert: () => { throw new Error('not implemented in stub'); },
    get: (kind: ConnectionKind, name: string) =>
      rows.find((r) => r.kind === kind && r.name === name) ?? null,
    list: (query?: { kind?: ConnectionKind }) =>
      query?.kind ? rows.filter((r) => r.kind === query.kind) : rows.slice(),
    listSince: () => [],
    delete: () => false,
    count: () => rows.length,
  } as unknown as ConnectionStoreSqlite;
  return store;
};

// Mirrors the composer's `for (entry of NOTIFICATION_CHANNEL_REGISTRY)`
// loop — including threading `entry.channel` + `entry.subtype` into
// the boot call — so the tests below exercise the same boot path
// bin.ts wires.
const buildAllDispatchersViaRegistry = (deps: {
  connectionStore: ConnectionStoreSqlite;
  notificationHandler: ConnectionKindHandler;
}): Record<NotificationChannel, NotificationChannelDispatcher> => {
  // Mirrors the production wiring (`wire-connection-notification`), which builds
  // by LOOKUP over the derived channel list and throws on a gap — so this helper
  // cannot quietly return a map missing a channel while claiming to be total.
  const booted = new Map<NotificationChannel, NotificationChannelDispatcher>();
  for (const entry of NOTIFICATION_CHANNEL_REGISTRY) {
    booted.set(entry.channel, entry.boot({
      ...deps,
      channel: entry.channel,
      subtype: entry.subtype,
    }));
  }
  return totalRecord(NOTIFICATION_DELIVERY_CHANNELS, (channel) => {
    const dispatcher = booted.get(channel);
    if (dispatcher === undefined) {
      throw new Error(`no dispatcher booted for channel '${channel}'`);
    }
    return dispatcher;
  });
};

// ────────────────────────────────────────────────────────────────
// channel → subtype mapping
// ────────────────────────────────────────────────────────────────

describe('D-122 follow-on — channel → subtype dispatch routing', () => {
  it('routes "slack" through the connection record with subtype="slack"', async () => {
    const calls: ConnectionRow[] = [];
    const handler: ConnectionKindHandler = async (record) => {
      calls.push(record);
      return { status: 'ok', result: {}, headers: undefined };
    };
    const dispatchers = buildAllDispatchersViaRegistry({
      connectionStore: buildStore([
        buildRow({ name: 'work', subtype: 'slack' }),
        buildRow({ name: 'team-chat', subtype: 'telegram' }),
      ]),
      notificationHandler: handler,
    });

    const out = await dispatchers.slack({ channel: 'slack', text: 'Hello slack' });

    expect(out.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.subtype).toBe('slack');
    expect(calls[0]?.name).toBe('work');
  });

  it('routes "telegram" through the connection record with subtype="telegram"', async () => {
    const calls: ConnectionRow[] = [];
    const handler: ConnectionKindHandler = async (record) => {
      calls.push(record);
      return { status: 'ok', result: {}, headers: undefined };
    };
    const dispatchers = buildAllDispatchersViaRegistry({
      connectionStore: buildStore([buildRow({ name: 'team', subtype: 'telegram' })]),
      notificationHandler: handler,
    });

    const out = await dispatchers.telegram({ channel: 'telegram', text: 'Hello tg' });

    expect(out.ok).toBe(true);
    expect(calls[0]?.subtype).toBe('telegram');
  });

  it('routes "email" through the connection record with subtype="email"', async () => {
    const calls: ConnectionRow[] = [];
    const handler: ConnectionKindHandler = async (record) => {
      calls.push(record);
      return { status: 'ok', result: {}, headers: undefined };
    };
    const dispatchers = buildAllDispatchersViaRegistry({
      connectionStore: buildStore([buildRow({ name: 'gmail-personal', subtype: 'email' })]),
      notificationHandler: handler,
    });

    const out = await dispatchers.email({ channel: 'email', text: 'Hello email' });

    expect(out.ok).toBe(true);
    expect(calls[0]?.subtype).toBe('email');
    expect(calls[0]?.name).toBe('gmail-personal');
  });

  it('maps the underscore "in_app" channel name to the dashed "in-app" subtype', async () => {
    const calls: ConnectionRow[] = [];
    const handler: ConnectionKindHandler = async (record) => {
      calls.push(record);
      return { status: 'ok', result: undefined, headers: undefined };
    };
    const dispatchers = buildAllDispatchersViaRegistry({
      connectionStore: buildStore([buildRow({ name: 'broadcast', subtype: 'in-app' })]),
      notificationHandler: handler,
    });

    const out = await dispatchers.in_app({ channel: 'in_app', text: 'Hello bus' });

    expect(out.ok).toBe(true);
    expect(calls[0]?.subtype).toBe('in-app');
  });
});

// ────────────────────────────────────────────────────────────────
// no-record / unbound behavior
// ────────────────────────────────────────────────────────────────

describe('D-122 follow-on — unbound channels surface NO_CONNECTION_BOUND', () => {
  it('returns ok=false reason=NO_CONNECTION_BOUND when no record matches the channel subtype', async () => {
    const handler: ConnectionKindHandler = async () => {
      throw new Error('handler should not be invoked');
    };
    const dispatchers = buildAllDispatchersViaRegistry({
      connectionStore: buildStore([buildRow({ name: 'work', subtype: 'slack' })]),
      notificationHandler: handler,
    });

    const out = await dispatchers.email({ channel: 'email', text: 'No email enrolled' });

    expect(out.ok).toBe(false);
    expect(out.reason).toBe('NO_CONNECTION_BOUND');
  });

  it('returns NO_CONNECTION_BOUND for every channel when the store is empty', async () => {
    const handler: ConnectionKindHandler = async () => {
      throw new Error('handler should not be invoked');
    };
    const dispatchers = buildAllDispatchersViaRegistry({
      connectionStore: buildStore([]),
      notificationHandler: handler,
    });

    const channels = ['slack', 'telegram', 'email', 'in_app'] as const;
    for (const channel of channels) {
      const out = await dispatchers[channel]({ channel, text: 'unbound' });
      expect(out.ok).toBe(false);
      expect(out.reason).toBe('NO_CONNECTION_BOUND');
    }
  });
});

// ────────────────────────────────────────────────────────────────
// envelope translation
// ────────────────────────────────────────────────────────────────

describe('D-122 follow-on — handler-envelope translation', () => {
  it('translates status="send_error" into ok=false reason=<vendor.error>', async () => {
    const handler: ConnectionKindHandler = async () => ({
      status: 'send_error',
      result: { vendor: 'slack', error: 'channel_not_found' },
      headers: undefined,
    });
    const dispatchers = buildAllDispatchersViaRegistry({
      connectionStore: buildStore([buildRow({ name: 'work', subtype: 'slack' })]),
      notificationHandler: handler,
    });

    const out = await dispatchers.slack({ channel: 'slack', text: 'bad channel' });

    expect(out.ok).toBe(false);
    expect(out.reason).toBe('channel_not_found');
  });

  it('translates a thrown IngredientError into ok=false reason=<error.code>', async () => {
    const handler: ConnectionKindHandler = async () => {
      throw new IngredientError('OAUTH_EXPIRED', 'token expired', { name: 'work' });
    };
    const dispatchers = buildAllDispatchersViaRegistry({
      connectionStore: buildStore([buildRow({ name: 'work', subtype: 'slack' })]),
      notificationHandler: handler,
    });

    const out = await dispatchers.slack({ channel: 'slack', text: 'expired auth' });

    expect(out.ok).toBe(false);
    expect(out.reason).toBe('OAUTH_EXPIRED');
  });

  it('translates a thrown plain Error into ok=false reason=<error.message>', async () => {
    const handler: ConnectionKindHandler = async () => {
      throw new Error('network down');
    };
    const dispatchers = buildAllDispatchersViaRegistry({
      connectionStore: buildStore([buildRow({ name: 'work', subtype: 'slack' })]),
      notificationHandler: handler,
    });

    const out = await dispatchers.slack({ channel: 'slack', text: 'bad network' });

    expect(out.ok).toBe(false);
    expect(out.reason).toBe('network down');
  });

  it('translates an unrecognized envelope shape into ok=false reason=unexpected_envelope', async () => {
    // Handler returns a non-`status` envelope — the dispatch translator
    // falls through both the `'ok'` and `'send_error'` branches and
    // emits the `unexpected_envelope` reason so the failed[] row
    // surfaces a stable diagnostic instead of crashing or leaking
    // prose. Defends against silent regressions if a future subtype
    // dispatcher returns the wrong envelope shape.
    const handler: ConnectionKindHandler = async () => ({
      unknown_field: 'opaque',
    });
    const dispatchers = buildAllDispatchersViaRegistry({
      connectionStore: buildStore([buildRow({ name: 'work', subtype: 'slack' })]),
      notificationHandler: handler,
    });

    const out = await dispatchers.slack({ channel: 'slack', text: 'opaque' });

    expect(out).toEqual({ ok: false, reason: 'unexpected_envelope' });
  });

  it('forwards text + title + link_url verbatim into params', async () => {
    let capturedParams: Record<string, unknown> | null = null;
    const handler: ConnectionKindHandler = async (_row, params) => {
      capturedParams = params;
      return { status: 'ok', result: {}, headers: undefined };
    };
    const dispatchers = buildAllDispatchersViaRegistry({
      connectionStore: buildStore([buildRow({ name: 'work', subtype: 'slack' })]),
      notificationHandler: handler,
    });

    await dispatchers.slack({
      channel: 'slack',
      text: 'Body content',
      title: 'Heading',
      link_url: 'https://example.com/x',
    });

    expect(capturedParams).toMatchObject({
      text: 'Body content',
      title: 'Heading',
      link_url: 'https://example.com/x',
    });
  });
});

// ────────────────────────────────────────────────────────────────
// re-enrollment liveness — store rescanned per call
// ────────────────────────────────────────────────────────────────

describe('D-122 follow-on — store rescanned on every call (re-enrollment liveness)', () => {
  it('picks up a freshly-enrolled connection without rebuilding the dispatcher', async () => {
    const rows: ConnectionRow[] = [];
    const store = buildStore(rows);
    const handler: ConnectionKindHandler = async () => ({ status: 'ok', result: {}, headers: undefined });
    const dispatchers = buildAllDispatchersViaRegistry({
      connectionStore: store,
      notificationHandler: handler,
    });

    // Initial state — no slack record.
    const out1 = await dispatchers.slack({ channel: 'slack', text: 'first call' });
    expect(out1).toEqual({ ok: false, reason: 'NO_CONNECTION_BOUND' });

    // User enrolls a slack connection — pushes the record into the
    // shared array. The dispatcher closure was built before this; if
    // the bridge cached at boot it would still report NO_CONNECTION_BOUND.
    rows.push(buildRow({ name: 'work', subtype: 'slack' }));

    const out2 = await dispatchers.slack({ channel: 'slack', text: 'second call' });
    expect(out2).toEqual({ ok: true });
  });

  it('synthesizes a ResolvedCall with risk_tier=write for transport classification', async () => {
    const captured: Array<{ slug: string; risk_tier: string }> = [];
    const handler: ConnectionKindHandler = async (_row, _params, call) => {
      captured.push({ slug: call.slug, risk_tier: call.risk_tier });
      return { status: 'ok', result: {}, headers: undefined };
    };
    const dispatchers = buildAllDispatchersViaRegistry({
      connectionStore: buildStore([buildRow({ name: 'work', subtype: 'slack' })]),
      notificationHandler: handler,
    });

    await dispatchers.slack({ channel: 'slack', text: 'classify me' });

    expect(captured[0]?.risk_tier).toBe('write');
    expect(captured[0]?.slug).toBe('recued/notification-send.slack');
  });
});

// ────────────────────────────────────────────────────────────────
// registry authoritativeness — each entry's (channel, subtype) is the
// truth at runtime, not a hint that boot modules can ignore
// ────────────────────────────────────────────────────────────────

describe('D-122 follow-on — registry (channel, subtype) is authoritative at runtime', () => {
  it.each(NOTIFICATION_CHANNEL_REGISTRY.map((entry) => ({
    channel: entry.channel,
    subtype: entry.subtype,
  })))(
    'channel=$channel resolves the connection row whose subtype=$subtype + carries the channel-suffixed slug',
    async ({ channel, subtype }) => {
      // Build a store with one row per known subtype so the
      // dispatcher's `find` has to discriminate by subtype rather than
      // pick the only row available.
      const rows: ConnectionRow[] = NOTIFICATION_CHANNEL_REGISTRY.map((entry) =>
        buildRow({ name: `record-${entry.subtype}`, subtype: entry.subtype }));

      const calls: Array<{ row: ConnectionRow; slug: string }> = [];
      const handler: ConnectionKindHandler = async (row, _params, call) => {
        calls.push({ row, slug: call.slug });
        return { status: 'ok', result: {}, headers: undefined };
      };
      const dispatchers = buildAllDispatchersViaRegistry({
        connectionStore: buildStore(rows),
        notificationHandler: handler,
      });

      const out = await dispatchers[channel]({ channel, text: 'route check' });

      expect(out.ok).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.row.subtype).toBe(subtype);
      expect(calls[0]?.row.name).toBe(`record-${subtype}`);
      // Slug uses the channel id (underscore for `in_app`), not the
      // subtype (dash for `in-app`) — proves both labels flow through.
      expect(calls[0]?.slug).toBe(`recued/notification-send.${channel}`);
    },
  );
});
