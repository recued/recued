/** D-337 slice L — a recipe that may ask the owner partway through is not run while a call of
 *  its turn waits for their approval; one that cannot ask runs as before.
 *
 *  Slice K held back a write or a pack action that would ask, but a recipe asks only when it
 *  reaches its step: live, the model called an add first and then a recipe that removes an event,
 *  and both approvals went out (1 of 4 `--and-add` first turns). `recipeMayAsk` reads the steps
 *  first, each against the decision the run's own gate makes for it. */

import { describe, expect, it } from 'vitest';
import {
  OWNER_OPERATION_SCOPE,
  type ChatDispatchContext,
  type ContractRowLike,
  type ExecutionSource,
  type IngredientManifest,
  type OwnerOverridePolicy,
  type RecipeDefinition,
} from '@recued/contracts';
import type { PackOpResolution } from '@recued/recipes';

import { noteWaitingInTurn, notAskedYetMessage } from '../chat-carries-on.js';
import {
  buildChatTier1Handlers,
  createChatTier2Dispatch,
  type ChatRecipeExecutor,
  type ChatToolHandlerDeps,
} from '../chat-tool-handlers.js';
import { recipeMayAsk, type RecipeAskLookups } from '../recipe-asks-owner.js';
import { vendorNeutralWriteTargets } from '../connection-convention-families.js';
import { beginRoundGather, heldOnceAsked, takeRoundGather, type DeferredHold } from '../chat-gather.js';
import { CHAIN_REQUEST_STATE_KEY } from '../chain-evidence.js';
import { heldForApprovalMessageIn } from '../run-result-agent-projection.js';
import { stampExecuteResponseAuditRun, type ExecuteResponse } from '../types.js';

const OWNER: ExecutionSource = {
  channel: 'chat', actor: 'user_self', chat_session_id: 's', user_id: 'local', turn_id: 't',
} as ExecutionSource;
const CONTRACTED: ExecutionSource = { ...OWNER, contract_id: 'k-self' } as ExecutionSource;
/** The owner running it from the app: the one source whose ceiling (`admin`) relaxes an `ask`.
 *  In the owner's chat each op follows its approval (D-177 §N.15.6–7). */
const APP: ExecutionSource = { channel: 'user', actor: 'user_self', user_id: 'local', client_token_id: 't' } as ExecutionSource;
/** Unattended automation: the `read` ceiling, where the risk floor holds an author's `never`. */
const SCHEDULE: ExecutionSource = { channel: 'schedule', actor: 'system', cron: '0 9 * * *', source_recipe: 'r' } as ExecutionSource;

const recipe = (steps: unknown[], extra: Record<string, unknown> = {}): RecipeDefinition => ({
  recipe_id: 'r', version: 1, ttl: 300,
  metadata: { name: 'R', description: '', author: 'test', supported_platforms: [], tags: [] },
  variables: {}, steps, ...extra,
}) as unknown as RecipeDefinition;

/** A HubSpot-like catalog: a read, a write that asks once (admitted at the owner's ceiling), a
 *  write set to ask every time, and a destructive delete. Each declared under a fully-qualified
 *  id, as a catalog's are: the owner's rulings are keyed by it, not by the call's key. */
const CATALOG = {
  slug: 'crm-catalog',
  risk_tier: 'write',
  operations: {
    'deal.read': { operation_id: 'crm.deal.read', risk_tier: 'read', approval: 'never' },
    'deal.update': { operation_id: 'crm.deal.update', risk_tier: 'write', approval: 'ask' },
    // A write its author set to never ask: the floor raises it to `ask`, and the owner's chat runs
    // it as authored (D-177 §N.15.7).
    'deal.note': { operation_id: 'crm.deal.note', risk_tier: 'write', approval: 'never' },
    'deal.close': { operation_id: 'crm.deal.close', risk_tier: 'write', approval: 'always' },
    'deal.delete': { operation_id: 'crm.deal.delete', risk_tier: 'destructive' },
  },
} as unknown as IngredientManifest;
const lookups: RecipeAskLookups = {
  getManifest: (slug) => (slug === 'crm-catalog' ? CATALOG : undefined),
  packOps: () => new Map([['acme.crm-pack', {
    catalog_slug: 'crm-catalog', operations: new Set(Object.keys(CATALOG.operations ?? {})),
  }]]) as unknown as PackOpResolution,
};
const op = (id: string) => ({ id: 's', op: id, args: {} });

