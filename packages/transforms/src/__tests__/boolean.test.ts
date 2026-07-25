import { describe, it, expect } from 'vitest';
import { starts_with, ends_with } from '../boolean.js';
import { ctx } from './helpers.js';

const c = ctx();

describe('starts_with', () => {
  it('true when prefix matches', () => expect(starts_with({ input: 'hello', prefix: 'hel' }, c)).toBe(true));
  it('false when no match', () => expect(starts_with({ input: 'hello', prefix: 'xyz' }, c)).toBe(false));
  it('false for non-string', () => expect(starts_with({ input: 123, prefix: '1' }, c)).toBe(false));
});

describe('ends_with', () => {
  it('true when suffix matches', () => expect(ends_with({ input: 'hello', suffix: 'llo' }, c)).toBe(true));
  it('false when no match', () => expect(ends_with({ input: 'hello', suffix: 'xyz' }, c)).toBe(false));
});
