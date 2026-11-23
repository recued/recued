import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONTRACT_DEFINITION_SCOPE, D165_CONTRACT_SCHEMA, type ContractScope, type RecipeDefinition } from '@recued/contracts';
import { createMcpHttpDispatch, type McpDeps } from '../mcp-server.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { createRecipeStore } from '../recipe-store.js';
import { createContractOverlayResolver } from '../policy-contract-overlay.js';
import { createContractDefinitionStore } from '../storage/contract-definition-store.js';
import { createContractStore } from '../storage/contract-store.js';
import { withContractDispatchReservation } from '../contract-dispatch-reservation.js';
import { createMcpActionStore, MCP_ACTION_TABLE, type McpActionRecord } from '../mcp-action-store.js';
import { createSQLiteCollection } from '../sqlite-collection.js';
import { InFlightRegistry } from '../execution/in-flight-registry.js';
import { LaneSemaphore } from '../execution/lane-semaphore.js';
import type { CustomerSurfaceUsageSession } from '../seller/customer-surface-usage.js';

const NOW = 1_700_000_000_000;
const RECIPE: RecipeDefinition = {
  recipe_id: 'native-admission-fixture', version: 1, ttl: 60,
  metadata: { name: 'Fixture recipe', description: 'Native admission fixture', author: 'test', supported_platforms: ['test'] },
  variables: {}, prefetch_steps: [],
  steps: [{ id: 'value', transform: 'template', template: 'fixture' }],
  output: { sidebar: [{ type: 'text', source: 'step.value' }] },
};
const handles: Database.Database[] = [];
const dirs: string[] = [];
const fixture = (maxUses: number | null = 2, scope: ContractScope = { channels: ['mcp'] }) => {
  const dir = mkdtempSync(join(tmpdir(), 'recued-native-admission-')); dirs.push(dir);
  const database = join(dir, 'realm.sqlite');
  let clock = NOW;
  const open = () => {
    const db = new Database(database); handles.push(db); db.pragma('journal_mode = WAL');
    const store = createContractStore(db, { now: () => clock }); store.seedSchema(D165_CONTRACT_SCHEMA);
    return { db, store, definitions: createContractDefinitionStore(store, { now: () => clock }) };
  };
  const primary = open(), definitions = primary.definitions;
  const contract = definitions.mint({ minted_by: 'owner', display_name: 'Native admission fixture', scope,
    door_types: ['mcp'], expiry_at: NOW + 60_000, ...(maxUses === null ? {} : { max_uses: maxUses }) });
  const peerEnv = open(), peer = peerEnv.definitions;
  const overlay = createContractOverlayResolver({ definitionStore: definitions, now: () => clock });
  const recipeStore = createRecipeStore(join(dir, 'recipes')); recipeStore.register(RECIPE);
  const get = vi.spyOn(recipeStore, 'get'), ids = vi.spyOn(recipeStore, 'ids'), save = vi.spyOn(recipeStore, 'save');
  const deps: McpDeps = {
    recipeStore, executorConfig: { manifests: createManifestRegistry(join(dir, 'manifests')) }, baseVault: {},
    mcpTokenId: 'http_native_fixture', agentId: 'fixture-agent', boundContractId: contract.contract_id,
    boundContractActive: overlay.isContractLive(contract.contract_id), inboundTokenAuthorize: () => true,
    contractOverlay: overlay,
  };
  return { contract, definitions, peer, overlay, deps, get, ids, save, db: primary.db,
    removeDefinition: () => peerEnv.store.delete(CONTRACT_DEFINITION_SCOPE, [contract.contract_id]),
    expire: () => { clock = NOW + 60_001; }, row: () => definitions.get(contract.contract_id) };
};
afterEach(() => {
  vi.restoreAllMocks();
  for (const db of handles.splice(0)) if (db.open) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Reply = {
  jsonrpc: string; id: number; error?: unknown;
  result: { isError?: boolean; content: Array<{ type: string; text: string }> };
};
const call = async (deps: McpDeps, tool: string, args: Record<string, unknown> = {}) =>
  await createMcpHttpDispatch(deps)({ jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: tool, arguments: args } }) as Reply;
const readArgs = (tool: string) => tool === 'recued_getRecipe' ? { recipe_id: RECIPE.recipe_id } : {};
const listTools = async (deps: McpDeps) =>
  await createMcpHttpDispatch(deps)({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) as {
    result: { tools: Array<{ name: string }> };
  };
const expectRecipe = (reply: Reply) => {
  expect(reply).toMatchObject({ jsonrpc: '2.0', id: 1 });
  expect(reply.error).toBeUndefined();
  expect(reply.result.isError).not.toBe(true);
  expect(reply.result.content[0].text).toContain(RECIPE.recipe_id);
};

describe('native MCP contract admission over shared SQLite', () => {
  describe('bound-contract lifecycle is independent of metering', () => {
    describe.each(['recued_listRecipes', 'recued_getRecipe'])('%s', tool => {
      it.each(['exhausted', 'revoked', 'expired'] as const)('refuses an unmetered call when the bound contract is %s', async state => {
        const f = fixture(1, { channels: ['mcp'], ingredient_ids: ['other-tool'] });
        expect(f.deps.boundContractActive).toBe(true);
        if (state === 'exhausted') expect(f.peer.reserveDispatchUse!(f.contract.contract_id)).not.toBeNull();
        else if (state === 'revoked') f.peer.revoke(f.contract.contract_id, 'Owner closed this unmetered door');
        else f.expire();
        const before = f.row();

        expect((await call(f.deps, tool, readArgs(tool))).result.isError).toBe(true);
        expect(f.get).not.toHaveBeenCalled(); expect(f.ids).not.toHaveBeenCalled();
        expect(f.row()).toEqual(before);
      });

      it('refuses a missing bound definition without accessing recipes', async () => {
        const f = fixture(1);
        expect(f.removeDefinition()).toBe(true);
        expect((await call(f.deps, tool, readArgs(tool))).result.isError).toBe(true);
        expect(f.get).not.toHaveBeenCalled(); expect(f.ids).not.toHaveBeenCalled(); expect(f.row()).toBeNull();
      });
    });

    it('removes business tools from a revoked contract\'s catalog', async () => {
      const f = fixture(1, { channels: ['mcp'], ingredient_ids: ['other-tool'] });
      expect((await listTools(f.deps)).result.tools.map(t => t.name)).toContain('recued_listRecipes');
      f.peer.revoke(f.contract.contract_id, 'Owner closed this catalog');
      const before = f.row();
      expect((await listTools(f.deps)).result.tools).toEqual([]); expect(f.row()).toEqual(before);
    });

    it('does not let a new unmetered request borrow another attempt\'s reserved final use', async () => {
      const f = fixture(1, { channels: ['mcp'], ingredient_ids: ['other-tool'] });
      const use = f.overlay.takeDispatchUse!({ channel: 'mcp', actor: 'contracted_user', agent_id: 'fixture-agent', tool_call_id: 'prior-call',
        mcp_token_id: 'http_native_fixture', contract_id: f.contract.contract_id }, 'other-tool');
      expect(use.kind).toBe('taken'); if (use.kind !== 'taken') throw new Error('Fixture did not reserve its final use');
      await withContractDispatchReservation(use.token, async () => {
        expect(f.overlay.isContractLive(f.contract.contract_id)).toBe(true);
        expect((await listTools(f.deps)).result.tools).toEqual([]);
        expect((await call(f.deps, 'recued_listRecipes')).result.isError).toBe(true);
      });
      f.overlay.settleDispatchUse!(use, true);
      expect(f.get).not.toHaveBeenCalled(); expect(f.ids).not.toHaveBeenCalled(); expect(f.row()?.uses_remaining).toBe(0);
    });

    it('keeps a transport admission denial authoritative even when the contract is live', async () => {
      const f = fixture(1);
      expect(f.overlay.isContractLive(f.contract.contract_id)).toBe(true);
      const denied = { ...f.deps, boundContractActive: false };
      expect((await call(denied, 'recued_listRecipes')).result.isError).toBe(true);
      expect((await listTools(denied)).result.tools).toEqual([]);
      expect(f.get).not.toHaveBeenCalled(); expect(f.ids).not.toHaveBeenCalled(); expect(f.row()?.uses_remaining).toBe(1);
    });

    it('refuses an inactive bound contract before reserving seller usage', async () => {
      const f = fixture(1, { channels: ['mcp'], ingredient_ids: ['other-tool'] });
      f.peer.revoke(f.contract.contract_id, 'Owner closed this door'); const before = f.row();
      const reserveOnce = vi.fn(() => ({ admitted: true as const })), commit = vi.fn();
      const customerUsage: CustomerSurfaceUsageSession = { reserve: () => ({ admitted: true }), reserveOnce,
        markZeroUnitReservation: () => ({ admitted: true }), hasReservationKey: () => false,
        commit, release: vi.fn(), denialMessage: () => undefined };
      expect((await call({ ...f.deps, customerUsage }, 'recued_listRecipes')).result.isError).toBe(true);
      expect(reserveOnce).not.toHaveBeenCalled(); expect(commit).not.toHaveBeenCalled();
      expect(f.get).not.toHaveBeenCalled(); expect(f.ids).not.toHaveBeenCalled(); expect(f.row()).toEqual(before);
    });

    it('preserves a resolved transport snapshot when no live overlay is configured', async () => {
      const f = fixture(1);
      const { contractOverlay, ...legacy } = f.deps;
      expectRecipe(await call(legacy, 'recued_listRecipes')); expect(f.row()?.uses_remaining).toBe(1);
    });

    it('still queries the token\'s action store after its bound contract is revoked', async () => {
      const f = fixture(1); f.peer.revoke(f.contract.contract_id, 'Owner closed this door'); const before = f.row();
      const mcpActionStore = createMcpActionStore(createSQLiteCollection<McpActionRecord>(f.db, MCP_ACTION_TABLE));
      const getOwned = vi.spyOn(mcpActionStore, 'getOwned');
      const reply = await call({ ...f.deps, mcpPrincipalActive: () => true, inboundTokenAuthorize: () => false, mcpActionStore },
        'recued_actionStatus', { action_ref: 'unknown-action' });
      expect(reply.result.content[0].text).toContain('Async action not found for this MCP token');
      expect(getOwned).toHaveBeenCalledWith('unknown-action', 'http_native_fixture'); expect(f.row()).toEqual(before);
    });

    it('still stops the token\'s own run after its bound contract is revoked', async () => {
      const f = fixture(1); f.peer.revoke(f.contract.contract_id, 'Owner closed this door'); const before = f.row();
      const inFlightRegistry = new InFlightRegistry(new LaneSemaphore()), abort = vi.fn();
      inFlightRegistry.registerRun({ run_id: 'fixture-run', recipe_id: RECIPE.recipe_id, started_at: NOW, origin: 'attended', abort,
        source: { channel: 'mcp', actor: 'contracted_user', agent_id: 'fixture-agent', tool_call_id: 'fixture-call',
          mcp_token_id: 'http_native_fixture', contract_id: f.contract.contract_id } });
      const reply = await call({ ...f.deps, mcpPrincipalActive: () => true, inboundTokenAuthorize: () => false, inFlightRegistry },
        'recued_stopRecipe', { run_id: 'fixture-run' });
      expect(reply.result.isError).not.toBe(true); expect(JSON.parse(reply.result.content[0].text).status).toBe('stopped');
      expect(abort).toHaveBeenCalledOnce(); expect(f.row()).toEqual(before);
    });
  });

  describe.each(['recued_listRecipes', 'recued_getRecipe'])('%s', tool => {
    it.each(['exhausted', 'revoked', 'expired'] as const)('refuses a live-store %s contract before reading recipes', async state => {
      const f = fixture(1);
      expect(f.deps.boundContractActive).toBe(true);
      if (state === 'exhausted') expect(f.peer.reserveDispatchUse!(f.contract.contract_id)).not.toBeNull();
      else if (state === 'revoked') expect(f.peer.revoke(f.contract.contract_id, 'Owner closed this door')).not.toBeNull();
      else f.expire();
      expect(f.overlay.isContractLive(f.contract.contract_id)).toBe(false);
      const before = f.row();

      const reply = await call(f.deps, tool, readArgs(tool));

      expect(reply.result.isError).toBe(true);
      expect(reply.result.content[0].text).toMatch(/revoked|expired|exhausted|remaining uses/i);
      expect(f.get).not.toHaveBeenCalled();
      expect(f.ids).not.toHaveBeenCalled();
      expect(f.row()).toEqual(before);
    });

    it('allows the final use exactly once and refuses another call before reading', async () => {
      const f = fixture(1);
      expectRecipe(await call(f.deps, tool, readArgs(tool)));
      expect(f.row()?.uses_remaining).toBe(0);
      expect(f.get).toHaveBeenCalledTimes(1);
      f.get.mockClear(); f.ids.mockClear();

      expect((await call(f.deps, tool, readArgs(tool))).result.isError).toBe(true);
      expect(f.get).not.toHaveBeenCalled();
      expect(f.ids).not.toHaveBeenCalled();
      expect(f.row()?.uses_remaining).toBe(0);
    });
  });

  it('debits one unit from a multi-use contract', async () => {
    const f = fixture(2);
    expectRecipe(await call(f.deps, 'recued_getRecipe', readArgs('recued_getRecipe')));
    expect(f.get).toHaveBeenCalledTimes(1);
    expect(f.row()?.uses_remaining).toBe(1);
  });

  it('leaves the budget untouched when the checklist refuses', async () => {
    const f = fixture(1);
    const reply = await call({ ...f.deps, inboundTokenAuthorize: () => false }, 'recued_listRecipes');
    expect(reply.result.isError).toBe(true);
    expect(f.ids).not.toHaveBeenCalled();
    expect(f.get).not.toHaveBeenCalled();
    expect(f.row()?.uses_remaining).toBe(1);
    expectRecipe(await call(f.deps, 'recued_listRecipes'));
  });

  it('leaves the budget and recipe store untouched when a native write requires approval', async () => {
    const f = fixture(1);
    const reply = await call(f.deps, 'recued_saveRecipe', { recipe: RECIPE });
    expect(reply.result.isError).toBe(true);
    expect(reply.result.content[0].text).toMatch(/approval/i);
    expect(f.save).not.toHaveBeenCalled();
    expect(f.get).not.toHaveBeenCalled();
    expect(f.row()?.uses_remaining).toBe(1);
    expectRecipe(await call(f.deps, 'recued_listRecipes'));
  });

  it('preserves unmetered dispatch for a live contract outside the ingredient scope', async () => {
    const f = fixture(1, { channels: ['mcp'], ingredient_ids: ['other-tool'] });
    expectRecipe(await call(f.deps, 'recued_listRecipes'));
    expect(f.row()?.uses_remaining).toBe(1);
  });

  it('preserves unmetered dispatch for an unbound token', async () => {
    const f = fixture(1);
    const { boundContractId, boundContractActive, ...unbound } = f.deps;
    expectRecipe(await call(unbound, 'recued_listRecipes'));
    expect(f.row()?.uses_remaining).toBe(1);
  });

  it('admits an unbounded live contract but still refuses its revocation', async () => {
    const f = fixture(null);
    expectRecipe(await call(f.deps, 'recued_listRecipes'));
    const before = f.row();
    expect(before?.uses_remaining).toBeUndefined();
    f.peer.revoke(f.contract.contract_id, 'Owner closed this unbounded door');
    f.get.mockClear(); f.ids.mockClear();
    const revoked = f.row();
    expect((await call(f.deps, 'recued_listRecipes')).result.isError).toBe(true);
    expect(f.get).not.toHaveBeenCalled(); expect(f.ids).not.toHaveBeenCalled();
    expect(f.row()).toEqual(revoked);
  });

  it('keeps the existing charge when the admitted native body returns an error', async () => {
    const f = fixture(2);
    const reply = await call(f.deps, 'recued_getRecipe', { recipe_id: 'missing-recipe' });
    expect(reply.result.isError).toBe(true);
    expect(reply.result.content[0].text).toMatch(/recipe not found/i);
    expect(f.get).toHaveBeenCalledWith('missing-recipe');
    expect(f.row()?.uses_remaining).toBe(1);
  });
});
