import Database from 'better-sqlite3';
import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AssetRule, ConnectionRow } from '@recued/contracts';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../storage/work-entity-store.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';
import { createWorkEntityDispatchers } from '../work-entity-ingredients.js';
import { autoRegisterRecuedBuiltinSources } from '../work-entity-source-boot.js';
import { createAssetOccurrenceService } from '../situations/asset-occurrence-service.js';
import { createAssetOccurrenceStore } from '../storage/asset-occurrence-store.js';
import { createHouseholdHomeAssistant } from '../situations/household-home-assistant.js';
import { createSituationStore } from '../storage/situation-store.js';
import { createYoursService } from '../situations/yours-service.js';
import { createHouseholdDeliveryStore } from '../storage/household-delivery-store.js';
import type { BoundedHttpFetcher } from '../bounded-origin-http-fetcher.js';
import { STOP_GRACE_MS } from '../lifecycle/settle-within.js';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
const fixture = () => {
  const db = new Database(':memory:'); cleanups.push(() => db.close()); ensureWorkEntitySchema(db);
  const work = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(work);
  let at = Date.parse('2026-10-17T12:00Z'); let unlocked = true; let flags = 87; let loseAck = false;
  const dispatchers = createWorkEntityDispatchers({ store: work, resolver: createWorkEntityResolver(work), now: () => at });
  const occurrences = createAssetOccurrenceService({ db, work, dispatchers, timeZone: () => 'UTC', now: () => at });
  const connections: ConnectionRow[] = [{ pk: 'api:house', name: 'house', display_name: 'Home Assistant', kind: 'api', enrolled_at: 100,
    updated_at: 100, config_json: JSON.stringify({ base_url: 'http://home-assistant.local:8123' }), auth_ciphertext: 'not-public' }];
  const remote: Array<{ uid: string; summary: string; description?: string; status: 'needs_action' | 'completed'; due?: string }> = [];
  const calls: Array<{ path: string; body?: Record<string, unknown> }> = []; let sequence = 0;
  const fetcher: BoundedHttpFetcher = async (url, init) => {
    expect(init?.headers?.Authorization).toBe('Bearer test-token');
    const path = new URL(url).pathname; const body = init?.body ? JSON.parse(init.body) : undefined; calls.push({ path, body });
    let result: unknown = [];
    if (path === '/api/states') result = [
      { entity_id: 'todo.household', state: '1', attributes: { friendly_name: 'Household', supported_features: flags } },
      // A shopping list keeps no descriptions; one list is offline; the rest are not lists.
      { entity_id: 'todo.shopping_list', state: '0', attributes: { friendly_name: 'Shopping List', supported_features: 15 } },
      { entity_id: 'todo.away', state: 'unavailable', attributes: { friendly_name: 'Away list', supported_features: 87 } },
      { entity_id: 'sensor.kitchen', state: '21', attributes: { friendly_name: 'Kitchen' } }, { entity_id: 'todo.Not-An-Id', state: '0', attributes: {} }];
    else if (path.startsWith('/api/states/')) result = { entity_id: 'todo.household', state: '1', attributes: { supported_features: flags } };
    else if (path.endsWith('/get_items')) result = { service_response: { 'todo.household': { items: structuredClone(remote) } } };
    else if (path.endsWith('/add_item')) { remote.push({ uid: `ha-${++sequence}`, summary: body.item, description: body.description, status: 'needs_action', due: body.due_date });
      if (loseAck) { loseAck = false; throw new Error('Acknowledgement lost'); } }
    else if (path.endsWith('/update_item')) { const item = remote.find(item => item.uid === body.item); if (!item) throw new Error('Item missing'); item.summary = body.rename; item.description = body.description; }
    else if (path.endsWith('/remove_item')) { const index = remote.findIndex(item => item.uid === body.item); if (index >= 0) remote.splice(index, 1); }
    else throw new Error(`Unexpected provider path ${path}`);
    return { ok: true, status: 200, statusText: 'OK', headers: new Headers(), json: async () => result, text: async () => JSON.stringify(result) };
  };
  const boot = (network = false) => createHouseholdHomeAssistant({ db, work, connections: () => connections, credential: async () => 'test-token',
    ...(!network ? { fetch: fetcher } : {}), now: () => at, isVaultUnlocked: () => unlocked });
  const rule: AssetRule = { id: 'service', title: 'Service', enabled: true, muted: false, pinned: false, consequence: 'floor', expiry_policy: 'escalate_overdue',
    when: { kind: 'interval', field: 'serviced_on', every: { amount: 12, unit: 'months' } }, reaction: { notify: true, occurrence: 'action', emit: false },
    schedule: { before: [{ amount: 1, unit: 'months' }], on_day: true } };
  const put = (name: string, audience: 'owner' | 'household' = 'household', custom = rule) => work.writeAsset({ name, source_id: 'recued.asset',
    audience, source: { kind: 'owner', ref: 'owner' }, dates: { serviced_on: '2025-11-17' }, rules: [custom],
    ...(custom.when.kind === 'objective' ? { readings: { odometer: { value: 11_000, unit: 'km', as_of: at, evidence: [] } } } : {}) }, at);
  const row = (asset_id: string) => createAssetOccurrenceStore(db).byAsset(asset_id)[0]!;
  return { db, work, occurrences, dispatchers, connections, remote, calls, boot, put, row, rule, fetcher,
    configure: (service: ReturnType<typeof boot>) => service.configure({ connection_name: 'house', connection_enrolled_at: 100, entity_id: 'todo.household' }),
    time: (value: string) => { at = Date.parse(value); }, loseAck: () => { loseAck = true; }, flags: (value: number) => { flags = value; }, seal: () => { unlocked = false; } };
};

