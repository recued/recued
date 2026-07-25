/** D-164 P4g-1 — bundle pool: recued.com hash-pinned templates,
 *  in-memory source.
 *
 *  `createBundlePool({entries})` validates each entry at construction
 *  time and exposes the surviving set as a `TemplatePool` the library
 *  consumes alongside the audit-grown pool (P4h). The pool's `name` is
 *  `'bundle'` so diagnostics + the library's pool-iteration order log
 *  unambiguously which source returned a match.
 *
 *  **Server-only.** This module imports `node:crypto` via
 *  `./hash.ts` for the SHA-256 content-addressing digest. The
 *  `prompt-cache` package is server-side per design (D-148 P12 — "no
 *  client-side execution"); browser apps must not import the bundle
 *  surface. The `templates/index.ts` barrel re-exports bundle types
 *  for the boot path's convenience, but the boot path is server-only
 *  too.
 *
 *  Source contract (P4g-1 scope: in-memory only):
 *    - `entries: BundleEntryInput[]` — caller-supplied list of
 *      `{ template, locale }` pairs. Production wires this from the
 *      eventual HTTP-fetched manifest (P4g-2); tests inject synthetic
 *      entries directly.
 *    - **Aggregate validation.** The factory runs `validateBundleEntry`
 *      over every entry and collects ALL failures before deciding. If
 *      any entry is invalid, it throws `BundlePoolError` carrying the
 *      full per-entry failure list — registration surfaces every
 *      problem at once instead of fail-on-first. Unexpected throws
 *      from the validator (programming bugs) are caught per-entry +
 *      surfaced as `entry_unprocessable` so one bad entry can't abort
 *      the iteration and hide later failures.
 *    - **Empty entries is valid.** A bundle pool with no entries
 *      returns `[]` from `list()`; the library iterates and returns
 *      `null` from `match()`. Useful for tests that want the bundle
 *      pool registered but inert.
 *    - **Frozen entries.** Accepted entries are deep-frozen: the
 *      returned array, each entry object, each template, and each
 *      template's `slot_grammar` array are all `Object.freeze`'d.
 *      The library + the gate must never mutate the snapshot they
 *      receive (defense in depth — even if the library type-system
 *      contract weren't `readonly`).
 *
 *  Why throw at construction time vs returning a result type: pool
 *  construction is a server-boot step (P5/P6 wiring), not a
 *  per-request operation. Boot failures should crash loudly so the
 *  operator sees the bad fixture immediately; returning a result
 *  type would let the runtime silently start with an empty pool +
 *  no signal that templates went missing.
 *
 *  Out of scope for P4g-1 (future slices):
 *    - HTTP fetch from recued.com (`./fetch.ts`) — P4g-2.
 *    - On-disk persistence + content-addressed cache (`./store.ts`) —
 *      P4g-2 or P4g-3.
 *    - Refresh poller (`./poller.ts`) — P4g-3.
 *    - Lookup key composition (`./lookup.ts`) — currently the library
 *      iterates all entries + matches by slot grammar; lookup-table
 *      pre-filtering becomes interesting once entry counts grow.
 *
 *  See: D-164
 *  § 1 templates/bundle / § 3 the deterministic gate. */

import type { RegisteredTemplate, TemplatePool } from '../library.js';
import type { RenderTemplate } from '../../types.js';

import {
  validateBundleEntry,
  type BundleEntryInput,
  type BundleInvalidReason,
} from './validate.js';
import {
  BundleFetchError,
  type BundleFetcher,
  type BundleManifest,
} from './fetch.js';
import type { BundleStore } from './store.js';

export {
  validateBundleEntry,
  type BundleEntryInput,
  type BundleValidation,
  type BundleInvalidReason,
} from './validate.js';

export {
  computeBundleEntryHash,
  type BundleHashInput,
} from './hash.js';

