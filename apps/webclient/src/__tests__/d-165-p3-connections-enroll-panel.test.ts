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
import type { FoundationalOAuthEnv } from '../connections/foundational-oauth-popup.js';

import {
  type ConnectionsCompleteVendorOAuthCaller,
  mountConnectionsEnrollPanel,
  type ConnectionsEnrollListCaller,
  type ConnectionsEnrollCaller,
  type ConnectionsRotateCredentialsCaller,
  type ConnectionsCredentialRotationStatusCaller,
  type ConnectionsCredentialRotationActivityCaller,
  type ConnectionsAcknowledgeCredentialRotationSafeStopCaller,
  type ConnectionsCredentialRotationServerUpdateTriageCaller,
  type ConnectionsUpdateCaller,
  type ConnectionsDeleteCaller,
  type ConnectionsProbeCaller,
  type ConnectionsMcpPackPreviewCaller,
  type ConnectionsMcpPackCommitCaller,
  type ConnectionsEngagementHealthCaller,
  type ConnectionsReprobeEngagementCapabilitiesCaller,
  type ConnectionsMailListCaller,
  type ConnectionsStartVendorOAuthCaller,
  type ConnectionsTakeVendorOAuthResultCaller,
  type ConnectionsSuggestSetupCaller,
  type CredentialRotationServerUpdateTarget,
  type VendorOAuthBrowserEnv,
  type VendorOAuthPopupHandle,
} from '../settings/connections-enroll-panel.js';
import type { BroadcastSubscriber } from '../realtime/subscriber.js';
import {
  MAIL_SEND_CAPABLE_INSTANCES_SOURCE,
  MCP_PACK_INSTALL_SCOPE_HOST_ATTR,
  type ConnectionsPostSafeStopProfileHandoff,
} from '@recued/ui-shared';
import {
  CREDENTIAL_ROTATION_CONTINUITY_SESSION_KEY,
  createCredentialRotationContinuityStore,
  type CredentialRotationContinuityStore,
  type CredentialRotationContinuityStorage,
} from '../connections/credential-rotation-continuity.js';
import type {
  CredentialRotationOwnershipLease,
  CredentialRotationTabConvergence,
  ServerUpdateTabProgress,
} from '../connections/credential-rotation-tab-convergence.js';
import {
  CREDENTIAL_ROTATION_SERVER_UPDATE_CONTINUITY_SESSION_KEY,
  createCredentialRotationServerUpdateContinuity,
  type CredentialRotationServerUpdateContinuity,
} from '../connections/credential-rotation-server-update-continuity.js';
import {
  PROVIDER_SETUP_CONTINUITY_SESSION_KEY,
  createProviderSetupContinuityStore,
  type ProviderSetupContinuityStore,
} from '../connections/provider-setup-continuity.js';
import {
  SALESFORCE_OAUTH_TOKEN_URL_SANDBOX,
  SALESFORCE_OAUTH_TOKEN_URL_PRODUCTION,
  OAUTH_CLOUD_CALLBACK_URL,
  RpcError,
  MAX_HEADER_AUTH_ENTRIES,
  getVendorProvider,
  type ConnectionHealth,
  type ConnectionCredentialPostSafeStopVerificationSummary,
  type ConnectionCredentialRejectionCorrection,
  type ConnectionCredentialRotationActivity,
  type ConnectionCredentialRotationOutcome,
  type ConnectionCredentialRotationSafeStopAcknowledgement,
  type ConnectionView,
  type EngagementHealthResponse,
  type PackListEntry,
  type ReprobeEngagementCapabilitiesResponse,
} from '@recued/contracts';

// ════════════════════════════════════════════════════════════════
// Lightweight string-innerHTML fake host (unit tests)
// ════════════════════════════════════════════════════════════════

interface FakeSubmitButton {
  attrs: Map<string, string>;
  textContent: string;
  setAttribute(k: string, value?: string): void;
  removeAttribute(k: string): void;
  hasAttribute(k: string): boolean;
  getAttribute(k: string): string | null;
}

const SUBMIT_SELECTOR = '[data-action="connections-submit-form"]';
const SAFE_STOP_CHECK_SAVED_SELECTOR =
  '[data-action="connections-check-saved-after-safe-stop"]';
const FORM_VALIDATION_PANEL_SELECTOR = '[data-connection-form-validation]';
const FORM_VALIDATION_TITLE_SELECTOR =
  '[data-connection-form-validation-title]';
const FORM_VALIDATION_MESSAGE_SELECTOR =
  '[data-connection-form-validation-message]';
const FORM_VALIDATION_ACTION_WRAP_SELECTOR =
  '[data-connection-form-validation-action]';
const FORM_VALIDATION_ACTION_SELECTOR =
  '[data-action="connections-focus-first-invalid"]';
const CREDENTIAL_CORRECTION_PANEL_SELECTOR =
  '[data-connection-credential-correction]';
const CREDENTIAL_ADMIN_HANDOFF_SUMMARY_SELECTOR =
  '[data-credential-admin-handoff-summary]';
const CREDENTIAL_ADMIN_HANDOFF_STATUS_SELECTOR =
  '[data-credential-admin-handoff-status]';
const GUIDE_REVIEW_SELECTOR = '[data-action="connections-guide-review"]';
const GUIDE_URL_SELECTOR = '[data-connection-guide-url]';
const GUIDE_GENERATE_SELECTOR = '[data-action="connections-guide-generate"]';
const GUIDE_PANEL_SELECTOR = '[data-connection-guide-panel]';
const GUIDE_OPEN_SELECTOR = '[data-action="connections-guide-open"]';
const OAUTH_AUTHORIZE_SELECTOR = '[data-action="connections-authorize-vendor"]';
const FRESH_START_SELECTOR =
  '[data-action="connections-start-fresh-credential-rotation"]';
const FRESH_START_CHECKING_SELECTOR =
  '[data-connection-credential-recovery="restart_checking"]';
const FRESH_START_TRIAGING_SELECTOR =
  '[data-connection-credential-recovery="restart_triaging"]';
const SERVER_UPDATE_REVIEW_SELECTOR =
  '[data-action="connections-review-server-update"]';

const fieldSelector = (key: string): string => `[data-conn-field="${key}"]`;

const makeFakeHost = () => {
  let html = '';
  let renderCount = 0;
  let focusedSelector: string | null = null;
  let activeElement: object | null = null;
  const listeners = new Map<string, Array<(ev: unknown) => void>>();
  const makeFakeElement = (): FakeSubmitButton => ({
    attrs: new Map<string, string>(),
    textContent: '',
    setAttribute(k, value = '') {
      this.attrs.set(k, value);
    },
    removeAttribute(k) {
      this.attrs.delete(k);
    },
    hasAttribute(k) {
      return this.attrs.has(k);
    },
    getAttribute(k) {
      return this.attrs.get(k) ?? null;
    },
  });
  const submitBtn = {
    ...makeFakeElement(),
    focus() {
      focusedSelector = SUBMIT_SELECTOR;
      activeElement = submitBtn;
    },
  };
  const guideReviewBtn = makeFakeElement();
  const validationPanel = makeFakeElement();
  const validationTitle = makeFakeElement();
  const validationMessage = makeFakeElement();
  const validationActionWrap = makeFakeElement();
  const validationAction = makeFakeElement();
  const credentialAdminHandoffStatus = makeFakeElement();
  const focusTargets = new Map<string, {
    focus(): void;
    contains(candidate: object): boolean;
    setAttribute(key: string, value: string): void;
  }>();
  const ensureFocusTarget = (selector: string) => {
    const existing = focusTargets.get(selector);
    if (existing !== undefined) return existing;
    const target = {
      focus: () => {
        focusedSelector = selector;
        activeElement = target;
      },
      contains: (candidate: object) => candidate === target,
      setAttribute: () => {},
    };
    focusTargets.set(selector, target);
    return target;
  };
  for (const selector of [
    GUIDE_URL_SELECTOR,
    GUIDE_GENERATE_SELECTOR,
    GUIDE_PANEL_SELECTOR,
    GUIDE_OPEN_SELECTOR,
    OAUTH_AUTHORIZE_SELECTOR,
    FRESH_START_SELECTOR,
    FRESH_START_CHECKING_SELECTOR,
    FRESH_START_TRIAGING_SELECTOR,
    SERVER_UPDATE_REVIEW_SELECTOR,
    SAFE_STOP_CHECK_SAVED_SELECTOR,
    CREDENTIAL_CORRECTION_PANEL_SELECTOR,
    CREDENTIAL_ADMIN_HANDOFF_SUMMARY_SELECTOR,
  ]) {
    ensureFocusTarget(selector);
  }
  const host = {
    ownerDocument: {
      get activeElement() {
        return activeElement;
      },
    },
    get innerHTML() {
      return html;
    },
    set innerHTML(v: string) {
      html = v;
      renderCount += 1;
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
      if (sel === SUBMIT_SELECTOR) return submitBtn;
      if (sel === FORM_VALIDATION_PANEL_SELECTOR) return validationPanel;
      if (sel === FORM_VALIDATION_TITLE_SELECTOR) return validationTitle;
      if (sel === FORM_VALIDATION_MESSAGE_SELECTOR) return validationMessage;
      if (sel === FORM_VALIDATION_ACTION_WRAP_SELECTOR) {
        return validationActionWrap;
      }
      if (sel === FORM_VALIDATION_ACTION_SELECTOR) return validationAction;
      if (sel === CREDENTIAL_ADMIN_HANDOFF_STATUS_SELECTOR) {
        return credentialAdminHandoffStatus;
      }
      if (sel === GUIDE_REVIEW_SELECTOR) return guideReviewBtn;
      if (sel.startsWith('[data-conn-field="')) return ensureFocusTarget(sel);
      if (sel.startsWith('[data-field-key="')) return ensureFocusTarget(sel);
      if (sel.startsWith('.connections-field-row[data-field-key="')) {
        return ensureFocusTarget(sel);
      }
      return focusTargets.get(sel) ?? null;
    },
  };
  const fire = (type: string, ev: unknown): void => {
    for (const fn of [...(listeners.get(type) ?? [])]) fn(ev);
  };
  /** Simulate a delegated action click — `data` carries `action` + any
   *  `data-*` keys (camelCased: `kind`, `name`, `vendor`, `subtype`). */
  const click = (data: Record<string, string>) => {
    const attrs = new Map<string, string>();
    const el = {
      dataset: data,
      textContent: '',
      closest: () => el,
      setAttribute: (key: string, value: string) => attrs.set(key, value),
      removeAttribute: (key: string) => attrs.delete(key),
      getAttribute: (key: string) => attrs.get(key) ?? null,
    };
    fire('click', { target: el, preventDefault() {} });
    return el;
  };
  /** Simulate a field edit on a `data-conn-field` control. SELECT fires
   *  `change` (visibility re-render); everything else fires `input`. */
  const field = (key: string, value: string, tagName = 'INPUT'): void => {
    const el = { dataset: { connField: key }, value, tagName, closest: () => el };
    const type = tagName === 'SELECT' ? 'change' : 'input';
    fire(type, { target: el, type });
  };
  const guideUrl = (value: string): void => {
    const el = {
      dataset: { connectionGuideUrl: '' },
      value,
      tagName: 'INPUT',
      closest: (selector: string) =>
        selector === '[data-connection-guide-url]' ? el : null,
    };
    fire('input', { target: el, type: 'input' });
  };
  return {
    host: host as unknown as HTMLElement,
    getHtml: () => html,
    getRenderCount: () => renderCount,
    submitBtn,
    guideReviewBtn,
    validationPanel,
    validationTitle,
    validationMessage,
    validationActionWrap,
    validationAction,
    credentialAdminHandoffStatus,
    getFocusedSelector: () => focusedSelector,
    moveFocusOutsideGuide: () => {
      focusedSelector = 'outside-guide';
      activeElement = {};
    },
    listenerCount: () =>
      [...listeners.values()].reduce((n, l) => n + l.length, 0),
    click,
    field,
    guideUrl,
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

const rotationContinuity = (
  storageOverride?: CredentialRotationContinuityStorage | null,
) => {
  const values = new Map<string, string>();
  const storage: CredentialRotationContinuityStorage | null =
    storageOverride === undefined
      ? {
          getItem: (key) => values.get(key) ?? null,
          setItem: (key, value) => { values.set(key, value); },
          removeItem: (key) => { values.delete(key); },
        }
      : storageOverride;
  return {
    values,
    storage,
    store: createCredentialRotationContinuityStore({
      storage,
      scopeId: 'profile-panel-test',
      now: () => FIXED_NOW,
    }),
  };
};

const rotationTabs = (options: {
  supportsOwnershipLeases?: boolean;
  claim?: () => Promise<CredentialRotationOwnershipLease | null>;
} = {}) => {
  const listeners = new Set<Parameters<CredentialRotationTabConvergence['subscribe']>[0]>();
  const notifyCredentialRotated = vi.fn();
  const notifyServerCapabilityResolved = vi.fn();
  const notifyCredentialRotationStarted = vi.fn();
  const notifyCredentialRotationReleased = vi.fn();
  const notifyCredentialRotationSafeStopped = vi.fn();
  const notifyCredentialRotationSafeStopResolved = vi.fn();
  const notifyPostSafeStopVerificationChanged = vi.fn();
  let serverUpdateProgress: ServerUpdateTabProgress | null = null;
  const claimCredentialRotationOwnership = vi.fn(
    options.claim ?? (async () => null),
  );
  const convergence: CredentialRotationTabConvergence = {
    supportsOwnershipLeases: options.supportsOwnershipLeases ?? false,
    claimCredentialRotationOwnership,
    notifyCredentialRotationStarted,
    notifyCredentialRotationReleased,
    notifyCredentialRotationSafeStopped,
    notifyCredentialRotationSafeStopResolved,
    notifyPostSafeStopVerificationChanged,
    notifyCredentialRotated,
    notifyServerCapabilityResolved,
    supportsServerUpdateOwnership: false,
    claimServerUpdateOwnership: vi.fn(async () => null),
    readServerUpdateProgress: vi.fn(() =>
      serverUpdateProgress === null ? null : { ...serverUpdateProgress }),
    notifyServerUpdateProgress: vi.fn((progress) => {
      serverUpdateProgress = {
        ...progress,
        startedAt: serverUpdateProgress?.startedAt ?? FIXED_NOW,
      };
    }),
    clearServerUpdateProgress: vi.fn(async (expected) => {
      if (
        serverUpdateProgress === null
        || serverUpdateProgress.phase !== expected.phase
        || serverUpdateProgress.operation !== expected.operation
        || serverUpdateProgress.startedAt !== expected.startedAt
      ) return false;
      serverUpdateProgress = null;
      return true;
    }),
    reconcileServerUpdateProgress: vi.fn(async () => null),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: vi.fn(),
  };
  return {
    convergence,
    claimCredentialRotationOwnership,
    notifyCredentialRotationStarted,
    notifyCredentialRotationReleased,
    notifyCredentialRotationSafeStopped,
    notifyCredentialRotationSafeStopResolved,
    notifyPostSafeStopVerificationChanged,
    notifyCredentialRotated,
    notifyServerCapabilityResolved,
    emit: (hint: Parameters<Parameters<CredentialRotationTabConvergence['subscribe']>[0]>[0]) => {
      if (hint.type === 'server_update_progress') {
        serverUpdateProgress = hint.progress === null
          ? null
          : { ...hint.progress };
      }
      for (const listener of [...listeners]) listener(hint);
    },
    listenerCount: () => listeners.size,
  };
};

const rotationOwnershipLease = () => ({
  release: vi.fn(),
}) satisfies CredentialRotationOwnershipLease;

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
const SAFE_STOP_TOKEN = 'a'.repeat(64);

const safeStopCorrection = (
  authType: 'bearer' | 'basic' = 'bearer',
  endpointFieldKeys: ReadonlyArray<'config.base_url' | 'config.endpoint'> = [
    'config.base_url',
    'config.endpoint',
  ],
): ConnectionCredentialRejectionCorrection => ({
  auth_type: authType,
  field_keys: authType === 'basic'
    ? ['auth.username', 'auth.password']
    : ['auth.token'],
  triage: {
    reason: 'repeated_auth_rejection',
    stage: 'provider_probe',
    endpoint_field_keys: [...endpointFieldKeys],
    resolution: 'regenerate_credential_or_contact_admin',
  },
});

const safeStopActivity = (
  authType: 'bearer' | 'basic' = 'bearer',
  endpointFieldKeys?: ReadonlyArray<'config.base_url' | 'config.endpoint'>,
  acknowledgementToken = SAFE_STOP_TOKEN,
): { activity: ConnectionCredentialRotationActivity } => ({
  activity: {
    status: 'idle',
    safe_stop: {
      finished_at: FIXED_NOW,
      correction: safeStopCorrection(authType, endpointFieldKeys),
      acknowledgement_token: acknowledgementToken,
    },
  },
});

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
  runRotateCredentials?: ConnectionsRotateCredentialsCaller | null;
  runCredentialRotationStatus?: ConnectionsCredentialRotationStatusCaller;
  runCredentialRotationActivity?: ConnectionsCredentialRotationActivityCaller;
  runAcknowledgeCredentialRotationSafeStop?:
    ConnectionsAcknowledgeCredentialRotationSafeStopCaller | null;
  runCredentialRotationServerUpdateTriage?:
    ConnectionsCredentialRotationServerUpdateTriageCaller;
  credentialRotationContinuity?: CredentialRotationContinuityStore | null;
  credentialRotationTabConvergence?: CredentialRotationTabConvergence;
  credentialRotationServerUpdateContinuity?: Pick<
    CredentialRotationServerUpdateContinuity,
    'beginExactReturn' | 'read' | 'resumeResolvedRetry' | 'subscribe'
  >;
  onCredentialRotationCleanEditorReady?: (
    target: CredentialRotationServerUpdateTarget,
  ) => void;
  onCredentialRotationCleanEditorChanged?: (
    target: CredentialRotationServerUpdateTarget,
  ) => void;
  onReconnect?: (listener: () => void) => () => void;
  onOpenCredentialRotationServerUpdateGuide?: (
    target: CredentialRotationServerUpdateTarget,
  ) => void;
  initialCredentialRotationServerUpdateRetry?:
    CredentialRotationServerUpdateTarget;
  initialPostSafeStopRecovery?: CredentialRotationServerUpdateTarget;
  postSafeStopProfileLabel?: string;
  postSafeStopProfileHandoff?: ConnectionsPostSafeStopProfileHandoff;
  onOpenPostSafeStopServerProfiles?: () => void;
  onPostSafeStopProfileHandoffSettled?: () => void;
  credentialRotationAttemptId?: () => string;
  runDelete?: ConnectionsDeleteCaller;
  runProbe?: ConnectionsProbeCaller;
  runMcpPackPreview?: ConnectionsMcpPackPreviewCaller;
  runMcpPackCommit?: ConnectionsMcpPackCommitCaller;
  runEngagementHealth?: ConnectionsEngagementHealthCaller;
  runReprobeEngagementCapabilities?: ConnectionsReprobeEngagementCapabilitiesCaller;
  runMailList?: ConnectionsMailListCaller;
  runSuggestSetup?: ConnectionsSuggestSetupCaller;
  providerSetupContinuity?: ProviderSetupContinuityStore;
  confirmDiscardDraft?: (prompt: string) => boolean;
  copyText?: (value: string) => Promise<void>;
  runPacksList?: () => Promise<{ packs: ReadonlyArray<PackListEntry> }>;
  oauth?: {
    runComplete?: ConnectionsCompleteVendorOAuthCaller;
    foundationalEnv?: FoundationalOAuthEnv;
    env?: VendorOAuthBrowserEnv;
    subscribe?: BroadcastSubscriber['on'];
    runStart?: ConnectionsStartVendorOAuthCaller;
    runTake?: ConnectionsTakeVendorOAuthResultCaller;
  };
}

const mountPanel = (opts: MountOpts = {}) => {
  const fake = makeFakeHost();
  const credentialRotationContinuity = opts.credentialRotationContinuity === null
    ? undefined
    : opts.credentialRotationContinuity ?? rotationContinuity().store;

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
        // Enrollment's stored baseline is deliberately not a live check. The
        // submit controller must call runProbe to turn this into `ok`.
        probe: { status: 'unknown' } as ConnectionHealth,
      })),
  );
  const runUpdate = vi.fn<ConnectionsUpdateCaller>();
  runUpdate.mockImplementation(
    opts.runUpdate
      ?? (async (args) => ({
        connection: connection(args.name, { kind: args.kind }),
      })),
  );
  const runRotateCredentials = vi.fn<ConnectionsRotateCredentialsCaller>();
  runRotateCredentials.mockImplementation(
    opts.runRotateCredentials
      ?? (async (args) => ({
        connection: connection(args.name, { kind: args.kind }),
        verification: {
          status: 'verified',
          verified_at: FIXED_NOW,
          auth_type: args.patch.auth.type,
        },
      })),
  );
  const runCredentialRotationStatus =
    vi.fn<ConnectionsCredentialRotationStatusCaller>();
  if (opts.runCredentialRotationStatus !== undefined) {
    runCredentialRotationStatus.mockImplementation(
      opts.runCredentialRotationStatus,
    );
  }
  const runCredentialRotationActivity =
    vi.fn<ConnectionsCredentialRotationActivityCaller>();
  if (opts.runCredentialRotationActivity !== undefined) {
    runCredentialRotationActivity.mockImplementation(
      opts.runCredentialRotationActivity,
    );
  }
  const runAcknowledgeCredentialRotationSafeStop =
    vi.fn<ConnectionsAcknowledgeCredentialRotationSafeStopCaller>();
  runAcknowledgeCredentialRotationSafeStop.mockImplementation(
    opts.runAcknowledgeCredentialRotationSafeStop
      ?? (async () => ({
        acknowledgement: {
          status: 'acknowledged',
          acknowledged_at: FIXED_NOW + 1,
        },
      })),
  );
  const runCredentialRotationServerUpdateTriage =
    vi.fn<ConnectionsCredentialRotationServerUpdateTriageCaller>();
  if (opts.runCredentialRotationServerUpdateTriage !== undefined) {
    runCredentialRotationServerUpdateTriage.mockImplementation(
      opts.runCredentialRotationServerUpdateTriage,
    );
  }
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
  const runSuggestSetup = vi.fn<ConnectionsSuggestSetupCaller>();
  if (opts.runSuggestSetup !== undefined) {
    runSuggestSetup.mockImplementation(opts.runSuggestSetup);
  }

  const mount = mountConnectionsEnrollPanel({
    host: fake.host,
    document: { } as unknown as Document, // unused — host is supplied
    runList,
    runEnroll,
    runUpdate,
    ...(opts.runRotateCredentials !== null ? { runRotateCredentials } : {}),
    ...(opts.runCredentialRotationStatus !== undefined
      ? { runCredentialRotationStatus }
      : {}),
    ...(opts.runCredentialRotationActivity !== undefined
      ? { runCredentialRotationActivity }
      : {}),
    ...(opts.runAcknowledgeCredentialRotationSafeStop !== null
      ? { runAcknowledgeCredentialRotationSafeStop }
      : {}),
    ...(opts.runCredentialRotationServerUpdateTriage !== undefined
      ? { runCredentialRotationServerUpdateTriage }
      : {}),
    ...(credentialRotationContinuity !== undefined
      ? { credentialRotationContinuity }
      : {}),
    ...(opts.credentialRotationTabConvergence !== undefined
      ? {
          credentialRotationTabConvergence:
            opts.credentialRotationTabConvergence,
        }
      : {}),
    ...(opts.credentialRotationServerUpdateContinuity !== undefined
      ? {
          credentialRotationServerUpdateContinuity:
            opts.credentialRotationServerUpdateContinuity,
        }
      : {}),
    ...(opts.onReconnect !== undefined ? { onReconnect: opts.onReconnect } : {}),
    ...(opts.onOpenCredentialRotationServerUpdateGuide !== undefined
      ? {
          onOpenCredentialRotationServerUpdateGuide:
            opts.onOpenCredentialRotationServerUpdateGuide,
        }
      : {}),
    ...(opts.initialCredentialRotationServerUpdateRetry !== undefined
      ? {
          initialCredentialRotationServerUpdateRetry:
            opts.initialCredentialRotationServerUpdateRetry,
        }
      : {}),
    ...(opts.initialPostSafeStopRecovery !== undefined
      ? { initialPostSafeStopRecovery: opts.initialPostSafeStopRecovery }
      : {}),
    ...(opts.postSafeStopProfileLabel !== undefined
      ? { postSafeStopProfileLabel: opts.postSafeStopProfileLabel }
      : {}),
    ...(opts.postSafeStopProfileHandoff !== undefined
      ? { postSafeStopProfileHandoff: opts.postSafeStopProfileHandoff }
      : {}),
    ...(opts.onOpenPostSafeStopServerProfiles !== undefined
      ? {
          onOpenPostSafeStopServerProfiles:
            opts.onOpenPostSafeStopServerProfiles,
        }
      : {}),
    ...(opts.onPostSafeStopProfileHandoffSettled !== undefined
      ? {
          onPostSafeStopProfileHandoffSettled:
            opts.onPostSafeStopProfileHandoffSettled,
        }
      : {}),
    ...(opts.onCredentialRotationCleanEditorReady !== undefined
      ? {
          onCredentialRotationCleanEditorReady:
            opts.onCredentialRotationCleanEditorReady,
        }
      : {}),
    ...(opts.onCredentialRotationCleanEditorChanged !== undefined
      ? {
          onCredentialRotationCleanEditorChanged:
            opts.onCredentialRotationCleanEditorChanged,
        }
      : {}),
    credentialRotationAttemptId: opts.credentialRotationAttemptId
      ?? (() => 'rotation-panel-test-0001'),
    runDelete,
    runProbe,
    ...(opts.runMcpPackPreview !== undefined
      ? { runMcpPackPreview: opts.runMcpPackPreview }
      : {}),
    ...(opts.runMcpPackCommit !== undefined
      ? { runMcpPackCommit: opts.runMcpPackCommit }
      : {}),
    ...(opts.runEngagementHealth !== undefined
      ? { runEngagementHealth }
      : {}),
    ...(opts.runReprobeEngagementCapabilities !== undefined
      ? { runReprobeEngagementCapabilities }
      : {}),
    runMailList: opts.runMailList === undefined ? undefined : runMailList,
    ...(opts.runSuggestSetup !== undefined ? { runSuggestSetup } : {}),
    ...(opts.providerSetupContinuity !== undefined
      ? { providerSetupContinuity: opts.providerSetupContinuity }
      : {}),
    ...(opts.confirmDiscardDraft !== undefined
      ? { confirmDiscardDraft: opts.confirmDiscardDraft }
      : {}),
    ...(opts.copyText !== undefined ? { copyText: opts.copyText } : {}),
    ...(opts.oauth?.runStart !== undefined
      ? { runStartVendorOAuth: opts.oauth.runStart }
      : {}),
    ...(opts.oauth?.runTake !== undefined
      ? { runTakeVendorOAuthResult: opts.oauth.runTake }
      : {}),
    ...(opts.oauth?.subscribe !== undefined ? { subscribe: opts.oauth.subscribe } : {}),
    ...(opts.oauth?.env !== undefined ? { oauthEnv: opts.oauth.env } : {}),
    ...(opts.oauth?.runComplete !== undefined
      ? { runCompleteVendorOAuth: opts.oauth.runComplete }
      : {}),
    ...(opts.oauth?.foundationalEnv !== undefined
      ? { foundationalOAuthEnv: opts.oauth.foundationalEnv }
      : {}),
    ...(opts.runPacksList !== undefined ? { runPacksList: opts.runPacksList } : {}),
  });

  return {
    ...fake,
    mount,
    calls: {
      runList,
      runEnroll,
      runUpdate,
      runRotateCredentials,
      runCredentialRotationStatus,
      runCredentialRotationActivity,
      runAcknowledgeCredentialRotationSafeStop,
      runCredentialRotationServerUpdateTriage,
      runDelete,
      runProbe,
      runEngagementHealth,
      runReprobeEngagementCapabilities,
      runMailList,
      runSuggestSetup,
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

describe('D-228 MCP enrollment — generated-pack install scope', () => {
  const previewRows = [{
    op: 'create_issue_a1b2c3d4',
    tool: 'create_issue',
    description: 'Create an issue.',
    stored: { risk: 'write' as const, approval: 'ask' as const },
  }];

  it('collects the safe owner/read default and sends it on pack commit', async () => {
    const runMcpPackPreview = vi.fn<ConnectionsMcpPackPreviewCaller>(async () => ({
      pack_slug: 'mcp-generated-pack',
      rows: previewRows,
    }));
    const runMcpPackCommit = vi.fn<ConnectionsMcpPackCommitCaller>(async () => ({
      pack_slug: 'mcp-generated-pack',
      operations: 1,
    }));
    const rig = mountPanel({
      connections: [],
      runMcpPackPreview,
      runMcpPackCommit,
    });
    await rig.mount.whenLoaded();

    rig.click({ action: 'connections-open-add' });
    rig.click({ action: 'connections-pick-kind', kind: 'mcp' });
    rig.click({ action: 'connections-pick-subtype', subtype: 'sse' });
    rig.field('name', 'issue-mcp');
    rig.field('display_name', 'Issue MCP');
    rig.field('config.endpoint', 'https://mcp.example.test/sse');
    rig.click({ action: 'connections-submit-form' });
    await tick(20);
    expect(rig.calls.runEnroll).toHaveBeenCalledWith(expect.objectContaining({
      name: 'issue-mcp',
      kind: 'mcp',
    }));
    expect(runMcpPackPreview).toHaveBeenCalledWith({
      name: 'issue-mcp',
      kind: 'mcp',
    });
    expect(rig.getHtml()).toContain(`${MCP_PACK_INSTALL_SCOPE_HOST_ATTR}=""`);
    expect(rig.mount.getMcpPackInstallScope()).toEqual({
      access: 'read',
      audience: { owner: true, all_customers: false, all_other_contracts: false },
    });

    rig.click({ action: 'connections-mcp-pack-save' });
    await tick();
    expect(runMcpPackCommit).toHaveBeenCalledWith({
      name: 'issue-mcp',
      kind: 'mcp',
      reviewed_ops: ['create_issue_a1b2c3d4'],
      install_scope: {
        access: 'read',
        audience: { owner: true, all_customers: false, all_other_contracts: false },
      },
    });
    rig.mount.dispose();
  });

  it('sends the explicit write and Audience choices, and rejects unoffered All', async () => {
    const runMcpPackCommit = vi.fn<ConnectionsMcpPackCommitCaller>(async () => ({
      pack_slug: 'mcp-generated-pack',
      operations: 1,
    }));
    const rig = mountPanel({
      connections: [connection('issue-mcp', { kind: 'mcp', subtype: 'sse' })],
      runMcpPackPreview: async () => ({
        pack_slug: 'mcp-generated-pack',
        rows: previewRows,
      }),
      runMcpPackCommit,
    });
    await rig.mount.whenLoaded();
    rig.click({ action: 'connections-mcp-pack-generate', name: 'issue-mcp' });
    await tick();

    rig.mount.clickMcpPackAccessOption('all');
    expect(rig.mount.getMcpPackInstallScope()?.access).toBe('read');
    rig.mount.clickMcpPackAccessOption('write');
    rig.mount.setMcpPackInstallAudience({
      owner: true,
      all_customers: true,
      all_other_contracts: false,
    });
    expect(rig.mount.getMcpPackInstallScope()).toEqual({
      access: 'write',
      audience: { owner: true, all_customers: true, all_other_contracts: false },
    });

    rig.click({ action: 'connections-mcp-pack-save' });
    await tick();
    expect(runMcpPackCommit.mock.calls[0]?.[0].install_scope).toEqual({
      access: 'write',
      audience: { owner: true, all_customers: true, all_other_contracts: false },
    });
    rig.mount.dispose();
  });

  it('drops a cancelled review’s grants before the next server review', async () => {
    const rig = mountPanel({
      connections: [connection('issue-mcp', { kind: 'mcp', subtype: 'sse' })],
      runMcpPackPreview: async () => ({
        pack_slug: 'mcp-generated-pack',
        rows: previewRows,
      }),
      runMcpPackCommit: async () => ({
        pack_slug: 'mcp-generated-pack',
        operations: 1,
      }),
    });
    await rig.mount.whenLoaded();
    rig.click({ action: 'connections-mcp-pack-review', name: 'issue-mcp' });
    await tick();
    rig.mount.clickMcpPackAccessOption('write');
    rig.mount.setMcpPackInstallAudience({
      owner: true,
      all_customers: true,
      all_other_contracts: true,
    });
    rig.click({ action: 'connections-mcp-pack-cancel' });
    expect(rig.mount.getMcpPackInstallScope()).toBeNull();

    rig.click({ action: 'connections-mcp-pack-review', name: 'issue-mcp' });
    await tick();
    expect(rig.mount.getMcpPackInstallScope()).toEqual({
      access: 'read',
      audience: { owner: true, all_customers: false, all_other_contracts: false },
    });
    rig.mount.dispose();
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

  it('seeds messenger local mode and swaps the onboarding + credentials with the mode', async () => {
    const panel = mountPanel({ connections: [] });
    await panel.mount.whenLoaded();

    panel.click({ action: 'connections-open-add' });
    panel.click({ action: 'connections-pick-kind', kind: 'notification' });
    panel.click({ action: 'connections-pick-subtype', subtype: 'slack' });

    expect(panel.mount.getState().dialog.values['config.ingress_mode']).toBe('socket');
    expect(panel.mount.getState().dialog.values['auth.type']).toBe('bearer');
    expect(panel.getHtml()).toContain('data-connection-onboarding="slack-socket"');
    expect(panel.getHtml()).toContain('data-conn-field="auth.app_token"');
    expect(panel.getHtml()).not.toContain('data-conn-field="config.signing_secret"');
    expect(panel.getHtml()).not.toContain('data-conn-field="auth.type"');

    panel.field('config.ingress_mode', 'webhook', 'SELECT');

    expect(panel.mount.getState().dialog.values['config.ingress_mode']).toBe('webhook');
    expect(panel.getFocusedSelector()).toBe(fieldSelector('config.ingress_mode'));
    expect(panel.getHtml()).toContain('data-connection-onboarding="slack-webhook"');
    expect(panel.getHtml()).toContain('data-conn-field="config.signing_secret"');
    expect(panel.getHtml()).not.toContain('data-conn-field="auth.app_token"');
    panel.mount.dispose();
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

  it('surfaces and retries a failed pack-context read', async () => {
    let packReads = 0;
    const hubspotPack = {
      slug: 'hubspot-workflows',
      installed: true,
      manifest: {
        manifest_version: 2,
        artifact_type: 'pack',
        slug: 'hubspot-workflows',
        publisher: 'recued-core',
        version: 1,
        contents: [{
          type: 'composition',
          composition: {
            schema_version: 1,
            slug: 'hubspot-catalog',
            ingredients: [{
              slug: 'hubspot-catalog',
              kind: 'http',
              http: {
                base: 'https://api.hubapi.com',
                connection: 'hubspot',
              },
            }],
            operations: [{
              op: 'deal.create',
              ingredient: 'hubspot-catalog',
              risk: 'write',
              approval: 'never',
              required_scopes: ['crm.objects.deals.write'],
              bind: { method: 'POST', path: '/deals' },
            }],
          },
        }],
      },
    } as unknown as PackListEntry;
    const panel = mountPanel({
      connections: [connection('hubspot-work', {
        vendor: 'hubspot',
        granted_scopes: ['crm.objects.deals.read'],
        bound_pack_slugs: ['hubspot-workflows'],
      })],
      runPacksList: async () => {
        packReads += 1;
        if (packReads === 1) throw new Error('pack inventory unavailable');
        return { packs: [hubspotPack] };
      },
    });
    await panel.mount.whenLoaded();

    expect(packReads).toBe(1);
    expect(panel.getHtml()).toContain('data-connections-pack-inventory="error"');
    expect(panel.getHtml()).toContain('Recued cannot read the Pack details');

    panel.click({ action: 'connections-retry-pack-context' });
    await tick();

    expect(packReads).toBe(2);
    expect(panel.getHtml()).not.toContain('data-connections-pack-inventory');
    expect(panel.getHtml()).toContain('Used by packs');
    expect(panel.getHtml()).toContain('hubspot-workflows');
    panel.mount.dispose();
  });

  it('serializes live pack-context refreshes and drops the stale middle roster', async () => {
    const pack = (slug: string): PackListEntry => ({
      slug,
      installed: true,
      manifest: {
        manifest_version: 2,
        artifact_type: 'pack',
        slug,
        publisher: 'recued-core',
        version: 1,
        contents: [{
          type: 'composition',
          composition: {
            schema_version: 1,
            slug: `${slug}-catalog`,
            ingredients: [{
              slug: `${slug}-catalog`,
              kind: 'http',
              http: {
                base: 'https://api.hubapi.com',
                connection: 'hubspot',
              },
            }],
            operations: [{
              op: 'deal.read',
              ingredient: `${slug}-catalog`,
              risk: 'read',
              approval: 'never',
              required_scopes: ['crm.objects.deals.read'],
              bind: { method: 'GET', path: '/deals' },
            }],
          },
        }],
      },
    } as unknown as PackListEntry);
    const second = deferred<{ packs: ReadonlyArray<PackListEntry> }>();
    const third = deferred<{ packs: ReadonlyArray<PackListEntry> }>();
    let packReads = 0;
    const listeners = new Map<string, (event: never) => void>();
    const subscribe = ((kind: string, listener: (event: never) => void) => {
      listeners.set(kind, listener);
      return () => listeners.delete(kind);
    }) as unknown as BroadcastSubscriber['on'];
    const panel = mountPanel({
      connections: [connection('hubspot-work', {
        vendor: 'hubspot',
        granted_scopes: ['crm.objects.deals.read'],
      })],
      runPacksList: () => {
        packReads += 1;
        if (packReads === 1) return Promise.resolve({ packs: [pack('initial-pack')] });
        if (packReads === 2) return second.promise;
        return third.promise;
      },
      oauth: { subscribe },
    });
    await panel.mount.whenLoaded();
    expect(panel.getHtml()).toContain('initial-pack');

    listeners.get('pack_uninstalled')?.({
      kind: 'pack_uninstalled',
      pack_slug: 'initial-pack',
      pack_name: 'Initial Pack',
      pack_version: 1,
      removed_recipe_count: 1,
      cursor: 1,
    } as never);
    await tick();
    expect(packReads).toBe(2);

    listeners.get('pack_installed')?.({
      kind: 'pack_installed',
      pack_slug: 'current-pack',
      pack_name: 'Current Pack',
      pack_version: 1,
      installed_recipe_count: 1,
      cursor: 2,
    } as never);
    expect(packReads).toBe(2);

    second.resolve({ packs: [pack('stale-pack')] });
    await tick();
    expect(packReads).toBe(3);
    expect(panel.getHtml()).not.toContain('stale-pack');

    third.resolve({ packs: [pack('current-pack')] });
    await tick();
    expect(panel.getHtml()).toContain('current-pack');
    expect(panel.getHtml()).not.toContain('initial-pack');
    expect(panel.getHtml()).not.toContain('stale-pack');

    panel.mount.dispose();
    expect(listeners.has('pack_installed')).toBe(false);
    expect(listeners.has('pack_uninstalled')).toBe(false);
  });

  it('keeps initial readiness pending through an overtaking pack broadcast', async () => {
    const first = deferred<{ packs: ReadonlyArray<PackListEntry> }>();
    const latest = deferred<{ packs: ReadonlyArray<PackListEntry> }>();
    const listeners = new Map<string, (event: never) => void>();
    const subscribe = ((kind: string, listener: (event: never) => void) => {
      listeners.set(kind, listener);
      return () => listeners.delete(kind);
    }) as unknown as BroadcastSubscriber['on'];
    let packReads = 0;
    const panel = mountPanel({
      runPacksList: () => {
        packReads += 1;
        return packReads === 1 ? first.promise : latest.promise;
      },
      oauth: { subscribe },
    });
    let loaded = false;
    const whenLoaded = panel.mount.whenLoaded().then(() => { loaded = true; });
    await tick();
    expect(packReads).toBe(1);

    listeners.get('pack_installed')?.({
      kind: 'pack_installed',
      pack_slug: 'new-pack',
      pack_name: 'New Pack',
      pack_version: 1,
      installed_recipe_count: 1,
      cursor: 3,
    } as never);
    first.resolve({ packs: [] });
    await tick();

    expect(packReads).toBe(2);
    expect(loaded).toBe(false);

    latest.resolve({ packs: [] });
    await whenLoaded;
    expect(loaded).toBe(true);
    panel.mount.dispose();
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

describe('Connections API form — Suggest and guide', () => {
  const openOAuthGuide = async (opts: MountOpts = {}) => {
    const panel = mountPanel(opts);
    await panel.mount.whenLoaded();
    panel.click({ action: 'connections-open-add' });
    panel.click({ action: 'connections-pick-kind', kind: 'api' });
    panel.field('auth.type', 'oauth2_refresh', 'SELECT');
    panel.click({ action: 'connections-guide-open' });
    expect(panel.getFocusedSelector()).toBe(GUIDE_URL_SELECTOR);
    return panel;
  };

  it('reviews and sends only a cleaned URL, auth type, and field keys', async () => {
    const panel = await openOAuthGuide({
      runSuggestSetup: async (args) => ({
        shared_context: {
          target_url: args.target_url,
          auth_type: args.auth_type,
          field_keys: [...args.field_keys],
        },
        guide: {
          provider_name: 'Example Cloud',
          overview: 'Create an OAuth app before completing the connection form.',
          field_suggestions: [{
            field_key: 'auth.token_endpoint',
            suggested_value: 'https://oauth.example.com/token',
            guidance: 'Use the provider token endpoint.',
            confidence: 'high',
          }],
          steps: [{
            title: 'Create the app',
            instruction: 'Open the developer portal and create a web application.',
            field_keys: ['auth.client_id', 'auth.client_secret'],
          }],
          cautions: ['Request only the permissions you need.'],
        },
      }),
    });

    // These values stay in the enrollment form and must never enter the guide
    // request, even though the corresponding FIELD NAMES are reviewed.
    panel.field('auth.refresh_token', 'REFRESH-SECRET-DO-NOT-SHARE');
    panel.field('auth.client_id', 'CLIENT-ID-DO-NOT-SHARE');
    panel.field('auth.client_secret', 'CLIENT-SECRET-DO-NOT-SHARE');
    panel.guideUrl(
      'https://developer.example.com/apps?access_token=URL-SECRET-DO-NOT-SHARE#private',
    );
    expect(panel.guideReviewBtn.hasAttribute('disabled')).toBe(false);
    panel.click({ action: 'connections-guide-review' });
    expect(panel.getFocusedSelector()).toBe(GUIDE_GENERATE_SELECTOR);

    const reviewed = panel.mount.getState().dialog.setupGuide;
    expect(reviewed.stage).toBe('preview');
    expect(reviewed.preview?.target_url).toBe('https://developer.example.com/apps');
    expect(reviewed.preview?.field_keys).toContain('auth.client_secret');
    expect(JSON.stringify(reviewed.preview)).not.toContain('DO-NOT-SHARE');
    expect(panel.getHtml()).toContain('Not shared:');

    panel.click({ action: 'connections-guide-generate' });
    await tick();
    expect(panel.calls.runSuggestSetup).toHaveBeenCalledTimes(1);
    const sent = panel.calls.runSuggestSetup.mock.calls[0]?.[0];
    expect(sent).toEqual({
      target_url: 'https://developer.example.com/apps',
      auth_type: 'oauth2_refresh',
      field_keys: reviewed.preview?.field_keys,
    });
    expect(JSON.stringify(sent)).not.toContain('DO-NOT-SHARE');
    expect(panel.mount.getState().dialog.setupGuide.stage).toBe('ready');
    expect(panel.getFocusedSelector()).toBe(GUIDE_PANEL_SELECTOR);
    expect(panel.getHtml()).toContain('Provider setup walkthrough');
    expect(panel.getHtml()).toContain('Example Cloud');
    panel.click({ action: 'connections-guide-close' });
    expect(panel.getFocusedSelector()).toBe(GUIDE_OPEN_SELECTOR);
    panel.mount.dispose();
  });

  it('keeps the provider-app round trip ready, copies the exact callback, and returns to Client ID', async () => {
    const copyText = vi.fn(async (_value: string) => {});
    const panel = await openOAuthGuide({
      copyText,
      runSuggestSetup: async (args) => ({
        shared_context: {
          target_url: args.target_url,
          auth_type: args.auth_type,
          field_keys: [...args.field_keys],
        },
        guide: {
          provider_name: 'Example Cloud',
          overview: 'Create a web OAuth app, then return to Recued.',
          field_suggestions: [{
            field_key: 'auth.scopes',
            suggested_value: 'records.read records.write',
            guidance: 'Verify both scopes against the provider documentation.',
            confidence: 'medium',
          }],
          steps: [{
            title: 'Create the app',
            instruction: 'Create a confidential web application.',
            field_keys: ['auth.client_id', 'auth.client_secret'],
          }],
          cautions: ['Keep the client secret private.'],
        },
      }),
    });
    panel.guideUrl('https://developer.example.com/apps');
    panel.click({ action: 'connections-guide-review' });
    panel.click({ action: 'connections-guide-generate' });
    await tick();

    expect(panel.getHtml()).toContain('Provider app handoff');
    expect(panel.getHtml()).toContain(OAUTH_CLOUD_CALLBACK_URL);
    expect(panel.getHtml()).toContain('data-scope-source="guide"');
    expect(panel.getHtml()).toContain('This reviewed guide and your current form stay ready');

    const copyButton = panel.click({ action: 'connections-guide-copy-callback' });
    await tick();
    expect(copyText).toHaveBeenCalledWith(OAUTH_CLOUD_CALLBACK_URL);
    expect(copyButton.textContent).toBe('Copied');
    expect(copyButton.getAttribute('aria-label')).toBe('Callback URL copied.');

    panel.click({ action: 'connections-guide-return-to-form' });
    expect(panel.getFocusedSelector()).toBe(fieldSelector('auth.client_id'));
    expect(panel.mount.getState().dialog.setupGuide.stage).toBe('ready');
    panel.mount.dispose();
  });

  it('restores only a safe guide after reload, then resumes once at the exact unfinished field', async () => {
    const data = new Map<string, string>();
    const storage = {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => { data.set(key, value); },
      removeItem: (key: string) => { data.delete(key); },
    };
    const makeContinuity = () => createProviderSetupContinuityStore({
      storage,
      scopeId: 'profile-office',
      now: () => FIXED_NOW,
    });
    const suggest: ConnectionsSuggestSetupCaller = async (args) => ({
      shared_context: {
        target_url: args.target_url,
        auth_type: args.auth_type,
        field_keys: [...args.field_keys],
      },
      guide: {
        provider_name: 'Example Cloud',
        overview: 'Create the provider app and bring its issued values back.',
        field_suggestions: [
          {
            field_key: 'auth.client_id',
            suggested_value: 'MODEL-CLIENT-ID-MUST-NOT-PERSIST',
            guidance: 'Copy the issued client ID from the provider.',
            confidence: 'low',
          },
          {
            field_key: 'auth.client_secret',
            suggested_value: 'MODEL-CLIENT-SECRET-MUST-NOT-PERSIST',
            guidance: 'Copy the issued client secret from the provider.',
            confidence: 'low',
          },
          {
            field_key: 'auth.token_endpoint',
            suggested_value: 'https://oauth.example.com/token',
            guidance: 'Verify this public endpoint.',
            confidence: 'high',
          },
        ],
        steps: [{
          title: 'Create the app',
          instruction: 'Create a confidential web application.',
          field_keys: ['auth.client_id', 'auth.client_secret'],
        }],
        cautions: ['Keep provider-issued credentials in the live form.'],
      },
    });

    const first = await openOAuthGuide({
      providerSetupContinuity: makeContinuity(),
      runSuggestSetup: suggest,
    });
    first.field('name', 'private-account-name');
    first.field('display_name', 'Private Account');
    first.field('auth.client_id', 'REAL-CLIENT-ID-MUST-NOT-PERSIST');
    first.field('auth.client_secret', 'REAL-CLIENT-SECRET-MUST-NOT-PERSIST');
    // Leave the next required token-endpoint field unfinished. Its closed-list
    // name may persist so the return is exact; preceding credentials may not.
    first.field('auth.refresh_token', 'REAL-REFRESH-TOKEN-MUST-NOT-PERSIST');
    first.guideUrl('https://developer.example.com/apps?credential=url-secret');
    first.click({ action: 'connections-guide-review' });
    first.click({ action: 'connections-guide-generate' });
    await tick();

    const raw = data.get(PROVIDER_SETUP_CONTINUITY_SESSION_KEY) ?? '';
    expect(raw).toContain('https://developer.example.com/apps');
    expect(raw).toContain('https://oauth.example.com/token');
    expect(raw).not.toContain('private-account-name');
    expect(raw).not.toContain('Private Account');
    expect(raw).not.toContain('REAL-CLIENT-ID-MUST-NOT-PERSIST');
    expect(raw).not.toContain('REAL-CLIENT-SECRET-MUST-NOT-PERSIST');
    expect(raw).not.toContain('REAL-REFRESH-TOKEN-MUST-NOT-PERSIST');
    expect(raw).not.toContain('MODEL-CLIENT-ID-MUST-NOT-PERSIST');
    expect(raw).not.toContain('MODEL-CLIENT-SECRET-MUST-NOT-PERSIST');
    expect(raw).toContain('"resume_field_key":"auth.token_endpoint"');
    first.mount.dispose();

    // A new store instance models a full reload; the same session storage and
    // profile scope are the only continuity inputs.
    const second = mountPanel({
      providerSetupContinuity: makeContinuity(),
      runSuggestSetup: suggest,
      // Continuity is local and must not wait behind a stalled list request.
      runList: () => new Promise<
        Awaited<ReturnType<ConnectionsEnrollListCaller>>
      >(() => undefined),
    });
    const restored = second.mount.getState().dialog;
    expect(restored.stage).toBe('form');
    expect(restored.mode).toBe('create');
    expect(restored.setupGuide.stage).toBe('ready');
    expect(restored.setupGuide.resumeAvailable).toBe(true);
    expect(restored.setupGuide.resumeFieldKey).toBe('auth.token_endpoint');
    expect(restored.values['auth.type']).toBe('oauth2_refresh');
    expect(restored.values['name']).toBeUndefined();
    expect(restored.values['display_name']).toBeUndefined();
    expect(restored.values['auth.client_id']).toBeUndefined();
    expect(restored.values['auth.client_secret']).toBeUndefined();
    expect(restored.values['auth.refresh_token']).toBeUndefined();
    expect(second.getHtml()).toContain('Provider setup restored');
    expect(second.getHtml()).toContain('Resume provider setup');
    expect(second.getHtml()).toContain('Other form entries were not retained');
    expect(second.getHtml()).toContain('were never stored in this resume');
    expect(second.getHtml()).not.toContain('connections-guide-return-to-form');

    second.click({ action: 'connections-guide-resume' });
    expect(second.mount.getState().dialog.setupGuide.resumeAvailable).toBe(false);
    expect(second.mount.getState().dialog.setupGuide.resumeFieldKey).toBeNull();
    expect(second.getFocusedSelector()).toBe(fieldSelector('auth.token_endpoint'));
    expect(second.getHtml()).not.toContain('Provider setup restored');
    expect(second.getHtml()).toContain('connections-guide-return-to-form');
    expect(data.has(PROVIDER_SETUP_CONTINUITY_SESSION_KEY)).toBe(false);
    second.mount.dispose();

    const third = mountPanel({ providerSetupContinuity: makeContinuity() });
    await third.mount.whenLoaded();
    await tick();
    expect(third.mount.getState().dialog.stage).toBe('closed');
    expect(third.getHtml()).not.toContain('Resume provider setup');
    third.mount.dispose();
  });

  it('retires a restored guide whose stored field context no longer matches the schema', async () => {
    const data = new Map<string, string>();
    const storage = {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => { data.set(key, value); },
      removeItem: (key: string) => { data.delete(key); },
    };
    const continuity = createProviderSetupContinuityStore({
      storage,
      scopeId: 'profile-office',
      now: () => FIXED_NOW,
    });
    expect(continuity.write({
      schemaKind: 'bare_api',
      schemaVendor: null,
      resumeFieldKey: 'auth.client_id',
      result: {
        shared_context: {
          target_url: 'https://developer.example.com/apps',
          auth_type: 'oauth2_refresh',
          // Valid closed-list keys, but not the full live visible-field set.
          field_keys: ['auth.type', 'auth.client_id'],
        },
        guide: {
          provider_name: 'Stale Guide',
          overview: 'This should not be restored.',
          field_suggestions: [],
          steps: [{
            title: 'Old step',
            instruction: 'Old schema.',
            field_keys: ['auth.client_id'],
          }],
          cautions: [],
        },
      },
    })).toBe(true);

    const panel = mountPanel({ providerSetupContinuity: continuity });
    await panel.mount.whenLoaded();
    await tick();
    expect(panel.mount.getState().dialog.stage).toBe('closed');
    expect(panel.getHtml()).not.toContain('Stale Guide');
    expect(data.has(PROVIDER_SETUP_CONTINUITY_SESSION_KEY)).toBe(false);
    panel.mount.dispose();
  });

  it('rebuilds a registered provider from its schema identity without credentials', async () => {
    const data = new Map<string, string>();
    const storage = {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => { data.set(key, value); },
      removeItem: (key: string) => { data.delete(key); },
    };
    const makeContinuity = () => createProviderSetupContinuityStore({
      storage,
      scopeId: 'profile-office',
      now: () => FIXED_NOW,
    });
    const suggest: ConnectionsSuggestSetupCaller = async (args) => ({
      shared_context: { ...args, field_keys: [...args.field_keys] },
      guide: {
        provider_name: 'Salesforce',
        overview: 'Create a Connected App.',
        field_suggestions: [],
        steps: [{
          title: 'Create the Connected App',
          instruction: 'Use the provider App Manager.',
          field_keys: ['auth.client_id', 'auth.client_secret'],
        }],
        cautions: ['Verify the selected environment.'],
      },
    });

    const first = mountPanel({
      providerSetupContinuity: makeContinuity(),
      runSuggestSetup: suggest,
    });
    await first.mount.whenLoaded();
    first.click({ action: 'connections-open-add' });
    first.click({ action: 'connections-pick-vendor', vendor: 'salesforce' });
    first.field('auth.client_id', 'SALESFORCE-ID-MUST-NOT-PERSIST');
    first.field('auth.client_secret', 'SALESFORCE-SECRET-MUST-NOT-PERSIST');
    first.click({ action: 'connections-guide-open' });
    first.guideUrl('https://help.salesforce.com/s/articleView?id=sf.connected_app_create.htm');
    first.click({ action: 'connections-guide-review' });
    first.click({ action: 'connections-guide-generate' });
    await tick();
    const raw = data.get(PROVIDER_SETUP_CONTINUITY_SESSION_KEY) ?? '';
    expect(raw).toContain('Salesforce');
    expect(raw).not.toContain('SALESFORCE-ID-MUST-NOT-PERSIST');
    expect(raw).not.toContain('SALESFORCE-SECRET-MUST-NOT-PERSIST');
    first.mount.dispose();

    const second = mountPanel({ providerSetupContinuity: makeContinuity() });
    await second.mount.whenLoaded();
    await tick();
    const restored = second.mount.getState().dialog;
    expect(restored.vendor).toBe('salesforce');
    expect(restored.values['config.vendor']).toBe('salesforce');
    expect(restored.values['auth.type']).toBe('oauth2_refresh');
    expect(restored.values['auth.token_endpoint'])
      .toBe(SALESFORCE_OAUTH_TOKEN_URL_PRODUCTION);
    expect(restored.values['auth.client_id']).toBeUndefined();
    expect(restored.values['auth.client_secret']).toBeUndefined();
    expect(restored.setupGuide.resumeAvailable).toBe(true);
    second.mount.dispose();
  });

  it('applies only an explicit reviewed non-secret suggestion to its exact field', async () => {
    const panel = await openOAuthGuide({
      runSuggestSetup: async (args) => ({
        shared_context: {
          target_url: args.target_url,
          auth_type: args.auth_type,
          field_keys: [...args.field_keys],
        },
        guide: {
          provider_name: 'Example Cloud',
          overview: 'Verify every value.',
          field_suggestions: [
            {
              field_key: 'auth.token_endpoint',
              suggested_value: '  https://oauth.example.com/token  ',
              guidance: 'Verify the token endpoint.',
              confidence: 'high',
            },
            {
              // A compromised/old server may violate the guidance-only policy;
              // the client must still refuse to transfer provider identity.
              field_key: 'auth.client_id',
              suggested_value: 'MODEL-INVENTED-ID',
              guidance: 'Copy the real ID from the provider.',
              confidence: 'low',
            },
          ],
          steps: [{
            title: 'Configure OAuth',
            instruction: 'Use verified provider values.',
            field_keys: ['auth.token_endpoint'],
          }],
          cautions: [],
        },
      }),
    });
    panel.guideUrl('https://developer.example.com/apps');
    panel.click({ action: 'connections-guide-review' });
    panel.click({ action: 'connections-guide-generate' });
    await tick();

    expect(panel.getHtml().match(/connections-guide-use-suggestion/gu)).toHaveLength(1);
    panel.click({
      action: 'connections-guide-use-suggestion',
      fieldKey: 'auth.token_endpoint',
    });
    expect(panel.mount.getState().dialog.values['auth.token_endpoint'])
      .toBe('https://oauth.example.com/token');
    expect(panel.getFocusedSelector()).toBe(fieldSelector('auth.token_endpoint'));
    expect(panel.getHtml()).toContain('Use in form after checking');

    panel.click({
      action: 'connections-guide-use-suggestion',
      fieldKey: 'auth.client_id',
    });
    expect(panel.mount.getState().dialog.values['auth.client_id']).toBeUndefined();
    panel.mount.dispose();
  });

  it('requires another review when the selected auth method changes', async () => {
    const panel = await openOAuthGuide();
    panel.guideUrl('https://developer.example.com/apps');
    panel.click({ action: 'connections-guide-review' });
    expect(panel.mount.getState().dialog.setupGuide.stage).toBe('preview');

    panel.field('auth.type', 'bearer', 'SELECT');
    const guide = panel.mount.getState().dialog.setupGuide;
    expect(guide.stage).toBe('entry');
    expect(guide.targetUrl).toBe('https://developer.example.com/apps');
    expect(guide.preview).toBeNull();
    panel.mount.dispose();
  });

  it('does not show a result whose echoed context differs from the review', async () => {
    const panel = await openOAuthGuide({
      runSuggestSetup: async (args) => ({
        shared_context: { ...args, target_url: 'https://different.example.com/' },
        guide: {
          provider_name: 'Wrong result',
          overview: 'Wrong context.',
          field_suggestions: [],
          steps: [{ title: 'Wrong', instruction: 'Wrong.', field_keys: [] }],
          cautions: [],
        },
      }),
    });
    panel.guideUrl('https://developer.example.com/apps');
    panel.click({ action: 'connections-guide-review' });
    panel.click({ action: 'connections-guide-generate' });
    await tick();
    expect(panel.mount.getState().dialog.setupGuide.stage).toBe('error');
    expect(panel.getHtml()).toContain('did not match the context you reviewed');
    expect(panel.getHtml()).not.toContain('Wrong result');
    panel.mount.dispose();
  });

  it('announces an async result without stealing focus from another form field', async () => {
    const pending = deferred<Awaited<ReturnType<ConnectionsSuggestSetupCaller>>>();
    const panel = await openOAuthGuide({ runSuggestSetup: () => pending.promise });
    panel.guideUrl('https://developer.example.com/apps');
    panel.click({ action: 'connections-guide-review' });
    const reviewed = panel.mount.getState().dialog.setupGuide.preview!;
    panel.click({ action: 'connections-guide-generate' });
    expect(panel.getFocusedSelector()).toBe(GUIDE_PANEL_SELECTOR);

    panel.moveFocusOutsideGuide();
    pending.resolve({
      shared_context: {
        target_url: reviewed.target_url,
        auth_type: reviewed.auth_type,
        field_keys: [...reviewed.field_keys],
      },
      guide: {
        provider_name: 'Example Cloud',
        overview: 'Ready without a focus jump.',
        field_suggestions: [],
        steps: [{ title: 'Create a key', instruction: 'Use the provider portal.', field_keys: [] }],
        cautions: [],
      },
    });
    await tick();

    expect(panel.mount.getState().dialog.setupGuide.stage).toBe('ready');
    expect(panel.getFocusedSelector()).toBe('outside-guide');
    expect(panel.getHtml()).toContain('aria-live="polite"');
    panel.mount.dispose();
  });

  it('drops a late guide after close and still reports the paid call as in flight', async () => {
    const pending = deferred<Awaited<ReturnType<ConnectionsSuggestSetupCaller>>>();
    const panel = await openOAuthGuide({ runSuggestSetup: () => pending.promise });
    panel.guideUrl('https://developer.example.com/apps');
    panel.click({ action: 'connections-guide-review' });
    panel.click({ action: 'connections-guide-generate' });
    expect(panel.mount.hasInFlightWork()).toBe(true);
    panel.click({ action: 'connections-guide-close' });
    expect(panel.mount.getState().dialog.setupGuide.stage).toBe('closed');
    expect(panel.mount.getState().dialog.setupGuide.targetUrl)
      .toBe('https://developer.example.com/apps');

    pending.resolve({
      shared_context: {
        target_url: 'https://developer.example.com/apps',
        auth_type: 'oauth2_refresh',
        field_keys: [],
      },
      guide: {
        provider_name: 'Late result',
        overview: 'Late.',
        field_suggestions: [],
        steps: [{ title: 'Late', instruction: 'Late.', field_keys: [] }],
        cautions: [],
      },
    });
    await tick();
    expect(panel.mount.hasInFlightWork()).toBe(false);
    expect(panel.mount.getState().dialog.setupGuide.stage).toBe('closed');
    expect(panel.getHtml()).not.toContain('Late result');
    panel.mount.dispose();
  });

  it('explains the in-flight lock when a closed guide is reopened before settling', async () => {
    const pending = deferred<Awaited<ReturnType<ConnectionsSuggestSetupCaller>>>();
    const panel = await openOAuthGuide({ runSuggestSetup: () => pending.promise });
    panel.guideUrl('https://developer.example.com/apps');
    panel.click({ action: 'connections-guide-review' });
    panel.click({ action: 'connections-guide-generate' });
    panel.click({ action: 'connections-guide-close' });

    panel.click({ action: 'connections-guide-open' });
    expect(panel.mount.getState().dialog.setupGuide.targetUrl)
      .toBe('https://developer.example.com/apps');
    panel.click({ action: 'connections-guide-review' });
    panel.click({ action: 'connections-guide-generate' });

    expect(panel.calls.runSuggestSetup).toHaveBeenCalledTimes(1);
    expect(panel.mount.getState().dialog.setupGuide.stage).toBe('error');
    expect(panel.getHtml()).toContain('previous setup-guide request is still finishing');

    pending.resolve({
      shared_context: {
        target_url: 'https://developer.example.com/apps',
        auth_type: 'oauth2_refresh',
        field_keys: [],
      },
      guide: {
        provider_name: 'Hidden stale result',
        overview: 'Stale.',
        field_suggestions: [],
        steps: [{ title: 'Stale', instruction: 'Stale.', field_keys: [] }],
        cautions: [],
      },
    });
    await tick();
    expect(panel.getHtml()).not.toContain('Hidden stale result');
    panel.mount.dispose();
  });

  it('degrades honestly when the guide caller is not wired', async () => {
    const panel = await openOAuthGuide();
    panel.guideUrl('https://developer.example.com/apps');
    panel.click({ action: 'connections-guide-review' });
    panel.click({ action: 'connections-guide-generate' });
    expect(panel.mount.getState().dialog.setupGuide.stage).toBe('error');
    expect(panel.getHtml()).toContain('not available in this view yet');
    panel.mount.dispose();
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
    const {
      mount,
      click,
      field,
      getHtml,
      calls,
      validationPanel,
      validationMessage,
    } = mountPanel({ connections: [] });
    await mount.whenLoaded();

    click({ action: 'connections-open-add' });
    click({ action: 'connections-pick-kind', kind: 'notification' });
    click({ action: 'connections-pick-subtype', subtype: 'email' });

    expect(calls.runMailList).not.toHaveBeenCalled();
    expect(mount.getState().dialog.stage).toBe('form');
    expect(getHtml()).toContain('You have no mailbox that can send');

    field('name', 'newsletter');
    field('display_name', 'Newsletter');
    expect(validationPanel.getAttribute('role')).toBe('status');
    expect(validationPanel.getAttribute('aria-live')).toBe('polite');
    expect(validationMessage.textContent).toBe(
      'Review the prerequisite shown with this field.',
    );
    click({ action: 'connections-submit-form' });
    await tick();

    expect(calls.runEnroll).not.toHaveBeenCalled();
    expect(mount.getState().dialog.error).toContain('You have no mailbox that can send');
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
    expect(getHtml()).not.toContain('You have no mailbox that can send');
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
    expect(getHtml()).toContain('You have no mailbox that can send');
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
    expect(mount.hasUnsavedChanges()).toBe(true);

    await mount.refresh();
    await tick();

    expect(mount.getState().dynamicOptions[MAIL_SEND_CAPABLE_INSTANCES_SOURCE]).toEqual([
      'keep-imap',
    ]);
    expect(mount.getState().dialog.values['config.sender_mail_instance']).toBe('');
    expect(mount.hasUnsavedChanges()).toBe(false);
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
    expect(mount.hasUnsavedChanges()).toBe(false);
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
    expect(calls.runProbe).toHaveBeenCalledTimes(1);
    expect(calls.runProbe).toHaveBeenCalledWith({ name: 'my-api', kind: 'api' });

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

  it('keeps a successful enrollment when the follow-up probe rpc fails', async () => {
    const { mount, click, field, calls } = mountPanel({
      connections: [],
      runProbe: async () => {
        throw new Error('probe transport unavailable');
      },
    });
    await mount.whenLoaded();

    click({ action: 'connections-open-add' });
    click({ action: 'connections-pick-kind', kind: 'api' });
    field('name', 'saved-api');
    field('display_name', 'Saved API');
    field('config.base_url', 'https://api.example.com');
    field('auth.token', 'secret-123');
    click({ action: 'connections-submit-form' });
    await tick();

    expect(calls.runEnroll).toHaveBeenCalledTimes(1);
    expect(calls.runProbe).toHaveBeenCalledWith({ name: 'saved-api', kind: 'api' });
    expect(mount.getState().dialog.stage).toBe('closed');
    expect(mount.getState().dialog.error).toBeNull();
    expect(mount.getState().dialog.recentProbe).toEqual({
      kind: 'api',
      name: 'saved-api',
      status: 'probe transport unavailable',
    });
    expect(calls.runList).toHaveBeenCalledTimes(2);
    mount.dispose();
  });

  it('blocks submit, surfaces the first fix, and focuses its exact field', async () => {
    const { mount, click, calls, getFocusedSelector } = mountPanel({ connections: [] });
    await mount.whenLoaded();

    click({ action: 'connections-open-add' });
    click({ action: 'connections-pick-kind', kind: 'api' });
    // No name / display_name / base_url / token filled.
    click({ action: 'connections-submit-form' });
    await tick();

    expect(calls.runEnroll).not.toHaveBeenCalled();
    expect(mount.getState().dialog.error).not.toBeNull();
    expect(mount.getState().dialog.stage).toBe('form');
    expect(getFocusedSelector()).toBe(fieldSelector('name'));
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

  it('advances the live first-fix checkpoint without rebuilding or losing the draft', async () => {
    const {
      mount,
      click,
      field,
      getRenderCount,
      getFocusedSelector,
      submitBtn,
      validationPanel,
      validationTitle,
      validationMessage,
      validationActionWrap,
      validationAction,
    } = mountPanel({ connections: [] });
    await mount.whenLoaded();

    click({ action: 'connections-open-add' });
    click({ action: 'connections-pick-kind', kind: 'api' });
    const formRenderCount = getRenderCount();

    click({ action: 'connections-focus-first-invalid', fieldKey: 'forged' });
    expect(getFocusedSelector()).toBe(fieldSelector('name'));

    field('name', 'my-api');

    expect(getRenderCount()).toBe(formRenderCount);
    expect(validationPanel.getAttribute('data-status')).toBe('blocked');
    expect(validationPanel.getAttribute('data-field-key')).toBe('display_name');
    expect(validationTitle.textContent).toBe('Next: Display name');
    expect(validationMessage.textContent).toBe('Display name is required.');
    expect(validationAction.textContent).toBe('Go to Display name');
    expect(validationActionWrap.hasAttribute('hidden')).toBe(false);

    click({ action: 'connections-focus-first-invalid', fieldKey: 'name' });
    expect(getFocusedSelector()).toBe(fieldSelector('display_name'));

    field('display_name', 'My API');
    expect(validationTitle.textContent).toBe('Next: Base URL');
    field('config.base_url', 'https://api.example.com');
    expect(validationTitle.textContent).toBe('Next: Bearer Token');
    field('auth.token', 'secret-token');

    expect(getRenderCount()).toBe(formRenderCount);
    expect(validationPanel.getAttribute('data-status')).toBe('ready');
    expect(validationPanel.getAttribute('data-field-key')).toBe('');
    expect(validationTitle.textContent).toBe('Required details complete');
    expect(validationMessage.textContent).toBe('Review the values before saving.');
    expect(validationMessage.textContent).not.toContain('secret-token');
    expect(validationActionWrap.hasAttribute('hidden')).toBe(true);
    expect(submitBtn.hasAttribute('disabled')).toBe(false);

    field('config.base_url', '');
    expect(validationTitle.textContent).toBe('Next: Base URL');
    expect(validationActionWrap.hasAttribute('hidden')).toBe(false);
    expect(submitBtn.hasAttribute('disabled')).toBe(true);
    mount.dispose();
  });

  it('guards only meaningful memory-only drafts and never echoes a credential', async () => {
    const { mount, click, field, getHtml } = mountPanel({
      connections: [
        connection('my-api', {
          display_name: 'My API',
          base_url: 'https://api.example.com',
          auth_type: 'bearer',
        }),
      ],
    });
    await mount.whenLoaded();

    click({ action: 'connections-edit', kind: 'api', name: 'my-api' });
    expect(mount.hasUnsavedChanges()).toBe(false);
    expect(mount.unsavedChangesPrompt()).toBeNull();
    expect(getHtml()).toMatch(
      /changes you make stay only in this tab.*credential fields are not saved in your browser.*cannot be\s+restored/is,
    );

    field('auth.token', 'private-replacement-secret');
    expect(mount.hasUnsavedChanges()).toBe(true);
    expect(mount.unsavedChangesPrompt()).toMatch(
      /discard changes to api\/my-api.*cancel to stay.*cannot be restored/i,
    );
    expect(mount.unsavedChangesPrompt()).not.toContain(
      'private-replacement-secret',
    );

    // Clearing an unpersisted credential returns to the exact baseline, so a
    // harmless Back/route change does not add confirmation friction.
    field('auth.token', '');
    expect(mount.hasUnsavedChanges()).toBe(false);
    expect(mount.unsavedChangesPrompt()).toBeNull();

    field('display_name', 'My API renamed');
    expect(mount.hasUnsavedChanges()).toBe(true);
    field('display_name', 'My API');
    expect(mount.hasUnsavedChanges()).toBe(false);

    click({ action: 'connections-cancel-dialog' });
    expect(mount.hasUnsavedChanges()).toBe(false);

    click({ action: 'connections-open-add' });
    click({ action: 'connections-pick-kind', kind: 'api' });
    expect(mount.hasUnsavedChanges()).toBe(false);
    field('auth.token', 'new-connection-secret');
    expect(mount.hasUnsavedChanges()).toBe(true);
    expect(mount.unsavedChangesPrompt()).toMatch(
      /discard this new connection setup.*cancel to stay/i,
    );
    expect(mount.unsavedChangesPrompt()).not.toContain(
      'new-connection-secret',
    );
    click({ action: 'connections-cancel-dialog' });
    expect(mount.hasUnsavedChanges()).toBe(false);

    mount.dispose();
  });

  it('keeps a credential draft guarded while Save is pending and after failure', async () => {
    const enroll =
      deferred<{ connection: ConnectionView; probe?: ConnectionHealth }>();
    const { mount, click, field } = mountPanel({
      connections: [],
      runEnroll: () => enroll.promise,
    });
    await mount.whenLoaded();

    click({ action: 'connections-open-add' });
    click({ action: 'connections-pick-kind', kind: 'api' });
    field('name', 'pending-api');
    field('display_name', 'Pending API');
    field('config.base_url', 'https://api.example.com');
    field('auth.token', 'pending-private-token');
    click({ action: 'connections-submit-form' });
    await tick(2);

    expect(mount.getState().dialog.saving).toBe(true);
    expect(mount.hasUnsavedChanges()).toBe(true);
    expect(mount.unsavedChangesPrompt()).toMatch(
      /leave while this connection is saving.*may still save it.*cannot be brought back/i,
    );
    expect(mount.unsavedChangesPrompt()).not.toContain(
      'pending-private-token',
    );

    enroll.reject(new Error('server unavailable'));
    await tick();

    expect(mount.getState().dialog.saving).toBe(false);
    expect(mount.getState().dialog.error).toContain('server unavailable');
    expect(mount.hasUnsavedChanges()).toBe(true);
    expect(mount.unsavedChangesPrompt()).toMatch(
      /discard this new connection setup.*cannot be restored/i,
    );

    mount.dispose();
  });

  it('makes dirty form Back and Cancel explicit without exposing the draft', async () => {
    const confirmDiscardDraft = vi.fn((_message: string) => false);
    const { mount, click, field } = mountPanel({
      connections: [
        connection('my-api', {
          display_name: 'My API',
          auth_type: 'bearer',
        }),
      ],
      confirmDiscardDraft,
    });
    await mount.whenLoaded();

    click({ action: 'connections-edit', kind: 'api', name: 'my-api' });
    field('auth.token', 'stay-in-this-tab');
    click({ action: 'connections-cancel-dialog' });

    expect(confirmDiscardDraft).toHaveBeenCalledOnce();
    expect(confirmDiscardDraft.mock.calls[0]![0]).toMatch(
      /discard changes to api\/my-api.*cancel to stay/i,
    );
    expect(confirmDiscardDraft.mock.calls[0]![0]).not.toContain(
      'stay-in-this-tab',
    );
    expect(mount.getState().dialog.stage).toBe('form');
    expect(mount.getState().dialog.values['auth.token'])
      .toBe('stay-in-this-tab');
    expect(mount.hasUnsavedChanges()).toBe(true);

    confirmDiscardDraft.mockReturnValueOnce(true);
    click({ action: 'connections-cancel-dialog' });
    expect(mount.getState().dialog.stage).toBe('closed');
    expect(mount.hasUnsavedChanges()).toBe(false);

    click({ action: 'connections-open-add' });
    click({ action: 'connections-pick-kind', kind: 'api' });
    field('auth.token', 'new-setup-secret');
    click({ action: 'connections-back-to-kind' });
    expect(mount.getState().dialog.stage).toBe('form');
    expect(mount.getState().dialog.values['auth.token'])
      .toBe('new-setup-secret');

    confirmDiscardDraft.mockReturnValueOnce(true);
    click({ action: 'connections-back-to-kind' });
    expect(mount.getState().dialog.stage).toBe('kind-picker');
    expect(mount.hasUnsavedChanges()).toBe(false);

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
    expect(updateArgs.patch).not.toHaveProperty('auth');
    expect(calls.runEnroll).not.toHaveBeenCalled();
    expect(mount.getState().dialog.stage).toBe('closed');
    mount.dispose();
  });

  it('routes a credential edit through verify-before-swap and retains its receipt', async () => {
    const { mount, click, field, calls, getHtml } = mountPanel({
      connections: [
        connection('my-api', {
          display_name: 'My API',
          base_url: 'https://api.example.com',
          auth_type: 'bearer',
        }),
      ],
    });
    await mount.whenLoaded();

    click({ action: 'connections-edit', kind: 'api', name: 'my-api' });
    field('auth.token', 'replacement-secret');
    expect(getHtml()).toContain('Replacement ready to verify');
    expect(getHtml()).toContain('Verify and replace');
    click({ action: 'connections-submit-form' });
    await tick();

    expect(calls.runUpdate).not.toHaveBeenCalled();
    expect(calls.runRotateCredentials).toHaveBeenCalledTimes(1);
    expect(calls.runRotateCredentials).toHaveBeenCalledWith({
      attempt_id: 'rotation-panel-test-0001',
      name: 'my-api',
      kind: 'api',
      patch: expect.objectContaining({
        auth: { type: 'bearer', token: 'replacement-secret' },
      }),
    });
    expect(mount.getState().dialog.stage).toBe('closed');
    expect(mount.getState().dialog.recentProbe).toMatchObject({
      kind: 'api',
      name: 'my-api',
      status: 'verified',
      purpose: 'credential_rotation',
      auth_type: 'bearer',
      verified_at: FIXED_NOW,
    });
    expect(getHtml()).toContain('A key you paste in checked, and now in use for api/my-api');
    expect(getHtml()).not.toContain('replacement-secret');
    expect(calls.runList).toHaveBeenCalledTimes(2);
    mount.dispose();
  });

  it('preserves a sibling-stale secret draft, blocks its save, and reloads only after explicit consent', async () => {
    const tabs = rotationTabs();
    let listed = connection('shared-api', {
      display_name: 'Shared API',
      base_url: 'https://old.example.com',
      auth_type: 'bearer',
      updated_at: 10,
    });
    const { mount, click, field, calls, getHtml, submitBtn } = mountPanel({
      runList: async () => ({ connections: [listed] }),
      credentialRotationTabConvergence: tabs.convergence,
    });
    await mount.whenLoaded();

    click({ action: 'connections-edit', kind: 'api', name: 'shared-api' });
    field('auth.token', 'memory-only-draft');
    listed = connection('shared-api', {
      display_name: 'Shared API · latest',
      base_url: 'https://latest.example.com',
      auth_type: 'bearer',
      updated_at: 11,
    });

    tabs.emit({ type: 'credential_rotated', kind: 'api', name: 'shared-api' });
    expect(mount.getState().dialog.externalChange?.phase).toBe('checking');
    expect(mount.getState().dialog.values['auth.token']).toBe('memory-only-draft');
    await tick();

    expect(mount.getState().dialog.externalChange?.phase).toBe('changed');
    expect(mount.getState().dialog.values['auth.token']).toBe('memory-only-draft');
    expect(getHtml()).toContain('Connection changed since you opened it');
    expect(getHtml()).toContain('Reload latest');
    expect(submitBtn.hasAttribute('disabled')).toBe(true);

    click({ action: 'connections-submit-form' });
    await tick();
    expect(calls.runRotateCredentials).not.toHaveBeenCalled();
    expect(calls.runUpdate).not.toHaveBeenCalled();

    click({ action: 'connections-reload-stale-editor' });
    await tick();
    expect(mount.getState().dialog.externalChange).toBeNull();
    expect(mount.getState().dialog.values.display_name).toBe('Shared API · latest');
    expect(mount.getState().dialog.values['config.base_url']).toBe(
      'https://latest.example.com',
    );
    expect(mount.getState().dialog.values['auth.token']).not.toBe(
      'memory-only-draft',
    );

    field('auth.token', 'fresh-after-reload');
    click({ action: 'connections-submit-form' });
    await tick();
    expect(calls.runRotateCredentials).toHaveBeenCalledWith(expect.objectContaining({
      name: 'shared-api',
      expected_updated_at: 11,
      patch: expect.objectContaining({
        auth: { type: 'bearer', token: 'fresh-after-reload' },
      }),
    }));
    expect(tabs.notifyCredentialRotated).toHaveBeenCalledWith({
      kind: 'api',
      name: 'shared-api',
    });
    mount.dispose();
    expect(tabs.listenerCount()).toBe(0);
  });

  it('pauses a matching secret draft while a sibling owns verification and resumes after release', async () => {
    const lease = rotationOwnershipLease();
    const tabs = rotationTabs({
      supportsOwnershipLeases: true,
      claim: async () => lease,
    });
    const { mount, click, field, calls, getHtml, submitBtn } = mountPanel({
      connections: [connection('owned-api', {
        base_url: 'https://api.example.com',
        updated_at: 12,
      })],
      credentialRotationTabConvergence: tabs.convergence,
      runCredentialRotationActivity: async () => ({
        activity: { status: 'idle' },
      }),
    });
    await mount.whenLoaded();
    click({ action: 'connections-edit', kind: 'api', name: 'owned-api' });
    field('auth.token', 'memory-only-contender');

    tabs.emit({
      type: 'credential_rotation_started',
      kind: 'api',
      name: 'owned-api',
    });
    expect(mount.getState().dialog.credentialRotationOwnership?.phase)
      .toBe('active');
    expect(mount.getState().dialog.values['auth.token'])
      .toBe('memory-only-contender');
    expect(getHtml()).toContain('Credential check active elsewhere');
    expect(submitBtn.hasAttribute('disabled')).toBe(true);

    click({ action: 'connections-submit-form' });
    await tick();
    expect(calls.runRotateCredentials).not.toHaveBeenCalled();

    tabs.emit({
      type: 'credential_rotation_released',
      kind: 'api',
      name: 'owned-api',
    });
    await tick();
    expect(mount.getState().dialog.credentialRotationOwnership?.phase)
      .toBe('available');
    expect(mount.getState().dialog.values['auth.token'])
      .toBe('memory-only-contender');
    expect(submitBtn.hasAttribute('disabled')).toBe(false);
    mount.dispose();
  });

  it('converges a sibling safe stop through server authority and keeps the admin handoff value-free', async () => {
    const tabs = rotationTabs();
    const activity = deferred<{
      activity: ConnectionCredentialRotationActivity;
    }>();
    const runActivity = vi.fn(() => activity.promise);
    const copyText = vi.fn(async (_value: string) => {});
    const panel = mountPanel({
      connections: [connection('shared-safe-stop', {
        display_name: 'Shared safe stop',
        base_url: 'https://private.example.test',
        auth_type: 'bearer',
        updated_at: 14,
      })],
      credentialRotationTabConvergence: tabs.convergence,
      runCredentialRotationActivity: runActivity,
      copyText,
    });
    await panel.mount.whenLoaded();
    panel.click({
      action: 'connections-edit',
      kind: 'api',
      name: 'shared-safe-stop',
    });
    panel.field('auth.token', 'sibling-memory-only-secret');

    tabs.emit({
      type: 'credential_rotation_safe_stopped',
      kind: 'api',
      name: 'shared-safe-stop',
    });
    expect(panel.mount.getState().credentialRotationRecovery?.phase)
      .toBe('safe_stop_checking');
    expect(panel.mount.getState().dialog.credentialRotationOwnership?.phase)
      .toBe('safe_stop_checking');
    expect(panel.submitBtn.hasAttribute('disabled')).toBe(true);
    expect(panel.mount.getState().dialog.values['auth.token'])
      .toBe('sibling-memory-only-secret');
    expect(panel.getHtml()).toMatch(
      /data-connection-credential-recovery="safe_stop_checking"[^>]*aria-busy="true"/,
    );
    expect(panel.getHtml()).toMatch(
      /data-connection-rotation-owner="safe_stop_checking"[^>]*aria-busy="true"/,
    );

    activity.resolve(safeStopActivity());
    await tick();

    expect(panel.mount.getState().credentialRotationRecovery).toMatchObject({
      phase: 'safe_stopped',
      correction: {
        triage: {
          resolution: 'regenerate_credential_or_contact_admin',
        },
      },
    });
    expect(panel.mount.getState().dialog.credentialRotationOwnership).toBeNull();
    expect(panel.mount.getState().dialog.credentialCorrection).toMatchObject({
      triage: {
        resolution: 'regenerate_credential_or_contact_admin',
      },
    });
    expect(panel.mount.getState().dialog.values['auth.token'])
      .toBe('sibling-memory-only-secret');
    expect(panel.getHtml()).toContain('same credential regeneration');
    expect(panel.getHtml()).toContain('Safe details for the provider administrator');
    expect(panel.submitBtn.hasAttribute('disabled')).toBe(true);

    panel.click({ action: 'connections-copy-credential-admin-handoff' });
    await tick();
    const copied = copyText.mock.calls[0]![0];
    expect(copied).toContain('Connection: api/shared-safe-stop');
    expect(copied).toContain('Sign-in method: A key you paste in');
    expect(copied).not.toContain('sibling-memory-only-secret');
    expect(copied).not.toContain('https://private.example.test');
    expect(copied).not.toContain(String(FIXED_NOW));

    panel.field('auth.token', 'fresh-sibling-secret');
    expect(panel.mount.getState().credentialRotationRecovery).toBeNull();
    expect(panel.mount.getState().dialog.credentialCorrection).toBeNull();
    expect(panel.getHtml()).not.toMatch(
      /data-action="connections-submit-form"[^>]*disabled/,
    );

    // A routine focus/reconnect reconciliation must not resurrect the exact
    // historical stop after this editor materially corrected it. A newer
    // exact safe-stop signal still takes the authoritative path above.
    tabs.emit({ type: 'reconcile' });
    await tick();
    expect(runActivity).toHaveBeenCalledOnce();
    expect(panel.mount.getState().credentialRotationRecovery).toBeNull();
    expect(panel.mount.getState().dialog.credentialCorrection).toBeNull();
    expect(panel.mount.getState().dialog.values['auth.token'])
      .toBe('fresh-sibling-secret');
    expect(panel.getHtml()).not.toMatch(
      /data-action="connections-submit-form"[^>]*disabled/,
    );

    panel.click({ action: 'connections-submit-form' });
    await tick();
    expect(panel.calls.runRotateCredentials).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'shared-safe-stop',
        patch: expect.objectContaining({
          auth: { type: 'bearer', token: 'fresh-sibling-secret' },
        }),
      }),
    );
    panel.mount.dispose();
  });

  it('lands a list-only sibling safe stop on the exact blank recovery form', async () => {
    const tabs = rotationTabs();
    const panel = mountPanel({
      connections: [connection('list-safe-stop', {
        base_url: 'https://private.example.test',
        auth_type: 'bearer',
        updated_at: 15,
      })],
      credentialRotationTabConvergence: tabs.convergence,
      runCredentialRotationActivity: async () => safeStopActivity(),
    });
    await panel.mount.whenLoaded();

    tabs.emit({
      type: 'credential_rotation_safe_stopped',
      kind: 'api',
      name: 'list-safe-stop',
    });
    await tick();

    expect(panel.mount.getState().dialog.stage).toBe('closed');
    expect(panel.mount.getState().credentialRotationRecovery?.phase)
      .toBe('safe_stopped');
    expect(panel.getHtml()).toContain('Resume credential recovery');
    expect(panel.getHtml()).toContain('no draft crossed tabs');

    panel.click({
      action: 'connections-review-credential-rotation',
      kind: 'api',
      name: 'forged-other-connection',
    });
    expect(panel.mount.getState().dialog.stage).toBe('closed');
    expect(panel.mount.getState().credentialRotationRecovery?.name)
      .toBe('list-safe-stop');

    panel.click({
      action: 'connections-review-credential-rotation',
      kind: 'api',
      name: 'list-safe-stop',
    });

    expect(panel.mount.getState().dialog.editingId)
      .toBe('api/list-safe-stop');
    expect(panel.mount.getState().dialog.values['auth.token']).toBeUndefined();
    expect(panel.mount.getState().dialog.credentialCorrection).toMatchObject({
      triage: {
        resolution: 'regenerate_credential_or_contact_admin',
      },
    });
    expect(panel.getHtml()).toContain(
      'Safe details for the provider administrator',
    );
    expect(panel.getHtml()).toContain('Provider/admin confirmed a fix');
    expect(panel.getHtml()).toMatch(
      /data-action="connections-submit-form"[^>]*disabled/,
    );
    panel.mount.dispose();
  });

  it('discovers a cold safe stop, records closure on the server, and explicitly checks the saved connection', async () => {
    const saved = connection('cold-safe-stop', {
      base_url: 'https://private.example.test',
      auth_type: 'bearer',
      updated_at: 15,
    });
    let acknowledged = false;
    let savedUpdatedAt = 15;
    const panel = mountPanel({
      runList: async () => ({
        connections: [{ ...saved, updated_at: savedUpdatedAt }],
        ...(acknowledged
          ? {}
          : {
              credential_rotation_safe_stops: [{
                kind: 'api' as const,
                name: 'cold-safe-stop',
                finished_at: FIXED_NOW,
                correction: safeStopCorrection(),
                acknowledgement_token: SAFE_STOP_TOKEN,
              }],
            }),
      }),
      runAcknowledgeCredentialRotationSafeStop: async () => {
        acknowledged = true;
        return {
          acknowledgement: {
            status: 'acknowledged',
            acknowledged_at: FIXED_NOW + 1,
          },
        };
      },
      runCredentialRotationActivity: async () => ({
        activity: { status: 'idle', safe_stop: null },
      }),
      runProbe: async () => {
        savedUpdatedAt = 16;
        return {
          health: { status: 'ok', last_probed_at: FIXED_NOW + 2 },
          connection_updated_at: savedUpdatedAt,
        };
      },
    });
    await panel.mount.whenLoaded();

    expect(panel.mount.getState().credentialRotationRecovery).toMatchObject({
      kind: 'api',
      name: 'cold-safe-stop',
      phase: 'safe_stopped',
      outstandingSafeStopCount: 1,
    });
    expect(panel.getHtml()).toContain('Resume credential recovery');
    expect(panel.getHtml()).not.toContain(SAFE_STOP_TOKEN);
    expect(JSON.stringify(panel.mount.getState())).not.toContain(
      SAFE_STOP_TOKEN,
    );

    panel.click({
      action: 'connections-review-credential-rotation',
      kind: 'api',
      name: 'cold-safe-stop',
    });
    expect(panel.mount.getState().dialog.values['auth.token']).toBeUndefined();
    expect(panel.getHtml()).toContain('Provider/admin confirmed a fix');

    panel.click({ action: 'connections-confirm-credential-handoff' });
    await tick();

    expect(panel.calls.runAcknowledgeCredentialRotationSafeStop)
      .toHaveBeenCalledWith({
        kind: 'api',
        name: 'cold-safe-stop',
        acknowledgement_token: SAFE_STOP_TOKEN,
      });
    expect(panel.calls.runCredentialRotationActivity).toHaveBeenCalledWith({
      kind: 'api',
      name: 'cold-safe-stop',
    });
    expect(panel.mount.getState().credentialRotationRecovery).toBeNull();
    expect(panel.mount.getState().dialog.credentialCorrection).toBeNull();
    expect(panel.mount.getState().dialog.credentialSafeStopClosureNotice)
      .toEqual({
        kind: 'api',
        name: 'cold-safe-stop',
        nextStep: 'check_saved_connection',
      });
    expect(panel.getHtml()).toContain('Recovery stop closed');
    expect(panel.getHtml()).toContain('Go back and check connection');
    expect(panel.getHtml()).not.toContain(SAFE_STOP_TOKEN);
    expect(panel.getFocusedSelector()).toBe(SAFE_STOP_CHECK_SAVED_SELECTOR);

    panel.click({
      action: 'connections-check-saved-after-safe-stop',
      kind: 'api',
      name: 'cold-safe-stop',
    });
    await tick();
    expect(panel.mount.getState().dialog.stage).toBe('closed');
    expect(panel.calls.runProbe).toHaveBeenCalledWith({
      kind: 'api',
      name: 'cold-safe-stop',
      expected_updated_at: 15,
    });
    expect(panel.calls.runList).toHaveBeenCalledTimes(2);
    expect(panel.mount.getState().dialog.recentProbe).toMatchObject({
      kind: 'api',
      name: 'cold-safe-stop',
      status: 'ok',
      purpose: 'post_safe_stop',
      resolution: 'resolved',
    });
    expect(panel.getHtml()).toContain('Checked, and it is sorted');
    expect(panel.getHtml()).toContain('provider accepted it');
    expect(panel.getHtml()).not.toContain(
      'Last checked for api/cold-safe-stop',
    );

    panel.mount.dispose();

    // A new mount receives no sidecar after the durable acknowledgement. It
    // neither rediscovers the stop nor replays the one-shot closure receipt.
    const reloaded = mountPanel({ connections: [saved] });
    await reloaded.mount.whenLoaded();
    expect(reloaded.mount.getState().credentialRotationRecovery).toBeNull();
    expect(reloaded.getHtml()).not.toContain('Resume credential recovery');
    expect(reloaded.getHtml()).not.toContain('Recovery stop closed');
    reloaded.mount.dispose();
  });

  it('turns a fresh post-ack rejection into a clean exact-editor correction without reviving the old safe stop', async () => {
    const tabs = rotationTabs();
    const saved = connection('still-rejected', {
      base_url: 'https://private.example.test',
      auth_type: 'bearer',
      updated_at: 30,
    });
    let acknowledged = false;
    let savedUpdatedAt = 30;
    const panel = mountPanel({
      credentialRotationTabConvergence: tabs.convergence,
      runList: async () => ({
        connections: [{ ...saved, updated_at: savedUpdatedAt }],
        ...(acknowledged
          ? {}
          : {
              credential_rotation_safe_stops: [{
                kind: 'api' as const,
                name: 'still-rejected',
                finished_at: FIXED_NOW,
                correction: safeStopCorrection(),
                acknowledgement_token: SAFE_STOP_TOKEN,
              }],
            }),
      }),
      runAcknowledgeCredentialRotationSafeStop: async () => {
        acknowledged = true;
        return {
          acknowledgement: {
            status: 'acknowledged',
            acknowledged_at: FIXED_NOW + 1,
          },
        };
      },
      runCredentialRotationActivity: async () => ({
        activity: { status: 'idle', safe_stop: null },
      }),
      runProbe: async () => {
        savedUpdatedAt = 31;
        return {
          health: {
            status: 'auth_failed',
            last_probed_at: FIXED_NOW + 2,
          },
          connection_updated_at: savedUpdatedAt,
          credential_correction: {
            auth_type: 'bearer',
            field_keys: ['auth.token'],
          },
        };
      },
    });
    await panel.mount.whenLoaded();
    panel.click({
      action: 'connections-review-credential-rotation',
      kind: 'api',
      name: 'still-rejected',
    });
    panel.click({ action: 'connections-confirm-credential-handoff' });
    await tick();
    panel.click({
      action: 'connections-check-saved-after-safe-stop',
      kind: 'api',
      name: 'still-rejected',
    });
    await tick();

    expect(panel.mount.getState().dialog.recentProbe).toMatchObject({
      purpose: 'post_safe_stop',
      resolution: 'reopen',
      status: 'auth_failed',
      credential_correction: {
        auth_type: 'bearer',
        field_keys: ['auth.token'],
      },
    });
    expect(panel.mount.getState().credentialRotationRecovery).toBeNull();
    expect(panel.getHtml()).toContain('The key you saved still needs a look');
    expect(panel.getHtml()).toContain('Look at the key you saved');
    expect(panel.getHtml()).not.toContain(SAFE_STOP_TOKEN);
    expect(tabs.notifyPostSafeStopVerificationChanged).toHaveBeenCalledOnce();

    panel.click({
      action: 'connections-review-post-safe-stop',
      kind: 'api',
      name: 'still-rejected',
    });

    expect(panel.mount.getState().dialog).toMatchObject({
      stage: 'form',
      mode: 'edit',
      editingId: 'api/still-rejected',
      credentialCorrection: {
        fieldKeys: ['auth.token'],
      },
    });
    expect(panel.mount.getState().dialog.values['auth.token']).toBeUndefined();
    expect(panel.mount.getState().dialog.credentialCorrection?.safeStopClosure)
      .toBeUndefined();
    expect(panel.mount.getState().credentialRotationRecovery).toBeNull();
    expect(panel.getHtml()).toContain(
      'The earlier stop stays closed',
    );
    panel.mount.dispose();
  });

  it('keeps an unreachable post-ack check retryable and binds the retry to the refreshed row', async () => {
    let savedUpdatedAt = 40;
    let probeCount = 0;
    const saved = connection('retry-after-ack', {
      base_url: 'https://private.example.test',
      auth_type: 'bearer',
      updated_at: savedUpdatedAt,
    });
    const panel = mountPanel({
      runList: async () => ({
        connections: [{ ...saved, updated_at: savedUpdatedAt }],
      }),
      runProbe: async () => {
        probeCount += 1;
        savedUpdatedAt += 1;
        return {
          health: {
            status: probeCount === 1 ? 'unreachable' : 'ok',
            last_probed_at: FIXED_NOW + probeCount,
          },
          connection_updated_at: savedUpdatedAt,
        };
      },
    });
    await panel.mount.whenLoaded();
    panel.click({
      action: 'connections-edit',
      kind: 'api',
      name: 'retry-after-ack',
    });
    panel.mount.getState().dialog.credentialSafeStopClosureNotice = {
      kind: 'api',
      name: 'retry-after-ack',
      nextStep: 'check_saved_connection',
    };

    panel.click({
      action: 'connections-check-saved-after-safe-stop',
      kind: 'api',
      name: 'retry-after-ack',
    });
    await tick();

    expect(panel.calls.runProbe).toHaveBeenNthCalledWith(1, {
      kind: 'api',
      name: 'retry-after-ack',
      expected_updated_at: 40,
    });
    expect(panel.mount.getState().dialog.recentProbe).toMatchObject({
      purpose: 'post_safe_stop',
      resolution: 'retry',
      status: 'unreachable',
    });
    expect(panel.getHtml()).toContain('Recued could not reach them');
    expect(panel.getHtml()).toContain('Check again');

    panel.click({
      action: 'connections-recheck-post-safe-stop',
      kind: 'api',
      name: 'retry-after-ack',
    });
    await tick();

    expect(panel.calls.runProbe).toHaveBeenNthCalledWith(2, {
      kind: 'api',
      name: 'retry-after-ack',
      expected_updated_at: 41,
    });
    expect(panel.mount.getState().dialog.recentProbe).toMatchObject({
      purpose: 'post_safe_stop',
      resolution: 'resolved',
      status: 'ok',
    });
    expect(panel.getHtml()).toContain('Checked, and it is sorted');
    panel.mount.dispose();
  });

  it('asks for a paired-server update when an older probe cannot bind its result to an exact row', async () => {
    const tabs = rotationTabs();
    const saved = connection('old-server-check', {
      auth_type: 'bearer',
      updated_at: 45,
    });
    const panel = mountPanel({
      credentialRotationTabConvergence: tabs.convergence,
      runList: async () => ({ connections: [saved] }),
      runProbe: async () => ({
        health: { status: 'ok', last_probed_at: FIXED_NOW + 1 },
      }),
    });
    await panel.mount.whenLoaded();
    panel.click({
      action: 'connections-edit',
      kind: 'api',
      name: 'old-server-check',
    });
    panel.mount.getState().dialog.credentialSafeStopClosureNotice = {
      kind: 'api',
      name: 'old-server-check',
      nextStep: 'check_saved_connection',
    };

    panel.click({
      action: 'connections-check-saved-after-safe-stop',
      kind: 'api',
      name: 'old-server-check',
    });
    await tick();

    expect(panel.mount.getState().dialog.recentProbe).toMatchObject({
      purpose: 'post_safe_stop',
      resolution: 'unsupported',
      status: 'ok',
    });
    expect(panel.getHtml()).toContain('Your server needs updating before it can check this');
    expect(panel.getHtml()).toContain('Check once it is updated');
    expect(tabs.notifyPostSafeStopVerificationChanged).not.toHaveBeenCalled();
    panel.mount.dispose();
  });

  it('restores an unresolved post-ack check from a cold authoritative list without replaying the closure receipt', async () => {
    const saved = connection('cold-post-ack-check', {
      auth_type: 'bearer',
      updated_at: 50,
    });
    const panel = mountPanel({
      runList: async () => ({
        connections: [saved],
        credential_post_safe_stop_verifications: [{
          kind: 'api',
          name: 'cold-post-ack-check',
          status: 'pending',
          acknowledged_at: 49,
        }],
      }),
    });
    await panel.mount.whenLoaded();

    expect(panel.mount.getState().credentialRotationRecovery).toBeNull();
    expect(panel.mount.getState().dialog.credentialSafeStopClosureNotice)
      .toBeNull();
    expect(panel.mount.getState().dialog.recentProbe).toMatchObject({
      kind: 'api',
      name: 'cold-post-ack-check',
      status: 'pending',
      purpose: 'post_safe_stop',
      resolution: 'retry',
    });
    expect(panel.getHtml()).toContain('The connection you saved still needs checking');
    expect(panel.getHtml()).toContain('Check again');
    expect(panel.getHtml()).not.toContain('Recovery stop closed');
    panel.mount.dispose();
  });

  it('holds a cross-profile recovery on a neutral landing until the owner chooses a server', async () => {
    const openServerProfiles = vi.fn();
    const settleProfileHandoff = vi.fn();
    const saved = connection('shared-name', {
      auth_type: 'bearer',
      updated_at: 50,
    });
    const panel = mountPanel({
      postSafeStopProfileLabel: 'Office server',
      postSafeStopProfileHandoff: {
        reason: 'profile_mismatch',
        activeProfileLabel: 'Office server',
        sourceProfileLabel: 'Home server',
        serverProfilesAvailable: true,
      },
      onOpenPostSafeStopServerProfiles: openServerProfiles,
      onPostSafeStopProfileHandoffSettled: settleProfileHandoff,
      runList: async () => ({
        connections: [saved],
        credential_post_safe_stop_verifications: [{
          kind: 'api',
          name: 'shared-name',
          status: 'pending',
          acknowledged_at: 49,
        }],
      }),
    });
    await panel.mount.whenLoaded();

    expect(panel.mount.getState().postSafeStopRecoveries).toHaveLength(1);
    expect(panel.mount.getState().dialog.recentProbe).toBeNull();
    expect(panel.getHtml()).toContain('This belongs to a different server');
    expect(panel.getHtml()).toContain('Home server');
    expect(panel.getHtml()).toContain('Office server');
    expect(panel.getHtml()).toContain(
      'did not open or check a same-named connection on this server',
    );

    panel.click({ action: 'connections-open-post-safe-stop-profile' });
    expect(openServerProfiles).toHaveBeenCalledTimes(1);
    expect(settleProfileHandoff).not.toHaveBeenCalled();
    expect(panel.mount.getState().dialog.recentProbe).toBeNull();

    panel.click({ action: 'connections-review-active-post-safe-stop' });
    expect(panel.mount.getState().dialog.recentProbe).toMatchObject({
      kind: 'api',
      name: 'shared-name',
      resolution: 'retry',
    });
    expect(settleProfileHandoff).toHaveBeenCalledTimes(1);
    expect(panel.getHtml()).not.toContain(
      'This belongs to a different server',
    );
    expect(panel.getHtml()).toContain('Server profile: Office server');
    panel.mount.dispose();
  });

  it('keeps a dismissed profile handoff neutral across authoritative refreshes', async () => {
    const settleProfileHandoff = vi.fn();
    const saved = connection('shared-name', {
      auth_type: 'bearer',
      updated_at: 50,
    });
    const panel = mountPanel({
      postSafeStopProfileHandoff: {
        reason: 'unbound',
        activeProfileLabel: 'Office server',
        serverProfilesAvailable: false,
      },
      onPostSafeStopProfileHandoffSettled: settleProfileHandoff,
      runList: async () => ({
        connections: [saved],
        credential_post_safe_stop_verifications: [{
          kind: 'api',
          name: 'shared-name',
          status: 'pending',
          acknowledged_at: 49,
        }],
      }),
    });
    await panel.mount.whenLoaded();

    panel.click({ action: 'connections-dismiss-post-safe-stop-profile' });
    expect(settleProfileHandoff).toHaveBeenCalledTimes(1);
    expect(panel.mount.getState().dialog.recentProbe).toBeNull();
    expect(panel.getHtml()).not.toContain(
      'Recued has to check this link against a server',
    );

    await panel.mount.refresh();
    expect(panel.mount.getState().postSafeStopRecoveries).toHaveLength(1);
    expect(panel.mount.getState().dialog.recentProbe).toBeNull();
    expect(settleProfileHandoff).toHaveBeenCalledTimes(1);
    panel.mount.dispose();
  });

  it('selects an exact post-ack target, then advances a one-shot success receipt to the next unresolved connection', async () => {
    const first = connection('first-check', {
      auth_type: 'bearer',
      updated_at: 70,
    });
    const next = connection('next-reopen', {
      kind: 'mcp',
      auth_type: 'bearer',
      updated_at: 80,
    });
    const nextSummary: ConnectionCredentialPostSafeStopVerificationSummary = {
      kind: 'mcp',
      name: 'next-reopen',
      status: 'auth_failed',
      acknowledged_at: 74,
      checked_at: 79,
      connection_updated_at: 80,
      credential_correction: {
        auth_type: 'bearer',
        field_keys: ['auth.token'],
      },
    };
    let checkedFirst = false;
    const panel = mountPanel({
      initialPostSafeStopRecovery: { kind: 'api', name: 'first-check' },
      runList: async () => ({
        connections: [first, next],
        // Put the requested item second to prove the exact Attention landing
        // wins over server queue order on the first authoritative snapshot.
        credential_post_safe_stop_verifications: checkedFirst
          ? [nextSummary]
          : [
              nextSummary,
              {
                kind: 'api',
                name: 'first-check',
                status: 'pending',
                acknowledged_at: 75,
              },
            ],
      }),
      runProbe: async () => {
        checkedFirst = true;
        return {
          health: { status: 'ok', last_probed_at: 76 },
          connection_updated_at: 70,
        };
      },
    });
    await panel.mount.whenLoaded();

    expect(panel.mount.getState().dialog.recentProbe).toMatchObject({
      kind: 'api',
      name: 'first-check',
      resolution: 'retry',
    });
    expect(panel.mount.getState().postSafeStopRecoveries).toHaveLength(2);

    panel.click({
      action: 'connections-recheck-post-safe-stop',
      kind: 'api',
      name: 'first-check',
    });
    await tick();

    expect(panel.mount.getState().dialog.recentProbe).toMatchObject({
      kind: 'api',
      name: 'first-check',
      status: 'ok',
      resolution: 'resolved',
    });
    expect(panel.mount.getState().postSafeStopRecoveries.map((item) => item.name))
      .toEqual(['next-reopen']);
    expect(panel.getHtml()).toContain('Checked, and it is sorted');
    expect(panel.getHtml()).toContain('1 other connection still needs recovery');
    expect(panel.getHtml()).toContain('Continue to next');

    panel.click({
      action: 'connections-continue-post-safe-stop',
      kind: 'mcp',
      name: 'next-reopen',
    });

    expect(panel.mount.getState().dialog.recentProbe).toMatchObject({
      kind: 'mcp',
      name: 'next-reopen',
      status: 'auth_failed',
      resolution: 'reopen',
    });
    expect(panel.getHtml()).not.toContain('Checked, and it is sorted');
    expect(panel.getHtml()).toContain('Look at the key you saved');
    panel.mount.dispose();

    const reloaded = mountPanel({
      initialPostSafeStopRecovery: { kind: 'api', name: 'first-check' },
      runList: async () => ({
        connections: [first, next],
        credential_post_safe_stop_verifications: [nextSummary],
      }),
    });
    await reloaded.mount.whenLoaded();
    expect(reloaded.mount.getState().dialog.recentProbe).toMatchObject({
      kind: 'mcp',
      name: 'next-reopen',
      resolution: 'reopen',
    });
    expect(reloaded.getHtml()).not.toContain('Checked, and it is sorted');
    reloaded.mount.dispose();
  });

  it('preserves a removed-item closure across refresh so the next recovery remains actionable', async () => {
    const tabs = rotationTabs();
    const removed = connection('removed-check', {
      auth_type: 'bearer',
      updated_at: 90,
    });
    const next = connection('remaining-check', {
      kind: 'mcp',
      auth_type: 'bearer',
      updated_at: 91,
    });
    const nextSummary: ConnectionCredentialPostSafeStopVerificationSummary = {
      kind: 'mcp',
      name: 'remaining-check',
      status: 'pending',
      acknowledged_at: 89,
    };
    let removedFromServer = false;
    const panel = mountPanel({
      credentialRotationTabConvergence: tabs.convergence,
      initialPostSafeStopRecovery: { kind: 'api', name: 'removed-check' },
      runList: async () => ({
        connections: removedFromServer ? [next] : [removed, next],
        credential_post_safe_stop_verifications: removedFromServer
          ? [nextSummary]
          : [
              {
                kind: 'api',
                name: 'removed-check',
                status: 'pending',
                acknowledged_at: 90,
              },
              nextSummary,
            ],
      }),
      runProbe: async () => {
        removedFromServer = true;
        throw new RpcError(
          'not_found',
          'The connection no longer exists.',
          404,
          'collection.connection.probe',
        );
      },
    });
    await panel.mount.whenLoaded();

    panel.click({
      action: 'connections-recheck-post-safe-stop',
      kind: 'api',
      name: 'removed-check',
    });
    await tick();

    expect(panel.mount.getState().dialog.recentProbe).toMatchObject({
      kind: 'api',
      name: 'removed-check',
      resolution: 'removed',
    });
    expect(panel.getHtml()).toContain('That connection is gone');
    expect(panel.getHtml()).toContain('Continue to next');

    await panel.mount.refresh();

    expect(panel.mount.getState().dialog.recentProbe).toMatchObject({
      kind: 'api',
      name: 'removed-check',
      resolution: 'removed',
    });
    expect(panel.mount.getState().postSafeStopRecoveries.map((item) => item.name))
      .toEqual(['remaining-check']);
    expect(panel.getHtml()).toContain('Continue to next');
    panel.mount.dispose();
  });

  it('replaces an old success receipt when the same connection becomes unresolved again', async () => {
    const saved = connection('reopened-check', {
      auth_type: 'bearer',
      updated_at: 100,
    });
    let summaries: ConnectionCredentialPostSafeStopVerificationSummary[] = [{
      kind: 'api',
      name: 'reopened-check',
      status: 'pending',
      acknowledged_at: 99,
    }];
    const panel = mountPanel({
      runList: async () => ({
        connections: [saved],
        credential_post_safe_stop_verifications: summaries,
      }),
      runProbe: async () => {
        summaries = [];
        return {
          health: { status: 'ok', last_probed_at: 101 },
          connection_updated_at: 100,
        };
      },
    });
    await panel.mount.whenLoaded();

    panel.click({
      action: 'connections-recheck-post-safe-stop',
      kind: 'api',
      name: 'reopened-check',
    });
    await tick();
    expect(panel.getHtml()).toContain('Checked, and it is sorted');

    summaries = [{
      kind: 'api',
      name: 'reopened-check',
      status: 'auth_failed',
      acknowledged_at: 102,
      checked_at: 103,
      connection_updated_at: 100,
      credential_correction: {
        auth_type: 'bearer',
        field_keys: ['auth.token'],
      },
    }];
    await panel.mount.refresh();

    expect(panel.mount.getState().dialog.recentProbe).toMatchObject({
      kind: 'api',
      name: 'reopened-check',
      status: 'auth_failed',
      resolution: 'reopen',
    });
    expect(panel.getHtml()).not.toContain('Checked, and it is sorted');
    expect(panel.getHtml()).toContain('Look at the key you saved');
    panel.mount.dispose();
  });

  it('lets a causally later same-connection reopen overtake the probe result immediately', async () => {
    const saved = connection('racing-reopen', {
      auth_type: 'bearer',
      updated_at: 110,
    });
    let summaries: ConnectionCredentialPostSafeStopVerificationSummary[] = [{
      kind: 'api',
      name: 'racing-reopen',
      status: 'pending',
      acknowledged_at: 109,
    }];
    const panel = mountPanel({
      runList: async () => ({
        connections: [saved],
        credential_post_safe_stop_verifications: summaries,
      }),
      runProbe: async () => {
        summaries = [{
          kind: 'api',
          name: 'racing-reopen',
          status: 'auth_failed',
          acknowledged_at: 112,
          checked_at: 113,
          connection_updated_at: 110,
          credential_correction: {
            auth_type: 'bearer',
            field_keys: ['auth.token'],
          },
        }];
        return {
          health: { status: 'ok', last_probed_at: 111 },
          connection_updated_at: 110,
        };
      },
    });
    await panel.mount.whenLoaded();

    panel.click({
      action: 'connections-recheck-post-safe-stop',
      kind: 'api',
      name: 'racing-reopen',
    });
    await tick();

    expect(panel.mount.getState().dialog.recentProbe).toMatchObject({
      kind: 'api',
      name: 'racing-reopen',
      status: 'auth_failed',
      resolution: 'reopen',
    });
    expect(panel.getHtml()).not.toContain('Checked, and it is sorted');
    expect(panel.getHtml()).toContain('Look at the key you saved');
    panel.mount.dispose();
  });

  it('converges a sibling-discovered fresh rejection and authoritative closure through list sidecars', async () => {
    const tabs = rotationTabs();
    const saved = connection('sibling-post-ack', {
      auth_type: 'bearer',
      updated_at: 61,
    });
    let summaries: ConnectionCredentialPostSafeStopVerificationSummary[] = [];
    const panel = mountPanel({
      credentialRotationTabConvergence: tabs.convergence,
      runList: async () => ({
        connections: [saved],
        credential_post_safe_stop_verifications: summaries,
      }),
    });
    await panel.mount.whenLoaded();
    expect(panel.mount.getState().dialog.recentProbe).toBeNull();

    summaries = [{
      kind: 'api',
      name: 'sibling-post-ack',
      status: 'auth_failed',
      acknowledged_at: 59,
      checked_at: 60,
      connection_updated_at: 61,
      credential_correction: {
        auth_type: 'bearer',
        field_keys: ['auth.token'],
      },
    }];
    tabs.emit({ type: 'reconcile' });
    await tick();

    expect(panel.mount.getState().dialog.recentProbe).toMatchObject({
      kind: 'api',
      name: 'sibling-post-ack',
      status: 'auth_failed',
      purpose: 'post_safe_stop',
      resolution: 'reopen',
    });
    expect(panel.getHtml()).toContain('Look at the key you saved');

    summaries = [];
    tabs.emit({ type: 'reconcile' });
    await tick();

    expect(panel.mount.getState().dialog.recentProbe).toBeNull();
    expect(panel.getHtml()).not.toContain('The key you saved still needs a look');
    panel.mount.dispose();
  });

  it('keeps the cold-list closure capability when result settles later', async () => {
    const continuity = rotationContinuity();
    expect(continuity.store.write({
      attemptId: 'rotation-cold-race-0001',
      kind: 'api',
      name: 'cold-race-stop',
      baselineUpdatedAt: 15,
    })).toBe('stored');
    const status = deferred<{
      outcome: ConnectionCredentialRotationOutcome;
    }>();
    const saved = connection('cold-race-stop', {
      auth_type: 'bearer',
      updated_at: 15,
    });
    const panel = mountPanel({
      credentialRotationContinuity: continuity.store,
      runList: async () => ({
        connections: [saved],
        credential_rotation_safe_stops: [{
          kind: 'api',
          name: 'cold-race-stop',
          finished_at: FIXED_NOW,
          correction: safeStopCorrection(),
          acknowledgement_token: SAFE_STOP_TOKEN,
        }],
      }),
      runCredentialRotationStatus: () => status.promise,
      runCredentialRotationActivity: async () => safeStopActivity(),
    });
    await tick();
    status.resolve({
      outcome: {
        status: 'failed',
        started_at: FIXED_NOW - 1,
        finished_at: FIXED_NOW,
        reason: 'auth_failed',
        correction: safeStopCorrection(),
      },
    });
    await panel.mount.whenLoaded();

    expect(panel.mount.getState().credentialRotationRecovery).toMatchObject({
      phase: 'safe_stopped',
      name: 'cold-race-stop',
    });
    panel.click({
      action: 'connections-review-credential-rotation',
      kind: 'api',
      name: 'cold-race-stop',
    });
    expect(panel.mount.getState().dialog.credentialCorrection?.safeStopClosure)
      .toEqual({ phase: 'ready', error: null });
    expect(panel.getHtml()).toContain('Provider/admin confirmed a fix');
    expect(panel.getHtml()).not.toContain(SAFE_STOP_TOKEN);
    panel.mount.dispose();
  });

  it('does not let an older acknowledged receipt clear a newer cold-list safe stop', async () => {
    const continuity = rotationContinuity();
    expect(continuity.store.write({
      attemptId: 'rotation-older-acknowledged-0001',
      kind: 'api',
      name: 'newer-safe-stop',
      baselineUpdatedAt: 15,
    })).toBe('stored');
    const status = deferred<{
      outcome: ConnectionCredentialRotationOutcome;
    }>();
    const newerToken = 'd'.repeat(64);
    const listCalled = deferred<void>();
    const activity = vi.fn<ConnectionsCredentialRotationActivityCaller>(
      async () => safeStopActivity('bearer', undefined, newerToken),
    );
    const panel = mountPanel({
      credentialRotationContinuity: continuity.store,
      runList: async () => {
        listCalled.resolve();
        return {
          connections: [connection('newer-safe-stop', {
            auth_type: 'bearer',
            updated_at: 15,
          })],
          credential_rotation_safe_stops: [{
            kind: 'api' as const,
            name: 'newer-safe-stop',
            finished_at: FIXED_NOW + 2,
            correction: safeStopCorrection(),
            acknowledgement_token: newerToken,
          }],
        };
      },
      runCredentialRotationStatus: () => status.promise,
      runCredentialRotationActivity: activity,
    });
    await listCalled.promise;
    for (let i = 0; i < 5; i += 1) {
      if (
        panel.mount.getState().credentialRotationRecovery?.phase
          === 'safe_stopped'
      ) break;
      await tick();
    }
    expect(panel.mount.getState().credentialRotationRecovery).toMatchObject({
      name: 'newer-safe-stop',
      phase: 'safe_stopped',
    });

    // This response was authoritative when produced, but is causally older
    // than the list projection that has already landed in this tab.
    status.resolve({
      outcome: {
        status: 'failed',
        started_at: FIXED_NOW - 2,
        finished_at: FIXED_NOW - 1,
        reason: 'auth_failed',
        safe_stop_acknowledged_at: FIXED_NOW,
      },
    });
    await panel.mount.whenLoaded();

    expect(activity).toHaveBeenCalledWith({
      kind: 'api',
      name: 'newer-safe-stop',
    });
    expect(panel.mount.getState().credentialRotationRecovery).toMatchObject({
      name: 'newer-safe-stop',
      phase: 'safe_stopped',
    });
    expect(continuity.store.read()).not.toBeNull();
    expect(panel.mount.getState().dialog.credentialSafeStopClosureNotice)
      .toBeNull();
    panel.click({
      action: 'connections-review-credential-rotation',
      kind: 'api',
      name: 'newer-safe-stop',
    });
    expect(panel.mount.getState().dialog.credentialCorrection?.safeStopClosure)
      .toEqual({ phase: 'ready', error: null });
    expect(panel.getHtml()).not.toContain(newerToken);
    panel.mount.dispose();
  });

  it('keeps route work guarded through the acknowledgement write and authoritative reread', async () => {
    const acknowledgement = deferred<{
      acknowledgement: ConnectionCredentialRotationSafeStopAcknowledgement;
    }>();
    const activity = deferred<{
      activity: ConnectionCredentialRotationActivity;
    }>();
    const panel = mountPanel({
      runList: async () => ({
        connections: [connection('guarded-safe-stop', {
          auth_type: 'bearer',
          updated_at: 15,
        })],
        credential_rotation_safe_stops: [{
          kind: 'api',
          name: 'guarded-safe-stop',
          finished_at: FIXED_NOW,
          correction: safeStopCorrection(),
          acknowledgement_token: SAFE_STOP_TOKEN,
        }],
      }),
      runAcknowledgeCredentialRotationSafeStop: () => acknowledgement.promise,
      runCredentialRotationActivity: () => activity.promise,
    });
    await panel.mount.whenLoaded();
    panel.click({
      action: 'connections-review-credential-rotation',
      kind: 'api',
      name: 'guarded-safe-stop',
    });

    panel.click({ action: 'connections-confirm-credential-handoff' });
    expect(panel.mount.getState().dialog.credentialCorrection?.safeStopClosure)
      .toMatchObject({ phase: 'acknowledging' });
    expect(panel.mount.hasInFlightWork()).toBe(true);

    acknowledgement.resolve({
      acknowledgement: {
        status: 'acknowledged',
        acknowledged_at: FIXED_NOW + 1,
      },
    });
    await tick();
    expect(panel.calls.runCredentialRotationActivity).toHaveBeenCalledOnce();
    expect(panel.mount.hasInFlightWork()).toBe(true);

    activity.resolve({ activity: { status: 'idle', safe_stop: null } });
    await tick();
    expect(panel.mount.hasInFlightWork()).toBe(false);
    expect(panel.mount.getState().dialog.credentialSafeStopClosureNotice)
      .toMatchObject({ nextStep: 'check_saved_connection' });
    panel.mount.dispose();
  });

  it('retires an interrupted acknowledged receipt without replaying it and wakes sibling tabs', async () => {
    const continuity = rotationContinuity();
    const tabs = rotationTabs();
    expect(continuity.store.write({
      attemptId: 'rotation-acknowledged-reload-0001',
      kind: 'api',
      name: 'acknowledged-reload',
      baselineUpdatedAt: 15,
    })).toBe('stored');
    const panel = mountPanel({
      connections: [connection('acknowledged-reload', {
        auth_type: 'bearer',
        updated_at: 15,
      })],
      credentialRotationContinuity: continuity.store,
      credentialRotationTabConvergence: tabs.convergence,
      runCredentialRotationStatus: async () => ({
        outcome: {
          status: 'failed',
          started_at: FIXED_NOW - 1,
          finished_at: FIXED_NOW,
          reason: 'auth_failed',
          safe_stop_acknowledged_at: FIXED_NOW + 1,
        },
      }),
    });
    await panel.mount.whenLoaded();

    expect(continuity.store.read()).toBeNull();
    expect(panel.mount.getState().credentialRotationRecovery).toBeNull();
    expect(panel.getHtml()).not.toContain('Resume credential recovery');
    expect(panel.getHtml()).not.toContain('Recovery stop closed');
    expect(tabs.notifyCredentialRotationSafeStopResolved).toHaveBeenCalledWith({
      kind: 'api',
      name: 'acknowledged-reload',
    });
    panel.mount.dispose();
  });

  it('does not trust a malformed acknowledged timestamp to clear recovery', async () => {
    const continuity = rotationContinuity();
    expect(continuity.store.write({
      attemptId: 'rotation-malformed-ack-0001',
      kind: 'api',
      name: 'malformed-ack',
      baselineUpdatedAt: 15,
    })).toBe('stored');
    const panel = mountPanel({
      connections: [connection('malformed-ack', {
        auth_type: 'bearer',
        updated_at: 15,
      })],
      credentialRotationContinuity: continuity.store,
      runCredentialRotationStatus: async () => ({
        outcome: {
          status: 'failed',
          started_at: FIXED_NOW - 1,
          finished_at: FIXED_NOW,
          reason: 'auth_failed',
          correction: safeStopCorrection(),
          safe_stop_acknowledged_at: 'forged' as unknown as number,
        },
      }),
    });
    await panel.mount.whenLoaded();

    expect(continuity.store.read()).not.toBeNull();
    expect(panel.mount.getState().credentialRotationRecovery).toMatchObject({
      phase: 'failed',
      correction: {
        triage: { resolution: 'regenerate_credential_or_contact_admin' },
      },
    });
    panel.mount.dispose();
  });

  it('reports a bounded cold safe-stop queue and rejects the whole malformed projection', async () => {
    const first = connection('newest-safe-stop', {
      auth_type: 'bearer',
      updated_at: 20,
    });
    const second = connection('older-safe-stop', {
      auth_type: 'bearer',
      updated_at: 10,
    });
    let newestClosed = false;
    const valid = mountPanel({
      runList: async () => ({
        connections: [first, second],
        credential_rotation_safe_stops: [
          ...(newestClosed
            ? []
            : [{
                kind: 'api' as const,
                name: 'newest-safe-stop',
                finished_at: FIXED_NOW + 2,
                correction: safeStopCorrection(),
                acknowledgement_token: 'b'.repeat(64),
              }]),
          {
            kind: 'api',
            name: 'older-safe-stop',
            finished_at: FIXED_NOW + 1,
            correction: safeStopCorrection(),
            acknowledgement_token: 'c'.repeat(64),
          },
        ],
      }),
      runAcknowledgeCredentialRotationSafeStop: async () => {
        newestClosed = true;
        return {
          acknowledgement: {
            status: 'acknowledged',
            acknowledged_at: FIXED_NOW + 3,
          },
        };
      },
      runCredentialRotationActivity: async () => ({
        activity: { status: 'idle', safe_stop: null },
      }),
    });
    await valid.mount.whenLoaded();
    expect(valid.mount.getState().credentialRotationRecovery).toMatchObject({
      name: 'newest-safe-stop',
      outstandingSafeStopCount: 2,
    });
    expect(valid.getHtml()).toContain('1 other connection also needs recovery');
    expect(valid.getHtml()).toContain(
      'offer the next one when you return to the list',
    );
    expect(valid.getHtml()).not.toMatch(/[bc]{64}/);
    valid.click({
      action: 'connections-review-credential-rotation',
      kind: 'api',
      name: 'newest-safe-stop',
    });
    valid.click({ action: 'connections-confirm-credential-handoff' });
    await tick();
    valid.click({
      action: 'connections-check-saved-after-safe-stop',
      kind: 'api',
      name: 'newest-safe-stop',
    });
    await tick();
    expect(valid.mount.getState().credentialRotationRecovery).toMatchObject({
      name: 'older-safe-stop',
      outstandingSafeStopCount: 1,
    });
    expect(valid.getHtml()).toContain('api/older-safe-stop');
    valid.mount.dispose();

    const malformed = mountPanel({
      runList: async () => ({
        connections: [first, second],
        credential_rotation_safe_stops: [{
          kind: 'api',
          name: 'newest-safe-stop',
          finished_at: FIXED_NOW + 2,
          correction: safeStopCorrection(),
          acknowledgement_token: 'b'.repeat(64),
        }, {
          kind: 'api',
          name: 'orphaned-safe-stop',
          finished_at: FIXED_NOW + 1,
          correction: safeStopCorrection(),
          acknowledgement_token: 'not-an-opaque-token',
        }],
      }),
    });
    await malformed.mount.whenLoaded();
    expect(malformed.mount.getState().credentialRotationRecovery).toBeNull();
    expect(malformed.getHtml()).not.toContain('Resume credential recovery');
    malformed.mount.dispose();
  });

  it('treats a sibling closure message as a wake-up and re-reads server authority before unlocking', async () => {
    const tabs = rotationTabs();
    const panel = mountPanel({
      runList: async () => ({
        connections: [connection('sibling-closed-stop', {
          auth_type: 'bearer',
          updated_at: 12,
        })],
        credential_rotation_safe_stops: [{
          kind: 'api',
          name: 'sibling-closed-stop',
          finished_at: FIXED_NOW,
          correction: safeStopCorrection(),
          acknowledgement_token: SAFE_STOP_TOKEN,
        }],
      }),
      credentialRotationTabConvergence: tabs.convergence,
      runCredentialRotationActivity: async () => ({
        activity: { status: 'idle', safe_stop: null },
      }),
    });
    await panel.mount.whenLoaded();
    panel.click({
      action: 'connections-review-credential-rotation',
      kind: 'api',
      name: 'sibling-closed-stop',
    });

    tabs.emit({
      type: 'credential_rotation_safe_stop_resolved',
      kind: 'api',
      name: 'sibling-closed-stop',
    });
    await tick();

    expect(panel.calls.runCredentialRotationActivity).toHaveBeenCalledWith({
      kind: 'api',
      name: 'sibling-closed-stop',
    });
    expect(panel.calls.runAcknowledgeCredentialRotationSafeStop)
      .not.toHaveBeenCalled();
    expect(panel.mount.getState().dialog.credentialCorrection).toBeNull();
    expect(panel.mount.getState().dialog.credentialSafeStopClosureNotice)
      .toMatchObject({ nextStep: 'check_saved_connection' });
    expect(panel.getHtml()).toContain('Go back and check connection');
    expect(panel.getHtml()).not.toContain(SAFE_STOP_TOKEN);
    panel.mount.dispose();
  });

  it('keeps a newer safe stop blocked when a stale acknowledgement token is superseded', async () => {
    const newerToken = 'd'.repeat(64);
    const acknowledge = vi.fn<
      ConnectionsAcknowledgeCredentialRotationSafeStopCaller
    >()
      .mockResolvedValueOnce({ acknowledgement: { status: 'superseded' } })
      .mockResolvedValueOnce({
        acknowledgement: {
          status: 'acknowledged',
          acknowledged_at: FIXED_NOW + 10,
        },
      });
    const activity = vi.fn<ConnectionsCredentialRotationActivityCaller>()
      .mockResolvedValueOnce(safeStopActivity(
        'bearer',
        undefined,
        newerToken,
      ))
      .mockResolvedValueOnce({
        activity: { status: 'idle', safe_stop: null },
      });
    const panel = mountPanel({
      runList: async () => ({
        connections: [connection('stale-closure', {
          auth_type: 'bearer',
          updated_at: 12,
        })],
        credential_rotation_safe_stops: [{
          kind: 'api',
          name: 'stale-closure',
          finished_at: FIXED_NOW,
          correction: safeStopCorrection(),
          acknowledgement_token: SAFE_STOP_TOKEN,
        }],
      }),
      runAcknowledgeCredentialRotationSafeStop: acknowledge,
      runCredentialRotationActivity: activity,
    });
    await panel.mount.whenLoaded();
    panel.click({
      action: 'connections-review-credential-rotation',
      kind: 'api',
      name: 'stale-closure',
    });

    panel.click({ action: 'connections-confirm-credential-handoff' });
    await tick();
    expect(acknowledge).toHaveBeenNthCalledWith(1, {
      kind: 'api',
      name: 'stale-closure',
      acknowledgement_token: SAFE_STOP_TOKEN,
    });
    expect(panel.mount.getState().credentialRotationRecovery?.phase)
      .toBe('safe_stopped');
    expect(panel.mount.getState().dialog.credentialCorrection).not.toBeNull();
    expect(panel.mount.getState().dialog.credentialSafeStopClosureNotice)
      .toBeNull();
    expect(panel.submitBtn.hasAttribute('disabled')).toBe(true);

    panel.click({ action: 'connections-confirm-credential-handoff' });
    await tick();
    expect(acknowledge).toHaveBeenNthCalledWith(2, {
      kind: 'api',
      name: 'stale-closure',
      acknowledgement_token: newerToken,
    });
    expect(panel.mount.getState().credentialRotationRecovery).toBeNull();
    expect(panel.mount.getState().dialog.credentialSafeStopClosureNotice)
      .toMatchObject({ nextStep: 'check_saved_connection' });
    expect(panel.getHtml()).not.toContain(newerToken);
    panel.mount.dispose();
  });

  it('keeps an uncertain acknowledgement blocked and safely repeats the same server closure check', async () => {
    const acknowledge = vi.fn<
      ConnectionsAcknowledgeCredentialRotationSafeStopCaller
    >()
      .mockRejectedValueOnce(new Error('reply lost after write'))
      .mockResolvedValueOnce({
        acknowledgement: {
          status: 'already_acknowledged',
          acknowledged_at: FIXED_NOW + 1,
        },
      });
    const activity = vi.fn<ConnectionsCredentialRotationActivityCaller>()
      .mockRejectedValueOnce(new Error('server reconnecting'))
      .mockResolvedValueOnce({
        activity: { status: 'idle', safe_stop: null },
      });
    const panel = mountPanel({
      runList: async () => ({
        connections: [connection('uncertain-closure', {
          auth_type: 'bearer',
          updated_at: 12,
        })],
        credential_rotation_safe_stops: [{
          kind: 'api',
          name: 'uncertain-closure',
          finished_at: FIXED_NOW,
          correction: safeStopCorrection(),
          acknowledgement_token: SAFE_STOP_TOKEN,
        }],
      }),
      runAcknowledgeCredentialRotationSafeStop: acknowledge,
      runCredentialRotationActivity: activity,
    });
    await panel.mount.whenLoaded();
    panel.click({
      action: 'connections-review-credential-rotation',
      kind: 'api',
      name: 'uncertain-closure',
    });

    panel.click({ action: 'connections-confirm-credential-handoff' });
    await tick();
    expect(panel.mount.getState().dialog.credentialCorrection?.safeStopClosure)
      .toMatchObject({ phase: 'unconfirmed' });
    expect(panel.getHtml()).toContain('Check server closure');
    expect(panel.submitBtn.hasAttribute('disabled')).toBe(true);
    expect(panel.getHtml()).not.toContain(SAFE_STOP_TOKEN);

    panel.click({ action: 'connections-confirm-credential-handoff' });
    await tick();
    expect(acknowledge).toHaveBeenCalledTimes(2);
    expect(acknowledge.mock.calls[0]).toEqual(acknowledge.mock.calls[1]);
    expect(panel.mount.getState().dialog.credentialCorrection).toBeNull();
    expect(panel.mount.getState().dialog.credentialSafeStopClosureNotice)
      .toMatchObject({ nextStep: 'check_saved_connection' });
    panel.mount.dispose();
  });

  it('routes a mismatched local auth draft through explicit discard into the exact safe handoff', async () => {
    const tabs = rotationTabs();
    const confirmDiscardDraft = vi.fn(() => true);
    const panel = mountPanel({
      connections: [connection('mismatched-safe-stop', {
        base_url: 'https://private.example.test',
        auth_type: 'bearer',
        updated_at: 15,
      })],
      credentialRotationTabConvergence: tabs.convergence,
      confirmDiscardDraft,
      runCredentialRotationActivity: async () => safeStopActivity(),
    });
    await panel.mount.whenLoaded();
    panel.click({
      action: 'connections-edit',
      kind: 'api',
      name: 'mismatched-safe-stop',
    });
    panel.field('auth.type', 'basic', 'SELECT');
    panel.field('auth.username', 'local-only-user');
    panel.field('auth.password', 'local-only-password');

    tabs.emit({
      type: 'credential_rotation_safe_stopped',
      kind: 'api',
      name: 'mismatched-safe-stop',
    });
    await tick();

    expect(panel.mount.getState().credentialRotationRecovery?.phase)
      .toBe('safe_stopped');
    expect(panel.mount.getState().dialog.credentialCorrection).toBeNull();
    expect(panel.mount.getState().dialog.credentialRotationOwnership)
      .toMatchObject({ phase: 'safe_stopped' });
    expect(panel.mount.getState().dialog.values['auth.password'])
      .toBe('local-only-password');
    expect(panel.getHtml()).toContain(
      'rejected sign-in method differs from this editor',
    );
    expect(panel.getHtml()).toContain(
      'rebuild the editor around the rejected sign-in method',
    );
    expect(panel.getHtml()).not.toContain('reload the saved sign-in method');
    expect(panel.getHtml()).toContain('Resume credential recovery');
    expect(panel.getHtml()).not.toContain(
      'Safe details for the provider administrator',
    );

    panel.click({
      action: 'connections-review-credential-rotation',
      kind: 'api',
      name: 'mismatched-safe-stop',
    });

    expect(confirmDiscardDraft).toHaveBeenCalledOnce();
    expect(panel.mount.getState().dialog.values['auth.type']).toBe('bearer');
    expect(panel.mount.getState().dialog.values['auth.password']).toBeUndefined();
    expect(panel.mount.getState().dialog.credentialCorrection).toMatchObject({
      triage: { resolution: 'regenerate_credential_or_contact_admin' },
    });
    expect(panel.getHtml()).toContain(
      'Safe details for the provider administrator',
    );
    expect(panel.getHtml()).not.toContain('local-only-password');
    panel.mount.dispose();
  });

  it('rebuilds a list-only recovery around the rejected auth method instead of the saved one', async () => {
    const tabs = rotationTabs();
    const panel = mountPanel({
      connections: [connection('rejected-basic-stop', {
        base_url: 'https://private.example.test',
        auth_type: 'bearer',
        updated_at: 15,
      })],
      credentialRotationTabConvergence: tabs.convergence,
      runCredentialRotationActivity: async () => safeStopActivity('basic'),
    });
    await panel.mount.whenLoaded();

    tabs.emit({
      type: 'credential_rotation_safe_stopped',
      kind: 'api',
      name: 'rejected-basic-stop',
    });
    await tick();
    panel.click({
      action: 'connections-review-credential-rotation',
      kind: 'api',
      name: 'rejected-basic-stop',
    });

    expect(panel.mount.getState().dialog.editingId)
      .toBe('api/rejected-basic-stop');
    expect(panel.mount.getState().dialog.values['auth.type']).toBe('basic');
    expect(panel.mount.getState().dialog.values['auth.username']).toBeUndefined();
    expect(panel.mount.getState().dialog.values['auth.password']).toBeUndefined();
    expect(panel.mount.getState().dialog.credentialRotationOwnership).toBeNull();
    expect(panel.mount.getState().dialog.credentialCorrection).toMatchObject({
      fieldKeys: ['auth.username', 'auth.password'],
      triage: { resolution: 'regenerate_credential_or_contact_admin' },
    });
    expect(panel.getHtml()).toContain('Sign-in method: Username and password');
    expect(panel.getHtml()).toContain('Safe details for the provider administrator');
    expect(panel.getHtml()).toMatch(
      /data-action="connections-submit-form"[^>]*disabled/,
    );
    panel.mount.dispose();
  });

  it('retains a sibling admin handoff that arrives during a metadata-only save', async () => {
    const tabs = rotationTabs();
    const update = deferred<{ connection: ConnectionView }>();
    const saved = connection('metadata-save-stop', {
      display_name: 'Before metadata save',
      base_url: 'https://private.example.test',
      auth_type: 'bearer',
      updated_at: 15,
    });
    const panel = mountPanel({
      connections: [saved],
      credentialRotationTabConvergence: tabs.convergence,
      runUpdate: () => update.promise,
      runCredentialRotationActivity: async () => safeStopActivity(),
    });
    await panel.mount.whenLoaded();
    panel.click({
      action: 'connections-edit',
      kind: 'api',
      name: 'metadata-save-stop',
    });
    panel.field('display_name', 'After metadata save');
    panel.click({ action: 'connections-submit-form' });
    expect(panel.mount.getState().dialog.saving).toBe(true);

    tabs.emit({
      type: 'credential_rotation_safe_stopped',
      kind: 'api',
      name: 'metadata-save-stop',
    });
    await tick();

    expect(panel.calls.runUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'metadata-save-stop',
        patch: expect.not.objectContaining({ auth: expect.anything() }),
      }),
    );
    expect(panel.mount.getState().credentialRotationRecovery?.phase)
      .toBe('safe_stopped');
    expect(panel.mount.getState().dialog.credentialCorrection).toMatchObject({
      triage: { resolution: 'regenerate_credential_or_contact_admin' },
    });

    update.resolve({
      connection: {
        ...saved,
        display_name: 'After metadata save',
        updated_at: 16,
      },
    });
    await tick();

    expect(panel.mount.getState().dialog.stage).toBe('closed');
    expect(panel.mount.getState().credentialRotationRecovery?.phase)
      .toBe('safe_stopped');
    expect(panel.getHtml()).toContain('Resume credential recovery');
    expect(panel.getHtml()).toContain('no draft crossed tabs');
    panel.mount.dispose();
  });

  it('clears an orphaned safe-stop handoff when a later full list proves the connection was removed', async () => {
    const tabs = rotationTabs();
    const saved = connection('removed-safe-stop', {
      base_url: 'https://private.example.test',
      auth_type: 'bearer',
      updated_at: 15,
    });
    let listed: ReadonlyArray<ConnectionView> = [saved];
    const runActivity = async () => safeStopActivity();
    const panel = mountPanel({
      runList: async () => ({ connections: listed }),
      credentialRotationTabConvergence: tabs.convergence,
      runCredentialRotationActivity: runActivity,
    });
    await panel.mount.whenLoaded();

    tabs.emit({
      type: 'credential_rotation_safe_stopped',
      kind: 'api',
      name: 'removed-safe-stop',
    });
    await tick();
    expect(panel.mount.getState().credentialRotationRecovery?.phase)
      .toBe('safe_stopped');

    // Model a delayed activity projection racing a causally-later full list.
    // The absent connection wins, so the UI cannot leave a dead “Dismiss”
    // button that redraws the same orphaned handoff.
    listed = [];
    tabs.emit({ type: 'reconcile' });
    await tick();

    expect(panel.mount.getState().connections).toEqual([]);
    expect(panel.mount.getState().credentialRotationRecovery).toBeNull();
    expect(panel.getHtml()).not.toContain('Resume credential recovery');
    expect(panel.getHtml()).not.toContain('removed-safe-stop');
    panel.mount.dispose();
  });

  it('does not let an advisory safe-stop hint invent recovery after the server clears it', async () => {
    const tabs = rotationTabs();
    const panel = mountPanel({
      connections: [connection('cleared-safe-stop', {
        base_url: 'https://api.example.test',
        auth_type: 'bearer',
        updated_at: 15,
      })],
      credentialRotationTabConvergence: tabs.convergence,
      runCredentialRotationActivity: async () => ({
        activity: { status: 'idle', safe_stop: null },
      }),
    });
    await panel.mount.whenLoaded();
    panel.click({
      action: 'connections-edit',
      kind: 'api',
      name: 'cleared-safe-stop',
    });
    panel.field('auth.token', 'still-memory-only');

    tabs.emit({
      type: 'credential_rotation_safe_stopped',
      kind: 'api',
      name: 'cleared-safe-stop',
    });
    await tick();

    expect(panel.mount.getState().credentialRotationRecovery).toBeNull();
    expect(panel.mount.getState().dialog.credentialRotationOwnership).toBeNull();
    expect(panel.mount.getState().dialog.credentialCorrection).toBeNull();
    expect(panel.mount.getState().dialog.values['auth.token'])
      .toBe('still-memory-only');
    expect(panel.getHtml()).not.toContain('Safe details for the provider administrator');
    expect(panel.submitBtn.hasAttribute('disabled')).toBe(false);
    expect(panel.calls.runRotateCredentials).not.toHaveBeenCalled();
    panel.mount.dispose();
  });

  it('retires an originating safe-stop receipt after the server proves a later attempt reset it', async () => {
    const tabs = rotationTabs();
    const continuity = rotationContinuity();
    expect(continuity.store.write({
      attemptId: 'rotation-safe-stop-reset-0001',
      kind: 'api',
      name: 'locally-restored-stop',
      baselineUpdatedAt: 15,
    })).toBe('stored');
    const runActivity = vi.fn(async () => ({
      activity: { status: 'idle' as const, safe_stop: null },
    }));
    const panel = mountPanel({
      connections: [connection('locally-restored-stop', {
        base_url: 'https://private.example.test',
        auth_type: 'bearer',
        updated_at: 15,
      })],
      credentialRotationContinuity: continuity.store,
      credentialRotationTabConvergence: tabs.convergence,
      runCredentialRotationStatus: async () => ({
        outcome: {
          status: 'failed',
          started_at: FIXED_NOW - 1_000,
          finished_at: FIXED_NOW,
          reason: 'auth_failed',
          correction: safeStopCorrection(),
        },
      }),
      runCredentialRotationActivity: runActivity,
    });
    await panel.mount.whenLoaded();

    expect(panel.mount.getState().credentialRotationRecovery).toMatchObject({
      phase: 'failed',
      correction: {
        triage: { resolution: 'regenerate_credential_or_contact_admin' },
      },
    });
    expect(continuity.store.read()).not.toBeNull();

    tabs.emit({ type: 'reconcile' });
    await tick();

    expect(runActivity).toHaveBeenCalledWith({
      kind: 'api',
      name: 'locally-restored-stop',
    });
    expect(continuity.store.read()).toBeNull();
    expect(panel.mount.getState().credentialRotationRecovery).toBeNull();
    expect(panel.getHtml()).not.toContain('Resume credential recovery');
    panel.mount.dispose();
  });

  it('uses an identity-free fallback pulse to discover a safe stop only for the already-open editor', async () => {
    const tabs = rotationTabs();
    const runActivity = vi.fn(async () => safeStopActivity());
    const panel = mountPanel({
      connections: [connection('fallback-safe-stop', {
        base_url: 'https://private.example.test',
        auth_type: 'bearer',
        updated_at: 15,
      })],
      credentialRotationTabConvergence: tabs.convergence,
      runCredentialRotationActivity: runActivity,
    });
    await panel.mount.whenLoaded();
    panel.click({
      action: 'connections-edit',
      kind: 'api',
      name: 'fallback-safe-stop',
    });
    panel.field('auth.token', 'fallback-memory-only-secret');

    // Storage/focus fallback carries no identity. The panel may therefore ask
    // only about the exact editor already open in this tab, then trusts only
    // the selected server's bounded response.
    tabs.emit({ type: 'reconcile' });
    await tick();

    expect(runActivity).toHaveBeenCalledWith({
      kind: 'api',
      name: 'fallback-safe-stop',
    });
    expect(panel.mount.getState().credentialRotationRecovery?.phase)
      .toBe('safe_stopped');
    expect(panel.mount.getState().dialog.values['auth.token'])
      .toBe('fallback-memory-only-secret');
    expect(panel.getHtml()).toContain('Safe details for the provider administrator');
    panel.mount.dispose();
  });

  it('upgrades an in-flight quiet activity read when an exact safe-stop signal arrives', async () => {
    const tabs = rotationTabs();
    const activity = deferred<{
      activity: ConnectionCredentialRotationActivity;
    }>();
    const runActivity = vi.fn(() => activity.promise);
    const panel = mountPanel({
      connections: [connection('upgraded-safe-stop-check', {
        base_url: 'https://private.example.test',
        auth_type: 'bearer',
        updated_at: 15,
      })],
      credentialRotationTabConvergence: tabs.convergence,
      runCredentialRotationActivity: runActivity,
    });
    await panel.mount.whenLoaded();
    panel.click({
      action: 'connections-edit',
      kind: 'api',
      name: 'upgraded-safe-stop-check',
    });
    panel.field('auth.token', 'upgrade-memory-only-secret');

    tabs.emit({ type: 'reconcile' });
    expect(runActivity).toHaveBeenCalledOnce();
    expect(panel.mount.getState().credentialRotationRecovery).toBeNull();

    tabs.emit({
      type: 'credential_rotation_safe_stopped',
      kind: 'api',
      name: 'upgraded-safe-stop-check',
    });

    expect(runActivity).toHaveBeenCalledOnce();
    expect(panel.mount.getState().credentialRotationRecovery?.phase)
      .toBe('safe_stop_checking');
    expect(panel.mount.getState().dialog.credentialRotationOwnership?.phase)
      .toBe('safe_stop_checking');
    expect(panel.submitBtn.hasAttribute('disabled')).toBe(true);
    expect(panel.mount.getState().dialog.values['auth.token'])
      .toBe('upgrade-memory-only-secret');

    activity.resolve({ activity: { status: 'idle' } });
    await tick();

    expect(panel.mount.getState().credentialRotationRecovery?.phase)
      .toBe('safe_stop_unconfirmed');
    expect(panel.mount.getState().dialog.credentialRotationOwnership?.phase)
      .toBe('safe_stop_unconfirmed');
    expect(panel.getHtml()).toContain(
      'did not say whether it stopped safely',
    );
    expect(panel.getHtml()).not.toContain(
      'Safe details for the provider administrator',
    );
    expect(panel.submitBtn.hasAttribute('disabled')).toBe(true);
    panel.mount.dispose();
  });

  it('drops an older quiet safe-stop read once this tab submits a new replacement', async () => {
    const tabs = rotationTabs();
    const activity = deferred<{
      activity: ConnectionCredentialRotationActivity;
    }>();
    const rotate = deferred<
      Awaited<ReturnType<ConnectionsRotateCredentialsCaller>>
    >();
    const panel = mountPanel({
      connections: [connection('newer-than-safe-stop-read', {
        base_url: 'https://private.example.test',
        auth_type: 'bearer',
        updated_at: 15,
      })],
      credentialRotationTabConvergence: tabs.convergence,
      runCredentialRotationActivity: () => activity.promise,
      runRotateCredentials: () => rotate.promise,
    });
    await panel.mount.whenLoaded();
    panel.click({
      action: 'connections-edit',
      kind: 'api',
      name: 'newer-than-safe-stop-read',
    });
    panel.field('auth.token', 'newer-memory-only-secret');

    tabs.emit({ type: 'reconcile' });
    expect(panel.calls.runCredentialRotationActivity).toHaveBeenCalledOnce();

    panel.click({ action: 'connections-submit-form' });
    await tick(2);
    expect(panel.calls.runRotateCredentials).toHaveBeenCalledOnce();
    expect(panel.mount.getState().dialog.saving).toBe(true);

    activity.resolve(safeStopActivity());
    await tick();

    expect(panel.mount.getState().credentialRotationRecovery).toBeNull();
    expect(panel.mount.getState().dialog.credentialCorrection).toBeNull();
    expect(panel.mount.getState().dialog.saving).toBe(true);
    expect(panel.getHtml()).not.toContain(
      'Safe details for the provider administrator',
    );

    rotate.resolve({
      connection: connection('newer-than-safe-stop-read', { updated_at: 16 }),
      verification: {
        status: 'verified',
        verified_at: FIXED_NOW + 1,
        auth_type: 'bearer',
      },
    });
    await tick();
    expect(panel.mount.getState().dialog.stage).toBe('closed');
    panel.mount.dispose();
  });

  it('keeps a malformed server safe stop paused and never turns it into admin guidance', async () => {
    const tabs = rotationTabs();
    // Reordered closed-list fields are not authoritative. In particular, they
    // must never become selectors or copied prose.
    const malformed = safeStopActivity('bearer', [
      'config.endpoint',
      'config.base_url',
    ]);
    const panel = mountPanel({
      connections: [connection('malformed-safe-stop', {
        base_url: 'https://private.example.test',
        auth_type: 'bearer',
        updated_at: 15,
      })],
      credentialRotationTabConvergence: tabs.convergence,
      runCredentialRotationActivity: async () => malformed,
    });
    await panel.mount.whenLoaded();
    panel.click({
      action: 'connections-edit',
      kind: 'api',
      name: 'malformed-safe-stop',
    });
    panel.field('auth.token', 'malformed-memory-only-secret');

    tabs.emit({
      type: 'credential_rotation_safe_stopped',
      kind: 'api',
      name: 'malformed-safe-stop',
    });
    await tick();

    expect(panel.mount.getState().credentialRotationRecovery?.phase)
      .toBe('safe_stop_unconfirmed');
    expect(panel.mount.getState().dialog.credentialCorrection).toBeNull();
    expect(panel.mount.getState().dialog.values['auth.token'])
      .toBe('malformed-memory-only-secret');
    expect(panel.getHtml()).toContain(
      'did not say whether it stopped safely',
    );
    expect(panel.getHtml()).not.toContain(
      'Safe details for the provider administrator',
    );
    expect(panel.submitBtn.hasAttribute('disabled')).toBe(true);
    panel.mount.dispose();
  });

  it('keeps an unsupported sibling safe stop paused until an explicit authoritative recheck', async () => {
    const tabs = rotationTabs();
    const runActivity = vi.fn<ConnectionsCredentialRotationActivityCaller>()
      .mockResolvedValueOnce({ activity: { status: 'idle' } })
      .mockResolvedValueOnce(safeStopActivity());
    const panel = mountPanel({
      connections: [connection('mixed-version-stop', {
        base_url: 'https://api.example.test',
        auth_type: 'bearer',
        updated_at: 16,
      })],
      credentialRotationTabConvergence: tabs.convergence,
      runCredentialRotationActivity: runActivity,
    });
    await panel.mount.whenLoaded();
    panel.click({
      action: 'connections-edit',
      kind: 'api',
      name: 'mixed-version-stop',
    });
    panel.field('auth.token', 'memory-only-draft');

    tabs.emit({
      type: 'credential_rotation_safe_stopped',
      kind: 'api',
      name: 'mixed-version-stop',
    });
    await tick();

    expect(panel.mount.getState().credentialRotationRecovery?.phase)
      .toBe('safe_stop_unconfirmed');
    expect(panel.mount.getState().dialog.credentialRotationOwnership?.phase)
      .toBe('safe_stop_unconfirmed');
    expect(panel.getHtml()).toContain(
      'did not say whether it stopped safely',
    );
    expect(panel.getHtml()).not.toContain(
      'Safe details for the provider administrator',
    );
    expect(panel.submitBtn.hasAttribute('disabled')).toBe(true);

    panel.click({
      action: 'connections-check-credential-safe-stop',
      kind: 'api',
      name: 'mixed-version-stop',
    });
    await tick();

    expect(runActivity).toHaveBeenCalledTimes(2);
    expect(panel.mount.getState().credentialRotationRecovery?.phase)
      .toBe('safe_stopped');
    expect(panel.mount.getState().dialog.credentialCorrection).toMatchObject({
      triage: {
        resolution: 'regenerate_credential_or_contact_admin',
      },
    });
    expect(panel.mount.getState().dialog.values['auth.token'])
      .toBe('memory-only-draft');
    panel.mount.dispose();
  });

  it('drops a late safe-stop read when a newer sibling attempt has started', async () => {
    const tabs = rotationTabs({ supportsOwnershipLeases: true });
    const activity = deferred<{
      activity: ConnectionCredentialRotationActivity;
    }>();
    const panel = mountPanel({
      connections: [connection('overtaken-safe-stop', {
        base_url: 'https://api.example.test',
        auth_type: 'bearer',
        updated_at: 17,
      })],
      credentialRotationTabConvergence: tabs.convergence,
      runCredentialRotationActivity: () => activity.promise,
    });
    await panel.mount.whenLoaded();
    panel.click({
      action: 'connections-edit',
      kind: 'api',
      name: 'overtaken-safe-stop',
    });
    panel.field('auth.token', 'memory-only-contender');

    tabs.emit({
      type: 'credential_rotation_safe_stopped',
      kind: 'api',
      name: 'overtaken-safe-stop',
    });
    tabs.emit({
      type: 'credential_rotation_started',
      kind: 'api',
      name: 'overtaken-safe-stop',
    });
    activity.resolve(safeStopActivity());
    await tick();

    expect(panel.mount.getState().credentialRotationRecovery).toBeNull();
    expect(panel.mount.getState().dialog.credentialCorrection).toBeNull();
    expect(panel.mount.getState().dialog.credentialRotationOwnership)
      .toMatchObject({ phase: 'active' });
    expect(panel.mount.getState().dialog.values['auth.token'])
      .toBe('memory-only-contender');
    expect(panel.getHtml()).toContain('Credential check active elsewhere');
    expect(panel.getHtml()).not.toContain(
      'Safe details for the provider administrator',
    );
    panel.mount.dispose();
  });

  it('automatically elects one successor when the owner disappears without a release hint', async () => {
    vi.useFakeTimers();
    const successorLease = rotationOwnershipLease();
    const claims: Array<CredentialRotationOwnershipLease | null> = [
      null,
      successorLease,
    ];
    const tabs = rotationTabs({
      supportsOwnershipLeases: true,
      claim: async () => claims.shift() ?? null,
    });
    let activityReads = 0;
    const row = connection('crashed-owner-api', {
      base_url: 'https://api.example.com',
      updated_at: 18,
    });
    const panel = mountPanel({
      connections: [row],
      credentialRotationTabConvergence: tabs.convergence,
      runCredentialRotationActivity: async () => {
        activityReads += 1;
        return activityReads <= 2
          ? { activity: { status: 'pending' as const, started_at: FIXED_NOW } }
          : { activity: { status: 'idle' as const } };
      },
    });

    try {
      await panel.mount.whenLoaded();
      panel.click({
        action: 'connections-edit',
        kind: 'api',
        name: 'crashed-owner-api',
      });
      panel.field('auth.token', 'successor-memory-only');
      tabs.emit({
        type: 'credential_rotation_started',
        kind: 'api',
        name: 'crashed-owner-api',
      });

      expect(panel.mount.getState().dialog.credentialRotationOwnership)
        .toMatchObject({ phase: 'active', automaticTakeover: true });
      expect(panel.getHtml()).toContain('elect one safe successor automatically');
      const waitingRenderCount = panel.getRenderCount();

      // The original owner still holds the Web Lock. A quiet failed election
      // leaves the draft, focus surface, and polite live region untouched.
      await vi.advanceTimersByTimeAsync(2_000);
      expect(tabs.claimCredentialRotationOwnership).toHaveBeenCalledTimes(1);
      expect(panel.calls.runCredentialRotationActivity).not.toHaveBeenCalled();
      expect(panel.mount.getState().dialog.credentialRotationOwnership?.phase)
        .toBe('active');
      expect(panel.getRenderCount()).toBe(waitingRenderCount);

      // The owner disappears without broadcasting release. Exactly one later
      // poll wins the browser lease, then waits on server authority.
      await vi.advanceTimersByTimeAsync(2_000);
      expect(tabs.claimCredentialRotationOwnership).toHaveBeenCalledTimes(2);
      expect(panel.calls.runCredentialRotationActivity).toHaveBeenCalledTimes(1);
      expect(panel.mount.getState().dialog.credentialRotationOwnership?.phase)
        .toBe('pending');
      expect(tabs.notifyCredentialRotationStarted).toHaveBeenCalledWith({
        kind: 'api',
        name: 'crashed-owner-api',
      });
      const pendingRenderCount = panel.getRenderCount();

      // Repeated server-pending observations are intentionally silent: the
      // polite status region must not announce the same wait every two seconds.
      await vi.advanceTimersByTimeAsync(2_000);
      expect(panel.calls.runCredentialRotationActivity).toHaveBeenCalledTimes(2);
      expect(panel.mount.getState().dialog.credentialRotationOwnership?.phase)
        .toBe('pending');
      expect(panel.getRenderCount()).toBe(pendingRenderCount);
      expect(tabs.notifyCredentialRotationStarted).toHaveBeenCalledTimes(1);

      // Server-idle is not enough by itself: the same check re-reads the row
      // revision before making the memory-only draft actionable.
      await vi.advanceTimersByTimeAsync(2_000);
      expect(panel.calls.runCredentialRotationActivity).toHaveBeenCalledTimes(3);
      expect(panel.mount.getState().dialog.credentialRotationOwnership?.phase)
        .toBe('available');
      expect(panel.mount.getState().dialog.values['auth.token'])
        .toBe('successor-memory-only');
      expect(panel.submitBtn.hasAttribute('disabled')).toBe(false);
      expect(panel.calls.runRotateCredentials).not.toHaveBeenCalled();
      expect(tabs.notifyCredentialRotationReleased).not.toHaveBeenCalled();
      expect(successorLease.release).not.toHaveBeenCalled();
    } finally {
      panel.mount.dispose();
      vi.useRealTimers();
    }
  });

  it('keeps half-filled replacements out of automatic successor election', async () => {
    vi.useFakeTimers();
    const successorLease = rotationOwnershipLease();
    const tabs = rotationTabs({
      supportsOwnershipLeases: true,
      claim: async () => successorLease,
    });
    const panel = mountPanel({
      connections: [connection('partial-basic-api', {
        base_url: 'https://api.example.com',
        auth_type: 'basic',
        updated_at: 24,
      })],
      credentialRotationTabConvergence: tabs.convergence,
      runCredentialRotationActivity: async () => ({
        activity: { status: 'idle' },
      }),
    });

    try {
      await panel.mount.whenLoaded();
      panel.click({
        action: 'connections-edit',
        kind: 'api',
        name: 'partial-basic-api',
      });
      panel.field('auth.username', 'replacement-user');
      tabs.emit({
        type: 'credential_rotation_started',
        kind: 'api',
        name: 'partial-basic-api',
      });

      expect(panel.mount.getState().dialog.credentialRotationOwnership)
        .toMatchObject({ phase: 'active', automaticTakeover: false });
      await vi.advanceTimersByTimeAsync(6_000);
      expect(tabs.claimCredentialRotationOwnership).not.toHaveBeenCalled();

      panel.field('auth.password', 'complete-memory-only-replacement');
      expect(panel.mount.getState().dialog.credentialRotationOwnership)
        .toMatchObject({ phase: 'active', automaticTakeover: true });
      expect(panel.getHtml()).toContain('elect one safe successor automatically');
      await vi.advanceTimersByTimeAsync(2_000);

      expect(tabs.claimCredentialRotationOwnership).toHaveBeenCalledOnce();
      expect(panel.mount.getState().dialog.credentialRotationOwnership?.phase)
        .toBe('available');
      expect(successorLease.release).not.toHaveBeenCalled();
    } finally {
      panel.mount.dispose();
      vi.useRealTimers();
    }
  });

  it('resumes an elected successor automatically after reconnect', async () => {
    vi.useFakeTimers();
    const successorLease = rotationOwnershipLease();
    const reconnect: { current?: () => void } = {};
    const tabs = rotationTabs({
      supportsOwnershipLeases: true,
      claim: async () => successorLease,
    });
    let activityReads = 0;
    const panel = mountPanel({
      connections: [connection('reconnecting-successor-api', {
        base_url: 'https://api.example.com',
        updated_at: 25,
      })],
      credentialRotationTabConvergence: tabs.convergence,
      runCredentialRotationActivity: async () => {
        activityReads += 1;
        if (activityReads === 1) {
          throw Object.assign(new Error('connection dropped'), {
            code: 'connection_lost',
          });
        }
        return { activity: { status: 'idle' } };
      },
      onReconnect: (listener) => {
        reconnect.current = listener;
        return () => { delete reconnect.current; };
      },
    });

    try {
      await panel.mount.whenLoaded();
      panel.click({
        action: 'connections-edit',
        kind: 'api',
        name: 'reconnecting-successor-api',
      });
      panel.field('auth.token', 'reconnect-memory-only');
      tabs.emit({
        type: 'credential_rotation_started',
        kind: 'api',
        name: 'reconnecting-successor-api',
      });
      await vi.advanceTimersByTimeAsync(2_000);

      expect(panel.mount.getState().dialog.credentialRotationOwnership)
        .toMatchObject({ phase: 'unconfirmed', automaticTakeover: true });
      expect(panel.getHtml()).toContain('will check again after reconnecting');
      expect(successorLease.release).not.toHaveBeenCalled();

      reconnect.current?.();
      await tick();

      expect(panel.calls.runCredentialRotationActivity).toHaveBeenCalledTimes(2);
      expect(tabs.claimCredentialRotationOwnership).toHaveBeenCalledOnce();
      expect(panel.mount.getState().dialog.credentialRotationOwnership?.phase)
        .toBe('available');
      expect(panel.mount.getState().dialog.values['auth.token'])
        .toBe('reconnect-memory-only');
    } finally {
      panel.mount.dispose();
      vi.useRealTimers();
    }
  });

  it('drops a late reconnect result after the successor draft becomes invalid', async () => {
    vi.useFakeTimers();
    const successorLease = rotationOwnershipLease();
    const reconnectActivity = deferred<{
      activity: { status: 'idle' };
    }>();
    const reconnect: { current?: () => void } = {};
    const tabs = rotationTabs({
      supportsOwnershipLeases: true,
      claim: async () => successorLease,
    });
    let activityReads = 0;
    const panel = mountPanel({
      connections: [connection('stale-reconnect-successor', {
        base_url: 'https://api.example.com',
        updated_at: 26,
      })],
      credentialRotationTabConvergence: tabs.convergence,
      runCredentialRotationActivity: async () => {
        activityReads += 1;
        if (activityReads === 1) {
          throw Object.assign(new Error('connection dropped'), {
            code: 'connection_lost',
          });
        }
        return reconnectActivity.promise;
      },
      onReconnect: (listener) => {
        reconnect.current = listener;
        return () => { delete reconnect.current; };
      },
    });

    try {
      await panel.mount.whenLoaded();
      panel.click({
        action: 'connections-edit',
        kind: 'api',
        name: 'stale-reconnect-successor',
      });
      panel.field('auth.token', 'temporary-reconnect-draft');
      tabs.emit({
        type: 'credential_rotation_started',
        kind: 'api',
        name: 'stale-reconnect-successor',
      });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(panel.mount.getState().dialog.credentialRotationOwnership?.phase)
        .toBe('unconfirmed');

      reconnect.current?.();
      await tick();
      expect(panel.calls.runCredentialRotationActivity).toHaveBeenCalledTimes(2);

      panel.field('auth.token', '');
      expect(panel.mount.getState().dialog.credentialRotationOwnership)
        .toMatchObject({ phase: 'active', automaticTakeover: false });
      expect(successorLease.release).toHaveBeenCalledOnce();

      reconnectActivity.resolve({ activity: { status: 'idle' } });
      await tick();

      expect(panel.mount.getState().dialog.credentialRotationOwnership)
        .toMatchObject({ phase: 'active', automaticTakeover: false });
      expect(panel.submitBtn.hasAttribute('disabled')).toBe(true);
      expect(panel.calls.runRotateCredentials).not.toHaveBeenCalled();
      expect(panel.mount.hasInFlightWork()).toBe(false);
    } finally {
      panel.mount.dispose();
      vi.useRealTimers();
    }
  });

  it('stops cleanly without start/release ping-pong when server takeover is unsupported', async () => {
    vi.useFakeTimers();
    const unsupportedLease = rotationOwnershipLease();
    const tabs = rotationTabs({
      supportsOwnershipLeases: true,
      claim: async () => unsupportedLease,
    });
    const panel = mountPanel({
      connections: [connection('unsupported-successor-api', {
        base_url: 'https://api.example.com',
        updated_at: 28,
      })],
      credentialRotationTabConvergence: tabs.convergence,
      runCredentialRotationActivity: async () => {
        throw Object.assign(new Error('method unavailable'), {
          code: 'unknown_method',
        });
      },
    });

    try {
      await panel.mount.whenLoaded();
      panel.click({
        action: 'connections-edit',
        kind: 'api',
        name: 'unsupported-successor-api',
      });
      panel.field('auth.token', 'unsupported-memory-only');
      tabs.emit({
        type: 'credential_rotation_started',
        kind: 'api',
        name: 'unsupported-successor-api',
      });
      await vi.advanceTimersByTimeAsync(2_000);

      expect(panel.mount.getState().dialog.credentialRotationOwnership)
        .toMatchObject({ phase: 'unconfirmed', automaticTakeover: false });
      expect(unsupportedLease.release).toHaveBeenCalledOnce();
      expect(tabs.notifyCredentialRotationStarted).not.toHaveBeenCalled();
      expect(tabs.notifyCredentialRotationReleased).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(6_000);
      expect(tabs.claimCredentialRotationOwnership).toHaveBeenCalledOnce();
      expect(panel.calls.runCredentialRotationActivity).toHaveBeenCalledOnce();
    } finally {
      panel.mount.dispose();
      vi.useRealTimers();
    }
  });

  it('keeps metadata-only siblings out of automatic succession until they hold a replacement', async () => {
    vi.useFakeTimers();
    const successorLease = rotationOwnershipLease();
    const tabs = rotationTabs({
      supportsOwnershipLeases: true,
      claim: async () => successorLease,
    });
    const panel = mountPanel({
      connections: [connection('draft-owner-api', {
        base_url: 'https://api.example.com',
        updated_at: 21,
      })],
      credentialRotationTabConvergence: tabs.convergence,
      runCredentialRotationActivity: async () => ({
        activity: { status: 'idle' },
      }),
    });

    try {
      await panel.mount.whenLoaded();
      panel.click({
        action: 'connections-edit',
        kind: 'api',
        name: 'draft-owner-api',
      });
      tabs.emit({
        type: 'credential_rotation_started',
        kind: 'api',
        name: 'draft-owner-api',
      });

      expect(panel.mount.getState().dialog.credentialRotationOwnership)
        .toMatchObject({ phase: 'active', automaticTakeover: false });
      expect(panel.getHtml()).toContain('choose Check availability');
      await vi.advanceTimersByTimeAsync(6_000);
      expect(tabs.claimCredentialRotationOwnership).not.toHaveBeenCalled();
      expect(panel.calls.runCredentialRotationActivity).not.toHaveBeenCalled();

      // A real replacement entered later makes this tab eligible without
      // requiring another cross-tab signal. Browser lock election still picks
      // at most one such contender.
      panel.field('auth.token', 'late-memory-only-contender');
      expect(panel.mount.getState().dialog.credentialRotationOwnership)
        .toMatchObject({ phase: 'active', automaticTakeover: true });
      await vi.advanceTimersByTimeAsync(2_000);

      expect(tabs.claimCredentialRotationOwnership).toHaveBeenCalledOnce();
      expect(panel.calls.runCredentialRotationActivity).toHaveBeenCalledOnce();
      expect(panel.mount.getState().dialog.credentialRotationOwnership?.phase)
        .toBe('available');
      expect(panel.mount.getState().dialog.values['auth.token'])
        .toBe('late-memory-only-contender');
      expect(successorLease.release).not.toHaveBeenCalled();
    } finally {
      panel.mount.dispose();
      vi.useRealTimers();
    }
  });

  it('finishes a manually claimed pending observation before yielding a metadata editor', async () => {
    vi.useFakeTimers();
    const observerLease = rotationOwnershipLease();
    const tabs = rotationTabs({
      supportsOwnershipLeases: true,
      claim: async () => observerLease,
    });
    let activityReads = 0;
    const panel = mountPanel({
      connections: [connection('metadata-observer-api', {
        base_url: 'https://api.example.com',
        updated_at: 27,
      })],
      credentialRotationTabConvergence: tabs.convergence,
      runCredentialRotationActivity: async () => {
        activityReads += 1;
        return activityReads === 1
          ? { activity: { status: 'pending' as const, started_at: FIXED_NOW } }
          : { activity: { status: 'idle' as const } };
      },
    });

    try {
      await panel.mount.whenLoaded();
      panel.click({
        action: 'connections-edit',
        kind: 'api',
        name: 'metadata-observer-api',
      });
      tabs.emit({
        type: 'credential_rotation_started',
        kind: 'api',
        name: 'metadata-observer-api',
      });
      expect(panel.mount.getState().dialog.credentialRotationOwnership)
        .toMatchObject({ phase: 'active', automaticTakeover: false });

      panel.click({ action: 'connections-check-credential-rotation-owner' });
      await tick();
      expect(panel.mount.getState().dialog.credentialRotationOwnership)
        .toMatchObject({ phase: 'pending', automaticTakeover: true });

      await vi.advanceTimersByTimeAsync(2_000);
      expect(panel.calls.runCredentialRotationActivity).toHaveBeenCalledTimes(2);
      expect(panel.mount.getState().dialog.credentialRotationOwnership).toBeNull();
      expect(observerLease.release).toHaveBeenCalledOnce();
      expect(tabs.notifyCredentialRotationReleased).toHaveBeenCalledWith({
        kind: 'api',
        name: 'metadata-observer-api',
      });
    } finally {
      panel.mount.dispose();
      vi.useRealTimers();
    }
  });

  it('yields a late automatic lease when its replacement draft was cleared', async () => {
    vi.useFakeTimers();
    const claimed = deferred<CredentialRotationOwnershipLease | null>();
    const staleLease = rotationOwnershipLease();
    const tabs = rotationTabs({
      supportsOwnershipLeases: true,
      claim: async () => claimed.promise,
    });
    const panel = mountPanel({
      connections: [connection('cleared-contender-api', {
        base_url: 'https://api.example.com',
        updated_at: 22,
      })],
      credentialRotationTabConvergence: tabs.convergence,
      runCredentialRotationActivity: async () => ({
        activity: { status: 'idle' },
      }),
    });

    try {
      await panel.mount.whenLoaded();
      panel.click({
        action: 'connections-edit',
        kind: 'api',
        name: 'cleared-contender-api',
      });
      panel.field('auth.token', 'temporary-contender');
      tabs.emit({
        type: 'credential_rotation_started',
        kind: 'api',
        name: 'cleared-contender-api',
      });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(tabs.claimCredentialRotationOwnership).toHaveBeenCalledOnce();

      // The browser claim can settle after the user's intent changed. That
      // stale win is released without consulting the server or reviving the
      // cleared replacement.
      panel.field('auth.token', '');
      expect(panel.mount.getState().dialog.credentialRotationOwnership)
        .toMatchObject({ phase: 'active', automaticTakeover: false });
      claimed.resolve(staleLease);
      await tick();

      expect(staleLease.release).toHaveBeenCalledOnce();
      expect(panel.calls.runCredentialRotationActivity).not.toHaveBeenCalled();
      expect(tabs.notifyCredentialRotationStarted).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(6_000);
      expect(tabs.claimCredentialRotationOwnership).toHaveBeenCalledOnce();
    } finally {
      panel.mount.dispose();
      vi.useRealTimers();
    }
  });

  it('finishes observing a pending attempt, then yields when its draft is gone', async () => {
    vi.useFakeTimers();
    const successorLease = rotationOwnershipLease();
    const tabs = rotationTabs({
      supportsOwnershipLeases: true,
      claim: async () => successorLease,
    });
    let activityReads = 0;
    const panel = mountPanel({
      connections: [connection('cleared-pending-api', {
        base_url: 'https://api.example.com',
        updated_at: 23,
      })],
      credentialRotationTabConvergence: tabs.convergence,
      runCredentialRotationActivity: async () => {
        activityReads += 1;
        return activityReads === 1
          ? { activity: { status: 'pending' as const, started_at: FIXED_NOW } }
          : { activity: { status: 'idle' as const } };
      },
    });

    try {
      await panel.mount.whenLoaded();
      panel.click({
        action: 'connections-edit',
        kind: 'api',
        name: 'cleared-pending-api',
      });
      panel.field('auth.token', 'clear-after-election');
      tabs.emit({
        type: 'credential_rotation_started',
        kind: 'api',
        name: 'cleared-pending-api',
      });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(panel.mount.getState().dialog.credentialRotationOwnership?.phase)
        .toBe('pending');

      // The elected successor keeps one authoritative server observation
      // alive, but must not retain the lease as an actionable contender after
      // its own replacement disappears.
      panel.field('auth.token', '');
      expect(panel.mount.getState().dialog.credentialRotationOwnership)
        .toMatchObject({ phase: 'pending', automaticTakeover: true });
      await vi.advanceTimersByTimeAsync(2_000);

      expect(panel.calls.runCredentialRotationActivity).toHaveBeenCalledTimes(2);
      expect(panel.mount.getState().dialog.credentialRotationOwnership).toBeNull();
      expect(successorLease.release).toHaveBeenCalledOnce();
      expect(tabs.notifyCredentialRotationReleased).toHaveBeenCalledWith({
        kind: 'api',
        name: 'cleared-pending-api',
      });
      expect(panel.calls.runRotateCredentials).not.toHaveBeenCalled();
    } finally {
      panel.mount.dispose();
      vi.useRealTimers();
    }
  });

  it('stops automatic successor election when the protected editor closes', async () => {
    vi.useFakeTimers();
    const tabs = rotationTabs({
      supportsOwnershipLeases: true,
      claim: async () => null,
    });
    const panel = mountPanel({
      connections: [connection('closed-draft-api', {
        base_url: 'https://api.example.com',
        updated_at: 19,
      })],
      credentialRotationTabConvergence: tabs.convergence,
      runCredentialRotationActivity: async () => ({
        activity: { status: 'idle' },
      }),
    });

    try {
      await panel.mount.whenLoaded();
      panel.click({
        action: 'connections-edit',
        kind: 'api',
        name: 'closed-draft-api',
      });
      panel.field('auth.token', 'discarded-with-editor');
      tabs.emit({
        type: 'credential_rotation_started',
        kind: 'api',
        name: 'closed-draft-api',
      });
      panel.click({ action: 'connections-cancel-dialog' });

      await vi.advanceTimersByTimeAsync(6_000);
      expect(panel.mount.getState().dialog.stage).toBe('closed');
      expect(tabs.claimCredentialRotationOwnership).not.toHaveBeenCalled();
      expect(panel.calls.runCredentialRotationActivity).not.toHaveBeenCalled();
      expect(panel.mount.hasInFlightWork()).toBe(false);
    } finally {
      panel.mount.dispose();
      vi.useRealTimers();
    }
  });

  it('claims browser ownership before writing continuity or sending provider work', async () => {
    const tabs = rotationTabs({
      supportsOwnershipLeases: true,
      claim: async () => null,
    });
    const continuity = rotationContinuity();
    const { mount, click, field, calls } = mountPanel({
      connections: [connection('busy-api', {
        base_url: 'https://api.example.com',
        updated_at: 20,
      })],
      credentialRotationContinuity: continuity.store,
      credentialRotationTabConvergence: tabs.convergence,
    });
    await mount.whenLoaded();
    click({ action: 'connections-edit', kind: 'api', name: 'busy-api' });
    field('auth.token', 'must-not-send');
    click({ action: 'connections-submit-form' });
    await tick();

    expect(tabs.claimCredentialRotationOwnership).toHaveBeenCalledWith({
      kind: 'api',
      name: 'busy-api',
    });
    expect(calls.runRotateCredentials).not.toHaveBeenCalled();
    expect(continuity.store.read()).toBeNull();
    expect(mount.getState().dialog.values['auth.token']).toBe('must-not-send');
    expect(mount.getState().dialog.credentialRotationOwnership?.phase)
      .toBe('active');
    mount.dispose();
  });

  it('offers one safe takeover only after browser ownership, server idle, and an unchanged row', async () => {
    const lease = rotationOwnershipLease();
    const tabs = rotationTabs({
      supportsOwnershipLeases: true,
      claim: async () => lease,
    });
    let activityRead = 0;
    const row = connection('takeover-api', {
      base_url: 'https://api.example.com',
      updated_at: 31,
    });
    const { mount, click, field, calls, getHtml, submitBtn } = mountPanel({
      runList: async () => ({ connections: [row] }),
      runCredentialRotationActivity: async () => {
        activityRead += 1;
        return activityRead === 1
          ? { activity: { status: 'pending', started_at: FIXED_NOW } }
          : { activity: { status: 'idle' } };
      },
      credentialRotationTabConvergence: tabs.convergence,
    });
    await mount.whenLoaded();
    click({ action: 'connections-edit', kind: 'api', name: 'takeover-api' });
    field('auth.token', 'takeover-secret');
    tabs.emit({
      type: 'credential_rotation_started',
      kind: 'api',
      name: 'takeover-api',
    });

    click({ action: 'connections-check-credential-rotation-owner' });
    await tick();
    expect(mount.getState().dialog.credentialRotationOwnership?.phase)
      .toBe('pending');
    expect(getHtml()).toContain('server is still checking');
    expect(getHtml()).toContain('This tab now holds the browser check');
    expect(calls.runRotateCredentials).not.toHaveBeenCalled();

    click({ action: 'connections-check-credential-rotation-owner' });
    await tick();
    expect(mount.getState().dialog.credentialRotationOwnership?.phase)
      .toBe('available');
    expect(mount.getState().dialog.values['auth.token']).toBe('takeover-secret');
    expect(getHtml()).toContain('This tab can continue');
    expect(submitBtn.hasAttribute('disabled')).toBe(false);

    click({ action: 'connections-submit-form' });
    await tick();
    expect(calls.runRotateCredentials).toHaveBeenCalledTimes(1);
    expect(calls.runRotateCredentials.mock.calls[0]![0].patch.auth)
      .toEqual({ type: 'bearer', token: 'takeover-secret' });
    expect(lease.release).toHaveBeenCalledOnce();
    expect(tabs.notifyCredentialRotated).toHaveBeenCalledWith({
      kind: 'api',
      name: 'takeover-api',
    });
    mount.dispose();
  });

  it('lets a new editor check ownership while a cancelled editor read is still settling', async () => {
    const firstActivity = deferred<{
      activity: { status: 'idle' };
    }>();
    const firstLease = rotationOwnershipLease();
    const secondLease = rotationOwnershipLease();
    const leases = [firstLease, secondLease];
    const tabs = rotationTabs({
      supportsOwnershipLeases: true,
      claim: async () => leases.shift() ?? null,
    });
    let activityCall = 0;
    const rows = [
      connection('first-api', {
        base_url: 'https://first.example.com',
        updated_at: 61,
      }),
      connection('second-api', {
        base_url: 'https://second.example.com',
        updated_at: 62,
      }),
    ];
    const { mount, click, field, calls } = mountPanel({
      connections: rows,
      credentialRotationTabConvergence: tabs.convergence,
      runCredentialRotationActivity: async () => {
        activityCall += 1;
        return activityCall === 1
          ? firstActivity.promise
          : { activity: { status: 'idle' } };
      },
    });
    await mount.whenLoaded();
    click({ action: 'connections-edit', kind: 'api', name: 'first-api' });
    field('auth.token', 'first-memory-only');
    tabs.emit({
      type: 'credential_rotation_started',
      kind: 'api',
      name: 'first-api',
    });
    click({ action: 'connections-check-credential-rotation-owner' });
    await tick();
    expect(calls.runCredentialRotationActivity).toHaveBeenCalledTimes(1);
    expect(mount.hasInFlightWork()).toBe(true);

    click({ action: 'connections-cancel-dialog' });
    expect(firstLease.release).toHaveBeenCalledOnce();
    // The detached server read is secret-free/read-only and must not pin a
    // route or server switch after its editor and browser lease are gone.
    expect(mount.hasInFlightWork()).toBe(false);

    click({ action: 'connections-edit', kind: 'api', name: 'second-api' });
    field('auth.token', 'second-memory-only');
    tabs.emit({
      type: 'credential_rotation_started',
      kind: 'api',
      name: 'second-api',
    });
    click({ action: 'connections-check-credential-rotation-owner' });
    await tick();

    expect(calls.runCredentialRotationActivity).toHaveBeenCalledTimes(2);
    expect(mount.getState().dialog.editingId).toBe('api/second-api');
    expect(mount.getState().dialog.credentialRotationOwnership?.phase)
      .toBe('available');
    expect(mount.getState().dialog.values['auth.token'])
      .toBe('second-memory-only');

    firstActivity.resolve({ activity: { status: 'idle' } });
    await tick();
    expect(mount.getState().dialog.editingId).toBe('api/second-api');
    expect(mount.getState().dialog.credentialRotationOwnership?.phase)
      .toBe('available');
    expect(secondLease.release).not.toHaveBeenCalled();
    mount.dispose();
  });

  it('routes an idle takeover through stale-editor review when the saved row changed', async () => {
    const lease = rotationOwnershipLease();
    const tabs = rotationTabs({
      supportsOwnershipLeases: true,
      claim: async () => lease,
    });
    let listRead = 0;
    const before = connection('changed-during-check', {
      base_url: 'https://old.example.com',
      updated_at: 51,
    });
    const after = connection('changed-during-check', {
      base_url: 'https://new.example.com',
      updated_at: 52,
    });
    const { mount, click, field, calls, getHtml } = mountPanel({
      runList: async () => {
        listRead += 1;
        return { connections: [listRead === 1 ? before : after] };
      },
      runCredentialRotationActivity: async () => ({
        activity: { status: 'idle' },
      }),
      credentialRotationTabConvergence: tabs.convergence,
    });
    await mount.whenLoaded();
    click({
      action: 'connections-edit',
      kind: 'api',
      name: 'changed-during-check',
    });
    field('auth.token', 'keep-until-owner-reloads');
    tabs.emit({
      type: 'credential_rotation_started',
      kind: 'api',
      name: 'changed-during-check',
    });
    click({ action: 'connections-check-credential-rotation-owner' });
    await tick();

    expect(mount.getState().dialog.credentialRotationOwnership).toBeNull();
    expect(mount.getState().dialog.externalChange?.phase).toBe('changed');
    expect(mount.getState().dialog.values['auth.token'])
      .toBe('keep-until-owner-reloads');
    expect(getHtml()).toContain('Connection changed since you opened it');
    expect(calls.runRotateCredentials).not.toHaveBeenCalled();
    expect(lease.release).toHaveBeenCalledOnce();
    mount.dispose();
  });

  it('turns a server-owned contender rejection into guided ownership recovery', async () => {
    const continuity = rotationContinuity();
    const owned = Object.assign(new Error('already checking'), {
      code: 'credential_rotation_owned_elsewhere',
    });
    const { mount, click, field, calls, getHtml } = mountPanel({
      connections: [connection('server-owned-api', {
        base_url: 'https://api.example.com',
        updated_at: 41,
      })],
      credentialRotationContinuity: continuity.store,
      runRotateCredentials: async () => { throw owned; },
    });
    await mount.whenLoaded();
    click({ action: 'connections-edit', kind: 'api', name: 'server-owned-api' });
    field('auth.token', 'preserved-contender');
    click({ action: 'connections-submit-form' });
    await tick();

    expect(calls.runRotateCredentials).toHaveBeenCalledOnce();
    expect(continuity.store.read()).toBeNull();
    expect(calls.runCredentialRotationStatus).not.toHaveBeenCalled();
    expect(mount.getState().dialog.values['auth.token'])
      .toBe('preserved-contender');
    expect(mount.getState().dialog.error).toBeNull();
    expect(mount.getState().dialog.credentialRotationOwnership?.phase)
      .toBe('active');
    expect(getHtml()).toContain('Credential check active elsewhere');
    mount.dispose();
  });

  it('uses an identity-free reconcile pulse plus the server revision to stale an open editor', async () => {
    const tabs = rotationTabs();
    let listed = connection('focus-api', {
      base_url: 'https://api.example.com',
      updated_at: 20,
    });
    const { mount, click, field, calls } = mountPanel({
      runList: async () => ({ connections: [listed] }),
      credentialRotationTabConvergence: tabs.convergence,
    });
    await mount.whenLoaded();
    click({ action: 'connections-edit', kind: 'api', name: 'focus-api' });
    field('auth.token', 'preserved-on-focus');

    listed = connection('focus-api', {
      base_url: 'https://api.example.com',
      updated_at: 21,
    });
    tabs.emit({ type: 'reconcile' });
    await tick();

    expect(mount.getState().dialog.externalChange?.phase).toBe('changed');
    expect(mount.getState().dialog.values['auth.token']).toBe('preserved-on-focus');
    click({ action: 'connections-submit-form' });
    await tick();
    expect(calls.runRotateCredentials).not.toHaveBeenCalled();
    mount.dispose();
  });

  it('keeps initial schema readiness pending when a sibling refresh overtakes the first list', async () => {
    const tabs = rotationTabs();
    const initialList = deferred<{ connections: ReadonlyArray<ConnectionView> }>();
    const siblingList = deferred<{ connections: ReadonlyArray<ConnectionView> }>();
    const packs = deferred<{ packs: ReadonlyArray<PackListEntry> }>();
    let listCall = 0;
    const { mount } = mountPanel({
      credentialRotationTabConvergence: tabs.convergence,
      runList: () => {
        listCall += 1;
        return listCall === 1 ? initialList.promise : siblingList.promise;
      },
      runPacksList: () => packs.promise,
    });
    let loaded = false;
    void mount.whenLoaded().then(() => { loaded = true; });

    tabs.emit({ type: 'reconcile' });
    siblingList.resolve({ connections: [] });
    initialList.resolve({ connections: [] });
    await tick();
    expect(loaded).toBe(false);

    packs.resolve({ packs: [] });
    await mount.whenLoaded();
    expect(loaded).toBe(true);
    expect(listCall).toBe(2);
    mount.dispose();
  });

  it('carries explicit reload consent through an overtaking sibling hint', async () => {
    const tabs = rotationTabs();
    const delayedReload = deferred<{ connections: ReadonlyArray<ConnectionView> }>();
    let call = 0;
    const oldRow = connection('overtaken-api', {
      display_name: 'Old row',
      base_url: 'https://old.example.com',
      updated_at: 40,
    });
    const latestRow = connection('overtaken-api', {
      display_name: 'Newest row',
      base_url: 'https://newest.example.com',
      updated_at: 42,
    });
    const { mount, click, field } = mountPanel({
      credentialRotationTabConvergence: tabs.convergence,
      runList: async () => {
        call += 1;
        if (call === 1) return { connections: [oldRow] };
        if (call === 2) return { connections: [{ ...oldRow, updated_at: 41 }] };
        if (call === 3) return delayedReload.promise;
        return { connections: [latestRow] };
      },
    });
    await mount.whenLoaded();
    click({ action: 'connections-edit', kind: 'api', name: 'overtaken-api' });
    field('auth.token', 'discard-only-after-click');
    tabs.emit({
      type: 'credential_rotated',
      kind: 'api',
      name: 'overtaken-api',
    });
    await tick();
    expect(mount.getState().dialog.externalChange?.phase).toBe('changed');

    click({ action: 'connections-reload-stale-editor' });
    expect(mount.getState().dialog.externalChange?.reloading).toBe(true);
    tabs.emit({ type: 'reconcile' });
    await tick();

    expect(mount.getState().dialog.externalChange).toBeNull();
    expect(mount.getState().dialog.values.display_name).toBe('Newest row');
    expect(mount.getState().dialog.values['auth.token']).not.toBe(
      'discard-only-after-click',
    );
    delayedReload.resolve({ connections: [{ ...oldRow, updated_at: 41 }] });
    await tick();
    expect(mount.getState().dialog.values.display_name).toBe('Newest row');
    mount.dispose();
  });

  it('folds a server revision conflict into the same stale-editor recovery without losing the replacement', async () => {
    const conflict = Object.assign(new Error(
      'This connection changed after you opened it.',
    ), { code: 'conflict' });
    const { mount, click, field, calls, getHtml } = mountPanel({
      connections: [connection('cas-api', {
        base_url: 'https://api.example.com',
        updated_at: 30,
      })],
      runRotateCredentials: async () => { throw conflict; },
    });
    await mount.whenLoaded();
    click({ action: 'connections-edit', kind: 'api', name: 'cas-api' });
    field('auth.token', 'keep-after-conflict');
    click({ action: 'connections-submit-form' });
    await tick();

    expect(calls.runRotateCredentials).toHaveBeenCalledWith(expect.objectContaining({
      expected_updated_at: 30,
    }));
    expect(mount.getState().dialog.values['auth.token']).toBe(
      'keep-after-conflict',
    );
    expect(mount.getState().dialog.error).toBeNull();
    expect(mount.getState().dialog.externalChange?.phase).toBe('changed');
    expect(getHtml()).toContain('Connection changed since you opened it');
    mount.dispose();
  });

  it('recovers a committed rotation after reload without retaining the credential', async () => {
    const continuity = rotationContinuity();
    const tabs = rotationTabs();
    expect(continuity.store.write({
      attemptId: 'rotation-reload-test-0001',
      kind: 'api',
      name: 'reload-api',
    })).toBe('stored');
    const { mount, calls, getHtml } = mountPanel({
      connections: [connection('reload-api', { auth_type: 'oauth2_refresh' })],
      credentialRotationContinuity: continuity.store,
      credentialRotationTabConvergence: tabs.convergence,
      runCredentialRotationStatus: async () => ({
        outcome: {
          status: 'succeeded',
          started_at: FIXED_NOW,
          verification: {
            status: 'verified',
            verified_at: FIXED_NOW + 1_000,
            auth_type: 'oauth2_refresh',
            access_expires_at: FIXED_NOW + 3_600_000,
          },
        },
      }),
    });

    await mount.whenLoaded();
    expect(calls.runCredentialRotationStatus).toHaveBeenCalledWith({
      attempt_id: 'rotation-reload-test-0001',
      kind: 'api',
      name: 'reload-api',
    });
    expect(calls.runRotateCredentials).not.toHaveBeenCalled();
    expect(tabs.notifyCredentialRotated).toHaveBeenCalledWith({
      kind: 'api',
      name: 'reload-api',
    });
    expect(continuity.store.read()).toBeNull();
    expect(mount.getState().credentialRotationRecovery).toBeNull();
    expect(mount.getState().dialog.recentProbe).toMatchObject({
      purpose: 'credential_rotation',
      status: 'verified',
      name: 'reload-api',
      auth_type: 'oauth2_refresh',
    });
    expect(getHtml()).toContain('replacement for api/reload-api was checked and is now in use');
    expect(getHtml()).toContain('That is what this says happened');
    expect(calls.runList).toHaveBeenCalledTimes(2);
    expect(JSON.stringify([...continuity.values.values()])).not.toMatch(
      /refresh_token|client_secret|access_token/i,
    );
    mount.dispose();
  });

  it('lands a former owner on the successor result without re-announcing ownership', async () => {
    const continuity = rotationContinuity();
    const unexpectedLease = rotationOwnershipLease();
    const tabs = rotationTabs({
      supportsOwnershipLeases: true,
      claim: async () => unexpectedLease,
    });
    expect(continuity.store.write({
      attemptId: 'rotation-former-owner-0001',
      kind: 'api',
      name: 'handoff-api',
      baselineUpdatedAt: 70,
    })).toBe('stored');
    let successorPending = true;
    const formerRow = connection('handoff-api', {
      display_name: 'Before takeover',
      base_url: 'https://before.example.com',
      auth_type: 'bearer',
      updated_at: 70,
    });
    const successorRow = connection('handoff-api', {
      display_name: 'Successor version',
      base_url: 'https://successor.example.com',
      auth_type: 'oauth2_refresh',
      updated_at: 71,
    });
    const { mount, click, calls, getHtml } = mountPanel({
      runList: async () => ({
        connections: [successorPending ? formerRow : successorRow],
      }),
      credentialRotationContinuity: continuity.store,
      credentialRotationTabConvergence: tabs.convergence,
      runCredentialRotationStatus: async () => ({
        outcome: {
          status: 'failed',
          started_at: FIXED_NOW,
          finished_at: FIXED_NOW + 1_000,
          reason: 'unreachable',
        },
      }),
      runCredentialRotationActivity: async () => ({
        activity: successorPending
          ? { status: 'pending', started_at: FIXED_NOW + 2_000 }
          : { status: 'idle' },
      }),
    });

    await mount.whenLoaded();
    expect(mount.getState().credentialRotationRecovery).toMatchObject({
      phase: 'handoff',
      name: 'handoff-api',
    });
    expect(getHtml()).toContain('Another tab has taken over the next credential check');
    expect(getHtml()).toContain('Check handoff');
    expect(continuity.store.read()?.attemptId).toBe(
      'rotation-former-owner-0001',
    );
    expect(tabs.claimCredentialRotationOwnership).not.toHaveBeenCalled();
    expect(unexpectedLease.release).not.toHaveBeenCalled();
    expect(tabs.notifyCredentialRotationStarted).not.toHaveBeenCalled();

    successorPending = false;
    click({ action: 'connections-check-credential-rotation' });
    await tick();

    expect(calls.runCredentialRotationStatus).toHaveBeenCalledTimes(2);
    expect(calls.runCredentialRotationActivity).toHaveBeenCalledTimes(2);
    expect(calls.runRotateCredentials).not.toHaveBeenCalled();
    expect(continuity.store.read()).toBeNull();
    expect(mount.getState().credentialRotationRecovery).toMatchObject({
      phase: 'superseded',
      name: 'handoff-api',
    });
    expect(mount.getState().connections[0]?.display_name).toBe(
      'Successor version',
    );
    expect(getHtml()).toContain('Recued kept the newer server version');
    expect(getHtml()).toContain('Look at the connection');
    expect(getHtml()).not.toContain('Recued kept the old key');
    expect(tabs.claimCredentialRotationOwnership).toHaveBeenCalledOnce();
    expect(unexpectedLease.release).toHaveBeenCalledOnce();
    expect(tabs.notifyCredentialRotationStarted).not.toHaveBeenCalled();

    click({
      action: 'connections-review-credential-rotation',
      kind: 'api',
      name: 'handoff-api',
    });
    expect(mount.getState().credentialRotationRecovery).toBeNull();
    expect(mount.getState().dialog.editingId).toBe('api/handoff-api');
    expect(mount.getState().dialog.values.display_name).toBe(
      'Successor version',
    );
    mount.dispose();
  });

  it('returns an unchanged former-owner draft to an explicit, safely rechecked resume', async () => {
    const continuity = rotationContinuity();
    const probeLease = rotationOwnershipLease();
    const submitLease = rotationOwnershipLease();
    const leases = [probeLease, submitLease];
    const tabs = rotationTabs({
      supportsOwnershipLeases: true,
      claim: async () => leases.shift() ?? null,
    });
    expect(continuity.store.write({
      attemptId: 'rotation-former-owner-resume-0001',
      kind: 'api',
      name: 'resume-api',
      baselineUpdatedAt: 72,
    })).toBe('stored');
    const reconnect: { current?: () => void } = {};
    let successorPending = true;
    const unchanged = connection('resume-api', {
      display_name: 'Unchanged version',
      base_url: 'https://unchanged.example.com',
      auth_type: 'bearer',
      updated_at: 72,
    });
    const {
      mount,
      click,
      field,
      calls,
      getHtml,
      getFocusedSelector,
      submitBtn,
    } = mountPanel({
      runList: async () => ({ connections: [unchanged] }),
      credentialRotationContinuity: continuity.store,
      credentialRotationTabConvergence: tabs.convergence,
      runCredentialRotationStatus: async () => ({
        outcome: {
          status: 'failed',
          started_at: FIXED_NOW,
          finished_at: FIXED_NOW + 1_000,
          reason: 'auth_failed',
          correction: {
            auth_type: 'bearer',
            field_keys: ['auth.token'],
            triage: {
              reason: 'repeated_auth_rejection',
              stage: 'provider_probe',
              endpoint_field_keys: ['config.base_url', 'config.endpoint'],
            },
          },
        },
      }),
      runCredentialRotationActivity: async () => ({
        activity: successorPending
          ? { status: 'pending', started_at: FIXED_NOW + 2_000 }
          : { status: 'idle' },
      }),
      onReconnect: (listener) => {
        reconnect.current = listener;
        return () => { delete reconnect.current; };
      },
    });

    await mount.whenLoaded();
    click({ action: 'connections-edit', kind: 'api', name: 'resume-api' });
    field('auth.token', 'memory-only-resume-secret');
    expect(mount.getState().dialog.credentialRotationOwnership?.phase)
      .toBe('handoff');

    successorPending = false;
    click({ action: 'connections-check-credential-rotation' });
    await tick();

    expect(continuity.store.read()).toBeNull();
    expect(mount.getState().credentialRotationRecovery).toMatchObject({
      phase: 'resumable',
      failureReason: 'auth_failed',
      name: 'resume-api',
    });
    expect(mount.getState().dialog.credentialRotationOwnership).toBeNull();
    expect(mount.getState().dialog.error).toBeNull();
    expect(mount.getState().dialog.credentialCorrection).toEqual({
      message: 'The provider rejected the replacement. Your Recued kept the old key; correct the replacement and try again.',
      fieldKeys: ['auth.token'],
      triage: {
        stage: 'provider_probe',
        endpointFieldKeys: ['config.base_url'],
      },
    });
    expect(mount.getState().dialog.values['auth.token']).toBe(
      'memory-only-resume-secret',
    );
    expect(getHtml()).toContain('Replacement rejected');
    expect(getHtml()).toContain('Replacement rejected again');
    expect(getHtml()).toContain('Review Base URL');
    expect(getFocusedSelector()).toBe(fieldSelector('auth.token'));
    expect(getHtml()).toContain(
      'data-connection-credential-recovery="resumable"',
    );
    expect(getHtml()).toContain('aria-atomic="true"');
    expect(getHtml()).toContain('you can continue in this tab');
    expect(getHtml()).toContain('No newer credential was saved');
    expect(getHtml()).toContain('is still only here');
    expect(getHtml()).toContain(
      'confirm that no other tab or server check owns this connection',
    );
    expect(submitBtn.hasAttribute('disabled')).toBe(false);
    expect(probeLease.release).toHaveBeenCalledOnce();
    expect(tabs.notifyCredentialRotationStarted).not.toHaveBeenCalled();

    reconnect.current?.();
    await tick();
    expect(mount.getState().credentialRotationRecovery?.phase)
      .toBe('resumable');
    expect(mount.getState().dialog.values['auth.token']).toBe(
      'memory-only-resume-secret',
    );
    expect(getHtml()).toContain('you can continue in this tab');

    click({ action: 'connections-submit-form' });
    await tick(20);

    expect(tabs.claimCredentialRotationOwnership).toHaveBeenCalledTimes(2);
    expect(calls.runRotateCredentials).toHaveBeenCalledOnce();
    expect(calls.runRotateCredentials.mock.calls[0]![0].patch.auth).toEqual({
      type: 'bearer',
      token: 'memory-only-resume-secret',
    });
    expect(tabs.notifyCredentialRotationStarted).toHaveBeenCalledOnce();
    expect(submitLease.release).toHaveBeenCalledOnce();
    expect(mount.getState().credentialRotationRecovery).toBeNull();
    expect(getHtml()).not.toContain('you can continue in this tab');
    mount.dispose();
  });

  it('falls back to generic review for malformed recovered correction metadata', async () => {
    const continuity = rotationContinuity();
    expect(continuity.store.write({
      attemptId: 'rotation-malformed-correction-0001',
      kind: 'api',
      name: 'malformed-api',
      baselineUpdatedAt: 72,
    })).toBe('stored');
    const unchanged = connection('malformed-api', {
      auth_type: 'bearer',
      updated_at: 72,
    });
    const { mount, getHtml } = mountPanel({
      connections: [unchanged],
      runList: async () => ({ connections: [unchanged] }),
      credentialRotationContinuity: continuity.store,
      runCredentialRotationStatus: async () => ({
        outcome: {
          status: 'failed',
          started_at: FIXED_NOW,
          finished_at: FIXED_NOW + 1_000,
          reason: 'auth_failed',
          correction: {
            auth_type: 'bearer',
            // Contract-shaped but not the canonical bearer correction.
            field_keys: ['auth.password'],
          },
        },
      }),
    });

    await mount.whenLoaded();

    expect(continuity.store.read()).toBeNull();
    expect(mount.getState().credentialRotationRecovery).toMatchObject({
      phase: 'failed',
      failureReason: 'auth_failed',
      name: 'malformed-api',
    });
    expect(mount.getState().credentialRotationRecovery).not.toHaveProperty(
      'correction',
    );
    expect(getHtml()).toContain('Look at the connection');
    expect(getHtml()).not.toContain('Correct replacement');
    expect(getHtml()).not.toContain('data-connection-credential-correction');
    mount.dispose();
  });

  it('restores a cleared handoff after reload and offers one safe clean start', async () => {
    const continuity = rotationContinuity();
    expect(continuity.store.write({
      attemptId: 'rotation-cleared-handoff-0001',
      kind: 'api',
      name: 'cleared-handoff-api',
      baselineUpdatedAt: 75,
    })).toBe('stored');
    const unchanged = connection('cleared-handoff-api', {
      display_name: 'Cleared handoff API',
      base_url: 'https://unchanged.example.com',
      auth_type: 'bearer',
      updated_at: 75,
    });
    const firstTabs = rotationTabs();
    const first = mountPanel({
      connections: [unchanged],
      credentialRotationContinuity: continuity.store,
      credentialRotationTabConvergence: firstTabs.convergence,
      runCredentialRotationStatus: async () => ({
        outcome: {
          status: 'failed',
          started_at: FIXED_NOW,
          finished_at: FIXED_NOW + 1_000,
          reason: 'unreachable',
        },
      }),
      runCredentialRotationActivity: async () => ({
        activity: { status: 'pending', started_at: FIXED_NOW + 2_000 },
      }),
    });

    await first.mount.whenLoaded();
    expect(first.mount.getState().credentialRotationRecovery?.phase)
      .toBe('handoff');
    expect(continuity.store.read()).toMatchObject({
      attemptId: 'rotation-cleared-handoff-0001',
      successorObservedAt: FIXED_NOW,
    });
    const persistedHandoff = continuity.values.get(
      CREDENTIAL_ROTATION_CONTINUITY_SESSION_KEY,
    )!;
    expect(JSON.parse(persistedHandoff)).toMatchObject({
      version: 3,
      baseline_updated_at: 75,
      successor_observed_at: FIXED_NOW,
    });
    expect(persistedHandoff).not.toMatch(
      /refresh_token|client_secret|access_token|bearer/i,
    );
    first.mount.dispose();

    const restoredStore = createCredentialRotationContinuityStore({
      storage: continuity.storage,
      scopeId: 'profile-panel-test',
      now: () => FIXED_NOW + 3_000,
    });
    const probeLease = rotationOwnershipLease();
    const restoredTabs = rotationTabs({
      supportsOwnershipLeases: true,
      claim: async () => probeLease,
    });
    const reconnect: { current?: () => void } = {};
    const restored = mountPanel({
      connections: [unchanged],
      credentialRotationContinuity: restoredStore,
      credentialRotationTabConvergence: restoredTabs.convergence,
      runCredentialRotationStatus: async () => ({
        outcome: {
          status: 'failed',
          started_at: FIXED_NOW,
          finished_at: FIXED_NOW + 1_000,
          reason: 'unreachable',
        },
      }),
      runCredentialRotationActivity: async () => ({
        activity: { status: 'idle' },
      }),
      onReconnect: (listener) => {
        reconnect.current = listener;
        return () => { delete reconnect.current; };
      },
    });

    await restored.mount.whenLoaded();
    expect(restoredStore.read()).toBeNull();
    expect(continuity.values.has(
      CREDENTIAL_ROTATION_CONTINUITY_SESSION_KEY,
    )).toBe(false);
    expect(restored.mount.getState().credentialRotationRecovery).toMatchObject({
      phase: 'restart_ready',
      failureReason: 'unreachable',
      baselineUpdatedAt: 75,
      name: 'cleared-handoff-api',
    });
    expect(restored.getHtml()).toContain(
      'data-connection-credential-recovery="restart_ready"',
    );
    expect(restored.getHtml()).toContain('unfinished credentials are never stored');
    expect(restored.getHtml()).toContain('Start fresh');
    expect(restored.getHtml()).toContain(
      'aria-label="Start a fresh credential replacement for api/cleared-handoff-api"',
    );
    expect(restored.getHtml()).toContain('recheck ownership before sending');
    expect(restored.getHtml()).not.toContain('Look at the connection');
    expect(probeLease.release).toHaveBeenCalledOnce();

    reconnect.current?.();
    await tick(20);
    expect(restored.mount.getState().credentialRotationRecovery?.phase)
      .toBe('restart_ready');
    expect(restored.getHtml()).toContain('Start fresh');

    const activityChecksBeforeFreshStart =
      restored.calls.runCredentialRotationActivity.mock.calls.length;
    const listReadsBeforeFreshStart = restored.calls.runList.mock.calls.length;
    restored.click({
      action: 'connections-start-fresh-credential-rotation',
      kind: 'api',
      name: 'cleared-handoff-api',
    });
    expect(restored.mount.getState().credentialRotationRecovery?.phase)
      .toBe('restart_checking');
    expect(restored.mount.getState().dialog.stage).toBe('closed');
    expect(restored.getHtml()).toContain('Checking server…');
    expect(restored.getHtml()).toContain('aria-busy="true"');
    expect(restored.getHtml()).toContain('tabindex="-1"');
    expect(restored.getFocusedSelector()).toBe(FRESH_START_CHECKING_SELECTOR);
    restored.click({
      action: 'connections-start-fresh-credential-rotation',
      kind: 'api',
      name: 'cleared-handoff-api',
    });
    expect(restored.calls.runCredentialRotationActivity).toHaveBeenCalledTimes(
      activityChecksBeforeFreshStart + 1,
    );
    await tick();

    expect(restored.mount.getState().credentialRotationRecovery).toBeNull();
    expect(restored.mount.getState().dialog.editingId)
      .toBe('api/cleared-handoff-api');
    expect(restored.mount.getState().dialog.values['auth.token'])
      .toBeUndefined();
    expect(restored.getFocusedSelector()).toBe(fieldSelector('auth.token'));
    expect(restored.getHtml()).not.toContain('Start fresh');
    expect(restored.calls.runCredentialRotationActivity).toHaveBeenCalledTimes(
      activityChecksBeforeFreshStart + 1,
    );
    expect(restored.calls.runList).toHaveBeenCalledTimes(
      listReadsBeforeFreshStart + 1,
    );
    expect(restored.calls.runRotateCredentials).not.toHaveBeenCalled();
    restored.mount.dispose();
  });

  it('keeps credentials closed while server activity is pending, then rechecks before opening', async () => {
    const continuity = rotationContinuity();
    expect(continuity.store.write({
      attemptId: 'rotation-fresh-start-pending-0001',
      kind: 'api',
      name: 'fresh-start-pending-api',
      baselineUpdatedAt: 76,
    })).toBe('stored');
    expect(continuity.store.markSuccessorObserved(
      'rotation-fresh-start-pending-0001',
    )).toBe('stored');
    const probeLease = rotationOwnershipLease();
    const tabs = rotationTabs({
      supportsOwnershipLeases: true,
      claim: async () => probeLease,
    });
    const unchanged = connection('fresh-start-pending-api', {
      auth_type: 'bearer',
      updated_at: 76,
    });
    let activityRead = 0;
    const panel = mountPanel({
      connections: [unchanged],
      credentialRotationContinuity: continuity.store,
      credentialRotationTabConvergence: tabs.convergence,
      runCredentialRotationStatus: async () => ({
        outcome: {
          status: 'failed',
          started_at: FIXED_NOW,
          finished_at: FIXED_NOW + 1_000,
          reason: 'server_error',
        },
      }),
      runCredentialRotationActivity: async () => {
        activityRead += 1;
        return {
          activity: activityRead === 2
            ? { status: 'pending', started_at: FIXED_NOW + 2_000 }
            : { status: 'idle' },
        };
      },
    });

    await panel.mount.whenLoaded();
    expect(panel.mount.getState().credentialRotationRecovery?.phase)
      .toBe('restart_ready');

    panel.click({
      action: 'connections-start-fresh-credential-rotation',
      kind: 'api',
      name: 'fresh-start-pending-api',
    });
    await tick();

    expect(panel.mount.getState().credentialRotationRecovery?.phase)
      .toBe('restart_handoff');
    expect(panel.mount.getState().dialog.stage).toBe('closed');
    expect(panel.getHtml()).toContain('No credential entry is needed here yet');
    expect(panel.getHtml()).toContain('Check handoff');
    expect(panel.getHtml()).not.toContain('data-conn-field="auth.token"');

    panel.click({
      action: 'connections-start-fresh-credential-rotation',
      kind: 'api',
      name: 'fresh-start-pending-api',
    });
    expect(panel.mount.getState().credentialRotationRecovery?.phase)
      .toBe('restart_checking');
    await tick();

    expect(panel.mount.getState().credentialRotationRecovery).toBeNull();
    expect(panel.mount.getState().dialog.editingId)
      .toBe('api/fresh-start-pending-api');
    expect(panel.mount.getState().dialog.values['auth.token']).toBeUndefined();
    expect(panel.getFocusedSelector()).toBe(fieldSelector('auth.token'));
    expect(panel.calls.runCredentialRotationActivity).toHaveBeenCalledTimes(3);
    expect(panel.calls.runRotateCredentials).not.toHaveBeenCalled();
    panel.mount.dispose();
  });

  it('keeps a retryable clean-start receipt offline and resumes it after reconnect', async () => {
    const continuity = rotationContinuity();
    expect(continuity.store.write({
      attemptId: 'rotation-fresh-start-reconnect-0001',
      kind: 'api',
      name: 'fresh-start-reconnect-api',
      baselineUpdatedAt: 77,
    })).toBe('stored');
    expect(continuity.store.markSuccessorObserved(
      'rotation-fresh-start-reconnect-0001',
    )).toBe('stored');
    const probeLease = rotationOwnershipLease();
    const tabs = rotationTabs({
      supportsOwnershipLeases: true,
      claim: async () => probeLease,
    });
    const reconnect: { current?: () => void } = {};
    let activityReachable = true;
    const panel = mountPanel({
      connections: [connection('fresh-start-reconnect-api', {
        auth_type: 'bearer',
        updated_at: 77,
      })],
      credentialRotationContinuity: continuity.store,
      credentialRotationTabConvergence: tabs.convergence,
      runCredentialRotationStatus: async () => ({
        outcome: {
          status: 'failed',
          started_at: FIXED_NOW,
          finished_at: FIXED_NOW + 1_000,
          reason: 'unreachable',
        },
      }),
      runCredentialRotationActivity: async () => {
        if (!activityReachable) throw new Error('paired server disconnected');
        return { activity: { status: 'idle' } };
      },
      onReconnect: (listener) => {
        reconnect.current = listener;
        return () => { delete reconnect.current; };
      },
    });

    await panel.mount.whenLoaded();
    activityReachable = false;
    panel.click({
      action: 'connections-start-fresh-credential-rotation',
      kind: 'api',
      name: 'fresh-start-reconnect-api',
    });
    await tick();

    expect(panel.mount.getState().credentialRotationRecovery?.phase)
      .toBe('restart_waiting');
    expect(panel.mount.getState().dialog.stage).toBe('closed');
    expect(panel.getHtml()).toContain('No credential was sent');
    expect(panel.getHtml()).toContain('Try again');
    expect(panel.getFocusedSelector()).toBe(
      FRESH_START_SELECTOR,
    );

    activityReachable = true;
    reconnect.current?.();
    await tick(20);

    expect(panel.mount.getState().credentialRotationRecovery).toBeNull();
    expect(panel.mount.getState().dialog.editingId)
      .toBe('api/fresh-start-reconnect-api');
    expect(panel.mount.getState().dialog.values['auth.token']).toBeUndefined();
    expect(panel.getFocusedSelector()).toBe(fieldSelector('auth.token'));
    expect(panel.calls.runRotateCredentials).not.toHaveBeenCalled();
    panel.mount.dispose();
  });

  it('does not resurrect a disposed panel when a reconnect preflight becomes ready late', async () => {
    const continuity = rotationContinuity();
    expect(continuity.store.write({
      attemptId: 'rotation-fresh-start-disposed-reconnect-0001',
      kind: 'api',
      name: 'fresh-start-disposed-reconnect-api',
      baselineUpdatedAt: 78,
    })).toBe('stored');
    expect(continuity.store.markSuccessorObserved(
      'rotation-fresh-start-disposed-reconnect-0001',
    )).toBe('stored');
    const probeLease = rotationOwnershipLease();
    const tabs = rotationTabs({
      supportsOwnershipLeases: true,
      claim: async () => probeLease,
    });
    const unchanged = connection('fresh-start-disposed-reconnect-api', {
      auth_type: 'bearer',
      updated_at: 78,
    });
    const reconnectList = deferred<{
      connections: ReadonlyArray<ConnectionView>;
    }>();
    let listRead = 0;
    let activityReachable = true;
    const reconnect: { current?: () => void } = {};
    const panel = mountPanel({
      runList: async () => {
        listRead += 1;
        return listRead <= 2
          ? { connections: [unchanged] }
          : reconnectList.promise;
      },
      credentialRotationContinuity: continuity.store,
      credentialRotationTabConvergence: tabs.convergence,
      runCredentialRotationStatus: async () => ({
        outcome: {
          status: 'failed',
          started_at: FIXED_NOW,
          finished_at: FIXED_NOW + 1_000,
          reason: 'unreachable',
        },
      }),
      runCredentialRotationActivity: async () => {
        if (!activityReachable) throw new Error('paired server disconnected');
        return { activity: { status: 'idle' } };
      },
      onReconnect: (listener) => {
        reconnect.current = listener;
        return () => { delete reconnect.current; };
      },
    });

    await panel.mount.whenLoaded();
    activityReachable = false;
    panel.click({
      action: 'connections-start-fresh-credential-rotation',
      kind: 'api',
      name: 'fresh-start-disposed-reconnect-api',
    });
    await tick();
    expect(panel.mount.getState().credentialRotationRecovery?.phase)
      .toBe('restart_waiting');

    activityReachable = true;
    const activityReadsBeforeReconnect =
      panel.calls.runCredentialRotationActivity.mock.calls.length;
    reconnect.current?.();
    await tick();
    expect(listRead).toBe(3);
    panel.mount.dispose();
    expect(panel.getHtml()).toBe('');

    reconnectList.resolve({ connections: [unchanged] });
    await tick(20);

    expect(panel.getHtml()).toBe('');
    expect(panel.calls.runCredentialRotationActivity).toHaveBeenCalledTimes(
      activityReadsBeforeReconnect,
    );
  });

  it('fails closed when the paired server cannot run the fresh-start preflight', async () => {
    const continuity = rotationContinuity();
    expect(continuity.store.write({
      attemptId: 'rotation-fresh-start-unsupported-0001',
      kind: 'api',
      name: 'fresh-start-unsupported-api',
      baselineUpdatedAt: 78,
    })).toBe('stored');
    expect(continuity.store.markSuccessorObserved(
      'rotation-fresh-start-unsupported-0001',
    )).toBe('stored');
    const onOpenCredentialRotationServerUpdateGuide = vi.fn();
    const panel = mountPanel({
      connections: [connection('fresh-start-unsupported-api', {
        auth_type: 'bearer',
        updated_at: 78,
      })],
      credentialRotationContinuity: continuity.store,
      runCredentialRotationStatus: async () => ({
        outcome: {
          status: 'failed',
          started_at: FIXED_NOW,
          finished_at: FIXED_NOW + 1_000,
          reason: 'server_error',
        },
      }),
      onOpenCredentialRotationServerUpdateGuide,
    });

    await panel.mount.whenLoaded();
    const listReadsBeforeStart = panel.calls.runList.mock.calls.length;
    expect(panel.mount.getState().credentialRotationRecovery?.phase)
      .toBe('restart_ready');

    panel.click({
      action: 'connections-start-fresh-credential-rotation',
      kind: 'api',
      name: 'fresh-start-unsupported-api',
    });

    expect(panel.mount.getState().credentialRotationRecovery?.phase)
      .toBe('restart_unsupported');
    expect(panel.mount.getState().dialog.stage).toBe('closed');
    expect(panel.getHtml()).toContain('cannot perform the activity preflight');
    expect(panel.getHtml()).toContain('Update the server before trying again');
    expect(panel.getHtml()).toContain('Review update steps');
    expect(panel.getHtml()).toContain('Check again');
    expect(panel.getHtml()).toContain('Dismiss');
    expect(panel.calls.runList).toHaveBeenCalledTimes(listReadsBeforeStart);
    expect(panel.calls.runRotateCredentials).not.toHaveBeenCalled();

    panel.click({
      action: 'connections-review-server-update',
      kind: 'api',
      name: 'fresh-start-unsupported-api',
    });
    expect(onOpenCredentialRotationServerUpdateGuide).toHaveBeenCalledOnce();
    expect(onOpenCredentialRotationServerUpdateGuide).toHaveBeenCalledWith({
      kind: 'api',
      name: 'fresh-start-unsupported-api',
    });
    expect(panel.mount.getState().credentialRotationRecovery?.phase)
      .toBe('restart_unsupported');
    expect(panel.calls.runList).toHaveBeenCalledTimes(listReadsBeforeStart);

    panel.click({
      action: 'connections-dismiss-credential-rotation',
      kind: 'api',
      name: 'fresh-start-unsupported-api',
    });
    expect(panel.mount.getState().credentialRotationRecovery).toBeNull();
    expect(panel.mount.getState().dialog.stage).toBe('closed');
    panel.mount.dispose();
  });

  it('triages the exact selected server when support is still absent after the update return', async () => {
    const triage = deferred<{
      reason: 'running_version_changed';
      checkStatus: 'up-to-date';
      baselineVersion: string;
      currentVersion: string;
      channel: 'stable';
    }>();
    const onOpenCredentialRotationServerUpdateGuide = vi.fn();
    const panel = mountPanel({
      connections: [connection('guided-still-unsupported-api', {
        auth_type: 'bearer',
        updated_at: 81,
      })],
      credentialRotationContinuity: null,
      runCredentialRotationActivity: async () => {
        throw Object.assign(new Error('method unavailable'), {
          code: 'unknown_method',
        });
      },
      runCredentialRotationServerUpdateTriage: async () => triage.promise,
      onOpenCredentialRotationServerUpdateGuide,
      initialCredentialRotationServerUpdateRetry: {
        kind: 'api',
        name: 'guided-still-unsupported-api',
      },
    });

    await panel.mount.whenLoaded();
    await tick();
    expect(panel.mount.getState().credentialRotationRecovery).toMatchObject({
      phase: 'restart_triaging',
      returnedFromServerUpdate: true,
    });
    expect(panel.getHtml()).toContain('Checking its running version');
    expect(panel.getFocusedSelector()).toBe(FRESH_START_TRIAGING_SELECTOR);

    triage.resolve({
      reason: 'running_version_changed',
      checkStatus: 'up-to-date',
      baselineVersion: '26.7.3',
      currentVersion: '26.8.0',
      channel: 'stable',
    });
    await tick();

    expect(panel.calls.runCredentialRotationServerUpdateTriage)
      .toHaveBeenCalledWith({
        kind: 'api',
        name: 'guided-still-unsupported-api',
      });
    expect(panel.mount.getState().credentialRotationRecovery).toMatchObject({
      phase: 'restart_unsupported',
      returnedFromServerUpdate: true,
      serverUpdateTriage: {
        reason: 'running_version_changed',
        baselineVersion: '26.7.3',
        currentVersion: '26.8.0',
      },
    });
    expect(panel.getHtml()).toContain('went from version 26.7.3 to 26.8.0');
    expect(panel.getHtml()).toContain('What the server said: running 26.8.0');
    expect(panel.getHtml()).toContain('Review server profile');
    expect(panel.getHtml()).not.toContain('Review update steps');
    expect(panel.getFocusedSelector()).toBe(SERVER_UPDATE_REVIEW_SELECTOR);
    expect(panel.calls.runRotateCredentials).not.toHaveBeenCalled();

    panel.click({
      action: 'connections-review-server-update',
      kind: 'api',
      name: 'guided-still-unsupported-api',
    });
    expect(onOpenCredentialRotationServerUpdateGuide).toHaveBeenCalledWith({
      kind: 'api',
      name: 'guided-still-unsupported-api',
    });
    expect(panel.mount.getState().credentialRotationRecovery?.phase)
      .toBe('restart_unsupported');
    panel.mount.dispose();
  });

  it('focuses Check again when post-update triage has no Account guide host', async () => {
    const panel = mountPanel({
      connections: [connection('standalone-still-unsupported-api', {
        auth_type: 'bearer',
        updated_at: 82,
      })],
      credentialRotationContinuity: null,
      runCredentialRotationActivity: async () => {
        throw Object.assign(new Error('method unavailable'), {
          code: 'unknown_method',
        });
      },
      runCredentialRotationServerUpdateTriage: async () => ({
        reason: 'current_build_missing_capability',
        checkStatus: 'up-to-date',
        currentVersion: '26.8.0',
        channel: 'stable',
      }),
      initialCredentialRotationServerUpdateRetry: {
        kind: 'api',
        name: 'standalone-still-unsupported-api',
      },
    });

    await panel.mount.whenLoaded();
    await tick();
    await tick();

    expect(panel.mount.getState().credentialRotationRecovery?.phase)
      .toBe('restart_unsupported');
    expect(panel.getHtml()).not.toContain('Review server profile');
    expect(panel.getHtml()).toContain('Check again');
    expect(panel.getFocusedSelector()).toBe(FRESH_START_SELECTOR);
    panel.mount.dispose();
  });

  it('shows a freshly confirmed capability without opening a form until the owner continues here', async () => {
    const statusListeners = new Set<(status: 'connected') => void>();
    const continuity = createCredentialRotationServerUpdateContinuity({
      storage: null,
      scopeId: 'profile-panel-test',
      status: () => 'connected',
      onStatus: (listener) => {
        statusListeners.add(listener as (status: 'connected') => void);
        return () => {
          statusListeners.delete(listener as (status: 'connected') => void);
        };
      },
      now: () => FIXED_NOW,
    });
    const target = {
      kind: 'api' as const,
      name: 'sibling-capability-api',
    };
    continuity.begin(target);
    continuity.markStillUnsupported(target, null);
    const panel = mountPanel({
      connections: [connection(target.name, {
        auth_type: 'bearer',
        updated_at: 85,
      })],
      credentialRotationContinuity: null,
      credentialRotationServerUpdateContinuity: continuity,
      runCredentialRotationActivity: async () => ({
        activity: { status: 'idle' },
      }),
    });
    await panel.mount.whenLoaded();

    expect(continuity.markCapabilityResolvedElsewhere(target)).toBe(true);

    expect(panel.mount.getState().credentialRotationRecovery).toMatchObject({
      ...target,
      phase: 'restart_resolved',
      baselineUpdatedAt: 85,
      returnedFromServerUpdate: true,
    });
    expect(panel.mount.getState().dialog.stage).toBe('closed');
    expect(panel.calls.runCredentialRotationActivity).not.toHaveBeenCalled();
    expect(panel.getHtml()).toContain('A look-only check says');
    expect(panel.getHtml()).toContain('You stayed on this page');
    expect(panel.getHtml()).toContain('Continue in this tab');
    expect(panel.getFocusedSelector()).toBeNull();

    panel.click({
      action: 'connections-start-fresh-credential-rotation',
      ...target,
    });
    await tick(30);

    expect(panel.calls.runCredentialRotationActivity).toHaveBeenCalledOnce();
    expect(continuity.read()?.phase).toBe('ready');
    expect(panel.mount.getState().credentialRotationRecovery).toMatchObject({
      ...target,
      phase: 'editor_ready',
      returnedFromServerUpdate: true,
    });
    expect(panel.mount.getState().dialog.editingId)
      .toBe('api/sibling-capability-api');
    expect(panel.mount.getState().dialog.values['auth.token']).toBeUndefined();
    panel.mount.dispose();
    continuity.dispose();
    expect(statusListeners.size).toBe(0);
  });

  it('joins sibling update progress without navigating, opening a form, or running a retry', async () => {
    const continuity = createCredentialRotationServerUpdateContinuity({
      storage: null,
      scopeId: 'profile-panel-test',
      status: () => 'connected',
      onStatus: () => () => undefined,
      now: () => FIXED_NOW,
    });
    const target = {
      kind: 'api' as const,
      name: 'sibling-update-api',
    };
    continuity.begin(target);
    continuity.markStillUnsupported(target, null);
    const panel = mountPanel({
      connections: [connection(target.name, {
        auth_type: 'bearer',
        updated_at: 86,
      })],
      credentialRotationContinuity: null,
      credentialRotationServerUpdateContinuity: continuity,
      runCredentialRotationActivity: async () => ({
        activity: { status: 'idle' },
      }),
    });
    await panel.mount.whenLoaded();

    continuity.observeServerUpdateProgress({
      phase: 'applying',
      operation: 'update',
      startedAt: FIXED_NOW + 1,
    });

    expect(panel.mount.getState().credentialRotationRecovery).toMatchObject({
      ...target,
      phase: 'restart_unsupported',
      returnedFromServerUpdate: true,
      serverUpdateProgress: {
        phase: 'applying',
        operation: 'update',
      },
    });
    expect(panel.mount.getState().dialog.stage).toBe('closed');
    expect(panel.getHtml()).toContain(
      'An open Recued tab is applying the server update',
    );
    expect(panel.getHtml()).not.toContain(
      'data-action="connections-start-fresh-credential-rotation"',
    );
    expect(panel.getFocusedSelector()).toBeNull();

    panel.click({
      action: 'connections-start-fresh-credential-rotation',
      ...target,
    });
    await tick();
    expect(panel.calls.runCredentialRotationActivity).not.toHaveBeenCalled();
    expect(panel.mount.getState().dialog.stage).toBe('closed');

    continuity.observeServerUpdateProgress({
      phase: 'awaiting_reconnect',
      operation: 'update',
      startedAt: FIXED_NOW + 1,
    });
    expect(panel.getHtml()).toContain('server accepted the update');
    expect(panel.getHtml()).toContain('verify its own reconnect');

    continuity.observeServerUpdateProgress(null);
    expect(panel.mount.getState().credentialRotationRecovery).toMatchObject({
      ...target,
      phase: 'restart_unsupported',
    });
    expect(
      panel.mount.getState().credentialRotationRecovery?.serverUpdateProgress,
    ).toBeUndefined();
    expect(panel.getHtml()).toContain('Check again');
    expect(panel.mount.getState().dialog.stage).toBe('closed');

    panel.mount.dispose();
    continuity.dispose();
  });

  it('keeps an open form in memory but pauses every save during sibling update progress', async () => {
    const tabs = rotationTabs();
    const target = {
      kind: 'api' as const,
      name: 'open-draft-update-api',
    };
    const panel = mountPanel({
      connections: [connection(target.name, {
        auth_type: 'bearer',
        updated_at: 87,
      })],
      credentialRotationContinuity: null,
      credentialRotationTabConvergence: tabs.convergence,
    });
    await panel.mount.whenLoaded();
    panel.click({ action: 'connections-edit', ...target });
    panel.field('display_name', 'Unsaved local label');

    tabs.emit({
      type: 'server_update_progress',
      progress: {
        phase: 'applying',
        operation: 'update',
        startedAt: FIXED_NOW + 1,
      },
    });

    expect(panel.mount.getState().dialog.stage).toBe('form');
    expect(panel.mount.getState().dialog.values.display_name)
      .toBe('Unsaved local label');
    expect(panel.mount.getState().dialog.error).toMatch(
      /server change is in progress.*unsaved form stays.*Save is paused/i,
    );
    expect(panel.submitBtn.hasAttribute('disabled')).toBe(true);

    panel.click({ action: 'connections-submit-form' });
    await tick();
    expect(panel.calls.runUpdate).not.toHaveBeenCalled();
    expect(panel.mount.getState().dialog.values.display_name)
      .toBe('Unsaved local label');

    tabs.emit({
      type: 'server_update_progress',
      progress: null,
    });
    expect(panel.mount.getState().dialog.stage).toBe('form');
    expect(panel.mount.getState().dialog.error).toBeNull();
    expect(panel.mount.getState().dialog.values.display_name)
      .toBe('Unsaved local label');
    panel.mount.dispose();
  });

  it('explains the pause when a form opens after sibling progress already started', async () => {
    const tabs = rotationTabs();
    const target = {
      kind: 'api' as const,
      name: 'late-open-update-api',
    };
    const panel = mountPanel({
      connections: [connection(target.name, {
        auth_type: 'bearer',
        updated_at: 88,
      })],
      credentialRotationContinuity: null,
      credentialRotationTabConvergence: tabs.convergence,
    });
    await panel.mount.whenLoaded();
    tabs.emit({
      type: 'server_update_progress',
      progress: {
        phase: 'awaiting_reconnect',
        operation: 'rollback',
        startedAt: FIXED_NOW + 1,
      },
    });

    panel.click({ action: 'connections-edit', ...target });

    expect(panel.mount.getState().dialog.stage).toBe('form');
    expect(panel.mount.getState().dialog.error).toMatch(
      /server change is in progress.*save is paused.*reconnects/i,
    );
    expect(panel.submitBtn.hasAttribute('disabled')).toBe(true);
    panel.click({ action: 'connections-submit-form' });
    await tick();
    expect(panel.calls.runUpdate).not.toHaveBeenCalled();
    panel.mount.dispose();
  });

  it('returns from the server guide to the exact connection and reruns the safe preflight', async () => {
    const activity = deferred<{
      activity: ConnectionCredentialRotationActivity;
    }>();
    const tabs = rotationTabs();
    const panel = mountPanel({
      connections: [
        connection('other-api', { auth_type: 'bearer', updated_at: 80 }),
        connection('guided-api', { auth_type: 'bearer', updated_at: 81 }),
      ],
      credentialRotationContinuity: null,
      credentialRotationTabConvergence: tabs.convergence,
      runCredentialRotationActivity: async () => activity.promise,
      initialCredentialRotationServerUpdateRetry: {
        kind: 'api',
        name: 'guided-api',
      },
    });

    await panel.mount.whenLoaded();
    await tick();

    expect(panel.mount.getState().credentialRotationRecovery).toMatchObject({
      kind: 'api',
      name: 'guided-api',
      phase: 'restart_checking',
      baselineUpdatedAt: 81,
      returnedFromServerUpdate: true,
    });
    expect(panel.getHtml()).toContain('Checking the updated server');
    expect(panel.getHtml()).toContain('api/guided-api');
    expect(panel.mount.getState().dialog.stage).toBe('closed');
    expect(panel.calls.runCredentialRotationActivity).toHaveBeenCalledOnce();
    expect(panel.calls.runCredentialRotationActivity).toHaveBeenCalledWith({
      kind: 'api',
      name: 'guided-api',
    });

    activity.resolve({ activity: { status: 'idle' } });
    await tick(30);

    expect(panel.mount.getState().credentialRotationRecovery).toMatchObject({
      kind: 'api',
      name: 'guided-api',
      phase: 'editor_ready',
      returnedFromServerUpdate: true,
    });
    expect(panel.mount.getState().dialog.editingId).toBe('api/guided-api');
    expect(panel.mount.getState().dialog.values['auth.token']).toBeUndefined();
    expect(panel.getFocusedSelector()).toBe(fieldSelector('auth.token'));
    expect(panel.calls.runList).toHaveBeenCalledTimes(2);
    expect(panel.calls.runRotateCredentials).not.toHaveBeenCalled();
    expect(tabs.notifyServerCapabilityResolved).toHaveBeenCalledOnce();
    expect(tabs.notifyServerCapabilityResolved).toHaveBeenCalledWith({
      kind: 'api',
      name: 'guided-api',
    });
    panel.mount.dispose();
  });

  it('lands a completed server recovery on the exact clean editor and retires its orientation on first input', async () => {
    const target = { kind: 'api' as const, name: 'guided-api' };
    const serverUpdateContinuity =
      createCredentialRotationServerUpdateContinuity({
        storage: null,
        scopeId: 'profile-panel-test',
        status: () => 'connected',
        onStatus: () => () => undefined,
        now: () => FIXED_NOW,
      });
    serverUpdateContinuity.begin(target);
    serverUpdateContinuity.observeServerUpdateVerification({
      phase: 'completed',
      operation: 'update',
      startedAt: FIXED_NOW + 1,
      reason: 'server_closed_unresolved',
      baseline: {
        currentVersion: '26.8.1',
        channel: 'stable',
        updateStatus: 'up-to-date',
        affectedConnection: {
          ...target,
          activity: 'idle',
        },
      },
    });
    const panel = mountPanel({
      connections: [
        connection('other-api', { auth_type: 'bearer', updated_at: 80 }),
        connection(target.name, { auth_type: 'bearer', updated_at: 81 }),
      ],
      credentialRotationContinuity: null,
      credentialRotationServerUpdateContinuity: serverUpdateContinuity,
      runCredentialRotationActivity: async () => ({
        activity: { status: 'idle' },
      }),
      initialCredentialRotationServerUpdateRetry: target,
    });

    await panel.mount.whenLoaded();
    await tick(30);

    expect(panel.calls.runCredentialRotationActivity).toHaveBeenCalledOnce();
    expect(panel.calls.runCredentialRotationActivity).toHaveBeenCalledWith(
      target,
    );
    expect(panel.calls.runList).toHaveBeenCalledTimes(2);
    expect(panel.mount.getState().dialog.editingId)
      .toBe('api/guided-api');
    expect(panel.mount.getState().dialog.values['auth.token']).toBeUndefined();
    expect(panel.mount.getState().credentialRotationRecovery).toMatchObject({
      ...target,
      phase: 'restart_ready',
      returnedFromServerUpdate: true,
      serverUpdateVerification: {
        phase: 'completed',
        baseline: {
          currentVersion: '26.8.1',
          affectedConnection: target,
        },
      },
    });
    expect(panel.getHtml()).toMatch(
      /server recovery is finished and server-change controls are unlocked.*original update result is still unknown.*enter a new replacement below/is,
    );
    expect(panel.getFocusedSelector()).toBe(fieldSelector('auth.token'));
    expect(panel.calls.runRotateCredentials).not.toHaveBeenCalled();

    panel.field('auth.token', 'new-memory-only-token');

    expect(panel.mount.getState().credentialRotationRecovery).toBeNull();
    expect(panel.mount.getState().dialog.values['auth.token'])
      .toBe('new-memory-only-token');
    expect(panel.getHtml()).not.toMatch(/server recovery is finished/i);
    expect(panel.calls.runRotateCredentials).not.toHaveBeenCalled();
    panel.mount.dispose();
    serverUpdateContinuity.dispose();
  });

  it('restores an untouched clean editor as target-only guidance, rechecks, then retires on first edit', async () => {
    const target = { kind: 'api' as const, name: 'guided-api' };
    const stored = new Map<string, string>();
    const serverUpdateContinuity =
      createCredentialRotationServerUpdateContinuity({
        storage: {
          getItem: (key) => stored.get(key) ?? null,
          setItem: (key, value) => { stored.set(key, value); },
          removeItem: (key) => { stored.delete(key); },
        },
        scopeId: 'profile-panel-test',
        status: () => 'connected',
        onStatus: () => () => undefined,
        now: () => FIXED_NOW,
      });
    serverUpdateContinuity.begin(target);
    expect(serverUpdateContinuity.beginExactReturn(target)).toBe(true);
    const callbacks = {
      onCredentialRotationCleanEditorReady: (
        ready: CredentialRotationServerUpdateTarget,
      ) => {
        expect(serverUpdateContinuity.markExactEditorReady(ready)).toBe(true);
      },
      onCredentialRotationCleanEditorChanged: (
        changed: CredentialRotationServerUpdateTarget,
      ) => {
        serverUpdateContinuity.retire(changed);
      },
    };
    const connections = [
      connection(target.name, { auth_type: 'bearer', updated_at: 81 }),
    ];
    const first = mountPanel({
      connections,
      credentialRotationContinuity: null,
      credentialRotationServerUpdateContinuity: serverUpdateContinuity,
      runCredentialRotationActivity: async () => ({
        activity: { status: 'idle' },
      }),
      initialCredentialRotationServerUpdateRetry: target,
      ...callbacks,
    });

    await first.mount.whenLoaded();
    await tick(30);

    expect(first.mount.getState().dialog.editingId).toBe('api/guided-api');
    expect(first.mount.getState().dialog.values['auth.token']).toBeUndefined();
    expect(first.mount.getState().credentialRotationRecovery).toMatchObject({
      ...target,
      phase: 'editor_ready',
      returnedFromServerUpdate: true,
    });
    expect(serverUpdateContinuity.read()).toMatchObject({
      ...target,
      phase: 'editor_ready',
    });
    const raw = stored.get(
      CREDENTIAL_ROTATION_SERVER_UPDATE_CONTINUITY_SESSION_KEY,
    )!;
    expect(raw).not.toMatch(/token|credential|field|form|receipt|26\./i);
    first.mount.dispose();

    const restored = mountPanel({
      connections,
      credentialRotationContinuity: null,
      credentialRotationServerUpdateContinuity: serverUpdateContinuity,
      runCredentialRotationActivity: async () => ({
        activity: { status: 'idle' },
      }),
      ...callbacks,
    });
    await restored.mount.whenLoaded();
    await tick();

    expect(restored.mount.getState().dialog.stage).toBe('closed');
    expect(restored.mount.getState().credentialRotationRecovery).toMatchObject({
      ...target,
      phase: 'editor_ready',
      returnedFromServerUpdate: true,
    });
    expect(restored.getHtml()).toMatch(
      /fresh key editor.*closed before any field changed.*reopen the fresh editor/is,
    );
    expect(restored.getHtml()).not.toMatch(
      /server recovery is finished|running 26\./i,
    );
    expect(restored.calls.runCredentialRotationActivity).not.toHaveBeenCalled();

    restored.click({
      action: 'connections-start-fresh-credential-rotation',
      ...target,
    });
    await tick(40);

    expect(restored.calls.runCredentialRotationActivity).toHaveBeenCalledOnce();
    expect(restored.mount.getState().dialog.editingId).toBe('api/guided-api');
    expect(restored.mount.getState().dialog.values['auth.token']).toBeUndefined();
    expect(serverUpdateContinuity.read()?.phase).toBe('editor_ready');
    restored.field('display_name', 'Guided API replacement');
    expect(restored.mount.getState().dialog.values.display_name)
      .toBe('Guided API replacement');
    expect(restored.mount.getState().credentialRotationRecovery).toBeNull();
    expect(serverUpdateContinuity.read()).toBeNull();
    expect(stored.has(
      CREDENTIAL_ROTATION_SERVER_UPDATE_CONTINUITY_SESSION_KEY,
    )).toBe(false);

    restored.mount.dispose();
    serverUpdateContinuity.dispose();
  });

  it('drops clean-editor orientation when another surface dismisses its handoff', async () => {
    const target = { kind: 'api' as const, name: 'guided-api' };
    const serverUpdateContinuity =
      createCredentialRotationServerUpdateContinuity({
        storage: null,
        scopeId: 'profile-panel-test',
        status: () => 'connected',
        onStatus: () => () => undefined,
        now: () => FIXED_NOW,
      });
    serverUpdateContinuity.begin(target);
    expect(serverUpdateContinuity.beginExactReturn(target)).toBe(true);
    expect(serverUpdateContinuity.markExactEditorReady(target)).toBe(true);
    const panel = mountPanel({
      connections: [
        connection(target.name, { auth_type: 'bearer', updated_at: 81 }),
      ],
      credentialRotationContinuity: null,
      credentialRotationServerUpdateContinuity: serverUpdateContinuity,
    });

    await panel.mount.whenLoaded();
    await tick();

    expect(panel.mount.getState().credentialRotationRecovery).toMatchObject({
      ...target,
      phase: 'editor_ready',
    });
    panel.click({
      action: 'connections-edit',
      ...target,
    });
    expect(panel.mount.getState().dialog.editingId).toBe('api/guided-api');
    expect(panel.mount.getState().dialog.values['auth.token']).toBeUndefined();

    serverUpdateContinuity.retire(target);

    expect(panel.mount.getState().credentialRotationRecovery).toBeNull();
    expect(panel.mount.getState().dialog.editingId).toBe('api/guided-api');
    expect(panel.mount.getState().dialog.values['auth.token']).toBeUndefined();
    expect(panel.getHtml()).not.toMatch(
      /fresh key editor|server recovery is finished/i,
    );

    panel.mount.dispose();
    serverUpdateContinuity.dispose();
  });

  it('keeps the exact guide return retryable when its first post-update list is still offline', async () => {
    const guided = connection('guided-offline-api', {
      auth_type: 'bearer',
      updated_at: 83,
    });
    let listRead = 0;
    const panel = mountPanel({
      credentialRotationContinuity: null,
      runList: async () => {
        listRead += 1;
        if (listRead === 1) throw new Error('server is restarting');
        return { connections: [guided] };
      },
      runCredentialRotationActivity: async () => ({
        activity: { status: 'idle' },
      }),
      initialCredentialRotationServerUpdateRetry: {
        kind: 'api',
        name: 'guided-offline-api',
      },
    });

    await panel.mount.whenLoaded();
    await tick();

    expect(panel.mount.getState().error).toBeNull();
    expect(panel.mount.getState().credentialRotationRecovery).toMatchObject({
      kind: 'api',
      name: 'guided-offline-api',
      phase: 'restart_waiting',
      returnedFromServerUpdate: true,
    });
    expect(panel.getHtml()).toContain('could not yet confirm the updated server');
    expect(panel.getHtml()).toContain('Try again');
    expect(panel.calls.runCredentialRotationActivity).not.toHaveBeenCalled();

    panel.click({
      action: 'connections-start-fresh-credential-rotation',
      kind: 'api',
      name: 'guided-offline-api',
    });
    await tick(30);

    expect(panel.mount.getState().credentialRotationRecovery).toMatchObject({
      kind: 'api',
      name: 'guided-offline-api',
      phase: 'editor_ready',
      returnedFromServerUpdate: true,
    });
    expect(panel.mount.getState().dialog.editingId)
      .toBe('api/guided-offline-api');
    expect(panel.mount.getState().dialog.values['auth.token']).toBeUndefined();
    expect(panel.calls.runCredentialRotationActivity).toHaveBeenCalledOnce();
    expect(panel.calls.runList).toHaveBeenCalledTimes(3);
    expect(panel.calls.runRotateCredentials).not.toHaveBeenCalled();
    panel.mount.dispose();
  });

  it('resumes an offline server-guide return after reconnect without falsely superseding it', async () => {
    const guided = connection('guided-reconnect-api', {
      auth_type: 'bearer',
      updated_at: 84,
    });
    let listRead = 0;
    let reconnect: (() => void) | null = null;
    const panel = mountPanel({
      credentialRotationContinuity: null,
      runList: async () => {
        listRead += 1;
        if (listRead === 1) throw new Error('server is restarting');
        return { connections: [guided] };
      },
      runCredentialRotationActivity: async () => ({
        activity: { status: 'idle' },
      }),
      onReconnect: (listener) => {
        reconnect = listener;
        return () => undefined;
      },
      initialCredentialRotationServerUpdateRetry: {
        kind: 'api',
        name: 'guided-reconnect-api',
      },
    });

    await panel.mount.whenLoaded();
    await tick();
    expect(panel.mount.getState().credentialRotationRecovery).toMatchObject({
      phase: 'restart_waiting',
      returnedFromServerUpdate: true,
    });

    reconnect!();
    await tick(40);

    expect(panel.mount.getState().credentialRotationRecovery).toMatchObject({
      kind: 'api',
      name: 'guided-reconnect-api',
      phase: 'editor_ready',
      returnedFromServerUpdate: true,
    });
    expect(panel.mount.getState().dialog.editingId)
      .toBe('api/guided-reconnect-api');
    expect(panel.mount.getState().dialog.values['auth.token']).toBeUndefined();
    expect(panel.calls.runCredentialRotationActivity).toHaveBeenCalledOnce();
    expect(panel.calls.runList).toHaveBeenCalledTimes(3);
    expect(panel.calls.runRotateCredentials).not.toHaveBeenCalled();
    panel.mount.dispose();
  });

  it('keeps the exact return when reconnect supersedes its first list read', async () => {
    const guided = connection('guided-overlap-api', {
      auth_type: 'bearer',
      updated_at: 85,
    });
    const initialList = deferred<{ connections: ReadonlyArray<ConnectionView> }>();
    const reconnectList = deferred<{ connections: ReadonlyArray<ConnectionView> }>();
    let listRead = 0;
    let reconnect: (() => void) | null = null;
    const panel = mountPanel({
      credentialRotationContinuity: null,
      runList: async () => {
        listRead += 1;
        if (listRead === 1) return initialList.promise;
        if (listRead === 2) return reconnectList.promise;
        return { connections: [guided] };
      },
      runCredentialRotationActivity: async () => ({
        activity: { status: 'idle' },
      }),
      onReconnect: (listener) => {
        reconnect = listener;
        return () => undefined;
      },
      initialCredentialRotationServerUpdateRetry: {
        kind: 'api',
        name: 'guided-overlap-api',
      },
    });

    reconnect!();
    await tick();
    expect(panel.calls.runList).toHaveBeenCalledTimes(2);

    initialList.resolve({ connections: [guided] });
    await panel.mount.whenLoaded();
    await tick(30);
    reconnectList.resolve({ connections: [guided] });
    await tick(40);

    expect(panel.mount.getState().credentialRotationRecovery).toMatchObject({
      kind: 'api',
      name: 'guided-overlap-api',
      phase: 'editor_ready',
      returnedFromServerUpdate: true,
    });
    expect(panel.mount.getState().dialog.editingId)
      .toBe('api/guided-overlap-api');
    expect(panel.mount.getState().dialog.values['auth.token']).toBeUndefined();
    expect(panel.calls.runCredentialRotationActivity).toHaveBeenCalledOnce();
    expect(panel.calls.runList).toHaveBeenCalledTimes(4);
    expect(panel.calls.runRotateCredentials).not.toHaveBeenCalled();
    panel.mount.dispose();
  });

  it('continues when reconnect supersedes an in-flight return baseline check', async () => {
    const guided = connection('guided-check-overlap-api', {
      auth_type: 'bearer',
      updated_at: 86,
    });
    const manualBaseline = deferred<{
      connections: ReadonlyArray<ConnectionView>;
    }>();
    let listRead = 0;
    let reconnect: (() => void) | null = null;
    const panel = mountPanel({
      credentialRotationContinuity: null,
      runList: async () => {
        listRead += 1;
        if (listRead === 1) throw new Error('server is restarting');
        if (listRead === 2) return manualBaseline.promise;
        return { connections: [guided] };
      },
      runCredentialRotationActivity: async () => ({
        activity: { status: 'idle' },
      }),
      onReconnect: (listener) => {
        reconnect = listener;
        return () => undefined;
      },
      initialCredentialRotationServerUpdateRetry: {
        kind: 'api',
        name: 'guided-check-overlap-api',
      },
    });

    await panel.mount.whenLoaded();
    await tick();
    panel.click({
      action: 'connections-start-fresh-credential-rotation',
      kind: 'api',
      name: 'guided-check-overlap-api',
    });
    await tick();
    expect(panel.calls.runList).toHaveBeenCalledTimes(2);
    expect(panel.mount.getState().credentialRotationRecovery?.phase)
      .toBe('restart_checking');

    reconnect!();
    await tick(40);

    expect(panel.mount.getState().credentialRotationRecovery).toMatchObject({
      kind: 'api',
      name: 'guided-check-overlap-api',
      phase: 'editor_ready',
      returnedFromServerUpdate: true,
    });
    expect(panel.mount.getState().dialog.editingId)
      .toBe('api/guided-check-overlap-api');
    expect(panel.mount.getState().dialog.values['auth.token']).toBeUndefined();
    expect(panel.calls.runCredentialRotationActivity).toHaveBeenCalledOnce();
    expect(panel.calls.runList).toHaveBeenCalledTimes(4);
    expect(panel.calls.runRotateCredentials).not.toHaveBeenCalled();

    manualBaseline.resolve({ connections: [guided] });
    await tick();
    expect(panel.mount.getState().dialog.editingId)
      .toBe('api/guided-check-overlap-api');
    panel.mount.dispose();
  });

  it('does not redirect a server-guide return when the exact connection was removed', async () => {
    const panel = mountPanel({
      connections: [connection('different-api', { updated_at: 82 })],
      credentialRotationContinuity: null,
      runCredentialRotationActivity: async () => ({
        activity: { status: 'idle' },
      }),
      initialCredentialRotationServerUpdateRetry: {
        kind: 'api',
        name: 'removed-api',
      },
    });

    await panel.mount.whenLoaded();
    await tick();

    expect(panel.mount.getState().credentialRotationRecovery).toMatchObject({
      kind: 'api',
      name: 'removed-api',
      phase: 'superseded',
      returnedFromServerUpdate: true,
    });
    expect(panel.mount.getState().dialog.stage).toBe('closed');
    expect(panel.getHtml()).toContain('api/removed-api was removed');
    expect(panel.calls.runCredentialRotationActivity).not.toHaveBeenCalled();
    expect(panel.calls.runRotateCredentials).not.toHaveBeenCalled();
    panel.mount.dispose();
  });

  it('does not open after a sibling starts during the fresh-start activity read', async () => {
    const continuity = rotationContinuity();
    expect(continuity.store.write({
      attemptId: 'rotation-fresh-start-inflight-sibling-0001',
      kind: 'api',
      name: 'fresh-start-inflight-sibling-api',
      baselineUpdatedAt: 78,
    })).toBe('stored');
    expect(continuity.store.markSuccessorObserved(
      'rotation-fresh-start-inflight-sibling-0001',
    )).toBe('stored');
    const probeLease = rotationOwnershipLease();
    const tabs = rotationTabs({
      supportsOwnershipLeases: true,
      claim: async () => probeLease,
    });
    const delayedActivity = deferred<{
      activity: ConnectionCredentialRotationActivity;
    }>();
    let activityRead = 0;
    const panel = mountPanel({
      connections: [connection('fresh-start-inflight-sibling-api', {
        auth_type: 'bearer',
        updated_at: 78,
      })],
      credentialRotationContinuity: continuity.store,
      credentialRotationTabConvergence: tabs.convergence,
      runCredentialRotationStatus: async () => ({
        outcome: {
          status: 'failed',
          started_at: FIXED_NOW,
          finished_at: FIXED_NOW + 1_000,
          reason: 'server_error',
        },
      }),
      runCredentialRotationActivity: async () => {
        activityRead += 1;
        return activityRead === 1
          ? { activity: { status: 'idle' } }
          : delayedActivity.promise;
      },
    });

    await panel.mount.whenLoaded();
    panel.click({
      action: 'connections-start-fresh-credential-rotation',
      kind: 'api',
      name: 'fresh-start-inflight-sibling-api',
    });
    expect(panel.mount.getState().credentialRotationRecovery?.phase)
      .toBe('restart_checking');

    tabs.emit({
      type: 'credential_rotation_started',
      kind: 'api',
      name: 'fresh-start-inflight-sibling-api',
    });
    expect(panel.mount.getState().credentialRotationRecovery?.phase)
      .toBe('restart_handoff');
    delayedActivity.resolve({ activity: { status: 'idle' } });
    await tick();

    expect(panel.mount.getState().credentialRotationRecovery?.phase)
      .toBe('restart_handoff');
    expect(panel.mount.getState().dialog.stage).toBe('closed');
    expect(panel.getHtml()).toContain('Another tab or paired client is checking');
    expect(panel.calls.runRotateCredentials).not.toHaveBeenCalled();
    panel.mount.dispose();
  });

  it('keeps the handoff closed while a sibling owns the browser lease before its server claim', async () => {
    const continuity = rotationContinuity();
    expect(continuity.store.write({
      attemptId: 'rotation-fresh-start-lease-gap-0001',
      kind: 'api',
      name: 'fresh-start-lease-gap-api',
      baselineUpdatedAt: 79,
    })).toBe('stored');
    expect(continuity.store.markSuccessorObserved(
      'rotation-fresh-start-lease-gap-0001',
    )).toBe('stored');
    const recoveryProbeLease = rotationOwnershipLease();
    const retryProbeLease = rotationOwnershipLease();
    let claimRead = 0;
    let siblingLeaseReleased = false;
    const tabs = rotationTabs({
      supportsOwnershipLeases: true,
      claim: async () => {
        claimRead += 1;
        if (claimRead === 1) return recoveryProbeLease;
        return siblingLeaseReleased ? retryProbeLease : null;
      },
    });
    const panel = mountPanel({
      connections: [connection('fresh-start-lease-gap-api', {
        auth_type: 'bearer',
        updated_at: 79,
      })],
      credentialRotationContinuity: continuity.store,
      credentialRotationTabConvergence: tabs.convergence,
      runCredentialRotationStatus: async () => ({
        outcome: {
          status: 'failed',
          started_at: FIXED_NOW,
          finished_at: FIXED_NOW + 1_000,
          reason: 'server_error',
        },
      }),
      runCredentialRotationActivity: async () => ({
        activity: { status: 'idle' },
      }),
    });

    await panel.mount.whenLoaded();
    const listReadsBeforeStart = panel.calls.runList.mock.calls.length;
    expect(panel.mount.getState().credentialRotationRecovery?.phase)
      .toBe('restart_ready');
    expect(recoveryProbeLease.release).toHaveBeenCalledOnce();

    panel.click({
      action: 'connections-start-fresh-credential-rotation',
      kind: 'api',
      name: 'fresh-start-lease-gap-api',
    });
    await tick();

    expect(panel.mount.getState().credentialRotationRecovery?.phase)
      .toBe('restart_handoff');
    expect(panel.mount.getState().dialog.stage).toBe('closed');
    expect(panel.calls.runList).toHaveBeenCalledTimes(listReadsBeforeStart);
    expect(panel.getHtml()).toContain('Check handoff');

    siblingLeaseReleased = true;
    panel.click({
      action: 'connections-start-fresh-credential-rotation',
      kind: 'api',
      name: 'fresh-start-lease-gap-api',
    });
    await tick();

    expect(retryProbeLease.release).toHaveBeenCalledOnce();
    expect(panel.mount.getState().credentialRotationRecovery).toBeNull();
    expect(panel.mount.getState().dialog.editingId)
      .toBe('api/fresh-start-lease-gap-api');
    expect(panel.mount.getState().dialog.values['auth.token']).toBeUndefined();
    expect(panel.calls.runRotateCredentials).not.toHaveBeenCalled();
    panel.mount.dispose();
  });

  it('preserves newer dialog navigation when a safe fresh-start read lands late', async () => {
    const continuity = rotationContinuity();
    expect(continuity.store.write({
      attemptId: 'rotation-fresh-start-navigation-0001',
      kind: 'api',
      name: 'fresh-start-navigation-api',
      baselineUpdatedAt: 79,
    })).toBe('stored');
    expect(continuity.store.markSuccessorObserved(
      'rotation-fresh-start-navigation-0001',
    )).toBe('stored');
    const probeLease = rotationOwnershipLease();
    const tabs = rotationTabs({
      supportsOwnershipLeases: true,
      claim: async () => probeLease,
    });
    const unchanged = connection('fresh-start-navigation-api', {
      auth_type: 'bearer',
      updated_at: 79,
    });
    const delayedList = deferred<{
      connections: ReadonlyArray<ConnectionView>;
    }>();
    let listRead = 0;
    const panel = mountPanel({
      runList: async () => {
        listRead += 1;
        return listRead <= 2
          ? { connections: [unchanged] }
          : delayedList.promise;
      },
      credentialRotationContinuity: continuity.store,
      credentialRotationTabConvergence: tabs.convergence,
      runCredentialRotationStatus: async () => ({
        outcome: {
          status: 'failed',
          started_at: FIXED_NOW,
          finished_at: FIXED_NOW + 1_000,
          reason: 'server_error',
        },
      }),
      runCredentialRotationActivity: async () => ({
        activity: { status: 'idle' },
      }),
    });

    await panel.mount.whenLoaded();
    panel.click({
      action: 'connections-start-fresh-credential-rotation',
      kind: 'api',
      name: 'fresh-start-navigation-api',
    });
    await tick();
    expect(listRead).toBe(3);

    panel.click({ action: 'connections-open-add' });
    expect(panel.mount.getState().dialog.stage).toBe('kind-picker');
    delayedList.resolve({ connections: [unchanged] });
    await tick();

    expect(panel.mount.getState().dialog.stage).toBe('kind-picker');
    expect(panel.mount.getState().credentialRotationRecovery?.phase)
      .toBe('restart_ready');
    expect(panel.mount.getState().dialog.editingId).toBeNull();
    expect(panel.calls.runRotateCredentials).not.toHaveBeenCalled();
    panel.mount.dispose();
  });

  it('revokes a cleared-handoff fresh start as soon as a sibling takes over', async () => {
    const continuity = rotationContinuity();
    expect(continuity.store.write({
      attemptId: 'rotation-fresh-start-revoked-0001',
      kind: 'api',
      name: 'fresh-start-revoked-api',
      baselineUpdatedAt: 76,
    })).toBe('stored');
    expect(continuity.store.markSuccessorObserved(
      'rotation-fresh-start-revoked-0001',
    )).toBe('stored');
    const probeLease = rotationOwnershipLease();
    const tabs = rotationTabs({
      supportsOwnershipLeases: true,
      claim: async () => probeLease,
    });
    const unchanged = connection('fresh-start-revoked-api', {
      auth_type: 'bearer',
      updated_at: 76,
    });
    const reconnect: { current?: () => void } = {};
    const { mount, calls, getHtml } = mountPanel({
      connections: [unchanged],
      credentialRotationContinuity: continuity.store,
      credentialRotationTabConvergence: tabs.convergence,
      runCredentialRotationStatus: async () => ({
        outcome: {
          status: 'failed',
          started_at: FIXED_NOW,
          finished_at: FIXED_NOW + 1_000,
          reason: 'server_error',
        },
      }),
      runCredentialRotationActivity: async () => ({
        activity: { status: 'idle' },
      }),
      onReconnect: (listener) => {
        reconnect.current = listener;
        return () => { delete reconnect.current; };
      },
    });

    await mount.whenLoaded();
    expect(mount.getState().credentialRotationRecovery?.phase)
      .toBe('restart_ready');
    expect(getHtml()).toContain('Start fresh');

    tabs.emit({
      type: 'credential_rotation_started',
      kind: 'api',
      name: 'fresh-start-revoked-api',
    });

    expect(mount.getState().credentialRotationRecovery?.phase)
      .toBe('restart_handoff');
    expect(mount.getState().dialog.stage).toBe('closed');
    expect(getHtml()).toContain('Another tab or paired client is checking');
    expect(getHtml()).toContain('Check handoff');
    expect(getHtml()).not.toContain('Start fresh to open');
    expect(calls.runRotateCredentials).not.toHaveBeenCalled();
    await tick();
    expect(mount.getState().credentialRotationRecovery?.phase)
      .toBe('restart_handoff');

    const activityReadsBeforeReconnect =
      calls.runCredentialRotationActivity.mock.calls.length;
    reconnect.current?.();
    await tick(20);

    expect(mount.getState().credentialRotationRecovery?.phase)
      .toBe('restart_handoff');
    expect(mount.getState().dialog.stage).toBe('closed');
    expect(calls.runCredentialRotationActivity).toHaveBeenCalledTimes(
      activityReadsBeforeReconnect,
    );
    mount.dispose();
  });

  it('guides an already-open empty editor, then retires the receipt on input', async () => {
    const continuity = rotationContinuity();
    expect(continuity.store.write({
      attemptId: 'rotation-empty-editor-fresh-start-0001',
      kind: 'api',
      name: 'empty-editor-api',
      baselineUpdatedAt: 77,
    })).toBe('stored');
    const probeLease = rotationOwnershipLease();
    const tabs = rotationTabs({
      supportsOwnershipLeases: true,
      claim: async () => probeLease,
    });
    let successorPending = true;
    const unchanged = connection('empty-editor-api', {
      auth_type: 'bearer',
      updated_at: 77,
    });
    const { mount, click, field, calls, getHtml } = mountPanel({
      connections: [unchanged],
      credentialRotationContinuity: continuity.store,
      credentialRotationTabConvergence: tabs.convergence,
      runCredentialRotationStatus: async () => ({
        outcome: {
          status: 'failed',
          started_at: FIXED_NOW,
          finished_at: FIXED_NOW + 1_000,
          reason: 'auth_failed',
        },
      }),
      runCredentialRotationActivity: async () => ({
        activity: successorPending
          ? { status: 'pending', started_at: FIXED_NOW + 2_000 }
          : { status: 'idle' },
      }),
    });

    await mount.whenLoaded();
    click({
      action: 'connections-edit',
      kind: 'api',
      name: 'empty-editor-api',
    });
    expect(mount.getState().dialog.values['auth.token']).toBeUndefined();
    successorPending = false;
    click({ action: 'connections-check-credential-rotation' });
    await tick();

    expect(mount.getState().credentialRotationRecovery?.phase)
      .toBe('restart_ready');
    expect(getHtml()).toContain('Enter a new replacement below');
    expect(getHtml()).not.toContain('Start fresh to open');

    field('auth.token', 'new-memory-only-replacement');

    expect(mount.getState().credentialRotationRecovery).toBeNull();
    expect(mount.getState().dialog.values['auth.token'])
      .toBe('new-memory-only-replacement');
    expect(getHtml()).not.toContain('no replacement draft to recover');
    expect(calls.runRotateCredentials).not.toHaveBeenCalled();
    mount.dispose();
  });

  it('replaces a fresh-start receipt when a later list proves a newer row', async () => {
    const continuity = rotationContinuity();
    expect(continuity.store.write({
      attemptId: 'rotation-fresh-start-changed-0001',
      kind: 'api',
      name: 'fresh-start-changed-api',
      baselineUpdatedAt: 77,
    })).toBe('stored');
    expect(continuity.store.markSuccessorObserved(
      'rotation-fresh-start-changed-0001',
    )).toBe('stored');
    const probeLease = rotationOwnershipLease();
    const tabs = rotationTabs({
      supportsOwnershipLeases: true,
      claim: async () => probeLease,
    });
    let listed = connection('fresh-start-changed-api', {
      display_name: 'Before newer save',
      auth_type: 'bearer',
      updated_at: 77,
    });
    const { mount, getHtml } = mountPanel({
      runList: async () => ({ connections: [listed] }),
      credentialRotationContinuity: continuity.store,
      credentialRotationTabConvergence: tabs.convergence,
      runCredentialRotationStatus: async () => ({
        outcome: {
          status: 'failed',
          started_at: FIXED_NOW,
          finished_at: FIXED_NOW + 1_000,
          reason: 'server_error',
        },
      }),
      runCredentialRotationActivity: async () => ({
        activity: { status: 'idle' },
      }),
    });

    await mount.whenLoaded();
    expect(mount.getState().credentialRotationRecovery?.phase)
      .toBe('restart_ready');
    listed = connection('fresh-start-changed-api', {
      display_name: 'Newer sibling save',
      auth_type: 'oauth2_refresh',
      updated_at: 78,
    });

    tabs.emit({ type: 'reconcile' });
    await tick();

    expect(mount.getState().credentialRotationRecovery?.phase)
      .toBe('superseded');
    expect(mount.getState().connections[0]?.display_name)
      .toBe('Newer sibling save');
    expect(getHtml()).toContain('Recued kept the newer server version');
    expect(getHtml()).not.toContain('Start fresh');
    mount.dispose();
  });

  it('keeps the editor closed when the fresh-start preflight finds a newer row', async () => {
    const continuity = rotationContinuity();
    expect(continuity.store.write({
      attemptId: 'rotation-fresh-start-read-race-0001',
      kind: 'api',
      name: 'fresh-start-read-race-api',
      baselineUpdatedAt: 79,
    })).toBe('stored');
    expect(continuity.store.markSuccessorObserved(
      'rotation-fresh-start-read-race-0001',
    )).toBe('stored');
    const probeLease = rotationOwnershipLease();
    const tabs = rotationTabs({
      supportsOwnershipLeases: true,
      claim: async () => probeLease,
    });
    const before = connection('fresh-start-read-race-api', {
      display_name: 'Before late read',
      auth_type: 'bearer',
      updated_at: 79,
    });
    const after = connection('fresh-start-read-race-api', {
      display_name: 'Newer late read',
      auth_type: 'oauth2_refresh',
      updated_at: 80,
    });
    const laterList = deferred<{
      connections: ReadonlyArray<ConnectionView>;
    }>();
    let listReads = 0;
    const { mount, click, calls, getHtml } = mountPanel({
      runList: async () => {
        listReads += 1;
        return listReads <= 2
          ? { connections: [before] }
          : laterList.promise;
      },
      credentialRotationContinuity: continuity.store,
      credentialRotationTabConvergence: tabs.convergence,
      runCredentialRotationStatus: async () => ({
        outcome: {
          status: 'failed',
          started_at: FIXED_NOW,
          finished_at: FIXED_NOW + 1_000,
          reason: 'server_error',
        },
      }),
      runCredentialRotationActivity: async () => ({
        activity: { status: 'idle' },
      }),
    });

    await mount.whenLoaded();
    expect(mount.getState().credentialRotationRecovery?.phase)
      .toBe('restart_ready');
    expect(listReads).toBe(2);

    click({
      action: 'connections-start-fresh-credential-rotation',
      kind: 'api',
      name: 'fresh-start-read-race-api',
    });
    expect(mount.getState().credentialRotationRecovery?.phase)
      .toBe('restart_checking');
    expect(mount.getState().dialog.stage).toBe('closed');
    await tick();
    expect(listReads).toBe(3);
    laterList.resolve({ connections: [after] });
    await tick();

    expect(mount.getState().credentialRotationRecovery?.phase)
      .toBe('superseded');
    expect(mount.getState().dialog.stage).toBe('closed');
    expect(mount.getState().connections[0]?.display_name)
      .toBe('Newer late read');
    expect(getHtml()).toContain('Recued kept the newer server version');
    expect(getHtml()).not.toContain('data-conn-field="auth.token"');
    expect(calls.runRotateCredentials).not.toHaveBeenCalled();
    mount.dispose();
  });

  it('revokes a resumable former-owner draft when a sibling starts first', async () => {
    const continuity = rotationContinuity();
    const probeLease = rotationOwnershipLease();
    const tabs = rotationTabs({
      supportsOwnershipLeases: true,
      claim: async () => probeLease,
    });
    expect(continuity.store.write({
      attemptId: 'rotation-resume-revoked-0001',
      kind: 'api',
      name: 'resume-revoked-api',
      baselineUpdatedAt: 73,
    })).toBe('stored');
    let successorPending = true;
    const unchanged = connection('resume-revoked-api', {
      base_url: 'https://unchanged.example.com',
      auth_type: 'bearer',
      updated_at: 73,
    });
    const { mount, click, field, calls, getHtml, submitBtn } = mountPanel({
      runList: async () => ({ connections: [unchanged] }),
      credentialRotationContinuity: continuity.store,
      credentialRotationTabConvergence: tabs.convergence,
      runCredentialRotationStatus: async () => ({
        outcome: {
          status: 'failed',
          started_at: FIXED_NOW,
          finished_at: FIXED_NOW + 1_000,
          reason: 'server_error',
        },
      }),
      runCredentialRotationActivity: async () => ({
        activity: successorPending
          ? { status: 'pending', started_at: FIXED_NOW + 2_000 }
          : { status: 'idle' },
      }),
    });

    await mount.whenLoaded();
    click({
      action: 'connections-edit',
      kind: 'api',
      name: 'resume-revoked-api',
    });
    field('auth.token', 'preserve-but-do-not-send');
    successorPending = false;
    click({ action: 'connections-check-credential-rotation' });
    await tick();
    expect(mount.getState().credentialRotationRecovery?.phase)
      .toBe('resumable');

    tabs.emit({
      type: 'credential_rotation_started',
      kind: 'api',
      name: 'resume-revoked-api',
    });

    expect(mount.getState().credentialRotationRecovery).toBeNull();
    expect(mount.getState().dialog.credentialRotationOwnership?.phase)
      .toBe('active');
    expect(mount.getState().dialog.values['auth.token']).toBe(
      'preserve-but-do-not-send',
    );
    expect(submitBtn.hasAttribute('disabled')).toBe(true);
    expect(getHtml()).not.toContain('you can continue in this tab');
    expect(getHtml()).toContain('Credential check active elsewhere');
    expect(calls.runRotateCredentials).not.toHaveBeenCalled();
    mount.dispose();
  });

  it('keeps handoff when a sibling starts during the final unchanged-row read', async () => {
    vi.useFakeTimers();
    const continuity = rotationContinuity();
    const probeLease = rotationOwnershipLease();
    const tabs = rotationTabs({
      supportsOwnershipLeases: true,
      claim: async () => probeLease,
    });
    expect(continuity.store.write({
      attemptId: 'rotation-resume-read-race-0001',
      kind: 'api',
      name: 'resume-read-race-api',
      baselineUpdatedAt: 74,
    })).toBe('stored');
    const unchanged = connection('resume-read-race-api', {
      base_url: 'https://unchanged.example.com',
      auth_type: 'bearer',
      updated_at: 74,
    });
    const finalList = deferred<{ connections: ReadonlyArray<ConnectionView> }>();
    let listReads = 0;
    let successorPending = true;
    const { mount, click, field, calls, getHtml, submitBtn } = mountPanel({
      runList: async () => {
        listReads += 1;
        return listReads === 2
          ? finalList.promise
          : { connections: [unchanged] };
      },
      credentialRotationContinuity: continuity.store,
      credentialRotationTabConvergence: tabs.convergence,
      runCredentialRotationStatus: async () => ({
        outcome: {
          status: 'failed',
          started_at: FIXED_NOW,
          finished_at: FIXED_NOW + 1_000,
          reason: 'server_error',
        },
      }),
      runCredentialRotationActivity: async () => ({
        activity: successorPending
          ? { status: 'pending', started_at: FIXED_NOW + 2_000 }
          : { status: 'idle' },
      }),
    });

    try {
      await mount.whenLoaded();
      click({
        action: 'connections-edit',
        kind: 'api',
        name: 'resume-read-race-api',
      });
      field('auth.token', 'keep-waiting-secret');
      successorPending = false;
      await vi.advanceTimersByTimeAsync(2_000);
      await tick();
      expect(tabs.claimCredentialRotationOwnership).toHaveBeenCalledOnce();

      tabs.emit({
        type: 'credential_rotation_started',
        kind: 'api',
        name: 'resume-read-race-api',
      });
      finalList.resolve({ connections: [unchanged] });
      await tick();

      expect(continuity.store.read()?.attemptId).toBe(
        'rotation-resume-read-race-0001',
      );
      expect(mount.getState().credentialRotationRecovery?.phase).toBe('handoff');
      expect(mount.getState().dialog.credentialRotationOwnership?.phase)
        .toBe('handoff');
      expect(mount.getState().dialog.values['auth.token']).toBe(
        'keep-waiting-secret',
      );
      expect(submitBtn.hasAttribute('disabled')).toBe(true);
      expect(getHtml()).toContain(
        'data-connection-rotation-owner="handoff"',
      );
      expect(getHtml()).not.toContain('you can continue in this tab');
      expect(calls.runRotateCredentials).not.toHaveBeenCalled();
      expect(tabs.notifyCredentialRotationStarted).not.toHaveBeenCalled();
    } finally {
      mount.dispose();
      vi.useRealTimers();
    }
  });

  it('recognizes a newer successor row from a legacy continuity marker', async () => {
    const continuity = rotationContinuity();
    continuity.values.set(
      CREDENTIAL_ROTATION_CONTINUITY_SESSION_KEY,
      JSON.stringify({
        version: 1,
        scope_id: 'profile-panel-test',
        attempt_id: 'rotation-legacy-former-owner-0001',
        kind: 'api',
        name: 'legacy-handoff-api',
        started_at: FIXED_NOW,
      }),
    );
    const { mount, getHtml } = mountPanel({
      connections: [connection('legacy-handoff-api', {
        base_url: 'https://successor.example.com',
        updated_at: FIXED_NOW + 500,
      })],
      credentialRotationContinuity: continuity.store,
      runCredentialRotationStatus: async () => ({
        outcome: {
          status: 'failed',
          started_at: FIXED_NOW,
          finished_at: FIXED_NOW + 1_000,
          reason: 'server_error',
        },
      }),
    });

    await mount.whenLoaded();
    expect(mount.getState().credentialRotationRecovery?.phase)
      .toBe('superseded');
    expect(continuity.store.read()).toBeNull();
    expect(getHtml()).toContain('Recued kept the newer server version');
    mount.dispose();
  });

  it('never resumes a changed editor from a legacy marker with no receipt baseline', async () => {
    const continuity = rotationContinuity();
    continuity.values.set(
      CREDENTIAL_ROTATION_CONTINUITY_SESSION_KEY,
      JSON.stringify({
        version: 1,
        scope_id: 'profile-panel-test',
        attempt_id: 'rotation-legacy-no-receipt-0001',
        kind: 'api',
        name: 'legacy-no-receipt-api',
        started_at: FIXED_NOW,
      }),
    );
    const probeLease = rotationOwnershipLease();
    const tabs = rotationTabs({
      supportsOwnershipLeases: true,
      claim: async () => probeLease,
    });
    const before = connection('legacy-no-receipt-api', {
      base_url: 'https://before.example.com',
      auth_type: 'bearer',
      updated_at: FIXED_NOW - 100,
    });
    const after = connection('legacy-no-receipt-api', {
      base_url: 'https://after.example.com',
      auth_type: 'bearer',
      updated_at: FIXED_NOW + 100,
    });
    let listReads = 0;
    let successorPending = true;
    const { mount, click, field, calls, getHtml, submitBtn } = mountPanel({
      runList: async () => {
        listReads += 1;
        return { connections: [listReads === 1 ? before : after] };
      },
      credentialRotationContinuity: continuity.store,
      credentialRotationTabConvergence: tabs.convergence,
      runCredentialRotationStatus: async () => ({
        outcome: { status: 'not_found' },
      }),
      runCredentialRotationActivity: async () => ({
        activity: successorPending
          ? { status: 'pending', started_at: FIXED_NOW + 1 }
          : { status: 'idle' },
      }),
    });

    await mount.whenLoaded();
    click({
      action: 'connections-edit',
      kind: 'api',
      name: 'legacy-no-receipt-api',
    });
    field('auth.token', 'do-not-resume-against-newer-row');
    successorPending = false;
    click({ action: 'connections-check-credential-rotation' });
    await tick();

    expect(continuity.store.read()).toBeNull();
    expect(mount.getState().credentialRotationRecovery?.phase)
      .toBe('superseded');
    expect(mount.getState().dialog.externalChange?.phase).toBe('changed');
    expect(mount.getState().dialog.values['auth.token']).toBe(
      'do-not-resume-against-newer-row',
    );
    expect(submitBtn.hasAttribute('disabled')).toBe(true);
    expect(getHtml()).toContain('Connection changed since you opened it');
    expect(getHtml()).not.toContain('you can continue in this tab');
    expect(calls.runRotateCredentials).not.toHaveBeenCalled();
    mount.dispose();
  });

  it('waits through the successor browser-lease window before server work starts', async () => {
    const continuity = rotationContinuity();
    const probeLease = rotationOwnershipLease();
    const claims: Array<CredentialRotationOwnershipLease | null> = [
      null,
      probeLease,
    ];
    const tabs = rotationTabs({
      supportsOwnershipLeases: true,
      claim: async () => claims.shift() ?? null,
    });
    expect(continuity.store.write({
      attemptId: 'rotation-late-browser-owner-0001',
      kind: 'api',
      name: 'lease-window-api',
      baselineUpdatedAt: 75,
    })).toBe('stored');
    let successorFinished = false;
    const before = connection('lease-window-api', {
      base_url: 'https://before.example.com',
      updated_at: 75,
    });
    const after = connection('lease-window-api', {
      base_url: 'https://after.example.com',
      updated_at: 76,
    });
    const { mount, click, calls, getHtml } = mountPanel({
      runList: async () => ({
        connections: [successorFinished ? after : before],
      }),
      credentialRotationContinuity: continuity.store,
      credentialRotationTabConvergence: tabs.convergence,
      runCredentialRotationStatus: async () => ({
        outcome: {
          status: 'failed',
          started_at: FIXED_NOW,
          finished_at: FIXED_NOW + 1_000,
          reason: 'server_error',
        },
      }),
      // The successor owns the browser lock but has not minted its server
      // attempt yet. Server activity is therefore still honestly idle.
      runCredentialRotationActivity: async () => ({
        activity: { status: 'idle' },
      }),
    });

    await mount.whenLoaded();
    expect(calls.runCredentialRotationActivity).toHaveBeenCalledOnce();
    expect(tabs.claimCredentialRotationOwnership).toHaveBeenCalledOnce();
    expect(mount.getState().credentialRotationRecovery?.phase).toBe('handoff');
    expect(continuity.store.read()).not.toBeNull();
    expect(getHtml()).toContain('Another tab has taken over');
    expect(tabs.notifyCredentialRotationStarted).not.toHaveBeenCalled();

    successorFinished = true;
    click({ action: 'connections-check-credential-rotation' });
    await tick();

    expect(tabs.claimCredentialRotationOwnership).toHaveBeenCalledTimes(2);
    expect(probeLease.release).toHaveBeenCalledOnce();
    expect(tabs.notifyCredentialRotationStarted).not.toHaveBeenCalled();
    expect(tabs.notifyCredentialRotationReleased).not.toHaveBeenCalled();
    expect(mount.getState().credentialRotationRecovery?.phase)
      .toBe('superseded');
    expect(mount.getState().connections[0]?.updated_at).toBe(76);
    expect(continuity.store.read()).toBeNull();
    mount.dispose();
  });

  it('replaces an old failure callout when the successor completion arrives just after retirement', async () => {
    const continuity = rotationContinuity();
    const probeLease = rotationOwnershipLease();
    const tabs = rotationTabs({
      supportsOwnershipLeases: true,
      claim: async () => probeLease,
    });
    expect(continuity.store.write({
      attemptId: 'rotation-after-retirement-0001',
      kind: 'api',
      name: 'retired-race-api',
      baselineUpdatedAt: 77,
    })).toBe('stored');
    let listed = connection('retired-race-api', {
      display_name: 'Former version',
      base_url: 'https://before.example.com',
      updated_at: 77,
    });
    const { mount, calls, getHtml } = mountPanel({
      runList: async () => ({ connections: [listed] }),
      credentialRotationContinuity: continuity.store,
      credentialRotationTabConvergence: tabs.convergence,
      runCredentialRotationStatus: async () => ({
        outcome: {
          status: 'failed',
          started_at: FIXED_NOW,
          finished_at: FIXED_NOW + 1_000,
          reason: 'server_error',
        },
      }),
      runCredentialRotationActivity: async () => ({
        activity: { status: 'idle' },
      }),
    });

    await mount.whenLoaded();
    expect(mount.getState().credentialRotationRecovery).toMatchObject({
      phase: 'failed',
      failureReason: 'server_error',
    });
    expect(continuity.store.read()).toBeNull();
    expect(probeLease.release).toHaveBeenCalledOnce();

    listed = connection('retired-race-api', {
      display_name: 'Successor version',
      base_url: 'https://after.example.com',
      updated_at: 78,
    });
    tabs.emit({
      type: 'credential_rotated',
      kind: 'api',
      name: 'retired-race-api',
    });
    await tick();

    expect(calls.runRotateCredentials).not.toHaveBeenCalled();
    expect(mount.getState().credentialRotationRecovery?.phase)
      .toBe('superseded');
    expect(mount.getState().connections[0]?.display_name)
      .toBe('Successor version');
    expect(getHtml()).toContain('Recued kept the newer server version');
    expect(getHtml()).not.toContain('Recued kept the old key');
    mount.dispose();
  });

  it('ignores a delayed completion broadcast when the settled connection did not change', async () => {
    const continuity = rotationContinuity();
    const probeLease = rotationOwnershipLease();
    const tabs = rotationTabs({
      supportsOwnershipLeases: true,
      claim: async () => probeLease,
    });
    expect(continuity.store.write({
      attemptId: 'rotation-stale-broadcast-0001',
      kind: 'api',
      name: 'stale-broadcast-api',
      baselineUpdatedAt: 79,
    })).toBe('stored');
    const unchanged = connection('stale-broadcast-api', {
      display_name: 'Unchanged version',
      base_url: 'https://unchanged.example.com',
      updated_at: 79,
    });
    const { mount, calls, getHtml } = mountPanel({
      runList: async () => ({ connections: [unchanged] }),
      credentialRotationContinuity: continuity.store,
      credentialRotationTabConvergence: tabs.convergence,
      runCredentialRotationStatus: async () => ({
        outcome: {
          status: 'failed',
          started_at: FIXED_NOW,
          finished_at: FIXED_NOW + 1_000,
          reason: 'server_error',
        },
      }),
      runCredentialRotationActivity: async () => ({
        activity: { status: 'idle' },
      }),
    });

    await mount.whenLoaded();
    expect(mount.getState().credentialRotationRecovery).toMatchObject({
      phase: 'failed',
      failureReason: 'server_error',
    });
    expect(continuity.store.read()).toBeNull();

    tabs.emit({
      type: 'credential_rotated',
      kind: 'api',
      name: 'stale-broadcast-api',
    });
    await tick();

    expect(calls.runList).toHaveBeenCalledTimes(3);
    expect(mount.getState().credentialRotationRecovery).toMatchObject({
      phase: 'failed',
      failureReason: 'server_error',
    });
    expect(mount.getState().connections[0]?.updated_at).toBe(79);
    expect(getHtml()).toContain('Recued kept the old key');
    expect(getHtml()).not.toContain('Recued kept the newer server version');
    mount.dispose();
  });

  it('preserves a newly opened editor when the former owner receipt lands late', async () => {
    const continuity = rotationContinuity();
    const unexpectedLease = rotationOwnershipLease();
    const tabs = rotationTabs({
      supportsOwnershipLeases: true,
      claim: async () => unexpectedLease,
    });
    expect(continuity.store.write({
      attemptId: 'rotation-late-editor-0001',
      kind: 'api',
      name: 'late-editor-api',
      baselineUpdatedAt: 80,
    })).toBe('stored');
    const status = deferred<Awaited<ReturnType<
      ConnectionsCredentialRotationStatusCaller
    >>>();
    let listRead = 0;
    const before = connection('late-editor-api', {
      base_url: 'https://before.example.com',
      auth_type: 'bearer',
      updated_at: 80,
    });
    const after = connection('late-editor-api', {
      base_url: 'https://after.example.com',
      auth_type: 'bearer',
      updated_at: 81,
    });
    const { mount, click, field, calls, getHtml } = mountPanel({
      runList: async () => {
        listRead += 1;
        return { connections: [listRead === 1 ? before : after] };
      },
      credentialRotationContinuity: continuity.store,
      credentialRotationTabConvergence: tabs.convergence,
      runCredentialRotationStatus: () => status.promise,
    });

    await tick();
    click({
      action: 'connections-edit',
      kind: 'api',
      name: 'late-editor-api',
    });
    expect(mount.getState().dialog.credentialRotationOwnership?.phase)
      .toBe('handoff');
    field('auth.token', 'new-memory-only-draft');

    status.resolve({
      outcome: {
        status: 'succeeded',
        started_at: FIXED_NOW,
        verification: {
          status: 'verified',
          verified_at: FIXED_NOW + 1_000,
          auth_type: 'bearer',
        },
      },
    });
    await mount.whenLoaded();
    await tick();

    expect(mount.getState().dialog.stage).toBe('form');
    expect(mount.getState().dialog.values['auth.token']).toBe(
      'new-memory-only-draft',
    );
    expect(mount.getState().dialog.externalChange?.phase).toBe('changed');
    expect(mount.getState().dialog.credentialRotationOwnership).toBeNull();
    expect(mount.getState().dialog.recentProbe).toMatchObject({
      purpose: 'credential_rotation',
      recovered: true,
      name: 'late-editor-api',
    });
    expect(getHtml()).toContain('Connection changed since you opened it');
    expect(getHtml()).toContain('was checked and is now in use');
    expect(calls.runRotateCredentials).not.toHaveBeenCalled();
    expect(tabs.claimCredentialRotationOwnership).not.toHaveBeenCalled();
    expect(tabs.notifyCredentialRotationStarted).not.toHaveBeenCalled();
    expect(unexpectedLease.release).not.toHaveBeenCalled();
    expect(continuity.store.read()).toBeNull();
    mount.dispose();
  });

  it('keeps a recovered receipt out of an unrelated editor until returning to the list', async () => {
    const continuity = rotationContinuity();
    expect(continuity.store.write({
      attemptId: 'rotation-unrelated-editor-0001',
      kind: 'api',
      name: 'receipt-api',
      baselineUpdatedAt: 82,
    })).toBe('stored');
    const status = deferred<Awaited<ReturnType<
      ConnectionsCredentialRotationStatusCaller
    >>>();
    const rows = [
      connection('receipt-api', {
        base_url: 'https://receipt.example.com',
        updated_at: 82,
      }),
      connection('other-api', {
        base_url: 'https://other.example.com',
        updated_at: 83,
      }),
    ];
    const { mount, click, field, getHtml, getRenderCount } = mountPanel({
      connections: rows,
      credentialRotationContinuity: continuity.store,
      runCredentialRotationStatus: () => status.promise,
    });

    await tick();
    click({ action: 'connections-edit', kind: 'api', name: 'other-api' });
    field('display_name', 'Other draft');
    const editorRenderCount = getRenderCount();
    status.resolve({
      outcome: {
        status: 'succeeded',
        started_at: FIXED_NOW,
        verification: {
          status: 'verified',
          verified_at: FIXED_NOW + 1_000,
          auth_type: 'bearer',
        },
      },
    });
    await mount.whenLoaded();
    await tick();

    expect(mount.getState().dialog.editingId).toBe('api/other-api');
    expect(mount.getState().dialog.values.display_name).toBe('Other draft');
    expect(getRenderCount()).toBe(editorRenderCount);
    expect(mount.getState().dialog.recentProbe).toMatchObject({
      recovered: true,
      name: 'receipt-api',
    });
    expect(getHtml()).not.toContain('data-connection-credential-receipt');

    click({ action: 'connections-cancel-dialog' });
    expect(mount.getState().dialog.stage).toBe('closed');
    expect(getHtml()).toContain('data-connection-credential-receipt="verified"');
    expect(getHtml()).toContain('replacement for api/receipt-api was checked');
    mount.dispose();
  });

  it('automatically advances a still-pending reload recovery to its receipt', async () => {
    vi.useFakeTimers();
    const continuity = rotationContinuity();
    expect(continuity.store.write({
      attemptId: 'rotation-pending-test-0001',
      kind: 'api',
      name: 'pending-api',
    })).toBe('stored');
    let statusCalls = 0;
    const terminal = deferred<Awaited<ReturnType<
      ConnectionsCredentialRotationStatusCaller
    >>>();
    const { mount, calls, getHtml, getRenderCount } = mountPanel({
      connections: [connection('pending-api', { auth_type: 'bearer' })],
      credentialRotationContinuity: continuity.store,
      runCredentialRotationStatus: async () => {
        statusCalls += 1;
        if (statusCalls <= 2) {
          return { outcome: { status: 'pending' as const, started_at: FIXED_NOW } };
        }
        return terminal.promise;
      },
    });

    try {
      await mount.whenLoaded();
      expect(mount.getState().credentialRotationRecovery).toMatchObject({
        phase: 'pending',
        name: 'pending-api',
      });
      expect(calls.runCredentialRotationStatus).toHaveBeenCalledTimes(1);
      const pendingRenderCount = getRenderCount();

      await vi.advanceTimersByTimeAsync(2_000);
      expect(calls.runCredentialRotationStatus).toHaveBeenCalledTimes(2);
      expect(getRenderCount()).toBe(pendingRenderCount);

      await vi.advanceTimersByTimeAsync(2_000);
      expect(calls.runCredentialRotationStatus).toHaveBeenCalledTimes(3);
      // Background polling must not churn the polite live region through a
      // transient "Checking…" state while the server call is outstanding.
      expect(mount.getState().credentialRotationRecovery?.phase).toBe('pending');
      expect(getRenderCount()).toBe(pendingRenderCount);

      terminal.resolve({
        outcome: {
          status: 'succeeded',
          started_at: FIXED_NOW,
          verification: {
            status: 'verified',
            verified_at: FIXED_NOW + 2_000,
            auth_type: 'bearer',
          },
        },
      });
      await tick();

      expect(continuity.store.read()).toBeNull();
      expect(mount.getState().credentialRotationRecovery).toBeNull();
      expect(getHtml()).toContain('A key you paste in replacement for api/pending-api was checked and is now in use');
    } finally {
      mount.dispose();
      vi.useRealTimers();
    }
  });

  it('reclaims and announces ownership only after the exact receipt is pending', async () => {
    const continuity = rotationContinuity();
    const observerLease = rotationOwnershipLease();
    const tabs = rotationTabs({
      supportsOwnershipLeases: true,
      claim: async () => observerLease,
    });
    expect(continuity.store.write({
      attemptId: 'rotation-pending-owner-0001',
      kind: 'api',
      name: 'pending-owner-api',
      baselineUpdatedAt: 90,
    })).toBe('stored');
    const { mount, calls } = mountPanel({
      connections: [connection('pending-owner-api', { updated_at: 90 })],
      credentialRotationContinuity: continuity.store,
      credentialRotationTabConvergence: tabs.convergence,
      runCredentialRotationStatus: async () => ({
        outcome: { status: 'pending', started_at: FIXED_NOW },
      }),
    });

    await mount.whenLoaded();
    expect(calls.runCredentialRotationStatus).toHaveBeenCalledOnce();
    expect(tabs.claimCredentialRotationOwnership).toHaveBeenCalledOnce();
    expect(tabs.notifyCredentialRotationStarted).toHaveBeenCalledWith({
      kind: 'api',
      name: 'pending-owner-api',
    });
    expect(mount.getState().credentialRotationRecovery?.phase).toBe('pending');
    expect(observerLease.release).not.toHaveBeenCalled();
    mount.dispose();
  });

  it('clears a stale recovery callout when its marker is no longer present', async () => {
    const continuity = rotationContinuity();
    expect(continuity.store.write({
      attemptId: 'rotation-cleared-test-0001',
      kind: 'api',
      name: 'cleared-api',
    })).toBe('stored');
    const { mount, click } = mountPanel({
      connections: [connection('cleared-api', { auth_type: 'bearer' })],
      credentialRotationContinuity: continuity.store,
      runCredentialRotationStatus: async () => ({
        outcome: { status: 'pending', started_at: FIXED_NOW },
      }),
    });
    await mount.whenLoaded();
    expect(mount.getState().credentialRotationRecovery?.phase).toBe('pending');

    continuity.store.retire('rotation-cleared-test-0001');
    click({ action: 'connections-check-credential-rotation' });
    await tick();

    expect(mount.getState().credentialRotationRecovery).toBeNull();
    mount.dispose();
  });

  it('reconciles an in-doubt rotation automatically on reconnect', async () => {
    const continuity = rotationContinuity();
    const reconnect: { current?: () => void } = {};
    const lost = Object.assign(new Error('socket dropped'), {
      code: 'connection_lost',
    });
    let statusCalls = 0;
    const { mount, click, field, calls, getHtml } = mountPanel({
      connections: [connection('reconnect-api', {
        base_url: 'https://api.example.com',
        auth_type: 'bearer',
      })],
      credentialRotationContinuity: continuity.store,
      runRotateCredentials: async () => { throw lost; },
      runCredentialRotationStatus: async () => {
        statusCalls += 1;
        if (statusCalls === 1) {
          throw Object.assign(new Error('still offline'), {
            code: 'server_offline',
          });
        }
        return {
          outcome: {
            status: 'succeeded' as const,
            started_at: FIXED_NOW,
            verification: {
              status: 'verified' as const,
              verified_at: FIXED_NOW + 2_000,
              auth_type: 'bearer' as const,
            },
          },
        };
      },
      onReconnect: (listener) => {
        reconnect.current = listener;
        return () => { delete reconnect.current; };
      },
    });
    await mount.whenLoaded();

    click({ action: 'connections-edit', kind: 'api', name: 'reconnect-api' });
    field('auth.token', 'never-persist-this-secret');
    click({ action: 'connections-submit-form' });
    await tick();

    expect(mount.getState().credentialRotationRecovery).toMatchObject({
      phase: 'waiting',
      name: 'reconnect-api',
    });
    expect(continuity.store.read()?.attemptId).toBe('rotation-panel-test-0001');
    expect(getHtml()).toContain('outcome is not confirmed yet');
    expect(getHtml()).toContain('data-action="connections-check-credential-rotation"');
    expect(JSON.stringify([...continuity.values.values()])).not.toContain(
      'never-persist-this-secret',
    );

    reconnect.current?.();
    await tick(20);
    expect(calls.runCredentialRotationStatus).toHaveBeenCalledTimes(2);
    expect(continuity.store.read()).toBeNull();
    expect(mount.getState().dialog.stage).toBe('closed');
    expect(mount.getState().dialog.recentProbe).toMatchObject({
      purpose: 'credential_rotation',
      name: 'reconnect-api',
      status: 'verified',
    });
    expect(getHtml()).toContain('A key you paste in replacement for api/reconnect-api was checked and is now in use');
    mount.dispose();
  });

  it('reconciles instead of retrying when the server could not close its receipt', async () => {
    const continuity = rotationContinuity();
    const unknown = Object.assign(new Error('receipt outcome unknown'), {
      code: 'credential_rotation_outcome_unknown',
    });
    const { mount, click, field, calls } = mountPanel({
      connections: [connection('receipt-failure-api', {
        base_url: 'https://api.example.com',
        auth_type: 'bearer',
      })],
      credentialRotationContinuity: continuity.store,
      runRotateCredentials: async () => { throw unknown; },
      runCredentialRotationStatus: async () => ({
        outcome: {
          status: 'failed',
          started_at: FIXED_NOW,
          finished_at: FIXED_NOW + 1_000,
          reason: 'server_error',
        },
      }),
    });
    await mount.whenLoaded();

    click({ action: 'connections-edit', kind: 'api', name: 'receipt-failure-api' });
    field('auth.token', 'never-replay-this-secret');
    click({ action: 'connections-submit-form' });
    await tick(20);

    expect(calls.runRotateCredentials).toHaveBeenCalledTimes(1);
    expect(calls.runCredentialRotationStatus).toHaveBeenCalledTimes(1);
    expect(continuity.store.read()).toBeNull();
    expect(mount.getState().credentialRotationRecovery).toMatchObject({
      phase: 'failed',
      failureReason: 'server_error',
    });
    expect(mount.getState().dialog.error).toContain(
      'Recued kept the old key',
    );
    mount.dispose();
  });

  it('turns a recovered rotation conflict into the stale-editor reload boundary', async () => {
    const continuity = rotationContinuity();
    const unknown = Object.assign(new Error('reply was lost'), {
      code: 'credential_rotation_outcome_unknown',
    });
    const { mount, click, field, calls, getHtml } = mountPanel({
      connections: [connection('recovered-conflict', {
        base_url: 'https://api.example.com',
        auth_type: 'bearer',
        updated_at: 50,
      })],
      credentialRotationContinuity: continuity.store,
      runRotateCredentials: async () => { throw unknown; },
      runCredentialRotationStatus: async () => ({
        outcome: {
          status: 'failed',
          started_at: FIXED_NOW,
          finished_at: FIXED_NOW + 1_000,
          reason: 'conflict',
        },
      }),
    });
    await mount.whenLoaded();
    click({ action: 'connections-edit', kind: 'api', name: 'recovered-conflict' });
    field('auth.token', 'keep-recovered-conflict');
    click({ action: 'connections-submit-form' });
    await tick(20);

    expect(calls.runRotateCredentials).toHaveBeenCalledTimes(1);
    expect(calls.runCredentialRotationStatus).toHaveBeenCalledTimes(1);
    expect(mount.getState().dialog.values['auth.token']).toBe(
      'keep-recovered-conflict',
    );
    expect(mount.getState().dialog.error).toBeNull();
    expect(mount.getState().dialog.externalChange?.phase).toBe('changed');
    expect(getHtml()).toContain('Reload latest');
    click({ action: 'connections-submit-form' });
    await tick();
    expect(calls.runRotateCredentials).toHaveBeenCalledTimes(1);
    mount.dispose();
  });

  it('does not send a replacement when reload continuity cannot be stored', async () => {
    const continuity = rotationContinuity(null);
    const { mount, click, field, calls } = mountPanel({
      connections: [connection('storage-blocked', {
        base_url: 'https://api.example.com',
        auth_type: 'bearer',
      })],
      credentialRotationContinuity: continuity.store,
    });
    await mount.whenLoaded();

    click({ action: 'connections-edit', kind: 'api', name: 'storage-blocked' });
    field('auth.token', 'must-not-send');
    click({ action: 'connections-submit-form' });
    await tick();

    expect(calls.runRotateCredentials).not.toHaveBeenCalled();
    expect(mount.getState().dialog.error).toContain(
      "couldn't protect this replacement through a reload",
    );
    expect(mount.getState().dialog.values['auth.token']).toBe('must-not-send');
    mount.dispose();
  });

  it('does not send a replacement when the host omits recovery continuity', async () => {
    const { mount, click, field, calls } = mountPanel({
      connections: [connection('continuity-unwired', {
        base_url: 'https://api.example.com',
        auth_type: 'bearer',
      })],
      credentialRotationContinuity: null,
    });
    await mount.whenLoaded();

    click({ action: 'connections-edit', kind: 'api', name: 'continuity-unwired' });
    field('auth.token', 'must-not-send');
    click({ action: 'connections-submit-form' });
    await tick();

    expect(calls.runRotateCredentials).not.toHaveBeenCalled();
    expect(mount.getState().dialog.error).toContain(
      "couldn't protect this replacement through a reload",
    );
    mount.dispose();
  });

  it('holds the rotation dialog until the exact verification receipt lands', async () => {
    const rotate = deferred<Awaited<ReturnType<ConnectionsRotateCredentialsCaller>>>();
    const { mount, click, field } = mountPanel({
      connections: [connection('slow-rotation', { base_url: 'https://api.example.com' })],
      runRotateCredentials: () => rotate.promise,
    });
    await mount.whenLoaded();

    click({ action: 'connections-edit', kind: 'api', name: 'slow-rotation' });
    field('auth.token', 'replacement');
    click({ action: 'connections-submit-form' });
    await tick(2);
    expect(mount.getState().dialog.saving).toBe(true);

    // A delegated/synthetic click cannot bypass the disabled Cancel button and
    // discard the eventual rotation outcome.
    click({ action: 'connections-cancel-dialog' });
    expect(mount.getState().dialog.stage).toBe('form');
    expect(mount.getState().dialog.saving).toBe(true);

    rotate.resolve({
      connection: connection('slow-rotation'),
      verification: {
        status: 'verified',
        verified_at: FIXED_NOW,
        auth_type: 'bearer',
      },
    });
    await tick();
    expect(mount.getState().dialog.stage).toBe('closed');
    expect(mount.getState().dialog.recentProbe).toMatchObject({
      purpose: 'credential_rotation',
      status: 'verified',
    });
    mount.dispose();
  });

  it('keeps the outcome pointer when the route closes before success can render', async () => {
    const continuity = rotationContinuity();
    const rotate = deferred<Awaited<ReturnType<ConnectionsRotateCredentialsCaller>>>();
    const first = mountPanel({
      connections: [connection('route-change-api', {
        base_url: 'https://api.example.com',
        auth_type: 'bearer',
      })],
      credentialRotationContinuity: continuity.store,
      runRotateCredentials: () => rotate.promise,
    });
    await first.mount.whenLoaded();
    first.click({ action: 'connections-edit', kind: 'api', name: 'route-change-api' });
    first.field('auth.token', 'memory-only-replacement');
    first.click({ action: 'connections-submit-form' });
    await tick(2);
    expect(continuity.store.read()?.attemptId).toBe('rotation-panel-test-0001');

    first.mount.dispose();
    rotate.resolve({
      connection: connection('route-change-api'),
      verification: {
        status: 'verified',
        verified_at: FIXED_NOW,
        auth_type: 'bearer',
      },
    });
    await tick();
    expect(continuity.store.read()?.attemptId).toBe('rotation-panel-test-0001');

    const resumed = mountPanel({
      connections: [connection('route-change-api', { auth_type: 'bearer' })],
      credentialRotationContinuity: continuity.store,
      runCredentialRotationStatus: async () => ({
        outcome: {
          status: 'succeeded',
          started_at: FIXED_NOW,
          verification: {
            status: 'verified',
            verified_at: FIXED_NOW,
            auth_type: 'bearer',
          },
        },
      }),
    });
    await resumed.mount.whenLoaded();

    expect(continuity.store.read()).toBeNull();
    expect(resumed.calls.runRotateCredentials).not.toHaveBeenCalled();
    expect(resumed.getHtml()).toContain('A key you paste in replacement for api/route-change-api was checked and is now in use');
    resumed.mount.dispose();
  });

  it('keeps the rejected draft and lands on the server-authoritative correction field', async () => {
    const failure =
      'The provider rejected the replacement credentials. Your saved connection was not changed.';
    const rejected = new RpcError(
      'credential_verification_failed',
      failure,
      422,
      'collection.connection.rotateCredentials',
      {
        verification_status: 'auth_failed',
        existing_credential_preserved: true,
        correction: {
          auth_type: 'bearer',
          field_keys: ['auth.token'],
        },
      },
    );
    const { mount, click, field, calls, getHtml, getFocusedSelector } = mountPanel({
      connections: [connection('my-api', { base_url: 'https://api.example.com' })],
      runRotateCredentials: async () => { throw rejected; },
    });
    await mount.whenLoaded();

    click({ action: 'connections-edit', kind: 'api', name: 'my-api' });
    field('auth.token', 'try-again-secret');
    click({ action: 'connections-submit-form' });
    await tick();

    expect(calls.runRotateCredentials).toHaveBeenCalledTimes(1);
    expect(calls.runUpdate).not.toHaveBeenCalled();
    expect(calls.runList).toHaveBeenCalledTimes(1);
    expect(mount.getState().dialog.stage).toBe('form');
    expect(mount.getState().dialog.saving).toBe(false);
    expect(mount.getState().dialog.values['auth.token']).toBe('try-again-secret');
    expect(mount.getState().dialog.error).toBeNull();
    expect(mount.getState().dialog.credentialCorrection).toEqual({
      message: failure,
      fieldKeys: ['auth.token'],
    });
    expect(getHtml()).toContain('saved connection was not changed');
    expect(getHtml()).toContain('Replacement rejected');
    expect(getHtml()).toContain('Review Bearer Token');
    expect(getHtml()).toContain('aria-errormessage="connections-credential-correction-message"');
    expect(getFocusedSelector()).toBe(fieldSelector('auth.token'));
    expect(getHtml()).toContain('Replacement ready to verify');

    // The action target comes from live state, never the clicked dataset.
    click({ action: 'connections-focus-credential-correction', fieldKey: 'forged' });
    expect(getFocusedSelector()).toBe(fieldSelector('auth.token'));

    // Unrelated edits do not dismiss an authoritative credential rejection,
    // and a new local blocker remains actionable beside it.
    field('display_name', '');
    expect(mount.getState().dialog.credentialCorrection).not.toBeNull();
    expect(getHtml()).toContain('Next: Display name');
    expect(getHtml()).toContain('Display name is required.');
    expect(getHtml()).toMatch(/data-action="connections-submit-form"[^>]*disabled/);
    field('display_name', 'Renamed API');
    expect(mount.getState().dialog.credentialCorrection).not.toBeNull();
    expect(getHtml()).not.toContain('data-connection-form-validation');
    field('auth.token', 'corrected-secret');
    expect(mount.getState().dialog.credentialCorrection).toBeNull();
    expect(getHtml()).toContain('Required details complete');

    // A new server target also invalidates the old provider verdict, while
    // leaving the memory-only replacement available for the next check.
    click({ action: 'connections-submit-form' });
    await tick();
    expect(mount.getState().dialog.credentialCorrection).not.toBeNull();
    field('config.base_url', 'https://other-api.example.com');
    expect(mount.getState().dialog.credentialCorrection).toBeNull();
    expect(mount.getState().dialog.values['auth.token']).toBe('corrected-secret');
    mount.dispose();
  });

  it('routes a repeated rejection to the exact server-authoritative endpoint and setup guide', async () => {
    const rejectedAgain = new RpcError(
      'credential_verification_failed',
      'The provider rejected the replacement credentials. Your saved connection was not changed.',
      422,
      'collection.connection.rotateCredentials',
      {
        verification_status: 'auth_failed',
        existing_credential_preserved: true,
        correction: {
          auth_type: 'bearer',
          field_keys: ['auth.token'],
          triage: {
            reason: 'repeated_auth_rejection',
            stage: 'provider_probe',
            endpoint_field_keys: ['config.base_url', 'config.endpoint'],
          },
        },
      },
    );
    const {
      mount,
      click,
      field,
      getHtml,
      getFocusedSelector,
    } = mountPanel({
      connections: [connection('triage-api', {
        base_url: 'https://api.example.com',
      })],
      runRotateCredentials: async () => { throw rejectedAgain; },
    });
    await mount.whenLoaded();

    click({ action: 'connections-edit', kind: 'api', name: 'triage-api' });
    field('auth.token', 'memory-only-secret');
    click({ action: 'connections-submit-form' });
    await tick();

    expect(mount.getState().dialog.credentialCorrection).toEqual({
      message: rejectedAgain.message,
      fieldKeys: ['auth.token'],
      triage: {
        stage: 'provider_probe',
        endpointFieldKeys: ['config.base_url'],
      },
    });
    expect(getHtml()).toContain('Replacement rejected again');
    expect(getHtml()).toContain('Review Base URL');
    expect(getHtml()).toContain('Check provider setup');

    click({
      action: 'connections-focus-credential-triage',
      fieldKey: 'forged',
    });
    expect(getFocusedSelector()).toBe(fieldSelector('config.base_url'));

    click({ action: 'connections-guide-open' });
    expect(mount.getState().dialog.setupGuide.stage).toBe('entry');
    expect(mount.getState().dialog.credentialCorrection).not.toBeNull();
    expect(getFocusedSelector()).toBe(GUIDE_URL_SELECTOR);
    mount.dispose();
  });

  it('safe-stops a third rejection and offers only explicit, privacy-safe recovery', async () => {
    const continuity = rotationContinuity();
    const tabs = rotationTabs();
    const runActivity = vi.fn<ConnectionsCredentialRotationActivityCaller>()
      .mockResolvedValueOnce(safeStopActivity())
      .mockResolvedValue({
        activity: { status: 'idle', safe_stop: null },
      });
    const copyText = vi.fn(async (_value: string) => {});
    const rejectedAgain = new RpcError(
      'credential_verification_failed',
      'The provider rejected the replacement credentials. Your saved connection was not changed.',
      422,
      'collection.connection.rotateCredentials',
      {
        verification_status: 'auth_failed',
        existing_credential_preserved: true,
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
      },
    );
    const panel = mountPanel({
      connections: [connection('safe-stop-api', {
        display_name: 'Safe stop API',
        base_url: 'https://private-api.example.com',
        auth_type: 'bearer',
        updated_at: 81,
      })],
      credentialRotationContinuity: continuity.store,
      credentialRotationTabConvergence: tabs.convergence,
      runCredentialRotationActivity: runActivity,
      copyText,
      runRotateCredentials: async () => { throw rejectedAgain; },
      runSuggestSetup: async (args) => ({
        shared_context: {
          target_url: args.target_url,
          auth_type: args.auth_type,
          field_keys: [...args.field_keys],
        },
        guide: {
          provider_name: 'Example Cloud',
          overview: 'Confirm the endpoint before rotating the credential.',
          field_suggestions: [{
            field_key: 'config.base_url',
            suggested_value: 'https://private-api.example.com',
            guidance: 'Use the documented API base URL.',
            confidence: 'high',
          }],
          steps: [{
            title: 'Rotate the credential',
            instruction: 'Create a new least-privilege credential.',
            field_keys: ['auth.token'],
          }],
          cautions: [],
        },
      }),
    });
    await panel.mount.whenLoaded();

    panel.click({
      action: 'connections-edit',
      kind: 'api',
      name: 'safe-stop-api',
    });
    panel.field('auth.token', 'memory-only-rejected-secret');
    panel.click({ action: 'connections-submit-form' });
    await tick();

    expect(panel.calls.runRotateCredentials).toHaveBeenCalledOnce();
    expect(continuity.store.read()).toMatchObject({
      attemptId: 'rotation-panel-test-0001',
      kind: 'api',
      name: 'safe-stop-api',
    });
    expect(JSON.stringify([...continuity.values.values()])).not.toContain(
      'memory-only-rejected-secret',
    );
    expect(panel.mount.getState().credentialRotationRecovery).toMatchObject({
      phase: 'safe_stopped',
      failureReason: 'auth_failed',
      correction: {
        triage: {
          resolution: 'regenerate_credential_or_contact_admin',
        },
      },
    });
    expect(panel.mount.getState().dialog.credentialCorrection).toMatchObject({
      triage: {
        resolution: 'regenerate_credential_or_contact_admin',
      },
    });
    expect(tabs.notifyCredentialRotationSafeStopped).toHaveBeenCalledWith({
      kind: 'api',
      name: 'safe-stop-api',
    });
    expect(panel.getHtml()).toContain('Pause before retrying');
    expect(panel.getHtml()).toContain('Create or rotate credential');
    expect(panel.getHtml()).toContain('Provider/admin confirmed a fix');
    expect(panel.getHtml()).toMatch(
      /data-action="connections-submit-form"[^>]*disabled/,
    );

    // A delegated or scripted retry cannot bypass the disabled control.
    panel.click({ action: 'connections-submit-form' });
    await tick();
    expect(panel.calls.runRotateCredentials).toHaveBeenCalledOnce();
    expect(panel.getFocusedSelector()).toBe(
      CREDENTIAL_CORRECTION_PANEL_SELECTOR,
    );

    const copyButton = panel.click({
      action: 'connections-copy-credential-admin-handoff',
    });
    await tick();
    expect(copyText).toHaveBeenCalledOnce();
    const copied = copyText.mock.calls[0]![0];
    expect(copied).toContain('Connection: api/safe-stop-api');
    expect(copied).toContain('Sign-in method: A key you paste in');
    expect(copied).toContain('Non-secret fields to review: Base URL');
    expect(copied).not.toContain('Recued sent nothing by itself');
    expect(copied).not.toContain('memory-only-rejected-secret');
    expect(copied).not.toContain('https://private-api.example.com');
    expect(copied).not.toContain(rejectedAgain.message);
    expect(copyButton.textContent).toBe('Copied');
    expect(panel.credentialAdminHandoffStatus.textContent).toContain(
      'Recued sent nothing by itself',
    );

    panel.click({
      action: 'connections-focus-credential-correction',
      fieldKey: 'forged',
    });
    expect(panel.getFocusedSelector()).toBe(fieldSelector('auth.token'));
    expect(continuity.store.read()).not.toBeNull();

    // Applying an unchanged guide suggestion must not turn the same rejected
    // candidate into an enabled retry.
    panel.click({ action: 'connections-guide-open' });
    panel.guideUrl('https://developer.example.com/apps');
    panel.click({ action: 'connections-guide-review' });
    panel.click({ action: 'connections-guide-generate' });
    await tick();
    panel.click({
      action: 'connections-guide-use-suggestion',
      fieldKey: 'config.base_url',
    });
    expect(panel.mount.getState().dialog.credentialCorrection).not.toBeNull();
    expect(continuity.store.read()).not.toBeNull();
    expect(panel.getHtml()).toMatch(
      /data-action="connections-submit-form"[^>]*disabled/,
    );

    // The retained draft can be retried only after the owner explicitly says
    // the provider-side condition changed. The paired server records that
    // exact safe-stop closure before a separate verification is enabled.
    panel.click({ action: 'connections-confirm-credential-handoff' });
    await tick();
    expect(panel.calls.runAcknowledgeCredentialRotationSafeStop)
      .toHaveBeenCalledWith({
        kind: 'api',
        name: 'safe-stop-api',
        acknowledgement_token: SAFE_STOP_TOKEN,
      });
    expect(continuity.store.read()).toBeNull();
    expect(panel.mount.getState().credentialRotationRecovery).toBeNull();
    expect(panel.mount.getState().dialog.credentialCorrection).toBeNull();
    expect(panel.getFocusedSelector()).toBe(SUBMIT_SELECTOR);
    expect(panel.getHtml()).toContain('Recovery stop closed');
    expect(tabs.notifyCredentialRotationSafeStopResolved).toHaveBeenCalledWith({
      kind: 'api',
      name: 'safe-stop-api',
    });
    expect(panel.getHtml()).not.toMatch(
      /data-action="connections-submit-form"[^>]*disabled/,
    );
    expect(panel.calls.runRotateCredentials).toHaveBeenCalledOnce();

    tabs.emit({ type: 'reconcile' });
    await tick();
    expect(runActivity).toHaveBeenCalledTimes(2);
    expect(panel.mount.getState().credentialRotationRecovery).toBeNull();
    expect(panel.mount.getState().dialog.credentialCorrection).toBeNull();
    expect(panel.getHtml()).not.toMatch(
      /data-action="connections-submit-form"[^>]*disabled/,
    );
    panel.mount.dispose();
  });

  it('restores a safe stop without credentials and requires one explicit admin-fix acknowledgement', async () => {
    const continuity = rotationContinuity();
    expect(continuity.store.write({
      attemptId: 'rotation-safe-stop-reload-01',
      kind: 'api',
      name: 'reload-safe-stop',
      baselineUpdatedAt: 82,
    })).toBe('stored');
    const saved = connection('reload-safe-stop', {
      display_name: 'Reload safe stop',
      base_url: 'https://private-api.example.com',
      auth_type: 'bearer',
      updated_at: 82,
    });
    const runCredentialRotationStatus = async () => ({
      outcome: {
        status: 'failed' as const,
        started_at: FIXED_NOW,
        finished_at: FIXED_NOW + 1_000,
        reason: 'auth_failed' as const,
        correction: {
          auth_type: 'bearer' as const,
          field_keys: ['auth.token'] as const,
          triage: {
            reason: 'repeated_auth_rejection' as const,
            stage: 'provider_probe' as const,
            endpoint_field_keys: [
              'config.base_url' as const,
              'config.endpoint' as const,
            ],
            resolution: 'regenerate_credential_or_contact_admin' as const,
          },
        },
      },
    });
    const first = mountPanel({
      connections: [saved],
      credentialRotationContinuity: continuity.store,
      runCredentialRotationStatus,
    });
    await first.mount.whenLoaded();

    expect(first.calls.runRotateCredentials).not.toHaveBeenCalled();
    expect(continuity.store.read()?.attemptId).toBe(
      'rotation-safe-stop-reload-01',
    );
    expect(first.mount.getState().credentialRotationRecovery).toMatchObject({
      phase: 'failed',
      correction: {
        triage: {
          resolution: 'regenerate_credential_or_contact_admin',
        },
      },
    });
    expect(first.getHtml()).toContain('Resume credential recovery');

    first.click({
      action: 'connections-review-credential-rotation',
      kind: 'api',
      name: 'reload-safe-stop',
    });
    expect(first.mount.getState().dialog.editingId).toBe(
      'api/reload-safe-stop',
    );
    expect(first.mount.getState().dialog.values['auth.token']).toBeUndefined();
    expect(first.mount.getState().dialog.credentialCorrection).toMatchObject({
      triage: {
        resolution: 'regenerate_credential_or_contact_admin',
      },
    });
    expect(first.getHtml()).toContain('No rejected credential was restored');
    expect(first.getHtml()).not.toContain('Provider/admin confirmed a fix');
    expect(first.getHtml()).toMatch(
      /data-action="connections-submit-form"[^>]*disabled/,
    );
    expect(continuity.store.read()).not.toBeNull();

    // The action is absent and its handler independently rechecks that an
    // exact, complete replacement draft still exists.
    first.click({ action: 'connections-confirm-credential-handoff' });
    expect(first.mount.getState().dialog.credentialCorrection).not.toBeNull();
    expect(continuity.store.read()).not.toBeNull();
    first.mount.dispose();

    const restored = mountPanel({
      connections: [saved],
      credentialRotationContinuity: continuity.store,
      runCredentialRotationStatus,
    });
    await restored.mount.whenLoaded();
    expect(restored.calls.runRotateCredentials).not.toHaveBeenCalled();
    expect(restored.getHtml()).toContain('Resume credential recovery');
    expect(continuity.store.read()).not.toBeNull();

    restored.click({
      action: 'connections-review-credential-rotation',
      kind: 'api',
      name: 'reload-safe-stop',
    });
    expect(restored.getHtml()).not.toContain(
      'Provider/admin confirmed a fix',
    );
    restored.field('auth.token', 'newly-rotated-secret');
    expect(continuity.store.read()).toBeNull();
    expect(restored.mount.getState().credentialRotationRecovery).toBeNull();
    expect(restored.mount.getState().dialog.credentialCorrection).toBeNull();
    expect(restored.getHtml()).not.toMatch(
      /data-action="connections-submit-form"[^>]*disabled/,
    );
    expect(restored.calls.runRotateCredentials).not.toHaveBeenCalled();
    restored.mount.dispose();
  });

  it('keeps the safe stop through failed OAuth and retires it only for a claimed fresh token', async () => {
    const continuity = rotationContinuity();
    const popups = [makeFakePopup(), makeFakePopup()];
    const oauthEnv = {
      open: vi.fn(() => popups.shift() ?? null),
      setTimeout: vi.fn(() => 1),
      clearTimeout: vi.fn(),
    } satisfies VendorOAuthBrowserEnv;
    const sub = makeFakeSubscribe();
    const runStart = vi.fn<ConnectionsStartVendorOAuthCaller>();
    runStart
      .mockRejectedValueOnce(Object.assign(new Error('invalid_client'), {
        code: 'credential_verification_failed',
      }))
      .mockResolvedValueOnce({
        authorize_url: 'https://auth.example.com/authorize?flow=safe-stop',
        flow_id: 'flow-safe-stop',
        server_identity_public_key_b64: 'safe-stop-public-key',
        claim_secret: 'safe-stop-claim',
      });
    const runTake = vi.fn<ConnectionsTakeVendorOAuthResultCaller>(async () => ({
      result: {
        refresh_token: 'fresh-oauth-token',
        granted_scopes: ['records.read'],
      },
    }));
    const rejectedAgain = new RpcError(
      'credential_verification_failed',
      'The provider rejected the replacement credentials. Your saved connection was not changed.',
      422,
      'collection.connection.rotateCredentials',
      {
        verification_status: 'auth_failed',
        existing_credential_preserved: true,
        correction: {
          auth_type: 'oauth2_refresh',
          field_keys: [
            'auth.refresh_token',
            'auth.client_id',
            'auth.client_secret',
            'auth.token_endpoint',
          ],
          triage: {
            reason: 'repeated_auth_rejection',
            stage: 'credential_exchange',
            endpoint_field_keys: ['auth.token_endpoint'],
            resolution: 'regenerate_credential_or_contact_admin',
          },
        },
      },
    );
    const panel = mountPanel({
      connections: [connection('oauth-safe-stop', {
        display_name: 'OAuth safe stop',
        base_url: 'https://api.example.com',
        auth_type: 'oauth2_refresh',
        updated_at: 83,
      })],
      credentialRotationContinuity: continuity.store,
      runRotateCredentials: async () => { throw rejectedAgain; },
      oauth: {
        env: oauthEnv,
        subscribe: sub.subscribe,
        runStart,
        runTake,
      },
    });
    await panel.mount.whenLoaded();

    panel.click({
      action: 'connections-edit',
      kind: 'api',
      name: 'oauth-safe-stop',
    });
    panel.field('auth.refresh_token', 'rejected-oauth-token');
    panel.field('auth.client_id', 'client-id');
    panel.field('auth.client_secret', 'client-secret');
    panel.field('auth.authorize_url', 'https://auth.example.com/authorize');
    panel.field('auth.token_endpoint', 'https://auth.example.com/token');
    panel.click({ action: 'connections-submit-form' });
    await tick();

    expect(panel.mount.getState().dialog.credentialCorrection).toMatchObject({
      triage: {
        resolution: 'regenerate_credential_or_contact_admin',
      },
    });
    expect(continuity.store.read()).not.toBeNull();

    panel.click({ action: 'connections-authorize-vendor' });
    await flushAsync();
    expect(runStart).toHaveBeenCalledTimes(1);
    expect(panel.mount.getState().dialog.oauthInFlight).toBe(false);
    expect(panel.mount.getState().dialog.credentialCorrection).toMatchObject({
      triage: {
        resolution: 'regenerate_credential_or_contact_admin',
      },
    });
    expect(continuity.store.read()).not.toBeNull();
    expect(panel.getHtml()).toContain('Pause before retrying');

    panel.click({ action: 'connections-authorize-vendor' });
    await flushAsync();
    expect(runStart).toHaveBeenCalledTimes(2);
    expect(panel.mount.getState().dialog.oauthInFlight).toBe(true);
    expect(panel.mount.getState().dialog.credentialCorrection).toBeNull();
    expect(continuity.store.read()).not.toBeNull();

    sub.fire('flow-safe-stop');
    await flushAsync();
    expect(runTake).toHaveBeenCalledWith({
      flow_id: 'flow-safe-stop',
      claim_secret: 'safe-stop-claim',
    });
    expect(panel.mount.getState().dialog.values['auth.refresh_token']).toBe(
      'fresh-oauth-token',
    );
    expect(panel.mount.getState().dialog.credentialCorrection).toBeNull();
    expect(panel.mount.getState().credentialRotationRecovery).toBeNull();
    expect(continuity.store.read()).toBeNull();
    expect(panel.calls.runRotateCredentials).toHaveBeenCalledOnce();
    panel.mount.dispose();
  });

  it('ignores malformed triage metadata without losing a valid correction', async () => {
    const rejected = new RpcError(
      'credential_verification_failed',
      'The provider rejected the replacement credentials.',
      422,
      'collection.connection.rotateCredentials',
      {
        verification_status: 'auth_failed',
        existing_credential_preserved: true,
        correction: {
          auth_type: 'bearer',
          field_keys: ['auth.token'],
          triage: {
            reason: 'repeated_auth_rejection',
            stage: 'provider_probe',
            endpoint_field_keys: ['auth.token_endpoint'],
          },
        },
      },
    );
    const { mount, click, field, getHtml } = mountPanel({
      connections: [connection('malformed-triage', {
        base_url: 'https://api.example.com',
      })],
      runRotateCredentials: async () => { throw rejected; },
    });
    await mount.whenLoaded();

    click({ action: 'connections-edit', kind: 'api', name: 'malformed-triage' });
    field('auth.token', 'memory-only-secret');
    click({ action: 'connections-submit-form' });
    await tick();

    expect(mount.getState().dialog.credentialCorrection).toEqual({
      message: rejected.message,
      fieldKeys: ['auth.token'],
    });
    expect(getHtml()).toContain('Replacement rejected');
    expect(getHtml()).not.toContain('Replacement rejected again');
    expect(getHtml()).not.toContain('data-connection-credential-triage');
    mount.dispose();
  });

  it('lands a grouped header rejection on the repeatable credential control', async () => {
    const rejected = new RpcError(
      'credential_verification_failed',
      'The provider rejected the replacement credentials.',
      422,
      'collection.connection.rotateCredentials',
      {
        verification_status: 'auth_failed',
        existing_credential_preserved: true,
        correction: {
          auth_type: 'header',
          field_keys: ['auth.headers'],
        },
      },
    );
    const { mount, click, field, calls, getFocusedSelector } = mountPanel({
      connections: [connection('header-api', {
        auth_type: 'header',
        base_url: 'https://api.example.com',
      })],
      runRotateCredentials: async () => { throw rejected; },
    });
    await mount.whenLoaded();

    click({ action: 'connections-edit', kind: 'api', name: 'header-api' });
    field('auth.headers.0.header_name', 'X-API-Key');
    field('auth.headers.0.value', 'memory-only-secret');
    click({ action: 'connections-submit-form' });
    await tick();

    expect(mount.getState().dialog.error).toBeNull();
    expect(calls.runRotateCredentials).toHaveBeenCalledTimes(1);
    expect(mount.getState().dialog.credentialCorrection?.fieldKeys).toEqual([
      'auth.headers',
    ]);
    expect(getFocusedSelector()).toBe(
      '.connections-field-row[data-field-key="auth.headers"]',
    );
    mount.dispose();
  });

  it('does not turn stale server correction metadata into a form selector', async () => {
    const failure = 'The provider rejected the replacement credentials.';
    const stale = new RpcError(
      'credential_verification_failed',
      failure,
      422,
      'collection.connection.rotateCredentials',
      {
        verification_status: 'auth_failed',
        existing_credential_preserved: true,
        correction: {
          auth_type: 'bearer',
          field_keys: ['name', 'auth.token'],
        },
      },
    );
    const { mount, click, field, getHtml } = mountPanel({
      connections: [connection('stale-correction', {
        base_url: 'https://api.example.com',
        auth_type: 'bearer',
      })],
      runRotateCredentials: async () => { throw stale; },
    });
    await mount.whenLoaded();

    click({ action: 'connections-edit', kind: 'api', name: 'stale-correction' });
    field('auth.token', 'memory-only-secret');
    click({ action: 'connections-submit-form' });
    await tick();

    expect(mount.getState().dialog.credentialCorrection).toBeNull();
    expect(mount.getState().dialog.error).toBe(failure);
    expect(getHtml()).not.toContain('data-connection-credential-correction');
    expect(getHtml()).not.toContain('Review Password');
    mount.dispose();
  });

  it('omits provider-fixed fields while preserving the exact visible OAuth correction set', async () => {
    const rejected = new RpcError(
      'credential_verification_failed',
      'The provider rejected the replacement credentials.',
      422,
      'collection.connection.rotateCredentials',
      {
        verification_status: 'auth_failed',
        existing_credential_preserved: true,
        correction: {
          auth_type: 'oauth2_refresh',
          field_keys: [
            'auth.refresh_token',
            'auth.client_id',
            'auth.client_secret',
            'auth.token_endpoint',
          ],
        },
      },
    );
    const { mount, click, field, getHtml, getFocusedSelector } = mountPanel({
      connections: [connection('hub-oauth', {
        vendor: 'hubspot',
        auth_type: 'oauth2_refresh',
      })],
      runRotateCredentials: async () => { throw rejected; },
    });
    await mount.whenLoaded();

    click({ action: 'connections-edit', kind: 'api', name: 'hub-oauth' });
    field('auth.refresh_token', 'memory-only-refresh');
    field('auth.client_id', 'client-id');
    field('auth.client_secret', 'memory-only-secret');
    click({ action: 'connections-submit-form' });
    await tick();

    expect(mount.getState().dialog.credentialCorrection?.fieldKeys).toEqual([
      'auth.refresh_token',
      'auth.client_id',
      'auth.client_secret',
    ]);
    expect(getHtml()).toContain(
      'Review this credential set together: Refresh Token, OAuth Client ID, OAuth Client Secret.',
    );
    expect(getHtml()).not.toContain('Review Token Endpoint');
    expect(getFocusedSelector()).toBe(fieldSelector('auth.refresh_token'));
    mount.dispose();
  });

  it('fails closed when a mixed-version host has no safe rotation caller', async () => {
    const { mount, click, field, calls } = mountPanel({
      connections: [connection('legacy-server', { base_url: 'https://api.example.com' })],
      runRotateCredentials: null,
    });
    await mount.whenLoaded();

    click({ action: 'connections-edit', kind: 'api', name: 'legacy-server' });
    field('auth.token', 'must-not-reach-update');
    click({ action: 'connections-submit-form' });
    await tick();

    expect(calls.runRotateCredentials).not.toHaveBeenCalled();
    expect(calls.runUpdate).not.toHaveBeenCalled();
    expect(mount.getState().dialog.error).toContain(
      'Your current keys were not changed',
    );
    expect(mount.getState().dialog.stage).toBe('form');
    mount.dispose();
  });

  it('turns an older server unknown-method reply into safe rotation guidance', async () => {
    const unsupported = Object.assign(
      new Error('Unknown rpc method: collection.connection.rotateCredentials'),
      { code: 'unknown_method' },
    );
    const { mount, click, field, calls } = mountPanel({
      connections: [connection('older-server', { base_url: 'https://api.example.com' })],
      runRotateCredentials: async () => { throw unsupported; },
    });
    await mount.whenLoaded();

    click({ action: 'connections-edit', kind: 'api', name: 'older-server' });
    field('auth.token', 'must-not-fall-back-to-update');
    click({ action: 'connections-submit-form' });
    await tick();

    expect(calls.runRotateCredentials).toHaveBeenCalledTimes(1);
    expect(calls.runUpdate).not.toHaveBeenCalled();
    expect(mount.getState().dialog.error).toContain(
      'Recued cannot safely replace keys on this server yet',
    );
    expect(mount.getState().dialog.error).not.toContain('Unknown rpc method');
    expect(mount.getState().dialog.stage).toBe('form');
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
    const tabs = rotationTabs();
    const remaining = [connection('keep')];
    const { mount, click, calls } = mountPanel({
      credentialRotationTabConvergence: tabs.convergence,
      connections: [connection('drop'), connection('keep')],
      runList: vi
        .fn<ConnectionsEnrollListCaller>()
        .mockResolvedValueOnce({
          connections: [connection('drop'), connection('keep')],
          credential_post_safe_stop_verifications: [{
            kind: 'api',
            name: 'drop',
            status: 'pending',
            acknowledged_at: 1,
          }],
        })
        .mockResolvedValueOnce({
          connections: remaining,
          credential_post_safe_stop_verifications: [],
        }),
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
    expect(tabs.notifyPostSafeStopVerificationChanged).toHaveBeenCalledOnce();
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
    expect(getHtml()).toContain('Paste a refresh token in the Refresh Token field');
    expect(getHtml()).not.toContain('refresh token below');
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
    expect(getHtml()).toContain('Checking what Salesforce can do');

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
      'cannot check what Salesforce can do from here',
    );
    expect(getHtml()).toContain('cannot check what Salesforce can do from here');
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
    expect(getHtml()).toContain('Use the server’s Housekeeping settings');
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
  const wireVendorForm = (
    click: (d: Record<string, string>) => void,
    field: (key: string, value: string, tagName?: string) => void,
  ): void => {
    click({ action: 'connections-open-add' });
    click({ action: 'connections-pick-vendor', vendor: 'hubspot' });
    // Past the naming step. `name` / `display_name` joined the readiness
    // checklist (required for the OWNER to finish, even though the authorize
    // call reads neither), so a form left unnamed now blocks on NAMING before it
    // reaches the credential behaviour every test below is about.
    field('name', 'hubspot');
    field('display_name', 'HubSpot');
    // HubSpot defaults to the Service Key path. Exercise the real reachable
    // OAuth control by deliberately choosing the refresh-token flow.
    field('auth.type', 'oauth2_refresh', 'SELECT');
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

    wireVendorForm(click, field);
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

    click({ action: 'connections-back-to-kind' });
    click({ action: 'connections-pick-kind', kind: 'api' });
    field('auth.type', 'oauth2_refresh', 'SELECT');
    const nextDialog = mount.getState().dialog;
    expect(nextDialog.oauthGrantedScopes).toBeNull();
    expect(nextDialog.oauthError).toBeNull();
    expect(nextDialog.oauthErrorFieldKey).toBeNull();
    expect(nextDialog.oauthNeedsReauthorization).toBe(false);
    expect(getHtml()).not.toContain('Granted scopes (1)');
    mount.dispose();
  });

  it('does not consume another row recovery receipt from a same-named create OAuth form', async () => {
    const continuity = rotationContinuity();
    expect(continuity.store.write({
      attemptId: 'rotation-create-oauth-isolation-0001',
      kind: 'api',
      name: 'hubspot',
      baselineUpdatedAt: 88,
    })).toBe('stored');
    expect(continuity.store.markSuccessorObserved(
      'rotation-create-oauth-isolation-0001',
    )).toBe('stored');
    const popup = makeFakePopup();
    const oauthEnv = makeFakeOAuthEnv(popup);
    const sub = makeFakeSubscribe();
    const runStart = vi.fn<ConnectionsStartVendorOAuthCaller>(async () => ({
      authorize_url: 'https://app.hubspot.com/oauth/authorize',
      flow_id: 'flow-create-isolation',
      server_identity_public_key_b64: 'pk-create-isolation',
      claim_secret: 'claim-create-isolation',
    }));
    const runTake = vi.fn<ConnectionsTakeVendorOAuthResultCaller>(async () => ({
      result: {
        refresh_token: 'create-form-token',
        granted_scopes: ['crm.objects.contacts.read'],
      },
    }));
    const { mount, click, field, getHtml } = mountPanel({
      connections: [connection('hubspot', {
        vendor: 'hubspot',
        auth_type: 'oauth2_refresh',
        updated_at: 88,
      })],
      credentialRotationContinuity: continuity.store,
      runCredentialRotationStatus: async () => ({
        outcome: {
          status: 'failed',
          started_at: FIXED_NOW,
          finished_at: FIXED_NOW + 1_000,
          reason: 'server_error',
        },
      }),
      runCredentialRotationActivity: async () => ({
        activity: { status: 'idle' },
      }),
      oauth: { env: oauthEnv.env, subscribe: sub.subscribe, runStart, runTake },
    });
    await mount.whenLoaded();
    expect(mount.getState().credentialRotationRecovery?.phase)
      .toBe('restart_ready');

    wireVendorForm(click, field);
    field('auth.client_id', 'create-client-id');
    field('auth.client_secret', 'create-client-secret');
    click({ action: 'connections-authorize-vendor', vendor: 'hubspot' });
    await flushAsync();
    sub.fire('flow-create-isolation');
    await flushAsync();

    expect(mount.getState().dialog.mode).toBe('create');
    expect(mount.getState().dialog.values['auth.refresh_token'])
      .toBe('create-form-token');
    expect(mount.getState().credentialRotationRecovery?.phase)
      .toBe('restart_ready');
    expect(getHtml()).toContain('Start fresh');
    mount.dispose();
  });

  it('invalidates a returned token when its app binding changes, then accepts a manual replacement', async () => {
    const popup = makeFakePopup();
    const oauthEnv = makeFakeOAuthEnv(popup);
    const sub = makeFakeSubscribe();
    const runStart = vi.fn<ConnectionsStartVendorOAuthCaller>(async () => ({
      authorize_url: 'https://app.hubspot.com/oauth/authorize',
      flow_id: 'flow-binding',
      server_identity_public_key_b64: 'pk',
      claim_secret: 'claim-binding',
    }));
    const runTake = vi.fn<ConnectionsTakeVendorOAuthResultCaller>(async () => ({
      result: {
        refresh_token: 'returned-token',
        granted_scopes: ['crm.objects.contacts.read'],
      },
    }));
    const { mount, click, field, getHtml, getFocusedSelector } = mountPanel({
      connections: [],
      oauth: { env: oauthEnv.env, subscribe: sub.subscribe, runStart, runTake },
    });
    await mount.whenLoaded();

    wireVendorForm(click, field);
    field('auth.client_id', 'original-client-id');
    field('auth.client_secret', 'original-secret');
    click({ action: 'connections-authorize-vendor', vendor: 'hubspot' });
    await flushAsync();
    sub.fire('flow-binding');
    await flushAsync();
    expect(mount.getState().dialog.values['auth.refresh_token']).toBe('returned-token');

    field('auth.client_id', 'replacement-client-id');

    let dialog = mount.getState().dialog;
    expect(dialog.values['auth.client_id']).toBe('replacement-client-id');
    expect(dialog.values['auth.client_secret']).toBe('original-secret');
    expect(dialog.values['auth.refresh_token']).toBe('');
    expect(dialog.oauthGrantedScopes).toBeNull();
    expect(dialog.oauthNeedsReauthorization).toBe(true);
    expect(getFocusedSelector()).toBe(fieldSelector('auth.client_id'));
    expect(getHtml()).toContain('cleared the previous authorization');

    // Further edits keep the one useful explanation instead of flashing it
    // away, and a deliberately pasted replacement becomes the new source.
    field('auth.client_id', 'replacement-client-id-2');
    expect(mount.getState().dialog.oauthNeedsReauthorization).toBe(true);
    expect(getHtml()).toContain('cleared the previous authorization');
    field('auth.refresh_token', 'manual-replacement-token');

    dialog = mount.getState().dialog;
    expect(dialog.values['auth.refresh_token']).toBe('manual-replacement-token');
    expect(dialog.oauthNeedsReauthorization).toBe(false);
    expect(dialog.oauthGrantedScopes).toBeNull();
    expect(getHtml()).not.toContain('cleared the previous authorization');
    expect(getHtml()).toContain('Refresh token ready to save');
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
    field('display_name', 'my-thing');
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
    const { mount, click, field, getFocusedSelector } = mountPanel({
      connections: [],
      oauth: { env: oauthEnv.env, subscribe: sub.subscribe, runStart, runTake },
    });
    await mount.whenLoaded();

    click({ action: 'connections-open-add' });
    click({ action: 'connections-pick-kind', kind: 'api' });
    field('auth.type', 'oauth2_refresh', 'SELECT');
    // Named first — the checklist blocks on naming before endpoints, and this
    // test is about the ENDPOINTS.
    field('name', 'generic');
    field('display_name', 'Generic');
    field('auth.client_id', 'cid'); // but no authorize_url / token_endpoint
    click({ action: 'connections-authorize-vendor' });

    expect(runStart).not.toHaveBeenCalled();
    expect(oauthEnv.env.open).not.toHaveBeenCalled();
    expect(mount.getState().dialog.oauthError).toContain("provider's Token Endpoint");
    expect(mount.getState().dialog.oauthErrorFieldKey).toBe('auth.token_endpoint');
    expect(getFocusedSelector()).toBe(fieldSelector('auth.token_endpoint'));
    mount.dispose();
  });

  it('rejects an unsafe generic endpoint before opening a popup', async () => {
    const popup = makeFakePopup();
    const oauthEnv = makeFakeOAuthEnv(popup);
    const sub = makeFakeSubscribe();
    const runStart = vi.fn<ConnectionsStartVendorOAuthCaller>();
    const { mount, click, field, getFocusedSelector } = mountPanel({
      connections: [],
      oauth: {
        env: oauthEnv.env,
        subscribe: sub.subscribe,
        runStart,
        runTake: vi.fn<ConnectionsTakeVendorOAuthResultCaller>(),
      },
    });
    await mount.whenLoaded();

    click({ action: 'connections-open-add' });
    click({ action: 'connections-pick-kind', kind: 'api' });
    field('auth.type', 'oauth2_refresh', 'SELECT');
    // Named first — see the note above; this test is about an UNSAFE endpoint.
    field('name', 'generic');
    field('display_name', 'Generic');
    field('auth.client_id', 'cid');
    field('auth.token_endpoint', 'http://provider.example/token');
    field('auth.authorize_url', 'https://provider.example/authorize');
    click({ action: 'connections-authorize-vendor' });

    expect(runStart).not.toHaveBeenCalled();
    expect(oauthEnv.env.open).not.toHaveBeenCalled();
    expect(mount.getState().dialog.oauthError).toContain('complete HTTPS URL');
    expect(mount.getState().dialog.oauthErrorFieldKey).toBe('auth.token_endpoint');
    expect(getFocusedSelector()).toBe(fieldSelector('auth.token_endpoint'));
    mount.dispose();
  });

  it('rejects an unsafe generic token endpoint before saving a pasted token', async () => {
    const { mount, click, field, calls } = mountPanel({ connections: [] });
    await mount.whenLoaded();

    click({ action: 'connections-open-add' });
    click({ action: 'connections-pick-kind', kind: 'api' });
    field('auth.type', 'oauth2_refresh', 'SELECT');
    field('name', 'provider');
    field('display_name', 'Provider');
    field('config.base_url', 'https://api.provider.example');
    field('auth.client_id', 'client-id');
    field('auth.refresh_token', 'pasted-token');
    field('auth.token_endpoint', 'http://provider.example/token');
    click({ action: 'connections-submit-form' });
    await tick();

    expect(calls.runEnroll).not.toHaveBeenCalled();
    expect(mount.getState().dialog.error).toContain('complete HTTPS URL');
    expect(mount.getState().dialog.stage).toBe('form');
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

    wireVendorForm(click, field);
    field('auth.client_id', 'cid');
    field('auth.client_secret', 'secret');
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

    wireVendorForm(click, field);
    field('auth.client_id', 'cid');
    field('auth.client_secret', 'secret');
    click({ action: 'connections-authorize-vendor', vendor: 'hubspot' });
    await flushAsync();

    expect(runStart).not.toHaveBeenCalled();
    expect(mount.getState().dialog.oauthError).toContain('browser blocked the pop-up');
    expect(mount.getState().dialog.oauthInFlight).toBe(false);
    mount.dispose();
  });

  it('requires a client_id before opening the popup', async () => {
    const popup = makeFakePopup();
    const oauthEnv = makeFakeOAuthEnv(popup);
    const sub = makeFakeSubscribe();
    const { mount, click, field, getFocusedSelector } = mountPanel({
      connections: [],
      oauth: {
        env: oauthEnv.env,
        subscribe: sub.subscribe,
        runStart: vi.fn<ConnectionsStartVendorOAuthCaller>(),
        runTake: vi.fn<ConnectionsTakeVendorOAuthResultCaller>(),
      },
    });
    await mount.whenLoaded();

    wireVendorForm(click, field);
    click({ action: 'connections-authorize-vendor', vendor: 'hubspot' });

    expect(oauthEnv.env.open).not.toHaveBeenCalled();
    expect(mount.getState().dialog.oauthError).toContain('Client ID');
    expect(mount.getState().dialog.oauthErrorFieldKey).toBe('auth.client_id');
    expect(getFocusedSelector()).toBe(fieldSelector('auth.client_id'));
    mount.dispose();
  });

  it('requires a registered provider secret and clears the stale error on correction', async () => {
    const popup = makeFakePopup();
    const oauthEnv = makeFakeOAuthEnv(popup);
    const sub = makeFakeSubscribe();
    const runStart = vi.fn<ConnectionsStartVendorOAuthCaller>();
    const { mount, click, field, getHtml, getFocusedSelector } = mountPanel({
      connections: [],
      oauth: {
        env: oauthEnv.env,
        subscribe: sub.subscribe,
        runStart,
        runTake: vi.fn<ConnectionsTakeVendorOAuthResultCaller>(),
      },
    });
    await mount.whenLoaded();

    wireVendorForm(click, field);
    field('auth.client_id', 'preserved-client-id');
    expect(getHtml()).toContain('1 required detail left');
    click({ action: 'connections-authorize-vendor', vendor: 'hubspot' });

    expect(runStart).not.toHaveBeenCalled();
    expect(oauthEnv.env.open).not.toHaveBeenCalled();
    expect(mount.getState().dialog.oauthError).toContain('requires the client secret');
    expect(mount.getState().dialog.oauthErrorFieldKey).toBe('auth.client_secret');
    expect(getFocusedSelector()).toBe(fieldSelector('auth.client_secret'));
    expect(mount.getState().dialog.values['auth.client_id']).toBe('preserved-client-id');

    field('auth.scopes', 'crm.objects.contacts.read');
    expect(mount.getState().dialog.oauthError).toContain('requires the client secret');
    expect(mount.getState().dialog.oauthErrorFieldKey).toBe('auth.client_secret');

    field('auth.client_secret', 'corrected-secret');

    expect(mount.getState().dialog.oauthError).toBeNull();
    expect(mount.getState().dialog.oauthErrorFieldKey).toBeNull();
    expect(mount.getState().dialog.values['auth.client_id']).toBe('preserved-client-id');
    expect(mount.getState().dialog.values['auth.client_secret']).toBe('corrected-secret');
    expect(getFocusedSelector()).toBe(fieldSelector('auth.client_secret'));
    expect(getHtml()).toContain('Ready to authorize');
    mount.dispose();
  });

  it('maps a provider rejection to the corrective field without dropping live credentials', async () => {
    const popup = makeFakePopup();
    const oauthEnv = makeFakeOAuthEnv(popup);
    const sub = makeFakeSubscribe();
    const runStart = vi.fn<ConnectionsStartVendorOAuthCaller>(async () => {
      throw new Error('provider requires client_secret');
    });
    const { mount, click, field, getFocusedSelector } = mountPanel({
      connections: [],
      oauth: {
        env: oauthEnv.env,
        subscribe: sub.subscribe,
        runStart,
        runTake: vi.fn<ConnectionsTakeVendorOAuthResultCaller>(),
      },
    });
    await mount.whenLoaded();

    wireVendorForm(click, field);
    field('auth.client_id', 'preserved-client-id');
    field('auth.client_secret', 'preserved-client-secret');
    click({ action: 'connections-authorize-vendor', vendor: 'hubspot' });
    await flushAsync();

    expect(mount.getState().dialog.oauthInFlight).toBe(false);
    expect(mount.getState().dialog.oauthError).toContain('Re-copy the secret');
    expect(mount.getState().dialog.oauthErrorFieldKey).toBe('auth.client_secret');
    expect(getFocusedSelector()).toBe(fieldSelector('auth.client_secret'));
    expect(mount.getState().dialog.values['auth.client_id']).toBe('preserved-client-id');
    expect(mount.getState().dialog.values['auth.client_secret']).toBe('preserved-client-secret');
    expect(popup.close).toHaveBeenCalled();
    mount.dispose();
  });

  it('locks OAuth-captured values and submit while provider authorization is active', async () => {
    const popup = makeFakePopup();
    const oauthEnv = makeFakeOAuthEnv(popup);
    const sub = makeFakeSubscribe();
    const start = deferred<Awaited<ReturnType<ConnectionsStartVendorOAuthCaller>>>();
    const runStart = vi.fn<ConnectionsStartVendorOAuthCaller>(() => start.promise);
    const { mount, click, field, calls, submitBtn } = mountPanel({
      connections: [],
      oauth: {
        env: oauthEnv.env,
        subscribe: sub.subscribe,
        runStart,
        runTake: vi.fn<ConnectionsTakeVendorOAuthResultCaller>(),
      },
    });
    await mount.whenLoaded();

    wireVendorForm(click, field);
    field('auth.client_id', 'captured-client-id');
    field('auth.client_secret', 'captured-client-secret');
    field('auth.scopes', 'scope.one scope.two');
    field('config.base_url', 'https://captured.example');
    click({ action: 'connections-authorize-vendor', vendor: 'hubspot' });
    click({ action: 'connections-authorize-vendor', vendor: 'hubspot' });
    expect(mount.getState().dialog.oauthInFlight).toBe(true);
    expect(oauthEnv.env.open).toHaveBeenCalledTimes(1);
    expect(runStart).toHaveBeenCalledTimes(1);

    field('auth.client_id', 'replacement-client-id');
    field('auth.client_secret', 'replacement-client-secret');
    field('auth.scopes', 'replacement.scope');
    field('config.sandbox', 'true', 'SELECT');
    field('config.base_url', 'https://replacement.example');
    expect(mount.getState().dialog.values['auth.client_id']).toBe('captured-client-id');
    expect(mount.getState().dialog.values['auth.client_secret']).toBe('captured-client-secret');
    expect(mount.getState().dialog.values['auth.scopes']).toBe('scope.one scope.two');
    expect(mount.getState().dialog.values['config.sandbox']).not.toBe('true');
    expect(mount.getState().dialog.values['config.base_url']).toBe('https://captured.example');

    // Unrelated text remains editable, but its cosmetic validity sync must not
    // re-enable a submit carrying an authorization attempt's older values.
    field('display_name', 'HubSpot while authorizing');
    expect(mount.getState().dialog.values['display_name']).toBe('HubSpot while authorizing');
    expect(submitBtn.hasAttribute('disabled')).toBe(true);
    click({ action: 'connections-submit-form' });
    expect(calls.runEnroll).not.toHaveBeenCalled();

    start.resolve({
      authorize_url: 'https://app.hubspot.com/oauth/authorize',
      flow_id: 'flow-locked',
      server_identity_public_key_b64: 'pk',
      claim_secret: 'secret',
    });
    await flushAsync();
    mount.dispose();
  });

  it('does not start provider authorization while Save is committing', async () => {
    const save = deferred<{ connection: ConnectionView; probe?: ConnectionHealth }>();
    const popup = makeFakePopup();
    const oauthEnv = makeFakeOAuthEnv(popup);
    const sub = makeFakeSubscribe();
    const runStart = vi.fn<ConnectionsStartVendorOAuthCaller>();
    const { mount, click, field, calls } = mountPanel({
      connections: [],
      runEnroll: () => save.promise,
      oauth: {
        env: oauthEnv.env,
        subscribe: sub.subscribe,
        runStart,
        runTake: vi.fn<ConnectionsTakeVendorOAuthResultCaller>(),
      },
    });
    await mount.whenLoaded();

    wireVendorForm(click, field);
    field('name', 'hubspot');
    field('display_name', 'HubSpot');
    field('auth.client_id', 'client-id');
    field('auth.client_secret', 'client-secret');
    field('auth.refresh_token', 'manual-token');
    click({ action: 'connections-submit-form' });
    expect(mount.getState().dialog.saving).toBe(true);
    expect(calls.runEnroll).toHaveBeenCalledTimes(1);

    click({ action: 'connections-authorize-vendor', vendor: 'hubspot' });
    expect(oauthEnv.env.open).not.toHaveBeenCalled();
    expect(runStart).not.toHaveBeenCalled();

    save.resolve({ connection: connection('hubspot'), probe: { status: 'unknown' } });
    await tick();
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

    wireVendorForm(click, field);
    field('auth.client_id', 'cid');
    field('auth.client_secret', 'secret');
    click({ action: 'connections-authorize-vendor', vendor: 'hubspot' });
    await flushAsync();

    sub.fire('flow-stale'); // claim starts (pending)
    await flushAsync();
    expect(runTake).toHaveBeenCalledTimes(1);

    // The flow times out before the claim resolves → settled as an error.
    oauthEnv.fireTimers();
    expect(mount.getState().dialog.oauthError).toContain('took too long');
    expect(mount.getState().dialog.oauthInFlight).toBe(false);

    // The slow claim finally resolves — it MUST NOT patch the timed-out dialog.
    claim.resolve({ result: { refresh_token: 'rt-stale', granted_scopes: ['x'] } });
    await flushAsync();
    const dialog = mount.getState().dialog;
    expect(dialog.values['auth.refresh_token'] ?? '').toBe(''); // no stale token
    expect(dialog.oauthError).toContain('took too long'); // error not overwritten
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

    wireVendorForm(click, field);
    field('auth.client_id', 'cid');
    field('auth.client_secret', 'secret');
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

describe('D-223 — a pre-filled box says who filled it', () => {
  const hintingPack = {
    slug: 'acme-tasks',
    installed: true,
    manifest: {
      manifest_version: 2,
      artifact_type: 'pack',
      slug: 'acme-tasks',
      publisher: 'acme-co',
      version: 1,
      connection_hints: [{
        connection: 'acme',
        values: { 'config.base_url': 'https://api.acme.example' },
      }],
      contents: [],
    },
  } as unknown as PackListEntry;

  it('seeds the value, attributes it, and drops the marker once the owner edits', async () => {
    const { mount, click, field, getHtml } = mountPanel({
      connections: [],
      runPacksList: async () => ({ packs: [hintingPack] }),
    });
    await mount.whenLoaded();

    click({ action: 'connections-open-add' });
    click({ action: 'connections-pick-vendor', vendor: 'acme' });

    // Seeded onto a visible, editable field...
    expect(mount.getState().dialog.values['config.base_url']).toBe('https://api.acme.example');
    // ...and attributed, so the owner can tell it apart from something they typed.
    expect(mount.getState().dialog.hintedFields['config.base_url']).toBe('acme-co');
    expect(getHtml()).toContain('Suggested by acme-co');

    // The owner touches the box. It is theirs now.
    field('config.base_url', 'https://acme.internal.example');
    expect(mount.getState().dialog.hintedFields['config.base_url']).toBeUndefined();
    expect(getHtml()).not.toContain('Suggested by acme-co');
    mount.dispose();
  });

  it('clears the marker even when the owner retypes the suggested value', async () => {
    // Keyed on the EDIT, not on the value differing. Retyping the suggestion is
    // still the owner looking at it and deciding — which is all the marker asked
    // for, so it has done its job and should go.
    const { mount, click, field } = mountPanel({
      connections: [],
      runPacksList: async () => ({ packs: [hintingPack] }),
    });
    await mount.whenLoaded();
    click({ action: 'connections-open-add' });
    click({ action: 'connections-pick-vendor', vendor: 'acme' });
    expect(mount.getState().dialog.hintedFields['config.base_url']).toBe('acme-co');

    field('config.base_url', 'https://api.acme.example');
    expect(mount.getState().dialog.hintedFields['config.base_url']).toBeUndefined();
    mount.dispose();
  });

  it('attributes nothing when no pack hints (the permitting case)', async () => {
    const { mount, click, getHtml } = mountPanel({ connections: [] });
    await mount.whenLoaded();
    click({ action: 'connections-open-add' });
    click({ action: 'connections-pick-vendor', vendor: 'acme' });
    expect(mount.getState().dialog.hintedFields).toEqual({});
    expect(getHtml()).not.toContain('Suggested by');
    mount.dispose();
  });
});

describe('R26.2 Option B — a LOOPBACK PWA authorizes without a public server', () => {
  const loopbackEnv = (onMessage: { fire?: (ev: { origin: string; data: unknown }) => void }) => ({
    origin: 'http://127.0.0.1:7841',
    randomState: () => 'nonce',
    onMessage: (h: (ev: { origin: string; data: unknown }) => void) => {
      onMessage.fire = h;
      return () => undefined;
    },
    setTimeout: () => () => undefined,
    setInterval: () => () => undefined,
  });

  it('never calls startVendorOAuth, and exchanges through completeVendorOAuth', async () => {
    const popup = makeFakePopup();
    const oauthEnv = makeFakeOAuthEnv(popup);
    const bus: { fire?: (ev: { origin: string; data: unknown }) => void } = {};
    const runStart = vi.fn();
    const runComplete = vi.fn(async () => ({
      refresh_token: 'RT-loopback',
      granted_scopes: ['Contacts.Read'],
    }));
    const { mount, click, field } = mountPanel({
      connections: [],
      oauth: {
        env: oauthEnv.env,
        runStart: runStart as never,
        runComplete,
        foundationalEnv: loopbackEnv(bus),
      },
    });
    await mount.whenLoaded();

    click({ action: 'connections-open-add' });
    click({ action: 'connections-pick-kind', kind: 'api' });
    field('auth.type', 'oauth2_refresh', 'SELECT');
    field('name', 'ms-contacts');
    field('display_name', 'Outlook Contacts');
    field('auth.client_id', 'cid');
    field('auth.authorize_url', 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
    field('auth.token_endpoint', 'https://login.microsoftonline.com/common/oauth2/v2.0/token');
    field('auth.scopes', 'offline_access Contacts.Read');
    click({ action: 'connections-authorize-vendor' });
    for (let i = 0; i < 6; i += 1) await Promise.resolve();

    // ⛔ The point of the whole change: the rpc that demands a public HTTPS
    // server URL is never reached.
    expect(runStart).not.toHaveBeenCalled();

    // The popup went to the provider with OUR OWN origin as the callback.
    const navigated = String(popup.location.href);
    expect(navigated).toContain('login.microsoftonline.com');
    expect(navigated).toContain(
      encodeURIComponent('http://127.0.0.1:7841/webclient/oauth-callback.html'),
    );
    // No query marker — Entra rejects a query string in a registered redirect.
    expect(navigated).not.toContain('recued_relay');

    // The same-origin relay page hands the code back.
    bus.fire?.({
      origin: 'http://127.0.0.1:7841',
      data: { kind: 'recued:oauth-code', code: 'CODE', state: 'frelay_nonce' },
    });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(runComplete).toHaveBeenCalledTimes(1);
    const calls = runComplete.mock.calls as unknown as readonly (readonly Record<string, unknown>[])[];
    const sent = calls[0]![0]!;
    expect(sent.code).toBe('CODE');
    expect(sent.redirect_uri).toBe('http://127.0.0.1:7841/webclient/oauth-callback.html');
    expect(sent.token_endpoint).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/token');
    // The returned token lands in the form, so Save persists a working connection.
    expect(mount.getState().dialog.values['auth.refresh_token']).toBe('RT-loopback');
    mount.dispose();
  });

  /** The exchange persists NOTHING — the token sits in the draft until Save.
   *  So Cancel here throws away a completed provider consent, and the generic
   *  "credential fields cannot be restored" phrasing reads as "retype your
   *  secret", not "go back through the consent screen". Name the real cost. */
  it('Cancel after a completed consent warns that the authorization itself is discarded', async () => {
    const popup = makeFakePopup();
    const oauthEnv = makeFakeOAuthEnv(popup);
    const bus: { fire?: (ev: { origin: string; data: unknown }) => void } = {};
    const confirmDiscardDraft = vi.fn((_message: string) => false);
    const { mount, click, field } = mountPanel({
      connections: [],
      confirmDiscardDraft,
      oauth: {
        env: oauthEnv.env,
        runStart: vi.fn() as never,
        runComplete: vi.fn(async () => ({
          refresh_token: 'RT-loopback',
          granted_scopes: ['Contacts.Read'],
        })),
        foundationalEnv: loopbackEnv(bus),
      },
    });
    await mount.whenLoaded();

    click({ action: 'connections-open-add' });
    click({ action: 'connections-pick-kind', kind: 'api' });
    field('auth.type', 'oauth2_refresh', 'SELECT');
    field('name', 'ms-contacts');
    field('display_name', 'Outlook Contacts');
    field('auth.client_id', 'cid');
    field('auth.authorize_url', 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
    field('auth.token_endpoint', 'https://login.microsoftonline.com/common/oauth2/v2.0/token');
    field('auth.scopes', 'offline_access Contacts.Read');
    click({ action: 'connections-authorize-vendor' });
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
    bus.fire?.({
      origin: 'http://127.0.0.1:7841',
      data: { kind: 'recued:oauth-code', code: 'CODE', state: 'frelay_nonce' },
    });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(mount.getState().dialog.oauthGrantedScopes).toEqual(['Contacts.Read']);

    click({ action: 'connections-cancel-dialog' });

    expect(confirmDiscardDraft).toHaveBeenCalledOnce();
    const prompt = confirmDiscardDraft.mock.calls[0]![0]!;
    expect(prompt).toMatch(/authorization you just completed/i);
    expect(prompt).toMatch(/authorize with the provider again/i);
    // The prompt is a warning, not a leak — the minted token stays out of it.
    expect(prompt).not.toContain('RT-loopback');
    // Declining keeps the authorization intact.
    expect(mount.getState().dialog.stage).toBe('form');
    expect(mount.getState().dialog.values['auth.refresh_token']).toBe('RT-loopback');
    mount.dispose();
  });

  it('⛔ a NON-loopback origin keeps the cloud path', async () => {
    const popup = makeFakePopup();
    const oauthEnv = makeFakeOAuthEnv(popup);
    const bus: { fire?: (ev: { origin: string; data: unknown }) => void } = {};
    const runStart = vi.fn(async () => { throw new Error('start reached'); });
    const runComplete = vi.fn();
    const { mount, click, field } = mountPanel({
      connections: [],
      oauth: {
        env: oauthEnv.env,
        runStart: runStart as never,
        runComplete: runComplete as never,
        foundationalEnv: { ...loopbackEnv(bus), origin: 'https://app.recued.com' },
      },
    });
    await mount.whenLoaded();
    click({ action: 'connections-open-add' });
    click({ action: 'connections-pick-vendor', vendor: 'hubspot' });
    field('name', 'hubspot');
    field('display_name', 'HubSpot');
    field('auth.type', 'oauth2_refresh', 'SELECT');
    field('auth.client_id', 'cid');
    field('auth.client_secret', 'sec');
    click({ action: 'connections-authorize-vendor', vendor: 'hubspot' });
    await Promise.resolve();
    // Self-serve is loopback-only: every other origin still needs the signed
    // state + a reachable server, and must not silently change behaviour.
    expect(runComplete).not.toHaveBeenCalled();
    mount.dispose();
  });
});
