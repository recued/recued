import Database from 'better-sqlite3';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONTRACT_DEFINITION_SCOPE, D165_CONTRACT_SCHEMA, type ContractScope, type RecipeDefinition, type TimelineEntry } from '@recued/contracts';
import { modernMcpHttpHeaders, withModernMcpRequestMeta } from '@recued/ingredients/mcp-protocol.js';
import { buildAuditEntry, createAuditLogStore, type AuditEntry, type ActivityEntry } from '@recued/storage';
import { composeMcpHttpTransport } from '../composition/bin/wire-mcp-http-transport.js';
import { createMcpPortHandler } from '../ports/mcp/handler.js';
import { createRateLimiter } from '../ports/common/rate-limit.js';
import { createChatInboundTokenStore, ensureChatInboundTokenSchema } from '../storage/chat-inbound-token-store.js';
import { createClientTokenStore } from '../pairing/client-tokens.js';
import { createContractStore } from '../storage/contract-store.js';
import { createContractDefinitionStore } from '../storage/contract-definition-store.js';
import { createContractGrantEntryStore } from '../storage/contract-grant-entry-store.js';
import { createContractOverlayResolver } from '../policy-contract-overlay.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { createRecipeStore } from '../recipe-store.js';
import { createSQLiteCollection } from '../sqlite-collection.js';
import { ensureMemorySchema } from '../memory-schema.js';
import { createCollectionTable } from '../collections/table.js';
import { createEnrichmentStore } from '../storage/enrichment-store.js';
import { createMcpActionStore, MCP_ACTION_TABLE, type McpActionRecord } from '../mcp-action-store.js';
import { InFlightRegistry } from '../execution/in-flight-registry.js';
import { LaneSemaphore } from '../execution/lane-semaphore.js';
import type { McpDeps } from '../mcp-server.js';

// Real HTTP, bearer verification, composition and dispatch. Spies observe store
// methods without replacing authentication, lifecycle, grants or use charging.
const RECIPE: RecipeDefinition = {
  recipe_id: 'http-lifecycle-recipe', version: 1, ttl: 60,
  metadata: { name: 'HTTP fixture', description: 'Task-owned fixture', author: 'test', supported_platforms: ['test'] },
  variables: {}, prefetch_steps: [], steps: [{ id: 'value', transform: 'template', template: 'fixture' }],
  output: { sidebar: [{ type: 'text', source: 'step.value' }] },
};
const AUDIT_MARKER = 'http-lifecycle-audit';
const MAIL_MARKER = 'http-lifecycle-mail';
const TOPIC_MARKER = 'http-lifecycle-topic';
const servers: Server[] = [], handles: Database.Database[] = [], dirs: string[] = [];
const drains: Array<() => Promise<void>> = [];
const serverErrors: unknown[] = [];
type RpcResult = { isError?: boolean; content?: Array<{ text: string }>; tools?: Array<{ name: string }> };
type HttpReply = { status: number; body: { jsonrpc?: string; id?: number; result?: RpcResult; error?: unknown } };

