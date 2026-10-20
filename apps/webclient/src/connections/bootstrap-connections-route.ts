/** Connections — top-level route (treemap §6, review-log R13–R16, D-201).
 *
 *  A `[Mail · Calendar · Files · Apps & APIs · Webhooks]` surface over the
 *  foundational account lanes, generic outbound connections, and inbound
 *  webhook control plane, backed by three substrates:
 *    - Mail / Calendar / Files = FOUNDATIONAL account lanes bound through
 *      the coded `collection.{mail,calendar,file}.*` adapters
 *      (`accounts-lane-panel.ts` + the pure `renderAccountsPanel`).
 *    - Apps & APIs (`others` in the stable route id) = the generic
 *      `connection.*` REACH lane (api / mcp / notification) — the existing
 *      enrollment panel, rehosted here.
 *    - Webhooks = the owner-only `webhook.ingress.*` inbound lifecycle.
 *
 *  The unified tab bar lives in THIS route (it spans all three substrates).
 *  Tabs are anchors whose href is the lane's deep link
 *  (`#connections/<tab>`); `connections` is a `WEBCLIENT_DEEP_LINK_ROUTES`
 *  member, so a tab click changes the hash and the shell re-mounts this
 *  route with the new `initialTab` — back / forward / refresh all hold.
 *  Only the active tab's panel mounts per route instance.
 *
 *  The standalone per-connection "Operation grants" matrix retired with
 *  R13 (write-ops come from installing the pack that declares them; the
 *  server floor is untouched), so this route no longer hosts it. */

import { PRIMITIVE_STYLES } from '@recued/ui-shared/primitives';
import { mountSourceSpheresPanel, type SourceSpheresOptions } from './source-spheres-panel.js';
import { isAuthenticationIncidentHistoryFilters } from '@recued/contracts';
import {
  CONNECTION_NAME_REGEX,
  CONNECTIONS_PAGE_STYLES,
  ACCOUNTS_PANEL_STYLES,
  type ConnectionsPostSafeStopProfileHandoff,
  type ServerUpdateReceiptVerificationState,
} from '@recued/ui-shared';

import {
  mountAccountsLanePanel,
  type AccountsLanePanelMount,
  type CalendarLaneCallers,
  type FileLaneCallers,
  type MailLaneCallers,
  type AccountsOAuthEnv,
  type OAuthClientConfigResult,
} from './accounts-lane-panel.js';
import type { FoundationalOAuthContinuity } from './foundational-oauth-continuity.js';
import { accountSetupEnrollment, type AccountSetupContinuity } from './account-setup-continuity.js';
import {
  connectionsAccountAddress,
  connectionsEnrollAddress,
  connectionsOAuthAppsAddress,
  connectionsOAuthAppAddress,
  connectionsAccessResultAddress,
  connectionsAccessCheckAddress,
  connectionsAccessRepairReturn,
  isConnectionAccessResultReference,
  isConnectionAccessCheckReference,
  connectionsAddressSelection,
  connectionsLaneAddress,
  isConnectionsTabId,
  isFoundationalConnectionsLane,
  type ConnectionsAddress,
  type ConnectionsTabId,
  type ConnectionOAuthAppReview,
  type ConnectionAccessResultReference,
  type ConnectionAccessCheckReference,
} from './connections-navigation.js';
import type { ProviderSetupContinuityStore } from './provider-setup-continuity.js';
import type { SignInGridCallers } from './sign-in-grid-controls.js';
import type { CredentialRotationContinuityStore } from './credential-rotation-continuity.js';
import type { CredentialRotationTabConvergence } from './credential-rotation-tab-convergence.js';
import type { CredentialRotationServerUpdateContinuity } from './credential-rotation-server-update-continuity.js';
import {
  CONNECTIONS_GRANT_PANEL_STYLES,
  mountConnectionsGrantPanel,
  type ConnectionsGrantGroupCaller,
  type ConnectionsGrantPanelMount,
  type ConnectionsListCaller,
  type ConnectionsListGroupsCaller,
  type ConnectionsRevokeGroupCaller,
} from '../settings/connections-grant-panel.js';
import {
  mountConnectionsEnrollPanel,
  type ConnectionsCompleteVendorOAuthCaller,
  type ConnectionsDeleteCaller,
  type ConnectionsEngagementHealthCaller,
  type ConnectionsEnrollCaller,
  type ConnectionsEnrollListCaller,
  type ConnectionsEnrollPanelMount,
  type ConnectionsMailListCaller,
  type ConnectionsPreviewPurgeCaller,
  type ConnectionsRemovalEffectsCaller,
  type ConnectionsProbeCaller,
  type ConnectionsMcpPackPreviewCaller,
  type ConnectionsMcpPackCommitCaller,
  type ConnectionsReprobeEngagementCapabilitiesCaller,
  type ConnectionsStartVendorOAuthCaller,
  type ConnectionsTakeVendorOAuthResultCaller,
  type ConnectionsRotateCredentialsCaller,
  type ConnectionsCredentialRotationStatusCaller,
  type ConnectionsCredentialRotationActivityCaller,
  type ConnectionsAcknowledgeCredentialRotationSafeStopCaller,
  type ConnectionsCredentialRotationServerUpdateTriageCaller,
  type ConnectionsUpdateCaller,
  type ConnectionsGetMatchPatternsCaller,
  type ConnectionsSetMatchPatternsCaller,
  type ConnectionsSuggestSetupCaller,
  type CredentialRotationServerUpdateTarget,
} from '../settings/connections-enroll-panel.js';
import { serializeShellRoute } from '../shell/route.js';
import { createHierarchicalHistory } from '../shell/hierarchical-navigation.js';
import { serializeChatConnectedSource } from '../chat/connected-source-handoff.js';
import {
  mountWebhooksPanel,
  WEBHOOKS_PANEL_STYLES,
  type WebhooksCreateCaller,
  type WebhooksCredentialRetireCaller,
  type WebhooksCredentialWriteCaller,
  type WebhooksDeliveryEventGetCaller,
  type WebhooksDeliveryGetCaller,
  type WebhooksDeliveryListCaller,
  type WebhooksDisableCaller,
  type WebhooksEnableCaller,
  type WebhooksListCaller,
  type WebhooksManualConfirmCaller,
  type WebhooksRegistrationReconcileCaller,
  type WebhooksPanelMount,
  type WebhooksRejectedDeliveryListCaller,
  type WebhooksRetireCaller,
  type WebhooksTestDeliveryCaller,
  type WebhooksRetentionPruneCaller,
} from './webhooks-panel.js';
import type { AccountLaneId } from '@recued/ui-shared';
import type {
  OAuthAppConfigSnapshot,
  PackListEntry,
  SetOAuthAppConfigArgs,
} from '@recued/contracts';
import type { BroadcastSubscriber } from '../realtime/subscriber.js';
import { createManagedOAuthPanel, type ManagedOAuthPanelContext } from '../settings/managed-oauth-panel.js';
import { createReconnectWorklistPanel, RECONNECT_WORKLIST_STYLES } from '../settings/reconnect-worklist-panel.js';
import { createAuthenticationIncidentPanel, AUTHENTICATION_INCIDENT_STYLES } from './authentication-incident-panel.js';
import { createAuthenticationAccessPanel } from './authentication-access-panel.js';
import { createManagedOAuthMigrationPanel } from '../settings/managed-oauth-migration-panel.js';
import { mountConnectionReplacementPanel } from './connection-replacement-panel.js';
import type { ConnectionReplacementCaller } from './connection-replacement-caller.js';
import { createOAuthAppsPanel, OAUTH_APPS_STYLES, type OAuthAppsCaller } from '../settings/oauth-apps-panel.js';
import { OAUTH_TROUBLESHOOTING_STYLES } from './oauth-troubleshooting.js';

export const CONNECTIONS_ROUTE_GRANTS_SECTION_ATTR =
  'data-recued-connections-route-grants';
export const CONNECTIONS_ROUTE_ENROLL_HOST_ATTR =
  'data-recued-connections-route-enroll-host';
export const CONNECTIONS_ROUTE_STYLES_MARKER =
  'data-recued-connections-route-styles';
export const CONNECTIONS_ROUTE_HOST_ATTR = 'data-recued-connections-route';
export const CONNECTIONS_ROUTE_HEADING_ATTR =
  'data-recued-connections-route-heading';
export const CONNECTIONS_ROUTE_DESCRIPTION_ATTR =
  'data-recued-connections-route-description';
export const CONNECTIONS_ROUTE_TABS_ATTR =
  'data-recued-connections-route-tabs';
export const CONNECTIONS_ROUTE_CONTENT_ATTR =
  'data-recued-connections-route-content';
export const CONNECTIONS_ROUTE_UNAVAILABLE_ATTR =
  'data-recued-connections-route-unavailable';
/** D-322 — broker management stays within Apps & APIs. */
export const CONNECTIONS_MANAGE_BROKERS_ATTR = 'data-recued-connections-manage-brokers';
export const CONNECTIONS_CREDENTIAL_ROTATION_RETRY_SEGMENT =
  'retry-credential-rotation';
export const CONNECTIONS_POST_SAFE_STOP_RECOVERY_SEGMENT =
  'finish-recovery';
const CONNECTIONS_POST_SAFE_STOP_PROFILE_SEGMENT = 'profile';
const MAX_SERVER_PROFILE_ID_LENGTH = 256;

const validServerProfileId = (value: unknown): value is string =>
  typeof value === 'string'
  && value.trim().length > 0
  && value.length <= MAX_SERVER_PROFILE_ID_LENGTH;

/** A post-ack recovery identity is meaningful only inside the local server
 * profile whose authenticated boot produced it. The opaque browser-local
 * profile id is safe to route; labels, URLs, credentials, and form values are
 * deliberately excluded. */
export interface ProfileBoundPostSafeStopRecoveryTarget
  extends CredentialRotationServerUpdateTarget {
  serverProfileId: string;
}

