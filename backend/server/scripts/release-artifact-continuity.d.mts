import type { ChannelName, ReleaseManifest } from '@recued/release';

export interface EffectiveChannelArtifactDrop {
  consumerChannel: ChannelName;
  artifact: string;
  priorTargetChannel: ChannelName;
  candidateTargetChannel: ChannelName;
}

export declare const RELEASE_CONSUMER_CHANNELS: readonly ChannelName[];
export declare const findEffectiveChannelArtifactDrops: (
  prior: ReleaseManifest,
  candidate: ReleaseManifest,
) => EffectiveChannelArtifactDrop[];
export declare const formatEffectiveChannelArtifactDrop: (
  drop: EffectiveChannelArtifactDrop,
) => string;
