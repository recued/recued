import { describe, expect, it, vi } from 'vitest';
import type {
  ConnectionSetupGuideRequest,
  ConnectionSetupGuideResult,
} from '@recued/ui-shared';
import {
  OPENER_RELAY_MESSAGE_KIND,
  OAUTH_OPENER_RELAY_STATE_PREFIX,
  WEBHOOK_PROFILE_REGISTRY,
  type WebhookProfileRuntimeCapabilityView,
  type ConnectionHealth,
  type ConnectionView,
  type WebhookDeliveryDetailView,
  type WebhookDeliveryListRequest,
  type WebhookDeliveryListResponse,
  type WebhookIngressView,
  type WebhookRejectedDeliveryListRequest,
  type WebhookRejectedDeliveryListResponse,
} from '@recued/contracts';

import {
  CONNECTIONS_ROUTE_CONTENT_ATTR,
  CONNECTIONS_ROUTE_ENROLL_HOST_ATTR,
  CONNECTIONS_ROUTE_GRANTS_SECTION_ATTR,
  CONNECTIONS_ROUTE_DESCRIPTION_ATTR,
  CONNECTIONS_ROUTE_HEADING_ATTR,
  CONNECTIONS_ROUTE_STYLES_MARKER,
  CONNECTIONS_ROUTE_TABS_ATTR,
  bootstrapConnectionsRoute,
  parseConnectionsCredentialRotationRetry,
  parseConnectionsPostSafeStopRecovery,
  resolveProfileBoundPostSafeStopRecovery,
  serializeConnectionsCredentialRotationRetry,
  serializeConnectionsPostSafeStopRecovery,
} from '../connections/bootstrap-connections-route.js';
import { createFoundationalOAuthContinuity } from '../connections/foundational-oauth-continuity.js';
import {
  PROVIDER_SETUP_CONTINUITY_SESSION_KEY,
  createProviderSetupContinuityStore,
} from '../connections/provider-setup-continuity.js';
import type { FoundationalOAuthEnv } from '../connections/foundational-oauth-popup.js';
import {
  WEBHOOKS_PANEL_ACTION_ATTR,
  WEBHOOKS_PANEL_ATTR,
  WEBHOOKS_PANEL_CARD_ATTR,
  WEBHOOKS_PANEL_DELIVERIES_ATTR,
  WEBHOOKS_PANEL_DELIVERY_ATTR,
  WEBHOOKS_PANEL_DEDUPLICATION_ATTR,
  WEBHOOKS_PANEL_ENVIRONMENT_ATTR,
  WEBHOOKS_PANEL_EVENT_TYPE_ATTR,
  WEBHOOKS_PANEL_EVENT_ATTR,
  WEBHOOKS_PANEL_FIELD_ATTR,
  WEBHOOKS_PANEL_FORM_ATTR,
  WEBHOOKS_PANEL_NEW_ATTR,
  WEBHOOKS_PANEL_PAYLOAD_ATTR,
  WEBHOOKS_PANEL_PAIRED_CONNECTION_ATTR,
  WEBHOOKS_PANEL_PROFILE_ATTR,
  WEBHOOKS_PANEL_REGISTRATION_MODE_ATTR,
  WEBHOOKS_PANEL_REGISTRATION_TARGET_KEY_ATTR,
  WEBHOOKS_PANEL_REGISTRATION_TARGET_KIND_ATTR,
  WEBHOOKS_PANEL_REJECTION_ATTR,
  WEBHOOKS_PANEL_REJECTIONS_ATTR,
  WEBHOOKS_PANEL_REBIND_ATTR,
  WEBHOOKS_PANEL_RETENTION_ATTR,
  WEBHOOKS_PANEL_STYLES,
  WEBHOOKS_PANEL_TEST_ATTR,
} from '../connections/webhooks-panel.js';
import {
  SETTINGS_ROUTE_CONNECTIONS_LINK_ATTR,
  SETTINGS_ROUTE_SECTION_ATTR,
  bootstrapSettingsRoute,
} from '../settings/bootstrap-settings-route.js';
import { createInMemoryWebclientLocalStore } from '../storage/local-store.js';
import type {
  ConnectionsEnrollListCaller,
} from '../settings/connections-enroll-panel.js';

interface FakeEl {
  tagName: string;
  className: string;
  textContent: string;
  type: string;
  disabled: boolean;
  checked: boolean;
  value: string;
  innerHTML: string;
  attrs: Map<string, string>;
  children: FakeEl[];
  parent: FakeEl | null;
  listeners: Map<string, Array<(ev: unknown) => void>>;
  readonly firstChild: FakeEl | null;
  setAttribute(k: string, v: string): void;
  removeAttribute(k: string): void;
  getAttribute(k: string): string | null;
  hasAttribute(k: string): boolean;
  appendChild(c: FakeEl): FakeEl;
  removeChild(c: FakeEl): FakeEl;
  addEventListener(type: string, fn: (ev: unknown) => void): void;
  removeEventListener(type: string, fn: (ev: unknown) => void): void;
  contains(el: unknown): boolean;
  querySelector(sel: string): FakeEl | null;
  click(): void;
  remove(): void;
}

interface FakeDoc {
  styleElements: FakeEl[];
  head: { querySelector(sel: string): FakeEl | null; appendChild(el: FakeEl): FakeEl };
  createElement(tag: string): FakeEl;
}

// The enroll panel + the accounts panel each disable their Submit button via
// `host.querySelector('[data-action="…submit-form"]')`. The harness returns a
// shared stub button for either selector so the imperative disabled-sync no-ops
// cleanly under the string-only DOM.
const SUBMIT_SELECTORS = new Set([
  '[data-action="connections-submit-form"]',
  '[data-action="connections-guide-review"]',
  '[data-action="accounts-submit-form"]',
]);

const makeFakeEl = (tag: string): FakeEl => {
  const submitButton: FakeEl = {
    tagName: 'BUTTON',
    className: '',
    textContent: '',
    type: '',
    disabled: false,
    checked: false,
    value: '',
    innerHTML: '',
    attrs: new Map<string, string>(),
    children: [] as FakeEl[],
    parent: null,
    listeners: new Map<string, Array<(ev: unknown) => void>>(),
    get firstChild() {
      return null;
    },
    setAttribute(k: string) {
      submitButton.attrs.set(k, '');
      if (k === 'disabled') submitButton.disabled = true;
    },
    removeAttribute(k: string) {
      submitButton.attrs.delete(k);
      if (k === 'disabled') submitButton.disabled = false;
    },
    getAttribute(k: string) {
      return submitButton.attrs.get(k) ?? null;
    },
    hasAttribute(k: string) {
      return submitButton.attrs.has(k);
    },
    appendChild(c: FakeEl) {
      submitButton.children.push(c);
      return c;
    },
    removeChild(c: FakeEl) {
      const idx = submitButton.children.indexOf(c);
      if (idx >= 0) submitButton.children.splice(idx, 1);
      return c;
    },
    addEventListener(type: string, fn: (ev: unknown) => void) {
      const list = submitButton.listeners.get(type) ?? [];
      list.push(fn);
      submitButton.listeners.set(type, list);
    },
    removeEventListener(type: string, fn: (ev: unknown) => void) {
      const list = submitButton.listeners.get(type);
      if (list === undefined) return;
      const idx = list.indexOf(fn);
      if (idx >= 0) list.splice(idx, 1);
    },
    contains() {
      return true;
    },
    querySelector() {
      return null;
    },
    click() {},
    remove() {},
  };

  const el: FakeEl = {
    tagName: tag.toUpperCase(),
    className: '',
    textContent: '',
    type: '',
    disabled: false,
    checked: false,
    value: '',
    innerHTML: '',
    attrs: new Map(),
    children: [],
    parent: null,
    listeners: new Map(),
    get firstChild() {
      return el.children[0] ?? null;
    },
    setAttribute(k, v) {
      el.attrs.set(k, v);
      if (k === 'disabled') el.disabled = true;
    },
    removeAttribute(k) {
      el.attrs.delete(k);
      if (k === 'disabled') el.disabled = false;
    },
    getAttribute(k) {
      return el.attrs.get(k) ?? null;
    },
    hasAttribute(k) {
      return el.attrs.has(k);
    },
    appendChild(c) {
      c.parent = el;
      el.children.push(c);
      return c;
    },
    removeChild(c) {
      const idx = el.children.indexOf(c);
      if (idx < 0) throw new Error('removeChild: not a child');
      el.children.splice(idx, 1);
      c.parent = null;
      return c;
    },
    addEventListener(type, fn) {
      const list = el.listeners.get(type) ?? [];
      list.push(fn);
      el.listeners.set(type, list);
    },
    removeEventListener(type, fn) {
      const list = el.listeners.get(type);
      if (list === undefined) return;
      const idx = list.indexOf(fn);
      if (idx >= 0) list.splice(idx, 1);
    },
    contains() {
      return true;
    },
    querySelector(sel) {
      return SUBMIT_SELECTORS.has(sel) ? submitButton : null;
    },
    click() {
      if (el.disabled || el.attrs.has('disabled')) return;
      for (const fn of el.listeners.get('click') ?? []) fn({ target: el });
    },
    remove() {
      if (el.parent !== null) el.parent.removeChild(el);
    },
  };
  return el;
};

const makeFakeDocument = (): FakeDoc => {
  const styleElements: FakeEl[] = [];
  const matchSelector = (sel: string): { tag: string; attr: string } | null => {
    const m = sel.match(/^([\w-]+)\[([\w-]+)\]$/);
    return m === null ? null : { tag: m[1]!.toUpperCase(), attr: m[2]! };
  };
  return {
    styleElements,
    head: {
      querySelector(sel) {
        const parsed = matchSelector(sel);
        if (parsed === null) return null;
        return (
          styleElements.find(
            (s) => s.tagName === parsed.tag && s.attrs.has(parsed.attr),
          ) ?? null
        );
      },
      appendChild(el) {
        styleElements.push(el);
        return el;
      },
    },
    createElement: (tag) => makeFakeEl(tag),
  };
};

const collectByAttr = (
  root: FakeEl,
  attr: string,
  out: FakeEl[] = [],
): FakeEl[] => {
  if (root.attrs.has(attr)) out.push(root);
  for (const child of root.children) collectByAttr(child, attr, out);
  return out;
};

const findByAttrValue = (
  root: FakeEl,
  attr: string,
  value: string,
): FakeEl | null => {
  if (root.getAttribute(attr) === value) return root;
  for (const child of root.children) {
    const hit = findByAttrValue(child, attr, value);
    if (hit !== null) return hit;
  }
  return null;
};

const treeText = (root: FakeEl): string => [
  root.textContent,
  ...root.children.map(treeText),
].join(' ');

const tick = async (n = 10): Promise<void> => {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
};

const fire = (host: FakeEl, type: string, ev: unknown): void => {
  for (const fn of [...(host.listeners.get(type) ?? [])]) fn(ev);
};

const clickAction = (host: FakeEl, data: Record<string, string>): void => {
  const el = { dataset: data, closest: () => el };
  fire(host, 'click', { target: el, preventDefault() {} });
};

/** Fire a field edit. `datasetKey` is the renderer's data attribute camelCased
 *  (`connField` for the enroll panel, `acctField` for the accounts panel). */
const field = (
  host: FakeEl,
  datasetKey: 'connField' | 'acctField',
  key: string,
  value: string,
  tagName = 'INPUT',
): void => {
  const el = { dataset: { [datasetKey]: key }, value, tagName, closest: () => el };
  const type = tagName === 'SELECT' ? 'change' : 'input';
  fire(host, type, { target: el, type });
};

const guideUrl = (host: FakeEl, value: string): void => {
  const el = {
    dataset: { connectionGuideUrl: '' },
    value,
    tagName: 'INPUT',
    closest: (selector: string) =>
      selector === '[data-connection-guide-url]' ? el : null,
  };
  fire(host, 'input', { target: el, type: 'input' });
};

const connection = (
  name: string,
  over: Partial<ConnectionView> = {},
): ConnectionView => ({
  name,
  kind: 'api',
  display_name: name,
  ...over,
});

const enrollCallers = () => {
  const enrolled = [connection('hub')];
  const connectionsEnrollListCaller = vi.fn<ConnectionsEnrollListCaller>(
    async () => ({ connections: enrolled }),
  );
  return {
    connectionsEnrollListCaller,
    connectionsEnrollCaller: vi.fn(async (args: { name: string; kind: ConnectionView['kind']; display_name?: string }) => ({
      connection: connection(args.name, {
        kind: args.kind,
        display_name: args.display_name,
      }),
      probe: { status: 'ok' } as ConnectionHealth,
    })),
    connectionsUpdateCaller: vi.fn(async (args: { name: string; kind: ConnectionView['kind'] }) => ({
      connection: connection(args.name, { kind: args.kind }),
    })),
    connectionsDeleteCaller: vi.fn(async () => ({ deleted: true })),
    connectionsProbeCaller: vi.fn(async () => ({
      health: { status: 'ok' } as ConnectionHealth,
    })),
    connectionsSuggestSetupCaller: vi.fn(async (args: ConnectionSetupGuideRequest) => ({
      shared_context: args,
      guide: {
        provider_name: 'Example Cloud',
        overview: 'Create a provider credential, then finish the form.',
        field_suggestions: [],
        steps: [{
          title: 'Create a credential',
          instruction: 'Open the provider page and create a least-privilege token.',
          field_keys: ['auth.token'],
        }],
        cautions: ['Verify the current provider documentation.'],
      },
    })),
  };
};

const readyWebhook = (): WebhookIngressView => ({
  ingress_id: 'whi_0123456789abcdef0123456789abcdef',
  public_id: 'opaquePublicId_0123456789abcdef',
  display_name: 'Signed deliveries',
  profile_id: 'generic.raw-body-hmac-sha256.v1',
  environment: 'live',
  paired_connection_id: null,
  registration_target: null,
  registration_mode: 'manual',
  endpoint_url: 'https://hooks.example/v1/webhooks/opaquePublicId_0123456789abcdef',
  remote_endpoint_id: null,
  selected_event_types: ['delivery'],
  registration_state: 'registered',
  intake_state: 'ready',
  configured_fields: ['signature_header', 'signing_secret'],
  missing_required_fields: [],
  active_credential_versions: [{
    version: '1',
    created_at: 1,
    retired_at: null,
    last_verified_at: null,
  }],
  readiness: {
    credentials_complete: true,
    registration_complete: true,
    registration_endpoint_matches: true,
    event_selection_complete: true,
    local_configuration_complete: true,
    profile_runtime_available: true,
    paired_connection_available: true,
    listener_available: true,
    public_url_available: true,
    public_reachability_enabled: true,
    tls_ready: true,
    clock_ready: true,
    test_delivery_supported: false,
    vault_unlocked: true,
    server_unpaused: true,
    can_enable: true,
    blockers: [],
  },
  health: {
    status: 'ready',
    test_observed_at: null,
    last_delivery_at: null,
    last_error_code: null,
  },
  enabled_at: null,
  created_at: 1,
  updated_at: 2,
});

const TEST_WEBHOOK_PROFILE_IDS = [
  'generic.static-header-token.v1',
  'generic.http-basic.v1',
  'generic.raw-body-hmac-sha256.v1',
  'github.webhook.v1',
  'paddle.notification.v1',
  'stripe.event.v1',
  'telegram.bot-webhook.v1',
] as const;

const TEST_WEBHOOK_PROFILE_CAPABILITIES: readonly WebhookProfileRuntimeCapabilityView[] =
  TEST_WEBHOOK_PROFILE_IDS.map((profileId) => ({
    profile_id: profileId,
    registration_modes: WEBHOOK_PROFILE_REGISTRY[profileId].registration_modes,
    deduplication: WEBHOOK_PROFILE_REGISTRY[profileId].deduplication,
  }));

const webhookList = (
  ingresses: readonly WebhookIngressView[],
  profiles: readonly WebhookProfileRuntimeCapabilityView[] =
    TEST_WEBHOOK_PROFILE_CAPABILITIES,
) => ({ ingresses, profiles });

