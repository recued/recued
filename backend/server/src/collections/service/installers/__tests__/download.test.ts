/** D-118 Phase 3 — `download` installer tests.
 *
 *  Covers the only kind that does real I/O. Real fs in a tmpdir +
 *  mock fetch. Sha256 verification, atomic replace, .bak rollback,
 *  path-traversal guard, https-only enforcement.
 */

import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SERVICE_CWD_SUBDIR } from '@recued/contracts';

import {
  DOWNLOAD_INSTALLER_MAX_BYTES,
  DOWNLOAD_INSTALLER_TIMEOUT_MS,
  downloadInstaller,
  resolveDownloadTarget,
  validateDownloadParams,
} from '../download.js';
import {
  DownloadShaMismatchError,
  InstallerParamError,
  type FetchFn,
  type InstallerContext,
} from '../types.js';

let dataPath: string;

const sha256Hex = (buf: Buffer): string =>
  createHash('sha256').update(buf).digest('hex');

const okFetch = (body: Buffer): FetchFn =>
  ((async () =>
    new Response(new Uint8Array(body), { status: 200 })) as unknown as FetchFn);

const failFetch = (status: number): FetchFn =>
  ((async () =>
    new Response('', { status, statusText: 'broken' })) as unknown as FetchFn);

const makeCtx = (fetch: FetchFn, slug = 'demo'): InstallerContext => ({
  dataPath,
  slug,
  fetch,
});

const exists = async (path: string): Promise<boolean> => {
  try {
    await fsp.stat(path);
    return true;
  } catch {
    return false;
  }
};

beforeEach(async () => {
  dataPath = await mkdtemp(join(tmpdir(), 'recued-d118-dl-'));
});

afterEach(async () => {
  await fsp.rm(dataPath, { recursive: true, force: true });
});

// ────────────────────────────────────────────────────────────────
// Param validation
// ────────────────────────────────────────────────────────────────

describe('validateDownloadParams', () => {
  it('accepts a complete + well-formed params object', () => {
    const valid = validateDownloadParams({
      url: 'https://example.com/bin',
      sha256: 'a'.repeat(64),
      target: 'bin/tool',
    });
    expect(valid.target).toBe('bin/tool');
  });

  it('rejects http:// (https-only)', () => {
    expect(() =>
      validateDownloadParams({
        url: 'http://example.com/bin',
        sha256: 'a'.repeat(64),
        target: 'bin',
      }),
    ).toThrow(InstallerParamError);
  });

  it('rejects malformed URLs and embedded credentials', () => {
    expect(() => validateDownloadParams({
      url: 'https://',
      sha256: 'a'.repeat(64),
      target: 'bin',
    })).toThrow(/valid absolute URL/);
    expect(() => validateDownloadParams({
      url: 'https://user:secret@example.com/bin',
      sha256: 'a'.repeat(64),
      target: 'bin',
    })).toThrow(/embedded credentials/);
  });

  it('rejects malformed sha (non-hex)', () => {
    expect(() =>
      validateDownloadParams({
        url: 'https://example.com',
        sha256: 'NOT-HEX-AT-ALL'.repeat(5),
        target: 'bin',
      }),
    ).toThrow(/sha256/);
  });

  it('rejects sha of wrong length', () => {
    expect(() =>
      validateDownloadParams({
        url: 'https://example.com',
        sha256: 'a'.repeat(63),
        target: 'bin',
      }),
    ).toThrow(/sha256/);
  });

  it('rejects missing target', () => {
    expect(() =>
      validateDownloadParams({
        url: 'https://example.com',
        sha256: 'a'.repeat(64),
      }),
    ).toThrow(/target/);
  });
});

// ────────────────────────────────────────────────────────────────
// resolveDownloadTarget — path-traversal guard
// ────────────────────────────────────────────────────────────────

