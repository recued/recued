/** R2 step 6 - write-saga reconciliation unit tests. */

import type { Commit, ExecutionSource, IngredientManifest } from '@recued/contracts';
import type { Answer } from '@recued/notification';
import {
  createCommitStore,
  createInMemoryCollection,
  type CommitStore,
} from '@recued/storage';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SAGA_ASK_OPTIONS,
  SAGA_HANDLER_KIND,
  buildSagaAsk,
  createSagaAnswerHandler,
  detectTornSaga,
  type SagaAnnotationWriter,
  type SagaCompensationDispatcher,
  type SagaCompensationPlanRef,
  type TornSaga,
  type TornSagaWrite,
} from '../saga-reconciliation.js';
import {
  wrapWithCommitGateway,
  type CommitGatewayDeps,
  type CommitRunIdentity,
} from '../commit-gateway.js';

const DISPATCHED_AT = Date.parse('2026-06-01T10:00:00.000Z');
const ANSWERED_AT = Date.parse('2026-06-01T10:01:00.000Z');

const source = (): ExecutionSource => ({
  channel: 'chat',
  actor: 'user_self',
  chat_session_id: 'chat-1',
  user_id: 'user-1',
});

const op = (operation_id: string, risk_tier: string): Record<string, unknown> => ({
  operation_id,
  description: `${operation_id} fixture`,
  risk_tier,
  groups: [],
  required_scopes: [],
});

const rest = (method: string, path_template: string): Record<string, unknown> => ({
  kind: 'rest',
  method,
  path_template,
});

const hubspotCatalog = (): IngredientManifest => ({
  slug: 'hubspot-catalog',
  name: 'HubSpot catalog fixture',
  description: 'Minimal saga classifier fixture.',
  author: 'recued-core',
  kind: 'connection',
  version: 1,
  category: 'data',
  risk_tier: 'read',
  input: { operation: null, args: null },
  output: { result: 'result' },
  operations: {
    'deal.search': op('recued-core/hubspot.deal.search', 'read'),
    'deal.create': op('recued-core/hubspot.deal.create', 'write'),
    'deal.delete': op('recued-core/hubspot.deal.delete', 'destructive'),
  },
  surfaces: {
    api: {
      executes: {
        'deal.search': rest('POST', '/crm/v3/objects/deals/search'),
        'deal.create': rest('POST', '/crm/v3/objects/deals'),
        'deal.delete': rest('DELETE', '/crm/v3/objects/deals/{{deal_id}}'),
      },
    },
  },
} as unknown as IngredientManifest);

const salesforceCatalog = (): IngredientManifest => ({
  slug: 'salesforce-catalog',
  name: 'Salesforce catalog fixture',
  description: 'Pins the real GET /query search collision.',
  author: 'recued-core',
  kind: 'connection',
  version: 1,
  category: 'data',
  risk_tier: 'read',
  input: { operation: null, args: null },
  output: { result: 'records' },
  operations: {
    'opportunity.search': op('recued-core/salesforce.opportunity.search', 'read'),
    'contact.search': op('recued-core/salesforce.contact.search', 'read'),
    'account.search': op('recued-core/salesforce.account.search', 'read'),
  },
  surfaces: {
    api: {
      executes: {
        'opportunity.search': rest('GET', '/services/data/v60.0/query'),
        'contact.search': rest('GET', '/services/data/v60.0/query'),
        'account.search': rest('GET', '/services/data/v60.0/query'),
      },
    },
  },
} as unknown as IngredientManifest);

const ambiguousWriteCatalog = (): IngredientManifest => ({
  slug: 'ambiguous-catalog',
  name: 'Ambiguous catalog fixture',
  description: 'Two write-tier operations share the same REST binding.',
  author: 'test',
  kind: 'connection',
  version: 1,
  category: 'data',
  risk_tier: 'read',
  input: { operation: null, args: null },
  output: { result: 'result' },
  operations: {
    'deal.create': op('recued-core/ambiguous.deal.create', 'write'),
    'deal.delete': op('recued-core/ambiguous.deal.delete', 'destructive'),
  },
  surfaces: {
    api: {
      executes: {
        'deal.create': rest('POST', '/collision'),
        'deal.delete': rest('POST', '/collision'),
      },
    },
  },
} as unknown as IngredientManifest);

