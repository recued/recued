/** D-136 P7.G read-site gates + D-187 S3b owner read-visibility rpc.
 *
 *  The §A.13.5 read gates resolve `mcp_exposed` per (bound contract, topic) from a
 *  per-contract override MAP (D-187): `registry.describe` filter, `enrichment.read`
 *  reject, `vector.similarity_search` reject, `timeline` gate. This suite drives those
 *  handlers with plain per-contract maps (the same `EnrichmentVisibilityOverrides`
 *  shape the dispatch boundary builds).
 *
 *  The `mcp.visibility.{read,write}` rpc (D-187 S3b) now reads/writes the OWNER
 *  contract's per-topic pins (`contract.enrichment.<OWNER_CONTRACT_ID>.*`) via the
 *  `ContractEnrichmentVisibilityStore`, not the retired per-pair `mcp_topic_visibility`
 *  side table. (Store CRUD has its own S1 suite; the `toggle ?? authorDefault`
 *  resolver has its own S2 suite — not re-covered here.)
 *
 *  Spec: docs/d-136-spec.md §A.13.5 + docs/d-187-spec.md §3.2 / §8 (S3b). */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ENRICHMENT_REGISTRY,
  OWNER_CONTRACT_ID,
  RpcError,
  resolveMCPExposure,
  topicGrantEntry,
  type EnrichmentDefinition,
  type EnrichmentTopic,
  type MCPExposurePolicy,
} from '@recued/contracts';
import { ensureHousekeepingSchema } from '../housekeeping/schema.js';
import { createContractStore } from '../storage/contract-store.js';
import {
  createContractGrantEntryStore,
  type ContractGrantEntryStore,
} from '../storage/contract-grant-entry-store.js';
import type { ReadGrantChecker } from '../read-grant-checker.js';
import {
  createEnrichmentStore,
  type EnrichmentStore,
} from '../storage/enrichment-store.js';
import { handleRegistryDescribe } from '../mcp/registry-describe.js';
import { handleEnrichmentRead } from '../mcp/enrichment-read.js';
import { handleVectorSimilaritySearch } from '../mcp/vector-similarity.js';
import {
  handleMCPVisibilityRead,
  handleMCPVisibilityWrite,
} from '../mcp-visibility-handler.js';

const NOW = 1_750_000_000_000;

let dir: string;
let db: Database.Database;
let store: EnrichmentStore;
/** OWNER grant store for the rpc blocks (`contract.contract_grant.<OWNER>.*`). */
let ownerGrant: ContractGrantEntryStore;

const PROBE_TOPIC: EnrichmentTopic = 'company';
const VECTOR_PROBE_TOPIC: EnrichmentTopic = 'embedding';

/** D-187 AMENDMENT — a per-dispatch read-grant checker pinned per topic, replacing the
 *  retired per-contract visibility map. Each pin is an explicit `enrichment.<topic>`
 *  grant (`'public'` ⇒ granted, `'private'` ⇒ revoked); an UNPINNED topic falls back to
 *  the registry author default (`mcp_exposed`) — exactly the retired
 *  `toggle ?? authorDefault` rule the read gates consumed. Collections are unfenced here
 *  (these cases exercise the enrichment plane). */
const pinChecker = (
  ...pins: ReadonlyArray<readonly [EnrichmentTopic, MCPExposurePolicy]>
): ReadGrantChecker => {
  const map = new Map<EnrichmentTopic, MCPExposurePolicy>(pins);
  return {
    isTopicReadGranted: (topic) => {
      const pin = map.get(topic);
      return pin !== undefined
        ? pin === 'public'
        : resolveMCPExposure(topic) === 'public';
    },
    isCollectionReadGranted: () => true,
    // D-187 slice 3 — these cases exercise the ENTRY (topic-visibility) term; admit the
    // verb-op so the read gate reduces to the topic grant under test.
    isVerbOpGranted: () => true,
  };
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-136-p7-g-'));
  db = new Database(join(dir, 'test.db'));
  ensureHousekeepingSchema(db);
  store = createEnrichmentStore(db, { now: () => NOW });
  ownerGrant = createContractGrantEntryStore(
    createContractStore(db, { now: () => NOW }),
  );
});