describe('D-337 slice L — whether a recipe may ask the owner, read off its steps', () => {
  it('a removal asks; reads, transforms and guards do not; a write asks in the chat and not from the app', () => {
    expect(recipeMayAsk(recipe([op('core.data.calendar.delete')]), OWNER, lookups)).toBe(true);
    const reads = [
      op('core.data.calendar.get'),
      { id: 'x', transform: 'pick', input: '{{step.s}}' },
      { id: 'g', guard: '{{step.x}} is_empty' },
    ];
    expect(recipeMayAsk(recipe(reads), OWNER, lookups)).toBe(false);
    expect(recipeMayAsk(recipe([...reads, op('core.data.calendar.create')]), OWNER, lookups)).toBe(true);
    expect(recipeMayAsk(recipe([...reads, op('core.data.calendar.create')]), APP, lookups)).toBe(false);
  });

  it('a send asks the owner, as the run\'s own review does', () => {
    expect(recipeMayAsk(recipe([op('core.mail.send')]), OWNER, lookups)).toBe(true);
  });

  it('a vendor-neutral read does not; a vendor-neutral write may (its vendor\'s setting is known at run time)', () => {
    expect(recipeMayAsk(recipe([op('core.crm.deal.search')]), OWNER, lookups)).toBe(false);
    expect(recipeMayAsk(recipe([op('core.crm.deal.update')]), OWNER, lookups)).toBe(true);
  });

  it('a pack operation follows its catalog\'s setting: in the chat an ask asks, and an author\'s never runs', () => {
    expect(recipeMayAsk(recipe([op('acme.crm-pack.deal.read')]), OWNER, lookups)).toBe(false);
    expect(recipeMayAsk(recipe([op('acme.crm-pack.deal.update')]), OWNER, lookups)).toBe(true);
    expect(recipeMayAsk(recipe([op('acme.crm-pack.deal.update')]), APP, lookups)).toBe(false);
    expect(recipeMayAsk(recipe([op('acme.crm-pack.deal.note')]), OWNER, lookups)).toBe(false);
    // The floor still holds an author's never where the owner is not present.
    expect(recipeMayAsk(recipe([op('acme.crm-pack.deal.note')]), SCHEDULE, lookups)).toBe(true);
    expect(recipeMayAsk(recipe([op('acme.crm-pack.deal.close')]), OWNER, lookups)).toBe(true);
    expect(recipeMayAsk(recipe([op('acme.crm-pack.deal.delete')]), OWNER, lookups)).toBe(true);
    expect(recipeMayAsk(recipe([op('acme.crm-pack.deal.close')]), APP, lookups)).toBe(true);
  });

  it('a step it cannot read counts as asking', () => {
    // No installed pack serves it; the catalog does not declare it; a templated op; no op at all.
    expect(recipeMayAsk(recipe([op('other.pack.thing.do')]), OWNER, lookups)).toBe(true);
    expect(recipeMayAsk(recipe([op('acme.crm-pack.deal.merge')]), OWNER, lookups)).toBe(true);
    expect(recipeMayAsk(recipe([op('{{config.op}}')]), OWNER, lookups)).toBe(true);
    expect(recipeMayAsk(recipe([{ id: 'q' }]), OWNER, lookups)).toBe(true);
  });

  it('an ingredient step reads as its op: kernel-backed, a catalog operation, or its own tier', () => {
    expect(recipeMayAsk(recipe([{ id: 's', ingredient: 'calendar-delete', input: {} }]), OWNER, lookups)).toBe(true);
    expect(recipeMayAsk(recipe([{ id: 's', ingredient: 'calendar-get', input: {} }]), OWNER, lookups)).toBe(false);
    expect(recipeMayAsk(recipe([{ id: 's', ingredient: 'crm-catalog', input: { operation: 'deal.read' } }]), OWNER, lookups))
      .toBe(false);
    expect(recipeMayAsk(recipe([{ id: 's', ingredient: 'crm-catalog', input: { operation: '{{config.op}}' } }]), OWNER, lookups))
      .toBe(true);
    expect(recipeMayAsk(recipe([{ id: 's', ingredient: 'unknown-thing', input: {} }]), OWNER, lookups)).toBe(true);
  });

  it('reads every list: a removal among the prefetch steps asks', () => {
    expect(recipeMayAsk(recipe([op('core.data.calendar.get')], {
      prefetch_steps: [{ id: 'p', op: 'core.data.calendar.delete', args: {} }],
    }), OWNER, lookups)).toBe(true);
  });

  it('slice O: a vendor-neutral write is read on each of the owner\'s CRMs, and asks when one of them would', () => {
    type Targets = RecipeAskLookups['neutralWriteTargets'];
    const on = (targets: Targets, extra: Partial<RecipeAskLookups> = {}): RecipeAskLookups => ({
      ...lookups, neutralWriteTargets: targets, ...extra,
    });
    // One CRM, whose catalog asks for an update: it asks in the chat, and from the app it does not.
    const crm: Targets = (alias, verb) => [{ catalog_slug: 'crm-catalog', operation: `${alias}.${verb}` }];
    expect(recipeMayAsk(recipe([op('core.crm.deal.update')]), OWNER, on(crm))).toBe(true);
    expect(recipeMayAsk(recipe([op('core.crm.deal.update')]), APP, on(crm))).toBe(false);
    // Its delete is destructive, and its close is set to ask every time.
    expect(recipeMayAsk(recipe([op('core.crm.deal.delete')]), OWNER, on(crm))).toBe(true);
    expect(recipeMayAsk(recipe([op('core.crm.deal.close')]), OWNER, on(crm))).toBe(true);
    // The owner's own ruling on that operation, keyed as the run keys it.
    expect(recipeMayAsk(recipe([op('core.crm.deal.update')]), APP, on(crm, {
      ownerRuling: (ingredient, operation) => (ingredient === 'crm-catalog' && operation === 'crm.deal.update'
        ? { approval: 'always' } : undefined),
    }))).toBe(true);
    // A second CRM that asks every time for its update: the write may land there.
    const PICKY = { slug: 'picky-catalog', operations: {
      'deal.update': { operation_id: 'picky.deal.update', risk_tier: 'write', approval: 'always' },
    } } as unknown as IngredientManifest;
    const both: Targets = (alias, verb) => [
      { catalog_slug: 'crm-catalog', operation: `${alias}.${verb}` },
      { catalog_slug: 'picky-catalog', operation: `${alias}.${verb}` },
    ];
    expect(recipeMayAsk(recipe([op('core.crm.deal.update')]), APP, on(both, {
      getManifest: (slug) => (slug === 'picky-catalog' ? PICKY : lookups.getManifest(slug)),
    }))).toBe(true);
    // An operation its catalog does not declare, no CRM at all, or not known: it may ask.
    expect(recipeMayAsk(recipe([op('core.crm.deal.merge')]), OWNER, on(crm))).toBe(true);
    expect(recipeMayAsk(recipe([op('core.crm.deal.update')]), OWNER, on(() => []))).toBe(true);
    expect(recipeMayAsk(recipe([op('core.crm.deal.update')]), OWNER, on(() => undefined))).toBe(true);
    // A read never asks.
    expect(recipeMayAsk(recipe([op('core.crm.deal.search')]), OWNER, on(crm))).toBe(false);
  });

  it('the owner\'s own ruling for an action is read as the run reads it, and replaces the catalog\'s', () => {
    const ruled = (rulings: Record<string, OwnerOverridePolicy>): RecipeAskLookups => ({
      ...lookups, ownerRuling: (ingredient, operation) => rulings[`${ingredient}/${operation}`],
    });
    // A write the owner's runs from the app make without asking, which the owner set to ask every
    // time. (In the chat it asks either way, by its approval.)
    const create = recipe([op('core.data.calendar.create')]);
    expect(recipeMayAsk(create, APP, lookups)).toBe(false);
    expect(recipeMayAsk(create, APP, ruled({ 'calendar-create/calendar-create': { approval: 'always' } }))).toBe(true);
    // Keyed by the action: a ruling for another one is not this one's.
    expect(recipeMayAsk(create, APP, ruled({ 'calendar-update/calendar-update': { approval: 'always' } }))).toBe(false);
    // A catalog operation: the owner's word over the catalog's, either way, keyed by the catalog
    // and the operation's declared id (the run's gateway reads it so), never the call's key.
    expect(recipeMayAsk(recipe([op('acme.crm-pack.deal.update')]), APP,
      ruled({ 'crm-catalog/crm.deal.update': { approval: 'always' } }))).toBe(true);
    expect(recipeMayAsk(recipe([op('acme.crm-pack.deal.update')]), APP,
      ruled({ 'crm-catalog/deal.update': { approval: 'always' } }))).toBe(false);
    expect(recipeMayAsk(recipe([op('acme.crm-pack.deal.close')]), APP,
      ruled({ 'crm-catalog/crm.deal.close': { approval: 'never' } }))).toBe(false);
    // An owner's own never on a write is not an author's: in the chat the floor still holds it.
    expect(recipeMayAsk(recipe([op('acme.crm-pack.deal.close')]), OWNER,
      ruled({ 'crm-catalog/crm.deal.close': { approval: 'never' } }))).toBe(true);
    // A delete stays one, whatever approval is set on it.
    expect(recipeMayAsk(recipe([op('acme.crm-pack.deal.delete')]), OWNER,
      ruled({ 'crm-catalog/crm.deal.delete': { approval: 'never' } }))).toBe(true);
    // The owner's risk replaces the catalog's, as the run's resolver takes it: raised to a delete,
    // a write asks; lowered, a delete does not.
    expect(recipeMayAsk(recipe([op('acme.crm-pack.deal.update')]), APP,
      ruled({ 'crm-catalog/crm.deal.update': { risk: 'destructive' } }))).toBe(true);
    expect(recipeMayAsk(recipe([op('acme.crm-pack.deal.delete')]), APP,
      ruled({ 'crm-catalog/crm.deal.delete': { risk: 'write' } }))).toBe(false);
    // The ingredient form: the same ruling, by the same key.
    expect(recipeMayAsk(recipe([{ id: 's', ingredient: 'crm-catalog', input: { operation: 'deal.update' } }]), OWNER,
      ruled({ 'crm-catalog/crm.deal.update': { approval: 'always' } }))).toBe(true);
  });
});

