import type { PromptSchedule, PromptScheduleSkipPreview, PromptScheduleSkipRequest, PromptScheduleSkipResult,
  PromptScheduleUndoSkipRequest } from '@recued/contracts';
import { renderActionLabel } from '@recued/ui-shared';
import { classifyRpcError, humanizeRpcError } from '../shell/rpc-error-copy.js';
import { readPromptSchedules } from './prompt-search.js';

type Operation = { action: 'skip_next'; request: PromptScheduleSkipRequest } | { action: 'undo_skip'; request: PromptScheduleUndoSkipRequest };
export interface PromptSkipClient {
  (method: 'chat.schedule.skip_preview', args: PromptScheduleSkipRequest): Promise<PromptScheduleSkipPreview>;
  (method: 'chat.schedule.skip_next', args: PromptScheduleSkipRequest): Promise<PromptScheduleSkipResult>;
  (method: 'chat.schedule.undo_skip', args: PromptScheduleUndoSkipRequest): Promise<PromptScheduleSkipResult>;
}
const instant = (at: unknown): at is number => Number.isSafeInteger(at) && Number(at) >= 0 && Number(at) <= 8.64e15;
const parse = (raw: unknown, id: string): Operation | undefined => {
  if (!raw || typeof raw !== 'object') return;
  const op = raw as Operation, request = op.request;
  if (!request || request.schedule_id !== id || !Number.isSafeInteger(request.expected_revision) || request.expected_revision < 1
    || !Number.isSafeInteger(request.expected_skip_revision) || request.expected_skip_revision < 0) return;
  const base = { schedule_id: id, expected_revision: request.expected_revision, expected_skip_revision: request.expected_skip_revision };
  if (op.action === 'skip_next' && instant(op.request.run_at)) return { action: op.action, request: { ...base, run_at: op.request.run_at } };
  if (op.action === 'undo_skip' && typeof op.request.skip_id === 'string' && /^[0-9a-f-]{36}$/i.test(op.request.skip_id))
    return { action: op.action, request: { ...base, skip_id: op.request.skip_id } };
  return;
};

/** Read-only confirmation plus immutable, same-tab retries. Never retarget a
 * lost reply to whatever occurrence happens to be next after a refresh. */
