import type { FileAttachmentSelection, FileLifecycleMutation, FileLifecyclePreview } from '@recued/contracts';
import { e } from '@recued/ui-shared';
import { classifyRpcError, humanizeRpcError } from '../shell/rpc-error-copy.js';

export const FILE_BATCH_ACTION = 'file-batch-';
export const FILE_BATCH_FOCUS = 'data-file-batch-focus';
export const FILE_BATCH_LIMIT = 100;
type Action = 'archive' | 'restore';
type State = 'checking' | 'ready' | 'waiting' | 'running' | 'confirmed' | 'skipped' | 'failed' | 'unconfirmed';
type Result = { file: FileAttachmentSelection; state: State; preview?: FileLifecyclePreview; message?: string; failure?: string };
const localFile = (id: string): boolean => /^file:[0-9a-f]{32}$/.test(id);
const achieved = (preview: FileLifecyclePreview, action: Action): boolean => !preview.deleted && preview.archived === (action === 'archive');
const failureMessage = (cause: unknown): string => classifyRpcError(cause).code === 'unknown_method'
  ? 'Update your Recued server to manage saved files together.' : humanizeRpcError(cause);

/** A reviewed selection over existing owner RPCs. Changes use pinned revisions;
 * every write is reconciled with current reads and never retried here. */