const response = { recipe_id: 'r', recipe_hash: 'h', success: true, output: { sidebar: [] }, steps: [], errors: [], duration_ms: 1 } as unknown as ExecuteResponse;

/** `rows`: the contract store's owner rulings (`owner_operation`), as the server scans them. */
const harness = (stored: RecipeDefinition, rows: readonly ContractRowLike[] = [],
  targets?: ChatToolHandlerDeps['neutralWriteTargets'], runs?: ChatRecipeExecutor) => {
  const ran: unknown[] = [];
  const execute: ChatRecipeExecutor = (req, internal) => { ran.push(req); return runs?.(req, internal) ?? Promise.resolve(response); };
  const deps = {
    getContactStore: () => undefined,
    getCollectionRegistry: () => undefined,
    getAuditLog: () => undefined,
    getEnrichmentStore: () => undefined,
    getRecipeStore: () => ({
      ids: () => ['r'], get: (id: string) => (id === 'r' ? stored : null), getStored: () => null, listStored: () => [],
    }) as never,
    getExecutorConfig: () => ({ manifests: { get: (slug: string) => (slug === 'crm-catalog' ? CATALOG : null) } }) as never,
    getExecuteRecipe: () => execute,
    getContractScan: () => (scope: string, prefix: readonly string[]) => (scope === OWNER_OPERATION_SCOPE
      ? rows.filter((row) => prefix.every((segment, i) => row.segments[i] === segment)) : []),
    ...(targets !== undefined ? { neutralWriteTargets: targets } : {}),
  } as unknown as ChatToolHandlerDeps;
  const ctx = (source: ExecutionSource, waiting: boolean): ChatDispatchContext => {
    const turn_state = new Map<string, unknown>();
    if (waiting) noteWaitingInTurn(turn_state, 'calendar.create');
    return { channel: 'internal_function_call', session_id: 's', turn_id: 't', execution_source: source, turn_state };
  };
  return {
    ran,
    deps,
    run: (source: ExecutionSource, waiting: boolean) =>
      buildChatTier1Handlers(deps)['recipe.run']!({ recipe_id: 'r' }, ctx(source, waiting)),
    tier2: (source: ExecutionSource, waiting: boolean) =>
      createChatTier2Dispatch(deps)('kitchen/r', {}, ctx(source, waiting)),
  };
};

