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
