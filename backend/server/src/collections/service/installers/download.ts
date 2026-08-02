/** D-118 Phase 3 — `download` installer kind.
 *
 *  Direct HTTPS download with sha256 verification + atomic
 *  replace + `.bak` rollback on upgrade. The only kind that
 *  doesn't go through `runProcess` — fetch, hash, write, rename
 *  are all pure Node I/O.
 *
 *  Flow:
 *    1. Resolve target path against `<dataPath>/services/<slug>/`.
 *       Manifest paths are joined under this prefix; an absolute
 *       path in the manifest is re-anchored (path-traversal guard).
 *    2. Stream download → a unique `<target>.download.<id>.tmp`, hashing on
 *       the fly. Reject the bytes when the verified hash doesn't
 *       match the declared one (`DownloadShaMismatchError`).
 *    3. If `<target>` already exists, move it to `<target>.bak`
 *       so an upgrade has a rollback target.
 *    4. Atomic `rename(<target>.download.tmp → <target>)`.
 *    5. On any failure post-step-3: restore `<target>.bak →
 *       <target>` and clean up the tmp.
 *
 *  Network calls reuse the host's TLS chain (no `--insecure`
 *  flags, no custom cert overrides). HTTP-only URLs are rejected
 *  at validate time.
 */

import { createHash, randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize, relative } from 'node:path';

import { SERVICE_CWD_SUBDIR, isPrivateHost } from '@recued/contracts';
import { discardResponseBody } from '@recued/ingredients';

import {
  DownloadShaMismatchError,
  InstallerParamError,
  type InstallerContext,
  type InstallerKindModule,
  type InstallerOutcome,
} from './types.js';
import { ownSafe } from '../key-safety.js';

export interface DownloadParams {
  /** HTTPS URL. HTTP rejected — every download must be authenticated
   *  by TLS as well as by sha256. */
  url: string;
  /** Hex-encoded sha256 of the expected payload. Lowercase. */
  sha256: string;
  /** Destination path. Re-anchored under `<dataPath>/services/
   *  <slug>/` even when the manifest writes an absolute path. */
  target: string;
}

/** Installer payloads are executables/archives, not an unbounded artifact
 * channel. This ceiling also bounds disk consumed before sha verification. */
export const DOWNLOAD_INSTALLER_MAX_BYTES = 512 * 1024 * 1024;

/** One deadline spans connect, headers, and streamed body consumption. */
export const DOWNLOAD_INSTALLER_TIMEOUT_MS = 10 * 60 * 1000;

export const validateDownloadParams = (raw: unknown): DownloadParams => {
  if (raw === null || typeof raw !== 'object') {
    throw new InstallerParamError('download', 'params must be an object');
  }
  const params = raw as Record<string, unknown>;
  const url = ownSafe(params, 'url');
  const sha256 = ownSafe(params, 'sha256');
  const target = ownSafe(params, 'target');
  if (typeof url !== 'string' || url === '') {
    throw new InstallerParamError('download', 'url required (string)');
  }
  let parsedUrl: URL;
  try {
    if (url !== url.trim()) throw new Error('surrounding whitespace');
    parsedUrl = new URL(url);
  } catch {
    throw new InstallerParamError('download', 'url must be a valid absolute URL');
  }
  if (parsedUrl.protocol !== 'https:') {
    throw new InstallerParamError(
      'download',
      'url must be https:// — http downloads are not allowed',
    );
  }
  if (parsedUrl.username !== '' || parsedUrl.password !== '') {
    throw new InstallerParamError(
      'download',
      'url must not contain embedded credentials',
    );
  }
  if (
    typeof sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(sha256)
  ) {
    throw new InstallerParamError(
      'download',
      'sha256 required — 64-char hex (lowercase)',
    );
  }
  if (typeof target !== 'string' || target === '') {
    throw new InstallerParamError('download', 'target required (string)');
  }
  return {
    url: parsedUrl.toString(),
    sha256,
    target,
  };
};

/** Resolve the manifest's `target` against the per-instance cwd.
 *  Absolute manifest paths are re-anchored — even a malicious
 *  `target: "/etc/passwd"` lands at
 *  `<dataPath>/services/<slug>/etc/passwd`. Path-traversal
 *  segments (`..`) are rejected outright. */
