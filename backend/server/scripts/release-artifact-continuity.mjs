/**
 * Artifact continuity at the consumer boundary.
 *
 * A manifest is not consumed as the union of every channel it declares:
 * stable follows stable, while edge follows the newer of stable and edge.
 * Comparing global artifact-key unions therefore misses a key moved from one
 * channel to another even when the resulting stable/edge target no longer
 * offers it. Keep this helper on the canonical resolver so publication and
 * installed clients make the same channel choice.
 */
import { resolveChannelTarget } from '@recued/release';

export const RELEASE_CONSUMER_CHANNELS = Object.freeze(['stable', 'edge']);

/**
 * Return artifact keys a consumer channel could resolve before but cannot
 * resolve from the candidate target. A candidate with no target for a consumer
 * is skipped: no release is offered on that channel, so this is channel
 * availability rather than a platform retirement.
 *
 * @param {import('@recued/release').ReleaseManifest} prior
 * @param {import('@recued/release').ReleaseManifest} candidate
 */
export const findEffectiveChannelArtifactDrops = (prior, candidate) => {
  const drops = [];
  for (const consumerChannel of RELEASE_CONSUMER_CHANNELS) {
    const before = resolveChannelTarget(prior, consumerChannel);
    const after = resolveChannelTarget(candidate, consumerChannel);
    if (!before || !after) continue;

    for (const artifact of Object.keys(before.release.artifacts ?? {}).sort()) {
      if (Object.prototype.hasOwnProperty.call(after.release.artifacts ?? {}, artifact)) continue;
      drops.push({
        consumerChannel,
        artifact,
        priorTargetChannel: before.channel,
        candidateTargetChannel: after.channel,
      });
    }
  }
  return drops;
};

export const formatEffectiveChannelArtifactDrop = (drop) =>
  `${drop.consumerChannel}:${drop.artifact} (${drop.priorTargetChannel}->${drop.candidateTargetChannel})`;
