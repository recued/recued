/** D-165 P3.enroll-host — Settings → Connections enrollment panel.
 *
 *  The host mounts `renderConnectionsPage` via innerHTML + delegated
 *  dispatch (no jsdom in this repo), so — like the reception authoring
 *  mount test — the fake host stores `innerHTML` as a string and
 *  simulates delegated `click` / field `input` / `change` events by
 *  handing the listeners a synthetic `{ dataset, closest }` target.
 *  Assertions read the mount's `getState()` + the rpc mocks + rendered
 *  HTML substrings (the renderer itself is real). The bootstrap-gating
 *  test uses a fuller fake document (the grant-panel test's shape,
 *  widened with `innerHTML` / `contains` / `querySelector`). */

import { describe, expect, it, vi } from 'vitest';

import {
  mountConnectionsEnrollPanel,
  type ConnectionsEnrollListCaller,
  type ConnectionsEnrollCaller,
  type ConnectionsUpdateCaller,
  type ConnectionsDeleteCaller,
  type ConnectionsProbeCaller,
  type ConnectionsEngagementHealthCaller,
  type ConnectionsReprobeEngagementCapabilitiesCaller,
  type ConnectionsMailListCaller,
  type ConnectionsStartVendorOAuthCaller,
  type ConnectionsTakeVendorOAuthResultCaller,
  type VendorOAuthBrowserEnv,
  type VendorOAuthPopupHandle,
} from '../settings/connections-enroll-panel.js';
import type { BroadcastSubscriber } from '../realtime/subscriber.js';
import { MAIL_SEND_CAPABLE_INSTANCES_SOURCE } from '@recued/ui-shared';
import {
  SALESFORCE_OAUTH_TOKEN_URL_SANDBOX,
  SALESFORCE_OAUTH_TOKEN_URL_PRODUCTION,
  OAUTH_CLOUD_CALLBACK_URL,
  MAX_HEADER_AUTH_ENTRIES,
  getVendorProvider,
  type ConnectionHealth,
  type ConnectionView,
  type EngagementHealthResponse,
  type PackListEntry,
  type ReprobeEngagementCapabilitiesResponse,
} from '@recued/contracts';

// ════════════════════════════════════════════════════════════════
// Lightweight string-innerHTML fake host (unit tests)
// ════════════════════════════════════════════════════════════════

interface FakeSubmitButton {
  attrs: Set<string>;
  setAttribute(k: string): void;
  removeAttribute(k: string): void;
  hasAttribute(k: string): boolean;
}

const SUBMIT_SELECTOR = '[data-action="connections-submit-form"]';

const makeFakeHost = () => {
  let html = '';
  const listeners = new Map<string, Array<(ev: unknown) => void>>();
  const submitBtn: FakeSubmitButton = {
    attrs: new Set<string>(),
    setAttribute(k) {
      this.attrs.add(k);
    },
    removeAttribute(k) {
      this.attrs.delete(k);
    },
    hasAttribute(k) {
      return this.attrs.has(k);
    },
  };
  const host = {
    get innerHTML() {
      return html;
    },
    set innerHTML(v: string) {
      html = v;
    },
    addEventListener(type: string, fn: (ev: unknown) => void) {
      const list = listeners.get(type) ?? [];
      list.push(fn);
      listeners.set(type, list);
    },
    removeEventListener(type: string, fn: (ev: unknown) => void) {
      const list = listeners.get(type);
      if (list === undefined) return;
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    },
    contains() {
      return true;
    },
    querySelector(sel: string) {
      return sel === SUBMIT_SELECTOR ? submitBtn : null;
    },
  };
  const fire = (type: string, ev: unknown): void => {
    for (const fn of [...(listeners.get(type) ?? [])]) fn(ev);
  };
  /** Simulate a delegated action click — `data` carries `action` + any
   *  `data-*` keys (camelCased: `kind`, `name`, `vendor`, `subtype`). */
  const click = (data: Record<string, string>): void => {
    const el = { dataset: data, closest: () => el };
    fire('click', { target: el, preventDefault() {} });
  };
  /** Simulate a field edit on a `data-conn-field` control. SELECT fires
   *  `change` (visibility re-render); everything else fires `input`. */
  const field = (key: string, value: string, tagName = 'INPUT'): void => {
    const el = { dataset: { connField: key }, value, tagName, closest: () => el };
    const type = tagName === 'SELECT' ? 'change' : 'input';
    fire(type, { target: el, type });
  };
  return {
    host: host as unknown as HTMLElement,
    getHtml: () => html,
    submitBtn,
    listenerCount: () =>
      [...listeners.values()].reduce((n, l) => n + l.length, 0),
    click,
    field,
  };
};

const tick = async (n = 10): Promise<void> => {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
};

const deferred = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

// ── Fixtures + mount helper ───────────────────────────────────────

const connection = (
  name: string,
  over: Partial<ConnectionView> = {},
): ConnectionView => ({
  name,
  kind: 'api',
  display_name: name,
  ...over,
});

const FIXED_NOW = 1_714_867_200_000;

const hubspotHealth = (): EngagementHealthResponse => ({
  vendor: 'hubspot',
  daily_budget: 250_000,
  bucket_started_at: FIXED_NOW,
  relationships: [],
  rows: [
    {
      vendor: 'hubspot',
      entity: 'email',
      last_pulled_at: FIXED_NOW - 60_000,
      last_error: null,
      pages_fetched_today: 2,
      api_calls_consumed_today: 12,
      budget_utilization_pct: 0.000048,
      rate_control_state: 'normal',
    },
  ],
});

const salesforceHealth = (): EngagementHealthResponse => ({
  vendor: 'salesforce',
  daily_budget: 50_000,
  bucket_started_at: FIXED_NOW,
  relationships: [],
  rows: [
    {
      vendor: 'salesforce',
      entity: 'task',
      last_pulled_at: FIXED_NOW - 120_000,
      last_error: null,
      pages_fetched_today: 1,
      api_calls_consumed_today: 24,
      budget_utilization_pct: 0.00048,
      rate_control_state: 'normal',
      capability: {
        connection_id: 'api/sf',
        vendor: 'salesforce',
        entity: 'task',
        available: true,
        cdc_supported: true,
        push_topic_supported: true,
        reconciler_only: false,
        association_rescan_required: false,
        last_probed_at: FIXED_NOW,
      },
    },
  ],
});

const salesforceReprobe = (): ReprobeEngagementCapabilitiesResponse => ({
  rows: [
    {
      ...salesforceHealth().rows[0]!,
      entity: 'voice_call',
      api_calls_consumed_today: 32,
    },
  ],
  reprobed_at: FIXED_NOW + 1_000,
  winning_call_entity: 'voice_call',
  call_entity_changed: true,
  pushtopic_creation: [{ entity: 'voice_call', outcome: 'created' }],
});

interface MountOpts {
  connections?: ReadonlyArray<ConnectionView>;
  runList?: ConnectionsEnrollListCaller;
  runEnroll?: ConnectionsEnrollCaller;
  runUpdate?: ConnectionsUpdateCaller;
  runDelete?: ConnectionsDeleteCaller;
  runProbe?: ConnectionsProbeCaller;
  runEngagementHealth?: ConnectionsEngagementHealthCaller;
  runReprobeEngagementCapabilities?: ConnectionsReprobeEngagementCapabilitiesCaller;
  runMailList?: ConnectionsMailListCaller;
  runPacksList?: () => Promise<{ packs: ReadonlyArray<PackListEntry> }>;
  oauth?: {
    env?: VendorOAuthBrowserEnv;
    subscribe?: BroadcastSubscriber['on'];
    runStart?: ConnectionsStartVendorOAuthCaller;
    runTake?: ConnectionsTakeVendorOAuthResultCaller;
  };
}

