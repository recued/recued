/** Effective bind-port resolution.
 *
 *  Shared by the three places that need to know which TCP port the server
 *  binds: the serve path (`compose-base-context`), the daemon wrapper
 *  (`start` / `stop` / `status` / `restart` / auth subcommands), and the
 *  pair URL enumerator. Centralised so they cannot drift — if `serve` binds
 *  one port while `status` probes another, the daemon CLI silently breaks.
 *
 *  Precedence (highest first):
 *    1. CLI `--port` / `--bind-port` — every `=`/space spelling, via the
 *       loader's own flag parser (`getArg` alone misses the `--port=` and
 *       long `--bind-port` forms).
 *    2. Generic `$PORT` env — the 12-factor alias documented in the server
 *       README, kept just below an explicit flag.
 *    3. Loader-resolved `bootstrap.bind_port` — i.e. config.toml `bind_port`,
 *       then `RECUED_BOOTSTRAP_BIND_PORT`, then the distribution preset
 *       default (7717), in the loader's own precedence order.
 *
 *  Before this existed each site read `getArg('port') ?? $PORT ?? '7717'`,
 *  which never consulted the loaded config: a launch without `--port` always
 *  bound 7717 regardless of the configured `bind_port`. The literal `7717`
 *  now lives only in the presets — the single source of truth. */

import {
  ConfigValidationError,
  loadConfig,
  parseCliOverrides,
  type Distribution,
  type LoadResult,
} from '@recued/config';

import { getArg } from './parse.js';

export interface ResolveBindPortOptions {
  /** Raw argv slice (same array the rest of the CLI parses). */
  args: string[];
  /** Env source — defaults to `process.env`; injectable for tests. */
  env?: Record<string, string | undefined>;
  /** An already-loaded config to reuse. `compose-base-context` loads it to
   *  build the runtime store, so it passes it through to avoid a second
   *  read. Omit and the resolver loads it itself — a cheap fs read + parse
   *  with no side effects. */
  loaded?: LoadResult;
}

/** Resolve the effective bind port. See the module header for precedence. */
export const resolveBindPort = (opts: ResolveBindPortOptions): number => {
  const env = opts.env ?? process.env;

  // 1. Explicit CLI flag outranks everything, including $PORT. Parsing via
  //    the loader covers --port, --port=, --bind-port, and --bind-port=
  //    uniformly (getArg only matches the spaced `--port <n>` form).
  const cliPort = parseCliOverrides(opts.args).bootstrap.bind_port;
  if (cliPort !== undefined) return cliPort;

  // 2. Generic $PORT. Trim first: a blank/whitespace value is treated as
  //    absent and falls through to config (without trimming, `Number(' ')`
  //    is 0 — an unintended ephemeral-port bind). A non-blank but invalid
  //    value fails loud rather than silently dropping the operator's intent.
  const rawPortEnv = env.PORT?.trim();
  if (rawPortEnv) {
    const n = Number(rawPortEnv);
    if (!Number.isInteger(n) || n < 0 || n > 65_535) {
      throw new ConfigValidationError(
        `PORT must be an integer in [0, 65535] (got ${JSON.stringify(env.PORT)})`,
        'bind_port',
      );
    }
    return n;
  }

  // 3. config.toml bind_port / RECUED_BOOTSTRAP_BIND_PORT / preset default.
  const loaded =
    opts.loaded ??
    loadConfig({
      distribution:
        (env.RECUED_DISTRIBUTION as Distribution | undefined) ?? 'source',
      configPath: getArg(opts.args, 'config'),
      argv: opts.args,
      env,
    });
  return loaded.bootstrap.bind_port;
};
