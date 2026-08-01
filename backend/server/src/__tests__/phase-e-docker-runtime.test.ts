/** Phase E (D-107) - Docker runtime artifact smoke.
 *
 *  This suite is intentionally opt-in because it builds the production
 *  Docker image. Run with:
 *
 *    RECUED_DOCKER_RUNTIME_SMOKE=1 npx vitest run --pool forks \
 *      backend/server/src/__tests__/phase-e-docker-runtime.test.ts
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PKG_ROOT = resolve(__dirname, '..', '..');
const REPO_ROOT = resolve(PKG_ROOT, '..', '..');
const ENABLED = process.env.RECUED_DOCKER_RUNTIME_SMOKE === '1';
const IMAGE_TAG = `recued-server:phase-e-runtime-smoke-${process.pid}`;

const readPackageJson = (): {
  name: string;
  version: string;
  license: string;
} => JSON.parse(readFileSync(resolve(PKG_ROOT, 'package.json'), 'utf8'));

type DockerImageInspect = {
  Config: {
    Cmd?: string[];
    Entrypoint?: string[];
    Env?: string[];
    ExposedPorts?: Record<string, unknown>;
    Labels?: Record<string, string>;
    User?: string;
    WorkingDir?: string;
  };
};

const docker = (args: string[], options: { encoding?: BufferEncoding } = {}): string =>
  execFileSync('docker', args, {
    cwd: REPO_ROOT,
    encoding: options.encoding ?? 'utf8',
  });

const runImageShell = (script: string): string =>
  docker(['run', '--rm', '--entrypoint', 'sh', IMAGE_TAG, '-lc', script]);

const describeDocker = ENABLED ? describe : describe.skip;

describeDocker('Phase E - Docker runtime artifact smoke', () => {
  beforeAll(() => {
    docker(['info', '--format', '{{.ServerVersion}}']);
    execFileSync(
      'docker',
      ['build', '-f', 'backend/server/Dockerfile', '-t', IMAGE_TAG, '.'],
      { cwd: REPO_ROOT, stdio: 'inherit' },
    );
  }, 900_000);

  afterAll(() => {
    try {
      execFileSync('docker', ['image', 'rm', '-f', IMAGE_TAG], {
        cwd: REPO_ROOT,
        stdio: 'ignore',
      });
    } catch {
      // Best-effort cleanup only.
    }
  });

  it('runtime image metadata matches the package release metadata', () => {
    const pkg = readPackageJson();
    const [inspect] = JSON.parse(
      docker(['image', 'inspect', IMAGE_TAG]),
    ) as DockerImageInspect[];

    expect(inspect.Config.User).toBe('recued');
    expect(inspect.Config.WorkingDir).toBe('/opt/recued');
    expect(inspect.Config.Entrypoint).toEqual(['/usr/local/bin/recued-entrypoint']);
    expect(inspect.Config.Cmd).toEqual([
      '--db',
      '/var/lib/recued/recued.db',
      '--config',
      '/etc/recued/config.toml',
    ]);
    expect(inspect.Config.Env ?? []).toContain('RECUED_SUPERVISOR_MODE=docker');
    expect(inspect.Config.Labels?.['org.opencontainers.image.title']).toBe('recued-server');
    expect(inspect.Config.Labels?.['org.opencontainers.image.licenses']).toBe(pkg.license);
    expect(Object.keys(inspect.Config.ExposedPorts ?? {}).sort()).toEqual([
      '7717/tcp',
      '7718/tcp',
      '7719/tcp',
    ]);

    const imagePackage = JSON.parse(
      docker([
        'run',
        '--rm',
        '--entrypoint',
        'node',
        IMAGE_TAG,
        '-e',
        'process.stdout.write(require("fs").readFileSync("/opt/recued/package.json","utf8"))',
      ]),
    ) as { name: string; version: string; license: string };
    expect(imagePackage.name).toBe(pkg.name);
    expect(imagePackage.version).toBe(pkg.version);
    expect(imagePackage.license).toBe(pkg.license);
  }, 120_000);

  it('ships the built runtime surface without source files', () => {
    runImageShell([
      'test -x /usr/local/bin/recued-entrypoint',
      'test -f /opt/recued/dist/bin.js',
      'test -f /opt/recued/dist/index.js',
      'test ! -e /opt/recued/scripts/rollback.mjs',
      'test -f /opt/recued/config.sample.toml',
      'test ! -e /opt/recued/backend/server/src/bin.ts',
      'test ! -e /opt/recued/backend/server/Dockerfile',
    ].join(' && '));
  }, 120_000);

  it('runs --version without creating the configured DB path', () => {
    const pkg = readPackageJson();
    const out = runImageShell([
      'db=/tmp/must-not-exist.db',
      'rm -f "$db"',
      '/usr/local/bin/recued-entrypoint --version --db "$db"',
      'test ! -e "$db"',
    ].join(' && ')).trim();

    expect(out).toBe(pkg.version);
  }, 120_000);

  it('runs --help without creating the configured DB path', () => {
    const out = runImageShell([
      'db=/tmp/must-not-exist.db',
      'rm -f "$db"',
      '/usr/local/bin/recued-entrypoint --help --db "$db"',
      'test ! -e "$db"',
    ].join(' && '));

    expect(out).toContain('recued-server');
    expect(out).toContain('your personal warehouse + 24/7 recipe runner');
    expect(out).toContain('--db <path>');
    expect(out).toContain('Pairing:');
  }, 120_000);

  /** ⛔ THE GAP THAT LET A DEAD IMAGE SHIP. Every check above either inspects
   *  metadata or runs `--version` / `--help` — the two commands that never open
   *  a database. So nothing loaded the SQLite driver, and the image spent an
   *  unknown period unable to start at all:
   *
   *      Could not locate the bindings file. Tried:
   *       → …/better-sqlite3-multiple-ciphers/lib/binding/node-v127-linux-arm64/…
   *
   *  D-212 made the cipher fork the sole runtime driver and demoted plain
   *  `better-sqlite3` to dev-only, but the Dockerfile kept rebuilding the plain
   *  one. A green build, green metadata assertions, and a container that died on
   *  its first line.
   *
   *  🔑 The only test that catches "does it actually run" is running it. This
   *  one boots the real entrypoint, waits for the server to serve, and asserts
   *  the HEALTHCHECK the orchestrator will use goes green — which separately
   *  catches probing with a binary the image does not have (it used `wget`;
   *  node:22-slim has none, so containers sat `unhealthy` forever). */
  it('⛔ BOOTS, opens its database, and reaches HEALTHY', () => {
    const name = `recued-boot-smoke-${process.pid}`;
    docker(['rm', '-f', name]);
    try {
      docker(['run', '-d', '--name', name, IMAGE_TAG]);

      // Poll rather than sleep — the health probe has its own start period.
      let health = '';
      let state = '';
      for (let i = 0; i < 40; i += 1) {
        state = docker(['inspect', name, '--format', '{{.State.Status}}']).trim();
        health = docker([
          'inspect', name, '--format',
          '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}',
        ]).trim();
        if (state !== 'running' || health === 'healthy' || health === 'unhealthy') break;
        execFileSync('sleep', ['3']);
      }

      const logs = docker(['logs', name], { encoding: 'utf8' });
      // Name the actual failure in the assertion message — a bare `false` here
      // sends the reader to the wrong place entirely.
      expect(state, `container exited instead of serving. logs:\n${logs}`).toBe('running');
      expect(logs).not.toMatch(/Could not locate the bindings file/);
      expect(health, `HEALTHCHECK never went green. logs:\n${logs}`).toBe('healthy');
    } finally {
      docker(['rm', '-f', name]);
    }
  }, 180_000);
});
