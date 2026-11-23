import { e } from '@recued/ui-shared';
import { readExactRecordLink, exactRecordNoun, type ExactRecordLinkMatch } from './exact-record-link.js';
import type { LinkOption } from './record-link-insert.js';
import { pinnedRecordIdentity } from './pinned-records.js';
import { verifyRecordLinkShortcut, type RecordLinkShortcutReaders } from './record-link-shortcuts.js';
import type { WorkLinkPreviewResult } from './work-link-preview.js';

export type RecordResultPreviewData = Extract<WorkLinkPreviewResult, { state: 'missing' }>
  | (Extract<WorkLinkPreviewResult, { state: 'ready' }> & { reference: ExactRecordLinkMatch });
export type RecordResultPreviewView = { owner: string; key: string; stamp: string; title: string } &
  (RecordResultPreviewData | { state: 'loading' | 'error'; message?: string }) & { checking?: boolean; error?: string };
const stamp = (option: LinkOption) => JSON.stringify([option.target.hash, option.received_at, option.exact?.identity, option.shortcut ? pinnedRecordIdentity(option.shortcut) : null]);
const missing = (): RecordResultPreviewData => ({ state: 'missing', message: 'This record is no longer available with the same details. Refresh the results and try again.' });

/** Explicit previews read only the chosen record. The current lifetime token is
 * checked again before the host's normal Open/Insert path is allowed to run. */
export const readRecordResultPreview = async (option: LinkOption, readers: RecordLinkShortcutReaders, href: string): Promise<RecordResultPreviewData> => {
  if (option.shortcut && !await verifyRecordLinkShortcut(option.shortcut, readers)) return missing();
  let projection: Extract<WorkLinkPreviewResult, { state: 'ready' }> | undefined, sourceLabel: string | undefined;
  const expectedAt = option.received_at ?? (option.shortcut && 'origin' in option.shortcut && 'receivedAt' in option.shortcut.origin ? option.shortcut.origin.receivedAt : undefined);
  const selected = await readExactRecordLink(option.target, { ...readers,
    ...(readers.source ? { source: async args => {
      const reply = await readers.source!(args);
      return expectedAt !== undefined && reply.record?.received_at !== expectedAt ? { ...reply, record: null } : reply;
    } } : {}),
    ...(readers.work ? { work: async (kind, id) => {
      const reply = await readers.work!(kind, id), entity = reply.entity;
      if (entity) sourceLabel = option.shortcut?.source_label || (entity.source_id === 'recued.' + entity._kind ? 'Recued' : entity.source_id);
      return reply;
    } } : {}),
  }, href, result => { projection = result; });
  if (selected.state !== 'ready') return selected;
  if (!projection || option.exact && selected.match.identity !== option.exact.identity) return missing();
  return { ...projection, details: [...(sourceLabel ? ['Source: ' + sourceLabel] : []), ...projection.details], reference: selected.match };
};

