/** Connections — top-level route (treemap §6, review-log R13–R16, D-201).
 *
 *  A `[Mail · Calendar · Files · Others · Webhooks]` surface over the
 *  foundational account lanes, generic outbound connections, and inbound
 *  webhook control plane, backed by three substrates:
 *    - Mail / Calendar / Files = FOUNDATIONAL account lanes bound through
 *      the coded `collection.{mail,calendar,file}.*` adapters
 *      (`accounts-lane-panel.ts` + the pure `renderAccountsPanel`).
 *    - Others = the generic `connection.*` REACH lane (api / mcp /
 *      notification) — the existing enrollment panel, rehosted here.
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
import { CONNECTIONS_PAGE_STYLES, ACCOUNTS_PANEL_STYLES } from '@recued/ui-shared';

import {
  mountAccountsLanePanel,
  type AccountsLanePanelMount,
  type CalendarLaneCallers,
  type FileLaneCallers,
  type MailLaneCallers,
  type OAuthClientConfigResult,
} from './accounts-lane-panel.js';
import {
  mountConnectionsEnrollPanel,
  type ConnectionsDeleteCaller,
  type ConnectionsEngagementHealthCaller,
  type ConnectionsEnrollCaller,
  type ConnectionsEnrollListCaller,
  type ConnectionsEnrollPanelMount,
  type ConnectionsMailListCaller,
  type ConnectionsPreviewPurgeCaller,
  type ConnectionsProbeCaller,
  type ConnectionsReprobeEngagementCapabilitiesCaller,
  type ConnectionsStartVendorOAuthCaller,
  type ConnectionsTakeVendorOAuthResultCaller,
  type ConnectionsUpdateCaller,
  type ConnectionsGetMatchPatternsCaller,
  type ConnectionsSetMatchPatternsCaller,
} from '../settings/connections-enroll-panel.js';
import { serializeShellRoute } from '../shell/route.js';
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

export const CONNECTIONS_ROUTE_STYLES_MARKER =
  'data-recued-connections-route-styles';
export const CONNECTIONS_ROUTE_HOST_ATTR = 'data-recued-connections-route';
export const CONNECTIONS_ROUTE_HEADING_ATTR =
  'data-recued-connections-route-heading';
export const CONNECTIONS_ROUTE_TABS_ATTR =
  'data-recued-connections-route-tabs';
export const CONNECTIONS_ROUTE_CONTENT_ATTR =
  'data-recued-connections-route-content';
export const CONNECTIONS_ROUTE_UNAVAILABLE_ATTR =
  'data-recued-connections-route-unavailable';

/** The five top-level lanes. `'others'` is the
 *  generic `connection.*` REACH lane; the rest are foundational. */
const CONNECTIONS_TABS = [
  { id: 'mail', label: 'Mail' },
  { id: 'calendar', label: 'Calendar' },
  { id: 'file', label: 'Files' },
  { id: 'others', label: 'Others' },
  { id: 'webhooks', label: 'Webhooks' },
] as const;

type ConnectionsTabId = (typeof CONNECTIONS_TABS)[number]['id'];

const isFoundationalLane = (tab: ConnectionsTabId): tab is AccountLaneId =>
  tab === 'mail' || tab === 'calendar' || tab === 'file';

const resolveTab = (raw: string | undefined): ConnectionsTabId =>
  CONNECTIONS_TABS.some((t) => t.id === raw)
    ? (raw as ConnectionsTabId)
    : 'mail';

const CONNECTIONS_ROUTE_CHROME_STYLES = `
[${CONNECTIONS_ROUTE_HOST_ATTR}] {
  max-width: var(--wc-content-max, 1080px);
  margin: 0 auto;
  padding: 16px;
  color: var(--fg);
}
[${CONNECTIONS_ROUTE_HOST_ATTR}] .connections-route-header {
  display: flex;
  align-items: baseline;
  gap: 12px;
  margin-bottom: 14px;
}
[${CONNECTIONS_ROUTE_HOST_ATTR}] .connections-route-title {
  margin: 0;
  font-size: 20px;
  font-weight: 650;
}
[${CONNECTIONS_ROUTE_TABS_ATTR}] {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
  border-bottom: 1px solid var(--border);
  margin-bottom: 16px;
}
[${CONNECTIONS_ROUTE_TABS_ATTR}] .connections-route-tab {
  appearance: none;
  text-decoration: none;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
  padding: 8px 14px;
  font-weight: 600;
  font-size: 14px;
  color: var(--muted);
  cursor: pointer;
}
[${CONNECTIONS_ROUTE_TABS_ATTR}] .connections-route-tab:hover {
  color: var(--fg);
}
[${CONNECTIONS_ROUTE_TABS_ATTR}] .connections-route-tab--active {
  color: var(--fg);
  border-bottom-color: var(--accent);
}
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
  [${CONNECTIONS_ROUTE_HOST_ATTR}] .connections-route-header {
    display: grid;
  }
}
`;

