#!/usr/bin/env node
/**
 * D-169 P0 Slice 1 — Browser Bridge bundle build script.
 *
 * Bundles `apps/bridge/src/boot/service-worker-entry.ts` into a single
 * ESM `service-worker.js` and copies the static `public/` shell
 * (`manifest.json`, `icons/`, `side-panel/`) into `build/` so the
 * directory can be loaded wholesale as an unpacked MV3 extension.
 *
 * Why `build/` (mirrors webclient pattern):
 *   `dist/` is the TypeScript per-file emit for downstream library
 *   consumers (the typed modules in `apps/bridge/src/` flow into other
 *   tests + packages via the workspace `main` entry). The deployable
 *   extension artefact has to live somewhere distinct — `build/` is
 *   the load-this-into-Chrome directory.
 *
 * The bundle is `format: 'esm'` because the manifest's
 * `background.service_worker` carries `"type": "module"` — MV3 service
 * workers run as ES modules and the bundled entry has top-level
 * `import` syntax preserved (esbuild rewrites our package-internal
 * imports + leaves the bundle self-contained).
 *
 * Outputs (under `apps/bridge/build/`):
 *   manifest.json             — copied from public/
 *   icons/                    — copied from public/
 *   side-panel/index.html     — copied from public/ (D-169 P1)
 *   side-panel/*.css          — copied from public/ (pairing.css is the
 *                                pair form, shown while unpaired)
 *   side-panel/index.js       — D-169 P1: bundled from side-panel-entry.ts
 *                                (the panel, and the pair form inside it)
 *   service-worker.js         — bundled SW entry (ESM)
 *   service-worker.js.map     — linked sourcemap
 *
 * Flags:
 *   --minify   Minify the bundle (production builds).
 *
 * Spec: D-169 § A.1 + § A.3 — bundler + SW boot wire-up;
 *       side-panel scaffold.
 */

import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, '..');
const SRC = join(PKG_ROOT, 'src');
const PUBLIC_DIR = join(PKG_ROOT, 'public');
// A drive builds into a directory of its own (`RECUED_BRIDGE_BUILD_OUT`), so the build/ the
// owner loads unpacked in their own Chrome stays as it is. Never one with anything in it: this
// script empties build/ first, and it must not empty a directory someone named by mistake.
const OUT_OVERRIDE = process.env.RECUED_BRIDGE_BUILD_OUT;
const OUT = OUT_OVERRIDE ? resolve(OUT_OVERRIDE) : join(PKG_ROOT, 'build');
if (OUT_OVERRIDE && existsSync(OUT) && readdirSync(OUT).length > 0) {
  throw new Error(`[build-bridge] RECUED_BRIDGE_BUILD_OUT must be a new or empty directory: ${OUT}`);
}

const minify = process.argv.includes('--minify');

console.log(`[build-bridge] cleaning ${OUT_OVERRIDE ? OUT : 'build/'}`);
if (!OUT_OVERRIDE && existsSync(OUT)) rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

console.log('[build-bridge] copying public/ → build/');
cpSync(PUBLIC_DIR, OUT, {
  recursive: true,
  // Finder metadata is not an extension asset and must not leak into the
  // Chrome Web Store ZIP when a developer has browsed public/ on macOS.
  filter: (source) => basename(source) !== '.DS_Store',
});

// D-174 Bridge redesign P1 — the side panel `<link>`s the shared canonical
// token file (single source of truth in @recued/ui-shared); copy it next to
// the HTML so the relative `href="tokens.css"` resolves. This replaces the
// Bridge's old divergent warm `:root` palette. (There is no popup: the side
// panel shows the pair form itself.)
const TOKENS_CSS = join(PKG_ROOT, '..', '..', 'packages', 'ui-shared', 'src', 'theme', 'tokens.css');
cpSync(TOKENS_CSS, join(OUT, 'side-panel', 'tokens.css'));

const sharedBuildOpts = {
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2022', 'chrome120'],
  // Resolve TS source over the prebuilt dist/ so we always bundle the
  // current source tree (same pattern as webclient + backend builds).
  resolveExtensions: ['.ts', '.mjs', '.js', '.json'],
  tsconfig: join(PKG_ROOT, 'tsconfig.json'),
  sourcemap: 'linked',
  minify,
  logLevel: 'info',
};

console.log('[build-bridge] bundling service-worker-entry.ts');
await build({
  ...sharedBuildOpts,
  entryPoints: [join(SRC, 'boot', 'service-worker-entry.ts')],
  outfile: join(OUT, 'service-worker.js'),
});

// D-169 P1 — bundle the side-panel renderer. The html shell at
// `public/side-panel/index.html` references `index.js`; this bundle is
// the production wiring (chrome.* glue + store + mount).
console.log('[build-bridge] bundling side-panel-entry.ts');
await build({
  ...sharedBuildOpts,
  entryPoints: [join(SRC, 'side-panel', 'side-panel-entry.ts')],
  outfile: join(OUT, 'side-panel', 'index.js'),
});

// "Watch this element" picker (brick 2). Bundled as an IIFE because the
// SW injects it via `chrome.scripting.executeScript({ files })`, which runs
// the file as a classic (non-module) script in the page's isolated world —
// not as an ES module like the SW / side-panel entries above.
console.log('[build-bridge] bundling picker-content-entry.ts');
await build({
  ...sharedBuildOpts,
  format: 'iife',
  entryPoints: [join(SRC, 'picker', 'picker-content-entry.ts')],
  outfile: join(OUT, 'picker', 'picker.js'),
});

console.log('[build-bridge] done →', OUT);
