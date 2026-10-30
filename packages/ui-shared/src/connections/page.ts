import { fileSourceOAuthProvider } from '@recued/contracts';
/** D-125 P7.1 — Settings → Connections page renderer.
 *
 *  Pure HTML — every state input arrives via `props`. The host wires
 *  `data-action` clicks to `collection.connection.list / enroll /
 *  update / delete / probe` rpcs (P2.1) and patches the page state
 *  back through.
 *
 *  Spec wireframe (D-125 § 7.1):
 *
 *    [Connections]
 *      ▼ API (4)
 *        hubspot      → app.hubapi.com           [edit] [delete] [probe]
 *        ...
 *      ▼ MCP (1)
 *        gh-mcp       → mcp.github.com/sse       [edit] [delete] [probe]
 *      ▼ Notification (3)
 *        team-slack   → #general (Slack)         [edit] [delete] [probe]
 *
 *      [+ Add Connection]
 *
 *  Add flow opens kind-picker → (optional subtype-picker) → form.
 *  Probe runs after save with result inline. Form values flow through
 *  `collection.connection.enroll` (or `update` in edit mode). */

import {
  getVendorProvider,
  savedOAuthAppsForIssuer,
  localhostOriginForNumberedLoopback,
  vendorHasEngagement,
  CONNECTION_INBOUND_SECRET_FIELDS,
  OAUTH_CLOUD_CALLBACK_URL,
  MAX_HEADER_AUTH_ENTRIES,
  MESSAGE_MATCH_MAX_PATTERNS,
  validateMessageMatchPatterns,
  type ConnectionKind,
  type ConnectionVendorProvider,
  type ConnectionView,
  type ConnectionAuthType,
  type ReleaseCheckStatus,
} from '@recued/contracts';
import { e } from '../template.js';
import { renderAuthenticationReconnect } from './authentication-reconnect.js';
import { AUTHENTICATION_MANAGEMENT_STYLES, renderAuthenticationManagement } from './manage-authentication.js';
import {
  REFERENCE_PROVENANCE_STYLES,
  renderProvenance,
} from '../reference-provenance.js';
import { button } from '../primitives/button.js';
import { textInput, select as selectField, fieldHint } from '../primitives/field.js';
import { inlineError, inlineHint, inlineOk } from '../primitives/message.js';
import { emptyHint } from '../primitives/empty-hint.js';
import {
  CONNECTION_KIND_CHOICES,
  CONNECTION_SUBTYPE_CHOICES,
  CONNECTION_NAME_REGEX,
  collectHeaderRows,
  nameKeyForListField,
  collectMatchPatternRows,
  matchPatternRowsToPatterns,
  isCompleteMatchPatternRow,
  isHalfFilledMatchPatternRow,
  resolveConnectionSchema,
  withAuthenticationSwitchSchema,
  resolveVendorSchema,
  type ConnectionField,
  type ConnectionFormValues,
  type ConnectionSchema,
  type HeaderRow,
  type MatchPatternRow,
} from '../connection-schemas/index.js';
import {
  type ConnectionsPageState,
  type ConnectionsDialogState,
  type ConnectionsPostSafeStopRecoveryState,
  type ConnectionsServerUpdateTriage,
  connectionRowKey,
} from './state.js';
import { shouldPatchConnectionAuth } from './payload.js';
import {
  renderEngagementHealthPanel,
  ENGAGEMENT_HEALTH_PANEL_STYLES,
} from './engagement-health.js';
import { packsUsingConnection, type InstalledPackScopes } from './pack-usage.js';
import {
  connectionRemovalChanges,
  connectionRemovalRecipeChanges,
  connectionRemovalRecipeSentence,
  connectionRemovalSentence,
} from '../connection-removal.js';
import type { ConnectionsDeleteEffects } from './state.js';
import { mcpPackBadge, type McpPackBadge, type McpPackStatusView } from './mcp-pack.js';
import type { McpPackReviewState } from './state.js';
import {
  canApplyConnectionSetupGuideSuggestion,
  connectionSetupGuideReturnTarget,
} from './setup-guide.js';
import {
  connectionFormRunsOAuthDance,
  connectionOAuthCredentialReadiness,
  selectedSavedOAuthAppIssuer,
  compatibleSavedOAuthAppIssuer,
  connectionOAuthHttpsEndpointIssue,
  isConnectionOAuthLockedField,
} from './oauth-credentials.js';

export interface ConnectionsPostSafeStopProfileHandoff {
  /** A legacy/malformed link has no trustworthy profile binding; a mismatch
   * names a valid local profile other than the one this shell booted on. */
  reason: 'unbound' | 'profile_mismatch';
  activeProfileLabel: string;
  sourceProfileLabel?: string;
  serverProfilesAvailable: boolean;
}

export interface ConnectionsPageProps extends ConnectionsPageState {
  /** Whether the host wants the page rendered as a stand-alone view
   *  (with a Back button at the top) or embedded in an outer scroll
   *  container that already has its own chrome. The sidebar mounts
   *  it as stand-alone; the options page (if it ever rehosts the
   *  page in-place post-P7.3) would mount it embedded. */
  layout?: 'standalone' | 'embedded';
  /** D-322 §23 — hide the switch entry point when the host has no broker RPC. */
  managedOAuthAvailable?: boolean;
  /** The host can open the persistent Account/server-profile guide from an
   * unsupported safe-start receipt. Absent hosts keep the direct recheck and
   * dismiss actions, rather than rendering a dead guide button. */
  credentialRotationServerUpdateGuideAvailable?: boolean;
  /** Presentation-only label for the exact profile whose server supplied the
   * post-ack queue. Profile ids remain routing metadata and are not rendered. */
  postSafeStopProfileLabel?: string;
  /** Safe landing when a recovery URL cannot be bound to this boot. */
  postSafeStopProfileHandoff?: ConnectionsPostSafeStopProfileHandoff | null;
  /** D-320 slice 2h — the host mounts the per-sign-in grids ("Which packs use
   *  which connection") into a placeholder at the top of the API group. Absent:
   *  none. */
  signInGrids?: boolean;
  /** D-127 P4.3 / wire-up — dynamic option lists keyed by
   *  `options_source` id. Field is inherited from
   *  `ConnectionsPageState` (D-127 wire-up moved storage there so
   *  hosts hydrate via `patchConnectionsPage`); the entry on Props
   *  remains as documentation of the prop boundary. Currently
   *  populated keys: `'data.mail.send_capable_instances'` ⇒ live
   *  `collection.mail.list` filtered client-side by `send_capable:
   *  true` then projected to slugs. Missing entries resolve to `[]`
   *  and the empty-list guidance kicks in. */
}

const KIND_ORDER: readonly ConnectionKind[] = ['api', 'mcp', 'notification'];
const AUTH_LABELS: Record<ConnectionAuthType, string> = {
  none: 'No authentication', bearer: 'Bearer token', basic: 'Username and password', header: 'API key in headers',
  query: 'API key in URL', oauth2_refresh: 'Recued direct OAuth', managed_oauth: 'OAuth broker (Nango)',
  oauth2_client_credentials: 'OAuth app credentials', atproto_session: 'AT Protocol app password',
  request_signature: 'Signed requests', body_field: 'Credentials in request body',
};
/** The sign-in methods a new API connection offers first, in the order an
 *  owner weighs them: Recued signs in itself, a broker does, or a key. */
const AUTH_METHOD_CARDS: ReadonlyArray<{ type: ConnectionAuthType; title: string; description: string }> = [
  { type: 'oauth2_refresh', title: AUTH_LABELS.oauth2_refresh, description: 'Sign in with your own OAuth app. Recued keeps the sign-in fresh.' },
  { type: 'managed_oauth', title: AUTH_LABELS.managed_oauth, description: 'A Nango account holds the sign-in and keeps it fresh.' },
  { type: 'bearer', title: 'API key or token', description: 'Paste a key or token the service gave you.' },
];
const healthOfView = (connection: ConnectionView) => {
  const health = connection.health as { status?: string; last_error?: string; last_probed_at?: number } | undefined;
  return health && typeof health === 'object' ? health : undefined;
};
const KIND_LABELS: Record<ConnectionKind, string> = {
  api: 'API',
  mcp: 'MCP',
  notification: 'Notification',
};

/** Group connections by their `kind`. Stable order matches KIND_ORDER. */
const groupByKind = (
  connections: readonly ConnectionView[],
): Record<ConnectionKind, ConnectionView[]> => {
  const out: Record<ConnectionKind, ConnectionView[]> = {
    api: [],
    mcp: [],
    notification: [],
  };
  for (const conn of connections) {
    out[conn.kind].push(conn);
  }
  for (const kind of KIND_ORDER) {
    out[kind].sort((a, b) => a.name.localeCompare(b.name));
  }
  return out;
};

const summaryFor = (conn: ConnectionView): string => {
  if (conn.kind === 'api') {
    return typeof conn.base_url === 'string' ? conn.base_url : '';
  }
  if (conn.kind === 'mcp') {
    return typeof conn.endpoint === 'string' ? conn.endpoint : '';
  }
  if (conn.kind === 'notification') {
    if (typeof conn.channel_id === 'string') return `#${conn.channel_id}`;
    if (typeof conn.chat_id === 'string') return `chat ${conn.chat_id}`;
    // D-127 P4.3 — email subtype no longer carries SMTP creds; the
    // record's config.sender_mail_instance points at a `data.mail.<n>`
    // instance that holds the auth. Surfaces "via <slug>" so a row
    // like "newsletter via work-gmail" reads cleanly in the list.
    if (typeof conn.sender_mail_instance === 'string') return `via ${conn.sender_mail_instance}`;
    return conn.subtype ? `(${conn.subtype})` : '';
  }
  return '';
};

/** D-139 P2 / D-192 S5 — recognize a vendor connection that has an
 *  engagement-health surface so we can render the affordance. Prefer the
 *  server-stamped `supports_engagement_health` (computed from the LIVE merged
 *  vendor registry, so a pack-declared engagement CRM like Dynamics lights up
 *  too); fall back to a built-in-registry `vendorHasEngagement` read for dbless
 *  / legacy servers that don't stamp it (same graceful-degrade as
 *  `bound_pack_slugs`). The `vendor` field is `config.vendor` flattened onto
 *  the view. */
const isEngagementVendorConnection = (conn: ConnectionView): boolean => {
  if (conn.kind !== 'api') return false;
  const stamped = conn.supports_engagement_health;
  if (typeof stamped === 'boolean') return stamped;
  const v = conn.vendor;
  return typeof v === 'string' && vendorHasEngagement(v);
};

/** The connection's vendor — `config.vendor` (flattened onto the view), else
 *  the `subtype` fallback. Mirrors the server `resolveConnectionVendor` + the
 *  pack-row readiness controller, so both pivots resolve identically. */
const connectionVendor = (conn: ConnectionView): string | undefined => {
  const raw = (conn as { vendor?: unknown }).vendor;
  if (typeof raw === 'string' && raw.length > 0) return raw;
  return typeof conn.subtype === 'string' && conn.subtype.length > 0
    ? conn.subtype
    : undefined;
};

/** Connection-detail "Used by packs" — the inverse-pivot section on an api
 *  connection row: which INSTALLED packs use this connection + per-pack scope
 *  coverage (covered / missing X / not verified). Empty for non-api connections,
 *  a vendor-less connection, or when no installed pack uses it. READINESS, not
 *  a gate. */
const renderPackUsage = (
  conn: ConnectionView,
  installedPacks: readonly InstalledPackScopes[],
): string => {
  if (conn.kind !== 'api') return '';
  const vendor = connectionVendor(conn);
  // A vendor is needed to read the packs' scopes; the packs whose list holds the
  // connection are named without one (D-320).
  if (vendor === undefined && (conn.bound_pack_slugs ?? []).length === 0) return '';
  // D-194 #6 — `bound_pack_slugs` (stamped by handleConnectionList from the grant
  // store) narrows the vendor-match to packs granted on THIS specific connection,
  // so two connections of one vendor don't both list every vendor pack. Absent
  // (dbless / legacy) → packsUsingConnection falls back to vendor-match.
  const usage = packsUsingConnection(
    installedPacks,
    vendor ?? '',
    conn.granted_scopes,
    conn.bound_pack_slugs,
    conn.default_for_pack_slugs,
    conn.pack_holders,
  );
  if (usage.length === 0) return '';
  const items = usage
    .map((u) => {
      const c = u.coverage;
      // A pack that needs no scope has no coverage to say (D-320).
      const status = u.needed.length === 0
        ? null
        : !c.known
          ? 'Recued has not checked what it may do'
          : c.covered
            ? 'covered'
            : `missing ${c.missing.join(', ')}`;
      const tone = c.known && !c.covered ? 'warn' : 'ok';
      // D-320 §4 — the pack runs on this connection unless told otherwise.
      const isDefault = u.is_default === true
        ? ' <span class="connections-pack-usage-default" data-pack-usage-default>· its default</span>'
        : '';
      // D-320 slice 2h — a family once, by its holder, its members counted.
      const members = u.members.length === 0
        ? ''
        : ` <span class="connections-pack-usage-members" data-pack-usage-members="${u.members.length}" title="${e(u.members.join(', '))}">and ${u.members.length} ${u.members.length === 1 ? 'pack that signs' : 'packs that sign'} in through it</span>`;
      return `<li class="connections-pack-usage-item" data-pack-usage="${e(u.pack_slug)}" data-pack-usage-tone="${tone}"><span class="connections-pack-usage-name">${e(u.pack_name)}</span>${members}${status === null ? '' : ` <span class="connections-pack-usage-status">— ${e(status)}</span>`}${isDefault}</li>`;
    })
    .join('');
  return `
    <div class="connections-pack-usage" data-conn-pack-usage="${e(connectionRowKey(conn.kind, conn.name))}" tabindex="-1">
      <p class="connections-pack-usage-heading">Used by packs</p>
      <ul class="connections-pack-usage-list">${items}</ul>
    </div>
  `;
};

/** A failed optional pack-context read is a degraded projection, not an empty
 *  roster. Keep the connection list usable while making that distinction and
 *  its explicit recovery action visible. The busy replacement remains
 *  focusable; the webclient controller owns the single-flight guard. */
const renderPackInventoryRecovery = (
  recovery: ConnectionsPageProps['packInventoryRecovery'],
): string => {
  if (recovery === undefined) return '';
  const retrying = recovery.phase === 'retrying';
  return `
    <section class="connections-credential-recovery connections-pack-inventory"
      data-connections-pack-inventory="${recovery.phase}"
      role="${retrying ? 'status' : 'alert'}"
      aria-live="polite" aria-atomic="true" aria-busy="${retrying ? 'true' : 'false'}">
      <div class="connections-pack-inventory-copy">
        <strong>${retrying ? 'Getting the Pack details back' : 'Recued cannot read the Pack details'}</strong>
        <span>${retrying
          ? 'Loading how your Packs are used, and what to set up…'
          : `Your connections still work. What Recued shows about Packs may be missing things. ${e(recovery.message)}`}</span>
      </div>
      <div class="connections-credential-recovery-action">
        <button type="button"
          class="rx-btn rx-btn-secondary rx-btn-xs btn btn-xs btn-secondary"
          data-action="connections-retry-pack-context"
          data-connections-pack-inventory-retry
          aria-disabled="${retrying ? 'true' : 'false'}"
          aria-busy="${retrying ? 'true' : 'false'}">${retrying ? 'Retrying…' : 'Retry'}</button>
      </div>
    </section>
  `;
};

const renderRow = (
  conn: ConnectionView,
  probeInFlight: Set<string>,
  deleteInFlight: Set<string>,
  engagementHealth: ConnectionsPageState['engagementHealth'],
  installedPacks: readonly InstalledPackScopes[],
  mcpPackStatus: Readonly<Record<string, McpPackStatusView>> | undefined,
  managedOAuthAvailable = false,
): string => {
  const key = connectionRowKey(conn.kind, conn.name);
  const probing = probeInFlight.has(key);
  const deleting = deleteInFlight.has(key);
  const showEngagement = isEngagementVendorConnection(conn);
  const engagementExpanded = showEngagement && engagementHealth.expanded.has(key);
  // D-139 P2 — render the inline engagement-health detail panel
  // beneath the row when the user has expanded it. The panel host
  // owns the rpc lifecycle; the renderer only reads state.
  const engagementPanel = engagementExpanded
    ? renderEngagementHealthPanel({
        connectionName: conn.name,
        loading: engagementHealth.loading.has(key),
        error: engagementHealth.error[key] ?? null,
        reprobing: engagementHealth.reprobing.has(key),
        installing: engagementHealth.installing.has(key),
        data: engagementHealth.data[key] ?? null,
        lastReprobe: engagementHealth.lastReprobe[key] ?? null,
      })
    : '';
  const engagementToggleLabel = engagementExpanded
    ? 'Hide health'
    : 'How well it is working';
  return `
    <div class="connections-row-wrap" data-conn-key="${e(key)}">
      <div class="connections-row" data-conn-key="${e(key)}">
        <div class="connections-row-info">
          <div class="connections-row-identity">
            <strong class="connections-row-name">${e(conn.display_name || conn.name)}</strong>
            ${conn.subtype ? `<span class="connections-row-subtype">${e(conn.subtype)}</span>` : ''}
            ${conn.display_name && conn.display_name !== conn.name ? `<span class="connections-row-display">${e(conn.name)}</span>` : ''}
          </div>
          <span class="connections-row-summary">${e(summaryFor(conn))}</span>
          <div class="connections-row-meta">
            ${conn.kind === 'api' ? `<span>${e(conn.auth_type === 'managed_oauth' ? 'OAuth broker' : conn.auth_type ? AUTH_LABELS[conn.auth_type] : 'Authentication not reported')}${['managed_oauth', 'oauth2_refresh'].includes(conn.auth_type ?? '') ? ' · ' + e(typeof conn.account_email === 'string' && conn.account_email ? conn.account_email : 'Account unknown') : ''}</span>` : ''}
            <span>${e(healthOfView(conn)?.status === 'ok' && !healthOfView(conn)?.last_error ? 'Last check passed' : healthOfView(conn)?.status === 'auth_failed' ? 'Access denied — needs attention' : healthOfView(conn)?.status === 'unreachable' ? 'Could not reach service' : 'Access not verified')}</span>
          </div>
        </div>
        <div class="connections-row-actions">
          ${managedOAuthAvailable && conn.kind === 'api' && ['oauth2_refresh', 'bearer', 'managed_oauth'].includes(conn.auth_type ?? '')
            ? button({ label: 'Manage authentication', action: 'connections-manage-row-authentication', size: 'sm', data: { kind: conn.kind, name: conn.name }, disabled: deleting }) : ''}
          ${
            showEngagement
              ? button({
                  label: engagementToggleLabel,
                  size: 'xs',
                  variant: engagementExpanded ? 'primary' : 'secondary',
                  action: 'connections-engagement-toggle',
                  data: { kind: conn.kind, name: conn.name },
                  disabled: deleting,
                })
              : ''
          }
          ${button({
            label: 'Edit',
            size: 'xs',
            action: 'connections-edit',
            data: { kind: conn.kind, name: conn.name },
            disabled: deleting,
          })}
          ${button({
            label: probing ? 'Testing…' : 'Test connection',
            size: 'xs',
            action: 'connections-probe',
            data: { kind: conn.kind, name: conn.name },
            disabled: deleting,
            ariaDisabled: probing, ariaBusy: probing,
          })}
          ${button({
            label: deleting ? 'Removing…' : 'Remove',
            size: 'xs',
            variant: 'danger-text',
            action: 'connections-delete',
            data: { kind: conn.kind, name: conn.name },
            disabled: deleting,
          })}
        </div>
      </div>
      ${engagementPanel}
      ${renderPackUsage(conn, installedPacks)}
      ${renderMcpPackBadge(conn, mcpPackStatus)}

    </div>
  `;
};

/** D-225 Slice 2 — the generated-pack badge on an MCP connection's detail.
 *
 *  ⚠ An ABSENT status renders nothing, and that is only correct because absent
 *  means "not fetched yet". Once a status exists, `unknown` renders VISIBLY —
 *  the whole reason the server keeps it distinct from `current` is that silence
 *  reads as reassurance on exactly the connections nobody has probed. A host
 *  that hydrated a failed fetch as absent would recreate the false all-clear. */
const renderMcpPackBadge = (
  conn: ConnectionView,
  statuses: Readonly<Record<string, McpPackStatusView>> | undefined,
): string => {
  if (conn.kind !== 'mcp') return '';
  const status = statuses?.[connectionRowKey(conn.kind, conn.name)];
  if (status === undefined) return '';
  const badge = mcpPackBadge(status);
  const action = badge.action === undefined
    ? ''
    // ⚠ `data-action` + `data-kind` / `data-name` — the convention the panel's
    // click dispatcher reads. A bespoke attribute would render a button that
    // looks live and does nothing.
    : `<button type="button" class="connections-mcp-pack-action"`
      + ` data-action="connections-mcp-pack-${e(badge.action)}"`
      + ` data-mcp-pack-action="${e(badge.action)}"`
      + ` data-kind="${e(conn.kind)}" data-name="${e(conn.name)}">${e(mcpPackActionLabel(badge.action))}</button>`;
  return `
    <div class="connections-mcp-pack" data-conn-mcp-pack="${e(connectionRowKey(conn.kind, conn.name))}" data-mcp-pack-tone="${e(badge.tone)}">
      <p class="connections-mcp-pack-heading"><span class="connections-mcp-pack-label">${e(badge.label)}</span></p>
      <p class="connections-mcp-pack-detail">${e(badge.detail)}</p>
      ${action}
    </div>
  `;
};

const mcpPackActionLabel = (action: NonNullable<McpPackBadge['action']>): string => {
  switch (action) {
    case 'generate': return 'Generate pack';
    case 'review': return 'Review tools';
    case 'probe': return 'Check it now';
  }
};

/** Host slot for the webclient's shared Access × Audience install picker. The
 *  page renderer stays pure HTML; the enrollment host mounts the interactive
 *  DOM control here after each render. */
export const MCP_PACK_INSTALL_SCOPE_HOST_ATTR =
  'data-recued-mcp-pack-install-scope';

/** D-225 Slice 2 — the generated-pack review screen.
 *
 *  The middle of the enrollment chain: `#connections → mcp → create → success`
 *  → THIS → Save → pack detail.
 *
 *  ⛔ **A DISCLOSURE, not a second editor.** There is no per-row relax control:
 *  `mcpPackCommit` writes no rulings, and tuning goes through
 *  `contract.ownerOperation.*`, which enforces the approval floor and refuses a
 *  downgrade without an explicit confirm. A relax button on a screen the owner
 *  is skimming would route a downgrade around exactly the confirmation it
 *  exists to require. The server's claim is shown, attributed, alongside where
 *  to act on it.
 *
 *  ⛔ A failed probe renders the ERROR, never an empty list — zero rows reads as
 *  "this server has no tools", and an owner could Save that believing they had
 *  reviewed something. */
const renderMcpPackReview = (review: McpPackReviewState | null): string => {
  if (review === null) return '';
  const conn = e(review.connection.name);
  const head = `<h3 class="connections-review-title">Tools published by “${conn}”</h3>`;
  if (review.loading) {
    return `<section class="connections-review" data-mcp-pack-review="${conn}">${head}
      <p class="connections-review-note">Asking the server what it offers…</p></section>`;
  }
  if (review.error !== null) {
    return `<section class="connections-review" data-mcp-pack-review="${conn}" data-review-state="error">${head}
      <p class="connections-review-error">${e(review.error)}</p>
      <button type="button" data-action="connections-mcp-pack-review" data-kind="mcp" data-name="${conn}">Try again</button>
      <button type="button" data-action="connections-mcp-pack-cancel">Cancel</button>
    </section>`;
  }
  const view = review.view;
  if (view === null) return '';
  const rows = view.rows.map((r) => {
    const claim = r.claim === undefined
      ? ''
      : `<p class="connections-review-claim">${e(r.claim)}</p>`;
    const desc = r.description === undefined
      ? ''
      : `<p class="connections-review-desc">${e(r.description)}</p>`;
    // ⚠ `offer` is rendered as TEXT, not a control. It says what the server
    // claims and where the owner can act on it — the acting happens in pack
    // detail, behind the downgrade confirm.
    const offer = r.offer === undefined
      ? ''
      : `<p class="connections-review-offer">You can relax this to ${e(r.offer.risk)} / ${e(r.offer.approval)} in pack detail after installing.</p>`;
    return `<li class="connections-review-row" data-review-op="${e(r.op)}">
      <p class="connections-review-tool"><code>${e(r.tool)}</code></p>
      ${desc}${claim}
      <p class="connections-review-tier">Held for approval — ${e(r.selected.risk)} / ${e(r.selected.approval)}</p>
      ${offer}
    </li>`;
  }).join('');
  const save = view.rows.length === 0
    ? ''
    : `<button type="button" class="connections-review-save" data-action="connections-mcp-pack-save"
        data-kind="mcp" data-name="${conn}"${review.saving ? ' disabled' : ''}>${review.saving ? 'Installing…' : 'Install pack'}</button>`;
  const installScope = view.rows.length === 0
    ? ''
    : `<div class="connections-review-install-scope" ${MCP_PACK_INSTALL_SCOPE_HOST_ATTR}=""></div>`;
  return `
    <section class="connections-review" data-mcp-pack-review="${conn}" data-review-state="ready">
      ${head}
      <p class="connections-review-summary">${e(view.summary)}</p>
      <ul class="connections-review-list">${rows}</ul>
      ${installScope}
      ${save}
      <button type="button" data-action="connections-mcp-pack-cancel">Cancel</button>
    </section>
  `;
};

/** D-320 slice 2h — where the host mounts the per-sign-in grids ("Which packs use
 *  which connection"): at the top of the API group, an overview above the rows. */
export const SIGNIN_GRIDS_HOST_ATTR = 'data-recued-signin-grids-host';

const renderKindGroup = (
  kind: ConnectionKind,
  rows: readonly ConnectionView[],
  probeInFlight: Set<string>,
  deleteInFlight: Set<string>,
  engagementHealth: ConnectionsPageState['engagementHealth'],
  installedPacks: readonly InstalledPackScopes[],
  mcpPackStatus: Readonly<Record<string, McpPackStatusView>> | undefined,
  signInGrids = false,
  managedOAuthAvailable = false,
): string => {
  if (rows.length === 0) return '';
  const grids = kind === 'api' && signInGrids
    ? `<div class="connections-signin-grids" ${SIGNIN_GRIDS_HOST_ATTR}=""></div>`
    : '';
  return `
    <section class="connections-group" data-kind="${e(kind)}">
      <h3 class="connections-group-title">${e(KIND_LABELS[kind])} (${rows.length})</h3>
      <div class="connections-group-rows">
        ${rows.map((r) => renderRow(r, probeInFlight, deleteInFlight, engagementHealth, installedPacks, mcpPackStatus, managedOAuthAvailable)).join('')}
      </div>
      ${grids}
    </section>
  `;
};

const formatUtcMinute = (value: number | undefined): string | null => {
  if (value === undefined || !Number.isFinite(value)) return null;
  try {
    return `${new Date(value).toISOString().replace('T', ' ').slice(0, 16)} UTC`;
  } catch {
    return null;
  }
};

