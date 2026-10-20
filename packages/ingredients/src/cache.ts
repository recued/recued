/** Manifest-aware cache wrapper for ingredient executors.
 *
 *  Uses the canonical cache-key scheme (v1:{slug}@{version}:{hash} — D-103
 *  dropped the leading instance_id so ext + server computing the same
 *  semantic result land on the same key) and the policy module from
 *  @recued/cache. Cache decisions are derived from the ingredient
 *  manifest's category + risk_tier rather than guessed from slug.
 *
 *  Policy (derivePolicy, @recued/cache):
 *    - Action category: NEVER cache (side effects).
 *    - Non-read risk tiers (write/admin/destructive): NEVER cache.
 *    - Read + data/ai: cache with max(recipe_ttl, MIN_TTL[category]) floor.
 *
 *  Step-level freshness (stepOptions.cache):
 *    - `fresh`: bypass cache. Always re-fetch. Neither reads nor writes.
 *    - `acceptable` (default): use cache if within TTL. Standard behavior.
 *    - `any`: serve stale entries regardless of TTL. Enables progressive
 *      render — the UI paints cached-fast, then a separate pass refreshes.
 *
 *  If the manifest can't be loaded, the upstream executor runs uncached —
 *  its own error path gives a clearer diagnosis than returning a stale entry.
 */

import { cacheKey, estimateSize, derivePolicy, type CacheStore } from '@recued/cache';
import { canonicalJSONStringify, type CacheEntry, type IngredientManifest, type StepMeta } from '@recued/contracts';
import { IngredientError, type IngredientExecutor, type ManifestLoader } from './types.js';
import { mergeManifestStepInput, mergeManifestStepOutput } from './dispatch.js';

export type CacheStatus = 'hit' | 'hit_stale' | 'miss' | 'skipped';

export interface CacheStatusContext {
  slug: string;
  /** Cache key when computed; absent for skipped/disabled. */
  key?: string;
  /** Age of the served entry in ms. Present on hit + hit_stale. */
  age_ms?: number;
  /** True when the entry was served past its TTL (freshness='any'). */
  stale?: boolean;
  /** This decision belongs to the single host-approved recovery attempt. */
  retried?: true;
}

export interface IngredientCacheCall {
  slug: string;
  input: Record<string, unknown>;
  manifest: IngredientManifest;
  stepMeta: StepMeta | undefined;
}

export interface IngredientCacheOptions {
  /** Host binding for a resolved call. null bypasses caching when identity is
   * unavailable; undefined keeps the ordinary unscoped cache. Binding errors
   * during lookup bypass caching; validation failures after capture refuse reuse. */
  cacheScope?: (call: IngredientCacheCall) => IngredientCacheScope | null | undefined | Promise<IngredientCacheScope | null | undefined>;
  /** Manifest lookup — the wrapper needs the category + risk_tier and can't
   *  guess them from slug alone. Failures fall through to the raw executor. */
  manifestLoader: ManifestLoader;
  /** Pluggable store. Use createInMemoryStore() for tests. */
  store: CacheStore;
  /** The current recipe's ttl in seconds. The policy applies the MIN_TTL
   *  floor for the manifest's category on top. */
  recipe_ttl: number;
  /** Current recipe id — used to tag entries for per-recipe eviction on
   *  uninstall. */
  recipe_id: string;
  /** Optional storage budget. When set, evictLRU runs after each write. */
  max_bytes?: number;
  /** Clock function — tests override to control expiry. Defaults to Date.now. */
  now?: () => number;
  /** Resolve value references in input before computing the cache key.
   *  When provided, `{{context.url}}` etc. are resolved so different
   *  runtime contexts produce different cache keys. */
  resolveRefs?: (obj: Record<string, unknown>) => Record<string, unknown>;
  /** Observability callback for audit/telemetry. Fired on every call with
   *  the cache decision and, on hits, the age of the served entry. */
  onStatus?: (status: CacheStatus, context: CacheStatusContext) => void;
  /** Host-only, per-call result evidence. Captured before dispatch and checked
   * on reuse; never stored in CacheEntry or sourced from provider payloads.
   * Evidence failures cannot change cache or execution behavior. */
  resultEvidence?: (call: { slug: string; input: Record<string, unknown>; stepMeta: StepMeta | undefined }) => {
    cached(entry: CacheEntry): void;
    stored(entry: CacheEntry): void;
  } | undefined;
}

