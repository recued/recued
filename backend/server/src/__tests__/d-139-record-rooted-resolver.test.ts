/** D-139 slice 2 — `resolveEngagementsForRecord`, the deal/account root.
 *
 *  ## Why this exists
 *
 *  8 of the 12 D-139 engagement topics are DEAL-scoped and 2 are
 *  ACCOUNT-scoped (`valid_scopes` in `ENRICHMENT_REGISTRY`); only 2 are
 *  contact-scoped. Every pure-compute kernel under
 *  `housekeeping/engagement-aggregates/` takes `EngagementRow[]` — and
 *  until this root existed there was NO WAY to get that array for a deal.
 *  `resolveEngagementsForContact` requires an `email` and runs D-138
 *  identity-expansion; a deal has neither. That is the reason those
 *  kernels have sat with zero production callers.
 *
 *  ## What is actually being asserted
 *
 *  The two roots share ONE body (`resolveEngagementsCore`) — they differ
 *  only in the edge selector. So the interesting assertions are:
 *
 *    1. The selector reaches the right rows (deal edges, account edges),
 *       and does NOT reach a sibling record's rows.
 *    2. The shared filter surface really is shared — a window, a
 *       lifecycle whitelist, an authorship filter and a cursor behave on
 *       the record root exactly as they do on the contact root. This is
 *       the assertion that would go red if someone later re-implemented
 *       the record root separately instead of extending the selector.
 *    3. A scope that cannot be resolved REFUSES rather than returning an
 *       empty page. An empty page is indistinguishable from "this deal
 *       has no engagements", and a producer writes that as fact — the
 *       exact failure that made the D-139 self-relay recipes harmful.
 *
 *  ## The join key
 *
 *  `target_id` is the full `composePlatformRecordTargetId` string
 *  (`<vendor>_<entity>_<connection>_<native>`). Both sides compose it
 *  the same way — the record reconcilers via `slim.id`
 *  (`deal-reconciler.ts:107`) and the engagement reconcilers via
 *  `hubSpotEngagementTargetIdFor` — so the enrichment row a producer is
 *  computing for and the edge it must follow carry the SAME string. A
 *  native-only id matches nothing; that is asserted below, because a
 *  silent empty page is how this class of bug hides. */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import {
  composePlatformRecordTargetId,
  type CoverageMetadata,
  type EngagementRow,
  type EnrichmentScope,
} from '@recued/contracts';
import {
  createEngagementStore,
  EngagementInvalidError,
  type EngagementStore,
} from '../storage/engagement-store.js';

const NOW = 1_714_867_300_000;
const DAY = 24 * 60 * 60 * 1000;

const DEAL = composePlatformRecordTargetId('hubspot', 'deal', 'acme-hubspot', '47291');
const OTHER_DEAL = composePlatformRecordTargetId('hubspot', 'deal', 'acme-hubspot', '99999');
const COMPANY = composePlatformRecordTargetId('hubspot', 'company', 'acme-hubspot', '1234');

const COVERAGE: CoverageMetadata = {
  sources_connected: ['connection.api.hubspot.email'],
  sources_unavailable: [],
  sources_stale: [],
  sources_degraded: [],
  row_counts: {},
  last_source_event_at: NOW,
};

const row = (overrides: Partial<EngagementRow> = {}): EngagementRow => ({
  connection_id: 'acme-hubspot',
  target_id: 'hubspot_email_1',
  vendor: 'hubspot',
  entity: 'email',
  meta: { subject: 'Quarterly review' },
  mirror_blob_hash: null,
  authorship: 'user',
  direction: 'outbound',
  dedupe_confidence: 'none',
  lifecycle_state: 'point_in_time',
  event_at: NOW - DAY,
  vendor_created_at: NOW - DAY,
  vendor_modified_at: NOW - DAY,
  ingested_at: NOW,
  body_state: 'none',
  ...overrides,
});

/** One engagement plus the record edge that hangs it off `recordId`. */
const seed = (
  store: EngagementStore,
  engagementId: string,
  edge_type: 'deal' | 'account',
  recordId: string,
  overrides: Partial<EngagementRow> = {},
): void => {
  store.upsert({ row: row({ target_id: engagementId, ...overrides }) });
  store.upsertEdge({
    connection_id: 'acme-hubspot',
    engagement_target_id: engagementId,
    edge_type,
    target_kind: 'connection.api',
    target_id: recordId,
    vendor: 'hubspot',
    created_at: NOW,
  });
};

const freshStore = (): EngagementStore => createEngagementStore(new Database(':memory:'));

const resolve = (
  store: EngagementStore,
  scope: string,
  target_id: string,
  args: Record<string, unknown> = {},
) =>
  store.resolveEngagementsForRecord(
    { scope: scope as EnrichmentScope, target_id, since: 0, ...args },
    { now: () => NOW, coverage: COVERAGE },
  );

const ids = (r: { engagements: ReadonlyArray<{ target_id: string }> }): string[] =>
  r.engagements.map((e) => e.target_id).sort();

