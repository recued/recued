/** D-170 — local manifest body store (N.14 / N.16).
 *
 *  Persists the bodies a composition decomposes into so the gateway can resolve
 *  locally-authored capabilities. A composition decomposes to either a single
 *  ingredient (1×1) or a catalog + N entity schemas; this store holds the
 *  resolvable manifest (catalog / ingredient) AND the entity schemas as one
 *  artifact keyed by `(slug, version)`.
 *
 *  Two consumers, two read shapes:
 *    - `getManifest(slug)` / `listManifests()` feed the LIVE manifest registry
 *      (`executorConfig.manifests`) so the gateway dispatches the catalog's
 *      operations exactly as for a marketplace ingredient (N.16). The catalog /
 *      ingredient manifest is the only thing the gateway dispatch registry loads.
 *    - `getEntitySchemas(slug)` feeds the D-167 PII egress path:
 *      `createMetaFieldPrivacyResolverFromLocalManifestStore` reads these rows'
 *      `MetaField.privacy` tags live per egress packet to alias outbound PII
 *      (activation `93fa73ba`). No manifest registry loads them — the egress
 *      resolver is their consumer, reading the store directly per packet.
 *
 *  Versioning. Keyed `(slug, version)`; unpinned reads return the HIGHEST
 *  version. Pinned reads return exactly that `(slug, version)` row, or `null`
 *  on mismatch. The v1 decomposer always emits `version: 1` (N.9's version-bump
 *  is a later slice), so today there is one row per slug — the (slug, version)
 *  key is forward-compat for when the composition version (= pack version)
 *  bumps.
 *
 *  Bodies are non-secret by construction — D-170 manifests never carry literal
 *  secrets (N.6: `ENGINE_LOCKED_INPUT_KEYS` / `CATALOG_FORBIDDEN_CUSTOM_HEADERS`
 *  are validator-enforced; auth resolves through vault / connection at call
 *  time). So plaintext JSON, consistent with the `contract_store` table (any
 *  storage-level encryption covers the whole db uniformly).
 *
 *  N.14 is explicit that the local path needs NO new `contract.*` family and NO
 *  CAS-by-hash — this is a plain dedicated table.
 *
 *  Spec: D-170 § N.14 (storage), N.16 (gateway resolution). */

import type Database from 'better-sqlite3';
import type { EntitySchemaIngredientInput, IngredientManifest } from '@recued/contracts';

const TABLE = 'local_manifest';

/** One stored authored artifact: the resolvable catalog / ingredient manifest +
 *  the entity schemas the composition decomposed into. */
export interface StoredAuthoredArtifact {
  manifest: IngredientManifest;
  entity_schemas: EntitySchemaIngredientInput[];
}

export interface LocalManifestStore {
  /** Upsert an artifact keyed `(manifest.slug, manifest.version)`. A re-install
   *  at the same version overwrites in place; a bumped version adds a row. */
  put(artifact: StoredAuthoredArtifact): void;
  /** Resolve a manifest for a slug — unpinned returns the current
   *  (highest-version) body the gateway registry serves; pinned returns only an
   *  exact `(slug, version)` match. null when absent or version-mismatched. */
  getManifest(slug: string, version?: number): IngredientManifest | null;
  /** Entity schemas for a slug — unpinned reads the current artifact; pinned
   *  reads only an exact `(slug, version)` match. `[]` when absent, version-
   *  mismatched, or when the artifact decomposed to a 1×1 ingredient. */
  getEntitySchemas(slug: string, version?: number): EntitySchemaIngredientInput[];
  /** Every current-version manifest — the boot-preload source for the live
   *  manifest registry. Deterministic order (slug asc). */
  listManifests(): IngredientManifest[];
  /** All slugs with at least one stored version (slug asc). */
  slugs(): string[];
  /** Drop EVERY version of a slug. Returns true iff ≥1 row was removed. */
  delete(slug: string): boolean;
}

/** Install the local_manifest table. Idempotent (`IF NOT EXISTS`); safe on
 *  every boot and from the store factory. */
