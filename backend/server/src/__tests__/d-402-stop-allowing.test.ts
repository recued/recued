/** D-402 slice F4 (§7.9, ruling 12) — "Stop allowing": every standing permission one caller holds for one
 *  recipe, ended at once, and nothing else: another caller's, another recipe's, the chat's switch. */

import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import type { ContractDefinition, WriteRuleRow } from '@recued/contracts';

import { createBrowserPassStore } from '../storage/browser-pass-store.js';
import { createTriggerPreapprovalStore } from '../storage/trigger-preapproval-store.js';
import { stopAllowing, stoppedCount } from '../stop-allowing.js';

const OWNER = { kind: 'owner_chat' } as const;
const APP = { kind: 'ai_app', contract_id: 'k-claude' } as const;
const V1 = 'a'.repeat(64);
const V2 = 'b'.repeat(64);
const NOW = Date.UTC(2026, 10, 17, 12);

/** A grant as the contract store keeps one, live for a day. */
const grant = (contract_id: string, over: Partial<ContractDefinition>): ContractDefinition => ({
  contract_id, display_name: contract_id, scope: { channels: ['chat'], actors: ['user_self'], ingredient_ids: ['notes'] },
  minted_at: NOW - 1_000, minted_by: 'owner', expiry_at: NOW + 86_400_000,
  ...over,
} as unknown as ContractDefinition);

const fixture = () => {
  const db = new Database(':memory:');
  const preapprovals = createTriggerPreapprovalStore(db);
  const browserPasses = createBrowserPassStore(db);
  const defs = [
    // "Allow in this chat" for this recipe, in one of the owner's chats: ended.
    grant('g-chat', { grant_kind: 'session', grant_mode: 'kind', channel_session_id: 'chat:c1', bound_recipe: { recipe_id: 'file-bill', recipe_hash: 'h' } }),
    // The same in a messenger: ended too.
    grant('g-messenger', { grant_kind: 'session', grant_mode: 'kind', channel_session_id: 'messenger:telegram:42', bound_recipe: { recipe_id: 'file-bill', recipe_hash: 'h' } }),
    // Another recipe's: kept.
    grant('g-other', { grant_kind: 'session', grant_mode: 'kind', channel_session_id: 'chat:c1', bound_recipe: { recipe_id: 'other', recipe_hash: 'h' } }),
    // An AI app's, bound to its contract: kept when the owner's chats are stopped.
    grant('g-app', { grant_kind: 'session', grant_mode: 'kind', channel_session_id: 'mcp:t1', bound_contract_id: 'k-claude', bound_recipe: { recipe_id: 'file-bill', recipe_hash: 'h' } }),
    // A delegation rule the owner's chats hold for the recipe: ended.
    grant('d-chat', { grant_kind: 'delegation', bound_recipe: { recipe_id: 'file-bill', recipe_hash: 'h' } }),
  ];
  const revokedGrants: string[] = [];
  // As the store ends one: no longer live.
  const end = (id: string) => {
    const at = defs.findIndex((def) => def.contract_id === id);
    if (at === -1) return null;
    revokedGrants.push(id);
    defs[at] = { ...defs[at]!, revoked_at: NOW } as unknown as ContractDefinition;
    return defs[at]!;
  };
  const definitions = { list: () => defs, revokeSessionGrant: vi.fn(end), revoke: vi.fn(end) };
  const rules = [
    { rule_id: 'r-chat', key: { principal: OWNER, tool: 'schedule.create', scope: 'file-bill' } },
    { rule_id: 'r-other', key: { principal: OWNER, tool: 'schedule.create', scope: 'other' } },
    { rule_id: 'r-app', key: { principal: APP, tool: 'schedule.create', scope: 'file-bill' } },
  ] as unknown as WriteRuleRow[];
  const revokedRules: string[] = [];
  const writeRules = { listRules: () => rules.filter((rule) => !revokedRules.includes(rule.rule_id)),
    revoke: vi.fn((id: string) => { revokedRules.push(id); return rules.find((rule) => rule.rule_id === id)!; }) };
  const auditLog = { logActivity: vi.fn(async () => undefined) };
  const deps = { preapprovals, browserPasses, definitions, writeRules, auditLog, now: () => NOW } as never;
  return { preapprovals, browserPasses, revokedGrants, revokedRules, auditLog, deps };
};

