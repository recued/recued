/** D-116 — wait transform. */

import { describe, it, expect } from 'vitest';
import { wait } from '../timing.js';
import { TRANSFORMS, getTransform } from '../index.js';
import { TRANSFORM_SCHEMAS } from '../schemas.js';
import { ctx } from './helpers.js';

describe('wait', () => {
  it('returns { waited_ms } matching the requested ms', async () => {
    const result = await wait({ ms: 10 }, ctx()) as { waited_ms: number };
    expect(result.waited_ms).toBe(10);
  });

  it('actually sleeps for roughly the requested duration', async () => {
    const start = Date.now();
    await wait({ ms: 50 }, ctx());
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(45);
    expect(elapsed).toBeLessThan(250);
  });

  it('handles ms=0 without sleeping and returns waited_ms=0', async () => {
    const start = Date.now();
    const result = await wait({ ms: 0 }, ctx()) as { waited_ms: number };
    const elapsed = Date.now() - start;
    expect(result.waited_ms).toBe(0);
    expect(elapsed).toBeLessThan(20);
  });

  it('throws on non-finite / negative ms', async () => {
    await expect(wait({ ms: -1 }, ctx())).rejects.toThrow(/non-negative/);
    await expect(wait({ ms: Number.NaN }, ctx())).rejects.toThrow(/finite/);
  });

  it('calls ctx.extendBudget with ms before sleeping so the engine excludes the pause', async () => {
    const calls: number[] = [];
    const c = ctx({ extendBudget: (ms) => calls.push(ms) });
    await wait({ ms: 5 }, c);
    expect(calls).toEqual([5]);
  });

  it('is registered in TRANSFORMS and schemas', () => {
    expect(getTransform('wait')).toBe(wait);
    expect(TRANSFORMS.get('wait')).toBe(wait);
    expect(TRANSFORM_SCHEMAS.wait).toBeDefined();
    expect(TRANSFORM_SCHEMAS.wait.ms).toMatchObject({ required: true, type: 'number' });
  });
});
