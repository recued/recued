/** D-247 slice 7 — the READ side of the coverage ledger.
 *
 *  ⛔ The write shipped in the same change as this read, deliberately. D-247
 *  exists partly because `buildRecipeOpDependencyIndex` was written, tested and
 *  called by nothing; a capture-only ledger would be the same artefact. */

import { describe, expect, it } from 'vitest';
import { readRecipeCoverageUsage } from '../recipe-coverage-usage.js';

const NOW = 1_750_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

const row = (target: string, granting_recipe: string, agoDays: number, detail?: string) => ({
  activity_id: `a${target}${agoDays}${granting_recipe}`,
  timestamp: NOW - agoDays * DAY,
  action: 'recipe_coverage_admission' as const,
  target,
  detail: detail ?? JSON.stringify({ granting_recipe }),
});

const store = (rows: unknown[]) =>
  ({ listActivities: async () => rows as never }) as never;

describe('readRecipeCoverageUsage', () => {
  it('counts per op and names the covering recipes, de-duplicated', async () => {
    const r = await readRecipeCoverageUsage(
      store([
        row('core.mail.send', 'recued-core/chase', 1),
        row('core.mail.send', 'recued-core/chase', 2),
        row('core.mail.send', 'recued-core/reply', 3),
        row('core.file.delete', 'recued-core/tidy', 1),
      ]),
      { window_days: 30, now: () => NOW },
    );
    expect(r.byOperation.get('core.mail.send')).toEqual({
      count: 3,
      recipes: ['recued-core/chase', 'recued-core/reply'],
    });
    expect(r.byOperation.get('core.file.delete')?.count).toBe(1);
  });

  it('excludes rows outside the window but still reports the oldest scanned', async () => {
    // The window is part of the ANSWER: `data.audit` evicts oldest-first, so a
    // caller must be able to say "in the retained window" rather than "never".
    const r = await readRecipeCoverageUsage(
      store([row('core.mail.send', 'recued-core/chase', 90)]),
      { window_days: 30, now: () => NOW },
    );
    expect(r.byOperation.size).toBe(0);
    expect(r.oldest_scanned_at).toBe(NOW - 90 * DAY);
    expect(r.window_days).toBe(30);
  });

  it('an op with no coverage run is ABSENT, never a confident zero', async () => {
    const r = await readRecipeCoverageUsage(store([]), { window_days: 30, now: () => NOW });
    expect(r.byOperation.has('core.mail.send')).toBe(false);
    expect(r.oldest_scanned_at).toBeNull();
  });

  it('ignores every other activity action', async () => {
    const r = await readRecipeCoverageUsage(
      store([
        { activity_id: 'x', timestamp: NOW, action: 'connection_gateway', target: 'core.mail.send' },
        { activity_id: 'y', timestamp: NOW, action: 'chat_tool_call', target: 's:t:core.mail.send' },
      ]),
      { window_days: 30, now: () => NOW },
    );
    expect(r.byOperation.size).toBe(0);
  });

  it('counts a row whose detail is malformed — understating usage reads as "safe to revoke"', async () => {
    const r = await readRecipeCoverageUsage(
      store([row('core.mail.send', '', 1, '{not json')]),
      { window_days: 30, now: () => NOW },
    );
    expect(r.byOperation.get('core.mail.send')).toEqual({ count: 1, recipes: [] });
  });
});

/** ⛔ THE RPC HANDLER, DRIVEN — because a reader with a typed caller and no test
 *  through it is the same shape as a reader with no caller: nothing proves the
 *  wiring, only that it compiles. */
