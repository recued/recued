/** D-148 § A.4 — webclient role-boundary lint.
 *
 *  The webclient is forbidden from importing engine code (recipes,
 *  storage, cache, scheduler, marketplace). The lint test scans every
 *  source file under `apps/webclient/src/` and asserts no import
 *  statement targets one of the forbidden prefixes.
 *
 *  This module ships the scanner. The actual test that fails the
 *  build lives at `__tests__/role-boundary.test.ts` and uses the
 *  `node:fs` recursion helper to enumerate the directory; the
 *  scanner here is pure (string → findings) so the test logic stays
 *  tiny.
 */

import { WEBCLIENT_FORBIDDEN_IMPORT_PREFIXES } from '@recued/contracts';

export interface ForbiddenImportFinding {
  file_path: string;
  line: number;
  imported: string;
  forbidden_prefix: string;
}

/** Extract every `import ... from '...'` and `import('...')` target
 *  from a TypeScript source. Tolerant: comments + string literals
 *  inside template literals don't fool the scanner because we match
 *  the strict `from '...'` / `from "..."` shape (and the dynamic
 *  `import('...')` form).
 *
 *  Codex P3 #3 fold — additionally scans:
 *   - Triple-slash references (`/// <reference path="..." />` +
 *     `/// <reference types="..." />`) — TS-specific cross-package
 *     reach that bypasses the `from` matcher.
 *   - `require('y')` / `require.resolve('y')` — Node-style imports
 *     (rare in this codebase but trivial to add). */
export const collectWebclientImports = (source: string): Array<{ line: number; imported: string }> => {
  const out: Array<{ line: number; imported: string }> = [];
  const lines = source.split('\n');
  // `from 'x'` or `from "x"` — covers `import x from 'y'`,
  // `import { x } from 'y'`, `import 'y'`, `export ... from 'y'`.
  const fromRe = /from\s+['"]([^'"]+)['"]/g;
  // Bare `import 'y'` (side-effect import) — distinct from the
  // `from` form above.
  const sideEffectRe = /^\s*import\s+['"]([^'"]+)['"]/;
  // Dynamic `import('y')`.
  const dynRe = /import\(\s*['"]([^'"]+)['"]\s*\)/g;
  // Module declarations (`declare module 'x'`) — also scan.
  const declareRe = /declare\s+module\s+['"]([^'"]+)['"]/g;
  // TS triple-slash reference (Codex P3 #3 fold).
  const tripleSlashRe = /^\s*\/\/\/\s*<reference\s+(?:path|types)\s*=\s*['"]([^'"]+)['"]/;
  // Node-style require — rare here but we close the surface for
  // forward compat (Codex P3 #3 fold).
  const requireRe = /\brequire(?:\.resolve)?\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (let i = 0; i < lines.length; i++) {
    const ln = i + 1;
    const text = lines[i];
    let m: RegExpExecArray | null;
    fromRe.lastIndex = 0;
    while ((m = fromRe.exec(text)) !== null) {
      out.push({ line: ln, imported: m[1] });
    }
    const se = sideEffectRe.exec(text);
    if (se) out.push({ line: ln, imported: se[1] });
    dynRe.lastIndex = 0;
    while ((m = dynRe.exec(text)) !== null) {
      out.push({ line: ln, imported: m[1] });
    }
    declareRe.lastIndex = 0;
    while ((m = declareRe.exec(text)) !== null) {
      out.push({ line: ln, imported: m[1] });
    }
    const ts = tripleSlashRe.exec(text);
    if (ts) out.push({ line: ln, imported: ts[1] });
    requireRe.lastIndex = 0;
    while ((m = requireRe.exec(text)) !== null) {
      out.push({ line: ln, imported: m[1] });
    }
  }
  return out;
};

/** Codex P3 #3 fold — relative paths that reach into forbidden
 *  packages. The package-prefix matcher only catches `@recued/<x>`;
 *  a relative `../../packages/engine` targets the same code through
 *  a different shape and would otherwise bypass the gate. The list
 *  mirrors the package prefixes minus the `@recued/` segment. */
const FORBIDDEN_RELATIVE_TARGETS: ReadonlyArray<string> = [
  'packages/engine',
  'packages/recipes',
  'packages/storage',
  'packages/cache',
  'packages/scheduler',
  'packages/marketplace',
  'backend/server',
] as const;

const containsForbiddenRelativeTarget = (imported: string): string | null => {
  // Normalize `../../packages/engine/...` regardless of leading ../
  // depth.
  const normalized = imported.replace(/^(?:\.{1,2}\/)+/, '');
  for (const target of FORBIDDEN_RELATIVE_TARGETS) {
    if (normalized === target || normalized.startsWith(target + '/')) {
      return target;
    }
  }
  return null;
};

/** Apply the forbidden-prefix gate. Returns one finding per
 *  violating import. The gate matches against the literal
 *  `@recued/<package>` prefix; relative imports (`../`,`./`) are
 *  ignored since the webclient internal structure is allowed to
 *  reach across its own subdirectories.
 *
 *  Special-case: the lint gate itself imports `WEBCLIENT_FORBIDDEN_IMPORT_PREFIXES`
 *  from `@recued/contracts`; the contracts package is not in the
 *  forbidden list. Any unrelated import that starts with `@recued/`
 *  but isn't in the forbidden list (e.g. `@recued/contracts`,
 *  `@recued/crypto`, `@recued/ui-shared`) passes. */
export const scanForForbiddenImports = (
  file_path: string,
  source: string,
): ForbiddenImportFinding[] => {
  const imports = collectWebclientImports(source);
  const findings: ForbiddenImportFinding[] = [];
  for (const { line, imported } of imports) {
    // Codex P3 #3 fold — relative path that reaches into a forbidden
    // package directory. Without this, a relative
    // `../../packages/engine` would silently bypass the `@recued/...`
    // prefix gate.
    if (imported.startsWith('.') || imported.startsWith('/')) {
      const rel = containsForbiddenRelativeTarget(imported);
      if (rel) {
        findings.push({
          file_path,
          line,
          imported,
          forbidden_prefix: rel,
        });
      }
      continue;
    }
    for (const prefix of WEBCLIENT_FORBIDDEN_IMPORT_PREFIXES) {
      if (
        imported === prefix ||
        imported.startsWith(prefix + '/')
      ) {
        findings.push({ file_path, line, imported, forbidden_prefix: prefix });
        break;
      }
    }
  }
  return findings;
};
