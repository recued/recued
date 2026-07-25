/** D-210 A.8 slice 2 — the lifecycle WRITE through the real kernel adapter.
 *
 *  The store gained `setLifecycleState` before anything could call it. This
 *  suite is the proof that the op ↔ slug-arm ↔ dispatcher triangle actually
 *  closes, rather than the method existing and being unreachable — the
 *  declared-but-not-backed shape this arc keeps closing. */

import type { FormResponse } from '@recued/contracts';
import { FORM_RESPONSE_LIFECYCLE_STATES } from '@recued/contracts';
import { describe, expect, it, vi } from 'vitest';

import { createKernelAdapter } from '../kernel.js';

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
  origin_actor: 'anonymous',
  origin_surface: 'system',
  lifecycle_state: 'no_show',
  state_changed_at: 5_000,
  metadata: { template_ref: 'file:template-1' },
};

const call = (input: Record<string, unknown>) => ({
  slug: 'form-response-set-state',
  risk_tier: 'write' as const,
  input,
  output: {},
});

describe('kernel adapter — form-response-set-state', () => {
  it('routes the submission id AND the state to the dispatcher', async () => {
    const formResponseSetState = vi.fn(async () => ({ record: RESPONSE }));
    const adapter = createKernelAdapter({ formResponseSetState });

    await expect(
      adapter(call({ submission_id: 'submission-1', lifecycle_state: 'no_show' })),
    ).resolves.toEqual({ record: RESPONSE });
    // Assert the REQUEST, not just that something came back: a dispatcher that
    // ignored `lifecycle_state` would still return a record.
    expect(formResponseSetState).toHaveBeenCalledWith({
      submission_id: 'submission-1',
      lifecycle_state: 'no_show',
    });
  });

  it('accepts EVERY state in the contract vocabulary', async () => {
    const formResponseSetState = vi.fn(async () => ({ record: RESPONSE }));
    const adapter = createKernelAdapter({ formResponseSetState });

    // Driven off the const itself — a state added to the vocabulary but
    // rejected by the arm fails here without anyone remembering to extend a
    // hand-written list.
    for (const state of FORM_RESPONSE_LIFECYCLE_STATES) {
      await expect(
        adapter(call({ submission_id: 'submission-1', lifecycle_state: state })),
      ).resolves.toMatchObject({ record: expect.anything() });
    }
    expect(formResponseSetState).toHaveBeenCalledTimes(
      FORM_RESPONSE_LIFECYCLE_STATES.length,
    );
  });

  it('rejects a state outside the vocabulary and NAMES the accepted set', async () => {
    const formResponseSetState = vi.fn(async () => ({ record: RESPONSE }));
    const adapter = createKernelAdapter({ formResponseSetState });

    await expect(
      adapter(call({ submission_id: 'submission-1', lifecycle_state: 'attended' })),
    ).rejects.toMatchObject({ code: 'BAD_INPUT' });
    // The dispatcher must never see it — validation is in front of the store.
    expect(formResponseSetState).not.toHaveBeenCalled();

    // The message is built from the const, so an agent reads back the ACTUAL
    // accepted set rather than a copy that can drift from it.
    await expect(
      adapter(call({ submission_id: 'submission-1', lifecycle_state: 'attended' })),
    ).rejects.toThrow(FORM_RESPONSE_LIFECYCLE_STATES.join(', '));
  });

  it('requires a submission id', async () => {
    const formResponseSetState = vi.fn(async () => ({ record: RESPONSE }));
    const adapter = createKernelAdapter({ formResponseSetState });

    await expect(
      adapter(call({ lifecycle_state: 'accepted' })),
    ).rejects.toMatchObject({ code: 'BAD_INPUT' });
    expect(formResponseSetState).not.toHaveBeenCalled();
  });

  it('preserves a missing row as record: null rather than inventing one', async () => {
    const adapter = createKernelAdapter({
      formResponseSetState: async () => ({ record: null }),
    });

    await expect(
      adapter(call({ submission_id: 'missing', lifecycle_state: 'accepted' })),
    ).resolves.toEqual({ record: null });
  });

  it('throws SERVER_NOT_REACHABLE when the dispatcher is absent', async () => {
    const adapter = createKernelAdapter({});

    await expect(
      adapter(call({ submission_id: 'submission-1', lifecycle_state: 'accepted' })),
    ).rejects.toMatchObject({ code: 'SERVER_NOT_REACHABLE' });
  });
});
