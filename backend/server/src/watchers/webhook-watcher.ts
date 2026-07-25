/** D-115 Phase 6C — webhook-watcher handler + queue.
 *
 *  Server-only. Unlike mail / file / calendar watchers, webhook
 *  triggers aren't driven by warehouse reads — they come from
 *  inbound HTTP POSTs at `/hook/{recipe_id}/{slug}`. The handler
 *  drains a per-`(recipe_id, slug)` in-memory queue on each tick
 *  and returns `{should_run, requests, queue_size}`.
 *
 *  Queue bounds (see DEFAULT_* below):
 *    - Per-key size cap — the oldest entry is evicted FIFO when
 *      a new arrival would exceed the cap. Protects against a
 *      runaway producer blowing server RAM.
 *    - Per-entry TTL — stale entries are pruned before drain.
 *      If a recipe stops ticking, its queue empties itself; we
 *      never serve a webhook that arrived hours ago.
 *
 *  D-096 invariant: the cloud never relays inbound webhooks.
 *  This handler runs on `recued-server` only and requires a
 *  publicly reachable address (or user-hosted tunnel) to receive
 *  external posts. Extension instances route `webhook-watcher`
 *  ingredients through pair-rpc to the paired server; without a
 *  server they fall through to SERVER_NOT_REACHABLE at the kernel
 *  adapter. */

import { IngredientError } from '@recued/ingredients';

export const DEFAULT_WEBHOOK_QUEUE_MAX_PER_KEY = 1000;
export const DEFAULT_WEBHOOK_QUEUE_TTL_MS = 5 * 60 * 1000;

/** One enqueued request. `body` is the raw body text capped at the
 *  listener's body limit; the recipe author can parse JSON via a
 *  downstream transform. Headers are captured as a flat lower-
 *  cased map so authors can key off Content-Type / User-Agent / x-*
 *  without needing the hook listener to emit a specific subset. */
export interface WebhookWatcherRequest {
  delivery_id: string;
  received_at: number;
  method: string;
  headers: Record<string, string>;
  body: string;
  source_ip: string | null;
  [field: string]: unknown;
}

export interface WebhookWatcherArgs {
  recipe_id: string;
  slug: string;
}

export interface WebhookWatcherOutput {
  should_run: boolean;
  requests: WebhookWatcherRequest[];
  queue_size: number;
  [field: string]: unknown;
}

export interface WebhookWatcherQueueOptions {
  /** Per-(recipe_id, slug) hard cap. Oldest-first FIFO eviction
   *  when exceeded. Default DEFAULT_WEBHOOK_QUEUE_MAX_PER_KEY. */
  maxPerKey?: number;
  /** Per-entry TTL in ms. Older entries are pruned on enqueue +
   *  drain. Default DEFAULT_WEBHOOK_QUEUE_TTL_MS. */
  ttlMs?: number;
  /** `Date.now()` injection for deterministic tests. */
  now?: () => number;
}

export interface WebhookWatcherQueue {
  /** Append a request to `(recipe_id, slug)`'s buffer. Evicts
   *  oldest entries when the per-key cap is exceeded. */
  enqueue(recipe_id: string, slug: string, request: WebhookWatcherRequest): void;
  /** Remove + return every non-expired entry for `(recipe_id, slug)`
   *  in arrival order. Destructive — a request is delivered to
   *  exactly one tick, matching the manifest's "drains the queue"
   *  contract. Returns `[]` when the queue is empty. */
  drain(recipe_id: string, slug: string): WebhookWatcherRequest[];
  /** Non-destructive size probe. Useful for health / diagnostics;
   *  the handler reports `queue_size` post-drain (0 after a full
   *  drain) so recipes can AND-gate on "more requests arrived
   *  while we were running" — fold back in via auto-run. */
  size(recipe_id: string, slug: string): number;
  /** Drop every queue for a given recipe (e.g., on uninstall). */
  purgeRecipe(recipe_id: string): void;
  /** Remove expired entries from every queue. Normally called on
   *  enqueue + drain; exposed for test + maintenance flows. */
  prune(): void;
}

const keyOf = (recipe_id: string, slug: string): string =>
  `${recipe_id}\u0000${slug}`;

export const createWebhookWatcherQueue = (
  options: WebhookWatcherQueueOptions = {},
): WebhookWatcherQueue => {
  const maxPerKey = options.maxPerKey ?? DEFAULT_WEBHOOK_QUEUE_MAX_PER_KEY;
  const ttlMs = options.ttlMs ?? DEFAULT_WEBHOOK_QUEUE_TTL_MS;
  const now = options.now ?? Date.now;

  const queues = new Map<string, WebhookWatcherRequest[]>();

  const pruneKey = (key: string, cutoff: number): void => {
    const q = queues.get(key);
    if (!q) return;
    while (q.length > 0 && q[0].received_at < cutoff) q.shift();
    if (q.length === 0) queues.delete(key);
  };

  return {
    enqueue(recipe_id, slug, request) {
      const key = keyOf(recipe_id, slug);
      const cutoff = now() - ttlMs;
      pruneKey(key, cutoff);
      const q = queues.get(key) ?? [];
      q.push(request);
      while (q.length > maxPerKey) q.shift();
      queues.set(key, q);
    },
    drain(recipe_id, slug) {
      const key = keyOf(recipe_id, slug);
      const cutoff = now() - ttlMs;
      pruneKey(key, cutoff);
      const q = queues.get(key);
      if (!q || q.length === 0) return [];
      queues.delete(key);
      return q;
    },
    size(recipe_id, slug) {
      const key = keyOf(recipe_id, slug);
      const cutoff = now() - ttlMs;
      pruneKey(key, cutoff);
      return queues.get(key)?.length ?? 0;
    },
    purgeRecipe(recipe_id) {
      const prefix = `${recipe_id}\u0000`;
      for (const key of [...queues.keys()]) {
        if (key.startsWith(prefix)) queues.delete(key);
      }
    },
    prune() {
      const cutoff = now() - ttlMs;
      for (const key of [...queues.keys()]) pruneKey(key, cutoff);
    },
  };
};

// ────────────────────────────────────────────────────────────────
// Kernel dispatcher handler
// ────────────────────────────────────────────────────────────────

export interface WebhookWatcherDeps {
  queue: WebhookWatcherQueue;
}

const parseArgs = (input: Record<string, unknown>): WebhookWatcherArgs => {
  const recipe_id = input.recipe_id;
  if (typeof recipe_id !== 'string' || recipe_id === '') {
    throw new IngredientError(
      'TRANSFORM_INVALID_INPUT',
      'webhook-watcher: `recipe_id` is required',
      { got: recipe_id },
    );
  }
  const slug = input.slug;
  if (typeof slug !== 'string' || slug === '') {
    throw new IngredientError(
      'TRANSFORM_INVALID_INPUT',
      'webhook-watcher: `slug` is required',
      { got: slug },
    );
  }
  return { recipe_id, slug };
};

export const handleWebhookWatcher = async (
  deps: WebhookWatcherDeps,
  input: Record<string, unknown>,
): Promise<WebhookWatcherOutput> => {
  const args = parseArgs(input);
  const requests = deps.queue.drain(args.recipe_id, args.slug);
  // After drain the queue is empty for this key; `queue_size` is
  // always 0 post-drain by construction. Kept in the envelope so
  // callers can future-proof against a non-destructive drain mode.
  const queueSize = deps.queue.size(args.recipe_id, args.slug);
  return {
    should_run: requests.length > 0,
    requests,
    queue_size: queueSize,
  };
};
