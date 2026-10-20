/** Immutable, encrypted artifacts of successfully committed reviewed pack groups.
 * Capture is prepared before the transaction and published with its receipt. */
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { PACK_RELEASE_LIMITS as LIMIT, PACK_UPDATE_LIMITS, RpcError, regressionBytes, type PackReleaseSummary } from '@recued/contracts';
import type { RecipeStore } from '../recipe-store.js';
import type { ContractStore } from './contract-store.js';
import type { PreapprovalCodec } from './preapproval-codec.js';
import { getInstalledPack } from '../pack-inventory.js';
import { packUpdateMembers,packUpdateRecipes,type PreparedPackUpdate } from '../pack-update-plan.js';
import { recipeReleaseDigest as digest } from './recipe-release-authority.js';

interface Row { pack_slug: string; revision: number; encrypted: string }
export interface RetainedPackRelease {
  release_id: string; sequence: number; created_at: number; digest: string; request_id: string;
  target: PreparedPackUpdate; surrounding_inventory: string;
}
interface State { schema_version: 1; pack_slug: string; revision: number; sequence: number; releases: RetainedPackRelease[] }
export interface PackReleaseHistorySnapshot { row: Row | undefined; state: State }
const conflict = (message: string): never => { throw new RpcError('pack_update_conflict',message,409); };

/** Installation timestamps and ingredient inventory are part of this conservative
 * compatibility boundary. Connection and audience choices are never restored. */
export const packReleaseEnvironment = (contracts: ContractStore, target: PreparedPackUpdate): string => {
  const members = new Set(packUpdateMembers(target).map(pack => pack.manifest.slug));
  return digest({ packs: contracts.scan('installed_pack').filter(row => !members.has(row.segments[0]!)),
    ingredients: contracts.scan('installed_ingredient') });
};
export const packReleaseArtifact = (target: PreparedPackUpdate): PreparedPackUpdate => {
  const artifact = structuredClone(target); delete artifact.requirements; return artifact;
};
export const packReleaseDigest = (target: PreparedPackUpdate, surrounding_inventory: string): string =>
  digest({ target: packReleaseArtifact(target),surrounding_inventory });
export const packReleaseInstalled = (target: PreparedPackUpdate, recipes: RecipeStore, contracts: ContractStore): boolean =>
  packUpdateMembers(target).every(pack => {
    const installed = getInstalledPack(contracts,pack.manifest.slug), ids = recipes.listForPack(pack.manifest.slug).sort();
    return installed?.publisher === pack.manifest.publisher && installed.version === pack.manifest.version
      && ids.length === pack.recipes.length && pack.recipes.every(entry => {
        const stored = recipes.getStored(entry.slug);
        return stored?.pack_slug === pack.manifest.slug && stored.publisher_id === entry.recipe?.publisher_id
          && digest(recipes.get(entry.slug)) === digest(entry.recipe?.recipe);
      });
  });
