import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ASSET_DOCUMENT_DETAILS_ATTRIBUTE, assetDocumentDetails, type AssetDocumentDetails, type ExecutionSource } from '@recued/contracts';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../storage/work-entity-store.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';
import { autoRegisterRecuedBuiltinSources } from '../work-entity-source-boot.js';
import { createWorkEntityDispatchers } from '../work-entity-ingredients.js';
import { createAssetOccurrenceService, type AssetOccurrenceService } from '../situations/asset-occurrence-service.js';
import { createYoursService } from '../situations/yours-service.js';
import { createSituationStore } from '../storage/situation-store.js';
import { createAnnotationStore } from '../storage/annotation-store.js';
import { createBlobStore } from '../storage/blob-store.js';

const owner: ExecutionSource = { channel: 'user', actor: 'user_self', user_id: 'owner', client_token_id: 'paired' };
const disposals: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of disposals.splice(0)) await dispose(); });
const fixture = () => {
  const db = new Database(':memory:'); ensureWorkEntitySchema(db);
  const work = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(work);
  let occurrences: AssetOccurrenceService; let unlocked = true;
  const dispatchers = createWorkEntityDispatchers({ store: work, resolver: createWorkEntityResolver(work),
    onAssetChanged: async asset => { await occurrences.reconcileAsset(asset.id); },
    onAssetDeleted: async asset => { await occurrences.retireAsset(asset.id); } });
  occurrences = createAssetOccurrenceService({ db, work, dispatchers, timeZone: () => 'UTC' });
  const dir = mkdtempSync(join(tmpdir(), 'asset-documents-'));
  const annotations = createAnnotationStore({ db, blobs: createBlobStore(join(dir, 'blobs')) });
  const service = createYoursService({ db, work, dispatchers, occurrences, annotations, situations: createSituationStore(db), isVaultUnlocked: () => unlocked });
  disposals.push(async () => { await service.stop(); db.close(); rmSync(dir, { recursive: true, force: true }); });
  const command = (input: Parameters<typeof service.command>[0]) => service.command(input, owner);
  const create = async (name: string) => (await command({ action: 'asset.create', input: { name, attributes: { colour: 'white' } } })).id!;
  const attach = async (asset_id: string, record_id = 'file:received:manual') => ({ asset_id, record_id,
    link_id: (await command({ action: 'file.attach', asset_id, record_id })).id! });
  return { work, service, command, create, attach, annotations, seal: () => { unlocked = false; } };
};

