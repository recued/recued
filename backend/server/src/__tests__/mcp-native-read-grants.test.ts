import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { D165_CONTRACT_SCHEMA, type TimelineEntry } from '@recued/contracts';
import { buildAuditEntry, createAuditLogStore, type AuditEntry, type ActivityEntry } from '@recued/storage';
import { createMcpHttpDispatch, type McpDeps } from '../mcp-server.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { createRecipeStore } from '../recipe-store.js';
import { createContractOverlayResolver } from '../policy-contract-overlay.js';
import { createContractDefinitionStore } from '../storage/contract-definition-store.js';
import { createContractStore } from '../storage/contract-store.js';
import { createContractGrantEntryStore } from '../storage/contract-grant-entry-store.js';
import { createEnrichmentStore } from '../storage/enrichment-store.js';
import { createSQLiteCollection } from '../sqlite-collection.js';

const NOW = 1_700_000_000_000;
const AUDIT_MARKER = 'native-read-audit-fixture';
const handles: Database.Database[] = [];
const dirs: string[] = [];
const fixture = async (grant: boolean | 'absent' = true, maxUses: number | null = 1) => {
  const dir = mkdtempSync(join(tmpdir(), 'recued-native-read-')); dirs.push(dir);
  const file = join(dir, 'realm.sqlite');
  let clock = NOW;
  const open = () => {
    const db = new Database(file); handles.push(db); db.pragma('journal_mode = WAL');
    const store = createContractStore(db, { now: () => clock }); store.seedSchema(D165_CONTRACT_SCHEMA);
    return { db, grants: createContractGrantEntryStore(store), definitions: createContractDefinitionStore(store, { now: () => clock }) };
  };
  const env = open(), peer = open();
  const contract = env.definitions.mint({ minted_by: 'owner', display_name: 'Native read fixture', scope: { channels: ['mcp'] },
    door_types: ['mcp'], expiry_at: NOW + 60_000, ...(maxUses === null ? {} : { max_uses: maxUses }) });
  if (grant !== 'absent') env.grants.set(contract.contract_id, 'core.audit.read', grant, NOW);
  const overlay = createContractOverlayResolver({ definitionStore: env.definitions, grantEntryStore: env.grants, now: () => clock });
  const auditLog = createAuditLogStore(createSQLiteCollection<AuditEntry>(env.db, 'audit_entries'), createSQLiteCollection<ActivityEntry>(env.db, 'audit_activities'));
  await auditLog.append(buildAuditEntry({ run_id: AUDIT_MARKER, recipe_id: 'fixture-recipe', recipe_hash: 'fixture-hash',
    commit_status: 'succeeded', duration_ms: 1, errors: [], now: NOW }));
  const nativeReadAudit = auditLog.listRecent.bind(auditLog);
  const readAudit = vi.spyOn(auditLog, 'listRecent');
  const deps: McpDeps = {
    recipeStore: createRecipeStore(join(dir, 'recipes')), executorConfig: { manifests: createManifestRegistry(join(dir, 'manifests')) },
    baseVault: {}, auditLog, mcpTokenId: 'http_native_read_fixture', agentId: 'fixture-agent', boundContractId: contract.contract_id,
    boundContractActive: overlay.isContractLive(contract.contract_id), inboundTokenAuthorize: () => true, contractOverlay: overlay,
  };
  const afterTake = (change: () => void) => {
    const take = overlay.takeDispatchUse!.bind(overlay);
    vi.spyOn(overlay, 'takeDispatchUse').mockImplementation((...args) => {
      const result = take(...args); expect(result.kind).toBe('taken'); change(); return result;
    });
  };
  return { ...env, peer, contract, overlay, deps, readAudit, nativeReadAudit, afterTake,
    expire: () => { clock = NOW + 60_001; }, row: () => env.definitions.get(contract.contract_id) };
};
afterEach(() => {
  vi.restoreAllMocks();
  for (const db of handles.splice(0)) if (db.open) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Reply = { error?: unknown; result: { isError?: boolean; content: Array<{ text: string }> } };
const call = async (deps: McpDeps, tool = 'recued_getAudit', args: Record<string, unknown> = {}) =>
  await createMcpHttpDispatch(deps)({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } }) as Reply;
const expectAudit = (reply: Reply) => {
  expect(reply.error).toBeUndefined(); expect(reply.result.isError).not.toBe(true);
  expect(reply.result.content[0].text).toContain(AUDIT_MARKER);
};

describe('native MCP reads retain their final-use contract', () => {
  it.each([false, 'absent'] as const)('refuses the final audit read when its grant is %s', async grant => {
    const f = await fixture(grant);
    const reply = await call(f.deps);
    expect(reply.result.isError).toBe(true);
    expect(f.readAudit).not.toHaveBeenCalled();
    expect(f.grants.get(f.contract.contract_id, 'core.audit.read')).toBe(grant === 'absent' ? undefined : grant);
    expect(f.row()?.uses_remaining).toBe(0);
  });

  it('admits a granted final audit read once and refuses a fresh call', async () => {
    const f = await fixture();
    expectAudit(await call(f.deps));
    expect(f.readAudit).toHaveBeenCalledTimes(1); expect(f.row()?.uses_remaining).toBe(0);
    expect((await call(f.deps)).result.isError).toBe(true);
    expect(f.readAudit).toHaveBeenCalledTimes(1); expect(f.row()?.uses_remaining).toBe(0);
  });

  it.each([2, null])('keeps audit denials on a %s-use contract', async cap => {
    const f = await fixture(false, cap);
    expect((await call(f.deps)).result.isError).toBe(true);
    expect(f.readAudit).not.toHaveBeenCalled();
    expect(f.row()?.uses_remaining).toBe(cap === null ? undefined : 1);
  });

  it('preserves an unbound owner read without consuming another contract\'s budget', async () => {
    const f = await fixture(false);
    const { boundContractId, boundContractActive, ...unbound } = f.deps;
    expectAudit(await call(unbound)); expect(f.row()?.uses_remaining).toBe(1);
  });

  it.each(['revoked', 'expired', 'definition-changed'] as const)('refuses a reserved read when its contract is %s', async state => {
    const f = await fixture();
    let changedRow: ReturnType<typeof f.row>;
    f.afterTake(() => {
      if (state === 'revoked') f.peer.definitions.revoke(f.contract.contract_id, 'Owner closed this door');
      else if (state === 'expired') f.expire();
      else f.peer.definitions.setReadSpheres(f.contract.contract_id, ['personal']);
      changedRow = f.row();
    });
    const reply = await call(f.deps);
    const after = f.row();
    expect(reply.result.isError).toBe(true); expect(f.readAudit).not.toHaveBeenCalled();
    expect(after?.uses_remaining).toBe(0);
    if (state === 'revoked') expect(after).toMatchObject({ revoked_at: NOW, revocation_reason: 'Owner closed this door' });
    expect(after).toEqual(changedRow!);
  });

  it.each([false, true])('reads the current audit grant when it changes to %s', async granted => {
    const f = await fixture(!granted);
    f.afterTake(() => f.peer.grants.set(f.contract.contract_id, 'core.audit.read', granted, NOW + 1));
    const reply = await call(f.deps);
    if (granted) expectAudit(reply);
    else expect(reply.result.isError).toBe(true);
    expect(f.readAudit).toHaveBeenCalledTimes(Number(granted)); expect(f.row()?.uses_remaining).toBe(0);
    expect(f.grants.get(f.contract.contract_id, 'core.audit.read')).toBe(granted);
  });

  it('does not carry reservation authority into the native body or another dispatch', async () => {
    const f = await fixture();
    const bodyLiveness: boolean[] = [];
    f.readAudit.mockImplementation(async (...args) => {
      bodyLiveness.push(f.overlay.isContractLive(f.contract.contract_id));
      expect((await call(f.deps)).result.isError).toBe(true);
      return f.nativeReadAudit(...args);
    });
    expectAudit(await call(f.deps));
    expect(bodyLiveness).toEqual([false]); expect(f.readAudit).toHaveBeenCalledTimes(1);
    expect(f.overlay.isContractLive(f.contract.contract_id)).toBe(false);
  });

  it.each([false, true])('keeps the collection grant %s for the final timeline read', async granted => {
    const f = await fixture();
    f.grants.set(f.contract.contract_id, 'core.memory.timeline.read', true, NOW);
    f.grants.set(f.contract.contract_id, 'data.mail', granted, NOW);
    const entry: TimelineEntry = { ts: NOW, source: 'mail', kind: 'record', payload: { marker: 'native-mail-fixture' } };
    const loadCollectionRecord = vi.fn(async () => entry);
    const reply = await call({ ...f.deps, loadCollectionRecord }, 'recued_dataTimeline', { entity_id: 'mail:fixture-mail' });
    expect(reply.result.isError).not.toBe(true);
    expect(JSON.parse(reply.result.content[0].text).entries).toEqual(granted ? [entry] : []);
    expect(loadCollectionRecord).toHaveBeenCalledTimes(Number(granted)); expect(f.row()?.uses_remaining).toBe(0);
  });

  it.each([false, true])('keeps the topic grant %s for the final enrichment read', async granted => {
    const f = await fixture();
    f.grants.set(f.contract.contract_id, 'core.data.enrichment.read', true, NOW);
    f.grants.set(f.contract.contract_id, 'enrichment.contact_timeline_rollup', granted, NOW);
    const enrichmentStore = createEnrichmentStore(f.db, { now: () => NOW });
    enrichmentStore.upsert({ topic: 'contact_timeline_rollup', scope: 'contact', target_id: 'fixture-contact', authored_by: 'fixture-recipe',
      value: { interaction_count: 1, last_interaction: NOW, recent_subjects: ['native-topic-fixture'], cursor_at: NOW, window_ms: 30 * 24 * 60 * 60 * 1000 } });
    const read = vi.spyOn(enrichmentStore, 'getRowAsOf');
    const reply = await call({ ...f.deps, enrichmentStore }, 'recued_enrichmentRead', {
      topic: 'contact_timeline_rollup', scope: 'contact', target_id: 'fixture-contact', include_stale: true,
    });
    if (granted) {
      expect(reply.result.isError).not.toBe(true); expect(reply.result.content[0].text).toContain('native-topic-fixture');
      expect(read).toHaveBeenCalled();
    } else {
      expect(reply.result.isError).toBe(true); expect(read).not.toHaveBeenCalled();
    }
    expect(f.row()?.uses_remaining).toBe(0);
  });
});
