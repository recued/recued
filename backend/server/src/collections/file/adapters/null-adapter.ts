/** Phase 7 (D-110) — in-test null adapter.
 *
 *  Fake adapter used exclusively in unit tests. Not registered in the
 *  production composition root; test files register it explicitly via
 *  `createAdapterRegistry().register(nullAdapterFactory)` so the
 *  enroll rpc + caps gating paths can be exercised without spinning
 *  up a real FS watcher, AWS client, or browser.
 *
 *  Pretend caps are configurable via the `config` shape:
 *    { caps?: Partial<ProbedCaps> }
 *  so tests can verify refusals for read-only adapters, auth=none
 *  adapters, etc. Defaults to full caps (`write: 'yes', delete:
 *  'yes', watch: 'poll', mirror: 'optional', auth: 'none',
 *  path_style: 'posix'`). */

import type { FileRecordStat } from '@recued/contracts';
import type {
  FileAdapterFactory,
  FileMutationCapable,
} from '../adapter-registry.js';
import type { ProbedCaps } from '../caps.js';
import { FileAdapterError } from '../errors.js';

const DEFAULT_CAPS: ProbedCaps = {
  read: 'yes',
  write: 'yes',
  delete: 'yes',
  watch: 'poll',
  mirror: 'optional',
  auth: 'none',
  path_style: 'posix',
};

const readCapsOverride = (
  config: Record<string, unknown>,
): ProbedCaps => {
  const override = (config.caps as Partial<ProbedCaps> | undefined) ?? {};
  return { ...DEFAULT_CAPS, ...override };
};

export const nullAdapterFactory: FileAdapterFactory = {
  type: 'null-adapter',
  async probeCaps(config) {
    if (config.probeThrows) {
      throw new Error('synthetic probe failure');
    }
    return readCapsOverride(config);
  },
  create(ctx) {
    const records = new Map<string, { body: Uint8Array; modified_at_ms: number; mime?: string }>();
    let started = false;
    const instance: FileMutationCapable = {
      async start() {
        started = true;
        ctx.log?.('info', `null-adapter[${ctx.slug}] started`);
      },
      async stop() {
        started = false;
        ctx.log?.('info', `null-adapter[${ctx.slug}] stopped`);
      },
      async writeRecord(path, body, mime) {
        if (!started) throw new FileAdapterError('io_error', 'adapter not started');
        records.set(path, { body, modified_at_ms: Date.now(), mime });
        await ctx.onEvent({ type: 'change', path });
      },
      async deleteRecord(path) {
        if (!started) throw new FileAdapterError('io_error', 'adapter not started');
        // Idempotent — matches fs-adapter semantics (ENOENT swallowed).
        if (!records.has(path)) {
          await ctx.onEvent({ type: 'remove', path });
          return;
        }
        records.delete(path);
        await ctx.onEvent({ type: 'remove', path });
      },
      async readRecord(path) {
        if (!started) throw new FileAdapterError('io_error', 'adapter not started');
        const entry = records.get(path);
        if (!entry) throw new FileAdapterError('not_found', `null-adapter: not found: ${path}`);
        return entry.body;
      },
      async statRecord(path): Promise<FileRecordStat> {
        if (!started) throw new FileAdapterError('io_error', 'adapter not started');
        const entry = records.get(path);
        if (!entry) return { exists: false };
        return {
          exists: true,
          size_bytes: entry.body.length,
          modified_at_ms: entry.modified_at_ms,
          mime: entry.mime,
        };
      },
    };
    return instance;
  },
};
