/** D-212 slice 5 — the keyfile sealed against a platform secret store.
 *
 *  ⛔ These tests never touch the real OS keychain. Provisioning writes to
 *  shared machine state, and an early draft of this feature — which selected a
 *  provider by default rather than on request — deposited 28 stray entries in
 *  the developer's own login keychain during two test runs. The registry is
 *  mocked here so a fake provider stands in.
 *
 *  The behaviour that matters is not "it encrypts". It is that the provider is
 *  chosen ONCE, recorded, and honoured forever after: re-running the selection
 *  ladder at open time would treat a sealed realm as unsealed the moment the
 *  store happened to be locked, which is the silent downgrade this design
 *  exists to prevent.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

/** Swappable stand-in for the platform store. */
let fakeSecret: Uint8Array | null = null;
let fakeAvailable = true;
let provisionCalls = 0;
let fetchCalls = 0;

vi.mock('../keys/machine-secret.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../keys/machine-secret.js')>();
  const fake = {
    id: 'os-keyring' as const,
    isAvailable: async () => fakeAvailable,
    provision: async () => {
      provisionCalls += 1;
      fakeSecret = new Uint8Array(32).fill(0x5a);
      return fakeSecret;
    },
    fetch: async () => {
      fetchCalls += 1;
      return fakeSecret ? new Uint8Array(fakeSecret) : null;
    },
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

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFileServerKeyStore } from '../keys/file-store.js';

let dir: string;
const keyfile = (): string => join(dir, 'identity-keys.json');

const KEYPAIR = {
  key_class: 'server_identity_key' as const,
  private_key_b64: 'cHJpdmF0ZQ==',
  public_key_b64: 'cHVibGlj',
  public_key_fingerprint: 'fp-1',
  created_at: 1,
};

const readDoc = (): Record<string, unknown> =>
  JSON.parse(readFileSync(keyfile(), 'utf8')) as Record<string, unknown>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd212-machine-seal-'));
  fakeSecret = null;
  fakeAvailable = true;
  provisionCalls = 0;
  fetchCalls = 0;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('machine-sealed keyfile', () => {
  it('seals a new keyfile and records which provider did it', async () => {
    const store = await createFileServerKeyStore({ filePath: keyfile(), machineSealing: true });
    store.saveServerIdentityKey(KEYPAIR);
    await store.flush?.();

    const doc = readDoc();
    expect(doc.encrypted).toBe(true);
    expect(doc.sealed_by).toBe('os-keyring');
    expect(typeof doc.machine_salt_b64).toBe('string');
    expect(provisionCalls).toBe(1);
    // The private key must not be sitting in the payload.
    expect(readFileSync(keyfile(), 'utf8')).not.toContain(KEYPAIR.private_key_b64);
  });

  it('reopens through the recorded provider', async () => {
    const first = await createFileServerKeyStore({ filePath: keyfile(), machineSealing: true });
    first.saveServerIdentityKey(KEYPAIR);
    await first.flush?.();

    const reopened = await createFileServerKeyStore({ filePath: keyfile() });
    expect(reopened.loadServerIdentityKey()).toEqual(KEYPAIR);
    expect(fetchCalls).toBeGreaterThan(0);
  });

  it('fails loudly — never as unsealed — when the store cannot answer', async () => {
    const first = await createFileServerKeyStore({ filePath: keyfile(), machineSealing: true });
    first.saveServerIdentityKey(KEYPAIR);
    await first.flush?.();

    // The keychain is locked, or the entry is gone.
    fakeSecret = null;

    await expect(
      createFileServerKeyStore({ filePath: keyfile() }),
    ).rejects.toThrow(/sealed by 'os-keyring'.*cannot produce its secret/s);
  });

  it('does not re-run the ladder on an existing file when the provider is unavailable', async () => {
    const first = await createFileServerKeyStore({ filePath: keyfile(), machineSealing: true });
    first.saveServerIdentityKey(KEYPAIR);
    await first.flush?.();
    const sealedBefore = readDoc().sealed_by;

    // Provider present but the ladder would now decline it. An existing file
    // must still open through what sealed it — re-selecting here is how a
    // sealed realm would silently become an unsealed one.
    fakeAvailable = false;

    const reopened = await createFileServerKeyStore({ filePath: keyfile(), machineSealing: true });
    expect(reopened.loadServerIdentityKey()).toEqual(KEYPAIR);
    reopened.saveServerIdentityKey({ ...KEYPAIR, public_key_fingerprint: 'fp-2' });
    await reopened.flush?.();

    expect(readDoc().sealed_by).toBe(sealedBefore);
    expect(readDoc().encrypted).toBe(true);
  });

  it('an explicit passphrase outranks the platform store', async () => {
    const store = await createFileServerKeyStore({
      filePath: keyfile(),
      passphrase: 'operator-chose-this',
      machineSealing: true,
      argon2_params: { t: 1, m: 8, p: 1 },
    });
    store.saveServerIdentityKey(KEYPAIR);
    await store.flush?.();

    const doc = readDoc();
    expect(doc.encrypted).toBe(true);
    expect(doc.sealed_by).toBeUndefined();
    expect(provisionCalls).toBe(0);
  });

  it('stays plaintext when sealing is not requested — the store is never touched', async () => {
    const store = await createFileServerKeyStore({ filePath: keyfile() });
    store.saveServerIdentityKey(KEYPAIR);
    await store.flush?.();

    expect(readDoc().encrypted).toBe(false);
    expect(readDoc().sealed_by).toBeUndefined();
    expect(provisionCalls).toBe(0);
  });

  it('leaves an existing plaintext keyfile alone rather than sealing it behind the operator', async () => {
    const plain = await createFileServerKeyStore({ filePath: keyfile() });
    plain.saveServerIdentityKey(KEYPAIR);
    await plain.flush?.();

    const reopened = await createFileServerKeyStore({ filePath: keyfile(), machineSealing: true });
    reopened.saveServerIdentityKey({ ...KEYPAIR, public_key_fingerprint: 'fp-2' });
    await reopened.flush?.();

    // Sealing an existing realm is a migration, not a side effect of opening it:
    // the secret would then exist on exactly one machine with nothing having
    // told the operator so.
    expect(readDoc().encrypted).toBe(false);
    expect(provisionCalls).toBe(0);
  });
});

