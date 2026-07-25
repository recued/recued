/** D-192 email flagship E2b — the commitment_tracker standalone task.
 *
 *  The dispatch shell: a DECLARATION-DRIVEN contact walk (`scopesForCrmAlias`)
 *  → the ctx's `resolveContactEngagements` fan-in closure → the pure producer
 *  → per-contact `commitment_tracker` rows. The headline test is the
 *  cross-vendor walk catching Pipedrive's `entity:'person' crm_alias:'contact'`
 *  — a hardcoded `['…hubspot.contact','…salesforce.contact']` list would miss
 *  it. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildConnectionVendorEntity,
  CONNECTION_VENDOR_ENTITIES,
  type Authorship,
  type CommitmentTrackerValue,
  type ConnectionVendorEntity,
  type CoverageMetadata,
  type DedupeConfidence,
  type Direction,
  type EngagementLifecycleState,
  type EngagementVendor,
  type EngagementsResolverArgs,
  type EngagementsResolverResult,
  type EngagementsResolverRow,
  type EnrichmentScope,
} from '@recued/contracts';

import { STANDALONE_TASKS } from '../housekeeping/registration.js';
import {
  COMMITMENT_TRACKER_AUTHORED_BY,
  COMMITMENT_TRACKER_TOPIC,
} from '../housekeeping/engagement-aggregates/commitment-tracker.js';
import {
  commitmentTrackerTask,
  processOneCommitmentTrackerContact,
  runCommitmentTrackerCycle,
} from '../housekeeping/engagement-aggregates/commitment-tracker-task.js';
import {
  createEnrichmentStore,
  type EnrichmentStore,
} from '../storage/enrichment-store.js';
import type { HousekeepingContext } from '../housekeeping/registry.js';

const NOW = 1_714_867_200_000;
const day = 24 * 60 * 60 * 1000;

const EMPTY_COVERAGE: CoverageMetadata = {
  sources_connected: [],
  sources_unavailable: [],
  sources_stale: [],
  sources_degraded: [],
  row_counts: {},
  last_source_event_at: 0,
};

const engagementRow = (
  overrides: Partial<EngagementsResolverRow> = {},
): EngagementsResolverRow => ({
  connection_id: 'acme-hubspot',
  target_id: 'hubspot_email_1',
  vendor: 'hubspot' as EngagementVendor,
  entity: 'email',
  meta: { from: 'anna@acme.com' },
  mirror_blob_hash: null,
  authorship: 'user' as Authorship,
  direction: 'inbound' as Direction,
  dedupe_confidence: 'none' as DedupeConfidence,
  lifecycle_state: 'point_in_time' as EngagementLifecycleState,
  event_at: NOW - 1 * day,
  vendor_created_at: NOW - 1 * day,
  vendor_modified_at: NOW - 1 * day,
  ingested_at: NOW - 1 * day,
  body_state: 'inline_body',
  body_inline: 'I will send the revised SOW by Friday.',
  ...overrides,
});

describe('D-192 E2b — commitment_tracker standalone task', () => {
  let dir: string;
  let db: Database.Database;
  let store: EnrichmentStore;
  let llmCalls: number;

  /** Seed a contact platform-reference walk row (the walk reads
   *  scope/target_id/meta only) via raw insert — bypasses per-topic scope
   *  validation so salesforce.contact + pipedrive.person seed uniformly. */
  const seedContact = (scope: string, target_id: string, email: string): void => {
    db.prepare(
      `INSERT INTO data_enrichment
         (_id, topic, scope, target_id, authored_by, ingested_at, authored_at, meta)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      `${scope}:${target_id}`,
      'lifecycle_stage_inferred',
      scope,
      target_id,
      'seed',
      NOW,
      NOW,
      JSON.stringify({ snapshot_at: NOW, snapshot_hash: `h:${target_id}`, email, name: 'Anna Acme' }),
    );
  };

  const resolveContactEngagements = vi.fn(
    (_args: EngagementsResolverArgs): EngagementsResolverResult => ({
      engagements: [engagementRow({ target_id: 'e1' })],
      coverage: EMPTY_COVERAGE,
    }),
  );

  const ctx = (over: Partial<HousekeepingContext> = {}): HousekeepingContext =>
    ({
      db,
      bus: { emit: () => undefined, subscribe: () => () => undefined, dispose: () => undefined } as never,
      enrichmentStore: store,
      recipeStore: {} as never,
      now: () => NOW,
      emitAuditRow: () => undefined,
      llm: vi.fn(async () => ({ commitments: [] })),
      llmWithMeta: vi.fn(async () => {
        llmCalls += 1;
        return {
          result: { commitments: [{ index: 0, actor: 'anna@acme.com', text: 'Send the SOW by Friday' }] },
          model_id: 'groq:llama-3-70b',
        };
      }),
      resolveLLMModelId: vi.fn(async () => 'groq:llama-3-70b'),
      resolveContactEngagements,
      ...over,
    }) as unknown as HousekeepingContext;

  const commitmentRow = (scope: string, target_id: string): CommitmentTrackerValue | undefined =>
    store.list({
      topic: COMMITMENT_TRACKER_TOPIC,
      scope: scope as EnrichmentScope,
      target_id,
      authored_by: COMMITMENT_TRACKER_AUTHORED_BY,
    })[0]?.value as CommitmentTrackerValue | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'd-192-e2b-'));
    db = new Database(join(dir, 'test.db'));
    db.pragma('journal_mode = WAL');
    store = createEnrichmentStore(db);
    llmCalls = 0;
    resolveContactEngagements.mockClear();
  });

  afterEach(() => {
    store.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('no-ops when resolveContactEngagements is unwired (dbless / pre-wire)', async () => {
    seedContact('connection.api.hubspot.contact', 'hubspot_contact_1', 'anna@acme.com');
    const res = await runCommitmentTrackerCycle(ctx({ resolveContactEngagements: undefined }));
    expect(res).toEqual({ produced: 0, skipped: 0 });
    expect(llmCalls).toBe(0);
  });

  it('walks contact scopes DECLARATIVELY across vendors — incl. Pipedrive `person` (crm_alias:contact)', async () => {
    // A hardcoded `['…hubspot.contact','…salesforce.contact']` list would
    // MISS pipedrive.person; the crm_alias-driven walk catches it.
    seedContact('connection.api.hubspot.contact', 'hubspot_contact_1', 'anna@acme.com');
    seedContact('connection.api.salesforce.contact', 'salesforce_contact_9', 'bob@acme.com');
    seedContact('connection.api.pipedrive.person', 'pipedrive_person_7', 'carol@acme.com');

    const res = await runCommitmentTrackerCycle(ctx()); // resolveVendorRegistry undefined → built-in registry
    expect(res.produced).toBe(3);
    expect(commitmentRow('connection.api.hubspot.contact', 'hubspot_contact_1')?.commitments).toHaveLength(1);
    expect(commitmentRow('connection.api.salesforce.contact', 'salesforce_contact_9')?.commitments).toHaveLength(1);
    // The declaration-driven proof:
    const pipedrive = commitmentRow('connection.api.pipedrive.person', 'pipedrive_person_7');
    expect(pipedrive?.commitments).toHaveLength(1);
    expect(pipedrive?.entity).toBe('carol@acme.com');
  });

  it('walks + persists a PACK contact scope once writable from the live registry (D-192 S4c3b relaxation)', async () => {
    // A pack `crm_alias:'contact'` vendor: enumerated by `scopesForCrmAlias`, but the
    // prior STATIC valid_scopes intersection skipped it. S4c3b relaxes the guard to
    // `store.isScopeSupported('commitment_tracker', scope)` — true once the store
    // resolves the live registry (S4b), so the pack contact is tracked + the
    // commitment persists under its scope (the upsert no longer rejects).
    const acmeContact: ConnectionVendorEntity = buildConnectionVendorEntity({
      vendor: 'acme',
      entity: 'contact',
      display_name: 'Acme Contact',
      crm_alias: 'contact',
      meta_fields: [],
    });
    const liveRegistry: ConnectionVendorEntity[] = [...CONNECTION_VENDOR_ENTITIES, acmeContact];
    const registryStore = createEnrichmentStore(db, { resolveVendorRegistry: () => liveRegistry });
    seedContact('connection.api.acme.contact', 'acme_contact_1', 'anna@acme.com');

    const res = await runCommitmentTrackerCycle(
      ctx({ enrichmentStore: registryStore, resolveVendorRegistry: () => liveRegistry }),
    );
    expect(res.produced).toBe(1);
    const rows = registryStore.list({
      topic: COMMITMENT_TRACKER_TOPIC,
      scope: 'connection.api.acme.contact' as EnrichmentScope,
      target_id: 'acme_contact_1',
      authored_by: COMMITMENT_TRACKER_AUTHORED_BY,
    });
    expect(rows).toHaveLength(1);
  });

  it('passes the contact email + registry acceptance to the resolver', async () => {
    seedContact('connection.api.hubspot.contact', 'hubspot_contact_1', 'anna@acme.com');
    await runCommitmentTrackerCycle(ctx());
    const args = resolveContactEngagements.mock.calls[0]![0];
    expect(args.email).toBe('anna@acme.com');
    expect(args.authorship).toContain('user');
    expect(args.lifecycle_state).toContain('point_in_time');
    expect(args.dedupe_acceptance).toBe('exact_only');
  });

  it('processOneCommitmentTrackerContact guards: no_resolver / no_meta / no_email', async () => {
    const contact = { target_id: 'c1', meta_json: JSON.stringify({ email: 'anna@acme.com' }) };
    expect(
      (await processOneCommitmentTrackerContact(ctx({ resolveContactEngagements: undefined }), 'connection.api.hubspot.contact' as EnrichmentScope, contact, 'free')).reason,
    ).toBe('no_resolver');
    expect(
      (await processOneCommitmentTrackerContact(ctx(), 'connection.api.hubspot.contact' as EnrichmentScope, { target_id: 'c1', meta_json: null }, 'free')).reason,
    ).toBe('no_meta');
    expect(
      (await processOneCommitmentTrackerContact(ctx(), 'connection.api.hubspot.contact' as EnrichmentScope, { target_id: 'c1', meta_json: JSON.stringify({ name: 'x' }) }, 'free')).reason,
    ).toBe('no_email');
  });

  it('binds the extracted commitment to its source engagement + persists at the contact scope', async () => {
    seedContact('connection.api.hubspot.contact', 'hubspot_contact_1', 'anna@acme.com');
    await runCommitmentTrackerCycle(ctx());
    const value = commitmentRow('connection.api.hubspot.contact', 'hubspot_contact_1');
    expect(value?.commitments[0]!.text).toBe('Send the SOW by Friday');
    expect(value?.commitments[0]!.evidence_links[0]!.source_id).toBe('e1');
    expect(value?.commitments[0]!.evidence_links[0]!.source).toBe('engagement_email');
    expect(value?.commitments[0]!.actor_email).toBe('anna@acme.com');
  });

  it('is registered in STANDALONE_TASKS as an AI-surface enrichment task', () => {
    const task = STANDALONE_TASKS.find((t) => t === commitmentTrackerTask);
    expect(task).toBeDefined();
    expect(commitmentTrackerTask.meta.id).toBe('enrichment.commitment_tracker');
    expect(commitmentTrackerTask.topic).toBe(COMMITMENT_TRACKER_TOPIC);
    expect(commitmentTrackerTask.is_ai_surface).toBe(true);
  });
});