describe('Connections route (R13–R16 restructure)', () => {
  it('keeps every webhook button at the shared mobile target height', () => {
    expect(WEBHOOKS_PANEL_STYLES).toContain(
      `[${WEBHOOKS_PANEL_ATTR}] button { box-sizing:border-box; min-height:36px;`,
    );
  });

  it('round-trips only a valid non-secret connection identity for the server-update return', () => {
    expect(serializeConnectionsCredentialRotationRetry({
      kind: 'api',
      name: 'github-main',
    })).toBe(
      '#connections/others/retry-credential-rotation/api/github-main',
    );
    expect(parseConnectionsCredentialRotationRetry([
      'others',
      'retry-credential-rotation',
      'api',
      'github-main',
    ])).toEqual({ kind: 'api', name: 'github-main' });
    expect(parseConnectionsCredentialRotationRetry([
      'others',
      'retry-credential-rotation',
      'unknown',
      'github-main',
    ])).toBeNull();
    expect(parseConnectionsCredentialRotationRetry([
      'others',
      'retry-credential-rotation',
      'api',
      'secret/name',
    ])).toBeNull();
  });

  it('round-trips only a valid identity for an exact post-ack recovery handoff', () => {
    expect(serializeConnectionsPostSafeStopRecovery({
      serverProfileId: 'profile-home',
      kind: 'mcp',
      name: 'research-main',
    })).toBe(
      '#connections/others/finish-recovery/profile/profile-home/mcp/research-main',
    );
    expect(parseConnectionsPostSafeStopRecovery([
      'others',
      'finish-recovery',
      'profile',
      'profile-home',
      'mcp',
      'research-main',
    ])).toEqual({
      serverProfileId: 'profile-home',
      kind: 'mcp',
      name: 'research-main',
    });
    expect(parseConnectionsPostSafeStopRecovery([
      'others',
      'finish-recovery',
      'profile',
      'profile-home',
      'unknown',
      'research-main',
    ])).toBeNull();
    expect(parseConnectionsPostSafeStopRecovery([
      'others',
      'finish-recovery',
      'profile',
      'profile-home',
      'mcp',
      'secret/name',
    ])).toBeNull();
    expect(parseConnectionsPostSafeStopRecovery([
      'others',
      'finish-recovery',
      'mcp',
      'research-main',
    ])).toBeNull();
  });

  it('requires the booted profile before resolving a post-ack target', () => {
    const bound = [
      'others',
      'finish-recovery',
      'profile',
      'profile-home',
      'api',
      'billing-crm',
    ];
    expect(resolveProfileBoundPostSafeStopRecovery(bound, 'profile-home'))
      .toEqual({
        status: 'matched',
        target: {
          serverProfileId: 'profile-home',
          kind: 'api',
          name: 'billing-crm',
        },
      });
    expect(resolveProfileBoundPostSafeStopRecovery(bound, 'profile-office'))
      .toEqual({
        status: 'profile_mismatch',
        target: {
          serverProfileId: 'profile-home',
          kind: 'api',
          name: 'billing-crm',
        },
      });
    expect(resolveProfileBoundPostSafeStopRecovery(bound, null))
      .toEqual({ status: 'unbound' });
    expect(resolveProfileBoundPostSafeStopRecovery([
      'others',
      'finish-recovery',
      'api',
      'billing-crm',
    ], 'profile-home')).toEqual({ status: 'unbound' });
    expect(resolveProfileBoundPostSafeStopRecovery([
      'others',
      'enroll',
      'stripe',
    ], 'profile-home')).toEqual({ status: 'none' });
  });

  it('renders the five connection tabs with the active one marked', () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const route = bootstrapConnectionsRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      initialTab: 'file',
      file: {
        list: vi.fn(async () => ({ instances: [] })),
        enroll: vi.fn(async () => { throw new Error('unused'); }),
        delete: vi.fn(async () => ({ ok: true as const })),
      },
    });

    expect(collectByAttr(root, CONNECTIONS_ROUTE_HEADING_ATTR)[0]?.textContent)
      .toBe('Connections');
    expect(collectByAttr(root, CONNECTIONS_ROUTE_DESCRIPTION_ATTR)[0]?.textContent)
      .toBe('Bring your mail, calendars, files, and everyday services into Recued.');
    expect(doc.styleElements[0]?.attrs.has(CONNECTIONS_ROUTE_STYLES_MARKER)).toBe(true);

    const tabBar = collectByAttr(root, CONNECTIONS_ROUTE_TABS_ATTR)[0]!;
    expect(tabBar.getAttribute('aria-label')).toBe('Connection types');
    const tabs = tabBar.children;
    expect(tabs.map((t) => t.textContent)).toEqual([
      'Mail',
      'Calendar',
      'Files',
      'Apps & APIs',
      'Webhooks',
    ]);
    expect(tabs.map((t) => t.getAttribute('href'))).toEqual([
      '#connections/mail',
      '#connections/calendar',
      '#connections/file',
      '#connections/others',
      '#connections/webhooks',
    ]);
    // Files is the active tab → only it carries the active marker + aria.
    expect(tabs[2]!.getAttribute('aria-current')).toBe('page');
    expect(tabs[2]!.className).toContain('connections-route-tab--active');
    expect(tabs[0]!.getAttribute('aria-current')).toBeNull();

    route.dispose();
    expect(root.children).toHaveLength(0);
  });

  it('forwards an exact privacy-safe leave guard for a dirty connection editor', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const callers = enrollCallers();
    callers.connectionsEnrollListCaller.mockResolvedValue({
      connections: [
        connection('github-main', {
          display_name: 'GitHub',
          auth_type: 'bearer',
        }),
      ],
    });
    const route = bootstrapConnectionsRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      initialTab: 'others',
      ...callers,
    });
    await route.connectionsEnrollPanel()!.whenLoaded();
    const content = collectByAttr(root, CONNECTIONS_ROUTE_ENROLL_HOST_ATTR)[0]!;

    expect(route.hasUnsavedChanges()).toBe(false);
    expect(route.unsavedChangesPrompt()).toBeNull();
    clickAction(content, {
      action: 'connections-edit',
      kind: 'api',
      name: 'github-main',
    });
    field(
      content,
      'connField',
      'auth.token',
      'private-route-only-secret',
    );

    expect(route.hasUnsavedChanges()).toBe(true);
    expect(route.unsavedChangesPrompt()).toMatch(
      /discard changes to api\/github-main.*cancel to stay/i,
    );
    expect(route.unsavedChangesPrompt()).not.toContain(
      'private-route-only-secret',
    );

    field(content, 'connField', 'auth.token', '');
    expect(route.hasUnsavedChanges()).toBe(false);
    expect(route.unsavedChangesPrompt()).toBeNull();

    route.dispose();
  });

  it('returns through Apps & APIs and retries only the addressed connection', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const callers = enrollCallers();
    callers.connectionsEnrollListCaller.mockResolvedValue({
      connections: [
        connection('other-api', { updated_at: 90 }),
        connection('guided-api', { auth_type: 'bearer', updated_at: 91 }),
      ],
    });
    const activity = vi.fn(async () => ({
      activity: { status: 'idle' as const },
    }));
    const onCredentialRotationServerUpdateRetrySettled = vi.fn();
    const onCredentialRotationCleanEditorReady = vi.fn();
    const route = bootstrapConnectionsRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      initialTab: 'others',
      initialCredentialRotationServerUpdateRetry: {
        kind: 'api',
        name: 'guided-api',
      },
      connectionsCredentialRotationActivityCaller: activity,
      onCredentialRotationServerUpdateRetrySettled,
      onCredentialRotationCleanEditorReady,
      ...callers,
    });

    await route.connectionsEnrollPanel()!.whenLoaded();
    await tick(30);

    expect(activity).toHaveBeenCalledOnce();
    expect(activity).toHaveBeenCalledWith({
      kind: 'api',
      name: 'guided-api',
    });
    expect(callers.connectionsEnrollListCaller).toHaveBeenCalledTimes(2);
    expect(route.connectionsEnrollPanel()!.getState().credentialRotationRecovery)
      .toMatchObject({
        kind: 'api',
        name: 'guided-api',
        phase: 'editor_ready',
        returnedFromServerUpdate: true,
      });
    expect(route.connectionsEnrollPanel()!.getState().dialog.editingId)
      .toBe('api/guided-api');
    expect(route.connectionsEnrollPanel()!.getState().dialog.values['auth.token'])
      .toBeUndefined();
    expect(onCredentialRotationServerUpdateRetrySettled).not.toHaveBeenCalled();
    expect(onCredentialRotationCleanEditorReady).toHaveBeenCalledWith({
      kind: 'api',
      name: 'guided-api',
    });
    route.dispose();
  });

  it('lands an Attention recovery link on the exact unresolved connection', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const callers = enrollCallers();
    callers.connectionsEnrollListCaller.mockResolvedValue({
      connections: [
        connection('queue-first', {
          auth_type: 'bearer',
          updated_at: 40,
        }),
        connection('attention-target', {
          auth_type: 'bearer',
          updated_at: 50,
        }),
      ],
      credential_post_safe_stop_verifications: [
        {
          kind: 'api',
          name: 'queue-first',
          status: 'pending',
          acknowledged_at: 30,
        },
        {
          kind: 'api',
          name: 'attention-target',
          status: 'unreachable',
          acknowledged_at: 31,
          checked_at: 32,
          connection_updated_at: 50,
        },
      ],
    });
    const route = bootstrapConnectionsRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      initialTab: 'others',
      initialPostSafeStopRecovery: {
        kind: 'api',
        name: 'attention-target',
      },
      ...callers,
    });

    await route.connectionsEnrollPanel()!.whenLoaded();
    expect(route.connectionsEnrollPanel()!.getState().dialog.recentProbe)
      .toMatchObject({
        kind: 'api',
        name: 'attention-target',
        status: 'unreachable',
        resolution: 'retry',
      });
    route.dispose();
  });

  it('passes authoritative cold safe-stop closure through the route mount', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const callers = enrollCallers();
    const token = 'a'.repeat(64);
    callers.connectionsEnrollListCaller.mockResolvedValue({
      connections: [connection('cold-safe-stop', {
        base_url: 'https://api.example.test',
        auth_type: 'bearer',
        updated_at: 91,
      })],
      credential_rotation_safe_stops: [{
        kind: 'api',
        name: 'cold-safe-stop',
        finished_at: 100,
        acknowledgement_token: token,
        correction: {
          auth_type: 'bearer',
          field_keys: ['auth.token'],
          triage: {
            reason: 'repeated_auth_rejection',
            stage: 'provider_probe',
            endpoint_field_keys: ['config.base_url', 'config.endpoint'],
            resolution: 'regenerate_credential_or_contact_admin',
          },
        },
      }],
    });
    const acknowledge = vi.fn(async () => ({
      acknowledgement: {
        status: 'acknowledged' as const,
        acknowledged_at: 101,
      },
    }));
    const route = bootstrapConnectionsRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      initialTab: 'others',
      connectionsCredentialRotationActivityCaller: vi.fn(async () => ({
        activity: { status: 'idle' as const, safe_stop: null },
      })),
      connectionsAcknowledgeCredentialRotationSafeStopCaller: acknowledge,
      ...callers,
    });
    await route.connectionsEnrollPanel()!.whenLoaded();
    const content = collectByAttr(root, CONNECTIONS_ROUTE_ENROLL_HOST_ATTR)[0]!;

    clickAction(content, {
      action: 'connections-review-credential-rotation',
      kind: 'api',
      name: 'cold-safe-stop',
    });
    clickAction(content, {
      action: 'connections-confirm-credential-handoff',
    });
    await tick();

    expect(acknowledge).toHaveBeenCalledWith({
      kind: 'api',
      name: 'cold-safe-stop',
      acknowledgement_token: token,
    });
    expect(route.connectionsEnrollPanel()!.getState().dialog
      .credentialSafeStopClosureNotice).toMatchObject({
        nextStep: 'check_saved_connection',
      });
    expect(content.innerHTML).not.toContain(token);
    route.dispose();
  });

  it('reports an interrupted exact return when the route leaves before its preflight settles', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const callers = enrollCallers();
    callers.connectionsEnrollListCaller.mockResolvedValue({
      connections: [
        connection('guided-api', { auth_type: 'bearer', updated_at: 91 }),
      ],
    });
    const activity = vi.fn(async () =>
      await new Promise<never>(() => undefined));
    const onCredentialRotationServerUpdateRetrySettled = vi.fn();
    const onCredentialRotationServerUpdateRetryInterrupted = vi.fn();
    const target = {
      kind: 'api' as const,
      name: 'guided-api',
    };
    const route = bootstrapConnectionsRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      initialTab: 'others',
      initialCredentialRotationServerUpdateRetry: target,
      connectionsCredentialRotationActivityCaller: activity,
      onCredentialRotationServerUpdateRetrySettled,
      onCredentialRotationServerUpdateRetryInterrupted,
      ...callers,
    });

    await route.connectionsEnrollPanel()!.whenLoaded();
    await tick();
    expect(activity).toHaveBeenCalledWith(target);

    route.dispose();

    expect(onCredentialRotationServerUpdateRetrySettled).not.toHaveBeenCalled();
    expect(onCredentialRotationServerUpdateRetryInterrupted)
      .toHaveBeenCalledOnce();
    expect(onCredentialRotationServerUpdateRetryInterrupted)
      .toHaveBeenCalledWith(target);
  });

  it('keeps the exact return interruptible when the clean-editor handoff cannot settle', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const callers = enrollCallers();
    callers.connectionsEnrollListCaller.mockResolvedValue({
      connections: [
        connection('guided-api', { auth_type: 'bearer', updated_at: 91 }),
      ],
    });
    const target = {
      kind: 'api' as const,
      name: 'guided-api',
    };
    const onCredentialRotationCleanEditorReady = vi.fn(() => {
      throw new Error('continuity unavailable');
    });
    const onCredentialRotationServerUpdateRetryInterrupted = vi.fn();
    const route = bootstrapConnectionsRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      initialTab: 'others',
      initialCredentialRotationServerUpdateRetry: target,
      connectionsCredentialRotationActivityCaller: vi.fn(async () => ({
        activity: { status: 'idle' as const },
      })),
      onCredentialRotationCleanEditorReady,
      onCredentialRotationServerUpdateRetryInterrupted,
      ...callers,
    });

    await route.connectionsEnrollPanel()!.whenLoaded();
    await tick(30);

    expect(route.connectionsEnrollPanel()!.getState().dialog.editingId)
      .toBe('api/guided-api');
    expect(onCredentialRotationCleanEditorReady).toHaveBeenCalledWith(target);

    route.dispose();

    expect(onCredentialRotationServerUpdateRetryInterrupted)
      .toHaveBeenCalledOnce();
    expect(onCredentialRotationServerUpdateRetryInterrupted)
      .toHaveBeenCalledWith(target);
  });

  it('forwards a still-unsupported return to the persistent server-update guide', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const callers = enrollCallers();
    callers.connectionsEnrollListCaller.mockResolvedValue({
      connections: [connection('guided-api', {
        auth_type: 'bearer',
        updated_at: 92,
      })],
    });
    const onOpenCredentialRotationServerUpdateGuide = vi.fn();
    const onCredentialRotationServerUpdateRetrySettled = vi.fn();
    const triage = vi.fn(async () => ({
      reason: 'running_version_unchanged' as const,
      checkStatus: 'up-to-date' as const,
      baselineVersion: '26.7.3',
      currentVersion: '26.7.3',
      channel: 'stable' as const,
    }));
    const route = bootstrapConnectionsRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      initialTab: 'others',
      initialCredentialRotationServerUpdateRetry: {
        kind: 'api',
        name: 'guided-api',
      },
      connectionsCredentialRotationServerUpdateTriageCaller: triage,
      onOpenCredentialRotationServerUpdateGuide,
      onCredentialRotationServerUpdateRetrySettled,
      ...callers,
    });

    await route.connectionsEnrollPanel()!.whenLoaded();
    await tick();
    expect(route.connectionsEnrollPanel()!.getState().credentialRotationRecovery)
      .toMatchObject({
        kind: 'api',
        name: 'guided-api',
        phase: 'restart_unsupported',
        returnedFromServerUpdate: true,
        serverUpdateTriage: {
          reason: 'running_version_unchanged',
          currentVersion: '26.7.3',
        },
      });
    expect(triage).toHaveBeenCalledWith({ kind: 'api', name: 'guided-api' });
    const content = collectByAttr(root, CONNECTIONS_ROUTE_ENROLL_HOST_ATTR)[0]!;
    expect(content.innerHTML).toContain('same running version seen before');
    expect(content.innerHTML).toContain('Review server profile');

    clickAction(content, {
      action: 'connections-review-server-update',
      kind: 'api',
      name: 'guided-api',
    });
    expect(onOpenCredentialRotationServerUpdateGuide).toHaveBeenCalledOnce();
    expect(onOpenCredentialRotationServerUpdateGuide).toHaveBeenCalledWith({
      kind: 'api',
      name: 'guided-api',
    });
    expect(onCredentialRotationServerUpdateRetrySettled).not.toHaveBeenCalled();
    route.dispose();
  });

  it('mounts the foundational Mail lane by default and enrolls an IMAP account', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const list = vi.fn(async () => ({ instances: [] as never[] }));
    let finishEnroll!: (value: {
      slug: string;
      send_capable: boolean;
    }) => void;
    const enrollPending = new Promise<{
      slug: string;
      send_capable: boolean;
    }>((resolve) => { finishEnroll = resolve; });
    const enrollImap = vi.fn((_args: Record<string, unknown>) => enrollPending);
    const route = bootstrapConnectionsRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      mail: { list, enrollImap, delete: vi.fn(async () => ({ ok: true as const })) },
      ...enrollCallers(),
    });

    // Default tab = Mail → the foundational accounts panel mounts, the generic
    // connection.* enroll panel does not.
    expect(route.accountsPanel()).not.toBeNull();
    expect(route.connectionsEnrollPanel()).toBeNull();
    expect(route.activeTab()).toBe('mail');
    await route.accountsPanel()!.whenLoaded();
    expect(list).toHaveBeenCalledTimes(1);

    const content = collectByAttr(root, CONNECTIONS_ROUTE_CONTENT_ATTR)[0]!;
    // Mail now has 3 providers (IMAP + Gmail/Microsoft OAuth) → Add opens the
    // provider picker; choose IMAP, then fill its form.
    clickAction(content, { action: 'accounts-open-add' });
    clickAction(content, { action: 'accounts-pick-provider', provider: 'imap' });
    field(content, 'acctField', 'name', 'fastmail');
    field(content, 'acctField', 'host', 'imap.fastmail.com');
    field(content, 'acctField', 'username', 'me@fastmail.com');
    field(content, 'acctField', 'password', 'app-password');
    clickAction(content, { action: 'accounts-submit-form' });
    expect(route.hasInFlightWork()).toBe(true);
    expect(route.inFlightWorkPrompt()).toBe(
      'Connections is still doing something. Leave anyway?',
    );
    finishEnroll({ slug: 'fastmail', send_capable: true });
    await tick();

    expect(enrollImap).toHaveBeenCalledTimes(1);
    expect(enrollImap.mock.calls[0]![0]).toMatchObject({
      name: 'fastmail',
      host: 'imap.fastmail.com',
      port: 993,
      secure: true,
      username: 'me@fastmail.com',
      password: 'app-password',
      folders: ['INBOX'],
    });
    // Re-list after a successful enroll.
    expect(list).toHaveBeenCalledTimes(2);
    expect(route.accountsPanel()!.getState().connectionSuccess).toEqual({
      slug: 'fastmail',
      providerId: 'imap',
    });
    expect(route.hasInFlightWork()).toBe(false);
    expect(route.inFlightWorkPrompt()).toBeNull();

    route.dispose();
    expect(root.children).toHaveLength(0);
  });

  it('reattaches one foundational OAuth transaction across route mounts', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const continuity = createFoundationalOAuthContinuity();
    const relay = {
      current: null as ((event: { origin: string; data: unknown }) => void) | null,
    };
    const popup = {
      closed: false,
      location: { href: '' },
      close: vi.fn(() => { popup.closed = true; }),
    };
    const popupOpen = vi.fn(() => popup);
    const env: FoundationalOAuthEnv = {
      origin: 'https://app.recued.com',
      randomState: () => 'ROUTE-CONTINUITY',
      onMessage: (listener) => {
        relay.current = listener;
        return () => { relay.current = null; };
      },
      setTimeout: () => () => undefined,
      setInterval: () => () => undefined,
    };
    const list = vi.fn(async () => ({ instances: [] as never[] }));
    const enrollOAuth = vi.fn(async () => ({
      ok: true as const,
      account_key_prefix: 'gmail.work',
    }));
    const getOAuthClientConfig = vi.fn(async () => ({
      gmail: { client_id: 'GMAIL-CID' },
      gcal: null,
      graph: null,
    }));
    const routeOptions = {
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      mail: {
        list,
        enrollImap: vi.fn(async () => ({ slug: 'imap', send_capable: false })),
        enrollOAuth,
        delete: vi.fn(async () => ({ ok: true as const })),
      },
      getOAuthClientConfig,
      foundationalOAuthContinuity: continuity,
      accountsOAuthEnv: { openPopup: popupOpen, env },
    };

    const first = bootstrapConnectionsRoute(routeOptions);
    await first.accountsPanel()!.whenLoaded();
    const firstContent = collectByAttr(root, CONNECTIONS_ROUTE_CONTENT_ATTR)[0]!;
    clickAction(firstContent, { action: 'accounts-open-add' });
    clickAction(firstContent, { action: 'accounts-pick-provider', provider: 'gmail' });
    field(firstContent, 'acctField', 'name', 'work');
    clickAction(firstContent, { action: 'accounts-oauth-connect' });
    await tick();
    expect(continuity.snapshot()).toMatchObject({
      status: 'pending',
      returnHref: '#connections/mail',
    });

    first.dispose();
    expect(popup.closed).toBe(false);
    const second = bootstrapConnectionsRoute(routeOptions);
    await second.accountsPanel()!.whenLoaded();
    expect(second.accountsPanel()!.getState()).toMatchObject({
      providerId: 'gmail',
      oauthFinishing: true,
      oauthProgressStage: 'waiting_for_consent',
    });
    expect(popupOpen).toHaveBeenCalledTimes(1);
    expect(getOAuthClientConfig).toHaveBeenCalledTimes(1);

    relay.current?.({
      origin: 'https://app.recued.com',
      data: {
        kind: OPENER_RELAY_MESSAGE_KIND,
        state: `${OAUTH_OPENER_RELAY_STATE_PREFIX}ROUTE-CONTINUITY`,
        code: 'ROUTE-CODE',
      },
    });
    await tick();
    expect(enrollOAuth).toHaveBeenCalledTimes(1);
    expect(second.accountsPanel()!.getState().connectionSuccess).toEqual({
      slug: 'work',
      providerId: 'gmail',
    });

    second.dispose();
    continuity.dispose();
  });

  it('mounts the generic connection.* enroll panel on the Others tab', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const callers = enrollCallers();
    const route = bootstrapConnectionsRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      initialTab: 'others',
      ...callers,
    });

    expect(route.activeTab()).toBe('others');
    expect(route.connectionsEnrollPanel()).not.toBeNull();
    expect(route.accountsPanel()).toBeNull();

    await route.connectionsEnrollPanel()!.whenLoaded();
    expect(callers.connectionsEnrollListCaller).toHaveBeenCalledTimes(1);

    const content = collectByAttr(root, CONNECTIONS_ROUTE_ENROLL_HOST_ATTR)[0]!;
    clickAction(content, { action: 'connections-open-add' });
    clickAction(content, { action: 'connections-pick-kind', kind: 'api' });
    field(content, 'connField', 'auth.token', 'secret-123');
    clickAction(content, { action: 'connections-guide-open' });
    guideUrl(content, 'https://developer.example.com/apps?token=url-secret');
    clickAction(content, { action: 'connections-guide-review' });
    clickAction(content, { action: 'connections-guide-generate' });
    await tick();
    expect(callers.connectionsSuggestSetupCaller).toHaveBeenCalledWith({
      target_url: 'https://developer.example.com/apps',
      auth_type: 'bearer',
      field_keys: expect.arrayContaining(['auth.type', 'auth.token']),
    });
    expect(JSON.stringify(callers.connectionsSuggestSetupCaller.mock.calls[0]?.[0]))
      .not.toContain('secret-123');
    field(content, 'connField', 'name', 'my-api');
    field(content, 'connField', 'display_name', 'My API');
    field(content, 'connField', 'config.base_url', 'https://api.example.com');
    clickAction(content, { action: 'connections-submit-form' });
    await tick();

    expect(callers.connectionsEnrollCaller).toHaveBeenCalledTimes(1);
    expect(callers.connectionsEnrollCaller.mock.calls[0]![0]).toMatchObject({
      name: 'my-api',
      kind: 'api',
      display_name: 'My API',
      config: { base_url: 'https://api.example.com' },
      auth: { type: 'bearer', token: 'secret-123' },
    });

    route.dispose();
    expect(root.children).toHaveLength(0);
  });

  it('reattaches a privacy-safe provider-app guide across Connections route mounts', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const callers = enrollCallers();
    const connectionsSuggestSetupCaller = vi.fn<
      (args: ConnectionSetupGuideRequest) => Promise<ConnectionSetupGuideResult>
    >(async (args) => ({
      shared_context: args,
      guide: {
        provider_name: 'Example OAuth',
        overview: 'Create a web app, then return to the exact unfinished field.',
        field_suggestions: [{
          field_key: 'auth.client_id',
          suggested_value: 'MODEL-ID-MUST-NOT-PERSIST',
          guidance: 'Copy the provider-issued identifier into the live form.',
          confidence: 'low',
        }],
        steps: [{
          title: 'Create the app',
          instruction: 'Create a confidential web OAuth app.',
          field_keys: ['auth.client_id', 'auth.client_secret'],
        }],
        cautions: ['Keep credentials in the live form.'],
      },
    }));
    const data = new Map<string, string>();
    const storage = {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => { data.set(key, value); },
      removeItem: (key: string) => { data.delete(key); },
    };
    const providerSetupContinuity = createProviderSetupContinuityStore({
      storage,
      scopeId: 'profile-office',
      now: () => 1_800_000_000_000,
    });
    const routeOptions = {
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      initialTab: 'others',
      providerSetupContinuity,
      ...callers,
      connectionsSuggestSetupCaller,
    };

    const first = bootstrapConnectionsRoute(routeOptions);
    await first.connectionsEnrollPanel()!.whenLoaded();
    const firstContent = collectByAttr(
      root,
      CONNECTIONS_ROUTE_ENROLL_HOST_ATTR,
    )[0]!;
    clickAction(firstContent, { action: 'connections-open-add' });
    clickAction(firstContent, { action: 'connections-pick-kind', kind: 'api' });
    field(firstContent, 'connField', 'auth.type', 'oauth2_refresh', 'SELECT');
    field(firstContent, 'connField', 'auth.client_id', 'REAL-ID-MUST-NOT-PERSIST');
    field(firstContent, 'connField', 'auth.client_secret', 'REAL-SECRET-MUST-NOT-PERSIST');
    clickAction(firstContent, { action: 'connections-guide-open' });
    guideUrl(firstContent, 'https://developer.example.com/apps?private=value');
    clickAction(firstContent, { action: 'connections-guide-review' });
    clickAction(firstContent, { action: 'connections-guide-generate' });
    await tick();

    const raw = data.get(PROVIDER_SETUP_CONTINUITY_SESSION_KEY) ?? '';
    expect(raw).toContain('https://developer.example.com/apps');
    expect(raw).not.toContain('REAL-ID-MUST-NOT-PERSIST');
    expect(raw).not.toContain('REAL-SECRET-MUST-NOT-PERSIST');
    expect(raw).not.toContain('MODEL-ID-MUST-NOT-PERSIST');
    first.dispose();

    const second = bootstrapConnectionsRoute(routeOptions);
    await second.connectionsEnrollPanel()!.whenLoaded();
    await tick();
    const restored = second.connectionsEnrollPanel()!.getState().dialog;
    expect(restored.setupGuide.resumeAvailable).toBe(true);
    expect(restored.values['auth.client_id']).toBeUndefined();
    expect(restored.values['auth.client_secret']).toBeUndefined();
    const secondContent = collectByAttr(
      root,
      CONNECTIONS_ROUTE_ENROLL_HOST_ATTR,
    )[0]!;
    expect(secondContent.innerHTML).toContain('Resume provider setup');
    clickAction(secondContent, { action: 'connections-guide-resume' });
    expect(second.connectionsEnrollPanel()!.getState().dialog.setupGuide.resumeAvailable)
      .toBe(false);
    expect(data.has(PROVIDER_SETUP_CONTINUITY_SESSION_KEY)).toBe(false);
    second.dispose();
  });

  it('mounts the inbound Webhooks panel and enables only a ready ingress', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const ingress = readyWebhook();
    const runList = vi.fn(async () => webhookList([ingress]));
    const runEnable = vi.fn(async () => ({
      ingress: { ...ingress, intake_state: 'enabled' as const },
    }));
    const route = bootstrapConnectionsRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      initialTab: 'webhooks',
      webhooksListCaller: runList,
      webhooksCreateCaller: vi.fn(async () => ({ ingress })),
      webhooksCredentialWriteCaller: vi.fn(async () => ({
        ingress,
        credential_version: {
          version: '2',
          created_at: 2,
          retired_at: null,
          last_verified_at: null,
        },
      })),
      webhooksCredentialRetireCaller: vi.fn(async () => ({ ingress })),
      webhooksManualConfirmCaller: vi.fn(async () => ({ ingress })),
      webhooksEnableCaller: runEnable,
      webhooksDisableCaller: vi.fn(async () => ({ ingress })),
    });

    expect(route.activeTab()).toBe('webhooks');
    expect(route.accountsPanel()).toBeNull();
    expect(route.connectionsEnrollPanel()).toBeNull();
    expect(route.webhooksPanel()).not.toBeNull();
    await route.webhooksPanel()!.refresh();
    expect(treeText(root)).toContain('Assurance authenticated');

    const enable = findByAttrValue(root, WEBHOOKS_PANEL_ACTION_ATTR, 'enable');
    expect(enable?.disabled).toBe(false);
    expect(findByAttrValue(root, WEBHOOKS_PANEL_ACTION_ATTR, 'test-delivery'))
      .toBeNull();
    enable?.click();
    await tick();
    expect(runEnable).toHaveBeenCalledWith({ ingress_id: ingress.ingress_id });

    route.dispose();
    expect(root.children).toHaveLength(0);
  });

  it('distinguishes repeated webhook actions by their owning ingress', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const first = readyWebhook();
    const second: WebhookIngressView = {
      ...readyWebhook(),
      ingress_id: 'whi_11111111111111111111111111111111',
      public_id: 'opaquePublicId_1111111111111111',
      display_name: 'Billing deliveries',
      endpoint_url: 'https://hooks.example/v1/webhooks/opaquePublicId_1111111111111111',
    };
    const route = bootstrapConnectionsRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      initialTab: 'webhooks',
      webhooksListCaller: vi.fn(async () => webhookList([first, second])),
      webhooksCreateCaller: vi.fn(async () => ({ ingress: first })),
      webhooksCredentialWriteCaller: vi.fn(async () => ({
        ingress: first,
        credential_version: first.active_credential_versions[0]!,
      })),
      webhooksCredentialRetireCaller: vi.fn(async () => ({ ingress: first })),
      webhooksManualConfirmCaller: vi.fn(async () => ({ ingress: first })),
      webhooksEnableCaller: vi.fn(async () => ({ ingress: first })),
      webhooksDisableCaller: vi.fn(async () => ({ ingress: first })),
    });
    await route.webhooksPanel()!.refresh();

    const actions = collectByAttr(root, WEBHOOKS_PANEL_ACTION_ATTR);
    const labelsFor = (action: string): Array<string | null> => actions
      .filter((candidate) => candidate.getAttribute(WEBHOOKS_PANEL_ACTION_ATTR) === action)
      .map((candidate) => candidate.getAttribute('aria-label'));
    expect(labelsFor('credentials')).toEqual([
      `Swap the keys for Signed deliveries (${first.ingress_id})`,
      `Swap the keys for Billing deliveries (${second.ingress_id})`,
    ]);
    expect(labelsFor('enable')).toEqual([
      `Let messages in for Signed deliveries (${first.ingress_id})`,
      `Let messages in for Billing deliveries (${second.ingress_id})`,
    ]);

    route.dispose();
  });

  it('keeps account list/detail in-page while using native hierarchical history', async () => {
    const doc = makeFakeDocument();
    const calls: string[] = [];
    (doc as unknown as { defaultView: unknown }).defaultView = {
      history: {
        pushState: (_data: unknown, _title: string, url: string) => {
          calls.push(`push ${url}`);
        },
        replaceState: (_data: unknown, _title: string, url: string) => {
          calls.push(`replace ${url}`);
        },
      },
    };
    const onHashSync = vi.fn();
    const root = doc.createElement('div');
    const route = bootstrapConnectionsRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      initialAddress: { kind: 'lane', tab: 'mail' },
      onHashSync,
      mail: {
        list: vi.fn(async () => ({
          instances: [{
            slug: 'work-mail',
            adapter_type: 'gmail',
            auth_state: 'healthy' as const,
            last_synced_at: 1_700_000_000_000,
            send_capable: false,
            account_email: 'owner@example.com',
          }],
        })),
        enrollImap: vi.fn(async () => ({ slug: 'unused', send_capable: false })),
        delete: vi.fn(async () => ({ ok: true as const })),
      },
    });
    await route.accountsPanel()!.whenLoaded();
    const content = collectByAttr(root, CONNECTIONS_ROUTE_CONTENT_ATTR)[0]!;

    clickAction(content, { action: 'accounts-open-detail', slug: 'work-mail' });
    clickAction(content, { action: 'accounts-back-to-list' });

    expect(calls).toEqual([
      'push #connections/mail/work-mail',
      'replace #connections/mail',
    ]);
    expect(onHashSync).toHaveBeenNthCalledWith(
      1,
      '#connections/mail/work-mail',
    );
    expect(onHashSync).toHaveBeenNthCalledWith(2, '#connections/mail');
    route.dispose();
  });

  it('offers the bounded owner reconcile action only for the code-backed managed Stripe profile', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const base = readyWebhook();
    const ingress: WebhookIngressView = {
      ...base,
      display_name: 'Managed Stripe events',
      profile_id: 'stripe.event.v1',
      environment: 'test',
      paired_connection_id: 'stripe-test',
      registration_mode: 'managed_endpoint',
      remote_endpoint_id: null,
      selected_event_types: ['invoice.paid'],
      registration_state: 'managed_pending',
      intake_state: 'draft',
      configured_fields: [],
      missing_required_fields: ['endpoint_secret'],
      active_credential_versions: [],
      readiness: {
        ...base.readiness,
        credentials_complete: false,
        registration_complete: false,
        registration_endpoint_matches: false,
        local_configuration_complete: false,
        profile_runtime_available: false,
        can_enable: false,
        blockers: [
          'credentials_incomplete',
          'registration_incomplete',
          'profile_runtime_unavailable',
        ],
      },
    };
    const runReconcile = vi.fn(async () => ({
      ingress: {
        ...ingress,
        remote_endpoint_id: 'we_1234567890abcdef',
        registration_state: 'registered' as const,
        intake_state: 'ready' as const,
      },
    }));
    const route = bootstrapConnectionsRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      initialTab: 'webhooks',
      webhooksListCaller: vi.fn(async () => webhookList([ingress])),
      webhooksCreateCaller: vi.fn(async () => ({ ingress })),
      webhooksCredentialWriteCaller: vi.fn(async () => ({
        ingress,
        credential_version: {
          version: '1',
          created_at: 1,
          retired_at: null,
          last_verified_at: null,
        },
      })),
      webhooksCredentialRetireCaller: vi.fn(async () => ({ ingress })),
      webhooksManualConfirmCaller: vi.fn(async () => ({ ingress })),
      webhooksRegistrationReconcileCaller: runReconcile,
      webhooksEnableCaller: vi.fn(async () => ({ ingress })),
      webhooksDisableCaller: vi.fn(async () => ({ ingress })),
    });
    await route.webhooksPanel()!.refresh();

    const reconcile = findByAttrValue(
      root,
      WEBHOOKS_PANEL_ACTION_ATTR,
      'registration-reconcile',
    );
    expect(reconcile).toMatchObject({
      textContent: 'Set up the address at the service',
      disabled: false,
    });
    expect(treeText(root)).toContain('How to set it up managed endpoint');
    expect(treeText(root)).toContain('Connection stripe-test');
    expect(treeText(root)).toContain('never exposed to packs or recipes');
    expect(findByAttrValue(root, WEBHOOKS_PANEL_ACTION_ATTR, 'credentials')).toBeNull();
    reconcile?.click();
    await tick();
    expect(runReconcile).toHaveBeenCalledWith({ ingress_id: ingress.ingress_id });
    route.dispose();
  });

  it('submits a bounded managed connection replacement without provider request fields', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const base = readyWebhook();
    const ingress: WebhookIngressView = {
      ...base,
      display_name: 'Managed Stripe connection',
      profile_id: 'stripe.event.v1',
      environment: 'test',
      paired_connection_id: 'stripe-test',
      pending_paired_connection_id: null,
      registration_mode: 'managed_endpoint',
      remote_endpoint_id: 'we_rebindui123456789',
      selected_event_types: ['invoice.paid'],
      registration_state: 'registered',
      intake_state: 'ready',
    };
    const runReconcile = vi.fn(async () => ({
      ingress: {
        ...ingress,
        paired_connection_id: 'stripe-test-rotated',
      },
    }));
    const route = bootstrapConnectionsRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      initialTab: 'webhooks',
      webhooksListCaller: vi.fn(async () => webhookList([ingress])),
      webhooksCreateCaller: vi.fn(async () => ({ ingress })),
      webhooksCredentialWriteCaller: vi.fn(async () => ({
        ingress,
        credential_version: ingress.active_credential_versions[0]!,
      })),
      webhooksCredentialRetireCaller: vi.fn(async () => ({ ingress })),
      webhooksManualConfirmCaller: vi.fn(async () => ({ ingress })),
      webhooksRegistrationReconcileCaller: runReconcile,
      webhooksEnableCaller: vi.fn(async () => ({ ingress })),
      webhooksDisableCaller: vi.fn(async () => ({ ingress })),
    });
    await route.webhooksPanel()!.refresh();

    const open = findByAttrValue(
      root,
      WEBHOOKS_PANEL_ACTION_ATTR,
      'connection-rebind',
    );
    expect(open).toMatchObject({ textContent: 'Change the Connection' });
    open?.click();
    const input = collectByAttr(root, WEBHOOKS_PANEL_REBIND_ATTR)[0]!;
    input.value = ' stripe-test-rotated ';
    expect(treeText(root)).toContain('Same-account credentials keep the endpoint live');
    fire(input.parent!.parent!, 'submit', { preventDefault() {} });
    await tick();

    expect(runReconcile).toHaveBeenCalledWith({
      ingress_id: ingress.ingress_id,
      paired_connection_id: 'stripe-test-rotated',
    });
    route.dispose();
  });

  it('keeps a pending connection target visible and retries through the cutover RPC', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const base = readyWebhook();
    const ingress: WebhookIngressView = {
      ...base,
      display_name: 'Stripe account cutover',
      profile_id: 'stripe.event.v1',
      environment: 'test',
      paired_connection_id: 'stripe-test-old',
      pending_paired_connection_id: 'stripe-test-new',
      registration_mode: 'managed_endpoint',
      remote_endpoint_id: 'we_pendingrebind12345',
      selected_event_types: ['invoice.paid'],
      registration_state: 'cleanup_pending',
      intake_state: 'disabled',
      health: {
        ...base.health,
        status: 'degraded',
        last_error_code: 'managed_cleanup_unconfirmed',
      },
      readiness: {
        ...base.readiness,
        registration_complete: false,
        can_enable: false,
        blockers: ['registration_incomplete'],
      },
    };
    const retryCutover = vi.fn(async () => ({ ingress }));
    const retryDisable = vi.fn(async () => ({ ingress }));
    const route = bootstrapConnectionsRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      initialTab: 'webhooks',
      webhooksListCaller: vi.fn(async () => webhookList([ingress])),
      webhooksCreateCaller: vi.fn(async () => ({ ingress })),
      webhooksCredentialWriteCaller: vi.fn(async () => ({
        ingress,
        credential_version: ingress.active_credential_versions[0]!,
      })),
      webhooksCredentialRetireCaller: vi.fn(async () => ({ ingress })),
      webhooksManualConfirmCaller: vi.fn(async () => ({ ingress })),
      webhooksRegistrationReconcileCaller: retryCutover,
      webhooksEnableCaller: vi.fn(async () => ({ ingress })),
      webhooksDisableCaller: retryDisable,
      webhooksRetireCaller: vi.fn(async () => ({ ingress })),
    });
    await route.webhooksPanel()!.refresh();

    expect(treeText(root)).toContain('Waiting for a Connection stripe-test-new');
    expect(treeText(root)).toContain('Only once it has checked the address is gone will it switch');
    const retry = findByAttrValue(root, WEBHOOKS_PANEL_ACTION_ATTR, 'cleanup-retry');
    expect(retry).toMatchObject({ textContent: 'Try the swap again' });
    retry?.click();
    await tick();
    expect(retryCutover).toHaveBeenCalledWith({
      ingress_id: ingress.ingress_id,
      paired_connection_id: 'stripe-test-new',
    });
    expect(retryDisable).not.toHaveBeenCalled();
    route.dispose();
  });

  it('keeps failed managed cleanup visible and retryable while intake stays closed', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const base = readyWebhook();
    const ingress: WebhookIngressView = {
      ...base,
      display_name: 'Stripe cleanup pending',
      profile_id: 'stripe.event.v1',
      environment: 'test',
      paired_connection_id: 'stripe-test',
      registration_mode: 'managed_endpoint',
      remote_endpoint_id: 'we_cleanup123456789',
      registration_state: 'cleanup_pending',
      intake_state: 'disabled',
      health: {
        ...base.health,
        status: 'degraded',
        last_error_code: 'managed_cleanup_unconfirmed',
      },
      readiness: {
        ...base.readiness,
        registration_complete: false,
        can_enable: false,
        blockers: ['registration_incomplete'],
      },
    };
    const retryDisable = vi.fn(async () => ({
      ingress: {
        ...ingress,
        remote_endpoint_id: null,
        registration_state: 'managed_pending' as const,
      },
    }));
    const route = bootstrapConnectionsRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      initialTab: 'webhooks',
      webhooksListCaller: vi.fn(async () => webhookList([ingress])),
      webhooksCreateCaller: vi.fn(async () => ({ ingress })),
      webhooksCredentialWriteCaller: vi.fn(async () => ({
        ingress,
        credential_version: {
          version: '1',
          created_at: 1,
          retired_at: null,
          last_verified_at: null,
        },
      })),
      webhooksCredentialRetireCaller: vi.fn(async () => ({ ingress })),
      webhooksManualConfirmCaller: vi.fn(async () => ({ ingress })),
      webhooksRegistrationReconcileCaller: vi.fn(async () => ({ ingress })),
      webhooksEnableCaller: vi.fn(async () => ({ ingress })),
      webhooksDisableCaller: retryDisable,
      webhooksRetireCaller: vi.fn(async () => ({ ingress })),
    });
    await route.webhooksPanel()!.refresh();

    expect(treeText(root)).toContain('The address at the service still has to be cleaned up');
    expect(treeText(root)).toContain('Last thing that went wrong managed_cleanup_unconfirmed');
    expect(findByAttrValue(
      root,
      WEBHOOKS_PANEL_ACTION_ATTR,
      'registration-reconcile',
    )).toBeNull();
    expect(findByAttrValue(root, WEBHOOKS_PANEL_ACTION_ATTR, 'retire')).toBeNull();
    const retry = findByAttrValue(root, WEBHOOKS_PANEL_ACTION_ATTR, 'cleanup-retry');
    expect(retry).toMatchObject({
      textContent: 'Try the clean-up again',
      disabled: false,
    });
    retry?.click();
    await tick();
    expect(retryDisable).toHaveBeenCalledWith({ ingress_id: ingress.ingress_id });
    route.dispose();
  });

  it('runs a profile-backed test only on an enabled test ingress and shows durable observation', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const base = readyWebhook();
    const ingress: WebhookIngressView = {
      ...base,
      environment: 'test',
      intake_state: 'enabled',
      enabled_at: 10,
      readiness: {
        ...base.readiness,
        test_delivery_supported: true,
      },
      health: {
        ...base.health,
        status: 'healthy',
      },
    };
    const observedAt = 2_100_000_000_000;
    const runTestDelivery = vi.fn(async () => ({
      ingress: {
        ...ingress,
        health: {
          ...ingress.health,
          test_observed_at: observedAt,
          last_delivery_at: observedAt,
        },
      },
      delivery_id: 'whd_testdelivery0000000000000000000',
      observed_at: observedAt,
    }));
    const route = bootstrapConnectionsRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      initialTab: 'webhooks',
      webhooksListCaller: vi.fn(async () => webhookList([ingress])),
      webhooksCreateCaller: vi.fn(async () => ({ ingress })),
      webhooksCredentialWriteCaller: vi.fn(async () => ({
        ingress,
        credential_version: ingress.active_credential_versions[0]!,
      })),
      webhooksCredentialRetireCaller: vi.fn(async () => ({ ingress })),
      webhooksManualConfirmCaller: vi.fn(async () => ({ ingress })),
      webhooksEnableCaller: vi.fn(async () => ({ ingress })),
      webhooksDisableCaller: vi.fn(async () => ({ ingress })),
      webhooksTestDeliveryCaller: runTestDelivery,
    });
    await route.webhooksPanel()!.refresh();

    const test = findByAttrValue(root, WEBHOOKS_PANEL_ACTION_ATTR, 'test-delivery');
    expect(test?.disabled).toBe(false);
    expect(treeText(root)).toContain('may run recipes bound to this test ingress');
    test?.click();
    await tick();

    expect(runTestDelivery).toHaveBeenCalledWith({ ingress_id: ingress.ingress_id });
    expect(collectByAttr(root, WEBHOOKS_PANEL_TEST_ATTR)).toHaveLength(1);
    expect(treeText(root)).toContain('arrived and was kept at');
    expect(treeText(root)).toContain('It went the same way a real one would');

    runTestDelivery.mockRejectedValueOnce(new Error(
      'delivery whd_ambiguous may have dispatched; inspect it before retrying',
    ));
    findByAttrValue(root, WEBHOOKS_PANEL_ACTION_ATTR, 'test-delivery')?.click();
    await tick();
    expect(collectByAttr(root, WEBHOOKS_PANEL_TEST_ATTR)).toHaveLength(0);
    expect(treeText(root)).toContain('may have dispatched; inspect it before retrying');

    route.dispose();
  });

  it('does not present a GitHub test delivery as rotated-secret verification', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const base = readyWebhook();
    const ingress: WebhookIngressView = {
      ...base,
      profile_id: 'github.webhook.v1',
      environment: 'test',
      intake_state: 'enabled',
      configured_fields: ['webhook_secret'],
      missing_required_fields: [],
      selected_event_types: ['issues'],
      active_credential_versions: [{
        version: '2',
        created_at: 2,
        retired_at: null,
        last_verified_at: null,
      }, {
        version: '1',
        created_at: 1,
        retired_at: null,
        last_verified_at: 3,
      }],
      readiness: {
        ...base.readiness,
        test_delivery_supported: true,
      },
    };
    const route = bootstrapConnectionsRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      initialTab: 'webhooks',
      webhooksListCaller: vi.fn(async () => webhookList([ingress])),
      webhooksCreateCaller: vi.fn(async () => ({ ingress })),
      webhooksCredentialWriteCaller: vi.fn(async () => ({
        ingress,
        credential_version: ingress.active_credential_versions[0]!,
      })),
      webhooksCredentialRetireCaller: vi.fn(async () => ({ ingress })),
      webhooksManualConfirmCaller: vi.fn(async () => ({ ingress })),
      webhooksEnableCaller: vi.fn(async () => ({ ingress })),
      webhooksDisableCaller: vi.fn(async () => ({ ingress })),
      webhooksTestDeliveryCaller: vi.fn(async () => ({
        ingress,
        delivery_id: 'whd_githubtest000000000000000000000',
        observed_at: 4,
      })),
    });
    await route.webhooksPanel()!.refresh();

    expect(findByAttrValue(root, WEBHOOKS_PANEL_ACTION_ATTR, 'test-delivery'))
      .not.toBeNull();
    expect(treeText(root)).toContain('deliberately signs with the older active credential');
    expect(treeText(root)).toContain('it cannot verify the replacement');
    expect(treeText(root)).toContain('does not prove the GitHub dashboard is configured');
    route.dispose();
  });

  it('drills into accepted deliveries and renders decoded JSON only as text', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const ingress = readyWebhook();
    const delivery = {
      delivery_id: 'whd_00000000000000000000000000000001',
      ingress_id: ingress.ingress_id,
      profile_id: ingress.profile_id,
      environment: ingress.environment,
      received_at: 2_100_000_000_000,
      raw_body_sha256: 'a'.repeat(64),
      raw_body_retained: false,
      decoded_content_type: 'application/json',
      decoded_schema_id: 'generic.delivery.v1',
      transport_assurance: 'authenticated',
      minimum_source_truth_policy: 'delivery_payload_allowed',
      credential_version: '1',
      admission_method: 'generic-hmac-sha256',
      freshness_checked: true,
      event_count: 1,
      metadata_expires_at: 2_200_000_000_000,
    } satisfies WebhookDeliveryListResponse['deliveries'][number];
    const event = {
      event_id: 'whe_00000000000000000000000000000001',
      delivery_id: delivery.delivery_id,
      ingress_id: ingress.ingress_id,
      event_index: 0,
      provider_event_id: 'provider-event-1',
      provider_resource_id: null,
      provider_event_type: 'delivery',
      provider_occurred_at: null,
      selected_for_dispatch: true,
      dispatch_state: 'dispatched',
      payload_retained: true,
      payload_expires_at: 2_150_000_000_000,
      metadata_expires_at: delivery.metadata_expires_at,
    } satisfies WebhookDeliveryDetailView['events'][number];
    const olderDelivery = {
      ...delivery,
      delivery_id: 'whd_00000000000000000000000000000002',
      received_at: delivery.received_at - 1,
    } satisfies WebhookDeliveryListResponse['deliveries'][number];
    const cursor = {
      received_at: delivery.received_at,
      delivery_id: delivery.delivery_id,
    };
    const runDeliveryList = vi.fn(async (args: WebhookDeliveryListRequest) => (
      args.cursor === undefined
        ? { deliveries: [delivery], next_cursor: cursor }
        : { deliveries: [olderDelivery], next_cursor: null }
    ) satisfies WebhookDeliveryListResponse);
    const runDeliveryGet = vi.fn(async () => ({
      detail: { delivery, events: [event] },
    }));
    const runDeliveryEventGet = vi.fn(async () => ({
      event: {
        event,
        payload_retained: true as const,
        payload: { unsafe_markup: '<script>alert("decoded")</script>' },
      },
    }));
    const rejection = {
      rejection_id: 'whr_00000000000000000000000000000001',
      ingress_id: ingress.ingress_id,
      profile_id: ingress.profile_id,
      environment: ingress.environment,
      reason_code: 'authentication_failed',
      http_status: 401,
      bucket_started_at: 2_100_000_000_000,
      first_recorded_at: 2_100_000_000_001,
      last_recorded_at: 2_100_000_000_100,
      recorded_attempt_count: 2,
      metadata_prune_eligible_at: 2_200_000_000_000,
    } satisfies WebhookRejectedDeliveryListResponse['rejections'][number];
    const olderRejection = {
      ...rejection,
      rejection_id: 'whr_00000000000000000000000000000002',
      bucket_started_at: rejection.bucket_started_at - 60_000,
      first_recorded_at: rejection.first_recorded_at - 60_000,
      last_recorded_at: rejection.last_recorded_at - 60_000,
      reason_code: 'unsupported_media_type',
      http_status: 415,
      recorded_attempt_count: 1,
    } satisfies WebhookRejectedDeliveryListResponse['rejections'][number];
    const rejectionCursor = {
      bucket_started_at: rejection.bucket_started_at,
      rejection_id: rejection.rejection_id,
    };
    const runRejectedDeliveryList = vi.fn(async (
      args: WebhookRejectedDeliveryListRequest,
    ): Promise<WebhookRejectedDeliveryListResponse> => args.cursor === undefined
      ? { rejections: [rejection], next_cursor: rejectionCursor }
      : { rejections: [olderRejection], next_cursor: null });
    let retirementCommitted = false;
    const runList = vi.fn(async () => {
      if (retirementCommitted) throw new Error('post-retirement refresh failed');
      return webhookList([ingress]);
    });
    const runRetentionPrune = vi.fn(async () => ({
      result: {
        payloads_deleted: 2,
        outbox_rows_deleted: 1,
        events_deleted: 1,
        deliveries_deleted: 1,
        rejected_summaries_deleted: 3,
      },
    }));
    const runRetire = vi.fn(async () => {
      retirementCommitted = true;
      return {
        ingress: {
          ...ingress,
          intake_state: 'retired' as const,
          registration_state: 'retired' as const,
        },
      };
    });
    const route = bootstrapConnectionsRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      initialTab: 'webhooks',
      webhooksListCaller: runList,
      webhooksCreateCaller: vi.fn(async () => ({ ingress })),
      webhooksCredentialWriteCaller: vi.fn(async () => ({
        ingress,
        credential_version: ingress.active_credential_versions[0]!,
      })),
      webhooksCredentialRetireCaller: vi.fn(async () => ({ ingress })),
      webhooksManualConfirmCaller: vi.fn(async () => ({ ingress })),
      webhooksEnableCaller: vi.fn(async () => ({ ingress })),
      webhooksDisableCaller: vi.fn(async () => ({ ingress })),
      webhooksDeliveryListCaller: runDeliveryList,
      webhooksDeliveryGetCaller: runDeliveryGet,
      webhooksDeliveryEventGetCaller: runDeliveryEventGet,
      webhooksRejectedDeliveryListCaller: runRejectedDeliveryList,
      webhooksRetentionPruneCaller: runRetentionPrune,
      webhooksRetireCaller: runRetire,
    });
    await route.webhooksPanel()!.refresh();

    findByAttrValue(root, WEBHOOKS_PANEL_ACTION_ATTR, 'deliveries')!.click();
    await tick();
    expect(runDeliveryList).toHaveBeenCalledWith({
      ingress_id: ingress.ingress_id,
      limit: 10,
    });
    expect(collectByAttr(root, WEBHOOKS_PANEL_DELIVERIES_ATTR)).toHaveLength(1);
    expect(treeText(root)).toContain('Ones that failed the check, or were turned away, are not here.');
    expect(collectByAttr(root, WEBHOOKS_PANEL_DELIVERY_ATTR)).toHaveLength(1);

    findByAttrValue(root, WEBHOOKS_PANEL_ACTION_ATTR, 'deliveries-more')!.click();
    await tick();
    expect(runDeliveryList).toHaveBeenLastCalledWith({
      ingress_id: ingress.ingress_id,
      limit: 10,
      cursor,
    });
    expect(collectByAttr(root, WEBHOOKS_PANEL_DELIVERY_ATTR)).toHaveLength(2);
    expect(collectByAttr(root, WEBHOOKS_PANEL_ACTION_ATTR)
      .filter((action) => action.getAttribute(WEBHOOKS_PANEL_ACTION_ATTR)
        === 'delivery-open')
      .map((action) => action.getAttribute('aria-label'))).toEqual([
      `Look at message ${delivery.delivery_id} for ${ingress.display_name} (${ingress.ingress_id})`,
      `Look at message ${olderDelivery.delivery_id} for ${ingress.display_name} (${ingress.ingress_id})`,
    ]);

    findByAttrValue(root, WEBHOOKS_PANEL_ACTION_ATTR, 'delivery-open')!.click();
    await tick();
    expect(runDeliveryGet).toHaveBeenCalledWith({
      ingress_id: ingress.ingress_id,
      delivery_id: delivery.delivery_id,
    });
    expect(collectByAttr(root, WEBHOOKS_PANEL_EVENT_ATTR)).toHaveLength(1);
    expect(findByAttrValue(root, WEBHOOKS_PANEL_ACTION_ATTR, 'event-open')
      ?.getAttribute('aria-label')).toBe(
      `See what was sent for event ${event.event_id} in ${ingress.display_name} (${ingress.ingress_id})`,
    );

    findByAttrValue(root, WEBHOOKS_PANEL_ACTION_ATTR, 'event-open')!.click();
    await tick();
    expect(runDeliveryEventGet).toHaveBeenCalledWith({
      ingress_id: ingress.ingress_id,
      delivery_id: delivery.delivery_id,
      event_id: event.event_id,
    });
    const payload = collectByAttr(root, WEBHOOKS_PANEL_PAYLOAD_ATTR)[0]!;
    expect(payload.textContent).toContain('<script>alert(\\"decoded\\")</script>');
    expect(payload.innerHTML).toBe('');

    findByAttrValue(root, WEBHOOKS_PANEL_ACTION_ATTR, 'rejections')!.click();
    await tick();
    expect(runRejectedDeliveryList).toHaveBeenCalledWith({
      ingress_id: ingress.ingress_id,
      limit: 10,
    });
    expect(collectByAttr(root, WEBHOOKS_PANEL_DELIVERIES_ATTR)).toHaveLength(0);
    expect(collectByAttr(root, WEBHOOKS_PANEL_REJECTIONS_ATTR)).toHaveLength(1);
    expect(collectByAttr(root, WEBHOOKS_PANEL_REJECTION_ATTR)).toHaveLength(1);
    expect(treeText(root)).toContain('What they said, their fingerprints, paths, headers, signatures, keys, network details');
    expect(treeText(root)).toContain('authentication_failed');
    findByAttrValue(root, WEBHOOKS_PANEL_ACTION_ATTR, 'rejections-more')!.click();
    await tick();
    expect(runRejectedDeliveryList).toHaveBeenLastCalledWith({
      ingress_id: ingress.ingress_id,
      limit: 10,
      cursor: rejectionCursor,
    });
    expect(collectByAttr(root, WEBHOOKS_PANEL_REJECTION_ATTR)).toHaveLength(2);

    findByAttrValue(root, WEBHOOKS_PANEL_ACTION_ATTR, 'rejections')!.click();
    runRejectedDeliveryList.mockRejectedValueOnce(new Error('rejection read failed'));
    findByAttrValue(root, WEBHOOKS_PANEL_ACTION_ATTR, 'rejections')!.click();
    await tick();
    expect(treeText(root)).toContain('rejection read failed');
    expect(treeText(root)).toContain('Recued cannot show the messages that were turned away.');
    expect(treeText(root)).not.toContain('Recued has kept no messages that were turned away.');

    findByAttrValue(root, WEBHOOKS_PANEL_ACTION_ATTR, 'retention-prune')!.click();
    await tick();
    expect(runRetentionPrune).toHaveBeenCalledWith({ ingress_id: ingress.ingress_id });
    expect(collectByAttr(root, WEBHOOKS_PANEL_RETENTION_ATTR)).toHaveLength(1);
    expect(treeText(root)).toContain('Cleared out: 2 things that were sent');
    expect(treeText(root)).toContain('Anything still waiting, being worked on, stuck, or pinned is kept safe.');

    findByAttrValue(root, WEBHOOKS_PANEL_ACTION_ATTR, 'retire')!.click();
    expect(runRetire).not.toHaveBeenCalled();
    expect(treeText(root)).toContain('Retirement is permanent');
    findByAttrValue(root, WEBHOOKS_PANEL_ACTION_ATTR, 'retire-confirm')!.click();
    await tick();
    expect(runRetire).toHaveBeenCalledWith({ ingress_id: ingress.ingress_id });
    expect(collectByAttr(root, WEBHOOKS_PANEL_CARD_ATTR)).toHaveLength(0);
    expect(treeText(root)).toContain('post-retirement refresh failed');

    route.dispose();
  });

  it('keeps live retirement closed until a remaining credential has verified', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const ingress: WebhookIngressView = {
      ...readyWebhook(),
      intake_state: 'enabled',
      active_credential_versions: [
        {
          version: '2',
          created_at: 2,
          retired_at: null,
          last_verified_at: null,
        },
        {
          version: '1',
          created_at: 1,
          retired_at: null,
          last_verified_at: 3,
        },
      ],
    };
    const runRetire = vi.fn(async () => ({ ingress }));
    const route = bootstrapConnectionsRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      initialTab: 'webhooks',
      webhooksListCaller: vi.fn(async () => webhookList([ingress])),
      webhooksCreateCaller: vi.fn(async () => ({ ingress })),
      webhooksCredentialWriteCaller: vi.fn(async () => ({
        ingress,
        credential_version: ingress.active_credential_versions[0]!,
      })),
      webhooksCredentialRetireCaller: vi.fn(async () => ({ ingress })),
      webhooksManualConfirmCaller: vi.fn(async () => ({ ingress })),
      webhooksEnableCaller: vi.fn(async () => ({ ingress })),
      webhooksDisableCaller: vi.fn(async () => ({ ingress })),
      webhooksRetireCaller: runRetire,
    });
    await route.webhooksPanel()!.refresh();
    const retire = collectByAttr(root, WEBHOOKS_PANEL_ACTION_ATTR)
      .filter((action) => action.getAttribute(WEBHOOKS_PANEL_ACTION_ATTR)
        === 'credential-retire');
    expect(retire.map((action) => [action.textContent, action.disabled])).toEqual([
      ['Retire key v2', false],
      ['Retire key v1', true],
    ]);
    expect(findByAttrValue(root, WEBHOOKS_PANEL_ACTION_ATTR, 'retire'))
      .toMatchObject({ disabled: true });
    expect(runRetire).not.toHaveBeenCalled();
    route.dispose();
  });

  it('blocks ingress retirement during handshake exposure or for an unsupported managed adapter', async () => {
    const cases: WebhookIngressView[] = [
      {
        ...readyWebhook(),
        intake_state: 'verification_pending',
      },
      {
        ...readyWebhook(),
        ingress_id: 'whi_99999999999999999999999999999999',
        profile_id: 'slack.request.v0',
        registration_mode: 'managed_endpoint',
        remote_endpoint_id: 'remote-endpoint-1',
        selected_event_types: ['event_callback'],
        intake_state: 'disabled',
      },
      {
        ...readyWebhook(),
        ingress_id: 'whi_88888888888888888888888888888888',
        profile_id: 'generic.static-header-token.v1',
        paired_connection_id: 'fixture-provider-test',
        registration_mode: 'operation_bound',
        registration_state: 'not_applicable',
        intake_state: 'disabled',
      },
    ];
    for (const ingress of cases) {
      const doc = makeFakeDocument();
      const root = doc.createElement('div');
      const runRetire = vi.fn(async () => ({ ingress }));
      const route = bootstrapConnectionsRoute({
        root: root as unknown as HTMLElement,
        document: doc as unknown as Document,
        initialTab: 'webhooks',
        webhooksListCaller: vi.fn(async () => webhookList([ingress])),
        webhooksCreateCaller: vi.fn(async () => ({ ingress })),
        webhooksCredentialWriteCaller: vi.fn(async () => ({
          ingress,
          credential_version: ingress.active_credential_versions[0]!,
        })),
        webhooksCredentialRetireCaller: vi.fn(async () => ({ ingress })),
        webhooksManualConfirmCaller: vi.fn(async () => ({ ingress })),
        webhooksEnableCaller: vi.fn(async () => ({ ingress })),
        webhooksDisableCaller: vi.fn(async () => ({ ingress })),
        webhooksRetireCaller: runRetire,
      });
      await route.webhooksPanel()!.refresh();

      const retire = findByAttrValue(root, WEBHOOKS_PANEL_ACTION_ATTR, 'retire')!;
      expect(retire.disabled).toBe(true);
      if (ingress.registration_mode === 'managed_endpoint') {
        expect(findByAttrValue(root, WEBHOOKS_PANEL_ACTION_ATTR, 'credentials'))
          .toBeNull();
      }
      retire.click();
      expect(runRetire).not.toHaveBeenCalled();
      expect(findByAttrValue(root, WEBHOOKS_PANEL_ACTION_ATTR, 'retire-confirm')).toBeNull();
      route.dispose();
    }
  });

  it('allows retirement of a never-enabled operation-bound draft', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const ingress: WebhookIngressView = {
      ...readyWebhook(),
      profile_id: 'generic.static-header-token.v1',
      paired_connection_id: 'fixture-provider-test',
      registration_mode: 'operation_bound',
      registration_state: 'not_applicable',
      intake_state: 'draft',
      configured_fields: [],
      missing_required_fields: ['header_name', 'header_token'],
      active_credential_versions: [],
    };
    const retired: WebhookIngressView = {
      ...ingress,
      registration_state: 'retired',
      intake_state: 'retired',
    };
    const runRetire = vi.fn(async () => ({ ingress: retired }));
    const route = bootstrapConnectionsRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      initialTab: 'webhooks',
      webhooksListCaller: vi.fn(async () => webhookList([ingress])),
      webhooksCreateCaller: vi.fn(async () => ({ ingress })),
      webhooksCredentialWriteCaller: vi.fn(async () => ({
        ingress,
        credential_version: {
          version: '1',
          created_at: 1,
          retired_at: null,
          last_verified_at: null,
        },
      })),
      webhooksCredentialRetireCaller: vi.fn(async () => ({ ingress })),
      webhooksManualConfirmCaller: vi.fn(async () => ({ ingress })),
      webhooksEnableCaller: vi.fn(async () => ({ ingress })),
      webhooksDisableCaller: vi.fn(async () => ({ ingress })),
      webhooksRetireCaller: runRetire,
    });
    await route.webhooksPanel()!.refresh();

    const retire = findByAttrValue(root, WEBHOOKS_PANEL_ACTION_ATTR, 'retire')!;
    expect(retire.disabled).toBe(false);
    retire.click();
    expect(treeText(root)).toContain('nothing could ever have been sent to it');
    findByAttrValue(root, WEBHOOKS_PANEL_ACTION_ATTR, 'retire-confirm')!.click();
    await tick();
    expect(runRetire).toHaveBeenCalledWith({ ingress_id: ingress.ingress_id });
    route.dispose();
  });

  it('builds generic credential fields from the trusted profile and clears plaintext after save', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const created = {
      ...readyWebhook(),
      display_name: 'Static token',
      profile_id: 'generic.static-header-token.v1' as const,
      registration_state: 'manual_pending' as const,
      intake_state: 'draft' as const,
      configured_fields: [],
      missing_required_fields: ['header_name', 'header_token'],
    };
    const runCreate = vi.fn(async () => ({ ingress: created }));
    const runWrite = vi.fn(async () => ({
      ingress: created,
      credential_version: {
        version: '1',
        created_at: 2,
        retired_at: null,
        last_verified_at: null,
      },
    }));
    const route = bootstrapConnectionsRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      initialTab: 'webhooks',
      webhooksListCaller: vi.fn(async () => webhookList([])),
      webhooksCreateCaller: runCreate,
      webhooksCredentialWriteCaller: runWrite,
      webhooksCredentialRetireCaller: vi.fn(async () => ({ ingress: created })),
      webhooksManualConfirmCaller: vi.fn(async () => ({ ingress: created })),
      webhooksEnableCaller: vi.fn(async () => ({ ingress: created })),
      webhooksDisableCaller: vi.fn(async () => ({ ingress: created })),
    });
    await route.webhooksPanel()!.refresh();
    collectByAttr(root, WEBHOOKS_PANEL_NEW_ATTR)[0]!.click();
    const profile = collectByAttr(root, WEBHOOKS_PANEL_PROFILE_ATTR)[0]!;
    expect(profile.children.map((option) => option.value)).toEqual([
      'generic.static-header-token.v1',
      'generic.http-basic.v1',
      'generic.raw-body-hmac-sha256.v1',
      'github.webhook.v1',
      'paddle.notification.v1',
      'stripe.event.v1',
      'telegram.bot-webhook.v1',
    ]);
    const name = findByAttrValue(root, WEBHOOKS_PANEL_FIELD_ATTR, 'display_name')!;
    const header = findByAttrValue(root, WEBHOOKS_PANEL_FIELD_ATTR, 'header_name')!;
    const token = findByAttrValue(root, WEBHOOKS_PANEL_FIELD_ATTR, 'header_token')!;
    name.value = 'Static token';
    header.value = 'X-Webhook-Token';
    token.value = 'plaintext-never-echoed';
    const form = findByAttrValue(root, WEBHOOKS_PANEL_FORM_ATTR, 'create')!;
    expect(collectByAttr(root, WEBHOOKS_PANEL_DEDUPLICATION_ATTR)[0]?.textContent)
      .toContain('in 5 minutes blocks');
    expect(collectByAttr(root, WEBHOOKS_PANEL_DEDUPLICATION_ATTR)[0]?.textContent)
      .toContain('at least 45 days');
    fire(form, 'submit', { preventDefault() {} });
    await tick();

    expect(runCreate).toHaveBeenCalledWith({
      display_name: 'Static token',
      profile_id: 'generic.static-header-token.v1',
      environment: 'test',
      registration_mode: 'manual',
      selected_event_types: ['delivery'],
    });
    expect(runWrite).toHaveBeenCalledWith({
      ingress_id: created.ingress_id,
      credentials: {
        header_name: 'X-Webhook-Token',
        header_token: 'plaintext-never-echoed',
      },
    });
    expect(treeText(root)).not.toContain('plaintext-never-echoed');
    route.dispose();
  });

  it('renders create profiles and modes only from server-projected capabilities', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const ingress = readyWebhook();
    const route = bootstrapConnectionsRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      initialTab: 'webhooks',
      webhooksListCaller: vi.fn(async () => webhookList([], [{
        profile_id: 'slack.request.v0',
        registration_modes: ['manual'],
        deduplication: WEBHOOK_PROFILE_REGISTRY['slack.request.v0'].deduplication,
      }, {
        profile_id: 'generic.static-header-token.v1',
        registration_modes: ['manual'],
        deduplication: {
          ...WEBHOOK_PROFILE_REGISTRY['generic.static-header-token.v1'].deduplication,
          tombstone_horizon_ms: 1,
        },
      }])),
      webhooksCreateCaller: vi.fn(async () => ({ ingress })),
      webhooksCredentialWriteCaller: vi.fn(async () => ({
        ingress,
        credential_version: ingress.active_credential_versions[0]!,
      })),
      webhooksCredentialRetireCaller: vi.fn(async () => ({ ingress })),
      webhooksManualConfirmCaller: vi.fn(async () => ({ ingress })),
      webhooksRegistrationReconcileCaller: vi.fn(async () => ({ ingress })),
      webhooksEnableCaller: vi.fn(async () => ({ ingress })),
      webhooksDisableCaller: vi.fn(async () => ({ ingress })),
    });
    await route.webhooksPanel()!.refresh();
    collectByAttr(root, WEBHOOKS_PANEL_NEW_ATTR)[0]!.click();

    const profile = collectByAttr(root, WEBHOOKS_PANEL_PROFILE_ATTR)[0]!;
    expect(profile.children.map((option) => option.value)).toEqual([
      'slack.request.v0',
    ]);
    expect(treeText(root)).toContain('Slack requests · timestamped hmac');
    expect(collectByAttr(root, WEBHOOKS_PANEL_DEDUPLICATION_ATTR)[0]?.textContent)
      .toContain('If there is none, it uses the signed time and exactly what was sent');
    expect(collectByAttr(root, WEBHOOKS_PANEL_REGISTRATION_MODE_ATTR)[0]!
      .children.map((option) => option.value)).toEqual(['manual']);
    expect(collectByAttr(root, WEBHOOKS_PANEL_PAIRED_CONNECTION_ATTR)).toEqual([]);
    route.dispose();
  });

  it('drops profile mutation authority when a capability refresh fails', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const ingress = readyWebhook();
    let failList = false;
    const route = bootstrapConnectionsRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      initialTab: 'webhooks',
      webhooksListCaller: vi.fn(async () => {
        if (failList) throw new Error('capability projection unavailable');
        return webhookList([ingress], [{
          profile_id: ingress.profile_id,
          registration_modes: ['manual'],
          deduplication: WEBHOOK_PROFILE_REGISTRY[ingress.profile_id].deduplication,
        }]);
      }),
      webhooksCreateCaller: vi.fn(async () => ({ ingress })),
      webhooksCredentialWriteCaller: vi.fn(async () => ({
        ingress,
        credential_version: ingress.active_credential_versions[0]!,
      })),
      webhooksCredentialRetireCaller: vi.fn(async () => ({ ingress })),
      webhooksManualConfirmCaller: vi.fn(async () => ({ ingress })),
      webhooksEnableCaller: vi.fn(async () => ({ ingress })),
      webhooksDisableCaller: vi.fn(async () => ({ ingress })),
    });
    await route.webhooksPanel()!.refresh();
    expect(findByAttrValue(root, WEBHOOKS_PANEL_ACTION_ATTR, 'credentials')).not.toBeNull();
    expect(findByAttrValue(root, WEBHOOKS_PANEL_ACTION_ATTR, 'enable')).not.toBeNull();

    failList = true;
    await route.webhooksPanel()!.refresh();
    expect(collectByAttr(root, WEBHOOKS_PANEL_NEW_ATTR)[0]!.disabled).toBe(true);
    expect(findByAttrValue(root, WEBHOOKS_PANEL_ACTION_ATTR, 'credentials')).toBeNull();
    expect(findByAttrValue(root, WEBHOOKS_PANEL_ACTION_ATTR, 'enable')).toBeNull();
    expect(treeText(root)).toContain('capability projection unavailable');
    route.dispose();
  });

  it('drops profile mutation authority when the post-mutation relist fails', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const ingress = readyWebhook();
    let failList = false;
    const runEnable = vi.fn(async () => {
      failList = true;
      return {
        ingress: { ...ingress, intake_state: 'enabled' as const },
      };
    });
    const route = bootstrapConnectionsRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      initialTab: 'webhooks',
      webhooksListCaller: vi.fn(async () => {
        if (failList) throw new Error('post-mutation capability refresh failed');
        return webhookList([ingress], [{
          profile_id: ingress.profile_id,
          registration_modes: ['manual'],
          deduplication: WEBHOOK_PROFILE_REGISTRY[ingress.profile_id].deduplication,
        }]);
      }),
      webhooksCreateCaller: vi.fn(async () => ({ ingress })),
      webhooksCredentialWriteCaller: vi.fn(async () => ({
        ingress,
        credential_version: ingress.active_credential_versions[0]!,
      })),
      webhooksCredentialRetireCaller: vi.fn(async () => ({ ingress })),
      webhooksManualConfirmCaller: vi.fn(async () => ({ ingress })),
      webhooksEnableCaller: runEnable,
      webhooksDisableCaller: vi.fn(async () => ({ ingress })),
    });
    await route.webhooksPanel()!.refresh();
    findByAttrValue(root, WEBHOOKS_PANEL_ACTION_ATTR, 'enable')!.click();
    await tick();

    expect(runEnable).toHaveBeenCalledOnce();
    expect(collectByAttr(root, WEBHOOKS_PANEL_NEW_ATTR)[0]!.disabled).toBe(true);
    expect(findByAttrValue(root, WEBHOOKS_PANEL_ACTION_ATTR, 'credentials')).toBeNull();
    expect(findByAttrValue(root, WEBHOOKS_PANEL_ACTION_ATTR, 'enable')).toBeNull();
    expect(treeText(root)).toContain('post-mutation capability refresh failed');
    route.dispose();
  });

  it('does not fall back to manual when only an unusable managed mode is projected', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const ingress = readyWebhook();
    const route = bootstrapConnectionsRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      initialTab: 'webhooks',
      webhooksListCaller: vi.fn(async () => webhookList([], [{
        profile_id: 'github.webhook.v1',
        registration_modes: ['managed_endpoint'],
        deduplication: WEBHOOK_PROFILE_REGISTRY['github.webhook.v1'].deduplication,
      }])),
      webhooksCreateCaller: vi.fn(async () => ({ ingress })),
      webhooksCredentialWriteCaller: vi.fn(async () => ({
        ingress,
        credential_version: ingress.active_credential_versions[0]!,
      })),
      webhooksCredentialRetireCaller: vi.fn(async () => ({ ingress })),
      webhooksManualConfirmCaller: vi.fn(async () => ({ ingress })),
      webhooksEnableCaller: vi.fn(async () => ({ ingress })),
      webhooksDisableCaller: vi.fn(async () => ({ ingress })),
    });
    await route.webhooksPanel()!.refresh();

    const newWebhook = collectByAttr(root, WEBHOOKS_PANEL_NEW_ATTR)[0]!;
    expect(newWebhook.disabled).toBe(true);
    newWebhook.click();
    expect(findByAttrValue(root, WEBHOOKS_PANEL_FORM_ATTR, 'create')).toBeNull();
    route.dispose();
  });

  it('creates manual GitHub and keeps secret rotation overlap safe', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const base = readyWebhook();
    const firstSecret = 'G'.repeat(43);
    const rotatedSecret = 'R'.repeat(43);
    const created: WebhookIngressView = {
      ...base,
      display_name: 'GitHub repository events',
      profile_id: 'github.webhook.v1',
      environment: 'live',
      registration_mode: 'manual',
      selected_event_types: ['issues', 'pull_request'],
      registration_state: 'manual_pending',
      intake_state: 'draft',
      configured_fields: [],
      missing_required_fields: ['webhook_secret'],
      active_credential_versions: [],
      readiness: {
        ...base.readiness,
        credentials_complete: false,
        registration_complete: false,
        local_configuration_complete: false,
        can_enable: false,
        blockers: ['credentials_incomplete', 'registration_incomplete'],
      },
    };
    const credentialed: WebhookIngressView = {
      ...created,
      intake_state: 'verification_pending',
      configured_fields: ['webhook_secret'],
      missing_required_fields: [],
      active_credential_versions: [{
        version: '1',
        created_at: 2,
        retired_at: null,
        last_verified_at: null,
      }],
      readiness: {
        ...created.readiness,
        credentials_complete: true,
        local_configuration_complete: true,
        blockers: ['registration_incomplete'],
      },
    };
    const registered: WebhookIngressView = {
      ...credentialed,
      registration_state: 'registered',
      intake_state: 'ready',
      active_credential_versions: [{
        ...credentialed.active_credential_versions[0]!,
        last_verified_at: null,
      }],
      readiness: {
        ...credentialed.readiness,
        registration_complete: true,
        registration_endpoint_matches: true,
        can_enable: true,
        blockers: [],
      },
    };
    let setupCredentialVerified = false;
    const enabled = (): WebhookIngressView => ({
      ...registered,
      intake_state: 'enabled',
      active_credential_versions: [{
        ...registered.active_credential_versions[0]!,
        last_verified_at: setupCredentialVerified ? 3 : null,
      }],
    });
    let phase:
      | 'empty'
      | 'created'
      | 'credentialed'
      | 'registered'
      | 'enabled'
      | 'rotated' = 'empty';
    let newCredentialVerified = false;
    const rotated = (): WebhookIngressView => {
      const currentEnabled = enabled();
      return {
        ...currentEnabled,
        active_credential_versions: [{
          version: '2',
          created_at: 4,
          retired_at: null,
          last_verified_at: newCredentialVerified ? 5 : null,
        }, currentEnabled.active_credential_versions[0]!],
      };
    };
    const currentIngress = (): WebhookIngressView | null => {
      if (phase === 'created') return created;
      if (phase === 'credentialed') return credentialed;
      if (phase === 'registered') return registered;
      if (phase === 'enabled') return enabled();
      if (phase === 'rotated') return rotated();
      return null;
    };
    const runCreate = vi.fn(async () => {
      phase = 'created';
      return { ingress: created };
    });
    const runWrite = vi.fn(async () => {
      if (phase === 'created') {
        phase = 'credentialed';
        return {
          ingress: credentialed,
          credential_version: credentialed.active_credential_versions[0]!,
          one_time_generated_credentials: { webhook_secret: firstSecret },
        };
      }
      if (phase === 'enabled') {
        phase = 'rotated';
        const ingress = rotated();
        return {
          ingress,
          credential_version: ingress.active_credential_versions[0]!,
          one_time_generated_credentials: { webhook_secret: rotatedSecret },
        };
      }
      throw new Error(`unexpected GitHub credential write during ${phase}`);
    });
    const runManualConfirm = vi.fn(async () => {
      phase = 'registered';
      return { ingress: registered };
    });
    const runEnable = vi.fn(async () => {
      phase = 'enabled';
      return { ingress: enabled() };
    });
    const runCredentialRetire = vi.fn(async () => ({ ingress: rotated() }));
    const runReconcile = vi.fn(async () => ({ ingress: registered }));
    const route = bootstrapConnectionsRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      initialTab: 'webhooks',
      webhooksListCaller: vi.fn(async () => {
        const ingress = currentIngress();
        return webhookList(ingress ? [ingress] : []);
      }),
      webhooksCreateCaller: runCreate,
      webhooksCredentialWriteCaller: runWrite,
      webhooksCredentialRetireCaller: runCredentialRetire,
      webhooksManualConfirmCaller: runManualConfirm,
      webhooksRegistrationReconcileCaller: runReconcile,
      webhooksEnableCaller: runEnable,
      webhooksDisableCaller: vi.fn(async () => ({ ingress: enabled() })),
    });
    await route.webhooksPanel()!.refresh();
    collectByAttr(root, WEBHOOKS_PANEL_NEW_ATTR)[0]!.click();

    const profile = collectByAttr(root, WEBHOOKS_PANEL_PROFILE_ATTR)[0]!;
    profile.value = 'github.webhook.v1';
    fire(profile, 'change', { target: profile });
    const environment = collectByAttr(root, WEBHOOKS_PANEL_ENVIRONMENT_ATTR)[0]!;
    expect(environment.children.map((option) => option.value)).toEqual([
      'test',
      'live',
      'custom',
    ]);
    environment.value = 'live';
    const mode = collectByAttr(root, WEBHOOKS_PANEL_REGISTRATION_MODE_ATTR)[0]!;
    expect(mode.children.map((option) => option.value)).toEqual([
      'manual',
      'managed_endpoint',
    ]);
    expect(collectByAttr(root, WEBHOOKS_PANEL_PAIRED_CONNECTION_ATTR)).toEqual([]);
    expect(findByAttrValue(root, WEBHOOKS_PANEL_FIELD_ATTR, 'webhook_secret')).toBeNull();
    expect(treeText(root)).toContain('Content type');
    expect(treeText(root)).toContain('application/json');
    expect(treeText(root)).toContain('SSL verification enabled');
    expect(treeText(root)).toContain('Let me select individual events');
    expect(treeText(root)).toContain('leave Active selected');
    expect(treeText(root)).toContain('immediate ping while Recued intake is still closed');
    const events = collectByAttr(root, WEBHOOKS_PANEL_EVENT_TYPE_ATTR);
    expect(events.every((input) => input.checked === false)).toBe(true);
    const issues = findByAttrValue(root, WEBHOOKS_PANEL_EVENT_TYPE_ATTR, 'issues')!;
    const pullRequest = findByAttrValue(
      root,
      WEBHOOKS_PANEL_EVENT_TYPE_ATTR,
      'pull_request',
    )!;
    findByAttrValue(root, WEBHOOKS_PANEL_FIELD_ATTR, 'display_name')!.value =
      'GitHub repository events';
    fire(findByAttrValue(root, WEBHOOKS_PANEL_FORM_ATTR, 'create')!, 'submit', {
      preventDefault() {},
    });
    expect(runCreate).not.toHaveBeenCalled();

    issues.checked = true;
    pullRequest.checked = true;
    fire(findByAttrValue(root, WEBHOOKS_PANEL_FORM_ATTR, 'create')!, 'submit', {
      preventDefault() {},
    });
    await tick();

    expect(runCreate).toHaveBeenCalledWith({
      display_name: 'GitHub repository events',
      profile_id: 'github.webhook.v1',
      environment: 'live',
      registration_mode: 'manual',
      selected_event_types: ['issues', 'pull_request'],
    });
    expect(runWrite).toHaveBeenLastCalledWith({
      ingress_id: created.ingress_id,
      credentials: {},
    });
    expect(treeText(root)).toContain(`webhook_secret: ${firstSecret}`);
    expect(treeText(root)).toContain('Payload URL');
    expect(treeText(root)).toContain('Content type to application/json');
    expect(treeText(root)).toContain('choose Let me select individual events');
    expect(treeText(root)).toContain('subscribe to exactly these event types: issues, pull_request');
    expect(treeText(root)).toContain('leave Active selected');
    expect(treeText(root)).toContain('does not automatically redeliver a failure');
    expect(treeText(root)).toContain('open Recent deliveries and Redeliver that ping');
    expect(findByAttrValue(root, WEBHOOKS_PANEL_ACTION_ATTR, 'registration-reconcile'))
      .toBeNull();
    expect(runReconcile).not.toHaveBeenCalled();
    findByAttrValue(root, WEBHOOKS_PANEL_ACTION_ATTR, 'manual-confirm')!.click();
    await tick();
    expect(runManualConfirm).toHaveBeenCalledWith({ ingress_id: created.ingress_id });
    expect(runEnable).not.toHaveBeenCalled();
    findByAttrValue(root, WEBHOOKS_PANEL_ACTION_ATTR, 'enable')!.click();
    await tick();
    expect(runEnable).toHaveBeenCalledWith({ ingress_id: created.ingress_id });
    expect(treeText(root)).toContain('v1 (not checked yet)');

    // Model the owner redelivering GitHub's setup ping after explicit enablement.
    setupCredentialVerified = true;
    await route.webhooksPanel()!.refresh();
    expect(treeText(root)).toContain('v1 (verified)');

    findByAttrValue(root, WEBHOOKS_PANEL_ACTION_ATTR, 'credentials')!.click();
    expect(treeText(root)).toContain('GitHub accepts one secret for a hook');
    expect(treeText(root)).toContain('accepted delivery verified by the new credential');
    fire(findByAttrValue(root, WEBHOOKS_PANEL_FORM_ATTR, 'credentials')!, 'submit', {
      preventDefault() {},
    });
    await tick();
    expect(runWrite).toHaveBeenCalledTimes(2);
    expect(runWrite).toHaveBeenLastCalledWith({
      ingress_id: created.ingress_id,
      credentials: {},
    });
    expect(treeText(root)).toContain(`webhook_secret: ${rotatedSecret}`);
    expect(treeText(root)).not.toContain(firstSecret);
    expect(treeText(root)).toContain('update this same GitHub hook to the new secret');
    const pendingRetirement = collectByAttr(root, WEBHOOKS_PANEL_ACTION_ATTR)
      .filter((action) => action.getAttribute(WEBHOOKS_PANEL_ACTION_ATTR)
        === 'credential-retire');
    expect(pendingRetirement.map((action) => [action.textContent, action.disabled]))
      .toEqual([
        ['Retire key v2', false],
        ['Retire key v1', true],
      ]);

    newCredentialVerified = true;
    await route.webhooksPanel()!.refresh();
    const verifiedRetirement = collectByAttr(root, WEBHOOKS_PANEL_ACTION_ATTR)
      .filter((action) => action.getAttribute(WEBHOOKS_PANEL_ACTION_ATTR)
        === 'credential-retire');
    expect(verifiedRetirement.map((action) => [action.textContent, action.disabled]))
      .toEqual([
        ['Retire key v2', false],
        ['Retire key v1', false],
      ]);
    expect(runCredentialRetire).not.toHaveBeenCalled();
    route.dispose();
  });

  it('creates managed GitHub only with an explicit repository or organization target', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const base = readyWebhook();
    const created: WebhookIngressView = {
      ...base,
      display_name: 'Managed GitHub repository events',
      profile_id: 'github.webhook.v1',
      environment: 'live',
      paired_connection_id: 'github-pat',
      registration_target: { kind: 'repository', key: 'openai/example' },
      registration_mode: 'managed_endpoint',
      remote_endpoint_id: null,
      selected_event_types: ['issues', 'pull_request'],
      registration_state: 'managed_pending',
      intake_state: 'draft',
      configured_fields: [],
      missing_required_fields: ['webhook_secret'],
      active_credential_versions: [],
      readiness: {
        ...base.readiness,
        credentials_complete: false,
        registration_complete: false,
        local_configuration_complete: false,
        can_enable: false,
        blockers: ['credentials_incomplete', 'registration_incomplete'],
      },
    };
    let persisted = false;
    const runCreate = vi.fn(async () => {
      persisted = true;
      return { ingress: created };
    });
    const runWrite = vi.fn(async () => ({
      ingress: created,
      credential_version: {
        version: '1',
        created_at: 2,
        retired_at: null,
        last_verified_at: null,
      },
    }));
    const runReconcile = vi.fn(async () => ({ ingress: created }));
    const route = bootstrapConnectionsRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      initialTab: 'webhooks',
      webhooksListCaller: vi.fn(async () => webhookList(
        persisted ? [created] : [],
      )),
      webhooksCreateCaller: runCreate,
      webhooksCredentialWriteCaller: runWrite,
      webhooksCredentialRetireCaller: vi.fn(async () => ({ ingress: created })),
      webhooksManualConfirmCaller: vi.fn(async () => ({ ingress: created })),
      webhooksRegistrationReconcileCaller: runReconcile,
      webhooksEnableCaller: vi.fn(async () => ({ ingress: created })),
      webhooksDisableCaller: vi.fn(async () => ({ ingress: created })),
    });
    await route.webhooksPanel()!.refresh();
    collectByAttr(root, WEBHOOKS_PANEL_NEW_ATTR)[0]!.click();

    const profile = collectByAttr(root, WEBHOOKS_PANEL_PROFILE_ATTR)[0]!;
    profile.value = 'github.webhook.v1';
    fire(profile, 'change', { target: profile });
    const mode = collectByAttr(root, WEBHOOKS_PANEL_REGISTRATION_MODE_ATTR)[0]!;
    mode.value = 'managed_endpoint';
    fire(mode, 'change', { target: mode });
    collectByAttr(root, WEBHOOKS_PANEL_ENVIRONMENT_ATTR)[0]!.value = 'live';
    const targetKind = collectByAttr(
      root,
      WEBHOOKS_PANEL_REGISTRATION_TARGET_KIND_ATTR,
    )[0]!;
    expect(targetKind.children.map((option) => option.value)).toEqual([
      'repository',
      'organization',
    ]);
    expect(treeText(root)).toContain('personal access token');
    expect(findByAttrValue(root, WEBHOOKS_PANEL_FIELD_ATTR, 'webhook_secret')).toBeNull();
    findByAttrValue(root, WEBHOOKS_PANEL_FIELD_ATTR, 'display_name')!.value =
      'Managed GitHub repository events';
    const events = collectByAttr(root, WEBHOOKS_PANEL_EVENT_TYPE_ATTR);
    for (const input of events) {
      input.checked = input.value === 'issues' || input.value === 'pull_request';
    }
    collectByAttr(root, WEBHOOKS_PANEL_PAIRED_CONNECTION_ATTR)[0]!.value =
      ' github-pat ';
    collectByAttr(root, WEBHOOKS_PANEL_REGISTRATION_TARGET_KEY_ATTR)[0]!.value =
      ' OpenAI/Example ';
    fire(findByAttrValue(root, WEBHOOKS_PANEL_FORM_ATTR, 'create')!, 'submit', {
      preventDefault() {},
    });
    await tick();

    expect(runCreate).toHaveBeenCalledWith({
      display_name: 'Managed GitHub repository events',
      profile_id: 'github.webhook.v1',
      environment: 'live',
      paired_connection_id: 'github-pat',
      registration_target: { kind: 'repository', key: 'openai/example' },
      registration_mode: 'managed_endpoint',
      selected_event_types: ['issues', 'pull_request'],
    });
    expect(runWrite).not.toHaveBeenCalled();
    expect(treeText(root)).toContain('Where it is set up repository: openai/example');
    expect(treeText(root)).toContain('refuses ambiguous or foreign hooks');
    expect(treeText(root)).toContain('immediate setup ping before you let messages in');
    expect(treeText(root)).toContain('will not retry that failure automatically');
    expect(treeText(root)).toContain('Recent deliveries to redeliver that ping');
    expect(findByAttrValue(root, WEBHOOKS_PANEL_ACTION_ATTR, 'credentials')).toBeNull();
    const reconcile = findByAttrValue(
      root,
      WEBHOOKS_PANEL_ACTION_ATTR,
      'registration-reconcile',
    );
    expect(reconcile).toMatchObject({
      textContent: 'Set up the address at the service',
      disabled: false,
    });
    reconcile?.click();
    await tick();
    expect(runReconcile).toHaveBeenCalledWith({ ingress_id: created.ingress_id });
    route.dispose();
  });

  it('creates manual Telegram with one-time generated setWebhook material', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const base = readyWebhook();
    const created: WebhookIngressView = {
      ...base,
      display_name: 'Telegram bot updates',
      profile_id: 'telegram.bot-webhook.v1',
      environment: 'custom',
      paired_connection_id: null,
      registration_mode: 'manual',
      selected_event_types: ['message', 'callback_query'],
      registration_state: 'manual_pending',
      intake_state: 'draft',
      configured_fields: [],
      missing_required_fields: ['secret_token'],
      active_credential_versions: [],
      readiness: {
        ...base.readiness,
        credentials_complete: false,
        registration_complete: false,
        local_configuration_complete: false,
        can_enable: false,
        blockers: ['credentials_incomplete', 'registration_incomplete'],
      },
    };
    const credentialed: WebhookIngressView = {
      ...created,
      intake_state: 'verification_pending',
      configured_fields: ['secret_token'],
      missing_required_fields: [],
      active_credential_versions: [{
        version: '1',
        created_at: 2,
        retired_at: null,
        last_verified_at: null,
      }],
      readiness: {
        ...created.readiness,
        credentials_complete: true,
        local_configuration_complete: true,
        blockers: ['registration_incomplete'],
      },
    };
    let persisted = false;
    let credentialPersisted = false;
    let credentialWriteAttempts = 0;
    const runCreate = vi.fn(async () => {
      persisted = true;
      return { ingress: created };
    });
    const runWrite = vi.fn(async () => {
      credentialWriteAttempts += 1;
      if (credentialWriteAttempts > 1) {
        throw new Error('telegram credential rotation failed');
      }
      credentialPersisted = true;
      return {
        ingress: credentialed,
        credential_version: credentialed.active_credential_versions[0]!,
        one_time_generated_credentials: {
          secret_token: 'telegram-generated-once',
        },
      };
    });
    const runManualConfirm = vi.fn(async () => ({ ingress: credentialed }));
    const runReconcile = vi.fn(async () => ({ ingress: credentialed }));
    const route = bootstrapConnectionsRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      initialTab: 'webhooks',
      webhooksListCaller: vi.fn(async () => webhookList(
        credentialPersisted
          ? [credentialed]
          : persisted ? [created] : [],
      )),
      webhooksCreateCaller: runCreate,
      webhooksCredentialWriteCaller: runWrite,
      webhooksCredentialRetireCaller: vi.fn(async () => ({ ingress: credentialed })),
      webhooksManualConfirmCaller: runManualConfirm,
      webhooksRegistrationReconcileCaller: runReconcile,
      webhooksEnableCaller: vi.fn(async () => ({ ingress: credentialed })),
      webhooksDisableCaller: vi.fn(async () => ({ ingress: credentialed })),
    });
    await route.webhooksPanel()!.refresh();
    collectByAttr(root, WEBHOOKS_PANEL_NEW_ATTR)[0]!.click();

    const profile = collectByAttr(root, WEBHOOKS_PANEL_PROFILE_ATTR)[0]!;
    profile.value = 'telegram.bot-webhook.v1';
    fire(profile, 'change', { target: profile });
    const environment = collectByAttr(root, WEBHOOKS_PANEL_ENVIRONMENT_ATTR)[0]!;
    expect(environment.children.map((option) => option.value)).toEqual([
      'test',
      'live',
      'custom',
    ]);
    environment.value = 'custom';
    const mode = collectByAttr(root, WEBHOOKS_PANEL_REGISTRATION_MODE_ATTR)[0]!;
    expect(mode.children.map((option) => option.value)).toEqual([
      'manual',
      'managed_endpoint',
    ]);
    expect(collectByAttr(root, WEBHOOKS_PANEL_PAIRED_CONNECTION_ATTR)).toEqual([]);
    expect(findByAttrValue(root, WEBHOOKS_PANEL_FIELD_ATTR, 'secret_token')).toBeNull();
    expect(treeText(root)).toContain('call Telegram Bot API setWebhook');
    const events = collectByAttr(root, WEBHOOKS_PANEL_EVENT_TYPE_ATTR);
    expect(events.map((input) => input.value)).toEqual([
      'message',
      'edited_message',
      'callback_query',
    ]);
    expect(events.every((input) => input.checked === false)).toBe(true);
    findByAttrValue(root, WEBHOOKS_PANEL_FIELD_ATTR, 'display_name')!.value =
      'Telegram bot updates';
    fire(findByAttrValue(root, WEBHOOKS_PANEL_FORM_ATTR, 'create')!, 'submit', {
      preventDefault() {},
    });
    expect(runCreate).not.toHaveBeenCalled();

    for (const input of events) {
      input.checked = input.value === 'message' || input.value === 'callback_query';
    }
    fire(findByAttrValue(root, WEBHOOKS_PANEL_FORM_ATTR, 'create')!, 'submit', {
      preventDefault() {},
    });
    await tick();

    expect(runCreate).toHaveBeenCalledWith({
      display_name: 'Telegram bot updates',
      profile_id: 'telegram.bot-webhook.v1',
      environment: 'custom',
      registration_mode: 'manual',
      selected_event_types: ['message', 'callback_query'],
    });
    expect(runWrite).toHaveBeenCalledWith({
      ingress_id: created.ingress_id,
      credentials: {},
    });
    expect(treeText(root)).toContain('secret_token: telegram-generated-once');
    expect(treeText(root)).toContain('as allowed_updates');
    expect(findByAttrValue(root, WEBHOOKS_PANEL_ACTION_ATTR, 'registration-reconcile'))
      .toBeNull();
    expect(runReconcile).not.toHaveBeenCalled();
    const confirm = findByAttrValue(root, WEBHOOKS_PANEL_ACTION_ATTR, 'manual-confirm')!;
    expect(confirm.disabled).toBe(false);
    confirm.click();
    await tick();
    expect(runManualConfirm).toHaveBeenCalledWith({ ingress_id: created.ingress_id });

    findByAttrValue(root, WEBHOOKS_PANEL_ACTION_ATTR, 'credentials')!.click();
    expect(treeText(root)).toContain('shows it to you once');
    fire(findByAttrValue(root, WEBHOOKS_PANEL_FORM_ATTR, 'credentials')!, 'submit', {
      preventDefault() {},
    });
    await tick();
    expect(runWrite).toHaveBeenCalledTimes(2);
    expect(treeText(root)).toContain('telegram credential rotation failed');
    expect(treeText(root)).not.toContain('telegram-generated-once');
    route.dispose();
  });

  it('creates managed Telegram without exposing either bot or webhook credentials', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const created: WebhookIngressView = {
      ...readyWebhook(),
      display_name: 'Managed Telegram updates',
      profile_id: 'telegram.bot-webhook.v1',
      environment: 'live',
      paired_connection_id: 'telegram-bot',
      registration_mode: 'managed_endpoint',
      remote_endpoint_id: null,
      selected_event_types: ['message'],
      registration_state: 'managed_pending',
      intake_state: 'draft',
      configured_fields: [],
      missing_required_fields: ['secret_token'],
      active_credential_versions: [],
    };
    let persisted = false;
    const runCreate = vi.fn(async () => {
      persisted = true;
      return { ingress: created };
    });
    const runWrite = vi.fn(async () => ({
      ingress: created,
      credential_version: {
        version: '1',
        created_at: 2,
        retired_at: null,
        last_verified_at: null,
      },
    }));
    const runReconcile = vi.fn(async () => ({ ingress: created }));
    const route = bootstrapConnectionsRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      initialTab: 'webhooks',
      webhooksListCaller: vi.fn(async () => webhookList(
        persisted ? [created] : [],
      )),
      webhooksCreateCaller: runCreate,
      webhooksCredentialWriteCaller: runWrite,
      webhooksCredentialRetireCaller: vi.fn(async () => ({ ingress: created })),
      webhooksManualConfirmCaller: vi.fn(async () => ({ ingress: created })),
      webhooksRegistrationReconcileCaller: runReconcile,
      webhooksEnableCaller: vi.fn(async () => ({ ingress: created })),
      webhooksDisableCaller: vi.fn(async () => ({ ingress: created })),
    });
    await route.webhooksPanel()!.refresh();
    collectByAttr(root, WEBHOOKS_PANEL_NEW_ATTR)[0]!.click();

    const profile = collectByAttr(root, WEBHOOKS_PANEL_PROFILE_ATTR)[0]!;
    profile.value = 'telegram.bot-webhook.v1';
    fire(profile, 'change', { target: profile });
    const mode = collectByAttr(root, WEBHOOKS_PANEL_REGISTRATION_MODE_ATTR)[0]!;
    mode.value = 'managed_endpoint';
    fire(mode, 'change', { target: mode });
    collectByAttr(root, WEBHOOKS_PANEL_ENVIRONMENT_ATTR)[0]!.value = 'live';
    expect(treeText(root)).toContain('verifies the bot has no conflicting webhook');
    expect(findByAttrValue(root, WEBHOOKS_PANEL_FIELD_ATTR, 'secret_token')).toBeNull();
    findByAttrValue(root, WEBHOOKS_PANEL_FIELD_ATTR, 'display_name')!.value =
      'Managed Telegram updates';
    const events = collectByAttr(root, WEBHOOKS_PANEL_EVENT_TYPE_ATTR);
    for (const input of events) input.checked = input.value === 'message';
    collectByAttr(root, WEBHOOKS_PANEL_PAIRED_CONNECTION_ATTR)[0]!.value =
      ' telegram-bot ';
    fire(findByAttrValue(root, WEBHOOKS_PANEL_FORM_ATTR, 'create')!, 'submit', {
      preventDefault() {},
    });
    await tick();

    expect(runCreate).toHaveBeenCalledWith({
      display_name: 'Managed Telegram updates',
      profile_id: 'telegram.bot-webhook.v1',
      environment: 'live',
      paired_connection_id: 'telegram-bot',
      registration_mode: 'managed_endpoint',
      selected_event_types: ['message'],
    });
    expect(runWrite).not.toHaveBeenCalled();
    expect(findByAttrValue(root, WEBHOOKS_PANEL_ACTION_ATTR, 'credentials')).toBeNull();
    expect(treeText(root)).toContain('preserves the encrypted generated token');
    const reconcile = findByAttrValue(
      root,
      WEBHOOKS_PANEL_ACTION_ATTR,
      'registration-reconcile',
    );
    expect(reconcile).toMatchObject({
      textContent: 'Set up the address at the service',
      disabled: false,
    });
    reconcile?.click();
    await tick();
    expect(runReconcile).toHaveBeenCalledWith({ ingress_id: created.ingress_id });
    route.dispose();
  });

  it('creates managed Paddle only through a paired environment-matching API connection', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const base = readyWebhook();
    const created: WebhookIngressView = {
      ...base,
      display_name: 'Managed Paddle sandbox events',
      profile_id: 'paddle.notification.v1',
      environment: 'test',
      paired_connection_id: 'paddle-sandbox',
      registration_target: null,
      registration_mode: 'managed_endpoint',
      remote_endpoint_id: null,
      selected_event_types: ['transaction.completed'],
      registration_state: 'managed_pending',
      intake_state: 'draft',
      configured_fields: [],
      missing_required_fields: ['endpoint_secret_key'],
      active_credential_versions: [],
      readiness: {
        ...base.readiness,
        credentials_complete: false,
        registration_complete: false,
        local_configuration_complete: false,
        can_enable: false,
        blockers: ['credentials_incomplete', 'registration_incomplete'],
      },
    };
    let persisted = false;
    const runCreate = vi.fn(async () => {
      persisted = true;
      return { ingress: created };
    });
    const runWrite = vi.fn(async () => ({
      ingress: created,
      credential_version: {
        version: '1',
        created_at: 2,
        retired_at: null,
        last_verified_at: null,
      },
    }));
    const runReconcile = vi.fn(async () => ({ ingress: created }));
    const route = bootstrapConnectionsRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      initialTab: 'webhooks',
      webhooksListCaller: vi.fn(async () => webhookList(
        persisted ? [created] : [],
      )),
      webhooksCreateCaller: runCreate,
      webhooksCredentialWriteCaller: runWrite,
      webhooksCredentialRetireCaller: vi.fn(async () => ({ ingress: created })),
      webhooksManualConfirmCaller: vi.fn(async () => ({ ingress: created })),
      webhooksRegistrationReconcileCaller: runReconcile,
      webhooksEnableCaller: vi.fn(async () => ({ ingress: created })),
      webhooksDisableCaller: vi.fn(async () => ({ ingress: created })),
    });
    await route.webhooksPanel()!.refresh();
    collectByAttr(root, WEBHOOKS_PANEL_NEW_ATTR)[0]!.click();

    const profile = collectByAttr(root, WEBHOOKS_PANEL_PROFILE_ATTR)[0]!;
    profile.value = 'paddle.notification.v1';
    fire(profile, 'change', { target: profile });
    const mode = collectByAttr(root, WEBHOOKS_PANEL_REGISTRATION_MODE_ATTR)[0]!;
    expect(mode.children.map((option) => option.value)).toEqual([
      'manual',
      'managed_endpoint',
    ]);
    mode.value = 'managed_endpoint';
    fire(mode, 'change', { target: mode });
    collectByAttr(root, WEBHOOKS_PANEL_ENVIRONMENT_ATTR)[0]!.value = 'test';
    expect(treeText(root)).toContain('modern Sandbox key for test');
    expect(treeText(root)).toContain('refuses ambiguous destinations');
    expect(findByAttrValue(root, WEBHOOKS_PANEL_FIELD_ATTR, 'endpoint_secret_key'))
      .toBeNull();
    expect(collectByAttr(root, WEBHOOKS_PANEL_REGISTRATION_TARGET_KIND_ATTR))
      .toEqual([]);
    findByAttrValue(root, WEBHOOKS_PANEL_FIELD_ATTR, 'display_name')!.value =
      'Managed Paddle sandbox events';
    collectByAttr(root, WEBHOOKS_PANEL_PAIRED_CONNECTION_ATTR)[0]!.value =
      ' paddle-sandbox ';
    findByAttrValue(
      root,
      WEBHOOKS_PANEL_EVENT_TYPE_ATTR,
      'transaction.completed',
    )!.checked = true;
    fire(findByAttrValue(root, WEBHOOKS_PANEL_FORM_ATTR, 'create')!, 'submit', {
      preventDefault() {},
    });
    await tick();

    expect(runCreate).toHaveBeenCalledWith({
      display_name: 'Managed Paddle sandbox events',
      profile_id: 'paddle.notification.v1',
      environment: 'test',
      paired_connection_id: 'paddle-sandbox',
      registration_mode: 'managed_endpoint',
      selected_event_types: ['transaction.completed'],
    });
    expect(runWrite).not.toHaveBeenCalled();
    expect(treeText(root)).toContain('matching Paddle Sandbox account');
    expect(treeText(root)).toContain('platform and simulation traffic');
    expect(treeText(root)).toContain('provider-generated endpoint secret');
    expect(findByAttrValue(root, WEBHOOKS_PANEL_ACTION_ATTR, 'credentials')).toBeNull();
    expect(findByAttrValue(root, WEBHOOKS_PANEL_ACTION_ATTR, 'manual-confirm')).toBeNull();
    const reconcile = findByAttrValue(
      root,
      WEBHOOKS_PANEL_ACTION_ATTR,
      'registration-reconcile',
    );
    expect(reconcile).toMatchObject({
      textContent: 'Set up the address at the service',
      disabled: false,
    });
    reconcile?.click();
    await tick();
    expect(runReconcile).toHaveBeenCalledWith({ ingress_id: created.ingress_id });
    route.dispose();
  });

  it('creates a manual Paddle destination and keeps secret rotation overlap safe', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const base = readyWebhook();
    const firstSecret = `pdl_ntfset_${'a'.repeat(26)}_${'A'.repeat(32)}`;
    const rotatedSecret = `pdl_ntfset_${'b'.repeat(26)}_${'B'.repeat(32)}`;
    const created: WebhookIngressView = {
      ...base,
      display_name: 'Paddle sandbox lifecycle',
      profile_id: 'paddle.notification.v1',
      environment: 'test',
      paired_connection_id: null,
      registration_mode: 'manual',
      selected_event_types: ['subscription.updated', 'transaction.completed'],
      registration_state: 'manual_pending',
      intake_state: 'draft',
      configured_fields: [],
      missing_required_fields: ['endpoint_secret_key'],
      active_credential_versions: [],
      readiness: {
        ...base.readiness,
        credentials_complete: false,
        registration_complete: false,
        registration_endpoint_matches: false,
        local_configuration_complete: false,
        can_enable: false,
        blockers: ['credentials_incomplete', 'registration_incomplete'],
      },
    };
    const credentialed: WebhookIngressView = {
      ...created,
      intake_state: 'verification_pending',
      configured_fields: ['endpoint_secret_key'],
      missing_required_fields: [],
      active_credential_versions: [{
        version: '1',
        created_at: 2,
        retired_at: null,
        last_verified_at: null,
      }],
      readiness: {
        ...created.readiness,
        credentials_complete: true,
        local_configuration_complete: true,
        blockers: ['registration_incomplete'],
      },
    };
    const registered: WebhookIngressView = {
      ...credentialed,
      registration_state: 'registered',
      intake_state: 'ready',
      readiness: {
        ...credentialed.readiness,
        registration_complete: true,
        registration_endpoint_matches: true,
        can_enable: true,
        blockers: [],
      },
    };
    let firstCredentialVerified = false;
    const enabled = (): WebhookIngressView => ({
      ...registered,
      intake_state: 'enabled',
      active_credential_versions: [{
        ...registered.active_credential_versions[0]!,
        last_verified_at: firstCredentialVerified ? 3 : null,
      }],
    });
    let replacementCredentialVerified = false;
    const rotated = (): WebhookIngressView => {
      const current = enabled();
      return {
        ...current,
        active_credential_versions: [{
          version: '2',
          created_at: 4,
          retired_at: null,
          last_verified_at: replacementCredentialVerified ? 5 : null,
        }, current.active_credential_versions[0]!],
      };
    };
    const disabled = (): WebhookIngressView => ({
      ...rotated(),
      intake_state: 'disabled',
    });
    let phase:
      | 'empty'
      | 'created'
      | 'credentialed'
      | 'registered'
      | 'enabled'
      | 'rotated'
      | 'disabled' = 'empty';
    const currentIngress = (): WebhookIngressView | null => {
      if (phase === 'created') return created;
      if (phase === 'credentialed') return credentialed;
      if (phase === 'registered') return registered;
      if (phase === 'enabled') return enabled();
      if (phase === 'rotated') return rotated();
      if (phase === 'disabled') return disabled();
      return null;
    };
    const runCreate = vi.fn(async () => {
      phase = 'created';
      return { ingress: created };
    });
    const runWrite = vi.fn(async () => {
      if (phase === 'created') {
        phase = 'credentialed';
        return {
          ingress: credentialed,
          credential_version: credentialed.active_credential_versions[0]!,
        };
      }
      if (phase === 'enabled') {
        phase = 'rotated';
        const ingress = rotated();
        return {
          ingress,
          credential_version: ingress.active_credential_versions[0]!,
        };
      }
      throw new Error(`unexpected Paddle credential write during ${phase}`);
    });
    const runManualConfirm = vi.fn(async () => {
      phase = 'registered';
      return { ingress: registered };
    });
    const runEnable = vi.fn(async () => {
      phase = 'enabled';
      return { ingress: enabled() };
    });
    const runDisable = vi.fn(async () => {
      phase = 'disabled';
      return { ingress: disabled() };
    });
    const runReconcile = vi.fn(async () => ({ ingress: created }));
    const runTestDelivery = vi.fn(async () => ({
      ingress: enabled(),
      delivery_id: 'whd_should_not_run',
      observed_at: 5,
    }));
    const runRetire = vi.fn(async () => ({
      ingress: {
        ...disabled(),
        registration_state: 'retired' as const,
        intake_state: 'retired' as const,
      },
    }));
    const route = bootstrapConnectionsRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      initialTab: 'webhooks',
      webhooksListCaller: vi.fn(async () => {
        const ingress = currentIngress();
        return webhookList(ingress ? [ingress] : []);
      }),
      webhooksCreateCaller: runCreate,
      webhooksCredentialWriteCaller: runWrite,
      webhooksCredentialRetireCaller: vi.fn(async () => ({ ingress: rotated() })),
      webhooksManualConfirmCaller: runManualConfirm,
      webhooksRegistrationReconcileCaller: runReconcile,
      webhooksEnableCaller: runEnable,
      webhooksDisableCaller: runDisable,
      webhooksTestDeliveryCaller: runTestDelivery,
      webhooksRetireCaller: runRetire,
    });
    await route.webhooksPanel()!.refresh();
    collectByAttr(root, WEBHOOKS_PANEL_NEW_ATTR)[0]!.click();

    const profile = collectByAttr(root, WEBHOOKS_PANEL_PROFILE_ATTR)[0]!;
    profile.value = 'paddle.notification.v1';
    fire(profile, 'change', { target: profile });
    const environment = collectByAttr(root, WEBHOOKS_PANEL_ENVIRONMENT_ATTR)[0]!;
    expect(environment.children.map((option) => option.value)).toEqual(['test', 'live']);
    const mode = collectByAttr(root, WEBHOOKS_PANEL_REGISTRATION_MODE_ATTR)[0]!;
    expect(mode.children.map((option) => option.value)).toEqual([
      'manual',
      'managed_endpoint',
    ]);
    expect(collectByAttr(root, WEBHOOKS_PANEL_PAIRED_CONNECTION_ATTR)).toEqual([]);
    expect(findByAttrValue(root, WEBHOOKS_PANEL_FIELD_ATTR, 'endpoint_secret_key')).toBeNull();
    expect(treeText(root)).toContain('matching Paddle Sandbox account for test');
    expect(treeText(root)).toContain('Endpoint secret key with Add keys');
    const eventTypes = collectByAttr(root, WEBHOOKS_PANEL_EVENT_TYPE_ATTR);
    expect(eventTypes).toHaveLength(68);
    expect(eventTypes.every((input) => input.checked === false)).toBe(true);
    const subscriptionUpdated = findByAttrValue(
      root,
      WEBHOOKS_PANEL_EVENT_TYPE_ATTR,
      'subscription.updated',
    )!;
    const transactionCompleted = findByAttrValue(
      root,
      WEBHOOKS_PANEL_EVENT_TYPE_ATTR,
      'transaction.completed',
    )!;
    findByAttrValue(root, WEBHOOKS_PANEL_FIELD_ATTR, 'display_name')!.value =
      'Paddle sandbox lifecycle';
    fire(findByAttrValue(root, WEBHOOKS_PANEL_FORM_ATTR, 'create')!, 'submit', {
      preventDefault() {},
    });
    expect(runCreate).not.toHaveBeenCalled();

    subscriptionUpdated.checked = true;
    transactionCompleted.checked = true;
    fire(findByAttrValue(root, WEBHOOKS_PANEL_FORM_ATTR, 'create')!, 'submit', {
      preventDefault() {},
    });
    await tick();

    expect(runCreate).toHaveBeenCalledWith({
      display_name: 'Paddle sandbox lifecycle',
      profile_id: 'paddle.notification.v1',
      environment: 'test',
      registration_mode: 'manual',
      selected_event_types: ['subscription.updated', 'transaction.completed'],
    });
    expect(runWrite).not.toHaveBeenCalled();
    expect(treeText(root)).toContain(created.endpoint_url!);
    expect(treeText(root)).toContain('matching Paddle Sandbox account');
    expect(treeText(root)).toContain('Developer tools > Notifications > New destination');
    expect(treeText(root)).toContain('API version to 1');
    expect(treeText(root)).toContain('Usage type to Platform and simulation');
    expect(treeText(root)).toContain('overflow menu > Edit destination');
    expect(treeText(root)).toContain(
      'subscribe to exactly these event types: subscription.updated, transaction.completed',
    );
    expect(treeText(root)).toContain('Use Paddle simulator after enablement');
    expect(treeText(root)).toContain('Developer tools > Simulations > New simulation');
    expect(treeText(root)).toContain('Recued does not synthesize Paddle deliveries');
    expect(findByAttrValue(root, WEBHOOKS_PANEL_ACTION_ATTR, 'registration-reconcile'))
      .toBeNull();
    expect(findByAttrValue(root, WEBHOOKS_PANEL_ACTION_ATTR, 'test-delivery')).toBeNull();
    expect(runReconcile).not.toHaveBeenCalled();
    expect(runTestDelivery).not.toHaveBeenCalled();
    expect(findByAttrValue(root, WEBHOOKS_PANEL_ACTION_ATTR, 'manual-confirm')?.disabled)
      .toBe(true);

    findByAttrValue(root, WEBHOOKS_PANEL_ACTION_ATTR, 'credentials')!.click();
    expect(treeText(root)).not.toContain('endpoint secret keys do not rotate in place');
    const secret = findByAttrValue(root, WEBHOOKS_PANEL_FIELD_ATTR, 'endpoint_secret_key')!;
    secret.value = firstSecret;
    fire(findByAttrValue(root, WEBHOOKS_PANEL_FORM_ATTR, 'credentials')!, 'submit', {
      preventDefault() {},
    });
    await tick();
    expect(runWrite).toHaveBeenCalledWith({
      ingress_id: created.ingress_id,
      credentials: { endpoint_secret_key: firstSecret },
    });
    expect(treeText(root)).not.toContain(firstSecret);
    const confirm = findByAttrValue(root, WEBHOOKS_PANEL_ACTION_ATTR, 'manual-confirm')!;
    expect(confirm.disabled).toBe(false);
    confirm.click();
    await tick();
    expect(runManualConfirm).toHaveBeenCalledWith({ ingress_id: created.ingress_id });
    findByAttrValue(root, WEBHOOKS_PANEL_ACTION_ATTR, 'enable')!.click();
    await tick();
    expect(runEnable).toHaveBeenCalledWith({ ingress_id: created.ingress_id });

    firstCredentialVerified = true;
    await route.webhooksPanel()!.refresh();
    expect(treeText(root)).toContain('v1 (verified)');
    findByAttrValue(root, WEBHOOKS_PANEL_ACTION_ATTR, 'credentials')!.click();
    expect(treeText(root)).toContain('endpoint secret keys do not rotate in place');
    expect(treeText(root)).toContain('create a second active URL destination');
    expect(treeText(root)).toContain('at most 10 active destinations');
    expect(treeText(root)).toContain('deactivate a different unused destination first');
    expect(treeText(root)).toContain('deactivate the old Paddle destination');
    expect(treeText(root)).toContain('deactivation preserves Paddle delivery logs');
    const replacement = findByAttrValue(
      root,
      WEBHOOKS_PANEL_FIELD_ATTR,
      'endpoint_secret_key',
    )!;
    replacement.value = rotatedSecret;
    fire(findByAttrValue(root, WEBHOOKS_PANEL_FORM_ATTR, 'credentials')!, 'submit', {
      preventDefault() {},
    });
    await tick();
    expect(runWrite).toHaveBeenCalledTimes(2);
    expect(runWrite).toHaveBeenLastCalledWith({
      ingress_id: created.ingress_id,
      credentials: { endpoint_secret_key: rotatedSecret },
    });
    expect(treeText(root)).not.toContain(rotatedSecret);
    expect(findByAttrValue(root, WEBHOOKS_PANEL_ACTION_ATTR, 'credentials')?.disabled)
      .toBe(true);
    const pendingRetirement = collectByAttr(root, WEBHOOKS_PANEL_ACTION_ATTR)
      .filter((action) => action.getAttribute(WEBHOOKS_PANEL_ACTION_ATTR)
        === 'credential-retire');
    expect(pendingRetirement.map((action) => [action.textContent, action.disabled]))
      .toEqual([
        ['Retire key v2', false],
        ['Retire key v1', true],
      ]);

    replacementCredentialVerified = true;
    await route.webhooksPanel()!.refresh();
    const verifiedRetirement = collectByAttr(root, WEBHOOKS_PANEL_ACTION_ATTR)
      .filter((action) => action.getAttribute(WEBHOOKS_PANEL_ACTION_ATTR)
        === 'credential-retire');
    expect(verifiedRetirement.map((action) => [action.textContent, action.disabled]))
      .toEqual([
        ['Retire key v2', false],
        ['Retire key v1', false],
      ]);
    findByAttrValue(root, WEBHOOKS_PANEL_ACTION_ATTR, 'disable')!.click();
    await tick();
    findByAttrValue(root, WEBHOOKS_PANEL_ACTION_ATTR, 'retire')!.click();
    expect(treeText(root)).toContain('deactivate this notification destination in Paddle');
    expect(treeText(root)).toContain('Recued cannot verify or perform the remote deactivation');
    expect(runRetire).not.toHaveBeenCalled();
    route.dispose();
  });

  it('keeps a live Paddle destination platform-only and sends testing to Sandbox', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const base = readyWebhook();
    const ingress: WebhookIngressView = {
      ...base,
      display_name: 'Paddle live lifecycle',
      profile_id: 'paddle.notification.v1',
      environment: 'live',
      registration_mode: 'manual',
      selected_event_types: ['transaction.completed'],
      registration_state: 'manual_pending',
      intake_state: 'draft',
      configured_fields: [],
      missing_required_fields: ['endpoint_secret_key'],
      active_credential_versions: [],
      readiness: {
        ...base.readiness,
        credentials_complete: false,
        registration_complete: false,
        registration_endpoint_matches: false,
        local_configuration_complete: false,
        can_enable: false,
        blockers: ['credentials_incomplete', 'registration_incomplete'],
      },
    };
    const route = bootstrapConnectionsRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      initialTab: 'webhooks',
      webhooksListCaller: vi.fn(async () => webhookList([ingress])),
      webhooksCreateCaller: vi.fn(async () => ({ ingress })),
      webhooksCredentialWriteCaller: vi.fn(async () => ({
        ingress,
        credential_version: {
          version: '1',
          created_at: 2,
          retired_at: null,
          last_verified_at: null,
        },
      })),
      webhooksCredentialRetireCaller: vi.fn(async () => ({ ingress })),
      webhooksManualConfirmCaller: vi.fn(async () => ({ ingress })),
      webhooksEnableCaller: vi.fn(async () => ({ ingress })),
      webhooksDisableCaller: vi.fn(async () => ({ ingress })),
      webhooksTestDeliveryCaller: vi.fn(async () => ({
        ingress,
        delivery_id: 'whd_should_not_run',
        observed_at: 5,
      })),
    });
    await route.webhooksPanel()!.refresh();

    expect(treeText(root)).toContain('matching Paddle Live account');
    expect(treeText(root)).toContain('Usage type to Platform.');
    expect(treeText(root)).not.toContain('Usage type to Platform and simulation');
    expect(treeText(root)).toContain('Test separately with a Paddle Sandbox account');
    expect(treeText(root)).toContain('do not route simulation traffic to this live ingress');
    expect(treeText(root)).toContain('Use a separate test-environment ingress');
    expect(findByAttrValue(root, WEBHOOKS_PANEL_ACTION_ATTR, 'test-delivery')).toBeNull();
    expect(findByAttrValue(root, WEBHOOKS_PANEL_ACTION_ATTR, 'registration-reconcile'))
      .toBeNull();
    route.dispose();
  });

  it('creates a manual Stripe URL before accepting its later vendor-returned secret', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const base = readyWebhook();
    const created: WebhookIngressView = {
      ...base,
      display_name: 'Stripe dashboard endpoint',
      profile_id: 'stripe.event.v1',
      environment: 'test',
      paired_connection_id: null,
      registration_mode: 'manual',
      selected_event_types: ['invoice.paid'],
      registration_state: 'manual_pending',
      intake_state: 'draft',
      configured_fields: [],
      missing_required_fields: ['endpoint_secret'],
      active_credential_versions: [],
      readiness: {
        ...base.readiness,
        credentials_complete: false,
        registration_complete: false,
        local_configuration_complete: false,
        can_enable: false,
        blockers: ['credentials_incomplete', 'registration_incomplete'],
      },
    };
    const credentialed: WebhookIngressView = {
      ...created,
      intake_state: 'verification_pending',
      configured_fields: ['endpoint_secret'],
      missing_required_fields: [],
      active_credential_versions: [{
        version: '1',
        created_at: 2,
        retired_at: null,
        last_verified_at: null,
      }],
      readiness: {
        ...created.readiness,
        credentials_complete: true,
        blockers: ['registration_incomplete'],
      },
    };
    let persisted = false;
    let credentialPersisted = false;
    const runCreate = vi.fn(async () => {
      persisted = true;
      return { ingress: created };
    });
    const runWrite = vi.fn(async () => {
      credentialPersisted = true;
      return {
        ingress: credentialed,
        credential_version: {
          version: '1',
          created_at: 2,
          retired_at: null,
          last_verified_at: null,
        },
      };
    });
    const runManualConfirm = vi.fn(async () => ({ ingress: credentialed }));
    const route = bootstrapConnectionsRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      initialTab: 'webhooks',
      webhooksListCaller: vi.fn(async () => webhookList(
        credentialPersisted
          ? [credentialed]
          : persisted ? [created] : [],
      )),
      webhooksCreateCaller: runCreate,
      webhooksCredentialWriteCaller: runWrite,
      webhooksCredentialRetireCaller: vi.fn(async () => ({ ingress: created })),
      webhooksManualConfirmCaller: runManualConfirm,
      webhooksEnableCaller: vi.fn(async () => ({ ingress: created })),
      webhooksDisableCaller: vi.fn(async () => ({ ingress: created })),
    });
    await route.webhooksPanel()!.refresh();
    collectByAttr(root, WEBHOOKS_PANEL_NEW_ATTR)[0]!.click();

    const profile = collectByAttr(root, WEBHOOKS_PANEL_PROFILE_ATTR)[0]!;
    profile.value = 'stripe.event.v1';
    fire(profile, 'change', { target: profile });
    const environment = collectByAttr(root, WEBHOOKS_PANEL_ENVIRONMENT_ATTR)[0]!;
    expect(environment.children.map((option) => option.value)).toEqual(['test', 'live']);
    const mode = collectByAttr(root, WEBHOOKS_PANEL_REGISTRATION_MODE_ATTR)[0]!;
    expect(mode.children.map((option) => option.value)).toEqual(['manual']);
    expect(findByAttrValue(root, WEBHOOKS_PANEL_FIELD_ATTR, 'endpoint_secret')).toBeNull();
    expect(treeText(root)).toContain('Create the local ingress first');
    const eventTypes = collectByAttr(root, WEBHOOKS_PANEL_EVENT_TYPE_ATTR);
    expect(eventTypes.map((input) => input.value)).toEqual([
      'checkout.session.completed',
      'customer.subscription.created',
      'customer.subscription.deleted',
      'customer.subscription.updated',
      'invoice.paid',
      'invoice.payment_failed',
    ]);
    expect(eventTypes.every((input) => input.checked === false)).toBe(true);
    const name = findByAttrValue(root, WEBHOOKS_PANEL_FIELD_ATTR, 'display_name')!;
    name.value = 'Stripe dashboard endpoint';
    fire(findByAttrValue(root, WEBHOOKS_PANEL_FORM_ATTR, 'create')!, 'submit', {
      preventDefault() {},
    });
    expect(runCreate).not.toHaveBeenCalled();
    expect(name.value).toBe('Stripe dashboard endpoint');

    for (const input of eventTypes) input.checked = input.value === 'invoice.paid';
    fire(findByAttrValue(root, WEBHOOKS_PANEL_FORM_ATTR, 'create')!, 'submit', {
      preventDefault() {},
    });
    await tick();

    expect(runCreate).toHaveBeenCalledWith({
      display_name: 'Stripe dashboard endpoint',
      profile_id: 'stripe.event.v1',
      environment: 'test',
      registration_mode: 'manual',
      selected_event_types: ['invoice.paid'],
    });
    expect(runWrite).not.toHaveBeenCalled();
    expect(treeText(root)).toContain(created.endpoint_url!);
    expect(treeText(root)).toContain('Add keys');
    expect(treeText(root)).toContain('After the vendor returns the Endpoint signing secret');
    expect(findByAttrValue(root, WEBHOOKS_PANEL_ACTION_ATTR, 'manual-confirm')?.disabled)
      .toBe(true);

    findByAttrValue(root, WEBHOOKS_PANEL_ACTION_ATTR, 'credentials')!.click();
    const secret = findByAttrValue(root, WEBHOOKS_PANEL_FIELD_ATTR, 'endpoint_secret')!;
    secret.value = 'whsec_manual-never-rendered';
    fire(findByAttrValue(root, WEBHOOKS_PANEL_FORM_ATTR, 'credentials')!, 'submit', {
      preventDefault() {},
    });
    await tick();
    expect(runWrite).toHaveBeenCalledWith({
      ingress_id: created.ingress_id,
      credentials: { endpoint_secret: 'whsec_manual-never-rendered' },
    });
    expect(treeText(root)).not.toContain('whsec_manual-never-rendered');
    const confirm = findByAttrValue(root, WEBHOOKS_PANEL_ACTION_ATTR, 'manual-confirm')!;
    expect(confirm.disabled).toBe(false);
    confirm.click();
    await tick();
    expect(runManualConfirm).toHaveBeenCalledWith({ ingress_id: created.ingress_id });
    route.dispose();
  });

  it('creates managed Stripe without accepting or sending an endpoint secret', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const base = readyWebhook();
    const created: WebhookIngressView = {
      ...base,
      display_name: 'Managed Stripe events',
      profile_id: 'stripe.event.v1',
      environment: 'live',
      paired_connection_id: 'stripe-live',
      registration_mode: 'managed_endpoint',
      remote_endpoint_id: null,
      selected_event_types: ['invoice.payment_failed'],
      registration_state: 'managed_pending',
      intake_state: 'draft',
      configured_fields: [],
      missing_required_fields: ['endpoint_secret'],
    };
    let persisted = false;
    const runCreate = vi.fn(async () => {
      persisted = true;
      return { ingress: created };
    });
    const runWrite = vi.fn(async () => ({
      ingress: created,
      credential_version: {
        version: '1',
        created_at: 2,
        retired_at: null,
        last_verified_at: null,
      },
    }));
    const runReconcile = vi.fn(async () => ({ ingress: created }));
    const route = bootstrapConnectionsRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      initialTab: 'webhooks',
      webhooksListCaller: vi.fn(async () => webhookList(
        persisted ? [created] : [],
      )),
      webhooksCreateCaller: runCreate,
      webhooksCredentialWriteCaller: runWrite,
      webhooksCredentialRetireCaller: vi.fn(async () => ({ ingress: created })),
      webhooksManualConfirmCaller: vi.fn(async () => ({ ingress: created })),
      webhooksRegistrationReconcileCaller: runReconcile,
      webhooksEnableCaller: vi.fn(async () => ({ ingress: created })),
      webhooksDisableCaller: vi.fn(async () => ({ ingress: created })),
    });
    await route.webhooksPanel()!.refresh();
    collectByAttr(root, WEBHOOKS_PANEL_NEW_ATTR)[0]!.click();

    const profile = collectByAttr(root, WEBHOOKS_PANEL_PROFILE_ATTR)[0]!;
    profile.value = 'stripe.event.v1';
    fire(profile, 'change', { target: profile });
    const environment = collectByAttr(root, WEBHOOKS_PANEL_ENVIRONMENT_ATTR)[0]!;
    environment.value = 'live';
    const mode = collectByAttr(root, WEBHOOKS_PANEL_REGISTRATION_MODE_ATTR)[0]!;
    expect(mode.children.map((option) => option.value)).toEqual([
      'manual',
      'managed_endpoint',
    ]);
    mode.value = 'managed_endpoint';
    fire(mode, 'change', { target: mode });
    expect(findByAttrValue(root, WEBHOOKS_PANEL_FIELD_ATTR, 'endpoint_secret')).toBeNull();
    expect(treeText(root)).toContain('captures its one-time signing secret');
    const events = collectByAttr(root, WEBHOOKS_PANEL_EVENT_TYPE_ATTR);
    for (const input of events) {
      input.checked = input.value === 'invoice.payment_failed';
    }
    findByAttrValue(root, WEBHOOKS_PANEL_FIELD_ATTR, 'display_name')!.value =
      'Managed Stripe events';
    collectByAttr(root, WEBHOOKS_PANEL_PAIRED_CONNECTION_ATTR)[0]!.value =
      ' stripe-live ';
    fire(findByAttrValue(root, WEBHOOKS_PANEL_FORM_ATTR, 'create')!, 'submit', {
      preventDefault() {},
    });
    await tick();

    expect(runCreate).toHaveBeenCalledWith({
      display_name: 'Managed Stripe events',
      profile_id: 'stripe.event.v1',
      environment: 'live',
      paired_connection_id: 'stripe-live',
      registration_mode: 'managed_endpoint',
      selected_event_types: ['invoice.payment_failed'],
    });
    expect(runWrite).not.toHaveBeenCalled();
    const reconcile = findByAttrValue(
      root,
      WEBHOOKS_PANEL_ACTION_ATTR,
      'registration-reconcile',
    );
    expect(reconcile).toMatchObject({
      textContent: 'Set up the address at the service',
      disabled: false,
    });
    reconcile?.click();
    await tick();
    expect(runReconcile).toHaveBeenCalledWith({ ingress_id: created.ingress_id });
    route.dispose();
  });

  it('creates operation-bound ingress only with an explicit paired provider connection', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const created: WebhookIngressView = {
      ...readyWebhook(),
      display_name: 'Per-resource callbacks',
      profile_id: 'generic.static-header-token.v1',
      paired_connection_id: 'fixture-provider-test',
      registration_mode: 'operation_bound',
      registration_state: 'not_applicable',
      intake_state: 'draft',
      configured_fields: [],
      missing_required_fields: ['header_name', 'header_token'],
    };
    const runCreate = vi.fn(async () => ({ ingress: created }));
    const runWrite = vi.fn(async () => ({
      ingress: created,
      credential_version: {
        version: '1',
        created_at: 2,
        retired_at: null,
        last_verified_at: null,
      },
    }));
    const route = bootstrapConnectionsRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      initialTab: 'webhooks',
      webhooksListCaller: vi.fn(async () => webhookList([])),
      webhooksCreateCaller: runCreate,
      webhooksCredentialWriteCaller: runWrite,
      webhooksCredentialRetireCaller: vi.fn(async () => ({ ingress: created })),
      webhooksManualConfirmCaller: vi.fn(async () => ({ ingress: created })),
      webhooksEnableCaller: vi.fn(async () => ({ ingress: created })),
      webhooksDisableCaller: vi.fn(async () => ({ ingress: created })),
    });
    await route.webhooksPanel()!.refresh();
    collectByAttr(root, WEBHOOKS_PANEL_NEW_ATTR)[0]!.click();

    const mode = collectByAttr(root, WEBHOOKS_PANEL_REGISTRATION_MODE_ATTR)[0]!;
    expect(mode.children.map((option) => option.value)).toEqual([
      'manual',
      'operation_bound',
    ]);
    mode.value = 'operation_bound';
    fire(mode, 'change', { target: mode });
    expect(treeText(root)).toContain('recipe cannot receive or override it');

    const paired = collectByAttr(root, WEBHOOKS_PANEL_PAIRED_CONNECTION_ATTR)[0]!;
    paired.value = ' fixture-provider-test ';
    findByAttrValue(root, WEBHOOKS_PANEL_FIELD_ATTR, 'display_name')!.value =
      'Per-resource callbacks';
    findByAttrValue(root, WEBHOOKS_PANEL_FIELD_ATTR, 'header_name')!.value =
      'X-Webhook-Token';
    findByAttrValue(root, WEBHOOKS_PANEL_FIELD_ATTR, 'header_token')!.value =
      'operation-bound-secret';
    fire(findByAttrValue(root, WEBHOOKS_PANEL_FORM_ATTR, 'create')!, 'submit', {
      preventDefault() {},
    });
    await tick();

    expect(runCreate).toHaveBeenCalledWith({
      display_name: 'Per-resource callbacks',
      profile_id: 'generic.static-header-token.v1',
      environment: 'test',
      paired_connection_id: 'fixture-provider-test',
      registration_mode: 'operation_bound',
      selected_event_types: ['delivery'],
    });
    expect(runWrite).toHaveBeenCalledWith({
      ingress_id: created.ingress_id,
      credentials: {
        header_name: 'X-Webhook-Token',
        header_token: 'operation-bound-secret',
      },
    });
    expect(treeText(root)).not.toContain('operation-bound-secret');
    route.dispose();
  });

  it('refreshes a partially-created draft when the credential write fails', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const draft = {
      ...readyWebhook(),
      display_name: 'Repairable draft',
      profile_id: 'generic.static-header-token.v1' as const,
      registration_state: 'manual_pending' as const,
      intake_state: 'draft' as const,
      configured_fields: [],
      missing_required_fields: ['header_name', 'header_token'],
    };
    let persisted = false;
    const runList = vi.fn(async () => webhookList(persisted ? [draft] : []));
    const route = bootstrapConnectionsRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      initialTab: 'webhooks',
      webhooksListCaller: runList,
      webhooksCreateCaller: vi.fn(async () => {
        persisted = true;
        return { ingress: draft };
      }),
      webhooksCredentialWriteCaller: vi.fn(async () => {
        throw new Error('vault locked during credential write');
      }),
      webhooksCredentialRetireCaller: vi.fn(async () => ({ ingress: draft })),
      webhooksManualConfirmCaller: vi.fn(async () => ({ ingress: draft })),
      webhooksEnableCaller: vi.fn(async () => ({ ingress: draft })),
      webhooksDisableCaller: vi.fn(async () => ({ ingress: draft })),
    });
    await route.webhooksPanel()!.refresh();
    collectByAttr(root, WEBHOOKS_PANEL_NEW_ATTR)[0]!.click();
    findByAttrValue(root, WEBHOOKS_PANEL_FIELD_ATTR, 'display_name')!.value =
      'Repairable draft';
    findByAttrValue(root, WEBHOOKS_PANEL_FIELD_ATTR, 'header_name')!.value =
      'X-Webhook-Token';
    findByAttrValue(root, WEBHOOKS_PANEL_FIELD_ATTR, 'header_token')!.value =
      'transient-token';
    fire(findByAttrValue(root, WEBHOOKS_PANEL_FORM_ATTR, 'create')!, 'submit', {
      preventDefault() {},
    });
    await tick(20);

    expect(treeText(root)).toContain('vault locked during credential write');
    expect(treeText(root)).toContain('Repairable draft');
    expect(treeText(root)).not.toContain('transient-token');
    expect(findByAttrValue(root, WEBHOOKS_PANEL_FORM_ATTR, 'create')).toBeNull();
    expect(findByAttrValue(root, WEBHOOKS_PANEL_ACTION_ATTR, 'credentials'))
      .not.toBeNull();
    expect(runList).toHaveBeenCalled();
    route.dispose();
  });

  it('shows an unavailable note on Others when the enroll callers are absent', () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const route = bootstrapConnectionsRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      initialTab: 'others',
    });
    expect(route.connectionsEnrollPanel()).toBeNull();
    const content = collectByAttr(root, CONNECTIONS_ROUTE_CONTENT_ATTR)[0]!;
    expect(content.children[0]?.textContent).toContain('cannot add Connections yet');
    route.dispose();
  });

  it('leaves Settings as a pointer to #connections without mounting legacy panels', () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const route = bootstrapSettingsRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      localStore: createInMemoryWebclientLocalStore(),
    });

    expect(route.connectionsEnrollPanel()).toBeNull();
    expect(findByAttrValue(root, SETTINGS_ROUTE_SECTION_ATTR, 'connections-enroll'))
      .toBeNull();
    expect(findByAttrValue(root, SETTINGS_ROUTE_SECTION_ATTR, 'connections'))
      .toBeNull();
    const link = collectByAttr(root, SETTINGS_ROUTE_CONNECTIONS_LINK_ATTR)[0]!;
    expect(link.getAttribute('href')).toBe('#connections');
    // R29 (`4b1f9f09`) replaced the flat "Open Connections" pointer with a
    // Privacy-directory row: the label now lives in a `.privacy-directory-title`
    // span inside the link (mirrors the Data-pointer assertion in
    // d-148-bootstrap-settings-route.test.ts).
    const title = link.children.find(
      (c) => c.className === 'privacy-directory-title',
    );
    expect(title?.textContent).toBe('Connections');

    route.dispose();
  });
});

