/** Private transaction material. Never a recipe argument, receipt field or
 * admission permit. Only built-in stores may supply a lossless inverse. */
import { AsyncLocalStorage } from 'node:async_hooks';
import type Database from 'better-sqlite3';
import type { RecordsExecutionBinding, ReviewedResource } from '@recued/contracts';
import type { LocalMutationReceipt } from './storage/local-mutation-receipts.js';

export type LocalUpdateInverse =
  | { kind: 'records'; binding: RecordsExecutionBinding; args: Record<string, unknown>; resources: ReviewedResource[] }
  | { kind: 'local_calendar'; slug: string; source_id: string; set: Record<string, unknown>; unset: string[];
      binding: string; version: string; key: string };
const inverseContext = new AsyncLocalStorage<LocalUpdateInverse | undefined>();
const recorders = new WeakMap<Database.Database, (receipt: LocalMutationReceipt, inverse: LocalUpdateInverse) => void>();
export const withLocalUpdateInverse = <T>(inverse: LocalUpdateInverse | undefined, run: () => T): T =>
  inverseContext.run(inverse, run);
export const registerLocalUpdateInverseRecorder = (db: Database.Database,
  record: (receipt: LocalMutationReceipt, inverse: LocalUpdateInverse) => void): void => { recorders.set(db, record); };
export const recordLocalUpdateInverse = (db: Database.Database, receipt: LocalMutationReceipt): void => {
  const inverse = inverseContext.getStore();
  // A reverse update is not an implicit offer to redo the original action.
  if (inverse && receipt.owner !== 'local_undo') recorders.get(db)?.(receipt, inverse);
};
