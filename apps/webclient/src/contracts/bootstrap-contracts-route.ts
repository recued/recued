/** Top-level Contracts route: Built-in / Customer / Others inventories, with a
 *  tabbed detail view for one editable contract at a time.
 *
 *  `#contracts/<id>` remains addressable for ordinary contracts,
 *  server-managed reception/webhook contracts, and Seller-owned customer
 *  templates. Customer instances and short-lived gate grants stay in their
 *  owning product surfaces. The hidden `public_anonymous` sentinel remains a
 *  fail-closed runtime floor; the Built-in tab lists the real stored door
 *  contracts whose grants the owner can edit without exposing generic revoke
 *  or door-type controls.
 *
 *  Owner/self remains the Layer-1 boolean-access surface. Ambient staged-trust
 *  and scoped proposals stay dormant when empty and render after the primary
 *  inventory rather than competing with contract discovery.
 */

import {
  AUTHORABLE_DOOR_TYPES,
  OWNER_CONTRACT_ID,
  derivedDoorType,
  isStandingContractDefinition,
  type ContractGrantKind,
  type ContractDefinitionView,
  type ContractListRequest,
  type ContractLifecycleState,
  type DerivedDoorType,
  type DoorType,
  type MintContractRequest,
} from '@recued/contracts';
import { formatClientDateTime } from '@recued/ui-shared';
import { PRIMITIVE_STYLES } from '@recued/ui-shared/primitives';
import { serializeShellRoute } from '../shell/route.js';

import type {
  ContractsListCaller,
  ContractsRevokeCaller,
} from './contracts-panel.js';
import {
  mountSuggestedRulesPanel,
  SUGGESTED_RULES_PANEL_STYLES,
  type SuggestedRulesPanelMount,
  type SuggestionsAcceptCaller,
  type SuggestionsDismissCaller,
  type SuggestionsListCaller,
} from './suggested-rules-panel.js';
import {
  mountScopedGrantPanel,
  type ScopedGrantPanelMount,
  type ScopedSuggestionsAcceptCaller,
  type ScopedSuggestionsDismissCaller,
  type ScopedSuggestionsListCaller,
} from './scoped-grant-panel.js';
import {
  mountContractGrantsPanel,
  CONTRACT_GRANTS_PANEL_STYLES,
  type ContractGrantsPanelMount,
  type GrantReadCaller,
  type GrantReadByEntryCaller,
  type GrantWriteCaller,
  type GrantContractsCaller,
  type GrantCatalogOperationsCaller,
  type GrantRegistryDescribeCaller,
  type GrantSetDoorTypesCaller,
  type GrantCliReachabilityListCaller,
  type GrantCliReachabilitySetCaller,
} from './contract-grants-panel.js';
import {
  mountPermissionsPanel,
  PERMISSIONS_PANEL_STYLES,
  type PermissionsPanelMount,
} from '../settings/permissions-panel.js';
import type {
  PermissionsDeleteOverrideCaller,
  PermissionsIssueInboundTokenCaller,
  PermissionsListCatalogOperationsCaller,
  PermissionsListContractsCaller,
  PermissionsListInboundTokensCaller,
  PermissionsListOverridesCaller,
  PermissionsMintContractCaller,
  PermissionsRevokeContractCaller,
  PermissionsRevokeInboundTokenCaller,
  PermissionsToolCatalogCaller,
  PermissionsUpdateInboundContractCaller,
  PermissionsUpdateInboundTokenCaller,
  PermissionsUpsertOverrideCaller,
} from '../settings/permissions-panel.js';
import type { BroadcastSubscriber } from '../realtime/subscriber.js';
import type { RunsListCaller } from '../logs/bootstrap-logs-route.js';
import { humanizeRpcError } from '../shell/rpc-error-copy.js';

// ════════════════════════════════════════════════════════════════
// Stable test/host hooks
// ════════════════════════════════════════════════════════════════

export const CONTRACTS_ROUTE_STYLES_MARKER = 'data-recued-contracts-route-styles';
export const CONTRACTS_ROUTE_HOST_ATTR = 'data-recued-contracts-route';
export const CONTRACTS_ROUTE_HEADING_ATTR = 'data-recued-contracts-route-heading';
export const CONTRACTS_ROUTE_BODY_ATTR = 'data-recued-contracts-body';
export const CONTRACTS_ROUTE_LOADING_ATTR = 'data-recued-contracts-loading';
export const CONTRACTS_ROUTE_ERROR_ATTR = 'data-recued-contracts-error';
export const CONTRACTS_ROUTE_PROPOSALS_ATTR = 'data-recued-contracts-proposals';
/** The LIST view container. */
export const CONTRACTS_ROUTE_LIST_ATTR = 'data-recued-contracts-list';
/** One contract row (an `<a>`); carries `data-contract-id`. */
export const CONTRACTS_ROUTE_ROW_ATTR = 'data-recued-contracts-row';
export const CONTRACTS_ROUTE_ROW_ID_ATTR = 'data-contract-id';
/** Kind badge (Self / Anonymous / Contract / Template). */
export const CONTRACTS_ROUTE_BADGE_ATTR = 'data-recued-contracts-badge';
/** A server-managed anonymous door contract row. */
export const CONTRACTS_ROUTE_ANONYMOUS_ATTR = 'data-recued-contracts-anonymous';
/** One list-level inventory tab; carries `data-tab`. */
export const CONTRACTS_ROUTE_LIST_TAB_ATTR = 'data-recued-contracts-list-tab';
/** The active list-tab panel; carries `data-tab`. */
export const CONTRACTS_ROUTE_LIST_PANEL_ATTR = 'data-recued-contracts-list-panel';
/** Lifecycle pill; carries `data-state` = the {@link ContractLifecycleState}. */
export const CONTRACTS_ROUTE_PILL_ATTR = 'data-recued-contracts-pill';
/** The DETAIL view container; carries `data-contract-id`. */
export const CONTRACTS_ROUTE_DETAIL_ATTR = 'data-recued-contracts-detail';
/** The focus landing for an exact contract detail. Carries the contract id. */
export const CONTRACTS_ROUTE_DETAIL_HEADING_ATTR =
  'data-recued-contracts-detail-heading';
/** The "← Back to contracts" link in DETAIL. */
export const CONTRACTS_ROUTE_BACK_ATTR = 'data-recued-contracts-back';
/** One tab button in the DETAIL tab strip; carries `data-tab`. */
export const CONTRACTS_ROUTE_TAB_ATTR = 'data-recued-contracts-tab';
/** The DETAIL active-tab body (empty placeholder in delta 1). */
export const CONTRACTS_ROUTE_TAB_BODY_ATTR = 'data-recued-contracts-tab-body';
/** The header "Recent activity → Log" link. */
export const CONTRACTS_ROUTE_ACTIVITY_LINK_ATTR = 'data-recued-contracts-activity-link';

// ── New-contract flow (delta 2) ─────────────────────────────────────
/** The `+ New contract` action on the Others tab (toggles the mint form). */
export const CONTRACTS_ROUTE_NEW_BUTTON_ATTR = 'data-recued-contracts-new';
/** Legacy absence-test hook: customer-template authoring now belongs to Seller. */
export const CONTRACTS_ROUTE_NEW_TEMPLATE_BUTTON_ATTR =
  'data-recued-contracts-new-template';
/** The mint form wrapper (revealed by the action). */
export const CONTRACTS_ROUTE_NEW_FORM_ATTR = 'data-recued-contracts-new-form';
/** The `display_name` text input. */
export const CONTRACTS_ROUTE_NEW_NAME_ATTR = 'data-recued-contracts-new-name';
/** One door-type toggle; carries `data-door` (a {@link DoorType}) +
 *  `data-checked` (the stable state hook). */
export const CONTRACTS_ROUTE_NEW_DOOR_ATTR = 'data-recued-contracts-new-door';
/** The optional expiry input (`expiry_at`). */
export const CONTRACTS_ROUTE_NEW_EXPIRY_ATTR = 'data-recued-contracts-new-expiry';
/** The optional usage-cap input (`max_uses`). */
export const CONTRACTS_ROUTE_NEW_CAP_ATTR = 'data-recued-contracts-new-cap';
/** Legacy absence-test hook for the removed generic template form. */
export const CONTRACTS_ROUTE_NEW_TEMPLATE_STATUS_ATTR =
  'data-recued-contracts-new-template-status';
/** The "Create" submit button. */
export const CONTRACTS_ROUTE_NEW_SUBMIT_ATTR = 'data-recued-contracts-new-submit';
/** The mint-form error chip (validation / mint failure). */
export const CONTRACTS_ROUTE_NEW_ERROR_ATTR = 'data-recued-contracts-new-error';

// ── Contract inventory paging ─────────────────────────────────────────
export const CONTRACTS_ROUTE_PAGE_SIZE = 25;
export const CONTRACTS_ROUTE_PAGER_ATTR = 'data-recued-contracts-pager';
export const CONTRACTS_ROUTE_PAGE_STATUS_ATTR = 'data-recued-contracts-page-status';
export const CONTRACTS_ROUTE_PAGE_PREVIOUS_ATTR = 'data-recued-contracts-page-previous';
export const CONTRACTS_ROUTE_PAGE_NEXT_ATTR = 'data-recued-contracts-page-next';

// ── Connect tab (delta 2) ───────────────────────────────────────────
/** The Connect tab's content host (snippets + the contract-credential panel). */
export const CONTRACTS_ROUTE_CONNECT_HOST_ATTR = 'data-recued-contracts-connect';
/** One how-to-connect snippet card; carries the client id as its value. */
export const CONTRACTS_ROUTE_SNIPPET_ATTR = 'data-recued-contracts-snippet';
/** The "contract connect is unavailable on this server" note (callers unwired). */
export const CONTRACTS_ROUTE_UNAVAILABLE_ATTR = 'data-recued-contracts-unavailable';

// ── Header L1 controls (delta 3) ────────────────────────────────────
/** One door-type toggle in the detail header (L1 door open/close). Carries
 *  `data-door` (a {@link DoorType}) + `data-backed` (`true`/`false`). */
export const CONTRACTS_ROUTE_DOOR_TOGGLE_ATTR = 'data-recued-contracts-door-toggle';
/** The Revoke kill-switch — first stage (arms the confirm) / in-flight label. */
export const CONTRACTS_ROUTE_REVOKE_ATTR = 'data-recued-contracts-revoke';
/** The armed "Confirm" button (second stage — commits the revoke). */
export const CONTRACTS_ROUTE_REVOKE_CONFIRM_ATTR = 'data-recued-contracts-revoke-confirm';
/** The armed "Cancel" button (disarms the confirm). */
export const CONTRACTS_ROUTE_REVOKE_CANCEL_ATTR = 'data-recued-contracts-revoke-cancel';
/** A header control error chip (door-toggle / revoke failure). */
export const CONTRACTS_ROUTE_HEAD_ERROR_ATTR = 'data-recued-contracts-head-error';

// Same-surface hash navigation remounts this route. Carry only the exact Back
// target across that short boundary, scoped to the owning document and consumed
// by the first list paint so it cannot leak into later Contracts visits.
const pendingListFocusByDocument = new WeakMap<Document, string>();

// ════════════════════════════════════════════════════════════════
// MCP client snippets (pure helpers — consumed by the delta-2 Connect tab)
// ════════════════════════════════════════════════════════════════

const TOKEN_PLACEHOLDER = '<token shown once after opening the door>';

export interface McpClientSnippet {
  readonly id: 'claude' | 'cursor' | 'codex' | 'custom';
  readonly label: string;
  readonly body: string;
}

export const mcpEndpointFromServerUrl = (serverUrl: string): string => {
  try {
    const url = new URL(serverUrl);
    if (url.protocol === 'wss:') url.protocol = 'https:';
    if (url.protocol === 'ws:') url.protocol = 'http:';
    url.pathname = '/mcp';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return `${serverUrl.replace(/\/+$/, '').replace(/\/ws$/, '')}/mcp`;
  }
};

export const buildMcpClientSnippets = (
  serverUrl: string,
): ReadonlyArray<McpClientSnippet> => {
  const endpoint = mcpEndpointFromServerUrl(serverUrl);
  const jsonConfig = JSON.stringify(
    {
      mcpServers: {
        recued: {
          url: endpoint,
          headers: {
            Authorization: `Bearer ${TOKEN_PLACEHOLDER}`,
          },
        },
      },
    },
    null,
    2,
  );

  return [
    { id: 'claude', label: 'Claude Desktop', body: jsonConfig },
    { id: 'cursor', label: 'Cursor', body: jsonConfig },
    {
      id: 'codex',
      label: 'Codex',
      body: [
        '[mcp_servers.recued]',
        `url = "${endpoint}"`,
        'bearer_token_env_var = "RECUED_MCP_TOKEN"',
      ].join('\n'),
    },
    {
      id: 'custom',
      label: 'Custom MCP client',
      body: [
        `url: ${endpoint}`,
        `Authorization: Bearer ${TOKEN_PLACEHOLDER}`,
      ].join('\n'),
    },
  ];
};

// ════════════════════════════════════════════════════════════════
// Styles
// ════════════════════════════════════════════════════════════════

