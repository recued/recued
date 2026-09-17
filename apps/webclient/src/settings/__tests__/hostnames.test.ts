import { describe, expect, it, vi } from 'vitest';

import type {
  DiagnosticResponse,
  HostnameCertSource,
  HostnameOwnershipStatus,
  HostnameProjection,
  HostnameTlsTopology,
  HostnameVerificationMethod,
  ProConvenienceItemState,
  ProConvenienceStatusResponse,
} from '@recued/contracts';

import {
  HOSTNAMES_LOCAL_URLS_ATTR,
  HOSTNAMES_LOCAL_URL_KIND_ATTR,
  HOSTNAMES_LOCAL_URL_ROW_ATTR,
  HOSTNAMES_PANEL_EMPTY_ATTR,
  HOSTNAMES_PANEL_ERROR_ATTR,
  HOSTNAMES_PANEL_STYLES,
  HOSTNAMES_DETAIL_PANEL_ATTR,
  HOSTNAMES_DDNS_SECTION_ATTR,
  HOSTNAMES_DDNS_STATE_ATTR,
  HOSTNAMES_DDNS_TOGGLE_ATTR,
  HOSTNAMES_DDNS_BLOCKED_ATTR,
  HOSTNAMES_DDNS_ERROR_ATTR,
  HOSTNAMES_REMOVE_CONFIRM_PANEL_ATTR,
  HOSTNAMES_ROW_ATTR,
  HOSTNAMES_ROW_STATUS_ATTR,
  ddnsPauseWouldSelfDisconnect,
  mountHostnamesPanel,
  type DdnsControlContext,
  type DdnsControlContextCaller,
  type DdnsSetEnabledCaller,
  type DdnsStatusCaller,
  type HostnamesAddCaller,
  type HostnamesGetCaller,
  type HostnamesListCaller,
  type HostnamesRemoveCaller,
  type HostnamesUpdateCaller,
  type HostnamesVerifyOwnershipCaller,
  type NetworkLocalUrlsCaller,
} from '../hostnames.js';
import type { ReachabilityExternalProbeCaller } from '../reachability.js';
import {
  SETTINGS_ROUTE_SECTION_ATTR,
  bootstrapSettingsRoute,
  type BootstrapSettingsRouteOptions,
} from '../bootstrap-settings-route.js';
import { createInMemoryWebclientLocalStore } from '../../storage/local-store.js';

interface FakeElement {
  tagName: string;
  textContent: string;
  disabled: boolean;
  checked: boolean;
  className: string;
  value: string;
  type: string;
  children: FakeElement[];
  parent: FakeElement | null;
  attrs: Map<string, string>;
  listeners: Map<string, Array<(ev: unknown) => void>>;
  setAttribute(k: string, v: string): void;
  removeAttribute(k: string): void;
  getAttribute(k: string): string | null;
  hasAttribute(k: string): boolean;
  appendChild(el: FakeElement): FakeElement;
  removeChild(el: FakeElement): FakeElement;
  readonly firstChild: FakeElement | null;
  remove(): void;
  addEventListener(name: string, fn: (ev: unknown) => void): void;
  removeEventListener(name: string, fn: (ev: unknown) => void): void;
  click(): void;
  dispatch(name: string): void;
  classList: { add: (cls: string) => void };
}

const makeFakeElement = (tagName: string): FakeElement => {
  const el: FakeElement = {
    tagName: tagName.toUpperCase(),
    textContent: '',
    disabled: false,
    checked: false,
    className: '',
    value: '',
    type: '',
    children: [],
    parent: null,
    attrs: new Map(),
    listeners: new Map(),
    classList: {
      add(cls) {
        el.className = el.className === '' ? cls : `${el.className} ${cls}`;
      },
    },
    setAttribute(k, v) {
      el.attrs.set(k, v);
    },
    removeAttribute(k) {
      el.attrs.delete(k);
    },
    getAttribute(k) {
      return el.attrs.get(k) ?? null;
    },
    hasAttribute(k) {
      return el.attrs.has(k);
    },
    appendChild(child) {
      el.children.push(child);
      child.parent = el;
      return child;
    },
    removeChild(child) {
      const idx = el.children.indexOf(child);
      if (idx < 0) throw new Error('removeChild: not a child');
      el.children.splice(idx, 1);
      child.parent = null;
      return child;
    },
    get firstChild() {
      return el.children[0] ?? null;
    },
    remove() {
      if (el.parent) el.parent.removeChild(el);
    },
    addEventListener(name, fn) {
      const arr = el.listeners.get(name) ?? [];
      arr.push(fn);
      el.listeners.set(name, arr);
    },
    removeEventListener(name, fn) {
      const arr = el.listeners.get(name);
      if (!arr) return;
      const idx = arr.indexOf(fn);
      if (idx >= 0) arr.splice(idx, 1);
    },
    click() {
      for (const fn of el.listeners.get('click') ?? []) fn({ target: el });
    },
    dispatch(name) {
      for (const fn of el.listeners.get(name) ?? []) fn({ target: el });
    },
  };
  return el;
};

interface FakeDocument {
  createElement(tag: string): FakeElement;
  createTextNode(text: string): FakeElement;
  head: {
    appendChild(el: FakeElement): FakeElement;
    querySelector(selector: string): FakeElement | null;
  };
  styleTags: FakeElement[];
}

