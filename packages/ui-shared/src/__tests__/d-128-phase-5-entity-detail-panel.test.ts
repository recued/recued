/** D-128 Phase 5 — Memory-tab entity-detail panel render tests.
 *
 *  Pure-render coverage:
 *    - Header: registered vendor entity → "About this <display_name>";
 *      unregistered scope → scope-only fallback header.
 *    - Meta card (registered): renders meta_fields with type-aware
 *      formatting (`date_ms` → ISO date, `string[]` → comma list,
 *      missing → '—'); honours dotted keys (`key_dates.close_date`).
 *    - Meta card (unregistered + meta present): raw key/value list +
 *      install-pack hint.
 *    - Meta card (null snapshot): "snapshot pending" copy.
 *    - Enrichments section: empty + populated + score / confidence /
 *      array shapes summarize correctly; stale + model badges fire.
 *    - Timeline section: per-source label + relative time; empty
 *      state copy.
 *    - XSS defense: target_id with `<script>` payload escapes through.
 *    - Helpers: `pickFreshestMetaSnapshot`, `collapseToFreshestPerTopic`,
 *      `formatMetaFieldValue`, `summarizeEnrichmentValue`.
 *
 *  Spec: docs/d-128-spec.md §A.4 + Phase 5. */

import { describe, expect, it } from 'vitest';
import {
  collapseToFreshestPerTopic,
  formatMetaFieldValue,
  pickFreshestMetaSnapshot,
  renderEntityDetailPanel,
  summarizeEnrichmentValue,
  type EnrichmentSummary,
} from '../memory/index.js';
import type {
  ConnectionVendorEntity,
  EnrichmentMeta,
  TimelineEntry,
} from '@recued/contracts';

const NOW = 1_700_000_000_000;

// ────────────────────────────────────────────────────────────────
// Test fixtures — minimal HubSpot deal vendor entity
// ────────────────────────────────────────────────────────────────

const HUBSPOT_DEAL_ENTITY: ConnectionVendorEntity = {
  vendor: 'hubspot',
  entity: 'deal',
  scope: 'connection.api.hubspot.deal',
  display_name: 'HubSpot Deal',
  meta_fields: [
    { key: 'name', type: 'string', description: 'Deal name as shown in HubSpot.' },
    { key: 'status', type: 'string', description: 'Pipeline stage (e.g. negotiation).' },
    { key: 'amount', type: 'number', description: 'Deal amount in USD.' },
    { key: 'tags', type: 'string[]', description: 'Free-form tags applied to the deal.' },
    {
      key: 'key_dates.close_date',
      type: 'date_ms',
      description: 'Expected close date.',
    },
  ],
};

const SAMPLE_META: EnrichmentMeta = {
  snapshot_at: 1_695_000_000_000,
  snapshot_hash: 'fnv1a:abc123',
  name: 'Acme Q3 Expansion',
  status: 'negotiation',
  amount: 50_000,
  tags: ['enterprise', 'expansion'],
  key_dates: { close_date: 1_735_689_600_000 },
};

const baseDealHealth: EnrichmentSummary = {
  topic: 'deal_health_score',
  value: { score: 78, confidence: 0.82, signals: ['recent_activity'] },
  authored_by: 'system.housekeeping.deal_health_score',
  authored_at: NOW - 30 * 60_000, // 30m ago
  staleness_class: 'fresh',
  ingredient_slug: 'ai-score',
  model_id: 'gpt-4o-mini',
  display_name: 'Deal health score',
  description:
    'AI-derived 0-100 health signal per CRM deal — synthesises stage, age, recent activity.',
};

// ────────────────────────────────────────────────────────────────
// Header
// ────────────────────────────────────────────────────────────────

describe('D-128 P5 — entity-detail panel header', () => {
  it('renders "About this <display_name>" when vendor entity is registered', () => {
    const html = renderEntityDetailPanel({
      scope: 'connection.api.hubspot.deal',
      target_id: 'hubspot_deal_47291',
      vendorEntity: HUBSPOT_DEAL_ENTITY,
      metaSnapshot: SAMPLE_META,
      enrichments: [baseDealHealth],
      timelineEntries: [],
      now: NOW,
    });
    expect(html).toContain('About this HubSpot Deal');
    expect(html).toContain('hubspot_deal_47291');
    expect(html).toContain('connection.api.hubspot.deal');
  });

  it('falls back to a target-id-only header when no vendor entity is registered', () => {
    const html = renderEntityDetailPanel({
      scope: 'connection.api.unknown.thing',
      target_id: 'unk-1',
      vendorEntity: null,
      metaSnapshot: null,
      enrichments: [],
      timelineEntries: [],
      now: NOW,
    });
    expect(html).toContain('memory-entity-detail-header--unregistered');
    expect(html).toContain('About <code>unk-1</code>');
    expect(html).not.toContain('About this');
  });
});

