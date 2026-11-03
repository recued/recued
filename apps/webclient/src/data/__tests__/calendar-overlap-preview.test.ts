import { afterEach, expect, it, vi } from 'vitest';
import { type CalendarOverlapRequest, type CalendarOverlapResult } from '@recued/contracts';
import { createCalendarOverlapPreview } from '../calendar-overlap-preview.js';

const request: CalendarOverlapRequest = { start_at: Date.parse('2026-11-01T09:00:00Z'),
  end_at: Date.parse('2026-11-01T10:00:00Z'), is_all_day: false, timezone: 'America/Los_Angeles' };
const reply = (input = request, title = 'Customer meeting'): CalendarOverlapResult => ({
  ...input, checked_at: input.start_at, truncated: false,
  events: [{ summary: title, start_at: input.start_at, end_at: input.end_at, is_all_day: false, calendars: ['Work'] }],
  sources: [{ slug: 'work', name: 'Work', status: 'synced', last_synced_at: input.start_at }],
});
const setup = (call: (value: CalendarOverlapRequest) => Promise<CalendarOverlapResult>) =>
  createCalendarOverlapPreview({ call, id: 'edit', actionAttr: 'data-action', retryAction: 'retry' });
afterEach(() => { vi.useRealTimers(); });

it('debounces timing edits and refuses late replies for an older interval or a closed form', async () => {
  vi.useFakeTimers();
  let resolve!: (value: CalendarOverlapResult) => void;
  const call = vi.fn((input: CalendarOverlapRequest) => call.mock.calls.length === 1
    ? new Promise<CalendarOverlapResult>(done => { resolve = done; }) : Promise.resolve(reply(input, 'New time')));
  const preview = setup(call);
  preview.update(request); await vi.advanceTimersByTimeAsync(200);
  const next = { ...request, end_at: request.end_at + 1000 };
  preview.update(next);
  expect(preview.render()).not.toContain('Customer meeting');
  await vi.advanceTimersByTimeAsync(200);
  expect(preview.render()).toContain('New time');
  resolve(reply()); await Promise.resolve();
  expect(preview.render()).not.toContain('Customer meeting');
  preview.update({ ...next }); await vi.advanceTimersByTimeAsync(500);
  expect(call).toHaveBeenCalledTimes(2);
  preview.reset(); expect(preview.render()).not.toContain('New time'); preview.dispose();
});

it('retires an old answer immediately for incomplete times and does not send invalid ranges', async () => {
  vi.useFakeTimers();
  const call = vi.fn(async (input: CalendarOverlapRequest) => reply(input));
  const preview = setup(call); preview.update(request); await vi.advanceTimersByTimeAsync(200);
  expect(preview.render()).toContain('Customer meeting');
  preview.update(null); expect(preview.render()).toContain('Choose valid times');
  expect(preview.render()).not.toContain('Customer meeting');
  preview.update({ ...request, end_at: request.start_at }); await vi.advanceTimersByTimeAsync(500);
  expect(call).toHaveBeenCalledTimes(1); preview.dispose();
});

it('shows failures as unknown, supports read-only retry, and degrades for older servers', async () => {
  vi.useFakeTimers();
  const call = vi.fn< (value: CalendarOverlapRequest) => Promise<CalendarOverlapResult> >()
    .mockRejectedValueOnce({ code: 'unavailable' }).mockResolvedValueOnce(reply())
    .mockRejectedValueOnce({ code: 'unknown_method' });
  const preview = setup(call); preview.update(request); await vi.advanceTimersByTimeAsync(200);
  expect(preview.render()).toContain('could not be checked'); expect(preview.render()).not.toContain('No overlapping');
  preview.retry(); await Promise.resolve(); expect(preview.render()).toContain('Customer meeting');
  preview.retry(); await Promise.resolve(); expect(preview.render()).toContain('Update your Recued server');
  expect(preview.render()).not.toContain('Customer meeting'); preview.dispose();
  expect(createCalendarOverlapPreview({ id: 'edit', actionAttr: 'data-action', retryAction: 'retry' }).render()).toBe('');
});

it('labels partial empty results and escapes source labels and event titles', async () => {
  vi.useFakeTimers();
  const value = reply(); value.events = []; value.truncated = true;
  value.sources[0] = { slug: 'work', name: '<Work>', status: 'unavailable', last_synced_at: null };
  const preview = setup(async () => value); preview.update(request); await vi.advanceTimersByTimeAsync(200);
  expect(preview.render()).toContain('in the data checked'); expect(preview.render()).toContain('preview is incomplete');
  expect(preview.render()).toContain('&lt;Work&gt;'); expect(preview.render()).toContain('could not be read');
  expect(preview.render()).toContain('does not reserve'); preview.dispose();
});

it('rejects incomplete or unformattable replies without leaving an old result or claiming an empty range', async () => {
  vi.useFakeTimers();
  const corruptions = [
    (value: CalendarOverlapResult) => Reflect.deleteProperty(value, 'truncated'),
    (value: CalendarOverlapResult) => Reflect.deleteProperty(value.events[0]!, 'is_all_day'),
    (value: CalendarOverlapResult) => Reflect.set(value.events[0]!, 'start_at', -9e15),
    (value: CalendarOverlapResult) => Reflect.set(value.sources[0]!, 'last_synced_at', 9e15),
    (value: CalendarOverlapResult) => Reflect.set(value.events, 0, null),
  ];
  for (const corrupt of corruptions) {
    const value = reply(); const preview = setup(async () => value);
    preview.update(request); await vi.advanceTimersByTimeAsync(200);
    expect(preview.render()).toContain('Customer meeting');
    corrupt(value); preview.retry(); await Promise.resolve();
    expect(() => preview.render()).not.toThrow();
    expect(preview.render()).toContain('could not be checked');
    expect(preview.render()).not.toContain('Customer meeting');
    expect(preview.render()).not.toContain('No overlapping');
    preview.dispose();
  }
});

it('retires pending replies when a form closes or is disposed, including reopening the same interval', async () => {
  vi.useFakeTimers();
  const resolve: Array<(value: CalendarOverlapResult) => void> = [];
  const preview = setup(() => new Promise(done => { resolve.push(done); }));
  preview.update(request); await vi.advanceTimersByTimeAsync(200);
  preview.reset(); preview.update(request); await vi.advanceTimersByTimeAsync(200);
  resolve[0]!(reply(request, 'Closed form')); await Promise.resolve();
  expect(preview.render()).not.toContain('Closed form'); expect(preview.render()).toContain('Checking saved');
  preview.dispose(); resolve[1]!(reply(request, 'Disposed form')); await Promise.resolve();
  expect(preview.render()).not.toContain('Disposed form');
});

it('distinguishes both readings of a repeated hour in event times', async () => {
  vi.useFakeTimers();
  const input = { ...request, start_at: Date.parse('2026-11-01T08:00:00Z') };
  const value = reply(input);
  value.events[0] = { ...value.events[0]!, start_at: Date.parse('2026-11-01T08:45:00Z'), end_at: Date.parse('2026-11-01T09:15:00Z') };
  const preview = setup(async () => value); preview.update(input); await vi.advanceTimersByTimeAsync(200);
  expect(preview.render()).toContain('PDT'); expect(preview.render()).toContain('PST'); preview.dispose();
});
