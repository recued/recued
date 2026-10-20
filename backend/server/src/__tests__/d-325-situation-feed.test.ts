import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SituationRevision, SituationSnapshot } from '@recued/contracts';
import { createSituationStore } from '../storage/situation-store.js';

let db: Database.Database;
const snapshot = (): SituationSnapshot => ({ id: 'trip', state: 'proposed', urgency: 'routine',
  cluster: { id: 'trip', subjects: [{ collection: 'booking', id: 'b1' }], span: { from: 1, to: 100 }, omitted: 0, items: [] } });
beforeEach(() => { db = new Database(':memory:'); });
afterEach(() => db.close());

describe('D-325 durable situation feed', () => {
  it('commits before the doorbell, records meaningful changes in the same state, and ignores unchanged rereads', () => {
    const bus = { emit: vi.fn(() => { expect(db.inTransaction).toBe(false); expect(createSituationStore(db).get('trip')).not.toBeNull(); }) };
    const store = createSituationStore(db, bus);
    const first = store.save(snapshot(), { source: 'brief' }, 1)!;
    expect(first.revision).toBe(1); expect(bus.emit).toHaveBeenCalledTimes(1);
    expect(store.save(snapshot(), { source: 'brief' }, 2)).toBeNull();
    const next = snapshot(); next.urgency = 'floor';
    const second = store.save(next, { source: 'passport' }, 3)!;
    expect(second.changed_fields).toEqual(['urgency']); expect(second.before?.state).toBe(second.after.state);
    expect(store.revisionsAfter(0)).toHaveLength(2);
  });
  it('catches a crash or failed publication from the committed revision after restart', async () => {
    const store = createSituationStore(db, { emit: () => { throw new Error('bus failed'); } });
    store.save(snapshot(), { source: 'brief' }, 1);
    const restarted = createSituationStore(db); const receive = vi.fn(async () => true);
    expect(await restarted.catchUp('recipe:follow-up', receive)).toBe(1);
    expect(receive).toHaveBeenCalledTimes(1); expect(restarted.checkpoint('recipe:follow-up')).toBe(1);
    expect(await createSituationStore(db).catchUp('recipe:follow-up', receive)).toBe(0);
    expect(receive).toHaveBeenCalledTimes(1);
  });
  it('holds through a sealed vault and retries a failed subscriber without jumping past it', async () => {
    const store = createSituationStore(db); store.save(snapshot(), { source: 'brief' }, 1);
    const next = snapshot(); next.urgency = 'floor'; store.save(next, { source: 'evidence' }, 2);
    const receive = vi.fn(async () => false);
    expect(await store.catchUp('r1', receive, { isOpen: () => false })).toBe(0); expect(receive).not.toHaveBeenCalled();
    expect(await store.catchUp('r1', receive)).toBe(0); expect(store.checkpoint('r1')).toBe(0);
    const successful = vi.fn(async (_revision: SituationRevision) => true);
    expect(await store.catchUp('r1', successful)).toBe(2); expect(successful.mock.calls.map(args => args[0]?.revision)).toEqual([1, 2]);
    expect(() => { const other = createSituationStore(db); other.acknowledge('r2', 2); }).toThrow(/feed order/);
  });
  it('guards causes and concurrent catch-up, and keeps subscribers independent', async () => {
    const store = createSituationStore(db); store.save(snapshot(), { source: 'recipe:r1', revision: 1 }, 1);
    const receive = vi.fn(async () => true);
    expect(await store.catchUp('trigger:1', receive, { cause_source: 'recipe:r1' })).toBe(1); expect(receive).not.toHaveBeenCalled();
    expect(await store.catchUp('trigger:2', receive)).toBe(1); expect(receive).toHaveBeenCalledTimes(1);
    const next = snapshot(); next.urgency = 'floor'; store.save(next, { source: 'brief' }, 2);
    let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; });
    const first = store.catchUp('trigger:2', async () => { await wait; return true; });
    expect(await store.catchUp('trigger:2', receive)).toBe(0); release(); expect(await first).toBe(1);
  });
  it('records local measures only after explicit opt-in', () => {
    const store = createSituationStore(db);
    expect(store.measure('digest.response', 1, { outcome: 'accepted' }, 1)).toBe(false);
    store.writeSetting('metrics.opt_in', true);
    expect(store.measure('digest.response', 1, { outcome: 'accepted' }, 2)).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS n FROM proactive_measures').get()).toEqual({ n: 1 });
  });
});
