/** D-170 N.4 / N.15 — in-progress ingredient-composition draft store.
 *
 *  The AUTHORING precursor to `ingredient.install`. A draft is a (possibly
 *  incomplete) `CompositionIngredient` the Kitchen / Connection Setup editor
 *  is building; this store persists it per-pair so the author can save, reopen,
 *  preview (N.4 test-before-save), and finally install it.
 *
 *  Mirrors `local-manifest-store.ts`: a plain dedicated SQLite table sharing
 *  the per-pair db (no `contract.*` family, no CAS). A draft body is non-secret
 *  by construction — a composition is a declarative manifest (operation
 *  families + entity fields + groups), never a credential (auth resolves
 *  through vault / connection at call time, exactly as install bodies do), so
 *  plaintext JSON is consistent with the rest of the per-pair db (any
 *  storage-level encryption covers the whole file uniformly).
 *
 *  Two caps bound the table (`@recued/contracts`): a per-body byte cap
 *  (`INGREDIENT_DRAFT_MAX_BYTES`) and a per-pair draft count
 *  (`INGREDIENT_DRAFT_MAX_COUNT`). Both live in contracts so the store and the
 *  wire result codes agree.
 *
 *  Spec: D-170 § N.4 (test-before-save), N.15 (rpc surface). */

import type Database from 'better-sqlite3';
import {
  INGREDIENT_DRAFT_MAX_BYTES,
  INGREDIENT_DRAFT_MAX_COUNT,
  type CompositionSurface,
  type IngredientDraft,
  type IngredientDraftSummary,
} from '@recued/contracts';

const TABLE = 'ingredient_draft';

/** The two non-success outcomes `save` can surface — mapped 1:1 onto the wire
 *  result codes by the rpc handler. */
export type DraftSaveError = 'too_large' | 'limit_reached';

export interface DraftSaveInput {
  /** Omit (or pass an id with no existing row) to create; an existing id
   *  overwrites in place, preserving `created_at`. */
  draft_id?: string;
  title?: string;
  body: unknown;
  /** D-333 — the pack it installs as. Omitted: an existing draft keeps the one it has. */
  pack?: Record<string, unknown>;
}

export interface DraftStore {
  /** Upsert a draft. A NEW draft (id absent / no existing row) generates a
   *  `draft_id` + `created_at`; an overwrite preserves `created_at` and bumps
   *  `updated_at`. Returns the stored draft, or an error sentinel when the
   *  body exceeds `INGREDIENT_DRAFT_MAX_BYTES` (`too_large`) or a NEW draft
   *  would exceed `INGREDIENT_DRAFT_MAX_COUNT` (`limit_reached`). */
  save(input: DraftSaveInput): IngredientDraft | { error: DraftSaveError };
  /** Fetch one draft (full body) by id. null when absent. */
  get(draft_id: string): IngredientDraft | null;
  /** Every draft as a body-free summary, newest-updated first. */
  list(): IngredientDraftSummary[];
  /** Drop a draft by id. Returns true iff a row was removed. */
  delete(draft_id: string): boolean;
  /** D-333 — the draft of changes to an installed pack: the one already open, or a new one
   *  from `body`. One per pack. */
  openForPack(
    pack_slug: string,
    body: unknown,
    title: string,
  ): IngredientDraft | { error: DraftSaveError };
  /** Current draft count (the `limit_reached` denominator). */
  count(): number;
}

export interface DraftStoreOptions {
  /** Epoch-ms clock for `created_at` / `updated_at`. Tests inject a
   *  deterministic stub; production leaves it at `Date.now`. */
  now?: () => number;
  /** Draft-id generator. Tests inject a counter; production leaves it at
   *  `crypto.randomUUID`. */
  newId?: () => string;
}

/** Install the `ingredient_draft` table. Idempotent (`IF NOT EXISTS`); safe on
 *  every boot and from the store factory. */
