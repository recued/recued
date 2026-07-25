/** Phase 7 (D-110) — S3 file adapter.
 *
 *  Wraps the fetch-based S3 client + SigV4 behind the Phase 7
 *  FileAdapterFactory interface. Supports:
 *    - AWS + any S3-compatible endpoint (R2, B2, MinIO) via
 *      `endpoint` + `use_path_style` config knobs.
 *    - Caps probe: HeadBucket + PutObject → GetObject → DeleteObject
 *      round-trip on `/.recued-caps-probe`. Config keys with missing
 *      permissions surface as `write: 'no'` / `delete: 'no'` caps.
 *    - Watch: `realtime` when `notifications_enabled: true` (caller
 *      wires bucket-notification → server webhook → parseS3Notification).
 *      Falls back to `poll` otherwise.
 *
 *  v1 deliberately skips:
 *    - STS / IAM role credentials (user supplies access_key +
 *      secret_key).
 *    - Server-side encryption knob (SSE defaults apply).
 *    - Multipart upload for large files — v1 refuses objects above
 *      5 MB with a `TOO_LARGE` error rather than multipart streaming. */

import { randomUUID } from 'node:crypto';
import type { FileRecordStat } from '@recued/contracts';
import type {
  FileAdapterContext,
  FileAdapterFactory,
  FileMutationCapable,
} from '../../adapter-registry.js';
import type { ProbedCaps } from '../../caps.js';
import { classifyS3Error } from '../../errors.js';
import {
  createS3Client,
  S3Error,
  type S3Client,
  type S3ClientConfig,
  type S3Fetch,
} from './client.js';

const MAX_OBJECT_BYTES = 5 * 1024 * 1024;

export interface S3AdapterConfig {
  access_key: string;
  secret_key: string;
  region: string;
  bucket: string;
  endpoint?: string;
  use_path_style?: boolean;
  /** Flip to `true` when the operator has wired bucket notifications
   *  → server webhook. Caps.watch reads this; otherwise defaults to
   *  `poll`. */
  notifications_enabled?: boolean;
  /** Poll interval (ms) when `watch: 'poll'`. Ignored when
   *  `notifications_enabled: true`. Default 60s. */
  poll_interval_ms?: number;
}

export interface S3AdapterOverrides {
  fetcher?: S3Fetch;
  now?: () => Date;
}

const asConfig = (raw: Record<string, unknown>): S3AdapterConfig => {
  const access_key = raw.access_key;
  const secret_key = raw.secret_key;
  const region = raw.region;
  const bucket = raw.bucket;
  if (typeof access_key !== 'string' || !access_key) {
    throw new Error('s3 adapter: config.access_key is required');
  }
  if (typeof secret_key !== 'string' || !secret_key) {
    throw new Error('s3 adapter: config.secret_key is required');
  }
  if (typeof region !== 'string' || !region) {
    throw new Error('s3 adapter: config.region is required');
  }
  if (typeof bucket !== 'string' || !bucket) {
    throw new Error('s3 adapter: config.bucket is required');
  }
  const endpoint = typeof raw.endpoint === 'string' ? raw.endpoint : undefined;
  const use_path_style =
    typeof raw.use_path_style === 'boolean' ? raw.use_path_style : undefined;
  const notifications_enabled =
    typeof raw.notifications_enabled === 'boolean'
      ? raw.notifications_enabled
      : false;
  const poll_interval_ms =
    typeof raw.poll_interval_ms === 'number' && raw.poll_interval_ms > 0
      ? raw.poll_interval_ms
      : 60_000;
  return {
    access_key,
    secret_key,
    region,
    bucket,
    endpoint,
    use_path_style,
    notifications_enabled,
    poll_interval_ms,
  };
};

const clientConfig = (cfg: S3AdapterConfig): S3ClientConfig => ({
  access_key: cfg.access_key,
  secret_key: cfg.secret_key,
  region: cfg.region,
  bucket: cfg.bucket,
  endpoint: cfg.endpoint,
  use_path_style: cfg.use_path_style,
});

/** Build the S3 adapter factory. Overrides (fetcher, now) are shared
 *  between probe + live adapter so tests wire them once. Production
 *  callers use `createS3AdapterFactory()` with no arguments. */
