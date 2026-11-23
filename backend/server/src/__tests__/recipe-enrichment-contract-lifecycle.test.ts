import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONTRACT_DEFINITION_SCOPE, D165_CONTRACT_SCHEMA, STDIO_MCP_TOKEN_ID, type ExecutionSource, type RecipeDefinition } from '@recued/contracts';
import { handleExecute, type ExecuteHandlerDeps } from '../execute-handler.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { createRecipeStore } from '../recipe-store.js';
import { createContractOverlayResolver } from '../policy-contract-overlay.js';
import { createContractStore } from '../storage/contract-store.js';
import { createContractDefinitionStore } from '../storage/contract-definition-store.js';
import { createContractGrantEntryStore } from '../storage/contract-grant-entry-store.js';
import { createEnrichmentStore } from '../storage/enrichment-store.js';
import { withContractDispatchReservation } from '../contract-dispatch-reservation.js';
import { createMcpHttpDispatch, type McpDeps } from '../mcp-server.js';

// The execute handler, engine, transform, overlay and SQLite stores are real.
// The host's existing beforeRunStart boundary lets the second connection edit
// authority after preparation without substituting any authorization decision.
const NOW = 1_790_000_000_000;
const VALUE = { domain: 'example.test', company_name: 'Recipe warehouse fixture', source: 'domain_only',
  domain_category: 'business', reasoning: 'Native recipe fixture', computed_at: NOW };