export const ensureLocalManifestStoreSchema = (db: Database.Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      slug                TEXT NOT NULL,
      version             INTEGER NOT NULL,
      manifest_json       TEXT NOT NULL,
      entity_schemas_json TEXT NOT NULL,
      PRIMARY KEY (slug, version)
    );
    CREATE INDEX IF NOT EXISTS local_manifest_slug_idx ON ${TABLE} (slug);
  `);
};

interface ManifestRow {
  slug: string;
  version: number;
  manifest_json: string;
  entity_schemas_json: string;
}

/** Parse a stored manifest JSON column, returning null on corruption rather
 *  than throwing — a single bad row must not crash the boot preload (mirrors
 *  the manifest-loader's skip-malformed posture). */
const parseManifest = (json: string): IngredientManifest | null => {
  try {
    return JSON.parse(json) as IngredientManifest;
  } catch {
    return null;
  }
};

const parseEntitySchemas = (json: string): EntitySchemaIngredientInput[] => {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as EntitySchemaIngredientInput[]) : [];
  } catch {
    return [];
  }
};

export const createLocalManifestStore = (db: Database.Database): LocalManifestStore => {
  ensureLocalManifestStoreSchema(db);

  const putStmt = db.prepare(
    `INSERT INTO ${TABLE} (slug, version, manifest_json, entity_schemas_json)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (slug, version) DO UPDATE SET
         manifest_json       = excluded.manifest_json,
         entity_schemas_json = excluded.entity_schemas_json`,
  );
  // Highest-version row for one slug.
  const getCurrentStmt = db.prepare(
    `SELECT slug, version, manifest_json, entity_schemas_json FROM ${TABLE}
       WHERE slug = ? ORDER BY version DESC LIMIT 1`,
  );
  const getExactStmt = db.prepare(
    `SELECT slug, version, manifest_json, entity_schemas_json FROM ${TABLE}
       WHERE slug = ? AND version = ? LIMIT 1`,
  );
  // Every row, ordered so a JS dedup keeping the LAST seen per slug yields the
  // highest version per slug (ASC version → last is max).
  const allStmt = db.prepare(
    `SELECT slug, version, manifest_json, entity_schemas_json FROM ${TABLE}
       ORDER BY slug ASC, version ASC`,
  );
  const slugsStmt = db.prepare(
    `SELECT DISTINCT slug FROM ${TABLE} ORDER BY slug ASC`,
  );
  const deleteStmt = db.prepare(`DELETE FROM ${TABLE} WHERE slug = ?`);

  /** Current (highest-version) manifests, one per slug, slug-asc. */
  const currentManifests = (): IngredientManifest[] => {
    const bySlug = new Map<string, IngredientManifest>();
    for (const row of allStmt.all() as ManifestRow[]) {
      const manifest = parseManifest(row.manifest_json);
      if (manifest) bySlug.set(row.slug, manifest); // ASC order → last write wins = max version
    }
    return [...bySlug.values()];
  };

  return {
    put(artifact) {
      putStmt.run(
        artifact.manifest.slug,
        artifact.manifest.version,
        JSON.stringify(artifact.manifest),
        JSON.stringify(artifact.entity_schemas),
      );
    },
    getManifest(slug, version) {
      const row = version === undefined
        ? getCurrentStmt.get(slug) as ManifestRow | undefined
        : getExactStmt.get(slug, version) as ManifestRow | undefined;
      return row ? parseManifest(row.manifest_json) : null;
    },
    getEntitySchemas(slug, version) {
      const row = version === undefined
        ? getCurrentStmt.get(slug) as ManifestRow | undefined
        : getExactStmt.get(slug, version) as ManifestRow | undefined;
      return row ? parseEntitySchemas(row.entity_schemas_json) : [];
    },
    listManifests() {
      return currentManifests();
    },
    slugs() {
      return (slugsStmt.all() as Array<{ slug: string }>).map((r) => r.slug);
    },
    delete(slug) {
      return deleteStmt.run(slug).changes > 0;
    },
  };
};
