import { mountPacksPanel } from '../../src/settings/packs-panel.js';
import type { PackRemovalCaller } from '../../src/settings/pack-removal-caller.js';
import type { PackRemovalPlan,PackRemovalApplyResult,BulkPackManifest,PackListEntry } from '@recued/contracts';
const scenario = new URLSearchParams(location.search).get('scenario') ?? '',slug = 'removal-fixture',key = 'recued-pack-removal-fixture';
const withdrawn = scenario === 'withdrawn' || scenario === 'lost-refresh-withdrawn';
interface State { installed: boolean; generation: number; review_calls: number; apply_calls: number; writes: number; legacy_calls: number; catalog_calls: number;
  requests: Record<string,{ fingerprint: string; plan: PackRemovalPlan; generation: number }>;
  receipts: Record<string,{ fingerprint: string; result: PackRemovalApplyResult }>; apply_requests: unknown[]; failed_once?: boolean }
const initial = (): State => ({ installed: true,generation: 1,review_calls: 0,apply_calls: 0,writes: 0,legacy_calls: 0,catalog_calls: 0,requests: {},receipts: {},apply_requests: [] });
if (!sessionStorage.getItem(key)) sessionStorage.setItem(key,JSON.stringify(initial()));
const read = (): State => JSON.parse(sessionStorage.getItem(key)!);const write = (state: State) => sessionStorage.setItem(key,JSON.stringify(state));
const pack = { inventory_key: slug,pack_slug: slug,publisher: 'recued-core',version: scenario === 'older' ? 1 : 2 };
const plan = (review_id: string,publisher?: string): PackRemovalPlan => ({ review_id,expires_at: Date.now() + (scenario === 'expiry' && read().review_calls === 1 ? 500 : 300_000),pack: { ...pack,...(publisher ? { publisher } : {}) },
  publisher_choices: scenario === 'publishers' ? ['publisher-one','publisher-two'] : ['recued-core'],
  blockers: scenario === 'blocked' ? [{ code: 'dependants',message: 'Remove the dependent packs first.' }] : scenario === 'publishers' && !publisher ? [{ code: 'ambiguous',message: 'Choose the installed publisher before reviewing removal.' }]
    : !read().installed ? [{ code: 'not_installed',message: 'This pack is no longer installed.' }] : [],
  dependants: scenario === 'blocked' ? [{ inventory_key: 'dependent-pack',pack_slug: 'dependent-pack',version: 2,direct: true,via: [slug] }] : [],
  unknown_dependencies: scenario === 'unknown' ? [{ inventory_key: 'older-pack',pack_slug: 'older-pack',version: 1 }] : [],
  dependencies_kept: [{ inventory_key: 'shared-provider',pack_slug: 'shared-provider',version: 3 }],ingredients: { removed: ['exclusive-catalog'],shared: ['shared-catalog'] },
  recipes: ['owned-recipe'],bundled_recipes_kept: [],owned: { schedules: 2,automations: 1,recipes_with_settings: 1 },runtime: { would_disable: ['surviving-recipe'],would_degrade: [] },
  protection: { roots: [slug],release_history: true },prior_attempt_unconfirmed: scenario === 'unconfirmed' });
const caller: PackRemovalCaller = {
  async review(request) {
    const state = read();state.review_calls++;write(state);
    if (scenario === 'unavailable') throw new Error('Reviewed removal is unavailable on this server.');
    const prior = state.requests[request.request_id];if (prior) { if (prior.fingerprint !== JSON.stringify(request)) throw new Error('Review request changed.');return structuredClone(prior.plan); }
    const value = plan('review-'+request.request_id,request.publisher);state.requests[request.request_id] = { fingerprint: JSON.stringify(request),plan: value,generation: state.generation };write(state);
    if (scenario === 'lost-review' && state.review_calls === 1) throw new Error('Review reply lost. Retry the same request.');return structuredClone(value);
  },
  async apply(request) {
    let state = read();state.apply_calls++;state.apply_requests.push(request);write(state);
    const prior = state.receipts[request.review_id];if (prior) { if (prior.fingerprint !== JSON.stringify(request)) throw new Error('Removal identity changed.');return { ...structuredClone(prior.result),installed_now: state.installed }; }
    const review = Object.values(state.requests).find(item => item.plan.review_id === request.review_id)!;
    if (scenario === 'slow') await new Promise<void>(resolve => window.addEventListener('finish-removal',() => resolve(),{ once: true }));state = read();
    if (scenario === 'drift' && !state.failed_once) { state.failed_once = true;state.generation++;write(state); }
    if (state.generation !== review.generation || review.plan.expires_at <= Date.now()) throw new Error('The installed state changed. Review removal again.');
    if (review.plan.blockers.length || review.plan.unknown_dependencies.length && !request.acknowledge_unknown_dependencies
      || review.plan.prior_attempt_unconfirmed && !request.acknowledge_incomplete_attempt) throw new Error('Removal acknowledgement missing.');
    state.writes++;const failed = scenario === 'partial';if (!failed) state.installed = false;
    const result: PackRemovalApplyResult = { installed_now: state.installed,receipt: { review_id: request.review_id,request_id: request.request_id,pack_slug: slug,completed_at: Date.now(),
      result: failed ? { ok: false,removed: { recipes: [],body_grants: [] },failure: { code: 'unexpected',message: 'Partial cleanup failed.' } }
        : { ok: true,removed: { recipes: ['owned-recipe'],body_grants: [] } } } };
    state.receipts[request.review_id] = { fingerprint: JSON.stringify(request),result };write(state);
    if (scenario === 'lost-reinstalled') { state.installed = true;state.generation++;write(state); }
    if (scenario === 'lost' || scenario === 'lost-reinstalled' || scenario.startsWith('lost-refresh')) throw new Error('Removal reply lost. Recover its receipt.');return result;
  },
};
const manifest: BulkPackManifest = { manifest_version: 1,slug,publisher: 'recued-core',name: 'Removal fixture',description: 'Use a local removal fixture.',version: 2,
  recipes: [{ slug: 'owned-recipe',version: 1 }],requires: ['install_bulk_pack'],tags: [] };
const entry = (): PackListEntry => ({ ...manifest,pre_install: false,installed: read().installed && scenario !== 'older',installed_any_version: read().installed,recipe_count: 1,
  recipe_refs: manifest.recipes,body_visibility_grant_keys: [],body_visibility_grant_count: 0,...(scenario === 'missing-manifest' ? {} : { manifest }) });
const panel = mountPacksPanel({ host: document.querySelector<HTMLElement>('#root')!,document,initialSlug: slug,packRemovalCaller: caller,
  runList: async () => ({ packs: withdrawn ? [] : [entry()],installed_versions: read().installed ? [{ slug,version: pack.version }] : [] }),
  runUninstall: async () => { const state = read();state.legacy_calls++;write(state);throw new Error('Use the reviewed removal flow.'); },
  ...(scenario === 'missing-manifest' || withdrawn ? { runResolvePack: async () => {
    const state = read();state.catalog_calls++;write(state);return { manifest: null,failure: { code: 'unresolved' as const,message: 'Catalog unavailable' } };
  } } : {}),
});

window.addEventListener('refresh-removal-list',() => panel.refresh());
