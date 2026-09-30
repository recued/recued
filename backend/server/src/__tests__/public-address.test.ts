/** The server's own public addresses, picked live with the cloud probe's
 *  answers in the picture (`public-address.ts`).
 *
 *  ⛔ Every link used to come from `RECUED_PUBLIC_BASE_URL` alone, so a Pro
 *  server that never set it — a terminal setting Pro exists to make
 *  unnecessary — sent its links without one, and a server with a Pro address
 *  and its own domain could not say which of the two answers. */

import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import type { PathResolution, PathRole, RootApexMode } from '@recued/contracts';
import {
  AddressChoiceError,
  PROBE_OTHER_EVERY_MS,
  PROBE_REACHABLE_EVERY_MS,
  PROBE_VERDICT_FRESH_MS,
  canonicalServerPublicOrigins,
  createCloudReachabilityProber,
  createListenerPublicAddressFacts,
  createPublicAddressService,
  createSqlitePublicAddressStore,
  type AddressPin,
  type ProbeOutcome,
  type ProbeVerdict,
  type PublicAddressFacts,
  type PublicAddressStore,
  type PublicHostnameRow,
} from '../public-address.js';

const NOW = 1_800_000_000_000;

const row = (hostname: string, over: Partial<PublicHostnameRow> = {}): PublicHostnameRow => ({
  hostname,
  listener_ports: [443],
  enabled: true,
  ownership_status: 'verified',
  tls_topology: 'server_terminated',
  cert_source: hostname.endsWith('.recued.net') ? 'recued_acme' : 'byo_uploaded',
  cert_fingerprint: 'sha256:ab',
  cert_provisioning: 'ready',
  ...over,
});

const memoryStore = (): PublicAddressStore & {
  readonly publishes: Array<Readonly<Record<string, readonly string[]>>>;
} => {
  const verdicts = new Map<string, ProbeVerdict>();
  let published: Readonly<Record<string, readonly string[]>> | null = null;
  const publishes: Array<Readonly<Record<string, readonly string[]>>> = [];
  let pins: Record<string, AddressPin> = {};
  return {
    verdict: (hostname, port) => verdicts.get(`${hostname}:${String(port)}`) ?? null,
    putVerdict: (v) => { verdicts.set(`${v.hostname}:${String(v.port)}`, v); },
    published: (target) => (published?.[target] ? [...published[target]] : null),
    publish: (byTarget) => { published = byTarget; publishes.push(byTarget); },
    pins: () => ({ ...pins }),
    setPin: (use, pin) => {
      const next = { ...pins };
      if (pin === null) delete next[use];
      else next[use] = pin;
      pins = next;
    },
    publishes,
  };
};

const verdict = (
  hostname: string,
  over: Partial<ProbeVerdict> = {},
): ProbeVerdict => ({
  hostname,
  port: 443,
  probed_at: NOW - 60_000,
  port_open: true,
  https_ok: true,
  ...over,
});

const ALL_PUBLIC = (): Record<PathRole, PathResolution> => ({
  health: { lan: true, public: true },
  ws: { lan: true, public: true },
  mcp: { lan: true, public: true },
  llm_gateway: { lan: true, public: true },
  webhooks: { lan: true, public: true },
  reception: { lan: true, public: true },
  oauth: { lan: true, public: true },
  ask: { lan: true, public: true },
  webclient: { lan: true, public: true },
});

const facts = (over: {
  public?: Partial<Record<PathRole, boolean>>;
  apexMode?: RootApexMode;
  bundle?: boolean;
  bound?: boolean;
} = {}): PublicAddressFacts => ({
  pathPublic: (role) => over.public?.[role] ?? true,
  apexMode: () => over.apexMode ?? 'redirect',
  webclientBundleLoaded: () => over.bundle ?? true,
  publicListenerBound: () => over.bound ?? true,
});

