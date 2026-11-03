/** Production Agenda card (D-325 §15.7, 2026-11-02, later) with explicit read, save and send acknowledgements. */
import type { SituationAgendaSettings, SituationAgendaStatus } from '@recued/contracts';
import { PRIMITIVE_STYLES } from '@recued/ui-shared/primitives';
import { AGENDA_PANEL_STYLES, mountAgendaPanel } from '../../src/settings/agenda-panel.js';
import { WEBCLIENT_POLISH_STYLES } from '../../src/shell/webclient-polish-styles.js';

type Kind = 'read' | 'save' | 'send';
type Outcome = 'success' | 'error' | 'unsupported';
const host = document.querySelector<HTMLElement>('#panel')!;
const style = document.createElement('style');
style.textContent = `${PRIMITIVE_STYLES}\n${WEBCLIENT_POLISH_STYLES}\n${AGENDA_PANEL_STYLES}`;
document.head.appendChild(style);
// A current server's `yours.agenda`: it names a frequency (§15.7, 2026-11-03).
let current: SituationAgendaStatus = { settings: { enabled: false, time: '07:00', day: 'today', frequency: 'daily', weekday: 1 },
  last_run: null, last_sent: null, pending: 0, uncertain: 0 };
const calls: Array<{ kind: Kind; settings?: SituationAgendaSettings }> = [];
const pending: Array<{ kind: Kind; finish(outcome: Outcome): void }> = [];
const request = (kind: Kind, result: () => SituationAgendaStatus, settings?: SituationAgendaSettings) => {
  calls.push({ kind, ...(settings ? { settings: structuredClone(settings) } : {}) });
  return new Promise<SituationAgendaStatus>((resolve, reject) => {
    let released = false;
    pending.push({ kind, finish(outcome) {
      if (released) throw new Error('Fixture reply was already released.');
      released = true;
      if (outcome === 'unsupported') { reject(Object.assign(new Error('The agenda is unavailable.'), { code: 'unknown_method' })); return; }
      if (outcome === 'error') {
        reject(new Error(kind === 'read' ? 'Read interrupted. Retry agenda settings.'
          : kind === 'save' ? 'Could not save the agenda. Try again.' : 'Could not check the agenda. Try again.'));
        return;
      }
      resolve(result());
    } });
  });
};
const mount = () => mountAgendaPanel({
  host, document,
  read: () => {
    const snapshot = structuredClone(current);
    return request('read', () => snapshot);
  },
  save: settings => request('save', () => {
    current = { ...current, settings: structuredClone(settings) };
    return structuredClone(current);
  }, settings),
  sendNow: () => request('send', () => {
    const sent = { at: Date.parse('2026-11-02T20:00:00Z'), mode: 'agenda_manual', text: '06:00 Wake up\n06:30 Jogging', delivered_to: ['in_app'] };
    current = { ...current, last_run: { ...sent, state: 'sent' }, last_sent: sent };
    return structuredClone(current);
  }),
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
  setServer(patch: Partial<SituationAgendaStatus>) { current = { ...current, ...structuredClone(patch) }; },
  remount() { panel.dispose(); panel = mount(); },
};
declare global { interface Window { __agenda: typeof controls } }
window.__agenda = controls;
