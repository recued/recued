/** D-178 slice 2 — the `update.check` orchestrator.
 *
 *  Fetch the signed release manifest + its detached minisign signature, verify
 *  (I-2 — fail-closed), parse, and resolve LOCALLY against this install
 *  (anti-replay / freshness / channel / rollout — I-1/I-7/I-10). On a
 *  non-replay outcome the install's highest-accepted `sequence` advances so a
 *  later replay of an older-but-valid manifest is refused.
 *
 *  Pure orchestration over injected primitives (fetch / clock / state) so the
 *  whole decision path is unit-testable without a network or a clock. The
 *  embedded trusted pubkey is the frozen integrity boundary; an empty key (no
 *  signing identity wired yet — pre-GA / db-less harness) short-circuits to
 *  `not-configured` rather than fetching anything.
 */

import { parseManifest, resolveRelease, verify, type BinaryArtifact, type ChannelName, type Platform } from '@recued/release';
import type { ReleaseCheckResponse } from '@recued/contracts';
import type { ReleaseCheckState } from './release-state-store.js';

/** Detached-signature URL convention: `<manifest>.minisig` alongside. */
export const sigUrlFor = (manifestUrl: string): string => `${manifestUrl}.minisig`;

export interface ReleaseCheckDeps {
  /** Embedded trusted release pubkey (minisign format). Empty → not-configured. */
  trustedPubkey: string;
  /** Stable manifest URL; the detached sig is `<url>.minisig`. */
  manifestUrl: string;
  /** Fetch a URL as text. Throws on transport/HTTP failure. */
  fetchText: (url: string) => Promise<string>;
  channel: ChannelName;
  /** Running version (semver). */
  currentVersion: string;
  platform: Platform;
  /** Managed thin-launcher metadata version, when launcher-managed. */
  launcherVersion?: number;
  loadState: () => ReleaseCheckState;
  saveState: (state: ReleaseCheckState) => void;
  /** Wall-clock now in ms. */
  now: () => number;
}

const echo = (deps: ReleaseCheckDeps): Pick<ReleaseCheckResponse, 'current_version' | 'channel'> => ({
  current_version: deps.currentVersion,
  channel: deps.channel,
});

export const runReleaseCheck = async (deps: ReleaseCheckDeps): Promise<ReleaseCheckResponse> => {
  if (!deps.trustedPubkey || deps.trustedPubkey.length === 0) {
    return { status: 'not-configured', ...echo(deps) };
  }

  let manifestText: string;
  let sigText: string;
  try {
    [manifestText, sigText] = await Promise.all([
      deps.fetchText(deps.manifestUrl),
      deps.fetchText(sigUrlFor(deps.manifestUrl)),
    ]);
  } catch (err) {
    return { status: 'fetch-failed', ...echo(deps), detail: err instanceof Error ? err.message : 'fetch error' };
  }

  // I-2 — verify BEFORE parsing/acting on a single field.
  const v = verify({
    content: Buffer.from(manifestText, 'utf8'),
    signatureText: sigText,
    publicKeyText: deps.trustedPubkey,
  });
  if (!v.ok) {
    return { status: 'bad-signature', ...echo(deps), detail: v.reason };
  }

  let manifest;
  try {
    manifest = parseManifest(manifestText);
  } catch (err) {
    // A signed-but-malformed manifest is an integrity problem, not a fetch one.
    return { status: 'bad-signature', ...echo(deps), detail: err instanceof Error ? err.message : 'malformed manifest' };
  }

  const state = deps.loadState();
  const resolution = resolveRelease({
    manifest,
    channel: deps.channel,
    currentVersion: deps.currentVersion,
    platform: deps.platform,
    salt: state.salt,
    highestAcceptedSequence: state.highest_accepted_sequence,
    nowMs: deps.now(),
    launcherVersion: deps.launcherVersion,
  });

  // Advance the anti-replay floor on any non-replay outcome — once we've seen a
  // higher sequence under a valid signature, an older one must never be honored.
  if (resolution.status !== 'replay' && manifest.sequence > state.highest_accepted_sequence) {
    deps.saveState({ ...state, highest_accepted_sequence: manifest.sequence });
  }

  switch (resolution.status) {
    case 'replay':
      return { status: 'replay', ...echo(deps), sequence: resolution.sequence };
    case 'stale-feed':
      return { status: 'stale-feed', ...echo(deps), sequence: resolution.sequence, expires_at: resolution.expiresAt };
    case 'launcher-outdated':
      return { status: 'launcher-outdated', ...echo(deps) };
    case 'up-to-date':
      return { status: 'up-to-date', ...echo(deps), sequence: resolution.sequence };
    case 'update-available':
      return {
        status: 'update-available',
        ...echo(deps),
        sequence: resolution.sequence,
        available: {
          version: resolution.targetVersion,
          migration: resolution.migration,
          is_major: resolution.isMajor,
          below_min_supported: resolution.belowMinSupported,
          in_rollout_cohort: resolution.inRolloutCohort,
          auto_apply_eligible: resolution.autoApplyEligible,
          notes_url: resolution.release.notes_url,
        },
      };
  }
};

/** The release identity convention — `<channel>:<version>` — shared by the
 *  apply lock, the boot-failure counter key, and the on-boot commit decision.
 *  A single derivation so the staged binary's self-report and the ledger entry
 *  it must match are computed the same way. */
export const releaseIdentityOf = (channel: ChannelName, version: string): string => `${channel}:${version}`;

/** What `resolveForApply` resolved to: the apply target (artifact + identity),
 *  or a non-applyable outcome (mirrors the check statuses the apply path must
 *  refuse on). `not-configured` covers the empty-key pre-GA case; the rest are
 *  the resolve outcomes that aren't an installable artifact for this platform. */