const service = (input: {
  configured?: string;
  rows?: PublicHostnameRow[];
  store?: PublicAddressStore;
  facts?: PublicAddressFacts | null;
  probe?: (hostname: string, port: number) => Promise<ProbeOutcome>;
  now?: () => number;
}) => {
  const rows = input.rows ?? [];
  const svc = createPublicAddressService({
    configured: () => input.configured,
    hostnames: { list: () => rows },
    store: input.store ?? memoryStore(),
    ...(input.probe ? { prober: { probe: input.probe } } : {}),
    now: input.now ?? (() => NOW),
  });
  if (input.facts !== null) svc.bindFacts(input.facts ?? facts());
  return svc;
};

describe('baseUrls — the live, ranked answer', () => {
  it('a Pro server with nothing configured answers with its Pro address', () => {
    expect(service({ rows: [row('alice.recued.net')] }).baseUrls('ask'))
      .toEqual(['https://alice.recued.net']);
  });

  it('puts the configured address first, read at each call, and refuses a LAN or local one', () => {
    const env: { value?: string } = { value: '  https://mary.example.org/  ' };
    const svc = createPublicAddressService({
      configured: () => env.value,
      hostnames: { list: () => [row('alice.recued.net')] },
      store: memoryStore(),
      now: () => NOW,
    });
    svc.bindFacts(facts());
    expect(svc.baseUrls('ask')).toEqual(['https://mary.example.org', 'https://alice.recued.net']);
    env.value = 'http://192.168.1.5:7717';
    expect(svc.baseUrls('ask')).toEqual(['https://alice.recued.net']);
    env.value = 'https://alice.recued.net';
    expect(svc.baseUrls('ask')).toEqual(['https://alice.recued.net']);
  });

  it('before the listener facts are bound, offers the configured address and the last published names', () => {
    const svc = service({ configured: 'https://mary.example.org', rows: [row('alice.recued.net')], facts: null });
    expect(svc.baseUrls('ask')).toEqual(['https://mary.example.org']);
    svc.bindFacts(facts());
    expect(svc.baseUrls('ask')).toEqual(['https://mary.example.org', 'https://alice.recued.net']);
  });

  it('the last published answer stands in for the facts — the stdio MCP process, or early boot', () => {
    const store = memoryStore();
    const rows = [row('alice.recued.net'), row('recued.example.com')];
    service({ store, rows, facts: facts({ public: { ask: false } }) });
    const unbound = service({ store, rows, configured: 'https://mary.example.org', facts: null });
    expect(unbound.baseUrls('root')).toEqual(['https://mary.example.org', 'https://alice.recued.net']);
    expect(unbound.baseUrls('ask')).toEqual(['https://mary.example.org']);
    expect(unbound.baseUrls('reception'))
      .toEqual(['https://mary.example.org', 'https://recued.example.com', 'https://alice.recued.net']);
    // A published name that is no longer ours is not offered.
    expect(service({ store, rows: [row('recued.example.com')], facts: null }).baseUrls('reception'))
      .toEqual(['https://recued.example.com']);
  });

  it('offers no name while the public listener is not bound', () => {
    expect(service({ rows: [row('alice.recued.net')], facts: facts({ bound: false }) }).baseUrls('ask'))
      .toEqual([]);
  });

  it('offers a name for a path only while that path is Public, or once the grid has been read', () => {
    const rows = [row('alice.recued.net')];
    expect(service({ rows, facts: facts({ public: { ask: false } }) }).baseUrls('ask')).toEqual([]);
    expect(service({ rows, facts: facts({ public: { ask: false } }) }).baseUrls('reception'))
      .toEqual(['https://alice.recued.net']);
    const unread: PublicAddressFacts = { ...facts(), pathPublic: () => null };
    expect(service({ rows, facts: unread }).baseUrls('ask')).toEqual([]);
  });

  it('needs a certificate the server holds — or a proxy that holds one', () => {
    expect(service({
      rows: [
        row('alice.recued.net', { cert_fingerprint: undefined, cert_provisioning: 'pending' }),
        row('failed.example.com', { cert_fingerprint: undefined, cert_provisioning: 'failed' }),
        row('renewal-failed.example.com', { cert_provisioning: 'failed' }),
        row('proxied.example.com', {
          tls_topology: 'upstream_terminated', cert_source: 'byo_external',
          cert_fingerprint: undefined, cert_provisioning: undefined,
        }),
      ],
    }).baseUrls('ask')).toEqual(['https://renewal-failed.example.com', 'https://proxied.example.com']);
  });

  it('skips a name not yet verified, switched off, private, or with no port', () => {
    expect(service({
      rows: [
        row('pending.example.com', { ownership_status: 'pending' }),
        row('off.example.com', { enabled: false }),
        row('nas.local'),
        row('none.example.com', { listener_ports: [] }),
        row('alice.recued.net'),
      ],
    }).baseUrls('ask')).toEqual(['https://alice.recued.net']);
  });

  it('prefers the own domain to the Pro address, then 443', () => {
    expect(service({
      rows: [
        row('alice.recued.net'),
        row('b.example.com', { listener_ports: [8446] }),
        row('a.example.com', { listener_ports: [8447, 443] }),
      ],
    }).baseUrls('ask')).toEqual([
      'https://a.example.com',
      'https://b.example.com:8446',
      'https://alice.recued.net',
    ]);
  });

  it('ranks a name the probe reached over https first, and leaves out one where nothing answers', () => {
    const store = memoryStore();
    store.putVerdict(verdict('alice.recued.net'));
    store.putVerdict(verdict('dead.example.com', { port_open: false, https_ok: false }));
    store.putVerdict(verdict('open.example.com', { https_ok: false }));
    expect(service({
      store,
      rows: [row('dead.example.com'), row('open.example.com'), row('alice.recued.net'), row('new.example.com')],
    }).baseUrls('ask')).toEqual([
      // Reached — ranks above the preferred own domains.
      'https://alice.recued.net',
      // Port open with https failing, and never probed: not known, kept.
      'https://open.example.com',
      'https://new.example.com',
    ]);
  });

  it('forgets an old answer: a name last seen dead long ago is offered again', () => {
    const store = memoryStore();
    store.putVerdict(verdict('dead.example.com', {
      port_open: false, https_ok: false, probed_at: NOW - PROBE_VERDICT_FRESH_MS - 1,
    }));
    expect(service({ store, rows: [row('dead.example.com')] }).baseUrls('ask'))
      .toEqual(['https://dead.example.com']);
  });

  it('keeps the configured address first even where the probe found nothing', () => {
    const store = memoryStore();
    store.putVerdict(verdict('mary.example.org', { port_open: false, https_ok: false }));
    expect(service({ store, configured: 'https://mary.example.org', rows: [row('mary.example.org')] })
      .baseUrls('ask')).toEqual(['https://mary.example.org']);
  });
});

