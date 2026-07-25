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
 *    2. Stream download → `<target>.download.tmp`, hashing on
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

import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { dirname, isAbsolute, join, normalize, relative } from 'node:path';

import { SERVICE_CWD_SUBDIR } from '@recued/contracts';

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
  if (!/^https:\/\//i.test(url)) {
    throw new InstallerParamError(
      'download',
      'url must be https:// — http downloads are not allowed',
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
    url,
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

const sha256Hex = (buf: Buffer): string =>
  createHash('sha256').update(buf).digest('hex');

interface DownloadIO {
  fetch: typeof fetch;
}

/** Streaming-friendly fetch + hash. Reads the response into a
 *  buffer (installer payloads are typically tens of MB — small
 *  enough to keep in memory and avoid the temp-file race), writes
 *  to `<target>.download.tmp`, returns the verified hash. */
const fetchAndStage = async (
  io: DownloadIO,
  url: string,
  expectedSha: string,
  tmpPath: string,
): Promise<void> => {
  const res = await io.fetch(url);
  if (!res.ok) {
    throw new Error(`download fetched ${res.status} ${res.statusText}`);
  }
  const arrayBuffer = await res.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const actual = sha256Hex(buffer);
  if (actual !== expectedSha) {
    throw new DownloadShaMismatchError(url, expectedSha, actual);
  }
  await fsp.mkdir(dirname(tmpPath), { recursive: true });
  await fsp.writeFile(tmpPath, buffer);
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
  const tmp = `${target}.download.tmp`;
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
    await safeRm(`${resolved}.download.tmp`);
    return { exit_code: 0, log_lines: [`removed ${resolved}`] };
  },
};
