/** Production Household delivery panel with synthetic held read/save replies. */
import type { HouseholdHomeAssistantList, YoursSnapshot } from '@recued/contracts';
import { PRIMITIVE_STYLES } from '@recued/ui-shared/primitives';
import { HOUSEHOLD_DELIVERY_PANEL_STYLES, mountHouseholdDeliveryPanel } from '../../src/settings/household-delivery-panel.js';
import { WEBCLIENT_POLISH_STYLES } from '../../src/shell/webclient-polish-styles.js';

type Household = NonNullable<YoursSnapshot['household']>;
type Save = Parameters<Parameters<typeof mountHouseholdDeliveryPanel>[0]['save']>[0];
type Kind = 'read' | 'save';
type Outcome = 'success' | 'error' | 'applied_error' | 'unsupported' | 'without_home_assistant' | 'malformed_telegram' | 'malformed_home_assistant';
const host = document.querySelector<HTMLElement>('#panel')!;
const style = document.createElement('style');
style.textContent = `${PRIMITIVE_STYLES}\n${WEBCLIENT_POLISH_STYLES}\n${HOUSEHOLD_DELIVERY_PANEL_STYLES}`;
document.head.appendChild(style);
let current: Household = {
  telegram: { connection_name: 'Household group', connection_enrolled_at: 100, recipient: '-10001', selected_at: 200 },
  telegram_connections: [{ name: 'Household group', display_name: 'Family chat', enrolled_at: 100, recipient: '-10001' }],
  home_assistant: { selection: { connection_name: 'Household server', connection_enrolled_at: 300,
    base_url: 'https://household.invalid', entity_id: 'todo.household', selected_at: 400 },
    connections: [{ name: 'Household server', enrolled_at: 300 }], issue: null, uncertain: 0 },
  shared_assets: { assets: [{ id: 'boiler', name: 'Boiler' }, { id: 'car', name: 'Car' }], total: 2 },
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
// §15.7 amendment — the connection's to-do lists: an older server's refusal until a test sets them.
let listsReply: HouseholdHomeAssistantList[] | 'unsupported' | 'error' = 'unsupported';
const listCalls: unknown[] = [];
const mount = () => mountHouseholdDeliveryPanel({ host, document,
  homeAssistantLists: async input => {
    listCalls.push(structuredClone(input));
    if (listsReply === 'unsupported') throw Object.assign(new Error('Unknown method'), { code: 'unknown_method' });
    if (listsReply === 'error') throw new Error('Home Assistant is unreachable.');
    return { lists: structuredClone(listsReply) };
  },
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
        recipient: row.recipient, selected_at: 500 } : null };
    } else if (current.home_assistant) {
      const row = current.home_assistant.connections.find(row => row.name === input.connection_name && row.enrolled_at === input.connection_enrolled_at);
      current = { ...current, home_assistant: { ...current.home_assistant, selection: row ? {
        connection_name: row.name, connection_enrolled_at: row.enrolled_at, base_url: 'https://household.invalid',
        entity_id: input.entity_id!, selected_at: 600 } : null } };
    }
    return {};
  }, input),
});
let panel = mount();
const controls = {
  calls,
  listCalls,
  /** What the Home Assistant connection's list read answers from now on. */
  lists(reply: HouseholdHomeAssistantList[] | 'unsupported' | 'error') { listsReply = reply; },
  release(kind: Kind, index = 0, outcome: Outcome = 'success') {
    const item = pending.filter(item => item.kind === kind)[index];
    if (!item) throw new Error(`Missing fixture reply: ${kind} ${index}`);
    item.finish(outcome);
  },
  refresh() { void panel.refresh(); },
  /** The quiet re-read Settings makes when the page is shown again. */
  refreshQuietly() { void panel.refreshQuietly(); },
  refreshPair() { const first = panel.refresh(); return first === panel.refresh(); },
  setNewerServer(kind: 'telegram' | 'home_assistant' = 'telegram') {
    // Another group, saved elsewhere: the menu offers it second.
    if (kind === 'telegram') current = { ...current, telegram: { connection_name: 'Cousins', connection_enrolled_at: 150, recipient: '-10002', selected_at: 900 },
      telegram_connections: [...current.telegram_connections.filter(row => row.name !== 'Cousins'), { name: 'Cousins', enrolled_at: 150, recipient: '-10002' }] };
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
  /** A second Telegram group the owner could switch to. */
  addGroup(display_name = 'Cousins') {
    current = { ...current, telegram_connections: [...current.telegram_connections, { name: 'Cousins', display_name, enrolled_at: 150, recipient: '-10002' }] };
  },
  /** The assets whose reminders reach the household; `undefined` is a server before the list. */
  share(shared?: unknown) {
    if (shared === undefined) { const { shared_assets: _shared, ...rest } = current; current = rest; }
    // Deliberately unchecked, to exercise a malformed list too.
    else current = { ...current, shared_assets: shared as Household['shared_assets'] };
  },
  disconnect() {
    current = { ...current, telegram: null, telegram_connections: [],
      ...(current.home_assistant ? { home_assistant: { ...current.home_assistant, selection: null, connections: [] } } : {}) };
  },
  remount() { panel.dispose(); panel = mount(); },
  dispose() { panel.dispose(); },
  hasInFlightWork: () => panel.hasInFlightWork(),
  hasUnsavedChanges: () => panel.hasUnsavedChanges(),
};
declare global { interface Window { __householdDelivery: typeof controls } }
window.__householdDelivery = controls;