describe('D-402 slice F4 — "Stop allowing" ends one caller\'s permissions for one recipe, and only those', () => {
  it('the owner\'s chats: their pre-approvals (every version, this run\'s too), site passes, grants, rules', () => {
    const f = fixture();
    const always = f.preapprovals.grantCaller({ caller: OWNER, recipe_id: 'file-bill', recipe_sha256: V1, now: NOW - 10 });
    const older = f.preapprovals.grantCaller({ caller: OWNER, recipe_id: 'file-bill', recipe_sha256: V2, now: NOW - 9 });
    const once = f.preapprovals.grantCaller({ caller: OWNER, recipe_id: 'file-bill', recipe_sha256: V1, run_id: 'run-1', now: NOW - 8 });
    const other = f.preapprovals.grantCaller({ caller: OWNER, recipe_id: 'other', recipe_sha256: V1, now: NOW - 7 });
    const apps = f.preapprovals.grantCaller({ caller: APP, recipe_id: 'file-bill', recipe_sha256: V1, now: NOW - 6 });
    const pass = f.browserPasses.mint({ key: { principal: OWNER, recipe: 'file-bill', site: 'https://water.example.com' }, host: 'water.example.com', kind: 'always', now: NOW - 5 });
    const appPass = f.browserPasses.mint({ key: { principal: APP, recipe: 'file-bill', site: 'https://water.example.com' }, host: 'water.example.com', kind: 'always', now: NOW - 4 });
    const otherPass = f.browserPasses.mint({ key: { principal: OWNER, recipe: 'other', site: 'https://water.example.com' }, host: 'water.example.com', kind: 'always', now: NOW - 3 });

    const result = stopAllowing(f.deps, { caller: OWNER, recipe_id: 'file-bill', by: 'owner_chat' });
    expect(result).toEqual({ preapprovals: 3, site_passes: 1, session_grants: 2, delegations: 1, write_rules: 1 });
    expect(stoppedCount(result)).toBe(8);
    const ended = (id: string) => f.preapprovals.getCaller(id)?.revoked_at !== undefined;
    expect([always.id, older.id, once.id].every(ended)).toBe(true);
    expect([other.id, apps.id].some(ended)).toBe(false);
    const live = f.browserPasses.listPasses(NOW).map((row) => row.pass_id);
    expect(live).not.toContain(pass.pass_id);
    expect(live).toEqual(expect.arrayContaining([appPass.pass_id, otherPass.pass_id]));
    expect(f.revokedGrants.sort()).toEqual(['d-chat', 'g-chat', 'g-messenger']);
    expect(f.revokedRules).toEqual(['r-chat']);
    expect(f.auditLog.logActivity).toHaveBeenCalledWith(expect.objectContaining({ action: 'stop_allowing', target: 'file-bill' }));
    // Again: nothing more to end.
    expect(stoppedCount(stopAllowing(f.deps, { caller: OWNER, recipe_id: 'file-bill', by: 'owner_chat' }))).toBe(0);
  });

  it('an AI app: its own, by its contract, never the owner\'s chats\' or another app\'s', () => {
    const f = fixture();
    const mine = f.preapprovals.grantCaller({ caller: APP, recipe_id: 'file-bill', recipe_sha256: V1, now: NOW - 3 });
    const owners = f.preapprovals.grantCaller({ caller: OWNER, recipe_id: 'file-bill', recipe_sha256: V1, now: NOW - 2 });
    const another = f.preapprovals.grantCaller({ caller: { kind: 'ai_app', contract_id: 'k-other' }, recipe_id: 'file-bill', recipe_sha256: V1, now: NOW - 1 });
    const result = stopAllowing(f.deps, { caller: APP, recipe_id: 'file-bill', by: 'ai_app' });
    expect(result).toEqual({ preapprovals: 1, site_passes: 0, session_grants: 1, delegations: 0, write_rules: 1 });
    expect(f.preapprovals.getCaller(mine.id)?.revoked_at).toBe(NOW);
    expect(f.preapprovals.getCaller(owners.id)?.revoked_at).toBeUndefined();
    expect(f.preapprovals.getCaller(another.id)?.revoked_at).toBeUndefined();
    expect(f.revokedGrants).toEqual(['g-app']);
    expect(f.revokedRules).toEqual(['r-app']);
  });
});

