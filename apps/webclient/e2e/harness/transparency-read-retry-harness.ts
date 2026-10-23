/** Production Transparency settings with held replies; no server or provider. */
import { DEFAULT_INSTANCE_PREFS, type InstancePrefs } from '@recued/contracts';
import { PRIMITIVE_STYLES } from '@recued/ui-shared/primitives';
import { mountTransparencyPanel, TRANSPARENCY_PANEL_STYLES } from '../../src/settings/transparency-panel.js';
import { WEBCLIENT_POLISH_STYLES } from '../../src/shell/webclient-polish-styles.js';

type Kind = 'read' | 'save';
type Outcome = 'success' | 'error';
const host = document.querySelector<HTMLElement>('#panel')!;
const style = document.createElement('style'); style.textContent = `${PRIMITIVE_STYLES}\n${WEBCLIENT_POLISH_STYLES}\n${TRANSPARENCY_PANEL_STYLES}`; document.head.appendChild(style);
let current: InstancePrefs = { ...DEFAULT_INSTANCE_PREFS, 'ui.transparency.class.orchestration': true, 'ui.transparency.max_redaction_tier': 'none' };
const calls: Array<{ kind: Kind; patch?: Partial<InstancePrefs> }> = [];
const pending: Array<{ kind: Kind; finish(outcome: Outcome): void }> = [];
const request = (kind: Kind, response: () => { prefs: InstancePrefs }, patch?: Partial<InstancePrefs>) => {
  calls.push({ kind, ...(patch ? { patch } : {}) });
  return new Promise<{ prefs: InstancePrefs }>((resolve, reject) => {
    let released = false;
    pending.push({ kind, finish(outcome) {
      if (released) throw new Error('Fixture reply was already released.'); released = true;
      if (outcome === 'error') { reject(new Error(kind === 'read' ? 'Temporary preference read failure.' : 'Temporary preference save failure.')); return; }
      resolve(response());
    } });
  });
};
const panel = mountTransparencyPanel({ host, document,
  runPrefsGet: () => {
    const snapshot = structuredClone(current);
    return request('read', () => ({ prefs: snapshot }));
  },
  runPrefsSet: ({ patch }) => request('save', () => { current = { ...current, ...patch }; return { prefs: structuredClone(current) }; }, patch),
});
const controls = {
  calls,
  async release(kind: Kind, index = 0, outcome: Outcome = 'success') {
    const item = pending.filter(item => item.kind === kind)[index];
    if (!item) throw new Error(`Missing fixture reply: ${kind} ${index}`);
    item.finish(outcome);
    await (kind === 'read' ? panel.whenLoaded() : panel.whenSaveSettled());
  },
  hasInFlightWork: () => panel.hasInFlightWork(),
  dispose: () => panel.dispose(),
};
declare global { interface Window { __transparencyReadRetry: typeof controls } }
window.__transparencyReadRetry = controls;
