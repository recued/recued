/** Private deterministic transport fixture. SQLite, ownership and the actual
 * install writer are exercised separately by pack-update-rpc.test.ts. */
import type { BulkPackManifest, PackListEntry, PackUpdateView, PackUpdateStage, RecipeDefinition, RecipeRegressionSuite, RecipeRegressionVersion, PackUpdateApplyResult } from '@recued/contracts';
import { runRecipeRegression } from '@recued/engine';
import { mountPacksPanel } from '../../src/settings/packs-panel.js';
import type { PackUpdateCaller } from '../../src/settings/pack-update-caller.js';
import type { RecipeRegressionCaller } from '../../src/kitchen/recipe-editor/recipe-regression-caller.js';

const slug = 'reviewed-fixture', hash = 'f'.repeat(64), scenario = new URLSearchParams(location.search).get('scenario');
const recipe = (id: string,version = 1): RecipeDefinition => ({ recipe_id: id,version,ttl: version === 1 ? 0 : 10,
  metadata: { name: id,description: 'Fixture recipe.',author: 'owner',supported_platforms: [] },variables: {},prefetch_steps: [],
  steps: [{ id: 'count',transform: 'count',input: (scenario === 'failed' || scenario === 'dependency-failed') && id === 'second' && version === 2 ? [1] : [] }],output: { render: [] } });
const manifest: BulkPackManifest = { manifest_version: 1,slug,publisher: 'recued-core',name: 'Reviewed fixture pack',description: 'Use a tested fixture update.',
  version: scenario?.startsWith('restore') ? 3 : 2,recipes: ['first','second'].map(slug => ({ slug,version: 2 })),requires: ['install_bulk_pack'],tags: [] };
interface State { catalog_reads?: number; applies: Record<string,{ intent: string; result: PackUpdateApplyResult }>; applied_versions?: Record<string,number>; qualified_digest?: string; view: PackUpdateView; suite_revision: number; qualified_suite_revision?: number; install_calls: number; requests: Record<string,{ fingerprint: string; view: PackUpdateView }> }
const key = 'recued-pack-update-fixture';
const initial = (): State => ({ view: { pack_slug: slug,managed: !!scenario?.startsWith('restore'),revision: scenario?.startsWith('restore') ? 2 : 0,
  installed_version: scenario?.startsWith('restore') ? 3 : 1,candidate: null,qualification: null,applied: false,
  ...(scenario?.startsWith('restore') ? { releases: [2,1].map(sequence => ({ release_id: 'retained-' + sequence,sequence,created_at: sequence,digest: 'release-' + sequence,current: sequence === 2,
    packs: [{ pack_slug: 'required-fixture',name: 'Required fixture pack',version: sequence + 2 },{ pack_slug: slug,name: manifest.name,version: sequence + 1 }] })) } : {}) },
  suite_revision: 1,install_calls: 0,requests: {},applies: {} });
