/** D-178 S6 — installer artifact selection (pure).
 *
 *  The decision the `install.sh` / `install.ps1` bootstrap makes after it has
 *  verified + parsed the signed manifest: for this host's (channel, platform),
 *  which binary do I download, and what are its `sha256` + `.minisig` to verify?
 *
 *  Kept here (not inlined in shell) so the selection is unit-tested once and the
 *  scripts can call `recued ... ` or a tiny node one-liner over it rather than
 *  re-implementing manifest traversal in bash + PowerShell. Fail-closed: a
 *  missing channel or an unbuilt platform returns a typed reason, never a
 *  guessed artifact. */

import type { ChannelName, Platform, ReleaseManifest } from './manifest.js';
import { resolveChannelTarget } from './resolve.js';
import { binaryFileName } from './target.js';

export interface InstallSelection {
  ok: true;
  channel: ChannelName;
  platform: Platform;
  version: string;
  /** Canonical file name (`recued-<triple>[.exe]`). */
  fileName: string;
  /** Download URL from the manifest. */
  url: string;
  /** Expected sha256 (hex) — the fast-fail check; the `.minisig` is authority. */
  sha256: string;
  /** The detached minisign signature string for the binary. */
  sig: string;
}

export type InstallSelectionResult =
  | InstallSelection
  | { ok: false; reason: 'channel-missing' | 'platform-unavailable' };

export interface SelectInstallInput {
  /** Defaults to `stable`. */
  channel?: ChannelName;
  platform: Platform;
}

/** Pick the binary artifact for a host from a parsed (already signature-verified)
 *  manifest. Does NOT verify anything — the caller verifies the manifest sig
 *  before parsing, then this selects, then the caller verifies the chosen
 *  binary's own `.minisig`. */
export const selectInstallArtifact = (
  manifest: ReleaseManifest,
  input: SelectInstallInput,
): InstallSelectionResult => {
  const requested: ChannelName = input.channel ?? 'stable';
  // ⛔ `edge` MEANS max(stable, edge), NOT `channels[requested]`. This read the
  // requested channel directly, so it selected edge `26.9.1` over stable
  // `26.9.1.1` — pulling an edge subscriber BACKWARDS past a hotfix — and
  // answered `channel-missing` for a stable-only manifest, which is the shape
  // the live edge feed actually has. `resolveChannelTarget` is the same
  // primitive `resolveRelease` uses, so the exported installer selector and the
  // server's own update path can no longer disagree about what a channel means.
  const resolved = resolveChannelTarget(manifest, requested);
  if (!resolved) return { ok: false, reason: 'channel-missing' };
  const { channel, release: ch } = resolved;
  const artifact = ch.artifacts[input.platform];
  if (!artifact) return { ok: false, reason: 'platform-unavailable' };
  return {
    ok: true,
    channel,
    platform: input.platform,
    version: ch.version,
    fileName: binaryFileName(input.platform),
    url: artifact.url,
    sha256: artifact.sha256,
    sig: artifact.sig,
  };
};