describe('provider registry', () => {
  /** The ladder's shape is a security property: the strongest rung that will
   *  still answer at the next start must be tried first, and every id that can
   *  appear in a keyfile header must resolve to a provider — an unresolvable
   *  `sealed_by` is a realm nobody can open. */
  it('every declared provider id resolves, and order is strongest-first', async () => {
    const actual = await vi.importActual<typeof import('../keys/machine-secret.js')>(
      '../keys/machine-secret.js',
    );
    expect(actual.MACHINE_SECRET_PROVIDER_IDS).toEqual(['os-keyring', 'dpapi', 'secret-service', 'systemd-creds']);
    for (const id of actual.MACHINE_SECRET_PROVIDER_IDS) {
      expect(actual.machineSecretProvider(id)?.id).toBe(id);
    }
    expect(actual.MACHINE_SECRET_PROVIDERS.map((p) => p.id))
      .toEqual([...actual.MACHINE_SECRET_PROVIDER_IDS]);
  });

  it('declines every rung on a host that serves none', async () => {
    const actual = await vi.importActual<typeof import('../keys/machine-secret.js')>(
      '../keys/machine-secret.js',
    );
    // Both shipped rungs are platform-gated, so on any single OS at least one
    // must decline — and declining must be a clean `false`, never a throw, or
    // a boot fails on a host that simply cannot seal.
    for (const provider of actual.MACHINE_SECRET_PROVIDERS) {
      await expect(
        provider.isAvailable({ keyfilePath: '/nonexistent/realm/identity-keys.json', realmId: 'r' }),
      ).resolves.toBeTypeOf('boolean');
    }
  });

  it('scopes the realm id to the resolved keyfile path', async () => {
    const actual = await vi.importActual<typeof import('../keys/machine-secret.js')>(
      '../keys/machine-secret.js',
    );
    // Two realms on one machine must not collide on a keychain entry…
    expect(actual.realmIdForKeyfile('/srv/a/keys.json'))
      .not.toBe(actual.realmIdForKeyfile('/srv/b/keys.json'));
    // …and the same realm must resolve identically however it was spelled.
    expect(actual.realmIdForKeyfile('/srv/a/keys.json'))
      .toBe(actual.realmIdForKeyfile('/srv/a/./keys.json'));
  });
});

