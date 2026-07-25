import { describe, expect, it, vi } from 'vitest';

import type { Checkpoint } from '@recued/contracts';

import { withBeforePreflightResume } from '../composition/bin/wire-notification-block.js';

const NOW = 1_700_000_000_000;

const checkpoint = (): Checkpoint => ({
  checkpoint_id: 'cp-hook',
  run_id: 'run-hook',
  recipe_id: 'recipe-hook',
  gated_step_id: 'write',
  step_state: {},
  created_at: NOW,
});

describe('preflight resumer durable effect hook', () => {
  it('runs before downstream resume and a failure prevents execution', async () => {
    const order: string[] = [];
    const base = {
      resumeRun: vi.fn(async () => { order.push('resume'); }),
      denyRun: vi.fn(async () => { order.push('deny'); }),
    };
    const before = vi.fn(async () => { order.push('before'); });
    const wrapped = withBeforePreflightResume(base, before);
    const cp = checkpoint();
    const context = {
      recipe_id: 'recipe-hook',
      gated_step_id: 'write',
      approved_at: NOW + 500,
    };

    await wrapped.resumeRun(cp, context);
    expect(order).toEqual(['before', 'resume']);
    expect(before).toHaveBeenCalledWith(cp, context);

    const blockedBase = {
      resumeRun: vi.fn(async () => undefined),
      denyRun: vi.fn(async () => undefined),
    };
    const blocked = withBeforePreflightResume(blockedBase, async () => {
      throw new Error('canonical promotion unavailable');
    });
    await expect(blocked.resumeRun(cp, context)).rejects.toThrow(
      'canonical promotion unavailable',
    );
    expect(blockedBase.resumeRun).not.toHaveBeenCalled();

    // A rejection is not acceptance and must not run acceptance effects.
    await wrapped.denyRun(cp, context);
    expect(before).toHaveBeenCalledTimes(1);
    expect(base.denyRun).toHaveBeenCalledTimes(1);
  });
});
