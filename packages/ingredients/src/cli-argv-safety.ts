/** cli `argv_template` SAFETY — the single source of truth shared by the
 *  catalog validator (`validateIngredient`, the universal install/parse gate)
 *  AND the D-170 authoring composition rules, so the "locked binary + typed-data
 *  args" invariant can never drift between the two layers.
 *
 *  WHY a shared module (the gap this closes): the authoring layer already
 *  treats a templated command / interpreter code-hole as a HARD ERROR, but a
 *  directly-published or hand-crafted catalog ingredient bypasses the authoring
 *  table and is gated by `validateIngredient` ALONE — which historically only
 *  checked that `argv_template` was a non-empty string array. The D-182 §7.2
 *  reachability gate authorizes a cli op by (ingredient × operation), NOT by
 *  tool, so there is no binary allowlist: `argv[0]` is the ONLY thing that
 *  decides which binary runs. Two invariants:
 *
 *   1. `argv[0]` is the COMMAND — a non-templated literal pinned to the declared
 *      launched binary (`runtime.entry_point`). Otherwise a call-time `{hole}`
 *      chooses the binary and a narrow "run tool X" grant silently authorizes
 *      running ANY binary on PATH.
 *   2. no interpreter eval/code hole — `python -c {code}` / `bash -c {x}` /
 *      `node -e {code}` etc. turn call-time data into CODE; lock the script path
 *      and pass typed data args instead.
 *
 *  Each consumer maps the neutral violation descriptors below to its own issue
 *  code (`CATALOG_BINDING_INVALID` / `composition_cli_code_hole` + the new
 *  `composition_cli_command_hole`) and path convention. */

/** Interpreters whose listed flags execute an INLINE program string (code/eval
 *  holes). A bare `-` reads the program from stdin — equally a code channel. */
export const CLI_CODE_EVAL_FLAGS_BY_INTERPRETER: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['bash', new Set(['-c'])],
  ['sh', new Set(['-c'])],
  ['zsh', new Set(['-c'])],
  ['python', new Set(['-c', '-'])],
  ['python3', new Set(['-c', '-'])],
  ['node', new Set(['-e', '-'])],
  ['deno', new Set(['-e', '-'])],
  ['perl', new Set(['-e', '-'])],
  ['php', new Set(['-r'])],
  ['ruby', new Set(['-e', '-E', '-'])],
  ['awk', new Set()],
]);

/** Interpreters whose listed flags take a SCRIPT/MODULE path as their value —
 *  the path must be locked, never a call-time hole. */
export const CLI_CODE_ARG_FLAGS_BY_INTERPRETER: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['awk', new Set(['-f', '--file'])],
  ['node', new Set(['--require', '-r', '--import', '--loader', '--experimental-loader'])],
  ['python', new Set(['-m'])],
  ['python3', new Set(['-m'])],
  ['ruby', new Set(['-r'])],
]);

/** A subset of the code-arg flags whose value is a MODULE/script reference that,
 *  once seen with a locked value, ends the per-interpreter scan (the program is
 *  determined). */
export const CLI_SCRIPT_LOCKING_ARG_FLAGS_BY_INTERPRETER: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['awk', new Set(['-f', '--file'])],
  ['python', new Set(['-m'])],
  ['python3', new Set(['-m'])],
]);

/** A whole-token template hole: `{arg}` (the cli executor's single-brace
 *  substitution) or `{{ref}}` (a recipe-layer ref). */
export const CLI_HOLE_TOKEN_RE = /^(?:\{\{[^{}]+\}\}|\{[^{}]+\})$/;

export type CliArgvTemplateEntryLike = string | { expand_arg?: unknown };

export const isCliArgvStringToken = (entry: CliArgvTemplateEntryLike): entry is string =>
  typeof entry === 'string';

export const cliArgvStringTokens = (
  argv: readonly CliArgvTemplateEntryLike[],
): string[] =>
  argv.filter(isCliArgvStringToken);

export const isCliHoleToken = (token: string): boolean => CLI_HOLE_TOKEN_RE.test(token);

export const isCliFlagToken = (token: string): boolean =>
  token.startsWith('-') && token !== '-' && !isCliHoleToken(token);

export const cliFlagName = (token: string): string => {
  const assignmentIdx = token.indexOf('=');
  return assignmentIdx >= 0 ? token.slice(0, assignmentIdx) : token;
};

export const cliFlagInlineValue = (token: string): string | null => {
  const assignmentIdx = token.indexOf('=');
  return assignmentIdx >= 0 ? token.slice(assignmentIdx + 1) : null;
};

/** The interpreter name a token invokes (its basename, lowercased), or `null`
 *  when the token is not a recognized interpreter. */
export const cliInterpreterName = (token: string): string | null => {
  const base = token.split('/').filter(Boolean).pop() ?? token;
  const normalized = base.toLowerCase();
  return CLI_CODE_EVAL_FLAGS_BY_INTERPRETER.has(normalized) ? normalized : null;
};

