/** D-118 Phase 5 — argv / env ref resolver.
 *
 *  The supervisor resolves `{{config.*}}` in argv + env (spec line
 *  537) and `{{vault.*}}` in env (spec line 538) before spawning.
 *  Argv ref resolution matches the Phase 4 checker dispatcher's
 *  contract — pure refs preserve type, interpolation stringifies —
 *  but argv strings must ultimately be strings, so the walker here
 *  always returns strings. Env values are always strings too.
 *
 *  Vault refs only resolve inside `env`; argv that contains
 *  `{{vault.*}}` is a manifest authoring error (vault values are
 *  credentials, not positional arguments) and left as literal text
 *  so the binary surfaces a clear "unknown flag" error.
 */

import type { VaultResolveFn } from './types.js';
import { hasOwnSafe, setSafeKey } from '../key-safety.js';

const CONFIG_REF = /\{\{\s*config\.([^}:\s]+)\s*\}\}/g;
const VAULT_REF = /\{\{\s*vault\.([^}:\s]+)\s*\}\}/g;

const walkPath = (obj: unknown, path: string): unknown => {
  let cur = obj;
  for (const seg of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    if (!hasOwnSafe(cur as Record<string, unknown>, seg)) return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
};

/** Resolve only `{{config.*}}` — used for argv values. Vault refs
 *  are deliberately NOT substituted (see module header). */
export const resolveArgvValue = (
  value: string,
  config: Record<string, unknown>,
): string => {
  return value.replace(CONFIG_REF, (match, path: string) => {
    const resolved = walkPath(config, path);
    if (resolved == null) return match;
    return typeof resolved === 'object'
      ? JSON.stringify(resolved)
      : String(resolved);
  });
};

export const resolveArgv = (
  argv: string[],
  config: Record<string, unknown>,
): string[] => argv.map((a) => resolveArgvValue(a, config));

/** Resolve `{{config.*}}` + `{{vault.*}}` — used for env values.
 *  Missing vault keys leave the ref as literal text so the
 *  downstream binary's own error surfaces ("invalid API key"
 *  rather than a silent-empty swap). */
export const resolveEnvValue = (
  value: string,
  config: Record<string, unknown>,
  publisher_id: string,
  resolveVault: VaultResolveFn | undefined,
): string => {
  let out = value.replace(CONFIG_REF, (match, path: string) => {
    const resolved = walkPath(config, path);
    if (resolved == null) return match;
    return typeof resolved === 'object'
      ? JSON.stringify(resolved)
      : String(resolved);
  });
  out = out.replace(VAULT_REF, (match, key: string) => {
    const resolved = resolveVault?.(publisher_id, key);
    return resolved === undefined ? match : resolved;
  });
  return out;
};

export const resolveEnv = (
  env: Record<string, string> | undefined,
  config: Record<string, unknown>,
  publisher_id: string,
  resolveVault: VaultResolveFn | undefined,
): Record<string, string> | undefined => {
  if (!env) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    setSafeKey(out, k, resolveEnvValue(v, config, publisher_id, resolveVault));
  }
  return out;
};

/** Redact resolved `{{vault.*}}` values from argv before they
 *  land in audit events. Per spec line 936 + decision #18 — audit
 *  log never carries plaintext secrets. The supervisor composes
 *  argv from resolved config + vault, then walks a parallel
 *  "redaction map" keyed by the vault key names that appeared in
 *  the raw env to scrub matching values out of the displayed argv. */
export const redactArgvForAudit = (
  argv: string[],
  vaultKeys: ReadonlySet<string>,
  resolvedVaultValues: ReadonlyMap<string, string>,
): string[] => {
  if (vaultKeys.size === 0) return argv;
  return argv.map((a) => {
    for (const key of vaultKeys) {
      const value = resolvedVaultValues.get(key);
      if (value !== undefined && a === value) {
        return `<vault:${key}>`;
      }
    }
    return a;
  });
};