const makeFakeDocument = (): FakeDocument => {
  const styleTags: FakeElement[] = [];
  const parseSelector = (selector: string): { tag: string; attr: string } | null => {
    const match = selector.match(/^([\w-]+)\[([\w-]+)\]$/);
    if (match === null) return null;
    return { tag: match[1]!.toUpperCase(), attr: match[2]! };
  };
  return {
    createElement: makeFakeElement,
    createTextNode(text) {
      const node = makeFakeElement('#text');
      node.textContent = text;
      return node;
    },
    head: {
      appendChild(el) {
        styleTags.push(el);
        return el;
      },
      querySelector(selector) {
        const parsed = parseSelector(selector);
        if (parsed === null) return null;
        return (
          styleTags.find(
            (tag) => tag.tagName === parsed.tag && tag.hasAttribute(parsed.attr),
          ) ?? null
        );
      },
    },
    styleTags,
  };
};

const findAllByAttr = (
  root: FakeElement,
  attr: string,
  value?: string,
  out: FakeElement[] = [],
): FakeElement[] => {
  if (
    root.hasAttribute(attr)
    && (value === undefined || root.getAttribute(attr) === value)
  ) {
    out.push(root);
  }
  for (const child of root.children) findAllByAttr(child, attr, value, out);
  return out;
};

const findByAttr = (
  root: FakeElement,
  attr: string,
  value?: string,
): FakeElement | null => findAllByAttr(root, attr, value)[0] ?? null;

const textOf = (root: FakeElement): string =>
  `${root.textContent}${root.children.map(textOf).join('')}`;

const hostname = (
  name: string,
  overrides: Partial<HostnameProjection> = {},
): HostnameProjection => {
  const cert_source =
    (overrides.cert_source as HostnameCertSource | undefined) ?? 'byo_external';
  const tls_topology =
    (overrides.tls_topology as HostnameTlsTopology | undefined)
    ?? (cert_source === 'byo_external' ? 'upstream_terminated' : 'server_terminated');
  return {
    hostname_id: `hn-${name}`,
    hostname: name,
    cert_source,
    ownership_status:
      (overrides.ownership_status as HostnameOwnershipStatus | undefined) ?? 'pending',
    verification_method:
      (overrides.verification_method as HostnameVerificationMethod | undefined)
      ?? (cert_source === 'recued_acme' ? undefined : 'dns_txt'),
    listener_ports: [443],
    ddns_managed: cert_source === 'recued_acme',
    enabled: true,
    tls_topology,
    ...overrides,
  };
};

const diagnosticResponse = (
  hostname: string,
  overrides: Partial<DiagnosticResponse> = {},
): DiagnosticResponse => ({
  account_id: 'acct-1',
  hostname,
  detected_public_ip: '203.0.113.5',
  resolved_ips: ['203.0.113.5'],
  results: [],
  probed_at: 1_700_000_000_000,
  ...overrides,
});

const mountPanel = (opts: {
  rows?: ReadonlyArray<HostnameProjection>;
  runList?: HostnamesListCaller;
  runGet?: HostnamesGetCaller;
  runAdd?: HostnamesAddCaller;
  runUpdate?: HostnamesUpdateCaller;
  runRemove?: HostnamesRemoveCaller;
  runVerify?: HostnamesVerifyOwnershipCaller;
  runExternalProbe?: ReachabilityExternalProbeCaller;
  runLocalUrls?: NetworkLocalUrlsCaller;
  runDdnsStatus?: DdnsStatusCaller;
  runDdnsSetEnabled?: DdnsSetEnabledCaller;
  runDdnsControlContext?: DdnsControlContextCaller;
} = {}) => {
  const doc = makeFakeDocument();
  const host = makeFakeElement('div');
  const runList = vi.fn<HostnamesListCaller>();
  runList.mockImplementation(
    opts.runList ?? (async () => ({ hostnames: [...(opts.rows ?? [])] })),
  );
  const runGet = vi.fn<HostnamesGetCaller>();
  runGet.mockImplementation(
    opts.runGet
      ?? (async (input) => ({
        hostname: (opts.rows ?? []).find((row) => row.hostname === input.hostname) ?? null,
      })),
  );
  const runAdd = vi.fn<HostnamesAddCaller>();
  runAdd.mockImplementation(
    opts.runAdd
      ?? (async (input) => ({
        hostname: hostname(input.hostname, {
          cert_source: input.cert_source,
          verification_method: input.verification_method,
          enabled: input.enabled ?? false,
        }),
      })),
  );
  const runUpdate = vi.fn<HostnamesUpdateCaller>();
  runUpdate.mockImplementation(
    opts.runUpdate
      ?? (async (input) => {
        const base =
          (opts.rows ?? []).find((row) => row.hostname === input.hostname)
          ?? hostname(input.hostname);
        return {
          hostname: {
            ...base,
            cert_source: input.cert_source ?? base.cert_source,
            verification_method:
              input.verification_method ?? base.verification_method,
            enabled: input.enabled ?? base.enabled,
          },
        };
      }),
  );
  const runRemove = vi.fn<HostnamesRemoveCaller>();
  runRemove.mockImplementation(opts.runRemove ?? (async () => ({ removed: true })));
  const runVerify = vi.fn<HostnamesVerifyOwnershipCaller>();
  runVerify.mockImplementation(
    opts.runVerify
      ?? (async (input) => {
        const row = hostname(input.hostname, {
          ownership_status: 'verified',
          verification_method: input.method,
        });
        return {
          ok: true,
          hostname: row.hostname,
          method: input.method,
          status: 'verified',
          projection: row,
        };
      }),
  );
  const runExternalProbe = vi.fn<ReachabilityExternalProbeCaller>();
  if (opts.runExternalProbe !== undefined) {
    runExternalProbe.mockImplementation(opts.runExternalProbe);
  }
  const runLocalUrls = vi.fn<NetworkLocalUrlsCaller>();
  if (opts.runLocalUrls !== undefined) {
    runLocalUrls.mockImplementation(opts.runLocalUrls);
  }

  const panel = mountHostnamesPanel({
    host: host as unknown as HTMLElement,
    document: doc as unknown as Document,
    runList,
    runGet,
    runAdd,
    runUpdate,
    runRemove,
    runVerifyOwnership: runVerify,
    ...(opts.runExternalProbe !== undefined ? { runExternalProbe } : {}),
    ...(opts.runLocalUrls !== undefined ? { runLocalUrls } : {}),
    ...(opts.runDdnsStatus !== undefined ? { runDdnsStatus: opts.runDdnsStatus } : {}),
    ...(opts.runDdnsSetEnabled !== undefined
      ? { runDdnsSetEnabled: opts.runDdnsSetEnabled }
      : {}),
    ...(opts.runDdnsControlContext !== undefined
      ? { runDdnsControlContext: opts.runDdnsControlContext }
      : {}),
  });
  return {
    doc,
    host,
    panel,
    calls: {
      runList,
      runGet,
      runAdd,
      runUpdate,
      runRemove,
      runVerify,
      runExternalProbe,
      runLocalUrls,
    },
  };
};

