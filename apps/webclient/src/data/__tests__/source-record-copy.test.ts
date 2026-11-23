import { expect, it, vi } from 'vitest';
import { createSourceRecordCopy, sourceRecordLink, type SourceRecordCopyOwner } from '../source-record-copy.js';
import { recentSourceRecord, type RecentSourceOrigin } from '../recent-work-records.js';
import { parseShellRoute, parseSourceRecordAddress } from '../../shell/route.js';

const origin: RecentSourceOrigin = { kind: 'mail', slug: 'work/二', recordId: "message/shared?二.)!'*", receivedAt: 1, identity: 'message-v1', label: 'Saved email' };
const record = (value: RecentSourceOrigin = origin) => recentSourceRecord(value, 'Work')!;
const deferred = () => { let resolve!: (value: boolean) => void; const promise = new Promise<boolean>(done => { resolve = done; }); return { resolve, promise }; };
const setup = () => {
  const state: { owner: SourceRecordCopyOwner | null; blocked: boolean; focused: boolean } = {
    owner: { record: record(), scope: 'reader:1', href: 'https://app.test/tools/index.html?code=pair-secret#data/search' }, blocked: false, focused: true,
  };
  const write = vi.fn(async (_value: string): Promise<boolean> => true), render = vi.fn(), focusAction = vi.fn(() => { state.focused = true; }), selectFallback = vi.fn();
  const copy = createSourceRecordCopy({ current: () => state.owner, blocked: () => state.blocked, write, render, focusAction,
    actionFocused: () => state.focused, selectFallback });
  return { state, write, render, focusAction, selectFallback, copy };
};

it('links canonical contacts and exact mailbox/event records, preserving deployment paths and opaque ids without credentials or pairing parameters', () => {
  const origins: RecentSourceOrigin[] = [origin,
    { kind: 'calendar', slug: 'home/二', recordId: "cal:work:shared/2026-11-01T09:30:12.345Z?二!'", sourceId: 'event-one', receivedAt: 1, incarnation: 'event-v1', label: 'Event' },
    { kind: 'contact', id: "person/?二.'!", createdAt: 1, label: 'Riley' }];
  for (const ref of origins) {
    const link = sourceRecordLink('https://owner:password@app.test/tools/index.html?code=pair-secret&return=private#data/search', ref)!;
    const url = new URL(link); expect(url.origin + url.pathname).toBe('https://app.test/tools/index.html');
    expect(url.username + url.password + url.search).toBe(''); expect(link).not.toMatch(/password|pair-secret|private/u);
    const route = parseShellRoute(url.hash);
    if (ref.kind === 'contact') expect(route.segments).toEqual(['contact', ref.id]);
    else expect(parseSourceRecordAddress(route)).toMatchObject({ tab: ref.kind, collectionSlug: ref.slug, recordId: ref.recordId });
  }
  expect(sourceRecordLink('file:///app/index.html', origin)).toBeNull(); expect(sourceRecordLink('not a URL', origin)).toBeNull();
  expect(sourceRecordLink('https://app.test/', { ...origin, recordId: '' })).toBeNull();
  expect(sourceRecordLink('https://app.test/', { kind: 'note', id: 'one', label: 'Note' } as unknown as RecentSourceOrigin)).toBeNull();
});

it('copies only the captured record link and preserves it exactly for manual copying after a blocked clipboard', async () => {
  const f = setup(); f.write.mockRejectedValueOnce(Error('Clipboard denied'));
  expect(await f.copy.copy()).toBe(false);
  const value = sourceRecordLink(f.state.owner!.href, origin)!;
  expect(f.write).toHaveBeenCalledWith(value); expect(f.copy.state()?.fallback).toBe(value);
  expect(f.copy.state()?.notice?.error).toBe(true); expect(f.selectFallback).toHaveBeenCalledOnce();
  expect(await f.copy.copy()).toBe(true); expect(f.copy.state()?.notice).toEqual({ error: false, text: 'Link copied.' }); expect(f.copy.state()?.fallback).toBeUndefined();
});

it('blocks overlapping copies, unavailable readers and mutations before touching the clipboard', async () => {
  const f = setup(); f.state.blocked = true; expect(await f.copy.copy()).toBe(false); expect(f.write).not.toHaveBeenCalled();
  f.state.blocked = false; f.state.owner!.href = 'file:///app'; expect(await f.copy.copy()).toBe(false); expect(f.write).not.toHaveBeenCalled();
  f.state.owner!.href = 'https://app.test/'; const held = deferred(); f.write.mockReturnValueOnce(held.promise);
  const pending = f.copy.copy(); expect(f.copy.busy()).toBe(true); expect(await f.copy.copy()).toBe(false); expect(f.write).toHaveBeenCalledOnce();
  held.resolve(true); await pending; f.state.owner = null; expect(await f.copy.copy()).toBe(false); expect(f.copy.state()).toBeUndefined();
});

it('ignores late clipboard results after a reader, source, record incarnation or pairing changes, and after disposal', async () => {
  for (const change of ['scope', 'account', 'incarnation', 'closed', 'dispose'] as const) {
    const f = setup(), held = deferred(); f.write.mockReturnValueOnce(held.promise); const pending = f.copy.copy();
    if (change === 'scope') f.state.owner!.scope = 'reader:2';
    if (change === 'account') f.state.owner!.record = record({ ...origin, slug: 'home' });
    if (change === 'incarnation') f.state.owner!.record = record({ ...origin, receivedAt: 2, identity: 'replacement' });
    if (change === 'closed') f.state.owner = null;
    if (change === 'dispose') f.copy.reset();
    held.resolve(false); await pending; expect(f.copy.state()?.notice).toBeUndefined(); expect(f.copy.state()?.fallback).toBeUndefined();
    expect(f.render).toHaveBeenCalledOnce(); expect(f.selectFallback).not.toHaveBeenCalled();
  }
});

it('lets a new reader finish copying while an older rejected operation remains pending', async () => {
  const f = setup(), held = deferred(); f.write.mockReturnValueOnce(held.promise); const old = f.copy.copy();
  f.state.owner = { ...f.state.owner!, scope: 'reader:2', record: record({ ...origin, recordId: 'second' }) };
  await f.copy.copy(); const paints = f.render.mock.calls.length; held.resolve(false); await old;
  expect(f.copy.state()?.notice).toEqual({ error: false, text: 'Link copied.' }); expect(f.copy.state()?.fallback).toBeUndefined(); expect(f.render).toHaveBeenCalledTimes(paints);
});

it('offers the failed link without taking focus from a newer Find or reader action', async () => {
  const f = setup(), held = deferred(); f.write.mockReturnValueOnce(held.promise); const pending = f.copy.copy();
  f.state.focused = false; held.resolve(false); await pending;
  expect(f.copy.state()?.fallback).toBeTruthy(); expect(f.selectFallback).not.toHaveBeenCalled(); expect(f.focusAction).toHaveBeenCalledOnce();
});
