/** Production overview panel with explicit read, save and send acknowledgements. */
import type { SituationDeliverySettings, SituationDeliveryStatus } from '@recued/contracts';
import { PRIMITIVE_STYLES } from '@recued/ui-shared/primitives';
import { mountSituationDeliveryPanel, SITUATION_DELIVERY_PANEL_STYLES } from '../../src/settings/situation-delivery-panel.js';
import { WEBCLIENT_POLISH_STYLES } from '../../src/shell/webclient-polish-styles.js';

type Kind = 'read' | 'save' | 'send';
type Outcome = 'success' | 'error' | 'unsupported';
const host = document.querySelector<HTMLElement>('#panel')!;
const style = document.createElement('style');
style.textContent = `${PRIMITIVE_STYLES}\n${WEBCLIENT_POLISH_STYLES}\n${SITUATION_DELIVERY_PANEL_STYLES}`;
document.head.appendChild(style);
let current: SituationDeliveryStatus = {
  settings: { frequency: 'weekly', weekday: 1, time: '09:00', day_of: true },
  last_run: null, last_sent: null, pending: 0, uncertain: 0,
};
const calls: Array<{ kind: Kind; settings?: SituationDeliverySettings }> = [];
const pending: Array<{ kind: Kind; finish(outcome: Outcome): void }> = [];
const request = (kind: Kind, result: () => SituationDeliveryStatus, settings?: SituationDeliverySettings) => {
  calls.push({ kind, ...(settings ? { settings: structuredClone(settings) } : {}) });
  return new Promise<SituationDeliveryStatus>((resolve, reject) => {
    let released = false;
    pending.push({ kind, finish(outcome) {
      if (released) throw new Error('Fixture reply was already released.');
      released = true;
      if (outcome === 'unsupported') { reject(Object.assign(new Error('Overview settings are unavailable.'), { code: 'unknown_method' })); return; }
      if (outcome === 'error') {
        reject(new Error(kind === 'read' ? 'Read interrupted. Retry overview settings.'
          : kind === 'save' ? 'Could not save the overview schedule. Try again.' : 'Could not check the overview. Try again.'));
        return;
      }
      resolve(result());
    } });
  });
};
const mount = () => mountSituationDeliveryPanel({
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
    const sent = { at: Date.parse('2026-06-15T20:00:00Z'), mode: 'manual', text: 'Fixture overview', delivered_to: ['ui'] };
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
  setServer(patch: Partial<SituationDeliveryStatus>) { current = { ...current, ...structuredClone(patch) }; },
  remount() { panel.dispose(); panel = mount(); },
};
declare global { interface Window { __overview: typeof controls } }
window.__overview = controls;
