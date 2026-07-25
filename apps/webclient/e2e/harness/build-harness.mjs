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
import { cpSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(here, '../..'); // apps/webclient

const ENTRIES = ['kitchen-harness.ts', 'full-app-harness.ts'];
for (const entry of ENTRIES) {
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
