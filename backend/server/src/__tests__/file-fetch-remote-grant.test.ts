/** The `core.storage.file.fetch-remote` gate — the ONE grant that answers "may bytes
 *  be fetched from a connected vendor", asked inside `resolveRemoteFileBytes` because
 *  that is the single function BOTH remote-reach routes funnel through
 *  (`handleFileRead`'s `file:remote:*` branch and the CLI executor's
 *  `input_materialize` reader).
 *
 *  ⛔ THE RATCHET AT THE BOTTOM IS THE POINT OF THIS FILE. A gate at a shared boundary
 *  only holds while the boundary is shared — a third caller that reaches a per-vendor
 *  resolver directly would bypass it with nothing failing, which is exactly the shape
 *  the `file.search` collection fence failed in (a fence hand-added per handler, and
 *  one handler never got it). */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  OWNER_CONTRACT_ID,
  RpcError,
  opGrantEntry,
  KERNEL_OP_REGISTRY,
  type FileMetaProjection,
} from '@recued/contracts';

import {
  resolveRemoteFileBytes,
  EMPTY_REMOTE_FILE_BYTE_RESOLVERS,
  type RemoteFileReadDeps,
} from '../collections/file/remote-file-byte-resolver.js';
import { remoteFileRecordId } from '../file-view-resolver.js';
import { reconcileOwnerGrants } from '../owner-grant-reconcile.js';
import { FILE_FETCH_REMOTE_OP, createRemoteFetchAdmitter } from '../remote-fetch-admission.js';
import { createContractStore } from '../storage/contract-store.js';
import { createContractGrantEntryStore } from '../storage/contract-grant-entry-store.js';
import type { FileConnectionCredential, FileConnectionResolver } from '../file-source-adapters/index.js';
import type { FileMetaRow, FileMetaStore } from '../storage/file-meta-store.js';

const FETCH_REMOTE_OP = FILE_FETCH_REMOTE_OP;
const SCOPE = 'notion.myconn.file';
const TARGET = 'block-1';
const RECORD_ID = remoteFileRecordId(SCOPE, TARGET);

const projection: FileMetaProjection = {
  filename: 'report.pdf',
  provider: 'notion',
  remote_id: 'block-1',
};
const row: FileMetaRow = {
  scope: SCOPE,
  target_id: TARGET,
  meta: { ...projection, snapshot_hash: 'h', snapshot_at: 1 },
};
const cred: FileConnectionCredential = { auth: { type: 'bearer', token: 't' } as never, config: {} };

/** Counting stubs — a denial must not merely fail, it must fail BEFORE the mirror is
 *  read and BEFORE a credential is decrypted. */
const countingDeps = (admit?: () => boolean) => {
  const calls = { metaGet: 0, resolveConnection: 0, vendor: 0 };
  const fileMetaStore = {
    get: (scope: string, target_id: string) => {
      calls.metaGet += 1;
      return scope === SCOPE && target_id === TARGET ? row : null;
    },
  } as unknown as FileMetaStore;
  const resolveConnection: FileConnectionResolver = async () => {
    calls.resolveConnection += 1;
    return cred;
  };
  const deps: RemoteFileReadDeps = {
    fileMetaStore,
    resolveConnection,
    byteResolvers: {
      ...EMPTY_REMOTE_FILE_BYTE_RESOLVERS,
      notion: async () => {
        calls.vendor += 1;
        return { bytes: Buffer.from('hi') };
      },
    },
    ...(admit !== undefined ? { admitRemoteFetch: admit } : {}),
  };
  return { deps, calls };
};

const codeOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return '<no throw>';
  } catch (err) {
    if (err instanceof RpcError) return err.code;
    throw err;
  }
};

