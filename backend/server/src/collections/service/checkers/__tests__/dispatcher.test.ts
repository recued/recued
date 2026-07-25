/** D-118 Phase 4 — checker dispatcher tests. */

import { describe, expect, it, vi } from 'vitest';

import { SERVICE_CHECK_KINDS } from '@recued/contracts';

import {
  CheckerParamError,
  runCheck,
  type CheckerContext,
} from '../dispatcher.js';
import type {
  CheckerSpawnFn,
  CheckerTcpConnectFn,
} from '../types.js';

const stubCtx = (extra?: Partial<CheckerContext>): CheckerContext => ({
  whichBinary: async () => true,
  stat: async () => true,
  readText: async () => '1234',
  kill0: () => true,
  tcpConnect: async () => true,
  spawnWithTimeout: async () => ({ exit_code: 0 }),
  fetch: async () => new Response('', { status: 200 }),
  ...extra,
});

describe('runCheck — kind routing', () => {
  it('rejects unknown kinds with CheckerParamError', async () => {
    await expect(
      runCheck({ kind: 'ssh_ping', host: 'h' }, stubCtx()),
    ).rejects.toThrow(CheckerParamError);
  });

  it('rejects non-object specs', async () => {
    await expect(runCheck('nope', stubCtx())).rejects.toThrow(
      /check spec must be an object/,
    );
  });

  it('rejects the `install_check` alias (caller must resolve upstream)', async () => {
    // Per spec line 493 — the health_check { kind: "install_check" }
    // alias is resolved by the supervisor, not the dispatcher.
    await expect(runCheck({ kind: 'install_check' }, stubCtx())).rejects.toThrow(
      /unknown check kind/,
    );
  });

  it('routes to binary_in_path', async () => {
    const whichBinary = vi.fn<(n: string) => Promise<boolean>>(async () => true);
    const result = await runCheck(
      { kind: 'binary_in_path', binary: 'ffmpeg' },
      stubCtx({ whichBinary }),
    );
    expect(whichBinary).toHaveBeenCalledWith('ffmpeg');
    expect(result.passed).toBe(true);
  });

  it('routes to file_exists', async () => {
    const stat = vi.fn<(p: string) => Promise<boolean>>(async () => false);
    const result = await runCheck(
      { kind: 'file_exists', path: '/tmp/foo' },
      stubCtx({ stat }),
    );
    expect(stat).toHaveBeenCalledWith('/tmp/foo');
    expect(result.passed).toBe(false);
  });

  it('routes to http_ok', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response('', { status: 200 }));
    const result = await runCheck(
      { kind: 'http_ok', url: 'https://a.example/api/tags' },
      stubCtx({ fetch }),
    );
    expect(fetch).toHaveBeenCalledOnce();
    expect(result.passed).toBe(true);
  });

  it('routes to tcp_open', async () => {
    const tcpConnect = vi.fn<CheckerTcpConnectFn>(async () => true);
    await runCheck(
      { kind: 'tcp_open', host: '127.0.0.1', port: 11434 },
      stubCtx({ tcpConnect }),
    );
    expect(tcpConnect).toHaveBeenCalledWith('127.0.0.1', 11434, 2000);
  });

  it('routes to pid_file', async () => {
    const readText = vi.fn<(p: string) => Promise<string>>(async () => '4242');
    const kill0 = vi.fn<(pid: number) => boolean>(() => true);
    const result = await runCheck(
      { kind: 'pid_file', path: '/run/ollama.pid' },
      stubCtx({ readText, kill0 }),
    );
    expect(kill0).toHaveBeenCalledWith(4242);
    expect(result.passed).toBe(true);
  });

  it('routes to exec_ok', async () => {
    const spawnWithTimeout = vi.fn<CheckerSpawnFn>(async () => ({ exit_code: 0 }));
    await runCheck(
      { kind: 'exec_ok', argv: ['ffmpeg', '-version'] },
      stubCtx({ spawnWithTimeout }),
    );
    expect(spawnWithTimeout.mock.calls[0][0]).toEqual(['ffmpeg', '-version']);
  });

  it('every contract kind is wired in the dispatcher', async () => {
    const stubs: Record<string, unknown> = {
      binary_in_path: { kind: 'binary_in_path', binary: 'x' },
      file_exists: { kind: 'file_exists', path: '/tmp/x' },
      http_ok: { kind: 'http_ok', url: 'https://x.example' },
      tcp_open: { kind: 'tcp_open', host: 'h', port: 1234 },
      pid_file: { kind: 'pid_file', path: '/run/x.pid' },
      exec_ok: { kind: 'exec_ok', argv: ['x'] },
    };
    for (const kind of SERVICE_CHECK_KINDS) {
      const result = await runCheck(stubs[kind], stubCtx());
      expect(result.passed, `kind=${kind}`).toBe(true);
    }
  });
});

