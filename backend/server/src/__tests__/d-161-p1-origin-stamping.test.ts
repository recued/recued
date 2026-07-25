/** D-161 P1 — storage origin provenance stamping. */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  originProvenanceFromOptionalSource,
  SYSTEM_ORIGIN,
  type CollectionRecord,
  type EmittedLink,
  type ExecutionSource,
} from '@recued/contracts';
import type { ActivityEntry, AuditEntry } from '@recued/storage';

import { createCollectionTable, type CollectionTable } from '../collections/table.js';
import { insertLinks } from '../memory-links.js';
import { ensureMemorySchema, getOrCreateRecipeInsight } from '../memory-schema.js';
import { createSQLiteCollection } from '../sqlite-collection.js';
import { createContactStore, type ContactStore } from '../storage/contact-store.js';
import { createEnrichmentStore, type EnrichmentStore } from '../storage/enrichment-store.js';

const validRollup = {
  interaction_count: 4,
  last_interaction: 1_700_000_000_000,
  recent_subjects: ['hello'],
  cursor_at: 1_700_000_000_000,
  window_ms: 30 * 24 * 60 * 60 * 1000,
};

const validDealVelocity = {
  velocity: 'stable',
  recent_activity_count: 2,
  days_in_stage: 5,
  cursor_at: 1_700_000_000_000,
};

const contractedMcpSource: ExecutionSource = {
  channel: 'mcp',
  actor: 'contracted_user',
  agent_id: 'agent-1',
  tool_call_id: 'tool-call-1',
  mcp_token_id: 'mcp-token-1',
  contract_id: 'contract-1',
};

const makeCollectionRecord = (
  overrides: Partial<CollectionRecord> = {},
): CollectionRecord => ({
  record_id: 'uid:1@INBOX',
  received_at: 1_700_000_000_000,
  modified_at: 1_700_000_000_000,
  hot_fields: { from: 'a@b.com', subject: 'hi' },
  size_bytes: 11,
  source_id: '<msg-1@mail.example>',
  body_inline: 'Hello world',
  ...overrides,
});

describe('data_enrichment origin stamping', () => {
  let db: Database.Database;
  let store: EnrichmentStore;
  let idCounter: number;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    idCounter = 0;
    store = createEnrichmentStore(db, {
      now: () => 1_700_000_000_000 + idCounter,
      newId: () => `enr_${++idCounter}`,
    });
  });

  afterEach(() => {
    db.close();
  });

  it('defaults a per-record row without origin input to system/null', () => {
    const row = store.upsert({
      topic: 'contact_timeline_rollup',
      scope: 'contact',
      target_id: 'bob@x.com',
      value: validRollup,
      authored_by: 'system.housekeeping.rollup',
    });

    expect(row.origin_actor).toBe('system');
    expect(row.origin_contract_id).toBeNull();
  });

  it('persists threaded origin on a per-record row', () => {
    const row = store.upsert({
      topic: 'contact_timeline_rollup',
      scope: 'contact',
      target_id: 'agent-written@x.com',
      value: validRollup,
      authored_by: 'recipe.agent.rollup',
      origin_actor: 'contracted_user',
      origin_contract_id: 'c1',
    });

    expect(row.origin_actor).toBe('contracted_user');
    expect(row.origin_contract_id).toBe('c1');
  });

  it('defaults a platform-reference scope row without origin input to system/null', () => {
    const row = store.upsert({
      topic: 'deal_velocity_signal',
      scope: 'connection.api.hubspot.deal',
      target_id: 'hubspot_deal_1',
      value: validDealVelocity,
      authored_by: 'system.housekeeping.deal_velocity_signal',
    });

    expect(row.origin_actor).toBe('system');
    expect(row.origin_contract_id).toBeNull();
  });

  it('persists threaded origin on a platform-reference scope row', () => {
    const row = store.upsert({
      topic: 'deal_velocity_signal',
      scope: 'connection.api.hubspot.deal',
      target_id: 'hubspot_deal_2',
      value: validDealVelocity,
      authored_by: 'recipe.agent.deal_velocity_signal',
      origin_actor: 'contracted_user',
      origin_contract_id: 'c1',
    });

    expect(row.origin_actor).toBe('contracted_user');
    expect(row.origin_contract_id).toBe('c1');
  });

  it('re-stamps origin on an overwrite-mode update', () => {
    const first = store.upsert({
      topic: 'contact_timeline_rollup',
      scope: 'contact',
      target_id: 'rewrite@x.com',
      value: validRollup,
      authored_by: 'recipe.rewriter',
      mode: 'overwrite',
      origin_actor: 'contracted_user',
      origin_contract_id: 'c1',
    });
    const second = store.upsert({
      topic: 'contact_timeline_rollup',
      scope: 'contact',
      target_id: 'rewrite@x.com',
      value: { ...validRollup, interaction_count: 9 },
      authored_by: 'recipe.rewriter',
      mode: 'overwrite',
    });

    expect(second._id).toBe(first._id);
    expect(second.origin_actor).toBe('system');
    expect(second.origin_contract_id).toBeNull();
    expect(
      store.getByRecord(
        'contact_timeline_rollup',
        'contact',
        'rewrite@x.com',
        'recipe.rewriter',
      )?.origin_actor,
    ).toBe('system');
  });
});