export const ensureDraftStoreSchema = (db: Database.Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      draft_id   TEXT PRIMARY KEY,
      title      TEXT,
      body_json  TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ingredient_draft_updated_idx ON ${TABLE} (updated_at DESC);
  `);
  // D-333 — a draft can be changes to an installed pack; one such draft per pack.
  const columns = db.prepare(`PRAGMA table_info(${TABLE})`).all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'base_pack_slug')) {
    db.exec(`ALTER TABLE ${TABLE} ADD COLUMN base_pack_slug TEXT`);
  }
  // …and keeps the pack it installs as, so reopening it does not fall back to defaults.
  if (!columns.some((column) => column.name === 'pack_json')) {
    db.exec(`ALTER TABLE ${TABLE} ADD COLUMN pack_json TEXT`);
  }
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ingredient_draft_base_pack
    ON ${TABLE} (base_pack_slug) WHERE base_pack_slug IS NOT NULL`);
};

interface DraftRow {
  draft_id: string;
  title: string | null;
  body_json: string;
  created_at: number;
  updated_at: number;
  base_pack_slug?: string | null;
  pack_json?: string | null;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** Parse a stored body column, returning null on corruption rather than
 *  throwing — a single bad row must not crash a list (mirrors the manifest
 *  store's skip-malformed posture). */
const parseBody = (json: string): unknown => {
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return null;
  }
};

/** Best-effort summary projection off a (possibly incomplete) composition
 *  body — `slug` / `surface` null and `operation_count` 0 when the body can't
 *  supply them. Never throws on a malformed body. */
const summaryOf = (row: DraftRow): IngredientDraftSummary => {
  const body = parseBody(row.body_json);
  const obj = isPlainObject(body) ? body : undefined;
  const slug = typeof obj?.slug === 'string' ? obj.slug : null;
  // D-182 3b — the draft no longer authors a `surface`; derive the coarse label
  // from the primary ingredient's kind (cli → connector; any other kind → api),
  // null when the draft has no ingredient yet. `operation_count` reads the new
  // `operations[]` table.
  const firstIngredient = Array.isArray(obj?.ingredients) && isPlainObject(obj.ingredients[0])
    ? (obj.ingredients[0] as Record<string, unknown>)
    : undefined;
  const surface: CompositionSurface | null = firstIngredient === undefined
    ? null
    : firstIngredient.kind === 'cli'
      ? 'connector'
      : 'api';
  const operation_count = Array.isArray(obj?.operations)
    ? obj.operations.length
    : 0;
  return {
    draft_id: row.draft_id,
    ...(row.title !== null ? { title: row.title } : {}),
    slug,
    surface,
    operation_count,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...(row.base_pack_slug ? { base_pack_slug: row.base_pack_slug } : {}),
  };
};

const packOf = (row: DraftRow): { pack?: Record<string, unknown> } => {
  const pack = row.pack_json ? parseBody(row.pack_json) : null;
  return isPlainObject(pack) ? { pack } : {};
};

const rowToDraft = (row: DraftRow): IngredientDraft => ({
  draft_id: row.draft_id,
  ...(row.title !== null ? { title: row.title } : {}),
  body: parseBody(row.body_json),
  created_at: row.created_at,
  updated_at: row.updated_at,
  ...(row.base_pack_slug ? { base_pack: { pack_slug: row.base_pack_slug } } : {}),
  ...packOf(row),
});

export const createDraftStore = (
  db: Database.Database,
  options: DraftStoreOptions = {},
): DraftStore => {
  ensureDraftStoreSchema(db);
  const now = options.now ?? ((): number => Date.now());
  const newId = options.newId ?? ((): string => crypto.randomUUID());

  const getStmt = db.prepare(
    `SELECT draft_id, title, body_json, created_at, updated_at, base_pack_slug, pack_json FROM ${TABLE} WHERE draft_id = ?`,
  );
  const listStmt = db.prepare(
    `SELECT draft_id, title, body_json, created_at, updated_at, base_pack_slug, pack_json FROM ${TABLE}
       ORDER BY updated_at DESC, draft_id ASC`,
  );
  const byPackStmt = db.prepare(
    `SELECT draft_id, title, body_json, created_at, updated_at, base_pack_slug, pack_json FROM ${TABLE} WHERE base_pack_slug = ?`,
  );
  const setIdentityStmt = db.prepare(`UPDATE ${TABLE} SET pack_json = ? WHERE draft_id = ?`);
  const setPackStmt = db.prepare(`UPDATE ${TABLE} SET base_pack_slug = ? WHERE draft_id = ?`);
  const countStmt = db.prepare(`SELECT COUNT(*) AS n FROM ${TABLE}`);
  const insertStmt = db.prepare(
    `INSERT INTO ${TABLE} (draft_id, title, body_json, created_at, updated_at)
       VALUES (@draft_id, @title, @body_json, @created_at, @updated_at)`,
  );
  const updateStmt = db.prepare(
    `UPDATE ${TABLE}
       SET title = @title, body_json = @body_json, updated_at = @updated_at
       WHERE draft_id = @draft_id`,
  );
  const deleteStmt = db.prepare(`DELETE FROM ${TABLE} WHERE draft_id = ?`);
  const countOf = (): number => (countStmt.get() as { n: number }).n;

  const store: DraftStore = {
    save(input) {
      const bodyJson = JSON.stringify(input.body ?? null);
      // Byte-accurate cap (multi-byte chars count as their UTF-8 length, not
      // their string length) — a draft body is the only unbounded input here.
      if (Buffer.byteLength(bodyJson, 'utf8') > INGREDIENT_DRAFT_MAX_BYTES) {
        return { error: 'too_large' };
      }
      const ts = now();
      const existing = input.draft_id
        ? (getStmt.get(input.draft_id) as DraftRow | undefined)
        : undefined;
      const title = typeof input.title === 'string' ? input.title : null;
      const packJson = input.pack !== undefined ? JSON.stringify(input.pack) : undefined;

      if (existing) {
        updateStmt.run({
          draft_id: existing.draft_id,
          title,
          body_json: bodyJson,
          updated_at: ts,
        });
        if (packJson !== undefined) setIdentityStmt.run(packJson, existing.draft_id);
        return rowToDraft({
          ...existing,
          title,
          body_json: bodyJson,
          updated_at: ts,
          ...(packJson !== undefined ? { pack_json: packJson } : {}),
        });
      }

      // NEW draft — enforce the per-pair count cap (an overwrite above never
      // grows the table, so it is exempt).
      if (countOf() >= INGREDIENT_DRAFT_MAX_COUNT) {
        return { error: 'limit_reached' };
      }
      // Honor a caller-supplied id even when it had no row (idempotent
      // create-with-id); otherwise mint one.
      const draftId = input.draft_id ?? newId();
      insertStmt.run({
        draft_id: draftId,
        title,
        body_json: bodyJson,
        created_at: ts,
        updated_at: ts,
      });
      if (packJson !== undefined) setIdentityStmt.run(packJson, draftId);
      return rowToDraft({
        draft_id: draftId,
        title,
        body_json: bodyJson,
        created_at: ts,
        updated_at: ts,
        ...(packJson !== undefined ? { pack_json: packJson } : {}),
      });
    },
    get(draft_id) {
      const row = getStmt.get(draft_id) as DraftRow | undefined;
      return row ? rowToDraft(row) : null;
    },
    list() {
      return (listStmt.all() as DraftRow[]).map(summaryOf);
    },
    delete(draft_id) {
      return deleteStmt.run(draft_id).changes > 0;
    },
    count() {
      return countOf();
    },
    openForPack(pack_slug, body, title) {
      return db.transaction(() => {
        const open = byPackStmt.get(pack_slug) as DraftRow | undefined;
        if (open !== undefined) return rowToDraft(open);
        const created = store.save({ body, title });
        if ('error' in created) return created;
        setPackStmt.run(pack_slug, created.draft_id);
        return { ...created, base_pack: { pack_slug } };
      }).immediate();
    },
  };
  return store;
};
