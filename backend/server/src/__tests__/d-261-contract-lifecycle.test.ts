import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createContractStore } from '../storage/contract-store.js';
import { createCliReachabilityStore } from '../storage/cli-reachability-store.js';
import { createContractDefinitionStore } from '../storage/contract-definition-store.js';
import { collectPreapprovalContractReads, readPreapprovalContractQuery,
  withPreapprovalContractProjection, PREAPPROVAL_PACK_RESOLUTION_QUERY } from '../storage/preapproval-contract-reads.js';
import { createContractGrantStore } from '../storage/contract-grant-store.js';
import { registerPreapprovalInvalidator, synchronizePreapprovalIdentity } from '../storage/preapproval-lifecycle.js';
import { createLocalManifestStore } from '../ingredient-authoring/local-manifest-store.js';
import type { IngredientManifest } from '@recued/contracts';
import { preparedPlan, repositoryFixture } from './d-261-fixtures.js';

const databases: Database.Database[] = []; const directories: string[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const open = (path = ':memory:') => {
  const db = new Database(path); databases.push(db);
  const store = createContractStore(db); const reach = createCliReachabilityStore(store);
  const { repository } = repositoryFixture(db);
  registerPreapprovalInvalidator(db, (kind, key, incarnation) => repository.invalidateDependency(kind, key, incarnation));
  const prepare = async (read: () => unknown) => {
    const captured = db.transaction(() => collectPreapprovalContractReads(db, read)).immediate();
    const plan = preparedPlan(); plan.dependencies.push(...captured.dependencies);
    const proposal = await repository.prepare(plan, false);
    return { proposal, dependencies: captured.dependencies };
  };
  return { db, store, reach, repository, prepare };
};

describe('D-261 actual contract-read lifecycle', () => {
  it.each(['remove_restore', 'edit_restore'] as const)('observes a persisted manifest writer and its rollback across connections: %s', async change => {
    const dir = mkdtempSync(join(tmpdir(), 'd261-manifest-')); directories.push(dir);
    const a = open(join(dir, 'realm.sqlite')); const b = open(join(dir, 'realm.sqlite'));
    const manifestsA = createLocalManifestStore(a.db); const manifestsB = createLocalManifestStore(b.db);
    const manifest: IngredientManifest = { slug: 'persisted-review', name: 'Reviewed catalog', description: 'Lifecycle fixture',
      version: 2, author: 'fixture', kind: 'connection', category: 'data', risk_tier: 'read', input: {}, output: {} };
    manifestsA.put({ manifest, entity_schemas: [] });
    const identity = a.db.transaction(() => synchronizePreapprovalIdentity(a.db, 'installed_manifest', manifest.slug,
      manifestsA.getManifest(manifest.slug))).immediate()!;
    const plan = preparedPlan();
    plan.dependencies.push({ kind: identity.kind, key: identity.key, incarnation: identity.incarnation,
      revision: identity.revision, content_hash: identity.content_hash, until_phase: 'terminal' });
    const proposal = await a.repository.prepare(plan, false);
    // A non-winning historical version does not alter the reviewed dispatch.
    manifestsB.put({ manifest: { ...manifest, version: 1 }, entity_schemas: [] });
    expect(() => b.db.transaction(() => { manifestsB.delete(manifest.slug); throw new Error('rollback'); }).immediate()).toThrow('rollback');
    expect(manifestsA.getManifest(manifest.slug)).toEqual(manifest);
    expect((await a.repository.inspect(proposal.proposal_id)).execution_status).toBe('prepared');
    if (change === 'remove_restore') manifestsB.delete(manifest.slug);
    else manifestsB.put({ manifest: { ...manifest, description: 'Changed binding definition' }, entity_schemas: [] });
    manifestsB.put({ manifest, entity_schemas: [] });
    expect(manifestsA.getManifest(manifest.slug)).toEqual(manifest);
    expect((await a.repository.inspect(proposal.proposal_id)).execution_status).toBe('invalidated');
  });

  it('pins pack grants for the actual connection, including absent matches and a second writer', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'd261-projected-grants-')); directories.push(dir);
    const a = open(join(dir, 'realm.sqlite')); const b = open(join(dir, 'realm.sqlite'));
    const grantsA = createContractGrantStore(a.store); const grantsB = createContractGrantStore(b.store);
    const captured = await a.prepare(() => grantsA.listPackOwnedGroups('vendor.with.dots', 'account%one'));
    grantsB.grantPackGroup('unrelated', 'another-vendor', 'account%one', 'write');
    grantsB.removePackGroups('unrelated');
    grantsB.grantPackGroup('other-account', 'vendor.with.dots', 'account%two', 'write');
    expect((await a.repository.inspect(captured.proposal.proposal_id)).execution_status).toBe('prepared');
    grantsB.grantPackGroup('actual', 'vendor.with.dots', 'account%one', 'write');
    grantsB.removePackGroups('actual');
    expect((await a.repository.inspect(captured.proposal.proposal_id)).execution_status).toBe('invalidated');
  });

  it('pins only queried pack refs and observes temporary alias collisions', async () => {
    const f = open();
    const captured = await f.prepare(() => withPreapprovalContractProjection('installed_pack',
      { scope: PREAPPROVAL_PACK_RESOLUTION_QUERY, segments: ['publisher.actual'], exact: true }, () => f.store.scan('installed_pack', [])));
    f.store.put('installed_pack', ['other'], { pack_slug: 'other', version: '1', publisher: 'publisher', installed_at: 1 });
    f.store.delete('installed_pack', ['other']);
    expect((await f.repository.inspect(captured.proposal.proposal_id)).execution_status).toBe('prepared');
    f.store.put('installed_pack', ['generated-catalog'], { pack_slug: 'generated-catalog', version: '1', publisher: 'publisher', authored_pack_slug: 'actual', installed_at: 1 });
    f.store.delete('installed_pack', ['generated-catalog']);
    expect((await f.repository.inspect(captured.proposal.proposal_id)).execution_status).toBe('invalidated');
  });
  it('survives reopening and observes revoke/regrant through a second realm store connection', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'd261-authority-')); directories.push(dir);
    const a = open(join(dir, 'realm.sqlite'));
    a.reach.allow('user_self', 'a.b%', 'op.with.dots', 1);
    const captured = await a.prepare(() => a.reach.isAllowed('user_self', 'a.b%', 'op.with.dots'));
    const b = open(join(dir, 'realm.sqlite'));
    b.reach.deny('user_self', 'a.b%', 'op.with.dots');
    b.reach.allow('user_self', 'a.b%', 'op.with.dots', 1);
    expect((await a.repository.inspect(captured.proposal.proposal_id)).execution_status).toBe('invalidated');
    const current = b.db.transaction(() => readPreapprovalContractQuery(b.db, captured.dependencies[0]!.key)).immediate();
    expect(current!.revision).toBeGreaterThan(captured.dependencies[0]!.revision);
  });

  it('keeps exact query boundaries and rolls back authority invalidation with the writer', async () => {
    const f = open(); f.reach.allow('user_self', 'tool', 'write', 1);
    const captured = await f.prepare(() => f.reach.isAllowed('user_self', 'tool', 'write'));
    f.reach.allow('user_self', 'tool-other', 'write', 1);
    expect((await f.repository.inspect(captured.proposal.proposal_id)).execution_status).toBe('prepared');
    expect(() => f.store.transaction(() => {
      f.reach.deny('user_self', 'tool', 'write'); throw new Error('rollback');
    })).toThrow('rollback');
    expect(f.reach.isAllowed('user_self', 'tool', 'write')).toBe(true);
    expect((await f.repository.inspect(captured.proposal.proposal_id)).execution_status).toBe('prepared');
  });

  it('tracks absent prefix reads so temporary insertion/removal cannot disappear between checks', async () => {
    const f = open();
    const captured = await f.prepare(() => f.store.scan('cli_reachability', ['user_self', 'tool']));
    f.reach.allow('user_self', 'toolbox', 'write', 1);
    expect((await f.repository.inspect(captured.proposal.proposal_id)).execution_status).toBe('prepared');
    f.reach.allow('user_self', 'tool', 'write', 1); f.reach.deny('user_self', 'tool', 'write');
    expect((await f.repository.inspect(captured.proposal.proposal_id)).execution_status).toBe('invalidated');
  });

  it('keeps atomic use reservations separate from contract identity but seals an actual revoke', async () => {
    const f = open(); const definitions = createContractDefinitionStore(f.store);
    const definition = definitions.mint({ minted_by: 'owner', display_name: 'Reviewed driver', door_types: ['mcp'], max_uses: 2,
      scope: { channels: ['mcp'], actors: ['contracted_user'] } });
    const captured = await f.prepare(() => definitions.get(definition.contract_id));
    expect(definitions.reserveDispatchUse!(definition.contract_id)?.after.uses_remaining).toBe(1);
    expect((await f.repository.inspect(captured.proposal.proposal_id)).execution_status).toBe('prepared');
    definitions.revoke(definition.contract_id, 'owner revoked');
    f.store.put('contract_definition', [definition.contract_id], definition);
    expect((await f.repository.inspect(captured.proposal.proposal_id)).execution_status).toBe('invalidated');
  });
});
