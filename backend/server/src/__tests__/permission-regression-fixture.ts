import { randomUUID } from 'node:crypto';
import { kernelOpForBackingSlug, type PermissionDocument } from '@recued/contracts';
import { resourceFixture } from './preapproval-resources-fixture.js';
import { KERNEL_MANIFESTS } from '../kernel-manifests.js';
import { createPreapprovalCodec } from '../storage/preapproval-codec.js';
import { createPermissionRegressionHost } from '../permission-regression-host.js';
import { createPermissionRegressionStore } from '../storage/permission-regression-store.js';
import { createConnectionCatalogBindingStore } from '../storage/connection-catalog-binding-store.js';
import { createContractGrantStore } from '../storage/contract-grant-store.js';

export const permissionFixture = async () => {
  const f = await resourceFixture();
  for (const slug of ['email-list', 'mail-send']) f.manifests.register(KERNEL_MANIFESTS.find(item => item.slug === slug)!);
  const update = kernelOpForBackingSlug('calendar-update')!, remove = kernelOpForBackingSlug('calendar-delete')!;
  const contract = f.definitions.mint({ minted_by: 'owner', display_name: 'Permission test agreement', door_types: ['mcp'],
    scope: { channels: ['mcp'], actors: ['contracted_user'], operation_ids: [update, remove] }, max_uses: 100 });
  for (const op of [update, remove]) f.grants.set(contract.contract_id, op, true, f.clock.now);
  f.grants.set(contract.contract_id, 'data.task', false, f.clock.now);
  const credential = f.inbound.issueToken({ value: { label: 'Original assistant', concurrency_tier: 3, chat_mode: null,
    contract_id: contract.contract_id, grants: { [update]: true, [remove]: true } }, now: f.clock.now }).record;
  const key = { locked: false }, codec = createPreapprovalCodec(() => key.locked ? null : new Uint8Array(32).fill(7));
  const { host, store } = permissionStores(f, codec, contract.contract_id);
  const document = (): PermissionDocument => ({ title: 'Private permission scenarios', changes: [{ entry_key: remove, granted: false }, { entry_key: 'data.task', granted: null }], cases: [
    { id: 'write', name: 'An update still asks', credential_id: credential.token_id, expected: 'ask', target: { kind: 'operation', ingredient: 'calendar-update', input: { slug: 'local', source_id: 'meeting', patch: { summary: 'Reviewed example' } } } },
    { id: 'remove', name: 'Deletion is denied', credential_id: credential.token_id, expected: 'deny', target: { kind: 'operation', ingredient: 'calendar-delete', input: { slug: 'local', source_id: 'meeting' } } },
    { id: 'tasks', name: 'Clearing restores the task default', credential_id: credential.token_id, expected: 'allow', target: { kind: 'collection', collection: 'task' } },
  ] });
  const actor = JSON.stringify([f.token.token_id, f.clients.get(f.token.token_id)?.metadata?.instance_id]), check = () => { if (f.clients.get(f.token.token_id)?.revoked_at !== null) throw new Error('Owner revoked'); };
  const save = async (doc = document()) => { const current = await store.read(contract.contract_id, actor, check);
    return store.save({ contract_id: contract.contract_id, expected_revision: current.revision, expected_live_digest: current.live_digest, request_id: randomUUID(), document: doc }, actor, check); };
  const ready = async (doc = document()) => { const saved = await save(doc), tested = await store.test({ contract_id: contract.contract_id, expected_revision: saved.revision, draft_revision: saved.draft!.revision }, actor, check);
    const review = await store.prepare({ contract_id: contract.contract_id, expected_revision: tested.revision, draft_revision: tested.draft!.revision, receipt_id: tested.qualification!.receipt_id }, actor, check);
    return { saved, tested, review, request: { contract_id: contract.contract_id, expected_revision: tested.revision, review_id: review.review_id, request_id: randomUUID() } }; };
  return { ...f, host, store, key, codec, actor, check, contract, credential, update, remove, document, save, ready,
    reopenPermissions: async () => { const next = await f.reopen(); for (const slug of ['email-list', 'mail-send']) next.manifests.register(KERNEL_MANIFESTS.find(item => item.slug === slug)!); return { ...next, ...permissionStores(next, codec, contract.contract_id) }; } };
};

export const permissionStores = (value: Awaited<ReturnType<typeof resourceFixture>>, codec: ReturnType<typeof createPreapprovalCodec>, contractId: string) => {
    const host = createPermissionRegressionHost({ db: value.db, contracts: value.contracts, definitions: value.definitions, grants: value.grants,
      inbound: value.inbound, execution: value.execution, profiles: { connectionStore: value.execution.connectionStore!,
        getManifest: slug => value.manifests.get(slug), connectionCatalogBindingStore: createConnectionCatalogBindingStore(value.contracts),
        contractGrantStore: createContractGrantStore(value.contracts) }, automations: () => [{ kind: 'trigger', id: 'bound-trigger', recipe_id: value.recipe.recipe_id,
        label: 'Bound subscriber', contract_id: contractId }], now: () => value.clock.now });
    return { host, store: createPermissionRegressionStore(value.db, codec, host, () => value.clock.now) };
  };
