/** The environment for a program the server starts on someone else's behalf:
 *  a pack's command-line tool, or a service a pack installs, checks, invokes
 *  or runs. It is the server's own environment, minus what is the server's alone.
 *
 *  ⛔ WHY. `RECUED_IDENTITY_PASSPHRASE` unseals the server's key file, and the
 *  key file carries the unwrap key of the encrypted database: the data folder
 *  plus the passphrase is the realm. The owner supplies it in the server's own
 *  environment (a systemd EnvironmentFile, a launchd entry, a container's
 *  environment), as the key store's own error tells them to, and a child
 *  inherits its parent's environment. So every one of these programs could read
 *  it, coding agents included, which can run `env` and hand what they see to a
 *  model.
 *
 *  ⚠ NOT `delete process.env…` AT BOOT. The server reads it again after boot
 *  (`database-encryption.ts`), its own background re-launch (`daemon.ts`) and
 *  the managed launcher pass it to the server they start, and the system tools
 *  it runs (`ps`, `route`, the keychain helpers) are not someone else's code.
 *  Only programs run for others are denied it. Every site that starts one
 *  calls this, which `server-secrets-in-child-env.test.ts` holds by listing
 *  every importer of `node:child_process`.
 *
 *  The MCP stdio launcher needs none of this: it passes `PATH`, `HOME` and the
 *  connection's own variables, and inherits nothing. */

/** Recued's own namespace, withheld whole. Every `RECUED_*` variable configures
 *  the server or one of its commands, and several are secrets the server holds:
 *  the identity passphrase and its `_FILE` path, the LLM slots' API keys
 *  (`llm-env.ts`), the recovery key (`commands/archive.ts`), the MCP token, the
 *  experiment secret. No program run for someone else needs any of it, and a
 *  prefix withholds the NEXT secret too, where a list of names waits to be
 *  extended (the audit of 2026-10-09 found the LLM keys reaching every pack
 *  while the list named only the passphrase).
 *
 *  ⚠ WHAT THIS DOES NOT DO. A program running as the server's user can still
 *  read what that user can: the secret file itself, and on Linux the server's
 *  starting environment under `/proc/<pid>/environ`. Withholding keeps secrets
 *  out of what a tool is HANDED (an `env` dump, a log, a model's context), not
 *  out of reach of a tool that goes looking. The passphrase's job is the data
 *  folder at rest: a copied volume or backup carries no key. */
export const SERVER_ONLY_ENV_PREFIX = 'RECUED_';

/** Whether `name` is the server's own. Windows environment names are
 *  case-insensitive, so there `recued_identity_passphrase` IS the passphrase:
 *  the server reads it through `process.env` and a child would receive it. */
export const isServerOnlyEnvName = (
  name: string,
  platform: NodeJS.Platform = process.platform,
): boolean => (platform === 'win32' ? name.toUpperCase() : name).startsWith(SERVER_ONLY_ENV_PREFIX);

/** The server's environment with the program's own variables over it, and the
 *  server-only ones removed last, so `extra` cannot put one back. */
export const envForOthers = (
  extra?: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  for (const name of Object.keys(env)) {
    if (isServerOnlyEnvName(name, platform)) delete env[name];
  }
  return env;
};
