/** D-139 Phase 1a.1.1 — engagement substrate carry-forward sub-phase.
 *
 *  Covers the P1a.1.1 acceptance set:
 *    - `listHubSpotAssociations` paginates + parses HubSpot v3
 *      response shape; 404 returns null; 401 / 429 thread through
 *      the search-helper deps.
 *    - `fetchHubSpotEngagementAssociations` wraps deals + companies
 *      (+ optional contacts) into the structured projection;
 *      `source_record_missing` flips when any leg returns 404.
 *    - Reconciler `ingest()` accepts `crmAssociations` + emits
 *      `engagement_edges` of type `'deal'` / `'account'` per § A.4.
 *      Five reconcilers (email / meeting / note / call / task) thread
 *      the same shape.
 *    - TZ-correct task `due_at` — date-only HubSpot due dates
 *      canonicalize to wall-clock midnight in the user's local tz,
 *      NOT UTC midnight. East-of-UTC (Berlin) and west-of-UTC (NYC)
 *      both correctly land at the user's local 00:00.
 *    - `computeLocalDayMidnightUtc` boundary cases (UTC fast path,
 *      DST crossing, unknown tz fallback).
 *    - Engagement webhook `applyAssociationChange` callback path —
 *      ledger lookup → applier → ledger insert AFTER write succeeds.
 *      Failure path leaves ledger empty so HubSpot retries.
 *      `source_record_missing` (engagement deleted in flight) skips
 *      ledger insert.
 *    - Capability gate honored — `runAssociationRescan` skips when
 *      `association_rescan_required: false` (healthy-streaming);
 *      `force_run: true` bypasses for diagnostic flows.
 *    - Canary end-to-end deal-edge — reconciler ingest with
 *      crmAssociations → engagement_edges row of `edge_type='deal'`
 *      lands → query pattern `WHERE edge_type='deal' AND
 *      target_id=...` resolves the engagement set for
 *      `engagement_silence_duration` rollup.
 *
 *  Spec: D-139 § A.4, § A.6.3, § A.3.7, § A.9.1
 *  (engagement_silence_duration). */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { type EngagementRow } from '@recued/contracts';

import {
  createEngagementStore,
  type EngagementStore,
} from '../storage/engagement-store.js';
import { createEngagementCapabilityStore } from '../storage/engagement-capability-store.js';
import { createEngagementRateControlStore } from '../storage/engagement-rate-control-store.js';
import {
  HubSpotEmailEngagementReconciler,
} from '../data/hubspot/email-engagement-reconciler.js';
import { HubSpotMeetingEngagementReconciler } from '../data/hubspot/meeting-engagement-reconciler.js';
import { HubSpotNoteEngagementReconciler } from '../data/hubspot/note-engagement-reconciler.js';
import { HubSpotCallEngagementReconciler } from '../data/hubspot/call-engagement-reconciler.js';
import {
  HubSpotTaskEngagementReconciler,
  projectTaskEngagementRow,
} from '../data/hubspot/task-engagement-reconciler.js';
import {
  buildHubSpotEngagementAssociationChangeApplier,
} from '../data/hubspot/engagement-association-applier.js';
import { buildHubSpotEmailEngagementWebhookProcessor } from '../data/hubspot/email-engagement-webhook-processor.js';
import {
  computeLocalDayMidnightUtc,
  fetchHubSpotEngagementAssociations,
} from '../data/hubspot/engagement-shared.js';
import {
  listHubSpotAssociations,
  type RawHubSpotRecord,
} from '../data/hubspot/_hubspot-search.js';

// ────────────────────────────────────────────────────────────────
// Test harness
// ────────────────────────────────────────────────────────────────

const FIXED_NOW = 1_714_867_200_000;
const inMemoryDb = (): Database.Database => new Database(':memory:');

const makeStores = (): {
  store: EngagementStore;
  capStore: ReturnType<typeof createEngagementCapabilityStore>;
  rcStore: ReturnType<typeof createEngagementRateControlStore>;
  db: Database.Database;
} => {
  const db = inMemoryDb();
  const store = createEngagementStore(db);
  const capStore = createEngagementCapabilityStore(db);
  const rcStore = createEngagementRateControlStore(db);
  return { store, capStore, rcStore, db };
};

const fakeConnection = {
  _id: 'c1',
  name: 'acme-hubspot',
  kind: 'api',
  vendor: 'hubspot',
  auth: {
    type: 'oauth2_refresh' as const,
    current_access_token: 'test-token',
    refresh_token: 'rt',
  },
  config: {},
  created_at: FIXED_NOW,
  updated_at: FIXED_NOW,
} as never;

const okJson = (body: unknown): Response =>
  ({
    ok: true,
    status: 200,
    json: async () => body,
    headers: new Headers(),
    text: async () => JSON.stringify(body),
  }) as never;

const notFound = (): Response =>
  ({
    ok: false,
    status: 404,
    json: async () => ({ message: 'not found' }),
    headers: new Headers(),
    text: async () => '',
  }) as never;

const refreshAuth = async (): Promise<never> =>
  ({ type: 'oauth2_refresh', current_access_token: 'fresh' }) as never;

