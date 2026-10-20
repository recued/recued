import type { SituationDeliverySettings, SituationDeliveryStatus } from '@recued/contracts';
import { e } from '@recued/ui-shared';
import { classifyRpcError } from '../shell/rpc-error-copy.js';

export interface SituationDeliveryPanelOptions {
  host: HTMLElement; document?: Document;
  read: () => Promise<SituationDeliveryStatus>;
  save: (settings: SituationDeliverySettings) => Promise<unknown>;
  sendNow: () => Promise<unknown>;
}
export const mountSituationDeliveryPanel = (opts: SituationDeliveryPanelOptions) => {
  const doc = opts.document ?? document; const root = doc.createElement('section'); root.setAttribute('data-situation-delivery', ''); opts.host.appendChild(root);
  let disposed = false; let busy = false; let status: SituationDeliveryStatus | undefined;
  const message = (text: string, error = false) => {
    const node = root.querySelector('[data-situation-delivery-message]') as HTMLElement | null;
    if (node) { node.textContent = text; node.setAttribute('role', error ? 'alert' : 'status'); if (error) node.focus(); }
  };
  const lock = (value: boolean) => { busy = value; for (const node of root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input,select,button')) node.disabled = value; };
  const focusForWrite = (): (() => void) => {
    const active = doc.activeElement as HTMLElement | null;
    const name = active?.getAttribute('name');
    const selector = !active || !root.contains(active) ? undefined : name ? `[name="${name}"]`
      : active.hasAttribute('data-send-now') ? '[data-send-now]' : 'button[type="submit"]';
    return () => { if (selector && (doc.activeElement === doc.body || doc.activeElement === active)) root.querySelector<HTMLElement>(selector)?.focus(); };
  };
  const paint = () => {
    if (!status) return;
    const s = status.settings;
    root.innerHTML = `<h3>Coming up</h3><p>A weekly or daily overview and day-of notes open Today. Unchanged items are counted in Still open.</p>
      <p>Asset and occasion rules send their own reminders. Day-of notes add other due items and checks.</p>
      <form><label>Overview <select name="frequency" aria-label="Overview">${[['weekly', 'Weekly'], ['daily', 'Daily'], ['off', 'Off']].map(([value, text]) => `<option value="${value}"${s.frequency === value ? ' selected' : ''}>${text}</option>`).join('')}</select></label>
      <label>Weekly day <select name="weekday" aria-label="Weekly day">${['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].map((day, i) => `<option value="${i + 1}"${s.weekday === i + 1 ? ' selected' : ''}>${day}</option>`).join('')}</select></label>
      <label>Time <input type="time" name="time" aria-label="Time" value="${e(s.time)}" required></label>
      <label><input type="checkbox" name="day_of" aria-label="Day-of notes"${s.day_of ? ' checked' : ''}> Day-of notes</label>
      <p>Uses your <a href="#settings/server">server timezone</a> and notification quiet hours.</p>
      <button type="submit">Save overview schedule</button><button type="button" data-send-now>Send now</button></form>
      <p tabindex="-1" data-situation-delivery-message role="status"></p>
      ${status.pending ? `<p>${status.pending} overview deliveries are waiting. Recued retries them.</p>` : ''}
      ${status.uncertain ? `<p>${status.uncertain} deliveries could not be confirmed after their marked repeat. Open Today to check the current items.</p>` : ''}
      ${status.last_run ? `<p>Last checked ${e(new Date(status.last_run.at).toLocaleString())} · ${e(status.last_run.state)}</p>${status.last_sent?.text ? `<details><summary>What it sent</summary><p style="white-space:pre-wrap">${e(status.last_sent.text)}</p></details>` : ''}` : '<p>No overview has run yet.</p>'}`;
    root.querySelector('form')!.addEventListener('submit', async event => {
      event.preventDefault(); if (busy) return;
      const form = root.querySelector('form')!;
      const field = <T extends Element>(name: string) => form.querySelector(`[name="${name}"]`) as T;
      const value: SituationDeliverySettings = { frequency: field<HTMLSelectElement>('frequency').value as SituationDeliverySettings['frequency'],
        weekday: Number(field<HTMLSelectElement>('weekday').value), time: field<HTMLInputElement>('time').value, day_of: field<HTMLInputElement>('day_of').checked };
      const restoreFocus = focusForWrite(); lock(true); message('Saving…');
      try { await opts.save(value); if (!disposed) { status = await opts.read(); if (!disposed) { paint(); message('Overview schedule saved.'); } } }
      catch (error) { if (!disposed) message(error instanceof Error ? error.message : String(error), true); }
      finally { if (!disposed) { lock(false); restoreFocus(); } }
    });
    root.querySelector('[data-send-now]')!.addEventListener('click', async () => {
      if (busy) return; const restoreFocus = focusForWrite(); lock(true); message('Checking what changed…');
      try { await opts.sendNow(); if (!disposed) { status = await opts.read(); if (!disposed) { paint(); message('Checked. An overview sends when something changed.'); } } }
      catch (error) { if (!disposed) message(error instanceof Error ? error.message : String(error), true); }
      finally { if (!disposed) { lock(false); restoreFocus(); } }
    });
  };
  const refresh = async () => {
    if (disposed || busy) return;
    root.textContent = 'Loading overview settings…';
    try { const next = await opts.read(); if (!disposed) { status = next; paint(); } }
    catch (error) { if (!disposed && classifyRpcError(error).code === 'unknown_method') { root.remove(); return; } if (!disposed) { root.textContent = error instanceof Error ? error.message : String(error); const retry = doc.createElement('button'); retry.textContent = 'Retry overview settings'; retry.addEventListener('click', () => { void refresh(); }); root.appendChild(retry); } }
  };
  void refresh();
  return { refresh, dispose() { disposed = true; root.remove(); } };
};
