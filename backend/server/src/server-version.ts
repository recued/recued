/** Single source for the recued-server version.
 *
 *  Both the CLI router (`bin.ts` — `--version` + the archive/update profiles)
 *  and the running server (`serve-entry.ts` — the version reported on
 *  `ServerStatus` + the boot banner + the archive `min_consumer_version` check
 *  at restore) need it, and they used to each declare their own copy — which
 *  drifted (a fix to one missed the other). Keep it here so they can't.
 *
 *  Versioning is CALENDAR-BASED semver `yy.m.d` in Pacific time (e.g. `26.7.3`),
 *  bumped in package.json per release (at most one release/day, so the date is a
 *  unique version). No leading zeros — `26.7.3`, not `26.07.03` — so it stays
 *  VALID semver (npm + the archive/release comparators, which split on '.' and
 *  parse ints, both accept it). package.json is the single source: the Docker
 *  image tag, the homebrew formula, and this runtime version all read it.
 *
 *  Resolution: the build bakes `__RECUED_SERVER_VERSION__` (esbuild define, from
 *  package.json). An UNBUILT `tsx` run has no define, so read
 *  backend/server/package.json directly — the SAME source the build reads.
 *  `npm_package_version` is NOT reliable: `npx tsx bin.ts` from the monorepo
 *  root sets it to the ROOT package's `0.0.0`, not ours (which made the pre-pair
 *  restore commit reject with `ARCHIVE_FUTURE_VERSION` in dev). The
 *  package.json read is dead code in a built bundle (the define wins). */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

declare const __RECUED_SERVER_VERSION__: string | undefined;

const versionFromPackageJson = (): string | null => {
  try {
    // `import.meta.url` is undefined in the CJS/SEA bundle (esbuild replaces
    // `import.meta` with `{}`), which would make this throw into the catch and
    // silently report no version. The build-time define normally wins before we
    // get here; `__filename` keeps the FALLBACK honest rather than dead.
    const self = import.meta.url ? fileURLToPath(import.meta.url) : __filename;
    const pkgPath = join(dirname(self), '..', 'package.json');
    const version = (JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: unknown }).version;
    return typeof version === 'string' && version.length > 0 ? version : null;
  } catch {
    return null;
  }
};

export const SERVER_VERSION: string =
  typeof __RECUED_SERVER_VERSION__ !== 'undefined'
    ? __RECUED_SERVER_VERSION__
    : versionFromPackageJson() ?? process.env.npm_package_version ?? '0.0.0';
