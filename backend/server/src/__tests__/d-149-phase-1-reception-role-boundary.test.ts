/** D-149 P1 — Reception role-boundary lint.
 *
 *  Encodes Must Hold I-3 (no Pro-gating creep) + Must Hold I-12 (no
 *  engine code at request thread) by scanning every TypeScript file
 *  under `backend/server/src/ports/reception/` for forbidden imports
 *  + forbidden token references. Per spec § Validators line 2204-2206
 *  + Trap Register TR-3 + TR-10 the lint runs at every PR touching
 *  the reception substrate; this file is the executable form.
 *
 *  Forbidden imports: any path that pulls in `packages/engine/` or
 *  `packages/recipes/` (transitive engine surface — even type-only
 *  imports are wholesale forbidden because re-export chains pull
 *  forbidden code in by reference).
 *
 *  Forbidden tokens: `entitlements.` and `pro_tier.` references.
 *  Reception code paths cannot consult Pro entitlement state — the
 *  substrate is hostname-agnostic; a free user with BYO DDNS + own
 *  certbot ships the same Reception capabilities as a Pro user with
 *  `<handle>.recued.cloud` + ACME-DNS-01.
 *
 *  Test failures here mean a future PR has introduced a violation.
 *  Fix the import / token reference at the source; do NOT widen the
 *  forbidden list (that would dilute the contract). */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isTypeScriptSourceOrTsx } from '../../../../test/source-file-extensions.js';

const RECEPTION_ROOT = resolve(__dirname, '..', 'ports', 'reception');

/** Closed list of `packages/*` directories Reception MUST NOT import.
 *  Per Must Hold I-12 reception handlers do NOT call engine code in
 *  the request thread — visitor writes persist to the per-row
 *  reception tables and reactive triggers (D-115) fire engine
 *  reaction async. The wholesale ban catches type-only imports too
 *  because re-export chains can transit forbidden code. */
const FORBIDDEN_PACKAGE_IMPORTS = [
  '@recued/engine',
  '@recued/recipes',
  // Relative paths for in-tree Reception code.
  '../../packages/engine',
  '../../packages/recipes',
  '../../../packages/engine',
  '../../../packages/recipes',
] as const;

/** Closed list of forbidden source-text patterns. Must Hold I-3 +
 *  Trap Register TR-10. The substrate is hostname-agnostic; reception
 *  code paths MUST NOT reference the Pro entitlement registry or
 *  consult Pro tier state. */
const FORBIDDEN_TOKEN_PATTERNS = [
  /\bentitlements\./,
  /\bpro_tier\./,
] as const;

const collectTsFiles = (dir: string): string[] => {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === 'dist') continue;
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
    const escaped = forbidden.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`from\\s+['"]${escaped}(/[^'"]*)?['"]`);
    if (re.test(src)) violations.push(forbidden);
    const dynRe = new RegExp(`import\\s*\\(\\s*['"]${escaped}(/[^'"]*)?['"]`);
    if (dynRe.test(src)) violations.push(`(dynamic) ${forbidden}`);
  }
  return violations;
};

const findForbiddenTokens = (file: string): string[] => {
  const src = readFileSync(file, 'utf8');
  const violations: string[] = [];
  for (const re of FORBIDDEN_TOKEN_PATTERNS) {
    if (re.test(src)) violations.push(re.source);
  }
  return violations;
};

describe('D-149 P1 — Reception role-boundary lint (Must Hold I-12)', () => {
  const files = collectTsFiles(RECEPTION_ROOT);

  it('Reception substrate exists and ships at least one source file', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('no Reception file imports packages/engine or packages/recipes', () => {
    const offenders: Array<{ file: string; violations: string[] }> = [];
    for (const file of files) {
      const v = findForbiddenImports(file);
      if (v.length > 0) offenders.push({ file, violations: v });
    }
    expect(offenders).toEqual([]);
  });
});

describe('D-149 P1 — Reception no-Pro-gating grep (Must Hold I-3 + TR-10)', () => {
  const files = collectTsFiles(RECEPTION_ROOT);

  it('no Reception file references entitlements.* or pro_tier.*', () => {
    const offenders: Array<{ file: string; violations: string[] }> = [];
    for (const file of files) {
      const v = findForbiddenTokens(file);
      if (v.length > 0) offenders.push({ file, violations: v });
    }
    expect(offenders).toEqual([]);
  });
});

describe('D-149 P1 — Reception lint synthetic-regression sanity', () => {
  it('forbidden-import matcher catches a synthetic engine import', () => {
    const synthetic = `import { foo } from '@recued/engine';\nexport const x = foo;`;
    const re = new RegExp(`from\\s+['"]@recued/engine(/[^'"]*)?['"]`);
    expect(re.test(synthetic)).toBe(true);
  });

  it('forbidden-token matcher catches a synthetic entitlements reference', () => {
    const synthetic = `if (entitlements.pro) { /* ... */ }`;
    expect(/\bentitlements\./.test(synthetic)).toBe(true);
  });

  it('does not flag legitimate @recued/contracts imports', () => {
    const ok = `import { writeJson } from '../common/respond.js';`;
    for (const forbidden of FORBIDDEN_PACKAGE_IMPORTS) {
      const escaped = forbidden.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`from\\s+['"]${escaped}(/[^'"]*)?['"]`);
      expect(re.test(ok)).toBe(false);
    }
  });
});