const manifestLookup = (manifests: Record<string, IngredientManifest | undefined>) =>
  (slug: string): IngredientManifest | undefined => manifests[slug];

const commit = (overrides: Partial<Commit> = {}): Commit => ({
  commit_id: 'commit-1',
  kind: 'action',
  ingredient: 'hubspot-catalog',
  tool: 'hubspot-catalog',
  args: {
    connection_kind: 'api',
    method: 'POST',
    path: '/crm/v3/objects/deals',
    connection: 'hubspot1',
  },
  status: 'succeeded',
  source: source(),
  channel_session_id: 'chat:chat-1',
  correlation_id: 'corr-1',
  dispatch_depth: 0,
  idempotency_key: 'idem-1',
  dispatched_at: DISPATCHED_AT,
  request_id: 'run-1',
  ...overrides,
});

describe('detectTornSaga', () => {
  it('detects a landed catalog create that succeeded', () => {
    const saga = detectTornSaga({
      run_id: 'run-1',
      recipe_id: 'recipe-1',
      commits: [
        commit({
          commit_id: 'commit-create',
          output: { result: { id: '31337' } },
        }),
      ],
      getManifest: manifestLookup({ 'hubspot-catalog': hubspotCatalog() }),
    });

    expect(saga).not.toBeNull();
    expect(saga!.landed_writes).toEqual([
      expect.objectContaining({
        commit_id: 'commit-create',
        operation_key: 'deal.create',
        operation_id: 'recued-core/hubspot.deal.create',
        risk_tier: 'write',
        catalog_slug: 'hubspot-catalog',
        connection_name: 'hubspot1',
        output: { result: { id: '31337' } },
        dispatched_at: DISPATCHED_AT,
        unambiguous: true,
      }),
    ]);
    expect(saga!.failed_writes).toEqual([]);
    expect(saga!.uncertain).toEqual([]);
    expect(saga!.other_actions).toEqual([]);
  });

  it('classifies a failed catalog write as failed_writes when another write landed', () => {
    const saga = detectTornSaga({
      run_id: 'run-1',
      recipe_id: 'recipe-1',
      commits: [
        commit({ commit_id: 'commit-create', dispatched_at: DISPATCHED_AT }),
        commit({
          commit_id: 'commit-delete',
          status: 'failed',
          dispatched_at: DISPATCHED_AT + 1,
          args: {
            connection_kind: 'api',
            method: 'DELETE',
            path: '/crm/v3/objects/deals/{{deal_id}}',
            connection: 'hubspot1',
          },
        }),
      ],
      getManifest: manifestLookup({ 'hubspot-catalog': hubspotCatalog() }),
    });

    expect(saga).not.toBeNull();
    expect(saga!.landed_writes.map((w) => w.commit_id)).toEqual(['commit-create']);
    expect(saga!.failed_writes).toEqual([
      expect.objectContaining({
        commit_id: 'commit-delete',
        operation_key: 'deal.delete',
        operation_id: 'recued-core/hubspot.deal.delete',
        risk_tier: 'destructive',
      }),
    ]);
  });

  it('records in_doubt commits as uncertain and never treats them as landed by themselves', () => {
    const withLandedWrite = detectTornSaga({
      run_id: 'run-1',
      recipe_id: 'recipe-1',
      commits: [
        commit({ commit_id: 'commit-create', dispatched_at: DISPATCHED_AT }),
        commit({
          commit_id: 'commit-uncertain',
          status: 'in_doubt',
          dispatched_at: DISPATCHED_AT + 1,
        }),
      ],
      getManifest: manifestLookup({ 'hubspot-catalog': hubspotCatalog() }),
    });

    expect(withLandedWrite).not.toBeNull();
    expect(withLandedWrite!.landed_writes.map((w) => w.commit_id)).toEqual([
      'commit-create',
    ]);
    expect(withLandedWrite!.uncertain).toEqual([
      { commit_id: 'commit-uncertain', ingredient: 'hubspot-catalog' },
    ]);

    const uncertainOnly = detectTornSaga({
      run_id: 'run-2',
      recipe_id: 'recipe-1',
      commits: [commit({ commit_id: 'commit-uncertain-only', status: 'in_doubt' })],
      getManifest: manifestLookup({ 'hubspot-catalog': hubspotCatalog() }),
    });

    expect(uncertainOnly).toBeNull();
  });

  it('ignores read operations including the real Salesforce GET /query collision', () => {
    const saga = detectTornSaga({
      run_id: 'run-1',
      recipe_id: 'recipe-1',
      commits: [
        commit({ commit_id: 'commit-create', dispatched_at: DISPATCHED_AT }),
        commit({
          commit_id: 'commit-soql-search',
          kind: 'query',
          ingredient: 'salesforce-catalog',
          dispatched_at: DISPATCHED_AT + 1,
          args: {
            connection_kind: 'api',
            method: 'GET',
            path: '/services/data/v60.0/query',
            connection: 'sf1',
          },
        }),
      ],
      getManifest: manifestLookup({
        'hubspot-catalog': hubspotCatalog(),
        'salesforce-catalog': salesforceCatalog(),
      }),
    });

    expect(saga).not.toBeNull();
    expect(saga!.landed_writes.map((w) => w.commit_id)).toEqual(['commit-create']);
    expect(saga!.failed_writes).toEqual([]);
    expect(saga!.other_actions).toEqual([]);
  });

  it('classifies an ambiguous write collision at the highest risk and marks it non-compensable', () => {
    const saga = detectTornSaga({
      run_id: 'run-1',
      recipe_id: 'recipe-1',
      commits: [
        commit({
          commit_id: 'commit-ambiguous',
          ingredient: 'ambiguous-catalog',
          args: {
            connection_kind: 'api',
            method: 'POST',
            path: '/collision',
            connection: 'ambiguous1',
          },
        }),
      ],
      getManifest: manifestLookup({ 'ambiguous-catalog': ambiguousWriteCatalog() }),
    });

    expect(saga).not.toBeNull();
    expect(saga!.landed_writes).toEqual([
      expect.objectContaining({
        commit_id: 'commit-ambiguous',
        operation_key: 'deal.delete',
        operation_id: 'recued-core/ambiguous.deal.delete',
        risk_tier: 'destructive',
        unambiguous: false,
      }),
    ]);
  });

  it('keeps unmatched non-GET api calls as unclassified writes and drops unmatched GET calls', () => {
    const saga = detectTornSaga({
      run_id: 'run-1',
      recipe_id: 'recipe-1',
      commits: [
        commit({
          commit_id: 'commit-drifted-write',
          args: {
            connection_kind: 'api',
            method: 'PATCH',
            path: '/drifted/write',
            connection: 'hubspot1',
          },
        }),
        commit({
          commit_id: 'commit-drifted-read',
          kind: 'query',
          dispatched_at: DISPATCHED_AT + 1,
          args: {
            connection_kind: 'api',
            method: 'GET',
            path: '/drifted/read',
            connection: 'hubspot1',
          },
        }),
      ],
      getManifest: manifestLookup({ 'hubspot-catalog': hubspotCatalog() }),
    });

    expect(saga).not.toBeNull();
    expect(saga!.landed_writes).toEqual([
      expect.objectContaining({
        commit_id: 'commit-drifted-write',
        operation_key: '',
        operation_id: 'PATCH /drifted/write',
        risk_tier: 'write',
        unambiguous: false,
      }),
    ]);
    expect(saga!.landed_writes.map((w) => w.commit_id)).not.toContain(
      'commit-drifted-read',
    );
  });

  it('mentions landed non-catalog action commits as other_actions', () => {
    const saga = detectTornSaga({
      run_id: 'run-1',
      recipe_id: 'recipe-1',
      commits: [
        commit({ commit_id: 'commit-create' }),
        commit({
          commit_id: 'commit-mail',
          ingredient: 'mail.send',
          tool: 'mail.send',
          args: { to: 'ada@example.com' },
          dispatched_at: DISPATCHED_AT + 1,
        }),
      ],
      getManifest: manifestLookup({ 'hubspot-catalog': hubspotCatalog() }),
    });

    expect(saga).not.toBeNull();
    expect(saga!.other_actions).toEqual([
      { commit_id: 'commit-mail', ingredient: 'mail.send' },
    ]);
  });

  it('ignores a catalog-slug commit whose args are not the api wire shape (no method/path/connection)', () => {
    // A catalog ingredient can be invoked off the wire path (simple args,
    // a non-api connection_kind) — those commits carry no (method × path)
    // to classify and must neither land as writes nor trigger a saga.
    const saga = detectTornSaga({
      run_id: 'run-1',
      recipe_id: 'recipe-1',
      commits: [
        commit({ commit_id: 'commit-bare-args', args: {} }),
        commit({
          commit_id: 'commit-non-api',
          args: { connection_kind: 'mcp', method: 'POST', path: '/crm/v3/objects/deals' },
        }),
      ],
      getManifest: manifestLookup({ 'hubspot-catalog': hubspotCatalog() }),
    });

    expect(saga).toBeNull();
  });

  it('returns null when no catalog write landed', () => {
    const saga = detectTornSaga({
      run_id: 'run-1',
      recipe_id: 'recipe-1',
      commits: [
        commit({
          commit_id: 'commit-failed-create',
          status: 'failed',
        }),
      ],
      getManifest: manifestLookup({ 'hubspot-catalog': hubspotCatalog() }),
    });

    expect(saga).toBeNull();
  });

  it('orders derived writes oldest-first regardless of input order', () => {
    const saga = detectTornSaga({
      run_id: 'run-1',
      recipe_id: 'recipe-1',
      commits: [
        commit({ commit_id: 'commit-newer', dispatched_at: DISPATCHED_AT + 10 }),
        commit({ commit_id: 'commit-older', dispatched_at: DISPATCHED_AT - 10 }),
      ],
      getManifest: manifestLookup({ 'hubspot-catalog': hubspotCatalog() }),
    });

    expect(saga).not.toBeNull();
    expect(saga!.landed_writes.map((w) => w.commit_id)).toEqual([
      'commit-older',
      'commit-newer',
    ]);
  });
});

