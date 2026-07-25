/** D-212 follow-on 2 — the durable record that a keyfile's sealing changed.
 *
 *  `rotate-passphrase` and `recover-keyfile` both change how the realm's keys
 *  are protected, and neither could write an audit row: the server is STOPPED,
 *  so there is no audit log to write to. What existed was the `.pre-rotate-<ms>`
 *  backup's filename — durable, timestamped, and unable to answer the question
 *  you actually ask after a compromise: *when did the sealing factor last
 *  change, and did I do it?*
 *
 *  ⛔ The property under test is END TO END: the CLI-side write and the
 *  boot-side replay are two processes and neither is the feature on its own.
 *  Tests that only prove "a line was appended" would pass with nothing reading
 *  it — the "documented deferral becomes a bypass" shape this was deliberately
 *  not half-built into.
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateRecoveryKey } from '@recued/crypto';
import { HIGH_ASSURANCE_AUDIT_KINDS } from '@recued/contracts';
import {
  RESERVE_ACTIONS,
  createAuditLogStore,
  createInMemoryCollection,
  type ActivityEntry,
  type AuditEntry,
} from '@recued/storage';
import { createSigningAuditLog, verifyActivityEntry } from '../audit/signing.js';

import { generateEd25519Keypair } from '../keys/index.js';
import { createFileServerKeyStore } from '../keys/file-store.js';
import {
  createKeyfileEventLedger,
  keyfileEventLedgerPath,
  recordKeyfileEvent,
} from '../keys/keyfile-event-ledger.js';
import {
  KEYFILE_EVENT_REPLAY_PREFIX,
  replayKeyfileEventsIntoAudit,
  type KeyfileEventAuditSink,
} from '../keys/keyfile-event-replay.js';
import { bootServerIdentity, resolveIdentityKeysPath } from '../identity/boot.js';
import { rotateKeyfilePassphrase } from '../keyfile-passphrase-rotation.js';
import { regenerateKeyfileFromRecoveryKey } from '../keyfile-recovery.js';
import { createServerBundleStore } from '../server-bundle-store.js';
import { enrollRealmRecoveryKey } from '../server-vault-enrollment.js';
import { createRecoveryKeyCheckStore } from '../recovery-key-store.js';
import { createKeyManager } from '../key-manager.js';
import { openDatabase } from '../open-database.js';

const FAST = { t: 1, m: 8, p: 1 };
const OLD = 'the-passphrase-in-use';
const NEW = 'a-different-passphrase';

let dir: string;
const dbPath = (): string => join(dir, 'recued-server.db');
const keyfile = (): string => resolveIdentityKeysPath(dbPath());

const bundleSlots = (path: string) => {
  const store = createServerBundleStore(path);
  return {
    loadBundle: () => null,
    saveBundle: () => {},
    loadServerBundle: () => store.load(),
    saveServerBundle: (b: Parameters<typeof store.save>[0]) => { store.save(b); },
  };
};

/** A realm enrolled + encrypted with a signing identity, keyfile sealed by
 *  `OLD`. Returns the recovery key so the regeneration path can use it. */
const enrolledRealm = async (): Promise<string> => {
  const { mnemonic } = generateRecoveryKey();
  const database = await openDatabase(dbPath(), { databaseKey: null });
  const keyStore = await createFileServerKeyStore({
    filePath: keyfile(), passphrase: OLD, argon2_params: FAST,
  });
  try {
    const res = await enrollRealmRecoveryKey({
      recoveryKeyCheck: createRecoveryKeyCheckStore(database),
      recoveryKey: mnemonic,
      keys: createKeyManager(bundleSlots(dbPath())),
      keyStore,
      database,
    });
    expect(res.ok).toBe(true);
    await keyStore.flush?.();
  } finally {
    database.close();
  }
  const booted = await bootServerIdentity({
    dbPath: dbPath(), passphrase: OLD, argon2_params: FAST, machineSealing: false,
  });
  await booted.keyStore.flush?.();
  return mnemonic;
};

