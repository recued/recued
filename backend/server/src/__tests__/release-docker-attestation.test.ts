import { describe, expect, it, vi } from 'vitest';

import { assertDockerArtifactsAttested } from '../../scripts/release-docker-attestation.mjs';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const REF = `registry.example/recued/server@${DIGEST}`;

const index = (platforms = ['amd64', 'arm64']): string => JSON.stringify({
  schemaVersion: 2,
  manifests: platforms.map((architecture) => ({ platform: { os: 'linux', architecture } })),
});

const runner = (over: {
  digest?: string;
  platforms?: string[];
  version?: string;
  versions?: Partial<Record<'linux/amd64' | 'linux/arm64', string>>;
} = {}) =>
  vi.fn((_command: string, args: string[]) => {
    if (args[0] === 'run') {
      const platform = args[args.indexOf('--platform') + 1] as 'linux/amd64' | 'linux/arm64';
      return { status: 0, stdout: `${over.versions?.[platform] ?? over.version ?? '26.9.1'}\n`, stderr: '' };
    }
    if (args.includes('--raw')) return { status: 0, stdout: index(over.platforms), stderr: '' };
    return { status: 0, stdout: `Name: ${REF}\nDigest: ${over.digest ?? DIGEST}\n`, stderr: '' };
  });

describe('release Docker registry attestation', () => {
  it('attests the exact digest, both Linux architectures, and the baked runtime version', () => {
    const run = runner();
    expect(assertDockerArtifactsAttested({
      channels: {
        stable: { docker_baked: { image: 'registry.example/recued/server', digest: DIGEST } },
      },
      expectedVersion: '26.9.1',
      run,
      log: () => {},
    })).toBe(1);
    expect(run).toHaveBeenCalledWith(
      'docker',
      ['buildx', 'imagetools', 'inspect', REF],
      expect.any(Object),
    );
    expect(run).toHaveBeenCalledWith(
      'docker',
      ['run', '--rm', '--pull=always', '--platform', 'linux/amd64', REF, '--version'],
      expect.any(Object),
    );
    expect(run).toHaveBeenCalledWith(
      'docker',
      ['run', '--rm', '--pull=always', '--platform', 'linux/arm64', REF, '--version'],
      expect.any(Object),
    );
  });

  it('uses the signed seed executable to attest a thin image', () => {
    const run = runner();
    assertDockerArtifactsAttested({
      channels: {
        stable: { artifacts: { 'docker-thin': { image: 'registry.example/recued/server', digest: DIGEST } } },
      },
      expectedVersion: '26.9.1',
      run,
      log: () => {},
    });
    expect(run).toHaveBeenCalledWith(
      'docker',
      ['run', '--rm', '--pull=always', '--platform', 'linux/amd64',
        '--entrypoint', '/opt/recued-seed/recued', REF, '--version'],
      expect.any(Object),
    );
  });

  it('refuses a digest whose registry descriptor does not match', () => {
    expect(() => assertDockerArtifactsAttested({
      channels: { stable: { docker_baked: { image: 'registry.example/recued/server', digest: DIGEST } } },
      expectedVersion: '26.9.1',
      run: runner({ digest: `sha256:${'b'.repeat(64)}` }),
      log: () => {},
    })).toThrow(/registry reported/);
  });

  it('refuses a single-architecture image', () => {
    expect(() => assertDockerArtifactsAttested({
      channels: { stable: { docker_baked: { image: 'registry.example/recued/server', digest: DIGEST } } },
      expectedVersion: '26.9.1',
      run: runner({ platforms: ['amd64'] }),
      log: () => {},
    })).toThrow(/missing linux\/arm64/);
  });

  it('refuses an image that self-reports a different release', () => {
    expect(() => assertDockerArtifactsAttested({
      channels: { stable: { docker_baked: { image: 'registry.example/recued/server', digest: DIGEST } } },
      expectedVersion: '26.9.1',
      run: runner({ version: '26.8.31' }),
      log: () => {},
    })).toThrow(/expected "26\.9\.1"/);
  });

  it('refuses when only the non-host architecture self-reports a different release', () => {
    expect(() => assertDockerArtifactsAttested({
      channels: { stable: { docker_baked: { image: 'registry.example/recued/server', digest: DIGEST } } },
      expectedVersion: '26.9.1',
      run: runner({ versions: { 'linux/arm64': '26.8.31' } }),
      log: () => {},
    })).toThrow(/linux\/arm64.*expected "26\.9\.1"/);
  });
});
