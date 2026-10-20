import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PERMISSION_REGRESSION_LIMITS as LIMIT, parsePermissionDocument } from '@recued/contracts';
import { resourceFixtureDisposers } from './preapproval-resources-fixture.js';
import { permissionFixture } from './permission-regression-fixture.js';
import { kernelOpForBackingSlug, ENRICHMENT_REGISTRY } from '@recued/contracts';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createConnectionCatalogBindingStore } from '../storage/connection-catalog-binding-store.js';
import { createPermissionRegressionStore } from '../storage/permission-regression-store.js';
import { permissionRegressionImpact } from '../permission-regression-impact.js';

afterEach(async () => { vi.restoreAllMocks(); for (const dispose of resourceFixtureDisposers.splice(0).reverse()) await dispose(); });
it('compares real admission and read defaults without dispatch, grant changes or use consumption', async () => {
  const f = await permissionFixture();
  const before = f.grants.listForContract(f.contract.contract_id), uses = f.definitions.get(f.contract.contract_id)!.uses_remaining;
  const saved = await f.save(), tested = await f.store.test({ contract_id: f.contract.contract_id, expected_revision: saved.revision, draft_revision: saved.draft!.revision }, f.actor, f.check);
  expect(tested.comparison.cases.map(item => [item.current.verdict, item.candidate.verdict])).toEqual([['ask', 'ask'], ['ask', 'deny'], ['deny', 'allow']]);
  expect(tested.comparison.passed).toBe(3); expect(tested.qualification).not.toBeNull();
  expect(f.grants.listForContract(f.contract.contract_id)).toEqual(before); expect(f.definitions.get(f.contract.contract_id)!.uses_remaining).toBe(uses);
  expect(f.calendarUpdates).not.toHaveBeenCalled(); expect(f.calendarDeletes).not.toHaveBeenCalled();
  expect(tested.comparison.impact.entries).toContainEqual(expect.objectContaining({ kind: 'trigger', id: 'bound-trigger' }));
  expect(JSON.stringify(f.db.prepare('SELECT * FROM permission_regression_tracks').all())).not.toContain('Private permission scenarios');
});
it('requires passing examples and an exact owner review, then atomically writes grants and retained history', async () => {
  const f = await permissionFixture(), { request, review } = await f.ready();
  expect(review.changes).toContainEqual({ entry_key: 'data.task', before: false, after: null });
  const activated = await f.store.activate(request, f.actor, f.check);
  expect(activated.activated?.sequence).toBe(2); expect(f.grants.get(f.contract.contract_id, f.remove)).toBe(false);
  expect(f.grants.get(f.contract.contract_id, 'data.task')).toBeUndefined(); expect(activated.qualification).toBeNull();
  const retry = await f.store.activate(request, f.actor, f.check); expect(retry.activated).toEqual(activated.activated); expect(retry.mutation_revision).toBe(activated.mutation_revision);
  await expect(f.store.activate({ ...request, review_id: 'forged' }, f.actor, f.check)).rejects.toMatchObject({ code: 'permission_regression_conflict' });
  expect(f.calendarDeletes).not.toHaveBeenCalled();
});
it('restores historical grants as a fresh unqualified draft and preserves live grants until a new decision', async () => {
  const f = await permissionFixture(), { request } = await f.ready(); const active = await f.store.activate(request, f.actor, f.check);
  const restored = await f.store.save({ contract_id: f.contract.contract_id, expected_revision: active.revision, expected_live_digest: active.live_digest,
    request_id: randomUUID(), sequence: 1 }, f.actor, f.check);
  expect(restored.qualification).toBeNull(); expect(restored.saved_draft!.document.changes).toContainEqual({ entry_key: f.remove, granted: true });
  expect(f.grants.get(f.contract.contract_id, f.remove)).toBe(false);
  const doc = restored.saved_draft!.document; doc.cases[1]!.expected = 'ask'; doc.cases[2]!.expected = 'deny';
  const saved = await f.store.save({ contract_id: f.contract.contract_id, expected_revision: restored.revision, expected_live_digest: restored.live_digest,
    request_id: randomUUID(), document: doc }, f.actor, f.check);
  const tested = await f.store.test({ contract_id: f.contract.contract_id, expected_revision: saved.revision, draft_revision: saved.draft!.revision }, f.actor, f.check);
  expect(tested.qualification).not.toBeNull();
});
for (const drift of ['grant', 'grant-aba', 'credential', 'binding', 'definition', 'manifest', 'realm', 'owner', 'review-expiry', 'proof-expiry'] as const) it(`refuses stale activation after ${drift}`, async () => {
  const f = await permissionFixture(), { request } = await f.ready(); const original = f.grants.listForContract(f.contract.contract_id);
  if (drift === 'grant' || drift === 'grant-aba') { f.grants.set(f.contract.contract_id, f.update, false, f.clock.now); if (drift === 'grant-aba') f.grants.set(f.contract.contract_id, f.update, true, f.clock.now); }
  if (drift === 'credential') f.inbound.revokeToken({ token_id: f.credential.token_id, now: f.clock.now });
  if (drift === 'binding') f.inbound.updateTokenContract({ token_id: f.credential.token_id, contract_id: 'another-contract', now: f.clock.now });
  if (drift === 'definition') f.definitions.revoke(f.contract.contract_id, 'revoked');
  if (drift === 'manifest') f.manifests.register({ ...f.manifests.get('calendar-update')!, version: 2 });
  if (drift === 'realm') f.db.prepare('UPDATE preapproval_state SET lineage=? WHERE singleton=1').run(randomUUID());
  if (drift === 'owner') f.clients.revoke(f.token.token_id, 'revoked', f.clock.now);
  if (drift === 'review-expiry') f.clock.now += LIMIT.review_ms + 1;
  if (drift === 'proof-expiry') f.clock.now += LIMIT.qualification_ms + 1;
  await expect(f.store.activate(request, f.actor, f.check)).rejects.toThrow();
  expect(f.grants.get(f.contract.contract_id, f.remove)).toBe(original.find(item => item.entry_key === f.remove)!.granted);
});
it('keeps another paired client from using the passing proof or review', async () => {
  const f = await permissionFixture(), { request, saved } = await f.ready();
  expect((await f.store.read(f.contract.contract_id, 'another-pair', f.check)).qualification).toBeNull();
  await expect(f.store.prepare({ contract_id: f.contract.contract_id, expected_revision: saved.revision, draft_revision: saved.draft!.revision, receipt_id: 'copied' }, 'another-pair', f.check)).rejects.toThrow();
  await expect(f.store.activate(request, 'another-pair', f.check)).rejects.toThrow();
});
it('invalidates old proof before a newer test can fail while opening private cases', async () => {
  const f = await permissionFixture(), { saved, request } = await f.ready();
  vi.spyOn(f.codec, 'open').mockRejectedValueOnce(new Error('Interrupted private read'));
  await expect(f.store.test({ contract_id: f.contract.contract_id, expected_revision: saved.revision, draft_revision: saved.draft!.revision }, f.actor, f.check)).rejects.toThrow();
  expect((await f.store.read(f.contract.contract_id, f.actor, f.check)).qualification).toBeNull();
  await expect(f.store.activate(request, f.actor, f.check)).rejects.toThrow();
});
it('leaves failing and unsupported examples unqualified rather than treating them as safe denials', async () => {
  const f = await permissionFixture(), doc = f.document(); doc.cases[0]!.target = { kind: 'operation', ingredient: 'missing', input: {} }; doc.cases[0]!.expected = 'deny';
  const saved = await f.save(doc), result = await f.store.test({ contract_id: f.contract.contract_id, expected_revision: saved.revision, draft_revision: saved.draft!.revision }, f.actor, f.check);
  expect(result.comparison.cases[0]?.candidate.verdict).toBe('unsupported'); expect(result.qualification).toBeNull();
});
it('rechecks the paired owner and policy after asynchronous encryption', async () => {
  const f = await permissionFixture(), saved = await f.save(); const seal = f.codec.seal.bind(f.codec);
  vi.spyOn(f.codec, 'seal').mockImplementationOnce(async value => { const sealed = await seal(value); f.grants.set(f.contract.contract_id, f.update, false, f.clock.now); return sealed; });
  await expect(f.store.test({ contract_id: f.contract.contract_id, expected_revision: saved.revision, draft_revision: saved.draft!.revision }, f.actor, f.check)).rejects.toThrow();
  expect((await f.store.read(f.contract.contract_id, f.actor, f.check)).qualification).toBeNull();
});
it('rolls every grant and the history back if the atomic finalizer fails', async () => {
  const f = await permissionFixture(), { request } = await f.ready(), before = f.grants.listForContract(f.contract.contract_id);
  const prepare = f.db.prepare.bind(f.db);
  vi.spyOn(f.db, 'prepare').mockImplementation((sql: string) => { if (sql.includes('INSERT INTO permission_regression_tracks')) throw new Error('Injected finalizer failure'); return prepare(sql); });
  await expect(f.store.activate(request, f.actor, f.check)).rejects.toThrow('Injected');
  expect(f.grants.listForContract(f.contract.contract_id)).toEqual(before);
  vi.restoreAllMocks(); expect((await f.store.read(f.contract.contract_id, f.actor, f.check)).history).toHaveLength(1);
});
it('recovers the same activation receipt after reopening without applying it again', async () => {
  const f = await permissionFixture(), { request } = await f.ready(), first = await f.store.activate(request, f.actor, f.check);
  const reopened = await f.reopenPermissions();
  const second = await reopened.store.activate(request, f.actor, () => {}); expect(second.activated).toEqual(first.activated);
  expect(reopened.grants.get(f.contract.contract_id, f.remove)).toBe(false);
});
it('purges private tests with a monotonic deletion tombstone and rejects stale writes', async () => {
  const f = await permissionFixture(), saved = await f.save(), requestId = randomUUID();
  const deleted = await f.store.delete(f.contract.contract_id, saved.revision, requestId, f.actor, f.check);
  expect(await f.store.delete(f.contract.contract_id, saved.revision, requestId, f.actor, f.check)).toEqual(deleted);
  const read = await f.store.read(f.contract.contract_id, f.actor, f.check); expect(read.draft).toBeNull(); expect(read.revision).toBe(deleted.revision);
  await expect(f.store.save({ contract_id: f.contract.contract_id, expected_revision: saved.revision, expected_live_digest: read.live_digest, request_id: randomUUID(), document: f.document() }, f.actor, f.check)).rejects.toThrow();
  expect((await f.save()).revision).toBe(deleted.revision + 1);
});
it('bounds and closes authoring input, including forged authority and result fields', async () => {
  const f = await permissionFixture();
  expect(() => parsePermissionDocument({ ...f.document(), outcome: 'allow' })).toThrow();
  expect(() => parsePermissionDocument({ ...f.document(), cases: [{ ...f.document().cases[0], source: { actor: 'user_self' } }] })).toThrow();
  const doc = f.document(); doc.changes.push({ ...doc.changes[0]! }); expect(() => parsePermissionDocument(doc)).toThrow();
  const privateGrant = f.document(); privateGrant.changes[0] = { entry_key: 'recipe.core/other', granted: true };
  await expect(f.save(privateGrant)).rejects.toMatchObject({ code: 'permission_regression_unsupported' });
});