const read = (): State => JSON.parse(sessionStorage.getItem(key) ?? JSON.stringify(initial()));
const write = (state: State): void => sessionStorage.setItem(key,JSON.stringify(state));
if (!sessionStorage.getItem(key)) write(initial());
const fixtureSuite = (id: string): RecipeRegressionSuite => ({ title: 'Saved suite',baseline: recipe(id),cases: [{ id: 'empty',name: 'Empty input',sample: {},assertions: [
  { kind: 'run_status',expected: 'passed' },{ kind: 'value',phase: 'sequential',step_id: 'count',field: 'output',path: [],expected: 0 },
] }] });
const suiteHistory = (id: string) => {
  const saved = JSON.parse(sessionStorage.getItem('recued-pack-update-suites') ?? '{}') as Record<string,RecipeRegressionVersion[]>;
  const versions = saved[id] ?? ((scenario === 'authoring' || scenario === 'dependency-missing' || scenario === 'restore-missing') && id === 'second' ? [] : [{ recipe_id: id,revision: 1,digest: 'suite',created_at: 1,suite: fixtureSuite(id) }]);
  return { head_revision: versions.at(-1)?.revision ?? 0,versions: [...versions].reverse().map(({ suite: _suite,...metadata }) => metadata),version: versions.at(-1) ?? null };
};
const savedTests: RecipeRegressionCaller = {
  async get(args) {
    if (scenario === 'slow') await new Promise(resolve => setTimeout(resolve,1000));
    return suiteHistory(args.recipe_id);
  },
  async save(request) {
    const current = suiteHistory(request.recipe_id); if (current.head_revision !== request.expected_revision) throw new Error('Saved tests changed.');
    const versions = JSON.parse(sessionStorage.getItem('recued-pack-update-suites') ?? '{}') as Record<string,RecipeRegressionVersion[]>;
    const next = { recipe_id: request.recipe_id,revision: current.head_revision + 1,digest: 'suite-' + (current.head_revision + 1),created_at: Date.now(),suite: request.suite };
    versions[request.recipe_id] = [...(current.version ? [current.version] : []),next]; sessionStorage.setItem('recued-pack-update-suites',JSON.stringify(versions)); return suiteHistory(request.recipe_id);
  },
  async remove(request) { const versions = JSON.parse(sessionStorage.getItem('recued-pack-update-suites') ?? '{}'); versions[request.recipe_id] = []; sessionStorage.setItem('recued-pack-update-suites',JSON.stringify(versions)); return suiteHistory(request.recipe_id); },
  async run(request,signal) { const saved = suiteHistory(request.recipe_id).version!; return { ...await runRecipeRegression(saved.suite,request.candidate,signal),recipe_id: request.recipe_id,revision: saved.revision,suite_digest: saved.digest,baseline_hash: 'baseline',candidate_hash: 'candidate' }; },
};
const caller: PackUpdateCaller = {
  async restore(request) {
    const state = read(), prior = state.requests[request.request_id];
    if (prior) { if (prior.fingerprint !== JSON.stringify(request)) throw new Error('Restore identity changed.'); return structuredClone(state.view); }
    if (scenario === 'restore-drift') throw new Error('The surrounding pack inventory changed since this release.');
    if (state.view.revision !== request.expected_revision) throw new Error('Release stage changed. Reload it.');
    const release = state.view.releases!.find(release => release.release_id === request.release_id)!;
    const version = release.packs.find(pack => pack.pack_slug === slug)!.version;
    state.view.revision++; state.view.qualification = null; state.view.applied = false;
    state.view.candidate = { version,name: manifest.name,source: 'bundled',manifest_hash: 'a'.repeat(64),digest: release.digest,
      recipes: ['first','second'].map(id => ({ recipe_id: id,pack_slug: id === 'second' ? 'required-fixture' : slug,before: recipe(id,state.view.installed_version ?? 3),after: recipe(id,version) })),
      packs: release.packs.map(pack => ({ ...pack,installed_version: state.applied_versions?.[pack.pack_slug] ?? (pack.pack_slug === slug ? 3 : 4),dependencies: pack.pack_slug === slug ? ['required-fixture'] : [] })),
      restore: { release_id: release.release_id,sequence: release.sequence,created_at: release.created_at,digest: release.digest } };
    state.requests[request.request_id] = { fingerprint: JSON.stringify(request),view: structuredClone(state.view) }; write(state);
    if (scenario === 'restore-lost-stage') throw new Error('Restore stage reply lost. Retry the same request.');
    return structuredClone(state.view);
  },
  async release(request) {
    const state = read(), prior = state.requests[request.request_id];
    if (prior) return structuredClone(prior.view);
    if (state.view.revision !== request.expected_revision) throw new Error('The staged plan changed. Reload it.');
    state.view.revision++; state.view.candidate = null; state.view.qualification = null; state.view.applied = false;
    state.requests[request.request_id] = { fingerprint: JSON.stringify(request),view: structuredClone(state.view) }; write(state); return state.view;
  },
  async apply(request) {
    let state = read(); const prior = state.applies[request.request_id];
    if (prior) { if (prior.intent !== JSON.stringify(request)) throw new Error('Apply request changed.'); return { ...structuredClone(state.view),receipt: structuredClone(prior.result.receipt) }; }
    if (scenario === 'dependency-slow' || scenario === 'restore-slow') await new Promise(resolve => setTimeout(resolve,1000));
    state = read(); const proof = state.view.qualification;
    if (state.view.revision !== request.expected_revision || !proof || proof.review_id !== request.review_id || proof.expires_at <= Date.now()
      || state.qualified_suite_revision !== state.suite_revision || proof.suites.some(suite => suite.revision !== suiteHistory(suite.recipe_id).head_revision)) {
      throw new Error('Saved tests changed or expired. Test the dependency plan again.');
    }
    const candidate = state.view.candidate;
    if (!candidate || state.qualified_digest !== candidate.digest) throw new Error('Candidate changed. Restage the dependency plan.');
    const receipt = { request_id: request.request_id,plan_digest: candidate.digest,applied_at: Date.now(),
      packs: candidate.packs!.map(pack => ({ pack_slug: pack.pack_slug,version: pack.version })),
      release_id: 'captured-' + request.request_id,
      ...(candidate.restore ? { restored_release_id: candidate.restore.release_id } : {}) };
    state.install_calls++; state.view.installed_version = candidate.version; state.view.applied = true; state.view.qualification = null; state.view.last_apply = receipt;
    state.applied_versions = Object.fromEntries(receipt.packs.map(pack => [pack.pack_slug,pack.version]));
    if (state.view.releases) state.view.releases = [{ release_id: receipt.release_id,sequence: state.view.releases[0]!.sequence + 1,
      created_at: receipt.applied_at,digest: candidate.digest,current: true,packs: candidate.packs!.map(pack => ({ pack_slug: pack.pack_slug,name: pack.name,version: pack.version })) },
      ...state.view.releases.map(release => ({ ...release,current: release.packs.every(pack => state.applied_versions![pack.pack_slug] === pack.version) }))];
    const result = { ...structuredClone(state.view),receipt }; state.applies[request.request_id] = { intent: JSON.stringify(request),result }; write(state);
    if (scenario === 'dependency-lost' || scenario === 'restore-lost') throw new Error('Dependency reply lost. Recover its receipt.');
    return result;
  },
  async get() { return structuredClone(read().view); },
  async stage(request: PackUpdateStage) {
    const state = read(), prior = state.requests[request.request_id];
    if (prior) { if (prior.fingerprint !== JSON.stringify(request)) throw new Error('Request id changed.'); return structuredClone(prior.view); }
    if (state.view.revision !== request.expected_revision) throw new Error('A peer staged another update. Reload update protection.');
    state.view.managed = true; state.view.revision++; state.view.qualification = null;
    state.view.candidate = { version: 2,name: manifest.name,manifest_hash: hash,digest: 'candidate',source: 'bundled',
      recipes: ['first','second'].map(id => ({ recipe_id: id,before: recipe(id),after: recipe(id,2) })) };
    if (scenario?.startsWith('dependency')) {
      state.view.candidate.packs = [{ pack_slug: 'required-fixture',name: 'Required fixture pack',installed_version: 1,version: 3,dependencies: [] },
        { pack_slug: slug,name: manifest.name,installed_version: 1,version: 2,dependencies: ['required-fixture'] }];
      state.view.candidate.recipes.forEach(entry => { entry.pack_slug = entry.recipe_id === 'second' ? 'required-fixture' : slug; });
    }
    state.requests[request.request_id] = { fingerprint: JSON.stringify(request),view: structuredClone(state.view) }; write(state);
    if (scenario === 'lost-stage' && state.view.revision === 1) throw new Error('Stage reply lost. Retry the same stage.');
    return structuredClone(state.view);
  },
  async test(request,signal) {
    const state = read(); if (state.view.revision !== request.expected_revision) throw new Error('Staged update changed.');
    state.view.qualification = null; write(state);
    if (scenario === 'missing') throw new Error('Save recipe tests for second in Kitchen before testing this update.');
    if (scenario === 'slow') await new Promise<void>((resolve,reject) => {
      const abort = () => { clearTimeout(timer); reject(signal.reason); };
      const timer = setTimeout(() => { signal.removeEventListener('abort',abort); resolve(); },20_000);
      if (signal.aborted) abort(); else signal.addEventListener('abort',abort,{ once: true });
    });
    const comparisons = [];
    for (const entry of state.view.candidate!.recipes) {
      const saved = suiteHistory(entry.recipe_id).version;
      if (!saved) throw new Error(`Save recipe tests for ${entry.recipe_id} before testing this update.`);
      const suite = saved.suite;
      comparisons.push({ ...await runRecipeRegression(suite,entry.after,signal),recipe_id: entry.recipe_id,revision: saved.revision,
        suite_digest: 'suite',baseline_hash: 'before',candidate_hash: 'after' });
    }
    signal.throwIfAborted();
    if (comparisons.every(result => result.failed === 0)) state.view.qualification = { review_id: 'passing-review',expires_at: Date.now() + 900_000,passed: 2,
      suites: comparisons.map(result => ({ recipe_id: result.recipe_id,revision: result.revision,digest: 'suite' })) };
    state.qualified_suite_revision = state.suite_revision; state.qualified_digest = state.view.candidate!.digest; write(state); return { ...structuredClone(state.view),comparisons };
  },
};
const entry = (): PackListEntry => ({ ...manifest,pre_install: false,installed: read().view.installed_version === manifest.version,installed_any_version: true,
  requires: [...manifest.requires],recipe_count: 2,recipe_refs: manifest.recipes,
  body_visibility_grant_keys: [],body_visibility_grant_count: 0,...(scenario === 'restore-missing-manifest' ? {} : { manifest }) });