describe('core.storage.file.fetch-remote — the remote-byte gate', () => {
  it('is a registered kernel op, so the owner reconcile seeds a revocable row for it', () => {
    // ⚠ Derived from the registry, never hand-listed: an op that is not IN the
    // registry gets no seeded row, and a gate reading an unseeded id is a gate the
    // owner cannot reach from the Contracts UI.
    expect(KERNEL_OP_REGISTRY.some((e) => e.op === FETCH_REMOTE_OP)).toBe(true);

    const db = new Database(':memory:');
    try {
      const store = createContractStore(db);
      reconcileOwnerGrants(store, () => 1_750_000_000_000);
      const grants = createContractGrantEntryStore(store);
      expect(grants.get(OWNER_CONTRACT_ID, opGrantEntry(FETCH_REMOTE_OP))).toBe(true);
    } finally {
      db.close();
    }
  });

  it('DENIES with remote_fetch_not_granted, and touches nothing on the way out', async () => {
    const { deps, calls } = countingDeps(() => false);
    expect(await codeOf(resolveRemoteFileBytes(deps, RECORD_ID))).toBe('remote_fetch_not_granted');
    // ⛔ The assertion that makes this a gate rather than an error message: a revoked
    // capability performs no mirror read and decrypts no connection.
    expect(calls).toEqual({ metaGet: 0, resolveConnection: 0, vendor: 0 });
  });

  it('ADMITS when granted — the same call succeeds end to end', async () => {
    const { deps, calls } = countingDeps(() => true);
    const out = await resolveRemoteFileBytes(deps, RECORD_ID);
    expect(out.bytes.toString()).toBe('hi');
    expect(calls.vendor).toBe(1);
  });

  it('ADMITS when no predicate is wired (additive, matching every other grant seam)', async () => {
    const { deps, calls } = countingDeps(undefined);
    const out = await resolveRemoteFileBytes(deps, RECORD_ID);
    expect(out.bytes.toString()).toBe('hi');
    expect(calls.vendor).toBe(1);
  });

  it('the DENIAL is distinguishable from an unwired vendor and a missing connection', async () => {
    // A caller that cannot tell "you turned this off" from "this is broken" sends the
    // owner to debug a setting they chose.
    const denied = countingDeps(() => false);
    const unsupported = countingDeps(() => true);
    unsupported.deps.byteResolvers = EMPTY_REMOTE_FILE_BYTE_RESOLVERS;
    const gone = countingDeps(() => true);
    gone.deps.resolveConnection = async () => null;

    expect(await codeOf(resolveRemoteFileBytes(denied.deps, RECORD_ID)))
      .toBe('remote_fetch_not_granted');
    expect(await codeOf(resolveRemoteFileBytes(unsupported.deps, RECORD_ID)))
      .toBe('remote_provider_unsupported');
    expect(await codeOf(resolveRemoteFileBytes(gone.deps, RECORD_ID)))
      .toBe('file_storage_missing');
  });
});

// ────────────────────────────────────────────────────────────────
// The ratchet
// ────────────────────────────────────────────────────────────────

const SRC = join(import.meta.dirname, '..');
const walk = (dir: string, out: string[] = []): string[] => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === '__tests__' || name === 'node_modules') continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith('.ts')) out.push(p);
  }
  return out;
};

