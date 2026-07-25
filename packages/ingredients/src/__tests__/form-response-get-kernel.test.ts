import type { FormResponse } from '@recued/contracts';
import { describe, expect, it, vi } from 'vitest';

import { createKernelAdapter } from '../kernel.js';
import { IngredientError } from '../types.js';

const RESPONSE: FormResponse = {
  _id: 'submission-1',
  _collection: 'form_response',
  submission_id: 'submission-1',
  endpoint_id: 'endpoint-1',
  form_definition_id: 'definition-1',
  definition_snapshot: { fields: [{ name: 'brief' }] },
  values: { brief: 'Draft a proposal' },
  visitor: { email: 'visitor@example.com' },
  submitted_at: 1_000,
  accepted_at: 2_000,
  updated_at: 2_000,
  origin_actor: 'anonymous',
  origin_surface: 'system',
  lifecycle_state: 'received',
  state_changed_at: 0,
  metadata: { template_ref: 'file:template-1' },
};

const call = (input: Record<string, unknown>) => ({
  slug: 'form-response-get',
  risk_tier: 'read' as const,
  input,
  output: {},
});

describe('kernel adapter — form-response-get', () => {
  it('routes the stable submission id and returns the full canonical response', async () => {
    const formResponseGet = vi.fn(async () => ({ record: RESPONSE }));
    const adapter = createKernelAdapter({ formResponseGet });

    await expect(adapter(call({ submission_id: 'submission-1' }))).resolves.toEqual({
      record: RESPONSE,
    });
    expect(formResponseGet).toHaveBeenCalledOnce();
    expect(formResponseGet).toHaveBeenCalledWith({ submission_id: 'submission-1' });
  });

  it('preserves a missing response as record: null', async () => {
    const adapter = createKernelAdapter({
      formResponseGet: async () => ({ record: null }),
    });

    await expect(adapter(call({ submission_id: 'missing' }))).resolves.toEqual({
      record: null,
    });
  });

  it('throws SERVER_NOT_REACHABLE when the dispatcher is absent', async () => {
    const adapter = createKernelAdapter({});

    await expect(
      adapter(call({ submission_id: 'submission-1' })),
    ).rejects.toMatchObject({ code: 'SERVER_NOT_REACHABLE' });
  });

  it.each([
    {},
    { submission_id: '' },
    { submission_id: '   ' },
    { submission_id: 42 },
  ])('rejects an invalid submission id before dispatch: %j', async (input) => {
    const formResponseGet = vi.fn(async () => ({ record: RESPONSE }));
    const adapter = createKernelAdapter({ formResponseGet });

    let caught: unknown;
    try {
      await adapter(call(input));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(IngredientError);
    expect(caught).toMatchObject({ code: 'BAD_INPUT' });
    expect(formResponseGet).not.toHaveBeenCalled();
  });
});
