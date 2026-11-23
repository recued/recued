/** D-201 Slices 5A + 5B2B1 + 5B2B2A + 5B2B2B1 + 5B2B2B2A + 6A + 6B1 + 6B2 + 6B3 + 7B + 7F + 7G + 8F + 8H + 8J + 9BO + 9BP + 10B — Settings → Connections → Webhooks.
 *
 * Profile descriptors drive every field and instruction. Secret values exist
 * only in a transient form/credential-write request or a one-time generated
 * response; persisted views expose field names/version metadata but cannot
 * carry the values back.
 */

import {
  MAX_ACTIVE_WEBHOOK_CREDENTIAL_VERSIONS,
  MAX_WEBHOOK_DEAD_LETTER_REASON_LENGTH,
  MAX_WEBHOOK_DELIVERY_PAGE_SIZE,
  MAX_WEBHOOK_EVENT_TYPES_PER_REQUIREMENT,
  validateWebhookEventTypeGrammar,
  webhookEventTypeGrammarAccepts,
  WEBHOOK_OWNER_PROFILE_SETTINGS,
  WEBHOOK_PROFILE_REGISTRY,
  webhookOwnerTextForEnvironment,
  type WebhookEventTypeCatalog,
  type WebhookEventTypeGrammar,
  type WebhookIngressUpdateRequest,
  type WebhookDeadLetterActionRequest,
  type WebhookDeadLetterServerReason,
  type WebhookDeadLetterActionResponse,
  type WebhookDeadLetterListCursor,
  type WebhookDeadLetterListRequest,
  type WebhookDeadLetterListResponse,
  type WebhookDeadLetterReviewSummary,
  type WebhookDeadLetterView,
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
  type WebhookIngressDoorSetRequest,
  type WebhookIngressStraysDismissRequest,
  type WebhookIngressManualConfirmRequest,
  type WebhookIngressRegistrationReconcileRequest,
  type WebhookIngressReadinessBlocker,
  type WebhookIngressRetireRequest,
  type WebhookIngressTestDeliveryRequest,
  type WebhookIngressTestDeliveryResponse,
  type WebhookIngressView,
  type WebhookIngressRecipeView,
  type WebhookStrayEndpointView,
  type WebhookDeduplicationPolicy,
  type WebhookProfileRuntimeCapabilityView,
  type WebhookOwnerProfileSettings,
  type WebhookProfileDescriptor,
} from '@recued/contracts';

import {
  createTriggerPreapprovalSupport,
  mountTriggerPreapprovalPanel,
  type TriggerPreapprovalPanelCallers,
  type TriggerPreapprovalPanelMount,
  type TriggerPreapprovalSupport,
} from '../contracts/trigger-preapproval-panel.js';
import type { BroadcastSubscriber } from '../realtime/subscriber.js';
// D-201 Slice 10AX — the owner's closing in the words Kitchen uses too.
import { ownerClosedDoorClause } from './webhook-door-words.js';

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
/** D-201 Slice 10X — a card's list of the recipes it starts, and each recipe in it. */
export const WEBHOOKS_PANEL_RECIPES_ATTR = 'data-recued-webhooks-recipes';
/** D-201 Slice 10AQ — the setups of a webhook left at the other service. */
export const WEBHOOKS_PANEL_STRAYS_ATTR = 'data-recued-webhooks-strays';
export const WEBHOOKS_PANEL_RECIPE_ATTR = 'data-recued-webhooks-recipe';
/** D-201 Slice 10B — the messages that did not reach their recipes. */
export const WEBHOOKS_PANEL_DEAD_LETTERS_ATTR = 'data-recued-webhooks-dead-letters';
export const WEBHOOKS_PANEL_DEAD_LETTER_ATTR = 'data-recued-webhooks-dead-letter';
export const WEBHOOKS_PANEL_DEAD_LETTER_REVIEW_ATTR = 'data-recued-webhooks-dead-letter-review';
/** D-201 Slice 10F — one closed dead letter, and the retire step's warning. */
export const WEBHOOKS_PANEL_CLOSED_DEAD_LETTER_ATTR = 'data-recued-webhooks-closed-dead-letter';
export const WEBHOOKS_PANEL_RETIRE_DEAD_LETTERS_ATTR = 'data-recued-webhooks-retire-dead-letters';
/** D-201 Slice 10C — the editor for which events a webhook takes. */
export const WEBHOOKS_PANEL_EVENTS_EDITOR_ATTR = 'data-recued-webhooks-events-editor';
export const WEBHOOKS_PANEL_EVENTS_NOTICE_ATTR = 'data-recued-webhooks-events-notice';

export const WEBHOOKS_PANEL_STYLES = `
[${WEBHOOKS_PANEL_ATTR}] { display: grid; gap: 14px; }
[${WEBHOOKS_PANEL_ATTR}] .wh-head { display:flex; gap:12px; align-items:center; justify-content:space-between; }
[${WEBHOOKS_PANEL_ATTR}] .wh-head>button {flex:none;white-space:nowrap}
@media(max-width:600px){[${WEBHOOKS_PANEL_ATTR}] .wh-head{align-items:flex-start;flex-direction:column}}
[${WEBHOOKS_PANEL_ATTR}] .wh-head h2 { margin:0; font-size:18px; }
[${WEBHOOKS_PANEL_ATTR}] .wh-copy { margin:3px 0 0; color:var(--muted); font-size:13px; line-height:1.45; }
[${WEBHOOKS_PANEL_ATTR}] .wh-actions { display:flex; flex-wrap:wrap; gap:8px; }
[${WEBHOOKS_PANEL_ATTR}] .wh-actions > .wh-note { flex-basis:100%; }
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
[${WEBHOOKS_PANEL_ATTR}] .wh-event-types .wh-event-custom { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:7px; align-items:end; }
[${WEBHOOKS_PANEL_ATTR}] .wh-event-types .wh-event-custom label { display:grid; gap:5px; align-items:stretch; font-weight:600; }
[${WEBHOOKS_PANEL_ATTR}] .wh-event-types .wh-event-custom input { width:100%; min-width:0; }
[${WEBHOOKS_PANEL_EVENTS_EDITOR_ATTR}] { display:grid; gap:9px; border-top:1px solid var(--border); padding-top:10px; }
[${WEBHOOKS_PANEL_ATTR}] .wh-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(210px,1fr)); gap:10px; }
[${WEBHOOKS_PANEL_CARD_ATTR}] { display:grid; gap:11px; }
[${WEBHOOKS_PANEL_ATTR}] .wh-card-head { display:flex; gap:10px; justify-content:space-between; align-items:flex-start; }
[${WEBHOOKS_PANEL_ATTR}] .wh-card-head > button { flex:none; }
[${WEBHOOKS_PANEL_ATTR}] .wh-card-head h3 { margin:0; font-size:15px; }
[${WEBHOOKS_PANEL_ATTR}] details > summary { cursor:pointer; margin:4px 0; color:var(--fg); font-size:13px; font-weight:600; }
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
[${WEBHOOKS_PANEL_DEAD_LETTERS_ATTR}] { display:grid; gap:9px; border-top:1px solid var(--border); padding-top:10px; }
[${WEBHOOKS_PANEL_DELIVERY_ATTR}], [${WEBHOOKS_PANEL_EVENT_ATTR}], [${WEBHOOKS_PANEL_REJECTION_ATTR}], [${WEBHOOKS_PANEL_DEAD_LETTER_ATTR}], [${WEBHOOKS_PANEL_CLOSED_DEAD_LETTER_ATTR}] { border:1px solid var(--border); border-radius:7px; padding:9px; display:grid; gap:7px; background:var(--surface-sunk); }
[${WEBHOOKS_PANEL_PAYLOAD_ATTR}] { margin:0; padding:9px; border-radius:7px; overflow:auto; max-height:320px; white-space:pre-wrap; overflow-wrap:anywhere; background:var(--surface); font-size:11px; }
[${WEBHOOKS_PANEL_ATTR}] .wh-empty { padding:20px; border:1px dashed var(--border-strong); border-radius:9px; text-align:center; color:var(--muted); font-size:13px; }
`;