const requiredHostnameCallers = (): Pick<
  BootstrapSettingsRouteOptions,
  | 'hostnamesListCaller'
  | 'hostnamesGetCaller'
  | 'hostnamesAddCaller'
  | 'hostnamesUpdateCaller'
  | 'hostnamesRemoveCaller'
  | 'hostnamesVerifyOwnershipCaller'
> => ({
  hostnamesListCaller: vi.fn(async () => ({ hostnames: [] })),
  hostnamesGetCaller: vi.fn(async (input) => ({ hostname: hostname(input.hostname) })),
  hostnamesAddCaller: vi.fn(async (input) => ({
    hostname: hostname(input.hostname, {
      cert_source: input.cert_source,
      verification_method: input.verification_method,
      enabled: input.enabled ?? false,
    }),
  })),
  hostnamesUpdateCaller: vi.fn(async (input) => ({
    hostname: hostname(input.hostname, {
      cert_source: input.cert_source ?? 'byo_external',
      verification_method: input.verification_method ?? 'dns_txt',
      enabled: input.enabled ?? true,
    }),
  })),
  hostnamesRemoveCaller: vi.fn(async () => ({ removed: true })),
  hostnamesVerifyOwnershipCaller: vi.fn(async (input) => ({
    ok: true as const,
    hostname: input.hostname,
    method: input.method,
    status: 'verified' as const,
    projection: hostname(input.hostname, {
      ownership_status: 'verified',
      verification_method: input.method,
    }),
  })),
});

