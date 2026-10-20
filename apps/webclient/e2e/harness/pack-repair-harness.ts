import { mountPacksPanel } from '../../src/settings/packs-panel.js';
import type { PackRepairCaller } from '../../src/settings/pack-repair-caller.js';
import type { PackRepairEntry, PackRepairPlan, PackRepairApplyResult, PackRepairReview, PackRepairApply } from '@recued/contracts';
const scenario = new URLSearchParams(location.search).get('scenario') ?? '', key = 'recued-pack-repair-fixture', slug = 'orphan-fixture';
interface State {
  generation: number; writes: number; scans: number; apply_calls: number; installed: boolean; failed_once: boolean;
  reviews: Record<string, { request: PackRepairReview; plan: PackRepairPlan; generation: number }>;
  receipts: Record<string, { request: PackRepairApply; result: PackRepairApplyResult }>;
  applies: PackRepairApply[];
}
if (!sessionStorage.getItem(key)) sessionStorage.setItem(key, JSON.stringify({ generation: 1, writes: 0, scans: 0, apply_calls: 0, installed: false, failed_once: false, reviews: {}, receipts: {}, applies: [] }));
const read = (): State => JSON.parse(sessionStorage.getItem(key)!);const write = (state: State) => sessionStorage.setItem(key, JSON.stringify(state));
const entry = (): PackRepairEntry => {
  const state = read();return { pack: { inventory_key: slug, pack_slug: slug, publisher: 'fixture-publisher' }, inventory: state.installed, recipes: [], ingredients: [],
    metadata: { grants: state.writes ? 0 : 1, body_grants: 0, bindings: state.writes ? 0 : 1, defaults: 0, holders: 0, templates: 0, protection: !state.writes, history: !state.writes },
    ...(state.writes && scenario === 'lost-records' ? { records_state: 'ready' as const } : {}),
    removal: 'unconfirmed', findings: [{ code: 'orphaned_metadata', message: 'Local metadata remains after an interrupted removal.' }], next_step: scenario === 'missing' ? 'install' : 'review_cleanup' };
};
const caller: PackRepairCaller = {
  async inspect() {
    const state = read();state.scans++;write(state);
    if (scenario === 'scan-error' && state.scans === 1) throw new Error('Local inspection unavailable. Retry inspection.');
    return { inspected_at: Date.now(), entries: state.writes ? [] : [entry()], unattributed_manifests: ['unowned-local-body'], unavailable_receipts: 0,
      recent_repairs: Object.values(state.receipts).map(item => ({ request: item.request, receipt: item.result.receipt })) };
  },
  async review(request) {
    const state = read(), prior = state.reviews[request.request_id];if (prior) return structuredClone(prior.plan);
    const plan: PackRepairPlan = { review_id: 'review-' + request.request_id, expires_at: Date.now() + (scenario === 'expiry' ? 500 : 300000), entry: entry(), action: state.writes ? 'none' : 'retire_orphaned_metadata',
      blockers: state.writes ? [{ code: 'no_supported_repair', message: 'No supported local cleanup is proven.' }] : scenario === 'blocked' ? [{ code: 'ambiguous', message: 'Resolve conflicting publisher evidence before local cleanup.' }] : [],
      changes: ['Revoke 1 pack-owned operation grant.', 'Remove 1 catalog binding. Connection credentials stay enrolled.', 'Retire retained release history.'],
      manifests_removed: [], ingredients_removed: [], ingredients_kept: ['shared-catalog'], connections: ['fixture-account'],
      unknown_dependencies: scenario === 'unknown' ? [{ inventory_key: 'older-pack', pack_slug: 'older-pack' }] : [], would_disable: ['surviving-recipe'], would_degrade: [] };
    state.reviews[request.request_id] = { request, plan, generation: state.generation };write(state);
    if (scenario === 'lost-review' && Object.keys(state.reviews).length === 1) throw new Error('Review reply lost.');return structuredClone(plan);
  },
  async apply(request) {
    let state = read();state.apply_calls++;state.applies.push(request);write(state);
    const prior = state.receipts[request.review_id];
    if (prior) {
      if (scenario === 'evicted') throw new Error('This repair receipt is no longer retained.');
      if (JSON.stringify(request) !== JSON.stringify(prior.request)) throw new Error('Repair attempt identity changed.');
      return { ...structuredClone(prior.result), current: entry(), reconciliation_pending: false };
    }
    if (scenario === 'slow') await new Promise<void>(resolve => window.addEventListener('finish-repair', () => resolve(), { once: true }));
    state = read();const review = Object.values(state.reviews).find(item => item.plan.review_id === request.review_id)!;
    if (scenario === 'drift' && !state.failed_once) { state.failed_once = true;state.generation++;write(state); }
    if (review.generation !== state.generation || review.plan.expires_at <= Date.now()) throw new Error('Local state changed. Review repair again.');
    if (review.plan.blockers.length || !request.acknowledge_local_cleanup || review.plan.unknown_dependencies.length && !request.acknowledge_unknown_dependencies) throw new Error('Repair acknowledgement required.');
    state.writes++;state.installed = scenario === 'lost-reinstalled';write(state);
    const result: PackRepairApplyResult = { receipt: { review_id: request.review_id, request_id: request.request_id, completed_at: Date.now(), pack: review.plan.entry.pack,
      action: 'retire_orphaned_metadata', changes: review.plan.changes }, current: entry(), reconciliation_pending: scenario === 'reconcile' };
    state.receipts[request.review_id] = { request, result };write(state);
    if (scenario === 'lost' || scenario === 'lost-reinstalled' || scenario === 'lost-records') throw new Error('Completion reply lost.');return result;
  },
};
const panel = mountPacksPanel({ host: document.querySelector<HTMLElement>('#root')!, document, packRepairCaller: caller,
  runList: async () => ({ packs: [], installed_versions: [] }) });
window.addEventListener('refresh-repair-list', () => panel.refresh());
window.addEventListener('query-repair-work', () => { document.body.dataset.busy = String(panel.hasInFlightWork()); });