/** An in-memory stand-in for the D-120 activity log. Records everything so a
 *  test can assert the exact row a boot would write. */
const fakeAudit = (): KeyfileEventAuditSink & {
  rows: Array<{ activity_id: string; timestamp: number; action: string; target: string; detail?: string }>;
} => {
  const rows: Array<{ activity_id: string; timestamp: number; action: string; target: string; detail?: string }> = [];
  return {
    rows,
    listActivities: async () => rows.map((r) => ({ activity_id: r.activity_id })),
    logActivity: async (entry) => { rows.push({ ...entry }); },
  };
};

const detailOf = (row: { detail?: string }): Record<string, unknown> =>
  JSON.parse(row.detail ?? '{}') as Record<string, unknown>;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'd212-kfevent-')); });
afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });

describe('D-212 — a rotation is recorded, and the next boot audits it', () => {
  it('records the rotation and replays it into the audit log', async () => {
    await enrolledRealm();
    await rotateKeyfilePassphrase({
      dbPath: dbPath(), currentPassphrase: OLD, newPassphrase: NEW,
      argon2_params: FAST, now: () => 1_700_000_000_000,
    });

    const audit = fakeAudit();
    expect(await replayKeyfileEventsIntoAudit({ dataPath: dir, auditLog: audit })).toBe(1);

    const [row] = audit.rows;
    expect(row?.action).toBe('keyfile_sealing_changed');
    expect(row?.target).toBe(keyfile());
    // The event's OWN time, not the boot's — a row stamped at replay would say
    // the sealing changed whenever the server next happened to start.
    expect(row?.timestamp).toBe(1_700_000_000_000);
    expect(detailOf(row!)).toMatchObject({
      kind: 'passphrase_rotated',
      posture: 'passphrase',
      previous_keyfile: `${keyfile()}.pre-rotate-1700000000000`,
      recorded_at_boot: true,
    });
  });

  it('records a regeneration with the NEW identity and the posture it landed on', async () => {
    // The costly path: the realm is rescued and the identity is destroyed. The
    // fingerprint here is the one every paired device is about to reject, and
    // the posture is what says whether an unattended recovery landed UNSEALED.
    const mnemonic = await enrolledRealm();
    const before = await createFileServerKeyStore({
      filePath: keyfile(), passphrase: OLD, argon2_params: FAST, warn: () => {},
    });
    const oldFingerprint = before.loadServerIdentityKey()?.public_key_fingerprint;

    // Make the keyfile unopenable so regeneration's healthy-keyfile guard lets
    // it run — the real entry condition.
    writeFileSync(keyfile(), JSON.stringify({ version: 1, encrypted: false, payload: 'e30=' }));

    const result = await regenerateKeyfileFromRecoveryKey({
      dbPath: dbPath(), recoveryKey: mnemonic, env: {},
      argon2_params: FAST, now: () => 1_700_000_000_001,
    });

    // No passphrase and no machine sealing ⇒ this recovery landed UNSEALED,
    // which is the case the posture field exists for. Pinned explicitly: an
    // assertion against `result.posture` alone would hold for any value.
    expect(result.posture).toBe('none');

    const audit = fakeAudit();
    expect(await replayKeyfileEventsIntoAudit({ dataPath: dir, auditLog: audit })).toBe(1);
    const detail = detailOf(audit.rows[0]!);
    expect(detail).toMatchObject({ kind: 'keyfile_regenerated', posture: 'none' });
    expect(detail.server_identity_fingerprint).toBe(result.serverIdentityFingerprint);
    // The whole point of the row: the identity is NOT the one it was.
    expect(oldFingerprint).toBeTruthy();
    expect(detail.server_identity_fingerprint).not.toBe(oldFingerprint);
  });

  it('keeps BOTH events when two happen before a boot', async () => {
    // ⛔ The reason this is an append-only ledger and not a replace-on-write
    // marker. An attacker's rotation followed by the operator's own, with no
    // boot in between, is exactly the pair worth seeing — and a marker would
    // keep only the second, dropping the one that mattered.
    await enrolledRealm();
    await rotateKeyfilePassphrase({
      dbPath: dbPath(), currentPassphrase: OLD, newPassphrase: NEW,
      argon2_params: FAST, now: () => 1_700_000_000_000,
    });
    await rotateKeyfilePassphrase({
      dbPath: dbPath(), currentPassphrase: NEW, newPassphrase: 'a-third-one',
      argon2_params: FAST, now: () => 1_700_000_000_500,
    });

    const audit = fakeAudit();
    expect(await replayKeyfileEventsIntoAudit({ dataPath: dir, auditLog: audit })).toBe(2);
    expect(audit.rows.map((r) => r.timestamp)).toEqual([1_700_000_000_000, 1_700_000_000_500]);
  });
});