describe('baseUrls(root) — a webclient deep link needs an apex that lands on the webclient', () => {
  const rows = [row('alice.recued.net'), row('recued.example.com')];

  it('redirect mode: only the Pro address, whose root goes to app.recued.com', () => {
    expect(service({ rows, facts: facts({ apexMode: 'redirect' }) }).baseUrls('root'))
      .toEqual(['https://alice.recued.net']);
  });

  it('serve_webclient: every name, while the bundle is loaded and /webclient is Public', () => {
    expect(service({ rows, facts: facts({ apexMode: 'serve_webclient' }) }).baseUrls('root'))
      .toEqual(['https://recued.example.com', 'https://alice.recued.net']);
    expect(service({ rows, facts: facts({ apexMode: 'serve_webclient', bundle: false }) }).baseUrls('root'))
      .toEqual([]);
    expect(service({ rows, facts: facts({ apexMode: 'serve_webclient', public: { webclient: false } }) })
      .baseUrls('root')).toEqual([]);
  });

  it('serve_reception and not_found: none', () => {
    expect(service({ rows, facts: facts({ apexMode: 'serve_reception' }) }).baseUrls('root')).toEqual([]);
    expect(service({ rows, facts: facts({ apexMode: 'not_found' }) }).baseUrls('root')).toEqual([]);
  });
});

