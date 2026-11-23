import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type {
  ConnectionSetupGuideRequest,
  ConnectionSetupGuideResult,
} from '@recued/ui-shared';
import {
  OPENER_RELAY_MESSAGE_KIND,
  OAUTH_OPENER_RELAY_STATE_PREFIX,
  WEBHOOK_PROFILE_IDS,
  WEBHOOK_PROFILE_REGISTRY,
  webhookEventTypeGrammarAccepts,
  type WebhookEventTypeGrammar,
  type WebhookIngressUpdateRequest,
  type WebhookProfileRuntimeCapabilityView,
  type ConnectionHealth,
  type ConnectionView,
  type WebhookDeliveryDetailView,
  type WebhookDeliveryListRequest,
  type WebhookDeliveryListResponse,
  type WebhookIngressRecipeView,
  type WebhookIngressView,
  type WebhookRejectedDeliveryListRequest,
  type WebhookRejectedDeliveryListResponse,
  type WebhookDeadLetterActionRequest,
  type WebhookDeadLetterActionResponse,
  type WebhookDeadLetterListResponse,
  type WebhookDeadLetterView,
} from '@recued/contracts';

import {
  CONNECTIONS_ROUTE_CONTENT_ATTR,
  CONNECTIONS_MANAGE_BROKERS_ATTR,
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
  WEBHOOKS_PANEL_DEAD_LETTER_ATTR,
  WEBHOOKS_PANEL_DEAD_LETTER_REVIEW_ATTR,
  WEBHOOKS_PANEL_CLOSED_DEAD_LETTER_ATTR,
  WEBHOOKS_PANEL_RETIRE_DEAD_LETTERS_ATTR,
  WEBHOOKS_PANEL_DEAD_LETTERS_ATTR,
  WEBHOOKS_PANEL_DELIVERIES_ATTR,
  WEBHOOKS_PANEL_DELIVERY_ATTR,
  WEBHOOKS_PANEL_DEDUPLICATION_ATTR,
  WEBHOOKS_PANEL_ENVIRONMENT_ATTR,
  WEBHOOKS_PANEL_EVENTS_EDITOR_ATTR,
  WEBHOOKS_PANEL_EVENTS_NOTICE_ATTR,
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
  WEBHOOKS_PANEL_RECIPE_ATTR,
  WEBHOOKS_PANEL_RECIPES_ATTR,
  WEBHOOKS_PANEL_STRAYS_ATTR,
  WEBHOOKS_PANEL_RETENTION_ATTR,
  WEBHOOKS_PANEL_STYLES,
  WEBHOOKS_PANEL_TEST_ATTR,
  refusingText,
  ownEndpointText,
  recipeDoorText,
  ownerSecretAdvice,
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
  focus(): void;
  click(): void;
  remove(): void;
}

interface FakeDoc {
  defaultView?: { confirm(prompt: string): boolean };
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
    focus() {},
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
    focus() {},
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

describe('unified authentication repairs in Connections', () => {
  it('keeps history access-review drafts and starts visible to shell navigation guards', async () => {
    const doc = makeFakeDocument(); const root = doc.createElement('div'); const repairId = 'repair-' + 'a'.repeat(64); const targetId = 'b'.repeat(64);
    let release!: (reply: Awaited<ReturnType<import('../settings/managed-oauth-panel.js').ManagedOAuthCaller>>) => void;
    const verify = vi.fn<import('../settings/managed-oauth-panel.js').ManagedOAuthCaller>(async request => {
      if (request.action === 'authentication_access_retire') return { action: request.action };
      if (request.action === 'authentication_access_preview') return { action: request.action, preview: { id: 'p'.repeat(43), fingerprint: 'f'.repeat(64), expires_at: Date.now() + 60000,
        selection: { kind: 'repair', id: repairId }, label: 'Work', targets: [{ id: targetId, target: { kind: 'connection', name: 'work' }, label: 'Work API',
          authentication_revision: 'c'.repeat(64), check: 'api_read', base_url: 'https://vendor.test' }], targets_truncated: false, uses: [], usage_available: true } };
      if (request.action === 'authentication_access_run') return new Promise(resolve => { release = resolve; }); throw Error('Unexpected action');
    });
    const route = bootstrapConnectionsRoute({ root: root as unknown as HTMLElement, document: doc as unknown as Document, ...enrollCallers(), initialTab: 'others', initialIncidentHistory: { kind: 'all' },
      connectionsManagedOAuthCaller: verify, authenticationIncidentHistoryCaller: async query => ({ scope: query.scope, observed_at: 1, retention_days: 90, incidents: [], repairs: [{
        id: repairId, action: 'reauthorize', status: 'applied', started_at: 1, finished_at: 2, targets: [{ kind: 'connection', name: 'work' }], targets_truncated: false, incidents: [], incidents_truncated: false }], order: [repairId] }) });
    await route.whenLoaded(); findByAttrValue(root, 'data-incident-verify-access', repairId)!.click(); await route.whenLoaded();
    expect(route.hasUnsavedChanges()).toBe(true); expect(route.unsavedChangesPrompt()).toContain('Leave this access review');
    findByAttrValue(root, 'data-authentication-access-action', 'run')!.click(); expect(route.hasInFlightWork()).toBe(true);
    release({ action: 'authentication_access_run', verification: { id: 'verify-12345678-1234-4123-8123-123456789abc', selection: { kind: 'repair', id: repairId }, status: 'completed', started_at: 3, finished_at: 4,
      results: [{ id: targetId, target: { kind: 'connection', name: 'work' }, label: 'Work API', authentication_revision: 'c'.repeat(64), current: 'yes', checks: [{ kind: 'api_read', status: 'unconfirmed', reason: 'resource_required' }] }],
      targets_truncated: false, uses: [], usage_available: true } }); await route.whenLoaded();
    expect(route.hasInFlightWork()).toBe(false); expect(route.hasUnsavedChanges()).toBe(false); route.dispose();
  });
  it('mounts filtered history without unrelated account reads and preserves filters when clearing the selected scope', async () => {
    const doc = makeFakeDocument(); const root = doc.createElement('div'); const callers = enrollCallers(); const navigate = vi.fn();
    const filters = { search: 'Work', type: 'verification' as const, outcome: 'failed' as const, from: '2026-10-01' };
    const history = vi.fn<import('@recued/contracts').AuthenticationIncidentHistoryCaller>(async query => ({ scope: query.scope, filters: query.filters, observed_at: 1234, retention_days: 90, incidents: [], repairs: [], verifications: [], renewals: [], order: [] }));
    const route = bootstrapConnectionsRoute({ root: root as unknown as HTMLElement, document: doc as unknown as Document, ...callers, initialTab: 'others', navigate,
      initialIncidentHistory: { kind: 'connection', name: 'work' }, initialIncidentHistoryFilters: filters, authenticationIncidentHistoryCaller: history });
    await route.whenLoaded(); expect(history).toHaveBeenCalledExactlyOnceWith({ scope: { kind: 'connection', name: 'work' }, filters, include_renewals: true });
    expect(treeText(root)).toContain('No retained entries match'); expect(callers.connectionsEnrollListCaller).not.toHaveBeenCalled();
    findByAttrValue(root, 'data-history-filter-action', 'clear')!.click(); expect(navigate).toHaveBeenCalledExactlyOnceWith('#connections/others/incident-history/connection/work'); route.dispose();
  });
  it('opens a passed saved check in a standalone read-only page and leaves unrelated connection callers idle', async () => {
    const doc = makeFakeDocument(); const root = doc.createElement('div'); const callers = enrollCallers(); const repairs = vi.fn(); const apps = vi.fn(); const navigate = vi.fn();
    const reference = { verification_id: 'verify-12345678-1234-4123-8123-123456789abc', view: 'result' as const };
    const verify = vi.fn<import('../settings/managed-oauth-panel.js').ManagedOAuthCaller>(async () => ({ action: 'authentication_access_status', verification: {
      id: reference.verification_id, selection: { kind: 'group', id: 'a'.repeat(64) }, status: 'completed', started_at: 1, finished_at: 2, targets_truncated: false, uses: [], usage_available: true,
      results: [{ id: 'c'.repeat(64), target: { kind: 'connection', name: 'work' }, label: 'Work API', authentication_revision: 'd'.repeat(64), current: 'yes', checks: [{ kind: 'api_read', status: 'passed' }] }] } }));
    const route = bootstrapConnectionsRoute({ root: root as unknown as HTMLElement, document: doc as unknown as Document, initialTab: 'others', ...callers, navigate,
      oauthAppsCaller: apps, authenticationRepairsCaller: repairs, connectionsManagedOAuthCaller: verify, initialAccessCheck: reference }); await route.whenLoaded();
    expect(verify).toHaveBeenCalledExactlyOnceWith({ action: 'authentication_access_status', id: reference.verification_id });
    expect(treeText(root)).toContain('Protected API read: Passed'); expect(callers.connectionsEnrollListCaller).not.toHaveBeenCalled(); expect(repairs).not.toHaveBeenCalled(); expect(apps).not.toHaveBeenCalled();
    expect(route.hasUnsavedChanges()).toBe(false); expect(route.hasInFlightWork()).toBe(false);
    findByAttrValue(root, 'data-authentication-access-action', 'close')!.click(); expect(navigate).toHaveBeenCalledWith('#connections/others/incident-history'); route.dispose();
  });
  it.each([null, 'missing caller'] as const)('does not fall through from an unavailable saved-check page: %s', mode => {
    const doc = makeFakeDocument(); const root = doc.createElement('div'); const callers = enrollCallers();
    const route = bootstrapConnectionsRoute({ root: root as unknown as HTMLElement, document: doc as unknown as Document, initialTab: 'others', ...callers,
      initialAccessCheck: mode === null ? null : { verification_id: 'verify-12345678-1234-4123-8123-123456789abc', view: 'comparison' } });
    expect(treeText(root)).toContain(mode === null ? 'saved-check link is invalid' : 'Saved access results are unavailable');
    expect(callers.connectionsEnrollListCaller).not.toHaveBeenCalled(); route.dispose();
  });
  it('opens a returned saved result through local status without loading unrelated editors or starting a fresh review', async () => {
    const doc = makeFakeDocument(); const root = doc.createElement('div'); const callers = enrollCallers(); const repairs = vi.fn(); const apps = vi.fn();
    const reference = { verification_id: 'verify-12345678-1234-4123-8123-123456789abc', target_id: 'c'.repeat(64) };
    const verify = vi.fn<import('../settings/managed-oauth-panel.js').ManagedOAuthCaller>(async () => ({ action: 'authentication_access_status', verification: {
      id: reference.verification_id, selection: { kind: 'group', id: 'a'.repeat(64) }, status: 'completed', started_at: 1, finished_at: 2,
      targets_truncated: false, uses: [], usage_available: true, results: [{ id: reference.target_id, target: { kind: 'connection', name: 'work' }, label: 'Work API',
        authentication_revision: 'd'.repeat(64), current: 'no', checks: [{ kind: 'api_read', status: 'failed', reason: 'access_rejected' }] }] } }));
    const navigate = vi.fn(); const route = bootstrapConnectionsRoute({ root: root as unknown as HTMLElement, document: doc as unknown as Document,
      initialTab: 'others', ...callers, navigate, oauthAppsCaller: apps, authenticationRepairsCaller: repairs, connectionsManagedOAuthCaller: verify, initialAccessResult: reference });
    await route.whenLoaded(); expect(verify).toHaveBeenCalledExactlyOnceWith({ action: 'authentication_access_status', id: reference.verification_id });
    expect(callers.connectionsEnrollListCaller).not.toHaveBeenCalled(); expect(repairs).not.toHaveBeenCalled(); expect(apps).not.toHaveBeenCalled();
    expect(findByAttrValue(root, 'data-authentication-access-action', 'review-returned')).toBeDefined(); expect(route.hasUnsavedChanges()).toBe(false); expect(route.hasInFlightWork()).toBe(false);
    findByAttrValue(root, 'data-authentication-access-action', 'close')!.click(); expect(navigate).toHaveBeenCalledWith('#connections/others/incident-history'); route.dispose();
  });
  it.each([null, 'missing caller'] as const)('shows an unavailable saved-return link without falling through to another editor: %s', mode => {
    const doc = makeFakeDocument(); const root = doc.createElement('div'); const callers = enrollCallers();
    const route = bootstrapConnectionsRoute({ root: root as unknown as HTMLElement, document: doc as unknown as Document, initialTab: 'others', ...callers,
      initialAccessResult: mode === null ? null : { verification_id: 'verify-12345678-1234-4123-8123-123456789abc', target_id: 'a'.repeat(64) } });
    expect(treeText(root)).toContain(mode === null ? 'saved-result link is invalid' : 'Saved access results are unavailable');
    expect(callers.connectionsEnrollListCaller).not.toHaveBeenCalled(); route.dispose();
  });
  it.each(['mail', 'calendar', 'others'] as const)('keeps a saved-check return outside the replaceable %s lane host', tab => {
    const doc = makeFakeDocument(); const root = doc.createElement('div');
    const reference = { verification_id: 'verify-12345678-1234-4123-8123-123456789abc', target_id: 'a'.repeat(64) };
    const route = bootstrapConnectionsRoute({ root: root as unknown as HTMLElement, document: doc as unknown as Document, initialTab: tab, initialAccessRepairReturn: reference });
    const content = findByAttrValue(root, CONNECTIONS_ROUTE_CONTENT_ATTR, '')!;
    expect(collectByAttr(content, 'data-access-repair-return')).toEqual([]);
    expect(findByAttrValue(root, 'data-access-repair-return', '')?.getAttribute('href')).toBe('#connections/others/access-result/' + reference.verification_id + '/' + reference.target_id);
    route.dispose();
  });
  it.each(['local review', 'saved status'] as const)('allows leaving during a read-only access lookup: %s', async phase => {
    const doc = makeFakeDocument(); const root = doc.createElement('div');
    const selection = { kind: 'renewal' as const, id: 'renewal-12345678-1234-4123-8123-123456789abc' };
    const running: import('@recued/contracts').AuthenticationAccessVerification = { id: 'verify-12345678-1234-4123-8123-123456789abc', selection,
      status: 'checking', started_at: 1, targets_truncated: false, usage_available: true, uses: [], results: [{ id: 'c'.repeat(64), target: { kind: 'connection', name: 'work' },
        label: 'Work API', authentication_revision: 'd'.repeat(64), current: 'yes', checks: [{ kind: 'api_read', status: 'unconfirmed', reason: 'not_checked' }] }] };
    const preview: import('@recued/contracts').AuthenticationAccessPreview = { id: 'a'.repeat(43), fingerprint: 'b'.repeat(64), expires_at: Date.now() + 60000,
      selection, label: 'Current Work authentication', targets_truncated: false, usage_available: true, uses: [], targets: [{ id: 'c'.repeat(64), target: { kind: 'connection', name: 'work' },
        label: 'Work API', authentication_revision: 'd'.repeat(64), check: 'api_read', base_url: 'https://vendor.test/v1' }], ...(phase === 'saved status' ? { running } : {}) };
    let release!: (value: Awaited<ReturnType<import('../settings/managed-oauth-panel.js').ManagedOAuthCaller>>) => void;
    const call: import('../settings/managed-oauth-panel.js').ManagedOAuthCaller = async args => {
      if (args.action === 'authentication_access_retire') return { action: args.action };
      if (args.action === 'authentication_access_preview') return phase === 'local review' ? new Promise(resolve => { release = resolve; }) : { action: args.action, preview };
      if (args.action === 'authentication_access_status') return new Promise(resolve => { release = resolve; });
      throw Error('Unexpected action');
    };
    const route = bootstrapConnectionsRoute({ root: root as unknown as HTMLElement, document: doc as unknown as Document, initialTab: 'others',
      connectionsManagedOAuthCaller: call, initialAccessVerification: selection });
    try {
      if (phase === 'saved status') { await route.whenLoaded(); findByAttrValue(root, 'data-authentication-access-action', 'status')!.click(); }
      expect(route.hasUnsavedChanges()).toBe(false); expect(route.hasInFlightWork()).toBe(false);
    } finally { route.dispose(); release(phase === 'local review' ? { action: 'authentication_access_preview', preview } : { action: 'authentication_access_status', verification: running }); await route.whenLoaded(); }
  });
  it('opens the standalone access review without loading unrelated connection editors or starting remote checks', async () => {
    const doc = makeFakeDocument(); const root = doc.createElement('div'); const callers = enrollCallers(); const repairs = vi.fn(); const apps = vi.fn(); const navigate = vi.fn();
    const selection = { kind: 'renewal' as const, id: 'renewal-12345678-1234-4123-8123-123456789abc' };
    const verify = vi.fn<import('../settings/managed-oauth-panel.js').ManagedOAuthCaller>(async request => {
      if (request.action === 'authentication_access_retire') return { action: request.action };
      if (request.action !== 'authentication_access_preview') throw Error('Unexpected action');
      return { action: request.action, preview: { id: 'a'.repeat(43), fingerprint: 'b'.repeat(64), expires_at: Date.now() + 60000, selection,
        label: 'Current Work authentication', targets_truncated: false, uses: [], usage_available: true, targets: [{ id: 'c'.repeat(64),
          target: { kind: 'connection', name: 'work' }, label: 'Work API', check: 'api_read', authentication_revision: 'd'.repeat(64), base_url: 'https://vendor.test/v1' }] } };
    });
    const route = bootstrapConnectionsRoute({ root: root as unknown as HTMLElement, document: doc as unknown as Document, initialTab: 'others',
      ...callers, navigate, oauthAppsCaller: apps, authenticationRepairsCaller: repairs, connectionsManagedOAuthCaller: verify, initialAccessVerification: selection });
    await route.whenLoaded(); expect(verify).toHaveBeenCalledExactlyOnceWith({ action: 'authentication_access_preview', selection });
    expect(callers.connectionsEnrollListCaller).not.toHaveBeenCalled(); expect(repairs).not.toHaveBeenCalled(); expect(apps).not.toHaveBeenCalled();
    expect(route.hasUnsavedChanges()).toBe(true); expect(route.hasInFlightWork()).toBe(false);
    findByAttrValue(root, 'data-authentication-access-action', 'close')!.click();
    expect(route.hasUnsavedChanges()).toBe(false); expect(navigate).toHaveBeenCalledWith('#connections/others/incident-history'); route.dispose();
  });
  it.each([null, 'missing-caller'] as const)('fails a standalone access entry safely for %s', async kind => {
    const doc = makeFakeDocument(); const root = doc.createElement('div'); const callers = enrollCallers(); const verify = vi.fn();
    const route = bootstrapConnectionsRoute({ root: root as unknown as HTMLElement, document: doc as unknown as Document, initialTab: 'others', ...callers,
      initialAccessVerification: kind === null ? null : { kind: 'renewal', id: 'renewal-12345678-1234-4123-8123-123456789abc' },
      ...(kind === null ? { connectionsManagedOAuthCaller: verify } : {}) });
    await route.whenLoaded(); expect(verify).not.toHaveBeenCalled(); expect(callers.connectionsEnrollListCaller).not.toHaveBeenCalled();
    expect(collectByAttr(root, 'data-authentication-access-action')).toEqual([]); route.dispose();
  });
  it('allows leaving a local-only history shortcut lookup and ignores the late reply', async () => {
    const doc = makeFakeDocument(); const root = doc.createElement('div'); const navigate = vi.fn();
    const renewal: import('@recued/contracts').AuthenticationRenewalHistory = { id: 'renewal-12345678-1234-4123-8123-123456789abc', issuer: 'google', app_id: 'default', app_revision: 2,
      app_label: 'Work', started_at: 1, history_started_at: 1, finished_at: 2, status: 'completed', incomplete: false,
      results: [{ id: 'a'.repeat(64), revision: 'b'.repeat(64), label: 'Work API', connections: ['work'], native_accounts: [], eligible: true, status: 'failed', reason: 'grant_rejected', current: 'yes' }] };
    let release!: (reply: import('@recued/contracts').OAuthAppsResponse) => void;
    const call = vi.fn<import('../settings/oauth-apps-panel.js').OAuthAppsCaller>(() => new Promise(resolve => { release = resolve; }));
    const route = bootstrapConnectionsRoute({ root: root as unknown as HTMLElement, document: doc as unknown as Document, initialTab: 'others', ...enrollCallers(), navigate,
      oauthAppsCaller: call, initialIncidentHistory: { kind: 'oauth_apps' }, authenticationIncidentHistoryCaller: async query => ({ scope: query.scope,
        observed_at: 3, retention_days: 90, incidents: [], repairs: [], renewals: [renewal], order: [renewal.id] }) });
    await route.whenLoaded(); findByAttrValue(root, 'data-renewal-shortcut', renewal.id + ':' + renewal.results[0]!.id + ':0')!.click();
    expect(call).toHaveBeenCalledExactlyOnceWith({ action: 'renewal_status', id: renewal.id }); expect(route.hasInFlightWork()).toBe(false);
    route.dispose(); release({ action: 'renewal_status', apps: [{ issuer: 'google', id: 'default', label: 'Work', client_id: 'client', revision: 2, has_secret: true }], renewal_verification: renewal });
    await route.whenLoaded(); expect(navigate).not.toHaveBeenCalled();
  });
  it('opens the selected app review and keeps its renewal return outside the replaceable lane host', async () => {
    const doc = makeFakeDocument(); const root = doc.createElement('div');
    const app = { issuer: 'google' as const, id: 'default', client_id: 'client', label: 'Work', revision: 3, has_secret: true };
    const call = vi.fn<import('../settings/oauth-apps-panel.js').OAuthAppsCaller>(async request => ({ action: request.action, apps: [app],
      ...(request.action === 'usage' ? { usage: { id: 'u'.repeat(43), fingerprint: 'a'.repeat(64), expires_at: Date.now() + 60000, app,
        can_rotate: true, native_accounts: [], connections: [], unreadable_connections: [], warnings: [] } } : {}) }));
    const route = bootstrapConnectionsRoute({ root: root as unknown as HTMLElement, document: doc as unknown as Document, initialTab: 'others',
      ...enrollCallers(), oauthAppsCaller: call, initialOAuthAppReview: { issuer: 'google', id: 'default', view: 'usage' }, initialRenewalReturn: { issuer: 'google', id: 'default', view: 'renewal' } });
    await route.whenLoaded(); expect(call.mock.calls.slice(0, 2).map(([r]) => r)).toEqual([{ action: 'list' }, { action: 'usage', issuer: 'google', id: 'default', expected_revision: 3 }]);
    const content = findByAttrValue(root, CONNECTIONS_ROUTE_CONTENT_ATTR, '')!;
    expect(collectByAttr(content, 'data-renewal-repair-return')).toEqual([]);
    const back = findByAttrValue(root, 'data-renewal-repair-return', '');
    expect(back?.getAttribute('href')).toBe('#connections/others/oauth-apps/google/default/renewal'); route.dispose();
  });
  it('mounts retained incident history without reading credentials, accounts or the repair inventory', async () => {
    const doc = makeFakeDocument(); const root = doc.createElement('div');
    const history = vi.fn<import('@recued/contracts').AuthenticationIncidentHistoryCaller>(async query => ({ scope: query.scope, observed_at: 1234, retention_days: 90, incidents: [] }));
    const repairs = vi.fn(); const callers = enrollCallers();
    const route = bootstrapConnectionsRoute({ root: root as unknown as HTMLElement, document: doc as unknown as Document,
      initialTab: 'others', ...callers, authenticationRepairsCaller: repairs, initialIncidentHistory: { kind: 'connection', name: 'work' }, authenticationIncidentHistoryCaller: history });
    await route.whenLoaded(); expect(history).toHaveBeenCalledWith({ scope: { kind: 'connection', name: 'work' }, include_renewals: true });
    expect(repairs).not.toHaveBeenCalled(); expect(callers.connectionsEnrollListCaller).not.toHaveBeenCalled();
    const texts = (el: FakeEl): string => el.textContent + el.children.map(texts).join(' ');
    expect(texts(root)).toContain('No incidents have been recorded'); route.dispose();
  });
  it.each(['mail', 'calendar', 'file', 'others'] as const)('keeps the worklist outside the replaceable %s lane host', async initialTab => {
    const doc = makeFakeDocument(); const root = doc.createElement('div');
    const read = vi.fn(async (): Promise<import('@recued/contracts').AuthenticationRepairWorklist> => ({ observed_at: 1234, unavailable: [], groups: [{
      id: 'a'.repeat(64), kind: 'account', label: 'Work account', authentication: 'direct_oauth', connection_names: ['work'], usage_available: false,
      issues: [{ id: 'b'.repeat(64), code: 'credential_rejected', message: 'Recorded authentication failure.' }], uses: [], targets: [{ kind: 'connection', name: 'work' }],
    }] }));
    const route = bootstrapConnectionsRoute({ root: root as unknown as HTMLElement, document: doc as unknown as Document,
      initialTab, ...enrollCallers(), authenticationRepairsCaller: read });
    await route.whenLoaded();
    await vi.waitFor(() => expect(findByAttrValue(root, 'data-authentication-repair-group', 'a'.repeat(64))).not.toBeNull());
    const content = findByAttrValue(root, CONNECTIONS_ROUTE_CONTENT_ATTR, '')!;
    expect(collectByAttr(content, 'data-authentication-repair-group')).toEqual([]);
    await route.accountsPanel()?.refresh();
    expect(findByAttrValue(root, 'data-authentication-repair-group', 'a'.repeat(64))).not.toBeNull(); expect(read).toHaveBeenCalledTimes(1); route.dispose();
  });
  it('opens the saved-app manager from its repair destination using reads only', async () => {
    const doc = makeFakeDocument(); const root = doc.createElement('div');
    const call = vi.fn<import('../settings/oauth-apps-panel.js').OAuthAppsCaller>(async request => ({ action: request.action, apps: [] }));
    const route = bootstrapConnectionsRoute({ root: root as unknown as HTMLElement, document: doc as unknown as Document,
      initialTab: 'others', ...enrollCallers(), oauthAppsCaller: call, initialManageOAuthApps: true });
    const html = (el: FakeEl): string => el.innerHTML + el.children.map(html).join('');
    await route.whenLoaded(); await vi.waitFor(() => expect(call).toHaveBeenCalled());
    expect(html(root)).toContain('data-oauth-app-action="add"'); expect(call.mock.calls.map(([request]) => request.action)).toEqual(['list']); route.dispose();
  });
});

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

/** D-201 Slice 10C — a profile as a 10C server projects it: its event
 *  catalog, grammar included. */
const projectedCapability = (
  profileId: keyof typeof WEBHOOK_PROFILE_REGISTRY,
  eventTypes = WEBHOOK_PROFILE_REGISTRY[profileId].event_types,
): WebhookProfileRuntimeCapabilityView => ({
  profile_id: profileId,
  registration_modes: WEBHOOK_PROFILE_REGISTRY[profileId].registration_modes,
  deduplication: WEBHOOK_PROFILE_REGISTRY[profileId].deduplication,
  event_types: eventTypes,
});

const webhookList = (
  ingresses: readonly WebhookIngressView[],
  profiles: readonly WebhookProfileRuntimeCapabilityView[] =
    TEST_WEBHOOK_PROFILE_CAPABILITIES,
) => ({ ingresses, profiles });

/** D-201 Slice 10C — the webhooks route with every caller a card needs, the
 *  list served from `ingresses` (or a function of the moment). */
const webhookRouteCallers = (
  root: FakeEl,
  doc: FakeDoc,
  ingresses: readonly WebhookIngressView[] | (() => readonly WebhookIngressView[]),
  profiles: readonly WebhookProfileRuntimeCapabilityView[],
) => {
  const current = () => typeof ingresses === 'function' ? ingresses() : ingresses;
  const any = () => ({ ingress: current()[0] ?? readyWebhook() });
  return {
    root: root as unknown as HTMLElement,
    document: doc as unknown as Document,
    initialTab: 'webhooks' as const,
    webhooksListCaller: vi.fn(async () => webhookList(current(), profiles)),
    webhooksCreateCaller: vi.fn(async () => any()),
    webhooksCredentialWriteCaller: vi.fn(async () => ({
      ...any(),
      credential_version: readyWebhook().active_credential_versions[0]!,
    })),
    webhooksCredentialRetireCaller: vi.fn(async () => any()),
    webhooksManualConfirmCaller: vi.fn(async () => any()),
    webhooksEnableCaller: vi.fn(async () => any()),
    webhooksDisableCaller: vi.fn(async () => any()),
  };
};

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

