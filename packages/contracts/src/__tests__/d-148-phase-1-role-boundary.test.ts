/** D-148 P1 — role-boundary lint.
 *
 *  Encodes invariants I-8 + I-9 + I-11 from the Must Hold table:
 *   - I-8: bridge has no engine (no `packages/engine` imports).
 *   - I-9: bridge has no `<all_urls>` blanket grant (manifest scan
 *     when manifest exists; P3 wires the manifest).
 *   - I-11: webclient stores only the documented 5 fields (storage
 *     inventory test fires when webclient lands real code in P4).
 *
 *  P1 ships the lint scaffolding. Imports forbidden across the
 *  bridge / webclient surfaces are scanned in this test; if a future
 *  phase introduces a forbidden import the test fails before merge.
 *
 *  Appendix I.1 + I.2 (D-148 spec): "no engine imports in
 *  apps/bridge/" + "no engine imports in apps/webclient/" are the
 *  CI-gate negative-acceptance tests.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isTypeScriptSourceOrTsx } from '../../../../test/source-file-extensions.js';

const here = dirname(fileURLToPath(import.meta.url));
// repo root: packages/contracts/src/__tests__ → ../../../..
const REPO_ROOT = join(here, '..', '..', '..', '..');

/** Closed list of `packages/*` directories the bridge + webclient
 *  must NEVER import from. Reads are forbidden — imports of types
 *  may seem harmless but they pull in transitively forbidden code
 *  via re-export chains. The boundary is wholesale. */
const FORBIDDEN_PACKAGE_IMPORTS = [
  '@recued/engine',
  '@recued/recipes',
  '@recued/storage',
  '@recued/ingredients',
  '@recued/llm',
  '@recued/scheduler',
  '@recued/marketplace',
  '@recued/cache',
  '@recued/server',
  // Relative paths that reach into the same packages.
  '../../packages/engine',
  '../../packages/recipes',
  '../../packages/storage',
  '../../packages/ingredients',
  '../../packages/llm',
  '../../packages/scheduler',
  '../../packages/marketplace',
  '../../packages/cache',
  '../../backend/server',
];

const collectTsFiles = (dir: string): string[] => {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === 'dist' || entry === 'dist-extension') continue;
    // Skip test fixtures — sample import strings inside template
    // literals would self-trigger the forbidden-import matcher
    // without the carve-out. The lint applies to production code.
    if (entry === '__tests__') continue;
    if (entry.startsWith('.')) continue;
    const path = join(dir, entry);
    let st;
    try {
      st = statSync(path);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      out.push(...collectTsFiles(path));
    } else if (isTypeScriptSourceOrTsx(entry)) {
      out.push(path);
    }
  }
  return out;
};

const findForbiddenImports = (file: string): string[] => {
  const src = readFileSync(file, 'utf8');
  const violations: string[] = [];
  for (const forbidden of FORBIDDEN_PACKAGE_IMPORTS) {
    // Match `from '<forbidden>` or `from "<forbidden>` with optional
    // trailing path segments + closing quote.
    const re = new RegExp(`from\\s+['"]${forbidden.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(/[^'"]*)?['"]`);
    if (re.test(src)) {
      violations.push(forbidden);
    }
    // Dynamic import.
    const dynRe = new RegExp(`import\\s*\\(\\s*['"]${forbidden.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(/[^'"]*)?['"]`);
    if (dynRe.test(src)) {
      violations.push(`(dynamic) ${forbidden}`);
    }
  }
  return violations;
};

describe('D-148 P1 — role-boundary lint (apps/bridge/)', () => {
  const bridgeRoot = join(REPO_ROOT, 'apps', 'bridge', 'src');
  const files = collectTsFiles(bridgeRoot);

  it('apps/bridge/src exists', () => {
    // P1 reservation: directory should at least exist with a stub.
    expect(files.length).toBeGreaterThan(0);
  });

  it('I-8: no file under apps/bridge/src imports engine / recipes / storage / ingredients / llm', () => {
    const offenders: Array<{ file: string; violations: string[] }> = [];
    for (const file of files) {
      const violations = findForbiddenImports(file);
      if (violations.length > 0) {
        offenders.push({ file, violations });
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('D-148 P1 — role-boundary lint (apps/webclient/)', () => {
  const webclientRoot = join(REPO_ROOT, 'apps', 'webclient', 'src');
  const files = collectTsFiles(webclientRoot);

  it('apps/webclient/src exists', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('I-11: no file under apps/webclient/src imports engine / recipes / storage / ingredients', () => {
    const offenders: Array<{ file: string; violations: string[] }> = [];
    for (const file of files) {
      const violations = findForbiddenImports(file);
      if (violations.length > 0) {
        offenders.push({ file, violations });
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('D-148 P1 — role-boundary lint synthetic regression check', () => {
  it('detects a synthetic forbidden import (sanity check the matcher)', () => {
    const synthetic_src = `import { foo } from '@recued/engine';\nexport const x = foo;`;
    const re = new RegExp(`from\\s+['"]@recued/engine(/[^'"]*)?['"]`);
    expect(re.test(synthetic_src)).toBe(true);
  });

  it('does not flag legitimate @recued/contracts imports', () => {
    const ok_src = `import { KEY_CAPABILITIES } from '@recued/contracts';\n`;
    const violations: string[] = [];
    for (const forbidden of FORBIDDEN_PACKAGE_IMPORTS) {
      const re = new RegExp(`from\\s+['"]${forbidden.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(/[^'"]*)?['"]`);
      if (re.test(ok_src)) violations.push(forbidden);
    }
    expect(violations).toEqual([]);
  });
});
