import type { SourceRegistration, WorkEntityGetRpcResponse, WorkEntitySourceFreshness } from '@recued/contracts';
import { e } from '@recued/ui-shared';
import { serializeShellRoute } from '../shell/route.js';

type Get = (args: { kind: 'task'; id: string }) => Promise<WorkEntityGetRpcResponse>;
export type TaskDependency = { state: 'loading' | 'ready' | 'missing' | 'error'; title: string; source: string;
  done?: boolean; current?: boolean; pending?: boolean; expiresAt?: number; sourceId?: string };

export const taskSourceStatus = (id: string, fresh: WorkEntitySourceFreshness | undefined, sources: readonly SourceRegistration[], now: number): { current: boolean; expiresAt?: number } => {
  const expiresAt = fresh?.state === 'fresh' && fresh.last_success_at != null && fresh.stale_after_ms !== undefined
    ? fresh.last_success_at + fresh.stale_after_ms : undefined;
  return { current: fresh ? fresh.source_id === id && ['local', 'fresh', 'read_through'].includes(fresh.state)
    && fresh.list_complete !== false && (expiresAt === undefined || now <= expiresAt) : sources.some(source => source.id === id && source.source_kind === 'builtin'), expiresAt };
};

/** Only confirmed, current completion can clear a blocker. Missing rows,
 * pending writes, stale source metadata and wrong identities remain unknown. */
export const taskDependency = (id: string, response: WorkEntityGetRpcResponse, sources: readonly SourceRegistration[], now: number): TaskDependency => {
  const task = response.entity;
  if (task && (task._kind !== 'task' || task.id !== id)) throw new Error('The linked task could not be confirmed.');
  if (!task || task.deleted_at != null || task.sync_state === 'orphaned' || task.sync_state === 'tombstoned') {
    return { state: 'missing', title: 'Unavailable task', source: '' };
  }
  if (task._kind !== 'task' || typeof task.done !== 'boolean') throw new Error('The task status could not be confirmed.');
  const source = sources.find(source => source.id === task.source_id), status = taskSourceStatus(task.source_id, response.source_freshness, sources, now);
  const current = task.sync_state === 'live' && !task.pending_write && status.current;
  return { state: 'ready', title: task.title.trim() || 'Untitled task', source: source?.source_label || 'Source unavailable',
    done: task.done, current, pending: task.pending_write !== undefined, expiresAt: status.expiresAt, sourceId: task.source_id };
};

export const dependencySummary = (values: readonly TaskDependency[], ownerUncertain = false): string => {
  const waiting = values.filter(value => value.state === 'ready' && value.current && value.done === false).length;
  const unknown = ownerUncertain || values.some(value => value.state !== 'ready' || !value.current);
  if (waiting) return `Waiting on ${waiting} ${waiting === 1 ? 'task' : 'tasks'}${unknown ? ' · Some status unconfirmed' : ''}`;
  if (values.some(value => value.state === 'loading')) return 'Checking dependencies…';
  return unknown ? 'Dependency status unavailable' : 'Dependencies complete';
};

/** Dedupe visible references and bound read concurrency across refreshes.
 * Replaced jobs cannot repaint, even when their old RPC settles much later. */
export const createTaskDependencyReader = (deps: { get?: Get; sources: () => readonly SourceRegistration[]; changed: () => void; now?: () => number }) => {
  const entries = new Map<string, TaskDependency>(), jobs = new Map<string, object>();
  let wanted = new Set<string>(), queue: string[] = [], active = 0, disposed = false;
  const now = deps.now ?? Date.now;
  const pump = () => {
    while (!disposed && active < 4 && queue.length) {
      const id = queue.shift()!; if (!wanted.has(id)) continue;
      const job = {}; jobs.set(id, job); active++;
      void (async () => {
        let value: TaskDependency;
        try {
          if (!deps.get) throw new Error('Task reads unavailable.');
          value = taskDependency(id, await deps.get({ kind: 'task', id }), deps.sources(), now());
        } catch { value = { state: 'error', title: 'Task status unavailable', source: '' }; }
        if (!disposed && wanted.has(id) && jobs.get(id) === job) { entries.set(id, value); jobs.delete(id); deps.changed(); }
      })().finally(() => { active--; pump(); });
    }
  };
  const enqueue = (id: string) => { entries.set(id, { state: 'loading', title: entries.get(id)?.title ?? 'Loading task…', source: '' }); queue.push(id); };
  const value = (id: string): TaskDependency => {
    const saved = entries.get(id) ?? { state: 'loading' as const, title: 'Loading task…', source: '' };
    const current = saved.sourceId ? { ...saved, source: deps.sources().find(source => source.id === saved.sourceId)?.source_label || saved.source } : saved;
    return current.expiresAt !== undefined && now() > current.expiresAt ? { ...current, current: false } : current;
  };
  return {
    sync(ids: readonly string[], refresh = false) {
      if (refresh) { entries.clear(); jobs.clear(); queue = []; }
      wanted = new Set(ids); queue = queue.filter(id => wanted.has(id));
      for (const id of entries.keys()) if (!wanted.has(id)) { entries.delete(id); jobs.delete(id); }
      for (const id of wanted) if (!entries.has(id)) enqueue(id);
      pump();
    },
    value,
    current: () => [...wanted].every(id => value(id).state === 'ready' && value(id).current === true),
    refresh(ids: readonly string[] = [...wanted]) {
      const selected = new Set(ids); queue = queue.filter(id => !selected.has(id));
      for (const id of selected) if (wanted.has(id)) { jobs.delete(id); enqueue(id); }
      deps.changed(); pump();
    },
    dispose() { disposed = true; wanted.clear(); entries.clear(); jobs.clear(); queue = []; },
  };
};

