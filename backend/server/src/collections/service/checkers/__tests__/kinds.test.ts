/** D-118 Phase 4 — per-kind checker tests.
 *
 *  Each kind gets a happy path + one failure mode focused on the
 *  semantics unique to that kind (timeout behaviour, default
 *  values, IO error classification). Routing + param validation
 *  are covered in `dispatcher.test.ts`.
 */

import { describe, expect, it, vi } from 'vitest';

import { runCheck, type CheckerContext } from '../dispatcher.js';
import type { CheckerSpawnFn } from '../types.js';

const baseCtx = (extra: Partial<CheckerContext> = {}): CheckerContext => ({
  whichBinary: async () => false,
  stat: async () => false,
  readText: async () => '',
  kill0: () => false,
  tcpConnect: async () => false,
  spawnWithTimeout: async () => ({ exit_code: 1 }),
  fetch: async () => new Response('', { status: 500 }),
  ...extra,
});

describe('binary_in_path', () => {
  it('passes when PATH scan finds the binary', async () => {
    const r = await runCheck(
      { kind: 'binary_in_path', binary: 'ffmpeg' },
      baseCtx({ whichBinary: async () => true }),
    );
    expect(r.passed).toBe(true);
    expect(r.detail).toMatch(/found on PATH/);
  });

  it('fails when PATH scan misses the binary', async () => {
    const r = await runCheck(
      { kind: 'binary_in_path', binary: 'nope' },
      baseCtx({ whichBinary: async () => false }),
    );
    expect(r.passed).toBe(false);
    expect(r.detail).toMatch(/not found on PATH/);
  });
});

describe('file_exists', () => {
  it('passes when stat succeeds', async () => {
    const r = await runCheck(
      { kind: 'file_exists', path: '/etc/hosts' },
      baseCtx({ stat: async () => true }),
    );
    expect(r.passed).toBe(true);
  });

  it('fails when stat rejects (caller catches, maps to false)', async () => {
    const r = await runCheck(
      { kind: 'file_exists', path: '/no/such/path' },
      baseCtx({ stat: async () => false }),
    );
    expect(r.passed).toBe(false);
    expect(r.detail).toMatch(/not found/);
  });
});

describe('http_ok', () => {
  it('cancels the unused health response body', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
      },
      cancel() {
        cancelled = true;
      },
    });
    const r = await runCheck(
      { kind: 'http_ok', url: 'https://a.example/health' },
      baseCtx({ fetch: async () => new Response(body, { status: 200 }) }),
    );

    expect(r.passed).toBe(true);
    await vi.waitFor(() => expect(cancelled).toBe(true));
  });

  it('passes on default status_ok = [200]', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response('ok', { status: 200 }));
    const r = await runCheck(
      { kind: 'http_ok', url: 'https://a.example/health' },
      baseCtx({ fetch }),
    );
    expect(r.passed).toBe(true);
  });

  it('fails when status is outside the allowlist', async () => {
    const r = await runCheck(
      { kind: 'http_ok', url: 'https://a.example/health' },
      baseCtx({ fetch: async () => new Response('', { status: 503 }) }),
    );
    expect(r.passed).toBe(false);
    expect(r.detail).toMatch(/503/);
  });

  it('passes when a custom status_ok covers the returned code', async () => {
    const r = await runCheck(
      {
        kind: 'http_ok',
        url: 'https://a.example/health',
        status_ok: [200, 204, 503],
      },
      baseCtx({ fetch: async () => new Response('', { status: 503 }) }),
    );
    expect(r.passed).toBe(true);
  });

  it('returns passed=false with a timeout detail on AbortError', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>((_url, init) => {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });
    const r = await runCheck(
      {
        kind: 'http_ok',
        url: 'https://a.example/health',
        timeout_ms: 5,
      },
      baseCtx({ fetch }),
    );
    expect(r.passed).toBe(false);
    expect(r.detail).toMatch(/timed out after 5ms/);
  });

  it('returns passed=false with a generic error detail on fetch throw', async () => {
    const r = await runCheck(
      { kind: 'http_ok', url: 'https://a.example/health' },
      baseCtx({
        fetch: async () => {
          throw new Error('ECONNREFUSED');
        },
      }),
    );
    expect(r.passed).toBe(false);
    expect(r.detail).toMatch(/ECONNREFUSED/);
  });
});

