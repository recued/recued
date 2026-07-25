/** auth.migrate.* rpc handlers — plaintext → encrypted migration flow.
 *
 *  Four methods:
 *    auth.migrate.prepare(password)
 *      → { recoveryKey, bundle, verificationId, expiresInMs }
 *      Generates bundle + Master DEK + recovery key, holds in RAM under
 *      an ephemeral id. Bundle returned so UI can offer emergency export.
 *
 *    auth.migrate.commit({ verificationId, password })
 *      → { state, migrated }
 *      Looks up verification entry, saves bundle to disk, runs migration
 *      while holding the maintenance lock (caller starts/stops scheduler).
 *
 *    auth.migrate.status()
 *      → { active, phase?, progress?, startedAt?, bundleMissing? }
 *      Always callable. UI polls this for progress rendering.
 *
 *    auth.migrate.resume({ password, bundle? })
 *      → { state, migrated }
 *      Valid only when migration_state marker is present. Bundle param
 *      is required iff on-disk bundle is missing (disaster recovery).
 *
 *  Handlers return the bare response on success and throw `RpcError`
 *  on failure; the WS dispatcher wraps the throw into the wire
 *  envelope. The handler does not itself stop the scheduler or flip
 *  the ws lock — those lifecycle concerns are the caller's (bin.ts
 *  wiring). Handler guarantees: bundle saved before any data
 *  mutation; marker cleared only after migration completes.
 */

import type Database from 'better-sqlite3';
import {
  createBundle,
  openBundleWithPassword,
  deriveSubDEK,
  bundleToJSON,
  bundleFromJSON,
  type Argon2Params,
  type Bundle,
} from '@recued/crypto';
import {
  RpcError,
  type HandlerSlice,
  type ServerAuthMigrationStatus,
  type ServerAuthState,
  type ServerRpcRegistry,
} from '@recued/contracts';
import type { KeyManager } from '../key-manager.js';
import type { BundleStore } from '../bundle-store.js';
import type { WsClient } from '../ws-server.js';
import type { MigrationStateStore } from './migration-state.js';
import type { VerificationStore } from './verification-store.js';
import { runMigration, type MigrationResult } from './migration-runner.js';

const PREPARE_TTL_MS = 10 * 60 * 1000;

export interface MigrateDeps {
  db: Database.Database;
  blobRoot: string;
  keys: KeyManager;
  bundleStore: BundleStore;
  migrationState: MigrationStateStore;
  verifications: VerificationStore;
  /** Called BEFORE migration work starts. Host stops scheduler,
   *  heartbeat, etc. — entering maintenance mode. */
  onEnterMaintenance?: () => Promise<void> | void;
  /** Called AFTER migration completes (success or failure).
   *  Host restarts scheduler, heartbeat, etc. */
  onExitMaintenance?: () => Promise<void> | void;
  /** Argon2 params override for init/prepare. Tests only — production
   *  leaves at defaults. */
  argon2Params?: Argon2Params;
}

// ────────────────────────────────────────────────────────────────
// auth.migrate.prepare
// ────────────────────────────────────────────────────────────────

export const handleMigratePrepare = async (
  deps: MigrateDeps,
  args: { password?: unknown },
): Promise<{ recoveryKey: string; bundle: string; verificationId: string; expiresInMs: number }> => {
  const password = typeof args.password === 'string' ? args.password : '';
  if (!password) {
    throw new RpcError('bad_request', 'password is required', 400);
  }

  // Refuse when already initialized — migration is only for uninitialized
  // servers. Use auth.rotatePassword (future) for password changes on
  // already-encrypted servers.
  if (deps.keys.state() !== 'uninitialized') {
    throw new RpcError(
      'already_initialized',
      'server already has encryption configured — migration not applicable',
      409,
    );
  }

  // Refuse when a migration is already in progress (prevents overlapping
  // prepare calls from creating multiple bundles).
  if (deps.migrationState.exists()) {
    throw new RpcError(
      'migration_in_progress',
      'call auth.migrate.resume to continue the in-progress migration',
      409,
    );
  }

  const { bundle, recoveryKey, masterDEK } = await createBundle({
    password,
    argon2: deps.argon2Params,
  });

  const verificationId = deps.verifications.put(
    { bundle, masterDEK, recoveryKey, password },
    PREPARE_TTL_MS,
  );

  return {
    recoveryKey,
    bundle: bundleToJSON(bundle),
    verificationId,
    expiresInMs: PREPARE_TTL_MS,
  };
};

// ────────────────────────────────────────────────────────────────
// auth.migrate.commit
// ────────────────────────────────────────────────────────────────

const runWithMaintenance = async <T>(
  deps: MigrateDeps,
  fn: () => Promise<T>,
): Promise<T> => {
  await deps.onEnterMaintenance?.();
  try {
    return await fn();
  } finally {
    await deps.onExitMaintenance?.();
  }
};

const loadSubDEKs = (masterDEK: Uint8Array): { cacheKey: Uint8Array; blobKey: Uint8Array } => ({
  cacheKey: deriveSubDEK(masterDEK, 'server-data'),
  blobKey: deriveSubDEK(masterDEK, 'blob-store'),
});