const fixture = async (options: { maxUses?: number | null; scope?: ContractScope; cli?: boolean } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'recued-http-lifecycle-')); dirs.push(dir);
  const file = join(dir, 'realm.sqlite');
  const initialTime = Date.now(); let clock = initialTime, requestId = 0;
  const open = () => {
    const db = new Database(file); handles.push(db); db.pragma('journal_mode = WAL');
    const store = createContractStore(db, { now: () => clock }); store.seedSchema(D165_CONTRACT_SCHEMA);
    ensureChatInboundTokenSchema(db);
    const tokens = createChatInboundTokenStore(db); drains.push(() => tokens.drainAuthorityChanges());
    return { db, store, tokens, definitions: createContractDefinitionStore(store, { now: () => clock }), grants: createContractGrantEntryStore(store) };
  };
  const env = open(), peer = open();
  const maxUses = options.maxUses === undefined ? 2 : options.maxUses;
  const contract = env.definitions.mint({ minted_by: 'owner', display_name: 'HTTP lifecycle fixture',
    scope: options.scope ?? { channels: ['mcp'] }, door_types: ['mcp'], expiry_at: clock + 60_000,
    ...(maxUses === null ? {} : { max_uses: maxUses }) });
  const issueDoor = () => env.tokens.issueToken({ now: clock, value: {
    label: 'HTTP fixture key', concurrency_tier: 3, chat_mode: null, contract_id: contract.contract_id,
    grants: { recued_getRecipe: true, recued_listRecipes: true, recued_getAudit: true,
      recued_dataTimeline: true, recued_enrichmentRead: true },
  } });
  const door = issueDoor();
  const overlay = createContractOverlayResolver({ definitionStore: env.definitions, grantEntryStore: env.grants, now: () => clock });
  const recipeStore = createRecipeStore(join(dir, 'recipes'), env.db); recipeStore.save(RECIPE, 'fixture', 'inline', clock);
  const auditLog = createAuditLogStore(createSQLiteCollection<AuditEntry>(env.db, 'audit_entries'), createSQLiteCollection<ActivityEntry>(env.db, 'audit_activities'));
  ensureMemorySchema(env.db);
  await auditLog.append(buildAuditEntry({ run_id: AUDIT_MARKER, recipe_id: RECIPE.recipe_id, recipe_hash: 'fixture-hash',
    commit_status: 'succeeded', duration_ms: 1, errors: [], now: clock }));
  const mail = createCollectionTable({ db: env.db, platform: 'mail', slug: 'http-fixture' });
  mail.upsert({ record_id: 'fixture-mail', received_at: clock, modified_at: clock, size_bytes: 1,
    source_id: 'fixture-source', hot_fields: { subject: MAIL_MARKER }, body_inline: MAIL_MARKER });
  const enrichmentStore = createEnrichmentStore(env.db, { now: () => clock });
  enrichmentStore.upsert({ topic: 'contact_timeline_rollup', scope: 'contact', target_id: 'fixture-contact', authored_by: 'fixture-recipe',
    value: { interaction_count: 1, last_interaction: clock, recent_subjects: [TOPIC_MARKER], cursor_at: clock, window_ms: 30 * 24 * 60 * 60 * 1000 } });
  const actions = createMcpActionStore(createSQLiteCollection<McpActionRecord>(env.db, MCP_ACTION_TABLE), { now: () => clock });
  const registry = new InFlightRegistry(new LaneSemaphore());
  const readRecipe = vi.spyOn(recipeStore, 'get'), readRecipeIds = vi.spyOn(recipeStore, 'ids');
  const readAudit = vi.spyOn(auditLog, 'listRecent'), readMail = vi.spyOn(mail, 'get');
  const readEnrichment = vi.spyOn(enrichmentStore, 'getRowAsOf'), readAction = vi.spyOn(actions, 'getOwned');
  const verifyDoor = vi.spyOn(env.tokens, 'verifyBearer');
  const loadCollectionRecord = async (collection: string, id: string): Promise<TimelineEntry | null> => {
    if (collection !== 'mail') return null;
    const row = mail.get(id);
    return row ? { ts: row.received_at, source: 'mail', kind: 'record', payload: row } : null;
  };
  const clients = options.cli ? createClientTokenStore(env.db) : undefined;
  const deps: McpDeps = { db: env.db, recipeStore, executorConfig: { manifests: createManifestRegistry(join(dir, 'manifests')) },
    baseVault: {}, auditLog, contractOverlay: overlay, enrichmentStore, mcpActionStore: actions, inFlightRegistry: registry };
  const bundle = composeMcpHttpTransport({ executeDeps: deps, vaultStore: undefined, housekeepingStateStore: undefined,
    internalRegistry: undefined, clientTokens: clients, inboundTokenStore: env.tokens, loadCollectionRecord });
  if (!bundle) throw new Error('Fixture transport was not composed');
  const handler = createMcpPortHandler({ ...bundle.mcpHttpDeps, limiter: createRateLimiter({ capacity: 60, refill_window_ms: 60_000 }) });
  const server = createServer((req, res) => {
    void handler(req, res).catch(error => {
      serverErrors.push(error);
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Fixture server handler failed' }));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fixture has no loopback address');
  const url = 'http://127.0.0.1:' + address.port + '/mcp';
  const rpc = async (method: string, params: Record<string, unknown> = {}, bearer: string | null = door.bearer_plaintext): Promise<HttpReply> => {
    const requestParams = withModernMcpRequestMeta(params, { name: 'recued-http-lifecycle-test', version: '1' });
    const response = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(5_000),
      headers: { ...modernMcpHttpHeaders(method, requestParams), Accept: 'application/json', 'Content-Type': 'application/json',
        ...(bearer === null ? {} : { Authorization: 'Bearer ' + bearer }) },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params: requestParams }) });
    return { status: response.status, body: await response.json() as HttpReply['body'] };
  };
  const tool = (name: string, args: Record<string, unknown> = {}, bearer: string | null = door.bearer_plaintext) =>
    rpc('tools/call', { name, arguments: args }, bearer);
  const clearReads = () => { for (const spy of [readRecipe, readRecipeIds, readAudit, readMail, readEnrichment, readAction]) spy.mockClear(); };
  return { ...env, peer, contract, door, issueDoor, clients, actions, registry, rpc, tool, clearReads,
    readRecipe, readRecipeIds, readAudit, readMail, readEnrichment, readAction, verifyDoor,
    row: () => env.definitions.get(contract.contract_id), expire: () => { clock = initialTime + 60_001; } };
};
type Fixture = Awaited<ReturnType<typeof fixture>>;
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections(); await new Promise<void>(resolve => { server.close(() => resolve()); });
  }
  for (const drain of drains.splice(0)) await drain();
  vi.restoreAllMocks();
  for (const db of handles.splice(0)) if (db.open) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  expect(serverErrors.splice(0)).toEqual([]);
});
const result = (reply: HttpReply): RpcResult => {
  expect(reply.status).toBe(200); expect(reply.body.jsonrpc).toBe('2.0'); expect(reply.body.error).toBeUndefined();
  expect(reply.body.result).toBeDefined(); return reply.body.result!;
};
const text = (reply: HttpReply): string => {
  const body = result(reply); expect(body.isError).not.toBe(true);
  expect(body.content?.[0]?.text).toBeDefined(); return body.content![0].text;
};
const expectRefusal = (reply: HttpReply) => {
  expect(reply.status).toBe(200);
  expect(reply.body.error !== undefined || reply.body.result?.isError === true).toBe(true);
};
const expectNoBusinessReads = (f: Fixture) => {
  for (const spy of [f.readRecipe, f.readRecipeIds, f.readAudit, f.readMail, f.readEnrichment]) expect(spy).not.toHaveBeenCalled();
};

