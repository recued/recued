/** D-219 — which learned cases the owner has already turned into a recipe.
 *
 *  ⛔ **A SEPARATE TABLE, BECAUSE A CASE ROW IS A PROJECTION.** `execution_cases`
 *  is re-derived from the source observations by `rebuildMaterialized`, which
 *  runs on every compile, every forget and every compiler-version change — a
 *  marker written onto the case row would be silently wiped by the next rebuild.
 *  This is the only place such a fact can live.
 *
 *  ⛔⛔ **KEYED ON `case_key`, NEVER ON `case_id`.** `case_id` is
 *  `hash(case_key, compiler_version)` (`execution-case-core.ts`), so it CHANGES
 *  ON EVERY COMPILER BUMP — the corpus has already moved V15 → V18 → V19 → V20,
 *  and a link keyed on `case_id` would orphan itself at each one, silently.
 *  `case_key` is `hash(contract, principal, request_shape_hash,
 *  policy_fingerprint)`: stable across compiler versions, and stable across
 *  forget-then-relearn, which is the other reason it is the right identity.
 *
 *  ⚠ **NO EXPLICIT INDEX, EVER.** `d-214-execution-case-integration` ratchets
 *  that nothing matching `%execution_case%` carries an index other than
 *  `sqlite_autoindex%`, or any FTS/virtual table — A22, pending the D-213 §6.4
 *  bar. The composite PRIMARY KEY below is satisfied by an autoindex, which the
 *  ratchet exempts; `case_key` is a hash carrying no prompt text and is already
 *  a plaintext UNIQUE column on `execution_cases`, so this adds no exposure
 *  class. Do not add a `CREATE INDEX` here to make a read faster.
 *
 *  ⚠ Plaintext by design: a recipe id and a content hash are not user text.
 *  Nothing in this table needs the realm key, which is also why a forget does
 *  not have to reach into it.
 */

import type Database from 'better-sqlite3';

export interface AuthoredRecipeLink {
  /** The DURABLE case identity — see the header. */
  case_key: string;
  recipe_id: string;
  /** The recipe's content hash AT THE MOMENT IT WAS SAVED. Lets a surface tell
   *  "the recipe you made from this" from "a recipe of that name today", which
   *  is the same distinction `loadRecipeShape` already makes. */
  recipe_hash: string;
  authored_at: number;
}

