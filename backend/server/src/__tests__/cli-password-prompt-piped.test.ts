/** The CLI prompts read a PIPED line — the way a script supplies a secret.
 *
 *  ⛔ WHY THIS EXISTS. Both prompts closed their readline before resolving,
 *  and `close()` emits 'close' synchronously into a listener that resolves
 *  '' — so every piped secret read as empty. Found 2026-10-07 when a scripted
 *  `recued unlock` said "No recovery key entered" with the key on stdin; the
 *  same prompt feeds `recover-keyfile` and `rotate-passphrase`. A terminal
 *  takes a different branch, which is why nobody typing noticed.
 *
 *  `process.stdin` is the module's own global, so each case runs in a child
 *  process with real piped stdin. */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';

const promptModuleUrl = new URL('../cli/password-prompt.ts', import.meta.url).href;

/** Run one prompt in a child with `input` piped to its stdin; what it read. */
const readPiped = (prompt: 'promptSecret' | 'promptLine', input: string): string => {
  const body = `
    const m = await import(${JSON.stringify(promptModuleUrl)});
    const value = await m.${prompt}('label: ');
    process.stdout.write(JSON.stringify(value));
  `;
  const run = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '--eval', body],
    { cwd: process.cwd(), input, encoding: 'utf8', timeout: 15_000 },
  );
  expect(run.status, run.stderr).toBe(0);
  return JSON.parse(run.stdout) as string;
};

describe('CLI prompts — piped input', () => {
  for (const prompt of ['promptSecret', 'promptLine'] as const) {
    it(`${prompt} reads the piped line`, () => {
      expect(readPiped(prompt, 'abandon abandon art\n')).toBe('abandon abandon art');
    });

    it(`${prompt} reads a last line with no newline`, () => {
      expect(readPiped(prompt, 'abandon art')).toBe('abandon art');
    });

    it(`${prompt} answers '' for empty input`, () => {
      expect(readPiped(prompt, '')).toBe('');
    });
  }
});