const CONTRACTS_ROUTE_CHROME_STYLES = `
[${CONTRACTS_ROUTE_HOST_ATTR}] {
  /* Inherit the shell's light/dark tokens (index.html :root) instead of
     hard-pinning light values. */
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  max-width: var(--wc-content-max, 1080px);
  margin: 0 auto;
  padding: 16px;
  color: var(--fg);
}
[${CONTRACTS_ROUTE_BODY_ATTR}],
[${CONTRACTS_ROUTE_LIST_PANEL_ATTR}],
[${CONTRACTS_ROUTE_LIST_ATTR}],
[${CONTRACTS_ROUTE_DETAIL_ATTR}],
[${CONTRACTS_ROUTE_TAB_BODY_ATTR}],
[${CONTRACTS_ROUTE_CONNECT_HOST_ATTR}] {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  max-width: 100%;
}
[${CONTRACTS_ROUTE_BODY_ATTR}] > *,
[${CONTRACTS_ROUTE_LIST_PANEL_ATTR}] > *,
[${CONTRACTS_ROUTE_DETAIL_ATTR}] > *,
[${CONTRACTS_ROUTE_TAB_BODY_ATTR}] > *,
[${CONTRACTS_ROUTE_CONNECT_HOST_ATTR}] > * {
  min-width: 0;
  max-width: 100%;
}
[${CONTRACTS_ROUTE_HOST_ATTR}] .contracts-header {
  display: flex;
  align-items: baseline;
  gap: 12px;
  margin-bottom: 14px;
}
[${CONTRACTS_ROUTE_HOST_ATTR}] .contracts-title {
  margin: 0;
  font-size: 20px;
  font-weight: 650;
}
[${CONTRACTS_ROUTE_HOST_ATTR}] .contracts-link {
  box-sizing: border-box;
  min-height: 36px;
  display: inline-flex;
  align-items: center;
  padding: 4px;
  border-radius: 6px;
  font-size: 13px;
  color: var(--accent);
  text-decoration: none;
}
[${CONTRACTS_ROUTE_HOST_ATTR}] .contracts-link:hover {
  background: var(--accent-weak);
  text-decoration: underline;
}
[${CONTRACTS_ROUTE_HOST_ATTR}] .contracts-link:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
[${CONTRACTS_ROUTE_HOST_ATTR}] .contracts-section-copy {
  margin: 0;
  font-size: 13px;
  color: var(--muted);
  line-height: 1.45;
}
[${CONTRACTS_ROUTE_HOST_ATTR}] .contracts-intro {
  max-width: 68ch;
  margin: -4px 0 20px;
}
[${CONTRACTS_ROUTE_HOST_ATTR}] .contracts-inventory-section {
  margin: 0 0 24px;
}
[${CONTRACTS_ROUTE_HOST_ATTR}] .contracts-list-tabs {
  display: flex;
  gap: 4px;
  margin: 0 0 18px;
  border-bottom: 1px solid var(--border);
}
[${CONTRACTS_ROUTE_LIST_TAB_ATTR}] {
  display: inline-block;
  padding: 9px 13px;
  border-bottom: 2px solid transparent;
  color: var(--muted);
  font-size: 13px;
  font-weight: 600;
  text-decoration: none;
}
[${CONTRACTS_ROUTE_LIST_TAB_ATTR}][aria-selected="true"] {
  color: var(--fg);
  border-bottom-color: var(--accent);
}
[${CONTRACTS_ROUTE_HOST_ATTR}] .contracts-section-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 8px;
}
[${CONTRACTS_ROUTE_HOST_ATTR}] .contracts-section-title {
  margin: 0;
  font-size: 15px;
  font-weight: 650;
}
[${CONTRACTS_ROUTE_LOADING_ATTR}],
[${CONTRACTS_ROUTE_ERROR_ATTR}] {
  box-sizing: border-box;
  min-width: 0;
  max-width: 100%;
  font-size: 13px;
  color: var(--muted);
  padding: 10px 0;
  overflow-wrap: anywhere;
}
[${CONTRACTS_ROUTE_ERROR_ATTR}] {
  color: var(--danger, #b3261e);
}

/* ── LIST ───────────────────────────────────────────────────────── */
[${CONTRACTS_ROUTE_LIST_ATTR}] {
  display: grid;
  gap: 8px;
  margin: 6px 0;
  padding: 0;
  list-style: none;
}
[${CONTRACTS_ROUTE_LIST_ATTR}] > li {
  min-width: 0;
  max-width: 100%;
}
[${CONTRACTS_ROUTE_ROW_ATTR}] {
  box-sizing: border-box;
  display: flex;
  width: 100%;
  min-width: 0;
  max-width: 100%;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface-subtle);
  text-decoration: none;
  color: var(--fg);
}
[${CONTRACTS_ROUTE_ROW_ATTR}] > * {
  min-width: 0;
  max-width: 100%;
}
[${CONTRACTS_ROUTE_ROW_ATTR}]:hover {
  border-color: var(--accent);
}
[${CONTRACTS_ROUTE_ROW_ATTR}] .contracts-row-name {
  min-width: 0;
  max-width: 100%;
  flex: 1 1 180px;
  font-size: 14px;
  font-weight: 600;
  overflow-wrap: anywhere;
}
[${CONTRACTS_ROUTE_ROW_ATTR}] .contracts-row-meta {
  min-width: 0;
  max-width: 100%;
  margin-left: auto;
  font-size: 12px;
  color: var(--muted);
  overflow-wrap: anywhere;
}
[${CONTRACTS_ROUTE_ANONYMOUS_ATTR}] {
  cursor: pointer;
}

/* ── badge + pill ───────────────────────────────────────────────── */
[${CONTRACTS_ROUTE_BADGE_ATTR}] {
  font-size: 11px;
  font-weight: 650;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  padding: 2px 7px;
  border-radius: 999px;
  border: 1px solid var(--border);
  color: var(--muted);
}
[${CONTRACTS_ROUTE_BADGE_ATTR}][data-kind="self"] {
  color: var(--accent);
  border-color: var(--accent);
}
[${CONTRACTS_ROUTE_BADGE_ATTR}][data-kind="door"] {
  color: var(--fg);
  border-color: var(--border-strong, var(--border));
}
[${CONTRACTS_ROUTE_PILL_ATTR}] {
  font-size: 11px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--surface-sunk, var(--surface));
  color: var(--muted);
}
[${CONTRACTS_ROUTE_PILL_ATTR}][data-state="active"] {
  color: #0a7d33;
  background: color-mix(in srgb, #0a7d33 14%, transparent);
}
[${CONTRACTS_ROUTE_PILL_ATTR}][data-state="revoked"],
[${CONTRACTS_ROUTE_PILL_ATTR}][data-state="expired"],
[${CONTRACTS_ROUTE_PILL_ATTR}][data-state="exhausted"] {
  color: var(--danger, #b3261e);
  background: color-mix(in srgb, var(--danger, #b3261e) 12%, transparent);
}

/* ── contract inventory paging ────────────────────────────────────── */
[${CONTRACTS_ROUTE_PAGER_ATTR}] {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 10px;
}
[${CONTRACTS_ROUTE_PAGE_STATUS_ATTR}] {
  margin-right: auto;
  font-size: 12px;
  color: var(--muted);
}
[${CONTRACTS_ROUTE_PAGE_PREVIOUS_ATTR}],
[${CONTRACTS_ROUTE_PAGE_NEXT_ATTR}] {
  box-sizing: border-box;
  min-height: 36px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  appearance: none;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--surface);
  color: var(--fg);
  padding: 6px 10px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
[${CONTRACTS_ROUTE_PAGE_PREVIOUS_ATTR}][disabled],
[${CONTRACTS_ROUTE_PAGE_NEXT_ATTR}][disabled] {
  opacity: 0.5;
  cursor: default;
}

/* ── DETAIL ─────────────────────────────────────────────────────── */
[${CONTRACTS_ROUTE_BACK_ATTR}] {
  box-sizing: border-box;
  min-height: 36px;
  display: inline-flex;
  align-items: center;
  margin-bottom: 12px;
  padding: 4px;
  border-radius: 6px;
  font-size: 13px;
  color: var(--accent);
  text-decoration: none;
}
[${CONTRACTS_ROUTE_BACK_ATTR}]:hover {
  background: var(--accent-weak);
  text-decoration: underline;
}
[${CONTRACTS_ROUTE_BACK_ATTR}]:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
[${CONTRACTS_ROUTE_DETAIL_ATTR}] .contracts-detail-head {
  box-sizing: border-box;
  display: flex;
  width: 100%;
  min-width: 0;
  max-width: 100%;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--border);
}
[${CONTRACTS_ROUTE_DETAIL_ATTR}] .contracts-detail-head > * {
  min-width: 0;
  max-width: 100%;
}
[${CONTRACTS_ROUTE_DETAIL_ATTR}] .contracts-detail-name {
  min-width: 0;
  max-width: 100%;
  flex: 1 1 180px;
  margin: 0;
  font-size: 17px;
  font-weight: 650;
  overflow-wrap: anywhere;
}
[${CONTRACTS_ROUTE_DETAIL_ATTR}] .contracts-detail-limits {
  min-width: 0;
  max-width: 100%;
  font-size: 12px;
  color: var(--muted);
  overflow-wrap: anywhere;
}
[${CONTRACTS_ROUTE_DETAIL_ATTR}] .contracts-detail-spacer {
  margin-left: auto;
}
[${CONTRACTS_ROUTE_DETAIL_ATTR}] .contracts-tabs {
  display: flex;
  gap: 4px;
  margin: 14px 0 0;
  border-bottom: 1px solid var(--border);
}
[${CONTRACTS_ROUTE_TAB_ATTR}] {
  box-sizing: border-box;
  min-height: 36px;
  appearance: none;
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  padding: 8px 12px;
  font-size: 13px;
  font-weight: 600;
  color: var(--muted);
  cursor: pointer;
}
[${CONTRACTS_ROUTE_TAB_ATTR}][aria-selected="true"] {
  color: var(--fg);
  border-bottom-color: var(--accent);
}
[${CONTRACTS_ROUTE_TAB_BODY_ATTR}] {
  padding: 18px 4px;
  font-size: 13px;
  color: var(--muted);
  line-height: 1.5;
}

/* ── header L1 controls (door toggle + revoke) ──────────────────── */
[${CONTRACTS_ROUTE_DETAIL_ATTR}] .contracts-door {
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 11px;
  color: var(--muted);
}
[${CONTRACTS_ROUTE_DETAIL_ATTR}] .contracts-door-label {
  text-transform: uppercase;
  letter-spacing: 0.04em;
  font-weight: 600;
}
[${CONTRACTS_ROUTE_DOOR_TOGGLE_ATTR}] {
  box-sizing: border-box;
  min-height: 36px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 5px;
  border-radius: 6px;
  cursor: pointer;
}
[${CONTRACTS_ROUTE_DOOR_TOGGLE_ATTR}]:has(input:focus-visible) {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
[${CONTRACTS_ROUTE_DOOR_TOGGLE_ATTR}] input {
  width: 16px;
  height: 16px;
  margin: 0;
  accent-color: var(--accent);
  cursor: inherit;
}
[${CONTRACTS_ROUTE_DOOR_TOGGLE_ATTR}] input[disabled],
[${CONTRACTS_ROUTE_DOOR_TOGGLE_ATTR}] input[aria-disabled="true"] {
  opacity: 0.6;
  cursor: default;
}
[${CONTRACTS_ROUTE_DOOR_TOGGLE_ATTR}] .contracts-door-name {
  font-size: 12px;
  color: var(--fg);
}
[${CONTRACTS_ROUTE_DETAIL_ATTR}] .contracts-revoke-wrap {
  display: inline-flex;
  min-width: 0;
  max-width: 100%;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}
[${CONTRACTS_ROUTE_REVOKE_ATTR}],
[${CONTRACTS_ROUTE_REVOKE_CONFIRM_ATTR}],
[${CONTRACTS_ROUTE_REVOKE_CANCEL_ATTR}] {
  box-sizing: border-box;
  min-height: 36px;
  appearance: none;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: none;
  padding: 5px 11px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  color: var(--fg);
}
[${CONTRACTS_ROUTE_REVOKE_ATTR}],
[${CONTRACTS_ROUTE_REVOKE_CONFIRM_ATTR}] {
  color: var(--danger, #b3261e);
  border-color: var(--danger, #b3261e);
}
[${CONTRACTS_ROUTE_REVOKE_ATTR}][disabled],
[${CONTRACTS_ROUTE_REVOKE_ATTR}][aria-disabled="true"] {
  opacity: 0.6;
  cursor: default;
}
[${CONTRACTS_ROUTE_DETAIL_ATTR}] .contracts-revoke-prompt {
  font-size: 12px;
  color: var(--muted);
}
[${CONTRACTS_ROUTE_HEAD_ERROR_ATTR}] {
  min-width: 0;
  max-width: 100%;
  flex-basis: 100%;
  margin: 0;
  font-size: 12px;
  color: var(--danger, #b3261e);
  overflow-wrap: anywhere;
}

/* ── New-contract flow ──────────────────────────────────────────── */
[${CONTRACTS_ROUTE_HOST_ATTR}] .contracts-new-wrap {
  box-sizing: border-box;
  display: grid;
  width: 100%;
  min-width: 0;
  max-width: 100%;
  gap: 10px;
  margin: 4px 0 12px;
}
[${CONTRACTS_ROUTE_NEW_BUTTON_ATTR}] {
  justify-self: start;
  appearance: none;
  border: 1px solid var(--accent);
  border-radius: 8px;
  background: none;
  color: var(--accent);
  padding: 8px 14px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
[${CONTRACTS_ROUTE_NEW_BUTTON_ATTR}]:hover {
  background: color-mix(in srgb, var(--accent) 10%, transparent);
}
[${CONTRACTS_ROUTE_NEW_FORM_ATTR}] {
  box-sizing: border-box;
  display: grid;
  width: 100%;
  min-width: 0;
  max-width: 100%;
  gap: 10px;
  padding: 14px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface-subtle);
}
[${CONTRACTS_ROUTE_NEW_FORM_ATTR}] > * {
  min-width: 0;
  max-width: 100%;
}
[${CONTRACTS_ROUTE_NEW_FORM_ATTR}] .contracts-new-field {
  display: grid;
  min-width: 0;
  max-width: 100%;
  gap: 4px;
  font-size: 12px;
  color: var(--muted);
}
[${CONTRACTS_ROUTE_NEW_FORM_ATTR}] input {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  max-width: 100%;
  font: inherit;
  font-size: 13px;
  padding: 7px 9px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--surface);
  color: var(--fg);
}
[${CONTRACTS_ROUTE_NEW_FORM_ATTR}] .contracts-new-doors {
  display: flex;
  min-width: 0;
  max-width: 100%;
  flex-wrap: wrap;
  gap: 8px;
}
[${CONTRACTS_ROUTE_NEW_DOOR_ATTR}] {
  appearance: none;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--surface);
  color: var(--muted);
  padding: 5px 12px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
[${CONTRACTS_ROUTE_NEW_DOOR_ATTR}][data-checked="true"] {
  border-color: var(--accent);
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 12%, transparent);
}
[${CONTRACTS_ROUTE_NEW_SUBMIT_ATTR}] {
  justify-self: start;
  appearance: none;
  border: none;
  border-radius: 8px;
  background: var(--accent);
  color: var(--accent-fg, #fff);
  padding: 8px 16px;
  font-size: 13px;
  font-weight: 650;
  cursor: pointer;
}
[${CONTRACTS_ROUTE_NEW_SUBMIT_ATTR}]:disabled {
  opacity: 0.6;
  cursor: default;
}
[${CONTRACTS_ROUTE_NEW_ERROR_ATTR}] {
  min-width: 0;
  max-width: 100%;
  margin: 0;
  font-size: 12px;
  color: var(--danger, #b3261e);
  overflow-wrap: anywhere;
}
[${CONTRACTS_ROUTE_NEW_ERROR_ATTR}]:empty {
  display: none;
}

/* ── Connect tab ────────────────────────────────────────────────── */
[${CONTRACTS_ROUTE_CONNECT_HOST_ATTR}] {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 14px;
}
[${CONTRACTS_ROUTE_CONNECT_HOST_ATTR}] [data-recued-permissions-panel],
[${CONTRACTS_ROUTE_CONNECT_HOST_ATTR}] [data-recued-permissions-panel] > * {
  box-sizing: border-box;
  min-width: 0;
  max-width: 100%;
}
[${CONTRACTS_ROUTE_CONNECT_HOST_ATTR}] [data-recued-permissions-panel] :is(
  input, select, textarea
) {
  box-sizing: border-box;
  min-width: 0;
  max-width: 100%;
}
[${CONTRACTS_ROUTE_CONNECT_HOST_ATTR}] .contracts-snippet-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}
[${CONTRACTS_ROUTE_SNIPPET_ATTR}] {
  min-width: 0;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px;
  background: var(--surface-subtle);
}
[${CONTRACTS_ROUTE_SNIPPET_ATTR}] .contracts-snippet-label {
  margin: 0 0 6px;
  font-size: 12px;
  font-weight: 650;
  color: var(--muted);
}
[${CONTRACTS_ROUTE_SNIPPET_ATTR}] pre {
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-family: var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 11px;
  line-height: 1.45;
  color: var(--fg);
}
[${CONTRACTS_ROUTE_UNAVAILABLE_ATTR}] {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  background: var(--surface-subtle);
  font-size: 13px;
  color: var(--muted);
}

@media (max-width: 720px) {
  [${CONTRACTS_ROUTE_HOST_ATTR}] .contracts-header {
    display: grid;
  }
  [${CONTRACTS_ROUTE_ROW_ATTR}] {
    flex-wrap: wrap;
  }
  [${CONTRACTS_ROUTE_ROW_ATTR}] .contracts-row-meta {
    margin-left: 0;
    flex-basis: 100%;
  }
  [${CONTRACTS_ROUTE_CONNECT_HOST_ATTR}] .contracts-snippet-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
`;

