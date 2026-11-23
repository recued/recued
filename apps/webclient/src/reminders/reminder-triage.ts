import {
  REMINDER_TRIAGE_MAX, zonedWallClockToEpochMs,
  type ReminderView, type ReminderTriageAction, type ReminderTriagePreviewRequest, type ReminderTriagePreview,
  type ReminderTriageApplyRequest, type ReminderTriageResult, type ReminderTriageOutcome,
} from '@recued/contracts';
import { e } from '@recued/ui-shared';
import { humanizeRpcError } from '../shell/rpc-error-copy.js';
import { reminderTimePreset, reminderWallClockValue, formatReminderTimePreview } from './reminder-time.js';

export interface ReminderTriageCallers {
  triagePreview?: (input: ReminderTriagePreviewRequest) => Promise<ReminderTriagePreview>;
  triageApply?: (input: ReminderTriageApplyRequest) => Promise<ReminderTriageResult>;
}
interface Deps {
  callers: ReminderTriageCallers;
  rows: () => readonly ReminderView[];
  zone: () => string;
  now: () => number;
  actionAttr: string;
  actionPrefix?: string;
  fieldAttr: string;
  focusAttr: string;
  render: () => void;
  focus: (key: string, from?: readonly string[]) => void;
  beforeStart: () => boolean;
  beforeWrite: () => void;
  onResult: (item: ReminderTriageOutcome) => void;
  refresh: () => Promise<void>;
}
interface Review {
  request: ReminderTriageApplyRequest;
  preview: ReminderTriagePreview;
  outcomes: Map<string, ReminderTriageOutcome>;
  attempted: boolean;
}
const personal = (r: ReminderView) => r.state === 'pending' && r.managed_by !== 'clock';
const sameAction = (a: ReminderTriageAction, b: ReminderTriageAction) => a?.kind === b.kind
  && (a.kind === 'cancel' || b.kind === 'move' && a.at === b.at && a.time_zone === b.time_zone);

/** A selection is scoped to this list. Tokens and request IDs survive uncertain
 * replies; only unconfirmed or failed items are sent again. */
