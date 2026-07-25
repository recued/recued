/** D-148 P12 — mode-discriminator + executor-cap retirement ratchet.
 *
 *  Closes the I.9 invariant in full (D-148 lines
 *  2872-2874): "no `if (legacy_extension)` branches after P11 / CI
 *  grep ... any branch keyed on legacy extension state, mode
 *  discriminator, FREE_TIER_EXECUTOR_LIMIT, or similar. Zero matches.
 *  Guards I-20."
 *
 *  P11 retired the extension + webapp surfaces wholesale + asserted
 *  the strict `legacy_extension` literal grep. P12 follows up by
 *  retiring the mode wire shape + entitlement-cap code that the prior
 *  three-component model used to gate per-client engine execution:
 *
 *    - `packages/contracts/src/mode.ts` (DeviceMode + entitlement
 *      filter + executor-cap constants + grace-window)
 *    - `backend/server/src/session-handler.ts` (session.* rpc)
 *    - `backend/server/src/entitlement-state.ts` (Pro→Free auto-flip)
 *    - `paired_instances.mode` column + getMode/setMode/touchLastActive
 *    - WsClient.mode + WsClient.last_active fields
 *    - `EXECUTE_MODE_DISCONNECT_GRACE_HOURS` /
 *      `READ_MODE_DEFAULT_SUBSCRIPTIONS` /
 *      `EXECUTE_MODE_DEFAULT_SUBSCRIPTIONS` (collapsed into
 *      `DEFAULT_SUBSCRIPTIONS`)
 *    - `kind: 'session'` ServerEvent + SessionEventDetails +
 *      ExecutorIdentity (no client emits these post-P12)
 *    - UI helpers `renderReadModeBlockedButton` / `isReadModeBlocked`
 *      / `readModeTooltip` etc.
 *
 *  D-156 P2 lifted the prohibition on `renderDevicesPage` /
 *  `DevicesPageState` / `DevicesPageRow` + the `account/devices-page.ts`
 *  path: the renderer is back as a restore-minus-tier-widgets revival
 *  (no `mode` field, no mode-toggle, no Demote, no executor-limit copy,
 *  no overage / grace banners, no Replace flow). The seventeen
 *  mode/cap symbols below still hold the line — the renderer cannot
 *  silently re-acquire any of them.
 *
 *  The post-P12 architecture: one tier, one mode (server runs the
 *  engine; clients render and HID). No client-side execution at any
 *  tier. Free vs. Pro differs on cloud-coordination affordances
 *  (DDNS / ACME / handle reservation) per D-148 § A.10, not on what
 *  the server does locally. */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');

const RETIRED_PATHS: ReadonlyArray<readonly [label: string, relPath: string]> = [
  ['packages/contracts/src/mode.ts', 'packages/contracts/src/mode.ts'],
  [
    'packages/contracts/src/__tests__/d-121-phase-7-mode.test.ts',
    'packages/contracts/src/__tests__/d-121-phase-7-mode.test.ts',
  ],
  ['backend/server/src/session-handler.ts', 'backend/server/src/session-handler.ts'],
  [
    'backend/server/src/entitlement-state.ts',
    'backend/server/src/entitlement-state.ts',
  ],
  [
    'backend/server/src/__tests__/d-121-phase-7-session.test.ts',
    'backend/server/src/__tests__/d-121-phase-7-session.test.ts',
  ],
  // D-156 P2 lifted: `account/devices-page.ts` is back as the
  // restore-minus-tier-widgets revival. The mode/cap identifier list
  // below still enforces the semantic intent (no mode discriminator,
  // no executor cap, no Demote, no Replace flow).
  [
    'packages/ui-shared/src/account/__tests__/d-121-phase-7-devices-page.test.ts',
    'packages/ui-shared/src/account/__tests__/d-121-phase-7-devices-page.test.ts',
  ],
  [
    'packages/ui-shared/src/account/read-mode-nudge.ts',
    'packages/ui-shared/src/account/read-mode-nudge.ts',
  ],
  [
    'packages/ui-shared/src/account/__tests__/d-121-phase-7-read-mode-nudge.test.ts',
    'packages/ui-shared/src/account/__tests__/d-121-phase-7-read-mode-nudge.test.ts',
  ],
  [
    'packages/ui-shared/src/top-bar/__tests__/d-121-phase-7-devices-mode.test.ts',
    'packages/ui-shared/src/top-bar/__tests__/d-121-phase-7-devices-mode.test.ts',
  ],
];

