/** D-159 N.7 / I-1 -- engine does not import middleware*.
 *
 *  The deterministic recipe-plan executor (the D-159 N.3 keep-list)
 *  imports nothing from @recued/middleware or @recued/middleware-recued
 *  -- the thin-engine property D-157 P1's preflight checkpoint
 *  depends on.
 *
 *  The scan rejects BOTH forms of a boundary crossing (codex-review
 *  fold): an @recued/middleware* alias specifier, AND a relative
 *  specifier that -- resolved against the importing file -- escapes
 *  into packages/middleware/ or packages/middleware-recued/. A
 *  relative escape violates N.7 just as much as an alias import; a
 *  pure alias-string check would miss it.
 *
 *  Exemption: __tests__/ -- a cross-package test import is normal.
 *  (D-159 P1 relocated ai-webchat/ to @recued/llm and social-graph/
 *  to @recued/social-graph and deleted their D-159 P0 exemptions;
 *  the scan now covers every engine source directory.)
 *
 *  Spec: docs/d-159-spec.md section N.7 + I-1 + A.3. */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const SRC = resolve(__dirname, '..'); // packages/engine/src
const PKGS = resolve(SRC, '..', '..'); // packages/
const MW = join(PKGS, 'middleware') + '/';
const MWR = join(PKGS, 'middleware-recued') + '/';
const SPEC = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g;
const ALIAS = /^@recued\/middleware(-recued)?(\/|$)/;

/** Boundary-crossing specifiers in `txt` for a file located at
 *  `fileDir` -- an @recued/middleware* alias, or a relative path
 *  resolving into packages/middleware*\/. */
const crossings = (txt: string, fileDir: string): string[] => {
  const bad: string[] = [];
  for (const m of txt.matchAll(SPEC)) {
    const s = m[1];
    if (ALIAS.test(s)) {
      bad.push(s);
    } else if (s.startsWith('.')) {
      const r = resolve(fileDir, s.replace(/\.js$/, ''));
      if (r.startsWith(MW) || r.startsWith(MWR)) bad.push(s);
    }
  }
  return bad;
};

const relPath = (p: string): string => {
  const i = p.indexOf('/packages/');
  return i >= 0 ? p.slice(i + 1) : p;
};

/** Every .ts source file under packages/engine/src, recursively --
 *  __tests__/ aside, where a cross-package test import is normal. */
const collect = (dir: string): string[] => {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === '__tests__') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...collect(path));
    else if (name.endsWith('.ts')) out.push(path);
  }
  return out;
};

describe('D-159 N.7 / I-1 -- engine does not import middleware*', () => {
  const files = collect(SRC);

  it('the engine keep-list ships source files', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('no engine keep-list source imports middleware* (alias or relative escape)', () => {
    const offenders = files
      .map((f) => ({ f, bad: crossings(readFileSync(f, 'utf8'), dirname(f)) }))
      .filter((x) => x.bad.length > 0)
      .map((x) => relPath(x.f) + ': ' + x.bad.join(', '));
    expect(offenders).toEqual([]);
  });

  it('synthetic regression -- the scanner catches alias + relative escapes', () => {
    const here = join(SRC, 'adapters'); // a representative engine subdir depth
    expect(crossings("import { x } from '@recued/middleware';", here)).toHaveLength(1);
    expect(crossings("await import('@recued/middleware-recued/confidence-shape/x.js')", here)).toHaveLength(1);
    expect(crossings("import { x } from '../../../middleware/src/orchestrator/x.js';", here)).toHaveLength(1);
    // legitimate imports are not flagged
    expect(crossings("import { x } from '@recued/contracts';", here)).toHaveLength(0);
    expect(crossings("import { x } from '../execute.js';", here)).toHaveLength(0);
  });
});