// ────────────────────────────────────────────────────────────────
// Meta card
// ────────────────────────────────────────────────────────────────

describe('D-128 P5 — meta card (registered entity)', () => {
  it('renders meta_fields with type-aware formatting', () => {
    const html = renderEntityDetailPanel({
      scope: 'connection.api.hubspot.deal',
      target_id: 'hubspot_deal_47291',
      vendorEntity: HUBSPOT_DEAL_ENTITY,
      metaSnapshot: SAMPLE_META,
      enrichments: [],
      timelineEntries: [],
      now: NOW,
    });
    expect(html).toContain('Acme Q3 Expansion');
    expect(html).toContain('negotiation');
    expect(html).toContain('50000');
    // string[] → comma list
    expect(html).toContain('enterprise, expansion');
    // date_ms → ISO date
    expect(html).toContain('2025-01-01');
  });

  it('walks dotted meta_field keys (key_dates.close_date)', () => {
    const html = renderEntityDetailPanel({
      scope: 'connection.api.hubspot.deal',
      target_id: 'd1',
      vendorEntity: HUBSPOT_DEAL_ENTITY,
      metaSnapshot: SAMPLE_META,
      enrichments: [],
      timelineEntries: [],
      now: NOW,
    });
    expect(html).toContain('key_dates.close_date');
    // Date renders as ISO YYYY-MM-DD
    expect(html).toContain('2025-01-01');
  });

  it('renders missing meta_field values as em-dash', () => {
    const sparseMeta: EnrichmentMeta = {
      snapshot_at: 1_695_000_000_000,
      snapshot_hash: 'fnv1a:sparse',
      name: 'Just a name',
      // status / amount / tags / key_dates intentionally absent
    };
    const html = renderEntityDetailPanel({
      scope: 'connection.api.hubspot.deal',
      target_id: 'd1',
      vendorEntity: HUBSPOT_DEAL_ENTITY,
      metaSnapshot: sparseMeta,
      enrichments: [],
      timelineEntries: [],
      now: NOW,
    });
    // Each missing field should render an em-dash in its dd slot.
    const dashCount = (html.match(/<dd[^>]*>—<\/dd>/g) ?? []).length;
    expect(dashCount).toBeGreaterThanOrEqual(4);
  });

  it('renders "snapshot pending" copy when metaSnapshot is null', () => {
    const html = renderEntityDetailPanel({
      scope: 'connection.api.hubspot.deal',
      target_id: 'd1',
      vendorEntity: HUBSPOT_DEAL_ENTITY,
      metaSnapshot: null,
      enrichments: [],
      timelineEntries: [],
      now: NOW,
    });
    expect(html).toContain('Snapshot pending');
  });
});

describe('D-128 P5 — meta card (unregistered fallback)', () => {
  it('emits the install-pack hint for the scope', () => {
    const html = renderEntityDetailPanel({
      scope: 'connection.api.unknown.thing',
      target_id: 'unk-1',
      vendorEntity: null,
      metaSnapshot: null,
      enrichments: [],
      timelineEntries: [],
      now: NOW,
    });
    expect(html).toContain('No vendor-entity registry entry');
    expect(html).toContain('connection.api.unknown.thing');
  });

  it('renders raw key/value list when meta is present without a registry entry', () => {
    const html = renderEntityDetailPanel({
      scope: 'connection.api.unknown.thing',
      target_id: 'unk-1',
      vendorEntity: null,
      metaSnapshot: SAMPLE_META,
      enrichments: [],
      timelineEntries: [],
      now: NOW,
    });
    expect(html).toContain('memory-entity-detail-meta-list--raw');
    expect(html).toContain('Acme Q3 Expansion');
    // Bistemporal stamping fields excluded from the raw render.
    expect(html).not.toContain('snapshot_hash');
  });
});

// ────────────────────────────────────────────────────────────────
// Enrichments section
// ────────────────────────────────────────────────────────────────

