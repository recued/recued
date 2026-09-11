import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CollectionRecord, SourceRegistration, WorkEntity } from '@recued/contracts';
import { loadToday, renderToday, todayWindow } from '../data/today-view.js';
import type { BootstrapDataRouteOptions } from '../data/bootstrap-data-route.js';

const now = new Date(2026, 8, 8, 12).getTime();
const hour = 3_600_000;
const { tomorrow, before } = todayWindow(now);
const source: SourceRegistration = { id: 'recued.task', top_tier_kind: 'task', source_kind: 'builtin',
  source_label: 'My tasks', write_capable: true, registered_at: 1 };
const identity = { source_id: source.id, sync_state: 'live', conflict_policy: 'source_wins', last_seen_at: now,
  created_at: now, updated_at: now } as const;
const task = (id: string, due_at: number | undefined, done = false): WorkEntity => ({ ...identity,
  _kind: 'task', id, title: id, done, blocks_task_ids: [], ...(due_at === undefined ? {} : { due_at }) });
const commitment = (id: string, promised_for_at: number, lifecycle_state: 'pending' | 'fulfilled' | 'cancelled' | 'expired' = 'pending'): WorkEntity => ({
  ...identity, source_id: 'recued.commitment', _kind: 'commitment', id, statement: id, promised_for_at,
  promised_at: now, direction: 'outbound', lifecycle_state, due_status: 'not_due', expiry_policy: 'escalate_overdue',
  state_changed_at: now, lifecycle_changed_at: now, due_status_changed_at: now, derivation: 'user_declared',
  blocks_task_ids: [], blocks_project_ids: [],
});
const event = (id: string, start_at: number, end_at: number, status = 'confirmed'): CollectionRecord => ({
  record_id: id, source_id: id, received_at: 1, modified_at: 1, size_bytes: 0,
  hot_fields: { summary: id, start_at, end_at, status },
});
const instances = [{ platform: 'calendar', slug: 'work', adapter_type: 'gcal',
  caps: { read: 'yes', list_calendars: 'yes', create_event: 'yes', update_event: 'yes', delete_event: 'yes',
    rsvp: 'yes', search: 'local', watch: 'poll', auth: 'oauth', recurrence: 'server' },
  auth_state: 'healthy', last_synced_at: now }] as const;
const fresh = { last_success_at: now, age_ms: 0, pending: 0, degraded: false, stale: false };
const readers = (entities: WorkEntity[] = [], records: CollectionRecord[] = []): Parameters<typeof loadToday>[0] => ({
  workEntitySourceListCaller: async () => ({ sources: [source, { ...source, id: 'recued.commitment', top_tier_kind: 'commitment' }] }),
  workEntityListCaller: async ({ kind, offset = 0, limit = 100 }) => {
    const rows = entities.filter((entity) => entity._kind === kind);
    return { entities: rows.slice(offset, offset + limit), total: rows.length };
  },
  collectionListInstancesCaller: async () => ({ instances: [...instances] }),
  collectionListCaller: async ({ offset = 0, limit = 100, filters }) => {
    const rows = records.filter((record) => filters?.is_all_day === undefined
      || filters.is_all_day === (record.hot_fields.is_all_day === true || record.hot_fields.is_all_day === 1));
    return { records: rows.slice(offset, offset + limit), source_freshness: fresh };
  },
});

