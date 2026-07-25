/** D-139 P2 — Engagement-health detail panel renderer.
 *
 *  Renders the per-entity health surface + capability grid + action
 *  affordances for one HubSpot or Salesforce connection. Pure HTML;
 *  state arrives via `props`. The host wires `data-action` clicks to
 *  the new rpc surfaces:
 *
 *    - `data-action="connections-engagement-reprobe"` →
 *      `collection.connection.reprobeEngagementCapabilities` (Salesforce
 *      only)
 *    - `data-action="connections-engagement-install-puller"` → host
 *      navigates to the recipe install flow for the appropriate puller
 *      recipe (`hubspot-engagement-puller` / `salesforce-engagement-puller`)
 *    - `data-action="connections-engagement-configure-cadence"` → host
 *      navigates to Settings → Server → Housekeeping (HubSpot only)
 *
 *  Spec: docs/d-139-spec.md § A.8 + § P2. */

import type {
  EngagementHealthResponse,
  EngagementHealthRow,
  EngagementVendor,
  ReprobeEngagementCapabilitiesResponse,
} from '@recued/contracts';
import { e } from '../template.js';
import { button } from '../primitives/button.js';
import { inlineError, inlineHint } from '../primitives/message.js';

/** Renderable state for one connection's health detail panel. */
export interface EngagementHealthPanelProps {
  /** Connection name — drives the rpc args + the data-conn-name
   *  attribute the host reads on action clicks. */
  connectionName: string;
  /** Loading state (rpc in flight). Disables the action buttons + dims
   *  the row table. */
  loading: boolean;
  /** Last rpc error string when present. Surfaces inline above the
   *  table; cleared on next successful load. */
  error: string | null;
  /** Re-probe in-flight flag. Salesforce only — disables the re-probe
   *  button + flips the label to "Probing…". */
  reprobing: boolean;
  /** Install-in-flight flag. Disables the "Install scheduled puller"
   *  button + flips the label to "Installing…". */
  installing: boolean;
  /** Most recent `engagementHealth` response. `null` until the host
   *  hydrates the panel by calling the rpc. */
  data: EngagementHealthResponse | null;
  /** D-139 P2 Codex review fold #6 — most recent re-probe response.
   *  Carries the PushTopic auto-creation outcome per Salesforce
   *  object. `null` when no re-probe has happened in the current
   *  session. Hosts patch this from the `reprobeEngagementCapabilities`
   *  rpc result so the panel can surface "Created" / "Preserved" /
   *  "Failed" badges per relationship object. HubSpot panels leave
   *  this null. */
  lastReprobe?: ReprobeEngagementCapabilitiesResponse | null;
}

/** ⚠ An OVERRIDE table for irregular casing — NOT an exhaustive vendor list.
 *
 *  This was `Record<EngagementVendor, string>` with exactly two keys, and it rendered
 *  "undefined engagement health" for Dynamics. The bug is instructive, because the
 *  DE-HARDCODE ITSELF caused it: D-192 widened `EngagementVendor` from
 *  `'hubspot' | 'salesforce'` to bare `string`, which silently degraded
 *  `Record<EngagementVendor, string>` into `Record<string, string>` — so a two-key
 *  literal kept compiling with no exhaustiveness error, while the engagement plane
 *  went on to ship a third vendor as a pack (`community/packs/dynamics.json`).
 *
 *  The arc traded a compile-time guarantee for openness and did not replace it with a
 *  runtime floor. Wherever a `Record<OpenVendorType, …>` literal survives a widening,
 *  it stops being checked and starts returning `undefined` — quietly. That is the
 *  whole class; this was its only remaining instance.
 *
 *  So: derive by default, override only where a slug does not titlecase correctly
 *  (`hubspot` → "HubSpot", not "Hubspot"). A vendor nobody has heard of still renders
 *  as itself rather than as `undefined`.
 *
 *  The FULLER fix is to thread the vendor's real `display_name` from the live vendor
 *  registry (which is where a pack's own name lives — "Microsoft Dynamics 365", not
 *  "Dynamics") down into `EngagementHealthPanelProps`. Ledgered, not done: it is a
 *  prop-threading change through the connections page, and this floor stops the lie. */
const VENDOR_LABEL_OVERRIDES: Readonly<Record<string, string>> = {
  hubspot: 'HubSpot',
  salesforce: 'Salesforce',
};

/** Never `undefined`. Titlecases `dynamics` → "Dynamics", `zoho-crm` → "Zoho Crm";
 *  an unsplittable slug falls all the way back to itself. */
