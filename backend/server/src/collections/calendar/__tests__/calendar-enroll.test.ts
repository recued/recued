/** D-117 Phase 7 — calendar enroll rpc tests.
 *
 *  Exercises all 7 handlers (enrollOAuth, enrollBasic, list, update,
 *  delete, resync, reauth) using fakes for the OAuth fetcher, account
 *  store, and calendar adapter factory. */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RpcError,
  type CalendarCollectionCaps,
} from '@recued/contracts';

import {
  createInstanceStore,
  type CollectionInstanceStore,
} from '../../instance-store.js';
import {
  createCalendarAdapterRegistry,
  type CalendarAdapterContext,
  type CalendarAdapterFactory,
  type CalendarAdapterRegistry,
} from '../adapter-registry.js';
import type {
  CalendarProvider,
  CalendarProviderKind,
  ProbedCalendarCaps,
} from '../provider.js';
import {
  handleCalendarEnrollBasic,
  handleCalendarEnrollOAuth,
  handleCalendarList,
  handleCalendarUpdate,
  handleCalendarDelete,
  handleCalendarResync,
  handleCalendarReauth,
  type CalendarEnrollDeps,
} from '../enroll.js';
import type { OAuthAccountStore, OAuthProviderConfig } from '../../mail/oauth.js';