const mountPanel = (opts: MountOpts = {}) => {
  const fake = makeFakeHost();

  const runList = vi.fn<ConnectionsEnrollListCaller>();
  runList.mockImplementation(
    opts.runList ?? (async () => ({ connections: opts.connections ?? [] })),
  );
  const runEnroll = vi.fn<ConnectionsEnrollCaller>();
  runEnroll.mockImplementation(
    opts.runEnroll
      ?? (async (args) => ({
        connection: connection(args.name, {
          kind: args.kind,
          display_name: args.display_name,
        }),
        probe: { status: 'ok' } as ConnectionHealth,
      })),
  );
  const runUpdate = vi.fn<ConnectionsUpdateCaller>();
  runUpdate.mockImplementation(
    opts.runUpdate
      ?? (async (args) => ({
        connection: connection(args.name, { kind: args.kind }),
      })),
  );
  const runDelete = vi.fn<ConnectionsDeleteCaller>();
  runDelete.mockImplementation(opts.runDelete ?? (async () => ({ deleted: true })));
  const runProbe = vi.fn<ConnectionsProbeCaller>();
  runProbe.mockImplementation(
    opts.runProbe ?? (async () => ({ health: { status: 'ok' } as ConnectionHealth })),
  );
  const runEngagementHealth = vi.fn<ConnectionsEngagementHealthCaller>();
  runEngagementHealth.mockImplementation(
    opts.runEngagementHealth
      ?? (async ({ name }) => (name === 'sf' ? salesforceHealth() : hubspotHealth())),
  );
  const runReprobeEngagementCapabilities =
    vi.fn<ConnectionsReprobeEngagementCapabilitiesCaller>();
  runReprobeEngagementCapabilities.mockImplementation(
    opts.runReprobeEngagementCapabilities ?? (async () => salesforceReprobe()),
  );
  const runMailList = vi.fn<ConnectionsMailListCaller>();
  runMailList.mockImplementation(
    opts.runMailList ?? (async () => ({ instances: [] })),
  );

  const mount = mountConnectionsEnrollPanel({
    host: fake.host,
    document: { } as unknown as Document, // unused — host is supplied
    runList,
    runEnroll,
    runUpdate,
    runDelete,
    runProbe,
    ...(opts.runEngagementHealth !== undefined
      ? { runEngagementHealth }
      : {}),
    ...(opts.runReprobeEngagementCapabilities !== undefined
      ? { runReprobeEngagementCapabilities }
      : {}),
    runMailList: opts.runMailList === undefined ? undefined : runMailList,
    ...(opts.oauth?.runStart !== undefined
      ? { runStartVendorOAuth: opts.oauth.runStart }
      : {}),
    ...(opts.oauth?.runTake !== undefined
      ? { runTakeVendorOAuthResult: opts.oauth.runTake }
      : {}),
    ...(opts.oauth?.subscribe !== undefined ? { subscribe: opts.oauth.subscribe } : {}),
    ...(opts.oauth?.env !== undefined ? { oauthEnv: opts.oauth.env } : {}),
    ...(opts.runPacksList !== undefined ? { runPacksList: opts.runPacksList } : {}),
  });

  return {
    ...fake,
    mount,
    calls: {
      runList,
      runEnroll,
      runUpdate,
      runDelete,
      runProbe,
      runEngagementHealth,
      runReprobeEngagementCapabilities,
      runMailList,
    },
  };
};

// ── Vendor OAuth popup fakes (D-165 slice 3) ──────────────────────
const flushAsync = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

// The popup carries its OWN sessionStorage (modeled SEPARATELY from any opener
// store) — the jwks handshake writes into the popup's browsing context, which
// is the one the cloud callback page later reads. A single shared Map would
// mask the per-context bug.
const makeFakePopup = (): VendorOAuthPopupHandle & {
  close: ReturnType<typeof vi.fn>;
  popupStore: Map<string, string>;
  /** The popup's `opener` value captured at the instant `location.href` was
   *  assigned — lets a test prove the opener was severed BEFORE navigation. */
  readonly openerAtNavigation: () => unknown;
} => {
  const popupStore = new Map<string, string>();
  let openerAtNav: unknown = 'UNSET';
  const location = {
    _href: '',
    get href() {
      return this._href;
    },
    set href(v: string) {
      this._href = v;
      openerAtNav = popup.opener; // snapshot opener at navigation time
    },
  };
  const popup = {
    closed: false,
    close: vi.fn(() => {
      popup.closed = true;
    }),
    location,
    // A truthy sentinel standing in for the live `window` opener reference.
    opener: {} as unknown,
    sessionStorage: {
      setItem: (k: string, v: string) => {
        popupStore.set(k, v);
      },
    },
    popupStore,
    openerAtNavigation: () => openerAtNav,
  };
  return popup;
};

const makeFakeOAuthEnv = (popup: VendorOAuthPopupHandle | null) => {
  // The OPENER's sessionStorage — kept as a separate store that MUST stay empty
  // (the jwks must go into the popup, not here). The env no longer carries a
  // sessionStorage seam; this store exists only to assert nothing leaks here.
  const openerStore = new Map<string, string>();
  const timers: Array<() => void> = [];
  const env: VendorOAuthBrowserEnv = {
    open: vi.fn(() => popup),
    setTimeout: vi.fn((fn: () => void) => {
      timers.push(fn);
      return timers.length;
    }),
    clearTimeout: vi.fn(),
  };
  return { env, openerStore, fireTimers: () => timers.forEach((f) => f()) };
};

const makeFakeSubscribe = () => {
  let listener: ((e: { kind: string; flow_id: string; cursor: number }) => void) | null =
    null;
  const subscribe = vi.fn((kind: string, l: (e: never) => void) => {
    if (kind === 'connection.vendor_oauth_completed') {
      listener = l as (e: { kind: string; flow_id: string; cursor: number }) => void;
    }
    return () => {
      listener = null;
    };
  }) as unknown as BroadcastSubscriber['on'];
  return {
    subscribe,
    fire: (flow_id: string) =>
      listener?.({ kind: 'connection.vendor_oauth_completed', flow_id, cursor: 1 }),
  };
};

// ════════════════════════════════════════════════════════════════
// List
// ════════════════════════════════════════════════════════════════

describe('D-165 P3 connections enrollment panel — list', () => {
  it('renders loading, then the enrolled connections grouped by kind', async () => {
    const list = deferred<{ connections: ReadonlyArray<ConnectionView> }>();
    const { mount, getHtml } = mountPanel({
      runList: () => list.promise,
    });

    expect(mount.getState().loading).toBe(true);
    expect(getHtml()).toContain('Loading enrolled connections');

    list.resolve({
      connections: [
        connection('hub', { display_name: 'HubSpot', vendor: 'hubspot' }),
        connection('mcp-a', { kind: 'mcp', subtype: 'sse', display_name: 'MCP A' }),
      ],
    });
    await mount.whenLoaded();

    expect(mount.getState().loading).toBe(false);
    expect(mount.getState().connections).toHaveLength(2);
    const html = getHtml();
    expect(html).toContain('hub');
    expect(html).toContain('mcp-a');
    expect(html).toContain('+ Add Connection');
    mount.dispose();
  });

  it('renders the empty state when no connections are enrolled', async () => {
    const { mount, getHtml } = mountPanel({ connections: [] });
    await mount.whenLoaded();
    expect(mount.getState().connections).toHaveLength(0);
    expect(getHtml()).toContain('No connections enrolled yet');
    mount.dispose();
  });

  it('surfaces a list error without crashing the panel', async () => {
    const { mount, getHtml } = mountPanel({
      runList: async () => {
        throw new Error('list rpc down');
      },
    });
    await mount.whenLoaded();
    expect(mount.getState().error).toBe('list rpc down');
    expect(getHtml()).toContain('list rpc down');
    mount.dispose();
  });
});

// ════════════════════════════════════════════════════════════════
// Add flow — pickers
// ════════════════════════════════════════════════════════════════