const vendorLabel = (vendor: EngagementVendor): string => {
  const override = VENDOR_LABEL_OVERRIDES[vendor];
  if (override !== undefined) return override;
  const derived = vendor
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
  return derived.length > 0 ? derived : vendor;
};

const RATE_STATE_LABEL: Record<string, string> = {
  normal: 'Normal',
  degraded_30m: 'Slowing (30 min)',
  degraded_1h: 'Slowing (1 h)',
  suspended: 'Suspended',
};

/** "2 days ago" / "12 minutes ago" / etc. The renderer is HTML-only;
 *  the host can override this by pre-formatting `last_pulled_at`
 *  upstream if it wants different formatting (we keep it inline so a
 *  webapp / extension can both render without injecting a date util). */
const formatRelative = (now: number, ts: number | null): string => {
  if (ts === null) return 'Never';
  const delta = now - ts;
  if (delta < 0) return 'Just now';
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return `${days} d ago`;
};

/** Format the budget-utilization-pct field as "12.4%" / "100%". */
const formatPct = (pct: number): string => {
  const clamped = Math.max(0, Math.min(1, pct));
  if (clamped >= 1) return '100%';
  return `${(clamped * 100).toFixed(1)}%`;
};

const renderHubSpotCallout = (
  vendor: EngagementVendor,
  connectionName: string,
): string => {
  if (vendor !== 'hubspot') return '';
  return `
    <div class="connections-engagement-callout connections-engagement-callout--hubspot" role="note">
      <strong>No public URL?</strong>
      You'll get cycle-cadence updates instead of real-time alerts. Stored
      records, search, and daily aggregates still work — only "the moment
      it changes" notifications are affected.
      ${button({
        label: 'Configure cadence',
        variant: 'link',
        size: 'sm',
        action: 'connections-engagement-configure-cadence',
        data: { vendor: 'hubspot', name: connectionName },
      })}
    </div>
  `;
};

const renderCapabilityCell = (row: EngagementHealthRow): string => {
  if (!row.capability) return '<span class="connections-engagement-cap-none">—</span>';
  const cap = row.capability;
  const tags: string[] = [];
  if (cap.cdc_supported) tags.push('CDC');
  if (cap.push_topic_supported) tags.push('PushTopic');
  if (cap.reconciler_only) tags.push('Reconciler-only');
  if (cap.association_rescan_required) tags.push('Rescan-required');
  if (!cap.available) tags.push('Unavailable');
  const tagHtml = tags
    .map((t) => `<span class="connections-engagement-cap-tag">${e(t)}</span>`)
    .join('');
  return tagHtml || '<span class="connections-engagement-cap-none">—</span>';
};

const renderRow = (now: number, row: EngagementHealthRow): string => {
  const pulled = formatRelative(now, row.last_pulled_at);
  const errorHtml = row.last_error
    ? `<span class="connections-engagement-error" title="${e(row.last_error)}">⚠ ${e(row.last_error.slice(0, 60))}${row.last_error.length > 60 ? '…' : ''}</span>`
    : '<span class="connections-engagement-ok">OK</span>';
  return `
    <tr class="connections-engagement-row" data-entity="${e(row.entity)}">
      <td class="connections-engagement-cell-entity">
        <strong>${e(row.entity)}</strong>
      </td>
      <td class="connections-engagement-cell-pulled">${e(pulled)}</td>
      <td class="connections-engagement-cell-error">${errorHtml}</td>
      <td class="connections-engagement-cell-pages">${row.pages_fetched_today.toLocaleString()}</td>
      <td class="connections-engagement-cell-calls">${row.api_calls_consumed_today.toLocaleString()}</td>
      <td class="connections-engagement-cell-budget">
        <span class="connections-engagement-budget-pct connections-engagement-budget-${e(row.rate_control_state)}">
          ${e(formatPct(row.budget_utilization_pct))}
        </span>
      </td>
      <td class="connections-engagement-cell-capability">
        ${renderCapabilityCell(row)}
      </td>
    </tr>
  `;
};

