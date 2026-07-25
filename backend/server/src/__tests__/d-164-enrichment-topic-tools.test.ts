import { beforeEach, describe, expect, it } from 'vitest';
import type {
  ChatDispatchContext,
  ChatDispatchResult,
  EnrichmentTrustState,
  InternalToolRegistry,
  ToolEntry,
  ToolTier,
} from '@recued/contracts';
import {
  ENRICHMENT_TOPIC_TOOL_PREFIX,
  enrichmentTopicToolName,
  topicOfEnrichmentToolName,
  wrapRegistryWithEnrichmentTopicTools,
  type EnrichmentTopicToolDeps,
} from '../chat-enrichment-topic-tools.js';

const REAL_TOPICS = [
  'deal_health_score',
  'engagement_score_per_contact',
  'thread_signals',
] as const;

const makeEntry = (
  name: string,
  tier: ToolTier = 1,
  overrides: Partial<ToolEntry> = {},
): ToolEntry => ({
  name,
  tier,
  description: `${name} description`,
  arg_schema: { type: 'object', properties: {} },
  topic_tags: ['test'],
  classification: 'read',
  concurrency_safe: true,
  ...overrides,
});

type DispatchCall = {
  name: string;
  args: unknown;
  ctx: ChatDispatchContext;
};

const buildInnerRegistry = (
  entries: ToolEntry[],
  dispatchResult: ChatDispatchResult = { ok: true, result: {} },
): {
  registry: InternalToolRegistry;
  dispatchCalls: DispatchCall[];
  refreshCallbacks: Array<() => void>;
  unsubscribe: () => void;
  unsubscribeCalls: () => number;
} => {
  const dispatchCalls: DispatchCall[] = [];
  const refreshCallbacks: Array<() => void> = [];
  let unsubscribeCallCount = 0;

  const list = (): ReadonlyArray<ToolEntry> => entries;
  const unsubscribe = (): void => {
    unsubscribeCallCount += 1;
  };

  const registry: InternalToolRegistry = {
    list,
    listByTier: (tier) => list().filter((entry) => entry.tier === tier),
    getByName: (name) => list().find((entry) => entry.name === name) ?? null,
    dispatch: async (name, args, ctx) => {
      dispatchCalls.push({ name, args, ctx });
      return dispatchResult;
    },
    subscribeRefresh: (callback) => {
      refreshCallbacks.push(callback);
      return unsubscribe;
    },
  };

  return {
    registry,
    dispatchCalls,
    refreshCallbacks,
    unsubscribe,
    unsubscribeCalls: () => unsubscribeCallCount,
  };
};

const buildDeps = (
  topics: ReadonlyArray<string> | null = REAL_TOPICS,
  trust: Partial<Record<string, EnrichmentTrustState>> = {},
): EnrichmentTopicToolDeps => ({
  listTopicsWithRows: () => topics,
  resolveTrustState: (topic) => trust[topic] ?? 'auto',
});

const namesOf = (entries: ReadonlyArray<ToolEntry>): string[] =>
  entries.map((entry) => entry.name);

let ctx: ChatDispatchContext;

beforeEach(() => {
  ctx = { channel: 'internal_function_call', session_id: 's1' };
});

