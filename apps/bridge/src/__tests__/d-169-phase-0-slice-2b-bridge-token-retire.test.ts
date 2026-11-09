/** D-169 P0 Slice 2B — `bridge_token` symbol-absence + storage-shape ratchets.
 *
 *  Per spec § N.8 MUST NOT table (line 327: `bridge_token` as WS auth
 *  credential MUST NOT exist after D-169 lands) + the test-requirements
 *  block (line 953: "Auth ratchet (P0): grep test asserts `bridge_token`
 *  symbol absent across bridge + server source trees").
 *
 *  Companion to `d-169-phase-0-slice-2a-authority-retire.test.ts` —
 *  same comment-stripping + identifier-position needle pattern so
 *  doc-comment retirement breadcrumbs (e.g. "D-169 P0 Slice 2B —
 *  `bridge_token` retired") survive while runtime symbol use is
 *  banned. Per the project's zero-installs pre-launch rule the
 *  deprecation window is moot — retirement is immediate.
 *
 *  Ratchets:
 *   1. No source file under `apps/bridge/src/` or `backend/server/src/`
 *      references `bridge_token` (snake_case) as a runtime symbol.
 *   2. No source file references `bridge_token_rotate` as a runtime
 *      symbol.
 *   3. No source file references `rotateBridgeToken` (camelCase
 *      method name on the retired RotationEngine surface) as a symbol.
 *   4. `BRIDGE_LOCAL_STORAGE_FIELDS` is the new closed list of 8
 *      fields with the expected names (substrate alignment with
 *      `WEBCLIENT_LOCAL_STORAGE_FIELDS` for the auth + pair-state
 *      subset).
 *   5. The Slice 2A retirement of `BridgeAuthority` ratchets sibling
 *      (verify-authority.ts + authority-signer.ts both deleted) stays
 *      green — the two ratchets are independent but pinned alongside.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRIDGE_LOCAL_STORAGE_FIELDS } from '@recued/contracts';
import { isTypeScriptSource } from '../../../../test/source-file-extensions.js';

const here = dirname(fileURLToPath(import.meta.url));
// apps/bridge/src/__tests__ → ../../../../
const REPO_ROOT = resolve(here, '..', '..', '..', '..');
const BRIDGE_SRC = join(REPO_ROOT, 'apps', 'bridge', 'src');
const SERVER_SRC = join(REPO_ROOT, 'backend', 'server', 'src');

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
 *  ("D-169 P0 Slice 2B — `bridge_token` retired") don't trigger the
 *  symbol grep. Naive but adequate — we don't need a full TS parser;
 *  we just need to ignore documentation prose. */
const stripComments = (src: string): string => {
  let stripped = src.replace(/\/\*[\s\S]*?\*\//g, '');
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

describe('D-169 P0 Slice 2B — `bridge_token` symbol absence ratchets', () => {
  it('no bridge or server source file references `bridge_token` as a runtime symbol', () => {
    // Identifier-position needle: `bridge_token` not embedded in a
    // longer identifier (e.g. `bridge_tokenization` would be fine, but
    // none such exists in the codebase).
    const needle = /(^|[^A-Za-z0-9_])bridge_token\b/;
    const offenders = sourceFilesContaining([BRIDGE_SRC, SERVER_SRC], needle);
    expect(offenders).toEqual([]);
  });

  it('no bridge or server source file references `bridge_token_rotate` as a runtime symbol', () => {
    const needle = /(^|[^A-Za-z0-9_])bridge_token_rotate\b/;
    const offenders = sourceFilesContaining([BRIDGE_SRC, SERVER_SRC], needle);
    expect(offenders).toEqual([]);
  });

  it('no bridge or server source file references `rotateBridgeToken` as a symbol', () => {
    const needle = /(^|[^A-Za-z0-9_])rotateBridgeToken\b/;
    const offenders = sourceFilesContaining([BRIDGE_SRC, SERVER_SRC], needle);
    expect(offenders).toEqual([]);
  });

  it('no bridge or server source file references the retired `bridge_tokens` RotationEngineOptions field', () => {
    // The retired option name (plural) on `RotationEngineOptions`.
    // Allow `bridge_tokens` as a substring within unrelated identifiers
    // by anchoring on word boundaries.
    const needle = /(^|[^A-Za-z0-9_])bridge_tokens\b/;
    const offenders = sourceFilesContaining([BRIDGE_SRC, SERVER_SRC], needle);
    expect(offenders).toEqual([]);
  });
});

describe('D-169 P0 Slice 2B — BRIDGE_LOCAL_STORAGE_FIELDS closed-list pin', () => {
  it('exposes exactly the 8 post-Slice-2B fields in stable order, then D-335 slice G\'s blocked sites and the approvals shown', () => {
    expect([...BRIDGE_LOCAL_STORAGE_FIELDS]).toEqual([
      'server_url',
      'webclient_token',
      'server_public_key',
      'pair_metadata',
      'cert_pin_state',
      'chrome_permissions_state',
      'idempotency_cache',
      'pending_outbox',
      'blocked_sites',
      'approval_notices_shown',
    ]);
  });

  it('does NOT carry the retired `bridge_token` field name', () => {
    expect(
      (BRIDGE_LOCAL_STORAGE_FIELDS as ReadonlyArray<string>).includes('bridge_token'),
    ).toBe(false);
  });

  it('aligns the auth + pair-state subset with WEBCLIENT_LOCAL_STORAGE_FIELDS', () => {
    // The four fields that mirror the webclient closed list verbatim
    // (`server_url`, `webclient_token`, `server_public_key`,
    // `pair_metadata`, `cert_pin_state`) MUST appear in the bridge
    // list. The remaining three (`chrome_permissions_state`,
    // `idempotency_cache`, `pending_outbox`) are bridge-only DOM
    // executor state.
    const sharedWithWebclient = [
      'server_url',
      'webclient_token',
      'server_public_key',
      'pair_metadata',
      'cert_pin_state',
    ];
    for (const field of sharedWithWebclient) {
      expect((BRIDGE_LOCAL_STORAGE_FIELDS as ReadonlyArray<string>).includes(field)).toBe(true);
    }
  });
});

describe('D-169 P0 Slice 2B — bridge tokenStore module is present', () => {
  it('`apps/bridge/src/storage/token-store.ts` ships the WebclientTokenStore primitive', () => {
    expect(existsSync(join(BRIDGE_SRC, 'storage', 'token-store.ts'))).toBe(true);
  });
});