/** Address carried by Account's server-update guide. It intentionally contains
 * only the existing connection identity; provider credentials and form values
 * never enter the URL. */
export const serializeConnectionsCredentialRotationRetry = (
  target: CredentialRotationServerUpdateTarget,
): string => serializeShellRoute(
  'connections',
  'others',
  CONNECTIONS_CREDENTIAL_ROTATION_RETRY_SEGMENT,
  target.kind,
  target.name,
);

export const parseConnectionsCredentialRotationRetry = (
  segments: readonly string[],
): CredentialRotationServerUpdateTarget | null => {
  if (
    segments.length !== 4
    || segments[0] !== 'others'
    || segments[1] !== CONNECTIONS_CREDENTIAL_ROTATION_RETRY_SEGMENT
    || !CONNECTION_NAME_REGEX.test(segments[3] ?? '')
  ) return null;
  const kind = segments[2];
  if (kind !== 'api' && kind !== 'mcp' && kind !== 'notification') return null;
  return { kind, name: segments[3]! };
};

/** Exact Attention handoff for an unresolved post-ack check/reopen. The
 * address carries only browser-local profile id + connection identity; the
 * Connections panel still re-lists that profile's server authority before
 * presenting any action. */
export const serializeConnectionsPostSafeStopRecovery = (
  target: ProfileBoundPostSafeStopRecoveryTarget,
): string => serializeShellRoute(
  'connections',
  'others',
  CONNECTIONS_POST_SAFE_STOP_RECOVERY_SEGMENT,
  CONNECTIONS_POST_SAFE_STOP_PROFILE_SEGMENT,
  target.serverProfileId,
  target.kind,
  target.name,
);

export const parseConnectionsPostSafeStopRecovery = (
  segments: readonly string[],
): ProfileBoundPostSafeStopRecoveryTarget | null => {
  if (
    segments.length !== 6
    || segments[0] !== 'others'
    || segments[1] !== CONNECTIONS_POST_SAFE_STOP_RECOVERY_SEGMENT
    || segments[2] !== CONNECTIONS_POST_SAFE_STOP_PROFILE_SEGMENT
    || !validServerProfileId(segments[3])
    || !CONNECTION_NAME_REGEX.test(segments[5] ?? '')
  ) return null;
  const kind = segments[4];
  if (kind !== 'api' && kind !== 'mcp' && kind !== 'notification') return null;
  return {
    serverProfileId: segments[3],
    kind,
    name: segments[5]!,
  };
};

export type ProfileBoundPostSafeStopRecoveryResolution =
  | { status: 'none' }
  | { status: 'unbound' }
  | {
      status: 'profile_mismatch';
      target: ProfileBoundPostSafeStopRecoveryTarget;
    }
  | {
      status: 'matched';
      target: ProfileBoundPostSafeStopRecoveryTarget;
    };

/** Resolve a temporary post-ack address against the profile that actually
 * completed this boot. A malformed legacy address is an explicit unbound
 * handoff, not permission to reuse its kind/name against the current server. */
export const resolveProfileBoundPostSafeStopRecovery = (
  segments: readonly string[],
  activeProfileId: string | null,
): ProfileBoundPostSafeStopRecoveryResolution => {
  const attempted = segments[0] === 'others'
    && segments[1] === CONNECTIONS_POST_SAFE_STOP_RECOVERY_SEGMENT;
  if (!attempted) return { status: 'none' };
  const parsed = parseConnectionsPostSafeStopRecovery(segments);
  if (parsed === null || !validServerProfileId(activeProfileId)) {
    return { status: 'unbound' };
  }
  if (parsed.serverProfileId !== activeProfileId) {
    return {
      status: 'profile_mismatch',
      target: parsed,
    };
  }
  return {
    status: 'matched',
    target: parsed,
  };
};

/** The five top-level lanes. `'others'` remains the stable deep-link id for
 *  the user-facing Apps & APIs lane; the other non-webhook tabs are
 *  foundational account lanes. */
const CONNECTIONS_TABS = [
  { id: 'mail', label: 'Mail' },
  { id: 'calendar', label: 'Calendar' },
  { id: 'file', label: 'Files' },
  { id: 'others', label: 'Apps & APIs' },
  { id: 'webhooks', label: 'Webhooks' },
] as const;

// Same-surface tab navigation remounts this route. Carry only the activated
// tab across that short boundary, scoped to the owning document and consumed
// by the next Connections mount so direct links never steal focus.
const pendingTabFocusByDocument = new WeakMap<Document, ConnectionsTabId>();

const isFoundationalLane = (tab: ConnectionsTabId): tab is AccountLaneId =>
  isFoundationalConnectionsLane(tab);

const resolveTab = (raw: string | undefined): ConnectionsTabId =>
  isConnectionsTabId(raw) ? raw : 'mail';

const CONNECTIONS_ROUTE_CHROME_STYLES = `
[${CONNECTIONS_ROUTE_HOST_ATTR}] {
  max-width: var(--wc-content-max, 1080px);
  margin: 0 auto;
  padding: 22px 16px 36px;
  color: var(--fg);
}
[${CONNECTIONS_ROUTE_HOST_ATTR}] .connections-route-header {
  display: grid;
  gap: 7px;
  max-width: 720px;
  margin-bottom: 20px;
}
[${CONNECTIONS_ROUTE_HOST_ATTR}] .connections-route-title {
  margin: 0;
  color: var(--fg-strong, var(--fg));
  font-size: 28px;
  line-height: 1.15;
  font-weight: 700;
  letter-spacing: -0.025em;
}
[${CONNECTIONS_ROUTE_HOST_ATTR}] .connections-route-description {
  margin: 0;
  color: var(--muted);
  font-size: 14px;
  line-height: 1.55;
}
[${CONNECTIONS_ROUTE_TABS_ATTR}] {
  display: flex;
  gap: 4px;
  flex-wrap: nowrap;
  min-width: 0;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: thin;
  overscroll-behavior-x: contain;
  /* Keep the separator inside the rail; overlapping its border with a
     negative tab margin creates one pixel of vertical scroll overflow. */
  box-shadow: inset 0 -1px 0 var(--border);
  margin-bottom: 20px;
}
[${CONNECTIONS_ROUTE_TABS_ATTR}] .connections-route-tab {
  flex: 0 0 auto;
  appearance: none;
  text-decoration: none;
  border-bottom: 2px solid transparent;
  padding: 9px 14px 10px;
  font-weight: 600;
  font-size: 14px;
  white-space: nowrap;
  color: var(--muted);
  cursor: pointer;
  transition: color 120ms ease, background-color 120ms ease;
}
[${CONNECTIONS_ROUTE_TABS_ATTR}] .connections-route-tab:hover {
  color: var(--fg);
  background: var(--surface-sunk);
}
[${CONNECTIONS_ROUTE_TABS_ATTR}] .connections-route-tab--active {
  color: var(--fg);
  border-bottom-color: var(--accent);
}
/* Keep the keyboard focus ring inside the scrolling row. */
[${CONNECTIONS_ROUTE_HOST_ATTR}] [${CONNECTIONS_ROUTE_TABS_ATTR}] .connections-route-tab:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -3px;
}
[${CONNECTIONS_ROUTE_CONTENT_ATTR}],
[${CONNECTIONS_ROUTE_ENROLL_HOST_ATTR}] { min-width: 0; }
.connections-authentication-settings{border-top:1px solid var(--border);padding-top:16px;margin-top:24px;min-width:0}
.connections-authentication-settings>summary{font-size:14px;font-weight:600;cursor:pointer;padding:8px 0}
.connections-authentication-settings .oauth-apps h2,.connections-authentication-settings .oauth-apps h3{font-size:16px;margin:0 0 8px}
.connections-setup-return{border:1px solid var(--border);padding:12px;border-radius:8px;margin-bottom:16px;font-size:13px}
.connections-setup-return p{margin:0 0 8px}
.reconnect-worklist-disclosure{font-size:13px;border:1px solid var(--border);border-radius:8px;padding:10px 12px;margin:0 0 16px}
.reconnect-worklist-disclosure>summary{cursor:pointer;font-weight:600}
.reconnect-worklist-disclosure .reconnect-worklist{border:0;padding:12px 0 0;margin:0;font-size:13px}
.reconnect-worklist-disclosure h2,.reconnect-worklist-disclosure h3{font-size:16px}
[${CONNECTIONS_ROUTE_UNAVAILABLE_ATTR}] {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  background: var(--surface-subtle);
  color: var(--muted);
  font-size: 13px;
}
/* Empty / dashed enrollment states read as intentional panels rather
   than a bare muted line in whitespace (mirrors the shell §8 polish). */
[${CONNECTIONS_ROUTE_HOST_ATTR}] .rx-empty-hint {
  display: block;
  margin: 0;
  padding: 18px;
  border: 1px dashed var(--border-strong);
  border-radius: 8px;
  background: var(--surface-sunk);
  text-align: center;
  color: var(--fg-muted);
  font-size: 13px;
  line-height: 1.5;
  opacity: 1;
}
@media (max-width: 720px) {
  [${CONNECTIONS_ROUTE_HOST_ATTR}] {
    padding: 18px 14px 28px;
  }
  [${CONNECTIONS_ROUTE_HOST_ATTR}] .connections-route-header {
    margin-bottom: 16px;
  }
  [${CONNECTIONS_ROUTE_HOST_ATTR}] .connections-route-title {
    font-size: 25px;
  }
  [${CONNECTIONS_ROUTE_TABS_ATTR}] {
    margin-right: -14px;
    padding-right: 14px;
    margin-bottom: 18px;
  }
}
`;

export const CONNECTIONS_ROUTE_STYLES = [
  OAUTH_APPS_STYLES,
  OAUTH_TROUBLESHOOTING_STYLES,
  RECONNECT_WORKLIST_STYLES,
  AUTHENTICATION_INCIDENT_STYLES,
  PRIMITIVE_STYLES,
  CONNECTIONS_PAGE_STYLES,
  ACCOUNTS_PANEL_STYLES,
  WEBHOOKS_PANEL_STYLES,
  CONNECTIONS_GRANT_PANEL_STYLES,
  CONNECTIONS_ROUTE_CHROME_STYLES,
].join('\n');