describe('D-128 P5 — enrichments section', () => {
  it('renders one card per topic with summary + author + relative time', () => {
    const html = renderEntityDetailPanel({
      scope: 'connection.api.hubspot.deal',
      target_id: 'd1',
      vendorEntity: HUBSPOT_DEAL_ENTITY,
      metaSnapshot: SAMPLE_META,
      enrichments: [baseDealHealth],
      timelineEntries: [],
      now: NOW,
    });
    expect(html).toContain('data-topic="deal_health_score"');
    expect(html).toContain('Deal health score');
    expect(html).toContain('score 78');
    expect(html).toContain('system.housekeeping.deal_health_score');
    expect(html).toContain('30m ago');
  });

  it('renders the stale badge when staleness_class === "stale"', () => {
    const html = renderEntityDetailPanel({
      scope: 'connection.api.hubspot.deal',
      target_id: 'd1',
      vendorEntity: HUBSPOT_DEAL_ENTITY,
      metaSnapshot: SAMPLE_META,
      enrichments: [{ ...baseDealHealth, staleness_class: 'stale' }],
      timelineEntries: [],
      now: NOW,
    });
    expect(html).toContain('memory-enrichment-card-badge--stale');
    expect(html).toContain('stale');
  });

  it('renders the model badge for AI-surface producers', () => {
    const html = renderEntityDetailPanel({
      scope: 'connection.api.hubspot.deal',
      target_id: 'd1',
      vendorEntity: HUBSPOT_DEAL_ENTITY,
      metaSnapshot: SAMPLE_META,
      enrichments: [baseDealHealth],
      timelineEntries: [],
      now: NOW,
    });
    expect(html).toContain('memory-enrichment-card-badge--model');
    expect(html).toContain('gpt-4o-mini');
  });

  it('hides the model badge for deterministic producers (ingredient_slug + model_id both null)', () => {
    const deterministic: EnrichmentSummary = {
      ...baseDealHealth,
      ingredient_slug: null,
      model_id: null,
      topic: 'deal_velocity_signal',
      value: { velocity: 'stalling', recent_activity_count: 0, days_in_stage: 45 },
    };
    const html = renderEntityDetailPanel({
      scope: 'connection.api.hubspot.deal',
      target_id: 'd1',
      vendorEntity: HUBSPOT_DEAL_ENTITY,
      metaSnapshot: SAMPLE_META,
      enrichments: [deterministic],
      timelineEntries: [],
      now: NOW,
    });
    expect(html).not.toContain('memory-enrichment-card-badge--model');
  });

  it('shows the empty state when no enrichments exist', () => {
    const html = renderEntityDetailPanel({
      scope: 'connection.api.hubspot.deal',
      target_id: 'd1',
      vendorEntity: HUBSPOT_DEAL_ENTITY,
      metaSnapshot: SAMPLE_META,
      enrichments: [],
      timelineEntries: [],
      now: NOW,
    });
    expect(html).toContain('No enrichments yet.');
  });
});

// ────────────────────────────────────────────────────────────────
// Timeline section
// ────────────────────────────────────────────────────────────────

describe('D-128 P5 — timeline section', () => {
  it('renders one entry per timeline event with source + kind + relative time', () => {
    const entry: TimelineEntry = {
      ts: NOW - 2 * 60_000, // 2m ago
      source: 'enrichment',
      kind: 'deal_health_score',
      payload: {},
      recipe_slug: 'system.housekeeping.deal_health_score',
    };
    const html = renderEntityDetailPanel({
      scope: 'connection.api.hubspot.deal',
      target_id: 'd1',
      vendorEntity: HUBSPOT_DEAL_ENTITY,
      metaSnapshot: SAMPLE_META,
      enrichments: [],
      timelineEntries: [entry],
      now: NOW,
    });
    expect(html).toContain('data-source="enrichment"');
    expect(html).toContain('data-kind="deal_health_score"');
    expect(html).toContain('2m ago');
    expect(html).toContain('system.housekeeping.deal_health_score');
  });

  it('shows the empty state when no timeline events exist', () => {
    const html = renderEntityDetailPanel({
      scope: 'connection.api.hubspot.deal',
      target_id: 'd1',
      vendorEntity: HUBSPOT_DEAL_ENTITY,
      metaSnapshot: SAMPLE_META,
      enrichments: [],
      timelineEntries: [],
      now: NOW,
    });
    expect(html).toContain('No timeline events yet.');
  });
});

// ────────────────────────────────────────────────────────────────
// Host-supplied timeline props (run link + payload summary) + meta gate
// ────────────────────────────────────────────────────────────────

