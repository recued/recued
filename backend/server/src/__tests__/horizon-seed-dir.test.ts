/** The bench seed is found by CONTENT, so no local layout ships in the source.
 *
 *  ⛔ THE TWO GOALS THAT COLLIDED. The seed is a sibling checkout, not part of
 *  this repository, and its directory name is local to the machine it was
 *  cloned on — so hardcoding `resolve(REPO, '../<that-repo>')` blocks the
 *  public export's internal-reference scan. The scrub replaced it with a
 *  neutral `../bench-seed`, which exists on no machine the seed is actually
 *  cloned on: every horizon entry point then failed unless the caller knew to
 *  set `HORIZON_SEED_DIR`. A harness that needed no configuration suddenly
 *  needed one, and only said so after booting far enough to look.
 *
 *  🔑 Discovering by MARKER FILES satisfies both: a seed is a directory holding
 *  `seed-test.db` + `seed-identity.json`, which is a fact about the seed rather
 *  than about anyone's folder naming.
 *
 *  ⚠ The internal-name check at the bottom is the ratchet the export scan would
 *  otherwise catch later, at release time. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  isSeedDir,
  resolveSeedDir,
  seedNotFoundMessage,
} from '../../scripts/horizon-audit/seed-dir.js';

const dirs: string[] = [];
afterEach(() => { while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true }); });

/** A world: `<root>/repo` plus whatever siblings the case needs. */
const world = (siblings: Record<string, 'seed' | 'empty'>) => {
  const root = mkdtempSync(join(tmpdir(), 'seed-dir-'));
  dirs.push(root);
  const repo = join(root, 'repo');
  mkdirSync(repo);
  for (const [name, kind] of Object.entries(siblings)) {
    const dir = join(root, name);
    mkdirSync(dir);
    if (kind === 'seed') {
      writeFileSync(join(dir, 'seed-test.db'), '');
      writeFileSync(join(dir, 'seed-identity.json'), '{}');
    }
  }
  return { root, repo };
};

describe('horizon bench-seed resolution', () => {
  it('⛔ finds a seed whose directory has a LOCAL name', () => {
    // The case the scrub broke: the seed is not called `bench-seed` and no env
    // var is set.
    // ⚠ Any non-standard name proves this; the private sibling repo's actual
    // name is incidental and must not ship (the export's internal-reference
    // scan blocks it, and widening the scrub would be the wrong fix).
    const { repo, root } = world({ 'some-local-bench': 'seed', other: 'empty' });
    const res = resolveSeedDir(repo, {});
    expect(res.dir).toBe(join(root, 'some-local-bench'));
    expect(res.via).toBe('discovered');
  });

  it('prefers the conventional neutral name without scanning', () => {
    const { repo, root } = world({ 'bench-seed': 'seed', 'other-seed': 'seed' });
    const res = resolveSeedDir(repo, {});
    expect(res.dir).toBe(join(root, 'bench-seed'));
    expect(res.via).toBe('conventional-name');
  });

  it('⛔ an explicit HORIZON_SEED_DIR always wins, even if it is wrong', () => {
    // Deliberate: if the caller named a directory, silently resolving a
    // DIFFERENT one is worse than failing. The harness would otherwise audit a
    // seed nobody asked for and report it as the requested run.
    const { repo, root } = world({ 'bench-seed': 'seed' });
    const res = resolveSeedDir(repo, { HORIZON_SEED_DIR: join(root, 'nope') });
    expect(res.dir).toBe(join(root, 'nope'));
    expect(res.via).toBe('HORIZON_SEED_DIR');
  });

  it('is DETERMINISTIC when two seeds sit side by side', () => {
    // Directory order is not stable across filesystems; flipping between two
    // seeds run to run would make a result impossible to reproduce.
    const { repo, root } = world({ 'zz-seed': 'seed', 'aa-seed': 'seed' });
    expect(resolveSeedDir(repo, {}).dir).toBe(join(root, 'aa-seed'));
    expect(resolveSeedDir(repo, {}).dir).toBe(resolveSeedDir(repo, {}).dir);
  });

  it('⛔ reports NOT FOUND with what it wanted and where it looked', () => {
    // "not found" without either is what sends someone reading source to work
    // out what the harness even wanted.
    const { repo } = world({ other: 'empty', 'also-not-a-seed': 'empty' });
    const res = resolveSeedDir(repo, {});
    expect(res.dir).toBeNull();
    const msg = seedNotFoundMessage(res);
    expect(msg).toContain('seed-test.db');
    expect(msg).toContain('seed-identity.json');
    expect(msg).toContain('HORIZON_SEED_DIR');
    expect(msg).toContain('also-not-a-seed');   // it says WHERE it looked
  });

  it('a partial seed is not a seed', () => {
    const { root, repo } = world({ half: 'empty' });
    writeFileSync(join(root, 'half', 'seed-test.db'), '');
    expect(isSeedDir(join(root, 'half'))).toBe(false);
    expect(resolveSeedDir(repo, {}).dir).toBeNull();
  });

  it('⛔ RATCHET: no horizon-audit source names the private sibling checkout', () => {
    // What the public-export scan blocks on. Catching it here means a release
    // is not the first time anyone hears about it.
    const fs = require('node:fs') as typeof import('node:fs');
    const path = require('node:path') as typeof import('node:path');
    const dir = new URL('../../scripts/horizon-audit/', import.meta.url).pathname;
    const offenders: string[] = [];
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.ts')) continue;
      const src = fs.readFileSync(path.join(dir, name), 'utf8');
      // The one exception is THIS rule's own explanation, which has to be able
      // to say what it forbids.
      // Assembled, not written: a guard that spells out the forbidden string
      // would be caught by the very scan it exists to support.
      const FORBIDDEN = ['recued', 'substrate', 'bench'].join('-');
      if (src.includes(FORBIDDEN) && name !== 'seed-dir.ts') {
        offenders.push(name);
      }
    }
    expect(offenders).toEqual([]);
  });
});
