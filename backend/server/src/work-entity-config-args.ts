/** D-192 — resolve `connection_config` → op-arg bindings against the bound
 *  connection's parsed config.
 *
 *  One resolver for every consumer of a `WorkEntityConfigArgBinding` set:
 *   - the sync runner's LIST walk (`op_arg_bindings.list` — Asana `workspace`,
 *     Google Tasks `tasklist`);
 *   - the targeted READ (`op_arg_bindings.read` — Google Tasks `tasklist`);
 *   - the write executor's create args (`create_arg_bindings` — Linear `teamId`).
 *
 *  Keeping the resolution in ONE place is deliberate: the own-property guard and
 *  the unset check must be identical across list / read / create so a
 *  per-connection scoping arg can never resolve differently on one path than
 *  another. A bound-but-unset (or inherited-only) key returns a STRUCTURED
 *  failure; each caller formats its own message (a sync cycle degrades, a read
 *  config-fails, a create config-refuses) and never issues the bad request. */

import type { WorkEntityConfigArgBinding } from '@recued/contracts';

export type ConfigArgResolution =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; arg: string; config_key: string };

/** Resolve a `{ argName → { source:'connection_config', config_key } }` map to a
 *  flat `{ argName → value }` op-arg object. Returns the first unset binding's
 *  `arg`/`config_key` on failure so the caller can name it. `undefined` bindings
 *  resolve to an empty arg set (a Source with no scoping args — e.g. Todoist —
 *  yields `{}`, the pre-existing full-walk behavior). */
export const resolveConfigArgBindings = (
  bindings: Record<string, WorkEntityConfigArgBinding> | undefined,
  connection_config: Record<string, unknown> | undefined,
): ConfigArgResolution => {
  const args: Record<string, unknown> = {};
  for (const [argName, binding] of Object.entries(bindings ?? {})) {
    // A `static` binding is a CONSTANT baked into the declaration (Zoho
    // `module='Tasks'`) — never per-connection, always resolves. The validator
    // guarantees a non-empty string value at publish, so it can never produce a
    // bad request; no connection_config lookup, no failure path.
    if (binding.source === 'static') {
      args[argName] = binding.value;
      continue;
    }
    // OWN-property only — an inherited key (`__proto__` / `constructor`) would
    // otherwise resolve `Object.prototype` and slip past the unset guard with a
    // bogus value instead of failing (the write path's create-arg guard,
    // shared).
    const value = connection_config !== undefined
      && Object.prototype.hasOwnProperty.call(connection_config, binding.config_key)
      ? connection_config[binding.config_key]
      : undefined;
    if (value === undefined || value === null || value === '') {
      return { ok: false, arg: argName, config_key: binding.config_key };
    }
    args[argName] = value;
  }
  return { ok: true, args };
};