const rawEmail = (
  overrides: Partial<RawHubSpotRecord['properties']> = {},
  id = '47291',
): RawHubSpotRecord => ({
  id,
  properties: {
    hs_email_subject: 'Quarterly review',
    hs_email_text: 'Body',
    hs_email_html: '',
    hs_email_direction: 'INCOMING_EMAIL',
    hs_email_status: 'SENT',
    hs_email_from_email: 'bob@acme.com',
    hs_email_to_email: 'alice@recued.com',
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

const rawTask = (
  overrides: Partial<RawHubSpotRecord['properties']> = {},
  id = '301',
): RawHubSpotRecord => ({
  id,
  properties: {
    hs_task_subject: 'Email Bob about renewal',
    hs_task_status: 'NOT_STARTED',
    hs_task_priority: 'HIGH',
    hs_task_type: 'EMAIL',
    hs_task_body: '',
    hs_task_completion_date: '2026-05-04',
    hs_timestamp: '',
    hs_createdate: '1714000000000',
    hs_lastmodifieddate: '1714867200000',
    hubspot_owner_id: '777',
    hs_created_by_workflow_id: '',
    hs_created_via_workflow: '',
    hs_import_id: '',
    ...overrides,
  },
});

// ────────────────────────────────────────────────────────────────
// listHubSpotAssociations — wire-shape parsing
// ────────────────────────────────────────────────────────────────

describe('D-139 P1a.1.1 — listHubSpotAssociations', () => {
  it('parses v3 response shape (toObjectId field) + paginates via paging.next.after; returns pages_fetched + next_cursor', async () => {
    let calls = 0;
    const fetcher = (async (url: string): Promise<Response> => {
      calls += 1;
      if (calls === 1) {
        return okJson({
          results: [
            { toObjectId: 47291 },
            { toObjectId: 47292 },
          ],
          paging: { next: { after: 'page-2-cursor' } },
        });
      }
      expect(url).toContain('after=page-2-cursor');
      return okJson({ results: [{ toObjectId: 47293 }] });
    }) as never;

    const result = await listHubSpotAssociations(
      fakeConnection,
      'emails',
      '47291',
      'deals',
      { fetcher, refreshAuth },
    );
    expect(result).not.toBeNull();
    expect(result!.ids).toEqual(['47291', '47292', '47293']);
    expect(result!.pages_fetched).toBe(2);
    expect(result!.next_cursor).toBe(null);
    expect(calls).toBe(2);
  });

  it('Codex P2 #1 — page_cap caps the walk + surfaces next_cursor for resume', async () => {
    let calls = 0;
    const fetcher = (async (): Promise<Response> => {
      calls += 1;
      return okJson({
        results: [{ toObjectId: String(calls) }],
        paging: { next: { after: `page-${calls + 1}-cursor` } },
      });
    }) as never;

    const result = await listHubSpotAssociations(
      fakeConnection,
      'emails',
      '47291',
      'deals',
      { fetcher, refreshAuth },
      { page_cap: 2 },
    );
    expect(result!.pages_fetched).toBe(2);
    expect(result!.next_cursor).toBe('page-3-cursor');
    expect(calls).toBe(2);
  });

  it('returns null on 404 (engagement deleted between webhook + GET)', async () => {
    const fetcher = (async () => notFound()) as never;
    const result = await listHubSpotAssociations(
      fakeConnection,
      'emails',
      '47291',
      'deals',
      { fetcher, refreshAuth },
    );
    expect(result).toBeNull();
  });

  it('honors fallback `id` field on older portals + coerces numeric ids to string', async () => {
    const fetcher = (async () =>
      okJson({
        results: [{ id: 88 }, { id: '99' }],
      })) as never;
    const result = await listHubSpotAssociations(
      fakeConnection,
      'emails',
      '47291',
      'companies',
      { fetcher, refreshAuth },
    );
    expect(result!.ids).toEqual(['88', '99']);
  });

  it('threads URL path correctly for the from/to types', async () => {
    let observedUrl = '';
    const fetcher = (async (url: string) => {
      observedUrl = url;
      return okJson({ results: [] });
    }) as never;
    await listHubSpotAssociations(
      fakeConnection,
      'meetings',
      '301',
      'companies',
      { fetcher, refreshAuth },
    );
    expect(observedUrl).toContain('/meetings/301/associations/companies');
  });
});

// ────────────────────────────────────────────────────────────────
// fetchHubSpotEngagementAssociations — structured projection
// ────────────────────────────────────────────────────────────────

describe('D-139 P1a.1.1 — fetchHubSpotEngagementAssociations', () => {
  it('parallel-fetches deals + companies; api_calls_consumed reflects actual page count (Codex P2 #1)', async () => {
    let dealsCalls = 0;
    let companiesCalls = 0;
    const fetcher = (async (url: string): Promise<Response> => {
      if (url.includes('/deals')) {
        dealsCalls += 1;
        return okJson({ results: [{ toObjectId: 47291 }] });
      }
      if (url.includes('/companies')) {
        companiesCalls += 1;
        return okJson({ results: [{ toObjectId: 8839 }] });
      }
      return okJson({ results: [] });
    }) as never;

    const result = await fetchHubSpotEngagementAssociations({
      connection: fakeConnection,
      entity: 'email',
      raw_id: '47291',
      search: { fetcher, refreshAuth },
    });
    expect(result.associations.deals).toEqual(['47291']);
    expect(result.associations.companies).toEqual(['8839']);
    expect(result.api_calls_consumed).toBe(2);
    expect(result.source_record_missing).toBe(false);
    expect(dealsCalls).toBe(1);
    expect(companiesCalls).toBe(1);
  });

  it('Codex P2 #1 — multi-page legs bump api_calls_consumed past the leg count', async () => {
    let dealsCalls = 0;
    const fetcher = (async (url: string): Promise<Response> => {
      if (url.includes('/deals')) {
        dealsCalls += 1;
        if (dealsCalls === 1) {
          return okJson({
            results: [{ toObjectId: 1 }],
            paging: { next: { after: 'p2' } },
          });
        }
        return okJson({ results: [{ toObjectId: 2 }] });
      }
      return okJson({ results: [] });
    }) as never;
    const result = await fetchHubSpotEngagementAssociations({
      connection: fakeConnection,
      entity: 'email',
      raw_id: '47291',
      search: { fetcher, refreshAuth },
    });
    // 2 deals pages + 1 companies page = 3 api_calls_consumed
    // (was a fixed `2` pre-fold).
    expect(result.api_calls_consumed).toBe(3);
    expect(result.associations.deals).toEqual(['1', '2']);
  });

  it('Codex P2 #1 — page_cap surfaces next_cursors for resume', async () => {
    const fetcher = (async (url: string): Promise<Response> => {
      if (url.includes('/deals')) {
        return okJson({
          results: [{ toObjectId: 'd' }],
          paging: { next: { after: 'deals-tail' } },
        });
      }
      if (url.includes('/companies')) {
        return okJson({ results: [{ toObjectId: 'c' }] });
      }
      return okJson({ results: [] });
    }) as never;
    const result = await fetchHubSpotEngagementAssociations({
      connection: fakeConnection,
      entity: 'email',
      raw_id: '47291',
      search: { fetcher, refreshAuth },
      page_cap: 1,
    });
    expect(result.next_cursors?.deals).toBe('deals-tail');
    expect(result.next_cursors?.companies).toBeUndefined();
  });

  it('include_contacts: true adds the contacts leg + bumps api_calls_consumed', async () => {
    const fetcher = (async (url: string): Promise<Response> => {
      if (url.includes('/contacts')) return okJson({ results: [{ toObjectId: 5001 }] });
      return okJson({ results: [] });
    }) as never;
    const result = await fetchHubSpotEngagementAssociations({
      connection: fakeConnection,
      entity: 'meeting',
      raw_id: '301',
      search: { fetcher, refreshAuth },
      include_contacts: true,
    });
    expect(result.associations.contacts).toEqual(['5001']);
    expect(result.api_calls_consumed).toBe(3);
  });

  it('source_record_missing flips when ANY leg returns 404', async () => {
    const fetcher = (async (url: string): Promise<Response> => {
      if (url.includes('/companies')) return notFound();
      return okJson({ results: [] });
    }) as never;
    const result = await fetchHubSpotEngagementAssociations({
      connection: fakeConnection,
      entity: 'email',
      raw_id: '47291',
      search: { fetcher, refreshAuth },
    });
    expect(result.source_record_missing).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────
// Reconciler ingest — deal/account edges from crmAssociations
// ────────────────────────────────────────────────────────────────

describe('D-139 P1a.1.1 — reconciler ingest emits deal/account edges from crmAssociations', () => {
  it('email reconciler: deal + account edges + header-derived contact edges', () => {
    const { store } = makeStores();
    const reconciler = new HubSpotEmailEngagementReconciler({
      search: { refreshAuth },
      engagementStore: store,
      now: () => FIXED_NOW,
    });
    const slim = {
      id: 'hubspot_email_47291',
      modified_at: FIXED_NOW,
      _raw: rawEmail(),
    };
    const result = reconciler.ingest('acme-hubspot', slim, {
      deals: ['47291', '47292'],
      companies: ['8839'],
    });
    expect(result.row.target_id).toBe('hubspot_email_47291');
    const edges = store.listEdges({
      connection_id: 'acme-hubspot',
      engagement_target_id: 'hubspot_email_47291',
    });
    const dealEdges = edges.filter((e) => e.edge_type === 'deal');
    const accountEdges = edges.filter((e) => e.edge_type === 'account');
    const contactEdges = edges.filter((e) => e.edge_type === 'contact');
    expect(dealEdges.map((e) => e.target_id)).toEqual([
      'hubspot_deal_acme-hubspot_47291',
      'hubspot_deal_acme-hubspot_47292',
    ]);
    expect(accountEdges.map((e) => e.target_id)).toEqual([
      'hubspot_company_acme-hubspot_8839',
    ]);
    // Header-derived contact edges still emit at P1a.1.1 (CRM-side
    // contact emission is deferred — see note-engagement-reconciler
    // boundary note).
    expect(contactEdges.length).toBeGreaterThan(0);
    // Deal + account edges target `'connection.api'` per § A.4 closed
    // list; contact edges target `'data.contact'`.
    expect(dealEdges.every((e) => e.target_kind === 'connection.api')).toBe(
      true,
    );
    expect(
      accountEdges.every((e) => e.target_kind === 'connection.api'),
    ).toBe(true);
  });

  it('meeting reconciler: deal + account edges land alongside attendee-derived contacts', () => {
    const { store } = makeStores();
    const reconciler = new HubSpotMeetingEngagementReconciler({
      search: { refreshAuth },
      engagementStore: store,
      now: () => FIXED_NOW,
    });
    const slim = {
      id: 'hubspot_meeting_301',
      modified_at: FIXED_NOW,
      _raw: {
        id: '301',
        properties: {
          hs_meeting_title: 'Q3 sync',
          hs_meeting_start_time: '1714000000000',
          hs_meeting_end_time: '1714003600000',
          hs_meeting_outcome: '',
          hs_meeting_location: '',
          hs_meeting_external_url: '',
          hs_meeting_body: '',
          attendee_emails: 'bob@acme.com',
          hs_lastmodifieddate: '1714867200000',
          hs_createdate: '1714000000000',
          hubspot_owner_id: '777',
          hs_created_by_workflow_id: '',
          hs_created_via_workflow: '',
          hs_import_id: '',
        },
      } as RawHubSpotRecord,
    };
    reconciler.ingest('acme-hubspot', slim, {
      deals: ['1001'],
      companies: ['9001'],
    });
    const edges = store.listEdges({
      connection_id: 'acme-hubspot',
      engagement_target_id: 'hubspot_meeting_301',
    });
    expect(edges.some((e) => e.edge_type === 'deal' && e.target_id === 'hubspot_deal_acme-hubspot_1001')).toBe(true);
    expect(
      edges.some(
        (e) => e.edge_type === 'account' && e.target_id === 'hubspot_company_acme-hubspot_9001',
      ),
    ).toBe(true);
  });

  it('note / call / task reconcilers: deal + account edges emit; contact edges out-of-scope at P1a.1.1', () => {
    const { store } = makeStores();
    const note = new HubSpotNoteEngagementReconciler({
      search: { refreshAuth },
      engagementStore: store,
      now: () => FIXED_NOW,
    });
    const call = new HubSpotCallEngagementReconciler({
      search: { refreshAuth },
      engagementStore: store,
      now: () => FIXED_NOW,
    });
    const task = new HubSpotTaskEngagementReconciler({
      search: { refreshAuth },
      engagementStore: store,
      now: () => FIXED_NOW,
    });
    const noteSlim = {
      id: 'hubspot_note_500',
      modified_at: FIXED_NOW,
      _raw: {
        id: '500',
        properties: {
          hs_note_body: 'Sales meeting notes',
          hs_lastmodifieddate: '1714867200000',
          hs_createdate: '1714000000000',
          hubspot_owner_id: '777',
          hs_created_by_workflow_id: '',
          hs_created_via_workflow: '',
          hs_import_id: '',
        },
      } as RawHubSpotRecord,
    };
    note.ingest('acme-hubspot', noteSlim, {
      deals: ['1001'],
      companies: ['9001'],
      contacts: ['5001'], // Should be ignored at P1a.1.1.
    });
    const noteEdges = store.listEdges({
      connection_id: 'acme-hubspot',
      engagement_target_id: 'hubspot_note_500',
    });
    expect(noteEdges.some((e) => e.edge_type === 'deal')).toBe(true);
    expect(noteEdges.some((e) => e.edge_type === 'account')).toBe(true);
    expect(noteEdges.some((e) => e.edge_type === 'contact')).toBe(false);

    const callSlim = {
      id: 'hubspot_call_600',
      modified_at: FIXED_NOW,
      _raw: {
        id: '600',
        properties: {
          hs_call_status: 'COMPLETED',
          hs_call_direction: 'INBOUND',
          hs_call_body: '',
          hs_call_disposition: '',
          hs_call_duration: '300',
          hs_call_recording_url: '',
          hs_call_title: 'Discovery call',
          hs_timestamp: '1714867200000',
          hs_createdate: '1714000000000',
          hs_lastmodifieddate: '1714867200000',
          hubspot_owner_id: '777',
          hs_created_by_workflow_id: '',
          hs_created_via_workflow: '',
          hs_import_id: '',
        },
      } as RawHubSpotRecord,
    };
    call.ingest('acme-hubspot', callSlim, {
      deals: ['1001'],
      companies: [],
    });
    const callEdges = store.listEdges({
      connection_id: 'acme-hubspot',
      engagement_target_id: 'hubspot_call_600',
    });
    expect(callEdges.some((e) => e.edge_type === 'deal')).toBe(true);

    const taskSlim = {
      id: 'hubspot_task_700',
      modified_at: FIXED_NOW,
      _raw: rawTask({}, '700'),
    };
    task.ingest('acme-hubspot', taskSlim, {
      deals: [],
      companies: ['9002'],
    });
    const taskEdges = store.listEdges({
      connection_id: 'acme-hubspot',
      engagement_target_id: 'hubspot_task_700',
    });
    expect(taskEdges.some((e) => e.edge_type === 'account')).toBe(true);
  });

  it('Codex P1 #3 — ingestWithAssociations fetches deal+account edges before writing row (transactional row+edge)', async () => {
    const { store } = makeStores();
    const fetcher = (async (url: string): Promise<Response> => {
      if (url.includes('/deals')) {
        return okJson({ results: [{ toObjectId: 47291 }] });
      }
      if (url.includes('/companies')) {
        return okJson({ results: [{ toObjectId: 8839 }] });
      }
      return okJson({ results: [] });
    }) as never;
    const reconciler = new HubSpotEmailEngagementReconciler({
      search: { fetcher, refreshAuth },
      engagementStore: store,
      now: () => FIXED_NOW,
    });
    const slim = {
      id: 'hubspot_email_47291',
      modified_at: FIXED_NOW,
      _raw: rawEmail(),
    };
    const out = await reconciler.ingestWithAssociations(
      fakeConnection,
      'acme-hubspot',
      slim,
    );
    expect(out.associations_fetched).toBe(true);
    const edges = store.listEdges({
      connection_id: 'acme-hubspot',
      engagement_target_id: 'hubspot_email_47291',
    });
    expect(edges.some((e) => e.edge_type === 'deal')).toBe(true);
    expect(edges.some((e) => e.edge_type === 'account')).toBe(true);
  });

  it('Codex P1 #3 — ingestWithAssociations falls back gracefully when fetcher throws (rescan covers gap)', async () => {
    const { store } = makeStores();
    const fetcher = (async (): Promise<Response> => {
      throw new Error('network down');
    }) as never;
    const reconciler = new HubSpotEmailEngagementReconciler({
      search: { fetcher, refreshAuth },
      engagementStore: store,
      now: () => FIXED_NOW,
    });
    const slim = {
      id: 'hubspot_email_47291',
      modified_at: FIXED_NOW,
      _raw: rawEmail(),
    };
    const out = await reconciler.ingestWithAssociations(
      fakeConnection,
      'acme-hubspot',
      slim,
    );
    expect(out.associations_fetched).toBe(false);
    // Row still lands so producers see the engagement; rescan will
    // pick up the deal/account edges later.
    expect(out.row).toBeDefined();
    const edges = store.listEdges({
      connection_id: 'acme-hubspot',
      engagement_target_id: 'hubspot_email_47291',
    });
    expect(edges.some((e) => e.edge_type === 'deal')).toBe(false);
    expect(edges.some((e) => e.edge_type === 'contact')).toBe(true);
  });

  it('omitting crmAssociations falls back to P1a.1 behavior — header-derived contacts only, no deal/account edges', () => {
    const { store } = makeStores();
    const reconciler = new HubSpotEmailEngagementReconciler({
      search: { refreshAuth },
      engagementStore: store,
      now: () => FIXED_NOW,
    });
    reconciler.ingest('acme-hubspot', {
      id: 'hubspot_email_47291',
      modified_at: FIXED_NOW,
      _raw: rawEmail(),
    });
    const edges = store.listEdges({
      connection_id: 'acme-hubspot',
      engagement_target_id: 'hubspot_email_47291',
    });
    expect(edges.some((e) => e.edge_type === 'deal')).toBe(false);
    expect(edges.some((e) => e.edge_type === 'account')).toBe(false);
    expect(edges.some((e) => e.edge_type === 'contact')).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────
// TZ-correct task due_at midnight
// ────────────────────────────────────────────────────────────────

describe('D-139 P1a.1.1 — TZ-correct date-only task due_at midnight', () => {
  it('UTC tz: date-only due-date lands at UTC midnight (parity with parseUnixMs)', () => {
    expect(computeLocalDayMidnightUtc('2026-05-04', 'UTC')).toBe(
      Date.parse('2026-05-04T00:00:00Z'),
    );
  });

  it('Etc/UTC + GMT shortcuts also land at UTC midnight', () => {
    expect(computeLocalDayMidnightUtc('2026-05-04', 'Etc/UTC')).toBe(
      Date.parse('2026-05-04T00:00:00Z'),
    );
    expect(computeLocalDayMidnightUtc('2026-05-04', 'GMT')).toBe(
      Date.parse('2026-05-04T00:00:00Z'),
    );
  });

  it('America/New_York: 2026-05-04 lands at 2026-05-04T04:00:00Z (00:00 EDT)', () => {
    expect(
      computeLocalDayMidnightUtc('2026-05-04', 'America/New_York'),
    ).toBe(Date.parse('2026-05-04T04:00:00Z'));
  });

  it('Europe/Berlin: 2026-05-04 lands at 2026-05-03T22:00:00Z (00:00 CEST)', () => {
    expect(computeLocalDayMidnightUtc('2026-05-04', 'Europe/Berlin')).toBe(
      Date.parse('2026-05-03T22:00:00Z'),
    );
  });

  it('Asia/Tokyo: 2026-05-04 lands at 2026-05-03T15:00:00Z (00:00 JST UTC+9)', () => {
    expect(computeLocalDayMidnightUtc('2026-05-04', 'Asia/Tokyo')).toBe(
      Date.parse('2026-05-03T15:00:00Z'),
    );
  });

  it('Australia/Adelaide: 2026-05-04 lands at 2026-05-03T14:30:00Z (00:00 ACST UTC+9:30)', () => {
    expect(
      computeLocalDayMidnightUtc('2026-05-04', 'Australia/Adelaide'),
    ).toBe(Date.parse('2026-05-03T14:30:00Z'));
  });

  it('unknown tz falls back to UTC midnight (matches `tz_inferred` coverage hint)', () => {
    expect(
      computeLocalDayMidnightUtc('2026-05-04', 'Made/Up_Zone'),
    ).toBe(Date.parse('2026-05-04T00:00:00Z'));
  });

  it('non-date-only inputs return null (numeric / malformed)', () => {
    expect(computeLocalDayMidnightUtc('1714867200000', 'UTC')).toBe(null);
    expect(computeLocalDayMidnightUtc('not-a-date', 'UTC')).toBe(null);
    expect(computeLocalDayMidnightUtc('', 'UTC')).toBe(null);
    expect(computeLocalDayMidnightUtc(null, 'UTC')).toBe(null);
  });

  it('task projection for Berlin user: due_at lands at local midnight, not UTC midnight', () => {
    const row = projectTaskEngagementRow('acme-hubspot', rawTask(), {
      now: FIXED_NOW,
      defaultTzHint: 'Europe/Berlin',
    });
    expect(row.due_at).toBe(Date.parse('2026-05-03T22:00:00Z'));
    expect(row.due_at_is_date_only).toBe(true);
    expect(row.event_at).toBe(null); // Pending — § A.3.1.
    expect(row.event_at_tz_hint).toBe('Europe/Berlin');
  });

  it('task projection for NYC user: due_at lands at NYC midnight (4h after UTC midnight)', () => {
    const row = projectTaskEngagementRow('acme-hubspot', rawTask(), {
      now: FIXED_NOW,
      defaultTzHint: 'America/New_York',
    });
    expect(row.due_at).toBe(Date.parse('2026-05-04T04:00:00Z'));
    expect(row.due_at_is_date_only).toBe(true);
  });

  it('task projection for UTC user: due_at lands at UTC midnight (parity check vs P1a.2)', () => {
    const row = projectTaskEngagementRow('acme-hubspot', rawTask(), {
      now: FIXED_NOW,
      defaultTzHint: 'UTC',
    });
    expect(row.due_at).toBe(Date.parse('2026-05-04T00:00:00Z'));
  });

  it('task with numeric (non-date-only) due timestamp: TZ helper not used; parseUnixMs path', () => {
    const row = projectTaskEngagementRow(
      'acme-hubspot',
      rawTask({ hs_task_completion_date: '1714867200000' }),
      {
        now: FIXED_NOW,
        defaultTzHint: 'Europe/Berlin',
      },
    );
    expect(row.due_at).toBe(1714867200000);
    expect(row.due_at_is_date_only).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────
// Email webhook applyAssociationChange — edge-only write path
// ────────────────────────────────────────────────────────────────

describe('D-139 P1a.1.1 — email webhook applyAssociationChange edge-only write path', () => {
  const buildWebhookFetcher = (
    capturedDealIds: string[] = ['47291'],
    capturedCompanyIds: string[] = ['8839'],
  ): typeof fetch =>
    (async (url: string): Promise<Response> => {
      if (url.includes('/deals')) {
        return okJson({
          results: capturedDealIds.map((id) => ({ toObjectId: id })),
        });
      }
      if (url.includes('/companies')) {
        return okJson({
          results: capturedCompanyIds.map((id) => ({ toObjectId: id })),
        });
      }
      return okJson({ results: [] });
    }) as never;

  it('applier writes deal + account edges; ledger inserts AFTER write succeeds', async () => {
    const { store, rcStore, db } = makeStores();
    const fetcher = buildWebhookFetcher(['47291'], ['8839']);
    const applier = buildHubSpotEngagementAssociationChangeApplier({
      engagementStore: store,
      rateControlStore: rcStore,
      search: { fetcher, refreshAuth },
      resolveContactRedirect: () => null,
    });
    const processor = buildHubSpotEmailEngagementWebhookProcessor({
      search: { fetcher, refreshAuth },
      lookupConnection: async () => fakeConnection,
      engagementStore: store,
      now: () => FIXED_NOW,
      applyAssociationChange: applier,
    });
    const out = await processor.parseEvents(
      [{ subscriptionType: 'email.associationChange', objectId: 47291, eventId: 9999 }],
      {},
      'acme-hubspot',
    );
    expect(out.length).toBe(0); // Edge-only — no slim event for harness.
    const edges = store.listEdges({
      connection_id: 'acme-hubspot',
      engagement_target_id: 'hubspot_email_47291',
    });
    expect(edges.some((e) => e.edge_type === 'deal')).toBe(true);
    expect(edges.some((e) => e.edge_type === 'account')).toBe(true);
    // Ledger entry exists — webhook factory ledgered AFTER applier
    // returned successfully.
    const ledger = store.lookupInboundEvent({
      connection_id: 'acme-hubspot',
      vendor: 'hubspot',
      idempotency_key: '9999-email.associationChange',
    });
    expect(ledger.exists).toBe(true);
    // Sanity: only ONE ledger row landed.
    const ledgerCount = (
      db
        .prepare('SELECT COUNT(*) AS n FROM engagement_inbound_event_ledger')
        .get() as { n: number }
    ).n;
    expect(ledgerCount).toBe(1);
  });

  it('duplicate webhook delivery: ledger lookup short-circuits; applier called once', async () => {
    const { store, rcStore } = makeStores();
    const fetcher = buildWebhookFetcher();
    let applierCalls = 0;
    const realApplier = buildHubSpotEngagementAssociationChangeApplier({
      engagementStore: store,
      rateControlStore: rcStore,
      search: { fetcher, refreshAuth },
      resolveContactRedirect: () => null,
    });
    const wrappedApplier: typeof realApplier = (input) => {
      applierCalls += 1;
      return realApplier(input);
    };
    const processor = buildHubSpotEmailEngagementWebhookProcessor({
      search: { fetcher, refreshAuth },
      lookupConnection: async () => fakeConnection,
      engagementStore: store,
      now: () => FIXED_NOW,
      applyAssociationChange: wrappedApplier,
    });
    await processor.parseEvents(
      [{ subscriptionType: 'email.associationChange', objectId: 47291, eventId: 9999 }],
      {},
      'acme-hubspot',
    );
    await processor.parseEvents(
      [{ subscriptionType: 'email.associationChange', objectId: 47291, eventId: 9999 }],
      {},
      'acme-hubspot',
    );
    expect(applierCalls).toBe(1);
  });

  it('applier throw: ledger left empty so HubSpot webhook retry re-attempts', async () => {
    const { store, rcStore, db } = makeStores();
    const failingApplier = (async () => {
      throw new Error('upstream 500');
    }) as never;
    const processor = buildHubSpotEmailEngagementWebhookProcessor({
      search: { refreshAuth },
      lookupConnection: async () => fakeConnection,
      engagementStore: store,
      now: () => FIXED_NOW,
      applyAssociationChange: failingApplier,
    });
    await processor.parseEvents(
      [{ subscriptionType: 'email.associationChange', objectId: 47291, eventId: 9999 }],
      {},
      'acme-hubspot',
    );
    const ledgerCount = (
      db
        .prepare('SELECT COUNT(*) AS n FROM engagement_inbound_event_ledger')
        .get() as { n: number }
    ).n;
    expect(ledgerCount).toBe(0);
    void rcStore; // suppress unused
  });

  it('applier reports source_record_missing: skip ledger insert (engagement deleted in flight)', async () => {
    const { store, rcStore, db } = makeStores();
    const fetcher = (async (url: string): Promise<Response> => {
      if (url.includes('/deals') || url.includes('/companies')) {
        return notFound(); // FROM-record gone.
      }
      return okJson({ results: [] });
    }) as never;
    const applier = buildHubSpotEngagementAssociationChangeApplier({
      engagementStore: store,
      rateControlStore: rcStore,
      search: { fetcher, refreshAuth },
      resolveContactRedirect: () => null,
    });
    const processor = buildHubSpotEmailEngagementWebhookProcessor({
      search: { fetcher, refreshAuth },
      lookupConnection: async () => fakeConnection,
      engagementStore: store,
      now: () => FIXED_NOW,
      applyAssociationChange: applier,
    });
    await processor.parseEvents(
      [{ subscriptionType: 'email.associationChange', objectId: 47291, eventId: 9999 }],
      {},
      'acme-hubspot',
    );
    const ledgerCount = (
      db
        .prepare('SELECT COUNT(*) AS n FROM engagement_inbound_event_ledger')
        .get() as { n: number }
    ).n;
    expect(ledgerCount).toBe(0);
  });

  it('Codex P1 #1 — applier reports retryable_failure when rate-control is suspended; ledger stays empty', async () => {
    const { store, rcStore, db } = makeStores();
    // Pre-suspend the budget.
    rcStore.setBudget({
      connection_id: 'acme-hubspot',
      vendor: 'hubspot',
      daily_budget: 1,
      now: FIXED_NOW,
    });
    rcStore.recordUsage({
      connection_id: 'acme-hubspot',
      vendor: 'hubspot',
      n: 1,
      now: FIXED_NOW,
    });
    const fetcher = (async () => okJson({ results: [] })) as never;
    const applier = buildHubSpotEngagementAssociationChangeApplier({
      engagementStore: store,
      rateControlStore: rcStore,
      search: { fetcher, refreshAuth },
      resolveContactRedirect: () => null,
    });
    const processor = buildHubSpotEmailEngagementWebhookProcessor({
      search: { fetcher, refreshAuth },
      lookupConnection: async () => fakeConnection,
      engagementStore: store,
      now: () => FIXED_NOW,
      applyAssociationChange: applier,
    });
    await processor.parseEvents(
      [{ subscriptionType: 'email.associationChange', objectId: 47291, eventId: 9999 }],
      {},
      'acme-hubspot',
    );
    // Ledger MUST stay empty — HubSpot will redeliver.
    const ledgerCount = (
      db
        .prepare('SELECT COUNT(*) AS n FROM engagement_inbound_event_ledger')
        .get() as { n: number }
    ).n;
    expect(ledgerCount).toBe(0);
  });

  it('Codex P2 #2 — fetcher 429 triggers recordTooManyRequests + retryable_failure; ledger stays empty', async () => {
    const { store, rcStore, db } = makeStores();
    const fetcher = (async (): Promise<Response> =>
      ({
        ok: false,
        status: 429,
        headers: new Headers({ 'Retry-After': '0' }),
        json: async () => ({}),
        text: async () => 'rate limited',
      }) as never) as never;
    const applier = buildHubSpotEngagementAssociationChangeApplier({
      engagementStore: store,
      rateControlStore: rcStore,
      search: {
        fetcher,
        refreshAuth,
        rateLimitMaxRetries: 0, // Skip retry loop so 429 bubbles immediately.
        sleep: async () => undefined,
      },
      resolveContactRedirect: () => null,
    });
    const processor = buildHubSpotEmailEngagementWebhookProcessor({
      search: { fetcher, refreshAuth },
      lookupConnection: async () => fakeConnection,
      engagementStore: store,
      now: () => FIXED_NOW,
      applyAssociationChange: applier,
    });
    await processor.parseEvents(
      [{ subscriptionType: 'email.associationChange', objectId: 47291, eventId: 9999 }],
      {},
      'acme-hubspot',
    );
    // Ledger MUST stay empty for retryable failure.
    const ledgerCount = (
      db
        .prepare('SELECT COUNT(*) AS n FROM engagement_inbound_event_ledger')
        .get() as { n: number }
    ).n;
    expect(ledgerCount).toBe(0);
    // Per-tuple backoff was recorded.
    const backoff = rcStore.readBackoff({
      connection_id: 'acme-hubspot',
      vendor: 'hubspot',
      entity: 'email',
    });
    expect(backoff.consecutive_429s).toBeGreaterThanOrEqual(1);
  });

  it('applier wired but no callback supplied → falls back to P1a.2 pass-through behavior', async () => {
    const { store, db } = makeStores();
    const processor = buildHubSpotEmailEngagementWebhookProcessor({
      search: { refreshAuth },
      lookupConnection: async () => fakeConnection,
      engagementStore: store,
      now: () => FIXED_NOW,
      // applyAssociationChange omitted.
    });
    const out = await processor.parseEvents(
      [{ subscriptionType: 'email.associationChange', objectId: 47291, eventId: 9999 }],
      {},
      'acme-hubspot',
    );
    expect(out.length).toBe(0);
    const ledgerCount = (
      db
        .prepare('SELECT COUNT(*) AS n FROM engagement_inbound_event_ledger')
        .get() as { n: number }
    ).n;
    expect(ledgerCount).toBe(0);
  });

  it('applier diff: tombstones edges that disappeared; emits new edges', async () => {
    const { store, rcStore } = makeStores();
    // Seed an existing deal edge that's no longer in the CRM-side
    // associations.
    const seedRow: EngagementRow = {
      connection_id: 'acme-hubspot',
      target_id: 'hubspot_email_47291',
      vendor: 'hubspot',
      entity: 'email',
      meta: {},
      mirror_blob_hash: null,
      authorship: 'user',
      direction: 'inbound',
      dedupe_confidence: 'none',
      lifecycle_state: 'point_in_time',
      event_at: FIXED_NOW,
      vendor_created_at: FIXED_NOW,
      vendor_modified_at: FIXED_NOW,
      ingested_at: FIXED_NOW,
      body_state: 'inline_body',
      body_inline: 'x',
    };
    store.upsert({ row: seedRow });
    store.upsertEdge({
      connection_id: 'acme-hubspot',
      engagement_target_id: 'hubspot_email_47291',
      edge_type: 'deal',
      target_kind: 'connection.api',
      target_id: 'hubspot_deal_OLD',
      vendor: 'hubspot',
      created_at: FIXED_NOW - 1000,
    });
    const fetcher = (async (url: string): Promise<Response> => {
      if (url.includes('/deals')) {
        return okJson({ results: [{ toObjectId: 47291 }] });
      }
      if (url.includes('/companies')) {
        return okJson({ results: [] });
      }
      return okJson({ results: [] });
    }) as never;
    const applier = buildHubSpotEngagementAssociationChangeApplier({
      engagementStore: store,
      rateControlStore: rcStore,
      search: { fetcher, refreshAuth },
      resolveContactRedirect: () => null,
    });
    await applier({
      connection: fakeConnection,
      connection_id: 'acme-hubspot',
      entity: 'email',
      target_id: 'hubspot_email_47291',
      raw_id: '47291',
      now: FIXED_NOW,
    });
    const edges = store.listEdges({
      connection_id: 'acme-hubspot',
      engagement_target_id: 'hubspot_email_47291',
      include_deleted: true,
    });
    const oldEdge = edges.find((e) => e.target_id === 'hubspot_deal_OLD');
    const newEdge = edges.find((e) => e.target_id === 'hubspot_deal_acme-hubspot_47291');
    expect(oldEdge?.deleted_at).toBeGreaterThan(0);
    expect(newEdge).toBeDefined();
    expect(newEdge?.deleted_at).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────
// Canary end-to-end deal-edge — engagement_silence_duration query path
// ────────────────────────────────────────────────────────────────

describe('D-139 P1a.1.1 — canary end-to-end deal-edge for engagement_silence_duration', () => {
  it('reconciler ingest with crmAssociations.deals → edge_type=deal row → query pattern resolves engagement set per deal', () => {
    const { store } = makeStores();
    const reconciler = new HubSpotEmailEngagementReconciler({
      search: { refreshAuth },
      engagementStore: store,
      now: () => FIXED_NOW,
    });

    // Three inbound emails on deal hubspot_deal_47291 across 3 days.
    const inbound = (id: string, ts: number): {
      id: string;
      modified_at: number;
      _raw: RawHubSpotRecord;
    } => ({
      id: `hubspot_email_${id}`,
      modified_at: ts,
      _raw: rawEmail(
        {
          hs_email_direction: 'INCOMING_EMAIL',
          hs_email_status: 'SENT',
          hs_email_from_email: `prospect${id}@acme.com`,
          hs_email_to_email: 'rep@recued.com',
          hs_email_internet_message_id: `<msg-${id}@example.com>`,
          hs_timestamp: String(ts),
          hs_lastmodifieddate: String(ts + 100),
          hs_createdate: String(ts - 1000),
        },
        id,
      ),
    });

    const day = 24 * 60 * 60 * 1000;
    reconciler.ingest('acme-hubspot', inbound('1', FIXED_NOW - 5 * day), {
      deals: ['47291'],
      companies: [],
    });
    reconciler.ingest('acme-hubspot', inbound('2', FIXED_NOW - 2 * day), {
      deals: ['47291'],
      companies: [],
    });
    reconciler.ingest('acme-hubspot', inbound('3', FIXED_NOW - 1 * day), {
      deals: ['47291'],
      companies: [],
    });
    // Different deal — should NOT count.
    reconciler.ingest('acme-hubspot', inbound('4', FIXED_NOW), {
      deals: ['47999'],
      companies: [],
    });

    // Producer-side query: engagements on hubspot_deal_47291 with
    // event_at IS NOT NULL + lifecycle_state=point_in_time +
    // direction='inbound'. Walk engagement_edges → engagements →
    // filter → max(event_at) → days-since-now.
    const dealEdges = store.listEdges({
      connection_id: 'acme-hubspot',
      edge_type: 'deal',
      target_id: 'hubspot_deal_acme-hubspot_47291',
    });
    expect(dealEdges.length).toBe(3); // Three engagements on this deal.

    let lastInbound = 0;
    for (const edge of dealEdges) {
      const engagement = store.get(
        edge.connection_id,
        edge.engagement_target_id,
      );
      if (engagement === null) continue;
      if (engagement.event_at === null) continue;
      if (engagement.lifecycle_state !== 'point_in_time') continue;
      if (engagement.direction !== 'inbound') continue;
      if (
        engagement.authorship === 'crm_automation' ||
        engagement.authorship === 'system_process'
      ) {
        continue;
      }
      lastInbound = Math.max(lastInbound, engagement.event_at);
    }
    expect(lastInbound).toBe(FIXED_NOW - 1 * day);
    const days = Math.floor((FIXED_NOW - lastInbound) / day);
    expect(days).toBe(1); // Per `engagement_silence_duration.days`.
  });

  it('association-rescan path also lands deal edges → producer query resolves identically', async () => {
    const { store, capStore, rcStore } = makeStores();
    capStore.upsert({
      connection_id: 'acme-hubspot',
      vendor: 'hubspot',
      entity: 'email',
      available: true,
      association_rescan_required: true,
      last_probed_at: FIXED_NOW,
    });
    // Seed a row.
    store.upsert({
      row: {
        connection_id: 'acme-hubspot',
        target_id: 'hubspot_email_47291',
        vendor: 'hubspot',
        entity: 'email',
        meta: {},
        mirror_blob_hash: null,
        authorship: 'user',
        direction: 'inbound',
        dedupe_confidence: 'none',
        lifecycle_state: 'point_in_time',
        event_at: FIXED_NOW - 86_400_000,
        vendor_created_at: FIXED_NOW - 86_400_000,
        vendor_modified_at: FIXED_NOW - 86_400_000,
        ingested_at: FIXED_NOW - 86_400_000,
        body_state: 'inline_body',
        body_inline: 'x',
      },
    });

    // Use the rescan substrate via runAssociationRescan. (Imported
    // ad-hoc to avoid a top-level cycle with the canary-test focus.)
    const { runAssociationRescan } = await import(
      '../data/hubspot/association-rescan.js'
    );
    const out = await runAssociationRescan(
      {
        connection: fakeConnection,
        connection_id: 'acme-hubspot',
        vendor: 'hubspot',
        entity: 'email',
        fetcher: () => ({
          edges: [
            {
              edge_type: 'deal',
              target_kind: 'connection.api',
              target_id: 'hubspot_deal_47291',
            },
          ],
          api_calls_consumed: 2,
        }),
        now: FIXED_NOW,
        resolveContactRedirect: () => null,
      },
      {
        engagementStore: store,
        capabilityStore: capStore,
        rateControlStore: rcStore,
      },
    );
    expect(out.edges_created).toBe(1);
    const edges = store.listEdges({
      connection_id: 'acme-hubspot',
      edge_type: 'deal',
      target_id: 'hubspot_deal_47291',
    });
    expect(edges.length).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────────
// engagement-store ledger lookupInboundEvent surface
// ────────────────────────────────────────────────────────────────

describe('D-139 P1a.1.1 — engagement-store lookupInboundEvent', () => {
  it('returns { exists: false } for novel triple', () => {
    const { store } = makeStores();
    const result = store.lookupInboundEvent({
      connection_id: 'acme-hubspot',
      vendor: 'hubspot',
      idempotency_key: 'event-1',
    });
    expect(result.exists).toBe(false);
  });

  it('returns { exists: true, observed_at } after a checkAndInsert', () => {
    const { store } = makeStores();
    store.checkAndInsertInboundEvent({
      connection_id: 'acme-hubspot',
      vendor: 'hubspot',
      idempotency_key: 'event-1',
      delivery_path: 'webhook',
      observed_at: FIXED_NOW,
    });
    const result = store.lookupInboundEvent({
      connection_id: 'acme-hubspot',
      vendor: 'hubspot',
      idempotency_key: 'event-1',
    });
    expect(result.exists).toBe(true);
    if (result.exists) {
      expect(result.observed_at).toBe(FIXED_NOW);
    }
  });

  it('throws on empty idempotency_key', () => {
    const { store } = makeStores();
    expect(() =>
      store.lookupInboundEvent({
        connection_id: 'acme-hubspot',
        vendor: 'hubspot',
        idempotency_key: '',
      }),
    ).toThrow();
  });
});

// ────────────────────────────────────────────────────────────────
// D-139 P1a.1.2 — connection-delete cascade (rows + edges per § A.10)
// ────────────────────────────────────────────────────────────────

describe('D-139 P1a.1.2 — connection-delete cascade for engagement rows', () => {
  it('tombstoneEngagementRowsForConnection sets deleted_at + provenance on every connection-scoped row', () => {
    const { store } = makeStores();
    store.upsert({
      row: {
        connection_id: 'acme-hubspot',
        target_id: 'hubspot_email_1',
        vendor: 'hubspot',
        entity: 'email',
        meta: {},
        mirror_blob_hash: null,
        authorship: 'user',
        direction: 'inbound',
        dedupe_confidence: 'none',
        lifecycle_state: 'point_in_time',
        event_at: FIXED_NOW,
        vendor_created_at: FIXED_NOW,
        vendor_modified_at: FIXED_NOW,
        ingested_at: FIXED_NOW,
        body_state: 'inline_body',
        body_inline: 'x',
      },
    });
    const tombstoned = store.tombstoneEngagementRowsForConnection(
      'acme-hubspot',
      FIXED_NOW + 1000,
    );
    expect(tombstoned).toBe(1);
    const row = store.get('acme-hubspot', 'hubspot_email_1');
    expect(row).not.toBeNull();
    expect(row!.deleted_at).toBe(FIXED_NOW + 1000);
    expect(row!.deletion_provenance?.actor).toBe(
      'connection_delete:acme-hubspot',
    );
  });

  it('two-portal isolation: cascade scoped to connection_id; sibling portal unaffected', () => {
    const { store } = makeStores();
    // Two HubSpot connections in the same DB — both holding rows for
    // the same vendor-native id `47291` (allowed under Pass-3 R3.2's
    // composite primary key `(connection_id, target_id)`).
    const seedRow = (connection_id: string): EngagementRow => ({
      connection_id,
      target_id: 'hubspot_email_47291',
      vendor: 'hubspot',
      entity: 'email',
      meta: {},
      mirror_blob_hash: null,
      authorship: 'user',
      direction: 'inbound',
      dedupe_confidence: 'none',
      lifecycle_state: 'point_in_time',
      event_at: FIXED_NOW,
      vendor_created_at: FIXED_NOW,
      vendor_modified_at: FIXED_NOW,
      ingested_at: FIXED_NOW,
      body_state: 'inline_body',
      body_inline: 'x',
    });
    store.upsert({ row: seedRow('acme-hubspot') });
    store.upsert({ row: seedRow('partner-hubspot') });
    store.upsertEdge({
      connection_id: 'acme-hubspot',
      engagement_target_id: 'hubspot_email_47291',
      edge_type: 'deal',
      target_kind: 'connection.api',
      target_id: 'hubspot_deal_1',
      vendor: 'hubspot',
      created_at: FIXED_NOW,
    });
    store.upsertEdge({
      connection_id: 'partner-hubspot',
      engagement_target_id: 'hubspot_email_47291',
      edge_type: 'deal',
      target_kind: 'connection.api',
      target_id: 'hubspot_deal_2',
      vendor: 'hubspot',
      created_at: FIXED_NOW,
    });

    const rows = store.tombstoneEngagementRowsForConnection(
      'acme-hubspot',
      FIXED_NOW + 100,
    );
    const edges = store.tombstoneEdgesForConnection(
      'acme-hubspot',
      FIXED_NOW + 100,
    );
    expect(rows).toBe(1);
    expect(edges).toBe(1);

    // acme-hubspot is tombstoned.
    const acmeRow = store.get('acme-hubspot', 'hubspot_email_47291');
    expect(acmeRow!.deleted_at).toBe(FIXED_NOW + 100);
    const acmeEdges = store.listEdges({ connection_id: 'acme-hubspot' });
    expect(acmeEdges).toHaveLength(0); // active filter excludes tombstoned

    // partner-hubspot is intact.
    const partnerRow = store.get('partner-hubspot', 'hubspot_email_47291');
    expect(partnerRow!.deleted_at).toBeUndefined();
    const partnerEdges = store.listEdges({ connection_id: 'partner-hubspot' });
    expect(partnerEdges).toHaveLength(1);
  });

  it('cascade is no-op when connection had no engagement rows', () => {
    const { store } = makeStores();
    const tombstoned = store.tombstoneEngagementRowsForConnection(
      'never-enrolled',
      FIXED_NOW,
    );
    expect(tombstoned).toBe(0);
  });

  it('cascade does not re-tombstone already-deleted rows', () => {
    const { store } = makeStores();
    store.upsert({
      row: {
        connection_id: 'acme-hubspot',
        target_id: 'hubspot_email_1',
        vendor: 'hubspot',
        entity: 'email',
        meta: {},
        mirror_blob_hash: null,
        authorship: 'user',
        direction: 'inbound',
        dedupe_confidence: 'none',
        lifecycle_state: 'point_in_time',
        event_at: FIXED_NOW,
        vendor_created_at: FIXED_NOW,
        vendor_modified_at: FIXED_NOW,
        ingested_at: FIXED_NOW,
        body_state: 'inline_body',
        body_inline: 'x',
      },
    });
    store.tombstone({
      connection_id: 'acme-hubspot',
      target_id: 'hubspot_email_1',
      deleted_at: FIXED_NOW + 50,
      actor: 'reconciler',
      vendor_event_id: 'evt-1',
    });
    // Already-tombstoned row's deleted_at stays at the FIRST timestamp.
    const cascadeCount = store.tombstoneEngagementRowsForConnection(
      'acme-hubspot',
      FIXED_NOW + 100,
    );
    expect(cascadeCount).toBe(0);
    const row = store.get('acme-hubspot', 'hubspot_email_1');
    expect(row!.deleted_at).toBe(FIXED_NOW + 50);
  });
});

// ────────────────────────────────────────────────────────────────
// D-139 P1a.1.2 — TZ fallback chain (vendor → calendar → prefs → UTC)
// ────────────────────────────────────────────────────────────────

describe('D-139 P1a.1.2 — § A.3.7 tz fallback chain', () => {
  it('email reconciler: prefsTimezone wins over UTC fallback when defaultTzHint absent', () => {
    const { store } = makeStores();
    const reconciler = new HubSpotEmailEngagementReconciler({
      search: { refreshAuth },
      engagementStore: store,
      now: () => FIXED_NOW,
      prefsTimezone: () => 'America/Los_Angeles',
    });
    const result = reconciler.ingest('acme-hubspot', {
      id: 'hubspot_email_47291',
      modified_at: FIXED_NOW,
      _raw: rawEmail(),
    });
    expect(result.row.event_at_tz_hint).toBe('America/Los_Angeles');
    expect(result.row.event_at_tz_inferred).toBeUndefined();
  });

  it('email reconciler: UTC fallback flips event_at_tz_inferred = true', () => {
    const { store } = makeStores();
    const reconciler = new HubSpotEmailEngagementReconciler({
      search: { refreshAuth },
      engagementStore: store,
      now: () => FIXED_NOW,
      // No defaultTzHint, no prefsTimezone — full chain falls through.
    });
    const result = reconciler.ingest('acme-hubspot', {
      id: 'hubspot_email_47291',
      modified_at: FIXED_NOW,
      _raw: rawEmail(),
    });
    expect(result.row.event_at_tz_hint).toBe('UTC');
    expect(result.row.event_at_tz_inferred).toBe(true);
  });

  it('email reconciler: defaultTzHint (vendor / adapter) wins over prefs', () => {
    const { store } = makeStores();
    const reconciler = new HubSpotEmailEngagementReconciler({
      search: { refreshAuth },
      engagementStore: store,
      now: () => FIXED_NOW,
      defaultTzHint: 'Europe/Berlin',
      prefsTimezone: () => 'America/Los_Angeles',
    });
    const result = reconciler.ingest('acme-hubspot', {
      id: 'hubspot_email_47291',
      modified_at: FIXED_NOW,
      _raw: rawEmail(),
    });
    expect(result.row.event_at_tz_hint).toBe('Europe/Berlin');
    expect(result.row.event_at_tz_inferred).toBeUndefined();
  });

  it('email reconciler: prefsTimezone() returning null falls through to UTC + sets inferred', () => {
    const { store } = makeStores();
    const reconciler = new HubSpotEmailEngagementReconciler({
      search: { refreshAuth },
      engagementStore: store,
      now: () => FIXED_NOW,
      prefsTimezone: () => null,
    });
    const result = reconciler.ingest('acme-hubspot', {
      id: 'hubspot_email_47291',
      modified_at: FIXED_NOW,
      _raw: rawEmail(),
    });
    expect(result.row.event_at_tz_hint).toBe('UTC');
    expect(result.row.event_at_tz_inferred).toBe(true);
  });

  it('task reconciler: prefsTimezone drives date-only due_at canonicalization (Berlin user)', () => {
    const { store } = makeStores();
    const reconciler = new HubSpotTaskEngagementReconciler({
      search: { refreshAuth },
      engagementStore: store,
      now: () => FIXED_NOW,
      prefsTimezone: () => 'Europe/Berlin',
    });
    const result = reconciler.ingest('acme-hubspot', {
      id: 'hubspot_task_700',
      modified_at: FIXED_NOW,
      _raw: rawTask({}, '700'),
    });
    // Berlin user with `prefs.timezone = 'Europe/Berlin'` + no
    // defaultTzHint sees due-date canonicalize to Berlin midnight.
    expect(result.row.due_at).toBe(Date.parse('2026-05-03T22:00:00Z'));
    expect(result.row.event_at_tz_hint).toBe('Europe/Berlin');
    expect(result.row.event_at_tz_inferred).toBeUndefined();
  });

  it('task reconciler: full UTC fallback chain flips inferred + uses UTC midnight', () => {
    const { store } = makeStores();
    const reconciler = new HubSpotTaskEngagementReconciler({
      search: { refreshAuth },
      engagementStore: store,
      now: () => FIXED_NOW,
    });
    const result = reconciler.ingest('acme-hubspot', {
      id: 'hubspot_task_700',
      modified_at: FIXED_NOW,
      _raw: rawTask({}, '700'),
    });
    expect(result.row.due_at).toBe(Date.parse('2026-05-04T00:00:00Z'));
    expect(result.row.event_at_tz_hint).toBe('UTC');
    expect(result.row.event_at_tz_inferred).toBe(true);
  });

  it('meeting reconciler: calendarTwin.tz_hint wins over prefs', () => {
    const { store } = makeStores();
    const reconciler = new HubSpotMeetingEngagementReconciler({
      search: { refreshAuth },
      engagementStore: store,
      now: () => FIXED_NOW,
      calendarTwinFinder: () => ({
        calendar_id: 'cal-1',
        match_key: 'external_url',
        tz_hint: 'Asia/Tokyo',
      }),
      prefsTimezone: () => 'Europe/Berlin',
    });
    const result = reconciler.ingest('acme-hubspot', {
      id: 'hubspot_meeting_301',
      modified_at: FIXED_NOW,
      _raw: {
        id: '301',
        properties: {
          hs_meeting_title: 'Q3 sync',
          hs_meeting_start_time: '1714000000000',
          hs_meeting_end_time: '1714003600000',
          hs_meeting_outcome: '',
          hs_meeting_location: '',
          hs_meeting_external_url: 'https://meet.example/abc',
          hs_meeting_body: '',
          attendee_emails: 'bob@acme.com',
          hs_lastmodifieddate: '1714867200000',
          hs_createdate: '1714000000000',
          hubspot_owner_id: '777',
          hs_created_by_workflow_id: '',
          hs_created_via_workflow: '',
          hs_import_id: '',
        },
      } as RawHubSpotRecord,
    });
    expect(result.row.event_at_tz_hint).toBe('Asia/Tokyo');
    expect(result.row.event_at_tz_inferred).toBeUndefined();
  });

  it('meeting reconciler: no calendar twin + prefsTimezone wins over UTC', () => {
    const { store } = makeStores();
    const reconciler = new HubSpotMeetingEngagementReconciler({
      search: { refreshAuth },
      engagementStore: store,
      now: () => FIXED_NOW,
      prefsTimezone: () => 'Europe/Berlin',
    });
    const result = reconciler.ingest('acme-hubspot', {
      id: 'hubspot_meeting_301',
      modified_at: FIXED_NOW,
      _raw: {
        id: '301',
        properties: {
          hs_meeting_title: 'Q3 sync',
          hs_meeting_start_time: '1714000000000',
          hs_meeting_end_time: '1714003600000',
          hs_meeting_outcome: '',
          hs_meeting_location: '',
          hs_meeting_external_url: '',
          hs_meeting_body: '',
          attendee_emails: 'bob@acme.com',
          hs_lastmodifieddate: '1714867200000',
          hs_createdate: '1714000000000',
          hubspot_owner_id: '777',
          hs_created_by_workflow_id: '',
          hs_created_via_workflow: '',
          hs_import_id: '',
        },
      } as RawHubSpotRecord,
    });
    expect(result.row.event_at_tz_hint).toBe('Europe/Berlin');
    expect(result.row.event_at_tz_inferred).toBeUndefined();
  });

  it('note / call reconcilers: chain reduces to prefs → UTC; both flip inferred when chain falls through', () => {
    const { store } = makeStores();
    const note = new HubSpotNoteEngagementReconciler({
      search: { refreshAuth },
      engagementStore: store,
      now: () => FIXED_NOW,
    });
    const call = new HubSpotCallEngagementReconciler({
      search: { refreshAuth },
      engagementStore: store,
      now: () => FIXED_NOW,
    });
    const noteResult = note.ingest('acme-hubspot', {
      id: 'hubspot_note_500',
      modified_at: FIXED_NOW,
      _raw: {
        id: '500',
        properties: {
          hs_note_body: 'Sales notes',
          hs_lastmodifieddate: '1714867200000',
          hs_createdate: '1714000000000',
          hubspot_owner_id: '777',
          hs_created_by_workflow_id: '',
          hs_created_via_workflow: '',
          hs_import_id: '',
        },
      } as RawHubSpotRecord,
    });
    const callResult = call.ingest('acme-hubspot', {
      id: 'hubspot_call_600',
      modified_at: FIXED_NOW,
      _raw: {
        id: '600',
        properties: {
          hs_call_status: 'COMPLETED',
          hs_call_direction: 'INBOUND',
          hs_call_body: '',
          hs_call_disposition: '',
          hs_call_duration: '300',
          hs_call_recording_url: '',
          hs_call_title: 'Discovery call',
          hs_timestamp: '1714867200000',
          hs_createdate: '1714000000000',
          hs_lastmodifieddate: '1714867200000',
          hubspot_owner_id: '777',
          hs_created_by_workflow_id: '',
          hs_created_via_workflow: '',
          hs_import_id: '',
        },
      } as RawHubSpotRecord,
    });
    expect(noteResult.row.event_at_tz_inferred).toBe(true);
    expect(callResult.row.event_at_tz_inferred).toBe(true);
  });

  it('event_at_tz_inferred persists round-trip through engagement_store', () => {
    const { store } = makeStores();
    const reconciler = new HubSpotEmailEngagementReconciler({
      search: { refreshAuth },
      engagementStore: store,
      now: () => FIXED_NOW,
    });
    reconciler.ingest('acme-hubspot', {
      id: 'hubspot_email_47291',
      modified_at: FIXED_NOW,
      _raw: rawEmail(),
    });
    const round = store.get('acme-hubspot', 'hubspot_email_47291');
    expect(round!.event_at_tz_inferred).toBe(true);
  });

  it('Codex Area 2 — prefsTimezone callback throws → resolver falls through to UTC + inferred=true', () => {
    const { store } = makeStores();
    const reconciler = new HubSpotEmailEngagementReconciler({
      search: { refreshAuth },
      engagementStore: store,
      now: () => FIXED_NOW,
      prefsTimezone: () => {
        throw new Error('prefs store unavailable');
      },
    });
    const result = reconciler.ingest('acme-hubspot', {
      id: 'hubspot_email_47291',
      modified_at: FIXED_NOW,
      _raw: rawEmail(),
    });
    expect(result.row.event_at_tz_hint).toBe('UTC');
    expect(result.row.event_at_tz_inferred).toBe(true);
  });

  it('Codex Area 2 — prefsTimezone returning empty string falls through (no IANA tz exists with empty name)', () => {
    const { store } = makeStores();
    const reconciler = new HubSpotEmailEngagementReconciler({
      search: { refreshAuth },
      engagementStore: store,
      now: () => FIXED_NOW,
      prefsTimezone: () => '',
    });
    const result = reconciler.ingest('acme-hubspot', {
      id: 'hubspot_email_47291',
      modified_at: FIXED_NOW,
      _raw: rawEmail(),
    });
    expect(result.row.event_at_tz_hint).toBe('UTC');
    expect(result.row.event_at_tz_inferred).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────
// D-139 P1a.1.2 — ingestWithAssociations widened to meeting/note/call/task
// ────────────────────────────────────────────────────────────────

describe('D-139 P1a.1.2 — ingestWithAssociations widening', () => {
  const buildAssocFetcher = (deal_ids: string[], company_ids: string[]): typeof fetch =>
    (async (url: string): Promise<Response> => {
      if (url.includes('/deals')) {
        return okJson({
          results: deal_ids.map((id) => ({ toObjectId: id })),
        });
      }
      if (url.includes('/companies')) {
        return okJson({
          results: company_ids.map((id) => ({ toObjectId: id })),
        });
      }
      return okJson({ results: [] });
    }) as never;

  const meetingSlim = {
    id: 'hubspot_meeting_301',
    modified_at: FIXED_NOW,
    _raw: {
      id: '301',
      properties: {
        hs_meeting_title: 'Sync',
        hs_meeting_start_time: '1714000000000',
        hs_meeting_end_time: '1714003600000',
        hs_meeting_outcome: '',
        hs_meeting_location: '',
        hs_meeting_external_url: '',
        hs_meeting_body: '',
        attendee_emails: 'bob@acme.com',
        hs_lastmodifieddate: '1714867200000',
        hs_createdate: '1714000000000',
        hubspot_owner_id: '777',
        hs_created_by_workflow_id: '',
        hs_created_via_workflow: '',
        hs_import_id: '',
      },
    } as RawHubSpotRecord,
  };
  const noteSlim = {
    id: 'hubspot_note_500',
    modified_at: FIXED_NOW,
    _raw: {
      id: '500',
      properties: {
        hs_note_body: 'note',
        hs_lastmodifieddate: '1714867200000',
        hs_createdate: '1714000000000',
        hubspot_owner_id: '777',
        hs_created_by_workflow_id: '',
        hs_created_via_workflow: '',
        hs_import_id: '',
      },
    } as RawHubSpotRecord,
  };
  const callSlim = {
    id: 'hubspot_call_600',
    modified_at: FIXED_NOW,
    _raw: {
      id: '600',
      properties: {
        hs_call_status: 'COMPLETED',
        hs_call_direction: 'INBOUND',
        hs_call_body: '',
        hs_call_disposition: '',
        hs_call_duration: '300',
        hs_call_recording_url: '',
        hs_call_title: 'Call',
        hs_timestamp: '1714867200000',
        hs_createdate: '1714000000000',
        hs_lastmodifieddate: '1714867200000',
        hubspot_owner_id: '777',
        hs_created_by_workflow_id: '',
        hs_created_via_workflow: '',
        hs_import_id: '',
      },
    } as RawHubSpotRecord,
  };
  const taskSlim = {
    id: 'hubspot_task_700',
    modified_at: FIXED_NOW,
    _raw: rawTask({}, '700'),
  };

  it('meeting reconciler: ingestWithAssociations fetches + writes deal/account edges in one transaction', async () => {
    const { store } = makeStores();
    const fetcher = buildAssocFetcher(['1001'], ['9001']);
    const reconciler = new HubSpotMeetingEngagementReconciler({
      search: { fetcher, refreshAuth },
      engagementStore: store,
      now: () => FIXED_NOW,
    });
    const out = await reconciler.ingestWithAssociations(
      fakeConnection,
      'acme-hubspot',
      meetingSlim,
    );
    expect(out.associations_fetched).toBe(true);
    const edges = store.listEdges({
      connection_id: 'acme-hubspot',
      engagement_target_id: 'hubspot_meeting_301',
    });
    expect(edges.some((e) => e.edge_type === 'deal' && e.target_id === 'hubspot_deal_acme-hubspot_1001')).toBe(true);
    expect(edges.some((e) => e.edge_type === 'account' && e.target_id === 'hubspot_company_acme-hubspot_9001')).toBe(true);
  });

  it('note reconciler: ingestWithAssociations same shape; deals + companies edges land', async () => {
    const { store } = makeStores();
    const fetcher = buildAssocFetcher(['1001'], ['9001']);
    const reconciler = new HubSpotNoteEngagementReconciler({
      search: { fetcher, refreshAuth },
      engagementStore: store,
      now: () => FIXED_NOW,
    });
    const out = await reconciler.ingestWithAssociations(
      fakeConnection,
      'acme-hubspot',
      noteSlim,
    );
    expect(out.associations_fetched).toBe(true);
    const edges = store.listEdges({
      connection_id: 'acme-hubspot',
      engagement_target_id: 'hubspot_note_500',
    });
    expect(edges.some((e) => e.edge_type === 'deal')).toBe(true);
    expect(edges.some((e) => e.edge_type === 'account')).toBe(true);
  });

  it('call reconciler: ingestWithAssociations same shape; deals edge lands', async () => {
    const { store } = makeStores();
    const fetcher = buildAssocFetcher(['1001'], []);
    const reconciler = new HubSpotCallEngagementReconciler({
      search: { fetcher, refreshAuth },
      engagementStore: store,
      now: () => FIXED_NOW,
    });
    const out = await reconciler.ingestWithAssociations(
      fakeConnection,
      'acme-hubspot',
      callSlim,
    );
    expect(out.associations_fetched).toBe(true);
    const edges = store.listEdges({
      connection_id: 'acme-hubspot',
      engagement_target_id: 'hubspot_call_600',
    });
    expect(edges.some((e) => e.edge_type === 'deal' && e.target_id === 'hubspot_deal_acme-hubspot_1001')).toBe(true);
  });

  it('task reconciler: ingestWithAssociations same shape; account edge lands', async () => {
    const { store } = makeStores();
    const fetcher = buildAssocFetcher([], ['9001']);
    const reconciler = new HubSpotTaskEngagementReconciler({
      search: { fetcher, refreshAuth },
      engagementStore: store,
      now: () => FIXED_NOW,
    });
    const out = await reconciler.ingestWithAssociations(
      fakeConnection,
      'acme-hubspot',
      taskSlim,
    );
    expect(out.associations_fetched).toBe(true);
    const edges = store.listEdges({
      connection_id: 'acme-hubspot',
      engagement_target_id: 'hubspot_task_700',
    });
    expect(edges.some((e) => e.edge_type === 'account' && e.target_id === 'hubspot_company_acme-hubspot_9001')).toBe(true);
  });

  it('meeting reconciler: fetcher throw → graceful fallback (row lands; no deal/account edges)', async () => {
    const { store } = makeStores();
    const fetcher = (async () => {
      throw new Error('upstream down');
    }) as never;
    const reconciler = new HubSpotMeetingEngagementReconciler({
      search: { fetcher, refreshAuth },
      engagementStore: store,
      now: () => FIXED_NOW,
    });
    const out = await reconciler.ingestWithAssociations(
      fakeConnection,
      'acme-hubspot',
      meetingSlim,
    );
    expect(out.associations_fetched).toBe(false);
    expect(out.row).toBeDefined();
    const edges = store.listEdges({
      connection_id: 'acme-hubspot',
      engagement_target_id: 'hubspot_meeting_301',
    });
    expect(edges.some((e) => e.edge_type === 'deal')).toBe(false);
    // Attendee-derived contact edges still emit (parity with email reconciler).
    expect(edges.some((e) => e.edge_type === 'contact')).toBe(true);
  });

  it('source_record_missing on any leg returns early without writing the row (engagement deleted in flight)', async () => {
    const { store } = makeStores();
    const fetcher = (async (url: string) => {
      if (url.includes('/companies')) return notFound();
      return okJson({ results: [] });
    }) as never;
    const reconciler = new HubSpotNoteEngagementReconciler({
      search: { fetcher, refreshAuth },
      engagementStore: store,
      now: () => FIXED_NOW,
    });
    const out = await reconciler.ingestWithAssociations(
      fakeConnection,
      'acme-hubspot',
      noteSlim,
    );
    expect(out.associations_fetched).toBe(false);
    // No row written.
    const persisted = store.get('acme-hubspot', 'hubspot_note_500');
    expect(persisted).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────
// D-139 P1a.1.2 — wireHubSpotReconciliation engagement-store cascade
// ────────────────────────────────────────────────────────────────

describe('D-139 P1a.1.2 — wireHubSpotReconciliation cascade for engagements', () => {
  it('connection delete tombstones engagement rows + edges scoped to the deleted connection only', async () => {
    // Lazy-imported to avoid pulling the housekeeping registry into
    // every other test in this file.
    const { wireHubSpotReconciliation } = await import(
      '../data/hubspot/boot.js'
    );
    const {
      clearDefaultReconcilerRegistry,
    } = await import('../housekeeping/reconciliation/reconciler-registry.js');
    const {
      clearDefaultHousekeepingRegistry,
    } = await import('../housekeeping/registry.js');
    const { createConnectionStore } = await import(
      '../storage/connection-store.js'
    );
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    const connectionStore = createConnectionStore(db);
    const engagementStore = createEngagementStore(db);

    clearDefaultReconcilerRegistry();
    clearDefaultHousekeepingRegistry();

    // Two HubSpot connections — both holding the same vendor-native id
    // (allowed; composite primary key namespaces by `connection_id`).
    for (const name of ['acme-hubspot', 'partner-hubspot']) {
      connectionStore.upsert({
        kind: 'api',
        name,
        display_name: name,
        config_json: JSON.stringify({
          base_url: 'https://api.hubapi.com',
          vendor: 'hubspot',
        }),
        auth_ciphertext: 'opaque',
        enrolled_at: 1,
        updated_at: 1,
      });
      engagementStore.upsert({
        row: {
          connection_id: name,
          target_id: 'hubspot_email_47291',
          vendor: 'hubspot',
          entity: 'email',
          meta: {},
          mirror_blob_hash: null,
          authorship: 'user',
          direction: 'inbound',
          dedupe_confidence: 'none',
          lifecycle_state: 'point_in_time',
          event_at: FIXED_NOW,
          vendor_created_at: FIXED_NOW,
          vendor_modified_at: FIXED_NOW,
          ingested_at: FIXED_NOW,
          body_state: 'inline_body',
          body_inline: 'x',
        },
      });
      engagementStore.upsertEdge({
        connection_id: name,
        engagement_target_id: 'hubspot_email_47291',
        edge_type: 'deal',
        target_kind: 'connection.api',
        target_id: `hubspot_deal_${name}`,
        vendor: 'hubspot',
        created_at: FIXED_NOW,
      });
    }

    wireHubSpotReconciliation({
      connectionStore,
      reconcilers: [], // No reconcilers — cascade still wires.
      lookupConnection: () => null,
      engagementStore,
    });

    // Delete only acme-hubspot.
    connectionStore.delete('api', 'acme-hubspot');

    const acmeRow = engagementStore.get('acme-hubspot', 'hubspot_email_47291');
    const partnerRow = engagementStore.get(
      'partner-hubspot',
      'hubspot_email_47291',
    );
    expect(acmeRow!.deleted_at).toBeGreaterThan(0);
    expect(partnerRow!.deleted_at).toBeUndefined();

    const acmeEdges = engagementStore.listEdges({
      connection_id: 'acme-hubspot',
    });
    const partnerEdges = engagementStore.listEdges({
      connection_id: 'partner-hubspot',
    });
    expect(acmeEdges).toHaveLength(0); // tombstoned
    expect(partnerEdges).toHaveLength(1);

    db.close();
    clearDefaultReconcilerRegistry();
    clearDefaultHousekeepingRegistry();
  });

  it('boot wire is engagement-aware only when engagementStore is supplied (backwards-compat)', async () => {
    const { wireHubSpotReconciliation } = await import(
      '../data/hubspot/boot.js'
    );
    const {
      clearDefaultReconcilerRegistry,
    } = await import('../housekeeping/reconciliation/reconciler-registry.js');
    const {
      clearDefaultHousekeepingRegistry,
    } = await import('../housekeeping/registry.js');
    const { createConnectionStore } = await import(
      '../storage/connection-store.js'
    );
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    const connectionStore = createConnectionStore(db);
    const engagementStore = createEngagementStore(db);

    clearDefaultReconcilerRegistry();
    clearDefaultHousekeepingRegistry();

    connectionStore.upsert({
      kind: 'api',
      name: 'acme-hubspot',
      display_name: 'Acme',
      config_json: JSON.stringify({
        base_url: 'https://api.hubapi.com',
        vendor: 'hubspot',
      }),
      auth_ciphertext: 'opaque',
      enrolled_at: 1,
      updated_at: 1,
    });
    engagementStore.upsert({
      row: {
        connection_id: 'acme-hubspot',
        target_id: 'hubspot_email_1',
        vendor: 'hubspot',
        entity: 'email',
        meta: {},
        mirror_blob_hash: null,
        authorship: 'user',
        direction: 'inbound',
        dedupe_confidence: 'none',
        lifecycle_state: 'point_in_time',
        event_at: FIXED_NOW,
        vendor_created_at: FIXED_NOW,
        vendor_modified_at: FIXED_NOW,
        ingested_at: FIXED_NOW,
        body_state: 'inline_body',
        body_inline: 'x',
      },
    });

    // Wire WITHOUT engagementStore — the cascade is omitted.
    wireHubSpotReconciliation({
      connectionStore,
      reconcilers: [],
      lookupConnection: () => null,
    });

    connectionStore.delete('api', 'acme-hubspot');
    const row = engagementStore.get('acme-hubspot', 'hubspot_email_1');
    // Row survives — engagement cascade only runs when wired.
    expect(row).not.toBeNull();
    expect(row!.deleted_at).toBeUndefined();

    db.close();
    clearDefaultReconcilerRegistry();
    clearDefaultHousekeepingRegistry();
  });
});