describe('ownBaseUrls — every own address, whatever the grid or the probe says', () => {
  it('lists configured, then own domains, then the Pro address; ignores the grid and the probe', () => {
    const store = memoryStore();
    store.putVerdict(verdict('recued.example.com', { port_open: false, https_ok: false }));
    const svc = service({
      store,
      configured: 'https://mary.example.org',
      rows: [
        row('alice.recued.net'),
        row('recued.example.com'),
        row('pending.recued.net', { cert_fingerprint: undefined, cert_provisioning: 'pending' }),
      ],
      facts: facts({ bound: false, public: { oauth: false } }),
    });
    expect(svc.ownBaseUrls()).toEqual([
      'https://mary.example.org',
      'https://recued.example.com',
      'https://alice.recued.net',
    ]);
  });

  it('works before the listener facts are bound', () => {
    expect(service({ rows: [row('alice.recued.net')], facts: null }).ownBaseUrls())
      .toEqual(['https://alice.recued.net']);
  });
});

describe('proReachability — the Pro card', () => {
  const pro = row('alice.recued.net', { cert_fingerprint: undefined, cert_provisioning: 'pending' });

  it('is unknown with no Pro address, or no fresh answer for it', () => {
    expect(service({ rows: [row('recued.example.com')] }).proReachability()).toBeNull();
    const store = memoryStore();
    store.putVerdict(verdict('alice.recued.net', { probed_at: NOW - PROBE_VERDICT_FRESH_MS - 1 }));
    expect(service({ store, rows: [pro] }).proReachability()).toBeNull();
  });

  it('is reachable when the port answered, before any certificate', () => {
    const store = memoryStore();
    store.putVerdict(verdict('alice.recued.net', { https_ok: false }));
    expect(service({ store, rows: [pro] }).proReachability()).toEqual({ reachable: true });
  });

  it('is not reachable when nothing answered, or while the public listener is down', () => {
    const store = memoryStore();
    store.putVerdict(verdict('alice.recued.net', { port_open: false, https_ok: false }));
    expect(service({ store, rows: [pro] }).proReachability()).toEqual({ reachable: false });
    const reached = memoryStore();
    reached.putVerdict(verdict('alice.recued.net'));
    expect(service({ store: reached, rows: [pro], facts: facts({ bound: false }) }).proReachability())
      .toEqual({ reachable: false });
  });
});

describe('probeDue — asks the cloud about fleet-issued names only, when due', () => {
  it('probes a Pro address and a fleet-certified custom domain, never a bring-your-own one', async () => {
    const probe = vi.fn(async (hostname: string, port: number): Promise<ProbeOutcome> =>
      ({ kind: 'verdict', verdict: verdict(hostname, { port, probed_at: NOW }) }));
    const svc = service({
      probe,
      rows: [
        row('alice.recued.net', { cert_fingerprint: undefined, cert_provisioning: 'pending' }),
        row('shop.example.com', { cert_source: 'recued_acme_custom' }),
        row('own.example.com', { cert_source: 'byo_uploaded' }),
        row('proxied.example.com', { cert_source: 'byo_external', tls_topology: 'upstream_terminated' }),
        row('off.recued.net', { enabled: false }),
      ],
    });
    await svc.probeDue();
    expect(probe.mock.calls).toEqual([['alice.recued.net', 443], ['shop.example.com', 443]]);
  });

  it('re-probes a reached name after 6 hours and any other after 30 minutes', async () => {
    const store = memoryStore();
    store.putVerdict(verdict('alice.recued.net', { probed_at: NOW - PROBE_REACHABLE_EVERY_MS + 1 }));
    store.putVerdict(verdict('shop.recued.net', { https_ok: false, probed_at: NOW - PROBE_OTHER_EVERY_MS }));
    const probe = vi.fn(async (hostname: string): Promise<ProbeOutcome> =>
      ({ kind: 'verdict', verdict: verdict(hostname, { probed_at: NOW }) }));
    await service({ store, probe, rows: [row('alice.recued.net'), row('shop.recued.net')] }).probeDue();
    expect(probe.mock.calls.map(([hostname]) => hostname)).toEqual(['shop.recued.net']);
    expect(store.verdict('shop.recued.net', 443)?.https_ok).toBe(true);
  });

  it('does not probe while the public listener is down', async () => {
    const probe = vi.fn(async (): Promise<ProbeOutcome> => ({ kind: 'rate_limited' }));
    await service({ probe, rows: [row('alice.recued.net')], facts: facts({ bound: false }) }).probeDue();
    expect(probe).not.toHaveBeenCalled();
  });

  it('stops the round when rate-limited and keeps what it had', async () => {
    const store = memoryStore();
    const probe = vi.fn(async (): Promise<ProbeOutcome> => ({ kind: 'rate_limited' }));
    await service({ store, probe, rows: [row('a.recued.net'), row('b.recued.net')] }).probeDue();
    expect(probe).toHaveBeenCalledTimes(1);
    expect(store.verdict('a.recued.net', 443)).toBeNull();
  });

  it('refreshes the facts first, runs one round at a time, and publishes after', async () => {
    const store = memoryStore();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const probe = vi.fn(async (hostname: string): Promise<ProbeOutcome> => {
      await gate;
      return { kind: 'verdict', verdict: verdict(hostname, { probed_at: NOW }) };
    });
    const refresh = vi.fn(async () => undefined);
    const svc = service({ store, probe, rows: [row('alice.recued.net')], facts: { ...facts(), refresh } });
    const first = svc.probeDue();
    const second = svc.probeDue();
    expect(second).toBe(first);
    release();
    await first;
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(store.published('ask')).toEqual(['https://alice.recued.net']);
  });
});