describe('asset document details', () => {
  it('retains distinct owner context for the same file on two assets without changing their other facts', async () => {
    const f = fixture(); const boiler = await f.create('Boiler'); const heater = await f.create('Heater');
    const first = await f.attach(boiler); const second = await f.attach(heater);
    await f.command({ action: 'file.details', ...first, details: { purpose: ' Manual ', applies_to: 'B24', revision: 'Edition 2025' } });
    await f.command({ action: 'file.details', ...second, details: { purpose: 'Installation guide' } });
    const current = (await f.service.snapshot({ asset_id: boiler })).assets[0]!;
    expect(assetDocumentDetails(current, first.record_id)).toEqual({ purpose: 'Manual', applies_to: 'B24', revision: 'Edition 2025' });
    expect(current.attributes.colour).toBe('white');
    expect(assetDocumentDetails(f.work.readAsset(heater)!, second.record_id)).toEqual({ purpose: 'Installation guide' });
    expect((await f.attach(boiler)).link_id).toBe(first.link_id);
    expect(assetDocumentDetails(f.work.readAsset(boiler)!, first.record_id).revision).toBe('Edition 2025');
  });

  it('clears optional details and detaches only the selected attachment and its asset context', async () => {
    const f = fixture(); const asset = await f.create('Boiler'); const other = await f.create('Heater');
    const first = await f.attach(asset); const receipt = await f.attach(asset, 'file:received:receipt'); const shared = await f.attach(other);
    for (const ref of [first, receipt, shared]) await f.command({ action: 'file.details', ...ref, details: { purpose: 'Manual' } });
    await f.command({ action: 'file.details', ...receipt, details: { purpose: '', applies_to: '  ', revision: '' } });
    expect(assetDocumentDetails(f.work.readAsset(asset)!, receipt.record_id)).toEqual({});
    await f.command({ action: 'file.detach', ...first });
    expect(await f.annotations.listLinks({ from_id: asset })).toEqual([expect.objectContaining({ _id: receipt.link_id })]);
    expect(f.work.readAsset(asset)!.attributes[ASSET_DOCUMENT_DETAILS_ATTRIBUTE]).toEqual({});
    expect(assetDocumentDetails(f.work.readAsset(other)!, shared.record_id)).toEqual({ purpose: 'Manual' });
    expect((await f.attach(asset)).link_id).not.toBe(first.link_id);
    expect(assetDocumentDetails(f.work.readAsset(asset)!, first.record_id)).toEqual({});
  });

  it('rejects a mismatched asset, file, stale link or locked vault before changing facts', async () => {
    const f = fixture(); const first = await f.create('Boiler'); const second = await f.create('Heater'); const ref = await f.attach(first);
    for (const replacement of [{ asset_id: second }, { record_id: 'file:received:other' }, { link_id: 'stale' }]) {
      await expect(f.command({ action: 'file.details', ...ref, ...replacement, details: { purpose: 'Manual' } })).rejects.toThrow('Attachment not found');
    }
    expect(f.work.readAsset(first)!.attributes).toEqual({ colour: 'white' });
    f.seal(); await expect(f.command({ action: 'file.details', ...ref, details: { purpose: 'Manual' } })).rejects.toThrow('Unlock');
  });

  it('keeps the context until the final reference to that file is detached', async () => {
    const f = fixture(); const id = await f.create('Boiler'); const ref = await f.attach(id);
    await f.command({ action: 'file.details', ...ref, details: { purpose: 'Manual' } });
    const duplicate = await f.annotations.link({ from_collection: 'asset', from_id: id, to_collection: 'file', to_id: ref.record_id,
      role: 'attachment', authored_by_recipe_id: 'importer' });
    await f.command({ action: 'file.detach', ...ref });
    expect(assetDocumentDetails(f.work.readAsset(id)!, ref.record_id)).toEqual({ purpose: 'Manual' });
    await f.command({ action: 'file.detach', ...ref, link_id: duplicate._id });
    expect(assetDocumentDetails(f.work.readAsset(id)!, ref.record_id)).toEqual({});
  });

  it('moves document context with merged file references while keeping the survivor’s details on a collision', async () => {
    const f = fixture(); const survivor = await f.create('Boiler'); const duplicate = await f.create('Same boiler');
    const kept = await f.attach(survivor, 'file:received:receipt'); const shared = await f.attach(duplicate, kept.record_id); const moved = await f.attach(duplicate);
    await f.command({ action: 'file.details', ...kept, details: { purpose: 'Purchase receipt' } });
    await f.command({ action: 'file.details', ...shared, details: { purpose: 'Other label' } });
    await f.command({ action: 'file.details', ...moved, details: { purpose: 'Manual', applies_to: 'B24' } });
    await f.command({ action: 'asset.same_thing', id: survivor, other_id: duplicate, merge: true });
    const asset = f.work.readAsset(survivor)!;
    expect(assetDocumentDetails(asset, kept.record_id)).toEqual({ purpose: 'Purchase receipt' });
    expect(assetDocumentDetails(asset, moved.record_id)).toEqual({ purpose: 'Manual', applies_to: 'B24' });
    expect(await f.annotations.listLinks({ from_collection: 'asset', from_id: survivor, to_collection: 'file', role: 'attachment' }))
      .toEqual(expect.arrayContaining([expect.objectContaining({ to_id: kept.record_id }), expect.objectContaining({ to_id: moved.record_id })]));
  });

  it.each([{ purpose: 42 }, { purpose: 'a'.repeat(201) }, { applies_to: 'a'.repeat(201) }, { revision: 'a'.repeat(101) }, null, []])('rejects malformed document details %j', async details => {
    const f = fixture(); const id = await f.create('Boiler'); const ref = await f.attach(id);
    await expect(f.command({ action: 'file.details', ...ref, details: details as AssetDocumentDetails })).rejects.toThrow();
    expect(f.work.readAsset(id)!.attributes).toEqual({ colour: 'white' });
  });

  it.each(['clear', 'detach'])('does not restore document context after a merge is retried following %s', async action => {
    const f = fixture(); const survivor = await f.create('Boiler'); const duplicate = await f.create('Same boiler'); const ref = await f.attach(duplicate);
    await f.command({ action: 'file.details', ...ref, details: { purpose: 'Old manual' } });
    const merge = { action: 'asset.same_thing' as const, id: survivor, other_id: duplicate, merge: true };
    await f.command(merge);
    const moved = await f.attach(survivor);
    if (action === 'clear') await f.command({ action: 'file.details', ...moved, details: {} });
    else await f.command({ action: 'file.detach', ...moved });
    await f.command(merge);
    expect(assetDocumentDetails(f.work.readAsset(survivor)!, moved.record_id)).toEqual({});
    expect((await f.annotations.listLinks({ from_collection: 'asset', from_id: survivor, role: 'attachment' })).length).toBe(action === 'clear' ? 1 : 0);
  });

  it('does not turn corrupt attributes or parent document context into facts for a part', async () => {
    const f = fixture(); const parent = await f.create('House'); const child = await f.create('Boiler'); const ref = await f.attach(parent);
    await f.command({ action: 'file.details', ...ref, details: { purpose: 'Manual' } });
    await f.command({ action: 'asset.link', id: child, parent_id: parent });
    expect(assetDocumentDetails(f.work.readAssetEffective(child)!, ref.record_id)).toEqual({});
    expect(assetDocumentDetails({ attributes: { document_details: { [ref.record_id]: { purpose: { text: 'Guess' } } } } }, ref.record_id)).toEqual({});
  });
});
