/** D-148 Appendix I.4 + I.5 — manifest CI gates.
 *
 *  The bridge ships with a narrow Chrome permission set; CI lint
 *  rejects any PR that adds a permission outside the allowed list.
 *  These pure helpers run inside vitest so the gate is enforced at
 *  every PR, not at build time only.
 *
 *  Allowed permissions per spec § A.3.4:
 *    storage / alarms / offscreen / notifications / tabs / scripting
 *
 *  Prohibited per spec § A.3.4 (closed list):
 *    cookies / webRequest / webRequestBlocking / history / bookmarks /
 *    tabCapture / desktopCapture / pageCapture / proxy / vpnProvider /
 *    debugger / <all_urls>
 *
 *  Host-permission policy:
 *    - `host_permissions` MUST be empty by default.
 *    - `optional_host_permissions` MAY be `*://*\/*` so Chrome's
 *      per-grant flow can request a specific origin at user prompt.
 */

import {
  BRIDGE_ALLOWED_CHROME_PERMISSIONS,
  BRIDGE_PROHIBITED_CHROME_PERMISSIONS,
} from '@recued/contracts';

export interface BridgeManifest {
  manifest_version: number;
  name: string;
  version: string;
  permissions?: string[];
  host_permissions?: string[];
  optional_host_permissions?: string[];
  background?: { service_worker?: string; type?: string };
  content_scripts?: Array<{ matches: string[]; js: string[]; all_frames?: boolean }>;
  /** Other fields tolerated; CI gate cares about the security-load-bearing fields. */
  [k: string]: unknown;
}

export type ManifestCheckOutcome =
  | { ok: true }
  | { ok: false; violations: string[] };

const allowed = new Set(BRIDGE_ALLOWED_CHROME_PERMISSIONS);
const prohibited = new Set(BRIDGE_PROHIBITED_CHROME_PERMISSIONS);

/** `action.default_icon` may be a single path string OR a size→path map
 *  (Chrome action docs); the top-level `icons` field is always a map.
 *  Normalize either to a flat list of path strings so a string-form value
 *  isn't iterated character-by-character. */
const iconPathsOf = (value: unknown): string[] => {
  if (typeof value === 'string') return [value];
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).filter(
      (v): v is string => typeof v === 'string',
    );
  }
  return [];
};

/** Validate a parsed bridge manifest against the spec § A.3.4 closed
 *  lists. Pure function; tests pass `JSON.parse(readFileSync(manifest))`. */
export const checkBridgeManifest = (manifest: BridgeManifest): ManifestCheckOutcome => {
  const violations: string[] = [];

  // Permission gate.
  const perms = manifest.permissions ?? [];
  for (const p of perms) {
    if (prohibited.has(p)) {
      violations.push(`prohibited permission: ${p}`);
    }
    if (!allowed.has(p)) {
      violations.push(`undocumented permission: ${p} (not in BRIDGE_ALLOWED_CHROME_PERMISSIONS)`);
    }
  }

  // Host permissions: empty by default.
  const host_perms = manifest.host_permissions ?? [];
  if (host_perms.length > 0) {
    violations.push(`host_permissions must be empty by default (per § A.3.4.1); found: ${host_perms.join(', ')}`);
  }

  // Optional host permissions: `<all_urls>` only as the owner's opt-in for
  // screenshots. Invariant I-9 as amended 2026-11-01 (D-335 slice H): Chrome
  // captures a tab only for an extension holding it, so it may be OPTIONAL,
  // asked for by "Allow screenshots" in the side panel, and is still refused in
  // `host_permissions` (above) and in content scripts (below). Anything else
  // optional must be a match pattern.
  const opt_host_perms = manifest.optional_host_permissions ?? [];
  for (const p of opt_host_perms) {
    if (p !== '<all_urls>' && !/^(\*|https?):\/\/[^/]+\/.*$/.test(p)) {
      violations.push(`optional_host_permissions entry is not a match pattern: ${p}`);
    }
  }

  // MV3 only.
  if (manifest.manifest_version !== 3) {
    violations.push(`manifest_version must be 3 (MV3); found: ${manifest.manifest_version}`);
  }

  // Icons must be raster PNG. Chrome MV3 does NOT render SVG for the
  // `icons` set or `action.default_icon` — an SVG-only icon set ships a
  // broken/blank toolbar icon and fails Web Store review. (D-174 Bridge
  // redesign P3.1.)
  const iconValues = [
    ...iconPathsOf((manifest as { icons?: unknown }).icons),
    ...iconPathsOf((manifest as { action?: { default_icon?: unknown } }).action?.default_icon),
  ];
  for (const icon of iconValues) {
    if (!icon.toLowerCase().endsWith('.png')) {
      violations.push(`icon must be a raster .png (Chrome MV3 rejects non-PNG icons); found: ${icon}`);
    }
  }

  // Content-scripts must NOT match <all_urls>; per-domain grants flow
  // through optional_host_permissions instead.
  const content_scripts = manifest.content_scripts ?? [];
  for (const cs of content_scripts) {
    for (const m of cs.matches ?? []) {
      if (m === '<all_urls>') {
        violations.push(`content_scripts.matches must not include <all_urls> (per § A.3.4)`);
      }
    }
  }

  if (violations.length > 0) return { ok: false, violations };
  return { ok: true };
};

/** Sanity check used in vitest — `apps/bridge/public/manifest.json`
 *  must pass. Tests resolve the path via `import.meta.url`. */
export const BRIDGE_MANIFEST_RELATIVE_PATH = 'public/manifest.json';

/** Codex P1 #1 fold — manifest references must resolve to actual
 *  files in `apps/bridge/public/`. Returns the list of referenced
 *  asset paths so the CI gate can stat them. */
export interface ReferencedAssets {
  service_worker?: string;
  default_popup?: string;
  default_icon?: string;
  icons: string[];
  content_script_files: string[];
}

export const collectReferencedAssets = (manifest: BridgeManifest): ReferencedAssets => {
  const out: ReferencedAssets = { icons: [], content_script_files: [] };
  if (manifest.background?.service_worker) {
    out.service_worker = manifest.background.service_worker;
  }
  const action = (manifest as { action?: { default_popup?: string; default_icon?: unknown } }).action;
  if (typeof action?.default_popup === 'string') {
    out.default_popup = action.default_popup;
  }
  out.icons.push(...iconPathsOf(action?.default_icon));
  const top_icons = (manifest as { icons?: Record<string, string> }).icons;
  if (top_icons) {
    for (const v of Object.values(top_icons)) {
      if (typeof v === 'string') out.icons.push(v);
    }
  }
  for (const cs of manifest.content_scripts ?? []) {
    for (const f of cs.js ?? []) out.content_script_files.push(f);
  }
  // Dedupe icons.
  out.icons = Array.from(new Set(out.icons));
  return out;
};