describe('publish — what a reader without facts falls back on', () => {
  it('publishes the names per target without the configured address, and only on change', () => {
    const store = memoryStore();
    const svc = service({
      store,
      configured: 'https://mary.example.org',
      rows: [row('alice.recued.net')],
      facts: facts({ public: { ask: false } }),
    });
    expect(store.published('root')).toEqual(['https://alice.recued.net']);
    expect(store.published('ask')).toEqual([]);
    svc.publish();
    expect(store.publishes).toHaveLength(1);
  });

  it('does not publish before the grid has been read', () => {
    const store = memoryStore();
    service({ store, rows: [row('alice.recued.net')], facts: { ...facts(), pathPublic: () => null } });
    expect(store.publishes).toHaveLength(0);
  });

});

describe('handed-out addresses — kept by someone else, so they move only when the owner moves them', () => {
  it('automatic is own domain first, then the Pro address, 443 first — and a read keeps nothing', () => {
    const store = memoryStore();
    const svc = service({
      store,
      rows: [row('alice.recued.net'), row('b.example.com', { listener_ports: [8446] }), row('a.example.com')],
    });
    expect(svc.addressChoices()).toEqual([
      { hostname: 'a.example.com', base_url: 'https://a.example.com' },
      { hostname: 'b.example.com', base_url: 'https://b.example.com:8446' },
      { hostname: 'alice.recued.net', base_url: 'https://alice.recued.net' },
    ]);
    expect(svc.addressUse('webhooks'))
      .toEqual({ use: 'webhooks', source: 'automatic', base_url: 'https://a.example.com' });
    expect(store.pins()).toEqual({});
  });

  it('keeps the address from its first use, so adding a domain later moves nothing', () => {
    const store = memoryStore();
    const rows = [row('alice.recued.net')];
    const svc = service({ store, rows });
    expect(svc.handOut('webhooks')).toEqual({
      use: 'webhooks', source: 'first_use', base_url: 'https://alice.recued.net', hostname: 'alice.recued.net',
    });
    // The owner adds a custom domain — "own domain first" would move every
    // registered webhook to it. It does not.
    rows.push(row('recued.example.com'));
    expect(svc.handOut('webhooks').base_url).toBe('https://alice.recued.net');
    // A use handed out for the first time now takes the new automatic answer.
    expect(svc.handOut('reception').base_url).toBe('https://recued.example.com');
    expect(store.pins().webhooks).toMatchObject({ hostname: 'alice.recued.net', by: 'first_use', at: NOW });
  });

  it('does not keep anything while there is no address to hand out', () => {
    const store = memoryStore();
    expect(service({ store }).handOut('webhooks'))
      .toEqual({ use: 'webhooks', source: 'automatic', base_url: null });
    expect(store.pins()).toEqual({});
  });

  it('never follows the probe or the Exposure grid', () => {
    const store = memoryStore();
    store.putVerdict(verdict('recued.example.com', { port_open: false, https_ok: false }));
    const svc = service({
      store,
      rows: [row('recued.example.com'), row('alice.recued.net')],
      facts: facts({ bound: false, public: { reception: false } }),
    });
    expect(svc.handOut('reception').base_url).toBe('https://recued.example.com');
  });

  it('keeps the owner\'s pick, and reports it — never replaces it — once it can no longer be used', () => {
    const store = memoryStore();
    const rows = [row('alice.recued.net'), row('shop.example.com')];
    const svc = service({ store, rows });
    svc.setAddressUse('customer_access', 'Shop.Example.com.');
    expect(svc.handOut('customer_access')).toEqual({
      use: 'customer_access', source: 'owner', base_url: 'https://shop.example.com', hostname: 'shop.example.com',
    });
    rows[1] = row('shop.example.com', { enabled: false });
    expect(svc.handOut('customer_access')).toEqual({
      use: 'customer_access', source: 'owner', base_url: null,
      hostname: 'shop.example.com', hostname_unusable: true,
    });
    expect(store.pins().customer_access).toMatchObject({ hostname: 'shop.example.com', by: 'owner' });
  });

  it('refuses a name that cannot be picked, and goes back to automatic on null', () => {
    const store = memoryStore();
    const svc = service({
      store,
      rows: [
        row('alice.recued.net'),
        row('pending.example.com', { cert_fingerprint: undefined, cert_provisioning: 'pending' }),
      ],
    });
    expect(() => svc.setAddressUse('webhooks', 'pending.example.com')).toThrow(AddressChoiceError);
    expect(() => svc.setAddressUse('webhooks', 'not a name')).toThrow(AddressChoiceError);
    expect(store.pins()).toEqual({});
    svc.setAddressUse('webhooks', 'alice.recued.net');
    svc.setAddressUse('webhooks', null);
    expect(store.pins()).toEqual({});
    expect(svc.addressUse('webhooks').source).toBe('automatic');
  });

  it('lets RECUED_PUBLIC_BASE_URL win, naming the kept name it overrides', () => {
    const store = memoryStore();
    const svc = service({ store, rows: [row('alice.recued.net')], configured: 'https://mary.example.org/hooks/' });
    svc.setAddressUse('webhooks', 'alice.recued.net');
    expect(svc.handOut('webhooks')).toEqual({
      use: 'webhooks', source: 'configured', base_url: 'https://mary.example.org/hooks', hostname: 'alice.recued.net',
    });
    expect(store.pins().reception).toBeUndefined();
  });

  it('gives a webhook or a customer only a clean https configured address; Reception also takes an intranet one', () => {
    const at = (configured: string) => service({ rows: [row('alice.recued.net')], configured });
    expect(at('http://mary.example.org').addressUse('webhooks').base_url).toBe('https://alice.recued.net');
    expect(at('https://user:secret@mary.example.org').addressUse('customer_access').base_url)
      .toBe('https://alice.recued.net');
    expect(at('http://192.168.1.20:7717').addressUse('reception'))
      .toEqual({ use: 'reception', source: 'configured', base_url: 'http://192.168.1.20:7717' });
    expect(at('http://192.168.1.20:7717').addressUse('webhooks').source).toBe('automatic');
    expect(at('http://localhost:7717').addressUse('reception').source).toBe('automatic');
  });

  it('describes every use, the choices, and the best address for links right now', () => {
    const store = memoryStore();
    const svc = service({
      store,
      rows: [row('alice.recued.net'), row('recued.example.com')],
      facts: facts({ apexMode: 'redirect' }),
    });
    svc.handOut('webhooks');
    expect(svc.describeAddressUses()).toEqual({
      uses: [
        { use: 'webhooks', source: 'first_use', base_url: 'https://recued.example.com', hostname: 'recued.example.com' },
        { use: 'reception', source: 'automatic', base_url: 'https://recued.example.com' },
        { use: 'customer_access', source: 'automatic', base_url: 'https://recued.example.com' },
      ],
      choices: [
        { hostname: 'recued.example.com', base_url: 'https://recued.example.com' },
        { hostname: 'alice.recued.net', base_url: 'https://alice.recued.net' },
      ],
      // A deep link needs a root that lands on the app: only the Pro address
      // in `redirect` mode. An answer link opens `/ask`, which both serve.
      links_now: { app: 'https://alice.recued.net', answers: 'https://recued.example.com' },
    });
  });
});

