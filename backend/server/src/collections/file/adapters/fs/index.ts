/** Phase 7 (D-110) — fs file adapter.
 *
 *  Wraps the Phase D `createFsWatcher` behind the Phase 7
 *  FileAdapterFactory interface. Adds mutation methods so
 *  `file-write` / `file-delete` / `file-move` ingredients can write
 *  through the same adapter that observes for new files.
 *
 *  Path contract: `writeRecord` / `deleteRecord` / `readRecord`
 *  accept paths relative to the configured `root`. Absolute paths
 *  or paths that escape root (`..`) are rejected with
 *  `PATH_ESCAPES_ROOT` — the dispatcher folds this into a
 *  recipe-visible `FILE_UNSAFE_PATH` error. */

import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path';
import type { FileRecordStat } from '@recued/contracts';
import type {
  FileAdapterContext,
  FileAdapterFactory,
  FileMutationCapable,
} from '../../adapter-registry.js';
import { classifyNodeFsError, FileAdapterError } from '../../errors.js';
import {
  createFsWatcher,
  type FsWatcher,
} from '../../fs-adapter.js';
import { probeFsCaps, type FsProbeConfig } from './probe.js';

const MIME_BY_EXT: Readonly<Record<string, string>> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.xml': 'application/xml',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

const mimeForPath = (path: string): string | undefined =>
  MIME_BY_EXT[extname(path).toLowerCase()];

export interface FsAdapterConfig extends FsProbeConfig {
  /** Gitignore-subset globs. Omitted → no ignores. Same syntax
   *  `createFsWatcher` documents. */
  ignore?: string[];
  /** Event debounce — forwarded to `createFsWatcher`. */
  debounceMs?: number;
}

const asConfig = (raw: Record<string, unknown>): FsAdapterConfig => {
  const path = raw.path;
  if (typeof path !== 'string' || path.length === 0) {
    throw new Error('fs adapter: config.path is required');
  }
  const ignore = Array.isArray(raw.ignore)
    ? (raw.ignore as unknown[]).filter((v): v is string => typeof v === 'string')
    : [];
  const debounceMs =
    typeof raw.debounceMs === 'number' && raw.debounceMs > 0
      ? raw.debounceMs
      : undefined;
  return { path, ignore, debounceMs };
};

/** Resolve a record path against the adapter root, refusing the two STRING
 *  forms that leave it: an absolute path, and a `..` traversal.
 *
 *  ⛔⛔ WHAT THIS DOES NOT DO, DESPITE THE NAME: it never touches the disk, so
 *  it cannot see a SYMLINK. A link that lives inside `root` and points outside
 *  it passes every check here, and the caller then reads, writes or deletes the
 *  TARGET. Demonstrated in `fs-adapter-factory.test.ts` — *"a SYMLINK inside
 *  the root is followed, in AND out"* — which pins the behaviour and states the
 *  open question rather than deciding it.
 *
 *  ⚠ The sibling containment check in this codebase takes the other posture:
 *  `execution/run-scratch.ts` calls `realpathSync` BEFORE comparing. Neither
 *  site says why it differs from the other, and that is the part worth
 *  resolving — following a user's own `~/Documents/work -> /Volumes/Work` is
 *  defensible, and so is refusing it; claiming containment while doing the
 *  first is not.
 *
 *  🔑 The caller cannot CREATE the link: `writeRecord` uses `writeFile`, which
 *  writes a regular file. The link must already exist. */
const ensureInsideRoot = (root: string, requested: string): string => {
  if (isAbsolute(requested)) {
    throw new Error(`fs adapter: absolute path not permitted: ${requested}`);
  }
  const abs = resolve(root, requested);
  const rel = relative(root, abs);
  if (rel.startsWith('..') || rel === '') {
    throw new Error(`fs adapter: path escapes root: ${requested}`);
  }
  return abs;
};

export const fsAdapterFactory: FileAdapterFactory = {
  type: 'fs',
  async probeCaps(config) {
    const parsed = asConfig(config);
    return probeFsCaps(parsed);
  },
  create(ctx: FileAdapterContext): FileMutationCapable {
    const config = asConfig(ctx.config);
    const root = resolve(config.path);
    let watcher: FsWatcher | undefined;
    let started = false;

    const log = ctx.log ?? (() => {});

    const instance: FileMutationCapable = {
      async start() {
        if (started) return;
        started = true;
        const watchMode = ctx.caps === undefined || ctx.caps.watch === 'realtime'
          ? 'realtime'
          : 'none';
        watcher = createFsWatcher({
          root,
          ignore: config.ignore ?? [],
          debounceMs: config.debounceMs,
          watchMode,
          onUnavailable: (error) => ctx.onDegraded?.(error),
          log,
          onEvent: (event) => ctx.onEvent(event),
        });
        try {
          await watcher.start();
        } catch (err) {
          try { await watcher.stop(); } catch { /* start error is authoritative */ }
          watcher = undefined;
          started = false;
          throw err;
        }
      },
      async stop() {
        if (!started) return;
        started = false;
        if (watcher) {
          await watcher.stop();
          watcher = undefined;
        }
      },
      async writeRecord(path, body) {
        const abs = ensureInsideRoot(root, path);
        try {
          await mkdir(dirname(abs), { recursive: true });
          await writeFile(abs, body);
        } catch (err) {
          throw classifyNodeFsError(err, path);
        }
      },
      async deleteRecord(path) {
        const abs = ensureInsideRoot(root, path);
        try {
          await unlink(abs);
        } catch (err) {
          // ENOENT on delete is idempotent — swallow. Everything else
          // classifies as a typed adapter error.
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
          throw classifyNodeFsError(err, path);
        }
      },
      async readRecord(path) {
        const abs = ensureInsideRoot(root, path);
        try {
          return await readFile(abs);
        } catch (err) {
          throw classifyNodeFsError(err, path);
        }
      },
      async statRecord(path): Promise<FileRecordStat> {
        let abs: string;
        try {
          abs = ensureInsideRoot(root, path);
        } catch (err) {
          // Path-shape error — surface as io_error, not permission.
          throw new FileAdapterError(
            'io_error',
            (err as Error).message,
            err,
          );
        }
        try {
          const st = await stat(abs);
          return {
            exists: true,
            size_bytes: st.size,
            modified_at_ms: Math.trunc(st.mtimeMs),
            mime: mimeForPath(path),
          };
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === 'ENOENT') return { exists: false };
          throw classifyNodeFsError(err, path);
        }
      },
    };

    return instance;
  },
};
