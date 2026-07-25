/** D-122 Phase 4.5 — `mail-get` ingredient + rpc handler.
 *
 *  Symmetric with `calendar-get`: returns the full canonical mail row
 *  for a `(slug, record_id)` pair, or `{ record: null }` when the
 *  record doesn't exist. Foundational recipes that consume a
 *  `mail-watcher` trigger and want to materialize `{{step.record.*}}`
 *  use this rather than `collection.get`'s generic shape — the named
 *  primitive keeps recipe JSON cleaner.
 *
 *  No new storage layer; routes through `CollectionRegistry.get('mail',
 *  slug)?.get(record_id)`. The collection's existing get returns the
 *  CollectionRecord shape (hot_fields + body_inline + size_bytes), the
 *  same surface the kernel ingredient adapter already stamps with
 *  `_id` + `_collection`. */

import { RpcError } from '@recued/contracts';
import type { HandlerSlice, ServerRpcRegistry } from '@recued/contracts';
import type { WsClient } from './ws-server.js';
import type { CollectionRegistry } from './collections/registry.js';

export interface MailGetDeps {
  registry: CollectionRegistry;
}

export const handleMailGet = async (
  deps: MailGetDeps,
  args: { slug?: unknown; record_id?: unknown },
): Promise<{ record: unknown | null }> => {
  if (typeof args.slug !== 'string' || args.slug.length === 0) {
    throw new RpcError('bad_request', 'mail.get: slug is required');
  }
  if (typeof args.record_id !== 'string' || args.record_id.length === 0) {
    throw new RpcError('bad_request', 'mail.get: record_id is required');
  }
  const collection = deps.registry.get('mail', args.slug);
  if (!collection) {
    throw new RpcError(
      'collection_not_found',
      `mail.get: instance '${args.slug}' not found`,
    );
  }
  const record = collection.get(args.record_id);
  return { record: record ?? null };
};

type MailGetMethods = 'mail.get';

export const makeMailGetHandlers = (
  deps: MailGetDeps | undefined,
): HandlerSlice<ServerRpcRegistry, MailGetMethods, WsClient> | undefined => {
  if (!deps) return undefined;
  return {
    methods: ['mail.get'],
    handlers: {
      'mail.get': async (args) =>
        handleMailGet(deps, args as Parameters<typeof handleMailGet>[1]),
    },
  };
};