const FULL_PROBED: ProbedCalendarCaps = {
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

const READ_ONLY_PROBED: ProbedCalendarCaps = {
  ...FULL_PROBED,
  create_event: 'no',
  update_event: 'no',
  delete_event: 'no',
  rsvp: 'no',
  search: 'local',
  auth: 'app_password',
  recurrence: 'client',
};

const makeFactory = (
  kind: CalendarProviderKind,
  probeImpl: (ctx: CalendarAdapterContext) => Promise<ProbedCalendarCaps>,
): CalendarAdapterFactory => ({
  kind,
  probeCaps: probeImpl,
  create: () => ({ kind, slug: 'x' }) as unknown as CalendarProvider,
});

const makeStore = (
  seed: Record<string, string> = {},
): OAuthAccountStore & { data: Map<string, string> } => {
  const data = new Map<string, string>(Object.entries(seed));
  return {
    data,
    async get(k) { return data.get(k) ?? null; },
    async set(k, v) { data.set(k, v); },
    async delete(k) { data.delete(k); },
    // Mirrors the production ServerAccountStore so the delete-handler prefix
    // sweep (caldav password + etag cursors) exercises its real path.
    async getAll() { return Object.fromEntries(data); },
  };
};

const oauthFetcher = (responses: Array<{ status: number; body: unknown }>) => {
  let i = 0;
  return async (_url: string, _init?: unknown) => {
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    return {
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      async json() { return r.body; },
      async text() { return JSON.stringify(r.body); },
    };
  };
};

interface Harness {
  db: Database.Database;
  instances: CollectionInstanceStore;
  adapters: CalendarAdapterRegistry;
  account: OAuthAccountStore & { data: Map<string, string> };
  deps: CalendarEnrollDeps;
}

const setup = (
  factories: CalendarAdapterFactory[],
  oauthCfg: OAuthProviderConfig | null = {
    tokenUrl: 'https://oauth/test',
    clientId: 'cid',
    clientSecret: 'csec',
  },
  fetcher: ReturnType<typeof oauthFetcher> | undefined = oauthFetcher([
    {
      status: 200,
      body: { access_token: 'at', refresh_token: 'rt', expires_in: 3600 },
    },
  ]),
): Harness => {
  const db = new Database(':memory:');
  const instances = createInstanceStore({ db });
  const adapters = createCalendarAdapterRegistry();
  for (const f of factories) adapters.register(f);
  const account = makeStore();
  const deps: CalendarEnrollDeps = {
    instances,
    adapters,
    accountStore: account,
    oauthConfig: () => oauthCfg,
    ...(fetcher !== undefined ? { fetcher } : {}),
    now: () => 1_700_000_000_000,
  };
  return { db, instances, adapters, account, deps };
};

describe('collection.calendar.enrollOAuth', () => {
  let h: Harness;
  beforeEach(() => {
    h = setup([makeFactory('gcal', async () => FULL_PROBED), makeFactory('graph', async () => FULL_PROBED)]);
  });
  afterEach(() => h.db.close());

  it('rejects invalid slug', async () => {
    await expect(
      handleCalendarEnrollOAuth(h.deps, {
        slug: 'UPPER',
        adapter: 'gcal',
        oauth_code: 'c',
        oauth_redirect_uri: 'http://x',
      }),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('rejects unknown adapter (caldav cannot enrollOAuth)', async () => {
    await expect(
      handleCalendarEnrollOAuth(h.deps, {
        slug: 'work',
        adapter: 'caldav' as never,
        oauth_code: 'c',
        oauth_redirect_uri: 'http://x',
      }),
    ).rejects.toMatchObject({
      code: 'bad_request',
      message: expect.stringContaining('adapter must be one of'),
    });
  });

  it('rejects already-enrolled slug', async () => {
    h.instances.upsert({
      platform: 'calendar',
      slug: 'work',
      adapter_type: 'gcal',
      config: {},
      caps: { ...FULL_PROBED } as CalendarCollectionCaps,
      auth_state: 'healthy',
      last_synced_at: null,
    });
    await expect(
      handleCalendarEnrollOAuth(h.deps, {
        slug: 'work',
        adapter: 'gcal',
        oauth_code: 'c',
        oauth_redirect_uri: 'http://x',
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('rejects the reserved local-calendar slug (D-173 P4.3)', async () => {
    await expect(
      handleCalendarEnrollOAuth(h.deps, {
        slug: 'local',
        adapter: 'gcal',
        oauth_code: 'c',
        oauth_redirect_uri: 'http://x',
      }),
    ).rejects.toMatchObject({
      code: 'conflict',
      message: expect.stringContaining('reserved'),
    });
  });

  it('returns not_configured when oauth client missing', async () => {
    h.deps.oauthConfig = () => null;
    await expect(
      handleCalendarEnrollOAuth(h.deps, {
        slug: 'work',
        adapter: 'gcal',
        oauth_code: 'c',
        oauth_redirect_uri: 'http://x',
      }),
    ).rejects.toMatchObject({
      code: 'not_configured',
    });
  });

  it('exchanges code, probes caps, writes the row, calls onEnrolled', async () => {
    let enrolled = '';
    h.deps.onEnrolled = (row) => { enrolled = row.slug; };
    const res = await handleCalendarEnrollOAuth(h.deps, {
      slug: 'work',
      adapter: 'gcal',
      oauth_code: 'authcode',
      oauth_redirect_uri: 'http://localhost/cb',
      backfill_days: 60,
      retention_days: 365,
    });
    expect(res.slug).toBe('work');
    expect(res.caps).toEqual(FULL_PROBED);
    // Token persisted
    expect(h.account.data.get('gcal.work.refresh_token')).toBe('rt');
    expect(h.account.data.get('gcal.work.access_token')).toBe('at');
    // Row in DB
    const row = h.instances.get('calendar', 'work');
    expect(row).not.toBeNull();
    expect(row!.adapter_type).toBe('gcal');
    expect(row!.config.backfill_days).toBe(60);
    // The gcal / graph adapter config parsers REQUIRE account_slug (it keys
    // their token + cursor storage); enroll must set it or the probe throws.
    expect(row!.config.account_slug).toBe('work');
    // Hook fired
    expect(enrolled).toBe('work');
  });

  it('passes account_slug into the adapter probe config (gcal/graph require it)', async () => {
    let probedSlug: unknown;
    const capturing = setup([
      makeFactory('gcal', async (ctx) => {
        probedSlug = ctx.config.account_slug;
        return FULL_PROBED;
      }),
      makeFactory('graph', async () => FULL_PROBED),
    ]);
    await handleCalendarEnrollOAuth(capturing.deps, {
      slug: 'work',
      adapter: 'gcal',
      oauth_code: 'authcode',
      oauth_redirect_uri: 'http://localhost/cb',
    });
    expect(probedSlug).toBe('work');
  });

  it('returns probe_failed when probeCaps throws unrelated to config', async () => {
    // Use a fresh harness with a failing gcal probe.
    const fresh = setup([
      makeFactory('gcal', async () => { throw new Error('boom'); }),
    ]);
    await expect(
      handleCalendarEnrollOAuth(fresh.deps, {
        slug: 'work',
        adapter: 'gcal',
        oauth_code: 'c',
        oauth_redirect_uri: 'http://x',
      }),
    ).rejects.toMatchObject({ code: 'probe_failed' });
    fresh.db.close();
  });

  it('surfaces token-exchange failures as upstream_error', async () => {
    const fresh = setup(
      [makeFactory('gcal', async () => FULL_PROBED)],
      { tokenUrl: 'http://x', clientId: 'cid' },
      oauthFetcher([{ status: 502, body: { error: 'bad gateway' } }]),
    );
    await expect(
      handleCalendarEnrollOAuth(fresh.deps, {
        slug: 'work',
        adapter: 'gcal',
        oauth_code: 'c',
        oauth_redirect_uri: 'http://x',
      }),
    ).rejects.toMatchObject({ code: 'upstream_error' });
    fresh.db.close();
  });
});

describe('collection.calendar.enrollBasic (caldav)', () => {
  let h: Harness;
  beforeEach(() => {
    h = setup([makeFactory('caldav', async () => READ_ONLY_PROBED)]);
  });
  afterEach(() => h.db.close());

  it('rejects empty required fields', async () => {
    await expect(
      handleCalendarEnrollBasic(h.deps, {
        slug: 'work',
        server_url: '',
        username: 'me',
        password: 'pw',
        calendar_home_url: 'https://x/',
      }),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('requires password + calendar_home_url', async () => {
    await expect(
      handleCalendarEnrollBasic(h.deps, {
        slug: 'work',
        server_url: 'https://caldav.fastmail.com',
        username: 'me@example.com',
        // password + calendar_home_url omitted
      }),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('rejects the reserved local-calendar slug (D-173 P4.3)', async () => {
    await expect(
      handleCalendarEnrollBasic(h.deps, {
        slug: 'local',
        server_url: 'https://caldav.fastmail.com',
        username: 'me@example.com',
        password: 'app-pw',
        calendar_home_url: 'https://caldav.fastmail.com/dav/calendars/',
      }),
    ).rejects.toMatchObject({
      code: 'conflict',
      message: expect.stringContaining('reserved'),
    });
  });

  it('writes the row + caps + stores the password server-side (not on config)', async () => {
    // Probe via a factory that reads `getAccountValue('password')` — the
    // SAME key scoping the runtime composition root uses
    // (`caldav.<slug>.password`). This pins the enroll→adapter credential
    // wiring: a wrong key would surface here as a null password.
    let seenPassword: string | null = null;
    const h2 = setup([
      makeFactory('caldav', async (ctx) => {
        seenPassword = await ctx.getAccountValue('password');
        return READ_ONLY_PROBED;
      }),
    ]);
    let enrolled = '';
    h2.deps.onEnrolled = (r) => { enrolled = r.slug; };
    const res = await handleCalendarEnrollBasic(h2.deps, {
      slug: 'fastmail',
      server_url: 'https://caldav.fastmail.com',
      username: 'me@example.com',
      password: 'app-pw',
      calendar_home_url: 'https://caldav.fastmail.com/dav/calendars/me/',
      scheduling_outbox_url: 'https://caldav.fastmail.com/dav/scheduling/outbox/',
      retention_days: 90,
    });
    expect(res.slug).toBe('fastmail');
    expect(res.caps.auth).toBe('app_password');
    // The probe resolved the password the enroll just stored.
    expect(seenPassword).toBe('app-pw');
    const row = h2.instances.get('calendar', 'fastmail');
    expect(row!.adapter_type).toBe('caldav');
    // Password lives in the account store under `caldav.<slug>.password`,
    // never on the config row (a config dump never reveals it).
    expect(h2.account.data.get('caldav.fastmail.password')).toBe('app-pw');
    expect(row!.config).not.toHaveProperty('vault_key');
    expect(row!.config).not.toHaveProperty('password');
    expect(row!.config.calendar_home_url).toBe(
      'https://caldav.fastmail.com/dav/calendars/me/',
    );
    expect(row!.config.scheduling_outbox_url).toBe(
      'https://caldav.fastmail.com/dav/scheduling/outbox/',
    );
    expect(row!.config.server_url).toBe('https://caldav.fastmail.com');
    expect(enrolled).toBe('fastmail');
    h2.db.close();
  });

  it('deletes the stored password when the probe fails (no orphaned credential)', async () => {
    const h2 = setup([
      makeFactory('caldav', async () => {
        throw new Error('PROPFIND 401 — credentials rejected');
      }),
    ]);
    await expect(
      handleCalendarEnrollBasic(h2.deps, {
        slug: 'fastmail',
        server_url: 'https://caldav.fastmail.com',
        username: 'me@example.com',
        password: 'app-pw',
        calendar_home_url: 'https://caldav.fastmail.com/dav/calendars/me/',
      }),
    ).rejects.toMatchObject({ code: 'probe_failed' });
    expect(h2.account.data.has('caldav.fastmail.password')).toBe(false);
    expect(h2.instances.get('calendar', 'fastmail')).toBeNull();
    h2.db.close();
  });

  it('rejects already-enrolled slug', async () => {
    h.instances.upsert({
      platform: 'calendar',
      slug: 'fastmail',
      adapter_type: 'caldav',
      config: {},
      caps: { ...READ_ONLY_PROBED } as CalendarCollectionCaps,
      auth_state: 'healthy',
      last_synced_at: null,
    });
    await expect(
      handleCalendarEnrollBasic(h.deps, {
        slug: 'fastmail',
        server_url: 'https://x',
        username: 'me',
        password: 'app-pw',
        calendar_home_url: 'https://x/dav/',
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });
});

describe('collection.calendar.list / update / delete', () => {
  let h: Harness;
  beforeEach(() => {
    h = setup([makeFactory('gcal', async () => FULL_PROBED)]);
    h.instances.upsert({
      platform: 'calendar',
      slug: 'work',
      adapter_type: 'gcal',
      config: { backfill_days: 30 },
      caps: { ...FULL_PROBED } as CalendarCollectionCaps,
      auth_state: 'healthy',
      last_synced_at: null,
    });
  });
  afterEach(() => h.db.close());

  it('list returns calendar rows only', async () => {
    h.instances.upsert({
      platform: 'file',
      slug: 'docs',
      adapter_type: 'fs',
      config: { path: '/x' },
      caps: { read: 'yes', write: 'yes', delete: 'yes', watch: 'realtime', mirror: 'optional', auth: 'none', path_style: 'posix' } as never,
      auth_state: 'healthy',
      last_synced_at: null,
    });
    const res = await handleCalendarList(h.deps);
    expect(res.instances).toHaveLength(1);
    expect(res.instances[0].slug).toBe('work');
  });

  it('update merges config + skips reprobe by default', async () => {
    const res = await handleCalendarUpdate(h.deps, {
      slug: 'work',
      config_patch: { retention_days: 180 },
    });
    expect(res.re_probed).toBe(false);
    const row = h.instances.get('calendar', 'work');
    expect(row!.config.retention_days).toBe(180);
    expect(row!.config.backfill_days).toBe(30);
  });

  it('update strips credential keys from config_patch (never on the config row)', async () => {
    await handleCalendarUpdate(h.deps, {
      slug: 'work',
      config_patch: { password: 'leak', vault_key: 'leak', retention_days: 5 },
    });
    const row = h.instances.get('calendar', 'work');
    // Non-secret field lands; password / vault_key are dropped.
    expect(row!.config.retention_days).toBe(5);
    expect(row!.config).not.toHaveProperty('password');
    expect(row!.config).not.toHaveProperty('vault_key');
  });

  it('update with reprobe re-runs the probe + refreshes caps', async () => {
    const res = await handleCalendarUpdate(h.deps, {
      slug: 'work',
      config_patch: {},
      reprobe: true,
    });
    expect(res.re_probed).toBe(true);
  });

  it('update returns not_found for unknown slug', async () => {
    await expect(
      handleCalendarUpdate(h.deps, { slug: 'nope', config_patch: {} }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('delete drops the row and calls onDeleted', async () => {
    let deleted = '';
    h.deps.onDeleted = (s) => { deleted = s; };
    await handleCalendarDelete(h.deps, { slug: 'work' });
    expect(h.instances.get('calendar', 'work')).toBeNull();
    expect(deleted).toBe('work');
  });

  it('caldav delete purges the password AND etag sync-cursors, slug-scoped', async () => {
    h.instances.upsert({
      platform: 'calendar', slug: 'fast', adapter_type: 'caldav',
      config: { server_url: 'https://dav', username: 'me', calendar_home_url: 'https://dav/h' },
      caps: { ...READ_ONLY_PROBED } as CalendarCollectionCaps,
      auth_state: 'healthy', last_synced_at: null,
    });
    h.account.data.set('caldav.fast.password', 'pw');
    h.account.data.set('caldav.fast.etag.cal1.abc123', 'etag-a');
    h.account.data.set('caldav.fast.etag.cal1.def456', 'etag-b');
    // Look-alike sibling — MUST survive (the dot-terminated prefix guards
    // `fast` from matching `fast2`).
    h.account.data.set('caldav.fast2.password', 'pw2');
    h.account.data.set('caldav.fast2.etag.cal1.zzz', 'etag-z');

    await handleCalendarDelete(h.deps, { slug: 'fast' });

    expect(h.instances.get('calendar', 'fast')).toBeNull();
    expect([...h.account.data.keys()].some((k) => k.startsWith('caldav.fast.'))).toBe(false);
    // The look-alike sibling's keys are untouched.
    expect(h.account.data.get('caldav.fast2.password')).toBe('pw2');
    expect(h.account.data.get('caldav.fast2.etag.cal1.zzz')).toBe('etag-z');
  });

  it('caldav delete falls back to the exact password key when the store cannot enumerate', async () => {
    // A narrow store double (no getAll) can't sweep the etag prefix; the handler
    // still drops the known password (etags degrade to orphaned — documented).
    const data = new Map<string, string>([
      ['caldav.narrow.password', 'pw'],
      ['caldav.narrow.etag.cal1.abc', 'etag-a'],
    ]);
    h.deps.accountStore = {
      async get(k) { return data.get(k) ?? null; },
      async set(k, v) { data.set(k, v); },
      async delete(k) { data.delete(k); },
    };
    h.instances.upsert({
      platform: 'calendar', slug: 'narrow', adapter_type: 'caldav',
      config: { server_url: 'https://dav', username: 'me', calendar_home_url: 'https://dav/h' },
      caps: { ...READ_ONLY_PROBED } as CalendarCollectionCaps,
      auth_state: 'healthy', last_synced_at: null,
    });
    await handleCalendarDelete(h.deps, { slug: 'narrow' });
    expect(data.has('caldav.narrow.password')).toBe(false); // exact-key fallback
    expect(data.has('caldav.narrow.etag.cal1.abc')).toBe(true); // can't enumerate → orphaned
  });

  it('delete returns not_found for unknown slug', async () => {
    await expect(handleCalendarDelete(h.deps, { slug: 'nope' })).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('collection.calendar.resync', () => {
  it('flips auth_state to expired on auth-related probe failure', async () => {
    const h = setup([
      makeFactory('gcal', async () => { throw new Error('401 token expired'); }),
    ]);
    h.instances.upsert({
      platform: 'calendar',
      slug: 'work',
      adapter_type: 'gcal',
      config: {},
      caps: { ...FULL_PROBED } as CalendarCollectionCaps,
      auth_state: 'healthy',
      last_synced_at: null,
    });
    const res = await handleCalendarResync(h.deps, { slug: 'work' });
    expect(res.auth_state).toBe('expired');
    h.db.close();
  });

  it('flips auth_state to degraded on non-auth failure', async () => {
    const h = setup([
      makeFactory('gcal', async () => { throw new Error('upstream timeout'); }),
    ]);
    h.instances.upsert({
      platform: 'calendar',
      slug: 'work',
      adapter_type: 'gcal',
      config: {},
      caps: { ...FULL_PROBED } as CalendarCollectionCaps,
      auth_state: 'healthy',
      last_synced_at: null,
    });
    const res = await handleCalendarResync(h.deps, { slug: 'work' });
    expect(res.auth_state).toBe('degraded');
    h.db.close();
  });

  it('keeps cached caps + flips auth_state back to healthy on probe success', async () => {
    const h = setup([makeFactory('gcal', async () => FULL_PROBED)]);
    h.instances.upsert({
      platform: 'calendar',
      slug: 'work',
      adapter_type: 'gcal',
      config: {},
      caps: { ...FULL_PROBED } as CalendarCollectionCaps,
      auth_state: 'expired',
      last_synced_at: null,
    });
    const res = await handleCalendarResync(h.deps, { slug: 'work' });
    expect(res.auth_state).toBe('healthy');
    expect(res.caps).toEqual(FULL_PROBED);
    h.db.close();
  });
});

describe('collection.calendar.reauth', () => {
  it('returns not_implemented for caldav', async () => {
    const h = setup([makeFactory('caldav', async () => READ_ONLY_PROBED)]);
    h.instances.upsert({
      platform: 'calendar',
      slug: 'fastmail',
      adapter_type: 'caldav',
      config: {},
      caps: { ...READ_ONLY_PROBED } as CalendarCollectionCaps,
      auth_state: 'healthy',
      last_synced_at: null,
    });
    await expect(handleCalendarReauth(h.deps, { slug: 'fastmail' })).rejects.toMatchObject({
      code: 'not_implemented',
    });
    h.db.close();
  });

  it('returns not_implemented for the credential-free local calendar (D-173 P4.3)', async () => {
    const h = setup([makeFactory('caldav', async () => READ_ONLY_PROBED)]);
    h.instances.upsert({
      platform: 'calendar',
      slug: 'local',
      adapter_type: 'local',
      config: {},
      caps: { ...READ_ONLY_PROBED, auth: 'none' } as CalendarCollectionCaps,
      auth_state: 'healthy',
      last_synced_at: null,
    });
    await expect(handleCalendarReauth(h.deps, { slug: 'local' })).rejects.toMatchObject({
      code: 'not_implemented',
    });
    h.db.close();
  });

  it('returns ok:true for gcal so the extension drives the OAuth popup', async () => {
    const h = setup([makeFactory('gcal', async () => FULL_PROBED)]);
    h.instances.upsert({
      platform: 'calendar',
      slug: 'work',
      adapter_type: 'gcal',
      config: {},
      caps: { ...FULL_PROBED } as CalendarCollectionCaps,
      auth_state: 'expired',
      last_synced_at: null,
    });
    const res = await handleCalendarReauth(h.deps, { slug: 'work' });
    expect(res).toEqual({ ok: true });
    h.db.close();
  });
});
