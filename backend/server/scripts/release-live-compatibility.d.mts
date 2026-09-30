import type { ChannelName, ReleaseManifest } from '@recued/release';

export interface LiveReleaseRegression {
  /** `downgrade`: the fleet's resolved version moves backwards. `same-version-bytes`:
   *  it keeps its version and `artifacts` names the keys whose bytes differ. */
  kind: 'downgrade' | 'same-version-bytes';
  consumerChannel: ChannelName;
  liveTargetChannel: ChannelName;
  liveVersion: string;
  candidateTargetChannel: ChannelName;
  candidateVersion: string;
  artifacts: string[];
}

export declare const findLiveReleaseRegressions: (
  live: ReleaseManifest,
  candidate: ReleaseManifest,
) => LiveReleaseRegression[];
export declare const formatLiveReleaseRegression: (
  regression: LiveReleaseRegression,
) => string;
export declare const LIVE_RELEASE_REGRESSION_REMEDY: string;
