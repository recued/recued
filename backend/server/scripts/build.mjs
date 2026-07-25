#!/usr/bin/env node
/**
 * Phase E build script for @recued/server (D-107).
 *
 * Bundles the monorepo workspace packages (@recued/*) into a
 * standalone dist/ so the published npm package is self-contained.
 * External-izes native + heavy real-npm deps so the installed tree
 * stays thin and the native SQLite cipher driver rebuilds postinstall.
 *
 * Outputs:
 *   dist/bin.js          — CLI entry (#!/usr/bin/env node banner)
 *   dist/index.js        — library entry
 *   dist/bin.js.map      — linked sourcemap
 *   dist/index.js.map    — linked sourcemap
 *   dist/index.d.ts      — TS types for the library entry (via tsc)
 *
 * Type declarations run through `tsc --emitDeclarationOnly` instead
 * of esbuild because esbuild doesn't emit .d.ts.
 */

import { build } from 'esbuild';
import { chmodSync, mkdirSync, rmSync, cpSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, '..');
const SRC = join(PKG_ROOT, 'src');
const OUT = join(PKG_ROOT, 'dist');

// Read the package version so we can bake it into the bundle. Distribution
// versioning is CALENDAR-BASED semver `yy.m.d` (Pacific) — package.json is the
// single source of truth (bumped per release; at most one release/day, so the
// Pacific date is a unique, human-legible version). We bake it here so
// `recued-server --version` reports it even when invoked outside `npm run`
// (which would otherwise supply it via `process.env.npm_package_version`).
const pkg = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8'));
const VERSION = pkg.version;

// Real npm deps we keep external. better-sqlite3-multiple-ciphers is native (breaks
// when bundled). The others are heavy enough that bundling inflates
// the tarball without speeding install.
const EXTERNAL = [
  'better-sqlite3-multiple-ciphers',
  'ws',
  'imapflow',
  'mailparser',
  '@iarna/toml',
  // Node built-ins — always external.
  'node:*',
];

console.log('[build] cleaning dist/');
if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

console.log('[build] bundling entry points via esbuild');
const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  sourcemap: 'linked',
  external: EXTERNAL,
  logLevel: 'info',
  tsconfig: join(PKG_ROOT, 'tsconfig.json'),
  // The monorepo ships .js shims alongside .ts files; prefer .ts so
  // we compile from source, not the pre-built dist/.
  resolveExtensions: ['.ts', '.tsx', '.mjs', '.js', '.json'],
  // Constants injected at build time. Source code reads these as
  // declared globals; esbuild replaces them verbatim in the bundle.
  define: {
    '__RECUED_SERVER_VERSION__': JSON.stringify(VERSION),
  },
};

// ── Stale-shadow guard (2026-06-04) ─────────────────────────────────
// esbuild resolves an explicit `./foo.js` import to a real `foo.js` on disk
// when present, even with a `foo.ts` sibling (`resolveExtensions` only
// rewrites EXTENSIONLESS imports). A stale `src/**/*.js` left over from an
// old tsc-into-src emit therefore SHADOWS its `.ts` source and silently gets
// bundled — shipping outdated or missing exports. (This masked a chat
// tool-loop reinvoke crash: a stale `packages/transforms/src/pii-alias.js`
// predating the `aliasArgs` export got bundled over the `.ts`, so
// `aliasArgsForEgress` threw `ReferenceError` on every reinvoke.) These `.js`
// are git-ignored compiled output. Fail the build LOUDLY (never rm source)
// if any reached the bundle, naming the offenders so the dev deletes them.
const assertNoStaleSrcJsShadow = (metafile, label) => {
  const offenders = [];
  for (const inputPath of Object.keys(metafile.inputs)) {
    const abs = resolve(process.cwd(), inputPath);
    if (abs.includes('/node_modules/')) continue;
    if (!/[/\\]src[/\\].*\.js$/.test(abs)) continue; // only src/**/*.js
    if (existsSync(abs.replace(/\.js$/, '.ts'))) offenders.push(inputPath);
  }
  if (offenders.length > 0) {
    throw new Error(
      `[build] stale .js shadow bundled into ${label}: a compiled src/*.js was ` +
        `resolved over its .ts source (git-ignored stale tsc output). Delete it ` +
        `and rebuild:\n  ${offenders.join('\n  ')}`,
    );
  }
};

// bin.ts already has a `#!/usr/bin/env node` shebang; esbuild keeps
// the first-line shebang in ESM output, so no explicit banner is
// needed. Adding one would double it.
const binResult = await build({
  ...common,
  entryPoints: [join(SRC, 'bin.ts')],
  outfile: join(OUT, 'bin.js'),
  metafile: true,
});
assertNoStaleSrcJsShadow(binResult.metafile, 'bin.js');

const indexResult = await build({
  ...common,
  entryPoints: [join(SRC, 'index.ts')],
  outfile: join(OUT, 'index.js'),
  metafile: true,
});
assertNoStaleSrcJsShadow(indexResult.metafile, 'index.js');

// D-178 — the thin `:managed` image launcher (I-9 frozen verify-and-exec loop).
// Bundled standalone so the `:managed` image carries ONLY the launcher + node,
// never the server bundle (the binary it launches lives on the data volume).
const launcherResult = await build({
  ...common,
  entryPoints: [join(SRC, 'launcher', 'bin.ts')],
  outfile: join(OUT, 'managed-launcher.js'),
  metafile: true,
});
assertNoStaleSrcJsShadow(launcherResult.metafile, 'managed-launcher.js');

// Executable bit on the CLI entry so npm's bin linker can invoke it.
chmodSync(join(OUT, 'bin.js'), 0o755);
chmodSync(join(OUT, 'managed-launcher.js'), 0o755);

// Declaration files intentionally NOT emitted — @recued/server is
// consumed as a CLI, not a library. Users who import via
// `await import('@recued/server')` get the JS runtime entry. If the
// library surface grows consumer-facing, add a minimal hand-written
// `index.d.ts` rather than letting tsc emit the full tree of
// internal types.

// config.sample.toml sits at the package root so it reaches users
// via npm's `files` array; no copy needed. Listed here as a
// reminder that the file is part of the distributable surface.
const sampleCfg = join(PKG_ROOT, 'config.sample.toml');
if (!existsSync(sampleCfg)) {
  console.warn('[build] warning: config.sample.toml missing at package root');
}

console.log('[build] done →', OUT);
