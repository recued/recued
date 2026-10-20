import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { createOccurrenceReminderStore, type OccurrenceReminderPlan } from '../storage/occurrence-reminder-store.js';

const plan = (group_id: string, point_key: string, occurrence_id = 'occurrence'): OccurrenceReminderPlan => ({
  delivery: { group_id, destinations: [{ id: 'ui', channel: 'ui' }], asks: [{ ask_id: `ask-${group_id}`,
    message: { title: 'Passport', text: 'Renew passport.' }, options: [{ id: 'done', label: 'Done' }],
    handler: { kind: 'reminder.occurrence', payload: { occurrence_id } },
  }] }, points: [{ occurrence_id, point_key, on: '2026-10-17', ask_id: `ask-${group_id}`, skipped_keys: [] }],
});

describe('D-325 reminder point outbox', () => {
  it('recovers a reserved point with the same question, and coalesces missed points without minting their questions', () => {
    const directory = mkdtempSync(join(tmpdir(), 'd325-points-'));
    const path = join(directory, 'points.sqlite');
    let db = new Database(path);
    try {
      const first = createOccurrenceReminderStore(db);
      const input = plan('current', 'before:1:months');
      input.points[0]!.skipped_keys = ['before:6:months', 'before:3:months'];
      first.reserve(input, 1000);
      db.close(); db = new Database(path);
      const recovered = createOccurrenceReminderStore(db);
      expect(recovered.reserve(input, 2000).created_at).toBe(1000);
      expect(recovered.pending()).toHaveLength(1);
      expect(recovered.pending()[0]!.plan.delivery.asks.map(ask => ask.ask_id)).toEqual(['ask-current']);
      expect(recovered.point('occurrence', 'before:6:months')).toEqual({ group_id: 'current', ask_id: null });
      expect(recovered.point('occurrence', 'before:1:months')).toEqual({ group_id: 'current', ask_id: 'ask-current' });
      expect(() => recovered.reserve(plan('duplicate', 'before:1:months'), 3000)).toThrow('already planned');
      expect(recovered.plan('duplicate')).toBeNull();
    } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  it('requires the previous question to close before replacement, including after abandoning an earlier plan', () => {
    const db = new Database(':memory:');
    try {
      const store = createOccurrenceReminderStore(db);
      store.reserve(plan('first', 'before:6:months'), 1000);
      store.activate('first', 1001); store.ready('first', '2026-04-17', 1002); store.released('first', 1003);
      store.reserve(plan('second', 'before:3:months'), 2000);
      expect(store.replacements('second')).toEqual([{ occurrence_id: 'occurrence', ask_id: 'ask-first' }]);
      expect(() => store.activate('second', 2001)).toThrow('Close the previous reminder');
      expect(store.control('occurrence').current_ask_id).toBe('ask-first');
      store.abandon('second', 'source_changed', 2002);
      store.reserve(plan('third', 'before:1:months'), 3000);
      expect(store.replacements('third')).toEqual([{ occurrence_id: 'occurrence', ask_id: 'ask-first' }]);
      expect(() => store.activate('third', 3001)).toThrow('Close the previous reminder');
      store.acknowledgeReplacement('ask-first', 3002);
      store.activate('third', 3003);
      expect(store.control('occurrence').current_ask_id).toBe('ask-third');
      store.ready('third', '2026-10-17', 3004);
      // Ready remains an outbox entry until the ask layer acknowledges handoff.
      expect(store.pending()[0]!.phase).toBe('ready');
      store.released('third', 3005);
      expect(store.pending()).toEqual([]);
      expect(() => store.abandon('third', 'too_late', 3005)).toThrow('through its ask');
    } finally { db.close(); }
  });

  it('reserves an entire bundle atomically and keeps an answer receipt stable across a retry', () => {
    const db = new Database(':memory:');
    try {
      const store = createOccurrenceReminderStore(db);
      store.reserve(plan('first', 'on_day'), 1000);
      const conflict = plan('conflict', 'on_day');
      const other = plan('other', 'on_day', 'other-occurrence');
      conflict.delivery.asks = [...conflict.delivery.asks, ...other.delivery.asks];
      conflict.points.push(...other.points);
      expect(() => store.reserve(conflict, 2000)).toThrow('already planned');
      expect(store.point('other-occurrence', 'on_day')).toBeNull();
      const answer = { ask_id: 'ask-first', occurrence_id: 'occurrence', outcome: 'done' as const, answered_at: 3000 };
      expect(store.answer(answer).applied_at).toBeNull();
      store.applied(answer.ask_id, 3001);
      expect(store.answer(answer).applied_at).toBe(3001);
      expect(store.pendingAnswers()).toEqual([]);
      expect(() => store.answer({ ...answer, outcome: 'not_needed' })).toThrow('different answer');
    } finally { db.close(); }
  });
});
