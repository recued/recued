import { AsyncLocalStorage } from 'node:async_hooks';
import type Database from 'better-sqlite3';

const participants = new AsyncLocalStorage<((db: Database.Database) => void) | undefined>();
export const withScheduledLocalAuthority = <T>(consume: (db: Database.Database) => void, effect: () => T): T =>
  participants.run(consume, effect);
/** The native mutation and authorization budget share the realm transaction. */
export const consumeScheduledLocalAuthority = (db: Database.Database): void => participants.getStore()?.(db);
