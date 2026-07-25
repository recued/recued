import { describe, expect, it } from 'vitest';
import { parseManifest, type ReleaseManifest } from '../manifest.js';
import { compareVersions, DEFAULT_FRESHNESS_GRACE_MS, inRolloutCohort, resolveRelease, type ResolveInput } from '../resolve.js';

const manifest = (over: Partial<Record<string, unknown>> = {}, channels?: Record<string, unknown>): ReleaseManifest =>
  parseManifest(JSON.stringify({
    schema_version: 1,
    sequence: 184,
    expires_at: '2026-07-16T10:00:00Z',
    min_launcher_version: 2,
    channels: channels ?? {
      stable: {
        version: '1.4.2', released_at: '2026-07-02T10:00:00Z', min_supported: '1.2.0',
        migration: true, rollout_pct: 100, notes_url: '',
        artifacts: {
          'linux-x64': { url: 'https://x/l', sha256: 'aa', sig: 'ss' },
          'docker-thin': { image: 'recued/recued:managed', digest: 'sha256:dd' },
        },
      },
    },
    ...over,
  }));

// 2026-07-10 — comfortably inside the 2026-07-16 expiry.
const NOW = Date.parse('2026-07-10T00:00:00Z');

const base = (over: Partial<ResolveInput> = {}): ResolveInput => ({
  manifest: manifest(),
  channel: 'stable',
  currentVersion: '1.3.0',
  platform: 'linux-x64',
  salt: 'seed-abc',
  highestAcceptedSequence: 100,
  nowMs: NOW,
  ...over,
});

describe('compareVersions', () => {
  it('orders by numeric segment', () => {
    expect(compareVersions('1.4.2', '1.4.1')).toBe(1);
    expect(compareVersions('1.4.2', '1.5.0')).toBe(-1);
    expect(compareVersions('2.0.0', '1.9.9')).toBe(1);
    expect(compareVersions('1.4.0', '1.4.0')).toBe(0);
  });
  it('reads a missing segment as 0 and ignores pre-release trailers', () => {
    expect(compareVersions('1.4', '1.4.0')).toBe(0);
    expect(compareVersions('1.5.0-rc1', '1.5.0')).toBe(0);
  });
});

describe('inRolloutCohort', () => {
  it('100% admits everyone, 0% admits no one', () => {
    expect(inRolloutCohort('anything', 100)).toBe(true);
    expect(inRolloutCohort('anything', 0)).toBe(false);
  });
  it('is deterministic for a given salt', () => {
    expect(inRolloutCohort('seed-abc', 40)).toBe(inRolloutCohort('seed-abc', 40));
  });
});

describe('resolveRelease', () => {
  it('offers a newer release on the followed channel', () => {
    const r = resolveRelease(base());
    expect(r.status).toBe('update-available');
    if (r.status !== 'update-available') return;
    expect(r.targetVersion).toBe('1.4.2');
    expect(r.migration).toBe(true);
    expect(r.artifact?.url).toBe('https://x/l');
    expect(r.autoApplyEligible).toBe(true);
  });

  it('reports up-to-date when current ≥ target', () => {
    expect(resolveRelease(base({ currentVersion: '1.4.2' })).status).toBe('up-to-date');
    expect(resolveRelease(base({ currentVersion: '1.5.0' })).status).toBe('up-to-date');
  });

  it('refuses a STRICTLY-older manifest (downgrade), not the current one', () => {
    // Equal to the floor is the current manifest re-fetched — NOT a replay, so
    // re-polling stays idempotent + apply-after-check can still resolve it.
    expect(resolveRelease(base({ highestAcceptedSequence: 184 })).status).toBe('update-available');
    // Strictly below the floor is a genuine downgrade attempt — refuse.
    expect(resolveRelease(base({ highestAcceptedSequence: 200 })).status).toBe('replay');
  });

  it('surfaces a stale feed past expiry + grace', () => {
    const past = NOW + DEFAULT_FRESHNESS_GRACE_MS + 1;
    // expires_at 2026-07-16; push now well beyond expiry + grace.
    const r = resolveRelease(base({ nowMs: Date.parse('2026-08-01T00:00:00Z') }));
    expect(r.status).toBe('stale-feed');
    // within grace → still resolves normally
    const r2 = resolveRelease(base({ nowMs: Date.parse('2026-07-18T00:00:00Z') }));
    expect(r2.status).toBe('update-available');
    void past;
  });

  it('stops applying when the launcher is below min_launcher_version', () => {
    const r = resolveRelease(base({ launcherVersion: 1 }));
    expect(r.status).toBe('launcher-outdated');
    if (r.status !== 'launcher-outdated') return;
    expect(r.required).toBe(2);
    expect(r.current).toBe(1);
    // a current launcher resolves normally
    expect(resolveRelease(base({ launcherVersion: 2 })).status).toBe('update-available');
    // a plain binary install (no launcher) skips the gate
    expect(resolveRelease(base()).status).toBe('update-available');
  });

  it('flags a major bump as notify-only (not auto-apply)', () => {
    const r = resolveRelease(base({
      currentVersion: '1.9.0',
      manifest: manifest({}, {
        stable: {
          version: '2.0.0', released_at: 'x', min_supported: '1.2.0', migration: false,
          rollout_pct: 100, notes_url: '', artifacts: { 'linux-x64': { url: 'u', sha256: 'a', sig: 's' } },
        },
      }),
    }));
    expect(r.status).toBe('update-available');
    if (r.status !== 'update-available') return;
    expect(r.isMajor).toBe(true);
    expect(r.autoApplyEligible).toBe(false);
  });

  it('flags an install below min_supported as urgent', () => {
    const r = resolveRelease(base({ currentVersion: '1.1.0' }));
    expect(r.status).toBe('update-available');
    if (r.status !== 'update-available') return;
    expect(r.belowMinSupported).toBe(true);
  });

  it('edge resolves to max(stable, edge) and never below current', () => {
    const m = manifest({}, {
      stable: {
        version: '1.4.5', released_at: 'x', min_supported: '1.2.0', migration: false,
        rollout_pct: 100, notes_url: '', artifacts: { 'linux-x64': { url: 'us', sha256: 'a', sig: 's' } },
      },
      edge: {
        version: '1.4.0', released_at: 'x', min_supported: '1.2.0', migration: false,
        rollout_pct: 100, notes_url: '', artifacts: { 'linux-x64': { url: 'ue', sha256: 'a', sig: 's' } },
      },
    });
    const r = resolveRelease(base({ channel: 'edge', manifest: m, currentVersion: '1.3.0' }));
    expect(r.status).toBe('update-available');
    if (r.status !== 'update-available') return;
    expect(r.targetVersion).toBe('1.4.5'); // stable hotfix leapfrogs edge
  });

  it('respects local rollout cohort for auto-apply eligibility', () => {
    const m = manifest({}, {
      stable: {
        version: '1.4.2', released_at: 'x', min_supported: '1.2.0', migration: false,
        rollout_pct: 0, notes_url: '', artifacts: { 'linux-x64': { url: 'u', sha256: 'a', sig: 's' } },
      },
    });
    const r = resolveRelease(base({ manifest: m }));
    expect(r.status).toBe('update-available');
    if (r.status !== 'update-available') return;
    expect(r.inRolloutCohort).toBe(false);
    expect(r.autoApplyEligible).toBe(false);
  });
});