describe('createSqlitePublicAddressStore', () => {
  it('keeps verdicts and the published answer across store instances', () => {
    const db = new Database(':memory:');
    const first = createSqlitePublicAddressStore(db);
    first.putVerdict(verdict('alice.recued.net', { last_error: 'timeout' }));
    first.putVerdict(verdict('alice.recued.net', { https_ok: false }));
    first.publish({ root: ['https://alice.recued.net'] }, NOW);
    const second = createSqlitePublicAddressStore(db);
    expect(second.verdict('alice.recued.net', 443)).toEqual(verdict('alice.recued.net', { https_ok: false }));
    expect(second.verdict('alice.recued.net', 8446)).toBeNull();
    expect(second.published('root')).toEqual(['https://alice.recued.net']);
    expect(second.published('ask')).toBeNull();
  });

  it('keeps the names kept per use, and forgets one on null', () => {
    const db = new Database(':memory:');
    const first = createSqlitePublicAddressStore(db);
    first.setPin('webhooks', { hostname: 'alice.recued.net', by: 'first_use', at: NOW });
    first.setPin('reception', { hostname: 'shop.example.com', by: 'owner', at: NOW });
    first.setPin('reception', null);
    expect(createSqlitePublicAddressStore(db).pins())
      .toEqual({ webhooks: { hostname: 'alice.recued.net', by: 'first_use', at: NOW } });
    db.prepare(`INSERT OR REPLACE INTO server_config (key, value) VALUES (?, ?)`)
      .run('public_address_pins', JSON.stringify({ webhooks: { hostname: '', by: 'owner', at: 1 }, bogus: {} }));
    expect(createSqlitePublicAddressStore(db).pins()).toEqual({});
  });

  it('reads a damaged row as nothing', () => {
    const db = new Database(':memory:');
    createSqlitePublicAddressStore(db);
    db.prepare(`INSERT OR REPLACE INTO server_config (key, value) VALUES (?, ?)`)
      .run('public_address_probes', '{not json');
    db.prepare(`INSERT OR REPLACE INTO server_config (key, value) VALUES (?, ?)`)
      .run('public_address_published', '[1,2]');
    const store = createSqlitePublicAddressStore(db);
    expect(store.verdict('alice.recued.net', 443)).toBeNull();
    expect(store.published('root')).toBeNull();
  });
});