export const createPackReleaseHistory = (db: Database.Database, codec: PreapprovalCodec, recipes: RecipeStore, contracts: ContractStore) => {
  const row = (slug: string): Row | undefined => db.prepare('SELECT * FROM pack_release_history WHERE pack_slug=?').get(slug) as Row | undefined;
  const empty = (slug: string): PackReleaseHistorySnapshot => ({ row: undefined,
    state: { schema_version: 1,pack_slug: slug,revision: 0,sequence: 0,releases: [] } });
  const assert = (snapshot: PackReleaseHistorySnapshot, check: () => void): void => {
    check(); codec.assertUnlocked();
    if (JSON.stringify(row(snapshot.state.pack_slug)) !== JSON.stringify(snapshot.row)) conflict('Release history changed. Reload it before continuing.');
  };
  const quota = (slug: string, encrypted: string): void => {
    const retained = db.prepare('SELECT coalesce(sum(length(CAST(encrypted AS BLOB))),0) FROM pack_release_history WHERE pack_slug<>?').pluck().get(slug) as number;
    if (retained + Buffer.byteLength(encrypted,'utf8') > LIMIT.retained_bytes) {
      throw new RpcError('pack_update_limit','Pack release history is full. Remove an unused protected pack before retaining another release.',409);
    }
  };
  return {
    empty,assert,
    identity: (slug: string): string => digest(row(slug)),
    async load(slug: string, check: () => void): Promise<PackReleaseHistorySnapshot> {
      check(); codec.assertUnlocked(); const saved = row(slug); if (!saved) return empty(slug);
      const state = await codec.open(saved.encrypted) as State;
      const snapshot = { row: saved,state }; check(); codec.assertUnlocked();
      if (!state || state.schema_version !== 1 || state.pack_slug !== slug || state.revision !== saved.revision
        || !Number.isSafeInteger(state.sequence) || state.sequence < 1 || !Array.isArray(state.releases)
        || state.releases.length > LIMIT.releases || regressionBytes(state) > LIMIT.bytes
        || new Set(state.releases.map(release => release.release_id)).size !== state.releases.length) conflict('The sealed release history does not match its identity.');
      let sequence = 0;
      for (const release of state.releases) {
        if (!release.target || release.target.manifest?.slug !== slug || !release.target.dependencies?.length
          || packUpdateMembers(release.target).length > PACK_UPDATE_LIMITS.packs || packUpdateRecipes(release.target).length > PACK_UPDATE_LIMITS.recipes
          || !Number.isSafeInteger(release.sequence) || release.sequence <= sequence || release.sequence > state.sequence
          || release.digest !== packReleaseDigest(release.target,release.surrounding_inventory)) conflict('A retained release does not match its immutable artifacts.');
        sequence = release.sequence;
      }
      assert(snapshot,check); return snapshot;
    },
    summaries(snapshot: PackReleaseHistorySnapshot): PackReleaseSummary[] {
      return [...snapshot.state.releases].reverse().map(release => ({ release_id: release.release_id,sequence: release.sequence,
        created_at: release.created_at,digest: release.digest,current: packReleaseInstalled(release.target,recipes,contracts),
        packs: packUpdateMembers(release.target).map(pack => ({ pack_slug: pack.manifest.slug,name: pack.manifest.name,version: pack.manifest.version })) }));
    },
    async prepare(snapshot: PackReleaseHistorySnapshot, target: PreparedPackUpdate, request_id: string, at: number, check: () => void) {
      assert(snapshot,check);
      if (recipes.realmDatabase !== db || contracts.realmDatabase !== db) throw new RpcError('pack_update_unsupported','Release history requires the built-in stores on the same realm.',409);
      const artifact = packReleaseArtifact(target), surrounding_inventory = packReleaseEnvironment(contracts,artifact);
      const release: RetainedPackRelease = { release_id: randomUUID(),sequence: snapshot.state.sequence + 1,created_at: at,request_id,
        target: artifact,surrounding_inventory,digest: packReleaseDigest(artifact,surrounding_inventory) };
      const state: State = { schema_version: 1,pack_slug: artifact.manifest.slug,revision: snapshot.state.revision + 1,sequence: release.sequence,
        releases: [...snapshot.state.releases,release].slice(-LIMIT.releases) };
      while (regressionBytes(state) > LIMIT.bytes && state.releases.length > 1) state.releases.shift();
      if (regressionBytes(state) > LIMIT.bytes) throw new RpcError('pack_update_limit','Keep a retained release under 8 MB.',409);
      const encrypted = await codec.seal(state); assert(snapshot,check); quota(state.pack_slug,encrypted);
      if (packReleaseEnvironment(contracts,artifact) !== surrounding_inventory) conflict('The surrounding pack inventory changed during release capture.');
      return { release_id: release.release_id,snapshot: { row: { pack_slug: state.pack_slug,revision: state.revision,encrypted },state },
        commit() {
          assert(snapshot,check); quota(state.pack_slug,encrypted);
          if (!db.inTransaction || !packReleaseInstalled(artifact,recipes,contracts)
            || packReleaseEnvironment(contracts,artifact) !== surrounding_inventory) conflict('A release can be retained only with its complete installed group.');
          db.prepare('INSERT INTO pack_release_history VALUES(?,?,?) ON CONFLICT(pack_slug) DO UPDATE SET revision=excluded.revision,encrypted=excluded.encrypted')
            .run(state.pack_slug,state.revision,encrypted);
        } };
    },
  };
};
