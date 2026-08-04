/** M5 S1 — import-side auto-commit provenance (the D-108 deferred half).
 *
 *  A cross-machine restore swaps the server's db onto an UNCHANGED identity
 *  key-file (the archive carries the warehouse + a signed `migration_full`
 *  passport, never the keys). The old→new identity lineage that migration
 *  produces deserves a non-repudiable `passport.imported` receipt in the
 *  RESTORED db's audit ledger — but the restore can't write it directly:
 *  `runImport` renames the live db to `.bak` and the staged db onto `dbPath`,
 *  so any row written DURING the import lands on the discarded db.
 *
 *  The fix is a two-step hand-off across the restart, carried by a marker
 *  FILE in `dataPath` (which the swap never touches — only db/sidecars/config
 *  move):
 *    1. STAGE (`stageRestoreProvenanceMarker`) — after a restore commits, drop
 *       the archive's embedded passport into `<dataPath>/<marker>`.
 *    2. COMMIT (`commitRestoreProvenanceAtBoot`) — on the next boot, after the
 *       signing identity is up, re-verify + record the lineage into the live
 *       (restored) db, then clear the marker.
 *
 *  Best-effort + fail-open throughout. The provenance row is an informational
 *  receipt — the identity migration ITSELF already happened via the db swap,
 *  and the cloud handle re-anchor is owned by `handle-provisioner.ts`. So a
 *  malformed / unverifiable / duplicate marker is logged and CLEARED rather
 *  than failing the restore or wedging the boot (an unclearable marker would
 *  brick every subsequent boot — never acceptable for an informational row).
 *  A SAME-realm restore (rollback / own backup) lands as `commitImportedPassport`
 *  `same_identity` and is cleared silently — there is no lineage to record.
 */