describe('entity-detail panel — host timeline props + meta gate', () => {
  const mailEntry: TimelineEntry = {
    ts: NOW - 2 * 60_000,
    source: 'mail',
    kind: 'message',
    payload: { record_id: 'msg-1', subject: 'Launch', run_id: 'run-1' },
  };

  it('renders a run link when runHref returns a href, escaping it', () => {
    const html = renderEntityDetailPanel({
      scope: 'mail',
      target_id: 'msg-1',
      vendorEntity: null,
      metaSnapshot: null,
      enrichments: [],
      timelineEntries: [mailEntry],
      now: NOW,
      runHref: (entry) =>
        (entry.payload as { run_id?: string }).run_id
          ? `#runs?run_id=${(entry.payload as { run_id: string }).run_id}`
          : null,
    });
    expect(html).toContain('memory-timeline-entry-run-link');
    expect(html).toContain('href="#runs?run_id=run-1"');
    expect(html).toContain('Open run');
  });

  it('omits the run link when runHref is absent or returns null', () => {
    const html = renderEntityDetailPanel({
      scope: 'mail',
      target_id: 'msg-1',
      vendorEntity: null,
      metaSnapshot: null,
      enrichments: [],
      timelineEntries: [mailEntry],
      now: NOW,
    });
    expect(html).not.toContain('memory-timeline-entry-run-link');
    expect(html).not.toContain('Open run');
  });

  it('renders an escaped payload summary line when summarizePayload returns text', () => {
    const html = renderEntityDetailPanel({
      scope: 'mail',
      target_id: 'msg-1',
      vendorEntity: null,
      metaSnapshot: null,
      enrichments: [],
      timelineEntries: [mailEntry],
      now: NOW,
      summarizePayload: () => 'Subject: <Launch>',
    });
    expect(html).toContain('memory-timeline-entry-summary');
    expect(html).toContain('Subject: &lt;Launch&gt;');
  });

  it('omits the Snapshot (meta) section when showMetaSection is false', () => {
    const html = renderEntityDetailPanel({
      scope: 'mail',
      target_id: 'msg-1',
      vendorEntity: null,
      metaSnapshot: null,
      enrichments: [],
      timelineEntries: [mailEntry],
      now: NOW,
      showMetaSection: false,
    });
    expect(html).not.toContain('memory-entity-detail-section--meta');
    expect(html).not.toContain('No vendor-entity registry entry');
    // Enrichments + timeline sections still render.
    expect(html).toContain('memory-entity-detail-section--timeline');
  });

  it('keeps the Snapshot section by default (showMetaSection omitted)', () => {
    const html = renderEntityDetailPanel({
      scope: 'connection.api.unknown.thing',
      target_id: 'x1',
      vendorEntity: null,
      metaSnapshot: null,
      enrichments: [],
      timelineEntries: [mailEntry],
      now: NOW,
    });
    expect(html).toContain('memory-entity-detail-section--meta');
  });
});

// ────────────────────────────────────────────────────────────────
// XSS defense
// ────────────────────────────────────────────────────────────────

