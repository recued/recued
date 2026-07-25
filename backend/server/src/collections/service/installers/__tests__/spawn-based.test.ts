/** D-118 Phase 3 — argv assertions for the eight spawn-based
 *  installer kinds (everything except `download`).
 *
 *  Each kind's install / upgrade / uninstall must emit the exact
 *  argv from the spec install table (line 423-433). Drift here
 *  changes operator behavior silently (a bad uninstall flag could
 *  leave files behind), so the tests are intentionally pinned to
 *  the literal argv arrays.
 */

import { describe, expect, it, vi } from 'vitest';

import { brewInstaller } from '../brew.js';
import { cargoInstaller } from '../cargo.js';
import { dockerPullInstaller } from '../docker-pull.js';
import { goInstaller } from '../go-install.js';
import { npmInstaller } from '../npm.js';
import { pipInstaller } from '../pip.js';
import { scoopInstaller } from '../scoop.js';
import { wingetInstaller } from '../winget.js';
import {
  type InstallerContext,
  type SpawnFn,
  type SpawnResult,
} from '../types.js';

const ok: SpawnResult = { exit_code: 0, log_lines: [] };

const makeCtx = (spawn: SpawnFn): InstallerContext => ({
  dataPath: '/srv/recued',
  slug: 'demo',
  spawn,
});

const captureSpawn = () => {
  const calls: Array<{
    argv: string[];
    env?: Record<string, string>;
    cwd?: string;
  }> = [];
  const spawn: SpawnFn = async (argv, opts) => {
    calls.push({ argv, env: opts?.env, cwd: opts?.cwd });
    return ok;
  };
  return { calls, spawn };
};

// ────────────────────────────────────────────────────────────────
// brew
// ────────────────────────────────────────────────────────────────

describe('brewInstaller', () => {
  it('install runs `brew install <pkg>`', async () => {
    const { calls, spawn } = captureSpawn();
    await brewInstaller.install({ package: 'ffmpeg' }, makeCtx(spawn));
    expect(calls[0].argv).toEqual(['brew', 'install', 'ffmpeg']);
  });
  it('upgrade runs `brew upgrade <pkg>`', async () => {
    const { calls, spawn } = captureSpawn();
    await brewInstaller.upgrade({ package: 'ffmpeg' }, makeCtx(spawn));
    expect(calls[0].argv).toEqual(['brew', 'upgrade', 'ffmpeg']);
  });
  it('uninstall runs `brew uninstall <pkg>`', async () => {
    const { calls, spawn } = captureSpawn();
    await brewInstaller.uninstall({ package: 'ffmpeg' }, makeCtx(spawn));
    expect(calls[0].argv).toEqual(['brew', 'uninstall', 'ffmpeg']);
  });
});

// ────────────────────────────────────────────────────────────────
// scoop
// ────────────────────────────────────────────────────────────────

describe('scoopInstaller', () => {
  it('install runs `scoop install <pkg>`', async () => {
    const { calls, spawn } = captureSpawn();
    await scoopInstaller.install({ package: 'pandoc' }, makeCtx(spawn));
    expect(calls[0].argv).toEqual(['scoop', 'install', 'pandoc']);
  });
  it('upgrade uses scoop\'s `update` verb (not `upgrade`)', async () => {
    const { calls, spawn } = captureSpawn();
    await scoopInstaller.upgrade({ package: 'pandoc' }, makeCtx(spawn));
    expect(calls[0].argv).toEqual(['scoop', 'update', 'pandoc']);
  });
  it('uninstall runs `scoop uninstall <pkg>`', async () => {
    const { calls, spawn } = captureSpawn();
    await scoopInstaller.uninstall({ package: 'pandoc' }, makeCtx(spawn));
    expect(calls[0].argv).toEqual(['scoop', 'uninstall', 'pandoc']);
  });
});

// ────────────────────────────────────────────────────────────────
// winget
// ────────────────────────────────────────────────────────────────

describe('wingetInstaller', () => {
  it('install pins --scope user (no admin elevation)', async () => {
    const { calls, spawn } = captureSpawn();
    await wingetInstaller.install({ package: 'Gyan.FFmpeg' }, makeCtx(spawn));
    expect(calls[0].argv).toEqual([
      'winget', 'install', 'Gyan.FFmpeg', '--scope', 'user',
    ]);
  });
  it('upgrade does not need --scope user (winget infers from install)', async () => {
    const { calls, spawn } = captureSpawn();
    await wingetInstaller.upgrade({ package: 'Gyan.FFmpeg' }, makeCtx(spawn));
    expect(calls[0].argv).toEqual(['winget', 'upgrade', 'Gyan.FFmpeg']);
  });
  it('uninstall runs `winget uninstall <pkg>`', async () => {
    const { calls, spawn } = captureSpawn();
    await wingetInstaller.uninstall({ package: 'Gyan.FFmpeg' }, makeCtx(spawn));
    expect(calls[0].argv).toEqual(['winget', 'uninstall', 'Gyan.FFmpeg']);
  });
});