export const createRecordResultPreview = (deps: {
  owner: () => string | null; read: (option: LinkOption) => Promise<RecordResultPreviewData>;
  verify: (reference: ExactRecordLinkMatch) => Promise<boolean>; activate: (key: string, reference: ExactRecordLinkMatch) => void;
  blocked: () => boolean; changed: () => void;
}) => {
  let available = new Map<string, LinkOption>(), view: RecordResultPreviewView | null = null, binding: string | null = null, sequence = 0, disposed = false;
  const valid = (op: RecordResultPreviewView | null): op is RecordResultPreviewView => !!op && !disposed && binding === op.owner && deps.owner() === op.owner
    && !!available.get(op.key) && stamp(available.get(op.key)!) === op.stamp;
  const state = () => { if (!valid(view)) { view = null; sequence++; } return view; };
  const close = () => { sequence++; if (view) { view = null; deps.changed(); } };
  const open = async (key: string) => {
    const owner = deps.owner(), option = available.get(key); if (disposed || !owner || owner !== binding || !option || deps.blocked() || state()?.key === key && view?.state === 'loading') return;
    const visit = ++sequence, pending: RecordResultPreviewView = { owner, key, stamp: stamp(option), title: option.title, state: 'loading' };
    view = pending; deps.changed();
    try { const result = await deps.read(option); if (visit !== sequence || view !== pending || !valid(pending)) return; view = { ...pending, ...result }; }
    catch { if (visit !== sequence || view !== pending || !valid(pending)) return; view = { ...pending, state: 'error', message: 'This record could not be previewed. Try again.' }; }
    deps.changed();
  };
  return { state, open, close,
    bind(options: readonly LinkOption[]) { binding = deps.owner(); available = new Map(options.map(option => [option.key, option])); state(); },
    async activate() {
      const current = state(); if (!current || current.state !== 'ready' || current.checking || deps.blocked()) return;
      const visit = ++sequence; current.checking = true; current.error = undefined; deps.changed();
      try {
        const exists = await deps.verify(current.reference);
        if (visit !== sequence || state() !== current) return;
        current.checking = false;
        if (!exists) current.error = 'This record was removed or replaced. Close the preview and refresh the results.';
        else { const key = current.key; close(); deps.activate(key, current.reference); return; }
      } catch { if (visit !== sequence || state() !== current) return; current.checking = false; current.error = 'This record could not be checked. Try again.'; }
      deps.changed();
    },
    dispose() { disposed = true; sequence++; view = null; available.clear(); },
  };
};

export const previewResultHtml = (view: RecordResultPreviewView, action: 'Open' | 'Insert', focusAttr: string, actionAttr: string, blocked = false, activateLabel?: string): string => {
  const button = (name: string, text: string, disabled = false) => '<button type="button" ' + actionAttr + '="' + name + '" ' + focusAttr + '="preview-' + name + '"' + (disabled ? ' disabled' : '') + '>' + text + '</button>';
  const title = view.state === 'ready' ? view.title : view.title + ' preview';
  return '<section class="record-result-preview" aria-label="Record preview" data-record-result-preview-panel><header><h3 tabindex="-1" ' + focusAttr + '="preview-title">' + e(title) + '</h3>' + button('close', 'Close preview') + '</header>'
    + (view.state === 'loading' ? '<p role="status">Loading preview…</p>' : view.state === 'ready'
      ? view.details.map(detail => '<p>' + e(detail) + '</p>').join('') + (view.excerpt ? '<p class="record-result-preview-excerpt">' + e(view.excerpt) + '</p>' : '')
        + (view.warning ? '<p role="status">' + e(view.warning) + '</p>' : '')
        + (view.error ? '<p role="alert">' + e(view.error) + '</p>' : '')
      : '<p role="' + (view.state === 'error' ? 'alert' : 'status') + '">' + e(view.message ?? 'This record is unavailable.') + '</p>')
    + '<footer>' + (view.state === 'ready' ? button('activate', e(activateLabel ?? action + (action === 'Insert' ? ' link' : ' ' + exactRecordNoun(view.reference.target))), !!view.checking || blocked) : view.state !== 'loading' ? button('retry', 'Try again') : '')
    + (view.checking ? '<p role="status">Checking selected record…</p>' : '') + '</footer></section>';
};
export const RECORD_RESULT_PREVIEW_STYLES = `
.record-result-preview { min-width:0; overflow-wrap:anywhere; }
.record-result-preview header { display:flex; align-items:start; justify-content:space-between; gap:.75rem; }
.record-result-preview header h3 { margin:0; }
.record-result-preview button, .record-result-preview-trigger { padding:.5rem .75rem; min-height:44px; font:inherit; color:var(--fg); background:var(--surface); border:1px solid var(--border); border-radius:6px; cursor:pointer; }
.record-result-preview footer { margin-top:1rem; }
.record-result-preview-excerpt { white-space:pre-wrap; }
.record-result-preview-row { display:flex; align-items:stretch; gap:.5rem; min-width:0; }
.record-result-preview-row > .record-link-insert-option, .record-result-preview-row > .rq-row-btn { flex:1; min-width:0; width:auto; }
.record-result-preview-trigger { flex-shrink:0; align-self:start; }
`;