const root = document.querySelector<HTMLElement>('#root')!;
mountPacksPanel({ host: root,document,initialSlug: slug,runList: async () => ({ packs: scenario === 'restore-catalog-unavailable' ? [] : [entry()],installed_versions: [{ slug,version: read().view.installed_version ?? 1 }] }),packUpdateCaller: caller,packUpdateRegressionCaller: savedTests,
  ...(scenario === 'restore-missing-manifest' || scenario === 'restore-catalog-unavailable' ? { runResolvePack: async () => {
    const state = read(); state.catalog_reads = (state.catalog_reads ?? 0) + 1; write(state);
    return { manifest: null,failure: { code: 'unresolved' as const,message: 'Catalog unavailable' } };
  } } : {}),
  runInstallPreview: async () => ({ resolved: true,will_enable: [],hidden_count: 2,update_tests: { managed: read().view.managed,manifest_hash: hash } }),
  runInstall: async args => {
    const state = read(), proof = state.view.qualification;
    if (state.view.managed && (!proof || args.regression_review_id !== proof.review_id || state.qualified_suite_revision !== state.suite_revision || proof.suites.some(suite => suite.revision !== suiteHistory(suite.recipe_id).head_revision))) throw new Error('Saved tests changed. Test the staged update again.');
    state.install_calls++; state.view.installed_version = 2; state.view.applied = true; state.view.qualification = null; write(state);
    if (scenario === 'lost-apply') throw new Error('Update reply lost. Reload update protection to check the installed version.');
    return { result: { ok: true,installed: ['first','second'].map(slug => ({ slug,publisher_id: 'recued-core',version: 2,fresh_install: false,prior: null })),rolled_back: [] } };
  },
});