const renderRecentProbe = (
  dialog: ConnectionsDialogState,
  postSafeStopRecoveries: ReadonlyArray<
    ConnectionsPostSafeStopRecoveryState
  > = [],
  postSafeStopProfileLabel?: string,
): string => {
  const p = dialog.recentProbe;
  if (!p) return '';
  if (p.purpose === 'post_safe_stop') {
    const identity = `${p.kind}/${p.name}`;
    const profileLabel = postSafeStopProfileLabel?.trim() ?? '';
    const profileMeta = profileLabel.length === 0
      ? ''
      : `<span class="connections-post-safe-stop-profile">Server profile: ${e(profileLabel)}</span>`;
    const profileAria = profileLabel.length === 0
      ? ''
      : ` on ${profileLabel}`;
    const remaining = postSafeStopRecoveries.filter((item) =>
      item.kind !== p.kind || item.name !== p.name);
    const next = remaining[0];
    const remainingDetail = remaining.length === 0
      ? ''
      : ` ${remaining.length} other connection${remaining.length === 1 ? '' : 's'} still ${remaining.length === 1 ? 'needs' : 'need'} recovery.`;
    const continueAction = next === undefined
      ? ''
      : button({
          label: 'Continue to next',
          size: 'sm',
          variant: 'secondary',
          action: 'connections-continue-post-safe-stop',
          data: { kind: next.kind, name: next.name },
          ariaLabel: `Continue recovery with ${next.kind}/${next.name}${profileAria}`,
        });
    const checkedAt = formatUtcMinute(p.checked_at);
    const checked = checkedAt === null ? '' : ` Checked ${checkedAt}.`;
    const resolution = p.resolution ?? 'retry';
    let title: string;
    let detail: string;
    let action = '';
    if (resolution === 'checking') {
      title = 'Checking the connection you saved…';
      detail = `You said the provider setup is fixed, so your server is checking the key you have saved for ${identity}.`;
    } else if (resolution === 'resolved') {
      title = 'Checked, and it is sorted';
      detail = `Your server checked the key you have saved for ${identity}, and the provider accepted it. All done; nothing was changed or sent again.${checked}${remainingDetail}`;
      action = continueAction;
    } else if (resolution === 'reopen') {
      const hasCredentialCorrection = p.credential_correction !== undefined;
      title = hasCredentialCorrection
        ? 'The key you saved still needs a look'
        : 'The connection you saved still needs a look';
      detail = `Your server checked again, and the provider still refuses the key you have saved for ${identity}. This is a new result, so you can correct the key from here.${checked}`;
      action = button({
        label: hasCredentialCorrection
          ? 'Look at the key you saved'
          : 'Look at the connection',
        size: 'sm',
        variant: 'secondary',
        action: 'connections-review-post-safe-stop',
        data: { kind: p.kind, name: p.name },
        ariaLabel: hasCredentialCorrection
          ? `Look at the key you saved for ${identity}${profileAria}`
          : `Look at the sign-in settings for ${identity}${profileAria}`,
      });
    } else if (resolution === 'changed') {
      title = 'The connection changed while Recued was checking';
      detail = `Recued kept the newer version of ${identity} and did not use the older result on it. Look at the connection as it is now before you decide what to fix.`;
      action = button({
        label: 'Check the connection now',
        size: 'sm',
        variant: 'secondary',
        action: 'connections-recheck-post-safe-stop',
        data: { kind: p.kind, name: p.name },
        ariaLabel: `Check the connection you have saved for ${identity}${profileAria}`,
      });
    } else if (resolution === 'removed') {
      title = 'That connection is gone';
      detail = `Your server no longer has ${identity}, so there is no saved key left to check.${remainingDetail}`;
      action = continueAction;
    } else if (resolution === 'unsupported') {
      title = 'Your server needs updating before it can check this';
      detail = `Your server can check ${identity}, but it cannot say which saved version it checked. Update and restart your server, then run the check once more. No key was changed.`;
      action = button({
        label: 'Check once it is updated',
        size: 'sm',
        variant: 'secondary',
        action: 'connections-recheck-post-safe-stop',
        data: { kind: p.kind, name: p.name },
        ariaLabel: `Check ${identity}${profileAria} once you have updated your server`,
      });
    } else {
      title = p.status === 'pending'
        ? 'The connection you saved still needs checking'
        : p.status === 'unreachable'
          ? 'Recued could not reach them'
          : 'Recued has not checked this connection yet';
      detail = p.status === 'pending'
        ? `Your server wrote down that the earlier problem is closed for ${identity}, but no newer check of the saved credential is on record. Run one check to finish recovery.`
        : p.status === 'unreachable'
          ? `Your server could not reach them for ${identity}. This does not prove the saved credential is wrong. Reconnect or check the provider, then run one fresh check.${checked}`
          : p.status === 'auth_failed'
            ? `Your server said the key was refused, but Recued could not match that to the newest saved version of ${identity}. Reload the current row, then check it again before replacing anything.${checked}`
            : `Your server could not finish checking the saved key for ${identity}. The previous recovery stop remains closed; reconnect, then try one fresh check.${checked}`;
      action = button({
        label: 'Check again',
        size: 'sm',
        variant: 'secondary',
        action: 'connections-recheck-post-safe-stop',
        data: { kind: p.kind, name: p.name },
        ariaLabel: `Check the connection you saved again, for ${identity}${profileAria}`,
      });
    }
    return `
      <section class="connections-credential-rotation connections-post-safe-stop"
               data-post-safe-stop-verification="${e(resolution)}"
               role="status" aria-live="polite" aria-atomic="true"${resolution === 'checking' ? ' aria-busy="true"' : ''}>
        <strong>${e(title)}</strong>
        ${profileMeta}
        <span>${e(detail)}</span>
        ${action}
      </section>
    `;
  }
  if (p.purpose === 'credential_rotation' && p.status === 'verified') {
    const authType = p.auth_type === undefined
      ? 'The new key'
      : ({
          none: 'No sign-in needed',
          managed_oauth: 'Managed OAuth',
          bearer: 'A key you paste in',
          basic: 'Username and password',
          header: 'A key sent in the request',
          query: 'A key in the web address',
          request_signature: 'A pair of signing keys',
          body_field: 'A key sent with the request',
          oauth2_refresh: 'An OAuth refresh key',
          oauth2_client_credentials: 'An OAuth app key',
          atproto_session: 'AT Protocol app password',
        } as const)[p.auth_type];
    const checkedAt = formatUtcMinute(p.verified_at);
    const expiresAt = formatUtcMinute(p.access_expires_at);
    const checked = checkedAt === null ? '' : ` Verified ${checkedAt}.`;
    const expiry = expiresAt === null ? '' : ` Access token valid until ${expiresAt}.`;
    const message = p.recovered
      ? `${authType} replacement for ${p.kind}/${p.name} was checked and is now in use. That is what this says happened. Look at the connection as it is now before you change anything else.${checked}${expiry}`
      : `${authType} checked, and now in use for ${p.kind}/${p.name}. Future provider calls use the replacement.${checked}${expiry}`;
    return `<div class="connections-credential-receipt" data-connection-credential-receipt="verified" role="status" aria-live="polite">${inlineOk(
      message,
    )}${renderAuthenticationReconnect(p.reconnect_collections)}</div>`;
  }
  const httpStatus = p.last_error?.match(/^http_status_(\d{3})$/)?.[1];
  const tone = httpStatus || p.last_error && p.status === 'ok' ? 'warn' : p.status === 'ok' ? 'ok' : p.status === 'unknown' ? 'hint' : 'warn';
  const detail = httpStatus ? `Service responded with HTTP ${httpStatus}. Access was not verified.`
    : p.last_error === 'body_field_auth_not_probeable' ? 'This check cannot test credentials sent in a request body. Verify them through a protected operation.'
    : p.last_error === 'managed_oauth_permissions_unverified' ? 'The broker reached the service. Vendor permissions remain unverified; test a protected resource.'
    : p.kind === 'api' && p.status === 'ok' ? 'The service responded. This does not confirm every permission or access to your data.'
    : p.status === 'auth_failed' ? 'The service denied access. Review the saved sign-in and vendor permissions.'
    : p.status === 'unreachable' ? 'The service could not be reached. This does not prove the credentials are wrong.'
    : p.last_error ?? 'Review the connection before relying on access.';
  const message = `Last checked for ${p.kind}/${p.name}: ${httpStatus ? 'needs attention' : p.status}. ${detail}`;
  if (tone === 'ok') return inlineOk(message);
  if (tone === 'warn') return inlineError(message);
  return inlineHint(message);
};

const renderPostSafeStopProfileHandoff = (
  props: ConnectionsPageProps,
): string => {
  const handoff = props.postSafeStopProfileHandoff;
  if (handoff === undefined || handoff === null) return '';
  const activeLabel = handoff.activeProfileLabel.trim().length > 0
    ? handoff.activeProfileLabel.trim()
    : 'this server profile';
  const sourceLabel = handoff.sourceProfileLabel?.trim();
  const sourceKnown = sourceLabel !== undefined && sourceLabel.length > 0;
  const source = sourceKnown ? sourceLabel : 'another server profile';
  const title = handoff.reason === 'unbound'
    ? 'Recued has to check this link against a server'
    : 'This belongs to a different server';
  const detail = handoff.reason === 'unbound'
    ? `This link is old, or missing something, and does not say which server made it. You are using ${activeLabel}. Recued did not open or check a same-named connection here.`
    : sourceKnown
      ? `This was made for ${source}, but you are using ${activeLabel}. Recued did not open or check a same-named connection on this server.`
      : `This was made for a different server profile that is not currently named in this browser. You are using ${activeLabel}. Recued did not open or check a same-named connection on this server.`;
  // Do not advertise a route-changing choice while another connection editor
  // owns the page. The controller deliberately refuses to replace a live
  // editor, so rendering this button here would create a focusable no-op.
  const reviewCurrent = props.dialog.stage !== 'closed'
    || props.postSafeStopRecoveries.length === 0
    ? ''
    : button({
        label: `Review ${activeLabel} instead`,
        size: 'sm',
        variant: 'secondary',
        action: 'connections-review-active-post-safe-stop',
        ariaLabel: `Look at connections still to fix on ${activeLabel}`,
      });
  const openProfiles = handoff.serverProfilesAvailable
    ? button({
        label: 'Open your servers',
        size: 'sm',
        variant: 'primary',
        action: 'connections-open-post-safe-stop-profile',
        ariaLabel: sourceKnown
          ? `Open your servers to find ${source}`
          : 'Open your servers to review the recovery destination',
      })
    : '';
  return `
    <section class="connections-credential-rotation connections-post-safe-stop-profile-handoff"
             data-post-safe-stop-profile-handoff="${e(handoff.reason)}"
             role="status" aria-live="polite" aria-atomic="true">
      <strong>${e(title)}</strong>
      <span>${e(detail)}</span>
      <div class="connections-post-safe-stop-profile-actions">
        ${openProfiles}
        ${reviewCurrent}
        ${button({
          label: 'Dismiss',
          size: 'sm',
          variant: 'secondary',
          action: 'connections-dismiss-post-safe-stop-profile',
          ariaLabel: 'Put this aside',
        })}
      </div>
    </section>
  `;
};

const credentialRotationFailureCopy = (
  reason: NonNullable<ConnectionsPageState['credentialRotationRecovery']>['failureReason'],
): string => {
  if (reason === 'auth_failed') {
    return 'They refused the new key. Recued kept the old key.';
  }
  if (reason === 'unreachable') {
    return 'The check did not finish. Recued kept the old key.';
  }
  if (reason === 'inconclusive') {
    return 'They could not confirm the new key works. Recued kept the old key.';
  }
  if (reason === 'conflict') {
    return 'The connection changed while Recued was checking, so the new key was not used.';
  }
  return 'That did not finish. Recued kept the old key.';
};

const serverUpdateTriageReasonCopy = (
  triage: ConnectionsServerUpdateTriage,
): string => {
  const current = triage.currentVersion ?? 'a version nobody has confirmed';
  const baseline = triage.baselineVersion ?? 'the earlier version nobody confirmed';
  if (triage.reason === 'update_still_available') {
    const target = triage.availableVersion === undefined
      ? 'an available update'
      : `version ${triage.availableVersion}`;
    if (
      triage.baselineVersion !== undefined
      && triage.currentVersion !== undefined
      && triage.currentVersion !== triage.baselineVersion
    ) {
      return `Your server went from version ${baseline} to ${current}, but it still offers ${target}. An update was installed, but not the newest one, and the safety check is still missing.`;
    }
    return `Your server still says it is on version ${current}, and it still offers ${target}. That update is not running yet.`;
  }
  if (triage.reason === 'running_version_unchanged') {
    return `Your server still says it is on version ${current}, the same as before the update. Restart the server you picked, or install the update again, then try again.`;
  }
  if (triage.reason === 'running_version_changed') {
    return `Your server went from version ${baseline} to ${current}, but the safety check is still missing. Check that the whole update reached the server you picked, then restart it.`;
  }
  if (triage.reason === 'launcher_update_required') {
    return `Your server says it is on version ${current}, but the launcher that starts it is too old. Update the launcher, then try again.`;
  }
  if (triage.reason === 'self_update_unavailable') {
    return `Your server says it is on version ${current}, and it cannot update itself from here. Update it the way you installed it, then restart it.`;
  }
  if (triage.reason === 'current_build_missing_capability') {
    return `Your server says it is on version ${current} and says its ${triage.channel ?? 'current'} is up to date, but the safety check it needs is missing. Check what you actually installed, and that you picked the right server, before trying again.`;
  }
  if (triage.checkStatus === 'bad-signature') {
    return `Your server says it is on version ${current}, but the update it was offered did not pass its signature check. Do not install from that update service; check the server’s trusted update key first.`;
  }
  if (triage.checkStatus === 'replay') {
    return `Your server says it is on version ${current}, but it turned down an older update. Point it at an up-to-date update service, then try again.`;
  }
  if (triage.checkStatus === 'stale-feed') {
    return `Your server says it is on version ${current}, but it checks for updates in an old way that misses new ones. Run the installer on that server again to update it.`;
  }
  if (triage.checkStatus === 'fetch-failed') {
    return `Your server says it is on version ${current}, but it could not reach its update service. Check that it can reach the internet, and that its update address is right, then try again.`;
  }
  return 'The safety check it needs is missing, and Recued could not check for updates. Check you picked the right server, that Recued can reach it, and that its update settings are right.';
};

const serverUpdateTriageEvidenceCopy = (
  triage: ConnectionsServerUpdateTriage,
): string => {
  const evidence: string[] = [];
  if (triage.currentVersion !== undefined) {
    evidence.push(`running ${triage.currentVersion}`);
  }
  if (triage.channel !== undefined) evidence.push(`${triage.channel} channel`);
  evidence.push(
    triage.checkStatus === 'unavailable'
      ? 'update check unavailable'
      : `update check ${triage.checkStatus.replaceAll('-', ' ')}`,
  );
  if (triage.baselineVersion !== undefined) {
    evidence.push(`before update ${triage.baselineVersion}`);
  }
  return `What the server said: ${evidence.join(' · ')}.`;
};

const serverUpdateBaselinePostureCopy: Readonly<
  Record<ReleaseCheckStatus, string>
> = {
  'update-available': 'a newer version is ready',
  'up-to-date': 'this is the newest version',
  'not-configured': 'this server is not set up to check for updates by itself',
  'stale-feed': 'this server checks for updates in an old way and misses new ones',
  'launcher-outdated': 'the launcher has to be updated first',
  replay: 'an older update was ignored',
  'fetch-failed': 'the running version is known; Recued cannot reach the update service',
  'bad-signature': 'Recued knows the version it is running, but the update did not pass its checks',
};

const renderCredentialRotationRecovery = (
  props: ConnectionsPageProps,
): string => {
  const recovery = props.credentialRotationRecovery;
  if (recovery === null) return '';
  const identity = `${recovery.kind}/${recovery.name}`;
  const recoveryVerification = recovery.serverUpdateVerification;
  const canReview = props.connections.some((connection) =>
    connection.kind === recovery.kind && connection.name === recovery.name);
  const hasExactCorrection = recovery.correction !== undefined
    && recovery.correction.field_keys.length > 0;
  const hasRepeatedRejectionTriage = recovery.correction?.triage !== undefined;
  const hasRegenerationSafeStop = recovery.correction?.triage?.resolution
    === 'regenerate_credential_or_contact_admin';
  const reviewAction = (): string => button({
    label: props.loading
      ? 'Loading connection…'
      : canReview
        ? hasExactCorrection
          ? hasRegenerationSafeStop
            ? 'Carry on with the key'
            : hasRepeatedRejectionTriage
            ? 'Fix the refused key'
            : 'Correct the new key'
          : 'Look at the connection'
        : 'Dismiss',
    ariaLabel: props.loading
      ? `Loading connection ${identity}`
      : canReview && hasExactCorrection
        ? hasRegenerationSafeStop
          ? `Carry on with the key for ${identity}`
          : hasRepeatedRejectionTriage
          ? `Fix the key the provider keeps refusing for ${identity}`
          : `Correct the refused new key for ${identity}`
        : undefined,
    size: 'xs',
    action: 'connections-review-credential-rotation',
    data: { kind: recovery.kind, name: recovery.name },
    disabled: props.loading,
  });
  let message: string;
  let action = '';
  if (recovery.serverUpdateProgress !== undefined) {
    const progress = recovery.serverUpdateProgress;
    const verification = recoveryVerification;
    const operation = progress.operation === 'update' ? 'update' : 'rollback';
    // ⛔ What is happening and what to do, in the owner's words (2026-10-29).
    // These used to say what tabs pass each other ("an opaque ID for the
    // selected server profile…") and narrate receipts, closures and browser
    // latches, none of which the owner can act on. The update may come from
    // this very tab, so no line says which tab sent it.
    const doing = progress.operation === 'update'
      ? 'updating your server'
      : 'taking your server back to its previous version';
    const paused = `Swapping the key for ${identity}, and updates, stay paused.`;
    message = progress.phase === 'applying'
      ? `Recued is ${doing}. This tab stays on ${identity} and waits; nothing is sent twice.`
      : progress.operationId === undefined
        ? `Your server accepted the ${operation} and is restarting. This tab stays on ${identity} and offers to check the key once it has reconnected.`
        : verification?.phase === 'waiting'
          ? verification.reason === 'restart_pending'
            ? `Your server is still restarting after the ${operation}. Recued asks again by itself. Swapping the key for ${identity} waits until then.`
            : `Recued could not confirm the ${operation} yet and tries again by itself. Swapping the key for ${identity} waits until it can.`
        : verification?.phase === 'retryable'
          ? `Recued could not confirm the ${operation} after several tries. ${paused} Try again from Server Updates or the Account menu; switching to another server does not settle it.`
        : verification?.phase === 'reviewing_closure'
          ? `Closing this unanswered ${operation} is waiting in Server Updates. Finish or cancel it there. ${paused}`
        : verification?.phase === 'closing'
          ? `Your server is checking the ${operation} once more, and that no other update is running, before it writes down that it could not tell how it went. ${paused}`
        : verification?.phase === 'closed'
          ? `Your server wrote down that it could not tell how the ${operation} went. It does not say it worked or failed. Check how the server is now, in Server Updates or the Account menu, before anything else changes it.`
        : verification?.phase === 'checking_baseline'
          ? `Recued is reading how your server is now: the version it runs, its update state, and what ${identity} is doing. How the ${operation} went is still unknown, and updates stay paused.`
        : verification?.phase === 'baseline_retryable'
          ? `Recued could not read how your server is now. Reconnect if you need to, then try again in Server Updates or the Account menu. ${paused}`
        : verification?.phase === 'baseline_confirmed'
          ? (() => {
              const baseline = verification.baseline;
              if (baseline === undefined) {
                return `Recued could not read everything about how your server is now. ${paused}`;
              }
              const affected = baseline.affectedConnection;
              const connectionCopy = affected === undefined
                ? 'no connection is affected'
                : affected.activity === 'idle'
                  ? `${affected.kind}/${affected.name} has no key check waiting`
                  : affected.activity === 'pending'
                    ? `${affected.kind}/${affected.name} has a key check waiting`
                    : `${affected.kind}/${affected.name} is checked again when you go back`;
              const finishCopy =
                verification.reason === 'finish_unavailable'
                  ? ' This browser could not finish tidying up: choose Try finishing again in Server Updates or the Account menu. Nothing runs on the server twice.'
                  : ' Look it over in Server Updates or the Account menu, then finish recovery there.';
              return `Your server now runs ${baseline.currentVersion} on the ${baseline.channel} channel; ${serverUpdateBaselinePostureCopy[baseline.updateStatus]}; ${connectionCopy}.${finishCopy} How the ${operation} went is still unknown.`;
            })()
        : verification?.phase === 'finishing'
          ? `Recued knows how your server is now and is tidying up in this browser. Swapping the key for ${identity} waits until that is done. How the ${operation} went is still unknown.`
        : verification?.phase === 'unknown'
          ? verification.reason === 'operation_mismatch'
            ? `Your server says this was not the ${operation} Recued expected. Check in the Account menu that you picked the right server, and copy the details there, before you try again. ${paused}`
            : verification.reason === 'closure_in_flight'
              ? `Your server said no, because another update or rollback is running. Wait for it to finish, then check again. ${paused}`
              : verification.reason === 'closure_unavailable'
                ? `Your server could not write down that it could not tell how the ${operation} went. Try again, or send the details to whoever looks after this server. ${paused}`
                : `Your server does not know about this ${operation}. Check in the Account menu that you picked the right server. Then try again, copy the details to share, or close it in Server Updates. ${paused}`
        : `Your server accepted the ${operation} and is restarting. This tab stays on ${identity} and offers to check the key once the server confirms the ${operation} finished.`;
  } else if (recovery.phase === 'checking') {
    message = `Checking how swapping the key for ${identity} went…`;
  } else if (recovery.phase === 'pending') {
    message = `The server has the new key for ${identity} and is still checking it. Wait for the result before you try again.`;
    action = button({
      label: 'Check the result',
      size: 'xs',
      action: 'connections-check-credential-rotation',
    });
  } else if (recovery.phase === 'safe_stop_checking') {
    message = `Another tab says Recued stopped swapping the key for ${identity}. This tab is checking that with your server before it shows what to do next.`;
  } else if (recovery.phase === 'safe_stop_unconfirmed') {
    message = `Another tab says Recued stopped swapping the key for ${identity}, but this tab could not check that with your server. Swapping the key stays paused here. Reconnect and check again, or carry on in the tab where the provider refused the key.`;
    action = button({
      label: 'Check again',
      size: 'xs',
      action: 'connections-check-credential-safe-stop',
      data: { kind: recovery.kind, name: recovery.name },
    });
  } else if (recovery.phase === 'safe_stopped') {
    const exactEditorOpen = props.dialog.stage === 'form'
      && props.dialog.mode === 'edit'
      && props.dialog.editingId === connectionRowKey(
        recovery.kind,
        recovery.name,
      );
    const exactRecoveryVisible = exactEditorOpen
      && props.dialog.credentialCorrection?.triage?.resolution
        === 'regenerate_credential_or_contact_admin';
    const queueCopy = (recovery.outstandingSafeStopCount ?? 0) > 1
      ? ` ${recovery.outstandingSafeStopCount! - 1} other connection${recovery.outstandingSafeStopCount === 2 ? '' : 's'} also ${recovery.outstandingSafeStopCount === 2 ? 'needs' : 'need'} recovery; Recued will offer the next one when you return to the list.`
      : '';
    message = (exactRecoveryVisible
      ? `Your server confirms Recued stopped swapping the key for ${identity}, because the provider kept refusing the new one. The draft is only in this tab. Make a new key at the provider, or send the details to whoever manages it. Change the key, or fix the setup at the provider, before Recued checks again.`
      : exactEditorOpen
        ? `Your server confirms Recued stopped swapping the key for ${identity}, but the sign-in method the provider refused differs from this draft. Saving stays paused. Choose Carry on with the key to discard this draft, set the form back to the refused sign-in method, and get the details to share.`
        : `Your server confirms another tab stopped swapping the key for ${identity}. The saved key still works. You can carry on here: make a new key at the provider, or send the details to whoever manages it.`) + queueCopy;
    if (!exactRecoveryVisible) action = reviewAction();
  } else if (recovery.phase === 'handoff') {
    message = `This tab's earlier try at swapping the key for ${identity} ended, and another tab is checking the next one. This page updates when that tab is done. Do not start another swap here.`;
    action = button({
      label: 'Check again',
      size: 'xs',
      action: 'connections-check-credential-rotation',
    });
  } else if (recovery.phase === 'handoff_waiting') {
    message = `This tab's earlier try at swapping the key for ${identity} ended, but Recued could not check the connection now. It checks again after reconnecting. Do not try again from this tab yet.`;
    action = button({
      label: 'Check again',
      size: 'xs',
      action: 'connections-check-credential-rotation',
    });
  } else if (recovery.phase === 'resumable') {
    const exactDraftOpen = props.dialog.stage === 'form'
      && props.dialog.mode === 'edit'
      && props.dialog.editingId === connectionRowKey(
        recovery.kind,
        recovery.name,
      );
    if (exactDraftOpen) {
      const earlierOutcome = recovery.failureReason === undefined
        ? 'The earlier replacement was not applied.'
        : credentialRotationFailureCopy(recovery.failureReason);
      message = hasRegenerationSafeStop
        ? `No newer key was saved for ${identity}, and swapping it stays stopped in this tab. Your new key is only in this tab. Make a new key at the provider, send the details to whoever manages it, or confirm the provider fixed the setup before Recued checks again.`
        : `No newer key was saved for ${identity}, so you can carry on in this tab. Your new key is only here. ${earlierOutcome} Check or correct it, then choose Verify and replace. Recued checks that nothing else is swapping this key before it sends.`;
    } else {
      message = `No newer version of ${identity} was saved. Look at the connection before you enter another key.`;
      action = reviewAction();
    }
  } else if (recovery.phase === 'editor_ready') {
    const exactCleanEditorOpen = props.dialog.stage === 'form'
      && props.dialog.mode === 'edit'
      && props.dialog.editingId === connectionRowKey(
        recovery.kind,
        recovery.name,
      );
    if (exactCleanEditorOpen) {
      message = `The safety check finished and the blank form for ${identity} is ready. Nothing typed before was kept. Enter the new key below; Recued checks that nothing else is swapping it before it sends.`;
    } else {
      message = `The blank form for ${identity} closed before anything was typed. Carry on when you are ready; Recued runs the safety check again before it reopens the form. Nothing typed before comes back.`;
      action = button({
        label: props.loading
          ? 'Loading connection…'
          : canReview
            ? 'Reopen the blank form'
            : 'Dismiss',
        ariaLabel: props.loading
          ? `Loading connection ${identity}`
          : canReview
            ? `Reopen the blank form for ${identity} after running its safety check again`
            : `Dismiss this for ${identity}`,
        size: 'xs',
        action: canReview
          ? 'connections-start-fresh-credential-rotation'
          : 'connections-dismiss-credential-rotation',
        data: { kind: recovery.kind, name: recovery.name },
        disabled: props.loading,
      });
    }
  } else if (recovery.phase === 'restart_ready') {
    const exactCleanEditorOpen = props.dialog.stage === 'form'
      && props.dialog.mode === 'edit'
      && props.dialog.editingId === connectionRowKey(
        recovery.kind,
        recovery.name,
      );
    const earlierOutcome = recovery.failureReason === undefined
      ? 'The earlier replacement was not applied.'
      : credentialRotationFailureCopy(recovery.failureReason);
    if (exactCleanEditorOpen) {
      message = `No newer key was saved for ${identity}. Nothing typed before is here, because Recued never stores an unfinished key. ${earlierOutcome} Enter the new key below. Recued checks that nothing else is swapping it before it sends.`;
    } else {
      message = `No newer key was saved for ${identity}. Nothing typed before is here, because Recued never stores an unfinished key. ${earlierOutcome} Choose Start fresh to open a blank form. Recued checks that nothing else is swapping it before it sends.`;
      action = button({
        label: props.loading
          ? 'Loading connection…'
          : canReview
            ? 'Start fresh'
            : 'Dismiss',
        ariaLabel: props.loading
          ? `Loading connection ${identity}`
          : canReview
            ? `Start swapping the key for ${identity} again with a blank form`
            : `Dismiss this for ${identity}`,
        size: 'xs',
        action: canReview
          ? 'connections-start-fresh-credential-rotation'
          : 'connections-dismiss-credential-rotation',
        data: { kind: recovery.kind, name: recovery.name },
        disabled: props.loading,
      });
    }
  } else if (recovery.phase === 'restart_checking') {
    message = recovery.returnedFromServerUpdate === true
      ? `Checking the updated server and the saved ${identity} before opening a blank form…`
      : `Checking the server and the saved ${identity} again before opening a blank form…`;
    action = button({
      label: 'Checking server…',
      ariaLabel: `Checking whether swapping the key for ${identity} can start again`,
      size: 'xs',
      action: 'connections-start-fresh-credential-rotation',
      data: { kind: recovery.kind, name: recovery.name },
      disabled: true,
    });
  } else if (recovery.phase === 'restart_triaging') {
    message = `The updated server still cannot do the safety check for ${identity}. Checking its version and updates before suggesting what to do…`;
    action = button({
      label: 'Checking server…',
      ariaLabel: `Checking the running version and update state for the server used by ${identity}`,
      size: 'xs',
      action: 'connections-start-fresh-credential-rotation',
      data: { kind: recovery.kind, name: recovery.name },
      disabled: true,
    });
  } else if (recovery.phase === 'restart_handoff') {
    message = `Another tab or device is checking a new key for ${identity}. Nothing to enter here yet. Check again once it is done.`;
    action = button({
      label: 'Check again',
      ariaLabel: `Check whether the other check of the key for ${identity} is done`,
      size: 'xs',
      action: 'connections-start-fresh-credential-rotation',
      data: { kind: recovery.kind, name: recovery.name },
    });
  } else if (recovery.phase === 'restart_waiting') {
    message = recovery.returnedFromServerUpdate === true
      ? `Recued could not yet check the updated server and the saved ${identity}. No key was sent. Let this tab reconnect, then try again.`
      : `Recued could not check the server and the saved ${identity}. No key was sent, and you can still start fresh. Reconnect or try again.`;
    action = button({
      label: 'Try again',
      ariaLabel: `Try the safety check for ${identity} again`,
      size: 'xs',
      action: 'connections-start-fresh-credential-rotation',
      data: { kind: recovery.kind, name: recovery.name },
    });
  } else if (recovery.phase === 'restart_unsupported') {
    const triage = recovery.serverUpdateTriage;
    message = recovery.returnedFromServerUpdate === true && triage !== undefined
      ? `${serverUpdateTriageReasonCopy(triage)} ${serverUpdateTriageEvidenceCopy(triage)} No key was sent.`
      : recovery.returnedFromServerUpdate === true
        ? `This server still cannot do the safety check needed to swap the key for ${identity}, and Recued could not check its updates. Check you picked the right server before you try again. No key was sent.`
      : `This server cannot do the safety check needed to swap the key for ${identity}. Update the server, then try again. No key was sent.`;
    const guideAction = props.credentialRotationServerUpdateGuideAvailable === true
      ? button({
          label: triage?.reason === 'update_still_available'
            ? 'Continue server update'
            : recovery.returnedFromServerUpdate === true
              ? 'Review server profile'
              : 'Review update steps',
          ariaLabel: recovery.returnedFromServerUpdate === true
            ? `Look at the server you picked and what Recued found for ${identity}`
            : `Review server update steps for ${identity}`,
          variant: 'primary',
          size: 'xs',
          action: 'connections-review-server-update',
          data: { kind: recovery.kind, name: recovery.name },
        })
      : '';
    action = `${guideAction}${button({
      label: 'Check again',
      ariaLabel: `Check again whether the server can do the safety check for ${identity}`,
      size: 'xs',
      action: 'connections-start-fresh-credential-rotation',
      data: { kind: recovery.kind, name: recovery.name },
    })}${button({
      label: 'Dismiss',
      ariaLabel: `Dismiss this for ${identity}`,
      variant: 'link',
      size: 'xs',
      action: 'connections-dismiss-credential-rotation',
      data: { kind: recovery.kind, name: recovery.name },
    })}`;
  } else if (recovery.phase === 'restart_resolved') {
    message = `A safety check says this server can check a new key for ${identity}. You stayed on this page and no form opened. Carry on here when you are ready; Recued reads the server and the saved connection again before it opens a blank form.`;
    action = `${button({
      label: props.loading
        ? 'Loading connection…'
        : canReview
          ? 'Continue in this tab'
          : 'Dismiss',
      ariaLabel: props.loading
        ? `Loading connection ${identity}`
        : canReview
          ? `Carry on checking the new key for ${identity} in this tab`
          : `Dismiss this for ${identity}`,
      variant: canReview ? 'primary' : 'secondary',
      size: 'xs',
      action: canReview
        ? 'connections-start-fresh-credential-rotation'
        : 'connections-dismiss-credential-rotation',
      data: { kind: recovery.kind, name: recovery.name },
      disabled: props.loading,
    })}${canReview ? button({
      label: 'Dismiss',
      ariaLabel: `Dismiss this for ${identity}`,
      variant: 'link',
      size: 'xs',
      action: 'connections-dismiss-credential-rotation',
      data: { kind: recovery.kind, name: recovery.name },
    }) : ''}`;
  } else if (recovery.phase === 'superseded') {
    message = canReview
      ? `Another tab or device saved a newer version of ${identity} while this tab was away. Recued kept the newer one; look at it before you change anything.`
      : `${identity} was removed while this tab was away. Recued kept what the server has; dismiss this when you are ready.`;
    action = reviewAction();
  } else if (recovery.phase === 'waiting') {
    message = `The result for ${identity} is not confirmed yet. Recued checks again when this server reconnects; do not enter another key meanwhile.`;
    action = button({
      label: 'Check the result',
      size: 'xs',
      action: 'connections-check-credential-rotation',
    });
  } else if (recovery.phase === 'not_received') {
    message = `The server has no record of this new key for ${identity}, so it was not used. Look at the connection before you try again.`;
    action = reviewAction();
  } else if (recovery.phase === 'unsupported') {
    message = `This server cannot tell how swapping the key for ${identity} went. Look at the connection and test it before you decide whether to try again.`;
    action = reviewAction();
  } else if (hasRegenerationSafeStop) {
    const exactEditorOpen = props.dialog.stage === 'form'
      && props.dialog.mode === 'edit'
      && props.dialog.editingId === connectionRowKey(
        recovery.kind,
        recovery.name,
      );
    message = exactEditorOpen
      ? `Recovery is open for ${identity}. The saved key still works, and an unfinished key never comes back after a reload. Verify and replace waits until you enter a new key. If this tab still holds the refused one, you can instead confirm the provider fixed the setup, and Recued checks once more.`
      : `Your server refused another new key for ${identity} after checking the provider and its address. The saved key still works, and no unfinished key was stored. Carry on to make a new key at the provider, or get the details to send to whoever manages it.`;
    if (!exactEditorOpen) action = reviewAction();
  } else {
    message = `${credentialRotationFailureCopy(recovery.failureReason)} Look at ${identity} and enter the new key again when you are ready.`;
    action = reviewAction();
  }
  if (recoveryVerification?.phase === 'completed') {
    const baseline = recoveryVerification.baseline;
    const currentState = baseline === undefined
      ? 'What it read about the server is no longer here.'
      : `Your server runs ${baseline.currentVersion} on the ${baseline.channel} channel; ${serverUpdateBaselinePostureCopy[baseline.updateStatus]}.`;
    message =
      `Recovery is finished, and update and roll back work again. ${currentState} `
      + `How the ${recoveryVerification.operation} went is still unknown. `
      + message;
  }
  const recoveryBusy = (
    recovery.serverUpdateProgress !== undefined
    && (
      recovery.serverUpdateVerification === undefined
      || recovery.serverUpdateVerification.phase === 'checking'
      || recovery.serverUpdateVerification.phase === 'waiting'
      || recovery.serverUpdateVerification.phase === 'closing'
      || recovery.serverUpdateVerification.phase === 'checking_baseline'
      || recovery.serverUpdateVerification.phase === 'finishing'
    )
  )
    || recovery.phase === 'restart_checking'
    || recovery.phase === 'restart_triaging'
    || recovery.phase === 'safe_stop_checking';
  return `<section class="connections-credential-recovery" data-connection-credential-recovery="${e(recovery.phase)}" role="status" aria-live="polite" aria-atomic="true" aria-busy="${recoveryBusy ? 'true' : 'false'}"${recoveryBusy ? ' tabindex="-1"' : ''}>
    <div>${e(message)}</div>
    ${action === '' ? '' : `<div class="connections-credential-recovery-action">${action}</div>`}
  </section>`;
};

