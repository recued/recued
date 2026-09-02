import { describe, expect, it } from 'vitest';
import { isValidReleaseVersion, parseManifest, type ReleaseManifest } from '../manifest.js';
import { compareVersions, inRolloutCohort, resolveRelease, type ResolveInput } from '../resolve.js';

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
          'docker-thin': { image: 'recued/recued:managed', digest: `sha256:${'d'.repeat(64)}` },
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
  it('reads a missing segment as 0, and COERCES anything else rather than throwing', () => {
    expect(compareVersions('1.4', '1.4.0')).toBe(0);

    // ⛔ THIS IS NOT "IGNORES PRE-RELEASE TRAILERS" — IT IS THE COERCION THAT
    // MADE THEM DANGEROUS, and this test used to be titled as though it were a
    // feature. Where the trailer lands decides whether the version reads EQUAL
    // to the release it precedes or NEWER than it:
    expect(compareVersions('1.5.0-rc1', '1.5.0')).toBe(0);   // parseInt('0-rc1') → 0
    expect(compareVersions('26.9.1-rc.1', '26.9.1')).toBe(1); // parseInt('1-rc') → 1, then .1 wins
    // ⇒ a prerelease would be INSTALLED OVER the final release it precedes.
    //
    // 🔑 The comparator stays TOTAL on purpose — it runs on the update path and
    // must never throw there. Refusing malformed input is the GRAMMAR's job, and
    // `isValidReleaseVersion` (applied by `parseManifest` before any of these
    // values reach a comparison) is what makes the coercion unreachable.
    expect(isValidReleaseVersion('1.5.0-rc1')).toBe(false);
    expect(isValidReleaseVersion('26.9.1-rc.1')).toBe(false);
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

  it('⛔ STILL OFFERS THE RELEASE LONG PAST expires_at — there is no freshness gate', () => {
    // ⛔⛔ THIS ARM IS THE INVERSE OF THE ONE IT REPLACES, and the inversion is the
    // decision (2026-09-01, owner). The old rule refused a manifest past
    // `expires_at` + a 7-day grace. It punished the wrong party: a feed that has
    // merely stopped moving and a feed an attacker is freezing are
    // INDISTINGUISHABLE from here, so the only response available was to refuse
    // the newest release anyone actually has — a scheduled outage against a
    // seasonal release cadence, not a defence.
    //
    // `expires_at` is 2026-07-16 in this fixture. Years past it, the answer is
    // still the release.
    expect(resolveRelease(base({ nowMs: Date.parse('2030-01-01T00:00:00Z') })).status)
      .toBe('update-available');
    // ⚠ AND THE HALF THAT STILL DEFENDS IS UNTOUCHED: a manifest below the floor
    // is a downgrade attempt whatever the clock says, so dropping freshness must
    // not read as dropping anti-replay.
    expect(resolveRelease(base({ nowMs: Date.parse('2030-01-01T00:00:00Z'), highestAcceptedSequence: 200 })).status)
      .toBe('replay');
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

  // ── D-178 S1 rev 2 — the native `lib/` sidecar resolves WITH its binary ──
  describe('libArtifact', () => {
    const withLib = (artifacts: Record<string, unknown>) =>
      manifest({}, {
        stable: {
          version: '1.4.2', released_at: '2026-07-02T10:00:00Z', min_supported: '1.2.0',
          migration: false, rollout_pct: 100, notes_url: '',
          artifacts,
        },
      });

    it('resolves the sidecar for the SAME triple as the binary', () => {
      const r = resolveRelease(base({
        manifest: withLib({
          'linux-x64': { url: 'https://x/l', sha256: 'aa', sig: 'ss' },
          'lib-linux-x64': { url: 'https://x/lib-l', sha256: 'll', sig: 'lsig' },
          // a DIFFERENT triple's sidecar must not be picked up
          'lib-macos-arm64': { url: 'https://x/lib-m', sha256: 'mm', sig: 'msig' },
        }),
        platform: 'linux-x64',
      }));
      expect(r.status).toBe('update-available');
      if (r.status !== 'update-available') return;
      expect(r.artifact?.url).toBe('https://x/l');
      expect(r.libArtifact?.url).toBe('https://x/lib-l');
    });

    it('returns null — not the wrong arch — when THIS triple has no sidecar', () => {
      // ⛔ The failure this guards is silent and catastrophic: handing back
      // another platform's `.node` would install an exe with a sidecar it
      // cannot load.
      const r = resolveRelease(base({
        manifest: withLib({
          'linux-x64': { url: 'https://x/l', sha256: 'aa', sig: 'ss' },
          'lib-macos-arm64': { url: 'https://x/lib-m', sha256: 'mm', sig: 'msig' },
        }),
        platform: 'linux-x64',
      }));
      expect(r.status).toBe('update-available');
      if (r.status !== 'update-available') return;
      expect(r.artifact).not.toBeNull();
      expect(r.libArtifact).toBeNull();
    });

    it('still REPORTS the release when the sidecar is missing', () => {
      // Deliberate: the check surfaces the release; the APPLY path is where the
      // pair is enforced. Failing the check instead would hide an available
      // update from the owner entirely.
      const r = resolveRelease(base());
      expect(r.status).toBe('update-available');
      if (r.status !== 'update-available') return;
      expect(r.libArtifact).toBeNull();
    });
  });
});

/** ⛔ AN UNREADABLE EXPIRY IS STALE, NOT FRESH. `resolveRelease` takes a manifest
 *  OBJECT, so a caller that builds one itself bypasses `parseManifest` entirely —
 *  which is why the resolver owes its own answer rather than trusting the parser. */
describe('resolveRelease freshness fails closed', () => {
  // Built through the file's own `base()` rather than a hand-assembled input, so
  // this differs from every other resolve case in exactly ONE field. A bespoke
  // input can drift from the others silently and then assert about a scenario
  // nothing else in the file shares.
  const withExpiry = (expires_at: string) =>
    resolveRelease(base({ manifest: { ...manifest(), expires_at } }));

  it('does not READ the expiry at all — a malformed one changes nothing', () => {
    // ⚠ THIS ARM ONCE ASSERTED THE OPPOSITE, and the history is worth keeping:
    // the resolver skipped its staleness comparison when `Date.parse` returned
    // NaN, so `expires_at: "not-a-date"` was fresh forever — a freshness check
    // failing OPEN on exactly the input it existed to catch. That was fixed, and
    // then the gate itself was removed. What the arm guards now is that no
    // decision reads the field: a value the parser would reject and a real
    // timestamp resolve identically.
    expect(withExpiry('not-a-date').status).toBe('update-available');
    expect(withExpiry('2026-07-16T10:00:00Z').status).toBe('update-available');
    expect(withExpiry('1999-01-01T00:00:00Z').status).toBe('update-available');
  });
});