describe('D-165 P3 connections enrollment panel — add flow', () => {
  it('open-add → kind-picker → pick api seeds the form auth.type default', async () => {
    const { mount, getHtml, click } = mountPanel({ connections: [] });
    await mount.whenLoaded();

    click({ action: 'connections-open-add' });
    expect(mount.getState().dialog.stage).toBe('kind-picker');
    expect(getHtml()).toContain('Pick a connection kind');

    click({ action: 'connections-pick-kind', kind: 'api' });
    const dialog = mount.getState().dialog;
    expect(dialog.stage).toBe('form');
    expect(dialog.kind).toBe('api');
    // Seeded so an untouched select projects as `bearer`, not `none`.
    expect(dialog.values['auth.type']).toBe('bearer');
    expect(getHtml()).toContain('Add HTTP API');
    mount.dispose();
  });

  it('pick mcp → subtype-picker → pick subtype → form (subtype locked)', async () => {
    const { mount, click } = mountPanel({ connections: [] });
    await mount.whenLoaded();

    click({ action: 'connections-open-add' });
    click({ action: 'connections-pick-kind', kind: 'mcp' });
    expect(mount.getState().dialog.stage).toBe('subtype-picker');

    click({ action: 'connections-pick-subtype', subtype: 'sse' });
    const dialog = mount.getState().dialog;
    expect(dialog.stage).toBe('form');
    expect(dialog.kind).toBe('mcp');
    expect(dialog.subtype).toBe('sse');
    mount.dispose();
  });

  it('pick a vendor preset seeds the vendor schema values + jumps to the form', async () => {
    const { mount, click } = mountPanel({ connections: [] });
    await mount.whenLoaded();

    click({ action: 'connections-open-add' });
    click({ action: 'connections-pick-vendor', vendor: 'hubspot' });
    const dialog = mount.getState().dialog;
    expect(dialog.stage).toBe('form');
    expect(dialog.kind).toBe('api');
    expect(dialog.vendor).toBe('hubspot');
    // Vendor seed carries the locked discriminator + the default auth type
    // (D-129 Service-Key enrollment: `bearer` / Service Key is the default +
    // recommended HubSpot path; `oauth2_refresh` is the selectable alternative).
    expect(dialog.values['config.vendor']).toBe('hubspot');
    expect(dialog.values['auth.type']).toBe('bearer');
    mount.dispose();
  });

  it('Fork 1 B — pre-fills the Scopes field with the vendor const ∪ installed packs needs', async () => {
    // An installed HubSpot pack whose write op needs a scope the read-only
    // vendor const omits — exactly the under-scoping Fork 1 fixes.
    const hubspotPack = {
      slug: 'recued-core.hubspot',
      installed: true,
      manifest: {
        contents: [
          {
            type: 'composition',
            composition: {
              schema_version: 1,
              slug: 'hubspot-catalog',
              ingredients: [
                { slug: 'hubspot-catalog', kind: 'http', http: { base: 'https://api.hubapi.com', connection: 'hubspot' } },
              ],
              operations: [
                {
                  op: 'deal.create', ingredient: 'hubspot-catalog', risk: 'write',
                  approval: 'never', bind: { method: 'POST', path: '/x' },
                  required_scopes: ['crm.objects.deals.write'],
                },
              ],
            },
          },
        ],
      },
    } as unknown as PackListEntry;
    const { mount, click } = mountPanel({
      connections: [],
      runPacksList: async () => ({ packs: [hubspotPack] }),
    });
    await mount.whenLoaded();

    click({ action: 'connections-open-add' });
    click({ action: 'connections-pick-vendor', vendor: 'hubspot' });
    const scopes = (mount.getState().dialog.values['auth.scopes'] ?? '').split(' ');
    // The const floor (every default, incl. essentials) is present...
    for (const s of getVendorProvider('hubspot')!.oauth.scopes) expect(scopes).toContain(s);
    // ...plus the installed pack's write scope, unioned in.
    expect(scopes).toContain('crm.objects.deals.write');
    mount.dispose();
  });

  it('Fork 1 B — leaves the Scopes field blank when packs.list is unavailable (server unions)', async () => {
    const { mount, click } = mountPanel({ connections: [] }); // no runPacksList
    await mount.whenLoaded();

    click({ action: 'connections-open-add' });
    click({ action: 'connections-pick-vendor', vendor: 'hubspot' });
    // Field absent → start passes nothing → the server computes the union (A).
    expect(mount.getState().dialog.values['auth.scopes']).toBeUndefined();
    mount.dispose();
  });

  it('back + cancel navigate the dialog stages', async () => {
    const { mount, click } = mountPanel({ connections: [] });
    await mount.whenLoaded();

    click({ action: 'connections-open-add' });
    click({ action: 'connections-pick-kind', kind: 'notification' });
    expect(mount.getState().dialog.stage).toBe('subtype-picker');
    click({ action: 'connections-pick-subtype', subtype: 'slack' });
    expect(mount.getState().dialog.stage).toBe('form');
    click({ action: 'connections-back-to-subtype' });
    expect(mount.getState().dialog.stage).toBe('subtype-picker');
    expect(mount.getState().dialog.subtype).toBeNull();
    click({ action: 'connections-back-to-kind' });
    expect(mount.getState().dialog.stage).toBe('kind-picker');
    click({ action: 'connections-cancel-dialog' });
    expect(mount.getState().dialog.stage).toBe('closed');
    mount.dispose();
  });
});

// ════════════════════════════════════════════════════════════════
// Email send hydration — dynamic sender picker
// ════════════════════════════════════════════════════════════════

describe('D-165 P3 connections enrollment panel — email send hydration', () => {
  it('pre-warms send-capable mail options on mount', async () => {
    const { mount, calls } = mountPanel({
      connections: [],
      runMailList: async () => ({
        instances: [
          { slug: 'work-imap', send_capable: true },
          { slug: 'read-only-imap', send_capable: false },
          { slug: 'gmail-send', send_capable: true },
        ],
      }),
    });
    await mount.whenLoaded();
    await tick();

    expect(calls.runMailList).toHaveBeenCalledTimes(1);
    expect(mount.getState().dynamicOptions[MAIL_SEND_CAPABLE_INSTANCES_SOURCE]).toEqual([
      'work-imap',
      'gmail-send',
    ]);
    expect(
      mount.getState().dynamicOptions[MAIL_SEND_CAPABLE_INSTANCES_SOURCE],
    ).not.toContain('read-only-imap');
    mount.dispose();
  });

  it('re-pulls mail options when notification/email is picked and renders sender options', async () => {
    let call = 0;
    const { mount, click, getHtml, calls } = mountPanel({
      connections: [],
      runMailList: async () => {
        call += 1;
        return call === 1
          ? { instances: [{ slug: 'prewarm-only', send_capable: true }] }
          : {
              instances: [
                { slug: 'work-imap', send_capable: true },
                { slug: 'read-only-imap', send_capable: false },
                { slug: 'gmail-send', send_capable: true },
              ],
            };
      },
    });
    await mount.whenLoaded();
    await tick();

    click({ action: 'connections-open-add' });
    click({ action: 'connections-pick-kind', kind: 'notification' });
    click({ action: 'connections-pick-subtype', subtype: 'email' });
    await tick();

    expect(calls.runMailList).toHaveBeenCalledTimes(2);
    expect(mount.getState().dynamicOptions[MAIL_SEND_CAPABLE_INSTANCES_SOURCE]).toEqual([
      'work-imap',
      'gmail-send',
    ]);
    const html = getHtml();
    expect(html).toContain('data-conn-field="config.sender_mail_instance"');
    expect(html).toContain('value="work-imap"');
    expect(html).toContain('value="gmail-send"');
    expect(html).not.toContain('value="read-only-imap"');
    mount.dispose();
  });

  it('degrades to emptyGuidance and blocks submit when runMailList is absent', async () => {
    const { mount, click, field, getHtml, calls } = mountPanel({ connections: [] });
    await mount.whenLoaded();

    click({ action: 'connections-open-add' });
    click({ action: 'connections-pick-kind', kind: 'notification' });
    click({ action: 'connections-pick-subtype', subtype: 'email' });

    expect(calls.runMailList).not.toHaveBeenCalled();
    expect(mount.getState().dialog.stage).toBe('form');
    expect(getHtml()).toContain('No send-capable mail accounts');

    field('name', 'newsletter');
    field('display_name', 'Newsletter');
    click({ action: 'connections-submit-form' });
    await tick();

    expect(calls.runEnroll).not.toHaveBeenCalled();
    expect(mount.getState().dialog.error).toContain('No send-capable mail accounts');
    mount.dispose();
  });

  it('treats mail.list rejection as best-effort and retains the last-known-good list', async () => {
    let call = 0;
    const { mount, click, getHtml, calls } = mountPanel({
      connections: [],
      runMailList: async () => {
        call += 1;
        if (call === 1) {
          return { instances: [{ slug: 'work-imap', send_capable: true }] };
        }
        throw new Error('mail list down');
      },
    });
    await mount.whenLoaded();
    await tick();
    expect(mount.getState().dynamicOptions[MAIL_SEND_CAPABLE_INSTANCES_SOURCE]).toEqual([
      'work-imap',
    ]);

    click({ action: 'connections-open-add' });
    click({ action: 'connections-pick-kind', kind: 'notification' });
    click({ action: 'connections-pick-subtype', subtype: 'email' });
    await tick();

    expect(calls.runMailList).toHaveBeenCalledTimes(2);
    expect(mount.getState().error).toBeNull();
    expect(mount.getState().dynamicOptions[MAIL_SEND_CAPABLE_INSTANCES_SOURCE]).toEqual([
      'work-imap',
    ]);
    expect(getHtml()).toContain('value="work-imap"');
    expect(getHtml()).not.toContain('No send-capable mail accounts');
    mount.dispose();
  });

  it('leaves the sender source empty after a mail.list rejection with no prior success', async () => {
    const { mount, click, getHtml, calls } = mountPanel({
      connections: [],
      runMailList: async () => {
        throw new Error('mail list down');
      },
    });
    await mount.whenLoaded();
    await tick();

    expect(calls.runMailList).toHaveBeenCalledTimes(1);
    expect(mount.getState().error).toBeNull();
    expect(
      mount.getState().dynamicOptions[MAIL_SEND_CAPABLE_INSTANCES_SOURCE] ?? [],
    ).toEqual([]);

    click({ action: 'connections-open-add' });
    click({ action: 'connections-pick-kind', kind: 'notification' });
    click({ action: 'connections-pick-subtype', subtype: 'email' });
    await tick();

    expect(calls.runMailList).toHaveBeenCalledTimes(2);
    expect(mount.getState().error).toBeNull();
    expect(
      mount.getState().dynamicOptions[MAIL_SEND_CAPABLE_INSTANCES_SOURCE] ?? [],
    ).toEqual([]);
    expect(getHtml()).toContain('No send-capable mail accounts');
    mount.dispose();
  });

  it('lets the later-started overlapping hydration win', async () => {
    type MailListResult = Awaited<ReturnType<ConnectionsMailListCaller>>;
    const slowMount = deferred<MailListResult>();
    const fastPick = deferred<MailListResult>();
    let call = 0;
    const { mount, click, getHtml, calls } = mountPanel({
      connections: [],
      runMailList: () => {
        call += 1;
        return call === 1 ? slowMount.promise : fastPick.promise;
      },
    });
    await mount.whenLoaded();
    expect(calls.runMailList).toHaveBeenCalledTimes(1);

    click({ action: 'connections-open-add' });
    click({ action: 'connections-pick-kind', kind: 'notification' });
    click({ action: 'connections-pick-subtype', subtype: 'email' });
    expect(calls.runMailList).toHaveBeenCalledTimes(2);

    fastPick.resolve({
      instances: [{ slug: 'fast-newer', send_capable: true }],
    });
    await tick();
    expect(mount.getState().dynamicOptions[MAIL_SEND_CAPABLE_INSTANCES_SOURCE]).toEqual([
      'fast-newer',
    ]);
    expect(getHtml()).toContain('value="fast-newer"');

    slowMount.resolve({
      instances: [{ slug: 'slow-stale', send_capable: true }],
    });
    await tick();

    expect(mount.getState().dynamicOptions[MAIL_SEND_CAPABLE_INSTANCES_SOURCE]).toEqual([
      'fast-newer',
    ]);
    expect(getHtml()).toContain('value="fast-newer"');
    expect(getHtml()).not.toContain('value="slow-stale"');
    mount.dispose();
  });

  it('clears a selected sender when refresh drops it from the live list', async () => {
    let call = 0;
    const { mount, click, field, getHtml } = mountPanel({
      connections: [],
      runMailList: async () => {
        call += 1;
        return call < 3
          ? {
              instances: [
                { slug: 'keep-imap', send_capable: true },
                { slug: 'drop-imap', send_capable: true },
              ],
            }
          : { instances: [{ slug: 'keep-imap', send_capable: true }] };
      },
    });
    await mount.whenLoaded();
    await tick();

    click({ action: 'connections-open-add' });
    click({ action: 'connections-pick-kind', kind: 'notification' });
    click({ action: 'connections-pick-subtype', subtype: 'email' });
    await tick();
    field('config.sender_mail_instance', 'drop-imap', 'SELECT');
    expect(mount.getState().dialog.values['config.sender_mail_instance']).toBe('drop-imap');

    await mount.refresh();
    await tick();

    expect(mount.getState().dynamicOptions[MAIL_SEND_CAPABLE_INSTANCES_SOURCE]).toEqual([
      'keep-imap',
    ]);
    expect(mount.getState().dialog.values['config.sender_mail_instance']).toBe('');
    expect(getHtml()).toContain('value="keep-imap"');
    expect(getHtml()).not.toContain('value="drop-imap"');
    mount.dispose();
  });

  it('re-hydrates mail options when editing an enrolled notification/email connection', async () => {
    let call = 0;
    const { mount, click, getHtml, calls } = mountPanel({
      connections: [
        connection('newsletter', {
          kind: 'notification',
          subtype: 'email',
          display_name: 'Newsletter',
          sender_mail_instance: 'old-imap',
        }),
      ],
      runMailList: async () => {
        call += 1;
        return call === 1
          ? { instances: [] }
          : { instances: [{ slug: 'edit-imap', send_capable: true }] };
      },
    });
    await mount.whenLoaded();
    await tick();

    click({ action: 'connections-edit', kind: 'notification', name: 'newsletter' });
    await tick();

    expect(calls.runMailList).toHaveBeenCalledTimes(2);
    expect(mount.getState().dialog.mode).toBe('edit');
    expect(mount.getState().dialog.kind).toBe('notification');
    expect(mount.getState().dialog.subtype).toBe('email');
    expect(mount.getState().dynamicOptions[MAIL_SEND_CAPABLE_INSTANCES_SOURCE]).toEqual([
      'edit-imap',
    ]);
    expect(getHtml()).toContain('value="edit-imap"');
    mount.dispose();
  });

  it('public refresh re-pulls mail options', async () => {
    let call = 0;
    const { mount, calls } = mountPanel({
      connections: [],
      runMailList: async () => {
        call += 1;
        return call === 1
          ? { instances: [{ slug: 'prewarm-imap', send_capable: true }] }
          : { instances: [{ slug: 'refresh-imap', send_capable: true }] };
      },
    });
    await mount.whenLoaded();
    await tick();
    expect(mount.getState().dynamicOptions[MAIL_SEND_CAPABLE_INSTANCES_SOURCE]).toEqual([
      'prewarm-imap',
    ]);

    await mount.refresh();
    await tick();

    expect(calls.runMailList).toHaveBeenCalledTimes(2);
    expect(mount.getState().dynamicOptions[MAIL_SEND_CAPABLE_INSTANCES_SOURCE]).toEqual([
      'refresh-imap',
    ]);
    mount.dispose();
  });
});

