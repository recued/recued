/** D-167 P6.0 -- normalize single-step ai-* llm.pii_fields declarations. */

import { describe, expect, it } from 'vitest';

import { normalizePiiFields } from '../pii-alias.js';

const sortTags = (tags: ReturnType<typeof normalizePiiFields>) =>
  [...tags].sort((a, b) => `${a.path}:${a.kind}`.localeCompare(`${b.path}:${b.kind}`));

describe('D-167 P6.0 normalizePiiFields', () => {
  it('normalizes the wire path-to-kind map into PiiFieldTag entries', () => {
    expect(sortTags(normalizePiiFields({
      'owner.email': 'email',
      phone: 'phone',
    }))).toEqual([
      { path: 'owner.email', kind: 'email' },
      { path: 'phone', kind: 'phone' },
    ]);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['empty object', {}],
  ])('treats %s as an empty no-op declaration', (_name, raw) => {
    expect(normalizePiiFields(raw)).toEqual([]);
  });

  it.each([
    ['array of tag objects', [{ path: 'e', kind: 'email' }]],
    ['string', 'email'],
    ['number', 42],
    ['Map', new Map([['e', 'email']])],
    ['inherited-only object', Object.create({ e: 'email' })],
    ['unknown kind', { e: 'not-a-kind' }],
    ['empty path', { '': 'email' }],
  ])('throws on %s', (_name, raw) => {
    expect(() => normalizePiiFields(raw)).toThrow();
  });

  it('accepts a null-prototype plain dict with own entries', () => {
    const raw = Object.create(null) as Record<string, unknown>;
    raw.e = 'email';

    expect(normalizePiiFields(raw)).toEqual([{ path: 'e', kind: 'email' }]);
  });

  it('names the bad-kind path without echoing the bad kind value', () => {
    let thrown: unknown;
    try {
      normalizePiiFields({ sender_private: 'not-a-kind' });
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain('sender_private');
    expect(message).not.toContain('not-a-kind');
  });
});
