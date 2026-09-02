/** D-178 — channel resolution, anti-replay, freshness & local rollout (spec
 *  § Update machinery + § Release manifest).
 *
 *  Pure decision layer over an ALREADY signature-verified manifest (a consumer
 *  never reaches here with an unverified document — minisign.ts gates first).
 *  Everything is local: version comparison, anti-replay against the persisted
 *  highest-accepted `sequence` and staged-
 *  rollout eligibility from a per-install salt (I-1/I-7 — no identifier leaves
 *  the machine, the cloud serves no dynamic decision). The caller persists the
 *  new highest sequence on a non-`replay` outcome, and owns the manual-bypass
 *  path (`recued update` admits a not-yet-cohort release as an explicit audited
 *  act — resolve only reports cohort membership, it does not enforce it).
 */

import { createHash } from 'node:crypto';
import { libKeyFor } from './manifest.js';
import type { BinaryArtifact, ChannelName, ChannelRelease, DockerArtifact, Platform, ReleaseManifest } from './manifest.js';

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
}

export type ReleaseResolution =
  /** `sequence ≤ highestAccepted` — a replayed old-but-valid manifest; refuse. */
  | { status: 'replay'; sequence: number; highestAccepted: number }
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
      /** The channel's staged-rollout percentage. ⛔ CARRIED SEPARATELY FROM THE
       *  BOOLEAN because a bypass has to be able to STATE the odds: the spec's
       *  wording is "this release is in staged rollout (40%) — install anyway?",
       *  and "you are not in the cohort" alone cannot say 40. */
      rolloutPct: number;
      /** Derived: safe to auto-apply (in cohort AND not a major). */
      autoApplyEligible: boolean;
    };

/** Compare two CalVer versions — `yy.m.d` normally, `yy.m.d.n` for a same-day
 *  emergency. Returns <0, 0, >0. Numeric segment compare; a missing segment
 *  reads as 0, so today's triples order exactly as they always did; non-numeric
 *  trailers (pre-release tags) are ignored, failing toward "not newer".
 *
 *  ⛔⛔ THE FOURTH SEGMENT USED TO BE TRUNCATED — `slice(0, 3)` — WHICH MADE A
 *  HOTFIX INVISIBLE RATHER THAN REJECTED. `26.8.31.1` compared EQUAL to
 *  `26.8.31`, so `resolveRelease` hit its `<= 0` branch and answered
 *  `up-to-date`: the server accepted the new manifest (the anti-replay SEQUENCE
 *  gate is separate and passed) and then told the owner there was nothing to
 *  install. Silent, and on the one path that exists to deliver urgent fixes.
 *
 *  ⚠ THIS COMPARATOR RUNS ON THE INSTALLED SERVER, so the extension only helps
 *  servers that already carry it. That is survivable because of what the
 *  arithmetic actually does: a 4-part version is blind ONLY to servers running
 *  its exact base triple. `26.9.1.1` offered to a server on `26.8.31` truncates
 *  to `26.9.1` under the old comparator and still compares NEWER, so old servers
 *  take it fine. ⇒ the rule is: never hang a 4-part suffix off a triple that is
 *  already in the field. The release introducing this must itself be a plain
 *  triple (`26.9.1`), never `26.8.31.x`. */
export const compareVersions = (a: string, b: string): number => {
  const seg = (v: string): number[] =>
    v.split('.').slice(0, 4).map((s) => {
      const n = parseInt(s, 10);
      return Number.isFinite(n) ? n : 0;
    });
  const pa = seg(a);
  const pb = seg(b);
  for (let i = 0; i < 4; i++) {
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

/** Resolve the target release for `channel`, and say WHICH channel it came from.
 *  `edge` resolves to `max(stable, edge)` so a stable hotfix that leapfrogs edge
 *  still reaches edge users (spec § Channel ordering rule), and falls back to
 *  stable when no edge channel is declared. Returns null when neither is present.
 *
 *  ⛔⛔ THE ONE CHANNEL-SELECTION PRIMITIVE, AND IT IS EXPORTED BECAUSE IT WAS
 *  RE-IMPLEMENTED THREE TIMES AND GOT IT WRONG TWICE. `install.sh` read
 *  `.channels.edge` directly until it was fixed; `install.ps1` did the same and
 *  DIED on the live edge-path manifest, which declares only stable; and
 *  `selectInstallArtifact` — the exported, documented installer selector — still
 *  read the requested channel directly, so it picked edge `26.9.1` over stable
 *  `26.9.1.1` and answered `channel-missing` on a stable-only manifest.
 *
 *  🔑 Three copies of a rule is three chances to get it wrong, and "edge means
 *  max(stable, edge)" is exactly the kind of rule that reads as a lookup. The
 *  shell installers cannot import TypeScript and are ratcheted separately; every
 *  in-process caller uses THIS. */
export const resolveChannelTarget = (
  manifest: ReleaseManifest,
  channel: ChannelName,
): { channel: ChannelName; release: ChannelRelease } | null => {
  const { stable, edge } = manifest.channels;
  if (channel === 'stable') return stable ? { channel: 'stable', release: stable } : null;
  // edge
  if (edge && stable) {
    return compareVersions(stable.version, edge.version) > 0
      ? { channel: 'stable', release: stable }
      : { channel: 'edge', release: edge };
  }
  if (edge) return { channel: 'edge', release: edge };
  return stable ? { channel: 'stable', release: stable } : null;
};

const resolveTarget = (manifest: ReleaseManifest, channel: ChannelName): ChannelRelease | null =>
  resolveChannelTarget(manifest, channel)?.release ?? null;

/** Decide what (if anything) to do with a verified manifest for this install.
 *  Order: anti-replay → freshness → launcher gate → channel resolve → compare. */
export const resolveRelease = (input: ResolveInput): ReleaseResolution => {
  const { manifest, channel, currentVersion, platform, salt, highestAcceptedSequence, nowMs, launcherVersion } = input;
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

  // ⛔⛔ THERE IS NO FRESHNESS GATE, AND THAT IS A DECISION — 2026-09-01, owner.
  // This used to refuse a manifest past `expires_at` + a 7-day grace, and the
  // installer refused to install from one at all. The rule punished the wrong
  // party: a stale feed and an attacker-frozen feed are INDISTINGUISHABLE from
  // here, so the check could not tell "nothing shipped lately" from "someone is
  // starving you", and its only available response was to refuse the newest
  // release anyone actually has. With a seasonal release cadence that is a
  // scheduled outage of the install path in exchange for a freeze defence that
  // only bites if the feed is re-signed on a schedule.
  //
  // 🔑 `sequence` IS THE HALF THAT STILL DEFENDS. Anti-replay above refuses a
  // manifest BELOW the floor, so a downgrade is still impossible; what is given
  // up is the ability to notice a feed that has merely stopped moving. The
  // update rule is now the plain one: a legal newer release lights up
  // `update-available`.
  //
  // ⚠ `expires_at` IS STILL PUBLISHED, SIGNED AND PARSED — it is reference data
  // now, not a gate. `parseManifest` keeps validating its shape so the field
  // cannot quietly become garbage, and nothing reads it to make a decision.

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
    rolloutPct: release.rollout_pct,
    autoApplyEligible: cohort && !isMajor,
  };
};

export type { DockerArtifact };