// ════════════════════════════════════════════════════════════════
// Field capture + submit (enroll / update)
// ════════════════════════════════════════════════════════════════

describe('D-165 P3 connections enrollment panel — submit', () => {
  it('captures silent field edits + enrolls with the projected payload', async () => {
    const { mount, click, field, calls } = mountPanel({ connections: [] });
    await mount.whenLoaded();

    click({ action: 'connections-open-add' });
    click({ action: 'connections-pick-kind', kind: 'api' });
    field('name', 'my-api');
    field('display_name', 'My API');
    field('config.base_url', 'https://api.example.com');
    field('auth.token', 'secret-123');

    // Silent edits — values captured, dialog still on the form.
    expect(mount.getState().dialog.values.name).toBe('my-api');
    expect(mount.getState().dialog.stage).toBe('form');

    click({ action: 'connections-submit-form' });
    await tick();

    expect(calls.runEnroll).toHaveBeenCalledTimes(1);
    const payload = calls.runEnroll.mock.calls[0]![0];
    expect(payload.name).toBe('my-api');
    expect(payload.kind).toBe('api');
    expect(payload.display_name).toBe('My API');
    expect(payload.config).toMatchObject({ base_url: 'https://api.example.com' });
    expect(payload.auth).toMatchObject({ type: 'bearer', token: 'secret-123' });

    // Dialog closed; the post-save probe banner is retained.
    expect(mount.getState().dialog.stage).toBe('closed');
    expect(mount.getState().dialog.recentProbe).toMatchObject({
      kind: 'api',
      name: 'my-api',
      status: 'ok',
    });
    // Re-listed after the write.
    expect(calls.runList).toHaveBeenCalledTimes(2);
    mount.dispose();
  });

  it('blocks submit + surfaces an inline error when the form is invalid', async () => {
    const { mount, click, calls } = mountPanel({ connections: [] });
    await mount.whenLoaded();

    click({ action: 'connections-open-add' });
    click({ action: 'connections-pick-kind', kind: 'api' });
    // No name / display_name / base_url / token filled.
    click({ action: 'connections-submit-form' });
    await tick();

    expect(calls.runEnroll).not.toHaveBeenCalled();
    expect(mount.getState().dialog.error).not.toBeNull();
    expect(mount.getState().dialog.stage).toBe('form');
    mount.dispose();
  });

  it('a select edit re-renders to reveal conditional auth fields', async () => {
    const { mount, click, field, getHtml } = mountPanel({ connections: [] });
    await mount.whenLoaded();

    click({ action: 'connections-open-add' });
    click({ action: 'connections-pick-kind', kind: 'api' });
    field('auth.type', 'basic', 'SELECT');

    expect(mount.getState().dialog.values['auth.type']).toBe('basic');
    // Basic auth reveals username / password fields.
    expect(getHtml()).toContain('Username');
    expect(getHtml()).toContain('Password');
    mount.dispose();
  });

  it('cosmetic submit-sync enables the button once required fields are filled', async () => {
    const { mount, click, field, submitBtn } = mountPanel({ connections: [] });
    await mount.whenLoaded();

    click({ action: 'connections-open-add' });
    click({ action: 'connections-pick-kind', kind: 'api' });
    // The renderer disabled Submit (invalid). Fill all required fields —
    // each silent edit re-syncs the button.
    field('name', 'ok-api');
    field('display_name', 'OK API');
    field('config.base_url', 'https://api.example.com');
    field('auth.token', 'tok');
    expect(submitBtn.hasAttribute('disabled')).toBe(false);

    // Clearing a required field re-disables it.
    field('auth.token', '');
    expect(submitBtn.hasAttribute('disabled')).toBe(true);
    mount.dispose();
  });

  it('edit mode opens a prefilled form + patches via update (no auth re-send)', async () => {
    const { mount, click, field, calls } = mountPanel({
      connections: [
        connection('my-api', {
          display_name: 'My API',
          base_url: 'https://api.example.com',
        }),
      ],
    });
    await mount.whenLoaded();

    click({ action: 'connections-edit', kind: 'api', name: 'my-api' });
    const dialog = mount.getState().dialog;
    expect(dialog.mode).toBe('edit');
    expect(dialog.stage).toBe('form');
    expect(dialog.values.name).toBe('my-api');
    expect(dialog.values.display_name).toBe('My API');

    field('display_name', 'My API (renamed)');
    click({ action: 'connections-submit-form' });
    await tick();

    expect(calls.runUpdate).toHaveBeenCalledTimes(1);
    const updateArgs = calls.runUpdate.mock.calls[0]![0];
    expect(updateArgs.name).toBe('my-api');
    expect(updateArgs.kind).toBe('api');
    expect(updateArgs.patch.display_name).toBe('My API (renamed)');
    // No fresh credential typed → auth is NOT re-sent.
    expect(updateArgs.patch.auth).toBeUndefined();
    expect(calls.runEnroll).not.toHaveBeenCalled();
    expect(mount.getState().dialog.stage).toBe('closed');
    mount.dispose();
  });

  it('re-derives the Salesforce OAuth endpoint when the sandbox toggle flips', async () => {
    const { mount, click, field, calls } = mountPanel({ connections: [] });
    await mount.whenLoaded();

    click({ action: 'connections-open-add' });
    click({ action: 'connections-pick-vendor', vendor: 'salesforce' });
    // Seeded to the PRODUCTION endpoint…
    expect(mount.getState().dialog.values['auth.token_endpoint']).toBe(
      SALESFORCE_OAUTH_TOKEN_URL_PRODUCTION,
    );
    // …flip the sandbox toggle (a SELECT change) → endpoint re-derives.
    field('config.sandbox', 'sandbox', 'SELECT');
    expect(mount.getState().dialog.values['auth.token_endpoint']).toBe(
      SALESFORCE_OAUTH_TOKEN_URL_SANDBOX,
    );

    field('name', 'sf-sandbox');
    field('display_name', 'SF Sandbox');
    field('auth.client_id', 'cid');
    field('auth.client_secret', 'csecret');
    field('auth.refresh_token', 'rtok');
    click({ action: 'connections-submit-form' });
    await tick();

    expect(calls.runEnroll).toHaveBeenCalledTimes(1);
    const payload = calls.runEnroll.mock.calls[0]![0];
    // The sandbox endpoint — NOT the seeded production one — reaches enroll.
    expect(payload.auth).toMatchObject({
      token_endpoint: SALESFORCE_OAUTH_TOKEN_URL_SANDBOX,
    });
    expect(payload.config).toMatchObject({ vendor: 'salesforce', sandbox: 'sandbox' });
    mount.dispose();
  });

  it('a stale submit completion after cancel + reopen does not clobber the newer dialog', async () => {
    const enroll = deferred<{ connection: ConnectionView; probe?: ConnectionHealth }>();
    const { mount, click, field, calls } = mountPanel({
      connections: [],
      runEnroll: () => enroll.promise,
    });
    await mount.whenLoaded();

    click({ action: 'connections-open-add' });
    click({ action: 'connections-pick-kind', kind: 'api' });
    field('name', 'slow');
    field('display_name', 'Slow');
    field('config.base_url', 'https://api.example.com');
    field('auth.token', 'tok');
    click({ action: 'connections-submit-form' });
    await tick(2);
    expect(mount.getState().dialog.saving).toBe(true);

    // User abandons the slow save + starts a different connection.
    click({ action: 'connections-cancel-dialog' });
    expect(mount.getState().dialog.stage).toBe('closed');
    click({ action: 'connections-open-add' });
    click({ action: 'connections-pick-kind', kind: 'mcp' });
    expect(mount.getState().dialog.stage).toBe('subtype-picker');

    // The slow enroll finally resolves — it must be treated as stale.
    enroll.resolve({ connection: connection('slow'), probe: { status: 'ok' } });
    await tick();

    // The newer dialog is intact (not reset to closed), no stale probe banner,
    // and the stale completion did NOT trigger a re-list.
    expect(mount.getState().dialog.stage).toBe('subtype-picker');
    expect(mount.getState().dialog.recentProbe).toBeNull();
    expect(calls.runList).toHaveBeenCalledTimes(1);
    mount.dispose();
  });

  it('Back during an in-flight save clears saving + does not wedge later submits', async () => {
    const enroll = deferred<{ connection: ConnectionView; probe?: ConnectionHealth }>();
    const { mount, click, field, calls } = mountPanel({
      connections: [],
      runEnroll: () => enroll.promise,
    });
    await mount.whenLoaded();

    click({ action: 'connections-open-add' });
    click({ action: 'connections-pick-kind', kind: 'api' });
    field('name', 'first');
    field('display_name', 'First');
    field('config.base_url', 'https://api.example.com');
    field('auth.token', 'tok');
    click({ action: 'connections-submit-form' });
    await tick(2);
    expect(mount.getState().dialog.saving).toBe(true);

    // Back out mid-save — saving must clear (else the next form wedges).
    click({ action: 'connections-back-to-kind' });
    expect(mount.getState().dialog.saving).toBe(false);
    expect(mount.getState().dialog.stage).toBe('kind-picker');

    enroll.resolve({ connection: connection('first') });
    await tick();

    // Not wedged — a fresh enrollment still goes through.
    click({ action: 'connections-pick-kind', kind: 'api' });
    field('name', 'second');
    field('display_name', 'Second');
    field('config.base_url', 'https://api.example.com');
    field('auth.token', 'tok2');
    click({ action: 'connections-submit-form' });
    await tick();

    expect(calls.runEnroll).toHaveBeenCalledTimes(2);
    expect(calls.runEnroll.mock.calls[1]![0].name).toBe('second');
    mount.dispose();
  });

  it('blocks a concurrent submit while a prior write rpc is still settling', async () => {
    const enroll = deferred<{ connection: ConnectionView; probe?: ConnectionHealth }>();
    const { mount, click, field, calls } = mountPanel({
      connections: [],
      runEnroll: () => enroll.promise,
    });
    await mount.whenLoaded();

    click({ action: 'connections-open-add' });
    click({ action: 'connections-pick-kind', kind: 'api' });
    field('name', 'first');
    field('display_name', 'First');
    field('config.base_url', 'https://api.example.com');
    field('auth.token', 'tok');
    click({ action: 'connections-submit-form' });
    await tick(2);
    expect(calls.runEnroll).toHaveBeenCalledTimes(1);

    // Back out (clears dialog.saving) + start a second connection + submit
    // while the first rpc is still in flight — the cross-navigation lock holds.
    click({ action: 'connections-back-to-kind' });
    click({ action: 'connections-pick-kind', kind: 'api' });
    field('name', 'second');
    field('display_name', 'Second');
    field('config.base_url', 'https://api.example.com');
    field('auth.token', 'tok2');
    click({ action: 'connections-submit-form' });
    await tick(2);
    expect(calls.runEnroll).toHaveBeenCalledTimes(1); // still blocked

    // First settles → lock releases → the second submit now goes through.
    enroll.resolve({ connection: connection('first') });
    await tick();
    click({ action: 'connections-submit-form' });
    await tick();
    expect(calls.runEnroll).toHaveBeenCalledTimes(2);
    expect(calls.runEnroll.mock.calls[1]![0].name).toBe('second');
    mount.dispose();
  });

  it('locks the rendered form controls while a save is in flight', async () => {
    const enroll = deferred<{ connection: ConnectionView; probe?: ConnectionHealth }>();
    const { mount, click, field, getHtml } = mountPanel({
      connections: [],
      runEnroll: () => enroll.promise,
    });
    await mount.whenLoaded();

    click({ action: 'connections-open-add' });
    click({ action: 'connections-pick-kind', kind: 'api' });
    field('name', 'x');
    field('display_name', 'X');
    field('config.base_url', 'https://api.example.com');
    field('auth.token', 'tok');
    // Editable before submit (create-mode api form has no readonly fields).
    expect(getHtml()).not.toContain('readonly');

    click({ action: 'connections-submit-form' });
    await tick(2);
    expect(mount.getState().dialog.saving).toBe(true);
    // While committing, the renderer locks every control (readonly text inputs)
    // so the user can't type into a form the rpc already captured.
    expect(getHtml()).toContain('readonly');

    enroll.resolve({ connection: connection('x') });
    await tick();
    mount.dispose();
  });

  it('ignores field edits while a save is in flight', async () => {
    const enroll = deferred<{ connection: ConnectionView; probe?: ConnectionHealth }>();
    const { mount, click, field } = mountPanel({
      connections: [],
      runEnroll: () => enroll.promise,
    });
    await mount.whenLoaded();

    click({ action: 'connections-open-add' });
    click({ action: 'connections-pick-kind', kind: 'api' });
    field('name', 'orig');
    field('display_name', 'Orig');
    field('config.base_url', 'https://api.example.com');
    field('auth.token', 'tok');
    click({ action: 'connections-submit-form' });
    await tick(2);
    expect(mount.getState().dialog.saving).toBe(true);

    // An edit mid-save is dropped (the rpc already carries the submitted value).
    field('display_name', 'CHANGED');
    expect(mount.getState().dialog.values.display_name).toBe('Orig');

    enroll.resolve({ connection: connection('orig') });
    await tick();
    expect(mount.getState().dialog.stage).toBe('closed');
    mount.dispose();
  });

  it('surfaces an enroll rpc failure inline + keeps the form open', async () => {
    const { mount, click, field } = mountPanel({
      connections: [],
      runEnroll: async () => {
        throw new Error('enroll rejected');
      },
    });
    await mount.whenLoaded();

    click({ action: 'connections-open-add' });
    click({ action: 'connections-pick-kind', kind: 'api' });
    field('name', 'my-api');
    field('display_name', 'My API');
    field('config.base_url', 'https://api.example.com');
    field('auth.token', 'secret-123');
    click({ action: 'connections-submit-form' });
    await tick();

    expect(mount.getState().dialog.error).toBe('enroll rejected');
    expect(mount.getState().dialog.saving).toBe(false);
    expect(mount.getState().dialog.stage).toBe('form');
    mount.dispose();
  });
});