describe('D-212 — the replay is idempotent, and self-heals across a restore', () => {
  it('does not duplicate a row already in the audit log', async () => {
    await enrolledRealm();
    await rotateKeyfilePassphrase({
      dbPath: dbPath(), currentPassphrase: OLD, newPassphrase: NEW, argon2_params: FAST,
    });

    const audit = fakeAudit();
    expect(await replayKeyfileEventsIntoAudit({ dataPath: dir, auditLog: audit })).toBe(1);
    // Every subsequent boot re-reads a ledger that is NEVER cleared.
    expect(await replayKeyfileEventsIntoAudit({ dataPath: dir, auditLog: audit })).toBe(0);
    expect(await replayKeyfileEventsIntoAudit({ dataPath: dir, auditLog: audit })).toBe(0);
    expect(audit.rows).toHaveLength(1);
  });

  it('re-records when the audit rows are gone but the ledger is not', async () => {
    // ⛔ Why idempotency reads the DESTINATION rather than a cursor beside the
    // ledger. A migration-snapshot rollback restores the SQLite file and takes
    // the audit rows with it; a cursor would then say "already replayed" about
    // rows that no longer exist, and the record the out-of-database ledger
    // exists to preserve would be lost by the very event it was built for.
    await enrolledRealm();
    await rotateKeyfilePassphrase({
      dbPath: dbPath(), currentPassphrase: OLD, newPassphrase: NEW, argon2_params: FAST,
    });

    const audit = fakeAudit();
    expect(await replayKeyfileEventsIntoAudit({ dataPath: dir, auditLog: audit })).toBe(1);
    audit.rows.length = 0; // the snapshot restore
    expect(await replayKeyfileEventsIntoAudit({ dataPath: dir, auditLog: audit })).toBe(1);
  });

  it('writes nothing when it cannot read what it already recorded', async () => {
    // Skipping is the safe direction: an unreadable audit log means unknown
    // replay state, and duplicating a security row is worse than deferring it
    // to the next boot. The ledger keeps the entry either way.
    await enrolledRealm();
    await rotateKeyfilePassphrase({
      dbPath: dbPath(), currentPassphrase: OLD, newPassphrase: NEW, argon2_params: FAST,
    });

    const audit = fakeAudit();
    const blind: KeyfileEventAuditSink = {
      listActivities: async () => { throw new Error('audit unreadable'); },
      logActivity: audit.logActivity,
    };
    expect(await replayKeyfileEventsIntoAudit({ dataPath: dir, auditLog: blind })).toBe(0);
    expect(audit.rows).toHaveLength(0);
    // …and the entry is still there for a boot that can read.
    expect(await replayKeyfileEventsIntoAudit({ dataPath: dir, auditLog: audit })).toBe(1);
  });

  it('leaves an entry unreplayed when its audit write fails', async () => {
    await enrolledRealm();
    await rotateKeyfilePassphrase({
      dbPath: dbPath(), currentPassphrase: OLD, newPassphrase: NEW, argon2_params: FAST,
    });

    const audit = fakeAudit();
    let fail = true;
    const flaky: KeyfileEventAuditSink = {
      listActivities: audit.listActivities,
      logActivity: async (e) => {
        if (fail) throw new Error('disk full');
        await audit.logActivity(e);
      },
    };
    expect(await replayKeyfileEventsIntoAudit({ dataPath: dir, auditLog: flaky, warn: () => {} })).toBe(0);
    fail = false;
    expect(await replayKeyfileEventsIntoAudit({ dataPath: dir, auditLog: flaky })).toBe(1);
  });

  it('is a no-op when no keyfile event ever happened', async () => {
    const audit = fakeAudit();
    expect(await replayKeyfileEventsIntoAudit({ dataPath: dir, auditLog: audit })).toBe(0);
    expect(audit.rows).toHaveLength(0);
  });
});