it('applies the ordinary operation read fence and independent topic grants', async () => {
  const f = await permissionFixture(), doc = f.document(), email = kernelOpForBackingSlug('email-list')!, topic = Object.keys(ENRICHMENT_REGISTRY)[0]!;
  f.grants.set(f.contract.contract_id, email, true, f.clock.now);
  f.inbound.updateTokenGrants({ token_id: f.credential.token_id, grants: { ...f.credential.grants, [email]: true }, now: f.clock.now });
  doc.changes.push({ entry_key: 'data.mail', granted: false }, { entry_key: 'enrichment.' + topic, granted: false });
  doc.cases.push({ id: 'mail', name: 'Mailbox read withheld', credential_id: f.credential.token_id, expected: 'deny', target: { kind: 'operation', ingredient: 'email-list', input: { slug: 'work', metadata_only: true } } },
    { id: 'topic', name: 'Topic withheld', credential_id: f.credential.token_id, expected: 'deny', target: { kind: 'topic', topic } });
  const saved = await f.save(doc), result = await f.store.test({ contract_id: f.contract.contract_id, expected_revision: saved.revision, draft_revision: saved.draft!.revision }, f.actor, f.check);
  expect(result.comparison.cases.find(item => item.id === 'mail')).toMatchObject({ current: { verdict: 'allow' }, candidate: { verdict: 'deny' } });
  expect(result.qualification).not.toBeNull();
});
it('never lends a case a bearer permission that the selected credential lacks', async () => {
  const f = await permissionFixture(), doc = f.document();
  f.inbound.updateTokenGrants({ token_id: f.credential.token_id, grants: {}, now: f.clock.now });
  doc.cases[0]!.expected = 'ask'; const saved = await f.save(doc);
  const result = await f.store.test({ contract_id: f.contract.contract_id, expected_revision: saved.revision, draft_revision: saved.draft!.revision }, f.actor, f.check);
  expect(result.comparison.cases[0]).toMatchObject({ current: { verdict: 'deny' }, candidate: { verdict: 'deny' }, passed: false });
  expect(result.qualification).toBeNull();
});
it('preserves source-pack ownership and timestamps for unchanged explicit grant values', async () => {
  const f = await permissionFixture(); f.grants.set(f.contract.contract_id, f.update, true, f.clock.now, 'original-pack');
  const before = f.grants.listForContract(f.contract.contract_id).find(item => item.entry_key === f.update), doc = f.document();
  doc.changes.push({ entry_key: f.update, granted: true }); const { request } = await f.ready(doc);
  await f.store.activate(request, f.actor, f.check);
  expect(f.grants.listForContract(f.contract.contract_id).find(item => item.entry_key === f.update)).toEqual(before);
});
it('permits only one competing activation of the same reviewed revision', async () => {
  const f = await permissionFixture(), { request } = await f.ready();
  const outcomes = await Promise.allSettled([f.store.activate(request, f.actor, f.check), f.store.activate({ ...request, request_id: randomUUID() }, f.actor, f.check)]);
  expect(outcomes.filter(item => item.status === 'fulfilled')).toHaveLength(1); expect(outcomes.filter(item => item.status === 'rejected')).toHaveLength(1);
  expect((await f.store.read(f.contract.contract_id, f.actor, f.check)).history.map(item => item.sequence)).toEqual([1, 2]);
});
it('fences a private read overtaken by deletion and preserves a monotonic head', async () => {
  const f = await permissionFixture(), saved = await f.save(), open = f.codec.open.bind(f.codec);
  vi.spyOn(f.codec, 'open').mockImplementationOnce(async encrypted => {
    const value = await open(encrypted); await f.store.delete(f.contract.contract_id, saved.revision, randomUUID(), f.actor, f.check); return value;
  });
  await expect(f.store.read(f.contract.contract_id, f.actor, f.check)).rejects.toMatchObject({ code: 'permission_regression_conflict' });
  expect((await f.store.read(f.contract.contract_id, f.actor, f.check)).draft).toBeNull();
});
it('rechecks lock state and owner revocation after decrypting or sealing private content', async () => {
  const f = await permissionFixture(), saved = await f.save(), open = f.codec.open.bind(f.codec);
  vi.spyOn(f.codec, 'open').mockImplementationOnce(async encrypted => { const value = await open(encrypted); f.key.locked = true; return value; });
  await expect(f.store.read(f.contract.contract_id, f.actor, f.check)).rejects.toMatchObject({ code: 'server_locked' });
  f.key.locked = false; const { request } = await f.ready(), seal = f.codec.seal.bind(f.codec);
  vi.spyOn(f.codec, 'seal').mockImplementationOnce(async value => { const encrypted = await seal(value); f.clients.revoke(f.token.token_id, 'revoked after encryption', f.clock.now); return encrypted; });
  await expect(f.store.activate(request, f.actor, f.check)).rejects.toThrow('Owner revoked');
  expect(f.grants.get(f.contract.contract_id, f.remove)).toBe(true); expect(saved.revision).toBe(1);
});
it('bounds retained versions and rejects an idempotency replay after its version was pruned', async () => {
  const f = await permissionFixture(), firstView = await f.store.read(f.contract.contract_id, f.actor, f.check);
  const request = { contract_id: f.contract.contract_id, expected_revision: 0, expected_live_digest: firstView.live_digest, request_id: randomUUID(), document: f.document() };
  await f.store.save(request, f.actor, f.check);
  for (let index = 0; index < LIMIT.history + 2; index++) { const doc = f.document(); doc.title += ' ' + index; await f.save(doc); }
  const latest = await f.store.read(f.contract.contract_id, f.actor, f.check); expect(latest.drafts).toHaveLength(LIMIT.history);
  await expect(f.store.save(request, f.actor, f.check)).rejects.toMatchObject({ code: 'permission_regression_conflict' });
});