// ════════════════════════════════════════════════════════════════
// Row actions: probe / delete
// ════════════════════════════════════════════════════════════════

describe('D-165 P3 connections enrollment panel — row actions', () => {
  it('probe writes the recent-probe banner from the health status', async () => {
    const { mount, click, calls } = mountPanel({
      connections: [connection('my-api')],
      runProbe: async () => ({ health: { status: 'auth_failed' } as ConnectionHealth }),
    });
    await mount.whenLoaded();

    click({ action: 'connections-probe', kind: 'api', name: 'my-api' });
    await tick();

    expect(calls.runProbe).toHaveBeenCalledWith({ name: 'my-api', kind: 'api' });
    expect(mount.getState().dialog.recentProbe).toMatchObject({
      kind: 'api',
      name: 'my-api',
      status: 'auth_failed',
    });
    expect(mount.getState().probeInFlight.size).toBe(0);
    mount.dispose();
  });

  it('delete removes the row by re-listing', async () => {
    const remaining = [connection('keep')];
    const { mount, click, calls } = mountPanel({
      connections: [connection('drop'), connection('keep')],
      runList: vi
        .fn<ConnectionsEnrollListCaller>()
        .mockResolvedValueOnce({ connections: [connection('drop'), connection('keep')] })
        .mockResolvedValueOnce({ connections: remaining }),
    });
    await mount.whenLoaded();
    expect(mount.getState().connections).toHaveLength(2);

    // D-192 slice 5 — Delete now opens a confirm dialog; Remove runs the delete.
    click({ action: 'connections-delete', kind: 'api', name: 'drop' });
    await tick();
    expect(calls.runDelete).not.toHaveBeenCalled(); // confirm open, nothing deleted yet
    click({ action: 'connections-delete-confirm', kind: 'api', name: 'drop' });
    await tick();

    // No previewPurge wired here → no opt-in checkbox → mirror kept (false).
    expect(calls.runDelete).toHaveBeenCalledWith({ name: 'drop', kind: 'api', remove_mirror_data: false });
    expect(mount.getState().connections.map((c) => c.name)).toEqual(['keep']);
    expect(mount.getState().deleteInFlight.size).toBe(0);
    expect(mount.getState().deleteConfirm).toBeNull(); // confirm closed after delete
    mount.dispose();
  });
});