afterEach(() => {
  store.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const REGISTRY_MUT = ENRICHMENT_REGISTRY as Record<string, EnrichmentDefinition>;

// Mirrors the value shape `data.enrichment.company` validates per
// `ENRICHMENT_REGISTRY.company.value_schema` — the canonical helper
// from the P7.E gate test suite. Cleanly satisfies all required fields
// so `store.upsert` doesn't reject during fixture setup.
const COMPANY = (
  override: Partial<{ company_name: string; computed_at: number }> = {},
) => ({
  domain: 'acme.com',
  company_name: 'Acme',
  source: 'domain_only' as const,
  domain_category: 'business' as const,
  reasoning: 'derived from domain',
  computed_at: NOW,
  ...override,
});

const insertCompany = (target_id: string, ts: number, name: string): void => {
  store.upsert({
    topic: 'company',
    scope: 'contact',
    target_id,
    value: COMPANY({ company_name: name, computed_at: ts }),
    authored_by: 'system.housekeeping.company',
    event_at: ts,
  });
};

// ────────────────────────────────────────────────────────────────
// 1. handleRegistryDescribe + per-contract visibility override map
// ────────────────────────────────────────────────────────────────

describe('handleRegistryDescribe — visibility-override-aware', () => {
  it('filters topics overridden to private out of the response array (MCP path)', () => {
    insertCompany('alice@example.com', NOW, 'Acme');
    const out = handleRegistryDescribe({
      enrichmentStore: store,
      readGrantChecker: pinChecker([PROBE_TOPIC, 'private']),
      db,
    });
    expect(out.topics.find((t) => t.topic === PROBE_TOPIC)).toBeUndefined();
    // total_rows_visible subtracts the one company row.
    expect(out.total_rows_visible).toBe(0);
  });

  it('surfaces overridden-private topics when includePrivateTopics: true (Settings UI)', () => {
    insertCompany('alice@example.com', NOW, 'Acme');
    const out = handleRegistryDescribe({
      enrichmentStore: store,
      readGrantChecker: pinChecker([PROBE_TOPIC, 'private']),
      db,
      includePrivateTopics: true,
    });
    const entry = out.topics.find((t) => t.topic === PROBE_TOPIC);
    expect(entry).toBeDefined();
    expect(entry!.mcp_exposed).toBe('private');
    // The total_rows_visible field reflects the agent-visible total
    // (i.e. excludes private topic rows) regardless of who's asking —
    // it's a count of what an agent could reach via reads.
    expect(out.total_rows_visible).toBe(0);
  });

  it('override → public re-opens a registry-default-private topic', () => {
    const original = REGISTRY_MUT[PROBE_TOPIC]!.mcp_exposed;
    REGISTRY_MUT[PROBE_TOPIC]!.mcp_exposed = 'private';
    try {
      const out = handleRegistryDescribe({
        enrichmentStore: store,
        readGrantChecker: pinChecker([PROBE_TOPIC, 'public']),
      });
      expect(out.topics.find((t) => t.topic === PROBE_TOPIC)).toBeDefined();
    } finally {
      if (original === undefined) {
        delete REGISTRY_MUT[PROBE_TOPIC]!.mcp_exposed;
      } else {
        REGISTRY_MUT[PROBE_TOPIC]!.mcp_exposed = original;
      }
    }
  });
});

// ────────────────────────────────────────────────────────────────
// 2. enrichment.read + vector.similarity_search reject on override
// ────────────────────────────────────────────────────────────────

describe('handleEnrichmentRead — reject under override', () => {
  it("rejects when topic carries override 'private' (registry default was 'public')", () => {
    insertCompany('alice@example.com', NOW, 'Acme');
    expect(() =>
      handleEnrichmentRead(
        { enrichmentStore: store, readGrantChecker: pinChecker([PROBE_TOPIC, 'private']) },
        {
          topic: PROBE_TOPIC,
          scope: 'contact',
          target_id: 'alice@example.com',
        },
      ),
    ).toThrow(RpcError);
  });

  it("returns fall-through hint with reason 'topic_private' when freshness_budget_ms set", () => {
    insertCompany('alice@example.com', NOW, 'Acme');
    const out = handleEnrichmentRead(
      { enrichmentStore: store, readGrantChecker: pinChecker([PROBE_TOPIC, 'private']) },
      {
        topic: PROBE_TOPIC,
        scope: 'contact',
        target_id: 'alice@example.com',
        freshness_budget_ms: 60_000,
      },
    );
    expect(out.result).toBeNull();
    expect(out.fall_through_hint?.reason).toBe('topic_private');
  });

  it('still permits the read when no override pins the topic (registry default public)', () => {
    insertCompany('alice@example.com', NOW, 'Acme');
    const out = handleEnrichmentRead(
      { enrichmentStore: store, readGrantChecker: pinChecker() },
      {
        topic: PROBE_TOPIC,
        scope: 'contact',
        target_id: 'alice@example.com',
      },
    );
    expect(out.result).not.toBeNull();
  });
});

describe('handleVectorSimilaritySearch — reject under override', () => {
  it('rejects when topic carries override private', () => {
    expect(() =>
      handleVectorSimilaritySearch(
        { enrichmentStore: store, db, readGrantChecker: pinChecker([VECTOR_PROBE_TOPIC, 'private']) },
        {
          query_vector: [0.1, 0.2, 0.3],
          topic: VECTOR_PROBE_TOPIC,
          limit: 5,
        },
      ),
    ).toThrow(RpcError);
  });
});

// ────────────────────────────────────────────────────────────────
// 3. handleTimelineRequest — gateMcpPrivate opt-in semantic
// ────────────────────────────────────────────────────────────────

import { handleTimelineRequest } from '../mcp/timeline.js';
import { handleTimelineReadFromRecipe } from '../timeline-recipe-handler.js';

describe('handleTimelineRequest — gateMcpPrivate honours override', () => {
  it('default (gateMcpPrivate not set) returns rows even when override marks topic private', async () => {
    insertCompany('alice@example.com', NOW - 1000, 'Acme');
    const out = await handleTimelineRequest(
      { db, enrichmentStore: store, readGrantChecker: pinChecker([PROBE_TOPIC, 'private']) },
      { entity_id: 'contact:alice@example.com', limit: 50 },
    );
    const enrichmentEntries = out.entries.filter((e) => e.source === 'enrichment');
    expect(enrichmentEntries.length).toBe(1);
  });

  it('gateMcpPrivate: true filters rows when override marks topic private', async () => {
    insertCompany('alice@example.com', NOW - 1000, 'Acme');
    const out = await handleTimelineRequest(
      {
        db,
        enrichmentStore: store,
        readGrantChecker: pinChecker([PROBE_TOPIC, 'private']),
        gateMcpPrivate: true,
      },
      { entity_id: 'contact:alice@example.com', limit: 50 },
    );
    const enrichmentEntries = out.entries.filter((e) => e.source === 'enrichment');
    expect(enrichmentEntries.length).toBe(0);
  });

  it('gateMcpPrivate: true with no override → registry default applies (public passes)', async () => {
    insertCompany('alice@example.com', NOW - 1000, 'Acme');
    const out = await handleTimelineRequest(
      {
        db,
        enrichmentStore: store,
        readGrantChecker: pinChecker(),
        gateMcpPrivate: true,
      },
      { entity_id: 'contact:alice@example.com', limit: 50 },
    );
    const enrichmentEntries = out.entries.filter((e) => e.source === 'enrichment');
    expect(enrichmentEntries.length).toBe(1);
  });
});

describe('handleTimelineReadFromRecipe — trigger_source flips the gate', () => {
  it("trigger_source: 'mcp' applies the override gate", async () => {
    insertCompany('alice@example.com', NOW - 1000, 'Acme');
    const out = await handleTimelineReadFromRecipe(
      {
        timelineDeps: { db, enrichmentStore: store, readGrantChecker: pinChecker([PROBE_TOPIC, 'private']) },
      },
      {
        entity: 'contact:alice@example.com',
        limit: 50,
        trigger_source: 'mcp',
      },
    );
    const enrichmentEntries = out.entries.filter((e) => e.source === 'enrichment');
    expect(enrichmentEntries.length).toBe(0);
  });

  it("trigger_source: 'manual' bypasses the override gate (paired-client recipes see private rows)", async () => {
    insertCompany('alice@example.com', NOW - 1000, 'Acme');
    const out = await handleTimelineReadFromRecipe(
      {
        timelineDeps: { db, enrichmentStore: store, readGrantChecker: pinChecker([PROBE_TOPIC, 'private']) },
      },
      {
        entity: 'contact:alice@example.com',
        limit: 50,
        trigger_source: 'manual',
      },
    );
    const enrichmentEntries = out.entries.filter((e) => e.source === 'enrichment');
    expect(enrichmentEntries.length).toBe(1);
  });

  it('absent trigger_source bypasses the gate (defensive default)', async () => {
    insertCompany('alice@example.com', NOW - 1000, 'Acme');
    const out = await handleTimelineReadFromRecipe(
      {
        timelineDeps: { db, enrichmentStore: store, readGrantChecker: pinChecker([PROBE_TOPIC, 'private']) },
      },
      {
        entity: 'contact:alice@example.com',
        limit: 50,
      },
    );
    const enrichmentEntries = out.entries.filter((e) => e.source === 'enrichment');
    expect(enrichmentEntries.length).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────────
// 4. mcp.visibility.{read,write} rpc — OWNER read-scope (D-187 S3b)
// ────────────────────────────────────────────────────────────────

const pairedCaller = { instance_id: 'paired-1' };

describe('handleMCPVisibilityRead', () => {
  it('returns an empty list when no owner pins persisted', () => {
    expect(handleMCPVisibilityRead({ store: ownerGrant }).overrides).toEqual([]);
  });

  it('returns every persisted owner pin', () => {
    ownerGrant.set(OWNER_CONTRACT_ID, topicGrantEntry(PROBE_TOPIC), false, NOW);
    ownerGrant.set(OWNER_CONTRACT_ID, topicGrantEntry(VECTOR_PROBE_TOPIC), true, NOW + 1);
    const out = handleMCPVisibilityRead({ store: ownerGrant });
    expect(out.overrides).toHaveLength(2);
    expect(out.overrides.find((o) => o.topic === PROBE_TOPIC)?.policy).toBe('private');
    expect(out.overrides.find((o) => o.topic === VECTOR_PROBE_TOPIC)?.policy).toBe('public');
  });

  it('does not surface another contract\'s pins (owner-scoped)', () => {
    ownerGrant.set('door-contract-a', topicGrantEntry(PROBE_TOPIC), false, NOW);
    expect(handleMCPVisibilityRead({ store: ownerGrant }).overrides).toEqual([]);
  });
});

describe('handleMCPVisibilityWrite', () => {
  it('persists an owner pin + returns the effective policy', () => {
    const out = handleMCPVisibilityWrite(
      { store: ownerGrant, now: () => NOW },
      { topic: PROBE_TOPIC, policy: 'private' },
      pairedCaller,
    );
    expect(out).toEqual({ ok: true, effective_policy: 'private' });
    expect(ownerGrant.get(OWNER_CONTRACT_ID, topicGrantEntry(PROBE_TOPIC))).toBe(false);
  });

  it('clears an owner pin when policy: null + returns registry default', () => {
    ownerGrant.set(OWNER_CONTRACT_ID, topicGrantEntry(PROBE_TOPIC), false, NOW);
    const out = handleMCPVisibilityWrite(
      { store: ownerGrant, now: () => NOW },
      { topic: PROBE_TOPIC, policy: null },
      pairedCaller,
    );
    expect(out.effective_policy).toBe('public');
    expect(ownerGrant.get(OWNER_CONTRACT_ID, topicGrantEntry(PROBE_TOPIC))).toBeUndefined();
  });

  it('rejects unregistered callers (no instance_id)', () => {
    expect(() =>
      handleMCPVisibilityWrite(
        { store: ownerGrant },
        { topic: PROBE_TOPIC, policy: 'private' },
        { instance_id: null },
      ),
    ).toThrow(/requires a paired client/);
  });

  it('rejects unknown topics', () => {
    expect(() =>
      handleMCPVisibilityWrite(
        { store: ownerGrant },
        { topic: 'not_a_real_topic', policy: 'private' },
        pairedCaller,
      ),
    ).toThrow(/unknown topic/);
  });

  it('rejects invalid policy values', () => {
    expect(() =>
      handleMCPVisibilityWrite(
        { store: ownerGrant },
        { topic: PROBE_TOPIC, policy: 'sometimes_maybe' },
        pairedCaller,
      ),
    ).toThrow(/policy must be one of/);
  });
});