export interface BootstrapConnectionsRouteOptions {
  sourceSpheres?: SourceSpheresOptions;
  authenticationIncidentHistoryCaller?: import('@recued/contracts').AuthenticationIncidentHistoryCaller;
  authenticationHistoryExportCaller?: import('@recued/contracts').AuthenticationHistoryExportCaller;
  initialIncidentHistory?: import('@recued/contracts').AuthenticationIncidentScope | null;
  initialIncidentHistoryFilters?: import('@recued/contracts').AuthenticationIncidentHistoryFilters;
  initialAccessVerification?: import('@recued/contracts').AuthenticationAccessSelection | null;
  initialAccessResult?: ConnectionAccessResultReference | null;
  initialAccessCheck?: ConnectionAccessCheckReference | null;
  authenticationRepairsCaller?: import('@recued/contracts').AuthenticationRepairCaller;
  initialManageOAuthApps?: boolean;
  initialOAuthAppReview?: ConnectionOAuthAppReview;
  initialAccountAuthentication?: { platform: 'mail' | 'calendar'; slug: string };
  initialRenewalReturn?: ConnectionOAuthAppReview;
  initialAccessRepairReturn?: ConnectionAccessResultReference;
  oauthAppsCaller?: OAuthAppsCaller;
  reconnectWorklistCaller?: import('../settings/reconnect-worklist-panel.js').PackReconnectCaller;
  onWorklistReconnect?(group: import('@recued/contracts').PackReconnectGroup): void;
  initialWorklistReturn?: import('../settings/reconnect-worklist-continuity.js').ReconnectWorklistReturn;
  root: HTMLElement;
  document?: Document;
  /** Preferred complete route selection. Legacy positional fields below stay
   * available for narrow/test mounts; production passes this typed address. */
  initialAddress?: ConnectionsAddress;
  /** D-322 §24 — open a fresh saved editor; consent remains owner-triggered. */
  initialConnectionAccessReview?: { name: string };
  initialFileAuthenticationSwitch?: { name: string };
  initialPermissionRepair?: import('../settings/reconnect-worklist-continuity.js').ConnectionPermissionRepair;
  permissionRepairUnavailable?: boolean;
  permissionRepairPreviewCaller?: import('../settings/packs-panel.js').PacksInstallPreviewCaller;
  onPermissionRepairReturn?(verified: boolean, collections?: import('../settings/pack-permission-repair.js').PackPermissionRepair['reconnect_collections']): void;
  /** Keeps the shell's same-route comparison baseline aligned after a
   * successful in-page account list/detail History write. */
  onHashSync?: (hash: string) => void;
  /** Hash navigation seam used by post-connect next actions. The webclient
   *  bootstrap supplies its hash-source-aware navigator; direct mounts fall
   *  back to the document's location. */
  navigate?: (hash: string) => void;
  accountSetupContinuity?: AccountSetupContinuity;
  listCloudFiles?: () => Promise<{ sources: import('@recued/contracts').CloudFileSource[] }>;
  /** Deep-link segment 0 — the active lane tab (`#connections/<tab>`).
   *  Defaults to `mail`. */
  initialTab?: string;
  /** Deep-link segment 1 — a foundational account to open in detail
   *  (`#connections/<lane>/<slug>`). */
  initialDetailSlug?: string;
  /** Packs "Set up" deep link — `#connections/others/enroll/<vendor>`
   *  (segment 1 = the `enroll` verb, segment 2 = the vendor). Forwarded to
   *  the Apps & APIs enroll panel as its `initialVendor` so the enroll form
   *  opens pre-selected for that vendor. Ignored on foundational lanes. */
  initialEnrollVendor?: string;
  /** One-shot exact return from Account's server-update guide. */
  initialCredentialRotationServerUpdateRetry?:
    CredentialRotationServerUpdateTarget;
  /** Identity-only exact handoff from Attention into an unresolved post-ack
   * check/reopen. The panel selects it only if the current list still does. */
  initialPostSafeStopRecovery?: CredentialRotationServerUpdateTarget;
  /** Presentation-only identity of the booted profile whose current server
   * supplies the post-ack sidecar. */
  postSafeStopProfileLabel?: string;
  /** Safe landing for a legacy or cross-profile recovery address. */
  postSafeStopProfileHandoff?: ConnectionsPostSafeStopProfileHandoff;
  /** Opens Account's local server-profile roster from that safe landing. */
  onOpenPostSafeStopServerProfiles?: () => void;
  /** The owner dismissed the cross-profile handoff or explicitly chose this
   * profile's queue, so boot can retire the bound address for this mount. */
  onPostSafeStopProfileHandoffSettled?: () => void;
  /** One-shot memory-only completion transferred from boot before the exact
   * return consumes it. */
  initialCredentialRotationServerUpdateCompletion?:
    ServerUpdateReceiptVerificationState;
  /** Exact return is consumed only after the panel reaches a stable landing;
   * in-flight/waiting preflight state remains reload-safe. */
  onCredentialRotationServerUpdateRetrySettled?: (
    target: CredentialRotationServerUpdateTarget,
  ) => void;
  /** Exact preflight opened an untouched clean editor. */
  onCredentialRotationCleanEditorReady?: (
    target: CredentialRotationServerUpdateTarget,
  ) => void;
  /** First actual clean-editor field change retires its target-only resume. */
  onCredentialRotationCleanEditorChanged?: (
    target: CredentialRotationServerUpdateTarget,
  ) => void;
  /** Exact return route unmounted before its authoritative preflight settled. */
  onCredentialRotationServerUpdateRetryInterrupted?: (
    target: CredentialRotationServerUpdateTarget,
  ) => void;
  /** Opens the route-independent Account/server-profile guide. */
  onOpenCredentialRotationServerUpdateGuide?: (
    target: CredentialRotationServerUpdateTarget,
  ) => void;
  // ── Apps & APIs (`others` route id; generic connection.*) callers ──
  connectionsEnrollListCaller?: ConnectionsEnrollListCaller;
  /** Fork 1 B — `packs.list` caller; lights up the editable vendor-scope
   *  pre-fill in the enroll dialog. Optional + soft (absent → server unions). */
  connectionsPacksListCaller?: () => Promise<{ packs: ReadonlyArray<PackListEntry> }>;
  connectionsEnrollCaller?: ConnectionsEnrollCaller;
  connectionsUpdateCaller?: ConnectionsUpdateCaller;
  connectionsRotateCredentialsCaller?: ConnectionsRotateCredentialsCaller;
  connectionsCredentialRotationStatusCaller?: ConnectionsCredentialRotationStatusCaller;
  connectionsCredentialRotationActivityCaller?: ConnectionsCredentialRotationActivityCaller;
  connectionsAcknowledgeCredentialRotationSafeStopCaller?:
    ConnectionsAcknowledgeCredentialRotationSafeStopCaller;
  connectionsCredentialRotationServerUpdateTriageCaller?:
    ConnectionsCredentialRotationServerUpdateTriageCaller;
  credentialRotationContinuity?: CredentialRotationContinuityStore;
  credentialRotationTabConvergence?: CredentialRotationTabConvergence;
  credentialRotationServerUpdateContinuity?: Pick<
    CredentialRotationServerUpdateContinuity,
    'beginExactReturn' | 'read' | 'resumeResolvedRetry' | 'subscribe'
  >;
  onReconnect?: (listener: () => void) => () => void;
  connectionsDeleteCaller?: ConnectionsDeleteCaller;
  /** D-192 slice 5 — removal-preview "[N] item(s)" count for the delete-confirm
   *  dialog. Optional (absent → the confirm shows no checkbox). */
  connectionsPreviewPurgeCaller?: ConnectionsPreviewPurgeCaller;
  /** D-320 slice 2g — where each pack's runs go once a connection is deleted.
   *  Optional (absent → the confirm says nothing of it). */
  connectionsRemovalEffectsCaller?: ConnectionsRemovalEffectsCaller;
  /** D-320 slice 2h — the per-sign-in grids' calls. Optional (absent → no grid). */
  signInGridCallers?: SignInGridCallers;
  connectionsProbeCaller?: ConnectionsProbeCaller;
  /** D-165 follow-on, restored after R13 — the per-connection operation-group
   *  grant surface. Write ops on a catalog connection are NEVER auto-granted
   *  (Invariant 3: the enrolment boot seed admits read-tier ops only), so
   *  without these a hand-enrolled connection has no path from
   *  `operation_not_granted` to usable. The rpc family stayed wired server-side
   *  the whole time; R13 deleted only its consumer. */
  connectionsListCaller?: ConnectionsListCaller;
  connectionsListGroupsCaller?: ConnectionsListGroupsCaller;
  connectionsGrantGroupCaller?: ConnectionsGrantGroupCaller;
  connectionsRevokeGroupCaller?: ConnectionsRevokeGroupCaller;
  /** D-225 Slice 2 — the generated-pack review + install. Optional; absent →
   *  the review is never offered, which beats a button that fails. */
  connectionsMcpPackPreviewCaller?: ConnectionsMcpPackPreviewCaller;
  connectionsMcpPackCommitCaller?: ConnectionsMcpPackCommitCaller;
  /** D-192 M4c-UI — messenger trigger read + merge-write for the slack/telegram
   *  "Message triggers" editor. */
  connectionsGetMatchPatternsCaller?: ConnectionsGetMatchPatternsCaller;
  connectionsSetMatchPatternsCaller?: ConnectionsSetMatchPatternsCaller;
  connectionsEngagementHealthCaller?: ConnectionsEngagementHealthCaller;
  connectionsReprobeEngagementCapabilitiesCaller?: ConnectionsReprobeEngagementCapabilitiesCaller;
  connectionsMailListCaller?: ConnectionsMailListCaller;
  connectionsSuggestSetupCaller?: ConnectionsSuggestSetupCaller;
  /** Boot-owned safe guide carrier shared by route remounts. */
  providerSetupContinuity?: ProviderSetupContinuityStore;
  connectionsStartVendorOAuthCaller?: ConnectionsStartVendorOAuthCaller;
  /** Owner-reviewed replacement of selected local account references. */
  connectionReplacementCaller?: ConnectionReplacementCaller;
  /** D-322 — optional managed OAuth broker RPC. */
  connectionsManagedOAuthCaller?: import('../settings/managed-oauth-panel.js').ManagedOAuthCaller;
  /** R26.2 Option B — the pure code-exchange rpc, so a loopback PWA can finish
   *  a vendor OAuth dance without a public HTTPS server URL. */
  connectionsCompleteVendorOAuthCaller?: ConnectionsCompleteVendorOAuthCaller;
  connectionsTakeVendorOAuthResultCaller?: ConnectionsTakeVendorOAuthResultCaller;
  subscribe?: BroadcastSubscriber['on'];
  // ── Inbound webhook control plane (D-201 Slices 5A + 5B2B) ──
  webhooksListCaller?: WebhooksListCaller;
  webhooksCreateCaller?: WebhooksCreateCaller;
  webhooksCredentialWriteCaller?: WebhooksCredentialWriteCaller;
  webhooksCredentialRetireCaller?: WebhooksCredentialRetireCaller;
  webhooksManualConfirmCaller?: WebhooksManualConfirmCaller;
  webhooksRegistrationReconcileCaller?: WebhooksRegistrationReconcileCaller;
  webhooksEnableCaller?: WebhooksEnableCaller;
  webhooksDisableCaller?: WebhooksDisableCaller;
  webhooksTestDeliveryCaller?: WebhooksTestDeliveryCaller;
  webhooksDeliveryListCaller?: WebhooksDeliveryListCaller;
  webhooksDeliveryGetCaller?: WebhooksDeliveryGetCaller;
  webhooksDeliveryEventGetCaller?: WebhooksDeliveryEventGetCaller;
  webhooksRejectedDeliveryListCaller?: WebhooksRejectedDeliveryListCaller;
  webhooksRetireCaller?: WebhooksRetireCaller;
  webhooksRetentionPruneCaller?: WebhooksRetentionPruneCaller;
  // ── Foundational lane callers ──
  mail?: MailLaneCallers;
  calendar?: CalendarLaneCallers;
  file?: FileLaneCallers;
  /** Shared OAuth client-config caller for the Mail/Calendar sign-in lanes. */
  getOAuthClientConfig?: () => Promise<OAuthClientConfigResult>;
  /** BYO OAuth-app config callers — the inline Google / Microsoft sign-in app
   *  credentials on the account forms (forwarded to the foundational panel). */
  getOAuthAppConfig?: () => Promise<OAuthAppConfigSnapshot>;
  setOAuthAppConfig?: (args: SetOAuthAppConfigArgs) => Promise<{ ok: true }>;
  /** Boot-owned foundational OAuth transaction. Keeping this above the route
   *  mount is what lets hash navigation detach and reattach its presentation. */
  foundationalOAuthContinuity?: FoundationalOAuthContinuity;
  /** Deterministic direct-route test seam; production uses the browser env. */
  accountsOAuthEnv?: AccountsOAuthEnv;
  /** Shared clock for interrupted-OAuth retry grace. */
  now?: () => number;
}