// ════════════════════════════════════════════════════════════════
// Optional affordances (honest, not dead)
// ════════════════════════════════════════════════════════════════

describe('D-165 P3 connections enrollment panel — optional affordances', () => {
  it('authorize-vendor surfaces an honest oauthError pointing at manual entry', async () => {
    const { mount, click, field, getHtml } = mountPanel({ connections: [] });
    await mount.whenLoaded();

    click({ action: 'connections-open-add' });
    click({ action: 'connections-pick-vendor', vendor: 'hubspot' });
    // ⚠ REQUIRED, and its absence is what made this test red. Picking a vendor
    // seeds `auth.type: 'bearer'` (asserted above — HubSpot's default became a
    // Service Key), and `renderVendorOAuth` returns '' for anything that is not
    // an `oauth2_refresh` flow. So the whole OAuth block — button AND error —
    // was correctly absent, and the synthetic click was driving a control the
    // user cannot reach. Select the refresh flow first, exactly as the
    // generic-vendor oauth tests below do.
    field('auth.type', 'oauth2_refresh', 'SELECT');
    click({ action: 'connections-authorize-vendor', vendor: 'hubspot' });

    // Both halves matter and they are not the same claim: the first says the
    // handler produced an honest error, the second says the user can actually
    // SEE it. An error that only reaches state is an error nobody reads.
    expect(mount.getState().dialog.oauthError).toContain('Paste a refresh token');
    expect(getHtml()).toContain('Paste a refresh token');
    mount.dispose();
  });

  it('engagement-toggle expands an honest error panel when the health caller is absent', async () => {
    const { mount, click, getHtml } = mountPanel({
      connections: [connection('hub', { vendor: 'hubspot' })],
    });
    await mount.whenLoaded();

    click({ action: 'connections-engagement-toggle', kind: 'api', name: 'hub' });
    expect(mount.getState().engagementHealth.expanded.has('api/hub')).toBe(true);
    expect(mount.getState().engagementHealth.error['api/hub']).toContain(
      'D-139 health caller is not wired',
    );
    expect(getHtml()).toContain('D-139 health caller is not wired');

    click({ action: 'connections-engagement-toggle', kind: 'api', name: 'hub' });
    expect(mount.getState().engagementHealth.expanded.has('api/hub')).toBe(false);
    expect(mount.getState().engagementHealth.error['api/hub']).toBeUndefined();
    mount.dispose();
  });

  it('engagement-toggle hydrates the D-139 health rpc on first expand and reuses cached data', async () => {
    const health = deferred<EngagementHealthResponse>();
    const { mount, click, getHtml, calls } = mountPanel({
      connections: [connection('hub', { vendor: 'hubspot' })],
      runEngagementHealth: () => health.promise,
    });
    await mount.whenLoaded();

    click({ action: 'connections-engagement-toggle', kind: 'api', name: 'hub' });
    expect(calls.runEngagementHealth).toHaveBeenCalledWith({ name: 'hub' });
    expect(mount.getState().engagementHealth.loading.has('api/hub')).toBe(true);
    expect(getHtml()).toContain('Loading engagement health');

    health.resolve(hubspotHealth());
    await tick();

    expect(mount.getState().engagementHealth.loading.has('api/hub')).toBe(false);
    expect(mount.getState().engagementHealth.data['api/hub']?.vendor).toBe('hubspot');
    expect(getHtml()).toContain('HubSpot engagement health');
    expect(getHtml()).toContain('data-entity="email"');

    click({ action: 'connections-engagement-toggle', kind: 'api', name: 'hub' });
    click({ action: 'connections-engagement-toggle', kind: 'api', name: 'hub' });
    expect(calls.runEngagementHealth).toHaveBeenCalledTimes(1);
    expect(getHtml()).toContain('HubSpot engagement health');
    mount.dispose();
  });

  it('Salesforce re-probe patches refreshed rows and last PushTopic status', async () => {
    const reprobe = deferred<ReprobeEngagementCapabilitiesResponse>();
    const { mount, click, getHtml, calls } = mountPanel({
      connections: [connection('sf', { vendor: 'salesforce' })],
      runEngagementHealth: async () => salesforceHealth(),
      runReprobeEngagementCapabilities: () => reprobe.promise,
    });
    await mount.whenLoaded();
    click({ action: 'connections-engagement-toggle', kind: 'api', name: 'sf' });
    await tick();

    click({ action: 'connections-engagement-reprobe', name: 'sf' });
    expect(calls.runReprobeEngagementCapabilities).toHaveBeenCalledWith({ name: 'sf' });
    expect(mount.getState().engagementHealth.reprobing.has('api/sf')).toBe(true);
    expect(getHtml()).toContain('Re-probing Salesforce capabilities');

    reprobe.resolve(salesforceReprobe());
    await tick();

    expect(mount.getState().engagementHealth.reprobing.has('api/sf')).toBe(false);
    expect(mount.getState().engagementHealth.lastReprobe['api/sf']?.winning_call_entity).toBe(
      'voice_call',
    );
    expect(mount.getState().engagementHealth.data['api/sf']?.rows[0]?.entity).toBe(
      'voice_call',
    );
    expect(getHtml()).toContain('PushTopic auto-creation');
    expect(getHtml()).toContain('Created');
    mount.dispose();
  });

  it('Salesforce re-probe surfaces an honest error when the re-probe caller is absent', async () => {
    const { mount, click, getHtml } = mountPanel({
      connections: [connection('sf', { vendor: 'salesforce' })],
      runEngagementHealth: async () => salesforceHealth(),
    });
    await mount.whenLoaded();
    click({ action: 'connections-engagement-toggle', kind: 'api', name: 'sf' });
    await tick();

    click({ action: 'connections-engagement-reprobe', name: 'sf' });

    expect(mount.getState().engagementHealth.error['api/sf']).toContain(
      'D-139 re-probe caller is not wired',
    );
    expect(getHtml()).toContain('D-139 re-probe caller is not wired');
    mount.dispose();
  });

  it('non-rpc engagement panel affordances surface bounded inline guidance', async () => {
    const { mount, click, getHtml } = mountPanel({
      connections: [connection('hub', { vendor: 'hubspot' })],
      runEngagementHealth: async () => hubspotHealth(),
    });
    await mount.whenLoaded();
    click({ action: 'connections-engagement-toggle', kind: 'api', name: 'hub' });
    await tick();

    click({ action: 'connections-engagement-install-puller', name: 'hub', vendor: 'hubspot' });
    expect(getHtml()).toContain('Install the CRM engagement pack from Packs');

    click({ action: 'connections-engagement-configure-cadence', name: 'hub', vendor: 'hubspot' });
    expect(getHtml()).toContain('Use the Server housekeeping settings');
    mount.dispose();
  });
});

