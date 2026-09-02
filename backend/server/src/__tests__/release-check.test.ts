import { describe, expect, it } from 'vitest';
import { generateKeypair, sign } from '@recued/release';
import {
  resolveForApply,
  runReleaseCheck,
  sigUrlFor,
  type ReleaseCheckDeps,
} from '../update/release-check.js';
import type { ReleaseCheckState } from '../update/release-state-store.js';

const MANIFEST_URL = 'https://releases.example/manifest.json';

const manifestJson = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    schema_version: 1,
    sequence: 200,
    expires_at: '2026-07-16T10:00:00Z',
    min_launcher_version: 1,
    channels: {
      stable: {
        version: '1.4.2', released_at: '2026-07-02T10:00:00Z', min_supported: '1.2.0',
        migration: true, rollout_pct: 100, notes_url: 'https://n',
        artifacts: { 'linux-x64': { url: 'https://x/l', sha256: 'aa', sig: 'ss' } },
      },
    },
    ...over,
  });

const NOW = Date.parse('2026-07-10T00:00:00Z');

/** A deps factory backed by a real minisign signature so the verify path runs
 *  for real. Returns the deps + a mutable state cell. */
const makeDeps = (over: Partial<ReleaseCheckDeps> & { manifest?: string } = {}) => {
  const kp = generateKeypair();
  const manifest = over.manifest ?? manifestJson();
  const sigText = sign({
    content: Buffer.from(manifest, 'utf8'),
    secretSeed: kp.secretSeed,
    keyId: kp.keyId,
    trustedComment: 'manifest 1.4.2',
  });
  const state: ReleaseCheckState = { salt: 'fixed-salt', highest_accepted_sequence: 100 };
  const saved: ReleaseCheckState[] = [];
  const fetchText = async (url: string): Promise<string> => {
    if (url === MANIFEST_URL) return manifest;
    if (url === sigUrlFor(MANIFEST_URL)) return sigText;
    throw new Error(`unexpected url ${url}`);
  };
  const deps: ReleaseCheckDeps = {
    trustedPubkey: kp.publicKeyText,
    manifestUrl: MANIFEST_URL,
    fetchText,
    channel: 'stable',
    currentVersion: '1.3.0',
    platform: 'linux-x64',
    loadState: () => state,
    saveState: (s) => { saved.push(s); Object.assign(state, s); },
    now: () => NOW,
    ...over,
  };
  return { deps, state, saved, kp };
};

describe('runReleaseCheck', () => {
  it('short-circuits to not-configured with no trusted key (no fetch)', async () => {
    let fetched = false;
    const r = await runReleaseCheck({
      ...makeDeps().deps,
      trustedPubkey: '',
      fetchText: async () => { fetched = true; return ''; },
    });
    expect(r.status).toBe('not-configured');
    expect(fetched).toBe(false);
  });

  it('resolves a verified manifest to update-available + advances the floor', async () => {
    const { deps, saved } = makeDeps();
    const r = await runReleaseCheck(deps);
    expect(r.status).toBe('update-available');
    expect(r.available?.version).toBe('1.4.2');
    expect(r.available?.migration).toBe(true);
    expect(r.sequence).toBe(200);
    // anti-replay floor advanced to 200
    expect(saved.at(-1)?.highest_accepted_sequence).toBe(200);
  });

  it('projects the exact signed Docker digest for a delegated baked install', async () => {
    const manifest = JSON.parse(manifestJson()) as any;
    manifest.channels.stable.artifacts['docker-baked'] = {
      image: 'registry.example/recued/server',
      digest: `sha256:${'a'.repeat(64)}`,
    };
    const { deps } = makeDeps({
      manifest: JSON.stringify(manifest),
      distributionChannel: 'docker-baked',
    });
    const r = await runReleaseCheck(deps);
    expect(r).toMatchObject({
      status: 'update-available',
      docker: {
        artifact: 'docker-baked',
        version: '1.4.2',
        image: 'registry.example/recued/server',
        digest: `sha256:${'a'.repeat(64)}`,
        pull_ref: `registry.example/recued/server@sha256:${'a'.repeat(64)}`,
      },
    });
  });

  it('still delivers the signed thin-image recovery digest when the launcher is outdated', async () => {
    const manifest = JSON.parse(manifestJson({ min_launcher_version: 2 })) as any;
    manifest.channels.stable.artifacts['docker-thin'] = {
      image: 'registry.example/recued/server',
      digest: `sha256:${'b'.repeat(64)}`,
    };
    const { deps } = makeDeps({
      manifest: JSON.stringify(manifest),
      distributionChannel: 'docker-thin',
      launcherVersion: 1,
    });
    const r = await runReleaseCheck(deps);
    expect(r.status).toBe('launcher-outdated');
    expect(r.docker?.pull_ref).toBe(`registry.example/recued/server@sha256:${'b'.repeat(64)}`);
  });

  it('reports fetch-failed when a URL throws', async () => {
    const { deps } = makeDeps();
    const r = await runReleaseCheck({ ...deps, fetchText: async () => { throw new Error('boom'); } });
    expect(r.status).toBe('fetch-failed');
    expect(r.detail).toContain('boom');
  });

  it('rejects a manifest signed by the wrong key (bad-signature, fail-closed)', async () => {
    const { deps } = makeDeps();
    const other = generateKeypair();
    const r = await runReleaseCheck({ ...deps, trustedPubkey: other.publicKeyText });
    expect(r.status).toBe('bad-signature');
  });

  it('refuses a STRICTLY-older sequence (downgrade) and does NOT regress the floor', async () => {
    const { deps, saved } = makeDeps({ loadState: () => ({ salt: 's', highest_accepted_sequence: 201 }) });
    const r = await runReleaseCheck(deps);
    expect(r.status).toBe('replay');
    expect(saved).toHaveLength(0);
  });

  it('re-resolves the CURRENT manifest (sequence == floor) idempotently, not as a replay', async () => {
    // Equal sequence is the manifest we already accepted, re-fetched — a second
    // poll (or an apply after the check advanced the floor) must still resolve
    // it to update-available rather than a phantom replay. The floor is already
    // at the manifest's sequence, so it is not advanced again.
    const { deps, saved } = makeDeps({ loadState: () => ({ salt: 's', highest_accepted_sequence: 200 }) });
    const r = await runReleaseCheck(deps);
    expect(r.status).toBe('update-available');
    expect(saved).toHaveLength(0);
  });

  it('⛔ STILL SURFACES THE RELEASE LONG PAST expires_at — no freshness gate', () => {
    // This asserted `stale-feed` until 2026-09-01. The gate punished the wrong
    // party: a stalled feed and a frozen one are indistinguishable from here, so
    // its only response was to refuse the newest release anyone has. `sequence`
    // still refuses a downgrade — see the replay arms above.
    return (async () => {
      const { deps } = makeDeps({ now: () => Date.parse('2030-01-01T00:00:00Z') });
      const r = await runReleaseCheck(deps);
      expect(r.status).toBe('update-available');
    })();
  });
});