export const handleMigrateCommit = async (
  deps: MigrateDeps,
  args: { verificationId?: unknown; password?: unknown },
): Promise<{ state: ServerAuthState; migrated: MigrationResult }> => {
  const verificationId = typeof args.verificationId === 'string' ? args.verificationId : '';
  const password = typeof args.password === 'string' ? args.password : '';
  if (!verificationId || !password) {
    throw new RpcError('bad_request', 'verificationId and password are required', 400);
  }

  const entry = deps.verifications.take(verificationId);
  if (!entry) {
    throw new RpcError(
      'verification_expired',
      'verification session expired or invalid — call prepare again',
      410,
    );
  }

  // Sanity check: provided password still unlocks the bundle. If this
  // fails, the UI had a bug or the operator mis-typed — either way don't
  // commit, wipe the DEK, return unauthorized.
  try {
    await openBundleWithPassword(entry.bundle, password);
  } catch {
    entry.masterDEK.fill(0);
    throw new RpcError('unauthorized', 'invalid credentials', 401);
  }

  // Commit: save bundle, mark migration in progress, run it.
  deps.bundleStore.save(entry.bundle);

  const migrated = await runWithMaintenance(deps, async () => {
    const { cacheKey, blobKey } = loadSubDEKs(entry.masterDEK);
    try {
      return await runMigration({
        db: deps.db,
        stateStore: deps.migrationState,
        blobRoot: deps.blobRoot,
        cacheKey, blobKey,
      });
    } finally {
      cacheKey.fill(0);
      blobKey.fill(0);
    }
  });

  // Transition KeyManager to unlocked using the Master DEK we already have.
  // Cheapest path: call unlock() with the original password.
  try {
    await deps.keys.unlock({ password });
  } catch {
    // Non-fatal — bundle is saved correctly, operator can unlock next time.
  }

  entry.masterDEK.fill(0);

  return { state: deps.keys.state(), migrated };
};

// ────────────────────────────────────────────────────────────────
// auth.migrate.status
// ────────────────────────────────────────────────────────────────

export const handleMigrateStatus = async (
  deps: MigrateDeps,
): Promise<ServerAuthMigrationStatus> => {
  const state = deps.migrationState.load();
  if (!state) return { active: false };
  const bundleMissing = !deps.bundleStore.exists();
  return {
    active: true,
    phase: state.phase,
    progress: state.progress,
    startedAt: state.startedAt,
    bundleMissing: bundleMissing || undefined,
  };
};

// ────────────────────────────────────────────────────────────────
// auth.migrate.resume
// ────────────────────────────────────────────────────────────────

export const handleMigrateResume = async (
  deps: MigrateDeps,
  args: { password?: unknown; bundle?: unknown },
): Promise<{ state: ServerAuthState; migrated: MigrationResult }> => {
  const password = typeof args.password === 'string' ? args.password : '';
  const providedBundle = typeof args.bundle === 'string' ? args.bundle : undefined;

  if (!password) {
    throw new RpcError('bad_request', 'password is required', 400);
  }

  if (!deps.migrationState.exists()) {
    throw new RpcError('no_migration_in_progress', 'nothing to resume', 409);
  }

  // Disaster recovery: on-disk bundle missing, caller must supply one.
  let bundle: Bundle | null = deps.bundleStore.load();
  if (!bundle) {
    if (!providedBundle) {
      throw new RpcError(
        'bundle_required',
        'server lost its bundle mid-migration — supply the bundle you exported at prepare time',
        409,
      );
    }
    try {
      bundle = bundleFromJSON(providedBundle);
    } catch {
      throw new RpcError('bad_request', 'provided bundle is malformed', 400);
    }
    // Persist it before doing anything else — the caller just rescued us.
    deps.bundleStore.save(bundle);
  }

  let masterDEK: Uint8Array;
  try {
    masterDEK = await openBundleWithPassword(bundle, password);
  } catch {
    throw new RpcError('unauthorized', 'invalid credentials', 401);
  }

  const migrated = await runWithMaintenance(deps, async () => {
    const { cacheKey, blobKey } = loadSubDEKs(masterDEK);
    try {
      return await runMigration({
        db: deps.db,
        stateStore: deps.migrationState,
        blobRoot: deps.blobRoot,
        cacheKey, blobKey,
      });
    } finally {
      cacheKey.fill(0);
      blobKey.fill(0);
    }
  });

  try { await deps.keys.unlock({ password }); } catch { /* non-fatal */ }
  masterDEK.fill(0);

  return { state: deps.keys.state(), migrated };
};

// ────────────────────────────────────────────────────────────────
// Handler slice — composeHandlers factory
// ────────────────────────────────────────────────────────────────

export type MigrateMethods =
  | 'auth.migrate.prepare'
  | 'auth.migrate.commit'
  | 'auth.migrate.status'
  | 'auth.migrate.resume';

export const makeMigrateHandlers = (
  deps: MigrateDeps | undefined,
): HandlerSlice<ServerRpcRegistry, MigrateMethods, WsClient> | undefined => {
  if (!deps) return undefined;
  return {
    methods: ['auth.migrate.prepare', 'auth.migrate.commit', 'auth.migrate.status', 'auth.migrate.resume'],
    handlers: {
      'auth.migrate.prepare': async (args) => handleMigratePrepare(deps, args),
      'auth.migrate.commit': async (args) => handleMigrateCommit(deps, args),
      'auth.migrate.status': async () => handleMigrateStatus(deps),
      'auth.migrate.resume': async (args) => handleMigrateResume(deps, args),
    },
  };
};