describe('D-139 — resolveEngagementsForRecord selects by record edge', () => {
  it('returns a deal\'s engagements and NOT a sibling deal\'s', () => {
    const store = freshStore();
    seed(store, 'hubspot_email_1', 'deal', DEAL);
    seed(store, 'hubspot_email_2', 'deal', DEAL);
    seed(store, 'hubspot_email_3', 'deal', OTHER_DEAL);

    const r = resolve(store, 'connection.api.hubspot.deal', DEAL);
    expect(ids(r)).toEqual(['hubspot_email_1', 'hubspot_email_2']);
  });

  it('resolves an ACCOUNT scope through company→account crm_alias', () => {
    const store = freshStore();
    seed(store, 'hubspot_email_1', 'account', COMPANY);
    seed(store, 'hubspot_email_2', 'deal', DEAL);

    // HubSpot's entity is `company`; its crm_alias is `account`, which is
    // the edge type the reconcilers write. The scope→edge mapping is the
    // registry annotation, not a hand-written table.
    const r = resolve(store, 'connection.api.hubspot.company', COMPANY);
    expect(ids(r)).toEqual(['hubspot_email_1']);
  });

  it('resolves a Salesforce opportunity — same alias, different vendor+entity', () => {
    const store = freshStore();
    const opp = composePlatformRecordTargetId('salesforce', 'opportunity', 'acme-sf', 'OPP1');
    store.upsert({
      row: row({ target_id: 'sf_task_1', vendor: 'salesforce', entity: 'task', connection_id: 'acme-sf' }),
    });
    store.upsertEdge({
      connection_id: 'acme-sf',
      engagement_target_id: 'sf_task_1',
      edge_type: 'deal',
      target_kind: 'connection.api',
      target_id: opp,
      vendor: 'salesforce',
      created_at: NOW,
    });

    const r = resolve(store, 'connection.api.salesforce.opportunity', opp);
    expect(ids(r)).toEqual(['sf_task_1']);
  });

  it('a NATIVE-only id matches nothing — the join key is the full composed id', () => {
    const store = freshStore();
    seed(store, 'hubspot_email_1', 'deal', DEAL);

    // '47291' is the vendor's own id. The edge carries
    // `hubspot_deal_acme-hubspot_47291`. Passing the native id is the
    // silent-empty-page failure this asserts against.
    expect(resolve(store, 'connection.api.hubspot.deal', '47291').engagements).toEqual([]);
    expect(ids(resolve(store, 'connection.api.hubspot.deal', DEAL))).toEqual(['hubspot_email_1']);
  });

  it('excludes tombstoned edges', () => {
    const store = freshStore();
    seed(store, 'hubspot_email_1', 'deal', DEAL);
    seed(store, 'hubspot_email_2', 'deal', DEAL);
    store.tombstoneEdge({
      connection_id: 'acme-hubspot',
      engagement_target_id: 'hubspot_email_2',
      edge_type: 'deal',
      target_id: DEAL,
      deleted_at: NOW,
    });

    expect(ids(resolve(store, 'connection.api.hubspot.deal', DEAL))).toEqual(['hubspot_email_1']);
  });

  it('requires target_kind connection.api — pins a DEFENSIVE constraint', () => {
    // ⚠ CONTRIVED BY CONSTRUCTION, and deliberately so. In real data
    // `edge_type` alone separates these: a `data.contact` edge is keyed
    // on a canonical EMAIL and a record edge on a composed
    // `<vendor>_<entity>_<conn>_<native>` id, so the two target_id spaces
    // never intersect. The `target_kind` condition is therefore defensive
    // — it holds the selector to the documented composite key
    // `(edge_type, target_kind, target_id)` rather than to a coincidence
    // about id shapes.
    //
    // It is pinned here because an unproven condition is indistinguishable
    // from a condition that does nothing: a mutation dropping
    // `e.target_kind = ?` left the whole suite green until this case
    // existed. Either prove a constraint or delete it.
    const store = freshStore();
    store.upsert({ row: row({ target_id: 'hubspot_email_1' }) });
    store.upsertEdge({
      connection_id: 'acme-hubspot',
      engagement_target_id: 'hubspot_email_1',
      edge_type: 'deal',
      // The one thing wrong with this edge.
      target_kind: 'data.contact',
      target_id: DEAL,
      vendor: 'hubspot',
      created_at: NOW,
    });

    expect(resolve(store, 'connection.api.hubspot.deal', DEAL).engagements).toEqual([]);
  });

  it('does not cross edge types — a contact edge to the same id is not a deal edge', () => {
    const store = freshStore();
    store.upsert({ row: row({ target_id: 'hubspot_email_1' }) });
    store.upsertEdge({
      connection_id: 'acme-hubspot',
      engagement_target_id: 'hubspot_email_1',
      edge_type: 'contact',
      target_kind: 'connection.api',
      target_id: DEAL,
      vendor: 'hubspot',
      created_at: NOW,
    });

    expect(resolve(store, 'connection.api.hubspot.deal', DEAL).engagements).toEqual([]);
  });
});