describe('resolveDownloadTarget', () => {
  it('joins relative target under <data_path>/services/<slug>/', () => {
    const path = resolveDownloadTarget(
      { dataPath, slug: 'ffmpeg' },
      'bin/ffmpeg',
    );
    expect(path).toBe(join(dataPath, SERVICE_CWD_SUBDIR, 'ffmpeg', 'bin', 'ffmpeg'));
  });

  it('re-anchors absolute target paths under the cwd', () => {
    // Even a malicious manifest writing target: "/etc/passwd" lands
    // under <data>/services/<slug>/etc/passwd.
    const path = resolveDownloadTarget(
      { dataPath, slug: 'ff' },
      '/etc/passwd',
    );
    expect(path).toBe(join(dataPath, SERVICE_CWD_SUBDIR, 'ff', 'etc', 'passwd'));
  });

  it('rejects path-traversal segments that escape the cwd', () => {
    expect(() =>
      resolveDownloadTarget({ dataPath, slug: 'ff' }, '../escaped'),
    ).toThrow(/escapes/);
  });
});

// ────────────────────────────────────────────────────────────────
// install — happy path
// ────────────────────────────────────────────────────────────────

describe('downloadInstaller.install — happy path', () => {
  it('streams the payload without calling arrayBuffer()', async () => {
    const body = Buffer.from('stream me');
    const response = new Response(new Uint8Array(body), { status: 200 });
    const arrayBuffer = vi.spyOn(response, 'arrayBuffer').mockRejectedValue(
      new Error('must not buffer the complete installer payload'),
    );
    const fetch = (async () => response) as unknown as FetchFn;

    const out = await downloadInstaller.install(
      {
        url: 'https://example.com/streamed',
        sha256: sha256Hex(body),
        target: 'tools/streamed',
      },
      makeCtx(fetch),
    );

    expect(out.exit_code).toBe(0);
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it('writes verified payload at the resolved target path', async () => {
    const body = Buffer.from('hello world');
    const sha = sha256Hex(body);
    const out = await downloadInstaller.install(
      {
        url: 'https://example.com/bin',
        sha256: sha,
        target: 'tools/payload',
      },
      makeCtx(okFetch(body)),
    );
    expect(out.exit_code).toBe(0);
    const target = join(dataPath, SERVICE_CWD_SUBDIR, 'demo', 'tools', 'payload');
    const written = await readFile(target);
    expect(written.equals(body)).toBe(true);
  });

  it('cleans up the .download.tmp file after success', async () => {
    const body = Buffer.from('hello');
    const sha = sha256Hex(body);
    await downloadInstaller.install(
      { url: 'https://example.com/x', sha256: sha, target: 'tools/x' },
      makeCtx(okFetch(body)),
    );
    const target = join(dataPath, SERVICE_CWD_SUBDIR, 'demo', 'tools', 'x');
    expect(await exists(`${target}.download.tmp`)).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────
// install — sha mismatch
// ────────────────────────────────────────────────────────────────

describe('downloadInstaller.install — sha mismatch', () => {
  it('returns exit -2 + descriptive log line, no file written', async () => {
    const body = Buffer.from('actual contents');
    const wrongSha = 'b'.repeat(64);
    const out = await downloadInstaller.install(
      {
        url: 'https://example.com/bin',
        sha256: wrongSha,
        target: 'tools/payload',
      },
      makeCtx(okFetch(body)),
    );
    expect(out.exit_code).toBe(-2);
    expect(out.log_lines.join('\n')).toContain('sha256 mismatch');
    const target = join(dataPath, SERVICE_CWD_SUBDIR, 'demo', 'tools', 'payload');
    expect(await exists(target)).toBe(false);
    expect(await exists(`${target}.download.tmp`)).toBe(false);
  });

  it('DownloadShaMismatchError preserves expected + actual on the throw path', () => {
    // Type-level guard — readers depend on these fields when
    // surfacing the mismatch detail in the dashboard.
    const err = new DownloadShaMismatchError('https://x', 'abc', 'def');
    expect(err.url).toBe('https://x');
    expect(err.expected).toBe('abc');
    expect(err.actual).toBe('def');
  });
});

// ────────────────────────────────────────────────────────────────
// install — network error
// ────────────────────────────────────────────────────────────────

describe('downloadInstaller.install — network failure', () => {
  it('allows bounded cross-origin HTTPS redirects used by release CDNs', async () => {
    const body = Buffer.from('cdn payload');
    const calls: Array<{ url: string; redirect: RequestRedirect | undefined }> = [];
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, redirect: init?.redirect });
      if (calls.length === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://cdn.example.net/release.bin' },
        });
      }
      return new Response(new Uint8Array(body), { status: 200 });
    }) as unknown as FetchFn;

    const out = await downloadInstaller.install(
      {
        url: 'https://releases.example.com/latest',
        sha256: sha256Hex(body),
        target: 'tools/cdn',
      },
      makeCtx(fetch),
    );

    expect(out.exit_code).toBe(0);
    expect(calls).toEqual([
      { url: 'https://releases.example.com/latest', redirect: 'manual' },
      { url: 'https://cdn.example.net/release.bin', redirect: 'manual' },
    ]);
  });

  it.each([
    ['non-HTTPS', 'http://cdn.example.net/release.bin'],
    ['private/local', 'https://127.0.0.1/internal'],
  ])('refuses a %s redirect before requesting its target', async (_label, location) => {
    const fetch = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location },
    })) as unknown as FetchFn;

    const out = await downloadInstaller.install(
      {
        url: 'https://releases.example.com/latest',
        sha256: 'a'.repeat(64),
        target: 'tools/refused',
      },
      makeCtx(fetch),
    );

    expect(out.exit_code).toBe(-1);
    expect(out.log_lines.join(' ')).toContain(`refused a ${_label} target`);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects an oversized declared payload before reading its body', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const fetch = (async () => new Response(body, {
      status: 200,
      headers: {
        'content-length': String(DOWNLOAD_INSTALLER_MAX_BYTES + 1),
      },
    })) as unknown as FetchFn;

    const out = await downloadInstaller.install(
      {
        url: 'https://example.com/huge',
        sha256: 'a'.repeat(64),
        target: 'tools/huge',
      },
      makeCtx(fetch),
    );

    expect(out.exit_code).toBe(-1);
    expect(out.log_lines.join(' ')).toContain(
      `limit ${DOWNLOAD_INSTALLER_MAX_BYTES}`,
    );
    expect(cancelled).toBe(true);
  });

  it('aborts a response body that stalls past the installer deadline', async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
        signal = init?.signal ?? undefined;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            const abort = (): void => {
              const error = new Error('aborted');
              error.name = 'AbortError';
              controller.error(error);
            };
            if (signal?.aborted) abort();
            else signal?.addEventListener('abort', abort, { once: true });
          },
        });
        return new Response(body, { status: 200 });
      }) as unknown as FetchFn;
      const pending = downloadInstaller.install(
        {
          url: 'https://example.com/stalled',
          sha256: 'a'.repeat(64),
          target: 'tools/stalled',
        },
        makeCtx(fetch),
      );

      await vi.advanceTimersByTimeAsync(DOWNLOAD_INSTALLER_TIMEOUT_MS);
      const out = await pending;
      expect(signal?.aborted).toBe(true);
      expect(out.exit_code).toBe(-1);
      expect(out.log_lines.join(' ')).toContain('download timed out');
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns exit -1 with the response status in log_lines', async () => {
    const out = await downloadInstaller.install(
      {
        url: 'https://example.com/bin',
        sha256: 'a'.repeat(64),
        target: 'tools/p',
      },
      makeCtx(failFetch(503)),
    );
    expect(out.exit_code).toBe(-1);
    expect(out.log_lines.join(' ')).toContain('503');
  });
});

