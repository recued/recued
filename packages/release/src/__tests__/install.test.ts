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
        version: '1.5.0',
        released_at: '2026-07-05T10:00:00Z',
        min_supported: '1.2.0',
        migration: false,
        rollout_pct: 100,
        notes_url: 'https://recued.com/r/1.5.0',
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
    expect(r.ok && r.version).toBe('1.5.0');
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

  const oneChannel = (name: 'stable' | 'edge', version: string) => assembleManifest({
    sequence: 1, expires_at: '2026-08-01T00:00:00Z', min_launcher_version: 1,
    channels: {
      [name]: {
        version, released_at: '2026-07-02T10:00:00Z', min_supported: '1.0.0',
        migration: false, rollout_pct: 100, notes_url: 'https://x',
        binaries: { 'linux-x64': { url: `u-${name}`, sha256: 'a'.repeat(64), sig: 's' } },
      },
    },
  });

  /** ⛔⛔ `edge` MEANS max(stable, edge), NOT `channels[requested]`.
   *
   *  This selector is EXPORTED and documented as the canonical installer
   *  selection, and it read the requested channel directly — so it disagreed
   *  with `resolveRelease`, with `install.sh` and with `install.ps1`, all three
   *  of which resolve edge as max(stable, edge) with a stable fallback. Two
   *  concrete wrong answers, both reproduced before the fix:
   *
   *    stable 26.9.1.1 + edge 26.9.1 → it picked edge 26.9.1, pulling an edge
   *      subscriber BACKWARDS past the hotfix that supersedes it;
   *    a stable-only manifest + requested edge → `channel-missing`, which is the
   *      shape the LIVE edge feed actually has (it declares only stable).
   *
   *  It now calls `resolveChannelTarget`, the same primitive `resolveRelease`
   *  uses, so the two cannot drift again. */
  it('⛔ edge takes a stable hotfix that leapfrogs it, and reports stable as the channel', () => {
    const m = assembleManifest({
      sequence: 1, expires_at: '2026-08-01T00:00:00Z', min_launcher_version: 1,
      channels: {
        stable: {
          version: '26.9.1.1', released_at: '2026-07-02T10:00:00Z', min_supported: '1.0.0',
          migration: false, rollout_pct: 100, notes_url: 'https://x',
          binaries: { 'linux-x64': { url: 'u-stable', sha256: 'a'.repeat(64), sig: 's' } },
        },
        edge: {
          version: '26.9.1', released_at: '2026-07-02T10:00:00Z', min_supported: '1.0.0',
          migration: false, rollout_pct: 100, notes_url: 'https://x',
          binaries: { 'linux-x64': { url: 'u-edge', sha256: 'b'.repeat(64), sig: 's' } },
        },
      },
    });
    const r = selectInstallArtifact(m, { channel: 'edge', platform: 'linux-x64' });
    expect(r.ok && r.version).toBe('26.9.1.1');
    expect(r.ok && r.channel).toBe('stable');
    expect(r.ok && r.url).toBe('u-stable');
  });

  it('⛔ a stable-only manifest serves an edge request — the shape the live feed has', () => {
    const r = selectInstallArtifact(oneChannel('stable', '1.0.0'), {
      channel: 'edge', platform: 'linux-x64',
    });
    expect(r.ok && r.version).toBe('1.0.0');
    expect(r.ok && r.channel).toBe('stable');
  });

  it('edge still wins when it is genuinely ahead', () => {
    const m = assembleManifest({
      sequence: 1, expires_at: '2026-08-01T00:00:00Z', min_launcher_version: 1,
      channels: {
        stable: {
          version: '26.9.1', released_at: 'x', min_supported: '1.0.0',
          migration: false, rollout_pct: 100, notes_url: '',
          binaries: { 'linux-x64': { url: 'u-stable', sha256: 'a'.repeat(64), sig: 's' } },
        },
        edge: {
          version: '26.9.2', released_at: 'x', min_supported: '1.0.0',
          migration: false, rollout_pct: 100, notes_url: '',
          binaries: { 'linux-x64': { url: 'u-edge', sha256: 'b'.repeat(64), sig: 's' } },
        },
      },
    });
    const r = selectInstallArtifact(m, { channel: 'edge', platform: 'linux-x64' });
    expect(r.ok && r.version).toBe('26.9.2');
    expect(r.ok && r.channel).toBe('edge');
  });

  it('fails closed when NEITHER channel is present', () => {
    // Still fail-closed — the fallback is stable, not "any channel at all".
    const m = oneChannel('edge', '1.0.0');
    delete (m.channels as Record<string, unknown>).edge;
    expect(selectInstallArtifact(m, { channel: 'edge', platform: 'linux-x64' }))
      .toEqual({ ok: false, reason: 'channel-missing' });
    expect(selectInstallArtifact(m, { channel: 'stable', platform: 'linux-x64' }))
      .toEqual({ ok: false, reason: 'channel-missing' });
  });
});