describe('D-128 P5 — XSS defense', () => {
  it('escapes target_id with a <script> payload', () => {
    const html = renderEntityDetailPanel({
      scope: 'connection.api.hubspot.deal',
      target_id: '<script>alert(1)</script>',
      vendorEntity: HUBSPOT_DEAL_ENTITY,
      metaSnapshot: null,
      enrichments: [],
      timelineEntries: [],
      now: NOW,
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('escapes meta values when rendered through the registered card', () => {
    const html = renderEntityDetailPanel({
      scope: 'connection.api.hubspot.deal',
      target_id: 'd1',
      vendorEntity: HUBSPOT_DEAL_ENTITY,
      metaSnapshot: {
        snapshot_at: 1_695_000_000_000,
        snapshot_hash: 'fnv1a:xss',
        name: '<img src=x onerror=alert(1)>',
      } as EnrichmentMeta,
      enrichments: [],
      timelineEntries: [],
      now: NOW,
    });
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).toContain('&lt;img');
  });
});

// ────────────────────────────────────────────────────────────────
// Helpers — formatMetaFieldValue
// ────────────────────────────────────────────────────────────────

describe('D-128 P5 — formatMetaFieldValue', () => {
  it("formats a date_ms field as an ISO date (YYYY-MM-DD)", () => {
    expect(
      formatMetaFieldValue(
        { key: 'd', type: 'date_ms', description: '' },
        1_735_689_600_000,
      ),
    ).toBe('2025-01-01');
  });

  it('joins string[] with comma + space', () => {
    expect(
      formatMetaFieldValue(
        { key: 't', type: 'string[]', description: '' },
        ['a', 'b'],
      ),
    ).toBe('a, b');
  });

  it("returns '—' on undefined / null / wrong-type values", () => {
    expect(
      formatMetaFieldValue(
        { key: 'a', type: 'number', description: '' },
        undefined,
      ),
    ).toBe('—');
    expect(
      formatMetaFieldValue(
        { key: 'a', type: 'number', description: '' },
        null,
      ),
    ).toBe('—');
    expect(
      formatMetaFieldValue(
        { key: 'a', type: 'number', description: '' },
        'not-a-number',
      ),
    ).toBe('—');
  });
});

// ────────────────────────────────────────────────────────────────
// Helpers — summarizeEnrichmentValue
// ────────────────────────────────────────────────────────────────

describe('D-128 P5 — summarizeEnrichmentValue', () => {
  it('renders score-shaped values as "score N"', () => {
    expect(summarizeEnrichmentValue({ score: 78 })).toBe('score 78');
  });

  it('renders confidence-shaped values as "confidence N%"', () => {
    expect(summarizeEnrichmentValue({ confidence: 0.82 })).toBe('confidence 82%');
  });

  it('renders array values as item counts', () => {
    expect(summarizeEnrichmentValue([1, 2, 3])).toBe('3 items');
    expect(summarizeEnrichmentValue([])).toBe('0 items');
    expect(summarizeEnrichmentValue([1])).toBe('1 item');
  });

  it('renders objects without numeric primary fields as key list with overflow', () => {
    expect(
      summarizeEnrichmentValue({ a: 1, b: 2, c: 3, d: 4 }),
    ).toBe('a, b, c, +1 more');
  });

  it("returns '—' for null / undefined", () => {
    expect(summarizeEnrichmentValue(null)).toBe('—');
    expect(summarizeEnrichmentValue(undefined)).toBe('—');
  });
});

// ────────────────────────────────────────────────────────────────
// Helpers — collapseToFreshestPerTopic
// ────────────────────────────────────────────────────────────────

describe('D-128 P5 — collapseToFreshestPerTopic', () => {
  it('keeps the freshest row per topic', () => {
    const rows = [
      { topic: 'a', authored_at: 100 },
      { topic: 'a', authored_at: 200 },
      { topic: 'b', authored_at: 50 },
    ];
    const collapsed = collapseToFreshestPerTopic(rows);
    expect(collapsed).toHaveLength(2);
    expect(collapsed.find((r) => r.topic === 'a')?.authored_at).toBe(200);
    expect(collapsed.find((r) => r.topic === 'b')?.authored_at).toBe(50);
  });

  it('returns an empty array when given empty input', () => {
    expect(collapseToFreshestPerTopic([])).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────
// Helpers — pickFreshestMetaSnapshot
// ────────────────────────────────────────────────────────────────

describe('D-128 P5 — pickFreshestMetaSnapshot', () => {
  it('returns the meta with the highest snapshot_at', () => {
    const result = pickFreshestMetaSnapshot([
      {
        meta: {
          snapshot_at: 100,
          snapshot_hash: 'a',
          name: 'old',
        },
        ingested_at: 50,
      },
      {
        meta: {
          snapshot_at: 200,
          snapshot_hash: 'b',
          name: 'new',
        },
        ingested_at: 60,
      },
    ]);
    expect(result?.name).toBe('new');
  });

  it('returns null when every row has null meta', () => {
    expect(
      pickFreshestMetaSnapshot([
        { meta: null, ingested_at: 100 },
        { meta: null, ingested_at: 200 },
      ]),
    ).toBeNull();
  });

  it('returns null on empty input', () => {
    expect(pickFreshestMetaSnapshot([])).toBeNull();
  });

  it('falls back to ingested_at when snapshot_at is missing', () => {
    // snapshot_at is required in the type but the helper tolerates
    // missing values via nullish-coalesce — defense against misshapen
    // rows from a future schema drift.
    const result = pickFreshestMetaSnapshot([
      {
        meta: { snapshot_hash: 'a' } as EnrichmentMeta,
        ingested_at: 100,
      },
      {
        meta: { snapshot_hash: 'b' } as EnrichmentMeta,
        ingested_at: 200,
      },
    ]);
    expect(result?.snapshot_hash).toBe('b');
  });
});
