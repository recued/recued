/** CLI argument parsing helpers.
 *
 *  Shared between the top-level argv parse in bin.ts (which decides
 *  which subcommand to dispatch) and per-subcommand slice parsing
 *  inside commands/*.ts. Kept as free functions over an explicit
 *  `args` array so the same helpers work on `process.argv.slice(2)`
 *  and on a positional slice handed to a subcommand.
 *
 *  Error convention: helpers that accept user-supplied values
 *  (`argNumeric`, future validators) log to stderr and `process.exit(1)`
 *  on bad input. This is fine in a Node CLI — callers match the
 *  existing shape of bin.ts.
 */

/** Flags that take a following value — must skip their value when
 *  scanning for positionals. Mirrors every valued flag accepted downstream:
 *  the backend's own `--db`, plus the bootstrap flags `parseCliOverrides`
 *  (@recued/config) understands. A valued flag missing here leaks its value
 *  into the positional list, where it is mis-read as a subcommand — e.g.
 *  `--bind-port 9000 start` would route to subcommand "9000". The `--flag=value`
 *  spelling needs no entry (the whole token starts with `--` and is skipped). */
export const FLAGS_WITH_VALUES = new Set([
  '--db',
  '--config',
  '--port',
  '--bind-port',
  '--bind-host',
  '--host',
  '--data-path',
  '--db-path',
  '--mcp-port',
  '--webhook-port',
  // ⛔⛔ D-228 — `recued mcp --token <bearer>`. WITHOUT THIS ENTRY THE FLAG DOES
  // NOT WORK AT ALL: `parsePositionals` skips any `--flag` it does not know but
  // NOT that flag's VALUE, so the bearer lands as `positionals[0]`, is read as
  // the subcommand, misses `KNOWN_SUBCOMMANDS`, and the router prints HELP
  // instead of starting the server.
  //
  // 🔑 That made slice 1's advertised recovery path a dead end — the stderr
  // notice says "pass --token <bearer>", and slice 6 made the token-less refusal
  // total, so a user following the instruction got the help screen and no
  // server. `cli-context/mcp.ts` reads the flag correctly; nothing upstream ever
  // let it through. Found by the first end-to-end boot that actually PRESENTED a
  // token — the unit tests all called the context directly and skipped the
  // router entirely.
  '--token',
  // D-178 — `recued report-boot-failure --exit-code <n> [--bin-dir <dir>]`.
  // Same trap as `--token` directly above: an unlisted value-flag leaves its
  // value sitting in `positionals[0]`, where it is read as the subcommand.
  '--exit-code',
  '--bin-dir',
  // D-178 — `recued update-lease claim --pid <pid> --operation <text>`. This
  // verb READS `positionals[1]` (claim/release), so an unlisted value-flag does
  // not merely land harmlessly further down the list the way `--reason` does on
  // `revert-release`: it lands ON the action and the verb refuses itself.
  '--pid',
  '--operation',
  // D-178 — `recued release-floor raise --sequence <n>`. Reads `positionals[1]`
  // like the lease verb, so an unlisted value-flag lands ON the action.
  '--sequence',
]);

export const getFlag = (args: string[], name: string): boolean =>
  args.includes(`--${name}`) || (name.length === 1 && args.includes(`-${name}`));

export const getArg = (args: string[], name: string): string | undefined => {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
};

/** Walk `args`, skipping `--flag`s and their values (per FLAGS_WITH_VALUES),
 *  returning bare positionals in order. `positionals[0]` is the
 *  subcommand name; `positionals[1..]` are subcommand-specific. */
export const parsePositionals = (args: string[]): string[] => {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (FLAGS_WITH_VALUES.has(args[i])) { i++; continue; }
    if (args[i].startsWith('--')) continue;
    out.push(args[i]);
  }
  return out;
};

/** Subcommand-scoped value read — same shape as `getArg` but named
 *  differently for call-site clarity inside per-subcommand code. */
export const argValue = (args: string[], flag: string): string | undefined => {
  const i = args.indexOf(`--${flag}`);
  if (i < 0 || i === args.length - 1) return undefined;
  return args[i + 1];
};

/** Subcommand-scoped flag read. */
export const argFlag = (args: string[], flag: string): boolean =>
  args.includes(`--${flag}`);

/** Parse an optional non-negative numeric flag. Returns undefined when
 *  absent; exits the process with an error message when present but
 *  unparseable, so callers don't have to re-raise. */
export const argNumeric = (args: string[], flag: string): number | undefined => {
  const raw = argValue(args, flag);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    console.error(`--${flag} must be a non-negative number (got '${raw}').`);
    process.exit(1);
  }
  return n;
};
