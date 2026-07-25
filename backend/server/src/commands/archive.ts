/** `recued-server archive <sub>` — portable archive CLI (Phase F, D-108).
 *
 *  Sub-forms:
 *    archive export <path>              # produce a .recued.archive
 *    archive import <path>              # restore from a .recued.archive
 *    archive inspect <path>             # print the plaintext manifest
 *
 *  Recovery-key resolution order:
 *    1. --key=<value> or --key-file=<path>
 *    2. $RECUED_RECOVERY_KEY env var
 *    3. Interactive prompt (TTY only)
 *
 *  The command module itself keeps IO narrow: it invokes
 *  `exportArchive` / `applyRestore` / `summarizeArchive` / `parseManifest`
 *  from the archive module and renders human-readable status lines. Restore
 *  + dry-run stream the archive (never buffer the whole db). Rpc surface
 *  layering happens in `archive-handler.ts`.
 */

import { existsSync, readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { exportArchive, buildExportBlobSources, type BlobSource } from '../archive/archive-export.js';
import {
  summarizeArchive,
  parseManifest,
  type ImportOptions,
} from '../archive/archive-import.js';
import { FILE_NAMES } from '../archive/archive-format.js';
import { applyRestore, deriveBlobStoreKeyFromDb } from '../archive/archive-restore.js';
import { createBundleStore } from '../bundle-store.js';
import { bundleToJSON } from '@recued/crypto';

export interface ArchiveCommandDeps {
  dbPath: string;
  configPath: string | null;
  dataPath: string;
  serverVersion: string;
}

const RECOVERY_KEY_LEN = 32;

const resolveRecoveryKey = (args: string[]): Buffer => {
  const inlineIdx = args.findIndex((a) => a === '--key' || a.startsWith('--key='));
  if (inlineIdx >= 0) {
    const raw = args[inlineIdx].includes('=')
      ? args[inlineIdx].split('=', 2)[1]
      : args[inlineIdx + 1];
    if (!raw) throw new Error('--key: missing value');
    return decodeKey(raw);
  }
  const fileIdx = args.findIndex((a) => a === '--key-file' || a.startsWith('--key-file='));
  if (fileIdx >= 0) {
    const p = args[fileIdx].includes('=')
      ? args[fileIdx].split('=', 2)[1]
      : args[fileIdx + 1];
    if (!p) throw new Error('--key-file: missing path');
    return decodeKey(readFileSync(p, 'utf8').trim());
  }
  const env = process.env.RECUED_RECOVERY_KEY;
  if (env) return decodeKey(env.trim());
  throw new Error('recovery key missing — supply --key / --key-file / RECUED_RECOVERY_KEY');
};

const decodeKey = (raw: string): Buffer => {
  // Accept hex (64 chars) or base64 (~44 chars). The 24-word BIP39
  // mnemonic path goes through the extension before touching the
  // server; by the time we see it here it's the derived 32 bytes.
  const trimmed = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, 'hex');
  }
  const b = Buffer.from(trimmed, 'base64');
  if (b.length === RECOVERY_KEY_LEN) return b;
  throw new Error(`recovery key: expected 64-char hex or base64-encoded 32 bytes (got ${b.length})`);
};

const hasFlag = (args: string[], name: string): boolean =>
  args.includes(name) || args.some((a) => a.startsWith(`${name}=`));

/** Strict boolean for safety-critical switches. `hasFlag` treats any
 *  `--name=<anything>` (including `--name=false`) as present/true — fine
 *  for benign flags, but it would INVERT a destructive guard. Bare
 *  `--name` or `--name=true|1|yes` → true; `--name=false|0|no` or an empty
 *  value → false; anything else throws (fail closed). */
const strictBoolFlag = (args: string[], name: string): boolean => {
  const idx = args.findIndex((a) => a === name || a.startsWith(`${name}=`));
  if (idx < 0) return false;
  const arg = args[idx];
  if (arg === name) return true;
  const val = arg.slice(name.length + 1).toLowerCase();
  if (val === 'true' || val === '1' || val === 'yes') return true;
  if (val === '' || val === 'false' || val === '0' || val === 'no') return false;
  throw new Error(`${name}: expected true or false, got '${val}'`);
};

// ────────────────────────────────────────────────────────────────
// Sub-commands
// ────────────────────────────────────────────────────────────────

