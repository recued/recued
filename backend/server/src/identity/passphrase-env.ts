/** Env-var name the boot path reads for the optional file passphrase.
 *  Closed-string constant so tests + docs reference one source.
 *
 *  A leaf of its own so that code keeping the passphrase AWAY from a child
 *  process (`supervision/env-for-others.ts`) can name it without loading the
 *  key store. `identity/boot.ts` re-exports it. */
import { readFileSync } from 'node:fs';

export const IDENTITY_PASSPHRASE_ENV_VAR = 'RECUED_IDENTITY_PASSPHRASE';

/** Names a FILE that holds the passphrase, instead of holding it. This is the
 *  convention for a container secret (`/run/secrets/<name>`): the value stays
 *  out of `docker inspect`, out of the compose file people paste into forums,
 *  and out of the data volume's backups, which is what sealing protects. */
export const IDENTITY_PASSPHRASE_FILE_ENV_VAR = 'RECUED_IDENTITY_PASSPHRASE_FILE';

/** Why a server inside a container will not create its key file unsealed.
 *  There is no keychain and no secret service there, so the only alternative
 *  to a passphrase is an unsealed file in the data volume. */
export const CONTAINER_UNSEALED_REFUSAL =
  '[keys] Refusing to write the key file unsealed: inside a container nothing can seal it but a passphrase, '
  + 'and none is set. Unsealed, it would let anyone with a copy of the data volume, or a backup of it, open the realm. '
  + `Give the container one as a secret file: ${IDENTITY_PASSPHRASE_FILE_ENV_VAR}=/run/secrets/recued_identity_passphrase, `
  + 'with the file mounted there (docker-compose.yml shows how).';

/** The identity passphrase: `RECUED_IDENTITY_PASSPHRASE`, or the contents of
 *  the file `RECUED_IDENTITY_PASSPHRASE_FILE` names, without trailing line
 *  breaks (`echo` adds one). `undefined` when neither is set; an empty value
 *  counts as unset, as it always has.
 *
 *  ⛔ A NAMED FILE THAT YIELDS NOTHING THROWS — it never answers `undefined`.
 *  Unreadable, empty, or set alongside the variable: each would otherwise read
 *  as "no passphrase", and a server that finds none on its first boot stores
 *  its key file UNSEALED. Someone who named a file meant to seal. */
export const readIdentityPassphrase = (
  env: Readonly<Record<string, string | undefined>>,
): string | undefined => {
  const value = env[IDENTITY_PASSPHRASE_ENV_VAR] || undefined;
  const file = env[IDENTITY_PASSPHRASE_FILE_ENV_VAR] || undefined;
  if (file === undefined) return value;
  if (value !== undefined) {
    throw new Error(
      `Both ${IDENTITY_PASSPHRASE_ENV_VAR} and ${IDENTITY_PASSPHRASE_FILE_ENV_VAR} are set. `
      + 'Set one: the file for a container secret, the variable anywhere else. Moving to the file, '
      + `remove ${IDENTITY_PASSPHRASE_ENV_VAR} from wherever it is set (an env_file, the service's environment).`,
    );
  }
  let bytes: Buffer;
  try {
    bytes = readFileSync(file);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'unreadable';
    throw new Error(
      `${IDENTITY_PASSPHRASE_FILE_ENV_VAR} names ${file}, which cannot be read (${code}). `
      + 'Mount the secret there, readable by the user the server runs as.',
    );
  }
  const passphrase = decodeSecretFile(bytes, file).replace(/[\r\n]+$/, '');
  if (passphrase === '') {
    throw new Error(`${file}, named by ${IDENTITY_PASSPHRASE_FILE_ENV_VAR}, is empty. Put the passphrase in it.`);
  }
  return passphrase;
};

/** The text of a secret file, whichever way an editor or shell saved it.
 *
 *  ⛔ A MIS-DECODED PASSPHRASE STILL SEALS, AND THAT IS THE TRAP. Windows
 *  PowerShell 5.1's `"…" > file` writes UTF-16LE with a byte-order mark; read
 *  as UTF-8 that is `\uFFFD\uFFFDp\0w\0…`, which seals the realm consistently
 *  and fails only later, when the same passphrase is typed or rewritten as
 *  plain text: "wrong passphrase", then the recovery key and a re-pair. So a
 *  UTF-16LE file is decoded, a UTF-8 byte-order mark is dropped, and anything
 *  still holding NUL or U+FFFD is refused rather than used. */
const decodeSecretFile = (bytes: Buffer, file: string): string => {
  let text: string;
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    text = bytes.subarray(2).toString('utf16le');
  } else {
    text = bytes.toString('utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  }
  if (text.includes('\u0000') || text.includes('\ufffd')) {
    throw new Error(
      `${file}, named by ${IDENTITY_PASSPHRASE_FILE_ENV_VAR}, is not plain UTF-8 text. Save it as UTF-8 `
      + "(PowerShell: Set-Content -Encoding utf8 -NoNewline -Path <file> -Value '<passphrase>').",
    );
  }
  return text;
};
