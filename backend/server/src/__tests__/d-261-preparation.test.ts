import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { IngredientManifest, RecipeDefinition } from '@recued/contracts';
import { executeRecipe, type ExecutionContext } from '@recued/engine';
import { describePreapprovalInvocation } from '../preapproval-dispatch-description.js';
import { prepareFutureExecution, type PreapprovalPreparationDeps, type PreapprovalResolvedCall } from '../preapproval-prepare.js';
import { preapprovalHash, selectPreapprovalMembers } from '../preapproval-invocations.js';
import { decisionInput, fixtureRecipe, ownerResponder, preparedPlan, repositoryFixture } from './d-261-fixtures.js';

const mail: IngredientManifest = {
  slug: 'mail-send', name: 'Send email', description: '', author: 'recued',
  kind: 'storage', category: 'action', risk_tier: 'write', input: {}, output: {},
};
const catalog: IngredientManifest = {
  slug: 'test-catalog', name: 'Catalog', description: '', author: 'test',
  kind: 'connection', category: 'data', risk_tier: 'read', input: { operation: null, args: null }, output: {},
  operations: { 'item.write': { operation_id: 'test/catalog.item.write', risk_tier: 'write', approval: 'never', groups: [] } },
  surfaces: { api: { transport: 'rest', default_base_url: 'https://example.com', auth: { kind: 'none' }, executes: {
    'item.write': { kind: 'rest', method: 'POST', path_template: '/items/{{id}}', static_body: { reviewed: 'approved' } },
  } } },
};
const attachment = (recordId: string): PreapprovalResolvedCall => ({
  material: {
    op_id: 'core.storage.data-file-read', ingredient_slug: 'data-file-read', family: 'kernel', identity_version: 1,
    definition_hash: preapprovalHash('file definition'), binding_hash: preapprovalHash('file dispatcher'),
    input: { record_id: recordId }, output: {}, connection_id: null, account_id: null,
    resources: [], risk: 'read', pre_lift_approval: 'ask',
  },
  review: { label: 'Read attachment', detail: recordId, ineligible_reason: null },
  children: [], child_inventory: { complete: true }, nested_recipe: null, dependencies: [],
});
const harness = (definition: RecipeDefinition, extra: Partial<PreapprovalPreparationDeps> = {}) => {
  const fixture = preparedPlan();
  const descriptions: Parameters<PreapprovalPreparationDeps['describe']>[0][] = [];
  const manifests = new Map([mail, catalog, { ...mail, slug: 'invoke' }].map(m => [m.slug, m]));
  const deps: PreapprovalPreparationDeps = {
    loadRecipe: (id, publisher) => id === definition.recipe_id && publisher === 'core'
      ? { definition, publisher_id: publisher, dependencies: [] } : null,
    dispatch: { profiles: { get: () => null }, manifests: { get: slug => manifests.get(slug) ?? null } },
    manifest: slug => manifests.get(slug) ?? null,
    describe: call => {
      descriptions.push(call);
      const refs = call.input.file_refs;
      return describePreapprovalInvocation(call, {
        family: call.catalog ? 'http' : 'kernel', binding: { incarnation: 'account-v1', account: 'account-1' },
        connection_id: call.connection_name || null, account_id: 'account-1', resources: [],
        children: Array.isArray(refs) ? refs.map((ref, index) => ({ slot: 'attachment', index, call: attachment(String(ref)) })) : [],
        child_inventory: { complete: true }, nested_recipe: null, dependencies: [], label: call.manifest.name, detail: 'Fixed test account',
      }, { verdict: call.catalog ? 'admit' : 'ask', risk: 'write', approval: call.catalog ? 'never' : 'ask', reason: null });
    }, ...extra,
  };
  const build = () => prepareFutureExecution({ request: fixture.request, origin: fixture.origin, target: fixture.target }, deps);
  return { build, fixture, deps, descriptions, manifests };
};
const definition = (overrides: Partial<RecipeDefinition>): RecipeDefinition => ({ ...fixtureRecipe, ...overrides });