const renderActions = (props: EngagementHealthPanelProps, vendor: EngagementVendor): string => {
  const installLabel = props.installing
    ? 'Installing…'
    : 'Install scheduled puller recipe →';
  const reprobeButton =
    vendor === 'salesforce'
      ? button({
          label: props.reprobing ? 'Re-probing…' : 'Re-probe capabilities',
          variant: 'secondary',
          size: 'sm',
          action: 'connections-engagement-reprobe',
          data: { name: props.connectionName },
          disabled: props.reprobing || props.installing,
        })
      : '';
  return `
    <div class="connections-engagement-actions">
      ${button({
        label: installLabel,
        variant: 'primary',
        size: 'sm',
        action: 'connections-engagement-install-puller',
        data: { name: props.connectionName, vendor },
        disabled: props.installing || props.reprobing,
      })}
      ${reprobeButton}
    </div>
  `;
};

const renderHeader = (vendor: EngagementVendor, data: EngagementHealthResponse): string => {
  const bucketStarted = new Date(data.bucket_started_at).toISOString().slice(11, 16);
  const totalCalls = data.rows[0]?.api_calls_consumed_today ?? 0;
  return `
    <div class="connections-engagement-header">
      <h4 class="connections-engagement-title">${e(vendorLabel(vendor))} engagement health</h4>
      <p class="connections-engagement-subtitle">
        Daily budget: <strong>${data.daily_budget.toLocaleString()}</strong> API calls
        · used: <strong>${totalCalls.toLocaleString()}</strong>
        · bucket started ${e(bucketStarted)} UTC
      </p>
    </div>
  `;
};

const renderTable = (data: EngagementHealthResponse): string => {
  const now = Date.now();
  return `
    <table class="connections-engagement-table">
      <thead>
        <tr>
          <th>Entity</th>
          <th>Last pulled</th>
          <th>Status</th>
          <th>Pages today</th>
          <th>API calls today</th>
          <th>Budget</th>
          <th>Capability</th>
        </tr>
      </thead>
      <tbody>
        ${data.rows.map((row) => renderRow(now, row)).join('')}
      </tbody>
    </table>
  `;
};

const renderRelationshipsPanel = (data: EngagementHealthResponse): string => {
  if (data.vendor !== 'salesforce' || data.relationships.length === 0) return '';
  const rows = data.relationships
    .map((rel) => {
      const cap = rel.capability;
      const status = cap.available
        ? cap.push_topic_supported
          ? 'PushTopic'
          : cap.cdc_supported
            ? 'CDC'
            : 'Reconciler-only'
        : 'Unavailable';
      return `
        <tr class="connections-engagement-rel-row" data-entity="${e(rel.entity)}">
          <td><strong>${e(rel.entity)}</strong></td>
          <td><span class="connections-engagement-cap-tag">${e(status)}</span></td>
          <td>${cap.last_probe_error ? `<span class="connections-engagement-error">${e(cap.last_probe_error.slice(0, 80))}${cap.last_probe_error.length > 80 ? '…' : ''}</span>` : '<span class="connections-engagement-ok">OK</span>'}</td>
        </tr>
      `;
    })
    .join('');
  return `
    <div class="connections-engagement-relationships">
      <h5 class="connections-engagement-rel-title">Relationship objects</h5>
      <table class="connections-engagement-table">
        <thead>
          <tr><th>Object</th><th>Streaming</th><th>Status</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
};

const renderPushTopicCreationStatus = (
  reprobe: ReprobeEngagementCapabilitiesResponse | null | undefined,
): string => {
  if (!reprobe || reprobe.pushtopic_creation.length === 0) return '';
  const rows = reprobe.pushtopic_creation
    .map((p) => {
      const tone =
        p.outcome === 'created'
          ? 'connections-engagement-pt-created'
          : p.outcome === 'preserved'
            ? 'connections-engagement-pt-preserved'
            : 'connections-engagement-pt-failed';
      const label =
        p.outcome === 'created' ? 'Created' : p.outcome === 'preserved' ? 'Preserved' : 'Failed';
      const errorBlock = p.error
        ? `<span class="connections-engagement-error">${e(p.error.slice(0, 80))}${p.error.length > 80 ? '…' : ''}</span>`
        : '';
      return `
        <tr class="connections-engagement-pt-row" data-entity="${e(p.entity)}">
          <td><strong>${e(p.entity)}</strong></td>
          <td><span class="connections-engagement-pt-status ${tone}">${e(label)}</span></td>
          <td>${errorBlock}</td>
        </tr>
      `;
    })
    .join('');
  return `
    <div class="connections-engagement-pushtopic">
      <h5 class="connections-engagement-rel-title">PushTopic auto-creation (last re-probe)</h5>
      <table class="connections-engagement-table">
        <thead>
          <tr><th>Object</th><th>Outcome</th><th>Detail</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
};