/** A real binary name/path never contains a brace; ANY brace (full `{arg}`,
 *  partial `pre{arg}`, or `{{ref}}`) means the command token is templated. */
export const tokenContainsTemplateHole = (token: string): boolean => /[{}]/.test(token);

/** Invariant 1 — the command token (`argv[0]`). */
export type CliCommandViolation =
  | { kind: 'command_templated' }
  | { kind: 'command_tool_mismatch'; tool: string };

/** Validate `argv[0]` against the declared launched binary. Returns `null` when
 *  the command is a clean literal pinned to `declaredTool` (or when there is no
 *  declared tool to pin to — the caller enforces entry_point presence
 *  separately, e.g. the catalog `runtime.entry_point` required check). An empty
 *  argv is the caller's separate concern (a non-empty check precedes this). */
export const cliCommandViolation = (
  argv: readonly CliArgvTemplateEntryLike[],
  declaredTool: string | undefined,
): CliCommandViolation | null => {
  const cmd = argv[0];
  if (cmd === undefined) return null;
  if (typeof cmd !== 'string' || cmd.length === 0) return { kind: 'command_templated' };
  if (tokenContainsTemplateHole(cmd)) return { kind: 'command_templated' };
  if (declaredTool !== undefined && declaredTool.length > 0 && cmd !== declaredTool) {
    return { kind: 'command_tool_mismatch', tool: declaredTool };
  }
  return null;
};

/** Invariant 2 — an interpreter code/eval or script-path hole. */
export type CliInterpreterViolation =
  | { kind: 'code_eval'; index: number; interpreter: string; flag: string }
  | { kind: 'script_hole'; index: number; interpreter: string };

/** Scan the tokens AFTER an interpreter occurrence for the first code/eval hole
 *  or unlocked script-path hole. Emits AT MOST ONE violation per interpreter
 *  occurrence (the first determines the program), preserving the authoring
 *  layer's historical behaviour exactly. */
const collectInterpreterViolation = (
  argv: readonly CliArgvTemplateEntryLike[],
  interpreter: string,
  interpreterIdx: number,
  out: CliInterpreterViolation[],
): void => {
  const evalFlags = CLI_CODE_EVAL_FLAGS_BY_INTERPRETER.get(interpreter);
  const codeArgFlags = CLI_CODE_ARG_FLAGS_BY_INTERPRETER.get(interpreter);
  const scriptLockingArgFlags = CLI_SCRIPT_LOCKING_ARG_FLAGS_BY_INTERPRETER.get(interpreter);

  for (let idx = interpreterIdx + 1; idx < argv.length; idx += 1) {
    const token = argv[idx];
    // A typed expansion is data. If an interpreter would consume it as the
    // program/script path, reject it the same way we reject a `{hole}` there.
    // If it appears after a locked script path, the scan has already returned.
    if (typeof token !== 'string') {
      out.push({ kind: 'script_hole', index: idx, interpreter });
      return;
    }
    const flagName = cliFlagName(token);
    const inlineValue = cliFlagInlineValue(token);

    if (evalFlags?.has(token)) {
      out.push({ kind: 'code_eval', index: idx, interpreter, flag: token });
      return;
    }

    if (codeArgFlags?.has(flagName)) {
      if (inlineValue !== null) {
        if (isCliHoleToken(inlineValue)) {
          out.push({ kind: 'script_hole', index: idx, interpreter });
          return;
        }
        if (scriptLockingArgFlags?.has(flagName)) return;
        continue;
      }

      const argIdx = idx + 1;
      const argToken = argv[argIdx];
      if (argToken === undefined) return;
      if (typeof argToken !== 'string') {
        out.push({ kind: 'script_hole', index: argIdx, interpreter });
        return;
      }
      if (isCliHoleToken(argToken)) {
        out.push({ kind: 'script_hole', index: argIdx, interpreter });
        return;
      }
      if (scriptLockingArgFlags?.has(flagName)) return;
      idx = argIdx;
      continue;
    }

    if (isCliFlagToken(token)) continue;

    if (isCliHoleToken(token)) {
      out.push({ kind: 'script_hole', index: idx, interpreter });
    }
    return;
  }
};

/** All interpreter code/eval/script-path-hole violations in an argv template
 *  (one scan per interpreter occurrence). A non-interpreter command (`docker`,
 *  `docling`, `ffmpeg`, …) yields none. */
export const cliInterpreterViolations = (
  argv: readonly CliArgvTemplateEntryLike[],
): CliInterpreterViolation[] => {
  const out: CliInterpreterViolation[] = [];
  argv.forEach((token, idx) => {
    if (typeof token !== 'string') return;
    const interpreter = cliInterpreterName(token);
    if (interpreter === null) return;
    collectInterpreterViolation(argv, interpreter, idx, out);
  });
  return out;
};
