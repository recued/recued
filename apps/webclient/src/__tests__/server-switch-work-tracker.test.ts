import { describe, expect, it } from 'vitest';

import { createServerSwitchWorkTracker } from '../shell/server-switch-work-tracker.js';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
};

describe('createServerSwitchWorkTracker', () => {
  it('stays active until every concurrent source action settles', async () => {
    const tracker = createServerSwitchWorkTracker();
    const first = deferred<string>();
    const second = deferred<string>();
    const run = tracker.track((gate: Promise<string>) => gate);

    const firstRun = run(first.promise);
    const secondRun = run(second.promise);
    expect(tracker.hasInFlightWork()).toBe(true);

    first.resolve('first');
    await expect(firstRun).resolves.toBe('first');
    expect(tracker.hasInFlightWork()).toBe(true);

    second.resolve('second');
    await expect(secondRun).resolves.toBe('second');
    expect(tracker.hasInFlightWork()).toBe(false);
  });

  it('releases the fence after rejection without changing the caller result', async () => {
    const tracker = createServerSwitchWorkTracker();
    const gate = deferred<never>();
    const run = tracker.track(() => gate.promise);
    const result = run();

    expect(tracker.hasInFlightWork()).toBe(true);
    gate.reject(new Error('source refused'));
    await expect(result).rejects.toThrow('source refused');
    expect(tracker.hasInFlightWork()).toBe(false);
  });

  it('supports callback-driven work with an idempotent release', () => {
    const tracker = createServerSwitchWorkTracker();
    const release = tracker.begin();

    expect(tracker.hasInFlightWork()).toBe(true);
    release();
    release();
    expect(tracker.hasInFlightWork()).toBe(false);
  });

  it('keeps immutable, oldest-first return details until each lease settles', () => {
    const tracker = createServerSwitchWorkTracker();
    const first = tracker.begin({
      label: 'Creating a full backup',
      returnHref: '#settings/backup',
      returnLabel: 'View backup progress',
    });
    const second = tracker.begin({
      label: 'Sending a Chat message',
      returnHref: '#chat/session/chat-2',
    });

    expect(tracker.activeWork()).toEqual([
      {
        id: first.id,
        label: 'Creating a full backup',
        returnHref: '#settings/backup',
        returnLabel: 'View backup progress',
      },
      {
        id: second.id,
        label: 'Sending a Chat message',
        returnHref: '#chat/session/chat-2',
      },
    ]);

    const snapshot = tracker.activeWork();
    first.update({ jobId: 'archive-7', label: '  Creating a full backup  ' });
    expect(snapshot[0]).not.toHaveProperty('jobId');
    expect(tracker.activeWork()[0]).toMatchObject({
      id: first.id,
      label: 'Creating a full backup',
      jobId: 'archive-7',
    });

    first();
    expect(tracker.activeWork().map((work) => work.id)).toEqual([second.id]);
  });

  it('captures default route details when work begins, not when it settles', async () => {
    let href = '#settings/backup';
    const tracker = createServerSwitchWorkTracker(() => ({
      label: 'Saving Settings',
      returnHref: href,
    }));
    const gate = deferred<void>();
    const run = tracker.track(() => gate.promise);

    const result = run();
    href = '#chat';
    expect(tracker.activeWork()[0]).toMatchObject({
      label: 'Saving Settings',
      returnHref: '#settings/backup',
    });

    gate.resolve();
    await result;
    expect(tracker.activeWork()).toEqual([]);
  });

  it('notifies route-independent chrome on begin, metadata updates, and settle', () => {
    const tracker = createServerSwitchWorkTracker();
    const snapshots: string[][] = [];
    const detach = tracker.subscribe((work) => {
      snapshots.push(work.map((item) => `${item.label}:${item.phase ?? 'working'}`));
    });

    const release = tracker.begin({ label: 'Creating a backup' });
    release.update({ label: 'Backup ready', phase: 'result_ready' });
    release();
    detach();
    tracker.begin({ label: 'Detached work' });

    expect(snapshots).toEqual([
      [],
      ['Creating a backup:working'],
      ['Backup ready:result_ready'],
      [],
    ]);
  });

  it('never recycles an explicit action id after its first lease settles', () => {
    const tracker = createServerSwitchWorkTracker();
    const first = tracker.begin({ id: 'archive-export', label: 'First backup' });
    first();
    const replacement = tracker.begin({
      id: 'archive-export',
      label: 'Replacement backup',
    });

    expect(replacement.id).not.toBe(first.id);
    expect(tracker.activeWork()).toEqual([{
      id: replacement.id,
      label: 'Replacement backup',
    }]);
  });
});
