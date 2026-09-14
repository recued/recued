import { cpSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/** Ship the same PDF.js version for the core and worker, with local fonts and
 * codecs. Production and the browser harness use this exact asset inventory. */
export const copyFilePreviewAssets = (output) => {
  const root = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
  const { version } = createRequire(import.meta.url)('pdfjs-dist/package.json');
  const target = join(output, 'file-preview', version); mkdirSync(target, { recursive: true });
  for (const name of ['pdf.mjs', 'pdf.worker.mjs']) cpSync(join(root, 'legacy/build', name), join(target, name));
  for (const name of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) cpSync(join(root, name), join(target, name), { recursive: true });
  cpSync(join(root, 'LICENSE'), join(target, 'LICENSE'));
};