/** ⛔⛔⛔ THE APPLY RESOLVER IS ALSO AN ACCEPTANCE. It used to refuse to advance
 *  the anti-replay floor, on a stated reason that was FALSE: "a failed apply
 *  would re-resolve the SAME manifest as a `replay` and lock out every retry".
 *  `resolve.ts` refuses only a STRICTLY lower sequence and keeps equality
 *  resolvable for exactly that retry — so the lockout could not happen, and what
 *  the refusal actually bought was a hole. `recued update apply` calls this and
 *  nothing else: no check runs on that path. */
describe('resolveForApply — the anti-replay floor', () => {
  /** One state cell shared across several resolves, as one install's would be. */
  const install = (start = 100) => {
    const state: ReleaseCheckState = { salt: 'fixed-salt', highest_accepted_sequence: start };
    return {
      state,
      at: (sequence: number) => makeDeps({
        manifest: manifestJson({ sequence }),
        loadState: () => state,
        saveState: (s: ReleaseCheckState) => { Object.assign(state, s); },
      }).deps,
    };
  };

  it('remembers a higher sequence even when nothing installs from it', async () => {
    const box = install();
    // This fixture publishes no native sidecar, so the apply refuses it — which
    // is the point: the manifest was fetched, VERIFIED and resolved, and that is
    // acceptance for anti-replay purposes whether or not an artifact follows.
    const resolved = await resolveForApply(box.at(200));
    expect(resolved.status).toBe('no-artifact');
    expect(resolved.report).toMatchObject({
      status: 'update-available',
      available: { version: '1.4.2' },
    });
    expect(box.state.highest_accepted_sequence).toBe(200);
  });

  // ⛔⛔ THE HOLE. Resolve 200, install nothing, then be handed a still-in-date
  // signed manifest at 150 — the freeze/downgrade I-10 exists to refuse. Without
  // the floor advancing above, this resolved happily.
  it('refuses a replayed older manifest afterwards', async () => {
    const box = install();
    await resolveForApply(box.at(200));
    expect((await resolveForApply(box.at(150))).status).toBe('replay');
    // …and the floor does not regress on the way past.
    expect(box.state.highest_accepted_sequence).toBe(200);
  });

  // ⚠ THE RETRY THE OLD COMMENT WAS PROTECTING. A failed apply re-resolves its
  // OWN sequence against a floor now equal to it. Equality is permitted, so it
  // proceeds — the behaviour the refusal was written to preserve, preserved.
  //
  // ⛔ ASSERTS THE RETRY AND NOTHING ELSE, DELIBERATELY. It first also checked the
  // floor, which made it go red under the mutation that removes the advance — for
  // the floor, not for the retry — so it looked like the mutation broke retries
  // and proved the opposite of its point. Staying GREEN under that mutation is
  // what shows the reason given for the old refusal was never load-bearing.
  it('still resolves the same sequence on a retry', async () => {
    const box = install();
    await resolveForApply(box.at(200));
    expect((await resolveForApply(box.at(200))).status).not.toBe('replay');
  });

  it('leaves the floor alone when the resolve is itself a replay', async () => {
    const box = install(300);
    expect((await resolveForApply(box.at(150))).status).toBe('replay');
    expect(box.state.highest_accepted_sequence).toBe(300);
  });
});
