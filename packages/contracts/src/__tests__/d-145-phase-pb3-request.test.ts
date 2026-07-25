/** D-145 PB3 — RecuedRequest validator tests.
 *
 *  Per § B.1.1. Pin every closed-list issue kind + every validator
 *  branch. The orchestrator's `assertValidRecuedRequest` gate
 *  depends on these assertions. */

import { describe, it, expect } from 'vitest';

import {
  RECUED_REQUEST_SURFACES,
  RECUED_REQUEST_VALIDATION_ISSUE_KINDS,
  RecuedRequestValidationError,
  assertValidRecuedRequest,
  validateRecuedRequest,
  type RecuedRequest,
} from '../recued-request.js';

const minimal = (overrides: Partial<RecuedRequest> = {}): RecuedRequest => ({
  request_id: 'req-1',
  user_request: 'hello',
  surface: 'webclient',
  ...overrides,
});

describe('PB3 — RECUED_REQUEST_SURFACES + RECUED_REQUEST_VALIDATION_ISSUE_KINDS', () => {
  it('surfaces are 7 closed-list values', () => {
    expect(RECUED_REQUEST_SURFACES).toEqual([
      'webclient',
      'extension',
      'mcp_chat',
      'recipe_invoke',
      'scheduled',
      'reactive',
      'compose',
    ]);
  });
  it('validation issue kinds count = 10', () => {
    expect(RECUED_REQUEST_VALIDATION_ISSUE_KINDS).toHaveLength(10);
  });
});

describe('validateRecuedRequest — happy path', () => {
  it('returns no issues for a minimal valid request', () => {
    expect(validateRecuedRequest(minimal())).toEqual([]);
  });

  it('returns no issues for a request with optional fields', () => {
    expect(
      validateRecuedRequest(
        minimal({
          goal_id: 'goal-A',
          conversation_id: 'conv-1',
          model_hint: 'reasoning',
          context_breadth: 'wide',
          preview: true,
          received_at: 1000,
          intents: [
            { intent_id: 'i1', kind: 'commitment_extract', topic_tags: ['email'], confidence: 0.9 },
          ],
        }),
      ),
    ).toEqual([]);
  });
});

describe('validateRecuedRequest — issue branches', () => {
  it('flags missing request_id', () => {
    const issues = validateRecuedRequest({ ...minimal(), request_id: '' });
    expect(issues.some((i) => i.kind === 'request_id_missing')).toBe(true);
  });

  it('flags malformed request_id', () => {
    const issues = validateRecuedRequest({ ...minimal(), request_id: 'has spaces' });
    expect(issues.some((i) => i.kind === 'request_id_malformed')).toBe(true);
  });

  it('flags missing user_request', () => {
    const issues = validateRecuedRequest({
      ...minimal(),
      user_request: undefined as unknown as string,
    });
    expect(issues.some((i) => i.kind === 'user_request_missing')).toBe(true);
  });

  it('allows empty-string user_request (valid for some surfaces)', () => {
    const issues = validateRecuedRequest({ ...minimal(), user_request: '' });
    expect(issues.find((i) => i.kind === 'user_request_missing')).toBeUndefined();
  });

  it('flags unknown surface', () => {
    const issues = validateRecuedRequest({
      ...minimal(),
      surface: 'spaceship' as never,
    });
    expect(issues.some((i) => i.kind === 'unknown_surface')).toBe(true);
  });

  it('flags unknown model_hint', () => {
    const issues = validateRecuedRequest({
      ...minimal(),
      model_hint: 'turbo' as never,
    });
    expect(issues.some((i) => i.kind === 'unknown_model_hint')).toBe(true);
  });

  it('flags unknown context_breadth', () => {
    const issues = validateRecuedRequest({
      ...minimal(),
      context_breadth: 'medium' as never,
    });
    expect(issues.some((i) => i.kind === 'unknown_context_breadth')).toBe(true);
  });

  it('flags duplicate intent_id', () => {
    const issues = validateRecuedRequest(
      minimal({
        intents: [
          { intent_id: 'i1', kind: 'commitment_extract', topic_tags: [] },
          { intent_id: 'i1', kind: 'query', topic_tags: [] },
        ],
      }),
    );
    expect(issues.some((i) => i.kind === 'intent_id_collision')).toBe(true);
  });

  it('flags out-of-range intent.confidence', () => {
    const issues = validateRecuedRequest(
      minimal({
        intents: [
          { intent_id: 'i1', kind: 'commitment_extract', topic_tags: [], confidence: 1.5 },
          { intent_id: 'i2', kind: 'query', topic_tags: [], confidence: -0.1 },
        ],
      }),
    );
    expect(issues.filter((i) => i.kind === 'intent_confidence_out_of_range')).toHaveLength(2);
  });

  it('flags negative received_at', () => {
    const issues = validateRecuedRequest(minimal({ received_at: -1 }));
    expect(issues.some((i) => i.kind === 'received_at_negative')).toBe(true);
  });

  it('collects multiple issues without bailing', () => {
    const issues = validateRecuedRequest({
      request_id: '',
      user_request: undefined as unknown as string,
      surface: 'unknown' as never,
      model_hint: 'turbo' as never,
    });
    expect(issues.length).toBeGreaterThanOrEqual(4);
    const kinds = new Set(issues.map((i) => i.kind));
    expect(kinds.has('request_id_missing')).toBe(true);
    expect(kinds.has('user_request_missing')).toBe(true);
    expect(kinds.has('unknown_surface')).toBe(true);
    expect(kinds.has('unknown_model_hint')).toBe(true);
  });
});

describe('assertValidRecuedRequest', () => {
  it('does not throw for valid input', () => {
    expect(() => assertValidRecuedRequest(minimal())).not.toThrow();
  });

  it('throws RecuedRequestValidationError on invalid input', () => {
    expect(() => assertValidRecuedRequest({ ...minimal(), request_id: '' })).toThrow(
      RecuedRequestValidationError,
    );
  });

  it('error.code === RECUED_REQUEST_MALFORMED + carries issues', () => {
    try {
      assertValidRecuedRequest({ ...minimal(), request_id: '' });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(RecuedRequestValidationError);
      const err = e as RecuedRequestValidationError;
      expect(err.code).toBe('RECUED_REQUEST_MALFORMED');
      expect(err.issues.length).toBeGreaterThan(0);
    }
  });
});