afterEach(() => vi.restoreAllMocks());
describe('Today projection', () => {
  it('merges disjoint date groups and excludes completed, terminal, undated, ended, cancelled and out-of-window records', async () => {
    const snapshot = await loadToday(readers([
      task('overdue', now - hour), task('due-now', now), task('later', now + hour), task('tomorrow', tomorrow),
      task('last-minute', before - 1), task('beyond', before), task('done', now, true), task('undated', undefined),
      commitment('late-promise', now - 2 * hour), commitment('promise', now + 2 * hour),
      ...(['fulfilled', 'cancelled', 'expired'] as const).map((state) => commitment(state, now - hour, state)),
    ], [event('ended', now - hour, now), event('ongoing', now - hour, now + hour),
      event('meeting', now + 3 * hour, now + 4 * hour), event('cancelled', now, tomorrow, 'cancelled'),
      event('next-week', before, before + hour)]), now);
    expect(snapshot.items.filter((item) => item.group === 'overdue').map((item) => item.title)).toEqual(['late-promise', 'overdue']);
    expect(snapshot.items.filter((item) => item.group === 'today').map((item) => item.title)).toEqual(['ongoing', 'due-now', 'later', 'promise', 'meeting']);
    expect(snapshot.items.filter((item) => item.group === 'next').map((item) => item.title)).toEqual(['tomorrow', 'last-minute']);
    expect(snapshot.issues).toEqual([]);
  });

  it('pages both work kinds and all calendars with one fixed window, preserving source identity and exact detail URLs', async () => {
    const opts = readers([
      ...Array.from({ length: 205 }, (_, i) => task(`task /${i}`, now)),
      ...Array.from({ length: 205 }, (_, i) => commitment(`promise-${i}`, now)),
    ],
      Array.from({ length: 205 }, (_, i) => event(`event /${i}`, now, tomorrow)));
    opts.collectionListInstancesCaller = async () => ({ instances: [...instances, { ...instances[0], slug: 'personal /calendar' }] });
    const work = vi.fn(opts.workEntityListCaller!);
    const calendar = vi.fn(opts.collectionListCaller!);
    const snapshot = await loadToday({ ...opts, workEntityListCaller: work, collectionListCaller: calendar }, now);
    expect(snapshot.items).toHaveLength(820);
    expect(work.mock.calls.filter(([args]) => args.kind === 'task').map(([args]) => args.offset)).toEqual([0, 100, 200]);
    expect(work.mock.calls.filter(([args]) => args.kind === 'commitment').map(([args]) => args.offset)).toEqual([0, 100, 200]);
    for (const slug of ['work', 'personal /calendar']) {
      expect(calendar.mock.calls.filter(([args]) => args.slug === slug && args.filters?.is_all_day === false).map(([args]) => args.offset)).toEqual([0, 100, 200]);
    }
    expect(calendar.mock.calls.filter(([args]) => args.filters?.is_all_day === false)
      .every(([args]) => args.calendar_window?.from === now && args.calendar_window.before === before)).toBe(true);
    expect(snapshot.items.find((item) => item.title === 'task /0')?.href).toBe('#data/task/task%20%2F0');
    expect(snapshot.items.filter((item) => item.title === 'event /0').map((item) => item.href)).toEqual([
      '#data/calendar/record/personal%20%2Fcalendar/event%20%2F0', '#data/calendar/record/work/event%20%2F0',
    ]);
    expect(snapshot.sources.find((item) => item.key === `work:${source.id}`)?.label).toBe('My tasks');
  });

  it('keeps successful rows when another source or later page fails and never reports a clean empty result', async () => {
    const opts = readers([task('visible', now)]);
    opts.collectionListInstancesCaller = async () => ({ instances: [...instances, { ...instances[0], slug: 'broken' }] });
    opts.collectionListCaller = async ({ slug, offset }) => {
      if (slug === 'broken' || offset === 100) throw new Error('Source unavailable');
      return { records: Array.from({ length: 100 }, (_, i) => event(`kept-${i}`, now, tomorrow)), source_freshness: fresh };
    };
    const snapshot = await loadToday(opts, now);
    expect(snapshot.items).toHaveLength(101);
    expect(snapshot.issues).toHaveLength(2);
    const html = renderToday(snapshot, false, 'data-action');
    expect(html).toContain('Results below may be incomplete');
    expect(html).toContain('No items found in the available data');
    expect(html).not.toContain('No overdue tasks or commitments.');
  });

  it('exposes unknown, stale, partial, empty, and read-on-demand source coverage', async () => {
    const opts = readers();
    opts.workEntitySourceListCaller = async () => ({ sources: [
      { ...source, source_kind: 'connection' },
      { ...source, id: 'live-read', source_kind: 'connection', sync_posture: 'read_through' },
    ] });
    opts.workEntityListCaller = async ({ kind }) => ({ entities: [], total: 0,
      ...(kind === 'task' ? { source_freshness: [{ source_id: source.id, state: 'fresh', last_success_at: now - hour,
        stale_after_ms: 100, list_complete: false }] } : {}),
    });
    opts.collectionListCaller = async () => ({ records: [] });
    const snapshot = await loadToday(opts, now);
    expect(snapshot.sources.map((item) => item.freshness.label)).toEqual(expect.arrayContaining(['Sync stale · Partial sync', 'Not included', 'Freshness unknown']));
    expect(renderToday(snapshot, false, 'data-action')).toContain('Results below may be incomplete');
  });

  it('distinguishes all-day ongoing events, escapes source text, and stops nonadvancing pagination', async () => {
    const opts = readers();
    const rows = Array.from({ length: 100 }, (_, i) => ({ ...event(`<script>${i}`, now - hour, tomorrow),
      hot_fields: { summary: `<script>${i}`, start_at: now - hour, end_at: tomorrow, is_all_day: true } }));
    const list = vi.fn(async () => ({ records: rows, source_freshness: fresh }));
    const snapshot = await loadToday({ ...opts, collectionListCaller: list }, now);
    expect(list).toHaveBeenCalledTimes(2);
    expect(snapshot.items).toHaveLength(100);
    expect(snapshot.issues[0]).toContain('did not advance');
    const html = renderToday(snapshot, false, 'data-action');
    expect(html).toContain('All day · In progress');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });

  it('abandons retired reads before requesting additional pages', async () => {
    let current = true;
    const opts = readers();
    const list = vi.fn<NonNullable<BootstrapDataRouteOptions['workEntityListCaller']>>(async () => {
      current = false;
      return { entities: [task('old', now)], total: 200 };
    });
    const result = await loadToday({ ...opts, workEntityListCaller: list }, now, () => current);
    expect(result.items).toEqual([]);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it.each(['gcal', 'caldav', 'graph', 'local'] as const)('preserves the %s adapter interpretation of all-day records', async (adapter_type) => {
    const date = new Date(now);
    const localStart = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
    const dateOnly = adapter_type === 'gcal' || adapter_type === 'caldav';
    const start_at = dateOnly ? Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) : localStart;
    const end_at = dateOnly ? start_at + 86_400_000 : tomorrow;
    const row = event('all-day', start_at, end_at);
    row.hot_fields.is_all_day = true;
    const opts = readers([], [row]);
    opts.collectionListInstancesCaller = async () => ({ instances: [{ ...instances[0], adapter_type }] });
    const snapshot = await loadToday(opts, now);
    expect(snapshot.issues).toEqual([]);
    expect(snapshot.items).toEqual([expect.objectContaining({ when: localStart, allDay: true, ongoing: true, group: 'today' })]);
  });

  it.each(['task', 'commitment'] as const)('reports changing %s totals while retaining readable pages', async (kind) => {
    const rows = Array.from({ length: 101 }, (_, i) => kind === 'task' ? task(`task-${i}`, now) : commitment(`promise-${i}`, now));
    const opts = readers(rows);
    opts.workEntityListCaller = async ({ kind: requested, offset = 0 }) => requested !== kind
      ? { entities: [], total: 0 }
      : { entities: rows.slice(offset, offset + 100), total: offset === 0 ? 102 : 101 };
    const snapshot = await loadToday(opts, now);
    expect(snapshot.items).toHaveLength(101);
    expect(snapshot.issues).toEqual([expect.stringContaining('list changed while loading')]);
  });

  it('reports partially repeated pages even when they also contain new records', async () => {
    const opts = readers();
    opts.workEntityListCaller = async ({ kind, offset = 0 }) => kind !== 'task' ? { entities: [], total: 0 } : {
      entities: offset === 0 ? [task('one', now), task('two', now)] : [task('two', now), task('three', now)], total: 4,
    };
    opts.collectionListCaller = async ({ offset = 0 }) => ({ records: offset === 0
      ? Array.from({ length: 100 }, (_, i) => event(`event-${i}`, now, tomorrow))
      : [event('event-99', now, tomorrow), event('event-100', now, tomorrow)], source_freshness: fresh });
    const snapshot = await loadToday(opts, now);
    expect(snapshot.items).toHaveLength(104);
    expect(snapshot.issues).toEqual([
      expect.stringContaining('list changed while loading'), expect.stringContaining('did not advance consistently'),
    ]);
  });
});

describe('Today local calendar boundaries', () => {
  it('uses local midnight, including both daylight-saving transitions', () => {
    const previous = process.env.TZ;
    process.env.TZ = 'America/Los_Angeles';
    try {
      for (const [date, hours] of [['2026-03-08T00:00:00-08:00', 23], ['2026-11-01T00:00:00-07:00', 25]] as const) {
        const start = Date.parse(date);
        const window = todayWindow(start);
        expect(window.tomorrow - start).toBe(hours * hour);
        expect(window.before - start).toBe((hours + 6 * 24) * hour);
      }
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });
});
