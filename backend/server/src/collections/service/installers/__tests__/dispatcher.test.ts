/** D-118 Phase 3 — installer dispatcher tests.
 *
 *  Closed-registry routing — every kind in `SERVICE_INSTALL_KINDS`
 *  must map; unknown kinds fail loud; per-kind validation runs
 *  before any spawn.
 */

import { describe, expect, it, vi } from 'vitest';

import { SERVICE_INSTALL_KINDS } from '@recued/contracts';

import { runInstaller } from '../dispatcher.js';
import {
  InstallerParamError,
  type InstallerContext,
  type SpawnFn,
} from '../types.js';

const ctx = (extra?: Partial<InstallerContext>): InstallerContext => ({
  dataPath: '/srv/recued',
  slug: 'demo',
  spawn: async () => ({ exit_code: 0, log_lines: [] }),
  ...extra,
});

describe('runInstaller — kind routing', () => {
  it('rejects unknown kinds with InstallerParamError', async () => {
    await expect(
      runInstaller('apt' as never, 'install', { package: 'curl' }, ctx()),
    ).rejects.toThrow(InstallerParamError);
  });

  it('routes to the brew handler when kind = brew', async () => {
    const spawn = vi.fn<SpawnFn>(async () => ({ exit_code: 0, log_lines: [] }));
    await runInstaller('brew', 'install', { package: 'ffmpeg' }, ctx({ spawn }));
    expect(spawn).toHaveBeenCalledOnce();
    expect(spawn.mock.calls[0][0]).toEqual(['brew', 'install', 'ffmpeg']);
  });

  it('routes to the docker_pull handler when kind = docker_pull', async () => {
    const spawn = vi.fn<SpawnFn>(async () => ({ exit_code: 0, log_lines: [] }));
    await runInstaller(
      'docker_pull',
      'install',
      { image: 'ollama/ollama:latest' },
      ctx({ spawn }),
    );
    expect(spawn.mock.calls[0][0]).toEqual([
      'docker', 'pull', 'ollama/ollama:latest',
    ]);
  });

  it('every contract kind is wired in the dispatcher', async () => {
    // Pass shape-compatible (but minimal) params; we only need
    // the dispatcher not to throw `unknown install kind`. Per-kind
    // validation may still throw, which is what we filter on.
    const stubParams: Record<string, unknown> = {
      brew: { package: 'p' },
      scoop: { package: 'p' },
      winget: { package: 'p' },
      npm: { package: 'p' },
      pip: { package: 'p', user: true },
      cargo: { package: 'p' },
      go_install: { package: 'p', binary_name: 'p' },
      docker_pull: { image: 'i' },
      download: {
        url: 'https://example.com/x',
        sha256: 'a'.repeat(64),
        target: 'tools/x',
      },
    };
    for (const kind of SERVICE_INSTALL_KINDS) {
      // download has its own io path; skip in this routing-only smoke
      // (covered comprehensively in download.test.ts).
      if (kind === 'download') continue;
      const spawn = vi.fn<SpawnFn>(async () => ({ exit_code: 0, log_lines: [] }));
      await runInstaller(kind, 'install', stubParams[kind], ctx({ spawn }));
      expect(spawn, `kind=${kind}`).toHaveBeenCalledOnce();
    }
  });
});

describe('runInstaller — param validation', () => {
  it('brew: missing `package` throws InstallerParamError before spawn', async () => {
    const spawn = vi.fn<SpawnFn>(async () => ({ exit_code: 0, log_lines: [] }));
    await expect(
      runInstaller('brew', 'install', {}, ctx({ spawn })),
    ).rejects.toThrow(/package required/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('pip: missing `user: true` is a fatal manifest error', async () => {
    await expect(
      runInstaller('pip', 'install', { package: 'p' }, ctx()),
    ).rejects.toThrow(/user: true required/);
  });

  it('go_install: missing `binary_name` is a fatal manifest error', async () => {
    await expect(
      runInstaller('go_install', 'install', { package: 'p' }, ctx()),
    ).rejects.toThrow(/binary_name required/);
  });

  it('download: http:// url is rejected at validate time', async () => {
    await expect(
      runInstaller(
        'download',
        'install',
        {
          url: 'http://example.com/x',
          sha256: 'a'.repeat(64),
          target: 'tools/x',
        },
        ctx(),
      ),
    ).rejects.toThrow(/https/);
  });

  it('ignores inherited required params for every install kind', async () => {
    const inheritedOnly: Record<string, Record<string, unknown>> = {
      brew: { package: 'p' },
      scoop: { package: 'p' },
      winget: { package: 'p' },
      npm: { package: 'p' },
      pip: { package: 'p', user: true },
      cargo: { package: 'p' },
      go_install: { package: 'p', binary_name: 'p' },
      docker_pull: { image: 'i' },
      download: {
        url: 'https://example.com/x',
        sha256: 'a'.repeat(64),
        target: 'tools/x',
      },
    };
    const fetch = vi.fn(async () => new Response('')) as unknown as typeof globalThis.fetch;

    for (const kind of SERVICE_INSTALL_KINDS) {
      const spawn = vi.fn<SpawnFn>(async () => ({ exit_code: 0, log_lines: [] }));
      await expect(
        runInstaller(kind, 'install', Object.create(inheritedOnly[kind]), ctx({ spawn, fetch })),
      ).rejects.toThrow(InstallerParamError);
      expect(spawn, `kind=${kind}`).not.toHaveBeenCalled();
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('ignores inherited optional docker target on upgrade', async () => {
    const spawn = vi.fn<SpawnFn>(async () => ({ exit_code: 0, log_lines: [] }));
    const params = Object.assign(
      Object.create({ target: '0.1.33' }),
      { image: 'ollama/ollama:0.1.32' },
    ) as Record<string, unknown>;

    await runInstaller('docker_pull', 'upgrade', params, ctx({ spawn }));

    expect(spawn.mock.calls[0][0]).toEqual([
      'docker', 'pull', 'ollama/ollama:0.1.32',
    ]);
  });
});

describe('runInstaller — action routing', () => {
  it('install vs upgrade vs uninstall hit different argv', async () => {
    const spawn = vi.fn<SpawnFn>(async () => ({ exit_code: 0, log_lines: [] }));
    await runInstaller('brew', 'install', { package: 'ff' }, ctx({ spawn }));
    await runInstaller('brew', 'upgrade', { package: 'ff' }, ctx({ spawn }));
    await runInstaller('brew', 'uninstall', { package: 'ff' }, ctx({ spawn }));
    expect(spawn.mock.calls.map((c) => c[0])).toEqual([
      ['brew', 'install', 'ff'],
      ['brew', 'upgrade', 'ff'],
      ['brew', 'uninstall', 'ff'],
    ]);
  });
});
