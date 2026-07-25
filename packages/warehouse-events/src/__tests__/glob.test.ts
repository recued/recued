import { describe, expect, it } from 'vitest';

import { eventPath, matchesPattern } from '../glob.js';

describe('eventPath', () => {
  it('composes the canonical dotted path', () => {
    expect(eventPath('mail', 'work', 'message', 'created')).toBe(
      'data.mail.work.message.created',
    );
  });
});

describe('matchesPattern', () => {
  it('matches a literal path', () => {
    expect(matchesPattern('data.mail.work.message.created', 'data.mail.work.message.created')).toBe(true);
  });

  it('* matches a single segment', () => {
    expect(matchesPattern('data.mail.*.message.created', 'data.mail.work.message.created')).toBe(true);
    expect(matchesPattern('data.mail.*.message.created', 'data.mail.work.extra.message.created')).toBe(false);
  });

  it('** matches zero or more trailing segments', () => {
    expect(matchesPattern('data.mail.**', 'data.mail.work.message.created')).toBe(true);
    expect(matchesPattern('data.mail.**', 'data.mail')).toBe(true);
    expect(matchesPattern('data.mail.**', 'data.file.work.message.created')).toBe(false);
  });

  it('** in the middle matches the suffix', () => {
    expect(matchesPattern('data.**.created', 'data.mail.work.message.created')).toBe(true);
    expect(matchesPattern('data.**.created', 'data.mail.work.message.updated')).toBe(false);
  });

  it('differs on segment boundaries', () => {
    expect(matchesPattern('a.b', 'a.b.c')).toBe(false);
    expect(matchesPattern('a.b.c', 'a.b')).toBe(false);
  });
});
