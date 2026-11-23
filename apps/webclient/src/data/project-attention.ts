import { isDateOnlyDue, isDuePast, dueSpan, type WorkEntity, type ProjectAttentionScope, type WorkEntityProjectItem,
  type WorkEntityProjectAttentionRpcRequest, type WorkEntityProjectAttentionRpcResponse } from '@recued/contracts';
import { humanizeRpcError, classifyRpcError } from '../shell/rpc-error-copy.js';
import { projectAttentionIssueText as issueText, type ProjectAttentionView } from '@recued/ui-shared/work-entity-page';
import type { DataWorkEntityGetCaller } from './bootstrap-data-route.js';

export type ProjectAttentionCaller = (args: WorkEntityProjectAttentionRpcRequest) => Promise<WorkEntityProjectAttentionRpcResponse>;
type Project = Extract<WorkEntity, { _kind: 'project' }>;
export const projectAttentionIdentity = (project: Pick<Project, 'id' | 'source_id' | 'source_record_id' | 'created_at'>): string =>
  JSON.stringify([project.id, project.source_id, project.source_record_id ?? null, project.created_at]);
export const projectAttentionKey = (kind: 'task' | 'commitment', row: WorkEntityProjectItem): string => JSON.stringify([kind, row.id, row.source_id, row.source_record_id ?? null, row.created_at]);
const kindOf = (scope: ProjectAttentionScope) => scope === 'blocking_commitments' ? 'commitment' as const : 'task' as const;
const count = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
const text = (s: unknown): s is string => typeof s === 'string' && !!s && s.length <= 2048 && !/[\u0000-\u001f\u007f]/u.test(s);
const scopes = ['overdue_tasks', 'due_soon_tasks', 'blocking_commitments'] as const;
const reasons = ['stale', 'incomplete', 'provider_only', 'pending_project'];
export const projectStatusUpdate = (reply: WorkEntityProjectAttentionRpcResponse, failed = false): string => {
  const p = reply.project, c = reply.counts;
  const target = p.target_completion_at === undefined ? 'No target date' : isDateOnlyDue(p.target_completion_at)
    ? new Date(p.target_completion_at).toISOString().slice(0, 10) : new Date(p.target_completion_at).toLocaleDateString(undefined, { timeZone: reply.time_zone });
  return [p.title.trim() || 'Project', 'Saved status: ' + p.state[0]!.toUpperCase() + p.state.slice(1), 'Target: ' + target,
    `Tasks: ${c.open_tasks} open, ${c.completed_tasks} completed`, `Overdue tasks: ${c.overdue_tasks}`, `Due in the next 7 days (including today): ${c.due_soon_tasks}`,
    `Outstanding blocking commitments: ${c.blocking_commitments}`, 'Scope: Explicitly linked work saved on this server.',
    'Attention dates as of: ' + new Date(reply.as_of).toLocaleString(undefined, { timeZone: reply.time_zone }) + ' (' + reply.time_zone + ')',
    ...reply.coverage.issues.map(issueText), ...(reply.coverage.omitted ? [`${reply.coverage.omitted} additional source warnings.`] : []),
    ...(failed ? ['The latest refresh failed; these are counts from the last successful read.'] : [])].join('\n');
};
export { issueText as projectAttentionIssueText };

/** One project incarnation owns the complete-count snapshot, optional list and
 * explicit read-only actions. Loading never turns an unknown count into zero. */
