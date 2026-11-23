/** D-348 slices 5 and 6 — the rule for a chat request, at the catalog gate.
 *
 *  A catalog op holds at the catalog gate, so the catalog gate asks the host for the rule the owner
 *  accepted for the request the run was made for: in its ask branch, after no session grant and no
 *  trigger pre-approval admitted it, only where a chain may stand in (`chainMayStandIn`): no review
 *  lift, the owner's policy before the lift `never` or `ask`, below destructive (deletes are slice
 *  6's). The host is given the catalog's slug, the op the gate resolved, the connection, the risk and
 *  the arguments the op would be sent with. One that admits dispatches the op; anything else holds.
 *  The commit gateway's seam is the gateway's `d-348-chain-rule-gate.test.ts`.
 *
 *  Slice 6 — a delete is asked about too, with the record its operation names (`record_id_arg`), and
 *  each read tells the host the records it returned (`found`), read where D-254 reads them for a
 *  caller: the host lets a delete through only for a record a read of its run found. */

import { describe, expect, it, vi } from 'vitest';
import { PreflightRequiredSignal } from '@recued/contracts';
import type {
  ApiExecutionBinding,
  ChainRuleHooks,
  ConnectionOperationProfile,
  IngredientManifest,
  OperationRiskTier,
  OperationSpec,
  StepMeta,
  TriggerPreapprovalHooks,
} from '@recued/contracts';

import { runCatalogOperation } from '../catalog-gateway.js';
import type { CatalogSessionGrantHooks, ExecutionContext, IngredientExecutor } from '../types.js';

const SLUG = 'pub/cat';
const SHORT_OP = 'x';
const OPERATION_ID = 'pub/cat.x';
const CONNECTION = 'primary-connection';
const STEP: StepMeta = { step_id: 'save' } as StepMeta;

const operation = (risk_tier: OperationRiskTier, extras: Partial<OperationSpec> = {}): OperationSpec => ({
  operation_id: OPERATION_ID, risk_tier, groups: ['g'], ...extras,
});

const manifestFor = (op: OperationSpec): IngredientManifest => ({
  slug: SLUG, name: 'Catalog', description: '', author: 'pub', kind: 'connection', category: 'action', risk_tier: 'read',
  input: {}, output: {}, operations: { [SHORT_OP]: op },
  surfaces: { api: { transport: 'rest', default_base_url: 'https://api.example.test', auth: { kind: 'none' },
    result_path: 'results',
    executes: { [SHORT_OP]: { kind: 'rest', method: 'POST', path_template: '/x/{{id}}' } as ApiExecutionBinding } } },
});

/** The owner's chat: a write set to ask holds for their approval. */
const harness = (opts: {
  admit?: ChainRuleHooks['admit'] | null;
  catalogSessionGrants?: CatalogSessionGrantHooks;
  triggerPreapprovals?: TriggerPreapprovalHooks;
  /** What the provider answers, in the executor's envelope. */
  answer?: unknown;
} = {}) => {
  const ingredientExecutor = vi.fn<IngredientExecutor>(async () => opts.answer ?? ({ ok: true }));
  const admit = vi.fn<ChainRuleHooks['admit']>(opts.admit ?? (() => 'chain_1'));
  const found = vi.fn<NonNullable<ChainRuleHooks['found']>>();
  const ctx: ExecutionContext = {
    recipe: { recipe_id: 'set-amount' } as never,
    stores: {} as never,
    ingredientExecutor,
    execution_source: { channel: 'chat', actor: 'user_self', chat_session_id: 'chat-1', user_id: 'owner-1' },
    connectionProfileResolver: (): ConnectionOperationProfile => ({ allowed_operations: [SHORT_OP] }),
    ...(opts.admit !== null ? { chainRules: { admit, found } } : {}),
    ...(opts.catalogSessionGrants !== undefined ? { catalogSessionGrants: opts.catalogSessionGrants } : {}),
    ...(opts.triggerPreapprovals !== undefined ? { triggerPreapprovals: opts.triggerPreapprovals } : {}),
  };
  return { ctx, admit, found, ingredientExecutor };
};

const run = (ctx: ExecutionContext, manifest: IngredientManifest): Promise<unknown> =>
  runCatalogOperation(ctx, manifest, SLUG, { operation: SHORT_OP, args: { id: '42' }, connection: 'raw-connection' },
    CONNECTION, undefined, undefined, STEP);

const held = async (promise: Promise<unknown>) => {
  await expect(promise).rejects.toBeInstanceOf(PreflightRequiredSignal);
};