describe('D-261 preparation using dispatch resolution and durable selection', () => {
  it('lowers kernel ops and places HTTP, mail and required file reads in one owner decision', async () => {
    const h = harness(definition({ steps: [
      { id: 'catalog', ingredient: catalog.slug, connection: 'account-1', input: { operation: 'item.write', args: { id: '42' } } },
      { id: 'send', op: 'core.mail.send', args: { to: ['alex@example.com'], body: 'Reviewed', file_refs: ['file:frozen'] } },
    ] }));
    const plan = h.build();
    expect(plan.members.map(m => m.op_id)).toEqual(['test/catalog.item.write', 'core.mail.send', 'core.storage.data-file-read']);
    expect(plan.members[1]!.required_child_ids).toEqual([plan.members[2]!.member_id]);
    expect(plan.recipe_snapshots[0]!.definition.steps[1]).toMatchObject({ ingredient: 'mail-send' });
    const db = new Database(':memory:');
    try {
      const { repository } = repositoryFixture(db);
      const proposal = await repository.prepare(plan, true);
      expect(proposal.coverage).toBe('complete');
      await repository.decide(await decisionInput(repository, proposal.proposal_id), ownerResponder);
      expect(db.prepare('SELECT COUNT(*) AS n FROM preapproval_decisions').get()).toEqual({ n: 1 });
      expect(db.prepare('SELECT COUNT(*) AS n FROM preapproval_grants').get()).toEqual({ n: 1 });
      expect(db.prepare('SELECT COUNT(*) AS n FROM preapproval_members').get()).toEqual({ n: 3 });
    } finally { db.close(); }
  });

  it('uses the actual config layers, item shape and conditions without evaluating a transform', () => {
    const r = definition({ variables: { subject: 'Default', targets: [] }, steps: [
      { id: 'generated', transform: 'does-not-exist' },
      { id: 'each', ingredient: 'mail-send', foreach: '{{config.targets}}', skip_when: '{{item.send}} equal false',
        input: { to: '{{item.to}}', subject: '{{config.subject}}' } },
      { id: 'dynamic', ingredient: 'mail-send', input: { body: '{{step.generated}}' } },
    ] });
    const h = harness(r, { loadRecipe: () => ({ definition: r, publisher_id: 'core', dependencies: [],
      install_config: { subject: 'Install' }, bound_dish: { group_overlay: { subject: 'Group' }, config_overlay: { subject: 'Dish' } } }) });
    if (h.fixture.request.subject.kind !== 'recipe') throw new Error('fixture');
    h.fixture.request.subject.config = { subject: 'Request', targets: [{ to: 'same', send: true }, { to: 'skip', send: false }, { to: 'same', send: true }] };
    const plan = h.build();
    // D-319 — group ‹ dish ‹ the values given for this run, as `handleExecute`
    // resolves them; the install (main dish) layer is for dishless runs only.
    expect(plan.members.map(m => m.input)).toEqual([{ to: 'same', subject: 'Request' }, { to: 'same', subject: 'Request' }]);
    expect(plan.members.map(m => m.invocation_path.at(-1))).toEqual([{ kind: 'iteration', index: 0 }, { kind: 'iteration', index: 2 }]);
    expect(plan.members[0]!.effect_hash).toBe(plan.members[1]!.effect_hash);
    // Cause AND remedy, not the literal: a refusal that says only what failed
    // leaves the proposer to retry, and a retry cannot change a deferred value.
    expect(plan.uncovered).toHaveLength(1);
    expect(plan.uncovered[0]!.reason).toContain('arguments depend on a future value');
    expect(plan.uncovered[0]!.reason).toContain('proposal config');
    expect(plan.recipe_snapshots[0]!.effective_config.subject).toBe('Request');
    h.fixture.request.subject.config.subject = 'Edited later';
    expect(plan.recipe_snapshots[0]!.effective_config.subject).toBe('Request');
  });

  it('previews the same locked catalog mapping and static body the live gateway dispatches', async () => {
    const h = harness(definition({ steps: [{ id: 'write', ingredient: catalog.slug, connection: '{{config.connection}}',
      input: { operation: 'item.write', args: { id: '42', method: 'DELETE', path: '/evil', 'body.reviewed': false } } }] }));
    if (h.fixture.request.subject.kind !== 'recipe') throw new Error('fixture');
    h.fixture.request.subject.config = { connection: 'account-1' };
    const plan = h.build();
    const sent: Record<string, unknown>[] = [];
    const snapshot = plan.recipe_snapshots[0]!;
    const ctx: ExecutionContext = {
      recipe: snapshot.definition, stores: { config: snapshot.effective_config, vault: {}, context: {}, meta: {}, step: {} },
      ingredientExecutor: async (_slug, args) => { sent.push(args); return {}; },
      manifestGetter: slug => h.manifests.get(slug) ?? null,
      connectionProfileResolver: () => ({ allowed_operations: ['item.write'] }),
    };
    // This probe exercises the existing gate and wire builder. D-261 claim
    // composition is tested separately; no new approval marker is invented.
    const held = await executeRecipe(ctx);
    expect(sent).toEqual([]);
    expect(held.awaiting_approval).toMatchObject({ gated_step_id: 'write', ingredient_slug: catalog.slug,
      operation_id: 'test/catalog.item.write', connection_name: 'account-1' });
    ctx.resumeFrom = { gated_step_id: 'write', approved_target: { ingredient_slug: catalog.slug,
      operation_id: 'test/catalog.item.write', connection_name: 'account-1' } };
    const execution = await executeRecipe(ctx);
    expect(execution.errors).toEqual([]);
    expect(execution.success).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ method: 'POST', path: '/items/{{id}}', 'body.reviewed': 'approved', connection: 'account-1' });
    expect(plan.members[0]!.family).toBe('http');
    expect(plan.members[0]!.input.id).toBe('42');
  });

  it('keeps an unknown loop subtree uncovered and never fabricates its future inventory', () => {
    const h = harness(definition({ steps: [
      { id: 'fixed', ingredient: 'mail-send', input: { to: 'fixed' } },
      { id: 'future', ingredient: 'mail-send', foreach: '{{step.model.targets}}', input: { to: '{{item}}' } },
    ] }));
    const plan = h.build();
    expect(plan.members).toHaveLength(1);
    expect(plan.uncovered[0]).toMatchObject({ subtree: true });
    expect(plan.uncovered[0]!.reason).toContain('loop inventory depends on a future value');
    expect(plan.uncovered[0]!.reason).toContain('proposal config');
    expect(h.descriptions).toHaveLength(1);
  });

  it('pins output mappings that can change a browser effect', () => {
    const r = definition({ steps: [{ id: 'send', ingredient: 'mail-send', output: { '#target': 'dom.body' } }] });
    const first = harness(r).build();
    const changed = harness(definition({ steps: [{ id: 'send', ingredient: 'mail-send', output: { '#target': 'click' } }] })).build();
    expect(first.members[0]!.arguments_hash).toBe(changed.members[0]!.arguments_hash);
    expect(first.members[0]!.effect_hash).not.toBe(changed.members[0]!.effect_hash);
  });

  it('does not select a parent with incomplete governed child inventory', () => {
    const h = harness(definition({ steps: [{ id: 'send', ingredient: 'mail-send' }] }));
    const describe = h.deps.describe;
    h.deps.describe = call => {
      const result = describe(call);
      if (result.kind === 'resolved') result.call.child_inventory = { complete: false, reason: 'A future attachment has no pinned bytes.' };
      return result;
    };
    const plan = h.build();
    expect(plan.members[0]!.review.eligible).toBe(false);
    expect(() => selectPreapprovalMembers(plan)).toThrow(/No complete operation/);
  });

  it('expands a bound nested recipe and refuses recursive recipe graphs', () => {
    const child = definition({ recipe_id: 'child', steps: [{ id: 'child_send', ingredient: 'mail-send', input: { body: '{{config.body}}' } }] });
    const root = definition({ steps: [{ id: 'invoke', ingredient: 'invoke' }] });
    const h = harness(root);
    h.deps.loadRecipe = id => ({ definition: id === 'child' ? child : root, publisher_id: 'core', dependencies: [] });
    const describe = h.deps.describe;
    let target = 'child';
    h.deps.describe = call => {
      const result = describe(call);
      if (result.kind === 'resolved' && call.slug === 'invoke') {
        result.call.nested_recipe = { recipe_id: target, publisher_id: 'core', config: { body: 'Reviewed nested input' } };
      }
      return result;
    };
    const plan = h.build();
    expect(plan.recipe_snapshots).toHaveLength(2);
    expect(plan.members[1]!.input).toEqual({ body: 'Reviewed nested input' });
    expect(plan.members[0]!.required_child_ids).toEqual([plan.members[1]!.member_id]);
    target = root.recipe_id;
    expect(() => h.build()).toThrow(/cycle/);
  });

  it('excludes repeated qualification checks from a next-auto-run approval', () => {
    const h = harness(definition({ auto_run: { interval_ms: 60_000 }, trigger_steps: [{ id: 'watch', ingredient: 'mail-send' }],
      prefetch_steps: [{ id: 'read', ingredient: 'mail-send' }], steps: [{ id: 'send', ingredient: 'mail-send' }] }));
    h.fixture.request.activation = { kind: 'next_auto_run', recipe_id: fixtureRecipe.recipe_id, dish_id: 'dsh_auto', publisher_id: 'core', expected_revision: 1 };
    h.fixture.target = { ...h.fixture.target, kind: 'next_auto_run', due_at: null };
    const plan = h.build();
    expect(plan.members.map(m => m.invocation_path[1])).toEqual([
      { kind: 'step', phase: 'prefetch', step_id: 'read' }, { kind: 'step', phase: 'sequential', step_id: 'send' },
    ]);
    expect(plan.interaction_notes).toHaveLength(1);
  });

  it('claims independent nested prefetch calls under one exact parent and rejects a duplicate nested run', async () => {
    const child = definition({ recipe_id: 'child', prefetch_steps: [
      { id: 'first', ingredient: 'mail-send' }, { id: 'second', ingredient: 'mail-send' },
    ], steps: [] });
    const root = definition({ steps: [{ id: 'invoke', ingredient: 'invoke' }] });
    const h = harness(root);
    h.deps.loadRecipe = id => ({ definition: id === 'child' ? child : root, publisher_id: 'core', dependencies: [] });
    const describe = h.deps.describe;
    h.deps.describe = call => {
      const result = describe(call);
      if (result.kind === 'resolved' && call.slug === 'invoke') {
        result.call.nested_recipe = { recipe_id: 'child', publisher_id: 'core', config: {} };
      }
      return result;
    };
    const plan = h.build();
    const db = new Database(':memory:');
    try {
      const { repository, state } = repositoryFixture(db);
      const proposal = await repository.prepare(plan, false);
      await repository.decide(await decisionInput(repository, proposal.proposal_id), ownerResponder);
      state.now = 10_000;
      const rootRun = await repository.claimRun({ future_execution_ref: proposal.future_execution_ref,
        run_id: 'root-run', worker_id: 'worker', occurrence_key: 'due:10000', occurrence_sequence: 0 });
      const parent = await repository.claimMember(rootRun, plan.members[0]!);
      const path = plan.recipe_snapshots[1]!.invocation_path;
      const nested = await repository.bindNestedRun(rootRun, 'nested-run', path, parent);
      await expect(repository.bindNestedRun(rootRun, 'another-run', path, parent)).rejects.toMatchObject({ code: 'preapproval_already_claimed' });
      const children = await Promise.all(plan.members.slice(1).map(member => repository.claimMember(nested, member, parent.attempt_id)));
      expect(new Set(children.map(claim => claim.attempt_id)).size).toBe(2);
      expect(children.every(claim => claim.run_id === 'nested-run' && claim.parent_attempt_id === parent.attempt_id)).toBe(true);
      for (const claim of children) await repository.settleMember(claim, { status: 'succeeded', message: 'Read completed', result: {} });
      await repository.validateClaim(parent, true);
    } finally { db.close(); }
  });
});
