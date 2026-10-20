/** In-process capabilities for exact, reviewed pack recipe writes. Neither
 * a wire object nor an install source string can mint one. */
import type Database from 'better-sqlite3';
import { RpcError, type RecipeDefinition } from '@recued/contracts';
import { recipeReleaseDigest as digest } from './recipe-release-authority.js';

export const initializePackUpdates = (db: Database.Database): void => {
  db.exec(`CREATE TABLE IF NOT EXISTS pack_update_tracks (
    pack_slug TEXT PRIMARY KEY, revision INTEGER NOT NULL, deleted INTEGER NOT NULL,
    encrypted TEXT NOT NULL, attempt_id TEXT NOT NULL)`);
  db.exec('CREATE TABLE IF NOT EXISTS pack_update_members (recipe_id TEXT PRIMARY KEY, pack_slug TEXT NOT NULL)');
  db.exec('CREATE TABLE IF NOT EXISTS pack_update_plan_packs (pack_slug TEXT PRIMARY KEY, plan_slug TEXT NOT NULL)');
  db.exec('CREATE TABLE IF NOT EXISTS pack_release_history (pack_slug TEXT PRIMARY KEY, revision INTEGER NOT NULL, encrypted TEXT NOT NULL)');
};
export const packUpdatePlanOwner = (db: Database.Database, slug: string): string | undefined =>
  db.prepare(`SELECT p.plan_slug FROM pack_update_plan_packs p JOIN pack_update_tracks t ON t.pack_slug=p.plan_slug
    WHERE p.pack_slug=? AND t.deleted=0`).pluck().get(slug) as string | undefined;
interface Grant {
  db: Database.Database; pack_slug: string; check(): void;
  recipes: Map<string,{ before: string | null; after: string; written: boolean; pack_slug?: string }>;
}
const grants = new WeakMap<object,Grant>();
export const assertPackUpdatePermit = (db: Database.Database | undefined, permit: object): void => {
  const grant = grants.get(permit);
  if (!db || !db.inTransaction || !grant || grant.db !== db) throw new RpcError('pack_update_required','Apply the staged update through its reviewed plan.',409);
  grant.check();
};
export const withPackUpdateAuthoritySync = <T>(grant: Grant, write: (permit: object) => T): T => {
  const permit = {}; grants.set(permit,grant);
  try { return write(permit); } finally { grants.delete(permit); }
};
export const withPackUpdateAuthority = async <T>(grant: Grant, write: (permit: object) => Promise<T>): Promise<T> => {
  const permit = {}; grants.set(permit,grant);
  try { return await write(permit); } finally { grants.delete(permit); }
};
export const assertPackUpdateWrite = (db: Database.Database, recipe: RecipeDefinition,
  incomingPack?: string | null, permit?: object): void => {
  const prior = db.prepare('SELECT pack_slug,recipe_json FROM recipes WHERE recipe_id=?').get(recipe.recipe_id) as { pack_slug: string | null; recipe_json: string } | undefined;
  const member = db.prepare('SELECT pack_slug FROM pack_update_members WHERE recipe_id=?').pluck().get(recipe.recipe_id) as string | undefined;
  const candidates = [...new Set([prior?.pack_slug,incomingPack,member].filter((pack): pack is string => !!pack))];
  const protectedPacks = [...new Set(candidates
    .map(pack => packUpdatePlanOwner(db,pack) ?? (db.prepare('SELECT 1 FROM pack_update_tracks WHERE pack_slug=? AND deleted=0').get(pack) ? pack : undefined))
    .filter((pack): pack is string => !!pack))];
  if (!protectedPacks.length) return;
  const grant = permit ? grants.get(permit) : undefined, entry = grant?.recipes.get(recipe.recipe_id), body = digest(recipe);
  if (protectedPacks.length !== 1 || !grant || grant.db !== db || grant.pack_slug !== protectedPacks[0]
    || !entry || incomingPack !== (entry.pack_slug ?? grant.pack_slug) || !db.inTransaction) {
    throw new RpcError('pack_update_required','This pack requires a staged update and passing saved recipe tests in Packs.',409);
  }
  // The install engine can restore a captured prior body after a failed write.
  // Rollback stays available after revocation; it grants no new candidate.
  if (entry.written && entry.before !== null && body === digest(JSON.parse(entry.before))) return;
  grant.check();
  if (entry.written || body !== entry.after || (prior?.recipe_json ?? null) !== entry.before) {
    throw new RpcError('pack_update_conflict','A pack recipe changed during the reviewed update. Stage it again.',409);
  }
  entry.written = true;
};
export const retirePackUpdates = (db: Database.Database, slug: string): void => {
  db.transaction(() => {
    const root = packUpdatePlanOwner(db,slug);
    if (root && root !== slug) {
      db.prepare("UPDATE pack_update_tracks SET attempt_id='' WHERE pack_slug=?").run(root);
      db.prepare('DELETE FROM pack_update_members WHERE pack_slug=?').run(root);
      db.prepare('DELETE FROM pack_update_plan_packs WHERE plan_slug=?').run(root);
    }
    db.prepare("UPDATE pack_update_tracks SET revision=revision+1,deleted=1,encrypted='',attempt_id='' WHERE pack_slug=? AND deleted=0").run(slug);
    db.prepare('DELETE FROM pack_update_members WHERE pack_slug=?').run(slug);
    db.prepare('DELETE FROM pack_update_plan_packs WHERE plan_slug=?').run(slug);
    db.prepare('DELETE FROM pack_release_history WHERE pack_slug=?').run(slug);
  }).immediate();
};
