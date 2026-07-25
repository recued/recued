#!/usr/bin/env node
/**
 * D-148 § A.4 — webclient PWA bundle build script.
 *
 * Bundles `apps/webclient/src/webclient-main.ts` into a single ESM
 * `webclient-main.js` and copies the static `public/` shell
 * (`index.html`, `manifest.webmanifest`, `sw.js`) into `build/` so the
 * directory can be served wholesale at `app.recued.com`.
 *
 * Why `build/` (not `dist/`):
 *   `dist/` is the package's TypeScript compile output (`tsc --build`
 *   emits per-file `.js` + `.d.ts` for downstream library consumers,
 *   including a NON-bundled `dist/webclient-main.js` whose imports
 *   don't resolve in a browser). The deployable PWA artefact has to
 *   live somewhere distinct — `build/` matches the React / Vite
 *   convention for "the folder you serve at the public URL".
 *
 * The bundle is `format: 'esm'` so the HTML's
 * `<script type="module" src="./webclient-main.js">` loads it cleanly.
 * No imports get externalised — every dependency the webclient touches
 * lives in the monorepo (the role-boundary lint enforces it), so the
 * bundle is self-contained.
 *
 * Outputs (under `apps/webclient/build/`):
 *   index.html                      — copied from public/
 *   manifest.webmanifest            — copied from public/
 *   sw.js                           — copied from public/
 *   webclient-main.js               — bundled entrypoint (ESM)
 *   webclient-main.js.map           — linked sourcemap
 *   webclient-bundle-manifest.json  — D-152 integrity manifest (sha256 per served file)
 *
 * The integrity manifest (last) lists every OTHER file in build/ with its
 * SHA-256, so the server's disk loader can verify the dropped-in bundle
 * against a shipped manifest at boot (`WebclientBundleManifest` shape;
 * `backend/server/src/webclient-bundle-loader.ts`). It never lists itself —
 * it is bundle metadata, not a served asset.
 *
 * Flags:
 *   --minify   Minify the bundle (production builds).
 */

import { build } from 'esbuild';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** D-152 § A.16 — must match `WEBCLIENT_BUNDLE_MANIFEST_FILENAME` in
 *  `packages/contracts/src/webclient-bundle.ts`. Hardcoded because this
 *  script runs as standalone node ESM and can't import the contracts
 *  package; the contract carries the canonical comment. */
const BUNDLE_MANIFEST_FILENAME = 'webclient-bundle-manifest.json';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, '..');
const SRC = join(PKG_ROOT, 'src');
const PUBLIC_DIR = join(PKG_ROOT, 'public');
const OUT = join(PKG_ROOT, 'build');

const minify = process.argv.includes('--minify');

console.log('[build-webclient] cleaning build/');
if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

console.log('[build-webclient] copying public/ → build/');
cpSync(PUBLIC_DIR, OUT, { recursive: true });

// D-174 — copy the canonical design tokens (single source of truth in
// @recued/ui-shared) into build/ so index.html can <link> them. Not committed
// as a per-app copy → no drift; refreshed from source on every build.
console.log('[build-webclient] copying shared design tokens → build/tokens.css');
cpSync(resolve(PKG_ROOT, '../../packages/ui-shared/src/theme/tokens.css'), join(OUT, 'tokens.css'));

console.log('[build-webclient] bundling webclient-main.ts');
await build({
  entryPoints: [join(SRC, 'webclient-main.ts')],
  outfile: join(OUT, 'webclient-main.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2022', 'chrome120', 'firefox120', 'safari17'],
  // Resolve TS source over the prebuilt dist/ so we always bundle the
  // current source tree (same pattern as backend/server's build).
  resolveExtensions: ['.ts', '.tsx', '.mjs', '.js', '.json'],
  tsconfig: join(PKG_ROOT, 'tsconfig.json'),
  sourcemap: 'linked',
  minify,
  logLevel: 'info',
});

// R26.2 Option B — bundle the self-serve OAuth opener-relay entry (loaded by
// the static public/oauth-callback.html copied above as a same-origin
// `script-src 'self'` asset; IIFE so a plain <script> loads it). Built BEFORE
// the manifest emission below so it + its map get hashed + listed.
console.log('[build-webclient] bundling oauth-callback-relay.ts');
await build({
  entryPoints: [join(SRC, 'connections/oauth-callback-relay.ts')],
  outfile: join(OUT, 'oauth-callback-relay.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2022', 'chrome120', 'firefox120', 'safari17'],
  resolveExtensions: ['.ts', '.tsx', '.mjs', '.js', '.json'],
  tsconfig: join(PKG_ROOT, 'tsconfig.json'),
  sourcemap: 'linked',
  minify,
  logLevel: 'info',
});

// D-152 § A.16 — emit the integrity manifest. Walk every file now in
// build/ (recursive; the tree is flat today but a future asset folder
// stays covered), hash it, and write the sorted manifest LAST so it
// never hashes itself. Forward-slash relative paths match the server
// loader's match keys + the contract path regex.
console.log('[build-webclient] writing', BUNDLE_MANIFEST_FILENAME);
const walk = (dir) => {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(abs));
    else if (entry.isFile()) out.push(abs);
  }
  return out;
};
const manifestFiles = walk(OUT)
  .map((abs) => relative(OUT, abs).split(sep).join('/'))
  .filter((rel) => rel !== BUNDLE_MANIFEST_FILENAME)
  .sort()
  .map((rel) => ({
    path: rel,
    sha256: createHash('sha256').update(readFileSync(join(OUT, rel))).digest('hex'),
  }));
writeFileSync(
  join(OUT, BUNDLE_MANIFEST_FILENAME),
  JSON.stringify({ files: manifestFiles }, null, 2) + '\n',
);
console.log(`[build-webclient] manifest lists ${manifestFiles.length} file(s)`);

console.log('[build-webclient] done →', OUT);
