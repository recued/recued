import { mountAutomationRehearsalPanel } from '../../src/automation/automation-rehearsal-panel.js';
import { bootstrapAutomationRoute } from '../../src/automation/bootstrap-automation-route.js';
import { selectTriggerEvent, selectRecurringScheduleTick } from '../../../../backend/server/src/automation-start-decisions.js';
import { createAutoRunScheduler } from '@recued/scheduler';
import type { Conn, ServerRpcRegistry, RehearsalView, RehearsalTarget, RehearsalConfiguration, RehearsalDocument,
  RehearsalMutation, RehearsalComparison, RehearsalReview, RehearsalSave, RehearsalActivate, EventTrigger } from '@recued/contracts';
import type { WarehouseEvent } from '@recued/warehouse-events';
const query = new URLSearchParams(location.search), scenario = query.get('scenario'), storageKey = 'automation-rehearsal-fixture';
const kind = query.get('kind') === 'schedule' ? 'schedule' : query.get('kind') === 'timer' ? 'timer' : 'trigger';
const target: RehearsalTarget = { kind, id: kind === 'timer' ? 'fixture-dish' : 'fixture-' + kind }, instant = Date.parse('2026-10-19T00:10:00Z');
const initialConfiguration = (): RehearsalConfiguration => kind === 'trigger'
  ? { kind, enabled: false, pattern: 'data.task.main.task.created', filter: { 'record.status': 'ready' }, fields: null, watch_interval_ms: null }
  : kind === 'schedule' ? { kind, enabled: false, cron_expression: '*/5 * * * *', missed_policy: 'skip' } : { kind, enabled: false, reset_circuit: false };
const document = (): RehearsalDocument => ({ title: 'Saved automation scenarios', candidate: { ...initialConfiguration(), enabled: true }, cases: [
  { id: 'selected', name: 'Selected event or clock', expected: 'start', input: kind === 'trigger' ? { kind: 'event', source_ready: true, chat_mail: false,
    event: { platform: 'task', slug: 'main', entity_type: 'task', event_kind: 'created', record_id: 'fixture-record', at: instant, record: { status: 'ready' } } }
    : { kind: 'clock', at: instant, last_run_at: null, next_run_at: instant, running: false, auto_disabled: scenario === 'circuit' } },
] });
const initial = (): RehearsalView => ({ target, label: 'Fixture automation', supported: scenario !== 'unsupported',
  ...(scenario === 'unsupported' ? { reason: 'This automation is no longer available.' } : {}), recipe_id: 'fixture-recipe', dish_id: 'fixture-dish',
  time_zone: 'UTC', interval_ms: kind === 'timer' ? 300_000 : null, current: initialConfiguration(), revision: query.has('seed') ? 1 : 0,
  live_digest: 'basis-1', draft: query.has('seed') ? { revision: 1, digest: 'draft-1', base_digest: 'basis-1', created_at: Date.now(), document: document() } : null,
  drafts: query.has('seed') ? [{ revision: 1, title: 'Saved automation scenarios', created_at: Date.now() }] : [], qualification: null, history: [] });
interface Fixture { view: RehearsalView; applied: number; calls: Array<{ method: string; args: unknown }>; receipts: Record<string, RehearsalMutation> }
const state: Fixture = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null') ?? { view: initial(), applied: 0, calls: [], receipts: {} };
const clone = <T>(value: T): T => structuredClone(value), persist = () => sessionStorage.setItem(storageKey, JSON.stringify(state));
const trigger = (configuration = state.view.current): EventTrigger => ({ trigger_id: target.id, recipe_id: 'fixture-recipe', publisher_id: 'core', dish_id: 'fixture-dish',
  pattern: configuration?.kind === 'trigger' ? configuration.pattern : 'data.task.**', enabled: configuration?.enabled ?? false, created_at: 1,
  last_fired_at: null, last_error: null, origin: 'user',
  ...(configuration?.kind === 'trigger' && configuration.filter ? { filter: configuration.filter } : {}),
  ...(configuration?.kind === 'trigger' && configuration.fields ? { fields: configuration.fields } : {}) });