export const createPromptSkipControls = (options: {
  document: Document; call: PromptSkipClient; busy(): boolean; blocked(): boolean;
  redraw(focus?: string): void; refresh(): Promise<void>; mutate(work: () => Promise<void>): Promise<void>;
}) => {
  const doc = options.document, memory = new Map<string, Operation>();
  let disposed = false, sequence = 0, timer: ReturnType<typeof setTimeout> | undefined, expiredStamp = '';
  let confirmation: { row: PromptSchedule; request: PromptScheduleSkipRequest; preview?: PromptScheduleSkipPreview; loading: boolean; error?: string } | undefined;
  const key = (row: PromptSchedule) => 'recued:prompt-skip:' + encodeURIComponent(row.run_request_scope ?? row.session_id) + ':' + encodeURIComponent(row.schedule_id);
  const pending = (row: PromptSchedule): Operation | undefined => {
    const id = key(row); if (memory.has(id)) return memory.get(id);
    try { const found = parse(JSON.parse(doc.defaultView?.sessionStorage.getItem(id) ?? 'null'), row.schedule_id);
      if (found) { memory.set(id, found); return found; } } catch { /* A fresh server state still guards every clock mutation. */ }
    return;
  };
  const remember = (row: PromptSchedule, op: Operation) => {
    const id = key(row); memory.set(id, structuredClone(op));
    try { doc.defaultView?.sessionStorage.setItem(id, JSON.stringify(op)); } catch { /* Retain the exact request in this mounted panel. */ }
  };
  const forget = (row: PromptSchedule, expected: Operation) => {
    const id = key(row); if (JSON.stringify(pending(row)) !== JSON.stringify(expected)) return;
    memory.delete(id);
    try { if (JSON.stringify(parse(JSON.parse(doc.defaultView?.sessionStorage.getItem(id) ?? 'null'), row.schedule_id)) === JSON.stringify(expected)) doc.defaultView?.sessionStorage.removeItem(id); }
    catch { /* A persisted replay is safe; the server also binds it to its clock revision. */ }
  };
  const close = () => { confirmation = undefined; sequence++; };
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text: string) => { const el = doc.createElement(tag); el.textContent = text; return el; };
  const button = (host: HTMLElement, text: string, focus: string, action: () => void) => {
    const el = node('button', text); el.type = 'button'; el.disabled = options.busy(); el.dataset.promptFocus = focus;
    el.addEventListener('click', action); host.append(el); return el;
  };
  const date = (at: number, zone: string) => new Date(at).toLocaleString(undefined, { timeZone: zone,
    year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'shortOffset' });
  const change = (row: PromptSchedule, op: Operation) => {
    if (disposed || options.busy()) return;
    remember(row, op); close();
    void options.mutate(async () => {
      try {
        const reply = op.action === 'skip_next' ? await options.call('chat.schedule.skip_next', op.request) : await options.call('chat.schedule.undo_skip', op.request);
        const saved = readPromptSchedules([reply?.schedule])[0];
        if (!saved || saved.schedule_id !== row.schedule_id || saved.session_id !== row.session_id || reply.action !== op.action
          || reply.expected_skip_revision !== op.request.expected_skip_revision || reply.skip_revision !== op.request.expected_skip_revision + 1
          || !saved.skip_state || saved.skip_state.revision < reply.skip_revision
          || !['applied', 'replayed'].includes(reply.disposition)) throw Error('This scheduled run change could not be confirmed.');
        forget(row, op);
      } catch (failure) {
        const definitive = ['bad_request', 'invalid_args', 'conflict', 'not_found', 'unauthorized', 'forbidden', 'unknown_method', 'not_configured'].includes(classifyRpcError(failure).code ?? '');
        if (definitive) forget(row, op);
        // A conflict is final for this exact request; refreshing never applies
        // it to a later occurrence. An uncertain response keeps its Check action.
        if (definitive) await options.refresh();
        throw Error(humanizeRpcError(failure) + (definitive ? ' Review the current schedule before trying again.' : ' Check the original change before choosing another run.'));
      }
    });
  };
  const loadPreview = async (current: NonNullable<typeof confirmation>) => {
    const mine = ++sequence; current.loading = true; current.error = undefined; options.redraw();
    try {
      const preview = await options.call('chat.schedule.skip_preview', current.request);
      if (disposed || mine !== sequence || confirmation !== current) return;
      if (!preview || preview.schedule_id !== current.request.schedule_id || preview.expected_revision !== current.request.expected_revision
        || preview.expected_skip_revision !== current.request.expected_skip_revision || preview.run_at !== current.request.run_at
        || preview.time_zone !== current.row.time_zone || !instant(preview.following_run_at) || preview.following_run_at <= preview.run_at)
        throw Error('The skipped and following times could not be confirmed.');
      current.preview = preview;
    } catch (failure) { if (!disposed && mine === sequence && confirmation === current) current.error = humanizeRpcError(failure); }
    finally { if (!disposed && mine === sequence && confirmation === current) { current.loading = false; options.redraw(); } }
  };
  return {
    close,
    render(row: PromptSchedule, card: HTMLElement, actions: HTMLElement) {
      if (disposed) return;
      const op = pending(row), state = row.skip_state, skipped = state?.skipped, upcoming = state?.next;
      const prefix = row.schedule_id + ':';
      if (skipped) {
        const note = node('p', `Skipped run: ${date(skipped.run_at, row.time_zone)}. Regular timing continues with the next run.`);
        note.className = 'prompt-schedule-note'; card.append(note);
      }
      if (op) {
        const check = button(actions, op.action === 'skip_next' ? 'Check skip' : 'Check undo', prefix + 'check-skip', () => change(row, op));
        check.innerHTML = renderActionLabel('refresh', op.action === 'skip_next' ? 'Check skip' : 'Check undo');
        const note = node('p', 'This run change was not confirmed. Check its original request before changing another run.');
        note.className = 'prompt-schedule-note'; card.append(note); return;
      }
      if (skipped?.undo_available && skipped.run_at > Date.now()) {
        button(actions, 'Undo skip', prefix + 'undo-skip', () => change(row, { action: 'undo_skip', request: {
          schedule_id: row.schedule_id, expected_revision: row.revision, expected_skip_revision: state!.revision, skip_id: skipped.skip_id } }));
      }
      if (upcoming && upcoming.run_at > Date.now()) {
        button(actions, 'Skip next run', prefix + 'skip', () => {
          if (options.busy() || disposed) return;
          confirmation = { row, request: { schedule_id: row.schedule_id, expected_revision: row.revision,
            expected_skip_revision: state!.revision, run_at: upcoming.run_at }, loading: true };
          options.redraw(prefix + 'keep-run'); void loadPreview(confirmation);
        });
      }
      if (confirmation?.row.schedule_id !== row.schedule_id) return;
      const current = confirmation, group = doc.createElement('section'); group.className = 'prompt-schedule-confirm';
      group.setAttribute('role', 'region'); group.setAttribute('aria-label', 'Skip next scheduled run');
      const stale = current.request.expected_revision !== row.revision || current.request.expected_skip_revision !== state?.revision
        || current.request.run_at !== upcoming?.run_at || current.request.run_at <= Date.now();
      group.append(node('h4', 'Skip next run?'));
      if (stale || current.error) { const error = node('p', stale ? 'This scheduled run changed. Close this preview and review the current schedule.' : current.error!); error.setAttribute('role', 'alert'); group.append(error); }
      if (current.loading) { const loading = node('p', 'Checking the skipped and following times…'); loading.setAttribute('role', 'status'); group.append(loading); }
      if (current.preview) group.append(node('p', `Skip: ${date(current.preview.run_at, current.preview.time_zone)}`),
        node('p', `Following run: ${date(current.preview.following_run_at, current.preview.time_zone)}`),
        node('p', 'The regular cadence stays active. You can undo this skip until its original time.'));
      button(group, 'Keep next run', prefix + 'keep-run', () => { close(); options.redraw(prefix + 'skip'); });
      const confirm = button(group, 'Skip this run', prefix + 'confirm-skip', () => change(row, { action: 'skip_next', request: current.request }));
      confirm.disabled = options.busy() || current.loading || !current.preview || !!current.error || stale;
      if (current.error && !stale) button(group, 'Retry skip preview', prefix + 'retry-skip-preview', () => { void loadPreview(current); });
      card.append(group);
    },
    watch(rows: readonly PromptSchedule[]) {
      clearTimeout(timer); timer = undefined; if (disposed) return;
      const dates = rows.flatMap(row => [row.skip_state?.next?.run_at, row.skip_state?.skipped?.undo_available ? row.skip_state.skipped.run_at : undefined])
        .filter((at): at is number => at !== undefined);
      const at = Date.now(), passed = dates.filter(due => due <= at).sort((a, b) => a - b).join(',');
      if (passed && passed !== expiredStamp && !options.blocked()) {
        expiredStamp = passed; queueMicrotask(() => { if (!disposed && !options.blocked()) void options.refresh(); });
      }
      const next = dates.filter(due => due > at).sort((a, b) => a - b)[0];
      if (next !== undefined) timer = setTimeout(() => { if (!disposed && !options.blocked()) void options.refresh(); }, Math.min(next - at + 5, 2_147_483_647));
    },
    dispose() { disposed = true; close(); clearTimeout(timer); },
  };
};
