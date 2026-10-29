import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolProgress } from '@recued/contracts';
import { captureToolProgressReporter, reportToolProgress, withToolProgress } from '../execution/tool-progress.js';
import { withMcpToolProgress } from '../mcp-tool-progress.js';

afterEach(() => vi.useRealTimers());
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { resolve, promise };
};

describe('passive tool progress', () => {
  it('coalesces real changes to five seconds and discards pending/late updates after settlement', async () => {
    vi.useFakeTimers();
    const observed: ToolProgress[] = [];
    const done = deferred();
    let report!: NonNullable<ReturnType<typeof captureToolProgressReporter>>;
    const result = withToolProgress(value => observed.push(value), async () => {
      report = captureToolProgressReporter()!;
      report({ kind: 'provider', current: 1, total: 10 });
      await done.promise;
    });
    report({ kind: 'provider', current: 2, total: 10 });
    report({ kind: 'provider', current: 7, total: 10 });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(observed.map(value => value.current)).toEqual([1]);
    await vi.advanceTimersByTimeAsync(1);
    expect(observed.map(value => value.current)).toEqual([1, 7]);
    report({ kind: 'provider', current: 8, total: 10 });
    done.resolve();
    await result;
    report({ kind: 'provider', current: 10, total: 10 });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(observed.map(value => value.current)).toEqual([1, 7]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps captured pooled-transport callbacks with their own request and never invents idle progress', async () => {
    vi.useFakeTimers();
    const done = deferred();
    const first = vi.fn(), second = vi.fn();
    let reportFirst!: NonNullable<ReturnType<typeof captureToolProgressReporter>>;
    const a = withToolProgress(first, async () => {
      reportFirst = captureToolProgressReporter()!;
      await done.promise;
    });
    await withToolProgress(second, async () => {
      reportFirst({ kind: 'provider', current: 3 });
      reportToolProgress({ kind: 'provider', current: 9 });
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(first.mock.calls).toEqual([[{ kind: 'provider', current: 3 }]]);
    expect(second.mock.calls).toEqual([[{ kind: 'provider', current: 9 }]]);
    done.resolve();
    await a;
  });

  it('requires a requested MCP token and keeps progress separate from results and callbacks', async () => {
    const send = vi.fn();
    const run = async () => {
      reportToolProgress({ kind: 'steps', current: 1, total: 4 });
      return { result: 'finished' };
    };
    await withMcpToolProgress({}, send, run);
    expect(send).not.toHaveBeenCalled();
    expect(await withMcpToolProgress({ _meta: { progressToken: 'caller-1' } }, send, run))
      .toEqual({ result: 'finished' });
    expect(send.mock.calls).toEqual([[{ jsonrpc: '2.0', method: 'notifications/progress',
      params: { progressToken: 'caller-1', progress: 1, message: 'Recipe steps: 1 of 4' } }]]);
  });

  it('does not let a broken display fail an execution or leak a rejected call timer', async () => {
    vi.useFakeTimers();
    const failure = new Error('tool failed');
    await expect(withToolProgress(() => { throw new Error('display failed'); }, async () => {
      reportToolProgress({ kind: 'steps', current: 1, total: 3 });
      reportToolProgress({ kind: 'steps', current: 2, total: 3 });
      throw failure;
    })).rejects.toBe(failure);
    expect(vi.getTimerCount()).toBe(0);
  });
});
