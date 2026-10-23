import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProactiveProposalInput } from '@recued/contracts';
import { createProactiveProposalStore } from '../storage/proactive-proposal-store.js';

const uuid = vi.hoisted(() => ({ next: undefined as string | undefined }));
vi.mock('node:crypto', async importOriginal => {
  const crypto = await importOriginal<typeof import('node:crypto')>();
  return { ...crypto, randomUUID: () => uuid.next ?? crypto.randomUUID() };
});
const databases: Database.Database[] = [];
afterEach(() => { uuid.next = undefined; for (const db of databases.splice(0)) db.close(); });
const input = (key: string): ProactiveProposalInput => ({ key, kind: 'rule', title: key, explanation: '',
  confidence: 'high', origin: 'owner', sources: [], payload: { note: 'Keep this' } });
const fixture = () => {
  let sql: string[] | undefined;
  const db = new Database(':memory:', { verbose: statement => sql?.push(String(statement)) }); databases.push(db);
  const store = createProactiveProposalStore(db);
  const measure = <T>(run: () => T) => { const statements: string[] = []; sql = statements;
    try { return { value: run(), sql: statements }; } finally { sql = undefined; }
  };
  const rows = () => db.prepare('SELECT * FROM proactive_proposals ORDER BY id').all();
  return { db, store, measure, rows };
};
const idReads = (sql: string[]) => sql.filter(statement => /^SELECT value FROM proactive_proposals WHERE id=/u.test(statement));
const writes = (sql: string[]) => sql.filter(statement => /^(?:INSERT|UPDATE|DELETE|REPLACE)\b/iu.test(statement));

