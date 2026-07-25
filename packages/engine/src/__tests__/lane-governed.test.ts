/** D-181 Slice 2 — the engine's lane-governor seam (`invokeGoverned`).
 *
 *  Verifies that every governed ingredient call: classifies by manifest kind,
 *  acquires a slot, runs the executor inline, and releases on settle — success
 *  OR throw. The no-op default (no governor injected) must be behaviour-neutral. */

import { describe, expect, it } from 'vitest';
import type {
  ExecutionLane,
  IngredientManifest,
  LaneGovernor,
  OpDurationClassifier,
  SlotOutcome,
  SlotRequest,
} from '@recued/contracts';
import { isGatedCallClass } from '@recued/contracts';
import type { ExecutionContext } from '../types.js';
import { invokeGoverned, resolveCallClass } from '../lane.js';

/** A fake duration classifier: pre-seed recorded maxima, capture `record` calls. */
const makeFakeClassifier = (recorded: Record<string, number> = {}) => {
  const records: Array<{ slug: string; ms: number }> = [];
  const classifier: OpDurationClassifier = {
    recordedMaxMs: (slug) => recorded[slug],
    record: (slug, ms) => {
      records.push({ slug, ms });
    },
  };
  return { classifier, records };
};

const makeFakeGovernor = () => {
  const acquired: SlotRequest[] = [];
  const released: SlotOutcome[] = [];
  const governor: LaneGovernor = {
    acquire: async (r) => {
      acquired.push(r);
      let done = false;
      return {
        lane: isGatedCallClass(r.call_class) ? (r.call_class as ExecutionLane) : null,
        reportProgress: () => {},
        release: (o) => {
          if (done) return;
          done = true;
          released.push(o);
        },
      };
    },
  };
  return { governor, acquired, released };
};

const makeCtx = (over: Partial<ExecutionContext> & { executor?: ExecutionContext['ingredientExecutor'] }) =>
  ({
    recipe: { recipe_id: 'rcp' },
    ingredientExecutor: over.executor ?? (async () => 'RESULT'),
    manifestGetter: (slug: string) =>
      ({ kind: slug === 'docling' ? 'service' : 'storage' }) as IngredientManifest,
    ...over,
  }) as unknown as ExecutionContext;

describe('resolveCallClass', () => {
  it('reads the manifest kind', () => {
    const ctx = makeCtx({});
    expect(resolveCallClass(ctx, 'docling')).toBe('local-heavy');
    expect(resolveCallClass(ctx, 'warehouse-read')).toBe('fast-path');
  });

  it('defaults to external-io (default-gated) when the kind is unresolvable', () => {
    const ctx = makeCtx({ manifestGetter: undefined });
    expect(resolveCallClass(ctx, 'unknown')).toBe('external-io');
  });

  it('honors an explicit fast_path:true opt-out regardless of kind (§3d)', () => {
    const ctx = makeCtx({
      manifestGetter: (slug: string) =>
        ({ kind: 'service', fast_path: slug === 'cheap-cli' }) as IngredientManifest,
    });
    expect(resolveCallClass(ctx, 'cheap-cli')).toBe('fast-path'); // bypass despite service
    expect(resolveCallClass(ctx, 'heavy-cli')).toBe('local-heavy'); // no opt-out → gated
  });
});

