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

/** Merge vault sources: file -> env -> request overrides (last wins). */
export const mergeVault = (
  fileVault: Record<string, unknown>,
  envVault: Record<string, unknown>,
  requestVault?: Record<string, unknown>,
): Record<string, unknown> => {
  return { ...fileVault, ...envVault, ...(requestVault ?? {}) };
};