export const CONNECTIONS_ROUTE_STYLES = [
  PRIMITIVE_STYLES,
  CONNECTIONS_PAGE_STYLES,
  ACCOUNTS_PANEL_STYLES,
  WEBHOOKS_PANEL_STYLES,
  CONNECTIONS_ROUTE_CHROME_STYLES,
].join('\n');

export interface BootstrapConnectionsRouteOptions {
  root: HTMLElement;
  document?: Document;
  /** Deep-link segment 0 — the active lane tab (`#connections/<tab>`).
   *  Defaults to `mail`. */
  initialTab?: string;
  /** Deep-link segment 1 — a foundational account to open in detail
   *  (`#connections/<lane>/<slug>`). Opens the detail on mount; the lane
   *  tab is the addressable unit (account-detail nav is local state for
   *  now — R16 full-depth routing is a later track). */
  initialDetailSlug?: string;
  /** Packs "Set up" deep link — `#connections/others/enroll/<vendor>`
   *  (segment 1 = the `enroll` verb, segment 2 = the vendor). Forwarded to
   *  the Others enroll panel as its `initialVendor` so the enroll form opens
   *  pre-selected for that vendor. Ignored on foundational lanes. */
  initialEnrollVendor?: string;
  // ── Others (generic connection.*) enroll callers ──
  connectionsEnrollListCaller?: ConnectionsEnrollListCaller;
  /** Fork 1 B — `packs.list` caller; lights up the editable vendor-scope
   *  pre-fill in the enroll dialog. Optional + soft (absent → server unions). */
  connectionsPacksListCaller?: () => Promise<{ packs: ReadonlyArray<PackListEntry> }>;
  connectionsEnrollCaller?: ConnectionsEnrollCaller;
  connectionsUpdateCaller?: ConnectionsUpdateCaller;
  connectionsDeleteCaller?: ConnectionsDeleteCaller;
  /** D-192 slice 5 — removal-preview "[N] item(s)" count for the delete-confirm
   *  dialog. Optional (absent → the confirm shows no checkbox). */
  connectionsPreviewPurgeCaller?: ConnectionsPreviewPurgeCaller;
  connectionsProbeCaller?: ConnectionsProbeCaller;
  /** D-192 M4c-UI — messenger trigger read + merge-write for the slack/telegram
   *  "Message triggers" editor. */
  connectionsGetMatchPatternsCaller?: ConnectionsGetMatchPatternsCaller;
  connectionsSetMatchPatternsCaller?: ConnectionsSetMatchPatternsCaller;
  connectionsEngagementHealthCaller?: ConnectionsEngagementHealthCaller;
  connectionsReprobeEngagementCapabilitiesCaller?: ConnectionsReprobeEngagementCapabilitiesCaller;
  connectionsMailListCaller?: ConnectionsMailListCaller;
  connectionsStartVendorOAuthCaller?: ConnectionsStartVendorOAuthCaller;
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
}

export interface ConnectionsRoute {
  /** The active tab. */
  activeTab(): ConnectionsTabId;
  /** The foundational account panel (mounted only on the Mail / Calendar
   *  / Files tabs), else null. */
  accountsPanel(): AccountsLanePanelMount | null;
  /** The generic connection.* enroll panel (mounted only on the Others
   *  tab), else null. */
  connectionsEnrollPanel(): ConnectionsEnrollPanelMount | null;
  /** Inbound webhook setup panel (mounted only on the Webhooks tab). */
  webhooksPanel(): WebhooksPanelMount | null;
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

  const activeTab = resolveTab(opts.initialTab);

  const routeRoot = doc.createElement('div');
  routeRoot.setAttribute(CONNECTIONS_ROUTE_HOST_ATTR, '');

  const header = doc.createElement('header');
  header.className = 'connections-route-header';
  const heading = doc.createElement('h1');
  heading.className = 'connections-route-title';
  heading.setAttribute(CONNECTIONS_ROUTE_HEADING_ATTR, '');
  heading.textContent = 'Connections';
  header.appendChild(heading);
  routeRoot.appendChild(header);