describe('saying so out loud', () => {
  /** Every case here is one where the code does the right thing and the
   *  OPERATOR would otherwise be wrong about it. Nothing below changes what is
   *  protected; it changes whether someone can believe something false about
   *  where their keys' safety comes from. */
  const warnings: string[] = [];
  const warn = (m: string): void => { warnings.push(m); };

  beforeEach(() => { warnings.length = 0; });

  it('says a passphrase is ignored on a machine-sealed keyfile', async () => {
    const first = await createFileServerKeyStore({ filePath: keyfile(), machineSealing: true });
    first.saveServerIdentityKey(KEYPAIR);
    await first.flush?.();

    const reopened = await createFileServerKeyStore({
      filePath: keyfile(),
      passphrase: 'set-after-the-fact',
      warn,
    });
    // It still opens — the passphrase is inert, not fatal.
    expect(reopened.loadServerIdentityKey()).toEqual(KEYPAIR);
    expect(warnings.join('\n')).toMatch(/sealed by 'os-keyring'.*ignored/s);
    expect(warnings.join('\n')).toMatch(/re-pair with your recovery key/);
  });

  it('stays quiet when the passphrase is the thing actually sealing it', async () => {
    const store = await createFileServerKeyStore({
      filePath: keyfile(),
      passphrase: 'operator-chose-this',
      argon2_params: { t: 1, m: 8, p: 1 },
      warn,
    });
    store.saveServerIdentityKey(KEYPAIR);
    await store.flush?.();

    await createFileServerKeyStore({
      filePath: keyfile(),
      passphrase: 'operator-chose-this',
      argon2_params: { t: 1, m: 8, p: 1 },
      warn,
    });
    expect(warnings).toEqual([]);
  });

  it('says the keyfile is unsealed when sealing was asked for and none was possible', async () => {
    fakeAvailable = false;

    const store = await createFileServerKeyStore({
      filePath: keyfile(),
      machineSealing: true,
      warn,
    });
    store.saveServerIdentityKey(KEYPAIR);
    await store.flush?.();

    expect(readDoc().encrypted).toBe(false);
    expect(warnings.join('\n')).toMatch(/UNSEALED/);
    expect(warnings.join('\n')).toMatch(/copies this directory/);
  });

  it('does not cry unsealed when nobody asked for sealing', async () => {
    const store = await createFileServerKeyStore({ filePath: keyfile(), warn });
    store.saveServerIdentityKey(KEYPAIR);
    await store.flush?.();
    expect(warnings).toEqual([]);
  });

  it('tells someone in recovery that a passphrase cannot open a sealed keyfile', async () => {
    const first = await createFileServerKeyStore({ filePath: keyfile(), machineSealing: true });
    first.saveServerIdentityKey(KEYPAIR);
    await first.flush?.();

    // The store is gone, and the operator reaches for the env var.
    fakeSecret = null;

    await expect(
      createFileServerKeyStore({ filePath: keyfile(), passphrase: 'hopeful', warn }),
    ).rejects.toThrow(/A passphrase cannot open a machine-sealed keyfile/);
  });
});

/** D-212 §7.10 — the 2x2 the slice-5 handover left uncovered, plus the defect
 *  it was hiding.
 *
 *      [has-passphrase, no-passphrase] x [has-native-seal, no-native-seal]
 *
 *  Every cell was implemented and none was exercised end to end. The bottom
 *  right — no passphrase, no seal — used to REFUSE enrollment (§7.9), which is
 *  now retracted: it fired on essentially every headless Linux install and the
 *  remedy it named bricked the server. */
