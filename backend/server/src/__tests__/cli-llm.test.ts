/** CLI LLM subcommand tests.
 *
 *  The `llm *` subcommands run in-process on the local DB (no daemon
 *  required) — they exercise the LLMConfigManager directly. These tests
 *  spawn `recued-server` as a subprocess with a fresh DB file and parse
 *  stdout to verify command behavior.
 *
 *  Kept light — the full DB round-trip is covered by llm-config.test.ts;
 *  these tests focus on the CLI-level parsing and redaction behavior. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const binPath = join(__dirname, '..', '..', 'dist', 'bin.js');
let tmp: string;
let dbPath: string;

const runOnce = (args: string[]): SpawnSyncReturns<string> => spawnSync('node', [binPath, '--db', dbPath, ...args], {
  encoding: 'utf-8',
  env: { ...process.env, RECUED_SKIP_DB_INIT: '0' },
});

const transientDistImportError = (result: SpawnSyncReturns<string>): boolean =>
  result.status !== 0
  && /ERR_MODULE_NOT_FOUND|Cannot find package|Cannot find module|SyntaxError|Unexpected end/i
    .test(result.stderr);

const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

const run = (args: string[]): SpawnSyncReturns<string> => {
  let result = runOnce(args);
  for (let attempt = 0; attempt < 5 && transientDistImportError(result); attempt++) {
    sleepSync(100);
    result = runOnce(args);
  }
  return result;
};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'recued-cli-llm-'));
  dbPath = join(tmp, 'test.db');
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// Skip when the CLI can't run from dist (e.g., workspace not built, or the
// source-as-main `@recued/*` packages haven't been transpiled so raw `node`
// can't resolve them). We do a live smoke to detect both. The unit-level
// coverage of the underlying LLMConfigManager lives in llm-config.test.ts;
// this file covers the CLI-level parsing only.
const cliRunnable = (() => {
  try {
    require('node:fs').statSync(binPath);
    const probe = spawnSync('node', [binPath, '--help'], { encoding: 'utf-8', timeout: 5_000 });
    // Successful help prints to stdout; if the process exploded on import
    // (e.g., ERR_MODULE_NOT_FOUND from un-transpiled packages), stderr has
    // the stack and status is non-zero.
    return probe.status === 0 && !!probe.stdout;
  } catch { return false; }
})();

describe.skipIf(!cliRunnable)('recued-server llm CLI', () => {
  it('`set-slot slot_1` persists, `show` redacts the key', () => {
    const set = run([
      'llm', 'set-slot', 'slot_1',
      '--provider', 'openai',
      '--model', 'gpt-4',
      '--api-key', 'sk-secret-abcd1234',
      '--speed', 'fast',
      '--supports-json',
    ]);
    expect(set.status, set.stderr).toBe(0);

    const show = run(['llm', 'show']);
    expect(show.status).toBe(0);
    expect(show.stdout).toMatch(/\*\*\*1234/);
    expect(show.stdout).not.toMatch(/sk-secret-abcd1234/);

    const revealed = run(['llm', 'show', '--reveal-keys']);
    expect(revealed.status).toBe(0);
    expect(revealed.stdout).toMatch(/sk-secret-abcd1234/);
  });

  it('`export` redacts by default, `--with-keys` reveals', () => {
    run(['llm', 'set-slot', 'slot_1', '--provider', 'openai', '--model', 'gpt-4', '--api-key', 'sk-real-abcd1234']);
    const outPath = join(tmp, 'snap.json');
    run(['llm', 'export', outPath]);
    const redacted = JSON.parse(readFileSync(outPath, 'utf-8'));
    expect(redacted.config.slot_1.api_key).toBe('***1234');

    run(['llm', 'export', outPath, '--with-keys']);
    const revealed = JSON.parse(readFileSync(outPath, 'utf-8'));
    expect(revealed.config.slot_1.api_key).toBe('sk-real-abcd1234');
  });

  it('`import` round-trips a full config with non-default strategy', () => {
    const inPath = join(tmp, 'in.json');
    const cfg = {
      config: {
        slot_1: { provider: 'openai-compatible', model: 'llama', api_key: 'k', speed: 'fast', supports_json: true },
        // round_robin is the default and is normalized out of getConfig();
        // use the non-default strategy to prove import/show persistence.
        free_pool_strategy: 'weighted',
      },
      budget: 50000,
    };
    writeFileSync(inPath, JSON.stringify(cfg));
    const imp = run(['llm', 'import', inPath]);
    expect(imp.status).toBe(0);
    const show = run(['llm', 'show', '--reveal-keys']);
    const shown = JSON.parse(show.stdout) as { config: { free_pool_strategy?: string }; budget: number };
    expect(shown.config.free_pool_strategy).toBe('weighted');
    expect(shown.budget).toBe(50000);
  });

  it('rejects invalid strategy', () => {
    const r = run(['llm', 'set-strategy', 'bogus']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Invalid strategy/);
  });

  it('`add-pool-entry --type api` persists; `list-pool-entries` redacts the key', () => {
    const add = run([
      'llm', 'add-pool-entry',
      '--type', 'api',
      '--id', 'groq-llama',
      '--provider', 'openai-compatible',
      '--model', 'llama-3.3-70b',
      '--api-key', 'gsk-pooled-abcd1234',
      '--speed', 'fast',
      '--supports-json',
      '--base-url', 'https://api.groq.com/openai',
    ]);
    expect(add.status).toBe(0);
    expect(add.stdout).toMatch(/Added pool entry 'groq-llama'/);

    const list = run(['llm', 'list-pool-entries']);
    expect(list.status).toBe(0);
    expect(list.stdout).toMatch(/\*\*\*1234/);
    expect(list.stdout).not.toMatch(/gsk-pooled-abcd1234/);
    expect(list.stdout).toMatch(/llama-3\.3-70b/);

    const revealed = run(['llm', 'list-pool-entries', '--reveal-keys']);
    expect(revealed.stdout).toMatch(/gsk-pooled-abcd1234/);
  });

  it('`add-pool-entry --type web_chat` is rejected', () => {
    const add = run([
      'llm', 'add-pool-entry',
      '--type', 'web_chat',
      '--id', 'gemini-tab',
      '--tab', 'gemini',
    ]);
    expect(add.status).toBe(1);
    expect(add.stderr).toMatch(/--type must be api/);
  });

  it('`add-pool-entry` rejects duplicate ids', () => {
    run([
      'llm', 'add-pool-entry',
      '--type', 'api', '--id', 'dup', '--provider', 'openai-compatible',
      '--model', 'llama-3.3-70b', '--api-key', 'k1', '--speed', 'fast',
    ]);
    const dup = run([
      'llm', 'add-pool-entry',
      '--type', 'api', '--id', 'dup', '--provider', 'openai-compatible',
      '--model', 'llama-3.3-8b', '--api-key', 'k2', '--speed', 'fast',
    ]);
    expect(dup.status).toBe(1);
    expect(dup.stderr).toMatch(/already exists/);
  });

  it('`remove-pool-entry` deletes by id; unknown id exits 1', () => {
    run([
      'llm', 'add-pool-entry',
      '--type', 'api', '--id', 'to-remove', '--provider', 'openai-compatible',
      '--model', 'llama-3.3-70b', '--api-key', 'k', '--speed', 'fast',
    ]);
    const rm = run(['llm', 'remove-pool-entry', '--id', 'to-remove']);
    expect(rm.status).toBe(0);
    const missing = run(['llm', 'remove-pool-entry', '--id', 'to-remove']);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toMatch(/No pool entry/);
  });

  it('`set-allow-upgrade true` persists and `show` reflects it', () => {
    const set = run(['llm', 'set-allow-upgrade', 'true']);
    expect(set.status).toBe(0);
    const show = run(['llm', 'show']);
    expect(show.stdout).toMatch(/"allow_upgrade_default": true/);
  });

  it('`set-allow-upgrade` rejects non-boolean values', () => {
    const bad = run(['llm', 'set-allow-upgrade', 'yes']);
    expect(bad.status).toBe(1);
  });
});
