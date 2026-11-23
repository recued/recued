import { TASK_PRIORITIES, type ContactRecord, type TaskPriority, type SourceRegistration, type WorkEntity } from '@recued/contracts';
import { e, type RefPicker } from '@recued/ui-shared';
import type { DataContactGetCaller, DataContactListCaller, DataTaskMarkDoneCaller, DataWorkEntityGetCaller, DataWorkEntitySearchCaller, DataWorkEntityUpsertCaller, WorkEntitySourceListCaller } from './bootstrap-data-route.js';
import { humanizeRpcError } from '../shell/rpc-error-copy.js';
import { createTaskBulkProjectPicker, loadTaskProjectPreview, sameTaskProject, type BulkTaskProject, type TaskProjectChange } from './task-bulk-projects.js';
import { createTaskBulkContactPicker, loadTaskContactPreview, sameTaskContact, taskHasContact, type TaskContactChange } from './task-bulk-contacts.js';

type Task = Extract<WorkEntity, { _kind: 'task' }>;
type WriteAction = { kind: 'complete' } | { kind: 'reopen' } | { kind: 'date'; due: number } | { kind: 'clear' } | { kind: 'priority'; priority: TaskPriority }
  | { kind: 'project'; target: BulkTaskProject | null } | { kind: 'contact'; target: ContactRecord | null };
type Action = WriteAction | { kind: 'shift'; days: number };
type Result = { task: Task; state: 'waiting' | 'running' | 'confirmed' | 'failed' | 'unconfirmed' | 'skipped'; writeAttempted: boolean; message?: string; targetDue?: number; projectChange?: TaskProjectChange; contactChange?: TaskContactChange };
type ShiftPreview = { kind: 'shift'; days: number; rows: Result[] };
type ProjectPreview = { kind: 'project'; remove: boolean; loading: boolean; target: BulkTaskProject | null; rows: Result[]; error?: string };
type ContactPreview = { kind: 'contact'; remove: boolean; loading: boolean; target: ContactRecord | null; rows: Result[]; error?: string };
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
const achieved = (task: Task, action: WriteAction): boolean => action.kind === 'complete' ? task.done
  : action.kind === 'reopen' ? !task.done : action.kind === 'priority' ? task.priority === action.priority
    : action.kind === 'clear' ? task.due_at === undefined : action.kind === 'project'
      ? (task.parent_project_id ?? null) === (action.target?.id ?? null)
      : action.kind === 'contact' ? taskHasContact(task, action.target) : task.due_at === action.due;
const dueDay = (value: string): number | null => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(value + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? date.getTime() : null;
};
const DAY_MS = 86_400_000;
const shiftLabel = (days: number): string => `${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} ${days > 0 ? 'later' : 'earlier'}`;
const validDeadline = (value: number): boolean => Number.isFinite(value)
  && new Date(value).getUTCFullYear() >= 1 && new Date(value).getUTCFullYear() <= 9999;
const deadlineLabel = (value: number | undefined): string => value === undefined ? 'No due date'
  : !validDeadline(value) ? 'Invalid due date' : new Date(value).toISOString().replace(/T00:00:00\.000Z$/, '').replace('T', ' ').replace(/\.000Z$/, ' UTC').replace(/Z$/, ' UTC');

/** One owner-selected batch. Each task still goes through the existing guarded
 * mutation RPC; the ledger distinguishes confirmed writes from source-pending ones. */