const renderListView = (props: ConnectionsPageProps): string => {
  if (props.loading) {
    return `
      <p class="connections-loading">Loading enrolled connections…</p>
    `;
  }
  if (props.error) {
    return inlineError(props.error);
  }
  const filters = props.inventoryFilters;
  const visible = props.connections.filter(row => (!filters?.query || [row.display_name, row.name, row.vendor, row.base_url].join(' ').toLowerCase().includes(filters.query.toLowerCase()))
    && (!filters?.vendor || row.vendor === filters.vendor)
    && (!filters?.status || (filters.status === 'checked' ? healthOfView(row)?.status === 'ok' && !healthOfView(row)?.last_error
      : filters.status === 'attention' ? ['auth_failed', 'unreachable'].includes(healthOfView(row)?.status ?? '') || !!healthOfView(row)?.last_error
      : !healthOfView(row) || healthOfView(row)?.status === 'unknown')));
  const groups = groupByKind(visible);
  const installedPacks = props.installedPacks ?? [];
  const groupBlocks = KIND_ORDER.map((kind) =>
    renderKindGroup(
      kind,
      groups[kind],
      props.probeInFlight,
      props.deleteInFlight,
      props.engagementHealth,
      installedPacks,
      props.mcpPackStatus,
      props.signInGrids === true,
      props.managedOAuthAvailable === true,
    ),
  ).join('');
  const empty =
    props.connections.length === 0
      ? emptyHint({
          message:
            'No connections enrolled yet. Recipes that need outbound access prompt for enrollment at install time. You can also add one ahead of time below.',
        })
      : '';
  return `
    <div class="connections-add-row">${button({ label: '+ Add Connection', variant: 'primary', size: 'sm', action: 'connections-open-add' })}</div>
    ${props.connections.length ? `<div class="connections-inventory-filters" role="group" aria-label="Filter connections">
      <label>Search connections<input type="search" data-conn-inventory-filter="query" value="${e(filters?.query ?? '')}" autocomplete="off"></label>
      <label>Vendor<select data-conn-inventory-filter="vendor"><option value="">All vendors</option>${[...new Set(props.connections.map(row => row.vendor).filter((vendor): vendor is string => typeof vendor === 'string' && !!vendor))].map(vendor => `<option value="${e(vendor)}"${filters?.vendor === vendor ? ' selected' : ''}>${e(vendor)}</option>`).join('')}</select></label>
      <label>Status<select data-conn-inventory-filter="status"><option value="">All statuses</option><option value="checked"${filters?.status === 'checked' ? ' selected' : ''}>Last check passed</option><option value="attention"${filters?.status === 'attention' ? ' selected' : ''}>Needs attention</option><option value="unknown"${filters?.status === 'unknown' ? ' selected' : ''}>Not verified</option></select></label>
      <span role="status">${visible.length} of ${props.connections.length}</span></div>` : ''}
    ${renderRecentProbe(
      props.dialog,
      props.postSafeStopRecoveries,
      props.postSafeStopProfileLabel,
    )}
    ${renderPackInventoryRecovery(props.packInventoryRecovery)}
    ${empty}
    ${groupBlocks}
    ${props.connections.length && !visible.length ? inlineHint('No connections match these filters.') : ''}
  `;
};

// R13 — the per-vendor preset cards retired: one generic free-edit "Add API
// connection" form covers every vendor (any auth type, base URL, OAuth
// endpoints + scopes). Recognition / auto-detect returns later as a
// convenience pre-fill, never a gate.
const renderKindPicker = (): string => `
  <div class="connections-picker">
    <h3 class="connections-picker-title" data-connection-dialog-heading tabindex="-1">Pick a connection kind</h3>
    <div class="connections-picker-section">
      <div class="connections-picker-grid">
        ${CONNECTION_KIND_CHOICES.map((c) => `
          <button type="button"
            class="connections-picker-card"
            data-action="connections-pick-kind"
            data-kind="${e(c.kind)}">
            <strong>${e(c.label)}</strong>
            <span class="connections-picker-card-desc">${e(c.description)}</span>
          </button>
        `).join('')}
      </div>
    </div>
    <div class="connections-dialog-actions">
      ${button({ label: 'Cancel', size: 'sm', action: 'connections-cancel-dialog' })}
    </div>
  </div>
`;

const renderSubtypePicker = (kind: 'mcp' | 'notification'): string => `
  <div class="connections-picker">
    <h3 class="connections-picker-title" data-connection-dialog-heading tabindex="-1">Pick a ${e(KIND_LABELS[kind])} subtype</h3>
    <div class="connections-picker-grid">
      ${CONNECTION_SUBTYPE_CHOICES[kind].map((c) => `
        <button type="button"
          class="connections-picker-card"
          data-action="connections-pick-subtype"
          data-subtype="${e(c.subtype)}">
          <strong>${e(c.label)}</strong>
          <span class="connections-picker-card-desc">${e(c.description)}</span>
        </button>
      `).join('')}
    </div>
    <div class="connections-dialog-actions">
      ${button({ label: 'Back', size: 'sm', action: 'connections-back-to-kind' })}
      ${button({ label: 'Cancel', size: 'sm', action: 'connections-cancel-dialog' })}
    </div>
  </div>
`;

const fieldId = (key: string): string => `conn-field-${key.replace(/\./g, '-')}`;

/** D-127 P4.3 — resolve the option list for a select field. Static
 *  `field.options` and dynamic `field.options_source` are mutually
 *  exclusive in spec; when both are set the dynamic source wins so a
 *  schema migration can't accidentally surface stale static defaults.
 *  Returns the list + an `isDynamic` flag the renderer uses to decide
 *  whether to surface the empty-guidance + disabled-control UX. */
const resolveSelectOptions = (
  field: ConnectionField,
  dynamicOptions: Record<string, readonly string[]> | undefined,
): { options: readonly string[]; isDynamic: boolean } => {
  if (field.options_source) {
    const list = dynamicOptions?.[field.options_source] ?? [];
    return { options: list, isDynamic: true };
  }
  return { options: field.options ?? [], isDynamic: false };
};

/** One row of a `header-list` field — a `header_name` text input + a `value`
 *  secret input + a Remove button. The inputs carry `data-conn-field` so the
 *  host's delegated input listener syncs them like every other field; Remove is
 *  a `data-action`. `position` is the 1-based display order; `total` gates the
 *  Remove button so the last row can't be removed (one row always stays). */
const renderHeaderRow = (
  baseKey: string,
  row: HeaderRow,
  position: number,
  total: number,
  saving: boolean,
  credentialRejected = false,
  // ⚠ The two list fields differ ONLY here. Threading the field type rather
  // than duplicating the renderer keeps the remove-button wiring, the
  // credential-rejection focus target and the password masking identical for
  // both — three behaviours a copy would have to re-earn.
  listType: 'header-list' | 'body-field-list' = 'header-list',
): string => {
  const isBody = listType === 'body-field-list';
  const noun = isBody ? 'field' : 'header';
  const nameKey = `${baseKey}.${row.index}.${nameKeyForListField(listType)}`;
  const valueKey = `${baseKey}.${row.index}.value`;
  const nameInput = textInput({
    id: fieldId(nameKey),
    type: 'text',
    value: row.name,
    placeholder: isBody ? 'access_token' : 'X-API-Key',
    spellcheck: false,
    disabled: saving,
    ariaLabel: `${isBody ? 'Field' : 'Header'} ${position} name`,
    ariaInvalid: credentialRejected,
    ariaErrormessage: credentialRejected
      ? 'connections-credential-correction-message'
      : undefined,
    data: { 'conn-field': nameKey },
    extraClass: 'connections-header-name',
  });
  const valueInput = textInput({
    id: fieldId(valueKey),
    type: 'password',
    value: row.value,
    autocomplete: 'off',
    spellcheck: false,
    disabled: saving,
    ariaLabel: `${isBody ? 'Field' : 'Header'} ${position} value`,
    ariaInvalid: credentialRejected,
    ariaErrormessage: credentialRejected
      ? 'connections-credential-correction-message'
      : undefined,
    data: { 'conn-field': valueKey },
    extraClass: 'connections-header-value',
  });
  const removeBtn = button({
    label: 'Remove',
    action: 'connections-remove-header',
    size: 'sm',
    variant: 'secondary',
    extraClass: 'connections-header-remove',
    disabled: saving || total <= 1,
    ariaLabel: `Remove ${noun} ${position}`,
    // ⚠ `name-key` rides the dataset because the click handler lives in the
    // webclient panel, which sees only what the button carries — deriving it
    // there would mean re-deriving the field type from the schema by key.
    data: {
      'header-index': String(row.index),
      'base-key': baseKey,
      'name-key': nameKeyForListField(listType),
    },
  });
  return `<div class="connections-header-row" data-header-row="${row.index}">${nameInput}${valueInput}${removeBtn}</div>`;
};

/** Render a `header-list` field — the repeatable 1..N credential-header rows +
 *  an "Add header" button (disabled at `MAX_HEADER_AUTH_ENTRIES`). Defaults to
 *  one empty row. UX only; the server re-validates via `validateHeaderAuthEntries`. */
const renderHeaderList = (
  field: ConnectionField,
  values: ConnectionFormValues,
  saving: boolean,
  credentialRejected = false,
): string => {
  const listType = field.type === 'body-field-list' ? 'body-field-list' : 'header-list';
  const collected = collectHeaderRows(values, field.key, nameKeyForListField(listType));
  const rows: HeaderRow[] =
    collected.length > 0 ? collected : [{ index: 0, header_name: '', name: '', value: '' }];
  const rowsHtml = rows
    .map((r, i) => renderHeaderRow(
      field.key,
      r,
      i + 1,
      rows.length,
      saving,
      credentialRejected,
      listType,
    ))
    .join('');
  const addBtn = button({
    label: listType === 'body-field-list' ? '+ Add field' : '+ Add header',
    action: 'connections-add-header',
    size: 'sm',
    variant: 'secondary',
    extraClass: 'connections-header-add',
    disabled: saving || rows.length >= MAX_HEADER_AUTH_ENTRIES,
    data: { 'base-key': field.key, 'name-key': nameKeyForListField(listType) },
  });
  // `autofilled` joins `optional` here: the `*` is a claim about what the
  // OWNER must type, and an in-app flow supplies this one.
  const required = field.optional || field.autofilled
    ? ''
    : ' <span class="connections-field-required">*</span>';
  const hint = field.help ? fieldHint(field.help) : '';
  return `
    <div class="connections-field-row connections-header-list" data-field-key="${e(field.key)}"${credentialRejected
      ? ' data-credential-rejected="true" role="group" aria-describedby="connections-credential-correction-message" tabindex="-1"'
      : ''}>
      <label>${e(field.label)}${required}</label>
      <div class="connections-header-rows">${rowsHtml}</div>
      ${addBtn}
      ${hint}
    </div>
  `;
};

// D-192 M4c-UI — messenger trigger editor. Kind + mode option lists (a leading
// placeholder on kind so an untouched row carries no kind — the validator flags
// a value-without-kind rather than silently dropping it).
const MATCH_KIND_OPTIONS = [
  { value: '', label: 'Trigger on…' },
  { value: 'tag', label: '#tag' },
  { value: 'mention', label: '@mention' },
  { value: 'content', label: 'Keyword text' },
];
const MATCH_MODE_OPTIONS = [
  { value: 'contains', label: 'Anywhere' },
  { value: 'word', label: 'Whole word' },
];

/** One trigger row — a `kind` select + a `value` input + (content only) a
 *  `mode` select + Remove. Keyed `<base>.<i>.kind` / `.value` / `.mode`. */
const renderMatchPatternRow = (
  baseKey: string,
  row: MatchPatternRow,
  position: number,
  total: number,
  saving: boolean,
): string => {
  const kindKey = `${baseKey}.${row.index}.kind`;
  const valueKey = `${baseKey}.${row.index}.value`;
  const modeKey = `${baseKey}.${row.index}.mode`;
  const kindSelect = selectField({
    id: fieldId(kindKey),
    options: MATCH_KIND_OPTIONS.map((o) => ({ ...o, selected: o.value === row.kind })),
    disabled: saving,
    ariaLabel: `Trigger ${position} type`,
    data: { 'conn-field': kindKey },
    extraClass: 'connections-matchpattern-kind',
  });
  const valuePlaceholder =
    row.kind === 'content' ? 'e.g. I will send' : row.kind === 'mention' ? 'handle or user id' : 'commit';
  const valueInput = textInput({
    id: fieldId(valueKey),
    type: 'text',
    value: row.value,
    placeholder: valuePlaceholder,
    spellcheck: false,
    disabled: saving,
    ariaLabel: `Trigger ${position} value`,
    data: { 'conn-field': valueKey },
    extraClass: 'connections-matchpattern-value',
  });
  // The mode sub-control rides ONLY a content row.
  const modeSelect =
    row.kind === 'content'
      ? selectField({
          id: fieldId(modeKey),
          options: MATCH_MODE_OPTIONS.map((o) => ({ ...o, selected: o.value === (row.mode || 'contains') })),
          disabled: saving,
          ariaLabel: `Trigger ${position} match mode`,
          data: { 'conn-field': modeKey },
          extraClass: 'connections-matchpattern-mode',
        })
      : '';
  const removeBtn = button({
    label: 'Remove',
    action: 'connections-remove-pattern',
    size: 'sm',
    variant: 'secondary',
    extraClass: 'connections-matchpattern-remove',
    disabled: saving || total <= 1,
    ariaLabel: `Remove trigger ${position}`,
    data: { 'pattern-index': String(row.index), 'base-key': baseKey },
  });
  return `<div class="connections-matchpattern-row" data-pattern-row="${row.index}">${kindSelect}${valueInput}${modeSelect}${removeBtn}</div>`;
};

/** Render a `match-pattern-list` field — the repeatable trigger rows + an "Add
 *  trigger" button (capped at `MESSAGE_MATCH_MAX_PATTERNS`). Defaults to one
 *  empty row (an empty list = no triggers, which is valid). Saved via
 *  `setMatchPatterns`, NOT this form's config. */
const renderMatchPatternList = (
  field: ConnectionField,
  values: ConnectionFormValues,
  saving: boolean,
): string => {
  const collected = collectMatchPatternRows(values, field.key);
  const rows: MatchPatternRow[] =
    collected.length > 0 ? collected : [{ index: 0, kind: '', value: '', mode: '' }];
  const rowsHtml = rows
    .map((r, i) => renderMatchPatternRow(field.key, r, i + 1, rows.length, saving))
    .join('');
  const addBtn = button({
    label: '+ Add trigger',
    action: 'connections-add-pattern',
    size: 'sm',
    variant: 'secondary',
    extraClass: 'connections-matchpattern-add',
    disabled: saving || rows.length >= MESSAGE_MATCH_MAX_PATTERNS,
    data: { 'base-key': field.key },
  });
  const hint = field.help ? fieldHint(field.help) : '';
  return `
    <div class="connections-field-row connections-matchpattern-list" data-field-key="${e(field.key)}">
      <label>${e(field.label)}</label>
      <div class="connections-matchpattern-rows">${rowsHtml}</div>
      ${addBtn}
      ${hint}
    </div>
  `;
};

const renderField = (
  field: ConnectionField,
  values: ConnectionFormValues,
  dynamicOptions: Record<string, readonly string[]> | undefined,
  mode: ConnectionsDialogState['mode'],
  // Disable controls whose values an in-flight submit/OAuth attempt already
  // captured or may replace on success. The caller owns that lock boundary.
  locked = false,
  oauthErrorFieldKey: ConnectionsDialogState['oauthErrorFieldKey'] = null,
  credentialCorrectionFieldKeys: ReadonlyArray<string> = [],
  /** D-223 — field key → suggesting publisher, for the attribution marker. */
  hintedFields: Readonly<Record<string, string>> = {},
): string => {
  if (field.hidden) return '';
  if (field.showWhen && !field.showWhen(values)) return '';
  // A `header-list` renders its own repeatable-rows block, not the standard
  // single label+control wrapper.
  const credentialRejected = credentialCorrectionFieldKeys.includes(field.key);
  if (field.type === 'header-list' || field.type === 'body-field-list') {
    return renderHeaderList(field, values, locked, credentialRejected);
  }
  // A `match-pattern-list` (D-192 M4c-UI) likewise renders its own repeatable
  // trigger-rows block.
  if (field.type === 'match-pattern-list') return renderMatchPatternList(field, values, locked);
  const id = fieldId(field.key);
  const value = values[field.key] ?? '';
  const oauthInvalid = oauthErrorFieldKey === field.key;
  const errorId = credentialRejected
    ? 'connections-credential-correction-message'
    : oauthInvalid
      ? 'connections-oauth-error'
      : undefined;
  let control: string;
  let dynamicEmptyHint = '';
  let dynamicUnavailable = false;
  if (field.type === 'select') {
    const { options: optList, isDynamic } = resolveSelectOptions(field, dynamicOptions);
    const isEmpty = isDynamic && optList.length === 0;
    dynamicUnavailable = isEmpty;
    const renderedOpts = isEmpty
      ? [{
          // Empty placeholder — shown alongside the disabled select so
          // the user sees something rather than an empty dropdown that
          // looks broken. The submit-disable + emptyGuidance below
          // explain why the picker is empty.
          value: '',
          label: '— no options available —',
          selected: true,
          disabled: true,
        }]
      : [
          ...(isDynamic && value === ''
            ? [{
                value: '',
                label: '— select —',
                selected: true,
                disabled: true,
              }]
            : []),
          ...optList.map((opt) => ({
            value: opt,
            label: field.optionLabels?.[opt] ?? (field.key === 'auth.type' ? AUTH_LABELS[opt as ConnectionAuthType] : undefined) ?? opt,
            selected: opt === (value || (!isDynamic ? optList[0] || '' : '')),
          })),
        ];
    control = selectField({
      id,
      data: { 'conn-field': field.key },
      options: renderedOpts,
      disabled: isEmpty || field.readonly || locked,
    });
    if (isEmpty && field.emptyGuidance) {
      dynamicEmptyHint = `<p id="${e(id)}-empty-guidance" class="rx-msg rx-msg-warn connections-field-empty-guidance" role="note">${e(field.emptyGuidance)}</p>`;
    }
  } else if (field.type === 'json') {
    control = `
      <textarea
        id="${e(id)}"
        class="rx-input connections-field-json"
        data-conn-field="${e(field.key)}"
        rows="3"
        spellcheck="false"
        placeholder="${e(field.placeholder ?? '')}"
        ${field.readonly || locked ? 'readonly' : ''}
      >${e(value)}</textarea>
    `;
  } else {
    const inputType =
      field.type === 'secret'
        ? 'password'
        : field.type === 'url'
          ? 'url'
          : 'text';
    control = textInput({
      id,
      type: inputType,
      value,
      placeholder: field.placeholder,
      autocomplete: field.type === 'secret' ? 'off' : undefined,
      ariaInvalid: oauthInvalid || credentialRejected,
      ariaErrormessage: errorId,
      // D-165 P3.path-picker — `subresource_path` joins `name` as an
      // identity-fixed field: editable on create, read-only in edit (the
      // scope is immutable post-enrollment; re-scope = new connection).
      readonly:
        field.readonly ||
        locked ||
        (mode === 'edit' && (field.key === 'name' || field.key === 'subresource_path')),
      spellcheck: false,
      data: { 'conn-field': field.key },
    });
  }
  // `autofilled` joins `optional` here: the `*` is a claim about what the
  // OWNER must type, and an in-app flow supplies this one.
  const required = field.optional || field.autofilled
    ? ''
    : ' <span class="connections-field-required">*</span>';
  const hint = field.help ? fieldHint(field.help) : '';
  // ⚠ Wording is deliberate. "Suggested by X" tells the owner where a value came
  // from; it must NOT read as "Recued checked this". A label that looks like
  // assurance and is not is worse than no label at all.
  const suggestedBy = hintedFields[field.key];
  const attribution = suggestedBy
    ? `<p class="rx-field-hint field-hint connections-field-suggested"`
      + ` data-suggested-by="${e(suggestedBy)}">${renderProvenance({
        primary: `Suggested by ${suggestedBy}`,
        detail: 'Check it before you continue.',
        kind: 'source',
      })}</p>`
    : '';
  return `
    <div class="connections-field-row" data-field-key="${e(field.key)}"${oauthInvalid ? ' data-oauth-invalid="true"' : ''}${credentialRejected ? ' data-credential-rejected="true"' : ''}${dynamicUnavailable && field.emptyGuidance
      ? ` role="group" aria-labelledby="${e(id)}-label" aria-describedby="${e(id)}-empty-guidance" aria-disabled="true" tabindex="-1"`
      : ''}>
      <label id="${e(id)}-label" for="${e(id)}">${e(field.label)}${required}</label>
      ${control}
      ${hint}
      ${attribution}
      ${dynamicEmptyHint}
    </div>
  `;
};

export interface ConnectionFormValidationIssue {
  /** Exact schema/control key to focus. Repeatable fields may point at one
   * concrete row control; group-level failures use the schema field key. */
  readonly fieldKey: string;
  /** Stable visible label used by the "Go to …" affordance. */
  readonly fieldLabel: string;
  readonly message: string;
  /** The exact message is already rendered beside this field. The summary
   * should route to it without duplicating the same copy. */
  readonly detailAtField?: true;
  /** When "Go to <label>" would not read as English, e.g. a numbered step. */
  readonly actionLabel?: string;
}

export interface ConnectionFormValidationSummary {
  readonly status: 'blocked' | 'ready';
  readonly fieldKey: string;
  readonly title: string;
  readonly message: string;
  readonly actionLabel: string;
}

/** The authentication switch form's numbered steps, as validation targets them. */
const AUTHENTICATION_SWITCH_STEP_KEYS = {
  'sign-in': 'switch.step.sign-in',
  review: 'switch.step.review',
  check: 'switch.step.check',
} as const;

const formValidationIssue = (
  fieldKey: string,
  fieldLabel: string,
  message: string,
  detailAtField = false,
): ConnectionFormValidationIssue => ({
  fieldKey,
  fieldLabel,
  message,
  ...(detailAtField ? { detailAtField: true } : {}),
});

/** Return the first actionable connection-form problem, including the exact
 * control/group the host should focus. The string-only validator below remains
 * the compatibility boundary for existing callers. */