for (const point of ['inside-transaction', 'after-commit'] as const) it(`recovers actual process death ${point} without repeating a grant activation`, async () => {
  const f = await permissionFixture(), { request } = await f.ready(), root = fileURLToPath(new URL('../../../../', import.meta.url)), child = join(f.dir, 'permission-child.mts');
  const url = (path: string) => pathToFileURL(join(root, path)).href;
  writeFileSync(child, [
    `import {resourceFixture} from ${JSON.stringify(url('backend/server/src/__tests__/preapproval-resources-fixture.ts'))};`,
    `import {permissionStores} from ${JSON.stringify(url('backend/server/src/__tests__/permission-regression-fixture.ts'))};`,
    `import {createPreapprovalCodec} from ${JSON.stringify(url('backend/server/src/storage/preapproval-codec.ts'))};`,
    `import {KERNEL_MANIFESTS} from ${JSON.stringify(url('backend/server/src/kernel-manifests.ts'))};`,
    `const spies={fn:()=>Object.assign(()=>{},{mockClear(){}}),spyOn:(object,key)=>object[key].bind(object)};`,
    `const f=await resourceFixture(${JSON.stringify({ dir: f.dir, clock: f.clock, token: f.token })},{spies});`,
    `for(const slug of ['email-list','mail-send'])f.manifests.register(KERNEL_MANIFESTS.find(item=>item.slug===slug));`,
    `const {host,store}=permissionStores(f,createPreapprovalCodec(()=>new Uint8Array(32).fill(7)),${JSON.stringify(f.contract.contract_id)});`,
    ...(point === 'inside-transaction' ? [`const apply=host.apply.bind(host);host.apply=(...args)=>{apply(...args);process.exit(86);};`] : []),
    `await store.activate(${JSON.stringify(request)},${JSON.stringify(f.actor)},()=>{});process.exit(87);`,
  ].join('\n'));
  await f.close();
  const result = spawnSync(process.execPath, ['--import', url('node_modules/tsx/dist/loader.mjs'), child], { cwd: root, encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, TSX_TSCONFIG_PATH: join(root, 'tsconfig.test.json') } });
  expect(result.status, result.stdout + result.stderr).toBe(point === 'inside-transaction' ? 86 : 87);
  const next = await f.reopenPermissions(); expect(next.grants.get(f.contract.contract_id, f.remove)).toBe(point === 'inside-transaction');
  expect((await next.store.activate(request, f.actor, () => {})).activated?.sequence).toBe(2);
  expect((await next.store.read(f.contract.contract_id, f.actor, () => {})).history.map(item => item.sequence)).toEqual([1, 2]);
}, 45_000);


