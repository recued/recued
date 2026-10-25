/**
 * D-315 — running a template's owner-written pattern safely (§4.2, §9).
 *
 * A template's patterns run on the server over every email its conditions
 * match. A pattern that backtracks catastrophically (`^(a+)+$`) would stall
 * ingest, so patterns with regex syntax run inside a `vm` context with a
 * timeout, which V8 honours even mid-backtrack (measured 2026-09-26: a
 * catastrophic pattern was cut off at ~52 ms). Literal text cannot backtrack
 * and runs directly on the same capped input.
 *
 * Validation (`validateMailTemplateDefinition`) already refused patterns that do
 * not compile, carry flags other than i/m/s/u, or run long; this is the runtime
 * backstop. A timeout THROWS `TemplatePatternTimeout`, so the rules pass can
 * record why a value was not read instead of reporting a plain miss.
 *
 * ⛔ The VM deadline is wall time, so it also counts time the process is not
 * scheduled. Under load `Parcel \d+` was stopped at 50 ms (the full sweep,
 * 2026-10-24), and a repeated block whose split is stopped loses every fact in
 * its email while the backfill says "done". A pattern stopped once runs again
 * with a longer budget: one that backtracks catastrophically spends that budget
 * too and is still stopped; one that was only waiting for the CPU finishes.
 *
 * A pattern runs over canonical text (§9), as its characters are read
 * (`canonicalMailFactPattern`), and is checked as it runs.
 */

import { createContext, Script } from 'node:vm';

import { canonicalMailFactPattern } from '@recued/contracts';

export const TEMPLATE_PATTERN_TIMEOUT_MS = 50;
/** The second run's budget, after the first was stopped. */
export const TEMPLATE_PATTERN_RETRY_TIMEOUT_MS = 250;
/** Characters of source text a pattern is run over. */
export const TEMPLATE_PATTERN_MAX_INPUT = 200_000;
const COMPILED_CACHE_LIMIT = 500;

export class TemplatePatternTimeout extends Error {
  constructor(readonly pattern: string) {
    super(`the pattern took longer than ${TEMPLATE_PATTERN_RETRY_TIMEOUT_MS} ms and was stopped`);
    this.name = 'TemplatePatternTimeout';
  }
}

const context = createContext({ __re: undefined as RegExp | undefined, __text: '' });
const execScript = new Script('__re.exec(__text)');
type CompiledPattern = { readonly re: RegExp; readonly literal: boolean };
const compiled = new Map<string, CompiledPattern | null>();

const compile = (pattern: string, flags: string): CompiledPattern | null => {
  const key = `${flags}/${pattern}`;
  const cached = compiled.get(key);
  if (cached !== undefined) return cached;
  let result: CompiledPattern | null;
  try {
    // Only i / m / s / u: a `g` or `y` flag would make `exec` stateful.
    const source = canonicalMailFactPattern(pattern);
    result = {
      re: new RegExp(source, flags.replace(/[^imsu]/g, '')),
      // Classify what runs: canonicalization may introduce escapes or groups.
      literal: !/[.*+?^${}()|[\]\\]/u.test(source),
    };
  } catch {
    result = null;
  }
  if (compiled.size >= COMPILED_CACHE_LIMIT) compiled.delete(compiled.keys().next().value!);
  compiled.set(key, result);
  return result;
};

/** The first match of `pattern` in `text`, or `null`. A pattern that does not
 *  compile matches nothing; one that runs too long throws. */
export const runTemplatePattern = (
  pattern: string,
  flags: string,
  text: string,
): RegExpExecArray | null => {
  const expression = compile(pattern, flags);
  if (expression === null) return null;
  const { re, literal } = expression;
  const input = text.length > TEMPLATE_PATTERN_MAX_INPUT ? text.slice(0, TEMPLATE_PATTERN_MAX_INPUT) : text;
  // The VM deadline includes time the process is descheduled: even `--` could
  // time out and discard a repeated email's facts under load. Plain text has
  // no regex operators or escapes and needs no backtracking watchdog.
  if (literal) return re.exec(input);
  context.__re = re;
  context.__text = input;
  const stopped = (error: unknown): boolean => (error as { code?: string }).code === 'ERR_SCRIPT_EXECUTION_TIMEOUT';
  try {
    try {
      return execScript.runInContext(context, { timeout: TEMPLATE_PATTERN_TIMEOUT_MS }) as RegExpExecArray | null;
    } catch (error) {
      if (!stopped(error)) throw error;
    }
    try {
      return execScript.runInContext(context, { timeout: TEMPLATE_PATTERN_RETRY_TIMEOUT_MS }) as RegExpExecArray | null;
    } catch (error) {
      if (stopped(error)) throw new TemplatePatternTimeout(pattern);
      throw error;
    }
  } finally {
    context.__re = undefined;
    context.__text = '';
  }
};