describe('D-325 native proposal insertion', () => {
  for (const prefetched of [false, true]) it(`creates one proposal and event without a previous-ID read with prefetch=${prefetched}`, () => {
    const f = fixture(); const original = input("new-'漢😀"); const before = structuredClone(original);
    const lookup = prefetched ? f.store.prefetchKeys([original.key]) : undefined;
    const first = f.measure(() => f.store.ensure(original, 1, lookup));
    expect(idReads(first.sql)).toEqual([]); expect(writes(first.sql)).toHaveLength(2);
    expect(first.value).toEqual({ ...before, id: expect.stringMatching(/^proposal-/u), state: 'proposed', created_at: 1, updated_at: 1 });
    expect(f.store.byKey(original.key)).toEqual(first.value);
    expect(f.store.pendingEvents()).toEqual([{ revision: 1, at: 1, proposal: first.value }]);
    expect(original).toEqual(before); original.payload.note = 'Caller edit';
    expect(f.store.byKey(original.key)?.payload.note).toBe('Keep this');
    const repeated = f.measure(() => f.store.ensure(input(original.key), 2, lookup));
    expect(repeated.value).toEqual(first.value); expect(idReads(repeated.sql)).toEqual([]); expect(writes(repeated.sql)).toEqual([]);
    expect(f.store.pendingEvents()).toHaveLength(1);
  });

  for (const state of ['proposed', 'accepted', 'dismissed', 'retracted'] as const) it(`preserves an existing ${state} proposal during ensure`, () => {
    const f = fixture(); const first = f.store.ensure(input('existing'), 1);
    const saved = f.store.save({ ...first, state, title: 'Owner title', payload: { owner: true }, updated_at: 2,
      ...(state === 'dismissed' ? { dismissal: 'not_this_one' as const } : {}) });
    const events = f.store.pendingEvents();
    const repeated = f.measure(() => f.store.ensure({ ...input(first.key), title: 'Changed extraction' }, 3));
    expect(repeated.value).toEqual(saved); expect(idReads(repeated.sql)).toEqual([]); expect(writes(repeated.sql)).toEqual([]);
    expect(f.store.pendingEvents()).toEqual(events);
  });

  for (const malformed of [false, true]) it(`rejects a UUID collision without replacing a ${malformed ? 'malformed' : 'live'} proposal or its events`, () => {
    const f = fixture(); const existing = f.store.ensure(input('existing'), 1);
    if (malformed) f.db.prepare('UPDATE proactive_proposals SET value=? WHERE id=?').run('invalid JSON', existing.id);
    const before = f.rows(); const events = f.store.pendingEvents(); uuid.next = existing.id.slice('proposal-'.length);
    const result = f.measure(() => expect(() => f.store.ensure(input('new'), 2)).toThrow('UNIQUE constraint failed: proactive_proposals.id'));
    expect(idReads(result.sql)).toEqual([]); expect(f.rows()).toEqual(before); expect(f.store.byKey('new')).toBeNull();
    expect(f.store.pendingEvents()).toEqual(events); expect(f.db.inTransaction).toBe(false);
  });

  for (const reader of ['prefetched-miss', 'custom-miss'] as const) it(`keeps a conflicting key and its events intact with a ${reader}`, () => {
    const f = fixture(); const lookup = reader === 'prefetched-miss' ? f.store.prefetchKeys(['key']) : () => null;
    const existing = f.store.ensure(input('key'), 1); const events = f.store.pendingEvents();
    const result = f.measure(() => expect(() => f.store.ensure(input('key'), 2, lookup))
      .toThrow('UNIQUE constraint failed: proactive_proposals.dedupe_key'));
    expect(idReads(result.sql)).toEqual([]); expect(f.store.byKey('key')).toEqual(existing);
    expect(f.store.list()).toEqual([existing]); expect(f.store.pendingEvents()).toEqual(events);
  });

  for (const collision of ['id', 'dedupe_key'] as const) it(`preserves earlier caller writes and continues after a nested ${collision} collision`, () => {
    const f = fixture(); const existing = f.store.ensure(input('existing'), 1);
    const committed = f.db.transaction(() => {
      const earlier = f.store.ensure(input('earlier'), 2); const events = f.store.pendingEvents();
      if (collision === 'id') uuid.next = existing.id.slice('proposal-'.length);
      try {
        expect(() => f.store.ensure(input(collision === 'id' ? 'new' : existing.key), 3, () => null))
          .toThrow(`UNIQUE constraint failed: proactive_proposals.${collision}`);
      } finally { uuid.next = undefined; }
      expect(f.db.inTransaction).toBe(true); expect(f.store.byKey('earlier')).toEqual(earlier);
      expect(f.store.byKey('existing')).toEqual(existing); expect(f.store.byKey('new')).toBeNull();
      expect(f.store.pendingEvents()).toEqual(events);
      const later = f.store.ensure(input('later'), 4); return [existing, earlier, later];
    })();
    expect(f.db.inTransaction).toBe(false);
    expect(f.store.list().map(row => row.key).sort()).toEqual(['earlier', 'existing', 'later']);
    expect(f.store.pendingEvents().map(event => event.proposal)).toEqual(committed);
  });

  for (const outer of [false, true]) it(`rolls back the proposal when its event cannot be written with outer transaction=${outer}`, () => {
    const f = fixture(); const existing = f.store.ensure(input('existing'), 1); const events = f.store.pendingEvents();
    const preserved = [existing];
    f.db.exec(`CREATE TRIGGER reject_new_proposal_event BEFORE INSERT ON proactive_proposal_events
      WHEN json_extract(NEW.value,'$.key')='new' BEGIN SELECT RAISE(ABORT,'Fixture outbox unavailable'); END`);
    const action = () => {
      if (outer) preserved.push(f.store.ensure(input('earlier'), 2));
      const before = f.store.pendingEvents();
      const result = f.measure(() => expect(() => f.store.ensure(input('new'), 2)).toThrow('Fixture outbox unavailable'));
      expect(idReads(result.sql)).toEqual([]); expect(f.store.byKey('new')).toBeNull();
      expect(f.store.pendingEvents()).toEqual(before); expect(f.db.inTransaction).toBe(outer);
      for (const row of preserved) expect(f.store.byKey(row.key)).toEqual(row);
    };
    if (outer) f.db.transaction(action)(); else action();
    expect(f.store.list().map(row => row.key).sort()).toEqual(preserved.map(row => row.key).sort());
    expect(f.store.pendingEvents().slice(0, events.length)).toEqual(events); expect(f.db.inTransaction).toBe(false);
    f.db.exec('DROP TRIGGER reject_new_proposal_event');
    const retry = f.store.ensure(input('new'), 3);
    expect(f.store.pendingEvents().map(event => event.proposal)).toEqual([...preserved, retry]);
  });

  it('rolls back an inserted proposal and event with its caller transaction', () => {
    const f = fixture();
    expect(() => f.db.transaction(() => {
      const row = f.store.ensure(input('new'), 1); expect(f.store.byKey(row.key)).toEqual(row);
      expect(f.store.pendingEvents()).toHaveLength(1); throw new Error('Fixture caller rollback');
    })()).toThrow('Fixture caller rollback');
    expect(f.store.list()).toEqual([]); expect(f.store.pendingEvents()).toEqual([]);
  });

  it('keeps public save upserts and semantic-event suppression', () => {
    const f = fixture(); const row = { ...input('external'), id: 'external-id', state: 'proposed' as const, created_at: 1, updated_at: 1 };
    const first = f.measure(() => f.store.save(row)); expect(idReads(first.sql)).toHaveLength(1); expect(writes(first.sql)).toHaveLength(2);
    const shown = { ...row, shown_at: 2, edited_at: 2, updated_at: 2 };
    const repeat = f.measure(() => f.store.save(shown)); expect(idReads(repeat.sql)).toHaveLength(1); expect(writes(repeat.sql)).toHaveLength(1);
    expect(f.store.read(row.id)).toEqual(shown); expect(f.store.pendingEvents()).toHaveLength(1);
    const changed = { ...shown, title: 'Changed title', updated_at: 3 };
    const update = f.measure(() => f.store.save(changed)); expect(idReads(update.sql)).toHaveLength(1); expect(writes(update.sql)).toHaveLength(2);
    expect(f.store.pendingEvents().map(event => event.proposal)).toEqual([row, changed]); expect(f.store.read(row.id)).toEqual(changed);
  });

  it('rejects invalid input before reading or writing proposals', () => {
    const f = fixture(); const result = f.measure(() => expect(() => f.store.ensure({ ...input('bad'), title: '' }, 1))
      .toThrow('Invalid or oversized proposal'));
    expect(result.sql).toEqual([]); expect(f.store.list()).toEqual([]); expect(f.store.pendingEvents()).toEqual([]);
  });

  it('revalidates the full proposal size after adding its generated fields', () => {
    const f = fixture(); const value = { ...input('large'), payload: { text: '' } };
    value.payload.text = 'x'.repeat(65535 - JSON.stringify(value).length); expect(JSON.stringify(value)).toHaveLength(65535);
    const result = f.measure(() => expect(() => f.store.ensure(value, 1)).toThrow('Invalid or oversized proposal'));
    expect(idReads(result.sql)).toEqual([]); expect(writes(result.sql)).toEqual([]);
    expect(f.store.list()).toEqual([]); expect(f.store.pendingEvents()).toEqual([]);
  });
});