it('loads an immutable retained case version without changing the saved head or grants', async () => {
  const f = await permissionFixture(), first = await f.save(), doc = f.document(); doc.title = 'New working cases';
  const second = await f.save(doc), selected = await f.store.read(f.contract.contract_id, f.actor, f.check, first.draft!.revision);
  expect(selected.revision).toBe(second.revision); expect(selected.draft!.document.title).toBe('New working cases');
  expect(selected.selected_draft!.document.title).toBe(first.draft!.document.title); expect(f.grants.get(f.contract.contract_id, f.remove)).toBe(true);
});

it('uses declared catalog op authority and per-operation risk without lending token checklist access', async () => {
  const f = await permissionFixture();
  f.manifests.register({ slug: 'permission-api', name: 'Permission API', description: 'Local policy fixture.', author: 'fixture', kind: 'connection',
    category: 'data', risk_tier: 'read', input: { operation: null, args: null }, output: { result: 'result' },
    operations: { read: { operation_id: 'fixture.api.read', risk_tier: 'read', approval: 'never', groups: [] },
      write: { operation_id: 'fixture.api.write', risk_tier: 'write', approval: 'ask', groups: [] } },
    surfaces: { api: { transport: 'rest', default_base_url: 'https://fixture.invalid', auth: { kind: 'none' }, executes: {
      read: { kind: 'rest', method: 'GET', path_template: '/item' }, write: { kind: 'rest', method: 'POST', path_template: '/item' },
    } } } });
  f.execution.connectionStore!.upsert({ kind: 'api', name: 'fixture-api', display_name: 'Fixture account', enrolled_at: 1, updated_at: 1,
    auth_ciphertext: 'synthetic-opaque-value', config_json: JSON.stringify({ base_url: 'https://fixture.invalid' }) });
  createConnectionCatalogBindingStore(f.contracts).bind('fixture-api', 'permission-api', 'fixture-pack');
  for (const op of ['fixture.api.read', 'fixture.api.write']) f.grants.set(f.contract.contract_id, op, true, f.clock.now);
  const doc = f.document(); doc.changes.push({ entry_key: 'fixture.api.read', granted: false });
  for (const op of ['read', 'write']) doc.cases.push({ id: 'catalog_' + op, name: 'Catalog ' + op, credential_id: f.credential.token_id, expected: op === 'read' ? 'deny' : 'ask',
    target: { kind: 'operation', ingredient: 'permission-api', connection: 'fixture-api', input: { operation: op, args: {} } } });
  const saved = await f.save(doc), result = await f.store.test({ contract_id: f.contract.contract_id, expected_revision: saved.revision, draft_revision: saved.draft!.revision }, f.actor, f.check);
  expect(result.comparison.cases.find(item => item.id === 'catalog_read')).toMatchObject({ current: { verdict: 'allow' }, candidate: { verdict: 'deny' } });
  expect(result.comparison.cases.find(item => item.id === 'catalog_write')).toMatchObject({ current: { verdict: 'ask' }, candidate: { verdict: 'ask' } });
  expect(result.qualification).not.toBeNull(); expect(f.credential.grants['permission-api']).toBeUndefined();
});