export type ResolveForApplyResult =
  | {
      status: 'applyable';
      releaseIdentity: string;
      fromVersion: string;
      toVersion: string;
      channel: 'stable' | 'edge';
      migration: boolean;
      /** Major bump — notify-only, never auto-applied (I-4). */
      isMajor: boolean;
      /** In the local staged-rollout cohort AND not a major (I-4/I-7). */
      autoApplyEligible: boolean;
      artifact: BinaryArtifact;
      /** D-178 S1 rev 2 item 4 — the native `lib/` sidecar for the SAME triple.
       *  NON-NULL by construction: an `applyable` release without one is refused
       *  as `no-artifact` below, because a self-apply channel is always a SEA and
       *  a SEA without its addon cannot open its database. */
      libArtifact: BinaryArtifact;
      /** D-152 § A.16 — the release's webclient bundle archive, or null when the
       *  manifest carries none (binaries-only release). Best-effort synced to
       *  RECUED_WEBCLIENT_DIR by the apply after the binary swap. */
      webclientArtifact: BinaryArtifact | null;
    }
  | { status: 'not-configured' }
  | { status: 'fetch-failed'; detail: string }
  | { status: 'bad-signature'; detail: string }
  | { status: 'up-to-date' }
  | { status: 'stale-feed' }
  | { status: 'launcher-outdated' }
  | { status: 'replay' }
  | { status: 'no-artifact' };

/** Re-run the signed fetch/verify/resolve, returning the concrete artifact +
 *  release identity the apply orchestrator needs. Deliberately a SEPARATE call
 *  from `runReleaseCheck` (the wire projection drops the artifact + signature
 *  for the UI card); both walk the SAME I-2 verify boundary, so an apply never
 *  trusts a manifest the check wouldn't. UNLIKE the check it does NOT advance
 *  the anti-replay floor — see the NOTE at the resolve below for why, and do
 *  not "restore" it. A resolved-but-no-binary release
 *  (unsupported platform, docker-only artifacts) returns `no-artifact` — the
 *  binary apply path has nothing to install. */
export const resolveForApply = async (deps: ReleaseCheckDeps): Promise<ResolveForApplyResult> => {
  if (!deps.trustedPubkey || deps.trustedPubkey.length === 0) {
    return { status: 'not-configured' };
  }

  let manifestText: string;
  let sigText: string;
  try {
    [manifestText, sigText] = await Promise.all([
      deps.fetchText(deps.manifestUrl),
      deps.fetchText(sigUrlFor(deps.manifestUrl)),
    ]);
  } catch (err) {
    return { status: 'fetch-failed', detail: err instanceof Error ? err.message : 'fetch error' };
  }

  const v = verify({
    content: Buffer.from(manifestText, 'utf8'),
    signatureText: sigText,
    publicKeyText: deps.trustedPubkey,
  });
  if (!v.ok) return { status: 'bad-signature', detail: v.reason ?? 'signature verification failed' };

  let manifest;
  try {
    manifest = parseManifest(manifestText);
  } catch (err) {
    return { status: 'bad-signature', detail: err instanceof Error ? err.message : 'malformed manifest' };
  }

  const state = deps.loadState();
  const resolution = resolveRelease({
    manifest,
    channel: deps.channel,
    currentVersion: deps.currentVersion,
    platform: deps.platform,
    salt: state.salt,
    highestAcceptedSequence: state.highest_accepted_sequence,
    nowMs: deps.now(),
    launcherVersion: deps.launcherVersion,
  });

  // NOTE: unlike `runReleaseCheck`, the apply resolver does NOT advance the
  // anti-replay floor — apply is an ACTUATOR, not the anti-replay authority. If
  // it advanced the floor, a failed apply (verify/download/stage error) would
  // re-resolve the SAME manifest as a `replay` and lock out every retry until a
  // higher sequence shipped. The check owns floor maintenance.

  switch (resolution.status) {
    case 'replay':
      return { status: 'replay' };
    case 'stale-feed':
      return { status: 'stale-feed' };
    case 'launcher-outdated':
      return { status: 'launcher-outdated' };
    case 'up-to-date':
      return { status: 'up-to-date' };
    case 'update-available':
      if (!resolution.artifact) return { status: 'no-artifact' };
      // D-178 S1 rev 2 item 4 — the exe and its native addon are ONE artifact
      // for apply purposes. Both self-apply channels (`binary`, `docker-thin`)
      // run the SEA, which loads `<binDir>/lib/better_sqlite3.node` at the first
      // database open; installing the exe alone yields a server that boots far
      // enough to look healthy and then cannot open its database.
      //
      // ⛔ FAIL CLOSED, and refuse HERE rather than mid-apply: no ledger entry,
      // no download, no swap — a clean `not-available` the owner can act on. The
      // release pipeline already refuses to PUBLISH an unpaired binary
      // (`release-build.mjs`), so this should only ever fire on a hand-rolled or
      // tampered manifest. Note `runReleaseCheck` is a separate call, so the
      // update card still SHOWS the release — only applying it is refused.
      if (!resolution.libArtifact) return { status: 'no-artifact' };
      return {
        status: 'applyable',
        releaseIdentity: releaseIdentityOf(resolution.channel, resolution.targetVersion),
        fromVersion: resolution.currentVersion,
        toVersion: resolution.targetVersion,
        channel: deps.channel === 'edge' ? 'edge' : 'stable',
        migration: resolution.migration,
        isMajor: resolution.isMajor,
        autoApplyEligible: resolution.autoApplyEligible,
        artifact: resolution.artifact,
        libArtifact: resolution.libArtifact,
        webclientArtifact: resolution.release.artifacts.webclient ?? null,
      };
  }
};
