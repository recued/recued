/** D-139 P2 — Connection-page UX panel render tests.
 *
 *  Pure-render coverage: per-entity health table, "No public URL?"
 *  callout (HubSpot only), action affordances (Install scheduled
 *  puller / Re-probe), capability tags (Salesforce only), expand /
 *  collapse routing through `engagementHealth.expanded`.
 *
 *  Spec: D-139 § A.8 + § P2 acceptance. */

import { describe, expect, it } from 'vitest';
import type {
  EngagementHealthResponse,
  ConnectionView,
} from '@recued/contracts';
import {
  renderConnectionsPage,
  initialConnectionsPageState,
  renderEngagementHealthPanel,
} from '../connections/index.js';
import type { ConnectionsPageState } from '../connections/state.js';

// ────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────

const FIXED_NOW = 1_714_867_200_000;

const hubspotConn: ConnectionView = {
  name: 'acme-hubspot',
  kind: 'api',
  display_name: 'Acme HubSpot',
  vendor: 'hubspot',
  base_url: 'https://api.hubapi.com',
};

const salesforceConn: ConnectionView = {
  name: 'acme-salesforce',
  kind: 'api',
  display_name: 'Acme Salesforce',
  vendor: 'salesforce',
  base_url: 'https://acme.my.salesforce.com',
};

const stripeConn: ConnectionView = {
  name: 'stripe',
  kind: 'api',
  display_name: 'Stripe',
  base_url: 'https://api.stripe.com',
};

const baseState = (
  overrides?: Partial<ConnectionsPageState>,
): ConnectionsPageState => ({
  ...initialConnectionsPageState(),
  connections: [hubspotConn, salesforceConn, stripeConn],
  ...(overrides ?? {}),
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
      pages_fetched_today: 12,
      api_calls_consumed_today: 240,
      budget_utilization_pct: 0.001,
      rate_control_state: 'normal',
    },
    {
      vendor: 'hubspot',
      entity: 'meeting',
      last_pulled_at: null,
      last_error: 'rate-limited',
      pages_fetched_today: 0,
      api_calls_consumed_today: 240,
      budget_utilization_pct: 0.001,
      rate_control_state: 'normal',
    },
    {
      vendor: 'hubspot',
      entity: 'note',
      last_pulled_at: FIXED_NOW - 3_600_000,
      last_error: null,
      pages_fetched_today: 0,
      api_calls_consumed_today: 240,
      budget_utilization_pct: 0.001,
      rate_control_state: 'normal',
    },
    {
      vendor: 'hubspot',
      entity: 'call',
      last_pulled_at: FIXED_NOW - 86_400_000,
      last_error: null,
      pages_fetched_today: 0,
      api_calls_consumed_today: 240,
      budget_utilization_pct: 0.001,
      rate_control_state: 'normal',
    },
    {
      vendor: 'hubspot',
      entity: 'task',
      last_pulled_at: null,
      last_error: null,
      pages_fetched_today: 0,
      api_calls_consumed_today: 240,
      budget_utilization_pct: 0.001,
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
      pages_fetched_today: 4,
      api_calls_consumed_today: 96,
      budget_utilization_pct: 0.00192,
      rate_control_state: 'normal',
      capability: {
        connection_id: 'api:acme-salesforce',
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
    {
      vendor: 'salesforce',
      entity: 'event',
      last_pulled_at: FIXED_NOW - 600_000,
      last_error: null,
      pages_fetched_today: 1,
      api_calls_consumed_today: 96,
      budget_utilization_pct: 0.00192,
      rate_control_state: 'normal',
      capability: {
        connection_id: 'api:acme-salesforce',
        vendor: 'salesforce',
        entity: 'event',
        available: true,
        cdc_supported: false,
        push_topic_supported: true,
        reconciler_only: false,
        association_rescan_required: false,
        last_probed_at: FIXED_NOW,
      },
    },
    {
      vendor: 'salesforce',
      entity: 'email_message',
      last_pulled_at: null,
      last_error: null,
      pages_fetched_today: 0,
      api_calls_consumed_today: 96,
      budget_utilization_pct: 0.00192,
      rate_control_state: 'normal',
    },
  ],
});

// ────────────────────────────────────────────────────────────────
// Row-level affordance
// ────────────────────────────────────────────────────────────────

