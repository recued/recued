/** Host-only coordination of built-in stores on one realm connection. */
import { AsyncLocalStorage } from 'node:async_hooks';
import type Database from 'better-sqlite3';
import { withLocalMutationScope } from './local-mutation-context.js';
import { withResourceReview } from './resource-review.js';

export interface PreparedLocalWrite { db: Database.Database; apply(): void }
interface Frame { db: Database.Database; accounting: Array<() => void>; after: Array<() => void> }
const frames = new AsyncLocalStorage<Frame | undefined>();

export const afterLocalCommit = (db: Database.Database, publish: () => void, phase: 'accounting' | 'notify' = 'notify'): void => {
  const frame = frames.getStore();
  if (!frame) { publish(); return; }
  if (frame.db !== db || !db.inTransaction) throw new Error('Local participants must share the realm transaction.');
  (phase === 'accounting' ? frame.accounting : frame.after).push(publish);
};

export const commitLocalTransaction = <T>(db: Database.Database, apply: () => T): T => {
  if (frames.getStore() || db.inTransaction) throw new Error('A local change set requires its own outer transaction.');
  const frame: Frame = { db, accounting: [], after: [] };
  const result = db.transaction(() => frames.run(frame, () => {
    const value = apply();
    if (value && typeof value === 'object' && 'then' in value) throw new Error('Local commits cannot await.');
    return value;
  })).immediate();
  // Existing refresh/emitter sinks run after the durable receipt. A sink
  // failure cannot change committed truth or stop the other sinks from running.
  withLocalMutationScope(undefined, () => withResourceReview(undefined, () => {
    for (const finish of frame.accounting) { try { finish(); } catch { /* committed */ } }
    for (const publish of frame.after) { try { publish(); } catch { /* committed */ } }
  }));
  return result;
};
