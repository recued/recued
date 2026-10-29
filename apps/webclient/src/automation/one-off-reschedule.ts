import type { ServerSchedule } from '@recued/contracts';
import { humanizeRpcError } from '../shell/rpc-error-copy.js';
import { describePickedInstantOnServer, formatClientDateTime } from '@recued/ui-shared';

export type OneOffRescheduleCaller = (args: {
  schedule_id: string; run_at: number; expected_revision: string;
}) => Promise<{ schedule: ServerSchedule }>;

const localValue = (at: number): string => {
  const d = new Date(at), pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
const pickedTime = (value: string): number | null => {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value)) return null;
  const at = new Date(value).getTime();
  // Reject normalized dates, including a clock time skipped by daylight saving.
  return Number.isFinite(at) && localValue(at) === (value.length === 16 ? value + ':00' : value) ? at : null;
};
const errorMessage = humanizeRpcError;

/** A date draft survives route refreshes. Failed replies reconcile by reading;
 * no retry or read can issue another write on the owner's behalf. */
export const mountOneOffReschedule = (options: {
  host: HTMLElement; schedule: ServerSchedule; save: OneOffRescheduleCaller;
  read(): Promise<ServerSchedule | null>; now(): number; serverTimeZone?(): string | undefined;
  beginWork?(): () => void; onBusy(busy: boolean): void;
  onCurrent(schedule: ServerSchedule | null): void; onClose(): void;
}) => {
  const doc = options.host.ownerDocument;
  let baseline = options.schedule, observed: ServerSchedule | null = baseline;
  const identity = baseline.reschedule_identity;
  let value = localValue(baseline.run_at!), initialValue = value;
  let busy = false, disposed = false, requested: number | null = null, observationSeq = 0;
  let phase: 'editing' | 'uncertain' | 'conflict' | 'saved' | 'gone' = 'editing';
  let message = '', error = '';
  const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const format = (at: number) => formatClientDateTime(at, { timeZone: browserZone });
  const time = () => value === initialValue ? baseline.run_at! : pickedTime(value);
  const sameRun = (schedule: ServerSchedule | null): schedule is ServerSchedule & { mode: 'one_shot'; reschedule_identity: string } => !!identity && schedule?.schedule_id === baseline.schedule_id
    && schedule.reschedule_identity === identity && schedule.mode === 'one_shot';
  const changed = () => !sameRun(observed) || !observed?.reschedule_revision || observed.reschedule_revision !== baseline.reschedule_revision;
  const sameObservation = (a: ServerSchedule | null, b: ServerSchedule | null) =>
    a?.schedule_id === b?.schedule_id && a?.reschedule_identity === b?.reschedule_identity
    && a?.reschedule_revision === b?.reschedule_revision && a?.run_at === b?.run_at
    && a?.enabled === b?.enabled && a?.last_run_at === b?.last_run_at
    && a?.preapproval?.execution_status === b?.preapproval?.execution_status;
  options.host.className = 'automation-detail-section';
  options.host.dataset.recuedOneOffReschedule = baseline.schedule_id;

  const unavailable = (schedule: ServerSchedule | null): boolean => {
    if (sameRun(schedule)) return false;
    message = '';
    if (!schedule || schedule.reschedule_identity && schedule.reschedule_identity !== identity) {
      phase = 'gone';
      error = schedule ? 'This schedule was replaced. Close this editor and open the current run.'
        : 'This schedule no longer exists. If it finished, its result is in Logs.';
    } else {
      phase = 'conflict'; error = 'This server did not identify the saved run. Reload the schedule before continuing.';
    }
    return true;
  };
  const confirmation = (schedule: ServerSchedule): string => schedule.last_run_at !== null
    ? `Run time confirmed: ${format(schedule.run_at!)}. This run has already started; see Recent activity.`
    : `Scheduled for ${format(schedule.run_at!)}.${schedule.enabled ? '' : ' This run is paused.'}`;
  const render = () => {
    if (disposed) return;
    options.host.replaceChildren();
    let saveButton: HTMLButtonElement | null = null;
    options.host.setAttribute('aria-busy', String(busy));
    const heading = doc.createElement('h3'); heading.textContent = phase === 'saved' ? 'Run time confirmed' : 'Reschedule one-off run';
    options.host.append(heading);
    const line = (text: string, role?: string) => {
      const p = doc.createElement('p'); p.className = 'automation-detail-note'; p.textContent = text;
      if (role) p.setAttribute('role', role); options.host.append(p); return p;
    };
    if (phase !== 'saved') {
      if (phase !== 'gone') line(`Current time: ${format(observed?.run_at ?? baseline.run_at!)}.`);
      const label = doc.createElement('label'); label.textContent = `New date and time (${browserZone}) `;
      const input = doc.createElement('input'); input.type = 'datetime-local'; input.step = '1';
      input.className = 'automation-input'; input.value = value; input.disabled = busy || phase === 'uncertain'; input.readOnly = phase === 'gone';
      const preview = doc.createElement('p'); preview.className = 'automation-detail-note';
      const previewTime = () => {
        const picked = time();
        preview.textContent = picked === null ? 'Choose a valid date and time.'
          : `New run: ${format(picked)}. ${describePickedInstantOnServer(picked, options.serverTimeZone?.(), { clientZone: browserZone }) ?? ''}`.trim();
      };
      input.addEventListener('input', () => {
        value = input.value; previewTime();
        if (saveButton) saveButton.disabled = busy || time() === baseline.run_at;
      });
      label.append(input); options.host.append(label, preview); previewTime();
      if (phase !== 'gone') {
        line('Settings and history stay the same. Any review of the old time will need to be renewed.');
        line((observed ?? baseline).preapproval
          ? 'This reviewed run will stay paused. Review the new time before enabling it.'
          : 'A paused run stays paused.');
      }
    }
    if (error) line(error, 'alert');
    if (phase === 'saved' && observed) line(confirmation(observed), 'status');
    else if (message) line(message, 'status');
    if (phase === 'editing' && changed()) line('This schedule changed while you were editing. Your new time is kept; reload the current schedule before saving.', 'status');
    const actions = doc.createElement('div'); actions.className = 'automation-row-actions'; options.host.append(actions);
    const button = (text: string, action: () => void, primary = false) => {
      const b = doc.createElement('button'); b.type = 'button'; b.className = 'automation-button' + (primary ? ' automation-button--primary' : '');
      b.textContent = text; b.disabled = busy; b.addEventListener('click', action); actions.append(b); return b;
    };
    if (phase === 'editing' && !changed()) {
      saveButton = button(busy ? 'Saving…' : 'Save time', () => { void save(); }, true);
      saveButton.disabled = busy || time() === baseline.run_at;
    }
    else if (phase !== 'saved' && phase !== 'gone') button(busy ? 'Checking…' : phase === 'uncertain' ? 'Check saved time' : 'Reload schedule', () => { void reload(); });
    button(phase === 'saved' ? 'Done' : phase === 'gone' ? 'Close' : 'Cancel', options.onClose);
  };
  const setBusy = (next: boolean) => { busy = next; if (!disposed) { options.onBusy(next); render(); } };
  const accept = (schedule: ServerSchedule | null) => {
    observed = schedule;
    if (!disposed) options.onCurrent(schedule);
  };
  const readCurrent = async () => {
    const seq = observationSeq;
    const current = await options.read();
    if (seq !== observationSeq && !sameObservation(current, observed)) {
      throw new Error('This schedule changed while its saved time was being checked. Check it again.');
    }
    return current;
  };
  const saved = (schedule: ServerSchedule) => {
    phase = 'saved'; error = ''; message = ''; accept(schedule);
  };
  const save = async () => {
    if (busy || disposed || phase !== 'editing' || changed()) return;
    const at = time();
    if (at === null || at <= options.now()) { error = 'Choose a valid future date and time.'; render(); return; }
    const release = options.beginWork?.(), seq = observationSeq;
    requested = at; error = ''; message = ''; setBusy(true);
    try {
      const result = await options.save({ schedule_id: baseline.schedule_id, run_at: at, expected_revision: baseline.reschedule_revision! });
      if (!sameRun(result.schedule) || result.schedule.run_at !== at) throw new Error('The server did not confirm the requested time.');
      if (seq !== observationSeq && !sameObservation(result.schedule, observed)) throw new Error('This schedule changed before the save was confirmed.');
      if (!disposed) saved(result.schedule);
    } catch (failure) {
      if (!disposed) {
        try {
          const current = await readCurrent();
          if (disposed) return;
          if (sameRun(current) && current.run_at === at) saved(current);
          else {
            accept(current);
            if (!unavailable(current)) {
              phase = changed() ? 'conflict' : 'editing';
              error = `${errorMessage(failure)} Your new time is kept.`;
            }
          }
        } catch {
          if (!disposed) { phase = 'uncertain'; error = 'The save reply and current time could not be confirmed. Check the saved time before trying again. Your new time is kept.'; }
        }
      }
    } finally { release?.(); setBusy(false); }
  };
  const reload = async () => {
    if (busy || disposed) return;
    const release = options.beginWork?.(); setBusy(true);
    try {
      const current = await readCurrent();
      if (disposed) return;
      if (phase === 'uncertain' && sameRun(current) && current.run_at === requested) saved(current);
      else {
        accept(current); error = '';
        if (unavailable(current) || !current) return;
        if (!current.reschedule_revision) {
          phase = 'conflict'; error = 'This run can no longer be rescheduled.';
        } else {
          baseline = current; initialValue = localValue(current.run_at!); phase = 'editing'; requested = null;
          message = `Current schedule loaded: ${format(current.run_at!)}. Review your new time before saving.`;
        }
      }
    } catch (failure) { if (!disposed) error = `Could not read the saved time: ${errorMessage(failure)}`; }
    finally { release?.(); setBusy(false); }
  };
  render();
  return {
    pending: () => busy,
    update: (schedule: ServerSchedule | null) => {
      if (sameObservation(observed, schedule)) { observed = schedule; return; }
      observed = schedule; observationSeq++;
      if (phase === 'saved') {
        if (!unavailable(schedule) && schedule && schedule.run_at !== requested) {
          phase = 'conflict'; message = 'This run changed after saving. Reload its current time before editing again.';
        }
      }
      render();
    },
    dispose: () => { disposed = true; options.host.remove(); },
  };
};