describe('D-139 — the record root REFUSES rather than returning an empty page', () => {
  it('throws on a scope with no crm_alias', () => {
    const store = freshStore();
    // `connection.api.hubspot.email` is an ENGAGEMENT entity — it carries
    // no crm_alias by the § A.5.5 invariant, so it can never root a walk.
    expect(() => resolve(store, 'connection.api.hubspot.email', DEAL))
      .toThrow(EngagementInvalidError);
  });

  it('throws on a closed-list (non platform-reference) scope', () => {
    const store = freshStore();
    expect(() => resolve(store, 'mail', DEAL)).toThrow(EngagementInvalidError);
  });

  it('throws on an empty target_id', () => {
    const store = freshStore();
    expect(() => resolve(store, 'connection.api.hubspot.deal', '')).toThrow(EngagementInvalidError);
  });

  it('a resolvable record with genuinely no engagements returns an empty page, NOT a throw', () => {
    const store = freshStore();
    const r = resolve(store, 'connection.api.hubspot.deal', DEAL);
    expect(r.engagements).toEqual([]);
    expect(r.coverage).toEqual(COVERAGE);
  });
});

// ────────────────────────────────────────────────────────────────
// The shared-core contract. These would go red if the record root were
// ever re-implemented alongside the contact root instead of sharing it.
// ────────────────────────────────────────────────────────────────

describe('D-139 — the record root honours the SHARED filter surface', () => {
  it('applies the event_at window', () => {
    const store = freshStore();
    seed(store, 'recent', 'deal', DEAL, { event_at: NOW - DAY });
    seed(store, 'old', 'deal', DEAL, { event_at: NOW - 400 * DAY });

    expect(ids(resolve(store, 'connection.api.hubspot.deal', DEAL, { since: NOW - 30 * DAY })))
      .toEqual(['recent']);
  });

  it('applies the authorship whitelist', () => {
    const store = freshStore();
    seed(store, 'by_user', 'deal', DEAL, { authorship: 'user' });
    seed(store, 'by_bot', 'deal', DEAL, { authorship: 'crm_automation' });

    expect(ids(resolve(store, 'connection.api.hubspot.deal', DEAL, { authorship: ['user'] })))
      .toEqual(['by_user']);
  });

  it('applies the direction whitelist', () => {
    const store = freshStore();
    seed(store, 'out', 'deal', DEAL, { direction: 'outbound' });
    seed(store, 'internal', 'deal', DEAL, { direction: 'internal' });

    expect(ids(resolve(store, 'connection.api.hubspot.deal', DEAL, { direction: ['outbound'] })))
      .toEqual(['out']);
  });

  it('honours an explicit non-evidence lifecycle whitelist (scheduled meetings)', () => {
    const store = freshStore();
    // A scheduled meeting has NO event_at — the core drops the event_at
    // gate and windows on vendor_created_at when the caller asks for a
    // non-evidence state. Same switch the contact root gets.
    seed(store, 'upcoming', 'deal', DEAL, {
      lifecycle_state: 'scheduled',
      event_at: null,
      vendor_created_at: NOW - DAY,
    });
    seed(store, 'done', 'deal', DEAL, { lifecycle_state: 'completed' });

    expect(ids(resolve(store, 'connection.api.hubspot.deal', DEAL, { lifecycle_state: ['scheduled'] })))
      .toEqual(['upcoming']);
    // And the default evidence mode excludes it.
    expect(ids(resolve(store, 'connection.api.hubspot.deal', DEAL))).toEqual(['done']);
  });

  it('paginates with a round-tripping cursor', () => {
    const store = freshStore();
    for (let i = 0; i < 5; i += 1) {
      seed(store, `e${i}`, 'deal', DEAL, { event_at: NOW - (i + 1) * DAY });
    }

    const page1 = resolve(store, 'connection.api.hubspot.deal', DEAL, { page_size: 2 });
    expect(page1.engagements).toHaveLength(2);
    expect(page1.next_cursor).toBeDefined();

    const page2 = resolve(store, 'connection.api.hubspot.deal', DEAL, {
      page_size: 2,
      cursor: page1.next_cursor,
    });
    expect(page2.engagements).toHaveLength(2);
    // No overlap between pages — the cursor is strictly exclusive.
    const seen = new Set(ids(page1));
    for (const id of ids(page2)) expect(seen.has(id)).toBe(false);
  });

  it('excludes tombstoned engagement ROWS unless include_deleted', () => {
    const store = freshStore();
    seed(store, 'live', 'deal', DEAL);
    seed(store, 'gone', 'deal', DEAL);
    store.tombstone({
      connection_id: 'acme-hubspot',
      target_id: 'gone',
      deleted_at: NOW,
      actor: 'test',
      vendor_event_id: '',
    });

    expect(ids(resolve(store, 'connection.api.hubspot.deal', DEAL))).toEqual(['live']);
    expect(ids(resolve(store, 'connection.api.hubspot.deal', DEAL, { include_deleted: true })))
      .toEqual(['gone', 'live']);
  });
});
