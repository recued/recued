/** Production quiet-hours panel with explicitly released read/write replies. */
import type { QuietHoursGetResponse, QuietHoursSetRequest } from '@recued/contracts';
import { PRIMITIVE_STYLES } from '@recued/ui-shared/primitives';
import { mountQuietHoursPanel, QUIET_HOURS_PANEL_STYLES } from '../../src/settings/quiet-hours-panel.js';
import { WEBCLIENT_POLISH_STYLES } from '../../src/shell/webclient-polish-styles.js';

type Kind = 'get' | 'set';
type Outcome = 'success' | 'error' | 'applied_error' | 'incomplete';
const host = document.querySelector<HTMLElement>('#panel')!;
const style = document.createElement('style');
style.textContent = `${PRIMITIVE_STYLES}\n${WEBCLIENT_POLISH_STYLES}\n${QUIET_HOURS_PANEL_STYLES}`;
document.head.appendChild(style);
let current: QuietHoursGetResponse = {
  policy: { enabled: true, from_minute: 22 * 60, to_minute: 8 * 60, applies_to: ['notification'], updated_at: 1 },
  can_arm: new URLSearchParams(location.search).get('blocked') !== 'true', resolved_zone: 'Asia/Hong_Kong',
};
const calls: Array<{ kind: Kind; args?: QuietHoursSetRequest }> = [];
const pending: Array<{ kind: Kind; finish(outcome: Outcome): void }> = [];
const request = (kind: Kind, result: () => QuietHoursGetResponse, args?: QuietHoursSetRequest) => {
  calls.push({ kind, ...(args ? { args: structuredClone(args) } : {}) });
  return new Promise<QuietHoursGetResponse>((resolve, reject) => {
    let released = false;
    pending.push({ kind, finish(outcome) {
      if (released) throw new Error('Fixture reply was already released.');
      released = true;
      if (outcome === 'error' || outcome === 'applied_error') {
        if (outcome === 'applied_error') result();
        reject(new Error(kind === 'get' ? 'Could not read quiet hours.' : 'Connection interrupted. Try saving again.')); return;
      }
      const next = result();
      if (outcome === 'incomplete') Reflect.deleteProperty(next.policy, 'to_minute');
      resolve(next);
    } });
  });
};
const mount = () => mountQuietHoursPanel({
  host, document, clientZone: 'Europe/London', locale: 'en-GB', now: () => Date.parse('2026-06-15T20:00:00Z'),
  runGet: () => {
    const snapshot = structuredClone(current);
    return request('get', () => snapshot);
  },
  runSet: args => request('set', () => {
    current = { ...current, policy: { ...current.policy, ...args, updated_at: current.policy.updated_at + 1 } };
    return structuredClone(current);
  }, args),
});
let panel = mount();
const controls = {
  calls,
  guards: () => ({ work: panel.hasInFlightWork(), dirty: panel.hasUnsavedChanges() }),
  release(kind: Kind, index: number, outcome: Outcome = 'success') {
    const item = pending.filter(item => item.kind === kind)[index];
    if (!item) throw new Error(`Missing fixture reply: ${kind} ${index}`);
    item.finish(outcome);
  },
  refresh: () => { void panel.refresh(); },
  setServer(policy: Partial<QuietHoursGetResponse['policy']>, canArm = true) {
    current = { ...current, can_arm: canArm, policy: { ...current.policy, ...policy, updated_at: current.policy.updated_at + 1 } };
  },
  remount() { panel.dispose(); host.innerHTML = ''; panel = mount(); },
};
declare global { interface Window { __quietHours: typeof controls } }
window.__quietHours = controls;
