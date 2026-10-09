/** D-212 §7.11 — the escape hatch, proven to open.
 *
 *  §7.2 argues machine binding is safe to adopt because "binding lost ⇒ the
 *  bundle's recovery wrap still opens ⇒ re-mint the keyfile", and that premise
 *  was NOT true when slice 5 shipped: `rebindServerBundleForLocalBoot`
 *  constructs the key store first, so an unopenable keyfile threw before any
 *  recovery logic ran. Both the normal boot and the recovery path failed on the
 *  identical line.
 *
 *  ⛔ These tests never touch the real OS keychain — the registry is mocked so
 *  a sealed-then-dead keyfile can be produced without provisioning anything.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

let fakeSecret: Uint8Array | null = null;
let fakeAvailable = true;

vi.mock('../keys/machine-secret.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../keys/machine-secret.js')>();
  const fake = {
    id: 'os-keyring' as const,
    isAvailable: async () => fakeAvailable,
    provision: async () => {
      fakeSecret = new Uint8Array(32).fill(0x5a);
      return fakeSecret;
    },
    // Returns null once the entry is "gone" — the machine-reimaged /
    // entry-deleted / different-account case the hatch exists for.
    fetch: async () => (fakeSecret ? new Uint8Array(fakeSecret) : null),
  };
  return {
    ...actual,
    MACHINE_SECRET_PROVIDERS: [fake],
    machineSecretProvider: (id: string) => (id === 'os-keyring' ? fake : undefined),
    selectMachineSecretProvider: async () => (fakeAvailable ? fake : undefined),
    // The capability probe is part of the registry surface and must be
    // stubbed with it — leaving it real made the report contradict the
    // decision, which is how the double-walk bug surfaced.
    describeMachineSecretCapability: async () => (fakeAvailable ? ['os-keyring'] : []),
  };
});

import { mkdtempSync, existsSync, rmSync, chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateRecoveryKey } from '@recued/crypto';

import { createFileServerKeyStore } from '../keys/file-store.js';
import { resolveIdentityKeysPath } from '../identity/boot.js';
import {
  regenerateKeyfileFromRecoveryKey,
  KeyfileRecoveryError,
} from '../keyfile-recovery.js';
import { createServerBundleStore, resolveServerBundlePath } from '../server-bundle-store.js';
import { enrollRealmRecoveryKey } from '../server-vault-enrollment.js';
import { createRecoveryKeyCheckStore } from '../recovery-key-store.js';
import { createKeyManager } from '../key-manager.js';
import { openDatabase } from '../open-database.js';

let dir: string;
const dbPath = (): string => join(dir, 'recued-server.db');

/** KeyManager slots wired to the REAL sidecar store, so enrollment writes a
 *  bundle the recovery path will later find on disk. The legacy password
 *  bundle is absent on a D-212 realm. */
const bundleSlots = (path: string) => {
  const store = createServerBundleStore(path);
  return {
    loadBundle: () => null,
    saveBundle: () => {},
    loadServerBundle: () => store.load(),
    saveServerBundle: (b: Parameters<typeof store.save>[0]) => { store.save(b); },
  };
};

/** Stand up a REAL encrypted realm: db + bundle sidecar + machine-sealed
 *  keyfile, through the same enrollment door pairing uses. */