describe('contract.recipeOpUsage — the rpc that makes both halves read', () => {
  const build = async (rows: unknown[], auditLog = true) => {
    const { makeContractHandlers } = await import('../contract-handler.js');
    const slice = makeContractHandlers({
      store: {} as never,
      ...(auditLog ? { auditLog: { listActivities: async () => rows as never } as never } : {}),
    } as never);
    return slice!.handlers['contract.recipeOpUsage'];
  };

  it('projects the aggregate, carrying the window back to the caller', async () => {
    // ⚠ REAL clock: the handler stamps `now: () => Date.now()` and takes no
    // injectable one, so a fixture pinned to the module's NOW constant falls
    // outside every window and the aggregate reads empty — which looks exactly
    // like "the filter works".
    const handler = await build([{
      activity_id: 'live-1',
      timestamp: Date.now() - 60_000,
      action: 'recipe_coverage_admission' as const,
      target: 'core.mail.send',
      detail: JSON.stringify({ granting_recipe: 'recued-core/chase' }),
    }]);
    const out = await handler!({ window_days: 30 } as never, {} as never);
    expect(out).toMatchObject({
      operations: [{
        operation_id: 'core.mail.send', count: 1, recipes: ['recued-core/chase'], could: [],
      }],
      window_days: 30,
    });
  });

  it('defaults the window rather than scanning everything', async () => {
    const handler = await build([]);
    const out = await handler!({} as never, {} as never);
    expect((out as { window_days: number }).window_days).toBe(30);
  });

  it('clamps an absurd window instead of trusting the caller', async () => {
    const handler = await build([]);
    const out = await handler!({ window_days: 100_000 } as never, {} as never);
    expect((out as { window_days: number }).window_days).toBe(365);
  });

  it('with no audit store returns an EMPTY result, never a throw or a silent zero', async () => {
    const handler = await build([], false);
    const out = await handler!({} as never, {} as never);
    expect(out).toEqual({
      operations: [], window_days: 30, oldest_scanned_at: null, underivable: [],
    });
  });
});

/** ⛔⛔ D11's ROW NEEDS BOTH HALVES AND THEY MUST AGREE ABOUT OP IDS.
 *
 *  The static index records an ingredient step's canonical op only via an
 *  `OpResolver`, so a bare kernel step contributed its SLUG and no op id — while
 *  the gate, the coverage predicate and therefore the LEDGER all derive
 *  `core.mail.send` from that same slug. Without the same normalisation on both
 *  sides the row reads "ran 3× via chase" directly above a "still used by" list
 *  that does not mention chase. */
describe('D-247 D11 — the static half speaks the same op-id vocabulary', () => {
  it('indexes a bare kernel ingredient step under its core.* op', async () => {
    const { buildRecipeOpDependencyIndex } = await import('../derive-recipe-capability.js');
    const idx = buildRecipeOpDependencyIndex([{
      id: 'chase',
      recipe: {
        recipe_id: 'chase', version: 1, ttl: 300,
        metadata: { name: 'chase', description: 'd', author: 'recued-core' },
        variables: {}, prefetch_steps: [],
        // No `operation` — the shape an OpResolver cannot map.
        steps: [{ id: 's', ingredient: 'mail-send', input: {} }],
        output: { sidebar: [] },
      } as never,
    }]);
    expect(idx.byOp.get('core.mail.send')).toEqual(['chase']);
  });

  it('a templated dispatch lands in `underivable`, not in an empty "could"', async () => {
    // "We could not derive this" and "nothing uses this op" must stay
    // distinguishable — the second reads as permission to revoke.
    const { buildRecipeOpDependencyIndex } = await import('../derive-recipe-capability.js');
    const idx = buildRecipeOpDependencyIndex([{
      id: 'dyn',
      recipe: {
        recipe_id: 'dyn', version: 1, ttl: 300,
        metadata: { name: 'dyn', description: 'd', author: 'recued-core' },
        variables: {}, prefetch_steps: [],
        steps: [{ id: 's', ingredient: '{{config.slug}}', input: {} }],
        output: { sidebar: [] },
      } as never,
    }]);
    expect(idx.underivable).toEqual(['dyn']);
    expect(idx.byOp.size).toBe(0);
  });
});
