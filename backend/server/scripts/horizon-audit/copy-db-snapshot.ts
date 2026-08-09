/** Copy a live SQLite database out of a running server, WAL included.
 *
 *  ⛔ THE DEFECT THIS EXISTS FOR. `dump-schema.ts` did `copyFileSync(dbPath,
 *  out)`. The server runs in WAL mode, so everything written since the last
 *  checkpoint lives in `<db>-wal`, not in `<db>` — a plain file copy silently
 *  drops it. Measured on a real boot: the live database held 808 `sqlite_master`
 *  objects and the dump held 623. **23% of the schema, gone, with no error.**
 *
 *  ⛔ AND IT MADE THE SQL AUDIT LIE IN BOTH DIRECTIONS. `query-audit-run.ts`
 *  EXPLAINs the whole tree against this dump:
 *    - a table still in the WAL came back "no such table", so its queries were
 *      dropped from the DENOMINATOR — the tool reports coverage honestly, so
 *      this read as a corpus limitation rather than as the tool's own bug;
 *    - far worse, a table present in the dump whose INDEXES were still in the
 *      WAL got EXPLAINed as a full SCAN. That is a FALSE POSITIVE: the sweep
 *      reports a missing index that exists, and `index-advisor.ts` proposes a
 *      duplicate of it.
 *  The file's own header says booting is "the only honest way to get the schema
 *  the server actually runs on" — which was right, and then thrown away one line
 *  later.
 *
 *  🔑 THE FIX IS TO COPY THE SIDECARS. Opening the copy replays the WAL, so the
 *  reader sees exactly what the server sees. `-shm` is a rebuildable index into
 *  the WAL and is copied only for completeness.
 *
 *  ⚠ WHY NOT CHECKPOINT INSTEAD. Checkpointing means opening the live database
 *  and writing to it, and the D-212 chokepoint rule is that nothing which can
 *  touch a realm builds its own driver. Copying needs no driver at all, which is
 *  also why this helper is pure `node:fs`.
 *
 *  ⚠ CONSISTENCY. This is a file-level snapshot of a database that may still be
 *  written to, so it is only safe for a QUIESCENT server — which is the case
 *  every caller has (schema dumped straight after boot, no traffic). It is not a
 *  general-purpose backup; `VACUUM INTO` is that, and it needs a connection. */

import { copyFileSync, existsSync, rmSync } from 'node:fs';

/** SQLite's WAL-mode sidecars, in the order a reader needs them. */
const SIDECARS = ['-wal', '-shm'] as const;

export const copyDatabaseSnapshot = (srcPath: string, destPath: string): void => {
  copyFileSync(srcPath, destPath);
  for (const suffix of SIDECARS) {
    const src = `${srcPath}${suffix}`;
    const dest = `${destPath}${suffix}`;
    // ⚠ A STALE SIDECAR IS WORSE THAN A MISSING ONE. Writing over an existing
    // destination leaves whatever the previous dump put there, and a `-wal`
    // belonging to a different database is how a reader gets a schema that
    // never existed. Clear first, then copy only what the source actually has.
    if (existsSync(dest)) rmSync(dest, { force: true });
    if (existsSync(src)) copyFileSync(src, dest);
  }
};
