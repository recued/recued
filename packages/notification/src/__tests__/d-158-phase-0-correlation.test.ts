import { describe, expect, it } from 'vitest';
import {
  createAskSerializer,
  mintAskId,
  selectAskOption,
} from '../correlation.js';
import type { PendingAsk } from '../types.js';

const pendingAsk: PendingAsk = {
  ask_id: 'ask-select',
  message: { text: 'Choose one' },
  options: [
    { id: 'yes', label: 'Yes' },
    { id: 'no', label: 'No' },
  ],
  handler_kind: 'gateway.preflight',
  handler_payload: {},
  fanout_channels: ['ui'],
  status: 'open',
  created_at: 1000,
};

const deferred = <T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe('D-158 P0 correlation', () => {
  it('mintAskId returns unique ids with the ask- prefix', () => {
    const ids = Array.from({ length: 64 }, () => mintAskId());

    expect(ids.every((id) => id.startsWith('ask-'))).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('selectAskOption returns the offered option and rejects unknown ids', () => {
    expect(selectAskOption(pendingAsk, 'yes')).toEqual({
      id: 'yes',
      label: 'Yes',
    });
    expect(selectAskOption(pendingAsk, 'maybe')).toBeUndefined();
  });
});

describe('D-158 P0 AskSerializer', () => {
  it('runs same-key work strictly in series', async () => {
    const serializer = createAskSerializer();
    const events: string[] = [];
    const firstStarted = deferred();
    const releaseFirst = deferred();

    const first = serializer.run('ask-same', async () => {
      events.push('first:start');
      firstStarted.resolve();
      await releaseFirst.promise;
      events.push('first:end');
      return 'first';
    });
    await firstStarted.promise;

    const second = serializer.run('ask-same', async () => {
      events.push('second:start');
      events.push('second:end');
      return 'second';
    });
    await Promise.resolve();

    expect(events).toEqual(['first:start']);

    releaseFirst.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual([
      'first',
      'second',
    ]);
    expect(events).toEqual([
      'first:start',
      'first:end',
      'second:start',
      'second:end',
    ]);
  });

  it('lets different keys run concurrently', async () => {
    const serializer = createAskSerializer();
    const events: string[] = [];
    const firstStarted = deferred();
    const releaseFirst = deferred();

    const first = serializer.run('ask-a', async () => {
      events.push('a:start');
      firstStarted.resolve();
      await releaseFirst.promise;
      events.push('a:end');
      return 'a';
    });
    await firstStarted.promise;

    const second = serializer.run('ask-b', async () => {
      events.push('b:start');
      events.push('b:end');
      return 'b';
    });

    await expect(second).resolves.toBe('b');
    expect(events).toEqual(['a:start', 'b:start', 'b:end']);

    releaseFirst.resolve();
    await expect(first).resolves.toBe('a');
    expect(events).toEqual(['a:start', 'b:start', 'b:end', 'a:end']);
  });

  it('does not strand the next same-key run after a rejection', async () => {
    const serializer = createAskSerializer();
    const events: string[] = [];

    const first = serializer.run('ask-reject', async () => {
      events.push('first');
      throw new Error('handler failed');
    });
    const second = serializer.run('ask-reject', async () => {
      events.push('second');
      return 'second-ok';
    });

    await expect(first).rejects.toThrow('handler failed');
    await expect(second).resolves.toBe('second-ok');
    expect(events).toEqual(['first', 'second']);
  });
});