describe('createCloudReachabilityProber', () => {
  const answer = (status: number, body: unknown) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status }));

  it('asks about the port twice — https on /health, and a bare connect', async () => {
    const fetchImpl = answer(200, { data: { per_target: [
      { port: 443, kind: 'http', role: 'health', reachable: true, tls_valid: true, handshake_ms: 12 },
      { port: 443, kind: 'tcp', reachable: true, handshake_ms: 3 },
    ] } });
    const prober = createCloudReachabilityProber({
      endpoint: () => 'https://probe.recued.com/v1/reachability/probe', fetchImpl, now: () => NOW,
    });
    expect(await prober.probe('alice.recued.net', 443)).toEqual({
      kind: 'verdict',
      verdict: { hostname: 'alice.recued.net', port: 443, probed_at: NOW, port_open: true, https_ok: true },
    });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://probe.recued.com/v1/reachability/probe');
    expect(JSON.parse(String(init.body))).toEqual({
      hostname: 'alice.recued.net',
      targets: [{ port: 443, kind: 'http', role: 'health' }, { port: 443, kind: 'tcp' }],
    });
  });

  it('an open port with https failing is port_open without https_ok, with the reason', async () => {
    const prober = createCloudReachabilityProber({
      endpoint: () => 'https://probe', now: () => NOW,
      fetchImpl: answer(200, { data: { per_target: [
        { port: 443, kind: 'http', reachable: false, tls_valid: false, handshake_ms: 9, last_error: 'bad cert' },
        { port: 443, kind: 'tcp', reachable: true, handshake_ms: 3 },
      ] } }),
    });
    expect(await prober.probe('alice.recued.net', 443)).toMatchObject({
      verdict: { port_open: true, https_ok: false, last_error: 'bad cert' },
    });
  });

  it('a name that does not resolve is an answer: nothing answers', async () => {
    const prober = createCloudReachabilityProber({
      endpoint: () => 'https://probe', now: () => NOW,
      fetchImpl: answer(200, { data: { per_target: [
        { port: 443, kind: 'http', reachable: false, handshake_ms: 0, last_error: 'dns_unresolved' },
        { port: 443, kind: 'tcp', reachable: false, handshake_ms: 0, last_error: 'dns_unresolved' },
      ] } }),
    });
    expect(await prober.probe('alice.recued.net', 443)).toMatchObject({
      verdict: { port_open: false, https_ok: false, last_error: 'dns_unresolved' },
    });
  });

  it('a name resolving to a private address is an answer too', async () => {
    const prober = createCloudReachabilityProber({
      endpoint: () => 'https://probe', now: () => NOW,
      fetchImpl: answer(403, { error: { code: 'reachability_private_ip_denied', message: 'x' } }),
    });
    expect(await prober.probe('alice.recued.net', 443)).toMatchObject({
      verdict: { port_open: false, https_ok: false, last_error: 'resolves_to_private_ip' },
    });
  });

  it('rate-limited, refused, unreachable or garbled is no answer', async () => {
    const probeWith = (fetchImpl: (input: string, init?: RequestInit) => Promise<Response>) =>
      createCloudReachabilityProber({ endpoint: () => 'https://probe', fetchImpl }).probe('a.recued.net', 443);
    expect(await probeWith(answer(429, { error: { code: 'reachability_rate_limited' } })))
      .toEqual({ kind: 'rate_limited' });
    expect(await probeWith(answer(400, { error: { code: 'reachability_hostname_invalid' } })))
      .toEqual({ kind: 'failed', reason: 'http_400' });
    expect(await probeWith(async () => { throw new Error('offline'); }))
      .toEqual({ kind: 'failed', reason: 'offline' });
    expect(await probeWith(answer(200, { data: { per_target: [] } })))
      .toEqual({ kind: 'failed', reason: 'malformed_response' });
  });
});