export const connectionFormValidationIssue = (
  schema: ConnectionSchema,
  values: ConnectionFormValues,
  dynamicOptions: Record<string, readonly string[]> | undefined,
  mode: ConnectionsDialogState['mode'],
): ConnectionFormValidationIssue | null => {
  if (schema.fields.some(field => field.key === 'switch.verification_url') && !values['auth.authorization_receipt']?.trim()) {
    // The switch form's numbered steps carry these keys (`data-field-key`), so
    // "Go to" lands on the step that comes next.
    if (values['auth.type'] === 'oauth2_refresh') {
      return values['auth.refresh_token']?.trim()
        ? { fieldKey: AUTHENTICATION_SWITCH_STEP_KEYS.review, fieldLabel: 'Review the sign-in', actionLabel: 'Go to step 2',
            message: 'Review the new sign-in’s account and permissions before you apply it.' }
        : { fieldKey: AUTHENTICATION_SWITCH_STEP_KEYS['sign-in'], fieldLabel: 'Sign in', actionLabel: 'Go to step 1',
            message: 'Authorize the new sign-in, then review its account and permissions before you apply it.' };
    }
    return { fieldKey: AUTHENTICATION_SWITCH_STEP_KEYS['sign-in'], fieldLabel: 'Broker account', actionLabel: 'Go to step 1',
      message: 'Review permissions and authorize the selected broker account before you apply it.' };
  }
  const name = values.name?.trim() ?? '';
  if (!name) return formValidationIssue('name', 'Name', 'Name is required.');
  if (mode === 'create' && !CONNECTION_NAME_REGEX.test(name)) {
    return formValidationIssue(
      'name',
      'Name',
      'Name must be lowercase letters, digits, or dashes (1–48 chars).',
    );
  }
  const display = values.display_name?.trim() ?? '';
  if (!display) {
    return formValidationIssue(
      'display_name',
      'Display name',
      'Display name is required.',
    );
  }
  const authPatchIntent = mode === 'edit'
    ? shouldPatchConnectionAuth(schema, values)
    : true;
  const authType = values['auth.type'];
  if (authPatchIntent && authType === 'managed_oauth' && !values['auth.authorization_receipt']) {
    return formValidationIssue('auth.type', 'Authorization', 'Authorize this managed OAuth connection before saving.');
  }
  if (
    authPatchIntent
    && (authType === 'oauth2_refresh' || authType === 'oauth2_client_credentials')
  ) {
    const endpointFields = authType === 'oauth2_refresh'
      ? [
          ['auth.token_endpoint', 'Token Endpoint'],
          ['auth.authorize_url', 'Authorize URL'],
        ] as const
      : [['auth.token_endpoint', 'Token Endpoint']] as const;
    for (const [fieldKey, label] of endpointFields) {
      // Required/optional emptiness remains schema-owned below. When a value
      // is present, both manual-token Save and popup preflight enforce the same
      // credential-destination boundary.
      if ((values[fieldKey] ?? '').trim().length === 0) continue;
      const issue = connectionOAuthHttpsEndpointIssue(values, fieldKey, label);
      if (issue !== null) {
        return formValidationIssue(fieldKey, label, issue.message);
      }
    }
  }
  for (const field of schema.fields) {
    if (field.showWhen && !field.showWhen(values)) continue;
    if (field.key === 'auth.client_secret' && selectedSavedOAuthAppIssuer({ vendor: null,values }) !== null) continue;
    if (mode === 'edit' && !authPatchIntent && field.key.startsWith('auth.')) continue;
    // D-127 P4.3 — dynamic-options select with an empty resolved list
    // can never be satisfied; surface the field's emptyGuidance so the
    // user sees a single coherent message at the form level (instead
    // of generic "Field is required" + the inline guidance).
    if (field.type === 'select' && field.options_source) {
      const list = dynamicOptions?.[field.options_source] ?? [];
      if (list.length === 0 && !field.optional) {
        return formValidationIssue(
          field.key,
          field.label,
          field.emptyGuidance
            ?? `${field.label}: no options available — configure a prerequisite first.`,
          field.emptyGuidance !== undefined,
        );
      }
      // D-165 P3 — a dynamic select must be SELECTED FROM its live list: a
      // non-empty value that isn't a current option is stale (e.g. an account
      // that lost send capability, a deleted instance, or an edit-prefilled
      // value the refreshed list dropped). Reject it so a stale binding can
      // never be saved. An empty value falls through to the required-field
      // check below (or is allowed when the field is optional).
      const selected = values[field.key]?.trim() ?? '';
      if (selected.length > 0 && !list.includes(selected)) {
        return formValidationIssue(
          field.key,
          field.label,
          `${field.label}: "${selected}" is no longer available — pick one of the listed options.`,
        );
      }
    }
    // header-list — a repeatable credential-header group. Each non-blank row
    // needs BOTH a name and a value (a half-filled row is an error); at least
    // one complete row is required unless the field is optional. UX only — the
    // server re-validates the shape (+ cap + proto-guard) via
    // `validateHeaderAuthEntries`, so this never diverges from that authority.
    if (field.type === 'header-list' || field.type === 'body-field-list') {
      const nameKey = nameKeyForListField(field.type);
      const noun = field.type === 'body-field-list' ? 'field' : 'header';
      let complete = 0;
      for (const row of collectHeaderRows(values, field.key, nameKey)) {
        const hasName = row.name.trim().length > 0;
        const hasValue = row.value.trim().length > 0;
        if (hasName !== hasValue) {
          const missingKey = hasName ? 'value' : nameKey;
          return formValidationIssue(
            `${field.key}.${row.index}.${missingKey}`,
            field.label,
            `${field.label}: each ${noun} needs both a name and a value.`,
          );
        }
        if (hasName) complete += 1;
      }
      if (!field.optional && complete === 0) {
        return formValidationIssue(
          `${field.key}.0.${nameKey}`,
          field.label,
          `${field.label}: add at least one ${noun} (name and value).`,
        );
      }
      continue;
    }
    // match-pattern-list (D-192 M4c-UI) — a repeatable messenger trigger group.
    // A half-filled row (a kind with no value, or a value with no kind) is an
    // error; the complete rows are then re-checked against the SAME contracts
    // rule the server enforces on `setMatchPatterns` (token grammar / cap), so
    // the two never diverge. An empty list is valid (no triggers).
    if (field.type === 'match-pattern-list') {
      const rows = collectMatchPatternRows(values, field.key);
      for (const row of rows) {
        if (isHalfFilledMatchPatternRow(row)) {
          const missingKey = row.kind.trim().length > 0 ? 'value' : 'kind';
          return formValidationIssue(
            `${field.key}.${row.index}.${missingKey}`,
            field.label,
            `${field.label}: each trigger needs both a type and a value.`,
          );
        }
      }
      // Keep the focus-path index aligned with the compiler below: complete
      // rows carrying a stale/unknown kind are dropped by that compiler.
      const compiledRows = rows.filter((row) =>
        isCompleteMatchPatternRow(row)
        && (row.kind === 'tag' || row.kind === 'mention' || row.kind === 'content'));
      const problems = validateMessageMatchPatterns(
        matchPatternRowsToPatterns(rows),
      );
      if (problems.length > 0) {
        const path = /^patterns\[(\d+)\]\.(kind|value|mode)/u.exec(
          problems[0] ?? '',
        );
        const pathRow = path === null ? undefined : compiledRows[Number(path[1])];
        const fieldKey = pathRow === undefined || path?.[2] === undefined
          ? field.key
          : `${field.key}.${pathRow.index}.${path[2]}`;
        return formValidationIssue(
          fieldKey,
          field.label,
          `${field.label}: ${problems[0]}`,
        );
      }
      continue;
    }
    const raw = values[field.key] ?? '';
    // Inbound verification material is deliberately absent from
    // ConnectionView. An edit may leave it blank because the server merge keeps
    // the saved value; create mode still requires it, and switching to webhook
    // without a preserved value is rejected authoritatively by the server.
    if (
      mode === 'edit'
      && raw.trim().length === 0
      && field.key.startsWith('config.')
      && CONNECTION_INBOUND_SECRET_FIELDS.includes(field.key.slice('config.'.length))
    ) continue;
    if (field.optional) continue;
    if (raw.trim().length === 0) {
      return formValidationIssue(
        field.key,
        field.label,
        // An autofilled field is still blocking, but telling the owner it "is
        // required" names an obligation they cannot discharge by typing. Name
        // the action that fills it instead.
        field.autofilled
          ? `${field.label}: click Authorize to obtain one.`
          : `${field.label} is required.`,
      );
    }
  }
  return null;
};

/** Validate a connection enrollment / edit form. Returns the first
 * human-readable error message, or `null` when the form is submittable. */
export const validateConnectionForm = (
  schema: ConnectionSchema,
  values: ConnectionFormValues,
  dynamicOptions: Record<string, readonly string[]> | undefined,
  mode: ConnectionsDialogState['mode'],
): string | null => connectionFormValidationIssue(
  schema,
  values,
  dynamicOptions,
  mode,
)?.message ?? null;

/** Shared copy/projection for both the pure renderer and the browser host's
 * focus-preserving live updates. "Complete" is deliberately local-form
 * language: provider/server verification has not happened yet. */
export const connectionFormValidationSummary = (
  issue: ConnectionFormValidationIssue | null,
  /** An authentication switch is applied after an access check, not saved. */
  switching = false,
): ConnectionFormValidationSummary => issue === null
  ? {
      status: 'ready',
      fieldKey: '',
      title: switching ? 'Ready to verify' : 'Required details complete',
      message: switching
        ? 'Recued checks access with the new sign-in, then switches to it.'
        : 'Review the values before saving.',
      actionLabel: 'Go to first incomplete field',
    }
  : {
      status: 'blocked',
      fieldKey: issue.fieldKey,
      title: `Next: ${issue.fieldLabel}`,
      message: issue.detailAtField === true
        ? 'Review the prerequisite shown with this field.'
        : issue.message,
      actionLabel: issue.actionLabel ?? `Go to ${issue.fieldLabel}`,
    };

/** Let the validation checkpoint speak only when no more specific receipt,
 * conflict, server/OAuth error, or guide transition owns the announcement.
 * Shared with the host so silent edits preserve the same accessibility
 * contract as a full render. */
export const connectionFormValidationShouldAnnounce = (
  dialog: ConnectionsDialogState,
  issue: ConnectionFormValidationIssue | null,
): boolean => {
  const hasMatchingRecoveredReceipt = dialog.recentProbe?.recovered === true
    && dialog.editingId === connectionRowKey(
      dialog.recentProbe.kind,
      dialog.recentProbe.name,
    );
  return !hasMatchingRecoveredReceipt
    && dialog.externalChange === null
    && dialog.credentialRotationOwnership === null
    && dialog.credentialCorrection === null
    && dialog.credentialSafeStopClosureNotice === null
    && (
      dialog.error === null
      || dialog.error === issue?.message
    )
    && dialog.oauthError === null
    && !dialog.oauthNeedsReauthorization
    && dialog.setupGuide.error === null
    && dialog.setupGuide.stage !== 'loading'
    && dialog.setupGuide.stage !== 'ready';
};

const visibleCredentialCorrectionFields = (
  dialog: ConnectionsDialogState,
  schema: ConnectionSchema,
): ConnectionField[] => {
  const keys = dialog.credentialCorrection?.fieldKeys ?? [];
  const seen = new Set<string>();
  const fields: ConnectionField[] = [];
  for (const key of keys) {
    const field = schema.fields.find((candidate) =>
      candidate.key === key
      && !candidate.hidden
      && !candidate.readonly
      && (candidate.showWhen?.(dialog.values) ?? true));
    if (field === undefined || seen.has(field.key)) continue;
    seen.add(field.key);
    fields.push(field);
  }
  return fields;
};

const GUIDE_AUTH_LABELS: Record<string, string> = {
  none: 'No authentication',
  bearer: 'A key you paste in',
  basic: 'Username and password',
  header: 'Credential headers',
  query: 'Query parameter',
  oauth2_refresh: 'OAuth with refresh token',
  oauth2_client_credentials: 'An OAuth app keys',
  atproto_session: 'AT Protocol app password',
};

const visibleCredentialTriageFields = (
  dialog: ConnectionsDialogState,
  schema: ConnectionSchema,
): ConnectionField[] => {
  const keys = dialog.credentialCorrection?.triage?.endpointFieldKeys ?? [];
  const seen = new Set<string>();
  const fields: ConnectionField[] = [];
  for (const key of keys) {
    const field = schema.fields.find((candidate) =>
      candidate.key === key
      && !candidate.hidden
      && !candidate.readonly
      && (candidate.showWhen?.(dialog.values) ?? true));
    if (field === undefined || seen.has(field.key)) continue;
    seen.add(field.key);
    fields.push(field);
  }
  return fields;
};

const hasCredentialRegenerationSafeStop = (
  dialog: ConnectionsDialogState,
): boolean => dialog.credentialCorrection?.triage?.resolution
  === 'regenerate_credential_or_contact_admin';

/** Value-free administrator handoff for a credential safe stop. Every line is
 * built from closed-list state and schema labels; endpoint URLs, form values,
 * raw provider text, and credential material are excluded by construction. */
export const connectionCredentialRegenerationAdminHandoff = (
  dialog: ConnectionsDialogState,
  schema: ConnectionSchema,
): string | null => {
  const triage = dialog.credentialCorrection?.triage;
  if (
    triage?.resolution !== 'regenerate_credential_or_contact_admin'
    || dialog.mode !== 'edit'
  ) return null;
  const name = dialog.values.name ?? '';
  if (
    !CONNECTION_NAME_REGEX.test(name)
    || dialog.editingId !== connectionRowKey(schema.kind, name)
  ) return null;
  const identity = `${schema.kind}/${name}`;
  const authType = dialog.values['auth.type'] ?? '';
  const authLabel = GUIDE_AUTH_LABELS[authType] ?? 'Current sign-in method';
  const endpointLabels = visibleCredentialTriageFields(dialog, schema)
    .map((field) => field.label);
  const observedStep = triage.stage === 'credential_exchange'
    ? 'credential exchange'
    : 'configured provider endpoint check';
  const targetCheck = triage.stage === 'credential_exchange'
    ? 'Confirm the provider app or client, tenant, and exchange endpoint belong together.'
    : 'Confirm the connection endpoint and credential belong to the intended provider account, tenant, or workspace.';
  return [
    'Recued credential recovery handoff',
    `Connection: ${identity}`,
    `Sign-in method: ${authLabel}`,
    `Server-observed step: ${observedStep}`,
    `Non-secret fields to review: ${endpointLabels.length > 0 ? endpointLabels.join(', ') : 'provider account or workspace'}`,
    'Outcome: another replacement was rejected after provider/endpoint triage; the saved credential was not changed.',
    '',
    'Requested provider administrator checks:',
    `- ${targetCheck}`,
    '- Create, rotate, re-enable, or unlock a least-privilege credential for this connection.',
    '- Return the credential through the approved secret channel. Do not paste it into this handoff.',
    '',
    `Owner return: open Settings > Connections > ${identity}, enter the fresh credential, then choose Verify and replace once.`,
    'Privacy: this handoff excludes credential values, endpoint URLs, server URLs, form drafts, and raw provider responses.',
  ].join('\n');
};

/** One authoritative rejection, one exact correction action. Compound
 * credentials list every implicated field so the UI never implies the first
 * field is certainly wrong; it is only the deterministic place to begin. */
const renderCredentialCorrection = (
  dialog: ConnectionsDialogState,
  schema: ConnectionSchema,
): string => {
  const correction = dialog.credentialCorrection;
  if (correction === null) return '';
  const fields = visibleCredentialCorrectionFields(dialog, schema);
  if (fields.length === 0) return inlineError(correction.message);
  const first = fields[0]!;
  const labels = fields.map((field) => field.label);
  const triage = correction.triage;
  const safeStop = hasCredentialRegenerationSafeStop(dialog);
  const closure = correction.safeStopClosure;
  const hasRetainedCredentialDraft = safeStop
    && shouldPatchConnectionAuth(schema, dialog.values);
  const endpointFields = visibleCredentialTriageFields(dialog, schema);
  const firstEndpoint = endpointFields[0];
  const reviewCopy = safeStop
    ? hasRetainedCredentialDraft
      ? 'Do not send this key again unchanged. Enter a new key made at the provider, or ask whoever manages the provider account to fix it and confirm first.'
      : 'The refused key was not kept. Enter a new key made at the provider before checking again, or send the details below to whoever manages the provider account and ask them for one.'
    : labels.length === 1
      ? `Review ${labels[0]}, then verify the new key again.`
      : `Review these fields together: ${labels.join(', ')}. Start with ${first.label}, then verify again.`;
  const triageCopy = triage === undefined
    ? ''
    : triage.stage === 'credential_exchange'
      ? 'The provider refused the key again when your server tried to sign in with it. Check that the key and the sign-in address belong to the same provider account before you try again.'
      : firstEndpoint === undefined
        ? 'The provider refused the new key again. Check that it was made for the right provider account or workspace before you try again.'
        : 'The provider refused the new key again at the address it was sent to. Check that the key and the address belong to the right provider account before you try again.';
  const endpointAction = firstEndpoint === undefined
    ? ''
    : button({
        label: `Review ${firstEndpoint.label}`,
        size: 'sm',
        variant: 'secondary',
        action: 'connections-focus-credential-triage',
        data: { 'field-key': firstEndpoint.key },
      });
  const guideAction = triage !== undefined
    && schema.kind === 'api'
    && dialog.setupGuide.stage === 'closed'
    ? button({
        label: safeStop ? 'Make a new key' : 'Check provider setup',
        size: 'sm',
        variant: safeStop ? 'primary' : 'secondary',
        action: 'connections-guide-open',
      })
    : '';
  const credentialAction = button({
    label: safeStop ? `Enter a new ${first.label}` : `Review ${first.label}`,
    size: 'sm',
    variant: safeStop && guideAction === '' ? 'primary' : 'secondary',
    action: 'connections-focus-credential-correction',
    data: { 'field-key': first.key },
  });
  const closureActionLabel = closure?.phase === 'checking'
    ? 'Checking server support…'
    : closure?.phase === 'acknowledging'
      ? 'Noting the fix…'
      : closure?.phase === 'unconfirmed'
        ? 'Check again'
        : closure?.phase === 'unsupported'
          ? 'Update the server first'
          : 'The provider setup is fixed';
  const confirmedAction = safeStop
    ? button({
        label: closureActionLabel,
        size: 'sm',
        variant: 'secondary',
        action: 'connections-confirm-credential-handoff',
        ariaLabel: 'Confirm the provider setup is fixed, so Recued can check the key again',
        disabled: closure?.phase === 'checking'
          || closure?.phase === 'acknowledging'
          || closure?.phase === 'unsupported',
      })
    : '';
  const closureStatus = !safeStop || closure === undefined
    ? ''
    : closure.phase === 'ready'
      ? 'Recued asks your server to note the fix, then you can check the key again. No key is sent; checking a key is a separate step.'
      : closure.phase === 'checking'
        ? 'Checking that your server can note the fix…'
        : closure.phase === 'acknowledging'
          ? 'Noting the fix on your server…'
          : closure.error
            ?? (closure.phase === 'unsupported'
              ? 'This server cannot note the fix yet. Update it, or enter a different key before checking again.'
              : 'Recued could not confirm your server noted the fix. Reconnect, then choose Check again before you try again.');
  const adminHandoff = safeStop
    ? connectionCredentialRegenerationAdminHandoff(dialog, schema)
    : null;
  return `
    <section
      class="connections-credential-correction"
      data-connection-credential-correction
      data-field-key="${e(first.key)}"
      ${safeStop ? 'data-credential-safe-stop="true"' : ''}
      role="alert"
      aria-labelledby="connections-credential-correction-title"
      aria-describedby="connections-credential-correction-message connections-credential-correction-next${triage === undefined ? '' : ' connections-credential-correction-triage'}"
      tabindex="-1"
    >
      <strong id="connections-credential-correction-title">${safeStop ? 'Pause before retrying' : `Replacement rejected${triage === undefined ? '' : ' again'}`}</strong>
      <span id="connections-credential-correction-message">${e(correction.message)}</span>
      <span id="connections-credential-correction-next">${e(reviewCopy)}</span>
      ${triage === undefined
        ? ''
        : `<span id="connections-credential-correction-triage" data-connection-credential-triage data-stage="${e(triage.stage)}">${e(triageCopy)}</span>`}
      <div class="connections-credential-correction-action">
        ${guideAction}
        ${credentialAction}
        ${endpointAction}
        ${confirmedAction}
      </div>
      ${closureStatus === ''
        ? ''
        : `<p class="connections-credential-closure-status" data-credential-safe-stop-closure-status="${e(closure?.phase ?? 'checking')}" role="status" aria-live="polite" aria-atomic="true">${e(closureStatus)}</p>`}
      ${adminHandoff === null
        ? ''
        : `<details class="connections-credential-admin-handoff" data-credential-admin-handoff>
            <summary>Safe details for the provider administrator</summary>
            <div class="connections-credential-admin-handoff-body">
              <p id="connections-credential-admin-handoff-privacy">Nothing is sent automatically. Review before sharing. This summary contains only the connection identity, sign-in method, server-observed phase, field labels, and requested checks.</p>
              <pre data-credential-admin-handoff-summary tabindex="0" aria-label="Privacy-safe credential recovery handoff">${e(adminHandoff)}</pre>
              ${button({
                label: 'Copy safe handoff',
                size: 'sm',
                variant: 'secondary',
                action: 'connections-copy-credential-admin-handoff',
                ariaLabel: 'Copy the privacy-safe credential recovery handoff',
              })}
              <p data-credential-admin-handoff-status role="status" aria-live="polite" aria-atomic="true"></p>
            </div>
          </details>`}
    </section>
  `;
};

const renderConnectionFormValidation = (
  issue: ConnectionFormValidationIssue | null,
  announce: boolean,
  switching = false,
): string => {
  const summary = connectionFormValidationSummary(issue, switching);
  const ready = summary.status === 'ready';
  return `
    <section
      class="connections-form-validation"
      data-connection-form-validation
      data-status="${summary.status}"
      data-field-key="${e(summary.fieldKey)}"
      role="${announce ? 'status' : 'group'}"
      ${announce
        ? 'aria-live="polite" aria-atomic="true"'
        : 'aria-labelledby="connections-form-validation-title" aria-describedby="connections-form-validation-message"'}
      tabindex="-1"
    >
      <strong id="connections-form-validation-title" data-connection-form-validation-title>${e(summary.title)}</strong>
      <span id="connections-form-validation-message" data-connection-form-validation-message>${e(summary.message)}</span>
      <div class="connections-form-validation-action" data-connection-form-validation-action${ready ? ' hidden' : ''}>
        ${button({
          label: summary.actionLabel,
          size: 'sm',
          action: 'connections-focus-first-invalid',
          data: { 'field-key': summary.fieldKey },
        })}
      </div>
    </section>
  `;
};

/** A BUILT-IN provider's form open at a numbered loopback address (`127.0.0.1`
 *  or `[::1]`, which the server's start-up log prints): say to connect from
 *  `localhost`, or from app.recued.com. The printed callback follows the page,
 *  and HubSpot and Microsoft will not register an `http` one at a number.
 *  app.recued.com needs the server's own HTTPS address, because a vendor's code
 *  finishes at `<server>/oauth/complete` from there.
 *
 *  Empty for every other page, and for a custom OAuth app: its owner registered
 *  whatever this page prints, and their provider may take it.
 *
 *  A provider whose form has a way in with no redirect URL at all (HubSpot's
 *  Service Key) gets that named too, as its option reads in the form. */
const renderLoopbackNameSwitch = (dialog: ConnectionsDialogState): string => {
  if (dialog.vendor === null || getVendorProvider(dialog.vendor) === null) return '';
  if (dialog.oauthCallbackUrl === undefined) return '';
  let page: URL;
  try {
    page = new URL(dialog.oauthCallbackUrl);
  } catch {
    return '';
  }
  const localhost = localhostOriginForNumberedLoopback(page.origin);
  if (localhost === null) return '';
  const noRedirect = noRedirectAlternative(dialog.vendor);
  return `<p class="connections-oauth-callback-switch" data-oauth-callback-switch>
    <strong>Connect from <code>${e(localhost)}/webclient</code> instead.</strong>
    Providers such as HubSpot and Microsoft will not take a redirect URL at a number like
    <code>${e(page.hostname)}</code>. <code>localhost</code> is this same server under another name.
    Is that address new to this browser? Then pair it once, like a new device.
    Or connect from app.recued.com, if your server has its own HTTPS address, such as a Pro address.
    ${noRedirect === null
      ? ''
      : `Or choose <strong data-oauth-no-redirect-option>${e(noRedirect.option)}</strong> under ${e(noRedirect.field)}: it needs no redirect URL.`}
    You connect once. After that, the connection works from any address.
  </p>`;
};

/** The vendor form's own way in WITHOUT a redirect URL, named as its option
 *  and its field read on screen: any `auth.type` option other than the OAuth
 *  sign-in. HubSpot's Service Key today; null where sign-in is the only way. */
const noRedirectAlternative = (vendor: string): { option: string; field: string } | null => {
  const field = resolveVendorSchema(vendor)
    ?.fields.find((candidate) => candidate.key === 'auth.type');
  const value = field?.options?.find((option) => option !== 'oauth2_refresh');
  if (field === undefined || value === undefined) return null;
  return { option: field.optionLabels?.[value] ?? value, field: field.label };
};

/** D-129 P1.3 — render the OAuth dance affordance for vendor flows.
 *  Surfaces three states inline above the Save button:
 *   - idle (no refresh_token yet): primary "Authorize with <Vendor>"
 *     button. Click is captured by the host, which runs the OAuth
 *     dance + calls `collection.connection.completeVendorOAuth` + patches
 *     `auth.refresh_token` + `oauthGrantedScopes` back into state.
 *   - in flight (`oauthInFlight: true`): button replaced by a
 *     disabled "Authorizing…" pill so the user knows the popup /
 *     web-auth flow is mid-roundtrip.
 *   - completed (refresh_token populated): re-authorize affordance
 *     (smaller, secondary) + a granted-scopes summary so the user
 *     sees what the vendor consented to before Save.
 *   - error: an inline error message above the button surfaces
 *     `oauthError` (rpc rejection, popup blocked, user denied
 *     consent). */
const renderSavedOAuthApps = (dialog: ConnectionsDialogState): string => {
  if (dialog.mode !== 'create' && !dialog.authenticationSwitch || dialog.kind !== 'api' || !dialog.savedOAuthApps) return '';
  const issuer = compatibleSavedOAuthAppIssuer(dialog);
  if (!issuer) return '';
  const label = issuer === 'google' ? 'Google' : 'Microsoft';
  const state = dialog.savedOAuthApps;
  const apps = savedOAuthAppsForIssuer(state.config, issuer).filter(app => app.has_secret && (dialog.authenticationManagement !== 'app'
    || (dialog.authenticationManagementCurrentAppId ? app.id !== dialog.authenticationManagementCurrentAppId : app.client_id !== dialog.authenticationManagementCurrentClientId)));
  const selected = selectedSavedOAuthAppIssuer(dialog) !== null;
  const choice = dialog.values['auth.saved_oauth_app_choice'] ?? dialog.values['auth.saved_oauth_app_id'] ?? apps[0]?.id;
  const validChoice = apps.some(app => app.id === choice);
  const locked = state.loading || Boolean(state.error) || dialog.saving || dialog.oauthInFlight;
  // Re-authorizing keeps the current app. Its locked Client ID field names it
  // and says where its secret is, so a block repeating that adds nothing.
  if (dialog.authenticationManagement === 'reauthorize') return '';
  return `<section class="connections-oauth connections-saved-apps" data-saved-oauth-apps aria-label="OAuth app">
    <div class="connections-saved-apps-head">
      <h4>OAuth app</h4>
      <div class="connections-saved-apps-links">
        ${button({ label: 'Refresh saved apps',size: 'sm',variant: 'link',action: 'connections-refresh-saved-oauth-apps',disabled: state.loading || dialog.saving || dialog.oauthInFlight })}
        ${state.canManage ? button({ label: 'Manage saved apps', size: 'sm', variant: 'link', action: 'connections-manage-oauth-apps', disabled: dialog.saving || dialog.oauthInFlight }) : ''}
      </div>
    </div>
    ${selected ? `<p>Using your saved ${label} app: <code>${e(dialog.values['auth.client_id'] ?? '')}</code>.
      The secret stays on your server. Review the permissions below, then authorize this API connection.</p>
      ${button({ label: 'Enter another app',size: 'sm',action: 'connections-enter-oauth-app',disabled: dialog.saving || dialog.oauthInFlight })}` : ''}
    ${apps.length ? `<div class="connections-saved-apps-pick">
      <label>Saved ${label} app <select data-conn-field="auth.saved_oauth_app_choice"${locked ? ' disabled' : ''}>
      ${validChoice ? '' : '<option value="" selected>Choose a saved app</option>'}
      ${apps.map(app => `<option value="${e(app.id)}"${app.id === choice ? ' selected' : ''}>${e(app.label)} · ${e(app.client_id)}</option>`).join('')}
      </select></label>
      ${button({ label: `Use saved ${label} app`,size: 'sm',action: 'connections-use-saved-oauth-app',data: { issuer },disabled: locked || !validChoice })}
      </div><p class="connections-saved-apps-note">${state.error ? 'Refresh saved apps to check them.' : `Your saved ${label} app is ready to use for this API connection.`}</p>`
      : `<p class="connections-saved-apps-note">${state.loading ? 'Loading saved apps…' : `Add a ${label} app under Saved OAuth apps, or save one in Mail or Calendar.`}</p>`}
    ${state.error ? `<p role="status">${e(state.error)}</p>` : ''}
  </section>`;
};

