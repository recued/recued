import type { SourceRegistration, WorkEntity } from '@recued/contracts';
import { e } from '@recued/ui-shared';
import type { DataTaskMarkDoneCaller, DataWorkEntityGetCaller, DataWorkEntityUpsertCaller, WorkEntitySourceListCaller } from './bootstrap-data-route.js';
import { humanizeRpcError } from '../shell/rpc-error-copy.js';

type Task = Extract<WorkEntity, { _kind: 'task' }>;
type Action = { kind: 'complete' } | { kind: 'date'; due: number } | { kind: 'clear' };
type Result = { task: Task; state: 'waiting' | 'running' | 'confirmed' | 'failed' | 'unconfirmed'; writeAttempted: boolean; message?: string };
export const TASK_BULK_FOCUS = 'data-task-bulk-focus';
export const TASK_BULK_LIMIT = 100;

const unavailable = (task: Task, sources: readonly SourceRegistration[]): string | undefined => {
  const source = sources.find(row => row.id === task.source_id);
  if (task.deleted_at != null || task.sync_state !== 'live') return 'This task is not available for changes.';
  if (source?.top_tier_kind !== 'task' || !source.write_capable || source.sync_posture === 'read_through') return 'This source is read-only or unavailable.';
  if (task.pending_write) return 'A change is waiting for source confirmation.';
  return undefined;
};
const sameTask = (value: WorkEntity | null, task: Task): value is Task => value?._kind === 'task'
  && value.id === task.id && value.source_id === task.source_id && value.source_record_id === task.source_record_id
  && value.created_at === task.created_at && value.deleted_at == null && value.sync_state === 'live';
const achieved = (task: Task, action: Action): boolean => action.kind === 'complete' ? task.done
  : action.kind === 'clear' ? task.due_at === undefined : task.due_at === action.due;
const dueDay = (value: string): number | null => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(value + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? date.getTime() : null;
};

/** One owner-selected batch. Each task still goes through the existing guarded
 * mutation RPC; the ledger distinguishes confirmed writes from source-pending ones. */