const tornWrite = (overrides: Partial<TornSagaWrite> = {}): TornSagaWrite => ({
  commit_id: 'commit-create',
  operation_key: 'deal.create',
  operation_id: 'recued-core/hubspot.deal.create',
  risk_tier: 'write',
  catalog_slug: 'hubspot-catalog',
  connection_name: 'hubspot1',
  output: { result: { id: '31337' } },
  dispatched_at: DISPATCHED_AT,
  unambiguous: true,
  ...overrides,
});

const saga = (overrides: Partial<TornSaga> = {}): TornSaga => ({
  run_id: 'run-1',
  recipe_id: 'recipe-1',
  landed_writes: [tornWrite()],
  failed_writes: [],
  uncertain: [],
  other_actions: [],
  ...overrides,
});

const plan = (
  predecessor_commit_id = 'commit-create',
  overrides: Partial<SagaCompensationPlanRef> = {},
): SagaCompensationPlanRef => ({
  recipe: { recipe_id: `saga-undo-${predecessor_commit_id}` },
  config: { target_connection: 'hubspot1' },
  predecessor_commit_id,
  description: `delete deal 31337 on 'hubspot1'`,
  ...overrides,
});

describe('buildSagaAsk', () => {
  it('offers undo when at least one plan exists, keeps keep, and carries the durable payload', () => {
    const p = plan('commit-create');
    const ask = buildSagaAsk(
      saga({
        landed_writes: [
          tornWrite({ commit_id: 'commit-create', dispatched_at: DISPATCHED_AT }),
          tornWrite({
            commit_id: 'commit-unclassified',
            operation_key: '',
            operation_id: 'PATCH /drifted/write',
            dispatched_at: DISPATCHED_AT + 1,
            unambiguous: false,
          }),
        ],
      }),
      new Map([['commit-create', p]]),
    );

    expect(ask.options).toEqual([SAGA_ASK_OPTIONS.undo, SAGA_ASK_OPTIONS.keep]);
    expect(ask.message.text).toContain(
      "recued-core/hubspot.deal.create on 'hubspot1'",
    );
    expect(ask.message.text).toContain('re-run the recipe');
    expect(ask.handler.kind).toBe(SAGA_HANDLER_KIND);
    expect(ask.handler.payload).toEqual({
      run_id: 'run-1',
      recipe_id: 'recipe-1',
      landed_commit_ids: ['commit-create', 'commit-unclassified'],
      event_at: DISPATCHED_AT,
      plans: [p],
    });
    expect((ask.handler.payload as { plans: unknown[] }).plans[0]).toBe(p);
  });

  it('offers only keep and says actions cannot be undone when no plan exists', () => {
    const ask = buildSagaAsk(saga(), new Map());

    expect(ask.options).toEqual([SAGA_ASK_OPTIONS.keep]);
    expect(ask.message.text).toContain('cannot be undone automatically');
    expect(ask.message.text).toContain('re-run the recipe');
    expect(ask.handler.payload).toEqual({
      run_id: 'run-1',
      recipe_id: 'recipe-1',
      landed_commit_ids: ['commit-create'],
      event_at: DISPATCHED_AT,
      plans: [],
    });
  });
});

