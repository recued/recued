/** Private fixture suites, never a recipe installation or execution grant. */
import type Database from 'better-sqlite3';
import { RpcError, RECIPE_REGRESSION_LIMITS,
  type RecipeRegressionSave, type RecipeRegressionDelete, type RecipeRegressionRead, type RecipeRegressionHistory,
  type RecipeRegressionVersion } from '@recued/contracts';
import { normalizeRecipeRegressionSuite } from '@recued/engine';
import { canonicalJSONStringifyStrict, sha256Hex } from '@recued/crypto';
import type { PreapprovalCodec } from './preapproval-codec.js';

export const regressionDigest = (value: unknown): string => 'sha256:' + sha256Hex(canonicalJSONStringifyStrict(value));
interface Head { revision: number; deleted: number; request_id: string; request_hash: string }
interface Row { recipe_id: string; revision: number; digest: string; encrypted: string; created_at: number; request_id: string; request_hash: string }
const conflict = (message = 'The saved tests changed in another tab. Load the latest version before saving.'): never => {
  throw new RpcError('recipe_regression_conflict',message,409);
};
export const createRecipeRegressionStore = (db: Database.Database, codec: PreapprovalCodec, now: () => number = Date.now) => {
  db.exec(`CREATE TABLE IF NOT EXISTS recipe_regression_heads (
    recipe_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, deleted INTEGER NOT NULL,
    request_id TEXT NOT NULL, request_hash TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS recipe_regression_versions (
    recipe_id TEXT NOT NULL, revision INTEGER NOT NULL, digest TEXT NOT NULL,
    encrypted TEXT NOT NULL, created_at INTEGER NOT NULL, request_id TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL,
    PRIMARY KEY(recipe_id,revision));`);
  const head = (id: string): Head | undefined => db.prepare('SELECT * FROM recipe_regression_heads WHERE recipe_id=?').get(id) as Head | undefined;
  const history = (id: string): RecipeRegressionHistory => ({ head_revision: head(id)?.revision ?? 0,
    versions: db.prepare('SELECT revision,digest,created_at FROM recipe_regression_versions WHERE recipe_id=? ORDER BY revision DESC LIMIT ?')
      .all(id,RECIPE_REGRESSION_LIMITS.versions) as RecipeRegressionHistory['versions'] });
  const replay = (id: string, requestId: string, hash: string): number | undefined => {
    const prior = db.prepare(`SELECT recipe_id,revision,request_hash FROM recipe_regression_versions WHERE request_id=?
      UNION ALL SELECT recipe_id,revision,request_hash FROM recipe_regression_heads WHERE request_id=? LIMIT 1`)
      .get(requestId,requestId) as { recipe_id: string; revision: number; request_hash: string } | undefined;
    if (!prior) return undefined;
    if (prior.recipe_id !== id || prior.request_hash !== hash) return conflict('This request ID already names a different test change.');
    return prior.revision;
  };
  const read = async (id: string, revision: number | undefined, check: () => void): Promise<RecipeRegressionRead> => {
    check(); codec.assertUnlocked();
    const current = head(id), wanted = revision ?? (current?.deleted ? undefined : current?.revision);
    if (wanted === undefined) return { ...history(id), version: null };
    const row = db.prepare('SELECT * FROM recipe_regression_versions WHERE recipe_id=? AND revision=?').get(id,wanted) as Row | undefined;
    if (!row) return conflict('That test version was deleted or is no longer retained. Load the latest tests.');
    const envelope = await codec.open(row.encrypted) as { schema_version: number; request_id: string; request_hash: string; version: RecipeRegressionVersion };
    const raw = envelope.version;
    check(); codec.assertUnlocked();
    const live = db.prepare('SELECT * FROM recipe_regression_versions WHERE recipe_id=? AND revision=?').get(id,wanted) as Row | undefined;
    if (!live || live.encrypted !== row.encrypted || live.digest !== row.digest || live.request_hash !== row.request_hash
      || live.request_id !== row.request_id || live.created_at !== row.created_at
      || envelope.schema_version !== 1 || envelope.request_id !== row.request_id || envelope.request_hash !== row.request_hash
      || raw.recipe_id !== id || raw.revision !== wanted || raw.digest !== row.digest || raw.created_at !== row.created_at) return conflict('The saved test version changed while it was loading.');
    const suite = normalizeRecipeRegressionSuite(raw.suite);
    if (suite.baseline.recipe_id !== id || regressionDigest(suite) !== row.digest) return conflict('The sealed test version does not match its identity.');
    const latest = history(id);
    if (revision === undefined && latest.head_revision !== wanted) return conflict('The latest tests changed while loading. Load them again.');
    return { ...latest, version: { recipe_id: id, revision: wanted, digest: row.digest, created_at: row.created_at, suite } };
  };
  return {
    codec, history, read,
    async save(request: RecipeRegressionSave, check: () => void): Promise<RecipeRegressionRead> {
      check(); codec.assertUnlocked();
      const suite = normalizeRecipeRegressionSuite(request.suite);
      if (suite.baseline.recipe_id !== request.recipe_id) return conflict('The baseline must belong to this recipe.');
      const hash = regressionDigest({ kind: 'save',recipe_id: request.recipe_id,expected_revision: request.expected_revision,suite });
      const prior = replay(request.recipe_id,request.request_id,hash);
      if (prior !== undefined) return read(request.recipe_id,prior,check);
      const revision = request.expected_revision + 1, digest = regressionDigest(suite), created_at = now();
      const material: RecipeRegressionVersion = { recipe_id: request.recipe_id,revision,digest,created_at,suite };
      const encrypted = await codec.seal({ schema_version: 1,request_id: request.request_id,request_hash: hash,version: material });
      const saved = db.transaction(() => {
        check(); codec.assertUnlocked();
        const existing = replay(request.recipe_id,request.request_id,hash); if (existing !== undefined) return existing;
        const current = head(request.recipe_id);
        if ((current?.revision ?? 0) !== request.expected_revision) return conflict();
        if ((!current || current.deleted) && (db.prepare('SELECT count(*) FROM recipe_regression_heads WHERE deleted=0').pluck().get() as number) >= RECIPE_REGRESSION_LIMITS.suites) {
          throw new RpcError('recipe_regression_limit','Keep at most 100 saved recipe test suites. Delete an unused suite first.',409);
        }
        db.prepare('DELETE FROM recipe_regression_versions WHERE recipe_id=? AND revision<=?')
          .run(request.recipe_id,revision - RECIPE_REGRESSION_LIMITS.versions);
        const retained = db.prepare('SELECT coalesce(sum(length(CAST(encrypted AS BLOB))),0) FROM recipe_regression_versions').pluck().get() as number;
        if (retained + Buffer.byteLength(encrypted,'utf8') > RECIPE_REGRESSION_LIMITS.retained_bytes) throw new RpcError('recipe_regression_limit','Saved test history is full. Delete an unused suite or use smaller samples.',409);
        db.prepare('INSERT INTO recipe_regression_versions VALUES(?,?,?,?,?,?,?)')
          .run(request.recipe_id,revision,digest,encrypted,created_at,request.request_id,hash);
        db.prepare(`INSERT INTO recipe_regression_heads VALUES(?,?,0,?,?) ON CONFLICT(recipe_id) DO UPDATE
          SET revision=excluded.revision,deleted=0,request_id=excluded.request_id,request_hash=excluded.request_hash`)
          .run(request.recipe_id,revision,request.request_id,hash);
        return revision;
      }).immediate();
      return read(request.recipe_id,saved,check);
    },
    remove(request: RecipeRegressionDelete, check: () => void): RecipeRegressionRead {
      return db.transaction(() => {
        check(); codec.assertUnlocked();
        const hash = regressionDigest({ kind: 'delete',recipe_id: request.recipe_id,expected_revision: request.expected_revision });
        if (replay(request.recipe_id,request.request_id,hash) !== undefined) return { ...history(request.recipe_id),version: null };
        const current = head(request.recipe_id);
        if ((current?.revision ?? 0) !== request.expected_revision) return conflict();
        db.prepare('DELETE FROM recipe_regression_versions WHERE recipe_id=?').run(request.recipe_id);
        db.prepare(`INSERT INTO recipe_regression_heads VALUES(?,?,1,?,?) ON CONFLICT(recipe_id) DO UPDATE
          SET revision=excluded.revision,deleted=1,request_id=excluded.request_id,request_hash=excluded.request_hash`)
          .run(request.recipe_id,request.expected_revision + 1,request.request_id,hash);
        return { ...history(request.recipe_id),version: null };
      }).immediate();
    },
  };
};
export type RecipeRegressionStore = ReturnType<typeof createRecipeRegressionStore>;