export interface TaskBlockerFocus { owner: string; dependency: string }
export const createTaskBlockers = (deps: { get?: Get; sources: () => readonly SourceRegistration[]; open: (target: TaskBlockerFocus) => Promise<void>;
  canOpen?: () => boolean; now?: () => number; initialExpanded?: readonly string[]; ownerStatus?: (id: string) => { current: boolean; expiresAt?: number } }) => {
  const expanded = new Set(deps.initialExpanded);
  let root: HTMLElement | null = null, disposed = false;
  let expiryTimer: number | undefined;
  const bodies = new WeakMap<HTMLElement, string>();
  let opening: TaskBlockerFocus | null = null, openError: { owner: string; message: string } | null = null;
  const owners = new Map<string, { shell: HTMLDetailsElement; ids: string[] }>();
  const reader = createTaskDependencyReader({ ...deps, changed: () => paint() });
  const focus = (target: TaskBlockerFocus) => {
    const shell = owners.get(target.owner)?.shell;
    const control = [...shell?.querySelectorAll<HTMLElement>('[data-task-blocker-focus]') ?? []]
      .find(node => node.getAttribute('data-task-blocker-focus') === target.dependency)
      ?? shell?.querySelector<HTMLElement>('summary');
    control?.focus({ preventScroll: true }); return !!control;
  };
  const paint = () => {
    const view = root?.ownerDocument?.defaultView;
    if (expiryTimer !== undefined) view?.clearTimeout(expiryTimer); expiryTimer = undefined;
    let nextExpiry = Infinity;
    for (const [owner, { shell, ids }] of owners) {
      const ownerStatus = deps.ownerStatus?.(owner), uncertain = shell.hasAttribute('data-task-blocker-uncertain') || ownerStatus?.current === false;
      if (ownerStatus?.current && ownerStatus.expiresAt !== undefined) nextExpiry = Math.min(nextExpiry, ownerStatus.expiresAt);
      const values = ids.map(id => id === owner ? { state: 'error' as const, title: 'This task depends on itself', source: '' } : reader.value(id));
      for (const value of values) if (value.current && value.expiresAt !== undefined) nextExpiry = Math.min(nextExpiry, value.expiresAt);
      const summary = shell.querySelector<HTMLElement>('[data-task-blocker-summary]');
      if (summary) summary.textContent = dependencySummary(values, uncertain);
      const body = shell.querySelector<HTMLElement>('[data-task-blocker-body]'); if (!body) continue;
      const active = shell.ownerDocument.activeElement as HTMLElement | null;
      const held = active && body.contains(active) ? active.getAttribute('data-task-blocker-focus') : null;
      const html = `<ul>${values.map((value, index) => {
        const id = ids[index]!;
        const status = value.state === 'loading' ? 'Checking status…' : value.state === 'missing' ? 'This linked task is no longer available.'
          : value.state === 'error' ? 'Status could not be checked.'
            : `${value.done ? 'Completed' : 'Open'}${value.current ? '' : value.pending ? ' · Awaiting source confirmation' : ' · Last saved status; may be out of date'}`;
        return `<li>${value.state === 'ready' ? `<a href="${e(serializeShellRoute('data', 'task', id))}" data-task-blocker-open="${e(id)}" data-task-blocker-focus="${e(id)}"${opening ? ' aria-disabled="true"' : ''}>${e(value.title)}</a>`
          : `<span>${e(value.title)}</span>`}<span class="task-blocker-meta">${e([value.source, status].filter(Boolean).join(' · '))}</span></li>`;
      }).join('')}</ul>${uncertain ? '<p>The saved dependency list may be out of date.</p>' : ''}
      ${opening?.owner === owner ? '<p role="status">Opening task…</p>' : ''}${openError?.owner === owner ? `<p role="alert">${e(openError.message)}</p>` : ''}
      <button type="button" data-task-blocker-refresh data-task-blocker-focus="refresh"${values.some(value => value.state === 'loading') ? ' aria-disabled="true" aria-busy="true"' : ''}>Check dependencies again</button>`;
      if (bodies.get(body) !== html) { body.innerHTML = html; bodies.set(body, html); if (held) focus({ owner, dependency: held }); }
    }
    if (Number.isFinite(nextExpiry) && view?.setTimeout) expiryTimer = view.setTimeout(paint, Math.max(1, Math.min(60_000, nextExpiry - (deps.now?.() ?? Date.now()) + 1)));
  };
  const onToggle = (event: Event) => { const shell = event.target as HTMLDetailsElement; const owner = shell.getAttribute?.('data-task-blockers');
    if (owner) { if (shell.open) { expanded.add(owner); paint(); } else expanded.delete(owner); } };
  const onClick = (event: Event) => {
    const target = event.target as HTMLElement | null, shell = target?.closest<HTMLDetailsElement>('[data-task-blockers]');
    const owner = shell?.getAttribute('data-task-blockers'); if (!owner) return;
    if (target?.closest('[data-task-blocker-refresh]')) {
      event.preventDefault(); const ids = owners.get(owner)?.ids ?? [];
      if (!ids.some(id => id !== owner && reader.value(id).state === 'loading')) reader.refresh(ids); return;
    }
    const link = target?.closest<HTMLElement>('[data-task-blocker-open]'), dependency = link?.getAttribute('data-task-blocker-open');
    if (!dependency || !link) return;
    // Modified link activation keeps the browser's normal new-tab behavior.
    const mouse = event as MouseEvent;
    if (mouse.metaKey || mouse.ctrlKey || mouse.shiftKey || mouse.altKey || mouse.button > 0) return;
    event.preventDefault(); if (opening || deps.canOpen?.() === false) return;
    opening = { owner, dependency }; openError = null; paint(); const visit = opening;
    void deps.open(visit).catch(error => {
      if (!disposed && opening === visit) openError = { owner, message: error instanceof Error ? error.message : 'This task could not be opened. Try again.' };
    }).finally(() => { if (!disposed && opening === visit) { opening = null; paint(); } });
  };
  return {
    mount(nextRoot: HTMLElement, refresh = false) {
      if (typeof nextRoot.querySelectorAll !== 'function' || !nextRoot.ownerDocument) return;
      if (root !== nextRoot) { root?.removeEventListener('click', onClick); root?.removeEventListener('toggle', onToggle, true);
        root = nextRoot; root.addEventListener('click', onClick); root.addEventListener('toggle', onToggle, true); }
      for (const [owner, { shell }] of owners) { if (shell.open) expanded.add(owner); else expanded.delete(owner); }
      owners.clear();
      root.querySelectorAll<HTMLDetailsElement>('[data-task-blockers]').forEach(shell => {
        const owner = shell.getAttribute('data-task-blockers'); if (!owner) return;
        let ids: unknown; try { ids = JSON.parse(shell.getAttribute('data-task-blocker-ids') ?? '[]'); } catch { ids = []; }
        if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !id)) return;
        owners.set(owner, { shell, ids: [...new Set<string>(ids)] }); shell.open = expanded.has(owner);
      });
      reader.sync([...new Set([...owners.values()].flatMap(value => value.ids))], refresh); paint();
    },
    expanded: () => [...expanded], focus,
    current: () => reader.current() && [...owners].every(([owner, { shell, ids }]) => !ids.includes(owner)
      && !shell.hasAttribute('data-task-blocker-uncertain') && deps.ownerStatus?.(owner).current !== false),
    captureFocus: () => { const active = root?.ownerDocument?.activeElement as HTMLElement | null; const owner = active?.closest('[data-task-blockers]')?.getAttribute('data-task-blockers');
      return owner ? { owner, dependency: active?.getAttribute('data-task-blocker-focus') ?? 'summary' } : null; },
    refresh: () => reader.refresh(),
    dispose() { disposed = true; reader.dispose(); if (expiryTimer !== undefined) root?.ownerDocument?.defaultView?.clearTimeout(expiryTimer);
      root?.removeEventListener('click', onClick); root?.removeEventListener('toggle', onToggle, true); owners.clear(); },
  };
};
