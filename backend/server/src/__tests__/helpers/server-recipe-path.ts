/** Run a shipped recipe on the server's own path for state that survives
 *  between runs: shared storage, watcher cursors, the calendar watcher's record
 *  of returned events.
 *
 *  ⛔ Why this exists (2026-10-05). The starter-template fix stored its cursors
 *  under bare keys (`watch_urgent_mail_cursor`), and its test stubbed the
 *  shared write and handed the next run a hand-built `data.shared` store. Both
 *  halves agreed with each other and the test was green. On the server the
 *  write is refused: every shared-storage handler takes only `data.shared.*`
 *  keys. Two shipped Web Watch recipes had the same key, passing a harness that
 *  dry-runs the write. Here nothing between runs is stood in for:
 *
 *  - the recipe is lowered (op steps → kernel ingredients), as install does;
 *  - every kernel call goes through the REAL kernel adapter, with the engine's
 *    step metadata, so it injects `recipe_id` as production does;
 *  - shared writes, reads and lists run the server's own handlers
 *    (`shared-handler.ts`) over a real SQLite store;
 *  - `{{data.shared.*}}` references are prefetched through the same lookup
 *    `execute-handler.ts` wires (`sharedStore.read(key).value`);
 *  - the step cache and its read-fresh classifier are composed as
 *    `execute-handler.ts` composes them, so a cached read would show.
 *
 *  Watchers run through the real dispatcher over whatever the test hands it
 *  (a real collection table, a real calendar cursor store), and keep their own
 *  state in the server's database; the page a page watcher reported settles
 *  with the run as the server settles it. Only what leaves the server (a model
 *  call, a notification) is stood in, by `stand`. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { createInMemoryStore, derivePolicy } from '@recued/cache';
import { resolveDeep, type RecipeDefinition } from '@recued/contracts';
import { executeRecipe, type ExecutionContext, type ExecutionResult, type IngredientExecutor } from '@recued/engine';
import { createKernelAdapter, type KernelDispatchers } from '@recued/ingredients';
import { lowerOpStepRecipe } from '@recued/recipes';

import { KERNEL_MANIFESTS } from '../../kernel-manifests.js';
import {
  handleSharedDelete,
  handleSharedList,
  handleSharedPatch,
  handleSharedRead,
  handleSharedWrite,
} from '../../shared-handler.js';
import { createStepEffect } from '../../step-effect.js';
import { createBlobStore } from '../../storage/blob-store.js';
import { createSharedStore, type SharedStore } from '../../storage/shared-store.js';
import { createWatcherDispatcher, type WatcherDispatcherDeps } from '../../watchers/index.js';
import { httpWatcherRunOutcome, settleHttpWatcherRun } from '../../watchers/http-watcher-memory.js';

export interface ServerRecipePath {
  shared: SharedStore;
  /** One run, as a scheduled check runs it. State persists across runs.
   *  `context` adds to the run's `context.*`, e.g. the `event` an event
   *  trigger hands its recipe (`triggers/event-context.ts`). */
  run(recipe: RecipeDefinition, config?: Record<string, unknown>, context?: Record<string, unknown>): Promise<ExecutionResult & {
    stepResults: Map<string, unknown>;
  }>;
  /** A stored `data.shared.*` record's value, read the way a later run reads it. */
  read(key: string): Promise<unknown>;
  /** Kernel calls that were stood in, in order. */
  stood: Array<{ slug: string; input: Record<string, unknown> }>;
  close(): void;
}

