import { e } from '@recued/ui-shared';
import { humanizeRpcError } from '../shell/rpc-error-copy.js';

export type WorkReaderKind = 'task' | 'note';
export const WORK_READER_ACTION = 'work-reader-';
export const WORK_READER_FOCUS = 'data-work-reader-focus';
export interface WorkReaderScope {
  kind: WorkReaderKind; key: string; generation: number; label: string;
  ids: readonly string[]; more: boolean; progress: number; error?: string; ready?: boolean;
}

/** Keep the opening order, including an anchor that leaves a filtered list
 * after an edit. Each next record is read again by the host before it opens. */
export const createWorkReaderNavigation = (deps: {
  scope: () => WorkReaderScope | null;
  reading: () => { kind: WorkReaderKind; id: string } | null;
  canLeave: () => boolean;
  more: (kind: WorkReaderKind) => Promise<void>;
  open: (kind: WorkReaderKind, id: string) => Promise<boolean>;
  changed: () => void;
  focus: (direction: 'previous' | 'next') => void;
}) => {
  let visit: { kind: WorkReaderKind; key: string; navigation: number; ids: string[]; index: number; scrollTop: number } | null = null;
  let sequence = 0, moving = false, target: string | null = null, error = '';
  const current = () => {
    const scope = deps.scope();
    return visit && scope?.kind === visit.kind && scope.key === visit.key && scope.generation === visit.navigation ? scope : null;
  };
  const reading = () => { const record = deps.reading(); return !!visit && record?.kind === visit.kind && record.id === visit.ids[visit.index]; };
  const suspend = () => { sequence++; moving = false; target = null; };
  const reset = () => { suspend(); visit = null; error = ''; };
  const append = (ids: readonly string[]) => {
    if (!visit) return;
    const known = new Set(visit.ids);
    for (const id of ids) if (!known.has(id)) { known.add(id); visit.ids.push(id); }
  };
  const move = async (direction: -1 | 1) => {
    const owner = visit;
    if (!owner || !current() || !reading() || moving || !deps.canLeave()) return;
    const token = ++sequence, alive = () => sequence === token && visit === owner;
    const valid = () => alive() && current() !== null && reading() && deps.canLeave();
    moving = true; error = ''; deps.changed();
    try {
      if (!valid()) return;
      append(current()!.ids);
      // Note searches filter loaded rows. A page can advance without adding a
      // matching row; bound one activation without inventing an end of results.
      for (let pages = 0; direction === 1 && owner.index === owner.ids.length - 1 && current()?.more; pages++) {
        if (pages === 20) throw new Error('More results may be available. Return to the list to load more.');
        const progress = current()!.progress;
        await deps.more(owner.kind);
        if (!valid()) return;
        const scope = current()!;
        if (scope.error) throw new Error(scope.error);
        append(scope.ids);
        if (scope.more && scope.progress <= progress) throw new Error('The results did not advance. Try again.');
      }
      if (!valid()) return;
      target = owner.ids[owner.index + direction] ?? null;
      if (!target) return;
      const opened = await deps.open(owner.kind, target);
      if (!alive() || !current()) return;
      if (!opened) throw new Error('This record could not be opened. Try again.');
      owner.index = owner.ids.indexOf(target);
    } catch (cause) { if (alive() && current()) error = humanizeRpcError(cause); }
    finally {
      if (alive()) {
        moving = false; target = null; deps.changed();
        if (current() && reading() && deps.canLeave()) deps.focus(direction === 1 ? 'next' : 'previous');
      }
    }
  };
  return {
    reset, suspend,
    busy: () => moving,
    start(kind: WorkReaderKind, id: string, scrollTop: number) {
      reset(); const scope = deps.scope();
      if (scope?.kind !== kind || scope.ready === false) return;
      const ids = [...new Set(scope.ids)], index = ids.indexOf(id);
      if (index >= 0) visit = { kind, key: scope.key, navigation: scope.generation, ids, index, scrollTop };
    },
    resume(kind: WorkReaderKind, id: string) {
      const scope = deps.scope();
      if (!visit || scope?.kind !== kind || visit.kind !== kind || scope.key !== visit.key || !visit.ids.includes(id)) return;
      if (scope.generation !== visit.navigation) { suspend(); visit.navigation = scope.generation; }
      if (!moving || id === target) visit.index = visit.ids.indexOf(id);
    },
    returnPosition: () => visit && current() && reading() ? { kind: visit.kind, id: visit.ids[visit.index]!, scrollTop: visit.scrollTop } : null,
    handle(action: string) {
      if (!action.startsWith(WORK_READER_ACTION)) return false;
      if (action === 'work-reader-previous') void move(-1);
      if (action === 'work-reader-next') void move(1);
      return true;
    },
    render(): string {
      const scope = current();
      if (!visit || !scope || !reading()) return '';
      const pending = moving || !deps.canLeave(), kind = visit.kind;
      const button = (direction: 'previous' | 'next', unavailable: boolean) => `<button type="button" data-action="work-reader-${direction}" ${WORK_READER_FOCUS}="${direction}" data-${kind}-focus="reader-${direction}"${unavailable ? ' disabled' : pending ? ' aria-disabled="true" aria-busy="true"' : ''}>${direction === 'previous' ? 'Previous' : 'Next'} ${kind}</button>`;
      return `<nav class="work-reader-navigation" aria-label="Browse ${kind}s"><div>${button('previous', visit.index === 0)}${button('next', visit.index === visit.ids.length - 1 && !scope.more)}<span>${e(scope.label)} · ${visit.index + 1} of ${visit.ids.length}${scope.more ? '+' : ''} loaded</span></div>${moving ? `<p role="status">Opening ${kind}…</p>` : ''}${error ? `<p role="alert">${e(error)}</p>` : ''}</nav>`;
    },
  };
};

export const WORK_READER_NAVIGATION_STYLES = `
.work-reader-navigation { padding:8px 20px; flex-shrink:0; border-bottom:1px solid var(--rx-divider,var(--border)); }
.work-reader-navigation > div { display:flex; flex-wrap:wrap; align-items:center; gap:8px; }
.work-reader-navigation button { min-height:44px; padding:8px 12px; font:inherit; color:var(--rx-fg,var(--fg)); background:var(--rx-bg,var(--surface)); border:1px solid var(--rx-divider,var(--border)); border-radius:6px; cursor:pointer; }
.work-reader-navigation button:disabled, .work-reader-navigation button[aria-disabled="true"] { opacity:.6; cursor:default; }
.work-reader-navigation button:focus-visible { outline:2px solid var(--rx-accent,var(--accent)); outline-offset:2px; }
.work-reader-navigation span, .work-reader-navigation p { font-size:12px; overflow-wrap:anywhere; }
.work-reader-navigation p { margin:8px 0 0; }
.work-reader-navigation [role="alert"] { color:var(--danger,var(--fg)); }
`;