export const CONTRACTS_ROUTE_STYLES = [
  PRIMITIVE_STYLES,
  SUGGESTED_RULES_PANEL_STYLES,
  CONTRACT_GRANTS_PANEL_STYLES,
  CONTRACTS_ROUTE_CHROME_STYLES,
  // The Connect tab mounts the shared credential / override editor directly.
  // Bundle its scoped CSS here so a cold Contracts deep link does not render
  // the editor as native controls in one collapsed line.
  PERMISSIONS_PANEL_STYLES,
].join('\n');

// ════════════════════════════════════════════════════════════════
// Options + handle
// ════════════════════════════════════════════════════════════════

export const CONTRACTS_LIST_TABS = ['built-in', 'customer', 'others'] as const;
export type ContractsListTab = (typeof CONTRACTS_LIST_TABS)[number];

const CONTRACTS_LIST_PANEL_ID = 'recued-contracts-list-panel';
const listTabId = (tab: ContractsListTab): string =>
  `recued-contracts-list-tab-${tab}`;

// Category navigation remounts this route through the shell hash. Carry only
// the user-activated category across that short boundary so the replacement
// tab owns focus; direct deep links still land without stealing it.
const pendingListTabFocusByDocument = new WeakMap<
  Document,
  ContractsListTab
>();

export const isContractsListTab = (value: unknown): value is ContractsListTab =>
  typeof value === 'string'
  && (CONTRACTS_LIST_TABS as readonly string[]).includes(value);

export interface BootstrapContractsRouteOptions {
  root: HTMLElement;
  document?: Document;
  serverUrl: string;
  /** Deep-link segment — the selected contract id (`#contracts/<id>`). When
   *  set and it resolves to a known contract, the route opens that contract's
   *  DETAIL; otherwise it shows the LIST. */
  initialContractId?: string;
  /** Deep-link segment 1 — the selected DETAIL tab (`#contracts/<id>/<tab>`).
   *  Seeds the initial active tab when it is valid for the opened contract;
   *  otherwise the first tab is used. Tab CLICKS after mount are local state
   *  (no navigation), so this only seeds the landing tab — the new-contract
   *  flow lands on `connect`. */
  initialContractTab?: string;
  /** Addressable LIST tab (`#contracts/view/<tab>`). Bare `#contracts` defaults
   *  to Built-in. Ignored when `initialContractId` resolves to a detail. */
  initialListTab?: ContractsListTab;
  /** Navigation seam — sets the shell hash to drive a same-surface re-mount
   *  (the new-contract flow navigates to the fresh contract's DETAIL). Defaults
   *  to assigning `globalThis.location.hash`; tests inject a capturing fake. */
  navigate?: (hash: string) => void;
  // ── caller seams (kept across deltas; most wire in via deltas 2-4) ──
  permissionsListOverridesCaller?: PermissionsListOverridesCaller;
  permissionsDeleteOverrideCaller?: PermissionsDeleteOverrideCaller;
  permissionsUpsertOverrideCaller?: PermissionsUpsertOverrideCaller;
  permissionsListCatalogOperationsCaller?: PermissionsListCatalogOperationsCaller;
  permissionsListInboundTokensCaller?: PermissionsListInboundTokensCaller;
  permissionsIssueInboundTokenCaller?: PermissionsIssueInboundTokenCaller;
  permissionsRevokeInboundTokenCaller?: PermissionsRevokeInboundTokenCaller;
  permissionsUpdateInboundTokenCaller?: PermissionsUpdateInboundTokenCaller;
  permissionsToolCatalogCaller?: PermissionsToolCatalogCaller;
  permissionsMintContractCaller?: PermissionsMintContractCaller;
  permissionsRevokeContractCaller?: PermissionsRevokeContractCaller;
  permissionsListContractsCaller?: PermissionsListContractsCaller;
  permissionsUpdateInboundContractCaller?: PermissionsUpdateInboundContractCaller;
  contractsListCaller?: ContractsListCaller;
  contractsRevokeCaller?: ContractsRevokeCaller;
  /** D-177 N.13 — the staged-trust suggestion surface; all three gate the
   *  list-view "Proposals" area (the panel renders nothing visible when there
   *  are no open suggestions). */
  suggestionsListCaller?: SuggestionsListCaller;
  suggestionsAcceptCaller?: SuggestionsAcceptCaller;
  suggestionsDismissCaller?: SuggestionsDismissCaller;
  /** D-177 rule 5 — the scoped-grant proposal surface (same all-three gate). */
  scopedSuggestionsListCaller?: ScopedSuggestionsListCaller;
  scopedSuggestionsAcceptCaller?: ScopedSuggestionsAcceptCaller;
  scopedSuggestionsDismissCaller?: ScopedSuggestionsDismissCaller;
  grantReadCaller?: GrantReadCaller;
  grantReadByEntryCaller?: GrantReadByEntryCaller;
  grantWriteCaller?: GrantWriteCaller;
  grantListContractsCaller?: GrantContractsCaller;
  grantCatalogOperationsCaller?: GrantCatalogOperationsCaller;
  grantRegistryDescribeCaller?: GrantRegistryDescribeCaller;
  grantSetDoorTypesCaller?: GrantSetDoorTypesCaller;
  /** `cli.reachability.{list,set}` — route CLI ops in the Ops grant panel to the
   *  cli_reachability allowlist (their real authority), not contract_grant. */
  grantCliReachabilityListCaller?: GrantCliReachabilityListCaller;
  grantCliReachabilitySetCaller?: GrantCliReachabilitySetCaller;
  /** Trailing debounce for the contract-detail Ops type-along filter. */
  operationFilterDebounceMs?: number;
  runsListCaller?: RunsListCaller;
  now?: () => number;
  subscribe?: BroadcastSubscriber['on'];
}

/** A list/detail row. Owner is synthesized client-side; every other row maps
 *  from a stored contract definition. */
export interface ContractRowVM {
  readonly contract_id: string;
  readonly display_name: string;
  readonly is_self: boolean;
  readonly lifecycle_state: ContractLifecycleState;
  readonly grant_kind?: ContractGrantKind;
  readonly expiry_at?: number;
  readonly max_uses?: number;
  readonly uses_remaining?: number;
  /** Level-1 door types this contract backs. Absent / empty = wildcard
   *  (backs all). Drives the header door toggle (L1). Absent on self (not a
   *  door). */
  readonly door_types?: ReadonlyArray<DoorType>;
}

export type ContractsViewMode = 'loading' | 'list' | 'detail';

export interface ContractsRoute {
  /** Current rows (self first), after the initial load settles. */
  getContracts(): ReadonlyArray<ContractRowVM>;
  /** The rendered view mode after the initial load. */
  getViewMode(): ContractsViewMode;
  /** Selected contract id when in DETAIL, else null. */
  getSelectedContractId(): string | null;
  /** The active DETAIL tab id, else null. */
  getActiveTab(): string | null;
  /** The active inventory tab in LIST mode. */
  getListTab(): ContractsListTab;
  /** The credential panel mounted in the open DETAIL's Connect tab, or null
   *  (a built-in/template detail or the MCP-door callers aren't wired). It is
   *  built once per ordinary contract DETAIL and kept alive across tabs so a
   *  just-revealed one-time token survives a round-trip to Ops/Entities. */
  permissionsPanel(): PermissionsPanelMount | null;
  /** The single-contract grant view mounted for the open DETAIL's Ops/Entities
   *  tabs, or null (no DETAIL open / the grant callers aren't wired). Built once
   *  per DETAIL and shared by both tabs (kept alive across tab switches). */
  contractGrantsPanel(): ContractGrantsPanelMount | null;
  suggestedRulesPanel(): SuggestedRulesPanelMount | null;
  scopedGrantPanel(): ScopedGrantPanelMount | null;
  /** Resolves after the initial contract load + first render. */
  whenLoaded(): Promise<void>;
  /** True while any route-local or child-panel contract write is unresolved. */
  hasInFlightWork(): boolean;
  /** Contextual shell guard for contract writes that cannot be recalled. */
  inFlightWorkPrompt(): string | null;
  getRecoveryContextFreshness(): 'current' | 'unavailable';
  /** Re-read the privacy-safe inventory landing without reconstructing a
   * contract detail that was deliberately withheld during recovery. */
  retryRecoveryContext?(): Promise<void>;
  dispose(): void;
}

// ════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════

const SELF_ROW: ContractRowVM = {
  contract_id: OWNER_CONTRACT_ID,
  display_name: 'Owner (you)',
  is_self: true,
  lifecycle_state: 'active',
};

const toRowVM = (c: ContractDefinitionView): ContractRowVM => ({
  contract_id: c.contract_id,
  display_name: c.display_name,
  is_self: false,
  lifecycle_state: c.lifecycle_state,
  ...(c.grant_kind !== undefined ? { grant_kind: c.grant_kind } : {}),
  ...(c.expiry_at !== undefined ? { expiry_at: c.expiry_at } : {}),
  ...(c.max_uses !== undefined ? { max_uses: c.max_uses } : {}),
  ...(c.uses_remaining !== undefined ? { uses_remaining: c.uses_remaining } : {}),
  ...(c.door_types !== undefined ? { door_types: c.door_types } : {}),
});