describe('D-152 P6 hostnames panel', () => {
  it('lists hostname registry rows and renders the empty state', async () => {
    const empty = mountPanel({ rows: [] });
    await empty.panel.whenLoaded();
    expect(findByAttr(empty.host, HOSTNAMES_PANEL_EMPTY_ATTR)).not.toBeNull();
    empty.panel.dispose();

    const { host, panel } = mountPanel({
      rows: [
        hostname('pages.example', {
          cert_source: 'byo_external',
          ownership_status: 'pending',
          verification_method: 'dns_txt',
        }),
        hostname('app.recued.cloud', {
          cert_source: 'recued_acme',
          ownership_status: 'verified',
        }),
      ],
    });
    await panel.whenLoaded();

    expect(panel.getState().hostnames).toHaveLength(2);
    expect(findByAttr(host, HOSTNAMES_ROW_ATTR, 'pages.example')).not.toBeNull();
    expect(findByAttr(host, HOSTNAMES_ROW_STATUS_ATTR, 'pending')).not.toBeNull();
    expect(textOf(host)).toContain('Managed by Recued');
    panel.dispose();
  });

  /** ⛔ THE PILL USED TO SHOW OWNERSHIP, WHICH IS A DIFFERENT QUESTION. A Pro
   *  DDNS row registered by the enrollment service is `ownership_status:
   *  'verified'` the INSTANT it appears — the handle reservation is the proof
   *  for a Recued-controlled zone — so the panel said "Verified" while there
   *  was no certificate at all, at exactly the moment a new user is watching to
   *  see whether their hostname works. */
  it('shows PROVISIONING, not "Verified", while the certificate is pending', async () => {
    const { host, panel } = mountPanel({
      rows: [
        hostname('alice.recued.net', {
          cert_source: 'recued_acme',
          ownership_status: 'verified',   // ownership IS settled…
          cert_provisioning: 'pending',   // …but there is no cert yet
        }),
      ],
    });
    await panel.whenLoaded();

    expect(findByAttr(host, HOSTNAMES_ROW_STATUS_ATTR, 'pending')).not.toBeNull();
    expect(textOf(host)).toContain('Provisioning');
    expect(textOf(host)).not.toContain('Verified');
    panel.dispose();
  });

  it('distinguishes a FAILED attempt from one that has not started', async () => {
    // The difference a waiting user actually cares about, and the reason this
    // is persisted rather than derived from a missing `cert_fingerprint`.
    const { host, panel } = mountPanel({
      rows: [
        hostname('alice.recued.net', {
          cert_source: 'recued_acme',
          ownership_status: 'verified',
          cert_provisioning: 'failed',
          cert_last_error: 'subscription_required',
        }),
      ],
    });
    await panel.whenLoaded();

    expect(findByAttr(host, HOSTNAMES_ROW_STATUS_ATTR, 'failed')).not.toBeNull();
    expect(textOf(host)).toContain('Trying again');
    panel.dispose();
  });

  /** ⚠ A row written before the column existed has no `cert_provisioning`.
   *  Absent must mean UNKNOWN and fall back to ownership — defaulting it to
   *  'pending' would make every already-working legacy hostname read as if it
   *  had never been provisioned. */
  it('falls back to ownership for a legacy row with no provisioning state', async () => {
    const { host, panel } = mountPanel({
      rows: [
        hostname('legacy.example', {
          cert_source: 'byo_external',
          ownership_status: 'verified',
        }),
      ],
    });
    await panel.whenLoaded();

    expect(findByAttr(host, HOSTNAMES_ROW_STATUS_ATTR, 'verified')).not.toBeNull();
    panel.dispose();
  });

  it('adds a BYO hostname and carries the token hash into the verify flow', async () => {
    const added = hostname('token.example', {
      ownership_status: 'pending',
      verification_method: 'dns_txt',
    });
    const verified = { ...added, ownership_status: 'verified' as const };
    const { host, panel, calls } = mountPanel({
      rows: [],
      runAdd: async () => ({ hostname: added }),
      runVerify: async (input) => ({
        ok: true,
        hostname: input.hostname,
        method: input.method,
        status: 'verified',
        projection: verified,
      }),
    });
    await panel.whenLoaded();

    panel.openAdd();
    panel.setAddField('hostname', 'token.example');
    panel.setAddField('cert_source', 'byo_external');
    panel.setAddField('verification_method', 'dns_txt');
    panel.setAddField('verification_token_hash', 'sha256:expected');
    await panel.submitAdd();

    expect(calls.runAdd).toHaveBeenCalledWith({
      hostname: 'token.example',
      cert_source: 'byo_external',
      enabled: true,
      // The add form now STATES the listener ports rather than letting the
      // registry's `normalizePorts` substitute `[443]` silently — the request
      // carries the field on every add, defaulted or not.
      listener_ports: [443],
      verification_method: 'dns_txt',
      verification_token_hash: 'sha256:expected',
    });
    expect(panel.getState().verify.hostname).toBe('token.example');
    expect(panel.getState().verify.observed_token_hash).toBe('sha256:expected');

    await panel.submitVerify();

    expect(calls.runVerify).toHaveBeenCalledWith({
      hostname: 'token.example',
      method: 'dns_txt',
      observed_token_hash: 'sha256:expected',
    });
    expect(panel.getState().hostnames[0]!.ownership_status).toBe('verified');
    expect(findByAttr(host, HOSTNAMES_ROW_STATUS_ATTR, 'verified')).not.toBeNull();
    panel.dispose();
  });

  it('loads hostname detail through collection.hostname.get and reconciles the row', async () => {
    const seed = hostname('detail.example', {
      enabled: false,
      cert_fingerprint: 'sha256:old',
    });
    const detailed = hostname('detail.example', {
      enabled: true,
      cert_fingerprint: 'sha256:updated-full-fingerprint',
      cert_chain_metadata: {
        issuer: 'Test Root CA',
        subject: 'CN=detail.example',
      },
    });
    const { host, panel, calls } = mountPanel({
      rows: [seed],
      runGet: async () => ({ hostname: detailed }),
    });
    await panel.whenLoaded();

    await panel.openDetail('detail.example');

    expect(calls.runGet).toHaveBeenCalledWith({ hostname: 'detail.example' });
    expect(panel.getState().detail.projection).toMatchObject({
      hostname: 'detail.example',
      enabled: true,
      cert_fingerprint: 'sha256:updated-full-fingerprint',
    });
    expect(panel.getState().hostnames[0]!.enabled).toBe(true);
    expect(findByAttr(host, HOSTNAMES_DETAIL_PANEL_ATTR, 'detail.example')).not.toBeNull();
    expect(textOf(host)).toContain('Test Root CA');
    panel.dispose();
  });

  it('updates a hostname without resetting proof config for enable-only edits', async () => {
    const row = hostname('toggle.example', {
      cert_source: 'byo_external',
      verification_method: 'dns_txt',
      ownership_status: 'verified',
      enabled: true,
    });
    const updated = { ...row, enabled: false };
    const { panel, calls } = mountPanel({
      rows: [row],
      runUpdate: async () => ({ hostname: updated }),
    });
    await panel.whenLoaded();

    panel.openUpdate('toggle.example');
    panel.setUpdateField('enabled', false);
    await panel.submitUpdate();

    expect(calls.runUpdate).toHaveBeenCalledWith({
      hostname: 'toggle.example',
      enabled: false,
    });
    expect(panel.getState().hostnames[0]!.enabled).toBe(false);
    expect(panel.getState().update.hostname).toBeNull();
    panel.dispose();
  });

  it('sends changed proof config and token hash through update', async () => {
    const row = hostname('proof.example', {
      cert_source: 'byo_external',
      verification_method: 'dns_txt',
      ownership_status: 'verified',
      enabled: true,
    });
    const updated = {
      ...row,
      verification_method: 'http_token' as const,
      ownership_status: 'pending' as const,
    };
    const { panel, calls } = mountPanel({
      rows: [row],
      runUpdate: async () => ({ hostname: updated }),
    });
    await panel.whenLoaded();

    panel.openUpdate('proof.example');
    panel.setUpdateField('verification_method', 'http_token');
    panel.setUpdateField('verification_token_hash', 'sha256:new-proof');
    await panel.submitUpdate();

    expect(calls.runUpdate).toHaveBeenCalledWith({
      hostname: 'proof.example',
      verification_method: 'http_token',
      verification_token_hash: 'sha256:new-proof',
    });
    expect(panel.getState().hostnames[0]!.ownership_status).toBe('pending');
    panel.dispose();
  });

  it('removes a hostname through the remove rpc and clears the stale row', async () => {
    const { host, panel, calls } = mountPanel({
      rows: [hostname('stale.example')],
    });
    await panel.whenLoaded();

    panel.openRemove('stale.example');
    expect(findByAttr(host, HOSTNAMES_REMOVE_CONFIRM_PANEL_ATTR, 'stale.example')).not.toBeNull();

    await panel.confirmRemove();

    expect(calls.runRemove).toHaveBeenCalledWith({ hostname: 'stale.example' });
    expect(panel.getState().hostnames).toHaveLength(0);
    expect(findByAttr(host, HOSTNAMES_PANEL_EMPTY_ATTR)).not.toBeNull();
    panel.dispose();
  });

  it('surfaces expected verifyOwnership failures inline', async () => {
    const { host, panel } = mountPanel({
      rows: [
        hostname('token.example', {
          cert_source: 'byo_external',
          verification_method: 'dns_txt',
        }),
      ],
      runVerify: async (input) => ({
        ok: false,
        code: 'method_mismatch',
        hostname: input.hostname,
        method: input.method,
        expected_method: 'dns_txt',
        cert_source: 'byo_external',
      }),
    });
    await panel.whenLoaded();

    panel.openVerify('token.example');
    panel.setVerifyField('method', 'http_token');
    panel.setVerifyField('observed_token_hash', 'sha256:observed');
    await panel.submitVerify();

    expect(panel.getState().verify.error).toBe('Expected DNS TXT.');
    expect(findByAttr(host, HOSTNAMES_PANEL_ERROR_ATTR)).not.toBeNull();
    panel.dispose();
  });

  it('auto-populates observed token hash from the external probe before verifyOwnership', async () => {
    const { panel, calls } = mountPanel({
      rows: [
        hostname('token.example', {
          ownership_status: 'pending',
          verification_method: 'dns_txt',
        }),
      ],
      runExternalProbe: async () =>
        diagnosticResponse('token.example', {
          observed_token_hash: 'sha256:observed',
        }),
    });
    await panel.whenLoaded();

    panel.openVerify('token.example');
    await panel.submitVerify();

    expect(calls.runExternalProbe).toHaveBeenCalledWith({
      hostname: 'token.example',
      ownership_probe_method: 'dns_txt',
    });
    expect(panel.getState().verify.observed_token_hash).toBe('sha256:observed');
    expect(calls.runVerify).toHaveBeenCalledWith({
      hostname: 'token.example',
      method: 'dns_txt',
      observed_token_hash: 'sha256:observed',
    });
    panel.dispose();
  });

  it('renders the "Reachable on your network" section from network.local_urls', async () => {
    const { host, panel, calls } = mountPanel({
      rows: [hostname('pages.example', { cert_source: 'byo_external' })],
      runLocalUrls: async () => ({
        urls: [
          { url: 'http://localhost:8443', kind: 'loopback' },
          { url: 'http://192.168.1.42:8443', kind: 'lan' },
        ],
      }),
    });
    await panel.whenLoaded();

    expect(calls.runLocalUrls).toHaveBeenCalledTimes(1);
    expect(panel.getState().localUrls).toHaveLength(2);

    const section = findByAttr(host, HOSTNAMES_LOCAL_URLS_ATTR);
    expect(section).not.toBeNull();
    expect(textOf(section!)).toContain('Reachable on your network');

    // Both addresses render as copy-friendly rows keyed by URL...
    expect(
      findByAttr(host, HOSTNAMES_LOCAL_URL_ROW_ATTR, 'http://localhost:8443'),
    ).not.toBeNull();
    expect(
      findByAttr(host, HOSTNAMES_LOCAL_URL_ROW_ATTR, 'http://192.168.1.42:8443'),
    ).not.toBeNull();
    expect(textOf(host)).toContain('http://192.168.1.42:8443');

    // ...each carrying its loopback / lan kind chip.
    expect(findByAttr(host, HOSTNAMES_LOCAL_URL_KIND_ATTR, 'loopback')).not.toBeNull();
    expect(findByAttr(host, HOSTNAMES_LOCAL_URL_KIND_ATTR, 'lan')).not.toBeNull();

    // The registry rows still render alongside the new section.
    expect(findByAttr(host, HOSTNAMES_ROW_ATTR, 'pages.example')).not.toBeNull();
    panel.dispose();
  });

  it('omits the "Reachable on your network" section when no caller is supplied', async () => {
    const { host, panel, calls } = mountPanel({
      rows: [hostname('pages.example')],
    });
    await panel.whenLoaded();

    expect(calls.runLocalUrls).not.toHaveBeenCalled();
    expect(panel.getState().localUrls).toHaveLength(0);
    expect(findByAttr(host, HOSTNAMES_LOCAL_URLS_ATTR)).toBeNull();
    // The registry rows still render — the section is purely additive.
    expect(findByAttr(host, HOSTNAMES_ROW_ATTR, 'pages.example')).not.toBeNull();
    panel.dispose();
  });

  it('keeps the registry rows when the local-urls call fails', async () => {
    const { host, panel } = mountPanel({
      rows: [hostname('pages.example')],
      runLocalUrls: async () => {
        throw new Error('network.local_urls unavailable');
      },
    });
    await panel.whenLoaded();

    // A failing local-urls read renders no section but never disrupts the list
    // nor surfaces a panel error.
    expect(findByAttr(host, HOSTNAMES_LOCAL_URLS_ATTR)).toBeNull();
    expect(panel.getState().error).toBeNull();
    expect(findByAttr(host, HOSTNAMES_ROW_ATTR, 'pages.example')).not.toBeNull();
    panel.dispose();
  });
});