const renderVendorOAuth = (dialog: ConnectionsDialogState): string => {
  // Render the in-app consent affordance for a registered vendor flow OR a
  // generic `api` oauth2_refresh form (R14 — any BYO vendor). On the generic
  // form the button is an OPTIONAL accelerator: the named Refresh Token field
  // remains a manual fallback, and the host validates typed endpoints on click.
  const isGeneric =
    !dialog.vendor
    && connectionFormRunsOAuthDance({ kind: dialog.kind, values: dialog.values });
  const isRegisteredRefreshFlow =
    dialog.vendor !== null
    && dialog.values['auth.type'] === 'oauth2_refresh';
  if (!isRegisteredRefreshFlow && !isGeneric) return '';
  const readiness = connectionOAuthCredentialReadiness({
    vendor: dialog.vendor,
    kind: dialog.kind,
    values: dialog.values,
  });
  if (readiness === null) return '';
  const refreshToken = (dialog.values['auth.refresh_token'] ?? '').trim();
  const hasToken = refreshToken.length > 0;
  const hasUsableToken = hasToken && readiness.refreshReady;
  const tokenFromAuthorization = dialog.oauthGrantedScopes !== null;
  const grantedScopes = dialog.oauthGrantedScopes ?? [];
  const grantedSummary = grantedScopes.length > 0
    ? `<p class="connections-oauth-scopes">Granted scopes (${grantedScopes.length}): ${e(grantedScopes.join(', '))}</p>`
    : '';
  // The consent screen is the most expensive step in this form, and it persists
  // NOTHING: the exchange patches `auth.refresh_token` into the DRAFT and stops.
  // Three separate questions from the live drive — "is the connection saved?",
  // "why would I probe when authorization just succeeded?", "does Cancel undo the
  // authorization or just go back?" — are all the same missing sentence. Answer it
  // beside the token that is not yet on disk, not in the privacy paragraph above.
  const probeTarget = (dialog.values['config.base_url'] ?? '').trim();
  const postAuthorizationNextStep = hasUsableToken
    && tokenFromAuthorization
    && !dialog.saving
    ? dialog.authenticationSwitch ? `<p class="rx-msg rx-msg-warn connections-oauth-next-step" data-oauth-next-step role="status">
        <strong>Not applied yet.</strong> Review the sign-in in the next step, then select <em>${e(authenticationSwitchApplyLabel(dialog))}</em>.
      </p>` : `<p class="rx-msg rx-msg-warn connections-oauth-next-step" data-oauth-next-step role="status">
        <strong>Not saved yet.</strong> Select <em>Save and test</em> to store this
        connection on your server. Authorizing proved the provider issued a token;
        the probe is the separate check that the token actually reaches
        ${probeTarget.length > 0 ? `<code>${e(probeTarget)}</code>` : 'the API'}
        with the scopes you granted. Cancel discards this authorization and you
        would have to consent again.
      </p>`
    : '';
  const errorBlock = dialog.oauthError
    ? `<p id="connections-oauth-error" class="rx-msg rx-msg-error connections-oauth-error" role="alert">${e(dialog.oauthError)}</p>`
    : '';
  const reauthorizationBlock = dialog.oauthNeedsReauthorization && dialog.oauthError === null
    ? `<p class="rx-msg rx-msg-warn connections-oauth-error" role="status">Provider app details changed, so Recued cleared the previous authorization. Authorize again or paste a matching refresh token.</p>`
    : '';
  const who = dialog.vendor
    ? vendorDisplayName(dialog.vendor, getVendorProvider(dialog.vendor))
    : null;
  const buttonLabel = dialog.oauthInFlight
    ? 'Authorizing…'
    : hasUsableToken && !readiness.ready
      ? 'Add re-authorization details'
      : !readiness.ready
        ? 'Review provider credentials'
        : hasToken
          ? (who ? `Re-authorize with ${who}` : 'Re-authorize')
          : (who ? `Authorize with ${who}` : 'Authorize with provider');
  const missingCount = readiness.requirements.filter((item) => item.status === 'missing').length;
  const invalidCount = readiness.requirements.filter((item) => item.status === 'invalid').length;
  const unresolvedCount = missingCount + invalidCount;
  const statusTitle = dialog.oauthInFlight
    ? 'Provider authorization is open'
    : hasUsableToken
      ? tokenFromAuthorization
        ? 'Authorization received'
        : dialog.authenticationSwitch ? 'Refresh token ready' : 'Refresh token ready to save'
      : !readiness.ready
        ? readiness.issue?.fieldKey === null
          ? 'Provider details need attention'
          : invalidCount > 0
            ? `${unresolvedCount} ${unresolvedCount === 1 ? 'detail needs' : 'details need'} attention`
            : `${missingCount} required ${missingCount === 1 ? 'detail' : 'details'} left`
        : 'Ready to authorize';
  const oauthState = dialog.oauthInFlight
    ? 'in_flight'
    : hasUsableToken
      ? 'authorized'
      : !readiness.ready
        ? 'incomplete'
        : 'ready';
  // A switch or an edit starts from a saved name and label, so the checklist is
  // the credentials alone; a cleared label is the form's own status to report.
  const savedIdentity = dialog.authenticationSwitch !== null || dialog.mode === 'edit';
  const requirements = readiness.requirements.filter((item) => !savedIdentity
    || (item.fieldKey !== 'name' && item.fieldKey !== 'display_name')).map((item) => {
    const icon = item.status === 'complete'
      ? '✓'
      : item.status === 'optional'
        ? '○'
        : item.status === 'invalid'
          ? '!'
          : '•';
    const copy = item.status === 'complete'
      ? 'Ready'
      : item.status === 'optional'
        ? 'Optional'
        : item.status === 'invalid'
          ? 'Check'
          : 'Required';
    return `
      <li data-oauth-requirement="${e(item.fieldKey)}" data-status="${e(item.status)}">
        <span aria-hidden="true">${icon}</span>
        <span>${e(item.label)}</span>
        <small>${copy}</small>
      </li>
    `;
  }).join('');
  return `
    <section class="connections-oauth" aria-labelledby="connections-oauth-title" data-oauth-state="${oauthState}"
      ${dialog.vendor ? ` data-vendor="${e(dialog.vendor)}"` : ''}>
      <div class="connections-oauth-heading">
        <div>
          <p class="connections-oauth-eyebrow">Provider credentials</p>
          <h4 id="connections-oauth-title">${e(statusTitle)}</h4>
        </div>
        <span class="connections-oauth-private">Excluded from AI</span>
      </div>
      <p class="connections-oauth-privacy">
        Client ID, secret, and refresh token are used only between this form, your paired server,
        and the provider's OAuth endpoints. Saving stores them on your server; AI guidance and
        reload recovery never receive their values.
      </p>
      ${/* In a switch, a list of nothing left to enter is noise; it shows only while something is. */
        dialog.authenticationSwitch && readiness.requirements.every((item) => item.status === 'complete'
          || item.fieldKey === 'name' || item.fieldKey === 'display_name')
        ? '' : `<ul class="connections-oauth-readiness">${requirements}</ul>`}
      <div class="connections-oauth-callback">
        <div>
          <strong>Add this redirect URL to your provider app</strong>
          <span>Copy it exactly ${'—'} character for character ${'—'} into the app's redirect / callback URI list, then come back here and Authorize.</span>
        </div>
        <div class="connections-oauth-callback-value">
          <code>${e(dialog.oauthCallbackUrl ?? OAUTH_CLOUD_CALLBACK_URL)}</code>
          ${button({
            label: 'Copy',
            size: 'xs',
            action: 'connections-guide-copy-callback',
            ariaLabel: 'Copy the exact provider OAuth callback URL',
          })}
        </div>
        ${renderLoopbackNameSwitch(dialog)}
        ${dialog.oauthCallbackAlternateUrl !== undefined
          ? `<p class="connections-oauth-callback-alt">⚠ This URL belongs to the address you are on right now (<code>${e(new URL(dialog.oauthCallbackUrl ?? OAUTH_CLOUD_CALLBACK_URL).origin)}</code>). If you also open Recued at <code>${e(new URL(dialog.oauthCallbackAlternateUrl).origin)}</code>, add <code>${e(dialog.oauthCallbackAlternateUrl)}</code> too ${'—'} <strong>you cannot get one from the other by swapping the domain</strong>, because the paths are different as well. Providers accept several redirect URLs, so adding both is the safe move.</p>`
          : ''}
      </div>
      ${errorBlock}
      ${reauthorizationBlock}
      ${grantedSummary}
      ${postAuthorizationNextStep}
      ${readiness.scopes.length > 0
        ? `<div class="connections-oauth-scopes-required" data-recued-connections-oauth-scopes>
        <div>
          <strong>Add these permissions to your provider app</strong>
          <span>Recued will request exactly these at Authorize. Most providers only grant a permission the app is already registered for ${'—'} add them first, or consent succeeds and the first call still fails.</span>
        </div>
        <div class="connections-oauth-scopes-value">
          <code>${e(readiness.scopes.join(' '))}</code>
          ${button({
            label: 'Copy',
            size: 'xs',
            action: 'connections-guide-copy-scopes',
            ariaLabel: 'Copy the exact OAuth scopes this connection will request',
          })}
        </div>
        <p class="connections-oauth-scope-count">${readiness.scopeCount} ${readiness.scopeCount === 1 ? 'scope' : 'scopes'} ${'—'} the provider will show them on its consent screen.</p>
      </div>`
        : ''}
      ${button({
        label: buttonLabel,
        variant: hasUsableToken && !dialog.oauthInFlight ? 'secondary' : 'primary',
        size: 'sm',
        action: 'connections-authorize-vendor',
        ...(dialog.vendor ? { data: { vendor: dialog.vendor } } : {}),
        disabled: dialog.saving || dialog.oauthInFlight,
      })}
    </section>
  `;
};

const vendorDisplayName = (
  vendor: string,
  provider: ConnectionVendorProvider | null,
): string => provider?.display_name ?? vendor;

const renderVendorConsentDisclosure = (dialog: ConnectionsDialogState): string => {
  if (dialog.values['auth.type'] === 'managed_oauth') return ''; // D-322 — broker consent is described by its panel.
  if (!dialog.vendor) return '';
  const provider = getVendorProvider(dialog.vendor);
  const label = vendorDisplayName(dialog.vendor, provider);
  if (provider === null) {
    return `
      <div class="connections-consent" data-vendor="${e(dialog.vendor)}">
        <h4 class="connections-consent-title">Connection consent</h4>
        <p class="connections-consent-note">Vendor enrollment metadata is unavailable for ${e(dialog.vendor)}.</p>
      </div>
    `;
  }

  const requestedScopes = provider.oauth.scopes
    .map((scope) => `<li><code>${e(scope)}</code></li>`)
    .join('');
  const hasToken = (dialog.values['auth.refresh_token'] ?? '').trim().length > 0;
  const vendorStateKind = dialog.saving
    ? 'saving_connection'
    : hasToken
      ? 'ready_after_auth'
      : 'needs_connection';
  const vendorStateLabel = dialog.saving
    ? 'Saving connection before vendor setup'
    : hasToken
      ? 'Ready for provider-side setup after Save'
      : `Needs ${label} OAuth consent`;
  const vendorStateDetail = dialog.saving
    ? 'Provider-side setup remains held until the connection credential is persisted.'
    : hasToken
      ? `Provider-side setup can use the saved connection token. Default reconciliation cadence: ${provider.default_cadence}.`
      : 'Provider-side setup is held until OAuth completes and the connection is saved.';

  return `
    <div class="connections-consent" data-vendor="${e(dialog.vendor)}">
      <h4 class="connections-consent-title">Connection consent</h4>
      <p class="connections-consent-note">${e(label)} will request these OAuth scopes before the connection is saved.</p>
      <ul class="connections-consent-scopes">
        ${requestedScopes}
      </ul>
      <div class="connections-vendor-state" data-vendor-state="${e(vendorStateKind)}">
        <strong>${e(vendorStateLabel)}</strong>
        <span>${e(vendorStateDetail)}</span>
      </div>
    </div>
  `;
};

const splitGuideScopes = (raw: string): { scopes: string[]; omitted: number } => {
  const scopes = raw
    .trim()
    .split(/\s+/u)
    .filter((scope, index, all) => scope.length > 0 && all.indexOf(scope) === index);
  const shown = scopes.slice(0, 12);
  return { scopes: shown, omitted: scopes.length - shown.length };
};

/** OAuth app creation leaves the Recued tab, so the ready guide becomes a
 *  concrete round trip: exact callback contract, locally held scopes, and one
 *  schema-derived control to resume at when the owner returns. */
const renderConnectionSetupGuideHandoff = (
  dialog: ConnectionsDialogState,
  schema: ConnectionSchema,
): string => {
  const state = dialog.setupGuide;
  const preview = state.preview;
  const result = state.result;
  if (preview === null || result === null) return '';
  const authType = preview.auth_type;
  if (authType !== 'oauth2_refresh' && authType !== 'oauth2_client_credentials') {
    return `
      <a class="connections-setup-guide-open" href="${e(preview.target_url)}"
         target="_blank" rel="noopener noreferrer">Open provider page (new tab) <span aria-hidden="true">↗</span></a>
    `;
  }

  const isRefresh = authType === 'oauth2_refresh';
  const scopeKey = isRefresh ? 'auth.scopes' : 'auth.scope';
  const enteredScopes = (dialog.values[scopeKey] ?? '').trim();
  const suggestedScopes = result.guide.field_suggestions.find(
    (suggestion) => suggestion.field_key === scopeKey,
  )?.suggested_value?.trim() ?? '';
  const scopeRaw = enteredScopes || suggestedScopes;
  const scopeSource = enteredScopes.length > 0 ? 'form' : 'guide';
  const parsedScopes = splitGuideScopes(scopeRaw);
  const scopeList = parsedScopes.scopes.length > 0
    ? `
      <p>${scopeSource === 'form'
        ? 'These scopes were prepared in the form when this guide became ready:'
        : 'The guide suggested these scopes. Verify each one before adding it to the form:'}</p>
      <ul class="connections-setup-guide-scope-list" data-scope-source="${scopeSource}">
        ${parsedScopes.scopes.map((scope) => `<li><code>${e(scope)}</code></li>`).join('')}
      </ul>
      ${parsedScopes.omitted > 0
        ? `<p>Plus ${parsedScopes.omitted} more scope${parsedScopes.omitted === 1 ? '' : 's'} ${scopeSource === 'form' ? 'prepared at that point' : 'in this suggestion'}.</p>`
        : ''}
    `
    : '<p>No scope list is prepared yet. Choose the least privilege required for the work you intend to run.</p>';
  const returnTarget = connectionSetupGuideReturnTarget(schema, dialog.values);
  const returnAction = returnTarget === null || state.resumeAvailable
    ? ''
    : button({
        label: 'Continue in connection form',
        variant: 'primary',
        size: 'sm',
        action: 'connections-guide-return-to-form',
        disabled: dialog.saving,
      });
  const callbackStep = isRefresh
    ? `
      <li>
        <strong>Register Recued's exact callback URL</strong>
        <p>Paste this as an allowed redirect or callback URI, exactly as shown ${'—'} do not add a trailing slash.</p>
        ${renderLoopbackNameSwitch(dialog)}
        <div class="connections-setup-guide-copy-value">
          <code id="connection-setup-guide-callback">${e(dialog.oauthCallbackUrl ?? OAUTH_CLOUD_CALLBACK_URL)}</code>
          ${button({
            label: 'Copy',
            size: 'xs',
            action: 'connections-guide-copy-callback',
            ariaLabel: 'Copy the Recued OAuth callback URL',
          })}
        </div>
      </li>
    `
    : `
      <li>
        <strong>No callback URL is used</strong>
        <p>This machine-to-machine client-credentials flow exchanges the app credentials directly; do not invent a browser redirect URI.</p>
      </li>
    `;

  return `
    <section class="connections-setup-guide-handoff"
             data-connection-guide-handoff data-auth-type="${e(authType)}"
             aria-labelledby="connection-setup-guide-handoff-title">
      <div>
        <p class="connections-setup-guide-eyebrow">Provider app handoff</p>
        <h5 id="connection-setup-guide-handoff-title">Create the app, then return to this form</h5>
        <p>This reviewed guide and your current form stay ready in this tab while the provider portal opens in a new one.</p>
      </div>
      <ol class="connections-setup-guide-handoff-steps">
        <li>
          <strong>Open the provider portal</strong>
          <p>Create ${isRefresh ? 'a web OAuth app' : 'a machine-to-machine OAuth app'} using the walkthrough below.</p>
          <a class="connections-setup-guide-open" href="${e(preview.target_url)}"
             target="_blank" rel="noopener noreferrer">Open provider page (new tab) <span aria-hidden="true">↗</span></a>
        </li>
        ${callbackStep}
        <li>
          <strong>Confirm least-privilege scopes</strong>
          ${scopeList}
        </li>
        <li>
          <strong>Bring the issued values back to Recued</strong>
          <p>Enter the provider-issued client ID and any secret it issued only in the connection form—not in the AI guide. Recued will take you to the next unfinished field or ${isRefresh ? 'authorization' : 'Save and test'} action.</p>
          ${returnAction}
        </li>
      </ol>
    </section>
  `;
};

const renderConnectionSetupGuide = (
  dialog: ConnectionsDialogState,
  schema: ConnectionSchema,
): string => {
  if (schema.kind !== 'api' || dialog.values['auth.type'] === 'managed_oauth') return '';
  const state = dialog.setupGuide;
  const titleId = 'connection-setup-guide-title';
  const panelAttrs = `data-connection-guide-panel tabindex="-1" aria-labelledby="${titleId}"`;
  if (state.stage === 'closed') {
    return `
      <section class="connections-setup-guide connections-setup-guide--closed"
               ${panelAttrs}>
        <div class="connections-setup-guide-copy">
          <h4 id="${titleId}" class="connections-setup-guide-title">Not sure what goes where?</h4>
          <p>Recued can suggest field values and walk you through creating a provider app when one is required.</p>
        </div>
        ${button({
          label: 'Suggest and guide',
          size: 'sm',
          action: 'connections-guide-open',
        })}
      </section>
    `;
  }

  const cancel = button({
    label: 'Close guide',
    variant: 'link',
    size: 'sm',
    action: 'connections-guide-close',
  });

  if (state.stage === 'entry') {
    const reviewDisabled = state.targetUrl.trim().length === 0;
    const errorId = 'connection-setup-guide-url-error';
    const describedBy = `connection-setup-guide-privacy${state.error ? ` ${errorId}` : ''}`;
    return `
      <section class="connections-setup-guide" ${panelAttrs}>
        <div class="connections-setup-guide-heading">
          <div>
            <h4 id="${titleId}" class="connections-setup-guide-title">Suggest and guide</h4>
            <p>Start with the provider page or developer portal you are using.</p>
          </div>
          ${cancel}
        </div>
        <label class="connections-setup-guide-url-label" for="connection-setup-guide-url">
          Provider or developer-page URL
        </label>
        <input id="connection-setup-guide-url" class="rx-input"
               type="url" inputmode="url" autocomplete="url" spellcheck="false"
               data-connection-guide-url
               aria-describedby="${describedBy}"
               ${state.error ? `aria-invalid="true" aria-errormessage="${errorId}"` : ''}
               placeholder="https://developer.example.com/apps"
               value="${e(state.targetUrl)}" />
        <p id="connection-setup-guide-privacy" class="connections-setup-guide-privacy">
          Before anything is sent, you can review the cleaned URL, selected sign-in method,
          and visible field names. All other connection-form values—including tokens,
          passwords, and secrets—are never shared.
        </p>
        ${state.error
          ? `<div id="${errorId}" data-connection-guide-error>${inlineError(state.error)}</div>`
          : ''}
        <div class="connections-setup-guide-actions">
          ${button({
            label: 'Review what will be shared',
            variant: 'primary',
            size: 'sm',
            action: 'connections-guide-review',
            disabled: reviewDisabled,
          })}
        </div>
      </section>
    `;
  }

  const preview = state.preview;
  if (preview === null) {
    return `
      <section class="connections-setup-guide" ${panelAttrs}>
        <h4 id="${titleId}" class="connections-setup-guide-title">Suggest and guide</h4>
        ${inlineError(state.error ?? 'The reviewed setup context is no longer available.')}
        <div class="connections-setup-guide-actions">
          ${button({ label: 'Start again', size: 'sm', action: 'connections-guide-edit' })}
          ${cancel}
        </div>
      </section>
    `;
  }

  const fieldLabel = (key: string): string =>
    preview.visible_fields.find((field) => field.key === key)?.label ?? key;
  const sharedFields = preview.visible_fields
    .map((field) => `<li><span>${e(field.label)}</span><code>${e(field.key)}</code></li>`)
    .join('');
  const reviewedContext = `
    <div class="connections-setup-guide-shared">
      <h5>Shared with your configured AI</h5>
      <dl>
        <div><dt>Cleaned URL</dt><dd><code>${e(preview.target_url)}</code></dd></div>
        <div><dt>Sign-in method</dt><dd>${e(GUIDE_AUTH_LABELS[preview.auth_type] ?? preview.auth_type)}</dd></div>
      </dl>
      <details>
        <summary>${preview.visible_fields.length} visible field name${preview.visible_fields.length === 1 ? '' : 's'}</summary>
        <ul>${sharedFields}</ul>
      </details>
      <p class="connections-setup-guide-not-shared">
        <strong>Not shared:</strong> all other connection-form values, including account names,
        API endpoints, usernames, tokens, passwords, client secrets, or refresh tokens.
      </p>
      <p class="connections-setup-guide-context-note">
        Recued adds its standard, value-free descriptions for these fields. The URL is
        context only; Recued does not sign in to, fetch, or submit the page.
      </p>
    </div>
  `;

  if (state.stage === 'preview') {
    return `
      <section class="connections-setup-guide" ${panelAttrs}>
        <div class="connections-setup-guide-heading">
          <div>
            <h4 id="${titleId}" class="connections-setup-guide-title">Review before asking AI</h4>
            <p>Confirm this is the context you intend to share.</p>
          </div>
          ${cancel}
        </div>
        ${reviewedContext}
        <div class="connections-setup-guide-actions">
          ${button({ label: 'Edit URL', size: 'sm', action: 'connections-guide-edit' })}
          ${button({
            label: 'Create setup guide',
            variant: 'primary',
            size: 'sm',
            action: 'connections-guide-generate',
          })}
        </div>
      </section>
    `;
  }

  if (state.stage === 'loading') {
    return `
      <section class="connections-setup-guide" ${panelAttrs}>
        <h4 id="${titleId}" class="connections-setup-guide-title">Creating your setup guide…</h4>
        <p class="connections-setup-guide-progress" role="status" aria-live="polite">
          Your configured AI is reviewing the approved context. You can keep this form open;
          no connection will be saved or submitted.
        </p>
        ${reviewedContext}
        <div class="connections-setup-guide-actions">${cancel}</div>
      </section>
    `;
  }

  if (state.stage === 'error') {
    return `
      <section class="connections-setup-guide" ${panelAttrs}>
        <div class="connections-setup-guide-heading">
          <h4 id="${titleId}" class="connections-setup-guide-title">The guide was not created</h4>
          ${cancel}
        </div>
        ${inlineError(state.error ?? 'The setup guide could not be created.')}
        ${reviewedContext}
        <div class="connections-setup-guide-actions">
          ${button({ label: 'Edit URL', size: 'sm', action: 'connections-guide-edit' })}
          ${button({
            label: 'Try again',
            variant: 'primary',
            size: 'sm',
            action: 'connections-guide-generate',
          })}
        </div>
      </section>
    `;
  }

  const result = state.result;
  if (result === null) return '';
  const restoredNotice = state.resumeAvailable
    ? `
      <aside class="connections-setup-guide-resume" role="status" aria-live="polite" aria-atomic="true"
             aria-labelledby="connection-setup-guide-resume-title">
        <div>
          <strong id="connection-setup-guide-resume-title">Provider setup restored</strong>
          <p>Recued restored only the reviewed public URL, sign-in method, field names, and safe AI suggestions. Other form entries were not retained; credentials—including client IDs, secrets, and tokens—were never stored in this resume.</p>
        </div>
        ${button({
          label: 'Resume provider setup',
          variant: 'primary',
          size: 'sm',
          action: 'connections-guide-resume',
          disabled: dialog.saving,
        })}
      </aside>
    `
    : '';
  const suggestions = result.guide.field_suggestions.length > 0
    ? result.guide.field_suggestions.map((suggestion) => {
        const suggestedField = schema.fields.find((field) =>
          field.key === suggestion.field_key
          && !field.hidden
          && !field.readonly
          && field.type !== 'secret'
          && (field.showWhen?.(dialog.values) ?? true));
        const canApply = !state.resumeAvailable
          && preview.field_keys.includes(suggestion.field_key)
          && suggestedField !== undefined
          && canApplyConnectionSetupGuideSuggestion(
            suggestion.field_key,
            suggestion.suggested_value,
          );
        const applyControl = canApply
          ? button({
              label: 'Use in form after checking',
              size: 'xs',
              action: 'connections-guide-use-suggestion',
              data: { 'field-key': suggestion.field_key },
              ariaLabel: `Use this ${fieldLabel(suggestion.field_key)} suggestion in the form after checking it`,
              disabled: dialog.saving || dialog.oauthInFlight,
            })
          : '';
        return `
          <li class="connections-setup-guide-suggestion">
            <div class="connections-setup-guide-suggestion-heading">
              <strong>${e(fieldLabel(suggestion.field_key))}</strong>
              <span data-confidence="${e(suggestion.confidence)}">${e(suggestion.confidence)} confidence</span>
            </div>
            ${suggestion.suggested_value
              ? `<code class="connections-setup-guide-value">${e(suggestion.suggested_value)}</code>`
              : ''}
            <p>${e(suggestion.guidance)}</p>
            ${applyControl ? `<div class="connections-setup-guide-suggestion-action">${applyControl}</div>` : ''}
          </li>
        `;
      }).join('')
    : '<li class="connections-setup-guide-empty">No safe concrete field values were suggested. Follow the walkthrough below.</li>';
  const steps = result.guide.steps.map((step, index) => {
    const fields = step.field_keys.length > 0
      ? `<p class="connections-setup-guide-step-fields">Form fields: ${step.field_keys.map((key) => `<code>${e(fieldLabel(key))}</code>`).join(' ')}</p>`
      : '';
    return `
      <li>
        <div><span class="connections-setup-guide-step-number" aria-hidden="true">${index + 1}</span><strong>${e(step.title)}</strong></div>
        <p>${e(step.instruction)}</p>
        ${fields}
      </li>
    `;
  }).join('');
  const cautions = result.guide.cautions
    .map((caution) => `<li>${e(caution)}</li>`)
    .join('');

  return `
    <section class="connections-setup-guide connections-setup-guide--ready"
             ${panelAttrs}${state.resumeAvailable ? '' : ' aria-live="polite"'}>
      <div class="connections-setup-guide-heading">
        <div>
          <p class="connections-setup-guide-eyebrow">AI setup guide</p>
          <h4 id="${titleId}" class="connections-setup-guide-title">${e(result.guide.provider_name)}</h4>
        </div>
        ${cancel}
      </div>
      ${restoredNotice}
      <p class="connections-setup-guide-overview">${e(result.guide.overview)}</p>
      ${renderConnectionSetupGuideHandoff(dialog, schema)}
      <div class="connections-setup-guide-section">
        <h5>Suggested form values</h5>
        <p>Verify each value against the provider first. Only explicit, non-secret suggestions can be moved into this form; client IDs and secrets always remain manual.</p>
        <ul class="connections-setup-guide-suggestions">${suggestions}</ul>
      </div>
      <div class="connections-setup-guide-section">
        <h5>Provider setup walkthrough</h5>
        <ol class="connections-setup-guide-steps">${steps}</ol>
      </div>
      <div class="connections-setup-guide-cautions">
        <h5>Check before saving</h5>
        <ul>${cautions}</ul>
      </div>
      <p class="connections-setup-guide-disclaimer">
        AI-generated guidance can be outdated. Verify it with the provider; Recued will
        still validate and probe the connection when you save.
      </p>
      <div class="connections-setup-guide-actions">
        ${button({ label: 'Review and regenerate', size: 'sm', action: 'connections-guide-review-again' })}
      </div>
    </section>
  `;
};

/** The button that finishes a switch, as its footer labels it. */
const authenticationSwitchApplyLabel = (dialog: ConnectionsDialogState): string => dialog.authenticationRepair
  ? 'Verify access and return to pack'
  : dialog.authenticationManagement ? 'Verify and apply' : 'Verify and switch';

/** What a switch starts from: the method, and for a broker the account. */
const authenticationSwitchCurrent = (
  original: NonNullable<ConnectionsDialogState['authenticationSwitch']>,
): { current: string; account?: string } => original.managed_oauth
  ? { current: 'Broker sign-in', account: 'Nango account ' + original.managed_oauth.connection_id }
  : { current: original.auth_type === 'oauth2_refresh' ? 'Recued direct OAuth' : 'Saved authentication' };

/** A switch's intro: what the form does, and what it never changes. */
const renderAuthenticationSwitchIntro = (dialog: ConnectionsDialogState): string => {
  const original = dialog.authenticationSwitch;
  if (!original) return '';
  const lead = dialog.authenticationRepair
    ? 'Sign in again so this connection has the permissions your Packs need.'
    : dialog.authenticationManagement
      ? 'Sign in again, or change how this connection signs in.'
      : 'Change how this connection signs in.';
  return `${lead} Its name (<code>${e(original.name)}</code>), linked Packs and saved data stay the same.`;
};

/** Said where the access check is entered: what it proves, and that nothing
 *  switches until it passes. */
const renderAuthenticationSwitchCheckNote = (dialog: ConnectionsDialogState, fileSource: boolean): string =>
  `<p class="connections-switch-check-note" data-authentication-switch-check-note>${e(authenticationSwitchApplyLabel(dialog))} ${fileSource
    ? 'checks the file source with the new sign-in.'
    : 'reads this with the new sign-in. That shows the sign-in can read here, not that it has every permission.'} Your current sign-in stays active until the check passes.</p>`;

const renderCredentialRotation = (
  dialog: ConnectionsDialogState,
  schema: ConnectionSchema,
  /** The footer offers Manage authentication: name it as the way to sign in again. */
  signInAgain = false,
): string => {
  if (dialog.mode !== 'edit') return '';
  // A switch says this in its Check access step.
  if (dialog.authenticationSwitch) return '';
  // D-322 — the broker panel explains reauthorization beside its Reauthorize button.
  if (dialog.values['auth.type'] === 'managed_oauth') return '';
  const hasCredentialFields = schema.fields.some((field) =>
    field.key.startsWith('auth.') && field.key !== 'auth.type');
  if (!hasCredentialFields) return '';
  const replacing = shouldPatchConnectionAuth(schema, dialog.values);
  const title = dialog.saving && replacing
    ? 'Verifying replacement credentials…'
    : replacing
      ? 'Replacement ready to verify'
      : 'Current credentials stay active';
  const detail = replacing
    ? 'Recued will verify this complete replacement with the provider before switching. If verification fails, nothing in this connection changes.'
    : 'Leave credential fields blank to keep the current credentials. To rotate them, enter a complete replacement; Recued verifies it before switching.'
      + (signInAgain ? ' To sign in again or change how it signs in, use Manage authentication.' : '');
  return `
    <section class="connections-credential-rotation" data-credential-rotation="${replacing ? 'replacement' : 'current'}" role="status">
      <strong>${e(title)}</strong>
      <span>${e(detail)}</span>
    </section>
  `;
};

const renderCredentialSafeStopClosureNotice = (
  dialog: ConnectionsDialogState,
): string => {
  const notice = dialog.credentialSafeStopClosureNotice;
  if (notice === null) return '';
  const identity = `${notice.kind}/${notice.name}`;
  const nextStep = notice.nextStep === 'verify_replacement'
    ? 'Review this tab\'s memory-only replacement, then choose Verify and replace once.'
    : 'No credential was restored in this tab. Return to the connection list, then run one explicit check of the saved connection.';
  const action = notice.nextStep === 'check_saved_connection'
    ? button({
        label: 'Go back and check connection',
        size: 'sm',
        variant: 'secondary',
        action: 'connections-check-saved-after-safe-stop',
        data: { kind: notice.kind, name: notice.name },
        ariaLabel: `Return to the connection list and check the saved connection for ${identity}`,
      })
    : '';
  return `
    <section class="connections-credential-rotation"
             data-credential-safe-stop-closure="confirmed"
             role="status" aria-live="polite" aria-atomic="true">
      <strong>Recovery stop closed</strong>
      <span>The paired server confirmed that the previous safe stop for ${e(identity)} is no longer current. This acknowledgement did not send or replace a credential. ${e(nextStep)}</span>
      ${action}
    </section>
  `;
};

const renderExternalEditorChange = (
  dialog: ConnectionsDialogState,
): string => {
  const change = dialog.externalChange;
  if (change === null) return '';
  const identity = `${change.kind}/${change.name}`;
  const title = change.phase === 'checking'
    ? 'Checking a change from another tab…'
    : change.phase === 'removed'
      ? 'Connection removed since you opened it'
      : change.phase === 'unconfirmed'
        ? 'Could not load the latest connection'
        : 'Connection changed since you opened it';
  const detail = change.phase === 'checking'
    ? `Saving ${identity} is paused while Recued reads the latest server state. Your unsaved entries remain only in this tab.`
    : change.phase === 'removed'
      ? `Your unsaved entries remain only in this tab, but ${identity} no longer exists on the server and this stale editor cannot save.`
      : change.phase === 'unconfirmed'
        ? `Saving ${identity} remains paused so this draft cannot overwrite newer server state. Reconnect and reload the latest server state before saving.`
        : `Your unsaved entries remain only in this tab. Saving is paused so this draft cannot overwrite newer server state. Reloading clears this draft and loads the latest non-secret settings; credentials must be re-entered.`;
  const action = change.phase === 'checking'
    ? ''
    : button({
        label: change.phase === 'removed'
          ? 'Discard draft and close'
          : change.reloading
            ? 'Reloading latest…'
            : 'Reload latest',
        size: 'sm',
        action: 'connections-reload-stale-editor',
        disabled: change.reloading || dialog.saving,
      });
  return `
    <section class="connections-external-change" data-connection-external-change="${e(change.phase)}" role="alert" aria-live="assertive"${change.reloading ? ' aria-busy="true"' : ''}>
      <strong>${e(title)}</strong>
      <span>${e(detail)}</span>
      ${change.error === null ? '' : `<span class="connections-external-change-error">${e(change.error)}</span>`}
      ${action === '' ? '' : `<div class="connections-external-change-action">${action}</div>`}
    </section>
  `;
};

