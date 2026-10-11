/** CLI-flag overrides. Narrow by design — only fields meaningful to a
 *  user running `recued-server` from the command line. Full edits go
 *  through the config file or `server.setConfigField` rpc.
 *
 *  `--data-path` / `--db-path`, `--host` / `--bind-host` and `--mcp-port` were
 *  removed with their keys on 2026-10-09 (`bootstrap-keys.ts`). They are not
 *  parsed here: the server's router refuses them before any config loads
 *  (`RETIRED_FLAGS`, `backend/server/src/cli/parse.ts`). */

import { renamedWebhookPortNotice, type RetiredSetting } from './bootstrap-keys.js';
import { ConfigValidationError } from './parse.js';
import type { BootstrapConfig } from './types.js';

export interface CliOverrides {
  configPath?: string;
  bootstrap: Partial<BootstrapConfig>;
  /** `--webhook-port`, the old name of the webhook switch, when it was used. */
  renamed: RetiredSetting[];
}

/** Pluck the known flags out of argv. Unknown flags are left alone so
 *  subcommand parsers downstream can own them. */
export const parseCliOverrides = (argv: readonly string[]): CliOverrides => {
  const bootstrap: Partial<BootstrapConfig> = {};
  let configPath: string | undefined;
  let legacyWebhookPort: number | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === '--config') {
      if (!next) throw new ConfigValidationError('--config expects a path', '--config');
      configPath = next;
      i++;
      continue;
    }
    if (arg.startsWith('--config=')) {
      configPath = arg.slice('--config='.length);
      continue;
    }

    if (arg === '--bind-port' || arg === '--port') {
      if (!next) throw new ConfigValidationError(`${arg} expects a number`, 'bind_port');
      bootstrap.bind_port = parsePort(arg, next);
      i++;
      continue;
    }
    if (arg.startsWith('--bind-port=') || arg.startsWith('--port=')) {
      const val = arg.split('=', 2)[1];
      bootstrap.bind_port = parsePort(arg, val);
      continue;
    }

    // The old name of `webhooks_enabled` (renamed 2026-10-10). It still works:
    // non-zero is on. There is no flag for the new name; set it in the config
    // file or as RECUED_BOOTSTRAP_WEBHOOKS_ENABLED.
    if (arg === '--webhook-port') {
      if (!next) throw new ConfigValidationError('--webhook-port expects a number', 'webhook_port');
      legacyWebhookPort = parsePort(arg, next);
      i++;
      continue;
    }
    if (arg.startsWith('--webhook-port=')) {
      legacyWebhookPort = parsePort(arg, arg.split('=', 2)[1]);
      continue;
    }
  }

  const renamed: RetiredSetting[] = [];
  if (legacyWebhookPort !== undefined) {
    bootstrap.webhooks_enabled = legacyWebhookPort > 0;
    renamed.push(renamedWebhookPortNotice('--webhook-port', legacyWebhookPort, false));
  }
  return { configPath, bootstrap, renamed };
};

const parsePort = (flag: string, raw: string): number => {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    throw new ConfigValidationError(
      `${flag} must be an integer in [0, 65535] (got ${JSON.stringify(raw)})`,
      'port',
    );
  }
  return n;
};
