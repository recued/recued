/** D-148 P3 — manifest CI gate tests.
 *
 *  Covers Appendix I.4 + I.5: forbidden permissions, no <all_urls>
 *  blanket grant, host_permissions empty by default. Codex P1 #1
 *  fold adds the manifest-references-existing-files test. */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BRIDGE_MANIFEST_RELATIVE_PATH,
  checkBridgeManifest,
  collectReferencedAssets,
  type BridgeManifest,
} from '../manifest/manifest-checks.js';
import {
  BRIDGE_ALLOWED_CHROME_PERMISSIONS,
  BRIDGE_PROHIBITED_CHROME_PERMISSIONS,
} from '@recued/contracts';

const here = dirname(fileURLToPath(import.meta.url));
// apps/bridge/src/__tests__ → ../../public/manifest.json
const APPS_BRIDGE_ROOT = join(here, '..', '..');

describe('D-148 P3 — bridge manifest CI gate', () => {
  it('the actual manifest passes the gate', () => {
    const manifest_path = join(APPS_BRIDGE_ROOT, BRIDGE_MANIFEST_RELATIVE_PATH);
    const manifest = JSON.parse(readFileSync(manifest_path, 'utf8')) as BridgeManifest;
    const out = checkBridgeManifest(manifest);
    expect(out.ok).toBe(true);
  });

  it('synthetic manifest with <all_urls> in host_permissions fails', () => {
    const out = checkBridgeManifest({
      manifest_version: 3,
      name: 'test',
      version: '0.0.1',
      permissions: [...BRIDGE_ALLOWED_CHROME_PERMISSIONS],
      host_permissions: ['<all_urls>'],
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.violations.some((v) => v.includes('host_permissions'))).toBe(true);
    }
  });

  it('synthetic manifest with cookies permission fails', () => {
    const out = checkBridgeManifest({
      manifest_version: 3,
      name: 'test',
      version: '0.0.1',
      permissions: [...BRIDGE_ALLOWED_CHROME_PERMISSIONS, 'cookies'],
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.violations.some((v) => v.includes('cookies'))).toBe(true);
    }
  });

  it('all prohibited permissions trip the gate individually', () => {
    for (const prohibited of BRIDGE_PROHIBITED_CHROME_PERMISSIONS) {
      const out = checkBridgeManifest({
        manifest_version: 3,
        name: 'test',
        version: '0.0.1',
        permissions: [...BRIDGE_ALLOWED_CHROME_PERMISSIONS, prohibited],
      });
      expect(out.ok).toBe(false);
    }
  });

  it('manifest_version != 3 fails', () => {
    const out = checkBridgeManifest({
      manifest_version: 2,
      name: 'test',
      version: '0.0.1',
      permissions: [...BRIDGE_ALLOWED_CHROME_PERMISSIONS],
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.violations.some((v) => v.includes('manifest_version'))).toBe(true);
    }
  });

  it('content_scripts matching <all_urls> fails', () => {
    const out = checkBridgeManifest({
      manifest_version: 3,
      name: 'test',
      version: '0.0.1',
      permissions: [...BRIDGE_ALLOWED_CHROME_PERMISSIONS],
      content_scripts: [{ matches: ['<all_urls>'], js: ['content.js'] }],
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.violations.some((v) => v.includes('content_scripts'))).toBe(true);
    }
  });

  it('optional_host_permissions = ["*://*\\/*"] passes (per-domain opt-in)', () => {
    const out = checkBridgeManifest({
      manifest_version: 3,
      name: 'test',
      version: '0.0.1',
      permissions: [...BRIDGE_ALLOWED_CHROME_PERMISSIONS],
      optional_host_permissions: ['*://*/*'],
    });
    expect(out.ok).toBe(true);
  });

  it('SVG icons fail (Chrome MV3 needs raster PNG)', () => {
    const out = checkBridgeManifest({
      manifest_version: 3,
      name: 'test',
      version: '0.0.1',
      permissions: [...BRIDGE_ALLOWED_CHROME_PERMISSIONS],
      icons: { '128': 'icons/logo.svg' },
    } as unknown as BridgeManifest);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.violations.some((v) => v.includes('raster .png'))).toBe(true);
    }
  });

  it('a PNG action default_icon passes', () => {
    const out = checkBridgeManifest({
      manifest_version: 3,
      name: 'test',
      version: '0.0.1',
      permissions: [...BRIDGE_ALLOWED_CHROME_PERMISSIONS],
      icons: { '16': 'icons/logo-16.png', '128': 'icons/logo-128.png' },
      action: { default_icon: { '16': 'icons/logo-16.png' } },
    } as unknown as BridgeManifest);
    expect(out.ok).toBe(true);
  });

  it('a string-form default_icon is handled (not iterated char-by-char)', () => {
    // Chrome allows action.default_icon to be a single path string.
    const png = checkBridgeManifest({
      manifest_version: 3,
      name: 'test',
      version: '0.0.1',
      permissions: [...BRIDGE_ALLOWED_CHROME_PERMISSIONS],
      icons: { '128': 'icons/logo-128.png' },
      action: { default_icon: 'icons/logo-16.png' },
    } as unknown as BridgeManifest);
    expect(png.ok).toBe(true);

    const svg = checkBridgeManifest({
      manifest_version: 3,
      name: 'test',
      version: '0.0.1',
      permissions: [...BRIDGE_ALLOWED_CHROME_PERMISSIONS],
      icons: { '128': 'icons/logo-128.png' },
      action: { default_icon: 'icons/logo.svg' },
    } as unknown as BridgeManifest);
    expect(svg.ok).toBe(false);
  });

  // I-9 as amended 2026-11-01 (D-335 slice H): `<all_urls>` may be OPTIONAL, the
  // owner's "Allow screenshots", because Chrome captures a tab only for an
  // extension holding it. It is still refused as a host permission and in a
  // content script (the cases above), and an optional entry must be a pattern.
  it('optional_host_permissions may include <all_urls>, the owner\'s opt-in for screenshots', () => {
    const out = checkBridgeManifest({
      manifest_version: 3,
      name: 'test',
      version: '0.0.1',
      permissions: [...BRIDGE_ALLOWED_CHROME_PERMISSIONS],
      optional_host_permissions: ['*://*/*', '<all_urls>'],
    });
    expect(out.ok).toBe(true);
  });

  it('an optional host permission that is not a match pattern fails', () => {
    const out = checkBridgeManifest({
      manifest_version: 3,
      name: 'test',
      version: '0.0.1',
      permissions: [...BRIDGE_ALLOWED_CHROME_PERMISSIONS],
      optional_host_permissions: ['everything'],
    });
    expect(out.ok).toBe(false);
  });
});

describe('D-148 P3 — manifest references existing files (Codex P1 #1 fold)', () => {
  it('every static referenced asset path resolves to a real file in apps/bridge/public/', () => {
    const manifest_path = join(APPS_BRIDGE_ROOT, BRIDGE_MANIFEST_RELATIVE_PATH);
    const manifest = JSON.parse(readFileSync(manifest_path, 'utf8')) as BridgeManifest;
    const refs = collectReferencedAssets(manifest);
    const public_root = join(APPS_BRIDGE_ROOT, 'public');
    const missing: string[] = [];
    // D-169 P0 Slice 1 — `service_worker` is now a bundler output
    // (`build/service-worker.js`), not a static asset shipped in
    // `public/`. The bundler-output existence is asserted by the
    // D-169 slice-1 bundler test which runs esbuild in-process; this
    // sanity-check keeps verifying the static asset refs only.
    const checks = [
      refs.default_popup,
      refs.default_icon,
      ...refs.icons,
      ...refs.content_script_files,
    ].filter((p): p is string => typeof p === 'string');
    for (const p of checks) {
      const full = join(public_root, p);
      if (!existsSync(full)) missing.push(p);
    }
    expect(missing).toEqual([]);
  });
});
