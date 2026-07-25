import type { FormResponse } from '@recued/contracts';
import { describe, expect, it, vi } from 'vitest';

import { createKernelAdapter } from '../kernel.js';

const RESPONSE: FormResponse = {
  _id: 'submission-1',
  _collection: 'form_response',
  submission_id: 'submission-1',
  endpoint_id: 'endpoint-1',
  form_definition_id: 'definition-1',
  definition_snapshot: { fields: [] },
  values: { brief: 'Draft a proposal' },
  visitor: { email: 'visitor@example.test' },
  submitted_at: 1_000,
  accepted_at: 2_000,
  updated_at: 2_000,
  origin_actor: 'anonymous',
  origin_surface: 'system',
  lifecycle_state: 'received',
  state_changed_at: 0,
  metadata: {},
};

const call = (input: Record<string, unknown>) => ({
  slug: 'form-response-list',
  risk_tier: 'read' as const,
  input,
  output: {},
});

describe('kernel adapter — form-response-list', () => {
  it('routes bounded filters and preserves the keyset continuation', async () => {
    const next_cursor = { accepted_at: 2_000, submission_id: 'submission-1' };
    const formResponseList = vi.fn(async () => ({
      records: [RESPONSE],
      next_cursor,
    }));
    const adapter = createKernelAdapter({ formResponseList });

    await expect(adapter(call({
      endpoint_id: 'endpoint-1',
      form_definition_id: 'definition-1',
      lifecycle_states: ['received', 'in_review'],
      before: { accepted_at: 3_000, submission_id: 'submission-2' },
      limit: 25,
    }))).resolves.toEqual({ records: [RESPONSE], next_cursor });
    expect(formResponseList).toHaveBeenCalledWith({
      endpoint_id: 'endpoint-1',
      form_definition_id: 'definition-1',
      lifecycle_states: ['received', 'in_review'],
      before: { accepted_at: 3_000, submission_id: 'submission-2' },
      limit: 25,
    });
  });

  it('defaults to a bounded page and fails closed when the dispatcher is absent', async () => {
    const formResponseList = vi.fn(async () => ({ records: [] }));
    // Recipe execution merges these null manifest defaults into every call.
    // They are absence, not malformed explicit filters.
    await expect(createKernelAdapter({ formResponseList })(call({
      endpoint_id: null,
      form_definition_id: null,
      lifecycle_states: null,
      before: null,
      limit: 100,
    })))
      .resolves.toEqual({ records: [] });
    expect(formResponseList).toHaveBeenCalledWith({ limit: 100 });
    await expect(createKernelAdapter({})(call({})))
      .rejects.toMatchObject({ code: 'SERVER_NOT_REACHABLE' });
  });

  it.each([
    { limit: 0 },
    { limit: 500 },
    { endpoint_id: '' },
    { form_definition_id: 7 },
    { lifecycle_states: [] },
    { lifecycle_states: ['attended'] },
    { before: { accepted_at: -1, submission_id: 'x' } },
    { before: { accepted_at: 1, submission_id: '' } },
    { unknown: 'field' },
  ])('rejects malformed filters before dispatch: %j', async (input) => {
    const formResponseList = vi.fn(async () => ({ records: [] }));
    await expect(createKernelAdapter({ formResponseList })(call(input)))
      .rejects.toMatchObject({ code: 'BAD_INPUT' });
    expect(formResponseList).not.toHaveBeenCalled();
  });
});