export {
  BundleFetchError,
  createHttpBundleFetcher,
  parseBundleManifest,
  type BundleFetcher,
  type BundleFetchErrorReason,
  type BundleManifest,
  type CreateHttpBundleFetcherOptions,
  type HttpClient,
} from './fetch.js';

export {
  createFileBundleStore,
  type BundleStore,
  type CreateFileBundleStoreOptions,
} from './store.js';

export {
  defaultScheduler,
  startBundlePoller,
  type BundlePollerHandle,
  type PollerScheduler,
  type StartBundlePollerOptions,
} from './poller.js';

/** Stable pool-name string the library exposes in its iteration order
 *  diagnostics. Exported so callers (boot wiring, tests) can match on
 *  the literal rather than re-typing the string. */
export const BUNDLE_POOL_NAME = 'bundle';

/** Reasons surfaced via `BundlePoolError.failures`. Includes every
 *  `BundleInvalidReason` plus the pool-factory-owned `entry_unprocessable`
 *  for unexpected validator throws. */
export type BundlePoolFailureReason = BundleInvalidReason | 'entry_unprocessable';

/** Per-entry failure record carried in the aggregate error. The
 *  ordinal `index` is the entry's position in the caller's input
 *  array — the same caller can correlate failures back to source
 *  data without re-running the validator. */
export interface BundlePoolEntryFailure {
  readonly index: number;
  readonly reason: BundlePoolFailureReason;
  readonly detail: string;
}

/** Thrown by `createBundlePool` when one or more entries fail
 *  validation. Carries every failure; the caller decides how to
 *  surface (boot log, structured trace, etc.). The free-form
 *  `message` is a per-failure summary capped at `MESSAGE_MAX_FAILURES`
 *  rendered rows so unbounded failure lists don't blow log lines. */
export class BundlePoolError extends Error {
  readonly failures: ReadonlyArray<BundlePoolEntryFailure>;

  constructor(failures: ReadonlyArray<BundlePoolEntryFailure>) {
    super(buildBundlePoolErrorMessage(failures));
    this.name = 'BundlePoolError';
    this.failures = failures;
  }
}

/** Max per-failure rows rendered into the human message. Failures
 *  beyond this count get a trailing `... and N more` summary; the
 *  full list always lives on `error.failures`. */
const MESSAGE_MAX_FAILURES = 10;

const buildBundlePoolErrorMessage = (
  failures: ReadonlyArray<BundlePoolEntryFailure>,
): string => {
  const shown = failures.slice(0, MESSAGE_MAX_FAILURES);
  const lines = shown.map((f) => `  [${f.index}] ${f.reason}: ${JSON.stringify(f.detail)}`);
  const overflow = failures.length - shown.length;
  if (overflow > 0) lines.push(`  ... and ${overflow} more`);
  const header = `bundle pool: ${failures.length} invalid entr${failures.length === 1 ? 'y' : 'ies'}`;
  return `${header}\n${lines.join('\n')}`;
};

export interface CreateBundlePoolOptions {
  readonly entries: ReadonlyArray<BundleEntryInput>;
}

/** Deep-freeze an accepted entry — array → entry object → template →
 *  template's `slot_grammar`. The library + gate receive a fully-
 *  immutable snapshot. */
const freezeEntry = (
  template: RenderTemplate,
  locale: string,
): RegisteredTemplate => {
  const grammarCopy: ReadonlyArray<RenderTemplate['slot_grammar'][number]> =
    Object.freeze([...template.slot_grammar]);
  const frozenTemplate = Object.freeze({
    ...template,
    slot_grammar: grammarCopy,
  });
  return Object.freeze({ template: frozenTemplate, locale });
};

