import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ASSET_DOCUMENT_DETAILS_ATTRIBUTE, type Asset, type AssetAttributeReadingCommand, type ExecutionSource, type RecipeDefinition } from '@recued/contracts';
import { canonicalJsonString, canonicalRecipeDefinition } from '@recued/recipes';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../storage/work-entity-store.js';
import { autoRegisterRecuedBuiltinSources } from '../work-entity-source-boot.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';
import { createWorkEntityDispatchers } from '../work-entity-ingredients.js';
import { createAssetOccurrenceService } from '../situations/asset-occurrence-service.js';
import { createSituationStore } from '../storage/situation-store.js';
import { createYoursService } from '../situations/yours-service.js';
import { createAnnotationStore } from '../storage/annotation-store.js';
import { createBlobStore } from '../storage/blob-store.js';
import { createRecipeStore } from '../recipe-store.js';
import { makeYoursHandlers } from '../situations/yours-handler.js';
import type { WsClient } from '../ws-server.js';

const owner: ExecutionSource = { channel: 'user', actor: 'user_self', user_id: 'owner', client_token_id: 'paired' };
const dispose: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of dispose.splice(0)) await close(); });
const fixture = async () => {
  let time = Date.parse('2026-10-23T12:00:00Z'); let unlocked = true;
  const db = new Database(':memory:'); ensureWorkEntitySchema(db);
  const work = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(work);
  const onAssetChanged = vi.fn(async (_asset: Asset) => {});
  const dispatchers = createWorkEntityDispatchers({ store: work, resolver: createWorkEntityResolver(work), now: () => time, onAssetChanged });
  const occurrences = createAssetOccurrenceService({ db, work, dispatchers, now: () => time, timeZone: () => 'UTC' });
  const directory = mkdtempSync(join(tmpdir(), 'd325-optional-structure-'));
  const annotations = createAnnotationStore({ db, blobs: createBlobStore(join(directory, 'blobs')), now: () => time });
  const service = createYoursService({ db, work, dispatchers, occurrences, annotations, situations: createSituationStore(db), now: () => time, isVaultUnlocked: () => unlocked });
  dispose.push(async () => { await service.stop(); db.close(); rmSync(directory, { recursive: true, force: true }); });
  const created = await service.command({ action: 'asset.create', input: { name: 'Garden pump', attributes: { length: '  about 25 meters\n測定は概算です  ', colour: 'Blue' } } }, owner);
  const id = created.id!;
  const read = () => work.readAsset(id)!;
  const command = (input: Parameters<typeof service.command>[0]) => service.command(input, owner);
  const copy = (field = 'hose_length'): AssetAttributeReadingCommand => {
    const asset = read();
    return { action: 'asset.record_attribute_reading', id, request_id: 'reading-request-0001', attribute: 'length',
      expected_source: { value: asset.attributes.length as string, source: asset.field_sources['attributes.length'] ?? null }, field,
      expected_target: { exists: Object.hasOwn(asset.readings, field), value: asset.readings[field] ?? null, source: asset.field_sources[`readings.${field}`] ?? null },
      reading: { value: 25, unit: 'm', as_of: time - 60_000 } };
  };
  return { db, work, service, dispatchers, occurrences, onAssetChanged, annotations, directory, id, read, command, copy,
    advance: () => { time += 1000; }, rollback: () => { time -= 120_000; }, seal: () => { unlocked = false; } };
};