  // ── Tab bar (anchors → hash → shell remount) ──
  const tabBar = doc.createElement('nav');
  tabBar.setAttribute(CONNECTIONS_ROUTE_TABS_ATTR, '');
  for (const tab of CONNECTIONS_TABS) {
    const link = doc.createElement('a');
    link.className =
      'connections-route-tab'
      + (tab.id === activeTab ? ' connections-route-tab--active' : '');
    link.setAttribute('href', serializeShellRoute('connections', tab.id));
    link.textContent = tab.label;
    if (tab.id === activeTab) link.setAttribute('aria-current', 'page');
    tabBar.appendChild(link);
  }
  routeRoot.appendChild(tabBar);

  const content = doc.createElement('div');
  content.setAttribute(CONNECTIONS_ROUTE_CONTENT_ATTR, '');
  routeRoot.appendChild(content);

  let accountsPanel: AccountsLanePanelMount | null = null;
  let connectionsEnroll: ConnectionsEnrollPanelMount | null = null;
  let webhooksPanel: WebhooksPanelMount | null = null;

  if (isFoundationalLane(activeTab)) {
    accountsPanel = mountAccountsLanePanel({
      host: content,
      document: doc,
      initialLane: activeTab,
      ...(opts.initialDetailSlug !== undefined
        ? { initialDetailSlug: opts.initialDetailSlug }
        : {}),
      ...(opts.mail !== undefined ? { mail: opts.mail } : {}),
      ...(opts.calendar !== undefined ? { calendar: opts.calendar } : {}),
      ...(opts.file !== undefined ? { file: opts.file } : {}),
      ...(opts.getOAuthClientConfig !== undefined
        ? { getOAuthClientConfig: opts.getOAuthClientConfig }
        : {}),
      ...(opts.getOAuthAppConfig !== undefined
        ? { getOAuthAppConfig: opts.getOAuthAppConfig }
        : {}),
      ...(opts.setOAuthAppConfig !== undefined
        ? { setOAuthAppConfig: opts.setOAuthAppConfig }
        : {}),
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
        'Inbound webhook setup is not available on this server yet.',
      );
    }
  } else {
    const canMountEnroll =
      opts.connectionsEnrollListCaller !== undefined
      && opts.connectionsEnrollCaller !== undefined
      && opts.connectionsUpdateCaller !== undefined
      && opts.connectionsDeleteCaller !== undefined
      && opts.connectionsProbeCaller !== undefined;
    if (canMountEnroll) {
      connectionsEnroll = mountConnectionsEnrollPanel({
        host: content,
        document: doc,
        runList: opts.connectionsEnrollListCaller as ConnectionsEnrollListCaller,
        runEnroll: opts.connectionsEnrollCaller as ConnectionsEnrollCaller,
        runUpdate: opts.connectionsUpdateCaller as ConnectionsUpdateCaller,
        runDelete: opts.connectionsDeleteCaller as ConnectionsDeleteCaller,
        runProbe: opts.connectionsProbeCaller as ConnectionsProbeCaller,
        ...(opts.connectionsPreviewPurgeCaller !== undefined
          ? { runPreviewPurge: opts.connectionsPreviewPurgeCaller }
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
        ...(opts.connectionsStartVendorOAuthCaller !== undefined
          ? { runStartVendorOAuth: opts.connectionsStartVendorOAuthCaller }
          : {}),
        ...(opts.connectionsTakeVendorOAuthResultCaller !== undefined
          ? { runTakeVendorOAuthResult: opts.connectionsTakeVendorOAuthResultCaller }
          : {}),
        ...(opts.subscribe !== undefined ? { subscribe: opts.subscribe } : {}),
        ...(opts.connectionsPacksListCaller !== undefined
          ? { runPacksList: opts.connectionsPacksListCaller }
          : {}),
        ...(opts.initialEnrollVendor !== undefined
          ? { initialVendor: opts.initialEnrollVendor }
          : {}),
      });
    } else {
      appendUnavailable(
        doc,
        content,
        'Adding connections is not available on this server yet.',
      );
    }
  }

  opts.root.appendChild(routeRoot);

  let disposed = false;
  return {
    activeTab: () => activeTab,
    accountsPanel: () => accountsPanel,
    connectionsEnrollPanel: () => connectionsEnroll,
    webhooksPanel: () => webhooksPanel,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (accountsPanel !== null) accountsPanel.dispose();
      if (connectionsEnroll !== null) connectionsEnroll.dispose();
      if (webhooksPanel !== null) webhooksPanel.dispose();
      try {
        opts.root.removeChild(routeRoot);
      } catch {
        routeRoot.remove();
      }
    },
  };
};