describe('D-348 slice 5 — the catalog gate asks the host for the request\'s rule', () => {
  it('one that admits dispatches the held op; the host is given the op and account the gate resolved, and its arguments', async () => {
    const { ctx, admit, ingredientExecutor } = harness();
    await expect(run(ctx, manifestFor(operation('write', { approval: 'ask' })))).resolves.toEqual({ ok: true });
    // The account the call goes out on, not the one its step named.
    expect(admit).toHaveBeenCalledWith({
      slug: SLUG, operation_id: OPERATION_ID, operation_key: SHORT_OP, connection_name: CONNECTION, risk_tier: 'write',
      args: { id: '42' },
    });
    expect(ingredientExecutor).toHaveBeenCalledTimes(1);
  });

  it('none, a host that fails, or no host: the op holds, and nothing is dispatched', async () => {
    for (const { ctx, ingredientExecutor } of [
      harness({ admit: () => null }),
      harness({ admit: () => { throw new Error('store unreadable'); } }),
      harness({ admit: null }),
    ]) {
      await held(run(ctx, manifestFor(operation('write', { approval: 'ask' }))));
      expect(ingredientExecutor).not.toHaveBeenCalled();
    }
  });

  it('⛔ is not asked for an op set to "always ask", or one that needs no asking', async () => {
    for (const [name, manifest, holds] of [
      ['always', manifestFor(operation('write', { approval: 'always' })), true],
      ['a read', manifestFor(operation('read')), false],
    ] as const) {
      const { ctx, admit, ingredientExecutor } = harness();
      if (holds) await held(run(ctx, manifest));
      else await expect(run(ctx, manifest)).resolves.toEqual({ ok: true });
      expect(admit, name).not.toHaveBeenCalled();
      expect(ingredientExecutor, name).toHaveBeenCalledTimes(holds ? 0 : 1);
    }
  });

  it('is not asked when a session grant or a trigger pre-approval admitted: that is spent instead', async () => {
    const consume = vi.fn<CatalogSessionGrantHooks['consume']>(() => true);
    const granted = harness({ catalogSessionGrants: { match: () => 'grant-1', consume, mint: () => undefined } });
    await expect(run(granted.ctx, manifestFor(operation('write', { approval: 'ask' })))).resolves.toEqual({ ok: true });
    expect(granted.admit).not.toHaveBeenCalled();
    expect(consume).toHaveBeenCalledTimes(1);

    const preapproved = harness({ triggerPreapprovals: { admit: () => 'tpa_1' } });
    await expect(run(preapproved.ctx, manifestFor(operation('write', { approval: 'ask' })))).resolves.toEqual({ ok: true });
    expect(preapproved.admit).not.toHaveBeenCalled();
  });
});

describe('D-348 slice 6 — a delete, and what reads found', () => {
  it('a delete is asked about with the record its operation names; the host decides', async () => {
    const named = harness();
    await expect(run(named.ctx, manifestFor(operation('destructive', { record_id_arg: 'id' })))).resolves.toEqual({ ok: true });
    expect(named.admit).toHaveBeenCalledWith(expect.objectContaining({ risk_tier: 'destructive', record_id: '42' }));
    // One that names none is asked about without a record, which no host lets through.
    const unnamed = harness({ admit: (call) => (call.record_id === undefined ? null : 'chain_1') });
    await held(run(unnamed.ctx, manifestFor(operation('destructive'))));
    expect(unnamed.admit).toHaveBeenCalledWith(expect.not.objectContaining({ record_id: expect.anything() }));
    expect(unnamed.ingredientExecutor).not.toHaveBeenCalled();
  });

  it('a read tells the host the records it returned, at its records path, each by its id, with its arguments', async () => {
    // A record's associations and fields are not records the read found: only each record's own id.
    const { ctx, found } = harness({ answer: { result: { results: [
      { id: 'a1', owner_id: 'u9', associations: { contacts: { results: [{ id: 'c1' }] } } }, { id: 7 }, { name: 'no id' },
    ] } } });
    await run(ctx, manifestFor(operation('read')));
    expect(found).toHaveBeenCalledWith({
      slug: SLUG, operation_key: SHORT_OP, connection_name: CONNECTION, args: { id: '42' }, record_ids: ['a1', '7'],
    });
  });

  it('a targeted read\'s record is its body; a write, a held op or a failed read tells nothing', async () => {
    const targeted = harness({ answer: { result: { id: 'r5', properties: {} } } });
    await run(targeted.ctx, manifestFor(operation('read')));
    expect(targeted.found).toHaveBeenCalledWith(expect.objectContaining({ record_ids: ['r5'] }));

    const write = harness({ answer: { result: { results: [{ id: 'w1' }] } } });
    await run(write.ctx, manifestFor(operation('write', { approval: 'ask' })));
    expect(write.found).not.toHaveBeenCalled();

    const heldWrite = harness({ admit: () => null });
    await held(run(heldWrite.ctx, manifestFor(operation('write', { approval: 'ask' }))));
    expect(heldWrite.found).not.toHaveBeenCalled();

    const failed = harness();
    failed.ingredientExecutor.mockRejectedValueOnce(new Error('provider down'));
    await expect(run(failed.ctx, manifestFor(operation('read')))).rejects.toThrow();
    expect(failed.found).not.toHaveBeenCalled();
  });

  it('a host that throws while keeping them fails nothing', async () => {
    const { ctx, found } = harness({ answer: { result: { results: [{ id: 'a1' }] } } });
    found.mockImplementation(() => { throw new Error('full'); });
    await expect(run(ctx, manifestFor(operation('read')))).resolves.toEqual({ result: { results: [{ id: 'a1' }] } });
  });
});

