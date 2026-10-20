/** A single-use in-process capability. Wire objects can never authorize a
 * replacement of an enrolled recipe. The release store supplies the commit
 * finalizer inside the recipe writer's transaction, before mutation hooks. */
import type Database from 'better-sqlite3';
import { RpcError, type RecipeDefinition } from '@recued/contracts';
import { canonicalJSONStringifyStrict, sha256Hex } from '@recued/crypto';

export const recipeReleaseDigest = (value: unknown): string => 'sha256:' + sha256Hex(canonicalJSONStringifyStrict(value));
interface Grant { db: Database.Database; recipe_id: string; expected_json: string; candidate_digest: string }
const grants = new WeakMap<object,Grant>();
export const initializeRecipeReleases = (db: Database.Database): void => {
  db.exec(`CREATE TABLE IF NOT EXISTS recipe_release_tracks (
    recipe_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, active_digest TEXT NOT NULL,
    active_sequence INTEGER NOT NULL, deleted INTEGER NOT NULL, encrypted TEXT NOT NULL, attempt_id TEXT NOT NULL)`);
};
export const withRecipeReleaseAuthority = <T>(grant: Grant, write: (permit: object) => T): T => {
  const permit = {}; grants.set(permit,grant);
  try { return write(permit); } finally { grants.delete(permit); }
};
export const assertRecipeReleaseWrite = (db: Database.Database, recipe: RecipeDefinition,
  expectedJson?: string, permit?: object): void => {
  const managed = db.prepare('SELECT 1 FROM recipe_release_tracks WHERE recipe_id=? AND deleted=0').get(recipe.recipe_id);
  if (!managed) return;
  const grant = permit ? grants.get(permit) : undefined;
  if (!grant || grant.db !== db || grant.recipe_id !== recipe.recipe_id || grant.expected_json !== expectedJson
    || grant.candidate_digest !== recipeReleaseDigest(recipe) || !db.inTransaction) {
    throw new RpcError('recipe_release_required','This recipe uses reviewed releases. Save a draft, run its tests and review activation in Kitchen.',409);
  }
  grants.delete(permit!);
};
/** Deleting a recipe purges its private release material in the same transaction.
 * The monotonic tombstone prevents stale draft/activation requests after reuse. */
export const retireRecipeReleases = (db: Database.Database, recipeId: string): void => {
  db.prepare(`UPDATE recipe_release_tracks SET revision=revision+1,active_digest='',active_sequence=0,deleted=1,encrypted='',attempt_id=''
    WHERE recipe_id=? AND deleted=0`).run(recipeId);
};