const RECIPE: RecipeDefinition = {
  recipe_id: 'recipe-enrichment-lifecycle', version: 1, ttl: 60,
  metadata: { name: 'Warehouse lifecycle', description: 'Reads one cached company.', author: 'test', supported_platforms: ['test'] },
  variables: {}, prefetch_steps: [],
  steps: [{ id: 'cached', transform: 'enrichment-or-fetch', ref: 'data.contact.reader@example.test.company' }],
  output: { render: [{ type: 'summary', source: 'step.cached' }], sidebar: [] },
};
const handles: Database.Database[] = [];
const dirs: string[] = [];
const fixture = (maxUses: number | null = 2, granted = true) => {
  const dir = mkdtempSync(join(tmpdir(), 'recipe-read-life-')); dirs.push(dir);
  let clock = NOW;
  const open = () => {
    const db = new Database(join(dir, 'realm.sqlite')); handles.push(db); db.pragma('journal_mode = WAL');
    const store = createContractStore(db, { now: () => clock }); store.seedSchema(D165_CONTRACT_SCHEMA);
    return { db, store, definitions: createContractDefinitionStore(store, { now: () => clock }), grants: createContractGrantEntryStore(store) };
  };
  const env = open(), peer = open();
  const contract = env.definitions.mint({ minted_by: 'owner', display_name: 'Recipe reader', scope: { channels: ['mcp'] },
    expiry_at: NOW + 60_000, ...(maxUses === null ? {} : { max_uses: maxUses }) });
  env.grants.set(contract.contract_id, 'enrichment.company', granted, NOW);
  const overlay = createContractOverlayResolver({ definitionStore: env.definitions, grantEntryStore: env.grants, now: () => clock });
  const enrichmentStore = createEnrichmentStore(env.db, { now: () => clock });
  enrichmentStore.upsert({ topic: 'company', scope: 'contact', target_id: 'reader@example.test', value: VALUE,
    authored_by: 'system.housekeeping.company', event_at: NOW });
  const nativeList = enrichmentStore.list.bind(enrichmentStore);
  const read = vi.spyOn(enrichmentStore, 'list');
  const recipeStore = createRecipeStore(join(dir, 'recipes')); recipeStore.register(RECIPE);
  const source: ExecutionSource = { channel: 'mcp', actor: 'contracted_user', agent_id: 'fixture-agent',
    tool_call_id: 'recipe-read', mcp_token_id: 'fixture-token', contract_id: contract.contract_id };
  const deps: ExecuteHandlerDeps = { db: env.db, recipeStore,
    executorConfig: { manifests: createManifestRegistry(join(dir, 'manifests')) }, baseVault: {}, contractOverlay: overlay, enrichmentStore };
  const run = (change: () => void = () => {}) => handleExecute(deps, {
    recipe_id: RECIPE.recipe_id, trigger_source: 'mcp', execution_source: source,
    contract_snapshot: { contract_id: contract.contract_id, contract_version: 'fixture', allowed_tools: [],
      approval_required: [], scope_restrictions: [], resolved_at: NOW },
  }, { beforeRunStart: () => { read.mockClear(); change(); } });
  return { ...env, peer, contract, source, overlay, deps, read, nativeList, run, recipeStore, expire: () => { clock = NOW + 60_001; },
    row: () => env.definitions.get(contract.contract_id) };
};
afterEach(() => {
  vi.restoreAllMocks();
  for (const db of handles.splice(0)) if (db.open) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const outcome = (response: Awaited<ReturnType<typeof handleExecute>>) => {
  expect(response.success).toBe(true); expect(response.errors).toEqual([]);
  expect(response.steps).toEqual([expect.objectContaining({ id: 'cached', error: null, skipped: false })]);
  return response.output.render[0]?.data;
};

describe('recipe-local enrichment contract lifecycle', () => {
  it.each([1, 2, null])('reads a granted row without spending the %s-use dispatch budget', async cap => {
    const f = fixture(cap), before = f.row();
    expect(outcome(await f.run())).toEqual({ value: VALUE, source: 'enrichment' });
    expect(f.read).toHaveBeenCalledTimes(1); expect(f.row()).toEqual(before);
  });

  it.each(['revoked', 'expired', 'missing', 'exhausted'] as const)('does not read the warehouse when prepared authority is %s', async state => {
    const f = fixture(); let changed: ReturnType<typeof f.row>;
    const response = await f.run(() => {
      if (state === 'revoked') f.peer.definitions.revoke(f.contract.contract_id, 'Owner ended this recipe door');
      if (state === 'expired') f.expire();
      if (state === 'missing') f.peer.store.delete(CONTRACT_DEFINITION_SCOPE, [f.contract.contract_id]);
      if (state === 'exhausted') { f.peer.definitions.recordUse(f.contract.contract_id); f.peer.definitions.recordUse(f.contract.contract_id); }
      changed = f.row();
    });
    expect(outcome(response)).toEqual({ value: null, source: 'miss' });
    expect(f.read).not.toHaveBeenCalled(); expect(f.row()).toEqual(changed!);
    if (state === 'revoked') expect(f.row()).toMatchObject({ revoked_at: NOW, revocation_reason: 'Owner ended this recipe door', uses_remaining: 2 });
  });

  it.each([false, true])('observes a topic grant edited to %s through the other connection', async grant => {
    const f = fixture(2, !grant), before = f.row();
    const response = await f.run(() => f.peer.grants.set(f.contract.contract_id, 'enrichment.company', grant, NOW + 1));
    expect(outcome(response)).toEqual(grant ? { value: VALUE, source: 'enrichment' } : { value: null, source: 'miss' });
    expect(f.read).toHaveBeenCalledTimes(grant ? 1 : 0); expect(f.row()).toEqual(before);
    expect(f.grants.get(f.contract.contract_id, 'enrichment.company')).toBe(grant);
  });

  it('keeps the first result but refuses the next warehouse read after revocation', async () => {
    const f = fixture();
    f.recipeStore.register({ ...RECIPE, steps: [RECIPE.steps[0]!, { ...RECIPE.steps[0]!, id: 'second' }],
      output: { render: [{ type: 'summary', source: 'step.cached' }, { type: 'summary', source: 'step.second' }], sidebar: [] } });
    f.read.mockImplementationOnce((...args) => {
      const rows = f.nativeList(...args);
      f.peer.definitions.revoke(f.contract.contract_id, 'Owner stopped further reads');
      return rows;
    });
    const response = await f.run();
    expect(response.success).toBe(true); expect(response.errors).toEqual([]);
    expect(response.steps.map(step => step.id)).toEqual(['cached', 'second']);
    expect(response.output.render.map(block => block.data)).toEqual([
      { value: VALUE, source: 'enrichment' }, { value: null, source: 'miss' },
    ]);
    expect(f.read).toHaveBeenCalledTimes(1);
    expect(f.row()).toMatchObject({ revoked_at: NOW, revocation_reason: 'Owner stopped further reads', uses_remaining: 2 });
  });

  it('cannot borrow a completed dispatch reservation to read an exhausted contract', async () => {
    const f = fixture(1), take = f.overlay.takeDispatchUse!(f.source, 'other-dispatch');
    expect(take.kind).toBe('taken'); if (take.kind !== 'taken') throw new Error('Fixture did not reserve the final unit');
    f.overlay.settleDispatchUse!(take, true);
    const before = f.row();
    expect(outcome(await withContractDispatchReservation(take.token, () => f.run()))).toEqual({ value: null, source: 'miss' });
    expect(f.read).not.toHaveBeenCalled(); expect(f.row()).toEqual(before);
  });

  it('keeps an unbound owner read independent of another revoked contract', async () => {
    const f = fixture(); f.peer.definitions.revoke(f.contract.contract_id, 'Unrelated door ended');
    const before = f.row();
    expect(outcome(await handleExecute(f.deps, { recipe_id: RECIPE.recipe_id, trigger_source: 'mcp' })))
      .toEqual({ value: VALUE, source: 'enrichment' });
    expect(f.read).toHaveBeenCalledTimes(1); expect(f.row()).toEqual(before);
  });

  it('retains a topic denial when the owner replaces an exhausted budget', async () => {
    const f = fixture(1, false); f.peer.definitions.recordUse(f.contract.contract_id);
    let renewed: ReturnType<typeof f.row>;
    const response = await f.run(() => {
      f.peer.definitions.setLimits(f.contract.contract_id, { max_uses: 2, use_period: 'total', expiry_at: NOW + 60_000 });
      renewed = f.row();
    });
    expect(f.overlay.isContractLive(f.contract.contract_id)).toBe(true);
    expect(outcome(response)).toEqual({ value: null, source: 'miss' });
    expect(f.read).not.toHaveBeenCalled(); expect(f.row()).toEqual(renewed!);
    expect(f.grants.get(f.contract.contract_id, 'enrichment.company')).toBe(false);
  });

  it.each([STDIO_MCP_TOKEN_ID, 'cli-owner-fixture'])('preserves an admitted unbound MCP read with token %s', async tokenId => {
    const f = fixture(); f.peer.definitions.revoke(f.contract.contract_id, 'Unrelated door ended');
    const before = f.row();
    const deps: McpDeps = { ...f.deps, mcpTokenId: tokenId, ownerAdmitAll: true };
    const reply = await createMcpHttpDispatch(deps)({ jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'recued_runRecipe', arguments: { recipe_id: RECIPE.recipe_id } } }) as {
        error?: unknown; result: { isError?: boolean; content: Array<{ text: string }> };
      };
    expect(reply.error).toBeUndefined(); expect(reply.result.isError).not.toBe(true);
    expect(reply.result.content[0]?.text).toContain(VALUE.company_name);
    expect(f.read).toHaveBeenCalledTimes(1); expect(f.row()).toEqual(before);
  });

  it.each(['revoked', 'missing'] as const)('retains a real binding whose token id matches when its definition is %s', async state => {
    const f = fixture(); f.source.mcp_token_id = f.contract.contract_id;
    const response = await f.run(() => {
      if (state === 'revoked') f.peer.definitions.revoke(f.contract.contract_id, 'Real binding ended');
      else f.peer.store.delete(CONTRACT_DEFINITION_SCOPE, [f.contract.contract_id]);
    });
    expect(outcome(response)).toEqual({ value: null, source: 'miss' });
    expect(f.read).not.toHaveBeenCalled();
  });
});