describe('D-337 slice L — the chat\'s recipe runs', () => {
  const REMOVE = recipe([op('core.data.calendar.delete')]);
  const READ = recipe([op('core.data.calendar.get')]);
  const NOT_ASKED = { ok: false, reason: 'not_asked_yet', detail: notAskedYetMessage('calendar.create') };

  it('a recipe that would ask is not run while a call of the turn waits, by recipe.run or its own tool', async () => {
    const h = harness(REMOVE);
    expect(await h.run(OWNER, true)).toEqual(NOT_ASKED);
    expect(await h.tier2(OWNER, true)).toEqual(NOT_ASKED);
    expect(h.ran).toEqual([]);
  });

  it('one that cannot ask runs, and so does one that would when nothing waits', async () => {
    const reads = harness(READ);
    expect((await reads.run(OWNER, true)).ok).toBe(true);
    expect((await reads.tier2(OWNER, true)).ok).toBe(true);
    expect(reads.ran).toHaveLength(2);
    const removes = harness(REMOVE);
    expect((await removes.run(OWNER, false)).ok).toBe(true);
    expect((await removes.tier2(OWNER, false)).ok).toBe(true);
    expect(removes.ran).toHaveLength(2);
  });

  it('under a contract, where the conversation does not carry on, it runs as before', async () => {
    const h = harness(REMOVE);
    expect((await h.run(CONTRACTED, true)).ok).toBe(true);
    expect(h.ran).toHaveLength(1);
  });

  it('a write holds the recipe back in the chat, by its approval (an author\'s never: slice O below)', async () => {
    const CREATE = recipe([op('core.data.calendar.create')]);
    const asks = harness(CREATE);
    expect(await asks.run(OWNER, true)).toEqual(NOT_ASKED);
    expect(asks.ran).toEqual([]);
  });

  it('D-402 F3: one the caller\'s standing "Always" covers runs, as it asks nothing; a step that always asks still holds it', async () => {
    const CREATE = recipe([op('core.data.calendar.create')]);
    const covered = harness(CREATE);
    (covered.deps as { standingPreapproval?: unknown }).standingPreapproval = () => true;
    expect((await covered.run(OWNER, true)).ok).toBe(true);
    expect(covered.ran).toHaveLength(1);
    const removes = harness(REMOVE);
    (removes.deps as { standingPreapproval?: unknown }).standingPreapproval = () => true;
    expect(await removes.run(OWNER, true)).toEqual(NOT_ASKED);
    expect(removes.ran).toEqual([]);
  });
});