export const createReminderTriage = (deps: Deps) => {
  const selected = new Map<string, ReminderView>();
  let form: { value: string; zone: string } | null = null;
  let review: Review | null = null;
  let error: string | null = null;
  let reading = false, writing = false, disposed = false, seq = 0;
  let pending: Promise<void> = Promise.resolve();
  const available = () => !!deps.callers.triagePreview && !!deps.callers.triageApply;
  const actionPrefix = deps.actionPrefix ?? 'reminders-triage-';
  const attr = (action: string, key = action) => `${deps.actionAttr}="${actionPrefix}${action}" ${deps.focusAttr}="triage-${key}"`;
  const focus = (key: string) => `${deps.focusAttr}="triage-${key}"`;
  const reset = () => { seq++; selected.clear(); form = null; review = null; error = null; reading = false; };
  const retireReview = () => { seq++; form = null; review = null; error = null; reading = false; };
  const start = () => !disposed && !writing && deps.beforeStart();
  const preview = (action: ReminderTriageAction): void => {
    if (!selected.size || !deps.callers.triagePreview || !start()) return;
    const ids = [...selected.keys()], mine = ++seq;
    form = null; review = null; error = null; reading = true;
    deps.focus('triage-status'); deps.render();
    pending = (async () => {
      try {
        const out = await deps.callers.triagePreview!({ action, reminder_ids: ids });
        if (disposed || mine !== seq) return;
        if (!out || !sameAction(out.action, action) || !Array.isArray(out.items) || out.items.length !== ids.length
          || new Set(out.items.map(i => i.reminder_id)).size !== ids.length
          || out.items.some(i => !ids.includes(i.reminder_id) || i.reminder && i.reminder.reminder_id !== i.reminder_id
            || i.review_token && (!/^[a-f0-9]{64}$/.test(i.review_token) || !i.reminder || !personal(i.reminder))))
          throw new Error('The reminder review could not be confirmed. Review your selection again.');
        review = { preview: out, request: { request_id: crypto.randomUUID(), action,
          items: out.items.filter(i => i.review_token).map(i => ({ reminder_id: i.reminder_id, review_token: i.review_token! })) },
          outcomes: new Map(), attempted: false };
        deps.focus('triage-review', ['triage-status']);
      } catch (cause) {
        if (disposed || mine !== seq) return;
        error = humanizeRpcError(cause); deps.focus('triage-status', ['triage-status']);
      } finally {
        if (!disposed && mine === seq) { reading = false; deps.render(); }
      }
    })();
  };
  const apply = (retry: boolean): void => {
    const current = review;
    if (!current || writing || reading || !deps.callers.triageApply || !start()) return;
    const items = retry ? current.request.items.filter(i => current.outcomes.get(i.reminder_id)?.status === 'failed')
      : current.attempted ? [] : current.request.items;
    if (!items.length) return;
    writing = true; current.attempted = true; error = null;
    deps.beforeWrite(); deps.focus('triage-status'); deps.render();
    pending = (async () => {
      let outcomes: ReminderTriageOutcome[];
      try {
        const out = await deps.callers.triageApply!({ ...current.request, items });
        if (!out || !Array.isArray(out.items) || out.items.length !== items.length
          || new Set(out.items.map(i => i.reminder_id)).size !== items.length
          || out.items.some(i => !items.some(sent => sent.reminder_id === i.reminder_id)
            || !['applied', 'failed', 'needs_review'].includes(i.status) || i.reminder && i.reminder.reminder_id !== i.reminder_id))
          throw new Error('The change results could not be confirmed.');
        outcomes = out.items;
      } catch (cause) {
        outcomes = items.map(i => ({ reminder_id: i.reminder_id, status: 'failed',
          message: `${humanizeRpcError(cause)} Retry to confirm the earlier action safely.` }));
      }
      if (disposed) return;
      for (const item of outcomes) {
        current.outcomes.set(item.reminder_id, item);
        if (item.status === 'applied') selected.delete(item.reminder_id);
        deps.onResult(item);
      }
      writing = false;
      deps.focus('triage-status', ['triage-status']); deps.render();
      await deps.refresh();
    })();
  };
  const readyCount = (r: Review) => r.request.items.length;
  const render = (): string => {
    if (!available()) return '';
    const loaded = deps.rows().filter(personal), count = selected.size;
    if (!loaded.length && !count && !review) return '';
    const successes = [...(review?.outcomes.values() ?? [])].filter(i => i.status === 'applied').length;
    const retryable = [...(review?.outcomes.values() ?? [])].filter(i => i.status === 'failed').length;
    const status = writing ? 'Applying reminder changes…' : reading ? 'Checking selected reminders…'
      : review?.attempted ? `${successes} applied. ${count} remaining selected.` : `${count} selected.`;
    return `<section class="reminders-triage" aria-label="Bulk reminder actions">
      <div class="reminders-buttons">
        <button type="button" class="data-button" ${attr('select-loaded')} ${writing || reading || !loaded.length ? 'disabled' : ''}>Select loaded personal reminders${loaded.length > REMINDER_TRIAGE_MAX ? ` (up to ${REMINDER_TRIAGE_MAX})` : ''}</button>
        ${count || review ? `<button type="button" class="data-button" ${attr('clear')} ${writing ? 'disabled' : ''}>Clear selection</button>` : ''}
      </div>
      <p class="reminders-subtle">Selection covers loaded results only. Yours reminders and finished reminders cannot be selected.</p>
      <p role="status" aria-live="polite" tabindex="-1" ${focus('status')}>${e(status)}</p>
      ${error ? `<p role="alert" class="reminders-error">${e(error)}</p>` : ''}
      ${count && !review && !reading ? `<div class="reminders-buttons">
        <button type="button" class="data-button" ${attr('tomorrow')}>Move to tomorrow</button>
        <button type="button" class="data-button" ${attr('choose')}>Choose a time</button>
        <button type="button" class="data-button reminders-danger" ${attr('cancel')}>Cancel selected</button>
      </div>` : ''}
      ${form ? `<div class="reminders-triage-time">
        <label class="reminders-field">New reminder time <input type="datetime-local" class="data-input" ${deps.fieldAttr}="triage-at" ${focus('at')} value="${e(form.value)}"></label>
        <p class="reminders-subtle">Time uses ${e(form.zone)}. All selected reminders move to the same instant.</p>
        <button type="button" class="data-button" ${attr('review-time')}>Review move</button>
      </div>` : ''}
      ${review ? `<div class="reminders-triage-review">
        <h3 tabindex="-1" ${focus('review')}>${review.attempted ? 'Reminder results' : review.preview.action.kind === 'move' ? 'Review reminder move' : 'Review reminder cancellation'}</h3>
        ${review.preview.action.kind === 'move' ? `<p>Chosen time: ${e(formatReminderTimePreview(review.preview.action.at, review.preview.action.time_zone))} (${e(review.preview.action.time_zone)}).</p>` : ''}
        <ul aria-label="Selected reminder results">${review.preview.items.map(item => {
          const outcome = review!.outcomes.get(item.reminder_id), r = item.reminder ?? selected.get(item.reminder_id);
          return `<li data-reminder-triage-result="${e(item.reminder_id)}" data-outcome="${outcome?.status ?? (item.review_token ? 'ready' : 'needs_review')}">
            <strong>${e(r?.text ?? 'Unavailable reminder')}</strong>
            ${r ? `<p class="reminders-subtle">Previously scheduled: ${e(r.when)} (${e(r.time_zone ?? 'UTC')}).</p>` : ''}
            <p>${e(outcome?.message ?? item.message)}</p></li>`;
        }).join('')}</ul>
        <div class="reminders-buttons">
          ${!review.attempted && readyCount(review) ? `<button type="button" class="data-button ${review.preview.action.kind === 'cancel' ? 'reminders-danger' : 'data-button--primary'}" ${attr('confirm')} ${writing ? 'disabled' : ''}>${review.preview.action.kind === 'move' ? 'Move' : 'Cancel'} ${readyCount(review)} reminder${readyCount(review) === 1 ? '' : 's'}</button>` : ''}
          ${review.attempted && retryable ? `<button type="button" class="data-button" ${attr('retry')} ${writing ? 'disabled' : ''}>Retry failed (${retryable})</button>` : ''}
          ${count ? `<button type="button" class="data-button" ${attr('back')} ${writing ? 'disabled' : ''}>Back to selection</button>` : ''}
        </div>
      </div>` : ''}
    </section>`;
  };
  return {
    render,
    renderSelection: (r: ReminderView): string => available() && personal(r) ? `<label class="reminders-triage-select">
      <input type="checkbox" ${deps.fieldAttr}="triage-select" data-reminder-id="${e(r.reminder_id)}" ${focus(`select:${r.reminder_id}`)} aria-label="${e(`Select reminder: ${r.text}`)}" ${selected.has(r.reminder_id) ? 'checked' : ''} ${writing ? 'disabled' : ''}>Select</label>` : '',
    handleChange: (target: HTMLElement): boolean => {
      const field = target.getAttribute(deps.fieldAttr);
      if (field === 'triage-at') { if (form && !writing) form.value = (target as HTMLInputElement).value; return true; }
      if (field !== 'triage-select') return false;
      if (writing || !available()) return true;
      const id = target.getAttribute('data-reminder-id'), row = deps.rows().find(r => r.reminder_id === id);
      if (!row || !personal(row) || !start()) { deps.render(); return true; }
      if (!(target as HTMLInputElement).checked) selected.delete(row.reminder_id);
      else if (selected.size < REMINDER_TRIAGE_MAX) selected.set(row.reminder_id, row);
      else { error = `Select at most ${REMINDER_TRIAGE_MAX} reminders at once.`; deps.render(); return true; }
      retireReview(); deps.render(); return true;
    },
    handleAction: (action: string): boolean => {
      if (!action.startsWith(actionPrefix)) return false;
      if (!available() || writing || disposed) return true;
      const name = action.slice(actionPrefix.length);
      if (name === 'confirm' || name === 'retry') { apply(name === 'retry'); return true; }
      if (name === 'clear') { reset(); deps.focus('triage-select-loaded'); deps.render(); return true; }
      if (name === 'back') { retireReview(); deps.focus('triage-tomorrow'); deps.render(); return true; }
      if (!start()) return true;
      if (name === 'select-loaded') {
        retireReview();
        for (const row of deps.rows().filter(personal)) { if (selected.size >= REMINDER_TRIAGE_MAX) break; selected.set(row.reminder_id, row); }
        deps.render(); return true;
      }
      if (!selected.size) return true;
      try {
        if (name === 'cancel') preview({ kind: 'cancel' });
        else if (name === 'tomorrow') preview({ kind: 'move', at: reminderTimePreset('tomorrow-9', deps.now(), deps.zone()).at, time_zone: deps.zone() });
        else if (name === 'choose') {
          retireReview(); const zone = deps.zone(); form = { value: reminderTimePreset('tomorrow-9', deps.now(), zone).value, zone };
          deps.focus('triage-at'); deps.render();
        } else if (name === 'review-time' && form) {
          const at = zonedWallClockToEpochMs(form.value, form.zone);
          if (at === null || at <= deps.now() || reminderWallClockValue(at, form.zone) !== form.value)
            throw new Error(`Choose a valid future day and time in ${form.zone}.`);
          preview({ kind: 'move', at, time_zone: form.zone });
        }
      } catch (cause) { error = humanizeRpcError(cause); deps.focus(form ? 'triage-at' : 'triage-status'); deps.render(); }
      return true;
    },
    reset: () => { if (!writing) reset(); },
    isBusy: () => writing || reading || selected.size > 0 || review !== null,
    writing: () => writing,
    whenSettled: () => pending,
    dispose: () => { disposed = true; seq++; },
  };
};