describe('D-325 Home Assistant canonical household projection', () => {
  it('drives the real bounded HTTP adapter against a local Home Assistant API twin', async () => {
    const f = fixture(); const shared = f.put('Boiler'); await f.occurrences.tick(); const original = f.row(shared.id);
    const server = createServer(async (req, res) => {
      try { const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
        if (req.url?.includes('/get_items')) expect(req.url).toContain('?return_response');
        const response = await f.fetcher(`http://127.0.0.1${req.url}`, { method: req.method, headers: { Authorization: req.headers.authorization! },
          ...(chunks.length ? { body: Buffer.concat(chunks).toString('utf8') } : {}) });
        res.writeHead(response.status, { 'Content-Type': 'application/json' }); res.end(await response.text());
      } catch { res.writeHead(500); res.end('{}'); }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address(); if (!address || typeof address === 'string') throw new Error('Local fixture did not start');
      f.connections[0]!.config_json = JSON.stringify({ base_url: `http://127.0.0.1:${address.port}` });
      const ha = f.boot(true); await f.configure(ha); await ha.tick(); expect(f.remote).toHaveLength(1);
      expect(f.remote[0]!.description).toContain('Display only. Complete this task in Recued.');
      // D-325 §15.7 (2026-10-24) — the household only receives: ticked off there, it stays open.
      f.remote[0]!.status = 'completed'; await ha.tick(); expect(f.work.readCommitment(original.commitment_id!)!.lifecycle_state).toBe('pending');
      expect(f.remote).toHaveLength(1);
    } finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });
  it('projects only household tasks, and one ticked off there stays open until the owner marks it done (§15.7, 2026-10-24)', async () => {
    const f = fixture(); const shared = f.put('Boiler'); f.put('Personal policy', 'owner'); await f.occurrences.tick();
    const original = f.row(shared.id); const ha = f.boot(); await f.configure(ha); await ha.tick();
    expect(f.remote).toHaveLength(1); expect(f.remote[0]!.summary).toBe('Service · Boiler'); expect(f.remote[0]!.due).toBe('2026-11-17');
    f.remote[0]!.status = 'completed'; f.time('2026-10-24T12:00Z'); await ha.tick();
    expect(f.work.readCommitment(original.commitment_id!)!.lifecycle_state).toBe('pending');
    expect(f.work.readAsset(shared.id)!.dates.serviced_on).toBe('2025-11-17');
    // Recued learned nothing from the list, so it has nothing to ask the owner.
    const yours = createYoursService({ db: f.db, work: f.work, dispatchers: f.dispatchers, occurrences: f.occurrences, situations: createSituationStore(f.db), now: () => Date.parse('2026-10-24T12:00Z') });
    expect((await yours.snapshot({ asset_id: shared.id })).proposals.filter(row => row.kind === 'completion')).toEqual([]);
    // Marked done in Recued, it leaves the list.
    await f.occurrences.completeOccurrence({ occurrence_id: original.id, answered_at: Date.parse('2026-10-24T12:00Z'), owner_action: true });
    await ha.tick(); expect(f.remote).toEqual([]);
    expect(f.work.readCommitment(original.commitment_id!)!.lifecycle_state).toBe('fulfilled');
  });
  it('recovers a lost acknowledgement by its saved marker and never adds a second copy after restart', async () => {
    const f = fixture(); f.put('Boiler'); await f.occurrences.tick(); f.loseAck(); const ha = f.boot(); await f.configure(ha);
    expect(ha.read().uncertain).toBe(1); expect(f.remote).toHaveLength(1);
    const restarted = f.boot(); await restarted.tick(); await restarted.tick();
    expect(restarted.read().uncertain).toBe(0); expect(f.calls.filter(row => row.path.endsWith('/add_item'))).toHaveLength(1);
  });
  it('withdraws an owner-closed item, ignores foreign completed items, and never follows a replacement connection', async () => {
    const f = fixture(); const shared = f.put('Boiler'); await f.occurrences.tick(); const original = f.row(shared.id); const ha = f.boot();
    f.remote.push({ uid: 'foreign', summary: 'Service · Boiler', status: 'completed' }); await f.configure(ha); await ha.tick();
    expect(f.work.readCommitment(original.commitment_id!)!.lifecycle_state).toBe('pending');
    await f.dispatchers.commitmentCancel({ id: original.commitment_id! }); await ha.tick(); expect(f.remote.map(item => item.uid)).toEqual(['foreign']);
    const other = f.put('Car'); await f.occurrences.tick(); await ha.tick(); const id = f.row(other.id).commitment_id!;
    f.remote.find(item => item.uid !== 'foreign')!.status = 'completed'; f.connections[0] = { ...f.connections[0]!, enrolled_at: 101 };
    await ha.tick(); expect(f.work.readCommitment(id)!.lifecycle_state).toBe('pending'); expect(ha.read().issue).toContain('unavailable');
  });
  it('takes a list Recued cannot edit, as every list only shows tasks, and refuses one that cannot keep recovery markers', async () => {
    const f = fixture(); const shared = f.put('Boiler'); await f.occurrences.tick(); const original = f.row(shared.id); const ha = f.boot();
    f.flags(1 | 2 | 64); await f.configure(ha); await ha.tick(); expect(ha.read().selection).not.toHaveProperty('mode');
    expect(f.remote[0]!.description).toContain('Display only'); f.remote[0]!.status = 'completed'; await ha.tick();
    expect(f.work.readCommitment(original.commitment_id!)!.lifecycle_state).toBe('pending');
    f.flags(1 | 2 | 4); await expect(f.configure(ha)).rejects.toThrow('descriptions');
    f.seal(); const before = f.calls.length; await ha.tick(); expect(f.calls.length).toBe(before);
  });

  it('keeps a list saved as interactive where it is, rewrites the old note in place, and never completes from it (§15.7, 2026-10-24)', async () => {
    const f = fixture(); const shared = f.put('Boiler'); await f.occurrences.tick(); const original = f.row(shared.id); const ha = f.boot();
    // Saved before 2026-10-24, when ticking a task off there closed it in Recued.
    const legacy = { connection_name: 'house', connection_enrolled_at: 100, base_url: 'http://home-assistant.local:8123',
      entity_id: 'todo.household', mode: 'interactive', selected_at: 1 };
    createHouseholdDeliveryStore(f.db).setHomeAssistant(legacy);
    await ha.tick(); expect(f.remote).toHaveLength(1);
    // A task posted then still says ticking it off closes it in Recued.
    f.db.prepare("UPDATE household_ha_projections SET value=json_set(value,'$.content',?)").run(JSON.stringify(['Service · Boiler', '2026-11-17']));
    f.remote[0]!.description = `${f.remote[0]!.description!.split('\n')[0]}\nDone closes the original task in Recued. Service dates and readings are confirmed separately.`;
    const count = (end: string) => f.calls.filter(row => row.path.endsWith(end)).length; const adds = count('/add_item');
    await ha.tick();
    expect(f.remote[0]!.description).toContain('Display only. Complete this task in Recued.');
    expect([count('/add_item'), count('/remove_item')]).toEqual([adds, 0]);
    f.remote[0]!.status = 'completed'; await ha.tick();
    expect(f.work.readCommitment(original.commitment_id!)!.lifecycle_state).toBe('pending');
    // Saving the same list again keeps its selection, so its task is not removed and posted again.
    await f.configure(ha); expect(ha.read().selection).toMatchObject({ mode: 'interactive', selected_at: 1 });
    await ha.tick(); expect([count('/add_item'), count('/remove_item')]).toEqual([adds, 0]);
  });

  it('lists the connection’s to-do lists by name, saying which Recued can use and why not (§15.7 amendment)', async () => {
    const f = fixture(); const ha = f.boot(); const house = { connection_name: 'house', connection_enrolled_at: 100 };
    await expect(ha.lists(house)).resolves.toEqual({ lists: [
      { entity_id: 'todo.away', name: 'Away list', usable: false, reason: 'isn’t available right now' },
      { entity_id: 'todo.household', name: 'Household', usable: true },
      { entity_id: 'todo.shopping_list', name: 'Shopping List', usable: false, reason: 'can’t keep the note Recued adds to each item' },
    ] });
    // The list it calls usable is one `configure` accepts; every list only shows tasks, so it needs no update support.
    await f.configure(ha); expect(ha.read().selection?.entity_id).toBe('todo.household');
    f.flags(1 | 2 | 64); expect((await ha.lists(house)).lists.find(row => row.entity_id === 'todo.household')).toEqual({ entity_id: 'todo.household', name: 'Household', usable: true });
    const before = f.calls.length;
    await expect(ha.lists({ ...house, connection_enrolled_at: 99 })).rejects.toThrow('Choose an enrolled Home Assistant connection');
    f.seal(); await expect(ha.lists(house)).rejects.toThrow('Unlock the vault'); expect(f.calls.length).toBe(before);
  });
});

/** ⛔ The asset reminders' tick waits for a projection pass, and a drain waits
 *  for that, with 5 s; a pass can make 16 writes behind its reads, 5 s each. */
describe('D-325 Home Assistant projection — stopping', () => {
  afterEach(() => { vi.useRealTimers(); });

  const settle = async (): Promise<void> => {
    for (let i = 0; i < 10; i++) await new Promise<void>((resolve) => setImmediate(resolve));
  };
  /** The fixture's Home Assistant twin, with one kind of call held open. */
  const holding = (f: ReturnType<typeof fixture>, held: (path: string) => boolean, abortable: boolean) => {
    const seen: Array<{ path: string; signal?: AbortSignal }> = [];
    let hold = false;
    const fetch: BoundedHttpFetcher = (url, init) => {
      const path = new URL(url).pathname;
      if (!hold || !held(path)) return f.fetcher(url, init);
      seen.push({ path, ...(init?.signal ? { signal: init.signal } : {}) });
      return new Promise((_resolve, reject) => {
        if (abortable) init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    };
    const ha = createHouseholdHomeAssistant({ db: f.db, work: f.work, connections: () => f.connections,
      credential: async () => 'test-token', fetch, now: () => Date.parse('2026-10-17T12:00Z'), isVaultUnlocked: () => true });
    return { ha, seen, hold: () => { hold = true; } };
  };
  const stopWithinGrace = async (ha: { stop(): Promise<void> }, pass: Promise<void>) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let stopped = false; let passed = false;
    const stopping = ha.stop().then(() => { stopped = true; });
    void pass.then(() => { passed = true; });
    await vi.advanceTimersByTimeAsync(STOP_GRACE_MS);
    await settle();
    vi.useRealTimers();
    if (stopped) await stopping;
    return { stopped, passed };
  };

  it('ends the reads in flight and starts no write; the pass after the restart writes what was left', async () => {
    const f = fixture(); f.put('Boiler'); await f.occurrences.tick();
    const { ha, seen, hold } = holding(f, path => path.endsWith('/get_items'), true);
    await f.configure(ha);
    expect(f.remote).toHaveLength(1);
    f.put('Car'); await f.occurrences.tick();
    hold();
    const pass = ha.tick();
    await vi.waitFor(() => expect(seen).toHaveLength(1));

    expect(await stopWithinGrace(ha, pass)).toEqual({ stopped: true, passed: true });
    expect(seen[0]!.signal?.aborted).toBe(true);
    // No write started, and a stop is not an issue to show the owner.
    expect(f.calls.filter(row => row.path.endsWith('/add_item'))).toHaveLength(1);
    expect(ha.read().issue).toBeNull();
    // A stopped projection makes no further pass.
    await ha.tick();
    expect(seen).toHaveLength(1);

    const restarted = f.boot(); await restarted.tick();
    expect(f.remote.map(item => item.summary).sort()).toEqual(['Service · Boiler', 'Service · Car']);
    // One add each: the stopped pass marked nothing started.
    expect(f.calls.filter(row => row.path.endsWith('/add_item'))).toHaveLength(2);
  });

  it('leaves a write in flight to finish, and still stops within the grace', async () => {
    const f = fixture();
    const { ha, seen, hold } = holding(f, path => path.endsWith('/add_item'), false);
    await f.configure(ha);
    f.put('Boiler'); await f.occurrences.tick();
    hold();
    const pass = ha.tick();
    await vi.waitFor(() => expect(seen).toHaveLength(1));

    expect(await stopWithinGrace(ha, pass)).toEqual({ stopped: true, passed: true });
    // An add cut short could never be repeated (it is marked started first),
    // so the stop does not cut it: the write was given no stop signal.
    expect(seen[0]!.signal).toBeUndefined();
  });
});
