/** D-164 P5 -- concurrent tool-call dispatch primitive.
 *
 *  Spec: D-164 section 6.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  dispatchToolCalls as barrelDispatchToolCalls,
  type DispatchableToolCall,
  type ToolCallDispatchInput,
  type ToolCallDispatchOutput,
  type ToolCallResult,
  type ToolDispatchStrategy,
} from '..';
import { dispatchToolCalls as directDispatchToolCalls } from '../dispatch.js';

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
}

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe('D-164 P5 dispatchToolCalls empty short-circuit', () => {
  // A1
  it("returns the empty strategy and does not invoke executeOne when calls is empty", async () => {
    const executeOne = vi.fn(async (_payload: never): Promise<string> => {
      return 'unexpected';
    });

    const output = await barrelDispatchToolCalls<never, string>({
      calls: [],
      executeOne,
    });

    expect(output).toEqual({ strategy: 'empty', results: [] });
    expect(executeOne).not.toHaveBeenCalled();
  });

  // A2
  it('returns an awaitable resolved promise for the empty result', async () => {
    const outputPromise = barrelDispatchToolCalls<never, string>({
      calls: [],
      executeOne: async (_payload: never) => 'unexpected',
    });

    expect(typeof outputPromise.then).toBe('function');
    await expect(outputPromise).resolves.toEqual({
      strategy: 'empty',
      results: [],
    });
  });
});

describe('D-164 P5 dispatchToolCalls strategy decision', () => {
  // B3
  it('selects parallel when every call is concurrency_safe true', async () => {
    const output = await barrelDispatchToolCalls({
      calls: [
        { concurrency_safe: true, payload: 1 },
        { concurrency_safe: true, payload: 2 },
      ],
      executeOne: async (payload) => payload,
    });

    expect(output.strategy).toBe('parallel');
  });

  // B4
  it('selects sequential when every call is concurrency_safe false', async () => {
    const output = await barrelDispatchToolCalls({
      calls: [
        { concurrency_safe: false, payload: 1 },
        { concurrency_safe: false, payload: 2 },
      ],
      executeOne: async (payload) => payload,
    });

    expect(output.strategy).toBe('sequential');
  });

  // B5
  it('selects sequential when the first call is safe and the rest are unsafe', async () => {
    const output = await barrelDispatchToolCalls({
      calls: [
        { concurrency_safe: true, payload: 1 },
        { concurrency_safe: false, payload: 2 },
        { concurrency_safe: false, payload: 3 },
      ],
      executeOne: async (payload) => payload,
    });

    expect(output.strategy).toBe('sequential');
  });

  // B6
  it('selects sequential when the first call is unsafe and the rest are safe', async () => {
    const output = await barrelDispatchToolCalls({
      calls: [
        { concurrency_safe: false, payload: 1 },
        { concurrency_safe: true, payload: 2 },
        { concurrency_safe: true, payload: 3 },
      ],
      executeOne: async (payload) => payload,
    });

    expect(output.strategy).toBe('sequential');
  });

  // B7
  it('selects parallel for one concurrency_safe true call', async () => {
    const output = await barrelDispatchToolCalls({
      calls: [{ concurrency_safe: true, payload: 1 }],
      executeOne: async (payload) => payload,
    });

    expect(output.strategy).toBe('parallel');
  });

  // B8
  it('selects sequential for one concurrency_safe false call', async () => {
    const output = await barrelDispatchToolCalls({
      calls: [{ concurrency_safe: false, payload: 1 }],
      executeOne: async (payload) => payload,
    });

    expect(output.strategy).toBe('sequential');
  });

  // B9
  it('treats concurrency_safe: 1 as sequential because true is strict', async () => {
    const output = await barrelDispatchToolCalls({
      calls: [
        {
          concurrency_safe: 1 as unknown as boolean,
          payload: 1,
        },
      ],
      executeOne: async (payload) => payload,
    });

    expect(output.strategy).toBe('sequential');
  });

  // B10
  it("treats concurrency_safe: 'true' as sequential because true is strict", async () => {
    const output = await barrelDispatchToolCalls({
      calls: [
        {
          concurrency_safe: 'true' as unknown as boolean,
          payload: 1,
        },
      ],
      executeOne: async (payload) => payload,
    });

    expect(output.strategy).toBe('sequential');
  });
});

describe('D-164 P5 dispatchToolCalls parallel mode', () => {
  // C11
  it('invokes parallel calls concurrently before any result resolves', async () => {
    const waits = [deferred<string>(), deferred<string>(), deferred<string>()];
    const started: number[] = [];
    let returned = false;

    const outputPromise = barrelDispatchToolCalls({
      calls: [
        { concurrency_safe: true, payload: 0 },
        { concurrency_safe: true, payload: 1 },
        { concurrency_safe: true, payload: 2 },
      ],
      executeOne: (payload) => {
        started.push(payload);
        return waits[payload].promise;
      },
    });
    void outputPromise.then(() => {
      returned = true;
    });

    await Promise.resolve();

    expect(started).toEqual([0, 1, 2]);
    expect(returned).toBe(false);

    waits[0].resolve('zero');
    waits[1].resolve('one');
    waits[2].resolve('two');

    await outputPromise;
  });

  // C12
  it('preserves input result order when parallel completions arrive in reverse order', async () => {
    const waits = [deferred<string>(), deferred<string>(), deferred<string>()];
    const outputPromise = barrelDispatchToolCalls({
      calls: [
        { concurrency_safe: true, payload: 0 },
        { concurrency_safe: true, payload: 1 },
        { concurrency_safe: true, payload: 2 },
      ],
      executeOne: (payload) => waits[payload].promise,
    });

    await Promise.resolve();
    waits[2].resolve('two');
    waits[1].resolve('one');
    waits[0].resolve('zero');

    const output = await outputPromise;

    expect(output.results).toEqual([
      { ok: true, value: 'zero' },
      { ok: true, value: 'one' },
      { ok: true, value: 'two' },
    ]);
  });

  // C13
  it('collects a parallel resolved value as an ok result', async () => {
    const output = await barrelDispatchToolCalls({
      calls: [{ concurrency_safe: true, payload: 'tool-1' }],
      executeOne: async (payload) => `value:${payload}`,
    });

    expect(output.results).toEqual([{ ok: true, value: 'value:tool-1' }]);
  });

  // C14
  it('collects a parallel async rejection as an error result', async () => {
    const error = new Error('parallel async reject');
    const output = await barrelDispatchToolCalls<string, string>({
      calls: [{ concurrency_safe: true, payload: 'tool-1' }],
      executeOne: async () => {
        throw error;
      },
    });

    expect(output.results[0]).toEqual({ ok: false, error });
  });

  // C15
  it('collects a parallel synchronous throw as an error result', async () => {
    const error = new Error('parallel sync throw');
    const output = await barrelDispatchToolCalls<string, string>({
      calls: [{ concurrency_safe: true, payload: 'tool-1' }],
      executeOne: (): Promise<string> => {
        throw error;
      },
    });

    expect(output.results[0]).toEqual({ ok: false, error });
  });

  // C16
  it('collects mixed parallel successes and failures in per-call order', async () => {
    const error = new Error('middle failed');
    const output = await barrelDispatchToolCalls<number, string>({
      calls: [
        { concurrency_safe: true, payload: 0 },
        { concurrency_safe: true, payload: 1 },
        { concurrency_safe: true, payload: 2 },
      ],
      executeOne: async (payload) => {
        if (payload === 1) throw error;
        return `ok:${payload}`;
      },
    });

    expect(output.results).toEqual([
      { ok: true, value: 'ok:0' },
      { ok: false, error },
      { ok: true, value: 'ok:2' },
    ]);
  });

  // C17
  it('returns one parallel result for every call', async () => {
    const calls = [
      { concurrency_safe: true, payload: 0 },
      { concurrency_safe: true, payload: 1 },
      { concurrency_safe: true, payload: 2 },
      { concurrency_safe: true, payload: 3 },
    ];

    const output = await barrelDispatchToolCalls({
      calls,
      executeOne: async (payload) => payload,
    });

    expect(output.results).toHaveLength(calls.length);
  });
});

describe('D-164 P5 dispatchToolCalls sequential mode', () => {
  // D18
  it('invokes sequential calls one at a time', async () => {
    const waits: Deferred<string>[] = [];
    const started: number[] = [];
    let returned = false;

    const outputPromise = barrelDispatchToolCalls({
      calls: [
        { concurrency_safe: false, payload: 0 },
        { concurrency_safe: false, payload: 1 },
      ],
      executeOne: (payload) => {
        started.push(payload);
        const wait = deferred<string>();
        waits.push(wait);
        return wait.promise;
      },
    });
    void outputPromise.then(() => {
      returned = true;
    });

    await Promise.resolve();

    expect(started).toEqual([0]);
    expect(waits).toHaveLength(1);

    waits[0].resolve('zero');
    await Promise.resolve();

    expect(started).toEqual([0, 1]);
    expect(waits).toHaveLength(2);
    expect(returned).toBe(false);

    waits[1].resolve('one');
    await outputPromise;
  });

  // D19
  it('preserves input result order in sequential mode', async () => {
    const output = await barrelDispatchToolCalls({
      calls: [
        { concurrency_safe: false, payload: 0 },
        { concurrency_safe: false, payload: 1 },
        { concurrency_safe: false, payload: 2 },
      ],
      executeOne: async (payload) => `value:${payload}`,
    });

    expect(output.results).toEqual([
      { ok: true, value: 'value:0' },
      { ok: true, value: 'value:1' },
      { ok: true, value: 'value:2' },
    ]);
  });

  // D20
  it('collects a sequential resolved value as an ok result', async () => {
    const output = await barrelDispatchToolCalls({
      calls: [{ concurrency_safe: false, payload: 'tool-1' }],
      executeOne: async (payload) => `value:${payload}`,
    });

    expect(output.results).toEqual([{ ok: true, value: 'value:tool-1' }]);
  });

  // D21
  it('collects a sequential async rejection as an error result', async () => {
    const error = new Error('sequential async reject');
    const output = await barrelDispatchToolCalls<string, string>({
      calls: [{ concurrency_safe: false, payload: 'tool-1' }],
      executeOne: async () => {
        throw error;
      },
    });

    expect(output.results[0]).toEqual({ ok: false, error });
  });

  // D22
  it('collects a sequential synchronous throw as an error result', async () => {
    const error = new Error('sequential sync throw');
    const output = await barrelDispatchToolCalls<string, string>({
      calls: [{ concurrency_safe: false, payload: 'tool-1' }],
      executeOne: (): Promise<string> => {
        throw error;
      },
    });

    expect(output.results[0]).toEqual({ ok: false, error });
  });

  // D23
  it('continues sequential dispatch after the first call rejects', async () => {
    const error = new Error('first failed');
    const seen: number[] = [];
    const output = await barrelDispatchToolCalls<number, string>({
      calls: [
        { concurrency_safe: false, payload: 0 },
        { concurrency_safe: false, payload: 1 },
      ],
      executeOne: async (payload) => {
        seen.push(payload);
        if (payload === 0) throw error;
        return `ok:${payload}`;
      },
    });

    expect(seen).toEqual([0, 1]);
    expect(output.results).toEqual([
      { ok: false, error },
      { ok: true, value: 'ok:1' },
    ]);
  });

  // D24
  it('returns one sequential result for every call', async () => {
    const calls = [
      { concurrency_safe: false, payload: 0 },
      { concurrency_safe: false, payload: 1 },
      { concurrency_safe: false, payload: 2 },
      { concurrency_safe: false, payload: 3 },
    ];

    const output = await barrelDispatchToolCalls({
      calls,
      executeOne: async (payload) => payload,
    });

    expect(output.results).toHaveLength(calls.length);
  });
});

describe('D-164 P5 dispatchToolCalls payload threading', () => {
  // E25
  it('threads a complex object payload identity-equal into executeOne', async () => {
    const payload = {
      id: 'deal-1',
      nested: { owners: ['alice', 'bob'] },
      meta: new Map([['source', 'fixture']]),
    };

    const output = await barrelDispatchToolCalls({
      calls: [{ concurrency_safe: true, payload }],
      executeOne: async (received) => {
        expect(received).toBe(payload);
        return received.id;
      },
    });

    expect(output.results).toEqual([{ ok: true, value: 'deal-1' }]);
  });

  // E26
  it('threads different union-shaped payloads verbatim into executeOne', async () => {
    type UnionPayload =
      | { readonly kind: 'email'; readonly subject: string }
      | { readonly kind: 'calendar'; readonly starts_at: string };

    const emailPayload = { kind: 'email', subject: 'status' } as const;
    const calendarPayload = {
      kind: 'calendar',
      starts_at: '2026-05-25T09:00:00-07:00',
    } as const;
    const seen: UnionPayload[] = [];

    await barrelDispatchToolCalls<UnionPayload, string>({
      calls: [
        { concurrency_safe: true, payload: emailPayload },
        { concurrency_safe: true, payload: calendarPayload },
      ],
      executeOne: async (payload) => {
        seen.push(payload);
        return payload.kind;
      },
    });

    expect(seen[0]).toBe(emailPayload);
    expect(seen[1]).toBe(calendarPayload);
  });
});

describe('D-164 P5 dispatchToolCalls error value semantics', () => {
  // F27
  it('preserves non-Error parallel rejection values verbatim', async () => {
    const objectReason = { code: 'plain-object' };
    const reasons: unknown[] = ['string-reason', objectReason, undefined];

    const output = await barrelDispatchToolCalls<number, string>({
      calls: [
        { concurrency_safe: true, payload: 0 },
        { concurrency_safe: true, payload: 1 },
        { concurrency_safe: true, payload: 2 },
      ],
      executeOne: (payload) => Promise.reject(reasons[payload]),
    });

    for (const [index, result] of output.results.entries()) {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe(reasons[index]);
    }
  });

  // F28
  it('preserves non-Error sequential rejection values verbatim', async () => {
    const objectReason = { code: 'plain-object' };
    const reasons: unknown[] = ['string-reason', objectReason, undefined];

    const output = await barrelDispatchToolCalls<number, string>({
      calls: [
        { concurrency_safe: false, payload: 0 },
        { concurrency_safe: false, payload: 1 },
        { concurrency_safe: false, payload: 2 },
      ],
      executeOne: (payload) => Promise.reject(reasons[payload]),
    });

    for (const [index, result] of output.results.entries()) {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe(reasons[index]);
    }
  });
});

describe('D-164 P5 dispatchToolCalls public surface coherence', () => {
  // G29
  it('exports dispatchToolCalls and its dispatch types from the middleware barrel', () => {
    type Payload = { readonly id: string };
    const call: DispatchableToolCall<Payload> = {
      concurrency_safe: true,
      payload: { id: 'payload-1' },
    };
    const result: ToolCallResult<string> = { ok: true, value: 'done' };
    const strategy: ToolDispatchStrategy = 'parallel';
    const input: ToolCallDispatchInput<Payload, string> = {
      calls: [call],
      executeOne: async (payload) => payload.id,
    };
    const output: ToolCallDispatchOutput<string> = {
      strategy,
      results: [result],
    };

    expect(typeof barrelDispatchToolCalls).toBe('function');
    expect(input.calls[0]).toBe(call);
    expect(output.results[0]).toBe(result);
  });

  // G30
  it('exports the same dispatchToolCalls function reference from the barrel and direct module', () => {
    expect(barrelDispatchToolCalls).toBe(directDispatchToolCalls);
  });
});
