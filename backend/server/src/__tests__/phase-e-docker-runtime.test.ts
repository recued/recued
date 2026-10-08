/** Phase E (D-107) - Docker runtime artifact smoke.
 *
 *  Builds the production image, runs it, and asserts the container SERVES —
 *  `state === 'running'` plus a green HEALTHCHECK, with the container logs
 *  attached to the failure message. It is the only test that catches a break
 *  visible solely when you start the thing.
 *
 *  ⛔⛔ IT USED TO BE OPT-IN BEHIND `RECUED_DOCKER_RUNTIME_SMOKE=1`, AND THAT IS
 *  WHY IT CAUGHT NOTHING. Unset, the gate below resolved to `describe.skip`, and
 *  a skipped suite is indistinguishable from a passing one in a summary line. Its
 *  only runner was a human reading a checklist box — which lived in
 *  internal design notes, a provenance manifest for a release that
 *  predates calendar versioning. Between ceremonies FOUR independent breaks
 *  landed, each fatal to the image on its own, with every default test run green:
 *  no `.dockerignore`; `builtinModules` used as a membership test; a stale
 *  `node:22-slim` pin; and `RECUED_DISTRIBUTION_CHANNEL` declared nowhere, which
 *  EACCES-crashlooped the container before its boot banner.
 *
 *  🔑 THE FIX IS THE POLARITY, NOT THE MECHANISM. A gate that defaults to SKIP
 *  turns a broken product into silence. A gate that defaults to RUN turns a
 *  broken environment into noise, and silencing it becomes a deliberate act.
 *  `RECUED_SKIP_FS_WATCH_LIVE` is the one gate in this tree that already had it
 *  the right way round; this now matches it, and matches the capability-detected
 *  `HAVE_RG` / `HAVE_OFFICECLI` drives that run wherever they can.
 *
 *  ⚠ COST, STATED PLAINLY: on any machine with a live Docker daemon this now runs
 *  inside `npm run ci` and adds roughly 4-5 minutes. Decline a single run with
 *  `RECUED_SKIP_DOCKER_SMOKE=1`.
 *
 *  Force it on where detection cannot see a daemon it should:
 *
 *    npm run test:docker-smoke
 *    RECUED_DOCKER_RUNTIME_SMOKE=1 npx vitest run --pool forks \
 *      backend/server/src/__tests__/phase-e-docker-runtime.test.ts
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PKG_ROOT = resolve(__dirname, '..', '..');
const REPO_ROOT = resolve(PKG_ROOT, '..', '..');
/** ⛔ BINARY PRESENCE IS NOT ENOUGH — THE DAEMON HAS TO BE UP. The sibling
 *  capability drives use `existsSync` on the well-known bin dirs, which is the
 *  right probe for `rg` or `find` and the wrong one here: `docker` is on PATH
 *  whenever Docker Desktop is INSTALLED, including while it is stopped, and this
 *  suite's first act is `docker build`. Detecting the binary would have converted
 *  "not available" into a red suite, which is the failure mode the default-run
 *  polarity exists to avoid. Asking the daemon is what keeps it self-healing. */
const dockerAvailable = (): boolean => {
  try {
    execFileSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
      stdio: 'ignore',
      timeout: 15_000,
    });
    return true;
  } catch {
    return false;
  }
};

/** Explicit decline for one run — the escape hatch that makes default-run
 *  tolerable while iterating. Opt OUT, never opt in. */
const OPTED_OUT = process.env.RECUED_SKIP_DOCKER_SMOKE === '1';

/** Retained so every invocation already written down keeps working
 *  (internal design notes, the 0.2.0 checklist, `npm run
 *  test:docker-smoke`). It now FORCES the suite on rather than being the only way
 *  to enable it — and forcing it where no daemon answers fails loudly, which is
 *  the informative result for someone who asked for it by name. */
const FORCED = process.env.RECUED_DOCKER_RUNTIME_SMOKE === '1';

const ENABLED = !OPTED_OUT && (FORCED || dockerAvailable());
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

/** ⛔ A REGISTRY BLIP IS NOT A BROKEN IMAGE (2026-10-07).
 *
 *  Every build asks Docker Hub for the `# syntax=` frontend and for each `FROM`
 *  tag, even with both cached, so this smoke depended on Docker Hub answering at
 *  that second. Three sweeps went red in one day, each in the build's first 10 s,
 *  and BuildKit's own record names the cause (`docker buildx history inspect`):
 *  `failed to fetch anonymous token: Get "https://auth.docker.io/…": EOF` twice,
 *  `node:24-slim: failed to do request: Head "https://registry-1.docker.io/…":
 *  EOF` once. Every other build that week completed. The runner keeps only the
 *  file's name, so it read as a flaky test.
 *
 *  Only a registry request that died in transit is retried. A step that fails,
 *  a pull rate limit, a Dockerfile that does not parse — anything else — is the
 *  image's (or the account's) failure and fails at once, with the log. */
