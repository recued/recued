import { bootstrapConnectionsRoute } from '../../src/connections/bootstrap-connections-route.js';
import type { ConnectionReplacementCaller } from '../../src/connections/connection-replacement-caller.js';
import type { ConnectionReplacementInspection as Inspection, ConnectionReplacementReview as Review,
  ConnectionReplacementPlan as Plan, ConnectionReplacementApply as Apply, ConnectionReplacementResult as Result } from '@recued/contracts';
const scenario = new URLSearchParams(location.search).get('scenario') ?? '', key = 'connection-replacement-fixture';
interface State {
  writes: number; applies: Apply[]; generation: number; inspections: number; failed: boolean;
  reviews: Record<string, { request: unknown; plan: Plan; generation: number }>;
  receipts: Record<string, { request: Apply; result: Result }>;
}
if (!sessionStorage.getItem(key)) sessionStorage.setItem(key, JSON.stringify({ writes: 0, applies: [], generation: 1, inspections: 0, failed: false, reviews: {}, receipts: {} }));
const read = (): State => JSON.parse(sessionStorage.getItem(key)!);const write = (value: State) => sessionStorage.setItem(key, JSON.stringify(value));
const identities = [
  { connection_name: 'old-account', display_name: 'Old team', host: 'api.hubapi.com', identity: 'fixture-old-lineage' },
  { connection_name: 'new-account', display_name: 'New team', host: 'api.hubapi.com', identity: 'fixture-new-lineage' },
];
const pack = () => ({ pack_slug: 'hubspot', pack_name: 'HubSpot', slot: 'hubspot', catalogs: ['hubspot-catalog'], shared_with: ['shared-catalog-pack'],
  before_connections: ['old-account'], after_connections: ['new-account'], before_default: 'old-account', after_default: 'new-account', blockers: [] });
const inspection = (selected = false): Inspection => {
  const state = read();return { connections: identities, packs: selected && state.writes % 2 === 0 ? [pack()] : [],
    dishes: selected && state.writes % 2 === 0 ? [{ dish_id: 'dsh_fixture', recipe_id: 'fixture-list', name: 'Daily list', slots: ['hubspot'] }] : [],
    recent: Object.values(state.receipts).map(item => ({ request: item.request, receipt: item.result.receipt })), unavailable_receipts: 0 };
};
const saveReview = (request: unknown, requestId: string, direction: 'replace' | 'rollback', parent?: string): Plan => {
  const state = read(), prior = state.reviews[requestId];if (prior) return prior.plan;
  const selection = request as Partial<Review>;
  const plan: Plan = { review_id: 'review-' + requestId, expires_at: Date.now() + (scenario === 'expiry' ? 700 : 300000), direction,
    ...(parent ? { parent_receipt_id: parent } : {}), from: identities[direction === 'replace' ? 0 : 1]!, to: identities[direction === 'replace' ? 1 : 0]!,
    packs: direction === 'rollback' || selection.targets?.length ? [pack()] : [],
    dishes: direction === 'rollback' || selection.dish_ids?.length ? [{ dish_id: 'dsh_fixture', recipe_id: 'fixture-list', name: 'Daily list', slots: ['hubspot'] }] : [],
    impacts: [{ recipe_id: 'fixture-list', name: 'List fixture records', dish_ids: ['dsh_fixture'], schedules: 2, triggers: 1, timers: 1 }],
    blockers: scenario === 'blocked' ? [{ code: 'account_bound_settings', message: 'Saved settings contain account-bound record IDs. Review them first.' }] : [],
    changes: ['HubSpot · hubspot: old-account → new-account; shared with shared-catalog-pack', 'Daily list: saved account choice changes.'] };
  state.reviews[requestId] = { request, plan, generation: state.generation };write(state);return plan;
};
const caller: ConnectionReplacementCaller = {
  async inspect(request) {
    const state = read();state.inspections++;write(state);
    if (scenario === 'inspect-error' && state.inspections === 1) throw new Error('Inspection unavailable. Retry inspection.');
    return inspection(!!request.from_connection && !!request.to_connection);
  },
  async review(request) {
    const plan = saveReview(request, request.request_id, 'replace');
    const state = read();if (scenario === 'lost-review' && !state.failed) { state.failed = true;write(state);throw new Error('Review reply lost.'); }return structuredClone(plan);
  },
  async rollback(request) { return saveReview(request, request.request_id, 'rollback', request.receipt_id); },
  async apply(request) {
    let state = read();state.applies.push(structuredClone(request));write(state);
    const prior = state.receipts[request.review_id];
    if (prior) {
      if (scenario === 'evicted') throw new Error('This retained receipt is unavailable. Inspect the current state.');
      if (JSON.stringify(request) !== JSON.stringify(prior.request)) throw new Error('Attempt identity changed.');
      return { ...structuredClone(prior.result), current: inspection(), reconciliation_pending: false };
    }
    if (scenario === 'slow') await new Promise<void>(resolve => window.addEventListener('finish-replacement', () => resolve(), { once: true }));
    state = read();const review = Object.values(state.reviews).find(item => item.plan.review_id === request.review_id)!;
    if (scenario === 'drift' && !state.failed) { state.failed = true;state.generation++;write(state); }
    if (review.generation !== state.generation || review.plan.expires_at <= Date.now()) throw new Error('References changed. Inspect and review again.');
    if (review.plan.blockers.length || !request.acknowledge_account_change) throw new Error('Acknowledge a current unblocked plan.');
    state.writes++;
    const result: Result = { receipt: { review_id: request.review_id, request_id: request.request_id, completed_at: Date.now(), direction: review.plan.direction,
      ...(review.plan.parent_receipt_id ? { parent_receipt_id: review.plan.parent_receipt_id } : {}), from: review.plan.from, to: review.plan.to,
      packs: review.plan.packs.map(({ pack_slug, slot }) => ({ pack_slug, slot })), dish_ids: review.plan.dishes.map(dish => dish.dish_id), changes: review.plan.changes }, reconciliation_pending: scenario === 'reconcile' };
    state.receipts[request.review_id] = { request: structuredClone(request), result };write(state);
    if (scenario === 'lost' || scenario === 'evicted') throw new Error('Completion reply lost.');
    return { ...result, ...(scenario === 'current-unavailable' ? {} : { current: inspection() }) };
  },
};
const panel = bootstrapConnectionsRoute({ root: document.querySelector<HTMLElement>('#root')!, document, initialTab: 'others', connectionReplacementCaller: caller });
window.addEventListener('query-replacement-work', () => { document.body.dataset.busy = String(panel.hasInFlightWork());document.body.dataset.draft = String(panel.hasUnsavedChanges()); });
window.addEventListener('dispose-replacement', () => panel.dispose());