describe('D-337 slice O — a vendor-neutral CRM write, read on the owner\'s own CRMs', () => {
  const NOT_ASKED = { ok: false, reason: 'not_asked_yet', detail: notAskedYetMessage('calendar.create') };
  const onTheCatalog: ChatToolHandlerDeps['neutralWriteTargets'] = (alias, verb) =>
    [{ catalog_slug: 'crm-catalog', operation: `${alias}.${verb}` }];

  it('a recipe runs where the owner\'s CRM makes its write without asking, and waits where it asks', async () => {
    // An author's never runs in the chat (D-177 §N.15.7); an `ask` waits.
    const note = harness(recipe([op('core.crm.deal.note')]), [], onTheCatalog);
    expect((await note.run(OWNER, true)).ok).toBe(true);
    expect(note.ran).toHaveLength(1);
    const update = harness(recipe([op('core.crm.deal.update')]), [], onTheCatalog);
    expect(await update.run(OWNER, true)).toEqual(NOT_ASKED);
    expect(update.ran).toEqual([]);
    const close = harness(recipe([op('core.crm.deal.close')]), [], onTheCatalog);
    expect(await close.run(OWNER, true)).toEqual(NOT_ASKED);
    expect(close.ran).toEqual([]);
    // With the owner's CRMs not known, it waits, as before.
    const unknown = harness(recipe([op('core.crm.deal.update')]));
    expect(await unknown.run(OWNER, true)).toEqual(NOT_ASKED);
  });

  it('the operations: one per catalog the owner\'s connections serve, by each vendor\'s own entity', () => {
    const connections = (...names: string[]) => ({ list: () => names.map((name) => ({ name })) }) as never;
    const profiled = (by: Record<string, Record<string, unknown>>) =>
      ({ get: (name: string) => (by[name] !== undefined ? { allowed_operations: [], ...by[name] } : null) }) as never;
    const deps = {
      connectionStore: connections('hs', 'sf', 'pd', 'hs-again', 'unprofiled'),
      profiles: profiled({
        hs: { catalog_slug: 'hubspot-catalog' },
        sf: { catalog_slug: 'salesforce-catalog' },
        pd: { catalog_slug: 'pipedrive-catalog' },
        'hs-again': { catalog_slug: 'hubspot-catalog' },
      }),
      localManifestStore: undefined,
    };
    expect(vendorNeutralWriteTargets(deps, 'deal', 'update')).toEqual([
      { catalog_slug: 'hubspot-catalog', operation: 'deal.update' },
      { catalog_slug: 'salesforce-catalog', operation: 'opportunity.update' },
      { catalog_slug: 'pipedrive-catalog', operation: 'deal.update' },
    ]);
    expect(vendorNeutralWriteTargets(deps, 'account', 'update')).toEqual([
      { catalog_slug: 'hubspot-catalog', operation: 'company.update' },
      { catalog_slug: 'salesforce-catalog', operation: 'account.update' },
      { catalog_slug: 'pipedrive-catalog', operation: 'organization.update' },
    ]);
    // An alias none of them models.
    expect(vendorNeutralWriteTargets(deps, 'invoice', 'update')).toEqual([]);
    // A connection that serves two catalogs: both.
    expect(vendorNeutralWriteTargets({
      ...deps,
      connectionStore: connections('two'),
      profiles: profiled({ two: { catalog_slug: 'hubspot-catalog', catalogs: {
        'hubspot-catalog': { allowed_operations: [] }, 'salesforce-catalog': { allowed_operations: [] },
      } } }),
    }, 'contact', 'update')).toEqual([
      { catalog_slug: 'hubspot-catalog', operation: 'contact.update' },
      { catalog_slug: 'salesforce-catalog', operation: 'contact.update' },
    ]);
    // No stores: not known.
    expect(vendorNeutralWriteTargets({ connectionStore: undefined, profiles: undefined, localManifestStore: undefined },
      'deal', 'update')).toBeUndefined();
  });
});

