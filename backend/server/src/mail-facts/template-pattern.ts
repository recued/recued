/**
 * D-315 — running a template's owner-written pattern safely (§4.2, §9).
 *
 * A template's patterns run on the server over every email its conditions
 * match. A pattern that backtracks catastrophically (`^(a+)+$`) would stall
 * ingest, so every match runs inside a `vm` context with a timeout, which V8
 * honours even mid-backtrack (measured 2026-09-26: a catastrophic pattern was
 * cut off at ~52 ms; a normal match costs ~67 µs this way). The input is
 * capped too.
 *
 * Validation (`validateMailTemplateDefinition`) already refused patterns that do
 * not compile, carry flags other than i/m/s/u, or run long; this is the runtime
 * backstop. A timeout THROWS `TemplatePatternTimeout`, so the rules pass can
 * record why a value was not read instead of reporting a plain miss.
 *
 * A pattern runs over canonical text (§9), as its characters are read
 * (`canonicalMailFactPattern`), and is checked as it runs.
 */

import { createContext, Script } from 'node:vm';

import { canonicalMailFactPattern } from '@recued/contracts';

export const TEMPLATE_PATTERN_TIMEOUT_MS = 50;
/** Characters of source text a pattern is run over. */
export const TEMPLATE_PATTERN_MAX_INPUT = 200_000;
const COMPILED_CACHE_LIMIT = 500;

export class TemplatePatternTimeout extends Error {
  constructor(readonly pattern: string) {
    super(`the pattern took longer than ${TEMPLATE_PATTERN_TIMEOUT_MS} ms and was stopped`);
    this.name = 'TemplatePatternTimeout';
  }
}

const context = createContext({ __re: undefined as RegExp | undefined, __text: '' });
const execScript = new Script('__re.exec(__text)');
const compiled = new Map<string, RegExp | null>();

const compile = (pattern: string, flags: string): RegExp | null => {
  const key = `${flags}/${pattern}`;
  const cached = compiled.get(key);
  if (cached !== undefined) return cached;
  let re: RegExp | null;
  try {
    // Only i / m / s / u: a `g` or `y` flag would make `exec` stateful.
    re = new RegExp(canonicalMailFactPattern(pattern), flags.replace(/[^imsu]/g, ''));
  } catch {
    re = null;
  }
  if (compiled.size >= COMPILED_CACHE_LIMIT) compiled.delete(compiled.keys().next().value!);
  compiled.set(key, re);
  return re;
};

/** The first match of `pattern` in `text`, or `null`. A pattern that does not
 *  compile matches nothing; one that runs too long throws. */
export const runTemplatePattern = (
  pattern: string,
  flags: string,
  text: string,
): RegExpExecArray | null => {
  const re = compile(pattern, flags);
  if (re === null) return null;
  const input = text.length > TEMPLATE_PATTERN_MAX_INPUT ? text.slice(0, TEMPLATE_PATTERN_MAX_INPUT) : text;
  context.__re = re;
  context.__text = input;
  try {
    return execScript.runInContext(context, { timeout: TEMPLATE_PATTERN_TIMEOUT_MS }) as RegExpExecArray | null;
  } catch (error) {
    if ((error as { code?: string }).code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
      throw new TemplatePatternTimeout(pattern);
    }
    throw error;
  } finally {
    context.__re = undefined;
    context.__text = '';
  }
};
