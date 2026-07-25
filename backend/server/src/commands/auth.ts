/** `recued-server auth-status | unlock | lock` — encryption CLI.
 *
 *  These commands talk to a running daemon over the local WebSocket.
 *  Require the daemon to already be listening on `port` with `dbPath`
 *  matching the caller's DB. Each command returns non-zero on RPC or
 *  transport failure so scripts can detect errors.
 */

export interface AuthCommandDeps {
  dbPath: string;
  port: number;
}

export interface UnlockCommandDeps extends AuthCommandDeps {
  /** When true, the unlock flow prompts for a 24-word recovery key
   *  instead of a password. Wired from the top-level `--recovery-key`
   *  flag on the CLI. */
  useRecoveryKey: boolean;
}

/** D-212 §7.10 — the `auth-status` keyfile-posture block, as a value.
 *
 *  A pure function rather than inline `console.log`s so the copy can be
 *  asserted: §7.11 requires the unsealed remedy to name what it COSTS, and
 *  a side effect nothing can read is a requirement nothing can enforce.
 *
 *  ⛔ `'none'` is NOT `null`. `null` means the server reported no posture
 *  (an older daemon, or an unwired key store) and this block says nothing
 *  at all rather than implying either answer; `'none'` is a KNOWN unsealed
 *  keyfile and always speaks. Collapsing them would delete the only control
 *  that replaced the retracted §7.9 refusal. */
export const keyfilePostureLines = (
  sealing: 'machine' | 'passphrase' | 'none' | null,
): string[] => {
  if (sealing === null) return [];
  if (sealing !== 'none') return [`  Keyfile:    sealed (${sealing})`];
  return [
    '  Keyfile:    ⚠ UNSEALED — the key that opens this realm is readable',
    '              beside the database. Anyone who copies this directory',
    '              gets everything.',
    // The remedy WITH its price. The earlier one-liner stopped at "set the
    // passphrase and run recover-keyfile", which reads far cheaper than it
    // is: regeneration mints a NEW server identity, because the keyfile also
    // holds `server_identity`, `publisher_identity` and the D-175 account
    // binding. An operator who learns that afterwards has already de-paired
    // their fleet.
    '              To seal it: set RECUED_IDENTITY_PASSPHRASE, then run',
    "              'recued recover-keyfile' with your 24-word recovery key.",
    '              That re-creates the server identity — every paired device',
    '              must pair again, the publisher identity changes, and the',
    '              account binding is lost. Your data is untouched.',
  ];
};

export async function cmdAuthStatus(deps: AuthCommandDeps): Promise<void> {
  const { callLocalRpc, RpcError } = await import('../cli/rpc-client.js');
  const { dbPath, port } = deps;
  try {
    const res = await callLocalRpc<{ state: string }>({
      dbPath, port, method: 'auth.state',
    });
    console.log(`  Auth state: ${res.state}`);

    // Also show migration status if relevant
    const mig = await callLocalRpc<{ active: boolean; phase?: string; progress?: { rowsDone: number; rowsTotal: number; blobsDone: number; blobsTotal: number }; bundleMissing?: boolean }>({
      dbPath, port, method: 'auth.migrate.status',
    });
    if (mig.active) {
      console.log(`  Migration: ${mig.phase}`);
      if (mig.progress) {
        console.log(`    rows: ${mig.progress.rowsDone} / ${mig.progress.rowsTotal}`);
        console.log(`    blobs: ${mig.progress.blobsDone} / ${mig.progress.blobsTotal}`);
      }
      if (mig.bundleMissing) {
        console.log(`  ⚠ Bundle missing — run 'recued unlock' with a bundle file to recover`);
      }
    } else {
      console.log('  Migration: none in progress');
    }

    // D-212 §7.10 — the standing posture surface, on the command an operator
    // already runs to ask about encryption. `auth.state` answers "is the vault
    // unlocked"; it says nothing about whether the key that does the unlocking
    // is protected, and those are different questions with the same-looking
    // happy answer. A realm can report `unlocked` while its keyfile sits in the
    // clear beside the database.
    //
    // Best-effort: an older daemon has no `keyfile_sealing` field, and a
    // missing posture must not fail a status command.
    try {
      const sys = await callLocalRpc<{
        status: { keyfile_sealing: 'machine' | 'passphrase' | 'none' | null };
      }>({ dbPath, port, method: 'system.status' });
      const sealing = sys.status?.keyfile_sealing ?? null;
      // ⛔ Never "—" for `'none'`. §7.10 permits an unsealed keyfile precisely
      // BECAUSE the posture stays visible; rendering it as absence would
      // delete the only control that replaced the retracted refusal.
      for (const line of keyfilePostureLines(sealing)) console.log(line);
    } catch {
      // Silent: the posture is an addition to this command, not its purpose.
    }
  } catch (err) {
    if (err instanceof RpcError) {
      console.error(`  Error: ${err.message} (${err.code})`);
    } else {
      console.error(`  Error: ${(err as Error).message}`);
    }
    process.exit(1);
  }
}

export async function cmdUnlock(deps: UnlockCommandDeps): Promise<void> {
  const { callLocalRpc, RpcError } = await import('../cli/rpc-client.js');
  const { promptSecret, promptLine } = await import('../cli/password-prompt.js');
  const { dbPath, port, useRecoveryKey } = deps;

  try {
    let args: Record<string, unknown>;
    if (useRecoveryKey) {
      const key = await promptLine('Enter 24-word recovery key: ');
      args = { recoveryKey: key.trim() };
    } else {
      const pw = await promptSecret('Enter password: ');
      args = { password: pw };
    }

    const res = await callLocalRpc<{ state: string }>({
      dbPath, port, method: 'auth.unlock', args,
    });
    console.log(`  ✓ Unlocked (state: ${res.state})`);
  } catch (err) {
    if (err instanceof RpcError) {
      console.error(`  ✗ Unlock failed: ${err.message} (${err.code})`);
    } else {
      console.error(`  ✗ ${(err as Error).message}`);
    }
    process.exit(1);
  }
}

export async function cmdLock(deps: AuthCommandDeps): Promise<void> {
  const { callLocalRpc, RpcError } = await import('../cli/rpc-client.js');
  const { dbPath, port } = deps;
  try {
    const res = await callLocalRpc<{ state: string }>({
      dbPath, port, method: 'auth.lock',
    });
    console.log(`  ✓ Locked (state: ${res.state})`);
  } catch (err) {
    if (err instanceof RpcError) {
      console.error(`  ✗ Lock failed: ${err.message} (${err.code})`);
    } else {
      console.error(`  ✗ ${(err as Error).message}`);
    }
    process.exit(1);
  }
}
