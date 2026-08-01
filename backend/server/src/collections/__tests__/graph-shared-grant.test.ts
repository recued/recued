import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  CalendarCollectionCaps,
  FileCollectionCaps,
} from '@recued/contracts';

import {
  createInstanceStore,
  type CollectionInstanceStore,
} from '../instance-store.js';
import {
  createCalendarAdapterRegistry,
  type CalendarAdapterContext,
  type CalendarAdapterFactory,
} from '../calendar/adapter-registry.js';
import type {
  CalendarProvider,
  CalendarProviderKind,
  ProbedCalendarCaps,
} from '../calendar/provider.js';
import {
  handleCalendarAttachGraphGrant,
  handleCalendarEnrollOAuth,
  type CalendarEnrollDeps,
} from '../calendar/enroll.js';
import {
  handleMailDelete,
  type MailAdapterType,
  type MailEnrollDeps,
} from '../mail/enroll.js';
import type {
  HttpFetcher,
  OAuthAccountStore,
} from '../mail/oauth.js';

const CALENDAR_CAPS: ProbedCalendarCaps = {
  read: 'yes',
  list_calendars: 'yes',
  create_event: 'yes',
  update_event: 'yes',
  delete_event: 'yes',
  rsvp: 'yes',
  search: 'remote',
  watch: 'poll',
  auth: 'oauth',
  recurrence: 'server',
};

const MAIL_CAPS: FileCollectionCaps = {
  read: 'yes',
  write: 'no',
  delete: 'no',
  watch: 'realtime',
  mirror: 'required',
  auth: 'oauth',
  path_style: 'uri',
};

interface RecordingAccountStore extends OAuthAccountStore {
  data: Map<string, string>;
  getKeys: string[];
  setKeys: string[];
  deletedKeys: string[];
}

const makeAccountStore = (
  seed: Record<string, string> = {},
): RecordingAccountStore => {
  const data = new Map<string, string>(Object.entries(seed));
  const getKeys: string[] = [];
  const setKeys: string[] = [];
  const deletedKeys: string[] = [];
  return {
    data,
    getKeys,
    setKeys,
    deletedKeys,
    async get(key) {
      getKeys.push(key);
      return data.get(key) ?? null;
    },
    async set(key, value) {
      setKeys.push(key);
      data.set(key, value);
    },
    async delete(key) {
      deletedKeys.push(key);
      data.delete(key);
    },
    async getAll() {
      return Object.fromEntries(data);
    },
  };
};

