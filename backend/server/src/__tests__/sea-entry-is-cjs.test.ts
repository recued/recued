/** D-178 S1 rev 2 item 0a — the SEA entry must be CommonJS, and `bin.js` must not.
 *
 *  ── Why this exists ───────────────────────────────────────────────
 *  Node's SEA embedder runs the blob through `embedderRunCjs`. Pointed at the
 *  ESM `dist/bin.js`, `build-binary.mjs` produced a 132 MB binary that died on
 *  its FIRST LINE — `Cannot use import statement outside a module` — while
 *  printing a sha256 and exiting 0. Nothing in the suite saw it, because
 *  nothing executed the artifact.
 *
 *  The obvious fix — flip `build.mjs` to `format: 'cjs'` — is WRONG and this
 *  file guards that direction too. `backend/server/package.json` declares
 *  `"type": "module"`, so a CJS `dist/bin.js` is parsed as ESM by every normal
 *  run: `node dist/bin.js`, the npm `bin` link, and the `:managed` image's seed
 *  shim. The two consumers need two artifacts, and BOTH directions of getting
 *  that wrong are a released binary that cannot start.
 *
 *  ⚠ Reads the build scripts as TEXT, like `build-externals-declared.test.ts`:
 *  they are build scripts, not modules that export their config, and importing
 *  them would run a build. If either declaration is reshaped, these parses must
 *  be updated with it.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const readScript = (name: string): string =>
  readFileSync(join(PKG_ROOT, 'scripts', name), 'utf8');

describe('D-178 SEA entry module format', () => {
  it('build-binary.mjs targets bin.cjs, NOT the ESM bin.js', () => {
    const src = readScript('build-binary.mjs');
    const entry = /const ENTRY = join\(DIST, '([^']+)'\)/.exec(src);
    expect(entry, 'could not find the ENTRY declaration — reshaped?').not.toBeNull();
    expect(entry?.[1]).toBe('bin.cjs');
  });

  it('build.mjs emits a cjs bundle at bin.cjs', () => {
    const src = readScript('build.mjs');
    // The SEA build block: outfile bin.cjs with an explicit cjs format.
    expect(src).toMatch(/outfile:\s*join\(OUT,\s*'bin\.cjs'\)/);
    const seaBlock = /const seaResult = await build\(\{([\s\S]*?)\}\);/.exec(src);
    expect(seaBlock, 'could not find the SEA build call — reshaped?').not.toBeNull();
    expect(seaBlock?.[1]).toMatch(/format:\s*'cjs'/);
  });

  it('⛔ keeps dist/bin.js ESM — package.json is type:module and every normal run uses it', () => {
    const src = readScript('build.mjs');
    // The shared config the ESM outputs spread.
    expect(src).toMatch(/format:\s*'esm'/);
    const pkg = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8')) as {
      type?: string;
      bin?: Record<string, string>;
    };
    // If either of these ever changes, the reasoning above has to be re-derived
    // rather than assumed — hence asserting the premise, not just the conclusion.
    expect(pkg.type).toBe('module');
    expect(pkg.bin?.recued).toBe('./dist/bin.js');
  });

  it('the SEA bundle drops the createRequire banner (its import is illegal in CJS)', () => {
    const src = readScript('build.mjs');
    // The banner is stripped by destructuring it off `common`. If someone
    // spreads `common` wholesale into the SEA build instead, the emitted .cjs
    // starts with an `import` and the binary is back to not starting.
    expect(src).toMatch(/const \{ banner: _esmBanner, \.\.\.seaCommon \} = common/);
    const seaBlock = /const seaResult = await build\(\{([\s\S]*?)\}\);/.exec(src);
    expect(seaBlock?.[1]).toMatch(/\.\.\.seaCommon/);
    expect(seaBlock?.[1]).not.toMatch(/\.\.\.common/);
  });

  it('⇒ the SEA bundle externalises ONLY the native addon — the sidecar is one file', () => {
    // D-178 S1 rev 2 item 1, re-done under CJS. Under ESM a deferred
    // `require('ws')` survives as a runtime lookup, so ws/imapflow/nodemailer
    // must be external and therefore SHIPPED. Under CJS `require` is native and
    // esbuild inlines them, so they must NOT be external — and the `lib/`
    // sidecar reduces to `better_sqlite3.node` alone, because `dlopen` needs a
    // real path and no bundler can supply one.
    //
    // Verified by RUNNING each package from a bundle in a directory with no
    // node_modules (mailparser parsed an encoded-word subject, ws completed a
    // real round-trip, nodemailer's sendMail reached ECONNREFUSED rather than a
    // module error). ⚠ Re-run that probe if this list changes — a static check
    // is what missed the mailparser → nodemailer deep-require.
    const src = readScript('build.mjs');
    const block = /const SEA_EXTERNAL = \[([\s\S]*?)\];/.exec(src);
    expect(block, 'could not find SEA_EXTERNAL — reshaped?').not.toBeNull();
    const entries = [...(block?.[1] ?? '').replace(/\/\/[^\n]*/g, '').matchAll(/'([^']+)'/g)]
      .map((m) => m[1])
      .filter((n) => !n.startsWith('node:'));
    // ⛔ EMPTY of npm packages — not even the native driver. A SEA's require
    // resolves BUILT-INS ONLY, so an external here is UNLOADABLE at runtime
    // ("No such built-in module", observed on the first attempt), not merely
    // unbundled. The addon is loaded by open-database.ts through
    // createRequire(process.execPath) and passed to the driver as an OBJECT.
    expect(entries, 'a SEA cannot resolve any external npm package').toEqual([]);
  });

  it('the SEA build uses SEA_EXTERNAL, not the wider ESM list', () => {
    // Spreading `seaCommon` alone would silently inherit `common.external` and
    // put ws/imapflow/nodemailer back in the sidecar — a regression that builds
    // and runs fine, and is only visible as three extra files to ship.
    const seaBlock = /const seaResult = await build\(\{([\s\S]*?)\}\);/.exec(readScript('build.mjs'));
    expect(seaBlock?.[1]).toMatch(/external:\s*SEA_EXTERNAL/);
  });

  it('the SEA-only bundle is excluded from the npm package', () => {
    // `files` ships `dist/` wholesale; bin.cjs + its 40 MB sourcemap are used
    // only by the binary build and would roughly double the published tarball.
    const pkg = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8')) as { files: string[] };
    expect(pkg.files).toContain('!dist/bin.cjs');
    expect(pkg.files).toContain('!dist/bin.cjs.map');
  });
});