describe('D-120 links origin stamping', () => {
  let db: Database.Database;
  let recipeInsightId: number;

  const links: EmittedLink[] = [
    {
      step_id: 's1',
      collection: 'mail',
      entity_id: 'msg-1',
      access: 'read',
      kind: 'execution.action',
      ts: 1_000,
    },
    {
      step_id: 's1',
      collection: 'deal',
      entity_id: '42',
      access: 'read',
      kind: 'execution.write',
      ts: 1_001,
    },
  ];

  const linkOrigins = () =>
    db
      .prepare(
        `SELECT entity_id, origin_actor, origin_contract_id
           FROM links
          ORDER BY entity_id`,
      )
      .all() as Array<{
        entity_id: string;
        origin_actor: string;
        origin_contract_id: string | null;
      }>;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSQLiteCollection<AuditEntry>(db, 'audit_entries');
    createSQLiteCollection<ActivityEntry>(db, 'audit_activities');
    ensureMemorySchema(db);
    recipeInsightId = getOrCreateRecipeInsight(db, {
      hash: 'h-1',
      slug: 'd-161',
      version: 1,
      flattened: '{"steps":[]}',
    });
  });

  afterEach(() => {
    db.close();
  });

  it('stamps ctx.origin on every inserted link row', () => {
    expect(
      insertLinks(
        db,
        {
          memory_id: 'run-1',
          recipe_insight_id: recipeInsightId,
          origin: {
            origin_actor: 'contracted_user',
            origin_contract_id: 'c1',
          },
        },
        links,
      ),
    ).toBe(2);

    expect(linkOrigins()).toEqual([
      {
        entity_id: 'deal:42',
        origin_actor: 'contracted_user',
        origin_contract_id: 'c1',
      },
      {
        entity_id: 'mail:msg-1',
        origin_actor: 'contracted_user',
        origin_contract_id: 'c1',
      },
    ]);
  });

  it('defaults omitted ctx.origin to system/null', () => {
    insertLinks(
      db,
      {
        memory_id: 'run-2',
        recipe_insight_id: recipeInsightId,
      },
      links,
    );

    expect(linkOrigins()).toEqual([
      {
        entity_id: 'deal:42',
        origin_actor: 'system',
        origin_contract_id: null,
      },
      {
        entity_id: 'mail:msg-1',
        origin_actor: 'system',
        origin_contract_id: null,
      },
    ]);
  });
});

describe('contact origin stamping', () => {
  let db: Database.Database;
  let store: ContactStore;

  beforeEach(() => {
    db = new Database(':memory:');
    store = createContactStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it('observe returns a sync-derived contact with system origin', () => {
    const record = store.observe(
      { email: 'bob@x.com', name: 'Bob', source: 'email_from', event_at: 100 },
      200,
    );

    expect(record.origin_actor).toBe('system');
  });

  it('observe leaves the contract id absent on the record and null in storage', () => {
    const record = store.observe(
      { email: 'alice@x.com', name: 'Alice', source: 'calendar_attendee', event_at: 100 },
      200,
    );
    const row = db
      .prepare(
        `SELECT origin_actor, origin_contract_id
           FROM contacts
          WHERE email = ?`,
      )
      .get(record.email) as { origin_actor: string; origin_contract_id: string | null };

    expect(record.origin_contract_id).toBeUndefined();
    expect(row).toEqual({
      origin_actor: 'system',
      origin_contract_id: null,
    });
  });
});

describe('collection table origin stamping', () => {
  let db: Database.Database;
  let table: CollectionTable;

  beforeEach(() => {
    db = new Database(':memory:');
    table = createCollectionTable({ db, platform: 'mail', slug: 'work' });
  });

  afterEach(() => {
    db.close();
  });

  it('get returns system origin for a record upserted without origin fields', () => {
    const record = makeCollectionRecord();

    table.upsert(record);

    expect(table.get(record.record_id)?.origin_actor).toBe('system');
  });

  it('stores system/null in the collection table origin columns by default', () => {
    const record = makeCollectionRecord({ record_id: 'uid:2@INBOX' });

    table.upsert(record);
    const row = db
      .prepare(
        `SELECT origin_actor, origin_contract_id
           FROM ${table.tableName}
          WHERE record_id = ?`,
      )
      .get(record.record_id) as { origin_actor: string; origin_contract_id: string | null };

    expect(row).toEqual({
      origin_actor: 'system',
      origin_contract_id: null,
    });
  });
});

describe('memory/audit origin derivation', () => {
  it('derives origin from an AuditEntry execution_source', () => {
    const entry: Pick<AuditEntry, 'execution_source'> = {
      execution_source: contractedMcpSource,
    };

    expect(originProvenanceFromOptionalSource(entry.execution_source)).toEqual({
      origin_actor: 'contracted_user',
      origin_contract_id: 'contract-1',
    });
  });

  it('defaults a missing AuditEntry execution_source to SYSTEM_ORIGIN', () => {
    const entry: Pick<AuditEntry, 'execution_source'> = {};

    expect(originProvenanceFromOptionalSource(entry.execution_source)).toBe(
      SYSTEM_ORIGIN,
    );
  });
});
