import { describe, expect, it } from 'vitest';
import { isDockerArtifact, MANIFEST_SCHEMA_VERSION, ManifestError, parseManifest } from '../manifest.js';

const valid = () => JSON.stringify({
  schema_version: 1,
  sequence: 184,
  expires_at: '2026-07-16T10:00:00Z',
  min_launcher_version: 1,
  channels: {
    stable: {
      version: '1.4.2',
      released_at: '2026-07-02T10:00:00Z',
      min_supported: '1.2.0',
      migration: true,
      rollout_pct: 100,
      notes_url: 'https://recued.com/releases/1.4.2',
      artifacts: {
        'linux-x64': { url: 'https://x/l', sha256: 'aa', sig: 'ss' },
        'docker-thin': { image: 'recued/recued:managed', digest: 'sha256:dd' },
      },
    },
    edge: {
      version: '1.5.0-rc1', released_at: '2026-07-03T10:00:00Z', min_supported: '1.2.0',
      migration: false, rollout_pct: 25, notes_url: '', artifacts: { 'linux-x64': { url: 'u', sha256: 'a', sig: 's' } },
    },
  },
});

describe('parseManifest', () => {
  it('parses a well-formed manifest', () => {
    const m = parseManifest(valid());
    expect(m.sequence).toBe(184);
    expect(m.channels.stable?.version).toBe('1.4.2');
    expect(m.channels.stable?.migration).toBe(true);
    expect(m.channels.edge?.rollout_pct).toBe(25);
  });

  it('exposes docker artifacts as digest-anchored', () => {
    const m = parseManifest(valid());
    const thin = m.channels.stable?.artifacts['docker-thin'];
    expect(thin && isDockerArtifact(thin)).toBe(true);
    const bin = m.channels.stable?.artifacts['linux-x64'];
    expect(bin && isDockerArtifact(bin)).toBe(false);
  });

  it('ignores unknown fields (forward-compat I-9)', () => {
    const m = parseManifest(JSON.stringify({ ...JSON.parse(valid()), future_field: { whatever: 1 } }));
    expect(m.sequence).toBe(184);
  });

  it('refuses a newer schema_version', () => {
    const bad = JSON.parse(valid());
    bad.schema_version = MANIFEST_SCHEMA_VERSION + 1;
    expect(() => parseManifest(JSON.stringify(bad))).toThrow(ManifestError);
  });

  it('rejects malformed JSON, missing fields, bad rollout, and no channels', () => {
    expect(() => parseManifest('{')).toThrow(ManifestError);
    const noSeq = JSON.parse(valid()); delete noSeq.sequence;
    expect(() => parseManifest(JSON.stringify(noSeq))).toThrow(/sequence/);
    const badRollout = JSON.parse(valid()); badRollout.channels.stable.rollout_pct = 150;
    expect(() => parseManifest(JSON.stringify(badRollout))).toThrow(/rollout_pct/);
    const noChan = JSON.parse(valid()); noChan.channels = {};
    expect(() => parseManifest(JSON.stringify(noChan))).toThrow(/no known channels/);
  });

  it('rejects a binary artifact missing its detached signature (integrity boundary)', () => {
    const m = JSON.parse(valid());
    delete m.channels.stable.artifacts['linux-x64'].sig;
    expect(() => parseManifest(JSON.stringify(m))).toThrow(/artifact "linux-x64" missing "sig"/);
  });

  it('rejects a docker artifact missing its pinned digest', () => {
    const m = JSON.parse(valid());
    delete m.channels.stable.artifacts['docker-thin'].digest;
    expect(() => parseManifest(JSON.stringify(m))).toThrow(/missing "digest"/);
  });

  it('ignores unknown artifact kinds (forward-compat)', () => {
    const m = JSON.parse(valid());
    m.channels.stable.artifacts['flatpak-x64'] = { whatever: true };
    expect(() => parseManifest(JSON.stringify(m))).not.toThrow();
  });

  it('requires migration to be an explicit boolean', () => {
    const missing = JSON.parse(valid()); delete missing.channels.stable.migration;
    expect(() => parseManifest(JSON.stringify(missing))).toThrow(/migration/);
    const stringy = JSON.parse(valid()); stringy.channels.stable.migration = 'true';
    expect(() => parseManifest(JSON.stringify(stringy))).toThrow(/migration/);
  });

  // D-152 § A.16 — the arch-neutral webclient artifact (a binary-shaped
  // {url,sha256,sig}, keyed `webclient`).
  it('parses a webclient artifact + exposes it as a non-docker binary artifact', () => {
    const m = JSON.parse(valid());
    m.channels.stable.artifacts.webclient = { url: 'https://x/wc', sha256: 'ww', sig: 'wsig' };
    const parsed = parseManifest(JSON.stringify(m));
    const wc = parsed.channels.stable?.artifacts.webclient;
    expect(wc).toEqual({ url: 'https://x/wc', sha256: 'ww', sig: 'wsig' });
    expect(wc && isDockerArtifact(wc)).toBe(false);
  });

  it('accepts a manifest with no webclient artifact (binaries-only, backward-compat)', () => {
    const parsed = parseManifest(valid());
    expect(parsed.channels.stable?.artifacts.webclient).toBeUndefined();
  });

  it('rejects a webclient artifact missing its sig (the integrity boundary)', () => {
    const m = JSON.parse(valid());
    m.channels.stable.artifacts.webclient = { url: 'https://x/wc', sha256: 'ww' }; // no sig
    expect(() => parseManifest(JSON.stringify(m))).toThrow(/webclient.*sig|"sig"/);
  });
});
