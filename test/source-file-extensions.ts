/** One answer to "is this file TypeScript production source?", for the
 *  ratchets that walk a source tree.
 *
 *  ── Why it is shared ────────────────────────────────────────────────
 *  Twenty ratchets across `packages/`, `apps/` and `backend/` each walk a
 *  source tree looking for a forbidden reference, and each had written its
 *  own filter — `name.endsWith('.ts')`, with small drift about `.d.ts` and
 *  `.tsx`. A guard that decides *what it looks at* by a copied predicate
 *  fails open when the predicate falls behind: the file it skips is exactly
 *  the file nobody is checking.
 *
 *  That already happened once. `scripts/export-recued-archive.mts` — tracked,
 *  shipped, invoked from a runbook — sat outside the D-212 ratchets' reach
 *  purely because it ends in `.mts`, and the fix for those two walks
 *  (`backend/server/src/__tests__/d-212-production-source.ts`) is where this
 *  list comes from. This module is that fix applied to the rest, so the next
 *  `.mts` cannot quietly exempt itself from twenty guards at once.
 *
 *  ⛔ `.mts` / `.cts` belong here for a reason, not for completeness: a
 *  module-system-explicit extension is a normal thing for a script or an ESM
 *  entry point to have, and nothing about it makes the file less production.
 *
 *  ⚠ This decides EXTENSIONS only. Each ratchet keeps its own root and its
 *  own directory skips — those encode what that guard is about, and unifying
 *  them would change what each one covers. */

/** Every extension TypeScript production source is written in. */
export const SOURCE_EXTENSIONS = ['.ts', '.mts', '.cts'] as const;

/** Declaration output. Never production source — it is generated, and it
 *  restates what the source already said. */
const DECLARATION_SUFFIXES = ['.d.ts', '.d.mts', '.d.cts'] as const;

/** True for a TypeScript source file, false for declaration output.
 *
 *  Takes a file NAME or a full path — the check is suffix-only, so both
 *  work, and a caller that already has a path need not basename it. */
export const isTypeScriptSource = (nameOrPath: string): boolean => {
  if (DECLARATION_SUFFIXES.some((suffix) => nameOrPath.endsWith(suffix))) return false;
  return SOURCE_EXTENSIONS.some((ext) => nameOrPath.endsWith(ext));
};

/** As `isTypeScriptSource`, plus `.tsx`.
 *
 *  ⚠ There is no `.tsx` in this repo today. The one walk that accepted it
 *  keeps accepting it — removing the branch would be a silent narrowing of
 *  what that ratchet covers, decided by a helper rather than by its author. */
export const isTypeScriptSourceOrTsx = (nameOrPath: string): boolean =>
  isTypeScriptSource(nameOrPath) || nameOrPath.endsWith('.tsx');
