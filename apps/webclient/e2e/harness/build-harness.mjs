#!/usr/bin/env node
/**
 * Bundle the webclient Playwright render harnesses.
 *
 * Two entry points, both mirroring apps/webclient/scripts/build.mjs's esbuild
 * config (same `resolveExtensions` so the `.js` ESM specifiers in src/ resolve
 * to the `.ts` source):
 *   • kitchen-harness.ts  — Layer-2: the shipped `#kitchen` route-target
 *     components off a local mock-conn (kitchen-render.spec.ts).
 *   • full-app-harness.ts — Path B: the whole `bootstrapWebclient` app off the
 *     deterministic fakes, every IA route driven by hash (full-app.spec.ts).
 * Each emits a self-contained `<name>.js` next to its HTML, plus a copy of the
 * shared design tokens, so the pages load over HTTP with no runtime imports.
 */
import { build } from 'esbuild';
import { cpSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyFilePreviewAssets } from '../../scripts/file-preview-assets.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(here, '../..'); // apps/webclient
copyFilePreviewAssets(here);

const ENTRIES = ['kitchen-harness.ts', 'full-app-harness.ts', 'chat-queue-harness.ts', 'file-lifecycle-harness.ts', 'existing-files-harness.ts', 'mail-work-harness.ts'];
for (const entry of ENTRIES) {
  // An entry may legitimately be absent from a source projection: the public
  // export withholds `kitchen-harness.ts`, because it stress-tests marketplace
  // packs that the public catalog does not carry. Skipping keeps the remaining
  // harnesses buildable there instead of failing the whole e2e script on a file
  // that was removed on purpose.
  if (!existsSync(join(here, entry))) {
    console.log(`[build-harness] skipping ${entry} — not present in this tree`);
    continue;
  }
  console.log(`[build-harness] bundling ${entry}`);
  await build({
    entryPoints: [join(here, entry)],
    outfile: join(here, entry.replace(/\.ts$/, '.js')),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: ['es2022', 'chrome120'],
    resolveExtensions: ['.ts', '.tsx', '.mjs', '.js', '.json'],
    tsconfig: join(PKG_ROOT, 'tsconfig.json'),
    sourcemap: false,
    logLevel: 'info',
  });
}

console.log('[build-harness] copying shared design tokens → tokens.css');
cpSync(resolve(PKG_ROOT, '../../packages/ui-shared/src/theme/tokens.css'), join(here, 'tokens.css'));

console.log('[build-harness] done →', here);