describe('createListenerPublicAddressFacts', () => {
  it('knows the grid only once read or pushed, and keeps the last reading when a read fails', async () => {
    let read: () => Promise<Record<PathRole, PathResolution>> = async () => ALL_PUBLIC();
    const f = createListenerPublicAddressFacts({
      readResolution: () => read(),
      apexMode: () => 'redirect',
      webclientBundleLoaded: false,
      publicListenerBound: () => true,
    });
    expect(f.pathPublic('ask')).toBeNull();
    await f.refresh?.();
    expect(f.pathPublic('ask')).toBe(true);
    f.setResolution({ ...ALL_PUBLIC(), ask: { lan: true, public: false } });
    expect(f.pathPublic('ask')).toBe(false);
    read = async () => { throw new Error('machine not wired'); };
    await f.refresh?.();
    expect(f.pathPublic('ask')).toBe(false);
  });
});

describe('canonicalServerPublicOrigins', () => {
  it('takes one URL, a list, or nothing', () => {
    expect(canonicalServerPublicOrigins('https://alice.recued.net')).toEqual(['https://alice.recued.net']);
    expect(canonicalServerPublicOrigins(['https://a.example.com', 'https://b.example.com']))
      .toEqual(['https://a.example.com', 'https://b.example.com']);
    expect(canonicalServerPublicOrigins(null)).toEqual([]);
  });

  it('drops what is not a clean https origin, canonicalizes, and never repeats', () => {
    expect(canonicalServerPublicOrigins([
      'http://h.example.com',
      'https://h.example.com/path',
      'https://h.example.com/',
      'https://h.example.com',
    ])).toEqual(['https://h.example.com']);
  });
});
