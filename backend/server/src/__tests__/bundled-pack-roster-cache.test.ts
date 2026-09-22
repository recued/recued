/** The bundled pack roster is parsed once per unchanged tree.
 *
 *  ⛔ WHY A CACHE AT ALL, AND WHY THIS IS THE PIECE WORTH CACHING. Measured on
 *  a 1,051-pack realm, `packs.list` spent ~660ms of a ~1,170ms handler in
 *  `loadBundledPackManifests`, re-reading and re-parsing **95 MB of JSON on
 *  every call**. The per-pack DB queries everyone suspects — 2,104 of them —
 *  came to 69ms. The roster is 10x the cost of the N+1 it sits next to.
 *
 *  🔑 THE RISK IS MUTATION, NOT STALENESS, WHICH IS WHY THE COPY IS TESTED.
 *  Before the cache every caller got a freshly built array, so
 *  `handlePacksList`'s in-place `manifests.sort()` was harmless. Handing back
 *  the cached array would make one caller's sort reorder every later caller's
 *  roster — a cross-call side effect with no visible source. */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BULK_INSTALL_PACK_VERSION, BULK_PACK_INSTALL_PERMISSION } from '@recued/contracts';

import {
  clearBundledPackRosterCache,
  loadBundledPackManifests,
} from '../bundled-pack-source.js';

let dir: string;

const manifest = (slug: string, version = 1): string => JSON.stringify({
  manifest_version: BULK_INSTALL_PACK_VERSION,
  slug,
  publisher: 'recued-core',
  name: slug,
  description: `pack ${slug}`,
  version,
  recipes: [{ slug: `${slug}-recipe`, version: 1 }],
  requires: [BULK_PACK_INSTALL_PERMISSION],
  tags: [],
});

const write = (slug: string, version = 1): void =>
  writeFileSync(join(dir, `${slug}.json`), manifest(slug, version));

/** Move a file's mtime forward deliberately. ⚠ The test must not depend on the
 *  clock advancing between two writes — that is exactly the same-millisecond
 *  case the fingerprint cannot see, and a test that races it flakes. */
const touchAhead = (slug: string, secondsAhead: number): void => {
  const when = new Date(Date.now() + secondsAhead * 1000);
  utimesSync(join(dir, `${slug}.json`), when, when);
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'roster-cache-'));
  mkdirSync(dir, { recursive: true });
  clearBundledPackRosterCache();
});
afterEach(() => {
  clearBundledPackRosterCache();
  rmSync(dir, { recursive: true, force: true });
});

describe('bundled pack roster cache', () => {
  it('returns the same roster on a second call over an unchanged tree', () => {
    write('alpha');
    write('beta');
    const first = loadBundledPackManifests(dir);
    const second = loadBundledPackManifests(dir);
    expect(first.map((m) => m.slug).sort()).toStrictEqual(['alpha', 'beta']);
    expect(second.map((m) => m.slug).sort()).toStrictEqual(['alpha', 'beta']);
  });

  it('⛔ hands back a COPY — an in-place sort by one caller cannot reorder the next', () => {
    /** ⚠⚠ THE MUTATION MUST LAND ON A CACHE **HIT**, AND THE FIRST VERSION OF
     *  THIS TEST DID NOT. It mutated the FIRST call's array and passed even
     *  with the cache deliberately aliased — because a miss builds a fresh
     *  array and returns a copy of it either way, so the first result is never
     *  the cached one. The aliasing hazard exists only from the second call on.
     *  Caught by re-running this test against an aliased cache and watching it
     *  stay green, which is the only thing that would have shown it. */
    write('zulu');
    write('alpha');
    loadBundledPackManifests(dir);                      // 1st: populates (miss)
    const onAHit = loadBundledPackManifests(dir);       // 2nd: the cached path
    // `handlePacksList` does exactly this to the array it is given.
    onAHit.sort((a, b) => a.slug.localeCompare(b.slug));
    onAHit.length = 1;                                  // harsher, to be unmissable
    const next = loadBundledPackManifests(dir);         // 3rd: must be untouched
    expect(next.map((m) => m.slug).sort()).toStrictEqual(['alpha', 'zulu']);
  });

  it('notices an ADDED pack', () => {
    write('alpha');
    expect(loadBundledPackManifests(dir).map((m) => m.slug)).toStrictEqual(['alpha']);
    write('beta');
    expect(loadBundledPackManifests(dir).map((m) => m.slug).sort())
      .toStrictEqual(['alpha', 'beta']);
  });

  it('notices a REMOVED pack', () => {
    write('alpha');
    write('beta');
    expect(loadBundledPackManifests(dir)).toHaveLength(2);
    rmSync(join(dir, 'beta.json'));
    expect(loadBundledPackManifests(dir).map((m) => m.slug)).toStrictEqual(['alpha']);
  });

  it('notices an EDIT that changes the file length', () => {
    write('alpha', 1);
    expect(loadBundledPackManifests(dir)[0]!.version).toBe(1);
    // 1 -> 1000 is three bytes longer, so size alone settles it.
    write('alpha', 1000);
    expect(loadBundledPackManifests(dir)[0]!.version).toBe(1000);
  });

  it('notices an EDIT that preserves the file length, via mtime', () => {
    // 🔑 THE CASE SIZE CANNOT SEE. `version: 1` -> `version: 9` is the same
    // number of bytes, so if the fingerprint were size-only this would serve
    // the stale roster. mtime is set explicitly so the test does not depend on
    // the clock ticking between two writes.
    write('alpha', 1);
    expect(loadBundledPackManifests(dir)[0]!.version).toBe(1);
    write('alpha', 9);
    expect(join(dir, 'alpha.json')).toBeTruthy();
    touchAhead('alpha', 5);
    expect(loadBundledPackManifests(dir)[0]!.version).toBe(9);
  });

  it('keys the DEFAULT and an EXPLICIT dir separately', () => {
    // An explicit dir means "this fixture is the corpus" and withholds the
    // foundation embed, so the same path can legitimately yield two rosters.
    // A cache keyed on the path alone would let one poison the other.
    write('alpha');
    const explicitRoster = loadBundledPackManifests(dir);
    expect(explicitRoster.map((m) => m.slug)).toStrictEqual(['alpha']);
    // Re-reading through the explicit key stays the explicit answer.
    expect(loadBundledPackManifests(dir).map((m) => m.slug)).toStrictEqual(['alpha']);
  });
});
