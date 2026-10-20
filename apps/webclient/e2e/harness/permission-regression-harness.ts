import { mountPermissionRegressionPanel } from '../../src/contracts/permission-regression-panel.js';
import { bootstrapContractsRoute } from '../../src/contracts/bootstrap-contracts-route.js';
import type { Conn, ServerRpcRegistry, PermissionWorkbenchView, PermissionDocument, PermissionComparison,
  PermissionMutation, PermissionReview, PermissionSave, PermissionActivate, PermissionRestore } from '@recued/contracts';
const params = new URLSearchParams(location.search), scenario = params.get('scenario'), key = 'permission-regression-fixture', contract_id = 'permission-door';
const document = (): PermissionDocument => ({ title: 'Saved permission cases', changes: [{ entry_key: 'data.task', granted: null }], cases: [
  { id: 'tasks', name: 'Task access', credential_id: 'assistant-token', expected: 'allow', target: { kind: 'collection', collection: 'task' } },
] });
const initial = (): PermissionWorkbenchView => ({ contract_id, supported: scenario !== 'unsupported', ...(scenario === 'unsupported' ? { reason: 'This agreement is inactive.' } : {}), revision: params.has('seed') ? 1 : 0,
  live_digest: 'live-1', grants: [{ entry_key: 'data.task', granted: false }], credentials: [{ id: 'assistant-token', label: 'Original assistant', active: true }],
  catalog: [{ kind: 'collection', entry_key: 'data.task', label: 'Task collection' }, { kind: 'operation', entry_key: 'core.calendar.delete', label: 'Delete calendar event', ingredient: 'calendar-delete' }], catalog_truncated: false,
  draft: params.has('seed') ? { revision: 1, digest: 'candidate-1', base_digest: 'live-1', created_at: Date.now(), document: document() } : null,
  drafts: params.has('seed') ? [{ revision: 1, title: 'Saved permission cases', created_at: Date.now() }] : [],
  history: params.has('seed') ? [{ kind: 'observed', sequence: 1, digest: 'grants-1', created_at: Date.now(), grants: [{ entry_key: 'data.task', granted: false }] }] : [], qualification: null });
interface Fixture { view: PermissionWorkbenchView; calls: Array<{ method: string; args: unknown }>; applied: number; receipts: Record<string, PermissionMutation> }
const state: Fixture = JSON.parse(sessionStorage.getItem(key) ?? 'null') ?? { view: initial(), calls: [], applied: 0, receipts: {} };
const persist = () => sessionStorage.setItem(key, JSON.stringify(state));
const clone = <T>(value: T): T => structuredClone(value);
const comparison = (): PermissionComparison => ({ cases: state.view.draft!.document.cases.map(item => ({ id: item.id, name: item.name, expected: item.expected,
  current: { verdict: 'deny', detail: 'Current read grant withholds task access.' }, candidate: { verdict: scenario === 'failed' ? 'deny' : item.expected, detail: 'Admission example only.' }, passed: scenario !== 'failed' })),
  passed: scenario === 'failed' ? 0 : state.view.draft!.document.cases.length, failed: scenario === 'failed' ? state.view.draft!.document.cases.length : 0,
  impact: { entries: [{ kind: 'trigger', id: 'bound-trigger', label: 'Task subscriber', detail: 'Bound to this agreement.' }], total: 1, truncated: false,
    coverage: ['Examples do not execute operations or consume grant uses.', 'Impact is a structural inventory, with dynamic paths outside its coverage.'] } });
