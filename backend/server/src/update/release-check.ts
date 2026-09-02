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

import {
  parseManifest,
  resolveChannelTarget,
  resolveRelease,
  verify,
  type BinaryArtifact,
  type ChannelName,
  type Platform,
  type ReleaseManifest,
  type ReleaseResolution,
} from '@recued/release';
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
  /** How this server was installed. Docker channels need the exact signed
   * image@digest on every consumer surface because they cannot self-apply a
   * registry image by following a mutable tag. */
  distributionChannel?: 'binary' | 'docker-baked' | 'docker-thin' | 'source';
  /** Running version (semver). */
  currentVersion: string;
  platform: Platform;
  /** Managed thin-launcher metadata version, when launcher-managed. */
  launcherVersion?: number;
  loadState: () => ReleaseCheckState;
  saveState: (state: ReleaseCheckState) => void;
  /** The INSTALL-WIDE anti-replay floor, read from `<binaryDir>/.release-sequence`.
   *
   *  ⛔ TWO STORES, ONE INVARIANT. install.sh keeps its floor in a file beside the
   *  binary; each realm keeps one in its own SQLite. Neither could see the other,
   *  so a manifest the installer had already refused as a replay was still
   *  honoured by the server (and a realm restored from an older backup silently
   *  lowered its own floor). Taking the MAX makes the refusal a property of the
   *  HOST rather than of whichever actuator happened to look. */
  hostSequenceFloor?: () => number;
  /** Raise that same file. Best-effort — see `host-sequence-floor.ts`.
   *
   *  ⛔⛔ WITHOUT THIS, "A PROPERTY OF THE HOST" WAS FALSE ACROSS REALMS. Reading
   *  the shared file but never writing it meant server acceptance stayed in the
   *  realm that did the accepting: realm A at sequence 300 left realm B — same
   *  executable, its own database — free to accept a replayed 250. Running two
   *  realms on one host is supported (`update-lease.ts` keys the lease on the
   *  binary for exactly that reason), so this was a live gap, not a theoretical
   *  one.
   *
   *  ⚠ ABSENT → PER-REALM, THE OLD BEHAVIOUR. A harness that does not wire it,
   *  or a prefix that cannot be written, degrades to what shipped before rather
   *  than failing the check. */
  advanceHostSequenceFloor?: (sequence: number) => void;
  /** Wall-clock now in ms. */
  now: () => number;
}

const echo = (deps: ReleaseCheckDeps): Pick<ReleaseCheckResponse, 'current_version' | 'channel'> => ({
  current_version: deps.currentVersion,
  channel: deps.channel,
});

const verifiedDockerTarget = (
  deps: Pick<ReleaseCheckDeps, 'distributionChannel' | 'channel'>,
  manifest: ReleaseManifest,
): ReleaseCheckResponse['docker'] | undefined => {
  const artifactKey = deps.distributionChannel === 'docker-baked'
    ? 'docker-baked'
    : deps.distributionChannel === 'docker-thin'
      ? 'docker-thin'
      : null;
  if (artifactKey === null) return undefined;
  const selected = resolveChannelTarget(manifest, deps.channel);
  if (!selected) return undefined;
  const artifact = selected.release.artifacts[artifactKey];
  if (!artifact) return undefined;
  return {
    artifact: artifactKey,
    version: selected.release.version,
    // Identity remains the INSTALL'S release channel. Edge legitimately falls
    // back to stable bytes while retaining an edge operation identity.
    release_identity: releaseIdentityOf(deps.channel, selected.release.version),
    image: artifact.image,
    digest: artifact.digest,
    pull_ref: `${artifact.image}@${artifact.digest}`,
    notes_url: selected.release.notes_url,
  };
};

/** One projection for both check and apply resolution. The scheduled auto path
 * must not fetch the feed a second time merely to explain why it did not apply;
 * carrying this report beside the concrete artifact keeps notification bound
 * to the exact signed manifest and local policy decision already resolved. */