export const resolveDownloadTarget = (
  ctx: { dataPath: string; slug: string },
  manifestTarget: string,
): string => {
  // Strip leading slashes from absolute paths so `join` re-anchors
  // them under our subtree instead of escaping it.
  const stripped = manifestTarget.replace(/^[/\\]+/, '');
  const cwd = join(ctx.dataPath, SERVICE_CWD_SUBDIR, ctx.slug);
  const candidate = normalize(join(cwd, stripped));
  const rel = relative(cwd, candidate);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new InstallerParamError(
      'download',
      `target ${manifestTarget} escapes service cwd`,
    );
  }
  return candidate;
};

interface DownloadIO {
  fetch: typeof fetch;
}

const DOWNLOAD_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const DOWNLOAD_REDIRECT_LIMIT = 5;

/** Follow ordinary HTTPS CDN redirects without allowing a public download URL
 * to bounce the server onto a local/private target. No credentials are sent,
 * but an unrestricted redirect would still be an SSRF request primitive. */
const fetchDownloadResponse = async (
  fetchImpl: typeof fetch,
  url: string,
  signal: AbortSignal,
): Promise<Response> => {
  let current = new URL(url);
  const initialIsPrivate = isPrivateHost(current.hostname);
  for (let hop = 0; hop < DOWNLOAD_REDIRECT_LIMIT; hop += 1) {
    const response = await fetchImpl(current, { signal, redirect: 'manual' });
    if (!DOWNLOAD_REDIRECT_STATUSES.has(response.status)) return response;
    const location = response.headers.get('location');
    if (location === null || location === '') return response;

    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      discardResponseBody(response);
      throw new Error('download redirect contained an invalid Location');
    }
    if (next.protocol !== 'https:') {
      discardResponseBody(response);
      throw new Error('download redirect refused a non-HTTPS target');
    }
    if (next.username !== '' || next.password !== '') {
      discardResponseBody(response);
      throw new Error('download redirect refused embedded credentials');
    }
    if (!initialIsPrivate && isPrivateHost(next.hostname)) {
      discardResponseBody(response);
      throw new Error('download redirect refused a private/local target');
    }
    discardResponseBody(response);
    current = next;
  }
  throw new Error(`download exceeded ${DOWNLOAD_REDIRECT_LIMIT} redirects`);
};

const declaredLength = (response: Response): number | undefined => {
  const raw = response.headers.get('content-length');
  if (raw === null || !/^\d+$/.test(raw.trim())) return undefined;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
};

const writeChunk = async (
  file: Awaited<ReturnType<typeof fsp.open>>,
  chunk: Uint8Array,
  position: number,
): Promise<number> => {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await file.write(
      chunk,
      offset,
      chunk.byteLength - offset,
      position + offset,
    );
    if (bytesWritten < 1) throw new Error('download staging write made no progress');
    offset += bytesWritten;
  }
  return position + offset;
};

/** Fetch directly into a unique same-directory staging file while hashing.
 * Memory stays at one response chunk; the file is never promoted until its
 * bytes are complete, bounded, fsynced, and sha-verified. */
const fetchAndStage = async (
  io: DownloadIO,
  url: string,
  expectedSha: string,
  tmpPath: string,
): Promise<void> => {
  const controller = new AbortController();
  let timedOut = false;
  let transferComplete = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, DOWNLOAD_INSTALLER_TIMEOUT_MS);
  let res: Response | undefined;
  try {
    res = await fetchDownloadResponse(io.fetch, url, controller.signal);
    if (!res.ok) {
      throw new Error(`download fetched ${res.status} ${res.statusText}`);
    }
    const length = declaredLength(res);
    if (length !== undefined && length > DOWNLOAD_INSTALLER_MAX_BYTES) {
      throw new Error(
        `download declared ${length} bytes (limit ${DOWNLOAD_INSTALLER_MAX_BYTES})`,
      );
    }

    await fsp.mkdir(dirname(tmpPath), { recursive: true });
    const file = await fsp.open(tmpPath, 'wx', 0o700);
    try {
      const hash = createHash('sha256');
      let total = 0;
      const reader = res.body?.getReader();
      if (reader !== undefined) {
        let complete = false;
        try {
          for (;;) {
            const next = await reader.read();
            if (next.done) {
              complete = true;
              break;
            }
            if (next.value.byteLength === 0) continue;
            const nextTotal = total + next.value.byteLength;
            if (nextTotal > DOWNLOAD_INSTALLER_MAX_BYTES) {
              throw new Error(
                `download exceeded ${DOWNLOAD_INSTALLER_MAX_BYTES}-byte limit`,
              );
            }
            hash.update(next.value);
            total = await writeChunk(file, next.value, total);
          }
        } finally {
          if (!complete) void reader.cancel().catch(() => undefined);
          try {
            reader.releaseLock();
          } catch {
            // Abort/cancellation already owns stream cleanup.
          }
        }
      }
      transferComplete = true;
      clearTimeout(timer);
      const actual = hash.digest('hex');
      if (actual !== expectedSha) {
        throw new DownloadShaMismatchError(url, expectedSha, actual);
      }
      await file.sync();
    } finally {
      await file.close();
    }
  } catch (err) {
    if (timedOut && !transferComplete) {
      throw new Error(
        `download timed out after ${DOWNLOAD_INSTALLER_TIMEOUT_MS}ms`,
      );
    }
    throw err;
  } finally {
    if (res !== undefined) discardResponseBody(res);
    clearTimeout(timer);
  }
};