describe('D-139 P2 — engagement-health row affordance', () => {
  it('renders Engagement health button on HubSpot rows', () => {
    const html = renderConnectionsPage(baseState());
    expect(html).toContain('data-action="connections-engagement-toggle"');
    expect(html).toContain('Engagement health');
  });

  it('renders Engagement health button on Salesforce rows', () => {
    const html = renderConnectionsPage(baseState({ connections: [salesforceConn] }));
    expect(html).toContain('data-action="connections-engagement-toggle"');
  });

  it('omits Engagement health button on non-vendor api rows (Stripe)', () => {
    const html = renderConnectionsPage(baseState({ connections: [stripeConn] }));
    expect(html).not.toContain('connections-engagement-toggle');
  });

  it('omits Engagement health button on mcp / notification rows', () => {
    const mcpConn: ConnectionView = {
      name: 'gh-mcp',
      kind: 'mcp',
      subtype: 'sse',
      display_name: 'GH MCP',
      endpoint: 'https://mcp.github.com/sse',
    };
    const notifConn: ConnectionView = {
      name: 'team-slack',
      kind: 'notification',
      subtype: 'slack',
      display_name: 'Slack',
      channel_id: 'C0123',
    };
    const html = renderConnectionsPage(baseState({ connections: [mcpConn, notifConn] }));
    expect(html).not.toContain('connections-engagement-toggle');
  });

  it('D-192 S5 — renders the button for a PACK vendor via the server stamp (built-in read would miss it)', () => {
    // `dynamics` isn't a built-in engagement vendor, so the fallback
    // `vendorHasEngagement('dynamics')` is false — only the server-stamped
    // `supports_engagement_health: true` (from the live merged registry) lights it up.
    const dynamicsConn: ConnectionView = {
      name: 'acme-dynamics',
      kind: 'api',
      display_name: 'Acme Dynamics',
      vendor: 'dynamics',
      base_url: 'https://acme.crm.dynamics.com',
      supports_engagement_health: true,
    };
    const html = renderConnectionsPage(baseState({ connections: [dynamicsConn] }));
    expect(html).toContain('data-action="connections-engagement-toggle"');
  });

  it('D-192 S5 — a server stamp of false is authoritative over the built-in fallback', () => {
    // Vendor reads as engagement-capable in the built-in registry (hubspot), but
    // the server explicitly stamped false → the toggle is omitted (stamp wins).
    const stampedOffConn: ConnectionView = {
      ...hubspotConn,
      supports_engagement_health: false,
    };
    const html = renderConnectionsPage(baseState({ connections: [stampedOffConn] }));
    expect(html).not.toContain('connections-engagement-toggle');
  });

  it('renders Hide health label when row is expanded', () => {
    const html = renderConnectionsPage(
      baseState({
        engagementHealth: {
          ...initialConnectionsPageState().engagementHealth,
          expanded: new Set(['api/acme-hubspot']),
          data: { 'api/acme-hubspot': hubspotHealth() },
        },
      }),
    );
    expect(html).toContain('Hide health');
  });
});

// ────────────────────────────────────────────────────────────────
// Panel content
// ────────────────────────────────────────────────────────────────

