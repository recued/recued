/** D-201 Slices 5A + 5B2B1 + 5B2B2A + 5B2B2B1 + 5B2B2B2A + 6A + 6B1 + 6B2 + 6B3 + 7B + 7F + 7G + 8F + 8H + 8J + 9BO + 9BP — Settings → Connections → Webhooks.
 *
 * Profile descriptors drive every field and instruction. Secret values exist
 * only in a transient form/credential-write request or a one-time generated
 * response; persisted views expose field names/version metadata but cannot
 * carry the values back.
 */

import {
  MAX_ACTIVE_WEBHOOK_CREDENTIAL_VERSIONS,
  WEBHOOK_OWNER_PROFILE_SETTINGS,
  WEBHOOK_PROFILE_REGISTRY,
  webhookOwnerTextForEnvironment,
  type WebhookDeliveryDetailView,
  type WebhookDeliveryEventGetRequest,
  type WebhookDeliveryEventPayloadView,
  type WebhookDeliveryGetRequest,
  type WebhookDeliveryListCursor,
  type WebhookDeliveryListRequest,
  type WebhookDeliveryListResponse,
  type WebhookDeliveryRetentionPruneRequest,
  type WebhookDeliveryRetentionPruneResponse,
  type WebhookRejectedDeliveryListCursor,
  type WebhookRejectedDeliveryListRequest,
  type WebhookRejectedDeliveryListResponse,
  type WebhookIngressCreateRequest,
  type WebhookIngressCredentialRetireRequest,
  type WebhookIngressCredentialWriteRequest,
  type WebhookIngressCredentialWriteResponse,
  type WebhookIngressDisableRequest,
  type WebhookIngressEnableRequest,
  type WebhookIngressManualConfirmRequest,
  type WebhookIngressRegistrationReconcileRequest,
  type WebhookIngressReadinessBlocker,
  type WebhookIngressRetireRequest,
  type WebhookIngressTestDeliveryRequest,
  type WebhookIngressTestDeliveryResponse,
  type WebhookIngressView,
  type WebhookDeduplicationPolicy,
  type WebhookProfileRuntimeCapabilityView,
  type WebhookOwnerProfileSettings,
  type WebhookProfileDescriptor,
} from '@recued/contracts';

export const WEBHOOKS_PANEL_ATTR = 'data-recued-webhooks-panel';
export const WEBHOOKS_PANEL_NEW_ATTR = 'data-recued-webhooks-new';
export const WEBHOOKS_PANEL_FORM_ATTR = 'data-recued-webhooks-form';
export const WEBHOOKS_PANEL_PROFILE_ATTR = 'data-recued-webhooks-profile';
export const WEBHOOKS_PANEL_ENVIRONMENT_ATTR = 'data-recued-webhooks-environment';
export const WEBHOOKS_PANEL_REGISTRATION_MODE_ATTR = 'data-recued-webhooks-registration-mode';
export const WEBHOOKS_PANEL_PAIRED_CONNECTION_ATTR = 'data-recued-webhooks-paired-connection';
export const WEBHOOKS_PANEL_REGISTRATION_TARGET_KIND_ATTR =
  'data-recued-webhooks-registration-target-kind';
export const WEBHOOKS_PANEL_REGISTRATION_TARGET_KEY_ATTR =
  'data-recued-webhooks-registration-target-key';
export const WEBHOOKS_PANEL_EVENT_TYPE_ATTR = 'data-recued-webhooks-event-type';
export const WEBHOOKS_PANEL_FIELD_ATTR = 'data-recued-webhooks-field';
export const WEBHOOKS_PANEL_CARD_ATTR = 'data-recued-webhooks-card';
export const WEBHOOKS_PANEL_ACTION_ATTR = 'data-recued-webhooks-action';
export const WEBHOOKS_PANEL_ENDPOINT_ATTR = 'data-recued-webhooks-endpoint';
export const WEBHOOKS_PANEL_ERROR_ATTR = 'data-recued-webhooks-error';
export const WEBHOOKS_PANEL_ONE_TIME_ATTR = 'data-recued-webhooks-one-time';
export const WEBHOOKS_PANEL_DELIVERIES_ATTR = 'data-recued-webhooks-deliveries';
export const WEBHOOKS_PANEL_DELIVERY_ATTR = 'data-recued-webhooks-delivery';
export const WEBHOOKS_PANEL_EVENT_ATTR = 'data-recued-webhooks-event';
export const WEBHOOKS_PANEL_PAYLOAD_ATTR = 'data-recued-webhooks-payload';
export const WEBHOOKS_PANEL_REJECTIONS_ATTR = 'data-recued-webhooks-rejections';
export const WEBHOOKS_PANEL_REJECTION_ATTR = 'data-recued-webhooks-rejection';
export const WEBHOOKS_PANEL_RETENTION_ATTR = 'data-recued-webhooks-retention';
export const WEBHOOKS_PANEL_DEDUPLICATION_ATTR = 'data-recued-webhooks-deduplication';
export const WEBHOOKS_PANEL_TEST_ATTR = 'data-recued-webhooks-test-delivery';
export const WEBHOOKS_PANEL_REBIND_ATTR = 'data-recued-webhooks-connection-rebind';

export const WEBHOOKS_PANEL_STYLES = `
[${WEBHOOKS_PANEL_ATTR}] { display: grid; gap: 14px; }
[${WEBHOOKS_PANEL_ATTR}] .wh-head { display:flex; gap:12px; align-items:center; justify-content:space-between; }
[${WEBHOOKS_PANEL_ATTR}] .wh-head h2 { margin:0; font-size:18px; }
[${WEBHOOKS_PANEL_ATTR}] .wh-copy { margin:3px 0 0; color:var(--muted); font-size:13px; line-height:1.45; }
[${WEBHOOKS_PANEL_ATTR}] .wh-actions { display:flex; flex-wrap:wrap; gap:8px; }
[${WEBHOOKS_PANEL_ATTR}] button { box-sizing:border-box; min-height:36px; border:1px solid var(--border); border-radius:7px; padding:7px 10px; background:var(--surface); color:var(--fg); cursor:pointer; }
[${WEBHOOKS_PANEL_ATTR}] button.wh-primary { background:var(--accent); border-color:var(--accent); color:white; }
[${WEBHOOKS_PANEL_ATTR}] button:disabled { opacity:.5; cursor:not-allowed; }
[${WEBHOOKS_PANEL_ATTR}] button[aria-disabled="true"] { opacity:.5; cursor:progress; }
[${WEBHOOKS_PANEL_ATTR}] form, [${WEBHOOKS_PANEL_CARD_ATTR}] { border:1px solid var(--border); border-radius:10px; padding:14px; background:var(--surface); }
[${WEBHOOKS_PANEL_ATTR}] form { display:grid; gap:12px; }
[${WEBHOOKS_PANEL_ATTR}] label { display:grid; gap:5px; font-size:12px; font-weight:600; color:var(--muted); }
[${WEBHOOKS_PANEL_ATTR}] input, [${WEBHOOKS_PANEL_ATTR}] select { box-sizing:border-box; width:100%; border:1px solid var(--border); border-radius:7px; padding:8px; background:var(--surface-sunk); color:var(--fg); }
[${WEBHOOKS_PANEL_ATTR}] .wh-event-types { border:1px solid var(--border); border-radius:7px; padding:10px; display:grid; gap:7px; }
[${WEBHOOKS_PANEL_ATTR}] .wh-event-types legend { padding:0 5px; color:var(--muted); font-size:12px; font-weight:600; }
[${WEBHOOKS_PANEL_ATTR}] .wh-event-types label { display:flex; align-items:center; gap:7px; font-weight:400; overflow-wrap:anywhere; }
[${WEBHOOKS_PANEL_ATTR}] .wh-event-types input { width:auto; }
[${WEBHOOKS_PANEL_ATTR}] .wh-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(210px,1fr)); gap:10px; }
[${WEBHOOKS_PANEL_CARD_ATTR}] { display:grid; gap:11px; }
[${WEBHOOKS_PANEL_ATTR}] .wh-card-head { display:flex; gap:10px; justify-content:space-between; align-items:flex-start; }
[${WEBHOOKS_PANEL_ATTR}] .wh-card-head h3 { margin:0; font-size:15px; }
[${WEBHOOKS_PANEL_ATTR}] .wh-pill { border:1px solid var(--border); border-radius:999px; padding:3px 7px; font-size:11px; color:var(--muted); }
[${WEBHOOKS_PANEL_ATTR}] dl { display:grid; grid-template-columns:max-content 1fr; gap:5px 12px; margin:0; font-size:12px; }
[${WEBHOOKS_PANEL_ATTR}] dt { color:var(--muted); }
[${WEBHOOKS_PANEL_ATTR}] dd { margin:0; min-width:0; overflow-wrap:anywhere; }
[${WEBHOOKS_PANEL_ENDPOINT_ATTR}] { display:block; padding:8px; border-radius:7px; background:var(--surface-sunk); overflow-wrap:anywhere; user-select:all; font-size:12px; }
[${WEBHOOKS_PANEL_ATTR}] .wh-note { margin:0; border-left:3px solid var(--accent); padding:8px 10px; background:var(--surface-sunk); font-size:12px; line-height:1.45; }
[${WEBHOOKS_PANEL_ERROR_ATTR}] { border:1px solid var(--danger,#b44); border-radius:7px; padding:9px; color:var(--danger,#b44); font-size:12px; }
[${WEBHOOKS_PANEL_ONE_TIME_ATTR}] { border:1px solid var(--warning,#b87b00); border-radius:7px; padding:10px; background:var(--surface-sunk); font-size:12px; }
[${WEBHOOKS_PANEL_ONE_TIME_ATTR}] code { display:block; margin-top:5px; overflow-wrap:anywhere; user-select:all; }
[${WEBHOOKS_PANEL_DELIVERIES_ATTR}] { display:grid; gap:9px; border-top:1px solid var(--border); padding-top:10px; }
[${WEBHOOKS_PANEL_REJECTIONS_ATTR}] { display:grid; gap:9px; border-top:1px solid var(--border); padding-top:10px; }
[${WEBHOOKS_PANEL_DELIVERY_ATTR}], [${WEBHOOKS_PANEL_EVENT_ATTR}], [${WEBHOOKS_PANEL_REJECTION_ATTR}] { border:1px solid var(--border); border-radius:7px; padding:9px; display:grid; gap:7px; background:var(--surface-sunk); }
[${WEBHOOKS_PANEL_PAYLOAD_ATTR}] { margin:0; padding:9px; border-radius:7px; overflow:auto; max-height:320px; white-space:pre-wrap; overflow-wrap:anywhere; background:var(--surface); font-size:11px; }
[${WEBHOOKS_PANEL_ATTR}] .wh-empty { padding:20px; border:1px dashed var(--border-strong); border-radius:9px; text-align:center; color:var(--muted); font-size:13px; }
`;

