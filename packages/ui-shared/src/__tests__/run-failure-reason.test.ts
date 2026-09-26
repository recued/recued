/** Why a run failed, in one line: the surfaces that said only "Run returned
 *  errors" now say this under it (D-312). */

import { describe, expect, it } from 'vitest';
import { ERROR_MESSAGES } from '@recued/contracts';
import { runFailureReason } from '../run-failure-reason.js';

const error = (overrides: Record<string, unknown> = {}) => ({
  code: 'BAD_INPUT',
  message: 'notification-send: "slak" is not a channel',
  source: { recipe_id: 'r', step_id: 'send', ingredient_slug: null },
  details: {},
  ...overrides,
});

describe('runFailureReason', () => {
  it('nothing to explain is null', () => {
    expect(runFailureReason(undefined)).toBeNull();
    expect(runFailureReason([])).toBeNull();
  });

  it('⛔ the first error\'s message and its step', () => {
    expect(runFailureReason([error()])).toBe('notification-send: "slak" is not a channel (step send)');
  });

  it('says how many more there were', () => {
    expect(runFailureReason([error(), error({ message: 'second' })]))
      .toBe('notification-send: "slak" is not a channel (step send) · 1 more');
  });

  it('an error with no message says what its code means', () => {
    expect(runFailureReason([error({ message: '', source: undefined })])).toBe(ERROR_MESSAGES.BAD_INPUT);
  });

  it('⛔ never reads details: they can carry addresses', () => {
    const line = runFailureReason([error({ message: '', details: { account_email: 'someone@example.com' } })]);
    expect(line).not.toContain('@');
  });

  it('keeps a long message to one bounded line', () => {
    const line = runFailureReason([error({ message: `a\n${'b'.repeat(900)}`, source: undefined })])!;
    expect(line.length).toBe(400);
    expect(line.startsWith('a b')).toBe(true);
    expect(line.endsWith('…')).toBe(true);
  });

  it('errors that are not objects are counted, not shown', () => {
    expect(runFailureReason(['x', 42])).toBe('2 errors, none readable');
  });
});