it('requires the grant writer and activation history to share one physical realm', async () => {
  const first = await permissionFixture(), second = await permissionFixture();
  expect(() => createPermissionRegressionStore(first.db, first.codec, second.host)).toThrow('same realm');
});


it('allows owner cleanup of private history after the agreement is revoked', async () => {
  const f = await permissionFixture(), saved = await f.save(); f.definitions.revoke(f.contract.contract_id, 'retired agreement');
  const inactive = await f.store.read(f.contract.contract_id, f.actor, f.check); expect(inactive.supported).toBe(false); expect(inactive.draft).not.toBeNull();
  await f.store.delete(f.contract.contract_id, saved.revision, randomUUID(), f.actor, f.check);
  expect((await f.store.read(f.contract.contract_id, f.actor, f.check)).draft).toBeNull(); expect(f.grants.get(f.contract.contract_id, f.remove)).toBe(true);
});

for (const operation of ['read', 'save-replay', 'activation-replay'] as const) it(`rechecks revocation after the checked private load before ${operation}`, async () => {
  const f = await permissionFixture(), initial = await f.store.read(f.contract.contract_id, f.actor, f.check);
  const save = { contract_id: f.contract.contract_id, expected_revision: initial.revision, expected_live_digest: initial.live_digest,
    request_id: randomUUID(), document: f.document() };
  await f.store.save(save, f.actor, f.check);
  let invoke = () => f.store.read(f.contract.contract_id, f.actor, f.check);
  if (operation === 'save-replay') invoke = () => f.store.save(save, f.actor, f.check);
  if (operation === 'activation-replay') {
    const { request } = await f.ready(); await f.store.activate(request, f.actor, f.check);
    invoke = () => f.store.activate(request, f.actor, f.check);
  }
  const open = f.codec.open.bind(f.codec);
  vi.spyOn(f.codec, 'open').mockImplementationOnce(async encrypted => {
    const value = await open(encrypted);
    // Let load validate the decrypted snapshot, then revoke before its caller
    // resumes from await. Retrying a receipt must not bypass this boundary.
    queueMicrotask(() => queueMicrotask(() => f.clients.revoke(f.token.token_id, 'revoked at return boundary', f.clock.now)));
    return value;
  });
  await expect(invoke()).rejects.toThrow('Owner revoked');
});
for (const drift of ['vault-lock', 'grant-write'] as const) it(`rechecks ${drift} after the checked private load before returning cases`, async () => {
  const f = await permissionFixture(); await f.save(); const open = f.codec.open.bind(f.codec);
  vi.spyOn(f.codec, 'open').mockImplementationOnce(async encrypted => {
    const value = await open(encrypted);
    queueMicrotask(() => queueMicrotask(() => {
      if (drift === 'vault-lock') f.key.locked = true;
      else f.grants.set(f.contract.contract_id, f.update, false, f.clock.now);
    }));
    return value;
  });
  await expect(f.store.read(f.contract.contract_id, f.actor, f.check)).rejects.toMatchObject({ code: drift === 'vault-lock' ? 'server_locked' : 'permission_regression_conflict' });
});