export type WebhooksListCaller = () => Promise<{
  ingresses: readonly WebhookIngressView[];
  /** Optional only for rolling client/server compatibility. Absence exposes no
   * create or managed-registration authority. Production always projects it. */
  profiles?: readonly WebhookProfileRuntimeCapabilityView[];
}>;
export type WebhooksCreateCaller = (
  args: WebhookIngressCreateRequest,
) => Promise<{ ingress: WebhookIngressView }>;
export type WebhooksCredentialWriteCaller = (
  args: WebhookIngressCredentialWriteRequest,
) => Promise<WebhookIngressCredentialWriteResponse>;
export type WebhooksCredentialRetireCaller = (
  args: WebhookIngressCredentialRetireRequest,
) => Promise<{ ingress: WebhookIngressView }>;
export type WebhooksManualConfirmCaller = (
  args: WebhookIngressManualConfirmRequest,
) => Promise<{ ingress: WebhookIngressView }>;
export type WebhooksRegistrationReconcileCaller = (
  args: WebhookIngressRegistrationReconcileRequest,
) => Promise<{ ingress: WebhookIngressView }>;
export type WebhooksEnableCaller = (
  args: WebhookIngressEnableRequest,
) => Promise<{ ingress: WebhookIngressView }>;
export type WebhooksDisableCaller = (
  args: WebhookIngressDisableRequest,
) => Promise<{ ingress: WebhookIngressView }>;
export type WebhooksRetireCaller = (
  args: WebhookIngressRetireRequest,
) => Promise<{ ingress: WebhookIngressView }>;
export type WebhooksTestDeliveryCaller = (
  args: WebhookIngressTestDeliveryRequest,
) => Promise<WebhookIngressTestDeliveryResponse>;
export type WebhooksRetentionPruneCaller = (
  args: WebhookDeliveryRetentionPruneRequest,
) => Promise<WebhookDeliveryRetentionPruneResponse>;
export type WebhooksDeliveryListCaller = (
  args: WebhookDeliveryListRequest,
) => Promise<WebhookDeliveryListResponse>;
export type WebhooksDeliveryGetCaller = (
  args: WebhookDeliveryGetRequest,
) => Promise<{ detail: WebhookDeliveryDetailView }>;
export type WebhooksDeliveryEventGetCaller = (
  args: WebhookDeliveryEventGetRequest,
) => Promise<{ event: WebhookDeliveryEventPayloadView }>;
export type WebhooksRejectedDeliveryListCaller = (
  args: WebhookRejectedDeliveryListRequest,
) => Promise<WebhookRejectedDeliveryListResponse>;

export interface WebhooksPanelOptions {
  host: HTMLElement;
  document?: Document;
  runList: WebhooksListCaller;
  runCreate: WebhooksCreateCaller;
  runCredentialWrite: WebhooksCredentialWriteCaller;
  runCredentialRetire: WebhooksCredentialRetireCaller;
  runManualConfirm: WebhooksManualConfirmCaller;
  runRegistrationReconcile?: WebhooksRegistrationReconcileCaller;
  runEnable: WebhooksEnableCaller;
  runDisable: WebhooksDisableCaller;
  runTestDelivery?: WebhooksTestDeliveryCaller;
  runRetire?: WebhooksRetireCaller;
  runRetentionPrune?: WebhooksRetentionPruneCaller;
  runDeliveryList?: WebhooksDeliveryListCaller;
  runDeliveryGet?: WebhooksDeliveryGetCaller;
  runDeliveryEventGet?: WebhooksDeliveryEventGetCaller;
  runRejectedDeliveryList?: WebhooksRejectedDeliveryListCaller;
}

export interface WebhooksPanelMount {
  refresh(): Promise<void>;
  whenLoaded(): Promise<void>;
  getLoadError(): string | null;
  hasInFlightWork(): boolean;
  dispose(): void;
}

interface DeliveryInspectorState {
  ingress_id: string;
  deliveries: Array<WebhookDeliveryListResponse['deliveries'][number]>;
  next_cursor: WebhookDeliveryListCursor | null;
  detail: WebhookDeliveryDetailView | null;
  payloads: Map<string, WebhookDeliveryEventPayloadView>;
}

interface RejectionInspectorState {
  ingress_id: string;
  rejections: Array<WebhookRejectedDeliveryListResponse['rejections'][number]>;
  next_cursor: WebhookRejectedDeliveryListCursor | null;
  loaded: boolean;
}

const blockerLabel: Record<WebhookIngressReadinessBlocker, string> = {
  credentials_incomplete: 'Add all the keys it needs',
  credential_shape_invalid: 'Replace or retire the keys that are wrong',
  registration_incomplete: 'Say you have set it up at the other service',
  registration_endpoint_changed: 'Update the one true address, then say so again',
  event_selection_empty: 'Pick at least one event',
  profile_runtime_unavailable: 'This server does not know how to talk to that service',
  paired_connection_unavailable: 'Bring back, or pick, the Connection it needs',
  paired_connection_rebind_required: 'Show it is still the same account, then link it up again',
  listener_unavailable: 'The part that listens for webhooks is not running',
  public_url_unavailable: 'Your server needs a public https address for webhooks. See Settings → Server → Hostnames',
  public_reachability_disabled: 'Switch on RECUED_PUBLIC_REACHABLE',
  tls_unavailable: 'You need a trusted public https address',
  clock_unverified: 'Recued has not checked that your clock is right',
  vault_locked: 'Unlock your server’s keys',
  server_paused: 'Start the paused server again',
  retired: 'This webhook is closed for good',
};

const errorText = (error: unknown): string => error instanceof Error
  ? error.message
  : 'That did not work';

const clear = (element: HTMLElement): void => {
  while (element.firstChild) element.removeChild(element.firstChild);
};

const button = (
  doc: Document,
  label: string,
  action: string,
  primary = false,
): HTMLButtonElement => {
  const value = doc.createElement('button');
  value.type = 'button';
  value.textContent = label;
  value.setAttribute(WEBHOOKS_PANEL_ACTION_ATTR, action);
  if (primary) value.className = 'wh-primary';
  return value;
};

const descriptorFor = (profileId: string): WebhookProfileDescriptor | null =>
  Object.prototype.hasOwnProperty.call(WEBHOOK_PROFILE_REGISTRY, profileId)
    ? WEBHOOK_PROFILE_REGISTRY[profileId as keyof typeof WEBHOOK_PROFILE_REGISTRY]
    : null;

const ownerSettingsFor = (
  profile: WebhookProfileDescriptor,
): WebhookOwnerProfileSettings => WEBHOOK_OWNER_PROFILE_SETTINGS[profile.profile_id];

const formatExactDuration = (milliseconds: number): string => {
  const units = [
    ['day', 24 * 60 * 60 * 1_000],
    ['hour', 60 * 60 * 1_000],
    ['minute', 60 * 1_000],
    ['second', 1_000],
  ] as const;
  for (const [label, size] of units) {
    if (milliseconds % size !== 0) continue;
    const value = milliseconds / size;
    return `${value} ${label}${value === 1 ? '' : 's'}`;
  }
  return `${milliseconds} ms`;
};

const sameDeduplicationPolicy = (
  value: unknown,
  expected: WebhookDeduplicationPolicy,
): boolean => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).sort().join(',') !== 'identity,tombstone_horizon_ms') {
    return false;
  }
  if (candidate.tombstone_horizon_ms !== expected.tombstone_horizon_ms) return false;
  const identityValue = candidate.identity;
  if (identityValue === null
    || typeof identityValue !== 'object'
    || Array.isArray(identityValue)) return false;
  const identity = identityValue as Record<string, unknown>;
  if (identity.kind !== expected.identity.kind) return false;
  switch (expected.identity.kind) {
    case 'received_at_body_window':
      return Object.keys(identity).sort().join(',') === 'kind,window_ms'
        && identity.window_ms === expected.identity.window_ms;
    case 'stable_provider_id':
    case 'stable_provider_id_or_signed_timestamp_body':
    case 'signed_timestamp_body':
      return Object.keys(identity).join(',') === 'kind';
  }
  const exhaustive: never = expected.identity;
  return exhaustive;
};

const deduplicationDisclosure = (
  policy: WebhookDeduplicationPolicy,
): string => {
  const horizon = formatExactDuration(policy.tombstone_horizon_ms);
  switch (policy.identity.kind) {
    case 'received_at_body_window': {
      const window = formatExactDuration(policy.identity.window_ms);
      return `Recued tells them apart by when they arrived, in ${window} blocks, and by exactly what was sent. A retry that lands in the next block counts as new. Recued remembers ones it has seen for at least ${horizon}.`;
    }
    case 'signed_timestamp_body':
      return `Recued tells them apart by the signed time and exactly what was sent. A retry signed at a new time counts as new. Recued remembers ones it has seen for at least ${horizon}.`;
    case 'stable_provider_id_or_signed_timestamp_body':
      return `Recued uses the id the service gives each one. If there is none, it uses the signed time and exactly what was sent, so a retry signed at a new time counts as new. Recued remembers ones it has seen for at least ${horizon}. That is how long Recued goes back — it is not a promise about how long the sender keeps trying.`;
    case 'stable_provider_id':
      return `Recued remembers ids it has already seen for at least ${horizon}. That is how long Recued goes back — it is not a promise about how long the sender keeps trying.`;
  }
  const exhaustive: never = policy.identity;
  return exhaustive;
};

const formatOwnerText = (
  template: string,
  ingress?: WebhookIngressView,
): string => {
  const values: Readonly<Record<string, string>> = {
    events: ingress?.selected_event_types.join(', ') ?? 'the events you picked',
    environment: ingress?.environment ?? 'the one you picked',
    target_kind: ingress?.registration_target?.kind ?? 'where it goes at the service',
    target_key: ingress?.registration_target?.key ?? '',
  };
  return Object.entries(values).reduce(
    (text, [key, value]) => text.replaceAll(`{{${key}}}`, value),
    template,
  );
};

