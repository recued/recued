/** Ratchet — the six `RECUED_*` OAuth env vars stay deleted.
 *
 *  `RECUED_{GMAIL,GCAL,GRAPH}_CLIENT_ID` / `_SECRET` were a second credential
 *  path behind the encrypted `OAuthAppConfigStore`. They were deleted
 *  2026-07-28 because they:
 *
 *    · widened the secret's exposure surface — a plaintext copy in the process
 *      env, readable via `ps eww`, `/proc/<pid>/environ`, shell history,
 *      `docker inspect`;
 *    · IGNORED the vault lock, where the store path refuses with `locked` (423);
 *    · gave one global env pair per issuer while the store models credentials
 *      per issuer properly.
 *
 *  Nothing enforces that they stay gone. Re-adding `process.env.RECUED_GMAIL_
 *  CLIENT_ID` to a provider const would typecheck, pass every unit test, and
 *  silently restore all three problems — the store-first precedence means the
 *  fallback is INVISIBLE on any server that has stored credentials, so it would
 *  reach production unnoticed. This file is the thing that notices.
 *
 *  It matches on the READ (`process.env.<VAR>`), not the bare var name, so the
 *  comments that document the deletion — which necessarily quote the names —
 *  do not trip it. */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = fileURLToPath(new URL('.', import.meta.url));
/** Repo root — `backend/server/src/__tests__` → up four. */
const REPO_ROOT = join(HERE, '..', '..', '..', '..');

const SCANNED_ROOTS = [
  join(REPO_ROOT, 'backend', 'server', 'src'),
  join(REPO_ROOT, 'packages'),
  join(REPO_ROOT, 'apps', 'webclient', 'src'),
  join(REPO_ROOT, 'apps', 'bridge'),
];

const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'dist-bench', 'build', 'coverage', '.svelte-kit', '.git',
]);

const DELETED_VARS = [
  'RECUED_GMAIL_CLIENT_ID',
  'RECUED_GMAIL_CLIENT_SECRET',
  'RECUED_GCAL_CLIENT_ID',
  'RECUED_GCAL_CLIENT_SECRET',
  'RECUED_GRAPH_CLIENT_ID',
  'RECUED_GRAPH_CLIENT_SECRET',
] as const;

/** `process.env.VAR`, `process.env['VAR']`, `process.env["VAR"]` — the forms an
 *  actual read takes. A doc comment naming the var alone does not match. */
const readPatternFor = (v: string): RegExp =>
  new RegExp(String.raw`process\s*\.\s*env\s*(?:\.\s*${v}\b|\[\s*['"\`]${v}['"\`]\s*\])`);

const sourceFiles = (dir: string): string[] => {
  const out: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // an optional root (e.g. apps/bridge) may not exist
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...sourceFiles(join(dir, entry.name)));
    } else if (/\.(ts|tsx|js|mjs|cjs|svelte)$/.test(entry.name)) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
};

describe('RECUED_* OAuth env vars stay deleted', () => {
  const files = SCANNED_ROOTS.flatMap(sourceFiles);

  it('scans a non-empty file set (guards the ratchet against passing vacuously)', () => {
    // Without this, a broken path or an over-broad skip list turns every
    // assertion below into "0 files had the pattern" — a green that proves
    // nothing. Floor is a literal, not derived from the scan.
    expect(files.length).toBeGreaterThan(500);
    expect(files.some((f) => f.endsWith(join('collections', 'mail', 'gmail-provider.ts')))).toBe(true);
    expect(files.some((f) => f.endsWith(join('collections', 'calendar', 'gcal-provider.ts')))).toBe(true);
  });

  it.each(DELETED_VARS)('no source file reads process.env.%s', (varName) => {
    const pattern = readPatternFor(varName);
    const offenders = files
      .filter((f) => pattern.test(readFileSync(f, 'utf8')))
      .map((f) => relative(REPO_ROOT, f));
    expect(offenders).toEqual([]);
  });

  it('the read pattern actually matches a read (proves the assertions can fail)', () => {
    // The inverse witness. Without it, a typo in `readPatternFor` would make
    // every case above pass against any input at all.
    //
    // ⚠ The witnesses are CONCATENATED, never written literally. Spelled out,
    // this file would itself match the scan above — and the fix for that must
    // NOT be to exclude this path from `SCANNED_ROOTS`, because a real re-added
    // read placed here would then be exempt too. Verified empirically: the
    // first version of this file DID spell them out and the scan failed on it,
    // naming this file — so the assertions above are known to be able to fail,
    // not merely assumed to be.
    const ENV = `process${'.'}env`;
    const VAR = `RECUED_GMAIL${'_CLIENT_ID'}`;
    const pattern = readPatternFor(VAR);
    expect(pattern.test(`clientId: ${ENV}.${VAR} ?? ''`)).toBe(true);
    expect(pattern.test(`const x = ${ENV}['${VAR}'];`)).toBe(true);
    // ...and does NOT match prose that merely names the var, which is what the
    // deletion's own doc comments do throughout the tree.
    expect(pattern.test(`\`clientId\` was read from \`${VAR}\` / \`_SECRET\`.`)).toBe(false);
  });
});
