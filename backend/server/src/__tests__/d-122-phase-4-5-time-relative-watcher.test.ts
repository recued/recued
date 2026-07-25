/** D-122 Phase 4.5 — `time-relative-watcher` tests. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  handleTimeRelativeWatcher,
  parseOffsetMs,
  ensureTimeRelativeWatcherSchema,
} from '../watchers/time-relative-watcher.js';
import type { CollectionRegistry } from '../collections/registry.js';
import type { Collection } from '../collections/types.js';
import type { WorkEntityStore } from '../storage/work-entity-store.js';

let dir: string;
let db: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'time-relative-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  ensureTimeRelativeWatcherSchema(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const NOW = 1_700_000_000_000;

const fakeRegistry = (records: Record<string, unknown>[]): CollectionRegistry => {
  const collection = {
    platform: 'calendar',
    slug: 'primary',
    list: () => records,
  } as unknown as Collection;
  return {
    register: () => undefined,
    get: () => collection,
    list: () => [collection],
    dispose: async () => undefined,
  };
};

type TaskListQuery = Parameters<WorkEntityStore['listTasks']>[0];

const fakeTaskStore = (
  records: Record<string, unknown>[],
  calls?: TaskListQuery[],
): Pick<WorkEntityStore, 'listTasks'> => ({
  listTasks: (query?: TaskListQuery) => {
    calls?.push(query);
    const offset = query?.offset ?? 0;
    const limit = query?.limit ?? records.length;
    return records.slice(offset, offset + limit) as unknown as ReturnType<WorkEntityStore['listTasks']>;
  },
});

describe('parseOffsetMs', () => {
  it('parses negative day offsets', () => {
    expect(parseOffsetMs('-3d')).toBe(-3 * 86_400_000);
  });
  it('parses positive minute offsets', () => {
    expect(parseOffsetMs('+30m')).toBe(30 * 60_000);
  });
  it('treats unsigned as positive', () => {
    expect(parseOffsetMs('1h')).toBe(3_600_000);
  });
  it('throws on malformed input', () => {
    expect(() => parseOffsetMs('foo')).toThrow();
    expect(() => parseOffsetMs('3y')).toThrow();
    expect(() => parseOffsetMs('')).toThrow();
  });
});

describe('handleTimeRelativeWatcher', () => {
  it('returns should_run: false when no record matches', async () => {
    const registry = fakeRegistry([]);
    const out = await handleTimeRelativeWatcher(
      { db, registry, now: () => NOW },
      {
        collection: 'data.calendar',
        anchor_field: 'start_at',
        offsets: ['-1h'],
        recipe_id: 'r1',
      },
    );
    expect(out.should_run).toBe(false);
    expect(out.fired).toBe(false);
  });

  it('fires when an offset boundary is in the past but inside the lookback window', async () => {
    // Meeting starts 30 minutes from "now". `-1h` offset means fire
    // 1 hour before meeting — that boundary already crossed 30
    // minutes ago. Should fire.
    const meetingAt = NOW + 30 * 60_000;
    const registry = fakeRegistry([
      { _id: 'evt-1', hot_fields: { start_at: meetingAt } },
    ]);
    const out = await handleTimeRelativeWatcher(
      { db, registry, now: () => NOW },
      {
        collection: 'data.calendar',
        anchor_field: 'start_at',
        offsets: ['-1h'],
        recipe_id: 'r1',
      },
    );
    expect(out.should_run).toBe(true);
    expect(out.fired).toBe(true);
    expect(out.trigger_record_id).toBe('evt-1');
    expect(out.trigger_offset).toBe('-1h');
    expect(out.anchor_at).toBe(meetingAt);
  });

  it('does not refire the same (record, offset) on a subsequent tick', async () => {
    const meetingAt = NOW + 30 * 60_000;
    const registry = fakeRegistry([
      { _id: 'evt-1', hot_fields: { start_at: meetingAt } },
    ]);
    const args = {
      collection: 'data.calendar',
      anchor_field: 'start_at',
      offsets: ['-1h'],
      recipe_id: 'r1',
    };
    const first = await handleTimeRelativeWatcher(
      { db, registry, now: () => NOW },
      args,
    );
    expect(first.fired).toBe(true);
    const second = await handleTimeRelativeWatcher(
      { db, registry, now: () => NOW },
      args,
    );
    expect(second.fired).toBe(false);
    expect(second.should_run).toBe(false);
  });

  it('skips offsets whose boundary is in the future', async () => {
    // Meeting in 3 hours. `-1h` boundary not yet crossed.
    const meetingAt = NOW + 3 * 3_600_000;
    const registry = fakeRegistry([
      { _id: 'evt-1', hot_fields: { start_at: meetingAt } },
    ]);
    const out = await handleTimeRelativeWatcher(
      { db, registry, now: () => NOW },
      {
        collection: 'data.calendar',
        anchor_field: 'start_at',
        offsets: ['-1h'],
        recipe_id: 'r1',
      },
    );
    expect(out.fired).toBe(false);
  });

  it('fires the next offset on the same record after the first one fired', async () => {
    const meetingAt = NOW + 5 * 60_000;
    const registry = fakeRegistry([
      { _id: 'evt-1', hot_fields: { start_at: meetingAt } },
    ]);
    const args = {
      collection: 'data.calendar',
      anchor_field: 'start_at',
      offsets: ['-1h', '-10m'],
      recipe_id: 'r1',
    };
    const first = await handleTimeRelativeWatcher(
      { db, registry, now: () => NOW },
      args,
    );
    expect(first.fired).toBe(true);
    const offsetA = first.trigger_offset!;
    const second = await handleTimeRelativeWatcher(
      { db, registry, now: () => NOW + 1 },
      args,
    );
    expect(second.fired).toBe(true);
    expect(second.trigger_offset).not.toBe(offsetA);
  });

  it('honours the optional filter substring against hot_fields', async () => {
    const meetingAt = NOW + 30 * 60_000;
    const registry = fakeRegistry([
      { _id: 'evt-1', hot_fields: { start_at: meetingAt, status: 'confirmed' } },
      { _id: 'evt-2', hot_fields: { start_at: meetingAt, status: 'cancelled' } },
    ]);
    const out = await handleTimeRelativeWatcher(
      { db, registry, now: () => NOW },
      {
        collection: 'data.calendar',
        anchor_field: 'start_at',
        offsets: ['-1h'],
        filter: 'cancelled',
        recipe_id: 'r1',
      },
    );
    expect(out.fired).toBe(true);
    expect(out.trigger_record_id).toBe('evt-2');
  });

  it('fires against data.task due_at anchors and returns the task record', async () => {
    const dueAt = NOW - 1_000;
    const out = await handleTimeRelativeWatcher(
      {
        db,
        workEntityStore: fakeTaskStore([
          {
            id: 'tsk-1',
            title: 'Call Ada',
            body: 'Ask about launch window',
            due_at: dueAt,
            done: false,
            state: 'reminder_pending',
            source_id: 'src_recued_builtin',
            last_seen_at: NOW,
            sync_state: 'live',
            conflict_policy: 'last_write_wins',
            blocks_task_ids: [],
            created_at: NOW - 60_000,
            updated_at: NOW - 60_000,
            source_extension_blob: { kind: 'recued_reminder' },
          },
        ]),
        now: () => NOW,
      },
      {
        collection: 'data.task',
        anchor_field: 'due_at',
        offsets: ['0s'],
        filter: 'recued_reminder',
        recipe_id: 'r1',
      },
    );
    expect(out.should_run).toBe(true);
    expect(out.trigger_record_id).toBe('tsk-1');
    expect(out.trigger_record).toMatchObject({
      _id: 'tsk-1',
      _collection: 'task',
      title: 'Call Ada',
      body: 'Ask about launch window',
      state: 'reminder_pending',
    });

    const second = await handleTimeRelativeWatcher(
      {
        db,
        workEntityStore: fakeTaskStore([
          {
            id: 'tsk-1',
            title: 'Call Ada',
            due_at: dueAt,
            done: false,
            source_id: 'src_recued_builtin',
            last_seen_at: NOW,
            sync_state: 'live',
            conflict_policy: 'last_write_wins',
            blocks_task_ids: [],
            created_at: NOW - 60_000,
            updated_at: NOW - 60_000,
            state: 'reminder_pending',
            source_extension_blob: { kind: 'recued_reminder' },
          },
        ]),
        now: () => NOW,
      },
      {
        collection: 'data.task',
        anchor_field: 'due_at',
        offsets: ['0s'],
        filter: 'recued_reminder',
        recipe_id: 'r1',
      },
    );
    expect(second.should_run).toBe(true);
    expect(second.trigger_record_id).toBe('tsk-1');
  });

  it('keeps reminder tasks quiet after the state leaves pending', async () => {
    const dueAt = NOW - 1_000;
    const out = await handleTimeRelativeWatcher(
      {
        db,
        workEntityStore: fakeTaskStore([
          {
            id: 'tsk-1',
            title: 'Call Ada',
            due_at: dueAt,
            done: false,
            state: 'reminder_fired',
            source_id: 'src_recued_builtin',
            last_seen_at: NOW,
            sync_state: 'live',
            conflict_policy: 'last_write_wins',
            blocks_task_ids: [],
            created_at: NOW - 60_000,
            updated_at: NOW - 60_000,
            source_extension_blob: { kind: 'recued_reminder' },
          },
        ]),
        now: () => NOW,
      },
      {
        collection: 'data.task',
        anchor_field: 'due_at',
        offsets: ['0s'],
        filter: 'recued_reminder',
        recipe_id: 'r1',
      },
    );
    expect(out.should_run).toBe(false);
  });

  it('fair-rotates undeliverable reminders so one cannot head-of-line-block the others', async () => {
    const dueAt = NOW - 1_000;
    const mkReminder = (id: string, updatedAt: number): Record<string, unknown> => ({
      id,
      title: `Reminder ${id}`,
      body: `body ${id}`,
      due_at: dueAt,
      done: false,
      state: 'reminder_pending',
      source_id: 'src_recued_builtin',
      last_seen_at: NOW,
      sync_state: 'live',
      conflict_policy: 'last_write_wins',
      blocks_task_ids: [],
      created_at: NOW - 60_000,
      updated_at: updatedAt,
      source_extension_blob: { kind: 'recued_reminder' },
    });
    // Two due, pending reminders that never deliver (the watcher only
    // fires; task state never leaves `reminder_pending` here). `tsk-a`
    // sorts first, so the pre-fix return-on-first-fire path fired `tsk-a`
    // on EVERY tick and `tsk-b` starved forever.
    const store = fakeTaskStore([
      mkReminder('tsk-a', NOW - 1_000),
      mkReminder('tsk-b', NOW - 2_000),
    ]);
    const args = {
      collection: 'data.task',
      anchor_field: 'due_at',
      offsets: ['0s'],
      filter: 'recued_reminder',
      recipe_id: 'r1',
    };
    // Same durable ledger (`db`) across both ticks — the second tick sees
    // tsk-a's recorded attempt and prefers the least-recently-attempted.
    const first = await handleTimeRelativeWatcher(
      { db, workEntityStore: store, now: () => NOW },
      args,
    );
    const second = await handleTimeRelativeWatcher(
      { db, workEntityStore: store, now: () => NOW },
      args,
    );

    expect(first.should_run).toBe(true);
    expect(second.should_run).toBe(true);
    // The second tick fires the OTHER reminder — no head-of-line block.
    expect(second.trigger_record_id).not.toBe(first.trigger_record_id);
    expect(new Set([first.trigger_record_id, second.trigger_record_id])).toEqual(
      new Set(['tsk-a', 'tsk-b']),
    );
  });

  it('paginates data.task anchors beyond the first work-entity page', async () => {
    const dueAt = NOW - 1_000;
    const calls: TaskListQuery[] = [];
    const filler = Array.from({ length: 500 }, (_, i) => ({
      id: `filler-${i}`,
      title: `Filler ${i}`,
      due_at: dueAt,
      done: false,
      source_id: 'src_recued_builtin',
      last_seen_at: NOW,
      sync_state: 'live',
      conflict_policy: 'last_write_wins',
      blocks_task_ids: [],
      created_at: NOW - 120_000,
      updated_at: NOW - i,
    }));
    const out = await handleTimeRelativeWatcher(
      {
        db,
        workEntityStore: fakeTaskStore([
          ...filler,
          {
            id: 'tsk-late-page',
            title: 'Late-page reminder',
            due_at: dueAt,
            done: false,
            state: 'reminder_pending',
            source_id: 'src_recued_builtin',
            last_seen_at: NOW,
            sync_state: 'live',
            conflict_policy: 'last_write_wins',
            blocks_task_ids: [],
            created_at: NOW - 60_000,
            updated_at: NOW - 60_000,
            source_extension_blob: { kind: 'recued_reminder' },
          },
        ], calls),
        now: () => NOW,
      },
      {
        collection: 'data.task',
        anchor_field: 'due_at',
        offsets: ['0s'],
        filter: 'recued_reminder',
        recipe_id: 'r1',
      },
    );
    expect(out.should_run).toBe(true);
    expect(out.trigger_record_id).toBe('tsk-late-page');
    expect(calls.map((q) => q?.offset ?? 0)).toEqual([0, 500]);
  });

  it('rejects malformed offsets at validation time', async () => {
    const registry = fakeRegistry([]);
    await expect(handleTimeRelativeWatcher(
      { db, registry, now: () => NOW },
      {
        collection: 'data.calendar',
        anchor_field: 'start_at',
        offsets: ['3y'],
        recipe_id: 'r1',
      },
    )).rejects.toThrow();
  });

  it('returns should_run: false when the collection isn’t enrolled', async () => {
    const registry: CollectionRegistry = {
      register: () => undefined,
      get: () => undefined,
      list: () => [],
      dispose: async () => undefined,
    };
    const out = await handleTimeRelativeWatcher(
      { db, registry, now: () => NOW },
      {
        collection: 'data.calendar',
        anchor_field: 'start_at',
        offsets: ['-1h'],
        recipe_id: 'r1',
      },
    );
    expect(out.should_run).toBe(false);
  });
});
