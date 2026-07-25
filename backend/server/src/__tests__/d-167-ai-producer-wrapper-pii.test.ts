/** D-167 — runAIProducer routes cache-miss LLM egress through PII aliasing. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  computeProducerVersionHash,
  type EnrichmentScope,
  type EnrichmentTopic,
  type IngredientManifest,
  type PiiFieldTag,
} from '@recued/contracts';

import { runAIProducer } from '../housekeeping/ai-producer-wrapper.js';
import { createLlmResultCacheStore } from '../housekeeping/llm-result-cache-store.js';
import type { HousekeepingContext } from '../housekeeping/registry.js';
import { ensureHousekeepingSchema } from '../housekeeping/schema.js';
import { createTrustStore } from '../housekeeping/trust-store.js';
import { createEnrichmentStore } from '../storage/enrichment-store.js';

const SOURCE_EVENT_AT = 1_700_000_000_000;
const NOW = 1_700_500_000_000;
const TOPIC: EnrichmentTopic = 'role';
const SCOPE: EnrichmentScope = 'contact';
const AUTHORED_BY = 'system.housekeeping.role';
const SOURCE_RECORD_HASH = 'src_contact_001';
const INGREDIENT_SLUG = 'ai-classify';
const MODEL_ID = 'openai:gpt-4o-mini';

const baseManifest: IngredientManifest = {
  slug: 'ai-classify',
  name: 'AI Classifier',
  description: 'test',
  author: 'recued-core',
  kind: 'ai',
  category: 'ai',
  risk_tier: 'read',
  version: 1,
  tags: [],
  input: {},
  output: {},
};

type AiResponse = {
  category: string;
  confidence: number;
  reasoning: string;
};

const defaultAiResponse: AiResponse = {
  category: 'other',
  confidence: 0.9,
  reasoning: 'no pii',
};

const contactTagSource = (scope: EnrichmentScope): readonly PiiFieldTag[] =>
  scope === 'contact' ? [{ path: 'email', kind: 'email' }] : [];

const buildInput = (
  ctx: HousekeepingContext,
  overrides: Partial<{
    scope: EnrichmentScope;
    target_id: string;
    source_record_hash: string;
    llmInput: Record<string, unknown>;
    sourceRecordData: unknown;
    composeInput: (() => unknown) | undefined;
  }> = {},
) => {
  const scope = overrides.scope ?? SCOPE;
  const target_id = overrides.target_id ?? 'contact_record_001';
  const source_record_hash = overrides.source_record_hash ?? SOURCE_RECORD_HASH;
  return {
    ctx,
    topic: TOPIC,
    scope,
    target_id,
    authored_by: AUTHORED_BY,
    source_record_hash,
    inputFingerprint: {
      kind: 'per_record_source_hash' as const,
      source_record_hash,
    },
    producer_version_hash: computeProducerVersionHash({
      producer_code_hash: 'pc1',
      model_id: MODEL_ID,
      prompt_template_hash: 'pt1',
      adapter_version: '@recued/llm@1.0.0',
      consumed_ingredients_versions: [],
    }),
    ingredient_slug: INGREDIENT_SLUG,
    eventClock: { event_at: SOURCE_EVENT_AT },
    manifest: baseManifest,
    llmInput: overrides.llmInput ?? {
      'llm.data': 'Contact: alice@acme.com',
      'llm.categories': ['request', 'reply'],
      'llm.force_layer': 'free',
    },
    ...(Object.hasOwn(overrides, 'sourceRecordData')
      ? { sourceRecordData: overrides.sourceRecordData }
      : {}),
    validate: (raw: unknown) => raw as AiResponse,
    buildValue: (r: AiResponse) => ({
      title: 'Unknown',
      category: 'other',
      reasoning: r.reasoning,
      computed_at: NOW,
    }),
    token_estimate: 250,
    ...(Object.hasOwn(overrides, 'composeInput')
      ? { compose_input: overrides.composeInput }
      : {}),
  };
};

let dir: string;
let db: Database.Database;

const mkCtx = (overrides?: {
  llmWithMetaImpl?: HousekeepingContext['llmWithMeta'];
  enrichmentPiiTagSource?: HousekeepingContext['enrichmentPiiTagSource'];
  enableCache?: boolean;
}) => {
  ensureHousekeepingSchema(db);
  const enrichmentStore = createEnrichmentStore(db, { now: () => NOW });
  const trustStore = createTrustStore(db);
  const llmResultCache = overrides?.enableCache
    ? createLlmResultCacheStore(db)
    : undefined;
  const llmWithMeta = vi.fn(
    overrides?.llmWithMetaImpl ??
      (async (_m: IngredientManifest, _i: Record<string, unknown>) => ({
        result: defaultAiResponse,
        model_id: MODEL_ID,
      })),
  );
  const ctx: HousekeepingContext = {
    db,
    bus: { emit: vi.fn() } as unknown as HousekeepingContext['bus'],
    enrichmentStore,
    recipeStore: {} as HousekeepingContext['recipeStore'],
    now: () => NOW,
    emitAuditRow: vi.fn(),
    llmWithMeta,
    trustStore,
    ...(Object.hasOwn(overrides ?? {}, 'enrichmentPiiTagSource')
      ? { enrichmentPiiTagSource: overrides?.enrichmentPiiTagSource }
      : {}),
    ...(llmResultCache ? { llmResultCache } : {}),
  };
  return { ctx, enrichmentStore, trustStore, llmWithMeta, llmResultCache };
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-167-wrapper-pii-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('D-167 runAIProducer PII alias seam', () => {
  it('aliases on egress + restores on output', async () => {
    const seenInputs: Record<string, unknown>[] = [];
    const { ctx, enrichmentStore, llmWithMeta } = mkCtx({
      enrichmentPiiTagSource: contactTagSource,
      llmWithMetaImpl: async (_manifest, input) => {
        seenInputs.push(input);
        return {
          result: {
            category: 'request',
            confidence: 0.9,
            reasoning: `re: ${String(input['llm.data'])}`,
          },
          model_id: 'provider:model-from-mock',
        };
      },
    });

    const out = await runAIProducer(
      buildInput(ctx, { sourceRecordData: { email: 'alice@acme.com' } }),
    );

    expect(out.status).toBe('computed');
    expect(llmWithMeta).toHaveBeenCalledOnce();
    const sent = seenInputs[0]!;
    const sentData = String(sent['llm.data']);
    expect(sentData).toContain('m1@d1.invalid');
    expect(sentData).not.toContain('alice@acme.com');
    expect(sent['llm.categories']).toEqual(['request', 'reply']);
    expect(sent['llm.force_layer']).toBe('free');

    const rows = enrichmentStore.list({
      topic: TOPIC,
      scope: SCOPE,
      target_id: 'contact_record_001',
      authored_by: AUTHORED_BY,
      limit: 1,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.value).toEqual({
      title: 'Unknown',
      category: 'other',
      reasoning: 're: Contact: alice@acme.com',
      computed_at: NOW,
    });
    expect(JSON.stringify(rows[0]!.value)).not.toContain('m1@d1.invalid');
    expect(rows[0]!.model_id).toBe('provider:model-from-mock');
  });

  it('byte-identical no-op when sourceRecordData omitted', async () => {
    const seenInputs: Record<string, unknown>[] = [];
    const { ctx, llmWithMeta } = mkCtx({
      enrichmentPiiTagSource: contactTagSource,
      llmWithMetaImpl: async (_manifest, input) => {
        seenInputs.push(input);
        return { result: defaultAiResponse, model_id: MODEL_ID };
      },
    });

    await runAIProducer(buildInput(ctx));

    expect(llmWithMeta).toHaveBeenCalledOnce();
    expect(seenInputs[0]?.['llm.data']).toBe('Contact: alice@acme.com');
    expect(String(seenInputs[0]?.['llm.data'])).not.toContain('m1@d1.invalid');
  });

  it('no-op when no tag source wired', async () => {
    const seenInputs: Record<string, unknown>[] = [];
    const { ctx, llmWithMeta } = mkCtx({
      enrichmentPiiTagSource: undefined,
      llmWithMetaImpl: async (_manifest, input) => {
        seenInputs.push(input);
        return { result: defaultAiResponse, model_id: MODEL_ID };
      },
    });

    await runAIProducer(
      buildInput(ctx, { sourceRecordData: { email: 'alice@acme.com' } }),
    );

    expect(llmWithMeta).toHaveBeenCalledOnce();
    expect(seenInputs[0]?.['llm.data']).toBe('Contact: alice@acme.com');
    expect(String(seenInputs[0]?.['llm.data'])).not.toContain('m1@d1.invalid');
  });

  it('no-op when scope resolves no tags', async () => {
    const seenInputs: Record<string, unknown>[] = [];
    const { ctx, llmWithMeta } = mkCtx({
      enrichmentPiiTagSource: () => [],
      llmWithMetaImpl: async (_manifest, input) => {
        seenInputs.push(input);
        return { result: defaultAiResponse, model_id: MODEL_ID };
      },
    });

    await runAIProducer(
      buildInput(ctx, {
        sourceRecordData: { email: 'alice@acme.com' },
      }),
    );

    expect(llmWithMeta).toHaveBeenCalledOnce();
    expect(seenInputs[0]?.['llm.data']).toBe('Contact: alice@acme.com');
    expect(String(seenInputs[0]?.['llm.data'])).not.toContain('m1@d1.invalid');
  });

  it('cache-hit path makes no model call and never aliases', async () => {
    const seenInputs: Record<string, unknown>[] = [];
    const { ctx, llmWithMeta } = mkCtx({
      enrichmentPiiTagSource: contactTagSource,
      enableCache: true,
      llmWithMetaImpl: async (_manifest, input) => {
        seenInputs.push(input);
        return {
          result: {
            category: 'request',
            confidence: 0.9,
            reasoning: `re: ${String(input['llm.data'])}`,
          },
          model_id: MODEL_ID,
        };
      },
    });
    const composeInput = () => ({ system: 'classify', user: 'Contact: alice@acme.com' });

    const first = await runAIProducer(
      buildInput(ctx, {
        target_id: 'contact_record_001',
        source_record_hash: 'src_contact_001',
        sourceRecordData: { email: 'alice@acme.com' },
        composeInput,
      }),
    );
    expect(first.status).toBe('computed');
    expect(llmWithMeta).toHaveBeenCalledTimes(1);
    expect(String(seenInputs[0]?.['llm.data'])).toContain('m1@d1.invalid');
    expect(String(seenInputs[0]?.['llm.data'])).not.toContain('alice@acme.com');

    const second = await runAIProducer(
      buildInput(ctx, {
        target_id: 'contact_record_002',
        source_record_hash: 'src_contact_002',
        sourceRecordData: { email: 'alice@acme.com' },
        composeInput,
      }),
    );

    expect(second.status).toBe('computed');
    if (second.status === 'computed') {
      expect(second.cached).toBe(true);
      expect(second.tokens_consumed).toBe(0);
    }
    expect(llmWithMeta).toHaveBeenCalledTimes(1);
    expect(seenInputs).toHaveLength(1);
  });
});
