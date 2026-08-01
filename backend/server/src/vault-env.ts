/** Resolve server vault overrides from environment variables.
 *
 *  Convention: RECUED_VAULT_{key}=value -> vault[key] = value.
 *  The key is lower-cased to match the historical server-executor
 *  helper behavior.
 */
export const resolveVaultFromEnv = (
  env: Record<string, string | undefined> = process.env,
): Record<string, unknown> => {
  const vault: Record<string, unknown> = {};
  const prefix = 'RECUED_VAULT_';
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith(prefix) && value !== undefined) {
      const vaultKey = key.slice(prefix.length).toLowerCase();
      vault[vaultKey] = value;
    }
  }
  return vault;
};

/** Merge vault sources: stored -> env -> request overrides (last wins).
 *
 *  `fileVault` is vestigial naming from a `--vault-file` source that was never
 *  implemented; both production call sites pass the VaultStore-loaded
 *  credentials in that slot. Note those are publisher-nested while env entries
 *  are flat, so the spread only overrides on an exact top-level key collision. */
export const mergeVault = (
  fileVault: Record<string, unknown>,
  envVault: Record<string, unknown>,
  requestVault?: Record<string, unknown>,
): Record<string, unknown> => {
  return { ...fileVault, ...envVault, ...(requestVault ?? {}) };
};
