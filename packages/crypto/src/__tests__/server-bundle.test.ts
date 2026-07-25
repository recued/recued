import { describe, it, expect } from 'vitest';
import {
  createServerBundle,
  openServerBundleWithServerKey,
  openServerBundleWithRecoveryKey,
  openServerBundleWithRecoveryEntropy,
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
});
