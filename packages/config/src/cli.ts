/** CLI-flag overrides. Narrow by design — only fields meaningful to a
 *  user running `recued-server` from the command line. Full edits go
 *  through the config file or `server.setConfigField` rpc. */

import { ConfigValidationError } from './parse.js';
import type { BootstrapConfig } from './types.js';

export interface CliOverrides {
  configPath?: string;
  bootstrap: Partial<BootstrapConfig>;
}

/** Pluck the known flags out of argv. Unknown flags are left alone so
 *  subcommand parsers downstream can own them. */
export const parseCliOverrides = (argv: readonly string[]): CliOverrides => {
  const bootstrap: Partial<BootstrapConfig> = {};
  let configPath: string | undefined;

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

    if (arg === '--bind-host' || arg === '--host') {
      if (!next) throw new ConfigValidationError(`${arg} expects a host`, 'bind_host');
      bootstrap.bind_host = next;
      i++;
      continue;
    }
    if (arg.startsWith('--bind-host=') || arg.startsWith('--host=')) {
      bootstrap.bind_host = arg.split('=', 2)[1];
      continue;
    }

    if (arg === '--data-path' || arg === '--db-path') {
      if (!next) throw new ConfigValidationError(`${arg} expects a path`, 'data_path');
      bootstrap.data_path = next;
      i++;
      continue;
    }
    if (arg.startsWith('--data-path=') || arg.startsWith('--db-path=')) {
      bootstrap.data_path = arg.split('=', 2)[1];
      continue;
    }

    if (arg === '--mcp-port') {
      if (!next) throw new ConfigValidationError('--mcp-port expects a number', 'mcp_port');
      bootstrap.mcp_port = parsePort(arg, next);
      i++;
      continue;
    }
    if (arg.startsWith('--mcp-port=')) {
      bootstrap.mcp_port = parsePort(arg, arg.split('=', 2)[1]);
      continue;
    }

    if (arg === '--webhook-port') {
      if (!next) throw new ConfigValidationError('--webhook-port expects a number', 'webhook_port');
      bootstrap.webhook_port = parsePort(arg, next);
      i++;
      continue;
    }
    if (arg.startsWith('--webhook-port=')) {
      bootstrap.webhook_port = parsePort(arg, arg.split('=', 2)[1]);
      continue;
    }
  }

  return { configPath, bootstrap };
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