export const createS3AdapterFactory = (
  overrides: S3AdapterOverrides = {},
): FileAdapterFactory => {
  const probe = async (config: Record<string, unknown>): Promise<ProbedCaps> => {
    const parsed = asConfig(config);
    const client = createS3Client({
      config: clientConfig(parsed),
      fetcher: overrides.fetcher,
      now: overrides.now,
    });
    try {
      await client.headBucket();
    } catch (err) {
      // Failed bucket-level check — surface as config error (caller
      // maps to 422).
      throw new Error(`s3 adapter: HeadBucket failed: ${(err as Error).message}`);
    }

    const probeKey = `.recued-caps-probe-${randomUUID()}`;
    const body = new TextEncoder().encode('recued-caps-probe');
    let canWrite = true;
    let canDelete = true;
    try {
      await client.putObject(probeKey, body, 'text/plain');
      await client.getObject(probeKey);
    } catch {
      canWrite = false;
    } finally {
      try {
        await client.deleteObject(probeKey);
      } catch {
        canDelete = false;
      }
    }

    return {
      read: 'yes',
      write: canWrite ? 'yes' : 'no',
      delete: canWrite && canDelete ? 'yes' : 'no',
      watch: parsed.notifications_enabled ? 'realtime' : 'poll',
      mirror: 'optional',
      auth: 'keys',
      path_style: 's3-key',
    };
  };

  const create = (ctx: FileAdapterContext): FileMutationCapable => {
    const parsed = asConfig(ctx.config);
    const client: S3Client = createS3Client({
      config: clientConfig(parsed),
      fetcher: overrides.fetcher,
      now: overrides.now,
    });

    let pollHandle: ReturnType<typeof setInterval> | undefined;
    let seenKeys = new Set<string>();

    const runPollTick = async (): Promise<void> => {
      try {
        const { keys } = await client.listObjects();
        const fresh = new Set(keys);
        for (const key of fresh) {
          if (!seenKeys.has(key)) {
            await ctx.onEvent({ type: 'change', path: key });
          }
        }
        for (const key of seenKeys) {
          if (!fresh.has(key)) {
            await ctx.onEvent({ type: 'remove', path: key });
          }
        }
        seenKeys = fresh;
      } catch (err) {
        ctx.log?.('warn', `s3 poll tick failed for ${parsed.bucket}`, { err });
      }
    };

    return {
      async start() {
        // Initial scan → `present` events for each key.
        try {
          const { keys } = await client.listObjects();
          seenKeys = new Set(keys);
          for (const key of keys) {
            await ctx.onEvent({ type: 'present', path: key });
          }
        } catch (err) {
          ctx.log?.('error', 's3 initial scan failed', { err });
        }
        if (!parsed.notifications_enabled) {
          pollHandle = setInterval(() => {
            void runPollTick();
          }, parsed.poll_interval_ms);
        }
      },
      async stop() {
        if (pollHandle) {
          clearInterval(pollHandle);
          pollHandle = undefined;
        }
      },
      async writeRecord(path, body, mime) {
        if (body.length > MAX_OBJECT_BYTES) {
          throw new S3Error(
            'TOO_LARGE',
            `TOO_LARGE: object ${path} (${body.length} bytes) exceeds ${MAX_OBJECT_BYTES}-byte v1 ceiling`,
          );
        }
        try {
          await client.putObject(path, body, mime);
        } catch (err) {
          throw classifyS3Error(err, path);
        }
      },
      async deleteRecord(path) {
        try {
          await client.deleteObject(path);
        } catch (err) {
          throw classifyS3Error(err, path);
        }
      },
      async readRecord(path) {
        try {
          const { body } = await client.getObject(path);
          return body;
        } catch (err) {
          throw classifyS3Error(err, path);
        }
      },
      async statRecord(path): Promise<FileRecordStat> {
        try {
          const head = await client.headObject(path);
          return {
            exists: true,
            size_bytes: head.size_bytes,
            modified_at_ms: head.modified_at_ms ?? undefined,
            mime: head.mime,
          };
        } catch (err) {
          const classified = classifyS3Error(err, path);
          if (classified.code === 'not_found') return { exists: false };
          throw classified;
        }
      },
    };
  };

  return {
    type: 's3',
    probeCaps: probe,
    create,
  };
};

export const s3AdapterFactory = createS3AdapterFactory();
export { parseS3Notification } from './notifications.js';
export type { S3ClientConfig, S3Fetch } from './client.js';
