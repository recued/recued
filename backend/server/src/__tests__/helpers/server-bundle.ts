/** The server as `scripts/build.mjs` bundles it into `dist/bin.js`, for a test that starts
 *  real server processes. A start from it skips tsx, which reads and links ~2,800 modules each
 *  time: a `d-261-boot` boot took 1.5-1.8 s from the bundle against 2.3-3.2 s through tsx, and
 *  the first boot of a run, whose tsx cache is empty, 1.9 s against 8.2 s (2026-10-23, load 3-5).
 *
 *  ⚠ It lives three folders below the repo, as `dist/` does, because the server finds the repo
 *  from its own folder (`<here>/../../..` in `recipe-store.ts`, `manifest-loader.ts` and
 *  `bundled-pack-source.ts`) and loads its external packages from the repo's `node_modules`. A
 *  bundle anywhere else boots against the wrong tree, or not at all. `dist/` itself is no home:
 *  a sweep rewrites it while tests run (`phase-e-package` runs `build.mjs`).
 *
 *  It is rebuilt, in about half a second, when a file it was built from has changed or it was
 *  built in another checkout. `RECUED_TEST_SERVER_FROM_SOURCE=1` boots `bin.ts` through tsx
 *  instead, for a failure whose stack should name the `.ts` files. */
import { build } from 'esbuild';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const SERVER = resolve(import.meta.dirname, '../../..');
const BUNDLE_DIR = join(SERVER, '.test-server-bundle');
const BUNDLE = join(BUNDLE_DIR, 'bin.js');
const INPUTS = join(BUNDLE_DIR, 'inputs.json');

/** What a bundle was built from: the checkout, and each input's mtime and size. */
interface BuiltFrom { server: string; inputs: Record<string, [number, number]> }

const isFresh = (): boolean => {
  try {
    const built = JSON.parse(readFileSync(INPUTS, 'utf8')) as BuiltFrom;
    if (built.server !== realpathSync(SERVER) || !existsSync(BUNDLE)) return false;
    return Object.entries(built.inputs).every(([path, [mtime, size]]) => {
      const now = statSync(path);
      return now.mtimeMs === mtime && now.size === size;
    });
  } catch { return false; }
};

/** Builds with `build.mjs`'s options for `dist/bin.js`. The externals are the packages
 *  `dependency-manifest.json` declares external to the ESM bundle, the list `build.mjs`'s
 *  `EXTERNAL` must match. A writer publishes by rename, so a reader never runs half a file. */
const rebuild = async (): Promise<string> => {
  const manifest = JSON.parse(readFileSync(join(SERVER, 'dependency-manifest.json'), 'utf8')) as {
    packages: Record<string, { esm?: string }> };
  const { version } = JSON.parse(readFileSync(join(SERVER, 'package.json'), 'utf8')) as { version: string };
  mkdirSync(BUNDLE_DIR, { recursive: true });
  const written = `${BUNDLE}.${process.pid}`;
  const result = await build({
    absWorkingDir: SERVER, entryPoints: [join(SERVER, 'src', 'bin.ts')], outfile: written, metafile: true,
    bundle: true, platform: 'node', target: 'node20', format: 'esm', logLevel: 'warning',
    external: [...Object.entries(manifest.packages).filter(([, spec]) => spec.esm === 'external').map(([name]) => name), 'node:*'],
    tsconfig: join(SERVER, 'tsconfig.json'), resolveExtensions: ['.ts', '.tsx', '.mjs', '.js', '.json'],
    define: { __RECUED_SERVER_VERSION__: JSON.stringify(version) },
    banner: { js: "import { createRequire as __recuedCreateRequire } from 'node:module';\n"
      + 'const require = __recuedCreateRequire(import.meta.url);' },
  });
  const inputs: BuiltFrom['inputs'] = {};
  // The files esbuild read, and the ones that shaped how it read them.
  for (const input of [...Object.keys(result.metafile.inputs), 'tsconfig.json', '../../tsconfig.base.json',
    'package.json', 'dependency-manifest.json', import.meta.filename]) {
    const path = resolve(SERVER, input), stat = statSync(path);
    inputs[path] = [stat.mtimeMs, stat.size];
  }
  renameSync(written, BUNDLE);
  writeFileSync(`${INPUTS}.${process.pid}`, JSON.stringify({ server: realpathSync(SERVER), inputs } satisfies BuiltFrom));
  renameSync(`${INPUTS}.${process.pid}`, INPUTS);
  return BUNDLE;
};

let bundle: Promise<string> | undefined;

/** The arguments that start the server CLI under `process.execPath`: the bundle, or `bin.ts`
 *  through tsx when `RECUED_TEST_SERVER_FROM_SOURCE=1`. Checked and built once a process. */
export const serverEntry = async (): Promise<string[]> => process.env.RECUED_TEST_SERVER_FROM_SOURCE === '1'
  ? ['--import', 'tsx', join(SERVER, 'src', 'bin.ts')]
  : [await (bundle ??= isFresh() ? Promise.resolve(BUNDLE) : rebuild())];