export const createTaskBulkActions = (deps: {
  root?: ParentNode;
  rows: () => readonly WorkEntity[];
  sources: () => readonly SourceRegistration[];
  ready?: () => boolean;
  get?: DataWorkEntityGetCaller;
  search?: DataWorkEntitySearchCaller;
  contactList?: DataContactListCaller;
  contactGet?: DataContactGetCaller;
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
  let preview: ShiftPreview | ProjectPreview | ContactPreview | null = null;
  let projectChoice: RefPicker.RefPickerSelection | null = null, projectPreviewSequence = 0;
  let contactChoice: RefPicker.RefPickerSelection | null = null, contactPreviewSequence = 0;
  let busy = false, stopping = false, disposed = false;
  let date = '', priority = '', shiftDays = '1', error = '';
  let moreOpen = false;
  let pending: Promise<void> = Promise.resolve();
  let focusRequest: string | null = null;
  const enabled = (): boolean => !!deps.get && !!deps.listSources && (!!deps.complete || !!deps.update);
  const ready = (): boolean => deps.ready?.() ?? true;
  const rows = (): Task[] => deps.rows().filter((row): row is Task => row._kind === 'task');
  const reason = (task: Task): string | undefined => unavailable(task, deps.sources());
  const paint = (): void => { if (!disposed) deps.render(); };
  const setProject = (value: RefPicker.RefPickerSelection | null): void => {
    if (disposed || busy || preview || results.length || !selected.size) return;
    projectChoice = value ? { ...value } : null; error = ''; paint();
  };
  const projectPicker = createTaskBulkProjectPicker({ search: deps.search, choose: setProject });
  const setContact = (value: RefPicker.RefPickerSelection | null): void => {
    if (disposed || busy || preview || results.length || !selected.size) return;
    contactChoice = value ? { ...value } : null; error = ''; paint();
  };
  const contactPicker = createTaskBulkContactPicker({ search: deps.contactList, choose: setContact });
  const reset = (): void => {
    if (busy) return;
    selected.clear(); results = []; action = null; preview = null; date = ''; priority = ''; shiftDays = '1'; error = ''; focusRequest = null; moreOpen = false;
    projectPreviewSequence++; projectChoice = null; projectPicker.reset();
    contactPreviewSequence++; contactChoice = null; contactPicker.reset();
  };
  const selection = () => {
    const visible = rows(), reasons = new Map<string, string>();
    for (const task of visible) {
      const why = reason(task);
      if (why) reasons.set(task.id, why);
    }
    if (!busy && !preview && results.length === 0 && ready()) {
      for (const id of selected.keys()) if (!visible.some(row => row.id === id) || reasons.has(id)) selected.delete(id);
    }
    return { selected_ids: new Set(selected.keys()), unavailable: reasons, busy: busy || !!preview || results.length > 0 || !ready() };
  };
  const toggle = (id: string, checked: boolean): void => {
    if (busy || preview || results.length || !enabled() || !ready()) return;
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
      if (result.state === 'skipped') continue;
      // A shift is converted to the previewed absolute target, including on
      // retry. Never calculate another offset from a possibly saved deadline.
      const requested: WriteAction = chosen.kind === 'shift' ? { kind: 'date', due: result.targetDue! } : chosen;
      if (stopping) { result.state = 'failed'; result.message = result.writeAttempted
        ? 'Retry not started: you stopped the batch.' : 'Not started: you stopped the batch.'; continue; }
      result.state = 'running'; result.message = undefined; paint();
      try {
        // Fresh reads are also reconciliation after a lost reply. Do not send a
        // second write for an action whose requested state is already confirmed.
        const [{ entity }, { sources }, project, contact] = await Promise.all([deps.get({ kind: 'task', id: result.task.id }), deps.listSources(),
          chosen.kind === 'project' && chosen.target ? deps.get({ kind: 'project', id: chosen.target.id }) : undefined,
          chosen.kind === 'contact' && chosen.target ? deps.contactGet!({ email: chosen.target.contact_id! }) : undefined]);
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
        if (chosen.kind === 'project' && chosen.target && !sameTaskProject(project?.entity ?? null, chosen.target, sources)) {
          throw new Error('The destination project changed identity or is no longer available. Start another selection to review it.');
        }
        if (chosen.kind === 'contact' && chosen.target && !sameTaskContact(contact?.contact ?? null, chosen.target)) {
          throw new Error('The assigned contact changed identity or is no longer available. Start another selection to review it.');
        }
        if (achieved(entity, requested)) {
          result.state = 'confirmed'; selected.delete(result.task.id); deps.confirmed(entity); continue;
        }
        if (checkOnly) { result.state = 'unconfirmed'; result.message = 'The source has not confirmed the requested change. Open the task to check it.'; continue; }
        if (chosen.kind === 'project' && entity.parent_project_id !== result.task.parent_project_id) {
          result.state = 'skipped'; result.message = 'The project link changed after the preview. Left unchanged; start another selection to review it.';
          continue;
        }
        if (chosen.kind === 'contact' && entity.assigned_contact_id !== result.task.assigned_contact_id) {
          result.state = 'skipped'; result.message = 'The assigned contact changed after the preview. Left unchanged; start another selection to review it.';
          continue;
        }
        if (chosen.kind === 'shift' && (entity.done || entity.due_at !== result.task.due_at)) {
          result.state = 'skipped'; result.message = entity.done ? 'This task was completed after the preview. Its due date was left alone.'
            : 'The due date changed after the preview. Left unchanged; start another selection to review it.';
          continue;
        }
        if (entity.done && (chosen.kind === 'date' || chosen.kind === 'clear')) throw new Error('This task was completed before this change. Its due date was left alone.');
        result.writeAttempted = true;
        const out = requested.kind === 'complete' || requested.kind === 'reopen'
          ? await deps.complete!({ id: entity.id, done: requested.kind === 'complete' })
          : await deps.update!({ kind: 'task', id: entity.id, ...(requested.kind === 'priority' ? { priority: requested.priority }
            : requested.kind === 'clear' ? { clear_due_at: true } : requested.kind === 'project'
              ? requested.target ? { parent_project_id: requested.target.id } : { clear_parent_project: true }
              : requested.kind === 'contact' ? requested.target ? { assigned_contact_id: requested.target.email } : { clear_assigned_contact: true }
                : { due_at: requested.due }) });
        if (disposed) break;
        if (!sameTask(out.entity, result.task) || !achieved(out.entity, requested) || out.entity.pending_write) {
          result.state = 'unconfirmed'; result.message = sameTask(out.entity, result.task) && achieved(out.entity, requested) && out.entity.pending_write
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
    if (kind === 'complete' || kind === 'reopen' ? !deps.complete : !deps.update) return pending;
    if (kind === 'contact') {
      if (!deps.contactGet || preview?.kind !== 'contact' || preview.loading || preview.error || !preview.remove && !preview.target || !preview.rows.some(row => row.state === 'waiting')) return pending;
      action = { kind, target: preview.target }; results = preview.rows.map(row => ({ ...row })); preview = null;
      pending = run(results, false); return pending;
    }
    if (kind === 'project') {
      if (preview?.kind !== 'project' || preview.loading || preview.error || !preview.remove && !preview.target || !preview.rows.some(row => row.state === 'waiting')) return pending;
      action = { kind, target: preview.target }; results = preview.rows.map(row => ({ ...row })); preview = null;
      pending = run(results, false); return pending;
    }
    if (kind === 'shift') {
      if (preview?.kind !== 'shift' || !preview.rows.some(row => row.state === 'waiting')) return pending;
      action = { kind, days: preview.days }; results = preview.rows.map(row => ({ ...row })); preview = null;
      pending = run(results, false); return pending;
    }
    if (preview) return pending;
    if ((kind === 'date' || kind === 'clear') && [...selected.values()].some(task => task.done)) {
      error = 'Select only unfinished tasks to change due dates.'; focusRequest = 'selection'; paint(); return pending;
    }
    if (kind === 'priority' && !TASK_PRIORITIES.includes(priority as TaskPriority)) {
      error = 'Choose Low, Medium, or High priority.'; focusRequest = 'priority'; paint(); return pending;
    }
    const due = kind === 'date' ? dueDay(date) : null;
    if (kind === 'date' && due === null) {
      error = 'Choose a valid due date. It applies to the whole day.'; focusRequest = 'date'; paint(); return pending;
    }
    action = kind === 'date' ? { kind, due: due! } : kind === 'priority' ? { kind, priority: priority as TaskPriority } : { kind };
    results = [...selected.values()].map(task => ({ task, state: 'waiting', writeAttempted: false }));
    pending = run(results, false); return pending;
  };
  const previewShift = (): void => {
    if (busy || disposed || preview || results.length || !selected.size || !enabled() || !deps.update || !ready()) return;
    const days = Number(shiftDays);
    if (!shiftDays.trim() || !Number.isSafeInteger(days) || days === 0 || !Number.isSafeInteger(days * DAY_MS)) {
      error = 'Choose a nonzero whole number of days. Positive moves later; negative moves earlier.';
      focusRequest = 'shift-days'; paint(); return;
    }
    preview = { kind: 'shift', days, rows: [...selected.values()].map(task => {
      const targetDue = task.due_at === undefined ? undefined : task.due_at + days * DAY_MS;
      const message = reason(task) ?? (task.done ? 'Completed task; due date left alone.' : task.due_at === undefined
        ? 'No due date to shift.' : !validDeadline(task.due_at) || !validDeadline(targetDue!) ? 'The shifted deadline is outside the supported date range.' : undefined);
      return { task, state: message ? 'skipped' : 'waiting', writeAttempted: false, message, ...(message ? {} : { targetDue }) };
    }) };
    error = ''; focusRequest = 'preview'; paint();
  };
  const previewProjects = (remove = false): Promise<void> => {
    if (busy || disposed || preview || results.length || !selected.size || !enabled() || !deps.update || !ready()) return pending;
    if (!remove && !projectChoice) { error = 'Choose a project by name before previewing.'; focusRequest = 'project-search'; paint(); return pending; }
    const sequence = ++projectPreviewSequence;
    const plan: ProjectPreview = { kind: 'project', remove, loading: true, target: null,
      rows: [...selected.values()].map(task => ({ task, state: 'waiting', writeAttempted: false })) };
    const targetId = remove ? undefined : projectChoice!.id;
    const current = () => !disposed && preview === plan && projectPreviewSequence === sequence;
    preview = plan; error = ''; focusRequest = 'preview'; paint();
    pending = (async () => {
      try {
        const loaded = await loadTaskProjectPreview({ tasks: plan.rows.map(row => row.task), targetId, get: deps.get!,
          sources: deps.sources, current, unavailable: reason });
        if (!current() || !loaded) return;
        plan.target = loaded.target;
        plan.rows = loaded.rows.map(row => ({ ...row, state: row.message ? 'skipped' : 'waiting', writeAttempted: false }));
      } catch (failure) { if (current()) plan.error = humanizeRpcError(failure); }
      finally { if (current()) { plan.loading = false; focusRequest = 'preview'; paint(); } }
    })();
    return pending;
  };
  const previewContacts = (remove = false): Promise<void> => {
    if (busy || disposed || preview || results.length || !selected.size || !enabled() || !deps.update || !deps.contactGet || !ready()) return pending;
    if (!remove && !contactChoice) { error = 'Choose a contact by name or email before previewing.'; focusRequest = 'contact-search'; paint(); return pending; }
    const sequence = ++contactPreviewSequence;
    const plan: ContactPreview = { kind: 'contact', remove, loading: true, target: null,
      rows: [...selected.values()].map(task => ({ task, state: 'waiting', writeAttempted: false })) };
    const targetId = remove ? undefined : contactChoice!.id;
    const current = () => !disposed && preview === plan && contactPreviewSequence === sequence;
    preview = plan; error = ''; focusRequest = 'preview'; paint();
    pending = (async () => {
      try {
        const loaded = await loadTaskContactPreview({ tasks: plan.rows.map(row => row.task), targetId, get: deps.contactGet!, current, unavailable: reason });
        if (!current() || !loaded) return;
        plan.target = loaded.target;
        plan.rows = loaded.rows.map(row => ({ ...row, state: row.message ? 'skipped' : 'waiting', writeAttempted: false }));
      } catch (failure) { if (current()) plan.error = humanizeRpcError(failure); }
      finally { if (current()) { plan.loading = false; focusRequest = 'preview'; paint(); } }
    })();
    return pending;
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
    // Read the native disclosure before a repaint, including a preview visit.
    // This preserves typed fields and focus without repaints on toggle events.
    moreOpen = count ? deps.root?.querySelector<HTMLDetailsElement>('[data-task-bulk-more]')?.open ?? moreOpen : false;
    if (results.length) {
      const confirmed = results.filter(row => row.state === 'confirmed').length;
      const failed = results.filter(row => row.state === 'failed').length;
      const unconfirmed = results.filter(row => row.state === 'unconfirmed').length;
      const skipped = results.filter(row => row.state === 'skipped').length;
      return `<section class="task-bulk task-bulk-results" aria-label="Task batch results" tabindex="-1" ${focusAttr('results')} ${busy ? 'aria-busy="true"' : ''}>
        <h3>${action?.kind === 'complete' ? 'Complete tasks' : action?.kind === 'reopen' ? 'Reopen tasks'
          : action?.kind === 'priority' ? `Set priority to ${action.priority[0]!.toUpperCase() + action.priority.slice(1)}` : action?.kind === 'shift' ? `Shift deadlines ${shiftLabel(action.days)}` : action?.kind === 'project' ? action.target ? `Assign tasks to ${e(action.target.title)}` : 'Remove tasks from their projects' : action?.kind === 'contact' ? action.target ? 'Change assigned contacts' : 'Clear assigned contacts' : action?.kind === 'clear' ? 'Clear due dates' : 'Set due dates'}</h3>
        <p role="status" aria-live="polite">${confirmed} confirmed · ${failed} failed · ${unconfirmed} waiting for confirmation${action?.kind === 'shift' || action?.kind === 'project' || action?.kind === 'contact' ? ` · ${skipped} skipped` : ''}${busy ? ` · ${results.filter(row => row.state === 'waiting' || row.state === 'running').length} remaining` : ''}</p>
        <ul>${results.map(result => `<li><div class="task-bulk-result-task"><strong>${e(result.task.title)}</strong><span>${e(deps.sources().find(source => source.id === result.task.source_id)?.source_label ?? 'Source unavailable')}</span></div>
          <div class="task-bulk-result-outcome">${result.targetDue !== undefined ? `<p>${e(deadlineLabel(result.task.due_at))} → ${e(deadlineLabel(result.targetDue))}</p>` : ''}${result.projectChange ? `<p>${e(result.projectChange.from)} → ${e(result.projectChange.to)}</p>` : ''}${result.contactChange ? `<p>${e(result.contactChange.from)} → ${e(result.contactChange.to)}</p>` : ''}<span class="task-bulk-state" data-state="${result.state}">${result.state === 'confirmed' ? 'Confirmed' : result.state === 'running' ? 'Changing…' : result.state === 'waiting' ? 'Waiting' : result.state === 'failed' ? 'Failed' : result.state === 'skipped' ? 'Skipped' : 'Not confirmed'}</span>${result.message ? `<p>${e(result.message)}</p>` : ''}</div></li>`).join('')}</ul>
        <div class="task-bulk-buttons">${busy ? button('stop', stopping ? 'Stopping after this task…' : 'Stop after current task', stopping)
          : `${failed ? button('retry', 'Retry failed', false, true) : ''}${unconfirmed ? button('check', 'Check unconfirmed') : ''}${button('reset', 'Start another selection')}`}</div>
      </section>`;
    }
    if (preview?.kind === 'project') {
      const changing = preview.rows.filter(row => row.state === 'waiting').length;
      const removing = preview.remove;
      return `<section class="task-bulk task-bulk-results" aria-label="Task project preview" tabindex="-1" ${focusAttr('preview')}${preview.loading ? ' aria-busy="true"' : ''}>
        <h3>${preview.remove ? 'Remove selected project links' : 'Assign selected tasks to a project'}</h3>
        ${preview.loading ? '<p role="status">Loading project preview…</p>' : preview.error ? `<p role="alert">${e(preview.error)}</p>` : `
        <p role="status" aria-live="polite">${changing} task${changing === 1 ? '' : 's'} will change · ${preview.rows.length - changing} skipped</p>
        <p>Each task has one project. Moving a task replaces its current project link. Links changed since this preview are left alone when checked before saving.</p>
        <ul>${preview.rows.map(row => `<li><div class="task-bulk-result-task"><strong>${e(row.task.title)}</strong><span>${e(deps.sources().find(source => source.id === row.task.source_id)?.source_label ?? 'Source unavailable')}${row.task.done ? ' · Completed' : ''}</span></div>
          <div class="task-bulk-result-outcome"><p>${e(row.projectChange?.from ?? '')} → ${e(row.projectChange?.to ?? '')}</p>${row.message ? `<p>Skipped: ${e(row.message)}</p>` : row.task.parent_project_id && !removing ? '<p>Moves out of its current project.</p>' : ''}</div></li>`).join('')}</ul>`}
        <div class="task-bulk-buttons">${button('project-apply', 'Apply project changes', preview.loading || !!preview.error || !preview.remove && !preview.target || !changing || !ready(), true)}${preview.error ? button('project-retry', 'Retry preview') : ''}${button('project-back', 'Back to selection')}</div>
      </section>`;
    }
    if (preview?.kind === 'contact') {
      const changing = preview.rows.filter(row => row.state === 'waiting').length;
      return `<section class="task-bulk task-bulk-results" aria-label="Task contact preview" tabindex="-1" ${focusAttr('preview')}${preview.loading ? ' aria-busy="true"' : ''}>
        <h3>${preview.remove ? 'Clear assigned contacts' : 'Change assigned contacts'}</h3>
        ${preview.loading ? '<p role="status">Loading contact preview…</p>' : preview.error ? `<p role="alert">${e(preview.error)}</p>` : `
        <p role="status" aria-live="polite">${changing} task${changing === 1 ? '' : 's'} will change · ${preview.rows.length - changing} skipped</p>
        <p>Open and completed tasks are included. Assignments changed since this preview are left alone when checked before saving.</p>
        <ul>${preview.rows.map(row => `<li><div class="task-bulk-result-task"><strong>${e(row.task.title)}</strong><span>${e(deps.sources().find(source => source.id === row.task.source_id)?.source_label ?? 'Source unavailable')}${row.task.done ? ' · Completed' : ''}</span></div>
          <div class="task-bulk-result-outcome"><p>${e(row.contactChange?.from ?? '')} → ${e(row.contactChange?.to ?? '')}</p>${row.message ? `<p>Skipped: ${e(row.message)}</p>` : ''}</div></li>`).join('')}</ul>`}
        <div class="task-bulk-buttons">${button('contact-apply', 'Apply contact changes', preview.loading || !!preview.error || !preview.remove && !preview.target || !changing || !ready(), true)}${preview.error ? button('contact-retry', 'Retry preview') : ''}${button('contact-back', 'Back to selection')}</div>
      </section>`;
    }
    if (preview?.kind === 'shift') {
      const moving = preview.rows.filter(row => row.state === 'waiting').length;
      return `<section class="task-bulk task-bulk-results" aria-label="Deadline shift preview" tabindex="-1" ${focusAttr('preview')}>
        <h3>Shift deadlines ${shiftLabel(preview.days)}</h3>
        <p role="status" aria-live="polite">${moving} task${moving === 1 ? '' : 's'} will move · ${preview.rows.length - moving} skipped</p>
        <p>Dates and times are shown in UTC. Each day is 24 hours; time of day and spacing stay the same. Changed deadlines are left alone when applying.</p>
        <ul>${preview.rows.map(row => `<li><div class="task-bulk-result-task"><strong>${e(row.task.title)}</strong><span>${e(deps.sources().find(source => source.id === row.task.source_id)?.source_label ?? 'Source unavailable')}</span></div>
          <div class="task-bulk-result-outcome"><p>${e(deadlineLabel(row.task.due_at))}${row.targetDue === undefined ? '' : ` → ${e(deadlineLabel(row.targetDue))}`}</p>${row.message ? `<p>Skipped: ${e(row.message)}</p>` : ''}</div></li>`).join('')}</ul>
        <div class="task-bulk-buttons">${button('shift-apply', 'Apply deadline shift', !moving || !ready(), true)}${button('shift-back', 'Back to selection')}</div>
      </section>`;
    }
    const hasOpen = [...selected.values()].some(task => !task.done), hasDone = [...selected.values()].some(task => task.done);
    return `<section class="task-bulk${count ? '' : ' task-bulk--idle'}" aria-label="Task selection" tabindex="-1" ${focusAttr('selection')}>
      <div class="task-bulk-heading"><strong role="status" aria-live="polite">${count ? `${count} task${count === 1 ? '' : 's'} selected` : 'Change tasks together'}</strong>
        <div class="task-bulk-buttons">${button('all', 'Select shown', !ready() || !rows().some(row => !reason(row)))}${count ? button('reset', 'Clear selection') : ''}</div></div>
      <p>Available tasks shown here are included, including completed tasks. Up to ${TASK_BULK_LIMIT} per batch.</p>
      ${count ? `<div class="task-bulk-commands">${deps.complete && hasOpen ? button('complete', 'Complete selected', !ready(), true) : ''}${deps.complete && hasDone ? button('reopen', 'Reopen selected', !ready()) : ''}
        ${deps.update ? `<details class="task-bulk-more" data-task-bulk-more${moreOpen ? ' open' : ''}><summary ${focusAttr('more')}>More changes</summary>
        <div class="task-bulk-more-content"><div class="task-bulk-basic-changes">
        <div class="task-bulk-priority-actions" role="group" aria-label="Change selected priorities"><label>Priority <select aria-label="Priority" data-action="task-bulk-priority" ${focusAttr('priority')}${ready() ? '' : ' disabled'}><option value=""${priority === '' ? ' selected' : ''}>Choose priority</option>${TASK_PRIORITIES.map(value => `<option value="${value}"${priority === value ? ' selected' : ''}>${value[0]!.toUpperCase() + value.slice(1)}</option>`).join('')}</select></label>${button('priority-save', 'Set priority', !ready(), true)}</div>
        ${hasOpen ? `<div class="task-bulk-date-actions" role="group" aria-label="Change selected due dates"><label>Due date <input type="date" data-action="task-bulk-date" ${focusAttr('date')} value="${e(date)}"${ready() && !hasDone ? '' : ' disabled'}></label>${button('date-save', 'Set due date', !ready() || hasDone, true)}${button('clear', 'Clear due dates', !ready() || hasDone)}</div>` : ''}</div>
        <p>Priority applies to every selected task.${hasDone ? ' Select only unfinished tasks to set or clear due dates.' : ' The chosen due date applies to the whole day.'}</p>
        <div class="task-bulk-shift-actions" role="group" aria-label="Shift selected deadlines">
          ${button('shift-day', 'Preview +1 day', !ready())}${button('shift-week', 'Preview +1 week', !ready())}
          <label>Days to shift <input type="number" step="1" data-action="task-bulk-shift-days" ${focusAttr('shift-days')} value="${e(shiftDays)}"${ready() ? '' : ' disabled'}></label>${button('shift-preview', 'Preview shift', !ready())}
        </div><p>Positive moves later; negative moves earlier. Tasks without a due date and completed tasks are skipped.</p>
        <fieldset class="task-bulk-project-actions"${ready() ? '' : ' disabled'}><legend>Organize selected tasks</legend>
          ${deps.search ? projectPicker.render(projectChoice) : '<p>Project search is unavailable on this server.</p>'}
          <div class="task-bulk-buttons">${button('project-preview', 'Preview project assignment', !ready() || !projectChoice || !deps.search)}${button('project-remove', 'Preview removing project links', !ready())}</div>
        </fieldset>
        ${deps.contactGet ? `<fieldset class="task-bulk-project-actions"${ready() ? '' : ' disabled'}><legend>Assign selected tasks</legend>
          ${deps.contactList ? contactPicker.render(contactChoice) : '<p>Contact search is unavailable on this server.</p>'}
          <div class="task-bulk-buttons">${button('contact-preview', 'Preview contact assignment', !ready() || !contactChoice || !deps.contactList)}${button('contact-remove', 'Preview clearing assignments', !ready())}</div>
        </fieldset>` : ''}</div></details>` : ''}</div>` : ''}
      ${error ? `<p role="alert">${e(error)}</p>` : ''}
    </section>`;
  };
  return {
    enabled, selection, render, toggle, submit, retry, previewShift, previewProjects, setProject, previewContacts, setContact,
    mountProjectPicker: (root: ParentNode) => { projectPicker.mount(root, projectChoice); contactPicker.mount(root, contactChoice); },
    busy: () => busy,
    holdsList: () => selected.size > 0 || results.length > 0,
    snapshot: () => results.map(row => ({ ...row })),
    whenSettled: () => pending,
    reset,
    handleAction(key: string): boolean {
      if (!key.startsWith('task-bulk-')) return false;
      const command = key.slice('task-bulk-'.length);
      if (command === 'all' && !busy && !preview && !results.length && ready()) {
        const wasEmpty = selected.size === 0;
        for (const task of rows()) if (!reason(task) && selected.size < TASK_BULK_LIMIT) selected.set(task.id, { ...task });
        if (wasEmpty && selected.size > 0) deps.selectionStarted?.();
        paint();
      } else if (command === 'reset' && !busy) { reset(); focusRequest = 'all'; paint(); }
      else if (command === 'stop' && busy) { stopping = true; paint(); }
      else if (command === 'complete') void submit('complete');
      else if (command === 'reopen') void submit('reopen');
      else if (command === 'priority-save') void submit('priority');
      else if (command === 'date-save') void submit('date');
      else if ((command === 'shift-day' || command === 'shift-week') && !busy && !preview && !results.length) {
        shiftDays = command === 'shift-day' ? '1' : '7'; previewShift();
      }
      else if (command === 'shift-preview') previewShift();
      else if (command === 'shift-apply') void submit('shift');
      else if (command === 'shift-back' && !busy && preview?.kind === 'shift') { preview = null; focusRequest = 'shift-preview'; paint(); }
      else if (command === 'project-preview') void previewProjects();
      else if (command === 'project-remove') void previewProjects(true);
      else if (command === 'project-apply') void submit('project');
      else if (command === 'project-back' && !busy && preview?.kind === 'project') {
        focusRequest = preview.remove ? 'project-remove' : 'project-preview'; projectPreviewSequence++; preview = null; paint();
      }
      else if (command === 'project-retry' && preview?.kind === 'project' && preview.error) {
        const remove = preview.remove; preview = null; void previewProjects(remove);
      }
      else if (command === 'contact-preview') void previewContacts();
      else if (command === 'contact-remove') void previewContacts(true);
      else if (command === 'contact-apply') void submit('contact');
      else if (command === 'contact-back' && !busy && preview?.kind === 'contact') {
        focusRequest = preview.remove ? 'contact-remove' : 'contact-preview'; contactPreviewSequence++; preview = null; paint();
      }
      else if (command === 'contact-retry' && preview?.kind === 'contact' && preview.error) {
        const remove = preview.remove; preview = null; void previewContacts(remove);
      }
      else if (command === 'clear') void submit('clear');
      else if (command === 'retry') void retry();
      else if (command === 'check') void retry(true);
      return true;
    },
    setDate(value: string) { if (!busy && !preview && !results.length) { date = value; error = ''; } },
    setShiftDays(value: string) {
      if (busy || preview || results.length) return;
      shiftDays = value;
      // A number input reports an empty value while '-' is being typed.
      // Replacing it at that point would discard the browser's partial input.
      if (error && value !== '') { error = ''; paint(); }
    },
    setPriority(value: string) {
      if (busy || preview || results.length) return;
      priority = value;
      if (error) { error = ''; paint(); }
    },
    restoreFocus(root: ParentNode, key: string | null): void {
      if (disposed) return;
      const request = focusRequest; focusRequest = null;
      // Async completion owns only controls inside the batch. A tab, source
      // picker or other control the owner moved to keeps its own focus.
      const owned = request !== null && key !== null;
      const wanted = owned ? request : key;
      if (!wanted) return;
      const escape = (value: string) => value.replace(/["\\]/g, '\\$&');
      // Restore the picker input before its listeners are reattached. A host
      // repaint must not turn a closed, committed picker into a new search.
      const control = (wanted === 'project-search' || wanted === 'contact-search' ? root.querySelector<HTMLElement>(`[data-ref-picker="task-bulk-${wanted === 'project-search' ? 'project' : 'contact'}"] [data-ref-picker-input]`) : null)
        ?? root.querySelector<HTMLElement>(`[${TASK_BULK_FOCUS}="${escape(wanted)}"]:not(:disabled)`)
        ?? (key !== null ? root.querySelector<HTMLElement>(`[${TASK_BULK_FOCUS}="results"], [${TASK_BULK_FOCUS}="selection"]`) : null);
      control?.focus({ preventScroll: !owned || wanted === key });
    },
    dispose() { disposed = true; projectPreviewSequence++; contactPreviewSequence++; projectPicker.reset(); contactPicker.reset(); selected.clear(); },
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
.task-bulk-commands,.task-bulk-date-actions,.task-bulk-priority-actions,.task-bulk-shift-actions { display:flex; align-items:end; flex-wrap:wrap; gap:.65rem; }
.task-bulk-more { min-width:0; }
.task-bulk-more[open] { flex-basis:100%; }
.task-bulk-more > summary { box-sizing:border-box; width:fit-content; min-height:var(--wc-control-h,40px); padding:8px 12px; border:1px solid var(--border-strong); border-radius:var(--wc-radius,9px); font-size:13px; line-height:1.5; cursor:pointer; }
.task-bulk-more-content { display:grid; gap:12px; margin-top:12px; min-width:0; }
.task-bulk-basic-changes { display:flex; flex-wrap:wrap; gap:16px; align-items:start; }
.task-bulk-more-content .task-bulk-priority-actions,
.task-bulk-more-content .task-bulk-date-actions { border:0; padding:0; margin:0; }
.task-bulk-shift-actions { border-top:1px solid var(--border); padding-top:.75rem; }
.task-bulk-shift-actions input { width:7rem; }
.task-bulk-project-actions { display:grid; gap:.65rem; min-width:0; margin:0; padding:.75rem; border:1px solid var(--border); border-radius:.4rem; }
.task-bulk-project-actions legend { padding:0 .3rem; font-size:.85rem; }
.task-bulk-date-actions,.task-bulk-priority-actions { border-left:1px solid var(--border); padding-left:1rem; margin-left:.35rem; }
.task-bulk label { display:grid; gap:.35rem; font-size:.85rem; }
.task-bulk input,.task-bulk select { padding:.6rem; border:1px solid var(--border); border-radius:.4rem; background:var(--surface); color:var(--fg); font:inherit; }
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
@media(max-width:600px) { .task-bulk-results li { grid-template-columns:minmax(0,1fr); gap:.5rem; } .task-bulk-date-actions,.task-bulk-priority-actions { flex-basis:100%; border-left:0; border-top:1px solid var(--border); padding:1rem 0 0; margin:.35rem 0 0; } }
/* On a phone the idle bar is one row, so the first task stays above the fold; what
   "Select shown" includes is said once a selection starts. */
@media(max-width:600px) { .task-bulk--idle { margin:.5rem 0; padding:.6rem .75rem; } .task-bulk--idle .task-bulk-heading { flex-wrap:nowrap; } .task-bulk--idle .task-bulk-heading > strong { min-width:0; } .task-bulk--idle > p:not([role=alert]) { display:none; } }
`;
