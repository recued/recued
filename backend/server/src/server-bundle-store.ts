/** Server vault bundle persistence — a filesystem sidecar beside the realm db.
 *
 *  The server stores ONE dual-wrapped `ServerBundle` per realm: the Master DEK
 *  wrapped under both the keyfile-held server key and the user's recovery key.
 *  First-boot enrollment writes it; every subsequent boot can read it BEFORE
 *  opening SQLite and auto-unlock the same Master DEK.
 *
 *  D-212 deliberately keeps this separate from BOTH the database and the
 *  keyfile. The database cannot contain the material needed to decrypt itself,
 *  and keying the database directly from the keyfile would make a lost keyfile
 *  unrecoverable. A backup containing the database + this sidecar, but not the
 *  keyfile, remains recoverable with the 24-word recovery key.
 *
 *  The sidecar is atomically replaced (fsync temp -> rename) and mode 0600.
 *  The bundle is wrapped rather than plaintext key material, but keeping the
 *  file owner-only avoids widening access to recovery-critical metadata.
 */

import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  serverBundleToJSON,
  serverBundleFromJSON,
  type ServerBundle,
} from '@recued/crypto';
import { writeFileAtomicSync } from './durable-fs.js';

/** Kept as a suffix (rather than one fixed filename) so two explicitly named
 *  realm dbs in the same directory cannot share encryption state by accident. */
export const SERVER_BUNDLE_SIDECAR_SUFFIX = '.server-vault-bundle.json';

/** Resolve the canonical bundle sidecar for one realm db. */
export const resolveServerBundlePath = (dbPath: string): string =>
  `${resolve(dbPath)}${SERVER_BUNDLE_SIDECAR_SUFFIX}`;

export interface ServerBundleStore {
  /** Absolute path of this realm's bundle sidecar. */
  readonly path: string;
  /** Read the stored server bundle, or null when encryption is not yet
   *  enrolled on this realm. A present-but-malformed file throws: corrupt
   *  encryption state must never be mistaken for a fresh realm. */
  load(): ServerBundle | null;
  /** Persist the server bundle (overwrites — used only at first-boot
   *  enrollment + future recovery-key rotation; auto-unlock is read-only). */
  save(bundle: ServerBundle): void;
  /** Clear the stored bundle. Operator-side factory-reset only; never a
   *  remote client. */
  clear(): void;
  /** True when a server bundle sidecar exists for this realm. */
  exists(): boolean;
}

// This store's copy of the pattern was the correct one; it now lives in
// `durable-fs.ts` so the keyfile writer cannot drift from it again.
const writeAtomic = (path: string, body: string): void => {
  writeFileAtomicSync(path, body);
};

export const createServerBundleStore = (dbPath: string): ServerBundleStore => {
  const path = resolveServerBundlePath(dbPath);

  return {
    path,

    load() {
      if (!existsSync(path)) return null;
      const raw = readFileSync(path, 'utf8');
      try {
        return serverBundleFromJSON(raw);
      } catch (err) {
        throw new Error(
          `server-bundle-store: ${path} is unreadable: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },

    save(bundle) {
      writeAtomic(path, serverBundleToJSON(bundle));
    },

    clear() {
      try {
        unlinkSync(path);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    },

    exists() {
      return existsSync(path);
    },
  };
};