const answer = (option: string): Answer => ({
  option,
  answered_at: ANSWERED_AT,
});

const payload = (
  plans: unknown[] = [plan('commit-create')],
): Record<string, unknown> => ({
  run_id: 'run-1',
  recipe_id: 'recipe-1',
  landed_commit_ids: ['commit-create'],
  event_at: DISPATCHED_AT,
  plans,
});

const writer = () => ({
  writeReconciliation: vi.fn(async () => undefined),
});

const dispatcher = () => ({
  dispatchCompensation: vi.fn(async () => undefined),
});

describe('createSagaAnswerHandler', () => {
  it('throws on malformed payload before writing or dispatching', async () => {
    const w = writer();
    const d = dispatcher();

    await expect(
      createSagaAnswerHandler(w, d)(
        { run_id: 'run-1', recipe_id: 'recipe-1' },
        answer(SAGA_ASK_OPTIONS.keep.id),
      ),
    ).rejects.toThrow(/malformed payload/);

    expect(w.writeReconciliation).not.toHaveBeenCalled();
    expect(d.dispatchCompensation).not.toHaveBeenCalled();
  });

  it('records keep and never calls the dispatcher', async () => {
    const w = writer();
    const d = dispatcher();

    await createSagaAnswerHandler(w, d)(
      payload(),
      answer(SAGA_ASK_OPTIONS.keep.id),
    );

    expect(w.writeReconciliation).toHaveBeenCalledTimes(1);
    expect(w.writeReconciliation).toHaveBeenCalledWith({
      run_id: 'run-1',
      recipe_id: 'recipe-1',
      landed_commit_ids: ['commit-create'],
      answer: 'keep',
      answered_at: ANSWERED_AT,
      event_at: DISPATCHED_AT,
    });
    expect(d.dispatchCompensation).not.toHaveBeenCalled();
  });

  it('records undo then dispatches each persisted plan in order', async () => {
    const order: string[] = [];
    const p1 = plan('commit-1');
    const p2 = plan('commit-2');
    const w: SagaAnnotationWriter = {
      writeReconciliation: vi.fn(async () => {
        order.push('write');
      }),
    };
    const d: SagaCompensationDispatcher = {
      dispatchCompensation: vi.fn(async (p) => {
        order.push(`dispatch:${p.predecessor_commit_id}`);
      }),
    };

    await createSagaAnswerHandler(w, d)(
      payload([p1, p2]),
      answer(SAGA_ASK_OPTIONS.undo.id),
    );

    expect(order).toEqual(['write', 'dispatch:commit-1', 'dispatch:commit-2']);
    expect(d.dispatchCompensation).toHaveBeenCalledTimes(2);
    expect(d.dispatchCompensation).toHaveBeenNthCalledWith(1, p1);
    expect(d.dispatchCompensation).toHaveBeenNthCalledWith(2, p2);
  });

  it('attempts later plans after a dispatcher failure and rethrows naming the predecessor', async () => {
    const p1 = plan('commit-failed');
    const p2 = plan('commit-later');
    const w = writer();
    const d: SagaCompensationDispatcher = {
      dispatchCompensation: vi.fn(async (p) => {
        if (p.predecessor_commit_id === 'commit-failed') {
          throw new Error('dispatch exploded');
        }
      }),
    };

    await expect(
      createSagaAnswerHandler(w, d)(
        payload([p1, p2]),
        answer(SAGA_ASK_OPTIONS.undo.id),
      ),
    ).rejects.toThrow(/commit-failed: dispatch exploded/);

    expect(d.dispatchCompensation).toHaveBeenCalledTimes(2);
    expect(d.dispatchCompensation).toHaveBeenNthCalledWith(1, p1);
    expect(d.dispatchCompensation).toHaveBeenNthCalledWith(2, p2);
  });

  it('counts malformed plan entries as failures while still attempting valid plans', async () => {
    const p = plan('commit-valid');
    const w = writer();
    const d = dispatcher();

    await expect(
      createSagaAnswerHandler(w, d)(
        payload([
          {
            recipe: { recipe_id: 'saga-undo-bad' },
            config: {},
            predecessor_commit_id: 42,
          },
          p,
        ]),
        answer(SAGA_ASK_OPTIONS.undo.id),
      ),
    ).rejects.toThrow(/malformed plan entry/);

    expect(w.writeReconciliation).toHaveBeenCalledTimes(1);
    expect(d.dispatchCompensation).toHaveBeenCalledTimes(1);
    expect(d.dispatchCompensation).toHaveBeenCalledWith(p);
  });
});