describe('D-164 enrichment topic tool projection', () => {
  it('1. list() - umbrella enrichment.search replaced IN PLACE by per-topic entries', () => {
    const before = makeEntry('contact.search');
    const umbrella = makeEntry('enrichment.search');
    const tier2AfterUmbrella = makeEntry('publisher/follow-up', 2);
    const after = makeEntry('deal.search');
    const { registry } = buildInnerRegistry([
      before,
      umbrella,
      tier2AfterUmbrella,
      after,
    ]);

    const wrapped = wrapRegistryWithEnrichmentTopicTools(registry, buildDeps());

    expect(namesOf(wrapped.list())).toEqual([
      'contact.search',
      'enrichment.deal_health_score',
      'enrichment.engagement_score_per_contact',
      'enrichment.thread_signals',
      'publisher/follow-up',
      'deal.search',
    ]);
  });

  it('2. list() - per-topic entry shape omits topic and scope args', () => {
    const { registry } = buildInnerRegistry([makeEntry('enrichment.search')]);
    const wrapped = wrapRegistryWithEnrichmentTopicTools(
      registry,
      buildDeps(['deal_health_score']),
    );

    const entry = wrapped.getByName('enrichment.deal_health_score');
    expect(entry).not.toBeNull();
    expect(entry?.name).toBe('enrichment.deal_health_score');
    expect(entry?.tier).toBe(1);
    expect(entry?.classification).toBe('read');
    expect(entry?.concurrency_safe).toBe(true);
    expect(entry?.description.startsWith('Pre-computed fact — ')).toBe(true);

    const argSchema = entry?.arg_schema as {
      properties?: Record<string, unknown>;
    };
    expect(argSchema.properties).toHaveProperty('target_id');
    expect(argSchema.properties).toHaveProperty('limit');
    expect(argSchema.properties).not.toHaveProperty('topic');
    expect(argSchema.properties).not.toHaveProperty('scope');
  });

  it('3. list() - membership filters skip non-registry and off topics but keep manual and auto', () => {
    const { registry } = buildInnerRegistry([makeEntry('enrichment.search')]);
    const wrapped = wrapRegistryWithEnrichmentTopicTools(
      registry,
      buildDeps(
        [
          'deal_health_score',
          'not_a_topic',
          'engagement_score_per_contact',
          'thread_signals',
        ],
        {
          deal_health_score: 'manual',
          engagement_score_per_contact: 'off',
          thread_signals: 'auto',
        },
      ),
    );

    expect(namesOf(wrapped.list())).toEqual([
      'enrichment.deal_health_score',
      'enrichment.thread_signals',
    ]);
  });

  it('4. list() - deps failure modes drop umbrella and hide only the failing trust topic', () => {
    const base = [
      makeEntry('contact.search'),
      makeEntry('enrichment.search'),
      makeEntry('publisher/follow-up', 2),
    ];

    const throwingTopics = wrapRegistryWithEnrichmentTopicTools(
      buildInnerRegistry(base).registry,
      {
        listTopicsWithRows: () => {
          throw new Error('store unavailable');
        },
        resolveTrustState: () => 'auto',
      },
    );
    expect(namesOf(throwingTopics.list())).toEqual([
      'contact.search',
      'publisher/follow-up',
    ]);

    const nullTopics = wrapRegistryWithEnrichmentTopicTools(
      buildInnerRegistry(base).registry,
      buildDeps(null),
    );
    expect(namesOf(nullTopics.list())).toEqual([
      'contact.search',
      'publisher/follow-up',
    ]);

    const throwingTrust = wrapRegistryWithEnrichmentTopicTools(
      buildInnerRegistry(base).registry,
      {
        listTopicsWithRows: () => REAL_TOPICS,
        resolveTrustState: (topic) => {
          if (topic === 'deal_health_score') {
            throw new Error('trust unavailable');
          }
          return 'auto';
        },
      },
    );
    expect(namesOf(throwingTrust.list())).toEqual([
      'contact.search',
      'enrichment.engagement_score_per_contact',
      'enrichment.thread_signals',
      'publisher/follow-up',
    ]);
  });

  it('5. list() - no umbrella in inner list appends per-topic entries at the end', () => {
    const { registry } = buildInnerRegistry([
      makeEntry('contact.search'),
      makeEntry('publisher/follow-up', 2),
    ]);
    const wrapped = wrapRegistryWithEnrichmentTopicTools(
      registry,
      buildDeps(['deal_health_score']),
    );

    expect(namesOf(wrapped.list())).toEqual([
      'contact.search',
      'publisher/follow-up',
      'enrichment.deal_health_score',
    ]);
  });

  it('6. Reserved-namespace collision hiding skips valid topic collisions but keeps fake suffixes', () => {
    const validCollision = makeEntry('enrichment.deal_health_score', 3, {
      classification: 'unknown',
      concurrency_safe: false,
    });
    const invalidSuffix = makeEntry('enrichment.not_a_topic', 3, {
      classification: 'unknown',
      concurrency_safe: false,
    });
    const { registry } = buildInnerRegistry([validCollision, invalidSuffix]);
    const wrapped = wrapRegistryWithEnrichmentTopicTools(registry, buildDeps([]));

    expect(namesOf(wrapped.list())).toEqual(['enrichment.not_a_topic']);
    expect(namesOf(wrapped.listByTier(3))).toEqual(['enrichment.not_a_topic']);
    expect(wrapped.list()[0]).toBe(invalidSuffix);
    expect(wrapped.listByTier(3)[0]).toBe(invalidSuffix);
  });

  it('7. listByTier(1) replaces umbrella and listByTier(2) passes through unchanged without collisions', () => {
    const tier2Entries = [
      makeEntry('publisher/follow-up', 2),
      makeEntry('publisher/brief-account', 2),
    ];
    const { registry } = buildInnerRegistry([
      makeEntry('contact.search'),
      makeEntry('enrichment.search'),
      ...tier2Entries,
    ]);
    const wrapped = wrapRegistryWithEnrichmentTopicTools(
      registry,
      buildDeps(['deal_health_score', 'thread_signals']),
    );

    expect(namesOf(wrapped.listByTier(1))).toEqual([
      'contact.search',
      'enrichment.deal_health_score',
      'enrichment.thread_signals',
    ]);
    expect(wrapped.listByTier(2)).toEqual(tier2Entries);
  });

  it('8. getByName returns synthetic entries first, umbrella from inner, null for unknown, and valid non-members', () => {
    const collision = makeEntry('enrichment.deal_health_score', 3, {
      description: 'inner collision',
      classification: 'unknown',
      concurrency_safe: false,
    });
    const umbrella = makeEntry('enrichment.search');
    const { registry } = buildInnerRegistry([collision, umbrella]);
    const wrapped = wrapRegistryWithEnrichmentTopicTools(
      registry,
      buildDeps(['engagement_score_per_contact']),
    );

    const synthetic = wrapped.getByName('enrichment.deal_health_score');
    expect(synthetic).not.toBe(collision);
    expect(synthetic?.name).toBe('enrichment.deal_health_score');
    expect(synthetic?.tier).toBe(1);
    expect(synthetic?.description).toContain('Pre-computed fact');
    expect(wrapped.getByName('enrichment.search')).toBe(umbrella);
    expect(wrapped.getByName('unknown.tool')).toBeNull();

    const nonMember = wrapped.getByName('enrichment.thread_signals');
    expect(nonMember?.name).toBe('enrichment.thread_signals');
    expect(nonMember?.tier).toBe(1);
  });

  it('9. dispatch rewrite pins topic and delegates to enrichment.search with the same ctx reference', async () => {
    const inner = buildInnerRegistry([makeEntry('enrichment.search')]);
    const wrapped = wrapRegistryWithEnrichmentTopicTools(
      inner.registry,
      buildDeps(),
    );

    await wrapped.dispatch(
      'enrichment.deal_health_score',
      { target_id: 'x', limit: 5 },
      ctx,
    );

    expect(inner.dispatchCalls).toHaveLength(1);
    expect(inner.dispatchCalls[0]?.name).toBe('enrichment.search');
    expect(inner.dispatchCalls[0]?.args).toEqual({
      target_id: 'x',
      limit: 5,
      topic: 'deal_health_score',
    });
    expect(inner.dispatchCalls[0]?.ctx).toBe(ctx);
  });

  it('10. dispatch topic pin wins over model-supplied topic args', async () => {
    const inner = buildInnerRegistry([makeEntry('enrichment.search')]);
    const wrapped = wrapRegistryWithEnrichmentTopicTools(
      inner.registry,
      buildDeps(),
    );

    await wrapped.dispatch(
      'enrichment.deal_health_score',
      { target_id: 'x', topic: 'something_else' },
      ctx,
    );

    expect(inner.dispatchCalls[0]?.args).toEqual({
      target_id: 'x',
      topic: 'deal_health_score',
    });
  });

  it('11. dispatch arg passthrough handles absent args and leaves invalid non-object payloads unchanged', async () => {
    const inner = buildInnerRegistry([makeEntry('enrichment.search')]);
    const wrapped = wrapRegistryWithEnrichmentTopicTools(
      inner.registry,
      buildDeps(),
    );
    const rawString = 'bad args';
    const rawArray = ['bad args'];

    await wrapped.dispatch('enrichment.deal_health_score', undefined, ctx);
    await wrapped.dispatch('enrichment.deal_health_score', null, ctx);
    await wrapped.dispatch('enrichment.deal_health_score', rawString, ctx);
    await wrapped.dispatch('enrichment.deal_health_score', rawArray, ctx);

    expect(inner.dispatchCalls[0]?.args).toEqual({ topic: 'deal_health_score' });
    expect(inner.dispatchCalls[1]?.args).toEqual({ topic: 'deal_health_score' });
    expect(inner.dispatchCalls[2]?.args).toBe(rawString);
    expect(inner.dispatchCalls[3]?.args).toBe(rawArray);
  });

  it('12. dispatch non-reserved names delegates unchanged', async () => {
    const inner = buildInnerRegistry([
      makeEntry('enrichment.search'),
      makeEntry('contact.search'),
      makeEntry('enrichment.not_a_topic', 3, {
        classification: 'unknown',
        concurrency_safe: false,
      }),
    ]);
    const wrapped = wrapRegistryWithEnrichmentTopicTools(
      inner.registry,
      buildDeps(),
    );
    const umbrellaArgs = { target_id: 'x' };
    const contactArgs = { query: 'Ada' };
    const fakeSuffixArgs = { target_id: 'y' };

    await wrapped.dispatch('enrichment.search', umbrellaArgs, ctx);
    await wrapped.dispatch('contact.search', contactArgs, ctx);
    await wrapped.dispatch('enrichment.not_a_topic', fakeSuffixArgs, ctx);

    expect(inner.dispatchCalls.map((call) => call.name)).toEqual([
      'enrichment.search',
      'contact.search',
      'enrichment.not_a_topic',
    ]);
    expect(inner.dispatchCalls[0]?.args).toBe(umbrellaArgs);
    expect(inner.dispatchCalls[1]?.args).toBe(contactArgs);
    expect(inner.dispatchCalls[2]?.args).toBe(fakeSuffixArgs);
  });

  it('13. dispatch result passthrough returns inner resolved values as-is including errors', async () => {
    const errorResult: ChatDispatchResult = {
      ok: false,
      reason: 'execution_error',
      detail: 'boom',
    };
    const inner = buildInnerRegistry([makeEntry('enrichment.search')], errorResult);
    const wrapped = wrapRegistryWithEnrichmentTopicTools(
      inner.registry,
      buildDeps(),
    );

    const result = await wrapped.dispatch(
      'enrichment.deal_health_score',
      { target_id: 'x' },
      ctx,
    );

    expect(result).toBe(errorResult);
  });

  it('14. subscribeRefresh delegates to inner and returns the inner unsubscribe function', () => {
    const inner = buildInnerRegistry([makeEntry('enrichment.search')]);
    const wrapped = wrapRegistryWithEnrichmentTopicTools(
      inner.registry,
      buildDeps(),
    );
    const callback = (): void => {};

    const unsubscribe = wrapped.subscribeRefresh(callback);

    expect(inner.refreshCallbacks).toEqual([callback]);
    expect(unsubscribe).toBe(inner.unsubscribe);
    unsubscribe();
    expect(inner.unsubscribeCalls()).toBe(1);
  });

  it('15. helpers round-trip topic tool names and reject umbrella, empty, and unprefixed names', () => {
    expect(ENRICHMENT_TOPIC_TOOL_PREFIX).toBe('enrichment.');
    for (const topic of REAL_TOPICS) {
      const name = enrichmentTopicToolName(topic);
      expect(name).toBe(`enrichment.${topic}`);
      expect(topicOfEnrichmentToolName(name)).toBe(topic);
    }

    expect(topicOfEnrichmentToolName('enrichment.search')).toBeNull();
    expect(topicOfEnrichmentToolName('enrichment.')).toBeNull();
    expect(topicOfEnrichmentToolName('deal_health_score')).toBeNull();
  });

  it('16. Determinism: consecutive list() calls with unchanged deps are byte-stable', () => {
    const { registry } = buildInnerRegistry([
      makeEntry('contact.search'),
      makeEntry('enrichment.search'),
      makeEntry('publisher/follow-up', 2),
    ]);
    const wrapped = wrapRegistryWithEnrichmentTopicTools(registry, buildDeps());

    const first = JSON.stringify(wrapped.list());
    const second = JSON.stringify(wrapped.list());

    expect(second).toBe(first);
  });
});
