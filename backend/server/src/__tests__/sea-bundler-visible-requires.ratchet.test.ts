/** ⛔⛔ THE BUNDLER MUST BE ABLE TO SEE EVERY THIRD-PARTY IMPORT WE SHIP.
 *
 *  A shipped release is a Node SEA: one bundled file, no `node_modules` beside
 *  it. esbuild resolves imports at BUILD time — but only the ones it can see.
 *  A `require()` called through a `createRequire()` shadow is opaque to it, so
 *  the package is never bundled, and at runtime the SEA throws
 *  `Cannot find module '<x>'`.
 *
 *  🔑 WHY A RATCHET AND NOT A UNIT TEST. This defect cannot fail any normal
 *  test: every suite runs from source, where `node_modules` is right there and
 *  the require succeeds. It exists only in the artifact. `ws-server.ts` shipped
 *  exactly this — `require('ws')` threw inside the binary, a stub handle took
 *  over, and its upgrade callback destroyed every socket without writing a
 *  byte. The server booted, printed a healthy banner, served `/health` and
 *  `/webclient/` with 200s, answered an unknown-path upgrade with a correct
 *  404 — and could not be paired to by anything. Found only by driving a
 *  signed binary by hand (2026-08-27).
 *
 *  The build smoke in `scripts/build-binary-macos.mjs` now probes a real `/ws`
 *  upgrade and fails the build on silence or a stub answer. This ratchet is the
 *  cheap sibling that names the CAUSE at review time instead of at build time.
 *
 *  Node builtins (`node:fs`, `node:sea`, …) are exempt: they resolve inside a
 *  SEA by definition. Relative paths are exempt: they are part of the bundle.
 *
 *  ⚠ IF YOU ADD A LEGITIMATE `createRequire` TO A SHIPPED FILE, anchor it as
 *  `createRequire(import.meta.url ?? __filename)`. esbuild replaces
 *  `import.meta` with `{}` in CJS output, so `import.meta.url` is UNDEFINED in
 *  the SEA bundle and `createRequire(undefined)` throws at MODULE LOAD —
 *  `recued serve` died before printing anything, with "The argument 'filename'
 *  must be a file URL object, file URL string, or absolute path string.
 *  Received undefined". `__filename` is native in CJS and is never evaluated
 *  under ESM (`??` short-circuits), so one expression covers the ESM source,
 *  the ESM bundle and the CJS/SEA bundle. Relocated here from `ws-server.ts`
 *  on 2026-08-30, when the static `import * as wsLib from 'ws'` left that
 *  file's own shadow dead — the code went, the trap did not. */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Files allowed to reach a non-builtin through `createRequire`.
 *
 *  `open-database.ts` is the deliberate case: the native addon is shipped as a
 *  SIDECAR FILE beside the binary, never bundled, and is located at runtime via
 *  `node:sea` asset paths. That is the opposite situation — the require MUST
 *  stay invisible to the bundler, or esbuild would try to inline a `.node`. */
const ALLOWED = new Set(['open-database.ts']);

/** Strip comments before matching.
 *
 *  ⚠ Written after this ratchet failed on its own subject: `ws-server.ts` now
 *  carries a comment EXPLAINING the old `require('ws')`, and a raw regex read
 *  that prose as a violation. A ratchet that fires on the documentation of a fixed
 *  bug teaches people to delete the documentation. */
const stripComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    // `dev/` holds hand-run drives and `__tests__` never ships.
    if (entry === '__tests__' || entry === 'dev' || entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) out.push(full);
  }
  return out;
};

describe('SEA packaging — every shipped third-party import is bundler-visible', () => {
  it('no shipped file reaches a package through a createRequire shadow', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const text = stripComments(readFileSync(file, 'utf8'));
      if (!text.includes('createRequire')) continue;
      const rel = relative(SRC, file);
      if (ALLOWED.has(rel)) continue;
      for (const m of text.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)) {
        const spec = m[1]!;
        if (spec.startsWith('node:') || spec.startsWith('.') || spec.startsWith('/')) continue;
        offenders.push(`${rel}: require('${spec}')`);
      }
    }
    // A failure here means the SEA will throw `Cannot find module` for that
    // package and take whatever fallback the call site has — which, for
    // `ws-server`, was a stub that silently killed every WebSocket.
    expect(offenders).toEqual([]);
  });

  it('ws-server imports `ws` statically, so the bundle carries it', () => {
    const raw = readFileSync(join(SRC, 'ws-server.ts'), 'utf8');
    expect(raw).toMatch(/^import \* as wsLib from 'ws';$/m);
    expect(stripComments(raw)).not.toMatch(/require\(\s*['"]ws['"]\s*\)/);
  });
});