export const mountWebhooksPanel = (
  options: WebhooksPanelOptions,
): WebhooksPanelMount => {
  const doc = options.document ?? (globalThis as { document?: Document }).document;
  if (!doc) throw new Error('mountWebhooksPanel: no document available');

  const root = doc.createElement('section');
  root.setAttribute(WEBHOOKS_PANEL_ATTR, '');
  options.host.appendChild(root);

  let disposed = false;
  let busy = false;
  let mutationInFlight = false;
  let refreshInFlight: Promise<void> | null = null;
  let showCreate = false;
  let credentialIngressId: string | null = null;
  let ingresses: WebhookIngressView[] = [];
  let profileCapabilities: WebhookProfileRuntimeCapabilityView[] = [];
  let error: string | null = null;
  let oneTime: {
    ingress_id: string;
    credentials: Readonly<Record<string, string>>;
  } | null = null;
  let retentionNotice: {
    ingress_id: string;
    result: WebhookDeliveryRetentionPruneResponse['result'];
  } | null = null;
  let testDeliveryNotice: {
    ingress_id: string;
    delivery_id: string;
    observed_at: number;
  } | null = null;
  let retirementConfirmIngressId: string | null = null;
  let connectionRebindIngressId: string | null = null;
  let deliveryInspector: DeliveryInspectorState | null = null;
  let rejectionInspector: RejectionInspectorState | null = null;
  let pendingActionFocus: {
    ingress_id: string | null;
    action: string;
    label: string;
    item_id: string | null;
  } | null = null;
  let pendingCompletionFocus: {
    kind: 'card-title';
    ingress_id: string;
  } | {
    kind: 'panel-title';
  } | null = null;

  /** The panel repaints every card around an authority-bearing read/write. Keep
   *  the initiating control as a logical focus owner across both the busy and
   *  settled paints; otherwise Chromium drops focus to `<body>` the moment the
   *  old card is removed. */
  const rememberActionFocus = (fallback?: HTMLElement): void => {
    const focused = doc.activeElement as HTMLElement | null | undefined;
    const active = focused !== null
      && focused !== undefined
      && root.contains(focused)
      && focused.getAttribute?.(WEBHOOKS_PANEL_ACTION_ATTR) !== null
      ? focused
      : fallback;
    if (active === undefined || !root.contains(active)) return;
    const action = active.getAttribute?.(WEBHOOKS_PANEL_ACTION_ATTR) ?? null;
    if (action === null) return;
    let owner: HTMLElement | null = active;
    while (
      owner !== null
      && owner !== root
      && owner.getAttribute?.(WEBHOOKS_PANEL_CARD_ATTR) === null
    ) {
      owner = owner.parentElement ?? null;
    }
    if (owner === null) return;
    const ingressId = owner === root
      ? null
      : owner.getAttribute?.(WEBHOOKS_PANEL_CARD_ATTR) ?? null;
    if (owner !== root && ingressId === null) return;
    let itemOwner: HTMLElement | null = active;
    let itemId: string | null = null;
    while (itemOwner !== null && itemOwner !== owner) {
      itemId = itemOwner.getAttribute?.(WEBHOOKS_PANEL_EVENT_ATTR)
        ?? itemOwner.getAttribute?.(WEBHOOKS_PANEL_DELIVERY_ATTR)
        ?? null;
      if (itemId !== null) break;
      itemOwner = itemOwner.parentElement ?? null;
    }
    pendingActionFocus = {
      ingress_id: ingressId,
      action,
      label: active.textContent?.trim() ?? '',
      item_id: itemId,
    };
  };

  const findDescendant = (
    start: HTMLElement,
    predicate: (element: HTMLElement) => boolean,
  ): HTMLElement | null => {
    if (predicate(start)) return start;
    for (const child of Array.from(start.children)) {
      const hit = findDescendant(child as HTMLElement, predicate);
      if (hit !== null) return hit;
    }
    return null;
  };

  const contextualizeCardActions = (
    start: HTMLElement,
    ingress: WebhookIngressView,
  ): void => {
    if (
      start.tagName === 'BUTTON'
      && start.getAttribute?.(WEBHOOKS_PANEL_ACTION_ATTR) !== null
      && !start.hasAttribute('aria-label')
    ) {
      const label = start.textContent?.trim() ?? '';
      if (label !== '') {
        start.setAttribute(
          'aria-label',
          `${label} for ${ingress.display_name} (${ingress.ingress_id})`,
        );
      }
    }
    for (const child of Array.from(start.children)) {
      contextualizeCardActions(child as HTMLElement, ingress);
    }
  };

  const restoreActionFocus = (): void => {
    const pending = pendingActionFocus;
    if (pending === null) return;
    const card = pending.ingress_id === null
      ? null
      : findDescendant(root, (element) =>
          element.getAttribute?.(WEBHOOKS_PANEL_CARD_ATTR) === pending.ingress_id);
    const focusScope = pending.ingress_id === null ? root : card;
    const successors: Readonly<Record<string, string>> = {
      enable: 'disable',
      disable: 'enable',
      'manual-confirm': 'enable',
      'delivery-open': 'deliveries-back',
      'credential-save': 'credentials',
      'connection-rebind-confirm': 'connection-rebind',
    };
    const actions = [pending.action, successors[pending.action]]
      .filter((action): action is string => action !== undefined);
    let candidate: HTMLButtonElement | null = null;
    for (const action of actions) {
      const itemScope = action === pending.action
        && pending.item_id !== null
        && focusScope !== null
        ? findDescendant(focusScope, (element) =>
            element.getAttribute?.(WEBHOOKS_PANEL_EVENT_ATTR) === pending.item_id
            || element.getAttribute?.(WEBHOOKS_PANEL_DELIVERY_ATTR) === pending.item_id)
        : null;
      const actionScope = itemScope ?? focusScope;
      candidate = actionScope === null ? null : findDescendant(actionScope, (element) =>
        element.tagName === 'BUTTON'
        && element.getAttribute?.(WEBHOOKS_PANEL_ACTION_ATTR) === action
        && (action !== pending.action
          || pending.label === ''
          || element.textContent?.trim() === pending.label)) as HTMLButtonElement | null;
      if (candidate !== null) break;
      candidate = actionScope === null ? null : findDescendant(actionScope, (element) =>
        element.tagName === 'BUTTON'
        && element.getAttribute?.(WEBHOOKS_PANEL_ACTION_ATTR) === action) as HTMLButtonElement | null;
      if (candidate !== null) break;
    }
    if (
      candidate === null
      && pending.action === 'event-open'
      && pending.item_id !== null
    ) {
      const payload = card === null ? null : findDescendant(card, (element) =>
        element.getAttribute?.(WEBHOOKS_PANEL_PAYLOAD_ATTR) === pending.item_id);
      if (payload !== null) {
        payload.focus?.({ preventScroll: true });
        pendingActionFocus = null;
        return;
      }
    }
    if (!busy && pendingCompletionFocus !== null) {
      const destination = pendingCompletionFocus;
      const destinationCard = destination.kind === 'card-title'
        ? findDescendant(root, (element) =>
            element.getAttribute?.(WEBHOOKS_PANEL_CARD_ATTR) === destination.ingress_id)
        : null;
      const destinationTarget = destinationCard === null
        ? findDescendant(root, (element) => element.tagName === 'H2')
        : findDescendant(destinationCard, (element) => element.tagName === 'H3');
      destinationTarget?.focus?.({ preventScroll: true });
      pendingActionFocus = null;
      pendingCompletionFocus = null;
      return;
    }
    if (candidate === null) {
      if (!busy) {
        const title = card === null
          ? findDescendant(root, (element) => element.tagName === 'H2')
          : findDescendant(card, (element) => element.tagName === 'H3');
        title?.focus?.({ preventScroll: true });
        pendingActionFocus = null;
      }
      return;
    }
    if (busy && candidate.disabled) {
      // Native-disabled buttons cannot own focus. Keep only the initiating
      // action focusable, announce its busy state, and intercept duplicate
      // activation before the action's ordinary listener can mutate local UI.
      candidate.disabled = false;
      candidate.setAttribute('aria-disabled', 'true');
      candidate.setAttribute('aria-busy', 'true');
      candidate.addEventListener('click', (event) => {
        if (!busy) return;
        event.preventDefault();
        event.stopImmediatePropagation();
      }, { capture: true });
    }
    candidate.focus({ preventScroll: true });
    if (!busy) pendingActionFocus = null;
  };

  const focusRendered = (
    start: HTMLElement,
    predicate: (element: HTMLElement) => boolean,
  ): void => {
    findDescendant(start, predicate)?.focus?.({ preventScroll: true });
  };

  const renderedCard = (ingressId: string): HTMLElement | null =>
    findDescendant(root, (element) =>
      element.getAttribute?.(WEBHOOKS_PANEL_CARD_ATTR) === ingressId);

  const focusCardAction = (ingressId: string, action: string): void => {
    const card = renderedCard(ingressId);
    if (card === null) return;
    focusRendered(card, (element) =>
      element.getAttribute?.(WEBHOOKS_PANEL_ACTION_ATTR) === action);
  };

  const focusCardItemAction = (
    ingressId: string,
    itemAttribute: string,
    itemId: string,
    action: string,
  ): void => {
    const card = renderedCard(ingressId);
    if (card === null) return;
    const item = findDescendant(card, (element) =>
      element.getAttribute?.(itemAttribute) === itemId);
    if (item === null) return;
    focusRendered(item, (element) =>
      element.getAttribute?.(WEBHOOKS_PANEL_ACTION_ATTR) === action);
  };

  const applyListResult = (result: Awaited<ReturnType<WebhooksListCaller>>): void => {
    ingresses = [...result.ingresses];
    const seen = new Set<string>();
    profileCapabilities = [];
    for (const capability of result.profiles ?? []) {
      const profile = descriptorFor(capability.profile_id);
      if (!profile
        || seen.has(profile.profile_id)
        || !Array.isArray(capability.registration_modes)
        || !sameDeduplicationPolicy(
          (capability as { deduplication?: unknown }).deduplication,
          profile.deduplication,
        )) continue;
      const registrationModes = capability.registration_modes.filter(
        (mode, index, modes) => profile.registration_modes.includes(mode)
          && modes.indexOf(mode) === index,
      );
      if (registrationModes.length === 0) continue;
      seen.add(profile.profile_id);
      profileCapabilities.push({
        profile_id: profile.profile_id,
        registration_modes: registrationModes,
        deduplication: profile.deduplication,
      });
    }
  };

  const capabilityFor = (
    profileId: WebhookIngressView['profile_id'],
  ): WebhookProfileRuntimeCapabilityView | null =>
    profileCapabilities.find((candidate) => candidate.profile_id === profileId) ?? null;

  const availableRegistrationModes = (
    profileId: WebhookIngressView['profile_id'],
  ): readonly WebhookIngressCreateRequest['registration_mode'][] =>
    (capabilityFor(profileId)?.registration_modes ?? []).filter(
      (mode) => mode !== 'managed_endpoint'
        || options.runRegistrationReconcile !== undefined,
    );

  const createProfiles = (): WebhookProfileDescriptor[] => profileCapabilities
    .filter((capability) => availableRegistrationModes(capability.profile_id).length > 0)
    .map((capability) => descriptorFor(capability.profile_id))
    .filter((profile): profile is WebhookProfileDescriptor => profile !== null);

  const mutate = async (operation: () => Promise<unknown>): Promise<void> => {
    if (busy || disposed) return;
    rememberActionFocus();
    pendingCompletionFocus = null;
    busy = true;
    mutationInFlight = true;
    error = null;
    render();
    try {
      await operation();
    } catch (cause) {
      if (!disposed) error = errorText(cause);
    }
    // A multi-step mutation can partially commit (for example, ingress create
    // succeeds but the encrypted credential write fails). Always refresh so
    // the repairable draft remains visible instead of becoming a hidden orphan.
    if (!disposed) {
      try {
        const listed = await options.runList();
        if (!disposed) applyListResult(listed);
      } catch (cause) {
        if (!disposed) {
          // The projection is live server authority, not a cacheable catalog.
          // A failed relist must not leave creation or mutation controls backed
          // by a capability set the server can no longer confirm.
          profileCapabilities = [];
          if (error === null) error = errorText(cause);
        }
      }
    }
    busy = false;
    mutationInFlight = false;
    if (!disposed) render();
  };

  const inspect = async (operation: () => Promise<unknown>): Promise<void> => {
    if (busy || disposed) return;
    rememberActionFocus();
    busy = true;
    error = null;
    render();
    try {
      await operation();
    } catch (cause) {
      if (!disposed) error = errorText(cause);
    } finally {
      busy = false;
      if (!disposed) render();
    }
  };

  const canInspectDeliveries = options.runDeliveryList !== undefined
    && options.runDeliveryGet !== undefined
    && options.runDeliveryEventGet !== undefined;
  const canInspectRejections = options.runRejectedDeliveryList !== undefined;

  const loadDeliveries = (
    ingressId: string,
    cursor?: WebhookDeliveryListCursor,
  ): void => {
    if (!canInspectDeliveries) return;
    void inspect(async () => {
      const response = await options.runDeliveryList!({
        ingress_id: ingressId,
        limit: 10,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      if (deliveryInspector?.ingress_id !== ingressId) return;
      const deliveries = cursor === undefined
        ? [...response.deliveries]
        : [...deliveryInspector.deliveries, ...response.deliveries];
      deliveryInspector = {
        ...deliveryInspector,
        deliveries: [...new Map(deliveries.map((item) => [
          item.delivery_id,
          item,
        ])).values()],
        next_cursor: response.next_cursor,
      };
    });
  };

  const loadDeliveryDetail = (ingressId: string, deliveryId: string): void => {
    if (!canInspectDeliveries) return;
    void inspect(async () => {
      const response = await options.runDeliveryGet!({
        ingress_id: ingressId,
        delivery_id: deliveryId,
      });
      if (deliveryInspector?.ingress_id !== ingressId) return;
      deliveryInspector = {
        ...deliveryInspector,
        detail: response.detail,
        payloads: new Map(),
      };
    });
  };

  const loadDeliveryEvent = (
    ingressId: string,
    deliveryId: string,
    eventId: string,
  ): void => {
    if (!canInspectDeliveries) return;
    void inspect(async () => {
      const response = await options.runDeliveryEventGet!({
        ingress_id: ingressId,
        delivery_id: deliveryId,
        event_id: eventId,
      });
      if (deliveryInspector?.ingress_id !== ingressId
        || deliveryInspector.detail?.delivery.delivery_id !== deliveryId) return;
      const payloads = new Map(deliveryInspector.payloads);
      payloads.set(eventId, response.event);
      deliveryInspector = { ...deliveryInspector, payloads };
    });
  };

  const loadRejectedDeliveries = (
    ingressId: string,
    cursor?: WebhookRejectedDeliveryListCursor,
  ): void => {
    if (!canInspectRejections) return;
    void inspect(async () => {
      const response = await options.runRejectedDeliveryList!({
        ingress_id: ingressId,
        limit: 10,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      if (rejectionInspector?.ingress_id !== ingressId) return;
      const rejections = cursor === undefined
        ? [...response.rejections]
        : [...rejectionInspector.rejections, ...response.rejections];
      rejectionInspector = {
        ...rejectionInspector,
        rejections: [...new Map(rejections.map((item) => [
          item.rejection_id,
          item,
        ])).values()],
        next_cursor: response.next_cursor,
        loaded: true,
      };
    });
  };

  const inspectorView = (ingress: WebhookIngressView): HTMLElement => {
    const inspector = doc.createElement('section');
    inspector.setAttribute(WEBHOOKS_PANEL_DELIVERIES_ATTR, ingress.ingress_id);
    const state = deliveryInspector?.ingress_id === ingress.ingress_id
      ? deliveryInspector
      : null;

    const head = doc.createElement('div');
    head.className = 'wh-card-head';
    const title = doc.createElement('strong');
    title.textContent = state?.detail === null
      ? 'Messages that got through'
      : 'About this message';
    head.appendChild(title);
    const close = button(doc, 'Close', 'deliveries-close');
    close.disabled = busy;
    close.addEventListener('click', () => {
      deliveryInspector = null;
      render();
      focusCardAction(ingress.ingress_id, 'deliveries');
    });
    head.appendChild(close);
    inspector.appendChild(head);

    const boundary = doc.createElement('p');
    boundary.className = 'wh-copy';
    boundary.textContent = 'Only messages that got through. Ones that failed the check, or were turned away, are not here.';
    inspector.appendChild(boundary);

    if (state === null || (busy && state.deliveries.length === 0)) {
      const loading = doc.createElement('p');
      loading.className = 'wh-copy';
      loading.textContent = 'Loading the messages that got through…';
      inspector.appendChild(loading);
      return inspector;
    }

    const appendRow = (list: HTMLDListElement, label: string, value: string): void => {
      const term = doc.createElement('dt');
      term.textContent = label;
      const description = doc.createElement('dd');
      description.textContent = value;
      list.appendChild(term);
      list.appendChild(description);
    };
    const timestamp = (value: number | null): string => value === null
      ? 'Not given'
      : new Date(value).toLocaleString();

    if (state.detail !== null) {
      const inspectedDeliveryId = state.detail.delivery.delivery_id;
      const back = button(doc, 'Back to the messages', 'deliveries-back');
      back.disabled = busy;
      back.addEventListener('click', () => {
        if (deliveryInspector?.ingress_id !== ingress.ingress_id) return;
        deliveryInspector = {
          ...deliveryInspector,
          detail: null,
          payloads: new Map(),
        };
        render();
        focusCardItemAction(
          ingress.ingress_id,
          WEBHOOKS_PANEL_DELIVERY_ATTR,
          inspectedDeliveryId,
          'delivery-open',
        );
      });
      inspector.appendChild(back);

      const delivery = state.detail.delivery;
      const deliveryMeta = doc.createElement('dl');
      appendRow(deliveryMeta, 'Received', timestamp(delivery.received_at));
      appendRow(deliveryMeta, 'Profile', delivery.profile_id);
      appendRow(deliveryMeta, 'Environment', delivery.environment);
      appendRow(deliveryMeta, 'How it arrived', delivery.transport_assurance);
      appendRow(deliveryMeta, 'Admission', delivery.admission_method);
      appendRow(deliveryMeta, 'Checked it was recent', delivery.freshness_checked ? 'Yes' : 'No');
      appendRow(deliveryMeta, 'What was sent', delivery.raw_body_retained ? 'Retained' : 'Not kept');
      appendRow(deliveryMeta, 'Fingerprint of what was sent (SHA-256)', delivery.raw_body_sha256);
      appendRow(deliveryMeta, 'The labels around it can be cleared out', timestamp(delivery.metadata_expires_at));
      inspector.appendChild(deliveryMeta);

      if (state.detail.events.length === 0) {
        const empty = doc.createElement('p');
        empty.className = 'wh-copy';
        empty.textContent = 'Recued kept no events from this message.';
        inspector.appendChild(empty);
      }
      for (const event of state.detail.events) {
        const eventNode = doc.createElement('article');
        eventNode.setAttribute(WEBHOOKS_PANEL_EVENT_ATTR, event.event_id);
        const eventMeta = doc.createElement('dl');
        appendRow(eventMeta, 'Kind of event', event.provider_event_type);
        appendRow(eventMeta, 'Dispatch', event.dispatch_state);
        appendRow(eventMeta, 'Selected', event.selected_for_dispatch ? 'Yes' : 'No');
        appendRow(eventMeta, 'Event at the service', event.provider_event_id ?? 'Not given');
        appendRow(eventMeta, 'What it was about', event.provider_resource_id ?? 'Not given');
        appendRow(eventMeta, 'Occurred', timestamp(event.provider_occurred_at));
        appendRow(eventMeta, 'What was sent can be cleared out', timestamp(event.payload_expires_at));
        eventNode.appendChild(eventMeta);

        const loaded = state.payloads.get(event.event_id);
        if (loaded?.payload_retained === true) {
          const payload = doc.createElement('pre');
          payload.setAttribute(WEBHOOKS_PANEL_PAYLOAD_ATTR, event.event_id);
          payload.tabIndex = -1;
          payload.textContent = JSON.stringify(loaded.payload, null, 2) ?? 'null';
          eventNode.appendChild(payload);
        } else if (loaded?.payload_retained === false || !event.payload_retained) {
          const expired = doc.createElement('p');
          expired.className = 'wh-copy';
          expired.textContent = 'What was sent has passed its time and is gone.';
          eventNode.appendChild(expired);
        } else {
          const viewPayload = button(doc, 'See what was sent', 'event-open');
          viewPayload.setAttribute(
            'aria-label',
            `See what was sent for event ${event.event_id} in ${ingress.display_name} (${ingress.ingress_id})`,
          );
          viewPayload.disabled = busy;
          viewPayload.addEventListener('click', () => {
            loadDeliveryEvent(
              ingress.ingress_id,
              delivery.delivery_id,
              event.event_id,
            );
          });
          eventNode.appendChild(viewPayload);
        }
        inspector.appendChild(eventNode);
      }
      return inspector;
    }

    if (state.deliveries.length === 0) {
      const empty = doc.createElement('p');
      empty.className = 'wh-copy';
      empty.textContent = 'Recued has kept no messages that got through.';
      inspector.appendChild(empty);
    }
    for (const delivery of state.deliveries) {
      const deliveryNode = doc.createElement('article');
      deliveryNode.setAttribute(WEBHOOKS_PANEL_DELIVERY_ATTR, delivery.delivery_id);
      const deliveryMeta = doc.createElement('dl');
      appendRow(deliveryMeta, 'Received', timestamp(delivery.received_at));
      appendRow(deliveryMeta, 'Assurance', delivery.transport_assurance);
      appendRow(deliveryMeta, 'Events', String(delivery.event_count));
      appendRow(deliveryMeta, 'What was sent', delivery.raw_body_retained ? 'Retained' : 'Not kept');
      deliveryNode.appendChild(deliveryMeta);
      const open = button(doc, 'Look at this message', 'delivery-open');
      open.setAttribute(
        'aria-label',
        `Look at message ${delivery.delivery_id} for ${ingress.display_name} (${ingress.ingress_id})`,
      );
      open.disabled = busy;
      open.addEventListener('click', () => {
        loadDeliveryDetail(ingress.ingress_id, delivery.delivery_id);
      });
      deliveryNode.appendChild(open);
      inspector.appendChild(deliveryNode);
    }
    if (state.next_cursor !== null) {
      const loadMore = button(doc, 'Show more messages', 'deliveries-more');
      loadMore.disabled = busy;
      loadMore.addEventListener('click', () => {
        loadDeliveries(ingress.ingress_id, state.next_cursor!);
      });
      inspector.appendChild(loadMore);
    }
    return inspector;
  };

  const rejectionInspectorView = (ingress: WebhookIngressView): HTMLElement => {
    const inspector = doc.createElement('section');
    inspector.setAttribute(WEBHOOKS_PANEL_REJECTIONS_ATTR, ingress.ingress_id);
    const state = rejectionInspector?.ingress_id === ingress.ingress_id
      ? rejectionInspector
      : null;
    const head = doc.createElement('div');
    head.className = 'wh-card-head';
    const title = doc.createElement('strong');
    title.textContent = 'Messages that were turned away';
    head.appendChild(title);
    const close = button(doc, 'Close', 'rejections-close');
    close.disabled = busy;
    close.addEventListener('click', () => {
      rejectionInspector = null;
      render();
      focusCardAction(ingress.ingress_id, 'rejections');
    });
    head.appendChild(close);
    inspector.appendChild(head);

    const boundary = doc.createElement('p');
    boundary.className = 'wh-copy';
    boundary.textContent = 'Only messages turned away for a bad shape or a failed check, grouped by minute and by the way in they used. What they said, their fingerprints, paths, headers, signatures, keys, network details, wrong turns, ones dropped for coming too fast, and server faults you can try again are not kept here.';
    inspector.appendChild(boundary);
    if (state === null || (!state.loaded && busy)) {
      const loading = doc.createElement('p');
      loading.className = 'wh-copy';
      loading.textContent = 'Loading the messages that were turned away…';
      inspector.appendChild(loading);
      return inspector;
    }
    if (!state.loaded) {
      const unavailable = doc.createElement('p');
      unavailable.className = 'wh-copy';
      unavailable.textContent = 'Recued cannot show the messages that were turned away.';
      inspector.appendChild(unavailable);
      return inspector;
    }

    const appendRow = (list: HTMLDListElement, label: string, value: string): void => {
      const term = doc.createElement('dt');
      term.textContent = label;
      const description = doc.createElement('dd');
      description.textContent = value;
      list.appendChild(term);
      list.appendChild(description);
    };
    const timestamp = (value: number): string => new Date(value).toLocaleString();
    if (state.rejections.length === 0) {
      const empty = doc.createElement('p');
      empty.className = 'wh-copy';
      empty.textContent = 'Recued has kept no messages that were turned away.';
      inspector.appendChild(empty);
    }
    for (const rejection of state.rejections) {
      const rejectionNode = doc.createElement('article');
      rejectionNode.setAttribute(WEBHOOKS_PANEL_REJECTION_ATTR, rejection.rejection_id);
      const metadata = doc.createElement('dl');
      appendRow(metadata, 'Reason', rejection.reason_code);
      appendRow(metadata, 'HTTP status', String(rejection.http_status));
      appendRow(
        metadata,
        'Tries counted (at least this many)',
        String(rejection.recorded_attempt_count),
      );
      appendRow(metadata, 'First one', timestamp(rejection.first_recorded_at));
      appendRow(metadata, 'Last one', timestamp(rejection.last_recorded_at));
      appendRow(metadata, 'Profile', rejection.profile_id);
      appendRow(metadata, 'Environment', rejection.environment);
      appendRow(
        metadata,
        'The labels around it can be cleared out',
        timestamp(rejection.metadata_prune_eligible_at),
      );
      rejectionNode.appendChild(metadata);
      inspector.appendChild(rejectionNode);
    }
    if (state.next_cursor !== null) {
      const loadMore = button(doc, 'Show more turned-away messages', 'rejections-more');
      loadMore.disabled = busy;
      loadMore.addEventListener('click', () => {
        loadRejectedDeliveries(ingress.ingress_id, state.next_cursor!);
      });
      inspector.appendChild(loadMore);
    }
    return inspector;
  };

  const credentialForm = (
    ingress: WebhookIngressView,
    profile: WebhookProfileDescriptor,
  ): HTMLFormElement => {
    const ownerSettings = ownerSettingsFor(profile);
    const form = doc.createElement('form');
    form.setAttribute(WEBHOOKS_PANEL_FORM_ATTR, 'credentials');
    const title = doc.createElement('strong');
    title.textContent = ingress.active_credential_versions.length > 0
      ? 'Swap the keys'
      : 'Add keys';
    form.appendChild(title);
    const values = new Map<string, HTMLInputElement>();
    for (const field of profile.fields) {
      if (field.source === 'recued_generated'
        || field.source === 'managed_registration_result') continue;
      const label = doc.createElement('label');
      label.textContent = `${field.label}${field.required ? ' (required)' : ''}`;
      const input = doc.createElement('input');
      input.type = field.kind === 'secret'
        || field.kind === 'password'
        || field.kind === 'private_key'
        ? 'password'
        : 'text';
      input.autocomplete = 'off';
      input.required = field.required;
      input.setAttribute(WEBHOOKS_PANEL_FIELD_ATTR, field.key);
      values.set(field.key, input);
      label.appendChild(input);
      form.appendChild(label);
    }
    const generatedFields = profile.fields
      .filter((field) => field.source === 'recued_generated')
      .map((field) => field.label);
    if (generatedFields.length > 0) {
      const generatedNote = doc.createElement('p');
      generatedNote.className = 'wh-copy';
      generatedNote.textContent = ownerSettings.credential_rotation_instructions
        ?? `Saving makes a new ${generatedFields.join(', ')} key and shows it to you once. Put it into the other service before you retire the old one.`;
      form.appendChild(generatedNote);
    }
    if (generatedFields.length === 0
      && ownerSettings.credential_rotation_instructions !== null
      && ingress.active_credential_versions.length > 0) {
      const rotationNote = doc.createElement('p');
      rotationNote.className = 'wh-copy';
      rotationNote.textContent = ownerSettings.credential_rotation_instructions;
      form.appendChild(rotationNote);
    }
    const actions = doc.createElement('div');
    actions.className = 'wh-actions';
    const save = button(doc, 'Save this key', 'credential-save', true);
    save.type = 'submit';
    save.disabled = busy;
    actions.appendChild(save);
    const cancel = button(doc, 'Cancel', 'credential-cancel');
    cancel.addEventListener('click', () => {
      credentialIngressId = null;
      render();
      focusCardAction(ingress.ingress_id, 'credentials');
    });
    actions.appendChild(cancel);
    form.appendChild(actions);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (busy || disposed) return;
      rememberActionFocus(save);
      const credentials = Object.create(null) as Record<string, string>;
      for (const [key, input] of values) {
        if (input.value.length > 0) credentials[key] = input.value;
      }
      // A failed generated-credential rotation must not leave the previous
      // one-time plaintext looking like the result of the failed attempt.
      if (oneTime?.ingress_id === ingress.ingress_id) oneTime = null;
      void mutate(async () => {
        const response = await options.runCredentialWrite({
          ingress_id: ingress.ingress_id,
          credentials,
        });
        if (response.one_time_generated_credentials) {
          oneTime = {
            ingress_id: ingress.ingress_id,
            credentials: response.one_time_generated_credentials,
          };
        }
        credentialIngressId = null;
      });
    });
    return form;
  };

  const createForm = (): HTMLFormElement => {
    const profiles = createProfiles();
    const form = doc.createElement('form');
    form.setAttribute(WEBHOOKS_PANEL_FORM_ATTR, 'create');
    const nameLabel = doc.createElement('label');
    nameLabel.textContent = 'Name';
    const name = doc.createElement('input');
    name.required = true;
    name.placeholder = 'Billing notifications';
    name.setAttribute(WEBHOOKS_PANEL_FIELD_ATTR, 'display_name');
    nameLabel.appendChild(name);
    form.appendChild(nameLabel);

    const profileLabel = doc.createElement('label');
    profileLabel.textContent = 'How it proves who it is';
    const profileSelect = doc.createElement('select');
    profileSelect.setAttribute(WEBHOOKS_PANEL_PROFILE_ATTR, '');
    for (const profile of profiles) {
      const option = doc.createElement('option');
      option.value = profile.profile_id;
      option.textContent = `${ownerSettingsFor(profile).label} · ${profile.mechanism_kind.replaceAll('_', ' ')}`;
      profileSelect.appendChild(option);
    }
    profileLabel.appendChild(profileSelect);
    form.appendChild(profileLabel);

    const deduplicationNote = doc.createElement('p');
    deduplicationNote.className = 'wh-copy';
    deduplicationNote.setAttribute(WEBHOOKS_PANEL_DEDUPLICATION_ATTR, 'create');
    form.appendChild(deduplicationNote);
    const renderDeduplication = (): void => {
      const capability = capabilityFor(profileSelect.value as WebhookIngressView['profile_id']);
      deduplicationNote.textContent = capability === null
        ? 'This server did not say how it avoids doing the same thing twice.'
        : deduplicationDisclosure(capability.deduplication);
    };

    const environmentLabel = doc.createElement('label');
    environmentLabel.textContent = 'Environment';
    const environment = doc.createElement('select');
    environment.setAttribute(WEBHOOKS_PANEL_ENVIRONMENT_ATTR, '');
    environmentLabel.appendChild(environment);
    form.appendChild(environmentLabel);
    const renderEnvironments = (): void => {
      const previous = environment.value;
      clear(environment);
      const profile = descriptorFor(profileSelect.value);
      if (!profile) return;
      for (const value of profile.supported_environments) {
        const option = doc.createElement('option');
        option.value = value;
        option.textContent = value;
        environment.appendChild(option);
      }
      environment.value = profile.supported_environments.some(
        (value) => value === previous,
      )
        ? previous
        : profile.supported_environments[0] ?? '';
    };

    const registration = doc.createElement('div');
    registration.className = 'wh-grid';
    form.appendChild(registration);
    let selectedRegistrationMode: WebhookIngressCreateRequest['registration_mode'] = 'manual';
    let pairedConnectionInput: HTMLInputElement | null = null;
    let registrationTargetKindInput: HTMLSelectElement | null = null;
    let registrationTargetKeyInput: HTMLInputElement | null = null;
    let renderRegistrationNote = (): void => undefined;
    let renderFields = (): void => undefined;
    const renderRegistration = (): void => {
      clear(registration);
      pairedConnectionInput = null;
      registrationTargetKindInput = null;
      registrationTargetKeyInput = null;
      const profile = descriptorFor(profileSelect.value);
      if (!profile) return;
      const availableModes = availableRegistrationModes(profile.profile_id);
      if (!availableModes.includes(selectedRegistrationMode)) {
        selectedRegistrationMode = availableModes[0] ?? 'manual';
      }

      const modeLabel = doc.createElement('label');
      modeLabel.textContent = 'How to set it up';
      const modeSelect = doc.createElement('select');
      modeSelect.setAttribute(WEBHOOKS_PANEL_REGISTRATION_MODE_ATTR, '');
      for (const mode of availableModes) {
        const option = doc.createElement('option');
        option.value = mode;
        option.textContent = mode === 'operation_bound'
          ? 'Add it while the service is doing something'
          : mode === 'managed_endpoint'
            ? 'Set it up through a Connection'
          : 'Set it up yourself';
        modeSelect.appendChild(option);
      }
      modeSelect.value = selectedRegistrationMode;
      modeSelect.addEventListener('change', () => {
        selectedRegistrationMode = modeSelect.value as typeof selectedRegistrationMode;
        renderRegistration();
        renderFields();
        renderRegistrationNote();
      });
      modeLabel.appendChild(modeSelect);
      registration.appendChild(modeLabel);

      if (selectedRegistrationMode !== 'manual') {
        const connectionLabel = doc.createElement('label');
        connectionLabel.textContent = 'Connection to the service (needed)';
        const connection = doc.createElement('input');
        connection.required = true;
        connection.autocomplete = 'off';
        connection.placeholder = ownerSettingsFor(profile).connection_placeholder;
        connection.setAttribute(WEBHOOKS_PANEL_PAIRED_CONNECTION_ATTR, '');
        pairedConnectionInput = connection;
        connectionLabel.appendChild(connection);
        registration.appendChild(connectionLabel);
      }

      const targetSettings = ownerSettingsFor(profile).registration_target;
      if (targetSettings?.modes.includes(selectedRegistrationMode)) {
        const kindLabel = doc.createElement('label');
        kindLabel.textContent = targetSettings.kind_label;
        const kind = doc.createElement('select');
        kind.setAttribute(WEBHOOKS_PANEL_REGISTRATION_TARGET_KIND_ATTR, '');
        for (const targetKind of targetSettings.kinds) {
          const option = doc.createElement('option');
          option.value = targetKind.value;
          option.textContent = targetKind.label;
          kind.appendChild(option);
        }
        kind.value = targetSettings.kinds[0]?.value ?? '';
        registrationTargetKindInput = kind;
        kindLabel.appendChild(kind);
        registration.appendChild(kindLabel);

        const keyLabel = doc.createElement('label');
        keyLabel.textContent = targetSettings.key_label;
        const key = doc.createElement('input');
        key.required = true;
        key.autocomplete = 'off';
        key.placeholder = targetSettings.kinds.find((candidate) =>
          candidate.value === kind.value)?.key_placeholder ?? '';
        key.setAttribute(WEBHOOKS_PANEL_REGISTRATION_TARGET_KEY_ATTR, '');
        registrationTargetKeyInput = key;
        kind.addEventListener('change', () => {
          key.placeholder = targetSettings.kinds.find((candidate) =>
            candidate.value === kind.value)?.key_placeholder ?? '';
        });
        keyLabel.appendChild(key);
        registration.appendChild(keyLabel);
      }
    };

    const dynamic = doc.createElement('div');
    dynamic.className = 'wh-grid';
    form.appendChild(dynamic);
    let credentialInputs = new Map<string, HTMLInputElement>();
    renderFields = (): void => {
      clear(dynamic);
      credentialInputs = new Map();
      const profile = descriptorFor(profileSelect.value);
      if (!profile) return;
      for (const field of profile.fields) {
        if (field.source === 'recued_generated'
          || field.source === 'managed_registration_result'
          || field.source === 'vendor_generated') continue;
        const label = doc.createElement('label');
        label.textContent = `${field.label}${field.required ? ' (required)' : ''}`;
        const input = doc.createElement('input');
        input.type = field.kind === 'secret'
          || field.kind === 'password'
          || field.kind === 'private_key'
          ? 'password'
          : 'text';
        input.required = field.required;
        input.autocomplete = 'off';
        input.setAttribute(WEBHOOKS_PANEL_FIELD_ATTR, field.key);
        credentialInputs.set(field.key, input);
        label.appendChild(input);
        dynamic.appendChild(label);
      }
    };

    const eventTypes = doc.createElement('fieldset');
    eventTypes.className = 'wh-event-types';
    form.appendChild(eventTypes);
    let eventTypeInputs = new Map<string, HTMLInputElement>();
    let eventTypeValidation: HTMLParagraphElement | null = null;
    const renderEventTypes = (): void => {
      clear(eventTypes);
      eventTypeInputs = new Map();
      eventTypeValidation = null;
      const profile = descriptorFor(profileSelect.value);
      if (!profile || profile.event_types.kind === 'closed') {
        eventTypes.hidden = true;
        return;
      }
      eventTypes.hidden = false;
      const legend = doc.createElement('legend');
      legend.textContent = 'Events at the service';
      eventTypes.appendChild(legend);
      for (const eventType of profile.event_types.known_values) {
        const label = doc.createElement('label');
        const input = doc.createElement('input');
        input.type = 'checkbox';
        input.value = eventType;
        input.checked = false;
        input.setAttribute(WEBHOOKS_PANEL_EVENT_TYPE_ATTR, eventType);
        input.addEventListener('change', () => {
          if (eventTypeValidation) eventTypeValidation.hidden = true;
        });
        eventTypeInputs.set(eventType, input);
        label.appendChild(input);
        const text = doc.createElement('span');
        text.textContent = eventType;
        label.appendChild(text);
        eventTypes.appendChild(label);
      }
      eventTypeValidation = doc.createElement('p');
      eventTypeValidation.className = 'wh-copy';
      eventTypeValidation.textContent = 'Pick at least one event at the service.';
      eventTypeValidation.hidden = true;
      eventTypes.appendChild(eventTypeValidation);
    };
    profileSelect.addEventListener('change', () => {
      selectedRegistrationMode = 'manual';
      renderEnvironments();
      renderRegistration();
      renderFields();
      renderEventTypes();
      renderDeduplication();
      renderRegistrationNote();
    });
    // Browsers select the first option automatically. The explicit assignment
    // also keeps minimal DOM harnesses deterministic.
    profileSelect.value = profiles[0]?.profile_id ?? '';
    renderEnvironments();
    renderRegistration();
    renderFields();
    renderEventTypes();
    renderDeduplication();

    const note = doc.createElement('p');
    note.className = 'wh-note';
    renderRegistrationNote = (): void => {
      const profile = descriptorFor(profileSelect.value);
      if (!profile) {
        note.textContent = 'This server has no webhook set-ups installed.';
        return;
      }
      const template = ownerSettingsFor(profile)
        .create_instructions[selectedRegistrationMode];
      note.textContent = template === undefined
        ? 'This set-up cannot be done that way.'
        : webhookOwnerTextForEnvironment(
            template,
            environment.value as WebhookIngressView['environment'],
          );
    };
    renderRegistrationNote();
    form.appendChild(note);
    const actions = doc.createElement('div');
    actions.className = 'wh-actions';
    const create = button(doc, 'Make a webhook', 'create-submit', true);
    create.type = 'submit';
    create.disabled = busy || profiles.length === 0;
    actions.appendChild(create);
    const cancel = button(doc, 'Cancel', 'create-cancel');
    cancel.addEventListener('click', () => {
      showCreate = false;
      render();
      focusRendered(root, (element) =>
        element.hasAttribute?.(WEBHOOKS_PANEL_NEW_ATTR) === true);
    });
    actions.appendChild(cancel);
    form.appendChild(actions);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      rememberActionFocus(create);
      const profile = descriptorFor(profileSelect.value);
      if (!profile) return;
      const credentials = Object.create(null) as Record<string, string>;
      for (const [key, input] of credentialInputs) {
        if (input.value.length > 0) credentials[key] = input.value;
      }
      const selected = profile.event_types.kind === 'closed'
        ? [...profile.event_types.values]
        : [...eventTypeInputs]
            .filter(([, input]) => input.checked)
            .map(([eventType]) => eventType);
      if (selected.length === 0) {
        if (eventTypeValidation) eventTypeValidation.hidden = false;
        return;
      }
      const pairedConnectionId = pairedConnectionInput?.value.trim() ?? '';
      if (selectedRegistrationMode !== 'manual' && pairedConnectionId.length === 0) {
        error = `You need a Connection to the service to set it up ${selectedRegistrationMode.replaceAll('_', ' ')}.`;
        render();
        return;
      }
      let registrationTarget: NonNullable<
        WebhookIngressCreateRequest['registration_target']
      > | null = null;
      const targetSettings = ownerSettingsFor(profile).registration_target;
      if (targetSettings?.modes.includes(selectedRegistrationMode)) {
        const kind = registrationTargetKindInput?.value;
        const key = registrationTargetKeyInput?.value.trim() ?? '';
        if (!targetSettings.kinds.some((candidate) => candidate.value === kind)
          || key.length === 0) {
          error = targetSettings.required_message;
          render();
          return;
        }
        registrationTarget = {
          kind: kind!,
          key: targetSettings.key_normalization === 'lowercase'
            ? key.toLowerCase()
            : key,
        };
      }
      void mutate(async () => {
        const created = await options.runCreate({
          display_name: name.value,
          profile_id: profile.profile_id,
          environment: environment.value as WebhookIngressCreateRequest['environment'],
          registration_mode: selectedRegistrationMode,
          ...(selectedRegistrationMode !== 'manual'
            ? { paired_connection_id: pairedConnectionId }
            : {}),
          ...(registrationTarget !== null
            ? { registration_target: registrationTarget }
            : {}),
          selected_event_types: selected,
        });
        // Creation may commit before the follow-up credential write. From this
        // point repair belongs to the persisted ingress card; keeping this form
        // open would invite a duplicate ingress after a partial failure.
        showCreate = false;
        pendingCompletionFocus = {
          kind: 'card-title',
          ingress_id: created.ingress.ingress_id,
        };
        const credentialWriteDeferred = selectedRegistrationMode === 'managed_endpoint'
          || profile.fields.some((field) => field.source === 'vendor_generated');
        if (!credentialWriteDeferred) {
          const written = await options.runCredentialWrite({
            ingress_id: created.ingress.ingress_id,
            credentials,
          });
          if (written.one_time_generated_credentials) {
            oneTime = {
              ingress_id: created.ingress.ingress_id,
              credentials: written.one_time_generated_credentials,
            };
          }
        }
      });
    });
    return form;
  };

  const ingressCard = (ingress: WebhookIngressView): HTMLElement => {
    const profile = descriptorFor(ingress.profile_id);
    const ownerSettings = profile === null ? null : ownerSettingsFor(profile);
    const profileCapability = capabilityFor(ingress.profile_id);
    const profileModeAvailable = profileCapability
      ?.registration_modes.includes(ingress.registration_mode) ?? false;
    const needsManualConfirmation = profileModeAvailable
      && ingress.registration_mode === 'manual'
      && (ingress.registration_state === 'manual_pending'
        || ingress.registration_state === 'registered')
      && (!ingress.readiness.registration_complete
        || !ingress.readiness.registration_endpoint_matches);
    const canReconcileManagedRegistration = options.runRegistrationReconcile !== undefined
      && (profileCapability?.registration_modes.includes('managed_endpoint') ?? false)
      && ingress.registration_mode === 'managed_endpoint'
      && ingress.registration_state !== 'cleanup_pending'
      && ingress.registration_state !== 'retired'
      && ingress.intake_state !== 'retired';
    const card = doc.createElement('article');
    card.setAttribute(WEBHOOKS_PANEL_CARD_ATTR, ingress.ingress_id);
    const head = doc.createElement('div');
    head.className = 'wh-card-head';
    const title = doc.createElement('h3');
    title.tabIndex = -1;
    title.textContent = ingress.display_name;
    head.appendChild(title);
    const pill = doc.createElement('span');
    pill.className = 'wh-pill';
    pill.textContent = `${ingress.registration_state} · ${ingress.intake_state}`;
    head.appendChild(pill);
    card.appendChild(head);

    const detail = doc.createElement('dl');
    const row = (label: string, value: string): HTMLElement => {
      const term = doc.createElement('dt');
      term.textContent = label;
      const description = doc.createElement('dd');
      description.textContent = value;
      detail.appendChild(term);
      detail.appendChild(description);
      return description;
    };
    row('Profile', ingress.profile_id);
    row('Mechanism', profile?.mechanism_kind.replaceAll('_', ' ') ?? 'unknown');
    row('Assurance', profile?.transport_assurance ?? 'unknown');
    const deduplication = row(
      'Deduplication',
      profileCapability === null
        ? 'Recued cannot tell what this server promises'
        : deduplicationDisclosure(profileCapability.deduplication),
    );
    deduplication.setAttribute(WEBHOOKS_PANEL_DEDUPLICATION_ATTR, ingress.ingress_id);
    row('Environment', ingress.environment);
    row('How to set it up', ingress.registration_mode.replaceAll('_', ' '));
    row('Connection', ingress.paired_connection_id ?? 'None');
    row('Where it is set up', ingress.registration_target === null
      ? 'None'
      : `${ingress.registration_target.kind}: ${ingress.registration_target.key}`);
    if ((ingress.pending_paired_connection_id ?? null) !== null) {
      row('Waiting for a Connection', ingress.pending_paired_connection_id!);
    }
    row('Events', ingress.selected_event_types.join(', '));
    row('Health', ingress.health.status);
    row('Last thing that went wrong', ingress.health.last_error_code ?? 'None');
    row('Last message', ingress.health.last_delivery_at === null
      ? 'No messages yet'
      : new Date(ingress.health.last_delivery_at).toLocaleString());
    row('Test message', ingress.readiness.test_delivery_supported
      ? 'Recued can pretend to send one from outside'
      : ownerSettings === null
        ? 'Recued cannot show these settings'
        : webhookOwnerTextForEnvironment(
            ownerSettings.external_test_guidance,
            ingress.environment,
          ));
    row('Keys', ingress.active_credential_versions
      .map((version) => `v${version.version} (${version.last_verified_at === null
        ? 'not checked yet'
        : 'verified'})`).join(', ') || 'None');
    card.appendChild(detail);

    const endpoint = doc.createElement('code');
    endpoint.setAttribute(WEBHOOKS_PANEL_ENDPOINT_ATTR, '');
    endpoint.textContent = ingress.endpoint_url ?? 'No public https address yet';
    card.appendChild(endpoint);

    if (oneTime?.ingress_id === ingress.ingress_id) {
      const callout = doc.createElement('div');
      callout.setAttribute(WEBHOOKS_PANEL_ONE_TIME_ATTR, '');
      callout.textContent = 'Copy these now. Recued will not show them again.';
      for (const [key, value] of Object.entries(oneTime.credentials)) {
        const secret = doc.createElement('code');
        secret.textContent = `${key}: ${value}`;
        callout.appendChild(secret);
      }
      card.appendChild(callout);
      if (ingress.registration_mode === 'manual'
        && ownerSettings?.generated_credential_instructions) {
        const generatedRegistration = doc.createElement('p');
        generatedRegistration.className = 'wh-note';
        generatedRegistration.textContent = formatOwnerText(
          ownerSettings.generated_credential_instructions,
          ingress,
        );
        card.appendChild(generatedRegistration);
      }
    }

    if (retentionNotice?.ingress_id === ingress.ingress_id) {
      const notice = doc.createElement('div');
      notice.setAttribute(WEBHOOKS_PANEL_RETENTION_ATTR, ingress.ingress_id);
      notice.className = 'wh-note';
      const result = retentionNotice.result;
      notice.textContent = `Cleared out: ${result.payloads_deleted} things that were sent, ${result.outbox_rows_deleted} finished outgoing rows, ${result.events_deleted} events, ${result.deliveries_deleted} messages, and ${result.rejected_summaries_deleted} turned-away summaries. Anything still waiting, being worked on, stuck, or pinned is kept safe.`;
      card.appendChild(notice);
    }

    if (testDeliveryNotice?.ingress_id === ingress.ingress_id) {
      const notice = doc.createElement('div');
      notice.setAttribute(WEBHOOKS_PANEL_TEST_ATTR, ingress.ingress_id);
      notice.className = 'wh-note';
      notice.textContent = `Test message ${testDeliveryNotice.delivery_id} arrived and was kept at ${new Date(testDeliveryNotice.observed_at).toLocaleString()}. It went the same way a real one would.`;
      card.appendChild(notice);
    }

    if (needsManualConfirmation) {
      const instructions = doc.createElement('p');
      instructions.className = 'wh-note';
      instructions.textContent = ingress.endpoint_url === null
        ? 'Fix the public https address before you set this up at the other service.'
        : ownerSettings === null
          ? 'Recued cannot show the owner settings. Keep this closed.'
          : formatOwnerText(webhookOwnerTextForEnvironment(
              ownerSettings.manual_confirmation_instructions,
              ingress.environment,
            ), ingress);
      card.appendChild(instructions);
    }
    if (canReconcileManagedRegistration) {
      const instructions = doc.createElement('p');
      instructions.className = 'wh-note';
      instructions.textContent = ownerSettings === null
        ? 'Recued cannot show the owner settings. Keep this closed.'
        : formatOwnerText(webhookOwnerTextForEnvironment(
            ownerSettings.managed_reconciliation_instructions,
            ingress.environment,
          ), ingress);
      card.appendChild(instructions);
    }
    if (ingress.registration_state === 'cleanup_pending') {
      const instructions = doc.createElement('p');
      instructions.className = 'wh-note';
      instructions.textContent = (ingress.pending_paired_connection_id ?? null) === null
        ? 'Nothing can come in here now. The address at the service still has to be cleaned up. Trying again keeps this closed, and never makes a new address.'
        : `Nothing can come in here while your server removes the address from ${ingress.paired_connection_id ?? 'this Connection'}. Only once it has checked the address is gone will it switch to ${ingress.pending_paired_connection_id}, and you still set the new one up yourself.`;
      card.appendChild(instructions);
    }

    if (ingress.readiness.blockers.length > 0) {
      const blockers = doc.createElement('p');
      blockers.className = 'wh-copy';
      blockers.textContent = `Before you switch it on: ${ingress.readiness.blockers
        .map((value) => blockerLabel[value]).join('; ')}.`;
      card.appendChild(blockers);
    }
    if (ingress.readiness.test_delivery_supported) {
      const testBoundary = doc.createElement('p');
      testBoundary.className = 'wh-copy';
      testBoundary.textContent = ownerSettings?.test_delivery_boundary
        ?? 'Recued cannot test this set-up.';
      card.appendChild(testBoundary);
    }

    const actions = doc.createElement('div');
    actions.className = 'wh-actions';
    const canOwnerWriteCredentials = profileModeAvailable
      && profile !== null
      && ingress.registration_mode !== 'managed_endpoint'
      && (ingress.registration_mode === 'manual'
        || profile.fields.some((field) =>
          field.source === 'owner' || field.source === 'recued_generated'));
    if (profile && canOwnerWriteCredentials) {
      const credentialOverlapFull = ingress.active_credential_versions.length
        >= MAX_ACTIVE_WEBHOOK_CREDENTIAL_VERSIONS;
      const rotate = button(
        doc,
        ingress.active_credential_versions.length > 0 ? 'Swap the keys' : 'Add keys',
        'credentials',
      );
      rotate.disabled = busy || credentialOverlapFull;
      if (credentialOverlapFull) {
        rotate.title = `Retire one of the ${MAX_ACTIVE_WEBHOOK_CREDENTIAL_VERSIONS} keys in use before you add another`;
      }
      rotate.addEventListener('click', () => {
        credentialIngressId = ingress.ingress_id;
        render();
        const card = renderedCard(ingress.ingress_id);
        if (card !== null) {
          focusRendered(card, (element) =>
            element.getAttribute?.(WEBHOOKS_PANEL_FIELD_ATTR) !== null);
        }
      });
      actions.appendChild(rotate);
    }
    if (needsManualConfirmation) {
      const confirm = button(
        doc,
        ingress.registration_state === 'registered'
          ? 'I have updated this address'
          : 'I have set up this address',
        'manual-confirm',
        true,
      );
      confirm.disabled = busy
        || !ingress.readiness.credentials_complete
        || ingress.endpoint_url === null;
      confirm.addEventListener('click', () => {
        void mutate(() => options.runManualConfirm({ ingress_id: ingress.ingress_id }));
      });
      actions.appendChild(confirm);
    }
    if (canReconcileManagedRegistration) {
      const isFirstRegistration = ingress.remote_endpoint_id === null
        && ingress.registration_state === 'managed_pending';
      const reconcile = button(
        doc,
        isFirstRegistration
          ? 'Set up the address at the service'
          : 'Line the address up again',
        'registration-reconcile',
        ingress.registration_state !== 'registered',
      );
      reconcile.disabled = busy || ingress.endpoint_url === null;
      reconcile.title = 'Uses the one true address and the events this set-up allows. You do not type a web address.';
      reconcile.addEventListener('click', () => {
        void mutate(() => options.runRegistrationReconcile!({
          ingress_id: ingress.ingress_id,
        }));
      });
      actions.appendChild(reconcile);
    }
    if (profileModeAvailable
      && (ingress.intake_state === 'ready' || ingress.intake_state === 'disabled')) {
      const enable = button(doc, 'Let messages in', 'enable', true);
      enable.disabled = busy || !ingress.readiness.can_enable;
      enable.title = ingress.readiness.blockers.map((value) => blockerLabel[value]).join('; ');
      enable.addEventListener('click', () => {
        void mutate(() => options.runEnable({ ingress_id: ingress.ingress_id }));
      });
      actions.appendChild(enable);
    }
    if (ingress.intake_state === 'enabled' || ingress.intake_state === 'degraded') {
      const disable = button(doc, 'Stop messages coming in', 'disable');
      disable.disabled = busy;
      disable.addEventListener('click', () => {
        void mutate(() => options.runDisable({ ingress_id: ingress.ingress_id }));
      });
      actions.appendChild(disable);
    }
    if (ingress.registration_state === 'cleanup_pending'
      && (ingress.intake_state === 'disabled' || ingress.intake_state === 'retired')) {
      const pendingConnectionId = ingress.pending_paired_connection_id ?? null;
      const retryCleanup = button(
        doc,
        pendingConnectionId !== null && ingress.intake_state !== 'retired'
          ? 'Try the swap again'
          : 'Try the clean-up again',
        'cleanup-retry',
        true,
      );
      retryCleanup.disabled = busy
        || (ingress.intake_state === 'retired' && options.runRetire === undefined)
        || (pendingConnectionId !== null
          && ingress.intake_state !== 'retired'
          && options.runRegistrationReconcile === undefined);
      retryCleanup.addEventListener('click', () => {
        void mutate(() => {
          if (ingress.intake_state === 'retired') {
            return options.runRetire!({ ingress_id: ingress.ingress_id });
          }
          if (pendingConnectionId !== null) {
            return options.runRegistrationReconcile!({
              ingress_id: ingress.ingress_id,
              paired_connection_id: pendingConnectionId,
            });
          }
          return options.runDisable({ ingress_id: ingress.ingress_id });
        });
      });
      actions.appendChild(retryCleanup);
    }
    if (options.runRegistrationReconcile
      && (profileCapability?.registration_modes.includes('managed_endpoint') ?? false)
      && ingress.registration_mode === 'managed_endpoint'
      && ingress.paired_connection_id !== null
      && ingress.registration_state !== 'cleanup_pending'
      && ingress.registration_state !== 'retired'
      && ingress.intake_state !== 'retired') {
      const rebind = button(doc, 'Change the Connection', 'connection-rebind');
      rebind.disabled = busy;
      rebind.title = 'Your server checks the new one before it closes or changes the one you have';
      rebind.addEventListener('click', () => {
        connectionRebindIngressId = ingress.ingress_id;
        render();
        const card = renderedCard(ingress.ingress_id);
        if (card !== null) {
          focusRendered(card, (element) =>
            element.hasAttribute?.(WEBHOOKS_PANEL_REBIND_ATTR) === true);
        }
      });
      actions.appendChild(rebind);
    }
    if (options.runTestDelivery
      && profileModeAvailable
      && ingress.environment === 'test'
      && ingress.readiness.test_delivery_supported) {
      const sendTest = button(doc, 'Send a test message', 'test-delivery');
      sendTest.disabled = busy
        || !ingress.readiness.can_enable
        || (ingress.intake_state !== 'enabled'
          && ingress.intake_state !== 'degraded');
      sendTest.title = 'Sends a signed message to your public address. Recipes tied to this may run.';
      sendTest.addEventListener('click', () => {
        testDeliveryNotice = null;
        void mutate(async () => {
          const response = await options.runTestDelivery!({
            ingress_id: ingress.ingress_id,
          });
          if (response.ingress.ingress_id !== ingress.ingress_id) {
            throw new Error('The test message came back from the wrong way in');
          }
          testDeliveryNotice = {
            ingress_id: ingress.ingress_id,
            delivery_id: response.delivery_id,
            observed_at: response.observed_at,
          };
        });
      });
      actions.appendChild(sendTest);
    }
    if (canInspectDeliveries) {
      const inspecting = deliveryInspector?.ingress_id === ingress.ingress_id;
      const deliveries = button(
        doc,
        inspecting ? 'Hide the messages that got through' : 'See the messages that got through',
        'deliveries',
      );
      deliveries.disabled = busy;
      deliveries.addEventListener('click', () => {
        if (inspecting) {
          deliveryInspector = null;
          render();
          focusCardAction(ingress.ingress_id, 'deliveries');
          return;
        }
        deliveryInspector = {
          ingress_id: ingress.ingress_id,
          deliveries: [],
          next_cursor: null,
          detail: null,
          payloads: new Map(),
        };
        rejectionInspector = null;
        loadDeliveries(ingress.ingress_id);
      });
      actions.appendChild(deliveries);
    }
    if (canInspectRejections) {
      const inspecting = rejectionInspector?.ingress_id === ingress.ingress_id;
      const rejections = button(
        doc,
        inspecting ? 'Hide the turned-away messages' : 'See the turned-away messages',
        'rejections',
      );
      rejections.disabled = busy;
      rejections.addEventListener('click', () => {
        if (inspecting) {
          rejectionInspector = null;
          render();
          focusCardAction(ingress.ingress_id, 'rejections');
          return;
        }
        rejectionInspector = {
          ingress_id: ingress.ingress_id,
          rejections: [],
          next_cursor: null,
          loaded: false,
        };
        deliveryInspector = null;
        loadRejectedDeliveries(ingress.ingress_id);
      });
      actions.appendChild(rejections);
    }
    if (options.runRetentionPrune) {
      const prune = button(doc, 'Clear out what can go', 'retention-prune');
      prune.disabled = busy;
      prune.title = 'Only deletes what your server has already kept long enough';
      prune.addEventListener('click', () => {
        void mutate(async () => {
          const response = await options.runRetentionPrune!({
            ingress_id: ingress.ingress_id,
          });
          retentionNotice = {
            ingress_id: ingress.ingress_id,
            result: response.result,
          };
        });
      });
      actions.appendChild(prune);
    }
    if (options.runRetire && ingress.registration_state !== 'cleanup_pending') {
      const exposedIntake = ingress.intake_state === 'enabled'
        || ingress.intake_state === 'degraded'
        || (ingress.intake_state === 'verification_pending'
          && ingress.registration_mode !== 'operation_bound');
      // Possibly-exposed operation-bound cleanup and managed profiles without
      // a code-backed adapter remain closed; never-enabled drafts are clear.
      const remoteCleanupUnavailable = (ingress.registration_mode === 'operation_bound'
          && (ingress.intake_state === 'enabled'
            || ingress.intake_state === 'degraded'
            || ingress.intake_state === 'disabled'))
        || (ingress.registration_mode === 'managed_endpoint'
          && !(profileCapability?.registration_modes.includes('managed_endpoint') ?? false))
        || (ingress.registration_mode === 'manual'
          && ingress.remote_endpoint_id !== null);
      const retirementBlocked = exposedIntake || remoteCleanupUnavailable;
      if (retirementConfirmIngressId === ingress.ingress_id) {
        const confirmRetire = button(
          doc,
          'Really close this webhook for good?',
          'retire-confirm',
        );
        confirmRetire.disabled = busy || retirementBlocked;
        confirmRetire.addEventListener('click', () => {
          void mutate(async () => {
            const response = await options.runRetire!({ ingress_id: ingress.ingress_id });
            if (response.ingress.ingress_id !== ingress.ingress_id
              || response.ingress.intake_state !== 'retired'
              || response.ingress.registration_state !== 'retired') {
              throw new Error('Closing it came back from the wrong way in');
            }
            // Retirement may commit even if the generic post-mutation list
            // refresh fails. Remove the row immediately so the UI never renders
            // a committed retirement as still active.
            ingresses = ingresses.filter((candidate) =>
              candidate.ingress_id !== ingress.ingress_id);
            pendingCompletionFocus = { kind: 'panel-title' };
            if (oneTime?.ingress_id === ingress.ingress_id) oneTime = null;
            retirementConfirmIngressId = null;
            retentionNotice = null;
            testDeliveryNotice = null;
            deliveryInspector = null;
            rejectionInspector = null;
          });
        });
        actions.appendChild(confirmRetire);
        const cancelRetire = button(doc, 'Never mind', 'retire-cancel');
        cancelRetire.disabled = busy;
        cancelRetire.addEventListener('click', () => {
          retirementConfirmIngressId = null;
          render();
          focusCardAction(ingress.ingress_id, 'retire');
        });
        actions.appendChild(cancelRetire);
      } else {
        const retire = button(doc, 'Close this webhook for good', 'retire');
        retire.disabled = busy || retirementBlocked;
        retire.title = exposedIntake
          ? 'Stop messages coming in before you close this webhook'
          : remoteCleanupUnavailable
            ? 'Your server has to know how to clean up at the service first'
            : 'Closes this way in for good, and every key it uses';
        retire.addEventListener('click', () => {
          retirementConfirmIngressId = ingress.ingress_id;
          render();
          focusCardAction(ingress.ingress_id, 'retire-confirm');
        });
        actions.appendChild(retire);
      }
    }
    card.appendChild(actions);

    if (connectionRebindIngressId === ingress.ingress_id
      && options.runRegistrationReconcile
      && profileModeAvailable) {
      const form = doc.createElement('form');
      const label = doc.createElement('label');
      label.textContent = 'Id of the Connection to use instead';
      const input = doc.createElement('input');
      input.setAttribute(WEBHOOKS_PANEL_REBIND_ATTR, '');
      input.name = 'paired_connection_id';
      input.required = true;
      input.maxLength = 256;
      input.placeholder = ownerSettings?.connection_placeholder
        ?? 'provider-connection';
      label.appendChild(input);
      form.appendChild(label);
      const boundary = doc.createElement('p');
      boundary.className = 'wh-copy';
      boundary.textContent = ownerSettings?.connection_rebind_instructions
        ?? 'Recued cannot tell you how to link this up again. Keep it closed.';
      form.appendChild(boundary);
      const formActions = doc.createElement('div');
      formActions.className = 'wh-actions';
      const submit = button(doc, 'Check it and switch', 'connection-rebind-confirm', true);
      submit.type = 'submit';
      submit.disabled = busy;
      formActions.appendChild(submit);
      const cancel = button(doc, 'Cancel', 'connection-rebind-cancel');
      cancel.disabled = busy;
      cancel.addEventListener('click', () => {
        connectionRebindIngressId = null;
        render();
        focusCardAction(ingress.ingress_id, 'connection-rebind');
      });
      formActions.appendChild(cancel);
      form.appendChild(formActions);
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        rememberActionFocus(submit);
        const pairedConnectionId = input.value.trim();
        if (pairedConnectionId.length === 0
          || pairedConnectionId === ingress.paired_connection_id) return;
        void mutate(async () => {
          await options.runRegistrationReconcile!({
            ingress_id: ingress.ingress_id,
            paired_connection_id: pairedConnectionId,
          });
          connectionRebindIngressId = null;
        });
      });
      card.appendChild(form);
    }

    if (retirementConfirmIngressId === ingress.ingress_id) {
      const warning = doc.createElement('p');
      warning.className = 'wh-note';
      warning.textContent = ingress.registration_mode === 'managed_endpoint'
        ? 'This cannot be undone. Messages stop coming in first, the keys in use are retired, and your server deletes the address at the service and then checks it is gone. If that last call fails you will still see it, so you can try again.'
        : ingress.registration_mode === 'operation_bound'
          ? 'This cannot be undone. This way in was never switched on, so nothing could ever have been sent to it. The keys in use, and the public id, will be retired.'
          : ownerSettings?.manual_retirement_instructions
            ?? 'Recued cannot tell you how to close this. Keep it closed.';
      card.appendChild(warning);
    }

    if (credentialIngressId === ingress.ingress_id && profile && profileModeAvailable) {
      card.appendChild(credentialForm(ingress, profile));
    }
    if (ingress.active_credential_versions.length > 1) {
      const rotation = doc.createElement('div');
      rotation.className = 'wh-actions';
      for (const version of ingress.active_credential_versions) {
        const retire = button(doc, `Retire key v${version.version}`, 'credential-retire');
        const liveIntake = ingress.intake_state === 'enabled'
          || ingress.intake_state === 'degraded';
        const hasVerifiedRemaining = ingress.active_credential_versions.some(
          (candidate) => candidate.version !== version.version
            && candidate.last_verified_at !== null,
        );
        retire.disabled = busy || (liveIntake && !hasVerifiedRemaining);
        if (liveIntake && !hasVerifiedRemaining) {
          retire.title = 'First let a message through using one of the other keys';
        }
        retire.addEventListener('click', () => {
          void mutate(async () => {
            await options.runCredentialRetire({
              ingress_id: ingress.ingress_id,
              credential_version: version.version,
            });
            if (oneTime?.ingress_id === ingress.ingress_id) oneTime = null;
          });
        });
        rotation.appendChild(retire);
      }
      card.appendChild(rotation);
    }
    if (deliveryInspector?.ingress_id === ingress.ingress_id) {
      card.appendChild(inspectorView(ingress));
    }
    if (rejectionInspector?.ingress_id === ingress.ingress_id) {
      card.appendChild(rejectionInspectorView(ingress));
    }
    contextualizeCardActions(card, ingress);
    return card;
  };

  const render = (): void => {
    if (disposed) return;
    clear(root);
    const head = doc.createElement('div');
    head.className = 'wh-head';
    const copy = doc.createElement('div');
    const heading = doc.createElement('h2');
    heading.tabIndex = -1;
    heading.textContent = 'Webhooks coming in';
    copy.appendChild(heading);
    const subtitle = doc.createElement('p');
    subtitle.className = 'wh-copy';
    subtitle.textContent = 'Make a signed address for messages to arrive at, set it up at the other service, then switch it on yourself.';
    copy.appendChild(subtitle);
    head.appendChild(copy);
    const newButton = button(doc, 'New webhook', 'new', true);
    newButton.setAttribute(WEBHOOKS_PANEL_NEW_ATTR, '');
    newButton.disabled = busy || createProfiles().length === 0;
    if (createProfiles().length === 0) {
      newButton.title = 'This server has no webhook set-ups installed';
    }
    newButton.addEventListener('click', () => {
      showCreate = true;
      render();
      focusRendered(root, (element) =>
        element.getAttribute?.(WEBHOOKS_PANEL_FIELD_ATTR) === 'display_name');
    });
    head.appendChild(newButton);
    root.appendChild(head);
    if (error) {
      const errorNode = doc.createElement('div');
      errorNode.setAttribute(WEBHOOKS_PANEL_ERROR_ATTR, '');
      errorNode.textContent = error;
      root.appendChild(errorNode);
    }
    if (showCreate) root.appendChild(createForm());
    if (ingresses.length === 0 && !showCreate) {
      const empty = doc.createElement('div');
      empty.className = 'wh-empty';
      empty.textContent = busy ? 'Loading webhooks…' : 'No webhooks coming in yet.';
      root.appendChild(empty);
    }
    for (const ingress of ingresses) root.appendChild(ingressCard(ingress));
    restoreActionFocus();
  };

  const refresh = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    // Coalesce mount/manual refreshes and never race a list projection against
    // an authority-bearing mutation. An older response must not be able to
    // restore capabilities after a newer request has started.
    if (refreshInFlight !== null) return refreshInFlight;
    if (busy) return Promise.resolve();
    busy = true;
    error = null;
    render();
    const pending = (async (): Promise<void> => {
      try {
        const result = await options.runList();
        if (!disposed) applyListResult(result);
      } catch (cause) {
        if (!disposed) {
          // Capabilities are server-owned live authority. Preserve the last rows
          // for inspection/recovery, but expose no configuration authority after
          // a failed refresh.
          profileCapabilities = [];
          error = errorText(cause);
        }
      } finally {
        busy = false;
        if (!disposed) render();
      }
    })();
    refreshInFlight = pending;
    void pending.then(() => {
      if (refreshInFlight === pending) refreshInFlight = null;
    });
    return pending;
  };

  render();
  void refresh();
  return {
    refresh,
    whenLoaded: () => refreshInFlight ?? Promise.resolve(),
    getLoadError: () => error,
    hasInFlightWork: () => mutationInFlight,
    dispose() {
      if (disposed) return;
      disposed = true;
      oneTime = null;
      root.remove();
    },
  };
};