const makeTokenFetcher = () => vi.fn(async (
  _url: string,
  _init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => ({
  status: 200,
  ok: true,
  async json() {
    return {
      access_token: 'new-access-token',
      refresh_token: 'new-refresh-token',
      expires_in: 3_600,
      scope: 'Calendars.ReadWrite offline_access',
    };
  },
  async text() {
    return '';
  },
}));

const makeFactory = (
  kind: CalendarProviderKind,
  probe: (ctx: CalendarAdapterContext) => Promise<ProbedCalendarCaps>,
): CalendarAdapterFactory => ({
  kind,
  probeCaps: probe,
  create: () => ({ kind, slug: 'unused' }) as CalendarProvider,
});

interface Harness {
  db: Database.Database;
  instances: CollectionInstanceStore;
  account: RecordingAccountStore;
  fetcher: ReturnType<typeof makeTokenFetcher>;
  calendarDeps: CalendarEnrollDeps;
  mailDeps: MailEnrollDeps;
}

const openDatabases: Database.Database[] = [];

const makeHarness = (opts: {
  account?: Record<string, string>;
  graphProbe?: (ctx: CalendarAdapterContext) => Promise<ProbedCalendarCaps>;
  gcalProbe?: (ctx: CalendarAdapterContext) => Promise<ProbedCalendarCaps>;
  onCalendarEnrolled?: CalendarEnrollDeps['onEnrolled'];
} = {}): Harness => {
  const db = new Database(':memory:');
  openDatabases.push(db);
  const instances = createInstanceStore({ db });
  const account = makeAccountStore(opts.account);
  const fetcher = makeTokenFetcher();
  const adapters = createCalendarAdapterRegistry();
  adapters.register(makeFactory(
    'graph',
    opts.graphProbe ?? (async () => CALENDAR_CAPS),
  ));
  adapters.register(makeFactory(
    'gcal',
    opts.gcalProbe ?? (async () => CALENDAR_CAPS),
  ));

  const calendarDeps: CalendarEnrollDeps = {
    instances,
    adapters,
    accountStore: account,
    oauthConfig: () => ({
      tokenUrl: 'https://oauth.example.test/token',
      clientId: 'client-id',
      clientSecret: 'client-secret',
    }),
    fetcher: fetcher as HttpFetcher,
    onEnrolled: opts.onCalendarEnrolled,
    now: () => 1_700_000_000_000,
  };
  const mailDeps: MailEnrollDeps = {
    instances,
    accountStore: account,
  };
  return {
    db,
    instances,
    account,
    fetcher,
    calendarDeps,
    mailDeps,
  };
};

afterEach(() => {
  for (const db of openDatabases.splice(0)) db.close();
});

const putMail = (
  h: Harness,
  slug: string,
  adapter: MailAdapterType,
): void => {
  h.instances.upsert({
    platform: 'mail',
    slug,
    adapter_type: adapter,
    config: { account_slug: slug },
    caps: MAIL_CAPS,
    auth_state: 'healthy',
    last_synced_at: null,
  });
};

const putCalendar = (
  h: Harness,
  slug: string,
  adapter: 'graph' | 'gcal' | 'caldav',
): void => {
  h.instances.upsert({
    platform: 'calendar',
    slug,
    adapter_type: adapter,
    config: { account_slug: slug },
    caps: { ...CALENDAR_CAPS } as CalendarCollectionCaps,
    auth_state: 'healthy',
    last_synced_at: null,
  });
};

const seedOAuthGrant = (
  account: RecordingAccountStore,
  provider: 'graph' | 'gmail' | 'gcal',
  slug: string,
): Record<string, string> => {
  const values = {
    [`${provider}.${slug}.access_token`]: `${provider}-access`,
    [`${provider}.${slug}.refresh_token`]: `${provider}-refresh`,
    [`${provider}.${slug}.expires_at`]: '1700003600000',
    [`${provider}.${slug}.granted_scopes`]: `${provider}-scopes`,
  };
  for (const [key, value] of Object.entries(values)) {
    account.data.set(key, value);
  }
  return values;
};

const expectNoCalendarRow = (h: Harness, slug: string): void => {
  expect(h.instances.get('calendar', slug)).toBeNull();
};

describe('handleCalendarAttachGraphGrant preconditions', () => {
  it('A1 rejects when no mail instance exists and writes no calendar row', async () => {
    const h = makeHarness({
      account: { 'graph.work.refresh_token': 'refresh-token' },
    });

    await expect(
      handleCalendarAttachGraphGrant(h.calendarDeps, { slug: 'work' }),
    ).rejects.toMatchObject({ code: 'bad_request' });

    expectNoCalendarRow(h, 'work');
  });

  it('A2 rejects a non-Graph mail instance and writes no calendar row', async () => {
    const h = makeHarness({
      account: { 'graph.work.refresh_token': 'refresh-token' },
    });
    putMail(h, 'work', 'imap');

    await expect(
      handleCalendarAttachGraphGrant(h.calendarDeps, { slug: 'work' }),
    ).rejects.toMatchObject({ code: 'bad_request' });

    expectNoCalendarRow(h, 'work');
  });

  it('A3 rejects a Graph mail instance with no shared refresh token', async () => {
    const h = makeHarness();
    putMail(h, 'work', 'graph');

    await expect(
      handleCalendarAttachGraphGrant(h.calendarDeps, { slug: 'work' }),
    ).rejects.toMatchObject({ code: 'bad_request' });

    expect(h.account.getKeys).toEqual(['graph.work.refresh_token']);
    expectNoCalendarRow(h, 'work');
  });

  it('A4 rejects when the scope probe throws and leaves no calendar row', async () => {
    const h = makeHarness({
      account: { 'graph.work.refresh_token': 'refresh-token' },
      graphProbe: async () => {
        throw new Error('Calendars.ReadWrite was not granted');
      },
    });
    putMail(h, 'work', 'graph');

    await expect(
      handleCalendarAttachGraphGrant(h.calendarDeps, { slug: 'work' }),
    ).rejects.toMatchObject({ code: 'probe_failed' });

    expectNoCalendarRow(h, 'work');
  });

  it('A5 writes a healthy Graph row and scopes every probe token read to the shared prefix', async () => {
    const probeRequestedKeys: string[] = [];
    const probeValues: Array<string | null> = [];
    const h = makeHarness({
      account: {
        'graph.work.access_token': 'access-token',
        'graph.work.refresh_token': 'refresh-token',
        'graph.work.expires_at': '1700003600000',
        'graph.work.granted_scopes': 'Mail.Read Calendars.ReadWrite',
      },
      graphProbe: async (ctx) => {
        for (const key of [
          'access_token',
          'refresh_token',
          'expires_at',
          'granted_scopes',
        ]) {
          probeRequestedKeys.push(key);
          probeValues.push(await ctx.getAccountValue(key));
        }
        return CALENDAR_CAPS;
      },
    });
    putMail(h, 'work', 'graph');

    await expect(
      handleCalendarAttachGraphGrant(h.calendarDeps, { slug: 'work' }),
    ).resolves.toEqual({
      slug: 'work',
      caps: CALENDAR_CAPS,
    });

    expect(probeRequestedKeys).toEqual([
      'access_token',
      'refresh_token',
      'expires_at',
      'granted_scopes',
    ]);
    expect(probeValues).toEqual([
      'access-token',
      'refresh-token',
      '1700003600000',
      'Mail.Read Calendars.ReadWrite',
    ]);
    expect(h.account.getKeys).toEqual([
      'graph.work.refresh_token',
      'graph.work.access_token',
      'graph.work.refresh_token',
      'graph.work.expires_at',
      'graph.work.granted_scopes',
    ]);
    expect(h.instances.get('calendar', 'work')).toMatchObject({
      platform: 'calendar',
      slug: 'work',
      adapter_type: 'graph',
      auth_state: 'healthy',
    });
  });

  it('A6 performs no token exchange because the mail enrollment already spent the code', async () => {
    const h = makeHarness({
      account: { 'graph.work.refresh_token': 'refresh-token' },
    });
    putMail(h, 'work', 'graph');

    await handleCalendarAttachGraphGrant(h.calendarDeps, { slug: 'work' });

    expect(h.fetcher).not.toHaveBeenCalled();
  });
});

describe('handleCalendarAttachGraphGrant idempotency and retry safety', () => {
  it('B1 succeeds twice and retains exactly one calendar row', async () => {
    const graphProbe = vi.fn(async () => CALENDAR_CAPS);
    const h = makeHarness({
      account: { 'graph.work.refresh_token': 'refresh-token' },
      graphProbe,
    });
    putMail(h, 'work', 'graph');

    const first = await handleCalendarAttachGraphGrant(
      h.calendarDeps,
      { slug: 'work' },
    );
    const second = await handleCalendarAttachGraphGrant(
      h.calendarDeps,
      { slug: 'work' },
    );

    expect(first).toEqual(second);
    expect(first).toEqual({ slug: 'work', caps: CALENDAR_CAPS });
    expect(
      h.instances.list('calendar').filter((row) => row.slug === 'work'),
    ).toHaveLength(1);
    expect(graphProbe).toHaveBeenCalledTimes(1);
  });

  it('B2 conflicts with an existing calendar row on a different adapter', async () => {
    const h = makeHarness({
      account: { 'graph.work.refresh_token': 'refresh-token' },
    });
    putMail(h, 'work', 'graph');
    putCalendar(h, 'work', 'caldav');

    await expect(
      handleCalendarAttachGraphGrant(h.calendarDeps, { slug: 'work' }),
    ).rejects.toMatchObject({ code: 'conflict' });

    expect(h.instances.get('calendar', 'work')?.adapter_type).toBe('caldav');
  });

  it('B3 commits before adapter startup failure and then accepts an idempotent retry', async () => {
    const onEnrolled = vi.fn(async () => undefined);
    onEnrolled.mockRejectedValueOnce(new Error('adapter failed to start'));
    const h = makeHarness({
      account: { 'graph.work.refresh_token': 'refresh-token' },
      onCalendarEnrolled: onEnrolled,
    });
    putMail(h, 'work', 'graph');

    await expect(
      handleCalendarAttachGraphGrant(h.calendarDeps, { slug: 'work' }),
    ).rejects.toMatchObject({ code: 'adapter_start_failed' });

    expect(h.instances.get('calendar', 'work')).toMatchObject({
      adapter_type: 'graph',
      auth_state: 'healthy',
    });

    await expect(
      handleCalendarAttachGraphGrant(h.calendarDeps, { slug: 'work' }),
    ).resolves.toEqual({ slug: 'work', caps: CALENDAR_CAPS });
    expect(
      h.instances.list('calendar').filter((row) => row.slug === 'work'),
    ).toHaveLength(1);
  });
});

describe('handleCalendarEnrollOAuth shared-grant clobber protection', () => {
  it('C1 rejects Graph OAuth beside Graph mail before token exchange and preserves the grant', async () => {
    const h = makeHarness();
    putMail(h, 'work', 'graph');
    const originalGrant = seedOAuthGrant(h.account, 'graph', 'work');

    await expect(
      handleCalendarEnrollOAuth(h.calendarDeps, {
        slug: 'work',
        adapter: 'graph',
        oauth_code: 'single-use-code',
        oauth_redirect_uri: 'https://app.example.test/oauth/callback',
      }),
    ).rejects.toMatchObject({ code: 'conflict' });

    expect(h.fetcher).not.toHaveBeenCalled();
    expect(Object.fromEntries(h.account.data)).toEqual(originalGrant);
    expectNoCalendarRow(h, 'work');
  });

  it('C2 allows Graph OAuth beside an IMAP mail instance', async () => {
    const h = makeHarness();
    putMail(h, 'work', 'imap');

    await expect(
      handleCalendarEnrollOAuth(h.calendarDeps, {
        slug: 'work',
        adapter: 'graph',
        oauth_code: 'calendar-code',
        oauth_redirect_uri: 'https://app.example.test/oauth/callback',
      }),
    ).resolves.toEqual({ slug: 'work', caps: CALENDAR_CAPS });

    // The token exchange DID happen — asserted by the call the exchange makes,
    // not by a raw call count. A `graph` enroll also reads `/me` to record the
    // grant's owner identity, so the count is incidental and pinning it made
    // this test fail on an unrelated (and correct) addition.
    expect(h.fetcher.mock.calls.some(([url]) => String(url).includes('/token'))).toBe(true);
    expect(h.instances.get('calendar', 'work')?.adapter_type).toBe('graph');
  });

  it('C3 allows Google Calendar OAuth beside Gmail and keeps the prefixes separate', async () => {
    const h = makeHarness();
    putMail(h, 'work', 'gmail');
    h.account.data.set('gmail.work.refresh_token', 'gmail-refresh');

    await expect(
      handleCalendarEnrollOAuth(h.calendarDeps, {
        slug: 'work',
        adapter: 'gcal',
        oauth_code: 'calendar-code',
        oauth_redirect_uri: 'https://app.example.test/oauth/callback',
      }),
    ).resolves.toEqual({ slug: 'work', caps: CALENDAR_CAPS });

    expect(h.fetcher).toHaveBeenCalledTimes(1);
    expect(h.account.data.get('gmail.work.refresh_token')).toBe('gmail-refresh');
    expect(h.account.data.get('gcal.work.refresh_token')).toBe('new-refresh-token');
    expect(h.instances.get('calendar', 'work')?.adapter_type).toBe('gcal');
  });
});

describe('handleMailDelete shared-grant cleanup', () => {
  it('D1 removes Graph mail but preserves credentials used by a Graph calendar', async () => {
    const h = makeHarness();
    putMail(h, 'work', 'graph');
    putCalendar(h, 'work', 'graph');
    const grant = seedOAuthGrant(h.account, 'graph', 'work');

    await expect(
      handleMailDelete(h.mailDeps, { slug: 'work' }),
    ).resolves.toEqual({ ok: true });

    expect(h.instances.get('mail', 'work')).toBeNull();
    expect(h.instances.get('calendar', 'work')?.adapter_type).toBe('graph');
    for (const [key, value] of Object.entries(grant)) {
      expect(h.account.data.get(key)).toBe(value);
    }
    expect(h.account.deletedKeys).toEqual([]);
  });

  it('D2 deletes Graph credentials when no calendar row shares them', async () => {
    const h = makeHarness();
    putMail(h, 'work', 'graph');
    const grant = seedOAuthGrant(h.account, 'graph', 'work');

    await handleMailDelete(h.mailDeps, { slug: 'work' });

    expect(h.instances.get('mail', 'work')).toBeNull();
    for (const key of Object.keys(grant)) {
      expect(h.account.data.has(key)).toBe(false);
    }
    expect(h.account.deletedKeys).toEqual(Object.keys(grant));
  });

  it('D3 deletes Gmail credentials while leaving a same-slug GCal row untouched', async () => {
    const h = makeHarness();
    putMail(h, 'work', 'gmail');
    putCalendar(h, 'work', 'gcal');
    const gmailGrant = seedOAuthGrant(h.account, 'gmail', 'work');
    h.account.data.set('gcal.work.refresh_token', 'gcal-refresh');

    await handleMailDelete(h.mailDeps, { slug: 'work' });

    for (const key of Object.keys(gmailGrant)) {
      expect(h.account.data.has(key)).toBe(false);
    }
    expect(h.account.data.get('gcal.work.refresh_token')).toBe('gcal-refresh');
    expect(h.instances.get('calendar', 'work')?.adapter_type).toBe('gcal');
  });

  it('D4 deletes both IMAP password keys', async () => {
    const h = makeHarness();
    putMail(h, 'work', 'imap');
    h.account.data.set('imap.work.password', 'imap-password');
    h.account.data.set('imap.work.smtp_password', 'smtp-password');

    await handleMailDelete(h.mailDeps, { slug: 'work' });

    expect(h.instances.get('mail', 'work')).toBeNull();
    expect(h.account.data.has('imap.work.password')).toBe(false);
    expect(h.account.data.has('imap.work.smtp_password')).toBe(false);
    expect(h.account.deletedKeys).toEqual([
      'imap.work.password',
      'imap.work.smtp_password',
    ]);
  });
});
