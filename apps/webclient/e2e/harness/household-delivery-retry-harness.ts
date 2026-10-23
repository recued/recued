/** Production Household delivery panel with synthetic held read/save replies. */
import type { YoursCommand, YoursSnapshot } from '@recued/contracts';
import { PRIMITIVE_STYLES } from '@recued/ui-shared/primitives';
import { mountHouseholdDeliveryPanel } from '../../src/settings/household-delivery-panel.js';
import { WEBCLIENT_POLISH_STYLES } from '../../src/shell/webclient-polish-styles.js';

type Household = NonNullable<YoursSnapshot['household']>;
type Save = Extract<YoursCommand, { action: 'household.telegram' | 'household.home_assistant' }>;
type Kind = 'read' | 'save';
type Outcome = 'success' | 'error' | 'applied_error' | 'unsupported' | 'without_home_assistant' | 'malformed_telegram' | 'malformed_home_assistant';
const host = document.querySelector<HTMLElement>('#panel')!;
const style = document.createElement('style');
style.textContent = `${PRIMITIVE_STYLES}\n${WEBCLIENT_POLISH_STYLES}`;
document.head.appendChild(style);
let current: Household = {
  telegram: { connection_name: 'Household group', connection_enrolled_at: 100,
    recipient: '-10001', expected_sender: '1001', members: ['1001', '1002'], selected_at: 200 },
  telegram_connections: [{ name: 'Household group', enrolled_at: 100, recipient: '-10001', owner_sender: '1001' }],
  home_assistant: { selection: { connection_name: 'Household server', connection_enrolled_at: 300,
    base_url: 'https://household.invalid', entity_id: 'todo.household', mode: 'interactive', selected_at: 400 },
    connections: [{ name: 'Household server', enrolled_at: 300 }], issue: null, uncertain: 0 },
};
const calls: Array<{ kind: Kind; input?: Save }> = [];
const pending: Array<{ kind: Kind; finish(outcome: Outcome): void }> = [];
const request = <T>(kind: Kind, response: (outcome: Outcome) => T, input?: Save): Promise<T> => {
  calls.push({ kind, ...(input ? { input: structuredClone(input) } : {}) });
  return new Promise((resolve, reject) => {
    let finished = false;
    pending.push({ kind, finish(outcome) {
      if (finished) throw new Error('Fixture reply was already released.');
      finished = true;
      if (outcome === 'unsupported') {
        reject(Object.assign(new Error('Household delivery is unavailable.'), { code: 'unknown_method' })); return;
      }
      if (outcome === 'applied_error') response('success');
      if (outcome === 'error' || outcome === 'applied_error') { reject(new Error(`Temporary household ${kind} failure.`)); return; }
      resolve(response(outcome));
    } });
  });
};
const mount = () => mountHouseholdDeliveryPanel({ host, document,
  read: () => { const snapshot = structuredClone(current); return request('read', outcome => {
    if (outcome === 'without_home_assistant') { const { home_assistant, ...household } = snapshot; return household; }
    // Deliberately bypass the static contract to exercise unreadable RPC data.
    if (outcome === 'malformed_telegram') return { ...snapshot, telegram_connections: [null] } as unknown as Household;
    if (outcome === 'malformed_home_assistant') return {
      ...snapshot, home_assistant: { ...snapshot.home_assistant, connections: [null] },
    } as unknown as Household;
    return snapshot;
  }); },
  save: input => request('save', () => {
    if (input.action === 'household.telegram') {
      const row = current.telegram_connections.find(row => row.name === input.connection_name && row.enrolled_at === input.connection_enrolled_at);
      current = { ...current, telegram: row ? { connection_name: row.name, connection_enrolled_at: row.enrolled_at,
        recipient: row.recipient, expected_sender: row.owner_sender, members: input.members ?? [row.owner_sender], selected_at: 500 } : null };
    } else if (current.home_assistant) {
      const row = current.home_assistant.connections.find(row => row.name === input.connection_name && row.enrolled_at === input.connection_enrolled_at);
      current = { ...current, home_assistant: { ...current.home_assistant, selection: row ? {
        connection_name: row.name, connection_enrolled_at: row.enrolled_at, base_url: 'https://household.invalid',
        entity_id: input.entity_id!, mode: 'interactive', selected_at: 600 } : null } };
    }
    return {};
  }, input),
});
let panel = mount();
const controls = {
  calls,
  release(kind: Kind, index = 0, outcome: Outcome = 'success') {
    const item = pending.filter(item => item.kind === kind)[index];
    if (!item) throw new Error(`Missing fixture reply: ${kind} ${index}`);
    item.finish(outcome);
  },
  refresh() { void panel.refresh(); },
  refreshPair() { const first = panel.refresh(); return first === panel.refresh(); },
  setNewerServer(kind: 'telegram' | 'home_assistant' = 'telegram') {
    if (kind === 'telegram') current = { ...current, telegram: current.telegram ? { ...current.telegram, members: ['1001', '2002'] } : null };
    else if (current.home_assistant?.selection) current = { ...current, home_assistant: {
      ...current.home_assistant, selection: { ...current.home_assistant.selection, entity_id: 'todo.server' },
    } };
  },
  reenroll(kind: 'telegram' | 'home_assistant') {
    if (kind === 'telegram' && current.telegram) {
      const selected = current.telegram, enrolled_at = selected.connection_enrolled_at + 1;
      current = { ...current, telegram: { ...selected, connection_enrolled_at: enrolled_at },
        telegram_connections: current.telegram_connections.map(row => row.name === selected.connection_name ? { ...row, enrolled_at } : row) };
    } else if (kind === 'home_assistant' && current.home_assistant?.selection) {
      const ha = current.home_assistant, selected = ha.selection!, enrolled_at = selected.connection_enrolled_at + 1;
      current = { ...current, home_assistant: { ...ha, selection: { ...selected, connection_enrolled_at: enrolled_at },
        connections: ha.connections.map(row => row.name === selected.connection_name ? { ...row, enrolled_at } : row) } };
    }
  },
  remount() { panel.dispose(); panel = mount(); },
  dispose() { panel.dispose(); },
  hasInFlightWork: () => panel.hasInFlightWork(),
  hasUnsavedChanges: () => panel.hasUnsavedChanges(),
};
declare global { interface Window { __householdDelivery: typeof controls } }
window.__householdDelivery = controls;