const ddnsContext = (
  overrides: Partial<DdnsControlContext> = {},
): DdnsControlContext => ({
  published: true,
  ddnsHostname: 'alice.recued.net',
  blockToggle: false,
  ...overrides,
});

const flushMicrotasks = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

describe('R27 delta-B — ddnsPauseWouldSelfDisconnect (fail-closed guard)', () => {
  it('BLOCKS (true) when the dialed host is the handle — incl. case + trailing dot + port', () => {
    expect(ddnsPauseWouldSelfDisconnect('wss://alice.recued.net:8443/ws', 'alice.recued.net')).toBe(true);
    expect(ddnsPauseWouldSelfDisconnect('wss://ALICE.recued.net/ws', 'alice.recued.net')).toBe(true);
    // trailing DNS root dot must still match (the earlier fail-open bug)
    expect(ddnsPauseWouldSelfDisconnect('wss://alice.recued.net./ws', 'alice.recued.net')).toBe(true);
    expect(ddnsPauseWouldSelfDisconnect('wss://alice.recued.net/ws', 'alice.recued.net.')).toBe(true);
  });

  it('ALLOWS (false) only when the dialed host PROVABLY differs', () => {
    expect(ddnsPauseWouldSelfDisconnect('wss://192.168.1.5:8443/ws', 'alice.recued.net')).toBe(false);
    expect(ddnsPauseWouldSelfDisconnect('wss://bob.example.com/ws', 'alice.recued.net')).toBe(false);
  });

  it('FAILS CLOSED (true) when it cannot prove safety', () => {
    expect(ddnsPauseWouldSelfDisconnect(null, 'alice.recued.net')).toBe(true); // no server_url
    expect(ddnsPauseWouldSelfDisconnect('wss://alice.recued.net/ws', null)).toBe(true); // no hostname
    expect(ddnsPauseWouldSelfDisconnect('not a url', 'alice.recued.net')).toBe(true); // unparseable
    expect(ddnsPauseWouldSelfDisconnect('', 'alice.recued.net')).toBe(true);
  });
});

