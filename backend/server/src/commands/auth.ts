/** `recued unlock` — the encryption CLI that is left.
 *
 *  `unlock` posts the recovery key to `/auth/pair` on the running daemon.
 *
 *  ⛔ `auth-status` AND `lock` ARE RETIRED (owner's call, 2026-10-07). Both
 *  reached the server over the rpc socket with the raw realm token, which the
 *  server refuses since `89ba9bb31` — a 401 on every release from 26.8.1 —
 *  and the CLI holds no other credential. The names still answer, with what to
 *  do instead (`retiredEncryptionCommandLines`), rather than falling through
 *  to the help screen. The keyfile posture `auth-status` was meant to show
 *  lives on the webclient's Settings → Server → Key Health page (D-212 §7.10).
 */

export interface UnlockCommandDeps {
  port: number;
}

/** What `recued unlock` says, as a value. */
export type UnlockOutcome =
  | { readonly ok: true; readonly line: string }
  | { readonly ok: false; readonly line: string };

/** Give a running server its keys back with the 24-word recovery key.
 *
 *  ⛔ OVER `/auth/pair`, NOT THE rpc SOCKET. `auth.unlock` went over
 *  the CLI's rpc client (`cli/rpc-client.ts`, removed 2026-10-07), which the
 *  server has refused with a 401 since the socket
 *  stopped taking the raw realm token (`89ba9bb31`, first released in
 *  26.8.1) — so the disaster-recovery command never reached the server.
 *  `/auth/pair` with a recovery key is the webclient's re-pair route: it
 *  verifies the key against the realm and unlocks the vault (measured on
 *  26.10.6 against a locked realm: `auth.state` unlocked, the sync loops
 *  resumed). The recovery key IS the credential there, as here.
 *
 *  No `instanceId` is sent, so no device joins the Devices roster. The
 *  route still mints a client token; it is dropped unread, so its secret
 *  exists only in this process's memory. */
export const unlockWithRecoveryKey = async (input: {
  readonly port: number;
  readonly recoveryKey: string;
  /** Tests inject; production uses the global. */
  readonly fetchImpl?: typeof fetch;
}): Promise<UnlockOutcome> => {
  const recoveryKey = input.recoveryKey.trim();
  if (recoveryKey.length === 0) return { ok: false, line: '  ✗ No recovery key entered.' };
  const fetchImpl = input.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl(`http://127.0.0.1:${input.port}/auth/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ recoveryKey, clientKind: 'cli', displayName: 'recued unlock' }),
    });
  } catch {
    return {
      ok: false,
      line: `  ✗ No Recued server answered on 127.0.0.1:${input.port}. Start it first. `
        + 'A server whose keyfile is sealed with a passphrase starts only with '
        + 'RECUED_IDENTITY_PASSPHRASE in its environment.',
    };
  }
  if (res.ok) return { ok: true, line: '  ✓ Unlocked.' };
  let error: { code?: unknown; message?: unknown } = {};
  try {
    error = ((await res.json()) as { error?: typeof error }).error ?? {};
  } catch {
    // A body that is not JSON says nothing more than the status.
  }
  if (error.code === 'recovery_key_invalid') {
    return { ok: false, line: '  ✗ That recovery key does not match this server.' };
  }
  // An enrolled realm takes the key alone; only one that never paired asks
  // for a code — and it has no keys to lock.
  if (res.status === 400 && typeof error.message === 'string' && /code is required/.test(error.message)) {
    return {
      ok: false,
      line: '  ✗ This server has never been paired, so it has no recovery key yet. '
        + 'Pair a client to it first (recued pair).',
    };
  }
  const detail = typeof error.message === 'string' && error.message.length > 0
    ? error.message
    : `HTTP ${res.status}`;
  return { ok: false, line: `  ✗ Unlock failed: ${detail}` };
};

/** `recued unlock` — the recovery key, never a password.
 *
 *  The PASSWORD form is retired (2026-10-07): it unlocked the pre-D-212
 *  password bundle, which a D-212 realm never has, and a D-212 server
 *  unlocks itself at boot from its keyfile. `--recovery-key` is still
 *  accepted and changes nothing. The key is read without echo — it opens
 *  everything this server holds, and a visible prompt leaves it in the
 *  terminal's scrollback. */
export async function cmdUnlock(deps: UnlockCommandDeps): Promise<void> {
  const { promptSecret } = await import('../cli/password-prompt.js');
  const recoveryKey = await promptSecret('Enter 24-word recovery key: ');
  const outcome = await unlockWithRecoveryKey({ port: deps.port, recoveryKey });
  if (outcome.ok) {
    console.log(outcome.line);
    return;
  }
  console.error(outcome.line);
  process.exit(1);
}

/** The two retired commands, by name: what each says instead of running.
 *  A value, so the words can be asserted. */
export const retiredEncryptionCommandLines = (command: 'auth-status' | 'lock'): string[] =>
  command === 'auth-status'
    ? [
      '  recued auth-status has been removed.',
      '  How the server\'s key file is protected: the webclient, Settings → Server → Key Health.',
      '  Whether the server is running: recued status.',
    ]
    : [
      '  recued lock has been removed.',
      '  To take the server\'s keys out of memory, stop it: recued stop.',
    ];