const renderCredentialRotationOwnership = (
  dialog: ConnectionsDialogState,
): string => {
  const ownership = dialog.credentialRotationOwnership;
  if (ownership === null) return '';
  const identity = `${ownership.kind}/${ownership.name}`;
  const safeStopPhase = ownership.phase === 'safe_stop_checking'
    || ownership.phase === 'safe_stopped'
    || ownership.phase === 'safe_stop_unconfirmed';
  const title = ownership.phase === 'checking'
    ? 'Checking who can continue…'
    : ownership.phase === 'pending'
      ? 'The server is still checking the new key'
      : ownership.phase === 'safe_stop_checking'
        ? 'Checking that swapping the key stopped…'
        : ownership.phase === 'safe_stopped'
          ? 'Swapping the key is stopped'
          : ownership.phase === 'safe_stop_unconfirmed'
            ? 'Could not check that swapping the key stopped'
            : ownership.phase === 'handoff'
              ? 'Another tab is handling this check'
              : ownership.phase === 'available'
                ? 'This tab can continue'
                : ownership.phase === 'unconfirmed'
                  ? 'Could not confirm this tab can take over'
                  : 'The key is being checked elsewhere';
  const detail = ownership.phase === 'checking'
    ? `Saving ${identity} is paused while Recued checks the other tab and your server. Your new key stays only in this tab.`
    : ownership.phase === 'pending'
      ? `This tab is in charge now, but your server is still checking ${identity}. Recued waits and does not send the key again.`
      : ownership.phase === 'safe_stop_checking'
        ? `Another tab says Recued stopped swapping the key for ${identity}. Saving is paused while this tab checks that with your server; your new key stays only in this tab.`
        : ownership.phase === 'safe_stopped'
          ? `Your server confirms Recued stopped swapping the key for ${identity}, but what it needs fixed does not match this form's sign-in method. Keep this draft here and look at the recovery before Recued checks again.`
          : ownership.phase === 'safe_stop_unconfirmed'
            ? `Saving ${identity} stays paused because this tab could not check that swapping the key stopped. Reconnect and check again, or carry on in the tab where the provider refused the key; your new key stays only here.`
            : ownership.phase === 'handoff'
              ? `Another tab is checking ${identity}. Recued waits for it before this draft can be sent; your new key stays only in this tab.`
              : ownership.phase === 'available'
                ? `Nothing else is checking ${identity}. Look over your new key, which is only in this tab, then choose Verify and replace when you are ready.`
                : ownership.phase === 'unconfirmed'
                  ? `Saving ${identity} stays paused because Recued could not confirm the earlier check finished. Your new key stays only in this tab.`
                  : ownership.automaticTakeover
                    ? `Another tab or device is checking ${identity} with the provider. Saving here is paused so the key is not sent twice; your draft stays only in this tab. If that tab goes away, Recued picks one tab to carry on by itself.`
                    : `Another tab or device is checking ${identity} with the provider. Saving here is paused so the key is not sent twice; your draft stays only in this tab. When that tab finishes or closes, choose Check availability.`;
  const action = ownership.phase === 'available'
    ? ''
    : button({
        label: ownership.phase === 'checking'
          ? 'Checking…'
          : ownership.phase === 'safe_stop_checking'
            ? 'Checking…'
            : safeStopPhase
              ? 'Check again'
              : ownership.phase === 'pending' || ownership.phase === 'handoff'
                ? 'Check again'
                : 'Check availability',
        size: 'sm',
        action: safeStopPhase
          ? 'connections-check-credential-safe-stop'
          : ownership.phase === 'handoff'
            ? 'connections-check-credential-rotation'
            : 'connections-check-credential-rotation-owner',
        data: { kind: ownership.kind, name: ownership.name },
        disabled: ownership.phase === 'checking'
          || ownership.phase === 'safe_stop_checking'
          || dialog.saving,
      });
  return `
    <section class="connections-external-change" data-connection-rotation-owner="${e(ownership.phase)}" role="status" aria-live="polite"${ownership.phase === 'checking' || ownership.phase === 'safe_stop_checking' ? ' aria-busy="true"' : ''}>
      <strong>${e(title)}</strong>
      <span>${e(detail)}</span>
      ${ownership.error === null ? '' : `<span class="connections-external-change-error">${e(ownership.error)}</span>`}
      ${action === '' ? '' : `<div class="connections-external-change-action">${action}</div>`}
    </section>
  `;
};

/** Render one schema-owned provider checklist for the active create-mode path.
 * The form remains the authority for values and validation; this card only
 * sequences the provider-side work and states the exact post-save check. */
const renderConnectionOnboarding = (
  dialog: ConnectionsDialogState,
  schema: ConnectionSchema,
): string => {
  if (dialog.mode !== 'create' || schema.onboarding === undefined) return '';
  const guide = schema.onboarding.guides.find(
    (candidate) => candidate.showWhen?.(dialog.values) ?? true,
  );
  if (guide === undefined) return '';

  const steps = guide.steps.map((step) => `
    <li>
      <strong>${e(step.title)}</strong>
      <span>${e(step.detail)}</span>
    </li>
  `).join('');
  let portal = '';
  if (guide.portal !== undefined) {
    try {
      const parsed = new URL(guide.portal.url);
      if (
        parsed.protocol === 'https:'
        && parsed.username === ''
        && parsed.password === ''
        && parsed.hostname !== ''
      ) {
        portal = `
          <a class="connections-onboarding-portal" href="${e(guide.portal.url)}"
             target="_blank" rel="noopener noreferrer">
            ${e(guide.portal.label)} (new tab) <span aria-hidden="true">↗</span>
          </a>
        `;
      }
    } catch {
      // Schema-owned links fail closed. A malformed future URL must not turn a
      // provider checklist into an unsafe or broken navigation affordance.
    }
  }

  return `
    <section class="connections-onboarding" data-connection-onboarding="${e(guide.key)}"
             data-tone="${e(guide.tone)}" aria-labelledby="connection-onboarding-title">
      <div class="connections-onboarding-heading">
        <div>
          <p class="connections-onboarding-badge">${e(guide.badge)}</p>
          <h4 id="connection-onboarding-title">${e(guide.title)}</h4>
        </div>
        ${portal}
      </div>
      <p class="connections-onboarding-description">${e(guide.description)}</p>
      <ol class="connections-onboarding-steps">${steps}</ol>
      ${guide.note === undefined
        ? ''
        : `<p class="connections-onboarding-note" role="note"><strong>Before you continue:</strong> ${e(guide.note)}</p>`}
      <p class="connections-onboarding-verification">
        <strong>What Save and test checks:</strong> ${e(guide.verification)}
      </p>
    </section>
  `;
};

const renderForm = (
  dialog: ConnectionsDialogState,
  dynamicOptions: Record<string, readonly string[]> | undefined,
  managedOAuthAvailable = false,
): string => {
  const kind = dialog.kind;
  if (!kind) {
    return inlineError('Connection kind missing — pick a kind to continue.');
  }
  let schema = resolveConnectionSchema(
    kind,
    dialog.subtype ?? undefined,
    dialog.vendor ?? undefined,
    dialog.values['auth.type'],
  );
  if (!schema) {
    return inlineError(
      `No schema for ${kind}${dialog.subtype ? `/${dialog.subtype}` : ''} — pick a different subtype.`,
    );
  }
  if (dialog.authenticationSwitch) schema = withAuthenticationSwitchSchema(schema);
  const validationIssue = connectionFormValidationIssue(
    schema,
    dialog.values,
    dynamicOptions,
    dialog.mode,
  );
  const credentialRotation = dialog.mode === 'edit'
    && shouldPatchConnectionAuth(schema, dialog.values);
  const managedConsent = dialog.values['auth.type'] === 'managed_oauth';
  const matchingRecoveredReceipt = dialog.recentProbe?.recovered === true
    && dialog.editingId === connectionRowKey(
      dialog.recentProbe.kind,
      dialog.recentProbe.name,
    )
    ? renderRecentProbe(dialog)
    : '';
  const onboarding = renderConnectionOnboarding(dialog, schema);
  const probeNote = schema.probe && onboarding === ''
    ? fieldHint(
        schema.probe.description ??
          (schema.probe.kind && schema.probe.op
            ? `After save, a probe runs (${schema.probe.kind}.${schema.probe.op}) to verify the binding.`
            : `After save, a probe runs (${schema.probe.method ?? 'kind-specific'}${schema.probe.path ? ' ' + schema.probe.path : ''}) to verify the credentials.`),
      )
    : '';
  // D-129 P1.3 — vendor flows skip subtype-picker (vendors are always
  // kind=api). The Back affordance therefore points back to the
  // kind-picker, regardless of `kind`. Bare-kind forms keep the
  // existing kind=api → kind-picker, kind=mcp/notification →
  // subtype-picker mapping.
  const backAction = dialog.vendor
    ? 'connections-back-to-kind'
    : kind === 'api'
      ? 'connections-back-to-kind'
      : 'connections-back-to-subtype';
  const validationShouldAnnounce = connectionFormValidationShouldAnnounce(
    dialog,
    validationIssue,
  );
  // Re-authorizing, changing the app and reconnecting all keep the method.
  const fixedMethod = Boolean(dialog.authenticationRepair
    || dialog.authenticationManagement && dialog.authenticationManagement !== 'method');
  const savedAppIssuer = selectedSavedOAuthAppIssuer(dialog);
  // An edit of a saved API connection reads like the broker form: what the
  // connection is, then how it signs in. Setup help and a first sign-in's
  // consent notice are for new connections, and the status sits by Save.
  const editingApi = dialog.mode === 'edit' && kind === 'api' && !dialog.authenticationSwitch;
  // The saved credentials stay unless a complete replacement is entered, so an
  // edit asks for credentials, and shows the sign-in card, only once one is under way.
  const replacingCredentials = editingApi && (credentialRotation || dialog.oauthInFlight || dialog.oauthError !== null
    || dialog.oauthGrantedScopes !== null || dialog.oauthNeedsReauthorization || dialog.credentialCorrection !== null);
  const offersManageAuthentication = managedOAuthAvailable && editingApi
    && ['oauth2_refresh', 'bearer', 'managed_oauth'].includes(dialog.values['auth.type'] ?? '')
    && schema.fields.some(field => field.key === 'auth.type' && field.options?.includes('managed_oauth'));
  const editFieldCopy = (key: string): { help?: string; optional?: true } | undefined => {
    if (!editingApi) return undefined;
    if (key === 'name') return { optional: true, help: 'Screens, run records and AI clients refer to the connection by this name, so it stays as it is.' };
    if (key === 'auth.refresh_token') return { optional: true, help: 'Filled in when you authorize. To use a refresh token you already have, paste it here.' };
    if (key.startsWith('auth.') && key !== 'auth.type' && !replacingCredentials) return { optional: true };
    return undefined;
  };
  // In a switch, a locked control says why it is locked instead of how to fill
  // it in, and carries no "required" mark: there is nothing to enter.
  const switchFieldCopy = (key: string): { label?: string; help: string; optional?: true } | undefined => {
    if (!dialog.authenticationSwitch) return undefined;
    if (key === 'auth.type' && fixedMethod) {
      return { label: 'Authentication method', optional: true, help: dialog.authenticationRepair ? 'Reconnecting keeps this method.'
        : dialog.authenticationManagement === 'app' ? 'Changing the app keeps this method.' : 'Re-authorizing keeps this method.' };
    }
    if (key === 'auth.client_id' && (dialog.authenticationRepair || dialog.authenticationManagement === 'reauthorize')) {
      return { optional: true, help: savedAppIssuer !== null
        ? `Your current ${savedAppIssuer === 'google' ? 'Google' : 'Microsoft'} app. Its secret stays on your server.`
        : dialog.authenticationManagementCanChangeApp && !dialog.authenticationRepair
          ? 'Your current OAuth app. To use another, choose Change OAuth app above.'
          : 'Your current OAuth app.' };
    }
    if (key === 'auth.refresh_token') return { help: 'Filled in when you authorize. To use a refresh token you already have, paste it here.' };
    return undefined;
  };
  // A new API connection is asked first how it signs in: the three ways most
  // services take as cards, and every other method one select away.
  const choosesMethod = dialog.mode === 'create' && kind === 'api' && dialog.vendor === null && !dialog.authenticationSwitch;
  const renderAuthMethodChoice = (field: ConnectionField): string => {
    const { options } = resolveSelectOptions(field, dynamicOptions);
    const current = dialog.values['auth.type'] || options[0] || '';
    const cards = AUTH_METHOD_CARDS.filter(card => options.includes(card.type) && (card.type !== 'managed_oauth' || managedOAuthAvailable));
    const others = options.filter(option => !cards.some(card => card.type === option));
    const locked = dialog.saving || dialog.oauthInFlight;
    const otherChosen = others.includes(current);
    return `<div class="connections-field-row connections-auth-method" data-field-key="auth.type" role="group" aria-labelledby="connections-auth-method-title">
      <span class="connections-auth-method-title" id="connections-auth-method-title">How it signs in</span>
      <div class="connections-auth-method-cards">${cards.map(card => `<button type="button" class="connections-auth-method-card" data-action="connections-choose-auth" data-auth-type="${e(card.type)}" aria-pressed="${current === card.type}"${locked ? ' disabled' : ''}>
        <strong>${e(card.title)}</strong><span>${e(card.description)}</span></button>`).join('')}</div>
      ${others.length ? `<label class="connections-auth-method-other" for="${e(fieldId(field.key))}"><span>Other ways to sign in</span>${selectField({
        id: fieldId(field.key), data: { 'conn-field': field.key }, disabled: locked,
        options: [{ value: '', label: 'Choose another way…', selected: !otherChosen, disabled: true },
          ...others.map(option => ({ value: option, selected: option === current,
            label: field.optionLabels?.[option] ?? AUTH_LABELS[option as ConnectionAuthType] ?? option }))],
      })}</label>` : ''}
    </div>`;
  };
  const renderSchemaField = (field: ConnectionField): string => {
    if (choosesMethod && field.key === 'auth.type') return renderAuthMethodChoice(field);
    const readonly = (dialog.authenticationRepair && ['auth.client_id', 'auth.token_endpoint', 'auth.scopes'].includes(field.key))
      || (dialog.authenticationManagement === 'reauthorize' && ['auth.client_id', 'auth.token_endpoint'].includes(field.key))
      || (managedConsent && dialog.mode === 'edit' && field.key === 'config.base_url')
      || (savedAppIssuer !== null && field.key === 'auth.client_id');
    const copy = switchFieldCopy(field.key) ?? editFieldCopy(field.key);
    return renderField(
      // A locked field has nothing to enter, so it carries no required mark.
      readonly || copy ? { ...field, ...(readonly ? { readonly: true, optional: true } : {}),
        ...(readonly && dialog.authenticationRepair && field.key === 'auth.scopes' ? { help: 'This request keeps known current permissions and adds the Pack scopes. Review the full request before signing in.' } : {}),
        ...(readonly && managedConsent && dialog.mode === 'edit' && field.key === 'config.base_url' ? { help: 'Fixed for this connection: its authorization is bound to this address. To use another address, add a new connection.' } : {}),
        ...copy } : field,
      dialog.values,
      dynamicOptions,
      dialog.mode,
      dialog.saving || (fixedMethod && field.key === 'auth.type') || (dialog.oauthInFlight && isConnectionOAuthLockedField(field.key)),
      dialog.oauthErrorFieldKey,
      dialog.credentialCorrection?.fieldKeys ?? [],
      dialog.hintedFields,
    );
  };
  const onboardingSelectorKey = dialog.mode === 'create'
    ? schema.onboarding?.selectorKey
    : undefined;
  // An edit names the connection being edited, not its kind.
  const editingName = dialog.mode === 'edit' && !dialog.authenticationManagement && !dialog.authenticationRepair && !dialog.authenticationSwitch
    ? (dialog.values['display_name'] ?? '').trim() || (dialog.values['name'] ?? '').trim()
    : '';
  // An API connection's form, new or saved, reads as two parts: what the
  // connection is, then how it signs in. (A switch has its own steps.)
  const fieldGroups = kind === 'api' && !dialog.authenticationSwitch;
  const credentialNote = renderCredentialRotation(dialog, schema, offersManageAuthentication);
  let credentialNoteInGroup = false;
  let fieldGroup = '';
  const renderGroupedField = (field: ConnectionField): string => {
    const group = field.key.startsWith('auth.') ? 'sign-in' : 'connection';
    const heading = fieldGroups && !field.hidden && group !== fieldGroup
      ? `<h4 class="connections-form-group-title" data-connection-form-group="${group}">${group === 'sign-in' ? 'Sign-in' : 'Connection'}</h4>`
      : '';
    if (heading) fieldGroup = group;
    // An edit says what happens to the saved credentials where they are entered.
    const note = heading && group === 'sign-in' && editingApi ? credentialNote : '';
    if (note) credentialNoteInGroup = true;
    return heading + note + renderSchemaField(field);
  };
  const onboardingSelector = onboardingSelectorKey === undefined
    ? undefined
    : schema.fields.find((field) => field.key === onboardingSelectorKey);
  const fileSource = fileSourceOAuthProvider(dialog.vendor, dialog.values['config.base_url']) !== undefined;
  const formFields = schema.fields
    .filter((field) => !(field.key === 'switch.verification_url' && dialog.authenticationSwitch && fileSource) && field.key !== onboardingSelectorKey
      && !(field.key === 'auth.client_secret' && savedAppIssuer !== null));
  // Rendered before the template so the credential note knows whether it found its group.
  const groupedFields = dialog.authenticationSwitch ? '' : formFields.map(renderGroupedField).join('');
  const validation = dialog.credentialCorrection === null || validationIssue !== null
    ? renderConnectionFormValidation(validationIssue, validationShouldAnnounce, dialog.authenticationSwitch !== null)
    : '';
  const oauthHelpHost = ['oauth2_refresh', 'oauth2_client_credentials'].includes(dialog.values['auth.type'] ?? '')
    ? '<div data-connection-oauth-help-host></div>' : '';
  // An edit keeps its setup guide and OAuth troubleshooting below the fields, as help.
  const editHelpBody = editingApi ? renderConnectionSetupGuide(dialog, schema) + oauthHelpHost : '';
  const editHelp = editHelpBody ? `<div class="connections-form-help">${editHelpBody}</div>` : '';
  // A switch (Manage authentication, Reconnect) is one job done in order: sign
  // in, review that sign-in, check it can read, apply. Its form is those
  // numbered steps. The saved name and label cannot change there, so the title
  // and intro name them instead of two locked fields.
  const renderSwitchSteps = (): string => {
    const direct = dialog.values['auth.type'] === 'oauth2_refresh';
    const broker = dialog.values['auth.type'] === 'managed_oauth';
    const fields = (keep: (key: string) => boolean, heading = ''): string => {
      const html = formFields.filter(field => keep(field.key)).map(renderSchemaField).join('');
      return html.trim() ? `<div class="connections-form-fields">${heading}${html}</div>` : '';
    };
    // What the switch cannot change, such as the API address a broker sign-in is bound to.
    const pinned = fields(key => !key.startsWith('auth.') && !key.startsWith('switch.') && key !== 'name' && key !== 'display_name',
      '<h4 class="connections-form-group-title" data-connection-form-group="connection">Connection</h4>');
    const who = dialog.vendor ? vendorDisplayName(dialog.vendor, getVendorProvider(dialog.vendor)) : null;
    const steps: Array<{ id: keyof typeof AUTHENTICATION_SWITCH_STEP_KEYS; title: string; help?: string; body: string }> = [
      { id: 'sign-in', title: broker ? 'Sign in through Nango' : who ? `Sign in with ${who}` : 'Sign in',
        body: fields(key => key === 'auth.type') + renderSavedOAuthApps(dialog)
          + fields(key => key.startsWith('auth.') && key !== 'auth.type') + renderVendorOAuth(dialog)
          + (broker ? '<div data-managed-oauth-host></div>' : '') },
      ...(direct ? [{ id: 'review' as const, title: 'Review the sign-in',
        help: e(dialog.authenticationRepair
          ? 'See which account you signed in as and what it allows before you apply this reauthorization.'
          : fileSource
            ? `Sign in as the same ${who ?? 'vendor'} account, with access to every file. Checking file details can take longer for large sources.`
            : 'See which account you signed in as, what it allows, and which connections change. A different account may see different data.'),
        body: `<section class="connections-switch-review" data-direct-oauth-review>
          <div data-direct-oauth-impact></div>
          ${button({ label: dialog.directAuthenticationReview ? 'Review direct OAuth again' : 'Review direct OAuth account and permissions',
            size: 'sm', action: 'connections-review-direct-authentication', disabled: dialog.saving || dialog.oauthInFlight || dialog.externalChange !== null })}
        </section>` }] : []),
      { id: 'check', title: 'Check access',
        body: fields(key => key.startsWith('switch.')) + renderAuthenticationSwitchCheckNote(dialog, fileSource) },
    ];
    // The setup guide helps fill in a new app. Re-authorizing keeps the current one.
    const keepsApp = dialog.authenticationRepair || dialog.authenticationManagement === 'reauthorize';
    const help = (keepsApp ? '' : renderConnectionSetupGuide(dialog, schema)) + oauthHelpHost;
    return (pinned ? `<div class="connections-switch-pinned">${pinned}</div>` : '')
      + steps.map((step, index) => `
        <section class="connections-switch-step" data-authentication-switch-step="${step.id}" data-field-key="${AUTHENTICATION_SWITCH_STEP_KEYS[step.id]}" aria-labelledby="connections-switch-step-${step.id}">
          <h4 class="connections-switch-step-title" id="connections-switch-step-${step.id}"><span class="connections-switch-step-number">${index + 1}</span><span>${e(step.title)}</span></h4>
          ${step.help ? `<p class="connections-switch-step-help">${step.help}</p>` : ''}
          <div class="connections-switch-step-body">${step.body}</div>
        </section>`).join('')
      + (help ? `<div class="connections-form-help">${help}</div>` : '');
  };
  const switchCurrent = dialog.authenticationSwitch ? authenticationSwitchCurrent(dialog.authenticationSwitch) : null;
  return `
    <div class="connections-form" data-stage="form"${dialog.vendor ? ` data-vendor="${e(dialog.vendor)}"` : ''}>
      <h3 class="connections-form-title" data-connection-dialog-heading tabindex="-1">
        ${e(dialog.authenticationManagement ? 'Manage authentication for ' : dialog.authenticationRepair ? 'Reconnect ' : dialog.authenticationSwitch ? 'Switch authentication for ' : dialog.mode === 'edit' ? 'Edit ' : 'Add ')}${e(dialog.authenticationSwitch ? dialog.authenticationSwitch.display_name || dialog.authenticationSwitch.name : editingName || schema.label)}
      </h3>
      <p class="connections-form-description">${dialog.authenticationSwitch ? renderAuthenticationSwitchIntro(dialog) : e(schema.description)}</p>
      ${dialog.authenticationManagement && dialog.authenticationSwitch && switchCurrent ? renderAuthenticationManagement({ prefix: 'connections',
        action: dialog.authenticationManagement, ...switchCurrent, heading: false, note: false,
        canReauthorize: ['oauth2_refresh', 'managed_oauth'].includes(dialog.authenticationSwitch.auth_type ?? ''),
        canChangeApp: !dialog.authenticationRepair && dialog.authenticationManagementCanChangeApp === true,
        historyScope: { kind: 'connection', name: dialog.authenticationSwitch.name },
        canChangeMethod: !dialog.authenticationRepair, busy: dialog.saving || dialog.oauthInFlight || dialog.externalChange !== null })
        : switchCurrent ? `<p class="connections-switch-current">Current: <strong>${e(switchCurrent.current)}</strong>${switchCurrent.account ? ' · ' + e(switchCurrent.account) : ''}</p>` : ''}
      ${onboardingSelector === undefined
        ? ''
        : `<div class="connections-onboarding-selector" data-connection-onboarding-selector>
            ${renderSchemaField(onboardingSelector)}
          </div>`}
      ${onboarding}
      ${probeNote}
      ${matchingRecoveredReceipt}
      ${renderExternalEditorChange(dialog)}
      ${renderCredentialRotationOwnership(dialog)}
      ${dialog.authenticationSwitch || editingApi ? '' : renderConnectionSetupGuide(dialog, schema)}
      ${dialog.authenticationSwitch || dialog.mode === 'edit' ? '' : renderVendorConsentDisclosure(dialog)}
      ${credentialNoteInGroup ? '' : credentialNote}
      ${renderCredentialSafeStopClosureNotice(dialog)}
      ${renderCredentialCorrection(dialog, schema)}
      ${dialog.authenticationSwitch ? renderSwitchSteps() : `${editingApi ? '' : validation}
      <div class="connections-form-fields">
        ${groupedFields}
      </div>
      ${renderSavedOAuthApps(dialog)}
      ${editingApi && !replacingCredentials ? '' : renderVendorOAuth(dialog)}
      ${dialog.values['auth.type'] === 'managed_oauth' ? '<div data-managed-oauth-host></div>' : ''}
      ${editingApi ? editHelp : oauthHelpHost}`}
      ${dialog.error && dialog.credentialCorrection === null && dialog.error !== validationIssue?.message
        ? inlineError(dialog.error)
        : ''}
      ${/* In a switch or an edit, what is still missing is said beside the button it holds back. */
        dialog.authenticationSwitch || editingApi ? `<div class="connections-form-status">${validation}</div>` : ''}
      <div class="connections-dialog-footer">
      <p class="connections-form-draft-protection" data-connection-draft-protection>
        Changes stay in this tab until you save, and Recued asks before you leave.
        Credential fields are never kept in your browser, so a discard or reload clears them.
      </p>
      <div class="connections-dialog-actions">
        ${offersManageAuthentication
          ? button({ label: 'Manage authentication', size: 'sm', action: 'connections-manage-authentication',
              disabled: dialog.saving || dialog.oauthInFlight || dialog.externalChange !== null }) : ''}
        ${dialog.authenticationSwitch ? button({ label: 'Keep current authentication', size: 'sm',
          action: 'connections-cancel-authentication-switch', disabled: dialog.saving || dialog.oauthInFlight }) : ''}
        ${/* Back means "I picked the wrong kind" — it returns to the picker and
              WIPES `values`. Once a provider consent has completed in this
              session that is a strictly worse Cancel: same exit, same discard,
              but phrased as navigation. Retire it there, leaving two buttons
              whose difference is legible (save it / drop it). Gated on
              `oauthGrantedScopes`, not on the token: a hand-pasted refresh
              token consumed nothing external, so its Back stays. */''}
        ${dialog.mode === 'create' && dialog.oauthGrantedScopes === null
          ? button({
              label: 'Back',
              size: 'sm',
              action: backAction,
            })
          : ''}
        ${button({
          label: 'Cancel',
          size: 'sm',
          action: 'connections-cancel-dialog',
          disabled: dialog.saving && credentialRotation,
        })}
        ${button({
          label: dialog.saving
            ? dialog.authenticationManagement ? 'Verifying and applying…' : dialog.authenticationSwitch ? 'Verifying and switching…'
              : credentialRotation && !managedConsent
              ? 'Verifying replacement…'
              : 'Saving…'
            : dialog.authenticationRepair ? 'Verify access and return to pack' : dialog.authenticationManagement ? 'Verify and apply' : dialog.authenticationSwitch ? 'Verify and switch'
            : dialog.mode === 'edit'
              ? credentialRotation
                ? managedConsent ? 'Save authorization' : 'Verify and replace'
                : 'Save changes'
              : 'Save and test',
          variant: 'primary',
          size: 'sm',
          action: 'connections-submit-form',
          disabled: dialog.saving
            || dialog.oauthInFlight
            || dialog.externalChange !== null
            || hasCredentialRegenerationSafeStop(dialog)
            || (
              dialog.credentialRotationOwnership !== null
              && dialog.credentialRotationOwnership.phase !== 'available'
            )
            || validationIssue !== null,
        })}
      </div>
      </div>
    </div>
  `;
};

const renderDialog = (props: ConnectionsPageProps): string => {
  const d = props.dialog;
  if (d.stage === 'closed') return '';
  let body = '';
  if (d.stage === 'kind-picker') body = renderKindPicker();
  else if (d.stage === 'subtype-picker') {
    if (d.kind === 'mcp' || d.kind === 'notification') {
      body = renderSubtypePicker(d.kind);
    } else {
      body = inlineError('Subtype picker requested for a kind without subtypes.');
    }
  } else if (d.stage === 'form') body = renderForm(d, props.dynamicOptions, props.managedOAuthAvailable);
  // `data-dialog-mode` lets the page around a new connection's setup step back
  // (the Connections route hides its Advanced tools while one is being added).
  return `
    <div class="connections-dialog" role="dialog" aria-label="Connection enrollment" data-dialog-mode="${d.mode}">
      ${body}
    </div>
  `;
};

const renderHeader = (props: ConnectionsPageProps): string => {
  if (props.layout === 'embedded') {
    const heading = props.dialog.stage === 'closed'
      ? 'Enrolled connections'
      : 'Connection setup';
    return `<h2 class="connections-embedded-title" id="connections-embedded-heading">${heading}</h2>`;
  }
  return `
    <header class="connections-page-header">
      <button type="button"
        class="rx-btn rx-btn-link rx-btn-sm btn btn-link btn-sm"
        data-action="connections-close-page">
        ← Settings
      </button>
      <h2 class="connections-page-title">Connections</h2>
      <p class="connections-page-subtitle">
        Outbound endpoints recipes use — HTTP APIs, MCP servers, and notification destinations.
      </p>
    </header>
  `;
};