const projectCheckResponse = (
  deps: ReleaseCheckDeps,
  manifest: ReleaseManifest,
  resolution: ReleaseResolution,
): ReleaseCheckResponse => {
  const docker = verifiedDockerTarget(deps, manifest);
  switch (resolution.status) {
    case 'replay':
      return { status: 'replay', ...echo(deps), sequence: resolution.sequence };
    case 'launcher-outdated':
      return { status: 'launcher-outdated', ...echo(deps), ...(docker ? { docker } : {}) };
    case 'up-to-date':
      return { status: 'up-to-date', ...echo(deps), sequence: resolution.sequence };
    case 'update-available':
      return {
        status: 'update-available',
        ...echo(deps),
        sequence: resolution.sequence,
        ...(docker ? { docker } : {}),
        available: {
          version: resolution.targetVersion,
          release_identity: releaseIdentityOf(resolution.channel, resolution.targetVersion),
          migration: resolution.migration,
          is_major: resolution.isMajor,
          below_min_supported: resolution.belowMinSupported,
          in_rollout_cohort: resolution.inRolloutCohort,
          rollout_pct: resolution.rolloutPct,
          auto_apply_eligible: resolution.autoApplyEligible,
          notes_url: resolution.release.notes_url,
        },
      };
  }
};

/** The floor that actually applies: the higher of this realm's recorded value
 *  and the install-wide one. A malformed or absent file contributes 0, so a host
 *  that has never run the new installer behaves exactly as before. */
const effectiveFloor = (
  deps: Pick<ReleaseCheckDeps, 'hostSequenceFloor'>,
  state: { highest_accepted_sequence: number },
): number => {
  let installer = 0;
  try {
    const raw = deps.hostSequenceFloor?.() ?? 0;
    if (Number.isInteger(raw) && raw >= 0) installer = raw;
  } catch {
    /* unreadable is not a reason to lower the floor */
  }
  return Math.max(state.highest_accepted_sequence, installer);
};

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
    highestAcceptedSequence: effectiveFloor(deps, state),
    nowMs: deps.now(),
    launcherVersion: deps.launcherVersion,
  });
  advanceReplayFloor(deps, state, manifest.sequence, resolution.status);
  return projectCheckResponse(deps, manifest, resolution);
};

/** The release identity convention — `<channel>:<version>` — shared by the
 *  apply lock, the boot-failure counter key, and the on-boot commit decision.
 *  A single derivation so the staged binary's self-report and the ledger entry
 *  it must match are computed the same way. */
/** Remember the highest sequence we have accepted under a valid signature (I-10).
 *
 *  ⛔ ONE RULE, BOTH RESOLVERS. The check and the apply resolver each fetch,
 *  verify and resolve the same manifest, and the floor is the memory that makes a
 *  replay refusable afterwards. Two copies of "when do we remember this" is one
 *  copy too many — the apply path drifted to NOT remembering at all, and the
 *  comment explaining why outlived the behaviour it described being wrong about.
 *
 *  ⚠ ON ANY NON-REPLAY OUTCOME, not just an installable one. `launcher-outdated`
 *  is a refusal to ACT on a manifest, not a doubt about it: the signature
 *  verified and the sequence is real, so forgetting it would leave exactly that
 *  manifest replayable later. (`stale-feed` was the other such outcome until the
 *  freshness gate was removed — see `resolve.ts`.)
 *
 *  ⚠ HIGHER ONLY. Equal is the manifest we already accepted, re-fetched — writing
 *  it back would be a no-op with a disk write attached.
 *
 *  ⛔ THE HOST FILE IS ADVANCED OUTSIDE THAT "HIGHER ONLY" GUARD, ON PURPOSE.
 *  Nesting it under the realm's own advance would mean a realm already at this
 *  sequence never re-states it, so a host file left behind — by an installer
 *  write that raced this one, or by a prefix that was briefly unwritable — would
 *  stay behind until some realm happened to see a HIGHER release. Restating it
 *  on every non-replay resolution is what makes the shared floor self-heal; the
 *  writer itself is monotone and returns without touching disk when there is
 *  nothing to do. */
const advanceReplayFloor = (
  deps: Pick<ReleaseCheckDeps, 'saveState' | 'advanceHostSequenceFloor'>,
  state: ReleaseCheckState,
  sequence: number,
  status: string,
): void => {
  if (status === 'replay') return;
  deps.advanceHostSequenceFloor?.(sequence);
  if (sequence <= state.highest_accepted_sequence) return;
  deps.saveState({ ...state, highest_accepted_sequence: sequence });
};

export const releaseIdentityOf = (channel: ChannelName, version: string): string => `${channel}:${version}`;

/** What `resolveForApply` resolved to: the apply target (artifact + identity),
 *  or a non-applyable outcome (mirrors the check statuses the apply path must
 *  refuse on). `not-configured` covers the empty-key pre-GA case; the rest are
 *  the resolve outcomes that aren't an installable artifact for this platform. */