describe('D-212 — the ledger survives what a stopped-server record has to', () => {
  it('appends cleanly after a crash left a torn final line', async () => {
    // A crash mid-append leaves the file without a trailing newline. Appending
    // naively concatenates the next entry onto the corrupt one and the
    // malformed-line skip then drops BOTH — losing a real record.
    recordKeyfileEvent(dir, {
      kind: 'passphrase_rotated', at: 1, keyfile_path: keyfile(), posture: 'passphrase',
    }, { mintId: () => 'first' });
    appendFileSync(keyfileEventLedgerPath(dir), '{"id":"torn","kind":"passphrase_rot');
    recordKeyfileEvent(dir, {
      kind: 'passphrase_rotated', at: 2, keyfile_path: keyfile(), posture: 'passphrase',
    }, { mintId: () => 'second' });

    expect(createKeyfileEventLedger(dir).readAll().map((e) => e.id)).toEqual(['first', 'second']);
  });

  it('skips a foreign line rather than handing it to the replay', async () => {
    recordKeyfileEvent(dir, {
      kind: 'passphrase_rotated', at: 1, keyfile_path: keyfile(), posture: 'passphrase',
    }, { mintId: () => 'real' });
    // Valid JSON, not one of ours — a `kind` outside the closed pair must not
    // reach a consumer that will trust it.
    appendFileSync(keyfileEventLedgerPath(dir), `${JSON.stringify({ id: 'x', kind: 'made_up', at: 2 })}\n`);

    expect(createKeyfileEventLedger(dir).readAll().map((e) => e.id)).toEqual(['real']);
  });

  it('never fails the operation it is recording', async () => {
    // A rotation that succeeded must not be reported as failed because a log
    // line would not write. A directory standing where the ledger goes makes
    // the append fail for real.
    const warnings: string[] = [];
    mkdirSync(keyfileEventLedgerPath(dir));

    const recorded = recordKeyfileEvent(dir, {
      kind: 'passphrase_rotated', at: 1, keyfile_path: keyfile(), posture: 'passphrase',
    }, { warn: (m) => warnings.push(m) });

    expect(recorded).toBeNull();
    expect(warnings.join(' ')).toMatch(/the change itself succeeded/);
  });

  it('reports that it did NOT record, rather than letting the CLI claim it did', async () => {
    // ⛔ The claim is about the one artifact an operator would go looking for
    // months later. A rotation must still SUCCEED when the record fails — but
    // it must not report success in a way that says the record is there.
    await enrolledRealm();
    mkdirSync(keyfileEventLedgerPath(dir)); // the append cannot land

    const result = await rotateKeyfilePassphrase({
      dbPath: dbPath(), currentPassphrase: OLD, newPassphrase: NEW, argon2_params: FAST,
    });
    // The rotation itself is unaffected — that is the whole point of
    // best-effort recording.
    expect(result.keyfilePath).toBe(keyfile());
    expect(result.eventRecorded).toBe(false);
  });

  it('reports that it DID record when the ledger took the line', async () => {
    await enrolledRealm();
    const result = await rotateKeyfilePassphrase({
      dbPath: dbPath(), currentPassphrase: OLD, newPassphrase: NEW, argon2_params: FAST,
    });
    expect(result.eventRecorded).toBe(true);
    expect(createKeyfileEventLedger(dir).readAll()).toHaveLength(1);
  });

  it('holds no secret — only what is already public or already on disk', async () => {
    // ⛔ This file is NOT encrypted, because it has to be readable when the
    // keyfile is not. A future field carrying a passphrase, a key or the
    // recovery mnemonic would make it the softest target in the directory.
    await enrolledRealm();
    await rotateKeyfilePassphrase({
      dbPath: dbPath(), currentPassphrase: OLD, newPassphrase: NEW, argon2_params: FAST,
    });
    const raw = readFileSync(keyfileEventLedgerPath(dir), 'utf8');
    expect(raw).not.toContain(OLD);
    expect(raw).not.toContain(NEW);
    // And the vault key the keyfile holds never appears either.
    const store = await createFileServerKeyStore({
      filePath: keyfile(), passphrase: NEW, argon2_params: FAST, warn: () => {},
    });
    const vaultKey = store.loadServerVaultKey();
    expect(vaultKey).not.toBeNull();
    expect(raw).not.toContain(Buffer.from(vaultKey!).toString('base64'));
  });
});

