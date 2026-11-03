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
import type { ExecuteResponse } from '../types.js';

const OWNER: ExecutionSource = {
  channel: 'chat', actor: 'user_self', chat_session_id: 's', user_id: 'local', turn_id: 't',
} as ExecutionSource;
const CONTRACTED: ExecutionSource = { ...OWNER, contract_id: 'k-self' } as ExecutionSource;

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
  it('a removal asks; reads, transforms, guards and a write the owner\'s runs make do not', () => {
    expect(recipeMayAsk(recipe([op('core.data.calendar.delete')]), OWNER, lookups)).toBe(true);
    expect(recipeMayAsk(recipe([
      op('core.data.calendar.get'),
      { id: 'x', transform: 'pick', input: '{{step.s}}' },
      { id: 'g', guard: '{{step.x}} is_empty' },
      op('core.data.calendar.create'),
    ]), OWNER, lookups)).toBe(false);
  });

  it('a send asks the owner, as the run\'s own review does', () => {
    expect(recipeMayAsk(recipe([op('core.mail.send')]), OWNER, lookups)).toBe(true);
  });

  it('a vendor-neutral read does not; a vendor-neutral write may (its vendor\'s setting is known at run time)', () => {
    expect(recipeMayAsk(recipe([op('core.crm.deal.search')]), OWNER, lookups)).toBe(false);
    expect(recipeMayAsk(recipe([op('core.crm.deal.update')]), OWNER, lookups)).toBe(true);
  });

  it('a pack operation asks when its catalog makes it destructive or ask every time', () => {
    expect(recipeMayAsk(recipe([op('acme.crm-pack.deal.read')]), OWNER, lookups)).toBe(false);
    expect(recipeMayAsk(recipe([op('acme.crm-pack.deal.update')]), OWNER, lookups)).toBe(false);
    expect(recipeMayAsk(recipe([op('acme.crm-pack.deal.close')]), OWNER, lookups)).toBe(true);
    expect(recipeMayAsk(recipe([op('acme.crm-pack.deal.delete')]), OWNER, lookups)).toBe(true);
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
    // One CRM, whose catalog asks once for an update (admitted at the owner's ceiling).
    const crm: Targets = (alias, verb) => [{ catalog_slug: 'crm-catalog', operation: `${alias}.${verb}` }];
    expect(recipeMayAsk(recipe([op('core.crm.deal.update')]), OWNER, on(crm))).toBe(false);
    // Its delete is destructive, and its close is set to ask every time.
    expect(recipeMayAsk(recipe([op('core.crm.deal.delete')]), OWNER, on(crm))).toBe(true);
    expect(recipeMayAsk(recipe([op('core.crm.deal.close')]), OWNER, on(crm))).toBe(true);
    // The owner's own ruling on that operation, keyed as the run keys it.
    expect(recipeMayAsk(recipe([op('core.crm.deal.update')]), OWNER, on(crm, {
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
    expect(recipeMayAsk(recipe([op('core.crm.deal.update')]), OWNER, on(both, {
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
    // A write the owner's runs make without asking, which the owner set to ask every time.
    const create = recipe([op('core.data.calendar.create')]);
    expect(recipeMayAsk(create, OWNER, lookups)).toBe(false);
    expect(recipeMayAsk(create, OWNER, ruled({ 'calendar-create/calendar-create': { approval: 'always' } }))).toBe(true);
    // Keyed by the action: a ruling for another one is not this one's.
    expect(recipeMayAsk(create, OWNER, ruled({ 'calendar-update/calendar-update': { approval: 'always' } }))).toBe(false);
    // A catalog operation: the owner's word over the catalog's, either way, keyed by the catalog
    // and the operation's declared id (the run's gateway reads it so), never the call's key.
    expect(recipeMayAsk(recipe([op('acme.crm-pack.deal.update')]), OWNER,
      ruled({ 'crm-catalog/crm.deal.update': { approval: 'always' } }))).toBe(true);
    expect(recipeMayAsk(recipe([op('acme.crm-pack.deal.update')]), OWNER,
      ruled({ 'crm-catalog/deal.update': { approval: 'always' } }))).toBe(false);
    expect(recipeMayAsk(recipe([op('acme.crm-pack.deal.close')]), OWNER,
      ruled({ 'crm-catalog/crm.deal.close': { approval: 'never' } }))).toBe(false);
    // A delete stays one, whatever approval is set on it.
    expect(recipeMayAsk(recipe([op('acme.crm-pack.deal.delete')]), OWNER,
      ruled({ 'crm-catalog/crm.deal.delete': { approval: 'never' } }))).toBe(true);
    // The owner's risk replaces the catalog's, as the run's resolver takes it: raised to a delete,
    // a write asks; lowered, a delete does not.
    expect(recipeMayAsk(recipe([op('acme.crm-pack.deal.update')]), OWNER,
      ruled({ 'crm-catalog/crm.deal.update': { risk: 'destructive' } }))).toBe(true);
    expect(recipeMayAsk(recipe([op('acme.crm-pack.deal.delete')]), OWNER,
      ruled({ 'crm-catalog/crm.deal.delete': { risk: 'write' } }))).toBe(false);
    // The ingredient form: the same ruling, by the same key.
    expect(recipeMayAsk(recipe([{ id: 's', ingredient: 'crm-catalog', input: { operation: 'deal.update' } }]), OWNER,
      ruled({ 'crm-catalog/crm.deal.update': { approval: 'always' } }))).toBe(true);
  });
});

const response = { recipe_id: 'r', recipe_hash: 'h', success: true, output: { sidebar: [] }, steps: [], errors: [], duration_ms: 1 } as unknown as ExecuteResponse;

/** `rows`: the contract store's owner rulings (`owner_operation`), as the server scans them. */
const harness = (stored: RecipeDefinition, rows: readonly ContractRowLike[] = [],
  targets?: ChatToolHandlerDeps['neutralWriteTargets']) => {
  const ran: unknown[] = [];
  const execute: ChatRecipeExecutor = (req) => { ran.push(req); return Promise.resolve(response); };
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

  it('a step the owner set to ask every time holds the recipe back, read from their saved rulings', async () => {
    const CREATE = recipe([op('core.data.calendar.create')]);
    const free = harness(CREATE);
    expect((await free.run(OWNER, true)).ok).toBe(true);
    const ruled = harness(CREATE, [{ segments: ['calendar-create', 'calendar-create'], value: { approval: 'always' } }]);
    expect(await ruled.run(OWNER, true)).toEqual(NOT_ASKED);
    expect(ruled.ran).toEqual([]);
  });
});

describe('D-337 slice O — a vendor-neutral CRM write, read on the owner\'s own CRMs', () => {
  const NOT_ASKED = { ok: false, reason: 'not_asked_yet', detail: notAskedYetMessage('calendar.create') };
  const onTheCatalog: ChatToolHandlerDeps['neutralWriteTargets'] = (alias, verb) =>
    [{ catalog_slug: 'crm-catalog', operation: `${alias}.${verb}` }];

  it('a recipe runs where the owner\'s CRM makes its write without asking, and waits where it asks', async () => {
    const update = harness(recipe([op('core.crm.deal.update')]), [], onTheCatalog);
    expect((await update.run(OWNER, true)).ok).toBe(true);
    expect(update.ran).toHaveLength(1);
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
