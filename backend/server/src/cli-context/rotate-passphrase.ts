/** D-212 — `recued rotate-passphrase`, the cheap half of changing how a
 *  keyfile is sealed.
 *
 *  Sits beside `recover-keyfile` deliberately rather than inside it. They
 *  share a subject and nothing else: regeneration's entry condition is a
 *  keyfile nobody can open, it needs the 24-word recovery key, and it costs
 *  the server identity. This one's entry condition is a keyfile that opens
 *  fine, it needs only the passphrase already in use, and it costs nothing.
 *  One command covering both would have to say "recover" to an operator doing
 *  routine maintenance, and the name would stop describing the behaviour.
 *
 *  ⚠ Reads both passphrases from STDIN, never argv — a command line lands in
 *  the process list and the shell history, and this one seals the realm.
 */

import { promptSecret } from '../cli/password-prompt.js';
import { getArg } from '../cli/parse.js';
import type { BootTrace } from '../cli/boot-trace.js';
import {
  PassphraseRotationError,
  rotateKeyfilePassphrase,
} from '../keyfile-passphrase-rotation.js';
import { resolveIdentityKeysPath } from '../identity/boot.js';

export interface RotatePassphraseProfileOptions {
  args: string[];
  bootTrace?: BootTrace;
  env?: NodeJS.ProcessEnv;
  out?: (line: string) => void;
  /** Injectable so the wiring test does not need a TTY. Called once per
   *  prompt, in order. */
  readSecret?: (prompt: string) => Promise<string>;
}

/** ⚠ `promptSecret` HIDES the input on a tty. The obvious `readline` version
 *  echoes it, which puts passphrases in the terminal
 *  scrollback, in any session recording, and over the shoulder of anyone
 *  watching — for a credential that opens the whole realm. The repo already
 *  had the non-echoing reader; this reaches for it. */
const promptForSecret = async (prompt: string): Promise<string> =>
  (await promptSecret(prompt)).trim();

export async function runRotatePassphraseProfile(
  options: RotatePassphraseProfileOptions,
): Promise<void> {
  const env = options.env ?? process.env;
  const out = options.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  const ask = options.readSecret ?? promptForSecret;
  const dbPath = getArg(options.args, 'db') ?? env.DB_PATH ?? './recued-server.db';
  const keyfilePath = resolveIdentityKeysPath(dbPath);

  out('');
  out(`This changes the passphrase that seals ${keyfilePath}.`);
  out('');
  out('  ✔ Your realm, your data and your server IDENTITY are untouched —');
  out('    no device re-pairs, the publisher identity is unchanged, and the');
  out('    account binding stays bound.');
  out('  ✔ The old keyfile is kept beside the new one, not deleted.');
  out('');
  out('  The server must be STOPPED: a running one holds the old passphrase in');
  out('  memory and would rewrite the keyfile under it.');
  out('');

  // The CURRENT passphrase comes from the environment when it is there — that
  // is where the server reads it, so it is the value actually sealing the file
  // and asking the operator to retype it invites a typo that reads as "wrong
  // passphrase". Prompted only when the shell does not carry it.
  const fromEnv = env.RECUED_IDENTITY_PASSPHRASE;
  const currentPassphrase = fromEnv && fromEnv.length > 0
    ? fromEnv
    : await ask('Current passphrase: ');
  if (fromEnv && fromEnv.length > 0) {
    out('Using the current passphrase from RECUED_IDENTITY_PASSPHRASE.');
  }

  const newPassphrase = await ask('New passphrase: ');
  const confirm = await ask('New passphrase again: ');
  if (newPassphrase !== confirm) {
    // Refuse on a mismatch rather than sealing under the first one: the
    // operator would be locked out by their own typo at the next boot, with
    // the recovery key as the only way back.
    console.error('\n✘ The two new passphrases do not match. Nothing was changed.\n');
    process.exitCode = 1;
    return;
  }

  options.bootTrace?.mark('rotate-passphrase-start');
  try {
    const result = await rotateKeyfilePassphrase({
      dbPath,
      currentPassphrase,
      newPassphrase,
    });

    out('');
    out(`✔ Keyfile re-sealed at ${result.keyfilePath}`);
    out(`  server identity:  ${result.serverIdentityFingerprint} (unchanged)`);
    out(`  previous keyfile: ${result.backupPath}`);
    // The record, and only when there IS one. "When did the sealing factor last
    // change, and did I do it?" is asked months later, and an operator who
    // never learns the record exists will not go looking for it.
    out(result.eventRecorded
      ? '  recorded in:      keyfile-events.log (audited on the next server start)'
      : '  ⚠ NOT RECORDED —  keyfile-events.log could not be written, so this change'
        + '\n                    leaves no audit trail beyond the previous keyfile above.');
    out('');
    // ⛔ The loudest line, because it is the one that bricks the next boot if
    // it is skipped. Nothing here can verify a systemd unit or a compose file,
    // so the only honest move is to say it plainly and say it last.
    out('  ⚠ SET THE NEW PASSPHRASE BEFORE STARTING THE SERVER.');
    out('    RECUED_IDENTITY_PASSPHRASE must carry the new value wherever the');
    out('    server starts from — systemd EnvironmentFile, compose env_file, or');
    out('    your secret manager. Until it does, the server will refuse to boot');
    out('    rather than open the keyfile without it.');
    out('');
    out('  Once the server starts cleanly, the previous keyfile can be deleted.');
  } catch (err) {
    if (err instanceof PassphraseRotationError) {
      // Every one of these fires before the keyfile is touched, except
      // `verify_failed`, which restores it. The named code is the useful
      // output: each says what to do instead.
      console.error(`\n✘ ${err.code}\n\n${err.message}\n`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}
