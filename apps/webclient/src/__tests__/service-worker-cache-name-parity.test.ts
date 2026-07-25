/** The shell cache name exists in TWO places that nothing makes agree:
 *
 *    · `public/sw.js`            — `CACHE_NAME`, the cache the SW actually opens
 *    · `runtime/service-worker.ts` — `WEBCLIENT_SHELL_CACHE_NAME`, what Settings →
 *                                     Privacy "Clear this browser" tries to delete
 *
 *  `public/sw.js` is served verbatim (copied into `build/`, never bundled), so it
 *  cannot import the constant, and no build step stamps it. The two are kept in
 *  sync by hand — and by hand has failed twice:
 *
 *    1. the default named `recued.webclient.assets`, which no SW ever opened;
 *    2. the constant sat on `v4` while the SW had moved to `v5`.
 *
 *  Both times the wipe deleted a cache that did not exist and reported success.
 *  A privacy control that silently does nothing is worse than an absent one, so
 *  the agreement is asserted here rather than trusted.
 *
 *  This reads the REAL `public/sw.js` off disk — the file that ships. Asserting
 *  the constant against itself would pass in exactly the drifted state that
 *  caused the bug. */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { WEBCLIENT_SHELL_CACHE_NAME } from '../runtime/service-worker.js';

const SW_PATH = resolve(__dirname, '../../public/sw.js');

/** Pull `CACHE_NAME` out of the shipped SW source. Deliberately narrow: it
 *  matches the single top-level `const CACHE_NAME = '<name>';` declaration and
 *  nothing else, so a renamed or computed binding fails loudly here instead of
 *  silently matching something that is not the cache the SW opens. */
const readSwCacheName = (source: string): string => {
  const matches = [...source.matchAll(/^const CACHE_NAME = '([^']+)';$/gm)];
  expect(
    matches.length,
    'expected exactly one top-level `const CACHE_NAME = \'…\';` in public/sw.js',
  ).toBe(1);
  return matches[0]![1]!;
};

describe('shell cache name parity — public/sw.js vs the wipe target', () => {
  it('the constant Clear-this-browser deletes is the cache the SW opens', () => {
    const swCacheName = readSwCacheName(readFileSync(SW_PATH, 'utf8'));

    expect(
      WEBCLIENT_SHELL_CACHE_NAME,
      `public/sw.js opens "${swCacheName}" but Clear-this-browser targets ` +
        `"${WEBCLIENT_SHELL_CACHE_NAME}". Bump BOTH — otherwise the wipe deletes ` +
        `a cache that does not exist and reports success.`,
    ).toBe(swCacheName);
  });

  it('the SW cache name is version-suffixed, so a deploy can invalidate the shell', () => {
    // `webclient-main.js` has a FIXED filename — no content hash. The version
    // suffix is the only thing that changes `sw.js` bytes, and changing those
    // bytes is the only thing that makes a browser re-run install/activate and
    // sweep the previous shell. A name without one cannot be bumped.
    const swCacheName = readSwCacheName(readFileSync(SW_PATH, 'utf8'));
    expect(swCacheName).toMatch(/^webclient-shell-v\d+$/);
  });
});