describe('R27 delta-B — Pro DDNS toggle (hostnames panel)', () => {
  it('renders no Pro DDNS section when the ddns callers are absent', async () => {
    const { host, panel } = mountPanel();
    await panel.whenLoaded();
    expect(findByAttr(host, HOSTNAMES_DDNS_SECTION_ATTR)).toBeNull();
    panel.dispose();
  });

  it('renders no Pro DDNS section when DDNS is not published (gate)', async () => {
    const { host, panel } = mountPanel({
      runDdnsStatus: vi.fn(async () => ({ enabled: true })),
      runDdnsSetEnabled: vi.fn(async () => ({ enabled: false })),
      runDdnsControlContext: vi.fn(async () => ddnsContext({ published: false })),
    });
    await panel.whenLoaded();
    expect(findByAttr(host, HOSTNAMES_DDNS_SECTION_ATTR)).toBeNull();
    panel.dispose();
  });

  it('offers Pause + the billing warning when published, enabled, not connected-via-handle', async () => {
    const { host, panel } = mountPanel({
      runDdnsStatus: vi.fn(async () => ({ enabled: true })),
      runDdnsSetEnabled: vi.fn(async () => ({ enabled: false })),
      runDdnsControlContext: vi.fn(async () => ddnsContext()),
    });
    await panel.whenLoaded();
    expect(findByAttr(host, HOSTNAMES_DDNS_SECTION_ATTR)).not.toBeNull();
    expect(findByAttr(host, HOSTNAMES_DDNS_TOGGLE_ATTR)?.textContent).toBe('Pause the address');
    expect(findByAttr(host, HOSTNAMES_DDNS_BLOCKED_ATTR)).toBeNull();
    expect(textOf(host)).toContain('does NOT cancel Pro');
    panel.dispose();
  });

  it('offers Resume when paused', async () => {
    const { host, panel } = mountPanel({
      runDdnsStatus: vi.fn(async () => ({ enabled: false })),
      runDdnsSetEnabled: vi.fn(async () => ({ enabled: true })),
      runDdnsControlContext: vi.fn(async () => ddnsContext()),
    });
    await panel.whenLoaded();
    expect(findByAttr(host, HOSTNAMES_DDNS_TOGGLE_ATTR)?.textContent).toBe('Start the address again');
    expect(
      findByAttr(host, HOSTNAMES_DDNS_STATE_ATTR)?.getAttribute(HOSTNAMES_DDNS_STATE_ATTR),
    ).toBe('paused');
    panel.dispose();
  });

  it('BLOCKS the toggle (self-disconnect guard) when connected via the handle', async () => {
    const runDdnsSetEnabled = vi.fn<DdnsSetEnabledCaller>(async () => ({ enabled: false }));
    const { host, panel } = mountPanel({
      runDdnsStatus: vi.fn(async () => ({ enabled: true })),
      runDdnsSetEnabled,
      runDdnsControlContext: vi.fn(async () => ddnsContext({ blockToggle: true })),
    });
    await panel.whenLoaded();
    expect(findByAttr(host, HOSTNAMES_DDNS_SECTION_ATTR)).not.toBeNull();
    expect(findByAttr(host, HOSTNAMES_DDNS_TOGGLE_ATTR)).toBeNull();
    expect(textOf(findByAttr(host, HOSTNAMES_DDNS_BLOCKED_ATTR)!)).toContain('Server URL');
    expect(runDdnsSetEnabled).not.toHaveBeenCalled();
    panel.dispose();
  });

  it('Pause click calls runDdnsSetEnabled({enabled:false}) + flips to Resume', async () => {
    const runDdnsSetEnabled = vi.fn<DdnsSetEnabledCaller>(async () => ({ enabled: false }));
    const { host, panel } = mountPanel({
      runDdnsStatus: vi.fn(async () => ({ enabled: true })),
      runDdnsSetEnabled,
      runDdnsControlContext: vi.fn(async () => ddnsContext()),
    });
    await panel.whenLoaded();
    findByAttr(host, HOSTNAMES_DDNS_TOGGLE_ATTR)!.click();
    await flushMicrotasks();
    expect(runDdnsSetEnabled).toHaveBeenCalledWith({ enabled: false });
    expect(findByAttr(host, HOSTNAMES_DDNS_TOGGLE_ATTR)?.textContent).toBe('Start the address again');
    panel.dispose();
  });

  it('surfaces a toggle failure inline without flipping the displayed state', async () => {
    const runDdnsSetEnabled = vi.fn<DdnsSetEnabledCaller>(async () => {
      throw new Error('cloud pause failed: ddns_pause_subscription_lapsed');
    });
    const { host, panel } = mountPanel({
      runDdnsStatus: vi.fn(async () => ({ enabled: true })),
      runDdnsSetEnabled,
      runDdnsControlContext: vi.fn(async () => ddnsContext()),
    });
    await panel.whenLoaded();
    findByAttr(host, HOSTNAMES_DDNS_TOGGLE_ATTR)!.click();
    await flushMicrotasks();
    expect(findByAttr(host, HOSTNAMES_DDNS_ERROR_ATTR)).not.toBeNull();
    expect(findByAttr(host, HOSTNAMES_DDNS_TOGGLE_ATTR)?.textContent).toBe('Pause the address');
    panel.dispose();
  });
});