/** Wrap a `BundleStore` as a `BundleFetcher` so `loadBundlePool` can
 *  build the pool from disk without re-fetching upstream. Production
 *  wiring at boot:
 *    ```ts
 *    const store = await createFileBundleStore({ path: cachePath });
 *    const upstream = createHttpBundleFetcher({ url: manifestUrl });
 *    const poller = startBundlePoller({ fetcher: upstream, store, intervalMs });
 *    await poller.firstTick;
 *    const pool = await loadBundlePool({ fetcher: createStoreBackedFetcher({ store }) });
 *    ```
 *  The first tick populates the store from upstream; if upstream is
 *  reachable, the pool builds from the fresh manifest; if upstream
 *  fails but the store has a prior cache, the pool builds from disk;
 *  if both are empty, `loadBundlePool` throws `BundleFetchError`
 *  (`network_error`) and the boot decides how to proceed.
 *
 *  The adapter is synchronous + stateless — every `fetchManifest()`
 *  reads the store's latest `current()`. Subsequent poller writes
 *  affect *future* `loadBundlePool` builds; the existing pool's
 *  entries stay frozen for its lifetime (rebuild is the caller's
 *  responsibility — bundle subscribers + live rebuild are out of
 *  scope for P4g-3). */
export interface CreateStoreBackedFetcherOptions {
  readonly store: BundleStore;
}

export const createStoreBackedFetcher = (
  options: CreateStoreBackedFetcherOptions,
): BundleFetcher => ({
  async fetchManifest(): Promise<BundleManifest> {
    const cached = options.store.current();
    if (cached === null) {
      throw new BundleFetchError({
        reason: 'cache_empty',
        detail: 'bundle store is empty — call poller.firstTick or store.put before building the pool',
      });
    }
    return cached;
  },
});

export interface LoadBundlePoolOptions {
  /** The fetcher to source the manifest from. Production wires this
   *  to `createHttpBundleFetcher({ url: '<recued.com manifest URL>' })`;
   *  tests pass a synthetic fetcher returning an in-memory manifest. */
  readonly fetcher: BundleFetcher;
}

/** Load + construct a bundle pool from a `BundleFetcher`. Fetches
 *  the manifest, hands the entries to `createBundlePool`, and returns
 *  the validated `TemplatePool`.
 *
 *  Error surfaces:
 *    - `BundleFetchError` — manifest fetch / parse / schema failure.
 *      The fetcher already wraps every failure mode; this helper
 *      re-throws unchanged.
 *    - `BundlePoolError` — one or more entries failed per-template
 *      validation (kind / action_class / body / forbidden_path /
 *      hash mismatch). Both error classes carry structured failure
 *      lists so the boot path can render either as a single log line
 *      + a structured detail trace.
 *
 *  Why this lives next to `createBundlePool`: the two functions share
 *  the same `BundleEntryInput[]` contract; gluing them in a separate
 *  module would just add an import hop. Tests use both layers
 *  independently — `loadBundlePool` for the async + integration path,
 *  `createBundlePool` for synchronous + per-entry coverage. */
export const loadBundlePool = async (
  options: LoadBundlePoolOptions,
): Promise<TemplatePool> => {
  const manifest = await options.fetcher.fetchManifest();
  return createBundlePool({ entries: manifest.entries });
};

/** Construct the in-memory bundle pool. Validates every entry; throws
 *  `BundlePoolError` on any failure. Successful return → a deep-frozen
 *  list of `RegisteredTemplate` exposed via the `TemplatePool`
 *  contract. */
export const createBundlePool = (
  options: CreateBundlePoolOptions,
): TemplatePool => {
  const accepted: RegisteredTemplate[] = [];
  const failures: BundlePoolEntryFailure[] = [];

  options.entries.forEach((entry, index) => {
    let result;
    try {
      result = validateBundleEntry(entry);
    } catch (err) {
      failures.push({
        index,
        reason: 'entry_unprocessable',
        detail: `validator threw: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }
    if (result.kind === 'invalid') {
      failures.push({ index, reason: result.reason, detail: result.detail });
      return;
    }
    accepted.push(freezeEntry(result.entry.template, result.entry.locale));
  });

  if (failures.length > 0) throw new BundlePoolError(failures);

  const frozen = Object.freeze([...accepted]);
  return {
    name: BUNDLE_POOL_NAME,
    list: () => frozen,
  };
};
