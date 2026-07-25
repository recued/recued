/** Server vault enrollment + boot auto-unlock orchestration (slice 3).
 *
 *  Two small helpers that couple the KeyManager to the keyfile-held
 *  server key. They are the CALLERS of the slice-2 mechanism:
 *
 *    - `enrollServerVaultFromRecoveryKey` — the FIRST-BOOT path. Runs at
 *      `/auth/pair` (+ the `pair.registerRecoveryKey` WS twin) when the
 *      user confirms their recovery key. Mints a server key, persists it
 *      in the keyfile, and initializes the vault bundle so the Master DEK
 *      is dual-wrapped (server key + recovery key). Encryption turns on
 *      here and nowhere else.
 *
 *    - `autoUnlockServerVaultFromKeyfile` — the RUNNING path. Runs once
 *      at boot: reads the server key from the keyfile and unlocks the
 *      Master DEK, so a headless server decrypts its own warehouse with
 *      no human present. The recovery key is NOT involved on this path —
 *      it is a connection credential + disaster-recovery anchor only.
 *
 *  Crash-safety ordering (enroll): the server key is written to the
 *  keyfile AND FLUSHED before the bundle is created. A crash between the
 *  two leaves an orphan key in the keyfile but NO bundle — the next
 *  attempt sees `state === 'uninitialized'` and harmlessly regenerates,
 *  overwriting the orphan. The inverse order (bundle first) could leave a
 *  bundle the keyfile can't open — a headless lock-out recoverable only
 *  via the recovery key — so we avoid it.
 *
 *  Single-flight assumption: first-boot enrollment is inherently
 *  single-shot (a human confirms the recovery key once; every subsequent
 *  pair short-circuits on `state !== 'uninitialized'`). The helper does
 *  not lock against two concurrent first-pairs with DIFFERENT recovery
 *  keys — a practically impossible race on the pairing path — beyond the
 *  KeyManager's own orphan guard, which fails the loser.
 */

import { generateServerKey } from '@recued/crypto';
import type { KeyManager } from './key-manager.js';
import type { ServerKeyStore } from './keys/index.js';

export type ServerVaultEnrollResult = 'enrolled' | 'already_enrolled';
export type ServerVaultUnlockResult = 'unlocked' | 'skipped';

/** First-boot: enrol the server vault from the user's recovery key.
 *  Idempotent — a no-op (`'already_enrolled'`) once a bundle exists, so
 *  a re-pair on an already-encrypted server does nothing. Throws only on
 *  a genuinely bad recovery key (propagated from the KeyManager) — the
 *  caller should fail the pair so a pairing never completes un-encrypted. */
export const enrollServerVaultFromRecoveryKey = async (args: {
  keys: KeyManager;
  keyStore: Pick<ServerKeyStore, 'saveServerVaultKey' | 'flush'>;
  recoveryKey: string;
}): Promise<ServerVaultEnrollResult> => {
  const { keys, keyStore, recoveryKey } = args;
  // Only the very first pair (no bundle yet) enrols. Locked / unlocked
  // both mean "already encrypted" → nothing to do.
  if (keys.state() !== 'uninitialized') return 'already_enrolled';

  const serverKey = generateServerKey();
  // Keyfile first + flush: the auto-unlock secret is durably on disk
  // before the bundle references it. Orphan-on-crash is self-healing.
  keyStore.saveServerVaultKey(serverKey);
  if (keyStore.flush) await keyStore.flush();

  // Creates the bundle (validates the mnemonic; throws on a bad one) and
  // enters unlocked state. Same `serverKey` as the keyfile → the boot
  // path will be able to reopen it.
  await keys.initServerVault({ recoveryKey, serverKey });
  return 'enrolled';
};

/** Boot: auto-unlock the vault from the keyfile-held server key. No-op
 *  (`'skipped'`) unless the manager is `locked` (a bundle is persisted)
 *  AND a server key is present in the keyfile — so a fresh / password-only
 *  realm is untouched. A wrong or tampered key propagates (the caller
 *  should surface it rather than silently run locked). */
export const autoUnlockServerVaultFromKeyfile = async (args: {
  keys: KeyManager;
  keyStore: Pick<ServerKeyStore, 'loadServerVaultKey'>;
}): Promise<ServerVaultUnlockResult> => {
  const { keys, keyStore } = args;
  if (keys.state() !== 'locked') return 'skipped';
  const serverKey = keyStore.loadServerVaultKey();
  if (!serverKey) return 'skipped';
  await keys.unlockWithServerKey({ serverKey });
  return 'unlocked';
};