export interface IngredientCacheScope {
  key: string;
  validate(): void | Promise<void>;
  /** Host context carried only during the actual provider dispatch. */
  run?(dispatch: () => Promise<unknown>): Promise<unknown>;
  /** Private host recovery for this scope's own read-invalidation errors.
   * Return a rebind function only when one retry is safe. The wrapper reloads
   * and resolves the call before rebinding; it never retries a second failure. */
  retry?(error: unknown): ((call: IngredientCacheCall) => Promise<IngredientCacheScope | undefined>) | undefined;
}

export const withIngredientCache = (
  rawExecutor: IngredientExecutor,
  options: IngredientCacheOptions,
): IngredientExecutor => {
  const now = options.now ?? (() => Date.now());
  const emit = (status: CacheStatus, ctx: CacheStatusContext) =>
    options.onStatus?.(status, ctx);

  return async (slug, input, stepOutput, stepOptions, stepMeta) => {
    let evidence: ReturnType<NonNullable<IngredientCacheOptions['resultEvidence']>>;
    try { evidence = options.resultEvidence?.({ slug, input, stepMeta }); } catch { /* optional host metadata */ }
    const reportEvidence = (kind: 'cached' | 'stored', entry: CacheEntry): void => {
      try { evidence?.[kind](entry); } catch { /* optional host metadata */ }
    };
    const touch = async (entry: CacheEntry, at: number): Promise<void> => {
      // A hit updates LRU only. Replacing the row can invalidate private host
      // receipts and needlessly re-encrypt or broadcast an unchanged value.
      if (options.store.touch) await options.store.touch(entry.key, { last_accessed_at: at });
      else await options.store.set({ ...entry, last_accessed_at: at });
    };
    // D-201 — this read is authorized by engine-only recipe/run metadata and
    // a live payload pin, neither of which is part of the authored input (or
    // the canonical cache key). Caching by `event_ref` would therefore let a
    // later run — including a different recipe — receive decoded payload
    // bytes without re-entering the consumer-binding gate. Keep the payload
    // out of L1/peer caches entirely; the engine separately disables L2 for
    // the owner-default-only backing op.
    if (slug === 'webhook-event-get') {
      emit('skipped', { slug });
      return rawExecutor(slug, input, stepOutput, stepOptions, stepMeta);
    }
    // D-201 Slice 6B3 — operation-bound surface dispatches contain a callback
    // injected after recipe admission. A catalog wrapper is top-level read/data
    // even when its selected op mutates, so category-derived L1 policy alone
    // would cache the raw provider request/result. The engine-only sensitive
    // marker makes these calls unconditional pass-throughs.
    if (stepMeta?.surface_dispatch === true
      && stepMeta.surface_dispatch_sensitive === true) {
      emit('skipped', { slug });
      return rawExecutor(slug, input, stepOutput, stepOptions, stepMeta);
    }
    // ⛔ A WRITE IS NEVER SERVED FROM THE CACHE. A catalog wrapper is read/data at
    // the top whatever operation it runs, so the policy below would cache a
    // write too — and the commit gateway, outside this cache, records a hit as
    // done: two identical writes within the TTL reached the provider ONCE. The
    // dispatch carries the operation's own tier; anything but `read` passes.
    if (stepMeta?.surface_dispatch === true
      && stepMeta.surface_risk_tier !== undefined
      && stepMeta.surface_risk_tier !== 'read') {
      emit('skipped', { slug });
      return rawExecutor(slug, input, stepOutput, stepOptions, stepMeta);
    }

    const freshness = stepOptions?.cache ?? 'acceptable';

    // 'fresh' bypasses cache entirely — no read, no write.
    if (freshness === 'fresh') {
      emit('skipped', { slug });
      return rawExecutor(slug, input, stepOutput, stepOptions, stepMeta);
    }

    let manifest;
    try {
      manifest = await options.manifestLoader(slug);
    } catch {
      emit('skipped', { slug });
      return rawExecutor(slug, input, stepOutput, stepOptions, stepMeta);
    }
    if (!manifest) {
      emit('skipped', { slug });
      return rawExecutor(slug, input, stepOutput, stepOptions, stepMeta);
    }

    const policy = derivePolicy(manifest.category, manifest.risk_tier, options.recipe_ttl);
    if (!policy.enabled) {
      emit('skipped', { slug });
      return rawExecutor(slug, input, stepOutput, stepOptions, stepMeta);
    }

    // Merge manifest defaults + step input for the cache key — must match
    // what the dispatch layer sends to the adapter, otherwise different
    // manifest defaults produce the same key from identical step inputs.
    const mergedForKey = { ...(manifest.input ?? {}), ...input };
    const resolvedForKey = options.resolveRefs
      ? options.resolveRefs(mergedForKey)
      : mergedForKey;

    let scope: IngredientCacheScope | null | undefined;
    let scopedInput = resolvedForKey;
    if (options.cacheScope) {
      const merged = mergeManifestStepInput(manifest.input, input, { trustedSurfaceDispatch: stepMeta?.surface_dispatch === true });
      scopedInput = options.resolveRefs ? options.resolveRefs(merged) : merged;
      try { scope = await options.cacheScope({ slug, input: scopedInput, manifest, stepMeta }); }
      catch { scope = null; }
    }
    if (scope === null) {
      emit('skipped', { slug });
      return rawExecutor(slug, input, stepOutput, stepOptions, stepMeta);
    }

    // Entries contain the final adapter result, including output mapping and
    // privacy restoration. Another reader in the recovered generation may use
    // the same provider input with different result semantics. Bind these into
    // scoped keys so neither the first lookup nor recovery can reuse its value.
    const resultIdentity = scope ? canonicalJSONStringify([
      mergeManifestStepOutput(manifest.output, stepOutput), manifest.fallback ?? null,
      [...new Set(stepOptions?.pii_fields ?? [])].sort(),
    ]) : undefined;

    // A retry must keep output mappings and privacy options as well as inputs.
    let retryArguments: string | undefined;
    let retryManifest: string | undefined;
    let retryInput: string | undefined;
    if (scope?.retry) {
      try {
        retryArguments = canonicalJSONStringify([stepOutput ?? null, stepOptions ?? null]);
        retryManifest = canonicalJSONStringify(manifest);
        retryInput = canonicalJSONStringify(scopedInput);
      } catch { retryArguments = undefined; /* Unpinnable host options disable recovery. */ }
    }
    const inputChanged = () => new IngredientError('CONNECTION_REFUSED',
      'The read arguments changed while refreshing cached data. Review them and try again.',
      { reason: 'cache_input_changed' });
    const validateArguments = () => {
      if (retryArguments !== undefined
        && canonicalJSONStringify([stepOutput ?? null, stepOptions ?? null]) !== retryArguments) throw inputChanged();
    };
    const attempt = async (scope: IngredientCacheScope | undefined, retried = false) => {
      const validateRetryInput = () => {
        if (!retried) return;
        const merged = mergeManifestStepInput(manifest.input, input, { trustedSurfaceDispatch: stepMeta?.surface_dispatch === true });
        const resolved = options.resolveRefs ? options.resolveRefs(merged) : merged;
        if (canonicalJSONStringify(resolved) !== retryInput) throw inputChanged();
      };
      const validate = async () => {
        validateArguments();
        validateRetryInput();
        if (scope) await scope.validate();
        validateArguments();
        validateRetryInput();
      };
      const manifest_version = String(manifest.version ?? 0);
      const key = await cacheKey({
        ingredient_slug: slug,
        manifest_version,
        inputs: scope ? scopedInput : resolvedForKey,
        ...(scope ? { scope: canonicalJSONStringify(['ingredient-result-v1', scope.key, resultIdentity]) } : {}),
      });

      await validate();
      const cached = await options.store.get(key);
      await validate();
      const currentTime = now();

      // A peer or custom store may return an entry for a different key. Scoped
      // reads never accept that entry as proof of the requested host identity.
      if (cached && (!scope || cached.key === key)) {
        const age_ms = currentTime - cached.created_at;
        const fresh = cached.expires_at > currentTime;

        // Fresh hit on any freshness mode except 'fresh' (handled above).
        if (fresh) {
          await touch(cached, currentTime);
          await validate();
          emit('hit', { slug, key, age_ms, stale: false, ...(retried ? { retried: true as const } : {}) });
          await validate();
          return { value: cached.value, entry: cached, kind: 'cached' as const };
        }

        // Expired entry — serve only under 'any' freshness.
        if (freshness === 'any') {
          await touch(cached, currentTime);
          await validate();
          emit('hit_stale', { slug, key, age_ms, stale: true, ...(retried ? { retried: true as const } : {}) });
          await validate();
          return { value: cached.value, entry: cached, kind: 'cached' as const };
        }

        // 'acceptable' + expired → fall through to miss path.
      }

      emit('miss', { slug, key, ...(retried ? { retried: true as const } : {}) });
      const dispatch = () => {
        validateArguments();
        validateRetryInput();
        return rawExecutor(slug, input, stepOutput, stepOptions, stepMeta);
      };
      const value = await (scope?.run ? scope.run(dispatch) : dispatch());
      await validate();

      const entry: CacheEntry = {
        key,
        value,
        expires_at: currentTime + policy.ttl_seconds * 1000,
        recipe_id: options.recipe_id,
        ingredient_slug: slug,
        size_bytes: estimateSize(value),
        created_at: currentTime,
        last_accessed_at: currentTime,
        category: manifest.category,
        risk_tier: manifest.risk_tier,
      };
      await options.store.set(entry);
      await validate();

      if (options.max_bytes !== undefined) {
        await options.store.evictLRU(options.max_bytes);
      }

      await validate();
      return { value, entry, kind: 'stored' as const };
    };

    let result: Awaited<ReturnType<typeof attempt>>;
    try {
      result = await attempt(scope);
    } catch (error) {
      const rebind = scope?.retry?.(error);
      if (!rebind || retryArguments === undefined) throw error;
      const prepareRetry = async (): Promise<IngredientCacheCall> => {
        validateArguments();
        const current = await options.manifestLoader(slug);
        validateArguments();
        if (!current || !derivePolicy(current.category, current.risk_tier, options.recipe_ttl).enabled
          || stepMeta?.surface_dispatch === true && (stepMeta.surface_dispatch_sensitive === true
            || stepMeta.surface_risk_tier !== undefined && stepMeta.surface_risk_tier !== 'read')) throw error;
        if (canonicalJSONStringify(current) !== retryManifest) {
          throw new IngredientError('CONNECTION_REFUSED',
            'The read operation changed while refreshing cached data. Review it and try again.',
            { reason: 'cache_operation_changed' });
        }
        const merged = mergeManifestStepInput(current.input, input, { trustedSurfaceDispatch: stepMeta?.surface_dispatch === true });
        const resolved = options.resolveRefs ? options.resolveRefs(merged) : merged;
        if (canonicalJSONStringify(resolved) !== retryInput) throw inputChanged();
        return { slug, input: resolved, manifest: current, stepMeta };
      };
      const refreshed = await rebind(await prepareRetry());
      if (!refreshed) throw error;
      // A pending-write wait can outlive mutable recipe context or manifest
      // updates. Recheck before either a recovered hit or another provider call.
      await prepareRetry();
      result = await attempt(refreshed, true);
    }
    // Discarded attempts never attest a result or poison a later fresh result's
    // private provenance. No asynchronous cache work follows this notification.
    validateArguments();
    reportEvidence(result.kind, result.entry);
    return result.value;
  };
};
