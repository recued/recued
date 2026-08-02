import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CalendarCollectionCaps } from '@recued/contracts';

import {
  createInstanceStore,
  type CollectionInstanceStore,
} from '../instance-store.js';
import {
  createCalendarAdapterRegistry,
  type CalendarAdapterContext,
  type CalendarAdapterFactory,
} from '../calendar/adapter-registry.js';
import {
  handleCalendarEnrollOAuth,
  type CalendarEnrollDeps,
} from '../calendar/enroll.js';
import type {
  CalendarProvider,
  CalendarProviderKind,
  ProbedCalendarCaps,
} from '../calendar/provider.js';
import {
  handleMailEnrollOAuth,
  type MailEnrollDeps,
} from '../mail/enroll.js';
import {
  fetchGraphGrantIdentity,
  graphGrantIdentitiesMatch,
  readGraphGrantIdentity,
  restoreGraphGrant,
  snapshotGraphGrant,
  writeGraphGrantIdentity,
  type GraphGrantSnapshot,
  type HttpFetcher,
  type OAuthAccountStore,
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

const TOKEN_URL = 'https://oauth.example.test/token';
const GRAPH_ME_URL = 'https://graph.microsoft.com/v1.0/me';
const GRAPH_IDENTITY_URL = `${GRAPH_ME_URL}?$select=id`;
const GRAPH_GRANT_KEYS = [
  'access_token',
  'refresh_token',
  'expires_at',
  'granted_scopes',
  'grant_identity',
] as const;

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

type HttpResponse = Awaited<ReturnType<HttpFetcher>>;

const jsonResponse = (
  body: unknown,
  opts: { ok?: boolean; status?: number } = {},
): HttpResponse => ({
  status: opts.status ?? 200,
  ok: opts.ok ?? true,
  async json() {
    return body;
  },
  async text() {
    return JSON.stringify(body);
  },
});

const makeOAuthFetcher = (opts: {
  accessToken?: string;
  refreshToken?: string;
  scope?: string;
  subject?: string;
  subjectByAccessToken?: Readonly<Record<string, string | null>>;
  accountEmail?: string;
} = {}) => vi.fn(async (
  url: string,
  _init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => {
  if (url === TOKEN_URL) {
    return jsonResponse({
      access_token: opts.accessToken ?? 'new-access-token',
      refresh_token: opts.refreshToken ?? 'new-refresh-token',
      expires_in: 3_600,
      scope: opts.scope ?? 'Mail.Read Calendars.ReadWrite offline_access',
    });
  }
  if (url.startsWith(GRAPH_ME_URL)) {
    const authorization = _init?.headers?.Authorization ?? '';
    const accessToken = authorization.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length)
      : '';
    const hasMappedSubject = Object.prototype.hasOwnProperty.call(
      opts.subjectByAccessToken ?? {},
      accessToken,
    );
    const mappedSubject = hasMappedSubject
      ? opts.subjectByAccessToken?.[accessToken]
      : undefined;
    if (mappedSubject === null) {
      return jsonResponse({ error: 'identity_unavailable' }, { ok: false, status: 503 });
    }
    return jsonResponse({
      id: mappedSubject ?? opts.subject ?? 'new-subject',
      userPrincipalName: opts.accountEmail ?? 'owner@example.test',
    });
  }
  throw new Error(`unexpected fetch: ${url}`);
});

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
  fetcher: ReturnType<typeof makeOAuthFetcher>;
  calendarDeps: CalendarEnrollDeps;
  mailDeps: MailEnrollDeps;
}

const openDatabases: Database.Database[] = [];