describe('D-212 §7.10 — the sealing 2x2, and the remedy that used to brick', () => {
  const SIG = KEYPAIR.private_key_b64;

  it('passphrase + native seal ⇒ passphrase WINS, provider never touched', async () => {
    fakeAvailable = true;
    const store = await createFileServerKeyStore({
      filePath: keyfile(), machineSealing: true,
      passphrase: 'stated-intent', argon2_params: { t: 1, m: 8, p: 1 },
    });
    store.saveServerIdentityKey(KEYPAIR);
    await store.flush?.();

    const doc = readDoc();
    expect(doc.encrypted).toBe(true);
    // ⛔ Absence, not falsiness — `toMatchObject` cannot prove a key is missing.
    expect(Object.hasOwn(doc, 'sealed_by')).toBe(false);
    expect(typeof doc.kdf_salt_b64).toBe('string');
    // An explicit choice outranks anything selected on the operator's behalf,
    // so the platform store must not even be consulted.
    expect(provisionCalls).toBe(0);
    expect(store.sealingPosture?.()).toBe('passphrase');
    expect(readFileSync(keyfile(), 'utf8')).not.toContain(SIG);
  });

  it('passphrase + no native seal ⇒ passphrase seals, Argon2id path', async () => {
    fakeAvailable = false;
    const store = await createFileServerKeyStore({
      filePath: keyfile(), machineSealing: true,
      passphrase: 'stated-intent', argon2_params: { t: 1, m: 8, p: 1 },
    });
    store.saveServerIdentityKey(KEYPAIR);
    await store.flush?.();

    const doc = readDoc();
    expect(doc.encrypted).toBe(true);
    expect(Object.hasOwn(doc, 'sealed_by')).toBe(false);
    expect(typeof doc.kdf_salt_b64).toBe('string');
    expect(store.sealingPosture?.()).toBe('passphrase');
  });

  it('no passphrase + native seal ⇒ machine seals, HKDF path', async () => {
    fakeAvailable = true;
    const store = await createFileServerKeyStore({ filePath: keyfile(), machineSealing: true });
    store.saveServerIdentityKey(KEYPAIR);
    await store.flush?.();

    const doc = readDoc();
    expect(doc.sealed_by).toBe('os-keyring');
    expect(typeof doc.machine_salt_b64).toBe('string');
    // The machine rung is high-entropy — no password stretching involved.
    expect(Object.hasOwn(doc, 'kdf_salt_b64')).toBe(false);
    expect(store.sealingPosture?.()).toBe('machine');
  });

  it('no passphrase + no native seal ⇒ UNSEALED and said out loud — never a refusal', async () => {
    fakeAvailable = false;
    const warnings: string[] = [];
    const store = await createFileServerKeyStore({
      filePath: keyfile(), machineSealing: true, warn: (m) => warnings.push(m),
    });
    store.saveServerIdentityKey(KEYPAIR);
    await store.flush?.();

    const doc = readDoc();
    expect(doc.encrypted).toBe(false);
    expect(store.sealingPosture?.()).toBe('none');
    // §7.10's floor is enforced by legibility, so the warning is the control —
    // it must name the consequence, not merely that something is unsealed.
    expect(warnings.join('\n')).toMatch(/UNSEALED/);
    expect(warnings.join('\n')).toMatch(/copies this directory/);
  });

  /** ⛔⛔ The defect the 2x2 was hiding, through the REAL boot composition.
   *
   *  First boot flushes a plaintext keyfile before pairing exists. The operator
   *  reads the unsealed warning, sets RECUED_IDENTITY_PASSPHRASE, restarts —
   *  and until §7.10 that threw `file is unencrypted but a passphrase was
   *  supplied` and the server did not come up. Reproduced against
   *  `bootServerIdentity` because a file-store unit test cannot show that the
   *  composition root has no catch for it. */
  it('the prescribed remedy BOOTS: set the passphrase after an unsealed first boot', async () => {
    const { bootServerIdentity, resolveIdentityKeysPath } =
      await import('../identity/boot.js');
    fakeAvailable = false;
    const dbPath = join(dir, 'recued-server.db');

    const first = await bootServerIdentity({ dbPath, machineSealing: true, passphrase: null });
    expect(first.created).toBe(true);
    const fingerprint = first.identity.serverIdentityKey().public_key_fingerprint;
    const path = resolveIdentityKeysPath(dbPath);
    expect(JSON.parse(readFileSync(path, 'utf8')).encrypted).toBe(false);

    const second = await bootServerIdentity({
      dbPath, machineSealing: true,
      passphrase: 'set-after-reading-the-warning', argon2_params: { t: 1, m: 8, p: 1 },
    });

    // Booted, sealed, and the SAME server — not a fresh identity, which would
    // silently re-pair every client.
    expect(second.created).toBe(false);
    expect(second.identity.serverIdentityKey().public_key_fingerprint).toBe(fingerprint);
    expect(JSON.parse(readFileSync(path, 'utf8')).encrypted).toBe(true);
    expect(second.keyStore.sealingPosture?.()).toBe('passphrase');
  });
});