describe('runCheck — param validation', () => {
  it('binary_in_path: missing binary throws before IO', async () => {
    const whichBinary = vi.fn<(n: string) => Promise<boolean>>(async () => true);
    await expect(
      runCheck({ kind: 'binary_in_path' }, stubCtx({ whichBinary })),
    ).rejects.toThrow(/binary required/);
    expect(whichBinary).not.toHaveBeenCalled();
  });

  it('file_exists: missing path throws', async () => {
    await expect(runCheck({ kind: 'file_exists' }, stubCtx())).rejects.toThrow(
      /path required/,
    );
  });

  it('http_ok: missing url throws', async () => {
    await expect(runCheck({ kind: 'http_ok' }, stubCtx())).rejects.toThrow(
      /url required/,
    );
  });

  it('http_ok: non-http(s) url rejected', async () => {
    await expect(
      runCheck({ kind: 'http_ok', url: 'file:///etc/passwd' }, stubCtx()),
    ).rejects.toThrow(/http:\/\/ or https:\/\//);
  });

  it('http_ok: invalid status_ok rejected', async () => {
    await expect(
      runCheck(
        { kind: 'http_ok', url: 'https://a.example', status_ok: [] },
        stubCtx(),
      ),
    ).rejects.toThrow(/non-empty array/);
  });

  it('tcp_open: port out of range rejected', async () => {
    await expect(
      runCheck({ kind: 'tcp_open', host: 'h', port: 0 }, stubCtx()),
    ).rejects.toThrow(/1..65535/);
    await expect(
      runCheck({ kind: 'tcp_open', host: 'h', port: 70_000 }, stubCtx()),
    ).rejects.toThrow(/1..65535/);
  });

  it('exec_ok: empty argv rejected', async () => {
    await expect(
      runCheck({ kind: 'exec_ok', argv: [] }, stubCtx()),
    ).rejects.toThrow(/non-empty array/);
  });

  it('exec_ok: non-string argv element rejected', async () => {
    await expect(
      runCheck({ kind: 'exec_ok', argv: ['ff', 42] }, stubCtx()),
    ).rejects.toThrow(/non-empty array/);
  });
});

describe('runCheck — {{config.*}} interpolation', () => {
  it('pure ref preserves numeric type (port stays number)', async () => {
    const tcpConnect = vi.fn<CheckerTcpConnectFn>(async () => true);
    await runCheck(
      { kind: 'tcp_open', host: '127.0.0.1', port: '{{config.port}}' },
      stubCtx({ tcpConnect }),
      { port: 11434 },
    );
    expect(tcpConnect).toHaveBeenCalledWith('127.0.0.1', 11434, 2000);
  });

  it('interpolates into a URL string', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response('', { status: 200 }));
    await runCheck(
      {
        kind: 'http_ok',
        url: 'http://127.0.0.1:{{config.port}}/api/tags',
      },
      stubCtx({ fetch }),
      { port: 11434 },
    );
    expect(fetch.mock.calls[0][0]).toBe('http://127.0.0.1:11434/api/tags');
  });

  it('resolves refs inside argv arrays', async () => {
    const spawnWithTimeout = vi.fn<CheckerSpawnFn>(async () => ({ exit_code: 0 }));
    await runCheck(
      { kind: 'exec_ok', argv: ['{{config.cmd}}', '--version'] },
      stubCtx({ spawnWithTimeout }),
      { cmd: 'ollama' },
    );
    expect(spawnWithTimeout.mock.calls[0][0]).toEqual(['ollama', '--version']);
  });

  it('resolves nested config paths (config.models.default)', async () => {
    const whichBinary = vi.fn<(n: string) => Promise<boolean>>(async () => true);
    await runCheck(
      { kind: 'binary_in_path', binary: '{{config.models.default}}' },
      stubCtx({ whichBinary }),
      { models: { default: 'llama3' } },
    );
    expect(whichBinary).toHaveBeenCalledWith('llama3');
  });

  it('leaves unresolved refs as literal text (downstream validator surfaces)', async () => {
    // When `port` is missing from config, the {{config.port}} ref is
    // left intact — validation then fails because port must be a number.
    await expect(
      runCheck(
        { kind: 'tcp_open', host: 'h', port: '{{config.port}}' },
        stubCtx(),
        {},
      ),
    ).rejects.toThrow(/port required/);
  });

  it('does not resolve prototype-chain config paths', async () => {
    const whichBinary = vi.fn<(n: string) => Promise<boolean>>(async () => false);
    await runCheck(
      { kind: 'binary_in_path', binary: '{{config.constructor.name}}' },
      stubCtx({ whichBinary }),
      {},
    );
    expect(whichBinary).toHaveBeenCalledWith('{{config.constructor.name}}');
  });

  it('leaves non-config refs untouched (no cross-namespace resolution)', async () => {
    // Checkers only consume `{{config.*}}`. A `{{step.foo}}` ref stays
    // as literal text; the per-kind validator then catches the shape
    // error (binary must be a string — the raw ref IS a string, so
    // whichBinary just gets the literal "{{step.foo}}").
    const whichBinary = vi.fn<(n: string) => Promise<boolean>>(async () => false);
    await runCheck(
      { kind: 'binary_in_path', binary: '{{step.foo}}' },
      stubCtx({ whichBinary }),
      { port: 11434 },
    );
    expect(whichBinary).toHaveBeenCalledWith('{{step.foo}}');
  });
});