describe('D-139 P2 — engagement-health panel render', () => {
  it('renders 5 rows for HubSpot — one per engagement entity', () => {
    const html = renderEngagementHealthPanel({
      connectionName: 'acme-hubspot',
      loading: false,
      error: null,
      reprobing: false,
      installing: false,
      data: hubspotHealth(),
    });
    expect(html).toContain('data-entity="email"');
    expect(html).toContain('data-entity="meeting"');
    expect(html).toContain('data-entity="note"');
    expect(html).toContain('data-entity="call"');
    expect(html).toContain('data-entity="task"');
  });

  it('renders the "No public URL?" callout for HubSpot panels', () => {
    const html = renderEngagementHealthPanel({
      connectionName: 'acme-hubspot',
      loading: false,
      error: null,
      reprobing: false,
      installing: false,
      data: hubspotHealth(),
    });
    expect(html).toContain('No public URL?');
    expect(html).toContain('connections-engagement-callout--hubspot');
  });

  it('omits the "No public URL?" callout for Salesforce panels', () => {
    const html = renderEngagementHealthPanel({
      connectionName: 'acme-salesforce',
      loading: false,
      error: null,
      reprobing: false,
      installing: false,
      data: salesforceHealth(),
    });
    expect(html).not.toContain('No public URL?');
    expect(html).not.toContain('connections-engagement-callout--hubspot');
  });

  it('renders Install scheduled puller affordance for both vendors', () => {
    const hubspot = renderEngagementHealthPanel({
      connectionName: 'acme-hubspot',
      loading: false,
      error: null,
      reprobing: false,
      installing: false,
      data: hubspotHealth(),
    });
    const salesforce = renderEngagementHealthPanel({
      connectionName: 'acme-salesforce',
      loading: false,
      error: null,
      reprobing: false,
      installing: false,
      data: salesforceHealth(),
    });
    expect(hubspot).toContain('data-action="connections-engagement-install-puller"');
    expect(hubspot).toContain('Install scheduled puller recipe');
    expect(salesforce).toContain('data-action="connections-engagement-install-puller"');
  });

  it('renders Re-probe button only on Salesforce panels', () => {
    const hubspot = renderEngagementHealthPanel({
      connectionName: 'acme-hubspot',
      loading: false,
      error: null,
      reprobing: false,
      installing: false,
      data: hubspotHealth(),
    });
    const salesforce = renderEngagementHealthPanel({
      connectionName: 'acme-salesforce',
      loading: false,
      error: null,
      reprobing: false,
      installing: false,
      data: salesforceHealth(),
    });
    expect(hubspot).not.toContain('connections-engagement-reprobe');
    expect(salesforce).toContain('data-action="connections-engagement-reprobe"');
    expect(salesforce).toContain('Re-probe capabilities');
  });

  it('renders capability tags on Salesforce rows that carry capability flags', () => {
    const html = renderEngagementHealthPanel({
      connectionName: 'acme-salesforce',
      loading: false,
      error: null,
      reprobing: false,
      installing: false,
      data: salesforceHealth(),
    });
    expect(html).toContain('CDC');
    expect(html).toContain('PushTopic');
    // email_message row has no capability — placeholder dash
    expect(html).toContain('connections-engagement-cap-none');
  });

  it('renders error inline when row has last_error', () => {
    const html = renderEngagementHealthPanel({
      connectionName: 'acme-hubspot',
      loading: false,
      error: null,
      reprobing: false,
      installing: false,
      data: hubspotHealth(),
    });
    expect(html).toContain('rate-limited');
  });

  it('renders Never for entities with last_pulled_at null', () => {
    const html = renderEngagementHealthPanel({
      connectionName: 'acme-hubspot',
      loading: false,
      error: null,
      reprobing: false,
      installing: false,
      data: hubspotHealth(),
    });
    expect(html).toContain('Never');
  });

  it('renders Loading state when loading and no data yet', () => {
    const html = renderEngagementHealthPanel({
      connectionName: 'acme-hubspot',
      loading: true,
      error: null,
      reprobing: false,
      installing: false,
      data: null,
    });
    expect(html).toContain('Loading engagement health');
  });

  it('renders error state when error and no data', () => {
    const html = renderEngagementHealthPanel({
      connectionName: 'acme-hubspot',
      loading: false,
      error: 'rpc failed',
      reprobing: false,
      installing: false,
      data: null,
    });
    expect(html).toContain('rpc failed');
  });

  it('renders empty string when no data, no loading, no error', () => {
    const html = renderEngagementHealthPanel({
      connectionName: 'acme-hubspot',
      loading: false,
      error: null,
      reprobing: false,
      installing: false,
      data: null,
    });
    expect(html).toBe('');
  });

  it('disables Install button while installing', () => {
    const html = renderEngagementHealthPanel({
      connectionName: 'acme-hubspot',
      loading: false,
      error: null,
      reprobing: false,
      installing: true,
      data: hubspotHealth(),
    });
    expect(html).toContain('Installing…');
    // Disabled attribute present
    expect(html).toMatch(/data-action="connections-engagement-install-puller"[^>]+disabled/);
  });

  it('disables Re-probe button + flips label while reprobing', () => {
    const html = renderEngagementHealthPanel({
      connectionName: 'acme-salesforce',
      loading: false,
      error: null,
      reprobing: true,
      installing: false,
      data: salesforceHealth(),
    });
    expect(html).toContain('Re-probing…');
    expect(html).toContain('this may take a few seconds');
  });

  it('formats budget pct as percentage string', () => {
    const html = renderEngagementHealthPanel({
      connectionName: 'acme-hubspot',
      loading: false,
      error: null,
      reprobing: false,
      installing: false,
      data: {
        ...hubspotHealth(),
        rows: hubspotHealth().rows.map((r) => ({
          ...r,
          budget_utilization_pct: 0.97,
          rate_control_state: 'degraded_1h',
        })),
      },
    });
    expect(html).toContain('97.0%');
    expect(html).toContain('connections-engagement-budget-degraded_1h');
  });

  it('caps long error strings at 60 chars + …', () => {
    const longError = 'a'.repeat(120);
    const html = renderEngagementHealthPanel({
      connectionName: 'acme-hubspot',
      loading: false,
      error: null,
      reprobing: false,
      installing: false,
      data: {
        ...hubspotHealth(),
        rows: [
          {
            ...hubspotHealth().rows[0]!,
            last_error: longError,
          },
        ],
      },
    });
    // Truncated to 60 chars + … in the visible label. The full string
    // still lives in the title attribute (hover-only), so we check
    // specifically for the rendered `⚠` label form.
    const aRun = 'a'.repeat(60);
    expect(html).toContain(`⚠ ${aRun}…`);
  });
});

