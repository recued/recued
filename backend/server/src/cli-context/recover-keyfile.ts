/** D-212 §7.11 — `recued recover-keyfile`, the operator surface for the escape
 *  hatch.
 *
 *  ⛔ This is a CLI command and cannot be anything else. Its entry condition is
 *  a keyfile the server cannot open, and a server that cannot open its keyfile
 *  does not boot — so there is no rpc, no webclient screen, and no pairing flow
 *  to host it. The one person who can act is at a terminal.
 *
 *  ⚠ It reads the recovery key from STDIN, never argv. A 24-word mnemonic on a
 *  command line lands in the process list and the operator's shell history, and
 *  this one opens the entire realm.
 */

import { promptSecret } from '../cli/password-prompt.js';
import { getArg, getFlag } from '../cli/parse.js';
import type { BootTrace } from '../cli/boot-trace.js';
import {
  KeyfileRecoveryError,
  regenerateKeyfileFromRecoveryKey,
} from '../keyfile-recovery.js';
import { resolveIdentityKeysPath } from '../identity/boot.js';

export interface RecoverKeyfileProfileOptions {
  args: string[];
  bootTrace?: BootTrace;
  env?: NodeJS.ProcessEnv;
  out?: (line: string) => void;
  /** Injectable so the wiring test does not need a TTY. */
  readSecret?: (prompt: string) => Promise<string>;
}

/** ⚠ `promptSecret` HIDES the input on a tty. The obvious `readline` version
 *  echoes it, which puts the recovery key in the terminal
 *  scrollback, in any session recording, and over the shoulder of anyone
 *  watching — for a credential that opens the whole realm. The repo already
 *  had the non-echoing reader; this reaches for it. */
const promptForSecret = async (prompt: string): Promise<string> =>
  (await promptSecret(prompt)).trim();

export async function runRecoverKeyfileProfile(
  options: RecoverKeyfileProfileOptions,
): Promise<void> {
  const env = options.env ?? process.env;
  const out = options.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  const dbPath = getArg(options.args, 'db') ?? env.DB_PATH ?? './recued-server.db';
  const keyfilePath = resolveIdentityKeysPath(dbPath);

  // ⛔ Say the cost BEFORE asking for the key. The keyfile is not only the
  // server vault key — it carries the signing identity, the publisher identity
  // and the account binding, and none of those survive. §7.2's "costs a re-pair,
  // never data" is accurate but reads cheaper than it is, and an operator who
  // learns this afterwards has already paid.
  out('');
  out(`This re-creates ${keyfilePath} from your 24-word recovery key.`);
  out('');
  out('  ✔ Your data is recovered — the realm reopens and nothing is lost.');
  out('  ✘ The server IDENTITY is not. It lives in the same file, and a new one');
  out('    is minted, so:');
  out('      · every paired device must pair again');
  out('      · the publisher identity changes');
  out('      · the recued.com account binding is cleared and must be re-bound');
  out('');
  out('  The unopenable keyfile is moved aside, not deleted.');
  out('');

  if (!getFlag(options.args, 'yes')) {
    const confirm = await (options.readSecret ?? promptForSecret)(
      'Type "recover" to continue: ',
    );
    if (confirm !== 'recover') {
      out('Cancelled — nothing was changed.');
      process.exitCode = 1;
      return;
    }
  }

  const recoveryKey = await (options.readSecret ?? promptForSecret)(
    'Recovery key (24 words): ',
  );

  options.bootTrace?.mark('recover-keyfile-start');
  try {
    const result = await regenerateKeyfileFromRecoveryKey({
      dbPath,
      recoveryKey,
      env,
      // The server's own composition root opts into sealing, and so does this:
      // a regenerated keyfile is a FRESH one, so §7.10's first-boot choice
      // applies to it and this host gets to offer its best rung.
      machineSealing: true,
    });

    out('');
    out(`✔ Keyfile re-created at ${result.keyfilePath}`);
    out(`  sealed by:        ${result.posture}`);
    out(`  new fingerprint:  ${result.serverIdentityFingerprint}`);
    if (result.displacedTo) out(`  previous keyfile: ${result.displacedTo}`);
    // Weightier here than on a rotation: this is the only durable record that
    // the server IDENTITY was replaced, and the identity is what every paired
    // device is about to reject.
    out(result.eventRecorded
      ? '  recorded in:      keyfile-events.log (audited on the next server start)'
      : '  ⚠ NOT RECORDED —  keyfile-events.log could not be written, so this change'
        + '\n                    leaves no audit trail beyond the previous keyfile above.');
    if (result.posture === 'none') {
      out('');
      out('  ⚠ UNSEALED — this host offers no secret store and no passphrase is set,');
      out('    so anyone who copies this directory gets the keys to the realm with it.');
      out('    Set RECUED_IDENTITY_PASSPHRASE and run this again to seal it.');
    }
    out('');
    out('Start the server and pair your devices again.');
  } catch (err) {
    if (err instanceof KeyfileRecoveryError) {
      // A named refusal is the useful output here — these are the cases where
      // the operator should NOT proceed, and each says why.
      console.error(`\n✘ ${err.code}\n\n${err.message}\n`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}