// ────────────────────────────────────────────────────────────────
// upgrade — atomic replace + .bak rollback target
// ────────────────────────────────────────────────────────────────

describe('downloadInstaller.upgrade — .bak rollback path', () => {
  it('moves the prior payload aside as .bak before writing the new one', async () => {
    const cwd = join(dataPath, SERVICE_CWD_SUBDIR, 'demo', 'tools');
    await fsp.mkdir(cwd, { recursive: true });
    await writeFile(join(cwd, 'payload'), 'OLD');

    const next = Buffer.from('NEW');
    await downloadInstaller.upgrade(
      {
        url: 'https://example.com/bin',
        sha256: sha256Hex(next),
        target: 'tools/payload',
      },
      makeCtx(okFetch(next)),
    );

    const live = await readFile(join(cwd, 'payload'), 'utf8');
    const bak = await readFile(join(cwd, 'payload.bak'), 'utf8');
    expect(live).toBe('NEW');
    expect(bak).toBe('OLD');
  });

  it('overwrites a stale .bak from a prior upgrade', async () => {
    const cwd = join(dataPath, SERVICE_CWD_SUBDIR, 'demo', 'tools');
    await fsp.mkdir(cwd, { recursive: true });
    await writeFile(join(cwd, 'payload'), 'CURRENT');
    await writeFile(join(cwd, 'payload.bak'), 'STALE-FROM-EARLIER-UPGRADE');

    const next = Buffer.from('NEXT');
    await downloadInstaller.upgrade(
      {
        url: 'https://example.com/bin',
        sha256: sha256Hex(next),
        target: 'tools/payload',
      },
      makeCtx(okFetch(next)),
    );

    expect(await readFile(join(cwd, 'payload'), 'utf8')).toBe('NEXT');
    expect(await readFile(join(cwd, 'payload.bak'), 'utf8')).toBe('CURRENT');
  });

  it('sha mismatch on upgrade leaves the prior payload untouched', async () => {
    const cwd = join(dataPath, SERVICE_CWD_SUBDIR, 'demo', 'tools');
    await fsp.mkdir(cwd, { recursive: true });
    await writeFile(join(cwd, 'payload'), 'PRESERVED');

    const wrongSha = 'b'.repeat(64);
    const out = await downloadInstaller.upgrade(
      {
        url: 'https://example.com/bin',
        sha256: wrongSha,
        target: 'tools/payload',
      },
      makeCtx(okFetch(Buffer.from('whatever'))),
    );
    expect(out.exit_code).toBe(-2);
    expect(await readFile(join(cwd, 'payload'), 'utf8')).toBe('PRESERVED');
    expect(await exists(join(cwd, 'payload.bak'))).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────
// uninstall
// ────────────────────────────────────────────────────────────────

describe('downloadInstaller.uninstall', () => {
  it('removes target + .bak + leftover .download.tmp', async () => {
    const cwd = join(dataPath, SERVICE_CWD_SUBDIR, 'demo', 'tools');
    await fsp.mkdir(cwd, { recursive: true });
    await writeFile(join(cwd, 'payload'), 'X');
    await writeFile(join(cwd, 'payload.bak'), 'X');
    await writeFile(join(cwd, 'payload.download.tmp'), 'X');
    await writeFile(join(cwd, 'payload.download.crash-leftover.tmp'), 'X');

    const out = await downloadInstaller.uninstall(
      {
        url: 'https://example.com/x',
        sha256: 'a'.repeat(64),
        target: 'tools/payload',
      },
      makeCtx(okFetch(Buffer.from(''))),
    );
    expect(out.exit_code).toBe(0);
    expect(await exists(join(cwd, 'payload'))).toBe(false);
    expect(await exists(join(cwd, 'payload.bak'))).toBe(false);
    expect(await exists(join(cwd, 'payload.download.tmp'))).toBe(false);
    expect(await exists(join(cwd, 'payload.download.crash-leftover.tmp'))).toBe(false);
  });

  it('idempotent — succeeds even when target was never installed', async () => {
    const out = await downloadInstaller.uninstall(
      {
        url: 'https://example.com/x',
        sha256: 'a'.repeat(64),
        target: 'tools/never-installed',
      },
      makeCtx(okFetch(Buffer.from(''))),
    );
    expect(out.exit_code).toBe(0);
  });
});
