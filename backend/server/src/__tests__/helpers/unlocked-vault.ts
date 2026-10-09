/** Opens a composed server's vault the way first-boot enrollment leaves it: a
 *  D-212 server vault bundle, the Master DEK wrapped under a server key and a
 *  recovery key, both by HKDF. For tests that only need the vault unlocked —
 *  the server's secrets, the CAS, the AI adapter's sealed response cache.
 *
 *  ⛔ Not `keys.init({ password })`, which creates the password bundle (what
 *  `auth.init` creates). Its Argon2id runs at the production cost — 64 MiB,
 *  3 passes, 4 lanes, in JavaScript: 1.3-2.1 s per boot on an idle machine
 *  (this bundle: 1 ms), and far more under load, in every test that boots a
 *  server. Measured 2026-10-08 on a busy machine: a `bills-pack-live` test
 *  took 6-19.5 s with it and 4.2 s without, and three
 *  `d-316-content-known-values-composed` tests ran past their 30 s limit with
 *  it, none without.
 *
 *  ⚠ Enrollment (`enrollServerVaultFromRecoveryKey`) also re-encrypts the
 *  database (`rekeyDatabase`). This does not; nor did the password path. */
import { generateRecoveryKey, generateServerKey } from '@recued/crypto';

import type { KeyManager } from '../../key-manager.js';

export const unlockServerVault = (keys: KeyManager): Promise<void> =>
  keys.initServerVault({ recoveryKey: generateRecoveryKey().mnemonic, serverKey: generateServerKey() });
