/** A connection action the run's principal was not granted names where it is
 *  turned on, as a switched-off program does (`cli_reachability_disabled`). A pack
 *  installed with Access "Read" refused its first write "'…' is not allowed on
 *  connection 'crm' for this run, so it did not run. (operation_not_granted)" and
 *  said nothing more; the run dialog offered no fix for it either (found
 *  2026-11-08). */
import { describe, expect, it } from 'vitest';

import type {
  ExecutionSource,
  IngredientManifest,
  OperationRiskTier,
  ProviderSurfaces,
} from '@recued/contracts';

import type { ExecutionContext } from '../types.js';
import { runCatalogOperation } from '../catalog-gateway.js';

const SLUG = 'pub/cat';

const manifest = (risk: OperationRiskTier = 'write'): IngredientManifest => ({
  slug: SLUG,
  name: 'Catalog',
  description: '',
  author: 'pub',
  kind: 'connection',
  category: 'action',
  risk_tier: risk,
  input: {},
  output: {},
  operations: {
    'deal.update': { operation_id: 'pub/cat.deal.update', risk_tier: risk, groups: ['g'] },
  },
  surfaces: {
    api: {
      transport: 'rest',
      default_base_url: 'https://api.example.com',
      auth: { kind: 'none' },
      executes: { 'deal.update': { kind: 'rest', method: 'PATCH', path_template: '/deals/1' } },
    },
  } as ProviderSurfaces,
} as unknown as IngredientManifest);

const ctxFor = (source: ExecutionSource | undefined, actor?: string): ExecutionContext => ({
  recipe: { recipe_id: 'r1' } as never,
  stores: {} as never,
  ingredientExecutor: async () => ({ ok: true }),
  // Installed with Access "Read": the connection's profile grants no write.
  connectionProfileResolver: () => ({ catalog_slug: SLUG, allowed_operations: ['deal.read'] }) as never,
  ...(actor !== undefined ? { actor: actor as never } : {}),
  ...(source !== undefined ? { execution_source: source } : {}),
} as ExecutionContext);

const refusal = async (ctx: ExecutionContext): Promise<Error & { code?: unknown }> => {
  const outcome: unknown = await runCatalogOperation(
    ctx, manifest(), SLUG, { operation: 'deal.update', args: {} }, 'crm', undefined, undefined, undefined,
  ).then(() => 'dispatched', (err: unknown) => err);
  expect(outcome).toBeInstanceOf(Error);
  return outcome as Error & { code?: unknown };
};

describe('an ungranted connection action says where it is turned on', () => {
  it('the owner’s own run: on the pack’s Access tab, under Self (you)', async () => {
    const err = await refusal(ctxFor({ channel: 'chat', actor: 'user_self' } as ExecutionSource, 'user_self'));
    expect(err.message).toBe(
      "'pub/cat.deal.update' is not allowed on connection 'crm' for you, so it did not run. "
        + 'To use it, open its pack in Packs and turn it on under Self (you) on the Access tab. (operation_not_granted)',
    );
    expect(err.code).toBe('NOT_AUTHORIZED');
  });

  it('the owner’s schedule reads the owner’s switch too', async () => {
    const err = await refusal(ctxFor({
      channel: 'schedule', actor: 'system', cron: '0 9 * * *', source_recipe: 'r1',
    } as ExecutionSource, 'system'));
    expect(err.message).toContain('turn it on under Self (you) on the Access tab');
  });

  it('any other contract’s run: only that it is not available', async () => {
    const err = await refusal(ctxFor({
      channel: 'mcp', actor: 'contracted_user', agent_id: 'agent-1', contract_id: 'door-crm-writer',
    } as ExecutionSource, 'contracted_user'));
    expect(err.message).toBe("'pub/cat.deal.update' is not available for this contract. (operation_not_granted)");
  });

  it('a run that names no principal keeps the plain sentence', async () => {
    const err = await refusal(ctxFor(undefined, 'system'));
    expect(err.message).toBe(
      "'pub/cat.deal.update' is not allowed on connection 'crm' for this run, so it did not run. (operation_not_granted)",
    );
  });
});

/** With the operation-group gate off (2026-08-07), a connection action reaches
 *  `operation_not_granted` through a rule under "Rules for every contract" that
 *  says "Never allow it": the refusal names that rule, not the Access tab. */
describe('an action a rule never allows names the rule', () => {
  const ruleScan = (actor: string, operationId: string) => (scope: string, prefix: readonly string[]) => {
    const row = { segments: [actor, SLUG, operationId], value: { denied: true } };
    return scope === 'override' && prefix.every((segment, i) => row.segments[i] === segment) ? [row] : [];
  };
  const admitted = (source: ExecutionSource, actor: string, scanActor: string): ExecutionContext => ({
    recipe: { recipe_id: 'r1' } as never,
    stores: {} as never,
    ingredientExecutor: async () => ({ ok: true }),
    // The action is granted: only the rule refuses it.
    connectionProfileResolver: () => ({ catalog_slug: SLUG, allowed_operations: ['deal.update'] }) as never,
    contractScan: ruleScan(scanActor, 'pub/cat.deal.update') as never,
    actor: actor as never,
    execution_source: source,
  } as ExecutionContext);

  it('the owner: remove the rule under Rules for every contract', async () => {
    const err = await refusal(admitted({ channel: 'chat', actor: 'user_self' } as ExecutionSource, 'user_self', 'user_self'));
    expect(err.message).toBe(
      "'pub/cat.deal.update' is not allowed for you, so it did not run: a rule says never to allow it. "
        + 'To use it, remove that rule under Rules for every contract, on the Contracts page. (operation_not_granted)',
    );
  });

  it('an app with a contract: only that it is not available, rule or not', async () => {
    const err = await refusal(admitted({
      channel: 'mcp', actor: 'contracted_user', agent_id: 'agent-1', contract_id: 'door-crm-writer',
    } as ExecutionSource, 'contracted_user', 'contracted_user'));
    expect(err.message).toBe("'pub/cat.deal.update' is not available for this contract. (operation_not_granted)");
  });

  it('without the rule the same call runs', async () => {
    const ctx = admitted({ channel: 'chat', actor: 'user_self' } as ExecutionSource, 'user_self', 'nobody');
    await expect(runCatalogOperation(
      ctx, manifest(), SLUG, { operation: 'deal.update', args: {} }, 'crm', undefined, undefined, undefined,
    )).resolves.toEqual({ ok: true });
  });
});