describe('D-212 — the row is classified so it survives to be read', () => {
  it('is high-assurance, so deleting it needs a forged signature', () => {
    expect(HIGH_ASSURANCE_AUDIT_KINDS.has('keyfile_sealing_changed')).toBe(true);
  });

  it('is reserve-class, so retention cannot evict the answer', () => {
    // The question is asked months later. A row the pruner may drop is not an
    // answer, and this is the only structured one that exists.
    expect(RESERVE_ACTIONS.has('keyfile_sealing_changed')).toBe(true);
  });

  it('is actually SIGNED, through the real store the server boots with', async () => {
    // ⛔ Membership in HIGH_ASSURANCE_AUDIT_KINDS and "the row is signed" are
    // two facts joined by an inference, and the contracts comment claims the
    // second. Prove it through the REAL wrapper and a REAL store rather than
    // the fake sink the tests above use — a documented signature the code never
    // produces is the exact shape this arc has already been caught by once.
    //
    // ⚠ Membership also makes the verifier REJECT an unsigned row of this kind,
    // so a replay wired past the signing wrapper would not merely be unsigned:
    // it would write rows that read as tampered.
    await enrolledRealm();
    await rotateKeyfilePassphrase({
      dbPath: dbPath(), currentPassphrase: OLD, newPassphrase: NEW, argon2_params: FAST,
    });

    const underlying = createAuditLogStore(
      createInMemoryCollection<AuditEntry>(),
      createInMemoryCollection<ActivityEntry>(),
    );
    const serverIdentity = generateEd25519Keypair('server_identity_key');
    const signing = createSigningAuditLog(underlying, {
      getServerIdentity: () => serverIdentity,
    });

    expect(await replayKeyfileEventsIntoAudit({ dataPath: dir, auditLog: signing })).toBe(1);

    const [row] = await underlying.listActivities();
    expect(row?.action).toBe('keyfile_sealing_changed');
    expect(verifyActivityEntry(row!, serverIdentity.public_key_b64)).toEqual({ ok: true });
    // …and stored reserve-class, so the retention pruner cannot evict it.
    expect(row?.reserve).toBe(true);
  });

  it('carries the replay prefix, which is what makes the id findable', async () => {
    await enrolledRealm();
    await rotateKeyfilePassphrase({
      dbPath: dbPath(), currentPassphrase: OLD, newPassphrase: NEW, argon2_params: FAST,
    });
    const audit = fakeAudit();
    await replayKeyfileEventsIntoAudit({ dataPath: dir, auditLog: audit });
    const ledgerId = createKeyfileEventLedger(dir).readAll()[0]?.id;
    expect(audit.rows[0]?.activity_id).toBe(`${KEYFILE_EVENT_REPLAY_PREFIX}${ledgerId}`);
  });
});
