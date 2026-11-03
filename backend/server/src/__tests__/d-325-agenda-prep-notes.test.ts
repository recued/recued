import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { PreparationNotesValue } from '@recued/contracts';
import { createEnrichmentStore } from '../storage/enrichment-store.js';
import { preparationNotesReady } from '../situations/agenda-prep-notes.js';

const value: PreparationNotesValue = { summary: 'Prep brief: agree the week’s priorities.', key_points: ['Budget is still open'],
  attendees_considered: ['ana@example.com'], corpus_size: 3, computed_at: 1 };
const dbs: Database.Database[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });
const fixture = () => {
  const db = new Database(':memory:'); dbs.push(db); const store = createEnrichmentStore(db);
  return { db, store, ready: preparationNotesReady(store) };
};

describe('D-325 §15.7 amendment (2026-11-02, later) — the Agenda reads Meeting preparation notes', () => {
  it('calls an event ready only while it has a fresh preparation_notes row, by its record id', () => {
    const f = fixture();
    f.store.upsert({ topic: 'preparation_notes', scope: 'calendar', target_id: 'rec-briefing', value, authored_by: 'housekeeping:preparation_notes' });
    expect(f.ready('rec-briefing')).toBe(true);
    expect(f.ready('rec-standup')).toBe(false);
    // The event changed after the notes were written: the cascade marks them stale.
    f.db.prepare("UPDATE data_enrichment SET staleness_class='stale' WHERE target_id='rec-briefing'").run();
    expect(f.ready('rec-briefing')).toBe(false);
  });

  it('does not count another topic on the same event', () => {
    const f = fixture();
    f.store.upsert({ topic: 'related_threads', scope: 'calendar', target_id: 'rec-briefing',
      value: { threads: [], candidate_count: 0, ai_invoked: false, computed_at: 1 }, authored_by: 'housekeeping:related_threads' });
    expect(f.ready('rec-briefing')).toBe(false);
  });

  it('says no when the read fails, rather than failing the Agenda', () => {
    const ready = preparationNotesReady({ list: () => { throw new Error('database is locked'); } });
    expect(ready('rec-briefing')).toBe(false);
  });
});