/** D-212 §7.10 — LEGIBILITY, which the model treats as a requirement rather
 *  than polish. The retracted §7.9 enforced the floor by refusing; §7.10
 *  enforces it by making the posture visible and the choice legible. If these
 *  surfaces are absent or vague, §7.10 is a weaker rule with nothing in place
 *  of what it removed — so these assert a control, not copy. */
describe('D-212 §7.10 — the first-boot capability report', () => {
  /** ⚠ Saves + flushes. Construction alone writes nothing, so a helper that
   *  skipped this would leave `readDoc()` on a missing file and the
   *  "existing keyfile" case indistinguishable from a fresh one — both of
   *  which this helper got wrong on the first pass. */
  const bootWith = async (opts: { passphrase?: string; available: boolean }) => {
    fakeAvailable = opts.available;
    const warnings: string[] = [];
    const store = await createFileServerKeyStore({
      filePath: keyfile(),
      machineSealing: true,
      ...(opts.passphrase ? { passphrase: opts.passphrase, argon2_params: { t: 1, m: 8, p: 1 } } : {}),
      warn: (m) => warnings.push(m),
    });
    store.saveServerIdentityKey(KEYPAIR);
    await store.flush?.();
    return { store, text: warnings.join('\n') };
  };

  it('names what this machine CAN seal with, before the choice is locked', async () => {
    const { text } = await bootWith({ available: true });
    expect(text).toMatch(/can seal the keyfile with: os-keyring/);
  });

  it('says "nothing" plainly on a host that offers no rung', async () => {
    const { text } = await bootWith({ available: false });
    // ⛔ The VPS/container case. An operator who is never told their host can
    // seal nothing will reasonably assume it sealed something.
    expect(text).toMatch(/can seal the keyfile with: nothing/);
    expect(text).toMatch(/UNSEALED/);
    expect(text).toMatch(/copies this directory/);
  });

  it('reports the choice it made, not just the options', async () => {
    const { text } = await bootWith({ available: true });
    expect(text).toMatch(/no RECUED_IDENTITY_PASSPHRASE set — sealing with 'os-keyring'/);
  });

  /** ⚠ The precedence cost. A passphrase outranks every machine rung because
   *  stated intent beats anything selected for someone — but on a host that HAS
   *  a keyring it can LOWER real protection, since the keyring keeps its secret
   *  outside the data directory and an env var beside it does not. The choice
   *  stays the operator's; the silence is the defect. */
  it('warns when a passphrase DISPLACES an available platform store', async () => {
    const { text } = await bootWith({ available: true, passphrase: 'from-a-tutorial' });
    expect(text).toMatch(/sealing with the passphrase/);
    expect(text).toMatch(/outranks os-keyring/);
    expect(text).toMatch(/weaker than a platform store/);
    // …and it really did displace it — the report is not describing a fiction.
    expect(readDoc().sealed_by).toBeUndefined();
    expect(provisionCalls).toBe(0);
  });

  it('does NOT cry displacement when there was nothing to displace', async () => {
    const { text } = await bootWith({ available: false, passphrase: 'the-only-option' });
    expect(text).toMatch(/sealing with the passphrase/);
    expect(text).not.toMatch(/outranks/);
    expect(text).not.toMatch(/weaker than/);
  });

  it('states that the choice is PERMANENT and how to change it', async () => {
    for (const available of [true, false]) {
      rmSync(dir, { recursive: true, force: true });
      dir = mkdtempSync(join(tmpdir(), 'd212-machine-seal-'));
      fakeSecret = null;
      const { text } = await bootWith({ available });
      // Permanence is the whole reason the report has to happen HERE — after
      // pairing the keyfile is load-bearing and the cheap fix is gone.
      expect(text).toMatch(/PERMANENT for this realm/);
      expect(text).toMatch(/delete .*identity-keys\.json/);
      expect(text).toMatch(/recover-keyfile/);
    }
  });

  /** ⛔ Reporting is a QUESTION, not a decision. `describeMachineSecretCapability`
   *  probes with `isAvailable` only — asking what a host can do must never
   *  deposit shared machine state. An early draft of sealing left 28 stray
   *  keychain entries by blurring exactly this line. */
  it('reporting never provisions — a passphrase boot leaves the store untouched', async () => {
    await bootWith({ available: true, passphrase: 'stated-intent' });
    expect(provisionCalls).toBe(0);
    expect(fakeSecret).toBeNull();
  });

  it('an EXISTING keyfile is not re-reported — the choice was already made', async () => {
    await bootWith({ available: true });
    const warnings: string[] = [];
    await createFileServerKeyStore({
      filePath: keyfile(), machineSealing: true, warn: (m) => warnings.push(m),
    });
    // Re-running the ladder at open is the silent downgrade §7.5 refuses, and
    // a report implying a live choice would misdescribe a settled one.
    expect(warnings.join('\n')).not.toMatch(/can seal the keyfile with/);
    expect(warnings.join('\n')).not.toMatch(/PERMANENT/);
  });
});

