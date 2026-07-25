/** Phase 7 (D-110) — `ext-downloads` adapter (server side).
 *
 *  Server-side receiver for downloads events streamed in over the
 *  paired-client rpc `collection.file.downloads.stream`. The bridge
 *  observes `chrome.downloads`, serializes each completed download,
 *  and streams the payload to the server. This module exposes the
 *  factory + receive-side handler the rpc dispatcher calls.
 *
 *  Caps (fixed — no probe needed):
 *    read: 'yes', write: 'no', delete: 'no',
 *    watch: 'realtime', mirror: 'required',
 *    auth: 'none', path_style: 'uri'.
 *
 *  The adapter itself is passive: `start()` / `stop()` are no-ops
 *  because the bridge owns the observation loop. The server just
 *  holds the slug + emits events when the rpc receive handler calls
 *  `handleDownloadsStream`. `writeRecord` / `deleteRecord` reject
 *  with `UNSUPPORTED` — ext-downloads is read-only per
 *  caps.write = 'no'. */

import { Buffer } from 'node:buffer';
import type { FileRecordStat } from '@recued/contracts';
import type {
  FileAdapterContext,
  FileAdapterEvent,
  FileAdapterFactory,
  FileMutationCapable,
} from '../../adapter-registry.js';
import type { ProbedCaps } from '../../caps.js';
import { FileAdapterError } from '../../errors.js';

const FIXED_CAPS: ProbedCaps = {
  read: 'yes',
  write: 'no',
  delete: 'no',
  watch: 'realtime',
  mirror: 'required',
  auth: 'none',
  path_style: 'uri',
};

export interface DownloadStreamInput {
  slug: string;
  path: string;
  mime?: string;
  size_bytes: number;
  body_b64: string;
  source_url?: string;
}

/** In-memory registry keyed by slug. The factory adds/removes
 *  entries on start/stop. `handleDownloadsStream` reads from this
 *  registry so the rpc handler can dispatch per-slug without
 *  coupling to the CollectionRegistry. */
export interface ExtDownloadsRegistry {
  register(
    slug: string,
    onStream: (payload: DownloadStreamInput) => Promise<void> | void,
  ): void;
  unregister(slug: string): void;
  get(slug: string): ((payload: DownloadStreamInput) => Promise<void> | void) | undefined;
}

export const createExtDownloadsRegistry = (): ExtDownloadsRegistry => {
  const bySlug = new Map<string, (payload: DownloadStreamInput) => Promise<void> | void>();
  return {
    register(slug, onStream) {
      bySlug.set(slug, onStream);
    },
    unregister(slug) {
      bySlug.delete(slug);
    },
    get(slug) {
      return bySlug.get(slug);
    },
  };
};

export interface ExtDownloadsFactoryOptions {
  registry: ExtDownloadsRegistry;
}

export const createExtDownloadsAdapterFactory = (
  opts: ExtDownloadsFactoryOptions,
): FileAdapterFactory => ({
  type: 'ext-downloads',
  async probeCaps() {
    return FIXED_CAPS;
  },
  create(ctx: FileAdapterContext): FileMutationCapable {
    // In-memory stat cache populated as the extension streams
    // downloads. Loses its contents on server restart — recipes that
    // need older-than-process-lifetime metadata should query
    // `file-list` which hits the durable collection table.
    const statCache = new Map<string, FileRecordStat>();

    const onStream = async (payload: DownloadStreamInput): Promise<void> => {
      const bodyBytes = payload.body_b64
        ? Buffer.from(payload.body_b64, 'base64').length
        : 0;
      statCache.set(payload.path, {
        exists: true,
        size_bytes: payload.size_bytes || bodyBytes,
        modified_at_ms: Date.now(),
        mime: payload.mime,
      });
      const event: FileAdapterEvent = {
        type: 'change',
        path: payload.path,
      };
      await ctx.onEvent(event);
    };

    return {
      async start() {
        opts.registry.register(ctx.slug, onStream);
      },
      async stop() {
        opts.registry.unregister(ctx.slug);
        statCache.clear();
      },
      async writeRecord() {
        throw new FileAdapterError(
          'permission_denied',
          'ext-downloads: writeRecord is not supported (caps.write=no)',
        );
      },
      async deleteRecord() {
        throw new FileAdapterError(
          'permission_denied',
          'ext-downloads: deleteRecord is not supported (caps.delete=no)',
        );
      },
      async readRecord() {
        // Reading bytes goes through the Collection's record store —
        // the adapter itself doesn't hold the bytes after the stream
        // rpc received them. Returning an empty body keeps the
        // FileMutationCapable shape intact for callers that only
        // want the probe/caps surface.
        return new Uint8Array();
      },
      async statRecord(path): Promise<FileRecordStat> {
        const cached = statCache.get(path);
        if (cached) return cached;
        return { exists: false };
      },
    };
  },
});

/** Rpc handler for `collection.file.downloads.stream`. Routes the
 *  payload to the adapter registered for the slug. Throws when the
 *  slug isn't registered (the extension sent a stream for an
 *  unknown instance — caller surfaces a 404). */
export const handleDownloadsStream = async (
  registry: ExtDownloadsRegistry,
  input: DownloadStreamInput,
): Promise<{ ok: true; bytes_stored: number }> => {
  const onStream = registry.get(input.slug);
  if (!onStream) {
    throw new Error(`ext-downloads: no adapter registered for slug '${input.slug}'`);
  }
  await onStream(input);
  const bytes = input.body_b64 ? Buffer.from(input.body_b64, 'base64').length : 0;
  return { ok: true, bytes_stored: bytes };
};