let review: PermissionReview | null = null;
const call: Conn<ServerRpcRegistry> = async (method: keyof ServerRpcRegistry, raw?: unknown) => {
  const args = clone(raw); state.calls.push({ method, args }); persist();
  if (method === 'contract.regression.get') {
    const input = args as { draft_revision?: number };
    const selected = input.draft_revision === undefined ? undefined : [state.view.draft, ...Object.values(state.receipts).map(item => item.saved_draft)]
      .find(item => item?.revision === input.draft_revision) ?? { revision: 1, digest: 'candidate-1', base_digest: 'live-1', created_at: 1, document: document() };
    return { ...clone(state.view), ...(selected ? { selected_draft: clone(selected) } : {}) } as never;
  }
  if (method === 'contract.regression.save' || method === 'contract.regression.restore') {
    const input = args as PermissionSave & PermissionRestore;
    if (state.receipts[input.request_id]) return clone(state.receipts[input.request_id]) as never;
    const documentValue: PermissionDocument = method === 'contract.regression.save' ? input.document : { ...document(), title: 'Restore permission revision ' + input.sequence, changes: [{ entry_key: 'data.task', granted: false }] };
    const firstSave = state.calls.filter(item => item.method === 'contract.regression.save').length === 1;
    if ((scenario === 'slow-save' || scenario === 'lost-slow-save') && firstSave) await new Promise<void>(resolve => addEventListener('finish-permission', () => resolve(), { once: true }));
    if (input.expected_revision !== state.view.revision) throw new Error('Saved test head changed. Reload the recorded result.');
    state.view.revision++; state.view.draft = { revision: state.view.revision, digest: 'candidate-' + state.view.revision,
      base_digest: state.view.live_digest, created_at: Date.now(), document: clone(documentValue) };
    state.view.drafts.push({ revision: state.view.revision, title: documentValue.title, created_at: Date.now() }); state.view.qualification = null;
    if (!state.view.history.length) state.view.history.push({ kind: 'observed', sequence: 1, digest: 'grants-1', created_at: Date.now(), grants: clone(state.view.grants) });
    const result: PermissionMutation = { ...clone(state.view), mutation_revision: state.view.revision, saved_draft: clone(state.view.draft) };
    state.receipts[input.request_id] = result; persist();
    if (scenario === 'lost-slow-save' && firstSave) throw new Error('Save reply lost. Retry to read the recorded result.');
    return result as never;
  }
  if (method === 'contract.regression.test') {
    state.view.qualification = null; persist();
    if (scenario === 'slow-test') await new Promise<void>(resolve => addEventListener('finish-permission', () => resolve(), { once: true }));
    const result = comparison(); if (!result.failed) state.view.qualification = { receipt_id: 'passing-result', draft_revision: state.view.draft!.revision,
      candidate_digest: state.view.draft!.digest, expires_at: Date.now() + 900_000, comparison: result }; persist(); return { ...clone(state.view), comparison: result } as never;
  }
  if (method === 'contract.regression.prepare') {
    if (scenario === 'stale') throw new Error('Live policy changed. Test and review the draft again.');
    review = { review_id: 'permission-review', draft_revision: state.view.draft!.revision, candidate_digest: state.view.draft!.digest,
      live_digest: state.view.live_digest, expires_at: Date.now() + 300_000,
      changes: state.view.draft!.document.changes.map(item => ({ entry_key: item.entry_key, before: state.view.grants.find(row => row.entry_key === item.entry_key)?.granted ?? null, after: item.granted })),
      impact: comparison().impact }; return clone(review) as never;
  }
  if (method === 'contract.regression.activate') {
    const input = args as PermissionActivate;
    if (state.receipts[input.request_id]) return clone(state.receipts[input.request_id]) as never;
    for (const item of state.view.draft!.document.changes) {
      state.view.grants = state.view.grants.filter(row => row.entry_key !== item.entry_key);
      if (item.granted !== null) state.view.grants.push({ entry_key: item.entry_key, granted: item.granted });
    }
    state.applied++; state.view.revision++; state.view.live_digest = 'live-' + state.view.revision; state.view.qualification = null;
    const activated = { kind: 'activated' as const, sequence: state.view.history.at(-1)!.sequence + 1, digest: 'activated-' + state.view.revision, created_at: Date.now(), grants: clone(state.view.grants) };
    state.view.history.push(activated); const result: PermissionMutation = { ...clone(state.view), mutation_revision: state.view.revision, activated };
    state.receipts[input.request_id] = result; persist();
    if (scenario === 'lost-activation') throw new Error('Activation reply lost. Retry to read the recorded result.');
    return result as never;
  }
  if (method === 'contract.regression.delete') { state.view.revision++; state.view.draft = null; state.view.drafts = []; state.view.history = []; state.view.qualification = null;
    persist(); return { revision: state.view.revision } as never; }
  throw new Error('Unexpected fixture method: ' + method);
};
const host = documentQuery();
function documentQuery() { return window.document.querySelector<HTMLElement>('#root')!; }
let leases = 0;
const beginWork = () => { leases++; return () => { leases--; }; };
const panel = params.has('route') ? bootstrapContractsRoute({ root: host, serverUrl: 'https://fixture.invalid', initialContractId: contract_id, initialContractTab: 'ops', permissionWorkbenchCall: call, beginPermissionWork: beginWork,
  contractsListCaller: async () => ({ contracts: [{ contract_id, display_name: 'Original assistant agreement', minted_at: 1, minted_by: 'owner', scope: {}, door_types: ['mcp'], lifecycle_state: 'active' }], next_cursor: null, total: 1 }),
}) : mountPermissionRegressionPanel({ host, contractId: contract_id, call, beginWork });
addEventListener('query-permission-work', () => { window.document.body.dataset.busy = String(panel.hasInFlightWork()); window.document.body.dataset.leases = String(leases);
  window.document.body.dataset.unsaved = String('hasUnsavedChanges' in panel ? panel.hasUnsavedChanges() : panel.hasInFlightWork()); });
persist();

addEventListener('dispose-permission', () => panel.dispose());
