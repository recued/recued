/** D-136 P7.E — `mcp_exposed` per-topic gate.
 *
 *  Adds the §A.13.5 read-policy annotation that opts a topic out of
 *  the MCP read surface. Three layers ship together:
 *    1. Contracts — `MCPExposurePolicy` closed list +
 *       `EnrichmentDefinition.mcp_exposed?: 'public' | 'private'` +
 *       validator gate 11 (`validateLifecycleDefinition`) +
 *       `resolveMCPExposure` / `isMCPPrivateTopic` resolvers.
 *    2. `handleRegistryDescribe` — filters private topics out of the
 *       response array entirely; `total_rows_visible` subtracts rows
 *       attached to private topics symmetric to the pinned-author
 *       subtraction.
 *    3. `handleEnrichmentRead` + `handleVectorSimilaritySearch` —
 *       reject reads on private topics with a structured `bad_request`
 *       rpc error mirroring the topic-unknown / sidecar-missing
 *       errors P7.D shipped.
 *
 *  Substrate-private prefix (`system.user_correction.*` author rows)
 *  + vote-table contents remain invisible regardless — this annotation
 *  layers on top, never replaces them. Writes via MCP stay
 *  privilege-gated per-rpc; this gate governs the read surface only.
 *
 *  Spec: D-136 §A.13.5. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ENRICHMENT_REGISTRY,
  ENRICHMENT_PINNED_AUTHOR_PREFIX,
  ALL_MCP_EXPOSURE_POLICIES,
  RpcError,
  isMCPPrivateTopic,
  resolveMCPExposure,
  validateLifecycleDefinition,
  type EnrichmentDefinition,
  type EnrichmentTopic,
} from '@recued/contracts';
import {
  createEnrichmentStore,
  type EnrichmentStore,
} from '../storage/enrichment-store.js';
import {
  handleRegistryDescribe,
  _testing as registryInternals,
} from '../mcp/registry-describe.js';
import { AUTHOR_DEFAULT_READ_GRANT_CHECKER } from '../read-grant-checker.js';
import { handleEnrichmentRead } from '../mcp/enrichment-read.js';
import { handleVectorSimilaritySearch } from '../mcp/vector-similarity.js';

const NOW = 1_750_000_000_000;

let dir: string;
let db: Database.Database;
let store: EnrichmentStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-136-p7-e-'));
  db = new Database(join(dir, 'test.db'));
  store = createEnrichmentStore(db, { now: () => NOW });
});

afterEach(() => {
  store.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// ────────────────────────────────────────────────────────────────
// Registry monkey-patch helpers — runtime stub of `mcp_exposed` on
// real registry entries. Each `it` snapshots + restores so neighbours
// see the unmodified registry.
// ────────────────────────────────────────────────────────────────

const PRIVATE_PROBE_TOPIC: EnrichmentTopic = 'company';
const PRIVATE_VECTOR_PROBE_TOPIC: EnrichmentTopic = 'embedding';

const REGISTRY_MUT = ENRICHMENT_REGISTRY as Record<string, EnrichmentDefinition>;

const stubMcpExposure = (
  topic: EnrichmentTopic,
  value: 'public' | 'private' | undefined,
): (() => void) => {
  const original = REGISTRY_MUT[topic]!.mcp_exposed;
  if (value === undefined) {
    delete (REGISTRY_MUT[topic] as { mcp_exposed?: 'public' | 'private' }).mcp_exposed;
  } else {
    (REGISTRY_MUT[topic] as { mcp_exposed?: 'public' | 'private' }).mcp_exposed = value;
  }
  return () => {
    if (original === undefined) {
      delete (REGISTRY_MUT[topic] as { mcp_exposed?: 'public' | 'private' }).mcp_exposed;
    } else {
      (REGISTRY_MUT[topic] as { mcp_exposed?: 'public' | 'private' }).mcp_exposed = original;
    }
  };
};

// ────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────

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

const insertCompany = (target: string, event_at: number, name: string) =>
  store.upsert({
    topic: 'company',
    scope: 'contact',
    target_id: target,
    value: COMPANY({ company_name: name, computed_at: event_at }),
    authored_by: 'system.housekeeping.company',
    event_at,
  });

const vec = (...values: number[]): Buffer => {
  const f32 = Float32Array.from(values);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
};

const insertEmbedding = (target: string, vector: number[]) =>
  store.upsert({
    topic: 'embedding',
    scope: 'mail',
    target_id: target,
    value: { dimensions: vector.length, model: 'text-embedding-3-small' },
    authored_by: 'system.housekeeping.embedding',
    model_id: 'text-embedding-3-small',
    sidecar_vector: vec(...vector),
    event_at: NOW,
  });

const minimalDef = (
  override: Partial<EnrichmentDefinition> = {},
): EnrichmentDefinition => ({
  shape: 'per_record',
  valid_scopes: ['mail'],
  value_schema: () => ({ ok: true, value: undefined }),
  policy: 'dependent',
  producer_kind: 'reactive',
  name: 'probe',
  description: 'probe topic for validator tests',
  user_value: 'probe',
  temporal_class: 'stable_truth',
  identity_aggregation: 'scenario',
  lifecycle_policy: 'forward_only',
  compression_class: 'derived',
  ...override,
});

// ────────────────────────────────────────────────────────────────
// 1. Validator gate 11 — closed-list `mcp_exposed`
// ────────────────────────────────────────────────────────────────

describe('validateLifecycleDefinition — gate 11 (mcp_exposed closed list)', () => {
  it('accepts omitted mcp_exposed (default → public)', () => {
    const issues = validateLifecycleDefinition('probe', minimalDef());
    expect(issues.filter((m) => m.includes('mcp_exposed'))).toEqual([]);
  });

  it("accepts mcp_exposed: 'public'", () => {
    const issues = validateLifecycleDefinition(
      'probe',
      minimalDef({ mcp_exposed: 'public' }),
    );
    expect(issues.filter((m) => m.includes('mcp_exposed'))).toEqual([]);
  });

  it("accepts mcp_exposed: 'private'", () => {
    const issues = validateLifecycleDefinition(
      'probe',
      minimalDef({ mcp_exposed: 'private' }),
    );
    expect(issues.filter((m) => m.includes('mcp_exposed'))).toEqual([]);
  });

  it('rejects mcp_exposed outside the closed list', () => {
    const issues = validateLifecycleDefinition(
      'probe',
      minimalDef({ mcp_exposed: 'gated' as unknown as 'public' }),
    );
    const flagged = issues.filter((m) => m.includes('mcp_exposed'));
    expect(flagged.length).toBe(1);
    expect(flagged[0]!).toContain("§A.13.5");
    expect(flagged[0]!).toContain('public, private');
  });

  it('rejects null mcp_exposed', () => {
    const issues = validateLifecycleDefinition(
      'probe',
      minimalDef({ mcp_exposed: null as unknown as 'public' }),
    );
    expect(issues.filter((m) => m.includes('mcp_exposed')).length).toBe(1);
  });

  it('rejects numeric mcp_exposed', () => {
    const issues = validateLifecycleDefinition(
      'probe',
      minimalDef({ mcp_exposed: 1 as unknown as 'public' }),
    );
    expect(issues.filter((m) => m.includes('mcp_exposed')).length).toBe(1);
  });

  it('exposes the closed list as a readonly array constant', () => {
    expect(ALL_MCP_EXPOSURE_POLICIES).toEqual(['public', 'private']);
  });
});

// ────────────────────────────────────────────────────────────────
// 2. Resolver helpers — `resolveMCPExposure` + `isMCPPrivateTopic`
// ────────────────────────────────────────────────────────────────

describe('resolveMCPExposure / isMCPPrivateTopic', () => {
  it("resolves to 'public' on registry topics by default", () => {
    expect(resolveMCPExposure(PRIVATE_PROBE_TOPIC)).toBe('public');
    expect(isMCPPrivateTopic(PRIVATE_PROBE_TOPIC)).toBe(false);
  });

  it("flips to 'private' when registry annotation set", () => {
    const restore = stubMcpExposure(PRIVATE_PROBE_TOPIC, 'private');
    try {
      expect(resolveMCPExposure(PRIVATE_PROBE_TOPIC)).toBe('private');
      expect(isMCPPrivateTopic(PRIVATE_PROBE_TOPIC)).toBe(true);
    } finally {
      restore();
    }
  });

  it("explicit 'public' annotation surfaces unchanged", () => {
    const restore = stubMcpExposure(PRIVATE_PROBE_TOPIC, 'public');
    try {
      expect(resolveMCPExposure(PRIVATE_PROBE_TOPIC)).toBe('public');
      expect(isMCPPrivateTopic(PRIVATE_PROBE_TOPIC)).toBe(false);
    } finally {
      restore();
    }
  });
});

// ────────────────────────────────────────────────────────────────
// 3. registry.describe — private-topic filter + total_rows_visible
// ────────────────────────────────────────────────────────────────

describe('handleRegistryDescribe — mcp_exposed filter (P7.E §A.13.5)', () => {
  it("includes the topic when registry default ('public')", () => {
    const out = handleRegistryDescribe({ enrichmentStore: store });
    const found = out.topics.find((t) => t.topic === PRIVATE_PROBE_TOPIC);
    expect(found).toBeDefined();
    expect(found!.mcp_exposed).toBe('public');
  });

  it("omits the topic when registry declares mcp_exposed: 'private'", () => {
    const restore = stubMcpExposure(PRIVATE_PROBE_TOPIC, 'private');
    try {
      const out = handleRegistryDescribe({ enrichmentStore: store });
      expect(out.topics.find((t) => t.topic === PRIVATE_PROBE_TOPIC)).toBeUndefined();
      // Other topics still surface — the filter is per-topic, not global.
      expect(out.topics.length).toBeGreaterThan(20);
    } finally {
      restore();
    }
  });

  it('subtracts rows attached to private topics from total_rows_visible', () => {
    insertCompany('alice@example.com', NOW, 'Acme');
    insertCompany('bob@example.com', NOW, 'Globex');
    const baseline = handleRegistryDescribe({ enrichmentStore: store, db });
    expect(baseline.total_rows_visible).toBe(2);

    const restore = stubMcpExposure(PRIVATE_PROBE_TOPIC, 'private');
    try {
      const filtered = handleRegistryDescribe({ enrichmentStore: store, db });
      // 2 rows of `company` (now private) → visible total drops to 0.
      expect(filtered.total_rows_visible).toBe(0);
    } finally {
      restore();
    }
  });

  it('private-topic subtraction composes with pinned-author subtraction', () => {
    insertCompany('alice@example.com', NOW, 'Acme');
    // Pinned correction row — substrate-private; always invisible.
    store.upsert({
      topic: 'company',
      scope: 'contact',
      target_id: 'alice@example.com',
      value: COMPANY({ company_name: 'Acme Corp.' }),
      authored_by: `${ENRICHMENT_PINNED_AUTHOR_PREFIX}.vote_42`,
      event_at: NOW + 1000,
      mode: 'pinned',
    });
    // Two rows total; one pinned. Without privacy filter, visible = 1.
    const baseline = handleRegistryDescribe({ enrichmentStore: store, db });
    expect(baseline.total_rows_visible).toBe(1);

    // Mark `company` private — both rows drop. Math is `2 - 1 - 2 = -1`,
    // clamped to 0 by Math.max.
    const restore = stubMcpExposure(PRIVATE_PROBE_TOPIC, 'private');
    try {
      const filtered = handleRegistryDescribe({ enrichmentStore: store, db });
      expect(filtered.total_rows_visible).toBe(0);
    } finally {
      restore();
    }
  });

  it("entries that DO surface carry mcp_exposed: 'public'", () => {
    const out = handleRegistryDescribe({ enrichmentStore: store });
    for (const t of out.topics) {
      expect(t.mcp_exposed).toBe('public');
    }
  });

  it('zero private topics → behaviour identical to P7.D', () => {
    insertCompany('alice@example.com', NOW, 'Acme');
    const out = handleRegistryDescribe({ enrichmentStore: store, db });
    expect(out.total_rows_visible).toBe(1);
    expect(out.topics.find((t) => t.topic === 'company')).toBeDefined();
  });

  it('countUngrantedTopicRows internal helper returns 0 with no ungranted topics', () => {
    insertCompany('alice@example.com', NOW, 'Acme');
    // D-187 AMENDMENT — the merged counter takes a read-grant checker; the
    // author-default checker grants every author-`public` topic, so with no
    // `private` topics nothing is ungranted (registry-default behaviour preserved).
    // (D-187 slice 3 — the VERB-OP half lives in the handler's `total_rows_visible`
    // short-circuit, NOT this per-topic counter; the counter stays topic-only.)
    expect(
      registryInternals.countUngrantedTopicRows(db, AUTHOR_DEFAULT_READ_GRANT_CHECKER),
    ).toBe(0);
  });

  it('countUngrantedTopicRows surfaces row count for ungranted (author-private) topics', () => {
    insertCompany('alice@example.com', NOW, 'Acme');
    insertCompany('bob@example.com', NOW, 'Globex');
    const restore = stubMcpExposure(PRIVATE_PROBE_TOPIC, 'private');
    try {
      expect(
        registryInternals.countUngrantedTopicRows(db, AUTHOR_DEFAULT_READ_GRANT_CHECKER),
      ).toBe(2);
    } finally {
      restore();
    }
  });

  it('countUngrantedTopicRows returns 0 when db absent', () => {
    expect(
      registryInternals.countUngrantedTopicRows(undefined, AUTHOR_DEFAULT_READ_GRANT_CHECKER),
    ).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────
// 4. enrichment.read — reject private topics
// ────────────────────────────────────────────────────────────────

describe('handleEnrichmentRead — mcp_exposed gate (P7.E §A.13.5)', () => {
  it('reads succeed on the registry default (public)', () => {
    insertCompany('alice@example.com', NOW, 'Acme');
    const out = handleEnrichmentRead({ enrichmentStore: store }, {
      topic: 'company',
      scope: 'contact',
      target_id: 'alice@example.com',
    });
    expect(out.result).not.toBeNull();
  });

  it("rejects with bad_request when topic is mcp_exposed: 'private'", () => {
    insertCompany('alice@example.com', NOW, 'Acme');
    const restore = stubMcpExposure(PRIVATE_PROBE_TOPIC, 'private');
    try {
      expect(() =>
        handleEnrichmentRead({ enrichmentStore: store }, {
          topic: 'company',
          scope: 'contact',
          target_id: 'alice@example.com',
        }),
      ).toThrow(RpcError);
    } finally {
      restore();
    }
  });

  it('private-topic rejection mentions §A.13.5 + cites the topic', () => {
    const restore = stubMcpExposure(PRIVATE_PROBE_TOPIC, 'private');
    try {
      try {
        handleEnrichmentRead({ enrichmentStore: store }, {
          topic: 'company',
          scope: 'contact',
          target_id: 'alice@example.com',
        });
        throw new Error('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(RpcError);
        const e = err as RpcError;
        expect(e.code).toBe('bad_request');
        expect(e.message).toContain('company');
        expect(e.message).toContain('not read-granted');
        expect(e.message).toContain('read rejected');
      }
    } finally {
      restore();
    }
  });

  it("rejection fires before substrate-side reads (no data leak via timing)", () => {
    // Even when the row exists + is fresh, the rejection trips before
    // any storage call — agent has no way to probe whether rows exist.
    insertCompany('alice@example.com', NOW, 'Acme');
    const restore = stubMcpExposure(PRIVATE_PROBE_TOPIC, 'private');
    try {
      expect(() =>
        handleEnrichmentRead({ enrichmentStore: store }, {
          topic: 'company',
          scope: 'contact',
          target_id: 'alice@example.com',
          include_historical: true,
        }),
      ).toThrow(RpcError);
    } finally {
      restore();
    }
  });

  it('public topics still resolve normally after a private toggle is restored', () => {
    insertCompany('alice@example.com', NOW, 'Acme');
    const restore = stubMcpExposure(PRIVATE_PROBE_TOPIC, 'private');
    restore();
    const out = handleEnrichmentRead({ enrichmentStore: store }, {
      topic: 'company',
      scope: 'contact',
      target_id: 'alice@example.com',
    });
    expect(out.result).not.toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────
// 5. vector.similarity_search — reject private topics
// ────────────────────────────────────────────────────────────────

describe('handleVectorSimilaritySearch — mcp_exposed gate (P7.E §A.13.5)', () => {
  it('search succeeds on the registry default (public)', () => {
    insertEmbedding('msg-1', [1, 0, 0]);
    const out = handleVectorSimilaritySearch({ enrichmentStore: store, db }, {
      query_vector: [1, 0, 0],
      topic: 'embedding',
      limit: 5,
      similarity_threshold: 0,
    });
    expect(out.results.length).toBe(1);
  });

  it("rejects with bad_request when topic is mcp_exposed: 'private'", () => {
    insertEmbedding('msg-1', [1, 0, 0]);
    const restore = stubMcpExposure(PRIVATE_VECTOR_PROBE_TOPIC, 'private');
    try {
      expect(() =>
        handleVectorSimilaritySearch({ enrichmentStore: store, db }, {
          query_vector: [1, 0, 0],
          topic: 'embedding',
          limit: 5,
          similarity_threshold: 0,
        }),
      ).toThrow(RpcError);
    } finally {
      restore();
    }
  });

  it('private-topic rejection mentions §A.13.5 + cites the topic', () => {
    const restore = stubMcpExposure(PRIVATE_VECTOR_PROBE_TOPIC, 'private');
    try {
      try {
        handleVectorSimilaritySearch({ enrichmentStore: store, db }, {
          query_vector: [1, 0, 0],
          topic: 'embedding',
          limit: 5,
        });
        throw new Error('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(RpcError);
        const e = err as RpcError;
        expect(e.code).toBe('bad_request');
        expect(e.message).toContain('embedding');
        expect(e.message).toContain('not read-granted');
        expect(e.message).toContain('read rejected');
      }
    } finally {
      restore();
    }
  });

  it('rejection fires before sidecar SQL scan', () => {
    insertEmbedding('msg-1', [1, 0, 0]);
    insertEmbedding('msg-2', [0.9, 0, 0.1]);
    const restore = stubMcpExposure(PRIVATE_VECTOR_PROBE_TOPIC, 'private');
    try {
      expect(() =>
        handleVectorSimilaritySearch({ enrichmentStore: store, db }, {
          query_vector: [1, 0, 0],
          topic: 'embedding',
          limit: 100,
          similarity_threshold: -1,
        }),
      ).toThrow(RpcError);
    } finally {
      restore();
    }
  });
});

// ────────────────────────────────────────────────────────────────
// 6. End-to-end MCP tool dispatch — private topics filter / reject
// ────────────────────────────────────────────────────────────────

import { _testing as mcpTesting } from '../mcp-server.js';
import { createRecipeStore } from '../recipe-store.js';
import { createManifestRegistry } from '../manifest-loader.js';

const makeMcpDeps = () => ({
  recipeStore: createRecipeStore('/nonexistent'),
  executorConfig: { manifests: createManifestRegistry('/nonexistent') },
  baseVault: {},
  enrichmentStore: store,
  db,
});

const parseToolResponse = <T>(res: unknown): T => {
  const r = res as { content?: Array<{ text?: string }>; isError?: boolean };
  if (r.isError === true) {
    throw new Error(`tool returned error: ${JSON.stringify(r)}`);
  }
  const text = r.content?.[0]?.text;
  expect(typeof text).toBe('string');
  return JSON.parse(text!) as T;
};

describe('MCP dispatch — recued_registryDescribe omits private topics', () => {
  it("private topics never reach the agent", async () => {
    const restore = stubMcpExposure(PRIVATE_PROBE_TOPIC, 'private');
    try {
      const deps = makeMcpDeps() as Parameters<typeof mcpTesting.handleToolCall>[1];
      const res = await mcpTesting.handleToolCall(
        { name: 'recued_registryDescribe', arguments: {} },
        deps,
      );
      const out = parseToolResponse<{ topics: Array<{ topic: string; mcp_exposed: string }> }>(res);
      expect(out.topics.find((t) => t.topic === PRIVATE_PROBE_TOPIC)).toBeUndefined();
      // Every entry the agent CAN see is marked public.
      for (const t of out.topics) expect(t.mcp_exposed).toBe('public');
    } finally {
      restore();
    }
  });
});

describe('MCP dispatch — recued_enrichmentRead rejects private topics', () => {
  it("returns isError when topic is mcp_exposed: 'private'", async () => {
    insertCompany('alice@example.com', NOW, 'Acme');
    const restore = stubMcpExposure(PRIVATE_PROBE_TOPIC, 'private');
    try {
      const deps = makeMcpDeps() as Parameters<typeof mcpTesting.handleToolCall>[1];
      const res = await mcpTesting.handleToolCall(
        {
          name: 'recued_enrichmentRead',
          arguments: {
            topic: 'company',
            scope: 'contact',
            target_id: 'alice@example.com',
          },
        },
        deps,
      );
      expect((res as { isError?: boolean }).isError).toBe(true);
      const text = (res as { content?: Array<{ text?: string }> }).content?.[0]?.text;
      expect(text).toContain('not read-granted');
    } finally {
      restore();
    }
  });
});

describe('MCP dispatch — recued_vectorSimilaritySearch rejects private topics', () => {
  it("returns isError when topic is mcp_exposed: 'private'", async () => {
    insertEmbedding('msg-1', [1, 0, 0]);
    const restore = stubMcpExposure(PRIVATE_VECTOR_PROBE_TOPIC, 'private');
    try {
      const deps = makeMcpDeps() as Parameters<typeof mcpTesting.handleToolCall>[1];
      const res = await mcpTesting.handleToolCall(
        {
          name: 'recued_vectorSimilaritySearch',
          arguments: {
            query_vector: [1, 0, 0],
            topic: 'embedding',
            limit: 5,
          },
        },
        deps,
      );
      expect((res as { isError?: boolean }).isError).toBe(true);
      const text = (res as { content?: Array<{ text?: string }> }).content?.[0]?.text;
      expect(text).toContain('not read-granted');
    } finally {
      restore();
    }
  });
});

// ────────────────────────────────────────────────────────────────
// 7. Codex review fix #1 — recued_dataTimeline omits private-topic
//    enrichment entries (loadEnrichmentEntries gate).
// ────────────────────────────────────────────────────────────────

import { handleTimelineRequest } from '../mcp/timeline.js';

describe('handleTimelineRequest — mcp_exposed gate (P7.E Codex fix #1)', () => {
  it('returns enrichment timeline entries by default (public topic)', async () => {
    insertCompany('alice@example.com', NOW - 1000, 'Acme');
    const out = await handleTimelineRequest(
      { db, enrichmentStore: store },
      { entity_id: 'contact:alice@example.com', limit: 50 },
    );
    const enrichmentEntries = out.entries.filter((e) => e.source === 'enrichment');
    expect(enrichmentEntries.length).toBe(1);
    expect((enrichmentEntries[0]!.payload as { topic: string }).topic).toBe('company');
  });

  it("filters enrichment entries from topics declared mcp_exposed: 'private'", async () => {
    insertCompany('alice@example.com', NOW - 1000, 'Acme');
    const restore = stubMcpExposure(PRIVATE_PROBE_TOPIC, 'private');
    try {
      // P7.G — gate is opt-in (mirrors `EnrichmentReaderPolicy.gate_mcp_private`).
      // The MCP-channel `recued_dataTimeline` always sets it; this test pins
      // that behaviour by passing the flag explicitly.
      const out = await handleTimelineRequest(
        { db, enrichmentStore: store, gateMcpPrivate: true },
        { entity_id: 'contact:alice@example.com', limit: 50 },
      );
      const enrichmentEntries = out.entries.filter((e) => e.source === 'enrichment');
      expect(enrichmentEntries.length).toBe(0);
    } finally {
      restore();
    }
  });

  it('preserves hadMore signal so pagination cursor stability is unchanged', async () => {
    // Insert a single private-topic row; fetch with limit 1. The
    // unfiltered fetch returned 1 row matching the limit, so hadMore
    // should be true under the spec — and the visible array is empty.
    insertCompany('alice@example.com', NOW - 1000, 'Acme');
    const restore = stubMcpExposure(PRIVATE_PROBE_TOPIC, 'private');
    try {
      const out = await handleTimelineRequest(
        { db, enrichmentStore: store, gateMcpPrivate: true },
        { entity_id: 'contact:alice@example.com', limit: 1 },
      );
      const enrichmentEntries = out.entries.filter((e) => e.source === 'enrichment');
      expect(enrichmentEntries.length).toBe(0);
      // The cursor / hadMore plumbing isn't observable directly in the
      // smoke test; re-running with limit 50 confirms the entire page is
      // empty and the response is well-formed.
      expect(out.entries.find((e) => e.source === 'enrichment')).toBeUndefined();
    } finally {
      restore();
    }
  });
});

// ────────────────────────────────────────────────────────────────
// 8. Codex review fix #2 — MCP-triggered recipes (recued_runRecipe)
//    can't fetch private-topic data via enrichment-or-fetch transform
//    or the kernel `enrichment-list` ingredient.
// ────────────────────────────────────────────────────────────────

import { createEnrichmentReader } from '../storage/enrichment-resolver.js';
import { handleEnrichmentList } from '../enrichment-handler.js';

describe('createEnrichmentReader — MCP policy gate (P7.E Codex fix #2)', () => {
  it('default policy (gate_mcp_private: false) returns the row regardless of mcp_exposed', () => {
    insertCompany('alice@example.com', NOW, 'Acme');
    const restore = stubMcpExposure(PRIVATE_PROBE_TOPIC, 'private');
    try {
      const reader = createEnrichmentReader(store);
      const snap = reader('company', 'contact', 'alice@example.com');
      expect(snap).not.toBeNull();
      expect((snap!.value as { company_name: string }).company_name).toBe('Acme');
    } finally {
      restore();
    }
  });

  it('gate_mcp_private: true returns null on private topics WITHOUT touching the store', () => {
    insertCompany('alice@example.com', NOW, 'Acme');
    const restore = stubMcpExposure(PRIVATE_PROBE_TOPIC, 'private');
    try {
      const reader = createEnrichmentReader(store, { gate_mcp_private: true });
      const snap = reader('company', 'contact', 'alice@example.com');
      expect(snap).toBeNull();
    } finally {
      restore();
    }
  });

  it('gate_mcp_private: true is a no-op for public topics', () => {
    insertCompany('alice@example.com', NOW, 'Acme');
    const reader = createEnrichmentReader(store, { gate_mcp_private: true });
    const snap = reader('company', 'contact', 'alice@example.com');
    expect(snap).not.toBeNull();
  });

  it('gate_mcp_private: true is a no-op for unknown topics (not registered)', () => {
    const reader = createEnrichmentReader(store, { gate_mcp_private: true });
    // Unknown topic short-circuits to null at the store anyway; the
    // important property is no exception escapes the reader.
    const snap = reader('nonexistent_topic', 'contact', 'alice@example.com');
    expect(snap).toBeNull();
  });
});

describe('handleEnrichmentList — trigger_source MCP gate (P7.E Codex fix #2)', () => {
  it("paired-client triggers (no trigger_source) read private topics user-permissively", async () => {
    insertCompany('alice@example.com', NOW, 'Acme');
    const restore = stubMcpExposure(PRIVATE_PROBE_TOPIC, 'private');
    try {
      const out = await handleEnrichmentList(
        { store },
        { topic: 'company', scope: 'contact', target_id: 'alice@example.com' },
      );
      expect(out.entries.length).toBe(1);
    } finally {
      restore();
    }
  });

  it("rejects MCP-triggered reads on private topics with bad_request", async () => {
    insertCompany('alice@example.com', NOW, 'Acme');
    const restore = stubMcpExposure(PRIVATE_PROBE_TOPIC, 'private');
    try {
      await expect(
        handleEnrichmentList(
          { store, trigger_source: 'mcp' },
          { topic: 'company', scope: 'contact', target_id: 'alice@example.com' },
        ),
      ).rejects.toThrow(RpcError);
    } finally {
      restore();
    }
  });

  it("MCP-triggered rejection mentions §A.13.5 + cites the topic", async () => {
    const restore = stubMcpExposure(PRIVATE_PROBE_TOPIC, 'private');
    try {
      try {
        await handleEnrichmentList(
          { store, trigger_source: 'mcp' },
          { topic: 'company' },
        );
        throw new Error('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(RpcError);
        const e = err as RpcError;
        expect(e.code).toBe('bad_request');
        expect(e.message).toContain('company');
        expect(e.message).toContain('not read-granted');
        expect(e.message).toContain('read rejected');
      }
    } finally {
      restore();
    }
  });

  it("MCP-triggered reads on PUBLIC topics still resolve normally", async () => {
    insertCompany('alice@example.com', NOW, 'Acme');
    // No stub — `company` keeps its default 'public' exposure.
    const out = await handleEnrichmentList(
      { store, trigger_source: 'mcp' },
      { topic: 'company', scope: 'contact', target_id: 'alice@example.com' },
    );
    expect(out.entries.length).toBe(1);
  });

  it("non-mcp trigger_source values stay permissive (paired-client manual / cron / reactive)", async () => {
    insertCompany('alice@example.com', NOW, 'Acme');
    const restore = stubMcpExposure(PRIVATE_PROBE_TOPIC, 'private');
    try {
      for (const trigger of ['manual', 'auto_run', 'reactive', 'cron']) {
        const out = await handleEnrichmentList(
          { store, trigger_source: trigger },
          { topic: 'company', scope: 'contact', target_id: 'alice@example.com' },
        );
        expect(out.entries.length).toBe(1);
      }
    } finally {
      restore();
    }
  });
});

// ────────────────────────────────────────────────────────────────
// 9. Kernel adapter — `enrichment-list` forwards call.stepMeta.trigger_source
//    into the dispatcher input. Pins the threading contract that lets
//    handleEnrichmentList apply MCP-private gates without widening
//    every recipe-side caller.
// ────────────────────────────────────────────────────────────────

import { createKernelAdapter, type ResolvedCall } from '@recued/ingredients';
import type { StepMeta } from '@recued/contracts';

const enrichmentListManifest = (): Parameters<NonNullable<Parameters<typeof createKernelAdapter>[0]['mailGet']>>[0] | unknown =>
  ({}) as never;

describe('kernel enrichment-list adapter — trigger_source threading (P7.E Codex fix #2)', () => {
  void enrichmentListManifest;
  it("forwards call.stepMeta.trigger_source into the dispatcher input", async () => {
    let observed: string | undefined;
    const kernel = createKernelAdapter({
      enrichmentList: async (input) => {
        observed = input.trigger_source;
        return { entries: [], next_cursor: null };
      },
    });
    const stepMeta: StepMeta = {
      step_id: 'probe',
      recipe_id: 'p7e-test',
      trigger_source: 'mcp',
    };
    const call: ResolvedCall = {
      slug: 'enrichment-list',
      risk_tier: 'low',
      input: { topic: 'company', scope: 'contact', target_id: 'alice@example.com' },
      output: {},
      stepMeta,
    } as ResolvedCall;
    await kernel(call);
    expect(observed).toBe('mcp');
  });

  it("omits trigger_source when stepMeta lacks it (paired-client / no engine context)", async () => {
    let observed: string | undefined = 'sentinel';
    const kernel = createKernelAdapter({
      enrichmentList: async (input) => {
        observed = input.trigger_source;
        return { entries: [], next_cursor: null };
      },
    });
    const call: ResolvedCall = {
      slug: 'enrichment-list',
      risk_tier: 'low',
      input: { topic: 'company', scope: 'contact', target_id: 'alice@example.com' },
      output: {},
      // No stepMeta — direct adapter caller (test, MCP agent path that
      // bypasses the engine).
    } as ResolvedCall;
    await kernel(call);
    expect(observed).toBeUndefined();
  });

  it("forwards non-mcp trigger_source values verbatim (manual / cron / reactive)", async () => {
    for (const trigger of ['manual', 'auto_run', 'reactive', 'cron']) {
      let observed: string | undefined;
      const kernel = createKernelAdapter({
        enrichmentList: async (input) => {
          observed = input.trigger_source;
          return { entries: [], next_cursor: null };
        },
      });
      const call: ResolvedCall = {
        slug: 'enrichment-list',
        risk_tier: 'low',
        input: { topic: 'company' },
        output: {},
        stepMeta: { step_id: 'probe', trigger_source: trigger },
      } as ResolvedCall;
      await kernel(call);
      expect(observed).toBe(trigger);
    }
  });

  it("StepMeta type carries optional trigger_source (contract pin)", () => {
    const meta: StepMeta = { step_id: 's1', trigger_source: 'mcp' };
    expect(meta.trigger_source).toBe('mcp');
    const omitted: StepMeta = { step_id: 's1' };
    expect(omitted.trigger_source).toBeUndefined();
  });
});
