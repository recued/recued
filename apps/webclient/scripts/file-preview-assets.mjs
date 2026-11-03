import { cpSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';

/** Ship the same PDF.js version for the core and worker, with local fonts and
 * codecs. Production and the browser harness use this exact asset inventory. */
export const copyFilePreviewAssets = (output) => {
  const root = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
  const { version } = createRequire(import.meta.url)('pdfjs-dist/package.json');
  const target = join(output, 'file-preview', version); mkdirSync(target, { recursive: true });
  for (const name of ['pdf.mjs', 'pdf.worker.mjs']) cpSync(join(root, 'legacy/build', name), join(target, name));
  for (const name of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) cpSync(join(root, name), join(target, name), { recursive: true });
  cpSync(join(root, 'LICENSE'), join(target, 'LICENSE'));
  buildSync({ entryPoints: [fileURLToPath(new URL('../src/files/docx-worker.ts', import.meta.url))],
    outfile: join(output, 'file-preview/docx.worker.js'), bundle: true, format: 'esm', platform: 'browser',
    // The reader needs preview limits only, without the app registry side effects
    // of the contracts entry point. Keep its cold worker small and self-contained.
    alias: { '@recued/contracts': fileURLToPath(new URL('../../../packages/contracts/src/file-lifecycle.ts', import.meta.url)) },
    target: 'es2022', minify: true, resolveExtensions: ['.ts', '.js', '.json'] });
  const zip = dirname(createRequire(import.meta.url).resolve('fflate/package.json'));
  cpSync(join(zip, 'LICENSE'), join(output, 'file-preview/fflate-LICENSE'));
};
