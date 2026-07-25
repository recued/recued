import { describe, it, expect } from 'vitest';
import {
  createServerBundle,
  openServerBundleWithServerKey,
  openServerBundleWithRecoveryKey,
  openServerBundleWithRecoveryEntropy,
  rewrapServerBundleForServerKey,
  generateServerKey,
  serverBundleToJSON,
  serverBundleFromJSON,
  SERVER_BUNDLE_VERSION,
  SERVER_KEY_LEN,
  type ServerBundle,
} from '../server-bundle.js';
import { generateRecoveryKey, recoveryKeyToEntropy } from '../recovery.js';

const b64 = (u: Uint8Array): string => Buffer.from(u).toString('base64');

/** A fresh (recoveryKey, serverKey) enrollment pair. */
const enrollInputs = () => ({
  recoveryKey: generateRecoveryKey().mnemonic,
  serverKey: generateServerKey(),
});

describe('openServerBundleWithRecoveryEntropy', () => {
  it('recovers the SAME Master DEK from the raw entropy as the mnemonic path', async () => {
    const { recoveryKey, serverKey } = enrollInputs();
    const { bundle, masterDEK } = await createServerBundle({ recoveryKey, serverKey });

    const viaEntropy = await openServerBundleWithRecoveryEntropy(
      bundle,
      recoveryKeyToEntropy(recoveryKey),
    );
    const viaMnemonic = await openServerBundleWithRecoveryKey(bundle, recoveryKey);
    expect(b64(viaEntropy)).toBe(b64(masterDEK));
    expect(b64(viaEntropy)).toBe(b64(viaMnemonic));
  });

  it('throws (GCM tag) on the wrong entropy', async () => {
    const { recoveryKey, serverKey } = enrollInputs();
    const { bundle } = await createServerBundle({ recoveryKey, serverKey });
    const wrong = recoveryKeyToEntropy(generateRecoveryKey().mnemonic);
    await expect(openServerBundleWithRecoveryEntropy(bundle, wrong)).rejects.toThrow();
  });
});

describe('createServerBundle', () => {
  it('wraps a 256-bit Master DEK under both factors', async () => {
    const { recoveryKey, serverKey } = enrollInputs();
    const { bundle, masterDEK } = await createServerBundle({ recoveryKey, serverKey });

    expect(bundle.version).toBe(SERVER_BUNDLE_VERSION);
    expect(masterDEK.length).toBe(32);
    expect(serverKey.length).toBe(SERVER_KEY_LEN);
    // Both wraps present; neither salt reused for the other factor.
    expect(bundle.wrapped_server.length).toBeGreaterThan(0);
    expect(bundle.wrapped_rec.length).toBeGreaterThan(0);
    expect(bundle.salt_server).not.toBe(bundle.salt_rec);
  });

  it('rejects a malformed recovery key before minting any key material', async () => {
    await expect(
      createServerBundle({ recoveryKey: 'not a real mnemonic', serverKey: generateServerKey() }),
    ).rejects.toThrow(/mnemonic/i);
  });

  it('rejects a wrong-length server key', async () => {
    await expect(
      createServerBundle({
        recoveryKey: generateRecoveryKey().mnemonic,
        serverKey: new Uint8Array(16),
      }),
    ).rejects.toThrow(/server key must be/);
  });

  it('is non-deterministic — two enrollments of the same inputs differ', async () => {
    const { recoveryKey, serverKey } = enrollInputs();
    const a = await createServerBundle({ recoveryKey, serverKey });
    const b = await createServerBundle({ recoveryKey, serverKey });
    // Fresh Master DEK + fresh salts each time.
    expect(b64(a.masterDEK)).not.toBe(b64(b.masterDEK));
    expect(a.bundle.salt_server).not.toBe(b.bundle.salt_server);
  });
});

describe('open — both factors recover the SAME Master DEK', () => {
  it('server key opens the bundle to the enrolled Master DEK', async () => {
    const { recoveryKey, serverKey } = enrollInputs();
    const { bundle, masterDEK } = await createServerBundle({ recoveryKey, serverKey });

    const opened = await openServerBundleWithServerKey(bundle, serverKey);
    expect(b64(opened)).toBe(b64(masterDEK));
  });

  it('recovery key opens the bundle to the SAME Master DEK', async () => {
    const { recoveryKey, serverKey } = enrollInputs();
    const { bundle, masterDEK } = await createServerBundle({ recoveryKey, serverKey });

    const opened = await openServerBundleWithRecoveryKey(bundle, recoveryKey);
    expect(b64(opened)).toBe(b64(masterDEK));
  });
});

