import Database from 'better-sqlite3';
import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
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
import type { BoundedHttpFetcher } from '../bounded-origin-http-fetcher.js';

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
    if (path.startsWith('/api/states/')) result = { entity_id: 'todo.household', state: '1', attributes: { supported_features: flags } };
    else if (path.endsWith('/get_items')) result = { service_response: { 'todo.household': { items: structuredClone(remote) } } };
    else if (path.endsWith('/add_item')) { remote.push({ uid: `ha-${++sequence}`, summary: body.item, description: body.description, status: 'needs_action', due: body.due_date });
      if (loseAck) { loseAck = false; throw new Error('Acknowledgement lost'); } }
    else if (path.endsWith('/update_item')) { const item = remote.find(item => item.uid === body.item); if (!item) throw new Error('Item missing'); item.summary = body.rename; item.description = body.description; }
    else if (path.endsWith('/remove_item')) { const index = remote.findIndex(item => item.uid === body.item); if (index >= 0) remote.splice(index, 1); }
    else throw new Error(`Unexpected provider path ${path}`);
    return { ok: true, status: 200, statusText: 'OK', headers: new Headers(), json: async () => result, text: async () => JSON.stringify(result) };
  };
  const boot = (network = false) => createHouseholdHomeAssistant({ db, work, occurrences, connections: () => connections, credential: async () => 'test-token',
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
      f.remote[0]!.status = 'completed'; await ha.tick(); expect(f.work.readCommitment(original.commitment_id!)!.lifecycle_state).toBe('fulfilled');
      expect(f.remote).toEqual([]);
    } finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });
  it('projects only household tasks and closes the original without inventing an outage-time service date', async () => {
    const f = fixture(); const shared = f.put('Boiler'); f.put('Personal policy', 'owner'); await f.occurrences.tick();
    const original = f.row(shared.id); const ha = f.boot(); await f.configure(ha); await ha.tick();
    expect(f.remote).toHaveLength(1); expect(f.remote[0]!.summary).toBe('Service · Boiler'); expect(f.remote[0]!.due).toBe('2026-11-17');
    f.remote[0]!.status = 'completed'; f.time('2026-10-24T12:00Z'); await ha.tick();
    expect(f.work.readCommitment(original.commitment_id!)!.lifecycle_state).toBe('fulfilled'); expect(f.remote).toEqual([]);
    expect(f.work.readAsset(shared.id)!.dates.serviced_on).toBe('2025-11-17');
    expect(createAssetOccurrenceStore(f.db).completion(original.id)).toMatchObject({ known: false, reading: null });
    const yours = createYoursService({ db: f.db, work: f.work, dispatchers: f.dispatchers, occurrences: f.occurrences, situations: createSituationStore(f.db), now: () => Date.parse('2026-10-24T12:00Z') });
    const question = (await yours.snapshot({ asset_id: shared.id })).proposals.find(row => row.kind === 'completion')!;
    expect(question.payload.occurrence_id).toBe(original.id);
    await f.occurrences.confirmCompletion({ occurrence_id: original.id, on: '2026-10-18' });
    expect(f.work.readAsset(shared.id)!.dates.serviced_on).toBe('2026-10-18');
    expect((await yours.snapshot({ asset_id: shared.id })).proposals.filter(row => row.kind === 'completion')).toEqual([]);
  });
  it('recovers a lost acknowledgement by its saved marker and never adds a second copy after restart', async () => {
    const f = fixture(); f.put('Boiler'); await f.occurrences.tick(); f.loseAck(); const ha = f.boot(); await f.configure(ha);
    expect(ha.read().uncertain).toBe(1); expect(f.remote).toHaveLength(1);
    const restarted = f.boot(); await restarted.tick(); await restarted.tick();
    expect(restarted.read().uncertain).toBe(0); expect(f.calls.filter(row => row.path.endsWith('/add_item'))).toHaveLength(1);
  });
  it('does not guess a usage service reading from a later current odometer', async () => {
    const f = fixture(); const shared = f.put('Car', 'household', { ...f.rule, when: { kind: 'objective', mode: 'usage', field: 'odometer', target: 10_000,
      unit: 'km', direction: 'rising', every: 10_000, lead_days: 14 } }); await f.occurrences.tick(); const original = f.row(shared.id); const ha = f.boot(); await f.configure(ha); await ha.tick();
    f.remote[0]!.status = 'completed'; f.time('2026-11-17T12:00Z'); f.work.writeAsset({ id: shared.id, source_id: 'recued.asset', source: { kind: 'owner', ref: 'reading' },
      readings: { odometer: { value: 21_000, unit: 'km', as_of: Date.parse('2026-11-17T12:00Z'), evidence: [] } } }, Date.parse('2026-11-17T12:00Z'));
    await ha.tick(); expect(f.work.readAsset(shared.id)!.rules[0]!.when).toMatchObject({ target: 10_000 });
    await expect(f.occurrences.confirmCompletion({ occurrence_id: original.id, on: '2026-10-18' })).rejects.toThrow('actual service reading');
    await f.occurrences.confirmCompletion({ occurrence_id: original.id, on: '2026-10-18', reading: { value: 12_000, unit: 'km' } });
    expect(f.work.readAsset(shared.id)!.rules[0]!.when).toMatchObject({ target: 22_000 });
    expect(f.work.readAsset(shared.id)!.readings.odometer!.value).toBe(21_000);
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
  it('labels a list without update support display-only and refuses lists that cannot retain recovery markers', async () => {
    const f = fixture(); const shared = f.put('Boiler'); await f.occurrences.tick(); const original = f.row(shared.id); const ha = f.boot();
    f.flags(1 | 2 | 64); await f.configure(ha); await ha.tick(); expect(ha.read().selection!.mode).toBe('display_only');
    expect(f.remote[0]!.description).toContain('Display only'); f.remote[0]!.status = 'completed'; await ha.tick();
    expect(f.work.readCommitment(original.commitment_id!)!.lifecycle_state).toBe('pending');
    f.flags(1 | 2 | 4); await expect(f.configure(ha)).rejects.toThrow('descriptions');
    f.seal(); const before = f.calls.length; await ha.tick(); expect(f.calls.length).toBe(before);
  });
});
