/**
 * Live release compatibility at the consumer boundary.
 *
 * ⛔ `sequence` ORDERS MANIFESTS, NOT RELEASES. The publisher refuses a candidate
 * whose sequence does not advance past every authenticated live pointer, and each
 * install refuses a replay below its floor — but a higher-sequence manifest can
 * still carry a release that is not forward, and no consumer refuses it:
 *
 *   · an OLDER version. Installs already past it answer `up-to-date` and stay,
 *     while every install still below the live release, and every fresh install,
 *     is sent the older one instead. That is not a rollback path either: the
 *     documented recovery for a bad release is a forward `yy.m.d.n` hotfix
 *     (internal design notes), and the only sanctioned downgrade is the owner's
 *     `recued rollback`, which never consults the manifest (D-178 I-10).
 *   · the SAME version with different bytes. A server already running it answers
 *     `up-to-date` and never receives them, so two builds would carry one version
 *     in the field and nothing on either side would notice.
 *
 * Judged per consumer fleet through the canonical resolver, exactly as artifact
 * continuity is: stable follows stable, edge follows the newer of stable and edge.
 * A fleet with no live target has nothing to regress; one the candidate stops
 * resolving is channel availability, not a regression (see
 * `release-artifact-continuity.mjs`, which skips it for the same reason).
 *
 * 🔑 SAME-VERSION IDENTITY IS THE ARTIFACT BYTES AND NOTHING ELSE.
 *   · a hosted artifact (binary, `lib-*` sidecar, webclient) is its signed
 *     `sha256`. Its URL is sequence-namespaced and changes on every publish; its
 *     detached `sig` authenticates the bytes rather than naming them.
 *   · a docker artifact is its `digest` — the pull is digest-anchored (I-2).
 *   · an artifact kind this file does not know is compared whole, minus its URL.
 * Release metadata is deliberately NOT identity: `released_at` is re-anchored on
 * every cut (`release/release.mjs`), republishing a version with a new
 * `rollout_pct` is how a staged rollout moves (26.8.4 was republished at 0), and
 * `notes_url`, `min_supported` and `migration` describe the release rather than
 * the bytes it installs.
 *
 * A key only one side carries changes no installed bytes: one the candidate adds
 * was never offered by this live target, and one it drops is the platform-drop
 * guard's question. `--allow-platform-drop` does not reach this check.
 */
import { compareVersions, resolveChannelTarget } from '@recued/release';

import { RELEASE_CONSUMER_CHANNELS } from './release-artifact-continuity.mjs';

/** JSON with object keys sorted, so two spellings of one value compare equal. */
const sortedJson = (value) => JSON.stringify(value, (_key, nested) => (
  nested && typeof nested === 'object' && !Array.isArray(nested)
    ? Object.fromEntries(Object.entries(nested).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    : nested
));

/** What names an artifact's BYTES — see the header for why nothing else does. */
const artifactBytes = (artifact) => {
  if (artifact && typeof artifact === 'object') {
    if (typeof artifact.sha256 === 'string') return `sha256 ${artifact.sha256}`;
    if (typeof artifact.digest === 'string') return `digest ${artifact.digest}`;
    return sortedJson(Object.fromEntries(Object.entries(artifact).filter(([key]) => key !== 'url')));
  }
  return sortedJson(artifact);
};

/**
 * Return every consumer fleet the candidate would move to an older version, or
 * whose unchanged version it would give different artifact bytes.
 *
 * @param {import('@recued/release').ReleaseManifest} live
 * @param {import('@recued/release').ReleaseManifest} candidate
 */
export const findLiveReleaseRegressions = (live, candidate) => {
  const regressions = [];
  for (const consumerChannel of RELEASE_CONSUMER_CHANNELS) {
    const before = resolveChannelTarget(live, consumerChannel);
    const after = resolveChannelTarget(candidate, consumerChannel);
    if (!before || !after) continue;

    const finding = {
      consumerChannel,
      liveTargetChannel: before.channel,
      liveVersion: before.release.version,
      candidateTargetChannel: after.channel,
      candidateVersion: after.release.version,
    };
    const order = compareVersions(after.release.version, before.release.version);
    if (order < 0) {
      regressions.push({ kind: 'downgrade', ...finding, artifacts: [] });
    } else if (order === 0) {
      const liveArtifacts = before.release.artifacts ?? {};
      const candidateArtifacts = after.release.artifacts ?? {};
      const changed = Object.keys(liveArtifacts)
        .filter((key) => Object.prototype.hasOwnProperty.call(candidateArtifacts, key)
          && artifactBytes(liveArtifacts[key]) !== artifactBytes(candidateArtifacts[key]))
        .sort();
      if (changed.length > 0) {
        regressions.push({ kind: 'same-version-bytes', ...finding, artifacts: changed });
      }
    }
  }
  return regressions;
};

export const formatLiveReleaseRegression = (regression) => `${regression.consumerChannel}: ${
  regression.kind === 'downgrade'
    ? `${regression.liveVersion} -> ${regression.candidateVersion}`
    : `new bytes under ${regression.candidateVersion} for ${regression.artifacts.join(', ')}`
} (${regression.liveTargetChannel}->${regression.candidateTargetChannel})`;

/** The operator's way forward, shared by both places the publisher asks.
 *  ⚠ CODE, NOT A COMMENT: this file ships in the public export, whose
 *  internal-reference scan blocks an internal doc path left in a string. */
export const LIVE_RELEASE_REGRESSION_REMEDY =
  '  A higher `sequence` makes the manifest newer, not the release inside it. An older version is\n'
  + '  served to every install still below the live one and to every fresh install; new bytes under\n'
  + '  an unchanged version never reach a server already running it (it answers `up-to-date`).\n'
  + '  Ship a newer version instead — `version-date.mjs --hotfix` mints the next yy.m.d.n. A republish\n'
  + '  of the SAME version may change its metadata (released_at, rollout_pct, notes_url, min_supported),\n'
  + '  never its artifact bytes. No flag relaxes this, and there is no feed rollback: the only\n'
  + '  sanctioned downgrade is the owner\'s `recued rollback`.';
