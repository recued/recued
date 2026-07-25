import { describe, expect, it } from 'vitest';
import { generateKeypair, sign } from '@recued/release';
import { runReleaseCheck, sigUrlFor, type ReleaseCheckDeps } from '../update/release-check.js';
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

  it('surfaces a stale feed past expiry + grace', async () => {
    const { deps } = makeDeps({ now: () => Date.parse('2026-09-01T00:00:00Z') });
    const r = await runReleaseCheck(deps);
    expect(r.status).toBe('stale-feed');
    expect(r.expires_at).toBe('2026-07-16T10:00:00Z');
  });
});