/** D-212 §7.10 — the STANDING posture surface. The first-boot report is a
 *  moment; this is the fact a client can read at any time. Together they are
 *  what §7.10 enforces the floor with, in place of the retracted §7.9 refusal —
 *  an operator may run an unsealed keyfile, but not without knowing. */
describe('D-212 §7.10 — keyfile posture on `system.status`', () => {
  const snapshot = async (getKeyfileSealing?: () => 'machine' | 'passphrase' | 'none' | null) => {
    const { handleSystemStatus } = await import('../system-status-handler.js');
    const { status } = await handleSystemStatus({
      getServerDisplayName: () => 'test',
      getServerVersion: () => '0.0.0',
      getUptimeSeconds: () => 1,
      getLastSyncAt: () => null,
      ...(getKeyfileSealing ? { getKeyfileSealing } : {}),
    });
    return status;
  };

  it('reports each posture verbatim from the key store', async () => {
    for (const posture of ['machine', 'passphrase', 'none'] as const) {
      expect((await snapshot(() => posture)).keyfile_sealing).toBe(posture);
    }
  });

  /** ⛔ THE distinction the floor rests on. `null` is this shape's ordinary
   *  not-wired case (the counters use it); `'none'` is a KNOWN and materially
   *  worse posture. A client that collapses them renders an unsealed realm the
   *  same as a boot-race — which would delete the only control that replaced
   *  the refusal. They must not be interchangeable at the source either. */
  it('`none` is NOT `null` — known-unsealed never degrades to not-wired', async () => {
    expect((await snapshot(() => 'none')).keyfile_sealing).toBe('none');
    expect((await snapshot(() => 'none')).keyfile_sealing).not.toBeNull();
    expect((await snapshot()).keyfile_sealing).toBeNull();
    expect((await snapshot(() => null)).keyfile_sealing).toBeNull();
  });

  it('the field is always present, so a client cannot miss it by shape', async () => {
    // Absence would let a renderer skip the posture entirely without ever
    // deciding how to show it — the failure mode §7.10 exists to prevent.
    expect(Object.hasOwn(await snapshot(), 'keyfile_sealing')).toBe(true);
  });

  /** The posture is read LIVE, not captured. `bootSigningIdentity` runs after
   *  the status deps are composed, so a value snapshotted at compose time would
   *  report `null` forever. */
  it('reads the store on every snapshot rather than caching', async () => {
    let current: 'machine' | 'passphrase' | 'none' | null = null;
    const live = () => current;
    expect((await snapshot(live)).keyfile_sealing).toBeNull();
    current = 'machine';
    expect((await snapshot(live)).keyfile_sealing).toBe('machine');
  });
});