const isTransientRegistryFailure = (output: string): boolean =>
  /(?:failed to fetch anonymous token|failed to authorize|failed to do request|failed to resolve source metadata)[^\n]*?(?::\s*(?:unexpected )?EOF\b|i\/o timeout|connection reset by peer|TLS handshake timeout|no such host|Client\.Timeout exceeded)/u
    .test(output);

const BUILD_ATTEMPTS = 3;

const buildImage = (): void => {
  for (let attempt = 1; attempt <= BUILD_ATTEMPTS; attempt += 1) {
    const build = spawnSync(
      'docker',
      ['build', '-f', 'backend/server/Dockerfile', '-t', IMAGE_TAG, '.'],
      { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
    );
    if (build.status === 0) return;
    const output = [build.error?.message, build.stdout, build.stderr].filter(Boolean).join('\n');
    if (attempt === BUILD_ATTEMPTS || !isTransientRegistryFailure(output)) {
      throw new Error(`docker build failed (attempt ${attempt} of ${BUILD_ATTEMPTS}):\n${output.slice(-6000)}`);
    }
    execFileSync('sleep', [String(10 * attempt)]);
  }
};

describe('Phase E - which docker build failures are retried', () => {
  // Docker Hub's own words, from the three builds that failed (2026-10-07).
  it.each([
    'ERROR: failed to solve: docker/dockerfile:1.7: failed to resolve source metadata for docker.io/docker/dockerfile:1.7: failed to authorize: failed to fetch anonymous token: Get "https://auth.docker.io/token?scope=repository%3Adocker%2Fdockerfile%3Apull&service=registry.docker.io": EOF',
    'ERROR: failed to solve: node:24-slim: failed to resolve source metadata for docker.io/library/node:24-slim: failed to do request: Head "https://registry-1.docker.io/v2/library/node/manifests/24-slim": EOF',
    'ERROR: failed to solve: node:24-slim: failed to do request: Head "https://registry-1.docker.io/v2/library/node/manifests/24-slim": dial tcp: lookup registry-1.docker.io: no such host',
  ])('a registry request that died in transit is retried: %s', (output) => {
    expect(isTransientRegistryFailure(output)).toBe(true);
  });

  it.each([
    'ERROR: failed to solve: process "/bin/sh -c npm ci --ignore-scripts" did not complete successfully: exit code: 1',
    'ERROR: failed to solve: node:24-slim: failed to resolve source metadata for docker.io/library/node:24-slim: failed to copy: httpReadSeeker: failed open: unexpected status code https://registry-1.docker.io/v2/library/node/manifests/sha256:abc: 429 Too Many Requests - Server message: toomanyrequests: You have reached your pull rate limit.',
    'ERROR: failed to solve: dockerfile parse error on line 12: unknown instruction: COPPY',
    'Get "https://auth.docker.io/token": EOF\nERROR: failed to solve: process "/bin/sh -c node scripts/build.mjs" did not complete successfully: exit code: 2',
  ])('anything else fails at once: %s', (output) => {
    expect(isTransientRegistryFailure(output)).toBe(false);
  });
});

const describeDocker = ENABLED ? describe : describe.skip;

describeDocker('Phase E - Docker runtime artifact smoke', () => {
  beforeAll(() => {
    docker(['info', '--format', '{{.ServerVersion}}']);
    buildImage();
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
    // ⛔ A SECOND VARIABLE, NOT A RESTATEMENT OF THE LINE ABOVE — they share the
    // value `docker-thin`, which is how the managed image came to set only the
    // supervisor mode and read as though it had declared its channel too.
    // Unset, `resolveDistributionChannel` defaults to `'binary'`, `bin.ts` leases
    // `dirname(process.execPath)` = root-owned `/usr/local/bin` as uid 1001, and
    // the container EACCES-crashloops before its banner. The serving assertions
    // at the bottom of this file catch that — when this suite is actually run.
    expect(inspect.Config.Env ?? []).toContain('RECUED_DISTRIBUTION_CHANNEL=docker-baked');
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
