import { describe, expect, it, vi } from 'vitest';

import { RpcError } from '@recued/contracts';
import type {
  DiagnosticResponse,
  HostnameAddressUsesResponse,
  HostnameCertSource,
  HostnameOwnershipStatus,
  HostnameProjection,
  HostnameTlsTopology,
  HostnameVerificationMethod,
  ProConvenienceItemState,
  ProConvenienceStatusResponse,
} from '@recued/contracts';

import {
  HOSTNAMES_ADDRESSES_ATTR,
  HOSTNAMES_ADDRESS_CANCEL_BTN_ATTR,
  HOSTNAMES_ADDRESS_CONFIRM_ATTR,
  HOSTNAMES_ADDRESS_CONFIRM_BTN_ATTR,
  HOSTNAMES_ADDRESS_ERROR_ATTR,
  HOSTNAMES_ADDRESS_LINKS_ATTR,
  HOSTNAMES_ADDRESS_SELECT_ATTR,
  HOSTNAMES_ADDRESS_STATUS_ATTR,
  HOSTNAMES_KEPT_WARNING_ATTR,
  HOSTNAMES_UPDATE_FORM_ATTR,
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
  type HostnamesAddressUsesCaller,
  type HostnamesGetCaller,
  type HostnamesListCaller,
  type HostnamesPanelMount,
  type HostnamesRemoveCaller,
  type HostnamesSetAddressUseCaller,
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
  click(trusted?: boolean): void;
  focus(): void;
  dispatch(name: string, event?: Record<string, unknown>): void;
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
    click(trusted = false) {
      for (const fn of el.listeners.get('click') ?? []) fn({ target: el, isTrusted: trusted });
    },
    focus() {},
    dispatch(name, event = {}) {
      const dispatched = Object.assign(event, { target: el });
      for (const fn of el.listeners.get(name) ?? []) fn(dispatched);
    },
  };
  return el;
};

