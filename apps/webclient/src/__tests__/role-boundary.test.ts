/** D-148 P4 — webclient role-boundary lint.
 *
 *  Scans every TS file under `apps/webclient/src/` and asserts:
 *
 *    - No imports against `@recued/engine`, `@recued/recipes`,
 *      `@recued/storage`, `@recued/cache`, `@recued/scheduler`, or
 *      `@recued/marketplace`.
 *
 *  This is the load-bearing acceptance criterion from § P4 line 2125
 *  ("No durable engine code at webclient — lint test scans
 *  apps/webclient/ for imports of packages/engine"). */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WEBCLIENT_FORBIDDEN_IMPORT_PREFIXES } from '@recued/contracts';
import {
  collectWebclientImports,
  scanForForbiddenImports,
} from '../role-boundary/lint.js';
import { isTypeScriptSource } from '../../../../test/source-file-extensions.js';

const SRC_ROOT = join(__dirname, '..');

const walk = (dir: string): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    // Skip the test directory — its files contain sample import
    // strings as test fixtures + would otherwise self-flag the lint
    // scanner. The role-boundary rule applies to source code, not
    // test fixtures.
    if (entry === '__tests__') continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...walk(full));
    } else if (isTypeScriptSource(entry)) {
      out.push(full);
    }
  }
  return out;
};

describe('D-148 P4 — webclient role-boundary lint', () => {
  it('forbidden prefix list matches the contract surface', () => {
    expect([...WEBCLIENT_FORBIDDEN_IMPORT_PREFIXES].sort()).toEqual([
      '@recued/cache',
      '@recued/engine',
      '@recued/marketplace',
      '@recued/recipes',
      '@recued/scheduler',
      '@recued/storage',
    ]);
  });

  it('collectWebclientImports finds every import shape', () => {
    const imports = collectWebclientImports(`
      import { foo } from 'a';
      import 'side-effect';
      import("dynamic");
      const x = await import('also-dynamic');
      export { y } from 'reexport';
      declare module 'augment-me';
      /// <reference path="ref.d.ts" />
      /// <reference types="ref-types" />
      const r = require('lodash');
      const r2 = require.resolve('chalk');
    `);
    const targets = imports.map((i) => i.imported);
    expect(targets).toContain('a');
    expect(targets).toContain('side-effect');
    expect(targets).toContain('dynamic');
    expect(targets).toContain('also-dynamic');
    expect(targets).toContain('reexport');
    expect(targets).toContain('augment-me');
    expect(targets).toContain('ref.d.ts');
    expect(targets).toContain('ref-types');
    expect(targets).toContain('lodash');
    expect(targets).toContain('chalk');
  });

  it('scanForForbiddenImports flags violations', () => {
    const findings = scanForForbiddenImports(
      'demo.ts',
      `import { x } from '@recued/engine';
       import 'recipes';
       import { y } from '@recued/recipes/sub';`,
    );
    const flagged = findings.map((f) => f.imported);
    expect(flagged).toContain('@recued/engine');
    expect(flagged).toContain('@recued/recipes/sub');
  });

  it('Codex P3 #3 fold — scanner flags relative paths into forbidden packages', () => {
    const findings = scanForForbiddenImports(
      'demo.ts',
      `import { run } from '../../packages/engine/src/run';
       import { CACHE } from '../../packages/cache';
       import { ok } from '../local-helper';`,
    );
    const flagged = findings.map((f) => f.imported).sort();
    expect(flagged).toContain('../../packages/engine/src/run');
    expect(flagged).toContain('../../packages/cache');
    expect(flagged).not.toContain('../local-helper');
  });

  it('Codex P3 #3 fold — scanner flags triple-slash references into forbidden packages', () => {
    const findings = scanForForbiddenImports(
      'demo.ts',
      `/// <reference types="@recued/engine" />
       /// <reference path="../../packages/storage/dist/index.d.ts" />`,
    );
    const flagged = findings.map((f) => f.imported);
    expect(flagged).toContain('@recued/engine');
    expect(flagged).toContain('../../packages/storage/dist/index.d.ts');
  });

  it('no source file under apps/webclient/src reaches into forbidden packages', () => {
    const files = walk(SRC_ROOT);
    const findings: Array<{ file: string; imported: string }> = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      const hits = scanForForbiddenImports(relative(SRC_ROOT, file), source);
      findings.push(...hits.map((h) => ({ file: h.file_path, imported: h.imported })));
    }
    expect(findings).toEqual([]);
  });
});