// ════════════════════════════════════════════════════════════════
// Dispose
// ════════════════════════════════════════════════════════════════

describe('D-165 P3 connections enrollment panel — dispose', () => {
  it('detaches listeners, clears the host, is idempotent, ignores late rpc', async () => {
    const list = deferred<{ connections: ReadonlyArray<ConnectionView> }>();
    const { mount, getHtml, listenerCount, calls } = mountPanel({
      runList: () => list.promise,
    });
    expect(listenerCount()).toBeGreaterThan(0);

    mount.dispose();
    expect(getHtml()).toBe('');
    expect(listenerCount()).toBe(0);
    expect(() => mount.dispose()).not.toThrow();

    // A late list resolution after dispose must not re-render.
    list.resolve({ connections: [connection('late')] });
    await mount.whenLoaded();
    await tick();
    expect(getHtml()).toBe('');
    expect(calls.runEnroll).not.toHaveBeenCalled();
  });
});


// ════════════════════════════════════════════════════════════════
// Vendor OAuth popup (D-165 slice 3)
// ════════════════════════════════════════════════════════════════

describe('D-165 slice 3 connections enrollment panel — vendor OAuth popup', () => {
  const wireVendorForm = (click: (d: Record<string, string>) => void): void => {
    click({ action: 'connections-open-add' });
    click({ action: 'connections-pick-vendor', vendor: 'hubspot' });
  };

  it('runs the popup dance end-to-end and patches the claimed credential', async () => {
    const popup = makeFakePopup();
    const oauthEnv = makeFakeOAuthEnv(popup);
    const sub = makeFakeSubscribe();
    const runStart = vi.fn<ConnectionsStartVendorOAuthCaller>(async () => ({
      authorize_url: 'https://app.hubspot.com/oauth/authorize?x=1',
      flow_id: 'flow-1',
      server_identity_public_key_b64: 'pubkey-b64',
      claim_secret: 'secret-1',
    }));
    const runTake = vi.fn<ConnectionsTakeVendorOAuthResultCaller>(async () => ({
      result: {
        refresh_token: 'rt-new',
        granted_scopes: ['crm.objects.contacts.read'],
      },
    }));
    const { mount, click, field, getHtml } = mountPanel({
      connections: [],
      oauth: { env: oauthEnv.env, subscribe: sub.subscribe, runStart, runTake },
    });
    await mount.whenLoaded();

    wireVendorForm(click);
    field('auth.client_id', 'my-client-id');
    field('auth.client_secret', 'my-secret');
    click({ action: 'connections-authorize-vendor', vendor: 'hubspot' });

    // Popup opened synchronously inside the gesture; flow now in flight.
    expect(oauthEnv.env.open).toHaveBeenCalledWith('', '_blank');
    expect(mount.getState().dialog.oauthInFlight).toBe(true);

    await flushAsync(); // let driveVendorOAuth's start rpc resolve

    expect(runStart).toHaveBeenCalledWith({
      vendor: 'hubspot',
      client_id: 'my-client-id',
      client_secret: 'my-secret',
      redirect_uri: OAUTH_CLOUD_CALLBACK_URL,
      sandbox: false,
    });
    // jwks cached into the POPUP's own sessionStorage (the context the cloud
    // callback page reads), NOT the opener's; popup then navigated.
    expect(popup.popupStore.get('oauth_jwks_flow-1')).toBe('pubkey-b64');
    expect(oauthEnv.openerStore.size).toBe(0);
    expect(popup.location.href).toBe('https://app.hubspot.com/oauth/authorize?x=1');
    // Reverse-tabnabbing guard: the opener was severed BEFORE navigation, so
    // the cross-origin vendor page cannot reach back into our tab.
    expect(popup.openerAtNavigation()).toBeNull();
    expect(popup.opener).toBeNull();

    // The completion broadcast for OUR flow → claim with the stashed secret.
    sub.fire('flow-1');
    await flushAsync();

    expect(runTake).toHaveBeenCalledWith({ flow_id: 'flow-1', claim_secret: 'secret-1' });
    const dialog = mount.getState().dialog;
    expect(dialog.values['auth.refresh_token']).toBe('rt-new');
    expect(dialog.oauthGrantedScopes).toEqual(['crm.objects.contacts.read']);
    expect(dialog.oauthInFlight).toBe(false);
    expect(dialog.oauthError).toBeNull();
    expect(getHtml()).toContain('data-vendor-state="ready_after_auth"');
    expect(getHtml()).toContain('Ready for provider-side setup after Save');
    // Popup closed on settle — which destroys the popup's sessionStorage (where
    // the jwks lived), so no separate opener-side cleanup is needed.
    expect(popup.close).toHaveBeenCalled();
    mount.dispose();
  });

  // R14 — the generic `api` oauth2_refresh form (no registered vendor) runs the
  // same dance with form-supplied authorize_url + token_endpoint + scopes.
  it('runs the dance for a generic api oauth2_refresh form with form-supplied config', async () => {
    const popup = makeFakePopup();
    const oauthEnv = makeFakeOAuthEnv(popup);
    const sub = makeFakeSubscribe();
    const runStart = vi.fn<ConnectionsStartVendorOAuthCaller>(async () => ({
      authorize_url: 'https://auth.example.com/authorize?x=1',
      flow_id: 'flow-g',
      server_identity_public_key_b64: 'pk',
      claim_secret: 'sec-g',
    }));
    const runTake = vi.fn<ConnectionsTakeVendorOAuthResultCaller>(async () => ({
      result: { refresh_token: 'rt-generic', granted_scopes: ['read'] },
    }));
    const { mount, click, field } = mountPanel({
      connections: [],
      oauth: { env: oauthEnv.env, subscribe: sub.subscribe, runStart, runTake },
    });
    await mount.whenLoaded();

    click({ action: 'connections-open-add' });
    click({ action: 'connections-pick-kind', kind: 'api' });
    field('auth.type', 'oauth2_refresh', 'SELECT'); // reveal the oauth fields
    field('name', 'my-thing');
    field('auth.client_id', 'cid');
    field('auth.authorize_url', 'https://auth.example.com/authorize');
    field('auth.token_endpoint', 'https://auth.example.com/token');
    field('auth.scopes', 'read write');
    click({ action: 'connections-authorize-vendor' }); // NO vendor

    expect(oauthEnv.env.open).toHaveBeenCalledWith('', '_blank');
    await flushAsync();

    // The generic flow labels the OAuth flow with the sentinel, NOT the typed
    // connection name (which could collide with a registered vendor slug).
    expect(runStart).toHaveBeenCalledWith({
      vendor: 'custom',
      client_id: 'cid',
      redirect_uri: OAUTH_CLOUD_CALLBACK_URL,
      sandbox: false,
      authorize_url: 'https://auth.example.com/authorize',
      token_endpoint: 'https://auth.example.com/token',
      scopes: ['read', 'write'],
    });

    sub.fire('flow-g');
    await flushAsync();
    expect(runTake).toHaveBeenCalledWith({ flow_id: 'flow-g', claim_secret: 'sec-g' });
    expect(mount.getState().dialog.values['auth.refresh_token']).toBe('rt-generic');
    mount.dispose();
  });

  it('a generic oauth form without authorize_url + token_endpoint surfaces an error and never starts', async () => {
    const popup = makeFakePopup();
    const oauthEnv = makeFakeOAuthEnv(popup);
    const sub = makeFakeSubscribe();
    const runStart = vi.fn<ConnectionsStartVendorOAuthCaller>();
    const runTake = vi.fn<ConnectionsTakeVendorOAuthResultCaller>();
    const { mount, click, field } = mountPanel({
      connections: [],
      oauth: { env: oauthEnv.env, subscribe: sub.subscribe, runStart, runTake },
    });
    await mount.whenLoaded();

    click({ action: 'connections-open-add' });
    click({ action: 'connections-pick-kind', kind: 'api' });
    field('auth.type', 'oauth2_refresh', 'SELECT');
    field('auth.client_id', 'cid'); // but no authorize_url / token_endpoint
    click({ action: 'connections-authorize-vendor' });

    expect(runStart).not.toHaveBeenCalled();
    expect(oauthEnv.env.open).not.toHaveBeenCalled();
    expect(mount.getState().dialog.oauthError).toMatch(/Authorize URL and Token Endpoint/);
    mount.dispose();
  });

  it('owner-binding: a completion broadcast for a FOREIGN flow_id never claims', async () => {
    const popup = makeFakePopup();
    const oauthEnv = makeFakeOAuthEnv(popup);
    const sub = makeFakeSubscribe();
    const runStart = vi.fn<ConnectionsStartVendorOAuthCaller>(async () => ({
      authorize_url: 'https://app.hubspot.com/oauth/authorize',
      flow_id: 'flow-mine',
      server_identity_public_key_b64: 'pk',
      claim_secret: 'secret-mine',
    }));
    const runTake = vi.fn<ConnectionsTakeVendorOAuthResultCaller>(async () => ({
      result: null,
    }));
    const { mount, click, field } = mountPanel({
      connections: [],
      oauth: { env: oauthEnv.env, subscribe: sub.subscribe, runStart, runTake },
    });
    await mount.whenLoaded();

    wireVendorForm(click);
    field('auth.client_id', 'cid');
    click({ action: 'connections-authorize-vendor', vendor: 'hubspot' });
    await flushAsync();

    // A different client's flow completes — we must NOT claim it.
    sub.fire('flow-other');
    await flushAsync();
    expect(runTake).not.toHaveBeenCalled();
    expect(mount.getState().dialog.oauthInFlight).toBe(true); // still waiting on ours
    mount.dispose();
  });

  it('surfaces popup-blocked without calling the start rpc', async () => {
    const oauthEnv = makeFakeOAuthEnv(null); // window.open → null
    const sub = makeFakeSubscribe();
    const runStart = vi.fn<ConnectionsStartVendorOAuthCaller>();
    const runTake = vi.fn<ConnectionsTakeVendorOAuthResultCaller>();
    const { mount, click, field } = mountPanel({
      connections: [],
      oauth: { env: oauthEnv.env, subscribe: sub.subscribe, runStart, runTake },
    });
    await mount.whenLoaded();

    wireVendorForm(click);
    field('auth.client_id', 'cid');
    click({ action: 'connections-authorize-vendor', vendor: 'hubspot' });
    await flushAsync();

    expect(runStart).not.toHaveBeenCalled();
    expect(mount.getState().dialog.oauthError).toContain('Popup blocked');
    expect(mount.getState().dialog.oauthInFlight).toBe(false);
    mount.dispose();
  });

  it('requires a client_id before opening the popup', async () => {
    const popup = makeFakePopup();
    const oauthEnv = makeFakeOAuthEnv(popup);
    const sub = makeFakeSubscribe();
    const { mount, click } = mountPanel({
      connections: [],
      oauth: {
        env: oauthEnv.env,
        subscribe: sub.subscribe,
        runStart: vi.fn<ConnectionsStartVendorOAuthCaller>(),
        runTake: vi.fn<ConnectionsTakeVendorOAuthResultCaller>(),
      },
    });
    await mount.whenLoaded();

    wireVendorForm(click);
    click({ action: 'connections-authorize-vendor', vendor: 'hubspot' });

    expect(oauthEnv.env.open).not.toHaveBeenCalled();
    expect(mount.getState().dialog.oauthError).toContain('client ID');
    mount.dispose();
  });

  it('a stale claim that resolves after timeout never patches the dialog', async () => {
    const popup = makeFakePopup();
    const oauthEnv = makeFakeOAuthEnv(popup);
    const sub = makeFakeSubscribe();
    const runStart = vi.fn<ConnectionsStartVendorOAuthCaller>(async () => ({
      authorize_url: 'https://app.hubspot.com/oauth/authorize',
      flow_id: 'flow-stale',
      server_identity_public_key_b64: 'pk',
      claim_secret: 'secret-stale',
    }));
    // runTake stays pending until we resolve it — simulating a slow claim that
    // lands AFTER the flow times out.
    const claim = deferred<Awaited<ReturnType<ConnectionsTakeVendorOAuthResultCaller>>>();
    const runTake = vi.fn<ConnectionsTakeVendorOAuthResultCaller>(() => claim.promise);
    const { mount, click, field } = mountPanel({
      connections: [],
      oauth: { env: oauthEnv.env, subscribe: sub.subscribe, runStart, runTake },
    });
    await mount.whenLoaded();

    wireVendorForm(click);
    field('auth.client_id', 'cid');
    click({ action: 'connections-authorize-vendor', vendor: 'hubspot' });
    await flushAsync();

    sub.fire('flow-stale'); // claim starts (pending)
    await flushAsync();
    expect(runTake).toHaveBeenCalledTimes(1);

    // The flow times out before the claim resolves → settled as an error.
    oauthEnv.fireTimers();
    expect(mount.getState().dialog.oauthError).toContain('timed out');
    expect(mount.getState().dialog.oauthInFlight).toBe(false);

    // The slow claim finally resolves — it MUST NOT patch the timed-out dialog.
    claim.resolve({ result: { refresh_token: 'rt-stale', granted_scopes: ['x'] } });
    await flushAsync();
    const dialog = mount.getState().dialog;
    expect(dialog.values['auth.refresh_token'] ?? '').toBe(''); // no stale token
    expect(dialog.oauthError).toContain('timed out'); // error not overwritten
    expect(dialog.oauthGrantedScopes).toBeNull();
    mount.dispose();
  });

  it('a null claim result (already consumed) leaves the flow waiting, no error', async () => {
    const popup = makeFakePopup();
    const oauthEnv = makeFakeOAuthEnv(popup);
    const sub = makeFakeSubscribe();
    const runStart = vi.fn<ConnectionsStartVendorOAuthCaller>(async () => ({
      authorize_url: 'https://app.hubspot.com/oauth/authorize',
      flow_id: 'flow-dup',
      server_identity_public_key_b64: 'pk',
      claim_secret: 'secret-dup',
    }));
    const runTake = vi.fn<ConnectionsTakeVendorOAuthResultCaller>(async () => ({
      result: null,
    }));
    const { mount, click, field } = mountPanel({
      connections: [],
      oauth: { env: oauthEnv.env, subscribe: sub.subscribe, runStart, runTake },
    });
    await mount.whenLoaded();

    wireVendorForm(click);
    field('auth.client_id', 'cid');
    click({ action: 'connections-authorize-vendor', vendor: 'hubspot' });
    await flushAsync();

    sub.fire('flow-dup');
    await flushAsync();
    expect(runTake).toHaveBeenCalledTimes(1);
    const dialog = mount.getState().dialog;
    expect(dialog.oauthError).toBeNull();
    expect(dialog.oauthInFlight).toBe(true); // still pending — the timeout covers it
    expect(dialog.values['auth.refresh_token'] ?? '').toBe('');
    mount.dispose();
  });
});