const makeHarness = (opts: {
  account?: Record<string, string>;
  fetcher?: ReturnType<typeof makeOAuthFetcher>;
} = {}): Harness => {
  const db = new Database(':memory:');
  openDatabases.push(db);
  const instances = createInstanceStore({ db });
  const account = makeAccountStore(opts.account);
  const fetcher = opts.fetcher ?? makeOAuthFetcher();
  const adapters = createCalendarAdapterRegistry();
  adapters.register(makeFactory('graph', async () => CALENDAR_CAPS));
  adapters.register(makeFactory('gcal', async () => CALENDAR_CAPS));

  const calendarDeps: CalendarEnrollDeps = {
    instances,
    adapters,
    accountStore: account,
    oauthConfig: () => ({
      tokenUrl: TOKEN_URL,
      clientId: 'client-id',
      clientSecret: 'client-secret',
    }),
    fetcher: fetcher as HttpFetcher,
    now: () => 1_700_000_000_000,
  };
  const mailDeps: MailEnrollDeps = {
    instances,
    accountStore: account,
    oauthConfig: () => ({
      tokenUrl: TOKEN_URL,
      clientId: 'client-id',
      clientSecret: 'client-secret',
    }),
    fetcher: fetcher as HttpFetcher,
    now: () => 1_700_000_000_000,
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

const graphGrant = (
  subject: string,
  opts: { includeIdentity?: boolean } = {},
): Record<string, string> => ({
  'graph.work.access_token': `access-${subject}`,
  'graph.work.refresh_token': `refresh-${subject}`,
  'graph.work.expires_at': '1700003600000',
  'graph.work.granted_scopes': 'Mail.Read Calendars.ReadWrite offline_access',
  ...(opts.includeIdentity === false
    ? {}
    : {
        'graph.work.grant_identity': JSON.stringify({ subject }),
      }),
});

const overwriteAllGraphGrantKeys = (
  account: RecordingAccountStore,
  valuePrefix: string,
): void => {
  for (const key of GRAPH_GRANT_KEYS) {
    account.data.set(`graph.work.${key}`, `${valuePrefix}-${key}`);
  }
};

const enrollGraphMail = (h: Harness) => handleMailEnrollOAuth(h.mailDeps, {
  adapter: 'graph',
  account_slug: 'work',
  code: 'single-use-code',
  redirect_uri: 'https://app.example.test/oauth/callback',
});

const enrollCalendar = (
  h: Harness,
  adapter: 'graph' | 'gcal',
) => handleCalendarEnrollOAuth(h.calendarDeps, {
  slug: 'work',
  adapter,
  oauth_code: 'single-use-code',
  oauth_redirect_uri: 'https://app.example.test/oauth/callback',
});

const makeJwt = (claims: Record<string, unknown>): string => [
  Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
  Buffer.from(JSON.stringify(claims)).toString('base64url'),
  Buffer.from('signature').toString('base64url'),
].join('.');

describe('graphGrantIdentitiesMatch', () => {
  it('A1 returns true for the same subject and tenant', () => {
    expect(graphGrantIdentitiesMatch(
      { subject: 'subject-a', tenant: 'tenant-a' },
      { subject: 'subject-a', tenant: 'tenant-a' },
    )).toBe(true);
  });

  it('A2 returns false for the same subject in different known tenants', () => {
    expect(graphGrantIdentitiesMatch(
      { subject: 'subject-a', tenant: 'tenant-a' },
      { subject: 'subject-a', tenant: 'tenant-b' },
    )).toBe(false);
  });

  it.each([
    [{ subject: 'subject-a' }, { subject: 'subject-b' }],
    [
      { subject: 'subject-a', tenant: 'tenant-a' },
      { subject: 'subject-b', tenant: 'tenant-a' },
    ],
    [
      { subject: 'subject-a', tenant: 'tenant-a' },
      { subject: 'subject-b', tenant: 'tenant-b' },
    ],
  ])('A3 returns false for different subjects regardless of tenant', (a, b) => {
    expect(graphGrantIdentitiesMatch(a, b)).toBe(false);
  });

  it('A4 returns true when the subject matches and either tenant is absent', () => {
    expect(graphGrantIdentitiesMatch(
      { subject: 'subject-a' },
      { subject: 'subject-a', tenant: 'tenant-a' },
    )).toBe(true);
    expect(graphGrantIdentitiesMatch(
      { subject: 'subject-a', tenant: 'tenant-a' },
      { subject: 'subject-a' },
    )).toBe(true);
  });
});

describe('fetchGraphGrantIdentity', () => {
  it('B1 reads the Graph subject and the tid from a real three-part base64url JWT', async () => {
    const token = makeJwt({ tid: 'tenant-a', aud: 'graph' });
    const fetcher = vi.fn(async () => jsonResponse({ id: 'subject-a' }));

    await expect(
      fetchGraphGrantIdentity(token, fetcher as HttpFetcher),
    ).resolves.toEqual({ subject: 'subject-a', tenant: 'tenant-a' });
    expect(fetcher).toHaveBeenCalledWith(GRAPH_IDENTITY_URL, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
  });

  it('B2 accepts an opaque access token and returns a subject without a tenant', async () => {
    const fetcher = vi.fn(async () => jsonResponse({ id: 'subject-a' }));

    await expect(
      fetchGraphGrantIdentity('opaque-access-token', fetcher as HttpFetcher),
    ).resolves.toEqual({ subject: 'subject-a' });
  });

  it('B3 returns null when /me is non-ok', async () => {
    const fetcher = vi.fn(async () => jsonResponse(
      { error: 'unauthorized' },
      { ok: false, status: 401 },
    ));

    await expect(
      fetchGraphGrantIdentity('opaque-access-token', fetcher as HttpFetcher),
    ).resolves.toBeNull();
  });

  it('B3 returns null when /me throws', async () => {
    const fetcher = vi.fn(async () => {
      throw new Error('network unavailable');
    });

    await expect(
      fetchGraphGrantIdentity('opaque-access-token', fetcher as HttpFetcher),
    ).resolves.toBeNull();
  });

  it('B3 returns null when /me omits id', async () => {
    const fetcher = vi.fn(async () => jsonResponse({ displayName: 'Owner' }));

    await expect(
      fetchGraphGrantIdentity('opaque-access-token', fetcher as HttpFetcher),
    ).resolves.toBeNull();
  });
});

describe('Graph grant identity storage', () => {
  it('round-trips the identity through the graph-scoped account key', async () => {
    const account = makeAccountStore();

    await writeGraphGrantIdentity(account, 'work', {
      subject: 'subject-a',
      tenant: 'tenant-a',
    });

    expect(account.data.get('graph.work.grant_identity')).toBe(
      JSON.stringify({ subject: 'subject-a', tenant: 'tenant-a' }),
    );
    await expect(readGraphGrantIdentity(account, 'work')).resolves.toEqual({
      subject: 'subject-a',
      tenant: 'tenant-a',
    });
  });
});

describe('snapshotGraphGrant and restoreGraphGrant', () => {
  it('C1 restores all five keys to their snapshot values after an overwrite', async () => {
    const original = graphGrant('old-subject');
    const account = makeAccountStore(original);
    const snapshot = await snapshotGraphGrant(account, 'work');
    overwriteAllGraphGrantKeys(account, 'replacement');

    await expect(restoreGraphGrant(account, 'work', snapshot)).resolves.toBe(true);

    expect(Object.fromEntries(account.data)).toEqual(original);
  });

  it('C2 deletes a key that was absent when the snapshot was taken', async () => {
    const original = graphGrant('old-subject', { includeIdentity: false });
    const account = makeAccountStore(original);
    const snapshot = await snapshotGraphGrant(account, 'work');
    overwriteAllGraphGrantKeys(account, 'replacement');

    await restoreGraphGrant(account, 'work', snapshot);

    expect(account.data.has('graph.work.grant_identity')).toBe(false);
    expect(account.deletedKeys).toContain('graph.work.grant_identity');
    expect(Object.fromEntries(account.data)).toEqual(original);
  });

  it('C3 returns false after a store write throws and true when every write succeeds', async () => {
    const snapshot: GraphGrantSnapshot = {
      access_token: 'old-access',
      refresh_token: 'old-refresh',
      expires_at: 'old-expiry',
      granted_scopes: 'old-scopes',
      grant_identity: 'old-identity',
    };
    const failing = makeAccountStore();
    const set = failing.set.bind(failing);
    failing.set = async (key, value) => {
      if (key === 'graph.work.expires_at') throw new Error('write failed');
      await set(key, value);
    };

    await expect(restoreGraphGrant(failing, 'work', snapshot)).resolves.toBe(false);
    expect(failing.data.get('graph.work.access_token')).toBe('old-access');
    expect(failing.data.has('graph.work.expires_at')).toBe(false);
    expect(failing.data.get('graph.work.grant_identity')).toBe('old-identity');

    const healthy = makeAccountStore();
    await expect(restoreGraphGrant(healthy, 'work', snapshot)).resolves.toBe(true);
    expect(Object.fromEntries(healthy.data)).toEqual({
      'graph.work.access_token': 'old-access',
      'graph.work.refresh_token': 'old-refresh',
      'graph.work.expires_at': 'old-expiry',
      'graph.work.granted_scopes': 'old-scopes',
      'graph.work.grant_identity': 'old-identity',
    });
  });
});

describe('handleMailEnrollOAuth Graph shared-grant identity protection', () => {
  it('D1 allows the same account when the new grant includes calendar scope', async () => {
    const fetcher = makeOAuthFetcher({ subject: 'shared-subject' });
    const h = makeHarness({
      account: graphGrant('shared-subject'),
      fetcher,
    });
    putCalendar(h, 'work', 'graph');

    await expect(enrollGraphMail(h)).resolves.toMatchObject({ slug: 'work' });

    expect(h.instances.get('mail', 'work')).toMatchObject({
      adapter_type: 'graph',
      auth_state: 'healthy',
    });
    expect(h.account.data.get('graph.work.granted_scopes')).toContain(
      'Calendars.ReadWrite',
    );
  });

  it('D2 rejects a different account, fully restores the grant, and writes no mail row', async () => {
    const fetcher = makeOAuthFetcher({ subject: 'different-subject' });
    const h = makeHarness({
      account: graphGrant('calendar-subject'),
      fetcher,
    });
    putCalendar(h, 'work', 'graph');
    const before = Object.fromEntries(h.account.data);

    await expect(enrollGraphMail(h)).rejects.toMatchObject({ code: 'conflict' });

    expect(fetcher.mock.calls.some(([url]) => url === TOKEN_URL)).toBe(true);
    expect(fetcher.mock.calls.some(([url]) => url === GRAPH_IDENTITY_URL)).toBe(true);
    expect(Object.fromEntries(h.account.data)).toEqual(before);
    expect(h.instances.get('mail', 'work')).toBeNull();
  });

  it('D3 rejects silent calendar-scope demotion and restores the grant', async () => {
    const fetcher = makeOAuthFetcher({
      subject: 'shared-subject',
      scope: 'Mail.Read offline_access',
    });
    const h = makeHarness({
      account: graphGrant('shared-subject'),
      fetcher,
    });
    putCalendar(h, 'work', 'graph');
    const before = Object.fromEntries(h.account.data);

    await expect(enrollGraphMail(h)).rejects.toMatchObject({ code: 'conflict' });

    expect(fetcher.mock.calls.some(([url]) => url === TOKEN_URL)).toBe(true);
    expect(Object.fromEntries(h.account.data)).toEqual(before);
    expect(h.instances.get('mail', 'work')).toBeNull();
  });

  it('D4 allows a different account when no Graph calendar row shares the slug', async () => {
    const fetcher = makeOAuthFetcher({
      accessToken: 'different-access',
      refreshToken: 'different-refresh',
      subject: 'different-subject',
    });
    const h = makeHarness({
      account: graphGrant('old-mail-subject'),
      fetcher,
    });

    await expect(enrollGraphMail(h)).resolves.toMatchObject({ slug: 'work' });

    expect(h.account.data.get('graph.work.access_token')).toBe('different-access');
    expect(h.account.data.get('graph.work.refresh_token')).toBe('different-refresh');
    expect(h.account.deletedKeys).toEqual([]);
    expect(h.instances.get('mail', 'work')?.adapter_type).toBe('graph');
  });

  it('D5 recovers a pre-identity grant from its current token and allows the same account', async () => {
    const fetcher = makeOAuthFetcher({
      subjectByAccessToken: {
        'access-legacy-subject': 'legacy-subject',
        'new-access-token': 'legacy-subject',
      },
    });
    const h = makeHarness({
      account: graphGrant('legacy-subject', { includeIdentity: false }),
      fetcher,
    });
    putCalendar(h, 'work', 'graph');

    await expect(enrollGraphMail(h)).resolves.toMatchObject({ slug: 'work' });

    expect(JSON.parse(
      h.account.data.get('graph.work.grant_identity') ?? 'null',
    )).toEqual({ subject: 'legacy-subject' });
    expect(h.instances.get('mail', 'work')?.adapter_type).toBe('graph');
  });

  it('D6 refuses a different account even when the shared grant predates identity stamping', async () => {
    const fetcher = makeOAuthFetcher({
      subjectByAccessToken: {
        'access-legacy-subject': 'legacy-subject',
        'new-access-token': 'different-subject',
      },
    });
    const h = makeHarness({
      account: graphGrant('legacy-subject', { includeIdentity: false }),
      fetcher,
    });
    putCalendar(h, 'work', 'graph');
    const before = Object.fromEntries(h.account.data);

    await expect(enrollGraphMail(h)).rejects.toMatchObject({ code: 'conflict' });

    expect(Object.fromEntries(h.account.data)).toEqual(before);
    expect(h.instances.get('mail', 'work')).toBeNull();
  });

  it('D7 refuses before exchange when the existing shared account cannot be identified', async () => {
    const fetcher = makeOAuthFetcher({
      subjectByAccessToken: { 'access-legacy-subject': null },
    });
    const h = makeHarness({
      account: graphGrant('legacy-subject', { includeIdentity: false }),
      fetcher,
    });
    putCalendar(h, 'work', 'graph');
    const before = Object.fromEntries(h.account.data);

    await expect(enrollGraphMail(h)).rejects.toMatchObject({ code: 'conflict' });

    expect(fetcher.mock.calls.some(([url]) => url === TOKEN_URL)).toBe(false);
    expect(Object.fromEntries(h.account.data)).toEqual(before);
  });

  it('D8 restores the shared grant when the new account identity cannot be read', async () => {
    const fetcher = makeOAuthFetcher({
      subjectByAccessToken: { 'new-access-token': null },
    });
    const h = makeHarness({
      account: graphGrant('shared-subject'),
      fetcher,
    });
    putCalendar(h, 'work', 'graph');
    const before = Object.fromEntries(h.account.data);

    await expect(enrollGraphMail(h)).rejects.toMatchObject({ code: 'conflict' });

    expect(Object.fromEntries(h.account.data)).toEqual(before);
    expect(h.instances.get('mail', 'work')).toBeNull();
  });

  it('D9 records identity on a Graph mail enroll before any calendar shares it', async () => {
    const fetcher = makeOAuthFetcher({ subject: 'mail-first-subject' });
    const h = makeHarness({ fetcher });

    await enrollGraphMail(h);

    expect(JSON.parse(
      h.account.data.get('graph.work.grant_identity') ?? 'null',
    )).toEqual({ subject: 'mail-first-subject' });
    expect(h.instances.get('calendar', 'work')).toBeNull();
  });
});

describe('handleCalendarEnrollOAuth Graph grant identity recording', () => {
  it('E1 records identity for a Graph calendar enrolled without a mail row', async () => {
    const fetcher = makeOAuthFetcher({ subject: 'calendar-first-subject' });
    const h = makeHarness({ fetcher });

    await expect(enrollCalendar(h, 'graph')).resolves.toEqual({
      slug: 'work',
      caps: CALENDAR_CAPS,
    });

    expect(JSON.parse(
      h.account.data.get('graph.work.grant_identity') ?? 'null',
    )).toEqual({ subject: 'calendar-first-subject' });
    expect(h.instances.get('mail', 'work')).toBeNull();
  });

  it('E2 does not write grant identity for a Google Calendar enroll', async () => {
    const h = makeHarness();

    await expect(enrollCalendar(h, 'gcal')).resolves.toEqual({
      slug: 'work',
      caps: CALENDAR_CAPS,
    });

    expect(
      [...h.account.data.keys()].filter((key) => key.endsWith('.grant_identity')),
    ).toEqual([]);
    expect(h.account.data.has('gcal.work.grant_identity')).toBe(false);
  });
});
