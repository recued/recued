/** Every refusal a server handler throws reaches a recipe step with a name (D-313).
 *
 *  A handler behind a kernel op refuses with an `RpcError(code, message,
 *  status?)`. The step runner keeps a code the recipe vocabulary has, then asks
 *  `recipeCodeForRpcRefusal` (the table, then the status), and anything left is
 *  `NETWORK_ERROR`, "check your connection". On 2026-09-25 a live drive found a
 *  mistyped cron logged that way; a scan then found 144 codes, 122 of them
 *  unnamed.
 *
 *  This reads every `RpcError(` call under `src/`, calls spread over several
 *  lines included (a scan of single lines found a third of them), and fails on
 *  a call whose code would still be a network error, naming the file and line.
 *  Fix it by giving the call a status, adding the code to
 *  `RPC_REFUSAL_RECIPE_CODES`, or, for a code that really is not a step's
 *  refusal, to `RPC_CODES_LEFT_UNNAMED` with why.
 *
 *  ⚠ A code passed as a variable, or a status computed at the call, cannot be
 *  read here: such a call is judged by its code alone. */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ERR, RPC_CODES_LEFT_UNNAMED, recipeCodeForRpcRefusal } from '@recued/contracts';

const SRC = join(__dirname, '..');

const sourceFiles = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  if (statSync(path).isDirectory()) {
    // The CLI's rpc client has its own RpcError for its own transport, and tests throw what they like.
    return name === '__tests__' || name === 'cli' ? [] : sourceFiles(path);
  }
  return name.endsWith('.ts') && !name.endsWith('.d.ts') ? [path] : [];
});

/** The top-level arguments of the call whose `(` ends at `start`. */
const argumentsAt = (text: string, start: number): string[] => {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = '';
  for (let i = start; i < text.length; i += 1) {
    const c = text[i]!;
    if (quote !== null) {
      current += c;
      if (c === '\\') { current += text[i + 1] ?? ''; i += 1; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '\'' || c === '"' || c === '`') { quote = c; current += c; continue; }
    if (c === '(' || c === '[' || c === '{') { depth += 1; current += c; continue; }
    if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) { out.push(current.trim()); return out; }
      depth -= 1; current += c; continue;
    }
    if (c === ',' && depth === 0) { out.push(current.trim()); current = ''; continue; }
    current += c;
  }
  return out;
};

interface Throw { readonly file: string; readonly line: number; readonly code: string; readonly status?: number }

const throws: Throw[] = sourceFiles(SRC).flatMap((file) => {
  const text = readFileSync(file, 'utf8');
  const found: Throw[] = [];
  for (const match of text.matchAll(/RpcError\(/gu)) {
    const args = argumentsAt(text, match.index! + match[0].length);
    const code = /^'([a-z][a-z0-9_]*)'$/u.exec(args[0] ?? '')?.[1];
    if (code === undefined) continue;
    const status = /^\d{3}$/u.test(args[2] ?? '') ? Number(args[2]) : undefined;
    found.push({
      file: relative(SRC, file),
      line: text.slice(0, match.index).split('\n').length,
      code,
      ...(status !== undefined ? { status } : {}),
    });
  }
  return found;
});

describe('every refusal a server handler throws has a name at the step', () => {
  it('⛔ no RpcError call would still reach a step as NETWORK_ERROR', () => {
    const unnamed = throws
      .filter((t) => !Object.hasOwn(ERR, t.code))
      .filter((t) => !Object.hasOwn(RPC_CODES_LEFT_UNNAMED, t.code))
      .filter((t) => recipeCodeForRpcRefusal(t.code, t.status) === undefined)
      .map((t) => `${t.file}:${String(t.line)} ${t.code}${t.status !== undefined ? ` ${String(t.status)}` : ''}`);
    expect(unnamed).toEqual([]);
  });

  it('the scan reads calls written across lines, so it sees them all', () => {
    // 144 codes in 1,550 calls on 2026-09-25. A scan that found few would pass on nothing.
    expect(new Set(throws.map((t) => t.code)).size).toBeGreaterThanOrEqual(140);
    expect(throws.length).toBeGreaterThanOrEqual(1500);
    // `new RpcError(\n  'pack_not_installed', …, 400)` is one of those calls.
    expect(throws.some((t) => t.code === 'pack_not_installed' && t.file === 'schedule-handler.ts')).toBe(true);
  });

  it('a code left unnamed on purpose is one a handler still throws', () => {
    const thrown = new Set(throws.map((t) => t.code));
    expect(Object.keys(RPC_CODES_LEFT_UNNAMED).filter((code) => !thrown.has(code))).toEqual([]);
  });
});
