import { describe, expect, it } from 'vitest';

import { findEffectiveChannelArtifactDrops } from '../../scripts/release-artifact-continuity.mjs';

const release = (version: string, artifacts: Record<string, unknown>) => ({
  version,
  released_at: '2026-09-02T00:00:00Z',
  min_supported: '26.9.1',
  migration: false,
  rollout_pct: 100,
  notes_url: 'https://recued.com/releases',
  artifacts,
});

const manifest = (channels: Record<string, unknown>) => ({
  schema_version: 1,
  sequence: 1,
  expires_at: '2026-10-02T00:00:00Z',
  min_launcher_version: 1,
  channels,
}) as never;

describe('release artifact continuity follows effective consumer channels', () => {
  it('catches stable losing an artifact even when the global channel union keeps it', () => {
    const artifact = { image: 'registry.example/recued', digest: `sha256:${'a'.repeat(64)}` };
    const prior = manifest({ stable: release('26.9.2', { 'docker-baked': artifact }) });
    const candidate = manifest({
      stable: release('26.9.3', {}),
      edge: release('26.9.3', { 'docker-baked': artifact }),
    });

    expect(findEffectiveChannelArtifactDrops(prior, candidate)).toEqual([{
      consumerChannel: 'stable',
      artifact: 'docker-baked',
      priorTargetChannel: 'stable',
      candidateTargetChannel: 'stable',
    }]);
  });

  it('catches edge switching to a newer target that lacks an artifact still present on stable', () => {
    const artifact = { url: 'https://releases.example/recued', sha256: 'a'.repeat(64), sig: 'sig' };
    const prior = manifest({
      stable: release('26.9.2', { 'linux-x64': artifact }),
      edge: release('26.9.1', {}),
    });
    const candidate = manifest({
      stable: release('26.9.2', { 'linux-x64': artifact }),
      edge: release('26.9.3', {}),
    });

    expect(findEffectiveChannelArtifactDrops(prior, candidate)).toEqual([{
      consumerChannel: 'edge',
      artifact: 'linux-x64',
      priorTargetChannel: 'stable',
      candidateTargetChannel: 'edge',
    }]);
  });

  it('skips an undeclared stable target while still protecting edge resolution', () => {
    const prior = manifest({ stable: release('26.9.2', { 'linux-x64': {} }) });
    const candidate = manifest({ edge: release('26.9.3', {}) });

    expect(findEffectiveChannelArtifactDrops(prior, candidate)).toEqual([{
      consumerChannel: 'edge',
      artifact: 'linux-x64',
      priorTargetChannel: 'stable',
      candidateTargetChannel: 'edge',
    }]);
  });
});
