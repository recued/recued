/** D-106 follow-up — the file stack's watched folders, as collections.
 *
 *  `compose.ts` runs one adapter per enrolled folder; this keeps the matching
 *  `WatchedFolderCollection` per `fs` folder: registered in the collection
 *  registry as `('file', <slug>)` (so `collection.list` / `.get` / `.search`,
 *  the kernel file readers, universal search and the Files tab reach it) with
 *  its own storage gate, `collection:file:<slug>`, which bounds the text kept
 *  for search. Attached to the stack once the registry and the warehouse bus
 *  exist (`FileStack.attachWatchedFolders`). */

import type Database from 'better-sqlite3';
import type { StorageGate } from '@recued/storage-gate';
import type { WarehouseEventBus } from '@recued/warehouse-events';

import type { GateRegistry } from '../../storage-gates.js';
import type { CollectionRegistry } from '../registry.js';
import type { FileMutationCapable } from './adapter-registry.js';
import {
  createWatchedFolderCollection,
  type WatchedFolderCollection,
  type WatchedFolderStatus,
} from './watched-folder-collection.js';

/** The slug of the inbound file store (`inbound-file-collection.ts`), already
 *  registered as `('file', 'received')`. A folder enrolled under it is still
 *  watched, but cannot have a collection of its own. */
export const RECEIVED_FILE_SLUG = 'received';

/** The cap on text kept for search, per folder. */
export const WATCHED_FOLDER_TEXT_QUOTA_BYTES = 512 * 1024 * 1024;

/** The folder gates, from the server's gate registry. */
export interface WatchedFolderGates {
  /** The folder's gate, registered on first use. */
  get(slug: string): StorageGate;
  /** Take it out when the folder is removed. */
  release(slug: string): void;
}

/** The folder gates over the server's gate registry: `collection:file:<slug>`,
 *  file-collection sized, never evicted (the cascade leaves `file` surfaces
 *  alone). */
export const watchedFolderGates = (
  registry: Pick<GateRegistry, 'get' | 'register' | 'unregister'>,
): WatchedFolderGates => ({
  get: (slug) => {
    const name = `collection:file:${slug}`;
    return registry.get(name)
      ?? registry.register(name, { quota: WATCHED_FOLDER_TEXT_QUOTA_BYTES, reservePct: 1, initialUsage: 0 });
  },
  release: (slug) => { registry.unregister(`collection:file:${slug}`); },
});

/** What the stack attaches once the server has them. */
export interface WatchedFoldersAttachment {
  registry: CollectionRegistry;
  bus: WarehouseEventBus;
  gates: WatchedFolderGates;
}

export interface WatchedFoldersDeps extends WatchedFoldersAttachment {
  db: Database.Database;
  /** The folder's path from its instance row, read live. */
  rootOf: (slug: string) => string | undefined;
  status: (slug: string) => WatchedFolderStatus;
  /** The folder's live adapter, for reading a file's bytes. */
  adapter: (slug: string) => FileMutationCapable | undefined;
  now?: () => number;
  log?: (level: 'info' | 'warn' | 'error', msg: string, data?: unknown) => void;
}

export interface WatchedFolders {
  /** The folder's collection, registered on first use. `undefined` when it
   *  cannot have one: its slug is the inbound store's, or it has no path. */
  open(slug: string): WatchedFolderCollection | undefined;
  get(slug: string): WatchedFolderCollection | undefined;
  /** Its enrollment was deleted: unregister it, drop its tables and release
   *  its gate. No events. */
  drop(slug: string): void;
}

export const createWatchedFolders = (deps: WatchedFoldersDeps): WatchedFolders => {
  const open = new Map<string, WatchedFolderCollection>();
  const refused = new Set<string>();
  return {
    open(slug) {
      const existing = open.get(slug);
      if (existing) return existing;
      if (slug === RECEIVED_FILE_SLUG) {
        if (!refused.has(slug)) {
          refused.add(slug);
          deps.log?.('warn', `file-stack: folder '${slug}' shares the received files' name, so it is watched without records; enroll it again under another name`);
        }
        return undefined;
      }
      if (deps.rootOf(slug) === undefined) return undefined;
      const collection = createWatchedFolderCollection({
        db: deps.db,
        gate: deps.gates.get(slug),
        bus: deps.bus,
        slug,
        root: () => deps.rootOf(slug) ?? '',
        status: () => deps.status(slug),
        adapter: () => deps.adapter(slug),
        ...(deps.now ? { now: deps.now } : {}),
        ...(deps.log ? { log: deps.log } : {}),
      });
      // Text kept by an earlier run counts from the start.
      collection.gate.setUsed(collection.totalBytes());
      deps.registry.register(collection);
      open.set(slug, collection);
      return collection;
    },
    get: (slug) => open.get(slug),
    drop(slug) {
      const collection = open.get(slug);
      if (!collection) return;
      open.delete(slug);
      deps.registry.unregister('file', slug);
      collection.drop();
      deps.gates.release(slug);
    },
  };
};