describe('D-402 slice F4 — the owner\'s rpc: what callers may do without asking, and "Stop allowing"', () => {
  it('lists each by its recipe\'s name and who holds it; stopping one caller ends theirs, listed as ended', async () => {
    const f = fixture();
    const recipe = { recipe_id: 'file-bill', metadata: { name: 'File the water bill' } } as never;
    const version = (await import('../trigger-preapproval-rpc.js')).triggerPreapprovalRecipeSha256(recipe);
    f.preapprovals.grantCaller({ caller: OWNER, recipe_id: 'file-bill', recipe_sha256: version, now: NOW - 3 });
    f.preapprovals.grantCaller({ caller: APP, recipe_id: 'file-bill', recipe_sha256: version, now: NOW - 2 });
    f.preapprovals.grantCaller({ caller: OWNER, recipe_id: 'file-bill', recipe_sha256: V2, now: NOW - 1 });
    const { createCallerPreapprovalRpcHandlers } = await import('../caller-preapproval-rpc.js');
    const rpc = createCallerPreapprovalRpcHandlers({ store: f.preapprovals, stopDeps: () => f.deps,
      recipeOf: (id) => (id === 'file-bill' ? recipe : null), aiAppNameOf: (id) => (id === 'k-claude' ? 'Claude Desktop' : undefined), now: () => NOW });
    const listed = await rpc['collection.contract.listCallerPreapprovals']();
    expect(listed.preapprovals.map((row) => [row.caller_name, row.recipe_name, row.state])).toEqual([
      ['your chats', 'File the water bill', 'outdated'], ['Claude Desktop', 'File the water bill', 'live'], ['your chats', 'File the water bill', 'live']]);
    const { ended } = await rpc['collection.contract.stopAllowing']({ caller: { kind: 'ai_app', contract_id: 'k-claude' }, recipe_id: 'file-bill' });
    expect(ended.preapprovals).toBe(1);
    expect((await rpc['collection.contract.listCallerPreapprovals']()).preapprovals.map((row) => [row.caller_name, row.state]))
      .toEqual([['your chats', 'outdated'], ['Claude Desktop', 'revoked'], ['your chats', 'live']]);
    await expect(rpc['collection.contract.stopAllowing']({ recipe_id: 'file-bill' })).rejects.toThrow(/caller .* and recipe_id are required/u);
  });
});