export interface ConnectionsRoute {
  /** The active tab. */
  activeTab(): ConnectionsTabId;
  /** The foundational account panel (mounted only on the Mail / Calendar
   *  / Files tabs), else null. */
  accountsPanel(): AccountsLanePanelMount | null;
  /** The generic connection.* enroll panel (mounted only on the Apps & APIs
   *  tab), else null. */
  connectionsEnrollPanel(): ConnectionsEnrollPanelMount | null;
  connectionsGrantPanel(): ConnectionsGrantPanelMount | null;
  /** Re-labels profile-bound recovery copy after a local roster refresh. */
  setPostSafeStopProfileContext(context: {
    activeProfileLabel: string;
    sourceProfileLabel?: string;
  }): void;
  /** Inbound webhook setup panel (mounted only on the Webhooks tab). */
  webhooksPanel(): WebhooksPanelMount | null;
  /** Active lane's initial authoritative read. */
  whenLoaded(): Promise<void>;
  getRecoveryContextFreshness(): 'current' | 'unavailable';
  /** Re-read the active lane without reopening an editor or restoring its
   * credential-bearing draft. Absent when the lane has no readable panel. */
  retryRecoveryContext?(): Promise<void>;
  /** The generic connection editor has a memory-only draft that would be lost
   * if this route unmounted. */
  hasUnsavedChanges(): boolean;
  /** Exact, privacy-safe leave warning for the active connection draft. */
  unsavedChangesPrompt(): string | null;
  hasInFlightWork(): boolean;
  /** Contextual guard for connection writes that cannot be recalled. */
  inFlightWorkPrompt(): string | null;
  dispose(): void;
}

const appendUnavailable = (
  doc: Document,
  host: HTMLElement,
  text: string,
): void => {
  const unavailable = doc.createElement('div');
  unavailable.setAttribute(CONNECTIONS_ROUTE_UNAVAILABLE_ATTR, '');
  unavailable.textContent = text;
  host.appendChild(unavailable);
};

