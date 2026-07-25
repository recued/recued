/** D-139 Phase 1a.1 — engagement substrate tests.
 *
 *  Covers the substrate-side surface of the spec's P1a.1 acceptance:
 *    - Schema bootstrap round-trip + idempotent re-run.
 *    - `EngagementStore.upsert` round-trips every Pass-4 evidence-
 *      quality field; `vendor_modstamp` stale-update drop.
 *    - `engagement_edges` UNIQUE composite tolerates many-to-many.
 *    - Inbound-event ledger dedup behavior (Pass-5 R5.8 — duplicate
 *      returns no-op echoing previous observed_at).
 *    - `resolveContactIdentity` routing at edge emission — a loser
 *      email rewrites to the survivor canonical.
 *    - Resolver identity-expansion + evidence-quality filter
 *      round-trip + `'probable'`-confidence twins surface as separate
 *      rows with `dedupe_candidates` joined.
 *    - `HubSpotEmailEngagementReconciler` derivations: authorship
 *      classification (system_process for tracking-pixel rows),
 *      direction classification per `hs_email_direction`, lifecycle
 *      driven by `hs_email_status` per Pass-5 R5.3.
 *    - Body-state machine transitions (`mail_link` when twin found;
 *      `inline_body` for short bodies; `truncated_inline` for large).
 *    - HubSpot webhook processor idempotency-ledger gating.
 *
 *  Spec: D-139 § A.3, § A.3.2, § A.3.3, § A.3.5,
 *  § A.3.6, § A.3.8, § A.4, § A.5, § A.5.0, § A.5.1, § P1a.1
 *  acceptance. */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import {
  HUBSPOT_EMAIL_PROPERTIES,
  type EngagementRow,
} from '@recued/contracts';

import {
  createEngagementStore,
  ensureEngagementSchema,
  ENGAGEMENT_EDGES_TABLE,
  ENGAGEMENT_INBOUND_EVENT_LEDGER_TABLE,
  ENGAGEMENTS_TABLE,
} from '../storage/engagement-store.js';
import {
  HubSpotEmailEngagementReconciler,
  deriveEmailAuthorship,
  deriveEmailDirection,
  deriveEmailEventAt,
  deriveEmailLifecycleState,
  pickBodyState,
  projectEmailEngagementRow,
} from '../data/hubspot/email-engagement-reconciler.js';
import { buildHubSpotEmailEngagementWebhookProcessor } from '../data/hubspot/email-engagement-webhook-processor.js';
import type { RawHubSpotRecord } from '../data/hubspot/_hubspot-search.js';

// ────────────────────────────────────────────────────────────────
// Test harness
// ────────────────────────────────────────────────────────────────

const inMemoryDb = (): Database.Database => new Database(':memory:');

const baseRow = (overrides: Partial<EngagementRow> = {}): EngagementRow => ({
  connection_id: 'acme-hubspot',
  target_id: 'hubspot_email_47291',
  vendor: 'hubspot',
  entity: 'email',
  meta: { subject: 'Quarterly review' },
  mirror_blob_hash: null,
  authorship: 'user',
  direction: 'outbound',
  dedupe_confidence: 'none',
  lifecycle_state: 'point_in_time',
  event_at: 1_714_867_200_000,
  vendor_created_at: 1_714_867_200_000,
  vendor_modified_at: 1_714_867_200_500,
  ingested_at: 1_714_867_200_600,
  body_state: 'inline_body',
  body_inline: 'Hi Bob — heads up.',
  ...overrides,
});

const rawEmail = (
  overrides: Partial<RawHubSpotRecord['properties']> = {},
  id = '47291',
): RawHubSpotRecord => ({
  id,
  properties: {
    hs_email_subject: 'Quarterly review',
    hs_email_text: 'Hi Bob — heads up: I have one more thing for the deal.',
    hs_email_html: '',
    hs_email_direction: 'EMAIL',
    hs_email_status: 'SENT',
    hs_email_from_email: 'alice@recued.com',
    hs_email_to_email: 'bob@acme.com',
    hs_email_cc_email: '',
    hs_email_internet_message_id: '<msg-1@example.com>',
    hs_email_thread_id: 'thread-1',
    hs_timestamp: '1714867200000',
    hs_lastmodifieddate: '1714867200500',
    hs_createdate: '1714000000000',
    hubspot_owner_id: '777',
    hs_created_by_workflow_id: '',
    hs_created_via_workflow: '',
    hs_email_bounce_error_detail_message: '',
    hs_email_bounce_error_detail_status_code: '',
    hs_import_id: '',
    ...overrides,
  },
});

// ────────────────────────────────────────────────────────────────
// Schema bootstrap
// ────────────────────────────────────────────────────────────────