/** Identifiers retired by D-148 P12. A live source carrying any of
 *  these is a regression. Tests + spec text + changelog entries are
 *  allowed to reference them historically — the scan list below
 *  filters those paths out before grepping. */
const RETIRED_IDENTIFIERS: readonly string[] = [
  // Type / value exports
  'DeviceMode',
  'ALL_DEVICE_MODES',
  'DEVICE_MODE_SET',
  'DEFAULT_DEVICE_MODE',
  'FREE_TIER_EXECUTOR_LIMIT',
  'PRO_TIER_EXECUTOR_LIMIT',
  'PRO_DOWNGRADE_GRACE_HOURS',
  'EntitlementFilterClient',
  'EntitlementCheckResult',
  'EntitlementState',
  'checkExecutorEntitlement',
  'createEntitlementState',
  'evaluateExecutorOverage',
  'EXECUTE_MODE_DISCONNECT_GRACE_HOURS',
  'READ_MODE_DEFAULT_SUBSCRIPTIONS',
  'EXECUTE_MODE_DEFAULT_SUBSCRIPTIONS',
  // RPC method names
  'session.setMode',
  'session.demoteOther',
  'session.listDevices',
  // Event types
  'SessionEventDetails',
  'ExecutorIdentity',
  // Persistence + handler symbols
  'makeSessionHandlers',
  'SessionHandlerDeps',
  'touchLastActive',
  // UI helpers (deleted). D-156 P2 lifted `renderDevicesPage` /
  // `DevicesPageState` / `DevicesPageRow` — see file-header note +
  // RETIRED_PATHS comment above. The read-mode helpers stay banned.
  'isReadModeBlocked',
  'renderReadModeInlineNotice',
  'renderReadModeBlockedButton',
  'readModeTooltip',
];

const SCAN_ROOTS: readonly string[] = [
  'apps',
  'backend',
  'packages',
];

const SKIP_DIR_PARTS = new Set([
  'node_modules',
  'dist',
  'dist-extension',
  '__tests__',
  'coverage',
]);

// Only scan TypeScript source. Co-located `.js` build artifacts trail
// the source on every build — the canonical I.9 grep runs against
// what authors edit, not the derivative compiler output.
const SCAN_EXTS = new Set(['.ts', '.tsx']);

const walk = function* (root: string): Generator<string> {
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root)) {
    if (SKIP_DIR_PARTS.has(entry)) continue;
    const full = join(root, entry);
    let stat;
    try { stat = statSync(full); } catch { continue; }
    if (stat.isDirectory()) {
      yield* walk(full);
      continue;
    }
    if (!stat.isFile()) continue;
    const dot = entry.lastIndexOf('.');
    if (dot < 0) continue;
    if (!SCAN_EXTS.has(entry.slice(dot))) continue;
    yield full;
  }
};

const collectLiveSourceFiles = (): string[] => {
  const files: string[] = [];
  for (const rel of SCAN_ROOTS) {
    for (const file of walk(join(REPO_ROOT, rel))) {
      // Skip generated bundles + d.ts shims (build outputs reflect
      // pre-P12 state until rebuilt and aren't part of the source-
      // truth surface I.9 governs).
      if (file.endsWith('.d.ts')) continue;
      if (file.includes('/dist/')) continue;
      if (file.includes('/dist-extension')) continue;
      // Skip the P12 ratchet itself (it lists every retired identifier
      // as a string literal, on purpose).
      if (file.endsWith('d-148-p12-mode-discriminator-retirement.test.ts')) continue;
      files.push(file);
    }
  }
  return files;
};