describe('optional attribute reading copies', () => {
  it('reconciles a rule immediately after the copy and does not duplicate its occurrence on retry', async () => {
    const f = await fixture();
    f.onAssetChanged.mockImplementation(async asset => { await f.occurrences.reconcileAsset(asset.id); });
    await f.command({ action: 'asset.update', id: f.id, patch: { readings: { hose_length: null } } });
    await f.command({ action: 'rule.save', asset_id: f.id, rule: { id: 'inspect_hose', title: 'Inspect hose', enabled: true, muted: false, pinned: true,
      consequence: 'routine', expiry_policy: 'strict_expire', when: { kind: 'objective', field: 'hose_length', target: 20, unit: 'm', direction: 'rising', mode: 'condition', lead_days: 0 },
      reaction: { notify: true, occurrence: 'action', emit: false }, schedule: { before: [], on_day: true } } });
    const input = f.copy(); await f.command(input);
    const first = (await f.service.snapshot({ asset_id: f.id })).occurrences;
    expect(first).toHaveLength(1); expect(first[0]).toMatchObject({ rule_id: 'inspect_hose', question: false });
    await f.command(input);
    expect((await f.service.snapshot({ asset_id: f.id })).occurrences.map(row => row.id)).toEqual(first.map(row => row.id));
    expect(f.work.assetReadingHistory(f.id, 'hose_length')).toHaveLength(1);
  });

  it('registers context only for a paired owner and preserves the vault boundary', async () => {
    const f = await fixture(); const handlers = makeYoursHandlers(f.service)!;
    const paired = { instance_id: 'paired', client_kind: 'webclient', user_id: 'owner' } as WsClient;
    const input = { root: { kind: 'field' as const, asset_id: f.id, group: 'attributes' as const, field: 'length' } };
    expect(handlers.methods).toContain('yours.context');
    await expect(handlers.handlers['yours.context'](input, paired)).resolves.toMatchObject({ root: input.root, completeness: 'complete' });
    await expect(handlers.handlers['yours.context'](input, { ...paired, client_kind: 'bridge' } as WsClient)).rejects.toThrow('paired webclient');
    f.seal(); await expect(handlers.handlers['yours.context'](input, paired)).rejects.toThrow('Unlock');
  });

  it('keeps descriptive text independent and invokes no copy operation for a plain edit', async () => {
    const f = await fixture(); const copy = vi.spyOn(f.work, 'recordAttributeReading');
    await f.command({ action: 'asset.update', id: f.id, patch: { attributes: { length: '25 meters' } } });
    expect(f.read().attributes.length).toBe('25 meters'); expect(f.read().readings).toEqual({});
    expect(f.read().rules).toEqual([]); expect(f.work.listAssetObservationBindings(f.id)).toEqual([]); expect(copy).not.toHaveBeenCalled();
  });

  it('records the confirmed reading with an exact historical text receipt, preserving the note and its authority', async () => {
    const f = await fixture(); const before = f.read(); const input = f.copy();
    await f.command(input); const after = f.read();
    expect(after.attributes).toEqual(before.attributes); expect(after.field_sources['attributes.length']).toEqual(before.field_sources['attributes.length']);
    expect(after.readings.hose_length).toEqual({ ...input.reading, evidence: [{ collection: 'asset', id: f.id, field: 'attributes.length', value: before.attributes.length }] });
    expect(after.field_sources['readings.hose_length']).toMatchObject({ kind: 'owner', ref: 'paired-owner', revision: expect.stringMatching(/^attribute:[a-f0-9]{64}$/u) });
    expect(after.rules).toEqual([]); expect(f.work.listAssetObservationBindings(f.id)).toEqual([]);
    expect(f.work.assetReadingHistory(f.id, 'hose_length')).toHaveLength(1);
  });

  it('fills a reviewed unknown field and recognizes identical retries without a second sample or row update', async () => {
    const f = await fixture(); await f.command({ action: 'asset.update', id: f.id, patch: { readings: { hose_length: null } } });
    const input = f.copy(); await f.command(input); const after = f.read();
    const changes = () => (f.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
    const before = changes(); f.advance(); await f.command(input);
    expect(changes()).toBe(before); expect(f.read()).toEqual(after); expect(f.work.assetReadingHistory(f.id, 'hose_length')).toHaveLength(1);
    f.rollback(); await f.command(input); expect(f.read()).toEqual(after);
  });

  it('checks a changed text value and receipt inside the canonical transaction', async () => {
    const f = await fixture(); const input = f.copy(); const current = f.work.readAsset.bind(f.work);
    vi.spyOn(f.work, 'readAsset').mockImplementationOnce(id => {
      const prior = current(id); f.advance(); f.work.writeAsset({ id: f.id, source_id: 'recued.asset', source: { kind: 'owner', ref: 'another-owner' }, attributes: { length: '26 meters' } }); return prior;
    });
    await expect(f.command(input)).rejects.toThrow('text or its source changed');
    expect(f.read().attributes.length).toBe('26 meters'); expect(f.read().readings).toEqual({}); expect(f.work.assetReadingHistory(f.id, 'hose_length')).toEqual([]);
  });

  it('rejects an equal string with a newer source receipt but permits an unrelated attribute edit', async () => {
    const f = await fixture(); const input = f.copy(); f.advance();
    f.work.writeAsset({ id: f.id, source_id: 'recued.asset', source: { kind: 'owner', ref: 'another-owner' }, attributes: { length: input.expected_source.value } });
    await expect(f.command(input)).rejects.toThrow('text or its source changed');
    const reviewed = f.copy(); await f.command({ action: 'asset.update', id: f.id, patch: { attributes: { colour: 'Green' } } });
    await f.command(reviewed); expect(f.read().attributes.colour).toBe('Green');
  });

  it('rejects a target changed or cleared after review, including changes within the same clock tick', async () => {
    const f = await fixture(); await f.command({ action: 'asset.update', id: f.id, patch: { readings: { hose_length: { value: 24, unit: 'm', as_of: Date.parse('2026-10-23T11:00:00Z'), evidence: [] } } } });
    await f.command({ action: 'asset.update', id: f.id, patch: { readings: { hose_length: null } } }); const input = f.copy();
    await f.command({ action: 'asset.update', id: f.id, patch: { readings: { hose_length: null } } });
    await expect(f.command(input)).rejects.toThrow('reading field changed');
    const reviewed = f.copy(); await f.command({ action: 'asset.update', id: f.id, patch: { readings: { hose_length: { value: 26, unit: 'm', as_of: input.reading.as_of, evidence: [] } } } });
    await expect(f.command(reviewed)).rejects.toThrow('reading field changed'); expect(f.read().readings.hose_length?.value).toBe(26);
  });

  it('never overwrites an intervening observation on replay and keeps the original note independent', async () => {
    const f = await fixture(); const input = f.copy(); await f.command(input);
    await f.command({ action: 'asset.update', id: f.id, patch: { attributes: { length: '27 meters' } } });
    await f.command(input); expect(f.read().attributes.length).toBe('27 meters'); expect(f.read().readings.hose_length?.value).toBe(25);
    await f.command({ action: 'asset.update', id: f.id, patch: { readings: { hose_length: { value: 28, unit: 'm', as_of: input.reading.as_of + 1000, evidence: [] } } } });
    await expect(f.command(input)).rejects.toThrow(/changed/u); expect(f.read().readings.hose_length?.value).toBe(28);
    expect(f.work.assetReadingHistory(f.id, 'hose_length')).toHaveLength(2);
  });

  it('can finish reconciliation after a lost post-commit result without duplicating the canonical reading', async () => {
    const f = await fixture(); const input = f.copy(); f.onAssetChanged.mockRejectedValueOnce(new Error('lost post-commit result'));
    await expect(f.command(input)).rejects.toThrow('lost post-commit result');
    expect(f.work.assetReadingHistory(f.id, 'hose_length')).toHaveLength(1);
    await f.command(input); expect(f.work.assetReadingHistory(f.id, 'hose_length')).toHaveLength(1);
  });

  for (const change of [
    (input: AssetAttributeReadingCommand) => { input.reading.as_of = Date.parse('2100-01-01'); },
    (input: AssetAttributeReadingCommand) => { input.reading.unit = ''; },
    (input: AssetAttributeReadingCommand) => { input.reading.value = NaN; },
    (input: AssetAttributeReadingCommand) => { input.attribute = ASSET_DOCUMENT_DETAILS_ATTRIBUTE; },
    (input: AssetAttributeReadingCommand) => { input.field = 'constructor'; },
    (input: AssetAttributeReadingCommand) => { input.request_id = ''; },
    (input: AssetAttributeReadingCommand) => { input.expected_target.exists = true; },
  ]) it(`rejects an invalid or unreviewed copy (${change.toString()}) without changing canonical state`, async () => {
    const f = await fixture(); const before = f.read(); const input = f.copy(); change(input);
    await expect(f.command(input)).rejects.toThrow(); expect(f.read()).toEqual(before); expect(f.work.assetReadingHistory(f.id, 'hose_length')).toEqual([]);
  });

  it('requires the authenticated owner, an unlocked vault, and an active asset', async () => {
    const f = await fixture(); const input = f.copy();
    await expect(f.service.command(input, { channel: 'mcp', actor: 'contracted_user', agent_id: 'agent', tool_call_id: 'call', mcp_token_id: 'scoped', contract_id: 'scoped' })).rejects.toThrow('owner');
    await f.command({ action: 'asset.update', id: f.id, patch: { status: 'retired' }, confirm_retirement: true });
    await expect(f.command(input)).rejects.toThrow('active local asset');
    f.seal(); await expect(f.command(input)).rejects.toThrow(/Unlock/u);
  });

  it('adds file evidence without reclaiming an automatic observation or changing its source and time', async () => {
    const f = await fixture();
    f.work.writeAsset({ id: f.id, source_id: 'recued.asset', source: { kind: 'owner', ref: 'paired-owner' }, readings: { pressure: null } });
    f.work.bindAssetObservations({ id: 'device', asset_id: f.id, actor_ref: 'device', source_ref: 'device:pressure', fields: ['readings.pressure'], enabled: true });
    f.work.writeAssetObservations({ binding_id: 'device', actor_ref: 'device', readings: { pressure: { value: 2, unit: 'bar', as_of: Date.parse('2026-10-23T11:00:00Z'), evidence: [] } } });
    const link = await f.annotations.link({ from_collection: 'asset', from_id: f.id, to_collection: 'file', to_id: 'file:receipt', role: 'attachment', authored_by_recipe_id: 'owner', origin_actor: 'user_self', origin_surface: 'client_rpc' });
    const before = f.read(); const input = { action: 'asset.add_evidence' as const, id: f.id, path: 'readings.pressure' as const,
      expected: { value: before.readings.pressure!, source: before.field_sources['readings.pressure']! }, attachment_id: link._id, evidence: { collection: 'file' as const, id: 'file:receipt' } };
    await f.command(input); const after = f.read();
    expect(after.field_sources).toEqual(before.field_sources); expect(after.automatic_updates).toEqual(before.automatic_updates);
    expect(after.readings.pressure).toEqual({ ...before.readings.pressure, evidence: [input.evidence] });
    expect(f.work.listAssetObservationBindings(f.id)[0]?.enabled).toBe(true);
    const changes = (f.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n; await f.command(input);
    expect((f.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n).toBe(changes);
    expect(f.work.assetReadingHistory(f.id, 'pressure')).toHaveLength(1);
    f.work.writeAssetObservations({ binding_id: 'device', actor_ref: 'device', readings: { pressure: { value: 3, unit: 'bar', as_of: Date.parse('2026-10-23T11:01:00Z'), evidence: [] } } });
    expect(f.read().readings.pressure?.value).toBe(3);
    await expect(f.command(input)).rejects.toThrow('observation changed');
  });

  it('checks attachment membership inside the write and preserves manual handoffs when adding a citation', async () => {
    const f = await fixture(); const input = f.copy(); await f.command(input);
    const prior = f.read(); await f.command({ action: 'asset.automatic_updates', id: f.id, path: 'readings.hose_length', expected: { value: prior.readings.hose_length!, source: prior.field_sources['readings.hose_length']! } });
    const before = f.read(); const link = await f.annotations.link({ from_collection: 'asset', from_id: f.id, to_collection: 'file', to_id: 'file:receipt', role: 'attachment', authored_by_recipe_id: 'owner', origin_actor: 'user_self', origin_surface: 'client_rpc' });
    const citation = { action: 'asset.add_evidence' as const, id: f.id, path: 'readings.hose_length' as const, expected: { value: before.readings.hose_length!, source: before.field_sources['readings.hose_length']! }, attachment_id: link._id, evidence: { collection: 'file' as const, id: 'file:receipt' } };
    await expect(f.command({ ...citation, attachment_id: 'another-assets-link' })).rejects.toThrow('no longer attached');
    await f.command(citation); expect(f.read().automatic_updates).toEqual(before.automatic_updates); expect(f.read().field_sources).toEqual(before.field_sources);
    await f.annotations.deleteLink(link._id); await expect(f.command(citation)).rejects.toThrow('no longer attached');
  });

  it('does not enroll a recipe version that changed after the owner reviewed it', async () => {
    const f = await fixture(); const recipes = createRecipeStore(f.directory, f.db); f.service.bindRecipes(recipes);
    const recipe = JSON.parse(readFileSync('community/recipes/record-asset-evidence-paperless.json', 'utf8')) as RecipeDefinition;
    const digest = (value: RecipeDefinition) => createHash('sha256').update(canonicalJsonString(canonicalRecipeDefinition(value))).digest('hex');
    recipes.save(recipe, 'fixture', 'bundled', Date.now());
    await f.command({ action: 'asset.update', id: f.id, patch: { readings: { hose_length: null } } });
    const expected_recipe_hash = digest(recipe); recipe.metadata.description += ' Updated after review.'; recipes.save(recipe, 'fixture', 'bundled', Date.now() + 1);
    await expect(f.command({ action: 'binding.save', asset_id: f.id, recipe_id: recipe.recipe_id, fields: ['readings.hose_length'], expected_recipe_hash })).rejects.toThrow('changed while you were reviewing');
    expect(f.work.listAssetObservationBindings(f.id)).toEqual([]);
    await f.command({ action: 'binding.save', asset_id: f.id, recipe_id: recipe.recipe_id, fields: ['readings.hose_length'], expected_recipe_hash: digest(recipe) });
    expect(f.work.listAssetObservationBindings(f.id)[0]).toMatchObject({ enabled: true, fields: ['readings.hose_length'], recipe_hash: digest(recipe) });
  });
});