  it('keeps sign-in tools in a closed Advanced section under the Apps & APIs list', async () => {
    const doc = makeFakeDocument(); const root = doc.createElement('div');
    const apps = vi.fn<import('../settings/oauth-apps-panel.js').OAuthAppsCaller>(async () => ({ action: 'list', apps: [] }));
    const broker = vi.fn<import('../settings/managed-oauth-panel.js').ManagedOAuthCaller>(async () => ({ action: 'profiles', profiles: [] }));
    const route = bootstrapConnectionsRoute({ root: root as unknown as HTMLElement, document: doc as unknown as Document,
      initialTab: 'others', ...enrollCallers(), oauthAppsCaller: apps, connectionsManagedOAuthCaller: broker });
    await route.whenLoaded();
    const content = collectByAttr(root, CONNECTIONS_ROUTE_CONTENT_ATTR)[0]!;
    const advanced = collectByAttr(root, 'data-recued-connections-advanced')[0]!;
    // Below the list: the enrolled connections and Add lead the page.
    expect(content.children.indexOf(advanced)).toBeGreaterThan(content.children.indexOf(collectByAttr(content, CONNECTIONS_ROUTE_ENROLL_HOST_ATTR)[0]!));
    const tools = collectByAttr(advanced, 'data-recued-connections-tool');
    expect(tools.map(tool => tool.getAttribute('data-recued-connections-tool'))).toEqual(['oauth-apps', 'managed-sign-in', 'bulk-migration']);
    expect(tools.map(tool => (tool as unknown as { open?: boolean }).open ?? false)).toEqual([false, false, false]);
    expect(treeText(advanced)).toContain('Your own OAuth apps'); expect(treeText(advanced)).not.toContain('Authentication settings');
    expect(broker).not.toHaveBeenCalled();
    route.dispose();
  });

  it('opens the saved OAuth apps card for its deep link', async () => {
    const doc = makeFakeDocument(); const root = doc.createElement('div');
    const apps = vi.fn<import('../settings/oauth-apps-panel.js').OAuthAppsCaller>(async () => ({ action: 'list', apps: [] }));
    const route = bootstrapConnectionsRoute({ root: root as unknown as HTMLElement, document: doc as unknown as Document,
      initialTab: 'others', ...enrollCallers(), oauthAppsCaller: apps, initialManageOAuthApps: true });
    await route.whenLoaded();
    const card = findByAttrValue(root, 'data-recued-connections-tool', 'oauth-apps') as unknown as { open?: boolean };
    expect(card.open).toBe(true); route.dispose();
  });

  it.each(['mail', 'webhooks'] as const)('has no Advanced section on %s', tab => {
    const doc = makeFakeDocument(); const root = doc.createElement('div');
    const route = bootstrapConnectionsRoute({ root: root as unknown as HTMLElement, document: doc as unknown as Document, initialTab: tab,
      oauthAppsCaller: vi.fn(), connectionsManagedOAuthCaller: vi.fn() });
    expect(collectByAttr(root, 'data-recued-connections-advanced')).toEqual([]); route.dispose();
  });

  it('opens broker management in Apps & APIs without enrollment and guards its credential draft (D-322)', async () => {
    const doc = makeFakeDocument(); const root = doc.createElement('div');
    const call = vi.fn<import('../settings/managed-oauth-panel.js').ManagedOAuthCaller>(async (args) => {
      if (args.action === 'profiles') return { action: 'profiles', profiles: [] };
      throw new Error('Unexpected broker request');
    });
    const route = bootstrapConnectionsRoute({ root: root as unknown as HTMLElement, document: doc as unknown as Document,
      initialTab: 'others', ...enrollCallers(), connectionsManagedOAuthCaller: call });
    await route.whenLoaded(); expect(call).not.toHaveBeenCalled();
    const button = collectByAttr(root, CONNECTIONS_MANAGE_BROKERS_ATTR)[0]!; button.click();
    for (let i = 0; i < 14; i += 1) await Promise.resolve();
    expect(call).toHaveBeenCalledWith({ action: 'profiles' });
    expect(route.connectionsEnrollPanel()!.getState().dialog.stage).toBe('closed');
    const editor = button.parent!.children[2]!;
    expect(editor.innerHTML).toContain('Manage the brokers');
    clickAction(editor, { managedAction: 'add' });
    fire(editor, 'input', { type: 'input', target: { tagName: 'INPUT', dataset: { managedField: 'key' }, value: 'private-broker-key' } });
    expect(route.hasUnsavedChanges()).toBe(true);
    expect(route.unsavedChangesPrompt()).toContain('OAuth broker setup');
    expect(route.unsavedChangesPrompt()).not.toContain('private-broker-key');
    route.dispose(); expect(editor.listeners.get('input')).toEqual([]);
  });

  it('closes and reopens broker management while protecting and clearing its private draft (D-322)', async () => {
    const doc = makeFakeDocument(); const root = doc.createElement('div'); const confirm = vi.fn((_prompt: string) => false);
    doc.defaultView = { confirm };
    const call = vi.fn<import('../settings/managed-oauth-panel.js').ManagedOAuthCaller>(async () => ({ action: 'profiles', profiles: [] }));
    const route = bootstrapConnectionsRoute({ root: root as unknown as HTMLElement, document: doc as unknown as Document,
      initialTab: 'others', ...enrollCallers(), connectionsManagedOAuthCaller: call });
    await route.whenLoaded(); const button = collectByAttr(root, CONNECTIONS_MANAGE_BROKERS_ATTR)[0]!;
    button.click(); for (let i = 0; i < 14; i += 1) await Promise.resolve();
    const editor = button.parent!.children[2]!; clickAction(editor, { managedAction: 'add' });
    fire(editor, 'input', { type: 'input', target: { tagName: 'INPUT', dataset: { managedField: 'key' }, value: 'private-broker-key' } });
    button.click(); expect(button.getAttribute('aria-expanded')).toBe('true'); expect(route.hasUnsavedChanges()).toBe(true);
    expect(confirm.mock.calls[0]![0]).not.toContain('private-broker-key');
    confirm.mockReturnValue(true); button.click(); expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(editor.innerHTML).toBe('');
    expect(route.hasUnsavedChanges()).toBe(false); button.click(); expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(editor.innerHTML).not.toContain('private-broker-key'); route.dispose();
  });

