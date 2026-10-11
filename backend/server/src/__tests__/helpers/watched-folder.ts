/** A real watched folder for a test: the file stack (`composeFileStack`) with
 *  the folder records attached, over a folder on disk, started with a walk.
 *
 *  This is the production path since 2026-10-10. Tests used to build the
 *  Phase D `createFileCollection` instead, a collection with its own watcher
 *  that nothing in production created; it is gone. */
import type Database from 'better-sqlite3';
import { createStorageGate, type StorageGate } from '@recued/storage-gate';
import type { WarehouseEventBus } from '@recued/warehouse-events';

import { composeFileStack, type FileStack } from '../../collections/file/compose.js';
import {
  isWatchedFolderCollection,
  type WatchedFolderCollection,
} from '../../collections/file/watched-folder-collection.js';
import type { CollectionRegistry } from '../../collections/registry.js';

export interface WatchedFolderHarness {
  collection: WatchedFolderCollection;
  stack: FileStack;
  /** Stop the folder's adapter (its walk-and-watch). */
  close(): Promise<void>;
}

export const startWatchedFolder = async (opts: {
  db: Database.Database;
  bus: WarehouseEventBus;
  registry: CollectionRegistry;
  slug: string;
  root: string;
  /** `none` (default): one walk at start, nothing live — deterministic.
   *  `realtime`: the walk, then an OS watch. */
  watch?: 'none' | 'realtime';
  /** The folder's gate; a large one by default. */
  gate?: StorageGate;
}): Promise<WatchedFolderHarness> => {
  const stack = composeFileStack(opts.db);
  stack.attachWatchedFolders({
    registry: opts.registry,
    bus: opts.bus,
    gates: {
      get: (slug) => opts.gate
        ?? createStorageGate({ quota: 512 * 1024 * 1024, reservePct: 1, surface: `collection:file:${slug}` }),
      release: () => {},
    },
  });
  stack.instances.upsert({
    platform: 'file',
    slug: opts.slug,
    adapter_type: 'fs',
    config: { path: opts.root },
    caps: {
      read: 'yes', write: 'yes', delete: 'yes',
      watch: opts.watch ?? 'none',
      mirror: 'optional', auth: 'none', path_style: 'posix',
    },
    auth_state: 'healthy',
    last_synced_at: null,
  });
  await stack.startAll();
  const collection = opts.registry.get('file', opts.slug);
  if (!collection || !isWatchedFolderCollection(collection)) {
    throw new Error(`startWatchedFolder: no collection for '${opts.slug}'`);
  }
  return { collection, stack, close: () => stack.disposeAll() };
};