describe('the gate holds only while the boundary is shared', () => {
  /** ⛔⛔ The whole design is "one grant, because both routes funnel through one
   *  function". A THIRD caller is not a bug in itself — it is a caller that must be
   *  looked at, because reaching remote bytes any other way skips the gate silently.
   *  Listing the known callers here means adding one is a deliberate act. */
  it('resolveRemoteFileBytes has only the reviewed callers', () => {
    const callers = walk(SRC)
      .filter((f) => !f.endsWith('remote-file-byte-resolver.ts'))
      .filter((f) => /\bresolveRemoteFileBytes\s*\(/.test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(SRC.length + 1).replaceAll('\\', '/'))
      .sort();
    // ⛔ `dev/` IS STILL WALKED — this is NOT the blanket exclusion the comment
    // below rules out. The census still covers dev/, so a NEW caller parked there
    // fails this exactly as before. Only the KNOWN drive is conditional, and only
    // on whether its file exists: the public export does not ship `dev/`, so a
    // hard-coded third entry made this ratchet fail in the public tree over a file
    // that legitimately cannot be there — asserting the shape of the PRIVATE tree
    // rather than the boundary.
    const devDrive = 'dev/remote-fetch-grant-drive.ts';
    expect(callers).toEqual([
      // Paired-owner cloud attachment import: same grant at fetch, rechecked before retaining bytes.
      'cloud-file-attachments.ts',
      // The `file:remote:*` branch of the kernel file read.
      'collections/file/file-read-handler.ts',
      // The CLI executor's `input_materialize` reader — the route the shipped
      // corpus actually uses (45 of 46 call sites pass a dynamic `source`).
      'composition/bin/wire-execute-deps.ts',
      // ⚠ The live gate drive, listed rather than excused by excluding `dev/`.
      // A blanket exclusion would also excuse a real bypass parked under dev/,
      // and this ratchet's whole value is that a new caller has to be TYPED HERE.
      // (It caught this very file the moment the drive was written.)
      ...(existsSync(join(SRC, devDrive)) ? [devDrive] : []),
    ]);
  });

  /** ⛔ And the resolvers themselves must stay reachable ONLY through the orchestrator
   *  — importing one directly is the bypass this file exists to prevent. */
  it('no module reaches a per-vendor byte resolver directly', () => {
    const direct = walk(SRC)
      .filter((f) => !f.includes('remote-byte-resolvers'))
      .filter((f) => /from ['"].*remote-byte-resolvers\/(?!index)/.test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(SRC.length + 1));
    expect(direct).toEqual([]);
  });
});

describe('createRemoteFetchAdmitter — the four states that collapse into one boolean', () => {
  const NOW = 1_750_000_000_000;
  const withStore = <T>(fn: (s: ReturnType<typeof createContractStore>) => T): T => {
    const db = new Database(':memory:');
    try { return fn(createContractStore(db, { now: () => NOW })); } finally { db.close(); }
  };

  it('ADMITS when there is no contract store at all (a server with no substrate yet)', () => {
    expect(createRemoteFetchAdmitter(() => undefined)()).toBe(true);
  });

  it('ADMITS when no row exists yet (the pre-seed window — deny here would dark-boot it)', () => {
    withStore((store) => {
      const grants = createContractGrantEntryStore(store);
      expect(grants.get(OWNER_CONTRACT_ID, opGrantEntry(FETCH_REMOTE_OP))).toBeUndefined();
      expect(createRemoteFetchAdmitter(() => store)()).toBe(true);
    });
  });

  it('ADMITS on the seeded grant', () => {
    withStore((store) => {
      reconcileOwnerGrants(store, () => NOW);
      expect(createRemoteFetchAdmitter(() => store)()).toBe(true);
    });
  });

  it('DENIES on an explicit owner revoke — and the SAME predicate flips, not a copy', () => {
    withStore((store) => {
      reconcileOwnerGrants(store, () => NOW);
      const admit = createRemoteFetchAdmitter(() => store);
      expect(admit()).toBe(true);
      createContractGrantEntryStore(store)
        .set(OWNER_CONTRACT_ID, opGrantEntry(FETCH_REMOTE_OP), false, NOW);
      // ⚠ The same closure, re-invoked — reading at CALL time is what lets a revoke
      // take effect without a restart, and a memoised read would pass the assertion
      // above and fail this one.
      expect(admit()).toBe(false);
    });
  });

  it('a revoke reaches resolveRemoteFileBytes through the real predicate', async () => {
    await withStore(async (store) => {
      reconcileOwnerGrants(store, () => NOW);
      createContractGrantEntryStore(store)
        .set(OWNER_CONTRACT_ID, opGrantEntry(FETCH_REMOTE_OP), false, NOW);
      const { deps, calls } = countingDeps(createRemoteFetchAdmitter(() => store));
      expect(await codeOf(resolveRemoteFileBytes(deps, RECORD_ID)))
        .toBe('remote_fetch_not_granted');
      expect(calls).toEqual({ metaGet: 0, resolveConnection: 0, vendor: 0 });
    });
  });
});