describe('D-348 §7.8 — an op a standing permission lets through keeps a review of its change, so it can be undone', () => {
  // A Records op: a change to a record Recued keeps, the kind it can undo (a vendor's API call is not).
  const owner = { publisher: 'pub', pack_slug: 'notes' };
  const notes = (approval: 'ask' | 'never'): IngredientManifest => ({
    slug: 'notes', name: 'Notes', description: '', author: owner.publisher, kind: 'storage', version: 1, category: 'data',
    risk_tier: 'read', input: { operation: null, args: null }, output: { result: 'result' },
    operations: { 'note.update': { operation_id: 'pub.notes.note.update', risk_tier: 'write', approval, groups: ['note.write'] } },
    operation_groups: { 'note.write': { group_id: 'note.write', operations: ['note.update'], risk_floor: 'write' } },
    surfaces: { records: {
      executes: { 'note.update': { kind: 'core.records', action: 'update', entity: 'note', owner, pack_version: 1,
        storage_schema_hash: 'a'.repeat(64), declaration_hash: 'b'.repeat(64), operation_digest: 'c'.repeat(64) } },
      schema: { decimal_scale: 4, entities: { note: { kind: 'note', fields: [
        { key: 'id', slot: 'pk', kind: 'id', required: true }, { key: 'title', slot: 's1', kind: 'string', required: true }] } } },
    } },
  });
  const review = {
    schema_version: 1, operation: 'pub.notes.note.update', input_hash: 'a'.repeat(64), captured_at: 1,
    resources: [{ kind: 'records', key: 'pub:note:42', label: 'Note 42', binding: 'pub/notes', version: '1',
      before: { title: 'a' }, after: { title: 'b' }, precondition: { kind: 'records_revision', value: 1, incarnation: 'i1' } }],
  };
  /** The host's Records executor, review hooks and local-change hook: what ran under what, and
   *  which rule it named. */
  const withLocal = (ctx: ExecutionContext) => {
    const runs: Array<{ review: unknown; chain_rule_id: unknown }> = [];
    const capture = vi.fn(() => review as never);
    Object.assign(ctx, {
      recordsReachabilityResolver: () => true,
      recordsOperationExecutor: vi.fn(async () => ({ updated: true })),
      resourceReview: { capture, run: <T>(_review: unknown, effect: () => T): T => effect() },
      localMutations: {
        run: async <T>(call: { review: unknown; chain_rule_id?: string }, dispatch: () => T | Promise<T>): Promise<T> => {
          runs.push({ review: call.review, chain_rule_id: call.chain_rule_id });
          return dispatch();
        },
      },
    });
    return { runs, capture };
  };
  const update = (ctx: ExecutionContext, approval: 'ask' | 'never') => runCatalogOperation(ctx, notes(approval), 'notes',
    { operation: 'note.update', args: { id: '42', set: { title: 'b' } } }, '', undefined, undefined, STEP);

  it('let through by the request\'s rule: under a review, naming the rule for its commit', async () => {
    const { ctx } = harness();
    const local = withLocal(ctx);
    await update(ctx, 'ask');
    expect(local.runs).toEqual([{ review, chain_rule_id: 'chain_1' }]);
  });

  it('by a session grant or a trigger\'s pre-approval: under a review too, naming no rule', async () => {
    for (const permission of [
      { catalogSessionGrants: { match: () => 'grant-1', consume: () => true } as unknown as CatalogSessionGrantHooks },
      { triggerPreapprovals: { admit: () => 'tpa_1' } },
    ]) {
      const { ctx } = harness({ admit: () => null, ...permission });
      const local = withLocal(ctx);
      await update(ctx, 'ask');
      expect(local.runs).toEqual([{ review, chain_rule_id: undefined }]);
    }
  });

  it('an op that needs no ask runs as it did, with no review', async () => {
    const { ctx } = harness();
    const local = withLocal(ctx);
    await update(ctx, 'never');
    expect(local.runs).toEqual([]);
    expect(local.capture).not.toHaveBeenCalled();
  });
});