export const ensureExecutionCaseAuthoredSchema = (
  db: Database.Database,
): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS execution_case_authored (
      case_key     TEXT NOT NULL,
      recipe_id    TEXT NOT NULL,
      recipe_hash  TEXT NOT NULL,
      authored_at  INTEGER NOT NULL,
      PRIMARY KEY (case_key, recipe_id)
    );
    CREATE TABLE IF NOT EXISTS execution_case_drafted (
      case_key    TEXT PRIMARY KEY,
      drafted_at  INTEGER NOT NULL
    );
  `);
};

export interface ExecutionCaseAuthoredStore {
  /** ⛔ THE PROVENANCE GUARD. Recorded when the server actually issues a draft
   *  for a case, and required before an authored link will be accepted.
   *
   *  Without it `chat.execution.authored` verified only that a case and a recipe
   *  each EXIST — so a paired script could pair any case with any unrelated
   *  recipe and Settings would report it as authored from it. Protecting the
   *  key and hash VALUES was never protecting the RELATIONSHIP.
   *
   *  ⛔ Stored AT THE CASE, not carried in the Kitchen draft. The stash is
   *  `sessionStorage` — it dies with the tab — so a token routed through it
   *  would cost the owner the annotation on any refresh. The case outlives the
   *  draft, so the fact belongs here.
   *
   *  ⚠ NOT one-shot: the owner may edit and save repeatedly, and each save is
   *  the same authored thing at a new hash. It proves a draft was PAID FOR for
   *  this case, which is the part a script cannot fake. */
  recordDraftIssued(case_key: string, drafted_at: number): void;
  wasDrafted(case_key: string): boolean;
  /** Idempotent per (case_key, recipe_id): saving the same recipe again from the
   *  same case updates the hash and the time rather than accumulating rows. The
   *  owner did not author a second thing. */
  record(link: AuthoredRecipeLink): void;
  listForKey(case_key: string): AuthoredRecipeLink[];
  /** Bulk read for the owner-facing list, so rendering N cases is one query
   *  rather than N. ⚠ Returns a Map keyed by `case_key`; a key with no links is
   *  simply absent. */
  listForKeys(case_keys: readonly string[]): Map<string, AuthoredRecipeLink[]>;
  /** Drops every link for a case. ⚠ NOT called by forget — see the module
   *  header on why a forget leaves these alone. Exposed for a retention pass
   *  and for tests. */
  deleteForKey(case_key: string): number;
}

export const createExecutionCaseAuthoredStore = (
  db: Database.Database,
): ExecutionCaseAuthoredStore => {
  ensureExecutionCaseAuthoredSchema(db);
  const upsert = db.prepare(`
    INSERT INTO execution_case_authored
      (case_key, recipe_id, recipe_hash, authored_at)
    VALUES (@case_key, @recipe_id, @recipe_hash, @authored_at)
    ON CONFLICT(case_key, recipe_id) DO UPDATE SET
      recipe_hash = excluded.recipe_hash,
      authored_at = excluded.authored_at
  `);
  const selectForKey = db.prepare(`
    SELECT case_key, recipe_id, recipe_hash, authored_at
      FROM execution_case_authored
     WHERE case_key = ?
     ORDER BY authored_at ASC, recipe_id ASC
  `);
  const deleteForKey = db.prepare(
    'DELETE FROM execution_case_authored WHERE case_key = ?',
  );

  const upsertDrafted = db.prepare(`
    INSERT INTO execution_case_drafted (case_key, drafted_at)
    VALUES (@case_key, @drafted_at)
    ON CONFLICT(case_key) DO UPDATE SET drafted_at = excluded.drafted_at
  `);
  const selectDrafted = db.prepare(
    'SELECT 1 AS hit FROM execution_case_drafted WHERE case_key = ?',
  );

  return {
    recordDraftIssued: (case_key, drafted_at) => {
      upsertDrafted.run({ case_key, drafted_at });
    },
    wasDrafted: (case_key) => selectDrafted.get(case_key) !== undefined,
    record: (link) => { upsert.run(link); },
    listForKey: (case_key) => selectForKey.all(case_key) as AuthoredRecipeLink[],
    listForKeys: (case_keys) => {
      const out = new Map<string, AuthoredRecipeLink[]>();
      // ⚠ Iterated rather than an `IN (...)` over caller-sized input: the list
      // is bounded by what the panel renders, and a variadic IN would need
      // either a parameter-count cap or string building.
      for (const key of new Set(case_keys)) {
        const rows = selectForKey.all(key) as AuthoredRecipeLink[];
        if (rows.length > 0) out.set(key, rows);
      }
      return out;
    },
    deleteForKey: (case_key) => deleteForKey.run(case_key).changes,
  };
};

// ════════════════════════════════════════════════════════════════
// The recorder — extracted so the GUARD is testable
// ════════════════════════════════════════════════════════════════

/** ⛔ EXTRACTED BECAUSE THE GUARD SURVIVED A MUTATION. With this logic inline in
 *  `wire-chat-orchestrator`, deleting the `wasDrafted` check left every test
 *  green: the store test proved the predicate worked, and the dispatch test used
 *  a stubbed dep, so nothing proved the composition CALLED it. A guard no test
 *  can fail is not a guard. */
export interface AuthoredLinkRecorderDeps {
  /** The case's DURABLE key, or undefined when the case is gone (forgotten, or
   *  never existed). */
  loadCaseKey(case_id: string): Promise<string | undefined>;
  /** The stored recipe's content hash, or undefined when there is no such
   *  recipe. ⛔ Computed server-side — a caller-supplied hash would let them
   *  assert anything. */
  loadRecipeHash(recipe_id: string): string | undefined;
  store: Pick<ExecutionCaseAuthoredStore, 'wasDrafted' | 'record'>;
  now(): number;
}

/** Records "the owner saved this recipe, drafted from this case".
 *
 *  ⚠ Every rejection is `{ recorded: false }` rather than a throw: the save has
 *  already happened and is the thing that mattered. The cost of any failure here
 *  is an annotation. */
export const recordAuthoredLink = async (
  deps: AuthoredLinkRecorderDeps,
  input: { case_id: string; recipe_id: string },
): Promise<{ recorded: boolean }> => {
  const case_key = await deps.loadCaseKey(input.case_id);
  if (case_key === undefined) return { recorded: false };
  const recipe_hash = deps.loadRecipeHash(input.recipe_id);
  if (recipe_hash === undefined) return { recorded: false };
  // ⛔ THE PROVENANCE GUARD. Both existing is not one coming from the other.
  if (!deps.store.wasDrafted(case_key)) return { recorded: false };
  deps.store.record({
    case_key,
    recipe_id: input.recipe_id,
    recipe_hash,
    authored_at: deps.now(),
  });
  return { recorded: true };
};

/** Resolve a stored link against the recipe as it is NOW.
 *
 *  ⛔ EXTRACTED, not inlined in the composition. The provenance guard in this
 *  same module survived its first mutation precisely because it lived inline
 *  where no test could reach it; doing that twice in one file would be careless.
 *
 *  ⚠ `gone` is the case that matters: "you made a recipe from this" is merely
 *  incomplete when they have edited it, and actively misleading when the recipe
 *  is not there any more. */
export const resolveAuthoredState = (
  link: Pick<AuthoredRecipeLink, 'recipe_id' | 'recipe_hash'>,
  loadRecipeHash: (recipe_id: string) => string | undefined,
): 'unchanged' | 'edited' | 'gone' => {
  const live = loadRecipeHash(link.recipe_id);
  if (live === undefined) return 'gone';
  return live === link.recipe_hash ? 'unchanged' : 'edited';
};