export const createFileBatchActions = (deps: {
  files: () => readonly FileAttachmentSelection[];
  archived: () => boolean;
  active: () => boolean;
  ready: () => boolean;
  usage?: (input: { record_id: string }) => Promise<FileLifecyclePreview>;
  mutate?: (input: FileLifecycleMutation) => Promise<FileLifecyclePreview>;
  changed: () => void;
  confirmed: (id: string) => void;
}) => {
  const selected = new Map<string, FileAttachmentSelection>();
  let phase: 'selection' | 'review' | 'results' = 'selection';
  let results: Result[] = [], action: Action = 'archive';
  let reviewing = false, running = false, checking = false, stopping = false, disposed = false, sequence = 0;
  let error = '', focusRequest: string | null = null;
  let pending: Promise<void> = Promise.resolve();
  const enabled = (): boolean => !!deps.usage && !!deps.mutate;
  const current = (token: number): boolean => !disposed && token === sequence && deps.active();
  const paint = (focus?: string): void => { if (!disposed) { focusRequest = focus ?? null; deps.changed(); } };
  const prune = (): void => {
    if (phase !== 'selection' || !deps.ready()) return;
    const ids = new Set(deps.files().map(file => file.file_id));
    for (const id of selected.keys()) if (!ids.has(id)) selected.delete(id);
  };
  const reset = (): void => {
    if (running) return;
    sequence++; selected.clear(); phase = 'selection'; results = []; reviewing = false; error = ''; focusRequest = null;
  };
  const toggle = (id: string, checked: boolean): void => {
    if (!enabled() || !deps.ready() || phase !== 'selection' || running || disposed) return;
    prune();
    const file = deps.files().find(row => row.file_id === id);
    if (!file || !localFile(id)) return;
    error = '';
    if (!checked) selected.delete(id);
    else if (selected.size < FILE_BATCH_LIMIT) selected.set(id, { ...file });
    else error = `Choose up to ${FILE_BATCH_LIMIT} files at a time.`;
    paint();
  };
  const read = async (result: Result): Promise<FileLifecyclePreview> => {
    const preview = await deps.usage!({ record_id: result.file.file_id });
    if (preview.record_id !== result.file.file_id || !preview.revision) throw new Error('The server did not confirm this file. Refresh the library.');
    return preview;
  };
  const review = async (): Promise<void> => {
    if (!enabled() || !deps.ready() || phase !== 'selection' || disposed) return;
    prune(); if (!selected.size) return;
    const token = ++sequence; action = deps.archived() ? 'restore' : 'archive';
    phase = 'review'; reviewing = true; error = '';
    results = [...selected.values()].map(file => ({ file, state: 'checking' }));
    paint('heading');
    for (const result of results) {
      if (!current(token)) return;
      try {
        const preview = await read(result);
        if (!current(token)) return;
        result.preview = preview;
        result.file = { ...result.file, filename: preview.filename };
        if (preview.deleted) { result.state = 'skipped'; result.message = 'Permanently deleted; this file cannot be changed.'; }
        else if (achieved(preview, action)) { result.state = 'skipped'; result.message = action === 'archive' ? 'Already archived.' : 'Already in the library.'; }
        else if (action === 'restore' && preview.can_restore !== true) {
          result.state = 'skipped'; result.message = preview.can_restore === undefined ? 'Update the server to restore this file.' : 'This file can no longer be restored.';
        } else result.state = 'ready';
      } catch (cause) { if (!current(token)) return; result.state = 'failed'; result.message = failureMessage(cause); }
      paint();
    }
    if (current(token)) { reviewing = false; paint('heading'); }
  };
  const confirmState = (result: Result, preview: FileLifecyclePreview): boolean => {
    if (!achieved(preview, action)) return false;
    result.state = 'confirmed'; result.message = action === 'archive' ? 'In archived files.' : 'In the saved library.';
    selected.delete(result.file.file_id); deps.confirmed(result.file.file_id); return true;
  };
  const reconcile = async (result: Result, token: number): Promise<void> => {
    try {
      const preview = await read(result);
      if (!current(token)) return;
      result.file = { ...result.file, filename: preview.filename };
      if (!confirmState(result, preview)) {
        result.state = 'unconfirmed';
        result.message = preview.deleted ? 'The file was permanently deleted. This batch cannot confirm the requested change.'
          : `The requested change is not confirmed. The file is currently ${preview.archived ? 'archived' : 'in the library'}. Review it again before another change.`;
        if (result.failure) result.message = `${result.failure} ${result.message}`;
      }
    } catch (cause) {
      if (!current(token)) return;
      result.state = 'unconfirmed'; result.message = `The change could not be confirmed. ${failureMessage(cause)}`;
    }
  };
  const run = async (checkOnly: boolean): Promise<void> => {
    if (running || reviewing || disposed || !deps.active() || !enabled() || (!checkOnly && !deps.ready())
      || (checkOnly ? phase !== 'results' : phase !== 'review')) return;
    const targets = results.filter(row => row.state === (checkOnly ? 'unconfirmed' : 'ready'));
    if (!targets.length) return;
    const token = ++sequence; running = true; checking = checkOnly; stopping = false; phase = 'results';
    for (const result of targets) result.state = 'waiting';
    paint('heading');
    try {
      for (const result of targets) {
        if (!current(token)) break;
        if (stopping) { result.state = checkOnly ? 'unconfirmed' : 'skipped'; result.message = 'Not started: you stopped the batch.'; continue; }
        result.state = 'running'; paint();
        if (checkOnly) await reconcile(result, token);
        else {
          try {
            await deps.mutate!({ record_id: result.file.file_id, action, revision: result.preview!.revision });
            if (!current(token)) break;
            // A replayed receipt describes an earlier transition. Another actor
            // may have reversed it already; confirm the current state by reading.
            await reconcile(result, token);
          } catch (cause) {
            if (!current(token)) break;
            result.failure = failureMessage(cause);
            await reconcile(result, token);
          }
        }
        if (current(token)) paint();
      }
    } finally { running = false; if (current(token)) paint('heading'); }
  };
  const focusAttr = (key: string): string => `${FILE_BATCH_FOCUS}="${e(key)}"`;
  const button = (key: string, label: string, disabled = false, primary = false): string => `<button type="button" class="data-button${primary ? ' data-button--primary' : ''}" data-action="${FILE_BATCH_ACTION}${key}" ${focusAttr(key)}${disabled ? ' disabled' : ''}>${e(label)}</button>`;
  const handleAction = (value: string): boolean => {
    if (!value.startsWith(FILE_BATCH_ACTION)) return false;
    if (disposed) return true;
    const key = value.slice(FILE_BATCH_ACTION.length);
    if (key === 'stop' && running) { stopping = true; paint(); }
    else if (key === 'review' && phase === 'selection' && !running) pending = review();
    else if (key === 'confirm' && phase === 'review' && !reviewing && !running) pending = run(false);
    else if (key === 'check' && phase === 'results' && !running) pending = run(true);
    else if (key === 'back' && !running) { sequence++; phase = 'selection'; results = []; reviewing = false; paint('review'); }
    else if (key === 'reset' && !running) { reset(); paint('all'); }
    else if (key === 'all' && phase === 'selection' && deps.ready() && !running) {
      error = '';
      for (const file of deps.files()) if (localFile(file.file_id) && selected.size < FILE_BATCH_LIMIT) selected.set(file.file_id, { ...file });
      paint('all');
    }
    return true;
  };
  const render = (): string => {
    if (!enabled()) return '';
    prune();
    if (phase === 'selection') return `<section class="file-batch" aria-label="File selection">
      <div class="file-batch-heading"><strong role="status" aria-live="polite">${selected.size} file${selected.size === 1 ? '' : 's'} selected</strong>
        <div class="file-batch-buttons">${button('all', 'Select shown', !deps.ready() || !deps.files().length)}${selected.size ? button('reset', 'Clear selection') : ''}</div></div>
      <p>Select from the files shown here. Up to ${FILE_BATCH_LIMIT} per batch.</p>
      ${selected.size ? button('review', deps.archived() ? 'Review restore' : 'Review archive', !deps.ready(), true) : ''}${error ? `<p role="alert">${e(error)}</p>` : ''}</section>`;
    const ready = results.filter(row => row.state === 'ready').length;
    const confirmed = results.filter(row => row.state === 'confirmed').length;
    const unconfirmed = results.filter(row => row.state === 'unconfirmed').length;
    const skipped = results.filter(row => row.state === 'skipped').length;
    const failed = results.filter(row => row.state === 'failed').length;
    const labels: Record<State, string> = { checking: 'Checking…', ready: 'Ready', waiting: 'Waiting', running: checking ? 'Checking…' : 'Changing…', confirmed: 'Confirmed', skipped: 'Skipped', failed: 'Could not review', unconfirmed: 'Not confirmed' };
    return `<section class="file-batch" aria-label="${phase === 'review' ? 'Review selected files' : 'File batch results'}" aria-busy="${reviewing || running}">
      <h3 tabindex="-1" ${focusAttr('heading')}>${phase === 'review' ? `Review ${action}` : action === 'archive' ? 'Archive results' : 'Restore results'}</h3>
      <p>${action === 'archive' ? 'Archive hides these files from the current library. Their conversation attachments remain available.' : 'Restore puts these files back in the saved library.'}</p>
      <p role="status" aria-live="polite">${phase === 'review' ? `${ready} ready · ${skipped} skipped · ${failed} could not be reviewed${reviewing ? ' · Checking files…' : ''}`
        : `${confirmed} confirmed · ${skipped} skipped · ${failed} could not be reviewed · ${unconfirmed} not confirmed${running ? ` · ${results.filter(row => row.state === 'running' || row.state === 'waiting').length} remaining` : ''}`}</p>
      <ul class="file-batch-results">${results.map(row => `<li><div><strong>${e(row.file.filename)}</strong>${phase === 'results' && row.preview && row.preview.filename !== row.file.filename ? `<p>Reviewed as ${e(row.preview.filename)}</p>` : ''}${row.preview ? `<p>${phase === 'results' ? 'At review: ' : ''}${row.preview.message_count} message${row.preview.message_count === 1 ? '' : 's'} · ${row.preview.conversation_count} conversation${row.preview.conversation_count === 1 ? '' : 's'}</p>` : ''}</div>
        <div><span class="file-batch-state" data-state="${row.state}">${row.state === 'running' && !running ? 'Not confirmed' : labels[row.state]}</span>${row.message ? `<p>${e(row.message)}</p>` : ''}</div></li>`).join('')}</ul>
      <div class="file-batch-buttons">${phase === 'review' ? `${button('back', 'Back to selection')}${button('confirm', `${action === 'archive' ? 'Archive' : 'Restore'} ${ready} file${ready === 1 ? '' : 's'}`, reviewing || !ready || !deps.ready(), true)}`
        : running ? button('stop', stopping ? 'Stopping after this file…' : 'Stop after current file', stopping)
          : `${unconfirmed ? button('check', 'Check unconfirmed') : ''}${button('reset', 'Start another selection')}`}</div></section>`;
  };
  return {
    enabled, render, toggle, handleAction, reset,
    busy: () => running,
    holdsList: () => selected.size > 0 || phase !== 'selection',
    whenSettled: () => pending,
    snapshot: () => results.map(row => ({ ...row })),
    checkbox(id: string): string {
      if (!enabled()) return '';
      const file = deps.files().find(row => row.file_id === id); if (!file || !localFile(id)) return '';
      prune();
      return `<label class="file-batch-checkbox"><input type="checkbox" aria-label="${e(`Select ${file.filename}`)}" data-action="${FILE_BATCH_ACTION}toggle" data-file-batch-id="${e(id)}" ${focusAttr(`file-${id}`)}${selected.has(id) ? ' checked' : ''}${phase !== 'selection' || !deps.ready() ? ' disabled' : ''}></label>`;
    },
    restoreFocus(root: ParentNode, key: string | null): void {
      const request = focusRequest; focusRequest = null;
      if (disposed || key === null) return;
      const wanted = (request ?? key).replace(/["\\]/g, '\\$&');
      const target = root.querySelector<HTMLElement>(`[${FILE_BATCH_FOCUS}="${wanted}"]:not(:disabled)`)
        ?? root.querySelector<HTMLElement>(`[${FILE_BATCH_FOCUS}="heading"], [${FILE_BATCH_FOCUS}="all"]`);
      target?.focus({ preventScroll: !request || request === key });
    },
    dispose() { disposed = true; sequence++; selected.clear(); },
  };
};

export const FILE_BATCH_STYLES = `
.file-batch { display:grid; gap:12px; margin:16px 0; padding:16px; border:1px solid var(--border); border-radius:12px; background:var(--surface); }
.file-batch h3,.file-batch p { margin:0; }
.file-batch p { color:var(--muted); font-size:.875rem; overflow-wrap:anywhere; }
.file-batch [role=alert] { color:var(--danger); }
.file-batch-heading,.file-batch-buttons { display:flex; align-items:center; flex-wrap:wrap; gap:10px; }
.file-batch-heading { justify-content:space-between; }
.file-batch .data-button { min-height:var(--wc-control-h,44px); }
.file-batch-results { list-style:none; margin:0; padding:0; display:grid; gap:10px; }
.file-batch-results li { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:12px; padding:12px; border:1px solid var(--border); border-radius:8px; overflow-wrap:anywhere; }
.file-batch-state { font-weight:600; }
.file-batch-state[data-state=unconfirmed],.file-batch-state[data-state=failed] { color:var(--danger); }
.file-batch-checkbox { display:flex; align-items:center; justify-content:center; min-width:44px; min-height:44px; cursor:pointer; }
.file-batch-checkbox input { width:18px; height:18px; accent-color:var(--accent); }
@media(max-width:600px) { .file-batch-results li { grid-template-columns:1fr; } }
`;