import {
  existsSync,
  readFileSync,
  unlinkSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import type { ServerPassportProjection } from '@recued/contracts';

import type { Ed25519Keypair } from '../keys/index.js';
import { commitImportedPassport, type PassportAuditEmitter } from '../passport/index.js';
import { fsyncDir, writeFileAtomicSync } from '../durable-fs.js';

/** Marker filename in the server data dir. Dot-prefixed + `recued-`-namespaced
 *  so it reads as transient infra (like the instance lock), not user data. It
 *  survives the restore's atomic db swap because the swap only moves
 *  `dbPath` + its WAL/SHM sidecars + the config file. */
export const RESTORE_PROVENANCE_MARKER_FILE = '.recued-restore-provenance.json';

/** Marker envelope version — bumped if the on-disk shape ever changes so an
 *  old marker from a prior binary is recognised + skipped rather than
 *  mis-parsed. */
const MARKER_VERSION = 1 as const;

/** Attribution stamped onto the `passport.imported` row. There is no
 *  interactive client at boot time, so this names the mechanism (the restore
 *  committed at boot), not a paired instance — mirrors the export-embed
 *  sentinel `ARCHIVE_PASSPORT_EXPORTED_BY`. */
export const RESTORE_PROVENANCE_IMPORTED_BY = 'archive-restore-boot';

interface RestoreProvenanceMarker {
  v: typeof MARKER_VERSION;
  /** The archive's embedded signed `migration_full` passport (re-verified at
   *  commit time — never trusted as-is). */
  passport: ServerPassportProjection;
  /** Unix-ms the restore committed. Informational only. */
  restored_at: number;
}

/** Absolute path of the restore-provenance marker for a given data dir. */
export const restoreProvenanceMarkerPath = (dataPath: string): string =>
  join(dataPath, RESTORE_PROVENANCE_MARKER_FILE);

/** Delete a marker durably. Marker absence is meaningful here: a power-loss
 *  resurrection could otherwise record a prior restore's passport against the
 *  current database on the next boot. */
const clearMarker = (markerPath: string): void => {
  unlinkSync(markerPath);
  fsyncDir(dirname(markerPath));
};

/** STAGE — make the `dataPath` marker reflect THIS committed restore so the
 *  next boot records the right migration lineage. The `passportBytes` are the
 *  archive's verified `passport.json` record (a signed projection) when present.
 *
 *  A committed restore DEFINES the current provenance, so the marker is
 *  CLEAR-FIRST-then-write, never skip: it unconditionally drops any marker a
 *  PRIOR restore left, then writes this archive's passport (when present). The
 *  clear-first ordering closes a false-provenance hole — two committed
 *  restores with no intervening boot (reachable on the offline CLI path) where
 *  a no-passport restore follows a with-passport one would otherwise leave the
 *  FIRST archive's passport to be recorded against the SECOND restore's db
 *  (Codex S1 HIGH). Clearing BEFORE the write also degrades a write failure /
 *  crash in the write→rename gap to NO provenance rather than the prior
 *  archive's stale passport (Codex S1 MEDIUM) — the safe direction, since the
 *  identity migration itself already happened via the db swap.
 *
 *  Best-effort: a parse / write / clear failure is logged, never fails the
 *  restore (the receipt is not the migration). No concurrent reader exists
 *  (the boot hook and a restore commit never overlap), so the brief
 *  marker-absent window the clear-first opens is harmless. */
export const stageRestoreProvenanceMarker = (
  dataPath: string,
  passportBytes: Buffer | undefined,
  opts: {
    now?: () => number;
    warn?: (message: string) => void;
    /** Deterministic fault-injection seam; production uses the durable shared
     *  atomic writer whose stranded temps are owned by the boot sweep. */
    writeMarker?: (path: string, body: Buffer) => void;
  } = {},
): void => {
  const warn = opts.warn ?? ((message) => console.warn(message));
  const markerPath = restoreProvenanceMarkerPath(dataPath);

  let serialized: Buffer | undefined;
  if (passportBytes) {
    try {
      const passport = JSON.parse(
        passportBytes.toString('utf8'),
      ) as ServerPassportProjection;
      const marker: RestoreProvenanceMarker = {
        v: MARKER_VERSION,
        passport,
        restored_at: (opts.now ?? Date.now)(),
      };
      serialized = Buffer.from(JSON.stringify(marker), 'utf8');
    } catch (err) {
      // The archive itself verified (every GCM tag + the HMAC), so an
      // unparseable passport is near-impossible — but if it happens, record NO
      // provenance for this restore (fall through to the clear) rather than
      // leaving a stale marker to mislead the boot.
      warn(
        `[archive] restore-provenance passport unparseable (clearing any stale marker): ${(err as Error).message}`,
      );
    }
  }

  // Clear any prior restore's marker FIRST, so a write failure / crash below
  // degrades to no provenance, never the prior archive's stale passport.
  try {
    if (existsSync(markerPath)) clearMarker(markerPath);
  } catch (err) {
    warn(
      `[archive] restore-provenance stale-marker clear failed: ${(err as Error).message}`,
    );
  }
  if (!serialized) return;
  try {
    (opts.writeMarker ?? writeFileAtomicSync)(markerPath, serialized);
  } catch (err) {
    warn(
      `[archive] restore-provenance marker write failed (no provenance recorded): ${(err as Error).message}`,
    );
  }
};

export interface CommitRestoreProvenanceAtBootArgs {
  /** Server data dir (`dirname(dbPath)`) holding the marker. */
  dataPath: string;
  /** Per-call live identity getter — its fingerprint is the NEW publisher_id
   *  the lineage records against (read AFTER `bootSigningIdentity()`). */
  serverIdentity: () => Ed25519Keypair;
  /** High-assurance audit sink (the `passport.imported` row auto-signs). */
  audit: PassportAuditEmitter;
  /** Clock seam (tests). Defaults to `Date.now`. */
  now?: () => number;
  warn?: (message: string) => void;
}

/** COMMIT — on boot, if a restore staged a provenance marker, record the
 *  old→new identity lineage into the (now-restored) audit ledger, then clear
 *  the marker. Fail-open: ANY outcome (recorded, `same_identity` no-op,
 *  verification reject, or a thrown error) clears the marker — never wedge a
 *  boot, never retry forever. Returns nothing; observability is via the audit
 *  row + the boot log. Safe to call unconditionally every boot (a no-op when
 *  no marker is present). */
export const commitRestoreProvenanceAtBoot = async (
  args: CommitRestoreProvenanceAtBootArgs,
): Promise<void> => {
  const warn = args.warn ?? ((message) => console.warn(message));
  const markerPath = restoreProvenanceMarkerPath(args.dataPath);
  if (!existsSync(markerPath)) return;

  try {
    const marker = JSON.parse(
      readFileSync(markerPath, 'utf8'),
    ) as Partial<RestoreProvenanceMarker>;
    if (marker.v !== MARKER_VERSION || !marker.passport) {
      warn(
        `[archive] restore-provenance marker unrecognised (v=${String(marker.v)}); clearing without recording`,
      );
      return;
    }
    const result = await commitImportedPassport({
      passport: marker.passport,
      serverIdentity: args.serverIdentity(),
      audit: args.audit,
      imported_by_client_id: RESTORE_PROVENANCE_IMPORTED_BY,
      ...(args.now !== undefined ? { now: args.now } : {}),
    });
    if (result.ok) {
      // Boot-log breadcrumb (stderr — the boot path's log channel).
      console.error(
        `[archive] restore provenance recorded: ${result.previous_publisher_id} → ${result.new_publisher_id}` +
          (result.handle_reanchor_pending ? ' (handle re-anchor pending)' : ''),
      );
    } else if (result.reason !== 'same_identity') {
      // `same_identity` = a same-realm restore (rollback / own backup): no
      // lineage to record, cleared silently. Any OTHER reject means the
      // embedded passport failed re-verification — log it (the archive itself
      // verified, so this is unexpected) and clear.
      warn(
        `[archive] restore-provenance commit rejected (${result.reason}); clearing without recording`,
      );
    }
  } catch (err) {
    warn(
      `[archive] restore-provenance commit failed (clearing, no retry): ${(err as Error).message}`,
    );
  } finally {
    try {
      clearMarker(markerPath);
    } catch {
      /* best effort — a leftover marker only risks a duplicate no-op next boot */
    }
  }
};
