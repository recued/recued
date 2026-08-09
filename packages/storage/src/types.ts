/** A typed key-value collection. The minimal storage primitive.
 *  Concrete backends (in-memory, IndexedDB) implement this interface.
 *  Specialized stores (vault, config) wrap a Collection with extra logic.
 */
export interface Collection<V> {
  get(key: string): Promise<V | null>;
  set(key: string, value: V): Promise<void>;
  delete(key: string): Promise<void>;
  has(key: string): Promise<boolean>;
  list(): Promise<V[]>;
  listKeys(): Promise<string[]>;
  /** All entries whose key starts with the given prefix. */
  listByPrefix(prefix: string): Promise<Array<{ key: string; value: V }>>;
  /** Delete all entries whose key starts with the given prefix. Returns count deleted. */
  deleteByPrefix(prefix: string): Promise<number>;
  clear(): Promise<void>;
  size(): Promise<number>;
}

/** OPTIONAL capability: a backend that can filter on top-level fields WITHOUT
 *  materialising every row.
 *
 *  ⛔ WHY THIS EXISTS. `Collection` offers only key-shaped queries
 *  (`listByPrefix` / `deleteByPrefix`), so a store that needs "every row whose
 *  `status` is X" has no choice but `list()` — read every row, JSON-parse every
 *  row, filter in JS. That is O(total) for a question whose answer is usually
 *  tiny. Measured on the D-158 ask store: `countOpen()` — which backs the
 *  "N asks awaiting you" BADGE, i.e. a UI read — cost 1ms at 1k rows, 14ms at
 *  10k, and 51ms at 50k.
 *
 *  ⚠ DELIBERATELY NOT A QUERY LANGUAGE. Equality on top-level fields plus at
 *  most one `<` bound on a numeric field — exactly the retention/lifecycle
 *  shape, nothing more. A general query builder inside a KV primitive would be
 *  a worse thing to own than the full scan it replaces.
 *
 *  ⚠ OPTIONAL BY CONSTRUCTION. In-memory and IndexedDB backings do not
 *  implement it, and every consumer MUST keep a working `list()`-based path.
 *  Use `isFieldQueryable()` to detect. */
export interface FieldQuery {
  /** Top-level field equality. All entries must match. */
  readonly equals?: Readonly<Record<string, string>>;
  /** At most one strict `<` bound on a numeric top-level field. */
  readonly lessThan?: { readonly field: string; readonly value: number };
}

export interface FieldQueryableCollection<V> extends Collection<V> {
  /** Values matching the query. */
  queryByField(spec: FieldQuery): Promise<V[]>;
  /** How many values match — never materialises them. */
  countByField(spec: FieldQuery): Promise<number>;
  /** Delete matching values; returns how many went. */
  deleteByField(spec: FieldQuery): Promise<number>;
  /** Create indexes for the given top-level fields, so the queries above are
   *  bounded by matches rather than by table size. Idempotent. */
  ensureFieldIndexes(fields: readonly string[]): void;
}

/** A keyset window over one bistemporal ordering — the shape a paginated feed
 *  needs so it can stop reading the whole table.
 *
 *  ⛔ WHY THIS EXISTS. `memory.list` (the Data → Memory lens feed) called
 *  `listRecent(Number.MAX_SAFE_INTEGER)` and `userMemoryStore.list()`, then
 *  projected, filtered, sorted and PAGINATED IN JS. Both sources were read
 *  whole on every page request. Measured on real 698 B audit rows: 401ms and
 *  393 MB of heap for one 50-row page at 200k rows, linear — so at the 3.5 GiB
 *  prune trigger (~2.5M rows) it OOMs, which is exactly how the horizon harness
 *  died at 3.1 GB doing this same shape.
 *
 *  ⚠ ORDER + LIMIT + CURSOR ONLY. Filters stay where they are, in JS, so the
 *  feed's semantics do not move — this narrows what is READ, never what
 *  matches. Pushing the filters down too would be faster still and is a
 *  separate, riskier change: getting a paginated cursor subtly wrong shows up
 *  as duplicated or skipped entries, which is worse than slowness. */
export interface OrderedWindowQuery {
  /** JSON path preferred as the sort key when non-null (the EVENT time). */
  readonly tsPath: string;
  /** JSON path used when `tsPath` is null (the INGESTION time). */
  readonly tsFallbackPath: string;
  /** JSON path of the tiebreak id, compared DESC like the timestamp. */
  readonly idPath: string;
  readonly limit: number;
  /** Keyset cursor — return only rows STRICTLY after this in the DESC order. */
  readonly before?: { readonly ts: number; readonly id: string };
}

export interface OrderedWindowCollection<V> extends Collection<V> {
  /** Top-`limit` values by `COALESCE(tsPath, tsFallbackPath) DESC, idPath DESC`,
   *  strictly after `before`. */
  listWindowDesc(query: OrderedWindowQuery): Promise<V[]>;
  /** Index the ordering expression so the window is a seek, not a sort. */
  ensureWindowIndex(query: Pick<OrderedWindowQuery, 'tsPath' | 'tsFallbackPath' | 'idPath'>): void;
}

export const isOrderedWindowQueryable = <V>(
  collection: Collection<V>,
): collection is OrderedWindowCollection<V> =>
  typeof (collection as Partial<OrderedWindowCollection<V>>).listWindowDesc === 'function';

export const isFieldQueryable = <V>(
  collection: Collection<V>,
): collection is FieldQueryableCollection<V> =>
  typeof (collection as Partial<FieldQueryableCollection<V>>).queryByField === 'function'
  && typeof (collection as Partial<FieldQueryableCollection<V>>).countByField === 'function'
  && typeof (collection as Partial<FieldQueryableCollection<V>>).deleteByField === 'function';

/** Encrypted entry shape — the form vault and llm-slot values take in storage. */
export interface EncryptedEntry {
  ciphertext: string;   // base64
  iv: string;           // base64 (96-bit AES-GCM nonce)
  created_at: number;
  updated_at: number;
}

/** Config entry — a single user variable override for a recipe.
 *  Stored under composite key `${recipe_id}::${key}` in the underlying Collection.
 */
export interface ConfigEntry {
  recipe_id: string;
  key: string;
  value: unknown;
  set_at: number;
}
