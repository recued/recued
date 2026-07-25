import { describe, expect, it } from 'vitest';
import { selectInstallArtifact } from '../install.js';
import { assembleManifest, type ManifestInput } from '../assemble.js';

const manifest = () =>
  assembleManifest({
    sequence: 5,
    expires_at: '2026-08-01T00:00:00Z',
    min_launcher_version: 1,
    channels: {
      stable: {
        version: '1.4.2',
        released_at: '2026-07-02T10:00:00Z',
        min_supported: '1.2.0',
        migration: false,
        rollout_pct: 100,
        notes_url: 'https://recued.com/r/1.4.2',
        binaries: {
          'linux-x64': { url: 'https://cdn/recued-linux-x64', sha256: 'a'.repeat(64), sig: 'sig-lx' },
          'macos-arm64': { url: 'https://cdn/recued-macos-arm64', sha256: 'b'.repeat(64), sig: 'sig-mac' },
        },
      },
      edge: {
        version: '1.5.0-edge',
        released_at: '2026-07-05T10:00:00Z',
        min_supported: '1.2.0',
        migration: false,
        rollout_pct: 100,
        notes_url: 'https://recued.com/r/1.5.0-edge',
        binaries: {
          'linux-x64': { url: 'https://cdn/edge/recued-linux-x64', sha256: 'e'.repeat(64), sig: 'sig-edge' },
        },
      },
    },
  } satisfies ManifestInput);

describe('selectInstallArtifact', () => {
  it('defaults to stable and returns the host binary + sha256 + sig + fileName', () => {
    const r = selectInstallArtifact(manifest(), { platform: 'linux-x64' });
    expect(r).toEqual({
      ok: true,
      channel: 'stable',
      platform: 'linux-x64',
      version: '1.4.2',
      fileName: 'recued-linux-x64',
      url: 'https://cdn/recued-linux-x64',
      sha256: 'a'.repeat(64),
      sig: 'sig-lx',
    });
  });

  it('honors an explicit channel', () => {
    const r = selectInstallArtifact(manifest(), { channel: 'edge', platform: 'linux-x64' });
    expect(r.ok && r.version).toBe('1.5.0-edge');
    expect(r.ok && r.url).toBe('https://cdn/edge/recued-linux-x64');
  });

  it('names windows binaries with .exe', () => {
    const m = assembleManifest({
      sequence: 1,
      expires_at: '2026-08-01T00:00:00Z',
      min_launcher_version: 1,
      channels: {
        stable: {
          version: '1.0.0', released_at: '2026-07-02T10:00:00Z', min_supported: '1.0.0',
          migration: false, rollout_pct: 100, notes_url: 'https://x',
          binaries: { 'windows-x64': { url: 'https://cdn/recued-windows-x64.exe', sha256: 'f'.repeat(64), sig: 's' } },
        },
      },
    });
    const r = selectInstallArtifact(m, { platform: 'windows-x64' });
    expect(r.ok && r.fileName).toBe('recued-windows-x64.exe');
  });

  it('fails closed when the platform was not built for that channel', () => {
    // edge only ships linux-x64
    expect(selectInstallArtifact(manifest(), { channel: 'edge', platform: 'macos-arm64' }))
      .toEqual({ ok: false, reason: 'platform-unavailable' });
  });

  it('fails closed when the channel is absent', () => {
    const m = assembleManifest({
      sequence: 1, expires_at: '2026-08-01T00:00:00Z', min_launcher_version: 1,
      channels: {
        stable: {
          version: '1.0.0', released_at: '2026-07-02T10:00:00Z', min_supported: '1.0.0',
          migration: false, rollout_pct: 100, notes_url: 'https://x',
          binaries: { 'linux-x64': { url: 'u', sha256: 'a'.repeat(64), sig: 's' } },
        },
      },
    });
    expect(selectInstallArtifact(m, { channel: 'edge', platform: 'linux-x64' }))
      .toEqual({ ok: false, reason: 'channel-missing' });
  });
});