describe('resolveCallClass — D-181 §10 duration-threshold demotion (default-gated)', () => {
  it('demotes a gated-kind op to fast-path once its worst run is under the threshold', () => {
    const { classifier } = makeFakeClassifier({ docling: 4_000 });
    const ctx = makeCtx({ opDurationClassifier: classifier });
    expect(resolveCallClass(ctx, 'docling')).toBe('fast-path'); // was local-heavy
  });

  it('keeps a gated-kind op gated when its worst run is at/over the threshold', () => {
    const { classifier } = makeFakeClassifier({ docling: 9_000 });
    const ctx = makeCtx({ opDurationClassifier: classifier });
    expect(resolveCallClass(ctx, 'docling')).toBe('local-heavy');
  });

  it('keeps an unknown (never-recorded) op gated — the safe default', () => {
    const { classifier } = makeFakeClassifier({});
    const ctx = makeCtx({ opDurationClassifier: classifier });
    expect(resolveCallClass(ctx, 'docling')).toBe('local-heavy');
  });

  it('never demotes a non-gated class (ai stays ai-governor even when fast)', () => {
    const { classifier } = makeFakeClassifier({ gpt: 1 });
    const ctx = makeCtx({
      opDurationClassifier: classifier,
      manifestGetter: (slug: string) =>
        ({ kind: slug === 'gpt' ? 'ai' : 'storage' }) as IngredientManifest,
    });
    expect(resolveCallClass(ctx, 'gpt')).toBe('ai-governor'); // NOT fast-path
  });

  it('is behaviour-neutral with no classifier injected (kind-only classification)', () => {
    const ctx = makeCtx({}); // no opDurationClassifier
    expect(resolveCallClass(ctx, 'docling')).toBe('local-heavy');
  });
});

describe('invokeGoverned', () => {
  it('acquires the classified slot, runs the executor, releases on success', async () => {
    const { governor, acquired, released } = makeFakeGovernor();
    const seen: unknown[] = [];
    const ctx = makeCtx({
      laneGovernor: governor,
      executor: async (slug, input) => {
        seen.push([slug, input]);
        return 'OK';
      },
    });
    const result = await invokeGoverned(ctx, 'docling', { a: 1 }, undefined, undefined, undefined);
    expect(result).toBe('OK');
    expect(acquired).toHaveLength(1);
    expect(acquired[0].call_class).toBe('local-heavy');
    expect(acquired[0].descriptor).toEqual({ recipe_id: 'rcp', slug: 'docling' });
    expect(seen).toEqual([['docling', { a: 1 }]]);
    expect(released).toEqual(['succeeded']);
  });

  it('releases as failed and re-throws when the executor crashes', async () => {
    const { governor, released } = makeFakeGovernor();
    const ctx = makeCtx({
      laneGovernor: governor,
      executor: async () => {
        throw new Error('boom');
      },
    });
    await expect(
      invokeGoverned(ctx, 'docling', {}, undefined, undefined, undefined),
    ).rejects.toThrow('boom');
    expect(released).toEqual(['failed']); // slot freed despite the crash
  });

  it('forwards host-provided held_lanes to the governor', async () => {
    const { governor, acquired } = makeFakeGovernor();
    const ctx = makeCtx({ laneGovernor: governor, heldLanes: new Set(['local-heavy']) });
    await invokeGoverned(ctx, 'docling', {}, undefined, undefined, undefined);
    expect(acquired[0].held_lanes).toEqual(new Set(['local-heavy']));
  });

  it('is behaviour-neutral with no governor injected (no-op default)', async () => {
    const calls: string[] = [];
    const ctx = makeCtx({
      executor: async (slug) => {
        calls.push(slug);
        return 'NEUTRAL';
      },
    });
    const result = await invokeGoverned(ctx, 'docling', {}, undefined, undefined, undefined);
    expect(result).toBe('NEUTRAL');
    expect(calls).toEqual(['docling']); // executor still runs, unchanged
  });

  it('records a SUCCESSFUL call duration into the §10 classifier', async () => {
    const { governor } = makeFakeGovernor();
    const { classifier, records } = makeFakeClassifier();
    const ctx = makeCtx({ laneGovernor: governor, opDurationClassifier: classifier });
    await invokeGoverned(ctx, 'docling', {}, undefined, undefined, undefined);
    expect(records).toHaveLength(1);
    expect(records[0].slug).toBe('docling');
    expect(records[0].ms).toBeGreaterThanOrEqual(0);
  });

  it('does NOT record a duration when the call fails (a truncated time must not demote a slow op)', async () => {
    const { governor } = makeFakeGovernor();
    const { classifier, records } = makeFakeClassifier();
    const ctx = makeCtx({
      laneGovernor: governor,
      opDurationClassifier: classifier,
      executor: async () => {
        throw new Error('boom');
      },
    });
    await expect(
      invokeGoverned(ctx, 'docling', {}, undefined, undefined, undefined),
    ).rejects.toThrow('boom');
    expect(records).toHaveLength(0);
  });
});