const enrolledRealm = async (recoveryKey: string, path: string = dbPath()) => {
  const database = await openDatabase(path, { databaseKey: null });
  const keyStore = await createFileServerKeyStore({
    filePath: resolveIdentityKeysPath(path),
    machineSealing: true,
  });
  const keys = createKeyManager(bundleSlots(path));
  const recoveryKeyCheck = createRecoveryKeyCheckStore(database);
  try {
    const res = await enrollRealmRecoveryKey({
      recoveryKeyCheck, recoveryKey, keys, keyStore, database,
    });
    expect(res.ok).toBe(true);
    await keyStore.flush?.();
  } finally {
    database.close();
  }
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd212-keyfile-recovery-'));
  fakeSecret = null;
  fakeAvailable = true;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('D-212 — one realm per data directory', () => {
  /** ⛔ The keyfile is DIRECTORY-scoped; the bundle sidecar is DB-scoped. The
   *  sidecar carries that suffix precisely "so two explicitly named realm dbs
   *  in the same directory cannot share encryption state by accident" — but
   *  every sidecar is wrapped to the ONE server key the shared keyfile holds,
   *  so enrolling a second realm silently overwrote it and left the first
   *  realm's database intact and permanently unreadable.
   *
   *  The same-realm guard directly above this one in `enrollServerVault-
   *  FromRecoveryKey` already names the hazard — "overwrites the only key that
   *  opens an existing bundle" — it was just scoped to ourselves. */
  it('REFUSES to enrol a second realm that would orphan its neighbour', async () => {
    const first = generateRecoveryKey().mnemonic;
    await enrolledRealm(first);

    // Drive the DOOR directly — it returns a typed outcome, not a throw, so the
    // refusal has to surface as `realm_conflict` (NOT `invalid`: the operator's
    // key is fine, their directory is not).
    const sibling = join(dir, 'second.db');
    const db2 = await openDatabase(sibling, { databaseKey: null });
    const keyStore2 = await createFileServerKeyStore({
      filePath: resolveIdentityKeysPath(sibling),
      machineSealing: true,
    });
    try {
      const res = await enrollRealmRecoveryKey({
        recoveryKeyCheck: createRecoveryKeyCheckStore(db2),
        recoveryKey: generateRecoveryKey().mnemonic,
        keys: createKeyManager(bundleSlots(sibling)),
        keyStore: keyStore2,
        database: db2,
      });
      expect(res).toMatchObject({ ok: false, code: 'realm_conflict' });
      expect((res as { message: string }).message).toMatch(/D212_REALM_WOULD_ORPHAN_SIBLING/);
    } finally {
      db2.close();
    }
    // The sibling never got its own sidecar — refused before any write.
    expect(existsSync(resolveServerBundlePath(sibling))).toBe(false);

    // The victim is untouched: its sidecar still opens under the shared keyfile,
    // which is the whole property. `recover-keyfile` therefore has nothing to
    // do — proven by it refusing as healthy.
    await expect(
      regenerateKeyfileFromRecoveryKey({ dbPath: dbPath(), recoveryKey: first, env: {} }),
    ).rejects.toThrow(/already opens this realm's vault bundle/);
  });

  it('still enrols a second realm in its OWN directory', async () => {
    // The neighbouring case the refusal must not catch — otherwise it is a ban
    // on second realms rather than on shared encryption state.
    await enrolledRealm(generateRecoveryKey().mnemonic);

    const ownDir = mkdtempSync(join(tmpdir(), 'd212-second-realm-'));
    try {
      await enrolledRealm(generateRecoveryKey().mnemonic, join(ownDir, 'recued-server.db'));
    } finally {
      rmSync(ownDir, { recursive: true, force: true });
    }
  });

  // ⛔ The guard must FAIL CLOSED on a sibling it cannot read. `readdir` listed
  // the file, so the sibling realm EXISTS — treating an unreadable sidecar as
  // "no sibling" let the destructive keyfile write proceed and strand it.
  it('REFUSES when a sibling sidecar EXISTS but cannot be read', async () => {
    await enrolledRealm(generateRecoveryKey().mnemonic);
    const victimSidecar = resolveServerBundlePath(dbPath());
    expect(existsSync(victimSidecar)).toBe(true);
    chmodSync(victimSidecar, 0o000); // present, but readFileSync throws EACCES

    const sibling = join(dir, 'second.db');
    const db2 = await openDatabase(sibling, { databaseKey: null });
    const keyStore2 = await createFileServerKeyStore({
      filePath: resolveIdentityKeysPath(sibling),
      machineSealing: true,
    });
    try {
      const res = await enrollRealmRecoveryKey({
        recoveryKeyCheck: createRecoveryKeyCheckStore(db2),
        recoveryKey: generateRecoveryKey().mnemonic,
        keys: createKeyManager(bundleSlots(sibling)),
        keyStore: keyStore2,
        database: db2,
      });
      // NOT `{ ok: true }` — an unreadable sibling is a sibling, not an absence.
      expect(res).toMatchObject({ ok: false, code: 'realm_conflict' });
    } finally {
      chmodSync(victimSidecar, 0o600); // restore so afterEach can clean up
      db2.close();
    }
    // Refused before any write: no second sidecar.
    expect(existsSync(resolveServerBundlePath(sibling))).toBe(false);
  });

  it('still enrols past a readable-but-INVALID file that merely shares the suffix', async () => {
    // The boundary the fail-closed change must NOT cross: a file that READS but
    // does not parse as a bundle is genuinely not a sibling realm, so it must
    // not block a legitimate first enrollment.
    const ownDir = mkdtempSync(join(tmpdir(), 'd212-junk-sidecar-'));
    writeFileSync(join(ownDir, 'junk.server-vault-bundle.json'), 'not a bundle at all');
    try {
      await enrolledRealm(generateRecoveryKey().mnemonic, join(ownDir, 'recued-server.db'));
    } finally {
      rmSync(ownDir, { recursive: true, force: true });
    }
  });

  /** ⛔ The sibling guard returns null on the FIRST enrollment (no key yet), so
   *  it cannot see a CONCURRENT first-enrollment. The enrollment queue keyed by
   *  db path let two first-enrollments in one directory race: both guards ran
   *  before either keyfile write landed, both wrote the SHARED keyfile, the last
   *  write won, and one realm was left with a bundle no keyfile opens. Keying the
   *  queue by the shared keyfile DIRECTORY serializes them, so the second runs
   *  after the first's keyfile exists and is refused. */
  it('serializes two concurrent first-enrolments in one directory (exactly one wins)', async () => {
    const buildArgs = async (path: string) => {
      const database = await openDatabase(path, { databaseKey: null });
      const keyStore = await createFileServerKeyStore({
        filePath: resolveIdentityKeysPath(path),
        machineSealing: true,
      });
      return {
        database,
        args: {
          recoveryKeyCheck: createRecoveryKeyCheckStore(database),
          recoveryKey: generateRecoveryKey().mnemonic,
          keys: createKeyManager(bundleSlots(path)),
          keyStore,
          database,
        },
      };
    };
    // Two DISTINCT dbs, ONE directory → one shared keyfile.
    const a = await buildArgs(join(dir, 'a.db'));
    const b = await buildArgs(join(dir, 'b.db'));
    try {
      // Fire both without awaiting between — the bug let both pass their guard
      // before either wrote.
      const [ra, rb] = await Promise.all([
        enrollRealmRecoveryKey(a.args),
        enrollRealmRecoveryKey(b.args),
      ]);
      const oks = [ra, rb].filter((r) => r.ok).length;
      const conflicts = [ra, rb].filter((r) => !r.ok && r.code === 'realm_conflict').length;
      // Exactly one realm may own the shared keyfile; the other must be refused
      // (NOT silently `ok`, which is the orphaning bug).
      expect(oks).toBe(1);
      expect(conflicts).toBe(1);
    } finally {
      a.database.close();
      b.database.close();
    }
  });
});

describe('D-212 §7.11 — regenerating a lost keyfile from the recovery key', () => {
  it('opens the hatch: a DEAD machine-sealed keyfile is replaced and the realm reopens', async () => {
    const { mnemonic } = generateRecoveryKey();
    await enrolledRealm(mnemonic);
    const keyfile = resolveIdentityKeysPath(dbPath());

    // The provider loses its entry — machine reimaged, entry deleted, or the
    // service now runs as a different account.
    fakeSecret = null;
    await expect(createFileServerKeyStore({ filePath: keyfile }))
      .rejects.toThrow(/cannot produce its secret right now/);

    // ⛔ This is the call that used to be unreachable.
    fakeAvailable = false; // the new host offers nothing; unsealed is allowed (§7.10)
    const result = await regenerateKeyfileFromRecoveryKey({
      dbPath: dbPath(), recoveryKey: mnemonic, env: {}, now: () => 1234,
    });

    expect(result.displacedTo).toBe(`${keyfile}.unopenable-1234`);
    expect(existsSync(result.displacedTo!)).toBe(true);
    expect(result.posture).toBe('none');

    // The realm opens again on the fresh keyfile alone — no recovery key.
    const reopened = await openDatabase(dbPath(), { keyEnvironment: {} });
    expect(() => reopened.prepare('select 1').get()).not.toThrow();
    reopened.close();
  });

  it('inside a container, refuses to regenerate it unsealed and puts the old keyfile back', async () => {
    // Recovery writes a NEW keyfile, so the container rule that guards a first boot guards it
    // too (audit 2026-10-09: this path skipped it and wrote one unsealed, holding the vault key).
    const { mnemonic } = generateRecoveryKey();
    await enrolledRealm(mnemonic);
    const keyfile = resolveIdentityKeysPath(dbPath());
    const before = readFileSync(keyfile);
    fakeSecret = null;
    fakeAvailable = false; // a container: nothing can seal it but a passphrase

    await expect(regenerateKeyfileFromRecoveryKey({
      dbPath: dbPath(), recoveryKey: mnemonic, env: { RECUED_SUPERVISOR_MODE: 'docker' }, now: () => 5,
    })).rejects.toThrow(/Refusing to write the key file unsealed: inside a container/);
    expect(readFileSync(keyfile)).toEqual(before);
    expect(existsSync(`${keyfile}.unopenable-5`)).toBe(false);
  });

  it('regeneration is how the sealing factor changes — the fresh keyfile takes this host', async () => {
    const { mnemonic } = generateRecoveryKey();
    await enrolledRealm(mnemonic);
    fakeSecret = null;
    fakeAvailable = false;

    const result = await regenerateKeyfileFromRecoveryKey({
      dbPath: dbPath(), recoveryKey: mnemonic,
      env: { RECUED_IDENTITY_PASSPHRASE: 'chosen-at-recovery' },
      now: () => 1,
      // Weak params: this asserts the POSTURE and that the realm reopens, not
      // the KDF's cost. At OWASP params the two derivations run ~4.8s against a
      // 5s default timeout — green in isolation, flaky under full-suite load.
      argon2_params: { t: 1, m: 8, p: 1 },
    });

    expect(result.posture).toBe('passphrase');
    const reopened = await openDatabase(dbPath(), {
      keyEnvironment: { RECUED_IDENTITY_PASSPHRASE: 'chosen-at-recovery' },
    });
    reopened.close();
  });

  it('REFUSES when the keyfile is healthy — never pay a re-pair you do not owe', async () => {
    const { mnemonic } = generateRecoveryKey();
    await enrolledRealm(mnemonic);

    // fakeSecret is still live, so the keyfile opens fine.
    await expect(
      regenerateKeyfileFromRecoveryKey({ dbPath: dbPath(), recoveryKey: mnemonic, env: {} }),
    ).rejects.toThrow(KeyfileRecoveryError);
    await expect(
      regenerateKeyfileFromRecoveryKey({ dbPath: dbPath(), recoveryKey: mnemonic, env: {} }),
    ).rejects.toThrow(/already opens this realm's vault bundle/);

    // Nothing displaced.
    expect(existsSync(`${resolveIdentityKeysPath(dbPath())}.unopenable-`)).toBe(false);
  });

  // ⛔ The guard used to ask only "does this file decode?", which made it refuse
  // the exact state it exists to rescue: a readable keyfile whose key is not
  // this realm's. Boot fails with D212_DATABASE_KEY_UNAVAILABLE while recovery
  // answers `keyfile_is_healthy` — a dead end with no tool left to reach for.
  it('RECOVERS a keyfile that decodes but does not open THIS realm', async () => {
    const { mnemonic } = generateRecoveryKey();
    await enrolledRealm(mnemonic);
    const keyfile = resolveIdentityKeysPath(dbPath());

    // A perfectly valid keyfile holding a server key this realm's bundle has
    // never seen — the wrong-backup / copied-off-another-host / crashed-midway
    // shape, all of which leave a decodable file behind.
    rmSync(keyfile);
    fakeAvailable = false;
    const stranger = await createFileServerKeyStore({ filePath: keyfile });
    stranger.saveServerVaultKey(new Uint8Array(32).fill(0x11));
    await stranger.flush?.();
    expect(existsSync(keyfile)).toBe(true);

    const ok = await regenerateKeyfileFromRecoveryKey({
      dbPath: dbPath(), recoveryKey: mnemonic, env: {}, now: () => 11,
    });

    // Recovered, not refused — and the stranger's file kept, not destroyed.
    expect(ok.displacedTo).toBe(`${keyfile}.unopenable-11`);
    expect(existsSync(`${keyfile}.unopenable-11`)).toBe(true);
  });

  it('a WRONG recovery key touches nothing — the dead keyfile is still there', async () => {
    const { mnemonic } = generateRecoveryKey();
    await enrolledRealm(mnemonic);
    const keyfile = resolveIdentityKeysPath(dbPath());
    fakeSecret = null;

    const stranger = generateRecoveryKey().mnemonic;
    await expect(
      regenerateKeyfileFromRecoveryKey({ dbPath: dbPath(), recoveryKey: stranger, env: {} }),
    ).rejects.toThrow(/does not open this realm's vault bundle/);

    // The probe runs BEFORE the displace, so the operator's artifacts are
    // exactly as they were and a correct key still works afterwards.
    expect(existsSync(keyfile)).toBe(true);
    fakeAvailable = false;
    const ok = await regenerateKeyfileFromRecoveryKey({
      dbPath: dbPath(), recoveryKey: mnemonic, env: {}, now: () => 7,
    });
    expect(ok.displacedTo).toBe(`${keyfile}.unopenable-7`);
  });

  it('a malformed mnemonic is named as such, not reported as the wrong realm', async () => {
    const { mnemonic } = generateRecoveryKey();
    await enrolledRealm(mnemonic);
    fakeSecret = null;

    await expect(
      regenerateKeyfileFromRecoveryKey({ dbPath: dbPath(), recoveryKey: 'not a phrase', env: {} }),
    ).rejects.toThrow(/not a valid 24-word recovery phrase/);
  });

  it('an unencrypted realm says so — a recovery key cannot open what was never sealed', async () => {
    const database = await openDatabase(dbPath(), { databaseKey: null });
    database.close();

    await expect(
      regenerateKeyfileFromRecoveryKey({
        dbPath: dbPath(), recoveryKey: generateRecoveryKey().mnemonic, env: {},
      }),
    ).rejects.toThrow(/not encrypted/);
  });

  /** ⛔ Bundle-opens is NOT enough. A bundle proves the mnemonic matches the
   *  BUNDLE; it does not prove the bundle belongs to the database beside it.
   *  This is the case that motivates probing the db rather than the wrap. */
  it('REFUSES a bundle that opens but does not match the database beside it', async () => {
    const a = generateRecoveryKey().mnemonic;
    await enrolledRealm(a);
    const keyfile = resolveIdentityKeysPath(dbPath());

    // Build a second, unrelated realm and graft ITS bundle over this one.
    const otherDir = mkdtempSync(join(tmpdir(), 'd212-other-realm-'));
    try {
      const otherDb = join(otherDir, 'recued-server.db');
      const b = generateRecoveryKey().mnemonic;
      const database = await openDatabase(otherDb, { databaseKey: null });
      const otherKeyStore = await createFileServerKeyStore({
        filePath: resolveIdentityKeysPath(otherDb), machineSealing: true,
      });
      const res = await enrollRealmRecoveryKey({
        recoveryKeyCheck: createRecoveryKeyCheckStore(database),
        recoveryKey: b,
        keys: createKeyManager(bundleSlots(otherDb)),
        keyStore: otherKeyStore,
        database,
      });
      expect(res.ok).toBe(true);
      await otherKeyStore.flush?.();
      database.close();

      const foreign = createServerBundleStore(otherDb).load()!;
      createServerBundleStore(dbPath()).save(foreign);
      fakeSecret = null;

      // `b` opens the grafted bundle — so a bundle-only probe would proceed and
      // bind a fresh keyfile to a database it cannot read.
      await expect(
        regenerateKeyfileFromRecoveryKey({ dbPath: dbPath(), recoveryKey: b, env: {} }),
      ).rejects.toThrow(/different realms/);

      // And nothing was displaced on that refusal.
      expect(existsSync(keyfile)).toBe(true);
    } finally {
      rmSync(otherDir, { recursive: true, force: true });
    }
  });
});

/** §7.11 requires the path be REACHABLE. A module nobody can invoke is not a
 *  recovery path, and this one has to run when the server cannot boot — so the
 *  operator surface is a CLI command, and it has to actually be dispatched. */
describe('D-212 §7.11 — `recued recover-keyfile` is wired and honest', () => {
  it('classifies as its own boot profile — not the unmigrated `command` sink', async () => {
    const { classifyBootProfile } = await import('../cli/boot-trace.js');
    expect(classifyBootProfile({ subcommand: 'recover-keyfile', version: false, mcp: false }))
      .toBe('recover-keyfile');
    // `command` is the profile that throws "has not migrated" — landing there
    // would make the command exist in help and fail on invocation.
    expect(classifyBootProfile({ subcommand: 'recover-keyfile', version: false, mcp: false }))
      .not.toBe('command');
  });

  it('states the IDENTITY cost before it asks for the recovery key', async () => {
    const { runRecoverKeyfileProfile } = await import('../cli-context/recover-keyfile.js');
    const { mnemonic } = generateRecoveryKey();
    await enrolledRealm(mnemonic);
    fakeSecret = null;
    fakeAvailable = false;

    const lines: string[] = [];
    let linesWhenFirstAsked = -1;
    const answers = ['recover', mnemonic];
    let i = 0;

    await runRecoverKeyfileProfile({
      args: ['recover-keyfile', '--db', dbPath()],
      env: {},
      out: (l) => lines.push(l),
      readSecret: async () => {
        if (linesWhenFirstAsked < 0) linesWhenFirstAsked = lines.length;
        return answers[i++] ?? '';
      },
    });

    // ⛔ The order is the point: an operator who learns the cost afterwards has
    // already paid it. Everything below must be on screen before the prompt.
    const before = lines.slice(0, linesWhenFirstAsked).join('\n');
    expect(before).toMatch(/pair again/);
    expect(before).toMatch(/publisher identity changes/);
    expect(before).toMatch(/account binding is cleared/);
    expect(before).toMatch(/moved aside, not deleted/);

    // …and it did the work.
    expect(lines.join('\n')).toMatch(/Keyfile re-created/);
    const reopened = await openDatabase(dbPath(), { keyEnvironment: {} });
    reopened.close();
  });

  it('an UNSEALED result is said out loud, not reported as plain success', async () => {
    const { runRecoverKeyfileProfile } = await import('../cli-context/recover-keyfile.js');
    const { mnemonic } = generateRecoveryKey();
    await enrolledRealm(mnemonic);
    fakeSecret = null;
    fakeAvailable = false; // no rung available ⇒ posture 'none'

    const lines: string[] = [];
    const answers = ['recover', mnemonic];
    let i = 0;
    await runRecoverKeyfileProfile({
      args: ['recover-keyfile', '--db', dbPath()],
      env: {},
      out: (l) => lines.push(l),
      readSecret: async () => answers[i++] ?? '',
    });

    // §7.10's floor is legibility — a keyfile left in the clear must say so.
    expect(lines.join('\n')).toMatch(/UNSEALED/);
    expect(lines.join('\n')).toMatch(/copies this directory/);
  });

  it('cancelling changes nothing and never asks for the key', async () => {
    const { runRecoverKeyfileProfile } = await import('../cli-context/recover-keyfile.js');
    const { mnemonic } = generateRecoveryKey();
    await enrolledRealm(mnemonic);
    const keyfile = resolveIdentityKeysPath(dbPath());
    fakeSecret = null;

    const lines: string[] = [];
    let asks = 0;
    await runRecoverKeyfileProfile({
      args: ['recover-keyfile', '--db', dbPath()],
      env: {},
      out: (l) => lines.push(l),
      readSecret: async () => { asks += 1; return 'no'; },
    });

    expect(asks).toBe(1); // the confirm only — never reached the key prompt
    expect(lines.join('\n')).toMatch(/Cancelled/);
    expect(existsSync(keyfile)).toBe(true);
  });
});