describe('D-152 P6 hostnames panel route mount', () => {
  it('mounts under the Server section and bundles its styles when all callers are supplied', async () => {
    const doc = makeFakeDocument();
    const host = makeFakeElement('div');
    const route = bootstrapSettingsRoute({
      root: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      localStore: createInMemoryWebclientLocalStore(),
      ...requiredHostnameCallers(),
    });

    expect(route.hostnamesPanel()).not.toBeNull();
    expect(findByAttr(host, SETTINGS_ROUTE_SECTION_ATTR, 'server')).not.toBeNull();
    expect(doc.styleTags[0]?.textContent).toContain(HOSTNAMES_PANEL_STYLES.trim());
    await route.hostnamesPanel()!.whenLoaded();
    route.dispose();
  });

  it('threads the Reachability prober into the Hostnames verify path', async () => {
    const doc = makeFakeDocument();
    const host = makeFakeElement('div');
    const reachabilityExternalProbeCaller = vi.fn<ReachabilityExternalProbeCaller>(
      async () =>
        diagnosticResponse('token.example', {
          observed_token_hash: 'sha256:observed',
        }),
    );
    const callers = requiredHostnameCallers();
    const route = bootstrapSettingsRoute({
      root: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      localStore: createInMemoryWebclientLocalStore(),
      ...callers,
      hostnamesListCaller: vi.fn(async () => ({
        hostnames: [
          hostname('token.example', {
            ownership_status: 'pending',
            verification_method: 'dns_txt',
          }),
        ],
      })),
      reachabilityExternalProbeCaller,
    });
    const panel = route.hostnamesPanel();
    expect(panel).not.toBeNull();
    await panel!.whenLoaded();

    panel!.openVerify('token.example');
    await panel!.submitVerify();

    expect(reachabilityExternalProbeCaller).toHaveBeenCalledWith({
      hostname: 'token.example',
      ownership_probe_method: 'dns_txt',
    });
    route.dispose();
  });

  it('omits the Hostnames panel when any hostname caller is missing', () => {
    const omitted: Array<keyof ReturnType<typeof requiredHostnameCallers>> = [
      'hostnamesListCaller',
      'hostnamesGetCaller',
      'hostnamesAddCaller',
      'hostnamesUpdateCaller',
      'hostnamesRemoveCaller',
      'hostnamesVerifyOwnershipCaller',
    ];
    for (const missing of omitted) {
      const doc = makeFakeDocument();
      const host = makeFakeElement('div');
      const callers = requiredHostnameCallers();
      delete callers[missing];
      const route = bootstrapSettingsRoute({
        root: host as unknown as HTMLElement,
        document: doc as unknown as Document,
        localStore: createInMemoryWebclientLocalStore(),
        ...callers,
      });

      expect(route.hostnamesPanel()).toBeNull();
      route.dispose();
    }
  });

  it('forwards networkLocalUrlsCaller into the mounted Hostnames panel', async () => {
    const doc = makeFakeDocument();
    const host = makeFakeElement('div');
    const networkLocalUrlsCaller = vi.fn<NetworkLocalUrlsCaller>(async () => ({
      urls: [{ url: 'http://10.0.0.5:8443', kind: 'lan' }],
    }));
    const route = bootstrapSettingsRoute({
      root: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      localStore: createInMemoryWebclientLocalStore(),
      ...requiredHostnameCallers(),
      networkLocalUrlsCaller,
    });

    const panel = route.hostnamesPanel();
    expect(panel).not.toBeNull();
    await panel!.whenLoaded();

    // ⛔ CALLED, NOT CALLED-ONCE. This asserted `1` from when Hostnames was the
    // only consumer; D-272's `29a1de4f2` gave Connect a device a `readPorts`
    // that reads the same rpc, and Connect a device ALWAYS mounts (it is the
    // first Server tab and needs no caller of its own). The count became a fact
    // about how many panels the route mounts, which is not what this test is
    // about — the forwarding is proved by the rows below.
    expect(networkLocalUrlsCaller).toHaveBeenCalled();
    expect(
      findByAttr(host, HOSTNAMES_LOCAL_URL_ROW_ATTR, 'http://10.0.0.5:8443'),
    ).not.toBeNull();
    expect(findByAttr(host, HOSTNAMES_LOCAL_URL_KIND_ATTR, 'lan')).not.toBeNull();
    route.dispose();
  });

  // R27 delta-B — the route composes the Pro DDNS gate context from
  // pro_convenience.status (published + hostname) + the local store (server_url
  // → self-disconnect), and forwards the toggle callers to the panel.
  const proStatus = (
    ddnsState: ProConvenienceItemState,
  ): ProConvenienceStatusResponse => ({
    entitlement: 'entitled',
    publisher_handle: 'alice',
    ddns_hostname: 'alice.recued.net',
    items: {
      handle: { state: 'active' },
      ddns: { state: ddnsState },
      acme: { state: 'active' },
    },
  });

  const mountDdnsRoute = async (serverUrl: string, ddnsState: ProConvenienceItemState) => {
    const doc = makeFakeDocument();
    const host = makeFakeElement('div');
    const localStore = createInMemoryWebclientLocalStore();
    await localStore.set('server_url', serverUrl);
    const ddnsStatusCaller = vi.fn<DdnsStatusCaller>(async () => ({ enabled: true }));
    const ddnsSetEnabledCaller = vi.fn<DdnsSetEnabledCaller>(async () => ({ enabled: false }));
    const accountProConvenienceStatusCaller = vi.fn(async () => proStatus(ddnsState));
    const route = bootstrapSettingsRoute({
      root: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      localStore,
      ...requiredHostnameCallers(),
      ddnsStatusCaller,
      ddnsSetEnabledCaller,
      accountProConvenienceStatusCaller,
    });
    await route.hostnamesPanel()!.whenLoaded();
    return { host, route, ddnsStatusCaller, accountProConvenienceStatusCaller };
  };

  it('forwards the Pro DDNS toggle (published + LAN-connected → actionable)', async () => {
    const { host, route, ddnsStatusCaller, accountProConvenienceStatusCaller } =
      await mountDdnsRoute('wss://192.168.1.9:8443/ws', 'active');
    expect(ddnsStatusCaller).toHaveBeenCalledTimes(1);
    expect(accountProConvenienceStatusCaller).toHaveBeenCalled();
    expect(findByAttr(host, HOSTNAMES_DDNS_TOGGLE_ATTR)?.textContent).toBe('Pause the address');
    expect(findByAttr(host, HOSTNAMES_DDNS_BLOCKED_ATTR)).toBeNull();
    route.dispose();
  });

  it('BLOCKS the Pro DDNS toggle when connected via the handle', async () => {
    const { host, route } = await mountDdnsRoute('wss://alice.recued.net:8443/ws', 'active');
    expect(findByAttr(host, HOSTNAMES_DDNS_SECTION_ATTR)).not.toBeNull();
    expect(findByAttr(host, HOSTNAMES_DDNS_TOGGLE_ATTR)).toBeNull();
    expect(findByAttr(host, HOSTNAMES_DDNS_BLOCKED_ATTR)).not.toBeNull();
    route.dispose();
  });

  it('omits the Pro DDNS section when DDNS is not yet published (the no-row gate)', async () => {
    const { host, route } = await mountDdnsRoute('wss://192.168.1.9:8443/ws', 'pending');
    expect(findByAttr(host, HOSTNAMES_DDNS_SECTION_ATTR)).toBeNull();
    route.dispose();
  });
});
