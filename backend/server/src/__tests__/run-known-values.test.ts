/** D-316 amendment (2026-10-06) — the known-value matcher is built at most once
 *  per run, never reused once degraded, released at the run's end, capped. */
import { describe, expect, it } from 'vitest';

import { buildKnownValueIndex, type PiiKnownValueSource } from '@recued/transforms';

import { createRunKnownValues } from '../run-known-values.js';

const counting = () => {
  const made: Array<PiiKnownValueSource & { degrade(): void }> = [];
  const build = (): PiiKnownValueSource => {
    let degraded = false;
    const source = {
      nameOrgIndex: { index: buildKnownValueIndex([{ value: 'Dana Whitfield', kind: 'name' as const }]) },
      resolveIdentifiers: () => [],
      isDegraded: () => degraded,
      degrade: () => { degraded = true; },
    };
    made.push(source);
    return source;
  };
  return { build, made };
};

describe('createRunKnownValues', () => {
  it('builds once for a run, however many of its calls ask', () => {
    const { build, made } = counting();
    const runs = createRunKnownValues(build);
    const forRun = runs.forRun('run-1');
    const first = forRun();
    expect(forRun()).toBe(first);
    expect(runs.forRun('run-1')()).toBe(first); // a second getter for the same run shares it
    expect(made).toHaveLength(1);
  });

  it('each run gets its own matcher, and a released run builds again', () => {
    const { build, made } = counting();
    const runs = createRunKnownValues(build);
    const one = runs.forRun('run-1')();
    const two = runs.forRun('run-2')();
    expect(two).not.toBe(one);
    runs.release('run-1');
    expect(runs.size()).toBe(1);
    expect(runs.forRun('run-1')()).not.toBe(one);
    expect(made).toHaveLength(3);
  });

  it('⛔ a degraded matcher goes to the call that built it, and the next call builds afresh', () => {
    const { build, made } = counting();
    const runs = createRunKnownValues(build);
    const forRun = runs.forRun('run-1');
    const first = forRun()!;
    made[0]!.degrade(); // e.g. a per-text phone lookup failed during that call
    expect(first.isDegraded()).toBe(true); // that call fails closed on it
    const second = forRun()!;
    expect(second).not.toBe(first);
    expect(second.isDegraded()).toBe(false);
    expect(made).toHaveLength(2);
  });

  it('keeps at most `maxRuns` runs, evicting the least recently used', () => {
    const { build, made } = counting();
    const runs = createRunKnownValues(build, 2);
    const a = runs.forRun('a')();
    runs.forRun('b')();
    expect(runs.forRun('a')()).toBe(a); // touching `a` makes `b` the oldest
    runs.forRun('c')();
    expect(runs.size()).toBe(2);
    expect(runs.forRun('a')()).toBe(a);
    expect(made).toHaveLength(3);
    runs.forRun('b')(); // evicted, so it builds again
    expect(made).toHaveLength(4);
  });

  it('a call with no run id is matched per call, never under a shared key', () => {
    const { build, made } = counting();
    const runs = createRunKnownValues(build);
    runs.forRun(undefined)();
    runs.forRun('')();
    expect(made).toHaveLength(2);
    expect(runs.size()).toBe(0);
  });

  it('a build with nothing to offer is not kept', () => {
    let builds = 0;
    const runs = createRunKnownValues(() => {
      builds += 1;
      return undefined;
    });
    expect(runs.forRun('run-1')()).toBeUndefined();
    expect(runs.forRun('run-1')()).toBeUndefined();
    expect(builds).toBe(2);
    expect(runs.size()).toBe(0);
  });
});
