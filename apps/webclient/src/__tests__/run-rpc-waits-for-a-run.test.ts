/** A recipe run is waited for as a run, not as a page read.
 *
 *  Every `execute` call took the rpc default of 30 s, while one AI step alone
 *  can take 20–40 s: the month-end drive (2026-09-24) saw runs reported as
 *  timed out that went on to finish on the server. Each `execute` call now
 *  passes `WEBCLIENT_RUN_RPC_TIMEOUT_MS`; this fails on one that does not, so a
 *  new run surface cannot bring the 30 s back. */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  WEBCLIENT_RPC_DEFAULT_TIMEOUT_MS,
  WEBCLIENT_RUN_RPC_TIMEOUT_MS,
} from '../realtime/rpc-conn.js';

const SRC = resolve(import.meta.dirname, '..');

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
  });

/** The text of each `('execute', …)` call: from the method name to the paren
 *  that closes the call. */
const executeCalls = (source: string): string[] => {
  const calls: string[] = [];
  for (const match of source.matchAll(/\(\s*'execute'\s*,/gu)) {
    let depth = 0;
    let end = match.index!;
    for (; end < source.length; end += 1) {
      if (source[end] === '(') depth += 1;
      else if (source[end] === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    calls.push(source.slice(match.index, end + 1));
  }
  return calls;
};

describe('a recipe run is waited for as a run', () => {
  it('⛔ every `execute` call passes the run wait, not the 30 s default', () => {
    const calls = sourceFiles(SRC).flatMap((file) =>
      executeCalls(readFileSync(file, 'utf8')).map((text) => ({ file: relative(SRC, file), text })));
    const short = calls.filter((call) => !call.text.includes('WEBCLIENT_RUN_RPC_TIMEOUT_MS'));
    expect(short.map((call) => `${call.file}: ${call.text.replace(/\s+/gu, ' ')}`)).toEqual([]);
    // 4 on 2026-09-25: a scan that found none would pass on nothing.
    expect(calls.length).toBeGreaterThanOrEqual(4);
  });

  it('the wait covers several AI steps, and is still bounded', () => {
    expect(WEBCLIENT_RUN_RPC_TIMEOUT_MS).toBeGreaterThanOrEqual(4 * WEBCLIENT_RPC_DEFAULT_TIMEOUT_MS);
    expect(WEBCLIENT_RUN_RPC_TIMEOUT_MS).toBeLessThanOrEqual(15 * 60_000);
  });
});
