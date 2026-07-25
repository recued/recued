/** D-159 N.7 / I-2 -- middleware does not import middleware-recued.
 *
 *  @recued/middleware is the stream-middleware *framework* (D-160).
 *  It MUST NOT import @recued/middleware-recued -- a framework never
 *  imports a middleware bundle. The allowed direction is the reverse:
 *  middleware-recued -> middleware.
 *
 *  The scan rejects BOTH forms of a crossing (codex-review fold): an
 *  @recued/middleware-recued alias specifier, AND a relative
 *  specifier that -- resolved against the importing file -- escapes
 *  into packages/middleware-recued/.
 *
 *  __tests__/ is exempt -- a cross-package test import is normal; the
 *  ratchet targets shipped framework source.
 *
 *  Spec: D-159 section N.7 + I-2 + A.3. */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { isTypeScriptSource } from '../../../../test/source-file-extensions.js';

const SRC = resolve(__dirname, '..'); // packages/middleware/src
const PKGS = resolve(SRC, '..', '..'); // packages/
const MWR = join(PKGS, 'middleware-recued') + '/';
const SPEC = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g;
const ALIAS = /^@recued\/middleware-recued(\/|$)/;

/** Boundary-crossing specifiers in `txt` for a file located at
 *  `fileDir` -- an @recued/middleware-recued alias, or a relative
 *  path resolving into packages/middleware-recued/. */
const crossings = (txt: string, fileDir: string): string[] => {
  const bad: string[] = [];
  for (const m of txt.matchAll(SPEC)) {
    const s = m[1];
    if (ALIAS.test(s)) {
      bad.push(s);
    } else if (s.startsWith('.')) {
      const r = resolve(fileDir, s.replace(/\.js$/, ''));
      if (r.startsWith(MWR)) bad.push(s);
    }
  }
  return bad;
};

const relPath = (p: string): string => {
  const i = p.indexOf('/packages/');
  return i >= 0 ? p.slice(i + 1) : p;
};

const collect = (dir: string): string[] => {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === '__tests__') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...collect(path));
    else if (isTypeScriptSource(name)) out.push(path);
  }
  return out;
};

describe('D-159 N.7 / I-2 -- middleware does not import middleware-recued', () => {
  const files = collect(SRC);

  it('the middleware framework ships source files', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('no middleware framework source imports middleware-recued (alias or relative escape)', () => {
    const offenders = files
      .map((f) => ({ f, bad: crossings(readFileSync(f, 'utf8'), dirname(f)) }))
      .filter((x) => x.bad.length > 0)
      .map((x) => relPath(x.f) + ': ' + x.bad.join(', '));
    expect(offenders).toEqual([]);
  });

  it('synthetic regression -- the scanner catches alias + relative escapes', () => {
    const here = join(SRC, 'orchestrator'); // a representative framework subdir
    expect(crossings("import { x } from '@recued/middleware-recued';", here)).toHaveLength(1);
    expect(crossings("import { x } from '../../../middleware-recued/src/confidence-shape/x.js';", here)).toHaveLength(1);
    // legitimate imports are not flagged
    expect(crossings("import { x } from '@recued/middleware';", here)).toHaveLength(0);
    expect(crossings("import { x } from '@recued/contracts';", here)).toHaveLength(0);
    expect(crossings("import { x } from '../primitives/registry.js';", here)).toHaveLength(0);
  });
});