interface FakeDocument {
  activeElement: FakeElement | null;
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
  const doc: FakeDocument = {
    activeElement: null,
    createElement(tag) {
      const node = makeFakeElement(tag);
      node.focus = () => { doc.activeElement = node; };
      return node;
    },
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
  return doc;
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
  document?: FakeDocument;
  confirmDiscard?: (prompt: string) => boolean;
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
  runAddressUses?: HostnamesAddressUsesCaller;
  runSetAddressUse?: HostnamesSetAddressUseCaller;
} = {}) => {
  const doc = opts.document ?? makeFakeDocument();
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
    ...(opts.confirmDiscard !== undefined ? { confirmDiscard: opts.confirmDiscard } : {}),
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
    ...(opts.runAddressUses !== undefined ? { runAddressUses: opts.runAddressUses } : {}),
    ...(opts.runSetAddressUse !== undefined ? { runSetAddressUse: opts.runSetAddressUse } : {}),
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

const pendingResult = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

describe('Hostnames draft and work guards', () => {
  it.each([
    ['hostname', ' ', ''],
    ['verification_token_hash', ' ', ''],
    ['cert_source', 'byo_uploaded', 'byo_external'],
    ['verification_method', 'http_token', 'dns_txt'],
    ['listener_ports', [], [443]],
    ['listener_ports', [443, 8447], [443]],
    ['enabled', false, true],
  ] as const)('tracks and restores the raw Add %s field (%j)', async (field, changed, original) => {
    const { panel } = mountPanel(); await panel.whenLoaded();
    expect(panel.hasUnsavedChanges()).toBe(false); panel.openAdd();
    expect(panel.hasUnsavedChanges()).toBe(false);
    panel.setAddField(field, changed); expect(panel.hasUnsavedChanges()).toBe(true);
    panel.setAddField(field, original); expect(panel.hasUnsavedChanges()).toBe(false);
    expect(panel.hasInFlightWork()).toBe(false); panel.dispose();
  });

  it('compares Edit choices with their seeded values and ignores port order', async () => {
    const row = hostname('seed.example', {
      cert_source: 'byo_uploaded', verification_method: 'http_token', listener_ports: [8447, 443], enabled: false,
    });
    const { panel } = mountPanel({ rows: [row] }); await panel.whenLoaded(); panel.openUpdate(row.hostname);
    expect(panel.hasUnsavedChanges()).toBe(false);
    panel.setUpdateField('listener_ports', [443, 8447]); expect(panel.hasUnsavedChanges()).toBe(false);
    for (const [field, changed, original] of [
      ['verification_token_hash', ' ', ''], ['cert_source', 'byo_external', 'byo_uploaded'],
      ['verification_method', 'dns_txt', 'http_token'], ['listener_ports', [443], [8447, 443]],
      ['enabled', true, false],
    ] as const) {
      panel.openUpdate(row.hostname);
      panel.setUpdateField(field, changed); expect(panel.hasUnsavedChanges()).toBe(true);
      panel.setUpdateField(field, original);
      // Switching certificate source also selects that source's default proof method.
      if (field === 'cert_source') panel.setUpdateField('verification_method', 'http_token');
      expect(panel.hasUnsavedChanges()).toBe(false);
    }
    panel.setUpdateField('verification_token_hash', 'draft'); panel.cancelUpdate();
    expect(panel.hasUnsavedChanges()).toBe(false); panel.openUpdate(row.hostname);
    expect(panel.hasUnsavedChanges()).toBe(false); panel.dispose();
  });

  it('keeps the Edit baseline stable through an inventory refresh, then reseeds on reopen', async () => {
    const row = hostname('seed.example'); let rows = [row];
    const { panel } = mountPanel({ runList: async () => ({ hostnames: rows }) });
    await panel.whenLoaded(); panel.openUpdate(row.hostname); panel.setUpdateField('enabled', false);
    rows = [{ ...row, enabled: false }]; await panel.refresh();
    expect(panel.hasUnsavedChanges()).toBe(true);
    panel.setUpdateField('enabled', true); expect(panel.hasUnsavedChanges()).toBe(false);
    panel.cancelUpdate(); panel.openUpdate(row.hostname); expect(panel.getState().update.values.enabled).toBe(false);
    expect(panel.hasUnsavedChanges()).toBe(false); panel.setUpdateField('enabled', true);
    expect(panel.hasUnsavedChanges()).toBe(true); panel.dispose();
  });

  it('keeps retained hidden proof drafts guarded until cleared or canceled', async () => {
    const { panel } = mountPanel(); await panel.whenLoaded(); panel.openAdd();
    panel.setAddField('verification_token_hash', ' draft '); panel.setAddField('cert_source', 'byo_uploaded');
    panel.setAddField('cert_source', 'byo_external'); expect(panel.hasUnsavedChanges()).toBe(true);
    panel.setAddField('cert_source', 'recued_acme'); panel.setAddField('cert_source', 'byo_external');
    expect(panel.getState().add.values.verification_token_hash).toBe(''); expect(panel.hasUnsavedChanges()).toBe(false);
    panel.setAddField('hostname', 'draft.example'); panel.cancelAdd(); expect(panel.hasUnsavedChanges()).toBe(false);
    panel.dispose();
  });

  it('ignores inventory reads and keeps the draft guard independent of loading', async () => {
    const read = pendingResult<{ hostnames: HostnameProjection[] }>();
    const { panel } = mountPanel({ runList: () => read.promise });
    expect(panel.hasInFlightWork()).toBe(false); expect(panel.hasUnsavedChanges()).toBe(false);
    panel.openAdd(); panel.setAddField('hostname', 'draft.example');
    expect(panel.hasInFlightWork()).toBe(false); expect(panel.hasUnsavedChanges()).toBe(true);
    read.resolve({ hostnames: [] }); await panel.whenLoaded(); expect(panel.hasUnsavedChanges()).toBe(true);
    panel.dispose(); expect(panel.hasUnsavedChanges()).toBe(false); expect(panel.hasInFlightWork()).toBe(false);
  });

  for (const mode of ['add', 'update'] as const) {
    for (const outcome of ['success', 'error'] as const) {
      it(`guards the pending ${mode} write and settles correctly after ${outcome}`, async () => {
        const row = hostname('seed.example'); const write = pendingResult<{ hostname: HostnameProjection }>();
        const { panel, calls } = mountPanel({ rows: [row], runAdd: () => write.promise, runUpdate: () => write.promise });
        await panel.whenLoaded();
        if (mode === 'add') { panel.openAdd(); panel.setAddField('hostname', row.hostname); panel.setAddField('verification_token_hash', 'draft'); }
        else { panel.openUpdate(row.hostname); panel.setUpdateField('verification_token_hash', 'draft'); }
        const task = mode === 'add' ? panel.submitAdd() : panel.submitUpdate();
        expect(panel.hasInFlightWork()).toBe(true); expect(panel.hasUnsavedChanges()).toBe(true);
        if (outcome === 'success') write.resolve({ hostname: row }); else write.reject(new Error('Synthetic write failed'));
        await task; expect(panel.hasInFlightWork()).toBe(false); expect(panel.hasUnsavedChanges()).toBe(outcome === 'error');
        expect(mode === 'add' ? calls.runAdd : calls.runUpdate).toHaveBeenCalledTimes(1);
        panel.dispose(); expect(panel.hasUnsavedChanges()).toBe(false); expect(panel.hasInFlightWork()).toBe(false);
      });
    }
  }

  it('keeps the submitted editor intact while its change is pending', async () => {
    const row = hostname('seed.example'); const write = pendingResult<{ hostname: HostnameProjection }>();
    const { panel } = mountPanel({ rows: [row], runUpdate: () => write.promise }); await panel.whenLoaded();
    panel.openUpdate(row.hostname); panel.setUpdateField('enabled', false); const task = panel.submitUpdate();
    panel.openAdd(); expect(panel.getState().add.open).toBe(false); expect(panel.getState().update.saving).toBe(true);
    expect(panel.hasInFlightWork()).toBe(true);
    write.resolve({ hostname: { ...row, enabled: false } }); await task;
    expect(panel.hasInFlightWork()).toBe(false); expect(panel.hasUnsavedChanges()).toBe(false); panel.dispose();
  });

  it.each(['add', 'update', 'verify'] as const)('audit: locks %s values and editor switches until its write settles', async mode => {
    const row = hostname('seed.example'); const write = pendingResult<{ hostname: HostnameProjection }>();
    const verification = pendingResult<Awaited<ReturnType<HostnamesVerifyOwnershipCaller>>>();
    const { panel, calls } = mountPanel({ rows: [row], runAdd: () => write.promise, runUpdate: () => write.promise, runVerify: () => verification.promise });
    await panel.whenLoaded(); let task: Promise<void>;
    if (mode === 'add') {
      panel.openAdd(); panel.setAddField('hostname', row.hostname); panel.setAddField('verification_token_hash', 'submitted'); task = panel.submitAdd();
    } else if (mode === 'update') {
      panel.openUpdate(row.hostname); panel.setUpdateField('verification_token_hash', 'submitted'); task = panel.submitUpdate();
    } else {
      panel.openVerify(row.hostname); panel.setVerifyField('observed_token_hash', 'submitted'); task = panel.submitVerify();
    }
    const submitted = panel.getState();
    panel.setAddField('verification_token_hash', 'newer');
    panel.setUpdateField('verification_token_hash', 'newer');
    panel.setVerifyField('observed_token_hash', 'newer');
    // Only the active editor must be immutable; inactive forms are not drafts.
    expect(mode === 'add' ? panel.getState().add : mode === 'update' ? panel.getState().update : panel.getState().verify)
      .toBe(mode === 'add' ? submitted.add : mode === 'update' ? submitted.update : submitted.verify);
    panel.cancelAdd(); panel.cancelUpdate(); panel.cancelVerify();
    panel.openAdd(); panel.openUpdate(row.hostname); panel.openRemove(row.hostname); panel.openVerify(row.hostname); await panel.openDetail(row.hostname);
    expect(mode === 'add' ? panel.getState().add : mode === 'update' ? panel.getState().update : panel.getState().verify)
      .toBe(mode === 'add' ? submitted.add : mode === 'update' ? submitted.update : submitted.verify);
    expect(calls.runGet).not.toHaveBeenCalled(); expect(panel.hasInFlightWork()).toBe(true);
    if (mode === 'verify') verification.resolve({ ok: true, hostname: row.hostname, method: 'dns_txt', status: 'verified', projection: row });
    else write.resolve({ hostname: row });
    await task; expect(panel.hasInFlightWork()).toBe(false); panel.dispose();
  });

  for (const outcome of ['success', 'error'] as const) {
    it(`audit: guards the complete verification flow through a probe ${outcome}`, async () => {
      const row = hostname('seed.example'); const probe = pendingResult<DiagnosticResponse>();
      const write = pendingResult<Awaited<ReturnType<HostnamesVerifyOwnershipCaller>>>();
      const { panel, calls } = mountPanel({ rows: [row], runExternalProbe: () => probe.promise, runVerify: () => write.promise });
      await panel.whenLoaded(); panel.openVerify(row.hostname); const task = panel.submitVerify();
      expect(panel.hasInFlightWork()).toBe(true); expect(panel.hasUnsavedChanges()).toBe(false);
      expect(calls.runVerify).not.toHaveBeenCalled();
      if (outcome === 'success') {
        probe.resolve(diagnosticResponse(row.hostname, { observed_token_hash: 'observed' })); await flushMicrotasks();
        expect(calls.runVerify).toHaveBeenCalledWith({ hostname: row.hostname, method: 'dns_txt', observed_token_hash: 'observed' });
        expect(panel.hasInFlightWork()).toBe(true);
        write.resolve({ ok: true, hostname: row.hostname, method: 'dns_txt', status: 'verified', projection: row });
      } else probe.reject(new Error('Synthetic probe unavailable'));
      await task; expect(panel.hasInFlightWork()).toBe(false); panel.dispose();
    });

    it(`audit: ignores a probe ${outcome} after disposal without sending ownership writes`, async () => {
      const row = hostname('seed.example'); const probe = pendingResult<DiagnosticResponse>();
      const { panel, calls } = mountPanel({ rows: [row], runExternalProbe: () => probe.promise });
      await panel.whenLoaded(); panel.openVerify(row.hostname); const task = panel.submitVerify(); panel.dispose();
      const snapshot = panel.getState(); expect(panel.hasInFlightWork()).toBe(false);
      if (outcome === 'success') probe.resolve(diagnosticResponse(row.hostname, { observed_token_hash: 'observed' }));
      else probe.reject(new Error('Late synthetic probe error'));
      await task; expect(calls.runVerify).not.toHaveBeenCalled(); expect(panel.getState()).toBe(snapshot);
    });
  }

  it.each(['success', 'error'] as const)('distinguishes proof drafts from other hostname mutations through %s', async outcome => {
    const row = hostname('seed.example');
    const remove = pendingResult<Awaited<ReturnType<HostnamesRemoveCaller>>>();
    const removal = mountPanel({ rows: [row], runRemove: () => remove.promise }); await removal.panel.whenLoaded();
    removal.panel.openRemove(row.hostname); const removing = removal.panel.confirmRemove();
    expect(removal.panel.hasInFlightWork()).toBe(true); expect(removal.panel.hasUnsavedChanges()).toBe(false);
    if (outcome === 'success') remove.resolve({ removed: true }); else remove.reject(new Error('Synthetic removal failed'));
    await removing; expect(removal.panel.hasInFlightWork()).toBe(false); removal.panel.dispose();

    const verify = pendingResult<Awaited<ReturnType<HostnamesVerifyOwnershipCaller>>>();
    const verification = mountPanel({ rows: [row], runVerify: () => verify.promise }); await verification.panel.whenLoaded();
    verification.panel.openVerify(row.hostname); verification.panel.setVerifyField('observed_token_hash', 'draft');
    const verifying = verification.panel.submitVerify();
    expect(verification.panel.hasInFlightWork()).toBe(true); expect(verification.panel.hasUnsavedChanges()).toBe(true);
    if (outcome === 'success') verify.resolve({ ok: true, hostname: row.hostname, method: 'dns_txt', status: 'verified', projection: row });
    else verify.reject(new Error('Synthetic verification failed'));
    await verifying; expect(verification.panel.hasInFlightWork()).toBe(false);
    expect(verification.panel.hasUnsavedChanges()).toBe(outcome === 'error'); verification.panel.dispose();

    const ddns = pendingResult<Awaited<ReturnType<DdnsSetEnabledCaller>>>();
    const toggle = mountPanel({ runDdnsStatus: async () => ({ enabled: true }), runDdnsSetEnabled: () => ddns.promise,
      runDdnsControlContext: async () => ({ published: true, ddnsHostname: 'alice.recued.net', blockToggle: false }) });
    await toggle.panel.whenLoaded(); findByAttr(toggle.host, HOSTNAMES_DDNS_TOGGLE_ATTR)!.click();
    expect(toggle.panel.hasInFlightWork()).toBe(true); expect(toggle.panel.hasUnsavedChanges()).toBe(false);
    if (outcome === 'success') ddns.resolve({ enabled: false }); else ddns.reject(new Error('Synthetic DDNS change failed'));
    await flushMicrotasks(); expect(toggle.panel.hasInFlightWork()).toBe(false); toggle.panel.dispose();

    const address = pendingResult<HostnameAddressUsesResponse>();
    const addresses = mountPanel({ runAddressUses: async () => addressUses(), runSetAddressUse: () => address.promise });
    await addresses.panel.whenLoaded(); const setting = addresses.panel.setAddressUse('reception', 'shop.example.com');
    expect(addresses.panel.hasInFlightWork()).toBe(true); expect(addresses.panel.hasUnsavedChanges()).toBe(false);
    if (outcome === 'success') address.resolve(addressUses()); else address.reject(new Error('Synthetic address change failed'));
    await setting; expect(addresses.panel.hasInFlightWork()).toBe(false); addresses.panel.dispose();
  });

  it.each(['success', 'error'] as const)('retires both guards on disposal before a late %s', async outcome => {
    const row = hostname('seed.example'); const write = pendingResult<{ hostname: HostnameProjection }>();
    const { panel, host } = mountPanel({ rows: [row], runUpdate: () => write.promise }); await panel.whenLoaded();
    panel.openUpdate(row.hostname); panel.setUpdateField('enabled', false); const task = panel.submitUpdate(); panel.dispose();
    expect(panel.hasInFlightWork()).toBe(false); expect(panel.hasUnsavedChanges()).toBe(false);
    const snapshot = panel.getState();
    if (outcome === 'success') write.resolve({ hostname: { ...row, enabled: false } }); else write.reject(new Error('Late synthetic write'));
    await task; expect(panel.getState()).toBe(snapshot); expect(host.children).toEqual([]);
  });
});

describe('Manual hostname verification drafts', () => {
  it('keeps its seeded method stable during an inventory refresh and reseeds on reopen', async () => {
    const row = hostname('seed.example', { verification_method: 'http_token' }); let rows = [row];
    const { panel } = mountPanel({ runList: async () => ({ hostnames: rows }) });
    await panel.whenLoaded(); panel.openVerify(row.hostname); expect(panel.hasUnsavedChanges()).toBe(false);
    panel.setVerifyField('observed_token_hash', ' draft '); expect(panel.hasUnsavedChanges()).toBe(true);
    rows = [{ ...row, verification_method: 'dns_txt' }]; await panel.refresh();
    expect(panel.getState().verify.method).toBe('http_token'); expect(panel.hasUnsavedChanges()).toBe(true);
    panel.setVerifyField('observed_token_hash', ''); expect(panel.hasUnsavedChanges()).toBe(false);
    panel.cancelVerify(); panel.openVerify(row.hostname);
    expect(panel.getState().verify.method).toBe('dns_txt'); expect(panel.hasUnsavedChanges()).toBe(false); panel.dispose();
  });

  it.each(['byo_external', 'byo_uploaded', 'recued_acme'] as const)('seeds the post-Add proof without a false warning for %s', async source => {
    const { panel } = mountPanel(); await panel.whenLoaded(); panel.openAdd();
    panel.setAddField('hostname', 'new.example'); panel.setAddField('cert_source', source);
    if (source !== 'recued_acme') panel.setAddField('verification_token_hash', '  submitted-proof  ');
    await panel.submitAdd(); expect(panel.hasUnsavedChanges()).toBe(false);
    if (source !== 'recued_acme') {
      expect(panel.getState().verify.observed_token_hash).toBe('  submitted-proof  ');
      panel.setVerifyField('observed_token_hash', 'new draft'); expect(panel.hasUnsavedChanges()).toBe(true);
      panel.setVerifyField('observed_token_hash', '  submitted-proof  '); expect(panel.hasUnsavedChanges()).toBe(false);
    } else expect(panel.getState().verify.hostname).toBeNull();
    panel.dispose();
  });

  it.each(['success', 'unverified', 'rejected', 'error'] as const)('protects submitted values until verification %s and acknowledges only verified proofs', async outcome => {
    const row = hostname('seed.example'); const write = pendingResult<Awaited<ReturnType<HostnamesVerifyOwnershipCaller>>>();
    const { panel, calls } = mountPanel({ rows: [row], runVerify: () => write.promise }); await panel.whenLoaded();
    panel.openVerify(row.hostname); panel.setVerifyField('method', 'http_token'); panel.setVerifyField('observed_token_hash', '  submitted-proof  ');
    const task = panel.submitVerify(); expect(panel.hasUnsavedChanges()).toBe(true); expect(panel.hasInFlightWork()).toBe(true);
    if (outcome === 'error') write.reject(new Error('Synthetic write unavailable'));
    else if (outcome === 'rejected') write.resolve({ ok: false, hostname: row.hostname, method: 'http_token', code: 'method_mismatch', expected_method: 'dns_txt' });
    else write.resolve({ ok: true, hostname: row.hostname, method: 'http_token', status: outcome === 'success' ? 'verified' : 'failed',
      projection: { ...row, verification_method: 'http_token', ownership_status: outcome === 'success' ? 'verified' : 'failed' } });
    await task; expect(panel.hasInFlightWork()).toBe(false); expect(panel.hasUnsavedChanges()).toBe(outcome !== 'success');
    expect(calls.runVerify).toHaveBeenCalledExactlyOnceWith({ hostname: row.hostname, method: 'http_token', observed_token_hash: 'submitted-proof' });
    expect(panel.getState().verify.observed_token_hash).toBe('  submitted-proof  ');
    if (outcome === 'success') {
      panel.setVerifyField('observed_token_hash', 'new draft'); expect(panel.hasUnsavedChanges()).toBe(true);
      panel.setVerifyField('observed_token_hash', '  submitted-proof  '); expect(panel.hasUnsavedChanges()).toBe(false);
    } else {
      panel.setVerifyField('observed_token_hash', ''); panel.setVerifyField('method', 'dns_txt'); expect(panel.hasUnsavedChanges()).toBe(false);
    }
    panel.dispose();
  });

  it('protects an unverified automatic observation and acknowledges a successful retry', async () => {
    const row = hostname('seed.example'); let attempts = 0;
    const { panel, calls } = mountPanel({ rows: [row],
      runExternalProbe: async () => diagnosticResponse(row.hostname, { observed_token_hash: 'automatic-observation' }),
      runVerify: async () => ({ ok: true, hostname: row.hostname, method: 'dns_txt', status: ++attempts === 1 ? 'failed' : 'verified', projection: row }),
    });
    await panel.whenLoaded(); panel.openVerify(row.hostname); expect(panel.hasUnsavedChanges()).toBe(false);
    await panel.submitVerify(); expect(panel.hasUnsavedChanges()).toBe(true); expect(panel.hasInFlightWork()).toBe(false);
    expect(panel.getState().verify.observed_token_hash).toBe('automatic-observation');
    await panel.submitVerify(); expect(panel.hasUnsavedChanges()).toBe(false);
    expect(calls.runExternalProbe).toHaveBeenCalledTimes(1); expect(calls.runVerify).toHaveBeenCalledTimes(2);
    panel.setVerifyField('observed_token_hash', ''); expect(panel.hasUnsavedChanges()).toBe(true);
    panel.setVerifyField('observed_token_hash', 'automatic-observation'); expect(panel.hasUnsavedChanges()).toBe(false); panel.dispose();
  });

  it.each(['unverified', 'rejected', 'error'] as const)('retains the last acknowledged certificate proof after a retry is %s', async outcome => {
    const row = hostname('certificate.example', { cert_source: 'byo_uploaded', verification_method: 'cert_proof' });
    const retry = pendingResult<Awaited<ReturnType<HostnamesVerifyOwnershipCaller>>>();
    let attempts = 0;
    const { panel, calls } = mountPanel({ rows: [row], runVerify: async () => ++attempts === 1
      ? { ok: true, hostname: row.hostname, method: 'cert_proof', status: 'verified', projection: { ...row, ownership_status: 'verified' } }
      : retry.promise,
    });
    await panel.whenLoaded(); panel.openVerify(row.hostname);
    panel.setVerifyField('cert_matches_hostname', true); expect(panel.hasUnsavedChanges()).toBe(true);
    await panel.submitVerify(); expect(panel.hasUnsavedChanges()).toBe(false);
    panel.setVerifyField('cert_matches_hostname', false); expect(panel.hasUnsavedChanges()).toBe(true);
    const task = panel.submitVerify(); expect(panel.hasInFlightWork()).toBe(true);
    panel.setVerifyField('cert_matches_hostname', true); expect(panel.getState().verify.cert_matches_hostname).toBe(false);
    if (outcome === 'error') retry.reject(new Error('Synthetic certificate retry unavailable'));
    else if (outcome === 'rejected') retry.resolve({ ok: false, hostname: row.hostname, method: 'cert_proof', code: 'not_found' });
    else retry.resolve({ ok: true, hostname: row.hostname, method: 'cert_proof', status: 'failed', projection: { ...row, ownership_status: 'failed' } });
    await task; expect(panel.hasInFlightWork()).toBe(false); expect(panel.hasUnsavedChanges()).toBe(true);
    expect(calls.runVerify.mock.calls).toEqual([
      [{ hostname: row.hostname, method: 'cert_proof', cert_matches_hostname: true }],
      [{ hostname: row.hostname, method: 'cert_proof', cert_matches_hostname: false }],
    ]);
    panel.setVerifyField('cert_matches_hostname', true); expect(panel.hasUnsavedChanges()).toBe(false);
    panel.cancelVerify(); panel.openVerify(row.hostname); expect(panel.getState().verify.cert_matches_hostname).toBe(false);
    expect(panel.hasUnsavedChanges()).toBe(false); panel.dispose();
  });

  it('retires a canceled or disposed draft and starts another editor clean', async () => {
    const row = hostname('seed.example'); const { panel, calls } = mountPanel({ rows: [row] }); await panel.whenLoaded();
    panel.openVerify(row.hostname); panel.setVerifyField('observed_token_hash', 'draft'); expect(panel.hasUnsavedChanges()).toBe(true);
    panel.cancelVerify(); expect(panel.hasUnsavedChanges()).toBe(false); panel.openVerify(row.hostname);
    expect(panel.getState().verify.observed_token_hash).toBe(''); expect(panel.hasUnsavedChanges()).toBe(false);
    panel.setVerifyField('observed_token_hash', 'draft'); panel.openAdd(); expect(panel.hasUnsavedChanges()).toBe(false);
    panel.openVerify(row.hostname); expect(panel.hasUnsavedChanges()).toBe(false);
    panel.setVerifyField('observed_token_hash', 'draft'); panel.dispose();
    expect(panel.hasUnsavedChanges()).toBe(false); expect(calls.runVerify).not.toHaveBeenCalled();
  });

  it('reuses the Settings guard for a manual verification draft and its successful acknowledgement', async () => {
    const doc = makeFakeDocument(); const host = makeFakeElement('div'); const row = hostname('seed.example');
    const route = bootstrapSettingsRoute({ root: host as unknown as HTMLElement, document: doc as unknown as Document,
      localStore: createInMemoryWebclientLocalStore(), ...requiredHostnameCallers(), hostnamesListCaller: async () => ({ hostnames: [row] }),
    });
    const panel = route.hostnamesPanel()!; await panel.whenLoaded(); panel.openVerify(row.hostname);
    expect(route.hasUnsavedChanges()).toBe(false); expect(route.unsavedChangesPrompt()).toBeNull();
    panel.setVerifyField('observed_token_hash', 'draft'); expect(route.hasUnsavedChanges()).toBe(true);
    expect(route.unsavedChangesPrompt()).toBe('Discard the unsaved hostname changes?');
    await panel.submitVerify(); expect(route.hasUnsavedChanges()).toBe(false); expect(route.unsavedChangesPrompt()).toBeNull(); route.dispose();
  });
});

describe('Hostnames editor transitions', () => {
  type Editor = 'add' | 'update' | 'verify';
  type Target = Editor | 'detail' | 'remove';
  const sources = ['add', 'update', 'verify'] as const;
  const targets = ['add', 'update', 'verify', 'detail', 'remove'] as const;
  const prompt = 'Discard the unsaved hostname changes?';
  const raw = '  unsaved proof  ';
  const open = async (panel: HostnamesPanelMount, target: Target, name: string) => {
    if (target === 'add') panel.openAdd();
    else if (target === 'update') panel.openUpdate(name);
    else if (target === 'verify') panel.openVerify(name);
    else if (target === 'detail') await panel.openDetail(name);
    else panel.openRemove(name);
  };
  const draft = (panel: HostnamesPanelMount, source: Editor, value = raw) => {
    if (source === 'add') panel.setAddField('verification_token_hash', value);
    else if (source === 'update') panel.setUpdateField('verification_token_hash', value);
    else panel.setVerifyField('observed_token_hash', value);
  };
  const assertOpen = (panel: HostnamesPanelMount, target: Target, name: string) => {
    if (target === 'add') expect(panel.getState().add.open).toBe(true);
    else expect(panel.getState()[target].hostname).toBe(name);
  };

  for (const source of sources) {
    for (const target of targets.filter(target => target !== source)) {
      for (const accept of [false, true]) {
        it(`${accept ? 'accepts' : 'declines'} ${source} to ${target} without silently dropping a draft`, async () => {
          const row = hostname('seed.example'); const confirmDiscard = vi.fn(() => accept);
          const { panel, host, calls } = mountPanel({ rows: [row], confirmDiscard }); await panel.whenLoaded();
          await open(panel, source, row.hostname); draft(panel, source);
          const snapshot = panel.getState(); const element = findByAttr(host, `data-recued-hostnames-${source}-form`);
          expect(panel.hasUnsavedChanges()).toBe(true); await open(panel, target, row.hostname);
          expect(confirmDiscard).toHaveBeenCalledExactlyOnceWith(prompt);
          if (!accept) {
            expect(panel.getState()).toBe(snapshot);
            expect(findByAttr(host, `data-recued-hostnames-${source}-form`)).toBe(element);
            expect(panel.hasUnsavedChanges()).toBe(true); expect(calls.runGet).not.toHaveBeenCalled();
          } else {
            assertOpen(panel, target, row.hostname); expect(panel.hasUnsavedChanges()).toBe(false);
            expect(calls.runGet).toHaveBeenCalledTimes(target === 'detail' ? 1 : 0);
            await open(panel, source, row.hostname); expect(panel.hasUnsavedChanges()).toBe(false);
            const values = panel.getState();
            expect(source === 'verify' ? values.verify.observed_token_hash : values[source].values.verification_token_hash).toBe('');
          }
          for (const caller of [calls.runAdd, calls.runUpdate, calls.runRemove, calls.runVerify, calls.runExternalProbe]) expect(caller).not.toHaveBeenCalled();
          panel.dispose();
        });
      }
    }

    it(`keeps repeated ${source} opens intact without asking to discard`, async () => {
      const row = hostname('seed.example'); const confirmDiscard = vi.fn(() => false);
      const { panel, host } = mountPanel({ rows: [row], confirmDiscard }); await panel.whenLoaded();
      await open(panel, source, row.hostname); draft(panel, source);
      const snapshot = panel.getState(); const element = findByAttr(host, `data-recued-hostnames-${source}-form`);
      await open(panel, source, row.hostname); await open(panel, source, row.hostname);
      expect(panel.getState()).toBe(snapshot); expect(findByAttr(host, `data-recued-hostnames-${source}-form`)).toBe(element);
      expect(panel.hasUnsavedChanges()).toBe(true); expect(confirmDiscard).not.toHaveBeenCalled(); panel.dispose();
    });

    it(`switches clean and restored ${source} forms without a discard question`, async () => {
      const row = hostname('seed.example'); const confirmDiscard = vi.fn(() => false);
      const { panel } = mountPanel({ rows: [row], confirmDiscard }); await panel.whenLoaded();
      await open(panel, source, row.hostname); draft(panel, source); draft(panel, source, '');
      expect(panel.hasUnsavedChanges()).toBe(false);
      const target = source === 'add' ? 'update' : 'add'; await open(panel, target, row.hostname);
      assertOpen(panel, target, row.hostname); expect(confirmDiscard).not.toHaveBeenCalled(); panel.dispose();
    });
  }

  for (const source of ['update', 'verify'] as const) for (const accept of [false, true]) {
    it(`${accept ? 'accepts' : 'declines'} a different hostname in the ${source} editor`, async () => {
      const first = hostname('first.example'); const second = hostname('second.example'); const confirmDiscard = vi.fn(() => accept);
      const { panel } = mountPanel({ rows: [first, second], confirmDiscard }); await panel.whenLoaded();
      await open(panel, source, first.hostname); draft(panel, source); const snapshot = panel.getState();
      await open(panel, source, second.hostname); expect(confirmDiscard).toHaveBeenCalledExactlyOnceWith(prompt);
      if (accept) { assertOpen(panel, source, second.hostname); expect(panel.hasUnsavedChanges()).toBe(false); }
      else { expect(panel.getState()).toBe(snapshot); expect(panel.hasUnsavedChanges()).toBe(true); }
      panel.dispose();
    });
  }

  for (const target of ['update', 'verify', 'detail', 'remove'] as const) {
    it(`does not discard or ask for an unknown ${target} target`, async () => {
      const confirmDiscard = vi.fn(() => true); const { panel, calls } = mountPanel({ confirmDiscard }); await panel.whenLoaded();
      panel.openAdd(); draft(panel, 'add'); const snapshot = panel.getState(); await open(panel, target, 'unknown.example');
      expect(panel.getState()).toBe(snapshot); expect(panel.hasUnsavedChanges()).toBe(true);
      expect(confirmDiscard).not.toHaveBeenCalled(); expect(calls.runGet).not.toHaveBeenCalled(); panel.dispose();
    });
  }

  for (const source of [...sources, 'probe'] as const) {
    it(`keeps all editor switches locked through pending ${source} work without prompting`, async () => {
      const row = hostname('seed.example'); const gate = pendingResult<void>(); const confirmDiscard = vi.fn(() => true);
      const { panel } = mountPanel({ rows: [row], confirmDiscard,
        runAdd: async () => { await gate.promise; return { hostname: row }; },
        runUpdate: async () => { await gate.promise; return { hostname: row }; },
        runVerify: async input => { await gate.promise; return { ok: true, hostname: row.hostname, method: input.method, status: 'verified', projection: row }; },
        ...(source === 'probe' ? { runExternalProbe: async () => { await gate.promise; return diagnosticResponse(row.hostname, { observed_token_hash: 'automatic-proof' }); } } : {}),
      });
      await panel.whenLoaded(); const editor = source === 'probe' ? 'verify' : source; await open(panel, editor, row.hostname);
      if (source !== 'probe') draft(panel, editor);
      if (source === 'add') panel.setAddField('hostname', 'new.example');
      const task = source === 'add' ? panel.submitAdd() : source === 'update' ? panel.submitUpdate() : panel.submitVerify();
      const snapshot = panel.getState(); expect(panel.hasInFlightWork()).toBe(true);
      for (const target of targets) await open(panel, target, row.hostname);
      expect(panel.getState()).toBe(snapshot); expect(confirmDiscard).not.toHaveBeenCalled();
      gate.resolve(); await task; expect(panel.hasInFlightWork()).toBe(false); panel.dispose();
    });
  }

  it('keeps hidden proof values and a changed certificate checkbox on a declined switch', async () => {
    const row = hostname('certificate.example', { cert_source: 'byo_uploaded', verification_method: 'cert_proof' });
    const confirmDiscard = vi.fn(() => false); const { panel } = mountPanel({ rows: [row], confirmDiscard }); await panel.whenLoaded();
    panel.openVerify(row.hostname); panel.setVerifyField('method', 'dns_txt'); draft(panel, 'verify');
    panel.setVerifyField('method', 'cert_proof'); panel.setVerifyField('cert_matches_hostname', true);
    const snapshot = panel.getState(); panel.openUpdate(row.hostname);
    expect(panel.getState()).toBe(snapshot); expect(panel.hasUnsavedChanges()).toBe(true);
    expect(confirmDiscard).toHaveBeenCalledExactlyOnceWith(prompt); panel.dispose();
  });

  for (const target of ['add', 'update', 'verify', 'remove'] as const) {
    it.each(['success', 'error'] as const)(`retires a late Details %s after switching to ${target}`, async outcome => {
      const row = hostname('seed.example'); const read = pendingResult<{ hostname: HostnameProjection | null }>();
      const confirmDiscard = vi.fn(() => true); const { panel, host } = mountPanel({ rows: [row], confirmDiscard, runGet: () => read.promise });
      await panel.whenLoaded(); panel.openAdd(); draft(panel, 'add'); const task = panel.openDetail(row.hostname);
      expect(confirmDiscard).toHaveBeenCalledExactlyOnceWith(prompt); await open(panel, target, row.hostname);
      if (target !== 'remove') draft(panel, target);
      const attr = target === 'remove' ? HOSTNAMES_REMOVE_CONFIRM_PANEL_ATTR : `data-recued-hostnames-${target}-form`;
      const snapshot = panel.getState(); const element = findByAttr(host, attr); expect(element).not.toBeNull();
      if (outcome === 'success') read.resolve({ hostname: null }); else read.reject(new Error('Late synthetic detail unavailable'));
      await task; expect(panel.getState()).toBe(snapshot); expect(findByAttr(host, attr)).toBe(element);
      expect(panel.hasUnsavedChanges()).toBe(target !== 'remove'); expect(panel.getState().detail.hostname).toBeNull();
      expect(confirmDiscard).toHaveBeenCalledTimes(1); panel.dispose();
    });
  }

  it('keeps an accepted confirmation from reopening a disposed panel', async () => {
    const row = hostname('seed.example'); let dispose = () => {};
    const confirmDiscard = vi.fn(() => { dispose(); return true; });
    const { panel, host, calls } = mountPanel({ rows: [row], confirmDiscard }); dispose = () => panel.dispose();
    await panel.whenLoaded(); panel.openAdd(); draft(panel, 'add'); const snapshot = panel.getState();
    await panel.openDetail(row.hostname);
    expect(confirmDiscard).toHaveBeenCalledExactlyOnceWith(prompt); expect(panel.getState()).toBe(snapshot);
    expect(host.children).toEqual([]); expect(panel.hasUnsavedChanges()).toBe(false); expect(calls.runGet).not.toHaveBeenCalled();
  });

  it('keeps an accepted confirmation from replacing an editor that started saving', async () => {
    const row = hostname('seed.example'); const write = pendingResult<{ hostname: HostnameProjection }>();
    let startSave = () => {}; let task: Promise<void> | undefined;
    const confirmDiscard = vi.fn(() => { startSave(); return true; });
    const { panel, calls } = mountPanel({ rows: [row], confirmDiscard, runAdd: () => write.promise });
    await panel.whenLoaded(); panel.openAdd(); panel.setAddField('hostname', row.hostname); draft(panel, 'add');
    startSave = () => { task = panel.submitAdd(); };
    await panel.openDetail(row.hostname);
    expect(confirmDiscard).toHaveBeenCalledExactlyOnceWith(prompt); expect(calls.runGet).not.toHaveBeenCalled();
    expect(calls.runAdd).toHaveBeenCalledExactlyOnceWith({ hostname: row.hostname, cert_source: 'byo_external',
      verification_method: 'dns_txt', verification_token_hash: raw.trim(), listener_ports: [443], enabled: true });
    expect(panel.getState().add.saving).toBe(true); expect(panel.getState().detail.hostname).toBeNull(); expect(panel.hasInFlightWork()).toBe(true);
    write.resolve({ hostname: row }); await task; expect(panel.hasInFlightWork()).toBe(false); expect(panel.hasUnsavedChanges()).toBe(false); panel.dispose();
  });
});

describe('Hostnames background status', () => {
  const raw = '  unsaved proof  ';
  for (const mode of ['add', 'update', 'verify'] as const) {
    for (const kind of ['local_urls', 'ddns', 'addresses'] as const) {
      for (const outcome of ['success', 'error'] as const) {
        it(`keeps the ${mode} controls and draft when ${kind} settles with ${outcome}`, async () => {
          const gate = pendingResult<void>(); const row = hostname('seed.example');
          const { panel, host, calls } = mountPanel({ rows: [row],
            ...(kind === 'local_urls' ? { runLocalUrls: async () => { await gate.promise; return { urls: [{ url: 'http://192.168.1.5:8443', kind: 'lan' as const }] }; } } : {}),
            ...(kind === 'ddns' ? { runDdnsStatus: async () => { await gate.promise; return { enabled: false }; },
              runDdnsControlContext: async () => ({ published: true, blockToggle: true, ddnsHostname: 'alice.recued.net' }) } : {}),
            ...(kind === 'addresses' ? { runAddressUses: async () => { await gate.promise; return addressUses({ uses: [
              { use: 'reception', source: 'owner', hostname: row.hostname, base_url: `https://${row.hostname}` },
            ] }); } } : {}),
          });
          await vi.waitFor(() => expect(panel.getState().loading).toBe(false));
          if (mode === 'add') panel.openAdd(); else if (mode === 'update') panel.openUpdate(row.hostname); else panel.openVerify(row.hostname);
          const form = findByAttr(host, `data-recued-hostnames-${mode}-form`)!;
          const fieldAttr = `data-recued-hostnames-${mode}-field`;
          const input = findByAttr(form, fieldAttr, mode === 'verify' ? 'observed_token_hash' : 'verification_token_hash')!;
          input.value = raw; input.dispatch('input');
          expect(panel.hasUnsavedChanges()).toBe(true);
          if (outcome === 'success') gate.resolve(); else gate.reject(new Error('Synthetic optional read unavailable'));
          await panel.whenLoaded();
          expect(findByAttr(host, `data-recued-hostnames-${mode}-form`)).toBe(form);
          expect(findByAttr(form, fieldAttr, mode === 'verify' ? 'observed_token_hash' : 'verification_token_hash')).toBe(input);
          expect(input.value).toBe(raw); expect(panel.hasUnsavedChanges()).toBe(true); expect(panel.hasInFlightWork()).toBe(false);
          if (kind === 'local_urls') expect(findByAttr(host, HOSTNAMES_LOCAL_URLS_ATTR) !== null).toBe(outcome === 'success');
          if (kind === 'ddns') expect(findByAttr(host, HOSTNAMES_DDNS_STATE_ATTR, 'paused') !== null).toBe(outcome === 'success');
          if (kind === 'addresses') {
            expect(findByAttr(host, HOSTNAMES_ADDRESSES_ATTR)).not.toBeNull();
            expect(findByAttr(host, HOSTNAMES_ADDRESS_ERROR_ATTR) !== null).toBe(outcome === 'error');
            if (mode === 'update') expect(findByAttr(form, HOSTNAMES_KEPT_WARNING_ATTR) !== null).toBe(outcome === 'success');
          }
          input.value = ''; input.dispatch('input'); expect(panel.hasUnsavedChanges()).toBe(false);
          expect(calls.runAdd).not.toHaveBeenCalled(); expect(calls.runUpdate).not.toHaveBeenCalled(); expect(calls.runVerify).not.toHaveBeenCalled();
          panel.dispose();
        });
      }
    }
  }

  it.each(['add', 'update', 'verify'] as const)('keeps pending %s fields locked, then renders its write error normally', async (mode) => {
    const read = pendingResult<HostnameAddressUsesResponse>(); const write = pendingResult<void>(); const row = hostname('seed.example');
    const { panel, host } = mountPanel({ rows: [row], runAddressUses: () => read.promise,
      runAdd: async () => { await write.promise; return { hostname: row }; },
      runUpdate: async () => { await write.promise; return { hostname: row }; },
      runVerify: async () => { await write.promise; return { ok: true, hostname: row.hostname, method: 'dns_txt', status: 'verified', projection: row }; },
    });
    await vi.waitFor(() => expect(panel.getState().loading).toBe(false));
    if (mode === 'add') { panel.openAdd(); panel.setAddField('hostname', 'new.example'); panel.setAddField('verification_token_hash', raw); }
    else if (mode === 'update') { panel.openUpdate(row.hostname); panel.setUpdateField('verification_token_hash', raw); }
    else { panel.openVerify(row.hostname); panel.setVerifyField('observed_token_hash', raw); }
    const submit = mode === 'add' ? panel.submitAdd() : mode === 'update' ? panel.submitUpdate() : panel.submitVerify();
    const formAttr = `data-recued-hostnames-${mode}-form`; const fieldAttr = `data-recued-hostnames-${mode}-field`;
    const name = mode === 'verify' ? 'observed_token_hash' : 'verification_token_hash';
    const form = findByAttr(host, formAttr)!; const input = findByAttr(form, fieldAttr, name)!;
    expect(input.disabled).toBe(true); expect(panel.hasInFlightWork()).toBe(true);
    read.resolve(addressUses()); await panel.whenLoaded();
    expect(findByAttr(host, formAttr)).toBe(form); expect(input.disabled).toBe(true); expect(panel.hasInFlightWork()).toBe(true);
    input.value = 'stale event'; input.dispatch('input');
    write.reject(new Error('Synthetic write unavailable')); await submit;
    const retry = findByAttr(host, formAttr)!; expect(retry).not.toBe(form);
    expect(findByAttr(retry, fieldAttr, name)?.value).toBe(raw); expect(findByAttr(retry, fieldAttr, name)?.disabled).toBe(false);
    expect(textOf(retry)).toContain('Synthetic write unavailable'); expect(panel.hasUnsavedChanges()).toBe(true); expect(panel.hasInFlightWork()).toBe(false);
    panel.dispose();
  });

  it('updates the kept-address warning in an open Remove confirmation', async () => {
    const read = pendingResult<HostnameAddressUsesResponse>(); const row = hostname('seed.example');
    const { panel, host } = mountPanel({ rows: [row], runAddressUses: () => read.promise });
    await vi.waitFor(() => expect(panel.getState().loading).toBe(false)); panel.openRemove(row.hostname);
    const confirm = findByAttr(host, HOSTNAMES_REMOVE_CONFIRM_PANEL_ATTR)!;
    read.resolve(addressUses({ uses: [{ use: 'reception', source: 'first_use', hostname: row.hostname, base_url: `https://${row.hostname}` }] }));
    await panel.whenLoaded(); expect(findByAttr(host, HOSTNAMES_REMOVE_CONFIRM_PANEL_ATTR)).toBe(confirm);
    expect(textOf(findByAttr(confirm, HOSTNAMES_KEPT_WARNING_ATTR)!)).toContain('Removing it stops it'); panel.dispose();
  });

  for (const kind of ['local_urls', 'ddns', 'addresses'] as const) {
    for (const outcome of ['success', 'error'] as const) {
      for (const retiredBy of ['refresh', 'dispose'] as const) {
        it(`ignores a late ${kind} ${outcome} after ${retiredBy}`, async () => {
          const gate = pendingResult<void>(); const row = hostname('seed.example'); let reads = 0;
          const read = async () => { const older = reads++ === 0; if (older) await gate.promise; return older; };
          const { panel, host } = mountPanel({ rows: [row],
            ...(kind === 'local_urls' ? { runLocalUrls: async () => ({ urls: [{ url: await read() ? 'http://192.168.1.2' : 'http://192.168.1.3', kind: 'lan' as const }] }) } : {}),
            ...(kind === 'ddns' ? { runDdnsStatus: async () => ({ enabled: await read() }),
              runDdnsControlContext: async () => ({ published: true, blockToggle: true, ddnsHostname: 'alice.recued.net' }) } : {}),
            ...(kind === 'addresses' ? { runAddressUses: async () => addressUses({ uses: await read() ? [
              { use: 'reception', source: 'owner', hostname: row.hostname, base_url: `https://${row.hostname}` },
            ] : [] }) } : {}),
          });
          const olderLoad = panel.whenLoaded(); await vi.waitFor(() => expect(panel.getState().loading).toBe(false));
          if (retiredBy === 'refresh') await panel.refresh(); else panel.dispose();
          if (retiredBy === 'refresh') panel.openUpdate(row.hostname);
          const form = findByAttr(host, HOSTNAMES_UPDATE_FORM_ATTR);
          const before = panel.getState(); const sectionAttr = kind === 'local_urls' ? HOSTNAMES_LOCAL_URLS_ATTR : kind === 'ddns' ? HOSTNAMES_DDNS_SECTION_ATTR : HOSTNAMES_ADDRESSES_ATTR;
          const section = findByAttr(host, sectionAttr);
          if (outcome === 'success') gate.resolve(); else gate.reject(new Error('Retired status unavailable'));
          await olderLoad;
          expect(panel.getState()).toEqual(before); expect(findByAttr(host, sectionAttr)).toBe(section);
          expect(findByAttr(host, HOSTNAMES_UPDATE_FORM_ATTR)).toBe(form);
          if (retiredBy === 'refresh') {
            expect(section).not.toBeNull(); expect(findByAttr(form!, HOSTNAMES_KEPT_WARNING_ATTR)).toBeNull();
          } else expect(host.children).toHaveLength(0);
          panel.dispose();
        });
      }
    }
  }

  it('refreshes only the current warning host after changing the edited row', async () => {
    const read = pendingResult<HostnameAddressUsesResponse>(); const first = hostname('first.example'); const second = hostname('second.example');
    const { panel, host } = mountPanel({ rows: [first, second], runAddressUses: () => read.promise });
    await vi.waitFor(() => expect(panel.getState().loading).toBe(false)); panel.openUpdate(first.hostname);
    const retired = findByAttr(host, HOSTNAMES_UPDATE_FORM_ATTR)!; panel.openUpdate(second.hostname);
    const current = findByAttr(host, HOSTNAMES_UPDATE_FORM_ATTR)!;
    read.resolve(addressUses({ uses: [{ use: 'reception', source: 'owner', hostname: second.hostname, base_url: `https://${second.hostname}` }] }));
    await panel.whenLoaded(); expect(findByAttr(host, HOSTNAMES_UPDATE_FORM_ATTR)).toBe(current);
    expect(findByAttr(retired, HOSTNAMES_KEPT_WARNING_ATTR)).toBeNull();
    expect(textOf(findByAttr(current, HOSTNAMES_KEPT_WARNING_ATTR)!)).toContain('second.example'); panel.dispose();
  });
});

describe('Hostnames editor feedback', () => {
  const raw = '  corrected proof  ';
  const errors = (form: FakeElement) => findAllByAttr(form, HOSTNAMES_PANEL_ERROR_ATTR)
    .filter(node => !node.hasAttribute(HOSTNAMES_KEPT_WARNING_ATTR));
  const open = (panel: HostnamesPanelMount, mode: 'add' | 'update' | 'verify', name: string) => {
    if (mode === 'add') panel.openAdd(); else if (mode === 'update') panel.openUpdate(name); else panel.openVerify(name);
  };
  const submit = (panel: HostnamesPanelMount, mode: 'add' | 'update' | 'verify') => mode === 'add'
    ? panel.submitAdd() : mode === 'update' ? panel.submitUpdate() : panel.submitVerify();

  it.each([
    ['add', 'hostname'], ['add', 'verification_token_hash'], ['update', 'verification_token_hash'], ['verify', 'observed_token_hash'],
  ] as const)('clears %s validation feedback from native %s input without replacing the form', async (mode, name) => {
    const row = hostname('seed.example');
    const { panel, host, calls } = mountPanel({ rows: [row], runAddressUses: async () => addressUses({ uses: [
      { use: 'reception', source: 'owner', hostname: row.hostname, base_url: `https://${row.hostname}` },
    ] }) });
    await panel.whenLoaded(); open(panel, mode, row.hostname);
    if (mode === 'add' && name === 'verification_token_hash') panel.setAddField('hostname', 'new.example');
    await submit(panel, mode); const form = findByAttr(host, `data-recued-hostnames-${mode}-form`)!;
    expect(errors(form)).toHaveLength(1);
    const input = findByAttr(form, `data-recued-hostnames-${mode}-field`, name)!;
    input.value = name === 'hostname' ? 'new.example' : raw; input.dispatch('input');
    expect(findByAttr(host, `data-recued-hostnames-${mode}-form`)).toBe(form);
    expect(findByAttr(form, `data-recued-hostnames-${mode}-field`, name)).toBe(input);
    expect(errors(form)).toHaveLength(0); expect(panel.getState()[mode].error).toBeNull(); expect(panel.hasUnsavedChanges()).toBe(true);
    if (mode === 'update') expect(findByAttr(form, HOSTNAMES_KEPT_WARNING_ATTR)).not.toBeNull();
    expect(calls.runAdd).not.toHaveBeenCalled(); expect(calls.runUpdate).not.toHaveBeenCalled(); expect(calls.runVerify).not.toHaveBeenCalled(); panel.dispose();
  });

  it.each(['add', 'update'] as const)('clears the %s error and state on a native Enabled change', async mode => {
    const row = hostname('seed.example'); const { panel, host } = mountPanel({ rows: [row] }); await panel.whenLoaded(); open(panel, mode, row.hostname);
    await submit(panel, mode); const form = findByAttr(host, `data-recued-hostnames-${mode}-form`)!;
    const checkbox = findByAttr(form, `data-recued-hostnames-${mode}-field`, 'enabled')!;
    expect(errors(form)).toHaveLength(1); checkbox.checked = false; checkbox.dispatch('change');
    expect(findByAttr(host, `data-recued-hostnames-${mode}-form`)).toBe(form); expect(errors(form)).toHaveLength(0);
    expect(panel.getState()[mode].error).toBeNull(); expect(panel.hasUnsavedChanges()).toBe(true); panel.dispose();
  });

  for (const certificate of [false, true]) {
    for (const outcome of ['success', 'unverified', 'rejected', 'error'] as const) {
      it(`clears ${certificate ? 'certificate' : 'text'} verification ${outcome} feedback on native input`, async () => {
        const row = hostname('seed.example', certificate ? { cert_source: 'byo_uploaded', verification_method: 'cert_proof' } : {});
        const method = certificate ? 'cert_proof' as const : 'dns_txt' as const;
        const { panel, host, calls } = mountPanel({ rows: [row], runVerify: async () => {
          if (outcome === 'error') throw new Error('Synthetic verification unavailable');
          if (outcome === 'rejected') return { ok: false, hostname: row.hostname, method, code: 'not_found' };
          return { ok: true, hostname: row.hostname, method, status: outcome === 'success' ? 'verified' : 'failed',
            projection: { ...row, ownership_status: outcome === 'success' ? 'verified' : 'failed' } };
        } });
        await panel.whenLoaded(); panel.openVerify(row.hostname);
        if (certificate) panel.setVerifyField('cert_matches_hostname', true); else panel.setVerifyField('observed_token_hash', raw);
        await panel.submitVerify(); const form = findByAttr(host, 'data-recued-hostnames-verify-form')!;
        expect(errors(form).length + findAllByAttr(form, 'data-recued-hostnames-status').length).toBe(1);
        const input = findByAttr(form, 'data-recued-hostnames-verify-field', certificate ? 'cert_matches_hostname' : 'observed_token_hash')!;
        if (certificate) { input.checked = false; input.dispatch('change'); } else { input.value = 'different proof'; input.dispatch('input'); }
        expect(findByAttr(host, 'data-recued-hostnames-verify-form')).toBe(form); expect(errors(form)).toHaveLength(0);
        expect(findAllByAttr(form, 'data-recued-hostnames-status')).toHaveLength(0);
        expect(panel.getState().verify.error).toBeNull(); expect(panel.getState().verify.result).toBeNull();
        expect(panel.hasUnsavedChanges()).toBe(certificate ? outcome === 'success' : true);
        expect(calls.runVerify).toHaveBeenCalledTimes(1); panel.dispose();
      });
    }
  }

  it.each(['add', 'update'] as const)('clears a failed %s write on editing while keeping its draft', async mode => {
    const row = hostname('seed.example'); const fail = async () => { throw new Error('Synthetic hostname write unavailable'); };
    const { panel, host, calls } = mountPanel({ rows: [row], runAdd: fail, runUpdate: fail }); await panel.whenLoaded(); open(panel, mode, row.hostname);
    if (mode === 'add') { panel.setAddField('hostname', 'new.example'); panel.setAddField('verification_token_hash', raw); }
    else panel.setUpdateField('verification_token_hash', raw);
    await submit(panel, mode); const form = findByAttr(host, `data-recued-hostnames-${mode}-form`)!; expect(errors(form)).toHaveLength(1);
    const input = findByAttr(form, `data-recued-hostnames-${mode}-field`, 'verification_token_hash')!;
    input.value = 'corrected proof'; input.dispatch('input'); expect(errors(form)).toHaveLength(0);
    expect(findByAttr(host, `data-recued-hostnames-${mode}-form`)).toBe(form); expect(panel.hasUnsavedChanges()).toBe(true); expect(panel.hasInFlightWork()).toBe(false);
    expect(calls.runAdd.mock.calls.length + calls.runUpdate.mock.calls.length).toBe(1); panel.dispose();
  });

  for (const mode of ['add', 'update', 'verify'] as const) {
    for (const checkbox of [false, true]) {
      it(`ignores a retired ${mode} ${checkbox ? 'checkbox' : 'text'} event after a feedback redraw`, async () => {
        const row = hostname('seed.example', mode === 'verify' && checkbox ? { cert_source: 'byo_uploaded', verification_method: 'cert_proof' } : {});
        const { panel, host } = mountPanel({ rows: [row], runVerify: async () => { throw new Error('Synthetic verification unavailable'); } });
        await panel.whenLoaded(); open(panel, mode, row.hostname);
        const name = checkbox ? mode === 'verify' ? 'cert_matches_hostname' : 'enabled'
          : mode === 'verify' ? 'observed_token_hash' : mode === 'add' ? 'hostname' : 'verification_token_hash';
        const retired = findByAttr(host, `data-recued-hostnames-${mode}-field`, name)!;
        await submit(panel, mode); const form = findByAttr(host, `data-recued-hostnames-${mode}-form`)!; expect(errors(form)).toHaveLength(1);
        const before = panel.getState(); retired.value = 'retired value'; retired.checked = !retired.checked; retired.dispatch(checkbox ? 'change' : 'input');
        expect(panel.getState()).toEqual(before); expect(errors(form)).toHaveLength(1); panel.dispose();
      });
    }
  }

  it('keeps automatic probe feedback during a pending verification', async () => {
    const probe = pendingResult<DiagnosticResponse>(); const row = hostname('seed.example');
    const { panel, host } = mountPanel({ rows: [row], runExternalProbe: () => probe.promise }); await panel.whenLoaded(); panel.openVerify(row.hostname);
    const task = panel.submitVerify(); const form = findByAttr(host, 'data-recued-hostnames-verify-form')!;
    const input = findByAttr(form, 'data-recued-hostnames-verify-field', 'observed_token_hash')!; const before = panel.getState();
    input.value = 'blocked'; input.dispatch('input'); expect(panel.getState()).toEqual(before);
    expect(findByAttr(form, 'data-recued-hostnames-verify-auto-probe-status')).not.toBeNull(); expect(panel.hasInFlightWork()).toBe(true);
    probe.reject(new Error('Synthetic probe unavailable')); await task; expect(errors(findByAttr(host, 'data-recued-hostnames-verify-form')!)).toHaveLength(1); panel.dispose();
  });

  it.each(['add', 'update', 'verify'] as const)('ignores a retired %s method change after validation redraws its feedback', async mode => {
    const row = hostname('seed.example'); const { panel, host } = mountPanel({ rows: [row] }); await panel.whenLoaded(); open(panel, mode, row.hostname);
    const retired = findByAttr(host, `data-recued-hostnames-${mode}-field`, 'method')!;
    await submit(panel, mode); const form = findByAttr(host, `data-recued-hostnames-${mode}-form`)!; expect(errors(form)).toHaveLength(1);
    const before = panel.getState(); retired.value = 'http_token'; retired.dispatch('change');
    expect(panel.getState()).toEqual(before); expect(errors(form)).toHaveLength(1); panel.dispose();
  });

  it('keeps all native Add fields active after clearing feedback and changing a choice', async () => {
    const { panel, host } = mountPanel(); await panel.whenLoaded(); panel.openAdd(); await panel.submitAdd();
    const form = findByAttr(host, 'data-recued-hostnames-add-form')!;
    const name = findByAttr(form, 'data-recued-hostnames-add-field', 'hostname')!; name.value = 'new.example'; name.dispatch('input');
    const proof = findByAttr(form, 'data-recued-hostnames-add-field', 'verification_token_hash')!; proof.value = raw; proof.dispatch('input');
    expect(errors(form)).toHaveLength(0); expect(panel.getState().add.values.verification_token_hash).toBe(raw);
    const method = findByAttr(form, 'data-recued-hostnames-add-field', 'method')!; method.value = 'http_token'; method.dispatch('change');
    const current = findByAttr(host, 'data-recued-hostnames-add-form')!; const next = findByAttr(current, 'data-recued-hostnames-add-field', 'verification_token_hash')!;
    expect(current).not.toBe(form); next.value = 'next proof'; next.dispatch('input');
    expect(panel.getState().add.values).toMatchObject({ hostname: 'new.example', verification_method: 'http_token', verification_token_hash: 'next proof' });
    expect(errors(current)).toHaveLength(0); expect(panel.hasUnsavedChanges()).toBe(true); panel.dispose();
  });

  for (const mode of ['add', 'update', 'verify'] as const) {
    it(`keeps a new ${mode} editor's feedback when a canceled editor dispatches input`, async () => {
      const first = hostname('first.example'); const second = hostname('second.example'); const { panel, host } = mountPanel({ rows: [first, second] });
      await panel.whenLoaded(); open(panel, mode, first.hostname); await submit(panel, mode);
      const name = mode === 'add' ? 'hostname' : mode === 'verify' ? 'observed_token_hash' : 'verification_token_hash';
      const retired = findByAttr(host, `data-recued-hostnames-${mode}-field`, name)!;
      if (mode === 'add') panel.cancelAdd(); else if (mode === 'update') panel.cancelUpdate(); else panel.cancelVerify();
      open(panel, mode, second.hostname); await submit(panel, mode);
      const current = findByAttr(host, `data-recued-hostnames-${mode}-form`)!; const before = panel.getState();
      retired.value = 'retired proof'; retired.dispatch('input');
      expect(panel.getState()).toEqual(before); expect(errors(current)).toHaveLength(1); panel.dispose();
    });

    it(`leaves disposed ${mode} feedback and state retired`, async () => {
      const row = hostname('seed.example'); const { panel, host } = mountPanel({ rows: [row] }); await panel.whenLoaded(); open(panel, mode, row.hostname); await submit(panel, mode);
      const input = findByAttr(host, `data-recued-hostnames-${mode}-field`, mode === 'add' ? 'hostname' : mode === 'verify' ? 'observed_token_hash' : 'verification_token_hash')!;
      panel.dispose(); const before = panel.getState(); input.value = 'disposed proof'; input.dispatch('input');
      expect(panel.getState()).toEqual(before); expect(host.children).toHaveLength(0);
    });
  }

  it.each(['verified', 'failed'] as const)('refreshes certificate feedback ownership across both automatic verification stages until %s', async status => {
    const row = hostname('certificate.example', { cert_source: 'byo_uploaded', verification_method: 'cert_proof' });
    const probe = pendingResult<DiagnosticResponse>(); const write = pendingResult<Awaited<ReturnType<HostnamesVerifyOwnershipCaller>>>();
    const { panel, host, calls } = mountPanel({ rows: [row], runExternalProbe: () => probe.promise, runVerify: () => write.promise });
    await panel.whenLoaded(); panel.openVerify(row.hostname); const task = panel.submitVerify();
    const retired = findByAttr(host, 'data-recued-hostnames-verify-field', 'cert_matches_hostname')!;
    probe.resolve(diagnosticResponse(row.hostname, { results: [{ kind: 'tls_handshake', status: 'pass', payload: {
      kind: 'tls_handshake', cert_valid: true, cert_matches_hostname: true, cert_expires_at: null, cert_issuer: null,
    } }] }));
    await vi.waitFor(() => expect(calls.runVerify).toHaveBeenCalledTimes(1));
    const pending = panel.getState(); retired.checked = false; retired.dispatch('change'); expect(panel.getState()).toEqual(pending);
    expect(calls.runVerify).toHaveBeenCalledExactlyOnceWith({ hostname: row.hostname, method: 'cert_proof', cert_matches_hostname: true });
    write.resolve({ ok: true, hostname: row.hostname, method: 'cert_proof', status, projection: { ...row, ownership_status: status } }); await task;
    const form = findByAttr(host, 'data-recued-hostnames-verify-form')!;
    const current = findByAttr(form, 'data-recued-hostnames-verify-field', 'cert_matches_hostname')!; expect(current.checked).toBe(true);
    expect(findByAttr(form, 'data-recued-hostnames-status')).not.toBeNull(); current.checked = false; current.dispatch('change');
    expect(findByAttr(form, 'data-recued-hostnames-status')).toBeNull(); expect(panel.getState().verify.result).toBeNull();
    expect(panel.hasUnsavedChanges()).toBe(status === 'verified'); expect(panel.hasInFlightWork()).toBe(false); panel.dispose();
  });
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

const addressUses = (
  over: Partial<HostnameAddressUsesResponse> = {},
): HostnameAddressUsesResponse => ({
  uses: [
    { use: 'webhooks', source: 'first_use', base_url: 'https://alice.recued.net', hostname: 'alice.recued.net' },
    { use: 'reception', source: 'automatic', base_url: 'https://alice.recued.net' },
    { use: 'customer_access', source: 'owner', base_url: 'https://shop.example.com', hostname: 'shop.example.com' },
  ],
  choices: [
    { hostname: 'shop.example.com', base_url: 'https://shop.example.com' },
    { hostname: 'alice.recued.net', base_url: 'https://alice.recued.net' },
  ],
  links_now: { app: 'https://alice.recued.net', answers: 'https://alice.recued.net' },
  registered_webhooks: 0,
  ...over,
});

describe('Hostnames — addresses you hand out', () => {
  const statusText = (host: FakeElement, use: string): string =>
    textOf(findByAttr(host, HOSTNAMES_ADDRESS_STATUS_ATTR, use)!);

  it('shows who decided each address, and says links in notices are not kept', async () => {
    const { host, panel } = mountPanel({
      runAddressUses: async () => addressUses(),
      runSetAddressUse: async () => addressUses(),
    });
    await panel.whenLoaded();

    expect(findByAttr(host, HOSTNAMES_ADDRESSES_ATTR)).not.toBeNull();
    expect(findByAttr(host, HOSTNAMES_ADDRESS_SELECT_ATTR, 'webhooks')!.value).toBe('alice.recued.net');
    expect(findByAttr(host, HOSTNAMES_ADDRESS_SELECT_ATTR, 'reception')!.value).toBe('');
    expect(findByAttr(host, HOSTNAMES_ADDRESS_SELECT_ATTR, 'customer_access')!.value).toBe('shop.example.com');
    expect(statusText(host, 'webhooks')).toContain('Kept since it was first handed out');
    expect(statusText(host, 'reception'))
      .toContain('It will use https://alice.recued.net and then keep it');
    expect(statusText(host, 'customer_access')).toContain('You picked it');
    expect(textOf(findByAttr(host, HOSTNAMES_ADDRESS_LINKS_ATTR)!))
      .toContain('Right now that is https://alice.recued.net.');
    panel.dispose();
  });

  it('lets RECUED_PUBLIC_BASE_URL win: the select is read-only and says why', async () => {
    const { host, panel } = mountPanel({
      runAddressUses: async () => addressUses({
        uses: [
          { use: 'webhooks', source: 'configured', base_url: 'https://mary.example.org' },
          { use: 'reception', source: 'configured', base_url: 'https://mary.example.org' },
          { use: 'customer_access', source: 'configured', base_url: 'https://mary.example.org' },
        ],
      }),
      runSetAddressUse: async () => addressUses(),
    });
    await panel.whenLoaded();
    expect(findByAttr(host, HOSTNAMES_ADDRESS_SELECT_ATTR, 'webhooks')!.disabled).toBe(true);
    expect(statusText(host, 'webhooks')).toContain('Set on the server by RECUED_PUBLIC_BASE_URL');
    panel.dispose();
  });

  it('keeps a picked name through setAddressUse and shows the answer', async () => {
    const picked = addressUses({
      uses: [
        { use: 'webhooks', source: 'first_use', base_url: 'https://alice.recued.net', hostname: 'alice.recued.net' },
        { use: 'reception', source: 'owner', base_url: 'https://shop.example.com', hostname: 'shop.example.com' },
        { use: 'customer_access', source: 'owner', base_url: 'https://shop.example.com', hostname: 'shop.example.com' },
      ],
    });
    const runSetAddressUse = vi.fn<HostnamesSetAddressUseCaller>(async () => picked);
    const { host, panel } = mountPanel({ runAddressUses: async () => addressUses(), runSetAddressUse });
    await panel.whenLoaded();

    const select = findByAttr(host, HOSTNAMES_ADDRESS_SELECT_ATTR, 'reception')!;
    select.value = 'shop.example.com';
    select.dispatch('change');
    await vi.waitFor(() => expect(statusText(host, 'reception')).toContain('You picked it'));
    expect(runSetAddressUse).toHaveBeenCalledWith({ use: 'reception', hostname: 'shop.example.com' });
    expect(findByAttr(host, HOSTNAMES_ADDRESS_SELECT_ATTR, 'reception')!.value).toBe('shop.example.com');
    panel.dispose();
  });

  it('asks before moving the webhooks address while webhooks are registered', async () => {
    const runSetAddressUse = vi.fn<HostnamesSetAddressUseCaller>(async () => addressUses());
    const { host, panel } = mountPanel({
      runAddressUses: async () => addressUses({ registered_webhooks: 3 }),
      runSetAddressUse,
    });
    await panel.whenLoaded();

    await panel.setAddressUse('webhooks', 'shop.example.com');
    const confirm = findByAttr(host, HOSTNAMES_ADDRESS_CONFIRM_ATTR, 'webhooks')!;
    expect(textOf(confirm)).toContain(
      'Move the webhooks address to https://shop.example.com? 3 webhooks were set up with '
      + 'https://alice.recued.net. After the move, each one stops taking events',
    );
    expect(runSetAddressUse).not.toHaveBeenCalled();

    findByAttr(host, HOSTNAMES_ADDRESS_CANCEL_BTN_ATTR)!.click();
    expect(findByAttr(host, HOSTNAMES_ADDRESS_CONFIRM_ATTR)).toBeNull();
    expect(runSetAddressUse).not.toHaveBeenCalled();

    await panel.setAddressUse('webhooks', 'shop.example.com');
    findByAttr(host, HOSTNAMES_ADDRESS_CONFIRM_BTN_ATTR)!.click();
    await vi.waitFor(() => expect(runSetAddressUse).toHaveBeenCalledWith({
      use: 'webhooks', hostname: 'shop.example.com',
    }));

    // A pick that hands out the same address costs nothing and does not ask.
    runSetAddressUse.mockClear();
    await panel.setAddressUse('webhooks', 'alice.recued.net');
    expect(findByAttr(host, HOSTNAMES_ADDRESS_CONFIRM_ATTR)).toBeNull();
    expect(runSetAddressUse).toHaveBeenCalledWith({ use: 'webhooks', hostname: 'alice.recued.net' });
    panel.dispose();
  });

  it('shows a kept name that stopped working, and does not offer it again', async () => {
    const { host, panel } = mountPanel({
      runAddressUses: async () => addressUses({
        uses: [
          { use: 'webhooks', source: 'owner', base_url: null, hostname: 'gone.example.com', hostname_unusable: true },
          { use: 'reception', source: 'automatic', base_url: 'https://alice.recued.net' },
          { use: 'customer_access', source: 'automatic', base_url: null },
        ],
      }),
      runSetAddressUse: async () => addressUses(),
    });
    await panel.whenLoaded();

    const select = findByAttr(host, HOSTNAMES_ADDRESS_SELECT_ATTR, 'webhooks')!;
    expect(select.value).toBe('gone.example.com');
    const gone = select.children.find((option) => option.value === 'gone.example.com')!;
    expect(gone.disabled).toBe(true);
    expect(textOf(gone)).toContain('no longer works');
    expect(statusText(host, 'webhooks')).toContain('gone.example.com can no longer be used');
    expect(findByAttr(host, HOSTNAMES_ADDRESS_STATUS_ATTR, 'webhooks')!.className)
      .toBe('hostnames-address-problem');
    expect(statusText(host, 'customer_access')).toContain('No address yet');
    panel.dispose();
  });

  it('warns on remove and on edit when the name is kept for a use', async () => {
    const { host, panel } = mountPanel({
      rows: [
        hostname('alice.recued.net', { cert_source: 'recued_acme', ownership_status: 'verified' }),
        hostname('other.example.com', { ownership_status: 'verified' }),
      ],
      runAddressUses: async () => addressUses({
        uses: [
          { use: 'webhooks', source: 'first_use', base_url: 'https://alice.recued.net', hostname: 'alice.recued.net' },
          { use: 'reception', source: 'owner', base_url: 'https://alice.recued.net', hostname: 'alice.recued.net' },
          // Automatic and not yet handed out: nothing is kept on the name.
          { use: 'customer_access', source: 'automatic', base_url: 'https://alice.recued.net' },
        ],
      }),
      runSetAddressUse: async () => addressUses(),
    });
    await panel.whenLoaded();

    panel.openRemove('alice.recued.net');
    const onRemove = findByAttr(host, HOSTNAMES_KEPT_WARNING_ATTR, 'alice.recued.net')!;
    expect(textOf(onRemove)).toContain(
      'alice.recued.net is the address kept for webhooks and Reception links. Removing it stops them',
    );
    panel.cancelRemove();

    panel.openRemove('other.example.com');
    expect(findByAttr(host, HOSTNAMES_KEPT_WARNING_ATTR)).toBeNull();
    panel.cancelRemove();

    panel.openUpdate('alice.recued.net');
    const form = findByAttr(host, HOSTNAMES_UPDATE_FORM_ATTR, 'alice.recued.net')!;
    expect(textOf(findByAttr(form, HOSTNAMES_KEPT_WARNING_ATTR)!)).toContain('Switching it off stops them');
    panel.dispose();
  });

  it('leaves the section out on a server without the call, and shows any other failure', async () => {
    const older = mountPanel({
      runAddressUses: async () => {
        throw new RpcError('unknown_method', 'Unknown rpc method: collection.hostname.addressUses', 404);
      },
    });
    await older.panel.whenLoaded();
    expect(findByAttr(older.host, HOSTNAMES_ADDRESSES_ATTR)).toBeNull();
    older.panel.dispose();

    const failing = mountPanel({
      runAddressUses: async () => {
        throw new RpcError('internal_error', 'the store is busy', 500);
      },
    });
    await failing.panel.whenLoaded();
    expect(textOf(findByAttr(failing.host, HOSTNAMES_ADDRESS_ERROR_ATTR)!)).toContain('the store is busy');
    failing.panel.dispose();
  });

  it('reads the addresses again after a name is removed', async () => {
    const runAddressUses = vi.fn<HostnamesAddressUsesCaller>(async () => addressUses());
    const { panel } = mountPanel({
      rows: [hostname('stale.example')],
      runAddressUses,
      runSetAddressUse: async () => addressUses(),
    });
    await panel.whenLoaded();
    expect(runAddressUses).toHaveBeenCalledTimes(1);
    panel.openRemove('stale.example');
    await panel.confirmRemove();
    await vi.waitFor(() => expect(runAddressUses).toHaveBeenCalledTimes(2));
    panel.dispose();
  });
});

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
    // ⛔ It sent the owner to "Server URL", which Settings does not have.
    expect(textOf(findByAttr(host, HOSTNAMES_DDNS_BLOCKED_ATTR)!))
      .toContain('with Change address, under Settings, then Servers.');
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
  it.each(['add', 'update'] as const)('aggregates hostname %s drafts and pending writes into the Settings guard', async mode => {
    const doc = makeFakeDocument(); const host = makeFakeElement('div'); const row = hostname('seed.example');
    const write = pendingResult<{ hostname: HostnameProjection }>();
    const route = bootstrapSettingsRoute({
      root: host as unknown as HTMLElement, document: doc as unknown as Document,
      localStore: createInMemoryWebclientLocalStore(), ...requiredHostnameCallers(),
      hostnamesListCaller: async () => ({ hostnames: [row] }),
      hostnamesAddCaller: () => write.promise, hostnamesUpdateCaller: () => write.promise,
    });
    const panel = route.hostnamesPanel()!; await panel.whenLoaded();
    if (mode === 'add') panel.openAdd(); else panel.openUpdate(row.hostname);
    expect(route.hasUnsavedChanges()).toBe(false); expect(route.hasInFlightWork()).toBe(false);
    expect(route.unsavedChangesPrompt()).toBeNull(); expect(route.inFlightWorkPrompt()).toBeNull();
    if (mode === 'add') { panel.setAddField('hostname', row.hostname); panel.setAddField('verification_token_hash', 'draft'); }
    else panel.setUpdateField('verification_token_hash', 'draft');
    expect(route.hasUnsavedChanges()).toBe(true); expect(route.unsavedChangesPrompt()).toBe('Discard the unsaved hostname changes?');
    const task = mode === 'add' ? panel.submitAdd() : panel.submitUpdate();
    expect(route.hasInFlightWork()).toBe(true); expect(route.inFlightWorkPrompt()).toBe('A hostname change is still in progress. Leave Settings anyway?');
    write.resolve({ hostname: row }); await task;
    expect(route.hasInFlightWork()).toBe(false); expect(route.hasUnsavedChanges()).toBe(false);
    expect(route.unsavedChangesPrompt()).toBeNull(); expect(route.inFlightWorkPrompt()).toBeNull();
    route.dispose(); expect(route.hasUnsavedChanges()).toBe(false); expect(route.hasInFlightWork()).toBe(false);
  });

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

  it('forwards the address-use callers into the mounted Hostnames panel', async () => {
    const doc = makeFakeDocument();
    const host = makeFakeElement('div');
    const hostnamesAddressUsesCaller = vi.fn<HostnamesAddressUsesCaller>(async () => addressUses());
    const hostnamesSetAddressUseCaller = vi.fn<HostnamesSetAddressUseCaller>(async () => addressUses());
    const route = bootstrapSettingsRoute({
      root: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      localStore: createInMemoryWebclientLocalStore(),
      ...requiredHostnameCallers(),
      hostnamesAddressUsesCaller,
      hostnamesSetAddressUseCaller,
    });
    const panel = route.hostnamesPanel()!;
    await panel.whenLoaded();
    expect(findByAttr(host, HOSTNAMES_ADDRESSES_ATTR)).not.toBeNull();
    await panel.setAddressUse('reception', 'shop.example.com');
    expect(hostnamesSetAddressUseCaller).toHaveBeenCalledWith({
      use: 'reception', hostname: 'shop.example.com',
    });
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

describe('Hostnames validation focus', () => {
  const row = hostname('seed.example');
  const rawName = '  new.example  ';
  const rawProof = '  synthetic-proof  ';
  const cases = [
    { mode: 'add', target: 'hostname', message: 'You need to give a name.' },
    { mode: 'add', target: 'verification_token_hash', message: 'Proof code is required for HTTP token and DNS TXT proofs.' },
    { mode: 'add', target: 'listener_port_443', message: 'Pick at least one port.' },
    { mode: 'update', target: 'verification_token_hash', message: 'Proof code is required when changing to HTTP token or DNS TXT proof.' },
    { mode: 'update', target: 'listener_port_443', message: 'Pick at least one port.' },
  ] as const;
  const prepare = (panel: HostnamesPanelMount, mode: 'add' | 'update', target: string): void => {
    if (mode === 'add') {
      panel.openAdd();
      panel.setAddField('hostname', target === 'hostname' ? '  ' : rawName);
      panel.setAddField('verification_token_hash', target === 'verification_token_hash' ? '  ' : rawProof);
      if (target === 'listener_port_443') panel.setAddField('listener_ports', []);
    } else {
      panel.openUpdate(row.hostname);
      panel.setUpdateField('verification_method', 'http_token');
      panel.setUpdateField('verification_token_hash', target === 'verification_token_hash' ? '  ' : rawProof);
      if (target === 'listener_port_443') panel.setUpdateField('listener_ports', []);
    }
  };
  for (const { mode, target, message } of cases) {
    it(`focuses ${mode} ${target} after an owned native submission and keeps raw drafts`, async () => {
      const { doc, host, panel, calls } = mountPanel({ rows: [row], runAddressUses: async () => addressUses({ uses: [
        { use: 'reception', source: 'owner', hostname: row.hostname, base_url: `https://${row.hostname}` },
      ] }) });
      await panel.whenLoaded(); prepare(panel, mode, target);
      const before = panel.getState()[mode].values;
      findByAttr(host, `data-recued-hostnames-${mode}-submit`)!.click(true);
      expect(panel.getState()[mode].error).toBe(message);
      const current = findByAttr(host, `data-recued-hostnames-${mode}-form`)!;
      const input = findByAttr(current, `data-recued-hostnames-${mode}-field`, target)!;
      expect(doc.activeElement).toBe(input); expect(panel.getState()[mode].values).toEqual(before);
      if (mode === 'update') expect(findByAttr(current, HOSTNAMES_KEPT_WARNING_ATTR)).not.toBeNull();
      if (target === 'listener_port_443') { input.checked = true; input.dispatch('change'); }
      else { input.value = target === 'hostname' ? rawName : rawProof; input.dispatch('input'); }
      expect(panel.getState()[mode].error).toBeNull(); expect(panel.hasUnsavedChanges()).toBe(true);
      expect(calls.runAdd).not.toHaveBeenCalled(); expect(calls.runUpdate).not.toHaveBeenCalled(); panel.dispose();
    });
  }
  for (const mode of ['add', 'update'] as const) {
    for (const submission of ['public', 'scripted'] as const) {
      it(`does not take unrelated focus for a ${submission} ${mode} validation`, async () => {
        const { doc, host, panel, calls } = mountPanel({ rows: [row] }); await panel.whenLoaded();
        prepare(panel, mode, 'verification_token_hash'); const other = doc.createElement('button'); other.focus();
        if (submission === 'public') { if (mode === 'add') await panel.submitAdd(); else await panel.submitUpdate(); }
        else findByAttr(host, `data-recued-hostnames-${mode}-submit`)!.click();
        expect(panel.getState()[mode].error).toContain('Proof code is required'); expect(doc.activeElement).toBe(other);
        expect(calls.runAdd).not.toHaveBeenCalled(); expect(calls.runUpdate).not.toHaveBeenCalled(); panel.dispose();
      });
    }
    for (const transition of ['redraw', 'reopen', 'dispose'] as const) {
      it(`ignores a retired ${mode} submit button after ${transition}`, async () => {
        const { doc, host, panel, calls } = mountPanel({ rows: [row] }); await panel.whenLoaded(); prepare(panel, mode, 'verification_token_hash');
        const retired = findByAttr(host, `data-recued-hostnames-${mode}-submit`)!;
        if (transition === 'redraw') { if (mode === 'add') panel.setAddField('enabled', false); else panel.setUpdateField('enabled', false); }
        else if (transition === 'reopen') { if (mode === 'add') panel.cancelAdd(); else panel.cancelUpdate(); prepare(panel, mode, 'verification_token_hash'); }
        else panel.dispose();
        const before = panel.getState(); const other = doc.createElement('button'); other.focus(); retired.click(true);
        expect(panel.getState()).toEqual(before); expect(doc.activeElement).toBe(other);
        expect(calls.runAdd).not.toHaveBeenCalled(); expect(calls.runUpdate).not.toHaveBeenCalled(); panel.dispose();
      });
    }
    it(`keeps ${mode} validation focus disabled while a write is pending`, async () => {
      const pending = pendingResult<{ hostname: HostnameProjection }>();
      const { doc, host, panel, calls } = mountPanel({ rows: [row], runAdd: () => pending.promise, runUpdate: () => pending.promise });
      await panel.whenLoaded(); prepare(panel, mode, 'listener_port_443');
      if (mode === 'add') panel.setAddField('listener_ports', [443]); else panel.setUpdateField('listener_ports', [443]);
      const task = mode === 'add' ? panel.submitAdd() : panel.submitUpdate(); const before = panel.getState();
      const other = doc.createElement('button'); other.focus(); findByAttr(host, `data-recued-hostnames-${mode}-submit`)!.click(true);
      expect(panel.getState()).toEqual(before); expect(doc.activeElement).toBe(other); expect(panel.hasInFlightWork()).toBe(true);
      expect(calls.runAdd.mock.calls.length + calls.runUpdate.mock.calls.length).toBe(1);
      pending.reject(new Error('Synthetic write failed')); await task; expect(doc.activeElement).toBe(other); panel.dispose();
    });
  }
  it('focuses the proof method for an incompatible existing row', async () => {
    const legacy = hostname('legacy.example', { cert_source: 'byo_external', verification_method: 'cert_proof' });
    const { doc, host, panel, calls } = mountPanel({ rows: [legacy] }); await panel.whenLoaded(); panel.openUpdate(legacy.hostname);
    findByAttr(host, 'data-recued-hostnames-update-submit')!.click(true);
    expect(panel.getState().update.error).toBe('You cannot prove it that way for this kind of certificate.');
    const method = findByAttr(host, 'data-recued-hostnames-update-field', 'method')!; expect(doc.activeElement).toBe(method);
    method.value = 'dns_txt'; method.dispatch('change'); expect(panel.getState().update.error).toBeNull(); expect(panel.hasUnsavedChanges()).toBe(true);
    expect(calls.runUpdate).not.toHaveBeenCalled(); panel.dispose();
  });
  it('does not guess an invalid field for an unchanged Edit form', async () => {
    const { doc, host, panel, calls } = mountPanel({ rows: [row] }); await panel.whenLoaded(); panel.openUpdate(row.hostname);
    const other = doc.createElement('button'); other.focus(); findByAttr(host, 'data-recued-hostnames-update-submit')!.click(true);
    expect(panel.getState().update.error).toBe('No changes to save.'); expect(doc.activeElement).toBe(other);
    expect(calls.runUpdate).not.toHaveBeenCalled(); panel.dispose();
  });
});


describe('Hostnames validation focus audit', () => {
  const row = hostname('seed.example');
  const rawName = '  new.example  ';
  const rawProof = '  synthetic-proof  ';
  const submit = (host: FakeElement, mode: 'add' | 'update'): void => {
    findByAttr(host, `data-recued-hostnames-${mode}-submit`)!.click(true);
  };
  const field = (host: FakeElement, mode: 'add' | 'update', name: string): FakeElement =>
    findByAttr(host, `data-recued-hostnames-${mode}-field`, name)!;

  it('advances through Add errors in field order before sending one trimmed write', async () => {
    const { doc, host, panel, calls } = mountPanel(); await panel.whenLoaded(); panel.openAdd();
    panel.setAddField('hostname', '  '); panel.setAddField('verification_token_hash', '  '); panel.setAddField('listener_ports', []);
    for (const [name, message, correction] of [
      ['hostname', 'You need to give a name.', rawName],
      ['verification_token_hash', 'Proof code is required for HTTP token and DNS TXT proofs.', rawProof],
      ['listener_port_443', 'Pick at least one port.', ''],
    ]) {
      submit(host, 'add'); const input = field(host, 'add', name!); expect(doc.activeElement).toBe(input);
      expect(panel.getState().add.error).toBe(message); expect(calls.runAdd).not.toHaveBeenCalled();
      if (name === 'listener_port_443') { input.checked = true; input.dispatch('change'); }
      else { input.value = correction!; input.dispatch('input'); }
      expect(panel.getState().add.error).toBeNull();
    }
    submit(host, 'add'); await Promise.resolve();
    expect(calls.runAdd).toHaveBeenCalledExactlyOnceWith({ hostname: 'new.example', cert_source: 'byo_external',
      verification_method: 'dns_txt', verification_token_hash: 'synthetic-proof', listener_ports: [443], enabled: true });
    expect(panel.getState().add.open).toBe(false); panel.dispose();
  });

  for (const mode of ['add', 'update'] as const) {
    for (const source of ['recued_acme', 'byo_uploaded'] as const) {
      it(`focuses ${mode} ports for ${source} without requiring a hidden proof`, async () => {
        const { doc, host, panel, calls } = mountPanel({ rows: [row] }); await panel.whenLoaded();
        if (mode === 'add') { panel.openAdd(); panel.setAddField('hostname', rawName); panel.setAddField('cert_source', source); panel.setAddField('listener_ports', []); }
        else { panel.openUpdate(row.hostname); panel.setUpdateField('cert_source', source); panel.setUpdateField('listener_ports', []); }
        expect(findByAttr(host, `data-recued-hostnames-${mode}-field`, 'verification_token_hash')).toBeNull();
        submit(host, mode); expect(panel.getState()[mode].error).toBe('Pick at least one port.');
        expect(doc.activeElement).toBe(field(host, mode, 'listener_port_443')); expect(panel.getState()[mode].values.cert_source).toBe(source);
        expect(calls.runAdd).not.toHaveBeenCalled(); expect(calls.runUpdate).not.toHaveBeenCalled(); panel.dispose();
      });
    }
    it(`focuses a missing ${mode} uploaded-certificate DNS proof`, async () => {
      const { doc, host, panel, calls } = mountPanel({ rows: [row] }); await panel.whenLoaded();
      if (mode === 'add') { panel.openAdd(); panel.setAddField('hostname', rawName); panel.setAddField('cert_source', 'byo_uploaded'); panel.setAddField('verification_method', 'dns_txt'); panel.setAddField('verification_token_hash', '  '); }
      else { panel.openUpdate(row.hostname); panel.setUpdateField('cert_source', 'byo_uploaded'); panel.setUpdateField('verification_method', 'dns_txt'); panel.setUpdateField('verification_token_hash', '  '); }
      submit(host, mode); expect(panel.getState()[mode].error).toContain('Proof code is required');
      expect(doc.activeElement).toBe(field(host, mode, 'verification_token_hash')); expect(panel.getState()[mode].values.verification_token_hash).toBe('  ');
      expect(calls.runAdd).not.toHaveBeenCalled(); expect(calls.runUpdate).not.toHaveBeenCalled(); panel.dispose();
    });
    it(`keeps the mounted ${mode} submit button active after native text clears its error`, async () => {
      const { host, panel, calls } = mountPanel({ rows: [row] }); await panel.whenLoaded();
      if (mode === 'add') { panel.openAdd(); panel.setAddField('hostname', rawName); }
      else { panel.openUpdate(row.hostname); panel.setUpdateField('verification_method', 'http_token'); }
      submit(host, mode); expect(panel.getState()[mode].error).toContain('Proof code is required');
      const button = findByAttr(host, `data-recued-hostnames-${mode}-submit`)!; const proof = field(host, mode, 'verification_token_hash');
      proof.value = rawProof; proof.dispatch('input'); expect(panel.getState()[mode].error).toBeNull();
      expect(findByAttr(host, `data-recued-hostnames-${mode}-submit`)).toBe(button); button.click(true); await Promise.resolve();
      const caller = mode === 'add' ? calls.runAdd : calls.runUpdate; expect(caller).toHaveBeenCalledTimes(1);
      expect(caller.mock.calls[0]![0]).toMatchObject({ hostname: mode === 'add' ? 'new.example' : row.hostname, verification_token_hash: 'synthetic-proof' });
      expect(panel.getState()[mode].saving).toBe(false); panel.dispose();
    });
  }
});


describe('Hostnames validation associations', () => {
  const row = hostname('seed.example');
  const rawName = '  new.example  ';
  const rawProof = '  synthetic-proof  ';
  const fields = (host: FakeElement, mode: 'add' | 'update') => findAllByAttr(host, `data-recued-hostnames-${mode}-field`);
  const field = (host: FakeElement, mode: 'add' | 'update', name = 'verification_token_hash') => findByAttr(host, `data-recued-hostnames-${mode}-field`, name)!;
  const error = (host: FakeElement, mode: 'add' | 'update') => findAllByAttr(findByAttr(host, `data-recued-hostnames-${mode}-form`)!, HOSTNAMES_PANEL_ERROR_ATTR).find(node => !node.hasAttribute(HOSTNAMES_KEPT_WARNING_ATTR))!;
  const submit = (panel: HostnamesPanelMount, mode: 'add' | 'update') => mode === 'add' ? panel.submitAdd() : panel.submitUpdate();
  const prepare = (panel: HostnamesPanelMount, mode: 'add' | 'update', target = 'verification_token_hash') => {
    if (mode === 'add') {
      panel.openAdd(); panel.setAddField('hostname', target === 'hostname' ? '  ' : rawName);
      panel.setAddField('verification_token_hash', target === 'verification_token_hash' ? '  ' : rawProof);
      if (target === 'listener_port_443') panel.setAddField('listener_ports', []);
    } else {
      panel.openUpdate(row.hostname);
      if (target !== 'method') {
        panel.setUpdateField('verification_method', 'http_token'); panel.setUpdateField('verification_token_hash', target === 'verification_token_hash' ? '  ' : rawProof);
        if (target === 'listener_port_443') panel.setUpdateField('listener_ports', []);
      }
    }
  };
  const expectAssociation = (host: FakeElement, mode: 'add' | 'update', target = 'verification_token_hash') => {
    const input = field(host, mode, target); const message = error(host, mode); const id = message.getAttribute('id');
    expect(id).toBeTruthy(); expect(input.getAttribute('aria-invalid')).toBe('true'); expect(input.getAttribute('aria-describedby')).toBe(id);
    expect(findAllByAttr(host, 'id', id!)).toEqual([message]);
    expect(fields(host, mode).filter(node => node.getAttribute('aria-invalid') === 'true')).toEqual([input]);
    return { input, message, id };
  };
  const expectClean = (input: FakeElement) => { expect(input.getAttribute('aria-invalid')).toBeNull(); expect(input.getAttribute('aria-describedby')).toBeNull(); };
  for (const [mode, target] of [
    ['add', 'hostname'], ['add', 'verification_token_hash'], ['add', 'listener_port_443'],
    ['update', 'verification_token_hash'], ['update', 'listener_port_443'], ['update', 'method'],
  ] as const) {
    it(`marks only ${mode} ${target} and associates its local error without taking public-submit focus`, async () => {
      const selected = target === 'method' ? { ...row, verification_method: 'cert_proof' as const } : row;
      const { doc, host, panel, calls } = mountPanel({ rows: [selected] }); await panel.whenLoaded(); prepare(panel, mode, target);
      const before = panel.getState()[mode].values; const outside = doc.createElement('button'); outside.focus(); await submit(panel, mode);
      expectAssociation(host, mode, target); expect(doc.activeElement).toBe(outside); expect(panel.getState()[mode].values).toEqual(before);
      expect(calls.runAdd).not.toHaveBeenCalled(); expect(calls.runUpdate).not.toHaveBeenCalled(); panel.dispose();
    });
  }
  for (const mode of ['add', 'update'] as const) {
    for (const change of ['text', 'enabled'] as const) {
      it(`clears the ${mode} association on native ${change} edits without replacing fields or kept warnings`, async () => {
        const { host, panel } = mountPanel({ rows: [row], runAddressUses: async () => addressUses({ uses: [
          { use: 'reception', source: 'owner', hostname: row.hostname, base_url: `https://${row.hostname}` },
        ] }) }); await panel.whenLoaded(); prepare(panel, mode); await submit(panel, mode);
        const { input, message } = expectAssociation(host, mode); const form = findByAttr(host, `data-recued-hostnames-${mode}-form`)!;
        const warning = findByAttr(form, HOSTNAMES_KEPT_WARNING_ATTR);
        if (change === 'text') { input.value = rawProof; input.dispatch('input'); }
        else { const enabled = field(host, mode, 'enabled'); enabled.checked = false; enabled.dispatch('change'); }
        expect(field(host, mode)).toBe(input); expect(findByAttr(host, `data-recued-hostnames-${mode}-form`)).toBe(form); expect(message.parent).toBeNull(); expectClean(input);
        if (mode === 'update') expect(findByAttr(form, HOSTNAMES_KEPT_WARNING_ATTR)).toBe(warning);
        expect(panel.getState()[mode].error).toBeNull(); expect(panel.hasUnsavedChanges()).toBe(true); panel.dispose();
      });
    }
    it(`clears retired ${mode} port attributes when a native choice redraws the editor`, async () => {
      const { host, panel } = mountPanel({ rows: [row] }); await panel.whenLoaded(); prepare(panel, mode, 'listener_port_443'); await submit(panel, mode);
      const { input } = expectAssociation(host, mode, 'listener_port_443'); input.checked = true; input.dispatch('change');
      expectClean(input); for (const node of fields(host, mode)) expectClean(node); expect(panel.getState()[mode].error).toBeNull(); panel.dispose();
    });
    it(`keeps the ${mode} association through roster redraws and ignores retired inputs`, async () => {
      const { host, panel } = mountPanel({ rows: [row] }); await panel.whenLoaded(); prepare(panel, mode); await submit(panel, mode);
      const old = expectAssociation(host, mode); const before = panel.getState()[mode].values; await panel.refresh();
      const current = expectAssociation(host, mode); expect(current.input).not.toBe(old.input); expect(current.id).toBe(old.id); expectClean(old.input);
      old.input.value = rawProof; old.input.dispatch('input'); expectAssociation(host, mode); expect(panel.getState()[mode].values).toEqual(before); panel.dispose();
    });
    it(`leaves a ${mode} server error unassociated even when its text matches local validation`, async () => {
      const localMessage = mode === 'add' ? 'Proof code is required for HTTP token and DNS TXT proofs.' : 'Proof code is required when changing to HTTP token or DNS TXT proof.';
      const fail = async () => { throw new Error(localMessage); };
      const { host, panel, calls } = mountPanel({ rows: [row], runAdd: fail, runUpdate: fail }); await panel.whenLoaded(); prepare(panel, mode); await submit(panel, mode);
      const { input } = expectAssociation(host, mode); input.value = rawProof; input.dispatch('input'); await submit(panel, mode);
      expect(panel.getState()[mode].error).toBe(localMessage); expect(error(host, mode).getAttribute('id')).toBeNull();
      for (const node of fields(host, mode)) expectClean(node); expect(calls.runAdd.mock.calls.length + calls.runUpdate.mock.calls.length).toBe(1); panel.dispose();
    });
    for (const transition of ['reopen', 'dispose'] as const) {
      it(`retires ${mode} error attributes on ${transition}`, async () => {
        const { host, panel } = mountPanel({ rows: [row] }); await panel.whenLoaded(); prepare(panel, mode); await submit(panel, mode);
        const { input } = expectAssociation(host, mode);
        if (transition === 'dispose') panel.dispose();
        else {
          if (mode === 'add') panel.cancelAdd(); else panel.cancelUpdate(); prepare(panel, mode);
          for (const node of fields(host, mode)) expectClean(node); await submit(panel, mode); const current = expectAssociation(host, mode);
          input.value = rawProof; input.dispatch('input'); expect(current.input.getAttribute('aria-describedby')).toBe(current.id);
        }
        expectClean(input); panel.dispose();
      });
    }
    it(`preserves another ${mode} description when native editing clears the validation message`, async () => {
      const { host, panel } = mountPanel({ rows: [row] }); await panel.whenLoaded(); prepare(panel, mode); await submit(panel, mode);
      const { input, id } = expectAssociation(host, mode); input.setAttribute('aria-describedby', `${id} retained-help`); input.value = rawProof; input.dispatch('input');
      expect(input.getAttribute('aria-invalid')).toBeNull(); expect(input.getAttribute('aria-describedby')).toBe('retained-help'); panel.dispose();
    });
  }
  it('uses separate error IDs for panels sharing a document, including a remount', async () => {
    const doc = makeFakeDocument(); const first = mountPanel({ document: doc }); const second = mountPanel({ document: doc });
    await Promise.all([first.panel.whenLoaded(), second.panel.whenLoaded()]);
    prepare(first.panel, 'add'); prepare(second.panel, 'add'); await first.panel.submitAdd(); await second.panel.submitAdd();
    const a = expectAssociation(first.host, 'add'); const b = expectAssociation(second.host, 'add'); expect(a.id).not.toBe(b.id);
    first.panel.dispose(); expect(b.input.getAttribute('aria-describedby')).toBe(b.id); expect(b.input.getAttribute('aria-invalid')).toBe('true');
    const third = mountPanel({ document: doc }); await third.panel.whenLoaded(); prepare(third.panel, 'add'); await third.panel.submitAdd();
    const c = expectAssociation(third.host, 'add'); expect(c.id).not.toBe(a.id); expect(c.id).not.toBe(b.id); expectClean(a.input); second.panel.dispose(); third.panel.dispose();
  });
  it('does not mark a field for a generic unchanged-Edit message', async () => {
    const { host, panel } = mountPanel({ rows: [row] }); await panel.whenLoaded(); panel.openUpdate(row.hostname); await panel.submitUpdate();
    expect(panel.getState().update.error).toBe('No changes to save.'); expect(error(host, 'update').getAttribute('id')).toBeNull();
    for (const node of fields(host, 'update')) expectClean(node); panel.dispose();
  });
});


describe('Hostnames association audit', () => {
  const row = hostname('seed.example'); const rawProof = '  synthetic-proof  ';
  const field = (host: FakeElement, mode: 'add' | 'update', name = 'verification_token_hash') => findByAttr(host, `data-recued-hostnames-${mode}-field`, name)!;
  const message = (host: FakeElement, mode: 'add' | 'update') => findAllByAttr(findByAttr(host, `data-recued-hostnames-${mode}-form`)!, HOSTNAMES_PANEL_ERROR_ATTR).find(node => !node.hasAttribute(HOSTNAMES_KEPT_WARNING_ATTR))!;
  const submit = (panel: HostnamesPanelMount, mode: 'add' | 'update') => mode === 'add' ? panel.submitAdd() : panel.submitUpdate();
  const prepare = (panel: HostnamesPanelMount, mode: 'add' | 'update') => {
    if (mode === 'add') { panel.openAdd(); panel.setAddField('hostname', '  new.example  '); }
    else { panel.openUpdate(row.hostname); panel.setUpdateField('verification_method', 'http_token'); }
  };
  const expectClean = (input: FakeElement) => { expect(input.getAttribute('aria-invalid')).toBeNull(); expect(input.getAttribute('aria-describedby')).toBeNull(); };

  it('moves one Add error ID across successive field errors and clears retired targets', async () => {
    const { host, panel, calls } = mountPanel(); await panel.whenLoaded(); panel.openAdd(); panel.setAddField('listener_ports', []);
    let id: string | null = null; let previous: FakeElement | null = null;
    for (const [name, text, correction] of [
      ['hostname', 'You need to give a name.', '  new.example  '],
      ['verification_token_hash', 'Proof code is required for HTTP token and DNS TXT proofs.', rawProof],
      ['listener_port_443', 'Pick at least one port.', ''],
    ] as const) {
      await panel.submitAdd(); const input = field(host, 'add', name); const error = message(host, 'add'); expect(error.textContent).toBe(text);
      expect(input.getAttribute('aria-invalid')).toBe('true'); expect(error.getAttribute('id')).toBeTruthy();
      if (id !== null) expect(error.getAttribute('id')).toBe(id); else id = error.getAttribute('id');
      expect(input.getAttribute('aria-describedby')).toBe(id); expect(findAllByAttr(host, 'id', id!)).toEqual([error]);
      if (previous !== null) expectClean(previous);
      if (name === 'listener_port_443') { input.checked = true; input.dispatch('change'); }
      else { input.value = correction; input.dispatch('input'); }
      expectClean(input); previous = input;
    }
    expect(panel.getState().add.error).toBeNull(); expect(calls.runAdd).not.toHaveBeenCalled(); panel.dispose();
  });
  for (const mode of ['add', 'update'] as const) {
    for (const source of ['recued_acme', 'byo_uploaded'] as const) {
      it(`retires ${mode} proof associations when ${source} hides the field`, async () => {
        const { host, panel, calls } = mountPanel({ rows: [row] }); await panel.whenLoaded(); prepare(panel, mode); await submit(panel, mode);
        const input = field(host, mode); expect(input.getAttribute('aria-invalid')).toBe('true'); const id = input.getAttribute('aria-describedby');
        const choice = field(host, mode, 'cert_source'); choice.value = source; choice.dispatch('change');
        expect(findByAttr(host, `data-recued-hostnames-${mode}-field`, 'verification_token_hash')).toBeNull(); expectClean(input);
        expect(findAllByAttr(host, 'id', id!)).toHaveLength(0); expect(panel.getState()[mode].error).toBeNull();
        expect(calls.runAdd).not.toHaveBeenCalled(); expect(calls.runUpdate).not.toHaveBeenCalled(); panel.dispose();
      });
    }
    it(`ignores a retired ${mode} Enabled event while a reopened form has an association`, async () => {
      const { host, panel } = mountPanel({ rows: [row] }); await panel.whenLoaded(); prepare(panel, mode); await submit(panel, mode);
      const retired = field(host, mode, 'enabled'); if (mode === 'add') panel.cancelAdd(); else panel.cancelUpdate();
      prepare(panel, mode); await submit(panel, mode); const input = field(host, mode); const id = input.getAttribute('aria-describedby'); const before = panel.getState();
      retired.checked = false; retired.dispatch('change'); expect(panel.getState()).toEqual(before); expect(input.getAttribute('aria-describedby')).toBe(id);
      expect(input.getAttribute('aria-invalid')).toBe('true'); expect(findAllByAttr(host, 'id', id!)).toEqual([message(host, mode)]); panel.dispose();
    });
  }
  it('clears a proof association when native hostname editing clears the shared feedback', async () => {
    const { doc, host, panel, calls } = mountPanel(); await panel.whenLoaded(); prepare(panel, 'add'); await panel.submitAdd();
    const proof = field(host, 'add'); expect(proof.getAttribute('aria-invalid')).toBe('true'); const name = field(host, 'add', 'hostname'); name.focus();
    name.value = '  corrected.example  '; name.dispatch('input'); expectClean(proof); expect(field(host, 'add')).toBe(proof); expect(field(host, 'add', 'hostname')).toBe(name);
    expect(doc.activeElement).toBe(name); expect(panel.getState().add.values.hostname).toBe('  corrected.example  '); expect(panel.getState().add.error).toBeNull(); expect(calls.runAdd).not.toHaveBeenCalled(); panel.dispose();
  });
});


describe('Hostnames validation Enter', () => {
  const row = hostname('seed.example');
  const rawName = '  new.example  ';
  const rawProof = '  synthetic-proof  ';
  const inputFor = (host: FakeElement, mode: 'add' | 'update', field = 'verification_token_hash') =>
    findByAttr(host, `data-recued-hostnames-${mode}-field`, field)!;
  const prepare = (panel: HostnamesPanelMount, mode: 'add' | 'update') => {
    if (mode === 'add') {
      panel.openAdd(); panel.setAddField('hostname', rawName);
      panel.setAddField('verification_token_hash', rawProof);
    } else {
      panel.openUpdate(row.hostname); panel.setUpdateField('verification_token_hash', rawProof);
    }
  };
  const enter = (input: FakeElement, overrides: Partial<KeyboardEvent> = {}) => {
    const event = {
      key: 'Enter', keyCode: 13, isTrusted: true, isComposing: false, repeat: false,
      altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; }, ...overrides,
    };
    input.dispatch('keydown', event);
    return event;
  };
  for (const [mode, target] of [
    ['add', 'hostname'], ['add', 'verification_token_hash'], ['update', 'verification_token_hash'],
  ] as const) {
    it(`submits ${mode} ${target} once with trimmed values and keeps pending locks`, async () => {
      const pending = pendingResult<{ hostname: HostnameProjection }>();
      const { host, panel, calls } = mountPanel({ rows: [row], runAdd: () => pending.promise, runUpdate: () => pending.promise });
      await panel.whenLoaded(); prepare(panel, mode);
      const input = inputFor(host, mode, target); input.focus();
      expect(enter(input).defaultPrevented).toBe(true);
      expect(panel.getState()[mode].saving).toBe(true); expect(panel.hasInFlightWork()).toBe(true);
      expect(panel.hasUnsavedChanges()).toBe(true);
      enter(input); enter(inputFor(host, mode, target));
      expect(calls.runAdd.mock.calls.length + calls.runUpdate.mock.calls.length).toBe(1);
      const call = mode === 'add' ? calls.runAdd.mock.calls[0]![0] : calls.runUpdate.mock.calls[0]![0];
      expect(call).toMatchObject({ hostname: mode === 'add' ? rawName.trim() : row.hostname, verification_token_hash: rawProof.trim() });
      pending.reject(new Error('Synthetic write failed'));
      await vi.waitFor(() => expect(panel.getState()[mode].saving).toBe(false));
      expect(panel.getState()[mode].error).toBe('Synthetic write failed');
      expect(panel.getState()[mode].values.verification_token_hash).toBe(rawProof);
      if (mode === 'add') expect(panel.getState().add.values.hostname).toBe(rawName);
      expect(panel.hasUnsavedChanges()).toBe(true); expect(panel.hasInFlightWork()).toBe(false); panel.dispose();
    });
  }
  for (const [mode, target] of [
    ['add', 'hostname'], ['add', 'verification_token_hash'], ['add', 'listener_port_443'],
    ['update', 'verification_token_hash'], ['update', 'listener_port_443'],
  ] as const) {
    it(`focuses and describes invalid ${mode} ${target} without writing`, async () => {
      const { doc, host, panel, calls } = mountPanel({ rows: [row] }); await panel.whenLoaded(); prepare(panel, mode);
      if (mode === 'add') {
        if (target === 'hostname') panel.setAddField('hostname', '  ');
        if (target === 'verification_token_hash') panel.setAddField('verification_token_hash', '  ');
        if (target === 'listener_port_443') panel.setAddField('listener_ports', []);
      } else {
        if (target === 'verification_token_hash') {
          panel.setUpdateField('verification_method', 'http_token'); panel.setUpdateField('verification_token_hash', '  ');
        } else panel.setUpdateField('listener_ports', []);
      }
      const values = panel.getState()[mode].values;
      const input = inputFor(host, mode); input.focus(); expect(enter(input).defaultPrevented).toBe(true);
      const invalid = inputFor(host, mode, target);
      expect(doc.activeElement).toBe(invalid); expect(invalid.getAttribute('aria-invalid')).toBe('true');
      const error = findAllByAttr(host, HOSTNAMES_PANEL_ERROR_ATTR).find(node => !node.hasAttribute(HOSTNAMES_KEPT_WARNING_ATTR))!;
      expect(invalid.getAttribute('aria-describedby')).toBe(error.getAttribute('id'));
      expect(panel.getState()[mode].values).toEqual(values);
      expect(calls.runAdd).not.toHaveBeenCalled(); expect(calls.runUpdate).not.toHaveBeenCalled(); panel.dispose();
    });
  }
  for (const mode of ['add', 'update'] as const) {
    it(`ignores modified, composing, repeated, consumed and scripted ${mode} keys`, async () => {
      const { host, panel, calls } = mountPanel({ rows: [row] }); await panel.whenLoaded(); prepare(panel, mode);
      const before = panel.getState(); const input = inputFor(host, mode);
      for (const overrides of [
        { key: 'Escape' }, { key: ' ' }, { altKey: true }, { ctrlKey: true }, { metaKey: true }, { shiftKey: true },
        { isComposing: true }, { keyCode: 229 }, { repeat: true }, { isTrusted: false }, { defaultPrevented: true },
      ]) {
        const event = enter(input, overrides);
        expect(event.defaultPrevented).toBe(overrides.defaultPrevented === true);
        expect(panel.getState()).toBe(before);
      }
      expect(calls.runAdd).not.toHaveBeenCalled(); expect(calls.runUpdate).not.toHaveBeenCalled(); panel.dispose();
    });
    it(`waits for ${mode} composition to finish before accepting a later Enter`, async () => {
      const { host, panel, calls } = mountPanel({ rows: [row] }); await panel.whenLoaded(); prepare(panel, mode);
      const input = inputFor(host, mode); const before = panel.getState();
      input.dispatch('compositionstart'); expect(enter(input).defaultPrevented).toBe(false); expect(panel.getState()).toBe(before);
      input.value = rawProof; input.dispatch('input');
      expect(enter(input).defaultPrevented).toBe(false);
      input.dispatch('compositionend'); expect(enter(input).defaultPrevented).toBe(true);
      expect(calls.runAdd.mock.calls.length + calls.runUpdate.mock.calls.length).toBe(1);
      await vi.waitFor(() => expect(panel.getState()[mode].saving).toBe(false)); panel.dispose();
    });
    for (const transition of ['redraw', 'reopen', 'dispose'] as const) {
      it(`ignores retired ${mode} text input after ${transition}`, async () => {
        const { doc, host, panel, calls } = mountPanel({ rows: [row] }); await panel.whenLoaded(); prepare(panel, mode);
        const retired = inputFor(host, mode);
        if (transition === 'redraw') {
          if (mode === 'add') panel.setAddField('enabled', false); else panel.setUpdateField('enabled', false);
        } else if (transition === 'reopen') {
          if (mode === 'add') panel.cancelAdd(); else panel.cancelUpdate(); prepare(panel, mode);
        } else panel.dispose();
        const before = panel.getState(); const other = doc.createElement('button'); other.focus();
        expect(enter(retired).defaultPrevented).toBe(false);
        expect(panel.getState()).toBe(before); expect(doc.activeElement).toBe(other);
        expect(calls.runAdd).not.toHaveBeenCalled(); expect(calls.runUpdate).not.toHaveBeenCalled(); panel.dispose();
      });
    }
    it(`does not submit ${mode} from choices or keyup`, async () => {
      const { host, panel, calls } = mountPanel({ rows: [row] }); await panel.whenLoaded(); prepare(panel, mode);
      const before = panel.getState(); inputFor(host, mode).dispatch('keyup', { key: 'Enter', isTrusted: true });
      for (const name of ['enabled', 'method', 'cert_source', 'listener_port_443']) expect(enter(inputFor(host, mode, name)).defaultPrevented).toBe(false);
      expect(panel.getState()).toBe(before); expect(calls.runAdd).not.toHaveBeenCalled(); expect(calls.runUpdate).not.toHaveBeenCalled(); panel.dispose();
    });
  }
  it('leaves manual Verify submission explicit', async () => {
    const { host, panel, calls } = mountPanel({ rows: [row] }); await panel.whenLoaded();
    panel.openVerify(row.hostname); panel.setVerifyField('observed_token_hash', rawProof);
    const before = panel.getState(); const input = findByAttr(host, 'data-recued-hostnames-verify-field', 'observed_token_hash')!;
    expect(enter(input).defaultPrevented).toBe(false); expect(panel.getState()).toBe(before);
    expect(calls.runVerify).not.toHaveBeenCalled(); expect(calls.runExternalProbe).not.toHaveBeenCalled(); panel.dispose();
  });

  describe('audit', () => {
    for (const mode of ['add', 'update'] as const) {
      it(`submits the same ${mode} text input after native correction clears feedback`, async () => {
        const pending = pendingResult<{ hostname: HostnameProjection }>();
        const { doc, host, panel, calls } = mountPanel({ rows: [row], runAdd: () => pending.promise, runUpdate: () => pending.promise });
        await panel.whenLoaded(); prepare(panel, mode);
        if (mode === 'add') panel.setAddField('verification_token_hash', '  ');
        else { panel.setUpdateField('verification_method', 'http_token'); panel.setUpdateField('verification_token_hash', '  '); }
        enter(inputFor(host, mode)); const input = inputFor(host, mode); input.focus();
        expect(input.getAttribute('aria-invalid')).toBe('true'); input.value = rawProof; input.dispatch('input');
        expect(doc.activeElement).toBe(input); expect(inputFor(host, mode)).toBe(input);
        expect(input.getAttribute('aria-invalid')).toBeNull(); expect(panel.getState()[mode].error).toBeNull();
        expect(enter(input).defaultPrevented).toBe(true);
        expect(calls.runAdd.mock.calls.length + calls.runUpdate.mock.calls.length).toBe(1);
        pending.resolve({ hostname: hostname(mode === 'add' ? rawName.trim() : row.hostname) });
        await vi.waitFor(() => expect(panel.getState()[mode].saving).toBe(false)); panel.dispose();
      });
      it(`retries ${mode} once with Numpad Enter after a rejected write`, async () => {
        const first = pendingResult<{ hostname: HostnameProjection }>(); const second = pendingResult<{ hostname: HostnameProjection }>();
        let attempt = 0; const write = () => (++attempt === 1 ? first.promise : second.promise);
        const { host, panel, calls } = mountPanel({ rows: [row], runAdd: write, runUpdate: write }); await panel.whenLoaded(); prepare(panel, mode);
        const retired = inputFor(host, mode); enter(retired); first.reject(new Error('Synthetic write failed'));
        await vi.waitFor(() => expect(panel.getState()[mode].saving).toBe(false));
        const input = inputFor(host, mode); expect(input).not.toBe(retired); expect(panel.getState()[mode].error).toBe('Synthetic write failed');
        expect(enter(retired).defaultPrevented).toBe(false);
        expect(enter(input, { code: 'NumpadEnter', location: 3 }).defaultPrevented).toBe(true);
        enter(input); enter(inputFor(host, mode));
        expect(calls.runAdd.mock.calls.length + calls.runUpdate.mock.calls.length).toBe(2);
        expect(panel.getState()[mode].error).toBeNull(); expect(panel.hasInFlightWork()).toBe(true);
        second.resolve({ hostname: hostname(mode === 'add' ? rawName.trim() : row.hostname) });
        await vi.waitFor(() => expect(panel.getState()[mode].saving).toBe(false));
        expect(mode === 'add' ? panel.getState().add.open : panel.getState().update.hostname !== null).toBe(false); panel.dispose();
      });
    }
    for (const source of ['recued_acme', 'byo_uploaded'] as const) {
      it(`submits an Add hostname when ${source} hides the proof field`, async () => {
        const { host, panel, calls } = mountPanel(); await panel.whenLoaded(); panel.openAdd();
        panel.setAddField('hostname', rawName); panel.setAddField('cert_source', source);
        expect(findByAttr(host, 'data-recued-hostnames-add-field', 'verification_token_hash')).toBeNull();
        expect(enter(inputFor(host, 'add', 'hostname')).defaultPrevented).toBe(true);
        expect(calls.runAdd).toHaveBeenCalledTimes(1);
        expect(calls.runAdd.mock.calls[0]![0]).toEqual({ hostname: rawName.trim(), cert_source: source,
          ...(source === 'byo_uploaded' ? { verification_method: 'cert_proof' } : {}), listener_ports: [443], enabled: true });
        await vi.waitFor(() => expect(panel.getState().add.saving).toBe(false)); panel.dispose();
      });
    }
    it('advances through Add validation errors before one native text-field write', async () => {
      const { doc, host, panel, calls } = mountPanel(); await panel.whenLoaded(); panel.openAdd(); panel.setAddField('listener_ports', []);
      enter(inputFor(host, 'add', 'hostname')); let input = inputFor(host, 'add', 'hostname'); expect(doc.activeElement).toBe(input);
      input.value = rawName; input.dispatch('input'); enter(input); input = inputFor(host, 'add'); expect(doc.activeElement).toBe(input);
      input.value = rawProof; input.dispatch('input'); enter(input);
      const port = inputFor(host, 'add', 'listener_port_443'); expect(doc.activeElement).toBe(port); expect(calls.runAdd).not.toHaveBeenCalled();
      port.checked = true; port.dispatch('change'); expect(enter(inputFor(host, 'add')).defaultPrevented).toBe(true);
      expect(calls.runAdd).toHaveBeenCalledTimes(1); await vi.waitFor(() => expect(panel.getState().add.saving).toBe(false)); panel.dispose();
    });
    it('keeps native Enter owned by its panel in a shared document', async () => {
      const doc = makeFakeDocument(); const first = mountPanel({ document: doc }); const second = mountPanel({ document: doc });
      await Promise.all([first.panel.whenLoaded(), second.panel.whenLoaded()]); prepare(first.panel, 'add'); prepare(second.panel, 'add');
      const before = second.panel.getState(); enter(inputFor(first.host, 'add'));
      expect(first.calls.runAdd).toHaveBeenCalledTimes(1); expect(second.calls.runAdd).not.toHaveBeenCalled(); expect(second.panel.getState()).toBe(before);
      await vi.waitFor(() => expect(first.panel.getState().add.saving).toBe(false)); first.panel.dispose(); second.panel.dispose();
    });
  });
});