export const createProjectAttention = (deps: {
  project(): Project; adopt(project: Project): void; active(): boolean; caller?: ProjectAttentionCaller; get?: DataWorkEntityGetCaller; zone(): string;
  changed(): void; beforeLeave(): boolean; blocked(): boolean;
  open(kind: 'task' | 'commitment', item: WorkEntityProjectItem, response: import('@recued/contracts').WorkEntityGetRpcResponse, key: string): Promise<void> | void;
  write(value: string): Promise<boolean>; focus(key: string): void; focused(key: string): boolean; selectFallback(): void;
}) => {
  const owner = projectAttentionIdentity(deps.project());
  let disposed = false, sequence = 0, activation = 0, phase: ProjectAttentionView['phase'] = deps.caller ? 'idle' : 'unsupported';
  let snapshot: WorkEntityProjectAttentionRpcResponse | undefined, scope: ProjectAttentionScope | undefined, error: string | undefined;
  let actionError: string | undefined, actionBusy = false, copying = false, copyNotice: string | undefined, fallback: string | undefined;
  let pending: Promise<void> = Promise.resolve();
  const current = () => !disposed && projectAttentionIdentity(deps.project()) === owner;
  const paint = () => { if (current()) deps.changed(); };
  const matches = (reply: WorkEntityProjectAttentionRpcResponse, selected: typeof scope, offset: number, limit: number, window?: number) => {
    if (!reply?.project || projectAttentionIdentity(reply.project) !== owner || reply.project._kind !== 'project'
      || typeof reply.project.title !== 'string' || !['active', 'paused', 'completed', 'archived'].includes(reply.project.state) || !count(reply.project.updated_at)
      || reply.project.deleted_at != null || reply.project.sync_state === 'orphaned' || reply.project.sync_state === 'tombstoned'
      || reply.time_zone !== deps.zone() || reply.scope !== selected || reply.offset !== offset || !count(reply.as_of) || !count(reply.checked_at)
      || reply.checked_at < reply.as_of || !count(reply.upcoming_before) || reply.upcoming_before <= reply.as_of || window !== undefined && reply.as_of !== window
      || !reply.counts || Object.values(reply.counts).some(n => !count(n)) || Object.keys(reply.counts).length !== 5
      || !scopes.every(key => count(reply.counts[key])) || !count(reply.counts.open_tasks) || !count(reply.counts.completed_tasks)
      || reply.counts.overdue_tasks + reply.counts.due_soon_tasks > reply.counts.open_tasks
      || !reply.coverage || !Array.isArray(reply.coverage.issues) || reply.coverage.issues.length > 50 || !count(reply.coverage.omitted)
      || reply.coverage.issues.some(i => !i || !['project', 'task', 'commitment'].includes(i.kind) || !text(i.source_label) || !reasons.includes(i.reason))
      || !Array.isArray(reply.items) || reply.items.length > limit || !count(reply.total) || typeof reply.more !== 'boolean'
      || reply.total !== (selected ? reply.counts[selected] : 0) || !selected && reply.items.length > 0
      || reply.more !== (offset + reply.items.length < reply.total) || offset < reply.total && !reply.items.length) return false;
    const kind = selected ? kindOf(selected) : undefined;
    return reply.items.every(item => text(item.id) && text(item.source_id) && count(item.created_at) && typeof item.title === 'string' && typeof item.source_label === 'string'
      && (kind === 'task' ? item.done === false : !!item.commitment))
      && new Set(reply.items.map(item => item.id)).size === reply.items.length;
  };
  const load = (append: boolean, requested = 0): Promise<void> => {
    if (!current() || !deps.caller || append && phase === 'loading' || actionBusy || copying) return pending;
    const ticket = ++sequence, selected = scope, original = snapshot;
    let offset = append ? original?.items.length ?? 0 : 0, items = append ? [...(original?.items ?? [])] : [];
    let fixed = append ? original?.as_of : undefined;
    const goal = append ? offset + 10 : Math.max(10, requested, selected === original?.scope ? original?.items.length ?? 0 : 0);
    phase = 'loading'; error = undefined; actionError = undefined; copyNotice = undefined; fallback = undefined; paint();
    pending = (async () => {
      try {
        let reply: WorkEntityProjectAttentionRpcResponse, first: WorkEntityProjectAttentionRpcResponse | undefined;
        do {
          const limit = Math.min(50, goal - offset);
          reply = await deps.caller!({ project_id: deps.project().id, project_identity: { source_id: deps.project().source_id,
            source_record_id: deps.project().source_record_id ?? null, created_at: deps.project().created_at }, time_zone: deps.zone(),
            ...(selected ? { scope: selected } : {}), offset, limit, ...(fixed !== undefined ? { as_of: fixed } : {}) });
          if (!current() || ticket !== sequence || selected !== scope) return;
          if (!matches(reply, selected, offset, limit, fixed) || first && JSON.stringify([first.counts, first.project.updated_at]) !== JSON.stringify([reply.counts, reply.project.updated_at]))
            throw new Error('The attention page changed or could not be confirmed. Refresh project attention.');
          first ??= reply; fixed = reply.as_of;
          const ids = new Set(items.map(item => item.id)); if (reply.items.some(item => ids.has(item.id))) throw new Error('The attention page repeated a record. Refresh project attention.');
          items.push(...reply.items); offset += reply.items.length;
        } while (selected && reply.more && offset < goal);
        snapshot = { ...reply, offset: 0, items, more: items.length < reply.total }; phase = 'ready'; deps.adopt(reply.project);
      } catch (failure) {
        if (!current() || ticket !== sequence) return;
        phase = classifyRpcError(failure).code === 'unknown_method' ? 'unsupported' : 'error'; error = humanizeRpcError(failure);
      } finally { if (current() && ticket === sequence) paint(); }
    })();
    return pending;
  };
  return {
    busy: () => phase === 'loading' || actionBusy || copying,
    view(): ProjectAttentionView | undefined {
      if (!current()) return undefined;
      return { phase, snapshot, scope, error, action_error: actionError, action_busy: actionBusy, copying, copy_notice: copyNotice, fallback,
        can_open: !!deps.get, copy_available: !!snapshot && phase !== 'loading' && !actionBusy && !deps.blocked() };
    },
    restore(selected: ProjectAttentionScope, loaded: number) { if (!current()) return pending; scope = selected; return load(false, Math.max(10, Math.min(500, loaded))); },
    refresh: () => load(false), more: () => snapshot?.more && scope ? load(true) : pending,
    show(selected: ProjectAttentionScope) { if (!current() || !deps.active() || !scopes.includes(selected) || deps.blocked() || actionBusy || copying) return pending;
      scope = selected; snapshot = snapshot ? { ...snapshot, items: [], scope: undefined } : undefined; return load(false); },
    close() { if (!current() || actionBusy || copying) return; sequence++; scope = undefined; if (snapshot) snapshot = { ...snapshot, scope: undefined, items: [], total: 0, more: false }; phase = snapshot ? 'ready' : 'idle'; error = undefined; paint(); if (!snapshot) void load(false); },
    async open(key: string): Promise<void> {
      if (!current() || !deps.active() || !scope || !snapshot || phase === 'loading' || actionBusy || copying || !deps.get || deps.blocked() || !deps.beforeLeave()) return;
      const kind = kindOf(scope), item = snapshot.items.find(row => projectAttentionKey(kind, row) === key); if (!item) return;
      const ticket = ++activation, shown = snapshot; actionBusy = true; actionError = undefined; paint();
      try {
        const [reply, parent] = await Promise.all([deps.get({ kind, id: item.id }), deps.get({ kind: 'project', id: shown.project.id })]);
        if (!current() || !deps.active() || ticket !== activation || snapshot !== shown) return;
        const entity = reply.entity, project = parent.entity;
        if (project?._kind !== 'project' || projectAttentionIdentity(project) !== owner || project.deleted_at != null || project.sync_state === 'orphaned' || project.sync_state === 'tombstoned'
          || !entity || entity._kind !== kind || entity.id !== item.id || entity.source_id !== item.source_id || entity.created_at !== item.created_at
          || (entity.source_record_id ?? null) !== (item.source_record_id ?? null) || entity.deleted_at != null || entity.sync_state === 'orphaned' || entity.sync_state === 'tombstoned')
          throw new Error('This record or project was removed or replaced. Refresh project attention.');
        if (entity._kind === 'task') {
          const due = entity.due_at;
          const fits = due !== undefined && (scope === 'overdue_tasks' ? isDateOnlyDue(due) ? isDuePast(due, shown.as_of, shown.time_zone) : due < shown.as_of
            : isDateOnlyDue(due) ? dueSpan(due, shown.time_zone).end > shown.as_of && dueSpan(due, shown.time_zone).start < shown.upcoming_before : due >= shown.as_of && due < shown.upcoming_before);
          if (entity.done || entity.parent_project_id !== shown.project.id || !fits) throw new Error('This task no longer matches the attention list. Refresh project attention.');
        } else if (entity._kind === 'commitment' && (!entity.blocks_project_ids.includes(shown.project.id) || entity.lifecycle_state !== item.commitment?.lifecycle_state))
          throw new Error('This commitment or its project link changed. Refresh project attention.');
        if (deps.blocked() || !deps.active() || !deps.beforeLeave() || !current()) return;
        await deps.open(kind, item, reply, key);
      } catch (failure) { if (current() && ticket === activation) actionError = humanizeRpcError(failure); }
      finally { if (current() && ticket === activation) { actionBusy = false; paint(); } }
    },
    async copy() {
      if (!current() || !deps.active() || !snapshot || phase === 'loading' || actionBusy || copying || deps.blocked()) return;
      const value = projectStatusUpdate(snapshot, phase === 'error'), ticket = sequence, shown = snapshot;
      copying = true; copyNotice = undefined; fallback = undefined; paint(); deps.focus('attention-copy');
      let ok = false; try { ok = await deps.write(value); } catch { /* Keep the captured report for manual copying. */ }
      if (!current() || ticket !== sequence || snapshot !== shown) return;
      copying = false; if (!deps.active()) { paint(); return; }
      const carry = deps.focused('attention-copy'); copyNotice = ok ? 'Project update copied.' : 'Copy did not complete. Select the project update and copy it.';
      fallback = ok ? undefined : value; paint(); if (carry) { if (ok) deps.focus('attention-copy'); else deps.selectFallback(); }
    },
    invalidate(message: string) { sequence++; activation++; snapshot = undefined; phase = 'error'; error = message; actionBusy = false; copying = false; paint(); },
    whenLoaded: () => pending,
    dispose() { disposed = true; sequence++; activation++; },
  };
};
export type ProjectAttention = ReturnType<typeof createProjectAttention>;
