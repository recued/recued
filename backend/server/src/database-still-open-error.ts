/** Another process still has the realm's database open, so a snapshot of the
 *  closed file would be missing its committed tail (`copyClosedDatabaseForSnapshot`).
 *
 *  🔑 Typed, so an update can tell the owner WHY it did not take effect — another
 *  program had the database open, typically an AI app's `recued --mcp` from a
 *  release before it stepped aside for updates — instead of "installing failed".
 *  Its own module so the update orchestrator can recognise it without loading
 *  the database layer. `code` survives a boundary that `instanceof` might not. */
export class DatabaseStillOpenError extends Error {
  readonly code = 'DATABASE_STILL_OPEN';
}

export const isDatabaseStillOpenError = (err: unknown): boolean =>
  err instanceof DatabaseStillOpenError
  || (typeof err === 'object' && err !== null
    && (err as { code?: unknown }).code === 'DATABASE_STILL_OPEN');
