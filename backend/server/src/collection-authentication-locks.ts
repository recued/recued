import type Database from 'better-sqlite3';
import { RpcError } from '@recued/contracts';
/** Both native-app swaps and saved-API migrations serialize collection changes. */
const locks = new WeakMap<Database.Database, Set<string>>();
export const collectionAuthenticationLocks = (db: Database.Database): Set<string> => {
  let active = locks.get(db);
  if (!active) { active = new Set(); locks.set(db, active); }
  return active;
};

/** D-322 §44 — deletion holds the same DB-scoped lease through adapter shutdown. */
export const withCollectionAuthenticationLock = async <T>(active: Set<string> | undefined, key: string, run: () => Promise<T>): Promise<T> => {
  if (active?.has(key)) throw new RpcError('conflict', 'Finish the pending authentication change or permission cleanup before deleting this account.');
  active?.add(key);
  try { return await run(); } finally { active?.delete(key); }
};