describe('rewrapServerBundleForServerKey', () => {
  it('preserves the recovery wrap + Master DEK while binding normal boot to a new server key', async () => {
    const { recoveryKey, serverKey } = enrollInputs();
    const { bundle, masterDEK } = await createServerBundle({ recoveryKey, serverKey });
    const nextServerKey = generateServerKey();
    const rebound = await rewrapServerBundleForServerKey(
      bundle,
      recoveryKeyToEntropy(recoveryKey),
      nextServerKey,
      { now: () => 1234 },
    );

    expect(rebound.wrapped_rec).toBe(bundle.wrapped_rec);
    expect(rebound.salt_rec).toBe(bundle.salt_rec);
    expect(rebound.wrapped_server).not.toBe(bundle.wrapped_server);
    expect(rebound.salt_server).not.toBe(bundle.salt_server);
    expect(rebound.updated_at).toBe(1234);
    expect(b64(await openServerBundleWithServerKey(rebound, nextServerKey))).toBe(b64(masterDEK));
    expect(b64(await openServerBundleWithRecoveryKey(rebound, recoveryKey))).toBe(b64(masterDEK));
    await expect(openServerBundleWithServerKey(rebound, serverKey)).rejects.toThrow();
  });

  it('fails closed on a wrong recovery factor without producing a rebound bundle', async () => {
    const { recoveryKey, serverKey } = enrollInputs();
    const { bundle } = await createServerBundle({ recoveryKey, serverKey });
    await expect(
      rewrapServerBundleForServerKey(
        bundle,
        recoveryKeyToEntropy(generateRecoveryKey().mnemonic),
        generateServerKey(),
      ),
    ).rejects.toThrow();
  });
});

describe('open — rejection paths', () => {
  it('rejects a wrong server key', async () => {
    const { recoveryKey, serverKey } = enrollInputs();
    const { bundle } = await createServerBundle({ recoveryKey, serverKey });
    await expect(
      openServerBundleWithServerKey(bundle, generateServerKey()),
    ).rejects.toThrow();
  });

  it('rejects a wrong recovery key', async () => {
    const { recoveryKey, serverKey } = enrollInputs();
    const { bundle } = await createServerBundle({ recoveryKey, serverKey });
    await expect(
      openServerBundleWithRecoveryKey(bundle, generateRecoveryKey().mnemonic),
    ).rejects.toThrow();
  });

  it('rejects a tampered server wrap (AEAD auth)', async () => {
    const { recoveryKey, serverKey } = enrollInputs();
    const { bundle } = await createServerBundle({ recoveryKey, serverKey });
    const tampered: ServerBundle = { ...bundle, wrapped_server: bundle.wrapped_rec };
    // Feeding the recovery-wrap ciphertext to the server-open path fails:
    // wrong KEK + AAD field label mismatch (`server` vs `rec`).
    await expect(
      openServerBundleWithServerKey(tampered, serverKey),
    ).rejects.toThrow();
  });

  it('rejects an unsupported bundle version', async () => {
    const { recoveryKey, serverKey } = enrollInputs();
    const { bundle } = await createServerBundle({ recoveryKey, serverKey });
    const future: ServerBundle = { ...bundle, version: SERVER_BUNDLE_VERSION + 1 };
    await expect(
      openServerBundleWithServerKey(future, serverKey),
    ).rejects.toThrow(/unsupported version/);
  });
});

/** The bundle is not secret and rides a plain sidecar, so its two halves can be
 *  recombined by anyone holding two realms' backups. Nothing about a spliced
 *  bundle looks wrong at boot: the server opens the server wrap, gets A KEY,
 *  and runs. The realm is only discovered to be unrecoverable at the one moment
 *  the recovery key is reached for — after the machine is already gone. */