it('stops impact inventory at its graph budget and reports incomplete coverage', async () => {
  const f = await permissionFixture(), recipes = f.execution.recipeStore;
  recipes.register({ ...f.recipe, recipe_id: '000-impact-budget', steps: [{ id: 'large-example', ingredient: 'calendar-update', input: { values: Array.from({ length: 50_001 }, (_, index) => index) } }] });
  const get = vi.spyOn(recipes, 'get');
  const impact = permissionRegressionImpact(f.db, f.contract.contract_id, f.document(), recipes, f.manifests, []);
  expect(impact.truncated).toBe(true); expect(impact.coverage.join(' ')).toContain('limit');
  expect(get.mock.calls.map(args => args[0])).toEqual(['000-impact-budget']);
});
it('includes topic literals within the bounded impact walk', async () => {
  const f = await permissionFixture(), topic = Object.keys(ENRICHMENT_REGISTRY)[0]!;
  f.execution.recipeStore.register({ ...f.recipe, recipe_id: '000-topic-reference', steps: [{ id: 'topic-example', ingredient: 'calendar-update', input: { topic } }] });
  const document = f.document(); document.changes = [{ entry_key: 'enrichment.' + topic, granted: false }];
  const impact = permissionRegressionImpact(f.db, f.contract.contract_id, document, f.execution.recipeStore, f.manifests, []);
  expect(impact.entries).toContainEqual(expect.objectContaining({ kind: 'recipe', id: '000-topic-reference' }));
});