type ResolveForApplyOutcome =
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
      /** Cohort membership on its own — `autoApplyEligible` ANDs it with
       *  not-major, so it cannot tell a caller WHY it is false. A manual apply
       *  needs the distinction: outside the cohort is a bypass to confirm and
       *  audit; a major is a different gate entirely. */
      inRolloutCohort: boolean;
      /** The channel's rollout percentage, so a bypass prompt can state it. */
      rolloutPct: number;
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

/** The check projection is carried on every outcome from the SAME fetch and
 * resolve. Auto mode can therefore report a major/out-of-cohort release, a
 * missing native artifact, or a launcher recovery target without a racy second
 * request and without silently discarding the intervention. */
export type ResolveForApplyResult = ResolveForApplyOutcome & {
  report: ReleaseCheckResponse;
};

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
    return { status: 'not-configured', report: { status: 'not-configured', ...echo(deps) } };
  }

  let manifestText: string;
  let sigText: string;
  try {
    [manifestText, sigText] = await Promise.all([
      deps.fetchText(deps.manifestUrl),
      deps.fetchText(sigUrlFor(deps.manifestUrl)),
    ]);
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'fetch error';
    return { status: 'fetch-failed', detail, report: { status: 'fetch-failed', ...echo(deps), detail } };
  }

  const v = verify({
    content: Buffer.from(manifestText, 'utf8'),
    signatureText: sigText,
    publicKeyText: deps.trustedPubkey,
  });
  if (!v.ok) {
    const detail = v.reason ?? 'signature verification failed';
    return { status: 'bad-signature', detail, report: { status: 'bad-signature', ...echo(deps), detail } };
  }

  let manifest;
  try {
    manifest = parseManifest(manifestText);
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'malformed manifest';
    return { status: 'bad-signature', detail, report: { status: 'bad-signature', ...echo(deps), detail } };
  }

  const state = deps.loadState();
  const resolution = resolveRelease({
    manifest,
    channel: deps.channel,
    currentVersion: deps.currentVersion,
    platform: deps.platform,
    salt: state.salt,
    highestAcceptedSequence: effectiveFloor(deps, state),
    nowMs: deps.now(),
    launcherVersion: deps.launcherVersion,
  });
  const report = projectCheckResponse(deps, manifest, resolution);

  // ⛔⛔⛔ IT ADVANCES THE FLOOR, AND THE REASON IT DID NOT WAS FALSE. The note
  // here used to read: "apply is an ACTUATOR, not the anti-replay authority. If
  // it advanced the floor, a failed apply would re-resolve the SAME manifest as a
  // `replay` and lock out every retry until a higher sequence shipped."
  //
  // `resolve.ts` refuses only a STRICTLY lower sequence, and says why in the same
  // breath: equality is "the CURRENT manifest re-fetched, not a downgrade", kept
  // resolvable precisely so a re-poll and an apply-after-check still work. A
  // retry re-resolves its own sequence against a floor equal to it and passes.
  // The lockout the note protected against cannot happen.
  //
  // ⇒ What the note actually bought was a HOLE. `recued update apply` calls this
  // and NOTHING else — no check runs on that path — so an offline install could
  // resolve sequence 200, fail to stage it, and later accept a replayed,
  // still-in-date signed manifest at 150: the freeze/downgrade I-10 exists to
  // refuse. Verifying a signature and reading a higher sequence IS acceptance for
  // anti-replay purposes, whether or not the artifact behind it installs.
  advanceReplayFloor(deps, state, manifest.sequence, resolution.status);

  switch (resolution.status) {
    case 'replay':
      return { status: 'replay', report };
    case 'launcher-outdated':
      return { status: 'launcher-outdated', report };
    case 'up-to-date':
      return { status: 'up-to-date', report };
    case 'update-available':
      if (!resolution.artifact) return { status: 'no-artifact', report };
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
      if (!resolution.libArtifact) return { status: 'no-artifact', report };
      return {
        status: 'applyable',
        report,
        releaseIdentity: releaseIdentityOf(resolution.channel, resolution.targetVersion),
        fromVersion: resolution.currentVersion,
        toVersion: resolution.targetVersion,
        channel: deps.channel === 'edge' ? 'edge' : 'stable',
        migration: resolution.migration,
        isMajor: resolution.isMajor,
        autoApplyEligible: resolution.autoApplyEligible,
        inRolloutCohort: resolution.inRolloutCohort,
        rolloutPct: resolution.rolloutPct,
        artifact: resolution.artifact,
        libArtifact: resolution.libArtifact,
        webclientArtifact: resolution.release.artifacts.webclient ?? null,
      };
  }
};
