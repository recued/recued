/** Local ingredient registry — CRUD for user-created/forked ingredient manifests.
 *
 *  Mirrors the InstallRegistry pattern for recipes: pluggable interface
 *  with in-memory + IDB implementations. Ingredients are keyed by `slug`
 *  (globally unique for marketplace, `local/*` for user-created).
 *
 *  The manifest loader chain checks this registry BEFORE the bundled
 *  loader, so a local ingredient with slug `hubspot-catalog` can
 *  override the marketplace version (fork-and-edit flow).
 */

import type { IngredientManifest } from '@recued/contracts';
import type { Collection } from '@recued/storage';

// ────────────────────────────────────────────────────────────────
// Interface
// ────────────────────────────────────────────────────────────────

export interface IngredientRegistry {
  /** List all locally stored ingredient manifests. */
  listLocal(): Promise<IngredientManifest[]>;
  /** Get a single manifest by slug, or null if not stored locally. */
  getLocal(slug: string): Promise<IngredientManifest | null>;
  /** Save (create or update) a manifest. Upsert semantics by slug. */
  saveLocal(manifest: IngredientManifest): Promise<void>;
  /** Delete a locally stored manifest. Idempotent. */
  deleteLocal(slug: string): Promise<void>;
  /** Number of locally stored manifests. */
  size(): Promise<number>;
}

// ────────────────────────────────────────────────────────────────
// In-memory implementation (tests)
// ────────────────────────────────────────────────────────────────

export const createInMemoryIngredientRegistry = (): IngredientRegistry => {
  const store = new Map<string, IngredientManifest>();
  return {
    async listLocal() { return [...store.values()]; },
    async getLocal(slug) { return store.get(slug) ?? null; },
    async saveLocal(manifest) { store.set(manifest.slug, manifest); },
    async deleteLocal(slug) { store.delete(slug); },
    async size() { return store.size; },
  };
};

// ────────────────────────────────────────────────────────────────
// IDB-backed implementation (extension production)
// ────────────────────────────────────────────────────────────────

export interface IDBIngredientRegistryOptions {
  dbName?: string;
  indexedDB?: IDBFactory;
}

export const createIDBIngredientRegistry = (
  options: IDBIngredientRegistryOptions = {},
): IngredientRegistry => {
  // Lazy import to avoid pulling IDB code in test environments
  // that don't have indexedDB. The import is dynamic but cached
  // after first call.
  let collectionPromise: Promise<Collection<IngredientManifest>> | null = null;

  const getCollection = (): Promise<Collection<IngredientManifest>> => {
    if (!collectionPromise) {
      collectionPromise = (async () => {
        const { createIDBCollection } = await import('@recued/storage');
        return createIDBCollection<IngredientManifest>({
          dbName: options.dbName ?? 'recued-local-ingredients',
          indexedDB: options.indexedDB,
        });
      })();
    }
    return collectionPromise;
  };

  return {
    async listLocal() {
      const col = await getCollection();
      return col.list();
    },
    async getLocal(slug) {
      const col = await getCollection();
      return col.get(slug);
    },
    async saveLocal(manifest) {
      const col = await getCollection();
      await col.set(manifest.slug, manifest);
    },
    async deleteLocal(slug) {
      const col = await getCollection();
      await col.delete(slug);
    },
    async size() {
      const col = await getCollection();
      return col.size();
    },
  };
};
