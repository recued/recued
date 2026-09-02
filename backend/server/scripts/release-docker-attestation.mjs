/** Release-time registry attestation for signed Docker artifacts.
 *
 * A syntactically valid digest proves nothing about what was pushed. Before a
 * manifest can be signed or published, every declared Docker target must:
 *   - resolve at the exact image@sha256 digest;
 *   - be an OCI/Docker manifest list containing linux/amd64 + linux/arm64; and
 *   - run on BOTH declared platforms and report the exact stamped Recued
 *     version. A host-architecture-only run leaves the other descriptor as
 *     unexecuted registry metadata, which is not an attestation of its bytes.
 *
 * The helper accepts both release.config (`docker_baked`) and parsed manifest
 * (`artifacts['docker-baked']`) channel shapes so build and publish ask the same
 * question at their respective irreversible boundaries.
 */

import { spawnSync } from 'node:child_process';

const DOCKER_KINDS = [
  { artifact: 'docker-baked', config: 'docker_baked' },
  { artifact: 'docker-thin', config: 'docker_thin' },
];

const commandOutput = (result) => `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();

const declaredDockerArtifacts = (channels) => {
  const found = [];
  for (const [channel, release] of Object.entries(channels ?? {})) {
    for (const kind of DOCKER_KINDS) {
      const value = release?.artifacts?.[kind.artifact] ?? release?.[kind.config];
      if (!value) continue;
      found.push({ channel, kind: kind.artifact, image: value.image, digest: value.digest });
    }
  }
  return found;
};

export const assertDockerArtifactsAttested = ({
  channels,
  expectedVersion,
  run = spawnSync,
  log = (message) => console.log(message),
}) => {
  const declarations = declaredDockerArtifacts(channels);
  const seen = new Set();
  for (const declared of declarations) {
    const ref = `${declared.image}@${declared.digest}`;
    const identity = `${declared.kind}:${ref}`;
    if (seen.has(identity)) continue;
    seen.add(identity);

    const inspect = run(
      'docker',
      ['buildx', 'imagetools', 'inspect', ref],
      { encoding: 'utf8', windowsHide: true },
    );
    if (inspect.status !== 0 || inspect.error) {
      throw new Error(
        `${declared.channel}.${declared.kind}: registry digest is not inspectable: ${ref}`
          + `${commandOutput(inspect) ? `\n  ${commandOutput(inspect).slice(0, 500)}` : ''}`,
      );
    }
    const reportedDigest = /^Digest:\s*(sha256:[0-9a-f]{64})\s*$/mi.exec(inspect.stdout ?? '')?.[1];
    if (reportedDigest !== declared.digest) {
      throw new Error(
        `${declared.channel}.${declared.kind}: registry reported ${reportedDigest ?? 'no digest'} for ${ref}; `
          + `expected ${declared.digest}`,
      );
    }

    const raw = run(
      'docker',
      ['buildx', 'imagetools', 'inspect', ref, '--raw'],
      { encoding: 'utf8', windowsHide: true },
    );
    if (raw.status !== 0 || raw.error) {
      throw new Error(
        `${declared.channel}.${declared.kind}: could not read the registry manifest list for ${ref}`
          + `${commandOutput(raw) ? `\n  ${commandOutput(raw).slice(0, 500)}` : ''}`,
      );
    }
    let index;
    try {
      index = JSON.parse(raw.stdout ?? '');
    } catch {
      throw new Error(`${declared.channel}.${declared.kind}: registry returned malformed OCI JSON for ${ref}`);
    }
    const platforms = new Set(
      Array.isArray(index?.manifests)
        ? index.manifests
            .map((entry) => `${entry?.platform?.os ?? ''}/${entry?.platform?.architecture ?? ''}`)
            .filter((value) => !value.endsWith('/'))
        : [],
    );
    const missing = ['linux/amd64', 'linux/arm64'].filter((platform) => !platforms.has(platform));
    if (missing.length > 0) {
      throw new Error(
        `${declared.channel}.${declared.kind}: ${ref} is not the required dual-architecture image; `
          + `missing ${missing.join(', ')} (registry has ${[...platforms].sort().join(', ') || 'no platform index'})`,
      );
    }

    const attestedPlatforms = ['linux/amd64', 'linux/arm64'];
    for (const platform of attestedPlatforms) {
      const runArgs = declared.kind === 'docker-thin'
        ? ['run', '--rm', '--pull=always', '--platform', platform,
            '--entrypoint', '/opt/recued-seed/recued', ref, '--version']
        : ['run', '--rm', '--pull=always', '--platform', platform, ref, '--version'];
      const version = run('docker', runArgs, { encoding: 'utf8', windowsHide: true });
      const reportedVersion = (version.stdout ?? '').trim().split(/\r?\n/, 1)[0] ?? '';
      if (version.status !== 0 || version.error || reportedVersion !== expectedVersion) {
        throw new Error(
          `${declared.channel}.${declared.kind}: ${ref} on ${platform} self-reported `
            + `${JSON.stringify(reportedVersion || '(nothing)')}; expected ${JSON.stringify(expectedVersion)}`
            + `${commandOutput(version) ? `\n  ${commandOutput(version).slice(0, 500)}` : ''}`,
        );
      }
    }
    log(`[release-docker] attested ${declared.kind} ${ref} (${attestedPlatforms.join(', ')} executed; v${expectedVersion})`);
  }
  return declarations.length;
};
