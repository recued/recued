/** The exemption, driven through the REAL `handleExecute` and a REAL audit store.
 *
 *  The predicate's own logic is unit-tested exhaustively from the `false` side in
 *  `packages/contracts/src/__tests__/audit-exemption.test.ts`. THIS file proves
 *  the other half: that the wiring hands it the real fields, so a change to the
 *  source, the trigger, or the run's outcome actually reaches the decision.
 *
 *  ⛔ Before this change, every case below wrote a row — measured 2026-08-20, on a
 *  recipe with ZERO operations. Only the first one stops.
 */
import { describe, expect, it } from 'vitest';

import type { ExecutionSource } from '@recued/contracts';
import { createAuditLogStore, createInMemoryCollection, type AuditEntry } from '@recued/storage';

import { createManifestRegistry } from '../manifest-loader.js';
import { createRecipeStore } from '../recipe-store.js';
import { handleExecute, type ExecuteHandlerDeps } from '../execute-handler.js';

/** A pure render: no ops, one transform, one table. The leanest thing the pack
 *  app can put on screen — and the shape that used to cost an anchor per screen. */
const renderRecipe = (id: string) => ({
  recipe_id: id, version: 1, ttl: 0, chat_exposed: true,
  metadata: { name: id, description: `Use “${id}” in Recued.`, author: 'probe',
    supported_platforms: [], tags: [], budget_ms: 5000 },
  variables: {}, requires: [], depends_on: [], prefetch_steps: [],
  steps: [
    { id: 'rows', transform: 'default', value: [{ id: 'a' }], fallback: [] },
    { id: 'table', transform: 'to_table', array: '{{step.rows}}',
      columns: [{ field: 'id', label: 'id' }] },
  ],
  output: { render: [{ type: 'table', source: 'step.table' }] },
});

const ownerSource = {
  channel: 'user', actor: 'user_self',
  user_id: 'local', client_token_id: 'client-1',
} as ExecutionSource;

/** The minimum a contract-bearing dispatch must carry to reach the engine. */
const snapshot = (contract_id: string) => ({
  contract_id, contract_version: 'v1', allowed_tools: ['*'], resolved_at: 0,
}) as never;

const runOnce = async (over: Record<string, unknown> = {}): Promise<number> => {
  const log = createAuditLogStore(
    createInMemoryCollection<AuditEntry>(), createInMemoryCollection());
  const recipeStore = createRecipeStore('/nonexistent');
  recipeStore.register(renderRecipe('browse-view') as never);
  const deps = {
    recipeStore, executorConfig: { manifests: createManifestRegistry('/nonexistent') },
    baseVault: {}, instanceId: 'drive', auditLog: log,
  } as unknown as ExecuteHandlerDeps;
  await handleExecute(deps, {
    recipe_id: 'browse-view',
    trigger_source: 'manual',
    config: {},
    execution_source: ownerSource,
    ...over,
  } as never);
  return (await log.listRecent(50)).length;
};

describe('a webclient manual render earns no audit anchor', () => {
  it('⛔ THE CHANGE: the owner browsing their own pack writes NOTHING', async () => {
    expect(await runOnce()).toBe(0);
  });

  it('…and it is the WIRING, not a broken harness — every other caller still writes',
    async () => {
    // If the harness simply could not produce a row, the assertion above would be
    // meaningless. Each of these differs from it in exactly one field.
    const cases: Array<[string, Record<string, unknown>]> = [
      // A model chose to make this read. The most important row to keep.
      ['chat', { execution_source: {
        channel: 'chat', actor: 'user_self', chat_session_id: 's1', user_id: 'local',
      } as ExecutionSource }],
      // The owner's own remote commands — still a surface, still logged.
      ['messenger', { execution_source: {
        channel: 'messenger', actor: 'user_self', vendor: 'telegram', from: 'owner',
      } as ExecutionSource }],
      // A delegated door.
      // ⚠ A contract-bearing source MUST carry a snapshot (D-153 P2.C), so these
      // two supply a minimal live one — the harness requirement, not the feature.
      ['mcp', { execution_source: {
        channel: 'mcp', actor: 'contracted_user', contract_id: 'c1',
        agent_id: 'a1', tool_call_id: 't1', mcp_token_id: 'tok1',
      } as ExecutionSource, contract_snapshot: snapshot('c1') }],
      // Unattended. Never the owner at a keyboard.
      ['reactive-trigger', { trigger_source: 'reactive' }],
      ['schedule-trigger', { trigger_source: 'schedule' }],
      // ⛔ Self-restricted: the owner deliberately narrowed their own session.
      // Someone who asked to be watched more closely keeps their log.
      ['self-restricted', { execution_source: {
        ...ownerSource, contract_id: 'self-restricted-contract',
      } as ExecutionSource, contract_snapshot: snapshot('self-restricted-contract') }],
      // No source at all — we cannot tell who ran it, so we record it.
      ['sourceless', { execution_source: undefined }],
    ];
    const rows: Record<string, number> = {};
    for (const [name, over] of cases) rows[name] = await runOnce(over);
    expect(rows).toEqual({
      chat: 1, messenger: 1, mcp: 1,
      'reactive-trigger': 1, 'schedule-trigger': 1,
      'self-restricted': 1, sourceless: 1,
    });
  });
});