  it.each(['old cache', 'missing cache'] as const)('probes the revision shown in account usage with $0 (D-322)', async cache => {
    const doc = makeFakeDocument(); const root = doc.createElement('div'); const callers = enrollCallers();
    callers.connectionsEnrollListCaller.mockResolvedValue({ connections: cache === 'old cache'
      ? [connection('saved-sheets', { updated_at: 1, auth_type: 'managed_oauth' })] : [] });
    const call: import('../settings/managed-oauth-panel.js').ManagedOAuthCaller = async args => {
      switch (args.action) {
        case 'profiles': return { action: 'profiles', profiles: [{ id: 'cloud', label: 'Cloud', broker: 'nango', base_url: 'https://api.nango.dev', revision: 1 }] };
        case 'integrations': return { action: 'integrations', integrations: [{ id: 'sheets', label: 'Sheets', provider: 'google-sheet', default_scopes: [], scope_metadata: 'unknown' }] };
        case 'remote_connections': return { action: 'remote_connections', connections: [{ id: 'account', label: 'Account', auth_error: false }], page: 0, has_more: false };
        case 'account_usage': return { action: 'account_usage', usage: { connection_id: 'account', auth_error: false, warnings: [],
          connections: [{ name: 'saved-sheets', display_name: 'Sheets', updated_at: 7, health: { status: 'unknown' }, uses: [], usage_available: true }] } };
        default: throw new Error('Unexpected broker request');
      }
    };
    const route = bootstrapConnectionsRoute({ root: root as unknown as HTMLElement, document: doc as unknown as Document,
      initialTab: 'others', ...callers, connectionsManagedOAuthCaller: call });
    await route.whenLoaded(); const button = collectByAttr(root, CONNECTIONS_MANAGE_BROKERS_ATTR)[0]!;
    button.click(); await tick(); const editor = button.parent!.children[2]!;
    const select = (field: string, value: string) => fire(editor, 'change', {
      type: 'change', target: { tagName: 'SELECT', dataset: { managedField: field }, value },
    });
    select('integration', 'sheets'); await tick(); select('account', 'account'); await tick();
    clickAction(editor, { managedAction: 'check-connection', managedName: 'saved-sheets' }); await tick();
    expect(callers.connectionsProbeCaller).toHaveBeenCalledWith({ kind: 'api', name: 'saved-sheets', expected_updated_at: 7 });
    route.dispose();
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
    expect(content.innerHTML).toContain('the same as before the update');
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
    // D-201 Slice 10AU (10AS finding 28) — in words, never the code.
    expect(treeText(root)).toContain(
      'Last thing that went wrong Recued could not confirm that it removed this webhook from the other service.');
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

  it('D-201 Slice 10B — lists the messages that did not reach their recipes, tries one again and closes one with a reason', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const base = readyWebhook();
    const ingress: WebhookIngressView = { ...base, intake_state: 'enabled' };
    const target = {
      kind: 'target',
      dead_letter_id: 'whx_00000000000000000000000000000001',
      ingress_id: ingress.ingress_id,
      delivery_id: 'whd_00000000000000000000000000000001',
      event_id: 'whe_00000000000000000000000000000001',
      provider_event_type: 'delivery',
      received_at: 2_100_000_000_000,
      recipe_id: 'track-parcels',
      attempt_count: 8,
      last_error_code: 'run_failed',
      dead_lettered_at: 2_100_000_000_500,
      payload_retained: true,
    } satisfies WebhookDeadLetterView;
    const event = {
      ...target,
      kind: 'event',
      dead_letter_id: 'who_00000000000000000000000000000002',
      event_id: 'whe_00000000000000000000000000000002',
      recipe_id: null,
      last_error_code: 'dispatch_failed',
      dead_lettered_at: 2_100_000_000_400,
    } satisfies WebhookDeadLetterView;
    let waiting: WebhookDeadLetterView[] = [target, event];
    const review = () => ({ unresolved: waiting.length, limit: 1_000 });
    const runDeadLetterList = vi.fn(async (): Promise<WebhookDeadLetterListResponse> => ({
      dead_letters: [...waiting],
      next_cursor: null,
      review: review(),
    }));
    const settle = (outcome: 'requeued' | 'resolved') => async (
      args: WebhookDeadLetterActionRequest,
    ): Promise<WebhookDeadLetterActionResponse> => {
      waiting = waiting.filter((row) => row.dead_letter_id !== args.dead_letter.dead_letter_id);
      return { dead_letter: args.dead_letter, outcome, review_id: 'whv_00000000000000000000000000000001', acted_at: 1 };
    };
    const runDeadLetterRequeue = vi.fn(settle('requeued'));
    const runDeadLetterResolve = vi.fn(settle('resolved'));
    const runList = vi.fn(async () => ({
      ...webhookList([{ ...ingress, dead_letters_unresolved: waiting.length }]),
      dead_letter_review: review(),
    }));
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
      webhooksDeadLetterListCaller: runDeadLetterList,
      webhooksDeadLetterRequeueCaller: runDeadLetterRequeue,
      webhooksDeadLetterResolveCaller: runDeadLetterResolve,
    });
    await route.webhooksPanel()!.refresh();

    const open = findByAttrValue(root, WEBHOOKS_PANEL_ACTION_ATTR, 'dead-letters')!;
    expect(open.textContent).toBe('See the messages that did not reach their recipes (2)');
    open.click();
    await tick();
    expect(runDeadLetterList).toHaveBeenCalledWith({ ingress_id: ingress.ingress_id, limit: 10 });
    expect(collectByAttr(root, WEBHOOKS_PANEL_DEAD_LETTERS_ATTR)).toHaveLength(1);
    expect(collectByAttr(root, WEBHOOKS_PANEL_DEAD_LETTER_ATTR)).toHaveLength(2);
    expect(treeText(root)).toContain('Its run of track-parcels');
    expect(treeText(root)).toContain('Handing it to its recipes');
    expect(treeText(root)).toContain('Closing deletes nothing and does not say the recipe ran.');
    expect(collectByAttr(root, WEBHOOKS_PANEL_DEAD_LETTER_REVIEW_ATTR)).toHaveLength(0);

    // Closing one needs a reason; the reason the owner types is what is sent.
    const item = (key: string) => findByAttrValue(root, WEBHOOKS_PANEL_DEAD_LETTER_ATTR, key)!;
    const eventKey = `event:${event.dead_letter_id}`;
    findByAttrValue(item(eventKey), WEBHOOKS_PANEL_ACTION_ATTR, 'dead-letter-resolve')!.click();
    await tick();
    expect(runDeadLetterResolve).not.toHaveBeenCalled();
    expect(treeText(root)).toContain('Write why you are closing it first.');
    const reason = findByAttrValue(item(eventKey), WEBHOOKS_PANEL_FIELD_ATTR, 'dead-letter-reason')!;
    reason.value = '  Refunded by hand  ';
    fire(reason, 'input', { target: reason, type: 'input' });
    findByAttrValue(item(eventKey), WEBHOOKS_PANEL_ACTION_ATTR, 'dead-letter-resolve')!.click();
    await tick();
    expect(runDeadLetterResolve).toHaveBeenCalledWith({
      ingress_id: ingress.ingress_id,
      dead_letter: { kind: 'event', dead_letter_id: event.dead_letter_id },
      dead_lettered_at: event.dead_lettered_at,
      reason: 'Refunded by hand',
    });
    expect(treeText(root)).toContain('Closed. Recued keeps your reason with it.');
    expect(collectByAttr(root, WEBHOOKS_PANEL_DEAD_LETTER_ATTR)).toHaveLength(1);

    // Trying one again needs no reason.
    findByAttrValue(item(`target:${target.dead_letter_id}`), WEBHOOKS_PANEL_ACTION_ATTR, 'dead-letter-requeue')!.click();
    await tick();
    expect(runDeadLetterRequeue).toHaveBeenCalledWith({
      ingress_id: ingress.ingress_id,
      dead_letter: { kind: 'target', dead_letter_id: target.dead_letter_id },
      dead_lettered_at: target.dead_lettered_at,
    });
    expect(treeText(root)).toContain('Recued is trying it again now.');
    expect(collectByAttr(root, WEBHOOKS_PANEL_DEAD_LETTER_ATTR)).toHaveLength(0);
    expect(treeText(root)).toContain('None are waiting');
    // The list was read again after each action, and the card's count with it.
    expect(runDeadLetterList).toHaveBeenCalledTimes(3);
    expect(runList.mock.calls.length).toBeGreaterThanOrEqual(3);

    route.dispose();
  });

  it('D-201 Slice 10B — warns at the review limit, keeps Try again closed on a switched-off webhook, and reloads on a refusal', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const ingress: WebhookIngressView = {
      ...readyWebhook(),
      intake_state: 'disabled',
      dead_letters_unresolved: 1,
    };
    const deadLetter = {
      kind: 'target',
      dead_letter_id: 'whx_00000000000000000000000000000009',
      ingress_id: ingress.ingress_id,
      delivery_id: 'whd_00000000000000000000000000000009',
      event_id: 'whe_00000000000000000000000000000009',
      provider_event_type: 'delivery',
      received_at: 2_100_000_000_000,
      recipe_id: 'track-parcels',
      attempt_count: 8,
      last_error_code: null,
      dead_lettered_at: 2_100_000_000_500,
      payload_retained: false,
    } satisfies WebhookDeadLetterView;
    const runDeadLetterList = vi.fn(async (): Promise<WebhookDeadLetterListResponse> => ({
      dead_letters: [deadLetter],
      next_cursor: null,
      review: { unresolved: 1_000, limit: 1_000 },
    }));
    const runDeadLetterResolve = vi.fn(async (): Promise<WebhookDeadLetterActionResponse> => {
      throw new Error('the dead letter changed since it was shown; look at it again');
    });
    const route = bootstrapConnectionsRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      initialTab: 'webhooks',
      webhooksListCaller: vi.fn(async () => ({
        ...webhookList([ingress]),
        dead_letter_review: { unresolved: 1_000, limit: 1_000 },
      })),
      webhooksCreateCaller: vi.fn(async () => ({ ingress })),
      webhooksCredentialWriteCaller: vi.fn(async () => ({
        ingress,
        credential_version: ingress.active_credential_versions[0]!,
      })),
      webhooksCredentialRetireCaller: vi.fn(async () => ({ ingress })),
      webhooksManualConfirmCaller: vi.fn(async () => ({ ingress })),
      webhooksEnableCaller: vi.fn(async () => ({ ingress })),
      webhooksDisableCaller: vi.fn(async () => ({ ingress })),
      webhooksDeadLetterListCaller: runDeadLetterList,
      webhooksDeadLetterRequeueCaller: vi.fn(async () => { throw new Error('not called'); }),
      webhooksDeadLetterResolveCaller: runDeadLetterResolve,
    });
    await route.webhooksPanel()!.refresh();
    expect(collectByAttr(root, WEBHOOKS_PANEL_DEAD_LETTER_REVIEW_ATTR)).toHaveLength(1);
    expect(treeText(root)).toContain('Recued keeps at most 1,000 messages that did not reach their recipes');
    // D-201 Slice 10AD (10AA finding 17) — the limit closes those no door let
    // run first: it said "the oldest".
    expect(treeText(root)).toContain('Each new one closes one that no door let run first, then the oldest');

    findByAttrValue(root, WEBHOOKS_PANEL_ACTION_ATTR, 'dead-letters')!.click();
    await tick();
    const requeue = findByAttrValue(root, WEBHOOKS_PANEL_ACTION_ATTR, 'dead-letter-requeue')!;
    expect(requeue.disabled).toBe(true);
    expect(requeue.getAttribute('title') ?? (requeue as unknown as { title?: string }).title)
      .toBe('Switch this webhook on first');
    expect(treeText(root)).toContain('Not kept');

    const reason = findByAttrValue(root, WEBHOOKS_PANEL_FIELD_ATTR, 'dead-letter-reason')!;
    reason.value = 'Closing it';
    fire(reason, 'input', { target: reason, type: 'input' });
    findByAttrValue(root, WEBHOOKS_PANEL_ACTION_ATTR, 'dead-letter-resolve')!.click();
    await tick();
    expect(runDeadLetterResolve).toHaveBeenCalledTimes(1);
    expect(treeText(root)).toContain('look at it again');
    // Refused: the list is read again, and what was typed is kept.
    expect(runDeadLetterList).toHaveBeenCalledTimes(2);
    expect(findByAttrValue(root, WEBHOOKS_PANEL_FIELD_ATTR, 'dead-letter-reason')!.value).toBe('Closing it');

    route.dispose();
  });

  it('D-201 Slice 10U — a dead letter its recipe never ran for want of a door says so, and a refused try again says what lets it run (10Q finding 9)', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    // D-201 Slice 10X — a server that lists the recipes the webhook starts.
    const ingress: WebhookIngressView = {
      ...readyWebhook(),
      intake_state: 'enabled',
      dead_letters_unresolved: 2,
      recipes: [{ recipe_id: 'track-parcels', consumer_kind: 'local_recipe', armed: true, door: 'missing' }],
    };
    const item = (index: number, code: string): WebhookDeadLetterView => ({
      kind: 'target',
      dead_letter_id: `whx_${String(index).padStart(32, '0')}`,
      ingress_id: ingress.ingress_id,
      delivery_id: `whd_${String(index).padStart(32, '0')}`,
      event_id: `whe_${String(index).padStart(32, '0')}`,
      provider_event_type: 'delivery',
      received_at: 2_100_000_000_000 + index,
      recipe_id: 'track-parcels',
      attempt_count: 1,
      last_error_code: code,
      dead_lettered_at: 2_100_000_001_000 + index,
      payload_retained: true,
    });
    const open = [item(0, 'door_missing'), item(1, 'door_closed')];
    const runDeadLetterRequeue = vi.fn(async (args: WebhookDeadLetterActionRequest): Promise<WebhookDeadLetterActionResponse> => {
      throw Object.assign(new Error('webhook.delivery.dead_letter.requeue: its recipe has no webhook door, so it cannot run'), {
        code: 'webhook_dead_letter_no_door',
        details: { door: args.dead_letter.dead_letter_id === open[0]!.dead_letter_id ? 'missing' : 'closed' },
      });
    });
    const route = bootstrapConnectionsRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      initialTab: 'webhooks',
      webhooksListCaller: vi.fn(async () => webhookList([ingress])),
      webhooksCreateCaller: vi.fn(async () => ({ ingress })),
      webhooksCredentialWriteCaller: vi.fn(async () => ({ ingress, credential_version: ingress.active_credential_versions[0]! })),
      webhooksCredentialRetireCaller: vi.fn(async () => ({ ingress })),
      webhooksManualConfirmCaller: vi.fn(async () => ({ ingress })),
      webhooksEnableCaller: vi.fn(async () => ({ ingress })),
      webhooksDisableCaller: vi.fn(async () => ({ ingress })),
      webhooksDeadLetterListCaller: vi.fn(async (): Promise<WebhookDeadLetterListResponse> => ({
        dead_letters: open, next_cursor: null, review: { unresolved: 2, limit: 1_000 },
      })),
      webhooksDeadLetterRequeueCaller: runDeadLetterRequeue,
      webhooksDeadLetterResolveCaller: vi.fn(async () => { throw new Error('not called'); }),
    });
    await route.webhooksPanel()!.refresh();
    findByAttrValue(root, WEBHOOKS_PANEL_ACTION_ATTR, 'dead-letters')!.click();
    await tick();
    // D-201 Slice 10X (10V finding 12) — remedies the owner can take: 10U said
    // to save again (refused for a pack's recipe) or to switch the door on
    // under Contracts (which has no such switch).
    const missing = "Its recipe never ran it: there is no door behind the recipe's webhook. "
      + 'Open its door under "Recipes it starts" above, then try it again.';
    const closed = "Its recipe never ran it: the door behind the recipe's webhook is closed. "
      + 'Open its door under "Recipes it starts" above, then try it again.';
    // The codes, in words (they showed as `door_missing`; before, such a
    // message was cancelled unseen and never listed).
    expect(treeText(root)).toContain(`Last problem ${missing}`);
    expect(treeText(root)).toContain(`Last problem ${closed}`);
    expect(treeText(root)).not.toContain('door_missing');
    const requeueOf = (index: number) => findByAttrValue(
      findByAttrValue(root, WEBHOOKS_PANEL_DEAD_LETTER_ATTR, `target:${open[index]!.dead_letter_id}`)!,
      WEBHOOKS_PANEL_ACTION_ATTR,
      'dead-letter-requeue',
    )!;
    requeueOf(1).click();
    await tick();
    expect(runDeadLetterRequeue).toHaveBeenCalledTimes(1);
    expect(treeText(root)).not.toContain('webhook.delivery.dead_letter.requeue');
    expect(treeText(root).split(closed).length - 1).toBeGreaterThanOrEqual(2);
    requeueOf(0).click();
    await tick();
    expect(treeText(root).split(missing).length - 1).toBeGreaterThanOrEqual(2);
    route.dispose();
  });

  it("D-201 Slice 10X — lists the recipes a webhook starts, each with its door, a way to the recipe, and a way to open a door that is not open", async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const ingress: WebhookIngressView = {
      ...readyWebhook(),
      intake_state: 'enabled',
      recipes: [
        { recipe_id: 'track-parcels', name: 'Track parcels', consumer_kind: 'local_recipe', armed: true, door: 'open' },
        {
          recipe_id: 'deal-alerts',
          name: 'Deal alerts',
          consumer_kind: 'pack_install',
          pack_slug: 'hubspot',
          armed: true,
          door: 'missing',
          door_reason: 'a step names no account yet.',
          door_reason_code: 'no_account',
        },
        { recipe_id: 'refund-notice', name: 'Refund notice', consumer_kind: 'local_recipe', armed: true, door: 'closed' },
        { recipe_id: 'old-hook', name: 'Old hook', consumer_kind: 'local_recipe', armed: false, door: 'closed' },
      ],
    };
    const runEnable = vi.fn(async () => ({ ingress }));
    const route = bootstrapConnectionsRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      initialTab: 'webhooks',
      webhooksListCaller: vi.fn(async () => webhookList([ingress])),
      webhooksCreateCaller: vi.fn(async () => ({ ingress })),
      webhooksCredentialWriteCaller: vi.fn(async () => ({ ingress, credential_version: ingress.active_credential_versions[0]! })),
      webhooksCredentialRetireCaller: vi.fn(async () => ({ ingress })),
      webhooksManualConfirmCaller: vi.fn(async () => ({ ingress })),
      webhooksEnableCaller: runEnable,
      webhooksDisableCaller: vi.fn(async () => ({ ingress })),
    });
    await route.webhooksPanel()!.refresh();
    const section = findByAttrValue(root, WEBHOOKS_PANEL_RECIPES_ATTR, ingress.ingress_id)!;
    expect(section).not.toBeNull();
    expect(treeText(section)).toContain('Recipes it starts');
    const recipe = (id: string) => findByAttrValue(section, WEBHOOKS_PANEL_RECIPE_ATTR, id)!;
    // Each links to its recipe (its page under Recipes; Kitchen links back here).
    expect(collectByAttr(recipe('track-parcels'), 'href').map((link) => link.getAttribute('href')))
      .toEqual(['#recipes/track-parcels']);
    expect(treeText(recipe('track-parcels'))).toContain('Its door is open');
    expect(treeText(recipe('deal-alerts'))).toContain('(from the pack hubspot)');
    expect(treeText(recipe('deal-alerts'))).toContain(
      'It has no door yet: a step names no account yet. Choose its account in its settings, then open its door.',
    );
    expect(treeText(recipe('refund-notice'))).toContain('Its door is closed, so nothing it is sent runs.');
    // One switched off in Kitchen is Kitchen's to switch on.
    expect(treeText(recipe('old-hook'))).toContain('Its own webhook switch is off, in Kitchen');
    const openButton = (id: string) => findByAttrValue(recipe(id), WEBHOOKS_PANEL_ACTION_ATTR, 'door-open');
    expect(openButton('track-parcels')).toBeNull();
    expect(openButton('old-hook')).toBeNull();
    expect(openButton('deal-alerts')).not.toBeNull();
    // Opening a door switches the webhook on again: every door not open is made.
    openButton('refund-notice')!.click();
    await tick();
    expect(runEnable).toHaveBeenCalledWith({ ingress_id: ingress.ingress_id });
    route.dispose();
  });

  // D-201 Slice 10AF (the owner's rulings of 2026-11-20) — the webhook's
  // switch is the master for the outside world; starting several recipes, each
  // also has its own door switch. Starting one, the master is its only switch.
  it("D-201 Slice 10AF — starting several recipes, each has its own door switch beside the webhook's", async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const ingress: WebhookIngressView = {
      ...readyWebhook(),
      intake_state: 'enabled',
      recipe_door_switch: true,
      recipes: [
        { recipe_id: 'track-parcels', name: 'Track parcels', consumer_kind: 'local_recipe', armed: true, door: 'open' },
        { recipe_id: 'deal-alerts', name: 'Deal alerts', consumer_kind: 'pack_install', pack_slug: 'hubspot', armed: true, door: 'missing' },
        {
          recipe_id: 'refund-notice',
          name: 'Refund notice',
          consumer_kind: 'local_recipe',
          armed: true,
          door: 'closed',
          closed_by_owner: true,
        },
        { recipe_id: 'old-hook', name: 'Old hook', consumer_kind: 'local_recipe', armed: false, door: 'open' },
        // D-201 Slice 10AO (10AM finding 15) — closed before its door was made.
        {
          recipe_id: 'refund-hold',
          name: 'Refund hold',
          consumer_kind: 'pack_install',
          pack_slug: 'refunds',
          armed: true,
          door: 'closed',
          closed_by_owner: true,
          no_door_yet: true,
        },
        // D-201 Slice 10AX (10AS finding 10) — closed after its door was made,
        // no door now, and why.
        {
          recipe_id: 'refund-gone',
          name: 'Refund gone',
          consumer_kind: 'local_recipe',
          armed: true,
          door: 'closed',
          closed_by_owner: true,
          no_door: true,
          door_reason: "Records recipe 'refund-gone' cannot be exposed through webhook: it reads Records.",
          door_reason_code: 'refused',
        },
        // D-201 Slice 10BE (10AY findings 16 and 18) — a closed door that still
        // stands says why one cannot be made, the server's reason after a colon
        // and ending as a sentence.
        {
          recipe_id: 'refund-stuck',
          name: 'Refund stuck',
          consumer_kind: 'local_recipe',
          armed: true,
          door: 'closed',
          closed_by_owner: true,
          door_reason: "step 'deal' resolves its connection at runtime ({{config.not_chosen}}), so which connection it "
            + 'would use is not knowable in advance.',
          door_reason_code: 'no_account',
        },
        {
          recipe_id: 'refund-unchecked',
          name: 'Refund unchecked',
          consumer_kind: 'local_recipe',
          armed: true,
          door: 'closed',
          closed_by_owner: true,
          no_door: true,
          door_reason: 'the records store is busy',
          door_reason_code: 'fault',
        },
        {
          recipe_id: 'refund-retired',
          name: 'Refund retired',
          consumer_kind: 'local_recipe',
          armed: true,
          door: 'closed',
          door_reason: "Records recipe 'refund-retired' cannot be exposed through webhook: it reads Records",
          door_reason_code: 'refused',
        },
      ],
    };
    const runEnable = vi.fn(async () => ({ ingress }));
    const runDoorSet = vi.fn(async () => ({ ingress }));
    const route = bootstrapConnectionsRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      initialTab: 'webhooks',
      webhooksListCaller: vi.fn(async () => webhookList([ingress])),
      webhooksCreateCaller: vi.fn(async () => ({ ingress })),
      webhooksCredentialWriteCaller: vi.fn(async () => ({ ingress, credential_version: ingress.active_credential_versions[0]! })),
      webhooksCredentialRetireCaller: vi.fn(async () => ({ ingress })),
      webhooksManualConfirmCaller: vi.fn(async () => ({ ingress })),
      webhooksEnableCaller: runEnable,
      webhooksDisableCaller: vi.fn(async () => ({ ingress })),
      webhooksDoorSetCaller: runDoorSet,
    });
    await route.webhooksPanel()!.refresh();
    const section = findByAttrValue(root, WEBHOOKS_PANEL_RECIPES_ATTR, ingress.ingress_id)!;
    const recipe = (id: string) => findByAttrValue(section, WEBHOOKS_PANEL_RECIPE_ATTR, id)!;
    const action = (id: string, name: string) => findByAttrValue(recipe(id), WEBHOOKS_PANEL_ACTION_ATTR, name);
    // D-201 Slice 10AJ (10AI finding 10) — it said what is sent "waits, unrun,
    // until you open it again": opening the door runs none of it.
    expect(treeText(recipe('refund-notice'))).toContain(
      'You closed its door, so what is sent to it does not run. It waits with the messages that did not reach their '
        + 'recipes, to try again once you open the door.',
    );
    expect(action('track-parcels', 'door-close')?.textContent).toBe('Close its door');
    expect((action('track-parcels', 'door-close') as unknown as { title?: string }).title).toBe(
      'What is sent to it then waits with the messages that did not reach their recipes, to try again once it is '
        + 'open. A run already going ends as one you refused.',
    );
    expect(action('track-parcels', 'door-open')).toBeNull();
    expect(action('refund-notice', 'door-open')?.textContent).toBe('Open its door');
    // D-201 Slice 10AO (10AM finding 15) — in the words its messages wait in:
    // "there is no door behind the recipe's webhook".
    expect(treeText(recipe('refund-hold'))).toContain(
      'You closed it before its door was made, so there is no door behind it and what is sent to it does not run. '
        + 'It waits with the messages that did not reach their recipes, to try again once you open the door.',
    );
    expect(treeText(recipe('refund-hold'))).not.toContain('You closed its door,');
    expect(action('refund-hold', 'door-open')?.textContent).toBe('Open its door');
    expect(action('deal-alerts', 'door-open')).not.toBeNull();
    // One switched off in Kitchen is Kitchen's to switch.
    expect(action('old-hook', 'door-close')).toBeNull();
    expect(action('old-hook', 'door-open')).toBeNull();
    action('track-parcels', 'door-close')!.click();
    await tick();
    expect(runDoorSet).toHaveBeenLastCalledWith({ ingress_id: ingress.ingress_id, recipe_id: 'track-parcels', open: false });
    action('refund-notice', 'door-open')!.click();
    await tick();
    expect(runDoorSet).toHaveBeenLastCalledWith({ ingress_id: ingress.ingress_id, recipe_id: 'refund-notice', open: true });
    // D-201 Slice 10AX (10AS finding 10) — a door its owner closed after it
    // was made, none now: said so, with why. It said "before its door was made".
    expect(treeText(recipe('refund-gone'))).toContain(
      'You closed its door, and there is no door behind it now, so what is sent to it does not run. It cannot have '
        + "a door as it stands: Records recipe 'refund-gone' cannot be exposed through webhook: it reads Records. "
        + 'Change the recipe before you open it. It waits with the messages that did not reach their recipes, to try '
        + 'again once you open the door.',
    );
    expect(treeText(recipe('refund-gone'))).not.toContain('before its door was made');
    expect(treeText(recipe('refund-stuck'))).toContain(
      'You closed its door, so what is sent to it does not run. It cannot have a door until its account is chosen: '
        + "step 'deal' resolves its connection at runtime ({{config.not_chosen}}), so which connection it would use is "
        + 'not knowable in advance. Choose its account in its settings before you open it. It waits with the messages '
        + 'that did not reach their recipes, to try again once you open the door.',
    );
    expect(treeText(recipe('refund-unchecked'))).toContain(
      'You closed its door, and there is no door behind it now, so what is sent to it does not run. Recued could not '
        + 'check whether it can have one: the records store is busy. It waits with the messages',
    );
    expect(treeText(recipe('refund-retired'))).toContain(
      "Its door is closed, so nothing it is sent runs. It cannot have a door as it stands: Records recipe "
        + "'refund-retired' cannot be exposed through webhook: it reads Records. Change the recipe before you open it.",
    );
    expect(treeText(recipe('refund-retired'))).not.toContain('Open it to let it run again.');
    // D-201 Slice 10AX (10AS finding 11) — a door not made yet is closed here
    // too, so it is made closed. It offered only "Open its door".
    expect(action('deal-alerts', 'door-open')?.textContent).toBe('Open its door');
    expect(action('deal-alerts', 'door-close')?.textContent).toBe('Close its door');
    expect((action('deal-alerts', 'door-close') as unknown as { title?: string }).title).toBe(
      'Its door is then made closed: what is sent to it waits with the messages that did not reach their recipes, '
        + 'to try again once it is open.',
    );
    action('deal-alerts', 'door-close')!.click();
    await tick();
    expect(runDoorSet).toHaveBeenLastCalledWith({ ingress_id: ingress.ingress_id, recipe_id: 'deal-alerts', open: false });
    // Its own switch, never the webhook's: that would open every door.
    expect(runEnable).not.toHaveBeenCalled();
    route.dispose();
  });

  // D-201 Slice 10AJ (10AI finding 5) — a server before 10AF has no per-recipe
  // switch to answer it: none is offered, whatever the webhook starts.
  it('D-201 Slice 10AJ — a server that cannot take a per-recipe switch is offered none', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const ingress: WebhookIngressView = {
      ...readyWebhook(),
      intake_state: 'enabled',
      recipes: [
        { recipe_id: 'track-parcels', name: 'Track parcels', consumer_kind: 'local_recipe', armed: true, door: 'open' },
        { recipe_id: 'refund-notice', name: 'Refund notice', consumer_kind: 'local_recipe', armed: true, door: 'missing' },
      ],
    };
    const runDoorSet = vi.fn(async () => ({ ingress }));
    const route = bootstrapConnectionsRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      initialTab: 'webhooks',
      webhooksListCaller: vi.fn(async () => webhookList([ingress])),
      webhooksCreateCaller: vi.fn(async () => ({ ingress })),
      webhooksCredentialWriteCaller: vi.fn(async () => ({ ingress, credential_version: ingress.active_credential_versions[0]! })),
      webhooksCredentialRetireCaller: vi.fn(async () => ({ ingress })),
      webhooksManualConfirmCaller: vi.fn(async () => ({ ingress })),
      webhooksEnableCaller: vi.fn(async () => ({ ingress })),
      webhooksDisableCaller: vi.fn(async () => ({ ingress })),
      webhooksDoorSetCaller: runDoorSet,
    });
    await route.webhooksPanel()!.refresh();
    const section = findByAttrValue(root, WEBHOOKS_PANEL_RECIPES_ATTR, ingress.ingress_id)!;
    const recipe = (id: string) => findByAttrValue(section, WEBHOOKS_PANEL_RECIPE_ATTR, id)!;
    expect(findByAttrValue(recipe('track-parcels'), WEBHOOKS_PANEL_ACTION_ATTR, 'door-close')).toBeNull();
    findByAttrValue(recipe('refund-notice'), WEBHOOKS_PANEL_ACTION_ATTR, 'door-open')?.click();
    await tick();
    expect(runDoorSet).not.toHaveBeenCalled();
    route.dispose();
  });

  // D-201 Slice 10AL (10AI finding 21) — a stray given up went with its record,
  // and the card's row with it, which read as resolved.
  it('D-201 Slice 10AL — the card says which earlier setups Recued stopped trying to remove, until the owner says they are gone', async () => {
    for (const [count, words, label] of [
      [1, 'Remove at the other service Recued stopped trying to remove an earlier setup of this webhook from the other '
        + 'service after a week of failed tries. Remove it there yourself, then say so here.', 'I removed it'],
      [2, 'Remove at the other service Recued stopped trying to remove 2 earlier setups of this webhook from the other '
        + 'service after a week of failed tries. Remove them there yourself, then say so here.', 'I removed them'],
    ] as const) {
      const doc = makeFakeDocument();
      const root = doc.createElement('div');
      let ingress: WebhookIngressView = { ...readyWebhook(), stray_endpoints: 1, stray_endpoints_given_up: count };
      const callers = webhookRouteCallers(root, doc, () => [ingress], TEST_WEBHOOK_PROFILE_CAPABILITIES);
      const runStraysDismiss = vi.fn(async () => {
        const { stray_endpoints_given_up: _gone, ...rest } = ingress;
        ingress = rest;
        return { ingress };
      });
      const route = bootstrapConnectionsRoute({ ...callers, webhooksStraysDismissCaller: runStraysDismiss });
      await route.webhooksPanel()!.refresh();
      expect(treeText(root)).toContain(words);
      // The ones still being removed are said apart.
      expect(treeText(root)).toContain('Left at the other service An earlier setup of this webhook is still at the other service');
      const removed = findByAttrValue(root, WEBHOOKS_PANEL_ACTION_ATTR, 'strays-dismiss')!;
      expect(removed.textContent).toBe(label);
      removed.click();
      await tick();
      expect(runStraysDismiss).toHaveBeenCalledWith({ ingress_id: ingress.ingress_id });
      // The list read again: the row goes, the others stay.
      expect(treeText(root)).not.toContain('Remove at the other service');
      expect(treeText(root)).toContain('Left at the other service');
      route.dispose();
    }
    // No dismissal wired: still said, with nothing to press. None given up: no row.
    for (const ingress of [
      { ...readyWebhook(), stray_endpoints_given_up: 1 },
      readyWebhook(),
    ] as WebhookIngressView[]) {
      const doc = makeFakeDocument();
      const root = doc.createElement('div');
      const route = bootstrapConnectionsRoute(webhookRouteCallers(root, doc, [ingress], TEST_WEBHOOK_PROFILE_CAPABILITIES));
      await route.webhooksPanel()!.refresh();
      expect(treeText(root).includes('Remove at the other service'))
        .toBe(ingress.stray_endpoints_given_up !== undefined);
      expect(findByAttrValue(root, WEBHOOKS_PANEL_ACTION_ATTR, 'strays-dismiss')).toBeNull();
      route.dispose();
    }
  });

  // D-201 Slice 10AN (the owner's call, 2026-11-20) — a webhook refusing every
  // message read healthy, and the card said nothing. D-201 Slice 10AR (10AM
  // findings 11 and 30) — it says only what the server knows: who sent them it
  // cannot know, so what the owner can do starts from what the other service
  // shows.
  it('D-201 Slice 10AN — the card says when messages are refused, and what Recued does or the owner can', async () => {
    const when = (at: number) => `T${at}`;
    const run = "At least 3 messages to this webhook's address since T1000 could not be verified with the secret it "
      + 'holds, and no message has been verified since. They may come from the other service, or from anyone who '
      + 'has the address.';
    expect(refusingText({ refused: 3, since: 1000, set_again: true }, 'managed_endpoint', when))
      .toBe(`${run} Recued sets this webhook again at the other service, with the secret it holds, at most once an hour.`);
    // D-201 Slice 10AU (10AS finding 5) — no longer once a run.
    expect(refusingText({ refused: 3, since: 1000, set_again: true, set_again_at: 5000 }, 'managed_endpoint', when))
      .toBe(`${run} Recued set this webhook again at the other service, with the secret it holds, at T5000, and `
        + 'sets it again, at most once an hour, while messages are still refused after that. If the other service '
        + 'still shows the messages it sends here failing, something else may be setting it there: switch this '
        + 'webhook off and on.');
    // 10AR (10AM finding 10) — a try that failed is said, never promised again.
    // D-201 Slice 10AU (10AS finding 28) — and what the owner can do when it
    // keeps failing.
    expect(refusingText({ refused: 3, since: 1000, set_again: true, set_again_failed_at: 6000 }, 'managed_endpoint', when))
      .toBe(`${run} Recued tried to set this webhook again at the other service, with the secret it holds, at `
        + 'T6000, and could not. It tries again an hour after that. If it keeps failing, check that the connection '
        + 'this webhook uses can still change webhooks at the other service, and switch this webhook off and on.');
    // No longer "The other service signs them with a secret Recued did not set":
    // an outsider's requests steered the owner into setting it up again.
    expect(refusingText({ refused: 3, since: 1000 }, 'managed_endpoint', when))
      .toBe(`${run} If the other service shows the messages it sends here failing, switch this webhook off and on: `
        + 'Recued sets it up there again, with a new secret. If it shows none failing, nothing needs doing.');
    // D-201 Slice 10AU (10AS finding 28) — by who makes the secret (below);
    // with no profile known, what the owner can always do.
    expect(refusingText({ refused: 3, since: 1000 }, 'manual', when))
      .toBe(`${run} If the other service shows the messages it sends here failing, check that the other service `
        + 'sends the secret this webhook holds; if you cannot tell, enter a new one there and here, with “Swap the '
        + 'keys”. If it shows none failing, nothing needs doing.');
    for (const text of [
      refusingText({ refused: 3, since: 1000 }, 'managed_endpoint', when),
      refusingText({ refused: 3, since: 1000 }, 'manual', when),
    ]) {
      expect(text).not.toContain('signature');
      expect(text).not.toContain('signs them');
    }
    for (const refusing of [{ refused: 4, since: 1000, set_again: true as const }, undefined]) {
      const doc = makeFakeDocument();
      const root = doc.createElement('div');
      const base = readyWebhook();
      const ingress: WebhookIngressView = {
        ...base,
        intake_state: 'enabled',
        health: { ...base.health, ...(refusing !== undefined ? { status: 'degraded' as const, refusing } : {}) },
      };
      const route = bootstrapConnectionsRoute(webhookRouteCallers(root, doc, [ingress], TEST_WEBHOOK_PROFILE_CAPABILITIES));
      await route.webhooksPanel()!.refresh();
      expect(treeText(root).includes("Messages refused At least 4 messages to this webhook's address"))
        .toBe(refusing !== undefined);
      route.dispose();
    }
  });

  // D-201 Slice 10AR (10AM findings 11 and 30) — "None" beside "degraded", and a
  // switched-off webhook told Recued sets it again.
  it('D-201 Slice 10AR — what went wrong names the refusals, and a webhook switched off shows none', async () => {
    const base = readyWebhook();
    const refusing = { refused: 4, since: 1000, set_again: true as const };
    const cases: Array<{ ingress: WebhookIngressView; row: string; refused: boolean }> = [
      {
        ingress: {
          ...base,
          intake_state: 'enabled',
          health: { ...base.health, status: 'degraded', last_error_code: null, refusing },
        },
        row: 'Last thing that went wrong Messages it could not verify (below)',
        refused: true,
      },
      {
        ingress: {
          ...base,
          intake_state: 'degraded',
          health: { ...base.health, status: 'degraded', last_error_code: 'managed_remote_missing', refusing },
        },
        // D-201 Slice 10AU (10AS finding 28) — in words, never the code.
        row: 'Last thing that went wrong What Recued set up at the other service is no longer there.',
        refused: true,
      },
      // A server before 10AR sends it for a webhook switched off too.
      {
        ingress: {
          ...base,
          intake_state: 'disabled',
          health: { ...base.health, status: 'disabled', last_error_code: null, refusing },
        },
        row: 'Last thing that went wrong None',
        refused: false,
      },
    ];
    for (const { ingress, row, refused } of cases) {
      const doc = makeFakeDocument();
      const root = doc.createElement('div');
      const route = bootstrapConnectionsRoute(webhookRouteCallers(root, doc, [ingress], TEST_WEBHOOK_PROFILE_CAPABILITIES));
      await route.webhooksPanel()!.refresh();
      expect(treeText(root)).toContain(row);
      expect(treeText(root).includes('Messages refused')).toBe(refused);
      expect(treeText(root).includes('Recued sets this webhook again')).toBe(refused);
      route.dispose();
    }
  });

  // D-201 Slice 10AQ (10AM findings 7, 23 and 24) — the strays sat inside the
  // collapsed configuration, counted only, and the webhook read as fine.
  it('D-201 Slice 10AQ — names each earlier setup left at the other service where the webhook is read, and one given up needs attention', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const base = readyWebhook();
    const healthy = { ...base.health, status: 'healthy' as const };
    const strayed: WebhookIngressView = {
      ...base,
      display_name: 'Strayed',
      registration_mode: 'managed_endpoint',
      paired_connection_id: 'stripe-test',
      remote_endpoint_id: 'we_live',
      intake_state: 'enabled',
      stray_endpoints: 1,
      stray_endpoints_given_up: 1,
      strays: [
        { remote_endpoint_id: 'we_given_up', connection_id: 'stripe-test', given_up: true },
        { remote_endpoint_id: 'we_standing', connection_id: 'stripe-other', given_up: false },
      ],
      health: { ...healthy, status: 'degraded', refusing: { refused: 4, since: 1000 } },
    };
    const givenUpOnly: WebhookIngressView = {
      ...base,
      ingress_id: 'whi_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      display_name: 'Given up only',
      stray_endpoints_given_up: 1,
      health: healthy,
    };
    const quiet: WebhookIngressView = {
      ...base,
      ingress_id: 'whi_ffffffffffffffffffffffffffffffff',
      display_name: 'Quiet one',
      health: healthy,
    };
    const route = bootstrapConnectionsRoute(
      webhookRouteCallers(root, doc, [strayed, givenUpOnly, quiet], TEST_WEBHOOK_PROFILE_CAPABILITIES),
    );
    await route.webhooksPanel()!.refresh();
    const notice = findByAttrValue(root, WEBHOOKS_PANEL_STRAYS_ATTR, strayed.ingress_id)!;
    expect(notice).not.toBeNull();
    // Where the webhook's state is read: never inside its collapsed configuration.
    for (let parent = notice.parent; parent !== null; parent = parent.parent) {
      expect(parent.tagName).not.toBe('DETAILS');
    }
    expect(treeText(notice)).toContain('It is the endpoint we_given_up at the connection stripe-test.');
    // D-201 Slice 10AT (10AS finding 22) — once, beside all of them, as its state has it.
    expect(treeText(notice).split("This webhook's own endpoint there is we_live: removing that one stops messages "
      + 'coming in.').length - 1).toBe(1);
    expect(treeText(notice)).toContain('It is the endpoint we_standing at the connection stripe-other.');
    // D-201 Slice 10AT — the webhook's own endpoint is its own line in the
    // notice, said because a stray stands at its account (the given-up one);
    // one at another account alone says nothing (ownEndpointText).
    const ownLine = (notice.children ?? []).filter((child) => treeText(child).startsWith("This webhook's own endpoint"));
    expect(ownLine).toHaveLength(1);
    // A server before 10AQ counts them only: said, unnamed.
    expect(treeText(findByAttrValue(root, WEBHOOKS_PANEL_STRAYS_ATTR, givenUpOnly.ingress_id)!))
      .not.toContain('It is the endpoint');
    // Messages refused, tied to them.
    expect(treeText(root)).toContain('Some may come from the earlier setups of this webhook still at the other service, '
      + 'which sign with a secret this webhook does not hold: removing them there stops those.');
    // One given up needs the owner: the webhook is among those needing attention.
    const status = findByAttrValue(root, 'data-webhook-filter', 'status')!;
    status.value = 'attention';
    fire(status, 'change', {});
    await tick();
    expect(findByAttrValue(root, WEBHOOKS_PANEL_CARD_ATTR, givenUpOnly.ingress_id)).not.toBeNull();
    expect(findByAttrValue(root, WEBHOOKS_PANEL_CARD_ATTR, quiet.ingress_id)).toBeNull();
    route.dispose();
  });

  // D-201 Slice 10BA (10AY finding 4) — one the search could not prove is this
  // webhook's is never removed: the card said Recued kept trying to remove it,
  // then that it stopped after a week of failed tries.
  it('D-201 Slice 10BA — an endpoint Recued cannot prove is said apart: never removed, for the owner to check', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const base = readyWebhook();
    const healthy = { ...base.health, status: 'healthy' as const };
    const strayed: WebhookIngressView = {
      ...base,
      display_name: 'Strayed',
      registration_mode: 'managed_endpoint',
      paired_connection_id: 'stripe-test',
      remote_endpoint_id: 'we_live',
      intake_state: 'enabled',
      stray_endpoints: 2,
      stray_endpoints_given_up: 1,
      strays: [
        { remote_endpoint_id: 'we_tried', connection_id: 'stripe-test', given_up: false },
        { remote_endpoint_id: 'we_edited', connection_id: 'stripe-test', given_up: false, unproven: true },
        { remote_endpoint_id: 'we_edited_long_ago', connection_id: 'stripe-test', given_up: true, unproven: true },
      ],
      health: healthy,
    };
    const route = bootstrapConnectionsRoute(
      webhookRouteCallers(root, doc, [strayed], TEST_WEBHOOK_PROFILE_CAPABILITIES),
    );
    await route.webhooksPanel()!.refresh();
    const text = treeText(findByAttrValue(root, WEBHOOKS_PANEL_STRAYS_ATTR, strayed.ingress_id)!);
    expect(text).toContain('An earlier setup of this webhook is still at the other service, and Recued keeps trying to '
      + 'remove it.');
    expect(text).toContain("An endpoint at the other service sends to this webhook's address, but Recued cannot prove "
      + 'it is an earlier setup of this webhook (it was changed there), so it does not remove it. Check it there, and '
      + 'remove it yourself if it is. After a week Recued stops looking and says so here.');
    expect(text).toContain("Recued stopped looking at an endpoint at the other service that sends to this webhook's "
      + "address after a week: it could not prove it is this webhook's, so it never removed it. Remove it there "
      + 'yourself if it is, then say so here.');
    // None of them said to have failed tries, nor every one to be tried.
    expect(text).not.toContain('after a week of failed tries');
    expect(text).not.toContain('2 earlier setups of this webhook are still at the other service');
    route.dispose();
  });

  // D-201 Slice 10BQ (10BM finding 13) — one the search found sending to another
  // address was said to send to this webhook's, and counted among what may be
  // refused here.
  it('D-201 Slice 10BQ — a stray found sending elsewhere is said as that, and left out of the refusals', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const base = readyWebhook();
    const strayed: WebhookIngressView = {
      ...base,
      display_name: 'Strayed',
      registration_mode: 'managed_endpoint',
      paired_connection_id: 'stripe-test',
      remote_endpoint_id: 'we_live',
      intake_state: 'enabled',
      stray_endpoints: 2,
      stray_endpoints_given_up: 1,
      strays: [
        { remote_endpoint_id: 'we_here', connection_id: 'stripe-test', given_up: false, unproven: true },
        { remote_endpoint_id: 'we_moved', connection_id: 'stripe-test', given_up: false, unproven: true, elsewhere: true },
        { remote_endpoint_id: 'we_moved_long_ago', connection_id: 'stripe-test', given_up: true, unproven: true, elsewhere: true },
      ],
      health: { ...base.health, status: 'degraded', refusing: { refused: 4, since: 1000 } },
    };
    const route = bootstrapConnectionsRoute(
      webhookRouteCallers(root, doc, [strayed], TEST_WEBHOOK_PROFILE_CAPABILITIES),
    );
    await route.webhooksPanel()!.refresh();
    const text = treeText(findByAttrValue(root, WEBHOOKS_PANEL_STRAYS_ATTR, strayed.ingress_id)!);
    expect(text).toContain("An endpoint at the other service sends to this webhook's address, but Recued cannot prove "
      + 'it is an earlier setup of this webhook (it was changed there), so it does not remove it. Check it there, and '
      + 'remove it yourself if it is. After a week Recued stops looking and says so here. It is the endpoint we_here '
      + 'at the connection stripe-test.');
    expect(text).toContain('An endpoint at the other service is labelled as an earlier setup of this webhook but sends '
      + 'to another address, so Recued cannot prove it is one (it was changed there) and does not remove it. Check it '
      + 'there, and remove it yourself if it is. After a week Recued stops looking and says so here. It is the endpoint '
      + 'we_moved at the connection stripe-test.');
    expect(text).toContain('Recued stopped looking at an endpoint at the other service after a week: labelled as an '
      + 'earlier setup of this webhook, it sends to another address, so Recued could not prove it is this '
      + "webhook's and never removed it. Remove it there yourself if it is, then say so here. It is the endpoint "
      + 'we_moved_long_ago at the connection stripe-test.');
    // Only the one at this webhook's address may send what is refused here.
    expect(treeText(root)).toContain('Some may come from the earlier setup of this webhook still at the other service, '
      + 'which signs with a secret this webhook does not hold: removing it there stops those.');
    // D-201 Slice 10BT (10BS finding 1) — but each of the three refuses setting
    // it up again, so the advice counts them all: 10BQ counted one.
    expect(treeText(root)).toContain('remove the earlier setups there first, then switch this webhook off and on '
      + '(beside them, setting it up again can be refused and leave it off)');
    // None of the three is one Recued tries to remove (the 10BS review: an extra
    // such sentence passed this case).
    expect(text).not.toContain('Recued keeps trying to remove');
    expect(text).not.toContain('Recued stopped trying to remove');
    route.dispose();
  });

  // D-201 Slice 10BT (10BS finding 1) — the review's case: beside only a stray
  // found sending elsewhere, the card said to switch the webhook off and on,
  // which a stray labelled as this webhook's refuses, leaving it off.
  it('D-201 Slice 10BT — beside a stray found sending elsewhere, the advice says to remove it first', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const base = readyWebhook();
    const strayed: WebhookIngressView = {
      ...base,
      display_name: 'Strayed',
      registration_mode: 'managed_endpoint',
      paired_connection_id: 'stripe-test',
      remote_endpoint_id: 'we_live',
      intake_state: 'enabled',
      stray_endpoints: 1,
      stray_endpoints_given_up: 0,
      strays: [
        { remote_endpoint_id: 'we_moved', connection_id: 'stripe-test', given_up: false, unproven: true, elsewhere: true },
      ],
      health: { ...base.health, status: 'degraded', refusing: { refused: 4, since: 1000 } },
    };
    const route = bootstrapConnectionsRoute(
      webhookRouteCallers(root, doc, [strayed], TEST_WEBHOOK_PROFILE_CAPABILITIES),
    );
    await route.webhooksPanel()!.refresh();
    const text = treeText(root);
    // It sends nothing refused here...
    expect(text).not.toContain('Some may come from');
    // ...but setting the webhook up again beside it can be refused.
    expect(text).toContain('If the other service shows the messages it sends here failing, remove the earlier setup '
      + 'there first, then switch this webhook off and on (beside it, setting it up again can be refused and leave it '
      + 'off): Recued sets it up there again, with a new secret.');
    route.dispose();
  });

  // D-201 Slice 10BY (10BX finding 4) — one Recued stopped looking at refuses
  // setting the webhook up again as much, and is counted: no case pinned it,
  // and without it the card advised the plain switch off and on again.
  it('D-201 Slice 10BY — beside a stray given up on, found sending elsewhere, the advice says to remove it first', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const base = readyWebhook();
    const strayed: WebhookIngressView = {
      ...base,
      display_name: 'Strayed',
      registration_mode: 'managed_endpoint',
      paired_connection_id: 'stripe-test',
      remote_endpoint_id: 'we_live',
      intake_state: 'enabled',
      stray_endpoints: 0,
      stray_endpoints_given_up: 1,
      strays: [
        { remote_endpoint_id: 'we_moved', connection_id: 'stripe-test', given_up: true, unproven: true, elsewhere: true },
      ],
      health: { ...base.health, status: 'degraded', refusing: { refused: 4, since: 1000 } },
    };
    const route = bootstrapConnectionsRoute(
      webhookRouteCallers(root, doc, [strayed], TEST_WEBHOOK_PROFILE_CAPABILITIES),
    );
    await route.webhooksPanel()!.refresh();
    const text = treeText(root);
    expect(text).not.toContain('Some may come from');
    expect(text).toContain('If the other service shows the messages it sends here failing, remove the earlier setup '
      + 'there first, then switch this webhook off and on (beside it, setting it up again can be refused and leave it '
      + 'off): Recued sets it up there again, with a new secret.');
    route.dispose();
  });

  // D-201 Slice 10BK (10BF finding 14) — the proven and the unproven were named
  // in one list after both sentences.
  it('D-201 Slice 10BK — each stray is named beside the sentence about it', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const base = readyWebhook();
    const strayed: WebhookIngressView = {
      ...base,
      display_name: 'Strayed',
      registration_mode: 'managed_endpoint',
      paired_connection_id: 'stripe-test',
      remote_endpoint_id: 'we_live',
      intake_state: 'enabled',
      stray_endpoints: 2,
      stray_endpoints_given_up: 2,
      strays: [
        { remote_endpoint_id: 'we_tried', connection_id: 'stripe-test', given_up: false },
        { remote_endpoint_id: 'we_edited', connection_id: 'stripe-test', given_up: false, unproven: true },
        { remote_endpoint_id: 'we_tried_long_ago', connection_id: 'stripe-test', given_up: true },
        { remote_endpoint_id: 'we_edited_long_ago', connection_id: 'stripe-test', given_up: true, unproven: true },
      ],
      health: { ...base.health, status: 'healthy' as const },
    };
    const route = bootstrapConnectionsRoute(
      webhookRouteCallers(root, doc, [strayed], TEST_WEBHOOK_PROFILE_CAPABILITIES),
    );
    await route.webhooksPanel()!.refresh();
    const text = treeText(findByAttrValue(root, WEBHOOKS_PANEL_STRAYS_ATTR, strayed.ingress_id)!);
    expect(text).toContain('Recued keeps trying to remove it. If it cannot be removed for a week, Recued stops and says so '
      + 'here. It is the endpoint we_tried at the connection stripe-test.');
    expect(text).toContain('After a week Recued stops looking and says so here. It is the endpoint we_edited at the '
      + 'connection stripe-test.');
    expect(text).toContain('Remove it there yourself, then say so here. It is the endpoint we_tried_long_ago at the '
      + 'connection stripe-test.');
    expect(text).toContain('Remove it there yourself if it is, then say so here. It is the endpoint we_edited_long_ago '
      + 'at the connection stripe-test.');
    expect(text).not.toContain('They are the endpoint');
    route.dispose();
  });

  // D-201 Slice 10BL (10BF finding 17) — 10BE made the server's reason end its
  // sentence before the advice; no case pinned it where the door is missing.
  it("D-201 Slice 10BL — a missing door's reason ends its sentence before the advice, whatever its code", () => {
    const missing = {
      recipe_id: 'refund-hold', armed: true, door: 'missing', door_reason: 'it reads Records',
    } as unknown as WebhookIngressRecipeView;
    expect(recipeDoorText({ ...missing, door_reason_code: 'refused' }))
      .toBe('It cannot have a door as it stands: it reads Records. Change the recipe, then open its door.');
    expect(recipeDoorText({ ...missing, door_reason_code: 'fault', door_reason: 'the records store is busy' }))
      .toBe('Recued could not make its door: the records store is busy. Open it to try again.');
    expect(recipeDoorText({ ...missing, door_reason_code: 'no_account', door_reason: "step 'deal' names no account" }))
      .toBe("It has no door yet: step 'deal' names no account. Choose its account in its settings, then open its door.");
    // One that ends its own sentence keeps the stop it has.
    expect(recipeDoorText({ ...missing, door_reason_code: 'refused', door_reason: 'it reads Records!' }))
      .toBe('It cannot have a door as it stands: it reads Records! Change the recipe, then open its door.');
  });

  it("D-201 Slice 10BK — a swap left pending is tried again as a swap, as the card's button says", () => {
    const strays = [{ remote_endpoint_id: 'we_standing', connection_id: 'stripe-test', given_up: false }];
    const own = {
      remote_endpoint_id: 'we_live', paired_connection_id: 'stripe-test', registration_state: 'cleanup_pending' as const,
    };
    // Before 10BK: "Try the clean-up again", beside "Try the swap again".
    expect(ownEndpointText({ ...own, intake_state: 'disabled', pending_paired_connection_id: 'stripe-other' }, strays))
      .toBe("This webhook's own endpoint there is we_live: its clean-up did not finish, so it may still be there. "
        + 'Try the swap again here, or remove it there yourself.');
    // Retired, its button is the clean-up's.
    expect(ownEndpointText({ ...own, intake_state: 'retired', pending_paired_connection_id: 'stripe-other' }, strays))
      .toBe("This webhook's own endpoint there is we_live: its clean-up did not finish, so it may still be there. "
        + 'Try the clean-up again here, or remove it there yourself.');
  });

  // D-201 Slice 10AQ (10AM finding 6) — a retired webhook, listed while a stray
  // of its stands: its card says so and takes "I removed it", nothing more.
  // D-201 Slice 10AT (10AS finding 21) — named for what it checks: a retired
  // card also shows its message viewers, "Clear out what can go", and "Try the
  // clean-up again" while its clean-up is pending.
  it('D-201 Slice 10AQ — a retired webhook listed for a stray of its offers "I removed it", never a retire again or a test message', async () => {
    const base = readyWebhook();
    const live: WebhookIngressView = {
      ...base,
      environment: 'test',
      intake_state: 'disabled',
      readiness: { ...base.readiness, test_delivery_supported: true },
      stray_endpoints_given_up: 1,
      strays: [{ remote_endpoint_id: 'we_left_behind', connection_id: 'stripe-test', given_up: true }],
    };
    const retired: WebhookIngressView = {
      ...live,
      registration_state: 'retired',
      intake_state: 'retired',
      readiness: { ...live.readiness, can_enable: false },
    };
    for (const ingress of [live, retired]) {
      const doc = makeFakeDocument();
      const root = doc.createElement('div');
      const route = bootstrapConnectionsRoute({
        ...webhookRouteCallers(root, doc, [ingress], TEST_WEBHOOK_PROFILE_CAPABILITIES),
        webhooksStraysDismissCaller: vi.fn(async () => ({ ingress })),
        webhooksRetireCaller: vi.fn(async () => ({ ingress })),
        webhooksTestDeliveryCaller: vi.fn(async () => { throw new Error('not called'); }),
      });
      await route.webhooksPanel()!.refresh();
      const card = findByAttrValue(root, WEBHOOKS_PANEL_CARD_ATTR, ingress.ingress_id)!;
      const state = ingress.intake_state;
      expect(treeText(card), state).toContain('It is the endpoint we_left_behind at the connection stripe-test.');
      expect(findByAttrValue(card, WEBHOOKS_PANEL_ACTION_ATTR, 'strays-dismiss'), state).not.toBeNull();
      // A webhook not retired offers both, so their absence below is the guard's.
      for (const action of ['retire', 'test-delivery']) {
        const found = findByAttrValue(card, WEBHOOKS_PANEL_ACTION_ATTR, action);
        if (state === 'retired') expect(found, `${state} ${action}`).toBeNull();
        else expect(found, `${state} ${action}`).not.toBeNull();
      }
      if (state === 'retired') {
        for (const action of ['enable', 'disable', 'connection-rebind']) {
          expect(findByAttrValue(card, WEBHOOKS_PANEL_ACTION_ATTR, action), action).toBeNull();
        }
      }
      route.dispose();
    }
  });

  // D-201 Slice 10AU (10AS finding 28) — "check that the secret there is the
  // one this webhook holds" could not be done where neither end shows it
  // again, Basic auth checks a username too, and a webhook a recipe gives its
  // address to was said to be one Recued does not set up there.
  it('D-201 Slice 10AU — what the owner can do about a secret Recued does not set, by who makes it', () => {
    const when = (at: number) => `T${at}`;
    const swap = '“Swap the keys”';
    const advice = (profileId: string, mode: WebhookIngressView['registration_mode'] = 'manual') =>
      refusingText({ refused: 3, since: 1000 }, mode, when, 0, profileId);
    // A secret Recued makes: shown once, and the other service may never show it.
    for (const [profileId, label] of [
      ['telegram.bot-webhook.v1', 'Webhook secret token'],
      ['github.webhook.v1', 'Webhook secret'],
    ] as const) {
      expect(advice(profileId)).toContain('If the other service shows the messages it sends here failing, make a new '
        + `“${label}” here with ${swap} and put it into the other service: Recued shows one it makes only once, and `
        + 'the other service may never show it back. If it shows none failing, nothing needs doing.');
    }
    // One the service makes: it shows it.
    expect(advice('stripe.event.v1')).toContain('failing, check that this webhook holds the “Endpoint signing secret” '
      + `the other service shows for it, and if not, enter that one here with ${swap}.`);
    // The owner's own.
    expect(advice('lemonsqueezy.webhook.v1')).toContain('failing, check that the “Signing secret” there is the one you '
      + `gave this webhook; if the other service does not show it, enter a new one there and here, with ${swap}.`);
    // Basic auth: a username too.
    expect(advice('generic.http-basic.v1')).toContain('failing, check that the “Username” and “Password” there are the '
      + `ones you gave this webhook; if the other service does not show them, enter new ones there and here, with ${swap}.`);
    // A token a recipe's operation does not give: the address it does.
    const bound = advice('generic.static-header-token.v1', 'operation_bound');
    expect(bound).toContain('has the address. The recipe that uses this webhook gives the other service its address, '
      + 'but not its “Header token”. If the other service shows the messages it sends here failing, check that the '
      + `“Header token” there is the one you gave this webhook; if the other service does not show it, enter a new one `
      + `there and here, with ${swap}.`);
    expect(advice('generic.static-header-token.v1')).not.toContain('The recipe that uses this webhook');
    for (const text of [bound, advice('telegram.bot-webhook.v1'), advice('generic.http-basic.v1'), advice('nope')]) {
      expect(text).not.toContain('Recued does not set it up there');
      expect(text).not.toContain('check that the secret there is the one this webhook holds');
    }
    expect(ownerSecretAdvice('generic.http-basic.v1').noun).toBe('“Username” and “Password”');
    expect(ownerSecretAdvice(undefined).noun).toBe('secret');
  });

  it('D-201 Slice 10AU — the card says it by its profile, and every last error in words, never the code', async () => {
    const base = readyWebhook();
    // The card gives the refusal text its profile.
    {
      const doc = makeFakeDocument();
      const root = doc.createElement('div');
      const ingress: WebhookIngressView = {
        ...base,
        profile_id: 'generic.http-basic.v1',
        intake_state: 'enabled',
        health: { ...base.health, status: 'degraded', refusing: { refused: 3, since: 1000 } },
      };
      const route = bootstrapConnectionsRoute(webhookRouteCallers(root, doc, [ingress], TEST_WEBHOOK_PROFILE_CAPABILITIES));
      await route.webhooksPanel()!.refresh();
      expect(treeText(root)).toContain('check that the “Username” and “Password” there are the ones you gave this webhook');
      route.dispose();
    }
    for (const [code, words] of [
      ['managed_registration_drift', 'The setup at the other service may not match this webhook.'],
      // D-201 Slice 10BG (10BF finding 13).
      ['managed_registration_certificate_unheld', 'Its setup at the other service uses a certificate set there, which '
        + 'Recued does not hold, so Recued did not set it again: setting it would remove that certificate.'],
      ['managed_remote_missing', 'What Recued set up at the other service is no longer there.'],
      ['managed_registration_unconfirmed', 'Recued could not confirm that what it set up at the other service is there.'],
      // D-201 Slice 10BT (10BS finding 1) — not "at this address": a setup found
      // sending elsewhere refuses it too.
      ['managed_registration_ambiguous', 'The other service has a setup that Recued cannot tell apart from another, '
        + "or prove is this webhook's, so it changed nothing there."],
      ['managed_cleanup_unconfirmed', 'Recued could not confirm that it removed this webhook from the other service.'],
      ['managed_cleanup_ambiguous', 'The other service has setups at this address that Recued cannot tell apart, so it '
        + 'removed none.'],
      ['paired_connection_deleted', 'The connection this webhook was set up through was deleted.'],
      ['unsupported_delivery', 'A message came in a form this webhook does not take, and was refused.'],
      ['profile_dependency_unavailable', 'Recued could not check a message, as something it needs for that was '
        + 'unavailable, and told the other service to try it again later.'],
      ['profile_internal_error', 'Recued failed while checking a message, and told the other service to try it again later.'],
      // A code a newer server sends.
      ['managed_something_new', 'Something went wrong that this page has no words for.'],
    ] as const) {
      const doc = makeFakeDocument();
      const root = doc.createElement('div');
      const ingress: WebhookIngressView = {
        ...base,
        intake_state: 'degraded',
        health: { ...base.health, status: 'degraded', last_error_code: code },
      };
      const route = bootstrapConnectionsRoute(webhookRouteCallers(root, doc, [ingress], TEST_WEBHOOK_PROFILE_CAPABILITIES));
      await route.webhooksPanel()!.refresh();
      expect(treeText(root)).toContain(`Last thing that went wrong ${words}`);
      expect(treeText(root)).not.toContain(code);
      route.dispose();
    }
  });

  // D-201 Slice 10AT (10AS finding 2) — switching off and on beside standing
  // strays can leave a webhook off: the next setup meets them and is refused.
  it('D-201 Slice 10AT — beside earlier setups, the advice removes them first, never a bare switch off and on', () => {
    const when = (at: number) => `T${at}`;
    const managedOne = refusingText({ refused: 3, since: 1000 }, 'managed_endpoint', when, 1);
    expect(managedOne).toContain('If the other service shows the messages it sends here failing, remove the earlier setup '
      + 'there first, then switch this webhook off and on (beside it, setting it up again can be refused and leave it off): '
      + 'Recued sets it up there again, with a new secret.');
    const setAgainTwo = refusingText({ refused: 3, since: 1000, set_again: true, set_again_at: 5000 }, 'managed_endpoint', when, 2);
    expect(setAgainTwo).toContain('something else may be setting it there: remove the earlier setups there first, then '
      + 'switch this webhook off and on (beside them, setting it up again can be refused and leave it off).');
    for (const text of [managedOne, setAgainTwo]) expect(text).not.toMatch(/(failing|there): switch this webhook off and on/);
    // With none standing, as before.
    expect(refusingText({ refused: 3, since: 1000 }, 'managed_endpoint', when))
      .toContain('failing, switch this webhook off and on: Recued sets it up there again');
    // D-201 Slice 10BG (10BF finding 13) — a set again refused over a
    // certificate set at the service: switching it off and on, the advice for
    // any other failure, removes that certificate, and is said for what it is.
    const failed = { refused: 3, since: 1000, set_again: true as const, set_again_failed_at: 2000 };
    const certificate = refusingText(failed, 'managed_endpoint', when, 0, 'telegram.bot-webhook.v1',
      'managed_registration_certificate_unheld');
    expect(certificate).toContain('Recued did not set this webhook again at the other service, at T2000: its setup '
      + 'there uses a certificate set there, which Recued does not hold, and setting it again would remove it. To keep '
      + 'that certificate, set a webhook up there yourself instead; switching this one off and on sets it up again '
      + 'without the certificate.');
    expect(certificate).not.toContain('check that the connection');
    expect(refusingText(failed, 'managed_endpoint', when, 0, 'telegram.bot-webhook.v1', 'managed_registration_drift'))
      .toContain('check that the connection this webhook uses can still change webhooks at the other service');
  });

  it('D-201 Slice 10BG — the card reads a set again refused over a certificate from the webhook it shows', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const base = readyWebhook();
    const ingress: WebhookIngressView = {
      ...base,
      profile_id: 'telegram.bot-webhook.v1',
      registration_mode: 'managed_endpoint',
      intake_state: 'enabled',
      health: {
        ...base.health,
        status: 'degraded',
        last_error_code: 'managed_registration_certificate_unheld',
        refusing: { refused: 3, since: 1000, set_again: true, set_again_failed_at: 2000 },
      },
    };
    const route = bootstrapConnectionsRoute(webhookRouteCallers(root, doc, [ingress], TEST_WEBHOOK_PROFILE_CAPABILITIES));
    await route.webhooksPanel()!.refresh();
    const text = treeText(root);
    expect(text).toContain('Recued did not set this webhook again at the other service');
    expect(text).toContain('switching this one off and on sets it up again without the certificate.');
    expect(text).not.toContain('check that the connection this webhook uses can still change webhooks');
    route.dispose();
  });

  // D-201 Slice 10AT (10AS finding 22) — "removing that one stops messages coming
  // in" when none were, and said in each block it could appear twice.
  it("D-201 Slice 10AT — the webhook's own endpoint is said once, as its state has it", async () => {
    const strays = [
      { remote_endpoint_id: 'we_given_up', connection_id: 'stripe-test', given_up: true },
      { remote_endpoint_id: 'we_standing', connection_id: 'stripe-test', given_up: false },
    ];
    const own = { remote_endpoint_id: 'we_live', paired_connection_id: 'stripe-test' };
    expect(ownEndpointText({ ...own, intake_state: 'enabled', registration_state: 'registered' }, strays))
      .toBe("This webhook's own endpoint there is we_live: removing that one stops messages coming in.");
    expect(ownEndpointText({ ...own, intake_state: 'degraded', registration_state: 'drifted' }, strays))
      .toBe("This webhook's own endpoint there is we_live: removing that one stops messages coming in.");
    // D-201 Slice 10BA (10AY finding 5) — nothing retries a clean-up by
    // itself: it said "Recued is removing it" beside the button that tries it.
    for (const intake of ['retired', 'disabled'] as const) {
      expect(ownEndpointText({ ...own, intake_state: intake, registration_state: 'cleanup_pending' }, strays), intake)
        .toBe("This webhook's own endpoint there is we_live: its clean-up did not finish, so it may still be there. "
          + 'Try the clean-up again here, or remove it there yourself.');
    }
    expect(ownEndpointText({ ...own, intake_state: 'disabled', registration_state: 'registered' }, strays))
      .toBe("This webhook's own endpoint there is we_live.");
    // A stray at another account, or nothing committed: nothing to say.
    expect(ownEndpointText({ ...own, intake_state: 'enabled', registration_state: 'registered' },
      strays.map((stray) => ({ ...stray, connection_id: 'stripe-other' })))).toBeNull();
    expect(ownEndpointText({ ...own, remote_endpoint_id: null, intake_state: 'enabled', registration_state: 'registered' }, strays))
      .toBeNull();
    // Strays in both blocks, at the webhook's own account: said once.
    const base = readyWebhook();
    const ingress: WebhookIngressView = {
      ...base,
      registration_mode: 'managed_endpoint',
      paired_connection_id: 'stripe-test',
      remote_endpoint_id: 'we_live',
      intake_state: 'enabled',
      stray_endpoints: 1,
      stray_endpoints_given_up: 1,
      strays,
    };
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const route = bootstrapConnectionsRoute(webhookRouteCallers(root, doc, [ingress], TEST_WEBHOOK_PROFILE_CAPABILITIES));
    await route.webhooksPanel()!.refresh();
    const notice = findByAttrValue(root, WEBHOOKS_PANEL_STRAYS_ATTR, ingress.ingress_id)!;
    expect(treeText(notice).split("This webhook's own endpoint there is we_live").length - 1).toBe(1);
    route.dispose();
  });

  // D-201 Slice 10AT (10AS finding 1) — listed again, its only retry offered.
  it('D-201 Slice 10AT — a retired webhook whose clean-up is pending offers "Try the clean-up again"', async () => {
    const base = readyWebhook();
    const pending: WebhookIngressView = {
      ...base,
      registration_mode: 'managed_endpoint',
      remote_endpoint_id: 'we_committed',
      registration_state: 'cleanup_pending',
      intake_state: 'retired',
      readiness: { ...base.readiness, can_enable: false },
    };
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const retire = vi.fn(async () => ({ ingress: pending }));
    const route = bootstrapConnectionsRoute({
      ...webhookRouteCallers(root, doc, [pending], TEST_WEBHOOK_PROFILE_CAPABILITIES),
      webhooksRetireCaller: retire,
    });
    await route.webhooksPanel()!.refresh();
    const card = findByAttrValue(root, WEBHOOKS_PANEL_CARD_ATTR, pending.ingress_id)!;
    const retry = findByAttrValue(card, WEBHOOKS_PANEL_ACTION_ATTR, 'cleanup-retry')!;
    expect(retry).not.toBeNull();
    expect(treeText(retry)).toBe('Try the clean-up again');
    expect(retry.disabled).toBe(false);
    fire(retry, 'click', {});
    await tick();
    expect(retire).toHaveBeenCalledWith({ ingress_id: pending.ingress_id });
    route.dispose();
  });

  it('D-201 Slice 10AL — the app wires webhook.ingress.strays.dismiss into the card', () => {
    const source = readFileSync(join(__dirname, '..', 'webclient-bootstrap.ts'), 'utf8');
    expect(source).toContain("(args) => rpcConn.call('webhook.ingress.strays.dismiss', args)");
    // D-201 Slice 10AQ (10AM finding 26) — fenced, as the card's other actions are.
    expect(source).toContain('? { webhooksStraysDismissCaller: switchWorkTracker.track(webhooksStraysDismissCaller) }');
    const route = readFileSync(join(__dirname, '..', 'connections', 'bootstrap-connections-route.ts'), 'utf8');
    expect(route).toContain('? { runStraysDismiss: opts.webhooksStraysDismissCaller }');
  });

  // D-201 Slice 10AJ (10AI finding 5) — the app's own wiring of the per-recipe
  // switch: without it the card offers none, silently, and every test of the
  // route passes its caller by hand.
  it('D-201 Slice 10AJ — the app wires webhook.ingress.door.set into the card', () => {
    const source = readFileSync(join(__dirname, '..', 'webclient-bootstrap.ts'), 'utf8');
    expect(source).toContain("(args) => rpcConn.call('webhook.ingress.door.set', args)");
    expect(source).toContain('? { webhooksDoorSetCaller: switchWorkTracker.track(webhooksDoorSetCaller) }');
  });

  it('D-201 Slice 10AF — starting one recipe, the master switch is its only switch', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const ingress: WebhookIngressView = {
      ...readyWebhook(),
      intake_state: 'enabled',
      recipe_door_switch: true,
      recipes: [{ recipe_id: 'refund-notice', name: 'Refund notice', consumer_kind: 'local_recipe', armed: true, door: 'missing' }],
    };
    const runEnable = vi.fn(async () => ({ ingress }));
    const runDoorSet = vi.fn(async () => ({ ingress }));
    const route = bootstrapConnectionsRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      initialTab: 'webhooks',
      webhooksListCaller: vi.fn(async () => webhookList([ingress])),
      webhooksCreateCaller: vi.fn(async () => ({ ingress })),
      webhooksCredentialWriteCaller: vi.fn(async () => ({ ingress, credential_version: ingress.active_credential_versions[0]! })),
      webhooksCredentialRetireCaller: vi.fn(async () => ({ ingress })),
      webhooksManualConfirmCaller: vi.fn(async () => ({ ingress })),
      webhooksEnableCaller: runEnable,
      webhooksDisableCaller: vi.fn(async () => ({ ingress })),
      webhooksDoorSetCaller: runDoorSet,
    });
    await route.webhooksPanel()!.refresh();
    const recipe = findByAttrValue(
      findByAttrValue(root, WEBHOOKS_PANEL_RECIPES_ATTR, ingress.ingress_id)!,
      WEBHOOKS_PANEL_RECIPE_ATTR,
      'refund-notice',
    )!;
    expect(findByAttrValue(recipe, WEBHOOKS_PANEL_ACTION_ATTR, 'door-close')).toBeNull();
    // A door Recued could not make opens with the webhook's own switch.
    findByAttrValue(recipe, WEBHOOKS_PANEL_ACTION_ATTR, 'door-open')!.click();
    await tick();
    expect(runEnable).toHaveBeenCalledWith({ ingress_id: ingress.ingress_id });
    expect(runDoorSet).not.toHaveBeenCalled();
    route.dispose();
  });

  it('D-201 Slice 10X — a server before 10X lists no recipes: no section, and a door-less dead letter says to update rather than point to one', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const ingress: WebhookIngressView = { ...readyWebhook(), intake_state: 'enabled', dead_letters_unresolved: 1 };
    const route = bootstrapConnectionsRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      initialTab: 'webhooks',
      webhooksListCaller: vi.fn(async () => webhookList([ingress])),
      webhooksCreateCaller: vi.fn(async () => ({ ingress })),
      webhooksCredentialWriteCaller: vi.fn(async () => ({ ingress, credential_version: ingress.active_credential_versions[0]! })),
      webhooksCredentialRetireCaller: vi.fn(async () => ({ ingress })),
      webhooksManualConfirmCaller: vi.fn(async () => ({ ingress })),
      webhooksEnableCaller: vi.fn(async () => ({ ingress })),
      webhooksDisableCaller: vi.fn(async () => ({ ingress })),
      webhooksDeadLetterListCaller: vi.fn(async (): Promise<WebhookDeadLetterListResponse> => ({
        dead_letters: [{
          kind: 'target',
          dead_letter_id: `whx_${'0'.repeat(32)}`,
          ingress_id: ingress.ingress_id,
          delivery_id: `whd_${'0'.repeat(32)}`,
          event_id: `whe_${'0'.repeat(32)}`,
          provider_event_type: 'delivery',
          received_at: 2_100_000_000_000,
          recipe_id: 'track-parcels',
          attempt_count: 1,
          last_error_code: 'door_closed',
          dead_lettered_at: 2_100_000_001_000,
          payload_retained: true,
        }],
        next_cursor: null,
        review: { unresolved: 1, limit: 1_000 },
      })),
      webhooksDeadLetterRequeueCaller: vi.fn(async () => { throw new Error('not called'); }),
      webhooksDeadLetterResolveCaller: vi.fn(async () => { throw new Error('not called'); }),
    });
    await route.webhooksPanel()!.refresh();
    expect(findByAttrValue(root, WEBHOOKS_PANEL_RECIPES_ATTR, ingress.ingress_id)).toBeNull();
    findByAttrValue(root, WEBHOOKS_PANEL_ACTION_ATTR, 'dead-letters')!.click();
    await tick();
    expect(treeText(root)).toContain(
      "Last problem Its recipe never ran it: the door behind the recipe's webhook is closed. Update Recued on your server to open it from here.",
    );
    expect(treeText(root)).not.toContain('Recipes it starts');
    route.dispose();
  });

  it("D-201 Slice 10W — an approved run a restart stopped says which step is in doubt, and what trying it again does", async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const ingress: WebhookIngressView = { ...readyWebhook(), intake_state: 'enabled', dead_letters_unresolved: 5 };
    const item = (index: number, code: string, held?: WebhookDeadLetterView['step_in_doubt']): WebhookDeadLetterView => ({
      kind: 'target',
      dead_letter_id: `whx_${String(index).padStart(32, '0')}`,
      ingress_id: ingress.ingress_id,
      delivery_id: `whd_${String(index).padStart(32, '0')}`,
      event_id: `whe_${String(index).padStart(32, '0')}`,
      provider_event_type: 'delivery',
      received_at: 2_100_000_000_000 + index,
      recipe_id: 'refund-revoke',
      attempt_count: 1,
      last_error_code: code,
      dead_lettered_at: 2_100_000_001_000 + index,
      payload_retained: true,
      ...(held !== undefined ? { step_in_doubt: held } : {}),
    });
    const route = bootstrapConnectionsRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      initialTab: 'webhooks',
      webhooksListCaller: vi.fn(async () => webhookList([ingress])),
      webhooksCreateCaller: vi.fn(async () => ({ ingress })),
      webhooksCredentialWriteCaller: vi.fn(async () => ({ ingress, credential_version: ingress.active_credential_versions[0]! })),
      webhooksCredentialRetireCaller: vi.fn(async () => ({ ingress })),
      webhooksManualConfirmCaller: vi.fn(async () => ({ ingress })),
      webhooksEnableCaller: vi.fn(async () => ({ ingress })),
      webhooksDisableCaller: vi.fn(async () => ({ ingress })),
      webhooksDeadLetterListCaller: vi.fn(async (): Promise<WebhookDeadLetterListResponse> => ({
        dead_letters: [
          item(0, 'approved_run_in_doubt', { step_id: 'tell_owner_two' }),
          item(1, 'approved_run_in_doubt', { step_id: 'close_on_refund', asks_again: true }),
          item(2, 'approved_run_in_doubt', { step_id: 'close_on_refund', asks_again: true, progress_unknown: true }),
          item(3, 'approved_run_in_doubt'),
          item(4, 'restart_interrupted'),
        ],
        next_cursor: null,
        review: { unresolved: 5, limit: 1_000 },
      })),
      webhooksDeadLetterRequeueCaller: vi.fn(async () => { throw new Error('not called'); }),
      webhooksDeadLetterResolveCaller: vi.fn(async () => { throw new Error('not called'); }),
    });
    await route.webhooksPanel()!.refresh();
    findByAttrValue(root, WEBHOOKS_PANEL_ACTION_ATTR, 'dead-letters')!.click();
    await tick();
    const text = treeText(root);
    // Before 10W the code showed as it is: `approved_run_in_doubt`.
    expect(text).not.toContain('approved_run_in_doubt');
    expect(text).not.toContain('restart_interrupted');
    // D-201 Slice 10AV (10AS finding 15) — no restart claimed: a hold the answer
    // could not write, and a step's own unconfirmed outcome, read so too.
    expect(text).toContain("Recued cannot tell whether 'tell_owner_two' went through (Logs say why). Check before "
      + "trying it again: trying it again goes on from 'tell_owner_two', with what ran before it kept, so only that "
      + 'step can run twice.');
    expect(text).not.toContain("The server restarted while 'tell_owner_two' was running");
    expect(text).toContain('Recued cannot tell whether a step of its approved run that sends something went through '
      + '(Logs say which, and why). Check before trying it again: trying it again runs the recipe from its first step.');
    expect(text).toContain("trying it again asks you for 'close_on_refund' again and goes on from it, with what ran "
      + 'before it kept, so only that step can run twice.');
    expect(text).toContain('The server stopped without warning during its approved run, so Recued cannot tell how far '
      + "it got. Check before trying it again: trying it again asks you for 'close_on_refund' again, and the steps "
      + 'after it run again too.');
    expect(text).toContain('trying it again runs the recipe from its first step.');
    expect(text).toContain('The server restarted during its approved run before Recued could keep it.');
    route.dispose();
  });

  // D-201 Slice 10AG (10AE finding 11) — a server since 10AG sends every held
  // state in `held_try_again`, and `step_in_doubt` only for those a 10W
  // Settings words right; this one reads the new field first.
  it("D-201 Slice 10AG — a held run's dead letter is read from held_try_again first", async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const ingress: WebhookIngressView = { ...readyWebhook(), intake_state: 'enabled', dead_letters_unresolved: 2 };
    const item = (
      index: number,
      held: WebhookDeadLetterView['held_try_again'],
      tenW?: WebhookDeadLetterView['step_in_doubt'],
    ): WebhookDeadLetterView => ({
      kind: 'target',
      dead_letter_id: `whx_${String(index).padStart(32, '0')}`,
      ingress_id: ingress.ingress_id,
      delivery_id: `whd_${String(index).padStart(32, '0')}`,
      event_id: `whe_${String(index).padStart(32, '0')}`,
      provider_event_type: 'delivery',
      received_at: 2_100_000_000_000 + index,
      recipe_id: 'refund-revoke',
      attempt_count: 1,
      last_error_code: 'approved_run_in_doubt',
      dead_lettered_at: 2_100_000_001_000 + index,
      payload_retained: true,
      ...(held !== undefined ? { held_try_again: held } : {}),
      ...(tenW !== undefined ? { step_in_doubt: tenW } : {}),
    });
    const route = bootstrapConnectionsRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      initialTab: 'webhooks',
      webhooksListCaller: vi.fn(async () => webhookList([ingress])),
      webhooksCreateCaller: vi.fn(async () => ({ ingress })),
      webhooksCredentialWriteCaller: vi.fn(async () => ({ ingress, credential_version: ingress.active_credential_versions[0]! })),
      webhooksCredentialRetireCaller: vi.fn(async () => ({ ingress })),
      webhooksManualConfirmCaller: vi.fn(async () => ({ ingress })),
      webhooksEnableCaller: vi.fn(async () => ({ ingress })),
      webhooksDisableCaller: vi.fn(async () => ({ ingress })),
      webhooksDeadLetterListCaller: vi.fn(async (): Promise<WebhookDeadLetterListResponse> => ({
        dead_letters: [
          item(0, { step_id: 'tell_owner_three', failed: true }),
          item(1, { step_id: 'tell_owner_two', failed: true }, { step_id: 'tell_owner_two' }),
        ],
        next_cursor: null,
        review: { unresolved: 2, limit: 1_000 },
      })),
      webhooksDeadLetterRequeueCaller: vi.fn(async () => { throw new Error('not called'); }),
      webhooksDeadLetterResolveCaller: vi.fn(async () => { throw new Error('not called'); }),
    });
    await route.webhooksPanel()!.refresh();
    findByAttrValue(root, WEBHOOKS_PANEL_ACTION_ATTR, 'dead-letters')!.click();
    await tick();
    const text = treeText(root);
    expect(text).toContain("Tried again, its approved run failed at 'tell_owner_three'.");
    expect(text).toContain("Tried again, its approved run failed at 'tell_owner_two'.");
    expect(text).not.toContain("Recued cannot tell whether 'tell_owner_two' went through");
    route.dispose();
  });

  // D-201 Slice 10BC (10AY findings 2 and 9) — Recued could not keep what ran
  // after the step it names: Settings said only that step could run twice, and
  // the try again sent again each later step that went through.
  it("D-201 Slice 10BC — a held run's dead letter says the steps after its step run again when they could not be kept", async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const ingress: WebhookIngressView = { ...readyWebhook(), intake_state: 'enabled', dead_letters_unresolved: 5 };
    const item = (index: number, held: WebhookDeadLetterView['held_try_again']): WebhookDeadLetterView => ({
      kind: 'target',
      dead_letter_id: `whx_${String(index).padStart(32, '0')}`,
      ingress_id: ingress.ingress_id,
      delivery_id: `whd_${String(index).padStart(32, '0')}`,
      event_id: `whe_${String(index).padStart(32, '0')}`,
      provider_event_type: 'delivery',
      received_at: 2_100_000_000_000 + index,
      recipe_id: 'refund-revoke',
      attempt_count: 1,
      last_error_code: 'approved_run_in_doubt',
      dead_lettered_at: 2_100_000_001_000 + index,
      payload_retained: true,
      ...(held !== undefined ? { held_try_again: held } : {}),
    });
    const route = bootstrapConnectionsRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      initialTab: 'webhooks',
      webhooksListCaller: vi.fn(async () => webhookList([ingress])),
      webhooksCreateCaller: vi.fn(async () => ({ ingress })),
      webhooksCredentialWriteCaller: vi.fn(async () => ({ ingress, credential_version: ingress.active_credential_versions[0]! })),
      webhooksCredentialRetireCaller: vi.fn(async () => ({ ingress })),
      webhooksManualConfirmCaller: vi.fn(async () => ({ ingress })),
      webhooksEnableCaller: vi.fn(async () => ({ ingress })),
      webhooksDisableCaller: vi.fn(async () => ({ ingress })),
      webhooksDeadLetterListCaller: vi.fn(async (): Promise<WebhookDeadLetterListResponse> => ({
        dead_letters: [
          // A loop close, held at itself once the run went past it.
          item(0, { step_id: 'close_on_refund', asks_again: true, later_run_again: true }),
          // A row a later write could not replace.
          item(1, { step_id: 'tell_owner_one', later_run_again: true }),
          item(2, { step_id: 'tell_owner_two', failed: true, later_run_again: true }),
          // A death's unknown progress says it already.
          item(3, { step_id: 'tell_owner_three', progress_unknown: true, later_run_again: true }),
          // D-201 Slice 10BH (10BF finding 1) — a try again that failed at the
          // close, or past it: held at the close, which asks again.
          item(4, { step_id: 'close_on_refund', asks_again: true, failed: true, later_run_again: true }),
        ],
        next_cursor: null,
        review: { unresolved: 5, limit: 1_000 },
      })),
      webhooksDeadLetterRequeueCaller: vi.fn(async () => { throw new Error('not called'); }),
      webhooksDeadLetterResolveCaller: vi.fn(async () => { throw new Error('not called'); }),
    });
    await route.webhooksPanel()!.refresh();
    findByAttrValue(root, WEBHOOKS_PANEL_ACTION_ATTR, 'dead-letters')!.click();
    await tick();
    const text = treeText(root);
    expect(text).toContain("Recued cannot tell whether 'close_on_refund' went through, and could not keep how far its "
      + 'approved run got after it (Logs say why). Check before trying it again: trying it again asks you for '
      + "'close_on_refund' again, and the steps after it that ran run again too.");
    expect(text).toContain("Recued cannot tell whether 'tell_owner_one' went through, and could not keep how far its "
      + "approved run got after it (Logs say why). Check before trying it again: trying it again goes on from "
      + "'tell_owner_one', with what ran before it kept, so that step and each step after it that ran can run twice.");
    expect(text).toContain("Tried again, its approved run failed at 'tell_owner_two', and Recued could not keep how "
      + 'far an earlier run got past it. Check why in Logs before trying it again: trying it again goes on from '
      + "'tell_owner_two', with what ran before it kept, so that step and each step after it that ran can run twice.");
    expect(text).toContain('The server stopped without warning while its approved run was tried again, so Recued '
      + "cannot tell how far it got. Check before trying it again: trying it again goes on from 'tell_owner_three', "
      + 'with what ran before it kept, so that step and each step after it can run twice.');
    // Before 10BH: "…failed at 'close_on_refund'", where it may have gone past it.
    expect(text).toContain("Tried again, its approved run failed, and Recued could not keep what ran after "
      + "'close_on_refund'. Check why in Logs before trying it again: trying it again asks you for "
      + "'close_on_refund' again, and the steps after it that ran run again too.");
    expect(text).not.toContain("Tried again, its approved run failed at 'close_on_refund'");
    expect(text).not.toContain('only that step can run twice');
    route.dispose();
  });

  it("D-201 Slice 10BI — a held run's dead letter says when only a hand-off is unproven (10BF finding 5)", async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const ingress: WebhookIngressView = { ...readyWebhook(), intake_state: 'enabled', dead_letters_unresolved: 3 };
    const item = (index: number, held: WebhookDeadLetterView['held_try_again']): WebhookDeadLetterView => ({
      kind: 'target',
      dead_letter_id: `whx_${String(index).padStart(32, '0')}`,
      ingress_id: ingress.ingress_id,
      delivery_id: `whd_${String(index).padStart(32, '0')}`,
      event_id: `whe_${String(index).padStart(32, '0')}`,
      provider_event_type: 'delivery',
      received_at: 2_100_000_000_000 + index,
      recipe_id: 'refund-revoke',
      attempt_count: 1,
      last_error_code: 'approved_run_in_doubt',
      dead_lettered_at: 2_100_000_001_000 + index,
      payload_retained: true,
      ...(held !== undefined ? { held_try_again: held } : {}),
    });
    const route = bootstrapConnectionsRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      initialTab: 'webhooks',
      webhooksListCaller: vi.fn(async () => webhookList([ingress])),
      webhooksCreateCaller: vi.fn(async () => ({ ingress })),
      webhooksCredentialWriteCaller: vi.fn(async () => ({ ingress, credential_version: ingress.active_credential_versions[0]! })),
      webhooksCredentialRetireCaller: vi.fn(async () => ({ ingress })),
      webhooksManualConfirmCaller: vi.fn(async () => ({ ingress })),
      webhooksEnableCaller: vi.fn(async () => ({ ingress })),
      webhooksDisableCaller: vi.fn(async () => ({ ingress })),
      webhooksDeadLetterListCaller: vi.fn(async (): Promise<WebhookDeadLetterListResponse> => ({
        dead_letters: [
          // Held at the close, which handed its work on, the run gone past it.
          item(0, { step_id: 'close_on_refund', asks_again: true, later_run_again: true, handoff_unproven: true }),
          // Nothing after it ran.
          item(1, { step_id: 'close_on_refund', asks_again: true, handoff_unproven: true }),
          // A try again since failed says so first.
          item(2, {
            step_id: 'close_on_refund', asks_again: true, failed: true, later_run_again: true, handoff_unproven: true,
          }),
          // D-201 Slice 10BV (10BS finding 8) — and with nothing after it run.
          item(3, { step_id: 'close_on_refund', asks_again: true, failed: true, handoff_unproven: true }),
        ],
        next_cursor: null,
        review: { unresolved: 4, limit: 1_000 },
      })),
      webhooksDeadLetterRequeueCaller: vi.fn(async () => { throw new Error('not called'); }),
      webhooksDeadLetterResolveCaller: vi.fn(async () => { throw new Error('not called'); }),
    });
    await route.webhooksPanel()!.refresh();
    findByAttrValue(root, WEBHOOKS_PANEL_ACTION_ATTR, 'dead-letters')!.click();
    await tick();
    const text = treeText(root);
    // Before 10BI: "…could not keep how far its approved run got after it", and
    // with nothing after it, "Recued cannot tell whether…", of a close that had
    // returned and handed its work on.
    expect(text).toContain("'close_on_refund' handed its work on and returned no hand-off Recued can check, so Recued "
      + "cannot prove it went through. Check before trying it again: trying it again asks you for 'close_on_refund' "
      + 'again, and the steps after it that ran run again too.');
    expect(text).toContain("'close_on_refund' handed its work on and returned no hand-off Recued can check, so Recued "
      + "cannot prove it went through. Check before trying it again: trying it again asks you for 'close_on_refund' "
      + 'again and goes on from it, with what ran before it kept, so only that step can run twice.');
    // D-201 Slice 10BP (10BM finding 12) — after a failed try again, too. It
    // said "…Recued could not keep what ran after 'close_on_refund'".
    expect(text).toContain("Tried again, its approved run failed, and 'close_on_refund' had handed its work on and "
      + 'returned no hand-off Recued can check. Check why in Logs before trying it again: trying it again asks you '
      + "for 'close_on_refund' again, and the steps after it that ran run again too.");
    // D-201 Slice 10BV (10BS finding 8) — it was worded as any failed step:
    // "Tried again, its approved run failed at 'close_on_refund'…".
    expect(text).toContain("Tried again, its approved run failed, and 'close_on_refund' had handed its work on and "
      + 'returned no hand-off Recued can check. Check why in Logs before trying it again: trying it again asks you '
      + "for 'close_on_refund' again and goes on from it, with what ran before it kept, so only that step can run twice.");
    expect(text).not.toContain("Tried again, its approved run failed at 'close_on_refund'");
    expect(text).not.toContain('could not keep what ran after');
    expect(text).not.toContain('could not keep how far its approved run got after it');
    route.dispose();
  });

  it("D-201 Slice 10AB — a held run's dead letter says what its try again does when the recipe changed, the try again failed, or the server went during it", async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const ingress: WebhookIngressView = { ...readyWebhook(), intake_state: 'enabled', dead_letters_unresolved: 4 };
    const item = (index: number, held: WebhookDeadLetterView['step_in_doubt']): WebhookDeadLetterView => ({
      kind: 'target',
      dead_letter_id: `whx_${String(index).padStart(32, '0')}`,
      ingress_id: ingress.ingress_id,
      delivery_id: `whd_${String(index).padStart(32, '0')}`,
      event_id: `whe_${String(index).padStart(32, '0')}`,
      provider_event_type: 'delivery',
      received_at: 2_100_000_000_000 + index,
      recipe_id: 'refund-revoke',
      attempt_count: 1,
      last_error_code: 'approved_run_in_doubt',
      dead_lettered_at: 2_100_000_001_000 + index,
      payload_retained: true,
      ...(held !== undefined ? { step_in_doubt: held } : {}),
    });
    const route = bootstrapConnectionsRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      initialTab: 'webhooks',
      webhooksListCaller: vi.fn(async () => webhookList([ingress])),
      webhooksCreateCaller: vi.fn(async () => ({ ingress })),
      webhooksCredentialWriteCaller: vi.fn(async () => ({ ingress, credential_version: ingress.active_credential_versions[0]! })),
      webhooksCredentialRetireCaller: vi.fn(async () => ({ ingress })),
      webhooksManualConfirmCaller: vi.fn(async () => ({ ingress })),
      webhooksEnableCaller: vi.fn(async () => ({ ingress })),
      webhooksDisableCaller: vi.fn(async () => ({ ingress })),
      webhooksDeadLetterListCaller: vi.fn(async (): Promise<WebhookDeadLetterListResponse> => ({
        dead_letters: [
          item(0, { step_id: 'close_on_refund', recipe_changed: true }),
          item(1, { step_id: 'tell_owner_three', failed: true }),
          item(2, { step_id: 'close_on_refund', asks_again: true, failed: true }),
          item(3, { step_id: 'tell_owner_two', progress_unknown: true }),
          // D-201 Slice 10AP (10AM finding 4) — a death, then a try again failing.
          item(4, { step_id: 'tell_owner_two', progress_unknown: true, failed: true }),
          item(5, { step_id: 'close_on_refund', asks_again: true, progress_unknown: true, failed: true }),
        ],
        next_cursor: null,
        review: { unresolved: 6, limit: 1_000 },
      })),
      webhooksDeadLetterRequeueCaller: vi.fn(async () => { throw new Error('not called'); }),
      webhooksDeadLetterResolveCaller: vi.fn(async () => { throw new Error('not called'); }),
    });
    await route.webhooksPanel()!.refresh();
    findByAttrValue(root, WEBHOOKS_PANEL_ACTION_ATTR, 'dead-letters')!.click();
    await tick();
    const text = treeText(root);
    // 10AA finding 4: it said the try again went on from the step in doubt.
    expect(text).toContain('The server restarted during its approved run, and the recipe has changed since, so what '
      + "that run kept cannot stand in for this version's steps. Check before trying it again: trying it again runs "
      + 'the recipe from its first step, so the steps that went through run again, and each step that needs your '
      + "approval, such as 'close_on_refund', asks you again.");
    // 10AA finding 2: a try again that failed is held from the step it failed at.
    expect(text).toContain("Tried again, its approved run failed at 'tell_owner_three'. Check why in Logs before "
      + "trying it again: trying it again goes on from 'tell_owner_three', with what ran before it kept, so only that "
      + 'step can run twice.');
    expect(text).toContain("Tried again, its approved run failed at 'close_on_refund'. Check why in Logs before trying "
      + "it again: trying it again asks you for 'close_on_refund' again and goes on from it, with what ran before it "
      + 'kept, so only that step can run twice.');
    // 10AA finding 1: the server went during the try again, past the approved step.
    expect(text).toContain('The server stopped without warning while its approved run was tried again, so Recued '
      + "cannot tell how far it got. Check before trying it again: trying it again goes on from 'tell_owner_two', "
      + 'with what ran before it kept, so that step and each step after it can run twice.');
    expect(text).not.toContain("asks you for 'tell_owner_two'");
    // D-201 Slice 10AP (10AM finding 4) — the failure and the unknown, both.
    expect(text).toContain("Tried again, its approved run failed at 'tell_owner_two', and Recued cannot tell how far "
      + 'an earlier run got, the server having stopped without warning. Check why in Logs before trying it again: '
      + "trying it again goes on from 'tell_owner_two', with what ran before it kept, so that step and each step "
      + 'after it can run twice.');
    expect(text).toContain("Tried again, its approved run failed at 'close_on_refund', and Recued cannot tell how far "
      + 'an earlier run got, the server having stopped without warning. Check why in Logs before trying it again: '
      + "trying it again asks you for 'close_on_refund' again and goes on from it, with what ran before it kept, so "
      + 'that step and each step after it can run twice.');
    route.dispose();
  });

  it('D-201 Slice 10F — shows the closed ones with who closed each and why; a refusal never sits beside an earlier notice; an action keeps what was showing', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const ingress: WebhookIngressView = { ...readyWebhook(), intake_state: 'enabled', dead_letters_unresolved: 12 };
    const item = (index: number, overrides: Partial<WebhookDeadLetterView> = {}): WebhookDeadLetterView => ({
      kind: 'target',
      dead_letter_id: `whx_${String(index).padStart(32, '0')}`,
      ingress_id: ingress.ingress_id,
      delivery_id: `whd_${String(index).padStart(32, '0')}`,
      event_id: `whe_${String(index).padStart(32, '0')}`,
      provider_event_type: 'delivery',
      received_at: 2_100_000_000_000 + index,
      recipe_id: 'track-parcels',
      attempt_count: 8,
      last_error_code: 'run_failed',
      dead_lettered_at: 2_100_000_001_000 + index,
      payload_retained: true,
      ...overrides,
    });
    const open = Array.from({ length: 12 }, (_, index) => item(index));
    const closedOnes = [
      item(100, { closure: { closed_at: 2_100_000_009_000, closed_by: 'owner', reason: 'Refunded by hand' } }),
      item(101, { closure: { closed_at: 2_100_000_008_000, closed_by: 'server', reason: 'review_limit' } }),
      item(102, { closure: { closed_at: 2_100_000_007_000, closed_by: 'server', reason: 'recipe_replaced' } }),
      item(103, { closure: { closed_at: 2_100_000_006_000, closed_by: 'server', reason: 'a_reason_from_a_newer_server' } }),
      // D-201 Slice 10AD (10AA finding 17) — one no door let run, closed by the
      // limit first whatever its age: it said "this was the oldest".
      item(104, {
        last_error_code: 'door_missing',
        closure: { closed_at: 2_100_000_005_000, closed_by: 'server', reason: 'review_limit' },
      }),
      // D-201 Slice 10AH (10AE finding 24) — and one whose door was closed.
      item(105, {
        last_error_code: 'door_closed',
        closure: { closed_at: 2_100_000_004_000, closed_by: 'server', reason: 'review_limit' },
      }),
    ];
    const runDeadLetterList = vi.fn(async (args: { limit?: number; cursor?: unknown; closed?: boolean })
      : Promise<WebhookDeadLetterListResponse> => {
      if (args.closed === true) return { dead_letters: closedOnes, next_cursor: null, review: { unresolved: 12, limit: 1_000 } };
      const from = args.cursor === undefined ? 0 : 10;
      const page = open.slice(from, from + (args.limit ?? 10));
      const last = page.at(-1)!;
      return {
        dead_letters: page,
        next_cursor: from + page.length < open.length
          ? { dead_lettered_at: last.dead_lettered_at, kind: last.kind, dead_letter_id: last.dead_letter_id }
          : null,
        review: { unresolved: 12, limit: 1_000 },
      };
    });
    let refuse = false;
    const runDeadLetterRequeue = vi.fn(async (args: WebhookDeadLetterActionRequest): Promise<WebhookDeadLetterActionResponse> => {
      if (refuse) {
        throw Object.assign(new Error('webhook.delivery.dead_letter.requeue: no recipe takes this message now; close it instead'), {
          code: 'webhook_dead_letter_no_recipe',
        });
      }
      return { dead_letter: args.dead_letter, outcome: 'requeued', review_id: 'whv_00000000000000000000000000000001', acted_at: 1 };
    });
    const route = bootstrapConnectionsRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      initialTab: 'webhooks',
      webhooksListCaller: vi.fn(async () => webhookList([ingress])),
      webhooksCreateCaller: vi.fn(async () => ({ ingress })),
      webhooksCredentialWriteCaller: vi.fn(async () => ({ ingress, credential_version: ingress.active_credential_versions[0]! })),
      webhooksCredentialRetireCaller: vi.fn(async () => ({ ingress })),
      webhooksManualConfirmCaller: vi.fn(async () => ({ ingress })),
      webhooksEnableCaller: vi.fn(async () => ({ ingress })),
      webhooksDisableCaller: vi.fn(async () => ({ ingress })),
      webhooksDeadLetterListCaller: runDeadLetterList,
      webhooksDeadLetterRequeueCaller: runDeadLetterRequeue,
      webhooksDeadLetterResolveCaller: vi.fn(async () => { throw new Error('not called'); }),
    });
    await route.webhooksPanel()!.refresh();
    findByAttrValue(root, WEBHOOKS_PANEL_ACTION_ATTR, 'dead-letters')!.click();
    await tick();
    findByAttrValue(root, WEBHOOKS_PANEL_ACTION_ATTR, 'dead-letters-more')!.click();
    await tick();
    expect(collectByAttr(root, WEBHOOKS_PANEL_DEAD_LETTER_ATTR)).toHaveLength(12);

    // Tried again: the list is read again with all twelve that were showing.
    const requeueOf = (index: number) => findByAttrValue(
      findByAttrValue(root, WEBHOOKS_PANEL_DEAD_LETTER_ATTR, `target:${open[index]!.dead_letter_id}`)!,
      WEBHOOKS_PANEL_ACTION_ATTR,
      'dead-letter-requeue',
    )!;
    requeueOf(0).click();
    await tick();
    expect(runDeadLetterList.mock.calls.at(-1)![0]).toMatchObject({ limit: 12 });
    expect(collectByAttr(root, WEBHOOKS_PANEL_DEAD_LETTER_ATTR)).toHaveLength(12);
    expect(treeText(root)).toContain('Recued is trying it again now.');
    // Refused: plain words, and the earlier notice is gone.
    refuse = true;
    requeueOf(1).click();
    await tick();
    expect(treeText(root)).toContain('No recipe takes this message now: its recipe was removed, switched off, or saved or updated with a different webhook setup. Close it instead.');
    expect(treeText(root)).not.toContain('Recued is trying it again now.');
    expect(treeText(root)).not.toContain('webhook.delivery.dead_letter.requeue');

    // The closed ones, each with who closed it and why.
    findByAttrValue(root, WEBHOOKS_PANEL_ACTION_ATTR, 'dead-letters-closed')!.click();
    await tick();
    expect(runDeadLetterList).toHaveBeenLastCalledWith({ ingress_id: ingress.ingress_id, limit: 10, closed: true });
    const closedText = (index: number) => treeText(findByAttrValue(
      root,
      WEBHOOKS_PANEL_CLOSED_DEAD_LETTER_ATTR,
      `target:${closedOnes[index]!.dead_letter_id}`,
    )!);
    expect(closedText(0)).toContain('You closed it: Refunded by hand');
    expect(closedText(1)).toContain('Recued closed it. More than 1,000 were waiting, and this was the oldest.');
    expect(closedText(2)).toContain('Recued closed it. Its recipe was saved or updated with a different webhook setup, so it may not take it now.');
    expect(closedText(3)).toContain('Recued closed it.');
    expect(closedText(3)).not.toContain('a_reason_from_a_newer_server');
    expect(closedText(4)).toContain('Recued closed it. More than 1,000 were waiting, and those no door let run are closed first.');
    expect(closedText(4)).not.toContain('this was the oldest');
    expect(closedText(5)).toContain('Recued closed it. More than 1,000 were waiting, and those no door let run are closed first.');
    expect(closedText(5)).not.toContain('this was the oldest');
    findByAttrValue(root, WEBHOOKS_PANEL_ACTION_ATTR, 'dead-letters-closed')!.click();
    await tick();
    expect(collectByAttr(root, WEBHOOKS_PANEL_CLOSED_DEAD_LETTER_ATTR)).toHaveLength(0);
    route.dispose();
  });

  it('D-201 Slice 10I — the closed ones can be reached with none open, and a refusal Settings makes clears the last notice', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const quiet: WebhookIngressView = { ...readyWebhook(), intake_state: 'enabled', dead_letters_unresolved: 0 };
    const closedOne: WebhookDeadLetterView = {
      kind: 'target',
      dead_letter_id: 'whx_00000000000000000000000000000077',
      ingress_id: quiet.ingress_id,
      delivery_id: 'whd_00000000000000000000000000000077',
      event_id: 'whe_00000000000000000000000000000077',
      provider_event_type: 'delivery',
      received_at: 2_100_000_000_000,
      recipe_id: 'track-parcels',
      attempt_count: 8,
      last_error_code: 'run_failed',
      dead_lettered_at: 2_100_000_009_000,
      payload_retained: false,
      closure: { closed_at: 2_100_000_009_000, closed_by: 'server', reason: 'recipe_disarmed' },
    };
    const route = bootstrapConnectionsRoute({
      ...webhookRouteCallers(root, doc, [quiet], TEST_WEBHOOK_PROFILE_CAPABILITIES),
      webhooksDeadLetterListCaller: vi.fn(async (args: { closed?: boolean }) => ({
        dead_letters: args.closed === true ? [closedOne] : [],
        next_cursor: null,
        review: { unresolved: 0, limit: 1_000 },
      })),
      webhooksDeadLetterRequeueCaller: vi.fn(async () => { throw new Error('not called'); }),
      webhooksDeadLetterResolveCaller: vi.fn(async () => { throw new Error('not called'); }),
    });
    await route.webhooksPanel()!.refresh();
    // 10H finding 6: with none open the section had no way in at all.
    const open = findByAttrValue(root, WEBHOOKS_PANEL_ACTION_ATTR, 'dead-letters')!;
    expect(open.textContent).toBe('See the messages that did not reach their recipes');
    open.click();
    await tick();
    expect(treeText(root)).toContain('None are waiting');
    findByAttrValue(root, WEBHOOKS_PANEL_ACTION_ATTR, 'dead-letters-closed')!.click();
    await tick();
    expect(treeText(findByAttrValue(
      root,
      WEBHOOKS_PANEL_CLOSED_DEAD_LETTER_ATTR,
      `target:${closedOne.dead_letter_id}`,
    )!)).toContain('Recued closed it. Its recipe was switched off.');
    route.dispose();
  });

  it('D-201 Slice 10I — closing one with no reason clears the notice an earlier action left', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const ingress: WebhookIngressView = { ...readyWebhook(), intake_state: 'enabled', dead_letters_unresolved: 2 };
    const item = (index: number): WebhookDeadLetterView => ({
      kind: 'target',
      dead_letter_id: `whx_${String(index).padStart(32, '0')}`,
      ingress_id: ingress.ingress_id,
      delivery_id: `whd_${String(index).padStart(32, '0')}`,
      event_id: `whe_${String(index).padStart(32, '0')}`,
      provider_event_type: 'delivery',
      received_at: 2_100_000_000_000 + index,
      recipe_id: 'track-parcels',
      attempt_count: 8,
      last_error_code: 'run_failed',
      dead_lettered_at: 2_100_000_001_000 + index,
      payload_retained: true,
    });
    const waiting = [item(1), item(2)];
    const route = bootstrapConnectionsRoute({
      ...webhookRouteCallers(root, doc, [ingress], TEST_WEBHOOK_PROFILE_CAPABILITIES),
      webhooksDeadLetterListCaller: vi.fn(async () => ({
        dead_letters: [...waiting],
        next_cursor: null,
        review: { unresolved: waiting.length, limit: 1_000 },
      })),
      webhooksDeadLetterRequeueCaller: vi.fn(async (args: WebhookDeadLetterActionRequest) => {
        waiting.splice(waiting.findIndex((row) => row.dead_letter_id === args.dead_letter.dead_letter_id), 1);
        return { dead_letter: args.dead_letter, outcome: 'requeued' as const, review_id: 'whv_00000000000000000000000000000001', acted_at: 1 };
      }),
      webhooksDeadLetterResolveCaller: vi.fn(async () => { throw new Error('not called'); }),
    });
    await route.webhooksPanel()!.refresh();
    findByAttrValue(root, WEBHOOKS_PANEL_ACTION_ATTR, 'dead-letters')!.click();
    await tick();
    findByAttrValue(
      findByAttrValue(root, WEBHOOKS_PANEL_DEAD_LETTER_ATTR, `target:${item(1).dead_letter_id}`)!,
      WEBHOOKS_PANEL_ACTION_ATTR,
      'dead-letter-requeue',
    )!.click();
    await tick();
    expect(treeText(root)).toContain('Recued is trying it again now.');
    // A close with no reason is refused before any request: the old notice goes.
    findByAttrValue(
      findByAttrValue(root, WEBHOOKS_PANEL_DEAD_LETTER_ATTR, `target:${item(2).dead_letter_id}`)!,
      WEBHOOKS_PANEL_ACTION_ATTR,
      'dead-letter-resolve',
    )!.click();
    await tick();
    expect(treeText(root)).toContain('Write why you are closing it first');
    expect(treeText(root)).not.toContain('Recued is trying it again now.');
    route.dispose();
  });

  it('D-201 Slice 10F — retiring says first that it closes the messages that did not reach their recipes', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const waiting: WebhookIngressView = { ...readyWebhook(), intake_state: 'disabled', dead_letters_unresolved: 3 };
    const quiet: WebhookIngressView = {
      ...readyWebhook(),
      ingress_id: 'whi_0123456789abcdef0123456789abcde7',
      display_name: 'Quiet one',
      intake_state: 'disabled',
      dead_letters_unresolved: 0,
    };
    const runRetire = vi.fn(async (args: { ingress_id: string }) => ({
      ingress: { ...waiting, ingress_id: args.ingress_id, intake_state: 'retired' as const, registration_state: 'retired' as const },
      dead_letters_closed: 3,
    }));
    const route = bootstrapConnectionsRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      initialTab: 'webhooks',
      webhooksListCaller: vi.fn(async () => webhookList([waiting, quiet])),
      webhooksCreateCaller: vi.fn(async () => ({ ingress: waiting })),
      webhooksCredentialWriteCaller: vi.fn(async () => ({ ingress: waiting, credential_version: waiting.active_credential_versions[0]! })),
      webhooksCredentialRetireCaller: vi.fn(async () => ({ ingress: waiting })),
      webhooksManualConfirmCaller: vi.fn(async () => ({ ingress: waiting })),
      webhooksEnableCaller: vi.fn(async () => ({ ingress: waiting })),
      webhooksDisableCaller: vi.fn(async () => ({ ingress: waiting })),
      webhooksRetireCaller: runRetire,
    });
    await route.webhooksPanel()!.refresh();
    const card = (id: string) => findByAttrValue(root, WEBHOOKS_PANEL_CARD_ATTR, id)!;
    findByAttrValue(card(quiet.ingress_id), WEBHOOKS_PANEL_ACTION_ATTR, 'retire')!.click();
    await tick();
    expect(collectByAttr(card(quiet.ingress_id), WEBHOOKS_PANEL_RETIRE_DEAD_LETTERS_ATTR)).toHaveLength(0);
    expect(findByAttrValue(card(quiet.ingress_id), WEBHOOKS_PANEL_ACTION_ATTR, 'retire-confirm')!
      .getAttribute('aria-describedby')).toBeNull();
    findByAttrValue(card(quiet.ingress_id), WEBHOOKS_PANEL_ACTION_ATTR, 'retire-cancel')!.click();
    await tick();

    findByAttrValue(card(waiting.ingress_id), WEBHOOKS_PANEL_ACTION_ATTR, 'retire')!.click();
    await tick();
    const warning = findByAttrValue(card(waiting.ingress_id), WEBHOOKS_PANEL_RETIRE_DEAD_LETTERS_ATTR, '3')!;
    expect(warning.textContent).toBe('Retiring it also closes the 3 messages that did not reach their recipes. They cannot be tried again once the webhook is retired.');
    // The confirm button, where focus goes, is described by it.
    const confirm = findByAttrValue(card(waiting.ingress_id), WEBHOOKS_PANEL_ACTION_ATTR, 'retire-confirm')!;
    expect(confirm.getAttribute('aria-describedby')).toBe(warning.getAttribute('id'));
    expect(warning.getAttribute('id')).toBe(`wh-retire-dead-letters-${waiting.ingress_id}`);
    confirm.click();
    await tick();
    expect(runRetire).toHaveBeenCalledWith({ ingress_id: waiting.ingress_id });
    route.dispose();
  });

  it('D-201 Slice 10C — the create form adds a name the server grammar takes, refuses one it does not, and sends both kinds', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const created: WebhookIngressView = {
      ...readyWebhook(),
      display_name: 'Lemon store',
      profile_id: 'lemonsqueezy.webhook.v1',
      environment: 'test',
      selected_event_types: ['order_created', 'subscription_plan_changed'],
      registration_state: 'manual_pending',
      intake_state: 'draft',
    };
    const runCreate = vi.fn(async () => ({ ingress: created }));
    const route = bootstrapConnectionsRoute({
      ...webhookRouteCallers(root, doc, [], [projectedCapability('lemonsqueezy.webhook.v1')]),
      webhooksCreateCaller: runCreate,
    });
    await route.webhooksPanel()!.refresh();
    collectByAttr(root, WEBHOOKS_PANEL_NEW_ATTR)[0]!.click();
    const profile = collectByAttr(root, WEBHOOKS_PANEL_PROFILE_ATTR)[0]!;
    profile.value = 'lemonsqueezy.webhook.v1';
    fire(profile, 'change', { target: profile });
    collectByAttr(root, WEBHOOKS_PANEL_ENVIRONMENT_ATTR)[0]!.value = 'test';
    expect(treeText(root)).toContain(
      'Lowercase letters, digits and _, starting with a letter, up to 128 long.',
    );
    const custom = findByAttrValue(root, WEBHOOKS_PANEL_FIELD_ATTR, 'event-type-custom')!;
    const add = findByAttrValue(root, WEBHOOKS_PANEL_ACTION_ATTR, 'event-type-add')!;
    const box = (eventType: string) =>
      findByAttrValue(root, WEBHOOKS_PANEL_EVENT_TYPE_ATTR, eventType);

    // A name outside the grammar is refused, in the grammar's own words.
    custom.value = 'Subscription.Plan-Changed';
    add.click();
    expect(box('Subscription.Plan-Changed')).toBeNull();
    expect(treeText(root)).toContain("This service's events are not named like that.");
    // A name the known list does not offer, but the grammar takes, is added ticked.
    custom.value = '  subscription_plan_changed ';
    add.click();
    expect(box('subscription_plan_changed')?.checked).toBe(true);
    expect(custom.value).toBe('');
    // Enter adds a name rather than sending the form; a known name is ticked,
    // never listed twice.
    custom.value = 'order_created';
    const enter = { key: 'Enter', preventDefault: vi.fn() };
    fire(custom, 'keydown', enter);
    expect(enter.preventDefault).toHaveBeenCalled();
    expect(runCreate).not.toHaveBeenCalled();
    expect(box('order_created')?.checked).toBe(true);
    expect(collectByAttr(root, WEBHOOKS_PANEL_EVENT_TYPE_ATTR).filter((input) =>
      input.getAttribute(WEBHOOKS_PANEL_EVENT_TYPE_ATTR) === 'order_created')).toHaveLength(1);
    expect(treeText(root)).toContain('order_created was already in the list. It is ticked now.');

    findByAttrValue(root, WEBHOOKS_PANEL_FIELD_ATTR, 'display_name')!.value = 'Lemon store';
    fire(findByAttrValue(root, WEBHOOKS_PANEL_FORM_ATTR, 'create')!, 'submit', {
      preventDefault() {},
    });
    await tick();
    expect(runCreate).toHaveBeenCalledWith(expect.objectContaining({
      profile_id: 'lemonsqueezy.webhook.v1',
      selected_event_types: ['order_created', 'subscription_plan_changed'],
    }));
    route.dispose();
  });

  it('D-201 Slice 10C — takes a typed name exactly when the grammar the server projected takes it', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const openProfiles = WEBHOOK_PROFILE_IDS.filter((profileId) =>
      WEBHOOK_PROFILE_REGISTRY[profileId].event_types.kind === 'open');
    // GitHub as a server could project it: the panel must follow the server,
    // never its own copy of the catalog.
    const serverGitHubGrammar: WebhookEventTypeGrammar = { kind: 'ascii_identifier.v1', max_bytes: 40 };
    const github = WEBHOOK_PROFILE_REGISTRY['github.webhook.v1'].event_types;
    if (github.kind !== 'open') throw new Error('GitHub has an open catalog');
    const capabilities = openProfiles.map((profileId) => profileId === 'github.webhook.v1'
      ? projectedCapability(profileId, { ...github, grammar: serverGitHubGrammar })
      : projectedCapability(profileId));
    const route = bootstrapConnectionsRoute(webhookRouteCallers(root, doc, [], capabilities));
    await route.webhooksPanel()!.refresh();
    collectByAttr(root, WEBHOOKS_PANEL_NEW_ATTR)[0]!.click();
    const names = [
      'subscription_plan_changed', 'merge_group', 'business_message', 'Message', 'Push',
      'customer.future_event', 'v2.core.account:updated/x-y', 'transaction.completed',
      'transaction.payment.failed', 'Transaction.completed', 'pull_request.opened',
      'message.edited', 'chat-boost', '1message', '_message', 'order-created', 'a/b',
      'é', '😀', 'a'.repeat(40), 'a'.repeat(41), 'a'.repeat(128), 'a'.repeat(129),
      `${'a'.repeat(63)}.b`, `${'a'.repeat(64)}.b`,
    ];
    for (const profileId of openProfiles) {
      const profile = collectByAttr(root, WEBHOOKS_PANEL_PROFILE_ATTR)[0]!;
      profile.value = profileId;
      fire(profile, 'change', { target: profile });
      const grammar = capabilities.find((capability) => capability.profile_id === profileId)!
        .event_types as Extract<WebhookProfileRuntimeCapabilityView['event_types'], { kind: 'open' }>;
      for (const name of names) {
        const custom = findByAttrValue(root, WEBHOOKS_PANEL_FIELD_ATTR, 'event-type-custom')!;
        custom.value = name;
        findByAttrValue(root, WEBHOOKS_PANEL_ACTION_ATTR, 'event-type-add')!.click();
        const added = findByAttrValue(root, WEBHOOKS_PANEL_EVENT_TYPE_ATTR, name);
        expect(added?.checked === true, `${profileId} ${name}`)
          .toBe(webhookEventTypeGrammarAccepts(grammar.grammar, name));
        // Untick it again, so the cap of 64 never decides.
        if (added !== null) {
          added.checked = false;
          fire(added, 'change', {});
        }
      }
    }
    // The server's grammar decided, not the panel's copy.
    const profile = collectByAttr(root, WEBHOOKS_PANEL_PROFILE_ATTR)[0]!;
    profile.value = 'github.webhook.v1';
    fire(profile, 'change', { target: profile });
    const custom = findByAttrValue(root, WEBHOOKS_PANEL_FIELD_ATTR, 'event-type-custom')!;
    custom.value = 'Push';
    findByAttrValue(root, WEBHOOKS_PANEL_ACTION_ATTR, 'event-type-add')!.click();
    expect(findByAttrValue(root, WEBHOOKS_PANEL_EVENT_TYPE_ATTR, 'Push')?.checked).toBe(true);
    expect((custom as FakeEl & { maxLength?: number }).maxLength).toBe(40);
    route.dispose();
  });

  it('D-201 Slice 10C — caps a webhook at 64 events, and offers no typed name or editor without a projected open catalog', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const closed: WebhookIngressView = readyWebhook();
    const legacy: WebhookIngressView = {
      ...readyWebhook(),
      ingress_id: 'whi_0123456789abcdef0123456789abcde2',
      display_name: 'Repository events',
      profile_id: 'github.webhook.v1',
      selected_event_types: ['issues'],
    };
    const route = bootstrapConnectionsRoute({
      ...webhookRouteCallers(root, doc, [closed, legacy], [
        projectedCapability('generic.raw-body-hmac-sha256.v1'),
        // A server older than 10C: no catalog projected.
        {
          profile_id: 'github.webhook.v1',
          registration_modes: WEBHOOK_PROFILE_REGISTRY['github.webhook.v1'].registration_modes,
          deduplication: WEBHOOK_PROFILE_REGISTRY['github.webhook.v1'].deduplication,
        },
        projectedCapability('lemonsqueezy.webhook.v1'),
      ]),
      webhooksUpdateCaller: vi.fn(),
    });
    await route.webhooksPanel()!.refresh();
    for (const ingress of [closed, legacy]) {
      const card = findByAttrValue(root, WEBHOOKS_PANEL_CARD_ATTR, ingress.ingress_id)!;
      expect(findByAttrValue(card, WEBHOOKS_PANEL_ACTION_ATTR, 'events-edit')).toBeNull();
    }
    collectByAttr(root, WEBHOOKS_PANEL_NEW_ATTR)[0]!.click();
    const profile = collectByAttr(root, WEBHOOKS_PANEL_PROFILE_ATTR)[0]!;
    profile.value = 'github.webhook.v1';
    fire(profile, 'change', { target: profile });
    // The known names still show; nothing can be typed the server cannot check.
    expect(findByAttrValue(root, WEBHOOKS_PANEL_EVENT_TYPE_ATTR, 'issues')).not.toBeNull();
    expect(findByAttrValue(root, WEBHOOKS_PANEL_FIELD_ATTR, 'event-type-custom')).toBeNull();

    profile.value = 'lemonsqueezy.webhook.v1';
    fire(profile, 'change', { target: profile });
    const custom = findByAttrValue(root, WEBHOOKS_PANEL_FIELD_ATTR, 'event-type-custom')!;
    const add = findByAttrValue(root, WEBHOOKS_PANEL_ACTION_ATTR, 'event-type-add')!;
    for (let i = 0; i < 64; i++) {
      custom.value = `future_event_${i}`;
      add.click();
    }
    expect(collectByAttr(root, WEBHOOKS_PANEL_EVENT_TYPE_ATTR)
      .filter((input) => input.checked)).toHaveLength(64);
    custom.value = 'future_event_64';
    add.click();
    expect(findByAttrValue(root, WEBHOOKS_PANEL_EVENT_TYPE_ATTR, 'future_event_64')).toBeNull();
    expect(treeText(root)).toContain('A webhook takes at most 64 events. Untick one first.');
    route.dispose();
  });

  it('D-201 Slice 10C — changes the events a webhook takes, keeps a name typed in before and refuses one its service never sends', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    let ingress: WebhookIngressView = {
      ...readyWebhook(),
      display_name: 'Repository events',
      profile_id: 'github.webhook.v1',
      configured_fields: ['webhook_secret'],
      // `Push` was taken before 10C; GitHub never sends it.
      selected_event_types: ['issues', 'merge_group', 'Push'],
    };
    const runUpdate = vi.fn(async (args: WebhookIngressUpdateRequest) => {
      ingress = { ...ingress, selected_event_types: [...args.patch.selected_event_types!] };
      return { ingress };
    });
    const route = bootstrapConnectionsRoute({
      ...webhookRouteCallers(root, doc, () => [ingress], [projectedCapability('github.webhook.v1')]),
      webhooksUpdateCaller: runUpdate,
    });
    await route.webhooksPanel()!.refresh();
    const card = () => findByAttrValue(root, WEBHOOKS_PANEL_CARD_ATTR, ingress.ingress_id)!;
    const edit = () => findByAttrValue(card(), WEBHOOKS_PANEL_ACTION_ATTR, 'events-edit')!;
    const editor = () => findByAttrValue(root, WEBHOOKS_PANEL_EVENTS_EDITOR_ATTR, ingress.ingress_id)!;
    const box = (eventType: string) =>
      findByAttrValue(editor(), WEBHOOKS_PANEL_EVENT_TYPE_ATTR, eventType)!;
    const ticked = () => collectByAttr(editor(), WEBHOOKS_PANEL_EVENT_TYPE_ATTR)
      .filter((input) => input.checked)
      .map((input) => input.getAttribute(WEBHOOKS_PANEL_EVENT_TYPE_ATTR));
    expect(edit().textContent).toBe('Change the events it takes');
    edit().click();
    // The selection as saved, names outside the known list kept.
    expect(ticked()).toEqual(['issues', 'merge_group', 'Push']);
    expect(treeText(editor())).toContain('Push (this service never sends an event named like this)');
    expect(treeText(editor())).not.toContain('merge_group (this service');
    expect(treeText(editor())).toContain('After you save, change the events at the service too');
    // A name the service never sends cannot be kept.
    findByAttrValue(editor(), WEBHOOKS_PANEL_ACTION_ATTR, 'events-save')!.click();
    await tick();
    expect(runUpdate).not.toHaveBeenCalled();
    expect(treeText(editor())).toContain('This service never sends an event named Push. Untick it to save.');
    box('Push').checked = false;
    fire(box('Push'), 'change', {});
    box('pull_request').checked = true;
    fire(box('pull_request'), 'change', {});
    // What is ticked and typed survives the list being read again.
    const custom = findByAttrValue(editor(), WEBHOOKS_PANEL_FIELD_ATTR, 'event-type-custom')!;
    custom.value = 'deployment_review';
    fire(custom, 'input', { target: custom });
    await route.webhooksPanel()!.refresh();
    expect(findByAttrValue(editor(), WEBHOOKS_PANEL_FIELD_ATTR, 'event-type-custom')!.value)
      .toBe('deployment_review');
    expect(ticked()).toEqual(['issues', 'pull_request', 'merge_group']);
    findByAttrValue(editor(), WEBHOOKS_PANEL_ACTION_ATTR, 'event-type-add')!.click();
    findByAttrValue(editor(), WEBHOOKS_PANEL_ACTION_ATTR, 'events-save')!.click();
    await tick();
    expect(runUpdate).toHaveBeenCalledWith({
      ingress_id: ingress.ingress_id,
      patch: {
        selected_event_types: ['issues', 'pull_request', 'merge_group', 'deployment_review'],
      },
    });
    expect(findByAttrValue(root, WEBHOOKS_PANEL_EVENTS_EDITOR_ATTR, ingress.ingress_id)).toBeNull();
    expect(findByAttrValue(card(), WEBHOOKS_PANEL_EVENTS_NOTICE_ATTR, ingress.ingress_id)?.textContent)
      .toBe('Saved. Change the events at the service too: it sends what is set up there.');
    // Saving what is already saved, or cancelling, sends nothing.
    edit().click();
    expect(ticked()).toEqual(['issues', 'pull_request', 'merge_group', 'deployment_review']);
    findByAttrValue(editor(), WEBHOOKS_PANEL_ACTION_ATTR, 'events-save')!.click();
    await tick();
    expect(findByAttrValue(root, WEBHOOKS_PANEL_EVENTS_EDITOR_ATTR, ingress.ingress_id)).toBeNull();
    edit().click();
    findByAttrValue(editor(), WEBHOOKS_PANEL_ACTION_ATTR, 'events-cancel')!.click();
    expect(findByAttrValue(root, WEBHOOKS_PANEL_EVENTS_EDITOR_ATTR, ingress.ingress_id)).toBeNull();
    expect(runUpdate).toHaveBeenCalledTimes(1);
    route.dispose();
  });

  it('D-201 Slice 10C — after a managed webhook changes its events, names the button that lines the address up again', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    let ingress: WebhookIngressView = {
      ...readyWebhook(),
      display_name: 'Repository events',
      profile_id: 'github.webhook.v1',
      registration_mode: 'managed_endpoint',
      paired_connection_id: 'github',
      remote_endpoint_id: '292430182',
      configured_fields: ['webhook_secret'],
      selected_event_types: ['issues'],
    };
    const runUpdate = vi.fn(async (args: WebhookIngressUpdateRequest) => {
      // The store marks a registered managed address drifted.
      ingress = {
        ...ingress,
        selected_event_types: [...args.patch.selected_event_types!],
        registration_state: 'drifted',
      };
      return { ingress };
    });
    const route = bootstrapConnectionsRoute({
      ...webhookRouteCallers(root, doc, () => [ingress], [projectedCapability('github.webhook.v1')]),
      webhooksUpdateCaller: runUpdate,
      webhooksRegistrationReconcileCaller: vi.fn(async () => ({ ingress })),
    });
    await route.webhooksPanel()!.refresh();
    const card = () => findByAttrValue(root, WEBHOOKS_PANEL_CARD_ATTR, ingress.ingress_id)!;
    findByAttrValue(card(), WEBHOOKS_PANEL_ACTION_ATTR, 'events-edit')!.click();
    const editor = findByAttrValue(root, WEBHOOKS_PANEL_EVENTS_EDITOR_ATTR, ingress.ingress_id)!;
    expect(treeText(editor)).toContain(
      'The service keeps sending the old events until the address is lined up again after you save.',
    );
    const pullRequest = findByAttrValue(editor, WEBHOOKS_PANEL_EVENT_TYPE_ATTR, 'pull_request')!;
    pullRequest.checked = true;
    fire(pullRequest, 'change', {});
    findByAttrValue(editor, WEBHOOKS_PANEL_ACTION_ATTR, 'events-save')!.click();
    await tick();
    expect(runUpdate).toHaveBeenCalledWith({
      ingress_id: ingress.ingress_id,
      patch: { selected_event_types: ['issues', 'pull_request'] },
    });
    expect(findByAttrValue(card(), WEBHOOKS_PANEL_EVENTS_NOTICE_ATTR, ingress.ingress_id)?.textContent)
      .toBe('Saved. Use Line the address up again, so the service sends these events.');
    expect(findByAttrValue(card(), WEBHOOKS_PANEL_ACTION_ATTR, 'registration-reconcile')?.textContent)
      .toBe('Line the address up again');
    route.dispose();
  });

  it('D-201 Slice 10G — a name typed but not added is added on Make a webhook and Save the events, or the save stops and says why', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    let ingress: WebhookIngressView = {
      ...readyWebhook(),
      display_name: 'Repository events',
      profile_id: 'github.webhook.v1',
      selected_event_types: ['issues'],
    };
    const runCreate = vi.fn(async () => ({ ingress }));
    const runUpdate = vi.fn(async (args: WebhookIngressUpdateRequest) => {
      ingress = { ...ingress, selected_event_types: [...args.patch.selected_event_types!] };
      return { ingress };
    });
    const route = bootstrapConnectionsRoute({
      ...webhookRouteCallers(root, doc, () => [ingress], [projectedCapability('github.webhook.v1')]),
      webhooksCreateCaller: runCreate,
      webhooksUpdateCaller: runUpdate,
    });
    await route.webhooksPanel()!.refresh();
    const card = () => findByAttrValue(root, WEBHOOKS_PANEL_CARD_ATTR, ingress.ingress_id)!;

    // Save the events with only a typed name: it is saved, not "unchanged".
    findByAttrValue(card(), WEBHOOKS_PANEL_ACTION_ATTR, 'events-edit')!.click();
    let editor = findByAttrValue(root, WEBHOOKS_PANEL_EVENTS_EDITOR_ATTR, ingress.ingress_id)!;
    findByAttrValue(editor, WEBHOOKS_PANEL_FIELD_ATTR, 'event-type-custom')!.value = 'merge_group';
    findByAttrValue(editor, WEBHOOKS_PANEL_ACTION_ATTR, 'events-save')!.click();
    await tick();
    expect(runUpdate).toHaveBeenCalledWith({
      ingress_id: ingress.ingress_id,
      patch: { selected_event_types: ['issues', 'merge_group'] },
    });

    // A typed name the grammar refuses stops the save, and says so.
    findByAttrValue(card(), WEBHOOKS_PANEL_ACTION_ATTR, 'events-edit')!.click();
    editor = findByAttrValue(root, WEBHOOKS_PANEL_EVENTS_EDITOR_ATTR, ingress.ingress_id)!;
    const custom = findByAttrValue(editor, WEBHOOKS_PANEL_FIELD_ATTR, 'event-type-custom')!;
    custom.value = 'Merge-Group';
    findByAttrValue(editor, WEBHOOKS_PANEL_ACTION_ATTR, 'events-save')!.click();
    await tick();
    expect(runUpdate).toHaveBeenCalledTimes(1);
    expect(treeText(editor)).toContain(
      "This service's events are not named like the one you typed. Lowercase letters, digits and _, starting with a letter, up to 128 long. Fix it or clear it to save.",
    );
    expect(custom.value).toBe('Merge-Group');
    findByAttrValue(editor, WEBHOOKS_PANEL_ACTION_ATTR, 'events-cancel')!.click();

    // Make a webhook sends a typed name too.
    collectByAttr(root, WEBHOOKS_PANEL_NEW_ATTR)[0]!.click();
    const profile = collectByAttr(root, WEBHOOKS_PANEL_PROFILE_ATTR)[0]!;
    profile.value = 'github.webhook.v1';
    fire(profile, 'change', { target: profile });
    const form = findByAttrValue(root, WEBHOOKS_PANEL_FORM_ATTR, 'create')!;
    findByAttrValue(form, WEBHOOKS_PANEL_EVENT_TYPE_ATTR, 'push')!.checked = true;
    findByAttrValue(form, WEBHOOKS_PANEL_FIELD_ATTR, 'event-type-custom')!.value = 'merge_group';
    findByAttrValue(form, WEBHOOKS_PANEL_FIELD_ATTR, 'display_name')!.value = 'Repository events';
    fire(form, 'submit', { preventDefault() {} });
    await tick();
    expect(runCreate).toHaveBeenCalledWith(expect.objectContaining({
      selected_event_types: ['push', 'merge_group'],
    }));
    route.dispose();
  });

  it('D-201 Slice 10G — the note after a managed save goes once the address is lined up', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    let ingress: WebhookIngressView = {
      ...readyWebhook(),
      display_name: 'Repository events',
      profile_id: 'github.webhook.v1',
      registration_mode: 'managed_endpoint',
      paired_connection_id: 'github',
      remote_endpoint_id: '292430182',
      configured_fields: ['webhook_secret'],
      selected_event_types: ['issues'],
    };
    const runUpdate = vi.fn(async (args: WebhookIngressUpdateRequest) => {
      ingress = {
        ...ingress,
        selected_event_types: [...args.patch.selected_event_types!],
        registration_state: 'drifted',
      };
      return { ingress };
    });
    const runReconcile = vi.fn(async () => {
      ingress = { ...ingress, registration_state: 'registered' };
      return { ingress };
    });
    const route = bootstrapConnectionsRoute({
      ...webhookRouteCallers(root, doc, () => [ingress], [projectedCapability('github.webhook.v1')]),
      webhooksUpdateCaller: runUpdate,
      webhooksRegistrationReconcileCaller: runReconcile,
    });
    await route.webhooksPanel()!.refresh();
    const card = () => findByAttrValue(root, WEBHOOKS_PANEL_CARD_ATTR, ingress.ingress_id)!;
    const note = () => findByAttrValue(card(), WEBHOOKS_PANEL_EVENTS_NOTICE_ATTR, ingress.ingress_id);
    findByAttrValue(card(), WEBHOOKS_PANEL_ACTION_ATTR, 'events-edit')!.click();
    const editor = findByAttrValue(root, WEBHOOKS_PANEL_EVENTS_EDITOR_ATTR, ingress.ingress_id)!;
    const pullRequest = findByAttrValue(editor, WEBHOOKS_PANEL_EVENT_TYPE_ATTR, 'pull_request')!;
    pullRequest.checked = true;
    fire(pullRequest, 'change', {});
    findByAttrValue(editor, WEBHOOKS_PANEL_ACTION_ATTR, 'events-save')!.click();
    await tick();
    expect(note()?.textContent).toBe('Saved. Use Line the address up again, so the service sends these events.');
    // A refresh while it is still drifted keeps it.
    await route.webhooksPanel()!.refresh();
    expect(note()).not.toBeNull();
    findByAttrValue(card(), WEBHOOKS_PANEL_ACTION_ATTR, 'registration-reconcile')!.click();
    await tick();
    expect(runReconcile).toHaveBeenCalledTimes(1);
    expect(note()).toBeNull();
    // Gone for good: drifting again later does not bring it back.
    ingress = { ...ingress, registration_state: 'drifted' };
    await route.webhooksPanel()!.refresh();
    expect(note()).toBeNull();
    route.dispose();
  });

  it('D-201 Slice 10G — a set-up the service refused for names it does not have says which, in plain words', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const ingress: WebhookIngressView = {
      ...readyWebhook(),
      display_name: 'Bot updates',
      profile_id: 'telegram.bot-webhook.v1',
      registration_mode: 'managed_endpoint',
      registration_state: 'managed_pending',
      paired_connection_id: 'telegram-bot',
      remote_endpoint_id: null,
      selected_event_types: ['message', 'edited_mesage'],
    };
    const runReconcile = vi.fn(async () => {
      throw Object.assign(
        new Error('webhook.ingress.registration.reconcile: Telegram does not know the update name edited_mesage'),
        {
          code: 'webhook_registration_event_types_unknown',
          details: { event_types: ['edited_mesage', 'with space', 7] },
        },
      );
    });
    const route = bootstrapConnectionsRoute({
      ...webhookRouteCallers(root, doc, [ingress], [projectedCapability('telegram.bot-webhook.v1')]),
      webhooksRegistrationReconcileCaller: runReconcile,
    });
    await route.webhooksPanel()!.refresh();
    findByAttrValue(root, WEBHOOKS_PANEL_ACTION_ATTR, 'registration-reconcile')!.click();
    await tick();
    expect(runReconcile).toHaveBeenCalledTimes(1);
    expect(treeText(root)).toContain(
      'The service does not have an event named edited_mesage, so it did not set it up. Check the spelling, or untick it, then line the address up again.',
    );
    expect(treeText(root)).not.toContain('webhook.ingress.registration.reconcile');
    expect(treeText(root)).not.toContain('with space');
    route.dispose();
  });

  // D-201 Slice 10AL (10AI finding 20) — it said Recued could not remove them
  // "when you changed the connection", which a change that failed never did.
  it('D-201 Slice 10AH — the card says when earlier setups of this webhook are still at the service', async () => {
    for (const [count, words] of [
      [1, 'Left at the other service An earlier setup of this webhook is still at the other service, and Recued keeps '
        + 'trying to remove it. If it cannot be removed for a week, Recued stops and says so here.'],
      [2, 'Left at the other service 2 earlier setups of this webhook are still at the other service, and Recued keeps '
        + 'trying to remove them. If they cannot be removed for a week, Recued stops and says so here.'],
      [undefined, null],
    ] as const) {
      const doc = makeFakeDocument();
      const root = doc.createElement('div');
      const ingress: WebhookIngressView = {
        ...readyWebhook(),
        ...(count !== undefined ? { stray_endpoints: count } : {}),
      };
      const route = bootstrapConnectionsRoute(webhookRouteCallers(root, doc, [ingress], TEST_WEBHOOK_PROFILE_CAPABILITIES));
      await route.webhooksPanel()!.refresh();
      if (words === null) expect(treeText(root)).not.toContain('Left at the other service');
      else expect(treeText(root)).toContain(words);
      route.dispose();
    }
  });

  it('D-201 Slice 10K — the card names the events the service did not have, long after the refusal', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const ingress: WebhookIngressView = {
      ...readyWebhook(),
      profile_id: 'telegram.bot-webhook.v1',
      registration_mode: 'managed_endpoint',
      registration_state: 'drifted',
      paired_connection_id: 'telegram-bot',
      selected_event_types: ['message', 'edited_mesage'],
      health: {
        ...readyWebhook().health,
        last_error_code: 'managed_registration_event_types_unknown',
        last_error_event_types: ['edited_mesage', 'with space'],
      },
    };
    const route = bootstrapConnectionsRoute(
      webhookRouteCallers(root, doc, [ingress], [projectedCapability('telegram.bot-webhook.v1')]),
    );
    await route.webhooksPanel()!.refresh();
    // 10H finding 17: it read "managed_registration_unconfirmed", no names.
    expect(treeText(root)).toContain(
      'Last thing that went wrong The service does not have an event named edited_mesage, so it did not set it up.',
    );
    expect(treeText(root)).not.toContain('managed_registration_event_types_unknown');
    expect(treeText(root)).not.toContain('with space');
    route.dispose();
  });

  it('D-201 Slice 10T — the card says which names the service never lists, apart from those it does not have (10Q finding 19)', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const ingress: WebhookIngressView = {
      ...readyWebhook(),
      profile_id: 'telegram.bot-webhook.v1',
      registration_mode: 'managed_endpoint',
      registration_state: 'drifted',
      paired_connection_id: 'telegram-bot',
      selected_event_types: ['message', 'custom_event', 'edited_mesage'],
      health: {
        ...readyWebhook().health,
        last_error_code: 'managed_registration_event_types_unknown',
        last_error_event_types: ['custom_event', 'edited_mesage'],
      },
    };
    const route = bootstrapConnectionsRoute(
      webhookRouteCallers(root, doc, [ingress], [projectedCapability('telegram.bot-webhook.v1')]),
    );
    await route.webhooksPanel()!.refresh();
    // It said the service "does not have" custom_event, and to check the spelling.
    expect(treeText(root)).toContain(
      'Last thing that went wrong The service does not have an event named edited_mesage, so it did not set it up. '
        + 'The service never lists the event custom_event, so a webhook set up with it could never be confirmed.',
    );
    route.dispose();

    // The server's catalog says which, not the panel's copy: a server older
    // than 10T names none, and the card words them as that server would.
    const telegram = WEBHOOK_PROFILE_REGISTRY['telegram.bot-webhook.v1'].event_types;
    if (telegram.kind !== 'open') throw new Error('Telegram catalog is open');
    const olderDoc = makeFakeDocument();
    const olderRoot = olderDoc.createElement('div');
    const older = bootstrapConnectionsRoute(webhookRouteCallers(olderRoot, olderDoc, [ingress], [
      projectedCapability('telegram.bot-webhook.v1', {
        kind: 'open', known_values: telegram.known_values, grammar: telegram.grammar,
      }),
    ]));
    await older.webhooksPanel()!.refresh();
    expect(treeText(olderRoot)).toContain(
      'Last thing that went wrong The service does not have events named custom_event, edited_mesage, so it did not set them up.',
    );
    expect(treeText(olderRoot)).not.toContain('never lists');
    older.dispose();

    // A list that is not names makes the catalog malformed, as any other field
    // would (10C): the panel goes by its own copy, which names them.
    const malformedDoc = makeFakeDocument();
    const malformedRoot = malformedDoc.createElement('div');
    const malformed = bootstrapConnectionsRoute(webhookRouteCallers(malformedRoot, malformedDoc, [ingress], [
      projectedCapability('telegram.bot-webhook.v1', {
        kind: 'open', known_values: telegram.known_values, grammar: telegram.grammar, never_listed: [7],
      } as unknown as typeof telegram),
    ]));
    await malformed.webhooksPanel()!.refresh();
    expect(treeText(malformedRoot)).toContain(
      'The service never lists the event custom_event, so a webhook set up with it could never be confirmed.',
    );
    malformed.dispose();
  });

  it('D-201 Slice 10T — a refusal for a name the service never lists says to untick it, not to check its spelling', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const ingress: WebhookIngressView = {
      ...readyWebhook(),
      display_name: 'Bot updates',
      profile_id: 'telegram.bot-webhook.v1',
      registration_mode: 'managed_endpoint',
      registration_state: 'managed_pending',
      paired_connection_id: 'telegram-bot',
      remote_endpoint_id: null,
      selected_event_types: ['message', 'custom_query'],
    };
    const runReconcile = vi.fn(async () => {
      throw Object.assign(
        new Error('webhook.ingress.registration.reconcile: Telegram never lists the update name custom_query'),
        {
          code: 'webhook_registration_event_types_unknown',
          details: { event_types: ['custom_query'], never_listed: ['custom_query'] },
        },
      );
    });
    const route = bootstrapConnectionsRoute({
      ...webhookRouteCallers(root, doc, [ingress], [projectedCapability('telegram.bot-webhook.v1')]),
      webhooksRegistrationReconcileCaller: runReconcile,
    });
    await route.webhooksPanel()!.refresh();
    findByAttrValue(root, WEBHOOKS_PANEL_ACTION_ATTR, 'registration-reconcile')!.click();
    await tick();
    expect(treeText(root)).toContain(
      'The service never lists the event custom_query, so a webhook set up with it could never be confirmed. '
        + 'Untick it, then line the address up again.',
    );
    expect(treeText(root)).not.toContain('Check the spelling');
    route.dispose();
  });

  it('D-201 Slice 10O — says the service may now send every kind of event when it could not be put back', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const ingress: WebhookIngressView = {
      ...readyWebhook(),
      profile_id: 'telegram.bot-webhook.v1',
      registration_mode: 'managed_endpoint',
      registration_state: 'drifted',
      paired_connection_id: 'telegram-bot',
      selected_event_types: ['mesage'],
      health: {
        ...readyWebhook().health,
        last_error_code: 'managed_registration_event_types_unrestored',
        last_error_event_types: ['mesage'],
      },
    };
    const runReconcile = vi.fn(async () => {
      throw Object.assign(
        new Error('webhook.ingress.registration.reconcile: Telegram does not know the update name mesage'),
        {
          code: 'webhook_registration_event_types_unknown',
          details: { event_types: ['mesage'], left_on_default: true },
        },
      );
    });
    const route = bootstrapConnectionsRoute({
      ...webhookRouteCallers(root, doc, [ingress], [projectedCapability('telegram.bot-webhook.v1')]),
      webhooksRegistrationReconcileCaller: runReconcile,
    });
    await route.webhooksPanel()!.refresh();
    // The stored code, long after: it read as plain names before 10O.
    expect(treeText(root)).toContain(
      'Last thing that went wrong The service does not have an event named mesage, so it did not set it up. '
        + 'It could not be put back to the events it had, so it may now send every kind of event.',
    );
    expect(treeText(root)).not.toContain('managed_registration_event_types_unrestored');
    // And at once, beside the fix.
    findByAttrValue(root, WEBHOOKS_PANEL_ACTION_ATTR, 'registration-reconcile')!.click();
    await tick();
    expect(treeText(root)).toContain(
      'The service does not have an event named mesage, so it did not set it up. '
        + 'It could not be put back to the events it had, so it may now send every kind of event. '
        + 'Check the spelling, or untick it, then line the address up again.',
    );
    route.dispose();
  });

  // D-201 Slice 10Z (10V finding 25) — a bot already on its default: nothing
  // was put back, so it is not said to be one that could not be.
  it('D-201 Slice 10Z — says the service was on its default set already, not that it could not be put back', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const ingress: WebhookIngressView = {
      ...readyWebhook(),
      profile_id: 'telegram.bot-webhook.v1',
      registration_mode: 'managed_endpoint',
      registration_state: 'drifted',
      paired_connection_id: 'telegram-bot',
      selected_event_types: ['mesage'],
      health: {
        ...readyWebhook().health,
        last_error_code: 'managed_registration_event_types_on_default',
        last_error_event_types: ['mesage'],
      },
    };
    const runReconcile = vi.fn(async () => {
      throw Object.assign(
        new Error('webhook.ingress.registration.reconcile: Telegram does not know the update name mesage'),
        {
          code: 'webhook_registration_event_types_unknown',
          details: { event_types: ['mesage'], left_on_default: true, was_on_default: true },
        },
      );
    });
    const route = bootstrapConnectionsRoute({
      ...webhookRouteCallers(root, doc, [ingress], [projectedCapability('telegram.bot-webhook.v1')]),
      webhooksRegistrationReconcileCaller: runReconcile,
    });
    await route.webhooksPanel()!.refresh();
    expect(treeText(root)).toContain(
      'Last thing that went wrong The service does not have an event named mesage, so it did not set it up. '
        + 'It was on its default set of events already, so it may send every kind of event.',
    );
    expect(treeText(root)).not.toContain('could not be put back');
    expect(treeText(root)).not.toContain('managed_registration_event_types_on_default');
    findByAttrValue(root, WEBHOOKS_PANEL_ACTION_ATTR, 'registration-reconcile')!.click();
    await tick();
    expect(treeText(root)).toContain(
      'The service does not have an event named mesage, so it did not set it up. '
        + 'It was on its default set of events already, so it may send every kind of event. '
        + 'Check the spelling, or untick it, then line the address up again.',
    );
    expect(treeText(root)).not.toContain('could not be put back');
    route.dispose();
  });

  it("D-201 Slice 10K — Telegram's two reserved names are refused as such, not by a rule they fit", async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const route = bootstrapConnectionsRoute(
      webhookRouteCallers(root, doc, [], [projectedCapability('telegram.bot-webhook.v1')]),
    );
    await route.webhooksPanel()!.refresh();
    collectByAttr(root, WEBHOOKS_PANEL_NEW_ATTR)[0]!.click();
    const profile = collectByAttr(root, WEBHOOKS_PANEL_PROFILE_ATTR)[0]!;
    profile.value = 'telegram.bot-webhook.v1';
    fire(profile, 'change', { target: profile });
    expect(treeText(root)).toContain(
      'Lowercase letters, digits and _, starting with a letter, up to 128 long, but not constructor or prototype.',
    );
    const custom = findByAttrValue(root, WEBHOOKS_PANEL_FIELD_ATTR, 'event-type-custom')!;
    const add = findByAttrValue(root, WEBHOOKS_PANEL_ACTION_ATTR, 'event-type-add')!;
    for (const reserved of ['constructor', 'prototype']) {
      custom.value = reserved;
      add.click();
      // 10H finding 19: it said "not named like that", then the rule it fits.
      expect(treeText(root)).toContain(`This service cannot take ${reserved} as an event name.`);
      expect(findByAttrValue(root, WEBHOOKS_PANEL_EVENT_TYPE_ATTR, reserved)).toBeNull();
    }
    // Any other refused name still gets the rule.
    custom.value = 'Message';
    add.click();
    expect(treeText(root)).toContain("This service's events are not named like that.");
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