// ────────────────────────────────────────────────────────────────
// Codex review fold-back UI tests (P2 #6 + P2 #7)
// ────────────────────────────────────────────────────────────────

describe('D-139 P2 Codex review fold #7 (P2) — relationship-objects panel section', () => {
  it('renders relationship rows on Salesforce panels when relationships are present', () => {
    const html = renderEngagementHealthPanel({
      connectionName: 'acme-salesforce',
      loading: false,
      error: null,
      reprobing: false,
      installing: false,
      data: {
        ...salesforceHealth(),
        relationships: [
          {
            vendor: 'salesforce',
            entity: 'task_relation',
            capability: {
              connection_id: 'api:acme-salesforce',
              vendor: 'salesforce',
              entity: 'task_relation',
              available: true,
              cdc_supported: false,
              push_topic_supported: true,
              reconciler_only: false,
              association_rescan_required: false,
              last_probed_at: FIXED_NOW,
            },
          },
          {
            vendor: 'salesforce',
            entity: 'event_relation',
            capability: {
              connection_id: 'api:acme-salesforce',
              vendor: 'salesforce',
              entity: 'event_relation',
              available: false,
              association_rescan_required: false,
              last_probed_at: FIXED_NOW,
            },
          },
        ],
      },
    });
    expect(html).toContain('connections-engagement-relationships');
    expect(html).toContain('Relationship objects');
    expect(html).toContain('data-entity="task_relation"');
    expect(html).toContain('data-entity="event_relation"');
    expect(html).toContain('PushTopic');
    expect(html).toContain('Unavailable');
  });

  it('omits the relationships panel section when no relationships are present', () => {
    const html = renderEngagementHealthPanel({
      connectionName: 'acme-salesforce',
      loading: false,
      error: null,
      reprobing: false,
      installing: false,
      data: salesforceHealth(),
    });
    expect(html).not.toContain('connections-engagement-relationships');
    expect(html).not.toContain('Relationship objects');
  });
});

describe('D-139 P2 Codex review fold #6 (P2) — PushTopic auto-creation status panel', () => {
  it('renders Created / Preserved / Failed badges per entity from lastReprobe', () => {
    const html = renderEngagementHealthPanel({
      connectionName: 'acme-salesforce',
      loading: false,
      error: null,
      reprobing: false,
      installing: false,
      data: salesforceHealth(),
      lastReprobe: {
        rows: [],
        reprobed_at: FIXED_NOW,
        winning_call_entity: 'voice_call',
        call_entity_changed: true,
        pushtopic_creation: [
          { entity: 'task', outcome: 'preserved' },
          { entity: 'event', outcome: 'created' },
          { entity: 'voice_call', outcome: 'create_failed', error: 'permission denied' },
        ],
      },
    });
    expect(html).toContain('connections-engagement-pushtopic');
    expect(html).toContain('PushTopic auto-creation');
    expect(html).toContain('Preserved');
    expect(html).toContain('Created');
    expect(html).toContain('Failed');
    expect(html).toContain('permission denied');
  });

  it('omits the PushTopic creation panel when lastReprobe is null', () => {
    const html = renderEngagementHealthPanel({
      connectionName: 'acme-salesforce',
      loading: false,
      error: null,
      reprobing: false,
      installing: false,
      data: salesforceHealth(),
      lastReprobe: null,
    });
    expect(html).not.toContain('connections-engagement-pushtopic');
  });

  it('omits the PushTopic creation panel when pushtopic_creation array is empty', () => {
    const html = renderEngagementHealthPanel({
      connectionName: 'acme-salesforce',
      loading: false,
      error: null,
      reprobing: false,
      installing: false,
      data: salesforceHealth(),
      lastReprobe: {
        rows: [],
        reprobed_at: FIXED_NOW,
        winning_call_entity: null,
        call_entity_changed: false,
        pushtopic_creation: [],
      },
    });
    expect(html).not.toContain('connections-engagement-pushtopic');
  });
});
