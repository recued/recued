/** The `[bootstrap]` settings — the two that exist, the one renamed, and the four
 *  that were removed.
 *
 *  Live: `bind_port`, the port the server listens on, and `webhooks_enabled`, the
 *  inbound-webhook switch (see `types.ts`).
 *
 *  🔁 RENAMED 2026-10-10: `webhook_port` → `webhooks_enabled`. It was always an
 *  on/off switch wearing a port's name: 0 was off, any other number on, and no
 *  number was ever bound (D-272). Unlike the removed keys it still DOES something,
 *  so the old name keeps working in a file, in `RECUED_BOOTSTRAP_WEBHOOK_PORT` and
 *  as `--webhook-port`: any non-zero value reads as `webhooks_enabled = true`, and
 *  boot names the rename. When both names are set, `webhooks_enabled` wins.
 *
 *  ⛔ REMOVED 2026-10-09: `data_path`, `log_path`, `bind_host` and `mcp_port`.
 *  Nothing in the server ever read them. The server keeps its data beside the
 *  database that `--db` / `DB_PATH` names (`realm-db-path.ts`), writes its log
 *  there too, binds its LAN listener at `network.lan_bind_address`, and serves MCP
 *  at `/mcp` on its own port (D-272). Setting any of them moved, opened or
 *  disabled nothing, and nothing said so.
 *
 *  🔑 IGNORED WITH A WARNING, NEVER REJECTED. The VPS cloud-init templates wrote
 *  `data_path`, `bind_host` and `mcp_port` into `/etc/recued/config.toml` until
 *  2026-10-08 (`c80b0776d`), and a self-hosted server updates without its config
 *  being rewritten. A file or a `RECUED_BOOTSTRAP_*` variable that still sets one
 *  is accepted, ignored, and named at boot with what to use instead; refusing it
 *  would fail those servers' first boot after the update. (The command-line flags
 *  for them are refused instead: no installer ever passed one — see
 *  `RETIRED_FLAGS` in `backend/server/src/cli/parse.ts`.) */

/** Every live `[bootstrap]` key. The parser, the env scan and the config
 *  watcher's restart diff all read this one list. */
export const BOOTSTRAP_KEYS = ['bind_port', 'webhooks_enabled'] as const;

export type BootstrapKey = (typeof BOOTSTRAP_KEYS)[number];

const LIVE_KEYS: ReadonlySet<string> = new Set(BOOTSTRAP_KEYS);

export const isBootstrapKey = (key: string): key is BootstrapKey => LIVE_KEYS.has(key);

/** Each removed key → what does its job, as one clause for the boot warning. */
export const RETIRED_BOOTSTRAP_SETTINGS: ReadonlyMap<string, string> = new Map([
  [
    'data_path',
    'the server keeps its data in the folder that holds its database; choose that with --db <file> or DB_PATH',
  ],
  ['log_path', 'the server writes its log beside its database'],
  ['bind_host', 'set the LAN listen address with "network.lan_bind_address" under [runtime]'],
  [
    'mcp_port',
    'MCP is served at /mcp on the server\'s own port; switch it on or off in Settings → Server → Exposure',
  ],
]);

/** A removed or renamed setting that a config file, the environment or a flag
 *  still uses, for the boot warning. */
export interface RetiredSetting {
  /** Where it was set: `bootstrap.data_path` in a file, or the variable name. */
  name: string;
  /** What does its job now — `RETIRED_BOOTSTRAP_SETTINGS`' clause — or, for a
   *  renamed key, its new name and how the old value was read. */
  replacement: string;
}

export const retiredSetting = (name: string, key: string): RetiredSetting | null => {
  const replacement = RETIRED_BOOTSTRAP_SETTINGS.get(key);
  return replacement === undefined ? null : { name, replacement };
};

/** The old name of a renamed key, which still works (see the header). */
export const LEGACY_WEBHOOK_PORT_KEY = 'webhook_port';

/** A setting written under its old name, and how it was read. */
export const renamedWebhookPortNotice = (
  name: string,
  port: number,
  overridden: boolean,
): RetiredSetting => ({
  name,
  replacement: overridden
    ? 'renamed to webhooks_enabled, which is also set and wins; this value was ignored'
    : `renamed to webhooks_enabled (it never opened a port); read as webhooks_enabled = ${port > 0}`,
});
