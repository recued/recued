/** Production Close the day card (D-343 slice 4) with explicit read, save and send acknowledgements. */
import type { EmailClosingReplyStatus, SituationAgendaStatus, SituationCloseDaySettings } from '@recued/contracts';
import { PRIMITIVE_STYLES } from '@recued/ui-shared/primitives';
import { CLOSE_DAY_PANEL_STYLES, mountCloseDayPanel } from '../../src/settings/close-day-panel.js';
import { WEBCLIENT_POLISH_STYLES } from '../../src/shell/webclient-polish-styles.js';

type Kind = 'read' | 'save' | 'send' | 'retry' | 'review';
type Outcome = 'success' | 'error' | 'unsupported' | 'unnamed';
const host = document.querySelector<HTMLElement>('#panel')!;
const style = document.createElement('style');
style.textContent = `${PRIMITIVE_STYLES}\n${WEBCLIENT_POLISH_STYLES}\n${CLOSE_DAY_PANEL_STYLES}`;
document.head.appendChild(style);
// A current server's `yours.agenda`: it names Close the day beside the Agenda.
let current: SituationAgendaStatus = { settings: { enabled: false, time: '07:00', day: 'today', frequency: 'daily', weekday: 1 },
  last_run: null, last_sent: null, pending: 0, uncertain: 0,
  close_day: { settings: { enabled: false, time: '21:00' }, last_run: null, last_sent: null, pending: 0, uncertain: 0 } };
const calls: Array<{ kind: Kind; settings?: SituationCloseDaySettings; reply_id?: string }> = [];
// Off for the next save: the server answers it but keeps what it had.
let keeps = true;
const pending: Array<{ kind: Kind; finish(outcome: Outcome): void }> = [];
const request = (kind: Kind, result: () => SituationAgendaStatus, settings?: SituationCloseDaySettings, reply_id?: string) => {
  calls.push({ kind, ...(settings ? { settings: structuredClone(settings) } : {}), ...(reply_id ? { reply_id } : {}) });
  return new Promise<SituationAgendaStatus>((resolve, reject) => {
    let released = false;
    pending.push({ kind, finish(outcome) {
      if (released) throw new Error('Fixture reply was already released.');
      released = true;
      if (outcome === 'unsupported') { reject(Object.assign(new Error('The agenda is unavailable.'), { code: 'unknown_method' })); return; }
      if (outcome === 'error') { reject(new Error(kind === 'read' ? 'Read interrupted.' : kind === 'save' ? 'Could not save. Try again.' : 'Could not send. Try again.')); return; }
      // A server with an Agenda but before Close the day names none.
      if (outcome === 'unnamed') { const { close_day: _closeDay, ...older } = result(); resolve(older); return; }
      resolve(result());
    } });
  });
};
const mount = () => mountCloseDayPanel({
  host, document,
  read: () => { const snapshot = structuredClone(current); return request('read', () => snapshot); },
  save: settings => request('save', () => {
    if (keeps) current = { ...current, close_day: { ...current.close_day!, settings: structuredClone(settings) } };
    keeps = true;
    return structuredClone(current);
  }, settings),
  sendNow: () => request('send', () => {
    const sent = { at: Date.parse('2026-11-07T21:00:00Z'), mode: 'close_day_manual', delivered_to: ['telegram'],
      text: '07:00 Run 5 km\n18:00 Spanish lesson\n\nPursuit: Learn Spanish\n\nReply to this with what you did.' };
    current = { ...current, close_day: { ...current.close_day!, last_run: { ...sent, state: 'sent' }, last_sent: sent } };
    return structuredClone(current);
  }),
  retryReply: id => request('retry', () => {
    current.close_day!.email_replies = current.close_day!.email_replies?.filter(reply => reply.id !== id);
    return structuredClone(current);
  }, undefined, id),
  reviewReply: id => request('review', () => {
    current.close_day!.email_replies = current.close_day!.email_replies?.filter(reply => reply.id !== id);
    return structuredClone(current);
  }, undefined, id),
});
let panel = mount();
const controls = {
  calls,
  release(kind: Kind, index: number, outcome: Outcome = 'success') {
    const item = pending.filter(item => item.kind === kind)[index];
    if (!item) throw new Error(`Missing fixture reply: ${kind} ${index}`);
    item.finish(outcome);
  },
  refresh: () => { void panel.refresh(); },
  hasUnsavedChanges: () => panel.hasUnsavedChanges(),
  hasInFlightWork: () => panel.hasInFlightWork(),
  setEmailReplies(replies: EmailClosingReplyStatus[]) { current.close_day!.email_replies = structuredClone(replies); },
  /** The next save is answered but not kept, as a server that dropped the change would answer it. */
  dropNextSave() { keeps = false; },
  remount() { panel.dispose(); panel = mount(); },
};
declare global { interface Window { __closeDay: typeof controls } }
window.__closeDay = controls;