/** D-192 slice 5 — the delete-confirm modal. Renders over the list when a Delete
 *  click is awaiting confirmation. The "also remove the [N] item(s)" checkbox
 *  appears ONLY when the `previewPurge` count resolved to > 0 (a `null` count —
 *  still loading, caller unwired, or a non-purgeable connection — or a 0 count
 *  render a plain confirm: the connection is removed, its synced data kept). */
/** D-320 slice 2g (ruling 16) — what deleting the connection does to the packs
 *  whose lists hold it: only the ones whose runs change, each in one sentence.
 *  While it loads, and if it fails, the dialog says so: silence would read as
 *  "nothing changes". */
const renderDeleteEffects = (effects: ConnectionsDeleteEffects | undefined): string => {
  if (effects === undefined) return '';
  if (effects.status === 'loading') {
    return '<p class="connections-delete-effects-note" data-connections-delete-effects="loading">Checking what changes for your packs…</p>';
  }
  if (effects.status === 'failed') {
    return '<p class="connections-delete-effects-note" data-connections-delete-effects="failed">Could not check what changes for your packs.</p>';
  }
  const changes = connectionRemovalChanges(effects.packs);
  // D-320 audit — and each recipe reading two of those lists at once: its runs need a
  // connection on both, so its answer is not its packs'.
  const recipeChanges = connectionRemovalRecipeChanges(effects.recipes);
  if (changes.length === 0 && recipeChanges.length === 0) return '';
  const items = changes
    .map((effect) => `<li data-delete-effect="${e(effect.outcome)}" data-delete-effect-pack="${e(effect.pack_slug)}">${e(connectionRemovalSentence(effect))}</li>`)
    .join('')
    + recipeChanges
      .map((effect) => `<li data-delete-effect="${e(effect.outcome)}" data-delete-effect-recipe="${e(effect.recipe_id)}">${e(connectionRemovalRecipeSentence(effect))}</li>`)
      .join('');
  return `
        <div class="connections-delete-effects" data-connections-delete-effects="ready">
          <p class="connections-delete-effects-title">What changes for your packs</p>
          <ul class="connections-delete-effects-list">${items}</ul>
        </div>`;
};

const renderDeleteConfirm = (props: ConnectionsPageProps): string => {
  const dc = props.deleteConfirm;
  if (dc === null) return '';
  const showOptIn = typeof dc.count === 'number' && dc.count > 0;
  const optInBlock = showOptIn
    ? `
        <label class="connections-delete-optin">
          <input type="checkbox" data-action="connections-delete-toggle-mirror"${
            dc.removeMirror ? ' checked' : ''
          }${dc.deleting ? ' disabled' : ''} />
          <span>Also remove the ${dc.count} item${
            dc.count === 1 ? '' : 's'
          } this connection synced to your warehouse</span>
        </label>
        <p class="connections-delete-note">
          Deletes the mirrored records this connection created. Your account and its
          activity history are kept.
        </p>`
    : '';
  const body = showOptIn
    ? 'Remove this connection. Its synced data is kept unless you opt in below.'
    : 'Remove this connection. Its synced data is kept.';
  return `
    <div class="connections-delete-backdrop">
      <div class="connections-delete-confirm" role="dialog" aria-modal="true"
           aria-label="Remove connection ${e(dc.name)}">
        <h3 class="connections-delete-title">Remove ${e(dc.name)}?</h3>
        <p class="connections-delete-body">${body}</p>
        ${renderDeleteEffects(dc.effects)}
        ${optInBlock}
        <div class="connections-delete-actions">
          ${button({
            label: 'Cancel',
            size: 'sm',
            action: 'connections-delete-cancel',
            disabled: dc.deleting,
          })}
          ${button({
            label: dc.deleting ? 'Removing…' : 'Remove',
            size: 'sm',
            variant: 'danger',
            action: 'connections-delete-confirm',
            data: { kind: dc.kind, name: dc.name },
            disabled: dc.deleting,
          })}
        </div>
      </div>
    </div>
  `;
};

export const renderConnectionsPage = (props: ConnectionsPageProps): string => {
  const dialogOpen = props.dialog.stage !== 'closed';
  const embeddedRegion = props.layout === 'embedded'
    ? ' role="region" aria-labelledby="connections-embedded-heading"'
    : '';
  return `
    <div class="connections-page${dialogOpen ? ' connections-page--dialog-open' : ''}"${embeddedRegion}>
      ${renderHeader(props)}
      ${renderCredentialRotationRecovery(props)}
      ${renderPostSafeStopProfileHandoff(props)}
      ${dialogOpen ? renderDialog(props) : renderListView(props)}
      ${dialogOpen ? '' : renderDeleteConfirm(props)}
      ${dialogOpen ? '' : renderMcpPackReview(props.mcpPackReview)}
    </div>
  `;
};

/** Self-contained CSS — same convention as every primitive
 *  (`.connections-*` selectors only, no ancestor coupling). The
 *  options-page + sidebar both already include the primitive
 *  stylesheet so we only add page-specific rules here. */