export const bootstrapConnectionsRoute = (
  opts: BootstrapConnectionsRouteOptions,
): ConnectionsRoute => {
  const doc = opts.document ?? (globalThis as { document?: Document }).document;
  if (doc === undefined) {
    throw new Error(
      'bootstrapConnectionsRoute: no document available - pass `opts.document` for non-browser environments',
    );
  }

  if (
    doc.head.querySelector(`style[${CONNECTIONS_ROUTE_STYLES_MARKER}]`) === null
  ) {
    const style = doc.createElement('style');
    style.setAttribute(CONNECTIONS_ROUTE_STYLES_MARKER, '');
    style.textContent = CONNECTIONS_ROUTE_STYLES;
    doc.head.appendChild(style);
  }

  const typedSelection = opts.initialAddress === undefined
    ? null
    : connectionsAddressSelection(opts.initialAddress);
  const activeTab = typedSelection?.tab ?? resolveTab(opts.initialTab);
  const initialDetailSlug = typedSelection === null
    ? opts.initialDetailSlug
    : typedSelection.detailSlug ?? undefined;
  const initialEnrollVendor = typedSelection === null
    ? opts.initialEnrollVendor
    : typedSelection.enrollVendor ?? undefined;
  const mountedConnectionsAddress = opts.initialAddress?.kind === 'account'
    ? connectionsAccountAddress(
        opts.initialAddress.lane,
        opts.initialAddress.slug,
      )
    : opts.initialAddress?.kind === 'enroll'
      ? connectionsEnrollAddress(opts.initialAddress.vendor, opts.initialAddress.pack)
      : connectionsLaneAddress(activeTab);
  const connectionsHistory = createHierarchicalHistory({
    initial: opts.initialAddress !== undefined
      ? mountedConnectionsAddress
      : isFoundationalLane(activeTab) && initialDetailSlug !== undefined
        ? connectionsAccountAddress(activeTab, initialDetailSlug)
        : connectionsLaneAddress(activeTab),
    history: () => doc.defaultView?.history,
    onCommit: (address) => opts.onHashSync?.(address.hash),
  });

  const routeRoot = doc.createElement('div');
  routeRoot.setAttribute(CONNECTIONS_ROUTE_HOST_ATTR, '');

  const header = doc.createElement('header');
  header.className = 'connections-route-header';
  const heading = doc.createElement('h1');
  heading.className = 'connections-route-title';
  heading.setAttribute(CONNECTIONS_ROUTE_HEADING_ATTR, '');
  heading.textContent = 'Connections';
  header.appendChild(heading);
  const description = doc.createElement('p');
  description.className = 'connections-route-description';
  description.setAttribute(CONNECTIONS_ROUTE_DESCRIPTION_ATTR, '');
  description.textContent =
    'Bring your mail, calendars, files, and everyday services into Recued.';
  header.appendChild(description);
  routeRoot.appendChild(header);

  // ── Tab bar (anchors → hash → shell remount) ──
  const tabBar = doc.createElement('nav');
  tabBar.setAttribute(CONNECTIONS_ROUTE_TABS_ATTR, '');
  tabBar.setAttribute('data-recued-scroll-rail', '');
  tabBar.setAttribute('aria-label', 'Connection types');
  let activeTabLink: HTMLElement | null = null;
  for (const tab of CONNECTIONS_TABS) {
    const link = doc.createElement('a');
    link.className =
      'connections-route-tab'
      + (tab.id === activeTab ? ' connections-route-tab--active' : '');
    link.setAttribute('href', connectionsLaneAddress(tab.id).hash);
    link.textContent = tab.label;
    // Native keyboard focus can leave a trailing tab only partly visible.
    link.addEventListener('focus', () => {
      link.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    });
    link.addEventListener('click', (event) => {
      const click = event as MouseEvent;
      if (
        (typeof click.button === 'number' && click.button !== 0)
        || click.metaKey
        || click.ctrlKey
        || click.altKey
        || click.shiftKey
      ) return;
      pendingTabFocusByDocument.set(doc, tab.id);
    });
    if (tab.id === activeTab) {
      link.setAttribute('aria-current', 'page');
      activeTabLink = link;
    }
    tabBar.appendChild(link);
  }
  routeRoot.appendChild(tabBar);
  const sourceSpheres = opts.sourceSpheres ? mountSourceSpheresPanel(routeRoot, opts.sourceSpheres) : undefined;

  // Lane panels replace their own host. Keep the shared worklist above it so
  // an account refresh cannot remove the repair entry point.
  const worklistHost = (opts.reconnectWorklistCaller || opts.authenticationRepairsCaller)
    && opts.initialIncidentHistory === undefined && opts.initialAccessVerification === undefined && opts.initialAccessResult === undefined && opts.initialAccessCheck === undefined
    && !opts.initialPermissionRepair && !opts.permissionRepairUnavailable ? doc.createElement('div') : null;
  if (worklistHost) routeRoot.appendChild(worklistHost);
  if (opts.initialRenewalReturn) {
    const note = doc.createElement('aside'); note.className = 'connections-setup-return';
    const copy = doc.createElement('p'); copy.textContent = 'After repairing this sign-in, review and run new token-renewal checks. Opening a review does not start a check.';
    const back = doc.createElement('a'); back.textContent = 'Review token renewal after repair'; back.href = connectionsOAuthAppAddress(opts.initialRenewalReturn).hash;
    back.setAttribute('href', back.href); back.setAttribute('data-renewal-repair-return', ''); note.appendChild(copy); note.appendChild(back); routeRoot.appendChild(note);
  }
  const accessRepairReturn = isConnectionAccessResultReference(opts.initialAccessRepairReturn) ? opts.initialAccessRepairReturn : undefined;
  if (accessRepairReturn) {
    const note = doc.createElement('aside'); note.className = 'connections-setup-return';
    const copy = doc.createElement('p'); copy.textContent = 'After repairing this sign-in, return to its saved access result. Review current access before choosing Run checks. The earlier result stays historical.';
    const back = doc.createElement('a'); back.textContent = 'Return to saved access check'; back.href = connectionsAccessResultAddress(accessRepairReturn).hash;
    back.setAttribute('href', back.href); back.setAttribute('data-access-repair-return', ''); note.appendChild(copy); note.appendChild(back); routeRoot.appendChild(note);
  }
  const content = doc.createElement('div');
  content.setAttribute(CONNECTIONS_ROUTE_CONTENT_ATTR, '');
  routeRoot.appendChild(content);

  let accountsPanel: AccountsLanePanelMount | null = null;
  let connectionsEnroll: ConnectionsEnrollPanelMount | null = null;
  let brokerPanel: ReturnType<typeof createManagedOAuthPanel> | null = null;
  let oauthAppsPanel: ReturnType<typeof createOAuthAppsPanel> | null = null;
  let oauthAppsHost: HTMLElement | null = null;
  let reconnectWorklist: ReturnType<typeof createReconnectWorklistPanel> | null = null;
  let incidentHistory: ReturnType<typeof createAuthenticationIncidentPanel> | null = null;
  let accessVerification: ReturnType<typeof createAuthenticationAccessPanel> | null = null;
  let migrationPanel: ReturnType<typeof createManagedOAuthMigrationPanel> | null = null;
  let replacementPanel: ReturnType<typeof mountConnectionReplacementPanel> | null = null;
  let connectionsGrant: ConnectionsGrantPanelMount | null = null;
  let webhooksPanel: WebhooksPanelMount | null = null;
  const authenticationSettings = doc.createElement('details');
  authenticationSettings.className = 'connections-authentication-settings';
  authenticationSettings.open = opts.initialManageOAuthApps === true || !!opts.initialOAuthAppReview;
  const settingsSummary = doc.createElement('summary'); settingsSummary.textContent = 'Authentication settings';
  authenticationSettings.appendChild(settingsSummary);

  if (worklistHost) {
    reconnectWorklist = createReconnectWorklistPanel({ document: doc,
      ...(opts.reconnectWorklistCaller ? { call: opts.reconnectWorklistCaller } : {}),
      ...(opts.authenticationRepairsCaller ? { repairs: opts.authenticationRepairsCaller } : {}),
      ...(opts.connectionsManagedOAuthCaller ? { verify: opts.connectionsManagedOAuthCaller } : {}),
      ...(opts.onWorklistReconnect ? { onReconnect: opts.onWorklistReconnect } : {}),
      ...(opts.initialWorklistReturn ? { returned: opts.initialWorklistReturn } : {}),
    });
    reconnectWorklist.mount(worklistHost);
  }
  const worklistUnsubs = opts.subscribe && reconnectWorklist ? [
    opts.subscribe('pack_installed', () => { void reconnectWorklist?.refresh(); }),
    opts.subscribe('pack_uninstalled', () => { void reconnectWorklist?.refresh(); }),
  ] : [];

  const navigate = (hash: string): void => {
    if (opts.navigate !== undefined) {
      opts.navigate(hash);
      return;
    }
    const location = doc.defaultView?.location;
    if (location !== undefined) location.hash = hash;
  };

  const savedCheck = (reference: ConnectionAccessCheckReference): void => navigate(connectionsAccessCheckAddress(reference).hash);
  if (opts.initialAccessCheck !== undefined) {
    const back = doc.createElement('a'); back.textContent = 'Back to connection history'; back.href = '#connections/others/incident-history';
    back.setAttribute('href', back.href); content.appendChild(back);
    if (!isConnectionAccessCheckReference(opts.initialAccessCheck)) appendUnavailable(doc, content, 'This saved-check link is invalid. Open connection history or Authentication repairs for a fresh review.');
    else if (!opts.connectionsManagedOAuthCaller) appendUnavailable(doc, content, 'Saved access results are unavailable. Reconnect or update the server, then try again.');
    else {
      const host = doc.createElement('div'); content.appendChild(host);
      accessVerification = createAuthenticationAccessPanel({ document: doc, call: opts.connectionsManagedOAuthCaller, savedCheck });
      accessVerification.mount(host); void accessVerification.openCheck(opts.initialAccessCheck, () => navigate('#connections/others/incident-history'));
    }
  } else if (opts.initialAccessResult !== undefined) {
    const back = doc.createElement('a'); back.textContent = 'Back to connection history'; back.href = '#connections/others/incident-history';
    back.setAttribute('href', back.href); content.appendChild(back);
    if (!isConnectionAccessResultReference(opts.initialAccessResult)) appendUnavailable(doc, content, 'This saved-result link is invalid. Open connection history or Authentication repairs for a fresh review.');
    else if (!opts.connectionsManagedOAuthCaller) appendUnavailable(doc, content, 'Saved access results are unavailable. Reconnect or update the server, then try again.');
    else {
      const host = doc.createElement('div'); content.appendChild(host);
      accessVerification = createAuthenticationAccessPanel({ document: doc, call: opts.connectionsManagedOAuthCaller, savedCheck });
      accessVerification.mount(host); void accessVerification.openResult(opts.initialAccessResult, () => navigate('#connections/others/incident-history'));
    }
  } else if (opts.initialAccessVerification !== undefined) {
    const back = doc.createElement('a'); back.textContent = 'Back to connection history'; back.href = '#connections/others/incident-history';
    back.setAttribute('href', back.href); content.appendChild(back);
    if (opts.initialAccessVerification === null) appendUnavailable(doc, content, 'This access-check link is invalid. Open connection history and choose Verify access.');
    else if (!opts.connectionsManagedOAuthCaller) appendUnavailable(doc, content, 'Access checks are unavailable. Reconnect or update the server, then try again.');
    else {
      const host = doc.createElement('div'); content.appendChild(host);
      accessVerification = createAuthenticationAccessPanel({ document: doc, call: opts.connectionsManagedOAuthCaller, savedCheck });
      accessVerification.mount(host); accessVerification.open(opts.initialAccessVerification, undefined, () => navigate('#connections/others/incident-history'));
    }
  } else if (opts.initialIncidentHistory !== undefined) {
    if (opts.initialIncidentHistory === null || opts.initialIncidentHistoryFilters !== undefined && !isAuthenticationIncidentHistoryFilters(opts.initialIncidentHistoryFilters)) appendUnavailable(doc, content, 'This incident history link is invalid. Open Authentication repairs and choose Incident history.');
    else {
      incidentHistory = createAuthenticationIncidentPanel({ document: doc, scope: opts.initialIncidentHistory,
        ...(opts.initialIncidentHistoryFilters ? { filters: opts.initialIncidentHistoryFilters } : {}),
        navigate, ...(opts.oauthAppsCaller ? { renewal: opts.oauthAppsCaller } : {}),
        ...(opts.connectionsManagedOAuthCaller ? { verify: opts.connectionsManagedOAuthCaller } : {}),
        ...(opts.authenticationHistoryExportCaller ? { exportHistory: opts.authenticationHistoryExportCaller } : {}),
        ...(opts.authenticationIncidentHistoryCaller ? { call: opts.authenticationIncidentHistoryCaller } : {}) });
      incidentHistory.mount(content);
    }
  } else if (isFoundationalLane(activeTab)) {
    accountsPanel = mountAccountsLanePanel({
      host: content,
      document: doc,
      initialLane: activeTab,
      oauthReturnHref: connectionsLaneAddress(activeTab).hash,
      onNavigate: (lane, detailSlug) => {
        connectionsHistory.navigate(
          detailSlug === null
            ? connectionsLaneAddress(lane)
            : connectionsAccountAddress(lane, detailSlug),
        );
      },
      onGoToChat: (source) => navigate(serializeChatConnectedSource(source)),
      onFirstMailboxConnected: () => navigate('#yours/proposals'),
      onOpenLane: (lane) => navigate(connectionsLaneAddress(lane).hash),
      ...(initialDetailSlug !== undefined
        ? { initialDetailSlug }
        : {}),
      ...(opts.initialAccountAuthentication?.platform === activeTab && opts.initialAccountAuthentication.slug === initialDetailSlug
        ? { initialManageAuthentication: opts.initialAccountAuthentication.slug } : {}),
      ...(opts.mail !== undefined ? { mail: opts.mail } : {}),
      ...(opts.calendar !== undefined ? { calendar: opts.calendar } : {}),
      ...(opts.file !== undefined ? { file: opts.file } : {}),
      ...(opts.connectionsEnrollListCaller !== undefined
        ? { listManagedConnections: opts.connectionsEnrollListCaller } : {}),
      onOpenManagedConnections: (name) => {
        const destination = name ? '#connections/others/review-access/api/' + encodeURIComponent(name) : '#connections/others';
        navigate(accessRepairReturn ? connectionsAccessRepairReturn(destination, accessRepairReturn) : destination);
      },
      ...(opts.connectionsManagedOAuthCaller ? { runCollectionAuthentication: opts.connectionsManagedOAuthCaller } : {}),
      ...(opts.listCloudFiles ? { listCloudFiles: opts.listCloudFiles } : {}),
      ...(opts.accountSetupContinuity ? { setupContinuity: opts.accountSetupContinuity,
        onSetupHandoff: (destination: 'apps' | 'connection') => {
          const draft = opts.accountSetupContinuity?.read();
          navigate(destination === 'apps' ? connectionsOAuthAppsAddress().hash : connectionsEnrollAddress(draft ? accountSetupEnrollment(draft).vendor : undefined).hash);
        } } : {}),
      onManageSavedApps: () => navigate(accessRepairReturn ? connectionsAccessRepairReturn(connectionsOAuthAppsAddress().hash, accessRepairReturn) : connectionsOAuthAppsAddress().hash),
      onAuthenticationChanged: () => { void reconnectWorklist?.refresh(); },
      ...(opts.getOAuthClientConfig !== undefined
        ? { getOAuthClientConfig: opts.getOAuthClientConfig }
        : {}),
      ...(opts.getOAuthAppConfig !== undefined
        ? { getOAuthAppConfig: opts.getOAuthAppConfig }
        : {}),
      ...(opts.setOAuthAppConfig !== undefined
        ? { setOAuthAppConfig: opts.setOAuthAppConfig }
        : {}),
      ...(opts.foundationalOAuthContinuity !== undefined
        ? { oauthContinuity: opts.foundationalOAuthContinuity }
        : {}),
      ...(opts.accountsOAuthEnv !== undefined
        ? { oauthEnv: opts.accountsOAuthEnv }
        : {}),
      ...(opts.now !== undefined ? { now: opts.now } : {}),
    });
  } else if (activeTab === 'webhooks') {
    const canMountWebhooks = opts.webhooksListCaller !== undefined
      && opts.webhooksCreateCaller !== undefined
      && opts.webhooksCredentialWriteCaller !== undefined
      && opts.webhooksCredentialRetireCaller !== undefined
      && opts.webhooksManualConfirmCaller !== undefined
      && opts.webhooksEnableCaller !== undefined
      && opts.webhooksDisableCaller !== undefined;
    if (canMountWebhooks) {
      webhooksPanel = mountWebhooksPanel({
        host: content,
        document: doc,
        runList: opts.webhooksListCaller!,
        runCreate: opts.webhooksCreateCaller!,
        runCredentialWrite: opts.webhooksCredentialWriteCaller!,
        runCredentialRetire: opts.webhooksCredentialRetireCaller!,
        runManualConfirm: opts.webhooksManualConfirmCaller!,
        ...(opts.webhooksRegistrationReconcileCaller !== undefined
          ? { runRegistrationReconcile: opts.webhooksRegistrationReconcileCaller }
          : {}),
        runEnable: opts.webhooksEnableCaller!,
        runDisable: opts.webhooksDisableCaller!,
        ...(opts.webhooksTestDeliveryCaller !== undefined
          ? { runTestDelivery: opts.webhooksTestDeliveryCaller }
          : {}),
        ...(opts.webhooksDeliveryListCaller !== undefined
          ? { runDeliveryList: opts.webhooksDeliveryListCaller }
          : {}),
        ...(opts.webhooksDeliveryGetCaller !== undefined
          ? { runDeliveryGet: opts.webhooksDeliveryGetCaller }
          : {}),
        ...(opts.webhooksDeliveryEventGetCaller !== undefined
          ? { runDeliveryEventGet: opts.webhooksDeliveryEventGetCaller }
          : {}),
        ...(opts.webhooksRejectedDeliveryListCaller !== undefined
          ? { runRejectedDeliveryList: opts.webhooksRejectedDeliveryListCaller }
          : {}),
        ...(opts.webhooksRetireCaller !== undefined
          ? { runRetire: opts.webhooksRetireCaller }
          : {}),
        ...(opts.webhooksRetentionPruneCaller !== undefined
          ? { runRetentionPrune: opts.webhooksRetentionPruneCaller }
          : {}),
      });
    } else {
      appendUnavailable(
        doc,
        content,
        'This server cannot set up webhooks coming in yet.',
      );
    }
  } else {
    const setup = opts.accountSetupContinuity?.read();
    if (setup) {
      const resume = doc.createElement('aside'); resume.className = 'connections-setup-return';
      const copy = doc.createElement('p'); copy.textContent = `Your ${setup.lane === 'mail' ? 'mailbox' : 'calendar'} setup is waiting. Its name and choices are kept in this tab; credentials are not.`;
      const back = doc.createElement('button'); back.type = 'button'; back.className = 'rx-btn rx-btn-outline rx-btn-sm';
      back.textContent = 'Return to ' + (setup.lane === 'mail' ? 'mailbox' : 'calendar') + ' setup';
      back.setAttribute('data-account-setup-return', ''); back.addEventListener('click', () => navigate(connectionsLaneAddress(setup.lane).hash));
      resume.appendChild(copy); resume.appendChild(back); content.appendChild(resume);
    }
    if (opts.oauthAppsCaller && !opts.initialPermissionRepair && !opts.permissionRepairUnavailable) {
      oauthAppsHost = doc.createElement('div'); authenticationSettings.appendChild(oauthAppsHost);
      oauthAppsPanel = createOAuthAppsPanel({ host: oauthAppsHost, call: opts.oauthAppsCaller,
        navigate,
        changed: () => { void connectionsEnroll?.refresh(); } });
    }
    if (opts.connectionsManagedOAuthCaller !== undefined) {
      const section = doc.createElement('section');
      section.className = 'connections-broker-manager';
      const intro = doc.createElement('div');
      intro.className = 'connections-broker-manager-intro';
      const title = doc.createElement('h2'); title.textContent = 'Managed sign-in';
      const description = doc.createElement('p'); description.textContent = 'Save a Nango broker for your app connections.';
      intro.appendChild(title); intro.appendChild(description);
      const button = doc.createElement('button');
      button.type = 'button'; button.textContent = 'Manage OAuth brokers';
      button.className = 'rx-btn rx-btn-outline rx-btn-sm';
      button.setAttribute(CONNECTIONS_MANAGE_BROKERS_ATTR, '');
      button.setAttribute('aria-expanded', 'false');
      const editor = doc.createElement('div'); editor.hidden = true;
      editor.id = 'connections-oauth-brokers';
      button.setAttribute('aria-controls', editor.id);
      const context: ManagedOAuthPanelContext = { enabled: false, mode: 'create', name: '', base_url: '',
        scopes: [], profile_id: '', integration_id: '' };
      brokerPanel = createManagedOAuthPanel({ call: opts.connectionsManagedOAuthCaller, manageProfiles: true,
        context: () => context, select: (profile, integration) => { context.profile_id = profile; context.integration_id = integration; },
        authorized: () => {}, invalidate: () => {},
        openConnection: async (name, expectedUpdatedAt) => {
          if (!connectionsEnroll || connectionsEnroll.hasInFlightWork()) throw new Error('Finish the current connection action before opening another connection.');
          const opened = await connectionsEnroll.openConnection('api', name, expectedUpdatedAt);
          if (opened) {
            const enrollHost = content.querySelector<HTMLElement>(`[${CONNECTIONS_ROUTE_ENROLL_HOST_ATTR}]`);
            enrollHost?.querySelector<HTMLElement>('[data-conn-field]:not(:disabled)')?.focus?.();
          }
          return opened;
        },
        ...(opts.connectionsProbeCaller ? { checkConnection: async (name: string, expectedUpdatedAt: number) => {
          if (connectionsEnroll?.hasInFlightWork()) throw new Error('Finish the current connection action before checking API access.');
          await opts.connectionsProbeCaller!({ kind: 'api', name, expected_updated_at: expectedUpdatedAt });
          await connectionsEnroll?.refresh();
        } } : {}),
        changed: () => {
          const busy = brokerPanel?.busy() ?? false;
          button.setAttribute('aria-busy', String(busy));
          if (busy) button.setAttribute('aria-disabled', 'true'); else button.removeAttribute('aria-disabled');
          brokerPanel?.mount(editor);
          if (!busy && context.enabled && doc.activeElement === button) {
            editor.querySelector<HTMLElement>('[data-managed-field="profile"], [data-managed-action="add"]')?.focus?.();
          }
        } });
      button.addEventListener('click', () => {
        if (brokerPanel?.busy() || migrationPanel?.busy()) return;
        if (context.enabled && brokerPanel?.hasDraft()) {
          const confirm = doc.defaultView?.confirm?.bind(doc.defaultView);
          if (confirm && !confirm('Discard this OAuth broker setup? Credential fields are not saved in your browser. Select Cancel to keep editing.')) return;
        }
        // Safari does not focus buttons on a mouse click. Keep a stable focus
        // owner while the broker list loads, then move into its first control.
        button.focus?.({ preventScroll: true });
        context.enabled = !context.enabled; editor.hidden = !context.enabled;
        button.textContent = context.enabled ? 'Close brokers' : 'Manage OAuth brokers';
        button.setAttribute('aria-expanded', String(context.enabled)); brokerPanel?.mount(context.enabled ? editor : null);
        if (!context.enabled) editor.innerHTML = '';
        if (context.enabled) editor.querySelector<HTMLElement>('[data-managed-field="profile"], [data-managed-action="add"]')?.focus?.();
      });
      section.appendChild(intro);
      section.appendChild(button); section.appendChild(editor); authenticationSettings.appendChild(section);
      const migrate = doc.createElement('button'); migrate.type = 'button'; migrate.className = 'rx-btn rx-btn-outline rx-btn-sm';
      migrate.textContent = 'Bulk authentication migration'; migrate.setAttribute('data-recued-bulk-authentication', '');
      const migrationHost = doc.createElement('div'); migrationHost.hidden = true;
      migrate.setAttribute('aria-expanded', 'false'); migrationHost.id = 'connections-bulk-authentication';
      migrate.setAttribute('aria-controls', migrationHost.id);
      const migrationNotice = doc.createElement('p'); migrationNotice.setAttribute('role', 'status'); migrationNotice.hidden = true;
      migrate.addEventListener('click', () => {
        if (migrationPanel) return;
        if (brokerPanel?.busy() || connectionsEnroll?.hasInFlightWork() || connectionsEnroll?.hasUnsavedChanges()) {
          migrationNotice.textContent = 'Finish or cancel the current connection action before starting a bulk migration.';
          migrationNotice.hidden = false; return;
        }
        migrationNotice.hidden = true;
        migrationHost.hidden = false; migrate.setAttribute('aria-expanded', 'true'); migrate.disabled = true;
        migrationPanel = createManagedOAuthMigrationPanel({ host: migrationHost, call: opts.connectionsManagedOAuthCaller!,
          changed: () => { void connectionsEnroll?.refresh(); },
          closed: () => { migrationPanel?.dispose(); migrationPanel = null; migrationHost.hidden = true; migrationHost.innerHTML = '';
            migrate.disabled = false; migrate.setAttribute('aria-expanded', 'false'); migrate.focus?.(); void connectionsEnroll?.refresh(); } });
        void migrationPanel.load();
      });
      section.appendChild(migrate); section.appendChild(migrationNotice); section.appendChild(migrationHost);
    }
    if (opts.connectionReplacementCaller) replacementPanel = mountConnectionReplacementPanel({ host: content, caller: opts.connectionReplacementCaller,
      busyOther: () => (connectionsEnroll?.hasInFlightWork() ?? false) || (connectionsEnroll?.hasUnsavedChanges() ?? false) || (migrationPanel?.busy() ?? false) || (brokerPanel?.busy() ?? false),
      changed: () => { void connectionsEnroll?.refresh(); } });
    const canMountEnroll =
      opts.connectionsEnrollListCaller !== undefined
      && opts.connectionsEnrollCaller !== undefined
      && opts.connectionsUpdateCaller !== undefined
      && opts.connectionsDeleteCaller !== undefined
      && opts.connectionsProbeCaller !== undefined;
    if (canMountEnroll) {
      // The enroll panel owns its host's `innerHTML` and replaces it after every
      // async read or editor update. Keep that ownership below the route
      // content node so its delayed initial render cannot delete sibling
      // surfaces such as Operation grants.
      const enrollHost = doc.createElement('div');
      enrollHost.setAttribute(CONNECTIONS_ROUTE_ENROLL_HOST_ATTR, '');
      content.appendChild(enrollHost);
      connectionsEnroll = mountConnectionsEnrollPanel({
        host: enrollHost,
        document: doc,
        runList: opts.connectionsEnrollListCaller as ConnectionsEnrollListCaller,
        runEnroll: opts.connectionsEnrollCaller as ConnectionsEnrollCaller,
        runUpdate: opts.connectionsUpdateCaller as ConnectionsUpdateCaller,
        ...(opts.connectionsRotateCredentialsCaller !== undefined
          ? { runRotateCredentials: opts.connectionsRotateCredentialsCaller }
          : {}),
        ...(opts.connectionsCredentialRotationStatusCaller !== undefined
          ? {
              runCredentialRotationStatus:
                opts.connectionsCredentialRotationStatusCaller,
            }
          : {}),
        ...(opts.connectionsCredentialRotationActivityCaller !== undefined
          ? {
              runCredentialRotationActivity:
                opts.connectionsCredentialRotationActivityCaller,
            }
          : {}),
        ...(opts.connectionsAcknowledgeCredentialRotationSafeStopCaller
          !== undefined
          ? {
              runAcknowledgeCredentialRotationSafeStop:
                opts.connectionsAcknowledgeCredentialRotationSafeStopCaller,
            }
          : {}),
        ...(opts.connectionsCredentialRotationServerUpdateTriageCaller
          !== undefined
          ? {
              runCredentialRotationServerUpdateTriage:
                opts.connectionsCredentialRotationServerUpdateTriageCaller,
            }
          : {}),
        ...(opts.credentialRotationContinuity !== undefined
          ? { credentialRotationContinuity: opts.credentialRotationContinuity }
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
        ...(opts.onReconnect !== undefined
          ? { onReconnect: opts.onReconnect }
          : {}),
        ...(opts.onOpenCredentialRotationServerUpdateGuide !== undefined
          ? {
              onOpenCredentialRotationServerUpdateGuide:
                opts.onOpenCredentialRotationServerUpdateGuide,
            }
          : {}),
        runDelete: opts.connectionsDeleteCaller as ConnectionsDeleteCaller,
        runProbe: opts.connectionsProbeCaller as ConnectionsProbeCaller,
        // D-225 Slice 2 — absent → the review is not offered at all, which
        // beats rendering a button that fails.
        ...(opts.connectionsMcpPackPreviewCaller !== undefined
          ? { runMcpPackPreview: opts.connectionsMcpPackPreviewCaller }
          : {}),
        ...(opts.connectionsMcpPackCommitCaller !== undefined
          ? { runMcpPackCommit: opts.connectionsMcpPackCommitCaller }
          : {}),
        ...(opts.connectionsPreviewPurgeCaller !== undefined
          ? { runPreviewPurge: opts.connectionsPreviewPurgeCaller }
          : {}),
        ...(opts.connectionsRemovalEffectsCaller !== undefined
          ? { runRemovalEffects: opts.connectionsRemovalEffectsCaller }
          : {}),
        ...(opts.signInGridCallers !== undefined
          ? { signInGridCallers: opts.signInGridCallers }
          : {}),
        ...(opts.connectionsGetMatchPatternsCaller !== undefined
          ? { runGetMatchPatterns: opts.connectionsGetMatchPatternsCaller }
          : {}),
        ...(opts.connectionsSetMatchPatternsCaller !== undefined
          ? { runSetMatchPatterns: opts.connectionsSetMatchPatternsCaller }
          : {}),
        ...(opts.connectionsEngagementHealthCaller !== undefined
          ? { runEngagementHealth: opts.connectionsEngagementHealthCaller }
          : {}),
        ...(opts.connectionsReprobeEngagementCapabilitiesCaller !== undefined
          ? {
              runReprobeEngagementCapabilities:
                opts.connectionsReprobeEngagementCapabilitiesCaller,
            }
          : {}),
        runMailList: opts.connectionsMailListCaller,
        ...(opts.getOAuthAppConfig ? { runGetOAuthAppConfig: opts.getOAuthAppConfig } : {}),
        ...(oauthAppsPanel ? { onManageOAuthApps: () => { authenticationSettings.open = true; oauthAppsPanel?.open(); oauthAppsHost?.scrollIntoView?.({ block: 'start', behavior: 'smooth' }); } } : {}),
        ...(opts.connectionsSuggestSetupCaller !== undefined
          ? { runSuggestSetup: opts.connectionsSuggestSetupCaller }
          : {}),
        ...(opts.providerSetupContinuity !== undefined
          ? { providerSetupContinuity: opts.providerSetupContinuity }
          : {}),
        ...(opts.connectionsCompleteVendorOAuthCaller !== undefined
          ? { runCompleteVendorOAuth: opts.connectionsCompleteVendorOAuthCaller }
          : {}),
        ...(opts.connectionsStartVendorOAuthCaller !== undefined
          ? { runStartVendorOAuth: opts.connectionsStartVendorOAuthCaller }
          : {}),
        ...(opts.connectionsManagedOAuthCaller !== undefined ? { runManagedOAuth: opts.connectionsManagedOAuthCaller } : {}),
        ...(opts.connectionsTakeVendorOAuthResultCaller !== undefined
          ? { runTakeVendorOAuthResult: opts.connectionsTakeVendorOAuthResultCaller }
          : {}),
        ...(opts.subscribe !== undefined ? { subscribe: opts.subscribe } : {}),
        ...(opts.connectionsPacksListCaller !== undefined
          ? { runPacksList: opts.connectionsPacksListCaller }
          : {}),
        ...(initialEnrollVendor !== undefined
          ? { initialVendor: initialEnrollVendor }
          : {}),
        ...(setup?.destination === 'connection' ? { initialAccountSetup: accountSetupEnrollment(setup) } : {}),
        ...(opts.initialAddress?.kind === 'enroll' && opts.initialAddress.pack !== undefined
          ? { initialPack: opts.initialAddress.pack } : {}),
        ...(opts.initialConnectionAccessReview ? { initialConnectionAccessReview: opts.initialConnectionAccessReview } : {}),
        ...(opts.initialFileAuthenticationSwitch ? { initialFileAuthenticationSwitch: opts.initialFileAuthenticationSwitch } : {}),
        ...(opts.initialPermissionRepair ? { initialPermissionRepair: opts.initialPermissionRepair } : {}),
        ...(opts.permissionRepairUnavailable ? { permissionRepairUnavailable: true } : {}),
        ...(opts.permissionRepairPreviewCaller ? { runPermissionRepairPreview: opts.permissionRepairPreviewCaller } : {}),
        ...(opts.reconnectWorklistCaller ? { runPermissionRepairWorklist: opts.reconnectWorklistCaller } : {}),
        ...(opts.onPermissionRepairReturn ? { onPermissionRepairReturn: opts.onPermissionRepairReturn } : {}),
        ...(opts.initialCredentialRotationServerUpdateRetry !== undefined
          ? {
              initialCredentialRotationServerUpdateRetry:
                opts.initialCredentialRotationServerUpdateRetry,
            }
          : {}),
        ...(opts.initialPostSafeStopRecovery !== undefined
          ? {
              initialPostSafeStopRecovery:
                opts.initialPostSafeStopRecovery,
            }
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
        ...(opts.initialCredentialRotationServerUpdateCompletion !== undefined
          ? {
              initialCredentialRotationServerUpdateCompletion:
                opts.initialCredentialRotationServerUpdateCompletion,
            }
          : {}),
        ...(opts.onCredentialRotationServerUpdateRetrySettled !== undefined
          ? {
              onCredentialRotationServerUpdateRetrySettled:
                opts.onCredentialRotationServerUpdateRetrySettled,
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
        ...(opts.onCredentialRotationServerUpdateRetryInterrupted !== undefined
          ? {
              onCredentialRotationServerUpdateRetryInterrupted:
                opts.onCredentialRotationServerUpdateRetryInterrupted,
            }
          : {}),
      });
    } else {
      appendUnavailable(
        doc,
        content,
        'This server cannot add Connections yet.',
      );
    }

    // ── Operation grants ──────────────────────────────────────────────
    // D-165 follow-on, RESTORED. R13 deleted this panel as collateral of the
    // lane restructure and left its rpc family
    // (`collection.connection.{grant,revoke,list}OperationGroup`) registered and
    // handled server-side with NO consumer — re-creating the exact state the
    // panel's own header described: "Before this panel there was no surface to
    // do that."
    //
    // 🔑 Why it belongs HERE and not on the enrol form. Enrolment stores a
    // credential; granting authorises operations. They are different decisions
    // about different things, and the second one is per-operation-GROUP, so it
    // cannot be a field on the form that creates the connection — it needs the
    // connection to exist first (the panel lists connections, then fans out
    // `listOperationGroups` per connection). Same lane, below the form.
    //
    // ⚠ Without it a hand-enrolled connection is stuck: write ops are never
    // auto-granted (Invariant 3 — the enrolment boot seed admits read-tier ops
    // only), so every write returns `operation_not_granted` and the ONLY other
    // grant writer is a pack install. Settings → Permissions cannot help: its
    // overrides may only TIGHTEN.
    //
    // ⛔⛔ NOT MOUNTED (owner decision, 2026-08-07). The caveat above described the
    // world in which this layer GATED; it no longer does
    // (`OPERATION_GROUP_GATE_ENABLED = false`), so a hand-enrolled connection is not
    // stuck and the panel's reason to exist is gone. It was ALSO actively misleading:
    // its rows named one pack (`excel.table.write`) but any sibling pack's install
    // flipped them, and its `granted` flag read user-manual grants only while
    // enforcement unioned user AND pack-owned — so a row offering "Grant" could
    // already be permitted. Authority now sits with the contract layer (doors) and the
    // per-run approval gate (owner).
    //
    // 🔑 The rpc family stays REGISTERED AND HANDLED on purpose. Un-mounting a consumer
    // is reversible; deleting a server-side surface is not, and R13 already made the
    // opposite mistake once — it removed this panel and left the rpcs orphaned, which
    // is how the gap this comment used to describe was created. The gate constant is
    // the one place to flip if the layer is ever re-enabled.
    const canMountConnectionsGrant = false;
    if (canMountConnectionsGrant) {
      const grantsSection = doc.createElement('section');
      grantsSection.className = 'connections-route-section';
      grantsSection.setAttribute(CONNECTIONS_ROUTE_GRANTS_SECTION_ATTR, '');
      const grantsHeading = doc.createElement('h2');
      grantsHeading.className = 'connections-route-section-title';
      grantsHeading.textContent = 'What each may do';
      grantsSection.appendChild(grantsHeading);
      const grantsHost = doc.createElement('div');
      grantsSection.appendChild(grantsHost);
      content.appendChild(grantsSection);
      connectionsGrant = mountConnectionsGrantPanel({
        host: grantsHost,
        document: doc,
        runListConnections: opts.connectionsListCaller as ConnectionsListCaller,
        runListGroups:
          opts.connectionsListGroupsCaller as ConnectionsListGroupsCaller,
        runGrant: opts.connectionsGrantGroupCaller as ConnectionsGrantGroupCaller,
        runRevoke:
          opts.connectionsRevokeGroupCaller as ConnectionsRevokeGroupCaller,
      });
    }
    if (oauthAppsPanel || brokerPanel) content.appendChild(authenticationSettings);
  }

  opts.root.appendChild(routeRoot);
  const pendingTabFocus = pendingTabFocusByDocument.get(doc);
  if (pendingTabFocus !== undefined) {
    pendingTabFocusByDocument.delete(doc);
    if (pendingTabFocus === activeTab) {
      const focus = activeTabLink as (HTMLElement & {
        focus?: (options?: FocusOptions) => void;
      }) | null;
      focus?.focus?.({ preventScroll: true });
    }
  }
  // The compact mobile tab strip scrolls horizontally. A direct deep link to
  // a trailing lane (especially Webhooks) otherwise mounts with its active tab
  // clipped outside the viewport, leaving the visible Mail tab looking like
  // the current context. Reveal without moving focus or forcing page scroll.
  activeTabLink?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  if (opts.initialManageOAuthApps || opts.initialOAuthAppReview) oauthAppsPanel?.open(opts.initialOAuthAppReview);

  let disposed = false;
  const hasInFlightWork = (): boolean =>
    (sourceSpheres?.busy() ?? false) ||
    (accountsPanel?.hasInFlightWork() ?? false)
    || (brokerPanel?.busy() ?? false)
    || (oauthAppsPanel?.busy() ?? false)
    || (replacementPanel?.busy() ?? false)
    || (migrationPanel?.busy() ?? false)
    || (reconnectWorklist?.busy() ?? false)
    || (accessVerification?.hasInFlightWork() ?? false)
    || (incidentHistory?.hasInFlightWork() ?? false)
    || (connectionsEnroll?.hasInFlightWork() ?? false)
    || (connectionsGrant?.hasInFlightWork() ?? false)
    || (webhooksPanel?.hasInFlightWork() ?? false);

  return {
    activeTab: () => activeTab,
    accountsPanel: () => accountsPanel,
    connectionsEnrollPanel: () => connectionsEnroll,
    connectionsGrantPanel: () => connectionsGrant,
    setPostSafeStopProfileContext: (context) => {
      connectionsEnroll?.setPostSafeStopProfileContext(context);
    },
    webhooksPanel: () => webhooksPanel,
    whenLoaded: async () => { await Promise.all([
      accessVerification?.whenLoaded() ?? incidentHistory?.whenLoaded() ?? accountsPanel?.whenLoaded() ?? connectionsEnroll?.whenLoaded() ?? webhooksPanel?.whenLoaded(),
      oauthAppsPanel?.whenLoaded(),
    ]); },
    getRecoveryContextFreshness: () => {
      if (accountsPanel !== null) {
        return accountsPanel.getState().error === null
          ? 'current'
          : 'unavailable';
      }
      if (connectionsEnroll !== null) {
        return connectionsEnroll.getState().error === null
          ? 'current'
          : 'unavailable';
      }
      if (webhooksPanel !== null) {
        return webhooksPanel.getLoadError() === null
          ? 'current'
          : 'unavailable';
      }
      return 'unavailable';
    },
    ...(accountsPanel !== null
      || connectionsEnroll !== null
      || webhooksPanel !== null
      ? {
          retryRecoveryContext: async (): Promise<void> => {
            await (
              accountsPanel?.refresh()
              ?? connectionsEnroll?.refresh()
              ?? webhooksPanel?.refresh()
              ?? Promise.resolve()
            );
          },
        }
      : {}),
    hasUnsavedChanges: () =>
      (replacementPanel?.hasDraft() ?? false) || (sourceSpheres?.hasDraft() ?? false) || (accountsPanel?.hasUnsavedChanges() ?? false) || (reconnectWorklist?.hasDraft() ?? false) || (accessVerification?.hasDraft() ?? false) || (incidentHistory?.hasDraft() ?? false) || (oauthAppsPanel?.hasDraft() ?? false) || (brokerPanel?.hasDraft() ?? false) || (migrationPanel?.hasDraft() ?? false) || (connectionsEnroll?.hasUnsavedChanges() ?? false),
    unsavedChangesPrompt: () =>
      replacementPanel?.hasDraft() ? 'Leave this account replacement review? Completed changes and their receipts stay on the server.' : sourceSpheres?.hasDraft() ? 'Discard this source sphere change?' : reconnectWorklist?.hasDraft() === true ? 'Leave this access review? Unstarted checks and resource choices will not be kept. Started jobs remain in connection history.' : accessVerification?.hasDraft() === true || incidentHistory?.hasDraft() === true ? 'Leave this access review? Its selected resources will not be kept.' : oauthAppsPanel?.hasDraft() === true ? 'Discard this OAuth app draft? The secret is held only in this editor.' : brokerPanel?.hasDraft() === true
        ? 'Discard this OAuth broker setup? Credential fields are not saved in your browser and cannot be restored after leaving.'
        : accountsPanel?.hasUnsavedChanges() ? 'Discard this account setup or replacement password? Credentials entered here cannot be restored.' : connectionsEnroll?.unsavedChangesPrompt() ?? null,
    hasInFlightWork,
    inFlightWorkPrompt: () =>
      reconnectWorklist?.inFlightWorkPrompt() ?? (hasInFlightWork()
        ? 'Connections is still doing something. Leave anyway?'
        : null),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      sourceSpheres?.dispose();
      if (accountsPanel !== null) accountsPanel.dispose();
      if (connectionsEnroll !== null) connectionsEnroll.dispose();
      brokerPanel?.dispose();
      oauthAppsPanel?.dispose();
      reconnectWorklist?.dispose();
      incidentHistory?.dispose();
      accessVerification?.dispose();
      for (const unsubscribe of worklistUnsubs) unsubscribe();
      replacementPanel?.dispose();
      migrationPanel?.dispose();
      if (webhooksPanel !== null) webhooksPanel.dispose();
      try {
        opts.root.removeChild(routeRoot);
      } catch {
        routeRoot.remove();
      }
    },
  };
};