describe('tcp_open', () => {
  it('passes when tcpConnect resolves true within the 2s ceiling', async () => {
    const r = await runCheck(
      { kind: 'tcp_open', host: '127.0.0.1', port: 80 },
      baseCtx({ tcpConnect: async () => true }),
    );
    expect(r.passed).toBe(true);
  });

  it('fails when tcpConnect resolves false', async () => {
    const r = await runCheck(
      { kind: 'tcp_open', host: '127.0.0.1', port: 80 },
      baseCtx({ tcpConnect: async () => false }),
    );
    expect(r.passed).toBe(false);
    expect(r.detail).toMatch(/unreachable/);
  });

  it('passes 2000ms as the per-probe timeout regardless of caller input', async () => {
    const tcpConnect = vi.fn<(h: string, p: number, t: number) => Promise<boolean>>(
      async () => true,
    );
    await runCheck(
      { kind: 'tcp_open', host: 'h', port: 22 },
      baseCtx({ tcpConnect }),
    );
    expect(tcpConnect.mock.calls[0][2]).toBe(2000);
  });
});

describe('pid_file', () => {
  it('passes when file exists + contains a live pid', async () => {
    const r = await runCheck(
      { kind: 'pid_file', path: '/run/x.pid' },
      baseCtx({
        stat: async () => true,
        readText: async () => '1337\n',
        kill0: () => true,
      }),
    );
    expect(r.passed).toBe(true);
    expect(r.detail).toMatch(/1337/);
  });

  it('fails when file does not exist', async () => {
    const r = await runCheck(
      { kind: 'pid_file', path: '/run/missing.pid' },
      baseCtx({ stat: async () => false }),
    );
    expect(r.passed).toBe(false);
    expect(r.detail).toMatch(/not found/);
  });

  it('fails when file contents are not an integer pid', async () => {
    const r = await runCheck(
      { kind: 'pid_file', path: '/run/x.pid' },
      baseCtx({
        stat: async () => true,
        readText: async () => 'not-a-pid',
        kill0: () => true,
      }),
    );
    expect(r.passed).toBe(false);
    expect(r.detail).toMatch(/positive integer pid/);
  });

  it('fails when pid is dead (stale pidfile)', async () => {
    const r = await runCheck(
      { kind: 'pid_file', path: '/run/x.pid' },
      baseCtx({
        stat: async () => true,
        readText: async () => '9999',
        kill0: () => false,
      }),
    );
    expect(r.passed).toBe(false);
    expect(r.detail).toMatch(/stale pidfile/);
  });

  it('fails cleanly when read throws (IO error)', async () => {
    const r = await runCheck(
      { kind: 'pid_file', path: '/run/x.pid' },
      baseCtx({
        stat: async () => true,
        readText: async () => {
          throw new Error('EACCES');
        },
      }),
    );
    expect(r.passed).toBe(false);
    expect(r.detail).toMatch(/unreadable.*EACCES/);
  });
});

describe('exec_ok', () => {
  it('passes on exit 0 by default', async () => {
    const r = await runCheck(
      { kind: 'exec_ok', argv: ['ffmpeg', '-version'] },
      baseCtx({ spawnWithTimeout: async () => ({ exit_code: 0 }) }),
    );
    expect(r.passed).toBe(true);
  });

  it('passes when exit code is in a custom exit_codes_ok list', async () => {
    const r = await runCheck(
      {
        kind: 'exec_ok',
        argv: ['grep', 'pattern', 'file'],
        exit_codes_ok: [0, 1],
      },
      baseCtx({ spawnWithTimeout: async () => ({ exit_code: 1 }) }),
    );
    expect(r.passed).toBe(true);
  });

  it('fails and reports timeout when spawn returns exit -9', async () => {
    const r = await runCheck(
      { kind: 'exec_ok', argv: ['sleep', '60'], timeout_ms: 100 },
      baseCtx({ spawnWithTimeout: async () => ({ exit_code: -9 }) }),
    );
    expect(r.passed).toBe(false);
    expect(r.detail).toMatch(/timed out after 100ms/);
  });

  it('fails and reports spawn failure when exit is -1', async () => {
    const r = await runCheck(
      { kind: 'exec_ok', argv: ['no-such-binary'] },
      baseCtx({ spawnWithTimeout: async () => ({ exit_code: -1 }) }),
    );
    expect(r.passed).toBe(false);
    expect(r.detail).toMatch(/failed to spawn/);
  });

  it('fails with non-zero exit not in allowlist', async () => {
    const r = await runCheck(
      { kind: 'exec_ok', argv: ['ffprobe', 'missing.mp4'] },
      baseCtx({ spawnWithTimeout: async () => ({ exit_code: 2 }) }),
    );
    expect(r.passed).toBe(false);
    expect(r.detail).toMatch(/exit 2/);
  });

  it('passes timeout_ms through to the spawn seam (default 5000)', async () => {
    const spawnWithTimeout = vi.fn<CheckerSpawnFn>(async () => ({ exit_code: 0 }));
    await runCheck(
      { kind: 'exec_ok', argv: ['x'] },
      baseCtx({ spawnWithTimeout }),
    );
    expect(spawnWithTimeout.mock.calls[0][1]).toBe(5000);
  });
});