describe('multi-header auth — repeatable header-list form', () => {
  const countRows = (html: string): number =>
    (html.match(/data-header-row="/g) ?? []).length;

  // Open the api enroll form with auth.type = header (where the list renders).
  const openHeaderForm = async () => {
    const h = mountPanel({ connections: [] });
    await h.mount.whenLoaded();
    h.click({ action: 'connections-open-add' });
    h.click({ action: 'connections-pick-kind', kind: 'api' });
    h.field('auth.type', 'header', 'SELECT');
    return h;
  };

  it('shows one empty header row by default + an Add button', async () => {
    const h = await openHeaderForm();
    expect(countRows(h.getHtml())).toBe(1);
    expect(h.getHtml()).toContain('+ Add header');
    h.mount.dispose();
  });

  it('Add materializes the default row then appends → two rows', async () => {
    const h = await openHeaderForm();
    h.click({ action: 'connections-add-header', baseKey: 'auth.headers' });
    expect(countRows(h.getHtml())).toBe(2);
    h.mount.dispose();
  });

  it('Remove drops a row → back to one', async () => {
    const h = await openHeaderForm();
    h.click({ action: 'connections-add-header', baseKey: 'auth.headers' });
    expect(countRows(h.getHtml())).toBe(2);
    h.click({ action: 'connections-remove-header', baseKey: 'auth.headers', headerIndex: '1' });
    expect(countRows(h.getHtml())).toBe(1);
    h.mount.dispose();
  });

  it('caps rows at MAX_HEADER_AUTH_ENTRIES + disables Add', async () => {
    const h = await openHeaderForm();
    // More clicks than the cap; the over-cap ones are no-ops.
    for (let i = 0; i < MAX_HEADER_AUTH_ENTRIES + 3; i += 1) {
      h.click({ action: 'connections-add-header', baseKey: 'auth.headers' });
    }
    expect(countRows(h.getHtml())).toBe(MAX_HEADER_AUTH_ENTRIES);
    expect(h.getHtml()).toMatch(/connections-header-add[^>]*disabled/);
    h.mount.dispose();
  });

  it('half-filled row (name without value) blocks submit with a validation error', async () => {
    const h = await openHeaderForm();
    h.field('name', 'plaid');
    h.field('display_name', 'Plaid');
    h.field('config.base_url', 'https://production.plaid.com');
    h.field('auth.headers.0.header_name', 'X-API-Key'); // value left blank
    h.click({ action: 'connections-submit-form' });
    expect(h.mount.getState().dialog.error).toMatch(
      /each header needs both a name and a value/i,
    );
    h.mount.dispose();
  });

  it('a complete single header passes validation + projects a 1-element array', async () => {
    const h = await openHeaderForm();
    h.field('name', 'plaid');
    h.field('display_name', 'Plaid');
    h.field('config.base_url', 'https://production.plaid.com');
    h.field('auth.headers.0.header_name', 'X-API-Key');
    h.field('auth.headers.0.value', 'k');
    h.click({ action: 'connections-submit-form' });
    // No validation error → the enroll rpc fired.
    expect(h.mount.getState().dialog.error).toBeNull();
    h.mount.dispose();
  });
});
