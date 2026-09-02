/** D-178 S2 — release-manifest assembly + signing helpers.
 *
 *  The signer side of the release pipeline: take the per-platform binary
 *  artifacts (each already sha256'd + minisign-signed) + docker digests +
 *  channel/version metadata, assemble a `ReleaseManifest`, serialize it to the
 *  EXACT bytes that get published to the CDN, and minisign-sign those bytes.
 *
 *  Two invariants the consumers depend on:
 *    - I-2 integrity: every binary artifact carries a detached `.minisig`; the
 *      manifest itself carries a detached `.minisig`. `assembleManifest` runs
 *      the result through `parseManifest` so a half-built manifest (missing a
 *      `sig`/`digest`) can't be published.
 *    - byte-exactness: the bytes signed MUST equal the bytes published. The
 *      signer writes `serializeManifest(manifest)` to disk and signs the SAME
 *      string — consumers verify the detached sig over the literal file bytes,
 *      so there is no separate "canonical form" they must reconstruct. The
 *      trailing newline is part of the signed bytes.
 *
 *  Pure + dependency-free (reuses `sign` from minisign + `parseManifest`); the
 *  impure orchestration (reading built binaries, env key, CDN staging) lives in
 *  `backend/server/scripts/release-build.mjs`.
 */

/** The shortest `expires_at` horizon a publish may carry, in days.
 *
 *  ⛔⛔ IT EXISTS BECAUSE OLD SERVERS STILL GATE ON A FIELD NOTHING READS. D-260
 *  withdrew the freshness gate: no current consumer reads `expires_at` to decide
 *  anything. A server built BEFORE that change does — past expires_at + a 7-day
 *  grace it resolves `stale-feed`, which makes `resolveForApply` non-applyable,
 *  so it refuses EVERY update INCLUDING the one that removes the gate. A
 *  near-dated publish therefore strands every such server, whose only route back
 *  is re-running install.sh by hand.
 *
 *  🔑 ONE CONSTANT, BOTH ENDS. The publisher's guard (`release-build.mjs`) and
 *  the release driver's default window (`release/lib/release-expiry.mjs`) each
 *  had their own number — 365 and 30 — so the DEFAULT release path refused
 *  ITSELF: `npm run release` produced a 30-day window that `release:build` then
 *  rejected. A floor and a default that can disagree are two policies wearing
 *  one name. Both import this. */
export const MIN_EXPIRY_HORIZON_DAYS = 365;

/** The horizon a publish uses when nobody names one. Far enough out that no
 *  server still gating on the field is stranded within any plausible support
 *  window, and re-anchored on every cut so it never creeps toward the floor. */
export const DEFAULT_EXPIRY_HORIZON_DAYS = 3650;

import { sign } from './minisign.js';
import {
  parseManifest,
  type BinaryArtifact,
  type ChannelName,
  type DockerArtifact,
  type Platform,
  type ReleaseManifest,
} from './manifest.js';
import { webclientArtifactTrustedComment } from './webclient-archive.js';

export interface ChannelInput {
  version: string;
  released_at: string;
  min_supported: string;
  migration: boolean;
  rollout_pct: number;
  notes_url: string;
  /** Per-platform downloadable binaries — each already sha256'd + signed. */
  binaries: Partial<Record<Platform, BinaryArtifact>>;
  /** D-178 S1 rev 2 item 2 — the per-triple native sidecar, keyed `lib-<triple>`
   *  and already sha256'd + signed. The SEA binary cannot embed a `.node`, so
   *  each binary is USELESS without its pair — `release-build.mjs` refuses to
   *  emit one without the other, and this stays a plain map only because the
   *  pairing is enforced upstream where the files are on disk to check. */
  libs?: Partial<Record<`lib-${Platform}`, BinaryArtifact>>;
  dockerBaked?: DockerArtifact;
  dockerThin?: DockerArtifact;
  /** The arch-neutral webclient bundle archive — already sha256'd + signed
   *  (a `webclient-<version>.bundle.json`). Optional: a binaries-only release
   *  simply omits it, and consumers that don't self-update the webclient
   *  (the baked docker image) ignore it. */
  webclient?: BinaryArtifact;
}

export interface ManifestInput {
  sequence: number;
  expires_at: string;
  min_launcher_version: number;
  channels: Partial<Record<ChannelName, ChannelInput>>;
}

