/** D-145 engine-wiring slice 3b.0 - D-153 commit shape lock. */

import { describe, expect, it } from 'vitest';

import { isCommit } from '../commits.js';

const validCommit = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  commit_id: 'commit-1',
  kind: 'query',
  ingredient: 'calendar',
  tool: 'list',
  args: {},
  status: 'pending',
  source: {
    channel: 'user',
    actor: 'user_self',
    user_id: 'user-1',
    client_token_id: 'client-token-1',
  },
  channel_session_id: 'user:user-1',
  correlation_id: 'corr-1',
  request_id: 'request-1',
  dispatch_depth: 0,
  idempotency_key: 'idem-1',
  dispatched_at: 1_700_000_000_000,
  ...overrides,
});

const withoutField = (
  value: object,
  field: string,
): Record<string, unknown> => {
  const next = { ...value } as Record<string, unknown>;
  delete next[field];
  return next;
};

describe('D-145 slice 3b.0 Commit predicate', () => {
  it('accepts a commit with cached true present', () => {
    expect(isCommit(validCommit({ cached: true }))).toBe(true);
  });

  it('accepts a commit with detail present', () => {
    expect(isCommit(validCommit({ detail: { foo: 'bar' } }))).toBe(true);
  });

  it('accepts a commit with cached true and detail present', () => {
    expect(isCommit(validCommit({
      cached: true,
      detail: { foo: 'bar' },
    }))).toBe(true);
  });

  it('accepts a commit with detail undefined', () => {
    expect(isCommit(validCommit({ detail: undefined }))).toBe(true);
  });

  it('rejects a commit with request_id missing', () => {
    expect(isCommit(withoutField(validCommit(), 'request_id'))).toBe(false);
  });

  it('rejects a commit with request_id as a number', () => {
    expect(isCommit(validCommit({ request_id: 123 }))).toBe(false);
  });

  it('rejects a commit with request_id as an empty string', () => {
    expect(isCommit(validCommit({ request_id: '' }))).toBe(false);
  });

  it('rejects a commit with cached false', () => {
    expect(isCommit(validCommit({ cached: false }))).toBe(false);
  });

  it('rejects a commit with cached as a number', () => {
    expect(isCommit(validCommit({ cached: 1 }))).toBe(false);
  });

  it('rejects a commit with cached as a string', () => {
    expect(isCommit(validCommit({ cached: 'true' }))).toBe(false);
  });

  it('rejects a commit with detail null', () => {
    expect(isCommit(validCommit({ detail: null }))).toBe(false);
  });

  it('rejects a commit with detail as an array', () => {
    expect(isCommit(validCommit({ detail: [] }))).toBe(false);
  });

  it('rejects a commit with detail as a string', () => {
    expect(isCommit(validCommit({ detail: 'string' }))).toBe(false);
  });
});
