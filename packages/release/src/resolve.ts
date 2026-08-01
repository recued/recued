/** D-178 — channel resolution, anti-replay, freshness & local rollout (spec
 *  § Update machinery + § Release manifest).
 *
 *  Pure decision layer over an ALREADY signature-verified manifest (a consumer
 *  never reaches here with an unverified document — minisign.ts gates first).
 *  Everything is local: version comparison, anti-replay against the persisted
 *  highest-accepted `sequence`, freshness against `expires_at`, and staged-
 *  rollout eligibility from a per-install salt (I-1/I-7 — no identifier leaves
 *  the machine, the cloud serves no dynamic decision). The caller persists the
 *  new highest sequence on a non-`replay` outcome, and owns the manual-bypass
 *  path (`recued update` admits a not-yet-cohort release as an explicit audited
 *  act — resolve only reports cohort membership, it does not enforce it).
 */

import { createHash } from 'node:crypto';
import { libKeyFor } from './manifest.js';
import type { BinaryArtifact, ChannelName, ChannelRelease, DockerArtifact, Platform, ReleaseManifest } from './manifest.js';

/** Default freshness grace past `expires_at` before a manifest reads as a
 *  "stale release feed" rather than "no update" (I-10). ~7 days — generous
 *  enough to ride out a missed re-sign without nagging. */
export const DEFAULT_FRESHNESS_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

export interface ResolveInput {
  /** A manifest whose detached minisign signature has ALREADY been verified. */
  manifest: ReleaseManifest;
  /** The channel this install follows. */
  channel: ChannelName;
  /** The running version (semver `major.minor.patch`). */
  currentVersion: string;
  /** Target triple for selecting the binary artifact. */
  platform: Platform;
  /** Per-install random salt, persisted once; drives rollout eligibility. */
  salt: string;
  /** Highest `sequence` this install has ever accepted (I-10 anti-replay floor). */
  highestAcceptedSequence: number;
  /** Wall-clock now in ms (injected — never read the clock in here). */
  nowMs: number;
  /** The managed thin-launcher's metadata version, when launcher-managed.
   *  Omit for plain binary installs (no launcher → no I-9 launcher gate). */
  launcherVersion?: number;
  /** Override the freshness grace window. */
  freshnessGraceMs?: number;
}

export type ReleaseResolution =
  /** `sequence ≤ highestAccepted` — a replayed old-but-valid manifest; refuse. */
  | { status: 'replay'; sequence: number; highestAccepted: number }
  /** Past `expires_at` + grace — surface a "stale release feed" notify (I-10). */
  | { status: 'stale-feed'; expiresAt: string; sequence: number }
  /** Launcher below `min_launcher_version` — stop applying, notify (I-9). */
  | { status: 'launcher-outdated'; required: number; current: number }
  /** Target ≤ current on the resolved channel — nothing to do. */
  | { status: 'up-to-date'; currentVersion: string; sequence: number }
  | {
      status: 'update-available';
      sequence: number;
      channel: ChannelName;
      currentVersion: string;
      targetVersion: string;
      release: ChannelRelease;
      /** The platform binary artifact, or null (docker installs pick a docker
       *  artifact off `release.artifacts` themselves). */
      artifact: BinaryArtifact | null;
      /** D-178 S1 rev 2 — the native `lib/` sidecar for the SAME triple, or
       *  null when the release carries none.
       *
       *  ⛔ A non-null `artifact` with a null `libArtifact` is an
       *  exe-without-its-native-module: it installs and then cannot open its
       *  database. Consumers that ACT on the binary must treat the pair as
       *  all-or-nothing; consumers that merely REPORT (the check card, the CLI)
       *  should still surface the release. */
      libArtifact: BinaryArtifact | null;
      /** This release migrates the schema on boot (rollback-rule input). */
      migration: boolean;
      /** Major bump from current — notify-only, never auto-apply (I-4). */
      isMajor: boolean;
      /** Running version is below the release's `min_supported` — URGENT notify. */
      belowMinSupported: boolean;
      /** Local staged-rollout eligibility: sha256(salt) % 100 < rollout_pct. */
      inRolloutCohort: boolean;
      /** Derived: safe to auto-apply (in cohort AND not a major). */
      autoApplyEligible: boolean;
    };

/** Compare two `major.minor.patch` semvers. Returns <0, 0, >0. Numeric segment
 *  compare; a missing segment reads as 0; non-numeric trailers (pre-release
 *  tags) are ignored for ordering — releases on the update channels are plain
 *  triples, and ignoring trailers fails toward "not newer". */
export const compareVersions = (a: string, b: string): number => {
  const seg = (v: string): number[] =>
    v.split('.').slice(0, 3).map((s) => {
      const n = parseInt(s, 10);
      return Number.isFinite(n) ? n : 0;
    });
  const pa = seg(a);
  const pb = seg(b);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
};

