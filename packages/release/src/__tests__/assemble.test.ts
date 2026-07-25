import { describe, expect, it } from 'vitest';
import {
  artifactTrustedComment,
  assembleManifest,
  manifestTrustedComment,
  serializeManifest,
  signArtifact,
  signManifest,
  type ManifestInput,
} from '../assemble.js';
import { parseManifest } from '../manifest.js';
import { generateKeypair, verify } from '../minisign.js';

const baseInput = (): ManifestInput => ({
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
      binaries: {
        'linux-x64': { url: 'https://cdn/recued-linux-x64', sha256: 'a'.repeat(64), sig: 'sig-lx' },
        'macos-arm64': { url: 'https://cdn/recued-macos-arm64', sha256: 'b'.repeat(64), sig: 'sig-mac' },
      },
      dockerBaked: { image: 'recued/server', digest: 'sha256:' + 'c'.repeat(64) },
    },
  },
});

describe('assembleManifest', () => {
  it('produces a manifest the consumer parser accepts', () => {
    const m = assembleManifest(baseInput());
    expect(m.sequence).toBe(184);
    expect(m.channels.stable?.version).toBe('1.4.2');
    expect(m.channels.stable?.artifacts['linux-x64']?.sig).toBe('sig-lx');
    expect(m.channels.stable?.artifacts['docker-baked']?.digest).toBe('sha256:' + 'c'.repeat(64));
    // round-trips through the real parser without throwing
    expect(() => parseManifest(serializeManifest(m))).not.toThrow();
  });

  it('refuses a binary artifact missing its sig (integrity boundary I-2)', () => {
    const input = baseInput();
    // @ts-expect-error — deliberately drop the sig
    input.channels.stable.binaries['linux-x64'] = { url: 'u', sha256: 'd'.repeat(64) };
    expect(() => assembleManifest(input)).toThrow();
  });

  it('omits docker artifacts that were not provided', () => {
    const input = baseInput();
    delete input.channels.stable!.dockerBaked;
    const m = assembleManifest(input);
    expect(m.channels.stable?.artifacts['docker-baked']).toBeUndefined();
  });
});

describe('serializeManifest', () => {
  it('is deterministic and newline-terminated (the exact published bytes)', () => {
    const m = assembleManifest(baseInput());
    const a = serializeManifest(m);
    const b = serializeManifest(assembleManifest(baseInput()));
    expect(a).toBe(b);
    expect(a.endsWith('}\n')).toBe(true);
  });
});

describe('trusted comments', () => {
  it('bind artifact file name + version, and the manifest sequence', () => {
    expect(artifactTrustedComment('recued-linux-x64', '1.4.2')).toBe('recued binary recued-linux-x64 v1.4.2');
    expect(manifestTrustedComment(184)).toBe('recued release manifest seq 184');
  });
});

describe('signing round-trips against the consumer verifier', () => {
  const kp = generateKeypair();

  it('signs the manifest over the exact published bytes', () => {
    const m = assembleManifest(baseInput());
    const { json, sig } = signManifest(m, kp);
    const res = verify({ content: Buffer.from(json, 'utf8'), signatureText: sig, publicKeyText: kp.publicKeyText });
    expect(res.ok).toBe(true);
    expect(res.trustedComment).toBe('recued release manifest seq 184');
  });

  it('a tampered manifest body fails verification', () => {
    const m = assembleManifest(baseInput());
    const { json, sig } = signManifest(m, kp);
    const tampered = json.replace('1.4.2', '9.9.9');
    expect(verify({ content: Buffer.from(tampered, 'utf8'), signatureText: sig, publicKeyText: kp.publicKeyText }).ok).toBe(false);
  });

  it('signs a binary artifact with a file+version-bound trusted comment', () => {
    const content = Buffer.from('fake binary bytes');
    const sig = signArtifact({ content, fileName: 'recued-macos-arm64', version: '1.4.2', key: kp });
    const res = verify({ content, signatureText: sig, publicKeyText: kp.publicKeyText });
    expect(res.ok).toBe(true);
    expect(res.trustedComment).toBe('recued binary recued-macos-arm64 v1.4.2');
  });
});
