/** D-110 / D-111 Phase 7 — file stack boot composer.
 *
 *  Wraps `composeFileStack` from the file-collection package with the
 *  bin.ts-level dep wiring: just the `[file-stack]` logger. The
 *  underlying composer carries `onEvent` + `auditLog` opts too;
 *  bin.ts doesn't wire either today (file collections are advisory
 *  per Phase 7 v1 — the mutation dispatcher reads the live adapter
 *  directly), so the composer's surface stays minimal.
 *
 *  Gated on `db` — dbless harnesses return `undefined` so downstream
 *  consumers (`fileStack.enrollDeps` / `startAll` / `disposeAll`) skip
 *  cleanly. */

import type Database from 'better-sqlite3';

import {
  composeFileStack,
  type FileStack,
} from '../../collections/file/compose.js';

export interface ComposeFileStackBootDeps {
  /** SQLite handle. Undefined → composer returns `undefined`. */
  db: Database.Database | undefined;
}

export const composeFileBoot = (
  deps: ComposeFileStackBootDeps,
): FileStack | undefined => {
  if (!deps.db) return undefined;

  return composeFileStack(deps.db, {
    log: (level, msg, data) => {
      const fn = level === 'error' ? console.error : console.log;
      fn(`[file-stack] ${msg}`, data ?? '');
    },
  });
};
