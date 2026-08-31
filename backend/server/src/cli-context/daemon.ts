import { hostname } from 'node:os';
import { getArg, getFlag, parsePositionals } from '../cli/parse.js';
import { resolveBindPort } from '../cli/resolve-bind-port.js';
import type { BootTrace } from '../cli/boot-trace.js';
import { resolveRealmDbPath } from '../realm-db-path.js';

export interface DaemonProfileOptions {
  args: string[];
  bootTrace?: BootTrace;
  env?: NodeJS.ProcessEnv;
}

const buildDaemonExtraArgs = (args: string[]): string[] => {
  const extraArgs: string[] = [];
  if (getFlag(args, 'reset-exposure')) extraArgs.push('--reset-exposure');
  // ⛔ `start` DAEMONIZES INTO `serve`, so a flag the child needs must be
  // forwarded HERE or it is silently dropped. The Windows Startup shortcut runs
  // `start --require-enrolled` (there is no supervisor on Windows, so it cannot
  // use `serve` the way the systemd/launchd units do); without this line the
  // guard would vanish on exactly the platform whose shortcut fires at every
  // login, and an unconfigured server would serve anyway.
  if (getFlag(args, 'require-enrolled')) extraArgs.push('--require-enrolled');
  return extraArgs;
};

export async function runDaemonProfile(options: DaemonProfileOptions): Promise<void> {
  const env = options.env ?? process.env;
  const positionals = parsePositionals(options.args);
  const subcommand = positionals[0];
  const dbPath = resolveRealmDbPath(getArg(options.args, 'db') ?? env.DB_PATH);
  const serverDisplayName = env.RECUED_SERVER_NAME ?? hostname() ?? 'recued';

  // Resolve the bind port lazily + once. Recovery commands (stop, logs) must
  // work even when config.toml / $PORT is malformed, so they never call this —
  // resolveBindPort can throw on bad config. Probe/spawn commands do, and
  // resolving before any side-effect (e.g. restart) means a bad config fails
  // before we stop a healthy daemon.
  let cachedPort: number | undefined;
  const resolvePort = (): number =>
    (cachedPort ??= resolveBindPort({ args: options.args, env }));
  const daemonOpts = () => ({
    dbPath,
    port: resolvePort(),
    extraArgs: buildDaemonExtraArgs(options.args),
  });

  options.bootTrace?.mark('dispatch-subcommand', subcommand ?? 'daemon');

  switch (subcommand) {
    case 'start': {
      options.bootTrace?.markImport('../daemon.js');
      const { daemonStart } = await import('../daemon.js');
      await daemonStart(daemonOpts());
      return;
    }
    case 'stop': {
      options.bootTrace?.markImport('../daemon.js');
      const { daemonStop } = await import('../daemon.js');
      // Recovery command — pidfile-driven, no port resolution.
      await daemonStop({ dbPath });
      return;
    }
    case 'status': {
      options.bootTrace?.markImport('../daemon.js');
      const { daemonStatus } = await import('../daemon.js');
      await daemonStatus(daemonOpts());
      options.bootTrace?.markImport('../cli/url-enumerate.js');
      const { enumerateServerUrls, formatUrlList } = await import('../cli/url-enumerate.js');
      const urls = await enumerateServerUrls({
        configuredHostname: serverDisplayName,
        port: resolvePort(),
      });
      console.log('');
      console.log('Reachable at:');
      console.log(formatUrlList(urls));
      return;
    }
    case 'restart': {
      options.bootTrace?.markImport('../daemon.js');
      const { daemonRestart } = await import('../daemon.js');
      await daemonRestart(daemonOpts());
      return;
    }
    case 'logs': {
      options.bootTrace?.markImport('../commands/logs.js');
      const { cmdLogs } = await import('../commands/logs.js');
      await cmdLogs({ dbPath, follow: getFlag(options.args, 'follow') || getFlag(options.args, 'f') });
      return;
    }
    case 'auth-status': {
      options.bootTrace?.markImport('../commands/auth.js');
      const { cmdAuthStatus } = await import('../commands/auth.js');
      await cmdAuthStatus({ dbPath, port: resolvePort() });
      return;
    }
    case 'unlock': {
      options.bootTrace?.markImport('../commands/auth.js');
      const { cmdUnlock } = await import('../commands/auth.js');
      await cmdUnlock({ dbPath, port: resolvePort(), useRecoveryKey: getFlag(options.args, 'recovery-key') });
      return;
    }
    case 'lock': {
      options.bootTrace?.markImport('../commands/auth.js');
      const { cmdLock } = await import('../commands/auth.js');
      await cmdLock({ dbPath, port: resolvePort() });
      return;
    }
    default:
      console.error(`Unknown daemon command '${subcommand ?? ''}'. Try --help.`);
      process.exitCode = 1;
  }
}