describe('D-402 slice F4 — the owner\'s chat takes an "Always" back (`recipe.stop_allowing`)', () => {
  const chatTool = async (deps: Record<string, unknown>, args: unknown, source: Record<string, unknown>) => {
    const { buildChatTier1Handlers } = await import('../chat-tool-handlers.js');
    return buildChatTier1Handlers(deps as never)['recipe.stop_allowing']!(args,
      { channel: 'internal_function_call', session_id: 's', turn_id: 't', execution_source: source } as never);
  };
  const OWNER_CHAT = { channel: 'chat', actor: 'user_self', chat_session_id: 's', user_id: 'u', turn_id: 't' };
  const none = { preapprovals: 0, site_passes: 0, session_grants: 0, delegations: 0, write_rules: 0 };

  it('ends what the owner\'s chats may do, or the app the owner names, and says what it ended', async () => {
    const stop = vi.fn((input: { caller: unknown; recipe_id: string }) =>
      (input.recipe_id === 'file-bill' ? { ...none, preapprovals: 1, site_passes: 2 } : none));
    const deps = { stopAllowing: stop, aiAppContractOf: (name: string) => (name.toLowerCase() === 'claude desktop' ? 'k-claude' : undefined) };
    const mine = await chatTool(deps, { recipe_id: 'recued-core/file-bill' }, OWNER_CHAT);
    expect(stop).toHaveBeenLastCalledWith({ caller: { kind: 'owner_chat' }, recipe_id: 'file-bill', by: 'owner_chat' });
    expect(mine).toMatchObject({ ok: true, result: { status: 'stopped',
      said: 'Ended 1 standing approval and 2 site passes: your chats now ask before each action of this recipe that asks.' } });
    await chatTool(deps, { recipe_id: 'file-bill', app: 'Claude Desktop' }, OWNER_CHAT);
    expect(stop).toHaveBeenLastCalledWith({ caller: { kind: 'ai_app', contract_id: 'k-claude' }, recipe_id: 'file-bill', by: 'owner_chat' });
    expect(await chatTool(deps, { recipe_id: 'other' }, OWNER_CHAT)).toMatchObject({ ok: true, result: { status: 'none' } });
  });

  it('an app no key is called: nothing ended; any chat but the owner\'s own: refused', async () => {
    const stop = vi.fn(() => none);
    const deps = { stopAllowing: stop, aiAppContractOf: () => undefined };
    expect(await chatTool(deps, { recipe_id: 'file-bill', app: 'Nobody' }, OWNER_CHAT))
      .toMatchObject({ ok: true, result: { status: 'not_found' } });
    expect(await chatTool(deps, { recipe_id: 'file-bill' }, { ...OWNER_CHAT, contract_id: 'k-household' }))
      .toMatchObject({ ok: false, reason: 'channel_denied' });
    expect(stop).not.toHaveBeenCalled();
  });
});

describe('D-402 slice F4 — composed once, where the run reads it (the composition root, not a stub)', () => {
  it('composeExecuteDeps carries the app-name lookups and "Stop allowing" over the stores it was given', async () => {
    const { composeExecuteDeps } = await import('../composition/bin/wire-execute-deps.js');
    const { createRecipeStore } = await import('../recipe-store.js');
    const { createManifestRegistry } = await import('../manifest-loader.js');
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'recued-d402-f4-'));
    const triggerPreapprovals = createTriggerPreapprovalStore(new Database(':memory:'));
    const apps = triggerPreapprovals.grantCaller({ caller: APP, recipe_id: 'file-bill', recipe_sha256: V1, now: NOW - 10 });
    const mine = triggerPreapprovals.grantCaller({ caller: OWNER, recipe_id: 'file-bill', recipe_sha256: V1, now: NOW - 9 });
    const execute = composeExecuteDeps({
      recipeStore: createRecipeStore(join(dir, 'recipes')),
      executorConfig: { manifests: createManifestRegistry(join(dir, 'manifests')) },
      baseVault: {}, serverInstanceId: 'server-1', serverDisplayName: 'Server One',
      eventBus: { subscribe: vi.fn(), unsubscribe: vi.fn(), emit: vi.fn(), replay: vi.fn(() => []) },
      getExecuteDeps: vi.fn(() => undefined),
      triggerPreapprovals,
      // As `compose-execution-context.ts` passes them: in a spread, where an undeclared field drops silently.
      ...{ aiAppNameOf: (id: string) => (id === 'k-claude' ? 'Claude Desktop' : undefined),
        aiAppContractOf: (name: string) => (name.toLowerCase() === 'claude desktop' ? 'k-claude' : undefined) },
    } as never).executeDeps;
    expect(execute.aiAppNameOf?.('k-claude')).toBe('Claude Desktop');
    expect(execute.aiAppContractOf?.('CLAUDE DESKTOP')).toBe('k-claude');
    expect(execute.stopAllowing?.({ caller: APP, recipe_id: 'file-bill', by: 'ai_app' })).toMatchObject({ preapprovals: 1 });
    const rows = triggerPreapprovals.listCallers();
    expect(rows.find((row) => row.id === apps.id)?.revoked_at).toBeDefined();
    expect(rows.find((row) => row.id === mine.id)?.revoked_at).toBeUndefined();
  });
});