describe('D-177 §N.15.9 — a recipe its round repeats is gathered, by recipe.run or its own tool', () => {
  const REMOVE = recipe([op('core.data.calendar.delete')]);
  /** Each run holds, and hands its ask to the round as the execute handler does. */
  const holding = () => {
    let seq = 0;
    const kept: string[] = [];
    const runs: ChatRecipeExecutor = async (_req, internal) => {
      seq += 1;
      const run_id = `run-${String(seq)}`;
      if (internal?.defer_ask?.({ run_id, op_key: 'calendar-delete' } as DeferredHold) === true) kept.push(run_id);
      return stampExecuteResponseAuditRun({ ...response, success: false, awaiting_approval: true } as ExecuteResponse, run_id);
    };
    return { kept, runs };
  };
  const roundCtx = (calls: ReadonlyArray<{ tool: string; args: unknown }>): ChatDispatchContext => {
    const turn_state = new Map<string, unknown>();
    beginRoundGather(turn_state, 0, calls);
    return { channel: 'internal_function_call', session_id: 's', turn_id: 't', execution_source: OWNER, turn_state };
  };
  const GATHERED = { kind: 'approval', gathered: true };

  it('recipe.run twice: both run, each hold kept for the round\'s one approval', async () => {
    const { kept, runs } = holding();
    const h = harness(REMOVE, [], undefined, runs);
    const ctx = roundCtx([{ tool: 'recipe.run', args: { recipe_id: 'r' } }, { tool: 'recipe.run', args: { recipe_id: 'r' } }]);
    for (let i = 0; i < 2; i++) {
      expect(await buildChatTier1Handlers(h.deps)['recipe.run']!({ recipe_id: 'r' }, ctx)).toMatchObject({ ok: true, run_held: GATHERED });
    }
    expect(kept).toEqual(['run-1', 'run-2']);
    expect(takeRoundGather(ctx.turn_state).map((member) => member.call_key)).toEqual(['recipe.run:r', 'recipe.run:r']);
  });

  it('its own tool twice: the same', async () => {
    const { kept, runs } = holding();
    const h = harness(REMOVE, [], undefined, runs);
    const ctx = roundCtx([{ tool: 'kitchen/r', args: {} }, { tool: 'kitchen/r', args: {} }]);
    for (let i = 0; i < 2; i++) {
      expect(await createChatTier2Dispatch(h.deps)('kitchen/r', {}, ctx)).toMatchObject({ ok: true, run_held: GATHERED });
    }
    expect(kept).toEqual(['run-1', 'run-2']);
  });

  it('another kind of call the round repeats waits on the first: not run, not asked', async () => {
    const { kept, runs } = holding();
    const h = harness(REMOVE, [], undefined, runs);
    const ctx = roundCtx([
      { tool: 'recipe.run', args: { recipe_id: 'r' } }, { tool: 'recipe.run', args: { recipe_id: 'r' } },
      { tool: 'kitchen/r', args: {} }, { tool: 'kitchen/r', args: {} },
    ]);
    await buildChatTier1Handlers(h.deps)['recipe.run']!({ recipe_id: 'r' }, ctx);
    expect(await createChatTier2Dispatch(h.deps)('kitchen/r', {}, ctx))
      .toEqual({ ok: false, reason: 'not_asked_yet', detail: notAskedYetMessage('recipe.run') });
    expect(kept).toEqual(['run-1']);
    expect(h.ran).toHaveLength(1);
  });

  it('D-329: once the round\'s ask is out, its result is told where it went, as one asked on its own is', async () => {
    const { runs } = holding();
    const h = harness(REMOVE, [], undefined, runs);
    // The owner's Telegram chat, where the approval comes with buttons.
    const TELEGRAM = { channel: 'messenger', actor: 'user_self', vendor: 'telegram', from: '42' } as unknown as ExecutionSource;
    const ctx = { ...roundCtx([{ tool: 'kitchen/r', args: {} }, { tool: 'kitchen/r', args: {} }]), execution_source: TELEGRAM };
    const held = await createChatTier2Dispatch(h.deps)('kitchen/r', {}, ctx);
    const [kept] = takeRoundGather(ctx.turn_state);
    const told = heldOnceAsked({ ...kept!, ask_id: 'ask-1', approval_channels: ['ui', 'telegram'] }, held);
    expect(told).toMatchObject({ ok: true, run_held: GATHERED, run_id: 'run-1' });
    expect((told as { result: { message: string } }).result.message).toBe(heldForApprovalMessageIn('telegram'));
    // Before, it read as a run whose ask had gone nowhere yet.
    expect((held as { result: { message: string } }).result.message).not.toBe(heldForApprovalMessageIn('telegram'));
  });

  it('a call its round does not repeat is held and asked on its own, as before', async () => {
    const { kept, runs } = holding();
    const h = harness(REMOVE, [], undefined, runs);
    const result = await buildChatTier1Handlers(h.deps)['recipe.run']!({ recipe_id: 'r' },
      roundCtx([{ tool: 'recipe.run', args: { recipe_id: 'r' } }]));
    expect(result).toMatchObject({ ok: true, run_held: { kind: 'approval' } });
    expect((result as { run_held?: { gathered?: true } }).run_held?.gathered).toBeUndefined();
    expect(kept).toEqual([]);
  });
});

