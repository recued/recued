/** Read-only mail warehouse registration for the standalone stdio MCP profile.
 *
 * The main server and `recued --mcp` are separate processes sharing the same
 * WAL-backed SQLite database.  Starting a second mail stack here would create a
 * second provider sync loop; leaving the registry empty makes every mail recipe
 * fail with COLLECTION_NOT_FOUND.  This adapter opens table-backed views for
 * configured mailboxes and exposes their read methods (the shared table helper
 * may idempotently ensure schema).  It never loads provider credentials, opens
 * a socket, syncs, sends, mutates mail records, or runs retention.
 */

import type Database from 'better-sqlite3';
import { createStorageGate } from '@recued/storage-gate';
import { createInstanceStore } from './collections/instance-store.js';
import type { CollectionRegistry } from './collections/registry.js';
import { createCollectionTable } from './collections/table.js';
import type { Collection } from './collections/types.js';

const DEFAULT_MAIL_QUOTA_BYTES = 512 * 1024 * 1024;

const positiveNumber = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : fallback;

export const registerMcpReadonlyMailCollections = (deps: {
  db: Database.Database;
  registry: CollectionRegistry;
}): number => {
  const instances = createInstanceStore({ db: deps.db });
  let registered = 0;

  for (const instance of instances.list('mail')) {
    if (deps.registry.get('mail', instance.slug)) continue;
    const table = createCollectionTable({
      db: deps.db,
      platform: 'mail',
      slug: instance.slug,
    });
    const gate = createStorageGate({
      quota: positiveNumber(instance.config.quota_bytes, DEFAULT_MAIL_QUOTA_BYTES),
      reservePct: 10,
      surface: `collection:mail:${instance.slug}:mcp-readonly`,
    });
    gate.setUsed(table.totalBytes());

    const refuseMutation = (): never => {
      throw new Error('mcp_readonly_mail_collection: mutation is not available');
    };
    const collection: Collection = {
      platform: 'mail',
      slug: instance.slug,
      gate,
      upsert: refuseMutation,
      delete: refuseMutation,
      get: (record_id) => table.get(record_id),
      list: (query) => table.list(query),
      search: (query) => table.search(query),
      sync: {
        async start() { /* read view has no provider loop */ },
        async stop() { /* read view has no provider loop */ },
      },
      health: () => ({
        platform: 'mail',
        slug: instance.slug,
        last_indexed_at: instance.last_synced_at ?? 0,
        pending_queue_size: 0,
        error_count_24h: 0,
        state: 'idle',
        auth_state: instance.auth_state,
      }),
      async runRetention() {
        return {
          pruned_count: 0,
          bytes_freed: 0,
          blob_hashes_freed: [],
          duration_ms: 0,
          skipped_reason: 'retention_disabled',
        };
      },
      async close() { /* the owning MCP profile closes the shared DB */ },
    };
    deps.registry.register(collection);
    registered += 1;
  }

  return registered;
};