// ────────────────────────────────────────────────────────────────
// npm — env override is load-bearing for sudo-free installs
// ────────────────────────────────────────────────────────────────

describe('npmInstaller', () => {
  it('install runs `npm install -g <pkg>` with NPM_CONFIG_PREFIX', async () => {
    const { calls, spawn } = captureSpawn();
    await npmInstaller.install({ package: 'wrangler' }, makeCtx(spawn));
    expect(calls[0].argv).toEqual(['npm', 'install', '-g', 'wrangler']);
    expect(calls[0].env?.NPM_CONFIG_PREFIX).toBe('/srv/recued/npm-prefix');
  });

  it('upgrade with target produces `<pkg>@<target>`', async () => {
    const { calls, spawn } = captureSpawn();
    await npmInstaller.upgrade(
      { package: 'wrangler', target: '3.45.1' },
      makeCtx(spawn),
    );
    expect(calls[0].argv).toEqual(['npm', 'install', '-g', 'wrangler@3.45.1']);
  });

  it('upgrade without target re-installs the unpinned spec', async () => {
    const { calls, spawn } = captureSpawn();
    await npmInstaller.upgrade({ package: 'wrangler' }, makeCtx(spawn));
    expect(calls[0].argv).toEqual(['npm', 'install', '-g', 'wrangler']);
  });

  it('uninstall runs `npm uninstall -g <pkg>` with same env', async () => {
    const { calls, spawn } = captureSpawn();
    await npmInstaller.uninstall({ package: 'wrangler' }, makeCtx(spawn));
    expect(calls[0].argv).toEqual(['npm', 'uninstall', '-g', 'wrangler']);
    expect(calls[0].env?.NPM_CONFIG_PREFIX).toBe('/srv/recued/npm-prefix');
  });
});

// ────────────────────────────────────────────────────────────────
// pip — --user mandatory
// ────────────────────────────────────────────────────────────────

describe('pipInstaller', () => {
  it('install pins --user', async () => {
    const { calls, spawn } = captureSpawn();
    await pipInstaller.install({ package: 'yt-dlp', user: true }, makeCtx(spawn));
    expect(calls[0].argv).toEqual(['pip', 'install', '--user', 'yt-dlp']);
  });
  it('upgrade uses --user --upgrade', async () => {
    const { calls, spawn } = captureSpawn();
    await pipInstaller.upgrade({ package: 'yt-dlp', user: true }, makeCtx(spawn));
    expect(calls[0].argv).toEqual(['pip', 'install', '--user', '--upgrade', 'yt-dlp']);
  });
  it('uninstall uses -y so it never blocks on prompt', async () => {
    const { calls, spawn } = captureSpawn();
    await pipInstaller.uninstall({ package: 'yt-dlp', user: true }, makeCtx(spawn));
    expect(calls[0].argv).toEqual(['pip', 'uninstall', '-y', 'yt-dlp']);
  });
});

// ────────────────────────────────────────────────────────────────
// cargo — upgrade needs --force
// ────────────────────────────────────────────────────────────────

describe('cargoInstaller', () => {
  it('install runs `cargo install <pkg>`', async () => {
    const { calls, spawn } = captureSpawn();
    await cargoInstaller.install({ package: 'ripgrep' }, makeCtx(spawn));
    expect(calls[0].argv).toEqual(['cargo', 'install', 'ripgrep']);
  });
  it('upgrade requires --force (cargo refuses re-install otherwise)', async () => {
    const { calls, spawn } = captureSpawn();
    await cargoInstaller.upgrade({ package: 'ripgrep' }, makeCtx(spawn));
    expect(calls[0].argv).toEqual(['cargo', 'install', '--force', 'ripgrep']);
  });
  it('uninstall runs `cargo uninstall <pkg>`', async () => {
    const { calls, spawn } = captureSpawn();
    await cargoInstaller.uninstall({ package: 'ripgrep' }, makeCtx(spawn));
    expect(calls[0].argv).toEqual(['cargo', 'uninstall', 'ripgrep']);
  });
});

// ────────────────────────────────────────────────────────────────
// go_install — version pin + binary_name uninstall
// ────────────────────────────────────────────────────────────────