export const createTaskBulkActions = (deps: {
  rows: () => readonly WorkEntity[];
  sources: () => readonly SourceRegistration[];
  ready?: () => boolean;
  get?: DataWorkEntityGetCaller;
  listSources?: WorkEntitySourceListCaller;
  complete?: DataTaskMarkDoneCaller;
  update?: DataWorkEntityUpsertCaller;
  render: () => void;
  selectionStarted?: () => void;
  begin: () => void;
  confirmed: (task: Task) => void;
  settled: () => void;
}) => {
  const selected = new Map<string, Task>();
  let results: Result[] = [], action: Action | null = null;
  let busy = false, stopping = false, disposed = false;
  let date = '', error = '';
  let pending: Promise<void> = Promise.resolve();
  let focusRequest: string | null = null;
  const enabled = (): boolean => !!deps.get && !!deps.listSources && (!!deps.complete || !!deps.update);
  const ready = (): boolean => deps.ready?.() ?? true;
  const rows = (): Task[] => deps.rows().filter((row): row is Task => row._kind === 'task');
  const reason = (task: Task): string | undefined => unavailable(task, deps.sources()) ?? (task.done ? 'This task is already completed.' : undefined);
  const paint = (): void => { if (!disposed) deps.render(); };
  const reset = (): void => {
    if (busy) return;
    selected.clear(); results = []; action = null; date = ''; error = ''; focusRequest = null;
  };
  const selection = () => {
    const visible = rows(), reasons = new Map<string, string>();
    for (const task of visible) {
      const why = reason(task);
      if (why) reasons.set(task.id, why);
    }
    if (!busy && results.length === 0 && ready()) {
      for (const id of selected.keys()) if (!visible.some(row => row.id === id) || reasons.has(id)) selected.delete(id);
    }
    return { selected_ids: new Set(selected.keys()), unavailable: reasons, busy: busy || results.length > 0 || !ready() };
  };
  const toggle = (id: string, checked: boolean): void => {
    if (busy || results.length || !enabled() || !ready()) return;
    const task = rows().find(row => row.id === id);
    if (!task || reason(task)) return;
    const wasEmpty = selected.size === 0;
    if (!checked) selected.delete(id);
    else if (selected.size < TASK_BULK_LIMIT) selected.set(id, { ...task });
    else error = `Choose up to ${TASK_BULK_LIMIT} tasks at a time.`;
    if (wasEmpty && selected.size > 0) deps.selectionStarted?.();
    paint();
  };
  const run = async (targets: Result[], checkOnly: boolean): Promise<void> => {
    if (busy || disposed || !action || !deps.get || !deps.listSources) return;
    const chosen = action;
    busy = true; stopping = false; error = '';
    deps.begin(); paint();
    for (const result of targets) {
      if (disposed) break;
      if (stopping) { result.state = 'failed'; result.message = result.writeAttempted
        ? 'Retry not started: you stopped the batch.' : 'Not started: you stopped the batch.'; continue; }
      result.state = 'running'; result.message = undefined; paint();
      try {
        // Fresh reads are also reconciliation after a lost reply. Do not send a
        // second write for an action whose requested state is already confirmed.
        const [{ entity }, { sources }] = await Promise.all([deps.get({ kind: 'task', id: result.task.id }), deps.listSources()]);
        if (disposed) break;
        if (!sameTask(entity, result.task)) throw new Error('This task changed identity or is no longer available. Refresh the list.');
        const why = unavailable(entity, sources);
        if (entity.pending_write) {
          result.state = result.writeAttempted ? 'unconfirmed' : 'failed';
          result.message = result.writeAttempted ? 'A change is waiting for source confirmation. The requested outcome is not confirmed.'
            : 'A change is waiting for source confirmation. This batch has not changed this task.';
          continue;
        }
        if (why) throw new Error(why);
        if (achieved(entity, chosen)) {
          result.state = 'confirmed'; selected.delete(result.task.id); deps.confirmed(entity); continue;
        }
        if (checkOnly) { result.state = 'unconfirmed'; result.message = 'The source has not confirmed the requested change. Open the task to check it.'; continue; }
        if (entity.done) throw new Error('This task was completed before this change. Its due date was left alone.');
        result.writeAttempted = true;
        const out = chosen.kind === 'complete'
          ? await deps.complete!({ id: entity.id, done: true })
          : await deps.update!({ kind: 'task', id: entity.id, ...(chosen.kind === 'clear' ? { clear_due_at: true } : { due_at: chosen.due }) });
        if (disposed) break;
        if (!sameTask(out.entity, result.task) || !achieved(out.entity, chosen) || out.entity.pending_write) {
          result.state = 'unconfirmed'; result.message = sameTask(out.entity, result.task) && achieved(out.entity, chosen) && out.entity.pending_write
            ? 'Saved here; waiting for source confirmation.' : 'The server did not confirm the requested change. Open the task to check it.';
        } else {
          result.state = 'confirmed'; selected.delete(result.task.id); deps.confirmed(out.entity);
        }
      } catch (failure) {
        if (disposed) break;
        result.state = 'failed'; result.message = humanizeRpcError(failure);
      }
    }
    busy = false;
    if (!disposed) deps.settled();
    focusRequest = 'results'; paint();
  };
  const submit = (kind: Action['kind']): Promise<void> => {
    if (busy || disposed || results.length || selected.size === 0 || !enabled() || !ready()) return pending;
    if (kind === 'complete' ? !deps.complete : !deps.update) return pending;
    const due = kind === 'date' ? dueDay(date) : null;
    if (kind === 'date' && due === null) {
      error = 'Choose a valid due date. It applies to the whole day.'; focusRequest = 'date'; paint(); return pending;
    }
    action = kind === 'date' ? { kind, due: due! } : { kind };
    results = [...selected.values()].map(task => ({ task, state: 'waiting', writeAttempted: false }));
    pending = run(results, false); return pending;
  };
  const retry = (checkOnly = false): Promise<void> => {
    if (busy || disposed) return pending;
    const targets = results.filter(row => row.state === (checkOnly ? 'unconfirmed' : 'failed'));
    if (!targets.length) return pending;
    pending = run(targets, checkOnly); return pending;
  };
  const focusAttr = (key: string): string => `${TASK_BULK_FOCUS}="${e(key)}"`;
  const button = (key: string, label: string, disabled = false, primary = false): string => `<button type="button" class="data-button${primary ? ' data-button--primary' : ''}" data-action="task-bulk-${key}" ${focusAttr(key)}${disabled ? ' disabled' : ''}>${e(label)}</button>`;
  const render = (): string => {
    if (!enabled()) return '';
    const count = selected.size;
    if (results.length) {
      const confirmed = results.filter(row => row.state === 'confirmed').length;
      const failed = results.filter(row => row.state === 'failed').length;
      const unconfirmed = results.filter(row => row.state === 'unconfirmed').length;
      return `<section class="task-bulk task-bulk-results" aria-label="Task batch results" tabindex="-1" ${focusAttr('results')} ${busy ? 'aria-busy="true"' : ''}>
        <h3>${action?.kind === 'complete' ? 'Complete tasks' : action?.kind === 'clear' ? 'Clear due dates' : 'Set due dates'}</h3>
        <p role="status" aria-live="polite">${confirmed} confirmed · ${failed} failed · ${unconfirmed} waiting for confirmation${busy ? ` · ${results.filter(row => row.state === 'waiting' || row.state === 'running').length} remaining` : ''}</p>
        <ul>${results.map(result => `<li><div class="task-bulk-result-task"><strong>${e(result.task.title)}</strong><span>${e(deps.sources().find(source => source.id === result.task.source_id)?.source_label ?? 'Source unavailable')}</span></div>
          <div class="task-bulk-result-outcome"><span class="task-bulk-state" data-state="${result.state}">${result.state === 'confirmed' ? 'Confirmed' : result.state === 'running' ? 'Changing…' : result.state === 'waiting' ? 'Waiting' : result.state === 'failed' ? 'Failed' : 'Not confirmed'}</span>${result.message ? `<p>${e(result.message)}</p>` : ''}</div></li>`).join('')}</ul>
        <div class="task-bulk-buttons">${busy ? button('stop', stopping ? 'Stopping after this task…' : 'Stop after current task', stopping)
          : `${failed ? button('retry', 'Retry failed', false, true) : ''}${unconfirmed ? button('check', 'Check unconfirmed') : ''}${button('reset', 'Start another selection')}`}</div>
      </section>`;
    }
    return `<section class="task-bulk${count ? '' : ' task-bulk--idle'}" aria-label="Task selection" tabindex="-1" ${focusAttr('selection')}>
      <div class="task-bulk-heading"><strong role="status" aria-live="polite">${count ? `${count} task${count === 1 ? '' : 's'} selected` : 'Change tasks together'}</strong>
        <div class="task-bulk-buttons">${button('all', 'Select shown', !ready() || !rows().some(row => !reason(row)))}${count ? button('reset', 'Clear selection') : ''}</div></div>
      <p>Only available, unfinished tasks shown here are included. Up to ${TASK_BULK_LIMIT} per batch.</p>
      ${count ? `<div class="task-bulk-commands">${deps.complete ? button('complete', 'Complete selected', !ready(), true) : ''}${deps.update ? `<div class="task-bulk-date-actions" role="group" aria-label="Change selected due dates"><label>Due date <input type="date" data-action="task-bulk-date" ${focusAttr('date')} value="${e(date)}"${ready() ? '' : ' disabled'}></label>${button('date-save', 'Set due date', !ready(), true)}${button('clear', 'Clear due dates', !ready())}</div>` : ''}</div>
      ${deps.update ? '<p>The chosen due date applies to the whole day.</p>' : ''}` : ''}
      ${error ? `<p role="alert">${e(error)}</p>` : ''}
    </section>`;
  };
  return {
    enabled, selection, render, toggle, submit, retry,
    busy: () => busy,
    holdsList: () => selected.size > 0 || results.length > 0,
    snapshot: () => results.map(row => ({ ...row })),
    whenSettled: () => pending,
    reset,
    handleAction(key: string): boolean {
      if (!key.startsWith('task-bulk-')) return false;
      const command = key.slice('task-bulk-'.length);
      if (command === 'all' && !busy && !results.length && ready()) {
        const wasEmpty = selected.size === 0;
        for (const task of rows()) if (!reason(task) && selected.size < TASK_BULK_LIMIT) selected.set(task.id, { ...task });
        if (wasEmpty && selected.size > 0) deps.selectionStarted?.();
        paint();
      } else if (command === 'reset' && !busy) { reset(); focusRequest = 'all'; paint(); }
      else if (command === 'stop' && busy) { stopping = true; paint(); }
      else if (command === 'complete') void submit('complete');
      else if (command === 'date-save') void submit('date');
      else if (command === 'clear') void submit('clear');
      else if (command === 'retry') void retry();
      else if (command === 'check') void retry(true);
      return true;
    },
    setDate(value: string) { if (!busy && !results.length) { date = value; error = ''; } },
    restoreFocus(root: ParentNode, key: string | null): void {
      if (disposed) return;
      const request = focusRequest; focusRequest = null;
      // Async completion owns only controls inside the batch. A tab, source
      // picker or other control the owner moved to keeps its own focus.
      const owned = request !== null && key !== null;
      const wanted = owned ? request : key;
      if (!wanted) return;
      const escape = (value: string) => value.replace(/["\\]/g, '\\$&');
      const control = root.querySelector<HTMLElement>(`[${TASK_BULK_FOCUS}="${escape(wanted)}"]:not(:disabled)`)
        ?? (key !== null ? root.querySelector<HTMLElement>(`[${TASK_BULK_FOCUS}="results"], [${TASK_BULK_FOCUS}="selection"]`) : null);
      control?.focus({ preventScroll: !owned || wanted === key });
    },
    dispose() { disposed = true; selected.clear(); },
  };
};
export type TaskBulkActions = ReturnType<typeof createTaskBulkActions>;

export const TASK_BULK_STYLES = `
.task-bulk { display:grid; gap:.75rem; padding:1rem; margin:1rem 0; border:1px solid var(--border); border-radius:.65rem; background:var(--surface); }
.task-bulk--idle { gap:.4rem; }
.task-bulk h3,.task-bulk p { margin:0; }
.task-bulk p { color:var(--muted); font-size:.85rem; }
.task-bulk [role=alert] { color:var(--danger); }
.task-bulk-heading,.task-bulk-buttons { display:flex; align-items:center; flex-wrap:wrap; gap:.65rem; }
.task-bulk-heading { justify-content:space-between; }
.task-bulk-commands,.task-bulk-date-actions { display:flex; align-items:end; flex-wrap:wrap; gap:.65rem; }
.task-bulk-date-actions { border-left:1px solid var(--border); padding-left:1rem; margin-left:.35rem; }
.task-bulk label { display:grid; gap:.35rem; font-size:.85rem; }
.task-bulk input { padding:.6rem; border:1px solid var(--border); border-radius:.4rem; background:var(--surface); color:var(--fg); font:inherit; }
.task-bulk-results ul { display:grid; gap:.6rem; margin:0; padding:0; list-style:none; }
.task-bulk-results li { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:.5rem; padding:.5rem 0; border-top:1px solid var(--border); overflow-wrap:anywhere; }
.task-bulk-result-task,.task-bulk-result-outcome { display:grid; align-content:start; gap:.25rem; }
.task-bulk-result-task strong { font-weight:600; }
.task-bulk-result-task > span { color:var(--muted); font-size:.8rem; }
.task-bulk-state { font-size:.85rem; font-weight:600; }
.task-bulk-state[data-state=confirmed] { color:var(--accent); }
.task-bulk-state[data-state=failed] { color:var(--danger); }
.work-entity-list-row:has(.work-entity-task-select) { display:grid; grid-template-columns:auto minmax(0,1fr); align-items:center; }
.work-entity-task-select { display:flex; align-items:center; justify-content:center; min-width:44px; min-height:44px; padding:.5rem; box-sizing:border-box; }
.work-entity-task-select input { width:1.15rem; height:1.15rem; accent-color:var(--accent); }
.work-entity-task-select span { position:absolute; width:1px; height:1px; padding:0; overflow:hidden; clip-path:inset(50%); white-space:nowrap; }
@media(max-width:600px) { .task-bulk-results li { grid-template-columns:minmax(0,1fr); gap:.5rem; } .task-bulk-date-actions { flex-basis:100%; border-left:0; border-top:1px solid var(--border); padding:1rem 0 0; margin:.35rem 0 0; } }
`;
