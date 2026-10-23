/** Production Last time panel with held reads and writes; no server or provider. */
import type { YoursLearningStatus } from '@recued/contracts';
import { PRIMITIVE_STYLES } from '@recued/ui-shared/primitives';
import { mountLastTimePanel } from '../../src/settings/last-time-panel.js';
import { WEBCLIENT_POLISH_STYLES } from '../../src/shell/webclient-polish-styles.js';

type Kind = 'read' | 'save';
type Outcome = 'success' | 'error' | 'unsupported' | 'malformed' | 'unchanged';
type Choice = 'on' | 'off';
const host = document.querySelector<HTMLElement>('#panel')!;
const style = document.createElement('style'); style.textContent = `${PRIMITIVE_STYLES}\n${WEBCLIENT_POLISH_STYLES}`; document.head.appendChild(style);
const initial = new URLSearchParams(location.search).get('state');
let current: YoursLearningStatus = { last_time: initial === 'off' || initial === 'unasked' ? initial : 'on', asked: false, classes: [] };
const calls: Array<{ kind: Kind; choice?: Choice }> = [];
const pending: Array<{ kind: Kind; finish(outcome: Outcome): void }> = [];
const request = (kind: Kind, result: () => unknown, choice?: Choice): Promise<unknown> => {
  calls.push({ kind, ...(choice ? { choice } : {}) });
  return new Promise((resolve, reject) => {
    let released = false;
    pending.push({ kind, finish(outcome) {
      if (released) throw new Error('Fixture reply was already released.'); released = true;
      if (outcome === 'unsupported') { reject(Object.assign(new Error('Last time settings are unavailable.'), { code: 'unknown_method' })); return; }
      if (outcome === 'error') { reject(new Error(kind === 'read' ? 'Could not check Last time settings.' : 'Could not save the Last time setting.')); return; }
      if (outcome === 'malformed') { resolve({ last_time: 'other', classes: null }); return; }
      if (outcome === 'unchanged') { resolve({}); return; }
      resolve(result());
    } });
  });
};
const mount = () => mountLastTimePanel({ host, document,
  read: () => {
    const snapshot = structuredClone(current);
    return request('read', () => snapshot) as Promise<YoursLearningStatus>;
  },
  save: choice => request('save', () => { current = { ...current, last_time: choice }; return {}; }, choice),
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
  setServer(last_time: YoursLearningStatus['last_time']) { current = { ...current, last_time }; },
  remount() { panel.dispose(); panel = mount(); },
  dispose() { panel.dispose(); },
};
declare global { interface Window { __lastTime: typeof controls } }
window.__lastTime = controls;