/** Render the engagement-health detail panel for one connection.
 *  Returns the empty string when `data` is null AND not loading — the
 *  host should call the rpc to hydrate before rendering. */
export const renderEngagementHealthPanel = (
  props: EngagementHealthPanelProps,
): string => {
  if (props.loading && !props.data) {
    return `
      <div class="connections-engagement-panel" data-conn-name="${e(props.connectionName)}">
        <p class="connections-engagement-loading">Loading engagement health…</p>
      </div>
    `;
  }
  if (props.error && !props.data) {
    return `
      <div class="connections-engagement-panel" data-conn-name="${e(props.connectionName)}">
        ${inlineError(props.error)}
      </div>
    `;
  }
  if (!props.data) {
    // No data, no loading, no error — host hasn't asked for the rpc yet.
    return '';
  }
  const { data } = props;
  const callout = renderHubSpotCallout(data.vendor, props.connectionName);
  return `
    <div class="connections-engagement-panel" data-conn-name="${e(props.connectionName)}" data-vendor="${e(data.vendor)}">
      ${renderHeader(data.vendor, data)}
      ${callout}
      ${props.error ? inlineError(props.error) : ''}
      ${renderTable(data)}
      ${renderRelationshipsPanel(data)}
      ${renderPushTopicCreationStatus(props.lastReprobe ?? null)}
      ${renderActions(props, data.vendor)}
      ${props.reprobing ? inlineHint('Re-probing Salesforce capabilities — this may take a few seconds.') : ''}
    </div>
  `;
};

/** Self-contained CSS for the engagement-health panel. No ancestor
 *  coupling — every selector targets `.connections-engagement-*`
 *  directly. */
export const ENGAGEMENT_HEALTH_PANEL_STYLES = `
.connections-engagement-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px;
  margin-top: 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface-sunk);
}
.connections-engagement-loading {
  font-size: 12px;
  color: var(--fg-muted);
  margin: 0;
}
.connections-engagement-header {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.connections-engagement-title {
  font-size: 13px;
  font-weight: 600;
  margin: 0;
}
.connections-engagement-subtitle {
  font-size: 11px;
  color: var(--fg-muted);
  margin: 0;
}
.connections-engagement-callout {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 12px;
  border-radius: 4px;
  border-left: 3px solid var(--accent, var(--border));
  background: var(--surface);
  font-size: 12px;
  color: var(--fg);
}
.connections-engagement-callout--hubspot strong {
  margin-right: 6px;
}
.connections-engagement-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.connections-engagement-table th {
  text-align: left;
  font-weight: 600;
  color: var(--fg-muted);
  padding: 4px 8px;
  border-bottom: 1px solid var(--border);
  font-size: 11px;
  text-transform: uppercase;
}
.connections-engagement-table td {
  padding: 6px 8px;
  border-bottom: 1px solid var(--border);
  vertical-align: top;
}
.connections-engagement-cell-entity strong {
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 12px;
}
.connections-engagement-error {
  color: var(--danger);
  font-size: 11px;
}
.connections-engagement-ok {
  color: var(--fg);
  font-size: 11px;
}
.connections-engagement-cap-tag {
  display: inline-block;
  font-size: 10px;
  padding: 2px 4px;
  margin-right: 4px;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: var(--surface);
  color: var(--fg-muted);
}
.connections-engagement-cap-none {
  font-size: 11px;
  color: var(--fg-muted);
}
.connections-engagement-budget-pct {
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 11px;
}
.connections-engagement-budget-degraded_30m {
  color: var(--fg);
}
.connections-engagement-budget-degraded_1h {
  color: var(--fg);
  font-weight: 600;
}
.connections-engagement-budget-suspended {
  color: var(--danger);
  font-weight: 600;
}
.connections-engagement-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  align-items: center;
}
.connections-engagement-relationships,
.connections-engagement-pushtopic {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 4px;
}
.connections-engagement-rel-title {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  color: var(--fg-muted);
  margin: 0;
}
.connections-engagement-pt-status {
  display: inline-block;
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 3px;
  font-weight: 600;
}
.connections-engagement-pt-created {
  color: var(--fg);
  border: 1px solid var(--border-strong);
}
.connections-engagement-pt-preserved {
  color: var(--fg-muted);
  border: 1px solid var(--border);
}
.connections-engagement-pt-failed {
  color: var(--danger);
  border: 1px solid var(--danger);
}
`;