describe('D-348 slice 5 — a run the owner\'s chat starts carries the request its turn is part of', () => {
  const REMOVE = recipe([op('core.data.calendar.delete')]);
  const inRequest = (turn_state: Map<string, unknown>): ChatDispatchContext =>
    ({ channel: 'internal_function_call', session_id: 's', turn_id: 't', execution_source: OWNER, turn_state });

  it('by recipe.run and by its own tool; none outside a request', async () => {
    const keys: Array<string | undefined> = [];
    const runs: ChatRecipeExecutor = async (_req, internal) => {
      keys.push(internal?.chain_request_key);
      return { ...response } as ExecuteResponse;
    };
    const h = harness(REMOVE, [], undefined, runs);
    const keyed = () => inRequest(new Map<string, unknown>([[CHAIN_REQUEST_STATE_KEY, { request_id: 't', key_hash: 'k-1' }]]));
    await buildChatTier1Handlers(h.deps)['recipe.run']!({ recipe_id: 'r' }, keyed());
    await createChatTier2Dispatch(h.deps)('kitchen/r', {}, keyed());
    await buildChatTier1Handlers(h.deps)['recipe.run']!({ recipe_id: 'r' }, inRequest(new Map()));
    expect(keys).toEqual(['k-1', 'k-1', undefined]);
  });
});
