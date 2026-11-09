/** D-169 P0 Slice 2A — authority retirement ratchets.
 *
 *  Per spec acceptance:
 *    "**No-Authority ratchet (P0):** grep test asserts `BridgeAuthority`
 *     / `AuthoritySigner` / `permitted_actions` symbols absent across
 *     bridge + server source trees."
 *
 *  Per project convention (zero-installs pre-launch), the "one-release
 *  deprecation window" caveat is moot — retirement is immediate.
 *
 *  Ratchets:
 *   1. The bridge's `src/permissions/verify-authority.ts` module is
 *      deleted (no file exists).
 *   2. The server's `src/bridges/authority-signer.ts` module is
 *      deleted (no file exists).
 *   3. No source file under `apps/bridge/src/` or
 *      `backend/server/src/` declares / imports the retired symbols
 *      as values. Doc-comment mentions referencing the historical
 *      design (e.g., "Pre-D-169...") are explicitly allowed since
 *      the project keeps decision-log breadcrumbs.
 *   4. `BridgeAuthority` is not exported from `@recued/contracts`.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isTypeScriptSource } from '../../../../test/source-file-extensions.js';

const here = dirname(fileURLToPath(import.meta.url));
// apps/bridge/src/__tests__ → ../../../../
const REPO_ROOT = resolve(here, '..', '..', '..', '..');
const BRIDGE_SRC = join(REPO_ROOT, 'apps', 'bridge', 'src');
const SERVER_SRC = join(REPO_ROOT, 'backend', 'server', 'src');
const CONTRACTS_SRC = join(REPO_ROOT, 'packages', 'contracts', 'src');

/** Walk a directory recursively for .ts files (skipping __tests__ +
 *  type-only declarations). Returns absolute paths. The grep ratchet
 *  excludes test files because tests reference retired symbols by
 *  name when asserting the retirement (this file itself). */
const collectSourceFiles = (dir: string): string[] => {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const visit = (path: string): void => {
    const stat = statSync(path);
    if (stat.isDirectory()) {
      const base = path.split('/').pop() ?? '';
      if (base === '__tests__' || base === 'node_modules' || base === 'dist' || base === 'build') {
        return;
      }
      for (const entry of readdirSync(path)) visit(join(path, entry));
      return;
    }
    if (isTypeScriptSource(path)) {
      out.push(path);
    }
  };
  visit(dir);
  return out;
};

/** Strip block + line comments from TS source so doc references
 *  ("Pre-D-169 BridgeAuthority...") don't trigger the symbol grep.
 *  Naive but adequate — we don't need a full TS parser; we just need
 *  to ignore documentation prose. */
const stripComments = (src: string): string => {
  // Block comments.
  let stripped = src.replace(/\/\*[\s\S]*?\*\//g, '');
  // Line comments.
  stripped = stripped.replace(/\/\/[^\n]*/g, '');
  return stripped;
};

const sourceFilesContaining = (roots: string[], needle: RegExp): string[] => {
  const matches: string[] = [];
  for (const root of roots) {
    for (const file of collectSourceFiles(root)) {
      const stripped = stripComments(readFileSync(file, 'utf8'));
      if (needle.test(stripped)) matches.push(file);
    }
  }
  return matches;
};

describe('D-169 P0 Slice 2A — file deletion ratchets', () => {
  it('apps/bridge/src/permissions/verify-authority.ts has been deleted', () => {
    expect(existsSync(join(BRIDGE_SRC, 'permissions', 'verify-authority.ts'))).toBe(false);
  });

  it('backend/server/src/bridges/authority-signer.ts has been deleted', () => {
    expect(existsSync(join(SERVER_SRC, 'bridges', 'authority-signer.ts'))).toBe(false);
  });
});

describe('D-169 P0 Slice 2A — symbol absence ratchets', () => {
  it('no bridge or server source file references `BridgeAuthority` as a symbol', () => {
    // Match identifier-position usage only — preceded by punctuation
    // common in import/type/value positions (no word char before).
    const needle = /(^|[^A-Za-z0-9_])BridgeAuthority\b/;
    const offenders = sourceFilesContaining([BRIDGE_SRC, SERVER_SRC], needle);
    expect(offenders).toEqual([]);
  });

  it('no bridge or server source file references `AuthoritySigner` as a symbol', () => {
    const needle = /(^|[^A-Za-z0-9_])AuthoritySigner\b/;
    const offenders = sourceFilesContaining([BRIDGE_SRC, SERVER_SRC], needle);
    expect(offenders).toEqual([]);
  });

  it('no bridge or server source file references `verifyBridgeAuthority` as a symbol', () => {
    const needle = /(^|[^A-Za-z0-9_])verifyBridgeAuthority\b/;
    const offenders = sourceFilesContaining([BRIDGE_SRC, SERVER_SRC], needle);
    expect(offenders).toEqual([]);
  });

  it('no bridge or server source file references `buildAuthoritySignedBytes` as a symbol', () => {
    const needle = /(^|[^A-Za-z0-9_])buildAuthoritySignedBytes\b/;
    const offenders = sourceFilesContaining([BRIDGE_SRC, SERVER_SRC], needle);
    expect(offenders).toEqual([]);
  });

  it('no bridge or server source file references `createWebCryptoEd25519Verifier` as a symbol', () => {
    const needle = /(^|[^A-Za-z0-9_])createWebCryptoEd25519Verifier\b/;
    const offenders = sourceFilesContaining([BRIDGE_SRC, SERVER_SRC], needle);
    expect(offenders).toEqual([]);
  });

  it('no bridge or server source file references `permitted_actions` as a symbol', () => {
    // `permitted_actions` is the field name on the retired BridgeAuthority.
    // The ingredient manifest's `permitted_actions` (a publish-time field
    // declaring which actions the ingredient supports) is a DIFFERENT field
    // that lives on the marketplace manifest contract, not on the
    // BridgeCommand wire. The bridge / server source tree must not
    // reference `permitted_actions` as a runtime symbol; the marketplace
    // contracts package may.
    const needle = /(^|[^A-Za-z0-9_])permitted_actions\b/;
    const offenders = sourceFilesContaining([BRIDGE_SRC, SERVER_SRC], needle);
    expect(offenders).toEqual([]);
  });
});

describe('D-169 P0 Slice 2A — contract surface ratchet', () => {
  it('`@recued/contracts` no longer re-exports `BridgeAuthority`', () => {
    const indexPath = join(CONTRACTS_SRC, 'index.ts');
    const src = readFileSync(indexPath, 'utf8');
    // Look at the index re-export only (the file is huge; we scope to
    // the re-export region keyed by the `BridgeCommand` line that
    // anchors the bridge re-export block).
    const stripped = stripComments(src);
    const needle = /\bBridgeAuthority\b/;
    expect(needle.test(stripped)).toBe(false);
  });
});