// ── Level-1 door-type math (a door backs a subset of DOOR_TYPES; absent/empty
//    = wildcard "backs all"). Salvaged from the global grant-matrix panel so it
//    retires cleanly in delta 4. ──
//
// D-207 slice 1c — this math runs over AUTHORABLE_DOOR_TYPES, not DOOR_TYPES. The two
// diverged when D-207 added `reception`: DOOR_TYPES is what a contract may BACK, and
// AUTHORABLE_DOOR_TYPES is what a HUMAN may hand-author. A reception door is not
// hand-authored — the server MINTS it from a recipe's derived capability when the owner
// binds a pair, which is the entire consent flow. It has no business in a toggle grid.
//
// The toggle grid already renders only the authorable types (below). Leaving the MATH on
// DOOR_TYPES was the half of the change that did not land, and it was not cosmetic: a
// wildcard door expanded to all four, so unticking one type wrote back an explicit list
// with `reception` in it — a human idly narrowing an MCP door would have hand-granted the
// anonymous public a door type they were never shown.
const doorTypeBacked = (
  doorTypes: ReadonlyArray<DoorType> | undefined,
  doorType: DoorType,
): boolean =>
  doorTypes === undefined || doorTypes.length === 0 || doorTypes.includes(doorType);

const backedDoorTypes = (
  doorTypes: ReadonlyArray<DoorType> | undefined,
): DoorType[] => AUTHORABLE_DOOR_TYPES.filter((t) => doorTypeBacked(doorTypes, t));

/** The explicit `door_types` to WRITE when toggling `doorType`, or `null` when
 *  the toggle would leave the door backing NOTHING (invalid — a door must back
 *  ≥1 type, and `[]` already means wildcard). "Backs all" normalizes to `[]`
 *  (matching mint); a strict subset is sent verbatim in AUTHORABLE_DOOR_TYPES order. */
const nextDoorTypes = (
  doorTypes: ReadonlyArray<DoorType> | undefined,
  doorType: DoorType,
): ReadonlyArray<DoorType> | null => {
  const backed = new Set(backedDoorTypes(doorTypes));
  if (backed.has(doorType)) backed.delete(doorType);
  else backed.add(doorType);
  if (backed.size === 0) return null;
  if (backed.size === AUTHORABLE_DOOR_TYPES.length) return [];
  return AUTHORABLE_DOOR_TYPES.filter((t) => backed.has(t));
};

const formatDateTime = (ts: number): string =>
  formatClientDateTime(ts, { invalidText: String(ts) });

const errMessage = (err: unknown): string =>
  humanizeRpcError(err);

const lifecycleLabel = (state: ContractLifecycleState): string =>
  state.charAt(0).toUpperCase() + state.slice(1);

const isCustomerTemplateRow = (row: ContractRowVM): boolean =>
  row.grant_kind === 'customer_template';

const listTabRoute = (tab: ContractsListTab): string =>
  serializeShellRoute('contracts', 'view', tab);

/** D-209 Task 3 — a DERIVED anonymous door (reception intake-form bind /
 *  webhook enrollment), via the contracts-owned partition
 *  ({@link derivedDoorType} classifies on EXPLICIT `door_types` membership —
 *  proof of a mint; a wildcard ordinary contract must NOT classify as public).
 *  Self/template take precedence: those identities own their badge, tabs and
 *  copy even if a row ever carried a derived door type (unreachable today —
 *  defensive consistency with `appendBadgeAndPill`/`tabsFor`). */
const anonymousDoorType = (row: ContractRowVM): DerivedDoorType | null =>
  row.is_self || isCustomerTemplateRow(row)
    ? null
    : derivedDoorType(row.door_types);

const listTabForRow = (row: ContractRowVM): ContractsListTab =>
  row.is_self || anonymousDoorType(row) !== null
    ? 'built-in'
    : isCustomerTemplateRow(row)
      ? 'customer'
      : 'others';

/** Badge + meta copy per derived door type. `Record<DerivedDoorType, …>` is
 *  the exhaustiveness pin: a future third derived door type fails compilation
 *  here instead of silently rendering as the wrong door class. */
const DERIVED_DOOR_BADGES: Record<DerivedDoorType, string> = {
  reception: 'Public form',
  webhook: 'Webhook',
};
const DERIVED_DOOR_META: Record<DerivedDoorType, string> = {
  reception: 'Runs its bound recipe for anonymous form visitors · capped by its granted ops',
  webhook: 'Runs its enrolled recipe on vendor deliveries · capped by its granted ops',
};

/** One-line "limits" summary for the row meta + detail header. */
const limitsSummary = (row: ContractRowVM): string => {
  if (row.is_self) return 'Standing authority — no expiry, no usage cap';
  if (isCustomerTemplateRow(row)) {
    return 'Customer template · stamped when access is issued';
  }
  // A derived door has no uses/expiry knobs — what bounds it is the recipe it
  // was derived from and the granted op closure. Saying "unlimited uses · no
  // expiry" here would be true and misleading at once. If a door row ever DID
  // carry a cap/expiry, hiding it would be the worse lie — fall through and
  // append the real limits after the door copy.
  const doorType = anonymousDoorType(row);
  if (doorType !== null && row.max_uses === undefined && row.expiry_at === undefined) {
    return DERIVED_DOOR_META[doorType];
  }
  const parts: string[] = doorType !== null ? [DERIVED_DOOR_META[doorType]] : [];
  if (row.max_uses !== undefined) {
    const remaining = row.uses_remaining ?? row.max_uses;
    parts.push([String(remaining), 'of', String(row.max_uses), 'uses left'].join(' '));
  } else {
    parts.push('unlimited uses');
  }
  parts.push(
    row.expiry_at !== undefined
      ? ['expires', formatDateTime(row.expiry_at)].join(' ')
      : 'no expiry',
  );
  return parts.join(' · ');
};

interface TabSpec {
  readonly id: string;
  readonly label: string;
}

// A derived anonymous door has no inbound token — its "connection" is the
// public form / vendor endpoint it was minted for — so the Connect tab (MCP
// link + one-time access code) would be meaningless and misleading on it.
// Its Ops/Entities tabs ARE the grantable-rows surface (D-207 §5.2).
const tabsFor = (row: ContractRowVM): ReadonlyArray<TabSpec> =>
  row.is_self || isCustomerTemplateRow(row) || anonymousDoorType(row) !== null
    ? [
        { id: 'ops', label: 'Ops' },
        { id: 'entities', label: 'Entities' },
      ]
    : [
        { id: 'connect', label: 'Connect' },
        { id: 'ops', label: 'Ops' },
        { id: 'entities', label: 'Entities' },
      ];

const tabPlaceholder = (id: string): string => {
  switch (id) {
    case 'connect':
      return 'Connection link, one-time access code, and client setup.';
    case 'ops':
      return 'Per-operation grants, grouped by pack.';
    case 'entities':
      return 'Per-entity grants — collections and enrichment topics.';
    default:
      return '';
  }
};

