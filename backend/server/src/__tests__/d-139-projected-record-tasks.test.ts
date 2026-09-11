/** D-139 P4 — the three projected-input topics produce.
 *
 *  These were the last of the twelve, and the only thing separating them
 *  from the six on `buildRecordAggregateTask` is that their kernels take a
 *  PROJECTED input rather than `EngagementRow[]`. So the risk sits in the
 *  projection, and this session has already produced three separate
 *  write-key-vs-read-key asymmetries in this exact producer family — a key
 *  written one way and read another, invisible to any test that builds both
 *  halves itself.
 *
 *  These therefore build the CRM side the way a reconciler does — the
 *  vendor-neutral `meta.close_state` and `meta.domain` both reconcilers
 *  actually project — and walk real `engagement_edges` rather than handing
 *  the kernels pre-made rows. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  type EngagementsForRecordArgs,
  composePlatformRecordTargetId,
  type EngagementRow,
  type EnrichmentScope,
} from '@recued/contracts';

import { createEngagementStore, type EngagementStore } from '../storage/engagement-store.js';
import { createEnrichmentStore, type EnrichmentStore } from '../storage/enrichment-store.js';
import { buildRecordEngagementsDeps, type EngagementsResolverDepsInput } from '../engagement-resolver-deps.js';
import { PROJECTED_RECORD_TASKS } from '../housekeeping/engagement-aggregates/projected-record-tasks.js';
import { STANDALONE_TASKS } from '../housekeeping/registration.js';
import type { HousekeepingContext } from '../housekeeping/registry.js';

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const ACCOUNT_SCOPE = 'connection.api.hubspot.company' as EnrichmentScope;
const CONTACT_SCOPE = 'connection.api.hubspot.contact' as EnrichmentScope;
const ACCOUNT = composePlatformRecordTargetId('hubspot', 'company', 'acme-hubspot', '900');
const CONTACT = composePlatformRecordTargetId('hubspot', 'contact', 'acme-hubspot', '100');
const DEAL_A = composePlatformRecordTargetId('hubspot', 'deal', 'acme-hubspot', '1');
const DEAL_B = composePlatformRecordTargetId('hubspot', 'deal', 'acme-hubspot', '2');
const BUYER = 'buyer@acme.com';

let dir: string; let db: Database.Database;
let enrichmentStore: EnrichmentStore; let engagementStore: EngagementStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd139-proj-'));
  db = new Database(join(dir, 'test.db'));
  enrichmentStore = createEnrichmentStore(db);
  engagementStore = createEngagementStore(db);
});
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

/** A platform-reference record row, with the meta a reconciler projects. */
const seedRecord = (scope: EnrichmentScope, target_id: string, extra: Record<string, unknown> = {}): void => {
  db.prepare(
    `INSERT INTO data_enrichment (_id, topic, scope, target_id, authored_by, ingested_at, authored_at, meta)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(`seed:${scope}:${target_id}`, 'lifecycle_stage_inferred', scope, target_id, 'seed', NOW, NOW,
    JSON.stringify({ snapshot_at: NOW, snapshot_hash: `h:${target_id}`, ...extra }));
};

const engagement = (id: string, over: Partial<EngagementRow> = {}): EngagementRow => ({
  connection_id: 'acme-hubspot', target_id: id, vendor: 'hubspot', entity: 'email',
  meta: {}, mirror_blob_hash: null, authorship: 'user', direction: 'inbound',
  dedupe_confidence: 'none', lifecycle_state: 'completed',
  event_at: NOW - 2 * DAY, vendor_created_at: NOW - 2 * DAY, vendor_modified_at: NOW - 2 * DAY,
  ingested_at: NOW, body_state: 'none', ...over,
});

const edge = (engagement_target_id: string, edge_type: 'contact' | 'deal' | 'account', target_id: string): void => {
  engagementStore.upsertEdge({
    connection_id: 'acme-hubspot', engagement_target_id, edge_type,
    target_kind: edge_type === 'contact' ? 'data.contact' : 'connection.api',
    target_id, vendor: 'hubspot', created_at: NOW,
    ...(edge_type === 'contact' ? { resolveContactRedirect: () => null } : {}),
  });
};

const makeCtx = (): HousekeepingContext => {
  const recordDeps = buildRecordEngagementsDeps({
    db, contactStore: { get: () => null, addressSet: () => [] } as never,
    connectionStore: ({ list: () => [] }) as unknown as EngagementsResolverDepsInput['connectionStore'],
    now: () => NOW,
  });
  return {
    db, bus: { emit: () => undefined, subscribe: () => () => undefined, dispose: () => undefined },
    enrichmentStore, recipeStore: {}, now: () => NOW, emitAuditRow: () => undefined,
    resolveRecordEngagements: (args: EngagementsForRecordArgs) => engagementStore.resolveEngagementsForRecord(args, recordDeps(args)),
  } as unknown as HousekeepingContext;
};

const task = (topic: string) => PROJECTED_RECORD_TASKS.find((t) => t.topic === topic)!;
const readValue = <T>(topic: string, scope: EnrichmentScope, target_id: string): T | undefined =>
  enrichmentStore.list({
    topic: topic as never, scope, target_id,
    authored_by: `system.housekeeping.${topic}`, limit: 1,
  })[0]?.value as T | undefined;

describe('D-139 P4 — registration', () => {
  it('all three are registered, deterministic, and correctly named', () => {
    const registered = new Set(STANDALONE_TASKS.map((t) => t.meta.id));
    expect(PROJECTED_RECORD_TASKS).toHaveLength(3);
    for (const t of PROJECTED_RECORD_TASKS) {
      expect(registered.has(t.meta.id), `${t.meta.id} not registered`).toBe(true);
      expect(t.is_ai_surface, t.meta.id).toBe(false);
      expect(t.meta.id).toBe(`enrichment.${t.topic}`);
    }
  });
});

describe('D-139 P4 — account_engagement_breadth', () => {
  it('counts DISTINCT contacts engaging at the account', async () => {
    seedRecord(ACCOUNT_SCOPE, ACCOUNT);
    // Two engagements, two different contacts — breadth 2.
    engagementStore.upsert({ row: engagement('e1') }); edge('e1', 'account', ACCOUNT); edge('e1', 'contact', BUYER);
    engagementStore.upsert({ row: engagement('e2') }); edge('e2', 'account', ACCOUNT); edge('e2', 'contact', 'cfo@acme.com');

    await task('account_engagement_breadth').step(makeCtx(), { kind: 'complete' }, 5_000);
    const v = readValue<{ distinct_contacts: number }>('account_engagement_breadth', ACCOUNT_SCOPE, ACCOUNT);
    expect(v, 'no row written').toBeDefined();
    expect(v!.distinct_contacts).toBe(2);
  });

  it('one engagement with TWO contact edges counts both', async () => {
    // ⛔ The projection emits one row per (engagement, contact) PAIR. A
    // mail to three people is three contacts engaging, not one — emitting
    // one row per engagement would silently under-report multi-threading,
    // which is the entire signal.
    seedRecord(ACCOUNT_SCOPE, ACCOUNT);
    engagementStore.upsert({ row: engagement('e1') });
    edge('e1', 'account', ACCOUNT); edge('e1', 'contact', BUYER); edge('e1', 'contact', 'cfo@acme.com');

    await task('account_engagement_breadth').step(makeCtx(), { kind: 'complete' }, 5_000);
    expect(readValue<{ distinct_contacts: number }>('account_engagement_breadth', ACCOUNT_SCOPE, ACCOUNT)!
      .distinct_contacts).toBe(2);
  });
});

describe('D-139 P4 — champion_deal_count', () => {
  it('tallies distinct deals and reads the vendor-neutral close_state', async () => {
    seedRecord(CONTACT_SCOPE, CONTACT, { email: BUYER });
    // 🔑 `close_state` is what BOTH reconcilers project — not Salesforce's
    // raw IsWon/IsClosed, which the kernel header still describes.
    seedRecord('connection.api.hubspot.deal' as EnrichmentScope, DEAL_A, { close_state: 'won' });
    seedRecord('connection.api.hubspot.deal' as EnrichmentScope, DEAL_B, { close_state: 'lost' });
    engagementStore.upsert({ row: engagement('e1') }); edge('e1', 'contact', BUYER); edge('e1', 'deal', DEAL_A);
    engagementStore.upsert({ row: engagement('e2') }); edge('e2', 'contact', BUYER); edge('e2', 'deal', DEAL_B);

    await task('champion_deal_count').step(makeCtx(), { kind: 'complete' }, 5_000);
    const v = readValue<{ won_deals: number; lost_deals: number }>('champion_deal_count', CONTACT_SCOPE, CONTACT);
    expect(v, 'no row written').toBeDefined();
    expect(v!.won_deals).toBe(1);
    expect(v!.lost_deals).toBe(1);
  });

  it('a contact record with NO email is skipped, not computed as zero', async () => {
    // ⛔ Contact edges key on the canonical EMAIL, not the platform id. A
    // contact whose meta carries no email joins to nothing, and computing
    // over that empty edge set would emit "0 deals" as a finding about the
    // contact rather than an absence in what we could read.
    seedRecord(CONTACT_SCOPE, CONTACT, { name: 'No Email' });
    await task('champion_deal_count').step(makeCtx(), { kind: 'complete' }, 5_000);
    expect(readValue('champion_deal_count', CONTACT_SCOPE, CONTACT)).toBeUndefined();
  });
});

describe('D-139 P4 — multi_account_contact', () => {
  it('flags a contact whose mail domain matches no affiliated account', async () => {
    seedRecord(CONTACT_SCOPE, CONTACT, { email: 'buyer@newco.com' });
    seedRecord(ACCOUNT_SCOPE, ACCOUNT, { domain: 'acme.com' });
    engagementStore.upsert({ row: engagement('e1') });
    edge('e1', 'contact', 'buyer@newco.com'); edge('e1', 'account', ACCOUNT);

    await task('multi_account_contact').step(makeCtx(), { kind: 'complete' }, 5_000);
    const v = readValue<{ is_multi_account: boolean; mail_domain: string | null }>(
      'multi_account_contact', CONTACT_SCOPE, CONTACT);
    expect(v, 'no row written').toBeDefined();
    expect(v!.is_multi_account).toBe(true);
    expect(v!.mail_domain).toBe('newco.com');
  });

  it('a matching domain is NOT multi-account', async () => {
    seedRecord(CONTACT_SCOPE, CONTACT, { email: BUYER });
    seedRecord(ACCOUNT_SCOPE, ACCOUNT, { domain: 'acme.com' });
    engagementStore.upsert({ row: engagement('e1') });
    edge('e1', 'contact', BUYER); edge('e1', 'account', ACCOUNT);

    await task('multi_account_contact').step(makeCtx(), { kind: 'complete' }, 5_000);
    expect(readValue<{ is_multi_account: boolean }>('multi_account_contact', CONTACT_SCOPE, CONTACT)!
      .is_multi_account).toBe(false);
  });

  it('a free-mail contact is not evidence of a job change', async () => {
    // The kernel drops free-mail domains itself; the projection deliberately
    // does NOT pre-filter, so that decision stays in one visible place.
    seedRecord(CONTACT_SCOPE, CONTACT, { email: 'someone@gmail.com' });
    seedRecord(ACCOUNT_SCOPE, ACCOUNT, { domain: 'acme.com' });
    engagementStore.upsert({ row: engagement('e1') });
    edge('e1', 'contact', 'someone@gmail.com'); edge('e1', 'account', ACCOUNT);

    await task('multi_account_contact').step(makeCtx(), { kind: 'complete' }, 5_000);
    const v = readValue<{ is_multi_account: boolean; mail_domain: string | null }>(
      'multi_account_contact', CONTACT_SCOPE, CONTACT);
    expect(v!.is_multi_account).toBe(false);
    expect(v!.mail_domain).toBeNull();
  });
});