describe('D-402 slice F4 — an AI app gives up its own permissions (`recued_stopAllowing`)', () => {
  const mcpFixture = async (wired = true) => {
    const { D165_CONTRACT_SCHEMA } = await import('@recued/contracts');
    const { createContractStore } = await import('../storage/contract-store.js');
    const { createContractDefinitionStore } = await import('../storage/contract-definition-store.js');
    const { createContractOverlayResolver } = await import('../policy-contract-overlay.js');
    const { createRecipeStore } = await import('../recipe-store.js');
    const { createManifestRegistry } = await import('../manifest-loader.js');
    const { createMcpHttpDispatch } = await import('../mcp-server.js');
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'recued-d402-f4-mcp-'));
    const store = createContractStore(new Database(':memory:')); store.seedSchema(D165_CONTRACT_SCHEMA);
    const definitions = createContractDefinitionStore(store);
    const contract = definitions.mint({ minted_by: 'owner', display_name: 'Claude Desktop', scope: { channels: ['mcp'] },
      door_types: ['mcp'], expiry_at: Date.now() + 365 * 86_400_000, max_uses: 2 });
    const overlay = createContractOverlayResolver({ definitionStore: definitions });
    const stop = vi.fn(() => ({ preapprovals: 1, site_passes: 1, session_grants: 0, delegations: 0, write_rules: 0 }));
    const deps = {
      recipeStore: createRecipeStore(join(dir, 'recipes')), executorConfig: { manifests: createManifestRegistry(join(dir, 'manifests')) },
      baseVault: {}, mcpTokenId: 'http_claude', agentId: 'claude-desktop', boundContractId: contract.contract_id,
      boundContractActive: overlay.isContractLive(contract.contract_id), contractOverlay: overlay, mcpPrincipalActive: () => true,
      // The token's checklist grants nothing: giving permissions up needs no grant.
      inboundTokenAuthorize: () => false,
      ...(wired ? { stopAllowing: stop } : {}),
    } as never;
    const send = async (body: Record<string, unknown>) => await createMcpHttpDispatch(deps)({ jsonrpc: '2.0', id: 1, ...body }) as {
      result: { tools?: Array<{ name: string }>; isError?: boolean; content?: Array<{ text: string }> } };
    return { contract, definitions, stop, send,
      call: (args: Record<string, unknown>) => send({ method: 'tools/call', params: { name: 'recued_stopAllowing', arguments: args } }),
      listed: async () => (await send({ method: 'tools/list' })).result.tools!.map((tool) => tool.name) };
  };

  it('listed with an empty checklist; ends only the calling app\'s own, from its contract; uses no contract use', async () => {
    const f = await mcpFixture();
    expect(await f.listed()).toContain('recued_stopAllowing');
    const before = f.definitions.get(f.contract.contract_id)?.uses_remaining;
    const reply = await f.call({ recipe_id: 'recued-core/file-bill' });
    expect(reply.result.isError).not.toBe(true);
    expect(JSON.parse(reply.result.content![0]!.text)).toMatchObject({ status: 'stopped', ended: { preapprovals: 1, site_passes: 1 } });
    expect(f.stop).toHaveBeenCalledWith({ caller: { kind: 'ai_app', contract_id: f.contract.contract_id }, recipe_id: 'file-bill', by: 'ai_app' });
    expect(f.definitions.get(f.contract.contract_id)?.uses_remaining).toBe(before);
  });

  it('never another app\'s: an argument naming a contract is refused, and nothing is ended', async () => {
    const f = await mcpFixture();
    const reply = await f.call({ recipe_id: 'file-bill', contract_id: 'k-other' });
    expect(reply.result.isError).toBe(true);
    expect(f.stop).not.toHaveBeenCalled();
  });

  it('not wired: not listed, and a call says so', async () => {
    const f = await mcpFixture(false);
    expect(await f.listed()).not.toContain('recued_stopAllowing');
    const reply = await f.call({ recipe_id: 'file-bill' });
    expect(reply.result.isError).toBe(true);
    expect(reply.result.content![0]!.text).toContain('not available');
  });
});