describe('goInstaller', () => {
  it('install with explicit version uses `<pkg>@<version>`', async () => {
    const { calls, spawn } = captureSpawn();
    await goInstaller.install(
      { package: 'github.com/cli/cli/v2/cmd/gh', binary_name: 'gh', version: 'v2.45.0' },
      makeCtx(spawn),
    );
    expect(calls[0].argv).toEqual([
      'go', 'install', 'github.com/cli/cli/v2/cmd/gh@v2.45.0',
    ]);
  });
  it('install without version defaults to @latest', async () => {
    const { calls, spawn } = captureSpawn();
    await goInstaller.install(
      { package: 'github.com/cli/cli/v2/cmd/gh', binary_name: 'gh' },
      makeCtx(spawn),
    );
    expect(calls[0].argv).toEqual([
      'go', 'install', 'github.com/cli/cli/v2/cmd/gh@latest',
    ]);
  });
  it('upgrade target overrides the install version', async () => {
    const { calls, spawn } = captureSpawn();
    await goInstaller.upgrade(
      {
        package: 'github.com/cli/cli/v2/cmd/gh',
        binary_name: 'gh',
        version: 'v2.45.0',
        target: 'v2.46.0',
      },
      makeCtx(spawn),
    );
    expect(calls[0].argv).toEqual([
      'go', 'install', 'github.com/cli/cli/v2/cmd/gh@v2.46.0',
    ]);
  });
  it('uninstall removes binary from $GOPATH/bin via rm -f', async () => {
    const { calls, spawn } = captureSpawn();
    const previousGopath = process.env.GOPATH;
    process.env.GOPATH = '/tmp/gopath';
    try {
      await goInstaller.uninstall(
        { package: 'github.com/cli/cli/v2/cmd/gh', binary_name: 'gh' },
        makeCtx(spawn),
      );
    } finally {
      if (previousGopath === undefined) delete process.env.GOPATH;
      else process.env.GOPATH = previousGopath;
    }
    expect(calls[0].argv).toEqual(['rm', '-f', '/tmp/gopath/bin/gh']);
  });
});

// ────────────────────────────────────────────────────────────────
// docker_pull — upgrade target replaces tag
// ────────────────────────────────────────────────────────────────

describe('dockerPullInstaller', () => {
  it('install pulls the image as declared', async () => {
    const { calls, spawn } = captureSpawn();
    await dockerPullInstaller.install({ image: 'ollama/ollama:latest' }, makeCtx(spawn));
    expect(calls[0].argv).toEqual(['docker', 'pull', 'ollama/ollama:latest']);
  });
  it('upgrade with bare tag replaces tag on the image', async () => {
    const { calls, spawn } = captureSpawn();
    await dockerPullInstaller.upgrade(
      { image: 'ollama/ollama:0.1.32', target: '0.1.33' },
      makeCtx(spawn),
    );
    expect(calls[0].argv).toEqual(['docker', 'pull', 'ollama/ollama:0.1.33']);
  });
  it('upgrade with full reference uses target as-is', async () => {
    const { calls, spawn } = captureSpawn();
    await dockerPullInstaller.upgrade(
      { image: 'ollama/ollama:0.1.32', target: 'ghcr.io/ollama/ollama:0.1.33' },
      makeCtx(spawn),
    );
    expect(calls[0].argv).toEqual([
      'docker', 'pull', 'ghcr.io/ollama/ollama:0.1.33',
    ]);
  });
  it('upgrade without target re-pulls the same image', async () => {
    const { calls, spawn } = captureSpawn();
    await dockerPullInstaller.upgrade(
      { image: 'ollama/ollama:0.1.32' },
      makeCtx(spawn),
    );
    expect(calls[0].argv).toEqual(['docker', 'pull', 'ollama/ollama:0.1.32']);
  });
  it('uninstall runs `docker rmi <img>`', async () => {
    const { calls, spawn } = captureSpawn();
    await dockerPullInstaller.uninstall({ image: 'ollama/ollama:latest' }, makeCtx(spawn));
    expect(calls[0].argv).toEqual(['docker', 'rmi', 'ollama/ollama:latest']);
  });
});

// ────────────────────────────────────────────────────────────────
// onStdout streaming — cross-cutting smoke
// ────────────────────────────────────────────────────────────────

describe('onStdout pass-through', () => {
  it('installer outcome carries the spawn helper\'s log_lines', async () => {
    const spawn: SpawnFn = async () => ({
      exit_code: 0,
      log_lines: ['Installing…', 'Done.'],
    });
    const lines: string[] = [];
    const result = await brewInstaller.install(
      { package: 'ffmpeg' },
      { dataPath: '/d', slug: 's', spawn, onStdout: (l) => lines.push(l) },
    );
    expect(result.log_lines).toEqual(['Installing…', 'Done.']);
    // onStdout is the spawn-helper's responsibility (live UI
    // streaming); the spawn-based installers themselves don't need
    // to forward — the helper does. Explicit check the contract:
    // installers DON'T double-fire onStdout for log_lines.
    expect(lines).toEqual([]);
  });

  it('vi.fn spawn captures call shape', async () => {
    const spawn = vi.fn<SpawnFn>(async () => ok);
    await brewInstaller.install({ package: 'ffmpeg' }, makeCtx(spawn));
    expect(spawn).toHaveBeenCalledOnce();
  });
});