export const createServerRecipePath = (opts: {
  watcher?: Omit<WatcherDispatcherDeps, 'now'>;
  /** More of the server's kernel dispatchers, e.g. a calendar stack's own
   *  (`stack.kernelDispatchers`), so those ops run for real too. */
  dispatchers?: Partial<KernelDispatchers>;
  now?: () => number;
  /** Return a value to stand in for a kernel call that leaves the server. */
  stand?: (slug: string, input: Record<string, unknown>) => unknown;
} = {}): ServerRecipePath => {
  const dir = mkdtempSync(join(tmpdir(), 'server-recipe-path-'));
  const db = new Database(join(dir, 'recued.db'));
  const shared = createSharedStore({ db, blobs: createBlobStore(join(dir, 'blobs')) });
  // Watchers keep their state in the server's database: this one, unless the
  // test hands them its own (a calendar stack's).
  const watcherDb = opts.watcher?.db ?? db;
  const adapter = createKernelAdapter({
    ...(opts.dispatchers ?? {}),
    write: ({ key, value }: { key: string; value: unknown }) => handleSharedWrite({ store: shared }, { key, value }),
    read: ({ key }: { key: string }) => handleSharedRead({ store: shared }, { key }),
    list: ({ prefix }: { prefix: string }) => handleSharedList({ store: shared }, { prefix }),
    patch: (input: Parameters<typeof handleSharedPatch>[1]) => handleSharedPatch({ store: shared }, input),
    delete: ({ key }: { key: string }) => handleSharedDelete({ store: shared }, { key }),
    watcher: createWatcherDispatcher({ ...(opts.watcher ?? {}), db: watcherDb, ...(opts.now ? { now: opts.now } : {}) }),
  } as unknown as KernelDispatchers);
  const manifests = new Map(KERNEL_MANIFESTS.map((manifest) => [manifest.slug, manifest]));
  const stepCacheStore = createInMemoryStore();
  const stood: ServerRecipePath['stood'] = [];
  let runs = 0;

  const run: ServerRecipePath['run'] = async (authored, config = {}, context = {}) => {
    const recipe = lowerOpStepRecipe(authored, new Map());
    const defaults = Object.fromEntries(Object.entries(recipe.variables ?? {}).map(([key, hint]) => {
      const isDefinition = hint !== null && typeof hint === 'object' && !Array.isArray(hint)
        && ('type' in hint || 'label' in hint);
      return [key, isDefinition ? (hint as { default?: unknown }).default : hint];
    }));
    const stores: ExecutionContext['stores'] = {
      vault: {}, config: { ...defaults, ...config }, context: { server: { available: true }, ...context }, meta: {}, step: {},
    };
    // The server caches only its sequential steps' ingredients (`execute-handler.ts`).
    const cached = new Set((recipe.steps ?? [])
      .map((step) => (step as { ingredient?: unknown }).ingredient)
      .filter((slug): slug is string => typeof slug === 'string'));
    const ingredientExecutor: IngredientExecutor = async (slug, input, stepOutput, _options, stepMeta) => {
      const resolved = resolveDeep(input, stores) as Record<string, unknown>;
      const standIn = opts.stand?.(slug, resolved);
      if (standIn !== undefined) {
        stood.push({ slug, input: resolved });
        return standIn;
      }
      const manifest = manifests.get(slug);
      if (manifest === undefined) throw new Error(`${recipe.recipe_id}: no kernel ingredient '${slug}' and no stand-in`);
      return adapter({
        slug, risk_tier: manifest.risk_tier, input: resolved, output: stepOutput ?? {},
        ...(stepMeta === undefined ? {} : { stepMeta }),
      });
    };
    // Each run has its own id, as `execute-handler.ts` mints one, so a page
    // watcher can hold what it reported until the run settles.
    const run_id = `run-${++runs}`;
    const result = await executeRecipe({
      recipe,
      run_id,
      stores,
      ingredientExecutor,
      sharedResolvers: {
        dataShared: { lookup: async (key: string) => (await shared.read(key))?.value ?? null },
      },
      stepCache: {
        store: stepCacheStore,
        ingredientPolicy: (slug: string) => {
          const manifest = manifests.get(slug);
          if (manifest === undefined || !cached.has(slug)) return null;
          const policy = derivePolicy(manifest.category, manifest.risk_tier, recipe.ttl ?? 0);
          return { cacheable: policy.enabled, ttl_seconds: policy.ttl_seconds, category: manifest.category };
        },
        getIngredientVersion: (slug: string) => manifests.get(slug)?.version ?? null,
      },
      stepEffect: createStepEffect((slug) => manifests.get(slug)),
    } as ExecutionContext);
    // Settled as `execute-handler.ts` settles it where it records the run.
    const status = result.awaiting_approval ? 'awaiting_approval'
      : result.awaiting_peer ? 'awaiting_peer'
        : result.success ? 'succeeded' : 'failed';
    settleHttpWatcherRun(watcherDb, run_id, httpWatcherRunOutcome(status, result.trigger_skipped === true));
    return {
      ...result,
      stepResults: new Map(result.steps.map((step) => [step.id, step.result as unknown])),
    };
  };

  return {
    shared,
    run,
    read: async (key) => (await shared.read(key.replace(/^data\.shared\./u, '')))?.value,
    stood,
    close: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
};