const sequence = <T>(values: readonly T[]): (() => T) => {
  let index = 0;
  return () => {
    if (index >= values.length) {
      throw new Error(`test sequence exhausted at index ${index}`);
    }
    const value = values[index];
    index += 1;
    return value;
  };
};

const gatewayIdentity = (
  overrides: Partial<CommitRunIdentity> = {},
): CommitRunIdentity => ({
  request_id: 'request-1',
  source: source(),
  channel_session_id: 'chat:chat-1',
  correlation_id: 'corr-1',
  dispatch_depth: 0,
  ...overrides,
});

let commitStore: CommitStore;

beforeEach(() => {
  commitStore = createCommitStore(createInMemoryCollection<Commit>());
});

const gatewayDeps = (
  overrides: Partial<CommitGatewayDeps> = {},
): CommitGatewayDeps => ({
  commitStore,
  identity: gatewayIdentity(),
  getIngredientCategory: () => 'data',
  genCommitId: sequence(['commit-1']),
  genIdempotencyKey: sequence(['idem-1']),
  now: sequence([DISPATCHED_AT, DISPATCHED_AT + 25]),
  ...overrides,
});

describe('wrapWithCommitGateway predecessor stamping', () => {
  it('stamps predecessor_commit_id on compensation commits and omits it by default', async () => {
    const output = { ok: true };
    const withPredecessor = wrapWithCommitGateway(async () => output, gatewayDeps({
      identity: gatewayIdentity({ predecessor_commit_id: 'commit-original' }),
      genCommitId: sequence(['commit-compensation']),
      genIdempotencyKey: sequence(['idem-compensation']),
      now: sequence([DISPATCHED_AT, DISPATCHED_AT + 25]),
    }));
    const withoutPredecessor = wrapWithCommitGateway(async () => output, gatewayDeps({
      identity: gatewayIdentity(),
      genCommitId: sequence(['commit-normal']),
      genIdempotencyKey: sequence(['idem-normal']),
      now: sequence([DISPATCHED_AT + 100, DISPATCHED_AT + 125]),
    }));

    await expect(withPredecessor('hubspot-catalog', {
      connection_kind: 'api',
      method: 'DELETE',
      path: '/crm/v3/objects/deals/{{deal_id}}',
      connection: 'hubspot1',
    })).resolves.toBe(output);
    await expect(withoutPredecessor('hubspot-catalog', {
      connection_kind: 'api',
      method: 'POST',
      path: '/crm/v3/objects/deals',
      connection: 'hubspot1',
    })).resolves.toBe(output);

    expect(await commitStore.get('commit-compensation')).toMatchObject({
      commit_id: 'commit-compensation',
      predecessor_commit_id: 'commit-original',
      status: 'succeeded',
    });
    expect(await commitStore.get('commit-normal')).toMatchObject({
      commit_id: 'commit-normal',
      status: 'succeeded',
    });
    expect(await commitStore.get('commit-normal')).not.toHaveProperty(
      'predecessor_commit_id',
    );
  });
});
