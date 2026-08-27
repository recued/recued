/** `backend/server/dependency-manifest.json` must agree with the build and the package.
 *
 *  The manifest is the declared inventory of every npm package our code
 *  reaches. `scripts/build.mjs` checks the EMITTED ARTIFACT against it on every
 *  build (nothing dangling, everything declared-inlined actually present); this
 *  file checks the DECLARATIONS against each other, which needs no build and so
 *  runs in the normal suite.
 *
 *  ⛔ WHY THREE LISTS HAVE TO AGREE. A package can be named in the manifest, in
 *  esbuild's `EXTERNAL`, and in `dependencies` — and any pair can drift:
 *    · external but undeclared → the artifact resolves a package it does not
 *      ship; MODULE_NOT_FOUND on the user's machine.
 *    · declared but not external → it gets bundled; harmless for a pure-ESM
 *      package, fatal for one with dynamic requires, and only when the path
 *      actually runs.
 *    · in neither, but reached anyway → the `ws` outage: never bundled, never
 *      shipped, and the failure is whatever the call site's fallback does.
 *
 *  The existing `build-externals-declared.test.ts` pins EXTERNAL ↔ dependencies.
 *  This adds the manifest as the third corner, and covers the SEA column that
 *  neither of the other two describes. */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

interface ManifestEntry {
  reached_by: 'static-import' | 'deferred-require';
  esm: 'external' | 'inlined';
  sea: 'inlined' | 'sidecar';
  sidecar_file?: string;
  why: string;
}

const manifest = JSON.parse(
  readFileSync(join(PKG_ROOT, 'dependency-manifest.json'), 'utf8'),
) as {
  packages: Record<string, ManifestEntry>;
  optional_unresolved: Record<string, string>;
};

const pkgJson = JSON.parse(
  readFileSync(join(PKG_ROOT, 'package.json'), 'utf8'),
) as { dependencies?: Record<string, string> };

/** Parse the esbuild lists out of `build.mjs` as TEXT — it is a build script,
 *  not a module that exports its config, and importing it would run a build.
 *  Same approach (and same caveat) as `build-externals-declared.test.ts`: if
 *  the declaration is reshaped this parse must move with it, which is what the
 *  "parses at all" cases below exist to force. */
const readList = (name: string): string[] => {
  const src = readFileSync(join(PKG_ROOT, 'scripts', 'build.mjs'), 'utf8');
  const block = new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`).exec(src);
  if (!block) throw new Error(`could not find the ${name} array in scripts/build.mjs`);
  return [...block[1]!.replace(/\/\/.*$/gm, '').matchAll(/['"]([^'"]+)['"]/g)]
    .map((m) => m[1]!)
    .filter((n) => n !== 'node:*');
};

describe('dependency manifest agrees with the build', () => {
  it('parses both esbuild lists at all', () => {
    // A vacuous pass over an empty set is the failure mode this guards.
    expect(readList('EXTERNAL').length).toBeGreaterThan(0);
    expect(readList('SEA_EXTERNAL')).toEqual([]); // builtins-only, by design
  });

  it('every manifest esm:external is in the esbuild EXTERNAL list', () => {
    const declared = Object.entries(manifest.packages)
      .filter(([, v]) => v.esm === 'external')
      .map(([k]) => k)
      .sort();
    expect(readList('EXTERNAL').sort()).toEqual(declared);
  });

  it('every manifest esm:external is a runtime dependency', () => {
    // External means "resolved from node_modules at runtime", so the package
    // must be declared or the npm artifact does not ship it.
    const deps = Object.keys(pkgJson.dependencies ?? {}).sort();
    const external = Object.entries(manifest.packages)
      .filter(([, v]) => v.esm === 'external')
      .map(([k]) => k)
      .sort();
    expect(deps).toEqual(external);
  });

  it('every manifest esm:inlined is NOT a runtime dependency', () => {
    // Inlined packages are carried by the bundle; declaring them as runtime
    // dependencies would make every npm install download them for nothing.
    const deps = new Set(Object.keys(pkgJson.dependencies ?? {}));
    const inlined = Object.entries(manifest.packages)
      .filter(([, v]) => v.esm === 'inlined')
      .map(([k]) => k);
    expect(inlined.filter((n) => deps.has(n))).toEqual([]);
  });

  it('only a native addon may be a SEA sidecar', () => {
    // The SEA inlines everything it can; the single irreducible case is a
    // `.node` binary, because dlopen needs a real path no bundler can provide.
    for (const [name, spec] of Object.entries(manifest.packages)) {
      if (spec.sea !== 'sidecar') continue;
      expect(spec.sidecar_file, `${name} is a sidecar without a file`).toMatch(/\.node$/);
    }
  });

  it('every package reached by our code is in the manifest', () => {
    // The `ws` outage in one assertion: it was reached, and named nowhere.
    const declared = new Set(Object.keys(manifest.packages));
    const missing = Object.keys(pkgJson.dependencies ?? {}).filter((n) => !declared.has(n));
    expect(missing).toEqual([]);
  });

  it('documents every entry, including why the optionals are safe', () => {
    // An undocumented entry is how a "temporary" exception becomes permanent.
    for (const [name, spec] of Object.entries(manifest.packages)) {
      expect(spec.why?.length ?? 0, `${name} has no rationale`).toBeGreaterThan(20);
    }
    for (const [name, why] of Object.entries(manifest.optional_unresolved)) {
      expect(why.length, `${name} has no rationale`).toBeGreaterThan(20);
    }
  });
});