describe('D-148 P12 — retired files absent on disk', () => {
  for (const [label, relPath] of RETIRED_PATHS) {
    it(`${label} no longer exists`, () => {
      expect(existsSync(join(REPO_ROOT, relPath))).toBe(false);
    });
  }
});

describe('D-148 P12 — retired identifiers absent from live source (I.9)', () => {
  const files = collectLiveSourceFiles();

  // One sub-test per identifier so a regression points at the offending
  // symbol without dumping the whole match list at once.
  for (const ident of RETIRED_IDENTIFIERS) {
    it(`no live source carries '${ident}'`, () => {
      // Match as a delimited token so substrings (e.g. `mode` inside
      // `'delta' | 'full'` discriminators) don't flag. The dot in
      // `session.setMode` is treated literally via regex escape.
      const escaped = ident.replace(/[.]/g, '\\.');
      const re = new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`);
      const offenders: string[] = [];
      for (const file of files) {
        let body: string;
        try { body = readFileSync(file, 'utf8'); } catch { continue; }
        if (re.test(body)) offenders.push(file.slice(REPO_ROOT.length + 1));
      }
      expect(offenders, `Offenders carrying '${ident}': ${offenders.join(', ')}`).toEqual([]);
    });
  }
});

describe('D-148 P12 — paired_instances schema retires mode + last_active', () => {
  it('paired-instances-store no longer adds mode column', () => {
    const file = join(
      REPO_ROOT,
      'backend/server/src/paired-instances-store.ts',
    );
    const body = readFileSync(file, 'utf8');
    expect(body).not.toContain('ADD COLUMN mode');
    expect(body).not.toContain('ADD COLUMN last_active');
    expect(body).not.toContain("UPDATE paired_instances SET mode");
    expect(body).not.toContain("UPDATE paired_instances SET last_active");
  });
});

describe('D-148 P12 — events surface no longer carries session kind', () => {
  it("'session' is not in ALL_BROADCAST_EVENT_KINDS", () => {
    const file = join(REPO_ROOT, 'packages/contracts/src/events.ts');
    const body = readFileSync(file, 'utf8');
    // The kind was emitted only by the now-deleted session-handler +
    // entitlement-state. P12 drops the union variant, the constant
    // entry, and the ExecutorIdentity / SessionEventDetails types.
    expect(body).not.toMatch(/kind:\s*'session'/);
    expect(body).not.toMatch(/'session'/);
  });

  it('SubscribeRequest no longer carries the mode field', () => {
    const file = join(REPO_ROOT, 'packages/contracts/src/events.ts');
    const body = readFileSync(file, 'utf8');
    expect(body).not.toMatch(/mode\?:\s*DeviceMode/);
  });
});

describe('D-148 P12 — server-registry no longer carries session.* rpc', () => {
  it('SERVER_RPC_METHOD_SET drops the three session methods', () => {
    const file = join(REPO_ROOT, 'packages/contracts/src/rpc/server-registry.ts');
    const body = readFileSync(file, 'utf8');
    expect(body).not.toContain("'session.setMode'");
    expect(body).not.toContain("'session.demoteOther'");
    expect(body).not.toContain("'session.listDevices'");
  });
});

describe('D-148 P12 — DEFAULT_SUBSCRIPTIONS replaces mode-keyed lists', () => {
  it('pairing.ts exports the unified list', () => {
    const file = join(REPO_ROOT, 'packages/contracts/src/pairing.ts');
    const body = readFileSync(file, 'utf8');
    expect(body).toContain('export const DEFAULT_SUBSCRIPTIONS');
    expect(body).not.toContain('READ_MODE_DEFAULT_SUBSCRIPTIONS');
    expect(body).not.toContain('EXECUTE_MODE_DEFAULT_SUBSCRIPTIONS');
    expect(body).not.toContain('EXECUTE_MODE_DISCONNECT_GRACE_HOURS');
  });
});