const majorOf = (v: string): number => {
  const n = parseInt(v.split('.')[0] ?? '', 10);
  return Number.isFinite(n) ? n : 0;
};

/** Local rollout eligibility — deterministic from the persisted per-install
 *  salt, so bumping `rollout_pct` admits more of the fleet without any
 *  identifier crossing the wire (I-1/I-7). */
export const inRolloutCohort = (salt: string, rolloutPct: number): boolean => {
  if (rolloutPct >= 100) return true;
  if (rolloutPct <= 0) return false;
  const digest = createHash('sha256').update(salt, 'utf8').digest();
  // First byte is enough entropy for a 0–99 bucket; mod-100 keeps it deterministic.
  return (digest.readUInt32BE(0) % 100) < rolloutPct;
};

/** Resolve the target release for `channel`. `edge` resolves to
 *  `max(stable, edge)` so a stable hotfix that leapfrogs edge still reaches
 *  edge users (spec § Channel ordering rule). Returns null when no release is
 *  present for the resolved channel. */
const resolveTarget = (manifest: ReleaseManifest, channel: ChannelName): ChannelRelease | null => {
  const { stable, edge } = manifest.channels;
  if (channel === 'stable') return stable ?? null;
  // edge
  if (edge && stable) return compareVersions(stable.version, edge.version) > 0 ? stable : edge;
  return edge ?? stable ?? null;
};

/** Decide what (if anything) to do with a verified manifest for this install.
 *  Order: anti-replay → freshness → launcher gate → channel resolve → compare. */
export const resolveRelease = (input: ResolveInput): ReleaseResolution => {
  const { manifest, channel, currentVersion, platform, salt, highestAcceptedSequence, nowMs, launcherVersion } = input;
  const grace = input.freshnessGraceMs ?? DEFAULT_FRESHNESS_GRACE_MS;
  const sequence = manifest.sequence;

  // I-10 anti-replay: a manifest STRICTLY below the highest sequence we ever
  // accepted is a replay (freeze/downgrade attempt) — refuse outright. Equal to
  // the floor is the CURRENT manifest re-fetched, not a downgrade: re-polling
  // `update.check` must stay idempotent, and an `update.apply` that re-resolves
  // the same manifest the check already advanced the floor past must still
  // resolve to that release rather than locking out as a phantom replay.
  if (sequence < highestAcceptedSequence) {
    return { status: 'replay', sequence, highestAccepted: highestAcceptedSequence };
  }

  // Freshness: past expiry + grace, the feed is too old to act on — a "stale
  // release feed" notify, never silently read as "no update".
  const expiresMs = Date.parse(manifest.expires_at);
  if (Number.isFinite(expiresMs) && nowMs > expiresMs + grace) {
    return { status: 'stale-feed', expiresAt: manifest.expires_at, sequence };
  }

  // I-9 launcher gate: a launcher below the manifest's floor stops applying and
  // notifies (the verification contract may have changed under it).
  if (launcherVersion !== undefined && launcherVersion < manifest.min_launcher_version) {
    return { status: 'launcher-outdated', required: manifest.min_launcher_version, current: launcherVersion };
  }

  const release = resolveTarget(manifest, channel);
  if (!release || compareVersions(release.version, currentVersion) <= 0) {
    return { status: 'up-to-date', currentVersion, sequence };
  }

  const isMajor = majorOf(release.version) > majorOf(currentVersion);
  const belowMinSupported = compareVersions(currentVersion, release.min_supported) < 0;
  const cohort = inRolloutCohort(salt, release.rollout_pct);
  const artifact = release.artifacts[platform] ?? null;
  // D-178 S1 rev 2 — the native sidecar for THIS triple. Resolved here, beside
  // the binary, so no consumer has to know the key naming; `libKeyFor` is the
  // single source of that.
  //
  // ⚠ Returned as `null` when absent rather than throwing, because a release
  // MAY legitimately have no sidecar (a docker-only channel, or a pre-sidecar
  // manifest). The pairing requirement is enforced where the binary is APPLIED
  // — refusing there is recoverable, refusing here would make the whole check
  // fail and hide an available release from the owner.
  const libArtifact = release.artifacts[libKeyFor(platform)] ?? null;

  return {
    status: 'update-available',
    sequence,
    channel,
    currentVersion,
    targetVersion: release.version,
    release,
    artifact,
    libArtifact,
    migration: release.migration,
    isMajor,
    belowMinSupported,
    inRolloutCohort: cohort,
    autoApplyEligible: cohort && !isMajor,
  };
};

export type { DockerArtifact };