describe('operation grants — the surface R13 deleted and left rpc-only', () => {
  const grantCallers = () => ({
    connectionsListCaller: vi.fn(async () => ({ connections: [] })),
    connectionsListGroupsCaller: vi.fn(async ({ name }: { name: string }) => ({
      connection_name: name,
      granted_groups: [],
      allowed_operations: [],
      available_groups: [],
    })),
    connectionsGrantGroupCaller: vi.fn(async () => { throw new Error('unused'); }),
    connectionsRevokeGroupCaller: vi.fn(async () => { throw new Error('unused'); }),
  });

  it('⛔⛔ NOT MOUNTED even with every caller wired — the layer no longer gates', async () => {
    /** INVERTED 2026-08-07 (owner decision). This used to assert the section RENDERS,
     *  on the premise that without it a hand-enrolled connection is stuck at
     *  `operation_not_granted` forever. That premise died with
     *  `OPERATION_GROUP_GATE_ENABLED = false`: every op a bound catalog declares is now
     *  admitted, and authority sits with the contract layer (doors) + the per-run
     *  approval gate (owner).
     *
     *  ⛔ THE PANEL WAS ALSO LYING, which is why it was removed rather than restyled:
     *    - its rows named ONE pack (`excel.table.write`) but `resolveInstallGrantWriteSet`
     *      iterates the CONNECTION's catalog, so ANY sibling pack installed at `All`
     *      flipped them — reproduced live by installing `planner`;
     *    - its `granted` flag read `__user__` grants only, while enforcement unioned
     *      user AND pack-owned — so a row offering "Grant" could already be permitted.
     *
     *  🔑 WIRING EVERY CALLER IS THE POINT OF THIS TEST. The sibling case below already
     *  covers "absent when the callers are absent"; passing that would be trivially
     *  satisfied by a route that lost its grant wiring by accident. Supplying the full
     *  caller set proves the un-mount is a DECISION, not a regression. */
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const enroll = enrollCallers();
    const route = bootstrapConnectionsRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      initialTab: 'others',
      ...enroll,
      ...grantCallers(),
      // Production reuses this exact list caller for both panels.
      connectionsListCaller: enroll.connectionsEnrollListCaller,
    } as never);

    expect(collectByAttr(root, CONNECTIONS_ROUTE_GRANTS_SECTION_ATTR).length).toBe(0);
    expect(route.connectionsGrantPanel(), 'no panel instance to drive').toBeNull();

    /** ⚠ The ENROL panel must survive intact — the two share a lane and a list caller,
     *  so un-mounting one is exactly the change that could take the other with it. */
    await route.connectionsEnrollPanel()!.whenLoaded();
    const content = collectByAttr(root, CONNECTIONS_ROUTE_CONTENT_ATTR)[0]!;
    expect(collectByAttr(root, CONNECTIONS_ROUTE_ENROLL_HOST_ATTR)[0]!.parent).toBe(content);
    route.dispose();
  });

  it('⛔ omits it when the callers are absent — never a dead control', () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    bootstrapConnectionsRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      initialTab: 'others',
    } as never);
    expect(collectByAttr(root, CONNECTIONS_ROUTE_GRANTS_SECTION_ATTR).length).toBe(0);
  });

  it('⛔ never renders on a NON-Apps lane', () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    bootstrapConnectionsRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      initialTab: 'file',
      file: {
        list: vi.fn(async () => ({ instances: [] })),
        enroll: vi.fn(async () => { throw new Error('unused'); }),
        delete: vi.fn(async () => ({ ok: true as const })),
      },
      ...grantCallers(),
    } as never);
    // Grants are api-connection scoped; surfacing them under Files would offer
    // to authorise operations on a substrate that has none.
    expect(collectByAttr(root, CONNECTIONS_ROUTE_GRANTS_SECTION_ATTR).length).toBe(0);
  });
});