const exists = async (path: string): Promise<boolean> => {
  try {
    await fsp.stat(path);
    return true;
  } catch {
    return false;
  }
};

const safeRm = async (path: string): Promise<void> => {
  try {
    await fsp.rm(path, { force: true });
  } catch {
    // best effort — caller already in a recovery path
  }
};

const safeRmDownloadTemps = async (target: string): Promise<void> => {
  const parent = dirname(target);
  const prefix = `${basename(target)}.download.`;
  let names: string[];
  try {
    names = await fsp.readdir(parent);
  } catch {
    return;
  }
  for (const name of names) {
    if (name.startsWith(prefix) && name.endsWith('.tmp')) {
      await safeRm(join(parent, name));
    }
  }
};

/** Run the install/upgrade logic. Returns an outcome shaped like
 *  the spawn-based installers so the dispatcher can route
 *  uniformly. Failure modes:
 *    - sha mismatch → exit -2 + DownloadShaMismatchError surfaces
 *      at the dispatcher (mapped to SERVICE_DOWNLOAD_SHA_MISMATCH).
 *    - network / fs error → exit -1 + message in log_lines. */
const stageReplace = async (
  params: DownloadParams,
  ctx: InstallerContext,
): Promise<InstallerOutcome> => {
  const target = resolveDownloadTarget(ctx, params.target);
  // Unique + exclusive avoids concurrent installs deleting or following one
  // another's predictable staging path. It remains in the target directory so
  // the verified promotion is one-filesystem atomic.
  const tmp = `${target}.download.${randomUUID()}.tmp`;
  const bak = `${target}.bak`;
  const fetchImpl = ctx.fetch ?? globalThis.fetch;

  try {
    await fetchAndStage({ fetch: fetchImpl }, params.url, params.sha256, tmp);
  } catch (err) {
    await safeRm(tmp);
    if (err instanceof DownloadShaMismatchError) {
      return {
        exit_code: -2,
        log_lines: [`sha256 mismatch: expected ${err.expected}, got ${err.actual}`],
      };
    }
    return {
      exit_code: -1,
      log_lines: [err instanceof Error ? err.message : String(err)],
    };
  }

  const hadPrior = await exists(target);
  if (hadPrior) {
    // Move the previous binary aside so an upgrade can roll back.
    // safeRm first to clear any stale .bak from a previous upgrade.
    await safeRm(bak);
    try {
      await fsp.rename(target, bak);
    } catch (err) {
      await safeRm(tmp);
      return {
        exit_code: -1,
        log_lines: [
          `failed to stage rollback (.bak): ${err instanceof Error ? err.message : String(err)}`,
        ],
      };
    }
  }

  try {
    await fsp.rename(tmp, target);
  } catch (err) {
    // Restore the prior binary on rename failure so we don't end up
    // with a missing target.
    if (hadPrior) {
      try {
        await fsp.rename(bak, target);
      } catch {
        /* swallow — primary error is more useful below */
      }
    }
    await safeRm(tmp);
    return {
      exit_code: -1,
      log_lines: [
        `failed to install verified payload: ${err instanceof Error ? err.message : String(err)}`,
      ],
    };
  }

  ctx.onStdout?.(`installed ${target} (sha256 ${params.sha256})`);
  return {
    exit_code: 0,
    log_lines: [`installed ${target} (sha256 ${params.sha256})`],
  };
};

export const downloadInstaller: InstallerKindModule<DownloadParams> = {
  install: stageReplace,
  upgrade: stageReplace,
  uninstall: async ({ target }, ctx) => {
    const resolved = resolveDownloadTarget(ctx, target);
    await safeRm(resolved);
    await safeRm(`${resolved}.bak`);
    await safeRmDownloadTemps(resolved);
    // Pre-hardening releases used one predictable staging filename.
    await safeRm(`${resolved}.download.tmp`);
    return { exit_code: 0, log_lines: [`removed ${resolved}`] };
  },
};
