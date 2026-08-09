/** Locate the bench seed without naming anyone's local checkout.
 *
 *  ⛔ THE CONSTRAINT THAT SHAPES THIS. The bench seed is a SIBLING CHECKOUT,
 *  not part of this repository, and its directory name is local to the machine
 *  it was cloned on. The public-export scan blocks on an internal reference in
 *  source, so `resolve(REPO, '../internal benchmarks')` cannot ship — that
 *  scrub (b782eae41) was right and is preserved here.
 *
 *  ⚠ WHAT THE SCRUB COST, AND WHAT THIS RESTORES. The neutral replacement
 *  `../bench-seed` does not exist on the machines the seed is actually cloned
 *  on, so every horizon entry point started failing unless the caller knew to
 *  set `HORIZON_SEED_DIR` — a harness that used to need no configuration
 *  suddenly needed one, and said so only after booting far enough to look.
 *
 *  🔑 SO IT DISCOVERS BY CONTENT, NOT BY NAME. A seed is a directory holding
 *  `seed-test.db` + `seed-identity.json`; that is a fact about the seed, not
 *  about anyone's folder naming. Scanning the repo's siblings for that pair
 *  ships no local layout AND needs no configuration, which is what the two
 *  competing goals were actually asking for.
 *
 *  ⚠ ONE LEVEL, NEVER A WALK. Only direct siblings of the repo are considered.
 *  A recursive search would be slower, would wander into `node_modules`, and
 *  would make "which seed did it pick?" genuinely hard to answer.
 *
 *  ⚠ DETERMINISTIC. Candidates are sorted, so two seeds side by side resolve
 *  the same way on every run rather than flipping with directory order. */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** The files that make a directory a bench seed. Content, not name. */
const SEED_MARKERS = ['seed-test.db', 'seed-identity.json'] as const;

/** The neutral fallback the export scrub introduced. Kept as the FIRST place
 *  looked after the env var, so a machine that does adopt the conventional name
 *  resolves without a scan. */
const NEUTRAL_DIR_NAME = 'bench-seed';

export const isSeedDir = (dir: string): boolean => {
  try {
    return SEED_MARKERS.every((marker) => existsSync(join(dir, marker)));
  } catch {
    return false;
  }
};

export interface SeedResolution {
  readonly dir: string | null;
  /** How it was found — reported so a surprising pick is visible rather than
   *  silently assumed. */
  readonly via: 'HORIZON_SEED_DIR' | 'conventional-name' | 'discovered' | 'none';
  /** Every place that was checked, for the failure message. */
  readonly searched: readonly string[];
}

/** Resolve the bench seed. `repoRoot` is the checkout this harness lives in;
 *  its PARENT is where sibling checkouts sit. */
export const resolveSeedDir = (
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): SeedResolution => {
  const searched: string[] = [];

  // 1. An explicit override always wins, and is NOT validated away — if the
  //    caller named a directory, a silent fallback to a different one would be
  //    worse than failing.
  const explicit = env.HORIZON_SEED_DIR;
  if (explicit !== undefined && explicit.length > 0) {
    return { dir: resolve(explicit), via: 'HORIZON_SEED_DIR', searched: [resolve(explicit)] };
  }

  const siblings = resolve(repoRoot, '..');

  // 2. The conventional neutral name, if the machine happens to use it.
  const conventional = join(siblings, NEUTRAL_DIR_NAME);
  searched.push(conventional);
  if (isSeedDir(conventional)) {
    return { dir: conventional, via: 'conventional-name', searched };
  }

  // 3. Discover by content among direct siblings.
  let entries: string[];
  try {
    entries = readdirSync(siblings).sort();
  } catch {
    return { dir: null, via: 'none', searched };
  }
  for (const name of entries) {
    if (name === NEUTRAL_DIR_NAME) continue; // already checked
    const candidate = join(siblings, name);
    try {
      if (!statSync(candidate).isDirectory()) continue;
    } catch {
      continue;
    }
    searched.push(candidate);
    if (isSeedDir(candidate)) return { dir: candidate, via: 'discovered', searched };
  }

  return { dir: null, via: 'none', searched };
};

/** The message printed when no seed is found. Names what it looked for AND
 *  where, because "not found" without either is the failure mode that sends
 *  someone reading source to work out what the harness even wanted. */
export const seedNotFoundMessage = (res: SeedResolution): string =>
  `[horizon] no bench seed found.\n`
  + `          A seed is a directory containing ${SEED_MARKERS.join(' + ')}.\n`
  + `          Looked in:\n`
  + res.searched.map((p) => `            ${p}\n`).join('')
  + `          Set HORIZON_SEED_DIR to point at it.`;