const compare = (): RehearsalComparison => {
  const doc = state.view.draft!.document;
  const decision = (configuration: RehearsalConfiguration, item: RehearsalDocument['cases'][number]) => {
    if (!configuration.enabled) return { verdict: 'skip' as const, detail: 'Automation is switched off.' };
    if (configuration.kind === 'trigger') {
      if (item.input.kind !== 'event') return { verdict: 'unsupported' as const, detail: 'Use an event scenario.' };
      const input = item.input;
      const match = input.source_ready && !input.event.in_drain && !(input.event.platform === 'mail' && input.chat_mail)
        && selectTriggerEvent(trigger(configuration), input.event as WarehouseEvent);
      return { verdict: match ? 'start' as const : 'skip' as const, detail: 'Shared pattern and payload selection.' };
    }
    if (item.input.kind !== 'clock') return { verdict: 'unsupported' as const, detail: 'Use a clock scenario.' };
    if (item.input.running) return { verdict: 'skip' as const, detail: 'Fixture has an overlapping run.' };
    if (configuration.kind === 'timer') {
      const scheduler = createAutoRunScheduler({ mintProcessId: () => 'fixture' }); scheduler.setRoster([{ recipe_id: 'fixture-recipe', publisher_id: 'core',
        dish_id: target.id, interval_ms: 300_000, dynamic: false, process_id: 'fixture', next_run_at: item.input.next_run_at,
        consecutive_failures: 0, auto_disabled: item.input.auto_disabled && !configuration.reset_circuit }]);
      return { verdict: scheduler.tick(item.input.at).fired.length ? 'start' as const : 'skip' as const, detail: 'Isolated production timer selection.' };
    }
    const chosen = selectRecurringScheduleTick({ schedule_id: target.id, recipe_id: 'fixture-recipe', publisher_id: 'core', ...configuration,
      created_at: 1, last_run_at: item.input.last_run_at, next_run_at: null, last_error: null, last_status: null }, item.input.at, 'UTC');
    return { verdict: chosen === 'regular' || chosen === 'fire' ? 'start' as const : chosen === 'ask' ? 'ask' as const : 'skip' as const, detail: 'Shared recurring schedule selection.' };
  };
  const cases = doc.cases.map(item => {
    const current = decision(state.view.current!, item), candidate = scenario === 'failed' ? { verdict: 'skip' as const, detail: 'Fixture injects a failed scenario.' } : decision(doc.candidate, item);
    return { id: item.id, name: item.name, expected: item.expected, current, candidate, passed: candidate.verdict === item.expected };
  });
  return { cases, passed: cases.filter(item => item.passed).length, failed: cases.filter(item => !item.passed).length,
    coverage: ['Scenario selection only. No provider, recipe, live cursor or queue was invoked.'] };
};
let review: RehearsalReview | null = null;
const call: Conn<ServerRpcRegistry> = async (method: keyof ServerRpcRegistry, raw?: unknown) => {
  const args = clone(raw); state.calls.push({ method, args }); persist();
  if (method === 'automation.rehearsal.get') {
    if (scenario === 'slow-reload' && state.calls.filter(item => item.method === method).length > 1) await new Promise<void>(resolve => addEventListener('finish-rehearsal', () => resolve(), { once: true }));
    const selected = (args as { draft_revision?: number }).draft_revision;
    const draft = selected === undefined ? undefined : [state.view.draft, ...Object.values(state.receipts).map(item => item.saved_draft)].find(item => item?.revision === selected)
      ?? { revision: 1, digest: 'draft-1', base_digest: 'basis-1', created_at: 1, document: document() };
    return { ...clone(state.view), ...(draft ? { selected_draft: clone(draft) } : {}) } as never;
  }
  if (method === 'automation.rehearsal.save') {
    const input = args as RehearsalSave; if (state.receipts[input.request_id]) return clone(state.receipts[input.request_id]) as never;
    const first = state.calls.filter(item => item.method === method).length === 1;
    if ((scenario === 'slow-save' || scenario === 'lost-save') && first) await new Promise<void>(resolve => addEventListener('finish-rehearsal', () => resolve(), { once: true }));
    if (input.expected_revision !== state.view.revision) throw new Error('Saved head changed. Reload the recorded result.');
    state.view.revision++; state.view.draft = { revision: state.view.revision, digest: 'draft-' + state.view.revision,
      base_digest: state.view.live_digest, created_at: Date.now(), document: clone(input.document) };
    state.view.drafts.push({ revision: state.view.revision, title: input.document.title, created_at: Date.now() }); state.view.qualification = null;
    const result: RehearsalMutation = { ...clone(state.view), mutation_revision: state.view.revision, saved_draft: clone(state.view.draft) };
    state.receipts[input.request_id] = result; persist();
    if (scenario === 'lost-save' && first) throw new Error('Save reply lost. Retry the recorded request.');
    return result as never;
  }
  if (method === 'automation.rehearsal.test') {
    state.view.qualification = null; persist();
    if (scenario === 'slow-test') await new Promise<void>(resolve => addEventListener('finish-rehearsal', () => resolve(), { once: true }));
    const comparison = compare(); if (!comparison.failed) state.view.qualification = { receipt_id: 'proof', draft_revision: state.view.draft!.revision,
      expires_at: Date.now() + 900_000, comparison }; persist(); return { ...clone(state.view), comparison } as never;
  }
  if (method === 'automation.rehearsal.prepare') {
    if (scenario === 'stale') throw new Error('Automation configuration changed. Run the current scenarios again.');
    review = { review_id: 'review', draft_revision: state.view.draft!.revision, expires_at: Date.now() + 300_000,
      before: clone(state.view.current!), after: clone(state.view.draft!.document.candidate), label: state.view.label, coverage: compare().coverage };
    return clone(review) as never;
  }
  if (method === 'automation.rehearsal.activate') {
    const input = args as RehearsalActivate; if (state.receipts[input.request_id]) return clone(state.receipts[input.request_id]) as never;
    state.view.current = clone(state.view.draft!.document.candidate); if (state.view.current.kind === 'timer') state.view.current.reset_circuit = false;
    state.applied++; state.view.revision++; state.view.live_digest = 'basis-' + state.view.revision; state.view.qualification = null;
    const activated = { sequence: state.applied, at: Date.now(), configuration: clone(state.view.current), refresh_confirmed: true as const,
      ...(state.view.draft!.document.candidate.kind === 'timer' && state.view.draft!.document.candidate.reset_circuit ? { circuit_reset: true as const } : {}) }; state.view.history.push(activated);
    const result: RehearsalMutation = { ...clone(state.view), mutation_revision: state.view.revision, activated }; state.receipts[input.request_id] = result; persist();
    if (scenario === 'lost-activation') throw new Error('Activation reply lost. Retry the recorded request.');
    return result as never;
  }
  if (method === 'automation.rehearsal.delete') {
    state.view.revision++; state.view.draft = null; state.view.drafts = []; state.view.history = []; state.view.qualification = null; persist(); return { revision: state.view.revision } as never;
  }
  throw new Error('Unexpected rehearsal fixture call: ' + method);
};
let leases = 0;
const beginWork = () => { leases++; return () => { leases--; }; };
const host = window.document.querySelector<HTMLElement>('#root')!;
const panel = query.has('route') ? bootstrapAutomationRoute({ root: host, initialSection: kind === 'trigger' ? 'triggers' : kind === 'schedule' ? 'schedules' : 'auto-run', initialDetailId: target.id,
  rehearsalCall: call, beginRehearsalWork: beginWork, recipeNamesCaller: async () => ({ recipes: [{ recipe_id: 'fixture-recipe', name: 'Fixture recipe' }] }),
  triggersListCaller: async () => ({ triggers: [trigger()] }), watchListCaller: async () => ({ watches: [] }),
  schedulesListCaller: async () => ({ schedules: kind === 'schedule' ? [{ schedule_id: target.id, recipe_id: 'fixture-recipe', publisher_id: 'core', dish_id: 'fixture-dish',
    cron_expression: '*/5 * * * *', enabled: state.view.current!.enabled, created_at: 1, last_run_at: null, next_run_at: null, last_status: null, last_error: null }] : [] }),
  autoRunListCaller: async () => ({ entries: kind === 'timer' ? [{ recipe_id: 'fixture-recipe', publisher_id: 'core', dish_id: target.id,
    dish_name: 'Fixture dish', recipe_name: 'Fixture recipe', interval_ms: 300_000, dynamic: false, enabled: state.view.current!.enabled,
    auto_disabled: false, consecutive_failures: 0, last_failure_at: null, last_failure_reason: null, next_run_at: null,
    last_started_at: null, last_finished_at: null, config_overlay: {}, variables: {} }] : [] }) })
  : mountAutomationRehearsalPanel({ host, target, call, beginWork });
addEventListener('query-rehearsal-work', () => { window.document.body.dataset.busy = String(panel.hasInFlightWork()); window.document.body.dataset.leases = String(leases);
  window.document.body.dataset.unsaved = String('hasUnsavedChanges' in panel ? panel.hasUnsavedChanges() : panel.hasInFlightWork()); });
addEventListener('dispose-rehearsal', () => panel.dispose());
addEventListener('refresh-automation', () => { if ('refresh' in panel) void panel.refresh(); });
persist();
