/** The publisher's live compatibility gate: a higher `sequence` must also be a
 *  forward release for every fleet the live manifest resolves. The per-fleet
 *  artifact-drop half is `release-artifact-continuity.mjs`'s, and release
 *  metadata is deliberately NOT part of same-version identity. */

import { describe, expect, it } from 'vitest';

import type { ChannelRelease, ReleaseManifest } from '@recued/release';
import { findEffectiveChannelArtifactDrops } from '../../scripts/release-artifact-continuity.mjs';
import {
  findLiveReleaseRegressions,
  formatLiveReleaseRegression,
} from '../../scripts/release-live-compatibility.mjs';

const binary = (sha256 = 'a'.repeat(64), sequence = 1, sig = `signature-${sha256}`) => ({
  url: `https://releases.recued.com/artifacts/${sequence}/recued-linux-x64`,
  sha256,
  sig,
});

const docker = (digest = 'd'.repeat(64), image = 'registry.example/recued/server') => ({
  image,
  digest: `sha256:${digest}`,
});

const release = (
  version: string,
  artifacts: ChannelRelease['artifacts'] = { 'linux-x64': binary() },
  over: Partial<ChannelRelease> = {},
): ChannelRelease => ({
  version,
  released_at: '2026-09-01T00:00:00Z',
  min_supported: '26.8.31',
  migration: false,
  rollout_pct: 25,
  notes_url: 'https://recued.com/releases/current',
  artifacts,
  ...over,
});

const manifest = (
  sequence: number,
  channels: ReleaseManifest['channels'],
): ReleaseManifest => ({
  schema_version: 1,
  sequence,
  expires_at: '2099-01-01T00:00:00Z',
  min_launcher_version: 1,
  channels,
});

