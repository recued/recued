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
  vendorHasEngagement,
  OAUTH_CLOUD_CALLBACK_URL,
  MAX_HEADER_AUTH_ENTRIES,
  MESSAGE_MATCH_MAX_PATTERNS,
  validateMessageMatchPatterns,
  type BulkPackManifest,
  type ConnectionKind,
  type ConnectionVendorProvider,
  type ConnectionView,
  type ReleaseCheckStatus,
} from '@recued/contracts';
import { e } from '../template.js';
import { button } from '../primitives/button.js';
import { textInput, select as selectField, fieldHint } from '../primitives/field.js';
import { inlineError, inlineHint, inlineOk } from '../primitives/message.js';
import { emptyHint } from '../primitives/empty-hint.js';
import {
  CONNECTION_KIND_CHOICES,
  CONNECTION_SUBTYPE_CHOICES,
  CONNECTION_NAME_REGEX,
  collectHeaderRows,
  collectMatchPatternRows,
  matchPatternRowsToPatterns,
  isCompleteMatchPatternRow,
  isHalfFilledMatchPatternRow,
  resolveConnectionSchema,
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
import { packsUsingConnection } from './pack-usage.js';
import { mcpPackBadge, type McpPackBadge, type McpPackStatusView } from './mcp-pack.js';
import type { McpPackReviewState } from './state.js';
import {
  canApplyConnectionSetupGuideSuggestion,
  connectionSetupGuideReturnTarget,
} from './setup-guide.js';
import {
  connectionOAuthCredentialReadiness,
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
  /** The host can open the persistent Account/server-profile guide from an
   * unsupported safe-start receipt. Absent hosts keep the direct recheck and
   * dismiss actions, rather than rendering a dead guide button. */
  credentialRotationServerUpdateGuideAvailable?: boolean;
  /** Presentation-only label for the exact profile whose server supplied the
   * post-ack queue. Profile ids remain routing metadata and are not rendered. */
  postSafeStopProfileLabel?: string;
  /** Safe landing when a recovery URL cannot be bound to this boot. */
  postSafeStopProfileHandoff?: ConnectionsPostSafeStopProfileHandoff | null;
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
  installedManifests: readonly BulkPackManifest[],
): string => {
  if (conn.kind !== 'api') return '';
  const vendor = connectionVendor(conn);
  if (vendor === undefined) return '';
  // D-194 #6 — `bound_pack_slugs` (stamped by handleConnectionList from the grant
  // store) narrows the vendor-match to packs granted on THIS specific connection,
  // so two accounts of one vendor don't both list every vendor pack. Absent
  // (dbless / legacy) → packsUsingConnection falls back to vendor-match.
  const usage = packsUsingConnection(
    installedManifests,
    vendor,
    conn.granted_scopes,
    conn.bound_pack_slugs,
  );
  if (usage.length === 0) return '';
  const items = usage
    .map((u) => {
      const c = u.coverage;
      const status = !c.known
        ? 'scopes not verified'
        : c.covered
          ? 'covered'
          : `missing ${c.missing.join(', ')}`;
      const tone = c.known && !c.covered ? 'warn' : 'ok';
      return `<li class="connections-pack-usage-item" data-pack-usage="${e(u.pack_slug)}" data-pack-usage-tone="${tone}"><span class="connections-pack-usage-name">${e(u.pack_slug)}</span> <span class="connections-pack-usage-status">— ${e(status)}</span></li>`;
    })
    .join('');
  return `
    <div class="connections-pack-usage" data-conn-pack-usage="${e(connectionRowKey(conn.kind, conn.name))}">
      <p class="connections-pack-usage-heading">Used by packs</p>
      <ul class="connections-pack-usage-list">${items}</ul>
    </div>
  `;
};

const renderRow = (
  conn: ConnectionView,
  probeInFlight: Set<string>,
  deleteInFlight: Set<string>,
  engagementHealth: ConnectionsPageState['engagementHealth'],
  installedManifests: readonly BulkPackManifest[],
  mcpPackStatus: Readonly<Record<string, McpPackStatusView>> | undefined,
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
    : 'Engagement health';
  return `
    <div class="connections-row-wrap" data-conn-key="${e(key)}">
      <div class="connections-row" data-conn-key="${e(key)}">
        <div class="connections-row-info">
          <strong class="connections-row-name">${e(conn.name)}</strong>
          ${conn.subtype ? `<span class="connections-row-subtype">${e(conn.subtype)}</span>` : ''}
          <span class="connections-row-summary">${e(summaryFor(conn))}</span>
          <span class="connections-row-display">${e(conn.display_name)}</span>
        </div>
        <div class="connections-row-actions">
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
            label: probing ? 'Probing…' : 'Probe',
            size: 'xs',
            action: 'connections-probe',
            data: { kind: conn.kind, name: conn.name },
            disabled: probing || deleting,
          })}
          ${button({
            label: deleting ? 'Deleting…' : 'Delete',
            size: 'xs',
            variant: 'danger-text',
            action: 'connections-delete',
            data: { kind: conn.kind, name: conn.name },
            disabled: deleting,
          })}
        </div>
      </div>
      ${engagementPanel}
      ${renderPackUsage(conn, installedManifests)}
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
    case 'probe': return 'Probe now';
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

const renderKindGroup = (
  kind: ConnectionKind,
  rows: readonly ConnectionView[],
  probeInFlight: Set<string>,
  deleteInFlight: Set<string>,
  engagementHealth: ConnectionsPageState['engagementHealth'],
  installedManifests: readonly BulkPackManifest[],
  mcpPackStatus: Readonly<Record<string, McpPackStatusView>> | undefined,
): string => {
  if (rows.length === 0) return '';
  return `
    <section class="connections-group" data-kind="${e(kind)}">
      <h3 class="connections-group-title">${e(KIND_LABELS[kind])} (${rows.length})</h3>
      <div class="connections-group-rows">
        ${rows.map((r) => renderRow(r, probeInFlight, deleteInFlight, engagementHealth, installedManifests, mcpPackStatus)).join('')}
      </div>
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
      title = 'Checking the saved connection…';
      detail = `The previous recovery stop for ${identity} stays closed while the paired server checks the credential that is currently saved.`;
    } else if (resolution === 'resolved') {
      title = 'Recovery verified';
      detail = `The paired server checked the currently saved credential for ${identity}, and the provider accepted it. Recovery is complete; no credential was changed or replayed.${checked}${remainingDetail}`;
      action = continueAction;
    } else if (resolution === 'reopen') {
      const hasCredentialCorrection = p.credential_correction !== undefined;
      title = hasCredentialCorrection
        ? 'Saved credential still needs attention'
        : 'Saved connection still needs attention';
      detail = `A fresh paired-server check found that the provider still rejects the authentication currently saved for ${identity}. The acknowledged recovery stop remains closed; this is a new result with a clean correction path.${checked}`;
      action = button({
        label: hasCredentialCorrection
          ? 'Review saved credential'
          : 'Review connection',
        size: 'sm',
        variant: 'secondary',
        action: 'connections-review-post-safe-stop',
        data: { kind: p.kind, name: p.name },
        ariaLabel: hasCredentialCorrection
          ? `Review the currently saved credential for ${identity}${profileAria}`
          : `Review the current authentication settings for ${identity}${profileAria}`,
      });
    } else if (resolution === 'changed') {
      title = 'Connection changed during the check';
      detail = `Recued preserved the newer saved version of ${identity} and did not apply the older check result to it. Check the current connection before deciding what to fix.`;
      action = button({
        label: 'Check current connection',
        size: 'sm',
        variant: 'secondary',
        action: 'connections-recheck-post-safe-stop',
        data: { kind: p.kind, name: p.name },
        ariaLabel: `Check the current saved connection for ${identity}${profileAria}`,
      });
    } else if (resolution === 'removed') {
      title = 'Connection no longer exists';
      detail = `The paired server no longer has ${identity}. Its previous recovery stop remains closed, and there is no saved credential left to check.${remainingDetail}`;
      action = continueAction;
    } else if (resolution === 'unsupported') {
      title = 'Server update needed for an exact check';
      detail = `This paired server can check ${identity}, but it cannot prove which saved version it checked. Update and restart the paired server, then run the check once more. The previous recovery stop remains closed, and no credential was changed.`;
      action = button({
        label: 'Check after update',
        size: 'sm',
        variant: 'secondary',
        action: 'connections-recheck-post-safe-stop',
        data: { kind: p.kind, name: p.name },
        ariaLabel: `Check ${identity}${profileAria} after updating the paired server`,
      });
    } else {
      title = p.status === 'pending'
        ? 'Saved connection still needs a check'
        : p.status === 'unreachable'
          ? 'Provider could not be reached'
          : 'Saved connection not yet verified';
      detail = p.status === 'pending'
        ? `The paired server recorded closure of the previous recovery stop for ${identity}, but no newer check of the saved credential is on record. Run one check to finish recovery.`
        : p.status === 'unreachable'
          ? `The paired server could not reach the provider for ${identity}. This does not prove the saved credential is wrong. Reconnect or check the provider, then run one fresh check.${checked}`
          : p.status === 'auth_failed'
            ? `The paired server reported a credential rejection, but Recued could not bind that result to the latest saved version of ${identity}. Reload the current row, then check it again before replacing anything.${checked}`
            : `The paired server could not authoritatively finish the saved-credential check for ${identity}. The previous recovery stop remains closed; reconnect, then try one fresh check.${checked}`;
      action = button({
        label: 'Check again',
        size: 'sm',
        variant: 'secondary',
        action: 'connections-recheck-post-safe-stop',
        data: { kind: p.kind, name: p.name },
        ariaLabel: `Check the currently saved connection again for ${identity}${profileAria}`,
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
      ? 'Replacement credential'
      : ({
          none: 'No-auth binding',
          bearer: 'Bearer token',
          basic: 'Username and password',
          header: 'Header credential',
          query: 'Query credential',
          oauth2_refresh: 'OAuth refresh credential',
          oauth2_client_credentials: 'OAuth client credential',
          atproto_session: 'AT Protocol app password',
        } as const)[p.auth_type];
    const checkedAt = formatUtcMinute(p.verified_at);
    const expiresAt = formatUtcMinute(p.access_expires_at);
    const checked = checkedAt === null ? '' : ` Verified ${checkedAt}.`;
    const expiry = expiresAt === null ? '' : ` Access token valid until ${expiresAt}.`;
    const message = p.recovered
      ? `${authType} replacement for ${p.kind}/${p.name} was verified and applied. This recovered receipt confirms that attempt; review the current connection state before making another change.${checked}${expiry}`
      : `${authType} verified and now active for ${p.kind}/${p.name}. Future provider calls use the replacement.${checked}${expiry}`;
    return `<div class="connections-credential-receipt" data-connection-credential-receipt="verified" role="status" aria-live="polite">${inlineOk(
      message,
    )}</div>`;
  }
  const tone = p.status === 'ok' ? 'ok' : p.status === 'unknown' ? 'hint' : 'warn';
  const message = `Last probe for ${p.kind}/${p.name}: ${p.status}`;
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
    ? 'This recovery link needs a server check'
    : 'This recovery belongs to another server';
  const detail = handoff.reason === 'unbound'
    ? `This older or incomplete link does not identify which server profile created it. You are using ${activeLabel}. Recued did not open or check a same-named connection here.`
    : sourceKnown
      ? `This handoff was created for ${source}, but you are using ${activeLabel}. Recued did not open or check a same-named connection on this server.`
      : `This handoff was created for a different server profile that is not currently named in this browser. You are using ${activeLabel}. Recued did not open or check a same-named connection on this server.`;
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
        ariaLabel: `Review unresolved connection recovery on ${activeLabel}`,
      });
  const openProfiles = handoff.serverProfilesAvailable
    ? button({
        label: 'Open server profiles',
        size: 'sm',
        variant: 'primary',
        action: 'connections-open-post-safe-stop-profile',
        ariaLabel: sourceKnown
          ? `Open server profiles to find ${source}`
          : 'Open server profiles to review the recovery destination',
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
          ariaLabel: 'Dismiss this server-profile recovery handoff',
        })}
      </div>
    </section>
  `;
};

const credentialRotationFailureCopy = (
  reason: NonNullable<ConnectionsPageState['credentialRotationRecovery']>['failureReason'],
): string => {
  if (reason === 'auth_failed') {
    return 'The provider rejected the replacement. The saved credential was preserved.';
  }
  if (reason === 'unreachable') {
    return 'The provider check could not finish. The saved credential was preserved.';
  }
  if (reason === 'inconclusive') {
    return 'The provider could not prove the replacement was valid. The saved credential was preserved.';
  }
  if (reason === 'conflict') {
    return 'This connection changed during verification, so the replacement was not applied.';
  }
  return 'The replacement did not complete. The saved credential was preserved.';
};

const serverUpdateTriageReasonCopy = (
  triage: ConnectionsServerUpdateTriage,
): string => {
  const current = triage.currentVersion ?? 'an unconfirmed version';
  const baseline = triage.baselineVersion ?? 'the earlier unconfirmed version';
  if (triage.reason === 'update_still_available') {
    const target = triage.availableVersion === undefined
      ? 'an available update'
      : `version ${triage.availableVersion}`;
    if (
      triage.baselineVersion !== undefined
      && triage.currentVersion !== undefined
      && triage.currentVersion !== triage.baselineVersion
    ) {
      return `The selected server moved from version ${baseline} to ${current}, but its signed update check still offers ${target}. An update landed, yet this server is not at the available release and the required capability remains absent.`;
    }
    return `The selected server still reports version ${current}, and its signed update check still offers ${target}. The available release is not running on this server.`;
  }
  if (triage.reason === 'running_version_unchanged') {
    return `The selected server still reports version ${current}, the same running version seen before the update detour. Restart or redeploy the actual server used by this profile before retrying.`;
  }
  if (triage.reason === 'running_version_changed') {
    return `The selected server moved from version ${baseline} to ${current}, but the required safe-preflight capability is still absent. Verify that this profile received the complete server image or package, then restart that instance.`;
  }
  if (triage.reason === 'launcher_update_required') {
    return `The selected server reports version ${current}, but its signed update check says the launcher is too old. Update the launcher or deployment wrapper before retrying.`;
  }
  if (triage.reason === 'self_update_unavailable') {
    return `The selected server reports version ${current}, but in-app updates are not configured for this install. Update its package, image, or deployment outside Recued, then restart the selected instance.`;
  }
  if (triage.reason === 'current_build_missing_capability') {
    return `The selected server reports version ${current} and says its ${triage.channel ?? 'current'} channel is up to date, but the required safe-preflight capability is absent. Verify the deployed release artifact and selected server profile before retrying.`;
  }
  if (triage.checkStatus === 'bad-signature') {
    return `The selected server reports version ${current}, but it rejected the release manifest signature. Do not apply from that feed; verify the server’s trusted release key and signed manifest before retrying.`;
  }
  if (triage.checkStatus === 'replay') {
    return `The selected server reports version ${current}, but it rejected an older signed release manifest. Restore a current release feed before retrying.`;
  }
  if (triage.checkStatus === 'stale-feed') {
    return `The selected server reports version ${current}, but its signed release manifest is stale. Publish or restore a fresh manifest before retrying.`;
  }
  if (triage.checkStatus === 'fetch-failed') {
    return `The selected server reports version ${current}, but it could not fetch its release feed. Check this server’s outbound access and configured feed endpoint before retrying.`;
  }
  return 'The required safe-preflight capability is absent, and Recued could not complete a signed update check. Verify the selected profile, server reachability, and release-feed configuration before retrying.';
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
  return `Server evidence: ${evidence.join(' · ')}.`;
};

const serverUpdateBaselinePostureCopy: Readonly<
  Record<ReleaseCheckStatus, string>
> = {
  'update-available': 'a newer release is available',
  'up-to-date': 'the release feed reports this version is current',
  'not-configured': 'in-place release checks are not configured',
  'stale-feed': 'the release feed is stale and will not be acted on',
  'launcher-outdated': 'the launcher must be updated first',
  replay: 'an older release manifest was ignored',
  'fetch-failed': 'the running version is known; the release feed is unreachable',
  'bad-signature': 'the running version is known; the release manifest was rejected',
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
            ? 'Resume credential recovery'
            : hasRepeatedRejectionTriage
            ? 'Resolve repeated rejection'
            : 'Correct replacement'
          : 'Review connection'
        : 'Dismiss',
    ariaLabel: props.loading
      ? `Loading connection ${identity}`
      : canReview && hasExactCorrection
        ? hasRegenerationSafeStop
          ? `Resume safe credential recovery for ${identity}`
          : hasRepeatedRejectionTriage
          ? `Resolve the repeated credential rejection for ${identity}`
          : `Correct the rejected credential replacement for ${identity}`
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
    message = progress.phase === 'applying'
      ? `An open Recued tab is applying the server ${operation}. This tab will stay on ${identity} and wait instead of sending a duplicate action. Tabs share only an opaque ID for the selected server profile, the operation, phase, and start time; no credential, endpoint, connection detail, form value, version, or raw error is shared.`
      : progress.operationId === undefined
        ? `The server accepted the ${operation} in an open Recued tab. This tab will stay on ${identity} and verify its own reconnect before offering the credential check. Tabs share only an opaque ID for the selected server profile, the operation, phase, and start time; no credential, endpoint, connection detail, form value, version, or raw error is shared.`
        : verification?.phase === 'waiting'
          ? verification.reason === 'restart_pending'
            ? `The paired server says this ${operation} is still finishing its restart. Recued will check the exact receipt again automatically; ${identity} and all server controls stay paused meanwhile. The receipt and raw server details are never shown or stored in this recovery view.`
            : `Recued could not confirm this ${operation} receipt yet and will retry automatically. ${identity} and all server controls stay paused unless the paired server resolves the exact receipt. Raw errors and the receipt are never shown or stored in this recovery view.`
        : verification?.phase === 'retryable'
          ? `Recued could not confirm this ${operation} after several safe checks. ${identity} and all server controls remain paused. Open Server Updates or Account to retry; switching servers cannot count as proof of this result.`
        : verification?.phase === 'reviewing_closure'
          ? `An owner is reviewing a server-authoritative closure for this unresolved ${operation} receipt. ${identity} and all server controls remain paused; review or cancel that decision in Server Updates.`
        : verification?.phase === 'closing'
          ? `The selected server is re-checking this exact ${operation} receipt and will refuse closure while any release transition is active. ${identity} and all server controls remain paused.`
        : verification?.phase === 'closed'
          ? `The selected server durably closed this receipt as unresolved without claiming the ${operation} succeeded or failed. Confirm its current version, release posture, and ${identity} activity in Server Updates or Account before another server change.`
        : verification?.phase === 'checking_baseline'
          ? `Recued is freshly reading the selected server’s running version, release posture, and ${identity} activity. The original ${operation} outcome remains unknown and all server controls stay paused.`
        : verification?.phase === 'baseline_retryable'
          ? `The selected server’s current state could not be confirmed. ${identity} and all server controls remain paused; reconnect if needed, then retry the current-state check in Server Updates or Account.`
        : verification?.phase === 'baseline_confirmed'
          ? (() => {
              const baseline = verification.baseline;
              if (baseline === undefined) {
                return `Current-state evidence is incomplete. ${identity} and all server controls remain paused.`;
              }
              const affected = baseline.affectedConnection;
              const connectionCopy = affected === undefined
                ? 'no affected connection was linked'
                : affected.activity === 'idle'
                  ? `${affected.kind}/${affected.name} has no credential verification pending`
                  : affected.activity === 'pending'
                    ? `${affected.kind}/${affected.name} has credential verification pending`
                    : `${affected.kind}/${affected.name} activity will be checked again on return`;
              const finishCopy =
                verification.reason === 'finish_unavailable'
                  ? ' The exact browser latch could not be retired; retry Finish recovery there. No server action will repeat.'
                  : ' Review and finish recovery there.';
              return `Current state confirmed: running ${baseline.currentVersion} on the ${baseline.channel} channel; ${serverUpdateBaselinePostureCopy[baseline.updateStatus]}; ${connectionCopy}. Open Server Updates or Account.${finishCopy} The original ${operation} outcome remains unknown.`;
            })()
        : verification?.phase === 'finishing'
          ? `The reviewed current-state baseline is confirmed and this tab is retiring only its browser latch. ${identity} stays paused until that local finish completes; the original ${operation} outcome remains unknown.`
        : verification?.phase === 'unknown'
          ? verification.reason === 'operation_mismatch'
            ? `The paired server resolved this receipt as a different action than the expected ${operation}. ${identity} and all server controls remain paused. Confirm the selected server profile in Account, then use the privacy-safe diagnostic before retrying.`
            : verification.reason === 'closure_in_flight'
              ? `The server refused unresolved closure because another release transition is active. ${identity} and all server controls remain paused; wait for that change to settle, then retry the receipt check.`
              : verification.reason === 'closure_unavailable'
                ? `The selected server could not record an authoritative unresolved closure. ${identity} and all server controls remain paused; retry the receipt check or use the privacy-safe administrator handoff.`
                : `The paired server did not recognize this ${operation} receipt. ${identity} and all server controls remain paused. Confirm the selected server profile in Account, then retry, use the privacy-safe diagnostic, or review server-authoritative closure in Server Updates.`
        : `The server accepted the ${operation} in an open Recued tab. This tab will stay on ${identity} while the paired server verifies the exact opaque receipt before offering the credential check. Tabs share only an opaque ID for the selected server profile, the operation, phase, start time, and opaque server receipt; no credential, endpoint, connection detail, form value, version, or raw error is shared.`;
  } else if (recovery.phase === 'checking') {
    message = `Checking the interrupted credential replacement for ${identity}…`;
  } else if (recovery.phase === 'pending') {
    message = `The server received the replacement for ${identity} and is still checking it. Do not retry while this outcome is pending.`;
    action = button({
      label: 'Check outcome',
      size: 'xs',
      action: 'connections-check-credential-rotation',
    });
  } else if (recovery.phase === 'safe_stop_checking') {
    message = `Another tab reported that credential recovery for ${identity} reached a safe stop. This tab is asking the paired server to confirm that exact state before showing or clearing any recovery guidance; no credential or form value crossed tabs.`;
  } else if (recovery.phase === 'safe_stop_unconfirmed') {
    message = `Another tab reported a safe stop for ${identity}, but this tab could not confirm it with the paired server. Credential replacement remains paused here. Reconnect and check again, or continue the regeneration/administrator handoff in the tab that received the rejection.`;
    action = button({
      label: 'Check safe stop',
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
      ? `The paired server confirmed the safe stop for ${identity}. This tab kept its draft memory-only and now offers the same credential regeneration and privacy-safe administrator handoff as the originating tab. A material correction or explicit provider-side fix is required before one new verification.`
      : exactEditorOpen
        ? `The paired server confirmed the safe stop for ${identity}, but the rejected sign-in method differs from this editor's current draft. Saving remains paused. Resume credential recovery to explicitly discard this draft, rebuild the editor around the rejected sign-in method, and open the exact privacy-safe handoff.`
        : `The paired server confirmed that another tab reached the credential safe stop for ${identity}. The saved credential remains active, no draft crossed tabs, and this tab can resume the same regeneration or privacy-safe administrator handoff.`) + queueCopy;
    if (!exactRecoveryVisible) action = reviewAction();
  } else if (recovery.phase === 'handoff') {
    message = `This tab's earlier replacement for ${identity} ended. Another tab has taken over the next credential check. Recued will update this page when that tab finishes or lets go; do not start another replacement here.`;
    action = button({
      label: 'Check handoff',
      size: 'xs',
      action: 'connections-check-credential-rotation',
    });
  } else if (recovery.phase === 'handoff_waiting') {
    message = `This tab's earlier replacement for ${identity} ended, but Recued could not confirm the current connection state. It will check again after reconnecting; do not retry from this tab yet.`;
    action = button({
      label: 'Check handoff',
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
        ? `No newer credential was saved for ${identity}, and the safe stop remains active in this tab. Your current replacement is still memory-only. Create or rotate a credential, use the privacy-safe administrator handoff, or explicitly confirm that the provider fixed the setup before another verification.`
        : `No newer credential was saved for ${identity}, so you can continue in this tab. Your current replacement is still only here. ${earlierOutcome} Review or correct the draft, then choose Verify and replace. Recued will confirm that no other tab or server check owns this connection before sending.`;
    } else {
      message = `No newer version of ${identity} was saved. Review the current connection before entering another replacement.`;
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
      message = `The read-only safety check finished and the clean credential editor for ${identity} is ready. No field value or credential was restored. Enter a replacement below; Recued will recheck ownership before sending.`;
    } else {
      message = `The clean credential editor for ${identity} closed before any field changed. Resume when ready; Recued will repeat the current activity and saved-connection checks before reopening it. No field value, credential, or server-recovery receipt will be restored.`;
      action = button({
        label: props.loading
          ? 'Loading connection…'
          : canReview
            ? 'Resume clean editor'
            : 'Dismiss',
        ariaLabel: props.loading
          ? `Loading connection ${identity}`
          : canReview
            ? `Resume the clean credential editor for ${identity} after repeating its safety check`
            : `Dismiss clean credential editor recovery for ${identity}`,
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
      message = `No newer credential was saved for ${identity}. This tab has no replacement draft to recover because unfinished credentials are never stored. ${earlierOutcome} Enter a new replacement below. Recued will recheck ownership before sending.`;
    } else {
      message = `No newer credential was saved for ${identity}. This tab has no replacement draft to recover because unfinished credentials are never stored. ${earlierOutcome} Start fresh to open a clean replacement form. Recued will recheck ownership before sending.`;
      action = button({
        label: props.loading
          ? 'Loading connection…'
          : canReview
            ? 'Start fresh'
            : 'Dismiss',
        ariaLabel: props.loading
          ? `Loading connection ${identity}`
          : canReview
            ? `Start a fresh credential replacement for ${identity}`
            : `Dismiss credential recovery for ${identity}`,
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
      ? `Checking the updated server and the latest saved version of ${identity} before opening its clean credential form…`
      : `Rechecking server activity and the latest saved version of ${identity} before opening a clean credential form…`;
    action = button({
      label: 'Checking server…',
      ariaLabel: `Checking whether a fresh credential replacement can start for ${identity}`,
      size: 'xs',
      action: 'connections-start-fresh-credential-rotation',
      data: { kind: recovery.kind, name: recovery.name },
      disabled: true,
    });
  } else if (recovery.phase === 'restart_triaging') {
    message = `The updated server still lacks the safe activity preflight for ${identity}. Checking its running version and signed update state before suggesting another step…`;
    action = button({
      label: 'Checking server…',
      ariaLabel: `Checking the running version and update state for the server used by ${identity}`,
      size: 'xs',
      action: 'connections-start-fresh-credential-rotation',
      data: { kind: recovery.kind, name: recovery.name },
      disabled: true,
    });
  } else if (recovery.phase === 'restart_handoff') {
    message = `Another tab or paired client is checking a replacement for ${identity}. No credential entry is needed here yet. Check again after that work finishes.`;
    action = button({
      label: 'Check handoff',
      ariaLabel: `Check whether the credential replacement handoff finished for ${identity}`,
      size: 'xs',
      action: 'connections-start-fresh-credential-rotation',
      data: { kind: recovery.kind, name: recovery.name },
    });
  } else if (recovery.phase === 'restart_waiting') {
    message = recovery.returnedFromServerUpdate === true
      ? `Recued could not yet confirm the updated server and the latest saved version of ${identity}. No credential was sent. Let this tab reconnect, then try again.`
      : `Recued could not confirm current server activity and the latest saved version of ${identity}. No credential was sent, and the clean-start option is still here. Reconnect or try again.`;
    action = button({
      label: 'Try again',
      ariaLabel: `Retry the fresh credential replacement preflight for ${identity}`,
      size: 'xs',
      action: 'connections-start-fresh-credential-rotation',
      data: { kind: recovery.kind, name: recovery.name },
    });
  } else if (recovery.phase === 'restart_unsupported') {
    const triage = recovery.serverUpdateTriage;
    message = recovery.returnedFromServerUpdate === true && triage !== undefined
      ? `${serverUpdateTriageReasonCopy(triage)} ${serverUpdateTriageEvidenceCopy(triage)} No credential was sent.`
      : recovery.returnedFromServerUpdate === true
        ? `This server still cannot perform the activity preflight required for a safe fresh replacement of ${identity}. Recued could not confirm its update state; review the selected server profile before retrying. No credential was sent.`
      : `This paired server cannot perform the activity preflight required to start a safe fresh replacement for ${identity}. Update the server before trying again; no credential was sent.`;
    const guideAction = props.credentialRotationServerUpdateGuideAvailable === true
      ? button({
          label: triage?.reason === 'update_still_available'
            ? 'Continue server update'
            : recovery.returnedFromServerUpdate === true
              ? 'Review server profile'
              : 'Review update steps',
          ariaLabel: recovery.returnedFromServerUpdate === true
            ? `Review the selected server profile and update diagnosis for ${identity}`
            : `Review server update steps for ${identity}`,
          variant: 'primary',
          size: 'xs',
          action: 'connections-review-server-update',
          data: { kind: recovery.kind, name: recovery.name },
        })
      : '';
    action = `${guideAction}${button({
      label: 'Check again',
      ariaLabel: `Check again for safe fresh credential replacement support for ${identity}`,
      size: 'xs',
      action: 'connections-start-fresh-credential-rotation',
      data: { kind: recovery.kind, name: recovery.name },
    })}${button({
      label: 'Dismiss',
      ariaLabel: `Dismiss credential recovery for ${identity}`,
      variant: 'link',
      size: 'xs',
      action: 'connections-dismiss-credential-rotation',
      data: { kind: recovery.kind, name: recovery.name },
    })}`;
  } else if (recovery.phase === 'restart_resolved') {
    message = `A fresh, read-only check confirmed that this server can safely check a credential replacement for ${identity}. You stayed on this page and no credential form opened. Continue here when you are ready; Recued will re-read the server and exact saved connection before opening a clean replacement form.`;
    action = `${button({
      label: props.loading
        ? 'Loading connection…'
        : canReview
          ? 'Continue in this tab'
          : 'Dismiss',
      ariaLabel: props.loading
        ? `Loading connection ${identity}`
        : canReview
          ? `Continue the credential replacement check for ${identity} in this tab`
          : `Dismiss resolved server capability for ${identity}`,
      variant: canReview ? 'primary' : 'secondary',
      size: 'xs',
      action: canReview
        ? 'connections-start-fresh-credential-rotation'
        : 'connections-dismiss-credential-rotation',
      data: { kind: recovery.kind, name: recovery.name },
      disabled: props.loading,
    })}${canReview ? button({
      label: 'Dismiss',
      ariaLabel: `Dismiss resolved server capability for ${identity}`,
      variant: 'link',
      size: 'xs',
      action: 'connections-dismiss-credential-rotation',
      data: { kind: recovery.kind, name: recovery.name },
    }) : ''}`;
  } else if (recovery.phase === 'superseded') {
    message = canReview
      ? `Another tab or paired client saved a newer version of ${identity} while this tab was away. Recued kept the newer server version; review it before making another change.`
      : `${identity} was removed while this tab was away. Recued kept the authoritative server state; dismiss this receipt when ready.`;
    action = reviewAction();
  } else if (recovery.phase === 'waiting') {
    message = `The result for ${identity} is not confirmed yet. Recued will check again when this server reconnects; do not enter another replacement meanwhile.`;
    action = button({
      label: 'Check outcome',
      size: 'xs',
      action: 'connections-check-credential-rotation',
    });
  } else if (recovery.phase === 'not_received') {
    message = `The server has no current receipt for this replacement of ${identity}. It was not applied to any currently enrolled connection with this identity; review the connection before trying again.`;
    action = reviewAction();
  } else if (recovery.phase === 'unsupported') {
    message = `This server cannot recover the interrupted receipt for ${identity}. Review and probe the connection before deciding whether to retry.`;
    action = reviewAction();
  } else if (hasRegenerationSafeStop) {
    const exactEditorOpen = props.dialog.stage === 'form'
      && props.dialog.mode === 'edit'
      && props.dialog.editingId === connectionRowKey(
        recovery.kind,
        recovery.name,
      );
    message = exactEditorOpen
      ? `Safe credential recovery is open for ${identity}. The saved credential remains active, and unfinished credentials are never restored after a reload. Verify and replace stays paused until you enter a fresh credential; if this tab still holds the rejected draft, you can instead confirm a provider-side fix before one new check.`
      : `The paired server rejected another replacement for ${identity} after provider/endpoint triage. The saved credential remains active, and no credential draft was stored. Resume to create or rotate a credential or prepare a privacy-safe administrator handoff.`;
    if (!exactEditorOpen) action = reviewAction();
  } else {
    message = `${credentialRotationFailureCopy(recovery.failureReason)} Review ${identity} and re-enter the replacement when ready.`;
    action = reviewAction();
  }
  if (recoveryVerification?.phase === 'completed') {
    const baseline = recoveryVerification.baseline;
    const currentState = baseline === undefined
      ? 'Its reviewed current-state baseline is no longer available.'
      : `It confirmed running ${baseline.currentVersion} on the ${baseline.channel} channel; ${serverUpdateBaselinePostureCopy[baseline.updateStatus]}.`;
    message =
      `Server recovery is finished and server-change controls are unlocked. ${currentState} `
      + `The original ${recoveryVerification.operation} outcome remains unknown. `
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
  const groups = groupByKind(props.connections);
  const installedManifests = props.installedPackManifests ?? [];
  const groupBlocks = KIND_ORDER.map((kind) =>
    renderKindGroup(
      kind,
      groups[kind],
      props.probeInFlight,
      props.deleteInFlight,
      props.engagementHealth,
      installedManifests,
      props.mcpPackStatus,
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
    ${renderRecentProbe(
      props.dialog,
      props.postSafeStopRecoveries,
      props.postSafeStopProfileLabel,
    )}
    ${empty}
    ${groupBlocks}
    <div class="connections-add-row">
      ${button({
        label: '+ Add Connection',
        variant: 'primary',
        size: 'sm',
        action: 'connections-open-add',
      })}
    </div>
  `;
};

// R13 — the per-vendor preset cards retired: one generic free-edit "Add API
// connection" form covers every vendor (any auth type, base URL, OAuth
// endpoints + scopes). Recognition / auto-detect returns later as a
// convenience pre-fill, never a gate.
const renderKindPicker = (): string => `
  <div class="connections-picker">
    <h3 class="connections-picker-title">Pick a connection kind</h3>
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
    <h3 class="connections-picker-title">Pick a ${e(KIND_LABELS[kind])} subtype</h3>
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
): string => {
  const nameKey = `${baseKey}.${row.index}.header_name`;
  const valueKey = `${baseKey}.${row.index}.value`;
  const nameInput = textInput({
    id: fieldId(nameKey),
    type: 'text',
    value: row.header_name,
    placeholder: 'X-API-Key',
    spellcheck: false,
    disabled: saving,
    ariaLabel: `Header ${position} name`,
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
    ariaLabel: `Header ${position} value`,
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
    ariaLabel: `Remove header ${position}`,
    data: { 'header-index': String(row.index), 'base-key': baseKey },
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
  const collected = collectHeaderRows(values, field.key);
  const rows: HeaderRow[] =
    collected.length > 0 ? collected : [{ index: 0, header_name: '', value: '' }];
  const rowsHtml = rows
    .map((r, i) => renderHeaderRow(
      field.key,
      r,
      i + 1,
      rows.length,
      saving,
      credentialRejected,
    ))
    .join('');
  const addBtn = button({
    label: '+ Add header',
    action: 'connections-add-header',
    size: 'sm',
    variant: 'secondary',
    extraClass: 'connections-header-add',
    disabled: saving || rows.length >= MAX_HEADER_AUTH_ENTRIES,
    data: { 'base-key': field.key },
  });
  const required = field.optional ? '' : ' <span class="connections-field-required">*</span>';
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
  if (field.type === 'header-list') {
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
            label: opt,
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
  const required = field.optional ? '' : ' <span class="connections-field-required">*</span>';
  const hint = field.help ? fieldHint(field.help) : '';
  // ⚠ Wording is deliberate. "Suggested by X" tells the owner where a value came
  // from; it must NOT read as "Recued checked this". A label that looks like
  // assurance and is not is worse than no label at all.
  const suggestedBy = hintedFields[field.key];
  const attribution = suggestedBy
    ? `<p class="rx-field-hint field-hint connections-field-suggested"`
      + ` data-suggested-by="${e(suggestedBy)}">Suggested by ${e(suggestedBy)} — check it before you continue.</p>`
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
}

export interface ConnectionFormValidationSummary {
  readonly status: 'blocked' | 'ready';
  readonly fieldKey: string;
  readonly title: string;
  readonly message: string;
  readonly actionLabel: string;
}

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
    if (field.type === 'header-list') {
      let complete = 0;
      for (const row of collectHeaderRows(values, field.key)) {
        const hasName = row.header_name.trim().length > 0;
        const hasValue = row.value.trim().length > 0;
        if (hasName !== hasValue) {
          const missingKey = hasName ? 'value' : 'header_name';
          return formValidationIssue(
            `${field.key}.${row.index}.${missingKey}`,
            field.label,
            `${field.label}: each header needs both a name and a value.`,
          );
        }
        if (hasName) complete += 1;
      }
      if (!field.optional && complete === 0) {
        return formValidationIssue(
          `${field.key}.0.header_name`,
          field.label,
          `${field.label}: add at least one header (name and value).`,
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
    if (field.optional) continue;
    const raw = values[field.key] ?? '';
    if (raw.trim().length === 0) {
      return formValidationIssue(
        field.key,
        field.label,
        `${field.label} is required.`,
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
): ConnectionFormValidationSummary => issue === null
  ? {
      status: 'ready',
      fieldKey: '',
      title: 'Required details complete',
      message: 'Review the values before saving.',
      actionLabel: 'Go to first incomplete field',
    }
  : {
      status: 'blocked',
      fieldKey: issue.fieldKey,
      title: `Next: ${issue.fieldLabel}`,
      message: issue.detailAtField === true
        ? 'Review the prerequisite shown with this field.'
        : issue.message,
      actionLabel: `Go to ${issue.fieldLabel}`,
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
  bearer: 'Bearer token',
  basic: 'Username and password',
  header: 'Credential headers',
  query: 'Query parameter',
  oauth2_refresh: 'OAuth with refresh token',
  oauth2_client_credentials: 'OAuth client credentials',
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
      ? 'Do not resend this replacement unchanged. Enter a newly created or rotated credential, or ask the provider administrator to repair and confirm the account or app first.'
      : 'No rejected credential was restored. Enter a newly created or rotated credential before verifying again, or use the safe handoff to ask the provider administrator for one.'
    : labels.length === 1
      ? `Review ${labels[0]}, then verify the replacement again.`
      : `Review this credential set together: ${labels.join(', ')}. Start with ${first.label}, then verify again.`;
  const triageCopy = triage === undefined
    ? ''
    : triage.stage === 'credential_exchange'
      ? 'The paired server saw another rejection during credential exchange. Confirm that the credential details and exchange endpoint belong to the same provider account or tenant before retrying.'
      : firstEndpoint === undefined
        ? "The paired server's configured provider check rejected this replacement again. Confirm that this credential was issued for the intended provider account, tenant, or workspace before retrying."
        : "The paired server's configured endpoint check rejected this replacement again. Confirm that the credential and endpoint belong to the intended provider account or tenant before retrying.";
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
        label: safeStop ? 'Create or rotate credential' : 'Check provider setup',
        size: 'sm',
        variant: safeStop ? 'primary' : 'secondary',
        action: 'connections-guide-open',
      })
    : '';
  const credentialAction = button({
    label: safeStop ? `Enter fresh ${first.label}` : `Review ${first.label}`,
    size: 'sm',
    variant: safeStop && guideAction === '' ? 'primary' : 'secondary',
    action: 'connections-focus-credential-correction',
    data: { 'field-key': first.key },
  });
  const closureActionLabel = closure?.phase === 'checking'
    ? 'Checking server support…'
    : closure?.phase === 'acknowledging'
      ? 'Recording provider fix…'
      : closure?.phase === 'unconfirmed'
        ? 'Check server closure'
        : closure?.phase === 'unsupported'
          ? 'Server update required'
          : 'Provider/admin confirmed a fix';
  const confirmedAction = safeStop
    ? button({
        label: closureActionLabel,
        size: 'sm',
        variant: 'secondary',
        action: 'connections-confirm-credential-handoff',
        ariaLabel: 'Confirm the provider or administrator changed the credential setup and close this server safe stop',
        disabled: closure?.phase === 'checking'
          || closure?.phase === 'acknowledging'
          || closure?.phase === 'unsupported',
      })
    : '';
  const closureStatus = !safeStop || closure === undefined
    ? ''
    : closure.phase === 'ready'
      ? 'Recued will ask the paired server to record this fix before closing the recovery stop. No credential or form value is sent; checking the saved or replacement credential remains a separate action.'
      : closure.phase === 'checking'
        ? 'Checking whether the paired server can record this recovery closure…'
        : closure.phase === 'acknowledging'
          ? 'Recording the provider or administrator fix on the paired server before this recovery stop is closed…'
          : closure.error
            ?? (closure.phase === 'unsupported'
              ? 'This server cannot record authoritative safe-stop closure yet. Update it, or enter a materially new credential before verifying again.'
              : 'Recued could not confirm that the paired server recorded the fix. Reconnect and check server closure before retrying.');
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
): string => {
  const summary = connectionFormValidationSummary(issue);
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
const renderVendorOAuth = (dialog: ConnectionsDialogState): string => {
  // Render the in-app consent affordance for a registered vendor flow OR a
  // generic `api` oauth2_refresh form (R14 — any BYO vendor). On the generic
  // form the button is an OPTIONAL accelerator: the named Refresh Token field
  // remains a manual fallback, and the host validates typed endpoints on click.
  const isGeneric =
    !dialog.vendor
    && dialog.kind === 'api'
    && dialog.values['auth.type'] === 'oauth2_refresh';
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
        : 'Refresh token ready to save'
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
  const requirements = readiness.requirements.map((item) => {
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
      <ul class="connections-oauth-readiness">${requirements}</ul>
      <div class="connections-oauth-callback">
        <div>
          <strong>Exact callback URL</strong>
          <span>Register this unchanged in the provider app.</span>
        </div>
        <div class="connections-oauth-callback-value">
          <code>${e(OAUTH_CLOUD_CALLBACK_URL)}</code>
          ${button({
            label: 'Copy',
            size: 'xs',
            action: 'connections-guide-copy-callback',
            ariaLabel: 'Copy the exact provider OAuth callback URL',
          })}
        </div>
      </div>
      ${errorBlock}
      ${reauthorizationBlock}
      ${grantedSummary}
      ${readiness.scopeCount > 0
        ? `<p class="connections-oauth-scope-count">${readiness.scopeCount} requested ${readiness.scopeCount === 1 ? 'scope' : 'scopes'} will be reviewed on the provider screen.</p>`
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
        <p>Paste this as an allowed redirect or callback URI. Do not add a slash or substitute this tab's address.</p>
        <div class="connections-setup-guide-copy-value">
          <code id="connection-setup-guide-callback">${e(OAUTH_CLOUD_CALLBACK_URL)}</code>
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
          <p>Enter the provider-issued client ID and any secret it issued only in the connection form—not in the AI guide. Recued will take you to the next unfinished field or ${isRefresh ? 'authorization' : 'Save and probe'} action.</p>
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
  if (schema.kind !== 'api') return '';
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

const renderCredentialRotation = (
  dialog: ConnectionsDialogState,
  schema: ConnectionSchema,
): string => {
  if (dialog.mode !== 'edit') return '';
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
    : 'Leave credential fields blank to keep the current credentials. To rotate them, enter a complete replacement; Recued verifies it before switching.';
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
        label: 'Return and check connection',
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
      ? 'The server is still checking the replacement'
      : ownership.phase === 'safe_stop_checking'
        ? 'Confirming the cross-tab safe stop…'
        : ownership.phase === 'safe_stopped'
          ? 'Credential recovery is paused across tabs'
          : ownership.phase === 'safe_stop_unconfirmed'
            ? 'Could not confirm the cross-tab safe stop'
            : ownership.phase === 'handoff'
              ? 'Another tab is handling this check'
              : ownership.phase === 'available'
                ? 'This tab can continue'
                : ownership.phase === 'unconfirmed'
                  ? 'Could not confirm that takeover is safe'
                  : 'Credential check active elsewhere';
  const detail = ownership.phase === 'checking'
    ? `Saving ${identity} is paused while Recued checks the live tab and paired server. Your replacement stays only in this tab.`
    : ownership.phase === 'pending'
      ? `This tab now holds the browser check, but the paired server is still verifying ${identity}. Recued will wait without sending the credential again.`
      : ownership.phase === 'safe_stop_checking'
        ? `Another tab reported a safe stop for ${identity}. Saving is paused while this tab independently checks the paired server; your replacement stays only in this tab.`
        : ownership.phase === 'safe_stopped'
          ? `The paired server confirmed the safe stop for ${identity}, but its correction does not match this editor's current sign-in method. Keep this draft here and review the exact recovery before another verification.`
          : ownership.phase === 'safe_stop_unconfirmed'
            ? `Saving ${identity} remains paused because this tab could not verify the safe-stop handoff. Reconnect and check again, or continue in the tab that received the rejection; your replacement stays only here.`
            : ownership.phase === 'handoff'
              ? `This returned editor does not own ${identity}. Recued is waiting for the active tab before this draft can be sent; your replacement stays only in this tab.`
              : ownership.phase === 'available'
                ? `No other tab or server check owns ${identity}. Review this memory-only replacement, then choose Verify and replace when ready.`
                : ownership.phase === 'unconfirmed'
                  ? `Saving ${identity} remains paused because Recued could not prove that the prior check finished. Your replacement stays only in this tab.`
                  : ownership.automaticTakeover
                    ? `Another tab or paired client owns the provider check for ${identity}. Saving here is paused so the replacement cannot be sent twice; your draft stays only in this tab. If that owner disappears, Recued will elect one safe successor automatically.`
                    : `Another tab or paired client owns the provider check for ${identity}. Saving here is paused so the replacement cannot be sent twice; your draft stays only in this tab. After that owner finishes or closes, choose Check availability.`;
  const action = ownership.phase === 'available'
    ? ''
    : button({
        label: ownership.phase === 'checking'
          ? 'Checking…'
          : ownership.phase === 'safe_stop_checking'
            ? 'Checking…'
            : safeStopPhase
              ? 'Check safe stop'
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

const renderForm = (
  dialog: ConnectionsDialogState,
  dynamicOptions: Record<string, readonly string[]> | undefined,
): string => {
  const kind = dialog.kind;
  if (!kind) {
    return inlineError('Connection kind missing — pick a kind to continue.');
  }
  const schema = resolveConnectionSchema(
    kind,
    dialog.subtype ?? undefined,
    dialog.vendor ?? undefined,
  );
  if (!schema) {
    return inlineError(
      `No schema for ${kind}${dialog.subtype ? `/${dialog.subtype}` : ''} — pick a different subtype.`,
    );
  }
  const validationIssue = connectionFormValidationIssue(
    schema,
    dialog.values,
    dynamicOptions,
    dialog.mode,
  );
  const credentialRotation = dialog.mode === 'edit'
    && shouldPatchConnectionAuth(schema, dialog.values);
  const matchingRecoveredReceipt = dialog.recentProbe?.recovered === true
    && dialog.editingId === connectionRowKey(
      dialog.recentProbe.kind,
      dialog.recentProbe.name,
    )
    ? renderRecentProbe(dialog)
    : '';
  const probeNote = schema.probe
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
  return `
    <div class="connections-form" data-stage="form"${dialog.vendor ? ` data-vendor="${e(dialog.vendor)}"` : ''}>
      <h3 class="connections-form-title">
        ${e(dialog.mode === 'edit' ? 'Edit ' : 'Add ')}${e(schema.label)}
      </h3>
      <p class="connections-form-description">${e(schema.description)}</p>
      <p class="connections-form-draft-protection" data-connection-draft-protection>
        Changes you make stay only in this tab. Recued will ask before you leave.
        Credential fields are not saved in your browser, so they cannot be
        restored after discard or reload.
      </p>
      ${probeNote}
      ${matchingRecoveredReceipt}
      ${renderExternalEditorChange(dialog)}
      ${renderCredentialRotationOwnership(dialog)}
      ${renderConnectionSetupGuide(dialog, schema)}
      ${renderVendorConsentDisclosure(dialog)}
      ${renderCredentialRotation(dialog, schema)}
      ${renderCredentialSafeStopClosureNotice(dialog)}
      ${renderCredentialCorrection(dialog, schema)}
      ${dialog.credentialCorrection === null || validationIssue !== null
        ? renderConnectionFormValidation(validationIssue, validationShouldAnnounce)
        : ''}
      <div class="connections-form-fields">
        ${schema.fields.map((f) => renderField(
          f,
          dialog.values,
          dynamicOptions,
          dialog.mode,
          dialog.saving || (dialog.oauthInFlight && isConnectionOAuthLockedField(f.key)),
          dialog.oauthErrorFieldKey,
          dialog.credentialCorrection?.fieldKeys ?? [],
          dialog.hintedFields,
        )).join('')}
      </div>
      ${renderVendorOAuth(dialog)}
      ${dialog.error && dialog.credentialCorrection === null && dialog.error !== validationIssue?.message
        ? inlineError(dialog.error)
        : ''}
      <div class="connections-dialog-actions">
        ${dialog.mode === 'create'
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
            ? credentialRotation
              ? 'Verifying replacement…'
              : 'Saving…'
            : dialog.mode === 'edit'
              ? credentialRotation
                ? 'Verify and replace'
                : 'Save changes'
              : 'Save and probe',
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
  } else if (d.stage === 'form') body = renderForm(d, props.dynamicOptions);
  return `
    <div class="connections-dialog" role="dialog" aria-label="Connection enrollment">
      ${body}
    </div>
  `;
};

const renderHeader = (props: ConnectionsPageProps): string => {
  if (props.layout === 'embedded') return '';
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
  return `
    <div class="connections-page${dialogOpen ? ' connections-page--dialog-open' : ''}">
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
.connections-page {
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
@media (max-width: 560px) {
  .connections-credential-recovery {
    align-items: flex-start;
    flex-direction: column;
  }
  .connections-credential-recovery-action { justify-content: flex-start; }
}
.connections-group {
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
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.connections-pack-usage {
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
  font-size: 12px;
}
.connections-pack-usage-name { font-weight: 600; }
.connections-pack-usage-status { color: var(--fg-muted); }
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
  align-items: baseline;
  gap: 8px;
  flex: 1;
  min-width: 0;
}
.connections-row-name {
  font-size: 13px;
  color: var(--fg);
}
.connections-row-subtype {
  font-size: 11px;
  color: var(--fg-muted);
  text-transform: lowercase;
}
.connections-row-summary {
  font-size: 12px;
  color: var(--fg-muted);
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.connections-row-display {
  font-size: 11px;
  color: var(--fg-muted);
}
.connections-row-actions {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
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
.connections-picker-title,
.connections-form-title {
  font-size: 14px;
  font-weight: 600;
  margin: 0 0 12px;
}
.connections-form-description {
  font-size: 12px;
  color: var(--fg-muted);
  margin: 0 0 12px;
}
.connections-form-draft-protection {
  font-size: 12px;
  line-height: 1.45;
  color: var(--fg-muted);
  margin: -4px 0 12px;
}
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
  border-left-color: var(--accent);
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
}
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
  display: flex;
  gap: 6px;
  align-items: center;
}
.connections-header-row .connections-header-name { flex: 1 1 40%; }
.connections-header-row .connections-header-value { flex: 1 1 60%; }
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
  display: flex;
  flex-direction: column;
}
.connections-delete-backdrop {
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
  width: 100%;
  max-width: 380px;
  padding: 20px;
  border: 1px solid var(--border, #e5e5e5);
  border-radius: 8px;
  background: var(--bg, #fff);
  color: var(--fg);
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.24);
}
.connections-delete-title { margin: 0 0 8px; font-size: 15px; }
.connections-delete-body { margin: 0 0 12px; font-size: 13px; color: var(--fg-muted); }
.connections-delete-optin {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 13px;
  cursor: pointer;
}
.connections-delete-optin input { margin-top: 2px; }
.connections-delete-note {
  margin: 6px 0 0 24px;
  font-size: 12px;
  color: var(--fg-muted);
}
.connections-delete-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
}
@media (max-width: 520px) {
  .connections-oauth-heading,
  .connections-oauth-callback-value {
    align-items: stretch;
    flex-direction: column;
  }
  .connections-oauth-readiness {
    grid-template-columns: 1fr;
  }
  .connections-oauth > .rx-btn,
  .connections-oauth-callback-value .rx-btn {
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
