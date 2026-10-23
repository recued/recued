/** Production timezone panel. Only its read/write callers are fixtures; every
 * response stays pending until a browser test releases it. */
import { resolveServerTimeZone, type ServerTimeZoneGetResponse, type ServerTimeZoneSetRequest } from '@recued/contracts';
import { PRIMITIVE_STYLES } from '@recued/ui-shared/primitives';
import { mountServerTimeZonePanel, SERVER_TIMEZONE_PANEL_STYLES } from '../../src/settings/server-timezone-panel.js';
import { WEBCLIENT_POLISH_STYLES } from '../../src/shell/webclient-polish-styles.js';

type Kind = 'get' | 'set';
type Outcome = 'success' | 'error' | 'applied_error' | 'incomplete' | 'missing_zone' | 'invalid_zone_type';
const host = document.querySelector<HTMLElement>('#panel')!;
const style = document.createElement('style');
style.textContent = `${PRIMITIVE_STYLES}\n${WEBCLIENT_POLISH_STYLES}\n${SERVER_TIMEZONE_PANEL_STYLES}`;
document.head.appendChild(style);
const params = new URLSearchParams(location.search);
const setting: ServerTimeZoneGetResponse['setting'] = {
  mode: params.get('mode') === 'follows_host' ? 'follows_host' : 'fixed',
  zone: params.get('stored_zone') ?? 'Europe/London', updated_at: 1,
};
let current: ServerTimeZoneGetResponse = {
  setting, resolved_zone: resolveServerTimeZone(setting, 'Europe/London'), host_zone: 'Europe/London',
};
const calls: Array<{ kind: Kind; args?: ServerTimeZoneSetRequest }> = [];
const pending: Array<{ kind: Kind; finish(outcome: Outcome): void }> = [];
const request = (kind: Kind, result: () => ServerTimeZoneGetResponse, args?: ServerTimeZoneSetRequest) => {
  calls.push({ kind, ...(args ? { args } : {}) });
  return new Promise<ServerTimeZoneGetResponse>((resolve, reject) => {
    let released = false;
    pending.push({ kind, finish(outcome) {
      if (released) throw new Error('Fixture response was already released.');
      released = true;
      if (outcome === 'error' || outcome === 'applied_error') {
        if (outcome === 'applied_error') result();
        reject(new Error(kind === 'get' ? 'Could not read the timezone.' : 'Connection interrupted. Try saving again.')); return;
      }
      try {
        const next = result();
        if (outcome === 'incomplete') Reflect.deleteProperty(next.setting, 'mode');
        if (outcome === 'missing_zone') Reflect.deleteProperty(next.setting, 'zone');
        if (outcome === 'invalid_zone_type') Reflect.set(next.setting, 'zone', 42);
        resolve(next);
      } catch (error) { reject(error); }
    } });
  });
};
const mount = () => mountServerTimeZonePanel({
  host, document, clientZone: 'Europe/London', locale: 'en-US', now: () => Date.parse('2026-06-15T20:00:00Z'),
  runGet: () => {
    const snapshot = structuredClone(current);
    return request('get', () => snapshot);
  },
  runSet: args => request('set', () => {
    // Pin the server's canonical reply; browser ICU aliases can differ from
    // the server's, and the production panel must display the wire response.
    const zone = args.zone === undefined ? current.setting.zone
      : args.zone === 'PST' ? 'America/Los_Angeles' : args.zone;
    if (args.mode === 'fixed' && !zone) throw new Error('This timezone cannot serve as a wall clock.');
    current = { ...current, setting: { mode: args.mode, zone, updated_at: current.setting.updated_at + 1 },
      resolved_zone: args.mode === 'fixed' ? zone! : current.host_zone };
    return structuredClone(current);
  }, args),
});
let panel = mount();
const controls = {
  calls,
  guards: () => ({ work: panel.isSaving(), dirty: panel.hasUnsavedChanges() }),
  release(kind: Kind, index: number, outcome: Outcome = 'success') {
    const item = pending.filter(item => item.kind === kind)[index];
    if (!item) throw new Error(`Missing fixture response: ${kind} ${index}`);
    item.finish(outcome);
  },
  refresh: () => { void panel.refresh(); },
  setServer(zone: string) {
    const setting: ServerTimeZoneGetResponse['setting'] = { mode: 'fixed', zone, updated_at: current.setting.updated_at + 1 };
    current = { ...current, setting, resolved_zone: resolveServerTimeZone(setting, current.host_zone) };
  },
  remount() { panel.dispose(); host.innerHTML = ''; panel = mount(); },
};
declare global { interface Window { __timezone: typeof controls } }
window.__timezone = controls;