const makeEl = <K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] => {
  const node = doc.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const appendBadgeAndPill = (
  doc: Document,
  host: HTMLElement,
  row: ContractRowVM,
): void => {
  const doorType = anonymousDoorType(row);
  const [badgeKind, badgeLabel] = row.is_self
    ? ['self', 'Self']
    : isCustomerTemplateRow(row)
      ? ['template', 'Template']
      : doorType !== null
        ? ['door', DERIVED_DOOR_BADGES[doorType]]
        : ['contract', 'Contract'];
  const badge = makeEl(doc, 'span', undefined, badgeLabel);
  badge.setAttribute(CONTRACTS_ROUTE_BADGE_ATTR, '');
  badge.setAttribute('data-kind', badgeKind);
  host.appendChild(badge);

  const pill = makeEl(
    doc,
    'span',
    undefined,
    lifecycleLabel(row.lifecycle_state),
  );
  pill.setAttribute(CONTRACTS_ROUTE_PILL_ATTR, '');
  pill.setAttribute('data-state', row.lifecycle_state);
  host.appendChild(pill);
};

/** One how-to-connect snippet card in a contract's Connect tab. */
const appendSnippet = (
  doc: Document,
  host: HTMLElement,
  snippet: McpClientSnippet,
): void => {
  const card = doc.createElement('section');
  card.setAttribute(CONTRACTS_ROUTE_SNIPPET_ATTR, snippet.id);
  const label = makeEl(doc, 'h3', 'contracts-snippet-label', snippet.label);
  card.appendChild(label);
  const pre = doc.createElement('pre');
  pre.textContent = snippet.body;
  card.appendChild(pre);
  host.appendChild(card);
};

const DOOR_TYPE_LABELS: Record<DoorType, string> = {
  mcp: 'MCP tools',
  mcp_chat: 'MCP chat',
  llm_gateway: 'LLM gateway',
  // D-207 — present for exhaustiveness; a reception door is DERIVED from a
  // (form, recipe) bind and never appears in the hand-authoring list.
  reception: 'Reception (public form)',
  // D-209 #1 — same: a webhook door is DERIVED at enrollment, never authored,
  // and (D-171 decision 8) not a row in the owner-facing door list either.
  webhook: 'Webhook (vendor endpoint)',
};

const clearChildren = (node: HTMLElement): void => {
  while (node.firstChild !== null) node.removeChild(node.firstChild);
};

// ════════════════════════════════════════════════════════════════
// Mount
// ════════════════════════════════════════════════════════════════

export const bootstrapContractsRoute = (
  opts: BootstrapContractsRouteOptions,
): ContractsRoute => {
  const doc = opts.document ?? (globalThis as { document?: Document }).document;
  if (doc === undefined) {
    throw new Error(
      'bootstrapContractsRoute: no document available - pass `opts.document` for non-browser environments',
    );
  }

  if (
    doc.head.querySelector(`style[${CONTRACTS_ROUTE_STYLES_MARKER}]`) === null
  ) {
    const style = doc.createElement('style');
    style.setAttribute(CONTRACTS_ROUTE_STYLES_MARKER, '');
    style.textContent = CONTRACTS_ROUTE_STYLES;
    doc.head.appendChild(style);
  }

  const routeRoot = doc.createElement('div');
  routeRoot.setAttribute(CONTRACTS_ROUTE_HOST_ATTR, '');

  const header = makeEl(doc, 'header', 'contracts-header');
  const heading = makeEl(doc, 'h1', 'contracts-title', 'Contracts');
  heading.setAttribute(CONTRACTS_ROUTE_HEADING_ATTR, '');
  header.appendChild(heading);
  routeRoot.appendChild(header);

  const body = doc.createElement('div');
  body.setAttribute(CONTRACTS_ROUTE_BODY_ATTR, '');
  routeRoot.appendChild(body);

  opts.root.appendChild(routeRoot);

  const navigate =
    opts.navigate
    ?? ((hash: string): void => {
      const loc = (globalThis as { location?: { hash: string } }).location;
      if (loc !== undefined) loc.hash = hash;
    });

  // The contract credential panel (token reveal/copy/revoke + tool grants) is
  // re-homed into the Connect tab; it mounts only when the three inbound-token
  // lifecycle callers are wired (the pre-delta-1 credential gate). Absent ⇒
  // the Connect tab shows the snippets + an "unavailable" note.
  const canMountContractCredential =
    opts.permissionsListInboundTokensCaller !== undefined
    && opts.permissionsIssueInboundTokenCaller !== undefined
    && opts.permissionsRevokeInboundTokenCaller !== undefined;

  // ── mutable state (settles after the one load) ──
  let disposed = false;
  let activeListTab: ContractsListTab = opts.initialListTab ?? 'built-in';
  let rows: ReadonlyArray<ContractRowVM> = [];
  let viewMode: ContractsViewMode = 'loading';
  let selectedContractId: string | null = null;
  let activeTab: string | null = null;
  let loadErrorMessage: string | null = null;
  let currentListCursor: string | undefined;
  let previousListCursors: Array<string | undefined> = [];
  let nextListCursor: string | null = null;
  let totalContractsOnTab = 0;
  let listPageBusy = false;
  let pendingPageFocus: 'previous' | 'next' | null = null;
  let suggestedRulesPanel: SuggestedRulesPanelMount | null = null;
  let scopedGrantPanel: ScopedGrantPanelMount | null = null;
  let connectPanel: PermissionsPanelMount | null = null;
  let detailGrantPanel: ContractGrantsPanelMount | null = null;
  let routeOwnedMutationCount = 0;

  const beginRouteOwnedMutation = (): (() => void) => {
    routeOwnedMutationCount += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      routeOwnedMutationCount = Math.max(0, routeOwnedMutationCount - 1);
    };
  };

  const hasContractsInFlightWork = (): boolean =>
    routeOwnedMutationCount > 0
    || suggestedRulesPanel?.hasInFlightWork() === true
    || scopedGrantPanel?.hasInFlightWork() === true
    || connectPanel?.hasInFlightWork() === true
    || detailGrantPanel?.hasInFlightWork() === true;

  const clearBody = (): void => {
    if (suggestedRulesPanel !== null) {
      suggestedRulesPanel.dispose();
      suggestedRulesPanel = null;
    }
    if (scopedGrantPanel !== null) {
      scopedGrantPanel.dispose();
      scopedGrantPanel = null;
    }
    if (connectPanel !== null) {
      connectPanel.dispose();
      connectPanel = null;
    }
    if (detailGrantPanel !== null) {
      detailGrantPanel.dispose();
      detailGrantPanel = null;
    }
    while (body.firstChild !== null) body.removeChild(body.firstChild);
  };

  // ── Proposals (ambient, dormant when empty) — list view only ──
  const mountProposals = (): void => {
    if (
      opts.suggestionsListCaller !== undefined
      && opts.suggestionsAcceptCaller !== undefined
      && opts.suggestionsDismissCaller !== undefined
    ) {
      const section = doc.createElement('section');
      section.setAttribute(CONTRACTS_ROUTE_PROPOSALS_ATTR, '');
      suggestedRulesPanel = mountSuggestedRulesPanel({
        host: section,
        document: doc,
        runListSuggestions: opts.suggestionsListCaller,
        runAcceptSuggestion: opts.suggestionsAcceptCaller,
        runDismissSuggestion: opts.suggestionsDismissCaller,
        // Names the door facet against the SAME `listContracts` this route
        // already lists contracts from, so a suggestion's door reads as the
        // exact string its inventory row shows. Absent ⇒ facet falls back to
        // the raw id.
        ...(opts.permissionsListContractsCaller !== undefined
          ? { runListContracts: opts.permissionsListContractsCaller }
          : {}),
        ...(opts.subscribe !== undefined ? { subscribe: opts.subscribe } : {}),
      });
      body.appendChild(section);
    }
    if (
      opts.scopedSuggestionsListCaller !== undefined
      && opts.scopedSuggestionsAcceptCaller !== undefined
      && opts.scopedSuggestionsDismissCaller !== undefined
    ) {
      const section = doc.createElement('section');
      section.setAttribute(CONTRACTS_ROUTE_PROPOSALS_ATTR, '');
      scopedGrantPanel = mountScopedGrantPanel({
        host: section,
        document: doc,
        runListSuggestions: opts.scopedSuggestionsListCaller,
        runAcceptSuggestion: opts.scopedSuggestionsAcceptCaller,
        runDismissSuggestion: opts.scopedSuggestionsDismissCaller,
        ...(opts.subscribe !== undefined ? { subscribe: opts.subscribe } : {}),
      });
      body.appendChild(section);
    }
  };

  // ── New-contract authoring flow ─────────────────────────────────────
  // A toggle button reveals a small mint form. The form is STATE-DRIVEN where
  // the fake DOM can't fire `change` (door toggles flip a draft + their own
  // `data-checked`); the text/number fields are read straight off the inputs at
  // submit. Mint → navigate to the fresh contract's DETAIL Connect tab; the
  // stateless route re-mounts there (no in-place swap). Grants start fail-closed
  // (a wildcard `scope: {}` with NO grant rows + a default-deny door token).
  const mountNewContractAction = (
    parent: HTMLElement,
    mintCaller: PermissionsMintContractCaller,
  ): void => {
    const wrap = makeEl(doc, 'div', 'contracts-new-wrap');

    const button = makeEl(
      doc,
      'button',
      'contracts-new-button',
      '+ New contract',
    );
    button.setAttribute('type', 'button');
    button.setAttribute(CONTRACTS_ROUTE_NEW_BUTTON_ATTR, '');
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-controls', 'recued-contracts-new-contract-form');
    wrap.appendChild(button);

    const form = makeEl(doc, 'div', 'contracts-new-form');
    form.setAttribute(CONTRACTS_ROUTE_NEW_FORM_ATTR, '');
    form.setAttribute('data-kind', 'contract');
    form.setAttribute('id', 'recued-contracts-new-contract-form');
    form.setAttribute('role', 'group');
    form.setAttribute('aria-label', 'New contract');

    const nameField = makeEl(doc, 'label', 'contracts-new-field');
    nameField.appendChild(makeEl(doc, 'span', undefined, 'Contract name'));
    const nameInput = makeEl(doc, 'input');
    nameInput.setAttribute('type', 'text');
    nameInput.setAttribute('placeholder', 'e.g. Shared research workspace');
    nameInput.setAttribute(CONTRACTS_ROUTE_NEW_NAME_ATTR, '');
    nameField.appendChild(nameInput);
    form.appendChild(nameField);

    const doorRow = makeEl(doc, 'div', 'contracts-new-doors');
    // D-207 — a `reception` door is DERIVED, never authored: `bindReceptionDoor` mints it
    // from a (form, recipe) pair, with a scope computed from what the recipe actually does
    // and a contract_id the pair row points at. A hand-minted one would have no pair
    // pointing at it, so no dispatch could ever resolve to it — an inert row that looks
    // like a live public door. Hence AUTHORABLE_DOOR_TYPES, not DOOR_TYPES.
    const doorDraft: Record<DoorType, boolean> = {
      mcp: false,
      mcp_chat: false,
      llm_gateway: false,
      reception: false,
      webhook: false,
    };
    for (const dt of AUTHORABLE_DOOR_TYPES) {
      const toggle = makeEl(doc, 'button', undefined, DOOR_TYPE_LABELS[dt]);
      toggle.setAttribute('type', 'button');
      toggle.setAttribute(CONTRACTS_ROUTE_NEW_DOOR_ATTR, '');
      toggle.setAttribute('data-door', dt);
      toggle.setAttribute('data-checked', 'false');
      toggle.setAttribute('aria-pressed', 'false');
      toggle.addEventListener('click', () => {
        doorDraft[dt] = !doorDraft[dt];
        toggle.setAttribute('data-checked', doorDraft[dt] ? 'true' : 'false');
        toggle.setAttribute('aria-pressed', doorDraft[dt] ? 'true' : 'false');
      });
      doorRow.appendChild(toggle);
    }
    form.appendChild(doorRow);

    const capField = makeEl(doc, 'label', 'contracts-new-field');
    capField.appendChild(makeEl(doc, 'span', undefined, 'Usage cap (optional)'));
    const capInput = makeEl(doc, 'input');
    capInput.setAttribute('type', 'number');
    capInput.setAttribute('min', '1');
    capInput.setAttribute('placeholder', 'unlimited');
    capInput.setAttribute(CONTRACTS_ROUTE_NEW_CAP_ATTR, '');
    capField.appendChild(capInput);
    form.appendChild(capField);

    const expiryField = makeEl(doc, 'label', 'contracts-new-field');
    expiryField.appendChild(makeEl(doc, 'span', undefined, 'Expiry (optional)'));
    const expiryInput = makeEl(doc, 'input');
    expiryInput.setAttribute('type', 'datetime-local');
    expiryInput.setAttribute(CONTRACTS_ROUTE_NEW_EXPIRY_ATTR, '');
    expiryField.appendChild(expiryInput);
    form.appendChild(expiryField);

    const error = makeEl(doc, 'p');
    error.setAttribute(CONTRACTS_ROUTE_NEW_ERROR_ATTR, '');
    error.setAttribute('role', 'alert');
    error.setAttribute('aria-live', 'polite');
    form.appendChild(error);

    const submit = makeEl(doc, 'button', 'contracts-new-submit', 'Create contract');
    submit.setAttribute('type', 'button');
    submit.setAttribute(CONTRACTS_ROUTE_NEW_SUBMIT_ATTR, '');
    form.appendChild(submit);

    const setError = (msg: string | null): void => {
      error.textContent = msg ?? '';
    };

    let submitting = false;
    let formOpen = false;
    button.addEventListener('click', () => {
      if (submitting) return;
      formOpen = !formOpen;
      button.setAttribute('aria-expanded', formOpen ? 'true' : 'false');
      button.textContent = formOpen ? 'Cancel new contract' : '+ New contract';
      if (formOpen) {
        wrap.appendChild(form);
        nameInput.focus({ preventScroll: true });
      } else {
        form.remove();
      }
    });

    const doSubmit = async (): Promise<void> => {
      if (submitting) return;
      const name = nameInput.value.trim();
      if (name.length === 0) {
        setError('Enter a name for the contract.');
        nameInput.focus({ preventScroll: true });
        return;
      }
      const doorTypes = AUTHORABLE_DOOR_TYPES.filter((dt) => doorDraft[dt]);
      const capRaw = capInput.value.trim();
      let cap: number | undefined;
      if (capRaw.length > 0) {
        cap = Number(capRaw);
        if (!Number.isInteger(cap) || cap <= 0) {
          setError('Usage cap must be a positive whole number.');
          capInput.focus({ preventScroll: true });
          return;
        }
      }
      const expiryRaw = expiryInput.value.trim();
      let expiry: number | undefined;
      if (expiryRaw.length > 0) {
        const parsed = Date.parse(expiryRaw);
        if (Number.isNaN(parsed)) {
          setError('Enter a valid expiry date.');
          expiryInput.focus({ preventScroll: true });
          return;
        }
        expiry = parsed;
      }

      setError(null);
      submitting = true;
      submit.textContent = 'Creating…';
      submit.setAttribute('aria-disabled', 'true');
      submit.setAttribute('aria-busy', 'true');
      button.setAttribute('aria-disabled', 'true');
      const releaseOwnership = beginRouteOwnedMutation();
      try {
        const request: MintContractRequest = {
          display_name: name,
          scope: {},
          ...(doorTypes.length > 0 ? { door_types: doorTypes } : {}),
          ...(cap !== undefined ? { max_uses: cap } : {}),
          ...(expiry !== undefined ? { expiry_at: expiry } : {}),
        };
        const view = await mintCaller(request);
        // The mint is durable before its intentional detail handoff. Release
        // the leave guard so that handoff does not confirm against itself.
        releaseOwnership();
        if (disposed) return;
        navigate(serializeShellRoute('contracts', view.contract_id, 'connect'));
      } catch (err) {
        if (disposed) return;
        submitting = false;
        submit.textContent = 'Create contract';
        submit.removeAttribute('aria-disabled');
        submit.removeAttribute('aria-busy');
        button.removeAttribute('aria-disabled');
        setError(errMessage(err));
        submit.focus({ preventScroll: true });
      } finally {
        releaseOwnership();
      }
    };
    submit.addEventListener('click', () => {
      void doSubmit();
    });

    parent.appendChild(wrap);
  };

  const renderList = (): void => {
    clearBody();
    viewMode = 'list';
    selectedContractId = null;
    activeTab = null;

    const intro = makeEl(
      doc,
      'p',
      'contracts-section-copy contracts-intro',
      'Contracts define who or what can reach Recued and which tools or data '
        + 'that access can use.',
    );
    body.appendChild(intro);

    const listTabs = makeEl(doc, 'nav', 'contracts-list-tabs');
    listTabs.setAttribute('role', 'tablist');
    listTabs.setAttribute('aria-label', 'Contract categories');
    listTabs.setAttribute('aria-orientation', 'horizontal');
    const tabLabels: Record<ContractsListTab, string> = {
      'built-in': 'Built-in',
      customer: 'Customer',
      others: 'Others',
    };
    const tabLinks: Array<{
      id: ContractsListTab;
      link: HTMLAnchorElement;
    }> = [];
    for (const tab of CONTRACTS_LIST_TABS) {
      const link = doc.createElement('a');
      link.setAttribute(CONTRACTS_ROUTE_LIST_TAB_ATTR, '');
      link.setAttribute('data-tab', tab);
      link.setAttribute('role', 'tab');
      link.setAttribute('id', listTabId(tab));
      link.setAttribute('aria-controls', CONTRACTS_LIST_PANEL_ID);
      link.setAttribute('href', listTabRoute(tab));
      link.setAttribute('aria-selected', tab === activeListTab ? 'true' : 'false');
      link.setAttribute('tabindex', tab === activeListTab ? '0' : '-1');
      if (tab === activeListTab) link.setAttribute('aria-current', 'page');
      link.textContent = tabLabels[tab];
      link.addEventListener('click', (event) => {
        const click = event as MouseEvent | undefined;
        if (
          tab === activeListTab
          || hasContractsInFlightWork()
          || (
            click !== undefined
            && (
              click.button !== 0
              || click.metaKey
              || click.ctrlKey
              || click.altKey
              || click.shiftKey
            )
          )
        ) {
          return;
        }
        pendingListTabFocusByDocument.set(doc, tab);
      });
      link.addEventListener('keydown', (event) => {
        const currentIndex = tabLinks.findIndex((entry) => entry.id === tab);
        if (currentIndex < 0) return;
        let nextIndex: number | null = null;
        if (event.key === 'ArrowRight') {
          nextIndex = (currentIndex + 1) % tabLinks.length;
        } else if (event.key === 'ArrowLeft') {
          nextIndex = (currentIndex - 1 + tabLinks.length) % tabLinks.length;
        } else if (event.key === 'Home') {
          nextIndex = 0;
        } else if (event.key === 'End') {
          nextIndex = tabLinks.length - 1;
        }
        if (nextIndex === null) return;
        event.preventDefault();
        tabLinks[nextIndex]!.link.click();
      });
      tabLinks.push({ id: tab, link });
      listTabs.appendChild(link);
    }
    body.appendChild(listTabs);

    if (loadErrorMessage !== null) {
      const note = makeEl(
        doc,
        'p',
        undefined,
        `Some contracts could not be loaded: ${loadErrorMessage}`,
      );
      note.setAttribute(CONTRACTS_ROUTE_ERROR_ATTR, '');
      body.appendChild(note);
    }

    const appendRows = (
      list: HTMLElement,
      listRows: ReadonlyArray<ContractRowVM>,
    ): void => {
      for (const row of listRows) {
        const li = doc.createElement('li');
        const anchor = doc.createElement('a');
        anchor.setAttribute(CONTRACTS_ROUTE_ROW_ATTR, '');
        anchor.setAttribute(CONTRACTS_ROUTE_ROW_ID_ATTR, row.contract_id);
        anchor.setAttribute(
          'href',
          serializeShellRoute('contracts', row.contract_id),
        );
        if (anonymousDoorType(row) !== null) {
          anchor.setAttribute(CONTRACTS_ROUTE_ANONYMOUS_ATTR, '');
        }

        anchor.appendChild(
          makeEl(doc, 'span', 'contracts-row-name', row.display_name),
        );
        appendBadgeAndPill(doc, anchor, row);
        anchor.appendChild(
          makeEl(doc, 'span', 'contracts-row-meta', limitsSummary(row)),
        );

        li.appendChild(anchor);
        list.appendChild(li);
      }
    };

    const panel = makeEl(doc, 'section', 'contracts-inventory-section');
    panel.setAttribute(CONTRACTS_ROUTE_LIST_PANEL_ATTR, '');
    panel.setAttribute('data-tab', activeListTab);
    panel.setAttribute('id', CONTRACTS_LIST_PANEL_ID);
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', listTabId(activeListTab));

    const appendPager = (
      host: HTMLElement,
      emptyStatus: string,
      itemSuffix = '',
    ): void => {
      const pager = makeEl(doc, 'div');
      pager.setAttribute(CONTRACTS_ROUTE_PAGER_ATTR, '');
      const status = makeEl(doc, 'span');
      status.setAttribute(CONTRACTS_ROUTE_PAGE_STATUS_ATTR, '');
      const pageStart = previousListCursors.length * CONTRACTS_ROUTE_PAGE_SIZE;
      const pageEnd = pageStart + rows.length;
      const hasPageNavigation = previousListCursors.length > 0
        || nextListCursor !== null;
      status.textContent = rows.length === 0
        ? `${emptyStatus}${hasPageNavigation ? ' on this page' : ''}`
        : `Showing ${pageStart + 1}–${pageEnd} of ${Math.max(
            totalContractsOnTab,
            pageEnd,
          )}${itemSuffix}`;
      pager.appendChild(status);

      const previousOwnsLoad = listPageBusy && pendingPageFocus === 'previous';
      const previous = makeEl(
        doc,
        'button',
        undefined,
        previousOwnsLoad ? 'Loading…' : 'Previous',
      );
      previous.setAttribute('type', 'button');
      previous.setAttribute(CONTRACTS_ROUTE_PAGE_PREVIOUS_ATTR, '');
      if (previousOwnsLoad) {
        previous.setAttribute('aria-label', 'Loading previous page');
        previous.setAttribute('aria-disabled', 'true');
        previous.setAttribute('aria-busy', 'true');
      } else if (listPageBusy || previousListCursors.length === 0) {
        previous.setAttribute('disabled', '');
      } else {
        previous.addEventListener('click', () => {
          if (listPageBusy) return;
          pendingPageFocus = 'previous';
          const prior = previousListCursors[previousListCursors.length - 1];
          void loadListPage(prior, 'previous');
        });
      }
      pager.appendChild(previous);

      const nextOwnsLoad = listPageBusy && pendingPageFocus === 'next';
      const next = makeEl(
        doc,
        'button',
        undefined,
        nextOwnsLoad ? 'Loading…' : 'Next',
      );
      next.setAttribute('type', 'button');
      next.setAttribute(CONTRACTS_ROUTE_PAGE_NEXT_ATTR, '');
      if (nextOwnsLoad) {
        next.setAttribute('aria-label', 'Loading next page');
        next.setAttribute('aria-disabled', 'true');
        next.setAttribute('aria-busy', 'true');
      } else if (listPageBusy || nextListCursor === null) {
        next.setAttribute('disabled', '');
      } else {
        next.addEventListener('click', () => {
          if (listPageBusy) return;
          pendingPageFocus = 'next';
          void loadListPage(nextListCursor ?? undefined, 'next');
        });
      }
      pager.appendChild(next);
      host.appendChild(pager);
    };

    if (activeListTab === 'built-in') {
      panel.appendChild(
        makeEl(doc, 'h2', 'contracts-section-title', 'Built-in contracts'),
      );
      panel.appendChild(
        makeEl(
          doc,
          'p',
          'contracts-section-copy',
          'Owner always exists. Public-form and webhook contracts are created '
            + 'by their owning features; edit their tool and data grants here.',
        ),
      );
      const list = makeEl(doc, 'ul');
      list.setAttribute(CONTRACTS_ROUTE_LIST_ATTR, '');
      appendRows(list, [SELF_ROW, ...rows]);
      panel.appendChild(list);
      appendPager(panel, 'No managed access contracts', ' managed contracts');
    } else {
      const isCustomer = activeListTab === 'customer';
      panel.appendChild(
        makeEl(
          doc,
          'h2',
          'contracts-section-title',
          isCustomer ? 'Customer templates' : 'Other contracts',
        ),
      );
      panel.appendChild(
        makeEl(
          doc,
          'p',
          'contracts-section-copy',
          isCustomer
            ? 'Templates define the tool and data grants stamped into customer '
              + 'access. Issued customer contracts stay in Seller.'
            : 'Contracts for agents, applications, shared credentials, and any '
              + 'other access to Recued.',
        ),
      );
      if (isCustomer) {
        const sellerLink = doc.createElement('a');
        sellerLink.className = 'contracts-link';
        sellerLink.setAttribute('href', serializeShellRoute('settings', 'seller'));
        sellerLink.textContent = 'Open Seller →';
        panel.appendChild(sellerLink);
      } else if (
        opts.permissionsMintContractCaller !== undefined
        && opts.contractsListCaller !== undefined
      ) {
        mountNewContractAction(panel, opts.permissionsMintContractCaller);
      }

      if (rows.length === 0) {
        panel.appendChild(
          makeEl(
            doc,
            'p',
            'contracts-section-copy',
            isCustomer
              ? 'No customer templates yet.'
              : 'No other contracts on this page.',
          ),
        );
      } else {
        const list = makeEl(doc, 'ul');
        list.setAttribute(CONTRACTS_ROUTE_LIST_ATTR, '');
        appendRows(list, rows);
        panel.appendChild(list);
      }

      appendPager(
        panel,
        isCustomer ? 'No customer templates' : 'No other contracts',
      );
    }

    body.appendChild(panel);

    // Staged-trust proposals are user decisions, not contract inventory. Keep
    // their existing dormant-when-empty behavior after the active inventory.
    mountProposals();

    const requestedTabFocus = pendingListTabFocusByDocument.get(doc);
    if (requestedTabFocus !== undefined) {
      pendingListTabFocusByDocument.delete(doc);
    }
    if (requestedTabFocus === activeListTab) {
      tabLinks.find((entry) => entry.id === activeListTab)?.link.focus({
        preventScroll: true,
      });
      return;
    }

    const returnFocusId = pendingListFocusByDocument.get(doc);
    if (returnFocusId !== undefined) {
      pendingListFocusByDocument.delete(doc);
      const returnRow = Array.from(body.querySelectorAll(
        `[${CONTRACTS_ROUTE_ROW_ATTR}]`,
      )).find((candidate) =>
        candidate.getAttribute(CONTRACTS_ROUTE_ROW_ID_ATTR) === returnFocusId,
      ) as HTMLElement | undefined;
      if (returnRow !== undefined) {
        returnRow.focus({ preventScroll: true });
      } else {
        heading.setAttribute('tabindex', '-1');
        heading.focus({ preventScroll: true });
      }
    } else if (pendingPageFocus !== null && listPageBusy) {
      const attr = pendingPageFocus === 'previous'
        ? CONTRACTS_ROUTE_PAGE_PREVIOUS_ATTR
        : CONTRACTS_ROUTE_PAGE_NEXT_ATTR;
      const owner = body.querySelector(`[${attr}]`) as HTMLElement | null;
      owner?.focus({ preventScroll: true });
    } else if (pendingPageFocus !== null) {
      const requestedDirection = pendingPageFocus;
      pendingPageFocus = null;
      const findEnabledPageControl = (
        direction: 'previous' | 'next',
      ): HTMLElement | null => {
        const attr = direction === 'previous'
          ? CONTRACTS_ROUTE_PAGE_PREVIOUS_ATTR
          : CONTRACTS_ROUTE_PAGE_NEXT_ATTR;
        const control = body.querySelector(`[${attr}]`) as HTMLElement | null;
        return control?.getAttribute('disabled') === null ? control : null;
      };
      const oppositeDirection = requestedDirection === 'previous'
        ? 'next'
        : 'previous';
      const control = findEnabledPageControl(requestedDirection)
        ?? findEnabledPageControl(oppositeDirection);
      const firstRow = body.querySelector(
        `[${CONTRACTS_ROUTE_ROW_ATTR}]`,
      ) as HTMLElement | null;
      const target = control ?? firstRow ?? heading;
      if (target === heading) heading.setAttribute('tabindex', '-1');
      target.focus({ preventScroll: true });
    }
  };

  const markPageRequestBusy = (
    direction: 'next' | 'previous',
  ): void => {
    const ownerAttr = direction === 'previous'
      ? CONTRACTS_ROUTE_PAGE_PREVIOUS_ATTR
      : CONTRACTS_ROUTE_PAGE_NEXT_ATTR;
    const siblingAttr = direction === 'previous'
      ? CONTRACTS_ROUTE_PAGE_NEXT_ATTR
      : CONTRACTS_ROUTE_PAGE_PREVIOUS_ATTR;
    const owner = body.querySelector(`[${ownerAttr}]`) as HTMLElement | null;
    const sibling = body.querySelector(`[${siblingAttr}]`) as HTMLElement | null;
    if (owner !== null) {
      owner.textContent = 'Loading…';
      owner.setAttribute(
        'aria-label',
        direction === 'previous' ? 'Loading previous page' : 'Loading next page',
      );
      owner.setAttribute('aria-disabled', 'true');
      owner.setAttribute('aria-busy', 'true');
      owner.focus({ preventScroll: true });
    }
    sibling?.setAttribute('disabled', '');
  };

  // The contract-credential (mcp-door) panel lives in the Connect tab. Only
  // reached behind the contract-credential gate (the door lifecycle trio), so the
  // three callers are cast to their non-optional caller types; every other
  // caller is forwarded when present (graceful degrade), mirroring the
  // production wiring from `webclient-bootstrap.ts`.
  const mountContractCredentialPanel = (
    panelHost: HTMLElement,
  ): PermissionsPanelMount =>
    mountPermissionsPanel({
      host: panelHost,
      document: doc,
      surface: 'contracts-detail',
      runListInboundTokens:
        opts.permissionsListInboundTokensCaller as PermissionsListInboundTokensCaller,
      runIssueInboundToken:
        opts.permissionsIssueInboundTokenCaller as PermissionsIssueInboundTokenCaller,
      runRevokeInboundToken:
        opts.permissionsRevokeInboundTokenCaller as PermissionsRevokeInboundTokenCaller,
      ...(opts.permissionsListOverridesCaller !== undefined
        && opts.permissionsDeleteOverrideCaller !== undefined
        ? {
            runListOverrides: opts.permissionsListOverridesCaller,
            runDeleteOverride: opts.permissionsDeleteOverrideCaller,
          }
        : {}),
      ...(opts.permissionsUpsertOverrideCaller !== undefined
        ? { runUpsertOverride: opts.permissionsUpsertOverrideCaller }
        : {}),
      ...(opts.permissionsListCatalogOperationsCaller !== undefined
        ? { runListCatalogOperations: opts.permissionsListCatalogOperationsCaller }
        : {}),
      ...(opts.permissionsUpdateInboundTokenCaller !== undefined
        ? { runUpdateInboundToken: opts.permissionsUpdateInboundTokenCaller }
        : {}),
      ...(opts.permissionsToolCatalogCaller !== undefined
        ? { runListToolCatalog: opts.permissionsToolCatalogCaller }
        : {}),
      ...(opts.permissionsMintContractCaller !== undefined
        && opts.permissionsRevokeContractCaller !== undefined
        && opts.permissionsListContractsCaller !== undefined
        && opts.permissionsUpdateInboundContractCaller !== undefined
        ? {
            runMintContract: opts.permissionsMintContractCaller,
            runRevokeContract: opts.permissionsRevokeContractCaller,
            runListContracts: opts.permissionsListContractsCaller,
            runUpdateInboundContract: opts.permissionsUpdateInboundContractCaller,
          }
        : {}),
      ...(opts.now !== undefined ? { now: opts.now } : {}),
      ...(opts.subscribe !== undefined ? { subscribe: opts.subscribe } : {}),
    });

  const renderDetail = (row: ContractRowVM): void => {
    clearBody();
    viewMode = 'detail';
    selectedContractId = row.contract_id;

    const detail = doc.createElement('section');
    detail.setAttribute(CONTRACTS_ROUTE_DETAIL_ATTR, '');
    detail.setAttribute(CONTRACTS_ROUTE_ROW_ID_ATTR, row.contract_id);

    const back = doc.createElement('a');
    back.setAttribute(CONTRACTS_ROUTE_BACK_ATTR, '');
    const parentListTab = listTabForRow(row);
    back.setAttribute('href', listTabRoute(parentListTab));
    back.textContent = `← Back to ${
      parentListTab === 'built-in'
        ? 'Built-in contracts'
        : parentListTab === 'customer'
          ? 'Customer contracts'
          : 'Other contracts'
    }`;
    back.addEventListener('click', (event) => {
      const click = event as MouseEvent | undefined;
      if (
        click !== undefined
        && (
          click.button !== 0
          || click.metaKey
          || click.ctrlKey
          || click.altKey
          || click.shiftKey
        )
      ) {
        return;
      }
      pendingListFocusByDocument.set(doc, row.contract_id);
    });
    detail.appendChild(back);

    // A degraded load still opens a targeted contract's DETAIL (self is always
    // synthesized), so surface the non-blocking load error here too — never
    // only on the LIST path.
    if (loadErrorMessage !== null) {
      const note = makeEl(
        doc,
        'p',
        undefined,
        `Some contracts could not be loaded: ${loadErrorMessage}`,
      );
      note.setAttribute(CONTRACTS_ROUTE_ERROR_ATTR, '');
      detail.appendChild(note);
    }

    // ── R12 header (re-renderable in place) ──
    // The L1 door toggle + Revoke mutate this contract's state, so the header
    // RE-RENDERS itself (`paintHead`) on each write — NOT the whole DETAIL — so
    // the kept-alive tab bodies (the Connect token, the grant panel) survive. The
    // route is stateless (no live list), so the local `currentRow` is the only
    // place to reflect a door/revoke edit until a Back-link remount reloads.
    let currentRow = row;
    let doorBusy = false;
    let doorBusyType: DoorType | null = null;
    let revokeBusy = false;
    let revokeArmed = false;
    let headError: string | null = null;
    let pendingHeadFocusAttr: string | null = null;

    // Only ordinary contracts expose generic door and revoke controls.
    // Seller templates use this detail strictly for grant authoring; Seller
    // owns their door/tier lifecycle. Derived anonymous doors open this detail
    // for grants, while Reception/Webhooks retain their lifecycle controls.
    // Keep the edit predicate a function of currentRow so a server echo cannot
    // leave stale controls alive after a door update.
    const canEditDoors = (): boolean =>
      !currentRow.is_self
      && !isCustomerTemplateRow(currentRow)
      && anonymousDoorType(currentRow) === null
      && opts.grantSetDoorTypesCaller !== undefined;
    const canRevoke =
      !currentRow.is_self
      && !isCustomerTemplateRow(currentRow)
      && anonymousDoorType(currentRow) === null
      && opts.contractsRevokeCaller !== undefined;

    const head = makeEl(doc, 'div', 'contracts-detail-head');
    let detailHeading: HTMLElement | null = null;

    /** Toggle one L1 door type via `setDoorTypes`, then reconcile `currentRow`
     *  from the authoritative response. Refuses to empty the backed set (a door
     *  must back ≥1 type). */
    const runSetDoor = async (doorType: DoorType): Promise<void> => {
      const setter = opts.grantSetDoorTypesCaller;
      if (setter === undefined || doorBusy) return;
      const next = nextDoorTypes(currentRow.door_types, doorType);
      if (next === null) return; // would back nothing — a door must back ≥1 type.
      doorBusy = true;
      doorBusyType = doorType;
      headError = null;
      const releaseOwnership = beginRouteOwnedMutation();
      paintHead();
      try {
        const updated = await setter({
          contract_id: currentRow.contract_id,
          door_types: next,
        });
        if (disposed) return;
        // Reflect the new backed set: prefer the server's echo, else the `next`
        // we asked for. A wildcard "backs all" is sent as `[]`, which a server
        // may echo as an OMITTED `door_types` — falling back to `next` keeps the
        // toggle from preserving the stale subset.
        currentRow = { ...currentRow, door_types: updated.door_types ?? next };
      } catch (err) {
        if (disposed) return;
        headError = `Could not update the door: ${errMessage(err)}`;
      } finally {
        doorBusy = false;
        doorBusyType = null;
        releaseOwnership();
        if (!disposed) paintHead();
      }
    };

    /** Revoke this contract (commit of the 2-stage confirm). The rpc is
     *  authoritative for the state now, so flip `currentRow` to revoked — the
     *  pill reads Revoked and the door/revoke controls drop on `paintHead`. */
    const runRevoke = async (): Promise<void> => {
      const revoke = opts.contractsRevokeCaller;
      if (revoke === undefined || revokeBusy) return;
      revokeBusy = true;
      revokeArmed = false;
      headError = null;
      const releaseOwnership = beginRouteOwnedMutation();
      paintHead();
      try {
        const revoked = await revoke({ contract_id: currentRow.contract_id });
        if (disposed) return;
        currentRow = { ...currentRow, lifecycle_state: revoked.lifecycle_state };
      } catch (err) {
        if (disposed) return;
        headError = `Could not revoke: ${errMessage(err)}`;
      } finally {
        revokeBusy = false;
        releaseOwnership();
        if (!disposed) paintHead();
      }
    };

    const appendDoorControls = (host: HTMLElement): void => {
      const wrap = makeEl(doc, 'span', 'contracts-door');
      wrap.appendChild(makeEl(doc, 'span', 'contracts-door-label', 'Door'));
      const backedCount = backedDoorTypes(currentRow.door_types).length;
      // AUTHORABLE_DOOR_TYPES, not DOOR_TYPES — the same rule the slice-1c
      // note above documents for the toggle MATH. Rendering reception/webhook
      // checkboxes here handed a human a control that either narrowed a
      // wildcard ordinary contract behind their back or (on a derived door, now
      // unreachable via `canEditDoors`) replaced its door-class binding.
      for (const dt of AUTHORABLE_DOOR_TYPES) {
        const backed = doorTypeBacked(currentRow.door_types, dt);
        const label = makeEl(doc, 'label', 'contracts-door-toggle');
        label.setAttribute(CONTRACTS_ROUTE_DOOR_TOGGLE_ATTR, '');
        label.setAttribute('data-door', dt);
        label.setAttribute('data-backed', backed ? 'true' : 'false');
        const input = doc.createElement('input');
        input.setAttribute('type', 'checkbox');
        input.setAttribute('data-door', dt);
        input.checked = backed;
        // Lock the only-backed type (un-backing it would empty the set; `[]`
        // means wildcard, not "backs nothing"). Disabled while a write runs.
        const lockLast = backed && backedCount === 1;
        if (doorBusy) {
          if (doorBusyType === dt) {
            input.setAttribute('aria-disabled', 'true');
            input.setAttribute('aria-busy', 'true');
          } else {
            input.setAttribute('disabled', '');
          }
        } else if (lockLast) {
          input.setAttribute('disabled', '');
        } else {
          input.addEventListener('change', () => {
            void runSetDoor(dt);
          });
        }
        label.appendChild(input);
        label.appendChild(
          makeEl(doc, 'span', 'contracts-door-name', DOOR_TYPE_LABELS[dt]),
        );
        wrap.appendChild(label);
      }
      host.appendChild(wrap);
    };

    const appendRevokeControl = (host: HTMLElement): void => {
      const wrap = makeEl(doc, 'span', 'contracts-revoke-wrap');
      if (revokeBusy) {
        const btn = makeEl(doc, 'button', undefined, 'Revoking…');
        btn.setAttribute('type', 'button');
        btn.setAttribute(CONTRACTS_ROUTE_REVOKE_ATTR, '');
        btn.setAttribute('aria-disabled', 'true');
        btn.setAttribute('aria-busy', 'true');
        wrap.appendChild(btn);
      } else if (revokeArmed) {
        wrap.appendChild(
          makeEl(doc, 'span', 'contracts-revoke-prompt', 'Revoke contract?'),
        );
        const confirm = makeEl(doc, 'button', undefined, 'Confirm');
        confirm.setAttribute('type', 'button');
        confirm.setAttribute(CONTRACTS_ROUTE_REVOKE_CONFIRM_ATTR, '');
        confirm.addEventListener('click', () => {
          pendingHeadFocusAttr = CONTRACTS_ROUTE_REVOKE_ATTR;
          void runRevoke();
        });
        wrap.appendChild(confirm);
        const cancel = makeEl(doc, 'button', undefined, 'Cancel');
        cancel.setAttribute('type', 'button');
        cancel.setAttribute(CONTRACTS_ROUTE_REVOKE_CANCEL_ATTR, '');
        cancel.addEventListener('click', () => {
          pendingHeadFocusAttr = CONTRACTS_ROUTE_REVOKE_ATTR;
          revokeArmed = false;
          paintHead();
        });
        wrap.appendChild(cancel);
      } else {
        const btn = makeEl(doc, 'button', undefined, 'Revoke');
        btn.setAttribute('type', 'button');
        btn.setAttribute(CONTRACTS_ROUTE_REVOKE_ATTR, '');
        btn.addEventListener('click', () => {
          pendingHeadFocusAttr = CONTRACTS_ROUTE_REVOKE_CONFIRM_ATTR;
          revokeArmed = true;
          paintHead();
        });
        wrap.appendChild(btn);
      }
      host.appendChild(wrap);
    };

    // A `const` arrow (not a hoisted `function`) so the outer `doc` narrowing
    // carries in; the helpers above reference it only in deferred callbacks (the
    // grant-matrix `renderCell` → `runToggleEntry` forward-ref precedent).
    const paintHead = (): HTMLElement => {
      const headingOwnedFocus = doc.activeElement === detailHeading;
      const activeHeadElement = doc.activeElement as HTMLElement | null;
      const focusedDoorTypeRaw = activeHeadElement?.tagName === 'INPUT'
        ? activeHeadElement.getAttribute('data-door')
        : null;
      const focusedDoorType = focusedDoorTypeRaw !== null
        && AUTHORABLE_DOOR_TYPES.some((doorType) =>
          doorType === focusedDoorTypeRaw)
        ? focusedDoorTypeRaw
        : null;
      const focusedHeadAttr = [
        CONTRACTS_ROUTE_REVOKE_ATTR,
        CONTRACTS_ROUTE_REVOKE_CONFIRM_ATTR,
        CONTRACTS_ROUTE_REVOKE_CANCEL_ATTR,
      ].find((attr) =>
        activeHeadElement !== null
        && activeHeadElement.getAttribute(attr) !== null,
      ) ?? null;
      const requestedHeadFocusAttr = pendingHeadFocusAttr ?? focusedHeadAttr;
      pendingHeadFocusAttr = null;
      clearChildren(head);
      const nextDetailHeading = makeEl(
        doc,
        'h2',
        'contracts-detail-name',
        currentRow.display_name,
      );
      nextDetailHeading.setAttribute(
        CONTRACTS_ROUTE_DETAIL_HEADING_ATTR,
        currentRow.contract_id,
      );
      nextDetailHeading.setAttribute('tabindex', '-1');
      detailHeading = nextDetailHeading;
      head.appendChild(nextDetailHeading);
      appendBadgeAndPill(doc, head, currentRow);
      // L1 door open/close — editable only for an ACTIVE ordinary contract (a non-active
      // door can't dispatch, so its door types are moot).
      if (canEditDoors() && currentRow.lifecycle_state === 'active') {
        appendDoorControls(head);
      }
      const spacer = makeEl(doc, 'span', 'contracts-detail-spacer');
      head.appendChild(spacer);
      head.appendChild(
        makeEl(doc, 'span', 'contracts-detail-limits', limitsSummary(currentRow)),
      );
      // Revoke kill-switch — any non-revoked ordinary contract (mirrors
      // `contracts-panel.ts`: an expired/exhausted one is still explicitly
      // revocable; a revoked one has nothing left to revoke).
      if (canRevoke && currentRow.lifecycle_state !== 'revoked') {
        appendRevokeControl(head);
      }
      const activityLink = doc.createElement('a');
      activityLink.className = 'contracts-link';
      activityLink.setAttribute(CONTRACTS_ROUTE_ACTIVITY_LINK_ATTR, '');
      activityLink.setAttribute('href', serializeShellRoute('logs'));
      activityLink.textContent = 'Recent activity → Log';
      head.appendChild(activityLink);
      if (headError !== null) {
        const chip = makeEl(doc, 'p', undefined, headError);
        chip.setAttribute(CONTRACTS_ROUTE_HEAD_ERROR_ATTR, '');
        head.appendChild(chip);
      }
      if (requestedHeadFocusAttr !== null) {
        const nextControl = head.querySelector(
          `[${requestedHeadFocusAttr}]`,
        ) as HTMLElement | null;
        (nextControl ?? nextDetailHeading).focus({ preventScroll: true });
      } else if (focusedDoorType !== null) {
        const nextDoorInput = Array.from(head.querySelectorAll('input')).find(
          (input) => input.getAttribute('data-door') === focusedDoorType,
        ) as HTMLElement | undefined;
        (nextDoorInput ?? nextDetailHeading).focus({ preventScroll: true });
      } else if (headingOwnedFocus) {
        nextDetailHeading.focus({ preventScroll: true });
      }
      return nextDetailHeading;
    };

    detail.appendChild(head);
    const initialDetailHeading = paintHead();

    // ── tab strip ──
    const tabs = tabsFor(row);
    // The deep-link tab segment (`#contracts/<id>/<tab>`) seeds the landing tab
    // when valid; otherwise the first tab. The new-contract flow lands on
    // `connect` (an ordinary contract's first tab).
    const wantedTab = opts.initialContractTab;
    activeTab =
      wantedTab !== undefined && tabs.some((t) => t.id === wantedTab)
        ? wantedTab
        : (tabs[0]?.id ?? null);
    const tabStrip = makeEl(doc, 'nav', 'contracts-tabs');
    tabStrip.setAttribute('role', 'tablist');
    tabStrip.setAttribute('aria-orientation', 'horizontal');
    tabStrip.setAttribute('aria-label', `${row.display_name} sections`);
    const tabBody = doc.createElement('div');
    tabBody.setAttribute(CONTRACTS_ROUTE_TAB_BODY_ATTR, '');
    tabBody.setAttribute('id', 'recued-contracts-detail-tabpanel');
    tabBody.setAttribute('role', 'tabpanel');

    // The Connect tab's content (snippets + the contract-credential panel) is built
    // ONCE and kept alive across tab switches — selectTab re-attaches it rather
    // than rebuilding, so a just-revealed one-time token survives a round-trip
    // to Ops/Entities. Disposed in `clearBody` when the DETAIL is torn down.
    let connectHost: HTMLElement | null = null;
    const ensureConnectHost = (): HTMLElement => {
      if (connectHost !== null) return connectHost;
      const host = doc.createElement('div');
      host.setAttribute(CONTRACTS_ROUTE_CONNECT_HOST_ATTR, '');
      host.appendChild(
        makeEl(
          doc,
          'p',
          'contracts-section-copy',
          'Give this contract a way to reach Recued: use a connection link and '
            + 'one-time access code, then grant the tools and data it may use.',
        ),
      );
      const grid = makeEl(doc, 'div', 'contracts-snippet-grid');
      for (const snippet of buildMcpClientSnippets(opts.serverUrl)) {
        appendSnippet(doc, grid, snippet);
      }
      host.appendChild(grid);
      if (canMountContractCredential) {
        const panelHost = doc.createElement('div');
        host.appendChild(panelHost);
        connectPanel = mountContractCredentialPanel(panelHost);
      } else {
        const note = makeEl(
          doc,
          'div',
          undefined,
          'Connecting this contract is not available on this server yet.',
        );
        note.setAttribute(CONTRACTS_ROUTE_UNAVAILABLE_ATTR, '');
        host.appendChild(note);
      }
      connectHost = host;
      return host;
    };

    // The Ops + Entities tabs share ONE single-contract grant view — it loads
    // the universe + this contract's grant rows once and renders both its
    // `opsRoot` (op grants) + `entitiesRoot` (collection + topic grants). Built
    // ONCE per DETAIL + kept alive across tab switches (the connect-host idiom),
    // so a switch never reloads and a just-toggled cell stays correct. Needs the
    // read + write grant callers; absent ⇒ the tabs fall back to a descriptor.
    const canMountGrants =
      opts.grantReadCaller !== undefined && opts.grantWriteCaller !== undefined;
    const ensureGrantPanel = (): ContractGrantsPanelMount | null => {
      if (!canMountGrants) return null;
      if (detailGrantPanel !== null) return detailGrantPanel;
      detailGrantPanel = mountContractGrantsPanel({
        document: doc,
        contractId: row.contract_id,
        ...(isCustomerTemplateRow(row) || anonymousDoorType(row) !== null
          ? { explicitGrantRowsOnly: true }
          : {}),
        runGrantRead: opts.grantReadCaller as GrantReadCaller,
        runGrantWrite: opts.grantWriteCaller as GrantWriteCaller,
        ...(opts.grantCatalogOperationsCaller !== undefined
          ? { runCatalogOperations: opts.grantCatalogOperationsCaller }
          : {}),
        ...(opts.grantRegistryDescribeCaller !== undefined
          ? { runRegistryDescribe: opts.grantRegistryDescribeCaller }
          : {}),
        ...(opts.grantCliReachabilityListCaller !== undefined
          ? { runCliReachabilityList: opts.grantCliReachabilityListCaller }
          : {}),
        ...(opts.grantCliReachabilitySetCaller !== undefined
          ? { runCliReachabilitySet: opts.grantCliReachabilitySetCaller }
          : {}),
        ...(opts.operationFilterDebounceMs !== undefined
          ? { operationFilterDebounceMs: opts.operationFilterDebounceMs }
          : {}),
        ...(opts.subscribe !== undefined ? { subscribe: opts.subscribe } : {}),
      });
      return detailGrantPanel;
    };

    const tabButtons: Array<{ id: string; btn: HTMLButtonElement }> = [];
    const selectTab = (id: string): void => {
      activeTab = id;
      for (const entry of tabButtons) {
        const selected = entry.id === id;
        entry.btn.setAttribute(
          'aria-selected',
          selected ? 'true' : 'false',
        );
        entry.btn.setAttribute('tabindex', selected ? '0' : '-1');
        if (selected) {
          tabBody.setAttribute(
            'aria-labelledby',
            entry.btn.getAttribute('id') ?? '',
          );
        }
      }
      clearChildren(tabBody);
      if (id === 'connect') {
        tabBody.appendChild(ensureConnectHost());
      } else if (id === 'ops' || id === 'entities') {
        const panel = ensureGrantPanel();
        if (panel !== null) {
          tabBody.appendChild(id === 'ops' ? panel.opsRoot : panel.entitiesRoot);
        } else {
          tabBody.appendChild(makeEl(doc, 'p', undefined, tabPlaceholder(id)));
        }
      } else {
        tabBody.appendChild(makeEl(doc, 'p', undefined, tabPlaceholder(id)));
      }
    };

    for (const tab of tabs) {
      const btn = doc.createElement('button');
      btn.setAttribute('type', 'button');
      btn.setAttribute(CONTRACTS_ROUTE_TAB_ATTR, '');
      btn.setAttribute('data-tab', tab.id);
      btn.setAttribute('role', 'tab');
      btn.setAttribute('id', `recued-contracts-detail-tab-${tab.id}`);
      btn.setAttribute('aria-controls', 'recued-contracts-detail-tabpanel');
      btn.textContent = tab.label;
      btn.addEventListener('click', () => selectTab(tab.id));
      btn.addEventListener('keydown', (event) => {
        const currentIndex = tabButtons.findIndex((entry) => entry.id === tab.id);
        if (currentIndex < 0) return;
        let nextIndex: number | null = null;
        if (event.key === 'ArrowRight') {
          nextIndex = (currentIndex + 1) % tabButtons.length;
        } else if (event.key === 'ArrowLeft') {
          nextIndex = (currentIndex - 1 + tabButtons.length)
            % tabButtons.length;
        } else if (event.key === 'Home') {
          nextIndex = 0;
        } else if (event.key === 'End') {
          nextIndex = tabButtons.length - 1;
        }
        if (nextIndex === null) return;
        event.preventDefault();
        const next = tabButtons[nextIndex]!;
        selectTab(next.id);
        next.btn.focus();
      });
      tabButtons.push({ id: tab.id, btn });
      tabStrip.appendChild(btn);
    }
    detail.appendChild(tabStrip);
    detail.appendChild(tabBody);
    if (activeTab !== null) selectTab(activeTab);

    body.appendChild(detail);
    // Exact contract navigation is asynchronous: the activating list row is
    // gone by the time the detail resolves. Move focus to the new page-level
    // subject so keyboard and screen-reader users do not fall back to <body>.
    initialDetailHeading.focus();
  };

  // ── initial loading placeholder ──
  const loading = makeEl(doc, 'p', undefined, 'Loading contracts…');
  loading.setAttribute(CONTRACTS_ROUTE_LOADING_ATTR, '');
  body.appendChild(loading);

  const requestListPage = async (cursor?: string): Promise<void> => {
    if (opts.contractsListCaller === undefined) {
      rows = [];
      nextListCursor = null;
      totalContractsOnTab = 0;
      return;
    }
    const request: ContractListRequest = activeListTab === 'built-in'
      ? {
          grant_kind: 'standing',
          derived_doors_only: true,
          limit: CONTRACTS_ROUTE_PAGE_SIZE,
          ...(cursor !== undefined ? { cursor } : {}),
        }
      : activeListTab === 'customer'
        ? {
            grant_kind: 'customer_template',
            limit: CONTRACTS_ROUTE_PAGE_SIZE,
            ...(cursor !== undefined ? { cursor } : {}),
          }
        : {
            grant_kind: 'standing',
            exclude_derived_doors: true,
            limit: CONTRACTS_ROUTE_PAGE_SIZE,
            ...(cursor !== undefined ? { cursor } : {}),
          };
    const response = await opts.contractsListCaller(request);
    // Defense in depth for older/fake callers that ignore the new request:
    // Built-in receives only server-derived public doors, Customer only editable
    // templates, and Others only human-authored standing contracts.
    const visibleRows = response.contracts.filter((contract) =>
      activeListTab === 'built-in'
        ? isStandingContractDefinition(contract)
          && derivedDoorType(contract.door_types) !== null
        : activeListTab === 'customer'
          ? contract.grant_kind === 'customer_template'
          : isStandingContractDefinition(contract)
            && derivedDoorType(contract.door_types) === null);
    rows = visibleRows.map(toRowVM);
    nextListCursor = response.next_cursor ?? null;
    totalContractsOnTab = response.total ?? visibleRows.length;
  };

  const loadListPage = async (
    cursor: string | undefined,
    direction: 'next' | 'previous',
  ): Promise<void> => {
    if (listPageBusy) return;
    listPageBusy = true;
    // Keep the current inventory and its ambient proposal panels mounted while
    // the next page is in flight. Replacing the whole list here detached the
    // focused pager and restarted supporting reads before the page even settled.
    markPageRequestBusy(direction);
    try {
      await requestListPage(cursor);
      if (disposed) return;
      if (direction === 'next') {
        previousListCursors = [...previousListCursors, currentListCursor];
      } else {
        previousListCursors = previousListCursors.slice(0, -1);
      }
      currentListCursor = cursor;
      loadErrorMessage = null;
    } catch (err) {
      if (disposed) return;
      loadErrorMessage = errMessage(err);
    } finally {
      listPageBusy = false;
      if (!disposed) renderList();
    }
  };

  const loadDetailTarget = async (
    contractId: string,
  ): Promise<ContractRowVM | null> => {
    if (contractId === OWNER_CONTRACT_ID) return SELF_ROW;
    if (opts.contractsListCaller === undefined) return null;
    const response = await opts.contractsListCaller({ contract_id: contractId });
    const contract = response.contracts.find((row) => row.contract_id === contractId);
    if (
      contract === undefined
      || !(
        isStandingContractDefinition(contract)
        || contract.grant_kind === 'customer_template'
      )
    ) {
      return null;
    }
    return toRowVM(contract);
  };

  const initialLoad = (async (): Promise<void> => {
    try {
      if (opts.initialContractId !== undefined) {
        const target = await loadDetailTarget(opts.initialContractId);
        if (disposed) return;
        if (target !== null) {
          renderDetail(target);
          return;
        }
      }
      await requestListPage();
      if (disposed) return;
      currentListCursor = undefined;
      previousListCursors = [];
      renderList();
    } catch (err) {
      if (disposed) return;
      rows = [];
      nextListCursor = null;
      totalContractsOnTab = 0;
      loadErrorMessage = errMessage(err);
      renderList();
    }
  })();

  const retryRecoveryContext = async (): Promise<void> => {
    if (disposed || listPageBusy) return;
    listPageBusy = true;
    loadErrorMessage = null;
    renderList();
    try {
      // Recovery markers retain only the broad Contracts area. Start again at
      // the active category's first page; never infer an old contract id or
      // carry an opaque cursor across server/profile boundaries.
      await requestListPage();
      if (disposed) return;
      currentListCursor = undefined;
      previousListCursors = [];
      loadErrorMessage = null;
    } catch (err) {
      if (disposed) return;
      rows = [];
      nextListCursor = null;
      totalContractsOnTab = 0;
      loadErrorMessage = errMessage(err);
    } finally {
      listPageBusy = false;
      if (!disposed) renderList();
    }
  };

  return {
    getContracts: () =>
      activeListTab === 'built-in' ? [SELF_ROW, ...rows] : rows,
    getViewMode: () => viewMode,
    getSelectedContractId: () => selectedContractId,
    getActiveTab: () => activeTab,
    getListTab: () => activeListTab,
    permissionsPanel: () => connectPanel,
    contractGrantsPanel: () => detailGrantPanel,
    suggestedRulesPanel: () => suggestedRulesPanel,
    scopedGrantPanel: () => scopedGrantPanel,
    whenLoaded: () => initialLoad,
    hasInFlightWork: hasContractsInFlightWork,
    inFlightWorkPrompt: () =>
      hasContractsInFlightWork()
        ? 'A contract action is still in progress. Leave Contracts anyway?'
        : null,
    getRecoveryContextFreshness: () =>
      opts.contractsListCaller !== undefined && loadErrorMessage === null
        ? 'current'
        : 'unavailable',
    ...(opts.contractsListCaller !== undefined
      ? { retryRecoveryContext }
      : {}),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (suggestedRulesPanel !== null) {
        suggestedRulesPanel.dispose();
        suggestedRulesPanel = null;
      }
      if (scopedGrantPanel !== null) {
        scopedGrantPanel.dispose();
        scopedGrantPanel = null;
      }
      if (connectPanel !== null) {
        connectPanel.dispose();
        connectPanel = null;
      }
      if (detailGrantPanel !== null) {
        detailGrantPanel.dispose();
        detailGrantPanel = null;
      }
      try {
        opts.root.removeChild(routeRoot);
      } catch {
        routeRoot.remove();
      }
    },
  };
};