/** Assemble + self-validate a `ReleaseManifest`. Throws (via `parseManifest`)
 *  if any channel ends up with a binary missing its `sig` or a docker artifact
 *  missing its `digest` — a malformed manifest never reaches the CDN. */
export const assembleManifest = (input: ManifestInput): ReleaseManifest => {
  const channels: Record<string, unknown> = {};
  for (const [name, ch] of Object.entries(input.channels)) {
    if (!ch) continue;
    const artifacts: Record<string, unknown> = { ...ch.binaries };
    if (ch.dockerBaked) artifacts['docker-baked'] = ch.dockerBaked;
    if (ch.dockerThin) artifacts['docker-thin'] = ch.dockerThin;
    if (ch.webclient) artifacts['webclient'] = ch.webclient;
    if (ch.libs) Object.assign(artifacts, ch.libs);
    channels[name] = {
      version: ch.version,
      released_at: ch.released_at,
      min_supported: ch.min_supported,
      migration: ch.migration,
      rollout_pct: ch.rollout_pct,
      notes_url: ch.notes_url,
      artifacts,
    };
  }

  const raw = {
    schema_version: 1,
    sequence: input.sequence,
    expires_at: input.expires_at,
    min_launcher_version: input.min_launcher_version,
    channels,
  };

  // Round-trip through the consumer's own parser so the published manifest is
  // exactly as strict as what every verifier accepts.
  return parseManifest(JSON.stringify(raw));
};

/** The EXACT published bytes: 2-space pretty JSON + trailing newline. The
 *  detached manifest sig is computed over this string; consumers verify the
 *  sig over the file as fetched. Deterministic for a given manifest object. */
export const serializeManifest = (manifest: ReleaseManifest): string =>
  `${JSON.stringify(manifest, null, 2)}\n`;

/** Trusted-comment binding for a binary artifact — pins file name + version so
 *  a valid signature can't be swapped onto a different artifact (§ Signing). */
export const artifactTrustedComment = (fileName: string, version: string): string =>
  `recued binary ${fileName} v${version}`;

/** Trusted-comment binding for the manifest — pins the monotonic sequence so a
 *  signature can't be lifted onto a replayed/older manifest body. */
export const manifestTrustedComment = (sequence: number): string =>
  `recued release manifest seq ${sequence}`;

export interface SignKey {
  secretSeed: Uint8Array;
  keyId: Uint8Array;
}

export interface SignedManifest {
  /** The published manifest bytes (write verbatim to the CDN). */
  json: string;
  /** The detached `.minisig` over `json`. */
  sig: string;
}

/** Serialize + minisign-sign a manifest. The returned `json`/`sig` pair is what
 *  ships: `<cdn>/manifest.json` + `<cdn>/manifest.json.minisig`. */
export const signManifest = (manifest: ReleaseManifest, key: SignKey): SignedManifest => {
  const json = serializeManifest(manifest);
  const sig = sign({
    content: Buffer.from(json, 'utf8'),
    secretSeed: key.secretSeed,
    keyId: key.keyId,
    trustedComment: manifestTrustedComment(manifest.sequence),
  });
  return { json, sig };
};

/** Sign one binary artifact's bytes → its detached `.minisig`. Used per
 *  platform before the artifact's `sig` field is folded into the manifest. */
export const signArtifact = (args: {
  content: Uint8Array;
  fileName: string;
  version: string;
  key: SignKey;
}): string =>
  sign({
    content: args.content,
    secretSeed: args.key.secretSeed,
    keyId: args.key.keyId,
    trustedComment: artifactTrustedComment(args.fileName, args.version),
  });

/** Sign the webclient bundle archive's bytes → its detached `.minisig`. Mirrors
 *  `signArtifact` but binds the WEBCLIENT trusted comment (so a webclient sig can
 *  never be lifted onto a binary artifact of the same version, or vice versa). */
export const signWebclientArchive = (args: {
  content: Uint8Array;
  fileName: string;
  version: string;
  key: SignKey;
}): string =>
  sign({
    content: args.content,
    secretSeed: args.key.secretSeed,
    keyId: args.key.keyId,
    trustedComment: webclientArtifactTrustedComment(args.fileName, args.version),
  });