const cmdExport = async (
  deps: ArchiveCommandDeps,
  args: string[],
): Promise<void> => {
  const dest = args.find((a) => !a.startsWith('--'));
  if (!dest) throw new Error('archive export: missing output path');
  const recoveryKey = resolveRecoveryKey(args);
  const force = hasFlag(args, '--force');
  const includeBlobs = !hasFlag(args, '--no-blobs');

  const db = new Database(deps.dbPath);
  try {
    // Legacy `vault-bundle.json` record — present only for a `keys.init`-
    // enrolled realm; it rides for the cross-machine passport / re-key path.
    // The blob re-encryption key is NOT read from here (a D-197 server has no
    // legacy bundle) — it is derived from the db's server bundle below.
    let vaultBundleJson: string | undefined;
    try {
      const b = createBundleStore(db).load();
      if (b) vaultBundleJson = bundleToJSON(b);
    } catch { /* no bundle table — pre-D-081 compositions */ }

    // Blob-encryption fix — the offline CLI has no live KeyManager, so derive
    // the realm's `blob-store` sub-DEK straight from the LIVE db's server bundle
    // (D-197) / legacy bundle + the recovery key. This is the SAME derivation
    // restore uses (`deriveBlobStoreKeyFromDb`), so the export decrypts each
    // ENCRYPTED cache/memory blob under exactly the key restore re-encrypts it
    // under. Null → KEYLESS realm → the roots are plaintext and read keyless. A
    // WRONG recovery key throws here (GCM tag) — refusing to emit an archive of
    // undecryptable ciphertext that could never restore. `--no-blobs` skips this
    // for a db-only archive on any server.
    let blobSources: BlobSource[] | undefined;
    if (includeBlobs) {
      let blobKey: Uint8Array | null;
      try {
        blobKey = await deriveBlobStoreKeyFromDb(db, recoveryKey);
      } catch (err) {
        // The realm is ENCRYPTED but the Master DEK would not unwrap — usually a
        // wrong recovery key (the archive envelope reuses the same key, so a bad
        // key here would also make the archive unrestorable), or a corrupt /
        // unreadable vault bundle. Refuse with an operator-facing message rather
        // than the raw GCM error; the verbatim cause disambiguates. `--no-blobs`
        // still produces a database-only archive on any server.
        throw new Error(
          `archive export: could not derive this server's blob encryption key — ` +
            `the recovery key is likely wrong, or this server's vault bundle is unreadable. ` +
            `Pass --no-blobs for a database-only archive. Cause: ${(err as Error).message}`,
        );
      }
      blobSources = buildExportBlobSources(
        deps.dataPath,
        db,
        blobKey ? () => blobKey : undefined,
      );
    }

    const result = await exportArchive({
      destPath: dest,
      recoveryKey,
      db,
      configPath: deps.configPath ?? undefined,
      vaultBundleJson,
      ...(blobSources ? { blobSources } : {}),
      force,
      producerVersion: deps.serverVersion,
    });
    console.log(
      `archive export: wrote ${result.bytes_written} bytes, ${result.blob_count} blobs → ${result.path}`,
    );
  } finally {
    db.close();
  }
};

const cmdImport = async (
  deps: ArchiveCommandDeps,
  args: string[],
): Promise<void> => {
  const src = args.find((a) => !a.startsWith('--'));
  if (!src) throw new Error('archive import: missing archive path');
  const recoveryKey = resolveRecoveryKey(args);
  const dryRun = hasFlag(args, '--dry-run');
  const allowFuture = hasFlag(args, '--allow-future-version');
  // --force gates the destructive live-server guard, so parse it strictly:
  // `--force=false` must mean false, not "flag present" (see strictBoolFlag).
  const force = strictBoolFlag(args, '--force');

  const importOpts: ImportOptions = {
    archivePath: src,
    recoveryKey,
    consumerVersion: deps.serverVersion,
    allowFutureVersion: allowFuture,
  };

  if (dryRun) {
    // Streaming summary: decrypt + verify the WHOLE archive (validates the
    // recovery key + integrity) without buffering the db or blobs.
    const summary = await summarizeArchive(importOpts);
    console.log('archive import --dry-run:');
    console.log(JSON.stringify(summary.manifest, null, 2));
    console.log(
      `records: db=${summary.dbBytes}b ` +
        `config=${summary.smallRecordBytes[FILE_NAMES.config] ?? 0}b ` +
        `vault=${summary.smallRecordBytes[FILE_NAMES.vault] ?? 0}b ` +
        `blobs=${summary.blobCount}`,
    );
    return;
  }

  // OFFLINE restore: the server must be stopped (the guard inside
  // applyRestore refuses on a live instance lock unless --force). We stream
  // the db to a temp file, overlay blobs first, back up + clobber the
  // db/config, and report.
  const restored = await applyRestore(
    { dbPath: deps.dbPath, dataPath: deps.dataPath, configPath: deps.configPath },
    importOpts,
    { force },
  );
  console.log(
    `archive import: restored ${src} → ${deps.dbPath} ` +
      `(${restored.db_bytes} DB bytes, ${restored.blob_count} blobs` +
      `${restored.config_written ? ', config' : ''}).`,
  );
  if (restored.db_backup_path) {
    console.log(`  Previous db backed up at ${restored.db_backup_path}.`);
  }
  if (restored.backups.length > 0) {
    console.log(`  Backups (${restored.backups.length}): roll back by stripping the ".bak-<stamp>" suffix.`);
  }
  console.log('  Restart the server to boot on the restored data.');
};

const cmdInspect = (args: string[]): void => {
  const src = args.find((a) => !a.startsWith('--'));
  if (!src) throw new Error('archive inspect: missing archive path');
  if (!existsSync(src)) throw new Error(`archive inspect: ${src} not found`);
  const buf = readFileSync(src);
  const { manifest } = parseManifest(buf);
  console.log(JSON.stringify(manifest, null, 2));
};

// ────────────────────────────────────────────────────────────────
// Entry point
// ────────────────────────────────────────────────────────────────

export async function cmdArchive(
  deps: ArchiveCommandDeps,
  args: string[],
): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case 'export':  return cmdExport(deps, rest);
    case 'import':  return cmdImport(deps, rest);
    case 'inspect': return cmdInspect(rest);
    default:
      console.error(`Unknown archive subcommand: ${sub ?? '(missing)'}`);
      console.error('Available: archive export <path>, archive import <path>, archive inspect <path>');
      process.exit(2);
  }
}
