/** The comment-stripper's own cases — it is a guard for guards, so it needs
 *  its own, and each case is one of the six real failures it exists to stop. */

import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';

import { codeNear, stripComments } from './source-text.js';

describe('stripComments', () => {
  it('⛔ removes a line comment that names the thing being checked', () => {
    const code = stripComments('// activeProfileId: dropped on purpose\nconst x = 1;');
    expect(code).not.toContain('activeProfileId');
    expect(code).toContain('const x = 1;');
  });

  it('⛔ removes a block comment naming a function that is no longer called', () => {
    const code = stripComments('/* was decideAddressChangeConvergence({...}) */\nconst d = inline();');
    expect(code).not.toContain('decideAddressChangeConvergence');
    expect(code).toContain('inline()');
  });

  it('⛔ removes a JSDoc block, which is where these names usually hide', () => {
    const code = stripComments('/** ⚠ `onLegacyAadRecord` is WIRED TO NOTHING. */\nexport const f = 1;');
    expect(code).not.toContain('onLegacyAadRecord');
    expect(code).toContain('export const f = 1;');
  });

  it('keeps code that merely looks comment-adjacent', () => {
    expect(stripComments('const url = "https://example.com/x";')).toContain('https://example.com/x');
  });

  it('⚠ survives a trailing comment on a real line without eating the line', () => {
    const code = stripComments('activeProfileId: read(), // the real one\n');
    expect(code).toContain('activeProfileId: read()');
    expect(code).not.toContain('the real one');
  });
});

describe('codeNear', () => {
  const self = resolve(import.meta.dirname, 'source-text.ts');

  it('returns a window of code around the anchor', () => {
    expect(codeNear(self, 'export const stripComments', 60)).toContain('stripComments');
  });

  it('⛔ THROWS on a missing anchor rather than returning an empty string', () => {
    // An empty string is green against every negative assertion, so a guard
    // watching renamed code would keep passing. Failing loudly is the point.
    expect(() => codeNear(self, 'aFunctionThatDoesNotExist', 40))
      .toThrow(/anchor .* is not in/);
  });

  it('⛔ throws for an anchor that survives ONLY in a comment', () => {
    // The subtle case: the name is still in the file, so a raw search finds it
    // and a code search does not. Silence here would be the worst of both.
    expect(() => codeNear(self, 'xserverAddressDepsx', 40)).toThrow();
  });
});