describe('D-139 P1a.1 — engagement schema bootstrap', () => {
  it('creates engagements + edges + ledger + dedupe-candidates tables', () => {
    const db = inMemoryDb();
    ensureEngagementSchema(db);
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain(ENGAGEMENTS_TABLE);
    expect(names).toContain(ENGAGEMENT_EDGES_TABLE);
    expect(names).toContain(ENGAGEMENT_INBOUND_EVENT_LEDGER_TABLE);
    expect(names).toContain('engagement_dedupe_candidates');
  });
  it('is idempotent on second boot', () => {
    const db = inMemoryDb();
    ensureEngagementSchema(db);
    expect(() => ensureEngagementSchema(db)).not.toThrow();
  });
  it('row table carries every Pass-4 evidence column', () => {
    const db = inMemoryDb();
    ensureEngagementSchema(db);
    const cols = db
      .prepare(`PRAGMA table_info(${ENGAGEMENTS_TABLE})`)
      .all() as Array<{ name: string }>;
    const colNames = new Set(cols.map((c) => c.name));
    expect(colNames.has('authorship')).toBe(true);
    expect(colNames.has('direction')).toBe(true);
    expect(colNames.has('dedupe_confidence')).toBe(true);
    expect(colNames.has('lifecycle_state')).toBe(true);
    expect(colNames.has('event_at_tz_hint')).toBe(true);
    expect(colNames.has('vendor_modstamp')).toBe(true);
    expect(colNames.has('vendor_raw_timestamp')).toBe(true);
    expect(colNames.has('body_state')).toBe(true);
    expect(colNames.has('body_truncation_offset')).toBe(true);
    expect(colNames.has('attachments')).toBe(true);
    expect(colNames.has('deletion_provenance')).toBe(true);
    expect(colNames.has('connection_id')).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────
// Store CRUD + vendor_modstamp stale-update drop
// ────────────────────────────────────────────────────────────────

describe('D-139 P1a.1 — engagement-store CRUD', () => {
  it('upsert + get round-trips every Pass-4 field', () => {
    const db = inMemoryDb();
    const store = createEngagementStore(db);
    const row = baseRow({
      attachments: [
        {
          vendor_attachment_id: 'att-1',
          filename: 'agenda.pdf',
          content_type: 'application/pdf',
          size_bytes: 12_345,
          uploaded_at: 1_714_867_200_000,
        },
      ],
      event_at_tz_hint: 'America/New_York',
      vendor_raw_timestamp: '1714867200000',
      body_state: 'truncated_inline',
      body_inline: 'first 6 KB ...',
      body_truncation_offset: 18_000,
      vendor_modstamp: '1714867200500',
    });
    store.upsert({ row });
    const fetched = store.get('acme-hubspot', 'hubspot_email_47291');
    expect(fetched).not.toBeNull();
    expect(fetched!.authorship).toBe('user');
    expect(fetched!.direction).toBe('outbound');
    expect(fetched!.lifecycle_state).toBe('point_in_time');
    expect(fetched!.event_at_tz_hint).toBe('America/New_York');
    expect(fetched!.vendor_raw_timestamp).toBe('1714867200000');
    expect(fetched!.body_state).toBe('truncated_inline');
    expect(fetched!.body_truncation_offset).toBe(18_000);
    expect(fetched!.attachments).toHaveLength(1);
    expect(fetched!.attachments![0]!.filename).toBe('agenda.pdf');
  });

  it('vendor_modstamp stale-update drop: incoming ≤ stored = no-op', () => {
    const db = inMemoryDb();
    const store = createEngagementStore(db);
    store.upsert({
      row: baseRow({
        vendor_modstamp: '2',
        meta: { subject: 'fresh subject' },
      }),
    });
    // Stale arrival with modstamp '1' (lex-less than '2').
    store.upsert({
      row: baseRow({
        vendor_modstamp: '1',
        meta: { subject: 'stale subject' },
      }),
    });
    const fetched = store.get('acme-hubspot', 'hubspot_email_47291');
    expect(fetched!.meta.subject).toBe('fresh subject');
  });

  it('vendor_modstamp stale-update drop: equal modstamp = no-op (not progress)', () => {
    const db = inMemoryDb();
    const store = createEngagementStore(db);
    store.upsert({
      row: baseRow({
        vendor_modstamp: '5',
        meta: { subject: 'first' },
      }),
    });
    store.upsert({
      row: baseRow({
        vendor_modstamp: '5',
        meta: { subject: 'duplicate retry' },
      }),
    });
    const fetched = store.get('acme-hubspot', 'hubspot_email_47291');
    expect(fetched!.meta.subject).toBe('first');
  });

  it('connection_id namespacing: same target_id under two portals stay separate', () => {
    const db = inMemoryDb();
    const store = createEngagementStore(db);
    store.upsert({ row: baseRow({ connection_id: 'acme-hubspot' }) });
    store.upsert({
      row: baseRow({
        connection_id: 'partner-hubspot',
        meta: { subject: 'partner version' },
      }),
    });
    const acme = store.get('acme-hubspot', 'hubspot_email_47291');
    const partner = store.get('partner-hubspot', 'hubspot_email_47291');
    expect(acme!.meta.subject).toBe('Quarterly review');
    expect(partner!.meta.subject).toBe('partner version');
  });
});

// ────────────────────────────────────────────────────────────────
// Edge writes + D-138 identity routing
// ────────────────────────────────────────────────────────────────

describe('D-139 P1a.1 — engagement_edges + D-138 identity routing', () => {
  it('upsertEdge routes contact target_id through resolveContactRedirect', () => {
    const db = inMemoryDb();
    const store = createEngagementStore(db);
    // bob@x.com merged into robert@y.com.
    const redirects = new Map<string, string>([['bob@x.com', 'robert@y.com']]);
    const lookup = (canonical: string): { merged_into?: string } | null => {
      const merged_into = redirects.get(canonical);
      return merged_into !== undefined ? { merged_into } : null;
    };
    store.upsertEdge({
      connection_id: 'acme-hubspot',
      engagement_target_id: 'hubspot_email_47291',
      edge_type: 'contact',
      target_kind: 'data.contact',
      target_id: 'bob@x.com',
      vendor: 'hubspot',
      created_at: 1_714_867_200_000,
      resolveContactRedirect: lookup,
    });
    const edges = store.listEdges({
      connection_id: 'acme-hubspot',
      engagement_target_id: 'hubspot_email_47291',
    });
    expect(edges).toHaveLength(1);
    expect(edges[0]!.target_id).toBe('robert@y.com');
  });

  it('many-to-many supported: one engagement → many contact edges', () => {
    const db = inMemoryDb();
    const store = createEngagementStore(db);
    for (const email of ['bob@acme.com', 'alice@acme.com']) {
      store.upsertEdge({
        connection_id: 'acme-hubspot',
        engagement_target_id: 'hubspot_email_47291',
        edge_type: 'contact',
        resolveContactRedirect: () => null,
        target_kind: 'data.contact',
        target_id: email,
        vendor: 'hubspot',
        created_at: 1_714_867_200_000,
      });
    }
    const edges = store.listEdges({
      connection_id: 'acme-hubspot',
      engagement_target_id: 'hubspot_email_47291',
    });
    expect(edges).toHaveLength(2);
  });

  it('tombstone-on-disassociate: deleted_at preserves history', () => {
    const db = inMemoryDb();
    const store = createEngagementStore(db);
    store.upsertEdge({
      connection_id: 'acme-hubspot',
      engagement_target_id: 'hubspot_email_47291',
      edge_type: 'contact',
      resolveContactRedirect: () => null,
      target_kind: 'data.contact',
      target_id: 'bob@acme.com',
      vendor: 'hubspot',
      created_at: 1_714_867_200_000,
    });
    store.tombstoneEdge({
      connection_id: 'acme-hubspot',
      engagement_target_id: 'hubspot_email_47291',
      edge_type: 'contact',
      target_id: 'bob@acme.com',
      deleted_at: 1_714_867_200_900,
    });
    const visible = store.listEdges({
      connection_id: 'acme-hubspot',
      engagement_target_id: 'hubspot_email_47291',
    });
    const all = store.listEdges({
      connection_id: 'acme-hubspot',
      engagement_target_id: 'hubspot_email_47291',
      include_deleted: true,
    });
    expect(visible).toHaveLength(0);
    expect(all).toHaveLength(1);
    expect(all[0]!.deleted_at).toBe(1_714_867_200_900);
  });

  it('connection-scoped cascade tombstones every edge under a deleted connection', () => {
    const db = inMemoryDb();
    const store = createEngagementStore(db);
    store.upsertEdge({
      connection_id: 'acme-hubspot',
      engagement_target_id: 'hubspot_email_1',
      edge_type: 'contact',
      resolveContactRedirect: () => null,
      target_kind: 'data.contact',
      target_id: 'bob@acme.com',
      created_at: 1,
    });
    store.upsertEdge({
      connection_id: 'partner-hubspot',
      engagement_target_id: 'hubspot_email_2',
      edge_type: 'contact',
      resolveContactRedirect: () => null,
      target_kind: 'data.contact',
      target_id: 'eve@partner.com',
      created_at: 1,
    });
    const tombstoned = store.tombstoneEdgesForConnection('acme-hubspot', 100);
    expect(tombstoned).toBe(1);
    const partnerLive = store.listEdges({ connection_id: 'partner-hubspot' });
    expect(partnerLive).toHaveLength(1);
  });
});

// ────────────────────────────────────────────────────────────────
// Inbound-event ledger
// ────────────────────────────────────────────────────────────────

describe('D-139 P1a.1 — inbound-event ledger (Pass-5 R5.8)', () => {
  it('first arrival inserts; duplicate returns no-op with previous observed_at', () => {
    const db = inMemoryDb();
    const store = createEngagementStore(db);
    const first = store.checkAndInsertInboundEvent({
      connection_id: 'acme-hubspot',
      vendor: 'hubspot',
      idempotency_key: '12345-email.creation',
      delivery_path: 'webhook',
      observed_at: 100,
    });
    expect(first.duplicate).toBe(false);
    const second = store.checkAndInsertInboundEvent({
      connection_id: 'acme-hubspot',
      vendor: 'hubspot',
      idempotency_key: '12345-email.creation',
      delivery_path: 'webhook',
      observed_at: 200,
    });
    expect(second.duplicate).toBe(true);
    expect(second.previous_observed_at).toBe(100);
  });

  it('compactInboundEventLedger drops entries older than the replay window', () => {
    const db = inMemoryDb();
    const store = createEngagementStore(db);
    const now = 25 * 60 * 60 * 1000; // 25 hours
    store.checkAndInsertInboundEvent({
      connection_id: 'acme-hubspot',
      vendor: 'hubspot',
      idempotency_key: 'old',
      delivery_path: 'webhook',
      observed_at: 0, // 25h before "now"
    });
    store.checkAndInsertInboundEvent({
      connection_id: 'acme-hubspot',
      vendor: 'hubspot',
      idempotency_key: 'fresh',
      delivery_path: 'webhook',
      observed_at: now - 60_000,
    });
    const compacted = store.compactInboundEventLedger(now);
    expect(compacted).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────────
// Resolver — identity expansion + evidence-quality filter round-trip
// ────────────────────────────────────────────────────────────────

describe('D-139 P1a.1 — engagements resolver', () => {
  it('identity-expansion routes loser-email → survivor canonical with full union', () => {
    const db = inMemoryDb();
    const store = createEngagementStore(db);

    // Two engagement rows — one edged at the loser email, one at the
    // survivor. The resolver's read-side identity expansion should
    // pick up both when the caller queries by either email.
    store.upsert({
      row: baseRow({
        target_id: 'hubspot_email_1',
        meta: { subject: 'pre-merge' },
      }),
    });
    store.upsertEdge({
      connection_id: 'acme-hubspot',
      engagement_target_id: 'hubspot_email_1',
      edge_type: 'contact',
      resolveContactRedirect: () => null,
      target_kind: 'data.contact',
      target_id: 'bob@x.com', // loser
      created_at: 1,
    });

    store.upsert({
      row: baseRow({
        target_id: 'hubspot_email_2',
        meta: { subject: 'post-merge' },
        event_at: 1_714_867_300_000,
      }),
    });
    store.upsertEdge({
      connection_id: 'acme-hubspot',
      engagement_target_id: 'hubspot_email_2',
      edge_type: 'contact',
      resolveContactRedirect: () => null,
      target_kind: 'data.contact',
      target_id: 'robert@y.com', // survivor
      created_at: 1,
    });

    const result = store.resolveEngagementsForContact(
      { email: 'robert@y.com', since: 0 },
      {
        resolveContactRedirect: () => null, // no further redirect
        expandContactIdentity: (survivor) =>
          survivor === 'robert@y.com' ? ['robert@y.com', 'bob@x.com'] : [],
        now: () => 1_714_867_300_000,
        coverage: {
          sources_connected: ['connection.api.hubspot.email'],
          sources_unavailable: [],
          sources_stale: [],
          sources_degraded: [],
          row_counts: {},
          last_source_event_at: 1_714_867_300_000,
        },
      },
    );

    expect(result.engagements).toHaveLength(2);
    const ids = result.engagements.map((e) => e.target_id).sort();
    expect(ids).toEqual(['hubspot_email_1', 'hubspot_email_2']);
  });

  it('evidence-quality filter — authorship whitelist excludes system_process', () => {
    const db = inMemoryDb();
    const store = createEngagementStore(db);
    store.upsert({ row: baseRow({ target_id: 'hubspot_email_a', authorship: 'user' }) });
    store.upsert({
      row: baseRow({
        target_id: 'hubspot_email_b',
        authorship: 'system_process',
        event_at: 1_714_867_200_001, // distinct sort key
      }),
    });
    for (const id of ['hubspot_email_a', 'hubspot_email_b']) {
      store.upsertEdge({
        connection_id: 'acme-hubspot',
        engagement_target_id: id,
        edge_type: 'contact',
        resolveContactRedirect: () => null,
        target_kind: 'data.contact',
        target_id: 'bob@acme.com',
        created_at: 1,
      });
    }
    const result = store.resolveEngagementsForContact(
      {
        email: 'bob@acme.com',
        since: 0,
        authorship: ['user', 'crm_user'],
      },
      {
        resolveContactRedirect: () => null,
        expandContactIdentity: () => ['bob@acme.com'],
        now: () => 1_714_867_300_000,
        coverage: emptyCoverage(),
      },
    );
    expect(result.engagements).toHaveLength(1);
    expect(result.engagements[0]!.authorship).toBe('user');
  });

  it('default lifecycle filter excludes pending tasks (event_at IS NULL is excluded)', () => {
    const db = inMemoryDb();
    const store = createEngagementStore(db);
    store.upsert({ row: baseRow({ target_id: 'hubspot_email_sent' }) });
    store.upsert({
      row: baseRow({
        target_id: 'hubspot_email_pending',
        lifecycle_state: 'pending',
        event_at: null,
      }),
    });
    for (const id of ['hubspot_email_sent', 'hubspot_email_pending']) {
      store.upsertEdge({
        connection_id: 'acme-hubspot',
        engagement_target_id: id,
        edge_type: 'contact',
        resolveContactRedirect: () => null,
        target_kind: 'data.contact',
        target_id: 'bob@acme.com',
        created_at: 1,
      });
    }
    const result = store.resolveEngagementsForContact(
      { email: 'bob@acme.com', since: 0 },
      {
        resolveContactRedirect: () => null,
        expandContactIdentity: () => ['bob@acme.com'],
        now: () => 1_714_867_300_000,
        coverage: emptyCoverage(),
      },
    );
    expect(result.engagements).toHaveLength(1);
    expect(result.engagements[0]!.target_id).toBe('hubspot_email_sent');
  });

  it('probable-confidence twins surface as separate rows with dedupe_candidates joined', () => {
    const db = inMemoryDb();
    const store = createEngagementStore(db);
    const row = baseRow({
      target_id: 'hubspot_email_1',
      dedupe_confidence: 'probable',
    });
    store.upsert({ row });
    store.upsertEdge({
      connection_id: 'acme-hubspot',
      engagement_target_id: 'hubspot_email_1',
      edge_type: 'contact',
      resolveContactRedirect: () => null,
      target_kind: 'data.contact',
      target_id: 'bob@acme.com',
      created_at: 1,
    });
    store.upsertDedupeCandidate({
      source_connection_id: 'acme-hubspot',
      source_target_id: 'hubspot_email_1',
      candidate_connection_id: 'data.mail',
      candidate_target_id: 'mail-row-99',
      match_key: 'from_to_sent_at_triple',
      confidence: 'probable',
      resolution_state: 'pending',
      detected_at: 1,
    });
    const result = store.resolveEngagementsForContact(
      { email: 'bob@acme.com', since: 0 },
      {
        resolveContactRedirect: () => null,
        expandContactIdentity: () => ['bob@acme.com'],
        now: () => 1_714_867_300_000,
        coverage: emptyCoverage(),
      },
    );
    expect(result.engagements).toHaveLength(1);
    const r = result.engagements[0]!;
    expect(r.dedupe_confidence).toBe('probable');
    expect(r.dedupe_candidates).toHaveLength(1);
    expect(r.dedupe_candidates![0]!.candidate_target_id).toBe('mail-row-99');
    expect(r.dedupe_candidates![0]!.match_key).toBe('from_to_sent_at_triple');
    expect(r.vendor_twins).toBeUndefined(); // no auto-collapse on probable
  });

  it('exact-confidence twins collapse into one row with vendor_twins[]', () => {
    const db = inMemoryDb();
    const store = createEngagementStore(db);
    store.upsert({
      row: baseRow({
        target_id: 'hubspot_email_a',
        dedupe_confidence: 'exact',
      }),
    });
    store.upsert({
      row: baseRow({
        target_id: 'hubspot_email_b',
        dedupe_confidence: 'exact',
        event_at: 1_714_867_200_001,
      }),
    });
    for (const id of ['hubspot_email_a', 'hubspot_email_b']) {
      store.upsertEdge({
        connection_id: 'acme-hubspot',
        engagement_target_id: id,
        edge_type: 'contact',
        resolveContactRedirect: () => null,
        target_kind: 'data.contact',
        target_id: 'bob@acme.com',
        created_at: 1,
      });
    }
    store.upsertDedupeCandidate({
      source_connection_id: 'acme-hubspot',
      source_target_id: 'hubspot_email_a',
      candidate_connection_id: 'acme-hubspot',
      candidate_target_id: 'hubspot_email_b',
      match_key: 'message_id',
      confidence: 'exact',
      resolution_state: 'pending',
      detected_at: 1,
    });
    const result = store.resolveEngagementsForContact(
      { email: 'bob@acme.com', since: 0 },
      {
        resolveContactRedirect: () => null,
        expandContactIdentity: () => ['bob@acme.com'],
        now: () => 1_714_867_300_000,
        coverage: emptyCoverage(),
      },
    );
    // Exact-confidence collapses the surviving row's twin into vendor_twins[].
    // The "newer" row (event_at_b > event_at_a) sorts first; it carries
    // no candidate-row pointing forward, so collapse happens on the older
    // row's read. We assert one of them carries vendor_twins.
    const collapsed = result.engagements.find(
      (r) => r.vendor_twins !== undefined,
    );
    expect(collapsed).toBeDefined();
    expect(collapsed!.vendor_twins).toContain('hubspot_email_b');
  });
});

const emptyCoverage = () => ({
  sources_connected: [],
  sources_unavailable: [],
  sources_stale: [],
  sources_degraded: [],
  row_counts: {},
  last_source_event_at: 0,
});

// ────────────────────────────────────────────────────────────────
// Reconciler derivations
// ────────────────────────────────────────────────────────────────

describe('D-139 P1a.1 — HubSpot email reconciler derivations', () => {
  it('authorship: hubspot_owner_id matching connection user → user', () => {
    expect(deriveEmailAuthorship(rawEmail({ hubspot_owner_id: '777' }), '777'))
      .toBe('user');
  });
  it('authorship: hs_created_by_workflow_id populated → crm_automation', () => {
    expect(
      deriveEmailAuthorship(
        rawEmail({ hubspot_owner_id: '999', hs_created_by_workflow_id: 'wf-1' }),
        '777',
      ),
    ).toBe('crm_automation');
  });
  it('authorship: tracking-pixel rows (status=OPENED, no body) → system_process', () => {
    const raw = rawEmail({
      hs_email_status: 'OPENED',
      hs_email_subject: '',
      hs_email_text: '',
      hs_email_html: '',
      hubspot_owner_id: '',
    });
    expect(deriveEmailAuthorship(raw, '777')).toBe('system_process');
  });
  it('authorship: import_id populated (no owner match) → import', () => {
    // The spec's decision tree at § A.3.2 evaluates hubspot_owner_id
    // → user/crm_user BEFORE the import branch. Isolate the import
    // case by clearing the owner-match.
    expect(
      deriveEmailAuthorship(
        rawEmail({ hs_import_id: 'csv-import-1', hubspot_owner_id: '' }),
        '777',
      ),
    ).toBe('import');
  });
  it('direction: INCOMING_EMAIL → inbound', () => {
    expect(
      deriveEmailDirection(rawEmail({ hs_email_direction: 'INCOMING_EMAIL' }), []),
    ).toBe('inbound');
  });
  it('direction: EMAIL outbound → outbound', () => {
    expect(deriveEmailDirection(rawEmail({ hs_email_direction: 'EMAIL' }), [])).toBe(
      'outbound',
    );
  });
  it('direction: internal-domain on both sides → internal', () => {
    const raw = rawEmail({
      hs_email_direction: 'EMAIL',
      hs_email_from_email: 'alice@recued.com',
      hs_email_to_email: 'bob@recued.com',
    });
    expect(deriveEmailDirection(raw, ['recued.com'])).toBe('internal');
  });
  it('lifecycle: hs_email_status drives the state machine (Pass-5 R5.3)', () => {
    expect(deriveEmailLifecycleState('SCHEDULED')).toBe('pending');
    expect(deriveEmailLifecycleState('SENDING')).toBe('pending');
    expect(deriveEmailLifecycleState('SENT')).toBe('point_in_time');
    expect(deriveEmailLifecycleState('FAILED')).toBe('failed');
    expect(deriveEmailLifecycleState('BOUNCED')).toBe('failed');
  });
  it('event_at: NULL for non-point_in_time lifecycle (pending sends not evidence)', () => {
    expect(deriveEmailEventAt(rawEmail(), 'pending')).toBeNull();
    expect(deriveEmailEventAt(rawEmail(), 'failed')).toBeNull();
    expect(deriveEmailEventAt(rawEmail(), 'point_in_time')).toBe(1_714_867_200_000);
  });
  // D-184 Decision 2 — pickBodyState derives from the CRM body only; the
  // 'mail_link' state is applied LIVE in the resolver on a Message-ID twin
  // (see the resolver mail-twin tests), no longer at projection time.
  it('body-state: short body → inline_body; large body → truncated_inline', () => {
    expect(pickBodyState(rawEmail({ hs_email_text: 'short' })).body_state).toBe(
      'inline_body',
    );
    const large = pickBodyState(rawEmail({ hs_email_text: 'x'.repeat(10_000) }));
    expect(large.body_state).toBe('truncated_inline');
    expect(large.body_truncation_offset).toBeGreaterThan(0);
  });
});

// ────────────────────────────────────────────────────────────────
// Reconciler row-projection round-trip
// ────────────────────────────────────────────────────────────────

describe('D-139 P1a.1 — projectEmailEngagementRow', () => {
  it('produces a row with all Pass-4 fields populated for a SENT email', () => {
    const row = projectEmailEngagementRow('acme-hubspot', rawEmail(), {
      now: 1_714_867_500_000,
      connectionUserOwnerId: '777',
    });
    expect(row.connection_id).toBe('acme-hubspot');
    expect(row.target_id).toBe('hubspot_email_47291');
    expect(row.vendor).toBe('hubspot');
    expect(row.entity).toBe('email');
    expect(row.authorship).toBe('user');
    expect(row.direction).toBe('outbound');
    expect(row.lifecycle_state).toBe('point_in_time');
    expect(row.event_at).toBe(1_714_867_200_000);
    expect(row.vendor_modstamp).toBe('1714867200500');
    expect(row.vendor_raw_timestamp).toBe('1714867200000');
    expect(row.body_state).toBe('inline_body');
    expect(row.meta.from_email).toBe('alice@recued.com');
    expect(row.meta.to_emails).toEqual(['bob@acme.com']);
    // Codex review fold #7 — event_at_tz_hint defaults to UTC.
    expect(row.event_at_tz_hint).toBe('UTC');
  });

  it('Codex fold #7 — defaultTzHint flows into event_at_tz_hint', () => {
    const row = projectEmailEngagementRow('acme-hubspot', rawEmail(), {
      now: 1_714_867_500_000,
      connectionUserOwnerId: '777',
      defaultTzHint: 'America/New_York',
    });
    expect(row.event_at_tz_hint).toBe('America/New_York');
  });

  it('Codex fold #6 — bounce_detail persists when lifecycle is failed', () => {
    const row = projectEmailEngagementRow(
      'acme-hubspot',
      rawEmail({
        hs_email_status: 'BOUNCED',
        hs_email_bounce_error_detail_message: 'Mailbox full',
        hs_email_bounce_error_detail_status_code: '5.2.2',
      }),
      {
        now: 1_714_867_500_000,
        connectionUserOwnerId: '777',
      },
    );
    expect(row.lifecycle_state).toBe('failed');
    expect(row.meta.bounce_detail).toEqual({
      message: 'Mailbox full',
      status_code: '5.2.2',
      vendor_status: 'BOUNCED',
    });
  });

  // D-184 Decision 2 — the former "pre-computed mail-twin match flips
  // body_state + dedupe_confidence" projection test is gone: exact twins
  // no longer flip body_state at projection. The live flip is covered by
  // the resolver mail-twin tests below.
});

// ────────────────────────────────────────────────────────────────
// Reconciler.ingest end-to-end
// ────────────────────────────────────────────────────────────────

describe('D-139 P1a.1 — reconciler ingest end-to-end', () => {
  // D-184 Decision 2 — the ingest writes contact + owner edges but NO
  // mail-twin edge and NO dedupe candidate (exact twins resolve live in
  // the resolver; probable materialization deferred). body_state is the
  // CRM-body state, never 'mail_link', at ingest.
  it('writes engagement row + contact + owner edges; no mail-twin edge or dedupe candidate at ingest', () => {
    const db = inMemoryDb();
    const store = createEngagementStore(db);
    const reconciler = new HubSpotEmailEngagementReconciler({
      search: { refreshAuth: async () => ({ type: 'oauth2_refresh' } as never) },
      engagementStore: store,
      connectionUserOwnerId: '777',
      now: () => 1_714_867_500_000,
    });
    const slim = {
      id: 'hubspot_email_47291',
      modified_at: 1_714_867_200_500,
      _raw: rawEmail(),
    };
    const { row, emittedEdgeCount } = reconciler.ingest('acme-hubspot', slim);
    expect(row.body_state).toBe('inline_body');
    expect(row.dedupe_confidence).toBe('none');
    expect(emittedEdgeCount).toBeGreaterThanOrEqual(2);
    const edges = store.listEdges({
      connection_id: 'acme-hubspot',
      engagement_target_id: 'hubspot_email_47291',
    });
    const types = edges.map((e) => e.edge_type).sort();
    expect(types).toContain('contact');
    expect(types).toContain('owner');
    expect(types).not.toContain('mail_twin');
    const candidates = store.listDedupeCandidatesForRow(
      'acme-hubspot',
      'hubspot_email_47291',
    );
    expect(candidates).toHaveLength(0);
  });

  it('contact-edge writes route through D-138 resolveContactIdentity', () => {
    const db = inMemoryDb();
    const store = createEngagementStore(db);
    const reconciler = new HubSpotEmailEngagementReconciler({
      search: { refreshAuth: async () => ({ type: 'oauth2_refresh' } as never) },
      engagementStore: store,
      connectionUserOwnerId: '777',
      resolveContactRedirect: (canonical) =>
        canonical === 'bob@acme.com'
          ? { merged_into: 'robert@acme.com' }
          : null,
      now: () => 1_714_867_500_000,
    });
    const slim = {
      id: 'hubspot_email_47291',
      modified_at: 1_714_867_200_500,
      _raw: rawEmail(),
    };
    reconciler.ingest('acme-hubspot', slim);
    const contactEdges = store.listEdges({
      connection_id: 'acme-hubspot',
      engagement_target_id: 'hubspot_email_47291',
      edge_type: 'contact',
    });
    expect(contactEdges.map((e) => e.target_id)).toContain('robert@acme.com');
    expect(contactEdges.map((e) => e.target_id)).not.toContain('bob@acme.com');
  });
});

// ────────────────────────────────────────────────────────────────
// Webhook processor — idempotency-ledger gating
// ────────────────────────────────────────────────────────────────

describe('D-139 P1a.1 — webhook processor idempotency gating', () => {
  it('duplicate eventId-subscriptionType is no-op', async () => {
    const db = inMemoryDb();
    const store = createEngagementStore(db);
    const processor = buildHubSpotEmailEngagementWebhookProcessor({
      search: { refreshAuth: async () => ({ type: 'oauth2_refresh' } as never) },
      engagementStore: store,
      lookupConnection: async () => null, // no follow-up GET path needed
      now: () => 1,
    });
    const payload = [
      {
        subscriptionType: 'email.deletion',
        objectId: 47_291,
        eventId: 1234,
      },
    ];
    const first = await processor.parseEvents(payload, {}, 'acme-hubspot');
    expect(first).toHaveLength(1);
    expect(first[0]).toEqual({
      kind: 'deleted',
      target_id: 'hubspot_email_47291',
    });
    // Same eventId — duplicate.
    const second = await processor.parseEvents(payload, {}, 'acme-hubspot');
    expect(second).toHaveLength(0);
  });

  it('Codex fold #9 + #13 — email.associationChange skips processing AND skips the ledger', async () => {
    // Pre-fold the ledger landed a row even though the side-effect
    // (edge-only write) wasn't applied. A duplicate retry then saw the
    // ledger as "processed" and silently dropped without ever writing
    // the edge. Post-fold: associationChange events bypass the ledger
    // entirely; the per-cycle association-rescan sweep at P1a.2 is
    // the substrate path that actually applies the change. The
    // dedicated edge-only write path lands at P1a.1.1.
    const db = inMemoryDb();
    const store = createEngagementStore(db);
    const processor = buildHubSpotEmailEngagementWebhookProcessor({
      search: { refreshAuth: async () => ({ type: 'oauth2_refresh' } as never) },
      engagementStore: store,
      lookupConnection: async () => null,
      now: () => 1,
    });
    const payload = [
      {
        subscriptionType: 'email.associationChange',
        objectId: 47_291,
        eventId: 5678,
      },
    ];
    const events = await processor.parseEvents(payload, {}, 'acme-hubspot');
    expect(events).toHaveLength(0);
    const ledger = db
      .prepare(
        `SELECT COUNT(*) AS n FROM ${ENGAGEMENT_INBOUND_EVENT_LEDGER_TABLE}`,
      )
      .get() as { n: number };
    expect(ledger.n).toBe(0);
  });

  it('non-email subscriptionType is filtered out by the processor', async () => {
    const db = inMemoryDb();
    const store = createEngagementStore(db);
    const processor = buildHubSpotEmailEngagementWebhookProcessor({
      search: { refreshAuth: async () => ({ type: 'oauth2_refresh' } as never) },
      engagementStore: store,
      lookupConnection: async () => null,
      now: () => 1,
    });
    const payload = [
      {
        subscriptionType: 'deal.creation',
        objectId: 12_345,
        eventId: 1,
      },
    ];
    const events = await processor.parseEvents(payload, {}, 'acme-hubspot');
    expect(events).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────────
// HubSpot search property-list smoke
// ────────────────────────────────────────────────────────────────

describe('D-139 P1a.1 — HUBSPOT_EMAIL_PROPERTIES surface', () => {
  it('carries the lifecycle drivers + cursor field + Message-ID + authorship hints', () => {
    const props = HUBSPOT_EMAIL_PROPERTIES as ReadonlyArray<string>;
    expect(props).toContain('hs_lastmodifieddate');
    expect(props).toContain('hs_email_status');
    expect(props).toContain('hs_email_direction');
    expect(props).toContain('hs_email_internet_message_id');
    expect(props).toContain('hubspot_owner_id');
    expect(props).toContain('hs_created_by_workflow_id');
    expect(props).toContain('hs_import_id');
  });
});

// ────────────────────────────────────────────────────────────────
// Codex review fold-back coverage (P1a.1 review fixes)
// ────────────────────────────────────────────────────────────────

describe('D-139 P1a.1 Codex fold — atomic ingest + tombstone-on-disassociate', () => {
  it('Codex fold #2 — re-ingest with shrunken contact set tombstones removed edges', () => {
    const db = inMemoryDb();
    const store = createEngagementStore(db);
    const reconciler = new HubSpotEmailEngagementReconciler({
      search: { refreshAuth: async () => ({ type: 'oauth2_refresh' } as never) },
      engagementStore: store,
      connectionUserOwnerId: '777',
      now: () => 1_714_867_500_000,
    });
    // First ingest — bob + alice.
    reconciler.ingest('acme-hubspot', {
      id: 'hubspot_email_47291',
      modified_at: 1_714_867_200_500,
      _raw: rawEmail({
        hs_email_to_email: 'bob@acme.com;alice@acme.com',
      }),
    });
    const initial = store.listEdges({
      connection_id: 'acme-hubspot',
      engagement_target_id: 'hubspot_email_47291',
      edge_type: 'contact',
    });
    expect(initial.map((e) => e.target_id).sort()).toEqual([
      // alice@recued.com is the rep (from_email); both to-recipients
      // are emitted as contact edges per the substrate's "every
      // header participant is a contact" derivation. The follow-up
      // sub-phase swaps this for HubSpot /associations/ reads.
      'alice@acme.com',
      'alice@recued.com',
      'bob@acme.com',
    ]);
    // Re-ingest with alice removed; bump modstamp so the upsert lands.
    reconciler.ingest('acme-hubspot', {
      id: 'hubspot_email_47291',
      modified_at: 1_714_867_300_000,
      _raw: rawEmail({
        hs_email_to_email: 'bob@acme.com',
        hs_lastmodifieddate: '1714867300000',
      }),
    });
    const after = store.listEdges({
      connection_id: 'acme-hubspot',
      engagement_target_id: 'hubspot_email_47291',
      edge_type: 'contact',
    });
    expect(after.map((e) => e.target_id).sort()).toEqual([
      'alice@recued.com',
      'bob@acme.com',
    ]);
    const tombstoned = store.listEdges({
      connection_id: 'acme-hubspot',
      engagement_target_id: 'hubspot_email_47291',
      edge_type: 'contact',
      include_deleted: true,
    });
    const deleted = tombstoned.find((e) => e.deleted_at !== undefined);
    expect(deleted).toBeDefined();
    expect(deleted!.target_id).toBe('alice@acme.com');
  });

  it('Codex fold #3 — atomic ingest returns counts for row + edges + dedupe candidates', () => {
    const db = inMemoryDb();
    const store = createEngagementStore(db);
    const result = store.ingestEngagementWithEdges({
      row: baseRow({ vendor_modstamp: '1' }),
      edges: [
        {
          connection_id: 'acme-hubspot',
          engagement_target_id: 'hubspot_email_47291',
          edge_type: 'contact',
          target_kind: 'data.contact',
          target_id: 'bob@acme.com',
          created_at: 1_714_867_200_000,
          resolveContactRedirect: () => null,
        },
      ],
      dedupe_candidates: [
        {
          source_connection_id: 'acme-hubspot',
          source_target_id: 'hubspot_email_47291',
          candidate_connection_id: 'data.mail',
          candidate_target_id: 'mail-row-1',
          match_key: 'message_id',
          confidence: 'exact',
          resolution_state: 'pending',
          detected_at: 1_714_867_200_000,
        },
      ],
    });
    expect(result.stale_modstamp).toBe(false);
    expect(result.edges_upserted).toBe(1);
    expect(result.edges_tombstoned).toBe(0);
    expect(result.dedupe_candidates_upserted).toBe(1);
  });

  it('Codex fold #3 — stale modstamp drops the entire transaction (row + edges + candidates)', () => {
    const db = inMemoryDb();
    const store = createEngagementStore(db);
    // Seed the persisted row at modstamp '5'.
    store.ingestEngagementWithEdges({
      row: baseRow({
        vendor_modstamp: '5',
        meta: { subject: 'fresh' },
      }),
      edges: [
        {
          connection_id: 'acme-hubspot',
          engagement_target_id: 'hubspot_email_47291',
          edge_type: 'owner',
          target_kind: 'user',
          target_id: 'hubspot_owner_id:777',
          created_at: 1,
        },
      ],
    });
    // Re-ingest at older modstamp '1' with new edges + candidates —
    // everything should drop atomically.
    const result = store.ingestEngagementWithEdges({
      row: baseRow({
        vendor_modstamp: '1',
        meta: { subject: 'stale' },
      }),
      edges: [
        {
          connection_id: 'acme-hubspot',
          engagement_target_id: 'hubspot_email_47291',
          edge_type: 'contact',
          target_kind: 'data.contact',
          target_id: 'eve@late.com',
          created_at: 1,
          resolveContactRedirect: () => null,
        },
      ],
      dedupe_candidates: [
        {
          source_connection_id: 'acme-hubspot',
          source_target_id: 'hubspot_email_47291',
          candidate_connection_id: 'data.mail',
          candidate_target_id: 'mail-row-99',
          match_key: 'message_id',
          confidence: 'exact',
          resolution_state: 'pending',
          detected_at: 1,
        },
      ],
    });
    expect(result.stale_modstamp).toBe(true);
    expect(result.edges_upserted).toBe(0);
    expect(result.dedupe_candidates_upserted).toBe(0);
    // Persisted row remains at the fresh subject.
    const fetched = store.get('acme-hubspot', 'hubspot_email_47291');
    expect(fetched!.meta.subject).toBe('fresh');
    // Owner edge from seed is still live; the stale-attempt's
    // 'eve@late.com' contact edge never landed.
    const edges = store.listEdges({
      connection_id: 'acme-hubspot',
      engagement_target_id: 'hubspot_email_47291',
    });
    expect(edges.map((e) => e.edge_type).sort()).toEqual(['owner']);
    const candidates = store.listDedupeCandidatesForRow(
      'acme-hubspot',
      'hubspot_email_47291',
    );
    expect(candidates).toHaveLength(0);
  });

  it('Codex fold #11 — upsertEdge throws when contact edge omits resolveContactRedirect', () => {
    const db = inMemoryDb();
    const store = createEngagementStore(db);
    expect(() =>
      store.upsertEdge({
        connection_id: 'acme-hubspot',
        engagement_target_id: 'hubspot_email_47291',
        edge_type: 'contact',
        target_kind: 'data.contact',
        target_id: 'bob@acme.com',
        created_at: 1,
      }),
    ).toThrow(/resolveContactRedirect/);
  });

  it('Codex fold #10 — explicit lifecycle whitelist with scheduled returns NULL-event_at rows', () => {
    const db = inMemoryDb();
    const store = createEngagementStore(db);
    // Scheduled meeting — event_at is NULL until past, lifecycle_state
    // is 'scheduled'. Default resolver call would exclude.
    store.upsert({
      row: baseRow({
        target_id: 'hubspot_meeting_1',
        lifecycle_state: 'scheduled',
        event_at: null,
        scheduled_start_at: 1_714_867_500_000,
        body_state: 'inline_body',
        body_inline: 'Sync prep',
      }),
    });
    store.upsertEdge({
      connection_id: 'acme-hubspot',
      engagement_target_id: 'hubspot_meeting_1',
      edge_type: 'contact',
      target_kind: 'data.contact',
      target_id: 'bob@acme.com',
      created_at: 1,
      resolveContactRedirect: () => null,
    });
    // Default call excludes the scheduled meeting (event_at IS NULL).
    const defaultResult = store.resolveEngagementsForContact(
      { email: 'bob@acme.com', since: 0 },
      {
        resolveContactRedirect: () => null,
        expandContactIdentity: () => ['bob@acme.com'],
        now: () => 1_714_867_300_000,
        coverage: emptyCoverage(),
      },
    );
    expect(defaultResult.engagements).toHaveLength(0);
    // Explicit ['scheduled'] whitelist surfaces the row.
    const upcomingResult = store.resolveEngagementsForContact(
      {
        email: 'bob@acme.com',
        since: 0,
        lifecycle_state: ['scheduled'],
      },
      {
        resolveContactRedirect: () => null,
        expandContactIdentity: () => ['bob@acme.com'],
        now: () => 1_714_867_300_000,
        coverage: emptyCoverage(),
      },
    );
    expect(upcomingResult.engagements).toHaveLength(1);
    expect(upcomingResult.engagements[0]!.lifecycle_state).toBe('scheduled');
    expect(upcomingResult.engagements[0]!.event_at).toBeNull();
  });

});
