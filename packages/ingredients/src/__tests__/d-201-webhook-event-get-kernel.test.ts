import { describe, expect, it, vi } from 'vitest';
import { createInMemoryStore } from '@recued/cache';
import type { IngredientManifest } from '@recued/contracts';

import { withIngredientCache } from '../cache.js';
import { createKernelAdapter } from '../kernel.js';

const call = (
  input: Record<string, unknown>,
  stepMeta?: { step_id: string; recipe_id?: string; run_id?: string },
) => ({
  slug: 'webhook-event-get',
  risk_tier: 'read' as const,
  input,
  output: {},
  ...(stepMeta ? { stepMeta } : {}),
});

describe('D-201 kernel adapter — webhook-event-get', () => {
  it('passes the locator plus engine-only recipe/run authority to the scoped reader', async () => {
    const result = {
      event: { event_id: 'whe_1' },
      delivery: { delivery_id: 'whd_1' },
      payload: { private_value: 'accepted' },
    };
    const webhookEventGet = vi.fn(async () => result);
    const adapter = createKernelAdapter({ webhookEventGet });

    await expect(adapter(call(
      { event_ref: 'whe_1' },
      { step_id: 'read-event', recipe_id: 'consumer-recipe', run_id: 'whr_1' },
    ))).resolves.toEqual(result);
    expect(webhookEventGet).toHaveBeenCalledWith(
      { event_ref: 'whe_1' },
      { recipe_id: 'consumer-recipe', run_id: 'whr_1' },
    );
  });

  it('does not accept authored recipe/run identity in place of StepMeta', async () => {
    const webhookEventGet = vi.fn(async () => ({ payload: {} }));
    const adapter = createKernelAdapter({ webhookEventGet });

    await expect(adapter(call({
      event_ref: 'whe_1',
      recipe_id: 'forged-recipe',
      run_id: 'forged-run',
    }))).rejects.toMatchObject({ code: 'WEBHOOK_EVENT_NOT_AUTHORIZED' });
    expect(webhookEventGet).not.toHaveBeenCalled();
  });

  it.each([
    {},
    { event_ref: '' },
    { event_ref: '   ' },
    { event_ref: 42 },
  ])('rejects an invalid event ref before dispatch: %j', async (input) => {
    const webhookEventGet = vi.fn(async () => ({ payload: {} }));
    const adapter = createKernelAdapter({ webhookEventGet });

    await expect(adapter(call(
      input,
      { step_id: 'read-event', recipe_id: 'consumer-recipe', run_id: 'whr_1' },
    ))).rejects.toMatchObject({ code: 'BAD_INPUT' });
    expect(webhookEventGet).not.toHaveBeenCalled();
  });

  it('fails closed when no scoped reader is composed', async () => {
    const adapter = createKernelAdapter({});
    await expect(adapter(call(
      { event_ref: 'whe_1' },
      { step_id: 'read-event', recipe_id: 'consumer-recipe', run_id: 'whr_1' },
    ))).rejects.toMatchObject({ code: 'SERVER_NOT_REACHABLE' });
  });

  it('never caches decoded payload across recipe/run authority boundaries', async () => {
    const manifest: IngredientManifest = {
      slug: 'webhook-event-get',
      name: 'Scoped webhook event read',
      description: 'D-201 live-authorization cache regression fixture',
      author: 'recued',
      kind: 'storage',
      version: 1,
      category: 'data',
      risk_tier: 'read',
      input: { event_ref: null },
      output: { payload: 'payload' },
    };
    const raw = vi.fn(async (
      _slug: string,
      _input: Record<string, unknown>,
      _output: Record<string, string> | undefined,
      _options: unknown,
      stepMeta: { recipe_id?: string; run_id?: string } | undefined,
    ) => {
      if (stepMeta?.recipe_id !== 'authorized-recipe'
        || stepMeta.run_id !== 'authorized-run') {
        throw new Error('live webhook authority denied');
      }
      return { payload: { private_value: 'must-not-be-replayed' } };
    });
    const cached = withIngredientCache(raw, {
      manifestLoader: async () => manifest,
      store: createInMemoryStore(),
      recipe_ttl: 300,
      recipe_id: 'authorized-recipe',
    });

    await expect(cached(
      'webhook-event-get',
      { event_ref: 'whe_shared_locator' },
      undefined,
      undefined,
      { step_id: 'read', recipe_id: 'authorized-recipe', run_id: 'authorized-run' },
    )).resolves.toMatchObject({ payload: { private_value: 'must-not-be-replayed' } });

    await expect(cached(
      'webhook-event-get',
      { event_ref: 'whe_shared_locator' },
      undefined,
      undefined,
      { step_id: 'read', recipe_id: 'other-recipe', run_id: 'other-run' },
    )).rejects.toThrow('live webhook authority denied');
    expect(raw).toHaveBeenCalledTimes(2);
  });
});
