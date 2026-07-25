/** D-148 P4 — internal-step grey-text stream. */

import { describe, expect, it } from 'vitest';
import type { WebclientInternalStepEntry } from '@recued/contracts';
import { createInternalStepStream } from '../internal-steps/stream.js';

const entry = (over: Partial<WebclientInternalStepEntry> = {}): WebclientInternalStepEntry => ({
  recipe_run_id: 'run-1',
  step_id: 's-1',
  summary: 'checking memory',
  ts: 1_000,
  state: 'in_flight',
  ...over,
});

describe('D-148 P4 — internal step stream', () => {
  it('push appends + history reads in order', () => {
    const stream = createInternalStepStream();
    stream.push(entry({ step_id: 's-1', ts: 1 }));
    stream.push(entry({ step_id: 's-2', ts: 2 }));
    const h = stream.history('run-1');
    expect(h.map((e) => e.step_id)).toEqual(['s-1', 's-2']);
  });

  it('coalesces duplicate (run, step, ts)', () => {
    const stream = createInternalStepStream();
    stream.push(entry({ step_id: 's-1', ts: 1 }));
    stream.push(entry({ step_id: 's-1', ts: 1 }));
    stream.push(entry({ step_id: 's-1', ts: 1 }));
    expect(stream.history('run-1')).toHaveLength(1);
  });

  it('caps history per run', () => {
    const stream = createInternalStepStream({ history_cap_per_run: 2 });
    stream.push(entry({ step_id: 's-1', ts: 1 }));
    stream.push(entry({ step_id: 's-2', ts: 2 }));
    stream.push(entry({ step_id: 's-3', ts: 3 }));
    const h = stream.history('run-1');
    expect(h.map((e) => e.step_id)).toEqual(['s-2', 's-3']);
  });

  it('subscribers fire on every push with snapshot', () => {
    const stream = createInternalStepStream();
    const calls: number[] = [];
    stream.subscribe((_run, list) => calls.push(list.length));
    stream.push(entry({ step_id: 's-1', ts: 1 }));
    stream.push(entry({ step_id: 's-2', ts: 2 }));
    expect(calls).toEqual([1, 2]);
  });

  it('clearRun + clearAll wipe history', () => {
    const stream = createInternalStepStream();
    stream.push(entry({ step_id: 's-1', ts: 1, recipe_run_id: 'run-A' }));
    stream.push(entry({ step_id: 's-2', ts: 2, recipe_run_id: 'run-B' }));
    stream.clearRun('run-A');
    expect(stream.history('run-A')).toHaveLength(0);
    expect(stream.history('run-B')).toHaveLength(1);
    stream.clearAll();
    expect(stream.size()).toBe(0);
  });

  it('listener throw is isolated', () => {
    const stream = createInternalStepStream();
    stream.subscribe(() => {
      throw new Error('boom');
    });
    let n = 0;
    stream.subscribe(() => (n += 1));
    stream.push(entry({ step_id: 's-1', ts: 1 }));
    expect(n).toBe(1);
  });
});
