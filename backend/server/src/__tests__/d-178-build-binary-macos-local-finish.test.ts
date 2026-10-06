/** D-178 — a plain `npm run build:binary` on macOS leaves a binary that RUNS.
 *
 *  Measured 2026-10-05 on a clone of the public repo: postject strips the
 *  signature, so the binary was killed at exec (exit 137, nothing printed), and
 *  once signed by hand it stopped at D178_SIDECAR_MISSING. The release driver
 *  did both steps; the script a contributor runs did neither.
 *
 *  Source assertions, like the postject test beside this one: executing the
 *  build needs macOS and a Node with a SEA fuse sentinel. The real build was
 *  driven on macos-arm64 when this landed. Each assertion names what it
 *  prevents.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '../../scripts');
/** Executable lines only — the comments discuss all of this at length. */
const codeOf = (name: string): string => readFileSync(join(SCRIPTS, name), 'utf8')
  .split('\n')
  .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
  .join('\n');
const build = codeOf('build-binary.mjs');
const releaseDriver = codeOf('build-binary-macos.mjs');

/** The macOS finishing block: from its guard to the checksum step. */
const finish = build.slice(
  build.indexOf("process.platform === 'darwin' && !CALLER_SIGNS"),
  build.indexOf("createHash('sha256')"),
);

describe('build:binary on macOS finishes the binary for this machine', () => {
  it('stages the cipher addon where the runtime looks for it', () => {
    // open-database.ts loads lib/better_sqlite3.node beside the executable;
    // without it the binary stops at D178_SIDECAR_MISSING.
    expect(finish).toMatch(/resolveCipherAddon\(\)/);
    expect(finish).toMatch(/join\(OUT, 'lib', 'better_sqlite3\.node'\)/);
  });

  it('probes the staged addon against the Node the binary embeds', () => {
    // A wrong-ABI addon gives the binary that boots and cannot be paired to.
    expect(finish).toMatch(/assertAddonMatchesThisNode\(sidecar\)/);
  });

  it('signs through the release signer, then executes what it signed', () => {
    // Unsigned, Apple Silicon kills it at exec: exit 137, nothing printed.
    expect(finish).toMatch(/sign-macos\.mjs/);
    expect(finish.indexOf('sign-macos.mjs')).toBeLessThan(finish.indexOf("'--version'"));
  });

  it('checksums the SIGNED bytes — signing rewrites the file', () => {
    expect(build.indexOf('sign-macos.mjs')).toBeGreaterThan(0);
    expect(build.indexOf('sign-macos.mjs')).toBeLessThan(build.indexOf("createHash('sha256')"));
  });

  it('hands the release driver the bare binary it signs with the Developer ID', () => {
    expect(build).toMatch(/const CALLER_SIGNS = process\.env\.RECUED_CALLER_SIGNS === '1'/);
    expect(releaseDriver).toMatch(
      /run\('npm', \['run', 'build:binary'\][^\n]*RECUED_CALLER_SIGNS: '1'/,
    );
  });
});
