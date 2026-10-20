import { createRecordsStore } from '../records/store.js';
import { createLocalManifestStore } from '../ingredient-authoring/local-manifest-store.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { recordsCatalogSlug } from '@recued/ingredient-authoring';
import type { RecordsExecutionBinding,RecordsSchemaSnapshot } from '@recued/contracts';
import { packUpdateFixture } from './pack-update-fixture.js';
import { recordPackInventory } from '../pack-inventory.js';
import { createPackRemovalStore } from '../storage/pack-removal-store.js';
import { handlePacksUninstall,type PackUninstallRpcDeps } from '../pack-uninstall-handler.js';
import type { PackDependency,PackRemovalApply,PackRemovalReview } from '@recued/contracts';
export const packRemovalFixture = async () => {
  const f = await packUpdateFixture();f.recipes.getBundled = () => null;
  let time = 1000;
  const install = (slug: string,dependencies?: PackDependency[],ingredients: string[] = [],publisher = 'recued-core',authored?: string) =>
    recordPackInventory(f.contracts,{ pack_slug: slug,publisher,pack_version: 1,dependencies,
      ...(authored ? { authored_pack_slug: authored } : {}),contents: ingredients.map(id => ({ type: 'ingredient',ingredient_id: id,ingredient_version: 1 })),installed_at: 1 });
  install(f.manifest.slug,[]);
  const deps: PackUninstallRpcDeps = { recipeStore: f.recipes,contractStore: f.contracts,packDir: f.dir,now: () => time };
  const removals = createPackRemovalStore(f.db,f.codec,deps,() => time),actor = 'removal-owner',check = () => { if (f.state.locked) throw new Error('owner locked'); };
  const request = (pack_slug = f.manifest.slug): PackRemovalReview => ({ pack_slug,request_id: crypto.randomUUID() });
  const review = (value = request()) => removals.review(value,actor,check);
  const execute = async (target: { pack_slug: string },controls: { check(): void; beforeMutation(): void }) =>
    (await handlePacksUninstall(deps,target,controls)).result;
  const apply = (value: PackRemovalApply) => removals.apply(value,actor,check,execute);
  return { ...f,deps,removals,actor,check,request,review,apply,execute,install,advance: (ms: number) => { time += ms; } };
};

export const installRemovalRecords = async (f: Awaited<ReturnType<typeof packRemovalFixture>>,publisher: string) => {
  const records = f.deps.recordsStore ??= createRecordsStore(f.db,{ now: () => 1000 });f.deps.localManifestStore ??= createLocalManifestStore(f.db);f.deps.registry ??= createManifestRegistry('/no-catalog');
  const owner = { publisher,pack_slug: 'same-records' },catalog = await recordsCatalogSlug(owner);
  const schema: RecordsSchemaSnapshot = { decimal_scale: 4,entities: { item: { kind: 'item',fields: [
    { key: 'id',slot: 'pk',kind: 'id',required: true,privacy: 'external_id' },{ key: 'title',slot: 's1',kind: 'string',required: true,privacy: 'content' },
  ] } } };
  const binding: RecordsExecutionBinding = { kind: 'core.records',action: 'create',entity: 'item',owner,pack_version: 1,
    storage_schema_hash: 'a'.repeat(64),declaration_hash: 'b'.repeat(64),operation_digest: publisher+':create' };
  records.installNamespace({ owner,version: 1,storage_schema_hash: 'a'.repeat(64),declaration_hash: 'b'.repeat(64),artifact_digest: 'artifact:'+publisher,schema,bindings: { create: binding } });
  records.execute({ binding,principal: 'owner',args: { id: 'kept',values: { title: 'Keep '+publisher } } });
  f.install(catalog,[],[],publisher,owner.pack_slug);f.recipes.save({ ...f.active[0]!,recipe_id: 'recipe-'+publisher },publisher,'pair-sync',1,catalog);
  return { records,owner,catalog };
};