describe('release publisher live compatibility', () => {
  it('refuses a higher-sequence hotfix-to-base regression, on every fleet that resolves it', () => {
    const live = manifest(20, { stable: release('26.9.1.1') });
    const candidate = manifest(21, { stable: release('26.9.1') });

    const found = findLiveReleaseRegressions(live, candidate);
    const downgrade = {
      kind: 'downgrade',
      liveTargetChannel: 'stable',
      liveVersion: '26.9.1.1',
      candidateTargetChannel: 'stable',
      candidateVersion: '26.9.1',
      artifacts: [],
    };
    // edge has no channel of its own, so it follows stable backwards too.
    expect(found).toEqual([
      { ...downgrade, consumerChannel: 'stable' },
      { ...downgrade, consumerChannel: 'edge' },
    ]);
    expect(found.map(formatLiveReleaseRegression)).toEqual([
      'stable: 26.9.1.1 -> 26.9.1 (stable->stable)',
      'edge: 26.9.1.1 -> 26.9.1 (stable->stable)',
    ]);
  });

  it('refuses new bytes under the version a fleet already resolves', () => {
    const live = manifest(20, {
      stable: release('26.9.1', { 'linux-x64': binary('a'.repeat(64), 20), 'docker-baked': docker('d'.repeat(64)) }),
    });
    const candidate = manifest(21, {
      stable: release('26.9.1', { 'linux-x64': binary('b'.repeat(64), 21), 'docker-baked': docker('e'.repeat(64)) }),
    });

    const found = findLiveReleaseRegressions(live, candidate);
    expect(found.map((r) => [r.kind, r.consumerChannel, r.artifacts])).toEqual([
      ['same-version-bytes', 'stable', ['docker-baked', 'linux-x64']],
      ['same-version-bytes', 'edge', ['docker-baked', 'linux-x64']],
    ]);
    expect(formatLiveReleaseRegression(found[0]))
      .toBe('stable: new bytes under 26.9.1 for docker-baked, linux-x64 (stable->stable)');
  });

  it('allows a same-version republish that changes only release metadata and sequence-namespaced URLs', () => {
    // The 26.8.4 shape: the same version republished later, at a higher sequence,
    // with a new rollout. released_at is re-anchored on every cut.
    const live = manifest(4, {
      stable: release('26.9.1', { 'linux-x64': binary('a'.repeat(64), 4), 'docker-baked': docker() }, {
        released_at: '2026-08-04T00:00:00Z',
        rollout_pct: 100,
        notes_url: 'https://recued.com/releases/old',
        min_supported: '26.8.1',
        migration: true,
      }),
    });
    const candidate = manifest(5, {
      stable: release('26.9.1', { 'linux-x64': binary('a'.repeat(64), 5), 'docker-baked': docker() }, {
        released_at: '2026-08-05T00:00:00Z',
        rollout_pct: 0,
        notes_url: 'https://recued.com/releases/new',
        min_supported: '26.8.31',
        migration: false,
      }),
    });

    expect(findLiveReleaseRegressions(live, candidate)).toEqual([]);
  });

  it('identifies bytes — not the signature over them, nor the repository serving a digest', () => {
    const live = manifest(20, {
      stable: release('26.9.1', {
        'linux-x64': binary('a'.repeat(64), 20, 'signature-under-the-old-comment'),
        'docker-thin': docker('d'.repeat(64), 'registry.example/recued/server'),
      }),
    });
    const candidate = manifest(21, {
      stable: release('26.9.1', {
        'linux-x64': binary('a'.repeat(64), 21, 'signature-under-a-new-comment'),
        'docker-thin': docker('d'.repeat(64), 'mirror.example/recued/server'),
      }),
    });

    expect(findLiveReleaseRegressions(live, candidate)).toEqual([]);
  });

  it('compares an artifact kind it does not know whole, minus its URL', () => {
    const future = (blob: string, sequence: number) => ({
      'future-kind': { url: `https://releases.recued.com/artifacts/${sequence}/future`, blob },
    }) as never;
    const live = manifest(20, { stable: release('26.9.1', future('x', 20)) });

    expect(findLiveReleaseRegressions(live, manifest(21, { stable: release('26.9.1', future('x', 21)) })))
      .toEqual([]);
    expect(findLiveReleaseRegressions(live, manifest(21, { stable: release('26.9.1', future('y', 21)) }))
      .map((r) => r.artifacts)).toEqual([['future-kind'], ['future-kind']]);
  });

  it('allows a forward version to carry new bytes', () => {
    const live = manifest(20, { stable: release('26.9.1', { 'linux-x64': binary('a'.repeat(64), 20) }) });
    const candidate = manifest(21, { stable: release('26.9.1.1', { 'linux-x64': binary('b'.repeat(64), 21) }) });

    expect(findLiveReleaseRegressions(live, candidate)).toEqual([]);
  });

  it('leaves a same-version addition alone and a drop to the platform-drop guard, which still sees it', () => {
    const live = manifest(20, { stable: release('26.9.1', { 'linux-x64': binary() }) });
    const added = manifest(21, {
      stable: release('26.9.1', { 'linux-x64': binary(), 'windows-x64': binary('c'.repeat(64)) }),
    });
    const dropped = manifest(21, { stable: release('26.9.1', {}) });

    expect(findLiveReleaseRegressions(live, added)).toEqual([]);
    expect(findLiveReleaseRegressions(live, dropped)).toEqual([]);
    // No hole between the two gates: the drop this one leaves is the other's.
    expect(findEffectiveChannelArtifactDrops(live, dropped).map((d) => d.artifact))
      .toEqual(['linux-x64', 'linux-x64']);
  });

  it('uses canonical edge resolution when stable leapfrogs the raw edge entry', () => {
    const live = manifest(20, {
      stable: release('26.9.2'),
      edge: release('26.9.1'),
    });
    const candidate = manifest(21, {
      stable: release('26.9.3'),
      edge: release('26.8.31'),
    });

    // The raw edge entry went backwards; the edge FLEET resolves stable, which went forward.
    expect(findLiveReleaseRegressions(live, candidate)).toEqual([]);
  });

  it('refuses an edge fleet walked back below the edge release it resolves', () => {
    const live = manifest(20, {
      stable: release('26.9.1'),
      edge: release('26.9.3'),
    });
    const candidate = manifest(21, {
      stable: release('26.9.2'),
      edge: release('26.9.2'),
    });

    expect(findLiveReleaseRegressions(live, candidate).map(formatLiveReleaseRegression))
      .toEqual(['edge: 26.9.3 -> 26.9.2 (edge->edge)']);
  });

  it('skips a fleet the candidate stops resolving while still judging the fleet that fell back to it', () => {
    const live = manifest(20, { stable: release('26.9.2') });
    const candidate = manifest(21, { edge: release('26.9.1') });

    expect(findLiveReleaseRegressions(live, candidate).map(formatLiveReleaseRegression))
      .toEqual(['edge: 26.9.2 -> 26.9.1 (stable->edge)']);
  });
});