describe('authenticated HTTP MCP contract lifecycle', () => {
  it.each(['missing', 'tampered', 'revoked'] as const)('rejects %s bearer authority before reading data or charging a use', async kind => {
    const f = await fixture();
    expect(text(await f.tool('recued_getRecipe', { recipe_id: RECIPE.recipe_id }))).toContain(RECIPE.recipe_id);
    expect(f.verifyDoor).toHaveBeenCalled(); expect(f.row()?.uses_remaining).toBe(1);
    f.clearReads();
    let bearer: string | null = f.door.bearer_plaintext;
    if (kind === 'missing') bearer = null;
    else if (kind === 'tampered') bearer = bearer.slice(0, -1) + (bearer.endsWith('A') ? 'B' : 'A');
    else f.peer.tokens.revokeToken({ token_id: f.door.record.token_id, now: Date.now() });
    expect((await f.tool('recued_getRecipe', { recipe_id: RECIPE.recipe_id }, bearer)).status).toBe(401);
    expectNoBusinessReads(f); expect(f.row()?.uses_remaining).toBe(1);
  });

  it('authenticates an unbound CLI key while rejecting other client kinds and a revoked CLI key', async () => {
    const f = await fixture({ cli: true }), clients = f.clients!;
    const cli = await clients.issue({ client_kind: 'cli', client_label: 'HTTP fixture' });
    const bearer = cli.token_id + '.' + cli.bearer;
    expect(text(await f.tool('recued_getRecipe', { recipe_id: RECIPE.recipe_id }, bearer))).toContain(RECIPE.recipe_id);
    expect(f.row()?.uses_remaining).toBe(2); f.clearReads();
    const webclient = await clients.issue({ client_kind: 'webclient', client_label: 'Wrong HTTP surface' });
    expect((await f.tool('recued_getRecipe', { recipe_id: RECIPE.recipe_id }, webclient.token_id + '.' + webclient.bearer)).status).toBe(401);
    clients.revoke(cli.token_id, 'Owner revoked this fixture CLI');
    expect((await f.tool('recued_getRecipe', { recipe_id: RECIPE.recipe_id }, bearer)).status).toBe(401);
    expectNoBusinessReads(f); expect(f.row()?.uses_remaining).toBe(2);
  });

  describe.each(['metered', 'unmetered'] as const)('%s door', mode => {
    it.each(['revoked', 'expired', 'exhausted'] as const)('refuses a %s contract through real bearer authentication', async state => {
      const f = await fixture({ scope: { channels: ['mcp'], ...(mode === 'unmetered' ? { ingredient_ids: ['other-tool'] } : {}) } });
      expect(text(await f.tool('recued_getRecipe', { recipe_id: RECIPE.recipe_id }))).toContain(RECIPE.recipe_id);
      expect(f.row()?.uses_remaining).toBe(mode === 'metered' ? 1 : 2);
      if (state === 'revoked') f.peer.definitions.revoke(f.contract.contract_id, 'Owner closed this HTTP door');
      else if (state === 'expired') f.expire();
      else while ((f.row()?.uses_remaining ?? 0) > 0) expect(f.peer.definitions.reserveDispatchUse!(f.contract.contract_id)).not.toBeNull();
      const before = f.row(); f.clearReads();
      expectRefusal(await f.tool('recued_getRecipe', { recipe_id: RECIPE.recipe_id }));
      const names = result(await f.rpc('tools/list')).tools!.map(t => t.name);
      expect(names).not.toContain('recued_getRecipe'); expect(names).not.toContain('recued_listRecipes');
      expectNoBusinessReads(f); expect(f.row()).toEqual(before);
    });
  });

  it('refuses a missing bound definition without converting the authenticated door into an owner', async () => {
    const f = await fixture();
    expect(text(await f.tool('recued_getRecipe', { recipe_id: RECIPE.recipe_id }))).toContain(RECIPE.recipe_id);
    expect(f.peer.store.delete(CONTRACT_DEFINITION_SCOPE, [f.contract.contract_id])).toBe(true); f.clearReads();
    expectRefusal(await f.tool('recued_getRecipe', { recipe_id: RECIPE.recipe_id }));
    expect(result(await f.rpc('tools/list')).tools!.map(t => t.name)).not.toContain('recued_getRecipe');
    expectNoBusinessReads(f); expect(f.row()).toBeNull();
  });

  it('charges a final admitted call once and refuses the next HTTP call before reading', async () => {
    const f = await fixture({ maxUses: 1 });
    expect(text(await f.tool('recued_getRecipe', { recipe_id: RECIPE.recipe_id }))).toContain(RECIPE.recipe_id);
    expect(f.readRecipe).toHaveBeenCalledTimes(1); expect(f.row()?.uses_remaining).toBe(0);
    const before = f.row(); f.clearReads();
    expectRefusal(await f.tool('recued_getRecipe', { recipe_id: RECIPE.recipe_id }));
    expectNoBusinessReads(f); expect(f.row()).toEqual(before);
  });

  it('keeps an uncapped door unmetered while still enforcing its contract revocation', async () => {
    const f = await fixture({ maxUses: null });
    for (let i = 0; i < 2; i++) expect(text(await f.tool('recued_getRecipe', { recipe_id: RECIPE.recipe_id }))).toContain(RECIPE.recipe_id);
    expect(f.row()?.uses_remaining).toBeUndefined();
    f.peer.definitions.revoke(f.contract.contract_id, 'Owner closed this uncapped HTTP door'); const before = f.row(); f.clearReads();
    expectRefusal(await f.tool('recued_getRecipe', { recipe_id: RECIPE.recipe_id }));
    expectNoBusinessReads(f); expect(f.row()).toEqual(before);
  });

  it('observes live contract and checklist edits from another connection without changing their charging order', async () => {
    const f = await fixture({ maxUses: 3 });
    f.peer.grants.set(f.contract.contract_id, 'core.audit.read', true, Date.now());
    expect(text(await f.tool('recued_getAudit'))).toContain(AUDIT_MARKER); expect(f.row()?.uses_remaining).toBe(2);
    f.peer.grants.set(f.contract.contract_id, 'core.audit.read', false, Date.now());
    expectRefusal(await f.tool('recued_getAudit')); expect(f.row()?.uses_remaining).toBe(1);
    expect(f.readAudit).toHaveBeenCalledTimes(1);
    f.peer.grants.set(f.contract.contract_id, 'core.audit.read', true, Date.now());
    f.peer.tokens.updateTokenGrants({ token_id: f.door.record.token_id, now: Date.now(), grants: { ...f.door.record.grants, recued_getAudit: false } });
    expectRefusal(await f.tool('recued_getAudit')); expect(f.row()?.uses_remaining).toBe(1);
    expect(f.readAudit).toHaveBeenCalledTimes(1);
    f.peer.tokens.updateTokenGrants({ token_id: f.door.record.token_id, now: Date.now(), grants: f.door.record.grants });
    expect(text(await f.tool('recued_getAudit'))).toContain(AUDIT_MARKER);
    expect(f.readAudit).toHaveBeenCalledTimes(2); expect(f.row()?.uses_remaining).toBe(0);
  });

  it.each(['denied', 'absent', 'allowed'] as const)('keeps the %s audit grant on the final HTTP use', async grant => {
    const f = await fixture({ maxUses: 1 });
    if (grant !== 'absent') f.peer.grants.set(f.contract.contract_id, 'core.audit.read', grant === 'allowed', Date.now());
    const reply = await f.tool('recued_getAudit');
    if (grant === 'allowed') expect(text(reply)).toContain(AUDIT_MARKER);
    else expectRefusal(reply);
    expect(f.readAudit).toHaveBeenCalledTimes(Number(grant === 'allowed'));
    expect(f.grants.get(f.contract.contract_id, 'core.audit.read')).toBe(grant === 'absent' ? undefined : grant === 'allowed');
    expect(f.row()?.uses_remaining).toBe(0);
  });

  it.each([false, true])('keeps collection grant %s through the final authenticated timeline call', async granted => {
    const f = await fixture({ maxUses: 1 });
    f.peer.grants.set(f.contract.contract_id, 'core.memory.timeline.read', true, Date.now());
    f.peer.grants.set(f.contract.contract_id, 'data.mail', granted, Date.now());
    const payload = JSON.parse(text(await f.tool('recued_dataTimeline', { entity_id: 'mail:fixture-mail' })));
    expect(f.readMail).toHaveBeenCalledTimes(Number(granted));
    if (granted) expect(JSON.stringify(payload.entries)).toContain(MAIL_MARKER);
    else expect(payload.entries).toEqual([]);
    expect(f.row()?.uses_remaining).toBe(0);
  });

  it.each([false, true])('keeps topic grant %s through the final authenticated enrichment call', async granted => {
    const f = await fixture({ maxUses: 1 });
    f.peer.grants.set(f.contract.contract_id, 'core.data.enrichment.read', true, Date.now());
    f.peer.grants.set(f.contract.contract_id, 'enrichment.contact_timeline_rollup', granted, Date.now());
    const reply = await f.tool('recued_enrichmentRead', { topic: 'contact_timeline_rollup', scope: 'contact', target_id: 'fixture-contact', include_stale: true });
    if (granted) { expect(text(reply)).toContain(TOPIC_MARKER); expect(f.readEnrichment).toHaveBeenCalled(); }
    else { expectRefusal(reply); expect(f.readEnrichment).not.toHaveBeenCalled(); }
    expect(f.row()?.uses_remaining).toBe(0);
  });

  it('retains same-token status and stop after contract revocation, with principal isolation and token revocation still enforced', async () => {
    const f = await fixture(), other = f.issueDoor(), abort = vi.fn();
    const action = await f.actions.createHeld({ run_id: 'http-action-run', principal_id: f.door.record.token_id,
      tool_name: 'recued_runRecipe', kind: 'recipe', checkpoint_id: 'http-checkpoint' });
    await f.actions.finish('http-action-run', { status: 'completed', result: { marker: 'http-owned-result' }, status_message: 'Completed.' });
    f.registry.registerRun({ run_id: 'http-running-run', recipe_id: RECIPE.recipe_id, started_at: Date.now(), origin: 'attended', abort,
      source: { channel: 'mcp', actor: 'contracted_user', agent_id: 'inbound_' + f.door.record.token_id,
        tool_call_id: 'http-fixture-call', mcp_token_id: f.door.record.token_id, contract_id: f.contract.contract_id } });
    f.peer.definitions.revoke(f.contract.contract_id, 'Owner closed this HTTP door'); const before = f.row(); f.clearReads();
    expect(result(await f.rpc('tools/list')).tools!.map(t => t.name).sort()).toEqual(['recued_actionStatus', 'recued_stopRecipe']);
    expectRefusal(await f.tool('recued_actionStatus', { action_ref: action.action_ref }, other.bearer_plaintext));
    expect(JSON.parse(text(await f.tool('recued_stopRecipe', { run_id: 'http-running-run' }, other.bearer_plaintext))).status).toBe('not_found');
    expect(abort).not.toHaveBeenCalled();
    const owned = JSON.parse(text(await f.tool('recued_actionStatus', { action_ref: action.action_ref })));
    expect(owned).toMatchObject({ action_ref: action.action_ref, status: 'completed', result: { marker: 'http-owned-result' } });
    expect(JSON.parse(text(await f.tool('recued_stopRecipe', { run_id: 'http-running-run' }))).status).toBe('stopped');
    expect(abort).toHaveBeenCalledOnce(); const actionReads = f.readAction.mock.calls.length;
    f.peer.tokens.revokeToken({ token_id: f.door.record.token_id, now: Date.now() });
    expect((await f.tool('recued_actionStatus', { action_ref: action.action_ref })).status).toBe(401);
    expect((await f.tool('recued_stopRecipe', { run_id: 'http-running-run' })).status).toBe(401);
    expect(f.readAction).toHaveBeenCalledTimes(actionReads); expect(abort).toHaveBeenCalledOnce();
    expectNoBusinessReads(f); expect(f.row()).toEqual(before);
  });
});
