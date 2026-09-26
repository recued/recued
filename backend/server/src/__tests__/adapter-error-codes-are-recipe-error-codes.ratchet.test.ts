/** Every code an adapter throws is a `RecipeErrorCode`.
 *
 *  The step runner keeps an adapter's code only when `ERR` lists it, and codes
 *  every other failure `NETWORK_ERROR`. 205 throw sites, 191 of them
 *  `BAD_INPUT`, threw codes the list did not have, so a refused input reached the
 *  owner as "a network error stopped the request", an MCP caller as
 *  "unavailable, come back later", and an unattended automation as a transient
 *  fault it kept retrying. Found when a mistyped notification channel was logged
 *  as `NETWORK_ERROR` (D-312).
 *
 *  The fix was the list; this keeps it complete: a code that is thrown and not
 *  listed fails here, naming the file, instead of turning into a network error
 *  wherever it lands. */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ERR } from '@recued/contracts';

const ROOT = resolve(import.meta.dirname, '../../../..');
const THROWN = /new IngredientError\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/gu;

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return ['__tests__', 'node_modules', 'dist'].includes(entry.name) ? [] : sourceFiles(path);
    }
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') && !entry.name.endsWith('.test.ts')
      ? [path]
      : [];
  });

describe('every code an adapter throws is a RecipeErrorCode', () => {
  it('⛔ so none reaches an owner or a caller as a network error', () => {
    const roots = [
      ...readdirSync(join(ROOT, 'packages')).map((name) => join(ROOT, 'packages', name, 'src')),
      join(ROOT, 'backend', 'server', 'src'),
    ].filter((dir) => existsSync(dir));
    const firstSeen = new Map<string, string>();
    for (const file of roots.flatMap(sourceFiles)) {
      for (const match of readFileSync(file, 'utf8').matchAll(THROWN)) {
        if (!firstSeen.has(match[1]!)) firstSeen.set(match[1]!, relative(ROOT, file));
      }
    }
    const unlisted = [...firstSeen]
      .filter(([code]) => !Object.hasOwn(ERR, code))
      .map(([code, file]) => `${code} (${file})`);
    expect(unlisted).toEqual([]);
    // 43 distinct codes on 2026-09-25: a scan that found none would pass on nothing.
    expect(firstSeen.size).toBeGreaterThanOrEqual(40);
  });
});