export const CONNECTIONS_PAGE_STYLES = `
${AUTHENTICATION_MANAGEMENT_STYLES}
.connections-auth-note{margin:0;color:var(--fg-muted);font-size:12px;line-height:1.5}
.connections-inventory-filters{display:flex;flex-wrap:wrap;align-items:end;gap:10px;margin:12px 0;font-size:13px}
.connections-inventory-filters label{display:grid;gap:5px;min-width:0}.connections-inventory-filters label:first-child{flex:1 1 180px}
.connections-inventory-filters input,.connections-inventory-filters select{box-sizing:border-box;min-width:0;max-width:100%;font:inherit;padding:9px;border:1px solid var(--border);border-radius:7px;background:var(--surface);color:var(--fg)}
${REFERENCE_PROVENANCE_STYLES}
.connections-page {
  box-sizing: border-box;
  min-width: 0;
  max-width: 100%;
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 16px;
}
.connections-page-header {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.connections-page-title {
  font-size: 16px;
  font-weight: 600;
  margin: 0;
}
.connections-embedded-title {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}
.connections-page-subtitle {
  font-size: 12px;
  color: var(--fg-muted);
  margin: 0;
}
.connections-loading {
  font-size: 12px;
  color: var(--fg-muted);
}
.connections-credential-recovery {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid var(--border, #d7d7d7);
  border-radius: 8px;
  background: var(--surface-subtle, #f7f7f7);
  color: var(--fg, #202020);
  font-size: 12px;
  line-height: 1.45;
}
.connections-credential-recovery[data-connection-credential-recovery="resumable"],
.connections-credential-recovery[data-connection-credential-recovery="restart_ready"],
.connections-credential-recovery[data-connection-credential-recovery="restart_checking"],
.connections-credential-recovery[data-connection-credential-recovery="restart_triaging"],
.connections-credential-recovery[data-connection-credential-recovery="restart_handoff"],
.connections-credential-recovery[data-connection-credential-recovery="restart_waiting"],
.connections-credential-recovery[data-connection-credential-recovery="restart_unsupported"],
.connections-credential-recovery[data-connection-credential-recovery="restart_resolved"] {
  border-color: var(--accent, var(--border));
  background: color-mix(in srgb, var(--accent) 6%, var(--bg));
}
.connections-credential-recovery-action {
  display: flex;
  flex: 0 0 auto;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 6px;
}
.connections-pack-inventory {
  border-color: var(--warn-border, #b8860b);
  background: color-mix(in srgb, var(--warn-bg, #f6b73c) 8%, var(--bg));
}
.connections-pack-inventory-copy {
  display: grid;
  gap: 2px;
}
.connections-pack-inventory-copy span { color: var(--fg-muted); }
@media (max-width: 560px) {
  .connections-credential-recovery {
    align-items: flex-start;
    flex-direction: column;
  }
  .connections-credential-recovery-action { justify-content: flex-start; }
}
.connections-group {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.connections-group-title {
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  color: var(--fg-muted);
  margin: 0 0 4px;
}
.connections-group-rows {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.connections-pack-usage {
  min-width: 0;
  margin: 4px 0 2px 12px;
  padding-top: 4px;
  border-top: 1px solid var(--border, #e5e5e5);
}
.connections-pack-usage-heading {
  margin: 0 0 2px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--fg-muted);
}
.connections-pack-usage-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.connections-pack-usage-item {
  min-width: 0;
  overflow-wrap: anywhere;
  font-size: 12px;
}
.connections-pack-usage-name { min-width: 0; overflow-wrap: anywhere; font-weight: 600; }
.connections-pack-usage-status { min-width: 0; overflow-wrap: anywhere; color: var(--fg-muted); }
/* D-225 — the generated-pack badge. "attention" is the ONLY tone that pulls the
   eye: if every state were emphasised the badge would be noise and the one that
   matters would be ignored. "unknown" earns it because silence there reads as
   reassurance. */
.connections-mcp-pack {
  margin-top: 8px;
  padding: 8px 10px;
  border-radius: 6px;
  border: 1px solid var(--border-subtle, rgba(127,127,127,0.25));
}
.connections-mcp-pack[data-mcp-pack-tone="attention"] {
  border-color: var(--warn-border, #b8860b);
}
.connections-mcp-pack-heading { margin: 0; font-size: 12px; }
.connections-mcp-pack-label { font-weight: 600; }
.connections-mcp-pack[data-mcp-pack-tone="attention"] .connections-mcp-pack-label {
  color: var(--warn-fg, #b8860b);
}
.connections-mcp-pack-detail { margin: 2px 0 0; font-size: 12px; color: var(--fg-muted); }
.connections-mcp-pack-action { margin-top: 6px; font-size: 12px; }
/* D-225 — the generated-pack review. A disclosure screen: it lists what a
   server publishes and what tier each tool will get, and Save installs. There
   is deliberately no per-row relax control here — see renderMcpPackReview. */
.connections-review {
  margin-top: 12px;
  padding: 12px;
  border-radius: 8px;
  border: 1px solid var(--border-subtle, rgba(127,127,127,0.25));
}
.connections-review-title { margin: 0 0 4px; font-size: 14px; }
.connections-review-summary { margin: 0 0 10px; font-size: 12px; color: var(--fg-muted); }
.connections-review-error { margin: 0 0 8px; font-size: 12px; color: var(--warn-fg, #b8860b); }
.connections-review-note { margin: 0; font-size: 12px; color: var(--fg-muted); }
.connections-review-list { list-style: none; margin: 0 0 10px; padding: 0; }
.connections-review-row {
  padding: 8px 0;
  border-top: 1px solid var(--border-subtle, rgba(127,127,127,0.18));
}
.connections-review-tool { margin: 0; font-size: 13px; }
.connections-review-desc { margin: 2px 0 0; font-size: 12px; color: var(--fg-muted); }
.connections-review-claim { margin: 2px 0 0; font-size: 12px; font-style: italic; color: var(--fg-muted); }
.connections-review-tier { margin: 2px 0 0; font-size: 12px; font-weight: 600; }
.connections-review-offer { margin: 2px 0 0; font-size: 12px; color: var(--fg-muted); }
.connections-pack-usage-item[data-pack-usage-tone="warn"] .connections-pack-usage-status {
  color: var(--danger, #b3261e);
}
.connections-row {
  box-sizing: border-box;
  min-width: 0;
  max-width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
}
.connections-row-info {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 4px;
  flex: 1;
  min-width: 0;
}
.connections-row-identity, .connections-row-meta {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 4px 10px;
  min-width: 0;
  overflow-wrap: anywhere;
}
.connections-row-meta { font-size: 11px; color: var(--fg-muted); }
.connections-row-meta > span { min-width: 0; }
.connections-row-name {
  min-width: 0;
  overflow-wrap: anywhere;
  font-size: 13px;
  color: var(--fg);
}
.connections-row-subtype {
  font-size: 11px;
  color: var(--fg-muted);
  text-transform: lowercase;
}
.connections-row-summary {
  min-width: 0;
  max-width: 100%;
  font-size: 12px;
  color: var(--fg-muted);
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.connections-row-display {
  min-width: 0;
  overflow-wrap: anywhere;
  font-size: 11px;
  color: var(--fg-muted);
}
.connections-row-actions {
  min-width: 0;
  max-width: 100%;
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}
@media (max-width: 560px) {
  .connections-row {
    align-items: stretch;
    flex-direction: column;
  }
  .connections-row-info {
    width: 100%;
    align-items: stretch;
    flex-direction: column;
    gap: 4px;
  }
  .connections-row-summary { width: 100%; }
  .connections-row-summary:empty { display: none; }
  .connections-row-actions {
    flex-wrap: wrap;
  }
}
.connections-add-row {
  display: flex;
  justify-content: flex-start;
  margin-top: 8px;
}
.connections-dialog {
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 16px;
  background: var(--bg);
}
/* D-322 — broker setup, enrollment and independent management share one layout. */
.connections-broker-manager {
  display: flex; flex-wrap: wrap; align-items: center; gap: 12px;
  max-width: 720px; padding: 16px; margin-bottom: 20px;
  border: 1px solid var(--border); border-radius: 8px; background: var(--surface);
}
.connections-broker-manager-intro { flex: 1 1 180px; min-width: 0; }
.connections-broker-manager-intro h2 { margin: 0 0 4px; font-size: 14px; font-weight: 600; }
.connections-broker-manager-intro p { margin: 0; font-size: 12px; color: var(--fg-muted); line-height: 1.5; }
.connections-broker-manager > .rx-btn { min-height: 44px; white-space: normal; }
.connections-broker-manager > div:last-child { width: 100%; min-width: 0; }
.connections-managed-oauth {
  display: grid; gap: 16px; box-sizing: border-box; min-width: 0; max-width: 720px;
  margin: 16px 0; padding: 20px; border: 1px solid var(--border); border-radius: 8px;
  background: var(--surface); font-size: 13px; line-height: 1.5; color: var(--fg);
  overflow-wrap: anywhere;
}
.connections-broker-manager .connections-managed-oauth { margin: 0; padding: 4px 0 0; border: 0; border-radius: 0; }
.connections-managed-oauth p { margin: 0; }
.connections-managed-oauth h3 { margin: 0 0 4px; font-size: 16px; font-weight: 600; color: var(--fg-strong); }
.connections-managed-oauth h4 { margin: 0; font-size: 14px; font-weight: 600; color: var(--fg-strong); }
.connections-managed-oauth .managed-oauth-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.connections-managed-oauth .managed-oauth-heading p,
.connections-managed-oauth .managed-oauth-note,
.connections-managed-oauth small { color: var(--fg-muted); font-size: 12px; line-height: 1.5; }
.connections-managed-oauth .managed-oauth-badge { display: inline-block; flex-shrink: 0; width: fit-content; padding: 3px 8px; border: 1px solid var(--border); border-radius: 5px; font-size: 11px; font-weight: 600; }
.connections-managed-oauth .managed-oauth-trust { padding: 10px 12px; background: var(--surface-sunk); border-radius: 6px; font-size: 12px; }
.connections-managed-oauth .managed-oauth-section { display: grid; gap: 12px; min-width: 0; }
.connections-managed-oauth .managed-oauth-section + .managed-oauth-section { border-top: 1px solid var(--border); padding-top: 16px; }
.connections-managed-oauth .managed-oauth-profile { display: grid; gap: 6px; }
.connections-managed-oauth code { white-space: normal; overflow-wrap: anywhere; font-size: 12px; }
.connections-managed-oauth .managed-oauth-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-width: 0; }
.connections-managed-oauth button { min-height: 44px; max-width: 100%; white-space: normal; justify-self: start; cursor: pointer; }
.connections-managed-oauth button:disabled { cursor: default; }
.connections-managed-oauth .managed-oauth-field { display: grid; gap: 6px; min-width: 0; }
.connections-managed-oauth .managed-oauth-field > :is(span, label) { font-weight: 500; }
.connections-managed-oauth input,
.connections-managed-oauth select { box-sizing: border-box; width: 100%; min-width: 0; max-width: 100%; min-height: 44px; padding: 9px 10px; border: 1px solid var(--border-strong); border-radius: 6px; background: var(--bg); color: var(--fg); font: inherit; }
.connections-managed-oauth select {
  appearance: none; overflow: hidden; text-overflow: ellipsis; padding-right: 32px;
  background-image: linear-gradient(45deg, transparent 50%, var(--fg-muted) 50%), linear-gradient(135deg, var(--fg-muted) 50%, transparent 50%);
  background-position: calc(100% - 16px) 50%, calc(100% - 12px) 50%;
  background-size: 4px 4px; background-repeat: no-repeat;
}
.connections-managed-oauth input::placeholder { color: var(--fg-muted); }
.connections-managed-oauth input[readonly] { background: var(--surface-sunk); }
.connections-managed-oauth input[aria-invalid="true"] { border-color: var(--danger); }
.connections-managed-oauth .managed-oauth-field-error { color: var(--danger); }
.connections-managed-oauth :is(input, select, button, summary):focus-visible,
.connections-broker-manager > button:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
.connections-managed-oauth .managed-oauth-editor { display: grid; gap: 16px; min-width: 0; margin: 0; padding: 16px; border: 1px solid var(--border); border-radius: 6px; }
.connections-managed-oauth legend { padding: 0 6px; font-size: 14px; font-weight: 600; }
.connections-managed-oauth .managed-oauth-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.connections-managed-oauth .managed-oauth-key { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: start; gap: 8px; }
.connections-managed-oauth .managed-oauth-key > button { margin-top: 25px; }
.connections-managed-oauth .managed-oauth-details { min-width: 0; }
.connections-managed-oauth summary { min-height: 44px; box-sizing: border-box; padding: 10px 0; color: var(--fg-muted); cursor: pointer; }
.connections-managed-oauth .managed-oauth-details > div { display: grid; gap: 10px; padding: 4px 0 8px; }
.connections-managed-oauth .managed-oauth-empty { display: grid; gap: 6px; padding: 16px; border: 1px dashed var(--border-strong); border-radius: 6px; }
.connections-managed-oauth .managed-oauth-empty strong { font-size: 14px; }
.connections-managed-oauth .managed-oauth-danger { display: grid; gap: 12px; padding: 12px; border: 1px solid var(--danger); border-radius: 6px; background: var(--danger-weak); }
.connections-managed-oauth .managed-oauth-feedback { padding: 12px; border-left: 3px solid var(--accent); border-radius: 4px; background: var(--accent-weak); }
.connections-managed-oauth .managed-oauth-feedback-error { border-color: var(--danger); background: var(--danger-weak); }
.connections-managed-oauth .managed-oauth-footer { border-top: 1px solid var(--border); padding-top: 12px; }
.connections-managed-oauth .managed-oauth-preview { display: grid; gap: 10px; min-width: 0; padding: 14px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface-sunk); }
.connections-managed-oauth .managed-oauth-preview h5 { margin: 0; font-size: 13px; }
.connections-managed-oauth .managed-oauth-preview ul { margin: 0; padding-left: 20px; min-width: 0; }
.connections-managed-oauth .managed-oauth-preview code { overflow-wrap: anywhere; }
.connections-managed-oauth .managed-oauth-account-usage { display: grid; gap: 10px; min-width: 0; padding: 14px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface-sunk); }
.connections-managed-oauth .managed-oauth-account-usage :is(h5, p) { margin: 0; }
.connections-managed-oauth .managed-oauth-account-connections { display: grid; gap: 12px; list-style: none; padding: 0; margin: 0; }
.connections-managed-oauth .managed-oauth-account-connection { display: grid; gap: 8px; min-width: 0; padding-top: 12px; border-top: 1px solid var(--border); }
.connections-managed-oauth .managed-oauth-account-connection code { overflow-wrap: anywhere; }
.connections-managed-oauth .managed-oauth-account-connection dl { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 8px; margin: 0; }
.connections-managed-oauth .managed-oauth-account-connection dt { color: var(--fg-muted); }
.connections-managed-oauth .managed-oauth-account-connection dd { margin: 0; }
.connections-managed-oauth [data-managed-health="auth_failed"], .connections-managed-oauth [data-managed-health="unreachable"] { color: var(--danger); }
/* Inside a connection's editor: broker and integration side by side, then the
   authorization with a short permission summary. */
.connections-managed-oauth.managed-oauth-in-editor { gap: 14px; padding: 16px; }
.managed-oauth-in-editor .managed-oauth-identity { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 16px; align-items: start; }
.managed-oauth-in-editor .managed-oauth-identity > fieldset { grid-column: 1 / -1; }
.managed-oauth-in-editor .managed-oauth-choice { display: grid; gap: 8px; min-width: 0; align-content: start; }
.connections-managed-oauth .managed-oauth-profile-line { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; }
.connections-managed-oauth .managed-oauth-account-line { color: var(--fg); }
.connections-managed-oauth .managed-oauth-preview-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; }
.connections-managed-oauth .managed-oauth-preview-head button { min-height: 32px; }
.connections-managed-oauth .managed-oauth-decision strong {
  display: inline-block; padding: 3px 10px; border-radius: 999px;
  background: var(--accent-weak); color: var(--accent); font-size: 12px;
}
.connections-managed-oauth .managed-oauth-decision[data-managed-decision="blocked"] strong { background: var(--danger-weak); color: var(--danger); }
.connections-managed-oauth .managed-oauth-scopes { display: grid; gap: 6px; min-width: 0; }
.connections-managed-oauth ul.managed-oauth-scope-list { display: flex; flex-wrap: wrap; gap: 6px; margin: 0; padding: 0; list-style: none; }
.connections-managed-oauth ul.managed-oauth-scope-list code {
  display: inline-block; max-width: 100%; padding: 2px 8px; border: 1px solid var(--border); border-radius: 999px;
  background: var(--surface); font-size: 11.5px;
}
@media (max-width: 640px) {
  .managed-oauth-in-editor .managed-oauth-identity { grid-template-columns: minmax(0, 1fr); }
}
@media (max-width: 560px) {
  .connections-managed-oauth { padding: 14px; }
  .connections-managed-oauth .managed-oauth-editor { padding: 12px; }
  .connections-managed-oauth .managed-oauth-grid,
  .connections-managed-oauth .managed-oauth-key { grid-template-columns: minmax(0, 1fr); }
  .connections-managed-oauth .managed-oauth-key > button { margin-top: 0; }
}
.connections-picker-title {
  font-size: 14px;
  font-weight: 600;
  margin: 0 0 12px;
}
.connections-form-title {
  margin: 0 0 4px;
  color: var(--fg-strong, var(--fg));
  font-size: 16px;
  line-height: 1.3;
  font-weight: 650;
  overflow-wrap: anywhere;
}
.connections-form-description {
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--fg-muted);
  margin: 0 0 14px;
}
.connections-form-group-title {
  margin: 6px 0 0;
  padding-top: 14px;
  border-top: 1px solid var(--border);
  color: var(--fg-muted);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.connections-form-group-title:first-child { margin-top: 0; padding-top: 0; border-top: 0; }
.connections-form .connections-managed-oauth { max-width: none; margin: 0 0 12px; }
.connections-dialog-footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px 16px;
  margin-top: 16px;
  padding-top: 14px;
  border-top: 1px solid var(--border);
}
.connections-dialog-footer .connections-form-draft-protection { flex: 1 1 260px; max-width: 60ch; margin: 0; }
.connections-dialog-footer .connections-dialog-actions { flex: 0 1 auto; flex-wrap: wrap; margin-top: 0; }
.connections-form-description code { overflow-wrap: anywhere; }
/* A locked field reads as locked, not as a box to type in. (0,5,0) beats the
   webclient shell's input rule, input:not(...) four times over at (0,4,1). */
.connections-form .connections-field-row .rx-input[readonly][data-conn-field] { background: var(--surface-sunk); color: var(--fg-muted); }
/* A new API connection's sign-in method: three cards, then every other way. */
.connections-field-row.connections-auth-method { gap: 8px; }
.connections-auth-method-title { font-size: 12px; font-weight: 500; }
.connections-auth-method-cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 200px), 1fr));
  gap: 8px;
}
.connections-form .connections-auth-method-card {
  display: grid;
  gap: 3px;
  align-content: start;
  min-width: 0;
  margin: 0;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  color: var(--fg);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.connections-auth-method-card strong { font-size: 13px; font-weight: 650; }
.connections-auth-method-card span { color: var(--fg-muted); font-size: 12px; line-height: 1.4; }
.connections-form .connections-auth-method-card:hover { background: var(--surface-sunk); }
.connections-auth-method-card:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.connections-form .connections-auth-method-card[aria-pressed="true"] {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 8%, var(--surface));
  box-shadow: inset 0 0 0 1px var(--accent);
}
.connections-auth-method-card:disabled { opacity: 0.6; cursor: not-allowed; }
.connections-auth-method-other { display: grid; gap: 4px; font-size: 12px; font-weight: 500; }
.connections-auth-method-other > span { color: var(--fg-muted); }
.connections-switch-current { margin: 0 0 12px; font-size: 13px; }
.connections-switch-pinned { margin-top: 16px; }
.connections-switch-pinned > .connections-form-fields { margin-bottom: 0; }
/* Saved OAuth apps: the links sit by the title, and the picker and its button
   share a row instead of stacking full width. */
.connections-saved-apps { align-items: stretch; }
.connections-saved-apps .rx-btn { align-self: flex-start; }
.connections-saved-apps-head { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 4px 12px; }
.connections-saved-apps-head h4 { margin: 0; color: var(--fg-strong, var(--fg)); font-size: 13.5px; font-weight: 650; }
.connections-saved-apps-links { display: flex; flex-wrap: wrap; gap: 4px 12px; }
.connections-saved-apps-pick { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 8px; min-width: 0; }
.connections-saved-apps-pick > label { display: grid; flex: 1 1 260px; gap: 4px; min-width: 0; font-size: 12px; font-weight: 500; }
.connections-saved-apps-pick select { width: 100%; min-width: 0; }
.connections-saved-apps-pick > .rx-btn { align-self: flex-end; }
.connections-saved-apps-note { color: var(--fg-muted); font-size: 12px; }
.connections-switch-step {
  display: grid;
  gap: 10px;
  min-width: 0;
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid var(--border);
}
.connections-switch-step[tabindex="-1"]:focus {
  outline: 2px solid var(--accent);
  outline-offset: 4px;
  border-radius: 3px;
}
.connections-switch-step-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  color: var(--fg-strong, var(--fg));
  font-size: 14px;
  font-weight: 650;
  line-height: 1.3;
}
.connections-switch-step-number {
  display: inline-grid;
  place-items: center;
  flex: none;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: var(--accent);
  color: var(--on-accent);
  font-size: 12px;
  font-weight: 700;
}
.connections-switch-step-help,
.connections-switch-check-note {
  margin: 0;
  color: var(--fg-muted);
  font-size: 12.5px;
  line-height: 1.5;
}
.connections-switch-step-body { display: grid; gap: 12px; min-width: 0; }
.connections-switch-step-body > .connections-form-fields,
.connections-switch-step-body > .connections-oauth { margin-bottom: 0; }
.connections-switch-step-body > .connections-managed-oauth { margin: 0; }
.connections-switch-review { display: grid; justify-items: start; gap: 10px; min-width: 0; }
.connections-switch-review > [data-direct-oauth-impact] { justify-self: stretch; min-width: 0; }
.connections-switch-review > [data-direct-oauth-impact]:empty { display: none; }
/* The review result reads as the broker panel shows the same preview: one
   card at the panel's type sizes, not body text. */
.connections-switch-review > [data-direct-oauth-impact] {
  display: grid;
  gap: 10px;
  padding: 14px 16px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface);
  color: var(--fg);
  font-size: 13px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.connections-switch-review .managed-oauth-impact { display: grid; gap: 10px; min-width: 0; }
.connections-switch-review .managed-oauth-impact :is(p, h4, h5) { margin: 0; }
.connections-switch-review .managed-oauth-impact h4 { color: var(--fg-strong, var(--fg)); font-size: 13.5px; font-weight: 650; }
.connections-switch-review .managed-oauth-impact h5 { color: var(--fg-strong, var(--fg)); font-size: 12.5px; font-weight: 650; }
.connections-switch-review .managed-oauth-impact ul { margin: 0; padding-left: 18px; }
.connections-switch-review .managed-oauth-impact li + li { margin-top: 8px; }
.connections-switch-review .managed-oauth-account-card { display: grid; gap: 2px; background: var(--surface-sunk); }
.connections-switch-review .managed-oauth-account-card p { margin: 0; }
.connections-switch-review .managed-oauth-account-card h5 { margin-bottom: 4px; }
.connections-switch-review .connections-switch-review-permissions { margin: 0; color: var(--fg-muted); font-size: 12.5px; }
/* Help that is not a step of the form: the setup guide, OAuth troubleshooting. */
.connections-form-help { display: grid; gap: 10px; margin-top: 16px; }
.connections-form-help .connections-setup-guide { margin-bottom: 0; }
.connections-form-help > div:empty { display: none; }
/* In a switch or an edit, what still holds the main button back sits right
   above it. (0,3,0): the ready state's own margin rule comes later. */
.connections-form .connections-form-status > .connections-form-validation { margin: 16px 0 0; }
/* A form-level note, such as what Save then checks, keeps clear of the fields under it. */
.connections-form > .rx-field-hint { margin: 0 0 14px; }
@media (min-width: 640px) {
  .connections-switch-step-help,
  .connections-switch-step-body { padding-left: 30px; }
}
.connections-form-draft-protection {
  font-size: 12px;
  line-height: 1.45;
  color: var(--fg-muted);
  margin: -4px 0 12px;
}
.connections-onboarding-selector {
  margin: 0 0 10px;
  padding: 11px 12px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--surface-sunk, var(--bg));
}
.connections-onboarding-selector .connections-field-row { gap: 6px; }
.connections-onboarding {
  display: grid;
  gap: 10px;
  margin: 0 0 12px;
  padding: 13px 14px;
  border: 1px solid var(--border);
  border-left: 3px solid var(--accent);
  border-radius: 8px;
  background: var(--bg);
}
.connections-onboarding[data-tone="advanced"] {
  border-left-color: var(--warn, #c98500);
}
.connections-onboarding-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 14px;
}
.connections-onboarding-heading > div {
  display: grid;
  gap: 3px;
  min-width: 0;
}
.connections-onboarding-badge {
  margin: 0;
  color: var(--accent);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.connections-onboarding[data-tone="advanced"] .connections-onboarding-badge {
  color: var(--warn, #8a5a00);
}
.connections-onboarding h4 {
  margin: 0;
  color: var(--fg);
  font-size: 13px;
  font-weight: 650;
}
.connections-onboarding-portal {
  flex: 0 0 auto;
  color: var(--accent);
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
}
.connections-onboarding-description,
.connections-onboarding-note,
.connections-onboarding-verification {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
}
.connections-onboarding-description { color: var(--fg-muted); }
.connections-onboarding-steps {
  display: grid;
  gap: 0;
  margin: 0;
  padding: 0;
  list-style: none;
  counter-reset: messenger-onboarding;
}
.connections-onboarding-steps > li {
  position: relative;
  display: grid;
  gap: 2px;
  min-height: 28px;
  padding: 8px 0 8px 36px;
  border-top: 1px solid var(--border);
  counter-increment: messenger-onboarding;
}
.connections-onboarding-steps > li::before {
  content: counter(messenger-onboarding);
  position: absolute;
  top: 8px;
  left: 3px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: var(--surface-sunk, var(--bg));
  color: var(--fg);
  font-size: 10px;
  font-weight: 700;
}
.connections-onboarding-steps strong {
  color: var(--fg);
  font-size: 12px;
  font-weight: 650;
}
.connections-onboarding-steps span {
  color: var(--fg-muted);
  font-size: 11px;
  line-height: 1.45;
}
.connections-onboarding-note,
.connections-onboarding-verification {
  padding: 9px 10px;
  border-radius: 5px;
}
.connections-onboarding-note {
  border-left: 3px solid var(--warn, #c98500);
  background: var(--surface-sunk, var(--bg));
  color: var(--fg-muted);
}
.connections-onboarding-verification {
  border-left: 3px solid var(--accent);
  background: var(--surface-sunk, var(--bg));
  color: var(--fg-muted);
}
.connections-onboarding-note strong,
.connections-onboarding-verification strong { color: var(--fg); }
.connections-form-validation {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 3px 12px;
  align-items: center;
  margin: 12px 0;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-left: 3px solid var(--warn, #c98500);
  border-radius: 5px;
  background: var(--surface-sunk, var(--bg));
  font-size: 12px;
  line-height: 1.45;
}
.connections-form-validation[data-status="ready"] {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 2px 8px;
  margin: 0 0 12px;
  padding: 0;
  border: 0;
  background: none;
}
.connections-form-validation[data-status="ready"] strong::before {
  content: '✓';
  margin-right: 6px;
  color: var(--accent);
}
.connections-form-validation strong { color: var(--fg); }
.connections-form-validation > span {
  min-width: 0;
  color: var(--fg-muted);
}
.connections-form-validation-action {
  grid-column: 2;
  grid-row: 1 / span 2;
}
.connections-form-validation-action[hidden] { display: none; }
.connections-form-validation-action .rx-btn { min-height: 44px; }
.connections-credential-correction {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 3px 12px;
  align-items: center;
  margin: 12px 0;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-left: 3px solid var(--danger, #b42318);
  border-radius: 5px;
  background: var(--surface-sunk, var(--bg));
  font-size: 12px;
  line-height: 1.45;
}
.connections-credential-correction strong { color: var(--fg); }
.connections-credential-correction[data-credential-safe-stop="true"] {
  border-left-color: var(--warn, #c98500);
  background: color-mix(in srgb, var(--warn, #c98500) 7%, var(--bg));
}
.connections-credential-correction > span {
  min-width: 0;
  color: var(--fg-muted);
}
.connections-credential-correction-action {
  grid-column: 2;
  grid-row: 1 / span 4;
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 6px;
}
.connections-credential-correction-action .rx-btn { min-height: 44px; }
.connections-credential-closure-status {
  grid-column: 1 / -1;
  margin: 5px 0 0;
  color: var(--fg-muted);
}
.connections-credential-admin-handoff {
  grid-column: 1 / -1;
  margin-top: 7px;
  border-top: 1px solid var(--border);
  padding-top: 5px;
}
.connections-credential-admin-handoff > summary {
  display: flex;
  align-items: center;
  min-height: 44px;
  color: var(--fg);
  font-weight: 600;
  cursor: pointer;
}
.connections-credential-admin-handoff-body {
  display: grid;
  gap: 8px;
  padding: 2px 0 5px;
}
.connections-credential-admin-handoff-body > p { margin: 0; color: var(--fg-muted); }
.connections-credential-admin-handoff pre {
  max-width: 100%;
  margin: 0;
  padding: 9px 10px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--bg);
  color: var(--fg);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  user-select: text;
}
.connections-credential-admin-handoff .rx-btn { min-height: 44px; justify-self: start; }
.connections-credential-admin-handoff [data-credential-admin-handoff-status] {
  min-height: 1.45em;
}
.connections-field-row[data-credential-rejected="true"] .rx-input,
.connections-field-row[data-credential-rejected="true"] .rx-select {
  border-color: var(--danger, #b42318);
}
.connections-header-list[data-credential-rejected="true"] {
  border-left: 3px solid var(--danger, #b42318);
  padding-left: 9px;
}
@media (max-width: 560px) {
  .connections-onboarding-heading {
    align-items: stretch;
    flex-direction: column;
  }
  .connections-onboarding-portal { white-space: normal; }
  .connections-form-validation,
  .connections-credential-correction {
    grid-template-columns: minmax(0, 1fr);
  }
  .connections-form-validation-action,
  .connections-credential-correction-action {
    grid-column: 1;
    grid-row: auto;
    margin-top: 5px;
  }
  .connections-form-validation-action,
  .connections-form-validation-action .rx-btn,
  .connections-credential-correction-action,
  .connections-credential-correction-action .rx-btn {
    width: 100%;
  }
}
.connections-credential-rotation {
  display: grid;
  gap: 3px;
  margin: 12px 0;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-left: 3px solid var(--accent);
  border-radius: 5px;
  background: var(--surface-sunk, var(--bg));
  font-size: 12px;
  line-height: 1.45;
}
.connections-credential-rotation[data-credential-rotation="replacement"] {
  background: color-mix(in srgb, var(--accent) 6%, var(--bg));
}
.connections-form-fields > .connections-credential-rotation { margin: 0; }
.connections-credential-rotation strong { color: var(--fg); }
.connections-credential-rotation span { color: var(--fg-muted); }
.connections-credential-rotation[data-credential-safe-stop-closure] .rx-btn {
  min-height: 44px;
  justify-self: start;
  margin-top: 5px;
}
.connections-post-safe-stop .rx-btn {
  min-height: 44px;
  justify-self: start;
  margin-top: 5px;
}
.connections-post-safe-stop-profile {
  color: var(--fg, #202020) !important;
  font-size: 11px;
  font-weight: 600;
}
.connections-post-safe-stop-profile-handoff {
  border-left-color: var(--warn, #c98500);
  background: color-mix(in srgb, var(--warn, #c98500) 7%, var(--bg));
}
.connections-post-safe-stop-profile-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 5px;
}
.connections-post-safe-stop-profile-actions .rx-btn { min-height: 44px; }
.connections-post-safe-stop[data-post-safe-stop-verification="resolved"] {
  border-left-color: var(--ok, #067647);
  background: color-mix(in srgb, var(--ok, #067647) 6%, var(--bg));
}
.connections-post-safe-stop[data-post-safe-stop-verification="reopen"] {
  border-left-color: var(--warn, #c98500);
  background: color-mix(in srgb, var(--warn, #c98500) 7%, var(--bg));
}
@media (max-width: 560px) {
  .connections-credential-rotation[data-credential-safe-stop-closure] .rx-btn,
  .connections-post-safe-stop .rx-btn,
  .connections-post-safe-stop-profile-actions,
  .connections-post-safe-stop-profile-actions .rx-btn {
    width: 100%;
  }
}
.connections-external-change {
  display: grid;
  gap: 5px;
  margin: 12px 0;
  padding: 11px 12px;
  border: 1px solid var(--warn, #c98500);
  border-left-width: 4px;
  border-radius: 6px;
  background: color-mix(in srgb, var(--warn, #c98500) 8%, var(--bg));
  font-size: 12px;
  line-height: 1.5;
}
.connections-external-change strong { color: var(--fg); }
.connections-external-change span { color: var(--fg-muted); }
.connections-external-change[data-connection-rotation-owner="available"] {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 6%, var(--bg));
}
.connections-external-change-error {
  color: var(--danger, #b42318) !important;
  font-weight: 600;
}
.connections-external-change-action {
  display: flex;
  justify-content: flex-end;
  margin-top: 3px;
}
.connections-external-change-action .rx-btn { min-height: 44px; }
@media (max-width: 560px) {
  .connections-external-change-action,
  .connections-external-change-action .rx-btn {
    width: 100%;
  }
}
.connections-credential-receipt { margin-bottom: 12px; }
.connections-picker-grid {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 12px;
}
.connections-picker-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 12px;
}
.connections-picker-section-title {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  color: var(--fg-muted);
  margin: 0;
}
.connections-picker-section-hint {
  font-size: 12px;
  color: var(--fg-muted);
  margin: 0 0 4px;
}
.connections-picker-card {
  text-align: left;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  cursor: pointer;
  font-family: inherit;
  color: var(--fg);
}
.connections-picker-card:hover { background: var(--surface-sunk); }
.connections-picker-card--vendor {
  border-color: var(--accent, var(--border));
}
.connections-picker-card-desc {
  font-size: 12px;
  color: var(--fg-muted);
}
.connections-oauth {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface-sunk);
  margin-bottom: 12px;
  font-size: 13px;
  line-height: 1.5;
}
.connections-oauth > h4 { margin: 0; color: var(--fg-strong, var(--fg)); font-size: 13.5px; font-weight: 650; }
.connections-oauth > p { margin: 0; }
.connections-oauth > label { display: grid; gap: 4px; font-size: 12px; font-weight: 500; }
.connections-oauth[data-oauth-state="ready"],
.connections-oauth[data-oauth-state="authorized"] {
  border-color: color-mix(in srgb, var(--success) 42%, var(--border));
  background: color-mix(in srgb, var(--success) 6%, var(--bg));
}
.connections-oauth-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.connections-oauth-heading > div {
  display: grid;
  gap: 2px;
}
.connections-oauth-eyebrow {
  margin: 0;
  color: var(--fg-muted);
  font-size: 10px;
  font-weight: 650;
  letter-spacing: .06em;
  text-transform: uppercase;
}
.connections-oauth-heading h4 {
  margin: 0;
  font-size: 14px;
}
.connections-oauth-private {
  flex: 0 0 auto;
  padding: 3px 7px;
  border: 1px solid var(--border);
  border-radius: 999px;
  color: var(--fg-muted);
  background: var(--bg);
  font-size: 10px;
  font-weight: 600;
}
.connections-oauth-privacy,
.connections-oauth-scope-count {
  margin: 0;
  color: var(--fg-muted);
  font-size: 11px;
  line-height: 1.45;
}
.connections-oauth-readiness {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.connections-oauth-readiness li {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 6px;
  min-width: 0;
  padding: 7px 8px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--bg);
  font-size: 11px;
}
.connections-oauth-readiness li > span:first-child {
  color: var(--fg-muted);
  font-weight: 700;
}
.connections-oauth-readiness li[data-status="complete"] > span:first-child {
  color: var(--success);
}
.connections-oauth-readiness small {
  color: var(--fg-muted);
  font-size: 10px;
}
.connections-oauth-callback {
  display: grid;
  gap: 6px;
  padding: 9px;
  border-left: 3px solid var(--accent);
  background: var(--bg);
}
.connections-oauth-callback > div:first-child {
  display: grid;
  gap: 1px;
  font-size: 11px;
}
.connections-oauth-callback > div:first-child span {
  color: var(--fg-muted);
}
.connections-oauth-callback-value {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.connections-oauth-callback-value code {
  min-width: 0;
  overflow-wrap: anywhere;
  color: var(--fg);
  font-size: 10px;
}
/* A long URL or scope list wraps; its Copy button keeps its width. */
.connections-oauth-callback-value .rx-btn,
.connections-oauth-scopes-value .rx-btn { flex: none; }
/* The caveats under the URL read at the block's own size, not as body text. */
.connections-oauth-callback-switch,
.connections-oauth-callback-alt {
  margin: 0;
  font-size: 11.5px;
  line-height: 1.45;
}
.connections-oauth-callback-alt { color: var(--fg-muted); }
.connections-oauth-callback-switch code,
.connections-oauth-callback-alt code { font-size: 10.5px; overflow-wrap: anywhere; }
/* Mirrors .connections-oauth-callback deliberately: they are the same KIND of
   instruction ("go configure this at your provider, then come back"), and a reader who
   has learned to act on the accent-barred block should not have to learn a second
   visual language for the other half of the same setup.
   NOTE: no backticks anywhere in this block — the stylesheet is a template literal, and
   a backtick here terminates it (which is exactly how this comment broke the build). */
.connections-oauth-scopes-required {
  display: grid;
  gap: 6px;
  padding: 9px;
  border-left: 3px solid var(--accent);
  background: var(--bg);
}
.connections-oauth-scopes-required > div:first-child {
  display: grid;
  gap: 1px;
  font-size: 11px;
}
.connections-oauth-scopes-required > div:first-child span {
  color: var(--fg-muted);
}
.connections-oauth-scopes-value {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.connections-oauth-scopes-value code {
  min-width: 0;
  overflow-wrap: anywhere;
  color: var(--fg);
  font-size: 10px;
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
}
.connections-oauth-error {
  margin: 0;
}
.connections-oauth-scopes {
  font-size: 11px;
  color: var(--fg-muted);
  margin: 0;
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  word-break: break-all;
}
.connections-consent {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  margin-bottom: 12px;
}
.connections-consent-title {
  font-size: 12px;
  font-weight: 600;
  margin: 0;
}
.connections-consent-note {
  font-size: 12px;
  color: var(--fg-muted);
  margin: 0;
}
.connections-consent-scopes {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 0;
  margin: 0;
  list-style: none;
}
.connections-consent-scopes code {
  display: inline-block;
  padding: 2px 6px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--surface-sunk);
  font-size: 11px;
}
.connections-vendor-state {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-top: 8px;
  border-top: 1px solid var(--border);
  font-size: 12px;
}
.connections-vendor-state strong {
  font-weight: 600;
}
.connections-vendor-state span {
  color: var(--fg-muted);
}
.connections-setup-guide {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px;
  margin-bottom: 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-sunk);
}
.connections-setup-guide:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.connections-setup-guide--closed {
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
}
.connections-setup-guide-copy,
.connections-setup-guide-heading > div {
  min-width: 0;
}
.connections-setup-guide-title {
  margin: 0;
  font-size: 13px;
  font-weight: 650;
  color: var(--fg);
}
.connections-setup-guide p {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--fg-muted);
}
.connections-setup-guide-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.connections-setup-guide-heading > div {
  display: grid;
  gap: 3px;
}
.connections-setup-guide-url-label {
  font-size: 12px;
  font-weight: 600;
}
.connections-setup-guide-privacy,
.connections-setup-guide-context-note,
.connections-setup-guide-disclaimer {
  max-width: 72ch;
}
.connections-setup-guide-actions {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.connections-setup-guide-shared {
  display: grid;
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
}
.connections-setup-guide-shared h5,
.connections-setup-guide-section h5,
.connections-setup-guide-cautions h5,
.connections-setup-guide-handoff h5 {
  margin: 0;
  font-size: 12px;
  font-weight: 650;
}
.connections-setup-guide-shared dl {
  display: grid;
  gap: 8px;
  margin: 0;
}
.connections-setup-guide-shared dl > div {
  display: grid;
  grid-template-columns: minmax(92px, auto) minmax(0, 1fr);
  gap: 10px;
  align-items: baseline;
}
.connections-setup-guide-shared dt {
  font-size: 11px;
  color: var(--fg-muted);
}
.connections-setup-guide-shared dd {
  min-width: 0;
  margin: 0;
  font-size: 12px;
  overflow-wrap: anywhere;
}
.connections-setup-guide-shared summary {
  cursor: pointer;
  font-size: 12px;
  color: var(--fg);
}
.connections-setup-guide-shared ul {
  display: grid;
  gap: 4px;
  margin: 8px 0 0;
  padding-left: 18px;
}
.connections-setup-guide-shared li {
  font-size: 11px;
}
.connections-setup-guide-shared li code {
  margin-left: 5px;
  color: var(--fg-muted);
}
.connections-setup-guide-not-shared {
  padding: 9px 10px;
  border-left: 3px solid var(--ok, var(--accent));
  background: var(--surface-sunk);
  color: var(--fg) !important;
}
.connections-setup-guide-progress {
  padding-left: 20px;
  position: relative;
}
.connections-setup-guide-progress::before {
  content: '';
  position: absolute;
  left: 0;
  top: 3px;
  width: 10px;
  height: 10px;
  border: 2px solid var(--border-strong, var(--border));
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: connections-guide-spin 800ms linear infinite;
}
@keyframes connections-guide-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .connections-setup-guide-progress::before { animation: none; }
}
.connections-setup-guide-eyebrow {
  color: var(--accent) !important;
  font-size: 10px !important;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.connections-setup-guide-overview {
  color: var(--fg) !important;
}
.connections-setup-guide-resume {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding: 12px;
  border: 1px solid color-mix(in srgb, var(--accent) 42%, var(--border));
  border-radius: 7px;
  background: color-mix(in srgb, var(--accent) 7%, var(--bg));
}
.connections-setup-guide-resume > div {
  display: grid;
  gap: 3px;
  min-width: 0;
}
.connections-setup-guide-resume strong {
  font-size: 12px;
  color: var(--fg);
}
.connections-setup-guide-resume .rx-btn {
  flex: 0 0 auto;
}
.connections-setup-guide-open {
  align-self: flex-start;
  font-size: 12px;
  font-weight: 600;
  color: var(--accent);
}
.connections-setup-guide-handoff {
  display: grid;
  gap: 10px;
  padding: 12px;
  border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--border));
  border-radius: 7px;
  background: var(--bg);
}
.connections-setup-guide-handoff > div {
  display: grid;
  gap: 4px;
}
.connections-setup-guide-handoff-steps {
  display: grid;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
  counter-reset: provider-handoff;
}
.connections-setup-guide-handoff-steps > li {
  position: relative;
  display: grid;
  gap: 6px;
  padding: 10px 10px 10px 38px;
  border-top: 1px solid var(--border);
  counter-increment: provider-handoff;
}
.connections-setup-guide-handoff-steps > li::before {
  content: counter(provider-handoff);
  position: absolute;
  top: 9px;
  left: 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: var(--surface-sunk);
  color: var(--fg);
  font-size: 10px;
  font-weight: 700;
}
.connections-setup-guide-handoff-steps > li > strong {
  font-size: 12px;
}
.connections-setup-guide-copy-value {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.connections-setup-guide-copy-value code {
  min-width: 0;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--surface-sunk);
  font-size: 11px;
  overflow-wrap: anywhere;
}
.connections-setup-guide-scope-list {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.connections-setup-guide-scope-list code {
  display: inline-block;
  padding: 2px 5px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--surface-sunk);
  font-size: 10px;
  overflow-wrap: anywhere;
}
.connections-setup-guide-section,
.connections-setup-guide-cautions {
  display: grid;
  gap: 8px;
}
.connections-setup-guide-suggestions,
.connections-setup-guide-steps,
.connections-setup-guide-cautions ul {
  display: grid;
  gap: 8px;
  padding: 0;
  margin: 0;
  list-style: none;
}
.connections-setup-guide-suggestion,
.connections-setup-guide-steps > li {
  display: grid;
  gap: 6px;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
}
.connections-setup-guide-suggestion-heading {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  align-items: baseline;
  font-size: 12px;
}
.connections-setup-guide-suggestion-heading span {
  font-size: 10px;
  color: var(--fg-muted);
  text-transform: capitalize;
  white-space: nowrap;
}
.connections-setup-guide-suggestion-heading span[data-confidence="low"] {
  color: var(--warn, #8a5a00);
}
.connections-setup-guide-value {
  display: block;
  width: fit-content;
  max-width: 100%;
  padding: 4px 6px;
  border-radius: 4px;
  background: var(--surface-sunk);
  font-size: 11px;
  overflow-wrap: anywhere;
  white-space: normal;
}
.connections-setup-guide-suggestion-action {
  display: flex;
  align-items: center;
  justify-content: flex-end;
}
.connections-setup-guide-empty {
  font-size: 12px;
  color: var(--fg-muted);
}
.connections-setup-guide-steps {
  counter-reset: none;
}
.connections-setup-guide-steps > li > div {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}
.connections-setup-guide-step-number {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  flex: 0 0 20px;
  border-radius: 50%;
  background: var(--accent);
  color: var(--on-accent);
  font-size: 10px;
  font-weight: 700;
}
.connections-setup-guide-step-fields code {
  display: inline-block;
  margin: 2px 3px 0 0;
  padding: 1px 4px;
  border-radius: 3px;
  background: var(--surface-sunk);
  font-size: 10px;
}
.connections-setup-guide-cautions {
  padding: 10px;
  border-left: 3px solid var(--warn, #c98500);
  background: var(--bg);
}
.connections-setup-guide-cautions ul {
  gap: 5px;
  padding-left: 18px;
  list-style: disc;
}
.connections-setup-guide-cautions li {
  font-size: 11px;
  line-height: 1.45;
  color: var(--fg-muted);
}
.connections-form-fields {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-bottom: 12px;
}
.connections-field-row {
  min-width: 0;
  max-width: 100%;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.connections-field-row[tabindex="-1"]:focus {
  outline: 2px solid var(--accent);
  outline-offset: 3px;
  border-radius: 3px;
}
.connections-field-row label {
  font-size: 12px;
  font-weight: 500;
}
/* Safari can include a native select's unpainted option text in its parent's
   scroll area at narrow widths. Keep that text inside the closed control. */
.connections-field-row select { overflow: hidden; }
.connections-field-required {
  color: var(--danger);
  font-weight: 600;
}
.connections-field-json {
  resize: vertical;
  min-height: 60px;
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
}
.connections-header-rows {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.connections-header-row {
  min-width: 0;
  display: flex;
  gap: 6px;
  align-items: center;
}
.connections-header-row .connections-header-name {
  box-sizing: border-box; min-width: 0; width: 100%; flex: 1 1 40%;
}
.connections-header-row .connections-header-value {
  box-sizing: border-box; min-width: 0; width: 100%; flex: 1 1 60%;
}
.connections-header-row .connections-header-remove { flex: 0 0 auto; }
.connections-header-add { margin-top: 6px; align-self: flex-start; }
.connections-matchpattern-rows {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.connections-matchpattern-row {
  display: flex;
  gap: 6px;
  align-items: center;
  flex-wrap: wrap;
}
.connections-matchpattern-row .connections-matchpattern-kind { flex: 0 0 auto; }
.connections-matchpattern-row .connections-matchpattern-value { flex: 1 1 40%; min-width: 120px; }
.connections-matchpattern-row .connections-matchpattern-mode { flex: 0 0 auto; }
.connections-matchpattern-row .connections-matchpattern-remove { flex: 0 0 auto; margin-left: auto; }
.connections-matchpattern-add { margin-top: 6px; align-self: flex-start; }
.connections-dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 12px;
}
.connections-row-wrap {
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.connections-delete-backdrop {
  box-sizing: border-box;
  min-width: 0;
  max-width: 100%;
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: rgba(0, 0, 0, 0.45);
}
.connections-delete-confirm {
  box-sizing: border-box;
  min-width: 0;
  width: 100%;
  max-width: 380px;
  padding: 20px;
  border: 1px solid var(--border, #e5e5e5);
  border-radius: 8px;
  background: var(--bg, #fff);
  color: var(--fg);
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.24);
}
.connections-delete-title {
  min-width: 0;
  margin: 0 0 8px;
  overflow-wrap: anywhere;
  font-size: 15px;
}
.connections-delete-body {
  min-width: 0;
  margin: 0 0 12px;
  overflow-wrap: anywhere;
  font-size: 13px;
  color: var(--fg-muted);
}
.connections-delete-optin {
  min-width: 0;
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 13px;
  cursor: pointer;
}
.connections-delete-optin input { margin-top: 2px; }
.connections-delete-note {
  min-width: 0;
  margin: 6px 0 0 24px;
  overflow-wrap: anywhere;
  font-size: 12px;
  color: var(--fg-muted);
}
.connections-signin-grids:empty { display: none; }
.sg-section { min-width: 0; margin: 4px 0 12px; font-size: 13px; }
.sg-heading { margin: 0 0 2px; font-size: 14px; }
.sg-note { min-width: 0; margin: 4px 0; font-size: 12px; color: var(--fg-muted); overflow-wrap: anywhere; }
.sg-error { min-width: 0; margin: 4px 0; font-size: 12px; color: var(--danger, #b42318); overflow-wrap: anywhere; }
.sg-grid { min-width: 0; margin: 10px 0; }
.sg-title { margin: 0 0 4px; font-size: 13px; font-weight: 600; overflow-wrap: anywhere; }
.sg-scroll { max-width: 100%; overflow-x: auto; }
.sg-table { border-collapse: collapse; font-size: 13px; }
.sg-table th, .sg-table td { padding: 4px 8px; text-align: center; border-bottom: 1px solid var(--border, #e5e5e5); }
.sg-table .sg-pack, .sg-table .sg-corner { text-align: left; font-weight: 500; min-width: 140px; }
.sg-table .sg-corner { font-size: 12px; color: var(--fg-muted); }
.sg-table button { white-space: nowrap; }
.sg-connection { font-size: 12px; font-weight: 600; white-space: nowrap; }
.sg-cell input { margin: 0 3px; }
.sg-cannot { color: var(--fg-muted); }
.sg-members summary { cursor: pointer; font-size: 12px; color: var(--fg-muted); }
.sg-members-list { margin: 2px 0 0; padding-left: 16px; font-size: 12px; text-align: left; }
.sg-confirm { min-width: 0; margin: 6px 0 0; padding: 8px; border: 1px solid var(--border, #e5e5e5); border-radius: 6px; }
.sg-confirm-question { margin: 0 0 4px; font-size: 13px; font-weight: 600; overflow-wrap: anywhere; }
.sg-confirm-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 6px; }
.connections-pack-usage-members { color: var(--fg-muted); }
.sg-offer { min-width: 0; margin: 8px 0 12px; padding: 10px; border: 1px solid var(--border, #e5e5e5); border-radius: 6px; }
.sg-offer-title { margin: 0 0 4px; font-size: 14px; font-weight: 600; overflow-wrap: anywhere; }
.sg-offer-question { margin: 6px 0 2px; font-size: 13px; overflow-wrap: anywhere; }
.sg-offer-list { margin: 0; padding-left: 0; list-style: none; }
.sg-offer-item { min-width: 0; margin: 2px 0; overflow-wrap: anywhere; }
.sg-offer-label { display: inline-flex; gap: 6px; align-items: baseline; }
.connections-delete-effects {
  min-width: 0;
  margin: 0 0 12px;
  font-size: 13px;
}
.connections-delete-effects-title {
  margin: 0 0 4px;
  font-weight: 600;
}
.connections-delete-effects-list {
  min-width: 0;
  margin: 0;
  padding-left: 18px;
  overflow-wrap: anywhere;
}
.connections-delete-effects-list li + li { margin-top: 4px; }
.connections-delete-effects-note {
  min-width: 0;
  margin: 0 0 12px;
  font-size: 13px;
  overflow-wrap: anywhere;
  color: var(--fg-muted);
}
.connections-delete-actions {
  min-width: 0;
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 16px;
}
@media (max-width: 520px) {
  .connections-header-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
  }
  .connections-header-row .connections-header-name { grid-column: 1 / -1; }
  .connections-header-row .connections-header-value { grid-column: 1; }
  .connections-header-row .connections-header-remove { grid-column: 2; }
  .connections-oauth-heading,
  .connections-oauth-callback-value,
  .connections-oauth-scopes-value {
    align-items: stretch;
    flex-direction: column;
  }
  .connections-oauth-readiness {
    grid-template-columns: 1fr;
  }
  .connections-oauth > .rx-btn,
  .connections-oauth-callback-value .rx-btn,
  .connections-oauth-scopes-value .rx-btn {
    width: 100%;
  }
  .connections-setup-guide--closed,
  .connections-setup-guide-heading {
    flex-direction: column;
    align-items: stretch;
  }
  .connections-setup-guide-resume {
    align-items: stretch;
    flex-direction: column;
  }
  .connections-setup-guide-resume .rx-btn {
    width: 100%;
  }
  .connections-setup-guide--closed .rx-btn,
  .connections-setup-guide-actions .rx-btn:not(.rx-btn-link) {
    width: 100%;
  }
  .connections-setup-guide-actions {
    align-items: stretch;
  }
  .connections-setup-guide-shared dl > div {
    grid-template-columns: 1fr;
    gap: 2px;
  }
  .connections-setup-guide-suggestion-heading {
    align-items: flex-start;
    flex-direction: column;
    gap: 2px;
  }
  .connections-setup-guide-copy-value {
    align-items: stretch;
    flex-direction: column;
  }
  .connections-setup-guide-copy-value .rx-btn,
  .connections-setup-guide-handoff-steps > li > .rx-btn,
  .connections-setup-guide-suggestion-action .rx-btn {
    width: 100%;
  }
  .connections-setup-guide-suggestion-action {
    align-items: stretch;
  }
}
${ENGAGEMENT_HEALTH_PANEL_STYLES}
`;