describe('the two wraps are bound to one bundle', () => {
  it('refuses a server wrap lifted from another bundle', async () => {
    // One machine, two realms — so the keyfile secret is genuinely able to open
    // either wrap, and only the binding stands between them.
    const serverKey = generateServerKey();
    const victimRecoveryKey = generateRecoveryKey().mnemonic;
    const victim = await createServerBundle({
      recoveryKey: victimRecoveryKey, serverKey,
    });
    const donor = await createServerBundle({
      recoveryKey: generateRecoveryKey().mnemonic, serverKey,
    });

    const spliced: ServerBundle = {
      ...victim.bundle,
      salt_server: donor.bundle.salt_server,
      wrapped_server: donor.bundle.wrapped_server,
    };

    await expect(openServerBundleWithServerKey(spliced, serverKey)).rejects.toThrow();

    // What the refusal is worth: the recovery half still opens to the VICTIM's
    // Master DEK. Had the server half been accepted it would have yielded the
    // donor's, and the realm would have run for its whole life under a key its
    // recovery phrase does not unlock.
    expect(b64(await openServerBundleWithRecoveryKey(spliced, victimRecoveryKey)))
      .toBe(b64(victim.masterDEK));
    expect(b64(donor.masterDEK)).not.toBe(b64(victim.masterDEK));
  });

  it('refuses a recovery wrap lifted from another bundle', async () => {
    const recoveryKey = generateRecoveryKey().mnemonic;
    const victim = await createServerBundle({ recoveryKey, serverKey: generateServerKey() });
    const donor = await createServerBundle({ recoveryKey, serverKey: generateServerKey() });

    const spliced: ServerBundle = {
      ...victim.bundle,
      salt_rec: donor.bundle.salt_rec,
      wrapped_rec: donor.bundle.wrapped_rec,
    };

    await expect(openServerBundleWithRecoveryKey(spliced, recoveryKey)).rejects.toThrow();
  });

  it('gives every bundle its own id', async () => {
    const { recoveryKey, serverKey } = enrollInputs();
    const a = await createServerBundle({ recoveryKey, serverKey });
    const b = await createServerBundle({ recoveryKey, serverKey });
    expect(a.bundle.bundle_id).not.toBe(b.bundle.bundle_id);
    expect(a.bundle.bundle_id.length).toBeGreaterThan(0);
  });

  it('keeps the id across a rewrap, so the untouched recovery wrap still opens', async () => {
    const { recoveryKey, serverKey } = enrollInputs();
    const { bundle, masterDEK } = await createServerBundle({ recoveryKey, serverKey });
    const rebound = await rewrapServerBundleForServerKey(
      bundle,
      recoveryKeyToEntropy(recoveryKey),
      generateServerKey(),
    );

    expect(rebound.bundle_id).toBe(bundle.bundle_id);
    expect(b64(await openServerBundleWithRecoveryKey(rebound, recoveryKey))).toBe(b64(masterDEK));
  });
});

describe('serverBundleToJSON / serverBundleFromJSON', () => {
  it('round-trips a bundle that still opens with both factors', async () => {
    const { recoveryKey, serverKey } = enrollInputs();
    const { bundle, masterDEK } = await createServerBundle({ recoveryKey, serverKey });

    const back = serverBundleFromJSON(serverBundleToJSON(bundle));
    expect(back).toEqual(bundle);
    expect(b64(await openServerBundleWithServerKey(back, serverKey))).toBe(b64(masterDEK));
    expect(b64(await openServerBundleWithRecoveryKey(back, recoveryKey))).toBe(b64(masterDEK));
  });

  it('rejects malformed JSON', () => {
    expect(() => serverBundleFromJSON('not json')).toThrow('malformed');
  });

  it('rejects JSON missing required fields', () => {
    expect(() => serverBundleFromJSON(JSON.stringify({ version: 1 }))).toThrow('missing required');
  });

  it('carries the bundle id, without which neither wrap would open', async () => {
    const { recoveryKey, serverKey } = enrollInputs();
    const { bundle } = await createServerBundle({ recoveryKey, serverKey });

    const json = JSON.parse(serverBundleToJSON(bundle)) as Record<string, unknown>;
    expect(json.bundle_id).toBe(bundle.bundle_id);

    const { bundle_id: _dropped, ...without } = json;
    expect(() => serverBundleFromJSON(JSON.stringify(without))).toThrow('missing required');
  });

  it('projects an exact field set, so an extra key cannot ride along', async () => {
    const { recoveryKey, serverKey } = enrollInputs();
    const { bundle } = await createServerBundle({ recoveryKey, serverKey });

    const smuggled = { ...bundle, attacker_note: 'ride along' } as ServerBundle;
    const round = JSON.parse(serverBundleToJSON(smuggled)) as Record<string, unknown>;
    expect(Object.hasOwn(round, 'attacker_note')).toBe(false);
  });
});
