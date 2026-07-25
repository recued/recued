#!/usr/bin/env node
/**
 * Generate `src/theme/tokens.generated.ts` from `src/theme/tokens.css`.
 *
 * `tokens.css` is the hand-edited source of truth; this emits the string
 * form (`THEME_TOKENS_CSS`) that SSR workers + JS-injecting surfaces
 * import. JSON.stringify handles all escaping, so the emitted constant is
 * byte-identical to the file (the guard test in
 * `src/theme/__tests__/tokens.test.ts` asserts it).
 *
 * Run: `npm run -w @recued/ui-shared generate:tokens`
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const themeDir = join(here, '..', 'src', 'theme');
const cssPath = join(themeDir, 'tokens.css');
const outPath = join(themeDir, 'tokens.generated.ts');

const css = readFileSync(cssPath, 'utf8');

const banner =
  '/* GENERATED from tokens.css by scripts/generate-tokens-css.mjs — do not\n' +
  ' * edit by hand. Edit tokens.css, then run\n' +
  ' * `npm run -w @recued/ui-shared generate:tokens`. */\n\n';

const body =
  '/** The canonical D-174 token block as a CSS string — inline into an SSR\n' +
  ' *  `<head>` (worker) or inject as a `<style>` (webclient / bridge /\n' +
  ' *  dashboard). Byte-identical to `tokens.css`. */\n' +
  `export const THEME_TOKENS_CSS = ${JSON.stringify(css)};\n`;

writeFileSync(outPath, banner + body, 'utf8');
console.log(`[generate-tokens-css] wrote ${outPath} (${css.length} bytes of CSS)`);
