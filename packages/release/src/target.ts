/** D-178 S1 — build-target resolution for the static-binary channel.
 *
 *  The release pipeline (CI matrix), the runtime self-updater, and the
 *  installer scripts all need to agree on ONE platform-triple vocabulary —
 *  the `Platform` keys the signed manifest's `artifacts` map is keyed by.
 *  Node reports `process.platform` / `process.arch`; the manifest speaks
 *  `linux-x64` / `macos-arm64` / `windows-x64` … . This module is the single
 *  pure mapping between the two, plus the canonical on-disk file name for a
 *  built binary (Windows carries `.exe`).
 *
 *  Pure + dependency-free so the frozen launcher and the `@recued/release`
 *  signer can both import it without dragging in node-only build machinery.
 */

import { PLATFORMS, type Platform } from './manifest.js';

/** Node `process.platform` values we can build a binary for. */
export type NodePlatform = 'linux' | 'darwin' | 'win32';
/** Node `process.arch` values we can build a binary for. */
export type NodeArch = 'x64' | 'arm64';

const OS_SEGMENT: Record<NodePlatform, string> = {
  linux: 'linux',
  darwin: 'macos',
  win32: 'windows',
};

/** Map a (node platform, node arch) pair to a manifest `Platform` triple.
 *  Returns null for any combination the static-binary channel does not
 *  build (e.g. `windows-arm64` is in the `Platform` union for forward-compat
 *  but is not a current build target — callers decide whether to error). */
export const resolvePlatformTriple = (
  platform: string,
  arch: string,
): Platform | null => {
  const os = OS_SEGMENT[platform as NodePlatform];
  if (!os) return null;
  if (arch !== 'x64' && arch !== 'arm64') return null;
  const triple = `${os}-${arch}` as Platform;
  return PLATFORMS.includes(triple) ? triple : null;
};

/** The manifest triple for the HOST the build is running on. SEA cannot
 *  cross-compile — each triple is produced by its own CI matrix runner — so
 *  the build script resolves its own target from `process`. */
export const currentPlatformTriple = (
  proc: { platform: string; arch: string } = process,
): Platform | null => resolvePlatformTriple(proc.platform, proc.arch);

/** Canonical on-disk file name for a built binary of the given triple.
 *  Windows triples carry the `.exe` suffix the OS requires; every other
 *  triple is extension-less. This is the name the installer downloads and
 *  the manifest `BinaryArtifact.url` ends in. */
export const binaryFileName = (triple: Platform): string =>
  triple.startsWith('windows-') ? `recued-${triple}.exe` : `recued-${triple}`;
