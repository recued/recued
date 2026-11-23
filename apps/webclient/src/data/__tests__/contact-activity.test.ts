import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeTimelineCursor, type Actor, type TimelineEntry, type TimelineRequest, type TimelineResponse } from '@recued/contracts';
import { contactActivityMemory, createContactActivity } from '../contact-activity.js';

const NOW = Date.parse('2026-11-15T12:00:00Z');
const entry = (n: number, actor: Actor = 'system', ts = NOW - n): TimelineEntry => ({ ts, source: 'annotation', kind: `Activity ${n}`,
  origin_actor: actor, payload: { id: `event-${n}`, body: 'Sensitive event text' } });
const cursor = (ts: number, key = 'annotation:Activity:event') => encodeTimelineCursor({ last_ts: ts, last_key: key });
const seed = (): TimelineResponse => ({ entries: Array.from({ length: 50 }, (_, n) => entry(n + 1)), next_cursor: cursor(NOW - 50) });
const deferred = <T>() => { let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
const rig = (memory = contactActivityMemory({})) => {
  const call = vi.fn<(args: TimelineRequest) => Promise<TimelineResponse>>(async () => ({ entries: [] })), changed = vi.fn();
  let now = NOW;
  const controller = createContactActivity({ call, changed, now: () => now, memory,
    renderEntries: entries => `<ol>${entries.map(row => `<li>${row.kind}</li>`).join('')}</ol>` });
  return { controller, call, changed, memory, now: (value: number) => { now = value; } };
};
afterEach(() => vi.unstubAllEnvs());

describe('contact activity paging and filters', () => {
  it('uses the existing first page and resumes only from its confirmed cursor, including tied event times', async () => {
    const r = rig(); const first = seed(); await r.controller.open('alex@example.test', first);
    expect(r.call).not.toHaveBeenCalled();
    r.call.mockResolvedValue({ entries: [entry(51, 'system', NOW - 50), entry(52)] });
    r.controller.handleAction('contact-activity-older'); await r.controller.whenLoaded();
    expect(r.call).toHaveBeenCalledWith({ entity_id: 'contact:alex@example.test', limit: 50, cursor: first.next_cursor });
    expect(r.controller.snapshot()).toMatchObject({ pages: 2, cursor: undefined, entries: expect.any(Array) });
    expect(r.controller.snapshot()!.entries).toHaveLength(52);
  });

  it('blocks duplicate page loads and retries the same cursor while retaining confirmed activity', async () => {
    const r = rig(); await r.controller.open('a', seed()); const gate = deferred<TimelineResponse>();
    r.call.mockReturnValueOnce(gate.promise).mockResolvedValueOnce({ entries: [entry(51)] });
    r.controller.handleAction('contact-activity-older'); r.controller.handleAction('contact-activity-older');
    expect(r.call).toHaveBeenCalledOnce(); gate.reject(new Error('Offline')); await r.controller.whenLoaded();
    expect(r.controller.snapshot()!.entries).toHaveLength(50); expect(r.controller.render()).toContain('Previously loaded activity remains');
    r.controller.handleAction('contact-activity-retry'); await r.controller.whenLoaded();
    expect(r.call.mock.calls[0]).toEqual(r.call.mock.calls[1]); expect(r.controller.snapshot()!.entries).toHaveLength(51);
  });

  it('applies local whole-day bounds across a daylight-saving transition and freezes them for retry', async () => {
    vi.stubEnv('TZ', 'America/New_York'); const r = rig(); await r.controller.open('a', seed());
    r.controller.setField('range', 'custom'); r.controller.setField('from', '2026-11-01'); r.controller.setField('through', '2026-11-01');
    r.call.mockRejectedValueOnce(new Error('Interrupted')).mockResolvedValueOnce({ entries: [] });
    await r.controller.apply(); r.now(NOW + 86_400_000); r.controller.handleAction('contact-activity-retry'); await r.controller.whenLoaded();
    expect(r.call.mock.calls.map(([args]) => args)).toEqual([0, 1].map(() => ({ entity_id: 'contact:a', limit: 50,
      since: Date.parse('2026-11-01T04:00:00Z'), until: Date.parse('2026-11-02T05:00:00Z') })));
  });

  it('last 7 and 30 days include today, and invalid dates do not replace the applied feed', async () => {
    vi.stubEnv('TZ', 'UTC'); const r = rig(); await r.controller.open('a', seed());
    r.controller.setField('range', 'custom'); r.controller.setField('from', '2026-02-30'); await r.controller.apply();
    expect(r.call).not.toHaveBeenCalled(); expect(r.controller.snapshot()!.entries).toHaveLength(50);
    r.controller.setField('from', '2026-11-16'); r.controller.setField('through', '2026-11-15'); await r.controller.apply();
    expect(r.call).not.toHaveBeenCalled(); expect(r.controller.render()).toContain('From must be on or before Through');
    r.controller.setField('range', 'week'); await r.controller.apply();
    expect(r.call.mock.calls[0]![0]).toMatchObject({ since: Date.parse('2026-11-09T00:00:00Z'), until: Date.parse('2026-11-16T00:00:00Z') });
    r.controller.setField('range', 'month'); await r.controller.apply();
    expect(r.call.mock.calls[1]![0]).toMatchObject({ since: Date.parse('2026-10-17T00:00:00Z'), until: Date.parse('2026-11-16T00:00:00Z') });
  });

  it('sends each actor lane to the server and rejects a reply outside the selected lane or dates', async () => {
    const r = rig(); await r.controller.open('a', seed());
    for (const actor of ['user_self', 'system', 'contracted_user', 'anonymous'] as const) {
      r.call.mockResolvedValueOnce({ entries: [entry(1, actor)] }); r.controller.setField('actor', actor); await r.controller.apply();
      expect(r.call.mock.lastCall?.[0].origin_actors).toEqual([actor]); expect(r.controller.snapshot()!.entries[0]!.origin_actor).toBe(actor);
    }
    r.call.mockResolvedValue({ entries: [entry(1, 'system')] }); r.controller.setField('actor', 'user_self'); await r.controller.apply();
    expect(r.controller.snapshot()!.entries).toEqual([]); expect(r.controller.snapshot()!.error).toContain('did not confirm');
    r.controller.setField('actor', 'all'); r.controller.setField('range', 'custom');
    r.controller.setField('from', '2026-11-15'); r.controller.setField('through', '2026-11-15');
    r.call.mockResolvedValue({ entries: [entry(1, 'system', 0)] }); await r.controller.apply();
    expect(r.controller.snapshot()!.entries).toEqual([]); expect(r.controller.snapshot()!.error).toContain('did not confirm');
  });

  it('continues past an empty actor-filtered page instead of declaring the older history empty', async () => {
    const r = rig(); await r.controller.open('a', seed()); r.controller.setField('actor', 'anonymous');
    r.call.mockResolvedValueOnce({ entries: [], next_cursor: cursor(NOW - 10) }).mockResolvedValueOnce({ entries: [entry(20, 'anonymous')] });
    await r.controller.apply(); expect(r.controller.render()).toContain('Load older activity');
    expect(r.controller.render()).not.toContain('No activity matches these filters.');
    r.controller.handleAction('contact-activity-older'); await r.controller.whenLoaded();
    expect(r.controller.snapshot()!.entries).toEqual([entry(20, 'anonymous')]);
  });

  it('refuses repeating or malformed cursors and preserves the last confirmed page', async () => {
    const r = rig(); const first = seed(); await r.controller.open('a', first);
    r.call.mockResolvedValue({ entries: first.entries, next_cursor: first.next_cursor });
    r.controller.handleAction('contact-activity-older'); await r.controller.whenLoaded();
    expect(r.controller.snapshot()).toMatchObject({ pages: 1, error: expect.any(String) });
    expect(r.controller.snapshot()!.entries).toHaveLength(50);
    r.call.mockResolvedValue({ entries: [entry(51)], next_cursor: 'unsupported-cursor' });
    r.controller.handleAction('contact-activity-retry'); await r.controller.whenLoaded();
    expect(r.controller.snapshot()!.pages).toBe(1); expect(r.controller.snapshot()!.error).toContain('did not advance');
  });

  it('retires an in-flight page after applying a different actor, and after selecting another contact', async () => {
    const r = rig(), gate = deferred<TimelineResponse>(); await r.controller.open('a', seed()); r.call.mockReturnValueOnce(gate.promise);
    r.controller.handleAction('contact-activity-older'); const previousPage = r.controller.whenLoaded(); r.controller.setField('actor', 'anonymous');
    r.call.mockResolvedValueOnce({ entries: [entry(2, 'anonymous')] }); await r.controller.apply();
    gate.resolve({ entries: [entry(51)] }); await previousPage; expect(r.controller.snapshot()!.entries).toEqual([entry(2, 'anonymous')]);
    const late = deferred<TimelineResponse>(); r.call.mockReturnValueOnce(late.promise);
    const old = r.controller.open('a', null); await r.controller.open('b', { entries: [entry(3)] });
    late.resolve({ entries: [entry(4)] }); await old;
    expect(r.controller.email()).toBe('b'); expect(r.controller.snapshot()!.entries).toEqual([entry(3)]);
  });

  it('restores page depth with fresh reads and keeps only preferences and position in memory', async () => {
    const memory = contactActivityMemory({}), r = rig(memory); await r.controller.open('a', seed());
    r.call.mockResolvedValue({ entries: [entry(51)] }); r.controller.handleAction('contact-activity-older'); await r.controller.whenLoaded(); r.controller.dispose();
    expect(JSON.stringify(memory.get('a'))).not.toContain('Sensitive event text');
    expect(JSON.stringify(memory.get('a'))).not.toContain('next_cursor');
    const resumed = rig(memory), newer = { entries: [entry(10)], next_cursor: cursor(NOW - 10) };
    resumed.call.mockResolvedValue({ entries: [entry(11)] }); await resumed.controller.open('a', newer);
    expect(resumed.call.mock.calls[0]![0].cursor).toBe(newer.next_cursor);
    expect(resumed.controller.snapshot()!.entries).toEqual([entry(10), entry(11)]);
    expect(contactActivityMemory({}).get('a')).toBeUndefined();
  });

  it('retains confirmed restoration progress and retries if a later restored page fails', async () => {
    const memory = contactActivityMemory({}); memory.set('a', { filters: { range: 'all', actor: 'all', from: '', through: '' },
      draft: { range: 'all', actor: 'all', from: '', through: '' }, pages: 2 });
    const r = rig(memory); r.call.mockRejectedValueOnce(new Error('Older page unavailable'));
    await r.controller.open('a', seed()); expect(r.controller.snapshot()!.entries).toHaveLength(50);
    expect(r.controller.snapshot()!.error).toContain('Older page unavailable');
  });

  it('ignores a reply after disposal and exposes a read-only retry after an initial failure', async () => {
    const r = rig(); await r.controller.open('a', null, 'Timeline unavailable');
    expect(r.controller.render()).toContain('Retry activity'); expect(r.controller.render()).not.toContain('No timeline events yet.');
    const gate = deferred<TimelineResponse>(); r.call.mockReturnValueOnce(gate.promise);
    r.controller.handleAction('contact-activity-retry'); const pending = r.controller.whenLoaded(), paints = r.changed.mock.calls.length;
    r.controller.dispose(); gate.resolve({ entries: [entry(1)] }); await pending;
    expect(r.changed).toHaveBeenCalledTimes(paints); expect(r.controller.snapshot()).toBeNull();
  });
});