export type WebhooksListCaller = () => Promise<{
  ingresses: readonly WebhookIngressView[];
  /** Optional only for rolling client/server compatibility. Absence exposes no
   * create or managed-registration authority. Production always projects it. */
  profiles?: readonly WebhookProfileRuntimeCapabilityView[];
  /** D-201 Slice 10B — the server's unresolved dead letters against its limit. */
  dead_letter_review?: WebhookDeadLetterReviewSummary;
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
/** D-201 Slice 10AF — one recipe's own door switch (`webhook.ingress.door.set`). */
export type WebhooksDoorSetCaller = (
  args: WebhookIngressDoorSetRequest,
) => Promise<{ ingress: WebhookIngressView }>;
/** D-201 Slice 10AL (10AI finding 21) — the owner removed the endpoints Recued
 *  stopped trying to remove (`webhook.ingress.strays.dismiss`). */
export type WebhooksStraysDismissCaller = (
  args: WebhookIngressStraysDismissRequest,
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
export type WebhooksUpdateCaller = (
  args: WebhookIngressUpdateRequest,
) => Promise<{ ingress: WebhookIngressView }>;
export type WebhooksDeadLetterListCaller = (
  args: WebhookDeadLetterListRequest,
) => Promise<WebhookDeadLetterListResponse>;
export type WebhooksDeadLetterRequeueCaller = (
  args: WebhookDeadLetterActionRequest,
) => Promise<WebhookDeadLetterActionResponse>;
export type WebhooksDeadLetterResolveCaller = (
  args: WebhookDeadLetterActionRequest,
) => Promise<WebhookDeadLetterActionResponse>;
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
  /** D-201 Slice 10AF — each recipe's own door switch, for a webhook that
   *  starts several. Absent: its doors open by switching the webhook on. */
  runDoorSet?: WebhooksDoorSetCaller;
  /** D-201 Slice 10AL — the owner removed the endpoints Recued gave up on. */
  runStraysDismiss?: WebhooksStraysDismissCaller;
  runTestDelivery?: WebhooksTestDeliveryCaller;
  runRetire?: WebhooksRetireCaller;
  runRetentionPrune?: WebhooksRetentionPruneCaller;
  runDeliveryList?: WebhooksDeliveryListCaller;
  runDeliveryGet?: WebhooksDeliveryGetCaller;
  runDeliveryEventGet?: WebhooksDeliveryEventGetCaller;
  runRejectedDeliveryList?: WebhooksRejectedDeliveryListCaller;
  /** D-201 Slice 10C — change which events an existing webhook takes. */
  runUpdate?: WebhooksUpdateCaller;
  /** D-201 Slice 10B — review the messages that did not reach their recipes:
   *  all three, or the card offers none of it. */
  runDeadLetterList?: WebhooksDeadLetterListCaller;
  runDeadLetterRequeue?: WebhooksDeadLetterRequeueCaller;
  runDeadLetterResolve?: WebhooksDeadLetterResolveCaller;
  /** D-341 slice B2b — "What it may do without asking" on each webhook's card: its pre-approvals,
   *  and the writes the recipes it runs could make without asking. Absent, no card offers it. */
  triggerPreapprovals?: TriggerPreapprovalPanelCallers;
  /** D-402 — each card's pre-approvals read again when one changes anywhere. */
  subscribe?: BroadcastSubscriber['on'];
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

interface DeadLetterInspectorState {
  ingress_id: string;
  dead_letters: WebhookDeadLetterView[];
  next_cursor: WebhookDeadLetterListCursor | null;
  loaded: boolean;
  /** What the owner has typed as each one's reason, by `deadLetterKey`. */
  reasons: Map<string, string>;
  /** What the last action did, for a screen reader and the eye. */
  notice: string | null;
  /** D-201 Slice 10F — the closed ones, once the owner asked to see them. */
  closed: {
    dead_letters: WebhookDeadLetterView[];
    next_cursor: WebhookDeadLetterListCursor | null;
    loaded: boolean;
  } | null;
}

/** D-201 Slice 10F — why Recued closed one itself, in the owner's words. */
const SERVER_CLOSE_REASON: Readonly<Record<WebhookDeadLetterServerReason, string>> = {
  review_limit: 'More than 1,000 were waiting, and this was the oldest.',
  webhook_retired: 'This webhook was retired.',
  recipe_removed: 'Its recipe was removed.',
  recipe_disarmed: 'Its recipe was switched off.',
  // D-201 Slice 10Y (10V findings 7 and 17) — a pack update closes them so too.
  recipe_replaced: 'Its recipe was saved or updated with a different webhook setup, so it may not take it now.',
};

const closureText = (
  closure: NonNullable<WebhookDeadLetterView['closure']>,
  /** D-201 Slice 10AD (10AA finding 17) — its own problem: the review limit
   *  closes the ones no door let run first, whatever their age. */
  code: string | null = null,
): string => {
  if (closure.closed_by === 'owner') {
    return closure.reason === null || closure.reason.length === 0
      ? 'You closed it.'
      : `You closed it: ${closure.reason}`;
  }
  const words = closure.reason === 'review_limit' && (code === 'door_missing' || code === 'door_closed')
    ? 'More than 1,000 were waiting, and those no door let run are closed first.'
    : closure.reason !== null
      && Object.prototype.hasOwnProperty.call(SERVER_CLOSE_REASON, closure.reason)
      ? SERVER_CLOSE_REASON[closure.reason as WebhookDeadLetterServerReason]
      : null;
  return words === null ? 'Recued closed it.' : `Recued closed it. ${words}`;
};

const deadLetterKey = (deadLetter: Pick<WebhookDeadLetterView, 'kind' | 'dead_letter_id'>): string =>
  `${deadLetter.kind}:${deadLetter.dead_letter_id}`;

/** Why a webhook cannot let messages in, in the owner's words. D-339 slice 21: also shown by Connect Apple Health on
 *  a Body's page (`yours/bootstrap-yours-route.ts`), so the two pages say it the same way. */
export const blockerLabel: Record<WebhookIngressReadinessBlocker, string> = {
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
  // Raised when either half is off (`compose-listeners.ts` runtime readiness),
  // so the label names both. Until 2026-10-10 it named only the environment
  // variable, because the server did not read the config key yet.
  public_reachability_disabled: 'Let it in from the internet: tick Public for /webhooks under Settings → Server → Exposure, and set "collection.webhook.public_reachable" = true in config.toml',
  tls_unavailable: 'You need a trusted public https address',
  clock_unverified: 'Recued has not checked that your clock is right',
  vault_locked: 'Unlock your server’s keys',
  server_paused: 'Start the paused server again',
  retired: 'This webhook is closed for good',
};

/** D-201 Slice 10G — the names a vendor did not keep, from a refusal's
 *  details: short printable names only, so nothing else reaches the page. */
const skippedEventNames = (error: unknown): string[] => {
  const details = (error as { details?: unknown } | null)?.details;
  const names = details !== null && typeof details === 'object'
    ? (details as { event_types?: unknown }).event_types
    : undefined;
  return Array.isArray(names)
    ? names.filter((name): name is string => typeof name === 'string'
      && name.length > 0
      && name.length <= 128
      && /^[\x21-\x7e]+$/.test(name)).slice(0, MAX_WEBHOOK_EVENT_TYPES_PER_REQUIREMENT)
    : [];
};

/** D-201 Slice 10O — said when the service fell back to its default set and
 *  could not be put back to the events it had. */
const LEFT_ON_DEFAULT_TEXT = 'It could not be put back to the events it had, so it may now send every kind of event.';

/** D-201 Slice 10Z (10V finding 25) — said instead when it was on its default
 *  set already: nothing was put back, since nothing changed. */
const ON_DEFAULT_TEXT = 'It was on its default set of events already, so it may send every kind of event.';

/** D-201 Slice 10U (10Q finding 9) — a message its recipe never ran because the
 *  recipe's webhook has no door, or its door is switched off: kept for the
 *  owner, where before it was cancelled unseen. */
/** D-201 Slice 10X (10V finding 12) — a door-less dead letter, and a remedy
 *  the owner can take: the webhook's card opens the door (the owner's ruling of
 *  2026-11-19). 10U said to save the recipe again (refused for a pack's) or to
 *  switch the door on under Contracts (which has no such switch). A server
 *  before 10X lists no recipes on the card, so it cannot be opened from here. */
const doorText = (door: 'missing' | 'closed', opensHere: boolean): string =>
  (door === 'missing'
    ? "Its recipe never ran it: there is no door behind the recipe's webhook. "
    : "Its recipe never ran it: the door behind the recipe's webhook is closed. ")
  + (opensHere
    ? 'Open its door under "Recipes it starts" above, then try it again.'
    : 'Update Recued on your server to open it from here.');

/** D-201 Slice 10X — a recipe's door on its webhook's card, in words: open,
 *  missing (and why, when the server can tell), or closed. The switch here is
 *  the owner's control (the owner's ruling of 2026-11-19): opening a door
 *  switches the webhook on again, which makes every door that is not open. */
export const recipeDoorText = (recipe: WebhookIngressRecipeView): string => {
  if (!recipe.armed) return 'Its own webhook switch is off, in Kitchen, so nothing starts it.';
  if (recipe.door === 'open') return 'Its door is open: what is let in starts it.';
  // D-201 Slice 10AF — closed by the owner's own switch: what is sent to it
  // waits, as messages that did not reach their recipe. D-201 Slice 10AJ
  // (10AI finding 10) — opening the door runs none of them: each is tried
  // again. This said they waited "until you open it again".
  // D-201 Slice 10AO (10AM finding 15) — closed before its door was made:
  // its messages wait as having no door, which is how that list words them.
  // It said "You closed its door" beside messages that said there was none.
  // D-201 Slice 10AX (10AS findings 10 and 13) — in the words Kitchen uses
  // (`ownerClosedDoorClause`): closed before its door was made only when it
  // was, and with no door now, why. A door its owner closed after it was made,
  // its rows door-less since, was said to be closed before it was made.
  // D-201 Slice 10BE (10AY finding 16) — why a door cannot be made for it as it
  // stands, whether or not a closed one stands: opening it would make one.
  if (recipe.door === 'closed' && recipe.closed_by_owner === true) {
    return ownerClosedDoorClause(recipe)
      + (recipe.no_door_yet === true ? ' and what is sent to it does not run.' : ', so what is sent to it does not run.')
      + closedDoorReason(recipe)
      + ' It waits with the messages that did not reach their recipes, to try again once you open the door.';
  }
  if (recipe.door === 'closed') {
    const why = closedDoorReason(recipe);
    return `Its door is closed, so nothing it is sent runs.${why === '' ? ' Open it to let it run again.' : why}`;
  }
  const reason = doorReasonSentence(recipe);
  if (reason === '') return 'It has no door yet, so nothing it is sent runs. Open it to make one.';
  switch (recipe.door_reason_code) {
    case 'no_account':
      return `It has no door yet: ${reason} Choose its account in its settings, then open its door.`;
    case 'fault':
      return `Recued could not make its door: ${reason} Open it to try again.`;
    default:
      return `It cannot have a door as it stands: ${reason} Change the recipe, then open its door.`;
  }
};

/** D-201 Slice 10BE (10AY finding 18) — the server's reason as a sentence: an
 *  exposure refusal or a fault comes with no closing stop, and the advice after
 *  it ran on ("…it reads Records Change the recipe…"). */
const doorReasonSentence = (recipe: WebhookIngressRecipeView): string => {
  const reason = recipe.door_reason?.trim() ?? '';
  return reason === '' || /[.!?]$/.test(reason) ? reason : `${reason}.`;
};

/** D-201 Slice 10AX (10AS finding 10) — why a recipe whose door is closed
 *  cannot have one made, when the server can tell, and what opening it would
 *  need. D-201 Slice 10BE (10AY findings 16 and 18) — for a closed door that
 *  still stands too; and the server's reason, which begins in lower case,
 *  follows a colon, as it does where the door is missing. */
const closedDoorReason = (recipe: WebhookIngressRecipeView): string => {
  const reason = doorReasonSentence(recipe);
  if (reason === '') return '';
  switch (recipe.door_reason_code) {
    case 'no_account':
      return ` It cannot have a door until its account is chosen: ${reason} Choose its account in its settings before you open it.`;
    case 'fault':
      return ` Recued could not check whether it can have one: ${reason}`;
    default:
      return ` It cannot have a door as it stands: ${reason} Change the recipe before you open it.`;
  }
};

/** A dead letter's last problem: the two door codes in words, any other as it is. */
/** D-201 Slice 10W (10V finding 1; the owner's call, 2026-11-19) — an approved
 *  run a restart stopped, in words: which step is in doubt, and what trying it
 *  again does. It goes on from that step, everything before it standing in, so
 *  only that step can run twice. Shown raw before 10W. */
const inDoubtText = (held: WebhookDeadLetterView['held_try_again']): string => {
  // D-201 Slice 10AV (10AS finding 15) — no restart is claimed where none may
  // have happened: a step's own unconfirmed outcome, and a hold Recued could
  // not write, are kept so too. Logs say which.
  if (held === undefined) {
    return 'Recued cannot tell whether a step of its approved run that sends something went through (Logs say '
      + 'which, and why). Check before trying it again: trying it again runs the recipe from its first step.';
  }
  // D-201 Slice 10AB (10AA finding 4) — what the run kept is another version's.
  if (held.recipe_changed === true) {
    return 'The server restarted during its approved run, and the recipe has changed since, so what that run kept '
      + 'cannot stand in for this version\'s steps. Check before trying it again: trying it again runs the recipe '
      + `from its first step, so the steps that went through run again, and each step that needs your approval, `
      + `such as '${held.step_id}', asks you again.`;
  }
  const goesOn = held.asks_again === true
    ? `asks you for '${held.step_id}' again and goes on from it`
    : `goes on from '${held.step_id}'`;
  // D-201 Slice 10AP (10AM finding 4) — a stop without warning left how far it
  // got unknown, and a try again since failed: both said. The wording below
  // said only that the server stopped, or only that one step could run twice.
  if (held.progress_unknown === true && held.failed === true) {
    return `Tried again, its approved run failed at '${held.step_id}', and Recued cannot tell how far an earlier `
      + 'run got, the server having stopped without warning. Check why in Logs before trying it again: trying it '
      + `again ${goesOn}, with what ran before it kept, so that step and each step after it can run twice.`;
  }
  if (held.progress_unknown === true) {
    return held.asks_again === true
      ? `The server stopped without warning during its approved run, so Recued cannot tell how far it got. Check `
        + `before trying it again: trying it again asks you for '${held.step_id}' again, and the steps after it `
        + 'run again too.'
      // D-201 Slice 10AB (10AA finding 1) — it went during the owner's try again.
      : `The server stopped without warning while its approved run was tried again, so Recued cannot tell how far `
        + `it got. Check before trying it again: trying it again goes on from '${held.step_id}', with what ran `
        + 'before it kept, so that step and each step after it can run twice.';
  }
  // D-201 Slice 10BC (10AY findings 2 and 9) — Recued could not keep what ran
  // after it: an approved step it cannot keep once the run went past it, or a
  // row a later write could not replace. Settings said only that step could
  // run twice, and the try again sent again each later step that went through.
  if (held.later_run_again === true) {
    const rest = held.asks_again === true
      ? `asks you for '${held.step_id}' again, and the steps after it that ran run again too.`
      : `goes on from '${held.step_id}', with what ran before it kept, so that step and each step after it that `
        + 'ran can run twice.';
    // D-201 Slice 10BH (10BF finding 1) — held at the approved step, which
    // Recued cannot keep, after a try again that failed at it or past it: it
    // said the run failed at that step, and the try again may have gone past
    // it first. Logs say where.
    return (held.failed === true && held.asks_again === true && held.handoff_unproven === true
      // D-201 Slice 10BP (10BM finding 12) — a hand-off it cannot check, after a
      // try again that failed: what the run did was kept, only the hand-off is
      // unproven. It said Recued could not keep what ran after it.
      ? `Tried again, its approved run failed, and '${held.step_id}' had handed its work on and returned no `
        + 'hand-off Recued can check. Check why in Logs before trying it again: '
      : held.failed === true && held.asks_again === true
      ? `Tried again, its approved run failed, and Recued could not keep what ran after '${held.step_id}'. `
        + 'Check why in Logs before trying it again: '
      : held.failed === true
      ? `Tried again, its approved run failed at '${held.step_id}', and Recued could not keep how far an earlier `
        + 'run got past it. Check why in Logs before trying it again: '
      // D-201 Slice 10BI (10BF finding 5) — a hand-off it cannot check: what
      // the run did is kept. It said Recued could not keep how far it got.
      : held.handoff_unproven === true
      ? handoffUnprovenText(held.step_id)
      : `Recued cannot tell whether '${held.step_id}' went through, and could not keep how far its approved run got `
        + 'after it (Logs say why). Check before trying it again: ')
      + `trying it again ${rest}`;
  }
  // D-201 Slice 10AB (10AA finding 2) — the try again failed rather than stopped.
  if (held.failed === true) {
    // D-201 Slice 10BV (10BS finding 8) — a hand-off it cannot check, as with
    // the steps after it (10BP): it was worded as any failed step.
    return (held.handoff_unproven === true
      ? `Tried again, its approved run failed, and '${held.step_id}' had handed its work on and returned no `
        + 'hand-off Recued can check. Check why in Logs before trying it again: '
      : `Tried again, its approved run failed at '${held.step_id}'. Check why in Logs before trying it again: `)
      + `trying it again ${goesOn}, with what ran before it kept, so only that step can run twice.`;
  }
  // D-201 Slice 10AV (10AS finding 15) — it said the server restarted, also
  // for a hold the answer could not write, where none had.
  // D-201 Slice 10BI (10BF finding 5) — and nothing after it ran.
  if (held.handoff_unproven === true) {
    return `${handoffUnprovenText(held.step_id)}trying it again ${goesOn}, with what ran before it kept, so only that `
      + 'step can run twice.';
  }
  return `Recued cannot tell whether '${held.step_id}' went through (Logs say why). Check before trying it again: `
    + `trying it again ${goesOn}, with what ran before it kept, so only that step can run twice.`;
};

/** D-201 Slice 10BI (10BF finding 5) — an approved step that handed its work on
 *  and returned no hand-off its receipt can check. */
const handoffUnprovenText = (stepId: string): string =>
  `'${stepId}' handed its work on and returned no hand-off Recued can check, so Recued cannot prove it went `
  + 'through. Check before trying it again: ';

const deadLetterProblemText = (
  code: string | null,
  opensHere: boolean,
  held?: WebhookDeadLetterView['held_try_again'],
): string =>
  code === 'door_missing' ? doorText('missing', opensHere)
    : code === 'door_closed' ? doorText('closed', opensHere)
      : code === 'approved_run_in_doubt' ? inDoubtText(held)
        : code === 'restart_interrupted'
          ? 'The server restarted during its approved run before Recued could keep it. Check before trying it '
            + 'again: trying it again runs the recipe from its first step.'
          : code ?? 'Not given';

/** D-201 Slice 10T (10Q finding 19) — names the service did not set up, in
 *  words: those it does not have, and those it never lists back
 *  (`never_listed` on its profile's catalog), which no spelling would fix. */
const refusedNamesText = (names: readonly string[], neverListed: readonly string[]): string => {
  const unlisted = names.filter((name) => neverListed.includes(name));
  const unknown = names.filter((name) => !neverListed.includes(name));
  const parts: string[] = [];
  if (names.length === 0) {
    parts.push('The service does not have some of these events, so it did not set them up.');
  } else if (unknown.length > 0) {
    parts.push(`The service does not have ${unknown.length === 1 ? 'an event named' : 'events named'} ${unknown.join(', ')}, so it did not set ${unknown.length === 1 ? 'it' : 'them'} up.`);
  }
  if (unlisted.length > 0) {
    parts.push(`The service never lists ${unlisted.length === 1 ? 'the event' : 'the events'} ${unlisted.join(', ')}, so a webhook set up with ${unlisted.length === 1 ? 'it' : 'them'} could never be confirmed.`);
  }
  return parts.join(' ');
};

/** D-201 Slice 10AU (10AS finding 28) — every other code a webhook's last
 *  error can hold, in the owner's words: the row showed the code itself, such
 *  as `managed_remote_missing`. */
const HEALTH_ERROR_WORDS: Readonly<Record<string, string>> = Object.freeze({
  managed_registration_drift: 'The setup at the other service may not match this webhook.',
  // D-201 Slice 10BG (10BF finding 13) — it reached only the server's log.
  managed_registration_certificate_unheld: 'Its setup at the other service uses a certificate set there, which '
    + 'Recued does not hold, so Recued did not set it again: setting it would remove that certificate.',
  managed_remote_missing: 'What Recued set up at the other service is no longer there.',
  managed_registration_unconfirmed: 'Recued could not confirm that what it set up at the other service is there.',
  // D-201 Slice 10BT (10BS finding 1) — not "at this address": a setup labelled
  // as this webhook's but sending elsewhere refuses it too, beside a notice
  // that says it sends to another address.
  managed_registration_ambiguous: 'The other service has a setup that Recued cannot tell apart from another, or '
    + 'prove is this webhook\'s, so it changed nothing there.',
  managed_cleanup_unconfirmed: 'Recued could not confirm that it removed this webhook from the other service.',
  managed_cleanup_ambiguous: 'The other service has setups at this address that Recued cannot tell apart, so it '
    + 'removed none.',
  paired_connection_deleted: 'The connection this webhook was set up through was deleted.',
  unsupported_delivery: 'A message came in a form this webhook does not take, and was refused.',
  profile_dependency_unavailable: 'Recued could not check a message, as something it needs for that was '
    + 'unavailable, and told the other service to try it again later.',
  profile_internal_error: 'Recued failed while checking a message, and told the other service to try it again '
    + 'later.',
});

/** A code this page has no words for, from a newer server: never shown as
 *  the code. */
const UNKNOWN_HEALTH_ERROR_TEXT = 'Something went wrong that this page has no words for.';

/** D-201 Slice 10K (10H finding 17) — the stored code a refusal for unknown
 *  event names leaves, in words with the names. D-201 Slice 10O — and the
 *  code that says the service was left sending every kind of event. D-201
 *  Slice 10AU (10AS finding 28) — any other code in words too
 *  (`HEALTH_ERROR_WORDS`), never as it is. */
const healthErrorText = (
  health: WebhookIngressView['health'],
  /** D-201 Slice 10T — the names its service never lists. */
  neverListed: readonly string[] = [],
): string => {
  if (health.last_error_code !== 'managed_registration_event_types_unknown'
    && health.last_error_code !== 'managed_registration_event_types_unrestored'
    && health.last_error_code !== 'managed_registration_event_types_on_default') {
    if (health.last_error_code === null) return 'None';
    return Object.prototype.hasOwnProperty.call(HEALTH_ERROR_WORDS, health.last_error_code)
      ? HEALTH_ERROR_WORDS[health.last_error_code]!
      : UNKNOWN_HEALTH_ERROR_TEXT;
  }
  const names = skippedEventNames({ details: { event_types: health.last_error_event_types } });
  const refused = refusedNamesText(names, neverListed);
  return health.last_error_code === 'managed_registration_event_types_unrestored'
    ? `${refused} ${LEFT_ON_DEFAULT_TEXT}`
    : health.last_error_code === 'managed_registration_event_types_on_default'
      ? `${refused} ${ON_DEFAULT_TEXT}`
      : refused;
};

/** D-201 Slice 10AH (10AE finding 8) — earlier setups of this webhook still at
 *  the other service, which Recued keeps removing, until a week of failed
 *  tries. D-201 Slice 10AL (10AI finding 20) — it said Recued could not remove
 *  them "when you changed the connection", which a change that failed never
 *  did. */
export const strayEndpointsText = (count: number): string => {
  const one = count === 1;
  return `${one ? 'An earlier setup' : `${count} earlier setups`} of this webhook ${one ? 'is' : 'are'} still at the `
    + `other service, and Recued keeps trying to remove ${one ? 'it' : 'them'}. If ${one ? 'it' : 'they'} cannot `
    + 'be removed for a week, Recued stops and says so here.';
};

/** D-201 Slice 10BA (10AY finding 4) — endpoints at this webhook's address the
 *  search could not prove are this webhook's (changed at the service): Recued
 *  never removes those. The card said it kept trying to remove one, then that
 *  it stopped after a week of failed tries, and no removal was ever sent. */
export const unprovenStrayEndpointsText = (count: number): string => {
  const one = count === 1;
  return `${one ? 'An endpoint' : `${count} endpoints`} at the other service ${one ? 'sends' : 'send'} to this `
    + `webhook's address, but Recued cannot prove ${one ? 'it is an earlier setup' : 'they are earlier setups'} of `
    + `this webhook (${one ? 'it was' : 'they were'} changed there), so it does not remove ${one ? 'it' : 'them'}. `
    + `Check ${one ? 'it' : 'them'} there, and remove ${one ? 'it' : 'them'} yourself if ${one ? 'it is' : 'they are'}. `
    + `After a week Recued stops looking and says so here.`;
};

/** D-201 Slice 10BQ (10BM finding 13) — an unproven one the search found
 *  sending to another address: labelled as this webhook's at the service, but
 *  changed there. It was said to send to this webhook's address. */
export const unprovenElsewhereStrayEndpointsText = (count: number): string => {
  const one = count === 1;
  return `${one ? 'An endpoint' : `${count} endpoints`} at the other service ${one ? 'is' : 'are'} labelled as `
    + `${one ? 'an earlier setup' : 'earlier setups'} of this webhook but ${one ? 'sends' : 'send'} to another `
    + `address, so Recued cannot prove ${one ? 'it is one' : 'they are'} (${one ? 'it was' : 'they were'} changed `
    + `there) and does not remove ${one ? 'it' : 'them'}. Check ${one ? 'it' : 'them'} there, and remove `
    + `${one ? 'it' : 'them'} yourself if ${one ? 'it is' : 'they are'}. After a week Recued stops looking and says `
    + 'so here.';
};

/** D-201 Slice 10AN (the owner's call, 2026-11-20) — messages refused for
 *  their signature, none verified since: what Recued does about it, or what
 *  the owner can. The webhook read healthy while it refused every message.
 *  D-201 Slice 10AR (10AM findings 11 and 30) — it says only what the server
 *  knows: messages to the address that did not verify with the secret this
 *  webhook holds, a signature or a token or a password. Who sent them it
 *  cannot know, as anyone with the address can, so what the owner can do
 *  starts from what the other service shows. Told the other service signed
 *  them, an owner could set a webhook up again at its service for an
 *  outsider's requests. */
export const refusingText = (
  refusing: NonNullable<WebhookIngressView['health']['refusing']>,
  registrationMode: WebhookIngressView['registration_mode'],
  when: (at: number) => string = (at) => new Date(at).toLocaleString(),
  /** D-201 Slice 10AQ (10AM finding 24) — earlier setups still at the service. */
  strays = 0,
  /** D-201 Slice 10AU (10AS finding 28) — the webhook's profile: what the owner
   *  can do about a secret Recued does not set depends on who makes it. */
  profileId?: string,
  /** D-201 Slice 10BG (10BF finding 13) — the webhook's last problem: a set
   *  again refused over a certificate set at the service. */
  lastErrorCode?: string | null,
  /** D-201 Slice 10BT (10BS finding 1) — the earlier setups beside which
   *  setting this webhook up again can be refused: every one still at the
   *  service, those found sending elsewhere too, which `strays` (those that
   *  may send what is refused here) leaves out. Absent: `strays`. */
  blocking?: number,
): string => {
  const refused = `At least ${refusing.refused} messages to this webhook's address since ${when(refusing.since)} `
    + 'could not be verified with the secret it holds, and no message has been verified since. They may come '
    + 'from the other service, or from anyone who has the address.';
  // D-201 Slice 10AQ (10AM finding 24) — a setup left at the service signs
  // with a secret this webhook does not hold, so what it sends is refused here:
  // said beside it. The advice below touches none of them.
  const run = strays > 0
    ? `${refused} Some may come from ${strays === 1 ? 'the earlier setup' : 'the earlier setups'} of this webhook `
      + `still at the other service, which ${strays === 1 ? 'signs' : 'sign'} with a secret this webhook does not `
      + `hold: removing ${strays === 1 ? 'it' : 'them'} there stops those.`
    : refused;
  // D-201 Slice 10AT (10AS finding 2) — beside earlier setups still at the
  // service, a switch off and on can leave the webhook off: setting it up again
  // meets them and is refused, as unconfirmed when one cannot be removed, as
  // ambiguous when two stand at its account and address. So they go first.
  // D-201 Slice 10BT (10BS finding 1) — counted apart from `strays`: one found
  // sending elsewhere sends nothing refused here, but still refuses setting
  // this webhook up again. 10BQ left it out of both, and beside it the card
  // said to switch the webhook off and on, which left it off.
  const before = blocking ?? strays;
  const offAndOn = before > 0
    ? `remove ${before === 1 ? 'the earlier setup' : 'the earlier setups'} there first, then switch this webhook `
      + `off and on (beside ${before === 1 ? 'it' : 'them'}, setting it up again can be refused and leave it off)`
    : 'switch this webhook off and on';
  if (refusing.set_again === true) {
    // D-201 Slice 10AR (10AM finding 10) — at most once an hour, done or
    // failed; a try that failed is said, never promised again. D-201 Slice
    // 10AU (10AS finding 28) — and what the owner can do when it keeps
    // failing: it said only when Recued tries again, so a connection that may
    // no longer change webhooks there failed every hour, unsaid.
    // D-201 Slice 10BG (10BF finding 13) — refused over a certificate set at
    // the service: switching it off and on, the advice for any other failure,
    // sets it up again without that certificate, so that is said for what it is.
    if (refusing.set_again_failed_at !== undefined && lastErrorCode === 'managed_registration_certificate_unheld') {
      return `${run} Recued did not set this webhook again at the other service, at `
        + `${when(refusing.set_again_failed_at)}: its setup there uses a certificate set there, which Recued does `
        + 'not hold, and setting it again would remove it. To keep that certificate, set a webhook up there yourself '
        + 'instead; switching this one off and on sets it up again without the certificate.';
    }
    if (refusing.set_again_failed_at !== undefined) {
      return `${run} Recued tried to set this webhook again at the other service, with the secret it holds, at `
        + `${when(refusing.set_again_failed_at)}, and could not. It tries again an hour after that. If it keeps `
        + 'failing, check that the connection this webhook uses can still change webhooks at the other service, '
        + `and ${offAndOn}.`;
    }
    // D-201 Slice 10AU (10AS finding 5) — no longer once a run: again, at most
    // once an hour, while messages are still refused after the last.
    return refusing.set_again_at !== undefined
      ? `${run} Recued set this webhook again at the other service, with the secret it holds, at `
        + `${when(refusing.set_again_at)}, and sets it again, at most once an hour, while messages are still `
        + 'refused after that. If the other service still shows the messages it sends here failing, something '
        + `else may be setting it there: ${offAndOn}.`
      : `${run} Recued sets this webhook again at the other service, with the secret it holds, at most once an hour.`;
  }
  if (registrationMode === 'managed_endpoint') {
    return `${run} If the other service shows the messages it sends here failing, ${offAndOn}: `
      + 'Recued sets it up there again, with a new secret. If it shows none failing, nothing needs doing.';
  }
  const { noun, advice } = ownerSecretAdvice(profileId);
  // D-201 Slice 10AU (10AS finding 28) — it said Recued does not set such a
  // webhook up there: a recipe's operation gives it the address (§6.3).
  const bound = registrationMode === 'operation_bound'
    ? ` The recipe that uses this webhook gives the other service its address, but not its ${noun}.`
    : '';
  return `${run}${bound} If the other service shows the messages it sends here failing, ${advice} If it shows `
    + 'none failing, nothing needs doing.';
};

/** D-201 Slice 10AU (10AS finding 28) — what the owner can do about a secret
 *  Recued does not set, by who makes it, named as the keys form names it. The
 *  card said to check that the secret there is the one this webhook holds,
 *  which cannot be done where neither end shows it again (some services never
 *  show a secret back, and this card shows one Recued makes once), and Basic
 *  auth checks a username too. A webhook a recipe's operation gives its address
 *  to was said to be one Recued does not set up there: it gives the address,
 *  not the secret. */
export const ownerSecretAdvice = (
  profileId: string | undefined,
): { readonly noun: string; readonly advice: string } => {
  const profile = profileId === undefined ? null : descriptorFor(profileId);
  const keys = (profile?.fields ?? []).filter((field) => field.kind === 'secret'
    || field.kind === 'password'
    || field.kind === 'private_key'
    || field.kind === 'username');
  const several = keys.length > 1;
  const noun = keys.length === 0 ? 'secret' : keys.map((field) => `“${field.label}”`).join(' and ');
  const swap = '“Swap the keys”';
  const sources = new Set(keys.map((field) => field.source));
  const advice = keys.length === 0
    ? `check that the other service sends the secret this webhook holds; if you cannot tell, enter a new one there `
      + `and here, with ${swap}.`
    : sources.has('vendor_generated')
      ? `check that this webhook holds the ${noun} the other service shows for it, and if not, enter `
        + `${several ? 'those' : 'that one'} here with ${swap}.`
      : sources.has('recued_generated')
        ? `make a new ${noun} here with ${swap} and put ${several ? 'them' : 'it'} into the other service: Recued `
          + `shows ${several ? 'those' : 'one'} it makes only once, and the other service may never show `
          + `${several ? 'them' : 'it'} back.`
        : `check that the ${noun} there ${several ? 'are the ones' : 'is the one'} you gave this webhook; if the `
          + `other service does not show ${several ? 'them' : 'it'}, enter ${several ? 'new ones' : 'a new one'} `
          + `there and here, with ${swap}.`;
  return { noun, advice };
};

/** D-201 Slice 10AR (10AM finding 11) — a run of refusals is read only while the
 *  webhook takes messages: a server before 10AR sent it for one switched off
 *  too, whose card then said Recued sets it again. */
const refusingShown = (ingress: Pick<WebhookIngressView, 'intake_state' | 'health'>):
  NonNullable<WebhookIngressView['health']['refusing']> | undefined =>
  ingress.intake_state === 'enabled' || ingress.intake_state === 'degraded'
    ? ingress.health.refusing
    : undefined;

/** D-201 Slice 10AQ (10AM finding 7) — each stray, as the other service names
 *  it, and the connection whose account it is at; then this webhook's own
 *  endpoint, when one is at the same account, whose removal stops messages
 *  coming in. The card counted them only. */
export const namedStraysText = (strays: readonly WebhookStrayEndpointView[]): string => {
  const names = strays.map((stray) => `${stray.remote_endpoint_id === null
    ? 'an endpoint Recued kept no id for'
    : `the endpoint ${stray.remote_endpoint_id}`} at the connection ${stray.connection_id}`);
  return `${strays.length === 1 ? 'It is' : 'They are'} ${names.join('; ')}.`;
};

/** D-201 Slice 10AT (10AS finding 22) — the webhook's own endpoint, when a stray
 *  stands at the same account: said once, beside all of them, and as its state
 *  has it. "Removing that one stops messages coming in" is true only while it
 *  takes messages; switched off or retired with its clean-up pending, nothing
 *  comes in and Recued is removing that endpoint itself. Said in each block, it
 *  could appear twice. */
export const ownEndpointText = (
  ingress: Pick<WebhookIngressView, 'remote_endpoint_id' | 'paired_connection_id' | 'intake_state' | 'registration_state'>
    & Partial<Pick<WebhookIngressView, 'pending_paired_connection_id'>>,
  strays: readonly WebhookStrayEndpointView[],
): string | null => {
  if (ingress.remote_endpoint_id === null
    || !strays.some((stray) => stray.connection_id === ingress.paired_connection_id)) return null;
  const own = `This webhook's own endpoint there is ${ingress.remote_endpoint_id}`;
  if (ingress.intake_state === 'enabled' || ingress.intake_state === 'degraded') {
    return `${own}: removing that one stops messages coming in.`;
  }
  // D-201 Slice 10BA (10AY finding 5) — nothing retries a clean-up by itself:
  // it said Recued was removing it, beside the button that tries it again.
  // D-201 Slice 10BK (10BF finding 14) — the button by its own name: a swap
  // left pending is tried again as a swap, as the card's button says.
  const swapPending = (ingress.pending_paired_connection_id ?? null) !== null && ingress.intake_state !== 'retired';
  return ingress.registration_state === 'cleanup_pending'
    ? `${own}: its clean-up did not finish, so it may still be there. Try the ${swapPending ? 'swap' : 'clean-up'} `
      + 'again here, or remove it there yourself.'
    : `${own}.`;
};

/** D-201 Slice 10AL (10AI finding 21) — the ones Recued stopped trying to
 *  remove. The row went with them, and read as resolved. */
export const givenUpStrayEndpointsText = (count: number): string => {
  const one = count === 1;
  return `Recued stopped trying to remove ${one ? 'an earlier setup' : `${count} earlier setups`} of this webhook `
    + `from the other service after a week of failed tries. Remove ${one ? 'it' : 'them'} there yourself, then `
    + 'say so here.';
};

/** D-201 Slice 10BQ (10BM finding 13) — the unproven ones found sending to
 *  another address, after a week. */
export const givenUpUnprovenElsewhereStrayEndpointsText = (count: number): string => {
  const one = count === 1;
  return `Recued stopped looking at ${one ? 'an endpoint' : `${count} endpoints`} at the other service after a `
    + `week: labelled as ${one ? 'an earlier setup' : 'earlier setups'} of this webhook, ${one ? 'it sends' : 'they send'} `
    + `to another address, so Recued could not prove ${one ? 'it is' : 'they are'} this webhook's and never removed `
    + `${one ? 'it' : 'them'}. Remove ${one ? 'it' : 'them'} there yourself if ${one ? 'it is' : 'they are'}, then say `
    + 'so here.';
};

/** D-201 Slice 10BA (10AY finding 4) — the unproven ones, after a week: Recued
 *  never tried to remove them. */
export const givenUpUnprovenStrayEndpointsText = (count: number): string => {
  const one = count === 1;
  return `Recued stopped looking at ${one ? 'an endpoint' : `${count} endpoints`} at the other service that `
    + `${one ? 'sends' : 'send'} to this webhook's address after a week: it could not prove ${one ? 'it is' : 'they are'} `
    + `this webhook's, so it never removed ${one ? 'it' : 'them'}. Remove ${one ? 'it' : 'them'} there yourself if `
    + `${one ? 'it is' : 'they are'}, then say so here.`;
};

const errorText = (error: unknown): string => {
  if ((error as { code?: unknown } | null)?.code === 'webhook_registration_event_types_unknown') {
    const names = skippedEventNames(error);
    // D-201 Slice 10O — said too when the service was left sending every kind.
    const details = (error as { details?: unknown }).details;
    const leftOnDefault = details !== null && typeof details === 'object'
      && (details as { left_on_default?: unknown }).left_on_default === true;
    // D-201 Slice 10Z (10V finding 25) — and whether it was there already.
    const wasOnDefault = leftOnDefault
      && (details as { was_on_default?: unknown }).was_on_default === true;
    // D-201 Slice 10T — and which of them the service never lists.
    const neverListed = details !== null && typeof details === 'object'
      && Array.isArray((details as { never_listed?: unknown }).never_listed)
      ? ((details as { never_listed: unknown[] }).never_listed)
        .filter((name): name is string => typeof name === 'string')
      : [];
    const refused = refusedNamesText(names, neverListed);
    const fix = names.length > 0 && names.every((name) => neverListed.includes(name))
      ? `Untick ${names.length === 1 ? 'it' : 'them'}, then line the address up again.`
      : names.length === 1
        ? 'Check the spelling, or untick it, then line the address up again.'
        : names.length === 0
          ? 'Check their spelling, or untick them, then line the address up again.'
          : 'Check the spelling, or untick them, then line the address up again.';
    return leftOnDefault
      ? `${refused} ${wasOnDefault ? ON_DEFAULT_TEXT : LEFT_ON_DEFAULT_TEXT} ${fix}`
      : `${refused} ${fix}`;
  }
  return error instanceof Error ? error.message : 'That did not work';
};

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
  // Safari does not focus buttons on pointer activation. Establish the action
  // owner before a read or write repaints the card.
  value.addEventListener('click', () => { if (!value.disabled) value.focus?.({ preventScroll: true }); });
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

/** D-201 Slice 10C — the event catalog the server projected, when it is a
 *  well-formed one. Absent or malformed (a server older than 10C): the panel
 *  offers its own copy's known names and no typed-in ones. D-201 Slice 10T —
 *  with the names the service never lists, when the server says so (a server
 *  older than 10T does not, and its refusals carry none either). */
const projectedEventCatalog = (value: unknown): WebhookEventTypeCatalog | null => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const catalog = value as Record<string, unknown>;
  const names = (list: unknown): string[] | null =>
    Array.isArray(list) && list.every((entry) => typeof entry === 'string')
      ? [...list as string[]]
      : null;
  if (catalog.kind === 'closed') {
    const values = names(catalog.values);
    return values === null ? null : { kind: 'closed', values };
  }
  const known = names(catalog.known_values);
  const neverListed = catalog.never_listed === undefined ? undefined : names(catalog.never_listed);
  if (catalog.kind !== 'open'
    || known === null
    || neverListed === null
    || validateWebhookEventTypeGrammar(catalog.grammar).length > 0) return null;
  return {
    kind: 'open',
    known_values: known,
    grammar: { ...(catalog.grammar as WebhookEventTypeGrammar) },
    ...(neverListed === undefined ? {} : { never_listed: neverListed }),
  };
};

/** What a grammar takes, in plain words, from its kind alone: never a
 *  vendor's own rule. */
const eventGrammarHint = (grammar: WebhookEventTypeGrammar): string => {
  switch (grammar.kind) {
    case 'ascii_alphanumeric_dot_colon_slash_dash.v1':
      return `Letters, digits and . _ : / -, starting with a letter or a digit, up to ${grammar.max_bytes} long.`;
    case 'ascii_identifier.v1':
      return `Letters, digits and _, starting with a letter, up to ${grammar.max_bytes} long.`;
    case 'lowercase_identifier_event_type.v1':
      return `Lowercase letters, digits and _, starting with a letter, up to ${grammar.max_characters} long.`;
    // D-201 Slice 10K (10H finding 19) — the rule names the two it refuses
    // (`constructor`, `prototype`), which fit the rest of it.
    case 'lowercase_json_member_event_type.v1':
      return `Lowercase letters, digits and _, starting with a letter, up to ${grammar.max_characters} long, but not constructor or prototype.`;
    case 'lowercase_dot_segment_event_type.v1':
      return `${grammar.segment_count} parts joined by dots, each lowercase letters, digits and _, starting with a letter.`;
  }
};

const eventGrammarMaxLength = (grammar: WebhookEventTypeGrammar): number => {
  switch (grammar.kind) {
    case 'ascii_alphanumeric_dot_colon_slash_dash.v1':
    case 'ascii_identifier.v1':
      return grammar.max_bytes;
    case 'lowercase_identifier_event_type.v1':
    case 'lowercase_json_member_event_type.v1':
      return grammar.max_characters;
    case 'lowercase_dot_segment_event_type.v1':
      return grammar.segment_count * grammar.max_segment_characters + grammar.segment_count - 1;
  }
};

/** Which events are ticked, and the names typed in that the catalog does not
 *  list (kept in the order they were added). */
interface EventSelection {
  checked: Set<string>;
  extras: string[];
  /** A name typed and not yet added. */
  draft: string;
}

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
  const expandedConfigurations = new Set<string>();
  /** D-341 slice B2b — each card's "What it may do without asking", by ingress: kept across the
   *  repaints that rebuild every card (moved into the new one, open or not, mid-grant or not). */
  const preapprovalPanels = new Map<string, { host: HTMLDetailsElement; panel: TriggerPreapprovalPanelMount | null }>();
  // Hidden on a server from before pre-approvals, asked once for the page.
  let preapprovalSupport: TriggerPreapprovalSupport | null = null;
  const preapprovalHost = (ingress: WebhookIngressView): HTMLDetailsElement | null => {
    const callers = options.triggerPreapprovals;
    if (callers === undefined || ingress.intake_state === 'retired') return null;
    const kept = preapprovalPanels.get(ingress.ingress_id);
    if (kept !== undefined) return kept.host;
    const host = doc.createElement('details');
    (preapprovalSupport ??= createTriggerPreapprovalSupport((args) => callers.choices(args)))
      .show(host, { kind: 'webhook', ingress_id: ingress.ingress_id });
    const summary = doc.createElement('summary');
    summary.textContent = 'What it may do without asking';
    host.appendChild(summary);
    const item: { host: HTMLDetailsElement; panel: TriggerPreapprovalPanelMount | null } = { host, panel: null };
    preapprovalPanels.set(ingress.ingress_id, item);
    host.addEventListener('toggle', () => {
      if (!host.open || item.panel !== null || disposed || !root.contains(host)) return;
      item.panel = mountTriggerPreapprovalPanel({
        host, trigger: { kind: 'webhook', ingress_id: ingress.ingress_id }, callers, document: doc,
        ...(options.subscribe !== undefined ? { subscribe: options.subscribe } : {}),
      });
    });
    return host;
  };
  let filterQuery = ''; let filterStatus = '';
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
  let deadLetterInspector: DeadLetterInspectorState | null = null;
  /** D-201 Slice 10C — the webhook whose events are being changed. */
  let eventsEditor: { ingress_id: string; selection: EventSelection } | null = null;
  /** `until_registered`: a managed save's note, which says the address still
   *  has to be lined up, so it goes once the webhook reads `registered`. */
  let eventsNotice: { ingress_id: string; text: string; until_registered: boolean } | null = null;
  /** The server's unresolved dead letters against its limit, as last listed. */
  let deadLetterReview: WebhookDeadLetterReviewSummary | null = null;
  let pendingActionFocus: {
    ingress_id: string | null;
    action: string;
    label: string;
    item_id: string | null;
  } | null = null;
  let pendingActionFocusElement: HTMLElement | null = null;
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
        ?? itemOwner.getAttribute?.(WEBHOOKS_PANEL_DEAD_LETTER_ATTR)
        ?? itemOwner.getAttribute?.(WEBHOOKS_PANEL_RECIPE_ATTR)
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
    pendingActionFocusElement = active;
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
      // A dead letter acted on leaves the list: the next one's same button,
      // else the list's Close.
      'dead-letter-requeue': 'dead-letters-close',
      'dead-letter-resolve': 'dead-letters-close',
      'events-save': 'events-edit',
      'events-cancel': 'events-edit',
      'door-open': 'door-close',
      'door-close': 'door-open',
    };
    const actions = [pending.action, successors[pending.action]]
      .filter((action): action is string => action !== undefined);
    let candidate: HTMLButtonElement | null = null;
    for (const action of actions) {
      const recipeAction = pending.action === 'door-open' || pending.action === 'door-close';
      const itemScope = (action === pending.action || recipeAction)
        && pending.item_id !== null
        && focusScope !== null
        ? findDescendant(focusScope, (element) =>
            recipeAction ? element.getAttribute?.(WEBHOOKS_PANEL_RECIPE_ATTR) === pending.item_id
            : element.getAttribute?.(WEBHOOKS_PANEL_EVENT_ATTR) === pending.item_id
            || element.getAttribute?.(WEBHOOKS_PANEL_DELIVERY_ATTR) === pending.item_id
            || element.getAttribute?.(WEBHOOKS_PANEL_DEAD_LETTER_ATTR) === pending.item_id)
        : null;
      const actionScope = recipeAction && pending.item_id !== null ? itemScope : itemScope ?? focusScope;
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
    pendingActionFocusElement = candidate;
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
    deadLetterReview = result.dead_letter_review ?? null;
    if (eventsEditor !== null
      && !ingresses.some((ingress) => ingress.ingress_id === eventsEditor?.ingress_id)) {
      eventsEditor = null;
    }
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
      const eventTypes = projectedEventCatalog(
        (capability as { event_types?: unknown }).event_types,
      );
      profileCapabilities.push({
        profile_id: profile.profile_id,
        registration_modes: registrationModes,
        deduplication: profile.deduplication,
        ...(eventTypes === null ? {} : { event_types: eventTypes }),
      });
    }
  };

  const capabilityFor = (
    profileId: WebhookIngressView['profile_id'],
  ): WebhookProfileRuntimeCapabilityView | null =>
    profileCapabilities.find((candidate) => candidate.profile_id === profileId) ?? null;

  /** D-201 Slice 10C — the events at the service: a box per known name and per
   *  name typed in, and, when the server said what its catalog takes, a field
   *  to type another, checked against the server's own grammar. Edits change
   *  `selection` in place and never repaint, so nothing typed is lost. */
  const eventPicker = (
    knownValues: readonly string[],
    grammar: WebhookEventTypeGrammar | null,
    selection: EventSelection,
  ): { element: HTMLFieldSetElement; checked(): string[] | null } => {
    const fieldset = doc.createElement('fieldset');
    fieldset.className = 'wh-event-types';
    const legend = doc.createElement('legend');
    legend.textContent = 'Events at the service';
    fieldset.appendChild(legend);
    const boxes = new Map<string, HTMLInputElement>();
    const problem = doc.createElement('p');
    problem.className = 'wh-copy';
    problem.setAttribute('role', 'status');
    problem.setAttribute(WEBHOOKS_PANEL_EVENTS_NOTICE_ATTR, 'problem');
    problem.hidden = true;
    const say = (text: string): void => {
      problem.textContent = text;
      problem.hidden = false;
    };
    /** A name chosen before the server said what its catalog takes, and
     *  outside it: the service never sends it, so it cannot be kept. */
    const neverSent = (eventType: string): boolean =>
      grammar !== null
      && !knownValues.includes(eventType)
      && !webhookEventTypeGrammarAccepts(grammar, eventType);
    const listed = (): string[] => [
      ...knownValues,
      ...selection.extras.filter((eventType) => !knownValues.includes(eventType)),
    ];
    /** The boxes as they stand, then `selection` brought in line: a box can
     *  change with no change event (a browser restoring a form, a script). */
    const selected = (): string[] => {
      for (const [eventType, box] of boxes) {
        if (box.checked) selection.checked.add(eventType);
        else selection.checked.delete(eventType);
      }
      return listed().filter((eventType) => selection.checked.has(eventType));
    };
    let insertBefore: HTMLElement | null = null;
    /** D-201 Slice 10G — what is typed in the field, added (true) or refused
     *  with a message (false); true when nothing is typed. */
    let addTyped: ((submitting: boolean) => boolean) | null = null;
    const addBox = (eventType: string): HTMLInputElement => {
      const label = doc.createElement('label');
      const input = doc.createElement('input');
      input.type = 'checkbox';
      input.value = eventType;
      input.checked = selection.checked.has(eventType);
      input.setAttribute(WEBHOOKS_PANEL_EVENT_TYPE_ATTR, eventType);
      input.addEventListener('change', () => {
        if (input.checked) selection.checked.add(eventType);
        else selection.checked.delete(eventType);
        problem.hidden = true;
      });
      boxes.set(eventType, input);
      label.appendChild(input);
      const text = doc.createElement('span');
      text.textContent = neverSent(eventType)
        ? `${eventType} (this service never sends an event named like this)`
        : eventType;
      label.appendChild(text);
      if (insertBefore !== null && typeof fieldset.insertBefore === 'function') {
        fieldset.insertBefore(label, insertBefore);
      } else {
        fieldset.appendChild(label);
      }
      return input;
    };
    for (const eventType of listed()) addBox(eventType);
    if (grammar !== null) {
      const custom = doc.createElement('div');
      custom.className = 'wh-event-custom';
      const label = doc.createElement('label');
      label.textContent = 'Another event at the service';
      const field = doc.createElement('input');
      field.type = 'text';
      field.autocomplete = 'off';
      field.maxLength = eventGrammarMaxLength(grammar);
      field.value = selection.draft;
      field.setAttribute(WEBHOOKS_PANEL_FIELD_ATTR, 'event-type-custom');
      field.addEventListener('input', () => {
        selection.draft = field.value;
      });
      label.appendChild(field);
      custom.appendChild(label);
      const add = button(doc, 'Add it', 'event-type-add');
      add.type = 'button';
      custom.appendChild(add);
      fieldset.appendChild(custom);
      insertBefore = custom;
      const hint = doc.createElement('p');
      hint.className = 'wh-copy';
      hint.textContent = eventGrammarHint(grammar);
      fieldset.appendChild(hint);
      const tryAdd = (submitting: boolean): boolean => {
        const value = field.value.trim();
        problem.hidden = true;
        if (value.length === 0) return true;
        // On a submit, the name is still in the field: say it blocks the save.
        const unsaved = submitting ? ' Fix it or clear it to save.' : '';
        if (!webhookEventTypeGrammarAccepts(grammar, value)) {
          // D-201 Slice 10K (10H finding 19) — a name that fits the rule's
          // letters but is refused all the same is one it reserves: say so,
          // not the rule it fits.
          const reserved = grammar.kind === 'lowercase_json_member_event_type.v1'
            && webhookEventTypeGrammarAccepts(
              { kind: 'lowercase_identifier_event_type.v1', max_characters: grammar.max_characters },
              value,
            );
          say(reserved
            ? `This service cannot take ${value} as an event name.${unsaved}`
            : `This service's events are not named like ${submitting ? 'the one you typed' : 'that'}. ${eventGrammarHint(grammar)}${unsaved}`);
          field.focus();
          return false;
        }
        if (!selection.checked.has(value)
          && selected().length >= MAX_WEBHOOK_EVENT_TYPES_PER_REQUIREMENT) {
          say(`A webhook takes at most ${MAX_WEBHOOK_EVENT_TYPES_PER_REQUIREMENT} events. Untick one first.${unsaved}`);
          field.focus();
          return false;
        }
        const alreadyListed = boxes.has(value);
        if (!alreadyListed) selection.extras.push(value);
        selection.checked.add(value);
        const box = boxes.get(value) ?? addBox(value);
        box.checked = true;
        field.value = '';
        selection.draft = '';
        if (submitting) return true;
        if (alreadyListed) say(`${value} was already in the list. It is ticked now.`);
        field.focus();
        return true;
      };
      addTyped = tryAdd;
      add.addEventListener('click', () => { tryAdd(false); });
      // Enter adds the name: inside a form it would otherwise submit it.
      field.addEventListener('keydown', (event) => {
        if ((event as KeyboardEvent).key !== 'Enter') return;
        event.preventDefault();
        tryAdd(false);
      });
    }
    fieldset.appendChild(problem);
    return {
      element: fieldset,
      checked: () => {
        // D-201 Slice 10G (10D finding 8) — a name typed but not added is added
        // now, or the save stops with why: it is never dropped.
        if (addTyped !== null && !addTyped(true)) return null;
        const names = selected();
        if (names.length === 0) {
          say('Pick at least one event at the service.');
          return null;
        }
        if (names.length > MAX_WEBHOOK_EVENT_TYPES_PER_REQUIREMENT) {
          say(`A webhook takes at most ${MAX_WEBHOOK_EVENT_TYPES_PER_REQUIREMENT} events. Untick ${names.length - MAX_WEBHOOK_EVENT_TYPES_PER_REQUIREMENT}.`);
          return null;
        }
        const refused = names.filter(neverSent);
        if (refused.length > 0) {
          say(refused.length === 1
            ? `This service never sends an event named ${refused[0]}. Untick it to save.`
            : `This service never sends events named ${refused.join(', ')}. Untick them to save.`);
          return null;
        }
        problem.hidden = true;
        return names;
      },
    };
  };

  /** The catalog to offer for a profile: the server's projection when it sent
   *  one, else the panel's own copy, which carries no typed-in names. */
  const eventCatalogFor = (
    profile: WebhookProfileDescriptor,
  ): { catalog: WebhookEventTypeCatalog; grammar: WebhookEventTypeGrammar | null } => {
    const projected = capabilityFor(profile.profile_id)?.event_types;
    const catalog = projected ?? profile.event_types;
    return {
      catalog,
      grammar: projected !== undefined && projected.kind === 'open' ? projected.grammar : null,
    };
  };

  /** D-201 Slice 10T — the names a profile's service never lists, from the
   *  same catalog. */
  const neverListedOf = (profileId: string): readonly string[] => {
    const profile = descriptorFor(profileId);
    if (profile === null) return [];
    const { catalog } = eventCatalogFor(profile);
    return catalog.kind === 'open' ? catalog.never_listed ?? [] : [];
  };

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

  const mutate = async (operation: () => Promise<unknown>, owner?: HTMLElement): Promise<void> => {
    if (busy || disposed || (owner !== undefined && !root.contains(owner))) return;
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

  // ── D-201 Slice 10B — messages that did not reach their recipes ─────────

  const canReviewDeadLetters = options.runDeadLetterList !== undefined
    && options.runDeadLetterRequeue !== undefined
    && options.runDeadLetterResolve !== undefined;

  /** The first page again, keeping what the owner typed for the ones left. */
  /** As many as were showing (Slice 10F: an action used to fall back to the
   *  first ten), and the closed ones too when they are showing. */
  const reloadDeadLetters = async (ingressId: string): Promise<void> => {
    const showing = deadLetterInspector?.ingress_id === ingressId
      ? deadLetterInspector.dead_letters.length
      : 0;
    const response = await options.runDeadLetterList!({
      ingress_id: ingressId,
      limit: Math.min(MAX_WEBHOOK_DELIVERY_PAGE_SIZE, Math.max(10, showing)),
    });
    if (deadLetterInspector?.ingress_id !== ingressId) return;
    if (deadLetterInspector.closed !== null) {
      const closedShowing = deadLetterInspector.closed.dead_letters.length;
      const closed = await options.runDeadLetterList!({
        ingress_id: ingressId,
        limit: Math.min(MAX_WEBHOOK_DELIVERY_PAGE_SIZE, Math.max(10, closedShowing + 1)),
        closed: true,
      });
      if (deadLetterInspector?.ingress_id !== ingressId) return;
      deadLetterInspector = {
        ...deadLetterInspector,
        closed: { dead_letters: [...closed.dead_letters], next_cursor: closed.next_cursor, loaded: true },
      };
    }
    const kept = new Set(response.dead_letters.map(deadLetterKey));
    deadLetterInspector = {
      ...deadLetterInspector,
      dead_letters: [...response.dead_letters],
      next_cursor: response.next_cursor,
      loaded: true,
      reasons: new Map([...deadLetterInspector.reasons].filter(([key]) => kept.has(key))),
    };
    deadLetterReview = response.review;
  };

  const loadDeadLetters = (
    ingressId: string,
    cursor?: WebhookDeadLetterListCursor,
  ): void => {
    if (!canReviewDeadLetters) return;
    void inspect(async () => {
      if (cursor === undefined) {
        await reloadDeadLetters(ingressId);
        return;
      }
      const response = await options.runDeadLetterList!({
        ingress_id: ingressId,
        limit: 10,
        cursor,
      });
      if (deadLetterInspector?.ingress_id !== ingressId) return;
      const deadLetters = [...deadLetterInspector.dead_letters, ...response.dead_letters];
      deadLetterInspector = {
        ...deadLetterInspector,
        dead_letters: [...new Map(deadLetters.map((item) => [
          deadLetterKey(item),
          item,
        ])).values()],
        next_cursor: response.next_cursor,
        loaded: true,
      };
      deadLetterReview = response.review;
    });
  };

  /** D-201 Slice 10F — the closed ones, a page at a time. */
  const loadClosedDeadLetters = (
    ingressId: string,
    cursor?: WebhookDeadLetterListCursor,
  ): void => {
    if (!canReviewDeadLetters) return;
    if (deadLetterInspector?.ingress_id === ingressId && cursor === undefined) {
      deadLetterInspector = {
        ...deadLetterInspector,
        closed: { dead_letters: [], next_cursor: null, loaded: false },
      };
    }
    void inspect(async () => {
      const response = await options.runDeadLetterList!({
        ingress_id: ingressId,
        limit: 10,
        closed: true,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      if (deadLetterInspector?.ingress_id !== ingressId || deadLetterInspector.closed === null) return;
      const deadLetters = cursor === undefined
        ? [...response.dead_letters]
        : [...new Map([...deadLetterInspector.closed.dead_letters, ...response.dead_letters]
          .map((item) => [deadLetterKey(item), item])).values()];
      deadLetterInspector = {
        ...deadLetterInspector,
        closed: { dead_letters: deadLetters, next_cursor: response.next_cursor, loaded: true },
      };
    });
  };

  const focusDeadLetterReason = (ingressId: string, key: string): void => {
    const card = renderedCard(ingressId);
    if (card === null) return;
    const item = findDescendant(card, (element) =>
      element.getAttribute?.(WEBHOOKS_PANEL_DEAD_LETTER_ATTR) === key);
    if (item === null) return;
    focusRendered(item, (element) =>
      element.getAttribute?.(WEBHOOKS_PANEL_FIELD_ATTR) === 'dead-letter-reason');
  };

  const actOnDeadLetter = (
    ingress: WebhookIngressView,
    deadLetter: WebhookDeadLetterView,
    action: 'requeue' | 'resolve',
  ): void => {
    if (!canReviewDeadLetters || deadLetterInspector?.ingress_id !== ingress.ingress_id) return;
    const key = deadLetterKey(deadLetter);
    const reason = (deadLetterInspector.reasons.get(key) ?? '').trim();
    // Slice 10F — the last action's notice goes now, so no refusal (this
    // one, or the server's) ever shows beside an earlier success (10I, 10H
    // finding 13: this one used to come first).
    deadLetterInspector = { ...deadLetterInspector, notice: null };
    if (action === 'resolve' && reason.length === 0) {
      error = 'Write why you are closing it first. Recued keeps the reason with it.';
      render();
      focusDeadLetterReason(ingress.ingress_id, key);
      return;
    }
    void mutate(async () => {
      const request: WebhookDeadLetterActionRequest = {
        ingress_id: ingress.ingress_id,
        dead_letter: { kind: deadLetter.kind, dead_letter_id: deadLetter.dead_letter_id },
        dead_lettered_at: deadLetter.dead_lettered_at,
        ...(reason.length > 0 ? { reason } : {}),
      };
      let response: WebhookDeadLetterActionResponse;
      try {
        response = action === 'requeue'
          ? await options.runDeadLetterRequeue!(request)
          : await options.runDeadLetterResolve!(request);
      } catch (cause) {
        if ((cause as { code?: unknown } | null)?.code === 'webhook_dead_letter_no_recipe') {
          throw new Error('No recipe takes this message now: its recipe was removed, switched off, or saved or updated with a different webhook setup. Close it instead.');
        }
        // D-201 Slice 10U (10Q finding 9) — it stays: say what lets it run.
        if ((cause as { code?: unknown } | null)?.code === 'webhook_dead_letter_no_door') {
          const door = (cause as { details?: { door?: unknown } }).details?.door;
          throw new Error(doorText(door === 'closed' ? 'closed' : 'missing', ingress.recipes !== undefined));
        }
        throw cause;
      } finally {
        // Refused or not, show the list as it stands now: a refusal for a
        // change since it was shown is answered by showing that change.
        try {
          await reloadDeadLetters(ingress.ingress_id);
        } catch {
          // The action's own outcome, or its refusal, is the error to show.
        }
      }
      if (deadLetterInspector?.ingress_id === ingress.ingress_id) {
        deadLetterInspector = {
          ...deadLetterInspector,
          notice: response.outcome === 'requeued'
            ? 'Recued is trying it again now.'
            : 'Closed. Recued keeps your reason with it.',
        };
      }
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

  /** The label of the card's button that lines a managed address up at the
   *  service, or null when the card shows none. */
  const reconcileLabelFor = (ingress: WebhookIngressView): string | null => {
    const available = options.runRegistrationReconcile !== undefined
      && (capabilityFor(ingress.profile_id)?.registration_modes
        .includes('managed_endpoint') ?? false)
      && ingress.registration_mode === 'managed_endpoint'
      && ingress.registration_state !== 'cleanup_pending'
      && ingress.registration_state !== 'retired'
      && ingress.intake_state !== 'retired';
    if (!available) return null;
    return ingress.remote_endpoint_id === null
      && ingress.registration_state === 'managed_pending'
      ? 'Set up the address at the service'
      : 'Line the address up again';
  };

  /** D-201 Slice 10C — change which events an existing webhook takes, names
   *  typed in before (outside the known list) kept and editable. */
  const canEditEvents = (ingress: WebhookIngressView): boolean =>
    options.runUpdate !== undefined
    && ingress.intake_state !== 'retired'
    && ingress.registration_state !== 'cleanup_pending'
    && capabilityFor(ingress.profile_id)?.event_types?.kind === 'open';

  const eventsEditorView = (ingress: WebhookIngressView): HTMLElement => {
    const section = doc.createElement('section');
    section.setAttribute(WEBHOOKS_PANEL_EVENTS_EDITOR_ATTR, ingress.ingress_id);
    const projected = capabilityFor(ingress.profile_id)?.event_types;
    if (eventsEditor?.ingress_id !== ingress.ingress_id
      || projected === undefined
      || projected.kind !== 'open') return section;
    const editing = eventsEditor;
    const head = doc.createElement('div');
    head.className = 'wh-card-head';
    const title = doc.createElement('strong');
    title.textContent = 'Which events it takes';
    head.appendChild(title);
    section.appendChild(head);
    const picker = eventPicker(projected.known_values, projected.grammar, editing.selection);
    section.appendChild(picker.element);
    const note = doc.createElement('p');
    note.className = 'wh-note';
    note.textContent = ingress.registration_mode === 'managed_endpoint'
      ? 'The service keeps sending the old events until the address is lined up again after you save.'
      : ingress.registration_mode === 'manual'
        ? 'After you save, change the events at the service too: it sends what is set up there.'
        : 'Recued takes only the events you tick.';
    section.appendChild(note);
    const actions = doc.createElement('div');
    actions.className = 'wh-actions';
    const save = button(doc, 'Save the events', 'events-save', true);
    save.disabled = busy;
    save.addEventListener('click', () => {
      const selected = picker.checked();
      if (selected === null) return;
      const unchanged = selected.length === ingress.selected_event_types.length
        && selected.every((eventType) => ingress.selected_event_types.includes(eventType));
      if (unchanged) {
        eventsEditor = null;
        render();
        focusCardAction(ingress.ingress_id, 'events-edit');
        return;
      }
      void mutate(async () => {
        const { ingress: updated } = await options.runUpdate!({
          ingress_id: ingress.ingress_id,
          patch: { selected_event_types: selected },
        });
        eventsEditor = null;
        // Named from the webhook as saved: saving can move a managed one's
        // state, and with it the button that lines the address up.
        const reconcile = reconcileLabelFor(updated);
        eventsNotice = {
          ingress_id: ingress.ingress_id,
          until_registered: updated.registration_mode === 'managed_endpoint',
          text: updated.registration_mode === 'managed_endpoint'
            ? reconcile === null
              ? 'Saved. The service keeps sending the old events until the address is lined up again.'
              : `Saved. Use ${reconcile}, so the service sends these events.`
            : updated.registration_mode === 'manual'
              ? 'Saved. Change the events at the service too: it sends what is set up there.'
              : 'Saved.',
        };
      });
    });
    actions.appendChild(save);
    const cancel = button(doc, 'Cancel', 'events-cancel');
    cancel.disabled = busy;
    cancel.addEventListener('click', () => {
      eventsEditor = null;
      render();
      focusCardAction(ingress.ingress_id, 'events-edit');
    });
    actions.appendChild(cancel);
    section.appendChild(actions);
    return section;
  };

  const deadLetterInspectorView = (ingress: WebhookIngressView): HTMLElement => {
    const inspector = doc.createElement('section');
    inspector.setAttribute(WEBHOOKS_PANEL_DEAD_LETTERS_ATTR, ingress.ingress_id);
    const state = deadLetterInspector?.ingress_id === ingress.ingress_id
      ? deadLetterInspector
      : null;
    const head = doc.createElement('div');
    head.className = 'wh-card-head';
    const title = doc.createElement('strong');
    title.textContent = 'Messages that did not reach their recipes';
    head.appendChild(title);
    const close = button(doc, 'Close', 'dead-letters-close');
    close.disabled = busy;
    close.addEventListener('click', () => {
      deadLetterInspector = null;
      render();
      focusCardAction(ingress.ingress_id, 'dead-letters');
    });
    head.appendChild(close);
    inspector.appendChild(head);

    const boundary = doc.createElement('p');
    boundary.className = 'wh-copy';
    boundary.textContent = 'Each one got through, but Recued tried it until its tries ran out. Fix what went wrong, then try it again: it runs as the same message, and only if its recipe may still take it. Or close it with a reason. Closing deletes nothing and does not say the recipe ran.';
    inspector.appendChild(boundary);

    if (state?.notice) {
      const notice = doc.createElement('p');
      notice.className = 'wh-note';
      notice.setAttribute('role', 'status');
      notice.textContent = state.notice;
      inspector.appendChild(notice);
    }
    if (state === null || (!state.loaded && busy)) {
      const loading = doc.createElement('p');
      loading.className = 'wh-copy';
      loading.textContent = 'Loading the messages that did not reach their recipes…';
      inspector.appendChild(loading);
      return inspector;
    }
    if (!state.loaded) {
      const unavailable = doc.createElement('p');
      unavailable.className = 'wh-copy';
      unavailable.textContent = 'Recued cannot show the messages that did not reach their recipes.';
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
    if (state.dead_letters.length === 0) {
      const empty = doc.createElement('p');
      empty.className = 'wh-copy';
      empty.textContent = 'None are waiting: every message here reached its recipes, or was closed.';
      inspector.appendChild(empty);
    }
    const receiving = ingress.intake_state === 'enabled' || ingress.intake_state === 'degraded';
    for (const deadLetter of state.dead_letters) {
      const key = deadLetterKey(deadLetter);
      const node = doc.createElement('article');
      node.setAttribute(WEBHOOKS_PANEL_DEAD_LETTER_ATTR, key);
      const metadata = doc.createElement('dl');
      appendRow(metadata, 'Kind of event', deadLetter.provider_event_type);
      appendRow(metadata, 'Received', timestamp(deadLetter.received_at));
      appendRow(
        metadata,
        'What did not happen',
        deadLetter.kind === 'event'
          ? 'Handing it to its recipes'
          : `Its run of ${deadLetter.recipe_id ?? 'a recipe'}`,
      );
      appendRow(metadata, 'Tries', String(deadLetter.attempt_count));
      appendRow(metadata, 'Last problem', deadLetterProblemText(
        deadLetter.last_error_code,
        ingress.recipes !== undefined,
        // D-201 Slice 10AG (10AE finding 11) — every held state, from a server
        // since 10AG; an older one's 10W states.
        deadLetter.held_try_again ?? deadLetter.step_in_doubt,
      ));
      appendRow(metadata, 'Gave up', timestamp(deadLetter.dead_lettered_at));
      appendRow(metadata, 'What was sent', deadLetter.payload_retained ? 'Kept' : 'Not kept');
      node.appendChild(metadata);

      const reasonLabel = doc.createElement('label');
      reasonLabel.textContent = 'Why (kept with what you decide; needed to close it)';
      const reason = doc.createElement('input');
      reason.type = 'text';
      reason.maxLength = MAX_WEBHOOK_DEAD_LETTER_REASON_LENGTH;
      reason.setAttribute(WEBHOOKS_PANEL_FIELD_ATTR, 'dead-letter-reason');
      reason.value = state.reasons.get(key) ?? '';
      reason.disabled = busy;
      reason.addEventListener('input', () => {
        // Kept without a repaint, so typing keeps its place.
        if (deadLetterInspector?.ingress_id !== ingress.ingress_id) return;
        deadLetterInspector.reasons.set(key, reason.value);
      });
      reasonLabel.appendChild(reason);
      node.appendChild(reasonLabel);

      const actions = doc.createElement('div');
      actions.className = 'wh-actions';
      const requeue = button(doc, 'Try it again', 'dead-letter-requeue');
      requeue.disabled = busy || !receiving;
      if (!receiving) requeue.title = 'Switch this webhook on first';
      requeue.addEventListener('click', () => {
        actOnDeadLetter(ingress, deadLetter, 'requeue');
      });
      actions.appendChild(requeue);
      const resolve = button(doc, 'Close it', 'dead-letter-resolve');
      resolve.disabled = busy;
      resolve.addEventListener('click', () => {
        actOnDeadLetter(ingress, deadLetter, 'resolve');
      });
      actions.appendChild(resolve);
      node.appendChild(actions);
      inspector.appendChild(node);
    }
    if (state.next_cursor !== null) {
      const loadMore = button(doc, 'Show more of them', 'dead-letters-more');
      loadMore.disabled = busy;
      loadMore.addEventListener('click', () => {
        loadDeadLetters(ingress.ingress_id, state.next_cursor!);
      });
      inspector.appendChild(loadMore);
    }

    // D-201 Slice 10F — the closed ones: who closed each, when and why.
    const closedState = state.closed;
    const toggleClosed = button(
      doc,
      closedState === null ? 'Show the closed ones' : 'Hide the closed ones',
      'dead-letters-closed',
    );
    toggleClosed.disabled = busy;
    toggleClosed.addEventListener('click', () => {
      if (deadLetterInspector?.ingress_id !== ingress.ingress_id) return;
      if (deadLetterInspector.closed !== null) {
        deadLetterInspector = { ...deadLetterInspector, closed: null };
        render();
        focusCardAction(ingress.ingress_id, 'dead-letters-closed');
        return;
      }
      loadClosedDeadLetters(ingress.ingress_id);
    });
    inspector.appendChild(toggleClosed);
    if (closedState !== null) {
      const closedHead = doc.createElement('strong');
      closedHead.textContent = 'Closed';
      inspector.appendChild(closedHead);
      if (!closedState.loaded) {
        const loading = doc.createElement('p');
        loading.className = 'wh-copy';
        loading.textContent = busy ? 'Loading the closed ones…' : 'Recued cannot show the closed ones.';
        inspector.appendChild(loading);
      } else if (closedState.dead_letters.length === 0) {
        const none = doc.createElement('p');
        none.className = 'wh-copy';
        none.textContent = 'None closed: a closed one is kept as long as its message is.';
        inspector.appendChild(none);
      }
      for (const deadLetter of closedState.loaded ? closedState.dead_letters : []) {
        const node = doc.createElement('article');
        node.setAttribute(WEBHOOKS_PANEL_CLOSED_DEAD_LETTER_ATTR, deadLetterKey(deadLetter));
        const metadata = doc.createElement('dl');
        appendRow(metadata, 'Kind of event', deadLetter.provider_event_type);
        appendRow(metadata, 'Received', timestamp(deadLetter.received_at));
        appendRow(
          metadata,
          'What did not happen',
          deadLetter.kind === 'event'
            ? 'Handing it to its recipes'
            : `Its run of ${deadLetter.recipe_id ?? 'a recipe'}`,
        );
        appendRow(metadata, 'Closed', timestamp(deadLetter.closure?.closed_at ?? deadLetter.dead_lettered_at));
        appendRow(metadata, 'Why', deadLetter.closure === undefined
          ? 'Not recorded'
          : closureText(deadLetter.closure, deadLetter.last_error_code));
        node.appendChild(metadata);
        inspector.appendChild(node);
      }
      if (closedState.loaded && closedState.next_cursor !== null) {
        const moreClosed = button(doc, 'Show more of the closed ones', 'dead-letters-closed-more');
        moreClosed.disabled = busy;
        moreClosed.addEventListener('click', () => {
          loadClosedDeadLetters(ingress.ingress_id, closedState.next_cursor!);
        });
        inspector.appendChild(moreClosed);
      }
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
      registration.appendChild(environmentLabel);
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

    const eventTypes = doc.createElement('div');
    form.appendChild(eventTypes);
    let eventTypePicker: ReturnType<typeof eventPicker> | null = null;
    const renderEventTypes = (): void => {
      clear(eventTypes);
      eventTypePicker = null;
      const profile = descriptorFor(profileSelect.value);
      if (!profile) return;
      const { catalog, grammar } = eventCatalogFor(profile);
      if (catalog.kind === 'closed') return;
      eventTypePicker = eventPicker(catalog.known_values, grammar, {
        checked: new Set(),
        extras: [],
        draft: '',
      });
      eventTypes.appendChild(eventTypePicker.element);
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
      const { catalog } = eventCatalogFor(profile);
      const selected = catalog.kind === 'closed'
        ? [...catalog.values]
        : eventTypePicker?.checked() ?? null;
      if (selected === null) return;
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

  /** D-201 Slice 10AQ (10AM findings 7 and 23) — the setups of this webhook
   *  left at the other service: those Recued keeps trying to remove, and those
   *  it stopped trying to, for the owner to remove there and say so. Each
   *  named, from a server that names them (`strays`). Said until the owner
   *  says they removed them, or a search of that account finds them gone or
   *  removes them. */
  const strayNotice = (ingress: WebhookIngressView): HTMLElement | null => {
    const standing = ingress.stray_endpoints ?? 0;
    const givenUp = ingress.stray_endpoints_given_up ?? 0;
    if (standing === 0 && givenUp === 0) return null;
    const notice = doc.createElement('section');
    notice.setAttribute(WEBHOOKS_PANEL_STRAYS_ATTR, ingress.ingress_id);
    notice.setAttribute('role', 'status');
    const said = (heading: string, paragraphs: readonly string[]): HTMLElement => {
      const group = doc.createElement('div');
      group.className = 'wh-stray-group';
      const title = doc.createElement('h4');
      title.textContent = heading;
      group.appendChild(title);
      for (const text of paragraphs) {
        const copy = doc.createElement('p');
        copy.className = 'wh-copy';
        copy.textContent = text;
        group.appendChild(copy);
      }
      notice.appendChild(group);
      return group;
    };
    // D-201 Slice 10BK (10BF finding 14) — each sentence with the strays it is
    // about: the proven and the unproven were named in one list after both.
    const withNames = (text: string, strays: readonly WebhookStrayEndpointView[]): string =>
      strays.length === 0 ? text : `${text} ${namedStraysText(strays)}`;
    // D-201 Slice 10BA (10AY finding 4) — the ones Recued never removes, said
    // apart, from a server that tells them apart (`unproven`).
    const named = ingress.strays ?? [];
    // D-201 Slice 10BQ (10BM finding 13) — and of those, the ones found at
    // another address, said as that: each was said to send to this webhook's.
    const atAddress = (stray: WebhookStrayEndpointView): boolean => stray.unproven === true && stray.elsewhere !== true;
    const elsewhere = (stray: WebhookStrayEndpointView): boolean => stray.unproven === true && stray.elsewhere === true;
    const givenUpUnproven = named.filter((stray) => stray.given_up && atAddress(stray));
    const standingUnproven = named.filter((stray) => !stray.given_up && atAddress(stray));
    const givenUpElsewhere = named.filter((stray) => stray.given_up && elsewhere(stray));
    const standingElsewhere = named.filter((stray) => !stray.given_up && elsewhere(stray));
    const givenUpTried = Math.max(0, givenUp - givenUpUnproven.length - givenUpElsewhere.length);
    const standingTried = Math.max(0, standing - standingUnproven.length - standingElsewhere.length);
    if (givenUp > 0) {
      const text = [
        ...(givenUpTried > 0
          ? [withNames(givenUpStrayEndpointsText(givenUpTried),
            named.filter((stray) => stray.given_up && stray.unproven !== true))]
          : []),
        ...(givenUpUnproven.length > 0
          ? [withNames(givenUpUnprovenStrayEndpointsText(givenUpUnproven.length), givenUpUnproven)]
          : []),
        ...(givenUpElsewhere.length > 0
          ? [withNames(givenUpUnprovenElsewhereStrayEndpointsText(givenUpElsewhere.length), givenUpElsewhere)]
          : []),
      ];
      const group = said('Remove at the other service', text);
      if (options.runStraysDismiss !== undefined) {
        const removed = button(doc, givenUp === 1 ? 'I removed it' : 'I removed them', 'strays-dismiss');
        removed.disabled = busy;
        removed.addEventListener('click', () => {
          void mutate(() => options.runStraysDismiss!({ ingress_id: ingress.ingress_id }), removed);
        });
        const holder = doc.createElement('div');
        holder.className = 'wh-actions';
        holder.appendChild(removed);
        group.appendChild(holder);
      }
    }
    if (standing > 0) {
      const text = [
        ...(standingTried > 0
          ? [withNames(strayEndpointsText(standingTried),
            named.filter((stray) => !stray.given_up && stray.unproven !== true))]
          : []),
        ...(standingUnproven.length > 0
          ? [withNames(unprovenStrayEndpointsText(standingUnproven.length), standingUnproven)]
          : []),
        ...(standingElsewhere.length > 0
          ? [withNames(unprovenElsewhereStrayEndpointsText(standingElsewhere.length), standingElsewhere)]
          : []),
      ];
      said('Left at the other service', text);
    }
    const own = ownEndpointText(ingress, ingress.strays ?? []);
    if (own !== null) {
      const ownCopy = doc.createElement('p');
      ownCopy.className = 'wh-copy';
      ownCopy.textContent = own;
      notice.appendChild(ownCopy);
    }
    return notice;
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
    const reconcileLabel = reconcileLabelFor(ingress);
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
    pill.textContent = `${ingress.registration_state.replaceAll('_', ' ')} · ${ingress.intake_state.replaceAll('_', ' ')}`;
    head.appendChild(pill);
    card.appendChild(head);

    const status = doc.createElement('p'); status.className = 'wh-copy';
    status.textContent = `${ingress.environment} · ${ingress.health.status.replaceAll('_', ' ')} · Last delivery: ${ingress.health.last_delivery_at === null ? 'none' : new Date(ingress.health.last_delivery_at).toLocaleString()}`;
    card.appendChild(status);
    // D-201 Slice 10AQ (10AM findings 7 and 23) — setups left at the other
    // service, each named, where the webhook's state is read: they sat inside
    // the collapsed configuration, and a given-up one was easy to miss.
    const strays = strayNotice(ingress);
    if (strays !== null) card.appendChild(strays);
    // D-201 Slice 10X — the recipes it starts, each with its door and a way to
    // it; a door that is not open is opened by switching the webhook on again.
    if (ingress.recipes !== undefined && ingress.recipes.length > 0) {
      const section = doc.createElement('section');
      section.setAttribute(WEBHOOKS_PANEL_RECIPES_ATTR, ingress.ingress_id);
      const heading = doc.createElement('h4');
      heading.textContent = 'Recipes it starts';
      section.appendChild(heading);
      const list = doc.createElement('ul');
      const receiving = ingress.intake_state === 'enabled' || ingress.intake_state === 'degraded';
      // D-201 Slice 10AF (the owner's rulings of 2026-11-20) — the webhook's
      // switch is the master for the outside world. Starting several recipes,
      // each also has its own door switch; starting one, the master is its
      // only switch, and opening a door it could not make switches it on.
      const ownSwitches = new Set(ingress.recipes.map((recipe) => recipe.recipe_id)).size > 1
        && ingress.recipe_door_switch === true
        && options.runDoorSet !== undefined;
      for (const recipe of ingress.recipes) {
        const item = doc.createElement('li');
        item.setAttribute(WEBHOOKS_PANEL_RECIPE_ATTR, recipe.recipe_id);
        const link = doc.createElement('a');
        link.setAttribute('href', `#recipes/${encodeURIComponent(recipe.recipe_id)}`);
        link.textContent = recipe.name ?? recipe.recipe_id;
        item.appendChild(link);
        if (recipe.pack_slug !== undefined) {
          const pack = doc.createElement('span');
          pack.textContent = ` (from the pack ${recipe.pack_slug})`;
          item.appendChild(pack);
        }
        const door = doc.createElement('p');
        door.className = 'wh-copy';
        door.textContent = recipeDoorText(recipe);
        item.appendChild(door);
        if (ownSwitches && recipe.armed) {
          // D-201 Slice 10AX (10AS finding 11) — a door not made yet is opened,
          // to make it, or closed, so it is made closed: the owner's ruling of
          // 2026-11-20 has doors opened and closed here. It offered only "Open
          // its door", and the next settings change made the door open.
          const switches = recipe.door === 'missing' ? [true, false] : [recipe.door !== 'open'];
          const recipeActions = doc.createElement('div');
          recipeActions.className = 'wh-actions';
          for (const opening of switches) {
            const doorSwitch = button(doc, opening ? 'Open its door' : 'Close its door', opening ? 'door-open' : 'door-close');
            doorSwitch.disabled = busy;
            if (!opening) {
              doorSwitch.title = recipe.door === 'missing'
                ? 'Its door is then made closed: what is sent to it waits with the messages that did not reach their '
                  + 'recipes, to try again once it is open.'
                : 'What is sent to it then waits with the messages that did not reach their recipes, '
                  + 'to try again once it is open. A run already going ends as one you refused.';
            }
            doorSwitch.addEventListener('click', () => {
              void mutate(() => options.runDoorSet!({
                ingress_id: ingress.ingress_id,
                recipe_id: recipe.recipe_id,
                open: opening,
              }), doorSwitch);
            });
            recipeActions.appendChild(doorSwitch);
          }
          item.appendChild(recipeActions);
        } else if (recipe.armed && recipe.door !== 'open' && profileModeAvailable) {
          const open = button(doc, 'Open its door', 'door-open');
          open.disabled = busy || !ingress.readiness.can_enable;
          if (!receiving) open.title = 'This also lets messages in';
          open.addEventListener('click', () => {
            void mutate(() => options.runEnable({ ingress_id: ingress.ingress_id }), open);
          });
          item.appendChild(open);
        }
        list.appendChild(item);
      }
      section.appendChild(list);
      card.appendChild(section);
    }
    const configuration = doc.createElement('details');
    configuration.open = expandedConfigurations.has(ingress.ingress_id) || ingress.registration_state === 'manual_pending';
    configuration.addEventListener('toggle', () => {
      if (!configuration.isConnected) return;
      if (configuration.open) expandedConfigurations.add(ingress.ingress_id); else expandedConfigurations.delete(ingress.ingress_id);
    });
    const configurationSummary = doc.createElement('summary'); configurationSummary.textContent = 'Configuration and delivery rules';
    configuration.appendChild(configurationSummary);

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
    const refusing = refusingShown(ingress);
    // D-201 Slice 10AR (10AM finding 30) — degraded by refused messages alone,
    // the row said "None" beside "degraded".
    row('Last thing that went wrong', refusing !== undefined && ingress.health.last_error_code === null
      ? 'Messages it could not verify (below)'
      : healthErrorText(ingress.health, neverListedOf(ingress.profile_id)));
    if (refusing !== undefined) {
      row('Messages refused', refusingText(
        refusing,
        ingress.registration_mode,
        undefined,
        // D-201 Slice 10BQ (10BM finding 13) — less those that send to another
        // address: nothing they send reaches this webhook.
        Math.max(0, (ingress.stray_endpoints ?? 0) + (ingress.stray_endpoints_given_up ?? 0)
          - (ingress.strays ?? []).filter((stray) => stray.unproven === true && stray.elsewhere === true).length),
        ingress.profile_id,
        ingress.health.last_error_code,
        // D-201 Slice 10BT (10BS finding 1) — but each refuses setting it up
        // again, so the advice counts them all.
        (ingress.stray_endpoints ?? 0) + (ingress.stray_endpoints_given_up ?? 0),
      ));
    }
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
    configuration.appendChild(detail);

    const endpoint = doc.createElement('code');
    endpoint.setAttribute(WEBHOOKS_PANEL_ENDPOINT_ATTR, '');
    endpoint.textContent = ingress.endpoint_url ?? 'No public https address yet';
    configuration.appendChild(endpoint); card.appendChild(configuration);
    const preapprovals = preapprovalHost(ingress);
    if (preapprovals !== null) card.appendChild(preapprovals);

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
    if (reconcileLabel !== null) {
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
    if (reconcileLabel !== null) {
      const reconcile = button(
        doc,
        reconcileLabel,
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
        }, retryCleanup);
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
    // D-201 Slice 10AQ (10AM finding 6) — a retired webhook is listed while a
    // stray of its stands: its card takes "I removed it", nothing more.
    if (options.runTestDelivery
      && profileModeAvailable
      && ingress.intake_state !== 'retired'
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
        deadLetterInspector = null;
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
        deadLetterInspector = null;
        loadRejectedDeliveries(ingress.ingress_id);
      });
      actions.appendChild(rejections);
    }
    if (canReviewDeadLetters) {
      const waiting = ingress.dead_letters_unresolved ?? 0;
      const inspecting = deadLetterInspector?.ingress_id === ingress.ingress_id;
      // D-201 Slice 10I (10H finding 6) — shown with none open too: the closed
      // ones (what a save, an uninstall or a retire closed) are inside it.
      const deadLetters = button(
        doc,
        inspecting
          ? 'Hide the messages that did not reach their recipes'
          : waiting > 0
            ? `See the messages that did not reach their recipes (${waiting})`
            : 'See the messages that did not reach their recipes',
        'dead-letters',
      );
      deadLetters.disabled = busy;
      deadLetters.addEventListener('click', () => {
        if (inspecting) {
          deadLetterInspector = null;
          render();
          focusCardAction(ingress.ingress_id, 'dead-letters');
          return;
        }
        deadLetterInspector = {
          ingress_id: ingress.ingress_id,
          dead_letters: [],
          next_cursor: null,
          loaded: false,
          reasons: new Map(),
          notice: null,
          closed: null,
        };
        deliveryInspector = null;
        rejectionInspector = null;
        loadDeadLetters(ingress.ingress_id);
      });
      actions.appendChild(deadLetters);
    }
    if (canEditEvents(ingress)) {
      const editing = eventsEditor?.ingress_id === ingress.ingress_id;
      const editEvents = button(
        doc,
        editing ? 'Close the event list' : 'Change the events it takes',
        'events-edit',
      );
      editEvents.disabled = busy;
      editEvents.addEventListener('click', () => {
        if (editing) {
          eventsEditor = null;
          render();
          focusCardAction(ingress.ingress_id, 'events-edit');
          return;
        }
        const known = capabilityFor(ingress.profile_id)?.event_types;
        const knownValues = known?.kind === 'open' ? known.known_values : [];
        eventsNotice = null;
        eventsEditor = {
          ingress_id: ingress.ingress_id,
          selection: {
            checked: new Set(ingress.selected_event_types),
            extras: ingress.selected_event_types.filter(
              (eventType) => !knownValues.includes(eventType),
            ),
            draft: '',
          },
        };
        render();
        const card = renderedCard(ingress.ingress_id);
        const editor = card === null ? null : findDescendant(card, (element) =>
          element.getAttribute?.(WEBHOOKS_PANEL_EVENTS_EDITOR_ATTR) === ingress.ingress_id);
        if (editor !== null) {
          focusRendered(editor, (element) =>
            element.getAttribute?.(WEBHOOKS_PANEL_EVENT_TYPE_ATTR) !== null);
        }
      });
      actions.appendChild(editEvents);
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
    if (options.runRetire && ingress.registration_state !== 'cleanup_pending' && ingress.intake_state !== 'retired') {
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
        // D-201 Slice 10F — retiring closes its open dead letters: said first,
        // on its own line just above the confirm button and as its
        // description, so a screen reader reads it with the button focus
        // moves to.
        const waiting = ingress.dead_letters_unresolved ?? 0;
        const warningId = `wh-retire-dead-letters-${ingress.ingress_id}`;
        if (waiting > 0) {
          const warning = doc.createElement('p');
          warning.className = 'wh-note';
          warning.setAttribute('id', warningId);
          warning.setAttribute(WEBHOOKS_PANEL_RETIRE_DEAD_LETTERS_ATTR, String(waiting));
          warning.textContent = waiting === 1
            ? 'Retiring it also closes the 1 message that did not reach its recipes. It cannot be tried again once the webhook is retired.'
            : `Retiring it also closes the ${waiting} messages that did not reach their recipes. They cannot be tried again once the webhook is retired.`;
          actions.appendChild(warning);
        }
        const confirmRetire = button(
          doc,
          'Really close this webhook for good?',
          'retire-confirm',
        );
        confirmRetire.disabled = busy || retirementBlocked;
        if (waiting > 0) confirmRetire.setAttribute('aria-describedby', warningId);
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
    if (deadLetterInspector?.ingress_id === ingress.ingress_id) {
      card.appendChild(deadLetterInspectorView(ingress));
    }
    if (eventsEditor?.ingress_id === ingress.ingress_id && canEditEvents(ingress)) {
      card.appendChild(eventsEditorView(ingress));
    }
    // D-201 Slice 10G (10D finding 17) — lined up, the note has done its job.
    if (eventsNotice?.ingress_id === ingress.ingress_id
      && eventsNotice.until_registered
      && ingress.registration_state === 'registered') {
      eventsNotice = null;
    }
    if (eventsNotice?.ingress_id === ingress.ingress_id) {
      const notice = doc.createElement('p');
      notice.className = 'wh-note';
      notice.setAttribute(WEBHOOKS_PANEL_EVENTS_NOTICE_ATTR, ingress.ingress_id);
      notice.setAttribute('role', 'status');
      notice.textContent = eventsNotice.text;
      card.appendChild(notice);
    }
    contextualizeCardActions(card, ingress);
    return card;
  };

  const render = (): void => {
    if (disposed) return;
    const active = doc.activeElement as HTMLInputElement | null;
    const focusedFilter = active?.dataset?.webhookFilter;
    const caret = active?.selectionStart;
    const focusedPreapproval = active !== null && [...preapprovalPanels.values()].some((item) => item.host.contains(active))
      ? active : null;
    // A delayed action owns focus only while the owner stays on its control.
    // Filters, cached pre-approvals and shell controls can take focus while it
    // runs; settling the request must respect that later choice.
    if (pendingActionFocus !== null && pendingActionFocusElement !== null
      && active !== null && active !== doc.body && active !== pendingActionFocusElement) {
      pendingActionFocus = null;
      pendingActionFocusElement = null;
      pendingCompletionFocus = null;
    }
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
    if (ingresses.length) {
      const filters = doc.createElement('div'); filters.className = 'wh-filters';
      const searchLabel = doc.createElement('label'); searchLabel.textContent = 'Search webhooks';
      const search = doc.createElement('input'); search.type = 'search'; search.value = filterQuery; search.setAttribute('data-webhook-filter', 'query');
      search.addEventListener('input', () => { filterQuery = search.value; render(); }); searchLabel.appendChild(search); filters.appendChild(searchLabel);
      const statusLabel = doc.createElement('label'); statusLabel.textContent = 'Status'; const status = doc.createElement('select'); status.setAttribute('data-webhook-filter', 'status');
      for (const [value, label] of [['', 'All statuses'], ['enabled', 'Enabled'], ['attention', 'Needs attention'], ['disabled', 'Disabled']]) {
        const option = doc.createElement('option'); option.value = value!; option.textContent = label!; option.selected = value === filterStatus; status.appendChild(option);
      }
      status.addEventListener('change', () => { filterStatus = status.value; render(); }); statusLabel.appendChild(status); filters.appendChild(statusLabel); root.appendChild(filters);
    }
    if (error) {
      const errorNode = doc.createElement('div');
      errorNode.setAttribute(WEBHOOKS_PANEL_ERROR_ATTR, '');
      errorNode.setAttribute('role', 'alert');
      errorNode.textContent = error;
      root.appendChild(errorNode);
      if (profileCapabilities.length === 0) {
        const recovery = doc.createElement('div');
        recovery.className = 'wh-actions';
        const retry = button(doc, 'Refresh webhooks', 'refresh');
        retry.disabled = busy;
        retry.addEventListener('click', () => {
          const pending = refresh();
          const heading = findDescendant(root, (element) => element.tagName === 'H2');
          heading?.focus?.({ preventScroll: true });
          void pending.then(() => {
            if (!disposed && (doc.activeElement === heading || doc.activeElement === doc.body)) {
              focusRendered(root, (element) => element.tagName === 'H2');
            }
          });
        });
        recovery.appendChild(retry);
        root.appendChild(recovery);
      }
    }
    if (deadLetterReview !== null && deadLetterReview.unresolved >= deadLetterReview.limit) {
      const full = doc.createElement('p');
      full.className = 'wh-note';
      full.setAttribute(WEBHOOKS_PANEL_DEAD_LETTER_REVIEW_ATTR, '');
      full.textContent = `Recued keeps at most ${deadLetterReview.limit.toLocaleString()} messages that did not reach their recipes, and it has that many. Each new one closes one that no door let run first, then the oldest, which keeps a record that the limit closed it. Try them again or close them on each webhook below.`;
      root.appendChild(full);
    }
    if (showCreate) root.appendChild(createForm());
    if (ingresses.length === 0 && !showCreate && !error) {
      const empty = doc.createElement('div');
      empty.className = 'wh-empty';
      empty.textContent = busy ? 'Loading webhooks…' : 'No webhooks coming in yet.';
      root.appendChild(empty);
    }
    const visible = ingresses.filter(ingress => (!filterQuery || [ingress.display_name, ingress.profile_id, ingress.environment].join(' ').toLowerCase().includes(filterQuery.toLowerCase()))
      && (!filterStatus || (filterStatus === 'attention' ? ingress.health.status !== 'healthy' || ingress.readiness.blockers.length > 0 || (ingress.stray_endpoints_given_up ?? 0) > 0 : ingress.intake_state === filterStatus)));
    for (const ingress of visible) root.appendChild(ingressCard(ingress));
    // A webhook gone or retired takes its pre-approvals' panel with it.
    for (const [ingressId, item] of preapprovalPanels) {
      if (ingresses.some((ingress) => ingress.ingress_id === ingressId && ingress.intake_state !== 'retired')) continue;
      item.panel?.dispose();
      item.host.remove();
      preapprovalPanels.delete(ingressId);
    }
    if (ingresses.length && !visible.length) { const empty = doc.createElement('p'); empty.textContent = 'No webhooks match these filters.'; empty.setAttribute('role', 'status'); root.appendChild(empty); }
    restoreActionFocus();
    // Moving its panel into the new card drops focus to <body>: put it back where it was.
    if (focusedPreapproval !== null && focusedPreapproval.isConnected
      && (doc.activeElement === null || doc.activeElement === doc.body)) {
      focusedPreapproval.focus({ preventScroll: true });
    }
    if (focusedFilter) {
      const field = root.querySelector<HTMLInputElement>(`[data-webhook-filter="${focusedFilter}"]`); field?.focus({ preventScroll: true });
      if (focusedFilter === 'query' && typeof caret === 'number') field?.setSelectionRange(caret, caret);
    }
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
    hasInFlightWork: () => mutationInFlight
      || [...preapprovalPanels.values()].some((item) => item.panel?.pending() === true),
    dispose() {
      if (disposed) return;
      disposed = true;
      oneTime = null;
      for (const item of preapprovalPanels.values()) item.panel?.dispose();
      preapprovalPanels.clear();
      root.remove();
    },
  };
};
