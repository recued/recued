/** D-122 Phase 2 — `mail-thread-reader` kernel ingredient handler.
 *
 *  Bundles every `data.mail` record sharing `thread_id` into a
 *  chronologically-sorted thread payload. The handler is mail-platform
 *  scoped — the underlying `data.mail` `hot_fields.thread_id` is the
 *  cross-provider canonical thread key (gmail's threadId, IMAP's
 *  References tail, Graph's conversationId all collapse to the same
 *  field at canonicalisation).
 *
 *  Sort: ascending by `received_at` (oldest → newest), so recipes
 *  iterating the thread see the natural conversation flow without an
 *  extra sort step.
 *
 *  Bound: `max_messages` caps the returned messages array. When the
 *  thread is longer, the OLDER messages drop off the head — that's the
 *  natural "last N messages of a thread" semantic and keeps the kernel
 *  surface aligned with how foundational recipes consume threads
 *  (`enrich-contact-from-thread` reads the most recent N for signature
 *  extraction; older messages don't help). `first_at` reflects the
 *  bounded window's first message, not the absolute thread start. */

import { RpcError } from '@recued/contracts';
import type { CollectionRecord } from '@recued/contracts';
import type { CollectionRegistry } from './collections/registry.js';

export interface MailThreadHandlerDeps {
  registry: CollectionRegistry;
}

export interface MailThreadResult {
  messages: CollectionRecord[];
  message_count: number;
  first_at: number;
  last_at: number;
}

const DEFAULT_MAX_MESSAGES = 50;
const HARD_CAP_MESSAGES = 500;

export const handleMailThreadRead = async (
  deps: MailThreadHandlerDeps,
  args: { slug?: unknown; thread_id?: unknown; max_messages?: unknown },
): Promise<MailThreadResult> => {
  const slug = args.slug;
  if (typeof slug !== 'string' || slug.length === 0) {
    throw new RpcError('bad_request', 'mail.thread.read: slug is required', 400);
  }
  const threadId = args.thread_id;
  if (typeof threadId !== 'string' || threadId.length === 0) {
    throw new RpcError('bad_request', 'mail.thread.read: thread_id is required', 400);
  }
  // The cap clamps both upward (defense against pathological recipes)
  // and downward (negative or zero collapses to the default). The
  // foundational recipes default to 50 which fits in one prompt window
  // easily.
  let max = DEFAULT_MAX_MESSAGES;
  if (typeof args.max_messages === 'number' && args.max_messages > 0) {
    max = Math.min(args.max_messages, HARD_CAP_MESSAGES);
  }

  const collection = deps.registry.get('mail', slug);
  if (!collection) {
    // Empty thread vs missing instance: differentiate. A missing
    // instance is a recipe-author error (slug typo or uninstalled
    // adapter) — surface as 404 so the recipe surface can point the
    // user at install. Empty thread (instance exists, no rows match)
    // returns the empty-shape below.
    throw new RpcError(
      'collection_not_found',
      `mail instance '${slug}' not found`,
      404,
    );
  }

  // Hot-field equality filter on `thread_id`. The `list` path's
  // ORDER BY is `received_at DESC` so we fetch up to `max` newest
  // and then reverse for ascending output — keeps the underlying
  // index seek efficient without an extra ORDER pass server-side.
  const records = collection.list({
    platform: 'mail',
    slug,
    filters: { thread_id: threadId },
    limit: max,
  });

  if (records.length === 0) {
    return {
      messages: [],
      message_count: 0,
      first_at: 0,
      last_at: 0,
    };
  }

  // Reverse to ascending. Records came back DESC, so the first row is
  // the newest; the message_count we report is the bounded count, not
  // the absolute thread size. A second list({ limit: bigger }) for the
  // absolute count is intentional non-goal — graph-builder recipes only
  // need the bounded window plus its boundaries, and a second query
  // would double the per-record cost in the hot tier.
  const messages = records.slice().reverse();
  return {
    messages,
    message_count: messages.length,
    first_at: messages[0].received_at,
    last_at: messages[messages.length - 1].received_at,
  };
};
